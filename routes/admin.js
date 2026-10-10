// routes/admin.js
// The review queue. An admin reads a dish, checks its ingredient list against
// what the dish claims to be, and either approves it or sends it back with a
// reason the kitchen can act on.

const express = require("express");
const { tell } = require("../notifier");
const { MenuItem, Kitchen, Branch, User, Rider, Order, Review, Report } = require("../models");
const {
  auth,
  allow,
  settings,
  startOfToday,
  OPEN_STATUSES,
  MOVING_STATUSES,
  toLatLng,
  riderView,
  buildLiveView,
} = require("../helpers");

const router = express.Router();
const onlyAdmin = [auth, allow("admin")];

/* ------------------------------------------------------------- overview */
router.get("/overview", ...onlyAdmin, async (req, res) => {
  const today = startOfToday();

  const [
    pending,
    approved,
    declined,
    kitchens,
    riders,
    ridersWaiting,
    customers,
    deliveredToday,
    live,
  ] =
    await Promise.all([
      MenuItem.countDocuments({ status: "pending" }),
      MenuItem.countDocuments({ status: "approved" }),
      MenuItem.countDocuments({ status: "declined" }),
      Kitchen.countDocuments(),
      Rider.countDocuments(),
      Rider.countDocuments({ status: "pending" }),
      User.countDocuments({ role: "customer" }),
      Order.find({ status: "delivered", deliveredAt: { $gte: today } }),
      Order.countDocuments({
        status: {
          $in: ["placed", "accepted", "preparing", "ready", "rider_assigned", "picked_up", "on_the_way"],
        },
      }),
    ]);

  res.json({
    pending,
    approved,
    declined,
    kitchens,
    riders,
    ridersWaiting,
    customers,
    liveOrders: live,
    commissionPercent: settings.commissionPercent,
    today: {
      delivered: deliveredToday.length,
      food: deliveredToday.reduce((sum, o) => sum + o.foodTotal, 0),
      fees: deliveredToday.reduce((sum, o) => sum + o.deliveryFee, 0),
      commission: deliveredToday.reduce((sum, o) => sum + (o.commissionAmount || 0), 0),
    },
  });
});

/* ----------------------------------------------------------- the reports */
// One endpoint behind the whole reports screen: filter, search, totals and the
// rows themselves.
//
//   ?from=2026-09-01&to=2026-09-30   by date
//   ?status=delivered                by state
//   ?kitchenId=... &riderId=...      by who
//   ?q=SKD-4F92                      order code, customer, kitchen, rider or dish
//
// The money columns are read off each order rather than recalculated, because
// the commission rate was written onto the order the day it was delivered.
router.get("/reports", ...onlyAdmin, async (req, res) => {
  try {
    const { from, to, status, kitchenId, riderId, q } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (kitchenId) filter.kitchenId = kitchenId;
    if (riderId) filter.riderId = riderId;

    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) {
        // Through the end of that day, not the start of it, which is what
        // somebody picking a date on a calendar means.
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    let orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(500)
      .populate("kitchenId", "name ownerName phone")
      .populate("customerId", "name phone")
      .populate("riderId", "name phone");

    // The search box looks across everything a person might type: an order
    // code, somebody's name, or the name of a dish. Done here rather than in
    // the query because the names live on joined records.
    if (q && q.trim()) {
      const needle = q.trim().toLowerCase();
      orders = orders.filter((o) => {
        const haystack = [
          o.code,
          o.kitchenId?.name,
          o.customerId?.name,
          o.customerId?.phone,
          o.riderId?.name,
          o.address,
          ...o.items.map((i) => i.name),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(needle);
      });
    }

    // Totals for the rows actually being shown, so the numbers always match
    // whatever the filters are set to.
    const delivered = orders.filter((o) => o.status === "delivered");
    const totals = {
      orders: orders.length,
      delivered: delivered.length,
      food: delivered.reduce((sum, o) => sum + o.foodTotal, 0),
      deliveryFees: delivered.reduce((sum, o) => sum + o.deliveryFee, 0),
      collected: delivered.reduce((sum, o) => sum + o.total, 0),
      commission: delivered.reduce((sum, o) => sum + (o.commissionAmount || 0), 0),
    };
    // What the kitchens actually keep once the platform's cut is taken out.
    totals.kitchenNet = totals.food - totals.commission;

    res.json({ totals, orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not build the report. Try again." });
  }
});

/* ------------------------------------------------- everything about one order */
// The full record, including the timeline. This is what settles an argument.
router.get("/orders/:id", ...onlyAdmin, async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate("kitchenId", "name ownerName phone")
    .populate("branchId", "name address")
    .populate("customerId", "name phone")
    .populate("riderId", "name phone");
  if (!order) return res.status(404).json({ message: "Order not found." });
  res.json(order);
});

/* --------------------------------------------------------------- settings */
// Everything the admin can change without a developer: delivery pricing,
// commission, the "recommended" threshold, bill due days, contact details.
router.get("/settings", ...onlyAdmin, (req, res) => res.json(require("../platform").getPlatform()));

router.put("/settings", ...onlyAdmin, async (req, res) => {
  try {
    res.json(await require("../platform").savePlatform(req.body || {}));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error(err);
    res.status(500).json({ message: "Could not save the settings." });
  }
});

/* --------------------------------------------------- identity documents */
// The only door to a CNIC picture. Admin only, and every look is logged.
router.get("/documents", ...onlyAdmin, async (req, res) => {
  const doc = await require("../documents").openDocument(req.query.ref);
  if (!doc) return res.status(404).json({ message: "That document was not found." });
  console.log(`[documents] ${req.user.name} (${req.user._id}) viewed ${String(req.query.ref).slice(0, 12)}…`);
  res.set("Cache-Control", "no-store");
  res.json(doc);
});

/* ---------------------------------------------- the lists behind the filters */
router.get("/riders", ...onlyAdmin, async (req, res) => {
  const riders = await Rider.find().sort({ createdAt: 1 }).populate("userId", "name phone");
  // Everything needed to make a decision is here, including the CNIC and the
  // licence - checking those is the whole point of the approval step.
  const rows = await Promise.all(
    riders.map(async (r) => ({
      _id: r._id,
      userId: r.userId?._id,
      name: r.userId?.name,
      phone: r.userId?.phone,
      vehicle: r.vehicle,
      vehicleNumber: r.vehicleNumber,
      vehicleMake: r.vehicleMake,
      vehicleColor: r.vehicleColor,
      licenseNumber: r.licenseNumber,
      cnic: r.cnic,
      cnicFrontRef: r.cnicFrontRef,
      cnicBackRef: r.cnicBackRef,
      imageUrl: r.imageUrl,
      status: r.status,
      decisionReason: r.decisionReason,
      isOnline: r.isOnline,
      maxJobs: r.maxJobs,
      joined: r.createdAt,
      rating: r.ratingCount ? Math.round((r.ratingSum / r.ratingCount) * 10) / 10 : null,
      ratingCount: r.ratingCount,
      delivered: await Order.countDocuments({ riderId: r.userId?._id, status: "delivered" }),
      carrying: await Order.countDocuments({
        riderId: r.userId?._id,
        status: { $in: ["rider_assigned", "picked_up", "on_the_way"] },
      }),
    }))
  );

  res.json(rows);
});

/* ------------------------------------------------------- deciding on a rider */
// Nothing a rider does is possible before this. They can sign in and look at an
// empty screen, and that is all.
router.patch("/riders/:id/decide", ...onlyAdmin, async (req, res) => {
  const { status, reason } = req.body;

  if (!["approved", "rejected", "suspended", "pending"].includes(status))
    return res.status(400).json({ message: "Approve, reject, suspend, or put it back to waiting." });

  // Turning somebody down without saying why leaves them with nothing to fix.
  if ((status === "rejected" || status === "suspended") && !String(reason || "").trim())
    return res.status(400).json({ message: "Give a reason, so the rider knows what is wrong." });

  const rider = await Rider.findById(req.params.id);
  if (!rider) return res.status(404).json({ message: "Rider not found." });

  // Nobody is approved without their papers on file.
  if (status === "approved" && (!rider.cnicFrontRef || !rider.cnicBackRef))
    return res.status(400).json({
      message: "This rider has not uploaded both sides of their CNIC, so they cannot be approved yet.",
    });

  rider.status = status;
  rider.decisionReason = String(reason || "").trim();
  rider.decidedAt = new Date();

  // Somebody who is no longer approved must not stay online holding jobs.
  if (status !== "approved") rider.isOnline = false;

  await rider.save();
  res.json(rider);

  // Tell the rider straight away - this is the message they are waiting for.
  const words = {
    approved: ["You are approved ✅", "Welcome aboard. Go online to start receiving deliveries."],
    rejected: ["Application not accepted", rider.decisionReason],
    suspended: ["Account suspended", rider.decisionReason],
    pending: ["Back under review", "An admin is looking at your account again."],
  }[status];
  tell([rider.userId], { title: words[0], body: words[1], data: { type: "account", status } }, { kind: "account" });
});

/* --------------------------------------------------------- review queue */
router.get("/menu", ...onlyAdmin, async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const items = await MenuItem.find(filter)
    .sort({ status: 1, createdAt: 1 }) // oldest waiting first
    .limit(100)
    .populate("kitchenId", "name ownerName phone");

  res.json(items);
});

/* ------------------------------------------------------ approve/decline */
router.patch("/menu/:id/decide", ...onlyAdmin, async (req, res) => {
  try {
    const { approve, reason } = req.body;

    const item = await MenuItem.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Dish not found." });

    if (approve) {
      item.status = "approved";
      item.declineReason = "";
    } else {
      // A decline without a reason is not useful to anyone. The kitchen cannot
      // fix what it has not been told about, so this is required.
      if (!reason || !String(reason).trim())
        return res
          .status(400)
          .json({ message: "Give a reason, so the kitchen knows what to change." });

      item.status = "declined";
      item.declineReason = String(reason).trim();
    }

    item.reviewedAt = new Date();
    await item.save();
    res.json(item);

    // The kitchen owner hears about every decision on their dishes.
    Kitchen.findById(item.kitchenId).select("ownerId").then((k) => {
      if (!k) return;
      tell(
        [k.ownerId],
        approve
          ? { title: "Dish approved ✅", body: `"${item.name}" is now on the menu.`, data: { type: "dish", itemId: item._id } }
          : { title: "Dish needs changes", body: `"${item.name}": ${item.declineReason}`, data: { type: "dish", itemId: item._id } },
        { kind: "dish" }
      );
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the decision. Try again." });
  }
});

/* ----------------------------------------------------- who is on here */
router.get("/kitchens", ...onlyAdmin, async (req, res) => {
  const kitchens = await Kitchen.find().sort({ createdAt: -1 }).limit(100);

  const withCounts = await Promise.all(
    kitchens.map(async (k) => {
      const items = await MenuItem.find({ kitchenId: k._id }).select("status");
      return {
        _id: k._id,
        name: k.name,
        ownerName: k.ownerName,
        phone: k.phone,
        createdAt: k.createdAt,
        // CNIC is not sent to a list screen. Nothing here needs it.
        dishes: {
          total: items.length,
          approved: items.filter((i) => i.status === "approved").length,
          pending: items.filter((i) => i.status === "pending").length,
          declined: items.filter((i) => i.status === "declined").length,
        },
      };
    })
  );

  res.json(withCounts);
});

/* ------------------------------------------------------------- orders */
router.get("/orders", ...onlyAdmin, async (req, res) => {
  const orders = await Order.find()
    .sort({ createdAt: -1 })
    .limit(60)
    .populate("kitchenId", "name")
    .populate("customerId", "name phone")
    .populate("riderId", "name phone");
  res.json(orders);
});

/* ------------------------------------------------------ live orders board */
// Every order that is still open, oldest first, with the rider's position for
// the ones being carried. The admin screen calls this every 5 seconds.
router.get("/live", ...onlyAdmin, async (req, res) => {
  try {
    const orders = await Order.find({ status: { $in: OPEN_STATUSES } })
      .sort({ createdAt: 1 })
      .populate("kitchenId", "name")
      .populate("branchId", "location")
      .populate("customerId", "name phone")
      .populate("riderId", "name phone");

    // One query for every rider involved, not one per order.
    const riderIds = [...new Set(orders.filter((o) => o.riderId).map((o) => String(o.riderId._id)))];
    const riderDocs = await Rider.find({ userId: { $in: riderIds } });
    const byUser = new Map(riderDocs.map((r) => [String(r.userId), r]));

    const rows = orders.map((o) => {
      const riderDoc = o.riderId ? byUser.get(String(o.riderId._id)) : null;
      const rider = riderDoc ? riderView(riderDoc, o.riderId) : null;
      if (rider && !MOVING_STATUSES.includes(o.status)) rider.location = null;
      const last = o.timeline?.[o.timeline.length - 1];
      return {
        _id: o._id,
        code: o.code,
        status: o.status,
        total: o.total,
        createdAt: o.createdAt,
        statusSince: last?.at || o.createdAt, // how long it has sat in this step
        cookTimeMin: o.cookTimeMin,
        kitchen: o.kitchenId?.name,
        customer: o.customerId?.name,
        rider,
        pickup: toLatLng(o.branchId?.location?.coordinates),
        dropoff: toLatLng(o.location?.coordinates),
      };
    });

    const counts = {};
    for (const s of OPEN_STATUSES) counts[s] = 0;
    for (const r of rows) counts[r.status] += 1;

    res.json({ orders: rows, counts, total: rows.length, serverTime: new Date() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the live orders." });
  }
});

// One order, as it is right now: status, timeline, both ends of the trip and
// the rider's position. Works for finished orders too - the rider's position is
// simply left out once nobody is carrying it.
router.get("/live/:id", ...onlyAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate("kitchenId", "name ownerName phone")
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

/* -------------------------------------------------------------- the logs */
// Every state change of every order, flattened into one list so it reads like a
// diary rather than something you have to open order by order.
//
//   ?from= &to= &kitchenId= &riderId= &event=accepted &q=
router.get("/logs", ...onlyAdmin, async (req, res) => {
  try {
    const { from, to, kitchenId, riderId, event, q } = req.query;

    const filter = {};
    if (kitchenId) filter.kitchenId = kitchenId;
    if (riderId) filter.riderId = riderId;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(300)
      .populate("kitchenId", "name")
      .populate("customerId", "name phone")
      .populate("riderId", "name phone");

    // One row per step, not per order.
    let entries = [];
    for (const o of orders) {
      for (const step of o.timeline) {
        entries.push({
          orderId: o._id,
          code: o.code,
          at: step.at,
          event: step.status,
          by: step.by,
          note: step.note || "",
          kitchen: o.kitchenId?.name || "",
          customer: o.customerId?.name || "",
          customerPhone: o.customerId?.phone || "",
          rider: o.riderId?.name || "",
          dishes: o.items.map((i) => `${i.qty} × ${i.name}`).join(", "),
          total: o.total,
        });
      }
    }

    if (event) entries = entries.filter((e) => e.event === event);

    if (q && q.trim()) {
      const needle = q.trim().toLowerCase();
      entries = entries.filter((e) =>
        [e.code, e.kitchen, e.customer, e.customerPhone, e.rider, e.dishes, e.note]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle)
      );
    }

    entries.sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json({ entries: entries.slice(0, 600), total: entries.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not build the log. Try again." });
  }
});

/* ----------------------------------------------------------- the billing */
// A month of trading, per kitchen and per rider.
//
// Nothing here charges anybody or sends an invoice. It is a statement of what
// happened and what would be owed, which is what you need long before a real
// billing run exists.
router.get("/billing", ...onlyAdmin, async (req, res) => {
  try {
    // Defaults to the month we are in.
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);

    const delivered = await Order.find({
      status: "delivered",
      deliveredAt: { $gte: start, $lt: end },
    })
      .populate("kitchenId", "name ownerName phone")
      .populate("riderId", "name phone");

    /* ------------------------------------------------------- by kitchen */
    const kitchens = {};
    for (const o of delivered) {
      const id = String(o.kitchenId?._id || "unknown");
      kitchens[id] = kitchens[id] || {
        kitchenId: o.kitchenId?._id,
        name: o.kitchenId?.name || "Unknown",
        ownerName: o.kitchenId?.ownerName || "",
        phone: o.kitchenId?.phone || "",
        orders: 0,
        food: 0,
        commission: 0,
        rate: o.commissionRate || settings.commissionPercent,
      };
      kitchens[id].orders += 1;
      kitchens[id].food += o.foodTotal;
      kitchens[id].commission += o.commissionAmount || 0;
    }
    Object.values(kitchens).forEach((k) => {
      k.net = k.food - k.commission; // what the kitchen keeps
    });

    /* --------------------------------------------------------- by rider */
    const riders = {};
    for (const o of delivered) {
      if (!o.riderId) continue;
      const id = String(o.riderId._id);
      riders[id] = riders[id] || {
        riderId: o.riderId._id,
        name: o.riderId.name,
        phone: o.riderId.phone,
        deliveries: 0,
        fees: 0,
        cashHandled: 0,
        owedToKitchens: 0,
      };
      riders[id].deliveries += 1;
      riders[id].fees += o.deliveryFee;      // the rider keeps this
      riders[id].cashHandled += o.total;     // what passed through their hands
      riders[id].owedToKitchens += o.foodTotal;
    }

    res.json({
      month,
      commissionPercent: settings.commissionPercent,
      totals: {
        orders: delivered.length,
        food: delivered.reduce((s, o) => s + o.foodTotal, 0),
        fees: delivered.reduce((s, o) => s + o.deliveryFee, 0),
        collected: delivered.reduce((s, o) => s + o.total, 0),
        commission: delivered.reduce((s, o) => s + (o.commissionAmount || 0), 0),
      },
      kitchens: Object.values(kitchens).sort((a, b) => b.food - a.food),
      riders: Object.values(riders).sort((a, b) => b.deliveries - a.deliveries),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not build the billing. Try again." });
  }
});

/* -------------------------------------------------- everything about one kitchen */
router.get("/kitchens/:id", ...onlyAdmin, async (req, res) => {
  try {
    const kitchen = await Kitchen.findById(req.params.id).populate("ownerId", "name phone email createdAt");
    if (!kitchen) return res.status(404).json({ message: "Kitchen not found." });

    const [branch, dishes, orders, reviews] = await Promise.all([
      Branch.findOne({ kitchenId: kitchen._id }),
      MenuItem.find({ kitchenId: kitchen._id }).sort({ createdAt: -1 }),
      Order.find({ kitchenId: kitchen._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .populate("customerId", "name phone")
        .populate("riderId", "name"),
      Review.find({ kitchenId: kitchen._id }).sort({ createdAt: -1 }).limit(20),
    ]);

    const reports = await Report.find({ kitchenId: kitchen._id }).sort({ createdAt: -1 }).limit(30);

    const delivered = orders.filter((o) => o.status === "delivered");

    // Which dishes actually sell, counted across the orders on file.
    const dishCounts = {};
    delivered.forEach((o) =>
      o.items.forEach((i) => {
        dishCounts[i.name] = dishCounts[i.name] || { name: i.name, qty: 0, value: 0 };
        dishCounts[i.name].qty += i.qty;
        dishCounts[i.name].value += i.price * i.qty;
      })
    );

    res.json({
      kitchen,
      owner: kitchen.ownerId,
      branch,
      rating: {
        average: kitchen.ratingCount
          ? Math.round((kitchen.ratingSum / kitchen.ratingCount) * 10) / 10
          : null,
        count: kitchen.ratingCount,
      },
      dishes,
      dishCounts: Object.values(dishCounts).sort((a, b) => b.qty - a.qty),
      orders,
      reviews,
      reports,
      money: {
        delivered: delivered.length,
        food: delivered.reduce((s, o) => s + o.foodTotal, 0),
        commission: delivered.reduce((s, o) => s + (o.commissionAmount || 0), 0),
        net: delivered.reduce((s, o) => s + o.foodTotal - (o.commissionAmount || 0), 0),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load that kitchen." });
  }
});

/* -------------------------------------------------------------- reviews */
// What customers said, across every kitchen, newest first.
//   ?kitchenId=  ?min=1..5  ?q=
router.get("/reviews", ...onlyAdmin, async (req, res) => {
  try {
    const filter = {};
    if (req.query.kitchenId) filter.kitchenId = req.query.kitchenId;
    if (req.query.min) filter.foodRating = { $lte: Number(req.query.min) };

    let reviews = await Review.find(filter)
      .sort({ createdAt: -1 })
      .limit(300)
      .populate("kitchenId", "name")
      .populate("riderId", "name");

    const q = String(req.query.q || "").trim().toLowerCase();
    if (q) {
      reviews = reviews.filter((r) =>
        [r.customerName, r.kitchenId?.name, r.foodComment, r.riderComment, ...(r.dishes || [])]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)
      );
    }

    const food = reviews.filter((r) => r.foodRating);
    const rider = reviews.filter((r) => r.riderRating);

    res.json({
      reviews,
      summary: {
        count: reviews.length,
        foodAverage: food.length
          ? Math.round((food.reduce((s, r) => s + r.foodRating, 0) / food.length) * 10) / 10
          : null,
        riderAverage: rider.length
          ? Math.round((rider.reduce((s, r) => s + r.riderRating, 0) / rider.length) * 10) / 10
          : null,
        // The ones worth reading first.
        poor: food.filter((r) => r.foodRating <= 2).length,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the reviews." });
  }
});

/* ----------------------------------------------------------- complaints */
// Called /complaints, not /reports. There is already a /reports endpoint above
// for the money report, and two routes with the same path is not a clash
// Express warns about - it silently uses the first one and the second never
// runs. That is exactly why kitchen complaints were not reaching this screen.
//
//   ?kitchenId=  ?status=open|acted|no_fault
router.get("/complaints", ...onlyAdmin, async (req, res) => {
  try {
    const filter = {};
    if (req.query.kitchenId) filter.kitchenId = req.query.kitchenId;
    if (req.query.status) filter.status = req.query.status;

    const reports = await Report.find(filter)
      .sort({ createdAt: -1 })
      .limit(300)
      .populate("kitchenId", "name ownerName phone");

    // Which kitchens are being complained about, and how often. One angry
    // customer is noise; the same complaint six times is a pattern.
    const byKitchen = {};
    const all = await Report.find().populate("kitchenId", "name");
    all.forEach((r) => {
      const id = String(r.kitchenId?._id || "unknown");
      byKitchen[id] = byKitchen[id] || {
        kitchenId: r.kitchenId?._id,
        name: r.kitchenId?.name || "Unknown",
        total: 0,
        open: 0,
        reasons: {},
      };
      byKitchen[id].total += 1;
      if (r.status === "open") byKitchen[id].open += 1;
      byKitchen[id].reasons[r.reason] = (byKitchen[id].reasons[r.reason] || 0) + 1;
    });

    res.json({
      reports,
      openCount: await Report.countDocuments({ status: "open" }),
      byKitchen: Object.values(byKitchen).sort((a, b) => b.total - a.total),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the reports." });
  }
});

router.patch("/complaints/:id", ...onlyAdmin, async (req, res) => {
  const { status, adminNote } = req.body;
  if (!["acted", "no_fault", "open"].includes(status))
    return res
      .status(400)
      .json({ message: "Say whether you acted on it, found no fault, or leave it open." });

  const report = await Report.findByIdAndUpdate(
    req.params.id,
    {
      status,
      adminNote: String(adminNote || "").trim(),
      handledAt: status === "open" ? null : new Date(),
    },
    { new: true }
  );
  if (!report) return res.status(404).json({ message: "Report not found." });
  res.json(report);

  // Whoever filed it is told once it has been looked at.
  if (status !== "open" && report.customerId)
    tell(
      [report.customerId],
      {
        title: "Your report was reviewed",
        body: status === "acted" ? "We acted on it. Thank you." : "We looked into it and found no fault.",
        data: { type: "report" },
      },
      { kind: "report" }
    );
});

module.exports = router;
