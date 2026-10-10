// routes/kitchen.js
// A kitchen's dishes, its orders, and today's takings.
//
// The rule that shapes the menu half of this file: a dish is only visible to
// customers once an admin has approved it, and any edit to an approved dish
// sends it back for review. Ingredients are the reason. If a kitchen could
// quietly change an ingredient list after approval, the review would be worth
// nothing, and someone with an allergy would be relying on a check that no
// longer applied.

const express = require("express");
const { Kitchen, Branch, MenuItem, Order, Review } = require("../models");
const { auth, allow, addTimeline, startOfToday, dispatchWaiting, buildLiveView } = require("../helpers");
const { orderChanged } = require("../notifier");

const router = express.Router();
const onlyKitchen = [auth, allow("kitchen")];

// "The kitchen belonging to whoever is signed in." One account owns exactly one
// kitchen, so this is always a single record.
async function myKitchen(req) {
  return Kitchen.findOne({ ownerId: req.user._id });
}

function readIngredients(raw) {
  if (!Array.isArray(raw)) return { error: "Add at least one ingredient." };

  const cleaned = raw
    .filter((i) => i && String(i.name || "").trim())
    .map((i) => ({
      name: String(i.name).trim(),
      quantity: String(i.quantity || "").trim(),
      note: String(i.note || "").trim(),
    }));

  if (cleaned.length === 0)
    return { error: "Add at least one ingredient. Customers rely on this list." };

  return { ingredients: cleaned };
}

/* ---------------------------------------------------------- the dashboard */
router.get("/summary", ...onlyKitchen, async (req, res) => {
  const kitchen = await myKitchen(req);
  if (!kitchen) return res.status(404).json({ message: "No kitchen is linked to this account." });

  const branch = await Branch.findOne({ kitchenId: kitchen._id });
  const items = await MenuItem.find({ kitchenId: kitchen._id }).select("status");

  const today = startOfToday();
  const deliveredToday = await Order.find({
    kitchenId: kitchen._id,
    status: "delivered",
    deliveredAt: { $gte: today },
  });

  const waiting = await Order.countDocuments({ kitchenId: kitchen._id, status: "placed" });
  const running = await Order.countDocuments({
    kitchenId: kitchen._id,
    status: { $in: ["accepted", "preparing", "ready", "rider_assigned", "picked_up", "on_the_way"] },
  });

  // The last few things customers said, so a complaint is read rather than
  // buried in an average.
  const reviews = await Review.find({ kitchenId: kitchen._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .select("customerName foodRating foodComment dishes createdAt");

  res.json({
    kitchen,
    branch,
    rating: {
      average: kitchen.ratingCount
        ? Math.round((kitchen.ratingSum / kitchen.ratingCount) * 10) / 10
        : null,
      count: kitchen.ratingCount,
    },
    reviews,
    dishes: {
      approved: items.filter((i) => i.status === "approved").length,
      pending: items.filter((i) => i.status === "pending").length,
      declined: items.filter((i) => i.status === "declined").length,
    },
    today: {
      // Only the food amount. The delivery fee is the rider's, never the
      // kitchen's, so it is not counted here.
      earnings: deliveredToday.reduce((sum, o) => sum + o.foodTotal, 0),
      delivered: deliveredToday.length,
    },
    orders: { waiting, running },
  });
});

/* ------------------------------------------------------ the kitchen photo */
// Set after signing in rather than during registration, because uploading a
// picture needs a token and there is no token until the account exists.
router.patch("/profile", ...onlyKitchen, async (req, res) => {
  const kitchen = await myKitchen(req);
  if (!kitchen) return res.status(404).json({ message: "No kitchen is linked to this account." });

  if (req.body.imageUrl !== undefined) kitchen.imageUrl = String(req.body.imageUrl).trim();
  if (req.body.videoUrl !== undefined) kitchen.videoUrl = String(req.body.videoUrl).trim();
  if (req.body.description !== undefined)
    kitchen.description = String(req.body.description).trim();

  await kitchen.save();
  res.json(kitchen);
});

/* ------------------------------------------------- open and close the shop */
router.patch("/branch/toggle", ...onlyKitchen, async (req, res) => {
  const kitchen = await myKitchen(req);
  const branch = await Branch.findOne({ kitchenId: kitchen._id });
  if (!branch) return res.status(404).json({ message: "Branch not found." });

  branch.isOpen = !branch.isOpen;
  await branch.save();
  res.json(branch);
});

/* ------------------------------------------------------------- the menu */
router.get("/menu", ...onlyKitchen, async (req, res) => {
  const kitchen = await myKitchen(req);
  if (!kitchen) return res.status(404).json({ message: "No kitchen is linked to this account." });

  const items = await MenuItem.find({ kitchenId: kitchen._id }).sort({ createdAt: -1 });

  res.json({
    items,
    counts: {
      approved: items.filter((i) => i.status === "approved").length,
      pending: items.filter((i) => i.status === "pending").length,
      declined: items.filter((i) => i.status === "declined").length,
    },
  });
});

router.post("/menu", ...onlyKitchen, async (req, res) => {
  try {
    const kitchen = await myKitchen(req);
    const { name, description, price, cookTimeMin, ingredients, images } = req.body;

    if (!name || !String(name).trim())
      return res.status(400).json({ message: "The dish needs a name." });
    if (!price || Number(price) < 1) return res.status(400).json({ message: "Set a price." });

    const parsed = readIngredients(ingredients);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    const clash = await MenuItem.findOne({
      kitchenId: kitchen._id,
      name: { $regex: `^${String(name).trim()}$`, $options: "i" },
    });
    if (clash) return res.status(409).json({ message: "That dish is already on your menu." });

    const item = await MenuItem.create({
      kitchenId: kitchen._id,
      name: String(name).trim(),
      description: description || "",
      price: Number(price),
      cookTimeMin: Number(cookTimeMin) || 20,
      images: Array.isArray(images) ? images.filter(Boolean).slice(0, 5) : [],
      ingredients: parsed.ingredients,
      status: "pending", // every new dish waits for review
    });

    res.status(201).json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the dish. Try again." });
  }
});

// Editing sends the dish back for review, approved or not.
router.patch("/menu/:id", ...onlyKitchen, async (req, res) => {
  try {
    const kitchen = await myKitchen(req);
    const item = await MenuItem.findOne({ _id: req.params.id, kitchenId: kitchen._id });
    if (!item) return res.status(404).json({ message: "Dish not found." });

    const { name, description, price, cookTimeMin, ingredients, images } = req.body;

    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ message: "The dish needs a name." });
      item.name = String(name).trim();
    }
    if (description !== undefined) item.description = description;
    if (price !== undefined) {
      if (Number(price) < 1) return res.status(400).json({ message: "Set a price." });
      item.price = Number(price);
    }
    if (cookTimeMin !== undefined) item.cookTimeMin = Number(cookTimeMin) || 20;
    if (images !== undefined)
      item.images = Array.isArray(images) ? images.filter(Boolean).slice(0, 5) : [];

    if (ingredients !== undefined) {
      const parsed = readIngredients(ingredients);
      if (parsed.error) return res.status(400).json({ message: parsed.error });
      item.ingredients = parsed.ingredients;
    }
    // Back into the queue, with the old decline reason cleared so the kitchen
    // is not still reading feedback about a version that no longer exists.
    item.status = "pending";
    item.declineReason = "";
    item.reviewedAt = null;
    item.submissionCount += 1;

    await item.save();
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the change. Try again." });
  }
});

// Today's stock, not what is in the dish, so this does not touch the review.
router.patch("/menu/:id/available", ...onlyKitchen, async (req, res) => {
  const kitchen = await myKitchen(req);
  const item = await MenuItem.findOne({ _id: req.params.id, kitchenId: kitchen._id });
  if (!item) return res.status(404).json({ message: "Dish not found." });

  item.available = !item.available;
  await item.save();
  res.json(item);
});

router.delete("/menu/:id", ...onlyKitchen, async (req, res) => {
  const kitchen = await myKitchen(req);
  const gone = await MenuItem.findOneAndDelete({ _id: req.params.id, kitchenId: kitchen._id });
  if (!gone) return res.status(404).json({ message: "Dish not found." });
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- orders */
// ?box=waiting  -> only orders that need an answer
// ?box=running  -> accepted through to on the way
// ?box=done     -> finished, one way or another
router.get("/orders", ...onlyKitchen, async (req, res) => {
  const kitchen = await myKitchen(req);
  if (!kitchen) return res.status(404).json({ message: "No kitchen is linked to this account." });

  const boxes = {
    waiting: ["placed"],
    running: ["accepted", "preparing", "ready", "rider_assigned", "picked_up", "on_the_way"],
    done: ["delivered", "rejected", "cancelled"],
  };

  const filter = { kitchenId: kitchen._id };
  if (boxes[req.query.box]) filter.status = { $in: boxes[req.query.box] };

  const orders = await Order.find(filter)
    .sort({ createdAt: -1 })
    .limit(60)
    .populate("customerId", "name phone")
    .populate("riderId", "name phone");

  // The counts drive the little number on each tab.
  const [waiting, running] = await Promise.all([
    Order.countDocuments({ kitchenId: kitchen._id, status: { $in: boxes.waiting } }),
    Order.countDocuments({ kitchenId: kitchen._id, status: { $in: boxes.running } }),
  ]);

  res.json({ orders, counts: { waiting, running } });
});

/* ------------------------------------------------------ watch one order live */
// The kitchen sees where the rider is for its OWN orders only - the filter on
// kitchenId is what enforces that. The board calls this every 5 seconds while
// the map is open.
router.get("/orders/:id/live", ...onlyKitchen, async (req, res) => {
  try {
    const kitchen = await myKitchen(req);
    if (!kitchen) return res.status(404).json({ message: "No kitchen is linked to this account." });

    const order = await Order.findOne({ _id: req.params.id, kitchenId: kitchen._id })
      .populate("kitchenId", "name phone")
      .populate("branchId", "name address location")
      .populate("customerId", "name phone")
      .populate("riderId", "name phone");
    if (!order) return res.status(404).json({ message: "Order not found." });

    res.json(await buildLiveView(order));
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Could not load that order." });
  }
});

router.patch("/orders/:id/accept", ...onlyKitchen, async (req, res) => {
  const kitchen = await myKitchen(req);
  const order = await Order.findOne({ _id: req.params.id, kitchenId: kitchen._id });
  if (!order) return res.status(404).json({ message: "Order not found." });
  if (order.status !== "placed")
    return res.status(400).json({ message: "This order has already been answered." });

  order.status = "accepted";
  addTimeline(order, "accepted", "kitchen");
  await order.save();
  orderChanged(order, "accepted");
  res.json(order);
});

router.patch("/orders/:id/reject", ...onlyKitchen, async (req, res) => {
  const kitchen = await myKitchen(req);
  const order = await Order.findOne({ _id: req.params.id, kitchenId: kitchen._id });
  if (!order) return res.status(404).json({ message: "Order not found." });
  if (order.status !== "placed")
    return res.status(400).json({ message: "This order has already been answered." });

  order.status = "rejected";
  order.rejectReason = String(req.body.reason || "The kitchen could not take this order").trim();
  addTimeline(order, "rejected", "kitchen", order.rejectReason);
  await order.save();
  orderChanged(order, "rejected");
  res.json(order);
});

router.patch("/orders/:id/preparing", ...onlyKitchen, async (req, res) => {
  const kitchen = await myKitchen(req);
  const order = await Order.findOne({ _id: req.params.id, kitchenId: kitchen._id });
  if (!order) return res.status(404).json({ message: "Order not found." });
  if (order.status !== "accepted")
    return res.status(400).json({ message: "Accept the order first." });

  // Past this point the customer can no longer cancel, because the food is
  // being made. Recorded on the order so the reason is visible later.
  order.status = "preparing";
  addTimeline(order, "preparing", "kitchen", "Cooking started - no longer cancellable");
  await order.save();
  orderChanged(order, "preparing");
  res.json(order);
});

/* ------------------------------------------ ready: this is where a rider is
   found. The job is offered to whoever is online and free. If nobody is, the
   order sits at "ready" and the kitchen can press the button again once a
   rider comes online. */
router.patch("/orders/:id/ready", ...onlyKitchen, async (req, res) => {
  const kitchen = await myKitchen(req);
  const order = await Order.findOne({ _id: req.params.id, kitchenId: kitchen._id });
  if (!order) return res.status(404).json({ message: "Order not found." });
  if (!["accepted", "preparing", "ready"].includes(order.status))
    return res.status(400).json({ message: "This order is not being cooked." });

  const justReady = order.status !== "ready";
  if (justReady) {
    order.status = "ready";
    addTimeline(order, "ready", "kitchen");
  }

  await order.save();
  if (justReady) orderChanged(order, "ready");

  // Already has a rider, or is already waiting in somebody's inbox.
  if (order.riderId || order.offeredTo)
    return res.json({ order, rider: null, message: "A rider already has this one." });

  // Ask the NEAREST suitable rider (by road). If nobody is close enough and
  // online with their location on, the order waits and is offered automatically
  // the moment someone is - the kitchen does not need to press anything again.
  await dispatchWaiting();
  const fresh = await Order.findById(order._id).populate("offeredTo", "name phone");
  if (fresh.offeredTo)
    return res.json({
      order: fresh,
      rider: { name: fresh.offeredTo.name, phone: fresh.offeredTo.phone },
      message: `Sent to ${fresh.offeredTo.name}, the nearest rider.`,
    });
  res.json({
    order: fresh,
    rider: null,
    message: "No rider is nearby right now. We keep looking and will send it the moment one is.",
  });
});

module.exports = router;
