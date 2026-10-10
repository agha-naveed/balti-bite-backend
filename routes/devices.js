// routes/devices.js
// A phone tells the server "send my pushes to this token". Called after every
// sign-in, because FCM can change a token without telling anyone.

const express = require("express");
const { DeviceToken } = require("../models");
const { auth } = require("../helpers");
const { isOn, pushToUser } = require("../push");

const router = express.Router();

router.post("/", auth, async (req, res) => {
  const token = String(req.body.token || "").trim();
  if (!token) return res.status(400).json({ message: "No device token was sent." });

  // Upsert on the token: the same phone signing in as someone else moves to them.
  await DeviceToken.findOneAndUpdate(
    { token },
    { userId: req.user._id, platform: String(req.body.platform || "android"), lastSeenAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.json({ ok: true });
});

// Signing out must stop pushes meant for that person reaching this phone.
router.delete("/", auth, async (req, res) => {
  const token = String(req.body?.token || req.query.token || "").trim();
  if (token) await DeviceToken.deleteOne({ token, userId: req.user._id });
  res.json({ ok: true });
});

// "Why am I not getting notifications?" - answered with facts, not guesses.
//   firebaseOn  false -> the SERVER has no working Firebase key (fix on Railway)
//   devices     0     -> THIS PHONE never registered (permission / google-services)
router.get("/status", auth, async (req, res) => {
  res.json({
    firebaseOn: isOn(),
    devices: await DeviceToken.countDocuments({ userId: req.user._id }),
  });
});

// Sends a real push to the signed-in person's phones. Close the app and press it.
router.post("/test", auth, async (req, res) => {
  if (!isOn())
    return res.status(503).json({
      message: "The server has no working Firebase key, so it cannot send. Check FIREBASE_SERVICE_ACCOUNT_JSON on Railway.",
    });
  const devices = await DeviceToken.countDocuments({ userId: req.user._id });
  if (!devices)
    return res.status(409).json({
      message: "This phone has not registered for notifications yet. Allow notifications and reopen the app.",
    });
  const { sent } = await pushToUser(req.user._id, {
    title: "Test notification ✅",
    body: "If you can read this with the app closed, push is working.",
    data: { type: "test" },
  });
  res.json({ sent, devices });
});

module.exports = router;
