// =====================================================================
// MATCH TYPES, TEAMS AND SLOTS
//
// Why this exists
// ---------------
// Before this module, "an online match" meant exactly two things in this
// codebase: casual play had ONE global pair of slots (`slots = {1,2}` in
// server.js) and ranked had rooms with `players[1]` and `players[2]`.
// Every rule that followed -- who relays to whom, who can damage whom,
// who won the round -- was written as `otherSlot(1) === 2`.
//
// That assumption is what this module removes. A match here is described
// by DATA, not by code that knows there are two players:
//
//   * MATCH TYPE   -- "2v2", "1v1v1", "coop4", ...
//   * TEAM SIZES   -- [2,2] / [1,1,1] / [4]; the length IS the team count
//     and the sum IS the maximum player count
//   * SLOT         -- 1..maxPlayers, the identity a connection plays as
//   * TEAM ID      -- 1..teamCount, which side a slot belongs to
//
// Adding "3v3" later is one entry in MATCH_TYPES and nothing else: no
// relay change, no combat change, no win-condition change, because every
// one of those reads the team layout instead of hard-coding it.
//
// Pure module: no sockets, no storage, no timers, no game state. It
// answers questions about a match's SHAPE. server.js owns the live
// matches; combat.js owns health; this owns "who is on whose side".
// =====================================================================

// The one table that defines what configurations exist.
//
//   teamSizes  -- one entry per TEAM, each the number of slots on it.
//                 Sum = maxPlayers, length = team count.
//   kind       -- "pvp" (teams fight each other) or "coop" (one team,
//                 fighting the Voidbreak PvE simulation).
//   roundsToWin-- team round wins needed to take the match. Matches the
//                 existing ROUNDS_TO_WIN (3) used by index.html and
//                 ranked.js, so 1v1 behaves exactly as it always has.
//   minPlayers -- a lobby cannot start below this. PvP needs every slot
//                 filled (a 2v2 with 3 people is not a 2v2); co-op can
//                 start as soon as its own player count is reached,
//                 which IS its maxPlayers here, so both are the same
//                 number today -- it stays a separate field because
//                 that is the rule that would differ first.
const MATCH_TYPES = {
    // ---- PvP: free-for-all (every player is their own team) ----
    "1v1":     { id: "1v1",     kind: "pvp",  label: "1V1",       teamSizes: [1, 1],       roundsToWin: 3, order: 1 },
    "1v1v1":   { id: "1v1v1",   kind: "pvp",  label: "1V1V1",     teamSizes: [1, 1, 1],    roundsToWin: 3, order: 2 },
    "1v1v1v1": { id: "1v1v1v1", kind: "pvp",  label: "1V1V1V1",   teamSizes: [1, 1, 1, 1], roundsToWin: 3, order: 3 },

    // ---- PvP: teams ----
    "2v1":     { id: "2v1",     kind: "pvp",  label: "2V1",       teamSizes: [2, 1],       roundsToWin: 3, order: 4 },
    "2v2":     { id: "2v2",     kind: "pvp",  label: "2V2",       teamSizes: [2, 2],       roundsToWin: 3, order: 5 },

    // ---- Voidbreak co-op: one team, against the PvE simulation ----
    "coop2":   { id: "coop2",   kind: "coop", label: "2 PLAYERS", teamSizes: [2],          roundsToWin: 1, order: 6 },
    "coop3":   { id: "coop3",   kind: "coop", label: "3 PLAYERS", teamSizes: [3],          roundsToWin: 1, order: 7 },
    "coop4":   { id: "coop4",   kind: "coop", label: "4 PLAYERS", teamSizes: [4],          roundsToWin: 1, order: 8 }
};

// Derived once, so nothing downstream has to recompute (or, worse,
// hand-maintain) the numbers that follow from teamSizes.
for (const key of Object.keys(MATCH_TYPES)) {
    const t = MATCH_TYPES[key];
    t.teamCount = t.teamSizes.length;
    t.maxPlayers = t.teamSizes.reduce((a, b) => a + b, 0);
    t.minPlayers = t.maxPlayers;
    t.teamed = t.kind === "pvp" && t.teamSizes.some(n => n > 1);
}

function isMatchType(id) {
    return typeof id === "string" && Object.prototype.hasOwnProperty.call(MATCH_TYPES, id);
}

function getMatchType(id) {
    return isMatchType(id) ? MATCH_TYPES[id] : null;
}

// Public, ordered list for the mode-select UI. A copy per call so a
// client of this module can never mutate the table.
function listMatchTypes(kind) {
    return Object.keys(MATCH_TYPES)
        .map(k => MATCH_TYPES[k])
        .filter(t => !kind || t.kind === kind)
        .sort((a, b) => a.order - b.order)
        .map(t => ({
            id: t.id,
            kind: t.kind,
            label: t.label,
            teamSizes: t.teamSizes.slice(),
            teamCount: t.teamCount,
            maxPlayers: t.maxPlayers,
            minPlayers: t.minPlayers,
            roundsToWin: t.roundsToWin,
            teamed: t.teamed
        }));
}

// ---------------------------------------------------------------------
// SLOT -> TEAM LAYOUT
//
// The default layout fills each team in order, which is exactly the
// assignment the spec describes:
//
//   1v1      slot1->team1  slot2->team2
//   1v1v1    slot1->team1  slot2->team2  slot3->team3
//   2v1      slot1->team1  slot2->team1  slot3->team2
//   2v2      slot1->team1  slot2->team1  slot3->team2  slot4->team2
//   coop4    every slot -> team 1
//
// A lobby may move a player to another team afterwards (see
// canMoveToTeam), but only ever to a team with room, and never after the
// match has started.
// ---------------------------------------------------------------------
function defaultTeamForSlot(type, slot) {
    if (!type) return 1;
    let remaining = slot;
    for (let team = 1; team <= type.teamCount; team++) {
        const size = type.teamSizes[team - 1];
        if (remaining <= size) return team;
        remaining -= size;
    }
    return type.teamCount;
}

// The full default layout, 1-indexed by slot.
function defaultLayout(type) {
    const out = {};
    if (!type) return out;
    for (let slot = 1; slot <= type.maxPlayers; slot++) out[slot] = defaultTeamForSlot(type, slot);
    return out;
}

// How many slots a given team may hold. Read from teamSizes, so a team
// can never be over-filled regardless of what a client asks for.
function teamCapacity(type, teamId) {
    if (!type || !Number.isInteger(teamId) || teamId < 1 || teamId > type.teamCount) return 0;
    return type.teamSizes[teamId - 1];
}

// `members` is { slot: teamId } for the slots currently occupied.
function teamOccupancy(members, teamId) {
    let n = 0;
    for (const slot of Object.keys(members)) if (members[slot] === teamId) n++;
    return n;
}

// Validates a team change request. The SERVER calls this; a client's own
// opinion about its team id is never used anywhere.
function canMoveToTeam(type, members, slot, teamId) {
    if (!type) return { ok: false, error: "Unknown match type" };
    if (type.kind === "coop") return { ok: false, error: "Co-op runs have one team" };
    if (!Number.isInteger(teamId) || teamId < 1 || teamId > type.teamCount) {
        return { ok: false, error: "No such team" };
    }
    if (members[slot] === teamId) return { ok: false, error: "Already on that team" };
    if (teamOccupancy(members, teamId) >= teamCapacity(type, teamId)) {
        return { ok: false, error: "That team is full" };
    }
    return { ok: true };
}

// ---------------------------------------------------------------------
// SPAWN SLOTS
//
// The server assigns a spawn INDEX (0-based) per slot; the client maps
// that index to a real arena coordinate from its own table (see
// MATCH_SPAWNS in index.html), which is the same table the existing
// local 3-4 player FFA already uses. Keeping coordinates on the client
// means this module never has to know the arena's size, and means the
// existing spawn points are reused rather than duplicated.
//
// Index order is deliberate: 0 and 1 are the ORIGINAL left/right duel
// spawns, so a 1v1 spawns in exactly the same two places it always has.
// Teammates are given adjacent indices where the layout allows it.
// ---------------------------------------------------------------------
function spawnIndexForSlot(type, slot) {
    if (!type) return 0;
    return Math.max(0, Math.min(type.maxPlayers - 1, slot - 1));
}

// ---------------------------------------------------------------------
// RELATIONSHIPS -- the questions combat asks.
// ---------------------------------------------------------------------

// `teams` is { slot: teamId }. Two slots are allies when they share a
// team; a slot is always its own ally (used to reject self-damage).
function areAllies(teams, a, b) {
    if (a === b) return true;
    const ta = teams[a], tb = teams[b];
    if (!ta || !tb) return false;
    return ta === tb;
}

function areEnemies(teams, a, b) {
    if (a === b) return false;
    const ta = teams[a], tb = teams[b];
    if (!ta || !tb) return false;
    return ta !== tb;
}

// Every team that still has at least one living slot. `isAlive(slot)` is
// supplied by the caller (combat.js owns that fact, not this module).
function livingTeams(teams, slots, isAlive) {
    const out = [];
    for (const slot of slots) {
        if (!isAlive(slot)) continue;
        const team = teams[slot];
        if (team && out.indexOf(team) === -1) out.push(team);
    }
    return out;
}

// The round's winner, or null while it is still being contested.
// One team left standing wins; zero left (a simultaneous wipe) is a
// draw, reported as null with `drawn` so the caller can restart the
// round rather than award it to nobody.
function resolveRoundWinner(teams, slots, isAlive) {
    const alive = livingTeams(teams, slots, isAlive);
    if (alive.length === 1) return { decided: true, team: alive[0], drawn: false };
    if (alive.length === 0) return { decided: true, team: null, drawn: true };
    return { decided: false, team: null, drawn: false };
}

// Slots on a team, in slot order.
function slotsOnTeam(teams, teamId) {
    return Object.keys(teams)
        .map(Number)
        .filter(slot => teams[slot] === teamId)
        .sort((a, b) => a - b);
}

module.exports = {
    MATCH_TYPES,
    isMatchType,
    getMatchType,
    listMatchTypes,
    defaultTeamForSlot,
    defaultLayout,
    teamCapacity,
    teamOccupancy,
    canMoveToTeam,
    spawnIndexForSlot,
    areAllies,
    areEnemies,
    livingTeams,
    resolveRoundWinner,
    slotsOnTeam
};
