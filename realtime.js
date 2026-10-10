// realtime.js
// The websocket side: instant screen refreshes and the rider's live location.
//
// Two different jobs, two different tools:
//   - Push (FCM, push.js)  wakes a CLOSED app and shows a notification.
//   - Websocket (this)     updates an OPEN app within milliseconds.
// Every change goes through both, so nobody waits and nobody misses it.
//
// Rooms:
//   user:<id>     everything meant for one person
//   admin         every admin
//   order:<id>    people watching one order's map (customer, kitchen, admin)

const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { User, Order, Rider, Kitchen } = require("./models");
const { settings } = require("./helpers");

let io = null;

function attach(httpServer, corsOrigin) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
    // Mobile networks drop and come back constantly; ping often so a dead
    // connection is noticed and replaced quickly.
    pingInterval: 10000,
    pingTimeout: 8000,
  });

  // Only a signed-in person may connect, using the same token as the API.
  io.use(async (socket, next) => {
    try {
      const payload = jwt.verify(socket.handshake.auth?.token || "", settings.jwtSecret);
      const user = await User.findById(payload.id).select("_id role name");
      if (!user) return next(new Error("no such user"));
      socket.user = user;
      next();
    } catch {
      next(new Error("unauthorised"));
    }
  });

  io.on("connection", (socket) => {
    const { _id, role } = socket.user;
    socket.join(`user:${_id}`);
    if (role === "admin") socket.join("admin");

    // A screen asks to watch one order. Checked here, because anybody could
    // otherwise ask for any order's rider.
    socket.on("watch:order", async (orderId, ack) => {
      try {
        const order = await Order.findById(orderId).select("customerId kitchenId riderId");
        if (!order) return ack?.({ ok: false });
        let allowed = role === "admin" || String(order.customerId) === String(_id);
        if (!allowed && role === "kitchen") {
          const k = await Kitchen.findOne({ ownerId: _id }).select("_id");
          allowed = k && String(k._id) === String(order.kitchenId);
        }
        if (!allowed) return ack?.({ ok: false });
        socket.join(`order:${orderId}`);
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false });
      }
    });
    socket.on("unwatch:order", (orderId) => socket.leave(`order:${orderId}`));

    // The rider's phone sends its position here instead of a PATCH every 5s.
    if (role === "rider") socket.on("rider:location", (fix) => onRiderFix(socket.user, fix));
  });

  return io;
}

/* ---------------------------------------------------- rider location */
// Which orders a rider is carrying changes rarely, but a fix arrives every few
// seconds. A short cache stops every fix from costing a database query.
const carrying = new Map(); // riderUserId -> { ids, at }
const lastSaved = new Map(); // riderUserId -> { at, lat, lng }
const CARRY_TTL_MS = 10000;
const SAVE_EVERY_MS = 15000;

async function activeOrderIds(riderUserId) {
  const key = String(riderUserId);
  const hit = carrying.get(key);
  if (hit && Date.now() - hit.at < CARRY_TTL_MS) return hit.ids;
  const rows = await Order.find({
    riderId: riderUserId,
    status: { $in: ["rider_assigned", "picked_up", "on_the_way"] },
  }).select("_id");
  const ids = rows.map((r) => String(r._id));
  carrying.set(key, { ids, at: Date.now() });
  return ids;
}

// Called when a job is taken or finished so the next fix sees the new list.
function forgetCarrying(riderUserId) {
  carrying.delete(String(riderUserId));
}

async function onRiderFix(user, fix) {
  const lat = Number(fix?.lat);
  const lng = Number(fix?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return;

  const ids = await activeOrderIds(user._id);
  // One message to every room that cares. Socket.IO delivers it once to a socket
  // that is in several of them (an admin watching one order, say).
  const payload = { riderId: String(user._id), lat, lng, at: Date.now(), orderIds: ids };
  const rooms = [...ids.map((id) => `order:${id}`), "admin"];

  // Out first, written second: the map should not wait for the database.
  io.to(rooms).emit("rider:location", payload);

  // The database copy is for people who open the screen later, so it does not
  // need every fix - every 15 seconds is plenty.
  const prev = lastSaved.get(String(user._id));
  if (!prev || Date.now() - prev.at > SAVE_EVERY_MS) {
    lastSaved.set(String(user._id), { at: Date.now(), lat, lng });
    Rider.findOneAndUpdate(
      { userId: user._id },
      { location: { type: "Point", coordinates: [lng, lat] }, locationAt: new Date() }
    ).catch(() => {});
  }
}

/* ------------------------------------------------------------ outgoing */
// Tells these people's open screens to reload. The screens already know how to
// fetch their own data; this only says "now".
function refresh(userIds, detail = {}, { admin = false } = {}) {
  if (!io) return;
  for (const id of [...new Set((userIds || []).filter(Boolean).map(String))]) {
    io.to(`user:${id}`).emit("refresh", detail);
  }
  if (admin) io.to("admin").emit("refresh", detail);
}

module.exports = { attach, refresh, forgetCarrying };
