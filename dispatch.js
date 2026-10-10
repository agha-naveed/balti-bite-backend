// dispatch.js
// Choosing which rider is asked to pick up a ready order.
//
// THE RULES
//   1. Only riders who are approved, ONLINE, not full, and have a FRESH location
//      (shared within the last few minutes). A rider whose location is off, or
//      whose app is closed, is not asked - they cannot be "nearby" to anything.
//   2. "Nearby" means near by ROAD, not as the crow flies. The few closest riders
//      by straight line are measured along real roads (hand-drawn roads first,
//      then the road map), and the shortest wins.
//   3. Nobody further than the admin's limit (Settings -> furthest pickup).
//   4. One rider is asked at a time. If they decline, or do not answer within the
//      admin's time limit, the next nearest is asked. A rider who passed is not
//      asked again for that order.
//   5. If nobody qualifies, the order waits and this tries again every few
//      seconds, and whenever a rider goes online, moves, or finishes a job.

const { Order, Rider, Branch } = require("./models");
const { settings, addTimeline } = require("./helpers");
const { routeBetween, meters } = require("./routing");
const { orderChanged } = require("./notifier");

const ACTIVE = ["rider_assigned", "picked_up", "on_the_way"];

// The nearest suitable rider for this order, or null.
async function pickRider(order) {
  const branch = await Branch.findById(order.branchId).select("location");
  const bc = branch?.location?.coordinates;
  if (!bc || (!bc[0] && !bc[1])) return null;
  const kitchenPoint = { lat: bc[1], lng: bc[0] };

  const { maxPickupKm, locationFreshSeconds } = settings.dispatch;
  const freshAfter = new Date(Date.now() - locationFreshSeconds * 1000);
  const skipped = new Set((order.skippedRiders || []).map(String));

  const riders = await Rider.find({
    status: "approved",
    isOnline: true,
    locationAt: { $gte: freshAfter },
  }).populate("userId", "name phone");

  const candidates = [];
  for (const r of riders) {
    if (!r.userId || skipped.has(String(r.userId._id))) continue;
    const c = r.location?.coordinates;
    if (!c || (!c[0] && !c[1])) continue;
    const here = { lat: c[1], lng: c[0] };

    // A road is never shorter than a straight line, so anybody already further
    // than the limit as the crow flies can be dropped without asking a router.
    const straightKm = meters(here, kitchenPoint) / 1000;
    if (straightKm > maxPickupKm) continue;

    const carrying = await Order.countDocuments({ riderId: r.userId._id, status: { $in: ACTIVE } });
    if (carrying >= r.maxJobs) continue;

    candidates.push({ rider: r, here, straightKm, carrying });
  }
  if (!candidates.length) return null;

  // Only the closest few are measured along roads - enough to catch a rider who
  // is close on the map but far by road, without hammering the routing server.
  candidates.sort((a, b) => a.straightKm - b.straightKm);
  const shortlist = candidates.slice(0, 5);
  const measured = await Promise.all(
    shortlist.map(async (c) => ({ ...c, road: await routeBetween(c.here, kitchenPoint) }))
  );

  const within = measured.filter((m) => m.road.distanceKm <= maxPickupKm);
  if (!within.length) return null;
  within.sort((a, b) => a.road.distanceKm - b.road.distanceKm || a.carrying - b.carrying);
  const best = within[0];
  return { rider: best.rider, km: best.road.distanceKm, minutes: best.road.durationMin, source: best.road.source };
}

let running = false;

// Goes through every ready order that has no rider and moves it along.
async function dispatchWaiting() {
  if (running) return; // a run already in progress will see everything
  running = true;
  try {
    const { offerSeconds } = settings.dispatch;
    const waiting = await Order.find({ status: "ready", riderId: null }).sort({ updatedAt: 1 });

    for (const order of waiting) {
      // An offer is out. Leave it alone unless the rider ran out of time.
      if (order.offeredTo) {
        const age = (Date.now() - new Date(order.offeredAt || 0).getTime()) / 1000;
        if (age < offerSeconds) continue;
        order.skippedRiders.push(order.offeredTo);
        order.offeredTo = null;
        order.offeredAt = null;
        addTimeline(order, "ready", "system", "Rider did not answer in time");
      }

      const pick = await pickRider(order);
      if (!pick) {
        // Everyone suitable has already passed on it once? Start the round again
        // rather than leave the order stuck forever.
        if (order.skippedRiders.length) {
          order.skippedRiders = [];
          await order.save();
        } else if (order.isModified()) {
          await order.save();
        }
        continue;
      }

      order.offeredTo = pick.rider.userId._id;
      order.offeredAt = new Date();
      addTimeline(
        order,
        "ready",
        "system",
        `Offered to ${pick.rider.userId.name} (${pick.km} km from the kitchen by road)`
      );
      await order.save();
      orderChanged(order, "offered", { pickupKm: pick.km });
    }
  } finally {
    running = false;
  }
}

// Every few seconds, so an unanswered offer moves on and a waiting order is
// picked up as soon as a suitable rider appears - without anyone pressing a
// button.
function startDispatcher() {
  const tick = () => dispatchWaiting().catch((e) => console.error("[dispatch]", e.message));
  setInterval(tick, 10 * 1000);
}

module.exports = { dispatchWaiting, pickRider, startDispatcher };
