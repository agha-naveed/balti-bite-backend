// routes/chat.js
// Live chat about an order.
//
//   customer <-> kitchen   from the moment the order is placed until a rider is
//                          assigned
//   customer <-> rider     from assignment until the food is delivered
//
// Every ORDER has its own chat, so a customer who orders from three kitchens
// has three. Which chat is open is decided by the order's status, not by the
// client: once the food is delivered (or the order is rejected or cancelled)
// nothing can be read or sent.
//
//   GET  /api/chat/threads        my open chats, with unread counts
//   GET  /api/chat/:orderId       the messages of this order's current chat
//   POST /api/chat/:orderId       send one  { text }
//   POST /api/chat/:orderId/read  mark what I am looking at as read

const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const { Order, Kitchen, User, Message } = require("../models");
const { auth } = require("../helpers");
const { emitToUsers } = require("../realtime");
const { pushToUser } = require("../push");

const router = express.Router();

const KITCHEN_OPEN = ["placed", "accepted", "preparing", "ready"];
const RIDER_OPEN = ["rider_assigned", "picked_up", "on_the_way"];
const channelOf = (status) =>
  KITCHEN_OPEN.includes(status) ? "kitchen" : RIDER_OPEN.includes(status) ? "rider" : null;

const sendLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => String(req.user?._id || "anon"),
  validate: false,
  message: { message: "You are sending messages too fast. Wait a moment." },
});

// Works out whether THIS person may use THIS order's chat right now, and who
// is on the other end. Returns { error: {status, message} } or { order, channel, other, others }.
async function threadFor(orderId, user) {
  if (!mongoose.isValidObjectId(orderId)) return { error: { status: 404, message: "Order not found." } };
  const order = await Order.findById(orderId).select("code status customerId kitchenId riderId");
  if (!order) return { error: { status: 404, message: "Order not found." } };

  const kitchen = await Kitchen.findById(order.kitchenId).select("name ownerId");
  const isCustomer = String(order.customerId) === String(user._id);
  const isKitchen = user.role === "kitchen" && kitchen && String(kitchen.ownerId) === String(user._id);
  const isRider = user.role === "rider" && order.riderId && String(order.riderId) === String(user._id);
  if (!isCustomer && !isKitchen && !isRider)
    return { error: { status: 403, message: "This is not your order." } };

  const channel = channelOf(order.status);
  if (!channel) return { error: { status: 410, message: "This chat has closed." } };
  if (channel === "kitchen" && isRider) return { error: { status: 410, message: "This chat has closed." } };
  if (channel === "rider" && isKitchen)
    return { error: { status: 410, message: "A rider has taken this order, so this chat has closed." } };

  // Who is on the other end.
  let other;
  if (isCustomer) {
    if (channel === "kitchen") other = { id: kitchen.ownerId, name: kitchen.name, role: "kitchen" };
    else {
      const rider = await User.findById(order.riderId).select("name");
      other = { id: order.riderId, name: rider?.name || "Your rider", role: "rider" };
    }
  } else {
    const customer = await User.findById(order.customerId).select("name");
    other = { id: order.customerId, name: customer?.name || "Customer", role: "customer" };
  }
  return { order, channel, other };
}

const asMessage = (m) => ({
  _id: String(m._id),
  senderId: String(m.senderId),
  senderRole: m.senderRole,
  text: m.text,
  at: m.createdAt,
});

/* ------------------------------------------------------------ my chats */
router.get("/threads", auth, async (req, res) => {
  try {
    let orders = [];
    if (req.user.role === "customer") {
      orders = await Order.find({ customerId: req.user._id, status: { $in: [...KITCHEN_OPEN, ...RIDER_OPEN] } })
        .select("status").limit(100);
    } else if (req.user.role === "kitchen") {
      const kitchen = await Kitchen.findOne({ ownerId: req.user._id }).select("_id");
      if (kitchen)
        orders = await Order.find({ kitchenId: kitchen._id, status: { $in: KITCHEN_OPEN } }).select("status").limit(100);
    } else if (req.user.role === "rider") {
      orders = await Order.find({ riderId: req.user._id, status: { $in: RIDER_OPEN } }).select("status").limit(100);
    }
    if (orders.length === 0) return res.json([]);

    const pairs = orders.map((o) => ({ orderId: o._id, channel: channelOf(o.status) }));
    const counts = await Message.aggregate([
      { $match: { $or: pairs, senderId: { $ne: req.user._id }, readAt: null } },
      { $group: { _id: { o: "$orderId", c: "$channel" }, n: { $sum: 1 } } },
    ]);
    const unread = new Map(counts.map((c) => [`${c._id.o}:${c._id.c}`, c.n]));
    res.json(
      pairs.map((p) => ({
        orderId: String(p.orderId),
        channel: p.channel,
        unread: unread.get(`${p.orderId}:${p.channel}`) || 0,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load your chats." });
  }
});

/* ------------------------------------------------------- one chat's log */
router.get("/:orderId", auth, async (req, res) => {
  try {
    const t = await threadFor(req.params.orderId, req.user);
    if (t.error) return res.status(t.error.status).json({ message: t.error.message });

    const rows = await Message.find({ orderId: t.order._id, channel: t.channel })
      .sort({ createdAt: 1 })
      .limit(200);
    await Message.updateMany(
      { orderId: t.order._id, channel: t.channel, senderId: { $ne: req.user._id }, readAt: null },
      { readAt: new Date() }
    );
    res.json({
      orderId: String(t.order._id),
      orderCode: t.order.code,
      channel: t.channel,
      with: { name: t.other.name, role: t.other.role },
      messages: rows.map(asMessage),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not open the chat." });
  }
});

/* ------------------------------------------------------------- send one */
router.post("/:orderId", auth, sendLimit, async (req, res) => {
  try {
    const text = String(req.body?.text || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
    if (!text) return res.status(400).json({ message: "Write a message first." });
    if (text.length > 500) return res.status(400).json({ message: "Keep it under 500 characters." });

    const t = await threadFor(req.params.orderId, req.user);
    if (t.error) return res.status(t.error.status).json({ message: t.error.message });

    const row = await Message.create({
      orderId: t.order._id,
      channel: t.channel,
      senderId: req.user._id,
      senderRole: req.user.role,
      text,
    });
    const message = asMessage(row);

    // Both people's open screens get it at once (the sender's other phones too).
    emitToUsers([req.user._id, t.other.id], "chat:message", {
      orderId: String(t.order._id),
      channel: t.channel,
      from: { name: req.user.name, role: req.user.role },
      message,
    });

    // And a push, for the person who has the app closed. Tapping it opens the order.
    pushToUser(t.other.id, {
      title: `${req.user.name} · order ${t.order.code}`,
      body: text.length > 120 ? `${text.slice(0, 117)}…` : text,
      data: { type: "order", orderId: String(t.order._id), chat: "1" },
      tag: `chat-${t.order._id}`,
    }).catch(() => {});

    res.status(201).json(message);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not send the message." });
  }
});

/* ----------------------------------------------------------- mark as read */
router.post("/:orderId/read", auth, async (req, res) => {
  try {
    const t = await threadFor(req.params.orderId, req.user);
    if (t.error) return res.status(t.error.status).json({ message: t.error.message });
    await Message.updateMany(
      { orderId: t.order._id, channel: t.channel, senderId: { $ne: req.user._id }, readAt: null },
      { readAt: new Date() }
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ message: "Could not update the chat." });
  }
});

module.exports = router;
