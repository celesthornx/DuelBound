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
        matchSize: 2
    };
}

// Resolves a sessionToken to that player's account record, or null.
function getAccountForSession(sessionToken) {
    const sub = sessions[sessionToken];
    if (!sub) return null;
    return accounts[sub] || null;
}

// The ONLY place that decides "is this request from the admin". Always
// re-derives the answer from the server's own session map and stored
// account email -- never from anything the client claims about itself.
function isAdminSession(sessionToken) {
    const account = getAccountForSession(sessionToken);
    return !!(account && account.email &&
        account.email.toLowerCase() === ADMIN_EMAIL.toLowerCase());
}

// sessionToken -> google "sub". In-memory only -- if the server restarts,
// signed-in players just click "Sign in with Google" again; their saved
// progress on disk is untouched.
const sessions = {};

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

            if (!accounts[sub]) {
                accounts[sub] = defaultAccount(info.name || info.email || "Player", info.email || "");
                await persistAccount(sub);
            } else if (accounts[sub].email !== (info.email || "")) {
                // Keep the stored email current -- this is what admin
                // verification checks against, so it must stay accurate.
                accounts[sub].email = info.email || "";
                await persistAccount(sub);
            }

            const sessionToken = crypto.randomBytes(24).toString("hex");
            sessions[sessionToken] = sub;

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
                matchSize: [2, 3, 4].includes(body.matchSize) ? body.matchSize : (existing.matchSize || 2)
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

function otherId(id) {
    return id === 1 ? 2 : 1;
}

function send(player, obj) {
    if (player && player.socket.readyState === WebSocket.OPEN) {
        player.socket.send(JSON.stringify(obj));
    }
}

wss.on("connection", socket => {

    let id = null;
    if (!slots[1]) id = 1;
    else if (!slots[2]) id = 2;

    if (id === null) {
        socket.send(JSON.stringify({ type: "serverFull" }));
        socket.close();
        return;
    }

    const player = {
        id: id,
        socket: socket,
        x: id === 1 ? 130 : 770,
        y: 270,
        facing: id === 1 ? 0 : Math.PI,
        lastSeq: 0
    };

    slots[id] = player;
    console.log("Player " + id + " connected");

    send(player, {
        type: "welcome",
        id: id,
        x: player.x,
        y: player.y,
        facing: player.facing
    });

    const opponent = slots[otherId(id)];
    if (opponent) {
        send(player, { type: "opponentJoined" });
        send(opponent, { type: "opponentJoined" });
    }

    socket.on("message", raw => {

        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch (error) {
            console.log("Invalid message from player " + id);
            return;
        }

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

        // The player who actually got hit reports every real hit here --
        // chip damage or a round-ending elimination -- so the opponent's
        // health bar and hit sound both stay in sync with what truly
        // happened, not just what looked like it happened on their screen.
        else if (data.type === "damage") {

            send(opponent, {
                type: "damage",
                health: data.health,
                shieldCharges: data.shieldCharges,
                eliminated: data.eliminated
            });
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
                }
            }
        }

        // ---- FOOTBALL MODE / HEIST MODE (generic relay) ----
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
        else if (typeof data.type === "string" && (data.type.indexOf("football") === 0 || data.type.indexOf("heist") === 0)) {

            send(opponent, data);
        }

        else if (data.type === "rematch") {

            send(opponent, { type: "rematch" });
        }

    });

    socket.on("close", () => {

        console.log("Player " + id + " disconnected");

        slots[id] = null;
        resetHeistState(); // leaving a Heist match cleans up its state for the next match

        const opponent = slots[otherId(id)];
        send(opponent, { type: "opponentLeft" });
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
    } catch (e) {
        console.error("FATAL: could not open the account store:", e.message);
        console.error("Refusing to start -- serving with an empty account store " +
            "would overwrite real player progress on the next save.");
        process.exit(1);
    }

    console.log("[storage] backend: " + store.backendName +
        " -- " + Object.keys(accounts).length + " account(s) loaded");
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

startServer();
