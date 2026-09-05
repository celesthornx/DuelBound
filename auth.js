// =====================================================================
// USERNAME + PASSWORD AUTHENTICATION
//
// The second way into a DuelBound account, alongside Google sign-in.
// Both end up at the SAME account record and the same internal account
// id -- this module owns only the credential half: hashing, verifying,
// validating a login username, and throttling guesses.
//
// Pure module: no sockets, no storage, no HTTP. server.js owns the
// account records and the sessions.
//
// Why scrypt and not Argon2id
// ---------------------------
// Argon2id is the better algorithm, but every Node binding for it is a
// native module, which means a compiler in the deploy image and a build
// step that can fail on a host we don't control. scrypt is memory-hard,
// is what `crypto` already ships, and needs no build step at all -- the
// right trade for this deployment. The stored format carries its own
// parameters, so moving to Argon2id later is a matter of adding a
// second verifier and re-hashing on next successful login; nothing
// stored here has to be thrown away.
//
// The ASYNC crypto.scrypt is used deliberately. scryptSync would block
// the single Node event loop for the whole ~100ms of a hash, which
// would stall every in-flight gameplay packet on the server for every
// login attempt -- exactly the class of bug the networking pass removed.
// =====================================================================

const crypto = require("crypto");

// scrypt cost. N is the memory/CPU factor: 2^15 is ~32MB per hash, slow
// enough that offline cracking of a stolen hash is expensive, fast
// enough that a real login is not noticeable. maxmem has to be raised
// explicitly or Node refuses at this N.
const SCRYPT = {
    N: 32768,
    r: 8,
    p: 1,
    keylen: 64,
    maxmem: 96 * 1024 * 1024
};

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200; // a bound, so a huge body can't be used to burn CPU

const USERNAME_MIN = 3;
const USERNAME_MAX = 16;

// Names that must never be claimable, because they read as the game or
// its staff in chat, on the leaderboard, or in a friend request. Note
// that admin rights do NOT come from a username (see isAdminSession in
// server.js) -- registering "admin" would grant nothing even if it were
// allowed. This list exists to stop impersonation, not privilege
// escalation.
const RESERVED_LOGIN_USERNAMES = new Set([
    "admin", "administrator", "administrador", "moderator", "mod", "mods",
    "system", "server", "root", "owner", "official", "support", "staff",
    "help", "helpdesk", "security", "duelarena", "duelbound", "gm",
    "gamemaster", "bot", "computer", "null", "undefined", "anonymous",
    "guest", "player", "me", "you"
]);

// ---------------------------------------------------------------------
// Login username rules.
//
// Deliberately stricter than the in-game DISPLAY name (see
// validateUsername in server.js, which allows spaces and accents): a
// login identifier is typed by hand, compared case-insensitively, and
// has to be unambiguous, so it is limited to ASCII letters, digits and
// underscores. The two are different fields on purpose -- see the
// accountId / username / displayName split in server.js.
// ---------------------------------------------------------------------
function validateLoginUsername(raw) {
    if (typeof raw !== "string") return { ok: false, error: "Username must be text" };
    const username = raw.trim();
    if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
        return { ok: false, error: "Username must be " + USERNAME_MIN + "–" + USERNAME_MAX + " characters." };
    }
    if (!/^[A-Za-z0-9_]+$/.test(username)) {
        return { ok: false, error: "Username can only use letters, numbers and underscores." };
    }
    if (RESERVED_LOGIN_USERNAMES.has(username.toLowerCase())) {
        return { ok: false, error: "That username is reserved." };
    }
    return { ok: true, username: username, key: username.toLowerCase() };
}

function validatePassword(raw) {
    if (typeof raw !== "string") return { ok: false, error: "Password must be text" };
    if (raw.length < PASSWORD_MIN) {
        return { ok: false, error: "Password must be at least " + PASSWORD_MIN + " characters." };
    }
    if (raw.length > PASSWORD_MAX) {
        return { ok: false, error: "Password must be " + PASSWORD_MAX + " characters or fewer." };
    }
    return { ok: true };
}

// ---------------------------------------------------------------------
// Hashing. Stored as a single self-describing string:
//
//   scrypt$N$r$p$<salt base64>$<hash base64>
//
// Carrying the parameters means today's hashes stay verifiable if the
// cost is raised later, and that a future move to another algorithm can
// be told apart by its prefix.
// ---------------------------------------------------------------------
function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16);
        crypto.scrypt(password, salt, SCRYPT.keylen, {
            N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem
        }, (err, derived) => {
            if (err) return reject(err);
            resolve([
                "scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p,
                salt.toString("base64"), derived.toString("base64")
            ].join("$"));
        });
    });
}

// Always compares in constant time, and never throws on a malformed or
// missing stored hash -- it just fails to verify.
function verifyPassword(password, stored) {
    return new Promise(resolve => {
        if (typeof password !== "string" || typeof stored !== "string") return resolve(false);
        const parts = stored.split("$");
        if (parts.length !== 6 || parts[0] !== "scrypt") return resolve(false);
        const N = parseInt(parts[1], 10), r = parseInt(parts[2], 10), p = parseInt(parts[3], 10);
        if (!N || !r || !p) return resolve(false);

        let salt, expected;
        try {
            salt = Buffer.from(parts[4], "base64");
            expected = Buffer.from(parts[5], "base64");
        } catch (e) { return resolve(false); }
        if (!salt.length || !expected.length) return resolve(false);

        crypto.scrypt(password, salt, expected.length, {
            N: N, r: r, p: p, maxmem: SCRYPT.maxmem
        }, (err, derived) => {
            if (err) return resolve(false);
            try {
                resolve(crypto.timingSafeEqual(derived, expected));
            } catch (e) {
                resolve(false); // length mismatch
            }
        });
    });
}

// ---------------------------------------------------------------------
// Failed-login throttling.
//
// Counted against BOTH the source IP and the attempted username, so
// neither spraying many usernames from one address nor hammering one
// account from many addresses gets a free pass. Lockouts are short and
// self-clearing: a player who mistypes a few times is never locked out
// for long, and never permanently.
// ---------------------------------------------------------------------
const THROTTLE = {
    maxFailures: 8,           // per window, per key
    windowMs: 15 * 60 * 1000, // failures older than this stop counting
    lockoutMs: 5 * 60 * 1000, // how long a tripped key stays blocked
    sweepEveryMs: 5 * 60 * 1000
};

function createLoginThrottle(config) {
    const cfg = Object.assign({}, THROTTLE, config || {});
    const entries = new Map(); // key -> { failures: [timestamps], blockedUntil }
    let lastSweep = 0;

    function sweep(now) {
        if (now - lastSweep < cfg.sweepEveryMs) return;
        lastSweep = now;
        for (const [key, e] of entries) {
            const live = e.failures.some(t => now - t < cfg.windowMs);
            if (!live && (!e.blockedUntil || e.blockedUntil < now)) entries.delete(key);
        }
    }

    function get(key) {
        let e = entries.get(key);
        if (!e) { e = { failures: [], blockedUntil: 0 }; entries.set(key, e); }
        return e;
    }

    return {
        // Returns { blocked, retryAfterSec } for the worst of the keys.
        check(keys, now) {
            now = now || Date.now();
            sweep(now);
            let worst = 0;
            for (const key of keys) {
                const e = entries.get(key);
                if (e && e.blockedUntil > now) worst = Math.max(worst, e.blockedUntil - now);
            }
            return worst > 0
                ? { blocked: true, retryAfterSec: Math.ceil(worst / 1000) }
                : { blocked: false, retryAfterSec: 0 };
        },

        recordFailure(keys, now) {
            now = now || Date.now();
            for (const key of keys) {
                const e = get(key);
                e.failures = e.failures.filter(t => now - t < cfg.windowMs);
                e.failures.push(now);
                if (e.failures.length >= cfg.maxFailures) {
                    e.blockedUntil = now + cfg.lockoutMs;
                    e.failures = [];
                }
            }
        },

        // A success clears that identity's counters, so one good login
        // undoes a run of typos.
        recordSuccess(keys) {
            for (const key of keys) entries.delete(key);
        },

        size() { return entries.size; }
    };
}

// ---------------------------------------------------------------------
// ACCOUNT RECOVERY CODES
//
// Why a code and not a "forgot password" email
// --------------------------------------------
// A password account here has no email, and nothing about it is
// verified. Any recovery flow built on something a stranger can also
// see or guess -- a username, a display name, a security question --
// is not a way back in for the owner, it is a way in for everyone else.
// So recovery is a bearer secret instead: a code generated once, shown
// to the player once, and stored only as a hash, exactly like the
// password. Whoever holds it can reset the password; nobody else can,
// including us.
//
// The alphabet drops characters that get misread when copied off a
// screen by hand (0/O, 1/I/L, 5/S, 8/B), because these are typed back
// in by a person who is already locked out.
// ---------------------------------------------------------------------
const RECOVERY_ALPHABET = "ACDEFHJKMNPQRTUVWXY2346789";
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_LEN = 5;

function generateRecoveryCode() {
    const groups = [];
    for (let g = 0; g < RECOVERY_GROUPS; g++) {
        let out = "";
        // rejection-free: 27 symbols from a byte, taken modulo, is a
        // negligible bias for this purpose but randomInt avoids it
        // entirely and is just as cheap here.
        for (let i = 0; i < RECOVERY_GROUP_LEN; i++) {
            out += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
        }
        groups.push(out);
    }
    return groups.join("-");
}

// Accepts what a locked-out player actually types: any case, with or
// without the dashes, with stray spaces.
function normalizeRecoveryCode(raw) {
    if (typeof raw !== "string") return "";
    return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isPlausibleRecoveryCode(raw) {
    return normalizeRecoveryCode(raw).length === RECOVERY_GROUPS * RECOVERY_GROUP_LEN;
}

// Hashed with the same scrypt as a password -- it IS a password, so it
// gets the same treatment and never touches disk in the clear.
function hashRecoveryCode(code) {
    return hashPassword(normalizeRecoveryCode(code));
}
function verifyRecoveryCode(code, stored) {
    return verifyPassword(normalizeRecoveryCode(code), stored);
}

module.exports = {
    generateRecoveryCode,
    normalizeRecoveryCode,
    isPlausibleRecoveryCode,
    hashRecoveryCode,
    verifyRecoveryCode,
    validateLoginUsername,
    validatePassword,
    hashPassword,
    verifyPassword,
    createLoginThrottle,
    RESERVED_LOGIN_USERNAMES,
    _params: { SCRYPT, PASSWORD_MIN, PASSWORD_MAX, USERNAME_MIN, USERNAME_MAX, THROTTLE }
};
