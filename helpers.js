// helpers.js
// Small plain functions shared by the routes.

const jwt = require("jsonwebtoken");
const { User, Rider } = require("./models");

const settings = {
  jwtSecret: process.env.JWT_SECRET || "dev_secret_change_me",
  deliveryFee: Number(process.env.DELIVERY_FEE || 80),
  // What the platform takes, as a percentage of the food amount. Worked out
  // when an order is delivered and stored on that order.
  commissionPercent: Number(process.env.COMMISSION_PERCENT || 5),
  // Filled in by platform.js from the database. Admin-editable.
  recommendedMonthlySales: Number(process.env.RECOMMENDED_MONTHLY_SALES || 50000),
  billDueDays: Number(process.env.BILL_DUE_DAYS || 7),
  delivery: { baseFee: 80, baseKm: 5, perExtraKm: 20, maxFee: 0 },
  contacts: {},
};

/* ---------------------------------------------------------------- auth */
// Builds the token the app keeps after signing in. It carries the user id and
// role, and stops working after seven days.
function signToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, settings.jwtSecret, { expiresIn: "7d" });
}

// Reads "Authorization: Bearer <token>", checks it, and attaches the user to
// the request so the route below can use it.
async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Please sign in to continue." });

    const payload = jwt.verify(token, settings.jwtSecret);
    const user = await User.findById(payload.id).select("-password");
    if (!user) return res.status(401).json({ message: "This account no longer exists." });

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Your session expired. Sign in again." });
  }
}

// Usage: router.get("/x", auth, allow("kitchen"), handler)
function allow(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role))
      return res.status(403).json({ message: "You do not have access to this." });
    next();
  };
}

/* ------------------------------------------------------------- phone numbers */
// Everybody writes a phone number differently: 0300 1234567, 0300-1234567,
// +92 300 1234567, 92 300 1234567. Stored as typed, the same person could never
// sign in twice. So every number is put into one shape before it is saved or
// looked up, and the same function is used on both sides - otherwise sign-up
// and sign-in would disagree about who somebody is.
//
// The shape is E.164: a plus, a country code, then digits. +923001234567
function normalizePhone(raw) {
  let value = String(raw || "").trim().replace(/[\s\-().]/g, "");

  if (value.startsWith("00")) value = "+" + value.slice(2);      // 0092… -> +92…
  if (/^0\d{10}$/.test(value)) value = "+92" + value.slice(1);    // 03001234567
  if (/^92\d{10}$/.test(value)) value = "+" + value;             // 923001234567
  if (/^3\d{9}$/.test(value)) value = "+92" + value;             // 3001234567

  return value;
}

// Loose on purpose. A number from outside Pakistan is fine; this only catches
// something that is obviously not a phone number at all.
function looksLikePhone(value) {
  return /^\+\d{8,15}$/.test(value);
}

/* ------------------------------------------------------------- CNIC */
// Thirteen digits, written 12345-1234567-1. Stored with the dashes, because
// that is how it appears on the card and how an admin will read it back.
function normalizeCnic(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length !== 13) return null;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

/* ------------------------------------------------------------ utilities */
function orderCode() {
  // e.g. SKD-4F92 - short enough to read out on the phone
  return "SKD-" + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function makeOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Appends to the order's own history. This is the record the whole app reads.
function addTimeline(order, status, by, note = "") {
  order.timeline.push({ status, at: new Date(), by, note });
}

// Midnight this morning, used everywhere "today's earnings" is worked out.
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/* --------------------------------------------------------------- distance */
// Straight-line kilometres between two [lng, lat] points.
//
// Used to check a kitchen will deliver somewhere. Straight-line understates a
// real journey through a valley, which makes this the forgiving direction to be
// wrong in: a kitchen occasionally accepting a slightly longer trip is better
// than refusing one it would have taken.
function distanceKm(a, b) {
  if (!a?.[0] || !b?.[0]) return null;

  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

// Kept for the files that still import these names. The real logic lives in
// dispatch.js (nearest rider by road); see there.
async function findFreeRider() {
  return null;
}
async function dispatchWaiting() {
  return require("./dispatch").dispatchWaiting();
}

/* --------------------------------------------------------------- live view */
// Statuses where an order is still open (not delivered / rejected / cancelled),
// and the ones where a rider is physically carrying it.
const OPEN_STATUSES = [
  "placed", "accepted", "preparing", "ready", "rider_assigned", "picked_up", "on_the_way",
];
const MOVING_STATUSES = ["rider_assigned", "picked_up", "on_the_way"];

// GeoJSON is [lng, lat]. Everything the screens draw wants { lat, lng }.
function toLatLng(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords;
  // [0, 0] is the schema default, meaning "never set" - not a place in the sea.
  if (!lat && !lng) return null;
  return { lat, lng };
}

// What a rider's phone last said. Sends "ageSec" (seconds since the fix)
// rather than a timestamp, so a wrong clock on somebody's phone can never make
// a fresh position look old.
function riderView(riderDoc, userDoc) {
  if (!riderDoc) return null;
  const at = riderDoc.locationAt;
  return {
    userId: String(riderDoc.userId || ""),
    name: userDoc?.name || "",
    phone: userDoc?.phone || "",
    photo: riderDoc.imageUrl || "",
    vehicle: riderDoc.vehicle,
    vehicleMake: riderDoc.vehicleMake || "",
    vehicleColor: riderDoc.vehicleColor || "",
    vehicleNumber: riderDoc.vehicleNumber,
    location: toLatLng(riderDoc.location?.coordinates),
    ageSec: at ? Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000)) : null,
  };
}

// Everything a "watch this order" screen needs, in one shape. Used by the
// kitchen and the admin so both draw exactly the same picture.
//
// The rider's position is only included while the order is actually being
// carried. Before that the rider may be doing something else; after delivery
// there is no reason for anybody to keep seeing where they went.
//
// The OTP is left out on purpose: it is the customer's secret at the door.
async function buildLiveView(order) {
  let rider = null;
  if (order.riderId) {
    const riderUserId = order.riderId._id || order.riderId;
    const [riderDoc, userDoc] = await Promise.all([
      Rider.findOne({ userId: riderUserId }),
      order.riderId.name ? Promise.resolve(order.riderId) : User.findById(riderUserId).select("name phone"),
    ]);
    rider = riderView(riderDoc, userDoc);
    if (rider && !MOVING_STATUSES.includes(order.status)) rider.location = null;
  }

  const o = order.toObject ? order.toObject() : order;
  delete o.otp;

  return {
    order: {
      _id: o._id,
      code: o.code,
      status: o.status,
      address: o.address,
      note: o.note,
      items: o.items,
      foodTotal: o.foodTotal,
      deliveryFee: o.deliveryFee,
      total: o.total,
      cookTimeMin: o.cookTimeMin,
      timeline: o.timeline,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      rejectReason: o.rejectReason,
      cancelReason: o.cancelReason,
      customerPhone: o.customerPhone,
      kitchen: { name: o.kitchenId?.name, phone: o.kitchenId?.phone },
      customer: { name: o.customerId?.name, phone: o.customerId?.phone },
    },
    kitchen: {
      name: o.kitchenId?.name,
      address: o.branchId?.address,
      ...(toLatLng(o.branchId?.location?.coordinates) || {}),
    },
    customer: {
      address: o.address,
      ...(toLatLng(o.location?.coordinates) || {}),
    },
    rider,
    serverTime: new Date(),
  };
}

module.exports = {
  OPEN_STATUSES,
  MOVING_STATUSES,
  toLatLng,
  riderView,
  buildLiveView,
  settings,
  signToken,
  auth,
  allow,
  orderCode,
  makeOtp,
  addTimeline,
  startOfToday,
  normalizePhone,
  looksLikePhone,
  normalizeCnic,
  distanceKm,
  findFreeRider,
  dispatchWaiting,
};
