// =====================================================================
// LOBBY CHAT
//
// A single global room for players sitting in the lobby. It rides on
// the EXISTING presence WebSocket (see server.js's presence_hello
// handler and connectPresence() in index.html) -- there is no second
// server, no second socket, and no polling. Chat is just another
// message type on a connection this server already authenticated.
//
// What this module owns
// ---------------------
//   * what a valid message is (length, shape, control characters)
//   * how fast one account may send
//   * the profanity filter, when it is switched on
//   * the last N messages, in memory only
//
// What it deliberately does NOT own
// ---------------------------------
// Identity. A submitted message carries NO sender fields at all -- the
// caller passes the account it resolved from conn.authSub, and this
// module stamps the message from that. A client cannot claim a name, an
// account id, or an admin flag, because there is no field for it to put
// one in.
//
// Nothing here is persisted. Chat never reaches accounts.json or the
// database: the history is a bounded in-memory ring that is empty again
// after a restart, which is the correct lifetime for lobby chatter and
// keeps it off the gameplay write path entirely.
//
// Pure module: no sockets, no storage, no timers.
// =====================================================================

const crypto = require("crypto");

const CHAT_CONFIG = {
    minLength: 1,
    maxLength: 200,

    // How much scrollback a player who just opened the lobby receives.
    // Small on purpose: it is a live room, not an archive.
    historySize: 50,

    // One message per this many ms, per ACCOUNT (not per socket -- two
    // tabs must not double the allowance).
    minMsBetweenMessages: 700,

    // A short burst is fine; a sustained one is not. Both limits have to
    // pass, so a player can fire off three quick replies but cannot hold
    // the room at max rate.
    burstMax: 6,
    burstWindowMs: 10000,

    // Names shown next to messages are display names, which allow more
    // characters than a login username. Truncated for layout only.
    maxNameLength: 24
};

// ---------------------------------------------------------------------
// The filter.
//
// A deliberately small, blunt list. The point is to take the worst of it
// out of a game a lot of children play, not to win an arms race against
// deliberate evasion -- which no word list ever does. It is switched by
// CHAT_FILTER_ENABLED so it can be turned off without a code change.
//
// Matching collapses the usual letter/number substitutions and runs of
// repeated letters first, so "f u u u c k" and "sh1t" are caught, then
// masks the matched span in the ORIGINAL text.
// ---------------------------------------------------------------------
const FILTER_WORDS = [
    "fuck", "shit", "bitch", "cunt", "asshole", "dickhead", "bastard",
    "nigger", "nigga", "faggot", "retard", "whore", "slut", "wanker",
    "twat", "pussy", "cock", "dick", "piss", "prick"
];

const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i" };

// Builds a lowercase "skeleton" of the text alongside a map from each
// skeleton character back to its index in the original, so a match can
// be masked in place without disturbing anything around it.
function skeletonize(text) {
    let skeleton = "";
    const map = [];
    let lastChar = "";
    for (let i = 0; i < text.length; i++) {
        let c = text[i].toLowerCase();
        if (LEET[c]) c = LEET[c];
        if (!/[a-z]/.test(c)) continue;   // punctuation and spacing are noise here
        if (c === lastChar) continue;     // "fuuuck" -> "fuck"
        lastChar = c;
        skeleton += c;
        map.push(i);
    }
    return { skeleton: skeleton, map: map };
}

// Suffixes an inflected form may add ("fucking", "bitches"). Anything
// longer than this and the word is a different word -- which is what
// keeps "cocktail" and "assessment" out of the filter.
const ALLOWED_SUFFIXES = ["", "s", "es", "ed", "er", "ers", "ing", "in", "y", "z", "a", "d", "n"];
// Prefixes that only ever combine with a swear. Deliberately tiny: an
// unconstrained prefix is what turns "shuttlecock" into a false match.
const ALLOWED_PREFIXES = ["", "mother", "moter", "bul", "dum", "jak", "dip", "hors", "as"];

function wordIsProfane(wordSkeleton, needle) {
    const at = wordSkeleton.indexOf(needle);
    if (at === -1) return false;
    const before = wordSkeleton.slice(0, at);
    const after = wordSkeleton.slice(at + needle.length);
    return ALLOWED_PREFIXES.indexOf(before) !== -1 && ALLOWED_SUFFIXES.indexOf(after) !== -1;
}

// Masks every original character between two indices, leaving spacing
// alone so the shape of the sentence survives.
function maskSpan(chars, start, end) {
    for (let i = start; i <= end; i++) {
        if (/\s/.test(chars[i])) continue;
        chars[i] = "*";
    }
}

// Two passes, because ordinary use and deliberate evasion need
// opposite rules:
//
//   1. WORD level, with boundaries. Catches "sh1t", "fuuuck",
//      "bitches" -- and, because the match has to account for the whole
//      word, leaves "cocktail" and "assessment" alone.
//   2. WHOLE MESSAGE, ignoring spacing, but only accepting a match that
//      actually spans more than one word. That is what "f u c k" looks
//      like, and no innocent single word can trigger it.
function filterProfanity(text) {
    const chars = text.split("");
    let filtered = false;

    const needles = FILTER_WORDS.map(w => skeletonize(w).skeleton).filter(Boolean);

    // ---- pass 1: word by word ----
    const wordRe = /[^\s]+/g;
    let m;
    while ((m = wordRe.exec(text)) !== null) {
        const word = m[0];
        const sk = skeletonize(word);
        if (!sk.skeleton) continue;
        for (const needle of needles) {
            if (wordIsProfane(sk.skeleton, needle)) {
                maskSpan(chars, m.index, m.index + word.length - 1);
                filtered = true;
                break;
            }
        }
    }

    // ---- pass 2: spaced-out evasion ----
    const whole = skeletonize(text);
    for (const needle of needles) {
        let from = 0;
        for (;;) {
            const at = whole.skeleton.indexOf(needle, from);
            if (at === -1) break;
            from = at + needle.length;
            const start = whole.map[at];
            const end = whole.map[at + needle.length - 1];
            // Only a match that crossed a space is interesting here --
            // anything inside a single word was pass 1's business, and
            // pass 1 deliberately declined it.
            if (/\s/.test(text.slice(start, end + 1))) {
                maskSpan(chars, start, end);
                filtered = true;
            }
        }
    }

    return { text: chars.join(""), filtered: filtered };
}

// ---------------------------------------------------------------------
// Validation.
//
// Runs on the SERVER, on every message, regardless of what the client
// checked. Control characters are stripped rather than rejected (a
// paste can pick them up innocently), but anything that would let a
// message break out of one line -- newlines, tabs -- is collapsed to a
// space.
// ---------------------------------------------------------------------
function validateMessage(raw, config) {
    const cfg = config || CHAT_CONFIG;
    if (typeof raw !== "string") return { ok: false, error: "Message must be text." };

    // Cheap bound BEFORE any regex work, so a megabyte of text can't be
    // used to burn CPU on the gameplay event loop.
    if (raw.length > cfg.maxLength * 10) return { ok: false, error: "Message is too long." };

    const text = raw
        .replace(/[\r\n\t]+/g, " ")
        // C0/C1 control characters: invisible, and nothing legitimate
        // types them.
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
        // Zero-width and bidi-override characters: invisible in the
        // message, but they can reorder or disguise what is rendered.
        .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    if (text.length < cfg.minLength) return { ok: false, error: "Message is empty." };
    if (text.length > cfg.maxLength) {
        return { ok: false, error: "Message must be " + cfg.maxLength + " characters or fewer." };
    }
    return { ok: true, text: text };
}

function newMessageId() {
    return crypto.randomBytes(9).toString("hex");
}

// ---------------------------------------------------------------------
// The room.
// ---------------------------------------------------------------------
function createChatRoom(options) {
    const cfg = Object.assign({}, CHAT_CONFIG, options && options.config);
    const filterEnabled = !(options && options.filterEnabled === false);

    const history = [];                 // oldest first, capped at cfg.historySize
    const rate = new Map();             // accountId -> { last, recent: [ts] }

    function pushHistory(message) {
        history.push(message);
        while (history.length > cfg.historySize) history.shift();
        return message;
    }

    function checkRate(accountId, now) {
        let e = rate.get(accountId);
        if (!e) { e = { last: 0, recent: [] }; rate.set(accountId, e); }
        if (now - e.last < cfg.minMsBetweenMessages) {
            return { ok: false, error: "You're sending messages too quickly." };
        }
        e.recent = e.recent.filter(t => now - t < cfg.burstWindowMs);
        if (e.recent.length >= cfg.burstMax) {
            return { ok: false, error: "You're sending messages too quickly." };
        }
        return { ok: true, entry: e };
    }

    return {
        config: cfg,
        filterEnabled: filterEnabled,

        // `sender` is built by the caller from the authenticated
        // connection: { accountId, name, isAdmin }. Nothing about it
        // comes from the message.
        submit(sender, rawText, now) {
            now = now || Date.now();
            if (!sender || !sender.accountId) return { ok: false, error: "Not signed in." };

            const v = validateMessage(rawText, cfg);
            if (!v.ok) return v;

            const gate = checkRate(sender.accountId, now);
            if (!gate.ok) return gate;

            let text = v.text;
            if (filterEnabled) text = filterProfanity(text).text;

            // Only count a message against the rate limit once it is
            // actually going to be sent, so a rejected message (too
            // long, empty) doesn't consume the player's allowance.
            gate.entry.last = now;
            gate.entry.recent.push(now);

            const name = String(sender.name || "Player").slice(0, cfg.maxNameLength);

            return {
                ok: true,
                message: pushHistory({
                    id: newMessageId(),
                    kind: "user",
                    // The SERVER's clock. A client timestamp would let a
                    // message claim to be from the future and sort itself
                    // to the top of everyone's log.
                    ts: now,
                    from: sender.accountId,
                    name: name,
                    admin: !!sender.isAdmin,
                    text: text
                })
            };
        },

        // System lines (joins, announcements). kind:"system" carries no
        // sender, and a client can never produce one: submit() is the
        // only path a client-originated message takes, and it always
        // stamps kind:"user".
        system(text) {
            const v = validateMessage(text, cfg);
            if (!v.ok) return null;
            return pushHistory({
                id: newMessageId(),
                kind: "system",
                ts: Date.now(),
                text: v.text
            });
        },

        history() {
            return history.slice();
        },

        // Called when an account signs out or drops, so the rate table
        // does not grow forever on a long-running server.
        forget(accountId) {
            rate.delete(accountId);
        },

        stats() {
            return { messages: history.length, tracked: rate.size, filterEnabled: filterEnabled };
        }
    };
}

module.exports = {
    CHAT_CONFIG,
    FILTER_WORDS,
    validateMessage,
    filterProfanity,
    createChatRoom
};
