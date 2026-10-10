// routes/public.js
// Everything a visitor can see before they have an account.
//
// No token is needed on any of these. Somebody should be able to look at the
// food, read the ingredients and decide they want it before being asked to sign
// up. The sign-in wall goes at checkout, not at the front door.
//
// Nothing here returns a phone number, a CNIC, or anything else not meant for a
// stranger.

const express = require("express");
const { Kitchen, Branch, MenuItem, Order, Review } = require("../models");
const { settings } = require("../helpers");

const router = express.Router();

// A kitchen selling this much in a calendar month gets a badge.

/* -------------------------------------------------------- which kitchens */
// Every open kitchen that would actually deliver to a given point.
//
// Each branch carries its own delivery radius, so "in range" is per kitchen,
// not one number for the whole city. Without coordinates every open kitchen
// comes back, and the app asks for a location before ordering.
async function kitchensInRange(lat, lng) {
  const open = await Branch.find({ isOpen: true });

  if (lat === undefined || lng === undefined || Number.isNaN(lat) || Number.isNaN(lng)) {
    return { branches: open, located: false };
  }

  const near = await Branch.aggregate([
    {
      $geoNear: {
        near: { type: "Point", coordinates: [lng, lat] },
        distanceField: "distanceM",
        spherical: true,
        query: { isOpen: true },
      },
    },
  ]);

  // $geoNear gives distance in metres; each branch decides its own limit.
  const inRange = near.filter((b) => b.distanceM / 1000 <= (b.deliveryRadiusKm || 15));
  return { branches: inRange, located: true };
}

// Which kitchens have sold enough this month to be recommended.
async function recommendedKitchenIds() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const rows = await Order.aggregate([
    { $match: { status: "delivered", deliveredAt: { $gte: start } } },
    { $group: { _id: "$kitchenId", sales: { $sum: "$foodTotal" } } },
    { $match: { sales: { $gte: settings.recommendedMonthlySales } } },
  ]);

  return new Set(rows.map((r) => String(r._id)));
}

function average(sum, count) {
  return count ? Math.round((sum / count) * 10) / 10 : null;
}

/* ------------------------------------------------------------- the grid */
// One flat grid of dishes, the way a food app looks, rather than a list of
// restaurants to dig through.
//
//   ?lat= &lng=   only kitchens that deliver there
//   ?q=           dish name
//   ?sort=rating|price_low|price_high
// Prices and contact details for signed-out visitors (the sign-in screen, the
// "how delivery is priced" note at checkout).
router.get("/info", (req, res) => res.json(require("../platform").publicInfo()));

router.get("/browse", async (req, res) => {
  try {
    const lat = req.query.lat !== undefined ? Number(req.query.lat) : undefined;
    const lng = req.query.lng !== undefined ? Number(req.query.lng) : undefined;
    const q = String(req.query.q || "").trim();
    const sort = String(req.query.sort || "rating");

    const { branches, located } = await kitchensInRange(lat, lng);
    if (branches.length === 0) {
      return res.json({
        located,
        deliveryFee: settings.deliveryFee,
        radiusNote: located ? "No kitchen delivers to that spot yet." : "",
        dishes: [],
        kitchens: [],
      });
    }

    const branchByKitchen = {};
    branches.forEach((b) => (branchByKitchen[String(b.kitchenId)] = b));
    const kitchenIds = Object.keys(branchByKitchen);

    const [kitchens, recommended] = await Promise.all([
      Kitchen.find({ _id: { $in: kitchenIds } }),
      recommendedKitchenIds(),
    ]);
    const kitchenById = {};
    kitchens.forEach((k) => (kitchenById[String(k._id)] = k));

    const filter = {
      kitchenId: { $in: kitchenIds },
      status: "approved",
      available: true,
    };
    if (q) filter.name = { $regex: q, $options: "i" };

    const found = await MenuItem.find(filter).limit(300);

    const dishes = found
      .map((d) => {
        const kitchen = kitchenById[String(d.kitchenId)];
        const branch = branchByKitchen[String(d.kitchenId)];
        if (!kitchen || !branch) return null;

        return {
          menuItemId: d._id,
          name: d.name,
          description: d.description,
          price: d.price,
          cookTimeMin: d.cookTimeMin,
          images: d.images,
          ingredients: d.ingredients,
          rating: average(d.ratingSum, d.ratingCount),
          ratingCount: d.ratingCount,

          kitchenId: kitchen._id,
          kitchenName: kitchen.name,
          kitchenImage: kitchen.imageUrl,
          kitchenRating: average(kitchen.ratingSum, kitchen.ratingCount),
          kitchenRatingCount: kitchen.ratingCount,
          recommended: recommended.has(String(kitchen._id)),
          distanceKm:
            branch.distanceM !== undefined
              ? Math.round((branch.distanceM / 1000) * 10) / 10
              : null,
        };
      })
      .filter(Boolean);

    /* ------------------------------------------------------------ order */
    if (sort === "price_low") dishes.sort((a, b) => a.price - b.price);
    else if (sort === "price_high") dishes.sort((a, b) => b.price - a.price);
    else {
      // Rated dishes first, best first. Everything with no rating yet is
      // shuffled instead of being left in database order - otherwise the same
      // new kitchen sits at the top for ever and never gets its first order.
      const rated = dishes.filter((d) => d.ratingCount > 0);
      const unrated = dishes.filter((d) => d.ratingCount === 0);

      rated.sort((a, b) => b.rating - a.rating || b.ratingCount - a.ratingCount);
      for (let i = unrated.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [unrated[i], unrated[j]] = [unrated[j], unrated[i]];
      }
      dishes.length = 0;
      dishes.push(...rated, ...unrated);
    }

    // The kitchens behind those dishes, for the strip along the top.
    const shown = {};
    dishes.forEach((d) => {
      shown[String(d.kitchenId)] = shown[String(d.kitchenId)] || {
        kitchenId: d.kitchenId,
        kitchenName: d.kitchenName,
        imageUrl: d.kitchenImage,
        rating: d.kitchenRating,
        ratingCount: d.kitchenRatingCount,
        recommended: d.recommended,
        distanceKm: d.distanceKm,
        dishes: 0,
      };
      shown[String(d.kitchenId)].dishes += 1;
    });

    res.json({
      located,
      deliveryFee: settings.deliveryFee,
      dishes,
      kitchens: Object.values(shown),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the food right now. Try again." });
  }
});

/* ------------------------------------------------------ one dish, deeply */
// What somebody sees when they tap a dish: the photos, what is in it, and what
// people who ate it said.
router.get("/dish/:id", async (req, res) => {
  try {
    const dish = await MenuItem.findOne({ _id: req.params.id, status: "approved" });
    if (!dish) return res.status(404).json({ message: "That dish is not listed." });

    const kitchen = await Kitchen.findById(dish.kitchenId);
    const branch = await Branch.findOne({ kitchenId: dish.kitchenId });
    const recommended = await recommendedKitchenIds();

    // Reviews of orders that actually contained this dish.
    const reviews = await Review.find({ kitchenId: dish.kitchenId, dishes: dish.name })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("customerName foodRating foodComment createdAt");

    res.json({
      menuItemId: dish._id,
      name: dish.name,
      description: dish.description,
      price: dish.price,
      cookTimeMin: dish.cookTimeMin,
      images: dish.images,
      ingredients: dish.ingredients,
      available: dish.available,
      rating: average(dish.ratingSum, dish.ratingCount),
      ratingCount: dish.ratingCount,

      kitchenId: kitchen?._id,
      kitchenName: kitchen?.name,
      kitchenImage: kitchen?.imageUrl,
      kitchenDescription: kitchen?.description,
      kitchenRating: average(kitchen?.ratingSum, kitchen?.ratingCount),
      kitchenRatingCount: kitchen?.ratingCount || 0,
      recommended: recommended.has(String(kitchen?._id)),
      isOpen: Boolean(branch?.isOpen),
      openTime: branch?.openTime || "",
      closeTime: branch?.closeTime || "",

      reviews,
      deliveryFee: settings.deliveryFee,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load that dish." });
  }
});

/* --------------------------------------------------- one kitchen's page */
router.get("/kitchen/:id", async (req, res) => {
  try {
    const kitchen = await Kitchen.findById(req.params.id);
    if (!kitchen) return res.status(404).json({ message: "That kitchen is not listed." });

    const branch = await Branch.findOne({ kitchenId: kitchen._id });
    const dishes = await MenuItem.find({
      kitchenId: kitchen._id,
      status: "approved",
      available: true,
    }).sort({ name: 1 });

    const recommended = await recommendedKitchenIds();
    const reviews = await Review.find({ kitchenId: kitchen._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("customerName foodRating foodComment dishes createdAt");

    // Deliberately NOT sent: the street address, the landmark, the owner's
    // phone number and the CNIC. A customer needs to know what the food is,
    // what it costs and what other people thought of it. They do not need to
    // know where the cook lives - a rider collects the food, and the kitchen's
    // own number is on the order once one exists.
    res.json({
      kitchenId: kitchen._id,
      kitchenName: kitchen.name,
      description: kitchen.description,
      imageUrl: kitchen.imageUrl,
      videoUrl: kitchen.videoUrl,
      isOpen: Boolean(branch?.isOpen),
      openTime: branch?.openTime || "",
      closeTime: branch?.closeTime || "",
      joined: kitchen.createdAt,
      rating: average(kitchen.ratingSum, kitchen.ratingCount),
      ratingCount: kitchen.ratingCount,
      recommended: recommended.has(String(kitchen._id)),
      reviews,
      deliveryFee: settings.deliveryFee,
      items: dishes.map((d) => ({
        menuItemId: d._id,
        name: d.name,
        description: d.description,
        price: d.price,
        cookTimeMin: d.cookTimeMin,
        images: d.images,
        ingredients: d.ingredients,
        rating: average(d.ratingSum, d.ratingCount),
        ratingCount: d.ratingCount,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load that kitchen." });
  }
});

module.exports = router;
