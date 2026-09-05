// =====================================================================
// CRYSTAL BILLING -- Stripe Checkout foundation for the premium currency.
//
// What this module owns
// ----------------------
//   * the Crystal package price list (what's for sale, and for how much)
//   * talking to the Stripe SDK: creating a Checkout Session, and
//     verifying/parsing a webhook event
//
// What it deliberately does NOT own
// ----------------------------------
// Granting Crystals. That happens in server.js, and only after the
// webhook handler there has: verified the event's signature (this
// module does that), recorded the Checkout Session id in the purchase
// ledger and confirmed THIS is the first time it's been seen (see
// storage.js's recordPurchaseIfNew -- an atomic, database-level check),
// and only then credited the account. This module never touches an
// account record, never touches the database, and never decides
// whether a purchase is "real" beyond verifying Stripe's signature --
// server.js is what makes the actual grant idempotent and atomic.
//
// Secrets: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are read from
// the environment ONLY. Neither is ever sent to the client, logged, or
// hard-coded. If STRIPE_SECRET_KEY is absent, this module simply
// reports itself as unconfigured -- server.js turns that into a plain
// "Crystal purchases are not available right now" response instead of
// pretending a purchase went through (see isConfigured()/CHECKOUT
// below). This is what the task calls for specifically: a real
// foundation that fails honestly when it isn't set up yet, not a fake
// success path.
// =====================================================================

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

// Lazily constructed so requiring this module never throws just
// because Stripe isn't configured yet (local dev, a fresh Render
// service before its env vars are set, etc.).
let _stripe = null;
function stripeClient() {
    if (!STRIPE_SECRET_KEY) return null;
    if (!_stripe) {
        const Stripe = require("stripe");
        _stripe = new Stripe(STRIPE_SECRET_KEY);
    }
    return _stripe;
}

function isConfigured() {
    return !!STRIPE_SECRET_KEY;
}
function webhookConfigured() {
    return !!STRIPE_WEBHOOK_SECRET;
}

// ---------------------------------------------------------------------
// CRYSTAL PACKAGES -- the one place these are defined. Placeholder
// prices per the brief; change the numbers here and both the Crystal
// Shop UI and the Checkout Session it creates pick up the new price on
// the next request -- nothing else in the codebase hard-codes a
// package price.
//
// `usdCents` is what Stripe actually charges (Stripe's API is
// cents-denominated, which also sidesteps floating-point cent errors).
// No Stripe Dashboard Product/Price setup is required for these to
// work: createCheckoutSession() below builds each line item with
// Stripe's `price_data` (an ad-hoc, on-the-fly price), not a
// pre-created Price ID. See the setup notes in the final summary for
// the alternative (Dashboard-managed Price IDs) if that's ever
// preferred instead.
// ---------------------------------------------------------------------
const CRYSTAL_PACKAGES = [
    { id: "crystals_500", crystals: 500, usdCents: 499, label: "500 Crystals" },
    { id: "crystals_1200", crystals: 1200, usdCents: 999, label: "1,200 Crystals" },
    { id: "crystals_2500", crystals: 2500, usdCents: 1999, label: "2,500 Crystals" },
    { id: "crystals_7000", crystals: 7000, usdCents: 4999, label: "7,000 Crystals" }
];

function findPackage(packageId) {
    if (typeof packageId !== "string") return null;
    return CRYSTAL_PACKAGES.find(p => p.id === packageId) || null;
}

// Public shape only -- nothing here is a secret, this is what the
// Crystal Shop UI fetches to render its price list instead of
// hard-coding the numbers a second time in index.html.
function publicPackages() {
    return CRYSTAL_PACKAGES.map(p => ({
        id: p.id, crystals: p.crystals, usdCents: p.usdCents, label: p.label
    }));
}

// ---------------------------------------------------------------------
// Checkout Session creation.
//
// `metadata` on the session is how the webhook later knows what to
// grant -- and it's trustworthy precisely because IT WAS SET HERE, by
// the server, from its own package lookup, at session-creation time.
// The client only ever chooses a packageId; it never gets to say how
// many Crystals that is or what it costs -- that comes from
// CRYSTAL_PACKAGES on this end, not from anything in the request.
// ---------------------------------------------------------------------
async function createCheckoutSession({ accountId, packageId, successUrl, cancelUrl }) {
    const stripe = stripeClient();
    if (!stripe) throw new Error("not_configured");

    const pkg = findPackage(packageId);
    if (!pkg) throw new Error("unknown_package");

    const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{
            quantity: 1,
            price_data: {
                currency: "usd",
                unit_amount: pkg.usdCents,
                product_data: {
                    name: pkg.label,
                    description: "DuelBound Crystals (premium currency)"
                }
            }
        }],
        client_reference_id: accountId,
        // Everything the webhook needs to grant the RIGHT amount to the
        // RIGHT account, server-decided and tamper-proof: Stripe signs
        // the event this metadata rides in, and the webhook handler
        // verifies that signature before reading any of it.
        metadata: {
            accountId: accountId,
            packageId: pkg.id,
            crystals: String(pkg.crystals)
        },
        success_url: successUrl,
        cancel_url: cancelUrl
    });

    return { id: session.id, url: session.url };
}

// ---------------------------------------------------------------------
// Webhook verification.
//
// `rawBody` MUST be the exact, unparsed request body Stripe sent --
// its signature is computed over those exact bytes, so JSON.parse-ing
// first (which can reorder/reformat whitespace) would make a genuine
// event fail verification. server.js reads the raw body itself for
// this one route, ahead of its usual JSON body parsing, specifically
// so this stays true.
//
// Throws on a missing/invalid signature -- callers must treat a thrown
// error as "reject this request", never as "process it anyway".
// ---------------------------------------------------------------------
function constructWebhookEvent(rawBody, signatureHeader) {
    const stripe = stripeClient();
    if (!stripe) throw new Error("not_configured");
    if (!STRIPE_WEBHOOK_SECRET) throw new Error("webhook_not_configured");
    return stripe.webhooks.constructEvent(rawBody, signatureHeader, STRIPE_WEBHOOK_SECRET);
}

module.exports = {
    CRYSTAL_PACKAGES,
    isConfigured,
    webhookConfigured,
    findPackage,
    publicPackages,
    createCheckoutSession,
    constructWebhookEvent
};
