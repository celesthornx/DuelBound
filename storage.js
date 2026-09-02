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
function writeJsonFileAtomic(file, value) {
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
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

// ---------------------------------------------------------------------
// FILE BACKEND -- local dev, and Render Persistent Disk via DATA_DIR
// ---------------------------------------------------------------------
function createFileBackend() {
    const accountsFile = path.join(DATA_DIR, "accounts.json");
    const docsDir = DATA_DIR;
    const enqueue = makeWriteQueue();

    // In-memory mirror so a single-account save doesn't have to re-read
    // the whole file (and can't lose a concurrent write to another key).
    let accountsCache = {};

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
        },

        async loadAllAccounts() {
            return accountsCache;
        },

        async saveAccount(sub, record) {
            accountsCache[sub] = record;
            return enqueue("accounts", () => {
                writeJsonFileAtomic(accountsFile, accountsCache);
            });
        },

        async loadDoc(key, fallback) {
            const value = readJsonFileStrict(path.join(docsDir, key + ".json"), null);
            return value === null ? fallback : value;
        },

        async saveDoc(key, value) {
            return enqueue("doc:" + key, () => {
                writeJsonFileAtomic(path.join(docsDir, key + ".json"), value);
            });
        }
    };
}

// ---------------------------------------------------------------------
// POSTGRES BACKEND -- Render Postgres, survives deploys and restarts
// ---------------------------------------------------------------------
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
    saveDoc: (key, value) => backend.saveDoc(key, value)
};
