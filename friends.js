// =====================================================================
// FRIENDS -- pure data-shape, migration and validation logic.
//
// Same split as ranked.js: everything here is a pure function or a plain
// constant. No sockets, no storage, no server state. server.js owns
// persistence, presence and the WebSocket wiring; this module owns
// "what does a friends record look like", "is this request legal",
// "what is safe to show another player" and "how is the list sorted".
//
// IDENTITY
// --------
// A friendship references the account's stable Google `sub` -- the same
// id the accounts store is keyed by. Emails are NEVER used as an
// identifier and never leave the server (see publicPlayerView).
// =====================================================================

const FRIENDS_CONFIG = {
    // Server-side cap. The client is never trusted to enforce this.
    maxFriends: 100,
    // Stops someone papering a popular player with requests, and bounds
    // how much a single account can store.
    maxOutgoingRequests: 50,
    maxIncomingRequests: 200,
    // Search
    searchMinChars: 1,
    searchMaxResults: 20,
    // Presence considered stale after this long without a heartbeat.
    presenceTimeoutMs: 70 * 1000
};

// Presence states this architecture can ACTUALLY determine, and nothing
// more. Each one is backed by a real server-side fact:
//   offline   -- no live authenticated connection for the account
//   online    -- connected, sitting in menus
//   inMatch   -- connected and reported being in a Duel Arena match
//   voidbreak -- connected and reported having Voidbreak open
// The two "reported" states come from the client, but they are only
// ever cosmetic labels ON TOP of a server-verified connection: a client
// cannot use them to appear online when it is not connected.
const PRESENCE = {
    OFFLINE: "offline",
    ONLINE: "online",
    IN_MATCH: "inMatch",
    VOIDBREAK: "voidbreak"
};

const VALID_ACTIVITIES = [PRESENCE.ONLINE, PRESENCE.IN_MATCH, PRESENCE.VOIDBREAK];

// Sort weight -- online first, then in-match, then Voidbreak, then
// offline (requirement 23). Lower sorts first.
const PRESENCE_ORDER = {
    [PRESENCE.ONLINE]: 0,
    [PRESENCE.IN_MATCH]: 1,
    [PRESENCE.VOIDBREAK]: 2,
    [PRESENCE.OFFLINE]: 3
};

function defaultFriendsRecord() {
    return {
        friends: [],
        incomingFriendRequests: [],
        outgoingFriendRequests: [],
        // Reserved so a future blocking system has somewhere to live
        // without another migration (requirement 25). Nothing reads it
        // for enforcement yet EXCEPT isBlocked() below, which is already
        // wired into every request/invite path -- so switching blocking
        // on later is a UI + write path, not a re-architecture.
        blocked: []
    };
}

// Normalizes one account's friend fields in place-safe fashion.
// Idempotent, additive, and never removes or resets anything: only
// missing/invalid fields are replaced. Returns the SAME reference when
// nothing needed changing so callers can cheaply detect "dirty".
function ensureFriendsRecord(account) {
    if (!account || typeof account !== "object") return null;

    const keys = ["friends", "incomingFriendRequests", "outgoingFriendRequests", "blocked"];
    let changed = false;
    const out = {};

    for (const key of keys) {
        const value = account[key];
        if (Array.isArray(value)) {
            // Drop anything that isn't a usable id, and de-duplicate.
            // A corrupt entry must not be able to wedge the whole list.
            const cleaned = [];
            const seen = new Set();
            for (const entry of value) {
                if (typeof entry !== "string" || !entry) { changed = true; continue; }
                if (seen.has(entry)) { changed = true; continue; }
                seen.add(entry);
                cleaned.push(entry);
            }
            if (cleaned.length !== value.length) changed = true;
            out[key] = cleaned;
        } else {
            out[key] = [];
            changed = true;
        }
    }

    return changed ? out : null; // null = already valid, nothing to write
}

// ---------------------------------------------------------------------
// VALIDATION
//
// Every one of these is a pure predicate so the server can check the
// same rules from any entry point without duplicating them.
// ---------------------------------------------------------------------

function isFriend(account, otherSub) {
    return Array.isArray(account.friends) && account.friends.includes(otherSub);
}
function hasIncomingRequest(account, fromSub) {
    return Array.isArray(account.incomingFriendRequests) && account.incomingFriendRequests.includes(fromSub);
}
function hasOutgoingRequest(account, toSub) {
    return Array.isArray(account.outgoingFriendRequests) && account.outgoingFriendRequests.includes(toSub);
}
// Blocking is not user-facing yet, but every gate already calls this so
// enabling it later needs no changes to the request/invite pipeline.
function isBlocked(account, otherSub) {
    return Array.isArray(account.blocked) && account.blocked.includes(otherSub);
}

// Decides whether A may send B a friend request.
// Returns { ok: true } or { ok: false, code, message }.
//
// The ORDER matters: the more specific/actionable answers come first so
// the player gets the most useful message ("you already have a request
// from them" beats a generic "already pending").
function canSendRequest(fromSub, toSub, fromAccount, toAccount, config) {
    const cfg = config || FRIENDS_CONFIG;

    if (!fromSub || !toSub) return { ok: false, code: "invalid", message: "Invalid player" };
    if (fromSub === toSub) {
        return { ok: false, code: "self", message: "You cannot add yourself" };
    }
    if (!toAccount) {
        return { ok: false, code: "notFound", message: "Player not found" };
    }
    if (isFriend(fromAccount, toSub)) {
        return { ok: false, code: "alreadyFriends", message: "You are already friends" };
    }
    // Their request to US already exists -> this is really an accept.
    // Surfaced as its own code so the server can just accept instead of
    // creating a second, mirrored pending request (requirement 18:
    // simultaneous requests must resolve to ONE state).
    if (hasIncomingRequest(fromAccount, toSub)) {
        return { ok: false, code: "reciprocal", message: "They already sent you a request -- accept it instead" };
    }
    if (hasOutgoingRequest(fromAccount, toSub)) {
        return { ok: false, code: "alreadyPending", message: "Request already sent" };
    }
    if (isBlocked(toAccount, fromSub) || isBlocked(fromAccount, toSub)) {
        // Deliberately indistinguishable from "not found" to the sender,
        // so blocking can't be probed.
        return { ok: false, code: "notFound", message: "Player not found" };
    }
    if ((fromAccount.friends || []).length >= cfg.maxFriends) {
        return { ok: false, code: "full", message: "Friend list full" };
    }
    if ((toAccount.friends || []).length >= cfg.maxFriends) {
        return { ok: false, code: "targetFull", message: "That player's friend list is full" };
    }
    if ((fromAccount.outgoingFriendRequests || []).length >= cfg.maxOutgoingRequests) {
        return { ok: false, code: "tooManyOutgoing", message: "You have too many pending requests" };
    }
    if ((toAccount.incomingFriendRequests || []).length >= cfg.maxIncomingRequests) {
        return { ok: false, code: "targetBusy", message: "That player has too many pending requests" };
    }
    return { ok: true };
}

// ---------------------------------------------------------------------
// PUBLIC VIEWS -- the ONLY shapes that ever reach a client.
//
// Built by allow-list, never by deleting fields from the account. That
// way a future private field added to an account cannot accidentally
// start leaking here.
// ---------------------------------------------------------------------

// The minimum needed to render a search result or a friend row.
// `rankedView` is publicRankedView(account) from ranked.js, passed in so
// this module doesn't depend on ranked.js.
function publicPlayerView(sub, account, presence, rankedView) {
    if (!account) return null;
    return {
        id: sub,                       // stable account id (NOT an email)
        name: account.name || "Player",
        skinId: account.p1SkinId || "cyan",
        presence: presence || PRESENCE.OFFLINE,
        rank: rankedView && rankedView.placementComplete && rankedView.rank
            ? { name: rankedView.rank.name, tier: rankedView.rank.tier, color: rankedView.rank.color }
            : null,
        rp: rankedView && rankedView.placementComplete ? rankedView.rp : null
    };
}

// A friend's fuller public profile. Still an allow-list, and still no
// email, no admin flag, no session data, no daily-challenge state.
function publicProfileView(sub, account, presence, rankedView) {
    const base = publicPlayerView(sub, account, presence, rankedView);
    if (!base) return null;
    return Object.assign(base, {
        wins: account.wins || 0,
        kills: account.kills || 0,
        friendCount: (account.friends || []).length,
        ranked: rankedView ? {
            placementComplete: !!rankedView.placementComplete,
            rank: rankedView.rank || null,
            rp: rankedView.placementComplete ? rankedView.rp : null,
            wins: rankedView.wins || 0,
            losses: rankedView.losses || 0,
            games: rankedView.games || 0,
            winRate: rankedView.winRate || 0,
            highestRank: rankedView.highestRank || null,
            highestRP: rankedView.highestRP || 0,
            season: rankedView.season || null
        } : null
    });
}

// Sort: online, in-match, Voidbreak, then offline; alphabetical inside
// each group (requirement 23 -- consistent and predictable).
function sortFriendViews(views) {
    return views.slice().sort((a, b) => {
        const pa = PRESENCE_ORDER[a.presence] !== undefined ? PRESENCE_ORDER[a.presence] : 9;
        const pb = PRESENCE_ORDER[b.presence] !== undefined ? PRESENCE_ORDER[b.presence] : 9;
        if (pa !== pb) return pa - pb;
        return String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
    });
}

// ---------------------------------------------------------------------
// MUTATIONS -- pure list edits. The server applies these to BOTH sides
// and persists both; doing the edits here keeps "what changes" separate
// from "how it is written", which is what makes the two-sided rollback
// in server.js readable.
// ---------------------------------------------------------------------
const without = (list, value) => (Array.isArray(list) ? list.filter(x => x !== value) : []);
const withValue = (list, value) => {
    const base = Array.isArray(list) ? list : [];
    return base.includes(value) ? base.slice() : base.concat([value]);
};

module.exports = {
    FRIENDS_CONFIG,
    PRESENCE,
    VALID_ACTIVITIES,
    PRESENCE_ORDER,
    defaultFriendsRecord,
    ensureFriendsRecord,
    isFriend,
    hasIncomingRequest,
    hasOutgoingRequest,
    isBlocked,
    canSendRequest,
    publicPlayerView,
    publicProfileView,
    sortFriendViews,
    without,
    withValue
};
