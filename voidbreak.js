// =====================================================================
// VOIDBREAK CLOUD SAVE -- account-side persistence for the Voidbreak
// minigame (see voidbreak.html).
//
// Why this exists
// ----------------
// Voidbreak has always been a fully self-contained document loaded into
// its own iframe (see index.html's launchVoidbreak()), with its own
// progression (Void Shards, Forge upgrades, weapon unlocks, beaten
// levels) saved ONLY to that browser's localStorage under
// "voidbreak_save_v1" -- completely independent of the signed-in
// Google/password account. That's the entire bug: progress was tied to
// the DEVICE, not the account, so it never followed a player to a
// second device and never went away on logout (localStorage doesn't
// care who's signed in).
//
// This module is the server-side half of the fix -- the same role
// catalog.js/battlepass.js play for their own systems: a pure module
// (no sockets, no storage, no HTTP) that defines the shape of a
// Voidbreak save and the two things server.js needs to treat it
// correctly:
//   * sanitizeSaveData(raw) -- turns an arbitrary client-reported blob
//     into a safe, correctly-shaped save (or null if the input isn't
//     even the right shape). This is the SAME trust tier Daily
//     Challenges' progress and /save's kills/wins already sit at in
//     this codebase (client-reported, casual-mode, no server-side game
//     simulation to check it against) -- see server.js's big comment
//     above DAILY_CHALLENGE_POOL for why that's an accepted, existing
//     tradeoff here, not a new one. What this DOES defend against is a
//     corrupt/malicious payload wrecking the stored account record:
//     wrong types, unknown keys, and absurd numeric values are all
//     clamped or dropped.
//   * mergeSaveData(a, b) -- a safe, non-destructive, never-duplicating
//     merge for the one moment two saves can legitimately disagree: a
//     device with pre-existing local/offline progress reconnecting to
//     an account that already has its own cloud save. Every field is
//     either MAX'd or OR'd, never summed -- summing two independently
//     -grown shard counts would let a player farm shards twice (once
//     per device) and then "merge" them into double the total; MAX
//     can't do that because it only ever keeps the higher of two
//     honestly-earned totals, never invents a third number.
// =====================================================================

// The exact shape voidbreak.html's own `DEF_SAVE` uses -- kept in sync
// with it deliberately (this file does not invent a new progression
// model, it only re-describes the existing one so the server can
// validate it). `settings` (volume/music/sfx/shake/dmgnum) is NOT part
// of the cloud save on purpose: it's a per-device audio/UX preference,
// not account progression, so it stays local-only in voidbreak.html
// exactly as it already was.
const DEF_SAVE = {
    shards: 0,
    forge: { vit: 0, pow: 0, swift: 0, core: 0, drive: 0, edge: 0 },
    weapons: { pulse: true, scatter: false, rail: false, plasma: false, voidb: false, voidc: false },
    lastWeapon: "pulse",
    runs: 0,
    best: 0,
    kills: 0,
    beaten: {}
};

const FORGE_KEYS = Object.keys(DEF_SAVE.forge);
const WEAPON_KEYS = Object.keys(DEF_SAVE.weapons);

// Generous sanity ceilings -- not a balance/anti-cheat model, purely a
// guard against a corrupt or hostile payload storing an absurd number
// (e.g. Infinity, 1e300, a 50MB "beaten" object) forever in the account
// record. A genuine player will never get remotely close to these.
const MAX_SHARDS = 10000000;
const MAX_FORGE_LEVEL = 999;
const MAX_COUNTER = 1000000;
const MAX_LEVEL_ID = 100;      // Voidbreak currently ships 5 levels; this just leaves headroom for more without a code change here
const MAX_BEATEN_ENTRIES = 200; // matches MAX_LEVEL_ID headroom, keeps the object bounded

function clampInt(n, lo, hi, fallback) {
    const v = Math.floor(Number(n));
    if (!isFinite(v)) return fallback;
    return Math.max(lo, Math.min(hi, v));
}

// Turns an arbitrary client-reported value into a safe, correctly-shaped
// Voidbreak save, or null if `raw` isn't even an object. Never throws.
function sanitizeSaveData(raw) {
    if (!raw || typeof raw !== "object") return null;

    const forge = {};
    const rawForge = (raw.forge && typeof raw.forge === "object") ? raw.forge : {};
    for (const key of FORGE_KEYS) {
        forge[key] = clampInt(rawForge[key], 0, MAX_FORGE_LEVEL, 0);
    }

    const weapons = {};
    const rawWeapons = (raw.weapons && typeof raw.weapons === "object") ? raw.weapons : {};
    for (const key of WEAPON_KEYS) {
        weapons[key] = !!rawWeapons[key];
    }
    weapons.pulse = true; // the starter weapon is always owned, exactly like DEF_SAVE

    let lastWeapon = typeof raw.lastWeapon === "string" ? raw.lastWeapon : "pulse";
    if (WEAPON_KEYS.indexOf(lastWeapon) === -1 || !weapons[lastWeapon]) lastWeapon = "pulse";

    const beaten = {};
    const rawBeaten = (raw.beaten && typeof raw.beaten === "object") ? raw.beaten : {};
    let beatenCount = 0;
    for (const key of Object.keys(rawBeaten)) {
        if (beatenCount >= MAX_BEATEN_ENTRIES) break;
        const levelId = Math.floor(Number(key));
        if (!isFinite(levelId) || levelId < 1 || levelId > MAX_LEVEL_ID) continue;
        if (!rawBeaten[key]) continue; // only true entries are meaningful
        beaten[levelId] = true;
        beatenCount++;
    }

    return {
        shards: clampInt(raw.shards, 0, MAX_SHARDS, 0),
        forge: forge,
        weapons: weapons,
        lastWeapon: lastWeapon,
        runs: clampInt(raw.runs, 0, MAX_COUNTER, 0),
        best: clampInt(raw.best, 0, MAX_COUNTER, 0),
        kills: clampInt(raw.kills, 0, MAX_COUNTER, 0),
        beaten: beaten
    };
}

// Safe merge of two ALREADY-SANITIZED saves (never call with raw client
// input -- sanitize each side first). Every field is MAX'd or OR'd, per
// the module header comment: never summed, so merging can only ever
// raise a value to the higher of two honestly-earned totals, never
// invent a bigger one by combining them.
function mergeSaveData(a, b) {
    a = a || DEF_SAVE;
    b = b || DEF_SAVE;

    const forge = {};
    for (const key of FORGE_KEYS) {
        forge[key] = Math.max(a.forge[key] || 0, b.forge[key] || 0);
    }
    const weapons = {};
    for (const key of WEAPON_KEYS) {
        weapons[key] = !!(a.weapons[key] || b.weapons[key]);
    }
    const beaten = Object.assign({}, a.beaten, b.beaten);

    // lastWeapon is a pure loadout preference, not progression -- no
    // stakes either way, so it just follows whichever side actually has
    // it unlocked, preferring `a` (the caller passes the more-recent
    // side first at every call site).
    let lastWeapon = weapons[a.lastWeapon] ? a.lastWeapon : (weapons[b.lastWeapon] ? b.lastWeapon : "pulse");

    return {
        shards: Math.max(a.shards || 0, b.shards || 0),
        forge: forge,
        weapons: weapons,
        lastWeapon: lastWeapon,
        runs: Math.max(a.runs || 0, b.runs || 0),
        best: Math.max(a.best || 0, b.best || 0),
        kills: Math.max(a.kills || 0, b.kills || 0),
        beaten: beaten
    };
}

// True if a save is exactly the untouched starting state -- used to
// decide whether there's anything worth migrating/merging at all.
function isDefaultSave(s) {
    if (!s) return true;
    if (s.shards || s.runs || s.best || s.kills) return false;
    if (Object.keys(s.beaten || {}).length) return false;
    for (const key of FORGE_KEYS) if ((s.forge || {})[key]) return false;
    for (const key of WEAPON_KEYS) if (key !== "pulse" && (s.weapons || {})[key]) return false;
    return true;
}

function defaultSaveData() {
    return JSON.parse(JSON.stringify(DEF_SAVE));
}

module.exports = {
    DEF_SAVE,
    FORGE_KEYS,
    WEAPON_KEYS,
    sanitizeSaveData,
    mergeSaveData,
    isDefaultSave,
    defaultSaveData
};
