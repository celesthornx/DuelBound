// =====================================================================
// SERVER-AUTHORITATIVE COMBAT -- health, shields and damage.
//
// What this module owns
// ---------------------
// Before this existed, an online player's client decided its OWN health:
// it detected the hit on itself, decremented its own health, and told
// the server the resulting number, which the server relayed verbatim.
// A modified client could therefore simply report "health: 3" forever,
// or never report a hit at all, and nothing could contradict it.
//
// This module moves the arithmetic to the server. A client no longer
// says how much health it has or how much damage it took -- it can only
// say "a shot connected on me", and the server:
//
//   * checks the opponent actually fired something that could still be
//     in the air (bullets and Shockwave blasts are tracked here as they
//     are relayed),
//   * decides the damage amount itself, from its own config,
//   * applies shields-then-health with its own arithmetic,
//   * decides whether that was an elimination,
//   * and broadcasts the resulting numbers to BOTH clients.
//
// What it deliberately does NOT own
// ---------------------------------
// Hit DETECTION is still done by the player who was hit, because their
// own position is the only ground truth that isn't network-delayed --
// the server sees every position ~half an RTT late, so detecting hits
// here would be strictly less accurate than where it happens now. The
// residual gap that leaves is documented in claimHit() below.
//
// Positions are also still client-owned; nothing here simulates
// movement.
//
// Pure module: no sockets, no storage, no timers. server.js owns the
// match rooms and the broadcasting; this owns "how much health is left".
// =====================================================================

// Mirrors index.html's own combat constants. These are the values the
// server will not take from a client under any circumstances.
const COMBAT_CONFIG = {
    maxHealth: 3,

    // Fallbacks only. server.js passes the live, admin-tunable
    // abilityConfig values in (see createCombatMatch), so these are what
    // a match uses if that config could not be loaded.
    bulletDamage: 1,
    triburstDamage: 1,
    shockwaveDamage: 1,

    // Ordinary bullets have no range limit in index.html (they die on a
    // wall), so a tracked bullet is kept alive for as long as one could
    // still plausibly be crossing the arena, plus slack for a ricochet.
    bulletMaxFlightMs: 3000,

    // How long a relayed Shockwave stays a valid damage source. The
    // blast is instantaneous; this only has to cover the round trip of
    // the victim noticing and reporting it.
    shockwaveWindowMs: 800,

    // Extra tolerance on a damage source's flight window, to absorb the
    // victim's own network delay in reporting the hit. Too tight would
    // reject real hits from a laggy but honest player.
    claimSlackMs: 1200,

    // A hit can never cost more than this regardless of what was
    // tracked -- a final backstop against a damage-inflation bug.
    maxDamagePerHit: 3,

    // Nothing legitimate lands hits faster than this. Bullets already
    // gate the rate (one hit consumes one tracked bullet), so this only
    // catches a pathological burst.
    minMsBetweenHits: 60
};

function otherSlot(slot) {
    return slot === 1 ? 2 : 1;
}

// ---------------------------------------------------------------------
// A single online match's combat state. Casual play has one of these;
// each ranked room has its own.
// ---------------------------------------------------------------------
function createCombatMatch(abilityConfig) {
    const cfg = Object.assign({}, COMBAT_CONFIG);

    // Damage numbers come from the SAME admin-tunable config the rest of
    // the server uses, so a balance change applies here automatically
    // instead of silently drifting from what the clients render.
    if (abilityConfig) {
        if (abilityConfig.triburst && typeof abilityConfig.triburst.damage === "number") {
            cfg.triburstDamage = abilityConfig.triburst.damage;
        }
        if (abilityConfig.shockwave && typeof abilityConfig.shockwave.damage === "number") {
            cfg.shockwaveDamage = abilityConfig.shockwave.damage;
        }
    }

    function newPlayer() {
        return {
            health: cfg.maxHealth,
            maxHealth: cfg.maxHealth,
            shields: 0,
            maxShields: 0,
            alive: true,
            lastHitAt: 0
        };
    }

    const players = { 1: newPlayer(), 2: newPlayer() };

    // Damage sources currently "in the air", per shooter slot. A hit
    // claim has to be able to consume one of these, which is what stops
    // a client claiming damage the opponent never actually dealt.
    let sources = [];   // { slot, damage, from, until, kind }
    let nextSourceId = 1;

    function prune(now) {
        if (!sources.length) return;
        sources = sources.filter(s => now <= s.until + cfg.claimSlackMs);
    }

    return {
        config: cfg,

        // Shield charges come from the Kevlar power, which lives on the
        // player's own account loadout. server.js reports it once at
        // match start; it is capped so a client cannot grant itself an
        // arbitrary number of free hits.
        setShields(slot, count) {
            const p = players[slot];
            if (!p) return;
            const n = Math.max(0, Math.min(3, Math.floor(Number(count) || 0)));
            p.maxShields = n;
            p.shields = n;
        },

        // ---- damage sources -------------------------------------------
        // Every projectile the shooter relays is tracked. `damage` is
        // NOT taken from the message: it is derived from the server's
        // own config, so a client that relays damage:99 still only ever
        // gets the real number applied.
        trackBullet(slot, msg, now) {
            if (!players[slot]) return;
            prune(now);
            // A triburst pellet is distinguishable by carrying an
            // explicit finite range; ordinary fire has none.
            const isAbilityShot = typeof msg.range === "number" && isFinite(msg.range) && msg.range > 0;
            sources.push({
                id: nextSourceId++,
                slot: slot,
                kind: isAbilityShot ? "triburst" : "bullet",
                damage: isAbilityShot ? cfg.triburstDamage : cfg.bulletDamage,
                from: now,
                until: now + cfg.bulletMaxFlightMs
            });
        },

        trackShockwave(slot, now) {
            if (!players[slot]) return;
            prune(now);
            sources.push({
                id: nextSourceId++,
                slot: slot,
                kind: "shockwave",
                damage: cfg.shockwaveDamage,
                from: now,
                until: now + cfg.shockwaveWindowMs
            });
        },

        // ---- the authoritative hit ------------------------------------
        // Called when `victimSlot`'s client reports that something
        // connected on it. The client supplies NO numbers: not the
        // damage, not the resulting health, not whether it died. All of
        // that is decided here.
        //
        // Known residual gap: because detection still happens on the
        // victim's machine, a modified client can stay silent and simply
        // never claim to be hit. Closing that needs the server to
        // simulate projectiles against player positions itself, which
        // would also make hit registration less accurate than it is
        // today (the server's view of a position is always ~half an RTT
        // stale). That trade is deliberately not taken here.
        claimHit(victimSlot, now) {
            const victim = players[victimSlot];
            if (!victim) return { accepted: false, reason: "no-such-slot" };
            if (!victim.alive) return { accepted: false, reason: "already-eliminated" };
            if (now - victim.lastHitAt < cfg.minMsBetweenHits) {
                return { accepted: false, reason: "rate-limited" };
            }

            prune(now);

            // Must correspond to something the OPPONENT actually fired
            // and that could still be in flight. Oldest first, so a
            // burst is consumed in the order it was fired.
            const shooter = otherSlot(victimSlot);
            let idx = -1;
            for (let i = 0; i < sources.length; i++) {
                const s = sources[i];
                if (s.slot === shooter && now >= s.from - cfg.claimSlackMs && now <= s.until + cfg.claimSlackMs) {
                    idx = i;
                    break;
                }
            }
            if (idx === -1) return { accepted: false, reason: "no-matching-shot" };

            const source = sources[idx];
            sources.splice(idx, 1); // one shot can only ever land once
            victim.lastHitAt = now;

            const damage = Math.max(1, Math.min(cfg.maxDamagePerHit, Math.floor(source.damage) || 1));

            // Shields absorb a whole hit, exactly as index.html does.
            let blocked = false;
            if (victim.shields > 0) {
                victim.shields--;
                blocked = true;
            } else {
                victim.health -= damage;
                if (victim.health <= 0) {
                    victim.health = 0;
                    victim.alive = false;
                }
            }

            return {
                accepted: true,
                slot: victimSlot,
                by: shooter,
                kind: source.kind,
                damage: blocked ? 0 : damage,
                blocked: blocked,
                health: victim.health,
                shields: victim.shields,
                eliminated: !victim.alive
            };
        },

        // ---- lifecycle -------------------------------------------------
        // A new round restores both players and clears anything still
        // tracked, so a shot fired in the previous round can never land
        // in the next one.
        resetRound() {
            for (const slot of [1, 2]) {
                const p = players[slot];
                p.health = p.maxHealth;
                p.shields = p.maxShields;
                p.alive = true;
                p.lastHitAt = 0;
            }
            sources = [];
        },

        // A rematch/new match additionally forgets the loadouts, since
        // the next match re-reports them.
        resetMatch() {
            players[1] = newPlayer();
            players[2] = newPlayer();
            sources = [];
        },

        isAlive(slot) {
            return !!(players[slot] && players[slot].alive);
        },

        stateFor(slot) {
            const p = players[slot];
            if (!p) return null;
            return { slot: slot, health: p.health, shields: p.shields, alive: p.alive };
        },

        // Diagnostics only (DEBUG_NETWORKING).
        debugState() {
            return {
                p1: this.stateFor(1),
                p2: this.stateFor(2),
                trackedSources: sources.length
            };
        }
    };
}

module.exports = { COMBAT_CONFIG, createCombatMatch };
