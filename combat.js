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
    overchargeDamage: 2,

    // Ability cooldowns this module enforces server-side (see
    // activateAbility below). Fallbacks only -- server.js passes the
    // live, admin-tunable seconds-based values in via createCombatMatch,
    // same as the damage numbers above.
    abilityCooldownMs: {
        gravitytrap: 9000,
        phaseshift: 14000,
        huntersmark: 6000,
        portal: 18000,
        overcharge: 15000
    },
    phaseShiftDurationMs: 1000,

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
        if (abilityConfig.overcharge) {
            if (typeof abilityConfig.overcharge.damage === "number") cfg.overchargeDamage = abilityConfig.overcharge.damage;
            if (typeof abilityConfig.overcharge.cooldown === "number") cfg.abilityCooldownMs.overcharge = abilityConfig.overcharge.cooldown * 1000;
        }
        if (abilityConfig.phaseshift) {
            if (typeof abilityConfig.phaseshift.duration === "number") cfg.phaseShiftDurationMs = abilityConfig.phaseshift.duration * 1000;
            if (typeof abilityConfig.phaseshift.cooldown === "number") cfg.abilityCooldownMs.phaseshift = abilityConfig.phaseshift.cooldown * 1000;
        }
        if (abilityConfig.gravitytrap && typeof abilityConfig.gravitytrap.cooldown === "number") {
            cfg.abilityCooldownMs.gravitytrap = abilityConfig.gravitytrap.cooldown * 1000;
        }
        if (abilityConfig.huntersmark && typeof abilityConfig.huntersmark.cooldown === "number") {
            cfg.abilityCooldownMs.huntersmark = abilityConfig.huntersmark.cooldown * 1000;
        }
        if (abilityConfig.portal && typeof abilityConfig.portal.cooldown === "number") {
            cfg.abilityCooldownMs.portal = abilityConfig.portal.cooldown * 1000;
        }
    }

    function newPlayer() {
        return {
            health: cfg.maxHealth,
            maxHealth: cfg.maxHealth,
            shields: 0,
            maxShields: 0,
            alive: true,
            lastHitAt: 0,

            // ---- new abilities' server-authoritative state ----
            phaseUntil: 0,             // Phase Shift: claimHit() rejects any hit while now < this
            overchargeShotsRemaining: 0, // Overcharge: only this many NEXT tracked bullets can be boosted
            huntersMarkReady: false,   // Hunter's Mark: only the next tracked bullet can carry the flag
            abilityLastUsed: {}        // { [abilityId]: ms timestamp }, for activateAbility's cooldown gate
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

        // ---- ability activation / cooldowns ----------------------------
        // The ONLY place an activation of one of the 5 new abilities is
        // considered valid. A client that claims to activate one faster
        // than its own configured cooldown allows is simply refused --
        // its own optimistic local effect already happened (same
        // client-prediction pattern every existing ability uses), but
        // that refusal is what stops the server's own state (phaseUntil,
        // overchargeShotsRemaining, huntersMarkReady) from ever being
        // refreshed faster than the real cooldown, which is the actual
        // exploit surface this closes: a modified client spamming
        // activation messages to keep itself permanently phased or
        // permanently topped up on Overcharge shots.
        activateAbility(slot, abilityId, now) {
            const p = players[slot];
            if (!p) return { accepted: false, reason: "no-such-slot" };
            const cooldownMs = cfg.abilityCooldownMs[abilityId];
            if (typeof cooldownMs !== "number") return { accepted: false, reason: "unknown-ability" };
            const lastUsed = p.abilityLastUsed[abilityId] || 0;
            if (now - lastUsed < cooldownMs) {
                return { accepted: false, reason: "cooldown" };
            }
            p.abilityLastUsed[abilityId] = now;

            if (abilityId === "phaseshift") {
                p.phaseUntil = now + cfg.phaseShiftDurationMs;
            } else if (abilityId === "overcharge") {
                p.overchargeShotsRemaining = 2;
            } else if (abilityId === "huntersmark") {
                p.huntersMarkReady = true;
            }
            return { accepted: true };
        },

        // Diagnostics/UI only -- never used to decide whether a hit lands.
        isPhased(slot, now) {
            const p = players[slot];
            return !!(p && now < p.phaseUntil);
        },

        // ---- damage sources -------------------------------------------
        // Every projectile the shooter relays is tracked. `damage` is
        // NOT taken from the message: it is derived from the server's
        // own config, so a client that relays damage:99 still only ever
        // gets the real number applied.
        trackBullet(slot, msg, now) {
            const shooter = players[slot];
            if (!shooter) return;
            prune(now);
            // A triburst pellet is distinguishable by carrying an
            // explicit finite range; ordinary fire has none.
            const isAbilityShot = typeof msg.range === "number" && isFinite(msg.range) && msg.range > 0;

            // Overcharge: honored only up to however many boosted shots
            // this slot's OWN activateAbility call actually granted --
            // never simply because the message claims overcharged:true.
            // Consumed here, one per tracked bullet, so a client cannot
            // get more than the 2 real activations gave it regardless of
            // how many shots it fires or what it claims about them.
            const isOvercharged = msg.overcharged === true && shooter.overchargeShotsRemaining > 0;
            if (isOvercharged) shooter.overchargeShotsRemaining--;

            // Hunter's Mark: same one-shot consumption pattern, gated on
            // the server's own huntersMarkReady flag rather than the
            // message's claim. Doesn't change damage -- only recorded so
            // a client can't claim an unlimited number of "marked" shots.
            const isMarked = msg.homing === true && shooter.huntersMarkReady;
            if (isMarked) shooter.huntersMarkReady = false;

            const damage = isOvercharged ? cfg.overchargeDamage
                : isAbilityShot ? cfg.triburstDamage
                : cfg.bulletDamage;

            sources.push({
                id: nextSourceId++,
                slot: slot,
                kind: isOvercharged ? "overcharge" : (isAbilityShot ? "triburst" : "bullet"),
                damage: damage,
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
            // Phase Shift: rejected before touching `sources` at all, so
            // a genuinely in-flight shot from an honest opponent is
            // still there to land a moment later once phasing ends --
            // this only ever refuses the CLAIM, it never consumes
            // anything. The client-side collision check already skips a
            // phased target the same way it already skips a dashing one
            // (see index.html), so an honest client never even sends
            // this claim while phased; this is the backstop for a
            // request that arrives anyway.
            if (now < victim.phaseUntil) return { accepted: false, reason: "phased" };
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
                // Transient effects AND cooldowns end with the round --
                // matches index.html's resetPositions(), which rebuilds
                // p1/p2 from scratch every round (abilityCd: 0 included,
                // see makePlayer), not just at match start. Mirroring
                // that here is what keeps the client's cooldown UI and
                // this server-side gate from disagreeing the moment a
                // new round begins.
                p.phaseUntil = 0;
                p.overchargeShotsRemaining = 0;
                p.huntersMarkReady = false;
                p.abilityLastUsed = {};
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
