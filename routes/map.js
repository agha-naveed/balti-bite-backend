// routes/map.js
// The Skardu map: places that OpenStreetMap does not know (areas, roundabouts,
// shops), roads traced by hand, and road distance between two points.
//
// Reading is open to everyone - the sign-up and checkout screens search places
// before anyone has an account. Only an admin can add, change or delete.

const express = require("express");
const rateLimit = require("express-rate-limit");
const { Place, RouteOverride, PLACE_TYPES } = require("../models");
const { auth, allow } = require("../helpers");
const { routeBetween, pathKm, clearOverrideCache } = require("../routing");

const router = express.Router();
const onlyAdmin = [auth, allow("admin")];

// A rough box around Skardu, Shigar, Kachura and Khaplu. It exists to catch a
// swapped latitude/longitude or a stray tap far away, not to limit the service.
const REGION = { minLat: 34.7, maxLat: 36.0, minLng: 74.8, maxLng: 77.0 };
const inRegion = (lat, lng) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  lat >= REGION.minLat && lat <= REGION.maxLat &&
  lng >= REGION.minLng && lng <= REGION.maxLng;

const escapeRegex = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function shape(p) {
  return {
    _id: p._id,
    name: p.name,
    type: p.type,
    aliases: p.aliases || [],
    notes: p.notes || "",
    lat: p.location?.coordinates?.[1],
    lng: p.location?.coordinates?.[0],
  };
}

/* ---------------------------------------------------------------- places */
// ?q=text  ?type=roundabout  ?lat=&lng= (nearest first)  ?limit=
router.get("/places", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 60, 500);
    const filter = {};
    if (PLACE_TYPES.includes(req.query.type)) filter.type = req.query.type;
    if (req.query.q) {
      const rx = new RegExp(escapeRegex(String(req.query.q).trim()), "i");
      filter.$or = [{ name: rx }, { aliases: rx }];
    }

    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && req.query.lat !== "") {
      const rows = await Place.aggregate([
        {
          $geoNear: {
            near: { type: "Point", coordinates: [lng, lat] },
            distanceField: "distanceM",
            spherical: true,
            query: filter,
          },
        },
        { $limit: limit },
      ]);
      return res.json(rows.map((p) => ({ ...shape(p), distanceM: Math.round(p.distanceM) })));
    }

    const rows = await Place.find(filter).sort({ name: 1 }).limit(limit);
    res.json(rows.map(shape));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load places." });
  }
});

function readPlace(body) {
  const name = String(body.name || "").trim();
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!name) return { error: "Give the place a name." };
  if (!inRegion(lat, lng))
    return { error: "That point is outside the Skardu region. Check latitude and longitude are not swapped." };
  const type = PLACE_TYPES.includes(body.type) ? body.type : "other";
  const aliases = (Array.isArray(body.aliases) ? body.aliases : String(body.aliases || "").split(","))
    .map((a) => String(a).trim())
    .filter(Boolean)
    .slice(0, 10);
  return {
    value: {
      name,
      type,
      aliases,
      notes: String(body.notes || "").trim(),
      location: { type: "Point", coordinates: [lng, lat] },
    },
  };
}

router.post("/places", ...onlyAdmin, async (req, res) => {
  const { error, value } = readPlace(req.body);
  if (error) return res.status(400).json({ message: error });

  // The same name twice within 100 m is almost certainly a double tap.
  const dupe = await Place.findOne({
    name: new RegExp(`^${escapeRegex(value.name)}$`, "i"),
    location: { $near: { $geometry: value.location, $maxDistance: 100 } },
  });
  if (dupe) return res.status(409).json({ message: `"${value.name}" is already on the map right here.` });

  const place = await Place.create({ ...value, createdBy: req.user._id });
  res.status(201).json(shape(place));
});

router.patch("/places/:id", ...onlyAdmin, async (req, res) => {
  const { error, value } = readPlace(req.body);
  if (error) return res.status(400).json({ message: error });
  const place = await Place.findByIdAndUpdate(req.params.id, value, { new: true });
  if (!place) return res.status(404).json({ message: "Place not found." });
  res.json(shape(place));
});

router.delete("/places/:id", ...onlyAdmin, async (req, res) => {
  await Place.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------ road route */
// ?fromLat= &fromLng= &toLat= &toLng= [&path=1]
// `source` tells the screen how the number was found: "manual" (a road you
// traced), "osrm" (the road network) or "estimate" (a guess - show it with "~").
const routeLimit = rateLimit({ windowMs: 60 * 1000, max: 90, standardHeaders: true, legacyHeaders: false });

router.get("/route", routeLimit, async (req, res) => {
  const a = { lat: Number(req.query.fromLat), lng: Number(req.query.fromLng) };
  const b = { lat: Number(req.query.toLat), lng: Number(req.query.toLng) };
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite))
    return res.status(400).json({ message: "Give fromLat, fromLng, toLat and toLng." });
  res.json(await routeBetween(a, b, { path: req.query.path === "1" }));
});

/* ----------------------------------------------------- hand-traced roads */
router.get("/overrides", ...onlyAdmin, async (req, res) => {
  res.json(await RouteOverride.find().sort({ createdAt: -1 }));
});

// Body: { name, path: [{lat,lng}, ...], from?: {label}, to?: {label}, twoWay?, durationMin? }
// The distance is the length of the line, so it is exactly what was traced.
router.post("/overrides", ...onlyAdmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const path = (Array.isArray(req.body.path) ? req.body.path : [])
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
    .filter((p) => inRegion(p.lat, p.lng));

  if (!name) return res.status(400).json({ message: "Give this road a name." });
  if (path.length < 2) return res.status(400).json({ message: "Click at least two points along the road." });

  const first = path[0];
  const last = path[path.length - 1];
  const row = await RouteOverride.create({
    name,
    path,
    from: { ...first, label: String(req.body.from?.label || "") },
    to: { ...last, label: String(req.body.to?.label || "") },
    distanceKm: pathKm(path),
    durationMin: Number(req.body.durationMin) > 0 ? Number(req.body.durationMin) : null,
    twoWay: req.body.twoWay !== false,
    createdBy: req.user._id,
  });
  clearOverrideCache();
  res.status(201).json(row);
});

router.delete("/overrides/:id", ...onlyAdmin, async (req, res) => {
  await RouteOverride.findByIdAndDelete(req.params.id);
  clearOverrideCache();
  res.json({ ok: true });
});

module.exports = router;
