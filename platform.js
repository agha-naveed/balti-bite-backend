// platform.js
// The numbers and details an admin can change from the app, without touching
// code or restarting the server:
//
//   - the delivery fee, which grows with the road distance
//   - the commission the platform takes
//   - the monthly sales a kitchen needs to be "recommended"
//   - how many days a bill is open before it is overdue
//   - the company's name and contact details
//
// They are saved in the database. The values in .env are only the starting
// point for a brand-new install; once an admin saves, the database wins.
//
// `settings` (helpers.js) is updated IN PLACE, so every route that reads
// settings.commissionPercent etc. sees the new value on its very next request.

const { Setting } = require("./models");
const { settings } = require("./helpers");

const DEFAULTS = () => ({
  commissionPercent: Number(process.env.COMMISSION_PERCENT || 5),
  recommendedMonthlySales: Number(process.env.RECOMMENDED_MONTHLY_SALES || 50000),
  billDueDays: Number(process.env.BILL_DUE_DAYS || 7),
  delivery: {
    // Rs 80 covers the first 5 km. Each km after that adds perExtraKm.
    baseFee: Number(process.env.DELIVERY_FEE || 80),
    baseKm: Number(process.env.DELIVERY_BASE_KM || 5),
    perExtraKm: Number(process.env.DELIVERY_PER_EXTRA_KM || 20),
    maxFee: Number(process.env.DELIVERY_MAX_FEE || 0), // 0 = no ceiling
  },
  // Who gets a ready order. Only riders who are online, free, and have shared a
  // FRESH location within maxPickupKm BY ROAD of the kitchen are asked, nearest
  // first.
  dispatch: {
    maxPickupKm: Number(process.env.DISPATCH_MAX_PICKUP_KM || 8),
    offerSeconds: Number(process.env.DISPATCH_OFFER_SECONDS || 60),
    locationFreshSeconds: Number(process.env.DISPATCH_LOCATION_FRESH_SECONDS || 180),
  },
  contacts: {
    companyName: process.env.COMPANY_NAME || "",
    supportPhone: process.env.SUPPORT_PHONE || "",
    whatsapp: "",
    supportEmail: "",
    address: "",
    hours: "",
    about: "",
  },
});

let current = DEFAULTS();

function apply(next) {
  current = next;
  settings.commissionPercent = next.commissionPercent;
  settings.recommendedMonthlySales = next.recommendedMonthlySales;
  settings.billDueDays = next.billDueDays;
  settings.delivery = next.delivery;
  settings.dispatch = next.dispatch;
  settings.contacts = next.contacts;
  // The fee for the first stretch. Old code that shows "the delivery fee" still
  // works; it just means "from this price".
  settings.deliveryFee = next.delivery.baseFee;
}

async function loadPlatform() {
  const row = await Setting.findOne({ key: "platform" });
  const base = DEFAULTS();
  const saved = row?.value || {};
  apply({
    ...base,
    ...saved,
    delivery: { ...base.delivery, ...(saved.delivery || {}) },
    dispatch: { ...base.dispatch, ...(saved.dispatch || {}) },
    contacts: { ...base.contacts, ...(saved.contacts || {}) },
  });
  return current;
}

const num = (v, name, { min = 0, max = 1e7 } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max)
    throw Object.assign(new Error(`${name} must be a number from ${min} to ${max}.`), { status: 400 });
  return n;
};
const text = (v, max = 300) => String(v ?? "").trim().slice(0, max);

// patch: the same shape as getPlatform(). Anything not sent stays as it was.
async function savePlatform(patch) {
  const next = {
    ...current,
    delivery: { ...current.delivery },
    dispatch: { ...current.dispatch },
    contacts: { ...current.contacts },
  };

  if (patch.commissionPercent !== undefined)
    next.commissionPercent = num(patch.commissionPercent, "Commission", { max: 100 });
  if (patch.recommendedMonthlySales !== undefined)
    next.recommendedMonthlySales = num(patch.recommendedMonthlySales, "Recommended monthly sales");
  if (patch.billDueDays !== undefined)
    next.billDueDays = Math.round(num(patch.billDueDays, "Days to pay a bill", { min: 1, max: 90 }));

  const d = patch.delivery;
  if (d) {
    if (d.baseFee !== undefined) next.delivery.baseFee = num(d.baseFee, "Base delivery fee", { max: 5000 });
    if (d.baseKm !== undefined) next.delivery.baseKm = num(d.baseKm, "Base distance", { min: 0.5, max: 100 });
    if (d.perExtraKm !== undefined) next.delivery.perExtraKm = num(d.perExtraKm, "Fee per extra km", { max: 2000 });
    if (d.maxFee !== undefined) next.delivery.maxFee = num(d.maxFee, "Maximum delivery fee", { max: 20000 });
    if (next.delivery.maxFee && next.delivery.maxFee < next.delivery.baseFee)
      throw Object.assign(new Error("The maximum fee cannot be lower than the base fee."), { status: 400 });
  }

  const q = patch.dispatch;
  if (q) {
    if (q.maxPickupKm !== undefined)
      next.dispatch.maxPickupKm = num(q.maxPickupKm, "Furthest rider pickup distance", { min: 0.5, max: 100 });
    if (q.offerSeconds !== undefined)
      next.dispatch.offerSeconds = Math.round(num(q.offerSeconds, "Seconds to answer a request", { min: 10, max: 600 }));
    if (q.locationFreshSeconds !== undefined)
      next.dispatch.locationFreshSeconds = Math.round(
        num(q.locationFreshSeconds, "How recent a rider's location must be", { min: 30, max: 3600 })
      );
  }

  const c = patch.contacts;
  if (c) {
    for (const k of ["companyName", "supportPhone", "whatsapp", "supportEmail", "address", "hours"])
      if (c[k] !== undefined) next.contacts[k] = text(c[k], 200);
    if (c.about !== undefined) next.contacts.about = text(c.about, 1000);
  }

  await Setting.findOneAndUpdate({ key: "platform" }, { value: next }, { upsert: true });
  apply(next);
  return current;
}

// Delivery fee for a road distance in km.
//   up to baseKm      -> baseFee
//   beyond            -> baseFee + perExtraKm for every started extra km
//   never above       -> maxFee (when one is set)
// Unknown distance (no address yet) shows the base fee.
function feeForKm(km) {
  const d = current.delivery;
  if (!Number.isFinite(km) || km <= d.baseKm) return d.baseFee;
  const extra = Math.ceil(km - d.baseKm);
  let fee = d.baseFee + extra * d.perExtraKm;
  if (d.maxFee > 0) fee = Math.min(fee, d.maxFee);
  return Math.round(fee);
}

const getPlatform = () => current;

// What any signed-out visitor may see.
function publicInfo() {
  return { delivery: current.delivery, contacts: current.contacts };
}

module.exports = { loadPlatform, savePlatform, getPlatform, feeForKm, publicInfo };
