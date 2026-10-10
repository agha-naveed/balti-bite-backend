// seed.js
// Run once with `npm run seed`. There is no public admin sign-up, so the admin
// account has to be created here.

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { User } = require("./models");
const { TERMS_VERSION } = require("./terms");

// Stored in the same shape the app normalizes everything else into, so the
// admin can sign in by typing either 03000000000 or +923000000000.
const PHONE = "123";
const PASSWORD = "admin123";

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  // Printed because seeding the wrong database is a common and confusing
  // mistake - it looks as though the admin was never created.
  console.log("Connected to database:", mongoose.connection.name);

  const existing = await User.findOne({ phone: PHONE });

  if (existing) {
    // Re-running resets the password rather than doing nothing, which saves a
    // lot of guessing if you ever lose it.
    existing.password = await bcrypt.hash(PASSWORD, 10);
    existing.role = "admin";
    await existing.save();
    console.log("Admin already existed - password has been reset.");
  } else {
    await User.create({
      name: "Platform admin",
      phone: PHONE,
      email: "admin@cloudkitchen.pk",
      password: await bcrypt.hash(PASSWORD, 10),
      role: "admin",
      acceptedTermsVersion: TERMS_VERSION,
      acceptedTermsAt: new Date(),
    });
    console.log("Admin created.");
  }

  console.log(`\n  phone:    ${PHONE}  (or type 03000000000)`);
  console.log(`  password: ${PASSWORD}\n`);
  console.log("Change that password before anyone else uses this.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
