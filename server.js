const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

// =====================================================================
// GOOGLE SIGN-IN CONFIG
// Must be the exact same Client ID as GOOGLE_CLIENT_ID in index.html.
// =====================================================================
const GOOGLE_CLIENT_ID = "626321723959-98drobgk7pc43cf004psnfg0af816d10.apps.googleusercontent.com";

// =====================================================================
// ADMIN ACCESS
// Only this exact Google account can use the balance-editor admin
// endpoints. This is enforced entirely server-side (see isAdminSession
// below) -- the client never gets to declare "I am admin".
// =====================================================================
const ADMIN_EMAIL = "ultragodbit@gmail.com";

// =====================================================================
// ACCOUNT STORAGE -- keyed by the player's Google account id ("sub").
//
// Durability lives in storage.js, NOT on this instance's filesystem.
// A container host like Render rebuilds the filesystem from the Git
// checkout on every deploy, so anything written to a local accounts.json
// is lost the next time the service is redeployed or restarted. See
// storage.js for the backend selection (Postgres via DATABASE_URL, or
// JSON files under DATA_DIR).
//
// `accounts` below stays an in-memory read cache of the whole store, so
// every synchronous read path in this file (leaderboard, admin search,
// isAdminSession) works exactly as it always did. Only the boot load and
// the writes go through the storage layer.
// =====================================================================
const store = require("./storage");

// Ranked rating/rank/season maths. Pure functions only -- the queue,
// the match rooms and persistence all live in this file (see the RANKED
// section further down).
const Ranked = require("./ranked");
const Combat = require("./combat");

// Friends data shape, validation and public views. Pure functions only;
// persistence, presence and the WebSocket wiring live in this file (see
// the FRIENDS section further down).
const Friends = require("./friends");

const accounts = {}; // sub -> account record (populated in startServer())

// Persists ONE account. Callers await this before replying, so a client
// only ever sees "saved" once the write is durable.
//
// Deliberately per-account rather than "write the whole file": two
// players saving at the same moment touch different rows/keys and can
// never overwrite each other's progress.
async function persistAccount(sub) {
    if (!sub || !accounts[sub]) return;
    try {
        await store.saveAccount(sub, accounts[sub]);
    } catch (e) {
        console.log("[storage] failed to save account " + sub + ":", e.message);
        throw e;
    }
}

// Reserved display names a player can't take -- blocks exact-match
// impersonation of system/admin/bot identities that appear elsewhere in
// the UI (COMPUTER as the VS Computer opponent label, ADMIN/SYSTEM/
// MODERATOR as plausible authority-sounding names, and the game's own
// name). Deliberately an EXACT match (after trim + lowercase), not a
// substring ban -- a substring ban would also block legitimate names
// like "Administrator Jones" or "System32" for no real reason.
const RESERVED_USERNAMES = new Set([
    "admin", "administrator", "moderator", "mod", "system", "server",
    "computer", "bot", "ai", "gm", "game master", "duel arena", "duelarena",
    "official", "support", "staff"
]);

// Server-side username validation -- the ONLY place a display name is
// accepted from a client. Trims surrounding whitespace, collapses
// internal runs of whitespace to a single space, enforces a length
// window, and only allows a conservative character set (letters,
// numbers, spaces, and a small set of punctuation) so a name can never
// inject markup, control characters, or otherwise-invisible characters
// into any UI it's later `.textContent`'d or interpolated into.
function validateUsername(raw) {
    if (typeof raw !== "string") return { ok: false, error: "Username must be text" };
    // Collapse all whitespace runs (tabs, newlines, repeated spaces) to
    // a single space, then trim -- "trim unnecessary whitespace" plus
    // closing off a class of near-invisible names ("A    B" vs "A B").
    const name = raw.replace(/\s+/g, " ").trim();
    if (name.length < 2) return { ok: false, error: "Username must be at least 2 characters" };
    if (name.length > 20) return { ok: false, error: "Username must be 20 characters or fewer" };
    // Letters (incl. common accented ones), digits, spaces, and a small
    // punctuation set -- excludes anything that reads as markup/control
    // syntax (<, >, &, backslashes, quotes) or that could be used to
    // visually spoof another name (zero-width/invisible Unicode, emoji
    // used as impersonation).
    if (!/^[A-Za-z0-9À-ſ .\-_']+$/.test(name)) {
        return { ok: false, error: "Username contains characters that aren't allowed" };
    }
    if (RESERVED_USERNAMES.has(name.toLowerCase())) {
        return { ok: false, error: "That name is reserved" };
    }
    return { ok: true, name: name };
}

function defaultAccount(name, email) {
    return {
        name: name,
        email: email || "",
        credits: 100,
        kills: 0,
        wins: 0,
        ownedSkins: ["cyan", "red"],
        ownedPowers: [],
        equippedPowers: [],
        equippedPowersP2: [],
        ownedAbilities: [],
        equippedAbilities: [],
        equippedAbilitiesP2: [],
        p1SkinId: "cyan",
        p2SkinId: "red",
        autoAimP1: false,
        autoAimP2: false,
        aimMode: "movement",
        matchSize: 2,
        deviceMode: "auto",
        xp: 0,
        level: 1,
        tutorialComplete: false,
        dailyChallenges: defaultDailyChallenges(),
        ranked: Ranked.defaultRankedRecord(),
        // Friend lists hold stable account ids (Google "sub"), never emails.
        friends: [],
        incomingFriendRequests: [],
        outgoingFriendRequests: [],
        blocked: []
    };
}

// Brings an account up to the current ranked shape and persists it only
// if something actually changed. Safe to call on any account at any
// time: ensureRankedRecord() only ever fills in missing/invalid fields
// (and rolls a stale season into history), never removes or resets
// existing data, and returns the same reference when nothing changed.
//
// This is the ONLY migration path -- existing accounts pick up ranked
// defaults lazily the first time they're touched, so nothing has to
// rewrite the whole store at boot.
function ensureAccountRanked(sub) {
    const account = accounts[sub];
    if (!account) return null;
    const ensured = Ranked.ensureRankedRecord(account);
    if (ensured !== account.ranked) {
        account.ranked = ensured;
        persistAccount(sub).catch(e =>
            console.log("[ranked] failed to persist ranked migration for " + sub + ":", e.message));
    }
    return account.ranked;
}

// Resolves a sessionToken to that player's account record, or null.
function getAccountForSession(sessionToken) {
    const sub = sessions[sessionToken];
    if (!sub) return null;
    return accounts[sub] || null;
}

// =====================================================================
// XP / LEVEL PROGRESSION
//
// `xp` on an account is the player's TOTAL lifetime XP (monotonic, never
// decremented) -- `level` is always a value DERIVED from it, recomputed
// every time xp changes, never stored independently of what xp implies.
// That's what makes "excess XP carries over" and "level increases
// correctly" automatic instead of something that has to be tracked by
// hand: there's only ever one number that actually matters.
//
// XP required to go from `level` to `level+1` scales linearly
// (100, 150, 200, 200+50*(level-1), ...) -- predictable, and easy to
// rebalance later by changing this one function.
// =====================================================================
function xpRequiredForLevel(level) {
    return 100 + Math.max(0, level - 1) * 50;
}

// Derives {level, xpIntoLevel, xpForNextLevel} from a total XP count.
// Pure function, safe to call with any non-negative number -- never
// mutates anything, never goes negative, always terminates (each loop
// iteration consumes at least 100 XP).
function computeLevelFromXP(totalXp) {
    let xp = Math.max(0, Math.floor(totalXp) || 0);
    let level = 1;
    while (xp >= xpRequiredForLevel(level)) {
        xp -= xpRequiredForLevel(level);
        level++;
        if (level > 100000) break; // pathological input guard, not a real cap
    }
    return { level: level, xpIntoLevel: xp, xpForNextLevel: xpRequiredForLevel(level) };
}

// Same trust boundary as Daily Challenges' reward grant and the ranked
// pipeline: this is the ONLY function that actually changes an
// account's xp, it NEVER accepts a client-supplied amount (every call
// site below passes a fixed, server-decided number for a fixed reason
// string), and it does the same atomic read-modify-write-then-persist-
// with-rollback as /challenges/claim. Returns null if the account
// doesn't exist; otherwise the account's new xp/level plus enough
// about what changed for a caller to show "+N XP" / "LEVEL UP" feedback.
async function awardXP(sub, amount, reason) {
    const account = accounts[sub];
    if (!account) return null;
    amount = Math.max(0, Math.floor(amount) || 0);
    if (amount === 0) {
        const cur = computeLevelFromXP(account.xp || 0);
        return { awarded: 0, reason: reason, totalXp: account.xp || 0, level: cur.level, xpIntoLevel: cur.xpIntoLevel, xpForNextLevel: cur.xpForNextLevel, leveledUp: false, levelsGained: 0 };
    }

    const previousXp = account.xp || 0;
    const previousLevel = account.level || 1;
    const newTotal = previousXp + amount;
    const derived = computeLevelFromXP(newTotal);

    account.xp = newTotal;
    account.level = derived.level;

    try {
        await persistAccount(sub);
    } catch (e) {
        account.xp = previousXp; // write failed -- undo the in-memory grant
        account.level = previousLevel;
        console.log("[xp] failed to persist XP award for " + sub + ":", e.message);
        return null;
    }

    return {
        awarded: amount,
        reason: reason,
        totalXp: newTotal,
        level: derived.level,
        xpIntoLevel: derived.xpIntoLevel,
        xpForNextLevel: derived.xpForNextLevel,
        leveledUp: derived.level > previousLevel,
        levelsGained: derived.level - previousLevel
    };
}

// Convenience wrapper for the fully server-authoritative award sites
// (Heist base destroyed, Bomb Run match won, Ranked match complete) --
// awards XP to the account behind a live casual WebSocket connection
// (identified via conn.authSub, set by presence_hello -- see the
// "Casual connection identity" section below) and, if that socket is
// still open, tells its own client right away via a small `xpAward`
// message so the in-match/lobby toast can show up without a poll.
// Silently does nothing if the connection was never authenticated
// (a guest with no account has nothing to award XP to) -- calling code
// never needs its own "is this player signed in" branch.
async function awardXPAndNotify(conn, amount, reason) {
    if (!conn || !conn.authSub) return;
    const result = await awardXP(conn.authSub, amount, reason);
    if (result) send(conn, Object.assign({ type: "xpAward" }, result));
}

// Brings an account up to the current XP shape -- exactly the same
// lazy, idempotent, never-overwrite-existing-data pattern as
// ensureAccountRanked() above. An account that predates this feature
// (or was loaded from an older store snapshot) gets xp=0/level=1 the
// first time it's touched; an account that already has a numeric xp
// is left completely alone.
function ensureAccountXP(sub) {
    const account = accounts[sub];
    if (!account) return null;
    let dirty = false;
    if (typeof account.xp !== "number" || !isFinite(account.xp) || account.xp < 0) {
        account.xp = 0;
        dirty = true;
    }
    const derived = computeLevelFromXP(account.xp);
    if (account.level !== derived.level) {
        account.level = derived.level;
        dirty = true;
    }
    if (dirty) {
        persistAccount(sub).catch(e =>
            console.log("[xp] failed to persist XP migration for " + sub + ":", e.message));
    }
    return { level: account.level, xp: account.xp };
}

// Fixed, server-decided XP amounts. This is the ONE place XP values for
// each event live, per the "centralized so it's easy to rebalance"
// requirement -- nothing else in this file hardcodes an XP number.
const XP_REWARDS = {
    round_win: 15,
    match_win: 40,
    kill: 4,
    football_goal: 12,
    heist_win: 50,
    bombrun_win: 50,
    ranked_win: 60,
    ranked_loss: 10,
    voidbreak_complete: 80
};
// A single client report can claim at most this many "kill" units at
// once (see the /xp/report handler) -- a real match cannot produce an
// absurd kill count, so this exists purely to cap the blast radius of a
// forged request, not to model real gameplay.
const XP_MAX_KILLS_PER_REPORT = 20;

// Client-reported XP events (round/match wins, goals, kill counts,
// Voidbreak clears) have the SAME trust boundary Daily Challenges
// progress already has -- see the big comment above DAILY_CHALLENGE_POOL.
// This app has no server-side simulation of casual matches (only Ranked
// does), so "a round was won" is inherently a client report, exactly
// like "10 kills were gotten" already is for /save's kills counter. What
// this endpoint adds on top of that existing trust level is what the
// task calls for specifically: the AMOUNT of XP is never client-
// supplied (always looked up from XP_REWARDS by a fixed reason code),
// and a minimum-interval-per-reason throttle blunts naive duplicate/
// replay spam from a single session. Heist, Bomb Run and Ranked wins
// skip this endpoint entirely and are awarded directly at the exact
// moment the SERVER's own state machine confirms the win (see
// registerHeistHit's destroy branch, the bombGoal handler's matchOver
// branch, and completeRankedMatch) -- those three are fully
// server-authoritative with no client report involved at all.
const lastXPReportAt = {}; // sub -> { [reason]: timestampMs }
const XP_REPORT_MIN_INTERVAL_MS = {
    round_win: 3000,
    match_win: 3000,
    football_goal: 800,
    kill: 1500,
    voidbreak_complete: 3000
};
// Throttle bookkeeping is per-account and would otherwise keep one entry
// per account that ever reported XP, for the life of the process. The
// entries are only meaningful for a few seconds, so anything older than
// the longest throttle window is swept the next time the map is touched.
const XP_REPORT_ENTRY_TTL_MS = 60 * 1000;
let lastXPSweepAt = 0;

function sweepXPReportThrottle(now) {
    if (now - lastXPSweepAt < XP_REPORT_ENTRY_TTL_MS) return;
    lastXPSweepAt = now;
    for (const sub of Object.keys(lastXPReportAt)) {
        const perSub = lastXPReportAt[sub];
        let live = false;
        for (const reason of Object.keys(perSub)) {
            if (now - perSub[reason] < XP_REPORT_ENTRY_TTL_MS) { live = true; break; }
        }
        if (!live) delete lastXPReportAt[sub];
    }
}

function xpReportThrottled(sub, reason) {
    const now = Date.now();
    sweepXPReportThrottle(now);
    const perSub = lastXPReportAt[sub] || (lastXPReportAt[sub] = {});
    const minGap = XP_REPORT_MIN_INTERVAL_MS[reason] || 2000;
    if (perSub[reason] && (now - perSub[reason]) < minGap) return true;
    perSub[reason] = now;
    return false;
}

// The ONLY place that decides "is this request from the admin". Always
// re-derives the answer from the server's own session map and stored
// account email -- never from anything the client claims about itself.
function isAdminSession(sessionToken) {
    const account = getAccountForSession(sessionToken);
    return !!(account && account.email &&
        account.email.toLowerCase() === ADMIN_EMAIL.toLowerCase());
}

// sessionToken -> google "sub".
//
// Persisted, not in-memory-only. When this map was rebuilt empty on every
// boot, a redeploy silently invalidated the token every signed-in player's
// tab was still holding: their /save calls came back 401, the client
// ignored the status, and everything they earned after the redeploy was
// dropped without any error. Sessions now survive a restart, so an open
// tab keeps saving straight through a deploy.
//
// Kept as a plain in-memory object (loaded at boot, written through on
// sign-in) so getAccountForSession/isAdminSession stay synchronous.
const sessions = {};

// Records a new session in memory AND in the store.
async function persistSession(token, sub) {
    sessions[token] = sub;
    try {
        await store.saveSession(token, { sub: sub, createdAt: Date.now() });
    } catch (e) {
        // The session still works on this instance; it just won't survive
        // a restart. Not worth failing the sign-in over.
        console.log("[storage] failed to persist session:", e.message);
    }
}

function verifyGoogleToken(idToken) {
    return new Promise((resolve, reject) => {
        if (!idToken || typeof idToken !== "string") {
            reject(new Error("Missing credential"));
            return;
        }
        const url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
        https.get(url, res => {
            let body = "";
            res.on("data", chunk => { body += chunk; });
            res.on("end", () => {
                try {
                    const data = JSON.parse(body);
                    if (!data.sub) {
                        reject(new Error("Invalid Google token"));
                        return;
                    }
                    if (data.aud !== GOOGLE_CLIENT_ID) {
                        reject(new Error("Token was not issued for this app"));
                        return;
                    }
                    resolve(data); // { sub, email, name, ... }
                } catch (e) {
                    reject(e);
                }
            });
        }).on("error", reject);
    });
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (body.length > 2e6) req.destroy(); // basic size guard
        });
        req.on("end", () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (e) { reject(e); }
        });
        req.on("error", reject);
    });
}

function sendJson(res, statusCode, obj) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end(JSON.stringify(obj));
}

// =====================================================================
// ABILITY BALANCE CONFIG
// A centralized set of tunable numbers per ability, editable from the
// admin panel. These defaults must match the values index.html's
// ABILITY_CONFIG_DEFAULTS starts with -- that's what keeps default
// gameplay behavior identical to before this system existed, and what
// "Reset" restores. Only fields that ability actually uses are listed
// (e.g. Void Blink has nothing but a cooldown -- it teleports instantly
// to a computed position, there's no speed/range/damage to tune).
// =====================================================================
const ABILITY_DEFAULTS = {
    triburst:    { bulletCount: 3, damage: 1, speed: 620, range: 220, spreadDegrees: 12, cooldown: 4.0 },
    shockwave:   { damage: 1, radius: 75, dashDurationPercent: 55 },
    timewarp:    { slowPercent: 45, duration: 2.5, cooldown: 11.0 },
    decoy:       { duration: 6.0, moveSpeed: 221, cooldown: 16.0 },
    ricochet:    { maxBounces: 3 },
    voidblink:   { cooldown: 13.0 },
    quickreload: { reloadSpeedPercent: 40, ammoPenalty: 2 }
};

// Server-side validation ranges -- the browser's own min/max on the
// input fields is just UX. This is what actually stops an absurd or
// malicious value from being saved, regardless of what the client sends.
const FIELD_LIMITS = {
    damage:              [0, 10],
    speed:               [0, 2000],
    range:               [0, 1200],
    cooldown:            [0, 60],
    duration:            [0, 60],
    bulletCount:         [1, 10],
    spreadDegrees:       [0, 90],
    radius:              [0, 500],
    dashDurationPercent: [10, 100],
    slowPercent:         [0, 100],
    moveSpeed:           [0, 1000],
    maxBounces:          [0, 10],
    reloadSpeedPercent:  [5, 100],
    ammoPenalty:         [0, 5]
};

// Ability balance is admin-editable at runtime, so it has exactly the
// same ephemeral-filesystem problem accounts did and goes through the
// same storage layer. Seeded from the committed abilityConfig.json.
const ABILITY_CONFIG_SEED_FILE = path.join(__dirname, "abilityConfig.json");

function mergeAbilityConfig(stored) {
    // Merge onto defaults field-by-field so a missing store, a missing
    // ability, or a newly-added field never produces an undefined value.
    const merged = {};
    for (const abilityId of Object.keys(ABILITY_DEFAULTS)) {
        merged[abilityId] = Object.assign({}, ABILITY_DEFAULTS[abilityId], (stored && stored[abilityId]) || {});
    }
    return merged;
}

async function loadAbilityConfig() {
    let stored = await store.loadDoc("abilityConfig", null);
    if (stored === null) {
        // Nothing stored yet -- seed from the file committed to the repo.
        try {
            stored = JSON.parse(fs.readFileSync(ABILITY_CONFIG_SEED_FILE, "utf8"));
        } catch (e) {
            stored = {};
        }
    }
    return mergeAbilityConfig(stored);
}

function persistAbilityConfig() {
    store.saveDoc("abilityConfig", abilityConfig)
        .catch(e => console.log("[storage] failed to save abilityConfig:", e.message));
}

let abilityConfig = mergeAbilityConfig({}); // replaced in startServer()

// Clamps and type-checks a single incoming value against FIELD_LIMITS.
// Returns null if the field name is unknown or the value isn't a finite
// number -- callers must treat null as "reject/ignore this field".
function clampField(key, rawValue) {
    const limits = FIELD_LIMITS[key];
    if (!limits) return null;
    const n = Number(rawValue);
    if (!isFinite(n)) return null;
    return Math.max(limits[0], Math.min(limits[1], n));
}

// =====================================================================
// DAILY CHALLENGES
//
// Three challenges a day -- one each of "get N kills", "win N matches"
// and "play N matches" -- picked deterministically from a small pool so
// every player sees the SAME three challenges on the SAME UTC calendar
// day, with no per-player state needed to decide what today's set is.
//
// The reset is the actual date, not "24h after this player last opened
// the game": today's set is a pure function of today's date string, and
// an account's stored progress/claimed state is rolled to a fresh
// {progress:0, claimed:{}} the moment it's next touched (via /save or
// /challenges/*) and its stored date no longer matches. That self-heals
// correctly however long the account was untouched for -- offline play,
// a server restart, a multi-day absence -- there is no in-memory-only
// timer that a restart could lose.
//
// Trust boundary: PROGRESS counts ride on the same client-authoritative
// /save path as the account's lifetime kills/wins/credits already do
// (see the /save handler) -- that trust level is this codebase's
// existing, deliberate tradeoff, not a new one introduced here. What is
// NOT client-trusted is the reward itself: /challenges/claim
// independently recomputes today's canonical challenge set, checks the
// account's own stored progress against it, checks the claimed flag,
// and increments credits by the server's own copy of the reward amount
// -- never a client-supplied one. A modified client can lie about
// progress (same as it already could about kills/wins); it cannot claim
// a reward it hasn't earned or claim one twice.
// =====================================================================
const DAILY_CHALLENGE_POOL = {
    kills: [
        { id: "kills_10", name: "BLOODHOUND",   desc: "Get 10 kills", target: 10, reward: 40 },
        { id: "kills_15", name: "SHARPSHOOTER", desc: "Get 15 kills", target: 15, reward: 55 },
        { id: "kills_20", name: "REAPER",       desc: "Get 20 kills", target: 20, reward: 70 }
    ],
    wins: [
        { id: "wins_2", name: "VICTOR",   desc: "Win 2 matches", target: 2, reward: 60 },
        { id: "wins_3", name: "CHAMPION", desc: "Win 3 matches", target: 3, reward: 85 }
    ],
    matches: [
        { id: "matches_3", name: "ARENA REGULAR", desc: "Play 3 matches", target: 3, reward: 30 },
        { id: "matches_5", name: "DEDICATED",     desc: "Play 5 matches", target: 5, reward: 45 }
    ]
};
const DAILY_CHALLENGE_CATEGORIES = ["kills", "wins", "matches"];

// Today's UTC calendar date as "YYYY-MM-DD". UTC (not the server's local
// zone, and not the player's) so every player and every server instance
// agree on what day it is, and the reset moment is the same wall-clock
// instant for everyone.
function todayUTC() {
    return new Date().toISOString().slice(0, 10);
}

// FNV-1a string hash -> mulberry32 PRNG. Small, dependency-free, and
// -- the only property that actually matters here -- exactly
// deterministic for a given date string, so every process/player
// derives the identical sequence without any of them telling each other
// what it is.
function hashStringToSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}
function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

// Today's 3 challenges: one deterministically-picked variant per
// category. Pure function of dateStr -- callable from anywhere without
// touching any account.
function getDailyChallenges(dateStr) {
    const rng = mulberry32(hashStringToSeed("voidbreak-daily-" + dateStr));
    return DAILY_CHALLENGE_CATEGORIES.map(category => {
        const variants = DAILY_CHALLENGE_POOL[category];
        const variant = variants[Math.floor(rng() * variants.length) % variants.length];
        return Object.assign({ category: category }, variant);
    });
}

// Returns a dailyChallenges record valid for TODAY, given an account's
// stored one (which may be missing, malformed, or simply from an
// earlier date). Never mutates its input -- returns the SAME reference
// back when it's already valid for today (so callers can cheaply tell
// "did this actually roll over"), or a fresh zeroed one otherwise.
function ensureDailyChallenges(stored) {
    const today = todayUTC();
    if (stored && typeof stored === "object" && stored.date === today &&
        stored.progress && typeof stored.progress === "object" &&
        stored.claimed && typeof stored.claimed === "object") {
        return stored;
    }
    return { date: today, progress: { kills: 0, wins: 0, matches: 0 }, claimed: {} };
}

function defaultDailyChallenges() {
    return { date: null, progress: { kills: 0, wins: 0, matches: 0 }, claimed: {} };
}

// =====================================================================
// RANKED -- queue, match rooms, and server-authoritative results.
//
// HOW RESULTS ARE DECIDED (and the honest limits of it)
// ----------------------------------------------------
// This codebase has no server-side game simulation: the WebSocket layer
// relays position/bullets/damage and the clients simulate everything.
// So the server cannot independently "see" who won a round.
//
// What it CAN do -- and what this implements -- is exploit the direction
// the existing protocol already reports in. A `damage` message describes
// the SENDER'S OWN health, and carries `eliminated` when the sender's own
// player died. In other words every elimination is self-reported by the
// player who LOST that round. That is an admission against interest:
//
//   * A cheater CANNOT forge a win. There is no "I killed them" message
//     to fake -- to gain a round they would need the OPPONENT'S client
//     to send "I died", which they do not control.
//   * The server counts rounds itself from those self-reports and
//     declares the match winner at roundsToWin. The clients are never
//     asked who won and are never believed if they say.
//
// So the RP-relevant question ("who won") is server-decided from
// messages that can only ever be sent to a player's own detriment.
//
// The residual risks, stated plainly rather than papered over:
//   1. A modified client can REFUSE to report its own death. It cannot
//      win that way -- it just stalls the match -- so this is handled as
//      abandonment (disconnect forfeit + match timeout) rather than as a
//      result.
//   2. Two consenting accounts can feed each other wins. No amount of
//      message validation fixes collusion; it is mitigated by the
//      repeat-opponent rule (see ranked.js isPairingRated) which makes
//      the 4th+ match between the same pair inside an hour unrated.
// Genuinely fixing (1) and (2) needs a server-side authoritative
// simulation, which is a rewrite of the whole game loop and explicitly
// out of scope here.
// =====================================================================

const RANKED_CONFIG = Ranked.RANKED_CONFIG;

// sub -> queue entry. Keyed by ACCOUNT, not by socket, so the same
// account cannot occupy two queue slots from two tabs.
const rankedQueue = new Map();

// matchId -> match room.
const rankedMatches = new Map();

// sub -> matchId, so a reconnecting/duplicate socket can be told it is
// already in a match instead of silently starting a second one.
const rankedPlayerMatch = new Map();

// Match ids are server-generated and unguessable. The random suffix is
// what stops a client submitting results for a match it invented.
function newRankedMatchId() {
    const d = new Date();
    const stamp = d.toISOString().slice(0, 10).replace(/-/g, "") +
        "_" + String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0");
    return "ranked_" + stamp + "_" + crypto.randomBytes(6).toString("hex");
}

// Ranked match history, newest first. Capped and persisted through the
// same storage layer everything else uses.
const RANKED_HISTORY_LIMIT = 300;
let rankedHistory = []; // replaced in startServer()

function persistRankedHistory() {
    store.saveDoc("rankedHistory", rankedHistory)
        .catch(e => console.log("[ranked] failed to save match history:", e.message));
}

function pushRankedHistory(entry) {
    rankedHistory.unshift(entry);
    if (rankedHistory.length > RANKED_HISTORY_LIMIT) rankedHistory.length = RANKED_HISTORY_LIMIT;
    persistRankedHistory();
}

// ---------------------------------------------------------------------
// QUEUE
// ---------------------------------------------------------------------
function rankedQueueStatusFor(entry) {
    const waitedSec = (Date.now() - entry.joinedAt) / 1000;
    return {
        type: "ranked_queue_status",
        waited: Math.floor(waitedSec),
        range: Ranked.matchmakingRange(entry.record, waitedSec),
        queued: rankedQueue.size
    };
}

function joinRankedQueue(conn, sessionToken) {
    const sub = sessions[sessionToken];
    if (!sub) {
        send(conn, { type: "ranked_error", code: "auth", message: "Sign in to play Ranked" });
        return;
    }
    if (!accounts[sub]) {
        send(conn, { type: "ranked_error", code: "account", message: "Account not loaded -- sign in again" });
        return;
    }
    // Already playing a ranked match on another tab/socket.
    if (rankedPlayerMatch.has(sub)) {
        send(conn, { type: "ranked_error", code: "inMatch", message: "You are already in a ranked match" });
        return;
    }

    const record = ensureAccountRanked(sub);

    // Re-queueing from a second tab replaces the first entry rather than
    // creating a duplicate (the Map key is the account).
    const previous = rankedQueue.get(sub);
    if (previous && previous.conn !== conn) {
        send(previous.conn, { type: "ranked_queue_left", reason: "replaced" });
        previous.conn.rankedQueued = false;
    }

    const entry = {
        sub: sub,
        conn: conn,
        record: record,
        name: accounts[sub].name || "Player",
        joinedAt: Date.now()
    };
    rankedQueue.set(sub, entry);
    conn.rankedSub = sub;
    conn.rankedQueued = true;

    send(conn, {
        type: "ranked_queue_joined",
        ranked: Ranked.publicRankedView(accounts[sub])
    });
    send(conn, rankedQueueStatusFor(entry));

    // Try immediately so two players already waiting pair up without
    // waiting for the next tick.
    tryMatchRankedQueue();
}

function leaveRankedQueue(sub, reason) {
    const entry = rankedQueue.get(sub);
    if (!entry) return false;
    rankedQueue.delete(sub);
    if (entry.conn) entry.conn.rankedQueued = false;
    send(entry.conn, { type: "ranked_queue_left", reason: reason || "left" });
    return true;
}

// Pairs everyone who can legally be paired right now. Oldest waiter
// first, so the longest-waiting player gets the widest band applied to
// them and is served before newer arrivals.
function tryMatchRankedQueue() {
    if (rankedQueue.size < 2) return;
    const now = Date.now();

    const waiting = Array.from(rankedQueue.values())
        .filter(e => e.conn && e.conn.socket.readyState === WebSocket.OPEN)
        .sort((a, b) => a.joinedAt - b.joinedAt);

    const used = new Set();

    for (let i = 0; i < waiting.length; i++) {
        const a = waiting[i];
        if (used.has(a.sub)) continue;

        let best = null;
        let bestGap = Infinity;

        for (let j = i + 1; j < waiting.length; j++) {
            const b = waiting[j];
            if (used.has(b.sub)) continue;
            if (b.sub === a.sub) continue;

            const aWaited = (now - a.joinedAt) / 1000;
            const bWaited = (now - b.joinedAt) / 1000;
            if (!Ranked.isAcceptableMatch(a, b, aWaited, bWaited)) continue;

            // Closest rating wins among everyone acceptable.
            const gap = Math.abs((a.record.rp || 0) - (b.record.rp || 0));
            if (gap < bestGap) { bestGap = gap; best = b; }
        }

        if (best) {
            used.add(a.sub);
            used.add(best.sub);
            rankedQueue.delete(a.sub);
            rankedQueue.delete(best.sub);
            a.conn.rankedQueued = false;
            best.conn.rankedQueued = false;
            createRankedMatch(a, best);
        }
    }
}

// ---------------------------------------------------------------------
// MATCH ROOMS
// ---------------------------------------------------------------------
function createRankedMatch(entryA, entryB) {
    const matchId = newRankedMatchId();

    // Anti-farm is evaluated ONCE, when the match is created, from both
    // sides -- so a pair can't dodge it by whoever happens to report
    // first, and the rated-ness is fixed before a single shot is fired.
    const ratedA = Ranked.isPairingRated(entryA.record, entryB.sub);
    const ratedB = Ranked.isPairingRated(entryB.record, entryA.sub);
    const rated = ratedA && ratedB;

    const match = {
        id: matchId,
        season: RANKED_CONFIG.season,
        rated: rated,
        createdAt: Date.now(),
        startedAt: null,
        // Round wins as counted BY THIS SERVER from self-reported
        // eliminations -- never from a client claiming a win.
        score: { 1: 0, 2: 0 },
        finished: false,
        // The single guard that makes result processing exactly-once.
        resultApplied: false,
        players: {},
        disconnectTimer: null,
        timeoutTimer: null
    };

    const setup = (slot, entry, oppEntry) => {
        const conn = entry.conn;
        conn.rankedMatchId = matchId;
        conn.rankedSlot = slot;
        conn.rankedSub = entry.sub;
        match.players[slot] = {
            slot: slot,
            sub: entry.sub,
            name: entry.name,
            conn: conn,
            // Snapshot the rating at match START. Using the live record
            // at result time would let a player's other concurrent match
            // change the maths of this one.
            rpAtStart: entry.record.rp,
            rankAtStart: Ranked.getRankForRecord(entry.record),
            placementCompleteAtStart: true,
            connected: true
        };
        rankedPlayerMatch.set(entry.sub, matchId);
    };

    setup(1, entryA, entryB);
    setup(2, entryB, entryA);

    // Each ranked room owns its combat state, so health/damage in one
    // match can never be affected by another. Shields are read from each
    // player's own account, never from anything they send.
    match.combat = Combat.createCombatMatch(abilityConfig);
    for (const slot of [1, 2]) {
        const acct = accounts[match.players[slot].sub];
        const kevlar = acct && Array.isArray(acct.equippedPowers) &&
            acct.equippedPowers.indexOf("kevlar") >= 0;
        match.combat.setShields(slot, kevlar ? 1 : 0);
    }

    rankedMatches.set(matchId, match);

    // A match nobody ever finishes must not leak. This is also what
    // covers "both clients silently vanished without a close event".
    match.timeoutTimer = setTimeout(() => {
        if (!match.finished) abandonRankedMatch(match, "timeout");
    }, RANKED_CONFIG.matchTimeoutMs);

    // Tell each side who they're facing. Only public rank info is sent --
    // never the opponent's email or account id.
    for (const slot of [1, 2]) {
        const me = match.players[slot];
        const them = match.players[slot === 1 ? 2 : 1];
        send(me.conn, {
            type: "ranked_match_found",
            matchId: matchId,
            slot: slot,
            rated: rated,
            season: RANKED_CONFIG.season,
            roundsToWin: RANKED_CONFIG.roundsToWin,
            you: {
                name: me.name,
                rp: me.rpAtStart,
                rank: me.rankAtStart,
                placementComplete: me.placementCompleteAtStart
            },
            opponent: {
                name: them.name,
                rp: them.rpAtStart,
                rank: them.rankAtStart,
                placementComplete: them.placementCompleteAtStart
            }
        });
    }

    console.log("[ranked] match " + matchId + " created: " +
        entryA.name + " (" + (entryA.record.rp || 0) + ") vs " +
        entryB.name + " (" + (entryB.record.rp || 0) + ")" + (rated ? "" : " [UNRATED - repeat pairing]"));

    return match;
}

// Both clients confirm they've loaded in; the match clock starts when
// the second one does.
function rankedMatchReady(conn) {
    const match = rankedMatches.get(conn.rankedMatchId);
    if (!match || match.finished) return;
    const me = match.players[conn.rankedSlot];
    if (!me) return;
    me.ready = true;
    const other = match.players[conn.rankedSlot === 1 ? 2 : 1];
    if (other && other.ready && !match.startedAt) {
        match.startedAt = Date.now();
        for (const slot of [1, 2]) {
            send(match.players[slot].conn, { type: "ranked_match_start", matchId: match.id });
        }
    }
}

// The server's own round counter. `loserSlot` is the slot of the player
// whose client reported ITS OWN elimination, so the round goes to the
// other one. See the trust discussion at the top of this section.
function registerRankedElimination(match, loserSlot) {
    if (!match || match.finished) return;
    const winnerSlot = loserSlot === 1 ? 2 : 1;
    match.score[winnerSlot]++;

    for (const slot of [1, 2]) {
        send(match.players[slot].conn, {
            type: "ranked_score",
            matchId: match.id,
            score: match.score
        });
    }

    if (match.score[winnerSlot] >= RANKED_CONFIG.roundsToWin) {
        completeRankedMatch(match, winnerSlot, "rounds");
    }
}

// ---------------------------------------------------------------------
// completeRankedMatch -- THE single place a ranked match produces RP.
//
// Exactly-once by construction: the first thing it does is claim the
// match via `resultApplied`. Every other path into it (round win,
// forfeit, timeout, a client spamming messages) hits that guard, so a
// client sending "I won" twenty times still produces exactly one result.
// ---------------------------------------------------------------------
async function completeRankedMatch(match, winnerSlot, reason) {
    if (!match || match.resultApplied) return;
    match.resultApplied = true; // claim BEFORE any await -- no interleaving
    match.finished = true;

    if (match.timeoutTimer) { clearTimeout(match.timeoutTimer); match.timeoutTimer = null; }
    if (match.disconnectTimer) { clearTimeout(match.disconnectTimer); match.disconnectTimer = null; }

    const winner = match.players[winnerSlot];
    const loser = match.players[winnerSlot === 1 ? 2 : 1];

    // Re-read the live records at completion time (they are the source
    // of truth), but use the START-time ratings for the RP maths so the
    // result of this match can't be shifted by anything that happened
    // elsewhere while it was being played.
    const summaries = {};
    const applied = [];

    for (const p of [winner, loser]) {
        const won = p === winner;
        const opponent = won ? loser : winner;
        const account = accounts[p.sub];
        if (!account) continue;

        const before = ensureAccountRanked(p.sub);
        const opponentRP = opponent.rpAtStart !== null
            ? opponent.rpAtStart
            : RANKED_CONFIG.startingRP; // unranked opponent -> treat as baseline

        const result = Ranked.applyMatchResult(before, {
            won: won,
            opponentRP: opponentRP,
            rated: match.rated
        });

        // Record the pairing for the anti-farm window.
        result.record.recentOpponents = Ranked.recordPairing(result.record, opponent.sub);

        account.ranked = result.record;
        summaries[p.slot] = result.summary;

        // Server-authoritative XP -- this loop only ever runs once per
        // match (see the resultApplied guard above), and `won` is
        // computed here from the server's own match state, not a client
        // report. Mutated directly (not via awardXP()) so it lands in
        // the SAME persistAccount() write as the ranked result just
        // below, instead of a separate write.
        const xpAmount = won ? XP_REWARDS.ranked_win : XP_REWARDS.ranked_loss;
        const previousXp = account.xp || 0;
        const previousLevel = account.level || 1;
        const xpDerived = computeLevelFromXP(previousXp + xpAmount);
        account.xp = previousXp + xpAmount;
        account.level = xpDerived.level;
        const xpResult = {
            awarded: xpAmount,
            reason: won ? "ranked_win" : "ranked_loss",
            totalXp: account.xp,
            level: xpDerived.level,
            xpIntoLevel: xpDerived.xpIntoLevel,
            xpForNextLevel: xpDerived.xpForNextLevel,
            leveledUp: xpDerived.level > previousLevel,
            levelsGained: xpDerived.level - previousLevel
        };

        applied.push({ sub: p.sub, slot: p.slot, record: result.record, summary: result.summary, xp: xpResult });
    }

    // Persist BOTH accounts before telling anyone they gained RP. If a
    // write fails the client is told the result did not save, rather
    // than being shown a promotion that isn't in the database.
    let persistError = null;
    for (const row of applied) {
        try {
            await persistAccount(row.sub);
        } catch (e) {
            persistError = e;
            console.log("[ranked] FAILED to persist result for " + row.sub + ":", e.message);
        }
    }

    pushRankedHistory({
        matchId: match.id,
        season: match.season,
        rated: match.rated,
        reason: reason,
        at: Date.now(),
        players: [1, 2].map(slot => {
            const p = match.players[slot];
            const s = summaries[slot];
            return {
                name: p.name,
                id: p.sub,
                slot: slot,
                won: slot === winnerSlot,
                rpBefore: s ? s.rpBefore : null,
                rpChange: s ? s.rpChange : 0,
                rpAfter: s ? s.rpAfter : null
            };
        }),
        winnerSlot: winnerSlot,
        score: match.score,
        saved: !persistError
    });

    // Tell each side their own result (and only the public half of the
    // opponent's).
    const xpBySlot = {};
    for (const row of applied) xpBySlot[row.slot] = row.xp;

    for (const slot of [1, 2]) {
        const p = match.players[slot];
        const them = match.players[slot === 1 ? 2 : 1];
        const s = summaries[slot];
        if (!p.conn) continue;
        send(p.conn, {
            type: "ranked_match_result",
            matchId: match.id,
            won: slot === winnerSlot,
            reason: reason,
            rated: match.rated,
            score: match.score,
            saved: !persistError,
            error: persistError ? "Result could not be saved -- it may not have applied" : null,
            result: s || null,
            xp: xpBySlot[slot] || null,
            opponent: {
                name: them.name,
                rank: summaries[them.slot] ? summaries[them.slot].rankAfter : them.rankAtStart,
                rp: summaries[them.slot] ? summaries[them.slot].rpAfter : them.rpAtStart
            },
            ranked: accounts[p.sub] ? Ranked.publicRankedView(accounts[p.sub]) : null
        });
    }

    cleanupRankedMatch(match);
    invalidateRankedLeaderboard(); // both ladders just moved

    console.log("[ranked] match " + match.id + " complete (" + reason + "): " +
        winner.name + " beat " + loser.name + " " +
        match.score[winnerSlot] + "-" + match.score[winnerSlot === 1 ? 2 : 1] +
        (match.rated ? "" : " [unrated]"));
}

// A match that ended without a winner (both gone, or timed out before
// anyone scored). Nobody's RP moves.
function abandonRankedMatch(match, reason) {
    if (!match || match.resultApplied) return;
    match.resultApplied = true;
    match.finished = true;
    if (match.timeoutTimer) { clearTimeout(match.timeoutTimer); match.timeoutTimer = null; }
    if (match.disconnectTimer) { clearTimeout(match.disconnectTimer); match.disconnectTimer = null; }

    for (const slot of [1, 2]) {
        const p = match.players[slot];
        if (p && p.conn) send(p.conn, { type: "ranked_match_abandoned", matchId: match.id, reason: reason });
    }
    cleanupRankedMatch(match);
    console.log("[ranked] match " + match.id + " abandoned (" + reason + ")");
}

function cleanupRankedMatch(match) {
    for (const slot of [1, 2]) {
        const p = match.players[slot];
        if (!p) continue;
        if (rankedPlayerMatch.get(p.sub) === match.id) rankedPlayerMatch.delete(p.sub);
        if (p.conn) {
            p.conn.rankedMatchId = null;
            p.conn.rankedSlot = null;
        }
    }
    rankedMatches.delete(match.id);
}

// A player's socket dropped. Before the match has started this just
// cancels it; once it's underway it becomes a forfeit after a grace
// period, so a blip doesn't lose the match but a rage-quit doesn't
// escape it either.
function handleRankedDisconnect(conn) {
    const sub = conn.rankedSub;

    if (conn.rankedQueued && sub) leaveRankedQueue(sub, "disconnected");

    const matchId = conn.rankedMatchId;
    if (!matchId) return;
    const match = rankedMatches.get(matchId);
    if (!match || match.finished) return;

    const me = match.players[conn.rankedSlot];
    const other = match.players[conn.rankedSlot === 1 ? 2 : 1];
    if (me) me.connected = false;

    // Both gone -> nothing to award to anybody.
    if (other && !other.connected) {
        abandonRankedMatch(match, "bothDisconnected");
        return;
    }

    // Never started -> cancel cleanly, no result.
    if (!match.startedAt) {
        abandonRankedMatch(match, "leftBeforeStart");
        return;
    }

    if (other && other.conn) {
        send(other.conn, {
            type: "ranked_opponent_disconnected",
            matchId: match.id,
            forfeitInSec: Math.round(RANKED_CONFIG.disconnectForfeitMs / 1000)
        });
    }

    if (match.disconnectTimer) clearTimeout(match.disconnectTimer);
    match.disconnectTimer = setTimeout(() => {
        if (match.finished) return;
        const stillGone = match.players[conn.rankedSlot] && !match.players[conn.rankedSlot].connected;
        if (!stillGone) return; // they came back
        const survivor = match.players[conn.rankedSlot === 1 ? 2 : 1];
        if (survivor && survivor.connected) {
            completeRankedMatch(match, survivor.slot, "forfeit");
        } else {
            abandonRankedMatch(match, "bothDisconnected");
        }
    }, RANKED_CONFIG.disconnectForfeitMs);
}

// Queue housekeeping. Also the thing that keeps the client's "queue
// time" honest -- it's the server's own clock being pushed out, not a
// number the client made up.
const RANKED_TICK_MS = 1000;
setInterval(() => {
    const now = Date.now();
    for (const entry of Array.from(rankedQueue.values())) {
        // Drop entries whose socket died without a close event.
        if (!entry.conn || entry.conn.socket.readyState !== WebSocket.OPEN) {
            rankedQueue.delete(entry.sub);
            continue;
        }
        const waitedSec = (now - entry.joinedAt) / 1000;
        if (waitedSec > RANKED_CONFIG.matchmaking.maxQueueSec) {
            rankedQueue.delete(entry.sub);
            entry.conn.rankedQueued = false;
            send(entry.conn, { type: "ranked_queue_timeout" });
            continue;
        }
        send(entry.conn, rankedQueueStatusFor(entry));
    }
    tryMatchRankedQueue();
}, RANKED_TICK_MS);

// ---------------------------------------------------------------------
// LEADERBOARD
//
// Built from the in-memory account cache (the same one the existing
// /leaderboard uses), and -- importantly -- CACHED. Sorting every
// account on every request is the thing requirement 20 warns about, so
// the sorted array is rebuilt at most once every few seconds and only
// the public columns are ever materialised.
// ---------------------------------------------------------------------
const RANKED_LB_TTL_MS = 5000;
let rankedLbCache = { at: 0, rows: [] };

function getRankedLeaderboard() {
    const now = Date.now();
    if (now - rankedLbCache.at < RANKED_LB_TTL_MS) return rankedLbCache.rows;

    const rows = [];
    for (const sub of Object.keys(accounts)) {
        const account = accounts[sub];
        const record = account && account.ranked;
        // Every account is ranked from its first match -- only having
        // actually played one is what keeps an untouched account off
        // the ladder.
        if (!record || typeof record !== "object") continue;
        if (record.season !== RANKED_CONFIG.season) continue;
        if ((record.games || 0) <= 0) continue;
        rows.push({
            sub: sub,
            name: account.name || "Player",
            rp: record.rp || 0,
            wins: record.wins || 0,
            losses: record.losses || 0,
            games: record.games || 0
        });
    }
    // Primary sort RP; ties broken by wins then fewer games, so an
    // identical RP is ordered by who did more with it.
    rows.sort((a, b) => (b.rp - a.rp) || (b.wins - a.wins) || (a.games - b.games));

    rankedLbCache = { at: now, rows: rows };
    return rows;
}

// Invalidates the cache so a just-finished match is reflected promptly
// rather than up to TTL later.
function invalidateRankedLeaderboard() {
    rankedLbCache.at = 0;
}

// =====================================================================
// FRIENDS -- presence, two-sided writes, and real-time events.
//
// PRESENCE: WHY A DEDICATED CONNECTION
// ------------------------------------
// Two facts about the existing architecture decided this design:
//
//   1. The client only opened a WebSocket when ENTERING online/ranked
//      play. A player sitting in the lobby had no socket at all, so
//      presence built purely on the existing connections would have
//      reported almost everybody offline.
//   2. A casual slot (`slots` = {1,2}) is claimed ON CONNECT. If idle
//      lobby players opened a socket just to be visible, they would
//      occupy the two casual slots and break casual matchmaking for
//      the players actually trying to duel.
//
// So a presence connection opts OUT of slot assignment (the client asks
// for it with ?presence=1, see the wss connection handler). It is the
// same WebSocket server, the same protocol and the same message loop --
// not a second networking system -- it simply never takes a slot and
// never participates in the gameplay relay.
//
// Presence is keyed by ACCOUNT and counts connections, because one
// player legitimately has several at once (a presence socket plus a
// gameplay socket, or two tabs). An account is online while it has at
// least one live authenticated connection, so closing one tab does not
// make a player in a match on another tab appear offline.
//
// TRUST: being online is a server fact (there is a live socket this
// server accepted a valid sessionToken on). The finer activity label
// (in a match / in Voidbreak) is reported by the client, but it can
// only ever decorate a connection the server already verified -- a
// client cannot use it to fake being online.
// =====================================================================

const FRIENDS_CONFIG = Friends.FRIENDS_CONFIG;

// sub -> { conns:Set<conn>, activity, since, lastSeen }
const presence = new Map();

function presenceStateOf(sub) {
    const row = presence.get(sub);
    if (!row || row.conns.size === 0) return Friends.PRESENCE.OFFLINE;
    return row.activity || Friends.PRESENCE.ONLINE;
}

// Attaches an authenticated connection to an account's presence.
// Returns true when the account transitioned offline -> online, so the
// caller knows whether to broadcast (and therefore never spams friends
// with an event per tab -- requirement 12).
function presenceAttach(sub, conn) {
    let row = presence.get(sub);
    const wasOffline = !row || row.conns.size === 0;
    if (!row) {
        row = { conns: new Set(), activity: Friends.PRESENCE.ONLINE, since: Date.now(), lastSeen: Date.now() };
        presence.set(sub, row);
    }
    row.conns.add(conn);
    row.lastSeen = Date.now();
    if (wasOffline) {
        row.activity = Friends.PRESENCE.ONLINE;
        row.since = Date.now();
    }
    return wasOffline;
}

// Detaches one connection. Returns true only when the LAST connection
// went away, i.e. the account actually went offline.
function presenceDetach(sub, conn) {
    const row = presence.get(sub);
    if (!row) return false;
    row.conns.delete(conn);
    if (row.conns.size === 0) {
        presence.delete(sub);
        return true;
    }
    return false;
}

// Client-reported activity label. Validated against a fixed list, and
// only ever applied to an account that already has a live connection.
function presenceSetActivity(sub, activity) {
    const row = presence.get(sub);
    if (!row || row.conns.size === 0) return false;
    if (Friends.VALID_ACTIVITIES.indexOf(activity) === -1) return false;
    if (row.activity === activity) return false;
    row.activity = activity;
    row.lastSeen = Date.now();
    return true;
}

// Sends a message to every live connection an account has (all tabs).
function sendToAccount(sub, payload) {
    const row = presence.get(sub);
    if (!row) return;
    for (const conn of row.conns) send(conn, payload);
}

// Tells an account's online friends that something about it changed.
// Only ever sends to CURRENT friends, so this cannot be used to probe
// anyone else's presence.
function broadcastToFriends(sub, payload) {
    const account = accounts[sub];
    if (!account || !Array.isArray(account.friends)) return;
    for (const friendSub of account.friends) {
        if (presenceStateOf(friendSub) !== Friends.PRESENCE.OFFLINE) {
            sendToAccount(friendSub, payload);
        }
    }
}

function presenceEventFor(sub) {
    const account = accounts[sub];
    return {
        type: "friend_presence",
        id: sub,
        name: account ? account.name : "Player",
        presence: presenceStateOf(sub)
    };
}

// ---------------------------------------------------------------------
// MIGRATION -- lazy, idempotent, additive. Mirrors ensureAccountRanked.
// ---------------------------------------------------------------------
function ensureAccountFriends(sub) {
    const account = accounts[sub];
    if (!account) return null;
    const fixed = Friends.ensureFriendsRecord(account);
    if (fixed) {
        // Assign field-by-field so nothing else on the account is touched.
        account.friends = fixed.friends;
        account.incomingFriendRequests = fixed.incomingFriendRequests;
        account.outgoingFriendRequests = fixed.outgoingFriendRequests;
        account.blocked = fixed.blocked;
        persistAccount(sub).catch(e =>
            console.log("[friends] failed to persist migration for " + sub + ":", e.message));
    }
    return account;
}

// ---------------------------------------------------------------------
// TWO-SIDED WRITES
//
// A friendship lives on TWO account records and the store has no
// cross-key transaction, so "write both" needs an explicit failure
// story. applyFriendMutation():
//   1. snapshots both sides' four lists,
//   2. applies the change in memory,
//   3. persists both,
//   4. and on ANY failure restores BOTH snapshots in memory and reports
//      failure -- so a half-written pair never becomes the live state.
//
// A crash between the two writes is still possible (nothing short of a
// real transaction prevents that), which is what reconcileFriendships()
// at boot is for: it repairs one-sided links rather than leaving them
// forever.
// ---------------------------------------------------------------------
const FRIEND_LIST_KEYS = ["friends", "incomingFriendRequests", "outgoingFriendRequests", "blocked"];

function snapshotFriendLists(account) {
    const snap = {};
    for (const key of FRIEND_LIST_KEYS) {
        snap[key] = Array.isArray(account[key]) ? account[key].slice() : [];
    }
    return snap;
}
function restoreFriendLists(account, snap) {
    for (const key of FRIEND_LIST_KEYS) account[key] = snap[key];
}

// `mutate` receives both accounts and edits them in memory. Returns
// { ok:true } or { ok:false, error }.
async function applyFriendMutation(subA, subB, mutate) {
    const a = accounts[subA];
    const b = accounts[subB];
    if (!a || !b) return { ok: false, error: "Player not found" };

    const snapA = snapshotFriendLists(a);
    const snapB = snapshotFriendLists(b);

    mutate(a, b);

    try {
        await persistAccount(subA);
    } catch (e) {
        restoreFriendLists(a, snapA);
        restoreFriendLists(b, snapB);
        console.log("[friends] write failed for " + subA + ", rolled back:", e.message);
        return { ok: false, error: "Could not save -- try again" };
    }

    try {
        await persistAccount(subB);
    } catch (e) {
        // The FIRST write already landed, so rolling back in memory is
        // not enough -- the stored copy of A has to be put back too.
        restoreFriendLists(a, snapA);
        restoreFriendLists(b, snapB);
        try {
            await persistAccount(subA);
        } catch (e2) {
            // Both the write and its compensation failed. Say so loudly
            // rather than pretending it worked; reconcileFriendships()
            // repairs this shape on the next boot.
            console.log("[friends] CRITICAL: could not roll back " + subA +
                " after " + subB + " failed:", e2.message);
        }
        console.log("[friends] write failed for " + subB + ", rolled back:", e.message);
        return { ok: false, error: "Could not save -- try again" };
    }

    return { ok: true };
}

// Boot-time repair for any one-sided link left by a crash mid-write.
// Conservative on purpose: a half-made friendship is DOWNGRADED (the
// dangling side is dropped) rather than completed, because inventing a
// friendship neither player confirmed is worse than losing a request
// they can simply send again.
function reconcileFriendships() {
    let repaired = 0;
    for (const sub of Object.keys(accounts)) {
        const account = accounts[sub];
        const fixed = Friends.ensureFriendsRecord(account);
        if (fixed) {
            account.friends = fixed.friends;
            account.incomingFriendRequests = fixed.incomingFriendRequests;
            account.outgoingFriendRequests = fixed.outgoingFriendRequests;
            account.blocked = fixed.blocked;
            repaired++;
        }
    }

    const dirty = new Set();
    for (const sub of Object.keys(accounts)) {
        const account = accounts[sub];

        // friends must be mutual, and must point at an account that
        // still exists (requirement 18: no broken references).
        const goodFriends = [];
        for (const other of account.friends) {
            const otherAccount = accounts[other];
            if (!otherAccount) { dirty.add(sub); continue; }
            if (Array.isArray(otherAccount.friends) && otherAccount.friends.includes(sub)) {
                goodFriends.push(other);
            } else {
                dirty.add(sub);
            }
        }
        if (goodFriends.length !== account.friends.length) account.friends = goodFriends;

        // An outgoing request must have a matching incoming one.
        const goodOut = [];
        for (const other of account.outgoingFriendRequests) {
            const otherAccount = accounts[other];
            if (otherAccount && Array.isArray(otherAccount.incomingFriendRequests)
                && otherAccount.incomingFriendRequests.includes(sub)) {
                goodOut.push(other);
            } else { dirty.add(sub); }
        }
        if (goodOut.length !== account.outgoingFriendRequests.length) account.outgoingFriendRequests = goodOut;

        const goodIn = [];
        for (const other of account.incomingFriendRequests) {
            const otherAccount = accounts[other];
            if (otherAccount && Array.isArray(otherAccount.outgoingFriendRequests)
                && otherAccount.outgoingFriendRequests.includes(sub)) {
                goodIn.push(other);
            } else { dirty.add(sub); }
        }
        if (goodIn.length !== account.incomingFriendRequests.length) account.incomingFriendRequests = goodIn;
    }

    for (const sub of dirty) {
        persistAccount(sub).catch(e =>
            console.log("[friends] reconcile write failed for " + sub + ":", e.message));
    }
    if (repaired || dirty.size) {
        console.log("[friends] reconcile: " + repaired + " record(s) normalised, " +
            dirty.size + " inconsistent link(s) repaired");
    }
}

// ---------------------------------------------------------------------
// VIEWS
// ---------------------------------------------------------------------
function friendViewOf(sub) {
    const account = accounts[sub];
    if (!account) return null;
    return Friends.publicPlayerView(sub, account, presenceStateOf(sub),
        Ranked.publicRankedView(account));
}

// The whole Friends panel payload in one round trip -- list, both
// request directions, and the counts. Only public fields, and only as
// many account reads as the player actually has relationships.
function friendsPayloadFor(sub) {
    const account = ensureAccountFriends(sub);
    if (!account) return null;

    const friends = Friends.sortFriendViews(
        account.friends.map(friendViewOf).filter(Boolean));
    const incoming = account.incomingFriendRequests.map(friendViewOf).filter(Boolean);
    const outgoing = account.outgoingFriendRequests.map(friendViewOf).filter(Boolean);

    return {
        friends: friends,
        incoming: incoming,
        outgoing: outgoing,
        counts: {
            friends: friends.length,
            incoming: incoming.length,
            outgoing: outgoing.length,
            maxFriends: FRIENDS_CONFIG.maxFriends
        }
    };
}

// Pushes a fresh payload to an account's live connections. Used after
// any change so every open tab converges without a refresh.
function pushFriendsUpdate(sub, reason, extra) {
    if (presenceStateOf(sub) === Friends.PRESENCE.OFFLINE) return;
    const payload = friendsPayloadFor(sub);
    if (!payload) return;
    sendToAccount(sub, Object.assign({
        type: "friends_update",
        reason: reason || "change",
        friends: payload.friends,
        incoming: payload.incoming,
        outgoing: payload.outgoing,
        counts: payload.counts
    }, extra || {}));
}

// ---------------------------------------------------------------------
// SEARCH -- server-side, public fields only, capped.
// ---------------------------------------------------------------------
function searchPlayers(query, viewerSub) {
    const q = String(query || "").trim().toLowerCase();
    if (q.length < FRIENDS_CONFIG.searchMinChars) return [];

    const viewer = accounts[viewerSub];
    const results = [];

    for (const sub of Object.keys(accounts)) {
        if (sub === viewerSub) continue; // never offer yourself
        const account = accounts[sub];
        const name = (account.name || "").toLowerCase();
        // Name match only. Searching by raw account id is deliberately
        // NOT supported: it would turn this into an id-confirmation
        // oracle, and ids are not something players see anyway.
        if (!name.includes(q)) continue;
        // Blocking (either direction) hides the player entirely.
        if (viewer && (Friends.isBlocked(viewer, sub) || Friends.isBlocked(account, viewerSub))) continue;

        const view = friendViewOf(sub);
        if (!view) continue;
        // Tell the client what it can offer, so it doesn't render an
        // ADD button that the server would only reject.
        view.relation = !viewer ? "none"
            : Friends.isFriend(viewer, sub) ? "friends"
            : Friends.hasOutgoingRequest(viewer, sub) ? "requested"
            : Friends.hasIncomingRequest(viewer, sub) ? "incoming"
            : "none";
        results.push(view);
        if (results.length >= FRIENDS_CONFIG.searchMaxResults) break;
    }

    // Exact name matches first, then alphabetical -- so searching a full
    // name puts that player at the top.
    results.sort((a, b) => {
        const ax = a.name.toLowerCase() === q ? 0 : 1;
        const bx = b.name.toLowerCase() === q ? 0 : 1;
        if (ax !== bx) return ax - bx;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return results;
}

// ---------------------------------------------------------------------
// OPERATIONS -- each one authenticates, validates, writes BOTH sides,
// and notifies both players' live connections.
// ---------------------------------------------------------------------

async function sendFriendRequest(fromSub, toSub) {
    const fromAccount = ensureAccountFriends(fromSub);
    const toAccount = accounts[toSub] ? ensureAccountFriends(toSub) : null;

    const verdict = Friends.canSendRequest(fromSub, toSub, fromAccount, toAccount, FRIENDS_CONFIG);

    // Simultaneous requests: they already asked us, so the correct
    // outcome is ONE friendship, not a second mirrored request.
    if (!verdict.ok && verdict.code === "reciprocal") {
        return acceptFriendRequest(fromSub, toSub);
    }
    if (!verdict.ok) return { ok: false, code: verdict.code, error: verdict.message };

    const result = await applyFriendMutation(fromSub, toSub, (a, b) => {
        a.outgoingFriendRequests = Friends.withValue(a.outgoingFriendRequests, toSub);
        b.incomingFriendRequests = Friends.withValue(b.incomingFriendRequests, fromSub);
    });
    if (!result.ok) return { ok: false, code: "storage", error: result.error };

    pushFriendsUpdate(fromSub, "requestSent");
    pushFriendsUpdate(toSub, "requestReceived", {
        notice: { kind: "requestReceived", from: friendViewOf(fromSub) }
    });
    return { ok: true, action: "requested" };
}

async function acceptFriendRequest(sub, fromSub) {
    const account = ensureAccountFriends(sub);
    const other = accounts[fromSub] ? ensureAccountFriends(fromSub) : null;
    if (!other) return { ok: false, code: "notFound", error: "Player not found" };

    // Already friends -> succeed idempotently rather than duplicating.
    if (Friends.isFriend(account, fromSub) && Friends.isFriend(other, sub)) {
        return { ok: true, action: "alreadyFriends" };
    }
    if (!Friends.hasIncomingRequest(account, fromSub)) {
        return { ok: false, code: "noRequest", error: "No pending request from that player" };
    }
    if ((account.friends || []).length >= FRIENDS_CONFIG.maxFriends) {
        return { ok: false, code: "full", error: "Friend list full" };
    }
    if ((other.friends || []).length >= FRIENDS_CONFIG.maxFriends) {
        return { ok: false, code: "targetFull", error: "That player's friend list is full" };
    }

    const result = await applyFriendMutation(sub, fromSub, (me, them) => {
        me.incomingFriendRequests = Friends.without(me.incomingFriendRequests, fromSub);
        me.outgoingFriendRequests = Friends.without(me.outgoingFriendRequests, fromSub);
        them.outgoingFriendRequests = Friends.without(them.outgoingFriendRequests, sub);
        them.incomingFriendRequests = Friends.without(them.incomingFriendRequests, sub);
        me.friends = Friends.withValue(me.friends, fromSub);
        them.friends = Friends.withValue(them.friends, sub);
    });
    if (!result.ok) return { ok: false, code: "storage", error: result.error };

    pushFriendsUpdate(sub, "requestAccepted");
    pushFriendsUpdate(fromSub, "requestAccepted", {
        notice: { kind: "requestAccepted", from: friendViewOf(sub) }
    });
    return { ok: true, action: "accepted" };
}

async function declineFriendRequest(sub, fromSub) {
    const account = ensureAccountFriends(sub);
    const other = accounts[fromSub] ? ensureAccountFriends(fromSub) : null;
    if (!other) {
        // Their account is gone -- still clear our dangling entry.
        if (Friends.hasIncomingRequest(account, fromSub)) {
            account.incomingFriendRequests = Friends.without(account.incomingFriendRequests, fromSub);
            await persistAccount(sub).catch(() => {});
            pushFriendsUpdate(sub, "requestDeclined");
        }
        return { ok: true, action: "declined" };
    }
    if (!Friends.hasIncomingRequest(account, fromSub)) {
        return { ok: true, action: "noRequest" }; // idempotent
    }

    const result = await applyFriendMutation(sub, fromSub, (me, them) => {
        me.incomingFriendRequests = Friends.without(me.incomingFriendRequests, fromSub);
        them.outgoingFriendRequests = Friends.without(them.outgoingFriendRequests, sub);
    });
    if (!result.ok) return { ok: false, code: "storage", error: result.error };

    pushFriendsUpdate(sub, "requestDeclined");
    pushFriendsUpdate(fromSub, "requestDeclined");
    return { ok: true, action: "declined" };
}

// Withdraw a request WE sent.
async function cancelFriendRequest(sub, toSub) {
    const account = ensureAccountFriends(sub);
    const other = accounts[toSub] ? ensureAccountFriends(toSub) : null;
    if (!Friends.hasOutgoingRequest(account, toSub)) return { ok: true, action: "noRequest" };
    if (!other) {
        account.outgoingFriendRequests = Friends.without(account.outgoingFriendRequests, toSub);
        await persistAccount(sub).catch(() => {});
        pushFriendsUpdate(sub, "requestCancelled");
        return { ok: true, action: "cancelled" };
    }

    const result = await applyFriendMutation(sub, toSub, (me, them) => {
        me.outgoingFriendRequests = Friends.without(me.outgoingFriendRequests, toSub);
        them.incomingFriendRequests = Friends.without(them.incomingFriendRequests, sub);
    });
    if (!result.ok) return { ok: false, code: "storage", error: result.error };

    pushFriendsUpdate(sub, "requestCancelled");
    pushFriendsUpdate(toSub, "requestCancelled");
    return { ok: true, action: "cancelled" };
}

async function removeFriend(sub, otherSub) {
    const account = ensureAccountFriends(sub);
    const other = accounts[otherSub] ? ensureAccountFriends(otherSub) : null;

    if (!other) {
        // Dangling reference to a deleted account -- clean our side only.
        if (Friends.isFriend(account, otherSub)) {
            account.friends = Friends.without(account.friends, otherSub);
            await persistAccount(sub).catch(() => {});
            pushFriendsUpdate(sub, "friendRemoved");
        }
        return { ok: true, action: "removed" };
    }
    // Not friends (already removed) -> idempotent success, and never
    // touches anyone else's list.
    if (!Friends.isFriend(account, otherSub) && !Friends.isFriend(other, sub)) {
        return { ok: true, action: "notFriends" };
    }

    const result = await applyFriendMutation(sub, otherSub, (me, them) => {
        me.friends = Friends.without(me.friends, otherSub);
        them.friends = Friends.without(them.friends, sub);
    });
    if (!result.ok) return { ok: false, code: "storage", error: result.error };

    pushFriendsUpdate(sub, "friendRemoved");
    pushFriendsUpdate(otherSub, "friendRemoved", {
        notice: { kind: "friendRemoved" }
    });
    return { ok: true, action: "removed" };
}

// A friend's public profile. Gated on an ACTUAL friendship (or self) --
// being able to name someone is not enough to read their profile.
function getFriendProfile(viewerSub, targetSub) {
    const viewer = ensureAccountFriends(viewerSub);
    const target = accounts[targetSub];
    if (!target) return { ok: false, error: "Player not found" };

    const isSelf = viewerSub === targetSub;
    if (!isSelf && !Friends.isFriend(viewer, targetSub)) {
        return { ok: false, error: "You can only view a friend's profile" };
    }
    return {
        ok: true,
        profile: Friends.publicProfileView(targetSub, target, presenceStateOf(targetSub),
            Ranked.publicRankedView(target))
    };
}

// ---------------------------------------------------------------------
// MATCH INVITES
//
// Deliberately minimal and honest. The existing casual online lobby is
// ONE global 2-slot room -- there is no room/code system to direct two
// specific players into, so an invite cannot reserve a private match.
// What this does is real and useful: it delivers a genuine invite over
// the live connection, and on accept tells BOTH clients to open the
// existing online lobby. It never claims to have matched them privately.
// ---------------------------------------------------------------------
const pendingInvites = new Map(); // inviteId -> {from, to, at}
const INVITE_TTL_MS = 60 * 1000;

function inviteFriend(fromSub, toSub) {
    const fromAccount = ensureAccountFriends(fromSub);
    if (!Friends.isFriend(fromAccount, toSub)) {
        return { ok: false, error: "You can only invite friends" };
    }
    if (presenceStateOf(toSub) === Friends.PRESENCE.OFFLINE) {
        return { ok: false, error: "That friend is offline" };
    }
    const inviteId = crypto.randomBytes(8).toString("hex");
    pendingInvites.set(inviteId, { from: fromSub, to: toSub, at: Date.now() });

    sendToAccount(toSub, {
        type: "friend_invite",
        inviteId: inviteId,
        from: friendViewOf(fromSub),
        expiresInSec: Math.round(INVITE_TTL_MS / 1000)
    });
    return { ok: true, inviteId: inviteId };
}

function respondToInvite(sub, inviteId, accept) {
    const invite = pendingInvites.get(inviteId);
    if (!invite) return { ok: false, error: "Invite expired" };
    // Only the invited account may answer it.
    if (invite.to !== sub) return { ok: false, error: "Not your invite" };
    pendingInvites.delete(inviteId);

    if (!accept) {
        sendToAccount(invite.from, {
            type: "friend_invite_declined", by: friendViewOf(sub)
        });
        return { ok: true, accepted: false };
    }
    // Both sides are told to head for the existing online lobby. The
    // lobby itself is unchanged -- this is a nudge, not a new matchmaker.
    const payload = kind => ({
        type: "friend_invite_accepted",
        with: friendViewOf(kind === "from" ? invite.to : invite.from)
    });
    sendToAccount(invite.from, payload("from"));
    sendToAccount(invite.to, payload("to"));
    return { ok: true, accepted: true };
}

// Housekeeping: expire invites and sweep presence rows whose sockets
// died without a close event.
setInterval(() => {
    const now = Date.now();
    for (const [id, invite] of Array.from(pendingInvites.entries())) {
        if (now - invite.at > INVITE_TTL_MS) pendingInvites.delete(id);
    }
    for (const [sub, row] of Array.from(presence.entries())) {
        for (const conn of Array.from(row.conns)) {
            if (!conn.socket || conn.socket.readyState !== WebSocket.OPEN) row.conns.delete(conn);
        }
        if (row.conns.size === 0) {
            presence.delete(sub);
            broadcastToFriends(sub, presenceEventFor(sub));
        }
    }
}, 15000);

// =====================================================================
// ADMIN ACTION LOG -- most recent 100 balance changes, newest first.
// =====================================================================
const ADMIN_LOG_SEED_FILE = path.join(__dirname, "adminLog.json");

async function loadAdminLog() {
    const stored = await store.loadDoc("adminLog", null);
    if (Array.isArray(stored)) return stored;
    // Nothing stored yet -- seed from the file committed to the repo so
    // the existing audit trail carries over on first boot.
    try {
        const seed = JSON.parse(fs.readFileSync(ADMIN_LOG_SEED_FILE, "utf8"));
        return Array.isArray(seed) ? seed : [];
    } catch (e) {
        return [];
    }
}

function persistAdminLog() {
    store.saveDoc("adminLog", adminLog)
        .catch(e => console.log("[storage] failed to save adminLog:", e.message));
}

let adminLog = []; // replaced in startServer()

// Shared by every admin action (ability balance changes and credit
// grants alike) -- the single audit trail, newest first, capped at 100
// and persisted to the same adminLog.json every time.
function pushAdminLog(entry) {
    adminLog.unshift(Object.assign({ time: Date.now() }, entry));
    if (adminLog.length > 100) adminLog.length = 100;
    persistAdminLog();
}

function logAdminAction(account, abilityId, changes, actionType) {
    if ((!changes || !changes.length) && actionType !== "resetAll") return; // no-op, nothing to log
    pushAdminLog({
        admin: account ? account.name : "unknown",
        abilityId: abilityId,
        type: actionType || "save",
        changes: changes || []
    });
}

// =====================================================================
// ADMIN CREDIT GRANTS
// =====================================================================
// Sanity ceiling on a single manual grant -- not a game-balance number,
// just a guard against a fat-fingered or malicious "give 999999999"
// request. Well above anything a legitimate grant would ever need.
const MAX_CREDIT_GRANT = 1000000;

// True only for a whole number in (0, MAX_CREDIT_GRANT] -- rejects
// negative, zero, decimal, NaN/Infinity, non-numeric, and absurdly
// large amounts. The browser's own input validation is just UX; this
// is what actually decides whether a grant is allowed.
function isValidCreditAmount(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 && n <= MAX_CREDIT_GRANT;
}

// =====================================================================
// STATIC FILE SERVING
// Serves index.html, bgm.mp3, and anything else sitting next to
// server.js. Google Sign-In requires a real http(s) origin -- it will
// not work if index.html is just double-clicked as a local file. Both
// players should visit http://<this computer's IP>:3000 instead.
// =====================================================================
const MIME_TYPES = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".json": "application/json"
};

function serveStatic(req, res) {
    let urlPath = req.url.split("?")[0];
    if (urlPath === "/") urlPath = "/index.html";

    const filePath = path.join(__dirname, decodeURIComponent(urlPath));

    // Basic safety: never serve a file outside this folder.
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not found: " + urlPath);
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        res.end(data);
    });
}

// =====================================================================
// HTTP SERVER (REST endpoints + serving the page/assets). The WebSocket
// relay attaches to this same server further down, so it's all one
// process on one port.
// =====================================================================
const httpServer = http.createServer(async (req, res) => {

    // Network diagnostics, only mounted when DEBUG_NETWORKING=1 -- a
    // production instance 404s this exactly like any unknown path.
    if (DEBUG_NETWORKING && req.method === "GET" && req.url === "/__net/stats") {
        sendJson(res, 200, netSnapshot());
        return;
    }

    if (req.method === "OPTIONS") {
        sendJson(res, 200, {});
        return;
    }

    // ---- POST /auth/google ----
    // body: { credential } (the ID token JWT from Google Identity Services)
    if (req.method === "POST" && req.url === "/auth/google") {
        try {
            const body = await readJsonBody(req);
            const info = await verifyGoogleToken(body.credential);
            const sub = info.sub;

            let dirty = false;
            if (!accounts[sub]) {
                accounts[sub] = defaultAccount(info.name || info.email || "Player", info.email || "");
                dirty = true;
            } else if (accounts[sub].email !== (info.email || "")) {
                // Keep the stored email current -- this is what admin
                // verification checks against, so it must stay accurate.
                accounts[sub].email = info.email || "";
                dirty = true;
            }
            // Rolls a stale (or pre-feature) dailyChallenges to a fresh
            // set for today -- this is the "player was offline across a
            // reset, or this account predates the feature" self-heal.
            const rolledDC = ensureDailyChallenges(accounts[sub].dailyChallenges);
            if (rolledDC !== accounts[sub].dailyChallenges) {
                accounts[sub].dailyChallenges = rolledDC;
                dirty = true;
            }
            // Lazily migrates a pre-XP-feature (or otherwise malformed)
            // account to xp:0/level:1 -- never touches an account that
            // already has valid XP. ensureAccountXP persists on its own
            // if it changed anything, so it's not folded into `dirty`.
            ensureAccountXP(sub);
            // Same lazy migration for a pre-tutorial-feature account --
            // an EXISTING player who predates this field must never be
            // treated as "not yet completed" by omission (that would
            // just re-offer them a tutorial they never needed); explicit
            // false is only ever set once, here, and only if the field
            // is genuinely missing.
            if (typeof accounts[sub].tutorialComplete !== "boolean") {
                accounts[sub].tutorialComplete = true;
                dirty = true;
            }
            if (dirty) await persistAccount(sub);

            const sessionToken = crypto.randomBytes(24).toString("hex");
            await persistSession(sessionToken, sub);

            sendJson(res, 200, {
                sessionToken: sessionToken,
                account: accounts[sub],
                isAdmin: isAdminSession(sessionToken)
            });
        } catch (e) {
            console.log("Google sign-in failed:", e.message);
            sendJson(res, 401, { error: "Google sign-in failed" });
        }
        return;
    }

    // ---- POST /save ----
    if (req.method === "POST" && req.url === "/save") {
        try {
            const body = await readJsonBody(req);
            const sub = sessions[body.sessionToken];
            if (!sub) {
                sendJson(res, 401, { error: "Not signed in" });
                return;
            }
            // A live session must map to a real stored account. If it
            // doesn't, something is wrong upstream -- refuse rather than
            // manufacture a default account, which would replace real
            // progress with 100 credits / 0 kills.
            const existing = accounts[sub];
            if (!existing) {
                sendJson(res, 409, { error: "Account not loaded -- sign in again" });
                return;
            }

            // Accepts a client-supplied counter only if it's a real,
            // non-negative, finite whole number; anything else (NaN,
            // Infinity, negative, a string) keeps the stored value rather
            // than corrupting the account.
            const safeCount = (incoming, current) =>
                (typeof incoming === "number" && isFinite(incoming) && incoming >= 0)
                    ? Math.floor(incoming) : current;

            // Same client-authoritative trust level as kills/wins/credits
            // above -- see the DAILY CHALLENGES comment block for why
            // that's an accepted tradeoff here, not a new one. Rolls to a
            // fresh {progress:0, claimed:{}} first if the stored record is
            // missing or from an earlier day, THEN merges in today's
            // progress if the client sent any -- so a stale/offline
            // account always ends up in a valid state for today even if
            // the client has nothing to report yet.
            const dc = ensureDailyChallenges(existing.dailyChallenges);
            let dailyProgress = dc.progress;
            const incomingDC = body.dailyChallengeProgress;
            if (incomingDC && typeof incomingDC === "object" && incomingDC.date === dc.date) {
                dailyProgress = {
                    kills: safeCount(incomingDC.kills, dc.progress.kills),
                    wins: safeCount(incomingDC.wins, dc.progress.wins),
                    matches: safeCount(incomingDC.matches, dc.progress.matches)
                };
            }
            const newDailyChallenges = { date: dc.date, progress: dailyProgress, claimed: dc.claimed };

            accounts[sub] = {
                name: existing.name,
                email: existing.email || "",
                credits: safeCount(body.credits, existing.credits),
                kills: safeCount(body.kills, existing.kills),
                wins: safeCount(body.wins, existing.wins),
                ownedSkins: Array.isArray(body.ownedSkins) ? body.ownedSkins : existing.ownedSkins,
                ownedPowers: Array.isArray(body.ownedPowers) ? body.ownedPowers : existing.ownedPowers,
                equippedPowers: Array.isArray(body.equippedPowers) ? body.equippedPowers : existing.equippedPowers,
                equippedPowersP2: Array.isArray(body.equippedPowersP2) ? body.equippedPowersP2 : (existing.equippedPowersP2 || []),
                ownedAbilities: Array.isArray(body.ownedAbilities) ? body.ownedAbilities : (existing.ownedAbilities || []),
                equippedAbilities: Array.isArray(body.equippedAbilities) ? body.equippedAbilities : (existing.equippedAbilities || []),
                equippedAbilitiesP2: Array.isArray(body.equippedAbilitiesP2) ? body.equippedAbilitiesP2 : (existing.equippedAbilitiesP2 || []),
                p1SkinId: body.p1SkinId || existing.p1SkinId,
                p2SkinId: body.p2SkinId || existing.p2SkinId,
                autoAimP1: typeof body.autoAimP1 === "boolean" ? body.autoAimP1 : (existing.autoAimP1 || false),
                autoAimP2: typeof body.autoAimP2 === "boolean" ? body.autoAimP2 : (existing.autoAimP2 || false),
                aimMode: (body.aimMode === "mouse" || body.aimMode === "movement") ? body.aimMode : (existing.aimMode || "movement"),
                matchSize: [2, 3, 4].includes(body.matchSize) ? body.matchSize : (existing.matchSize || 2),
                deviceMode: ["auto", "iphone", "ipad", "computer"].includes(body.deviceMode) ? body.deviceMode : (existing.deviceMode || "auto"),
                // XP/LEVEL ARE DELIBERATELY NOT READ FROM `body`, for the
                // exact same reason ranked/friends aren't: this handler
                // rebuilds the account field-by-field, so xp/level MUST be
                // carried forward from the stored record or a plain /save
                // (which every match already triggers, via saveProgress())
                // would silently wipe them. A client POSTing {xp:999999}
                // here has no effect whatsoever -- xp only ever changes
                // inside awardXP(), never here.
                xp: typeof existing.xp === "number" ? existing.xp : 0,
                level: typeof existing.level === "number" ? existing.level : 1,
                // Non-sensitive UX state (no credits/XP/rank riding on
                // it), same trust tier as aimMode/matchSize/deviceMode
                // above -- client-reported is fine here, unlike xp/level.
                tutorialComplete: typeof body.tutorialComplete === "boolean" ? body.tutorialComplete : (existing.tutorialComplete || false),
                dailyChallenges: newDailyChallenges,
                // RANKED IS DELIBERATELY NOT READ FROM `body`.
                //
                // This handler rebuilds the account field-by-field, so a
                // field that isn't carried over here is destroyed on the
                // next save. Ranked therefore has to be carried -- but
                // ONLY from the stored record, never from the request.
                //
                // That is also exactly what makes ranked tamper-proof
                // against this endpoint: kills/wins/credits above are
                // client-authoritative by existing design, but RP, rank,
                // ranked W/L and placement state can only ever be changed
                // by the server's own match pipeline (completeRankedMatch).
                // A client POSTing {ranked:{rp:99999}} here has no effect
                // whatsoever.
                ranked: Ranked.ensureRankedRecord(existing),
                // FRIEND LISTS ARE DELIBERATELY NOT READ FROM `body`.
                //
                // Exactly the same reasoning as `ranked` above: this
                // handler rebuilds the account field-by-field, so these
                // MUST be carried or they would be wiped on the next
                // save -- but only ever from the STORED record, never
                // from the request. A client POSTing
                // {friends:["someone"]} here has no effect at all;
                // friendships can only be created by the server's own
                // request/accept pipeline, which writes both sides.
                friends: Array.isArray(existing.friends) ? existing.friends : [],
                incomingFriendRequests: Array.isArray(existing.incomingFriendRequests) ? existing.incomingFriendRequests : [],
                outgoingFriendRequests: Array.isArray(existing.outgoingFriendRequests) ? existing.outgoingFriendRequests : [],
                blocked: Array.isArray(existing.blocked) ? existing.blocked : []
            };
            try {
                await persistAccount(sub);
            } catch (e) {
                // The write failed, so the cache no longer reflects the
                // store. Put the previous record back and tell the client
                // the save did not happen.
                accounts[sub] = existing;
                sendJson(res, 503, { error: "Could not save progress -- try again" });
                return;
            }
            sendJson(res, 200, { ok: true });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- GET /challenges/today?sessionToken=... (sessionToken optional) ----
    // Today's 3 challenges are the same for every player, so this needs
    // no auth to list them. If a valid sessionToken IS given, the
    // response also includes that account's own progress/claimed state
    // for today -- rolling it to a fresh day first if it was stale, so a
    // player returning after being offline across a reset (or a server
    // restart) sees a correctly-zeroed board the moment they open the
    // panel, not just the next time they happen to /save.
    if (req.method === "GET" && req.url.startsWith("/challenges/today")) {
        const urlObj = new URL(req.url, "http://x");
        const today = todayUTC();
        const defs = getDailyChallenges(today);
        const sessionToken = urlObj.searchParams.get("sessionToken");
        const sub = sessionToken ? sessions[sessionToken] : null;
        const account = sub ? accounts[sub] : null;

        let progress = { kills: 0, wins: 0, matches: 0 };
        let claimed = {};
        if (account) {
            const dc = ensureDailyChallenges(account.dailyChallenges);
            if (dc !== account.dailyChallenges) {
                account.dailyChallenges = dc;
                // Opportunistic self-heal write -- doesn't block or fail
                // the response either way; worst case it just re-rolls
                // (idempotently) again on the next request.
                persistAccount(sub).catch(e =>
                    console.log("[storage] failed to persist rolled dailyChallenges:", e.message));
            }
            progress = dc.progress;
            claimed = dc.claimed;
        }

        sendJson(res, 200, {
            date: today,
            challenges: defs.map(d => ({
                id: d.id, name: d.name, desc: d.desc,
                category: d.category, target: d.target, reward: d.reward
            })),
            progress: progress,
            claimed: claimed
        });
        return;
    }

    // ---- POST /challenges/claim ----
    // body: { sessionToken, challengeId }
    // Server-authoritative reward grant: independently recomputes TODAY's
    // canonical challenge set (never trusts a client-sent definition),
    // checks the account's own stored progress against it, checks the
    // claimed flag, and credits the server's own copy of the reward --
    // never a client-supplied amount. Mirrors /admin/credits' atomic
    // read-modify-write-then-persist shape, with the same rollback on a
    // failed write.
    if (req.method === "POST" && req.url === "/challenges/claim") {
        try {
            const body = await readJsonBody(req);
            const sub = sessions[body.sessionToken];
            if (!sub) {
                sendJson(res, 401, { error: "Not signed in" });
                return;
            }
            const target = accounts[sub];
            if (!target) {
                sendJson(res, 409, { error: "Account not loaded -- sign in again" });
                return;
            }

            const today = todayUTC();
            const dc = ensureDailyChallenges(target.dailyChallenges);
            const def = getDailyChallenges(today).find(c => c.id === body.challengeId);
            if (!def) {
                sendJson(res, 400, { error: "Not one of today's challenges" });
                return;
            }
            if (dc.claimed[body.challengeId]) {
                sendJson(res, 409, { error: "Already claimed" });
                return;
            }
            const have = dc.progress[def.category] || 0;
            if (have < def.target) {
                sendJson(res, 400, { error: "Challenge not complete yet" });
                return;
            }

            const previousBalance = target.credits || 0;
            const previousDC = target.dailyChallenges;
            target.credits = previousBalance + def.reward; // atomic increment, not a client-supplied total
            target.dailyChallenges = {
                date: dc.date,
                progress: dc.progress,
                claimed: Object.assign({}, dc.claimed, { [body.challengeId]: true })
            };
            try {
                await persistAccount(sub);
            } catch (e) {
                target.credits = previousBalance; // write failed -- undo the in-memory grant
                target.dailyChallenges = previousDC;
                sendJson(res, 503, { error: "Could not save reward -- try again" });
                return;
            }

            sendJson(res, 200, {
                ok: true,
                challengeId: body.challengeId,
                reward: def.reward,
                newBalance: target.credits,
                dailyChallenges: target.dailyChallenges
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- POST /xp/report ----
    // body: { sessionToken, reason, kills? }
    // The client-report half of the XP system -- see the big comment
    // above XP_REWARDS/lastXPReportAt for the trust model. `reason` must
    // be one of a fixed whitelist; the XP amount always comes from
    // XP_REWARDS, never from the request. `kills` (only meaningful for
    // reason:"kill") is clamped to XP_MAX_KILLS_PER_REPORT so one report
    // can't claim an arbitrary kill count.
    if (req.method === "POST" && req.url === "/xp/report") {
        try {
            const body = await readJsonBody(req);
            const sub = sessions[body.sessionToken];
            if (!sub) {
                sendJson(res, 401, { error: "Not signed in" });
                return;
            }
            if (!accounts[sub]) {
                sendJson(res, 409, { error: "Account not loaded -- sign in again" });
                return;
            }
            const reason = body.reason;
            if (!Object.prototype.hasOwnProperty.call(XP_REWARDS, reason)) {
                sendJson(res, 400, { error: "Unknown XP reason" });
                return;
            }
            // Heist/Bomb Run/Ranked wins are awarded server-side at the
            // moment the server itself confirms them -- never via this
            // client-facing endpoint, so a forged report can't double it.
            if (reason === "heist_win" || reason === "bombrun_win" || reason === "ranked_win" || reason === "ranked_loss") {
                sendJson(res, 400, { error: "This reward is granted automatically" });
                return;
            }
            if (xpReportThrottled(sub, reason)) {
                sendJson(res, 429, { error: "Too soon" });
                return;
            }

            let amount = XP_REWARDS[reason];
            if (reason === "kill") {
                const n = Math.max(1, Math.min(XP_MAX_KILLS_PER_REPORT, Math.floor(body.kills) || 1));
                amount = XP_REWARDS.kill * n;
            }

            const result = await awardXP(sub, amount, reason);
            if (!result) {
                sendJson(res, 503, { error: "Could not save XP -- try again" });
                return;
            }
            sendJson(res, 200, Object.assign({ ok: true }, result));
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- POST /account/username ----
    // body: { sessionToken, username }
    // Server-side validated username change. Reuses the account's
    // existing `name` field (the same one shown everywhere the account's
    // display name already appears) rather than adding a second field --
    // there's no architectural reason to keep them separate, and doing
    // so would just create two sources of truth for "what is this
    // player called".
    if (req.method === "POST" && req.url === "/account/username") {
        try {
            const body = await readJsonBody(req);
            const sub = sessions[body.sessionToken];
            if (!sub) {
                sendJson(res, 401, { error: "Not signed in" });
                return;
            }
            const target = accounts[sub];
            if (!target) {
                sendJson(res, 409, { error: "Account not loaded -- sign in again" });
                return;
            }

            const validation = validateUsername(body.username);
            if (!validation.ok) {
                sendJson(res, 400, { error: validation.error });
                return;
            }

            const previousName = target.name;
            target.name = validation.name;
            try {
                await persistAccount(sub);
            } catch (e) {
                target.name = previousName;
                sendJson(res, 503, { error: "Could not save username -- try again" });
                return;
            }

            sendJson(res, 200, { ok: true, name: target.name });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- GET /leaderboard?sort=credits|kills|wins ----
    if (req.method === "GET" && req.url.startsWith("/leaderboard")) {
        const urlObj = new URL(req.url, "http://x");
        const sortKey = ["credits", "kills", "wins"].includes(urlObj.searchParams.get("sort"))
            ? urlObj.searchParams.get("sort") : "credits";

        const entries = Object.values(accounts)
            .map(a => ({ name: a.name, credits: a.credits, kills: a.kills, wins: a.wins }))
            .sort((a, b) => b[sortKey] - a[sortKey])
            .slice(0, 20);

        sendJson(res, 200, { sort: sortKey, entries: entries });
        return;
    }

    // =================================================================
    // FRIENDS ENDPOINTS
    //
    // Every one of them resolves the caller from their sessionToken
    // server-side. The client never states who it is, and no handler
    // accepts a caller-supplied "my id" -- the acting account is always
    // sessions[token]. That is what makes it impossible to act as
    // somebody else by editing a request body.
    // =================================================================

    // ---- GET /friends?sessionToken=... ----
    if (req.method === "GET" && req.url.startsWith("/friends/list")) {
        const urlObj = new URL(req.url, "http://x");
        const sub = sessions[urlObj.searchParams.get("sessionToken")];
        if (!sub || !accounts[sub]) {
            sendJson(res, 401, { error: "Not signed in" });
            return;
        }
        const payload = friendsPayloadFor(sub);
        sendJson(res, 200, payload);
        return;
    }

    // ---- GET /friends/search?sessionToken=...&q=... ----
    // Server-side search. Returns at most searchMaxResults public views;
    // the browser never receives the account store.
    if (req.method === "GET" && req.url.startsWith("/friends/search")) {
        const urlObj = new URL(req.url, "http://x");
        const sub = sessions[urlObj.searchParams.get("sessionToken")];
        if (!sub || !accounts[sub]) {
            sendJson(res, 401, { error: "Not signed in" });
            return;
        }
        const q = urlObj.searchParams.get("q") || "";
        if (q.trim().length < FRIENDS_CONFIG.searchMinChars) {
            sendJson(res, 200, { results: [] });
            return;
        }
        sendJson(res, 200, { results: searchPlayers(q, sub) });
        return;
    }

    // ---- GET /friends/profile?sessionToken=...&id=... ----
    if (req.method === "GET" && req.url.startsWith("/friends/profile")) {
        const urlObj = new URL(req.url, "http://x");
        const sub = sessions[urlObj.searchParams.get("sessionToken")];
        if (!sub || !accounts[sub]) {
            sendJson(res, 401, { error: "Not signed in" });
            return;
        }
        const result = getFriendProfile(sub, urlObj.searchParams.get("id"));
        sendJson(res, result.ok ? 200 : 403, result.ok ? result : { error: result.error });
        return;
    }

    // ---- POST /friends/action ----
    // body: { sessionToken, action, id }
    // One authenticated entry point for every mutation, so the auth and
    // validation cannot drift between them.
    if (req.method === "POST" && req.url === "/friends/action") {
        try {
            const body = await readJsonBody(req);
            const sub = sessions[body.sessionToken];
            if (!sub || !accounts[sub]) {
                sendJson(res, 401, { error: "Not signed in" });
                return;
            }
            const targetId = typeof body.id === "string" ? body.id : "";
            if (!targetId) {
                sendJson(res, 400, { error: "Missing player id" });
                return;
            }

            let result;
            switch (body.action) {
                case "request": result = await sendFriendRequest(sub, targetId); break;
                case "accept":  result = await acceptFriendRequest(sub, targetId); break;
                case "decline": result = await declineFriendRequest(sub, targetId); break;
                case "cancel":  result = await cancelFriendRequest(sub, targetId); break;
                case "remove":  result = await removeFriend(sub, targetId); break;
                case "invite":  result = inviteFriend(sub, targetId); break;
                default:
                    sendJson(res, 400, { error: "Unknown action" });
                    return;
            }

            if (!result.ok) {
                // 409 for "the request is understood but the current
                // state forbids it" (already friends, self, full...),
                // which the UI turns into a friendly message.
                sendJson(res, result.code === "storage" ? 503 : 409,
                    { error: result.error, code: result.code });
                return;
            }
            sendJson(res, 200, Object.assign({ ok: true }, result, friendsPayloadFor(sub)));
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- GET /ranked/me?sessionToken=... ----
    // The signed-in player's own ranked profile. Requires auth because
    // it's the player's own record; returns only publicRankedView (no
    // email, no opponent identities).
    if (req.method === "GET" && req.url.startsWith("/ranked/me")) {
        const urlObj = new URL(req.url, "http://x");
        const sub = sessions[urlObj.searchParams.get("sessionToken")];
        if (!sub || !accounts[sub]) {
            sendJson(res, 401, { error: "Not signed in" });
            return;
        }
        ensureAccountRanked(sub);

        // The player's own ladder position, computed from the same
        // cached, sorted array the leaderboard uses.
        const rows = getRankedLeaderboard();
        let position = null;
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].sub === sub) { position = i + 1; break; }
        }

        sendJson(res, 200, {
            ranked: Ranked.publicRankedView(accounts[sub]),
            position: position,
            config: {
                season: RANKED_CONFIG.season,
                seasonName: RANKED_CONFIG.seasonName,
                placementGames: RANKED_CONFIG.placementGames,
                winRP: RANKED_CONFIG.winRP,
                lossRP: RANKED_CONFIG.lossRP,
                roundsToWin: RANKED_CONFIG.roundsToWin,
                tiers: Ranked.RANK_TIERS.map(t => ({
                    id: t.id, name: t.name, min: t.min,
                    max: t.max === Infinity ? null : t.max, color: t.color
                }))
            }
        });
        return;
    }

    // ---- GET /ranked/leaderboard?sessionToken=...&limit=... ----
    // Public ladder. sessionToken is optional and only used to report
    // "your rank is #47"; the rows themselves expose nothing but the
    // public ranked columns -- never emails, never account ids.
    if (req.method === "GET" && req.url.startsWith("/ranked/leaderboard")) {
        const urlObj = new URL(req.url, "http://x");
        const limitRaw = parseInt(urlObj.searchParams.get("limit"), 10);
        const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 20;

        const rows = getRankedLeaderboard();
        const sub = sessions[urlObj.searchParams.get("sessionToken")];

        let you = null;
        if (sub) {
            for (let i = 0; i < rows.length; i++) {
                if (rows[i].sub === sub) {
                    const rank = Ranked.getRankFromRP(rows[i].rp);
                    you = {
                        position: i + 1, name: rows[i].name, rp: rows[i].rp,
                        wins: rows[i].wins, losses: rows[i].losses, rank: rank
                    };
                    break;
                }
            }
        }

        sendJson(res, 200, {
            season: RANKED_CONFIG.season,
            seasonName: RANKED_CONFIG.seasonName,
            total: rows.length,
            you: you,
            // `sub` is deliberately stripped here -- it is the player's
            // Google account id and has no business leaving the server.
            entries: rows.slice(0, limit).map((r, i) => ({
                position: i + 1,
                name: r.name,
                rp: r.rp,
                wins: r.wins,
                losses: r.losses,
                games: r.games,
                rank: Ranked.getRankFromRP(r.rp)
            }))
        });
        return;
    }

    // ---- GET /admin/ranked?sessionToken=...&view=history|players ----
    // Admin-only ranked visibility. Re-checks isAdminSession exactly the
    // way every other admin endpoint does -- there is no client-supplied
    // admin flag anywhere in here.
    if (req.method === "GET" && req.url.startsWith("/admin/ranked")) {
        const urlObj = new URL(req.url, "http://x");
        if (!isAdminSession(urlObj.searchParams.get("sessionToken"))) {
            sendJson(res, 403, { error: "Forbidden -- admin access required" });
            return;
        }
        const view = urlObj.searchParams.get("view") || "history";

        if (view === "history") {
            sendJson(res, 200, { history: rankedHistory.slice(0, 50) });
            return;
        }
        if (view === "players") {
            const rows = getRankedLeaderboard();
            sendJson(res, 200, {
                season: RANKED_CONFIG.season,
                queued: rankedQueue.size,
                liveMatches: rankedMatches.size,
                players: rows.slice(0, 100).map(r => ({
                    id: r.sub, name: r.name, rp: r.rp,
                    wins: r.wins, losses: r.losses, games: r.games,
                    rank: Ranked.getRankFromRP(r.rp).name
                }))
            });
            return;
        }
        sendJson(res, 400, { error: "Unknown view" });
        return;
    }

    // ---- POST /admin/ranked ----
    // body: { sessionToken, action, ... }
    // Admin ranked controls. Server-authoritative like every other admin
    // action, audited through the same pushAdminLog trail.
    if (req.method === "POST" && req.url === "/admin/ranked") {
        try {
            const body = await readJsonBody(req);
            if (!isAdminSession(body.sessionToken)) {
                sendJson(res, 403, { error: "Forbidden -- admin access required" });
                return;
            }
            const adminAccount = getAccountForSession(body.sessionToken);

            // Wipe ONE player's ranked data back to a fresh record. Only
            // ever touches `ranked` -- credits/kills/wins/skins/powers
            // are not read or written here at all.
            if (body.action === "resetPlayer") {
                const target = accounts[body.playerId];
                if (!target) {
                    sendJson(res, 404, { error: "Player not found" });
                    return;
                }
                const before = Ranked.publicRankedView(target);
                target.ranked = Ranked.defaultRankedRecord();
                try {
                    await persistAccount(body.playerId);
                } catch (e) {
                    sendJson(res, 503, { error: "Could not save -- try again" });
                    return;
                }
                invalidateRankedLeaderboard();
                pushAdminLog({
                    admin: adminAccount ? adminAccount.name : "unknown",
                    type: "rankedReset",
                    targetPlayer: target.name,
                    targetId: body.playerId,
                    previousRP: before.rp,
                    previousRank: before.rank ? before.rank.name : null
                });
                sendJson(res, 200, { ok: true, ranked: Ranked.publicRankedView(target) });
                return;
            }

            // Roll EVERY account into the next season. Archives each
            // player's current season into their own history first (see
            // ranked.js rolloverToSeason) -- no season data is deleted.
            if (body.action === "startSeason") {
                const newSeason = String(body.season || "").trim();
                if (!newSeason || newSeason.length > 32) {
                    sendJson(res, 400, { error: "Invalid season id" });
                    return;
                }
                if (newSeason === RANKED_CONFIG.season) {
                    sendJson(res, 400, { error: "That season is already active" });
                    return;
                }
                // Refuse while matches are live -- rolling mid-match
                // would apply a result into the wrong season.
                if (rankedMatches.size > 0) {
                    sendJson(res, 409, { error: "Ranked matches are in progress -- try again shortly" });
                    return;
                }

                const previous = RANKED_CONFIG.season;
                RANKED_CONFIG.season = newSeason;
                RANKED_CONFIG.seasonName = String(body.seasonName || ("Season " + newSeason)).slice(0, 48);

                let rolled = 0;
                for (const sub of Object.keys(accounts)) {
                    const account = accounts[sub];
                    if (!account.ranked || typeof account.ranked !== "object") continue;
                    if (account.ranked.season === newSeason) continue;
                    account.ranked = Ranked.rolloverToSeason(account.ranked, RANKED_CONFIG);
                    try {
                        await persistAccount(sub);
                        rolled++;
                    } catch (e) {
                        console.log("[ranked] season rollover failed to save " + sub + ":", e.message);
                    }
                }
                // Persist the active season itself, or a restart would
                // silently revert to the code default.
                await store.saveDoc("rankedSeason", {
                    season: RANKED_CONFIG.season, seasonName: RANKED_CONFIG.seasonName
                }).catch(e => console.log("[ranked] failed to persist season:", e.message));

                invalidateRankedLeaderboard();
                pushAdminLog({
                    admin: adminAccount ? adminAccount.name : "unknown",
                    type: "rankedSeasonStart",
                    fromSeason: previous,
                    toSeason: newSeason,
                    accountsRolled: rolled
                });
                sendJson(res, 200, { ok: true, season: newSeason, accountsRolled: rolled });
                return;
            }

            // Live RP tuning. Clamped server-side; the admin UI's own
            // input limits are only UX.
            if (body.action === "config") {
                const allowed = {
                    winRP: [1, 200], lossRP: [0, 200], startingRP: [0, 5000],
                    placementGames: [1, 50], minRP: [0, 1000]
                };
                const changes = [];
                for (const key of Object.keys(allowed)) {
                    if (!(key in body)) continue;
                    const n = Number(body[key]);
                    if (!Number.isInteger(n)) continue;
                    const [lo, hi] = allowed[key];
                    const clamped = Math.max(lo, Math.min(hi, n));
                    if (RANKED_CONFIG[key] !== clamped) {
                        changes.push({ field: key, from: RANKED_CONFIG[key], to: clamped });
                        RANKED_CONFIG[key] = clamped;
                    }
                }
                if (changes.length) {
                    await store.saveDoc("rankedConfig", {
                        winRP: RANKED_CONFIG.winRP, lossRP: RANKED_CONFIG.lossRP,
                        startingRP: RANKED_CONFIG.startingRP,
                        placementGames: RANKED_CONFIG.placementGames, minRP: RANKED_CONFIG.minRP
                    }).catch(e => console.log("[ranked] failed to persist config:", e.message));
                    pushAdminLog({
                        admin: adminAccount ? adminAccount.name : "unknown",
                        type: "rankedConfig",
                        changes: changes
                    });
                }
                sendJson(res, 200, { ok: true, config: RANKED_CONFIG, changes: changes });
                return;
            }

            sendJson(res, 400, { error: "Unknown action" });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- GET /admin/check?sessionToken=... ----
    // For the UI only -- lets the client know whether to show the ADMIN
    // button. This is NOT a security boundary by itself; every actual
    // admin action below independently re-verifies via isAdminSession.
    if (req.method === "GET" && req.url.startsWith("/admin/check")) {
        const urlObj = new URL(req.url, "http://x");
        const sessionToken = urlObj.searchParams.get("sessionToken");
        sendJson(res, 200, { isAdmin: isAdminSession(sessionToken) });
        return;
    }

    // ---- GET /admin/abilities ----
    // Public read: every player's game needs the current live balance
    // numbers to actually play with them. Reading is not a privilege --
    // only POSTing (changing them) is.
    if (req.method === "GET" && req.url === "/admin/abilities") {
        sendJson(res, 200, { config: abilityConfig, defaults: ABILITY_DEFAULTS, limits: FIELD_LIMITS });
        return;
    }

    // ---- GET /admin/log?sessionToken=... ----
    if (req.method === "GET" && req.url.startsWith("/admin/log")) {
        const urlObj = new URL(req.url, "http://x");
        const sessionToken = urlObj.searchParams.get("sessionToken");
        if (!isAdminSession(sessionToken)) {
            sendJson(res, 403, { error: "Forbidden" });
            return;
        }
        sendJson(res, 200, { log: adminLog });
        return;
    }

    // ---- GET /admin/search-players?sessionToken=...&q=... ----
    // Admin-only player lookup for Credit Management. Matches by display
    // name (case-insensitive substring) or an exact account id, and
    // returns only what the admin UI actually needs to pick a target and
    // show its current balance -- never email or anything else from the
    // account record. Reads the same `accounts` object /save writes to,
    // so the balance shown is always the authoritative one, live.
    if (req.method === "GET" && req.url.startsWith("/admin/search-players")) {
        const urlObj = new URL(req.url, "http://x");
        const sessionToken = urlObj.searchParams.get("sessionToken");
        if (!isAdminSession(sessionToken)) {
            sendJson(res, 403, { error: "Forbidden -- admin access required" });
            return;
        }
        const q = (urlObj.searchParams.get("q") || "").trim().toLowerCase();
        const results = Object.keys(accounts)
            .filter(sub => {
                if (!q) return true;
                const a = accounts[sub];
                return sub === q || (a.name || "").toLowerCase().includes(q);
            })
            .slice(0, 20)
            .map(sub => ({ id: sub, name: accounts[sub].name, credits: accounts[sub].credits }));
        sendJson(res, 200, { results: results });
        return;
    }

    // ---- POST /admin/credits ----
    // body: { sessionToken, playerId, amount }
    // Server-authoritative credit grant: verifies admin + target + amount,
    // then increments the account's own stored balance (never accepts a
    // client-supplied newBalance) and persists it. Node's single-threaded
    // event loop means the read of accounts[playerId].credits and the
    // increment below run with no `await` in between, so no other request
    // can interleave and race the read-modify-write -- equivalent to an
    // atomic addCredits(playerId, amount). The persist that follows is
    // awaited and serialized per account by the storage layer, so
    // concurrent grants are written in the order they were applied.
    if (req.method === "POST" && req.url === "/admin/credits") {
        try {
            const body = await readJsonBody(req);

            if (!isAdminSession(body.sessionToken)) {
                sendJson(res, 403, { error: "Forbidden -- admin access required" });
                return;
            }
            const adminAccount = getAccountForSession(body.sessionToken);

            const target = accounts[body.playerId];
            if (!target) {
                sendJson(res, 404, { error: "Player not found" });
                return;
            }

            if (!isValidCreditAmount(body.amount)) {
                sendJson(res, 400, { error: "Invalid credit amount" });
                return;
            }
            const amount = Number(body.amount);

            const previousBalance = target.credits || 0;
            target.credits = previousBalance + amount; // atomic increment, not a client-supplied total
            try {
                await persistAccount(body.playerId);
            } catch (e) {
                target.credits = previousBalance; // write failed -- undo the in-memory grant
                sendJson(res, 503, { error: "Could not save credit grant -- try again" });
                return;
            }

            pushAdminLog({
                admin: adminAccount ? adminAccount.name : "unknown",
                type: "creditGrant",
                targetPlayer: target.name,
                targetId: body.playerId,
                amount: amount,
                previousBalance: previousBalance,
                newBalance: target.credits
            });

            sendJson(res, 200, {
                ok: true,
                playerId: body.playerId,
                name: target.name,
                previousBalance: previousBalance,
                newBalance: target.credits
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- POST /admin/abilities ----
    // body: { sessionToken, action: 'save'|'resetAbility'|'resetAll', abilityId?, values? }
    // This is the one endpoint that actually changes balance. Every
    // request re-checks isAdminSession server-side regardless of what
    // the client claims -- there is no client-supplied "isAdmin" flag
    // anywhere in this handler.
    if (req.method === "POST" && req.url === "/admin/abilities") {
        try {
            const body = await readJsonBody(req);

            if (!isAdminSession(body.sessionToken)) {
                sendJson(res, 403, { error: "Forbidden -- admin access required" });
                return;
            }
            const account = getAccountForSession(body.sessionToken);
            const action = body.action;

            if (action === "save") {
                const abilityId = body.abilityId;
                if (!ABILITY_DEFAULTS[abilityId]) {
                    sendJson(res, 400, { error: "Unknown ability" });
                    return;
                }
                const incoming = (body.values && typeof body.values === "object") ? body.values : {};
                const current = abilityConfig[abilityId];
                const validKeys = Object.keys(ABILITY_DEFAULTS[abilityId]);
                const changes = [];

                for (const key of validKeys) {
                    if (!(key in incoming)) continue;
                    const clamped = clampField(key, incoming[key]);
                    if (clamped === null) continue; // invalid/unknown -- silently skip, never crash or partially trust it
                    if (current[key] !== clamped) {
                        changes.push({ field: key, from: current[key], to: clamped });
                        current[key] = clamped;
                    }
                }

                persistAbilityConfig();
                logAdminAction(account, abilityId, changes, "save");
                sendJson(res, 200, { ok: true, config: abilityConfig[abilityId] });
                return;
            }

            if (action === "resetAbility") {
                const abilityId = body.abilityId;
                if (!ABILITY_DEFAULTS[abilityId]) {
                    sendJson(res, 400, { error: "Unknown ability" });
                    return;
                }
                const before = Object.assign({}, abilityConfig[abilityId]);
                abilityConfig[abilityId] = Object.assign({}, ABILITY_DEFAULTS[abilityId]);
                const changes = Object.keys(ABILITY_DEFAULTS[abilityId])
                    .filter(k => before[k] !== ABILITY_DEFAULTS[abilityId][k])
                    .map(k => ({ field: k, from: before[k], to: ABILITY_DEFAULTS[abilityId][k] }));

                persistAbilityConfig();
                logAdminAction(account, abilityId, changes, "reset");
                sendJson(res, 200, { ok: true, config: abilityConfig[abilityId] });
                return;
            }

            if (action === "resetAll") {
                const fresh = {};
                for (const key of Object.keys(ABILITY_DEFAULTS)) {
                    fresh[key] = Object.assign({}, ABILITY_DEFAULTS[key]);
                }
                abilityConfig = fresh;
                persistAbilityConfig();
                logAdminAction(account, "ALL", [], "resetAll");
                sendJson(res, 200, { ok: true, config: abilityConfig });
                return;
            }

            sendJson(res, 400, { error: "Unknown action" });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- everything else: serve it as a static file (index.html, bgm.mp3, ...) ----
    if (req.method === "GET") {
        serveStatic(req, res);
        return;
    }

    sendJson(res, 404, { error: "Not found" });
});

// (The "server started" banner is printed by startServer() at the bottom
// of this file, once the persistent store is loaded and the port is
// actually open -- printing it here would announce a server that is not
// listening yet.)

// =====================================================================
// WEBSOCKET RELAY -- movement/bullets/damage/skin/rematch for online
// matches, attached to the same HTTP server/port.
// =====================================================================
const wss = new WebSocket.Server({ server: httpServer });

const slots = { 1: null, 2: null };

// ---------------------------------------------------------------------
// SERVER-AUTHORITATIVE COMBAT
//
// Health, shields, damage amounts and eliminations are decided here, not
// by the clients -- see combat.js for the full rationale and for what
// deliberately stays client-side. Casual play has one shared match (it
// has one shared pair of slots); every ranked room gets its own.
// ---------------------------------------------------------------------
let casualCombat = Combat.createCombatMatch(abilityConfig);

// Shield charges come from the account's own equipped powers, looked up
// server-side. A client never gets to say how many free hits it has.
function shieldsForConnection(conn) {
    if (!conn || !conn.authSub) return 0;
    const account = accounts[conn.authSub];
    if (!account || !Array.isArray(account.equippedPowers)) return 0;
    return account.equippedPowers.indexOf("kevlar") >= 0 ? 1 : 0;
}

// Re-reads both sides' loadouts and starts the match's combat state
// fresh. Called when a casual pairing forms and whenever a match or
// round restarts.
function resetCasualCombat() {
    casualCombat.resetMatch();
    for (const slot of [1, 2]) {
        if (slots[slot]) casualCombat.setShields(slot, shieldsForConnection(slots[slot]));
    }
}

// Sends one authoritative health line to both sides of a match. Both
// clients render exactly this -- neither computes its own.
function broadcastHealth(a, b, result) {
    const payload = {
        type: "health",
        slot: result.slot,
        by: result.by,
        health: result.health,
        shields: result.shields,
        blocked: result.blocked,
        eliminated: result.eliminated,
        kind: result.kind
    };
    send(a, payload);
    send(b, payload);
}

// =====================================================================
// HEIST MODE -- server-authoritative base health.
// Unlike position/damage/shockwave (which are relayed and trusted to
// the player they describe), Heist HP is decided here on the server:
// both players' clients need to agree on the exact same number for a
// static base that has no single "owner" client the way a player's own
// health does. This server only ever hosts one 2-player match at a time
// (same as the existing `slots` design), so this is simple top-level
// state, reset whenever a new Heist match starts or a player leaves.
// =====================================================================
let heistHP = { 1: 20, 2: 20 };
let heistDestroyed = false;

function resetHeistState() {
    heistHP = { 1: 20, 2: 20 };
    heistDestroyed = false;
}

// =====================================================================
// BOMB RUN MODE -- server-authoritative carrier + score, same shape as
// Heist's HP above. Position/bullets/damage/deaths/respawns stay on the
// existing self-report relay (unchanged trust model), but WHO currently
// holds the one bomb, and the score/winner, are decided here so both
// clients can never disagree about a pickup or a goal.
// =====================================================================
let bombCarrier = null; // null | 1 | 2 (slot number)
let bombScore = { 1: 0, 2: 0 };
let bombMatchOver = false;
let bombWinner = null;

function resetBombState() {
    bombCarrier = null;
    bombScore = { 1: 0, 2: 0 };
    bombMatchOver = false;
    bombWinner = null;
}

function otherId(id) {
    return id === 1 ? 2 : 1;
}

// =====================================================================
// NETWORK DIAGNOSTICS (opt-in)
//
// Off by default and, when off, costs one boolean test per message --
// no counters, no allocation, no logging. Turn on with
// DEBUG_NETWORKING=1 in the environment, then read GET /__net/stats
// (which also stays 404 unless the flag is set, so it can't leak
// anything about a production instance).
//
// Deliberately counts only what this server actually does: it has no
// gameplay tick to time, because casual/ranked play is a MESSAGE RELAY
// -- see the WEBSOCKET RELAY section. "tick duration" therefore doesn't
// exist here; relay handling time per message is the equivalent number,
// and that's what's sampled.
// =====================================================================
const DEBUG_NETWORKING = process.env.DEBUG_NETWORKING === "1";

const netStats = {
    startedAt: Date.now(),
    msgsIn: 0, msgsOut: 0,
    bytesIn: 0, bytesOut: 0,
    maxPacketIn: 0, maxPacketOut: 0,
    // Relay handling time (parse + route + forward) in ms, sampled.
    handleMs: [],
    byType: Object.create(null)
};

function netRecordIn(type, bytes) {
    netStats.msgsIn++;
    netStats.bytesIn += bytes;
    if (bytes > netStats.maxPacketIn) netStats.maxPacketIn = bytes;
    netStats.byType[type] = (netStats.byType[type] || 0) + 1;
}
function netRecordHandle(ms) {
    netStats.handleMs.push(ms);
    if (netStats.handleMs.length > 5000) netStats.handleMs.shift();
}
function netSnapshot() {
    const s = netStats.handleMs.slice().sort((a, b) => a - b);
    const q = p => (s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(3) : 0);
    const secs = Math.max(1, (Date.now() - netStats.startedAt) / 1000);
    let sockets = 0;
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) sockets++; });
    return {
        uptimeSec: Math.round(secs),
        sockets: sockets,
        casualSlotsUsed: (slots[1] ? 1 : 0) + (slots[2] ? 1 : 0),
        rankedMatches: rankedMatches.size,
        rankedQueued: rankedQueue.size,
        presenceAccounts: presence.size,
        msgsInPerSec: +(netStats.msgsIn / secs).toFixed(1),
        msgsOutPerSec: +(netStats.msgsOut / secs).toFixed(1),
        kbInPerSec: +(netStats.bytesIn / secs / 1024).toFixed(2),
        kbOutPerSec: +(netStats.bytesOut / secs / 1024).toFixed(2),
        avgPacketIn: netStats.msgsIn ? Math.round(netStats.bytesIn / netStats.msgsIn) : 0,
        avgPacketOut: netStats.msgsOut ? Math.round(netStats.bytesOut / netStats.msgsOut) : 0,
        maxPacketIn: netStats.maxPacketIn,
        maxPacketOut: netStats.maxPacketOut,
        relayHandleMs: { p50: q(.5), p95: q(.95), p99: q(.99), max: s.length ? +s[s.length - 1].toFixed(3) : 0 },
        byType: netStats.byType
    };
}

// Wraps the relay's message handler so DEBUG_NETWORKING can measure
// per-message handling time and byte counts in ONE place, instead of
// threading a branch through every route inside it. When the flag is
// off this returns the original function unchanged -- literally the
// same reference, so there is no wrapper, no timing call and no
// measurable cost on the hot path.
function instrumentMessage(handler) {
    if (!DEBUG_NETWORKING) return handler;
    return function (raw) {
        const t0 = process.hrtime.bigint();
        const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
        let type = "?";
        try { type = (JSON.parse(raw.toString()) || {}).type || "?"; } catch (e) {}
        netRecordIn(type, bytes);
        try {
            return handler.apply(this, arguments);
        } finally {
            netRecordHandle(Number(process.hrtime.bigint() - t0) / 1e6);
        }
    };
}

function send(player, obj) {
    if (player && player.socket.readyState === WebSocket.OPEN) {
        const payload = JSON.stringify(obj);
        if (DEBUG_NETWORKING) {
            netStats.msgsOut++;
            const b = Buffer.byteLength(payload);
            netStats.bytesOut += b;
            if (b > netStats.maxPacketOut) netStats.maxPacketOut = b;
        }
        player.socket.send(payload);
    }
}

wss.on("connection", (socket, request) => {

    // A presence connection asks for it explicitly with ?presence=1 and
    // is NEVER given a casual slot. That is the whole point: idle lobby
    // players need to be visible to their friends without occupying one
    // of the two casual duel slots (see the FRIENDS section above).
    let isPresenceOnly = false;
    try {
        isPresenceOnly = /[?&]presence=1(&|$)/.test(request && request.url ? request.url : "");
    } catch (e) { isPresenceOnly = false; }

    // Every connection gets a lightweight envelope. For CASUAL play this
    // is exactly the old `player` object in one of the two global slots
    // (unchanged behaviour). For RANKED the same object is instead
    // attached to a match room, which is what allows more than one
    // ranked match to be in progress at a time without touching the
    // legacy slots at all.
    const conn = {
        socket: socket,
        // casual slot id (1/2) or null when this connection never took
        // a casual slot
        id: null,
        x: 0, y: 270, facing: 0, lastSeq: 0,
        // ranked state
        rankedSub: null,
        rankedQueued: false,
        rankedMatchId: null,
        rankedSlot: null,
        // friends/presence state
        authSub: null,
        presenceOnly: isPresenceOnly
    };

    // ---- Casual slot assignment (unchanged) ----
    // A connection that ends up playing ranked simply never uses this,
    // and a full server no longer refuses the connection outright: it
    // still has to be able to queue for ranked, which needs no slot.
    //
    // A PRESENCE connection skips this entirely -- it must never consume
    // a casual slot, or idle players in the lobby would lock out the
    // players actually trying to duel.
    let id = null;
    if (!isPresenceOnly) {
        if (!slots[1]) id = 1;
        else if (!slots[2]) id = 2;
    }

    if (id !== null) {
        conn.id = id;
        conn.x = id === 1 ? 130 : 770;
        conn.facing = id === 1 ? 0 : Math.PI;
        slots[id] = conn;
        console.log("Player " + id + " connected");

        send(conn, {
            type: "welcome",
            id: id,
            x: conn.x,
            y: conn.y,
            facing: conn.facing
        });

        const opponent = slots[otherId(id)];
        if (opponent) {
            // A fresh pairing starts from full health, with each side's
            // shields read from its own account (see resetCasualCombat).
            resetCasualCombat();
            send(conn, { type: "opponentJoined" });
            send(opponent, { type: "opponentJoined" });
        }
    } else if (!isPresenceOnly) {
        // No casual slot free. Previously this closed the socket; now it
        // stays open so ranked queueing still works, and the client is
        // told the casual lobby is full exactly as before.
        //
        // A presence connection never wanted a slot, so it must NOT be
        // told the lobby is full -- that message drives casual UI.
        send(conn, { type: "serverFull" });
    }

    const player = conn; // keep the original name for the relay code below

    socket.on("message", instrumentMessage(raw => {

        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch (error) {
            console.log("Invalid message from connection");
            return;
        }

        // =============================================================
        // FRIENDS / PRESENCE MESSAGES
        //
        // Handled first, and available on ANY connection (presence or
        // gameplay) so a player in a match still counts as online and
        // still receives friend events.
        // =============================================================
        if (typeof data.type === "string" && data.type.indexOf("presence_") === 0) {

            // Authenticates this socket. This is the ONLY way a socket
            // becomes associated with an account -- the client cannot
            // simply declare an id, it has to present a session token
            // this server itself issued.
            if (data.type === "presence_hello") {
                const sub = sessions[data.sessionToken];
                if (!sub || !accounts[sub]) {
                    send(conn, { type: "presence_error", message: "Not signed in" });
                    return;
                }
                // Re-identifying on the same socket (e.g. a re-sign-in)
                // detaches the previous account first.
                if (conn.authSub && conn.authSub !== sub) {
                    const wentOffline = presenceDetach(conn.authSub, conn);
                    if (wentOffline) broadcastToFriends(conn.authSub, presenceEventFor(conn.authSub));
                }
                conn.authSub = sub;
                ensureAccountFriends(sub);
                const cameOnline = presenceAttach(sub, conn);

                send(conn, {
                    type: "presence_ready",
                    id: sub,
                    friends: friendsPayloadFor(sub)
                });
                // Only announce a genuine offline -> online transition,
                // so opening a second tab doesn't notify everyone again.
                if (cameOnline) broadcastToFriends(sub, presenceEventFor(sub));

                // ---- Casual online-match identity ----
                // A connection that ALSO holds one of the two casual
                // gameplay slots (conn.id, set at connect time -- see
                // the top of wss.on("connection")) just proved who it
                // is. index.html's main gameplay socket sends this same
                // presence_hello once it knows its own sessionToken, so
                // this is the ONLY way the opponent's client ever learns
                // a real display name/level -- never from a client-sent
                // "name" field on any gameplay message. Only the public
                // {slot, name, level} triple is ever sent to the
                // OPPONENT; email/sub/admin status never leave this
                // block. Handles both connection orders: tells the
                // opponent about ME, and -- if they're already
                // authenticated -- tells me about THEM too.
                if (conn.id !== null) {
                    ensureAccountXP(sub);
                    const acct = accounts[sub];
                    const myIdentity = { type: "identity", slot: conn.id, name: acct.name, level: acct.level || 1 };
                    const opponentConn = slots[otherId(conn.id)];
                    send(conn, myIdentity); // echo back to self too, so my own client's HUD label updates immediately
                    if (opponentConn) {
                        send(opponentConn, myIdentity);
                        if (opponentConn.authSub && accounts[opponentConn.authSub]) {
                            const theirAcct = accounts[opponentConn.authSub];
                            send(conn, { type: "identity", slot: opponentConn.id, name: theirAcct.name, level: theirAcct.level || 1 });
                        }
                    }
                }
                return;
            }

            if (!conn.authSub) return; // everything below needs identity

            // Cosmetic activity label on top of a verified connection.
            if (data.type === "presence_activity") {
                if (presenceSetActivity(conn.authSub, data.activity)) {
                    broadcastToFriends(conn.authSub, presenceEventFor(conn.authSub));
                }
                return;
            }

            if (data.type === "presence_ping") {
                const row = presence.get(conn.authSub);
                if (row) row.lastSeen = Date.now();
                send(conn, { type: "presence_pong" });
                return;
            }
            return;
        }

        if (typeof data.type === "string" && data.type.indexOf("friend_") === 0) {
            if (!conn.authSub) {
                send(conn, { type: "presence_error", message: "Not signed in" });
                return;
            }
            // Invite responses are the only friend action that arrives
            // over the socket rather than HTTP, because they are a
            // live, expiring exchange between two connected players.
            if (data.type === "friend_invite_respond") {
                const result = respondToInvite(conn.authSub, data.inviteId, !!data.accept);
                if (!result.ok) send(conn, { type: "presence_error", message: result.error });
                return;
            }
            return;
        }

        // =============================================================
        // RANKED MESSAGES -- handled before (and entirely separately
        // from) the casual relay below.
        // =============================================================
        if (typeof data.type === "string" && data.type.indexOf("ranked_") === 0) {

            if (data.type === "ranked_queue_join") {
                joinRankedQueue(conn, data.sessionToken);
                return;
            }
            if (data.type === "ranked_queue_leave") {
                if (conn.rankedSub) leaveRankedQueue(conn.rankedSub, "left");
                return;
            }
            if (data.type === "ranked_match_ready") {
                rankedMatchReady(conn);
                return;
            }
            // NOTE: there is deliberately NO "ranked_match_result" or
            // "I won" message a client can send. The winner is decided
            // by this server from self-reported eliminations (see
            // registerRankedElimination) and nowhere else.
            return;
        }

        // =============================================================
        // RANKED IN-MATCH RELAY
        //
        // A connection inside a ranked match relays to its ROOM
        // opponent, not to the global casual slot, so several ranked
        // matches can run concurrently. The gameplay payloads are
        // relayed byte-for-byte identically to casual play -- the only
        // thing the server does extra is COUNT eliminations itself.
        // =============================================================
        if (conn.rankedMatchId) {
            const match = rankedMatches.get(conn.rankedMatchId);
            if (!match || match.finished) return;
            const me = match.players[conn.rankedSlot];
            const foe = match.players[conn.rankedSlot === 1 ? 2 : 1];
            if (!me || !foe) return;

            if (data.type === "ping") {
                send(conn, { type: "pong", t: data.t, ack: conn.lastSeq || 0 });
                return;
            }

            if (data.type === "position" && typeof data.seq === "number") conn.lastSeq = data.seq;

            // Projectiles are registered so a hit claim can be checked
            // against something that was really fired.
            if (data.type === "bullet") match.combat.trackBullet(conn.rankedSlot, data, Date.now());
            else if (data.type === "shockwave") match.combat.trackShockwave(conn.rankedSlot, Date.now());

            // A hit claim. Previously the round went to the opponent
            // because the losing client SAID "eliminated: true" -- so a
            // client that simply never sent it could not lose a round.
            // Now the server applies the damage itself and decides when
            // someone is dead, which is what actually decides the round.
            // ("damage" is the pre-authoritative name for the same
            // event, still accepted across a redeploy; its health and
            // eliminated fields are ignored.)
            if (data.type === "hitClaim" || data.type === "damage") {
                const result = match.combat.claimHit(conn.rankedSlot, Date.now());
                if (result.accepted) {
                    broadcastHealth(conn, foe.conn, result);
                    if (result.eliminated) {
                        match.combat.resetRound();
                        registerRankedElimination(match, conn.rankedSlot);
                    }
                }
                return;
            }

            // Everything else is a straight relay to the room opponent.
            send(foe.conn, data);
            return;
        }

        // =============================================================
        // CASUAL RELAY -- completely unchanged from here down.
        //
        // A presence connection stops here. It holds no casual slot, so
        // letting it reach the relay below would make it read
        // slots[otherId(null)] and relay stray gameplay messages into
        // somebody else's real match.
        // =============================================================
        if (conn.presenceOnly || conn.id === null) return;

        // Lightweight ping/pong for RTT measurement -- answered straight
        // back to the sender and does NOT require an opponent to be
        // connected (unlike everything below), so it works even while
        // waiting in the lobby. Also echoes back "ack": the last position
        // input-sequence number this server has seen from this same
        // connection (see index.html's inputSeq/lastAckSeq). This does
        // NOT make the server authoritative over gameplay -- there is no
        // physics simulation here, it's purely a diagnostic/ack channel
        // that index.html currently only uses for display, never to
        // reposition or "correct" a player.
        if (data.type === "ping") {
            send(player, { type: "pong", t: data.t, ack: player.lastSeq || 0 });
            return;
        }

        const opponent = slots[otherId(id)];
        if (!opponent) return;

        if (data.type === "position") {

            player.x = data.x;
            player.y = data.y;
            player.facing = data.facing;
            if (typeof data.seq === "number") player.lastSeq = data.seq;

            send(opponent, {
                type: "position",
                id: id,
                x: data.x,
                y: data.y,
                facing: data.facing,
                seq: data.seq
            });
        }

        else if (data.type === "bullet") {

            // Every projectile is registered as a damage source so a hit
            // claim can be checked against something that was really
            // fired (see combat.js). The damage VALUE is taken from the
            // server's own config there, never from this message.
            casualCombat.trackBullet(id, data, Date.now());

            send(opponent, {
                type: "bullet",
                x: data.x,
                y: data.y,
                vx: data.vx,
                vy: data.vy,
                color: data.color,
                range: data.range,
                bounces: data.bounces,
                damage: data.damage
            });
        }

        // A hit claim. The player who was hit is still the one who
        // DETECTS it (their own position is the only view of it that
        // isn't network-delayed), but that is all they get to say: this
        // message carries no health, no damage and no "I died". The
        // server checks the claim against shots the opponent really
        // fired, decides the damage from its own config, applies it, and
        // tells BOTH clients the resulting numbers.
        //
        // "damage" is the pre-authoritative name for the same event and
        // is still accepted so a client left open across a redeploy
        // keeps working; its health/eliminated fields are ignored.
        else if (data.type === "hitClaim" || data.type === "damage") {

            const result = casualCombat.claimHit(id, Date.now());
            if (result.accepted) {
                broadcastHealth(player, opponent, result);
                // The round is over the moment the server says someone
                // died, so the next round starts from full health. Any
                // shot still tracked from the old round is dropped with
                // it, so it cannot land after the reset.
                if (result.eliminated) casualCombat.resetRound();
            }
        }

        // A respawn in the modes where death is not the end of a round
        // (Football / Heist / Bomb Run) restores that player's health
        // server-side, so the authoritative numbers match what their
        // client is about to draw.
        else if (data.type === "footballRespawn" || data.type === "heistRespawn" || data.type === "bombRespawn") {

            casualCombat.resetRound();
            send(opponent, data);
        }

        // Tells the opponent which skin color to render you as, instead
        // of them always seeing you as the default red/blue.
        else if (data.type === "skin") {

            send(opponent, {
                type: "skin",
                color: data.color
            });
        }

        // The Shockwave ability: relays where the blast went off. The
        // receiving player decides for themselves (using their own real
        // position) whether it actually hit them -- same trust model as
        // bullets and damage.
        else if (data.type === "shockwave") {

            casualCombat.trackShockwave(id, Date.now());

            send(opponent, {
                type: "shockwave",
                x: data.x,
                y: data.y,
                radius: data.radius
            });
        }

        // Time Warp: a targeted debuff, just relayed straight through --
        // the receiving player applies it to their own real position.
        else if (data.type === "timewarp") {

            send(opponent, {
                type: "timewarp",
                duration: data.duration
            });
        }

        // Decoy: relays the caster's fake copy's position/facing/life so
        // the opponent's client can render it identically to a real
        // player. The receiving client alone decides how it looks --
        // this server has no opinion on "real" vs "fake".
        else if (data.type === "decoy") {

            send(opponent, {
                type: "decoy",
                x: data.x,
                y: data.y,
                facing: data.facing,
                life: data.life
            });
        }

        // ---- HEIST MODE: match start / rematch -- both bases reset to
        // 20/20. This one needs real server logic (unlike the generic
        // relay below), so it gets its own branch ahead of it.
        else if (data.type === "heistReset") {

            resetCasualCombat();
            resetHeistState();
            const payload = { type: "heistUpdate", hp: heistHP, destroyed: false, winner: null };
            send(player, payload);
            send(opponent, payload);
        }

        // ---- HEIST MODE: a bullet (or triburst pellet) landed on the
        // enemy base. `target` is which base (1 or 2) got hit. Only the
        // shooter reports this (see index.html's registerHeistHit), and
        // the server is the sole place that actually decrements HP and
        // decides destruction -- so both clients always agree on the
        // exact same number and the exact moment it hits zero, instead
        // of trusting either client's own count.
        else if (data.type === "heistHit") {

            if (!heistDestroyed) {
                const target = data.target;
                if ((target === 1 || target === 2) && heistHP[target] > 0) {
                    heistHP[target] = Math.max(0, heistHP[target] - 1);
                    let winner = null;
                    if (heistHP[target] === 0) {
                        heistDestroyed = true;
                        winner = otherId(target);
                    }
                    const payload = { type: "heistUpdate", hp: heistHP, destroyed: heistDestroyed, winner: winner };
                    send(player, payload);
                    send(opponent, payload);
                    // Server-authoritative XP: this IS the server's own
                    // confirmation of the win (HP just hit 0 in server
                    // state), so no client report is needed or accepted.
                    if (winner) awardXPAndNotify(slots[winner], XP_REWARDS.heist_win, "heist_win");
                }
            }
        }

        // ---- BOMB RUN MODE: match start / rematch -- carrier cleared,
        // score reset to 0/0. Mirrors heistReset above exactly.
        else if (data.type === "bombReset") {

            resetCasualCombat();
            resetBombState();
            const payload = { type: "bombUpdate", carrier: null, x: null, y: null };
            send(player, payload);
            send(opponent, payload);
        }

        // ---- BOMB RUN MODE: a pickup claim. Only granted if nobody
        // currently holds the bomb -- this is what makes it impossible
        // for both players to simultaneously "win" a race to the bomb,
        // and impossible to duplicate the single bomb. `by` is the
        // claimant's own slot number; x/y is their own reported position
        // (trusted the same way every other position report already is),
        // used only as where the bomb should now visually sit.
        else if (data.type === "bombPickup") {

            if (!bombMatchOver && bombCarrier === null) {
                bombCarrier = id; // trust only the connection's own slot, never a client-supplied id
                const payload = { type: "bombUpdate", carrier: bombCarrier, x: data.x, y: data.y };
                send(player, payload);
                send(opponent, payload);
            }
        }

        // ---- BOMB RUN MODE: a drop -- either from a manual drop or the
        // carrier dying (see index.html's handleBombDeath). Only the
        // player CURRENTLY holding the bomb can drop it, so a stray or
        // late message from the other player can never clear a live
        // carrier by mistake.
        else if (data.type === "bombDrop") {

            const claimedId = id; // this connection's own slot number
            if (!bombMatchOver && bombCarrier === claimedId) {
                bombCarrier = null;
                const payload = { type: "bombUpdate", carrier: null, x: data.x, y: data.y };
                send(player, payload);
                send(opponent, payload);
            }
        }

        // ---- BOMB RUN MODE: a goal claim. Only granted if the claimant
        // is the CURRENTLY-held carrier -- exactly the same guard as
        // heistHit's "only the shooter's own client reports its own
        // bullets" -- so a forged goal claim from a modified client (or a
        // stale message after already dropping) can never score. First
        // to 3 ends the match; otherwise the bomb resets to center and
        // play continues.
        else if (data.type === "bombGoal") {

            if (!bombMatchOver && bombCarrier === id) {
                bombScore[id] = (bombScore[id] || 0) + 1;
                bombCarrier = null;
                let winner = null;
                if (bombScore[1] >= 3 || bombScore[2] >= 3) {
                    bombMatchOver = true;
                    winner = bombScore[1] > bombScore[2] ? 1 : 2;
                    bombWinner = winner;
                }
                const payload = { type: "bombGoalUpdate", scorer: id, score1: bombScore[1], score2: bombScore[2], matchOver: bombMatchOver, winner: winner };
                send(player, payload);
                send(opponent, payload);
                // Server-authoritative XP -- bombMatchOver just flipped
                // true in the server's own state, so this can't be forged
                // or double-claimed via a client report.
                if (winner) awardXPAndNotify(slots[winner], XP_REWARDS.bombrun_win, "bombrun_win");
            }
        }

        // ---- FOOTBALL MODE / HEIST MODE / BOMB RUN MODE (generic relay) ----
        // Every football-related message (footballKick, footballBall,
        // footballGoal, footballRespawn, and any future footballXxx type)
        // plus heist messages that don't need server-side validation
        // (heistRespawn, and any future heistXxx type -- heistHit/
        // heistReset above are handled separately because those DO need
        // real logic) are relayed to the opponent completely untouched.
        // This is one generic branch instead of one per message type --
        // exactly the same trust model as bullets/shockwave/decoy above:
        // the server doesn't validate the physics/scoring itself, it just
        // passes the message along, and the receiving client decides what
        // to do with it. This also means new message types for either
        // mode can be added on the client later without ever touching
        // server.js again.
        else if (typeof data.type === "string" && (data.type.indexOf("football") === 0 || data.type.indexOf("heist") === 0 || data.type.indexOf("bomb") === 0)) {

            send(opponent, data);
        }

        else if (data.type === "rematch") {

            resetCasualCombat();
            send(opponent, { type: "rematch" });
        }

    }));

    socket.on("close", () => {

        // Presence first: drop this connection from its account, and
        // tell that account's friends only if it was the LAST one (so
        // closing one of two tabs doesn't show the player as offline).
        if (conn.authSub) {
            const sub = conn.authSub;
            const wentOffline = presenceDetach(sub, conn);
            if (wentOffline) broadcastToFriends(sub, presenceEventFor(sub));
        }

        // Ranked cleanup: drops any queue entry and turns an
        // in-progress ranked match into a forfeit/abandon as appropriate
        // (see handleRankedDisconnect). This is what guarantees a closed
        // browser can never leave a ghost in the queue.
        handleRankedDisconnect(conn);

        // Casual slot cleanup -- unchanged, but only for a connection
        // that actually held a slot.
        if (conn.id !== null) {
            console.log("Player " + conn.id + " disconnected");
            // Only release the slot if it is still OURS. A reconnect that
            // took the same slot number must not be evicted by the old
            // socket's late close event.
            if (slots[conn.id] === conn) {
                slots[conn.id] = null;
                resetHeistState(); // leaving a Heist match cleans up its state for the next match
                resetBombState(); // leaving a Bomb Run match cleans up its state for the next match
                const opponent = slots[otherId(conn.id)];
                send(opponent, { type: "opponentLeft" });
            }
        }
    });

});

// =====================================================================
// BOOT -- the persistent store is opened and fully loaded into memory
// BEFORE the port is opened. Serving requests against a half-loaded
// account cache is how a redeploy turns into "everyone lost their
// progress", so a storage failure here stops the process instead.
// =====================================================================
async function startServer() {
    try {
        await store.init();
        Object.assign(accounts, await store.loadAllAccounts());
        abilityConfig = await loadAbilityConfig();
        adminLog = await loadAdminLog();

        // Ranked: match history, plus the live season/config, which are
        // admin-editable at runtime and so must survive a restart rather
        // than snapping back to the code defaults.
        const storedHistory = await store.loadDoc("rankedHistory", null);
        rankedHistory = Array.isArray(storedHistory) ? storedHistory : [];

        const storedSeason = await store.loadDoc("rankedSeason", null);
        if (storedSeason && typeof storedSeason.season === "string" && storedSeason.season) {
            RANKED_CONFIG.season = storedSeason.season;
            if (storedSeason.seasonName) RANKED_CONFIG.seasonName = storedSeason.seasonName;
        }
        const storedRankedCfg = await store.loadDoc("rankedConfig", null);
        if (storedRankedCfg && typeof storedRankedCfg === "object") {
            for (const key of ["winRP", "lossRP", "startingRP", "placementGames", "minRP"]) {
                const v = storedRankedCfg[key];
                if (Number.isInteger(v)) RANKED_CONFIG[key] = v;
            }
        }
        // The queue and live matches are in-memory only and are simply
        // GONE after a restart -- which is the correct outcome. Nothing
        // is reconstructed, so a restart can never leave a ghost player
        // stuck in a queue or a zombie match holding someone's account.

        // Friends: normalise every record and repair any one-sided link
        // a crash mid-write could have left behind. Runs once, at boot,
        // against the fully-loaded account cache.
        reconcileFriendships();

        // Restore live sessions so a redeploy doesn't invalidate the token
        // every already-signed-in player is still holding.
        const restored = await store.loadValidSessions();
        for (const token of Object.keys(restored)) {
            const row = restored[token];
            if (row && accounts[row.sub]) sessions[token] = row.sub; // skip sessions whose account is gone
        }
    } catch (e) {
        console.error("FATAL: could not open the account store:", e.message);
        console.error("Refusing to start -- serving with an empty account store " +
            "would overwrite real player progress on the next save.");
        process.exit(1);
    }

    console.log("[storage] backend: " + store.backendName +
        " -- " + Object.keys(accounts).length + " account(s), " +
        Object.keys(sessions).length + " live session(s) loaded");
    if (!store.usingDatabase) {
        console.log("[storage] NOTE: no DATABASE_URL set, using the local filesystem. " +
            "On an ephemeral host (Render without a persistent disk) this data " +
            "does NOT survive a redeploy or restart.");
    }

    httpServer.listen(PORT, "0.0.0.0", () => {
        console.log("DUEL ARENA SERVER STARTED on port " + PORT);
        console.log("Open http://localhost:" + PORT + " on this computer,");
        console.log("or http://<this computer's LAN IP>:" + PORT + " on the other player's computer.");
    });
}

// Account writes are coalesced behind a short window so gameplay bursts
// don't hammer the disk (see storage.js). A redeploy/restart must not
// drop whatever is still inside that window, so flush it on the way out.
// Render sends SIGTERM before replacing an instance.
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    store.flushPendingWrites()
        .catch(e => console.log("[storage] flush on " + signal + " failed:", e.message))
        .then(() => process.exit(0));
    // Never hang the container waiting on a stuck disk.
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

startServer();
