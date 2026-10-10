// routing.js
// Distance BY ROAD between two points in the Skardu region.
//
// Straight-line distance lies badly here: the valley is split by the Indus and
// roads wind around it. This asks, in order:
//
//   1. A road traced by hand (RouteOverride). If an admin labelled the road
//      between two places, that is the truth - it beats everything.
//   2. OSRM, the routing server built on OpenStreetMap roads.
//   3. An estimate: straight line x a detour factor, clearly marked as an
//      estimate so nobody mistakes it for a measured distance.
//
// Used when an order is placed (can this kitchen reach the customer?) and by
// the maps (draw the road, show distance and time).

const { RouteOverride } = require("./models");
const roadnet = require("./roadnet");

const OSRM_URL = (process.env.OSRM_URL || "https://router.project-osrm.org").replace(/\/+$/, "");
// Skardu's roads wander, so a straight line understates the trip.
const DETOUR = Number(process.env.ROUTE_DETOUR_FACTOR || 1.5);
// Average speed for the estimate and for hand-labelled roads without a time.
const AVG_KMH = Number(process.env.ROUTE_AVG_KMH || 25);

const toRad = (d) => (d * Math.PI) / 180;
function meters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Length of a traced line, in km. Used when an admin saves a hand-drawn road.
function pathKm(path) {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += meters(path[i - 1], path[i]);
  return Math.round((m / 1000) * 100) / 100;
}

/* -------------------------------------------------------- hand-made roads */
let netCache = { at: 0, net: null };
async function network() {
  if (!netCache.net || Date.now() - netCache.at > 30000) {
    const rows = await RouteOverride.find().lean();
    netCache = { at: Date.now(), net: roadnet.build(rows) };
  }
  return netCache.net;
}
function clearOverrideCache() {
  netCache = { at: 0, net: null };
}

// Roads drawn by hand form one network. If both ends are near drawn roads and
// the roads connect them, the distance is measured ALONG those roads.
async function fromOverride(a, b) {
  const hit = roadnet.route(await network(), a, b);
  if (!hit) return null;
  return {
    distanceKm: hit.distanceKm,
    durationMin: Math.max(1, Math.round((hit.distanceKm / AVG_KMH) * 60)),
    path: hit.path,
    source: "manual",
    label: hit.roads.join(" + "),
  };
}

/* ------------------------------------------------------------------ OSRM */
const cache = new Map(); // "lat,lng;lat,lng" -> { at, value }
const TTL_MS = 10 * 60 * 1000;
const key = (a, b) => `${a.lat.toFixed(4)},${a.lng.toFixed(4)};${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;

async function fromOsrm(a, b, wantPath) {
  const k = key(a, b) + (wantPath ? "p" : "");
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const url =
      `${OSRM_URL}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}` +
      `?overview=${wantPath ? "full" : "false"}&geometries=geojson`;
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    const json = await r.json();
    const best = json?.routes?.[0];
    if (!best) return null;
    const value = {
      distanceKm: Math.round((best.distance / 1000) * 100) / 100,
      durationMin: Math.max(1, Math.round(best.duration / 60)),
      path: wantPath ? best.geometry.coordinates.map(([lng, lat]) => [lat, lng]) : null,
      source: "osrm",
    };
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    cache.set(k, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ main */
// a, b: { lat, lng }.  Always returns something - never throws.
async function routeBetween(a, b, { path = false } = {}) {
  const manual = await fromOverride(a, b);
  if (manual) return manual;

  const road = await fromOsrm(a, b, path);
  if (road) return road;

  const straight = meters(a, b) / 1000;
  const km = Math.round(straight * DETOUR * 100) / 100;
  return {
    distanceKm: km,
    durationMin: Math.max(1, Math.round((km / AVG_KMH) * 60)),
    path: path ? [[a.lat, a.lng], [b.lat, b.lng]] : null,
    source: "estimate",
  };
}

module.exports = { routeBetween, pathKm, meters, clearOverrideCache };
