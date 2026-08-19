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
// ACCOUNT STORAGE -- a single JSON file on disk, keyed by the player's
// Google account id ("sub"). No database needed for this scale of game.
// =====================================================================
const DB_FILE = path.join(__dirname, "accounts.json");

function loadAccounts() {
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    } catch (e) {
        return {};
    }
}

function saveAccountsToDisk() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(accounts, null, 2));
    } catch (e) {
        console.log("Could not write accounts.json:", e.message);
    }
}

const accounts = loadAccounts(); // sub -> account record

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
        autoAimP2: false
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

const ABILITY_CONFIG_FILE = path.join(__dirname, "abilityConfig.json");

function loadAbilityConfig() {
    let stored = {};
    try {
        stored = JSON.parse(fs.readFileSync(ABILITY_CONFIG_FILE, "utf8"));
    } catch (e) {
        stored = {};
    }
    // Merge onto defaults field-by-field so a missing file, a missing
    // ability, or a newly-added field never produces an undefined value.
    const merged = {};
    for (const abilityId of Object.keys(ABILITY_DEFAULTS)) {
        merged[abilityId] = Object.assign({}, ABILITY_DEFAULTS[abilityId], stored[abilityId] || {});
    }
    return merged;
}

function saveAbilityConfigToDisk() {
    try {
        fs.writeFileSync(ABILITY_CONFIG_FILE, JSON.stringify(abilityConfig, null, 2));
    } catch (e) {
        console.log("Could not write abilityConfig.json:", e.message);
    }
}

let abilityConfig = loadAbilityConfig();

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
const ADMIN_LOG_FILE = path.join(__dirname, "adminLog.json");

function loadAdminLog() {
    try {
        return JSON.parse(fs.readFileSync(ADMIN_LOG_FILE, "utf8"));
    } catch (e) {
        return [];
    }
}

function saveAdminLogToDisk() {
    try {
        fs.writeFileSync(ADMIN_LOG_FILE, JSON.stringify(adminLog, null, 2));
    } catch (e) {
        console.log("Could not write adminLog.json:", e.message);
    }
}

let adminLog = loadAdminLog();

function logAdminAction(account, abilityId, changes, actionType) {
    if ((!changes || !changes.length) && actionType !== "resetAll") return; // no-op, nothing to log
    adminLog.unshift({
        time: Date.now(),
        admin: account ? account.name : "unknown",
        abilityId: abilityId,
        type: actionType || "save",
        changes: changes || []
    });
    if (adminLog.length > 100) adminLog.length = 100;
    saveAdminLogToDisk();
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
                saveAccountsToDisk();
            } else if (accounts[sub].email !== (info.email || "")) {
                // Keep the stored email current -- this is what admin
                // verification checks against, so it must stay accurate.
                accounts[sub].email = info.email || "";
                saveAccountsToDisk();
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
            const existing = accounts[sub] || defaultAccount("Player");
            accounts[sub] = {
                name: existing.name,
                email: existing.email || "",
                credits: typeof body.credits === "number" ? body.credits : existing.credits,
                kills: typeof body.kills === "number" ? body.kills : existing.kills,
                wins: typeof body.wins === "number" ? body.wins : existing.wins,
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
                autoAimP2: typeof body.autoAimP2 === "boolean" ? body.autoAimP2 : (existing.autoAimP2 || false)
            };
            saveAccountsToDisk();
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

                saveAbilityConfigToDisk();
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

                saveAbilityConfigToDisk();
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
                saveAbilityConfigToDisk();
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

console.log("DUEL ARENA SERVER STARTED on port " + PORT);
console.log("Open http://localhost:" + PORT + " on this computer,");
console.log("or http://<this computer's LAN IP>:" + PORT + " on the other player's computer.");

// =====================================================================
// WEBSOCKET RELAY -- movement/bullets/damage/skin/rematch for online
// matches, attached to the same HTTP server/port.
// =====================================================================
const wss = new WebSocket.Server({ server: httpServer });

const slots = { 1: null, 2: null };

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
        facing: id === 1 ? 0 : Math.PI
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

        const opponent = slots[otherId(id)];
        if (!opponent) return;

        if (data.type === "position") {

            player.x = data.x;
            player.y = data.y;
            player.facing = data.facing;

            send(opponent, {
                type: "position",
                id: id,
                x: data.x,
                y: data.y,
                facing: data.facing
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

        else if (data.type === "rematch") {

            send(opponent, { type: "rematch" });
        }

    });

    socket.on("close", () => {

        console.log("Player " + id + " disconnected");

        slots[id] = null;

        const opponent = slots[otherId(id)];
        send(opponent, { type: "opponentLeft" });
    });

});

httpServer.listen(PORT, "0.0.0.0", () => {
    console.log("DUEL ARENA SERVER STARTED on port " + PORT);
});