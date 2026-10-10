// billing.js
// Turning a month of delivered orders into one bill per kitchen.
//
// WHAT IS BILLED
// The platform's commission on every order the kitchen delivered. Each order
// carries its own commission (worked out the day it was delivered), so changing
// the rate later never changes a bill that already exists.
//
// NOTHING IS MISSED, NOTHING IS BILLED TWICE
// A bill takes every delivered order that is not on a bill yet and was
// delivered before the cut-off, then stamps those orders with the bill's id.
// An order delivered a minute after the cut-off simply rolls into next month.
//
// WHEN
//   end_of_month    bill the month that is ending, including everything so far
//   start_of_month  bill the month that just ended, cut off at its last second
// An admin can press either button any time, or let the schedule do it.
// All dates are Pakistan time (UTC+5), because "the 1st" means the 1st there.

const { Order, Kitchen, Invoice, Setting } = require("./models");
const { settings } = require("./helpers");
const { tell } = require("./notifier");

const PKT_HOURS = 5;

/* ---------------------------------------------------------- Pakistan time */
const pkt = (d = new Date()) => new Date(d.getTime() + PKT_HOURS * 3600 * 1000);
const monthOf = (d = new Date()) => pkt(d).toISOString().slice(0, 7);
const startOfMonth = (month) => new Date(`${month}-01T00:00:00+05:00`);
function nextMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
function prevMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/* --------------------------------------------------------------- settings */
async function getSetting(key, fallback) {
  const row = await Setting.findOne({ key });
  return row ? row.value : fallback;
}
async function putSetting(key, value) {
  await Setting.findOneAndUpdate({ key }, { value }, { upsert: true });
}

function accountsFromEnv() {
  try {
    const parsed = JSON.parse(process.env.PAYMENT_ACCOUNTS || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
async function getAccounts() {
  const saved = await getSetting("paymentAccounts", null);
  return Array.isArray(saved) ? saved : accountsFromEnv();
}

/* ---------------------------------------------------------------- issuing */
// Works out the period and cut-off for a mode, and what each kitchen would owe.
async function unbilled(mode, month) {
  if (!["end_of_month", "start_of_month"].includes(mode))
    throw Object.assign(new Error("Choose end of month or start of month."), { status: 400 });

  const now = new Date();
  const thisMonth = monthOf(now);
  const period = month || (mode === "end_of_month" ? thisMonth : prevMonth(thisMonth));

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
    throw Object.assign(new Error("The month must look like 2026-09."), { status: 400 });
  if (period > thisMonth)
    throw Object.assign(new Error("That month has not started yet."), { status: 400 });

  // Everything delivered before this moment is fair game.
  const monthEnd = startOfMonth(nextMonth(period));
  const cutoff = mode === "end_of_month" || monthEnd > now ? now : monthEnd;

  const groups = await Order.aggregate([
    { $match: { status: "delivered", invoiceId: null, deliveredAt: { $lt: cutoff } } },
    {
      $group: {
        _id: "$kitchenId",
        orders: { $sum: 1 },
        food: { $sum: "$foodTotal" },
        commission: { $sum: "$commissionAmount" },
      },
    },
  ]);
  return { now, period, cutoff, groups };
}

// What each kitchen WOULD be billed, so the admin can choose who to send to.
async function previewInvoices({ mode, month }) {
  const { period, groups } = await unbilled(mode, month);
  const rows = [];
  for (const g of groups) {
    if (g.commission <= 0) continue;
    const kitchen = await Kitchen.findById(g._id).select("name ownerName phone");
    if (!kitchen) continue;
    rows.push({
      kitchenId: String(g._id),
      name: kitchen.name,
      ownerName: kitchen.ownerName,
      orders: g.orders,
      food: g.food,
      amount: g.commission,
      alreadyBilled: Boolean(await Invoice.exists({ kitchenId: g._id, period })),
    });
  }
  rows.sort((a, b) => b.amount - a.amount);
  return { period, rows };
}

// kitchenIds: send only to these kitchens. Leave it out to send to all.
async function issueInvoices({ mode, month, issuedBy = null, kitchenIds = null }) {
  const { now, period, cutoff, groups: allGroups } = await unbilled(mode, month);
  const only = Array.isArray(kitchenIds) ? new Set(kitchenIds.map(String)) : null;
  const groups = only ? allGroups.filter((g) => only.has(String(g._id))) : allGroups;

  const accounts = await getAccounts();
  const issued = [];
  const skipped = [];

  for (const g of groups) {
    if (g.commission <= 0) continue; // nothing owed - carry the orders forward

    const kitchen = await Kitchen.findById(g._id).select("name ownerId");
    if (!kitchen) continue;

    if (await Invoice.exists({ kitchenId: g._id, period })) {
      skipped.push({ kitchen: kitchen.name, reason: "Already billed for this month" });
      continue;
    }

    const invoice = await Invoice.create({
      number: `INV-${period.replace("-", "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      kitchenId: g._id,
      period,
      mode,
      orderCount: g.orders,
      foodTotal: g.food,
      commissionPercent: settings.commissionPercent,
      amount: g.commission,
      issuedAt: now,
      dueDate: new Date(now.getTime() + settings.billDueDays * 24 * 3600 * 1000),
      issuedBy,
      accounts,
    });

    await Order.updateMany(
      { kitchenId: g._id, status: "delivered", invoiceId: null, deliveredAt: { $lt: cutoff } },
      { invoiceId: invoice._id }
    );

    issued.push(invoice);
    tell(
      [kitchen.ownerId],
      {
        title: "🧾 Your bill is ready",
        body: `${invoice.number}: Rs ${invoice.amount} for ${period}. Pay in full and upload the receipt.`,
        data: { type: "invoice", invoiceId: invoice._id },
      },
      { kind: "invoice", invoiceId: String(invoice._id) }
    );
  }

  return { period, mode, issued, skipped };
}

/* -------------------------------------------------------------- scheduler */
// Checked every 30 minutes. It acts once per month per mode: the result is
// remembered, so a restart or a repeat check does nothing.
async function runSchedule() {
  const { mode } = (await getSetting("billingSchedule", { mode: "manual" })) || { mode: "manual" };
  if (mode === "manual") return;

  const now = pkt();
  const day = now.getUTCDate();
  const hour = now.getUTCHours();
  const thisMonth = monthOf();
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  let due = false;
  let tag = "";
  if (mode === "end_of_month" && day === lastDay && hour >= 20) {
    due = true;
    tag = `end:${thisMonth}`;
  }
  if (mode === "start_of_month" && day === 1 && hour >= 9) {
    due = true;
    tag = `start:${thisMonth}`;
  }
  if (!due) return;
  if ((await getSetting("billingLastAuto", "")) === tag) return;

  const result = await issueInvoices({ mode });
  await putSetting("billingLastAuto", tag);
  console.log(`[billing] automatic ${mode}: issued ${result.issued.length} bill(s) for ${result.period}`);
}

function startScheduler() {
  const tick = () => runSchedule().catch((e) => console.error("[billing]", e.message));
  setTimeout(tick, 30 * 1000);
  setInterval(tick, 30 * 60 * 1000);
}

module.exports = {
  issueInvoices,
  previewInvoices,
  startScheduler,
  getSetting,
  putSetting,
  getAccounts,
  monthOf,
};
