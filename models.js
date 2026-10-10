// models.js
// Every collection in the system, in one place, so the whole data model can be
// read top to bottom without opening six files.

const mongoose = require("mongoose");

// A reusable shape for a map point. MongoDB wants this exact GeoJSON format,
// with longitude FIRST, which trips everyone up once.
//
// It is a function, not a plain object, so each schema gets a fresh copy. It
// also has to be assigned directly: writing `location: { type: point(), index:
// "2dsphere" }` makes Mongoose read `index` as a field name, because the shape
// already has a `type` key of its own.
function point() {
  return {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: [0, 0] }, // [lng, lat]
  };
}

/* ------------------------------------------------------------------ user */
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    password: { type: String, required: true }, // hashed, never as typed
    role: {
      type: String,
      enum: ["customer", "kitchen", "rider", "admin"],
      required: true,
    },
    address: { type: String, default: "" },
    location: point(),

    // Which version of the terms this person agreed to, and when. Storing the
    // version rather than a plain true/false means that when the wording
    // changes, you can tell who has seen the new text.
    acceptedTermsVersion: { type: String, default: "" },
    acceptedTermsAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/* --------------------------------------------------------------- kitchen */
const kitchenSchema = new mongoose.Schema(
  {
    // unique, so one account can never own two kitchens
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    // unique, so two accounts can never register the same kitchen
    name: { type: String, required: true, trim: true, unique: true },
    ownerName: { type: String, required: true },
    phone: { type: String, required: true },
    cnic: { type: String, required: true },
    // References to the CNIC photos (front and back). Private: see documents.js.
    // Required at sign-up; not `required` here so older kitchens still save.
    cnicFrontRef: { type: String, default: "" },
    cnicBackRef: { type: String, default: "" },
    description: { type: String, default: "" },
    // A picture of the place or the food, shown on the public homepage. Stored
    // as a web address rather than an uploaded file, so there is no file server
    // to run yet. Blank is fine - the page draws a placeholder instead.
    imageUrl: { type: String, default: "" },
    // A short clip of the place, if the owner wants to add one. Optional, and
    // shown on the kitchen's own page rather than in the grid, because video in
    // a grid of forty dishes would be unusable on mobile data.
    videoUrl: { type: String, default: "" },

    // Kept as a running sum and a count rather than an average, so adding one
    // review is a single small write instead of re-reading every review.
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/* ---------------------------------------------------------------- branch */
const branchSchema = new mongoose.Schema(
  {
    kitchenId: { type: mongoose.Schema.Types.ObjectId, ref: "Kitchen", required: true },
    name: { type: String, required: true },
    address: { type: String, required: true },
    landmark: { type: String, default: "" },
    location: point(), // the pin dropped on the map during sign-up
    deliveryRadiusKm: { type: Number, default: 15 },
    deliveryMethod: {
      type: String,
      enum: ["delivery", "pickup", "both"],
      default: "both",
    },
    openTime: { type: String, default: "09:00" },
    closeTime: { type: String, default: "23:00" },
    isOpen: { type: Boolean, default: true },
  },
  { timestamps: true }
);
branchSchema.index({ location: "2dsphere" });

/* ----------------------------------------------------------------- rider */
const riderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    cnic: { type: String, required: true },
    // References to the CNIC photos (front and back). Private: see documents.js.
    cnicFrontRef: { type: String, default: "" },
    cnicBackRef: { type: String, default: "" },
    vehicle: { type: String, default: "bike" },
    // What they ride: required at sign-up so the customer and admin know what to
    // look for. (Not `required` here so riders from before this still save.)
    vehicleMake: { type: String, default: "" },  // "Honda CD 70"
    vehicleColor: { type: String, default: "" },
    // Both required at sign-up. A rider carrying somebody's food and somebody
    // else's cash is not an anonymous account.
    vehicleNumber: { type: String, required: true },
    licenseNumber: { type: String, required: true },
    // Required at sign-up: a photo of the RIDER (not the bike). Shown to the
    // customer whose food they are carrying, so the person at the door is
    // somebody they can recognise.
    imageUrl: { type: String, default: "" },
    location: point(), // updated every 5 seconds while a delivery is running
    // When `location` was last reported. Lets every screen say "updated 3s ago"
    // and warn when a rider's phone has gone quiet.
    locationAt: { type: Date, default: null },
    isOnline: { type: Boolean, default: false },

    // A rider is trusted with somebody's food and somebody else's cash, so an
    // admin reads the CNIC, the licence and the registration before they can
    // work at all. Until then the account exists and can sign in, and that is
    // all it can do.
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "suspended"],
      default: "pending",
    },
    decisionReason: { type: String, default: "" },
    decidedAt: { type: Date, default: null },
    // How many jobs this rider holds at once. A rider going the same way can
    // carry five; sending each one separately wastes the trip.
    maxJobs: { type: Number, default: 5 },

    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);
riderSchema.index({ location: "2dsphere" });

/* ------------------------------------------------------------- menu item */
// A dish a kitchen offers, with what goes into it.
//
// The ingredient list is the point of this collection. People with allergies
// and people with religious dietary requirements rely on it being right, which
// is why every dish is reviewed before customers can see it, and why editing an
// approved dish sends it back for review.
const menuItemSchema = new mongoose.Schema(
  {
    kitchenId: { type: mongoose.Schema.Types.ObjectId, ref: "Kitchen", required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    price: { type: Number, required: true, min: 1 },
    cookTimeMin: { type: Number, default: 20, min: 1 },
    // Several photos per dish. The first one is the cover, shown on cards; the
    // rest appear when somebody opens the dish. An empty list is fine - the
    // page draws a placeholder.
    images: [{ type: String }],

    ingredients: [
      {
        name: { type: String, required: true, trim: true },
        quantity: { type: String, default: "" }, // free text: "200 g", "2 tbsp"
        note: { type: String, default: "" },
      },
    ],
    status: {
      type: String,
      enum: ["pending", "approved", "declined"],
      default: "pending",
    },
    declineReason: { type: String, default: "" },
    reviewedAt: { type: Date, default: null },
    submissionCount: { type: Number, default: 1 },

    available: { type: Boolean, default: true },

    // A dish carries its own score as well as its kitchen's. When somebody
    // rates an order, every dish in that order gets the same score - which is
    // rough, but it is the only honest thing to do when the customer scored the
    // meal rather than each plate.
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);
menuItemSchema.index({ kitchenId: 1, name: 1 }, { unique: true });
// Customers search by dish name, so that field is worth an index of its own.
menuItemSchema.index({ name: 1 });

/* ----------------------------------------------------------------- order */
const orderSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true }, // short, readable aloud
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    kitchenId: { type: mongoose.Schema.Types.ObjectId, ref: "Kitchen", required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    items: [
      {
        menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem" },
        name: String,
        price: Number,
        qty: Number,
      },
    ],

    foodTotal: { type: Number, required: true },  // goes to the kitchen
    deliveryFee: { type: Number, default: 0 },    // the rider keeps this
    total: { type: Number, required: true },      // what the customer hands over
    cookTimeMin: { type: Number, default: 20 },

    address: { type: String, required: true },
    location: point(), // where the customer wants it
    customerPhone: { type: String, default: "" },
    note: { type: String, default: "" },

    status: {
      type: String,
      enum: [
        "placed",
        "accepted",
        "preparing",
        "ready",
        "rider_assigned",
        "picked_up",
        "on_the_way",
        "delivered",
        "rejected",
        "cancelled",
      ],
      default: "placed",
    },
    // Every state change is appended here, with who did it and when.
    timeline: [
      {
        status: String,
        at: { type: Date, default: Date.now },
        by: String, // customer / kitchen / rider / system
        note: String,
      },
    ],

    // Worked out once, when the order is delivered, and stored on the order.
    // Kept as a number rather than recalculated later, so a change to the rate
    // never rewrites history in the reports.
    commissionRate: { type: Number, default: 0 },   // percent
    commissionAmount: { type: Number, default: 0 }, // what the platform earns

    reviewed: { type: Boolean, default: false },

    // Distance by road from the kitchen to the customer, worked out when the
    // order is placed. `routeSource` says how: a hand-labelled road, the road
    // network, or an estimate when neither knew the way.
    routeKm: { type: Number, default: null },
    routeSource: { type: String, enum: ["manual", "osrm", "estimate", ""], default: "" },

    // Set once this order has been put on a kitchen's monthly bill, so no order
    // is ever billed twice and none is ever skipped.
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },

    otp: { type: String, default: "" }, // read out at the door
    rejectReason: { type: String, default: "" },
    cancelReason: { type: String, default: "" },
    deliveredAt: { type: Date, default: null },

    // While a job is offered to a rider and not yet accepted.
    offeredTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    offeredAt: { type: Date, default: null },
    // Riders who turned this job down or let the offer run out. The next offer
    // goes to somebody else, so one rider ignoring it cannot block the order.
    skippedRiders: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

orderSchema.index({ status: 1, invoiceId: 1, deliveredAt: 1 });

/* ---------------------------------------------------------------- review */
// One document per order, holding both scores.
//
// The food and the rider are scored separately on purpose. A cold curry is not
// the rider's fault, and a rider who took an hour did not cook anything. Rolling
// them into one number would blame the wrong person.
const reviewSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    customerName: { type: String, default: "" }, // copied, so the list needs no join
    kitchenId: { type: mongoose.Schema.Types.ObjectId, ref: "Kitchen", required: true },
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    foodRating: { type: Number, min: 1, max: 5, required: true },
    foodComment: { type: String, default: "" },
    riderRating: { type: Number, min: 1, max: 5, default: null },
    riderComment: { type: String, default: "" },

    // What was eaten, copied onto the review so a kitchen can see which dish a
    // complaint is actually about.
    dishes: [{ type: String }],
  },
  { timestamps: true }
);

/* ---------------------------------------------------------------- report */
// A complaint about a kitchen, raised by a customer and read by an admin.
//
// The reason is picked from a fixed list rather than typed. Free text alone is
// hard to count, and "this happened 6 times this month" is what actually makes
// an admin act.
const REPORT_REASONS = [
  "The ingredients were wrong or something was missing from the list",
  "The food arrived cold or in poor condition",
  "This is not what I ordered",
  "The food made me unwell",
  "The portion was much smaller than shown",
  "The photo does not match the food",
  "The kitchen was rude or unprofessional",
  "Something else",
];

const reportSchema = new mongoose.Schema(
  {
    kitchenId: { type: mongoose.Schema.Types.ObjectId, ref: "Kitchen", required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    customerName: { type: String, default: "" },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    orderCode: { type: String, default: "" },

    reason: { type: String, required: true },
    details: { type: String, default: "" },

    // "acted" means something was done about it - a dish taken down, the owner
    // called. "no_fault" means it was looked at and the kitchen did nothing
    // wrong. Both are closed; the difference matters when the same kitchen is
    // reported again and somebody needs to know whether this is a pattern.
    status: { type: String, enum: ["open", "acted", "no_fault"], default: "open" },
    adminNote: { type: String, default: "" },
    handledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/* ---------------------------------------------------------- device token */
// One row per phone that can receive a push. A person can be signed in on more
// than one phone, and a phone can change owner, so the TOKEN is the unique key.
const deviceTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, default: "android" },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

/* --------------------------------------------------------------- setting */
// Small key/value store for things an admin changes from the app: the billing
// schedule and the bank accounts printed on every bill.
const settingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed },
});

/* --------------------------------------------------------------- invoice */
// What a kitchen owes the platform for a month: the commission on every order
// it delivered. One bill, one amount, paid in full - there is deliberately no
// field for a part payment.
//
//   issued -> receipt_submitted -> paid
//                 |
//                 +-- admin rejects the receipt --> back to issued
const invoiceSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    kitchenId: { type: mongoose.Schema.Types.ObjectId, ref: "Kitchen", required: true, index: true },
    period: { type: String, required: true }, // "2026-09"
    mode: { type: String, enum: ["end_of_month", "start_of_month"], required: true },

    orderCount: { type: Number, default: 0 },
    foodTotal: { type: Number, default: 0 },
    commissionPercent: { type: Number, default: 0 },
    amount: { type: Number, required: true }, // the commission - what is owed

    issuedAt: { type: Date, default: Date.now },
    dueDate: { type: Date, required: true },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // null = automatic

    // Copied onto the bill when it is issued, so changing the accounts later
    // never rewrites an old bill.
    accounts: [{ bank: String, title: String, number: String, iban: String }],

    status: { type: String, enum: ["issued", "receipt_submitted", "paid"], default: "issued" },

    receipt: {
      imageUrl: { type: String, default: "" },
      reference: { type: String, default: "" }, // transaction / transfer id
      paidTo: { type: String, default: "" },    // which account they paid into
      note: { type: String, default: "" },
      submittedAt: { type: Date, default: null },
    },
    // Every receipt an admin turned down, kept so the history is not lost.
    rejections: [{ reason: String, at: { type: Date, default: Date.now }, imageUrl: String }],

    paidAt: { type: Date, default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);
// One bill per kitchen per month.
invoiceSchema.index({ kitchenId: 1, period: 1 }, { unique: true });

/* ----------------------------------------------------------------- place */
// A name on the map that OpenStreetMap does not have. Skardu's areas,
// roundabouts and shops are mostly missing there, so an admin adds them by
// hand and every screen can search them.
const PLACE_TYPES = [
  "area", "roundabout", "shop", "market", "landmark", "hotel",
  "hospital", "school", "mosque", "bridge", "other",
];
const placeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: PLACE_TYPES, default: "area" },
    aliases: [{ type: String, trim: true }], // other spellings people use
    notes: { type: String, default: "" },
    location: point(),
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);
placeSchema.index({ location: "2dsphere" });
placeSchema.index({ name: 1 });

/* -------------------------------------------------------- route override */
// A road the map does not know, traced by hand. The admin clicks along the
// real road; the length of that line is the distance. When an order's two
// ends are near the two ends of an override, this beats the routing server.
const routeOverrideSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    from: { lat: Number, lng: Number, label: String },
    to: { lat: Number, lng: Number, label: String },
    path: [{ lat: Number, lng: Number }],
    distanceKm: { type: Number, required: true },
    durationMin: { type: Number, default: null },
    twoWay: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

module.exports = {
  PLACE_TYPES,
  DeviceToken: mongoose.model("DeviceToken", deviceTokenSchema),
  Setting: mongoose.model("Setting", settingSchema),
  Invoice: mongoose.model("Invoice", invoiceSchema),
  Place: mongoose.model("Place", placeSchema),
  RouteOverride: mongoose.model("RouteOverride", routeOverrideSchema),
  REPORT_REASONS,
  Report: mongoose.model("Report", reportSchema),
  Review: mongoose.model("Review", reviewSchema),
  User: mongoose.model("User", userSchema),
  Kitchen: mongoose.model("Kitchen", kitchenSchema),
  Branch: mongoose.model("Branch", branchSchema),
  Rider: mongoose.model("Rider", riderSchema),
  MenuItem: mongoose.model("MenuItem", menuItemSchema),
  Order: mongoose.model("Order", orderSchema),
};
