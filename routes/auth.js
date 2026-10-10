// routes/auth.js
// The terms text, creating an account for any role, signing in, and reading
// back the full profile that was saved.

const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { User, Kitchen, Branch, Rider } = require("../models");
const {
  signToken,
  auth,
  normalizePhone,
  looksLikePhone,
  normalizeCnic,
} = require("../helpers");
const multer = require("multer");
const { buildTerms } = require("../terms");
const { saveDocument } = require("../documents");
const uploadRoute = require("./upload");

const router = express.Router();

// Slows down anyone trying thousands of passwords against the login form.
const loginLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: { message: "Too many attempts. Try again in a few minutes." },
});

/* ----------------------------------------------------------------- terms */
router.get("/terms", (req, res) => res.json(buildTerms()));

/* ---------------------------------------------------------------- signup */
// Customers sign up with plain JSON. Riders and kitchens send a form with files:
// the CNIC (front and back) and, for riders, their own photo. They arrive IN the
// registration request, so an account can never exist without its papers.
const papers = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) =>
    /^image\/(jpeg|png|webp)$/.test(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Upload JPEG, PNG or WebP pictures only.")),
}).fields([
  { name: "cnicFront", maxCount: 1 },
  { name: "cnicBack", maxCount: 1 },
  { name: "riderPhoto", maxCount: 1 },
]);

function readForm(req, res, next) {
  if (!req.is("multipart/form-data")) return next();
  papers(req, res, (err) => {
    if (err)
      return res.status(400).json({
        message: err.code === "LIMIT_FILE_SIZE" ? "A picture is too large. Use one under 8 MB." : err.message,
      });
    // Form fields are all text; the code below expects real booleans.
    if (req.body.acceptTerms === "true") req.body.acceptTerms = true;
    next();
  });
}

router.post("/register", readForm, async (req, res) => {
  let createdUser = null;
  const files = req.files || {};

  try {
    const {
      role,
      name,
      phone,
      email,
      password,
      acceptTerms,
      termsVersion,
      address,
      lat,
      lng,
      kitchenName,
      description,
      imageUrl,
      cnic,
      branchName,
      branchAddress,
      landmark,
      branchLat,
      branchLng,
      deliveryRadiusKm,
      deliveryMethod,
      openTime,
      closeTime,
      vehicle,
      vehicleNumber,
      licenseNumber,
      vehicleMake,
      vehicleColor,
    } = req.body;

    if (!["customer", "kitchen", "rider"].includes(role))
      return res.status(400).json({ message: "Choose customer, kitchen or rider." });
    if (!name || !phone || !password)
      return res.status(400).json({ message: "Name, phone and password are required." });
    if (String(password).length < 6)
      return res.status(400).json({ message: "Use a password of at least 6 characters." });

    // Checked here as well as in the app. A checkbox in a browser proves
    // nothing on its own - anyone can send a request without it.
    if (acceptTerms !== true)
      return res
        .status(400)
        .json({ message: "You need to accept the terms and conditions to create an account." });

    if (role === "kitchen") {
      if (!kitchenName) return res.status(400).json({ message: "Your kitchen needs a name." });
      if (!cnic) return res.status(400).json({ message: "CNIC is required to run a kitchen." });
      if (!normalizeCnic(cnic))
        return res.status(400).json({ message: "A CNIC is 13 digits, like 71501-1234567-1." });
      if (!files.cnicFront?.[0] || !files.cnicBack?.[0])
        return res
          .status(400)
          .json({ message: "Upload a photo of the front AND the back of your CNIC." });
      if (!branchAddress)
        return res.status(400).json({ message: "Add the address of your kitchen." });
      if (branchLat === undefined || branchLat === null || branchLng === undefined)
        return res.status(400).json({ message: "Place your kitchen on the map before continuing." });

      // One kitchen, one account. Checked before anything is written, so the
      // person gets a clear answer instead of a duplicate-key error.
      const nameTaken = await Kitchen.findOne({
        name: { $regex: `^${String(kitchenName).trim()}$`, $options: "i" },
      });
      if (nameTaken)
        return res.status(409).json({
          message:
            "A kitchen with that name is already registered. Each kitchen may only have one account.",
        });
    }

    if (role === "rider") {
      if (!cnic) return res.status(400).json({ message: "CNIC is required to ride." });
      if (!normalizeCnic(cnic))
        return res.status(400).json({ message: "A CNIC is 13 digits, like 71501-1234567-1." });
      // Not optional. A rider is trusted with somebody's food and somebody
      // else's cash, so the vehicle and the licence are both on record.
      if (!vehicleNumber || !String(vehicleNumber).trim())
        return res.status(400).json({ message: "Add your vehicle registration number." });
      if (!licenseNumber || !String(licenseNumber).trim())
        return res.status(400).json({ message: "Add your licence number." });
      if (!vehicleMake || !String(vehicleMake).trim())
        return res.status(400).json({ message: "Add your bike's make and model, like Honda CD 70." });
      if (!vehicleColor || !String(vehicleColor).trim())
        return res.status(400).json({ message: "Add your bike's colour." });
      if (!files.cnicFront?.[0] || !files.cnicBack?.[0])
        return res
          .status(400)
          .json({ message: "Upload a photo of the front AND the back of your CNIC." });
      if (!files.riderPhoto?.[0])
        return res.status(400).json({ message: "Add a clear photo of yourself." });
    }

    // Put into one shape, so the same person cannot end up with two accounts by
    // writing their number differently on different days.
    const cleanPhone = normalizePhone(phone);
    if (!looksLikePhone(cleanPhone))
      return res.status(400).json({ message: "That does not look like a phone number." });
    const taken = await User.findOne({ phone: cleanPhone });
    if (taken)
      return res.status(409).json({ message: "That phone number is already registered." });

    // Papers are stored first: if that fails nothing has been created, so the
    // person simply retries instead of being left with a half-made account.
    let cnicFrontRef = "";
    let cnicBackRef = "";
    let riderPhotoUrl = "";
    if (role === "kitchen" || role === "rider") {
      cnicFrontRef = await saveDocument(files.cnicFront[0]);
      cnicBackRef = await saveDocument(files.cnicBack[0]);
    }
    if (role === "rider") riderPhotoUrl = await uploadRoute.storePublic(req, files.riderPhoto[0]);

    createdUser = await User.create({
      name: String(name).trim(),
      phone: cleanPhone,
      email: email ? String(email).trim() : "",
      password: await bcrypt.hash(password, 10),
      role,
      address: address ? String(address).trim() : "",
      location:
        lat !== undefined && lat !== null
          ? { type: "Point", coordinates: [Number(lng), Number(lat)] }
          : undefined,
      acceptedTermsVersion: termsVersion || buildTerms().version,
      acceptedTermsAt: new Date(),
    });

    if (role === "kitchen") {
      const kitchen = await Kitchen.create({
        ownerId: createdUser._id,
        name: String(kitchenName).trim(),
        ownerName: String(name).trim(),
        phone: cleanPhone,
        cnic: normalizeCnic(cnic),
        cnicFrontRef,
        cnicBackRef,
        description: description || "",
        imageUrl: String(imageUrl || "").trim(),
      });

      await Branch.create({
        kitchenId: kitchen._id,
        name: branchName || "Main branch",
        address: String(branchAddress).trim(),
        landmark: landmark || "",
        location: { type: "Point", coordinates: [Number(branchLng), Number(branchLat)] },
        deliveryRadiusKm: Number(deliveryRadiusKm) || 15,
        deliveryMethod: deliveryMethod || "both",
        openTime: openTime || "09:00",
        closeTime: closeTime || "23:00",
      });
    }

    if (role === "rider") {
      // Created waiting. An admin reads the CNIC, the licence and the
      // registration before this person can take a single job.
      await Rider.create({
        userId: createdUser._id,
        cnic: normalizeCnic(cnic),
        cnicFrontRef,
        cnicBackRef,
        vehicle: vehicle || "bike",
        vehicleMake: String(vehicleMake).trim(),
        vehicleColor: String(vehicleColor).trim(),
        vehicleNumber: String(vehicleNumber).trim().toUpperCase(),
        licenseNumber: String(licenseNumber).trim().toUpperCase(),
        imageUrl: riderPhotoUrl,
        location:
          lat !== undefined && lat !== null
            ? { type: "Point", coordinates: [Number(lng), Number(lat)] }
            : undefined,
      });
    }

    res.status(201).json({
      token: signToken(createdUser),
      user: {
        id: createdUser._id,
        name: createdUser.name,
        phone: createdUser.phone,
        role: createdUser.role,
      },
    });
  } catch (err) {
    console.error(err);
    // If a later record failed after the account was made, remove the account
    // too. Otherwise the phone number is held by a half-finished registration
    // that can never be completed or retried.
    if (createdUser) {
      await User.findByIdAndDelete(createdUser._id).catch(() => {});
      await Kitchen.deleteMany({ ownerId: createdUser._id }).catch(() => {});
      await Rider.deleteMany({ userId: createdUser._id }).catch(() => {});
    }
    res.status(500).json({ message: "Could not create the account. Try again." });
  }
});

/* ----------------------------------------------------------------- login */
router.post("/login", loginLimit, async (req, res) => {
  try {
    const { phone, password } = req.body;

    // Normalized the same way as at sign-up. Without this, somebody who
    // registered with 0300… and signs in with +92 300… would be told their
    // password is wrong.
    const user = await User.findOne({ phone: normalizePhone(phone) });
    // The same message either way, so this form cannot be used to work out
    // which phone numbers are registered.
    if (!user) return res.status(401).json({ message: "Wrong phone number or password." });

    const ok = await bcrypt.compare(password || "", user.password);
    if (!ok) return res.status(401).json({ message: "Wrong phone number or password." });

    res.json({
      token: signToken(user),
      user: { id: user._id, name: user.name, phone: user.phone, role: user.role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not sign in. Try again." });
  }
});

/* -------------------------------------------------------------- who am I */
router.get("/me", auth, async (req, res) => {
  const profile = {
    id: req.user._id,
    name: req.user.name,
    phone: req.user.phone,
    email: req.user.email,
    role: req.user.role,
    address: req.user.address,
    acceptedTermsVersion: req.user.acceptedTermsVersion,
    acceptedTermsAt: req.user.acceptedTermsAt,
    joined: req.user.createdAt,
  };

  if (req.user.role === "kitchen") {
    const kitchen = await Kitchen.findOne({ ownerId: req.user._id });
    profile.kitchen = kitchen;
    profile.branches = kitchen ? await Branch.find({ kitchenId: kitchen._id }) : [];
  }

  if (req.user.role === "rider") {
    profile.rider = await Rider.findOne({ userId: req.user._id });
  }

  res.json(profile);
});

module.exports = router;
