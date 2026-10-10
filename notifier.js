// notifier.js
// One place that decides WHO hears about an order change and WHAT it says.
//
// Every route calls `orderChanged(order, event)` after saving. This then:
//   1. tells open screens to refresh (websocket), and
//   2. sends a push to the phones of whoever needs to act (FCM).
// It never throws and never makes a route wait: a failed notification must not
// turn a successful order into an error.

const { Kitchen, User, Rider } = require("./models");
const { pushToUsers } = require("./push");
const { refresh, forgetCarrying } = require("./realtime");

async function ownerOf(kitchenId) {
  const k = await Kitchen.findById(kitchenId).select("ownerId name");
  return k;
}

// event -> { who, title, body }. `who` picks from customer / kitchen / rider.
function messages(order, ctx) {
  const away = ctx.pickupKm ? ` Pickup is ${ctx.pickupKm} km from you by road.` : "";
  const code = order.code;
  const money = `Rs ${order.total}`;
  const riderName = ctx.riderName || "Your rider";

  return {
    placed: [
      { who: "kitchen", title: "🍽️ New order", body: `${code} · ${order.items.length} item(s) · ${money}. Tap to accept.` },
    ],
    accepted: [{ who: "customer", title: "Order accepted ✅", body: `${ctx.kitchenName} accepted ${code}.` }],
    rejected: [
      { who: "customer", title: "Order declined", body: `${ctx.kitchenName} could not take ${code}. ${order.rejectReason || ""}`.trim() },
    ],
    preparing: [{ who: "customer", title: "Cooking has started 👨‍🍳", body: `${ctx.kitchenName} is preparing ${code}.` }],
    ready: [{ who: "customer", title: "Food is ready", body: `${code} is packed. Finding a rider.` }],
    offered: [
      { who: "rider", title: "🛵 New delivery request", body: `${ctx.kitchenName} → ${order.address}.${away} Open the app to accept.` },
    ],
    rider_assigned: [
      { who: "customer", title: "Rider assigned", body: `${riderName} is heading to the kitchen for ${code}.` },
      { who: "kitchen", title: "Rider on the way", body: `${riderName} is coming to collect ${code}.` },
    ],
    on_the_way: [
      { who: "customer", title: "On the way 🛵", body: `${riderName} has your food. Keep your 4-digit code ready.` },
    ],
    delivered: [
      { who: "customer", title: "Delivered 🎉", body: `${code} has arrived. How was it? Tap to rate.` },
      { who: "kitchen", title: "Order delivered", body: `${code} was delivered.` },
    ],
    cancelled: [
      { who: "kitchen", title: "Order cancelled", body: `${code} was cancelled by the customer.` },
      { who: "rider", title: "Job cancelled", body: `${code} was cancelled. You do not need to deliver it.` },
    ],
    rider_passed: [
      { who: "kitchen", title: "Rider passed on a job", body: `${code} is waiting for another rider. Tap Ready again.` },
    ],
  };
}

async function orderChanged(order, event, extra = {}) {
  try {
    const kitchen = await ownerOf(order.kitchenId?._id || order.kitchenId);
    const riderId = order.riderId?._id || order.riderId || order.offeredTo;
    let riderName = "";
    if (order.riderId) {
      const r = await User.findById(order.riderId?._id || order.riderId).select("name");
      riderName = r?.name || "";
    }

    const people = {
      customer: String(order.customerId?._id || order.customerId),
      kitchen: kitchen?.ownerId && String(kitchen.ownerId),
      rider: riderId && String(riderId),
    };
    const ctx = { kitchenName: kitchen?.name || "The kitchen", riderName, ...extra };
    const list = messages(order, ctx)[event] || [];

    const detail = { kind: "order", orderId: String(order._id), status: order.status, event };

    // 1. Open screens, instantly. Everyone connected to this order refreshes -
    //    not just the people who get a notification - so a kitchen's board and
    //    the admin's live list stay in step.
    refresh(
      [people.customer, people.kitchen, people.rider, order.offeredTo],
      detail,
      { admin: true }
    );
    if (["rider_assigned", "delivered", "cancelled"].includes(event) && order.riderId)
      forgetCarrying(order.riderId?._id || order.riderId);

    // 2. Phones that are closed or locked.
    for (const m of list) {
      const target = people[m.who];
      if (!target) continue;
      pushToUsers([target], {
        title: m.title,
        body: m.body,
        tag: `order-${order._id}`,
        data: { type: "order", orderId: order._id, status: order.status, role: m.who },
      });
    }
  } catch (err) {
    console.error("[notifier]", err.message);
  }
}

// For things that are not an order: a bill, a receipt. Same two steps.
async function tell(userIds, payload, detail = { kind: "general" }, { admin = false } = {}) {
  try {
    refresh(userIds, detail, { admin });
    await pushToUsers(userIds, payload);
  } catch (err) {
    console.error("[notifier]", err.message);
  }
}

module.exports = { orderChanged, tell };
