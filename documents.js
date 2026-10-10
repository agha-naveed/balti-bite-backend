// documents.js
// Where identity papers (CNIC front and back) are kept.
//
// These are NOT stored like dish photos. A dish photo gets a public web address
// anyone can open. A CNIC must never have one. So:
//
//   - Cloudinary: uploaded with type "authenticated" - the address does not work
//     without a signature, and only this server can make one.
//   - Otherwise: written to backend/private_uploads, a folder that is never
//     served as static files.
//
// Either way the database stores only a short reference ("cld:..." / "disk:...").
// The ONLY way to see the picture is GET /api/admin/documents, which checks the
// caller is an admin.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "private_uploads");
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const useCloudinary = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);
let cloudinary = null;
if (useCloudinary) {
  cloudinary = require("cloudinary").v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
const MIME = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

// file: a multer memory file. Returns the reference to store.
async function saveDocument(file) {
  if (useCloudinary) {
    const id = await new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          {
            folder: "cloud-kitchen-private",
            resource_type: "image",
            type: "authenticated",
            transformation: [{ width: 1800, height: 1800, crop: "limit", quality: "auto" }],
          },
          (err, r) => (err ? reject(err) : resolve(r.public_id))
        )
        .end(file.buffer);
    });
    return `cld:${id}`;
  }
  const name = crypto.randomBytes(20).toString("hex") + (EXT[file.mimetype] || ".jpg");
  fs.writeFileSync(path.join(DIR, name), file.buffer);
  return `disk:${name}`;
}

// Returns { url } (short-lived signed link) or { dataUrl } for the admin screen.
async function openDocument(ref) {
  const [kind, ...rest] = String(ref || "").split(":");
  const id = rest.join(":");
  if (!id) return null;

  if (kind === "cld" && cloudinary) {
    return {
      url: cloudinary.url(id, {
        type: "authenticated",
        sign_url: true,
        secure: true,
        resource_type: "image",
        expires_at: Math.floor(Date.now() / 1000) + 300, // five minutes
      }),
    };
  }
  if (kind === "disk") {
    // path.basename: a reference can never climb out of the folder.
    const file = path.join(DIR, path.basename(id));
    if (!fs.existsSync(file)) return null;
    const mime = MIME[path.extname(file)] || "image/jpeg";
    return { dataUrl: `data:${mime};base64,${fs.readFileSync(file).toString("base64")}` };
  }
  return null;
}

module.exports = { saveDocument, openDocument };
