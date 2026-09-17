// =====================================================================
// ONLINE LOBBIES -- the room players sit in before a match exists.
//
// What this module is
// -------------------
// A pure state machine over ONE lobby record. It answers "may this
// happen?" and mutates the record when the answer is yes:
//
//   create / join / leave / setTeam / setReady / start / close
//
// Every one of those returns { ok } or { ok:false, error }, and every
// rule that could be abused (a full lobby, a started lobby, a team that
// is already full, someone else's ready flag, a non-host starting the
// match) is enforced HERE, server-side, rather than by the client
// choosing not to send the message.
//
// What it is NOT
// --------------
// No sockets, no timers, no storage, no broadcasting, no game state.
// server.js owns the live lobby table, the connections and the fan-out;
// party.js owns what a match type IS. This owns only the room.
//
// IDENTITY
// --------
// A member is identified by its ACCOUNT id (`sub`), which server.js
// resolves from a session token, never from anything the client sends.
// Nothing in this module accepts a client-supplied player id, team id or
// host flag as authoritative -- team changes are validated against the
// match type's own capacities, and the host is whoever this module says
// it is.
// =====================================================================

const Party = require("./party");

// A lobby nobody has touched for this long is swept (see isStale). Long
// enough to survive someone reading the rules or answering the door,
// short enough that abandoned rooms never accumulate.
const LOBBY_IDLE_MS = 15 * 60 * 1000;

// Room codes are what a player types to join a friend. Ambiguous
// characters (0/O, 1/I) are left out so a code read aloud or off a phone
// screen can't be mistyped into somebody else's room.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;

function makeCode(random) {
    let out = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
        out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
    }
    return out;
}

function normalizeCode(raw) {
    if (typeof raw !== "string") return null;
    const code = raw.trim().toUpperCase();
    if (code.length !== CODE_LENGTH) return null;
    for (const ch of code) if (CODE_ALPHABET.indexOf(ch) === -1) return null;
    return code;
}

// ---------------------------------------------------------------------
// The record.
//
// `members` is an ARRAY in join order; each entry carries the slot and
// team this module assigned. Slots are stable for the life of the lobby
// (a player leaving frees their slot for the next joiner) because the
// slot is what the match, the spawn point and the combat state are all
// keyed on.
// ---------------------------------------------------------------------
function createLobby(opts) {
    const type = Party.getMatchType(opts.typeId);
    if (!type) return { ok: false, error: "Unknown match type" };

    const lobby = {
        id: opts.id,
        code: opts.code,
        typeId: type.id,
        kind: type.kind,
        maxPlayers: type.maxPlayers,
        // "open" -> filling; "live" -> a match exists; "closed" -> gone.
        state: "open",
        hostSub: opts.hostSub,
        createdAt: opts.now,
        touchedAt: opts.now,
        // Set by server.js when it starts the match, so a late joiner
        // can be refused with the real reason rather than "full".
        matchId: null,
        members: [],
        // Voidbreak co-op run settings. Ignored entirely by PvP lobbies.
        // Only the HOST can change these, and only while open.
        settings: {
            levelIdx: 0,
            difficulty: "normal"
        },
        private: !!opts.private
    };
    return { ok: true, lobby: lobby };
}

function memberBySub(lobby, sub) {
    return lobby.members.find(m => m.sub === sub) || null;
}

function teamMap(lobby) {
    const out = {};
    for (const m of lobby.members) out[m.slot] = m.team;
    return out;
}

// The lowest slot number not currently taken. Slots are 1..maxPlayers,
// so this always finds one while the lobby is not full.
function nextFreeSlot(lobby) {
    const taken = new Set(lobby.members.map(m => m.slot));
    for (let slot = 1; slot <= lobby.maxPlayers; slot++) {
        if (!taken.has(slot)) return slot;
    }
    return null;
}

// The team a new member lands on: the first team with room, in team
// order. For every configuration in party.js that reproduces the spec's
// own examples (2v1 fills Team 1 then Team 2, 2v2 fills 1,1,2,2, FFA
// gives everyone their own team, co-op puts everyone on Team 1).
function firstTeamWithRoom(lobby) {
    const type = Party.getMatchType(lobby.typeId);
    const members = teamMap(lobby);
    for (let team = 1; team <= type.teamCount; team++) {
        if (Party.teamOccupancy(members, team) < Party.teamCapacity(type, team)) return team;
    }
    return 1;
}

function join(lobby, member, now) {
    if (!lobby || lobby.state === "closed") return { ok: false, error: "That lobby no longer exists" };
    if (lobby.state === "live") return { ok: false, error: "That match has already started" };
    if (memberBySub(lobby, member.sub)) return { ok: false, error: "Already in this lobby" };
    if (lobby.members.length >= lobby.maxPlayers) return { ok: false, error: "That lobby is full" };

    const slot = nextFreeSlot(lobby);
    if (slot === null) return { ok: false, error: "That lobby is full" };

    const row = {
        sub: member.sub,
        name: member.name,
        level: member.level || 1,
        slot: slot,
        team: firstTeamWithRoom(lobby),
        ready: false,
        connected: true,
        joinedAt: now
    };
    lobby.members.push(row);
    lobby.touchedAt = now;
    return { ok: true, member: row };
}

// Returns { ok, wasHost, empty, newHostSub }. server.js decides what to
// tell whom; this only updates the room.
function leave(lobby, sub, now) {
    const idx = lobby.members.findIndex(m => m.sub === sub);
    if (idx === -1) return { ok: false, error: "Not in this lobby" };

    const wasHost = lobby.hostSub === sub;
    lobby.members.splice(idx, 1);
    lobby.touchedAt = now;

    if (!lobby.members.length) {
        lobby.state = "closed";
        return { ok: true, wasHost: wasHost, empty: true, newHostSub: null };
    }

    // HOST LEAVING DOES NOT KILL THE ROOM. The longest-present remaining
    // member takes over, so a host closing their laptop costs everyone
    // else a new host and nothing more. (A host leaving a LIVE match is
    // a different question and is answered in server.js, where the match
    // state actually lives.)
    let newHostSub = null;
    if (wasHost) {
        lobby.hostSub = lobby.members[0].sub;
        newHostSub = lobby.hostSub;
    }

    // Everyone's ready flag is cleared when the roster changes, so a
    // match can never start on the strength of a "ready" given for a
    // different line-up.
    for (const m of lobby.members) m.ready = false;

    return { ok: true, wasHost: wasHost, empty: false, newHostSub: newHostSub };
}

// A team change. The requested team is checked against the match type's
// OWN capacity table -- this is the only place a team id is ever
// accepted, and it is never simply stored because a client asked.
function setTeam(lobby, sub, teamId, now) {
    if (lobby.state !== "open") return { ok: false, error: "The match has already started" };
    const me = memberBySub(lobby, sub);
    if (!me) return { ok: false, error: "Not in this lobby" };

    const type = Party.getMatchType(lobby.typeId);
    const members = teamMap(lobby);
    const check = Party.canMoveToTeam(type, members, me.slot, teamId);
    if (!check.ok) return check;

    me.team = teamId;
    // Same rule as a join/leave: the line-up changed, so consent to
    // start it is no longer valid.
    for (const m of lobby.members) m.ready = false;
    lobby.touchedAt = now;
    return { ok: true };
}

function setReady(lobby, sub, ready, now) {
    if (lobby.state !== "open") return { ok: false, error: "The match has already started" };
    const me = memberBySub(lobby, sub);
    if (!me) return { ok: false, error: "Not in this lobby" };
    me.ready = !!ready;
    lobby.touchedAt = now;
    return { ok: true };
}

// Co-op run settings (level + difficulty). Host only, open only.
function setSettings(lobby, sub, settings, now, levelCount) {
    if (lobby.state !== "open") return { ok: false, error: "The match has already started" };
    if (lobby.hostSub !== sub) return { ok: false, error: "Only the host can change the run" };
    if (lobby.kind !== "coop") return { ok: false, error: "This lobby has no run settings" };

    if (settings && settings.levelIdx !== undefined) {
        const idx = Math.floor(Number(settings.levelIdx));
        if (!isFinite(idx) || idx < 0 || idx >= levelCount) return { ok: false, error: "No such sector" };
        lobby.settings.levelIdx = idx;
    }
    if (settings && settings.difficulty !== undefined) {
        const d = String(settings.difficulty);
        if (["normal", "hard", "extreme"].indexOf(d) === -1) return { ok: false, error: "No such difficulty" };
        lobby.settings.difficulty = d;
    }
    lobby.touchedAt = now;
    return { ok: true };
}

// Can this lobby start RIGHT NOW? Both the host's start button and the
// server's own auto-start read this one function, so the two can never
// disagree about what "ready" means.
function startCheck(lobby, sub) {
    if (lobby.state === "live") return { ok: false, error: "The match has already started" };
    if (lobby.state !== "open") return { ok: false, error: "That lobby no longer exists" };
    if (lobby.hostSub !== sub) return { ok: false, error: "Only the host can start the match" };

    const type = Party.getMatchType(lobby.typeId);
    if (lobby.members.length < type.minPlayers) {
        return { ok: false, error: "Needs " + type.minPlayers + " players" };
    }
    // Every team must actually have its slots filled, or a "2v2" could
    // start as a 3-v-1. Capacity is checked on join and setTeam, so this
    // is the occupancy half of the same rule.
    const members = teamMap(lobby);
    for (let team = 1; team <= type.teamCount; team++) {
        if (Party.teamOccupancy(members, team) !== Party.teamCapacity(type, team)) {
            return { ok: false, error: "Teams are not balanced yet" };
        }
    }
    const notReady = lobby.members.filter(m => m.sub !== lobby.hostSub && !m.ready);
    if (notReady.length) {
        return { ok: false, error: notReady.length + " player(s) not ready" };
    }
    return { ok: true };
}

function markLive(lobby, matchId, now) {
    lobby.state = "live";
    lobby.matchId = matchId;
    lobby.touchedAt = now;
}

// Back to the room after a match finishes, so everyone lands in the
// lobby they came from instead of the main menu. Ready flags are
// cleared -- the next match needs fresh consent.
function returnToLobby(lobby, now) {
    if (lobby.state === "closed") return;
    lobby.state = "open";
    lobby.matchId = null;
    for (const m of lobby.members) m.ready = false;
    lobby.touchedAt = now;
}

function isStale(lobby, now) {
    return lobby.state === "closed" || (now - lobby.touchedAt) > LOBBY_IDLE_MS;
}

// ---------------------------------------------------------------------
// The view every client gets. Deliberately PUBLIC-ONLY: names, levels,
// slots, teams and ready flags. An account id (`sub`) never leaves the
// server through this -- clients address each other by SLOT.
// ---------------------------------------------------------------------
function publicView(lobby, viewerSub) {
    const type = Party.getMatchType(lobby.typeId);
    return {
        id: lobby.id,
        code: lobby.code,
        typeId: lobby.typeId,
        kind: lobby.kind,
        label: type ? type.label : lobby.typeId,
        teamSizes: type ? type.teamSizes.slice() : [],
        maxPlayers: lobby.maxPlayers,
        state: lobby.state,
        settings: { levelIdx: lobby.settings.levelIdx, difficulty: lobby.settings.difficulty },
        youAreHost: lobby.hostSub === viewerSub,
        yourSlot: (memberBySub(lobby, viewerSub) || {}).slot || null,
        hostSlot: (memberBySub(lobby, lobby.hostSub) || {}).slot || null,
        members: lobby.members.map(m => ({
            slot: m.slot,
            team: m.team,
            name: m.name,
            level: m.level,
            ready: m.ready,
            connected: m.connected,
            host: m.sub === lobby.hostSub,
            you: m.sub === viewerSub
        })),
        canStart: startCheck(lobby, lobby.hostSub).ok
    };
}

// A row for the "join a game" browser. Never includes members' names --
// a public list of who is online where is a bigger surface than the
// browser needs, and the friends system already covers that case.
function browserRow(lobby) {
    const type = Party.getMatchType(lobby.typeId);
    return {
        code: lobby.code,
        typeId: lobby.typeId,
        kind: lobby.kind,
        label: type ? type.label : lobby.typeId,
        players: lobby.members.length,
        maxPlayers: lobby.maxPlayers,
        state: lobby.state
    };
}

module.exports = {
    LOBBY_IDLE_MS,
    CODE_LENGTH,
    makeCode,
    normalizeCode,
    createLobby,
    memberBySub,
    teamMap,
    join,
    leave,
    setTeam,
    setReady,
    setSettings,
    startCheck,
    markLive,
    returnToLobby,
    isStale,
    publicView,
    browserRow
};
