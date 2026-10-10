// server.js
// Starts the API and connects to MongoDB.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const http = require("http");
const compression = require("compression");
const { attach } = require("./realtime");
const { init: initPush } = require("./push");
const { startScheduler } = require("./billing");

const app = express();

// Which origins may talk to this API.
//
// A browser sends the address the page was loaded from. The phone app is
// different: it is not served from a website, so it sends "https://localhost"
// (or "http://localhost" / "capacitor://localhost") whatever server it talks to.
//
// CLIENT_URL may hold several web addresses separated by commas. Nothing else
// is allowed - there is deliberately no wildcard and no "any address on the
// local network" rule.
const allowedOrigins = [
  ...(process.env.CLIENT_URL || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  "http://localhost",
  "https://localhost",
  "capacitor://localhost",
];

function originAllowed(origin, callback) {
  // No origin at all means a tool like Postman, or a same-machine request.
  if (!origin) return callback(null, true);
  if (allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error("Not allowed by CORS"));
}

app.use(cors({ origin: originAllowed, credentials: true }));
// gzip everything: menus, order lists and maps are mostly repeated text, which
// shrinks to a fraction on a slow mobile connection.
app.use(compression());
app.use(express.json());

// Photos saved on this machine, when Cloudinary is not configured. Served
// openly, because a picture of a plate of food is not a secret.
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Browsing needs no account, so these come first and carry no guard.
app.use("/api/public", require("./routes/public"));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/customer", require("./routes/customer"));
app.use("/api/kitchen", require("./routes/kitchen"));
app.use("/api/rider", require("./routes/rider"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/upload", require("./routes/upload"));
app.use("/api/map", require("./routes/map"));
app.use("/api/devices", require("./routes/devices"));
app.use("/api/invoices", require("./routes/invoices"));

app.get("/api/health", (req, res) =>
  res.json({ ok: true, time: new Date(), push: require("./push").isOn() })
);

// Anything else gets a readable answer instead of an HTML error page.
app.use((req, res) => res.status(404).json({ message: "That endpoint does not exist." }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Something broke on our side. Try again." });
});

const port = Number(process.env.PORT) || 5000;

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    // No host is given on purpose. Node then listens on every network
    // interface, which is what lets a phone reach this over Wi-Fi. Naming
    // "0.0.0.0" explicitly upsets Windows in some setups.
    // Admin-edited settings (fees, commission, contacts) come from the database.
    await require("./platform").loadPlatform();

    // Express and the websocket share one server and one port.
    const httpServer = http.createServer(app);
    attach(httpServer, originAllowed);
    initPush();
    startScheduler();
    require("./dispatch").startDispatcher();

    const server = httpServer.listen(port, () => {
      console.log(`API running on port ${port}`);
      console.log(`On this machine:  http://localhost:${port}/api/health`);
    });

    // If the port cannot be opened, say why in plain words.
    server.on("error", (err) => {
      if (err.code === "EACCES") {
        console.error(`\nPort ${port} is blocked by Windows.`);
        console.error("Windows reserves ranges of ports for Hyper-V and WSL. Check with:\n");
        console.error("  netsh interface ipv4 show excludedportrange protocol=tcp\n");
        console.error("If your port sits inside a listed range, set PORT=5050 in .env.\n");
      } else if (err.code === "EADDRINUSE") {
        console.error(`\nPort ${port} is already in use. Another copy is probably running.\n`);
      } else {
        console.error("Could not start the server:", err.message);
      }
      process.exit(1);
    });
  })
  .catch((err) => {
    console.error("Could not reach MongoDB:", err.message);
    process.exit(1);
  });
