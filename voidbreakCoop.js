// =====================================================================
// VOIDBREAK CO-OP -- the SHARED, SERVER-AUTHORITATIVE PvE simulation.
//
// Why this module exists
// ---------------------
// Solo Voidbreak (voidbreak.html) is a fully client-side game: the
// browser owns the enemies, the waves, the damage and the shard payout,
// and voidbreak.js on the server only validates the SAVE that comes back
// afterwards. That model cannot be shared. Two browsers each running
// their own copy of the same run would disagree about every enemy's
// position and health within a second, and "one authoritative shared
// match state" would be a fiction.
//
// So co-op does not duplicate the game per player. This module runs ONE
// simulation, on the server, for the whole party, and owns:
//
//   * which enemies exist, where they are and how much health they have
//   * enemy shooting, enemy contact damage, and therefore PLAYER health
//   * wave composition, wave progression and the run's objectives
//   * Void Upgrade offers and which one each player actually got
//   * shards earned, kills, run completion and failure
//   * every timer that decides a state transition
//
// Clients own what clients are good at: their own input, their own
// movement, and all presentation. They render enemies from the
// snapshots below using voidbreak.html's OWN createEnemy()/drawEnemy()
// pipeline -- the visuals are the existing ones, not a second set.
//
// What a client still decides, and why
// ------------------------------------
// PLAYER->ENEMY hit detection stays on the shooter's machine, and is
// reported as "this shot connected on enemy N". That is the same trust
// tier combat.js already documents for PvP: the shooter's own view is
// the only one that is not a network trip stale, and the server refuses
// to take a damage NUMBER from it -- the amount is computed here, from
// this module's own weapon table and the player's own STORED forge
// levels, and is rate-limited against the weapon's real fire rate.
// ENEMY->PLAYER damage has no such compromise: the server owns both
// sides of it and simply applies it.
//
// Numbers below mirror voidbreak.html's ETYPES / WEAPONS / LEVELS /
// DIFFICULTY_MODES deliberately -- the same pattern combat.js uses for
// index.html's combat constants. This file does not invent a second
// Voidbreak balance; it re-states the existing one so the server can
// simulate it.
//
// Pure module: no sockets, no storage, no timers of its own. server.js
// owns the rooms, the clock and the broadcasting.
// =====================================================================

// ---------------------------------------------------------------------
// MIRRORED CONSTANTS (voidbreak.html)
// ---------------------------------------------------------------------

// ETYPES, exactly as voidbreak.html defines them.
const ETYPES = {
    drone:       { hp: 34,  speed: 150, r: 13, cdmg: 12, shards: 2 },
    brute:       { hp: 210, speed: 52,  r: 26, cdmg: 20, shards: 8 },
    swarm:       { hp: 12,  speed: 195, r: 8,  cdmg: 6,  shards: 1 },
    sniper:      { hp: 48,  speed: 85,  r: 14, cdmg: 0,  shards: 3 },
    chaser:      { hp: 40,  speed: 235, r: 12, cdmg: 16, shards: 3 },
    phantom:     { hp: 56,  speed: 72,  r: 14, cdmg: 14, shards: 4 },
    fdrone:      { hp: 46,  speed: 178, r: 13, cdmg: 11, shards: 3 },
    ravager:     { hp: 400, speed: 60,  r: 30, cdmg: 22, shards: 14 },
    leaper:      { hp: 52,  speed: 205, r: 13, cdmg: 15, shards: 4 },
    core:        { hp: 66,  speed: 0,   r: 17, cdmg: 9,  shards: 5 },
    shattered:   { hp: 190, speed: 92,  r: 22, cdmg: 18, shards: 16 },
    stalker:     { hp: 64,  speed: 230, r: 13, cdmg: 16, shards: 4 },
    orb:         { hp: 60,  speed: 70,  r: 15, cdmg: 10, shards: 4 },
    guardian:    { hp: 250, speed: 52,  r: 27, cdmg: 20, shards: 16 },
    hunter:      { hp: 70,  speed: 120, r: 14, cdmg: 12, shards: 5 },
    leech:       { hp: 80,  speed: 42,  r: 16, cdmg: 8,  shards: 5 },
    singularity: { hp: 260, speed: 40,  r: 30, cdmg: 18, shards: 18 }
};

// How each enemy type behaves. voidbreak.html gives every type its own
// bespoke state machine (teleport phases, lunge windups, orbit release
// cycles and so on); reproducing all seventeen of those here verbatim
// would be a second copy of ~1,200 lines of client code with no way to
// keep the two in step. Instead each type is mapped to the ARCHETYPE its
// client behaviour belongs to, and the archetype is simulated with that
// type's own real speed/health/damage/range numbers. What a player sees
// is the same enemy, drawn by the same renderer, moving in the same
// broad way -- see the LIMITATIONS note at the bottom of this file.
const AI_ROLE = {
    swarm: "rush", chaser: "rush", leaper: "rush", stalker: "rush",
    brute: "heavy", ravager: "heavy", shattered: "heavy",
    guardian: "heavy", singularity: "heavy",
    drone: "orbit", fdrone: "orbit", hunter: "orbit",
    sniper: "standoff", orb: "standoff",
    core: "turret",
    phantom: "blink",
    leech: "rush"
};

// Weapon stats, mirrored. Only the fields the SERVER needs to decide a
// damage number and a legal fire rate -- colours, sounds, spread and
// projectile art stay on the client, where they are only ever drawn.
// `targets` is how many enemies ONE activation can legitimately connect
// with beyond its own projectile count: a plasma orb detonates, a Void
// Blade sweeps an arc, a railgun's pierce is already counted by
// `pierce`. It exists only to size the anti-spam gate in claimHit --
// without it an honest Void Blade sweeping six enemies looks exactly
// like a client spamming claims, and gets its real hits refused.
const WEAPONS = {
    pulse:   { dmg: 12, rate: 6.2, count: 1, pierce: 0,  targets: 1 },
    scatter: { dmg: 8,  rate: 1.8, count: 6, pierce: 0,  targets: 1 },
    rail:    { dmg: 80, rate: 0.85, count: 1, pierce: 99, targets: 1 },
    plasma:  { dmg: 18, rate: 1.5, count: 1, pierce: 0,  targets: 8,  explodes: true },
    voidb:   { dmg: 30, rate: 2.7, count: 1, pierce: 0,  targets: 8,  melee: true, range: 112 },
    voidc:   { dmg: 55, rate: 0.9, count: 1, pierce: 0,  targets: 10, explodes: true }
};
const WEAPON_KEYS = Object.keys(WEAPONS);

// Per-level wave composition, mirrored from LEVELS in voidbreak.html.
// `waveOpts` entries are [type, budgetCost, maxPerGroup, minDepth],
// exactly as the client's own makeWaves() reads them.
const LEVELS = [
    { id: 1, name: "THE COLLAPSE", diff: 1.00, completionBonus: 200,
      waveOpts: [["swarm",5,1,1],["drone",2,2,1],["sniper",3,3,2],["chaser",3,3,2],["brute",7,1,3]],
      combos: [],
      elitePool: [["drone",1],["sniper",1],["chaser",1],["brute",4]],
      eliteSupport: "drone" },
    { id: 2, name: "THE FRACTURE", diff: 1.22, completionBonus: 300,
      waveOpts: [["swarm",5,2,1],["drone",2,2,1],["sniper",3,2,2],["chaser",3,2,1],["brute",7,1,2],["phantom",4,2,3],["fdrone",3,2,2]],
      combos: [[["drone",2],["phantom",1]],[["sniper",2],["chaser",2]],[["brute",1],["fdrone",2]]],
      elitePool: [["drone",1],["sniper",1],["chaser",1],["brute",2],["ravager",3]],
      eliteSupport: "fdrone" },
    { id: 3, name: "THE COLLAPSE", diff: 1.32, completionBonus: 400,
      waveOpts: [["swarm",5,2,1],["drone",2,2,1],["sniper",3,2,2],["chaser",3,2,1],["brute",7,1,2],["phantom",4,2,2],["fdrone",3,2,1],["leaper",4,2,2],["core",4,2,3]],
      combos: [[["drone",2],["chaser",2]],[["phantom",2],["chaser",2]],[["core",2],["leaper",3]]],
      elitePool: [["drone",1],["sniper",1],["chaser",1],["brute",2],["ravager",2],["shattered",3]],
      eliteSupport: "fdrone" },
    { id: 4, name: "THE ABYSS", diff: 1.42, completionBonus: 500,
      waveOpts: [["swarm",5,2,1],["drone",2,2,1],["sniper",3,2,2],["chaser",3,2,1],["brute",7,1,2],["phantom",4,2,2],["fdrone",3,2,1],["leaper",4,2,2],["core",4,2,2],["stalker",4,2,2],["orb",3,2,2]],
      combos: [[["stalker",1],["orb",2],["chaser",2]],[["orb",2],["sniper",2]],[["core",2],["stalker",2]]],
      elitePool: [["drone",1],["sniper",1],["chaser",1],["brute",2],["ravager",2],["shattered",2],["guardian",3]],
      eliteSupport: "orb" },
    { id: 5, name: "THE DESCENT", diff: 1.52, completionBonus: 600,
      waveOpts: [["swarm",5,2,1],["drone",2,2,1],["sniper",3,2,2],["chaser",3,2,1],["brute",7,1,2],["phantom",4,2,2],["fdrone",3,2,1],["leaper",4,2,2],["core",4,2,2],["stalker",4,2,2],["orb",3,2,2],["hunter",4,2,2],["leech",4,1,2]],
      combos: [[["hunter",2],["chaser",2]],[["leech",1],["sniper",2]],[["core",2],["hunter",2]]],
      elitePool: [["drone",1],["sniper",1],["chaser",1],["brute",2],["ravager",2],["shattered",2],["guardian",2],["singularity",2]],
      eliteSupport: "hunter" },
    { id: 6, name: "THE RIFT", diff: 1.62, completionBonus: 700,
      waveOpts: [["swarm",5,2,1],["drone",2,2,1],["sniper",3,2,2],["chaser",3,2,1],["brute",7,1,2],["phantom",4,2,2],["fdrone",3,2,1],["leaper",4,2,2],["core",4,2,2],["stalker",4,2,2],["orb",3,2,2],["hunter",4,2,2],["leech",4,1,2]],
      combos: [[["chaser",3],["fdrone",2]],[["stalker",1],["orb",1],["hunter",2]],[["core",2],["leaper",2]]],
      elitePool: [["drone",1],["sniper",1],["chaser",1],["brute",2],["ravager",2],["shattered",2],["guardian",2],["singularity",3]],
      eliteSupport: "hunter" },
    { id: 7, name: "THE HOLLOW", diff: 1.72, completionBonus: 800,
      waveOpts: [["swarm",5,2,1],["drone",2,2,1],["sniper",3,2,2],["chaser",3,2,1],["brute",7,1,2],["phantom",4,2,2],["fdrone",3,2,1],["leaper",4,2,2],["core",4,2,2],["stalker",4,2,2],["orb",3,2,2],["hunter",4,2,2],["leech",4,1,2]],
      combos: [[["leech",2],["hunter",2]],[["singularity",1],["drone",3]],[["core",2],["orb",2]]],
      elitePool: [["drone",1],["sniper",1],["chaser",1],["brute",2],["ravager",2],["shattered",2],["guardian",2],["singularity",3]],
      eliteSupport: "leech" },
    { id: 8, name: "THE ORIGIN", diff: 1.85, completionBonus: 1000,
      waveOpts: [["swarm",5,2,1],["drone",2,2,1],["sniper",3,2,2],["chaser",3,2,1],["brute",7,1,2],["phantom",4,2,2],["fdrone",3,2,1],["leaper",4,2,2],["core",4,2,2],["stalker",4,2,2],["orb",3,2,2],["hunter",4,2,2],["leech",4,1,2]],
      combos: [[["singularity",1],["hunter",2]],[["shattered",1],["stalker",2]],[["core",2],["chaser",2]]],
      elitePool: [["drone",1],["sniper",1],["chaser",1],["brute",1],["ravager",2],["shattered",2],["guardian",2],["singularity",2]],
      eliteSupport: "hunter" }
];

// Mirrored from DIFFICULTY_MODES.
const DIFFICULTY_MODES = {
    normal:  { id: "normal",  shardMult: 1.0, hpMult: 1.00, dmgMult: 1.00, speedMult: 1.00, spawnMult: 1.00 },
    hard:    { id: "hard",    shardMult: 1.5, hpMult: 1.22, dmgMult: 1.25, speedMult: 1.08, spawnMult: 1.15 },
    extreme: { id: "extreme", shardMult: 2.0, hpMult: 1.45, dmgMult: 1.55, speedMult: 1.15, spawnMult: 1.30 }
};

// =====================================================================
// THE FINALE GUARDIAN
//
// A co-op run ends on a RANDOMLY DRAWN Guardian, not the sector's own.
// Which one you get is decided here, by the run's own RNG, and is not
// something a client asks for.
//
// How this can be server-authoritative without porting 1,200 lines of
// boss AI: voidbreak.html's eight boss RENDERERS read nothing but
// scalars -- x, y, r, t, phase, hitFlash, eye, invuln, vulnT, and
// coreMode for the two core bosses. So the server owns the FIGHT (where
// it is, what it is doing, how much health it has, which phase it is
// in, when it is vulnerable, what it summons, when it dies) and the
// client draws the real Guardian with the real art, the real phase
// banners, the real HP bar and the real intro. Nothing is re-drawn or
// re-skinned here.
//
// What is NOT a port: each Guardian's exact attack script. Instead each
// is mapped to the STYLE its own fight is built around, and the style
// is simulated with that Guardian's own radius, phase thresholds and
// summon composition (all mirrored from BOSSMETA). See LIMITATIONS.
const BOSS_STYLES = ["orbiter", "charger", "sweeper", "blinker", "core"];

const BOSSES = [
    { kind: "null",     name: "THE NULL",             r: 56, thresholds: [0.70, 0.35], style: "orbiter",
      adds: { 2: [["chaser", 2]],                 3: [["chaser", 2]] } },
    { kind: "king",     name: "THE FRACTURED KING",   r: 64, thresholds: [0.65, 0.30], style: "charger",
      adds: { 2: [["phantom", 2]],                3: [["phantom", 1], ["fdrone", 2]] } },
    { kind: "archon",   name: "THE COLLAPSED ARCHON", r: 68, thresholds: [0.65, 0.30], style: "sweeper",
      adds: { 2: [["phantom", 2]],                3: [["leaper", 2], ["phantom", 1]] } },
    { kind: "warden",   name: "THE ABYSSAL WARDEN",   r: 66, thresholds: [0.65, 0.30], style: "sweeper",
      adds: { 2: [["stalker", 2]],                3: [["stalker", 1], ["orb", 2]] } },
    { kind: "depths",   name: "THE DEPTHS",           r: 76, thresholds: [0.65, 0.30], style: "core",
      adds: { 2: [["leech", 2]],                  3: [["hunter", 2]] } },
    { kind: "sentinel", name: "THE SENTINEL",         r: 70, thresholds: [0.65, 0.30], style: "charger",
      adds: { 2: [["stalker", 2]],                3: [["shattered", 1], ["chaser", 2]] } },
    { kind: "eclipse",  name: "THE ECLIPSE",          r: 72, thresholds: [0.65, 0.30], style: "blinker",
      adds: { 2: [["leech", 2]],                  3: [["singularity", 1], ["hunter", 2]] } },
    { kind: "origin",   name: "THE ORIGIN",           r: 88, thresholds: [0.62, 0.28], style: "core",
      adds: { 2: [["guardian", 1], ["stalker", 2]], 3: [["singularity", 1], ["shattered", 1]] } }
];

// The Guardian answers hit claims on this reserved id. Enemy ids start
// at 1, so it can never collide with one.
const BOSS_ID = 0;

// Solo Guardians range from 5,200 health (The Null) to 16,500 (The
// Origin) -- a 3x spread that is part of each one's identity when you
// fight it at the end of ITS OWN sector. Drawn at random it would just
// be a coin flip between a short fight and a long one, so a co-op
// Guardian's health comes from a CO-OP budget instead: the sector's
// difficulty, the party's size, and the run's difficulty mode. Which
// Guardian you draw decides how the fight LOOKS and PLAYS, never how
// long it takes.
const BOSS_BASE_HP = 5200;
const BOSS_HP_PER_EXTRA_PLAYER = 0.85;
const BOSS_CONTACT_DMG = 22;
const BOSS_SHOT_DMG = 13;
const BOSS_PHASE_INVULN_MS = 1500;
const BOSS_VULN_WINDOW_MS = 2600;   // after a big attack: the opening to punish
const BOSS_SHARDS = 220;            // paid to every player, on top of the clear bonus

// The Void Upgrades a co-op run can offer. A subset of voidbreak.html's
// UPGRADES: exactly the ones whose effect this simulation can actually
// honour (a damage multiplier it applies, a max-health change it owns).
// Purely visual or client-physics upgrades (bullet speed, dash distance,
// projectile count) are left out rather than offered and silently
// ignored, which would be worse than not offering them.
const COOP_UPGRADES = [
    { id: "dmg",       name: "VOID AMPLIFIER",   desc: "+25% weapon damage.",                  rar: "c" },
    { id: "maxhp",     name: "REINFORCED SHELL", desc: "+25 max health, restored immediately.", rar: "c" },
    { id: "crit",      name: "NULL PIERCER",     desc: "+10% critical chance.",                rar: "r" },
    { id: "lifesteal", name: "SIPHON CORE",      desc: "Restore 4 HP on every kill.",          rar: "r" },
    { id: "firerate",  name: "OVERCLOCK",        desc: "+18% fire rate.",                      rar: "c" },
    { id: "pierce",    name: "LANCE ROUNDS",     desc: "Projectiles pierce +1 enemy.",         rar: "r" }
];

// ---------------------------------------------------------------------
// CO-OP TUNING
//
// How a run scales from 2 to 4 players. The brief is explicit that this
// must NOT be "enemies get absurd health", and it isn't: the dominant
// lever is HOW MANY enemies spawn and how many of them are elites --
// i.e. the same spawn-budget and elite-frequency machinery the solo game
// already uses for depth and difficulty. Health moves only a little
// (a 4-player enemy has 28% more health than a solo one, not 4x), and
// per-hit enemy DAMAGE does not scale at all, because scaling that would
// punish a group for being a group without making the fight richer.
const PLAYER_SCALING = {
    1: { spawn: 1.00, hp: 1.00, elites: 0 },
    2: { spawn: 1.75, hp: 1.12, elites: 0 },
    3: { spawn: 2.40, hp: 1.20, elites: 1 },
    4: { spawn: 3.00, hp: 1.28, elites: 1 }
};

// Run shape. Eight waves in one sector: the 4th is an elite wave (the
// existing "elite chamber" mechanic) and the 8th is the GUARDIAN -- a
// randomly drawn one of the game's eight, see BOSSES above.
const TOTAL_WAVES = 8;
const ELITE_WAVES = [4];
const BOSS_WAVE = 8;
const UPGRADE_AFTER_WAVES = [2, 4, 6];

// One arena for the whole run (the client never has to load a second
// room mid-run, and there is no branching path to keep four clients in
// agreement about). Matches ROOMMETA.combat's size in voidbreak.html.
const ROOM = { w: 1600, h: 1000 };

const TICK_MS = 50;                 // 20Hz simulation
const SNAPSHOT_EVERY_TICKS = 2;     // 10Hz enemy snapshots
const PLAYER_R = 15;
const MAX_ENEMIES = 80;             // hard safety cap on one run's roster
const MAX_EBULLETS = 220;
const PLAYER_INVULN_MS = 700;       // mirrors hurtPlayer()'s p.invuln = 0.7
const WAVE_GAP_MS = 2600;           // breathing room between waves
const RESPAWN_HP_FRACTION = 0.5;    // a dead player rejoins the next wave at half health
const POSITION_STALE_MS = 3000;     // a player whose client stopped reporting is not a valid target
const SHARD_BONUS_PER_WAVE = 12;

// A hit claim is refused if it arrives faster than the weapon could
// physically have fired it, with this much headroom for burst weapons,
// pierce and honest network jitter.
const CLAIM_RATE_HEADROOM = 2.5;
const CLAIM_RATE_FLOOR = 12;        // claims/sec allowed even for the slowest weapon
const CLAIM_MAX_RANGE = 1400;       // a claim from further away than the arena is nonsense

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }

// ---------------------------------------------------------------------
// THE RUN
//
// players: [{ slot, sub, name, weapon, forge, prestigeLevel }]
//   `forge` comes from the player's OWN STORED Voidbreak save, read
//   server-side by server.js -- never from anything the client sends,
//   which is what stops a modified client claiming max forge levels.
// ---------------------------------------------------------------------
function createRun(opts) {
    const levelIdx = clamp(Math.floor(Number(opts.levelIdx) || 0), 0, LEVELS.length - 1);
    const level = LEVELS[levelIdx];
    const diff = DIFFICULTY_MODES[opts.difficulty] || DIFFICULTY_MODES.normal;
    const random = opts.random || Math.random;

    const rand = (a, b) => a + random() * (b - a);
    const randi = (a, b) => Math.floor(rand(a, b + 1));
    const pick = arr => arr[Math.floor(random() * arr.length)];

    const playerCount = clamp(opts.players.length, 1, 4);
    const scaling = PLAYER_SCALING[playerCount] || PLAYER_SCALING[4];

    const players = {};
    for (const p of opts.players) {
        const forge = p.forge || {};
        const vit = clamp(Math.floor(Number(forge.vit) || 0), 0, 999);
        const pow = clamp(Math.floor(Number(forge.pow) || 0), 0, 999);
        const edge = clamp(Math.floor(Number(forge.edge) || 0), 0, 999);
        const maxhp = 100 + 20 * vit;
        players[p.slot] = {
            slot: p.slot,
            sub: p.sub,
            name: p.name,
            weapon: WEAPONS[p.weapon] ? p.weapon : "pulse",
            // Live position, reported by that player's own client. Never
            // used to move anybody -- only to decide what enemies chase
            // and what enemy attacks connect with.
            x: 0, y: ROOM.h / 2 - 150, ang: 0,
            reportedAt: 0,
            hp: maxhp, maxhp: maxhp,
            baseMaxhp: maxhp,
            dmgMult: 1 + 0.10 * pow,
            crit: 0.05 + 0.04 * edge,
            fireRateMult: 1,
            pierceAdd: 0,
            lifesteal: 0,
            alive: true, connected: true,
            invulnUntil: 0,
            upgrades: {},
            pendingUpgrade: null,      // { choices:[ids], waveIndex }
            // Per-run totals. These are what eventually become rewards,
            // and they are only ever added to HERE.
            shards: 0, kills: 0, damage: 0, downs: 0,
            claimTimes: [],            // rolling window for the fire-rate gate
            rewarded: false
        };
    }

    const run = {
        id: opts.id,
        levelIdx: levelIdx,
        level: level,
        difficultyId: diff.id,
        playerCount: playerCount,
        room: { w: ROOM.w, h: ROOM.h },
        // "waiting" -> pre-wave gap; "fighting"; "complete"; "failed"
        phase: "waiting",
        waveIndex: 0,               // waves finished
        waveActive: 0,              // index of the wave being fought (1-based)
        nextWaveAt: 0,
        startedAt: 0,
        endedAt: 0,
        players: players,
        enemies: [],
        ebullets: [],
        spawnQueue: [],
        boss: null,
        tickCount: 0,
        nextEnemyId: 1,
        nextBulletId: 1,
        events: [],
        lastTickAt: 0
    };

    // ---- helpers over run state ------------------------------------
    function alivePlayers() {
        const out = [];
        for (const slot of Object.keys(players)) {
            const p = players[slot];
            if (p.alive && p.connected) out.push(p);
        }
        return out;
    }

    function activePlayers() {
        const out = [];
        for (const slot of Object.keys(players)) {
            if (players[slot].connected) out.push(players[slot]);
        }
        return out;
    }

    // A player whose client has stopped reporting a position is not a
    // valid target: chasing a frozen ghost would pile the whole wave on
    // a coordinate nobody is standing on.
    function targetablePlayers(now) {
        return alivePlayers().filter(p => now - p.reportedAt < POSITION_STALE_MS);
    }

    function nearestPlayer(x, y, now) {
        const candidates = targetablePlayers(now);
        let best = null, bestD = Infinity;
        for (const p of candidates) {
            const d = dist(x, y, p.x, p.y);
            if (d < bestD) { bestD = d; best = p; }
        }
        return best ? { player: best, d: bestD } : null;
    }

    function emit(ev) { run.events.push(ev); }

    // ---- wave composition -------------------------------------------
    // A port of voidbreak.html's makeWaves() budget loop, with the
    // player-count spawn multiplier folded into the same budget the
    // depth and difficulty multipliers already use. Scaling the BUDGET
    // is what makes a 4-player wave a bigger fight rather than a
    // spongier one.
    function buildWave(waveNo) {
        const depth = waveNo; // waves 1..8 map onto the solo depth curve
        const isElite = ELITE_WAVES.indexOf(waveNo) !== -1;

        if (isElite) {
            const pool = level.elitePool.filter(o => depth >= o[1]).map(o => o[0]);
            const groups = [];
            const eliteCount = 1 + scaling.elites + (waveNo === TOTAL_WAVES ? 1 : 0);
            for (let i = 0; i < eliteCount; i++) {
                groups.push({ type: pick(pool.length ? pool : ["drone"]), count: 1, elite: true });
            }
            groups.push({
                type: level.eliteSupport || "drone",
                count: Math.max(2, Math.round(2 * scaling.spawn)),
                elite: false
            });
            return groups;
        }

        // A combo wave (a hand-authored composition) becomes more likely
        // deeper into the run, exactly as it does solo.
        if (waveNo >= 5 && level.combos.length && random() < 0.45) {
            const combo = pick(level.combos);
            return combo.map(([type, count]) => ({
                type: type,
                count: Math.max(1, Math.round(count * scaling.spawn)),
                elite: false
            }));
        }

        let budget = (7 + depth * 3.2) * diff.spawnMult * scaling.spawn;
        const groups = [];
        let guard = 0;
        while (budget > 0 && guard++ < 40) {
            const avail = level.waveOpts.filter(o => depth >= o[3] && o[1] <= budget + 2);
            if (!avail.length) break;
            const o = pick(avail);
            const count = Math.max(1, Math.min(o[2], Math.floor(budget / o[1]) || 1));
            groups.push({ type: o[0], count: count, elite: false });
            budget -= o[1] * count;
        }
        if (!groups.length) groups.push({ type: "drone", count: 2, elite: false });
        return groups;
    }

    // Spawn positions are picked away from every LIVE player, so nothing
    // ever materialises on top of somebody.
    function findSpawnPos(now) {
        const live = targetablePlayers(now);
        for (let i = 0; i < 24; i++) {
            const x = rand(-ROOM.w / 2 + 90, ROOM.w / 2 - 90);
            const y = rand(-ROOM.h / 2 + 90, ROOM.h / 2 - 90);
            let ok = true;
            for (const p of live) { if (dist(x, y, p.x, p.y) < 380) { ok = false; break; } }
            if (ok) return { x: x, y: y };
        }
        return { x: rand(-ROOM.w / 2 + 90, ROOM.w / 2 - 90), y: -ROOM.h / 2 + 90 };
    }

    function queueWave(waveNo, now) {
        if (waveNo === BOSS_WAVE) {
            spawnBoss(now);
            // A little company, so the arena is never just the two of you.
            const support = level.eliteSupport || "drone";
            const n = Math.max(2, Math.round(1.5 * scaling.spawn));
            for (let i = 0; i < n; i++) {
                const pos = findSpawnPos(now);
                run.spawnQueue.push({ x: pos.x, y: pos.y, type: support, elite: false, at: now + 2800 + i * 140 });
            }
            emit({ t: "wave", wave: waveNo, total: TOTAL_WAVES, elite: false, boss: 1 });
            return;
        }
        const groups = buildWave(waveNo);
        let queued = 0;
        for (const g of groups) {
            for (let i = 0; i < g.count; i++) {
                if (run.enemies.length + run.spawnQueue.length >= MAX_ENEMIES) break;
                const pos = findSpawnPos(now);
                run.spawnQueue.push({
                    x: pos.x + rand(-40, 40),
                    y: pos.y + rand(-40, 40),
                    type: g.type,
                    elite: g.elite,
                    at: now + 850 + queued * 120
                });
                queued++;
            }
        }
        emit({ t: "wave", wave: waveNo, total: TOTAL_WAVES, elite: ELITE_WAVES.indexOf(waveNo) !== -1 });
    }

    // ---- enemies ------------------------------------------------------
    // Stats derived exactly as createEnemy() does, with the co-op player
    // -count health multiplier as the one extra factor.
    function createEnemy(type, x, y, elite, depth) {
        const c = ETYPES[type] || ETYPES.drone;
        const ds = level.diff * (1 + (depth - 1) * 0.12);
        const emult = elite ? (type === "ravager" ? 1.9 : type === "shattered" ? 2.2 :
            type === "guardian" ? 2.1 : type === "singularity" ? 2.0 : 2.7) : 1;
        const rmult = elite ? (type === "ravager" ? 1.15 : type === "shattered" ? 1.4 :
            type === "guardian" ? 1.15 : type === "singularity" ? 1.1 : 1.35) : 1;
        const hp = c.hp * ds * emult * diff.hpMult * scaling.hp;
        return {
            id: run.nextEnemyId++,
            type: type, elite: !!elite,
            role: AI_ROLE[type] || "rush",
            x: x, y: y,
            r: c.r * rmult,
            hp: hp, maxhp: hp,
            speed: c.speed * (elite ? 1.12 : 1) * rand(0.92, 1.08) * (1 + (level.diff - 1) * 0.25) * diff.speedMult,
            // Contact/shot damage. diff.dmgMult is applied once, at the
            // moment the damage lands (see hurtPlayer below), never here
            // -- the same "exactly once" rule voidbreak.html documents.
            cdmg: c.cdmg * (elite ? 1.35 : 1) * (1 + (depth - 1) * 0.05) * level.diff,
            shards: c.shards,
            faceAng: 0,
            shootT: rand(0.6, 1.8),
            burst: 0, burstT: 0,
            strafeDir: random() < 0.5 ? -1 : 1,
            actT: rand(1.0, 2.4),
            blinkT: rand(1.8, 3.2),
            dead: false
        };
    }

    // ---- the Guardian ------------------------------------------------
    function spawnBoss(now) {
        // Randomly drawn, from the RUN's own RNG. Nothing a client sends
        // influences which one it is.
        const def = pick(BOSSES);
        const hp = Math.round(
            BOSS_BASE_HP * level.diff * diff.hpMult *
            (1 + BOSS_HP_PER_EXTRA_PLAYER * (playerCount - 1)));

        run.boss = {
            id: BOSS_ID,
            kind: def.kind,
            name: def.name,
            def: def,
            x: 0, y: -Math.min(300, ROOM.h / 2 - 140),
            vx: 0, vy: 0,
            r: def.r,
            hp: hp, maxhp: hp,
            phase: 1,
            t: 0,
            invulnUntil: now + 2600,   // the intro: untouchable while it arrives
            vulnUntil: 0,
            hitFlashUntil: 0,
            eyeUntil: 0,
            // The two core Guardians alternate between a sealed shell
            // (untouchable) and an exposed core (vulnerable, and the
            // only time real damage goes in) -- their actual mechanic,
            // not a new one.
            coreMode: def.style === "core" ? "closed" : null,
            coreUntil: def.style === "core" ? now + 6500 : 0,
            // Attack timers, in seconds of simulation.
            tRadial: 3.0, tVolley: 2.2, tBig: 5.5, tSummon: 11,
            act: null,                 // the attack currently being telegraphed
            dead: false
        };
        emit({ t: "bs", kind: def.kind, name: def.name,
               x: Math.round(run.boss.x), y: Math.round(run.boss.y),
               r: def.r, hp: hp, th: def.thresholds.slice() });
    }

    function bossShot(b, ang, speed, dmg, now) {
        if (run.ebullets.length >= MAX_EBULLETS) return;
        const bullet = {
            id: run.nextBulletId++,
            x: b.x + Math.cos(ang) * (b.r + 6),
            y: b.y + Math.sin(ang) * (b.r + 6),
            vx: Math.cos(ang) * speed,
            vy: Math.sin(ang) * speed,
            dmg: dmg, r: 8,
            dieAt: now + 4200
        };
        run.ebullets.push(bullet);
        // One message per shot; the client flies it locally, exactly
        // like an ordinary enemy shot (see the 'eb' event).
        emit({ t: "eb", x: Math.round(bullet.x), y: Math.round(bullet.y),
               vx: Math.round(bullet.vx), vy: Math.round(bullet.vy), b: 1 });
    }

    function bossSummon(b, now) {
        const groups = b.def.adds[b.phase] || [];
        for (const [type, n] of groups) {
            const live = run.enemies.filter(e => e.type === type && !e.dead).length;
            if (live >= 4) continue;
            for (let i = 0; i < n; i++) {
                if (run.enemies.length + run.spawnQueue.length >= MAX_ENEMIES) break;
                const pos = findSpawnPos(now);
                run.spawnQueue.push({ x: pos.x, y: pos.y, type: type, elite: false, at: now + 850 + i * 120 });
            }
        }
    }

    function bossPhaseTo(b, n, now) {
        b.phase = n;
        b.invulnUntil = now + BOSS_PHASE_INVULN_MS;
        b.act = null;
        // The phase change clears the field, exactly as it does solo.
        run.ebullets.length = 0;
        bossSummon(b, now);
        emit({ t: "bph", phase: n });

        // A downed player comes back at each phase break.
        //
        // Every other wave gives a downed player a way back in when it
        // is cleared; the Guardian is ONE wave, so without this a death
        // in the first ten seconds of a two-minute finale would mean
        // watching the rest of it. The Guardian's own phase thresholds
        // are the natural beat for it, and they are earned -- the party
        // only gets the revive by pushing it into the next phase.
        for (const p of activePlayers()) {
            if (p.alive) continue;
            p.alive = true;
            p.hp = Math.max(1, Math.round(p.maxhp * RESPAWN_HP_FRACTION));
            p.invulnUntil = now + PLAYER_INVULN_MS * 4;
            emit({ t: "pr", slot: p.slot, hp: Math.round(p.hp) });
        }
    }

    function bossDie(b, now) {
        if (b.dead) return;
        b.dead = true;
        b.hp = 0;
        run.ebullets.length = 0;
        run.spawnQueue.length = 0;
        // Its remaining summons die with it, exactly as they do solo.
        // They go through killEnemy so every client gets the kill EVENT
        // and removes them -- marking them dead here without telling
        // anybody would leave a ghost on screen that nothing can shoot.
        // `0` as the killer means nobody gets credit for the kill, but
        // the shards are paid, same as any other death.
        for (const e of run.enemies.slice()) {
            if (!e.dead) killEnemy(e, 0, now);
        }
        for (const p of activePlayers()) p.shards += Math.round(BOSS_SHARDS * diff.shardMult);
        emit({ t: "bd", kind: b.kind, name: b.name });
    }

    // One step of the Guardian fight. Styles differ in how it MOVES and
    // which big attack it commits to; every one of them also does the
    // radial/volley pressure that all eight Guardians share.
    function stepBoss(b, dt, now) {
        b.t += dt;
        const near = nearestPlayer(b.x, b.y, now);

        // The sealed/exposed cycle for the two core Guardians.
        if (b.coreMode && now >= b.coreUntil) {
            if (b.coreMode === "closed") {
                b.coreMode = "open";
                b.coreUntil = now + 5200;
                b.vulnUntil = now + 5200;     // exposed: hits land for 1.5x
            } else {
                b.coreMode = "closed";
                b.coreUntil = now + 6000;
            }
            emit({ t: "bcore", mode: b.coreMode });
        }

        if (!near) return;
        const p = near.player;
        const d = Math.max(1, near.d);
        const ax = (p.x - b.x) / d, ay = (p.y - b.y) / d;

        // ---- movement --------------------------------------------------
        const style = b.def.style;
        let speed = 70 + b.phase * 25;
        if (style === "charger" && b.act && b.act.k === "charge") {
            // Committed: it is already moving, handled below.
        } else if (style === "blinker") {
            speed = 45;                       // it mostly teleports
        }

        if (!b.act || b.act.k !== "charge") {
            // Holds a ring rather than sitting on top of the party.
            const want = style === "charger" ? 220 : 340;
            const drift = clamp((d - want) * 1.6, -speed, speed);
            b.x += ax * drift * dt;
            b.y += ay * drift * dt;
            // A slow orbit, so it is never a stationary target.
            b.x += -ay * speed * 0.45 * dt;
            b.y += ax * speed * 0.45 * dt;
        }

        const hw = ROOM.w / 2 - b.r, hh = ROOM.h / 2 - b.r;
        b.x = clamp(b.x, -hw, hw);
        b.y = clamp(b.y, -hh, hh);

        // ---- the attack it is committed to -----------------------------
        if (b.act) {
            b.act.t -= dt;
            if (b.act.k === "charge") {
                if (b.act.t > 0) {
                    // Telegraph: it winds up, aimed at where you were.
                } else if (b.act.t > -0.9) {
                    const cs = 620;
                    b.x += Math.cos(b.act.ang) * cs * dt;
                    b.y += Math.sin(b.act.ang) * cs * dt;
                    // Anything it runs through takes the hit.
                    for (const q of alivePlayers()) {
                        if (dist(b.x, b.y, q.x, q.y) < b.r + PLAYER_R + 6) hurtPlayer(q, BOSS_CONTACT_DMG, now);
                    }
                } else {
                    // Overshoots and is open for a moment.
                    b.act = null;
                    b.vulnUntil = now + BOSS_VULN_WINDOW_MS;
                    emit({ t: "bvuln" });
                }
            } else if (b.act.t <= 0) {
                // The telegraph finished: the attack goes off.
                if (b.act.k === "nova") {
                    const n = 16 + b.phase * 6;
                    for (let i = 0; i < n; i++) bossShot(b, (i / n) * Math.PI * 2, 300, BOSS_SHOT_DMG, now);
                } else if (b.act.k === "sweep") {
                    // A rotating fan, fired as one burst per step.
                    const arms = 3 + b.phase;
                    for (let i = 0; i < arms; i++) {
                        bossShot(b, b.act.ang + (i / arms) * Math.PI * 2, 340, BOSS_SHOT_DMG, now);
                    }
                    b.act.ang += 0.42;
                    b.act.t = 0.12;
                    b.act.left--;
                    if (b.act.left > 0) return;   // keep sweeping
                } else if (b.act.k === "blink") {
                    const ang = random() * Math.PI * 2;
                    const dd = 200 + random() * 120;
                    b.x = clamp(p.x + Math.cos(ang) * dd, -hw, hw);
                    b.y = clamp(p.y + Math.sin(ang) * dd, -hh, hh);
                    emit({ t: "bbl", x: Math.round(b.x), y: Math.round(b.y) });
                    const n = 10 + b.phase * 4;
                    for (let i = 0; i < n; i++) bossShot(b, (i / n) * Math.PI * 2, 330, BOSS_SHOT_DMG, now);
                } else if (b.act.k === "spire") {
                    // The core Guardians' aimed lance volley.
                    for (let i = -2; i <= 2; i++) {
                        bossShot(b, Math.atan2(p.y - b.y, p.x - b.x) + i * 0.13, 520, BOSS_SHOT_DMG + 3, now);
                    }
                }
                b.act = null;
                b.vulnUntil = now + BOSS_VULN_WINDOW_MS;
                emit({ t: "bvuln" });
            }
            return;   // one committed attack at a time
        }

        // ---- shared pressure -------------------------------------------
        // A sealed core Guardian does not attack; that IS the trade for
        // being untouchable.
        if (b.coreMode === "closed") return;

        b.tRadial -= dt;
        if (b.tRadial <= 0) {
            b.tRadial = Math.max(1.7, 3.4 - b.phase * 0.5);
            const n = 8 + b.phase * 3;
            const off = random() * Math.PI * 2;
            for (let i = 0; i < n; i++) bossShot(b, off + (i / n) * Math.PI * 2, 280, BOSS_SHOT_DMG, now);
        }

        b.tVolley -= dt;
        if (b.tVolley <= 0) {
            b.tVolley = Math.max(1.2, 2.6 - b.phase * 0.35);
            const aim = Math.atan2(p.y - b.y, p.x - b.x);
            for (let i = -1; i <= 1; i++) bossShot(b, aim + i * 0.16, 430, BOSS_SHOT_DMG, now);
        }

        b.tSummon -= dt;
        if (b.tSummon <= 0) {
            b.tSummon = 13 - b.phase;
            bossSummon(b, now);
        }

        // ---- the big, telegraphed attack -------------------------------
        b.tBig -= dt;
        if (b.tBig <= 0) {
            b.tBig = Math.max(3.2, 6.5 - b.phase * 0.8);
            const k = style === "charger" ? "charge"
                : style === "sweeper" ? "sweep"
                : style === "blinker" ? "blink"
                : style === "core" ? "spire"
                : "nova";
            b.act = {
                k: k,
                t: k === "charge" ? 0.85 : 0.7,
                ang: Math.atan2(p.y - b.y, p.x - b.x),
                left: 7 + b.phase * 2
            };
            // The telegraph is what makes the attack readable, so it is
            // an EVENT rather than something the client has to infer.
            emit({ t: "btel", k: k, x: Math.round(b.x), y: Math.round(b.y),
                   ang: Math.round(b.act.ang * 100), ms: Math.round(b.act.t * 1000) });
        }
    }

    function spawnEnemy(s, now) {
        if (run.enemies.length >= MAX_ENEMIES) return;
        const e = createEnemy(s.type, s.x, s.y, s.elite, Math.max(1, run.waveActive));
        run.enemies.push(e);
        // A SPAWN EVENT, not a state dump: the client builds its own
        // enemy object from this using voidbreak.html's createEnemy(),
        // so every visual (colour, shape, elite ring) comes from the
        // existing renderer rather than being described over the wire.
        emit({ t: "es", id: e.id, k: e.type, e: e.elite ? 1 : 0,
               x: Math.round(e.x), y: Math.round(e.y), hp: Math.round(e.hp) });
    }

    function enemyShoot(e, ang, speed, dmg, now) {
        if (run.ebullets.length >= MAX_EBULLETS) return;
        const b = {
            id: run.nextBulletId++,
            x: e.x + Math.cos(ang) * (e.r + 4),
            y: e.y + Math.sin(ang) * (e.r + 4),
            vx: Math.cos(ang) * speed,
            vy: Math.sin(ang) * speed,
            dmg: dmg,
            r: 6,
            dieAt: now + 2600
        };
        run.ebullets.push(b);
        // Clients simulate this projectile locally from its spawn state
        // (it travels in a straight line and never changes course), so
        // there is exactly ONE message per shot instead of a position
        // every tick. The server still simulates its own copy -- that
        // copy is the one that decides whether anybody was hit.
        emit({ t: "eb", x: Math.round(b.x), y: Math.round(b.y),
               vx: Math.round(b.vx), vy: Math.round(b.vy) });
    }

    function hurtPlayer(p, rawDmg, now) {
        if (!p.alive || !p.connected) return;
        if (now < p.invulnUntil) return;
        // The single point every PvE damage source funnels through, so
        // the difficulty multiplier is applied exactly once -- the same
        // rule voidbreak.html's own hurtPlayer() documents.
        const dmg = Math.max(1, Math.round(rawDmg * diff.dmgMult));
        p.hp = Math.max(0, p.hp - dmg);
        p.invulnUntil = now + PLAYER_INVULN_MS;
        emit({ t: "ph", slot: p.slot, hp: Math.round(p.hp), d: dmg });
        if (p.hp <= 0) {
            p.alive = false;
            p.downs++;
            emit({ t: "pd", slot: p.slot });
            checkWipe(now);
        }
    }

    // Everyone down at once ends the run. A player who dies while
    // teammates are still standing is simply out until the next wave --
    // no revive mechanic is invented here, and no teammate is punished
    // for the death.
    function checkWipe(now) {
        if (run.phase === "complete" || run.phase === "failed") return;
        if (alivePlayers().length === 0) finish(false, now);
    }

    function finish(victory, now) {
        if (run.phase === "complete" || run.phase === "failed") return;
        run.phase = victory ? "complete" : "failed";
        run.endedAt = now;
        if (victory) {
            // The sector completion bonus, paid to every player exactly
            // as a solo clear pays it to the one player.
            const bonus = Math.round(level.completionBonus * diff.shardMult);
            for (const p of activePlayers()) p.shards += bonus;
        }
        emit({
            t: "end",
            victory: victory,
            wave: run.waveIndex,
            total: TOTAL_WAVES,
            players: Object.keys(players).map(s => ({
                slot: players[s].slot,
                name: players[s].name,
                kills: players[s].kills,
                shards: Math.round(players[s].shards),
                downs: players[s].downs
            }))
        });
    }

    function killEnemy(e, bySlot, now) {
        if (e.dead) return;
        e.dead = true;
        const shards = Math.round(e.shards * diff.shardMult * (e.elite ? 2 : 1));
        // SHARED LOOT. Every connected player banks the same shards, so
        // nobody is racing a teammate for a pickup and the payout does
        // not depend on who landed the last hit. Enemy COUNT already
        // scales with party size, so this is not a multiplier on income
        // per enemy killed.
        for (const p of activePlayers()) p.shards += shards;
        const killer = players[bySlot];
        if (killer) {
            killer.kills++;
            if (killer.lifesteal > 0 && killer.alive) {
                killer.hp = Math.min(killer.maxhp, killer.hp + killer.lifesteal);
            }
        }
        emit({ t: "ek", id: e.id, by: bySlot || 0, s: shards });
    }

    // ---- per-type behaviour ------------------------------------------
    function stepEnemy(e, dt, now) {
        const near = nearestPlayer(e.x, e.y, now);
        if (!near) return;                     // nobody to fight -- hold position
        const p = near.player, d = Math.max(1, near.d);
        const ax = (p.x - e.x) / d, ay = (p.y - e.y) / d;
        e.faceAng = Math.atan2(p.y - e.y, p.x - e.x);

        let mvx = 0, mvy = 0;
        const sp = e.speed;

        switch (e.role) {
            case "rush":
                mvx = ax * sp; mvy = ay * sp;
                break;

            case "heavy":
                // Closes slowly, then telegraphs and fires a radial
                // burst -- the archetype behind every big enemy's slam.
                e.actT -= dt;
                if (e.actT <= 0 && d < 420) {
                    e.actT = rand(3.2, 4.8);
                    const n = e.elite ? 10 : 7;
                    for (let i = 0; i < n; i++) {
                        enemyShoot(e, e.faceAng + (i / n) * Math.PI * 2, 260, e.cdmg * 0.55, now);
                    }
                }
                mvx = ax * sp; mvy = ay * sp;
                break;

            case "orbit": {
                // Holds a ring at ~280px and fires bursts, strafing.
                e.shootT -= dt;
                if (e.burst > 0) {
                    e.burstT -= dt;
                    if (e.burstT <= 0) {
                        e.burst--; e.burstT = 0.13;
                        enemyShoot(e, e.faceAng + rand(-0.07, 0.07), 400, e.cdmg * 0.75, now);
                    }
                } else if (e.shootT <= 0 && d < 560) {
                    e.burst = e.elite ? 5 : 3;
                    e.burstT = 0.3;
                    e.shootT = rand(1.7, 2.4);
                }
                const radial = clamp((d - 280) * 2.5, -130, 130);
                const tang = e.strafeDir * 95;
                let vx = ax * radial + -ay * tang;
                let vy = ay * radial + ax * tang;
                const ml = Math.hypot(vx, vy) || 1;
                mvx = sp * vx / ml; mvy = sp * vy / ml;
                break;
            }

            case "standoff":
                // Keeps its distance and lands a single fast, aimed
                // shot -- snipers and orbs.
                e.shootT -= dt;
                if (e.shootT <= 0 && d < 700) {
                    e.shootT = rand(2.0, 3.2);
                    enemyShoot(e, e.faceAng, 560, e.cdmg > 0 ? e.cdmg : 10, now);
                }
                if (d < 380) { mvx = -ax * sp; mvy = -ay * sp; }
                else if (d > 520) { mvx = ax * sp * 0.6; mvy = ay * sp * 0.6; }
                else { mvx = -ay * sp * 0.5 * e.strafeDir; mvy = ax * sp * 0.5 * e.strafeDir; }
                break;

            case "turret":
                // Never moves (ETYPES.core has speed 0 already); fires
                // a slow spread.
                e.shootT -= dt;
                if (e.shootT <= 0 && d < 620) {
                    e.shootT = rand(1.8, 2.6);
                    for (let i = -1; i <= 1; i++) {
                        enemyShoot(e, e.faceAng + i * 0.22, 330, e.cdmg * 0.9, now);
                    }
                }
                break;

            case "blink":
                // Phantom: closes in jumps rather than walking.
                e.blinkT -= dt;
                if (e.blinkT <= 0 && d > 140) {
                    e.blinkT = rand(2.2, 3.6);
                    const jump = Math.min(d - 90, 260);
                    e.x += ax * jump; e.y += ay * jump;
                    emit({ t: "ebl", id: e.id, x: Math.round(e.x), y: Math.round(e.y) });
                } else {
                    mvx = ax * sp; mvy = ay * sp;
                }
                break;
        }

        e.x += mvx * dt;
        e.y += mvy * dt;

        // Keep enemies inside the room.
        const hw = ROOM.w / 2 - e.r, hh = ROOM.h / 2 - e.r;
        e.x = clamp(e.x, -hw, hw);
        e.y = clamp(e.y, -hh, hh);

        // Contact damage. The server owns both positions involved, so
        // this needs no claim from anybody.
        if (e.cdmg > 0 && near.d < e.r + PLAYER_R) hurtPlayer(p, e.cdmg * 0.5, now);
    }

    // Cheap mutual separation so a wave does not collapse into one
    // stack of overlapping sprites. O(n^2) over a roster capped at
    // MAX_ENEMIES, which at 20Hz is a few thousand cheap operations a
    // second -- far below anything this server would notice.
    function separate(dt) {
        const list = run.enemies;
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            for (let j = i + 1; j < list.length; j++) {
                const b = list[j];
                const dx = b.x - a.x, dy = b.y - a.y;
                const min = a.r + b.r;
                const d2 = dx * dx + dy * dy;
                if (d2 > min * min || d2 < 0.0001) continue;
                const d = Math.sqrt(d2);
                const push = (min - d) * 0.5;
                const nx = dx / d, ny = dy / d;
                a.x -= nx * push; a.y -= ny * push;
                b.x += nx * push; b.y += ny * push;
            }
        }
    }

    function stepBullets(dt, now) {
        for (let i = run.ebullets.length - 1; i >= 0; i--) {
            const b = run.ebullets[i];
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            let dead = now >= b.dieAt ||
                b.x < -ROOM.w / 2 || b.x > ROOM.w / 2 ||
                b.y < -ROOM.h / 2 || b.y > ROOM.h / 2;
            if (!dead) {
                for (const p of alivePlayers()) {
                    if (now - p.reportedAt >= POSITION_STALE_MS) continue;
                    if (dist(b.x, b.y, p.x, p.y) < b.r + PLAYER_R) {
                        hurtPlayer(p, b.dmg, now);
                        dead = true;
                        break;
                    }
                }
            }
            if (dead) run.ebullets.splice(i, 1);
        }
    }

    // ---- upgrades -----------------------------------------------------
    function offerUpgrades(now) {
        for (const p of activePlayers()) {
            const owned = p.upgrades;
            const pool = COOP_UPGRADES.filter(u => (owned[u.id] || 0) < 5);
            const choices = [];
            const copy = pool.slice();
            while (choices.length < 3 && copy.length) {
                choices.push(copy.splice(Math.floor(random() * copy.length), 1)[0].id);
            }
            if (!choices.length) continue;
            p.pendingUpgrade = { choices: choices, waveIndex: run.waveIndex };
            emit({ t: "uo", slot: p.slot, choices: choices.map(id => {
                const u = COOP_UPGRADES.find(x => x.id === id);
                return { id: u.id, name: u.name, desc: u.desc, rar: u.rar };
            }) });
        }
    }

    function applyUpgrade(p, id) {
        p.upgrades[id] = (p.upgrades[id] || 0) + 1;
        if (id === "dmg") p.dmgMult *= 1.25;
        else if (id === "maxhp") { p.maxhp += 25; p.hp = Math.min(p.maxhp, p.hp + 25); }
        else if (id === "crit") p.crit = Math.min(0.9, p.crit + 0.10);
        else if (id === "lifesteal") p.lifesteal += 4;
        else if (id === "firerate") p.fireRateMult *= 1.18;
        else if (id === "pierce") p.pierceAdd += 1;
    }

    // ---- the per-wave transition -------------------------------------
    function waveCleared(now) {
        run.waveIndex = run.waveActive;
        emit({ t: "wc", wave: run.waveIndex, total: TOTAL_WAVES });

        // A clear pays a small shared bonus and brings back anybody who
        // went down, at half health.
        for (const p of activePlayers()) {
            p.shards += SHARD_BONUS_PER_WAVE * run.waveIndex;
            if (!p.alive) {
                p.alive = true;
                p.hp = Math.max(1, Math.round(p.maxhp * RESPAWN_HP_FRACTION));
                p.invulnUntil = now + PLAYER_INVULN_MS * 3;
                emit({ t: "pr", slot: p.slot, hp: Math.round(p.hp) });
            }
        }

        if (run.waveIndex >= TOTAL_WAVES) { finish(true, now); return; }
        if (UPGRADE_AFTER_WAVES.indexOf(run.waveIndex) !== -1) offerUpgrades(now);

        run.phase = "waiting";
        run.nextWaveAt = now + WAVE_GAP_MS;
    }

    // =================================================================
    // PUBLIC API
    // =================================================================
    return {
        id: run.id,
        state: run,

        levelIdx: levelIdx,
        difficultyId: diff.id,

        get phase() { return run.phase; },
        get finished() { return run.phase === "complete" || run.phase === "failed"; },
        get victory() { return run.phase === "complete"; },

        // The setup every client needs once, at the start.
        config() {
            return {
                levelIdx: levelIdx,
                levelId: level.id,
                levelName: level.name,
                difficulty: diff.id,
                room: { w: ROOM.w, h: ROOM.h },
                totalWaves: TOTAL_WAVES,
                eliteWaves: ELITE_WAVES.slice(),
                // Which Guardian is drawn is deliberately NOT in the
                // config: the client finds out when it arrives, same as
                // everyone else in the party.
                bossWave: BOSS_WAVE,
                playerCount: playerCount,
                players: Object.keys(players).map(s => ({
                    slot: players[s].slot,
                    name: players[s].name,
                    weapon: players[s].weapon,
                    maxhp: players[s].maxhp
                }))
            };
        },

        begin(now) {
            run.startedAt = now;
            run.lastTickAt = now;
            run.phase = "waiting";
            run.nextWaveAt = now + 2200;
        },

        // A player's own client reporting where it is. Exactly the same
        // trust tier as every position in this codebase: it moves
        // nobody, it only decides what the simulation aims at. It is
        // clamped to the room so a client cannot park outside the arena
        // where nothing can reach it.
        reportPosition(slot, x, y, ang, now) {
            const p = players[slot];
            if (!p || !p.connected) return;
            if (typeof x !== "number" || !isFinite(x) || typeof y !== "number" || !isFinite(y)) return;
            p.x = clamp(x, -ROOM.w / 2, ROOM.w / 2);
            p.y = clamp(y, -ROOM.h / 2, ROOM.h / 2);
            if (typeof ang === "number" && isFinite(ang)) p.ang = ang;
            p.reportedAt = now;
        },

        // "My shot connected on enemy N."
        //
        // Everything that could be exploited is decided here: the enemy
        // must exist and be alive, the shooter must be alive, the claim
        // must be physically plausible (range), it must not arrive
        // faster than the weapon can fire, and the DAMAGE is computed
        // from this module's weapon table times the player's own stored
        // forge -- the message carries no number at all.
        claimHit(slot, enemyId, now) {
            const p = players[slot];
            if (!p || !p.connected || !p.alive) return { ok: false, reason: "not-alive" };
            if (run.phase !== "fighting") return { ok: false, reason: "not-fighting" };

            const b = run.boss;
            const isBoss = enemyId === BOSS_ID;
            const target = isBoss ? (b && !b.dead ? b : null)
                                  : run.enemies.find(x => x.id === enemyId && !x.dead);
            if (!target) return { ok: false, reason: "no-such-enemy" };
            const e = target;

            if (dist(p.x, p.y, e.x, e.y) > CLAIM_MAX_RANGE) return { ok: false, reason: "out-of-range" };

            // A Guardian mid-phase-change, or one whose core is sealed,
            // takes nothing at all -- its own mechanic, enforced here
            // rather than by a client agreeing not to shoot.
            if (isBoss && (now < b.invulnUntil || b.coreMode === "closed")) {
                return { ok: false, reason: "invulnerable" };
            }

            const w = WEAPONS[p.weapon] || WEAPONS.pulse;
            // What this weapon could HONESTLY connect with in a second:
            // its fire rate times how many things one activation can
            // hit (projectiles, pierce, and its blast/arc), with
            // headroom for network jitter. A modified client firing
            // faster than this is refused; an honest one never reaches
            // it, including a Void Blade in the middle of a swarm.
            // Everything ONE activation of this weapon can legitimately
            // connect with: its projectiles times its blast/arc, plus
            // whatever it pierces through. A railgun's pierce of 99 is
            // capped at a realistic line of enemies rather than taken
            // literally, so "unlimited pierce" does not become
            // "unlimited claims".
            const perActivation = w.count * (w.targets || 1) +
                Math.min((w.pierce || 0) + p.pierceAdd, 12);
            const allowed = Math.max(CLAIM_RATE_FLOOR,
                w.rate * p.fireRateMult * perActivation * CLAIM_RATE_HEADROOM);
            // Rolling one-second window. Cheap, and it caps sustained
            // damage output at the weapon's real rate rather than
            // trusting the client's own cadence.
            p.claimTimes = p.claimTimes.filter(t => now - t < 1000);
            if (p.claimTimes.length >= allowed) return { ok: false, reason: "rate-limited" };
            p.claimTimes.push(now);

            const crit = random() < p.crit;
            // An exposed Guardian takes 1.5x, exactly as it does solo.
            const vulnMult = (isBoss && now < b.vulnUntil) ? 1.5 : 1;
            const dmg = Math.max(1, w.dmg * p.dmgMult * (crit ? 2.2 : 1) * vulnMult);
            e.hp -= dmg;
            p.damage += dmg;

            if (isBoss) {
                b.hitFlashUntil = now + 100;
                if (b.hp <= 0) {
                    bossDie(b, now);
                    return { ok: true, dead: true, dmg: Math.round(dmg), crit: crit, enemyId: BOSS_ID };
                }
                // Phase thresholds are the Guardian's OWN, mirrored from
                // BOSSMETA, so the bar's two marks still mean what they
                // mean in a solo fight.
                const f = b.hp / b.maxhp;
                const th = b.def.thresholds;
                if (b.phase === 1 && f < th[0]) bossPhaseTo(b, 2, now);
                else if (b.phase === 2 && f < th[1]) bossPhaseTo(b, 3, now);
                return { ok: true, dead: false, dmg: Math.round(dmg), crit: crit, enemyId: BOSS_ID };
            }

            if (e.hp <= 0) {
                killEnemy(e, slot, now);
                return { ok: true, dead: true, dmg: Math.round(dmg), crit: crit, enemyId: e.id };
            }
            return { ok: true, dead: false, dmg: Math.round(dmg), crit: crit, enemyId: e.id };
        },

        // The client sends only an upgrade ID, and only one that the
        // SERVER offered to that player for that wave.
        chooseUpgrade(slot, id) {
            const p = players[slot];
            if (!p || !p.pendingUpgrade) return { ok: false, error: "Nothing to choose" };
            if (p.pendingUpgrade.choices.indexOf(id) === -1) return { ok: false, error: "Not offered" };
            applyUpgrade(p, id);
            p.pendingUpgrade = null;
            return { ok: true, id: id, maxhp: p.maxhp, hp: Math.round(p.hp) };
        },

        // A disconnect. The player stops being a target and stops being
        // simulated; their earned shards are frozen exactly where they
        // are so server.js can pay them out once and only once.
        disconnect(slot, now) {
            const p = players[slot];
            if (!p || !p.connected) return;
            p.connected = false;
            p.alive = false;
            emit({ t: "pl", slot: slot });
            // The last player leaving ends the run rather than leaving
            // an empty simulation ticking forever.
            if (!activePlayers().length) finish(false, now);
            else checkWipe(now);
        },

        // NOTE: there is deliberately no co-op reconnect. A player who
        // drops is PAID OUT at that moment (see payCoopPlayer) so their
        // earned shards are never lost, and `rewarded` is set so they
        // can never be paid a second time. Letting them re-enter the
        // same run afterwards would mean either paying twice or
        // tracking a partial second payout, and the exactly-once
        // guarantee is worth more here than the convenience. They land
        // back in the room and can join the next run.

        // ---- the simulation step ---------------------------------------
        // Returns { events, snapshot }. server.js decides how to send
        // them; this decides what is true.
        step(now) {
            if (run.phase === "complete" || run.phase === "failed") {
                return { events: this.drainEvents(), snapshot: null };
            }
            const dtMs = Math.min(200, now - run.lastTickAt);
            run.lastTickAt = now;
            const dt = dtMs / 1000;
            run.tickCount++;

            if (run.phase === "waiting" && now >= run.nextWaveAt) {
                run.waveActive = run.waveIndex + 1;
                run.phase = "fighting";
                queueWave(run.waveActive, now);
            }

            for (let i = run.spawnQueue.length - 1; i >= 0; i--) {
                if (now >= run.spawnQueue[i].at) {
                    spawnEnemy(run.spawnQueue[i], now);
                    run.spawnQueue.splice(i, 1);
                }
            }

            for (const e of run.enemies) { if (!e.dead) stepEnemy(e, dt, now); }
            if (run.boss && !run.boss.dead) stepBoss(run.boss, dt, now);
            separate(dt);
            stepBullets(dt, now);

            // Reap the dead AFTER stepping, so a kill and its event are
            // never processed twice.
            if (run.enemies.some(e => e.dead)) {
                run.enemies = run.enemies.filter(e => !e.dead);
            }

            // The Guardian wave is not over until the Guardian is.
            if (run.phase === "fighting" && !run.enemies.length && !run.spawnQueue.length &&
                (!run.boss || run.boss.dead)) {
                waveCleared(now);
            }

            let snapshot = null;
            if (run.tickCount % SNAPSHOT_EVERY_TICKS === 0) snapshot = this.snapshot();

            return { events: this.drainEvents(), snapshot: snapshot };
        },

        // A FLAT numeric array, not an array of objects: five numbers per
        // enemy instead of five quoted keys per enemy. At the 80-enemy
        // cap this is a few kilobytes a second to each client, and it
        // carries the only enemy facts a client cannot derive for itself
        // -- where it is, which way it faces, and how hurt it is.
        snapshot() {
            const now = Date.now();
            const a = [];
            for (const e of run.enemies) {
                if (e.dead) continue;
                a.push(e.id, Math.round(e.x), Math.round(e.y),
                       Math.round(e.faceAng * 100), Math.round(e.hp));
            }
            // Seven numbers per player: slot, health, alive, connected,
            // and the position/facing each one last reported. Relaying
            // positions through this snapshot rather than a separate
            // per-player broadcast means a party of four costs ONE
            // message per tick in total, not four, and teammates are
            // interpolated from exactly the same data the simulation
            // itself is using -- so what you see a teammate standing on
            // is what the server thinks they are standing on.
            const ps = [];
            for (const slot of Object.keys(players)) {
                const p = players[slot];
                ps.push(p.slot, Math.round(p.hp), p.alive ? 1 : 0, p.connected ? 1 : 0,
                        Math.round(p.x), Math.round(p.y), Math.round(p.ang * 100));
            }
            // The Guardian's own scalars -- the exact set its renderer
            // reads (see the BOSSES comment). Eight numbers, only while
            // a Guardian is alive.
            let bo = null;
            const b = run.boss;
            if (b && !b.dead) {
                bo = [Math.round(b.x), Math.round(b.y), Math.round(b.hp), b.phase,
                      now < b.invulnUntil ? 1 : 0,
                      now < b.vulnUntil ? 1 : 0,
                      now < b.hitFlashUntil ? 1 : 0,
                      b.coreMode === "closed" ? 0 : 1];
            }
            return { e: a, p: ps, w: run.waveActive, ph: run.phase, b: bo };
        },

        drainEvents() {
            if (!run.events.length) return null;
            const out = run.events;
            run.events = [];
            return out;
        },

        // Everything server.js needs to pay a player out. `rewarded` is
        // flipped by markRewarded() so a reconnect, a second disconnect
        // or a duplicate end-of-run message can never pay twice.
        rewardsFor(slot) {
            const p = players[slot];
            if (!p || p.rewarded) return null;
            return {
                sub: p.sub,
                slot: p.slot,
                shards: Math.max(0, Math.round(p.shards)),
                kills: p.kills,
                victory: run.phase === "complete",
                waves: run.waveIndex
            };
        },

        markRewarded(slot) {
            const p = players[slot];
            if (p) p.rewarded = true;
        },

        playerSlots() {
            return Object.keys(players).map(Number);
        },

        // Diagnostics for /__net/stats.
        debugState() {
            return {
                phase: run.phase,
                wave: run.waveActive + "/" + TOTAL_WAVES,
                enemies: run.enemies.length,
                ebullets: run.ebullets.length,
                boss: run.boss ? (run.boss.kind + " p" + run.boss.phase + " " +
                    Math.round(100 * run.boss.hp / run.boss.maxhp) + "%") : null,
                players: activePlayers().length
            };
        }
    };
}

// =====================================================================
// LIMITATIONS (deliberate, documented rather than worked around)
//
// 1. THE GUARDIAN'S ATTACK SCRIPT IS BY STYLE, not a per-boss port.
//    The eight Guardians are ~1,200 lines of bespoke, client-only
//    attack scripting. What IS the real thing here: which Guardian you
//    face, its art, its radius, its phase thresholds and banners, its
//    summon composition, its HP bar, its intro, its sealed/exposed core
//    where it has one, and the whole fight being decided by the server.
//    What is not: the exact order and timing of ITS OWN attacks, which
//    is drawn from the style its fight is built around (see BOSSES).
//
//    A co-op clear still does not mark the sector "beaten" for the solo
//    campaign -- the Guardian is randomly drawn and is usually not that
//    sector's own, so it is not the same achievement.
//
// 2. ENEMY BEHAVIOUR IS BY ARCHETYPE, not a per-type port (see AI_ROLE).
//    Stats, health, damage, shard value and appearance are the real
//    ones; the movement is the family's, not the individual's.
//
// 3. ROOMS, PORTALS, CHESTS, SHRINES, COIN RUNS AND THE COLLAPSE
//    HAZARDS are solo-only. A co-op run is one arena and eight waves,
//    so four clients never have to agree about a branching path.
// =====================================================================

module.exports = {
    ETYPES,
    BOSSES,
    BOSS_ID,
    WEAPONS,
    WEAPON_KEYS,
    LEVELS,
    DIFFICULTY_MODES,
    COOP_UPGRADES,
    TOTAL_WAVES,
    ELITE_WAVES,
    ROOM,
    TICK_MS,
    PLAYER_SCALING,
    createRun
};
