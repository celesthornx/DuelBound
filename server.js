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
const Shadow = require("./shadow");
const Auth = require("./auth");

// Friends data shape, validation and public views. Pure functions only;
// persistence, presence and the WebSocket wiring live in this file (see
// the FRIENDS section further down).
const Friends = require("./friends");
const Chat = require("./chat");
const Catalog = require("./catalog");
const Billing = require("./billing");
const BattlePass = require("./battlepass");
const Voidbreak = require("./voidbreak");
// Online lobbies / flexible match configurations / Voidbreak co-op.
// party.js  -- what match types exist and who is on whose team
// lobby.js  -- the room players sit in before a match exists
// voidbreakCoop.js -- the shared, server-authoritative PvE simulation
const Party = require("./party");
const Lobby = require("./lobby");
const VoidbreakCoop = require("./voidbreakCoop");

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
        // COINS -- the free, earned-by-playing currency (was called
        // "Credits" before the rename; see ensureAccountCurrency() for
        // how an existing account's stored `credits` value becomes
        // this field without losing its balance).
        coins: 100,
        // CRYSTALS -- the premium currency, sold in fixed packages via
        // Stripe Checkout (see billing.js). A brand-new account always
        // starts at 0; there is no free way to earn Crystals by design
        // -- see /admin/currency for the one exception (a logged,
        // reason-required manual adjustment).
        crystals: 0,
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
        blocked: [],
        // BATTLE PASS -- season xp/tier/premium-ownership/claim state.
        // See battlepass.js. Cosmetics it grants live in the
        // ownedBanners/ownedPlayerIcons/ownedEmotes/ownedKillEffects/
        // ownedAbilityCosmetics/ownedBadges arrays below (skins land in
        // the existing ownedSkins) -- those are permanent and NEVER
        // reset by a season rollover, only battlePass itself is.
        battlePass: Object.assign(BattlePass.defaultRecord(), { seasonId: BATTLE_PASS_SEASON.id }),
        ownedBanners: [],
        ownedPlayerIcons: [],
        ownedEmotes: [],
        ownedKillEffects: [],
        ownedAbilityCosmetics: [],
        ownedBadges: [],
        equippedBanner: null,
        equippedPlayerIcon: null,
        equippedKillEffect: null,
        // VOIDBREAK CLOUD SAVE -- null means "this account has never
        // saved Voidbreak progress to the cloud yet" (distinct from an
        // all-zero save, which is a real save that just hasn't earned
        // anything). See voidbreak.js and the /voidbreak/* endpoints.
        voidbreak: null,
        // PLAYTIME -- see the PLAYTIME section below. A brand-new account
        // has no history to estimate, so estimateDone starts true.
        playtime: defaultPlaytime(true)
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

// Same lazy-migration shape as ensureAccountRanked: rolls a missing/
// malformed/previous-season battlePass sub-record to a fresh one valid
// for the CURRENTLY active season, persists only if something actually
// changed, and never touches the permanent owned-cosmetic arrays (those
// are separate fields, granted once by /battlepass/claim and never
// reset). Also backfills the handful of new cosmetic-inventory fields
// (ownedBanners, etc.) for any account older than this feature.
function ensureAccountBattlePass(sub) {
    const account = accounts[sub];
    if (!account) return null;
    let dirty = false;

    const ensured = BattlePass.ensureRecord(account.battlePass, BATTLE_PASS_SEASON.id);
    if (ensured !== account.battlePass) {
        account.battlePass = ensured;
        dirty = true;
    }
    const arrayFields = ["ownedBanners", "ownedPlayerIcons", "ownedEmotes", "ownedKillEffects", "ownedAbilityCosmetics", "ownedBadges"];
    for (const field of arrayFields) {
        if (!Array.isArray(account[field])) {
            account[field] = [];
            dirty = true;
        }
    }
    if (!("equippedBanner" in account)) { account.equippedBanner = null; dirty = true; }
    if (!("equippedPlayerIcon" in account)) { account.equippedPlayerIcon = null; dirty = true; }
    if (!("equippedKillEffect" in account)) { account.equippedKillEffect = null; dirty = true; }

    if (dirty) {
        persistAccount(sub).catch(e =>
            console.log("[battlepass] failed to persist battlePass migration for " + sub + ":", e.message));
    }
    return account.battlePass;
}

// Grants ONE reward part onto an account's in-memory record. Never
// persists on its own -- every caller is already inside its own atomic
// read-modify-write-then-persist-with-rollback block (mirrors /shop/buy
// crediting a currency field or appending to an owned-item array), so
// this stays a pure mutation the caller can undo by simply not
// persisting. Returns nothing; the account object is mutated in place.
function grantBattlePassReward(account, reward) {
    if (!reward || typeof reward !== "object") return;
    if (reward.type === "coins") {
        account.coins = (account.coins || 0) + (reward.amount || 0);
    } else if (reward.type === "crystals") {
        account.crystals = (account.crystals || 0) + (reward.amount || 0);
    } else if (reward.type === "xp_boost") {
        account.battlePass.boostCharges = (account.battlePass.boostCharges || 0) + (reward.amount || 1);
    } else {
        const ownedField = BattlePass.OWNED_FIELD[reward.type];
        if (!ownedField || !reward.id) return;
        const owned = Array.isArray(account[ownedField]) ? account[ownedField] : [];
        if (owned.indexOf(reward.id) === -1) account[ownedField] = owned.concat([reward.id]);
    }
}

// Adds Battle-Pass-only XP to an account already loaded in memory (never
// persists -- folded into whatever write the caller is already doing,
// exactly like the ranked_win/ranked_loss XP mutation inside
// completeRankedMatch does for account.xp). Doubles the gain while a
// boost is active (and clears an expired one first) -- this multiplier
// only ever touches battlePass.xp, never account.xp/coins/crystals.
function addBattlePassXP(account, amount) {
    if (!account || !account.battlePass || amount <= 0) return;
    const bp = account.battlePass;
    if (bp.boostActiveUntil && bp.boostActiveUntil < Date.now()) bp.boostActiveUntil = 0;
    const boosted = bp.boostActiveUntil && bp.boostActiveUntil > Date.now();
    bp.xp = (bp.xp || 0) + Math.floor(amount * (boosted ? BattlePass.BOOST_MULTIPLIER : 1));
}

// Resolves a sessionToken to that player's account record, or null.
// =====================================================================
// ACCOUNT IDENTITY / CREDENTIALS
//
// An account is keyed by a STABLE internal id and nothing else:
//   Google accounts   -> the Google "sub"
//   password accounts -> "local:" + random, minted once at registration
//
// The login username is deliberately NOT the identity. It is a separate,
// changeable field, so renaming later never has to touch friend lists,
// ranked records, or anything else that stores an account id.
//
// Three distinct things, kept distinct:
//   accountId   -- the map key. Never changes, never shown to players.
//   username    -- the login identifier. Unique, case-insensitive.
//   name        -- the in-game DISPLAY name (pre-existing field). Not
//                  unique, and never overwritten for a Google account.
// =====================================================================

// usernameLower -> accountId. Rebuilt from the accounts map at boot, so
// it can never drift from what is actually stored.
const usernameIndex = new Map();

function indexUsername(accountId, account) {
    if (account && typeof account.usernameLower === "string" && account.usernameLower) {
        usernameIndex.set(account.usernameLower, accountId);
    }
}

function buildUsernameIndex() {
    usernameIndex.clear();
    for (const id of Object.keys(accounts)) indexUsername(id, accounts[id]);
    if (usernameIndex.size) console.log("[auth] indexed " + usernameIndex.size + " username(s)");
}

function newLocalAccountId() {
    return "local:" + crypto.randomBytes(16).toString("hex");
}

// THE ONLY shape of an account that is ever sent to a client.
//
// The account record holds a password hash. Several endpoints hand the
// whole record back (sign-in returns it so the client can populate
// progression in one round trip), so allowing the raw object out even
// once would leak every player's hash. Everything sensitive is stripped
// here, by omission from an explicit allowlist rather than by deleting
// fields -- a field added to the account later is then private by
// default instead of accidentally public.
function publicAccount(account) {
    if (!account || typeof account !== "object") return null;
    const out = {};
    for (const key of Object.keys(account)) {
        if (key === "passwordHash") continue; // never leaves the server
        if (key === "recoveryHash") continue; // ditto -- it is a second password
        if (key === "email") continue;        // not needed by the client, and admin checks key off it
        out[key] = account[key];
    }
    return out;
}

// Failed-login throttling.
const loginThrottle = Auth.createLoginThrottle();

// Registration is throttled separately and much more loosely. Every
// signup counts against the limit (not just failures), so the login
// numbers would be wrong here: several people on ONE shared address --
// a household, a school, a cafe -- legitimately create accounts in a
// burst, and locking that out would be worse than the abuse it stops.
// Recovery is the highest-value target on the server -- one correct
// guess takes an account over outright -- so it gets a much tighter
// budget than login.
const recoverThrottle = Auth.createLoginThrottle({
    maxFailures: 5,
    windowMs: 30 * 60 * 1000,
    lockoutMs: 15 * 60 * 1000
});

const registerThrottle = Auth.createLoginThrottle({
    maxFailures: 20,               // signups per window, per address
    windowMs: 60 * 60 * 1000,      // one hour
    lockoutMs: 10 * 60 * 1000
});

// Compared against when the username does not exist, so a failed login
// costs the same time either way and cannot be used to tell real
// usernames from fake ones by response latency. Generated once at boot
// from a random value nobody can log in with.
let DUMMY_PASSWORD_HASH = "";
Auth.hashPassword(crypto.randomBytes(32).toString("hex"))
    .then(h => { DUMMY_PASSWORD_HASH = h; })
    .catch(() => { DUMMY_PASSWORD_HASH = "scrypt$32768$8$1$AAAA$AAAA"; });

// Best-effort client address for rate limiting. x-forwarded-for is only
// consulted because Render terminates TLS in front of the app; it is
// used for THROTTLING ONLY and never for identity or authorisation, so
// a spoofed header can at worst throttle the spoofer.
function clientIpOf(req) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
    return (req.socket && req.socket.remoteAddress) || "unknown";
}

// Ends a session everywhere: this instance, and the store, so a restart
// cannot resurrect it.
async function destroySession(token) {
    if (typeof token !== "string" || !token) return;
    delete sessions[token];
    delete sessionLastSeen[token];
    try {
        await store.deleteSession(token);
    } catch (e) {
        console.log("[auth] failed to delete stored session:", e.message);
    }
}

// token -> last time it was used. Backs the idle sweep below.
const sessionLastSeen = Object.create(null);

// A session left behind by a closed tab (the unload beacon can be
// dropped by the browser) would otherwise sit in the store until its
// 30-day TTL. Anything unused for this long is reaped instead, which
// keeps the set of live sessions close to the set of people actually
// playing.
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const token of Object.keys(sessionLastSeen)) {
        if (now - sessionLastSeen[token] > SESSION_IDLE_MS) {
            destroySession(token).catch(() => {});
        }
    }
}, 60 * 60 * 1000).unref();

function getAccountForSession(sessionToken) {
    const sub = sessions[sessionToken];
    if (!sub) return null;
    sessionLastSeen[sessionToken] = Date.now();
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
// account's xp (and, now, its coins), it NEVER accepts a client-
// supplied amount for either (every call site below passes a fixed,
// server-decided number for a fixed reason string), and it does the
// same atomic read-modify-write-then-persist-with-rollback as
// /challenges/claim. Returns null if the account doesn't exist;
// otherwise the account's new xp/level/coins plus enough about what
// changed for a caller to show "+N XP" / "+N COINS" / "LEVEL UP"
// feedback.
//
// coinAmount defaults to 0 so every pre-existing call site that hasn't
// been given a COIN_REWARDS lookup yet (there are none left, but this
// keeps the function safe against a future one) simply awards no coins
// rather than throwing.
async function awardXP(sub, amount, reason, coinAmount) {
    const account = accounts[sub];
    if (!account) return null;
    amount = Math.max(0, Math.floor(amount) || 0);
    coinAmount = Math.max(0, Math.floor(coinAmount) || 0);
    if (amount === 0 && coinAmount === 0) {
        const cur = computeLevelFromXP(account.xp || 0);
        return { awarded: 0, coinsAwarded: 0, reason: reason, totalXp: account.xp || 0, totalCoins: account.coins || 0, level: cur.level, xpIntoLevel: cur.xpIntoLevel, xpForNextLevel: cur.xpForNextLevel, leveledUp: false, levelsGained: 0 };
    }

    const previousXp = account.xp || 0;
    const previousLevel = account.level || 1;
    const previousCoins = account.coins || 0;
    const newTotal = previousXp + amount;
    const derived = computeLevelFromXP(newTotal);

    account.xp = newTotal;
    account.level = derived.level;
    account.coins = previousCoins + coinAmount;

    // Battle Pass XP rides the same events as account XP (every reason
    // this function is ever called for is already a trustworthy,
    // server-decided amount) -- see addBattlePassXP. Folded into this
    // SAME persist rather than a second write, and rolled back together
    // if it fails, exactly like coins already is above.
    if (!account.battlePass) account.battlePass = BattlePass.defaultRecord();
    const previousBattlePass = account.battlePass;
    account.battlePass = Object.assign({}, previousBattlePass);
    addBattlePassXP(account, amount);

    try {
        await persistAccount(sub);
    } catch (e) {
        account.xp = previousXp; // write failed -- undo the in-memory grant
        account.level = previousLevel;
        account.coins = previousCoins;
        account.battlePass = previousBattlePass;
        console.log("[xp] failed to persist XP/coin award for " + sub + ":", e.message);
        return null;
    }

    return {
        awarded: amount,
        coinsAwarded: coinAmount,
        reason: reason,
        totalXp: newTotal,
        totalCoins: account.coins,
        level: derived.level,
        xpIntoLevel: derived.xpIntoLevel,
        xpForNextLevel: derived.xpForNextLevel,
        leveledUp: derived.level > previousLevel,
        levelsGained: derived.level - previousLevel
    };
}

// Convenience wrapper for the fully server-authoritative award sites
// (Heist base destroyed, Bomb Run match won, Ranked match complete) --
// awards XP+Coins to the account behind a live casual WebSocket
// connection (identified via conn.authSub, set by presence_hello -- see
// the "Casual connection identity" section below) and, if that socket
// is still open, tells its own client right away via a small `xpAward`
// message (it now also carries coinsAwarded/totalCoins) so the
// in-match/lobby toast can show up without a poll. Silently does
// nothing if the connection was never authenticated (a guest with no
// account has nothing to award) -- calling code never needs its own
// "is this player signed in" branch.
async function awardXPAndNotify(conn, amount, reason, coinAmount) {
    if (!conn || !conn.authSub) return;
    const result = await awardXP(conn.authSub, amount, reason, coinAmount);
    if (result) send(conn, Object.assign({ type: "xpAward" }, result));
}

// ---------------------------------------------------------------------
// The one function that actually grants Crystals for a real-money
// purchase. Called ONLY from the Stripe webhook handler, and only
// after that handler has already verified the event's signature --
// this function itself does not re-verify anything about Stripe, but
// it DOES independently re-validate the metadata against billing.js's
// own package list (never trusting the numbers in the event alone),
// and it claims the idempotency slot in the purchase ledger BEFORE
// touching the account, so a duplicate delivery of the same webhook
// event (Stripe's own retry behavior, or two instances racing) grants
// Crystals at most once. Never called with anything the CLIENT sent
// directly -- `session` here is Stripe's own object, reached only
// through a signature-verified webhook event.
// ---------------------------------------------------------------------
async function grantCrystalsForCheckoutSession(session) {
    const sessionId = session && session.id;
    if (!sessionId) return;

    const metadata = session.metadata || {};
    const accountId = metadata.accountId;
    const packageId = metadata.packageId;
    const crystals = parseInt(metadata.crystals, 10);

    if (typeof accountId !== "string" || !accountId ||
        typeof packageId !== "string" || !Number.isInteger(crystals) || crystals <= 0) {
        console.log("[billing] session " + sessionId + " has missing/invalid metadata -- refusing to grant");
        return;
    }

    // Re-derived from OUR OWN package list, never trusted from the
    // event alone -- metadata could only ever have been set by this
    // server's own createCheckoutSession(), but this is the second,
    // independent check that what's about to be granted matches a
    // real, currently-defined package.
    const pkg = Billing.findPackage(packageId);
    if (!pkg || pkg.crystals !== crystals) {
        console.log("[billing] session " + sessionId + "'s metadata does not match a real package -- refusing to grant");
        return;
    }

    const amountUsdCents = typeof session.amount_total === "number" ? session.amount_total : pkg.usdCents;

    // Claims this session id in the ledger FIRST, atomically (see
    // storage.js). A null return means it was already there -- this
    // exact session has already been processed, by this delivery or an
    // earlier duplicate of it, so stop here WITHOUT crediting anything.
    const claimed = await store.recordPurchaseIfNew({
        sessionId: sessionId,
        accountId: accountId,
        paymentIntentId: session.payment_intent || null,
        packageId: pkg.id,
        crystals: pkg.crystals,
        amountUsdCents: amountUsdCents,
        status: "granted"
    });
    if (!claimed) {
        console.log("[billing] session " + sessionId + " already processed -- not granting Crystals again");
        return;
    }

    const account = accounts[accountId];
    if (!account) {
        // Genuinely nowhere to put the Crystals (the account was
        // deleted, or the metadata pointed at something stale). Marked
        // distinctly in the ledger so this is auditable rather than
        // silently lost.
        await store.updatePurchase(sessionId, { status: "account_missing" }).catch(() => {});
        console.log("[billing] session " + sessionId + " references unknown account " + accountId);
        return;
    }

    const previousBalance = account.crystals || 0;
    account.crystals = previousBalance + pkg.crystals;
    try {
        await persistAccount(accountId);
    } catch (e) {
        account.crystals = previousBalance; // undo the in-memory grant
        // The ledger still says "granted" from the claim above -- mark
        // it as a failed grant instead so it's visible for manual
        // reconciliation (see /admin/currency) rather than silently
        // stuck. This narrow window (ledger claimed, account write
        // failed) is the one place a real cross-table transaction would
        // remove entirely; documented here rather than hidden.
        await store.updatePurchase(sessionId, { status: "grant_failed" }).catch(() => {});
        console.log("[billing] FAILED to persist Crystal grant for " + accountId + " (session " + sessionId + "):", e.message);
        return;
    }

    console.log("[billing] granted " + pkg.crystals + " crystals to " + accountId + " (session " + sessionId + ", $" + (amountUsdCents / 100).toFixed(2) + ")");
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

// ---------------------------------------------------------------------
// CURRENCY MIGRATION -- "Credits" -> "Coins", plus adding Crystals.
//
// This is a rename of the SAME balance, not a reset: an account's old
// `credits` NUMBER becomes its new `coins` number, unchanged, and the
// old field is then removed (this codebase fully owns the account
// record's shape end to end, so there is no external reader anywhere
// still expecting `credits` -- a clean rename is safe here in a way it
// would not be against a public API). Idempotent and never destructive,
// same as ensureAccountXP/ensureAccountRanked/ensureFriendsRecord above:
// an account that has already been migrated (has a numeric `coins`, no
// `credits`) is left completely alone.
//
// Called once, at boot, over every account already in the loaded cache
// (see migrateAllAccountsCurrency() below) -- unlike ensureAccountXP,
// this never needs a second per-request call site, because every
// account that will EVER exist after boot is either (a) already in the
// cache and covered by that one pass, or (b) created fresh afterwards
// via defaultAccount(), which already starts with coins/crystals in the
// new shape and so never needs migrating at all.
function ensureAccountCurrency(sub) {
    const account = accounts[sub];
    if (!account) return false;
    let dirty = false;

    if (typeof account.coins !== "number" || !isFinite(account.coins) || account.coins < 0) {
        // The old balance, if this account predates the rename.
        // Preserved exactly -- this is a rename, never a reset.
        account.coins = (typeof account.credits === "number" && isFinite(account.credits) && account.credits >= 0)
            ? Math.floor(account.credits) : 0;
        dirty = true;
    }
    if (Object.prototype.hasOwnProperty.call(account, "credits")) {
        delete account.credits; // the rename is complete; nothing reads this field any more
        dirty = true;
    }
    if (typeof account.crystals !== "number" || !isFinite(account.crystals) || account.crystals < 0) {
        account.crystals = 0; // every existing account gets crystals:0, never crystals:undefined
        dirty = true;
    }

    return dirty;
}

// Runs the migration above over every account already in memory --
// called once at boot, right after the store's accounts are loaded (see
// startServer()), so the leaderboard/admin panel/every sign-in shows
// the renamed field immediately rather than only after that ONE
// account happens to be touched again. Mirrors reconcileFriendships()'s
// "normalise everything once, persist only what actually changed" shape.
// =====================================================================
// PLAYTIME -- how long each player has actually been connected.
//
// MEASURED time (`seconds`) accrues from the presence system: an account
// is "playing" while it has at least one authenticated live connection
// (the same signal the friends list and lobby chat already trust). A
// periodic tick banks elapsed time for everyone online, and the last
// disconnect banks the remainder, so a server restart loses at most one
// tick rather than a whole session. Each tick is clamped, so a suspended
// or stalled process can never book a multi-hour jump.
//
// This never existed before, so there is no true record of time played
// prior to it. What CAN be recovered is an ESTIMATE from durable stats
// every account already carries (casual wins/kills, ranked games,
// Voidbreak runs). It lives in a separate field (`estimatedSeconds`),
// is computed exactly once per account (`estimateDone`), and the admin
// panel labels it as an estimate -- it is never folded into the
// measured counter, so the measured number stays a real measurement.
// =====================================================================
const PLAYTIME_TICK_MS = 60 * 1000;
const PLAYTIME_MAX_TICK_SEC = 150;          // clamp per accrual step
const PLAYTIME_PERSIST_EVERY_MS = 5 * 60 * 1000;
// Estimation assumptions (minutes per unit of recorded activity).
const EST_MIN_PER_CASUAL_MATCH = 4;
const EST_MIN_PER_RANKED_GAME = 5;
const EST_MIN_PER_VOIDBREAK_RUN = 6;
const EST_CASUAL_MATCHES_PER_WIN = 2;       // assumes ~50% win rate
const EST_KILLS_PER_MATCH = 3;
const EST_MAX_SECONDS = 2000 * 3600;        // sanity cap for corrupt stats

function defaultPlaytime(estimateDone) {
    return { seconds: 0, estimatedSeconds: 0, estimateBasis: "", estimateDone: !!estimateDone,
             firstSeenAt: 0, lastSeenAt: 0, sessions: 0 };
}

function safeNum(n) {
    const v = Math.floor(Number(n));
    return isFinite(v) && v > 0 ? v : 0;
}

// Pure. Casual wins and kills describe the SAME casual matches, so the
// larger of the two match estimates is used rather than their sum.
function estimatePriorPlaytime(account) {
    const wins = safeNum(account.wins);
    const kills = safeNum(account.kills);
    const ranked = safeNum(account.ranked && account.ranked.games);
    const vbRuns = safeNum(account.voidbreak && account.voidbreak.data && account.voidbreak.data.runs);
    const casual = Math.max(wins * EST_CASUAL_MATCHES_PER_WIN, Math.ceil(kills / EST_KILLS_PER_MATCH));
    const minutes = casual * EST_MIN_PER_CASUAL_MATCH + ranked * EST_MIN_PER_RANKED_GAME +
        vbRuns * EST_MIN_PER_VOIDBREAK_RUN;
    const parts = [];
    if (casual) parts.push("~" + casual + " casual matches");
    if (ranked) parts.push(ranked + " ranked games");
    if (vbRuns) parts.push(vbRuns + " Voidbreak runs");
    return { seconds: Math.min(EST_MAX_SECONDS, minutes * 60), basis: parts.join(", ") };
}

// Idempotent. Fills a missing/malformed playtime block and runs the
// one-time historical estimate. Returns true if anything changed.
function ensureAccountPlaytime(sub) {
    const account = accounts[sub];
    if (!account) return false;
    let dirty = false;
    const pt = account.playtime;
    if (!pt || typeof pt !== "object") {
        account.playtime = defaultPlaytime(false);
        dirty = true;
    } else {
        const d = defaultPlaytime(false);
        for (const k of Object.keys(d)) {
            if (typeof pt[k] !== typeof d[k]) { pt[k] = d[k]; dirty = true; }
        }
    }
    if (!account.playtime.estimateDone) {
        const est = estimatePriorPlaytime(account);
        account.playtime.estimatedSeconds = est.seconds;
        account.playtime.estimateBasis = est.basis;
        account.playtime.estimateDone = true;
        dirty = true;
    }
    return dirty;
}

// Admin-only view of one account's activity. Includes the live,
// not-yet-banked part of an ongoing session so the panel is current.
function adminActivityFields(sub) {
    const account = accounts[sub];
    ensureAccountPlaytime(sub);
    const pt = account.playtime;
    const row = presence.get(sub);
    const online = !!(row && row.conns.size > 0);
    const live = online && row.playAnchor
        ? Math.max(0, Math.min(PLAYTIME_MAX_TICK_SEC, Math.floor((Date.now() - row.playAnchor) / 1000))) : 0;
    const measured = pt.seconds + live;
    const email = account.email || "";
    return {
        email: email,
        emailIsGmail: /@(gmail|googlemail)\.com$/i.test(email),
        signInMethod: String(sub).indexOf("local:") === 0 ? "password" : "google",
        online: online,
        playtimeSeconds: measured,
        playtimeEstimatedSeconds: pt.estimatedSeconds,
        playtimeTotalSeconds: measured + pt.estimatedSeconds,
        playtimeEstimateBasis: pt.estimateBasis,
        playSessions: pt.sessions,
        firstSeenAt: pt.firstSeenAt,
        lastSeenAt: online ? Date.now() : pt.lastSeenAt
    };
}

function migrateAllAccountsPlaytime() {
    let n = 0;
    for (const sub of Object.keys(accounts)) {
        if (ensureAccountPlaytime(sub)) {
            n++;
            persistAccount(sub).catch(e =>
                console.log("[playtime] migration write failed for " + sub + ":", e.message));
        }
    }
    if (n) console.log("[playtime] initialised playtime for " + n + " account(s) (historical time estimated)");
}

// Banks elapsed connected time for one presence row into its account.
function accruePlaytime(sub, row, now, forcePersist) {
    const account = accounts[sub];
    if (!account || !row) return;
    ensureAccountPlaytime(sub);
    const pt = account.playtime;
    const anchor = row.playAnchor || now;
    const sec = Math.max(0, Math.min(PLAYTIME_MAX_TICK_SEC, Math.floor((now - anchor) / 1000)));
    // Advance by whole banked seconds only, so fractions carry over.
    row.playAnchor = sec > 0 ? anchor + sec * 1000 : anchor;
    if ((now - row.playAnchor) / 1000 > PLAYTIME_MAX_TICK_SEC) row.playAnchor = now;
    pt.seconds += sec;
    pt.lastSeenAt = now;
    if (forcePersist || now - (row.playPersistedAt || 0) >= PLAYTIME_PERSIST_EVERY_MS) {
        row.playPersistedAt = now;
        persistAccount(sub).catch(e =>
            console.log("[playtime] persist failed for " + sub + ":", e.message));
    }
}

function migrateAllAccountsCurrency() {
    let migrated = 0;
    for (const sub of Object.keys(accounts)) {
        if (ensureAccountCurrency(sub)) {
            migrated++;
            persistAccount(sub).catch(e =>
                console.log("[currency] migration write failed for " + sub + ":", e.message));
        }
    }
    if (migrated) {
        console.log("[currency] migrated " + migrated + " account(s): credits -> coins" +
            (migrated ? ", crystals:0 added where missing" : ""));
    }
}

// Fixed, server-decided XP amounts. This is the ONE place XP values for
// each event live, per the "centralized so it's easy to rebalance"
// requirement -- nothing else in this file hardcodes an XP number.
const XP_REWARDS = {
    round_win: 15,
    match_win: 40,
    kill: 4,
    football_goal: 12,
    // Bomb Run mirrors Football everywhere else in this codebase (goal
    // scored, match won) but was missing this one XP entry -- a goal
    // never granted XP at all, purely an oversight from when Bomb Run
    // was added. Given the SAME value as football_goal since the two
    // modes are treated as equivalent everywhere else.
    bombrun_goal: 12,
    heist_win: 50,
    bombrun_win: 50,
    ranked_win: 60,
    ranked_loss: 10,
    voidbreak_complete: 80,
    // Co-op Voidbreak. Granted by the SERVER when its own simulation
    // confirms the run was completed (see payCoopPlayer) -- there is no
    // client report for it, and /xp/report refuses the reason outright,
    // exactly like heist_win/bombrun_win/ranked_win.
    voidbreak_coop_complete: 90
};

// COINS earned for the same fixed set of reasons XP already is, so both
// currencies flow through the identical trust boundary/throttle
// (/xp/report below) with zero new endpoints. Values match what
// index.html used to add to its own local `credits` variable before
// the server-authoritative shop rewrite made that number stop actually
// persisting -- this table is what makes "receiving Coins" for a kill
// or a match win real again, server-side, rather than a client-side
// number that silently never reached the account.
//
// round_win/ranked_win/ranked_loss/voidbreak_complete are 0 on purpose:
// none of those ever paid out Coins/Credits in this game either, only
// XP -- this table preserves that, it does not invent new income.
// match_win's FULL amount (including the classic-mode FFA player-count
// bonus) is computed in the /xp/report handler, not looked up flatly
// from here -- see the handler for why.
const COIN_REWARDS = {
    round_win: 0,
    match_win: 40,
    kill: 15,
    football_goal: 15,
    bombrun_goal: 15,
    heist_win: 50,
    bombrun_win: 50,
    ranked_win: 0,
    ranked_loss: 0,
    voidbreak_complete: 0,
    // A co-op run is a real cooperative match, so unlike a solo clear it
    // pays Coins as well -- at the same rate a Heist/Bomb Run win does.
    voidbreak_coop_complete: 50
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
    bombrun_goal: 800,
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

// Raw-bytes body reader for the ONE route that needs it (the Stripe
// webhook, below): Stripe signs the exact bytes it sent, so verifying
// that signature against a re-serialized JSON.parse/stringify round
// trip (which can reorder keys or change whitespace) would fail a
// perfectly genuine event. Returns a Buffer, never a decoded string.
function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", chunk => {
            size += chunk.length;
            if (size > 1e6) { req.destroy(); return; } // Stripe events are small; this is a basic size guard
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

// The origin (scheme + host) this request itself arrived on, used to
// build Stripe's success/cancel redirect URLs so they always point
// back at whatever this game is actually being served from -- this
// deployment's Render URL, a custom domain, or localhost in dev --
// without a separate PUBLIC_ORIGIN env var to keep in sync by hand.
// Render's proxy sets x-forwarded-proto; a direct local connection has
// neither header, so falls back to whether THIS socket is itself TLS.
function originOf(req) {
    const proto = req.headers["x-forwarded-proto"] || (req.socket && req.socket.encrypted ? "https" : "http");
    const host = req.headers.host || ("localhost:" + PORT);
    return proto + "://" + host;
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
    quickreload: { reloadSpeedPercent: 40, ammoPenalty: 2 },
    gravitytrap: { pullRadius: 130, pullStrength: 90, slowPercent: 50, duration: 3.0, cooldown: 9.0 },
    phaseshift:  { duration: 1.0, cooldown: 14.0 },
    huntersmark: { homingTurnRate: 70, range: 260, cooldown: 6.0 },
    portal:      { duration: 6.0, cooldown: 18.0 },
    overcharge:  { damage: 2, speed: 780, hitboxPercent: 130, reloadPenaltyPercent: 130, duration: 3.0, cooldown: 15.0 }
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
    ammoPenalty:         [0, 5],
    pullRadius:          [0, 500],
    pullStrength:        [0, 500],
    homingTurnRate:      [0, 360],
    hitboxPercent:       [100, 300],
    reloadPenaltyPercent:[100, 300]
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
// /save path as the account's lifetime kills/wins already do (see the
// /save handler) -- that trust level is this codebase's existing,
// deliberate tradeoff, not a new one introduced here. Credits are NOT
// part of that tradeoff any more: /save no longer accepts a
// client-supplied balance at all (see catalog.js / /shop/buy), so the
// same lie-about-progress ceiling applies here as everywhere else that
// reads kills/wins. What is
// NOT client-trusted is the reward itself: /challenges/claim
// independently recomputes today's canonical challenge set, checks the
// account's own stored progress against it, checks the claimed flag,
// and increments coins by the server's own copy of the reward amount
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

// The currently active Battle Pass season. A plain, server-owned mutable
// copy of BattlePass.DEFAULT_SEASON (never the module's own object,
// which would be shared/frozen-by-convention state across requires) --
// mirrors how RANKED_CONFIG.season is bumped by /admin/ranked and
// persisted so a restart doesn't snap back to the code default. See
// startServer() for the boot-time load and /admin/battlepass for the
// only place this is ever written.
let BATTLE_PASS_SEASON = Object.assign({}, BattlePass.DEFAULT_SEASON);

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
    match.shadow = SHADOW_HIT_DETECTION ? Shadow.createShadowDetector() : null;
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
        // Same Battle Pass XP hook awardXP() has, folded into this same
        // persist for the same reason the ranked result itself is.
        if (!account.battlePass) account.battlePass = BattlePass.defaultRecord();
        addBattlePassXP(account, xpAmount);
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

// ---------------------------------------------------------------------
// CASUAL LEADERBOARD -- same caching as the ranked one above, and for
// the same reason. /leaderboard used to map AND sort every account in
// the store on every single request, synchronously, on the one thread
// the relay runs on. With a few hundred accounts that is a millisecond
// of everybody's packets sitting still; it grows with the player base,
// and the panel that calls it refetches on every sort toggle.
//
// Three keys, so three small cached arrays. Only the public columns are
// ever materialised -- exactly what the endpoint already returned.
// ---------------------------------------------------------------------
const CASUAL_LB_TTL_MS = 5000;
const casualLbCache = Object.create(null); // sortKey -> { at, rows }

function getCasualLeaderboard(sortKey) {
    const now = Date.now();
    const cached = casualLbCache[sortKey];
    if (cached && now - cached.at < CASUAL_LB_TTL_MS) return cached.rows;

    const rows = Object.values(accounts)
        .map(a => ({ name: a.name, coins: a.coins, kills: a.kills, wins: a.wins }))
        .sort((a, b) => b[sortKey] - a[sortKey])
        .slice(0, 20);

    casualLbCache[sortKey] = { at: now, rows: rows };
    return rows;
}

// ---------------------------------------------------------------------
// VOIDBREAK LEADERBOARD -- same cached-array shape as the two above, and
// for the same reason (don't sort every account on every request).
//
// Ranked by things that can only rise, and only through actually playing
// the mode -- never by spendable Void Shards (a balance that goes DOWN
// when spent would make the ladder punish the shop/prestige systems this
// same feature ships) and never by anything client-reported without a
// server-side floor under it:
//   1. prestige level     -- server-owned (voidbreak.js's applyPrestige),
//                             and by construction requires having finished
//                             every weapon/upgrade/level at least once.
//   2. kills (bosses slain) -- lifetime, incremented once per level
//                             clear, preserved across prestige.
//   3. mastery total       -- sum of every weapon's mastery LEVEL (not
//                             raw XP, which is client-reported and only
//                             rate-limited, not verified) across all six
//                             weapons; capping the input to a level via
//                             masteryLevelFromXp bounds how much one
//                             inflated save can move this column.
//   4. best (best sector)  -- lifetime deepest single-run clear depth.
//   5. runs                -- last-resort tiebreak only; more runs alone
//                             is not a goal, it only separates players
//                             already tied on every stat above.
// =====================================================================
const VOIDBREAK_LB_TTL_MS = 5000;
let voidbreakLbCache = { at: 0, rows: [] };

function getVoidbreakLeaderboard() {
    const now = Date.now();
    if (now - voidbreakLbCache.at < VOIDBREAK_LB_TTL_MS) return voidbreakLbCache.rows;

    const rows = [];
    for (const sub of Object.keys(accounts)) {
        const account = accounts[sub];
        const vb = account && account.voidbreak;
        const save = vb && vb.data;
        // Only accounts that have actually played Voidbreak belong on the
        // ladder -- same "must have played" gate the ranked ladder uses,
        // just against Voidbreak's own stats instead of ranked games.
        if (!save) continue;
        const prestige = (save.prestige || {}).level || 0;
        if (!((save.runs || 0) > 0 || (save.kills || 0) > 0 || prestige > 0)) continue;

        let mastery = 0;
        for (const key of Voidbreak.WEAPON_KEYS) {
            mastery += Voidbreak.masteryLevelFromXp((save.mastery || {})[key] || 0);
        }
        rows.push({
            sub: sub,
            name: account.name || "Player",
            prestige: prestige,
            kills: save.kills || 0,
            mastery: mastery,
            best: save.best || 0,
            runs: save.runs || 0
        });
    }
    rows.sort((a, b) => (b.prestige - a.prestige) || (b.kills - a.kills) || (b.mastery - a.mastery) || (b.best - a.best) || (b.runs - a.runs));

    voidbreakLbCache = { at: now, rows: rows };
    return rows;
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
        // Playtime session starts.
        row.playAnchor = Date.now();
        row.playPersistedAt = Date.now();
        if (accounts[sub]) {
            ensureAccountPlaytime(sub);
            const pt = accounts[sub].playtime;
            if (!pt.firstSeenAt) pt.firstSeenAt = Date.now();
            pt.lastSeenAt = Date.now();
            pt.sessions += 1;
        }
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
        accruePlaytime(sub, row, Date.now(), true); // bank the tail of the session
        presence.delete(sub);
        return true;
    }
    return false;
}

// Periodically bank playtime for everyone online (see PLAYTIME above).
setInterval(() => {
    const now = Date.now();
    for (const [sub, row] of presence) {
        if (row.conns.size > 0) accruePlaytime(sub, row, now, false);
    }
}, PLAYTIME_TICK_MS).unref();

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

// =====================================================================
// LOBBY CHAT -- routing.
//
// The room itself (validation, rate limits, filter, history) lives in
// chat.js. This half decides WHO a message reaches, and it reuses the
// presence system for it rather than tracking its own membership: an
// account is "in the lobby" exactly when the presence system says its
// activity is `online` -- not inMatch, not voidbreak. That is the same
// server-verified signal the friends list uses, so a client cannot put
// itself in the room by claiming to be there.
//
// Chat is delivered only over PRESENCE connections. The main gameplay
// socket authenticates with the same presence_hello, so without this
// filter a player sitting in the lobby with a gameplay socket open
// would receive every message twice.
// =====================================================================

// Off with CHAT_FILTER_ENABLED=0. On by default -- a lot of the people
// playing this are children.
const CHAT_FILTER_ENABLED = process.env.CHAT_FILTER_ENABLED !== "0";
const lobbyChat = Chat.createChatRoom({ filterEnabled: CHAT_FILTER_ENABLED });

function isInLobby(sub) {
    return presenceStateOf(sub) === Friends.PRESENCE.ONLINE;
}

function sendChatToAccount(sub, payload) {
    const row = presence.get(sub);
    if (!row) return;
    for (const conn of row.conns) {
        if (conn.presenceOnly) send(conn, payload);
    }
}

// Join lines are SYSTEM messages: they carry no sender, and a client
// cannot produce one -- chat.js only ever stamps kind:"user" on
// anything that arrives from a socket. Announced at most once every few
// minutes per account, so a flapping connection cannot spam the room.
const chatAnnouncedAt = new Map();
const CHAT_JOIN_COOLDOWN_MS = 5 * 60 * 1000;

function announceLobbyJoin(sub) {
    const account = accounts[sub];
    if (!account) return;
    const now = Date.now();
    const last = chatAnnouncedAt.get(sub) || 0;
    if (now - last < CHAT_JOIN_COOLDOWN_MS) return;
    chatAnnouncedAt.set(sub, now);
    const message = lobbyChat.system(String(account.name || "A player") + " joined the lobby.");
    // Everyone EXCEPT the player who just arrived: they do not need to
    // be told they are here, and an unread badge for their own join
    // would be nonsense.
    if (message) broadcastChat({ type: "chat_message", message: message }, sub);
}

function chatHistoryPayload() {
    return {
        type: "chat_history",
        messages: lobbyChat.history(),
        config: {
            maxLength: lobbyChat.config.maxLength,
            filterEnabled: lobbyChat.filterEnabled
        }
    };
}

function broadcastChat(payload, exceptSub) {
    for (const sub of presence.keys()) {
        if (sub === exceptSub) continue;
        if (isInLobby(sub)) sendChatToAccount(sub, payload);
    }
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
            lobbyChat.forget(sub);
        }
    }
    // Join-announcement cooldowns stop mattering once they expire.
    for (const [sub, at] of Array.from(chatAnnouncedAt.entries())) {
        if (now - at > CHAT_JOIN_COOLDOWN_MS) chatAnnouncedAt.delete(sub);
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

// Shared by every admin action (ability balance changes and currency
// adjustments alike) -- the single audit trail, newest first, capped at 100
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
// NEWS & EVENTS -- admin-posted announcements shown in the lobby.
//
// Deliberately just a flat, admin-authored list (title/body/tag),
// newest first, capped at 50 -- the same "no gameplay effect" shape as
// patch notes, except these are postable at runtime by an admin instead
// of requiring a code change/deploy. Nothing here reads or writes an
// account, so it can never touch currency, ownership, or stats.
// =====================================================================
let newsItems = []; // replaced in startServer()

async function loadNewsItems() {
    const stored = await store.loadDoc("news", null);
    return Array.isArray(stored) ? stored : [];
}

function persistNewsItems() {
    store.saveDoc("news", newsItems)
        .catch(e => console.log("[storage] failed to save news:", e.message));
}

const NEWS_TAGS = ["EVENT", "UPDATE", "NEWS"];

function publicNewsItem(item) {
    return { id: item.id, title: item.title, body: item.body, tag: item.tag, createdAt: item.createdAt };
}

// =====================================================================
// ADMIN CURRENCY ADJUSTMENTS -- Coins and Crystals, both.
// =====================================================================
// Sanity ceiling on a single manual adjustment -- not a game-balance
// number, just a guard against a fat-fingered or malicious
// "give 999999999" request. Well above anything a legitimate grant
// would ever need.
const MAX_CURRENCY_ADJUSTMENT = 1000000;

// A whole, nonzero number whose magnitude is within the ceiling above.
// Negative is allowed here (that's how an admin REMOVES currency) --
// whether a specific negative amount is actually safe to apply (i.e.
// doesn't take the balance below zero) is checked separately, against
// the account's live balance, at the point of use. The browser's own
// input validation is just UX; this is what actually decides whether
// an adjustment is allowed through at all.
function isValidCurrencyAdjustment(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n !== 0 && Math.abs(n) <= MAX_CURRENCY_ADJUSTMENT;
}

// The same idea for Voidbreak's own currency (see /admin/voidbreak/grant).
// Generous next to the real economy -- a full level clear pays roughly
// 700-1500 Void Shards -- but bounded, so a typo in the admin panel can't
// write an absurd number into an account.
const MAX_VOID_SHARD_GRANT = 1000000;

// Free-text justification the task requires on every manual
// adjustment. Control characters and newlines are stripped (this is
// rendered later, client-side, through escapeHtml() -- see
// renderAdminLog() -- so the concern here is length/garbage, not
// markup); 3-200 characters after trimming.
function validateAdminReason(raw) {
    if (typeof raw !== "string") return null;
    const reason = raw.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001F\u007F]/g, "").trim();
    if (reason.length < 3 || reason.length > 200) return null;
    return reason;
}

// =====================================================================
// STATIC FILE SERVING
//
// Serves index.html, bgm.mp3, and anything else sitting next to
// server.js. Google Sign-In requires a real http(s) origin -- it will
// not work if index.html is just double-clicked as a local file. Both
// players should visit http://<this computer's IP>:3000 instead.
//
// The actual reading/caching/compressing/ranging lives in static.js.
// It exists because the previous implementation here re-read the whole
// file from disk on every request and sent it back with no validator,
// no Cache-Control, no Content-Length and no compression -- so every
// page view moved ~5 MB (594 KB of HTML + a 4.4 MB mp3) through the
// same event loop the WebSocket relay runs on, and every RELOAD moved
// it again. Measured, that was this server's single biggest source of
// in-match latency spikes: 55 MB of static traffic over 12 seconds took
// ping p99 from 0.67 ms to 7.97 ms. See static.js for the full note.
// =====================================================================
// =====================================================================
// VOIDBREAK SAVE COMMIT
//
// The one place a Voidbreak save record is replaced. Every writer --
// the shop/mastery/prestige HTTP transactions, the admin Void Shard
// grant, and the co-op match rooms in the WebSocket layer -- goes
// through this, so "charged but didn't get the item" and "granted but
// never persisted" are both impossible: the in-memory record is rolled
// back if the account write fails.
//
// It lived inside the HTTP request handler until co-op needed it too.
// The body is unchanged.
// =====================================================================
async function commitVoidbreakSave(sub, account, nextData, opts) {
    const previous = account.voidbreak;
    const version = (previous ? previous.version : 0) + 1;
    account.voidbreak = {
        data: nextData,
        updatedAt: Date.now(),
        version: version,
        // The version at which this account most recently prestiged.
        // /voidbreak/save reads it to spot a device that is still
        // holding a save from before that reset (see the comment
        // there); every other writer just carries it forward.
        prestigeVersion: (opts && opts.markPrestige) ? version
            : (previous ? previous.prestigeVersion || 0 : 0)
    };
    try {
        await persistAccount(sub);
    } catch (e) {
        account.voidbreak = previous;
        return false;
    }
    return true;
}

const Static = require("./static");

const staticServer = Static.createStaticServer(__dirname, {
    // In production the checkout never changes under a running process,
    // so the per-request fs.stat revalidation can be skipped entirely.
    // Locally it stays on, so editing index.html still shows up on the
    // next reload without restarting the server.
    revalidate: process.env.NODE_ENV !== "production"
});

// =====================================================================
// PUBLIC STATIC FILES
//
// The static server resolves any path under the repo root, and the
// route table above falls through to it for every unmatched GET. That
// means GET /accounts.json, GET /server.js and GET /storage.js were all
// being served to anybody who asked -- the account seed (with real
// e-mail addresses) and the whole server source, including the new
// match-room and co-op modules.
//
// This is the allowlist. Only a handful of files are ever requested by
// the game (index.html, voidbreak.html, bgm.mp3 and the one shared
// content module below -- everything else the clients ask for is an API
// route handled above), so the safe set is small and explicit rather
// than a pattern that has to be kept ahead of whatever gets added to
// this directory next.
//
// /voidbreakUniverse.js is the ONE server-side .js file on this list,
// and it is here deliberately: it is the shared definition of what the
// universe contains (galaxies, solar systems, discoveries, planet
// buildings, ship systems), which voidbreak.html needs in order to draw
// any of it. It holds content data and pure lookup helpers only -- no
// credentials, no account data, no server logic, and nothing that
// decides a currency amount on its own (the server re-derives every
// price and gate from its own copy when it validates a request; see
// voidbreak.js's buildOnPlanet). Serving it is exactly as safe as
// serving the level tables already embedded in voidbreak.html.
//
// Adding any OTHER .js from this directory would be a mistake -- the
// rest of them are the server.
// =====================================================================
const PUBLIC_FILES = new Set([
    "/",
    "/index.html",
    "/voidbreak.html",
    "/voidbreakUniverse.js",
    "/bgm.mp3",
    "/favicon.ico",
    "/manifest.webmanifest",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/apple-touch-icon.png",
    "/icons/logo-128.png"
]);

async function serveStatic(req, res) {
    const requested = req.url.split("?")[0];
    if (!PUBLIC_FILES.has(requested)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found: " + requested);
        return;
    }

    let served = false;
    try {
        served = await staticServer.serve(req, res);
    } catch (e) {
        console.log("[static] error serving " + req.url + ":", e.message);
        if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Internal error");
        }
        return;
    }
    if (!served) {
        const urlPath = req.url.split("?")[0];
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found: " + urlPath);
    }
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

    // =================================================================
    // CRYSTAL BILLING -- Stripe Checkout foundation.
    //
    // Flow: client asks for a Checkout Session (server decides the
    // price from billing.js's own package list) -> player pays on
    // Stripe's own hosted page -> Stripe calls the webhook below with a
    // SIGNED event -> the webhook verifies that signature, checks the
    // purchase ledger for "have I already granted this session" (an
    // atomic, database-level check -- see storage.js's
    // recordPurchaseIfNew), and only then credits the account.
    //
    // The client is NEVER trusted to say a payment succeeded, including
    // when it lands back on success_url after Stripe redirects it there
    // -- that redirect fires the instant Stripe's own page thinks the
    // payment is done, well before this server's webhook necessarily
    // has. /billing/crystals/status exists so the client can poll
    // "did the grant actually happen yet" without the answer to that
    // question ever being self-reported.
    // =================================================================

    // ---- GET /billing/crystals/packages ----
    // Public, no auth needed -- this is a price list, not an account.
    // `configured:false` is what the Crystal Shop UI uses to show
    // "not available right now" instead of pretending a purchase button
    // works when STRIPE_SECRET_KEY isn't set in this environment yet.
    if (req.method === "GET" && req.url === "/billing/crystals/packages") {
        sendJson(res, 200, { configured: Billing.isConfigured(), packages: Billing.publicPackages() });
        return;
    }

    // ---- POST /billing/crystals/checkout ----  body: { sessionToken, packageId }
    if (req.method === "POST" && req.url === "/billing/crystals/checkout") {
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
            if (!Billing.isConfigured()) {
                sendJson(res, 503, { error: "Crystal purchases are not available right now." });
                return;
            }
            const pkg = Billing.findPackage(body.packageId);
            if (!pkg) {
                sendJson(res, 400, { error: "Unknown Crystal package" });
                return;
            }

            const origin = originOf(req);
            let session;
            try {
                session = await Billing.createCheckoutSession({
                    accountId: sub,
                    packageId: pkg.id,
                    successUrl: origin + "/?checkout=success&session_id={CHECKOUT_SESSION_ID}",
                    cancelUrl: origin + "/?checkout=cancel"
                });
            } catch (e) {
                console.log("[billing] checkout session creation failed:", e.message);
                sendJson(res, 502, { error: "Could not start checkout -- try again" });
                return;
            }

            sendJson(res, 200, { ok: true, url: session.url, sessionId: session.id });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- GET /billing/crystals/status?sessionToken=...&checkoutSessionId=... ----
    // Lets the client find out whether a specific purchase has actually
    // been granted yet, WITHOUT the answer ever coming from the client
    // itself (it only supplies which session to look up; the ledger,
    // written only by the webhook handler, supplies the answer). Scoped
    // to the caller's own account -- a purchase record from a different
    // account is reported as not found, never leaked.
    if (req.method === "GET" && req.url.startsWith("/billing/crystals/status")) {
        const urlObj = new URL(req.url, "http://x");
        const sub = sessions[urlObj.searchParams.get("sessionToken")];
        if (!sub) {
            sendJson(res, 401, { error: "Not signed in" });
            return;
        }
        const checkoutSessionId = urlObj.searchParams.get("checkoutSessionId") || "";
        const purchase = await store.getPurchase(checkoutSessionId);
        if (!purchase || purchase.accountId !== sub) {
            sendJson(res, 200, { status: "unknown" });
            return;
        }
        sendJson(res, 200, {
            status: purchase.status,
            crystals: purchase.crystals,
            newBalance: purchase.status === "granted" ? (accounts[sub] ? accounts[sub].crystals : null) : null
        });
        return;
    }

    // ---- POST /billing/stripe/webhook ----
    // Stripe calls this directly -- there is no sessionToken, no
    // account-level auth, because the caller isn't a player's browser.
    // What proves this request is genuinely from Stripe (and not
    // forged by anyone who found the URL) is the Stripe-Signature
    // header, verified against STRIPE_WEBHOOK_SECRET below. A request
    // that fails verification is rejected outright; nothing in its body
    // is ever read before that check passes.
    if (req.method === "POST" && req.url === "/billing/stripe/webhook") {
        let rawBody;
        try {
            rawBody = await readRawBody(req);
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
            return;
        }
        if (!Billing.isConfigured() || !Billing.webhookConfigured()) {
            // Not an error a real Stripe webhook would ever trigger
            // (Stripe wouldn't be sending events to an unconfigured
            // deployment), but fails closed rather than pretending.
            sendJson(res, 503, { error: "Webhook not configured" });
            return;
        }

        let event;
        try {
            event = Billing.constructWebhookEvent(rawBody, req.headers["stripe-signature"]);
        } catch (e) {
            console.log("[billing] webhook signature verification FAILED:", e.message);
            sendJson(res, 400, { error: "Invalid signature" });
            return;
        }

        try {
            if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
                const session = event.data.object;
                if (event.type === "checkout.session.async_payment_succeeded" || session.payment_status === "paid") {
                    await grantCrystalsForCheckoutSession(session);
                }
            } else if (event.type === "checkout.session.async_payment_failed") {
                const session = event.data.object;
                if (session && session.id) {
                    await store.updatePurchase(session.id, { status: "failed" }).catch(() => {});
                }
            }
            // Every other event type (and every branch above) still
            // gets a 200 -- acknowledging receipt is what stops Stripe
            // retrying an event this server has no use for.
            sendJson(res, 200, { received: true });
        } catch (e) {
            console.log("[billing] webhook handling error:", e.message);
            // A 500 here makes Stripe retry later, which is what we
            // want if this was a transient failure (e.g. the database
            // was briefly unreachable) rather than a real rejection.
            sendJson(res, 500, { error: "Internal error" });
        }
        return;
    }

    // ---- POST /auth/google ----
    // body: { credential } (the ID token JWT from Google Identity Services)
    // =================================================================
    // USERNAME + PASSWORD AUTHENTICATION
    //
    // The second door into the same account system. Everything a client
    // sends here is validated again server-side -- the browser's own
    // checks exist only so a player sees the problem sooner.
    // =================================================================

    // ---- POST /auth/register ----  body: { username, password, confirm }
    if (req.method === "POST" && req.url === "/auth/register") {
        try {
            const body = await readJsonBody(req);

            const u = Auth.validateLoginUsername(body.username);
            if (!u.ok) { sendJson(res, 400, { error: u.error }); return; }

            const p = Auth.validatePassword(body.password);
            if (!p.ok) { sendJson(res, 400, { error: p.error }); return; }

            if (typeof body.confirm === "string" && body.confirm !== body.password) {
                sendJson(res, 400, { error: "Passwords do not match." });
                return;
            }

            if (usernameIndex.has(u.key)) {
                sendJson(res, 409, { error: "That username is already taken." });
                return;
            }

            // Registration is rate-limited too, so the endpoint can't be
            // used to mass-create accounts or to probe which usernames
            // exist by watching for the 409.
            const ip = clientIpOf(req);
            const gate = registerThrottle.check(["reg:" + ip]);
            if (gate.blocked) {
                sendJson(res, 429, { error: "Too many accounts created from here. Try again later." });
                return;
            }
            registerThrottle.recordFailure(["reg:" + ip]);

            const passwordHash = await Auth.hashPassword(body.password);

            // Issued once, shown once, and stored only as a hash -- this
            // is the ONLY way back into a password account, because
            // there is no verified email to send a reset link to.
            const recoveryCode = Auth.generateRecoveryCode();
            const recoveryHash = await Auth.hashRecoveryCode(recoveryCode);

            // A brand new, stable internal id. Never derived from the
            // username, so the username stays changeable later.
            const accountId = newLocalAccountId();

            // Same starting account every Google player gets. The login
            // username doubles as the initial DISPLAY name; the two are
            // separate fields from here on, and changing one (via
            // /account/username) never touches the other.
            const account = defaultAccount(u.username, "");
            account.authMethods = ["password"];
            account.username = u.username;
            account.usernameLower = u.key;
            account.passwordHash = passwordHash;
            account.recoveryHash = recoveryHash;
            // A password account has no email, and admin is decided by
            // email (see isAdminSession) -- so registering any username,
            // "admin" included, can never confer admin rights.

            accounts[accountId] = account;
            indexUsername(accountId, account);
            await persistAccount(accountId);

            const sessionToken = crypto.randomBytes(24).toString("hex");
            await persistSession(sessionToken, accountId);

            console.log("[auth] new password account registered: " + u.username);
            sendJson(res, 200, {
                sessionToken: sessionToken,
                accountId: accountId,
                account: publicAccount(account),
                isAdmin: false,
                // The one and only time this leaves the server. It is
                // not stored anywhere in the clear, so if the player
                // loses it the account cannot be recovered -- which is
                // exactly the property that makes it safe.
                recoveryCode: recoveryCode
            });
        } catch (e) {
            console.log("[auth] register failed:", e.message);
            sendJson(res, 500, { error: "Something went wrong. Please try again." });
        }
        return;
    }

    // ---- POST /auth/login ----  body: { username, password }
    if (req.method === "POST" && req.url === "/auth/login") {
        try {
            const body = await readJsonBody(req);
            const ip = clientIpOf(req);

            // Deliberately the SAME message for every failure -- unknown
            // username, wrong password, malformed input. Saying which
            // one it was would turn this endpoint into a way to discover
            // who has an account.
            const GENERIC = "Incorrect username or password.";

            const rawUsername = typeof body.username === "string" ? body.username.trim() : "";
            const key = rawUsername.toLowerCase();
            const throttleKeys = ["ip:" + ip, "user:" + key];

            const gate = loginThrottle.check(throttleKeys);
            if (gate.blocked) {
                sendJson(res, 429, { error: "Too many failed attempts. Try again in " + gate.retryAfterSec + "s." });
                return;
            }

            const accountId = usernameIndex.get(key);
            const account = accountId ? accounts[accountId] : null;

            // Verify even when the account doesn't exist, against a
            // dummy hash, so a missing username and a wrong password
            // take the same amount of time. Otherwise the response
            // latency alone reveals which usernames are real.
            const storedHash = (account && typeof account.passwordHash === "string")
                ? account.passwordHash
                : DUMMY_PASSWORD_HASH;
            const okPassword = await Auth.verifyPassword(
                typeof body.password === "string" ? body.password : "", storedHash);

            if (!account || !okPassword) {
                loginThrottle.recordFailure(throttleKeys);
                sendJson(res, 401, { error: GENERIC });
                return;
            }

            loginThrottle.recordSuccess(throttleKeys);

            // Same lazy migrations the Google path runs, so a password
            // account created before a later feature self-heals too.
            const rolledDC = ensureDailyChallenges(account.dailyChallenges);
            if (rolledDC !== account.dailyChallenges) {
                account.dailyChallenges = rolledDC;
                await persistAccount(accountId);
            }
            ensureAccountXP(accountId);
            ensureAccountBattlePass(accountId);

            const sessionToken = crypto.randomBytes(24).toString("hex");
            await persistSession(sessionToken, accountId);

            sendJson(res, 200, {
                sessionToken: sessionToken,
                accountId: accountId,
                account: publicAccount(account),
                // Admin is derived from the stored account, never from
                // the login method or the username.
                isAdmin: isAdminSession(sessionToken)
            });
        } catch (e) {
            console.log("[auth] login failed:", e.message);
            sendJson(res, 500, { error: "Something went wrong. Please try again." });
        }
        return;
    }

    // ---- POST /auth/recover ----
    // body: { username, recoveryCode, newPassword, confirm }
    //
    // The whole "forgot password" flow. There is no email to send a
    // link to, so possession of the recovery code IS the proof of
    // ownership -- see the note above generateRecoveryCode in auth.js.
    if (req.method === "POST" && req.url === "/auth/recover") {
        try {
            const body = await readJsonBody(req);
            const ip = clientIpOf(req);

            // One message for every failure, exactly like /auth/login:
            // a distinct "no such user" would turn this into an account
            // finder, and a distinct "wrong code" would confirm a
            // username exists.
            const GENERIC = "Incorrect username or recovery code.";

            const rawUsername = typeof body.username === "string" ? body.username.trim() : "";
            const key = rawUsername.toLowerCase();

            // Recovery is a far more attractive brute-force target than
            // login (one success takes the account over completely), so
            // it gets its own, tighter budget.
            const throttleKeys = ["rec-ip:" + ip, "rec-user:" + key];
            const gate = recoverThrottle.check(throttleKeys);
            if (gate.blocked) {
                sendJson(res, 429, { error: "Too many attempts. Try again in " + gate.retryAfterSec + "s." });
                return;
            }

            const p = Auth.validatePassword(body.newPassword);
            if (!p.ok) { sendJson(res, 400, { error: p.error }); return; }
            if (typeof body.confirm === "string" && body.confirm !== body.newPassword) {
                sendJson(res, 400, { error: "Passwords do not match." });
                return;
            }

            const accountId = usernameIndex.get(key);
            const account = accountId ? accounts[accountId] : null;

            // Same constant-work shape as login: an account with no
            // recovery code on file, or no account at all, still costs a
            // full verification against a dummy hash.
            const storedHash = (account && typeof account.recoveryHash === "string")
                ? account.recoveryHash
                : DUMMY_PASSWORD_HASH;
            const okCode = await Auth.verifyRecoveryCode(
                typeof body.recoveryCode === "string" ? body.recoveryCode : "", storedHash);

            if (!account || !account.recoveryHash || !okCode) {
                recoverThrottle.recordFailure(throttleKeys);
                sendJson(res, 401, { error: GENERIC });
                return;
            }

            // The code is single-use: it is consumed here and a fresh
            // one is issued, so a code seen over someone's shoulder (or
            // left in a screenshot) cannot be used twice.
            const newCode = Auth.generateRecoveryCode();
            account.passwordHash = await Auth.hashPassword(body.newPassword);
            account.recoveryHash = await Auth.hashRecoveryCode(newCode);
            await persistAccount(accountId);

            // Anyone already signed in as this account is signed out --
            // if the password was reset because someone else had it,
            // leaving their session alive would defeat the reset.
            let killed = 0;
            for (const token of Object.keys(sessions)) {
                if (sessions[token] === accountId) { await destroySession(token); killed++; }
            }

            recoverThrottle.recordSuccess(throttleKeys);
            console.log("[auth] password recovered for " + account.username +
                        " (" + killed + " session(s) invalidated)");
            sendJson(res, 200, { ok: true, recoveryCode: newCode });
        } catch (e) {
            console.log("[auth] recover failed:", e.message);
            sendJson(res, 500, { error: "Something went wrong. Please try again." });
        }
        return;
    }

    // ---- POST /auth/recovery/new ----  body: { sessionToken, password }
    // Issues a fresh recovery code to someone who is already signed in.
    // This is how an account created before recovery codes existed gets
    // one, and how a player replaces a code they think is compromised.
    // The current password is required, so a borrowed unlocked browser
    // cannot silently mint itself a permanent way back in.
    if (req.method === "POST" && req.url === "/auth/recovery/new") {
        try {
            const body = await readJsonBody(req);
            const sub = sessions[body.sessionToken];
            const account = sub ? accounts[sub] : null;
            if (!account) { sendJson(res, 401, { error: "Not signed in" }); return; }
            if (typeof account.passwordHash !== "string") {
                sendJson(res, 400, { error: "This account signs in with Google and has no password to recover." });
                return;
            }
            const ok = await Auth.verifyPassword(
                typeof body.password === "string" ? body.password : "", account.passwordHash);
            if (!ok) { sendJson(res, 401, { error: "Incorrect password." }); return; }

            const newCode = Auth.generateRecoveryCode();
            account.recoveryHash = await Auth.hashRecoveryCode(newCode);
            await persistAccount(sub);
            sendJson(res, 200, { ok: true, recoveryCode: newCode });
        } catch (e) {
            console.log("[auth] recovery code issue failed:", e.message);
            sendJson(res, 500, { error: "Something went wrong. Please try again." });
        }
        return;
    }

    // ---- POST /auth/logout ----  body: { sessionToken }
    // Ends the session on the SERVER, so the token is dead even if a
    // copy of it survives somewhere. Used by the LOG OUT button and, on
    // a best-effort basis, by the page-unload beacon.
    if (req.method === "POST" && req.url === "/auth/logout") {
        try {
            const body = await readJsonBody(req);
            await destroySession(body.sessionToken);
        } catch (e) {
            // A logout that fails to parse is still a logout.
        }
        sendJson(res, 200, { ok: true });
        return;
    }

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
            ensureAccountBattlePass(sub);
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
            // Records how this account can be signed into. Purely
            // descriptive -- nothing grants access off it -- but it is
            // what a future "add a password to my Google account" flow
            // would extend, and it lets the client show the right thing.
            if (!Array.isArray(accounts[sub].authMethods) || accounts[sub].authMethods.indexOf("google") === -1) {
                accounts[sub].authMethods = (Array.isArray(accounts[sub].authMethods) ? accounts[sub].authMethods : []).concat(["google"]);
                dirty = true;
            }
            if (dirty) await persistAccount(sub);

            const sessionToken = crypto.randomBytes(24).toString("hex");
            await persistSession(sessionToken, sub);

            sendJson(res, 200, {
                sessionToken: sessionToken,
                accountId: sub,
                account: publicAccount(accounts[sub]),
                isAdmin: isAdminSession(sessionToken)
            });
        } catch (e) {
            console.log("Google sign-in failed:", e.message);
            sendJson(res, 401, { error: "Google sign-in failed" });
        }
        return;
    }

    // ---- GET /auth/session?sessionToken=... ----
    //
    // Resumes an EXISTING session -- this is what lets a page refresh
    // stay signed in. The other /auth/* endpoints above all mint a new
    // sessionToken because each of them is a fresh authentication event
    // (a password check, a Google credential verification); this one is
    // not an authentication event at all, just a lookup of a token the
    // client already holds, so it returns the SAME token rather than
    // rotating it.
    //
    // Same query-string-carries-sessionToken shape as every other
    // read-only endpoint in this file (/ranked/me, /friends/list,
    // /battlepass/state, ...) -- deliberately consistent with the
    // existing convention rather than inventing a new one.
    //
    // getAccountForSession() is the ONLY thing that decides whether this
    // succeeds: the client cannot claim to be any account, it can only
    // present a token this server itself issued via a real login. A
    // missing, expired, or already-logged-out token gets exactly the
    // same 401 a stale token gets everywhere else, so the client's
    // existing "session expired" handling (see saveProgress) applies
    // here unchanged.
    if (req.method === "GET" && req.url.startsWith("/auth/session")) {
        const urlObj = new URL(req.url, "http://x");
        const sessionToken = urlObj.searchParams.get("sessionToken") || "";
        const account = getAccountForSession(sessionToken);
        if (!account) {
            sendJson(res, 401, { error: "Not signed in" });
            return;
        }
        const sub = sessions[sessionToken];

        // Same lazy migrations /auth/login runs, for the same reason: a
        // session can be resumed after a day boundary (or a feature
        // deploy) rolled over while the tab was closed, and this is the
        // first moment that account is touched since.
        const rolledDC = ensureDailyChallenges(account.dailyChallenges);
        if (rolledDC !== account.dailyChallenges) {
            account.dailyChallenges = rolledDC;
            await persistAccount(sub);
        }
        ensureAccountXP(sub);
        ensureAccountBattlePass(sub);

        sendJson(res, 200, {
            ok: true,
            sessionToken: sessionToken,
            // Same field the other three /auth/* endpoints already
            // return (see /auth/register, /auth/login, /auth/google) --
            // the client's onAuthenticated() reads it unconditionally
            // (see the Voidbreak cloud-save handshake in index.html),
            // and a resumed session has to hand it over exactly like a
            // fresh login does, or Voidbreak silently falls back to a
            // guest/device-local save the moment a page is refreshed.
            accountId: sub,
            account: publicAccount(account),
            isAdmin: isAdminSession(sessionToken)
        });
        return;
    }

    // ---- POST /shop/buy ----
    // body: { sessionToken, itemType: 'skin'|'power'|'ability', itemId }
    //
    // The ONLY way an account's owned-items lists or Coins/Crystals
    // balance can grow from here on (see /save below, which now
    // refuses to accept either from the client). Price, existence AND
    // CURRENCY are checked against catalog.js -- the server's own copy
    // of what things cost and what they cost it IN -- never against
    // anything the client sent. Mirrors /admin/currency's and
    // /challenges/claim's atomic read-modify-write-then-persist shape,
    // with the same rollback on a failed write.
    if (req.method === "POST" && req.url === "/shop/buy") {
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

            const ownedField = Catalog.OWNED_FIELD[body.itemType];
            if (!ownedField) {
                sendJson(res, 400, { error: "Unknown item type" });
                return;
            }
            const item = Catalog.findItem(body.itemType, body.itemId);
            if (!item) {
                sendJson(res, 400, { error: "Unknown item" });
                return;
            }
            // The item's OWN catalog entry says which currency it costs
            // -- never anything the client sends. Every existing item
            // is currency:"coins"; a future Crystal-priced cosmetic just
            // needs that one field changed on its catalog.js entry.
            const currencyField = item.currency === "crystals" ? "crystals" : "coins";

            const owned = Array.isArray(target[ownedField]) ? target[ownedField] : [];
            if (owned.indexOf(item.id) !== -1) {
                sendJson(res, 409, { error: "You already own this" });
                return;
            }

            const previousBalance = target[currencyField] || 0;
            if (previousBalance < item.price) {
                sendJson(res, 400, { error: "Not enough " + currencyField });
                return;
            }

            const previousOwned = owned;
            target[currencyField] = previousBalance - item.price; // atomic decrement, never a client-supplied total
            target[ownedField] = owned.concat([item.id]);
            try {
                await persistAccount(sub);
            } catch (e) {
                // Write failed -- put both fields back exactly as they
                // were, so a failed purchase can never be charged for.
                target[currencyField] = previousBalance;
                target[ownedField] = previousOwned;
                sendJson(res, 503, { error: "Could not save purchase -- try again" });
                return;
            }

            sendJson(res, 200, {
                ok: true,
                itemType: body.itemType,
                itemId: item.id,
                price: item.price,
                currency: currencyField,
                newBalance: target[currencyField],
                owned: target[ownedField]
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
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
            // progress with 100 coins / 0 kills.
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

            // Same client-authoritative trust level as kills/wins above
            // (coins is no longer part of that group -- see /shop/buy)
            // -- see the DAILY CHALLENGES comment block for why that's
            // an accepted tradeoff here, not a new one. Rolls to a
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

            // Equip picks cost nothing, so they stay client-reported --
            // but ONLY as a choice among items this account genuinely
            // owns. Anything not present in the account's OWN stored
            // ownedPowers/ownedAbilities (never body.ownedPowers, which
            // is not trusted either -- see below) is filtered out, and
            // the surviving list is capped at how many of that item type
            // can ever be equipped at once. Without this, a client could
            // claim {equippedPowers:["kevlar"]} having never bought it
            // and the server would grant the shield anyway -- combat.js
            // and shieldsForConnection() read equippedPowers directly.
            const ownedPowersNow = Array.isArray(existing.ownedPowers) ? existing.ownedPowers : [];
            const ownedAbilitiesNow = Array.isArray(existing.ownedAbilities) ? existing.ownedAbilities : [];
            const clampEquip = (incoming, ownedList, max) =>
                (Array.isArray(incoming) ? incoming : [])
                    .filter(id => typeof id === "string" && ownedList.indexOf(id) !== -1)
                    .slice(0, max);

            accounts[sub] = {
                name: existing.name,
                email: existing.email || "",
                // COINS, CRYSTALS AND OWNED-ITEM LISTS ARE DELIBERATELY
                // NOT READ FROM `body`, for the same field-by-field-
                // rebuild reason as xp/level/ranked/friends below:
                // anything not carried here is destroyed by the next
                // routine save, so leaving these four out means a client
                // POSTing {coins:999999, crystals:999999,
                // ownedSkins:[...everything]} here has no effect
                // whatsoever. Coins only ever change inside /shop/buy,
                // /admin/currency, /challenges/claim and /xp/report's
                // coin-reward path now; Crystals only ever change inside
                // /admin/currency and the Stripe webhook handler;
                // ownership only ever grows inside /shop/buy.
                coins: existing.coins,
                crystals: existing.crystals,
                kills: safeCount(body.kills, existing.kills),
                wins: safeCount(body.wins, existing.wins),
                ownedSkins: Array.isArray(existing.ownedSkins) ? existing.ownedSkins : ["cyan", "red"],
                ownedPowers: ownedPowersNow,
                equippedPowers: clampEquip(body.equippedPowers, ownedPowersNow, Catalog.MAX_EQUIPPED_POWERS),
                equippedPowersP2: clampEquip(body.equippedPowersP2, ownedPowersNow, Catalog.MAX_EQUIPPED_POWERS),
                ownedAbilities: ownedAbilitiesNow,
                equippedAbilities: clampEquip(body.equippedAbilities, ownedAbilitiesNow, Catalog.MAX_EQUIPPED_ABILITIES),
                equippedAbilitiesP2: clampEquip(body.equippedAbilitiesP2, ownedAbilitiesNow, Catalog.MAX_EQUIPPED_ABILITIES),
                // Same reasoning again: a skin can only ever be equipped
                // if the account's OWN stored ownedSkins already contains
                // it, so claiming a skin never paid for is worth nothing
                // -- it draws a hull nobody else's client trusts as paid
                // for, but it's the last piece of that same class of bug.
                p1SkinId: (typeof body.p1SkinId === "string" && existing.ownedSkins && existing.ownedSkins.indexOf(body.p1SkinId) !== -1)
                    ? body.p1SkinId : existing.p1SkinId,
                p2SkinId: (typeof body.p2SkinId === "string" && existing.ownedSkins && existing.ownedSkins.indexOf(body.p2SkinId) !== -1)
                    ? body.p2SkinId : existing.p2SkinId,
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
                // CREDENTIALS ARE CARRIED, NEVER READ FROM `body` -- for
                // the same reason as xp/level above: this handler rebuilds
                // the account field-by-field, so anything not listed here
                // is destroyed by the next routine save. A client POSTing
                // {passwordHash:...} or {username:...} has no effect
                // whatsoever; both only ever change in /auth/register.
                authMethods: Array.isArray(existing.authMethods) ? existing.authMethods : undefined,
                username: existing.username,
                usernameLower: existing.usernameLower,
                passwordHash: existing.passwordHash,
                recoveryHash: existing.recoveryHash,
                // Non-sensitive UX state (no coins/crystals/XP/rank riding on
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
                // against this endpoint: kills/wins above are
                // client-authoritative by existing design (coins/crystals
                // is no longer -- see /shop/buy), but RP, rank,
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
                blocked: Array.isArray(existing.blocked) ? existing.blocked : [],
                // BATTLE PASS IS DELIBERATELY NOT READ FROM `body`, for the
                // exact same reason ranked/friends aren't: this handler
                // rebuilds the account field-by-field, so xp/tier/premium/
                // claimed state MUST be carried from the stored record or
                // it is wiped by the very next /save (which every match
                // already triggers via saveProgress()). A client POSTing
                // {battlePass:{premium:true}} here has no effect at all --
                // premium ownership only ever changes inside
                // /battlepass/purchase-premium, and xp only inside
                // awardXP()/completeRankedMatch()/the daily-challenge bonus.
                battlePass: BattlePass.ensureRecord(existing.battlePass, BATTLE_PASS_SEASON.id),
                // The cosmetics a Battle Pass reward grants are permanent,
                // server-only-growable inventories -- exactly like
                // ownedSkins/ownedPowers/ownedAbilities above, carried
                // ONLY from the stored record, never from the request.
                ownedBanners: Array.isArray(existing.ownedBanners) ? existing.ownedBanners : [],
                ownedPlayerIcons: Array.isArray(existing.ownedPlayerIcons) ? existing.ownedPlayerIcons : [],
                ownedEmotes: Array.isArray(existing.ownedEmotes) ? existing.ownedEmotes : [],
                ownedKillEffects: Array.isArray(existing.ownedKillEffects) ? existing.ownedKillEffects : [],
                ownedAbilityCosmetics: Array.isArray(existing.ownedAbilityCosmetics) ? existing.ownedAbilityCosmetics : [],
                ownedBadges: Array.isArray(existing.ownedBadges) ? existing.ownedBadges : [],
                // Equip picks cost nothing (same tier as p1SkinId/p2SkinId
                // above) so they ARE accepted from the client, but only as
                // a choice among cosmetics this account's OWN stored
                // owned-list already contains -- never body's own claim of
                // what it owns.
                equippedBanner: (typeof body.equippedBanner === "string" && Array.isArray(existing.ownedBanners) && existing.ownedBanners.indexOf(body.equippedBanner) !== -1)
                    ? body.equippedBanner : (body.equippedBanner === null ? null : (existing.equippedBanner || null)),
                equippedPlayerIcon: (typeof body.equippedPlayerIcon === "string" && Array.isArray(existing.ownedPlayerIcons) && existing.ownedPlayerIcons.indexOf(body.equippedPlayerIcon) !== -1)
                    ? body.equippedPlayerIcon : (body.equippedPlayerIcon === null ? null : (existing.equippedPlayerIcon || null)),
                equippedKillEffect: (typeof body.equippedKillEffect === "string" && Array.isArray(existing.ownedKillEffects) && existing.ownedKillEffects.indexOf(body.equippedKillEffect) !== -1)
                    ? body.equippedKillEffect : (body.equippedKillEffect === null ? null : (existing.equippedKillEffect || null)),
                // VOIDBREAK CLOUD SAVE IS DELIBERATELY NOT READ FROM
                // `body` -- same reason as ranked/battlePass above: this
                // handler rebuilds the account field-by-field, so
                // anything not carried here is destroyed by the next
                // routine save (and Duel Arena's own saveProgress() runs
                // after every match). Voidbreak's progress only ever
                // changes inside /voidbreak/save.
                voidbreak: existing.voidbreak || null,
                // Server-measured; never read from the request body.
                playtime: existing.playtime || defaultPlaytime(false)
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
    // claimed flag, and credits Coins with the server's own copy of the reward --
    // never a client-supplied amount. Mirrors /admin/currency's atomic
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

            const previousBalance = target.coins || 0;
            const previousDC = target.dailyChallenges;
            target.coins = previousBalance + def.reward; // atomic increment, not a client-supplied total
            target.dailyChallenges = {
                date: dc.date,
                progress: dc.progress,
                claimed: Object.assign({}, dc.claimed, { [body.challengeId]: true })
            };
            // Daily Challenges never route through awardXP() (they only
            // ever paid Coins) -- this is the one place a Daily Challenge
            // also feeds Battle Pass progress. Folded into the same
            // persist/rollback as the coins grant just above.
            if (!target.battlePass) target.battlePass = BattlePass.defaultRecord();
            const previousBattlePass = target.battlePass;
            target.battlePass = Object.assign({}, previousBattlePass);
            addBattlePassXP(target, BattlePass.DAILY_CHALLENGE_BONUS_XP);
            try {
                await persistAccount(sub);
            } catch (e) {
                target.coins = previousBalance; // write failed -- undo the in-memory grant
                target.dailyChallenges = previousDC;
                target.battlePass = previousBattlePass;
                sendJson(res, 503, { error: "Could not save reward -- try again" });
                return;
            }

            sendJson(res, 200, {
                ok: true,
                challengeId: body.challengeId,
                reward: def.reward,
                newBalance: target.coins,
                dailyChallenges: target.dailyChallenges
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- POST /xp/report ----
    // body: { sessionToken, reason, kills?, players? }
    // The client-report half of the XP AND COIN systems -- see the big
    // comment above XP_REWARDS/COIN_REWARDS/lastXPReportAt for the trust
    // model. `reason` must be one of a fixed whitelist; the XP amount
    // always comes from XP_REWARDS and the coin amount from
    // COIN_REWARDS, never from the request. `kills` (only meaningful
    // for reason:"kill") is clamped to XP_MAX_KILLS_PER_REPORT so one
    // report can't claim an arbitrary kill count. `players` (only
    // meaningful for reason:"match_win") is clamped to [2,4] -- Classic
    // Mode's match-win Coin bonus scales with lobby size (see
    // index.html's matchWinBonus()); this is the one place that
    // formula is computed server-side, from a client-reported player
    // count that is already the SAME trust tier kills/wins/matchSize
    // already are (a local/bot match's own configuration, not something
    // the server can independently verify -- see the DAILY CHALLENGES
    // comment block for why that tier is an accepted tradeoff here).
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
            if (reason === "heist_win" || reason === "bombrun_win" || reason === "ranked_win" ||
                reason === "ranked_loss" || reason === "voidbreak_coop_complete") {
                sendJson(res, 400, { error: "This reward is granted automatically" });
                return;
            }
            if (xpReportThrottled(sub, reason)) {
                sendJson(res, 429, { error: "Too soon" });
                return;
            }

            let amount = XP_REWARDS[reason];
            let coinAmount = COIN_REWARDS[reason] || 0;
            if (reason === "kill") {
                const n = Math.max(1, Math.min(XP_MAX_KILLS_PER_REPORT, Math.floor(body.kills) || 1));
                amount = XP_REWARDS.kill * n;
                coinAmount = (COIN_REWARDS.kill || 0) * n;
            }
            if (reason === "match_win" && Number.isInteger(body.players)) {
                const players = Math.max(2, Math.min(4, body.players));
                // Mirrors matchWinBonus() in index.html exactly: base 40
                // for 2 players, +10 Coins per player beyond 2.
                coinAmount = 40 + Math.max(0, players - 2) * 10;
            }

            const result = await awardXP(sub, amount, reason, coinAmount);
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

    // =====================================================================
    // BATTLE PASS
    //
    // Server-authoritative the same way the shop and Daily Challenges
    // already are: the client never gets to assert its own tier, XP,
    // premium ownership or claimed state -- every one of those is
    // re-derived here from the account's own stored battlePass record and
    // battlepass.js's TIERS table, never from anything the request sends.
    // =====================================================================

    // ---- GET /battlepass/config ----
    // Public, unauthenticated -- the season's identity/dates, the price to
    // unlock Premium, and the full 50-tier reward table. This is the ONE
    // place that table is defined (see battlepass.js) -- the client fetches
    // it rather than keeping a second hand-maintained copy.
    if (req.method === "GET" && req.url === "/battlepass/config") {
        sendJson(res, 200, {
            season: BATTLE_PASS_SEASON,
            priceCrystals: BattlePass.PASS_PRICE_CRYSTALS,
            tierCount: BattlePass.TIER_COUNT,
            xpPerTier: BattlePass.XP_PER_TIER,
            boostDurationMs: BattlePass.BOOST_DURATION_MS,
            boostMultiplier: BattlePass.BOOST_MULTIPLIER,
            tiers: BattlePass.TIERS
        });
        return;
    }

    // ---- GET /battlepass/state?sessionToken=... (optional) ----
    // A guest (no/invalid sessionToken) gets an honest all-zero state
    // back rather than a 401 -- exactly like /challenges/today -- so the
    // screen can render "SIGN IN TO TRACK PROGRESS" instead of an error.
    if (req.method === "GET" && req.url.startsWith("/battlepass/state")) {
        const urlObj = new URL(req.url, "http://x");
        const sessionToken = urlObj.searchParams.get("sessionToken");
        const sub = sessionToken ? sessions[sessionToken] : null;
        const account = sub ? accounts[sub] : null;

        let bp = BattlePass.defaultRecord();
        if (account) {
            bp = ensureAccountBattlePass(sub);
        }
        const derived = BattlePass.tierFromXP(bp.xp);
        sendJson(res, 200, {
            signedIn: !!account,
            xp: bp.xp,
            tier: derived.tier,
            xpIntoTier: derived.xpIntoTier,
            xpForNextTier: derived.xpForNextTier,
            premium: !!bp.premium,
            claimedFree: bp.claimedFree,
            claimedPremium: bp.claimedPremium,
            boostCharges: bp.boostCharges || 0,
            boostActiveUntil: bp.boostActiveUntil || 0
        });
        return;
    }

    // ---- POST /battlepass/purchase-premium ---- body: { sessionToken }
    // Spends Crystals to unlock the Premium track for the CURRENT season.
    // Same atomic decrement-then-persist-with-rollback shape as
    // /shop/buy; the price is read from battlepass.js, never the client.
    // Idempotent by construction: already-premium is rejected outright,
    // so a double click (or a replayed request) can never charge twice.
    if (req.method === "POST" && req.url === "/battlepass/purchase-premium") {
        try {
            const body = await readJsonBody(req);
            const sub = sessions[body.sessionToken];
            if (!sub) { sendJson(res, 401, { error: "Not signed in" }); return; }
            const target = accounts[sub];
            if (!target) { sendJson(res, 409, { error: "Account not loaded -- sign in again" }); return; }

            const bp = ensureAccountBattlePass(sub);
            if (bp.premium) {
                sendJson(res, 409, { error: "Premium is already unlocked this season" });
                return;
            }
            const price = BattlePass.PASS_PRICE_CRYSTALS;
            const previousBalance = target.crystals || 0;
            if (previousBalance < price) {
                sendJson(res, 400, { error: "Not enough crystals" });
                return;
            }

            const previousBattlePass = bp;
            target.crystals = previousBalance - price;
            target.battlePass = Object.assign({}, bp, { premium: true });
            try {
                await persistAccount(sub);
            } catch (e) {
                target.crystals = previousBalance;
                target.battlePass = previousBattlePass;
                sendJson(res, 503, { error: "Could not save purchase -- try again" });
                return;
            }

            sendJson(res, 200, {
                ok: true,
                newBalance: target.crystals,
                premium: true
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- POST /battlepass/claim ---- body: { sessionToken, tier, track }
    // The ONLY way a Battle Pass reward's Coins/Crystals/cosmetic actually
    // reaches an account. Re-derives the account's OWN current tier from
    // its OWN stored xp (never a client-sent tier), re-looks-up the
    // reward from battlepass.js (never a client-sent reward), and checks
    // the claimed-map before granting -- the exact same
    // read-verify-mutate-persist-with-rollback shape as
    // /challenges/claim.
    if (req.method === "POST" && req.url === "/battlepass/claim") {
        try {
            const body = await readJsonBody(req);
            const sub = sessions[body.sessionToken];
            if (!sub) { sendJson(res, 401, { error: "Not signed in" }); return; }
            const target = accounts[sub];
            if (!target) { sendJson(res, 409, { error: "Account not loaded -- sign in again" }); return; }

            const tierNumber = Number(body.tier);
            const track = body.track;
            if (!Number.isInteger(tierNumber) || tierNumber < 1 || tierNumber > BattlePass.TIER_COUNT) {
                sendJson(res, 400, { error: "Invalid tier" });
                return;
            }
            if (!BattlePass.isValidTrack(track)) {
                sendJson(res, 400, { error: "Invalid track" });
                return;
            }
            const def = BattlePass.tierDef(tierNumber);
            if (!def) { sendJson(res, 400, { error: "Invalid tier" }); return; }

            const bp = ensureAccountBattlePass(sub);
            const derived = BattlePass.tierFromXP(bp.xp);
            if (derived.tier < tierNumber) {
                sendJson(res, 400, { error: "This tier hasn't been reached yet" });
                return;
            }
            if (track === "premium" && !bp.premium) {
                sendJson(res, 403, { error: "Unlock Premium to claim this reward" });
                return;
            }
            const claimedMap = track === "premium" ? bp.claimedPremium : bp.claimedFree;
            if (claimedMap[tierNumber]) {
                sendJson(res, 409, { error: "Already claimed" });
                return;
            }

            const rewards = track === "premium" ? def.premium : def.free;

            // Snapshot every field grantBattlePassReward can touch so a
            // failed persist can put all of them back exactly as they
            // were -- a claim can grant a currency AND a cosmetic AND a
            // boost charge in one call (see Tier 50 Premium's bundle).
            const previousBattlePass = target.battlePass;
            const previousCoins = target.coins;
            const previousCrystals = target.crystals;
            const ownedFieldsTouched = {};
            for (const r of rewards) {
                const field = BattlePass.OWNED_FIELD[r.type];
                if (field && !(field in ownedFieldsTouched)) ownedFieldsTouched[field] = target[field];
            }

            target.battlePass = Object.assign({}, bp, {
                claimedFree: track === "free" ? Object.assign({}, bp.claimedFree, { [tierNumber]: true }) : bp.claimedFree,
                claimedPremium: track === "premium" ? Object.assign({}, bp.claimedPremium, { [tierNumber]: true }) : bp.claimedPremium
            });
            rewards.forEach(r => grantBattlePassReward(target, r));

            try {
                await persistAccount(sub);
            } catch (e) {
                target.battlePass = previousBattlePass;
                target.coins = previousCoins;
                target.crystals = previousCrystals;
                for (const field of Object.keys(ownedFieldsTouched)) target[field] = ownedFieldsTouched[field];
                sendJson(res, 503, { error: "Could not save reward -- try again" });
                return;
            }

            sendJson(res, 200, {
                ok: true,
                tier: tierNumber,
                track: track,
                rewards: rewards,
                newCoins: target.coins,
                newCrystals: target.crystals,
                battlePass: target.battlePass
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- POST /battlepass/useboost ---- body: { sessionToken } ----
    // Activates one XP Boost charge. Never stacks: rejected outright while
    // one is already running, so a charge can't be silently wasted on top
    // of an active window, and can't be used to multiply the multiplier.
    if (req.method === "POST" && req.url === "/battlepass/useboost") {
        try {
            const body = await readJsonBody(req);
            const sub = sessions[body.sessionToken];
            if (!sub) { sendJson(res, 401, { error: "Not signed in" }); return; }
            const target = accounts[sub];
            if (!target) { sendJson(res, 409, { error: "Account not loaded -- sign in again" }); return; }

            const bp = ensureAccountBattlePass(sub);
            const now = Date.now();
            if (bp.boostActiveUntil && bp.boostActiveUntil > now) {
                sendJson(res, 409, { error: "A boost is already active" });
                return;
            }
            if (!bp.boostCharges || bp.boostCharges < 1) {
                sendJson(res, 400, { error: "No XP Boost charges available" });
                return;
            }

            const previousBattlePass = bp;
            target.battlePass = Object.assign({}, bp, {
                boostCharges: bp.boostCharges - 1,
                boostActiveUntil: now + BattlePass.BOOST_DURATION_MS
            });
            try {
                await persistAccount(sub);
            } catch (e) {
                target.battlePass = previousBattlePass;
                sendJson(res, 503, { error: "Could not save -- try again" });
                return;
            }

            sendJson(res, 200, { ok: true, battlePass: target.battlePass });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- POST /admin/battlepass ---- body: { sessionToken, action, ... }
    // Admin Battle Pass season control. Mirrors /admin/ranked's
    // action:"startSeason" exactly: archives nothing (cosmetics already
    // granted live in permanent owned-item arrays, untouched by this),
    // resets every account's progress/claims/premium for the new season,
    // persists the new season doc so a restart doesn't revert it, and
    // logs the action.
    if (req.method === "POST" && req.url === "/admin/battlepass") {
        try {
            const body = await readJsonBody(req);
            if (!isAdminSession(body.sessionToken)) {
                sendJson(res, 403, { error: "Forbidden -- admin access required" });
                return;
            }
            const adminAccount = getAccountForSession(body.sessionToken);

            if (body.action === "startSeason") {
                const newId = String(body.seasonId || "").trim();
                if (!newId || newId.length > 32) {
                    sendJson(res, 400, { error: "Invalid season id" });
                    return;
                }
                if (newId === BATTLE_PASS_SEASON.id) {
                    sendJson(res, 400, { error: "That season is already active" });
                    return;
                }
                const days = Number.isFinite(Number(body.days)) && Number(body.days) > 0
                    ? Math.floor(Number(body.days)) : 42;

                const previous = BATTLE_PASS_SEASON.id;
                const now = Date.now();
                BATTLE_PASS_SEASON = {
                    id: newId,
                    name: String(body.seasonName || ("Season " + newId)).slice(0, 48),
                    startedAt: now,
                    endsAt: now + days * 24 * 60 * 60 * 1000
                };

                let rolled = 0;
                for (const sub of Object.keys(accounts)) {
                    const account = accounts[sub];
                    if (!account.battlePass || account.battlePass.seasonId === newId) continue;
                    account.battlePass = BattlePass.defaultRecord();
                    account.battlePass.seasonId = newId;
                    try {
                        await persistAccount(sub);
                        rolled++;
                    } catch (e) {
                        console.log("[battlepass] season rollover failed to save " + sub + ":", e.message);
                    }
                }
                await store.saveDoc("battlePassSeason", BATTLE_PASS_SEASON)
                    .catch(e => console.log("[battlepass] failed to persist season:", e.message));

                pushAdminLog({
                    admin: adminAccount ? adminAccount.name : "unknown",
                    type: "battlePassSeasonStart",
                    fromSeason: previous,
                    toSeason: newId,
                    accountsRolled: rolled
                });
                sendJson(res, 200, { ok: true, season: BATTLE_PASS_SEASON, accountsRolled: rolled });
                return;
            }

            sendJson(res, 400, { error: "Unknown action" });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // =====================================================================
    // VOIDBREAK CLOUD SAVE
    //
    // The account's own stored `voidbreak` field (see defaultAccount(),
    // /save's carry-forward above, and voidbreak.js) is the ONLY place
    // this progress lives server-side. Identity comes from the session
    // token exactly like every other account endpoint -- a client can
    // never ask to load or write a DIFFERENT account's save; there is no
    // "which account" parameter anywhere below, only "which SESSION".
    // =====================================================================

    // ---- GET /voidbreak/state?sessionToken=... ----
    // A guest (no/invalid sessionToken) gets an honest "not signed in"
    // response, not a 401 -- the client (voidbreak.html) uses this to
    // decide "stay on the local guest save" rather than treating it as
    // an error. Signed in with no cloud save yet is equally normal (a
    // brand-new account, or an existing account that never played
    // Voidbreak before this feature) -- see hasCloudSave.
    if (req.method === "GET" && req.url.startsWith("/voidbreak/state")) {
        const urlObj = new URL(req.url, "http://x");
        const sessionToken = urlObj.searchParams.get("sessionToken");
        const sub = sessionToken ? sessions[sessionToken] : null;
        const account = sub ? accounts[sub] : null;

        if (!account) {
            sendJson(res, 200, { signedIn: false, hasCloudSave: false, data: null, updatedAt: 0, version: 0 });
            return;
        }
        const vb = account.voidbreak;
        sendJson(res, 200, {
            signedIn: true,
            hasCloudSave: !!vb,
            data: vb ? vb.data : null,
            updatedAt: vb ? vb.updatedAt : 0,
            version: vb ? vb.version : 0,
            // The endgame view (shop catalog with prices/ownership/locks,
            // mastery progress, prestige eligibility) is resolved HERE,
            // server-side, from the stored save. The client renders it
            // and never computes a price, an ownership flag or an
            // eligibility check of its own.
            endgame: Voidbreak.endgameView(vb ? vb.data : null)
        });
        return;
    }

    // ---- POST /voidbreak/save ---- body: { sessionToken, data } ----
    // Sanitizes and stores a Voidbreak save. This is the client-
    // authoritative trust tier Daily Challenges' progress and /save's
    // kills/wins already sit at (see the big comment above
    // DAILY_CHALLENGE_POOL) -- Voidbreak has no server-side game
    // simulation to check "did this player really earn 500 shards"
    // against, so this endpoint's job is shape/bounds sanitization
    // (voidbreak.js's sanitizeSaveData -- wrong types, unknown keys and
    // absurd numbers are clamped or dropped), not gameplay validation.
    // What IS real here: only the authenticated account's OWN save can
    // ever be written (from `sessions[body.sessionToken]`, never a
    // client-supplied account id), and a save can only ever come from
    // this one endpoint -- a client can't smuggle progress in through
    // /save, which explicitly refuses to read `voidbreak` from its body.
    //
    // CONFLICT RESOLUTION IS SERVER-SIDE AND AUTHORITATIVE.
    //
    // This endpoint used to store whatever it was handed, on the theory
    // that the CLIENT would reconcile against /voidbreak/state first.
    // That was the cross-device bug: it made the last device to write
    // the winner regardless of how much progress it actually had, so
    // playing on a Mac and then opening an iPad flattened whichever one
    // saved first. And a device whose /voidbreak/state fetch failed fell
    // back to an empty local save and uploaded THAT, wiping the account
    // outright.
    //
    // The arbitration now happens here (Voidbreak.resolveSaveConflict),
    // where no client can route around it: a save that carries less
    // progress than the stored record can never replace it, a default
    // save can never replace a real one, and a device still holding a
    // pre-prestige save can never undo a prestige. The response carries
    // the resolved save back, so a device that lost the comparison
    // adopts the winner immediately instead of continuing to think its
    // own lesser state is current.
    if (req.method === "POST" && req.url === "/voidbreak/save") {
        try {
            const body = await readJsonBody(req);
            const sub = sessions[body.sessionToken];
            if (!sub) { sendJson(res, 401, { error: "Not signed in" }); return; }
            const target = accounts[sub];
            if (!target) { sendJson(res, 409, { error: "Account not loaded -- sign in again" }); return; }

            const clean = Voidbreak.sanitizeSaveData(body.data);
            if (!clean) { sendJson(res, 400, { error: "Invalid save data" }); return; }

            const previousVoidbreak = target.voidbreak;
            const previousVersion = previousVoidbreak ? previousVoidbreak.version : 0;
            // applyClientSave() is what makes the endgame fields safe on
            // this otherwise client-authoritative endpoint: every
            // server-owned field (shard spend ledger, owned/equipped
            // cosmetics, mastery reward claims, prestige level) is taken
            // from the STORED record and the client's version discarded,
            // and client-reported mastery XP is forced to be monotonic
            // and capped per save. So this endpoint still cannot be used
            // to grant items, refund a purchase, re-claim a reward or
            // fake a prestige -- only the transactional endpoints below
            // can touch any of that.
            const reconciled = Voidbreak.applyClientSave(clean, previousVoidbreak ? previousVoidbreak.data : null);

            // Which stored version this device last read. A prestige is
            // the one operation that legitimately LOWERS progression, so
            // a device that has not seen it yet is holding a save that
            // still contains everything the prestige consumed -- and
            // because applyClientSave() above copies the stored prestige
            // level onto every upload, the save body itself can no longer
            // reveal that. The version does. A client that omits it (or
            // is simply out of date) is treated as not having seen the
            // prestige, which is the safe direction.
            //
            // This is a consistency guard between a player's own devices,
            // not an anti-cheat measure: this endpoint is client-reported
            // by design (see voidbreak.js's DEF_SAVE header), so a client
            // willing to lie has simpler things to lie about.
            const baseVersion = Math.max(0, Math.floor(Number(body.baseVersion) || 0));
            const prestigeVersion = previousVoidbreak ? (previousVoidbreak.prestigeVersion || 0) : 0;

            // Which save actually represents more progress -- see
            // voidbreak.js's PROGRESS SCORING section for the exact
            // rules. The result is never less than what was already
            // stored, so a losing upload is a no-op rather than a loss.
            const resolution = Voidbreak.resolveSaveConflict(
                reconciled, previousVoidbreak ? previousVoidbreak.data : null,
                { incomingPredatesPrestige: prestigeVersion > 0 && baseVersion < prestigeVersion });

            if (!resolution.changed && previousVoidbreak) {
                // The upload carried nothing the stored record didn't
                // already have. Don't rewrite the record (no pointless
                // version bump, no disk write) -- just hand back what is
                // authoritative so the client can adopt it.
                sendJson(res, 200, {
                    ok: true,
                    updatedAt: previousVoidbreak.updatedAt,
                    version: previousVoidbreak.version,
                    data: previousVoidbreak.data,
                    resolvedFrom: resolution.winner,
                    endgame: Voidbreak.endgameView(previousVoidbreak.data)
                });
                return;
            }

            target.voidbreak = {
                data: resolution.data,
                updatedAt: Date.now(), // the SERVER's clock, never a client-supplied timestamp
                version: previousVersion + 1,
                prestigeVersion: prestigeVersion // carried forward, never reset by an ordinary save
            };
            try {
                await persistAccount(sub);
            } catch (e) {
                target.voidbreak = previousVoidbreak; // write failed -- undo the in-memory grant
                sendJson(res, 503, { error: "Could not save progress -- try again" });
                return;
            }

            sendJson(res, 200, {
                ok: true,
                updatedAt: target.voidbreak.updatedAt,
                version: target.voidbreak.version,
                // The authoritative save, so a device whose upload lost
                // (or was merged with a higher-progress record) replaces
                // its own lesser copy with this instead of drifting.
                data: target.voidbreak.data,
                resolvedFrom: resolution.winner,
                endgame: Voidbreak.endgameView(target.voidbreak.data)
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // =====================================================================
    // VOIDBREAK ENDGAME -- Void Shard Shop / Weapon Mastery / Void Prestige
    //
    // These four endpoints are the ONLY way the server-owned half of a
    // Voidbreak save can change (see voidbreak.js's DEF_SAVE comment for
    // the server-owned vs client-reported split). Each one:
    //   * identifies the account from the SESSION only, never a
    //     client-supplied id,
    //   * reads the CURRENT STORED save as the input to the decision,
    //     so a stale or forged client view can't influence the outcome,
    //   * delegates the decision to a pure function in voidbreak.js
    //     (price, ownership, unlock gate, mastery level reached, claim
    //     already made, prestige eligibility) -- nothing in the request
    //     body carries a price, a balance or an entitlement,
    //   * applies the change to a COPY and only commits it if the
    //     account write succeeds, rolling back in memory otherwise, so a
    //     failed persist can never charge a player or half-apply a
    //     prestige,
    //   * and is naturally idempotent against refresh / reconnect /
    //     multi-tab replay, because the duplicate check is against
    //     stored state rather than against anything in the request
    //     (buying an owned item, re-claiming a claimed reward, or
    //     prestiging when no longer eligible all fail closed).
    // =====================================================================
    function voidbreakEndgameAuth(body) {
        const sub = sessions[body.sessionToken];
        if (!sub) return { error: 401, message: "Not signed in" };
        const target = accounts[sub];
        if (!target) return { error: 409, message: "Account not loaded -- sign in again" };
        return { sub: sub, account: target };
    }

    // commitVoidbreakSave now lives at module scope (see the VOIDBREAK
    // SAVE COMMIT section further up) so the co-op match rooms in the
    // WebSocket layer can pay out a run through the exact same
    // copy-then-commit path these HTTP transactions use.

    // ---- POST /voidbreak/shop/buy ---- body: { sessionToken, itemId } ----
    if (req.method === "POST" && req.url === "/voidbreak/shop/buy") {
        try {
            const body = await readJsonBody(req);
            const auth = voidbreakEndgameAuth(body);
            if (auth.error) { sendJson(res, auth.error, { error: auth.message }); return; }

            const current = auth.account.voidbreak ? auth.account.voidbreak.data : Voidbreak.defaultSaveData();
            // Price, ownership and the unlock gate are all decided in
            // voidbreak.js against `current` -- the body contributes an
            // item id and nothing else.
            const result = Voidbreak.buyCosmetic(current, body.itemId);
            if (!result.ok) { sendJson(res, result.code || 400, { error: result.error }); return; }

            if (!(await commitVoidbreakSave(auth.sub, auth.account, result.save))) {
                sendJson(res, 503, { error: "Could not save purchase -- try again" });
                return;
            }
            sendJson(res, 200, {
                ok: true, itemId: result.item.id, price: result.item.price,
                endgame: Voidbreak.endgameView(result.save),
                version: auth.account.voidbreak.version
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- POST /voidbreak/shop/equip ---- body: { sessionToken, itemId } ----
    if (req.method === "POST" && req.url === "/voidbreak/shop/equip") {
        try {
            const body = await readJsonBody(req);
            const auth = voidbreakEndgameAuth(body);
            if (auth.error) { sendJson(res, auth.error, { error: auth.message }); return; }

            const current = auth.account.voidbreak ? auth.account.voidbreak.data : Voidbreak.defaultSaveData();
            const result = Voidbreak.equipCosmetic(current, body.itemId);
            if (!result.ok) { sendJson(res, result.code || 400, { error: result.error }); return; }

            if (!(await commitVoidbreakSave(auth.sub, auth.account, result.save))) {
                sendJson(res, 503, { error: "Could not save loadout -- try again" });
                return;
            }
            sendJson(res, 200, {
                ok: true, itemId: result.item.id,
                endgame: Voidbreak.endgameView(result.save),
                version: auth.account.voidbreak.version
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- POST /voidbreak/planet/build ----
    // body: { sessionToken, plot, buildingId }
    //
    // Home Planet construction SPENDS a currency, so it gets the same
    // treatment the shop does rather than riding along on /voidbreak/save
    // (which carries the colony forward from the stored record and
    // discards whatever the client claims about it -- see
    // voidbreak.js's applyClientSave). The body contributes a plot index
    // and a building id; the cost, the territory check, the requirement
    // gate and the level are all decided in voidbreak.js against the
    // STORED save.
    if (req.method === "POST" && req.url === "/voidbreak/planet/build") {
        try {
            const body = await readJsonBody(req);
            const auth = voidbreakEndgameAuth(body);
            if (auth.error) { sendJson(res, auth.error, { error: auth.message }); return; }

            const current = auth.account.voidbreak ? auth.account.voidbreak.data : Voidbreak.defaultSaveData();
            const result = Voidbreak.buildOnPlanet(current, body.plot, body.buildingId);
            if (!result.ok) { sendJson(res, result.code || 400, { error: result.error }); return; }

            if (!(await commitVoidbreakSave(auth.sub, auth.account, result.save))) {
                sendJson(res, 503, { error: "Could not save construction -- try again" });
                return;
            }
            sendJson(res, 200, {
                ok: true,
                plot: result.plot,
                buildingId: result.building.id,
                level: result.level,
                spent: result.spent,
                endgame: Voidbreak.endgameView(result.save),
                data: result.save,
                version: auth.account.voidbreak.version
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- POST /voidbreak/planet/decorate ----
    // body: { sessionToken, plot, decorationId }   (decorationId null clears)
    //
    // Costs nothing, so the only thing being enforced here is that the
    // player actually FOUND the thing they are placing -- which is a read
    // of the stored discovery log, not of the request.
    if (req.method === "POST" && req.url === "/voidbreak/planet/decorate") {
        try {
            const body = await readJsonBody(req);
            const auth = voidbreakEndgameAuth(body);
            if (auth.error) { sendJson(res, auth.error, { error: auth.message }); return; }

            const current = auth.account.voidbreak ? auth.account.voidbreak.data : Voidbreak.defaultSaveData();
            const wanted = (body.decorationId === null || body.decorationId === undefined) ? null : String(body.decorationId);
            const result = Voidbreak.placeDecoration(current, body.plot, wanted);
            if (!result.ok) { sendJson(res, result.code || 400, { error: result.error }); return; }

            if (!(await commitVoidbreakSave(auth.sub, auth.account, result.save))) {
                sendJson(res, 503, { error: "Could not save placement -- try again" });
                return;
            }
            sendJson(res, 200, {
                ok: true,
                plot: result.plot,
                decorationId: result.decoration ? result.decoration.id : null,
                cleared: !!result.cleared,
                endgame: Voidbreak.endgameView(result.save),
                data: result.save,
                version: auth.account.voidbreak.version
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- POST /voidbreak/mastery/claim ---- body: { sessionToken, weapon, level } ----
    // The mastery LEVEL is recomputed from the stored XP here; a client
    // asking to claim a level it hasn't reached is refused, and the
    // claim key makes a replayed request a 409 rather than a second
    // payout.
    if (req.method === "POST" && req.url === "/voidbreak/mastery/claim") {
        try {
            const body = await readJsonBody(req);
            const auth = voidbreakEndgameAuth(body);
            if (auth.error) { sendJson(res, auth.error, { error: auth.message }); return; }

            const current = auth.account.voidbreak ? auth.account.voidbreak.data : Voidbreak.defaultSaveData();
            const result = Voidbreak.claimMastery(current, body.weapon, body.level);
            if (!result.ok) { sendJson(res, result.code || 400, { error: result.error }); return; }

            if (!(await commitVoidbreakSave(auth.sub, auth.account, result.save))) {
                sendJson(res, 503, { error: "Could not save reward -- try again" });
                return;
            }
            sendJson(res, 200, {
                ok: true, weapon: body.weapon, level: Math.floor(Number(body.level)),
                reward: result.reward, grantedShards: result.grantedShards,
                endgame: Voidbreak.endgameView(result.save),
                version: auth.account.voidbreak.version
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- POST /voidbreak/prestige ---- body: { sessionToken, confirm } ----
    // `confirm` must be exactly true. That's not security (the server
    // re-checks eligibility regardless) -- it's a deliberate guard so a
    // mis-routed or accidental request can never wipe a player's
    // weapons/forge/levels without the UI having explicitly asked.
    if (req.method === "POST" && req.url === "/voidbreak/prestige") {
        try {
            const body = await readJsonBody(req);
            const auth = voidbreakEndgameAuth(body);
            if (auth.error) { sendJson(res, auth.error, { error: auth.message }); return; }
            if (body.confirm !== true) { sendJson(res, 400, { error: "Prestige must be confirmed" }); return; }

            const current = auth.account.voidbreak ? auth.account.voidbreak.data : Voidbreak.defaultSaveData();
            // Eligibility is judged against the stored save. A second
            // (duplicate/replayed) prestige fails here automatically:
            // the first one reset the very progress the requirements ask
            // for, so the account is no longer eligible.
            const result = Voidbreak.applyPrestige(current);
            if (!result.ok) {
                sendJson(res, result.code || 400, { error: result.error, requirements: result.requirements || null });
                return;
            }

            if (!(await commitVoidbreakSave(auth.sub, auth.account, result.save, { markPrestige: true }))) {
                sendJson(res, 503, { error: "Could not complete prestige -- try again" });
                return;
            }
            sendJson(res, 200, {
                ok: true, prestigeLevel: result.level,
                endgame: Voidbreak.endgameView(result.save),
                version: auth.account.voidbreak.version
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // ---- GET /voidbreak/leaderboard?sessionToken=...&limit=... ----
    // Public ladder, same shape and privacy rules as /ranked/leaderboard:
    // sessionToken is optional and only used to report "your rank is
    // #N"; the rows themselves never expose `sub` (a player's Google
    // account id) or anything but the public Voidbreak columns.
    if (req.method === "GET" && req.url.startsWith("/voidbreak/leaderboard")) {
        const urlObj = new URL(req.url, "http://x");
        const limitRaw = parseInt(urlObj.searchParams.get("limit"), 10);
        const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 20;

        const rows = getVoidbreakLeaderboard();
        const sub = sessions[urlObj.searchParams.get("sessionToken")];

        let you = null;
        if (sub) {
            for (let i = 0; i < rows.length; i++) {
                if (rows[i].sub === sub) {
                    you = {
                        position: i + 1, name: rows[i].name, prestige: rows[i].prestige,
                        kills: rows[i].kills, mastery: rows[i].mastery, best: rows[i].best, runs: rows[i].runs
                    };
                    break;
                }
            }
        }

        sendJson(res, 200, {
            total: rows.length,
            you: you,
            entries: rows.slice(0, limit).map((r, i) => ({
                position: i + 1, name: r.name, prestige: r.prestige,
                kills: r.kills, mastery: r.mastery, best: r.best, runs: r.runs
            }))
        });
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

    // ---- GET /leaderboard?sort=coins|kills|wins ----
    if (req.method === "GET" && req.url.startsWith("/leaderboard")) {
        const urlObj = new URL(req.url, "http://x");
        const sortKey = ["coins", "kills", "wins"].includes(urlObj.searchParams.get("sort"))
            ? urlObj.searchParams.get("sort") : "coins";

        sendJson(res, 200, { sort: sortKey, entries: getCasualLeaderboard(sortKey) });
        return;
    }

    // ---- GET /news ----
    // Public, read-only. No account/session involved -- every player
    // (including a guest) sees the same admin-posted list.
    if (req.method === "GET" && req.url === "/news") {
        sendJson(res, 200, { items: newsItems.slice(0, 20).map(publicNewsItem) });
        return;
    }

    // ---- POST /admin/news ----
    // body: { sessionToken, action: "create"|"delete", ... }
    // Admin-only, audited through the same pushAdminLog trail as every
    // other admin action. Posting/removing news never touches an
    // account -- no currency, ownership, or stat is readable or
    // writable from this endpoint.
    if (req.method === "POST" && req.url === "/admin/news") {
        try {
            const body = await readJsonBody(req);
            if (!isAdminSession(body.sessionToken)) {
                sendJson(res, 403, { error: "Forbidden -- admin access required" });
                return;
            }
            const adminAccount = getAccountForSession(body.sessionToken);

            if (body.action === "create") {
                const title = String(body.title || "").trim();
                const text = String(body.body || "").trim();
                const tag = NEWS_TAGS.includes(body.tag) ? body.tag : "NEWS";
                if (title.length < 3 || title.length > 80) {
                    sendJson(res, 400, { error: "Title must be 3-80 characters" });
                    return;
                }
                if (text.length < 3 || text.length > 2000) {
                    sendJson(res, 400, { error: "Body must be 3-2000 characters" });
                    return;
                }
                const item = {
                    id: crypto.randomUUID(),
                    title: title,
                    body: text,
                    tag: tag,
                    createdAt: Date.now(),
                    author: adminAccount ? adminAccount.name : "unknown"
                };
                newsItems.unshift(item);
                if (newsItems.length > 50) newsItems.length = 50;
                persistNewsItems();
                pushAdminLog({
                    admin: adminAccount ? adminAccount.name : "unknown",
                    type: "newsCreate",
                    newsId: item.id,
                    title: item.title,
                    tag: item.tag
                });
                sendJson(res, 200, { ok: true, item: publicNewsItem(item) });
                return;
            }

            if (body.action === "delete") {
                const id = String(body.id || "");
                const idx = newsItems.findIndex(n => n.id === id);
                if (idx === -1) {
                    sendJson(res, 404, { error: "Post not found" });
                    return;
                }
                const removed = newsItems[idx];
                newsItems.splice(idx, 1);
                persistNewsItems();
                pushAdminLog({
                    admin: adminAccount ? adminAccount.name : "unknown",
                    type: "newsDelete",
                    newsId: removed.id,
                    title: removed.title
                });
                sendJson(res, 200, { ok: true });
                return;
            }

            sendJson(res, 400, { error: "Unknown action" });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
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
            // ever touches `ranked` -- coins/crystals/kills/wins/skins/powers
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
    // Admin-only player lookup for Currency Management. Matches by display
    // name (case-insensitive substring) or an exact account id, and
    // returns only what the admin UI actually needs to pick a target and
    // show its current balance -- never email or anything else from the
    // account record. Reads the same `accounts` object /save writes to,
    // so the balance shown is always the authoritative one, live.
    // ---- GET /admin/playtime?sessionToken=...&sort=total|measured|recent ----
    // Every player's playtime and account email, admin only. Emails are
    // deliberately exposed nowhere else (friend lists use account ids).
    if (req.method === "GET" && req.url.startsWith("/admin/playtime")) {
        const urlObj = new URL(req.url, "http://x");
        if (!isAdminSession(urlObj.searchParams.get("sessionToken"))) {
            sendJson(res, 403, { error: "Forbidden -- admin access required" });
            return;
        }
        const sort = urlObj.searchParams.get("sort") || "total";
        const rows = Object.keys(accounts).map(sub => Object.assign(
            { id: sub, name: accounts[sub].name || "Player" }, adminActivityFields(sub)));
        const key = sort === "measured" ? "playtimeSeconds" : sort === "recent" ? "lastSeenAt" : "playtimeTotalSeconds";
        rows.sort((a, b) => (b[key] - a[key]) || a.name.localeCompare(b.name));
        let measured = 0, estimated = 0;
        for (const r of rows) { measured += r.playtimeSeconds; estimated += r.playtimeEstimatedSeconds; }
        sendJson(res, 200, {
            players: rows,
            totals: { players: rows.length, online: rows.filter(r => r.online).length,
                      measuredSeconds: measured, estimatedSeconds: estimated },
            trackingNote: "Measured = connected time recorded since playtime tracking began. " +
                "Estimated = one-time estimate of earlier play, derived from each account's match, ranked and Voidbreak history."
        });
        return;
    }

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
            .map(sub => {
                const vb = accounts[sub].voidbreak;
                const vbData = vb ? vb.data : null;
                return {
                    id: sub,
                    name: accounts[sub].name,
                    coins: accounts[sub].coins,
                    crystals: accounts[sub].crystals,
                    // Voidbreak balances, so the VOIDBREAK ADMIN panel can
                    // show the real numbers without a second round trip.
                    // `voidShards` is the LIFETIME earned total and
                    // `voidShardsSpendable` is what the player can actually
                    // spend (lifetime minus the server's spend ledger) --
                    // both shown, because a grant moves the first and the
                    // player feels the second.
                    voidShards: vbData ? (vbData.shards || 0) : 0,
                    voidShardsSpendable: vbData ? Voidbreak.spendableShards(vbData) : 0,
                    hasVoidbreakSave: !!vb,
                    ...adminActivityFields(sub)
                };
            });
        sendJson(res, 200, { results: results });
        return;
    }

    // ---- POST /admin/currency ----
    // body: { sessionToken, playerId, currency: 'coins'|'crystals', amount, reason }
    // Server-authoritative currency adjustment: verifies admin + target +
    // currency + amount + reason, then adjusts the account's own stored
    // balance (never accepts a client-supplied newBalance) and persists
    // it. `amount` can be negative -- that's how an admin REMOVES
    // currency -- but the result can never go below zero (see the
    // check against the live balance below). Node's single-threaded
    // event loop means the read of the balance and the adjustment below
    // run with no `await` in between, so no other request can
    // interleave and race the read-modify-write. The persist that
    // follows is awaited and serialized per account by the storage
    // layer, so concurrent adjustments are written in the order they
    // were applied. Every adjustment is logged with WHO, WHAT, HOW MUCH
    // and WHY (the required reason) via pushAdminLog, same as every
    // other admin action already is.
    if (req.method === "POST" && req.url === "/admin/currency") {
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

            const currency = body.currency === "crystals" ? "crystals" : (body.currency === "coins" ? "coins" : null);
            if (!currency) {
                sendJson(res, 400, { error: "Currency must be \"coins\" or \"crystals\"" });
                return;
            }

            if (!isValidCurrencyAdjustment(body.amount)) {
                sendJson(res, 400, { error: "Invalid amount" });
                return;
            }
            const amount = Number(body.amount);

            const reason = validateAdminReason(body.reason);
            if (!reason) {
                sendJson(res, 400, { error: "A reason (3-200 characters) is required" });
                return;
            }

            const previousBalance = target[currency] || 0;
            const nextBalance = previousBalance + amount;
            if (nextBalance < 0) {
                sendJson(res, 400, { error: "That would take the balance below zero" });
                return;
            }

            target[currency] = nextBalance; // atomic adjustment, not a client-supplied total
            try {
                await persistAccount(body.playerId);
            } catch (e) {
                target[currency] = previousBalance; // write failed -- undo the in-memory adjustment
                sendJson(res, 503, { error: "Could not save adjustment -- try again" });
                return;
            }

            pushAdminLog({
                admin: adminAccount ? adminAccount.name : "unknown",
                type: "currencyAdjust",
                currency: currency,
                targetPlayer: target.name,
                targetId: body.playerId,
                amount: amount,
                previousBalance: previousBalance,
                newBalance: target[currency],
                reason: reason
            });

            sendJson(res, 200, {
                ok: true,
                playerId: body.playerId,
                name: target.name,
                currency: currency,
                previousBalance: previousBalance,
                newBalance: target[currency]
            });
        } catch (e) {
            sendJson(res, 400, { error: "Bad request" });
        }
        return;
    }

    // =====================================================================
    // VOIDBREAK ADMIN -- grant Void Shards
    //
    // body: { sessionToken, playerId, amount, reason }
    //
    // Deliberately built on the SAME pattern as /admin/currency above --
    // same admin check, same required audit reason, same atomic
    // read-modify-write with in-memory rollback on a failed persist, and
    // the same pushAdminLog trail. It is not a second admin system, just
    // another action inside the existing one.
    //
    // SECURITY: the ONLY thing that decides whether this is allowed is
    // isAdminSession(body.sessionToken), resolved server-side from the
    // session to the account's stored email (see isAdminSession). There
    // is no client-supplied "isAdmin" flag anywhere in this handler, and
    // hiding the panel in the UI is presentation only -- a normal player
    // POSTing this endpoint directly gets a 403 exactly like any other
    // admin route.
    //
    // WHAT IT WRITES: the target account's OWN Voidbreak cloud save
    // (account.voidbreak.data.shards), which is the same record every
    // device reads through /voidbreak/state. So a grant lands on the
    // account, never on the admin's device or anyone's localStorage, and
    // reaches the player's Mac/iPad/phone the next time they sync.
    //
    // WHY `shards` AND NOT A SEPARATE BALANCE: `shards` is the LIFETIME
    // earned counter and spendable = shards - shardsSpent (see
    // voidbreak.js's spendableShards). Adding to `shards` therefore
    // raises what the player can actually spend, without touching the
    // spend ledger or any other progression field. It is also the field
    // the save-conflict resolver MAX-merges, so a granted amount cannot
    // be lost by another device syncing an older save afterwards, and
    // cannot be duplicated either (MAX never sums).
    if (req.method === "POST" && req.url === "/admin/voidbreak/grant") {
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

            // Positive whole numbers only. Unlike /admin/currency this
            // deliberately does NOT accept a negative amount: taking
            // Void Shards away would have to fight the MAX-merge that
            // keeps grants safe from a stale device re-uploading an
            // older save (the higher pre-removal number would simply win
            // back), so a "removal" here would silently un-apply itself.
            const amount = Number(body.amount);
            if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_VOID_SHARD_GRANT) {
                sendJson(res, 400, { error: "Amount must be a whole number between 1 and " + MAX_VOID_SHARD_GRANT });
                return;
            }

            const reason = validateAdminReason(body.reason);
            if (!reason) {
                sendJson(res, 400, { error: "A reason (3-200 characters) is required" });
                return;
            }

            const previous = target.voidbreak;
            // An account that has never played Voidbreak has no save
            // yet -- create a default one rather than refusing, so a
            // grant works for any player.
            const baseData = previous ? previous.data : Voidbreak.defaultSaveData();
            const previousShards = Math.max(0, Math.floor(Number(baseData.shards) || 0));
            const nextShards = previousShards + amount;

            // Copy-then-commit: the stored record is only replaced once
            // the account write succeeds (commitVoidbreakSave rolls the
            // in-memory change back otherwise), so a failed persist can
            // never leave a granted balance that isn't on disk.
            const nextData = Voidbreak.sanitizeSaveData(
                Object.assign({}, baseData, { shards: nextShards }));
            // sanitizeSaveData only validates the client-reported half;
            // carry the server-owned fields forward untouched so a grant
            // can never clear a purchase, an equip, a mastery claim or a
            // prestige.
            const merged = Voidbreak.applyClientSave(nextData, baseData);

            const ok = await commitVoidbreakSave(body.playerId, target, merged);
            if (!ok) {
                sendJson(res, 503, { error: "Could not save the grant -- try again" });
                return;
            }

            pushAdminLog({
                admin: adminAccount ? adminAccount.name : "unknown",
                type: "voidShardGrant",
                targetPlayer: target.name,
                targetId: body.playerId,
                amount: amount,
                previousBalance: previousShards,
                newBalance: merged.shards,
                reason: reason
            });

            sendJson(res, 200, {
                ok: true,
                playerId: body.playerId,
                name: target.name,
                amount: amount,
                previousBalance: previousShards,
                newBalance: merged.shards,
                spendable: Voidbreak.spendableShards(merged),
                version: target.voidbreak.version
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
    // HEAD is handled too: iOS/iPadOS Safari probes media with one
    // before it will stream it.
    if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(req, res);
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

// ---------------------------------------------------------------------
// SHADOW HIT DETECTION (off by default)
//
// Runs the server's OWN hit detection alongside the client's, without
// acting on it, purely to measure whether the two agree -- see shadow.js
// for why that measurement has to come before this can be promoted to
// authoritative. Set SHADOW_HIT_DETECTION=1 to enable, then read the
// agreement counters from GET /__net/stats (which additionally needs
// DEBUG_NETWORKING=1).
//
// When the flag is off, no detector is ever created, the tick below is
// never started, and every call site short-circuits on a null check.
// ---------------------------------------------------------------------
const SHADOW_HIT_DETECTION = process.env.SHADOW_HIT_DETECTION === "1";
const SHADOW_TICK_MS = 16;

let casualShadow = SHADOW_HIT_DETECTION ? Shadow.createShadowDetector() : null;

// Every live detector, stepped from ONE timer rather than one timer per
// match -- a few hundred microseconds of work for a handful of bullets.
function shadowDetectors() {
    const out = [];
    if (casualShadow) out.push({ shadow: casualShadow, combat: casualCombat });
    for (const match of rankedMatches.values()) {
        if (match.shadow && !match.finished) out.push({ shadow: match.shadow, combat: match.combat });
    }
    return out;
}

if (SHADOW_HIT_DETECTION) {
    console.log("[shadow] hit-detection shadow mode ENABLED (measuring only -- no damage is applied from it)");
    setInterval(() => {
        const now = Date.now();
        for (const d of shadowDetectors()) {
            d.shadow.step(now, slot => d.combat.isAlive(slot));
        }
    }, SHADOW_TICK_MS).unref();
}

// Aggregated agreement numbers across every live match.
function shadowSnapshot() {
    if (!SHADOW_HIT_DETECTION) return { enabled: false };
    const totals = { enabled: true, agreed: 0, serverOnly: 0, clientOnly: 0,
                     projectilesSimulated: 0, liveProjectiles: 0, unsettled: 0, closestMissPx: null };
    for (const d of shadowDetectors()) {
        const s = d.shadow.snapshot();
        totals.agreed += s.agreed;
        totals.serverOnly += s.serverOnly;
        totals.clientOnly += s.clientOnly;
        totals.projectilesSimulated += s.projectilesSimulated;
        totals.liveProjectiles += s.liveProjectiles;
        totals.unsettled += s.unsettled;
        if (s.closestMissPx !== null && (totals.closestMissPx === null || s.closestMissPx < totals.closestMissPx)) {
            totals.closestMissPx = s.closestMissPx;
        }
    }
    const decided = totals.agreed + totals.serverOnly + totals.clientOnly;
    totals.agreementPct = decided ? Math.round(totals.agreed / decided * 1000) / 10 : null;
    return totals;
}

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
    if (casualShadow) casualShadow.reset();
    for (const slot of [1, 2]) {
        if (slots[slot]) casualCombat.setShields(slot, shieldsForConnection(slots[slot]));
    }
}

// Sends one authoritative health line to both sides of a match. Both
// clients render exactly this -- neither computes its own.
function broadcastHealth(a, b, result) {
    // Serialised once and sent twice: both sides receive byte-identical
    // authoritative numbers, and the server pays for one stringify
    // instead of two.
    const payload = JSON.stringify({
        type: "health",
        slot: result.slot,
        by: result.by,
        health: result.health,
        shields: result.shields,
        blocked: result.blocked,
        eliminated: result.eliminated,
        kind: result.kind
    });
    sendRaw(a, payload);
    sendRaw(b, payload);
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
// ONLINE LOBBIES AND MATCH ROOMS
//
// What this replaces
// ------------------
// Casual online used to be ONE pair of global slots (`slots` above), so
// the whole server could host exactly one duel, always 1v1, always
// "P1 vs P2". That path is untouched and still works exactly as it did
// -- it is what the original ONLINE MULTIPLAYER button uses.
//
// Everything below is the NEW path, and it is built the way ranked
// already proved works here: a MATCH ROOM per match, several at a time,
// each owning its own combat state. What it adds on top is that a room
// is described by DATA (see party.js) rather than by code that knows
// there are two players:
//
//   * PvP rooms: 1v1, 1v1v1, 1v1v1v1, 2v1, 2v2 -- and any future
//     configuration, which is one entry in party.js's MATCH_TYPES and
//     no change at all down here.
//   * CO-OP rooms: 2-4 players sharing ONE Voidbreak PvE simulation
//     (see voidbreakCoop.js), which this layer ticks and broadcasts.
//
// TRUST
// -----
// Every rule a client could want to lie about is decided here:
//   * which slot a connection is          -- from the lobby, never sent
//   * which team a slot is on             -- from the lobby, never sent
//   * whether a hit lands, and for how much -- combat.js, team-checked
//   * who won a round, and the match      -- party.js against combat.js
//   * what a player is paid               -- this file, once, at the end
// A client never sends a player id, a team id, a damage number, a kill,
// a win, a reward, or a match result. There is no message for any of
// those, which is the strongest form the guarantee can take.
// =====================================================================

const lobbies = new Map();        // lobbyId -> lobby record (lobby.js)
const lobbyByCode = new Map();    // CODE -> lobbyId
const lobbyOfSub = new Map();     // accountId -> lobbyId
const arenaMatches = new Map();   // matchId -> PvP match room
const coopMatches = new Map();    // matchId -> co-op match room
const matchOfSub = new Map();     // accountId -> matchId (either kind)

let nextLobbySeq = 1;
let nextMatchSeq = 1;
function newLobbyId() { return "lb_" + (nextLobbySeq++) + "_" + crypto.randomBytes(3).toString("hex"); }
function newArenaMatchId() { return "am_" + (nextMatchSeq++) + "_" + crypto.randomBytes(3).toString("hex"); }

// How long a match room may live before it is torn down regardless of
// what its players are doing. Mirrors ranked's own matchTimeoutMs guard:
// a room nobody ever finishes must not leak.
const ARENA_MATCH_TIMEOUT_MS = 30 * 60 * 1000;
const COOP_MATCH_TIMEOUT_MS = 45 * 60 * 1000;
// Between a round ending and the next one starting. The SERVER owns
// this timer, so every client's countdown agrees.
const ARENA_ROUND_GAP_MS = 2600;
// A match starts when everyone has loaded in, or after this, whichever
// comes first -- one client failing to report ready can't hang a lobby.
const ARENA_LOAD_TIMEOUT_MS = 15000;
// How long a disconnected player's slot is held before their team
// forfeits it. Short enough that nobody waits around, long enough to
// survive a phone changing network.
const ARENA_DISCONNECT_GRACE_MS = 12000;

function mpError(conn, message) {
    send(conn, { type: "mp_error", message: message });
}

// The multiplayer position frame, built as a string directly for the
// same reason positionFrame() is (see its comment): it runs once per
// player per network tick and the generic serialiser was the single
// most-executed allocation on this server. `id` is stamped from the
// CONNECTION's own slot -- a client cannot move anybody but itself.
function mpPositionFrame(slot, data) {
    let s = '{"type":"mp_pos","id":' + slot +
            ',"x":' + finiteNum(data.x) +
            ',"y":' + finiteNum(data.y) +
            ',"facing":' + finiteNum(data.facing);
    if (typeof data.seq === "number" && isFinite(data.seq)) s += ',"seq":' + (data.seq | 0);
    if (data.d === 1) s += ',"d":1';
    return s + "}";
}

// ---------------------------------------------------------------------
// LOBBY PLUMBING
// ---------------------------------------------------------------------

function lobbyOf(conn) {
    if (!conn.authSub) return null;
    const id = lobbyOfSub.get(conn.authSub);
    return id ? lobbies.get(id) || null : null;
}

// Every connection currently sitting in this lobby, by account id.
// A member with no live socket simply does not receive -- their record
// stays so the roster does not shuffle under everyone else.
function connsInLobby(lobby) {
    const out = [];
    for (const m of lobby.members) {
        const conn = mpConnBySub.get(m.sub);
        if (conn) out.push({ member: m, conn: conn });
    }
    return out;
}

// The socket a given account is using for lobby/match traffic. Set when
// a connection sends its first mp_* message on an authenticated socket,
// so a player with the game open in two tabs cannot end up half in a
// lobby on one and half in a match on the other.
const mpConnBySub = new Map();

function broadcastLobby(lobby) {
    for (const row of connsInLobby(lobby)) {
        // publicView is per-viewer (it marks "you" and "host"), so this
        // is one serialise per member rather than one for the room. A
        // lobby is at most four people and this only runs on a roster
        // change, never per frame.
        send(row.conn, { type: "mp_lobby", lobby: Lobby.publicView(lobby, row.member.sub) });
    }
}

function destroyLobby(lobby) {
    lobby.state = "closed";
    lobbies.delete(lobby.id);
    if (lobbyByCode.get(lobby.code) === lobby.id) lobbyByCode.delete(lobby.code);
    for (const m of lobby.members) {
        if (lobbyOfSub.get(m.sub) === lobby.id) lobbyOfSub.delete(m.sub);
    }
    lobby.members = [];
}

function uniqueLobbyCode() {
    for (let i = 0; i < 40; i++) {
        const code = Lobby.makeCode(Math.random);
        if (!lobbyByCode.has(code)) return code;
    }
    return null;
}

// The identity a lobby member is created from. Read from the ACCOUNT,
// never from the message -- a client cannot name itself.
function lobbyIdentityFor(sub) {
    const account = accounts[sub];
    if (!account) return null;
    ensureAccountXP(sub);
    return { sub: sub, name: account.name, level: account.level || 1 };
}

function handleLobbyCreate(conn, typeId, isPrivate) {
    if (lobbyOfSub.has(conn.authSub)) { mpError(conn, "You are already in a lobby"); return; }
    if (matchOfSub.has(conn.authSub)) { mpError(conn, "You are already in a match"); return; }
    if (!Party.isMatchType(typeId)) { mpError(conn, "Unknown match type"); return; }

    const code = uniqueLobbyCode();
    if (!code) { mpError(conn, "Could not allocate a room code -- try again"); return; }

    const created = Lobby.createLobby({
        id: newLobbyId(), code: code, typeId: typeId,
        hostSub: conn.authSub, now: Date.now(), private: !!isPrivate
    });
    if (!created.ok) { mpError(conn, created.error); return; }

    const lobby = created.lobby;
    const me = lobbyIdentityFor(conn.authSub);
    if (!me) { mpError(conn, "Sign in to play online"); return; }
    Lobby.join(lobby, me, Date.now());

    lobbies.set(lobby.id, lobby);
    lobbyByCode.set(code, lobby.id);
    lobbyOfSub.set(conn.authSub, lobby.id);
    conn.lobbyId = lobby.id;
    broadcastLobby(lobby);
}

function handleLobbyJoin(conn, rawCode) {
    if (lobbyOfSub.has(conn.authSub)) { mpError(conn, "You are already in a lobby"); return; }
    if (matchOfSub.has(conn.authSub)) { mpError(conn, "You are already in a match"); return; }

    const code = Lobby.normalizeCode(rawCode);
    if (!code) { mpError(conn, "That is not a valid room code"); return; }
    const id = lobbyByCode.get(code);
    const lobby = id ? lobbies.get(id) : null;
    if (!lobby) { mpError(conn, "No room with that code"); return; }

    const me = lobbyIdentityFor(conn.authSub);
    if (!me) { mpError(conn, "Sign in to play online"); return; }

    // join() is where "full", "already started" and "already in" are
    // all refused -- this layer never second-guesses it.
    const result = Lobby.join(lobby, me, Date.now());
    if (!result.ok) { mpError(conn, result.error); return; }

    lobbyOfSub.set(conn.authSub, lobby.id);
    conn.lobbyId = lobby.id;
    broadcastLobby(lobby);
}

// QUICK PLAY. Finds the fullest open PUBLIC lobby of the requested type
// (fullest, so players collect into one room instead of spreading one
// per room and nobody ever starting) and joins it; creates one if there
// is none.
function handleLobbyQuick(conn, typeId) {
    if (!Party.isMatchType(typeId)) { mpError(conn, "Unknown match type"); return; }
    if (lobbyOfSub.has(conn.authSub)) { mpError(conn, "You are already in a lobby"); return; }

    let best = null;
    for (const lobby of lobbies.values()) {
        if (lobby.private || lobby.typeId !== typeId || lobby.state !== "open") continue;
        if (lobby.members.length >= lobby.maxPlayers) continue;
        if (!best || lobby.members.length > best.members.length) best = lobby;
    }
    if (best) { handleLobbyJoin(conn, best.code); return; }
    handleLobbyCreate(conn, typeId, false);
}

function handleLobbyLeave(conn, silent) {
    const lobby = lobbyOf(conn);
    if (!lobby) return;
    const result = Lobby.leave(lobby, conn.authSub, Date.now());
    lobbyOfSub.delete(conn.authSub);
    conn.lobbyId = null;
    if (!silent) send(conn, { type: "mp_left" });
    if (!result.ok) return;
    if (result.empty) { destroyLobby(lobby); return; }
    broadcastLobby(lobby);
}

function handleLobbyBrowse(conn) {
    const rows = [];
    for (const lobby of lobbies.values()) {
        if (lobby.private || lobby.state !== "open") continue;
        if (lobby.members.length >= lobby.maxPlayers) continue;
        rows.push(Lobby.browserRow(lobby));
    }
    rows.sort((a, b) => (b.players - a.players) || a.label.localeCompare(b.label));
    send(conn, { type: "mp_browse", rows: rows.slice(0, 40) });
}

// ---------------------------------------------------------------------
// PvP MATCH ROOMS
// ---------------------------------------------------------------------

function arenaMatchOf(conn) {
    return conn.mpMatchId ? arenaMatches.get(conn.mpMatchId) || null : null;
}

// The public description of a match, built ONCE and sent to everybody.
// Slots, teams and spawn points are all decided here; a client is told
// what it is, never asked.
function arenaMatchIntro(match, slot) {
    return {
        type: "mp_match",
        matchId: match.id,
        typeId: match.typeId,
        label: match.label,
        kind: "pvp",
        yourSlot: slot,
        yourTeam: match.teams[slot],
        roundsToWin: match.roundsToWin,
        teamCount: match.teamCount,
        maxPlayers: match.maxPlayers,
        players: match.slots.map(s => ({
            slot: s,
            team: match.teams[s],
            name: match.players[s].name,
            level: match.players[s].level,
            spawn: match.spawns[s]
        }))
    };
}

function arenaBroadcast(match, payload, exceptSlot) {
    const raw = JSON.stringify(payload);
    for (const s of match.slots) {
        if (s === exceptSlot) continue;
        const p = match.players[s];
        if (p && p.conn) sendRaw(p.conn, raw);
    }
}

function createArenaMatch(lobby) {
    const type = Party.getMatchType(lobby.typeId);
    const now = Date.now();
    const id = newArenaMatchId();

    const teams = {};
    const spawns = {};
    const slots = [];
    for (const m of lobby.members) {
        teams[m.slot] = m.team;
        spawns[m.slot] = Party.spawnIndexForSlot(type, m.slot);
        slots.push(m.slot);
    }
    slots.sort((a, b) => a - b);

    const match = {
        id: id,
        kind: "pvp",
        lobbyId: lobby.id,
        typeId: type.id,
        label: type.label,
        teamCount: type.teamCount,
        maxPlayers: type.maxPlayers,
        roundsToWin: type.roundsToWin,
        slots: slots,
        teams: teams,
        spawns: spawns,
        players: {},
        roundWins: {},
        round: 1,
        state: "loading",
        finished: false,
        resultApplied: false,
        createdAt: now,
        roundTimer: null,
        loadTimer: null,
        timeoutTimer: null,
        // One combat state per room, with this room's OWN roster and
        // team layout -- which is what makes friendly fire impossible
        // and lets several matches run at once without interfering.
        combat: Combat.createCombatMatch(abilityConfig, { slots: slots, teams: teams })
    };
    for (let t = 1; t <= type.teamCount; t++) match.roundWins[t] = 0;

    for (const m of lobby.members) {
        const conn = mpConnBySub.get(m.sub) || null;
        match.players[m.slot] = {
            slot: m.slot, sub: m.sub, name: m.name, level: m.level,
            team: m.team, conn: conn, connected: !!conn, loaded: false,
            kills: 0, disconnectTimer: null
        };
        if (conn) {
            conn.mpMatchId = id;
            conn.mpSlot = m.slot;
            conn.mpKind = "pvp";
        }
        matchOfSub.set(m.sub, id);
        // Shields come from the player's OWN account loadout, read here
        // -- never from anything the client reports (same rule casual
        // and ranked already follow).
        const acct = accounts[m.sub];
        const kevlar = acct && Array.isArray(acct.equippedPowers) &&
            acct.equippedPowers.indexOf("kevlar") >= 0;
        match.combat.setShields(m.slot, kevlar ? 1 : 0);
    }

    arenaMatches.set(id, match);
    Lobby.markLive(lobby, id, now);

    match.timeoutTimer = setTimeout(() => {
        if (!match.finished) endArenaMatch(match, null, "timeout");
    }, ARENA_MATCH_TIMEOUT_MS);

    match.loadTimer = setTimeout(() => {
        if (match.state === "loading") startArenaRound(match);
    }, ARENA_LOAD_TIMEOUT_MS);

    for (const s of slots) {
        const p = match.players[s];
        if (p.conn) send(p.conn, arenaMatchIntro(match, s));
    }
    console.log("[mp] " + type.id + " match " + id + " started with " + slots.length + " player(s)");
    return match;
}

function startArenaRound(match) {
    if (match.finished) return;
    if (match.loadTimer) { clearTimeout(match.loadTimer); match.loadTimer = null; }
    match.combat.resetRound();
    match.state = "playing";
    arenaBroadcast(match, {
        type: "mp_round_start",
        round: match.round,
        wins: match.roundWins
    });
}

// The ONLY place a round is decided. It reads combat.js for who is
// alive and party.js for what that means -- no client input at all.
function evaluateArenaRound(match) {
    if (match.finished || match.state !== "playing") return;
    const verdict = Party.resolveRoundWinner(
        match.teams, match.slots, slot => match.combat.isAlive(slot));
    if (!verdict.decided) return;

    match.state = "roundEnd";

    if (verdict.team !== null) match.roundWins[verdict.team]++;

    arenaBroadcast(match, {
        type: "mp_round_end",
        round: match.round,
        winnerTeam: verdict.team,
        drawn: verdict.drawn,
        wins: match.roundWins,
        nextInMs: ARENA_ROUND_GAP_MS
    });

    // Round-win XP for everyone on the winning team. Server-decided, so
    // there is no client report to forge or replay.
    if (verdict.team !== null) {
        for (const s of match.slots) {
            if (match.teams[s] !== verdict.team) continue;
            const p = match.players[s];
            if (p && p.sub) awardXPAndNotify(p.conn, XP_REWARDS.round_win, "round_win", COIN_REWARDS.round_win);
        }
    }

    if (verdict.team !== null && match.roundWins[verdict.team] >= match.roundsToWin) {
        match.roundTimer = setTimeout(() => endArenaMatch(match, verdict.team, "rounds"), ARENA_ROUND_GAP_MS);
        return;
    }

    match.round++;
    match.roundTimer = setTimeout(() => startArenaRound(match), ARENA_ROUND_GAP_MS);
}

// Kills, round wins and match wins are all awarded from the server's own
// state machine, at the moment it confirms them. Nothing here comes from
// a client report, so none of it can be forged or double-claimed.
async function awardArenaKill(sub) {
    const account = accounts[sub];
    if (!account) return;
    account.kills = (account.kills || 0) + 1;
    await awardXP(sub, XP_REWARDS.kill, "kill", COIN_REWARDS.kill);
}

async function awardArenaMatchWin(sub, playerCount) {
    const account = accounts[sub];
    if (!account) return null;
    account.wins = (account.wins || 0) + 1;
    // Mirrors matchWinBonus() in index.html and /xp/report's own
    // player-count scaling: 40 Coins plus 10 per player beyond two.
    const coins = 40 + Math.max(0, Math.min(4, playerCount) - 2) * 10;
    return awardXP(sub, XP_REWARDS.match_win, "match_win", coins);
}

function endArenaMatch(match, winnerTeam, reason) {
    if (!match || match.resultApplied) return;
    match.resultApplied = true;   // claim BEFORE any await -- no interleaving
    match.finished = true;
    match.state = "finished";

    if (match.roundTimer) { clearTimeout(match.roundTimer); match.roundTimer = null; }
    if (match.loadTimer) { clearTimeout(match.loadTimer); match.loadTimer = null; }
    if (match.timeoutTimer) { clearTimeout(match.timeoutTimer); match.timeoutTimer = null; }
    for (const s of match.slots) {
        const p = match.players[s];
        if (p && p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
    }

    const playerCount = match.slots.length;
    const winners = winnerTeam === null ? [] : Party.slotsOnTeam(match.teams, winnerTeam);

    arenaBroadcast(match, {
        type: "mp_match_end",
        winnerTeam: winnerTeam,
        reason: reason,
        wins: match.roundWins,
        winners: winners,
        scoreboard: match.slots.map(s => ({
            slot: s, team: match.teams[s],
            name: match.players[s].name,
            kills: match.players[s].kills,
            connected: match.players[s].connected
        }))
    });

    for (const s of winners) {
        const p = match.players[s];
        // Only a player who was actually still in the match is paid --
        // a forfeit does not pay the player who left.
        if (p && p.sub && p.connected) {
            awardArenaMatchWin(p.sub, playerCount)
                .then(result => { if (result && p.conn) send(p.conn, Object.assign({ type: "xpAward" }, result)); })
                .catch(e => console.log("[mp] match win award failed:", e.message));
        }
    }

    cleanupArenaMatch(match);
    console.log("[mp] match " + match.id + " finished (" + reason + ")" +
        (winnerTeam ? " -- team " + winnerTeam + " wins" : ""));
}

function cleanupArenaMatch(match) {
    for (const s of match.slots) {
        const p = match.players[s];
        if (!p) continue;
        if (matchOfSub.get(p.sub) === match.id) matchOfSub.delete(p.sub);
        if (p.conn && p.conn.mpMatchId === match.id) {
            p.conn.mpMatchId = null;
            p.conn.mpSlot = null;
            p.conn.mpKind = null;
        }
        p.conn = null;
    }
    arenaMatches.delete(match.id);

    // Everyone lands back in the room they came from rather than the
    // main menu, and the room is cleaned up if nobody is left in it.
    const lobby = lobbies.get(match.lobbyId);
    if (lobby) {
        Lobby.returnToLobby(lobby, Date.now());
        if (!lobby.members.length) destroyLobby(lobby);
        else broadcastLobby(lobby);
    }
}

// Re-attaches a returning player to the match they dropped out of, if
// that match is still live and their slot has not been forfeited yet
// (see the grace window in handleArenaDisconnect). This is what makes
// that window mean something: a phone changing network mid-round comes
// back into the same match instead of losing it.
//
// Identity comes from the ACCOUNT, which was proved with a session
// token this server issued -- a client cannot ask to be re-attached as
// somebody else, because it never names who it is.
function tryArenaReconnect(conn) {
    const matchId = matchOfSub.get(conn.authSub);
    if (!matchId) return false;
    const match = arenaMatches.get(matchId);
    if (!match || match.finished) return false;

    let slot = null;
    for (const s of match.slots) {
        if (match.players[s].sub === conn.authSub) { slot = s; break; }
    }
    if (slot === null) return false;
    const me = match.players[slot];
    if (me.connected && me.conn) return false;   // still here on another socket

    if (me.disconnectTimer) { clearTimeout(me.disconnectTimer); me.disconnectTimer = null; }
    me.connected = true;
    me.conn = conn;
    conn.mpMatchId = match.id;
    conn.mpSlot = slot;
    conn.mpKind = "pvp";

    // The returning client rebuilds its whole view from the same intro
    // every player got, plus the CURRENT round and score -- so it comes
    // back in step with everyone else rather than a round behind.
    send(conn, arenaMatchIntro(match, slot));
    send(conn, { type: "mp_round_start", round: match.round, wins: match.roundWins });
    arenaBroadcast(match, { type: "mp_player_back", slot: slot }, slot);
    console.log("[mp] slot " + slot + " reconnected to match " + match.id);
    return true;
}

// A player's socket dropped mid-match. Their slot is held briefly, then
// forfeited: they are eliminated from the round, which lets the normal
// round/win machinery decide the consequences (a 2v2 becomes a 1v2, a
// 1v1 ends). Never a special-cased "the other player wins".
function handleArenaDisconnect(conn) {
    const match = arenaMatchOf(conn);
    if (!match || match.finished) return;
    const slot = conn.mpSlot;
    const me = match.players[slot];
    if (!me) return;

    me.connected = false;
    me.conn = null;
    arenaBroadcast(match, { type: "mp_player_left", slot: slot, graceMs: ARENA_DISCONNECT_GRACE_MS });

    const anyoneLeft = match.slots.some(s => match.players[s].connected);
    if (!anyoneLeft) { endArenaMatch(match, null, "everyoneLeft"); return; }

    if (me.disconnectTimer) clearTimeout(me.disconnectTimer);
    me.disconnectTimer = setTimeout(() => {
        if (match.finished) return;
        const still = match.players[slot];
        if (!still || still.connected) return; // they came back
        // Out of the round. If that leaves one team standing, the normal
        // round evaluation ends the round; if it leaves one team in the
        // MATCH, the match is over.
        match.combat.forceEliminate(slot);
        const teamsWithAnyone = [];
        for (const s of match.slots) {
            if (!match.players[s].connected) continue;
            const t = match.teams[s];
            if (teamsWithAnyone.indexOf(t) === -1) teamsWithAnyone.push(t);
        }
        if (teamsWithAnyone.length <= 1) {
            endArenaMatch(match, teamsWithAnyone[0] || null, "forfeit");
            return;
        }
        arenaBroadcast(match, {
            type: "mp_health", slot: slot, by: 0, health: 0, shields: 0,
            blocked: false, eliminated: true, kind: "disconnect"
        });
        evaluateArenaRound(match);
    }, ARENA_DISCONNECT_GRACE_MS);
}

// ---------------------------------------------------------------------
// PvP IN-MATCH RELAY
//
// Gameplay payloads are relayed to the rest of the room the same way
// casual play relays them to one opponent -- the shapes are unchanged,
// the only additions are the `id` stamp (always the CONNECTION's own
// slot, never anything the message claims) and the team-aware hit
// resolution.
// ---------------------------------------------------------------------

// Message types that are pure presentation and may be relayed as-is,
// with the sender's slot stamped on. Anything not on this list is
// dropped rather than forwarded, so a new message type cannot appear on
// the wire without being considered here first.
const MP_RELAY_TYPES = new Set([
    "mp_bullet", "mp_shockwave", "mp_timewarp", "mp_decoy",
    "mp_gravitytrap", "mp_portal", "mp_portalClear", "mp_phaseshift",
    "mp_skin", "mp_emote"
]);

function handleArenaMessage(conn, data) {
    const match = arenaMatchOf(conn);
    if (!match || match.finished) return true;
    const slot = conn.mpSlot;
    const me = match.players[slot];
    if (!me) return true;

    if (data.type === "mp_ingame_ready") {
        me.loaded = true;
        if (match.state === "loading" && match.slots.every(s => !match.players[s].connected || match.players[s].loaded)) {
            startArenaRound(match);
        }
        return true;
    }

    if (data.type === "mp_pos") {
        if (typeof data.seq === "number") conn.lastSeq = data.seq;
        // Volatile: a position is only worth sending while it is still
        // current (see sendVolatile). Serialised ONCE for the whole
        // room rather than once per recipient -- this is the hottest
        // line in a 4-player match.
        const frame = mpPositionFrame(slot, data);
        for (const s of match.slots) {
            if (s === slot) continue;
            const p = match.players[s];
            if (p && p.conn) sendVolatile(p.conn, frame);
        }
        return true;
    }

    // THE authoritative hit. The message carries only WHO the victim's
    // client thinks shot them; combat.js decides whether that is even a
    // legal shooter (alive, in this match, on another team) and what the
    // damage is. A teammate named here is refused outright.
    if (data.type === "mp_hit") {
        if (match.state !== "playing") return true;
        const result = match.combat.claimHit(slot, Date.now(), data.by);
        if (!result.accepted) return true;
        arenaBroadcast(match, {
            type: "mp_health",
            slot: result.slot, by: result.by,
            health: result.health, shields: result.shields,
            blocked: result.blocked, eliminated: result.eliminated,
            kind: result.kind
        });
        if (result.eliminated) {
            const killer = match.players[result.by];
            if (killer && killer.sub) {
                killer.kills++;
                awardArenaKill(killer.sub)
                    .then(() => {})
                    .catch(e => console.log("[mp] kill award failed:", e.message));
            }
            evaluateArenaRound(match);
        }
        return true;
    }

    if (data.type === "mp_ability") {
        match.combat.activateAbility(slot, data.ability, Date.now());
        return true;
    }

    if (MP_RELAY_TYPES.has(data.type)) {
        // Projectiles are registered as damage sources so a hit claim
        // can be checked against something that was really fired.
        if (data.type === "mp_bullet") match.combat.trackBullet(slot, data, Date.now());
        else if (data.type === "mp_shockwave") match.combat.trackShockwave(slot, Date.now());

        const payload = Object.assign({}, data);
        payload.id = slot;   // stamped from the connection, never trusted from the message
        const raw = JSON.stringify(payload);
        for (const s of match.slots) {
            if (s === slot) continue;
            const p = match.players[s];
            if (!p || !p.conn) continue;
            // Decoys are the one relay whose only value is being current.
            if (data.type === "mp_decoy") sendVolatile(p.conn, raw);
            else sendRaw(p.conn, raw);
        }
        return true;
    }

    if (data.type === "mp_leave_match") {
        handleArenaDisconnect(conn);
        // Leaving a match on purpose also leaves the room it came from.
        handleLobbyLeave(conn, false);
        return true;
    }

    return true;
}

// ---------------------------------------------------------------------
// VOIDBREAK CO-OP MATCH ROOMS
//
// The simulation itself lives in voidbreakCoop.js. This layer owns the
// clock, the sockets and the payout.
// ---------------------------------------------------------------------

function coopMatchOf(conn) {
    return conn.mpMatchId ? coopMatches.get(conn.mpMatchId) || null : null;
}

function coopBroadcast(match, payload) {
    const raw = JSON.stringify(payload);
    for (const slot of Object.keys(match.players)) {
        const p = match.players[slot];
        if (p.conn) sendRaw(p.conn, raw);
    }
}

// The player's build comes from their OWN STORED Voidbreak save, read
// here, server-side. A client cannot claim max forge levels or a weapon
// it has not unlocked, because it is never asked.
function coopLoadoutFor(sub) {
    const account = accounts[sub];
    const save = (account && account.voidbreak && account.voidbreak.data) || Voidbreak.defaultSaveData();
    // The Void Loadout's primary is what the player actually flies now;
    // `lastWeapon` is the pre-loadout field and stays the fallback so a
    // save written before the loadout existed still starts a co-op run
    // with the weapon its owner last used. Either way the answer is
    // re-checked against the STORED weapons map, so a client still
    // cannot bring a weapon it has not unlocked.
    const loadout = (save.loadout && typeof save.loadout === "object") ? save.loadout : {};
    let weapon = typeof loadout.primary === "string" ? loadout.primary
               : (typeof save.lastWeapon === "string" ? save.lastWeapon : "pulse");
    if (!save.weapons || !save.weapons[weapon]) weapon = "pulse";
    return { weapon: weapon, forge: save.forge || {} };
}

function createCoopMatch(lobby) {
    const now = Date.now();
    const id = newArenaMatchId();

    const runPlayers = [];
    const players = {};
    for (const m of lobby.members) {
        const loadout = coopLoadoutFor(m.sub);
        runPlayers.push({
            slot: m.slot, sub: m.sub, name: m.name,
            weapon: loadout.weapon, forge: loadout.forge
        });
        const conn = mpConnBySub.get(m.sub) || null;
        players[m.slot] = { slot: m.slot, sub: m.sub, name: m.name, conn: conn, connected: !!conn, loaded: false };
        if (conn) {
            conn.mpMatchId = id;
            conn.mpSlot = m.slot;
            conn.mpKind = "coop";
        }
        matchOfSub.set(m.sub, id);
    }

    const run = VoidbreakCoop.createRun({
        id: id,
        levelIdx: lobby.settings.levelIdx,
        difficulty: lobby.settings.difficulty,
        players: runPlayers
    });

    const match = {
        id: id, kind: "coop", lobbyId: lobby.id, typeId: lobby.typeId,
        players: players, run: run, started: false, finished: false,
        createdAt: now, timeoutTimer: null, loadTimer: null
    };
    coopMatches.set(id, match);
    Lobby.markLive(lobby, id, now);

    match.timeoutTimer = setTimeout(() => {
        if (!match.finished) finishCoopMatch(match, "timeout");
    }, COOP_MATCH_TIMEOUT_MS);
    match.loadTimer = setTimeout(() => beginCoopRun(match), ARENA_LOAD_TIMEOUT_MS);

    const config = run.config();
    for (const slot of Object.keys(players)) {
        const p = players[slot];
        if (p.conn) {
            send(p.conn, Object.assign({ type: "vb_match", matchId: id, yourSlot: p.slot }, config));
        }
    }
    console.log("[coop] run " + id + " created: level " + (config.levelIdx + 1) +
        " " + config.difficulty + ", " + runPlayers.length + " player(s)");
    return match;
}

function beginCoopRun(match) {
    if (match.started || match.finished) return;
    if (match.loadTimer) { clearTimeout(match.loadTimer); match.loadTimer = null; }
    match.started = true;
    match.run.begin(Date.now());
    coopBroadcast(match, { type: "vb_begin" });
}

// Pays out ONE player, exactly once. Shards go through the same
// copy-then-commit path the shop and the admin grant use, so a failed
// write can never leave a balance that is not on disk -- and
// markRewarded() is what makes a reconnect, a second disconnect or a
// duplicate end-of-run message unable to pay twice.
async function payCoopPlayer(match, slot) {
    const reward = match.run.rewardsFor(slot);
    if (!reward || !reward.sub) return;
    match.run.markRewarded(slot);

    // The socket is captured HERE, before the first await. The room is
    // torn down as soon as the run ends (see cleanupCoopMatch, which
    // nulls every player's conn), so reading it back after the account
    // write would find nothing and the player would never be told what
    // they earned.
    const conn = (match.players[slot] && match.players[slot].conn) || null;

    const account = accounts[reward.sub];
    if (!account) return;

    if (reward.shards > 0) {
        const baseData = account.voidbreak ? account.voidbreak.data : Voidbreak.defaultSaveData();
        const previousShards = Math.max(0, Math.floor(Number(baseData.shards) || 0));
        // A co-op run counts as a run in the player's Voidbreak record.
        // It deliberately does NOT touch `kills` (which counts Guardians
        // slain -- co-op has no Guardian, see voidbreakCoop.js's
        // LIMITATIONS) or `beaten` (co-op does not clear a sector for
        // the solo campaign), so the existing ladder stays honest.
        const nextData = Voidbreak.sanitizeSaveData(Object.assign({}, baseData, {
            shards: previousShards + reward.shards,
            runs: Math.max(0, Math.floor(Number(baseData.runs) || 0)) + 1
        }));
        const merged = Voidbreak.applyClientSave(nextData, baseData);
        const ok = await commitVoidbreakSave(reward.sub, account, merged);
        if (!ok) {
            console.log("[coop] could not persist shard payout for " + reward.sub);
            return;
        }
    }

    // Account XP for finishing a co-op run. Granted here, from the
    // server's own confirmation that the run completed -- there is no
    // client-facing reason code for it (see /xp/report), so it cannot
    // be reported, replayed or farmed from a browser.
    if (reward.victory) {
        const result = await awardXP(reward.sub, XP_REWARDS.voidbreak_coop_complete,
            "voidbreak_coop_complete", COIN_REWARDS.voidbreak_coop_complete);
        if (result && conn) send(conn, Object.assign({ type: "xpAward" }, result));
    }

    if (conn) {
        const save = account.voidbreak ? account.voidbreak.data : null;
        send(conn, {
            type: "vb_reward",
            shards: reward.shards,
            kills: reward.kills,
            waves: reward.waves,
            victory: reward.victory,
            totalShards: save ? save.shards : null,
            spendable: save ? Voidbreak.spendableShards(save) : null
        });
    }
}

function finishCoopMatch(match, reason) {
    if (match.finished) return;
    match.finished = true;
    if (match.timeoutTimer) { clearTimeout(match.timeoutTimer); match.timeoutTimer = null; }
    if (match.loadTimer) { clearTimeout(match.loadTimer); match.loadTimer = null; }

    for (const slot of match.run.playerSlots()) {
        payCoopPlayer(match, slot).catch(e => console.log("[coop] payout failed:", e.message));
    }

    coopBroadcast(match, { type: "vb_over", reason: reason, victory: match.run.victory });
    cleanupCoopMatch(match);
    console.log("[coop] run " + match.id + " ended (" + reason + ")");
}

function cleanupCoopMatch(match) {
    for (const slot of Object.keys(match.players)) {
        const p = match.players[slot];
        if (matchOfSub.get(p.sub) === match.id) matchOfSub.delete(p.sub);
        if (p.conn && p.conn.mpMatchId === match.id) {
            p.conn.mpMatchId = null;
            p.conn.mpSlot = null;
            p.conn.mpKind = null;
        }
        p.conn = null;
    }
    coopMatches.delete(match.id);

    const lobby = lobbies.get(match.lobbyId);
    if (lobby) {
        Lobby.returnToLobby(lobby, Date.now());
        if (!lobby.members.length) destroyLobby(lobby);
        else broadcastLobby(lobby);
    }
}

function handleCoopDisconnect(conn) {
    const match = coopMatchOf(conn);
    if (!match || match.finished) return;
    const slot = conn.mpSlot;
    const p = match.players[slot];
    if (!p) return;
    p.connected = false;
    p.conn = null;
    // Pay out what they actually earned before removing them, and mark
    // them paid -- so coming back cannot earn the same shards twice.
    payCoopPlayer(match, slot).catch(e => console.log("[coop] payout on disconnect failed:", e.message));
    match.run.disconnect(slot, Date.now());
    coopBroadcast(match, { type: "vb_player_left", slot: slot });
    if (match.run.finished) finishCoopMatch(match, "ended");
}

function handleCoopMessage(conn, data) {
    const match = coopMatchOf(conn);
    if (!match || match.finished) return true;
    const slot = conn.mpSlot;
    const now = Date.now();

    if (data.type === "vb_ready") {
        const p = match.players[slot];
        if (p) p.loaded = true;
        const allLoaded = Object.keys(match.players)
            .every(s => !match.players[s].connected || match.players[s].loaded);
        if (allLoaded) beginCoopRun(match);
        return true;
    }

    if (data.type === "vb_pos") {
        match.run.reportPosition(slot, data.x, data.y, data.a, now);
        return true;
    }

    // "My shot connected on enemy N." Carries no damage number; see
    // voidbreakCoop.js's claimHit for everything that is checked.
    if (data.type === "vb_hit") {
        const result = match.run.claimHit(slot, Math.floor(Number(data.e)), now);
        if (result.ok) {
            // The shooter is told the number so it can draw its own
            // damage/crit popup. Everyone else learns the enemy's new
            // health from the next snapshot, and its death from the
            // kill event -- no per-hit fan-out to the whole party.
            send(conn, { type: "vb_hitok", e: result.enemyId, d: result.dmg, c: result.crit ? 1 : 0 });
        }
        return true;
    }

    if (data.type === "vb_upgrade") {
        const result = match.run.chooseUpgrade(slot, String(data.id || ""));
        if (result.ok) send(conn, { type: "vb_upgraded", id: result.id, maxhp: result.maxhp, hp: result.hp });
        else send(conn, { type: "mp_error", message: result.error });
        return true;
    }

    if (data.type === "vb_leave_match") {
        handleCoopDisconnect(conn);
        handleLobbyLeave(conn, false);
        return true;
    }

    return true;
}

// ---------------------------------------------------------------------
// THE CO-OP TICK
//
// ONE timer for every live run, not one per run -- the same reason the
// shadow detector above uses a single timer. Each step is measured in
// microseconds (see voidbreakCoop.js), and the loop does nothing at all
// while no co-op run exists.
// ---------------------------------------------------------------------
setInterval(() => {
    if (!coopMatches.size) return;
    const now = Date.now();
    for (const match of Array.from(coopMatches.values())) {
        if (!match.started || match.finished) continue;
        const out = match.run.step(now);

        if (out.events && out.events.length) {
            // EVENTS are the authoritative facts (spawned / killed /
            // hurt / wave changed / run over). Reliable, never dropped.
            const raw = JSON.stringify({ type: "vb_ev", e: out.events });
            for (const slot of Object.keys(match.players)) {
                const p = match.players[slot];
                if (p.conn) sendRaw(p.conn, raw);
            }
        }
        if (out.snapshot) {
            // SNAPSHOTS are only worth sending while they are current,
            // so they go out volatile -- a client whose socket is
            // already backed up gets the NEXT one instead of a queue of
            // stale ones (see sendVolatile).
            const raw = JSON.stringify({ type: "vb_s", s: out.snapshot });
            for (const slot of Object.keys(match.players)) {
                const p = match.players[slot];
                if (p.conn) sendVolatile(p.conn, raw);
            }
        }
        if (match.run.finished) finishCoopMatch(match, match.run.victory ? "victory" : "defeat");
    }
}, VoidbreakCoop.TICK_MS).unref();

// ---------------------------------------------------------------------
// LOBBY SWEEP -- rooms nobody came back to must not accumulate.
// ---------------------------------------------------------------------
setInterval(() => {
    const now = Date.now();
    for (const lobby of Array.from(lobbies.values())) {
        if (lobby.state === "live") continue;
        if (Lobby.isStale(lobby, now)) {
            for (const row of connsInLobby(lobby)) send(row.conn, { type: "mp_left", reason: "idle" });
            destroyLobby(lobby);
        }
    }
}, 60000).unref();

// ---------------------------------------------------------------------
// MESSAGE ROUTING -- every mp_*/vb_* message enters here.
// ---------------------------------------------------------------------
function handleMultiplayerMessage(conn, data) {
    const type = data.type;

    // Everything below needs a verified account. conn.authSub is set by
    // presence_hello and ONLY by presence_hello, which requires a
    // session token this server itself issued -- a client cannot simply
    // declare who it is.
    if (!conn.authSub || !accounts[conn.authSub]) {
        mpError(conn, "Sign in to play online");
        return true;
    }

    // This socket is now the account's multiplayer connection.
    mpConnBySub.set(conn.authSub, conn);

    // A returning player picks their match back up if it is still live
    // and their slot has not been forfeited yet.
    if (!conn.mpMatchId) tryArenaReconnect(conn);

    // ---- in-match traffic first: it is by far the most frequent ----
    if (conn.mpMatchId) {
        // Room management is not available while a match is live --
        // teams, readiness and the run's settings are all frozen once
        // it starts. The refusal is explicit rather than a silent drop
        // so a client that asks is told why, and so this rule is
        // stated in one place instead of being an accident of routing.
        if (type === "mp_team" || type === "mp_ready" || type === "mp_settings" ||
            type === "mp_start" || type === "mp_create" || type === "mp_join" ||
            type === "mp_quick") {
            mpError(conn, "The match has already started");
            return true;
        }
        if (conn.mpKind === "pvp") return handleArenaMessage(conn, data);
        if (conn.mpKind === "coop") return handleCoopMessage(conn, data);
    }

    if (type === "mp_types") {
        send(conn, {
            type: "mp_types",
            pvp: Party.listMatchTypes("pvp"),
            coop: Party.listMatchTypes("coop"),
            levels: VoidbreakCoop.LEVELS.map((l, i) => ({ idx: i, id: l.id, name: l.name })),
            totalWaves: VoidbreakCoop.TOTAL_WAVES
        });
        return true;
    }

    if (type === "mp_create") { handleLobbyCreate(conn, data.typeId, data.private); return true; }
    if (type === "mp_join")   { handleLobbyJoin(conn, data.code); return true; }
    if (type === "mp_quick")  { handleLobbyQuick(conn, data.typeId); return true; }
    if (type === "mp_browse") { handleLobbyBrowse(conn); return true; }
    if (type === "mp_leave")  { handleLobbyLeave(conn, false); return true; }

    const lobby = lobbyOf(conn);
    if (!lobby) { mpError(conn, "You are not in a lobby"); return true; }

    if (type === "mp_team") {
        const result = Lobby.setTeam(lobby, conn.authSub, Math.floor(Number(data.team)), Date.now());
        if (!result.ok) { mpError(conn, result.error); return true; }
        broadcastLobby(lobby);
        return true;
    }

    if (type === "mp_ready") {
        const result = Lobby.setReady(lobby, conn.authSub, !!data.ready, Date.now());
        if (!result.ok) { mpError(conn, result.error); return true; }
        broadcastLobby(lobby);
        return true;
    }

    if (type === "mp_settings") {
        const result = Lobby.setSettings(lobby, conn.authSub, data, Date.now(), VoidbreakCoop.LEVELS.length);
        if (!result.ok) { mpError(conn, result.error); return true; }
        broadcastLobby(lobby);
        return true;
    }

    if (type === "mp_start") {
        // startCheck is the ONE definition of "may this start": host,
        // open, enough players, teams balanced, everyone ready.
        const check = Lobby.startCheck(lobby, conn.authSub);
        if (!check.ok) { mpError(conn, check.error); return true; }
        if (lobby.kind === "coop") createCoopMatch(lobby);
        else createArenaMatch(lobby);
        broadcastLobby(lobby);
        return true;
    }

    return true;
}

// Called from the socket's close handler for every connection.
function handleMultiplayerDisconnect(conn) {
    if (!conn.authSub) return;
    if (conn.mpKind === "pvp") handleArenaDisconnect(conn);
    else if (conn.mpKind === "coop") handleCoopDisconnect(conn);
    if (conn.lobbyId) handleLobbyLeave(conn, true);
    if (mpConnBySub.get(conn.authSub) === conn) mpConnBySub.delete(conn.authSub);
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

const NET_SAMPLE_MAX = 4096;

const netStats = {
    startedAt: Date.now(),
    msgsIn: 0, msgsOut: 0,
    bytesIn: 0, bytesOut: 0,
    maxPacketIn: 0, maxPacketOut: 0,
    // Relay handling time (parse + route + forward) in ms, sampled into
    // a fixed ring (see netRecordHandle).
    handleMs: new Float64Array(NET_SAMPLE_MAX),
    handleIdx: 0,
    handleCount: 0,
    // Position frames dropped because a client's socket was already
    // backed up (see sendVolatile). A non-zero number here means
    // somebody's connection could not keep up, which is worth knowing.
    volatileDropped: 0,
    // Sockets reaped by the heartbeat because they stopped answering.
    socketsReaped: 0,
    byType: Object.create(null)
};

// ---------------------------------------------------------------------
// EVENT-LOOP LAG
//
// The one number that explains "the server was fine and then everyone
// lagged at once". A relay has no tick to time, so this is the real
// equivalent: how late a timer that asked for 100ms actually fired. Any
// value well above zero means something blocked the single thread --
// and while it was blocked, every player's packets were sitting in a
// queue. Costs one timer and one subtraction every 100ms, so it runs
// unconditionally rather than behind the debug flag.
// ---------------------------------------------------------------------
const LOOP_LAG_INTERVAL_MS = 100;
const loopLag = {
    samples: new Float64Array(NET_SAMPLE_MAX),
    idx: 0, count: 0, max: 0
};
let loopLagLast = Date.now();
setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - loopLagLast - LOOP_LAG_INTERVAL_MS);
    loopLagLast = now;
    loopLag.samples[loopLag.idx] = lag;
    loopLag.idx = (loopLag.idx + 1) % NET_SAMPLE_MAX;
    if (loopLag.count < NET_SAMPLE_MAX) loopLag.count++;
    if (lag > loopLag.max) loopLag.max = lag;
}, LOOP_LAG_INTERVAL_MS).unref();

function percentiles(ring, count) {
    if (!count) return { p50: 0, p95: 0, p99: 0, max: 0 };
    const s = Array.prototype.slice.call(ring, 0, count).sort((a, b) => a - b);
    const q = p => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(3);
    return { p50: q(.5), p95: q(.95), p99: q(.99), max: +s[s.length - 1].toFixed(3) };
}

function netRecordIn(type, bytes) {
    netStats.msgsIn++;
    netStats.bytesIn += bytes;
    if (bytes > netStats.maxPacketIn) netStats.maxPacketIn = bytes;
    netStats.byType[type] = (netStats.byType[type] || 0) + 1;
}
// A fixed ring, not a growing array with shift(): shift() on a
// 5000-element array is an O(n) memmove, and this used to run on EVERY
// relayed message the moment diagnostics were switched on -- so turning
// on the instrumentation measurably slowed down the thing it was
// measuring.
function netRecordHandle(ms) {
    netStats.handleMs[netStats.handleIdx] = ms;
    netStats.handleIdx = (netStats.handleIdx + 1) % NET_SAMPLE_MAX;
    if (netStats.handleCount < NET_SAMPLE_MAX) netStats.handleCount++;
}
function netSnapshot() {
    const secs = Math.max(1, (Date.now() - netStats.startedAt) / 1000);
    let sockets = 0;
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) sockets++; });
    return {
        uptimeSec: Math.round(secs),
        sockets: sockets,
        casualSlotsUsed: (slots[1] ? 1 : 0) + (slots[2] ? 1 : 0),
        rankedMatches: rankedMatches.size,
        // The new flexible match rooms, so a live instance's load is
        // visible in the same place every other number already is.
        lobbies: lobbies.size,
        arenaMatches: arenaMatches.size,
        coopMatches: coopMatches.size,
        coopRuns: Array.from(coopMatches.values()).map(m => m.run.debugState()),
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
        relayHandleMs: percentiles(netStats.handleMs, netStats.handleCount),
        // The number that explains a server-wide latency spike. See the
        // EVENT-LOOP LAG note above.
        eventLoopLagMs: Object.assign(percentiles(loopLag.samples, loopLag.count), { allTimeMax: +loopLag.max.toFixed(3) }),
        volatileDropped: netStats.volatileDropped,
        socketsReaped: netStats.socketsReaped,
        byType: netStats.byType,
        // Static asset cache: how much of a page load this server is
        // still actually transferring (see static.js).
        staticCache: staticServer.snapshot(),
        // Shadow hit detection: how often this server's own verdict
        // matched what the client reported. See shadow.js.
        shadowHitDetection: shadowSnapshot()
    };
}

// Wraps the relay's message handler so DEBUG_NETWORKING can measure
// per-message handling time and byte counts in ONE place, instead of
// threading a branch through every route inside it. When the flag is
// off this returns the original function unchanged -- literally the
// same reference, so there is no wrapper, no timing call and no
// measurable cost on the hot path.
// The handler publishes the type it just parsed here, so the wrapper
// can count by type without parsing the same JSON a second time. It used
// to do exactly that -- a full JSON.parse per message purely to read one
// field -- which roughly doubled the parse cost of every packet the
// moment diagnostics were switched on.
let lastMessageType = "?";

function instrumentMessage(handler) {
    if (!DEBUG_NETWORKING) return handler;
    return function (raw) {
        const t0 = process.hrtime.bigint();
        const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
        lastMessageType = "?";
        try {
            return handler.apply(this, arguments);
        } finally {
            netRecordIn(lastMessageType, bytes);
            netRecordHandle(Number(process.hrtime.bigint() - t0) / 1e6);
        }
    };
}

function send(player, obj) {
    if (player && player.socket.readyState === WebSocket.OPEN) {
        sendRaw(player, JSON.stringify(obj));
    }
}

// Sends an ALREADY-SERIALISED payload. Anything that goes to more than
// one recipient should stringify once and use this, instead of paying
// for the same JSON.stringify per player -- see broadcastHealth and the
// mode broadcasts below.
function sendRaw(player, payload) {
    if (!player || player.socket.readyState !== WebSocket.OPEN) return;
    if (DEBUG_NETWORKING) {
        netStats.msgsOut++;
        const b = Buffer.byteLength(payload);
        netStats.bytesOut += b;
        if (b > netStats.maxPacketOut) netStats.maxPacketOut = b;
    }
    player.socket.send(payload);
}

// How much unsent data may sit in one client's socket buffer before
// this server stops adding POSITION frames to it. Roughly a second of
// 60Hz position traffic.
const MAX_BUFFERED_BYTES = 64 * 1024;

// For frames whose only value is being CURRENT. If a client's socket is
// already backed up (a stalled mobile connection, a tab the OS
// suspended), queueing yet another position behind the backlog does not
// help it -- it makes things worse: the client eventually receives a
// long tail of positions that were true seconds ago and plays them
// back, which is exactly what "rubber-banding" and "the opponent
// teleporting" look like. Dropping the frame instead means that when
// the connection recovers, the next thing it receives is the CURRENT
// position.
//
// Only ever used for position/decoy relays. Every gameplay event
// (bullets, hits, health, round and match results, ranked, currency)
// goes through send() and is never dropped.
function sendVolatile(player, payload) {
    if (!player || player.socket.readyState !== WebSocket.OPEN) return;
    if (player.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        netStats.volatileDropped++;
        return;
    }
    sendRaw(player, payload);
}

// Builds the relayed position frame as a string directly. This is the
// single hottest line on the server -- it runs once per player per
// network tick -- and it was allocating a throwaway object and running
// the generic serialiser over it every time.
//
// `id` is stamped from the CONNECTION's own slot, never from anything
// the client sent, exactly as before. Every number is validated finite
// first: a client that sends NaN/Infinity would otherwise produce a
// payload the opponent's JSON.parse rejects, which would look like the
// opponent freezing.
function finiteNum(v) {
    return typeof v === "number" && isFinite(v) ? v : 0;
}

function positionFrame(id, data) {
    let s = '{"type":"position","id":' + id +
            ',"x":' + finiteNum(data.x) +
            ',"y":' + finiteNum(data.y) +
            ',"facing":' + finiteNum(data.facing);
    // Omitted rather than defaulted when absent: the client treats a
    // missing seq as "no sequence info" and a present one as a
    // monotonic counter, so inventing a 0 here would make it discard
    // every subsequent frame as stale.
    if (typeof data.seq === "number" && isFinite(data.seq)) s += ',"seq":' + (data.seq | 0);
    return s + "}";
}

// ---------------------------------------------------------------------
// SOCKET HEARTBEAT
//
// A TCP connection that dies without a FIN (a phone going through a
// tunnel, a laptop lid closing, a proxy dropping an idle link) leaves a
// socket that still reads as OPEN. Before this, nothing ever noticed:
//   * the casual slot that connection held was never released, so the
//     next player to arrive got "SERVER FULL" against a ghost,
//   * every relayed frame kept being queued into a socket nobody was
//     reading, growing bufferedAmount without bound,
//   * the presence row and friends list kept showing the player online.
//
// A protocol-level ping every 30s costs 2 bytes per socket and closes
// all three. Note this is the WEBSOCKET ping frame, which the browser
// answers automatically -- it is not the app-level {type:"ping"} the
// client sends to measure RTT, and it works even on the presence
// connection, which sends nothing at all on its own.
// ---------------------------------------------------------------------
const HEARTBEAT_INTERVAL_MS = 30000;

setInterval(() => {
    wss.clients.forEach(socket => {
        if (socket.isAlive === false) {
            netStats.socketsReaped++;
            // terminate(), not close(): a socket that missed a ping is
            // not going to complete a closing handshake either. The
            // 'close' event still fires, so all the existing cleanup
            // (casual slot, ranked forfeit, presence) runs normally.
            socket.terminate();
            return;
        }
        socket.isAlive = false;
        try { socket.ping(); } catch (e) { /* already gone */ }
    });
}, HEARTBEAT_INTERVAL_MS).unref();

wss.on("connection", (socket, request) => {

    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });

    // Node's http.Server already sets this on the sockets it hands over,
    // so this is belt-and-braces rather than a fix -- but it is the
    // difference between a 5ms relay and a 45ms one if that default ever
    // changes, because Nagle would hold a 60-byte position frame back
    // waiting for more data that never comes.
    try { socket._socket.setNoDelay(true); } catch (e) {}

    // A presence connection asks for it explicitly with ?presence=1 and
    // is NEVER given a casual slot. That is the whole point: idle lobby
    // players need to be visible to their friends without occupying one
    // of the two casual duel slots (see the FRIENDS section above).
    let isPresenceOnly = false;
    // A LOBBY/MATCH-ROOM connection (?mp=1) is the same idea: it plays
    // online, but through a match room of its own (see ONLINE LOBBIES
    // AND MATCH ROOMS), so it must never consume one of the two legacy
    // casual slots -- four players opening the new online hub would
    // otherwise lock every casual duel on the server out.
    let isMatchRoomOnly = false;
    try {
        const url = (request && request.url) ? request.url : "";
        isPresenceOnly = /[?&]presence=1(&|$)/.test(url);
        isMatchRoomOnly = /[?&]mp=1(&|$)/.test(url);
    } catch (e) { isPresenceOnly = false; isMatchRoomOnly = false; }

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
        presenceOnly: isPresenceOnly,
        // lobby / flexible-match-room state (see ONLINE LOBBIES AND
        // MATCH ROOMS). All null on a connection that never opens the
        // online hub, which is every existing client.
        matchRoomOnly: isMatchRoomOnly,
        lobbyId: null,
        mpMatchId: null,
        mpSlot: null,
        mpKind: null
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
    if (!isPresenceOnly && !isMatchRoomOnly) {
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
    } else if (!isPresenceOnly && !isMatchRoomOnly) {
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
        // Publishes the type for the diagnostics wrapper above. One
        // assignment; no branch, no allocation, and nothing at all when
        // DEBUG_NETWORKING is off (the wrapper does not exist then).
        if (DEBUG_NETWORKING) lastMessageType = (data && typeof data.type === "string") ? data.type : "?";

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

                // Lobby chat scrollback. Presence connections only --
                // the gameplay socket sends this same hello, and does
                // not want a copy (see the routing comment above).
                if (conn.presenceOnly) {
                    send(conn, chatHistoryPayload());
                    if (cameOnline) announceLobbyJoin(sub);
                }

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
                    // Coming back from a match means rejoining the chat
                    // room, and whatever was said while away is what
                    // the panel should be showing.
                    if (conn.presenceOnly && isInLobby(conn.authSub)) send(conn, chatHistoryPayload());
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

        // =============================================================
        // LOBBY CHAT
        //
        // Reached only on a connection that has already proved which
        // account it is (conn.authSub, set by presence_hello). The
        // message carries ONE field -- the text. Everything else about
        // it (who sent it, what it is called, whether that account is
        // an admin, when it happened, its id) is stamped server-side,
        // because there is no field on the wire for a client to claim
        // any of it.
        // =============================================================
        if (typeof data.type === "string" && data.type.indexOf("chat_") === 0) {
            if (!conn.authSub || !accounts[conn.authSub]) {
                send(conn, { type: "chat_error", message: "Sign in to use lobby chat." });
                return;
            }

            if (data.type === "chat_history_request") {
                send(conn, chatHistoryPayload());
                return;
            }

            if (data.type === "chat_send") {
                // Chat is delivered over presence connections only, so
                // a message sent on any other socket could not even be
                // echoed back to its own sender. The client never does
                // this; refusing it keeps the rule in one place.
                if (!conn.presenceOnly) {
                    send(conn, { type: "chat_error", message: "Lobby chat is not available on this connection." });
                    return;
                }
                if (!isInLobby(conn.authSub)) {
                    // Not an error the player can hit normally -- the
                    // panel is only reachable from the lobby -- so it
                    // just says what the rule is.
                    send(conn, { type: "chat_error", message: "Lobby chat is only available in the lobby." });
                    return;
                }
                const account = accounts[conn.authSub];
                const result = lobbyChat.submit({
                    accountId: conn.authSub,
                    name: account.name,
                    // Decided here, from the account's email, exactly
                    // like every other admin check on this server.
                    isAdmin: !!(account.email && ADMIN_EMAIL &&
                                account.email.toLowerCase() === ADMIN_EMAIL.toLowerCase())
                }, data.text);

                if (!result.ok) {
                    send(conn, { type: "chat_error", message: result.error });
                    return;
                }
                broadcastChat({ type: "chat_message", message: result.message });
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
        // ONLINE LOBBIES / FLEXIBLE MATCH ROOMS / VOIDBREAK CO-OP
        //
        // Routed before ranked and before the casual relay: a
        // connection inside a match room talks only to its room, and
        // must never reach the global casual slots.
        // =============================================================
        if (typeof data.type === "string" &&
            (data.type.indexOf("mp_") === 0 || data.type.indexOf("vb_") === 0)) {
            handleMultiplayerMessage(conn, data);
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

            if (data.type === "position") {
                if (typeof data.seq === "number") conn.lastSeq = data.seq;
                if (match.shadow) match.shadow.onPosition(conn.rankedSlot, data.x, data.y, data.d === 1, Date.now());
                sendVolatile(foe.conn, positionFrame(conn.rankedSlot, data));
                return;
            }

            if (match.shadow) {
                const now = Date.now();
                if (data.type === "bullet") match.shadow.onBullet(conn.rankedSlot, data, now);
                else if (data.type === "decoy") match.shadow.onDecoy(conn.rankedSlot, data.x, data.y, data.life, now);
                else if (data.type === "hitClaim" || data.type === "damage") match.shadow.onClaim(conn.rankedSlot, now);
            }

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
                        if (match.shadow) match.shadow.reset();
                        registerRankedElimination(match, conn.rankedSlot);
                    }
                }
                return;
            }

            // Ability activation for the 5 newer abilities (Gravity Trap,
            // Phase Shift, Hunter's Mark, Portal, Overcharge) -- the only
            // place their cooldown and consumable state actually lives.
            // The client already applied its own optimistic local effect
            // before sending this (same prediction pattern as every
            // other ability); this only decides whether the SERVER's own
            // copy of that state (phaseUntil/overchargeShotsRemaining/
            // huntersMarkReady, consulted by claimHit/trackBullet above)
            // gets to update. No response is sent either way -- same
            // fire-and-forget shape as timewarp/decoy.
            if (data.type === "abilityActivate") {
                match.combat.activateAbility(conn.rankedSlot, data.ability, Date.now());
                return;
            }

            // Everything else is a straight relay to the room opponent.
            send(foe.conn, data);
            return;
        }

        // A match-room connection measures its RTT the same way a
        // casual one does. Answered straight back to the sender; it
        // needs no opponent and no casual slot.
        if (data.type === "ping" && (conn.matchRoomOnly || conn.mpMatchId)) {
            send(conn, { type: "pong", t: data.t, ack: conn.lastSeq || 0 });
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
            // `d` is the dash flag (see index.html's send loop). A dashing
            // player is immune to bullets on the client, so shadow
            // detection has to know about it or every shot that passed
            // through a dash would look like a suppressed hit.
            if (casualShadow) casualShadow.onPosition(id, data.x, data.y, data.d === 1, Date.now());

            // Volatile: a position frame is only worth sending while it
            // is still current (see sendVolatile).
            sendVolatile(opponent, positionFrame(id, data));
        }

        else if (data.type === "bullet") {

            // Every projectile is registered as a damage source so a hit
            // claim can be checked against something that was really
            // fired (see combat.js). The damage VALUE is taken from the
            // server's own config there, never from this message.
            casualCombat.trackBullet(id, data, Date.now());
            if (casualShadow) casualShadow.onBullet(id, data, Date.now());

            send(opponent, {
                type: "bullet",
                x: data.x,
                y: data.y,
                vx: data.vx,
                vy: data.vy,
                color: data.color,
                range: data.range,
                bounces: data.bounces,
                damage: data.damage,
                hitRadius: data.hitRadius,
                overcharged: data.overcharged,
                homing: data.homing
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

            if (casualShadow) casualShadow.onClaim(id, Date.now());
            const result = casualCombat.claimHit(id, Date.now());
            if (result.accepted) {
                broadcastHealth(player, opponent, result);
                // The round is over the moment the server says someone
                // died, so the next round starts from full health. Any
                // shot still tracked from the old round is dropped with
                // it, so it cannot land after the reset.
                if (result.eliminated) {
                    casualCombat.resetRound();
                    if (casualShadow) casualShadow.reset();
                }
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

            if (casualShadow) casualShadow.onDecoy(id, data.x, data.y, data.life, Date.now());

            sendVolatile(opponent, JSON.stringify({
                type: "decoy",
                x: data.x,
                y: data.y,
                facing: data.facing,
                life: data.life
            }));
        }

        // Ability activation for the 5 newer abilities. The client
        // already applied its own optimistic local effect before this
        // arrives (same prediction pattern as every other ability); this
        // is only what lets the server's own copy of the resulting state
        // (phaseUntil / overchargeShotsRemaining / huntersMarkReady,
        // consulted by claimHit/trackBullet above) update, subject to
        // this ability's own server-side cooldown. No response either
        // way, same fire-and-forget shape as timewarp/decoy.
        else if (data.type === "abilityActivate") {

            casualCombat.activateAbility(id, data.ability, Date.now());
        }

        // Gravity Trap / Portal: static field/anchor markers, relayed
        // once at creation exactly like Decoy's spawn message -- neither
        // ever moves again, so unlike Decoy there is no continuous
        // re-broadcast to relay here. Deals no damage and moves nobody
        // by itself; the receiving client applies the pull/slow (Gravity
        // Trap) or performs the actual teleport (Portal, on a LATER
        // 'portalClear' from its own owner) to its own real position.
        else if (data.type === "gravitytrap") {

            send(opponent, { type: "gravitytrap", x: data.x, y: data.y, life: data.life });
        }
        else if (data.type === "portal") {

            send(opponent, { type: "portal", x: data.x, y: data.y, life: data.life });
        }
        else if (data.type === "portalClear") {

            send(opponent, { type: "portalClear" });
        }

        // Phase Shift: relayed purely so the opponent's client can render
        // the translucent effect on their view of us -- the real
        // invulnerability is enforced server-side (see claimHit/
        // activateAbility above), not by anything in this message.
        else if (data.type === "phaseshift") {

            send(opponent, { type: "phaseshift", duration: data.duration });
        }

        // ---- HEIST MODE: match start / rematch -- both bases reset to
        // 20/20. This one needs real server logic (unlike the generic
        // relay below), so it gets its own branch ahead of it.
        else if (data.type === "heistReset") {

            if (casualShadow) { casualShadow.setArena("heist"); casualShadow.reset(); }
            resetCasualCombat();
            resetHeistState();
            const payload = JSON.stringify({ type: "heistUpdate", hp: heistHP, destroyed: false, winner: null });
            sendRaw(player, payload);
            sendRaw(opponent, payload);
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
                    const payload = JSON.stringify({ type: "heistUpdate", hp: heistHP, destroyed: heistDestroyed, winner: winner });
                    sendRaw(player, payload);
                    sendRaw(opponent, payload);
                    // Server-authoritative XP: this IS the server's own
                    // confirmation of the win (HP just hit 0 in server
                    // state), so no client report is needed or accepted.
                    if (winner) awardXPAndNotify(slots[winner], XP_REWARDS.heist_win, "heist_win", COIN_REWARDS.heist_win);
                }
            }
        }

        // ---- BOMB RUN MODE: match start / rematch -- carrier cleared,
        // score reset to 0/0. Mirrors heistReset above exactly.
        else if (data.type === "bombReset") {

            if (casualShadow) { casualShadow.setArena("bombrun"); casualShadow.reset(); }
            resetCasualCombat();
            resetBombState();
            const payload = JSON.stringify({ type: "bombUpdate", carrier: null, x: null, y: null });
            sendRaw(player, payload);
            sendRaw(opponent, payload);
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
                const payload = JSON.stringify({ type: "bombUpdate", carrier: bombCarrier, x: data.x, y: data.y });
                sendRaw(player, payload);
                sendRaw(opponent, payload);
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
                const payload = JSON.stringify({ type: "bombUpdate", carrier: null, x: data.x, y: data.y });
                sendRaw(player, payload);
                sendRaw(opponent, payload);
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
                const payload = JSON.stringify({ type: "bombGoalUpdate", scorer: id, score1: bombScore[1], score2: bombScore[2], matchOver: bombMatchOver, winner: winner });
                sendRaw(player, payload);
                sendRaw(opponent, payload);
                // Server-authoritative XP -- bombMatchOver just flipped
                // true in the server's own state, so this can't be forged
                // or double-claimed via a client report.
                if (winner) awardXPAndNotify(slots[winner], XP_REWARDS.bombrun_win, "bombrun_win", COIN_REWARDS.bombrun_win);
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

            // Football has no reset message of its own, so its first
            // relayed message is what identifies the arena.
            if (casualShadow && data.type.indexOf("football") === 0) casualShadow.setArena("football");

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
            if (wentOffline) {
                broadcastToFriends(sub, presenceEventFor(sub));
                // Drop the account's chat rate-limit entry too, so the
                // table tracks only who is actually connected.
                lobbyChat.forget(sub);
            }
        }

        // Ranked cleanup: drops any queue entry and turns an
        // in-progress ranked match into a forfeit/abandon as appropriate
        // (see handleRankedDisconnect). This is what guarantees a closed
        // browser can never leave a ghost in the queue.
        handleRankedDisconnect(conn);

        // Lobby / match-room cleanup: forfeits the slot in a live match
        // after a grace period, pays out a co-op run's earned shards
        // exactly once, and removes the player from any room they were
        // still sitting in -- so neither a match nor a lobby can be
        // left orphaned in memory by a closed browser.
        handleMultiplayerDisconnect(conn);

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
        // Currency rename/migration runs BEFORE anything else touches
        // an account -- the leaderboard, admin panel and every sign-in
        // below this point must see `coins`/`crystals`, never a
        // still-unmigrated `credits`.
        migrateAllAccountsCurrency();
        migrateAllAccountsPlaytime();
        // Rebuilt from what is actually stored, so the login lookup can
        // never drift from the accounts it points at.
        buildUsernameIndex();
        abilityConfig = await loadAbilityConfig();
        adminLog = await loadAdminLog();
        newsItems = await loadNewsItems();

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

        // Battle Pass: the live season is admin-editable at runtime (see
        // /admin/battlepass) and so must survive a restart rather than
        // snapping back to battlepass.js's code default.
        const storedBPSeason = await store.loadDoc("battlePassSeason", null);
        if (storedBPSeason && typeof storedBPSeason.id === "string" && storedBPSeason.id) {
            BATTLE_PASS_SEASON = storedBPSeason;
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

    // Pre-read and pre-compress what every player pulls on their first
    // load, so the first visitor after a deploy doesn't pay for the
    // Brotli pass (and nobody already in a match pays for it either).
    // Deliberately not awaited: the port opens immediately and the warm
    // runs behind it.
    staticServer.warm(["index.html", "voidbreak.html", "bgm.mp3"])
        .then(() => {
            const s = staticServer.snapshot();
            const html = s.files.find(f => f.file === "index.html");
            console.log("[static] warmed " + s.files.length + " file(s), " +
                Math.round(s.cachedBytes / 1024) + " KB cached" +
                (html && html.br ? "; index.html " + Math.round(html.bytes / 1024) + " KB -> " +
                    Math.round(html.br / 1024) + " KB brotli" : ""));
        })
        .catch(e => console.log("[static] warm failed:", e.message));

    httpServer.listen(PORT, "0.0.0.0", () => {
        console.log("VOIDBREAK SERVER STARTED on port " + PORT);
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
