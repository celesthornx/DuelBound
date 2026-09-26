// =====================================================================
// VOIDBREAK UNIVERSE -- the content layer for galaxies, solar systems,
// discoveries, the Home Planet and ship progression.
//
// Why this file exists
// --------------------
// Voidbreak's combat has always been driven by the `LEVELS` array inside
// voidbreak.html: eight hand-written level definitions, each with its
// own wave composition, elite pool, boss and environment palette. That
// array is excellent at what it does and this file does not replace it.
//
// What it did NOT have was anywhere to say what a level IS -- what star
// it orbits, what the player has and hasn't found there, which galaxy
// it belongs to, what defeating its guardian is worth beyond shards, or
// what unlocks when an entire galaxy is finished. Those questions are
// the whole of the new Voidbreak direction (a universe that is explored
// and uncovered, rather than a numbered level list), and they are all
// CONTENT questions, not engine questions. So they live here, as data.
//
// The rule this file exists to enforce: ADDING A SOLAR SYSTEM, OR AN
// ENTIRE GALAXY, IS AN EDIT TO THIS FILE AND NOTHING ELSE. No new render
// path, no new state, no new endpoint, no new save field. A system is an
// object in a list; the galaxy map, the system map, the discovery log,
// the drive-piece economy and the reward screens all read whatever is
// here and size themselves to it. That is what makes "10 galaxies x 10
// systems" a content schedule instead of a rewrite, and it is also why
// nothing below hardcodes the number 10 -- a galaxy is exactly as long
// as its `systems` array (see driveTotal()).
//
// SHARED, NOT DUPLICATED
// ----------------------
// This module is loaded by BOTH halves of Voidbreak: server.js requires
// it, and voidbreak.html loads it with a <script> tag (which is why it
// is on server.js's PUBLIC_FILES allowlist -- it is pure content data
// with no secrets, no credentials and no server logic in it).
//
// voidbreak.js deliberately re-describes the save shape that
// voidbreak.html owns, because those two are describing the same thing
// from two sides. This file is different: it is the single definition of
// what the universe CONTAINS, and a client and a server that disagreed
// about that would disagree about which systems exist, what a galaxy
// costs to finish and which building a plot is allowed to hold. So it is
// shared rather than mirrored.
//
// TRUST
// -----
// Nothing here is a secret and nothing here decides a currency amount on
// its own. Prices and unlock rules are read by the SERVER out of this
// file when it validates a build request (see voidbreak.js's
// buildOnPlanet and server.js's /voidbreak/planet/build); the client
// gets the same catalog only so it can render buttons. A client that
// edits its own copy changes what its buttons say and nothing else --
// exactly the arrangement the Void Shard Shop already uses.
// =====================================================================

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.VBUniverse = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    // =================================================================
    // DISCOVERY KINDS
    //
    // Every point of interest in a system is one of these. The kind
    // drives its glyph and colour on the system map and the wording of
    // its "unknown" state -- which is the entire point of the discovery
    // system: an unexplored system should read as a list of things the
    // player cannot identify yet, not as an empty screen.
    // =================================================================
    var DISCOVERY_KINDS = {
        star:      { glyph: "☀", label: "STAR",          unknown: "UNCATALOGUED STAR",   color: [255, 212, 120] },
        planet:    { glyph: "●", label: "PLANET",        unknown: "UNKNOWN PLANET",      color: [120, 200, 255] },
        moon:      { glyph: "○", label: "MOON",          unknown: "UNKNOWN BODY",        color: [180, 200, 230] },
        belt:      { glyph: "∴", label: "ASTEROID BELT", unknown: "DEBRIS SIGNATURE",    color: [200, 170, 130] },
        station:   { glyph: "◈", label: "STATION",       unknown: "ARTIFICIAL STRUCTURE",color: [120, 255, 200] },
        derelict:  { glyph: "✖", label: "DERELICT",      unknown: "SIGNAL LOST",         color: [255, 150, 110] },
        anomaly:   { glyph: "◆", label: "ANOMALY",       unknown: "ANOMALY DETECTED",    color: [200, 120, 255] },
        signal:    { glyph: "≋", label: "SIGNAL",        unknown: "UNIDENTIFIED SIGNAL", color: [255, 120, 180] },
        ruin:      { glyph: "░", label: "RUIN",          unknown: "DATA UNAVAILABLE",    color: [255, 200, 160] }
    };

    // =================================================================
    // SHIP SYSTEMS
    //
    // The spaceship is the player's character (GDD pillar 2), so every
    // system cleared hands back a physical component rather than a
    // number -- see SYSTEMS[].part below, which names the component and
    // which of these it upgrades.
    //
    // BALANCE NOTE, and why these numbers are small: Voidbreak already
    // has a fully-tuned power curve (six Forge upgrades and twenty-odd
    // in-run Void Upgrades). Ship parts are a THIRD source of power on
    // top of both, earned once per system and never reset except by
    // prestige, so each level is deliberately worth noticeably less than
    // a Forge level of the same kind -- +10 max HP against the Vitality
    // Matrix's +20, +1.5% speed against Phase Boots' +6%. A full galaxy
    // of parts lands in the neighbourhood of two or three Forge levels
    // spread across several stats: felt, but not a rebalance of the
    // existing eight levels.
    //
    // `scanner` and `cargo` are deliberately NON-COMBAT. Scanner buys
    // information (how much of a system is revealed on arrival) and
    // cargo buys income. Neither touches damage, health or speed, so the
    // exploration half of the ship can be upgraded without inflating the
    // combat half.
    // =================================================================
    var SHIP_SYSTEMS = [
        { id: "hull",    name: "HULL PLATING",    glyph: "■", color: [120, 200, 255], per: 10,    unit: "MAX HEALTH",    fmt: function (n) { return "+" + (n * 10) + " max health"; } },
        { id: "engine",  name: "ION ENGINE",      glyph: "▶", color: [120, 255, 200], per: 0.015, unit: "SPEED",         fmt: function (n) { return "+" + (n * 1.5).toFixed(1) + "% movement speed"; } },
        { id: "weapon",  name: "WEAPON MOUNT",    glyph: "✦", color: [255, 160, 110], per: 0.025, unit: "DAMAGE",        fmt: function (n) { return "+" + (n * 2.5).toFixed(1) + "% weapon damage"; } },
        { id: "shield",  name: "SHIELD EMITTER",  glyph: "◌", color: [160, 180, 255], per: 0.03,  unit: "DASH SHIELD",   fmt: function (n) { return "+" + (n * 3) + "% dash invulnerability"; } },
        { id: "energy",  name: "ENERGY CELL",     glyph: "⚡", color: [255, 220, 130], per: 6,     unit: "MAX ENERGY",    fmt: function (n) { return "+" + (n * 6) + " max energy"; } },
        { id: "scanner", name: "DEEP SCANNER",    glyph: "◎", color: [200, 140, 255], per: 1,     unit: "SURVEY RANGE",  fmt: function (n) { return "reveals " + n + " extra site" + (n === 1 ? "" : "s") + " on arrival"; } },
        { id: "cargo",   name: "CARGO BAY",       glyph: "▤", color: [255, 190, 120], per: 0.04,  unit: "SALVAGE",       fmt: function (n) { return "+" + (n * 4) + "% coin salvage"; } }
    ];
    var SHIP_SYSTEM_IDS = SHIP_SYSTEMS.map(function (s) { return s.id; });
    var SHIP_SYSTEM_BY_ID = {};
    SHIP_SYSTEMS.forEach(function (s) { SHIP_SYSTEM_BY_ID[s.id] = s; });

    // A single ship system can only be raised so far by parts alone --
    // otherwise a player farming one galaxy's worth of repeat clears
    // would stack one stat indefinitely. Parts are awarded once per
    // system (first clear only), so this cap is a backstop rather than
    // a wall a normal player meets.
    var SHIP_PART_MAX = 8;

    // =================================================================
    // HOME PLANET -- BUILDINGS
    //
    // Buildings are bought with Coins, a NEW currency that exists only
    // for the planet. Void Shards were deliberately left alone: they are
    // the input to a finished, balanced economy (Forge, Void Shard Shop,
    // Weapon Mastery, Prestige) and adding a large new sink to them
    // would silently re-tune all four. Coins are earned in parallel from
    // the same combat -- see addCoins() in voidbreak.html -- so the
    // planet grows from play without competing with anything.
    //
    // `height` and `color` are render parameters: the planet is drawn as
    // an actual sphere with actual structures standing on it (see the
    // HOME PLANET section of voidbreak.html), and a building's silhouette
    // comes from these. `requires` is checked SERVER-SIDE in
    // voidbreak.js's buildOnPlanet before any coin is deducted.
    // =================================================================
    var BUILDINGS = [
        {
            id: "command", name: "COMMAND CENTER", glyph: "◈",
            desc: "Planetary authority. Every other structure needs it standing first.",
            cost: 0, costPerLevel: 400, maxLevel: 5, height: 0.10, color: [0, 240, 255],
            requires: null,
            effect: function (lv) { return "Planet tier " + lv + " · unlocks further construction"; }
        },
        {
            id: "hangar", name: "SHIP HANGAR", glyph: "▲",
            desc: "Berths your ship between expeditions. Shows the hull you actually fly.",
            cost: 350, costPerLevel: 300, maxLevel: 5, height: 0.075, color: [120, 255, 200],
            requires: { building: "command" },
            effect: function (lv) { return "Ship bay tier " + lv; }
        },
        {
            id: "lab", name: "RESEARCH LAB", glyph: "✲",
            desc: "Studies recovered components. Raises what salvage is worth.",
            cost: 500, costPerLevel: 400, maxLevel: 5, height: 0.085, color: [200, 120, 255],
            requires: { building: "command" },
            effect: function (lv) { return "+" + (lv * 3) + "% coin salvage"; },
            // Read by coinMultiplier() -- the one building with a
            // mechanical effect, and deliberately on the income side
            // rather than the combat side.
            coinBonusPerLevel: 0.03
        },
        {
            id: "observatory", name: "OBSERVATORY", glyph: "◎",
            desc: "Long-range survey array. Sees further into a system before you arrive.",
            cost: 650, costPerLevel: 450, maxLevel: 4, height: 0.115, color: [255, 212, 120],
            requires: { building: "command" },
            effect: function (lv) { return "reveals " + lv + " extra site" + (lv === 1 ? "" : "s") + " on arrival"; },
            surveyPerLevel: 1
        },
        {
            id: "foundry", name: "RESOURCE FOUNDRY", glyph: "▦",
            desc: "Processes raw void matter hauled back from the field.",
            cost: 800, costPerLevel: 550, maxLevel: 4, height: 0.07, color: [255, 160, 110],
            requires: { building: "lab" },
            effect: function (lv) { return "+" + (lv * 2) + "% coin salvage"; },
            coinBonusPerLevel: 0.02
        },
        {
            id: "spaceport", name: "SPACEPORT", glyph: "▭",
            desc: "Docking for everything that isn't yours. Traffic means the colony is real.",
            cost: 1100, costPerLevel: 600, maxLevel: 3, height: 0.06, color: [140, 190, 255],
            requires: { building: "hangar" },
            effect: function (lv) { return "Colony traffic tier " + lv; }
        },
        {
            id: "gate", name: "GALAXY GATE", glyph: "◇",
            desc: "Opens the jump corridor. Needs a completed Galaxy Drive to fire.",
            cost: 2000, costPerLevel: 0, maxLevel: 1, height: 0.15, color: [255, 120, 180],
            // Gated on having finished a galaxy at least once, so the
            // Gate cannot be standing before the moment it exists for.
            requires: { galaxiesCleared: 1 },
            effect: function () { return "Galaxy travel online"; }
        }
    ];
    var BUILDING_BY_ID = {};
    BUILDINGS.forEach(function (b) { BUILDING_BY_ID[b.id] = b; });

    // Decorations are placed on plots exactly like buildings, cost no
    // coins, and are unlocked by DISCOVERIES rather than bought -- they
    // are the thing the GDD asks for in "Planet Collectibles": physical
    // evidence on your planet of somewhere you actually went. A
    // decoration's `from` is a discovery id; find it in the field and it
    // becomes placeable at home.
    var DECORATIONS = [
        { id: "dec_monolith",  name: "ASTERON MONOLITH",   glyph: "▮", color: [120, 200, 255], height: 0.055, from: "g1s1_monolith" },
        { id: "dec_beacon",    name: "FRACTURE BEACON",    glyph: "✵", color: [200, 120, 255], height: 0.055, from: "g1s2_beacon" },
        { id: "dec_coil",      name: "ARCHON COIL",        glyph: "◌", color: [255, 110, 125], height: 0.055, from: "g1s3_coil" },
        { id: "dec_lantern",   name: "ABYSS LANTERN",      glyph: "◉", color: [90, 140, 255],  height: 0.055, from: "g1s4_lantern" },
        { id: "dec_spire",     name: "DESCENT SPIRE",      glyph: "▲", color: [150, 105, 255], height: 0.055, from: "g1s5_spire" },
        { id: "dec_sentinel",  name: "SENTINEL EYE",       glyph: "◈", color: [255, 170, 90],  height: 0.055, from: "g1s6_eye" },
        { id: "dec_eclipse",   name: "HOLLOW SHARD",       glyph: "◆", color: [140, 80, 255],  height: 0.055, from: "g1s7_shard" },
        { id: "dec_origin",    name: "ORIGIN SEAL",        glyph: "⬡", color: [255, 255, 255], height: 0.055, from: "g1s8_seal" },
        { id: "dec_emberglass",name: "EMBERGLASS BLOOM",   glyph: "❀", color: [255, 120, 60],  height: 0.055, from: "g2s1_bloom" },
        { id: "dec_crown",     name: "CRIMSON CROWN",      glyph: "♛", color: [255, 70, 70],   height: 0.055, from: "g2s3_crown" },
        { id: "dec_lattice",   name: "RIME LATTICE",       glyph: "❄", color: [200, 235, 255], height: 0.055, from: "g3s1_lattice" },
        { id: "dec_heart",     name: "CALVING HEART",      glyph: "◍", color: [120, 190, 255], height: 0.055, from: "g3s4_heart" },
        { id: "dec_ember",     name: "THE LAST EMBER",     glyph: "✧", color: [255, 200, 140], height: 0.055, from: "g3s6_ember" }
    ];
    var DECORATION_BY_ID = {};
    DECORATIONS.forEach(function (d) { DECORATION_BY_ID[d.id] = d; });

    // =================================================================
    // HOME PLANET -- TERRITORY
    //
    // The planet's surface is PLOT_COUNT hex plots spread evenly over a
    // sphere (the geometry itself is in voidbreak.html's renderer; this
    // is only the count and the expansion rule, because both halves need
    // to agree on how many plots exist and how many are yours).
    //
    // Territory is NOT bought. It expands as you explore -- every solar
    // system cleared anywhere in the universe widens the colony -- which
    // is the loop the GDD is built around: the planet is a physical
    // record of the journey, so it has to grow from the journey and not
    // from a shop. See plotsUnlocked().
    // =================================================================
    var PLOT_COUNT = 122;
    var PLOTS_AT_START = 7;
    var PLOTS_PER_SYSTEM = 4;

    function plotsUnlocked(systemsCleared) {
        var n = PLOTS_AT_START + Math.max(0, Math.floor(systemsCleared || 0)) * PLOTS_PER_SYSTEM;
        return Math.max(PLOTS_AT_START, Math.min(PLOT_COUNT, n));
    }

    // The territory a given save actually holds.
    //
    // Plots are unlocked in index order, so a building standing on plot
    // 30 is itself proof that territory reached 31. Taking the max of
    // the two is what keeps the colony coherent across a prestige: a New
    // Expedition resets the systems cleared (and therefore the first
    // term) but deliberately KEEPS the colony, and without this the
    // player would come home to buildings sitting outside their own
    // borders. Territory, like a building, is never taken back.
    function plotsUnlockedFor(u) {
        var fromExploration = plotsUnlocked(totalCleared(u));
        var fromColony = 0;
        if (u && u.planet) {
            ["buildings", "decorations"].forEach(function (which) {
                var map = u.planet[which] || {};
                Object.keys(map).forEach(function (key) {
                    var idx = Math.floor(Number(key));
                    if (isFinite(idx)) fromColony = Math.max(fromColony, idx + 1);
                });
            });
        }
        return Math.max(PLOTS_AT_START, Math.min(PLOT_COUNT, Math.max(fromExploration, fromColony)));
    }

    // =================================================================
    // THE UNIVERSE
    //
    // A galaxy is { id, name, theme, ... , systems: [...] }.
    // A system is a DESTINATION, and carries two separable halves:
    //
    //   * PRESENTATION -- name, star, discoveries, rewards, lore. Always
    //     here, for every system in every galaxy.
    //
    //   * COMBAT -- either `levelId`, meaning "reuse voidbreak.html's
    //     existing hand-tuned LEVELS entry with this id", or `levelDef`,
    //     a complete level definition written inline in the same shape.
    //
    // Galaxy 1's eight systems use `levelId`, so every wave, elite pool,
    // boss and palette that shipped and was balanced is the SAME object
    // it always was -- the universe layer wraps the existing game rather
    // than re-implementing it, and an existing player's eight cleared
    // levels are still those eight levels. Galaxy 2's systems use
    // `levelDef` and exist to prove the other half of the claim: that
    // new content is data. Nothing in voidbreak.html knows which kind a
    // system is except resolveLevel() below.
    // =================================================================

    function d(id, kind, name, note) {
        return { id: id, kind: kind, name: name, note: note || "" };
    }

    var GALAXIES = [
        {
            id: 1,
            name: "THE FRONTIER",
            subtitle: "GALAXY 01",
            theme: "The charted edge of known space. Cold stars, old wars, and the first thing that ever looked back.",
            color: [0, 240, 255],
            accent: [176, 108, 255],
            systems: [
                {
                    id: 1, name: "ASTERON", levelId: 1,
                    star: "ASTERON, a pale blue dwarf",
                    brief: "The first system anyone maps and the last one anyone remembers. Something beneath it stopped being dormant.",
                    drivePiece: "DRIVE HOUSING",
                    part: { system: "hull", name: "REINFORCED PLATE" },
                    coins: 260,
                    discoveries: [
                        d("g1s1_star", "star", "Asteron", "A blue dwarf running cold three billion years early."),
                        d("g1s1_veyra", "planet", "Veyra", "Tide-locked. One face glass, one face ice."),
                        d("g1s1_belt", "belt", "The Quiet Belt", "Debris in a perfect ring. Nothing makes a ring that perfect."),
                        d("g1s1_monolith", "ruin", "The Asteron Monolith", "Older than the star it orbits.", true)
                    ]
                },
                {
                    id: 2, name: "VEYRA REACH", levelId: 2,
                    star: "VEYRA, a violet variable",
                    brief: "The Reach flickers. Local time runs half a second behind the rest of the Frontier and nobody has explained why.",
                    drivePiece: "PHASE COUPLING",
                    part: { system: "engine", name: "ION MANIFOLD" },
                    coins: 320,
                    discoveries: [
                        d("g1s2_star", "star", "Veyra", "Brightens on a cycle that does not match its mass."),
                        d("g1s2_korrin", "planet", "Korrin", "Storm-wrapped. The storms have edges."),
                        d("g1s2_station", "station", "Relay Nine", "Still transmitting. Crew logged out four centuries ago."),
                        d("g1s2_beacon", "anomaly", "The Fracture Beacon", "A tear that hums on a fixed note.", true)
                    ]
                },
                {
                    id: 3, name: "KORR", levelId: 3,
                    star: "KORR, a red giant in collapse",
                    brief: "Korr is dying loudly. Everything in the system is being pulled toward the noise.",
                    drivePiece: "FLUX REGULATOR",
                    part: { system: "weapon", name: "RESONANCE BARREL" },
                    coins: 380,
                    discoveries: [
                        d("g1s3_star", "star", "Korr", "Shedding mass fast enough to watch."),
                        d("g1s3_ash", "planet", "Ashfall", "Rains its own crust."),
                        d("g1s3_wreck", "derelict", "The Long Silence", "A fleet that stopped mid-formation."),
                        d("g1s3_coil", "anomaly", "The Archon Coil", "Still under power. Still turning.", true)
                    ]
                },
                {
                    id: 4, name: "MYRRHEN DEEP", levelId: 4,
                    star: "MYRRHEN, a drowned blue star",
                    brief: "Light arrives late here and leaves early. The Deep keeps what falls into it.",
                    drivePiece: "GRAVITY LENS",
                    part: { system: "shield", name: "DEEP FIELD EMITTER" },
                    coins: 440,
                    discoveries: [
                        d("g1s4_star", "star", "Myrrhen", "Its own light bends back into it."),
                        d("g1s4_hollow", "planet", "The Hollow Sphere", "No core. Confirmed twice."),
                        d("g1s4_moon", "moon", "Sill", "Orbits backwards."),
                        d("g1s4_lantern", "ruin", "The Abyss Lantern", "A light left burning for something still coming.", true)
                    ]
                },
                {
                    id: 5, name: "TALVOS", levelId: 5,
                    star: "TALVOS, a white pulsar",
                    brief: "The pulsar keeps time for the whole Frontier. Lately it has been keeping it wrong.",
                    drivePiece: "CHRONO SPINDLE",
                    part: { system: "energy", name: "PULSAR CELL" },
                    coins: 520,
                    discoveries: [
                        d("g1s5_star", "star", "Talvos", "Eleven pulses a second, and one that does not belong."),
                        d("g1s5_shelf", "belt", "The Shelf", "Debris sorted by size. Sorted."),
                        d("g1s5_signal", "signal", "Carrier 4-4", "Repeats your own approach vector back at you."),
                        d("g1s5_spire", "ruin", "The Descent Spire", "Points down, into nothing.", true)
                    ]
                },
                {
                    id: 6, name: "SAERIS RIFT", levelId: 6,
                    star: "SAERIS, an orange flare star",
                    brief: "A wound in the Frontier that never closed, and a guardian that has spent an age watching it.",
                    drivePiece: "RIFT ANCHOR",
                    part: { system: "scanner", name: "RIFT SOUNDER" },
                    coins: 600,
                    discoveries: [
                        d("g1s6_star", "star", "Saeris", "Flares on contact. Any contact."),
                        d("g1s6_forge", "station", "Cinderforge", "Automated. Still producing. Nobody ordered this."),
                        d("g1s6_rift", "anomaly", "The Saeris Rift", "Both edges are the far side."),
                        d("g1s6_eye", "ruin", "The Sentinel Eye", "It was open before you arrived.", true)
                    ]
                },
                {
                    id: 7, name: "OLTHERA", levelId: 7,
                    star: "OLTHERA, a dark star",
                    brief: "A star that gives no light. The Hollow grew around it anyway.",
                    drivePiece: "NULL CAPACITOR",
                    part: { system: "cargo", name: "SALVAGE RIG" },
                    coins: 700,
                    discoveries: [
                        d("g1s7_star", "star", "Olthera", "Mass confirmed. Light not detected."),
                        d("g1s7_garden", "planet", "The Garden", "Something grew here without a sun."),
                        d("g1s7_choir", "signal", "The Choir", "Many voices, one of them recent."),
                        d("g1s7_shard", "anomaly", "The Hollow Shard", "A piece of somewhere that has no name yet.", true)
                    ]
                },
                {
                    id: 8, name: "ZENN PRIME", levelId: 8, finale: true,
                    star: "ZENN, the first star",
                    brief: "Where the Void started keeping records. Break the Origin and the Frontier is yours.",
                    drivePiece: "DRIVE CORE",
                    part: { system: "hull", name: "ORIGIN LATTICE" },
                    coins: 900,
                    discoveries: [
                        d("g1s8_star", "star", "Zenn", "Predates the galaxy it sits in."),
                        d("g1s8_archive", "station", "The Archive", "Indexes systems that do not exist yet."),
                        d("g1s8_first", "ruin", "First Ground", "Footprints. One set. Outbound."),
                        d("g1s8_seal", "anomaly", "The Origin Seal", "It closes from the inside.", true)
                    ]
                }
            ]
        },

        // -------------------------------------------------------------
        // GALAXY 2 -- authored entirely as data.
        //
        // Every system below carries a full `levelDef` in exactly the
        // shape voidbreak.html's LEVELS entries use, so these three are
        // playable without a single line of new engine code. They are
        // not difficulty reskins of Galaxy 1: the wave tables, elite
        // pools, support enemies and environments are composed
        // differently (Crimson Reach leans on pressure, fire-coloured
        // hazard fields and heavy elites where the Frontier leaned on
        // swarms), which is the distinction the GDD draws between "a new
        // galaxy" and "the same galaxy with bigger numbers".
        //
        // HONEST LIMITATION, stated rather than hidden: the bosses here
        // are existing boss kinds. New boss art and new attack patterns
        // are engine work, not data, and this file cannot conjure them.
        // Their arenas, escorts and lead-ins are new; the guardians
        // themselves are returning ones.
        // -------------------------------------------------------------
        {
            id: 2,
            name: "CRIMSON REACH",
            subtitle: "GALAXY 02",
            theme: "Red giants in a slow collapse. Everything here burns, and everything here has learned to live in it.",
            color: [255, 90, 70],
            accent: [255, 180, 80],
            systems: [
                {
                    id: 1, name: "PYRAX", coins: 1000,
                    star: "PYRAX, a red giant",
                    brief: "The Reach begins in fire. Pyrax has been shedding its outer shell for a century and the shell is still falling.",
                    drivePiece: "EMBER HOUSING",
                    part: { system: "hull", name: "ABLATIVE SHELL" },
                    discoveries: [
                        d("g2s1_star", "star", "Pyrax", "Shedding a planet's worth of mass a decade."),
                        d("g2s1_kiln", "planet", "The Kiln", "Surface temperature: molten. Surface: inhabited."),
                        d("g2s1_fall", "belt", "Shellfall", "The star's own crust, still arriving."),
                        d("g2s1_bloom", "ruin", "Emberglass Bloom", "Grown, not built, out of cooled starfall.", true)
                    ],
                    levelDef: {
                        name: "PYRAX", diff: 1.95, depth: 10, boss: "sentinel", completionBonus: 1150,
                        waveOpts: [["brute", 7, 1, 1], ["chaser", 3, 2, 1], ["fdrone", 3, 2, 1], ["leaper", 4, 2, 1],
                            ["core", 4, 2, 2], ["hunter", 4, 2, 2], ["orb", 3, 2, 2], ["swarm", 5, 2, 1]],
                        combos: [[["brute", 2], ["fdrone", 2]], [["hunter", 2], ["leaper", 2]],
                            [["core", 2], ["chaser", 3]], [["orb", 2], ["brute", 1]],
                            [["fdrone", 3], ["swarm", 4]], [["hunter", 2], ["orb", 2]]],
                        elitePool: [["brute", 1], ["ravager", 1], ["guardian", 2], ["shattered", 2], ["singularity", 3]],
                        eliteSupport: "fdrone",
                        secondElite: ["guardian", "ravager", "shattered"],
                        secondSupport: "leaper", secondSupportCount: 2,
                        env: {
                            floor: "rgba(28,8,6,0.84)", grid: "rgba(255,120,60,0.06)", border: [255, 110, 60],
                            neb: [[255, 90, 40], [190, 40, 60]], ambient: [[255, 130, 60], [255, 70, 50], [255, 190, 90]],
                            cracks: true, debris: true, debrisBig: true, glitch: false,
                            pillars: true, pillarsN: 6, pillarC: [255, 120, 60], channels: true, pressure: true
                        }
                    }
                },
                {
                    id: 2, name: "EMBERFALL", coins: 1150,
                    star: "EMBERFALL, a binary pair",
                    brief: "Two stars close enough to trade fire. The debris between them never settles, and neither does anything living in it.",
                    drivePiece: "BINARY GOVERNOR",
                    part: { system: "weapon", name: "EMBER CHAMBER" },
                    discoveries: [
                        d("g2s2_star", "star", "Emberfall A/B", "Close binary. Mass transfer ongoing."),
                        d("g2s2_anvil", "planet", "Anvil", "Struck twice a day, every day, for an age."),
                        d("g2s2_wreck", "derelict", "Salvage Line 7", "A harvesting fleet that stayed too long."),
                        d("g2s2_arc", "anomaly", "The Arc", "The bridge of fire between the two stars. It is not straight.")
                    ],
                    levelDef: {
                        name: "EMBERFALL", diff: 2.05, depth: 10, boss: "archon", completionBonus: 1250,
                        waveOpts: [["sniper", 3, 2, 1], ["phantom", 4, 2, 1], ["stalker", 4, 2, 1], ["hunter", 4, 2, 1],
                            ["leech", 4, 1, 2], ["orb", 3, 2, 1], ["fdrone", 3, 2, 1], ["drone", 2, 2, 1]],
                        combos: [[["stalker", 2], ["sniper", 2]], [["leech", 1], ["hunter", 2]],
                            [["phantom", 2], ["orb", 2]], [["hunter", 2], ["stalker", 2]],
                            [["leech", 1], ["fdrone", 3]], [["sniper", 3], ["drone", 2]]],
                        elitePool: [["ravager", 1], ["shattered", 1], ["guardian", 2], ["singularity", 2]],
                        eliteSupport: "stalker",
                        secondElite: ["shattered", "singularity", "guardian"],
                        secondSupport: "leech", secondSupportCount: 2,
                        env: {
                            floor: "rgba(32,10,4,0.86)", grid: "rgba(255,160,70,0.05)", border: [255, 150, 70],
                            neb: [[255, 120, 40], [255, 50, 90]], ambient: [[255, 160, 70], [255, 90, 60], [255, 220, 120]],
                            cracks: true, debris: true, debrisBig: true, glitch: true,
                            pillars: true, pillarsN: 8, pillarC: [255, 150, 70], channels: true, pressure: true
                        }
                    }
                },
                {
                    id: 3, name: "THE CRIMSON THRONE", coins: 1500, finale: true,
                    star: "THE THRONE, a star that stopped collapsing",
                    brief: "A red giant held at the exact instant before its own death. Something is holding it there.",
                    drivePiece: "CRIMSON CORE",
                    part: { system: "energy", name: "THRONE CELL" },
                    discoveries: [
                        d("g2s3_star", "star", "The Throne", "Collapse arrested. Mechanism unknown."),
                        d("g2s3_court", "station", "The Court", "Built facing inward, toward the star."),
                        d("g2s3_ash", "ruin", "Ashcourt Ruin", "Whoever built the Court did not finish."),
                        d("g2s3_crown", "anomaly", "The Crimson Crown", "The ring of held fire. It is a machine.", true)
                    ],
                    levelDef: {
                        name: "THE CRIMSON THRONE", diff: 2.2, depth: 10, boss: "origin", completionBonus: 1600,
                        waveOpts: [["brute", 7, 1, 1], ["hunter", 4, 2, 1], ["leech", 4, 1, 1], ["stalker", 4, 2, 1],
                            ["core", 4, 2, 1], ["orb", 3, 2, 1], ["leaper", 4, 2, 1], ["phantom", 4, 2, 1]],
                        combos: [[["leech", 2], ["hunter", 2]], [["brute", 2], ["stalker", 2]],
                            [["core", 2], ["orb", 2]], [["hunter", 2], ["leaper", 3]],
                            [["phantom", 2], ["leech", 1]], [["stalker", 2], ["orb", 2]]],
                        elitePool: [["ravager", 1], ["shattered", 1], ["guardian", 1], ["singularity", 2]],
                        eliteSupport: "leech",
                        secondElite: ["singularity", "guardian", "shattered", "ravager"],
                        secondSupport: "hunter", secondSupportCount: 3,
                        env: {
                            floor: "rgba(24,4,10,0.9)", grid: "rgba(255,70,70,0.05)", border: [255, 60, 70],
                            neb: [[255, 50, 50], [120, 20, 60]], ambient: [[255, 70, 70], [255, 180, 90], [255, 40, 110]],
                            cracks: true, debris: true, debrisBig: true, glitch: true,
                            pillars: true, pillarsN: 9, pillarC: [255, 80, 70], channels: true, pressure: true
                        }
                    }
                }
            ]
        },

        // -------------------------------------------------------------
        // GALAXY 3 -- THE FROZEN EXPANSE. Six systems, authored as data.
        //
        // Crimson Reach was about heat and pressure; the Expanse is about
        // what cold does to a fight. Each system has ONE identity that
        // its wave table, combos, elites and arena all serve, so no two
        // play alike:
        //
        //   RIME             the slow crush -- tanks, turrets and orbs
        //   GLACIS SPIRES    the shooting gallery -- ranged enemies in a
        //                    forest of ice spires
        //   HOARFROST DRIFT  the stampede -- fast melee through drifting ice
        //   THE CALVING      pulled apart -- gravity, leeches, pressure
        //   CRYOVAULT        the sleepers wake -- ambush and teleporters
        //   THE STILLPOINT   absolute zero -- everything, all at once
        //
        // `env.snow` turns the ambient motes into falling snow and
        // `env.crackC` tints the floor cracks ice-blue -- the only two
        // visuals this galaxy adds to the engine.
        //
        // `bossHpMult` exists because boss HP is fixed per boss KIND, not
        // scaled by `diff` (see createBoss in voidbreak.html). The Null
        // and the Fractured King were tuned as Frontier openers; pulled
        // this deep, un-scaled, they would fall in seconds. The multiplier
        // puts every guardian here between ~14k and ~19k HP, above
        // Crimson Reach and rising toward the finale.
        //
        // Same honest limitation as Galaxy 2: these are returning
        // guardians in new arenas with new escorts, not new boss kinds.
        // -------------------------------------------------------------
        {
            id: 3,
            name: "FROZEN EXPANSE",
            subtitle: "GALAXY 03",
            theme: "Ice older than starlight. Whatever moves out here has been moving very slowly for a very long time.",
            color: [150, 220, 255],
            accent: [90, 160, 255],
            systems: [
                {
                    id: 1, name: "RIME", coins: 1650,
                    star: "RIME, a white dwarf gone cold",
                    brief: "The first light in the Expanse is barely light at all. Everything here is heavy, slow, and in no hurry to let you leave.",
                    drivePiece: "FROST HOUSING",
                    part: { system: "engine", name: "CRYO INJECTOR" },
                    discoveries: [
                        d("g3s1_star", "star", "Rime", "Cooling faster than physics allows. Something is drinking the heat."),
                        d("g3s1_tessa", "planet", "Tessa", "A world wrapped in a single unbroken sheet of ice."),
                        d("g3s1_haul", "derelict", "The Long Haul", "A convoy frozen solid mid-burn. The engines are still lit."),
                        d("g3s1_lattice", "ruin", "The Rime Lattice", "Frost that grows in the same pattern every time it is scraped away.", true)
                    ],
                    levelDef: {
                        name: "RIME", diff: 2.3, depth: 10, boss: "warden", bossHpMult: 1.45, completionBonus: 1700,
                        waveOpts: [["brute", 7, 1, 1], ["orb", 3, 2, 1], ["drone", 2, 2, 1], ["sniper", 3, 2, 1],
                            ["core", 4, 2, 2], ["leech", 4, 1, 2], ["swarm", 5, 2, 2]],
                        combos: [[["brute", 2], ["orb", 2]], [["core", 2], ["sniper", 2]],
                            [["leech", 1], ["brute", 1], ["drone", 2]], [["orb", 3], ["swarm", 4]],
                            [["guardian", 1], ["drone", 2]], [["core", 3], ["orb", 1]]],
                        elitePool: [["brute", 1], ["guardian", 1], ["ravager", 2], ["guardian", 3]],
                        eliteSupport: "orb",
                        secondElite: ["guardian", "ravager", "brute"],
                        secondSupport: "core", secondSupportCount: 2,
                        env: {
                            floor: "rgba(8,14,26,0.84)", grid: "rgba(170,220,255,0.06)", border: [170, 220, 255],
                            neb: [[120, 190, 255], [200, 230, 255]], ambient: [[220, 240, 255], [160, 210, 255], [255, 255, 255]],
                            cracks: true, crackC: [170, 225, 255], debris: false, glitch: false, snow: true
                        }
                    }
                },
                {
                    id: 2, name: "GLACIS SPIRES", coins: 1800,
                    star: "GLACIS, a blue supergiant",
                    brief: "A forest of ice spires kilometres high, every one of them a lens. Something up there has the high ground and has always had it.",
                    drivePiece: "PRISM GYRO",
                    part: { system: "scanner", name: "PRISM ARRAY" },
                    discoveries: [
                        d("g3s2_star", "star", "Glacis", "Seen through the spires it is a thousand stars."),
                        d("g3s2_spires", "belt", "The Spire Field", "Ice columns in orbit, all aligned to the same point."),
                        d("g3s2_post", "station", "Listening Post Ardent", "Every antenna aimed outward. Every log ends mid-sentence."),
                        d("g3s2_prism", "anomaly", "The Glacis Prism", "Splits light into colours that do not have names.")
                    ],
                    levelDef: {
                        name: "GLACIS SPIRES", diff: 2.38, depth: 10, boss: "king", bossHpMult: 1.9, completionBonus: 1800,
                        waveOpts: [["sniper", 3, 2, 1], ["orb", 3, 2, 1], ["phantom", 4, 2, 1], ["fdrone", 3, 2, 1],
                            ["drone", 2, 2, 1], ["core", 4, 2, 2], ["hunter", 4, 2, 2], ["stalker", 4, 1, 3]],
                        combos: [[["sniper", 3], ["core", 1]], [["phantom", 2], ["orb", 2]],
                            [["hunter", 2], ["sniper", 2]], [["fdrone", 3], ["phantom", 1]],
                            [["core", 2], ["stalker", 2]], [["orb", 2], ["hunter", 2]]],
                        elitePool: [["sniper", 1], ["shattered", 1], ["guardian", 2], ["shattered", 3]],
                        eliteSupport: "sniper",
                        secondElite: ["shattered", "guardian", "ravager"],
                        secondSupport: "phantom", secondSupportCount: 2,
                        env: {
                            floor: "rgba(6,12,30,0.85)", grid: "rgba(120,200,255,0.06)", border: [110, 190, 255],
                            neb: [[80, 150, 255], [150, 220, 255]], ambient: [[140, 210, 255], [90, 160, 255], [230, 245, 255]],
                            cracks: true, crackC: [170, 225, 255], debris: false, glitch: false,
                            pillars: true, pillarsN: 11, pillarC: [150, 215, 255], snow: true
                        }
                    }
                },
                {
                    id: 3, name: "HOARFROST DRIFT", coins: 1950,
                    star: "HOARFROST, a rogue star",
                    brief: "A star that left its galaxy and dragged its own debris field with it. The ice never stops moving, and neither does anything hunting in it.",
                    drivePiece: "DRIFT KEEL",
                    part: { system: "shield", name: "HOARFROST WARD" },
                    discoveries: [
                        d("g3s3_star", "star", "Hoarfrost", "Travelling at four hundred kilometres a second. Heading nowhere in particular."),
                        d("g3s3_wake", "belt", "The Wake", "A tail of shattered moons, still sorting itself by size."),
                        d("g3s3_pack", "signal", "The Pack Call", "Short bursts, many sources, closing."),
                        d("g3s3_skiff", "derelict", "Skiff Nine", "Holed from the inside. The crew left in a hurry, or did not leave.")
                    ],
                    levelDef: {
                        name: "HOARFROST DRIFT", diff: 2.46, depth: 10, boss: "null", bossHpMult: 2.7, completionBonus: 1900,
                        waveOpts: [["swarm", 5, 2, 1], ["chaser", 3, 2, 1], ["leaper", 4, 2, 1], ["stalker", 4, 2, 1],
                            ["fdrone", 3, 2, 1], ["hunter", 4, 2, 2], ["brute", 7, 1, 3]],
                        combos: [[["chaser", 3], ["leaper", 2]], [["stalker", 2], ["swarm", 4]],
                            [["leaper", 3], ["hunter", 1]], [["fdrone", 2], ["chaser", 3]],
                            [["stalker", 2], ["hunter", 2]], [["brute", 1], ["swarm", 4], ["chaser", 2]]],
                        elitePool: [["chaser", 1], ["ravager", 1], ["shattered", 2], ["ravager", 3]],
                        eliteSupport: "leaper",
                        secondElite: ["ravager", "shattered", "chaser"],
                        secondSupport: "swarm", secondSupportCount: 5,
                        env: {
                            floor: "rgba(10,16,28,0.84)", grid: "rgba(200,235,255,0.05)", border: [200, 235, 255],
                            neb: [[170, 220, 255], [110, 130, 220]], ambient: [[235, 248, 255], [180, 220, 255], [140, 180, 255]],
                            cracks: true, crackC: [170, 225, 255], debris: true, debrisBig: true, glitch: false, snow: true
                        }
                    }
                },
                {
                    id: 4, name: "THE CALVING", coins: 2100,
                    star: "NARVAL, an ice giant tearing itself apart",
                    brief: "Narval is shedding its moons one glacier at a time. Gravity here pulls in three directions at once, and the ice screams when it breaks.",
                    drivePiece: "CALVING ANCHOR",
                    part: { system: "cargo", name: "GLACIER HAULER" },
                    discoveries: [
                        d("g3s4_star", "star", "Narval", "Not a star. An ice giant bright enough to be mistaken for one."),
                        d("g3s4_berg", "moon", "The Berg", "A moon-sized glacier, freshly broken off. Still falling outward."),
                        d("g3s4_tide", "anomaly", "The Tidebreak", "Where three pulls cancel out. Nothing drifts into it; everything is placed there."),
                        d("g3s4_heart", "ruin", "The Calving Heart", "A frozen engine at the centre of the break. It is running in reverse.", true)
                    ],
                    levelDef: {
                        name: "THE CALVING", diff: 2.55, depth: 10, boss: "depths", bossHpMult: 1.35, completionBonus: 2050,
                        waveOpts: [["leech", 4, 1, 1], ["core", 4, 2, 1], ["orb", 3, 2, 1], ["drone", 2, 2, 1],
                            ["hunter", 4, 2, 2], ["phantom", 4, 2, 2], ["brute", 7, 1, 2], ["sniper", 3, 2, 2]],
                        combos: [[["leech", 2], ["sniper", 2]], [["singularity", 1], ["drone", 3]],
                            [["core", 2], ["leech", 1], ["orb", 1]], [["hunter", 2], ["phantom", 2]],
                            [["leech", 1], ["brute", 1], ["orb", 2]], [["singularity", 1], ["hunter", 2]]],
                        elitePool: [["brute", 1], ["singularity", 1], ["guardian", 2], ["singularity", 3]],
                        eliteSupport: "leech",
                        secondElite: ["singularity", "guardian", "shattered"],
                        secondSupport: "core", secondSupportCount: 2,
                        env: {
                            floor: "rgba(4,10,22,0.86)", grid: "rgba(100,170,255,0.05)", border: [100, 170, 255],
                            neb: [[60, 120, 230], [170, 230, 255]], ambient: [[120, 190, 255], [200, 235, 255], [80, 130, 255]],
                            cracks: true, crackC: [170, 225, 255], debris: true, debrisBig: true, glitch: false,
                            pillars: true, pillarsN: 5, pillarC: [120, 190, 255], channels: true, pressure: true, snow: true
                        }
                    }
                },
                {
                    id: 5, name: "CRYOVAULT", coins: 2300,
                    star: "SELKE, a brown dwarf",
                    brief: "A vault built to keep something asleep until the universe was ready for it. The power is failing, and the sleepers are waking early.",
                    drivePiece: "CRYO MATRIX",
                    part: { system: "weapon", name: "CRYO LANCE" },
                    discoveries: [
                        d("g3s5_star", "star", "Selke", "Too small to burn. Just warm enough to keep a vault running."),
                        d("g3s5_vault", "station", "The Cryovault", "Ten thousand berths. Most of them are open."),
                        d("g3s5_roll", "signal", "The Roll Call", "Names read aloud, one per minute. It is nearly at the end."),
                        d("g3s5_pod", "derelict", "Berth Zero", "The first pod. Sealed from the inside, and empty.")
                    ],
                    levelDef: {
                        name: "CRYOVAULT", diff: 2.65, depth: 10, boss: "eclipse", bossHpMult: 1.15, completionBonus: 2200,
                        waveOpts: [["phantom", 4, 2, 1], ["stalker", 4, 2, 1], ["hunter", 4, 2, 1], ["core", 4, 2, 1],
                            ["fdrone", 3, 2, 1], ["drone", 2, 2, 1], ["leaper", 4, 2, 2], ["leech", 4, 1, 3]],
                        combos: [[["phantom", 2], ["stalker", 2]], [["shattered", 1], ["fdrone", 2]],
                            [["hunter", 2], ["core", 2]], [["stalker", 3], ["leaper", 1]],
                            [["ravager", 1], ["phantom", 2]], [["leech", 1], ["hunter", 2], ["drone", 2]]],
                        elitePool: [["phantom", 1], ["shattered", 1], ["ravager", 2], ["guardian", 2], ["shattered", 3]],
                        eliteSupport: "stalker",
                        secondElite: ["shattered", "ravager", "singularity", "guardian"],
                        secondSupport: "phantom", secondSupportCount: 3,
                        env: {
                            floor: "rgba(8,8,24,0.88)", grid: "rgba(160,190,255,0.05)", border: [160, 180, 255],
                            neb: [[120, 140, 255], [200, 120, 255]], ambient: [[170, 200, 255], [210, 160, 255], [240, 250, 255]],
                            cracks: true, crackC: [170, 225, 255], debris: true, debrisBig: false, glitch: true,
                            pillars: true, pillarsN: 8, pillarC: [150, 170, 255], channels: true, pressure: true, snow: true
                        }
                    }
                },
                {
                    id: 6, name: "THE STILLPOINT", coins: 2800, finale: true,
                    star: "THE STILLPOINT, a star at absolute zero",
                    brief: "The coldest place that has ever existed. Motion stops here. Break what keeps it still, and the Expanse thaws.",
                    drivePiece: "STILL CORE",
                    part: { system: "hull", name: "ZERO-POINT PLATING" },
                    discoveries: [
                        d("g3s6_star", "star", "The Stillpoint", "Zero kelvin, exactly. Not approximately. Exactly."),
                        d("g3s6_ring", "belt", "The Halted Ring", "Every rock in it stopped mid-orbit at the same instant."),
                        d("g3s6_throne", "station", "The Cold Court", "A mirror of the Crimson Court. Someone built both."),
                        d("g3s6_ember", "anomaly", "The Last Ember", "One point of warmth at the centre of the cold. It is being guarded.", true)
                    ],
                    levelDef: {
                        name: "THE STILLPOINT", diff: 2.8, depth: 10, boss: "origin", bossHpMult: 1.15, completionBonus: 2600,
                        waveOpts: [["swarm", 5, 2, 1], ["chaser", 3, 2, 1], ["sniper", 3, 2, 1], ["brute", 7, 1, 1],
                            ["orb", 3, 2, 1], ["leaper", 4, 2, 1], ["stalker", 4, 2, 1], ["hunter", 4, 2, 1],
                            ["core", 4, 2, 2], ["phantom", 4, 2, 2], ["fdrone", 3, 2, 2], ["leech", 4, 1, 2]],
                        combos: [[["singularity", 1], ["stalker", 2]], [["guardian", 1], ["sniper", 2], ["orb", 1]],
                            [["leech", 2], ["hunter", 2]], [["shattered", 1], ["leaper", 2]],
                            [["ravager", 1], ["chaser", 3]], [["core", 2], ["phantom", 2], ["orb", 1]],
                            [["singularity", 1], ["leech", 1], ["drone", 2]]],
                        elitePool: [["ravager", 1], ["shattered", 1], ["guardian", 1], ["singularity", 1], ["singularity", 3]],
                        eliteSupport: "hunter",
                        secondElite: ["singularity", "guardian", "shattered", "ravager"],
                        secondSupport: "stalker", secondSupportCount: 3,
                        env: {
                            floor: "rgba(6,10,20,0.9)", grid: "rgba(230,245,255,0.05)", border: [230, 245, 255],
                            neb: [[180, 220, 255], [90, 110, 200]], ambient: [[255, 255, 255], [190, 225, 255], [140, 170, 255]],
                            cracks: true, crackC: [170, 225, 255], debris: true, debrisBig: true, glitch: true,
                            pillars: true, pillarsN: 10, pillarC: [220, 240, 255], channels: true, pressure: true, snow: true
                        }
                    }
                }
            ]
        },

        // -------------------------------------------------------------
        // GALAXIES 4-10 -- named, themed, and deliberately EMPTY.
        //
        // These are not placeholders that lie. A galaxy with no `systems`
        // is rendered as surveyed-but-unreachable ("DEEP SURVEY IN
        // PROGRESS"), never as a playable destination that dead-ends,
        // and the galaxy map masks the name entirely until the player is
        // within one galaxy of it (see galaxyKnown()) so the far end of
        // the universe stays unknown.
        //
        // Filling one in means giving it a `systems` array in the shape
        // Galaxies 2 and 3 use. That is the whole procedure.
        // -------------------------------------------------------------
        { id: 4,  name: "MACHINE GALAXY",  subtitle: "GALAXY 04", color: [160, 255, 220], accent: [90, 200, 160],
          theme: "Worlds machined into shape. The builders left; the factories did not stop.", systems: [] },
        { id: 5,  name: "THE LIVING REACH",subtitle: "GALAXY 05", color: [140, 255, 140], accent: [200, 255, 120],
          theme: "A galaxy with a pulse. The stations here were grown.", systems: [] },
        { id: 6,  name: "STELLAR GRAVEYARD",subtitle: "GALAXY 06", color: [200, 200, 220], accent: [255, 140, 120],
          theme: "Dead stars and the fleets that died arguing over them.", systems: [] },
        { id: 7,  name: "QUANTUM RIFT",    subtitle: "GALAXY 07", color: [220, 130, 255], accent: [120, 200, 255],
          theme: "Distance stops being reliable. So does arrival.", systems: [] },
        { id: 8,  name: "THE ANCIENTS",    subtitle: "GALAXY 08", color: [255, 220, 160], accent: [255, 160, 90],
          theme: "Someone was here first, at a scale that makes the question uncomfortable.", systems: [] },
        { id: 9,  name: "THE VOID",        subtitle: "GALAXY 09", color: [110, 110, 160], accent: [80, 60, 140],
          theme: "Almost no stars. Almost.", systems: [] },
        { id: 10, name: "THE UNKNOWN",     subtitle: "GALAXY 10", color: [255, 255, 255], accent: [200, 120, 255],
          theme: "No survey. No signal. No returning records.", systems: [] }
    ];

    var GALAXY_BY_ID = {};
    GALAXIES.forEach(function (g) { GALAXY_BY_ID[g.id] = g; });

    // =================================================================
    // LOOKUP AND PROGRESSION HELPERS
    //
    // All pure. Both the client and the server call these, and neither
    // keeps its own copy of any of these rules.
    // =================================================================

    function galaxyById(id) { return GALAXY_BY_ID[Math.floor(Number(id) || 0)] || null; }

    function systemAt(galaxyId, systemId) {
        var g = galaxyById(galaxyId);
        if (!g) return null;
        for (var i = 0; i < g.systems.length; i++) if (g.systems[i].id === systemId) return g.systems[i];
        return null;
    }

    // The save key for one system. Everything that records per-system
    // state (cleared, discovered, drive piece taken) is keyed by this,
    // which is why a galaxy can grow without colliding with another.
    function systemKey(galaxyId, systemId) { return galaxyId + ":" + systemId; }

    // How many systems a galaxy's Galaxy Drive needs. Reads the array --
    // a galaxy is as long as it is written to be.
    function driveTotal(galaxyId) {
        var g = galaxyById(galaxyId);
        return g ? g.systems.length : 0;
    }

    function isPlayable(galaxyId) { return driveTotal(galaxyId) > 0; }

    // Resolves a system's combat definition into the exact shape
    // voidbreak.html's LEVELS entries use. `levels` is that array, passed
    // in rather than imported, because the level table belongs to the
    // client and the server has no business holding one.
    function resolveLevel(system, levels) {
        if (!system) return null;
        if (system.levelDef) return system.levelDef;
        if (system.levelId && levels) {
            for (var i = 0; i < levels.length; i++) if (levels[i].id === system.levelId) return levels[i];
        }
        return null;
    }

    // ---- progress reads -------------------------------------------
    // Each takes the `universe` sub-object of a save (never the whole
    // save) so they are equally usable on the server's stored record and
    // the client's live one.

    function emptyUniverse() {
        return {
            galaxy: 1,
            systems: {},     // { "1:3": 1 }  -- cleared systems
            discovered: {},  // { "1:3": ["g1s3_star", ...] }
            drive: {},       // { "1": 5 }    -- drive pieces held, per galaxy
            ship: {},        // { hull: 2, ... }
            coins: 0,
            coinsSpent: 0,
            planet: { buildings: {}, decorations: {} } // plotIndex -> { id, level }
        };
    }

    function systemCleared(u, galaxyId, systemId) {
        return !!(u && u.systems && u.systems[systemKey(galaxyId, systemId)]);
    }

    function clearedInGalaxy(u, galaxyId) {
        var g = galaxyById(galaxyId);
        if (!g || !u || !u.systems) return 0;
        var n = 0;
        for (var i = 0; i < g.systems.length; i++) if (systemCleared(u, galaxyId, g.systems[i].id)) n++;
        return n;
    }

    function totalCleared(u) {
        if (!u || !u.systems) return 0;
        return Object.keys(u.systems).filter(function (k) { return !!u.systems[k]; }).length;
    }

    function drivePieces(u, galaxyId) {
        if (!u || !u.drive) return 0;
        return Math.max(0, Math.floor(Number(u.drive[String(galaxyId)]) || 0));
    }

    // A galaxy's drive is complete when its pieces meet its system count.
    // An unwritten galaxy (no systems) can never be complete, which is
    // what stops progression running off the end of the authored
    // universe.
    function driveComplete(u, galaxyId) {
        var total = driveTotal(galaxyId);
        return total > 0 && drivePieces(u, galaxyId) >= total;
    }

    function galaxiesCleared(u) {
        var n = 0;
        for (var i = 0; i < GALAXIES.length; i++) if (driveComplete(u, GALAXIES[i].id)) n++;
        return n;
    }

    // Galaxy 1 is always open. Every later galaxy needs the previous
    // one's drive finished.
    function galaxyUnlocked(u, galaxyId) {
        var id = Math.floor(Number(galaxyId) || 0);
        if (id <= 1) return true;
        return driveComplete(u, id - 1);
    }

    // The furthest galaxy the player can currently travel to.
    function highestUnlockedGalaxy(u) {
        var best = 1;
        for (var i = 0; i < GALAXIES.length; i++) {
            if (galaxyUnlocked(u, GALAXIES[i].id)) best = Math.max(best, GALAXIES[i].id);
        }
        return best;
    }

    // Whether the galaxy's NAME is known. One past the furthest unlocked
    // galaxy is named (so there is always something visible to aim at);
    // everything beyond that reads DATA UNAVAILABLE. This is the
    // anticipation rule from the GDD, in one function.
    function galaxyKnown(u, galaxyId) {
        return Math.floor(Number(galaxyId) || 0) <= highestUnlockedGalaxy(u) + 1;
    }

    // A system opens when the one before it in its galaxy is cleared.
    // The first system of an unlocked galaxy is always open.
    function systemUnlocked(u, galaxyId, systemId) {
        if (!galaxyUnlocked(u, galaxyId)) return false;
        var g = galaxyById(galaxyId);
        if (!g) return false;
        var idx = -1;
        for (var i = 0; i < g.systems.length; i++) if (g.systems[i].id === systemId) { idx = i; break; }
        if (idx < 0) return false;
        if (idx === 0) return true;
        return systemCleared(u, galaxyId, g.systems[idx - 1].id);
    }

    // ---- discovery -------------------------------------------------

    function discoveredIn(u, galaxyId, systemId) {
        if (!u || !u.discovered) return [];
        var list = u.discovered[systemKey(galaxyId, systemId)];
        return Array.isArray(list) ? list : [];
    }

    function isDiscovered(u, galaxyId, systemId, discoveryId) {
        return discoveredIn(u, galaxyId, systemId).indexOf(discoveryId) !== -1;
    }

    // How many sites a visit reveals before the system is cleared: the
    // star, plus whatever the ship's scanner and the Observatory can
    // pick up from outside. Clearing the system reveals the rest -- so
    // survey gear buys you the system's secrets EARLY, and never buys
    // you something you could not eventually get by fighting for it.
    function surveyReveal(u) {
        var scanner = shipLevel(u, "scanner");
        var obs = buildingLevel(u, "observatory");
        var b = BUILDING_BY_ID.observatory;
        return 1 + scanner + obs * ((b && b.surveyPerLevel) || 0);
    }

    // Decorations unlocked by what has actually been found.
    function unlockedDecorations(u) {
        var out = [];
        for (var i = 0; i < DECORATIONS.length; i++) {
            var dec = DECORATIONS[i];
            if (!dec.from) { out.push(dec.id); continue; }
            var found = false;
            if (u && u.discovered) {
                var keys = Object.keys(u.discovered);
                for (var k = 0; k < keys.length && !found; k++) {
                    var list = u.discovered[keys[k]];
                    if (Array.isArray(list) && list.indexOf(dec.from) !== -1) found = true;
                }
            }
            if (found) out.push(dec.id);
        }
        return out;
    }

    // ---- ship ------------------------------------------------------

    function shipLevel(u, systemId) {
        if (!u || !u.ship) return 0;
        return Math.max(0, Math.min(SHIP_PART_MAX, Math.floor(Number(u.ship[systemId]) || 0)));
    }

    function shipPower(u) {
        return {
            hull:    shipLevel(u, "hull"),
            engine:  shipLevel(u, "engine"),
            weapon:  shipLevel(u, "weapon"),
            shield:  shipLevel(u, "shield"),
            energy:  shipLevel(u, "energy"),
            scanner: shipLevel(u, "scanner"),
            cargo:   shipLevel(u, "cargo")
        };
    }

    // ---- planet ----------------------------------------------------

    function buildingAt(u, plot) {
        if (!u || !u.planet || !u.planet.buildings) return null;
        return u.planet.buildings[String(plot)] || null;
    }

    function buildingLevel(u, buildingId) {
        if (!u || !u.planet || !u.planet.buildings) return 0;
        var best = 0, b = u.planet.buildings, keys = Object.keys(b);
        for (var i = 0; i < keys.length; i++) {
            var e = b[keys[i]];
            if (e && e.id === buildingId) best = Math.max(best, Math.floor(Number(e.level) || 0));
        }
        return best;
    }

    function hasBuilding(u, buildingId) { return buildingLevel(u, buildingId) > 0; }

    function countBuildings(u) {
        if (!u || !u.planet || !u.planet.buildings) return 0;
        return Object.keys(u.planet.buildings).length;
    }

    // What the NEXT copy/level of a building costs. A second Command
    // Center is not a thing, so cost is expressed per building id at its
    // current level: level 0 -> `cost`, each level after -> costPerLevel.
    function buildingCost(u, buildingId) {
        var b = BUILDING_BY_ID[buildingId];
        if (!b) return null;
        var lv = buildingLevel(u, buildingId);
        if (lv >= b.maxLevel) return null;
        return lv === 0 ? b.cost : b.costPerLevel;
    }

    // Whether the requirement gate on a building is satisfied. Purely a
    // read of stored progress -- never of anything the client asserts.
    function buildingRequirementMet(u, buildingId) {
        var b = BUILDING_BY_ID[buildingId];
        if (!b || !b.requires) return true;
        if (b.requires.building && !hasBuilding(u, b.requires.building)) return false;
        if (b.requires.galaxiesCleared && galaxiesCleared(u) < b.requires.galaxiesCleared) return false;
        return true;
    }

    function requirementText(buildingId) {
        var b = BUILDING_BY_ID[buildingId];
        if (!b || !b.requires) return "";
        if (b.requires.building) {
            var need = BUILDING_BY_ID[b.requires.building];
            return "NEEDS " + (need ? need.name : b.requires.building.toUpperCase());
        }
        if (b.requires.galaxiesCleared) {
            return "NEEDS " + b.requires.galaxiesCleared + " GALAXY DRIVE" + (b.requires.galaxiesCleared === 1 ? "" : "S") + " COMPLETED";
        }
        return "";
    }

    function spendableCoins(u) {
        if (!u) return 0;
        return Math.max(0, (Math.floor(Number(u.coins) || 0)) - (Math.floor(Number(u.coinsSpent) || 0)));
    }

    // Coin income multiplier from the colony and the ship's cargo bay.
    // Deliberately the ONLY mechanical effect the planet has, and it is
    // on income rather than on combat -- a player who never builds
    // anything is slower to build, not weaker in a fight.
    function coinMultiplier(u) {
        var m = 1;
        for (var i = 0; i < BUILDINGS.length; i++) {
            var b = BUILDINGS[i];
            if (!b.coinBonusPerLevel) continue;
            m += buildingLevel(u, b.id) * b.coinBonusPerLevel;
        }
        var cargo = SHIP_SYSTEM_BY_ID.cargo;
        m += shipLevel(u, "cargo") * (cargo ? cargo.per : 0);
        return m;
    }

    return {
        DISCOVERY_KINDS: DISCOVERY_KINDS,
        SHIP_SYSTEMS: SHIP_SYSTEMS,
        SHIP_SYSTEM_IDS: SHIP_SYSTEM_IDS,
        SHIP_SYSTEM_BY_ID: SHIP_SYSTEM_BY_ID,
        SHIP_PART_MAX: SHIP_PART_MAX,
        BUILDINGS: BUILDINGS,
        BUILDING_BY_ID: BUILDING_BY_ID,
        DECORATIONS: DECORATIONS,
        DECORATION_BY_ID: DECORATION_BY_ID,
        PLOT_COUNT: PLOT_COUNT,
        PLOTS_AT_START: PLOTS_AT_START,
        PLOTS_PER_SYSTEM: PLOTS_PER_SYSTEM,
        plotsUnlocked: plotsUnlocked,
        plotsUnlockedFor: plotsUnlockedFor,
        GALAXIES: GALAXIES,
        galaxyById: galaxyById,
        systemAt: systemAt,
        systemKey: systemKey,
        driveTotal: driveTotal,
        isPlayable: isPlayable,
        resolveLevel: resolveLevel,
        emptyUniverse: emptyUniverse,
        systemCleared: systemCleared,
        clearedInGalaxy: clearedInGalaxy,
        totalCleared: totalCleared,
        drivePieces: drivePieces,
        driveComplete: driveComplete,
        galaxiesCleared: galaxiesCleared,
        galaxyUnlocked: galaxyUnlocked,
        highestUnlockedGalaxy: highestUnlockedGalaxy,
        galaxyKnown: galaxyKnown,
        systemUnlocked: systemUnlocked,
        discoveredIn: discoveredIn,
        isDiscovered: isDiscovered,
        surveyReveal: surveyReveal,
        unlockedDecorations: unlockedDecorations,
        shipLevel: shipLevel,
        shipPower: shipPower,
        buildingAt: buildingAt,
        buildingLevel: buildingLevel,
        hasBuilding: hasBuilding,
        countBuildings: countBuildings,
        buildingCost: buildingCost,
        buildingRequirementMet: buildingRequirementMet,
        requirementText: requirementText,
        spendableCoins: spendableCoins,
        coinMultiplier: coinMultiplier
    };
});
