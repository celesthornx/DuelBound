// =====================================================================
// STATIC ASSET SERVING
//
// Why this file exists
// --------------------
// The old serveStatic() in server.js did `fs.readFile` of the whole
// file on every single request and replied with nothing but a
// Content-Type. That has three consequences that all land on the same
// event loop the WebSocket relay runs on:
//
//   * NO validator (no ETag/Last-Modified) and NO Cache-Control, so a
//     browser re-downloaded index.html (594 KB) and bgm.mp3 (4.4 MB) in
//     full on every load AND every reload. ~5 MB per page view.
//   * NO compression, so that 594 KB of HTML went out raw.
//   * NO Range support, which iOS/iPadOS Safari requires for <audio>:
//     without a 206 it re-requests the whole 4.4 MB file.
//
// Measured on loopback with a warm page cache: 55 MB of static traffic
// over 12 seconds pushed in-match ping p99 from 0.67 ms to 7.97 ms.
// On a small shared Render instance with real egress it is worse. This
// was the single largest source of gameplay latency SPIKES on this
// server -- not the relay, which measures at 0.09 ms per message.
//
// What this does instead
// ----------------------
//   * Reads each file ONCE into memory and revalidates with a cheap
//     async fs.stat (mtime+size), so a dev edit is still picked up but
//     a 4.4 MB buffer is not re-read per request.
//   * Strong ETag (content hash) + Last-Modified, so a repeat visit
//     gets a ~150-byte 304 instead of megabytes.
//   * gzip and Brotli, computed once per file and cached.
//   * Range/206 for media, which is what iPad audio actually needs.
//   * Real Content-Length (the old code sent chunked, even for the mp3).
//
// Everything here is async. Nothing on this path blocks the relay.
// =====================================================================

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
};

// Only these get compressed. Compressing an mp3/png wastes CPU and
// produces a bigger body.
const COMPRESSIBLE = new Set([
    "text/html; charset=utf-8",
    "application/javascript; charset=utf-8",
    "text/css; charset=utf-8",
    "application/json; charset=utf-8",
    "image/svg+xml",
    "text/plain; charset=utf-8"
]);

// Below this, compression costs more (in header overhead and CPU) than
// it saves.
const MIN_COMPRESS_BYTES = 1024;

// Total bytes allowed to sit in the in-memory cache. This repo's whole
// static payload is ~5.3 MB, so everything fits; anything larger than
// the remaining budget is streamed from disk instead of buffered, so a
// big file added later can never blow the container's memory.
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

// Content that IS the app: must be revalidated so a redeploy is picked
// up on the next load. `no-cache` still lets the browser keep the copy
// and get a 304 -- it just can't use it without asking.
const REVALIDATE_TYPES = new Set([
    "text/html; charset=utf-8",
    "application/javascript; charset=utf-8",
    "application/json; charset=utf-8"
]);

// Everything else (audio, images, fonts, css) changes rarely, so it gets
// a real max-age -- which is what stops the 4.4 MB bgm.mp3 being fetched
// again on every single page load.
//
// One day rather than a week, so replacing an asset in place can never
// leave a player on a stale copy for long; stale-while-revalidate then
// covers the following week, so a returning player still gets the file
// instantly from cache and the refresh happens in the background instead
// of blocking the load. Browsers without stale-while-revalidate simply
// revalidate after a day and get a 304 when nothing changed.
const STATIC_MAX_AGE_SEC = 24 * 60 * 60;
const STATIC_SWR_SEC = 6 * 24 * 60 * 60;

function createStaticServer(rootDir, options) {
    const opts = options || {};
    const revalidate = opts.revalidate !== false; // stat before serving from cache
    const cache = new Map(); // absolute path -> entry
    let cachedBytes = 0;

    const stats = { hits: 0, misses: 0, notModified: 0, ranges: 0, streamed: 0, bytesOut: 0 };

    function contentTypeFor(filePath) {
        return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    }

    // Loads a file into the cache (or marks it too big to cache).
    async function load(filePath, st) {
        const type = contentTypeFor(filePath);
        const entry = {
            path: filePath,
            type: type,
            size: st.size,
            mtimeMs: st.mtimeMs,
            lastModified: new Date(st.mtimeMs).toUTCString(),
            body: null,      // null => stream it from disk
            etag: null,
            gzip: null,      // lazily filled, then reused
            br: null,
            encodingPending: null
        };

        if (st.size <= MAX_CACHE_BYTES - cachedBytes) {
            entry.body = await fsp.readFile(filePath);
            cachedBytes += entry.body.length;
            entry.etag = '"' + crypto.createHash("sha1").update(entry.body).digest("base64").slice(0, 22) + '"';
        } else {
            // Too big for the remaining budget -- still cache the
            // metadata so it gets an ETag and a 304, just stream the body.
            entry.etag = 'W/"' + st.size.toString(16) + "-" + Math.round(st.mtimeMs).toString(16) + '"';
        }

        cache.set(filePath, entry);
        return entry;
    }

    async function getEntry(filePath) {
        const existing = cache.get(filePath);
        if (existing && !revalidate) return existing;

        let st;
        try {
            st = await fsp.stat(filePath);
        } catch (e) {
            if (existing) {
                cachedBytes -= existing.body ? existing.body.length : 0;
                cache.delete(filePath);
            }
            return null;
        }
        if (!st.isFile()) return null;

        if (existing && existing.size === st.size && existing.mtimeMs === st.mtimeMs) {
            stats.hits++;
            return existing;
        }
        if (existing) cachedBytes -= existing.body ? existing.body.length : 0;
        stats.misses++;
        return load(filePath, st);
    }

    // Compresses ONCE per file per encoding and reuses the result for
    // every later request. The compress itself runs on the libuv thread
    // pool (the async zlib API), so even the first one never blocks the
    // relay.
    function encodedBody(entry, encoding) {
        if (!entry.body) return Promise.resolve(null);
        if (encoding === "br" && entry.br) return Promise.resolve(entry.br);
        if (encoding === "gzip" && entry.gzip) return Promise.resolve(entry.gzip);

        const key = encoding;
        entry.encodingPending = entry.encodingPending || Object.create(null);
        if (entry.encodingPending[key]) return entry.encodingPending[key];

        const run = new Promise(resolve => {
            const done = (err, out) => {
                if (err || !out || out.length >= entry.body.length) { resolve(null); return; }
                if (encoding === "br") entry.br = out; else entry.gzip = out;
                resolve(out);
            };
            if (encoding === "br") {
                zlib.brotliCompress(entry.body, {
                    params: {
                        [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
                        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.body.length
                    }
                }, done);
            } else {
                zlib.gzip(entry.body, { level: 6 }, done);
            }
        }).then(v => { entry.encodingPending[key] = null; return v; });

        entry.encodingPending[key] = run;
        return run;
    }

    function pickEncoding(req, entry) {
        if (!entry.body || entry.body.length < MIN_COMPRESS_BYTES) return null;
        if (!COMPRESSIBLE.has(entry.type)) return null;
        const accept = String(req.headers["accept-encoding"] || "");
        if (/\bbr\b/.test(accept)) return "br";
        if (/\bgzip\b/.test(accept)) return "gzip";
        return null;
    }

    function cacheControlFor(entry) {
        return REVALIDATE_TYPES.has(entry.type)
            ? "no-cache"
            : "public, max-age=" + STATIC_MAX_AGE_SEC + ", stale-while-revalidate=" + STATIC_SWR_SEC;
    }

    // RFC 7233 single-range only, which is all any browser's media
    // element actually sends.
    function parseRange(header, size) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
        if (!m) return null;
        const hasStart = m[1] !== "", hasEnd = m[2] !== "";
        if (!hasStart && !hasEnd) return null;
        let start, end;
        if (hasStart) {
            start = parseInt(m[1], 10);
            end = hasEnd ? parseInt(m[2], 10) : size - 1;
        } else {
            const suffix = parseInt(m[2], 10);
            if (suffix <= 0) return null;
            start = Math.max(0, size - suffix);
            end = size - 1;
        }
        if (!isFinite(start) || !isFinite(end) || start > end || start >= size) return null;
        return { start: start, end: Math.min(end, size - 1) };
    }

    function isFresh(req, entry) {
        const inm = req.headers["if-none-match"];
        if (inm) {
            // A weak comparison is what a validator check calls for.
            const tags = inm.split(",").map(s => s.trim().replace(/^W\//, ""));
            const mine = entry.etag.replace(/^W\//, "");
            if (tags.indexOf("*") >= 0 || tags.indexOf(mine) >= 0) return true;
            return false;
        }
        const ims = req.headers["if-modified-since"];
        if (ims) {
            const t = Date.parse(ims);
            if (!isNaN(t) && Math.floor(entry.mtimeMs / 1000) * 1000 <= t) return true;
        }
        return false;
    }

    async function serve(req, res) {
        const method = req.method;
        if (method !== "GET" && method !== "HEAD") {
            res.writeHead(405, { "Allow": "GET, HEAD", "Content-Length": "0" });
            res.end();
            return true;
        }

        let urlPath = req.url.split("?")[0];
        if (urlPath === "/") urlPath = "/index.html";

        let decoded;
        try { decoded = decodeURIComponent(urlPath); } catch (e) { decoded = urlPath; }

        // Reject traversal before touching the filesystem. path.join
        // normalises "..", so comparing the RESULT against the root
        // (with a separator, so "/rootevil" can't pass) is the check.
        const filePath = path.join(rootDir, decoded);
        if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
            res.writeHead(403, { "Content-Type": "text/plain", "Content-Length": "9" });
            res.end("Forbidden");
            return true;
        }

        const entry = await getEntry(filePath);
        if (!entry) return false; // caller sends its own 404

        const compressible = COMPRESSIBLE.has(entry.type);

        const baseHeaders = {
            "Content-Type": entry.type,
            "Cache-Control": cacheControlFor(entry),
            "ETag": entry.etag,
            "Last-Modified": entry.lastModified,
            // A compressible resource is served in whichever encoding the
            // client asked for, so caches must key on that -- including on
            // the 304, which is why this lives in the shared headers.
            "Vary": "Accept-Encoding",
            // Ranges are offered only for what actually gets ranged (media).
            // A compressible resource has two representations sharing one
            // ETag, and a client that ranged the identity bytes of a
            // response it had cached compressed would splice the two
            // together. Not advertising ranges for those is the simple,
            // correct way to make that impossible.
            "Accept-Ranges": compressible ? "none" : "bytes",
            "X-Content-Type-Options": "nosniff"
        };

        // ---- 304: the whole point. A returning player's browser gets
        // ~150 bytes back instead of 594 KB of HTML / 4.4 MB of audio.
        if (isFresh(req, entry)) {
            stats.notModified++;
            res.writeHead(304, baseHeaders);
            res.end();
            return true;
        }

        // ---- Range (206). iOS/iPadOS Safari opens <audio> with a Range
        // request and will refetch the entire file if it doesn't get a
        // 206 back, which is exactly the 4.4 MB re-download this avoids.
        const rangeHeader = compressible ? null : req.headers["range"];
        if (rangeHeader) {
            const range = parseRange(rangeHeader, entry.size);
            if (!range) {
                res.writeHead(416, Object.assign({}, baseHeaders, {
                    "Content-Range": "bytes */" + entry.size,
                    "Content-Length": "0"
                }));
                res.end();
                return true;
            }
            const len = range.end - range.start + 1;
            stats.ranges++;
            stats.bytesOut += len;
            res.writeHead(206, Object.assign({}, baseHeaders, {
                "Content-Range": "bytes " + range.start + "-" + range.end + "/" + entry.size,
                "Content-Length": String(len)
            }));
            if (method === "HEAD") { res.end(); return true; }
            if (entry.body) {
                res.end(entry.body.subarray(range.start, range.end + 1));
            } else {
                stats.streamed++;
                fs.createReadStream(entry.path, { start: range.start, end: range.end })
                    .on("error", () => res.destroy())
                    .pipe(res);
            }
            return true;
        }

        // ---- Full body, compressed when it is worth it.
        const encoding = pickEncoding(req, entry);
        if (encoding) {
            const body = await encodedBody(entry, encoding);
            if (body) {
                stats.bytesOut += body.length;
                res.writeHead(200, Object.assign({}, baseHeaders, {
                    "Content-Encoding": encoding,
                    "Content-Length": String(body.length)
                }));
                res.end(method === "HEAD" ? undefined : body);
                return true;
            }
        }

        stats.bytesOut += entry.size;
        res.writeHead(200, Object.assign({}, baseHeaders, {
            "Content-Length": String(entry.size)
        }));
        if (method === "HEAD") { res.end(); return true; }
        if (entry.body) {
            res.end(entry.body);
        } else {
            stats.streamed++;
            fs.createReadStream(entry.path).on("error", () => res.destroy()).pipe(res);
        }
        return true;
    }

    // Pre-reads and pre-compresses the files every player pulls on the
    // very first load, so the first visitor after a deploy doesn't pay
    // for the Brotli pass mid-match.
    async function warm(names) {
        for (const name of names) {
            try {
                const entry = await getEntry(path.join(rootDir, name));
                if (!entry) continue;
                if (COMPRESSIBLE.has(entry.type) && entry.body && entry.body.length >= MIN_COMPRESS_BYTES) {
                    await encodedBody(entry, "br");
                    await encodedBody(entry, "gzip");
                }
            } catch (e) { /* a missing optional asset is not fatal */ }
        }
    }

    function snapshot() {
        const files = [];
        for (const entry of cache.values()) {
            files.push({
                file: path.basename(entry.path),
                bytes: entry.size,
                cached: !!entry.body,
                gzip: entry.gzip ? entry.gzip.length : null,
                br: entry.br ? entry.br.length : null
            });
        }
        return Object.assign({ cachedBytes: cachedBytes, files: files }, stats);
    }

    return { serve, warm, snapshot };
}

module.exports = { createStaticServer, MIME_TYPES };
