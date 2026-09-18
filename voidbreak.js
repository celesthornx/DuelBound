// =====================================================================
// VOIDBREAK CLOUD SAVE -- account-side persistence for the Voidbreak
// minigame (see voidbreak.html).
//
// Why this exists
// ----------------
// Voidbreak has always been a fully self-contained document loaded into
// its own iframe (see index.html's launchVoidbreak()), with its own
// progression (Void Shards, Forge upgrades, weapon unlocks, beaten
// levels) saved ONLY to that browser's localStorage under
// "voidbreak_save_v1" -- completely independent of the signed-in
// Google/password account. That's the entire bug: progress was tied to
// the DEVICE, not the account, so it never followed a player to a
// second device and never went away on logout (localStorage doesn't
// care who's signed in).
//
// This module is the server-side half of the fix -- the same role
// catalog.js/battlepass.js play for their own systems: a pure module
// (no sockets, no storage, no HTTP) that defines the shape of a
// Voidbreak save and the two things server.js needs to treat it
// correctly:
//   * sanitizeSaveData(raw) -- turns an arbitrary client-reported blob
//     into a safe, correctly-shaped save (or null if the input isn't
//     even the right shape). This is the SAME trust tier Daily
//     Challenges' progress and /save's kills/wins already sit at in
//     this codebase (client-reported, casual-mode, no server-side game
//     simulation to check it against) -- see server.js's big comment
//     above DAILY_CHALLENGE_POOL for why that's an accepted, existing
//     tradeoff here, not a new one. What this DOES defend against is a
//     corrupt/malicious payload wrecking the stored account record:
//     wrong types, unknown keys, and absurd numeric values are all
//     clamped or dropped.
//   * mergeSaveData(a, b) -- a safe, non-destructive, never-duplicating
//     merge for the one moment two saves can legitimately disagree: a
//     device with pre-existing local/offline progress reconnecting to
//     an account that already has its own cloud save. Every field is
//     either MAX'd or OR'd, never summed -- summing two independently
//     -grown shard counts would let a player farm shards twice (once
//     per device) and then "merge" them into double the total; MAX
//     can't do that because it only ever keeps the higher of two
//     honestly-earned totals, never invents a third number.
// =====================================================================

// The universe content layer (galaxies, systems, discoveries, planet
// buildings, ship systems). Shared verbatim with the client -- see the
// header of voidbreakUniverse.js for why that one is shared rather than
// mirrored the way DEF_SAVE below is.
const Universe = require("./voidbreakUniverse");

// The exact shape voidbreak.html's own `DEF_SAVE` uses -- kept in sync
// with it deliberately (this file does not invent a new progression
// model, it only re-describes the existing one so the server can
// validate it). `settings` (volume/music/sfx/shake/dmgnum) is NOT part
// of the cloud save on purpose: it's a per-device audio/UX preference,
// not account progression, so it stays local-only in voidbreak.html
// exactly as it already was.
const DEF_SAVE = {
    shards: 0,
    forge: { vit: 0, pow: 0, swift: 0, core: 0, drive: 0, edge: 0 },
    weapons: { pulse: true, scatter: false, rail: false, plasma: false, voidb: false, voidc: false },
    lastWeapon: "pulse",

    // ---- VOID LOADOUT ----
    // What the player flies with, chosen once and kept. Purely a
    // PREFERENCE, exactly like lastWeapon above: it decides which of the
    // player's already-earned options is equipped, never what they are
    // allowed to have. Which secondaries and abilities exist at all is
    // gated by universe progress (systems cleared / guardians beaten),
    // which is separate, already-validated save state -- so there is no
    // new ownership list here for a client to lie about, and an
    // unavailable id simply falls back to the default at use time.
    loadout: { primary: "pulse", secondary: "missile", ability: "overdrive" },

    runs: 0,
    best: 0,
    kills: 0,
    beaten: {},

    // ---- ENDGAME FIELDS (added by the Void Shard Shop / Weapon Mastery
    // / Void Prestige systems) ----
    //
    // SERVER-OWNED vs CLIENT-REPORTED is the critical distinction here,
    // and it's what makes the shop/prestige genuinely enforceable even
    // though Voidbreak itself is a client-simulated game:
    //
    //   * CLIENT-REPORTED (same existing trust tier as `shards`/`kills`
    //     -- sanitized and clamped, but not simulated server-side):
    //     `mastery` XP. There is no server-side game to check "did you
    //     really kill 40 enemies with the railgun" against, exactly as
    //     there never was for shards. sanitizeSaveData clamps it and
    //     applyClientSave() additionally rate-limits how fast it may
    //     grow per save, so it can't be inflated arbitrarily in one shot.
    //
    //   * SERVER-OWNED (a client literally cannot write these -- every
    //     one is stripped from any incoming /voidbreak/save payload and
    //     carried forward from the stored record instead; they change
    //     ONLY through the dedicated transactional endpoints):
    //     `shardsSpent`, `shopOwned`, `equipped`, `masteryClaimed`,
    //     `prestige`. So prices, ownership, reward claims and prestige
    //     state are decided by this module against the STORED record,
    //     never by anything the client asserts.
    //
    // `shardsSpent` is a monotonic ledger rather than a mutable balance
    // on purpose. Spendable balance is derived as (shards - shardsSpent).
    // `shards` is MAX-merged (it can only ever rise), and `shardsSpent`
    // is likewise MAX-merged and only ever incremented server-side, so
    // re-POSTing an older save can never "un-spend" a purchase or hand
    // back a refund -- which a plain mutable balance under a MAX merge
    // absolutely would (the higher, pre-purchase number would win, and
    // every item would be free).
    shardsSpent: 0,
    shopOwned: [],
    equipped: { skin: "", trail: "", hit: "", kill: "", theme: "", title: "", badge: "" },
    equippedWeaponSkins: {}, // { weaponKey: itemId }
    mastery: {},         // { weaponKey: xp }
    masteryClaimed: [],  // ["rail:4", ...] -- one entry per claimed mastery level
    prestige: { level: 0, history: [] },

    // ---- UNIVERSE FIELDS (Galaxy Map / Solar Systems / Discovery /
    // Ship Progression / Home Planet) ----
    //
    // One nested block rather than a dozen new top-level keys, because
    // every function in this file that touches a save (sanitize, merge,
    // conflict-resolve, prestige) then has exactly ONE new thing to
    // handle instead of twelve, and a future galaxy adds content to
    // voidbreakUniverse.js without adding a field here at all.
    //
    // The same SERVER-OWNED vs CLIENT-REPORTED split the endgame fields
    // use applies, and for the same reasons:
    //
    //   * CLIENT-REPORTED (sanitized, clamped, monotonic-merged, but not
    //     simulated server-side -- identical trust tier to `shards`,
    //     `kills` and `beaten`, which have always been reported this
    //     way): `galaxy`, `systems`, `discovered`, `drive`, `ship`,
    //     `coins`. These are the outcome of playing the game, and there
    //     is no server-side Voidbreak to check them against.
    //
    //   * SERVER-OWNED (stripped from every incoming save and carried
    //     forward from the stored record; writable only by the
    //     dedicated transactional endpoint /voidbreak/planet/build):
    //     `coinsSpent` and `planet`. Construction SPENDS a currency, so
    //     it gets the same treatment the Void Shard Shop gets -- the
    //     client sends a plot index and a building id, and this module
    //     decides against the STORED record whether that is affordable
    //     and allowed.
    //
    // `coinsSpent` is a monotonic ledger for exactly the reason
    // `shardsSpent` is one: `coins` is MAX-merged, so a mutable balance
    // would let a stale save "win" the merge and refund every building
    // the player ever placed. Spendable = coins - coinsSpent, floored.
    universe: {
        galaxy: 1,       // which galaxy the player is currently in
        systems: {},     // { "1:3": 1 } -- cleared systems, keyed galaxy:system
        discovered: {},  // { "1:3": ["g1s3_star", ...] } -- sites found
        drive: {},       // { "1": 5 } -- Galaxy Drive pieces held, per galaxy
        ship: {},        // { hull: 2, engine: 1, ... } -- ship part levels
        coins: 0,        // lifetime coins earned (planet construction currency)
        coinsSpent: 0,   // SERVER-OWNED monotonic spend ledger
        planet: {        // SERVER-OWNED colony state
            buildings: {},   // { "17": { id: "command", level: 2 } } -- keyed by plot index
            decorations: {}  // { "23": { id: "dec_monolith" } }
        }
    }
};

const FORGE_KEYS = Object.keys(DEF_SAVE.forge);
const WEAPON_KEYS = Object.keys(DEF_SAVE.weapons);
const EQUIP_SLOTS = Object.keys(DEF_SAVE.equipped);

// The closed sets the Void Loadout's two non-weapon slots are validated
// against. Kept in sync with voidbreak.html's SECONDARIES/VB_ABILITIES
// by hand, exactly as DEF_SAVE itself is kept in sync with that file's
// own DEF_SAVE -- this module re-describes the shape the client owns, it
// does not invent a second one. Only the IDS live here: what each does,
// what it costs in energy and when it unlocks are gameplay, and gameplay
// is the client's, same as the WEAPONS table has always been.
const SECONDARY_IDS = ["none", "missile", "drone", "barrier"];
const ABILITY_IDS = ["none", "overdrive", "mark", "blink"];

// =====================================================================
// VOID SHARD SHOP -- catalog
//
// This is the ONLY place prices and unlock rules live. The client is
// sent this catalog to render (GET /voidbreak/state) and sends back
// only an item id to buy; it never sends a price, a rarity or an
// ownership claim, and nothing it sends is used to compute cost.
//
// PRICING is calibrated against the measured Voidbreak economy rather
// than guessed: a full level clear pays ~686 shards at Level 1 rising
// to ~1500 at Level 8 on Normal (x1.5 Hard, x2.0 Extreme), and the
// pre-existing sinks (all 5 buyable weapons + every Forge upgrade)
// total 6805 shards -- i.e. the whole original progression is finished
// in roughly 7-9 clears, after which shards had no use at all.
//
// Individual prices are what a player actually feels, and they're set
// against that income: a common is ~1 Level-1 clear, an epic ~1 clear
// of a mid level, a legendary ~1.5 Level-8 clears. Nothing is priced
// out of reach of a mid-game player. The catalog TOTAL (61 items,
// 90,900 shards) is deliberately a long tail rather than a checklist to
// finish in an evening -- and roughly half of it is mythic tier that
// can't be bought with shards alone at all, being gated behind mastery
// 10 or a prestige level, so shard income is never the only thing
// standing between a player and the best-looking items.
//
// Every cosmetic is PURELY visual -- no item changes damage, health,
// speed, cooldowns, hitboxes or any other combat value. That's enforced
// structurally: an item carries only render parameters (colors), and
// the client applies them only in drawing code.
// =====================================================================
const PRICES = { common: 250, rare: 600, epic: 1200, legendary: 2200, mythic: 2800 };

function item(id, name, cat, rarity, extra) {
    const it = { id: id, name: name, cat: cat, rarity: rarity, price: PRICES[rarity] };
    return Object.assign(it, extra || {});
}

// `req` on an item is an UNLOCK GATE, checked server-side at purchase
// time on top of the price: { mastery: {weapon, level} } or
// { prestige: n }. A gated item is visible but unbuyable until earned,
// which is what ties the three systems into one loop (mastery and
// prestige unlock shop categories the shop alone can never sell).
const COSMETICS = [
    // ---- CHARACTER SKINS (player ship hull + thruster color) ----
    item("skin_cyan", "STANDARD ISSUE", "skin", "common", { hull: [0, 240, 255], glow: [0, 240, 255] }),
    item("skin_ember", "EMBER DRIVE", "skin", "common", { hull: [255, 140, 60], glow: [255, 90, 40] }),
    item("skin_venom", "VENOM CELL", "skin", "rare", { hull: [120, 255, 120], glow: [60, 255, 140] }),
    item("skin_amethyst", "AMETHYST CORE", "skin", "rare", { hull: [190, 120, 255], glow: [160, 92, 255] }),
    item("skin_crimson", "CRIMSON EDICT", "skin", "epic", { hull: [255, 70, 100], glow: [255, 45, 85] }),
    item("skin_abyss", "ABYSSAL DRIFT", "skin", "epic", { hull: [70, 110, 255], glow: [40, 80, 255] }),
    item("skin_gold", "GILDED VANGUARD", "skin", "legendary", { hull: [255, 215, 130], glow: [255, 201, 92] }),
    item("skin_void", "VOIDWALKER", "skin", "legendary", { hull: [230, 230, 255], glow: [190, 130, 255] }),
    item("skin_tuff", "TUFF", "skin", "legendary", { hull: [72, 78, 92], glow: [190, 70, 255] }),
    item("skin_prestige", "ASCENDANT", "skin", "mythic", { hull: [255, 255, 255], glow: [255, 201, 92], req: { prestige: 1 } }),

    // ---- WEAPON SKINS (per-weapon projectile/UI color) ----
    item("wsk_pulse_frost", "PULSE · FROSTLINE", "weaponSkin", "rare", { weapon: "pulse", color: [150, 235, 255] }),
    item("wsk_pulse_mastery", "PULSE · MASTERWORK", "weaponSkin", "mythic", { weapon: "pulse", color: [255, 230, 150], req: { mastery: { weapon: "pulse", level: 10 } } }),
    item("wsk_scatter_ember", "SCATTER · EMBERSHOT", "weaponSkin", "rare", { weapon: "scatter", color: [255, 120, 40] }),
    item("wsk_scatter_mastery", "SCATTER · MASTERWORK", "weaponSkin", "mythic", { weapon: "scatter", color: [255, 230, 150], req: { mastery: { weapon: "scatter", level: 10 } } }),
    item("wsk_rail_null", "RAIL · NULLBEAM", "weaponSkin", "epic", { weapon: "rail", color: [120, 255, 220] }),
    item("wsk_rail_mastery", "RAIL · MASTERWORK", "weaponSkin", "mythic", { weapon: "rail", color: [255, 230, 150], req: { mastery: { weapon: "rail", level: 10 } } }),
    item("wsk_plasma_solar", "PLASMA · SOLAR", "weaponSkin", "epic", { weapon: "plasma", color: [255, 200, 90] }),
    item("wsk_plasma_mastery", "PLASMA · MASTERWORK", "weaponSkin", "mythic", { weapon: "plasma", color: [255, 230, 150], req: { mastery: { weapon: "plasma", level: 10 } } }),
    item("wsk_voidb_rose", "BLADE · ROSEVOID", "weaponSkin", "epic", { weapon: "voidb", color: [255, 120, 200] }),
    item("wsk_voidb_mastery", "BLADE · MASTERWORK", "weaponSkin", "mythic", { weapon: "voidb", color: [255, 230, 150], req: { mastery: { weapon: "voidb", level: 10 } } }),
    item("wsk_voidc_eclipse", "CANNON · ECLIPSE", "weaponSkin", "legendary", { weapon: "voidc", color: [170, 90, 255] }),
    item("wsk_voidc_mastery", "CANNON · MASTERWORK", "weaponSkin", "mythic", { weapon: "voidc", color: [255, 230, 150], req: { mastery: { weapon: "voidc", level: 10 } } }),

    // ---- PROJECTILE TRAILS ----
    item("trail_none", "NO TRAIL", "trail", "common", { color: null }),
    item("trail_spark", "SPARKLINE", "trail", "common", { color: [255, 220, 150] }),
    item("trail_void", "VOID WAKE", "trail", "rare", { color: [160, 92, 255] }),
    item("trail_toxic", "TOXIC WAKE", "trail", "rare", { color: [120, 255, 140] }),
    item("trail_inferno", "INFERNO WAKE", "trail", "epic", { color: [255, 110, 50] }),
    item("trail_astral", "ASTRAL WAKE", "trail", "legendary", { color: [255, 255, 255] }),
    item("trail_mastery", "MASTER'S WAKE", "trail", "mythic", { color: [255, 201, 92], req: { mastery: { weapon: "any", level: 8 } } }),
    item("trail_prestige", "PRESTIGE WAKE", "trail", "mythic", { color: [255, 120, 255], req: { prestige: 2 } }),

    // ---- HIT EFFECTS (impact spark color) ----
    item("hit_default", "STANDARD IMPACT", "hit", "common", { color: [255, 255, 255] }),
    item("hit_gold", "GILDED IMPACT", "hit", "rare", { color: [255, 201, 92] }),
    item("hit_plasma", "PLASMA BURST", "hit", "rare", { color: [120, 200, 255] }),
    item("hit_venom", "VENOM BURST", "hit", "epic", { color: [110, 255, 160] }),
    item("hit_void", "VOID RUPTURE", "hit", "legendary", { color: [190, 110, 255] }),
    item("hit_prestige", "ASCENDANT RUPTURE", "hit", "mythic", { color: [255, 240, 200], req: { prestige: 3 } }),

    // ---- KILL EFFECTS (enemy death burst color) ----
    // Recolors killEnemy()'s deathFX -- the sparks/ring/glow burst an
    // enemy leaves behind -- exactly like `hit` recolors the impact
    // spark. Purely the burst's color and (via the item's own rarity)
    // how big/dense that burst is; the kill itself, its shard drop and
    // its mastery XP are already fully resolved before deathFX ever
    // runs, so this can't change what a kill is worth.
    item("kill_default", "STANDARD DETONATION", "kill", "common", { color: [255, 255, 255] }),
    item("kill_gold", "GILDED DETONATION", "kill", "rare", { color: [255, 201, 92] }),
    item("kill_plasma", "PLASMA COLLAPSE", "kill", "rare", { color: [120, 200, 255] }),
    item("kill_venom", "VENOM RUPTURE", "kill", "epic", { color: [110, 255, 160] }),
    item("kill_void", "VOID COLLAPSE", "kill", "legendary", { color: [190, 110, 255] }),
    item("kill_mastery", "MASTERWORK DETONATION", "kill", "mythic", { color: [255, 230, 150], req: { mastery: { weapon: "any", level: 9 } } }),
    item("kill_prestige", "ASCENDANT COLLAPSE", "kill", "mythic", { color: [255, 240, 200], req: { prestige: 2 } }),

    // ---- UI THEMES (menu/HUD accent colors) ----
    item("theme_default", "VOID CYAN", "theme", "common", { accent: "#00f0ff", accent2: "#a05cff" }),
    item("theme_ember", "EMBER", "theme", "rare", { accent: "#ff9d3c", accent2: "#ff4d6d" }),
    item("theme_toxic", "BIOHAZARD", "theme", "rare", { accent: "#38ff9c", accent2: "#b6ff3c" }),
    item("theme_royal", "ROYAL VOID", "theme", "epic", { accent: "#b06cff", accent2: "#ff5fd2" }),
    item("theme_gold", "GILDED", "theme", "legendary", { accent: "#ffc95c", accent2: "#ff9d3c" }),
    item("theme_prestige", "ASCENDANT", "theme", "mythic", { accent: "#ffffff", accent2: "#ffc95c", req: { prestige: 1 } }),

    // ---- TITLES (shown on the main menu profile line) ----
    item("title_breaker", "VOIDBREAKER", "title", "common", { text: "VOIDBREAKER" }),
    item("title_survivor", "SECTOR SURVIVOR", "title", "common", { text: "SECTOR SURVIVOR" }),
    item("title_hunter", "GUARDIAN HUNTER", "title", "rare", { text: "GUARDIAN HUNTER" }),
    item("title_collapse", "HERALD OF THE COLLAPSE", "title", "epic", { text: "HERALD OF THE COLLAPSE" }),
    item("title_origin", "ORIGIN SLAYER", "title", "legendary", { text: "ORIGIN SLAYER", req: { mastery: { weapon: "any", level: 5 } } }),
    item("title_ascendant", "THE ASCENDANT", "title", "mythic", { text: "THE ASCENDANT", req: { prestige: 1 } }),

    // ---- BADGES (small glyph next to the profile line) ----
    item("badge_shard", "SHARD SIGIL", "badge", "common", { glyph: "◆", color: "#a05cff" }),
    item("badge_skull", "GUARDIAN SKULL", "badge", "rare", { glyph: "☠", color: "#ff2d55" }),
    item("badge_star", "VOID STAR", "badge", "epic", { glyph: "✦", color: "#00f0ff" }),
    item("badge_crown", "CROWN OF SECTORS", "badge", "legendary", { glyph: "♛", color: "#ffc95c" }),
    item("badge_mastery", "MASTERY SIGIL", "badge", "mythic", { glyph: "⬢", color: "#ffc95c", req: { mastery: { weapon: "any", level: 10 } } }),
    item("badge_prestige", "PRESTIGE SIGIL", "badge", "mythic", { glyph: "♦", color: "#ff78ff", req: { prestige: 1 } })
];

const COSMETICS_BY_ID = {};
for (const c of COSMETICS) COSMETICS_BY_ID[c.id] = c;

// Which equip slot a category writes to. weaponSkin is the exception --
// it equips into the per-weapon map instead of a single slot.
const CAT_SLOT = { skin: "skin", trail: "trail", hit: "hit", kill: "kill", theme: "theme", title: "title", badge: "badge" };

function findCosmetic(id) {
    return (typeof id === "string" && COSMETICS_BY_ID[id]) || null;
}

// =====================================================================
// WEAPON MASTERY
//
// 10 levels per weapon. XP comes from actually USING the weapon, and is
// weighted by the value of what you kill (an enemy's own shard value)
// rather than a flat per-kill number, so grinding the weakest trash mob
// is never the fastest route -- swarm enemies are worth 1 shard, a
// Singularity elite 18, so the XP follows real difficulty.
//
// Curve: level n costs 300 + (n-1)*200 XP -> 12,000 XP to master one
// weapon. Measured against the audited economy (a clear kills roughly
// 500 shards' worth of enemies => ~1,500 kill XP + clear/boss bonuses,
// ~1,750 XP per clear) that's ~7 clears per weapon, ~42 to master all
// six -- a long-term goal that never gates normal play.
// =====================================================================
const MASTERY_MAX_LEVEL = 10;
const MASTERY_XP_PER_SHARD_VALUE = 3; // kill XP = enemy shard value * this
const MASTERY_XP_BOSS = 100;
const MASTERY_XP_LEVEL_CLEAR = 200;

function masteryXpForLevel(level) {
    if (level < 1 || level > MASTERY_MAX_LEVEL) return 0;
    return 300 + (level - 1) * 200;
}
function masteryTotalXpForLevel(level) {
    let t = 0;
    for (let i = 1; i <= level; i++) t += masteryXpForLevel(i);
    return t;
}
const MASTERY_TOTAL_XP = masteryTotalXpForLevel(MASTERY_MAX_LEVEL);

// Level -> reward. `kind` tells the client what to show; `shards` is the
// only one that pays currency, and it's granted by the server on claim.
const MASTERY_REWARDS = [
    { level: 1, kind: "title", label: "WEAPON TITLE", detail: "Unlocks this weapon's mastery title" },
    { level: 2, kind: "shards", label: "150 VOID SHARDS", shards: 150 },
    { level: 3, kind: "icon", label: "MASTERY ICON", detail: "Weapon icon marked as mastered in the Loadout" },
    { level: 4, kind: "color", label: "ALTERNATE COLOR", detail: "Alternate projectile tint for this weapon" },
    { level: 5, kind: "shards", label: "300 VOID SHARDS", shards: 300 },
    { level: 6, kind: "effect", label: "WEAPON EFFECT", detail: "Mastery muzzle flare for this weapon" },
    { level: 7, kind: "shards", label: "450 VOID SHARDS", shards: 450 },
    { level: 8, kind: "trail", label: "SHOP: MASTER'S WAKE", detail: "Unlocks MASTER'S WAKE in the Void Shard Shop" },
    { level: 9, kind: "badge", label: "MASTERY BADGE", detail: "Mastery badge for this weapon" },
    { level: 10, kind: "skin", label: "SHOP: MASTERWORK SKIN", detail: "Unlocks this weapon's MASTERWORK skin in the Shop" }
];
const MASTERY_REWARD_BY_LEVEL = {};
for (const r of MASTERY_REWARDS) MASTERY_REWARD_BY_LEVEL[r.level] = r;

function masteryLevelFromXp(xp) {
    let level = 0, spent = 0;
    const x = Math.max(0, Math.floor(Number(xp) || 0));
    for (let i = 1; i <= MASTERY_MAX_LEVEL; i++) {
        const need = masteryXpForLevel(i);
        if (x >= spent + need) { level = i; spent += need; } else break;
    }
    return level;
}
// Highest mastery level reached on ANY weapon -- used by "any"-weapon
// unlock gates (e.g. MASTER'S WAKE at any-weapon level 8).
function bestMasteryLevel(save) {
    let best = 0;
    for (const k of WEAPON_KEYS) {
        const lv = masteryLevelFromXp((save.mastery || {})[k]);
        if (lv > best) best = lv;
    }
    return best;
}

// =====================================================================
// VOID PRESTIGE
//
// Eligibility is deliberately late: every weapon owned, every Forge
// upgrade maxed (that's the full 6,805-shard original progression) and
// the final level beaten. That is exactly the state where shards stop
// having any use today, so Prestige opens precisely when the game
// otherwise runs out of goals -- never sooner.
//
// Requirements rise gently with prestige level (one extra level clear
// per prestige, capped) so the second and third loops aren't trivial,
// without ever becoming absurd.
//
// BONUSES are strictly progression-speed and cosmetic. There is no
// damage, health, speed, or any other combat bonus anywhere in this
// system -- a prestiged player is faster to re-equip, never stronger in
// a fight than a new player with the same gear.
// =====================================================================
const PRESTIGE_MAX_BONUS_LEVEL = 10;       // bonuses stop scaling here (they keep leveling for prestige, the numbers just cap)
const PRESTIGE_SHARD_BONUS_PER_LEVEL = 0.05; // +5% shard gain per level, capped at +50%
const PRESTIGE_COST_DISCOUNT_PER_LEVEL = 0.10; // -10% weapon/forge cost per level, capped at -50%
const PRESTIGE_MAX_COST_DISCOUNT = 0.50;
const PRESTIGE_MAX_SHARD_BONUS = 0.50;

function prestigeShardBonus(level) {
    return Math.min(PRESTIGE_MAX_SHARD_BONUS, Math.max(0, Number(level) || 0) * PRESTIGE_SHARD_BONUS_PER_LEVEL);
}
function prestigeCostDiscount(level) {
    return Math.min(PRESTIGE_MAX_COST_DISCOUNT, Math.max(0, Number(level) || 0) * PRESTIGE_COST_DISCOUNT_PER_LEVEL);
}

// Voidbreak ships 8 levels. The prestige requirement doesn't need an
// artificial per-loop multiplier: because prestige RESETS weapons,
// forge and level unlocks, every subsequent prestige already means
// re-earning the entire 6,805-shard progression and re-clearing all 8
// levels from scratch. The escalation is the loop itself, which is why
// this stays a flat, comprehensible bar rather than a number that
// creeps toward absurdity.
const TOTAL_LEVELS = 8;

// Returns { eligible, requirements: [{ id, label, done, detail }] }.
// Pure + side-effect free so the client can render the exact same
// checklist the server will enforce, with no second copy of the rules.
function prestigeStatus(save) {
    save = save || DEF_SAVE;
    const weaponsOwned = WEAPON_KEYS.filter(function (k) { return !!(save.weapons || {})[k]; }).length;
    const forgeMaxedKeys = [];
    // Forge maxima live in voidbreak.html's FORGE table; they're mirrored
    // here (same deliberate mirror as DEF_SAVE itself) so eligibility can
    // be judged server-side without the client asserting it.
    const FORGE_MAX = { vit: 6, pow: 6, swift: 5, core: 5, drive: 5, edge: 6 };
    for (const k of FORGE_KEYS) if (((save.forge || {})[k] || 0) >= FORGE_MAX[k]) forgeMaxedKeys.push(k);
    const beatenCount = Object.keys(save.beaten || {}).length;
    const finalBeaten = !!(save.beaten || {})[TOTAL_LEVELS];

    const reqs = [
        {
            id: "weapons", label: "UNLOCK EVERY WEAPON", done: weaponsOwned >= WEAPON_KEYS.length,
            detail: weaponsOwned + " / " + WEAPON_KEYS.length
        },
        {
            id: "forge", label: "MAX EVERY FORGE UPGRADE", done: forgeMaxedKeys.length >= FORGE_KEYS.length,
            detail: forgeMaxedKeys.length + " / " + FORGE_KEYS.length
        },
        {
            id: "final", label: "DEFEAT THE ORIGIN (LEVEL " + TOTAL_LEVELS + ")", done: finalBeaten,
            detail: finalBeaten ? "CLEARED" : "NOT CLEARED"
        },
        {
            id: "levels", label: "CLEAR " + TOTAL_LEVELS + " LEVELS", done: beatenCount >= TOTAL_LEVELS,
            detail: beatenCount + " / " + TOTAL_LEVELS
        }
    ];
    return { eligible: reqs.every(function (r) { return r.done; }), requirements: reqs };
}

// The exact, itemized reset the confirmation screen promises. Anything
// not listed in RESETS is preserved verbatim -- and that's asserted by
// tests, not just by this comment.
const PRESTIGE_RESETS = ["weapons (except PULSE RIFLE)", "all Forge upgrades", "unspent Void Shards", "level unlocks",
    "galaxy and solar-system progress", "Galaxy Drive pieces", "recovered ship components", "unspent Coins"];
const PRESTIGE_KEEPS = ["every shop cosmetic you own", "all weapon mastery XP and levels", "prestige level, badges and titles", "lifetime runs / best sector / bosses slain",
    "your Home Planet, every building on it and all its territory", "every discovery you have ever logged"];

// Generous sanity ceilings -- not a balance/anti-cheat model, purely a
// guard against a corrupt or hostile payload storing an absurd number
// (e.g. Infinity, 1e300, a 50MB "beaten" object) forever in the account
// record. A genuine player will never get remotely close to these.
const MAX_SHARDS = 10000000;
const MAX_FORGE_LEVEL = 999;
const MAX_COUNTER = 1000000;
const MAX_LEVEL_ID = 100;      // Voidbreak currently ships 5 levels; this just leaves headroom for more without a code change here
const MAX_BEATEN_ENTRIES = 200; // matches MAX_LEVEL_ID headroom, keeps the object bounded

// ---- universe bounds ----
// These are sized off voidbreakUniverse.js rather than guessed, so a
// galaxy added there does not need a number changed here. The +8 slack
// on the system cap covers a client that is one deploy ahead of this
// server (it may legitimately report a system this process has not
// loaded yet); everything past that is dropped rather than stored.
const MAX_COINS = 10000000;
const MAX_GALAXY_ID = 100;
const MAX_SYSTEM_ENTRIES = 400;
const MAX_DISCOVERIES_PER_SYSTEM = 32;
const MAX_DISCOVERY_ID_LEN = 48;
const MAX_PLOT_INDEX = 4096;

function clampInt(n, lo, hi, fallback) {
    const v = Math.floor(Number(n));
    if (!isFinite(v)) return fallback;
    return Math.max(lo, Math.min(hi, v));
}

// Turns an arbitrary client-reported `universe` blob into a safe,
// correctly-shaped one. Never throws, never trusts a key, and never
// grows without bound: every map is length-capped and every id is
// checked against what voidbreakUniverse.js actually defines, so a
// hostile payload cannot park a megabyte of junk (or a system in a
// galaxy that does not exist) in the account record.
//
// Server-owned members (`coinsSpent`, `planet`) are NOT read from `raw`
// here at all -- they come back as safe empties and applyClientSave()
// then overwrites them from the stored record, which is what makes them
// unwritable by a client. Same construction sanitizeSaveData() already
// uses for shardsSpent/shopOwned/equipped.
function sanitizeUniverse(raw) {
    const src = (raw && typeof raw === "object") ? raw : {};
    const out = Universe.emptyUniverse();

    out.galaxy = clampInt(src.galaxy, 1, MAX_GALAXY_ID, 1);

    // ---- cleared systems ----
    const rawSystems = (src.systems && typeof src.systems === "object") ? src.systems : {};
    let sysCount = 0;
    for (const key of Object.keys(rawSystems)) {
        if (sysCount >= MAX_SYSTEM_ENTRIES) break;
        if (!rawSystems[key]) continue;            // only true entries mean anything
        if (!/^\d{1,3}:\d{1,3}$/.test(key)) continue; // "galaxy:system" or nothing
        out.systems[key] = 1;
        sysCount++;
    }

    // ---- discoveries ----
    // Ids are matched against the galaxy's own discovery list, so an
    // invented id can never enter the record (and therefore can never
    // unlock a decoration that was never found).
    const rawDisc = (src.discovered && typeof src.discovered === "object") ? src.discovered : {};
    let discSystems = 0;
    for (const key of Object.keys(rawDisc)) {
        if (discSystems >= MAX_SYSTEM_ENTRIES) break;
        if (!/^\d{1,3}:\d{1,3}$/.test(key)) continue;
        const list = rawDisc[key];
        if (!Array.isArray(list)) continue;
        const parts = key.split(":");
        const system = Universe.systemAt(Math.floor(Number(parts[0])), Math.floor(Number(parts[1])));
        const known = system ? (system.discoveries || []).map(function (d) { return d.id; }) : null;
        const clean = [];
        for (const id of list) {
            if (clean.length >= MAX_DISCOVERIES_PER_SYSTEM) break;
            if (typeof id !== "string" || !id || id.length > MAX_DISCOVERY_ID_LEN) continue;
            // A system this server has not loaded yet (client one deploy
            // ahead) keeps its ids verbatim but still length-capped;
            // a system it HAS loaded only keeps ids that really exist.
            if (known && known.indexOf(id) === -1) continue;
            if (clean.indexOf(id) === -1) clean.push(id);
        }
        if (clean.length) { out.discovered[key] = clean; discSystems++; }
    }

    // ---- Galaxy Drive pieces ----
    // Capped at the galaxy's real system count where that is known, so
    // "I hold 900 pieces" cannot complete a drive early.
    const rawDrive = (src.drive && typeof src.drive === "object") ? src.drive : {};
    let driveCount = 0;
    for (const key of Object.keys(rawDrive)) {
        if (driveCount >= MAX_GALAXY_ID) break;
        if (!/^\d{1,3}$/.test(key)) continue;
        const total = Universe.driveTotal(Math.floor(Number(key)));
        const cap = total > 0 ? total : MAX_SYSTEM_ENTRIES;
        const n = clampInt(rawDrive[key], 0, cap, 0);
        if (n > 0) { out.drive[key] = n; driveCount++; }
    }

    // ---- ship part levels ----
    const rawShip = (src.ship && typeof src.ship === "object") ? src.ship : {};
    for (const id of Universe.SHIP_SYSTEM_IDS) {
        const n = clampInt(rawShip[id], 0, Universe.SHIP_PART_MAX, 0);
        if (n > 0) out.ship[id] = n;
    }

    out.coins = clampInt(src.coins, 0, MAX_COINS, 0);

    // Server-owned -- left as the empties emptyUniverse() supplied.
    return out;
}

// Older saves predate the universe layer entirely: an existing player
// has `beaten` levels but no `universe.systems`. Backfilling is not
// optional politeness -- without it a veteran with all eight levels
// cleared would open the galaxy map to a locked Galaxy 1, and the very
// first thing the new direction did would be to take their progress
// away.
//
// Galaxy 1's systems carry `levelId`, which IS the old level id, so the
// mapping is exact rather than a guess. Runs once per save and is
// idempotent: it only ever adds, so a save that has already been
// migrated (or that legitimately cleared a system without the legacy
// level) passes through untouched.
function migrateUniverse(save) {
    if (!save || !save.universe) return save;
    const u = save.universe;
    const beaten = save.beaten || {};
    const galaxy = Universe.galaxyById(1);
    if (!galaxy) return save;

    let added = 0;
    for (const system of galaxy.systems) {
        if (!system.levelId || !beaten[system.levelId]) continue;
        const key = Universe.systemKey(1, system.id);
        if (u.systems[key]) continue;
        u.systems[key] = 1;
        // A cleared system is a fully surveyed one -- see the client's
        // own reveal rule, which does exactly this on a clear.
        u.discovered[key] = (system.discoveries || []).map(function (d) { return d.id; });
        added++;
    }
    if (added > 0) {
        // Drive pieces follow the systems that were actually cleared, so
        // a migrated veteran holds the pieces their clears earned -- and
        // a completed Galaxy 1 opens Galaxy 2 immediately, which is the
        // correct reward for work already done.
        const held = Universe.drivePieces(u, 1);
        const earned = Universe.clearedInGalaxy(u, 1);
        if (earned > held) u.drive["1"] = earned;
    }
    return save;
}

// Turns an arbitrary client-reported value into a safe, correctly-shaped
// Voidbreak save, or null if `raw` isn't even an object. Never throws.
function sanitizeSaveData(raw) {
    if (!raw || typeof raw !== "object") return null;

    const forge = {};
    const rawForge = (raw.forge && typeof raw.forge === "object") ? raw.forge : {};
    for (const key of FORGE_KEYS) {
        forge[key] = clampInt(rawForge[key], 0, MAX_FORGE_LEVEL, 0);
    }

    const weapons = {};
    const rawWeapons = (raw.weapons && typeof raw.weapons === "object") ? raw.weapons : {};
    for (const key of WEAPON_KEYS) {
        weapons[key] = !!rawWeapons[key];
    }
    weapons.pulse = true; // the starter weapon is always owned, exactly like DEF_SAVE

    let lastWeapon = typeof raw.lastWeapon === "string" ? raw.lastWeapon : "pulse";
    if (WEAPON_KEYS.indexOf(lastWeapon) === -1 || !weapons[lastWeapon]) lastWeapon = "pulse";

    // The loadout is three ids out of three closed sets. Anything else
    // -- a missing object, a wrong type, an unknown id, a primary the
    // account does not own -- collapses to the default rather than being
    // rejected, because a bad preference should never cost a player a
    // save. SECONDARY_IDS/ABILITY_IDS are the whole validation: what a
    // given account may actually EQUIP is decided by universe progress
    // at use time, not stored here.
    const rawLoadout = (raw.loadout && typeof raw.loadout === "object") ? raw.loadout : {};
    let lPrimary = typeof rawLoadout.primary === "string" ? rawLoadout.primary : lastWeapon;
    if (WEAPON_KEYS.indexOf(lPrimary) === -1 || !weapons[lPrimary]) lPrimary = lastWeapon;
    let lSecondary = typeof rawLoadout.secondary === "string" ? rawLoadout.secondary : "missile";
    if (SECONDARY_IDS.indexOf(lSecondary) === -1) lSecondary = "missile";
    let lAbility = typeof rawLoadout.ability === "string" ? rawLoadout.ability : "overdrive";
    if (ABILITY_IDS.indexOf(lAbility) === -1) lAbility = "overdrive";
    const loadout = { primary: lPrimary, secondary: lSecondary, ability: lAbility };

    const beaten = {};
    const rawBeaten = (raw.beaten && typeof raw.beaten === "object") ? raw.beaten : {};
    let beatenCount = 0;
    for (const key of Object.keys(rawBeaten)) {
        if (beatenCount >= MAX_BEATEN_ENTRIES) break;
        const levelId = Math.floor(Number(key));
        if (!isFinite(levelId) || levelId < 1 || levelId > MAX_LEVEL_ID) continue;
        if (!rawBeaten[key]) continue; // only true entries are meaningful
        beaten[levelId] = true;
        beatenCount++;
    }

    // mastery is CLIENT-REPORTED (see the DEF_SAVE header comment): it's
    // sanitized and clamped here, and separately rate-limited against
    // the previous stored value in applyClientSave().
    const mastery = {};
    const rawMastery = (raw.mastery && typeof raw.mastery === "object") ? raw.mastery : {};
    for (const key of WEAPON_KEYS) {
        const xp = clampInt(rawMastery[key], 0, MASTERY_TOTAL_XP, 0);
        if (xp > 0) mastery[key] = xp;
    }

    return {
        shards: clampInt(raw.shards, 0, MAX_SHARDS, 0),
        forge: forge,
        weapons: weapons,
        lastWeapon: lastWeapon,
        loadout: loadout,
        runs: clampInt(raw.runs, 0, MAX_COUNTER, 0),
        best: clampInt(raw.best, 0, MAX_COUNTER, 0),
        kills: clampInt(raw.kills, 0, MAX_COUNTER, 0),
        beaten: beaten,
        mastery: mastery,
        // Server-owned fields are deliberately NOT read from `raw` here.
        // sanitizeSaveData's output is a complete save, so they're filled
        // with safe empties; applyClientSave() then overwrites them with
        // the STORED values, which is what actually makes them
        // unwritable by a client.
        shardsSpent: 0,
        shopOwned: [],
        equipped: { skin: "", trail: "", hit: "", kill: "", theme: "", title: "", badge: "" },
        equippedWeaponSkins: {},
        masteryClaimed: [],
        prestige: { level: 0, history: [] },
        universe: sanitizeUniverse(raw.universe)
    };
}

// The largest mastery XP gain a single /voidbreak/save is allowed to
// report, per weapon. A full level clear is worth ~1,750 XP by design,
// so 6,000 leaves generous headroom for a long session or a queued
// offline save while still making "set my mastery to max in one POST"
// impossible -- an inflated client has to come back thousands of times
// to fake what honest play earns, and each round trip is visible.
const MAX_MASTERY_XP_GAIN_PER_SAVE = 6000;

// Reconciles a freshly-sanitized CLIENT save against the STORED record.
// This is the function that actually enforces the server-owned/client-
// reported split: every server-owned field is taken from `stored` and
// the client's version is discarded outright, and the one client-
// reported endgame field (mastery XP) is clamped so it can only ever
// rise, and only by a bounded amount per call.
function applyClientSave(clean, stored) {
    const prev = stored || defaultSaveData();

    // ---- server-owned: always the stored value, never the client's ----
    clean.shardsSpent = Math.max(0, Math.floor(Number(prev.shardsSpent) || 0));
    clean.shopOwned = Array.isArray(prev.shopOwned) ? prev.shopOwned.slice() : [];
    clean.equipped = Object.assign({ skin: "", trail: "", hit: "", kill: "", theme: "", title: "", badge: "" }, prev.equipped || {});
    clean.equippedWeaponSkins = Object.assign({}, prev.equippedWeaponSkins || {});
    clean.masteryClaimed = Array.isArray(prev.masteryClaimed) ? prev.masteryClaimed.slice() : [];
    clean.prestige = {
        level: Math.max(0, Math.floor(Number((prev.prestige || {}).level) || 0)),
        history: Array.isArray((prev.prestige || {}).history) ? (prev.prestige || {}).history.slice(0, 50) : []
    };

    // ---- client-reported mastery: monotonic + growth-capped ----
    const prevMastery = prev.mastery || {};
    const merged = {};
    for (const key of WEAPON_KEYS) {
        const before = Math.max(0, Math.floor(Number(prevMastery[key]) || 0));
        const reported = Math.max(0, Math.floor(Number((clean.mastery || {})[key]) || 0));
        // never decreases, never jumps more than one session's worth
        const next = Math.min(Math.max(before, reported), before + MAX_MASTERY_XP_GAIN_PER_SAVE, MASTERY_TOTAL_XP);
        if (next > 0) merged[key] = next;
    }
    clean.mastery = merged;

    // ---- universe: server-owned half carried forward ----
    // The colony and its spend ledger are taken from the STORED record
    // exactly like shopOwned/shardsSpent above, so an ordinary save can
    // never place a building, raise one a level, or un-spend a coin.
    // Only /voidbreak/planet/build can, and it goes through
    // buildOnPlanet() below against this same stored record.
    const prevU = prev.universe || Universe.emptyUniverse();
    if (!clean.universe) clean.universe = Universe.emptyUniverse();
    clean.universe.coinsSpent = Math.max(0, Math.floor(Number(prevU.coinsSpent) || 0));
    clean.universe.planet = clonePlanet(prevU.planet);

    // ---- universe: client-reported half, forced monotonic ----
    // Everything here is progress, and progress does not go backwards.
    // Taking the max against the stored record means a device that is
    // behind (an offline tab finally flushing, a second device mid-sync)
    // can add what it found and never subtract what another device did
    // -- the same rule `shards` and `beaten` have always followed.
    const reportedU = clean.universe;
    reportedU.systems = Object.assign({}, prevU.systems || {}, reportedU.systems || {});
    reportedU.discovered = mergeDiscovered(prevU.discovered, reportedU.discovered);
    const drive = {};
    for (const key of Object.keys(Object.assign({}, prevU.drive || {}, reportedU.drive || {}))) {
        const n = Math.max(
            Math.floor(Number((prevU.drive || {})[key]) || 0),
            Math.floor(Number((reportedU.drive || {})[key]) || 0));
        if (n > 0) drive[key] = n;
    }
    reportedU.drive = drive;
    const ship = {};
    for (const id of Universe.SHIP_SYSTEM_IDS) {
        const n = Math.max(
            Math.floor(Number((prevU.ship || {})[id]) || 0),
            Math.floor(Number((reportedU.ship || {})[id]) || 0));
        if (n > 0) ship[id] = Math.min(n, Universe.SHIP_PART_MAX);
    }
    reportedU.ship = ship;
    reportedU.coins = Math.max(0, Math.floor(Number(reportedU.coins) || 0),
        Math.floor(Number(prevU.coins) || 0));

    // `shards` is the pre-existing client-reported balance. It must never
    // fall below what's already been spent in the shop, or the derived
    // spendable balance would go negative.
    if (clean.shards < 0) clean.shards = 0;

    // Last, so it sees the fully reconciled save: a pre-universe record
    // (or a client that has not migrated itself yet) gets its Galaxy 1
    // progress derived from the levels it already beat. Idempotent and
    // additive -- running it on an already-migrated save changes nothing.
    migrateUniverse(clean);
    return clean;
}

// A deep-enough copy of the colony that a caller mutating the result can
// never reach into the stored record. The nesting is exactly two levels
// (plot -> { id, level }), so this is cheaper and clearer than a
// JSON round trip and cannot be tripped by a stray non-plain value.
function clonePlanet(planet) {
    const src = planet || {};
    const out = { buildings: {}, decorations: {} };
    for (const key of Object.keys(src.buildings || {})) {
        const entry = src.buildings[key];
        if (!entry || typeof entry !== "object") continue;
        if (!Universe.BUILDING_BY_ID[entry.id]) continue;
        out.buildings[key] = { id: entry.id, level: Math.max(1, Math.floor(Number(entry.level) || 1)) };
    }
    for (const key of Object.keys(src.decorations || {})) {
        const entry = src.decorations[key];
        if (!entry || typeof entry !== "object") continue;
        if (!Universe.DECORATION_BY_ID[entry.id]) continue;
        out.decorations[key] = { id: entry.id };
    }
    return out;
}

// Union of two discovery maps. Finding something is permanent and
// unordered, so the union is always the truthful answer -- there is no
// version of "these two devices disagree about a discovery" where the
// right move is to forget one.
function mergeDiscovered(a, b) {
    const out = {};
    const sources = [a || {}, b || {}];
    for (const src of sources) {
        for (const key of Object.keys(src)) {
            const list = Array.isArray(src[key]) ? src[key] : [];
            if (!out[key]) out[key] = [];
            for (const id of list) {
                if (out[key].length >= MAX_DISCOVERIES_PER_SYSTEM) break;
                if (out[key].indexOf(id) === -1) out[key].push(id);
            }
        }
    }
    for (const key of Object.keys(out)) if (!out[key].length) delete out[key];
    return out;
}

// Spendable Void Shards = reported balance minus the server's spend
// ledger, floored at zero. Every price check and deduction in this
// module goes through this one function.
function spendableShards(save) {
    const s = save || DEF_SAVE;
    return Math.max(0, (Math.floor(Number(s.shards) || 0)) - (Math.floor(Number(s.shardsSpent) || 0)));
}

// Is this item's unlock gate satisfied by `save`? (Price is checked
// separately -- a gated item is visible and priced but unbuyable until
// the gate is met.)
function cosmeticUnlocked(save, it) {
    if (!it || !it.req) return true;
    const s = save || DEF_SAVE;
    if (it.req.prestige !== undefined) {
        if (((s.prestige || {}).level || 0) < it.req.prestige) return false;
    }
    if (it.req.mastery) {
        const want = it.req.mastery;
        const have = want.weapon === "any"
            ? bestMasteryLevel(s)
            : masteryLevelFromXp((s.mastery || {})[want.weapon]);
        if (have < want.level) return false;
    }
    return true;
}

// ---- PURCHASE ----------------------------------------------------
// Pure decision function: returns { ok, error } or { ok:true, save }
// with a NEW save object. The caller persists it. Price and ownership
// come from this module and the stored record only.
function buyCosmetic(save, itemId) {
    const it = findCosmetic(itemId);
    if (!it) return { ok: false, code: 400, error: "Unknown item" };
    const s = save || defaultSaveData();
    const owned = Array.isArray(s.shopOwned) ? s.shopOwned : [];
    if (owned.indexOf(it.id) !== -1) return { ok: false, code: 409, error: "You already own this" };
    if (!cosmeticUnlocked(s, it)) return { ok: false, code: 403, error: "Locked -- requirement not met" };
    if (spendableShards(s) < it.price) return { ok: false, code: 400, error: "Not enough Void Shards" };

    const next = cloneSave(s);
    next.shardsSpent = (Math.floor(Number(s.shardsSpent) || 0)) + it.price;
    next.shopOwned = owned.concat([it.id]);
    return { ok: true, save: next, item: it };
}

// ---- EQUIP -------------------------------------------------------
function equipCosmetic(save, itemId) {
    const s = save || defaultSaveData();
    const it = findCosmetic(itemId);
    if (!it) return { ok: false, code: 400, error: "Unknown item" };
    if ((s.shopOwned || []).indexOf(it.id) === -1) return { ok: false, code: 403, error: "You do not own this" };

    const next = cloneSave(s);
    if (it.cat === "weaponSkin") {
        if (WEAPON_KEYS.indexOf(it.weapon) === -1) return { ok: false, code: 400, error: "Unknown weapon" };
        next.equippedWeaponSkins = Object.assign({}, next.equippedWeaponSkins || {});
        // equipping the already-equipped skin toggles it back off
        if (next.equippedWeaponSkins[it.weapon] === it.id) delete next.equippedWeaponSkins[it.weapon];
        else next.equippedWeaponSkins[it.weapon] = it.id;
    } else {
        const slot = CAT_SLOT[it.cat];
        if (!slot) return { ok: false, code: 400, error: "Item cannot be equipped" };
        next.equipped = Object.assign({}, next.equipped || {});
        next.equipped[slot] = next.equipped[slot] === it.id ? "" : it.id;
    }
    return { ok: true, save: next, item: it };
}

// ---- MASTERY CLAIM -----------------------------------------------
// Grants a mastery level's reward exactly once. The level must actually
// be reached according to the STORED xp (not a client claim), and the
// claim key is recorded so a refresh/reconnect/second tab replaying the
// same request is a no-op rather than a second payout.
function claimMastery(save, weapon, level) {
    const s = save || defaultSaveData();
    if (WEAPON_KEYS.indexOf(weapon) === -1) return { ok: false, code: 400, error: "Unknown weapon" };
    const lv = Math.floor(Number(level));
    if (!(lv >= 1 && lv <= MASTERY_MAX_LEVEL)) return { ok: false, code: 400, error: "Invalid mastery level" };
    if (masteryLevelFromXp((s.mastery || {})[weapon]) < lv) return { ok: false, code: 403, error: "Mastery level not reached" };

    const key = weapon + ":" + lv;
    const claimed = Array.isArray(s.masteryClaimed) ? s.masteryClaimed : [];
    if (claimed.indexOf(key) !== -1) return { ok: false, code: 409, error: "Reward already claimed" };

    const reward = MASTERY_REWARD_BY_LEVEL[lv];
    const next = cloneSave(s);
    next.masteryClaimed = claimed.concat([key]);
    let grantedShards = 0;
    if (reward && reward.shards) {
        // A shard payout RAISES the reported balance. It's applied to
        // `shards` (the earned side) rather than by lowering the spend
        // ledger, so it behaves exactly like any other earned shard and
        // can't be used to claw back a purchase.
        grantedShards = reward.shards;
        next.shards = Math.min(MAX_SHARDS, (Math.floor(Number(s.shards) || 0)) + grantedShards);
    }
    return { ok: true, save: next, reward: reward || null, grantedShards: grantedShards, key: key };
}

// ---- PRESTIGE ----------------------------------------------------
// Performs the reset itemized by PRESTIGE_RESETS and nothing else. The
// caller must have confirmed with the player first; this function only
// re-checks eligibility (so a stale/forged client can't skip the gate)
// and then applies the change atomically to a copy.
function applyPrestige(save) {
    const s = save || defaultSaveData();
    const status = prestigeStatus(s);
    if (!status.eligible) return { ok: false, code: 403, error: "Prestige requirements not met", requirements: status.requirements };

    const next = cloneSave(s);
    const newLevel = ((s.prestige || {}).level || 0) + 1;

    // --- RESET (exactly PRESTIGE_RESETS, nothing more) ---
    next.weapons = {};
    for (const k of WEAPON_KEYS) next.weapons[k] = (k === "pulse");
    next.lastWeapon = "pulse";
    // Prestige takes the weapons back, so the loadout has to let go of
    // them too -- leaving `primary` pointed at a railgun the account no
    // longer owns would sanitize back to pulse on the next save anyway,
    // just less visibly. The secondary and ability slots reset with it:
    // both are gated on universe progress, which this same reset clears.
    next.loadout = { primary: "pulse", secondary: "missile", ability: "overdrive" };
    next.forge = {};
    for (const k of FORGE_KEYS) next.forge[k] = 0;
    next.beaten = {};
    // Unspent shards are consumed. Both sides of the ledger are zeroed
    // together so the derived spendable balance lands at exactly 0 --
    // zeroing only one side would either refund past purchases or drive
    // the balance negative.
    next.shards = 0;
    next.shardsSpent = 0;

    // The universe half of the reset. A New Expedition sets out again
    // from the Frontier: galaxy progression, drive pieces, recovered
    // ship components and the coin balance all go, exactly mirroring
    // what happens to levels, weapons, Forge and shards above (and coins
    // zero both sides of their ledger for the same reason shards do --
    // zeroing one side alone would either refund or bankrupt the
    // colony).
    //
    // What survives is everything the expedition LEARNED and BUILT:
    // `discovered` (a catalogue of places that have been seen is not
    // un-seen by going out again) and `planet` (the colony is the
    // physical record of the whole journey; demolishing it would erase
    // the one part of the game that is meant to accumulate forever).
    // Territory survives with it -- see plotsUnlockedFor(), which reads
    // the colony as well as the systems cleared precisely so a reset
    // cannot strand a standing building outside its own borders.
    const keptUniverse = next.universe || Universe.emptyUniverse();
    next.universe = Universe.emptyUniverse();
    next.universe.discovered = keptUniverse.discovered || {};
    next.universe.planet = keptUniverse.planet || { buildings: {}, decorations: {} };

    // --- PRESERVE (everything in PRESTIGE_KEEPS) ---
    // shopOwned, equipped, equippedWeaponSkins, mastery, masteryClaimed,
    // runs, best and kills are all carried through untouched by cloneSave.

    next.prestige = {
        level: newLevel,
        history: ((s.prestige || {}).history || []).concat([{ level: newLevel, at: Date.now() }]).slice(-50)
    };
    return { ok: true, save: next, level: newLevel };
}

// =====================================================================
// HOME PLANET CONSTRUCTION -- the one transactional universe operation
//
// Built to exactly the shape buyCosmetic() above uses, because it is
// exactly the same kind of operation: the client names a thing, and this
// function decides against the STORED save whether that is legal and
// affordable, then returns a NEW save rather than mutating the old one.
// Nothing about the cost, the requirement, the level or the plot comes
// from the request -- `plot` and `buildingId` are the whole of the
// client's contribution, and both are validated here.
//
// Placing a building on a plot that already holds one is an UPGRADE of
// that building, not a second one, which is why there is a single entry
// point rather than a build/upgrade pair.
// =====================================================================
function buildOnPlanet(save, plot, buildingId) {
    const building = Universe.BUILDING_BY_ID[buildingId];
    if (!building) return { ok: false, code: 400, error: "Unknown structure" };

    const s = save || defaultSaveData();
    const u = s.universe || Universe.emptyUniverse();

    const plotIndex = Math.floor(Number(plot));
    if (!isFinite(plotIndex) || plotIndex < 0 || plotIndex >= Universe.PLOT_COUNT) {
        return { ok: false, code: 400, error: "No such plot" };
    }
    // Territory is derived from progress the SERVER holds, so a client
    // cannot build past its own borders by asking nicely.
    if (plotIndex >= Universe.plotsUnlockedFor(u)) {
        return { ok: false, code: 403, error: "That plot is outside your territory" };
    }

    const existing = Universe.buildingAt(u, plotIndex);
    if (existing && existing.id !== buildingId) {
        return { ok: false, code: 409, error: "That plot already holds a different structure" };
    }
    if ((u.planet && u.planet.decorations && u.planet.decorations[String(plotIndex)])) {
        return { ok: false, code: 409, error: "That plot already holds a decoration" };
    }

    const currentLevel = Universe.buildingLevel(u, buildingId);
    if (currentLevel >= building.maxLevel) {
        return { ok: false, code: 409, error: building.name + " is already at maximum level" };
    }
    // Upgrading means upgrading THE one that exists, so a second plot
    // cannot be used to fork a building's level track.
    if (currentLevel > 0 && !existing) {
        return { ok: false, code: 409, error: "You already have a " + building.name + " -- upgrade it in place" };
    }
    if (!Universe.buildingRequirementMet(u, buildingId)) {
        return { ok: false, code: 403, error: "Locked -- " + (Universe.requirementText(buildingId) || "requirement not met") };
    }

    const cost = Universe.buildingCost(u, buildingId);
    if (cost === null) return { ok: false, code: 409, error: "Nothing left to build here" };
    if (Universe.spendableCoins(u) < cost) return { ok: false, code: 400, error: "Not enough Coins" };

    const next = cloneSave(s);
    if (!next.universe) next.universe = Universe.emptyUniverse();
    if (!next.universe.planet) next.universe.planet = { buildings: {}, decorations: {} };
    next.universe.coinsSpent = (Math.floor(Number(u.coinsSpent) || 0)) + cost;
    next.universe.planet.buildings[String(plotIndex)] = { id: buildingId, level: currentLevel + 1 };
    return { ok: true, save: next, building: building, level: currentLevel + 1, plot: plotIndex, spent: cost };
}

// Placing a decoration costs nothing -- it is unlocked by having FOUND
// the thing, which is progress the server already holds in
// `universe.discovered` and re-checks here. Passing a null decorationId
// clears the plot, which is the only way anything ever leaves a plot
// (buildings are never removed; see buildOnPlanet).
function placeDecoration(save, plot, decorationId) {
    const s = save || defaultSaveData();
    const u = s.universe || Universe.emptyUniverse();

    const plotIndex = Math.floor(Number(plot));
    if (!isFinite(plotIndex) || plotIndex < 0 || plotIndex >= Universe.PLOT_COUNT) {
        return { ok: false, code: 400, error: "No such plot" };
    }
    if (plotIndex >= Universe.plotsUnlockedFor(u)) {
        return { ok: false, code: 403, error: "That plot is outside your territory" };
    }
    if (Universe.buildingAt(u, plotIndex)) {
        return { ok: false, code: 409, error: "That plot already holds a structure" };
    }

    const next = cloneSave(s);
    if (!next.universe) next.universe = Universe.emptyUniverse();
    if (!next.universe.planet) next.universe.planet = { buildings: {}, decorations: {} };

    if (decorationId === null || decorationId === "") {
        delete next.universe.planet.decorations[String(plotIndex)];
        return { ok: true, save: next, cleared: true, plot: plotIndex };
    }

    const dec = Universe.DECORATION_BY_ID[decorationId];
    if (!dec) return { ok: false, code: 400, error: "Unknown decoration" };
    if (Universe.unlockedDecorations(u).indexOf(decorationId) === -1) {
        return { ok: false, code: 403, error: "You have not found that yet" };
    }
    next.universe.planet.decorations[String(plotIndex)] = { id: decorationId };
    return { ok: true, save: next, decoration: dec, plot: plotIndex };
}

function cloneSave(s) {
    return JSON.parse(JSON.stringify(s));
}

// A compact, client-safe view of everything the endgame UI needs to
// render: the catalog with per-item owned/equipped/unlocked flags
// resolved SERVER-SIDE, plus mastery and prestige state. The client
// renders this; it never computes prices, ownership or eligibility.
function endgameView(save) {
    const s = save || defaultSaveData();
    const owned = s.shopOwned || [];
    const items = COSMETICS.map(function (it) {
        const view = {
            id: it.id, name: it.name, cat: it.cat, rarity: it.rarity, price: it.price,
            owned: owned.indexOf(it.id) !== -1,
            unlocked: cosmeticUnlocked(s, it),
            req: it.req || null
        };
        for (const k of ["hull", "glow", "color", "accent", "accent2", "text", "glyph", "weapon"]) {
            if (it[k] !== undefined) view[k] = it[k];
        }
        if (it.cat === "weaponSkin") view.equipped = (s.equippedWeaponSkins || {})[it.weapon] === it.id;
        else view.equipped = (s.equipped || {})[CAT_SLOT[it.cat]] === it.id;
        return view;
    });

    const mastery = {};
    for (const k of WEAPON_KEYS) {
        const xp = Math.max(0, Math.floor(Number((s.mastery || {})[k]) || 0));
        const level = masteryLevelFromXp(xp);
        const intoLevel = xp - masteryTotalXpForLevel(level);
        const nextNeed = level >= MASTERY_MAX_LEVEL ? 0 : masteryXpForLevel(level + 1);
        mastery[k] = {
            xp: xp, level: level, max: MASTERY_MAX_LEVEL,
            intoLevel: intoLevel, nextNeed: nextNeed,
            claimable: [],
            claimed: (s.masteryClaimed || []).filter(function (c) { return c.indexOf(k + ":") === 0; })
                .map(function (c) { return Number(c.split(":")[1]); })
        };
        for (let lv = 1; lv <= level; lv++) {
            if ((s.masteryClaimed || []).indexOf(k + ":" + lv) === -1) mastery[k].claimable.push(lv);
        }
    }

    const pLevel = (s.prestige || {}).level || 0;
    return {
        spendable: spendableShards(s),
        shards: Math.floor(Number(s.shards) || 0),
        shardsSpent: Math.floor(Number(s.shardsSpent) || 0),
        items: items,
        equipped: Object.assign({}, s.equipped || {}),
        equippedWeaponSkins: Object.assign({}, s.equippedWeaponSkins || {}),
        mastery: mastery,
        masteryRewards: MASTERY_REWARDS,
        prestige: {
            level: pLevel,
            shardBonus: prestigeShardBonus(pLevel),
            costDiscount: prestigeCostDiscount(pLevel),
            status: prestigeStatus(s),
            resets: PRESTIGE_RESETS,
            keeps: PRESTIGE_KEEPS,
            history: ((s.prestige || {}).history || []).slice(-10)
        },
        // The universe half, resolved server-side for the same reason
        // the shop half is: the colony's spendable balance, what each
        // building costs NEXT, and whether its requirement is met are
        // all decisions, and the client should render decisions rather
        // than make them. It still draws the planet from `save.universe`
        // (which it has anyway); this is what it draws the BUY BUTTONS
        // from.
        universe: universeView(s)
    };
}

function universeView(save) {
    const s = save || defaultSaveData();
    const u = s.universe || Universe.emptyUniverse();
    const buildings = Universe.BUILDINGS.map(function (b) {
        const level = Universe.buildingLevel(u, b.id);
        return {
            id: b.id, name: b.name, glyph: b.glyph, desc: b.desc, color: b.color,
            level: level, maxLevel: b.maxLevel,
            cost: Universe.buildingCost(u, b.id),
            unlocked: Universe.buildingRequirementMet(u, b.id),
            requirement: Universe.requirementText(b.id),
            effect: b.effect ? b.effect(Math.max(1, level)) : "",
            nextEffect: b.effect && level < b.maxLevel ? b.effect(level + 1) : ""
        };
    });
    return {
        coins: Math.max(0, Math.floor(Number(u.coins) || 0)),
        coinsSpent: Math.max(0, Math.floor(Number(u.coinsSpent) || 0)),
        spendableCoins: Universe.spendableCoins(u),
        coinMultiplier: Universe.coinMultiplier(u),
        plotsUnlocked: Universe.plotsUnlockedFor(u),
        plotCount: Universe.PLOT_COUNT,
        buildings: buildings,
        planet: Universe.emptyUniverse().planet && clonePlanet(u.planet),
        decorationsUnlocked: Universe.unlockedDecorations(u),
        galaxy: Math.max(1, Math.floor(Number(u.galaxy) || 1)),
        galaxiesCleared: Universe.galaxiesCleared(u),
        systemsCleared: Universe.totalCleared(u),
        surveyReveal: Universe.surveyReveal(u),
        ship: Universe.shipPower(u)
    };
}

// Safe merge of two ALREADY-SANITIZED saves (never call with raw client
// input -- sanitize each side first). Every field is MAX'd or OR'd, per
// the module header comment: never summed, so merging can only ever
// raise a value to the higher of two honestly-earned totals, never
// invent a bigger one by combining them.
function mergeSaveData(a, b) {
    a = a || DEF_SAVE;
    b = b || DEF_SAVE;

    const forge = {};
    for (const key of FORGE_KEYS) {
        forge[key] = Math.max(a.forge[key] || 0, b.forge[key] || 0);
    }
    const weapons = {};
    for (const key of WEAPON_KEYS) {
        weapons[key] = !!(a.weapons[key] || b.weapons[key]);
    }
    const beaten = Object.assign({}, a.beaten, b.beaten);

    // lastWeapon is a pure loadout preference, not progression -- no
    // stakes either way, so it just follows whichever side actually has
    // it unlocked, preferring `a` (the caller passes the more-recent
    // side first at every call site).
    let lastWeapon = weapons[a.lastWeapon] ? a.lastWeapon : (weapons[b.lastWeapon] ? b.lastWeapon : "pulse");

    // The loadout merges the same way, and for the same reason: three
    // preferences with no stakes. `a` (the more-recent side at every
    // call site) wins each slot as long as it names something the merged
    // account can actually equip, which for the primary means a weapon
    // the MERGED weapons map owns -- so a merge can never leave a player
    // pointed at a weapon they do not have.
    const aL = a.loadout || {}, bL = b.loadout || {};
    const pickPrimary = weapons[aL.primary] ? aL.primary : (weapons[bL.primary] ? bL.primary : lastWeapon);
    const pickId = (x, y, set, dflt) =>
        (set.indexOf(x) !== -1 ? x : (set.indexOf(y) !== -1 ? y : dflt));
    const loadout = {
        primary: pickPrimary,
        secondary: pickId(aL.secondary, bL.secondary, SECONDARY_IDS, "missile"),
        ability: pickId(aL.ability, bL.ability, ABILITY_IDS, "overdrive")
    };

    // Endgame fields follow the same never-summed rule. shardsSpent is
    // MAX'd for the same reason `shards` is: it only ever grows (the
    // server is the only writer), so MAX keeps the true spend total and
    // can never "forget" a purchase by picking a staler, smaller ledger.
    const mastery = {};
    for (const key of WEAPON_KEYS) {
        const m = Math.max((a.mastery || {})[key] || 0, (b.mastery || {})[key] || 0);
        if (m > 0) mastery[key] = m;
    }
    const shopOwned = [];
    for (const id of ((a.shopOwned || []).concat(b.shopOwned || []))) {
        if (shopOwned.indexOf(id) === -1) shopOwned.push(id);
    }
    const masteryClaimed = [];
    for (const k of ((a.masteryClaimed || []).concat(b.masteryClaimed || []))) {
        if (masteryClaimed.indexOf(k) === -1) masteryClaimed.push(k);
    }
    const aPrestige = a.prestige || {}, bPrestige = b.prestige || {};
    const prestigeLevel = Math.max(aPrestige.level || 0, bPrestige.level || 0);
    const prestigeHistory = (aPrestige.history || []).length >= (bPrestige.history || []).length
        ? (aPrestige.history || []) : (bPrestige.history || []);

    return {
        shards: Math.max(a.shards || 0, b.shards || 0),
        forge: forge,
        weapons: weapons,
        lastWeapon: lastWeapon,
        loadout: loadout,
        runs: Math.max(a.runs || 0, b.runs || 0),
        best: Math.max(a.best || 0, b.best || 0),
        kills: Math.max(a.kills || 0, b.kills || 0),
        beaten: beaten,
        shardsSpent: Math.max(a.shardsSpent || 0, b.shardsSpent || 0),
        shopOwned: shopOwned,
        equipped: Object.assign({ skin: "", trail: "", hit: "", kill: "", theme: "", title: "", badge: "" }, b.equipped || {}, a.equipped || {}),
        equippedWeaponSkins: Object.assign({}, b.equippedWeaponSkins || {}, a.equippedWeaponSkins || {}),
        mastery: mastery,
        masteryClaimed: masteryClaimed,
        prestige: { level: prestigeLevel, history: prestigeHistory.slice(-50) },
        universe: mergeUniverse(a.universe, b.universe)
    };
}

// The universe half of mergeSaveData, under the same never-summed rule
// the rest of this module follows: every number is MAX'd, every set is
// UNION'd, and nothing is ever added together. Summing two devices'
// coin totals would be the exact double-earn bug the header warns about
// for shards; summing drive pieces would let two devices finish a
// galaxy neither of them actually finished.
//
// The colony is the one non-numeric member, so it merges per PLOT:
// whichever side has the higher level on a given plot wins, and a plot
// only one side has built on is kept. A building is never destroyed by
// a merge -- there is no honest reading of two saves in which a
// structure the player paid for should disappear.
function mergeUniverse(a, b) {
    const ua = a || Universe.emptyUniverse();
    const ub = b || Universe.emptyUniverse();
    const out = Universe.emptyUniverse();

    out.galaxy = Math.max(1, Math.floor(Number(ua.galaxy) || 1), Math.floor(Number(ub.galaxy) || 1));
    out.systems = Object.assign({}, ub.systems || {}, ua.systems || {});
    out.discovered = mergeDiscovered(ua.discovered, ub.discovered);

    for (const key of Object.keys(Object.assign({}, ua.drive || {}, ub.drive || {}))) {
        const n = Math.max(Math.floor(Number((ua.drive || {})[key]) || 0),
                           Math.floor(Number((ub.drive || {})[key]) || 0));
        if (n > 0) out.drive[key] = n;
    }
    for (const id of Universe.SHIP_SYSTEM_IDS) {
        const n = Math.max(Math.floor(Number((ua.ship || {})[id]) || 0),
                           Math.floor(Number((ub.ship || {})[id]) || 0));
        if (n > 0) out.ship[id] = Math.min(n, Universe.SHIP_PART_MAX);
    }

    out.coins = Math.max(Math.floor(Number(ua.coins) || 0), Math.floor(Number(ub.coins) || 0));
    out.coinsSpent = Math.max(Math.floor(Number(ua.coinsSpent) || 0), Math.floor(Number(ub.coinsSpent) || 0));

    const pa = clonePlanet(ua.planet), pb = clonePlanet(ub.planet);
    out.planet = { buildings: {}, decorations: {} };
    for (const key of Object.keys(Object.assign({}, pa.buildings, pb.buildings))) {
        const ea = pa.buildings[key], eb = pb.buildings[key];
        if (ea && eb) out.planet.buildings[key] = (ea.level >= eb.level) ? ea : eb;
        else out.planet.buildings[key] = ea || eb;
    }
    out.planet.decorations = Object.assign({}, pb.decorations, pa.decorations);
    return out;
}

// =====================================================================
// PROGRESS SCORING -- which of two saves represents more REAL progress
//
// Why this exists
// ---------------
// /voidbreak/save used to store whatever the client POSTed, full stop.
// That made the LAST device to save the winner regardless of how much
// progress it actually had, which is exactly the reported bug: play on
// the Mac, then open the iPad, and whichever one wrote last flattened
// the other. Worse, a device whose cloud fetch FAILED at boot fell back
// to an empty local save and then uploaded THAT, wiping the account.
//
// So the arbitration lives here, on the server, where it holds no
// matter what any client does -- a buggy, stale, offline or hostile
// client can no longer talk the account's progress downwards.
//
// WHY NOT A TIMESTAMP
// -------------------
// "Newest wins" is wrong for this game, and it is what the previous
// client-side reconciliation leaned on: a device's clock and the server's
// clock are different clocks (an iPad's can trivially be minutes off),
// and more importantly an OLDER save can legitimately hold far more
// progress than a newer one. Time is only ever used here as the final
// tie-break, once every real progression signal is exactly equal.
//
// WHY A VECTOR AND NOT ONE WEIGHTED NUMBER
// ----------------------------------------
// Comparison is LEXICOGRAPHIC over an ordered vector of progression
// signals, most meaningful first. That is what stops the exploit the
// naive "add it all up" score has: with one weighted total, a big
// enough currency balance eventually outweighs real level progress, so
// a save that had beaten nothing could beat a save that had cleared the
// game. Under a lexicographic compare, shards are only ever consulted
// when EVERY level/weapon/upgrade/mastery signal is already tied, so
// currency can never buy its way past actual progression.
//
// calculateProgressScore() additionally exposes a single flattened
// number, but that is for logging and diagnostics only -- compareSaves()
// is the authority, and nothing in this module decides anything from
// the flattened value.
//
// THE ORDER (highest priority first)
//   1. prestige level        -- the deepest permanent meta-progression
//   2. highest level beaten  -- then how many levels in total
//   3. weapons unlocked
//   4. total Forge upgrade levels
//   5. weapon mastery XP     -- then mastery rewards claimed
//   6. shop cosmetics owned
//   7. lifetime Void Shards earned (shards is a lifetime counter, not a
//      spendable balance -- spendable is shards - shardsSpent -- so it
//      only ever rises and is a legitimate, non-exploitable signal)
//   8. lifetime runs / bosses / kills
// =====================================================================

// Ordered, most significant first. Each entry is [name, extractor].
// The universe signals sit immediately below prestige and above the
// legacy level signals on purpose. Galaxies and solar systems are now
// the outer shell of progression -- a save that has conquered a galaxy
// is unambiguously further along than one that has not, whatever its
// level ids say -- while everything below them is untouched and in its
// original order, so two pre-universe saves still arbitrate exactly as
// they did before this existed (all the new signals read 0 and the
// comparison falls straight through to `highestLevel`).
const PROGRESS_SIGNALS = [
    ["prestigeLevel",  s => Math.max(0, Math.floor(Number((s.prestige || {}).level) || 0))],
    ["galaxiesCleared",s => Universe.galaxiesCleared(s.universe)],
    ["systemsCleared", s => Universe.totalCleared(s.universe)],
    ["drivePieces",    s => totalDrivePieces(s)],
    ["highestLevel",   s => highestBeatenLevel(s)],
    ["levelsBeaten",   s => countBeaten(s)],
    ["weaponsOwned",   s => WEAPON_KEYS.reduce((n, k) => n + ((s.weapons || {})[k] ? 1 : 0), 0)],
    ["forgeTotal",     s => FORGE_KEYS.reduce((n, k) => n + (Math.max(0, Math.floor(Number((s.forge || {})[k]) || 0))), 0)],
    ["shipParts",      s => Universe.SHIP_SYSTEM_IDS.reduce((n, k) => n + Universe.shipLevel(s.universe, k), 0)],
    ["masteryXp",      s => WEAPON_KEYS.reduce((n, k) => n + Math.max(0, Math.floor(Number((s.mastery || {})[k]) || 0)), 0)],
    ["masteryClaimed", s => (Array.isArray(s.masteryClaimed) ? s.masteryClaimed.length : 0)],
    ["shopOwned",      s => (Array.isArray(s.shopOwned) ? s.shopOwned.length : 0)],
    ["planetBuilt",    s => Universe.countBuildings(s.universe)],
    ["discoveries",    s => totalDiscoveries(s)],
    ["shardsEarned",   s => Math.max(0, Math.floor(Number(s.shards) || 0))],
    ["coinsEarned",    s => Math.max(0, Math.floor(Number((s.universe || {}).coins) || 0))],
    ["runs",           s => Math.max(0, Math.floor(Number(s.runs) || 0))],
    ["best",           s => Math.max(0, Math.floor(Number(s.best) || 0))],
    ["kills",          s => Math.max(0, Math.floor(Number(s.kills) || 0))]
];

function totalDrivePieces(s) {
    const drive = ((s || {}).universe || {}).drive || {};
    let n = 0;
    for (const key of Object.keys(drive)) n += Math.max(0, Math.floor(Number(drive[key]) || 0));
    return n;
}

function totalDiscoveries(s) {
    const found = ((s || {}).universe || {}).discovered || {};
    let n = 0;
    for (const key of Object.keys(found)) n += (Array.isArray(found[key]) ? found[key].length : 0);
    return n;
}

function highestBeatenLevel(s) {
    let highest = 0;
    for (const key of Object.keys((s && s.beaten) || {})) {
        if (!s.beaten[key]) continue;
        const id = Math.floor(Number(key));
        if (isFinite(id) && id > highest) highest = id;
    }
    return highest;
}

function countBeaten(s) {
    let n = 0;
    for (const key of Object.keys((s && s.beaten) || {})) if (s.beaten[key]) n++;
    return n;
}

// The per-signal breakdown, the ordered vector compareSaves() actually
// uses, and a single flattened number for logs/diagnostics only.
function calculateProgressScore(save) {
    const s = save || DEF_SAVE;
    const components = {};
    const vector = [];
    for (const [name, extract] of PROGRESS_SIGNALS) {
        const v = extract(s);
        components[name] = v;
        vector.push(v);
    }
    // Advisory only -- deliberately NOT the thing any decision is made
    // from (see the header note on why one weighted number is unsafe
    // here). Weighted so the ordering usually agrees with the real
    // lexicographic result, which makes it readable in a log line.
    const total =
        components.prestigeLevel  * 1000000000 +
        components.galaxiesCleared * 100000000 +
        components.systemsCleared  * 20000000 +
        components.highestLevel   * 10000000 +
        components.levelsBeaten   * 1000000 +
        components.weaponsOwned   * 100000 +
        components.forgeTotal     * 1000 +
        components.masteryClaimed * 500 +
        Math.min(999, Math.floor(components.masteryXp / 100)) +
        components.shopOwned      * 100 +
        Math.min(99999, Math.floor(components.shardsEarned / 100));
    return { components: components, vector: vector, total: total };
}

// Lexicographic compare of two saves' progress vectors.
//   > 0  => `a` has more progress
//   < 0  => `b` has more progress
//   = 0  => genuinely tied on every progression signal
function compareSaves(a, b) {
    const va = calculateProgressScore(a).vector;
    const vb = calculateProgressScore(b).vector;
    for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) return va[i] > vb[i] ? 1 : -1;
    }
    return 0;
}

// A save from BEFORE a prestige, folded into the post-prestige record.
//
// Prestige resets weapons/lastWeapon/forge/beaten/shards/shardsSpent and
// explicitly KEEPS runs, best, kills, mastery, shop ownership, equipped
// cosmetics, mastery claims and the prestige record itself (see
// applyPrestige, whose two halves this mirrors). A device still holding
// the pre-prestige save therefore has legitimately newer LIFETIME
// counters -- it kept playing -- while its copy of the reset fields is
// exactly the progress the prestige consumed. So the kept counters are
// merged upward and everything the prestige reset is taken from the
// stored record untouched.
function mergeKeptAcrossPrestige(stored, incoming) {
    const out = cloneSave(stored);
    const a = incoming || DEF_SAVE;
    // The two universe members prestige explicitly KEEPS are merged
    // upward for the same reason the lifetime counters below are: a
    // device that kept playing after the prestige legitimately found
    // sites and placed buildings the stored record has not seen. Every
    // member prestige RESETS is left as the stored record has it -- that
    // is the progress the prestige consumed, and taking it from the
    // stale save would undo the reset.
    if (!out.universe) out.universe = Universe.emptyUniverse();
    out.universe.discovered = mergeDiscovered(out.universe.discovered, (a.universe || {}).discovered);
    out.universe.planet = mergeUniverse(out.universe, a.universe || {}).planet;
    out.runs = Math.max(out.runs || 0, a.runs || 0);
    out.best = Math.max(out.best || 0, a.best || 0);
    out.kills = Math.max(out.kills || 0, a.kills || 0);
    const mastery = {};
    for (const k of WEAPON_KEYS) {
        const m = Math.max((out.mastery || {})[k] || 0, (a.mastery || {})[k] || 0);
        if (m > 0) mastery[k] = m;
    }
    out.mastery = mastery;
    return out;
}

// ---------------------------------------------------------------------
// THE ARBITER -- decides what a /voidbreak/save request actually stores.
//
// `incoming` is the client's sanitized + applyClientSave()'d save;
// `stored` is what the account already has (or null for a first save).
// `opts.incomingPredatesPrestige` says the uploading device last read
// this account's save BEFORE its most recent prestige (the caller works
// that out from the save version the client echoed back -- see
// /voidbreak/save).
// Returns { data, winner, reason, incomingScore, storedScore, changed }.
//
// Guarantees, in order:
//
//   * A STALE-BY-PRESTIGE upload can never undo a prestige. Prestige
//     deliberately RESETS weapons/forge/unspent shards/level unlocks, so
//     a second device still holding the pre-prestige save legitimately
//     has "more" of those. Merging it back in would resurrect exactly
//     what the prestige consumed.
//
//     There are two ways to be stale by a prestige and both are caught:
//     an incoming save that still carries a LOWER prestige level is
//     rejected outright; and -- the case that actually happens, because
//     /voidbreak/save's reconciliation copies the stored (server-owned)
//     prestige level onto every upload before it gets here, so the level
//     always matches -- a save whose device had not yet seen the
//     prestige keeps only the lifetime counters prestige preserves.
//   * A DEFAULT (untouched, brand-new) save can never replace a real
//     one. This is the empty-save wipe: a device whose cloud fetch
//     failed falls back to a fresh save and uploads it. The client is
//     fixed not to do that any more, but this is the backstop that
//     makes it impossible regardless of which client is talking.
//   * Otherwise the higher-progress side wins -- and the result is the
//     MERGE of both (every field MAX'd or OR'd, never summed, see
//     mergeSaveData), so the winner keeps everything it had AND nothing
//     the loser uniquely had is thrown away. Merging cannot inflate a
//     total: MAX only ever keeps the higher of two honestly-earned
//     numbers, it never adds them together.
// ---------------------------------------------------------------------
function resolveSaveConflict(incoming, stored, opts) {
    const options = opts || {};
    const incomingScore = calculateProgressScore(incoming);

    if (!stored) {
        return { data: incoming, winner: "incoming", reason: "first-save",
                 incomingScore: incomingScore, storedScore: null, changed: true };
    }

    const storedScore = calculateProgressScore(stored);

    // A device that is behind on prestige is holding a save from before
    // the reset. Never let it write, and never merge it.
    if (incomingScore.components.prestigeLevel < storedScore.components.prestigeLevel) {
        return { data: stored, winner: "stored", reason: "incoming-behind-prestige",
                 incomingScore: incomingScore, storedScore: storedScore, changed: false };
    }

    // The same staleness, seen from the version the device last read
    // rather than from the save body. Keep only what prestige preserves.
    if (options.incomingPredatesPrestige && storedScore.components.prestigeLevel > 0) {
        const kept = mergeKeptAcrossPrestige(stored, incoming);
        return { data: kept, winner: "stored", reason: "incoming-predates-prestige",
                 incomingScore: incomingScore, storedScore: storedScore,
                 changed: compareSaves(kept, stored) !== 0 };
    }

    // A brand-new save never beats real progress.
    if (isDefaultSave(incoming) && !isDefaultSave(stored)) {
        return { data: stored, winner: "stored", reason: "incoming-is-default",
                 incomingScore: incomingScore, storedScore: storedScore, changed: false };
    }

    const cmp = compareSaves(incoming, stored);
    // The winner is passed FIRST to mergeSaveData, which is what decides
    // the handful of preference-only fields (lastWeapon, equipped) -- the
    // progression fields themselves are order-independent (MAX/OR).
    const merged = cmp >= 0 ? mergeSaveData(incoming, stored) : mergeSaveData(stored, incoming);

    return {
        data: merged,
        winner: cmp > 0 ? "incoming" : (cmp < 0 ? "stored" : "tie"),
        reason: cmp > 0 ? "incoming-has-more" : (cmp < 0 ? "stored-has-more" : "tied"),
        incomingScore: incomingScore,
        storedScore: storedScore,
        // The merge can only ever add to the stored side, so anything
        // other than a straight "stored already had at least this" is a
        // real write. Compared on the progress vector rather than the
        // flattened total, so a change the weighting happens to round
        // away (a handful of shards, a few mastery XP) still persists.
        changed: compareSaves(merged, stored) !== 0
    };
}

// True if a save is exactly the untouched starting state -- used to
// decide whether there's anything worth migrating/merging at all.
function isDefaultSave(s) {
    if (!s) return true;
    if (s.shards || s.runs || s.best || s.kills) return false;
    if (Object.keys(s.beaten || {}).length) return false;
    // A save can now be non-default purely through the universe layer --
    // a player who surveyed a system or laid a foundation but has not
    // yet beaten anything still has progress worth protecting, and
    // treating that as "empty" would let a bootstrap overwrite it.
    const u = s.universe;
    if (u) {
        if (Math.floor(Number(u.coins) || 0) > 0) return false;
        if (Object.keys(u.systems || {}).length) return false;
        if (Object.keys(u.discovered || {}).length) return false;
        if (Object.keys(u.drive || {}).length) return false;
        if (Object.keys(u.ship || {}).length) return false;
        if (Universe.countBuildings(u)) return false;
        if (Object.keys((u.planet || {}).decorations || {}).length) return false;
    }
    for (const key of FORGE_KEYS) if ((s.forge || {})[key]) return false;
    for (const key of WEAPON_KEYS) if (key !== "pulse" && (s.weapons || {})[key]) return false;
    return true;
}

function defaultSaveData() {
    return JSON.parse(JSON.stringify(DEF_SAVE));
}

module.exports = {
    DEF_SAVE,
    FORGE_KEYS,
    WEAPON_KEYS,
    EQUIP_SLOTS,
    sanitizeSaveData,
    mergeSaveData,
    isDefaultSave,
    defaultSaveData,

    // save-conflict arbitration (see the PROGRESS SCORING section)
    calculateProgressScore,
    compareSaves,
    resolveSaveConflict,

    // universe / home planet (see voidbreakUniverse.js for the content)
    Universe,
    sanitizeUniverse,
    migrateUniverse,
    mergeUniverse,
    buildOnPlanet,
    placeDecoration,
    universeView,

    // endgame: catalog + pure transaction logic (server source of truth)
    COSMETICS,
    PRICES,
    findCosmetic,
    cosmeticUnlocked,
    spendableShards,
    applyClientSave,
    buyCosmetic,
    equipCosmetic,
    claimMastery,
    applyPrestige,
    prestigeStatus,
    prestigeShardBonus,
    prestigeCostDiscount,
    endgameView,
    masteryLevelFromXp,
    masteryXpForLevel,
    masteryTotalXpForLevel,
    bestMasteryLevel,
    MASTERY_MAX_LEVEL,
    MASTERY_TOTAL_XP,
    MASTERY_REWARDS,
    MASTERY_XP_PER_SHARD_VALUE,
    MASTERY_XP_BOSS,
    MASTERY_XP_LEVEL_CLEAR,
    MAX_MASTERY_XP_GAIN_PER_SAVE,
    PRESTIGE_RESETS,
    PRESTIGE_KEEPS,
    TOTAL_LEVELS
};
