// push.js
// Sends a push notification through Firebase Cloud Messaging (FCM).
//
// This is what reaches a phone whose app is closed or whose screen is off. The
// message goes from this server to Google, and Google wakes the phone - nothing
// on the phone has to be running.
//
// Set ONE of these in .env:
//   FIREBASE_SERVICE_ACCOUNT=./firebase-service-account.json   (path to the file)
//   FIREBASE_SERVICE_ACCOUNT_JSON={...}  or  a base64 string of that JSON
//     (use this on hosts like Render/Railway where you cannot upload a file)
//
// Without either, every function here quietly does nothing and the server logs
// one warning, so the rest of the app still works while Firebase is being set up.

const fs = require("fs");
const path = require("path");
const { DeviceToken } = require("./models");

let messaging = null;
let tried = false;

function loadCredentials() {
  const file = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (file) return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(text);
}

function init() {
  if (tried) return messaging;
  tried = true;
  try {
    const creds = loadCredentials();
    if (!creds) {
      console.warn("[push] Firebase is not configured - push notifications are OFF.");
      return null;
    }
    // The modular imports work on every recent firebase-admin. The old
    // "admin.credential.cert(...)" style was removed in newer versions, which is
    // what caused "Cannot read properties of undefined (reading 'cert')".
    const { initializeApp, cert, getApps } = require("firebase-admin/app");
    const { getMessaging } = require("firebase-admin/messaging");
    const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(creds) });
    messaging = getMessaging(app);
    console.log("[push] Firebase ready - push notifications are ON.");
  } catch (err) {
    console.error("[push] Could not start Firebase:", err.message);
  }
  return messaging;
}

const DEAD = [
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
];

// Sends one message to every phone a user is signed in on.
//   data values must be strings - FCM rejects anything else.
async function pushToUser(userId, { title, body, data = {}, tag }) {
  const fcm = init();
  if (!fcm || !userId) return { sent: 0 };

  const devices = await DeviceToken.find({ userId }).select("token");
  if (devices.length === 0) return { sent: 0 };

  const strings = {};
  for (const [k, v] of Object.entries(data)) strings[k] = String(v ?? "");

  const message = {
    tokens: devices.map((d) => d.token),
    notification: { title, body },
    data: strings,
    android: {
      // "high" is what wakes a phone that is dozing. Without it Android may hold
      // the message for minutes, which is exactly the delay we are removing.
      priority: "high",
      ttl: 60 * 60 * 1000, // an order alert older than an hour is no use
      notification: {
        channelId: "orders",
        sound: "default",
        ...(tag ? { tag } : {}), // same tag replaces the earlier one
        defaultVibrateTimings: true,
      },
    },
  };

  try {
    const res = await fcm.sendEachForMulticast(message);
    // Phones that uninstalled the app leave dead tokens behind. Clean them up.
    const dead = [];
    res.responses.forEach((r, i) => {
      if (!r.success && DEAD.includes(r.error?.code)) dead.push(message.tokens[i]);
    });
    if (dead.length) await DeviceToken.deleteMany({ token: { $in: dead } });
    return { sent: res.successCount };
  } catch (err) {
    console.error("[push] send failed:", err.message);
    return { sent: 0 };
  }
}

async function pushToUsers(userIds, payload) {
  const unique = [...new Set(userIds.filter(Boolean).map(String))];
  await Promise.all(unique.map((id) => pushToUser(id, payload)));
}

async function pushToRole(role, payload) {
  const { User } = require("./models");
  const people = await User.find({ role }).select("_id");
  await pushToUsers(people.map((p) => p._id), payload);
}

const isOn = () => Boolean(init());

module.exports = { init, isOn, pushToUser, pushToUsers, pushToRole };
