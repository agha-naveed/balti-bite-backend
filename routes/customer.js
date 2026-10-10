// routes/customer.js
// Searching, ordering, following an order, and looking back at old ones.

const express = require("express");
const {
  MenuItem,
  Kitchen,
  Branch,
  Order,
  Rider,
  Review,
  Report,
  User,
  REPORT_REASONS,
} = require("../models");
const {
  auth,
  allow,
  settings,
  orderCode,
  makeOtp,
  addTimeline,
  distanceKm,
} = require("../helpers");
const { orderChanged } = require("../notifier");
const { routeBetween } = require("../routing");
const { feeForKm } = require("../platform");

const router = express.Router();
const onlyCustomer = [auth, allow("customer")];

/* ----------------------------------------------------------------- quote */
// "What will delivery cost, and can they reach me?" for each kitchen in a cart,
// to a chosen address. Checkout asks this before the order is placed, so the
// fee shown is the fee charged: both come from the same road distance.
// Body: { lat, lng, kitchenIds: [] }
router.post("/quote", ...onlyCustomer, async (req, res) => {
  try {
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    const ids = Array.isArray(req.body.kitchenIds) ? req.body.kitchenIds.slice(0, 10) : [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
      return res.status(400).json({ message: "Choose a delivery location first." });

    const quotes = await Promise.all(
      ids.map(async (kitchenId) => {
        const branch = await Branch.findOne({ kitchenId });
        if (!branch?.location?.coordinates?.[0]) return { kitchenId, fee: feeForKm(NaN), known: false };
        const [bLng, bLat] = branch.location.coordinates;
        const route = await routeBetween({ lat: bLat, lng: bLng }, { lat, lng });
        const limitKm = branch.deliveryRadiusKm || 15;
        return {
          kitchenId,
          km: route.distanceKm,
          minutes: route.durationMin,
          source: route.source, // "estimate" means the road was not found; show it with "~"
          fee: feeForKm(route.distanceKm),
          limitKm,
          deliverable: route.distanceKm <= limitKm,
          known: true,
        };
      })
    );
    res.json({ quotes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not work out the delivery fee." });
  }
});

/* ---------------------------------------------------------------- search */
// By dish name and nothing else. Type "mamtu" and every open kitchen that
// cooks mamtu comes back. Distance plays no part in it.
router.get("/search", auth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    const filter = { status: "approved", available: true };
    if (q) filter.name = { $regex: q, $options: "i" };

    const dishes = await MenuItem.find(filter).sort({ name: 1 }).limit(100);
    if (dishes.length === 0) return res.json({ results: [] });

    const kitchenIds = [...new Set(dishes.map((d) => String(d.kitchenId)))];
    const kitchens = await Kitchen.find({ _id: { $in: kitchenIds } });
    const branches = await Branch.find({ kitchenId: { $in: kitchenIds }, isOpen: true });

    const kitchenById = {};
    kitchens.forEach((k) => (kitchenById[String(k._id)] = k));
    const branchByKitchen = {};
    branches.forEach((b) => (branchByKitchen[String(b.kitchenId)] = b));

    const grouped = {};
    for (const dish of dishes) {
      const key = String(dish.kitchenId);
      const kitchen = kitchenById[key];
      const branch = branchByKitchen[key];
      if (!kitchen || !branch) continue; // closed, so not listed

      if (!grouped[key]) {
        grouped[key] = {
          kitchenId: kitchen._id,
          kitchenName: kitchen.name,
          address: branch.address,
          items: [],
        };
      }
      grouped[key].items.push({
        menuItemId: dish._id,
        name: dish.name,
        price: dish.price,
        cookTimeMin: dish.cookTimeMin,
        images: dish.images,
        ingredients: dish.ingredients,
      });
    }

    res.json({ deliveryFee: settings.deliveryFee, results: Object.values(grouped) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Search is not responding. Try again." });
  }
});

/* ---------------------------------------------------------- place orders */
// A cart may hold food from several kitchens at once. Each kitchen gets its own
// order, because each one cooks separately, answers separately and is delivered
// separately - there is no such thing as half an order being accepted.
//
// Body: { groups: [{ kitchenId, items: [{ menuItemId, qty }] }], address, lat, lng, note }
router.post("/orders", ...onlyCustomer, async (req, res) => {
  try {
    const { groups, address, lat, lng, note, saveAsPrimary } = req.body;

    if (!Array.isArray(groups) || groups.length === 0)
      return res.status(400).json({ message: "Add something to your cart before ordering." });
    if (!address || !String(address).trim())
      return res.status(400).json({ message: "Add a delivery address." });

    const cleanAddress = String(address).trim();
    const where =
      lat !== undefined && lat !== null
        ? { type: "Point", coordinates: [Number(lng), Number(lat)] }
        : undefined;

    // Everything is checked before anything is written. Creating two orders and
    // then failing on the third would leave the customer half-committed with no
    // clear way back.
    const planned = [];

    for (const group of groups) {
      const kitchen = await Kitchen.findById(group.kitchenId);
      if (!kitchen)
        return res.status(404).json({ message: "One of those kitchens is no longer listed." });

      const branch = await Branch.findOne({ kitchenId: kitchen._id });
      if (!branch || !branch.isOpen)
        return res.status(400).json({ message: `${kitchen.name} is closed right now.` });

      // Checked against the address being ordered to, not the one the food was
      // browsed from. Somebody can fill a cart at home and then send it to an
      // office across town, and a kitchen that reaches one may not reach the
      // other. Caught here rather than after the order is placed.
      // Measured along the road, not as the crow flies - across the Indus those
      // can be very different. Falls back to an estimate if no road is known.
      let route = null;
      if (where && branch.location?.coordinates?.[0]) {
        const [bLng, bLat] = branch.location.coordinates;
        route = await routeBetween(
          { lat: bLat, lng: bLng },
          { lat: where.coordinates[1], lng: where.coordinates[0] }
        );
        const limit = branch.deliveryRadiusKm || 15;
        if (route.distanceKm > limit)
          return res.status(400).json({
            message: `${kitchen.name} does not deliver that far — it is about ${route.distanceKm} km by road${
              route.source === "estimate" ? " (estimated)" : ""
            } and they go up to ${limit} km. Remove their food, or order to somewhere closer.`,
          });
      }

      const ids = (group.items || []).map((i) => i.menuItemId);
      if (ids.length === 0)
        return res.status(400).json({ message: `Nothing chosen from ${kitchen.name}.` });

      // Prices always come from the database, never from what the app sent.
      // This is the one rule that stops somebody editing a price in a browser.
      const dishes = await MenuItem.find({
        _id: { $in: ids },
        kitchenId: kitchen._id,
        status: "approved",
        available: true,
      });
      if (dishes.length !== ids.length)
        return res
          .status(400)
          .json({ message: `Something from ${kitchen.name} is no longer available.` });

      let foodTotal = 0;
      let cookTimeMin = 0;
      const lines = dishes.map((dish) => {
        const asked = group.items.find((i) => String(i.menuItemId) === String(dish._id));
        const qty = Math.max(1, Number(asked.qty || 1));
        foodTotal += dish.price * qty;
        // The slowest dish decides how long the whole order takes.
        cookTimeMin = Math.max(cookTimeMin, dish.cookTimeMin);
        return { menuItemId: dish._id, name: dish.name, price: dish.price, qty };
      });

      // Priced by the road distance: the further the ride, the higher the fee.
      const fee = feeForKm(route ? route.distanceKm : NaN);
      planned.push({ kitchen, branch, lines, foodTotal, cookTimeMin, route, fee });
    }

    // Everything checked out, so now write.
    const created = [];
    for (const p of planned) {
      created.push(
        await Order.create({
          code: orderCode(),
          customerId: req.user._id,
          kitchenId: p.kitchen._id,
          branchId: p.branch._id,
          items: p.lines,
          foodTotal: p.foodTotal,
          deliveryFee: p.fee,
          total: p.foodTotal + p.fee,
          cookTimeMin: p.cookTimeMin,
          address: cleanAddress,
          location: where || p.branch.location,
          customerPhone: req.user.phone,
          note: note || "",
          routeKm: p.route ? p.route.distanceKm : null,
          routeSource: p.route ? p.route.source : "",
          status: "placed",
          otp: makeOtp(),
          timeline: [{ status: "placed", at: new Date(), by: "customer" }],
        })
      );
    }

    created.forEach((o) => orderChanged(o, "placed"));

    // Somebody ordering to a new place can keep it as their usual one.
    if (saveAsPrimary) {
      await User.findByIdAndUpdate(req.user._id, {
        address: cleanAddress,
        ...(where ? { location: where } : {}),
      });
    }

    // Each kitchen is a separate delivery, so each one carries its own fee.
    res.status(201).json({
      orders: created,
      count: created.length,
      note:
        created.length > 1
          ? "Each kitchen cooks and delivers separately, so each order has its own delivery fee and its own code."
          : "",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not place the order. Try again." });
  }
});

/* -------------------------------------------------------------- history */
// Everything this customer has ever ordered, with filters over it.
//   ?box=live|past   ?q=search   ?from=&to=
router.get("/orders", ...onlyCustomer, async (req, res) => {
  const LIVE = ["placed", "accepted", "preparing", "ready", "rider_assigned", "picked_up", "on_the_way"];

  const filter = { customerId: req.user._id };
  if (req.query.box === "live") filter.status = { $in: LIVE };
  if (req.query.box === "past") filter.status = { $nin: LIVE };

  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) {
      // Through the end of that day, which is what picking a date means.
      const end = new Date(req.query.to);
      end.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = end;
    }
  }

  let orders = await Order.find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .populate("kitchenId", "name imageUrl")
    .populate("riderId", "name phone");

  // Searched here rather than in the query, because the kitchen name lives on
  // a joined record and the dish names live inside an array.
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q) {
    orders = orders.filter((o) =>
      [o.code, o.kitchenId?.name, o.address, ...o.items.map((i) => i.name)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }

  // A running total of what this person has spent, and where.
  const delivered = orders.filter((o) => o.status === "delivered");
  const byKitchen = {};
  delivered.forEach((o) => {
    const name = o.kitchenId?.name || "Unknown";
    byKitchen[name] = byKitchen[name] || { kitchen: name, orders: 0, spent: 0 };
    byKitchen[name].orders += 1;
    byKitchen[name].spent += o.total;
  });

  res.json({
    orders,
    liveCount: await Order.countDocuments({ customerId: req.user._id, status: { $in: LIVE } }),
    summary: {
      total: orders.length,
      delivered: delivered.length,
      spent: delivered.reduce((sum, o) => sum + o.total, 0),
      kitchens: Object.values(byKitchen).sort((a, b) => b.spent - a.spent),
    },
  });
});

// Just the live ones, for the strip that follows a customer around the app.
router.get("/orders/live", ...onlyCustomer, async (req, res) => {
  const orders = await Order.find({
    customerId: req.user._id,
    status: {
      $in: ["placed", "accepted", "preparing", "ready", "rider_assigned", "picked_up", "on_the_way"],
    },
  })
    .sort({ createdAt: -1 })
    .populate("kitchenId", "name");
  res.json(orders);
});

/* ------------------------------------------------------------- one order */
// The tracking screen calls this every few seconds, which is how the rider's
// position keeps moving on the map.
router.get("/orders/:id", ...onlyCustomer, async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, customerId: req.user._id })
    .populate("kitchenId", "name phone")
    .populate("branchId", "name address location")
    .populate("riderId", "name phone");
  if (!order) return res.status(404).json({ message: "Order not found." });

  // Only while the order is actually moving. Once it is delivered there is no
  // reason for the customer to keep seeing where the rider went.
  let riderLocation = null;
  let riderAgeSec = null;
  let riderPhoto = "";
  if (order.riderId && ["rider_assigned", "picked_up", "on_the_way"].includes(order.status)) {
    const rider = await Rider.findOne({ userId: order.riderId._id });
    if (rider) {
      if (rider.location?.coordinates?.[0]) riderLocation = rider.location.coordinates;
      // Seconds since the rider's phone last reported. Sent as an age, not a
      // timestamp, so a wrong clock on either device cannot skew it.
      if (rider.locationAt)
        riderAgeSec = Math.max(0, Math.round((Date.now() - rider.locationAt.getTime()) / 1000));
      // So the person at the door is somebody the customer recognises.
      riderPhoto = rider.imageUrl || "";
    }
  }

  res.json({ order, riderLocation, riderAgeSec, riderPhoto });
});

/* ---------------------------------------------------------------- cancel */
// Cancelling is allowed right up until somebody starts cooking, which is the
// moment food would actually be wasted. That covers "placed" and "accepted" -
// a kitchen accepting an order has agreed to cook it but has not started, so
// there is nothing to throw away yet.
//
// Once the status is "preparing" the answer is no. The meat is in the pan.
const CANCELLABLE = ["placed", "accepted"];

router.patch("/orders/:id/cancel", ...onlyCustomer, async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, customerId: req.user._id });
  if (!order) return res.status(404).json({ message: "Order not found." });

  if (!CANCELLABLE.includes(order.status)) {
    const message =
      order.status === "preparing"
        ? "The kitchen has already started cooking, so this can no longer be cancelled."
        : "This order can no longer be cancelled.";
    return res.status(400).json({ message });
  }

  order.status = "cancelled";
  order.cancelReason = String(req.body.reason || "").trim();
  addTimeline(order, "cancelled", "customer", order.cancelReason);
  await order.save();
  orderChanged(order, "cancelled");
  res.json(order);
});

/* ---------------------------------------------------------------- review */
// Left once, after the food has arrived. The food and the rider get separate
// scores, because a cold curry is not the rider's fault and a slow rider did
// not cook anything.
router.post("/orders/:id/review", ...onlyCustomer, async (req, res) => {
  try {
    const { foodRating, foodComment, riderRating, riderComment } = req.body;

    const order = await Order.findOne({ _id: req.params.id, customerId: req.user._id });
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (order.status !== "delivered")
      return res.status(400).json({ message: "You can rate an order once it has arrived." });
    if (order.reviewed)
      return res.status(409).json({ message: "You have already rated this order." });

    const food = Number(foodRating);
    if (!food || food < 1 || food > 5)
      return res.status(400).json({ message: "Give the food a score from 1 to 5." });

    const rider = riderRating ? Number(riderRating) : null;
    if (rider && (rider < 1 || rider > 5))
      return res.status(400).json({ message: "Give the rider a score from 1 to 5." });

    await Review.create({
      orderId: order._id,
      customerId: req.user._id,
      customerName: req.user.name,
      kitchenId: order.kitchenId,
      riderId: order.riderId || null,
      foodRating: food,
      foodComment: String(foodComment || "").trim(),
      riderRating: rider,
      riderComment: String(riderComment || "").trim(),
      dishes: order.items.map((i) => i.name),
    });

    // The averages are kept as a running sum and count, so one review is one
    // small write rather than a re-read of everything ever left.
    await Kitchen.findByIdAndUpdate(order.kitchenId, {
      $inc: { ratingSum: food, ratingCount: 1 },
    });

    // Every dish in the order gets the same score. That is rough - the customer
    // rated the meal, not each plate - but it is the only honest reading of
    // what they actually told us, and it is what lets the grid put the
    // better-liked food first.
    await MenuItem.updateMany(
      { _id: { $in: order.items.map((i) => i.menuItemId) } },
      { $inc: { ratingSum: food, ratingCount: 1 } }
    );
    if (rider && order.riderId) {
      await Rider.findOneAndUpdate(
        { userId: order.riderId },
        { $inc: { ratingSum: rider, ratingCount: 1 } }
      );
    }

    order.reviewed = true;
    await order.save();
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    // The unique index on orderId is the real guard against a double review;
    // this is what it looks like when two taps land at once.
    if (err.code === 11000)
      return res.status(409).json({ message: "You have already rated this order." });
    res.status(500).json({ message: "Could not save your rating. Try again." });
  }
});

/* ---------------------------------------------------------------- report */
// The list of things somebody can report. Sent to the app so the wording is
// written once, and so a count of "cold food" means the same thing every time.
router.get("/report-reasons", auth, (req, res) => res.json(REPORT_REASONS));

router.post("/report", ...onlyCustomer, async (req, res) => {
  try {
    const { kitchenId, orderId, reason, details } = req.body;

    if (!kitchenId) return res.status(400).json({ message: "Which kitchen is this about?" });
    if (!reason || !REPORT_REASONS.includes(reason))
      return res.status(400).json({ message: "Choose a reason from the list." });

    const kitchen = await Kitchen.findById(kitchenId);
    if (!kitchen) return res.status(404).json({ message: "That kitchen is not listed." });

    // An order is optional, but if one is named it has to be this customer's -
    // otherwise anybody could attach a complaint to somebody else's order.
    let order = null;
    if (orderId) {
      order = await Order.findOne({ _id: orderId, customerId: req.user._id });
      if (!order) return res.status(404).json({ message: "That order is not yours." });
    }

    const report = await Report.create({
      kitchenId,
      customerId: req.user._id,
      customerName: req.user.name,
      orderId: order?._id || null,
      orderCode: order?.code || "",
      reason,
      details: String(details || "").trim(),
    });

    res.status(201).json({ ok: true, id: report._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not send that report. Try again." });
  }
});

module.exports = router;
