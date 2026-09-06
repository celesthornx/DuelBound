// =====================================================================
// BATTLE PASS -- season config, the 50-tier reward table, and the pure
// helpers that turn a Battle-Pass-XP total into a tier/claim state.
//
// Mirrors catalog.js and ranked.js on purpose:
//   * pure module -- no sockets, no storage, no HTTP. server.js owns the
//     account records and does the actual crediting/persisting.
//   * this file is the single source of truth for what a tier's reward
//     IS (type, amount/id, display name, rarity) -- server.js validates
//     every claim against it, never against anything the client sent,
//     the same way catalog.js is the price authority for /shop/buy.
//   * the client fetches this table from GET /battlepass/config rather
//     than keeping a second hand-maintained copy (unlike SKINS/POWERS/
//     ABILITIES, which predate that lesson -- see catalog.js's own
//     comment about that tech debt). Only the handful of new skins'
//     render data (color/gradient/deco) lives in index.html, because
//     drawing a skin is an inherently client-side concern.
//
// SEASON ARCHITECTURE
// -------------------
// A season is just a plain object (id, name, startedAt, endsAt) --
// server.js persists the ACTIVE one via store.saveDoc("battlePassSeason",
// ...) the same way RANKED_CONFIG's season survives a restart. Starting
// a new season (POST /admin/battlepass action:startSeason) never deletes
// a cosmetic anyone already earned -- those live permanently in the
// account's owned-item arrays (ownedSkins, ownedBanners, ...), completely
// separate from the season's xp/tier/claimed progress, which IS reset.
// A future season is just a new TIERS table plus a new season id; the
// code below never assumes there is exactly one season forever.
// =====================================================================

const PASS_PRICE_CRYSTALS = 499;
const TIER_COUNT = 50;
const XP_PER_TIER = 1000; // flat -- tier N is reached at N * 1000 lifetime Battle Pass XP
const TOTAL_SEASON_XP = TIER_COUNT * XP_PER_TIER;

// Bonus Battle Pass XP granted the moment a Daily Challenge is claimed
// (see /challenges/claim in server.js) -- Daily Challenges don't run
// through awardXP (they only ever paid Coins), so without this a
// Battle-Pass-only source of progress would go completely unrewarded
// even though the spec calls out Daily Challenges as a source of BP
// progress. Three challenges/day * 150 = 450 BP XP/day just from
// dailies, before a single match is played.
const DAILY_CHALLENGE_BONUS_XP = 150;

// "XP Boost" reward: grants one consumable charge. Activating a charge
// (POST /battlepass/useboost) doubles Battle-Pass-XP-only gains (never
// account XP/Coins/Crystals -- this is a pass-progression consumable,
// not a stat) for a fixed window. Never stacks -- activating while a
// boost is already running is rejected, so a charge can't be wasted by
// accident, but also can't be used to stack multipliers.
const BOOST_DURATION_MS = 60 * 60 * 1000; // 1 hour
const BOOST_MULTIPLIER = 2;

const DEFAULT_SEASON = {
    id: "S1",
    name: "NEON PROTOCOL",
    // Real wall-clock bounds so the client can show a real countdown.
    // Both are persisted (see server.js loading "battlePassSeason" at
    // boot) so a restart never resets the clock.
    startedAt: Date.parse("2026-09-01T00:00:00Z"),
    endsAt: Date.parse("2026-10-13T00:00:00Z") // 42 days -- a typical season length
};

// ---------------------------------------------------------------------
// Reward helpers. Every tier's free/premium value is ALWAYS an array of
// reward parts (most tiers have exactly one; Tier 50 Premium bundles the
// Mythic skin with a Crystal payout) so server.js's grant loop never
// needs a special case for "is this one reward or several".
// ---------------------------------------------------------------------
const coins = (amount) => ({ type: "coins", amount });
const crystals = (amount) => ({ type: "crystals", amount });
const xpBoost = () => ({ type: "xp_boost", amount: 1, name: "XP Boost", rarity: "common" });
const skin = (id, name, rarity) => ({ type: "skin", id, name, rarity });
const banner = (id, name, rarity) => ({ type: "banner", id, name, rarity });
const icon = (id, name, rarity) => ({ type: "player_icon", id, name, rarity });
const emote = (id, name, rarity) => ({ type: "emote", id, name, rarity });
const killfx = (id, name, rarity) => ({ type: "kill_effect", id, name, rarity });
const abilityCosmetic = (id, name, rarity) => ({ type: "ability_cosmetic", id, name, rarity });
const badge = (id, name, rarity) => ({ type: "badge", id, name, rarity });

// ---------------------------------------------------------------------
// THE 50-TIER TABLE -- matches the season spec exactly. Every reward
// with a stable id (skins/banners/icons/emotes/kill effects/ability
// cosmetics/badges) is unique to this season's namespace ("bp_s1_...")
// so a future season's own new cosmetics can never collide with these,
// and anyone who owns one keeps it forever once granted.
// ---------------------------------------------------------------------
const TIERS = [
    { tier: 1, free: [coins(100)], premium: [skin("bp_s1_starter", "VANGUARD STARTER", "common")] },
    { tier: 2, free: [crystals(25)], premium: [coins(150)] },
    { tier: 3, free: [coins(150)], premium: [crystals(25)] },
    { tier: 4, free: [xpBoost()], premium: [coins(250)] },
    { tier: 5, free: [banner("bp_s1_banner_signal", "SIGNAL CORPS", "common")], premium: [banner("bp_s1_banner_vanguard", "VANGUARD", "rare")] },
    { tier: 6, free: [crystals(25)], premium: [crystals(50)] },
    { tier: 7, free: [coins(250)], premium: [coins(300)] },
    { tier: 8, free: [abilityCosmetic("bp_s1_trail_ember", "EMBER TRAIL", "common")], premium: [emote("bp_s1_emote_taunt", "OVERCLOCK TAUNT", "common")] },
    { tier: 9, free: [coins(300)], premium: [crystals(50)] },
    { tier: 10, free: [skin("bp_s1_free10", "SIGNAL FLARE", "common")], premium: [skin("bp_s1_prem10", "AURORA STRIKE", "rare")] },
    { tier: 11, free: [crystals(25)], premium: [coins(400)] },
    { tier: 12, free: [coins(350)], premium: [xpBoost()] },
    { tier: 13, free: [xpBoost()], premium: [crystals(50)] },
    { tier: 14, free: [abilityCosmetic("bp_s1_trail_frost", "FROST TRAIL", "rare")], premium: [killfx("bp_s1_kill_sparkburst", "SPARK BURST", "rare")] },
    { tier: 15, free: [crystals(25)], premium: [coins(500)] },
    { tier: 16, free: [icon("bp_s1_icon_recruit", "RECRUIT SIGIL", "common")], premium: [emote("bp_s1_emote_salute", "SALUTE", "common")] },
    { tier: 17, free: [coins(450)], premium: [crystals(50)] },
    { tier: 18, free: [xpBoost()], premium: [coins(600)] },
    { tier: 19, free: [crystals(25)], premium: [banner("bp_s1_banner_eclipse", "ECLIPSE DIVISION", "rare")] },
    { tier: 20, free: [skin("bp_s1_free20", "RUSTBACK RUNNER", "rare")], premium: [skin("bp_s1_prem20", "PRISM BREAKER", "epic")] },
    { tier: 21, free: [crystals(25)], premium: [crystals(75)] },
    { tier: 22, free: [coins(550)], premium: [xpBoost()] },
    { tier: 23, free: [abilityCosmetic("bp_s1_trail_toxic", "TOXIC TRAIL", "rare")], premium: [coins(700)] },
    { tier: 24, free: [crystals(25)], premium: [emote("bp_s1_emote_gg", "GG WAVE", "rare")] },
    { tier: 25, free: [badge("bp_s1_badge_bronze", "SEASON BADGE: BRONZE", "common")], premium: [banner("bp_s1_banner_apex", "APEX COMMAND", "epic")] },
    { tier: 26, free: [coins(600)], premium: [crystals(75)] },
    { tier: 27, free: [xpBoost()], premium: [coins(800)] },
    { tier: 28, free: [crystals(25)], premium: [killfx("bp_s1_kill_novaburst", "NOVA BURST", "epic")] },
    { tier: 29, free: [coins(700)], premium: [crystals(100)] },
    { tier: 30, free: [skin("bp_s1_free30", "IRON WAKE", "rare")], premium: [skin("bp_s1_prem30", "SOLAR FLARE", "epic")] },
    { tier: 31, free: [crystals(25)], premium: [coins(900)] },
    { tier: 32, free: [xpBoost()], premium: [emote("bp_s1_emote_flex", "SYSTEM FLEX", "rare")] },
    { tier: 33, free: [coins(750)], premium: [crystals(100)] },
    { tier: 34, free: [abilityCosmetic("bp_s1_trail_volt", "VOLT TRAIL", "epic")], premium: [icon("bp_s1_icon_operative", "OPERATIVE SIGIL", "rare")] },
    { tier: 35, free: [crystals(25)], premium: [coins(1000)] },
    { tier: 36, free: [badge("bp_s1_badge_silver", "SEASON BADGE: SILVER", "rare")], premium: [banner("bp_s1_banner_storm", "STORMFRONT", "rare")] },
    { tier: 37, free: [coins(800)], premium: [crystals(100)] },
    { tier: 38, free: [xpBoost()], premium: [killfx("bp_s1_kill_voidrend", "VOID REND", "legendary")] },
    { tier: 39, free: [crystals(25)], premium: [coins(1100)] },
    { tier: 40, free: [skin("bp_s1_free40", "GHOSTLINE", "epic")], premium: [skin("bp_s1_prem40", "VOID SOVEREIGN", "legendary")] },
    { tier: 41, free: [coins(900)], premium: [crystals(100)] },
    { tier: 42, free: [abilityCosmetic("bp_s1_trail_shadow", "SHADOW TRAIL", "epic")], premium: [emote("bp_s1_emote_laugh", "STATIC LAUGH", "rare")] },
    { tier: 43, free: [crystals(25)], premium: [coins(1200)] },
    { tier: 44, free: [xpBoost()], premium: [crystals(125)] },
    { tier: 45, free: [badge("bp_s1_badge_gold", "SEASON BADGE: GOLD", "epic")], premium: [icon("bp_s1_icon_commander", "COMMANDER SIGIL", "epic")] },
    { tier: 46, free: [coins(1000)], premium: [crystals(125)] },
    { tier: 47, free: [crystals(50)], premium: [banner("bp_s1_banner_exclusive", "EXCLUSIVE: VOID HERALD", "legendary")] },
    { tier: 48, free: [coins(1500)], premium: [crystals(150)] },
    { tier: 49, free: [icon("bp_s1_icon_exclusive_free", "FREE OPERATIVE SIGIL", "epic")], premium: [emote("bp_s1_emote_exclusive", "EXCLUSIVE: GLITCH BOW", "legendary")] },
    {
        tier: 50,
        free: [badge("bp_s1_badge_finale", "SEASON FINALE BADGE", "legendary")],
        premium: [skin("bp_s1_mythic", "ASCENDANT ZERO", "mythic"), crystals(200)]
    }
];

const TIERS_BY_NUMBER = {};
TIERS.forEach(t => { TIERS_BY_NUMBER[t.tier] = t; });

// The account field each granted cosmetic type's ownership lives in --
// mirrors catalog.js's OWNED_FIELD mapping so grantReward()/every
// "does this account already own X" check has one place to look this
// up, for every non-currency reward type.
const OWNED_FIELD = {
    skin: "ownedSkins",
    banner: "ownedBanners",
    player_icon: "ownedPlayerIcons",
    emote: "ownedEmotes",
    kill_effect: "ownedKillEffects",
    ability_cosmetic: "ownedAbilityCosmetics",
    badge: "ownedBadges"
};

function tierDef(tierNumber) {
    return TIERS_BY_NUMBER[tierNumber] || null;
}

// Cumulative BP XP needed to REACH a given tier (tier 0 = 0 XP).
function xpForTier(tierNumber) {
    return Math.max(0, Math.min(TIER_COUNT, tierNumber)) * XP_PER_TIER;
}

// Pure: derives {tier, xpIntoTier, xpForNextTier} from a lifetime BP XP
// total. Never goes above TIER_COUNT -- XP earned past the final tier
// still accumulates (so a maxed-out player's bar doesn't look broken)
// but the tier itself is clamped.
function tierFromXP(totalXp) {
    const xp = Math.max(0, Math.floor(totalXp) || 0);
    const tier = Math.min(TIER_COUNT, Math.floor(xp / XP_PER_TIER));
    const xpIntoTier = tier >= TIER_COUNT ? xp - xpForTier(TIER_COUNT) : xp % XP_PER_TIER;
    const xpForNextTier = tier >= TIER_COUNT ? 0 : XP_PER_TIER;
    return { tier, xpIntoTier, xpForNextTier };
}

function defaultRecord() {
    return {
        seasonId: DEFAULT_SEASON.id,
        xp: 0,
        premium: false,
        claimedFree: {},
        claimedPremium: {},
        boostCharges: 0,
        boostActiveUntil: 0
    };
}

// Brings a stored battlePass sub-record up to a valid shape for the
// CURRENTLY active season, exactly like ensureDailyChallenges rolls a
// stale date forward. If the stored record is for an earlier season (an
// admin started a new one), progress/claims reset to zero for the new
// season -- but this function never touches owned-item arrays, so every
// cosmetic already granted last season stays owned permanently. Returns
// the SAME reference when nothing needed to change.
function ensureRecord(stored, activeSeasonId) {
    if (stored && typeof stored === "object" &&
        stored.seasonId === activeSeasonId &&
        typeof stored.xp === "number" && isFinite(stored.xp) && stored.xp >= 0 &&
        typeof stored.claimedFree === "object" && stored.claimedFree &&
        typeof stored.claimedPremium === "object" && stored.claimedPremium) {
        return stored;
    }
    const fresh = defaultRecord();
    fresh.seasonId = activeSeasonId;
    return fresh;
}

function isValidTrack(track) {
    return track === "free" || track === "premium";
}

module.exports = {
    PASS_PRICE_CRYSTALS,
    TIER_COUNT,
    XP_PER_TIER,
    TOTAL_SEASON_XP,
    DAILY_CHALLENGE_BONUS_XP,
    BOOST_DURATION_MS,
    BOOST_MULTIPLIER,
    DEFAULT_SEASON,
    TIERS,
    OWNED_FIELD,
    tierDef,
    xpForTier,
    tierFromXP,
    defaultRecord,
    ensureRecord,
    isValidTrack
};
