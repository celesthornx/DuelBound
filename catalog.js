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
// that catalog, only a second, server-side copy of the two facts that
// matter for money changing hands: does this id exist, and what does it
// cost. The two lists must be kept in sync by hand for now; unifying
// them into one fetched-from-the-server catalog is future work and
// would also let the render-only fields move server-side.
//
// Pure module: no sockets, no storage, no HTTP. server.js owns the
// account records and does the actual crediting/persisting.
// =====================================================================

const SKINS = [
    { id: "cyan", price: 0 },
    { id: "red", price: 0 },
    { id: "violet", price: 50 },
    { id: "gold", price: 75 },
    { id: "green", price: 75 },
    { id: "white", price: 100 },
    { id: "pink", price: 100 },
    { id: "orange", price: 60 },

    { id: "neonrunner", price: 120 },
    { id: "arcticarrow", price: 120 },
    { id: "crimsonfang", price: 120 },
    { id: "toxicskin", price: 120 },

    { id: "cybersamurai", price: 260 },
    { id: "galaxy", price: 260 },
    { id: "plasmacore", price: 260 },
    { id: "storm", price: 260 },

    { id: "eclipse", price: 520 },
    { id: "celestial", price: 520 },
    { id: "riftwalker", price: 520 },
    { id: "overlord", price: 520 },

    { id: "cardboardbox", price: 150 },
    { id: "rubberduck", price: 150 },
    { id: "toaster", price: 150 },
    { id: "carrot", price: 150 }
];

const POWERS = [
    { id: "extramag", price: 60 },
    { id: "rapidreload", price: 70 },
    { id: "quickdash", price: 80 },
    { id: "kevlar", price: 120 }
];

const ABILITIES = [
    { id: "quickreload", price: 90 },
    { id: "triburst", price: 150 },
    { id: "shockwave", price: 200 },
    { id: "timewarp", price: 280 },
    { id: "decoy", price: 350 },
    { id: "ricochet", price: 320 },
    { id: "voidblink", price: 420 }
];

// How many of an item TYPE can be equipped at once. Mirrors index.html's
// MAX_EQUIPPED_POWERS/MAX_EQUIPPED_ABILITIES -- kept here too so /save's
// clamp of a client-reported equip list has a server-side number to
// clamp against without importing the client's script.
const MAX_EQUIPPED_POWERS = 2;
const MAX_EQUIPPED_ABILITIES = 1;

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
    MAX_EQUIPPED_POWERS,
    MAX_EQUIPPED_ABILITIES,
    findItem
};
