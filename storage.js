// =====================================================================
// PERSISTENT STORAGE LAYER
//
// Why this file exists
// --------------------
// Render (and any container host) gives each instance an EPHEMERAL
// filesystem. It is rebuilt from the Git checkout on every deploy and
// reset on every restart/spin-down. Writing accounts to a local
// accounts.json therefore loses every account created or updated since
// the last commit -- the only accounts that survive a deploy are the
// ones physically committed to the repo.
//
// So account data has to live somewhere the instance does not own.
// This module picks a backend at boot:
//
//   DATABASE_URL set  -> Postgres  (Render Postgres; survives deploys)
//   otherwise         -> JSON files under DATA_DIR (default: this dir)
//
// The file backend is what local development uses, and it is also the
// right backend if you attach a Render Persistent Disk instead of a
// database (just point DATA_DIR at the mount, e.g. /var/data).
//
// Everything is async. server.js keeps its in-memory `accounts` object
// as a read cache, so all the synchronous read paths (leaderboard,
// admin search, isAdminSession) are unaffected -- only loads at boot
// and writes go through here.
// =====================================================================

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || "";
const DATA_DIR = process.env.DATA_DIR || __dirname;

// The committed accounts.json doubles as the migration seed: on first
// boot against an empty database its accounts are imported, so existing
// players keep their progress. Never used to OVERWRITE a stored account
// -- see migrateSeedAccounts().
const SEED_ACCOUNTS_FILE = path.join(__dirname, "accounts.json");

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

// How long a signed-in session stays valid. Sessions are persisted (see
// below) so a redeploy doesn't sign everybody out mid-game, but they
// shouldn't accumulate forever either.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Reads a JSON file. Returns `fallback` only when the file genuinely
// does not exist. A file that EXISTS but cannot be parsed is a corrupt
// store, not an empty one -- returning {} there is how a truncated
// write turns into "everybody lost their progress" on the next save, so
// that case is backed up and thrown instead.
function readJsonFileStrict(file, fallback) {
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    } catch (e) {
        if (e.code === "ENOENT") return fallback;
        throw e;
    }
    if (!raw.trim()) return fallback;
    try {
        return JSON.parse(raw);
    } catch (e) {
        const backup = file + ".corrupt-" + Date.now();
        try { fs.copyFileSync(file, backup); } catch (_) {}
        throw new Error(
            "Refusing to start: " + file + " exists but is not valid JSON (" +
            e.message + "). A copy was saved to " + backup + ". Starting with " +
            "an empty store here would overwrite real data on the next save."
        );
    }
}

// Atomic write: a full write to a temp file followed by a rename, which
// is atomic on POSIX. A crash can leave the temp file behind but can
// never leave the real store half-written.
//
// SYNCHRONOUS version -- boot only (seeding a fresh store, pruning
// expired sessions at startup). Nothing is being served yet at those
// points, so blocking is free. It must NEVER be used on a request or
// gameplay path: it blocks the single Node event loop, which stalls
// every in-flight WebSocket relay packet for its whole duration.
function writeJsonFileAtomic(file, value) {
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
}

// ASYNCHRONOUS version -- everything after boot. Same tmp+rename
// atomicity, but the serialize and the disk write both yield instead of
// blocking, so a save can never freeze the real-time relay.
async function writeJsonFileAtomicAsync(file, value) {
    const tmp = file + ".tmp-" + process.pid;
    await fsp.writeFile(tmp, JSON.stringify(value));
    await fsp.rename(tmp, file);
}

// Serializes writes per key so two overlapping saves can never interleave
// and can never land out of order.
function makeWriteQueue() {
    const chains = new Map();
    return function enqueue(key, task) {
        const prev = chains.get(key) || Promise.resolve();
        const next = prev.then(task, task);
        // Keep the chain alive but don't let a rejection poison the next write.
        chains.set(key, next.catch(() => {}));
        return next;
    };
}

// Coalesces rapid successive saves of the SAME key into ONE physical
// write. The file backend rewrites the whole accounts file per save, and
// gameplay fires several saves back to back -- a single kill triggers
// both /save and /xp/report, a round win another -- so without this the
// disk is hit once per game event instead of once per burst.
//
// The contract callers already depend on is preserved exactly: the
// promise returned resolves only once THIS caller's data has actually
// reached disk, and rejects if that write failed (server.js's /save
// rolls its in-memory record back on rejection, so a false "saved" here
// would silently desync the cache from the store).
//
// The batching is self-regulating rather than timer-based: a save with
// no write in flight goes out on the next tick (so an idle server still
// responds in ~1ms), while saves that arrive DURING a write pile into
// one batch that goes out when it finishes. Coalescing therefore kicks
// in exactly when the disk is the bottleneck and costs nothing when it
// isn't -- no fixed delay is ever added to a quiet server.
function makeCoalescingWriter() {
    const pending = new Map();  // key -> { waiters, write, scheduled }
    const running = new Map();  // key -> promise for a flush already on disk

    function flush(key) {
        const entry = pending.get(key);
        if (!entry) return Promise.resolve();
        pending.delete(key);

        // Never let two flushes of the same key overlap or land out of
        // order -- chain each one behind the previous.
        const prev = running.get(key) || Promise.resolve();
        const task = prev.then(() => entry.write(), () => entry.write());
        running.set(key, task.then(() => {}, () => {}));
        return task.then(
            () => { for (const w of entry.waiters) w.resolve(); },
            (e) => { for (const w of entry.waiters) w.reject(e); }
        );
    }

    return {
        // `write` is re-supplied on every call so a flush always persists
        // the LATEST snapshot, never a stale one captured earlier.
        save(key, write) {
            let entry = pending.get(key);
            if (!entry) {
                entry = { waiters: [], write: write, scheduled: false };
                pending.set(key, entry);
            }
            entry.write = write;
            const p = new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }));
            if (!entry.scheduled) {
                entry.scheduled = true;
                // Next tick, not a timer: everything queued in this same
                // turn of the event loop (a kill fires /save AND
                // /xp/report) collapses into a single physical write,
                // without delaying a lone save at all.
                const inFlight = running.get(key);
                if (inFlight) inFlight.then(() => flush(key));
                else setImmediate(() => flush(key));
            }
            return p;
        },
        // Used on shutdown so nothing still queued is lost.
        flushAll() {
            return Promise.all(Array.from(pending.keys()).map(flush));
        }
    };
}

// ---------------------------------------------------------------------
// FILE BACKEND -- local dev, and Render Persistent Disk via DATA_DIR
// ---------------------------------------------------------------------
function createFileBackend() {
    const accountsFile = path.join(DATA_DIR, "accounts.json");
    const sessionsFile = path.join(DATA_DIR, "sessions.json");
    const purchasesFile = path.join(DATA_DIR, "stripePurchases.json");
    const docsDir = DATA_DIR;
    const coalesced = makeCoalescingWriter();

    // In-memory mirrors so a single save doesn't have to re-read the
    // whole file (and can't lose a concurrent write to another key).
    let accountsCache = {};
    let sessionsCache = {};
    let purchasesCache = {}; // sessionId -> purchase record

    return {
        name: "file (" + DATA_DIR + ")",

        async init() {
            if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

            accountsCache = readJsonFileStrict(accountsFile, null);

            if (accountsCache === null) {
                // No store yet at DATA_DIR. Seed it from the committed
                // accounts.json so a fresh persistent disk starts with the
                // existing players rather than empty.
                const seed = readJsonFileStrict(SEED_ACCOUNTS_FILE, {});
                accountsCache = seed;
                writeJsonFileAtomic(accountsFile, accountsCache);
                const n = Object.keys(seed).length;
                if (n) console.log("[storage] seeded " + n + " account(s) into " + accountsFile);
            }

            purchasesCache = readJsonFileStrict(purchasesFile, {});
        },

        async loadAllAccounts() {
            return accountsCache;
        },

        async saveAccount(sub, record) {
            // The cache is the source of truth the rest of the server
            // reads, so it updates synchronously and immediately; only
            // the disk write is deferred/coalesced.
            accountsCache[sub] = record;
            return coalesced.save("accounts", () =>
                writeJsonFileAtomicAsync(accountsFile, accountsCache));
        },

        async loadDoc(key, fallback) {
            const value = readJsonFileStrict(path.join(docsDir, key + ".json"), null);
            return value === null ? fallback : value;
        },

        async saveDoc(key, value) {
            return coalesced.save("doc:" + key, () =>
                writeJsonFileAtomicAsync(path.join(docsDir, key + ".json"), value));
        },

        // Sessions are disposable -- the worst case for losing them is
        // that players sign in again -- so unlike accounts, a corrupt or
        // unreadable session file is discarded rather than fatal.
        async loadValidSessions() {
            let stored = {};
            try {
                stored = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
            } catch (e) {
                return {};
            }
            const cutoff = Date.now() - SESSION_TTL_MS;
            const live = {};
            for (const token of Object.keys(stored)) {
                const row = stored[token];
                if (row && row.sub && typeof row.createdAt === "number" && row.createdAt > cutoff) {
                    live[token] = row;
                }
            }
            sessionsCache = live;
            // Rewrite immediately so expired rows don't linger forever.
            if (Object.keys(live).length !== Object.keys(stored).length) {
                try { writeJsonFileAtomic(sessionsFile, live); } catch (e) {}
            }
            return live;
        },

        async saveSession(token, record) {
            sessionsCache[token] = record;
            return coalesced.save("sessions", () =>
                writeJsonFileAtomicAsync(sessionsFile, sessionsCache));
        },

        // Logging out has to actually remove the session, not just drop
        // it from the running instance -- otherwise a restart would
        // resurrect a session the player already ended.
        async deleteSession(token) {
            if (!(token in sessionsCache)) return;
            delete sessionsCache[token];
            return coalesced.save("sessions", () =>
                writeJsonFileAtomicAsync(sessionsFile, sessionsCache));
        },

        // Lets the process flush anything still sitting in the coalescing
        // window before exiting, so a restart can't drop the last save.
        flushPendingWrites() {
            return coalesced.flushAll();
        },

        // ---- Stripe purchase ledger (see billing.js) ----
        //
        // The idempotency guard the webhook handler depends on: a
        // purchase is recorded ONCE, keyed by its Stripe Checkout
        // Session ID, and every later delivery of the same webhook
        // event finds it already there instead of granting Crystals a
        // second time. Safe on a single Node process because the
        // check-then-insert below has no `await` between reading the
        // map and writing to it -- nothing else can run in between on
        // one event loop, which is the same reasoning the rest of this
        // file's in-memory caches already rely on.
        async recordPurchaseIfNew(record) {
            if (purchasesCache[record.sessionId]) return null; // already exists -- caller must not grant again
            purchasesCache[record.sessionId] = record;
            await coalesced.save("purchases", () =>
                writeJsonFileAtomicAsync(purchasesFile, purchasesCache));
            return record;
        },

        async updatePurchase(sessionId, patch) {
            const existing = purchasesCache[sessionId];
            if (!existing) return null;
            const updated = Object.assign({}, existing, patch);
            purchasesCache[sessionId] = updated;
            await coalesced.save("purchases", () =>
                writeJsonFileAtomicAsync(purchasesFile, purchasesCache));
            return updated;
        },

        async getPurchase(sessionId) {
            return purchasesCache[sessionId] || null;
        }
    };
}

// ---------------------------------------------------------------------
// POSTGRES BACKEND -- Render Postgres, survives deploys and restarts
// ---------------------------------------------------------------------
function rowToPurchase(row) {
    return {
        sessionId: row.session_id,
        accountId: row.account_id,
        paymentIntentId: row.payment_intent_id,
        packageId: row.package_id,
        crystals: row.crystals,
        amountUsdCents: row.amount_usd_cents,
        status: row.status,
        createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
        updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now()
    };
}

function createPostgresBackend() {
    const { Pool } = require("pg");

    // Render's managed Postgres presents a certificate the default Node
    // trust store doesn't chain to, so verification is relaxed for it the
    // same way Render's own docs do. The connection itself is still TLS.
    const needsSsl = !/localhost|127\.0\.0\.1/.test(DATABASE_URL);
    const pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: needsSsl ? { rejectUnauthorized: false } : false,
        max: 5
    });

    pool.on("error", err => {
        // An idle client dropped by the DB must not take the game down.
        console.log("[storage] idle postgres client error:", err.message);
    });

    const enqueue = makeWriteQueue();

    // One row per account, so two players saving at the same time write
    // different rows and can never clobber each other (which is exactly
    // what a single big JSON blob would do).
    async function ensureSchema() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                sub        TEXT PRIMARY KEY,
                data       JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS app_state (
                key        TEXT PRIMARY KEY,
                data       JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        // Sessions live here rather than in memory so a redeploy does not
        // silently sign every player out mid-game (their client keeps the
        // token it already has, and its saves keep being accepted).
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                token      TEXT PRIMARY KEY,
                sub        TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        // Stripe purchase ledger (see billing.js). session_id is the
        // PRIMARY KEY specifically so INSERT ... ON CONFLICT DO NOTHING
        // is an atomic, database-enforced "has this webhook event
        // already been processed" check -- the actual idempotency
        // guard, not just an in-memory one, so it survives a redeploy
        // and holds even if two webhook deliveries land on two
        // different server instances at once.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stripe_purchases (
                session_id         TEXT PRIMARY KEY,
                account_id         TEXT NOT NULL,
                payment_intent_id  TEXT,
                package_id         TEXT NOT NULL,
                crystals           INTEGER NOT NULL,
                amount_usd_cents   INTEGER NOT NULL,
                status             TEXT NOT NULL,
                created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
    }

    // Imports the committed accounts.json. ON CONFLICT DO NOTHING makes
    // this safe to run on every single boot: an account already in the
    // database keeps its stored (newer) data, and the stale committed
    // snapshot can never overwrite live progress.
    async function migrateSeedAccounts() {
        const seed = readJsonFileStrict(SEED_ACCOUNTS_FILE, {});
        const subs = Object.keys(seed);
        if (!subs.length) return;

        let imported = 0;
        for (const sub of subs) {
            const record = seed[sub];
            if (!record || typeof record !== "object") continue;
            const result = await pool.query(
                "INSERT INTO accounts (sub, data) VALUES ($1, $2) ON CONFLICT (sub) DO NOTHING",
                [sub, record]
            );
            if (result.rowCount > 0) imported++;
        }
        console.log(
            "[storage] seed migration: " + imported + " new account(s) imported, " +
            (subs.length - imported) + " already present (left untouched)"
        );
    }

    return {
        name: "postgres",

        async init() {
            await ensureSchema();
            await migrateSeedAccounts();
        },

        async loadAllAccounts() {
            const { rows } = await pool.query("SELECT sub, data FROM accounts");
            const out = {};
            for (const row of rows) out[row.sub] = row.data;
            return out;
        },

        async saveAccount(sub, record) {
            return enqueue("account:" + sub, () =>
                pool.query(
                    `INSERT INTO accounts (sub, data, updated_at) VALUES ($1, $2, now())
                     ON CONFLICT (sub) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
                    [sub, record]
                )
            );
        },

        async loadDoc(key, fallback) {
            const { rows } = await pool.query("SELECT data FROM app_state WHERE key = $1", [key]);
            return rows.length ? rows[0].data : fallback;
        },

        async saveDoc(key, value) {
            return enqueue("doc:" + key, () =>
                pool.query(
                    `INSERT INTO app_state (key, data, updated_at) VALUES ($1, $2, now())
                     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
                    [key, JSON.stringify(value)]
                )
            );
        },

        async loadValidSessions() {
            // Drop anything past its TTL first, then load what's left.
            await pool.query(
                "DELETE FROM sessions WHERE created_at < now() - ($1::bigint * interval '1 millisecond')",
                [SESSION_TTL_MS]
            );
            const { rows } = await pool.query("SELECT token, sub, created_at FROM sessions");
            const out = {};
            for (const row of rows) {
                out[row.token] = { sub: row.sub, createdAt: new Date(row.created_at).getTime() };
            }
            return out;
        },

        async saveSession(token, record) {
            return enqueue("session:" + token, () =>
                pool.query(
                    `INSERT INTO sessions (token, sub) VALUES ($1, $2)
                     ON CONFLICT (token) DO UPDATE SET sub = EXCLUDED.sub`,
                    [token, record.sub]
                )
            );
        },

        async deleteSession(token) {
            return enqueue("session:" + token, () =>
                pool.query("DELETE FROM sessions WHERE token = $1", [token])
            );
        },

        // ---- Stripe purchase ledger ----
        // Returns the inserted row, or null if session_id already
        // existed -- the caller (billing.js's webhook handler) treats
        // null as "already processed, do not grant Crystals again".
        // enqueue()'d per session id so two deliveries of the SAME
        // event that somehow reach this process concurrently still
        // serialize rather than both reading "not present yet".
        async recordPurchaseIfNew(record) {
            return enqueue("purchase:" + record.sessionId, async () => {
                const { rows } = await pool.query(
                    `INSERT INTO stripe_purchases
                        (session_id, account_id, payment_intent_id, package_id, crystals, amount_usd_cents, status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (session_id) DO NOTHING
                     RETURNING session_id`,
                    [record.sessionId, record.accountId, record.paymentIntentId || null,
                     record.packageId, record.crystals, record.amountUsdCents, record.status]
                );
                return rows.length ? record : null;
            });
        },

        async updatePurchase(sessionId, patch) {
            return enqueue("purchase:" + sessionId, async () => {
                const sets = [];
                const values = [];
                let i = 1;
                for (const key of Object.keys(patch)) {
                    const column = key === "paymentIntentId" ? "payment_intent_id" : key;
                    sets.push(column + " = $" + (++i));
                    values.push(patch[key]);
                }
                if (!sets.length) return this.getPurchase(sessionId);
                const { rows } = await pool.query(
                    `UPDATE stripe_purchases SET ${sets.join(", ")}, updated_at = now()
                     WHERE session_id = $1 RETURNING *`,
                    [sessionId, ...values]
                );
                return rows.length ? rowToPurchase(rows[0]) : null;
            });
        },

        async getPurchase(sessionId) {
            const { rows } = await pool.query(
                "SELECT * FROM stripe_purchases WHERE session_id = $1", [sessionId]
            );
            return rows.length ? rowToPurchase(rows[0]) : null;
        }
    };
}

const backend = DATABASE_URL ? createPostgresBackend() : createFileBackend();

module.exports = {
    backendName: backend.name,
    usingDatabase: !!DATABASE_URL,
    init: () => backend.init(),
    loadAllAccounts: () => backend.loadAllAccounts(),
    saveAccount: (sub, record) => backend.saveAccount(sub, record),
    loadDoc: (key, fallback) => backend.loadDoc(key, fallback),
    saveDoc: (key, value) => backend.saveDoc(key, value),
    loadValidSessions: () => backend.loadValidSessions(),
    saveSession: (token, record) => backend.saveSession(token, record),
    deleteSession: (token) => backend.deleteSession(token),
    // Only the file backend batches writes behind a short coalescing
    // window; Postgres writes go straight out, so there is nothing to
    // flush there and this is a no-op.
    flushPendingWrites: () =>
        backend.flushPendingWrites ? backend.flushPendingWrites() : Promise.resolve(),
    recordPurchaseIfNew: (record) => backend.recordPurchaseIfNew(record),
    updatePurchase: (sessionId, patch) => backend.updatePurchase(sessionId, patch),
    getPurchase: (sessionId) => backend.getPurchase(sessionId)
};
