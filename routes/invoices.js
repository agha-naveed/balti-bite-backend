// routes/invoices.js
// Monthly bills from the platform to kitchen owners, and the receipts that
// close them.
//
//   admin issues the bill  ->  kitchen pays into an account and uploads the
//   receipt  ->  admin checks the money arrived  ->  bill is PAID.
//
// The whole amount is paid at once. There is no partial payment anywhere: a bill
// is either unpaid, waiting to be checked, or paid.

const express = require("express");
const { Invoice, Kitchen, Order } = require("../models");
const { auth, allow, settings } = require("../helpers");
const { issueInvoices, previewInvoices, getSetting, putSetting, getAccounts } = require("../billing");
const { tell } = require("../notifier");
const { pushToRole } = require("../push");
const { refresh } = require("../realtime");

const router = express.Router();
const onlyAdmin = [auth, allow("admin")];
const onlyKitchen = [auth, allow("kitchen")];

function view(inv) {
  const o = inv.toObject ? inv.toObject() : inv;
  return { ...o, overdue: o.status === "issued" && new Date(o.dueDate) < new Date() };
}

async function myKitchen(req) {
  return Kitchen.findOne({ ownerId: req.user._id });
}

/* -------------------------------------------------------- admin: settings */
router.get("/settings", ...onlyAdmin, async (req, res) => {
  const schedule = (await getSetting("billingSchedule", { mode: "manual" })) || { mode: "manual" };
  res.json({
    mode: schedule.mode,
    accounts: await getAccounts(),
    dueDays: settings.billDueDays,
    commissionPercent: settings.commissionPercent,
  });
});

router.put("/settings", ...onlyAdmin, async (req, res) => {
  if (req.body.mode !== undefined) {
    if (!["manual", "end_of_month", "start_of_month"].includes(req.body.mode))
      return res.status(400).json({ message: "Pick manual, end of month or start of month." });
    await putSetting("billingSchedule", { mode: req.body.mode });
  }
  if (req.body.accounts !== undefined) {
    const accounts = (Array.isArray(req.body.accounts) ? req.body.accounts : [])
      .map((a) => ({
        bank: String(a.bank || "").trim(),
        title: String(a.title || "").trim(),
        number: String(a.number || "").trim(),
        iban: String(a.iban || "").trim(),
      }))
      .filter((a) => a.bank && a.number);
    await putSetting("paymentAccounts", accounts);
  }
  res.json({ ok: true });
});

/* -------------------------------------------------------- admin: preview */
// Who would be billed, and how much - before anything is sent.
router.get("/preview", ...onlyAdmin, async (req, res) => {
  try {
    res.json(await previewInvoices({ mode: req.query.mode, month: req.query.month }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error(err);
    res.status(500).json({ message: "Could not work out the bills." });
  }
});

/* ---------------------------------------------------------- admin: issue */
// Body: { mode: "end_of_month" | "start_of_month", month?: "2026-09", kitchenIds?: [] }
router.post("/issue", ...onlyAdmin, async (req, res) => {
  try {
    const result = await issueInvoices({
      mode: req.body.mode,
      month: req.body.month,
      issuedBy: req.user._id,
      kitchenIds: req.body.kitchenIds, // one, some, or (left out) all
    });
    res.status(201).json({
      period: result.period,
      issued: result.issued.length,
      skipped: result.skipped,
      total: result.issued.reduce((s, i) => s + i.amount, 0),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error(err);
    res.status(500).json({ message: "Could not issue the bills. Try again." });
  }
});

/* ----------------------------------------------------------- admin: list */
router.get("/", ...onlyAdmin, async (req, res) => {
  const filter = {};
  if (["issued", "receipt_submitted", "paid"].includes(req.query.status)) filter.status = req.query.status;
  if (/^\d{4}-\d{2}$/.test(req.query.period || "")) filter.period = req.query.period;

  const rows = await Invoice.find(filter)
    .sort({ issuedAt: -1 })
    .limit(300)
    .populate("kitchenId", "name ownerName phone");

  const all = await Invoice.aggregate([
    { $group: { _id: "$status", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);
  const by = Object.fromEntries(all.map((r) => [r._id, r]));

  res.json({
    invoices: rows.map(view),
    summary: {
      unpaid: by.issued?.amount || 0,
      unpaidCount: by.issued?.count || 0,
      toVerify: by.receipt_submitted?.amount || 0,
      toVerifyCount: by.receipt_submitted?.count || 0,
      paid: by.paid?.amount || 0,
      paidCount: by.paid?.count || 0,
    },
  });
});

/* ---------------------------------------------------------- kitchen: mine */
router.get("/mine", ...onlyKitchen, async (req, res) => {
  const kitchen = await myKitchen(req);
  if (!kitchen) return res.status(404).json({ message: "No kitchen is linked to this account." });
  const rows = await Invoice.find({ kitchenId: kitchen._id }).sort({ issuedAt: -1 }).limit(60);
  res.json({
    invoices: rows.map(view),
    owing: rows.filter((r) => r.status !== "paid").reduce((s, r) => s + r.amount, 0),
  });
});

/* ------------------------------------------------------------- one bill */
async function loadFor(req, res) {
  const inv = await Invoice.findById(req.params.id).populate("kitchenId", "name ownerName phone ownerId");
  if (!inv) return res.status(404).json({ message: "Bill not found." }), null;
  if (req.user.role === "kitchen" && String(inv.kitchenId?.ownerId) !== String(req.user._id))
    return res.status(403).json({ message: "That bill is not yours." }), null;
  if (!["kitchen", "admin"].includes(req.user.role))
    return res.status(403).json({ message: "You do not have access to this." }), null;
  return inv;
}

router.get("/:id", auth, async (req, res) => {
  const inv = await loadFor(req, res);
  if (!inv) return;
  const orders = await Order.find({ invoiceId: inv._id })
    .sort({ deliveredAt: 1 })
    .select("code foodTotal commissionAmount deliveredAt");
  res.json({ invoice: view(inv), orders });
});

/* ---------------------------------------------------- kitchen: the receipt */
// Body: { imageUrl, reference?, paidTo?, note? } - the photo comes from
// /api/upload first. No amount is sent: the bill is paid in full or not at all.
router.post("/:id/receipt", ...onlyKitchen, async (req, res) => {
  const inv = await loadFor(req, res);
  if (!inv) return;

  if (inv.status === "paid") return res.status(400).json({ message: "This bill is already paid." });
  if (inv.status === "receipt_submitted")
    return res.status(400).json({ message: "A receipt is already waiting to be checked." });

  const imageUrl = String(req.body.imageUrl || "").trim();
  if (!imageUrl) return res.status(400).json({ message: "Attach a photo or screenshot of the receipt." });

  inv.receipt = {
    imageUrl,
    reference: String(req.body.reference || "").trim(),
    paidTo: String(req.body.paidTo || "").trim(),
    note: String(req.body.note || "").trim(),
    submittedAt: new Date(),
  };
  inv.status = "receipt_submitted";
  await inv.save();

  refresh([], { kind: "invoice", invoiceId: String(inv._id) }, { admin: true });
  pushToRole("admin", {
    title: "🧾 Receipt to check",
    body: `${inv.kitchenId.name} paid Rs ${inv.amount} (${inv.number}). Verify it.`,
    data: { type: "invoice", invoiceId: inv._id },
  });
  res.json(view(inv));
});

/* ------------------------------------------------- admin: check the money */
router.patch("/:id/verify", ...onlyAdmin, async (req, res) => {
  const inv = await loadFor(req, res);
  if (!inv) return;
  if (inv.status !== "receipt_submitted")
    return res.status(400).json({ message: "There is no receipt waiting to be checked." });

  inv.status = "paid";
  inv.paidAt = new Date();
  inv.verifiedBy = req.user._id;
  await inv.save();

  tell(
    [inv.kitchenId.ownerId],
    {
      title: "Payment received ✅",
      body: `${inv.number} (Rs ${inv.amount}) is marked paid. Thank you.`,
      data: { type: "invoice", invoiceId: inv._id },
    },
    { kind: "invoice", invoiceId: String(inv._id) },
    { admin: true }
  );
  res.json(view(inv));
});

router.patch("/:id/reject", ...onlyAdmin, async (req, res) => {
  const inv = await loadFor(req, res);
  if (!inv) return;
  if (inv.status !== "receipt_submitted")
    return res.status(400).json({ message: "There is no receipt waiting to be checked." });

  const reason = String(req.body.reason || "").trim();
  if (!reason) return res.status(400).json({ message: "Say why the receipt was not accepted." });

  inv.rejections.push({ reason, imageUrl: inv.receipt.imageUrl });
  inv.receipt = { imageUrl: "", reference: "", paidTo: "", note: "", submittedAt: null };
  inv.status = "issued"; // back to waiting for a payment
  await inv.save();

  tell(
    [inv.kitchenId.ownerId],
    {
      title: "Receipt not accepted",
      body: `${inv.number}: ${reason}. Please upload a correct receipt.`,
      data: { type: "invoice", invoiceId: inv._id },
    },
    { kind: "invoice", invoiceId: String(inv._id) },
    { admin: true }
  );
  res.json(view(inv));
});

module.exports = router;
