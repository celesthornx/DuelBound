// =====================================================================
// RANKED -- pure rating/rank/season logic.
//
// Everything in this file is a pure function or a plain data constant:
// no sockets, no storage, no server state. server.js owns the queue, the
// match rooms and the persistence; this module owns "what rank is 1425
// RP", "how much RP does beating a 1800 cost/earn", "what does a brand
// new ranked record look like" and "how does an old account get ranked
// fields without losing anything".
//
// Keeping it separate is what makes the numbers tunable in one place
// (RANKED_CONFIG below) and the maths unit-testable without booting a
// server or opening a socket.
// =====================================================================

// ---------------------------------------------------------------------
// CENTRAL CONFIG -- every tunable ranked number lives here and nowhere
// else. Changing a value here changes it everywhere, including the
// numbers the client is told to display.
// ---------------------------------------------------------------------
const RANKED_CONFIG = {
    // Season identity. Deliberately NOT time-driven: a season rolls over
    // only when this string changes (and startNewSeason() is run), so a
    // clock skew or a restart can never silently wipe a season.
    season: "S1",
    seasonName: "Season 1",

    // Rating
    startingRP: 1000,     // where a placement-completed player lands at 50%
    minRP: 0,             // RP floor -- never negative
    winRP: 25,            // baseline win, before the opponent-rating adjustment
    lossRP: 20,           // baseline loss, before the opponent-rating adjustment

    // Opponent-rating adjustment. `eloScale` is the classic Elo 400:
    // a 400 RP gap makes the favourite ~10x more likely to win in the
    // model, which is what drives the reward/punishment skew. The clamps
    // keep a blowout mismatch from ever handing out a silly number.
    eloScale: 400,
    minRPGain: 10,
    maxRPGain: 40,
    minRPLoss: 8,
    maxRPLoss: 32,

    // Placements
    placementGames: 10,
    placementBaseRP: 900,     // RP for a 0-win placement run
    placementPerWinRP: 55,    // added per placement win (10 wins -> 1450)

    // Matchmaking -- the search band widens the longer someone waits, so
    // a lonely Grandmaster eventually gets a game instead of queueing
    // forever.
    matchmaking: {
        baseRange: 100,       // ±RP at t=0
        expandStep: 100,      // widen by this much...
        expandEverySec: 10,   // ...every this many seconds
        maxRange: 5000,       // effectively "anyone" once it gets here
        unrankedRange: 5000,  // placement players match anyone (no rating yet)
        maxQueueSec: 300      // give up and tell the client after 5 min
    },

    // Anti-abuse
    // Two accounts playing each other over and over is the cheapest way
    // to farm RP, so repeated pairings inside this window stop counting.
    repeatOpponent: {
        windowMs: 60 * 60 * 1000, // 1 hour
        maxMatches: 3             // 4th+ match vs the same person in an hour is unrated
    },
    // A ranked match that never reports a result (both clients silently
    // vanish) is abandoned server-side rather than leaking forever.
    matchTimeoutMs: 20 * 60 * 1000,
    // Grace period after a disconnect before it becomes a forfeit -- long
    // enough to survive a blip, short enough that rage-quitting isn't a
    // free escape.
    disconnectForfeitMs: 30 * 1000,

    // Match format -- must match index.html's ROUNDS_TO_WIN. The server
    // counts rounds itself (see server.js), so this is the authoritative
    // copy of "how long is a ranked match".
    roundsToWin: 3,

    // Season rewards. Structure first, content later: adding a reward is
    // adding a row here, and nothing else in the codebase has to change.
    // Cosmetic-only by design -- no stat/power rewards.
    rewards: [
        { minTier: "bronze",      type: "badge", id: "badge_bronze",      name: "Bronze Badge" },
        { minTier: "silver",      type: "badge", id: "badge_silver",      name: "Silver Badge" },
        { minTier: "gold",        type: "badge", id: "badge_gold",        name: "Gold Badge" },
        { minTier: "platinum",    type: "badge", id: "badge_platinum",    name: "Platinum Badge" },
        { minTier: "diamond",     type: "badge", id: "badge_diamond",     name: "Diamond Badge" },
        { minTier: "master",      type: "badge", id: "badge_master",      name: "Master Badge" },
        { minTier: "grandmaster", type: "title", id: "title_grandmaster", name: "Grandmaster" }
    ],

    // Soft reset applied to carry RP into the next season. newRP =
    // startingRP + (oldRP - startingRP) * factor, so everyone converges
    // toward the middle without losing their relative standing.
    seasonSoftResetFactor: 0.5
};

// ---------------------------------------------------------------------
// RANK TIERS
//
// `min` is inclusive, and the list is ordered low -> high. Tiers with
// `divisions: 3` are split into III / II / I across their band (III is
// the LOWEST, I the highest -- the usual convention). Master and
// Grandmaster are single blocks: they're the top of the ladder where RP
// itself is the interesting number, and subdividing an open-ended band
// (Grandmaster has no ceiling) doesn't mean anything.
// ---------------------------------------------------------------------
const RANK_TIERS = [
    { id: "bronze",      name: "Bronze",      min: 0,    max: 999,      divisions: 3, color: "#c87f4a" },
    { id: "silver",      name: "Silver",      min: 1000, max: 1499,     divisions: 3, color: "#b9c4d0" },
    { id: "gold",        name: "Gold",        min: 1500, max: 1999,     divisions: 3, color: "#ffc95c" },
    { id: "platinum",    name: "Platinum",    min: 2000, max: 2499,     divisions: 3, color: "#5ce0d8" },
    { id: "diamond",     name: "Diamond",     min: 2500, max: 2999,     divisions: 3, color: "#6ea8ff" },
    { id: "master",      name: "Master",      min: 3000, max: 3499,     divisions: 1, color: "#c07bff" },
    { id: "grandmaster", name: "Grandmaster", min: 3500, max: Infinity, divisions: 1, color: "#ff5c7a" }
];

const UNRANKED = {
    tier: "unranked",
    tierName: "Unranked",
    division: 0,
    name: "Unranked",
    short: "UNR",
    color: "#7d8b9c",
    index: -1
};

const ROMAN = ["", "I", "II", "III"];

// Every rank as one ordered list, so "did this player go up or down"
// is a single integer comparison rather than a pile of tier/division
// special cases. Built once at load.
const RANK_LADDER = (function () {
    const out = [];
    for (const tier of RANK_TIERS) {
        if (tier.divisions <= 1) {
            out.push({ tier: tier.id, division: 0 });
        } else {
            // Division III is the bottom of the band, I the top.
            for (let d = tier.divisions; d >= 1; d--) out.push({ tier: tier.id, division: d });
        }
    }
    return out;
})();

function ladderIndexOf(tierId, division) {
    for (let i = 0; i < RANK_LADDER.length; i++) {
        if (RANK_LADDER[i].tier === tierId && RANK_LADDER[i].division === division) return i;
    }
    return -1;
}

// ---------------------------------------------------------------------
// getRankFromRP -- THE single place RP becomes a rank. Everything that
// displays, compares or rewards a rank goes through here so there is
// exactly one definition of the thresholds.
//
// Returns a descriptor: { tier, tierName, division, name, short, color,
// index, floor, ceiling }. `index` is the ladder position (comparable
// with < / >), `floor`/`ceiling` bound the current division so the UI
// can draw a progress bar without re-deriving the thresholds.
// ---------------------------------------------------------------------
function getRankFromRP(rp) {
    const value = Math.max(RANKED_CONFIG.minRP, Math.floor(Number(rp) || 0));

    let tier = RANK_TIERS[RANK_TIERS.length - 1];
    for (const t of RANK_TIERS) {
        if (value >= t.min && value <= t.max) { tier = t; break; }
    }

    if (tier.divisions <= 1) {
        return {
            tier: tier.id,
            tierName: tier.name,
            division: 0,
            name: tier.name,
            short: tier.name.slice(0, 2).toUpperCase(),
            color: tier.color,
            index: ladderIndexOf(tier.id, 0),
            floor: tier.min,
            // The top tier is open-ended. JSON.stringify turns Infinity
            // into null anyway, so send an explicit null rather than
            // letting the client receive a value the server never meant.
            ceiling: tier.max === Infinity ? null : tier.max
        };
    }

    // Split the tier's band into equal division slices. Bronze 0-999 with
    // 3 divisions -> III:0-332, II:333-666, I:667-999.
    const span = (tier.max - tier.min + 1) / tier.divisions;
    let slice = Math.floor((value - tier.min) / span);
    if (slice > tier.divisions - 1) slice = tier.divisions - 1;
    const division = tier.divisions - slice; // slice 0 -> III (lowest)

    // floor/ceiling MUST be derived with the same arithmetic the slice
    // itself used, or they disagree at the boundaries: `slice` puts a
    // value in bucket s when s*span <= (v - min) < (s+1)*span, so the
    // bounds are ceil() of those same products, not an independent
    // round() of them (which drifts by one either side of a fractional
    // boundary and reports an RP as being outside its own division).
    return {
        tier: tier.id,
        tierName: tier.name,
        division: division,
        name: tier.name + " " + ROMAN[division],
        short: tier.name.slice(0, 1).toUpperCase() + ROMAN[division],
        color: tier.color,
        index: ladderIndexOf(tier.id, division),
        floor: tier.min + Math.ceil(slice * span),
        ceiling: tier.min + Math.ceil((slice + 1) * span) - 1
    };
}

// Rank descriptor for a whole ranked record -- the only difference from
// getRankFromRP is that a player still in placements has no rank at all
// yet, however much RP they've accumulated behind the scenes.
function getRankForRecord(record) {
    if (!record || !record.placementComplete) return Object.assign({}, UNRANKED);
    return getRankFromRP(record.rp);
}

// ---------------------------------------------------------------------
// calculateRPChange -- the rating maths.
//
// Moderate Elo-style skew around the flat win/loss values: beating
// someone rated above you pays more and losing to them costs less, and
// vice versa. At equal rating it reduces exactly to +winRP / -lossRP.
//
// Returns a NEGATIVE number for a loss. Never applies the RP floor
// itself -- applyMatchResult() does that, so this stays a pure "how big
// is the swing" function.
// ---------------------------------------------------------------------
function calculateRPChange(playerRP, opponentRP, won, config) {
    const cfg = config || RANKED_CONFIG;
    const mine = Number(playerRP) || 0;
    const theirs = Number(opponentRP) || 0;

    // Classic Elo expectation: 0.5 at equal rating, ->1 as you outrate
    // them, ->0 as they outrate you.
    const expected = 1 / (1 + Math.pow(10, (theirs - mine) / cfg.eloScale));

    if (won) {
        // Underdog (low expected) -> bigger multiplier. Equal -> 1.0x.
        const gain = Math.round(cfg.winRP * (0.5 + (1 - expected)));
        return Math.max(cfg.minRPGain, Math.min(cfg.maxRPGain, gain));
    }
    // Losing to a favourite (high expected for THEM = low for me) hurts
    // less. Equal -> 1.0x.
    const loss = Math.round(cfg.lossRP * (0.5 + expected));
    return -Math.max(cfg.minRPLoss, Math.min(cfg.maxRPLoss, loss));
}

// ---------------------------------------------------------------------
// Placement: turn a placement run into a starting rating.
//
// Deliberately performance-based rather than random or fixed: a 10-0 run
// starts materially higher than a 0-10 one. Centralized here so the
// curve can be retuned without touching the match pipeline.
// ---------------------------------------------------------------------
function computePlacementRP(wins, losses, config) {
    const cfg = config || RANKED_CONFIG;
    const w = Math.max(0, Math.floor(Number(wins) || 0));
    const rp = cfg.placementBaseRP + w * cfg.placementPerWinRP;
    return Math.max(cfg.minRP, Math.round(rp));
}

// ---------------------------------------------------------------------
// RECORD SHAPE + MIGRATION
//
// A ranked record is stored on the account under `ranked`. It holds the
// CURRENT season's live numbers plus a `history` map of finished
// seasons, so starting a new season never destroys the old one.
// ---------------------------------------------------------------------
function defaultRankedRecord(config) {
    const cfg = config || RANKED_CONFIG;
    return {
        season: cfg.season,
        rp: 0,                      // meaningless until placementComplete
        wins: 0,
        losses: 0,
        games: 0,
        placementGames: 0,
        placementWins: 0,
        placementLosses: 0,
        placementComplete: false,
        highestRP: 0,
        highestRankIndex: -1,       // ladder index; -1 = never ranked
        lastMatchAt: 0,
        rewards: [],                // earned cosmetic ids for this season
        history: {},                // seasonId -> frozen summary
        recentOpponents: []         // [{sub, at}] -- anti-farm window
    };
}

// Brings ANY account record up to the current ranked shape without ever
// removing or overwriting existing data.
//
// Idempotent and backwards compatible by construction: it only ever
// fills in fields that are missing or the wrong type. Returns the SAME
// object reference when nothing needed changing, so callers can cheaply
// tell whether a write is actually required (`ensured !== account.ranked`
// means "changed").
function ensureRankedRecord(account, config) {
    const cfg = config || RANKED_CONFIG;
    if (!account || typeof account !== "object") return null;

    const existing = account.ranked;
    const base = defaultRankedRecord(cfg);

    // Nothing there at all (or something non-object): brand new record.
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        return base;
    }

    let changed = false;
    const out = {};

    const numKeys = ["rp", "wins", "losses", "games", "placementGames",
        "placementWins", "placementLosses", "highestRP", "highestRankIndex", "lastMatchAt"];
    for (const k of numKeys) {
        const v = existing[k];
        if (typeof v === "number" && isFinite(v)) out[k] = v;
        else { out[k] = base[k]; changed = true; }
    }

    out.placementComplete = typeof existing.placementComplete === "boolean"
        ? existing.placementComplete : (changed = true, base.placementComplete);

    out.season = typeof existing.season === "string" && existing.season
        ? existing.season : (changed = true, base.season);

    out.rewards = Array.isArray(existing.rewards) ? existing.rewards : (changed = true, []);
    out.history = (existing.history && typeof existing.history === "object" && !Array.isArray(existing.history))
        ? existing.history : (changed = true, {});
    out.recentOpponents = Array.isArray(existing.recentOpponents)
        ? existing.recentOpponents : (changed = true, []);

    // Carry through any field a future version added that this one
    // doesn't know about, rather than silently dropping it.
    for (const k of Object.keys(existing)) {
        if (!(k in out)) { out[k] = existing[k]; }
    }

    // A record from a PREVIOUS season gets rolled over here (archive the
    // old numbers, soft-reset into the new season) so it happens exactly
    // once, on first touch, no matter which code path touches it first.
    if (out.season !== cfg.season) {
        return rolloverToSeason(out, cfg);
    }

    return changed ? out : existing;
}

// Freezes the current season into history and starts the next one.
// Never deletes a previous season's entry.
function rolloverToSeason(record, config) {
    const cfg = config || RANKED_CONFIG;
    const out = Object.assign({}, record);

    const history = Object.assign({}, record.history || {});
    // Only archive a season that actually had games -- an untouched
    // record rolling forward shouldn't litter history with empty rows.
    if (record.games > 0 || record.placementGames > 0) {
        history[record.season] = {
            season: record.season,
            rp: record.rp,
            wins: record.wins,
            losses: record.losses,
            games: record.games,
            highestRP: record.highestRP,
            highestRankIndex: record.highestRankIndex,
            placementComplete: record.placementComplete,
            rewards: (record.rewards || []).slice(),
            endedAt: Date.now()
        };
    }

    // Soft reset: keep relative standing, pull everyone toward the middle.
    const softRP = record.placementComplete
        ? Math.max(cfg.minRP, Math.round(
            cfg.startingRP + (record.rp - cfg.startingRP) * cfg.seasonSoftResetFactor))
        : 0;

    out.season = cfg.season;
    out.history = history;
    out.rp = softRP;
    out.wins = 0;
    out.losses = 0;
    out.games = 0;
    // A new season means fresh placements.
    out.placementGames = 0;
    out.placementWins = 0;
    out.placementLosses = 0;
    out.placementComplete = false;
    out.highestRP = 0;
    out.highestRankIndex = -1;
    out.rewards = [];
    out.recentOpponents = [];
    // `seedRP` remembers where the soft reset put them, so placements in
    // the new season can start from their real standing rather than from
    // scratch. Zero for a player who never finished placements.
    out.seedRP = softRP;

    return out;
}

// ---------------------------------------------------------------------
// applyMatchResult -- THE single place a ranked record changes.
//
// Pure: takes the record + context, returns { record, summary } with a
// brand new record object. The caller persists it. Doing it this way
// means the RP floor, placement bookkeeping, promotion detection and
// highest-ever tracking can't drift apart across call sites, because
// there is only one call site's worth of logic.
// ---------------------------------------------------------------------
function applyMatchResult(record, opts, config) {
    const cfg = config || RANKED_CONFIG;
    const won = !!opts.won;
    const opponentRP = Number(opts.opponentRP) || 0;
    const rated = opts.rated !== false; // unrated = counted, but no RP moves

    const before = Object.assign({}, record);
    const out = Object.assign({}, record);

    const rankBefore = getRankForRecord(before);
    const rpBefore = before.rp;

    out.games = (out.games || 0) + 1;
    if (won) out.wins = (out.wins || 0) + 1;
    else out.losses = (out.losses || 0) + 1;
    out.lastMatchAt = Date.now();

    let rpChange = 0;
    let placementJustCompleted = false;

    if (!out.placementComplete) {
        // ---- PLACEMENT MATCH ----
        out.placementGames = (out.placementGames || 0) + 1;
        if (won) out.placementWins = (out.placementWins || 0) + 1;
        else out.placementLosses = (out.placementLosses || 0) + 1;

        if (out.placementGames >= cfg.placementGames) {
            out.placementComplete = true;
            placementJustCompleted = true;
            // A returning player who had a rank last season starts from
            // their soft-reset seed, nudged by how placements went,
            // rather than from the generic base.
            const fromPlacements = computePlacementRP(out.placementWins, out.placementLosses, cfg);
            const seed = Number(out.seedRP) || 0;
            out.rp = seed > 0 ? Math.round((fromPlacements + seed) / 2) : fromPlacements;
            out.rp = Math.max(cfg.minRP, out.rp);
        }
        // RP does not move DURING placements -- the placement result is
        // the rank reveal, so there's nothing to show a delta against.
    } else if (rated) {
        // ---- RATED MATCH ----
        rpChange = calculateRPChange(out.rp, opponentRP, won, cfg);
        out.rp = Math.max(cfg.minRP, out.rp + rpChange);
        // The floor can absorb part of a loss (e.g. -20 at 5 RP only
        // actually costs 5), so report what really happened.
        rpChange = out.rp - rpBefore;
    }

    // Highest-ever tracking, current season.
    if (out.placementComplete) {
        if (out.rp > (out.highestRP || 0)) out.highestRP = out.rp;
        const nowRank = getRankFromRP(out.rp);
        if (nowRank.index > (typeof out.highestRankIndex === "number" ? out.highestRankIndex : -1)) {
            out.highestRankIndex = nowRank.index;
        }
    }

    // Cosmetic season rewards are granted on reaching a tier and never
    // taken back if the player later drops below it.
    if (out.placementComplete) {
        const earned = new Set(out.rewards || []);
        const reachedIndex = out.highestRankIndex;
        for (const reward of cfg.rewards) {
            const tierFirstIndex = ladderIndexOf(reward.minTier,
                (RANK_TIERS.find(t => t.id === reward.minTier) || {}).divisions > 1 ? 3 : 0);
            if (tierFirstIndex >= 0 && reachedIndex >= tierFirstIndex) earned.add(reward.id);
        }
        out.rewards = Array.from(earned);
    }

    const rankAfter = getRankForRecord(out);

    return {
        record: out,
        summary: {
            won: won,
            rated: rated,
            rpChange: rpChange,
            rpBefore: before.placementComplete ? rpBefore : null,
            rpAfter: out.placementComplete ? out.rp : null,
            rankBefore: rankBefore,
            rankAfter: rankAfter,
            promoted: rankAfter.index > rankBefore.index && rankBefore.index >= 0,
            demoted: rankAfter.index < rankBefore.index && rankAfter.index >= 0,
            placementComplete: out.placementComplete,
            placementJustCompleted: placementJustCompleted,
            placementGames: out.placementGames,
            placementWins: out.placementWins,
            placementLosses: out.placementLosses,
            placementTotal: cfg.placementGames,
            wins: out.wins,
            losses: out.losses,
            games: out.games
        }
    };
}

// ---------------------------------------------------------------------
// Anti-farm: has this pair played too many times recently?
//
// Returns true when the match should still be RATED. The window itself
// is pruned by the caller when it records the pairing.
// ---------------------------------------------------------------------
function isPairingRated(record, opponentSub, config) {
    const cfg = config || RANKED_CONFIG;
    const list = Array.isArray(record.recentOpponents) ? record.recentOpponents : [];
    const cutoff = Date.now() - cfg.repeatOpponent.windowMs;
    let count = 0;
    for (const row of list) {
        if (row && row.sub === opponentSub && row.at > cutoff) count++;
    }
    return count < cfg.repeatOpponent.maxMatches;
}

// Records a pairing and prunes anything outside the window. Pure --
// returns a new array.
function recordPairing(record, opponentSub, config) {
    const cfg = config || RANKED_CONFIG;
    const cutoff = Date.now() - cfg.repeatOpponent.windowMs;
    const list = (Array.isArray(record.recentOpponents) ? record.recentOpponents : [])
        .filter(row => row && typeof row.at === "number" && row.at > cutoff);
    list.push({ sub: opponentSub, at: Date.now() });
    // Hard cap so a very busy account can't grow this unbounded.
    return list.slice(-40);
}

// ---------------------------------------------------------------------
// Matchmaking band for a player who has been waiting `waitedSec`.
// ---------------------------------------------------------------------
function matchmakingRange(record, waitedSec, config) {
    const cfg = (config || RANKED_CONFIG).matchmaking;
    // No rating yet -> no meaningful band to search in.
    if (!record.placementComplete) return cfg.unrankedRange;
    const steps = Math.floor(Math.max(0, waitedSec) / cfg.expandEverySec);
    return Math.min(cfg.maxRange, cfg.baseRange + steps * cfg.expandStep);
}

// Are these two acceptable opponents for each other right now? Both
// bands have to accept -- a 10-second waiter shouldn't be dragged into a
// blowout just because the other player has been waiting 4 minutes.
function isAcceptableMatch(a, b, aWaitedSec, bWaitedSec, config) {
    const cfg = config || RANKED_CONFIG;
    // An unranked player has no rating to compare, so any pairing is fine.
    if (!a.record.placementComplete || !b.record.placementComplete) return true;
    const gap = Math.abs(a.record.rp - b.record.rp);
    return gap <= matchmakingRange(a.record, aWaitedSec, cfg)
        && gap <= matchmakingRange(b.record, bWaitedSec, cfg);
}

// ---------------------------------------------------------------------
// Public view of a ranked record -- what the client is allowed to see.
// Never includes recentOpponents (that's another player's identity) and
// never touches the rest of the account (email in particular).
// ---------------------------------------------------------------------
function publicRankedView(account, config) {
    const cfg = config || RANKED_CONFIG;
    const record = ensureRankedRecord(account, cfg) || defaultRankedRecord(cfg);
    const rank = getRankForRecord(record);
    const games = record.games || 0;
    const highestRank = record.highestRankIndex >= 0 && RANK_LADDER[record.highestRankIndex]
        ? rankDescriptorFromLadder(record.highestRankIndex)
        : null;

    return {
        season: record.season,
        seasonName: cfg.seasonName,
        rp: record.placementComplete ? record.rp : null,
        rank: rank,
        wins: record.wins || 0,
        losses: record.losses || 0,
        games: games,
        winRate: games > 0 ? Math.round((record.wins || 0) / games * 1000) / 10 : 0,
        highestRP: record.highestRP || 0,
        highestRank: highestRank,
        placementComplete: !!record.placementComplete,
        placementGames: record.placementGames || 0,
        placementWins: record.placementWins || 0,
        placementLosses: record.placementLosses || 0,
        placementTotal: cfg.placementGames,
        rewards: (record.rewards || []).slice(),
        history: Object.keys(record.history || {}).map(k => {
            const h = record.history[k];
            return {
                season: h.season,
                rp: h.rp,
                wins: h.wins,
                losses: h.losses,
                games: h.games,
                highestRP: h.highestRP,
                highestRank: h.highestRankIndex >= 0 ? rankDescriptorFromLadder(h.highestRankIndex) : null
            };
        })
    };
}

// A rank descriptor built from a ladder index (used for "highest rank
// ever", which is stored as an index rather than an RP value).
function rankDescriptorFromLadder(index) {
    const row = RANK_LADDER[index];
    if (!row) return Object.assign({}, UNRANKED);
    const tier = RANK_TIERS.find(t => t.id === row.tier);
    if (!tier) return Object.assign({}, UNRANKED);
    const name = row.division > 0 ? tier.name + " " + ROMAN[row.division] : tier.name;
    return {
        tier: tier.id,
        tierName: tier.name,
        division: row.division,
        name: name,
        short: row.division > 0 ? tier.name.slice(0, 1).toUpperCase() + ROMAN[row.division] : tier.name.slice(0, 2).toUpperCase(),
        color: tier.color,
        index: index
    };
}

module.exports = {
    RANKED_CONFIG,
    RANK_TIERS,
    RANK_LADDER,
    UNRANKED,
    getRankFromRP,
    getRankForRecord,
    rankDescriptorFromLadder,
    ladderIndexOf,
    calculateRPChange,
    computePlacementRP,
    defaultRankedRecord,
    ensureRankedRecord,
    rolloverToSeason,
    applyMatchResult,
    isPairingRated,
    recordPairing,
    matchmakingRange,
    isAcceptableMatch,
    publicRankedView
};
