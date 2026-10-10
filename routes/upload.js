// routes/upload.js
// Taking a photo and keeping it somewhere.
//
// Two places a picture can go, and the code picks whichever is set up:
//
//   Cloudinary   if the three CLOUDINARY_ keys are filled in. Use this once the
//                app is on a real server - a phone on mobile data cannot reach
//                a folder on your laptop.
//   this folder  otherwise. Files land in backend/uploads and are served from
//                there. Fine on your own machine and over your own Wi-Fi.
//
// Nothing in the rest of the app knows or cares which was used. Both give back
// the same thing: a web address, which is what gets saved on the dish.

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { auth, allow } = require("../helpers");

const router = express.Router();

// Where local files go, if Cloudinary is not set up.
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Is Cloudinary configured? Checked once at startup rather than per request.
const cloudinaryReady = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

let cloudinary = null;
if (cloudinaryReady) {
  cloudinary = require("cloudinary").v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log("Photos will be uploaded to Cloudinary.");
} else {
  console.log("Photos will be saved to backend/uploads (Cloudinary is not configured).");
}

// The file is held in memory, not written to disk first, because it may be
// going straight back out to Cloudinary and never touching this machine.
const upload = multer({
  storage: multer.memoryStorage(),
  // Photos are shrunk in the browser before they are sent, so they arrive well
  // under a megabyte. Video is not, and a short clip of a kitchen is easily
  // twenty. The limit covers both; the filter below decides what is allowed.
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const isImage = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype);
    const isVideo = /^video\/(mp4|webm|quicktime)$/.test(file.mimetype);
    if (!isImage && !isVideo)
      return cb(
        new Error("Upload a JPEG, PNG or WebP picture, or an MP4, WebM or MOV video.")
      );
    cb(null, true);
  },
});

// Sends the bytes to Cloudinary and hands back the address it gives us.
function toCloudinary(buffer, isVideo) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      isVideo
        ? { folder: "cloud-kitchen", resource_type: "video" }
        : {
            folder: "cloud-kitchen",
            resource_type: "image",
            // Cloudinary does its own resizing, so a picture is not stored many
            // times larger than any screen will ever show it.
            transformation: [{ width: 1200, height: 1200, crop: "limit", quality: "auto" }],
          },
      (err, result) => (err ? reject(err) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

// Writes the bytes into backend/uploads and builds the address to reach them.
function toDisk(req, file) {
  const ext = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
  }[file.mimetype];
  // A random name, so two people uploading "photo.jpg" do not overwrite each
  // other, and so nobody can guess what else is in the folder.
  const name = crypto.randomBytes(16).toString("hex") + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);

  // An absolute address, because the phone app is not served from this server
  // and a path like /uploads/x.jpg would point at the app itself.
  return `${req.protocol}://${req.get("host")}/uploads/${name}`;
}

/* ---------------------------------------------------------------- upload */
// Kitchens upload dish photos; admins may need to as well. Nobody else.
//
// Several files can arrive in one request, because a dish is allowed more than
// one picture and sending them one at a time is slower and easier to get wrong.
router.post("/", auth, allow("kitchen", "admin"), (req, res) => {
  upload.array("photo", 5)(req, res, async (err) => {
    // multer's own errors arrive here, not as a thrown exception.
    if (err) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return res.status(400).json({
        message: tooBig ? "That picture is too large. Try a smaller one." : err.message,
      });
    }
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ message: "No picture was sent." });

    try {
      const urls = [];
      for (const file of files) {
        const isVideo = file.mimetype.startsWith("video/");
        urls.push(
          cloudinaryReady ? await toCloudinary(file.buffer, isVideo) : toDisk(req, file)
        );
      }
      // `url` as well as `urls`, so a caller that only sent one file does not
      // have to reach into an array for it.
      res.status(201).json({
        url: urls[0],
        urls,
        storedOn: cloudinaryReady ? "cloudinary" : "server",
      });
    } catch (uploadError) {
      // Cloudinary rejects for reasons worth passing on rather than hiding
      // behind "something went wrong": a wrong key, a full account, a file it
      // will not accept.
      console.error("Upload failed:", uploadError);
      const detail = uploadError?.message || "";
      const looksLikeKeys = /api_key|cloud_name|signature|Invalid|401/i.test(detail);
      res.status(500).json({
        message: looksLikeKeys
          ? "Cloudinary rejected the upload. Check the three CLOUDINARY_ values in backend/.env, then restart the server."
          : `Could not save that picture. ${detail}`.trim(),
      });
    }
  });
});

/* ----------------------------------------------------------------- where */
// Lets the app show where photos are going, so nobody has to guess whether
// Cloudinary picked up the keys.
router.get("/where", auth, (req, res) => {
  res.json({ storedOn: cloudinaryReady ? "cloudinary" : "server" });
});

// Lets sign-up store a rider's photo with the same rules as every other picture.
router.storePublic = (req, file) =>
  cloudinaryReady ? toCloudinary(file.buffer, false) : toDisk(req, file);

module.exports = router;
