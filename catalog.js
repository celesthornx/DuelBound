// =====================================================================
// SHOP CATALOG -- the server's own copy of what exists and what it
// costs.
//
// Why this exists
// ----------------
// Before this module, the shop had no server half at all: a "purchase"
// was the client decrementing its own `credits` variable, adding an id
// to its own owned-items Set, and then POSTing the resulting numbers to
// /save, which wrote them down verbatim. Nothing ever checked that the
// price was real, that the balance could actually cover it, or that the
// item existed -- a client could simply report owning everything with
// any credit total it liked.
//
// This module is the price list /shop/buy (see server.js) checks a
// purchase against. The client's own SKINS/POWERS/ABILITIES arrays in
// index.html still exist and still drive the shop's rendering (name,
// color, description, rarity) -- this is deliberately NOT a rewrite of
// that catalog, only a second, server-side copy of the three facts that
// matter for money changing hands: does this id exist, what does it
// cost, and which currency it costs. The two lists must be kept in sync
// by hand for now; unifying them into one fetched-from-the-server
// catalog is future work and would also let the render-only fields move
// server-side.
//
// Every item here costs COINS -- the free, earned-by-playing currency.
// Nothing in this file is ever priced in Crystals (the premium
// currency): existing items keep exactly the price and currency they
// already had, per the "do not auto-convert between currencies" rule.
// A future Crystal-priced cosmetic just needs `currency: "crystals"` on
// its own catalog entry -- /shop/buy already reads this field rather
// than assuming Coins.
//
// Pure module: no sockets, no storage, no HTTP. server.js owns the
// account records and does the actual crediting/persisting.
// =====================================================================

const SKINS = [
    { id: "cyan", price: 0, currency: "coins" },
    { id: "red", price: 0, currency: "coins" },
    { id: "violet", price: 50, currency: "coins" },
    { id: "gold", price: 75, currency: "coins" },
    { id: "green", price: 75, currency: "coins" },
    { id: "white", price: 100, currency: "coins" },
    { id: "pink", price: 100, currency: "coins" },
    { id: "orange", price: 60, currency: "coins" },

    { id: "neonrunner", price: 120, currency: "coins" },
    { id: "arcticarrow", price: 120, currency: "coins" },
    { id: "crimsonfang", price: 120, currency: "coins" },
    { id: "toxicskin", price: 120, currency: "coins" },

    { id: "cybersamurai", price: 260, currency: "coins" },
    { id: "galaxy", price: 260, currency: "coins" },
    { id: "plasmacore", price: 260, currency: "coins" },
    { id: "storm", price: 260, currency: "coins" },

    { id: "eclipse", price: 520, currency: "coins" },
    { id: "celestial", price: 520, currency: "coins" },
    { id: "riftwalker", price: 520, currency: "coins" },
    { id: "overlord", price: 520, currency: "coins" },

    { id: "cardboardbox", price: 150, currency: "coins" },
    { id: "rubberduck", price: 150, currency: "coins" },
    { id: "toaster", price: 150, currency: "coins" },
    { id: "carrot", price: 150, currency: "coins" }
];

const POWERS = [
    { id: "extramag", price: 60, currency: "coins" },
    { id: "rapidreload", price: 70, currency: "coins" },
    { id: "quickdash", price: 80, currency: "coins" },
    { id: "kevlar", price: 120, currency: "coins" }
];

const ABILITIES = [
    { id: "quickreload", price: 90, currency: "coins" },
    { id: "triburst", price: 150, currency: "coins" },
    { id: "shockwave", price: 200, currency: "coins" },
    { id: "timewarp", price: 280, currency: "coins" },
    { id: "decoy", price: 350, currency: "coins" },
    { id: "ricochet", price: 320, currency: "coins" },
    { id: "voidblink", price: 420, currency: "coins" }
];

// How many of an item TYPE can be equipped at once. Mirrors index.html's
// MAX_EQUIPPED_POWERS/MAX_EQUIPPED_ABILITIES -- kept here too so /save's
// clamp of a client-reported equip list has a server-side number to
// clamp against without importing the client's script.
const MAX_EQUIPPED_POWERS = 2;
const MAX_EQUIPPED_ABILITIES = 1;

// Every currency /shop/buy is allowed to debit. A typo in an item's
// `currency` field fails closed (findItem still returns the item, but
// server.js's own CURRENCIES.indexOf check on the LOOKED-UP item, not
// on anything client-supplied, is what actually gates the debit).
const CURRENCIES = ["coins", "crystals"];

const CATALOGS = { skin: SKINS, power: POWERS, ability: ABILITIES };

// The account field each item type's ownership lives in. Single place
// this mapping is spelled out, so /shop/buy and /save's clamp can't
// drift apart on which field belongs to which type.
const OWNED_FIELD = { skin: "ownedSkins", power: "ownedPowers", ability: "ownedAbilities" };

function findItem(itemType, itemId) {
    const list = CATALOGS[itemType];
    if (!list || typeof itemId !== "string") return null;
    return list.find(i => i.id === itemId) || null;
}

module.exports = {
    SKINS,
    POWERS,
    ABILITIES,
    OWNED_FIELD,
    CURRENCIES,
    MAX_EQUIPPED_POWERS,
    MAX_EQUIPPED_ABILITIES,
    findItem
};
