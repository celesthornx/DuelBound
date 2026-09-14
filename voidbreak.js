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
    equipped: { skin: "", trail: "", hit: "", theme: "", title: "", badge: "" },
    equippedWeaponSkins: {}, // { weaponKey: itemId }
    mastery: {},         // { weaponKey: xp }
    masteryClaimed: [],  // ["rail:4", ...] -- one entry per claimed mastery level
    prestige: { level: 0, history: [] }
};

const FORGE_KEYS = Object.keys(DEF_SAVE.forge);
const WEAPON_KEYS = Object.keys(DEF_SAVE.weapons);
const EQUIP_SLOTS = Object.keys(DEF_SAVE.equipped);

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
// out of reach of a mid-game player. The catalog TOTAL (53 items,
// 78,250 shards) is deliberately a long tail rather than a checklist to
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
const CAT_SLOT = { skin: "skin", trail: "trail", hit: "hit", theme: "theme", title: "title", badge: "badge" };

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
const PRESTIGE_RESETS = ["weapons (except PULSE RIFLE)", "all Forge upgrades", "unspent Void Shards", "level unlocks"];
const PRESTIGE_KEEPS = ["every shop cosmetic you own", "all weapon mastery XP and levels", "prestige level, badges and titles", "lifetime runs / best sector / bosses slain"];

// Generous sanity ceilings -- not a balance/anti-cheat model, purely a
// guard against a corrupt or hostile payload storing an absurd number
// (e.g. Infinity, 1e300, a 50MB "beaten" object) forever in the account
// record. A genuine player will never get remotely close to these.
const MAX_SHARDS = 10000000;
const MAX_FORGE_LEVEL = 999;
const MAX_COUNTER = 1000000;
const MAX_LEVEL_ID = 100;      // Voidbreak currently ships 5 levels; this just leaves headroom for more without a code change here
const MAX_BEATEN_ENTRIES = 200; // matches MAX_LEVEL_ID headroom, keeps the object bounded

function clampInt(n, lo, hi, fallback) {
    const v = Math.floor(Number(n));
    if (!isFinite(v)) return fallback;
    return Math.max(lo, Math.min(hi, v));
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
        equipped: { skin: "", trail: "", hit: "", theme: "", title: "", badge: "" },
        equippedWeaponSkins: {},
        masteryClaimed: [],
        prestige: { level: 0, history: [] }
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
    clean.equipped = Object.assign({ skin: "", trail: "", hit: "", theme: "", title: "", badge: "" }, prev.equipped || {});
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

    // `shards` is the pre-existing client-reported balance. It must never
    // fall below what's already been spent in the shop, or the derived
    // spendable balance would go negative.
    if (clean.shards < 0) clean.shards = 0;
    return clean;
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
    next.forge = {};
    for (const k of FORGE_KEYS) next.forge[k] = 0;
    next.beaten = {};
    // Unspent shards are consumed. Both sides of the ledger are zeroed
    // together so the derived spendable balance lands at exactly 0 --
    // zeroing only one side would either refund past purchases or drive
    // the balance negative.
    next.shards = 0;
    next.shardsSpent = 0;

    // --- PRESERVE (everything in PRESTIGE_KEEPS) ---
    // shopOwned, equipped, equippedWeaponSkins, mastery, masteryClaimed,
    // runs, best and kills are all carried through untouched by cloneSave.

    next.prestige = {
        level: newLevel,
        history: ((s.prestige || {}).history || []).concat([{ level: newLevel, at: Date.now() }]).slice(-50)
    };
    return { ok: true, save: next, level: newLevel };
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
        }
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
        runs: Math.max(a.runs || 0, b.runs || 0),
        best: Math.max(a.best || 0, b.best || 0),
        kills: Math.max(a.kills || 0, b.kills || 0),
        beaten: beaten,
        shardsSpent: Math.max(a.shardsSpent || 0, b.shardsSpent || 0),
        shopOwned: shopOwned,
        equipped: Object.assign({ skin: "", trail: "", hit: "", theme: "", title: "", badge: "" }, b.equipped || {}, a.equipped || {}),
        equippedWeaponSkins: Object.assign({}, b.equippedWeaponSkins || {}, a.equippedWeaponSkins || {}),
        mastery: mastery,
        masteryClaimed: masteryClaimed,
        prestige: { level: prestigeLevel, history: prestigeHistory.slice(-50) }
    };
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
const PROGRESS_SIGNALS = [
    ["prestigeLevel",  s => Math.max(0, Math.floor(Number((s.prestige || {}).level) || 0))],
    ["highestLevel",   s => highestBeatenLevel(s)],
    ["levelsBeaten",   s => countBeaten(s)],
    ["weaponsOwned",   s => WEAPON_KEYS.reduce((n, k) => n + ((s.weapons || {})[k] ? 1 : 0), 0)],
    ["forgeTotal",     s => FORGE_KEYS.reduce((n, k) => n + (Math.max(0, Math.floor(Number((s.forge || {})[k]) || 0))), 0)],
    ["masteryXp",      s => WEAPON_KEYS.reduce((n, k) => n + Math.max(0, Math.floor(Number((s.mastery || {})[k]) || 0)), 0)],
    ["masteryClaimed", s => (Array.isArray(s.masteryClaimed) ? s.masteryClaimed.length : 0)],
    ["shopOwned",      s => (Array.isArray(s.shopOwned) ? s.shopOwned.length : 0)],
    ["shardsEarned",   s => Math.max(0, Math.floor(Number(s.shards) || 0))],
    ["runs",           s => Math.max(0, Math.floor(Number(s.runs) || 0))],
    ["best",           s => Math.max(0, Math.floor(Number(s.best) || 0))],
    ["kills",          s => Math.max(0, Math.floor(Number(s.kills) || 0))]
];

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
