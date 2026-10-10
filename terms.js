// terms.js
// The terms people agree to when they create an account.
//
// This lives on the backend and is served to the app, so there is only one copy.
// If the frontend had its own, the two would drift apart and you would not know
// which version somebody actually agreed to.
//
// Bump `version` whenever the wording changes in a way that matters. What each
// person accepted is stored on their account.
//
// NOTE: this is a sensible working draft, not legal advice. Before launch, have
// a lawyer in Pakistan read it - especially the sections on liability, fees and
// personal data - and replace COMPANY_NAME and the contact details.

const { settings } = require("./helpers");

// The company name and contact details are edited by the admin in the app, so
// the terms are built fresh each time they are asked for.
function buildTerms() {
  const c = settings.contacts || {};
  const COMPANY = c.companyName || process.env.COMPANY_NAME || "the Company";
  const bits = [c.supportPhone, c.whatsapp && `WhatsApp ${c.whatsapp}`, c.supportEmail].filter(Boolean);
  const CONTACT = bits.length ? bits.join(" · ") : "the support number shown in the app";
  const FEE = settings.delivery || {};

  return {
  version: "1.2",
  updated: "2026-10-07",
  sections: [
    {
      heading: "1. What this service is",
      body:
        `Cloud Kitchen, run by ${COMPANY}, is a platform that connects customers with home and commercial kitchens in the Skardu region, and with riders who deliver the food. We do not cook the food and we do not deliver it ourselves. Kitchens and riders are independent. They are not our employees, partners or agents, and nothing here creates an employment relationship.`,
    },
    {
      heading: "2. Who may use it",
      body:
        "You must be at least 18 years old and legally able to enter an agreement. Kitchens and riders must be 18 or over and hold a Computerised National Identity Card (CNIC). By creating an account you confirm that everything you tell us is true and that you will keep it up to date.",
    },
    {
      heading: "3. Your account",
      body:
        "Give your real name and a working phone number. That number identifies your account. One person may hold one account, and one kitchen may hold one account. Keep your password private: you are responsible for everything done under your account. Tell us at once if you think someone else has used it.",
    },
    {
      heading: "4. Identity checks and your CNIC",
      body:
        "Kitchens and riders must upload clear photos of the front and back of their own CNIC when they register, and riders must also upload a clear photo of themselves. Documents that belong to someone else, are altered, expired or unreadable will be refused and may lead to a permanent ban. We check these documents before an account can take orders or deliveries, and we may ask for them again at any time. Your CNIC photos are stored privately, are visible only to authorised administrators, are never shown to customers, and are used only to verify who you are and to meet legal obligations. We may share them with the authorities if the law requires it. We keep them while your account is active and for a reasonable period afterwards for fraud and dispute handling.",
    },
    {
      heading: "5. If you run a kitchen",
      body:
        "You are responsible for the safety, hygiene and quality of the food you cook, for storing and handling it properly, and for holding whatever licences, registrations and permissions the law requires. You must keep prices, opening hours and delivery areas accurate, prepare orders within the time you state, and package food so it arrives safe and sound. You must not use the platform to sell anything unlawful, expired, or unfit to eat. We may remove a dish or a kitchen that gets repeated complaints.",
    },
    {
      heading: "6. Listing what is in your food",
      body:
        "Every dish must list all its ingredients, accurately. People with allergies and people with religious dietary needs rely on this. Listing an ingredient you do not use, or leaving one out, is serious: the dish will be removed and the account may be suspended. Every dish is reviewed before customers can see it, and any edit sends it back for review.",
    },
    {
      heading: "7. If you deliver",
      body:
        "You must hold a valid driving licence for what you ride, keep your bike or vehicle legal and roadworthy, and give us its true make, colour and registration number. You must obey traffic laws, wear a helmet, and never ride unsafely to save time. Once you accept a delivery it is yours to finish; do not leave food unattended, open or tamper with it, or hand it to anyone but the customer. Confirm delivery only with the customer's four-digit code. You use your own vehicle, fuel and phone at your own cost and risk, and you are responsible for your own safety, fines and insurance. Delivery fees are yours to keep. Cash you collect for a kitchen belongs to that kitchen and must be handed over promptly when your shift ends. Keeping or losing that money is theft and will be treated as such.",
    },
    {
      heading: "8. Ordering and paying (customers)",
      body:
        `Orders are paid in cash on delivery. The delivery fee depends on the distance by road from the kitchen to you: it is ${FEE.baseFee} rupees for the first ${FEE.baseKm} km and ${FEE.perExtraKm} rupees for each further km${FEE.maxFee ? `, up to ${FEE.maxFee} rupees` : ""}. The food price and delivery fee shown at checkout, before you confirm, are what you pay. Give the rider your four-digit code only when you have your food. Be reachable at the address and phone number you gave. If an order cannot be delivered because you are unreachable or refuse it without good reason, we may restrict your account. You may cancel before the kitchen starts cooking. After that the food has been made, so it cannot be cancelled. If your food does not arrive, or is not what you ordered, tell us promptly through the app so we can look into it.`,
    },
    {
      heading: "9. Fees, monthly bills and payment",
      body:
        "Kitchens pay us a commission on each delivered order, shown in the app. We total it and send each kitchen one bill for the month, either at the end of that month or at the start of the next. The bill shows the amount, the due date and the bank accounts to pay into. A bill must be paid in full in a single payment; part payments are not accepted. After paying, upload a clear photo of the receipt in the app. We check that the money has arrived, and only then is the bill marked paid. A receipt we cannot match to a payment will be sent back. Unpaid or overdue bills may lead to your kitchen being hidden from customers or suspended until they are cleared. Do not send money to any account that is not shown on your bill in the app.",
    },
    {
      heading: "10. Conduct that is not allowed",
      body:
        "Do not give false information, create fake or duplicate accounts, post fake reviews, harass or threaten anyone, discriminate against customers, kitchens or riders, try to take orders outside the platform to avoid fees, interfere with how the service works, or use it for anything illegal. Do not share or sell another person's personal details.",
    },
    {
      heading: "11. Location, notifications and your information",
      body:
        "We collect what you give us at sign-up (name, phone number, address, and for kitchens and riders their CNIC and documents) and what the service needs to run, such as orders and ratings. A kitchen's name and address are shown to customers. While a delivery is in progress, the rider's live location is shared with that order's customer, the kitchen and our administrators, and only until the order is finished. By using the app you agree to receive notifications about orders, deliveries and bills; you can switch them off on your phone, but alerts may then arrive late or not at all. We do not sell your personal information. We share it only with people who need it to complete your order, with service providers who help us run the platform, and with the authorities when the law requires.",
    },
    {
      heading: "12. Ratings and complaints",
      body:
        "Customers can rate food and delivery. Ratings must be honest and fair. We may remove reviews that are abusive or false. We will look into complaints and may refund, warn, suspend or remove a kitchen, rider or customer based on what we find. Our decision on a complaint is final within the platform.",
    },
    {
      heading: "13. Suspending or ending an account",
      body:
        "You may close your account at any time, once any money you owe us or hold for someone else has been settled. We may suspend or close an account that breaks these terms, is the subject of serious or repeated complaints, or presents a risk to others, and in serious cases such as false ingredients, forged documents, fraud or theft we will do so without notice.",
    },
    {
      heading: "14. What we are not responsible for",
      body:
        "We provide the platform as it is and try to keep it running, but we cannot promise it will always be available or error-free. We are not responsible for the quality, safety or ingredients of food a kitchen prepares, for how a rider drives or behaves, for accidents, injuries or loss during a delivery, or for delays caused by weather, road closures, landslides, power or mobile network failures, which are common in our region. To the extent the law allows, our liability to you is limited to the amount of the order or bill concerned. Nothing here removes rights you have under the law that cannot be waived.",
    },
    {
      heading: "15. Changes to these terms",
      body:
        "We may update these terms. When we make an important change we will show the new version and may ask you to accept it again. Using the service after a change means you accept it.",
    },
    {
      heading: "16. Law and contact",
      body:
        `These terms are governed by the laws of Pakistan. We will try to settle any dispute by talking first; if that fails, the courts of Gilgit-Baltistan, Pakistan, will have jurisdiction. Questions, complaints or requests about your information: contact ${CONTACT}.`,
    },
  ],
  };
}

module.exports = { buildTerms, TERMS_VERSION: "1.2" };
