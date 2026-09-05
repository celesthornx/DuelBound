// =====================================================================
// SHADOW HIT DETECTION
//
// What this is for
// ----------------
// combat.js made the server authoritative over health: a client can only
// say "something connected on me", and the server decides the damage and
// the death. What it still cannot do is notice a client that says
// NOTHING -- hit detection itself still happens on the victim's machine,
// so a modified client can simply never report being hit.
//
// Closing that means detecting hits here instead. The catch is accuracy:
// this server only ever sees a position ~half an RTT late and at the
// client's send rate, so its idea of where someone was is always a
// little behind the truth. Switching straight over would trade a cheat
// for something worse -- players being hit behind cover, or clean shots
// not registering.
//
// So this module runs the detection WITHOUT acting on it. It simulates
// every relayed projectile against the positions the server already
// receives, works out whether it thinks a hit happened, and then just
// compares that verdict against what the client actually reported:
//
//   agreed      -- both saw the hit                  (detection is working)
//   serverOnly  -- we saw it, the client never said  (possible suppression)
//   clientOnly  -- the client said, we missed it     (we'd have denied a real hit)
//
// Read those counters (GET /__net/stats) over real traffic. When
// serverOnly is ~0 for honest players and clientOnly is small enough to
// live with, the same simulation can be promoted to authoritative. Until
// then it costs nothing: the whole thing is off unless
// SHADOW_HIT_DETECTION=1 is set.
//
// Geometry below MIRRORS index.html. If the arena, player size or bullet
// size ever changes there, it has to change here too or the agreement
// numbers become meaningless.
// =====================================================================

const W = 900;
const H = 540;
const PLAYER_R = 15;
const BULLET_R = 4;

// index.html's CLASSIC_COVERS, verbatim.
const CLASSIC_COVERS = [
    { x: W / 2 - 18, y: H / 2 - 70, w: 36, h: 140 },
    { x: 210, y: 120, w: 100, h: 22 },
    { x: W - 310, y: H - 142, w: 100, h: 22 },
    { x: 150, y: H - 180, w: 22, h: 110 },
    { x: W - 172, y: 70, w: 22, h: 110 }
];
// Football and Bomb Run drop the centre wall; Heist adds its two bases.
const NO_CENTER_COVERS = CLASSIC_COVERS.slice(1);
const HEIST_W = 64, HEIST_H = 100;
const HEIST_BASES = [
    { x: 22, y: H / 2 - HEIST_H / 2, w: HEIST_W, h: HEIST_H },
    { x: W - 22 - HEIST_W, y: H / 2 - HEIST_H / 2, w: HEIST_W, h: HEIST_H }
];
const HEIST_COVERS = CLASSIC_COVERS.concat(HEIST_BASES);

function coversFor(gameType) {
    if (gameType === "football" || gameType === "bombrun") return NO_CENTER_COVERS;
    if (gameType === "heist") return HEIST_COVERS;
    return CLASSIC_COVERS;
}

// Same test index.html uses.
function circleRectCollide(cx, cy, r, rect) {
    const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
    const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
    const dx = cx - nx, dy = cy - ny;
    return (dx * dx + dy * dy) < r * r;
}

const CFG = {
    // Simulation step. Smaller than the client's frame time so a fast
    // bullet cannot tunnel through a player between steps: at 620 px/s a
    // 16ms step moves ~10px, comfortably under the 19px hit radius.
    stepMs: 16,

    // How long a projectile is simulated before being dropped, as a
    // safety net for one that never hits anything.
    maxLifeMs: 4000,

    // Positions older than this are dropped from the history buffer.
    historyMs: 2000,

    // A server verdict and a client claim are treated as the SAME hit if
    // they land within this window. It has to cover the victim's report
    // making its way back to us.
    pairWindowMs: 700,

    // A client claim is only counted as unmatched once it is older than
    // the pairing window, so a verdict still in flight is not miscounted.
    settleMs: 900
};

function createShadowDetector() {
    let covers = CLASSIC_COVERS;
    let projectiles = [];
    let nextId = 1;

    // slot -> [{ t, x, y, dashing }]
    const history = { 1: [], 2: [] };
    // Opposing decoys absorb bullets in index.html, so they have to be
    // modelled here or every shot that really hit a decoy looks to this
    // module like a hit the client suppressed.
    let decoys = []; // { slot, x, y, expiresAt }

    // Unpaired verdicts/claims waiting to be matched with each other.
    let pendingVerdicts = []; // { slot, t }
    let pendingClaims = [];   // { slot, t }

    const stats = {
        agreed: 0,
        serverOnly: 0,   // we detected a hit the client never reported
        clientOnly: 0,   // the client reported a hit we did not detect
        projectilesSimulated: 0,
        // How close the nearest approach was for shots we did NOT call a
        // hit, so a systematic near-miss bias is visible rather than
        // hidden inside clientOnly.
        closestMissPx: null
    };

    function sampleAt(slot, t) {
        const buf = history[slot];
        if (!buf.length) return null;
        if (t <= buf[0].t) return buf[0];
        for (let i = 0; i < buf.length - 1; i++) {
            if (t >= buf[i].t && t <= buf[i + 1].t) {
                const span = (buf[i + 1].t - buf[i].t) || 1;
                const f = (t - buf[i].t) / span;
                return {
                    x: buf[i].x + (buf[i + 1].x - buf[i].x) * f,
                    y: buf[i].y + (buf[i + 1].y - buf[i].y) * f,
                    // Dash is a state, not a position -- never blend it.
                    dashing: buf[i].dashing || buf[i + 1].dashing
                };
            }
        }
        return buf[buf.length - 1];
    }

    // Pairs a new verdict/claim against the opposite list, or parks it.
    function reconcile(list, other, entry) {
        for (let i = 0; i < other.length; i++) {
            if (other[i].slot === entry.slot && Math.abs(other[i].t - entry.t) <= CFG.pairWindowMs) {
                other.splice(i, 1);
                stats.agreed++;
                return;
            }
        }
        list.push(entry);
    }

    function expire(now) {
        for (let i = pendingVerdicts.length - 1; i >= 0; i--) {
            if (now - pendingVerdicts[i].t > CFG.settleMs) {
                pendingVerdicts.splice(i, 1);
                stats.serverOnly++;
            }
        }
        for (let i = pendingClaims.length - 1; i >= 0; i--) {
            if (now - pendingClaims[i].t > CFG.settleMs) {
                pendingClaims.splice(i, 1);
                stats.clientOnly++;
            }
        }
        decoys = decoys.filter(d => d.expiresAt > now);
    }

    return {
        setArena(gameType) { covers = coversFor(gameType); },

        onPosition(slot, x, y, dashing, now) {
            const buf = history[slot];
            if (!buf) return;
            buf.push({ t: now, x: x, y: y, dashing: !!dashing });
            const cutoff = now - CFG.historyMs;
            while (buf.length && buf[0].t < cutoff) buf.shift();
        },

        onDecoy(slot, x, y, lifeSeconds, now) {
            decoys = decoys.filter(d => d.slot !== slot);
            decoys.push({
                slot: slot, x: x, y: y,
                expiresAt: now + Math.max(0, Math.min(20, Number(lifeSeconds) || 0)) * 1000
            });
        },

        onBullet(slot, msg, now) {
            const vx = Number(msg.vx), vy = Number(msg.vy);
            if (!isFinite(vx) || !isFinite(vy)) return;
            projectiles.push({
                id: nextId++,
                slot: slot,
                x: Number(msg.x) || 0,
                y: Number(msg.y) || 0,
                vx: vx, vy: vy,
                bounces: Math.max(0, Math.min(5, Math.floor(Number(msg.bounces) || 0))),
                range: (typeof msg.range === "number" && isFinite(msg.range)) ? msg.range : null,
                traveled: 0,
                bornAt: now,
                lastT: now,
                closest: Infinity
            });
            stats.projectilesSimulated++;
        },

        // The client told us it was hit. Pair it with our own verdict.
        onClaim(victimSlot, now) {
            reconcile(pendingClaims, pendingVerdicts, { slot: victimSlot, t: now });
        },

        // Advances every projectile to `now` and records a verdict for
        // any that reaches the opponent. Called from one shared tick.
        step(now, isAlive) {
            expire(now);
            if (!projectiles.length) return;

            const survivors = [];
            for (const b of projectiles) {
                let dead = false;
                let t = b.lastT;

                while (t < now && !dead) {
                    const dt = Math.min(CFG.stepMs, now - t) / 1000;
                    t += dt * 1000;

                    b.x += b.vx * dt;
                    b.y += b.vy * dt;
                    if (b.range !== null) {
                        b.traveled += Math.hypot(b.vx * dt, b.vy * dt);
                        if (b.traveled >= b.range) { dead = true; break; }
                    }
                    if (now - b.bornAt > CFG.maxLifeMs) { dead = true; break; }

                    // Arena bounds -- bounce if it has ricochet left.
                    if (b.x < 0 || b.x > W || b.y < 0 || b.y > H) {
                        if (b.bounces > 0) {
                            if (b.x < 0 || b.x > W) { b.vx = -b.vx; b.x = Math.max(BULLET_R, Math.min(W - BULLET_R, b.x)); }
                            if (b.y < 0 || b.y > H) { b.vy = -b.vy; b.y = Math.max(BULLET_R, Math.min(H - BULLET_R, b.y)); }
                            b.bounces--;
                        } else { dead = true; break; }
                    }

                    // Cover -- same face-detection and nudge as index.html.
                    for (const c of covers) {
                        if (!circleRectCollide(b.x, b.y, BULLET_R, c)) continue;
                        if (b.bounces > 0) {
                            const withinX = b.x > c.x && b.x < c.x + c.w;
                            const withinY = b.y > c.y && b.y < c.y + c.h;
                            if (withinX && !withinY) b.vy = -b.vy;
                            else if (withinY && !withinX) b.vx = -b.vx;
                            else { b.vx = -b.vx; b.vy = -b.vy; }
                            b.bounces--;
                            b.x += b.vx * 0.02;
                            b.y += b.vy * 0.02;
                        } else dead = true;
                        break;
                    }
                    if (dead) break;

                    // An opposing decoy eats the shot, exactly as on the client.
                    for (const d of decoys) {
                        if (d.slot === b.slot) continue;
                        if (Math.hypot(b.x - d.x, b.y - d.y) < BULLET_R + PLAYER_R) { dead = true; break; }
                    }
                    if (dead) break;

                    // The opponent. Dashing players are immune on the
                    // client, so they must be here too.
                    const victimSlot = b.slot === 1 ? 2 : 1;
                    if (isAlive && !isAlive(victimSlot)) continue;
                    const at = sampleAt(victimSlot, t);
                    if (!at || at.dashing) continue;

                    const dist = Math.hypot(b.x - at.x, b.y - at.y);
                    if (dist < b.closest) b.closest = dist;
                    if (dist < BULLET_R + PLAYER_R) {
                        reconcile(pendingVerdicts, pendingClaims, { slot: victimSlot, t: now });
                        dead = true;
                        break;
                    }
                }

                b.lastT = t;
                if (!dead) survivors.push(b);
                else if (b.closest !== Infinity && b.closest >= BULLET_R + PLAYER_R) {
                    if (stats.closestMissPx === null || b.closest < stats.closestMissPx) {
                        stats.closestMissPx = Math.round(b.closest * 10) / 10;
                    }
                }
            }
            projectiles = survivors;
        },

        hasWork() { return projectiles.length > 0; },

        reset() {
            projectiles = [];
            decoys = [];
            pendingVerdicts = [];
            pendingClaims = [];
            history[1] = [];
            history[2] = [];
        },

        snapshot() {
            const decided = stats.agreed + stats.serverOnly + stats.clientOnly;
            return {
                agreed: stats.agreed,
                serverOnly: stats.serverOnly,
                clientOnly: stats.clientOnly,
                // The number to watch before promoting this to
                // authoritative: how often the two verdicts matched.
                agreementPct: decided ? Math.round(stats.agreed / decided * 1000) / 10 : null,
                projectilesSimulated: stats.projectilesSimulated,
                closestMissPx: stats.closestMissPx,
                liveProjectiles: projectiles.length,
                unsettled: pendingVerdicts.length + pendingClaims.length
            };
        }
    };
}

module.exports = {
    createShadowDetector,
    // exported for tests
    _internals: { CLASSIC_COVERS, coversFor, circleRectCollide, W, H, PLAYER_R, BULLET_R, CFG }
};
