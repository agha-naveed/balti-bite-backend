// routes/rider.js
// Going online, answering a delivery request, and finishing it.
//
// There is no endpoint to cancel after accepting, on purpose. By that point the
// kitchen has packed the food and the customer is watching a map.

const express = require("express");
const { Rider, Order, Review } = require("../models");
const { auth, allow, settings, addTimeline, startOfToday, dispatchWaiting } = require("../helpers");
const { orderChanged } = require("../notifier");

const router = express.Router();
const onlyRider = [auth, allow("rider")];

/* ---------------------------------------------------------- the dashboard */
// The app calls this every few seconds, which is how a new job appears without
// the rider doing anything.
router.get("/summary", ...onlyRider, async (req, res) => {
  const rider = await Rider.findOne({ userId: req.user._id });
  if (!rider) return res.status(404).json({ message: "No rider profile is linked to this account." });

  // Jobs waiting to be answered - plural. Two kitchens can finish cooking at
  // the same moment and both send to the same rider, and only showing one of
  // them would leave the other sitting unanswered with nobody aware of it.
  const offers = await Order.find({ offeredTo: req.user._id, riderId: null })
    .sort({ offeredAt: 1 })
    .populate("kitchenId", "name phone")
    .populate("branchId", "name address location")
    .populate("customerId", "name phone");

  // Every job being carried right now. A rider heading the same way can hold
  // several; sending each one separately wastes the trip.
  const active = await Order.find({
    riderId: req.user._id,
    status: { $in: ["rider_assigned", "picked_up", "on_the_way"] },
  })
    .sort({ createdAt: 1 })
    .populate("kitchenId", "name phone")
    .populate("branchId", "name address location")
    .populate("customerId", "name phone");

  const today = startOfToday();
  const doneToday = await Order.find({
    riderId: req.user._id,
    status: "delivered",
    deliveredAt: { $gte: today },
  });

  const reviews = await Review.find({ riderId: req.user._id, riderRating: { $ne: null } })
    .sort({ createdAt: -1 })
    .limit(10)
    .select("customerName riderRating riderComment createdAt");

  const carrying = active.length;

  res.json({
    rider,
    rating: {
      average: rider.ratingCount
        ? Math.round((rider.ratingSum / rider.ratingCount) * 10) / 10
        : null,
      count: rider.ratingCount,
    },
    reviews,
    // The app uses this to explain why somebody is seeing no work, instead of
    // leaving them staring at an empty screen wondering what is broken.
    approval: {
      status: rider.status,
      reason: rider.decisionReason,
      decidedAt: rider.decidedAt,
    },
    // `offer` as well as `offers`, so nothing that only reads the first one
    // breaks; the app uses the list.
    offer: offers[0] || null,
    offers,
    active,
    // How many more this rider will take before new jobs stop being offered.
    capacity: {
      carrying,
      max: rider.maxJobs,
      room: Math.max(0, rider.maxJobs - carrying),
    },
    today: {
      // Only the delivery fees. The food money is the kitchen's and is only
      // passing through the rider's hands.
      earnings: doneToday.reduce((sum, o) => sum + o.deliveryFee, 0),
      delivered: doneToday.length,
      cashCollected: doneToday.reduce((sum, o) => sum + o.total, 0),
    },
  });
});

/* ---------------------------------------------------------------- photo */
// Set after signing in, or right after registration once the token exists.
// Shown to the customer whose food this rider is carrying.
router.patch("/photo", ...onlyRider, async (req, res) => {
  const rider = await Rider.findOneAndUpdate(
    { userId: req.user._id },
    { imageUrl: String(req.body.imageUrl || "").trim() },
    { new: true }
  );
  if (!rider) return res.status(404).json({ message: "Rider profile not found." });
  res.json({ imageUrl: rider.imageUrl });
});

/* --------------------------------------------------------------- online */
router.patch("/online", ...onlyRider, async (req, res) => {
  const rider = await Rider.findOne({ userId: req.user._id });
  if (!rider) return res.status(404).json({ message: "Rider profile not found." });

  if (rider.status !== "approved")
    return res.status(403).json({
      message:
        rider.status === "pending"
          ? "An admin still has to approve your account before you can go online."
          : "Your rider account is not active. Contact the admin.",
    });

  const goingOnline = Boolean(req.body.isOnline);
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  const hasFix = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    && req.body.lat !== undefined && req.body.lat !== null && req.body.lat !== "";

  // Nobody can be sent a nearby order without a location. Going online with it
  // switched off would only make the rider look available when they are not.
  if (goingOnline && !hasFix)
    return res.status(400).json({
      message: "Turn on your phone's location first. Orders are sent to the nearest rider, so we need to know where you are.",
    });

  rider.isOnline = goingOnline;
  if (hasFix) {
    rider.location = { type: "Point", coordinates: [lng, lat] };
    rider.locationAt = new Date();
  }
  await rider.save();
  res.json({ isOnline: rider.isOnline });

  // Food that was ready while nobody was online goes out now, instead of
  // waiting for the kitchen to notice and press the button again.
  if (rider.isOnline) dispatchWaiting().catch((e) => console.error("[dispatch]", e.message));
});

/* -------------------------------------------------------------- location */
// Sent every few seconds while a delivery is running. The customer's tracking
// screen reads the same numbers back.
router.patch("/location", ...onlyRider, async (req, res) => {
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  // Number(undefined) is NaN, so this also catches a missing value. Without the
  // range check a bad fix could put a rider in the middle of the ocean.
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return res.status(400).json({ message: "Location is missing or invalid." });

  await Rider.findOneAndUpdate(
    { userId: req.user._id },
    { location: { type: "Point", coordinates: [lng, lat] }, locationAt: new Date() }
  );
  res.json({ ok: true });
});

/* --------------------------------------------------------- take the job */
// riderId: null is part of the filter, so if two riders ever tap Accept at the
// same instant only the first one gets the order back. The second sees the
// "already taken" message rather than both of them setting off.
router.patch("/orders/:id/accept", ...onlyRider, async (req, res) => {
  const rider = await Rider.findOne({ userId: req.user._id });
  if (!rider) return res.status(404).json({ message: "Rider profile not found." });
  if (rider.status !== "approved")
    return res.status(403).json({ message: "Your rider account is not approved yet." });

  const carrying = await Order.countDocuments({
    riderId: req.user._id,
    status: { $in: ["rider_assigned", "picked_up", "on_the_way"] },
  });
  if (carrying >= rider.maxJobs)
    return res.status(400).json({
      message: `You are already carrying ${carrying} orders, which is the most at one time. Deliver one before taking another.`,
    });

  const order = await Order.findOneAndUpdate(
    { _id: req.params.id, riderId: null, offeredTo: req.user._id, status: "ready" },
    {
      riderId: req.user._id,
      status: "rider_assigned",
      offeredTo: null,
      $push: { timeline: { status: "rider_assigned", at: new Date(), by: "rider" } },
    },
    { new: true }
  );

  if (!order)
    return res.status(409).json({ message: "That job is no longer available." });

  orderChanged(order, "rider_assigned");
  res.json(order);
});

// Turning a job down before accepting is fine. The kitchen can send it out
// again once somebody else is free.
router.patch("/orders/:id/decline", ...onlyRider, async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, offeredTo: req.user._id });
  if (!order) return res.status(404).json({ message: "That request is not yours to answer." });

  order.skippedRiders.push(req.user._id); // not asked about this order again
  order.offeredTo = null;
  order.offeredAt = null;
  addTimeline(order, "ready", "rider", "Rider passed on this one");
  await order.save();
  orderChanged(order, "rider_passed");
  res.json({ ok: true });
  // Somebody else may be free right now.
  dispatchWaiting().catch((e) => console.error("[dispatch]", e.message));
});

/* --------------------------------------------------------- the delivery */
router.patch("/orders/:id/picked-up", ...onlyRider, async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, riderId: req.user._id });
  if (!order) return res.status(404).json({ message: "Order not found." });
  if (order.status !== "rider_assigned")
    return res.status(400).json({ message: "This order is not waiting to be collected." });

  order.status = "picked_up";
  addTimeline(order, "picked_up", "rider");
  order.status = "on_the_way";
  addTimeline(order, "on_the_way", "rider");
  await order.save();
  orderChanged(order, "on_the_way");
  res.json(order);
});

// The customer reads out four digits, the rider types them in. The order does
// not close until they match, which is what stops an order being marked
// delivered from the other end of town.
router.patch("/orders/:id/deliver", ...onlyRider, async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, riderId: req.user._id });
  if (!order) return res.status(404).json({ message: "Order not found." });
  if (!["picked_up", "on_the_way"].includes(order.status))
    return res.status(400).json({ message: "Collect the food from the kitchen first." });

  if (String(req.body.otp || "").trim() !== order.otp)
    return res
      .status(400)
      .json({ message: "That code does not match. Ask the customer to read it again." });

  order.status = "delivered";
  order.deliveredAt = new Date();

  // The platform's cut, worked out once and written onto the order. Storing the
  // number rather than recalculating it later means changing the rate never
  // rewrites what old reports say.
  order.commissionRate = settings.commissionPercent;
  order.commissionAmount = Math.round((order.foodTotal * settings.commissionPercent) / 100);

  addTimeline(order, "delivered", "rider", `Cash collected: Rs ${order.total}`);
  await order.save();

  orderChanged(order, "delivered");
  res.json(order);
  // This rider has room again.
  dispatchWaiting().catch((e) => console.error("[dispatch]", e.message));
});

/* -------------------------------------------------------------- history */
router.get("/orders", ...onlyRider, async (req, res) => {
  const orders = await Order.find({ riderId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(40)
    .populate("kitchenId", "name");
  res.json(orders);
});

module.exports = router;