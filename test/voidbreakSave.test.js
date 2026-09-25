// =====================================================================
// VOIDBREAK SAVE-LAYER REGRESSION TESTS
//
// What this protects: the promise that a player who was here before
// Voidbreak became the game loses nothing. Every save shape below is one
// that EXISTS in the wild -- a record written before the Void Loadout
// field existed, an empty account, a merge between two devices, a
// prestige, and a client trying to write fields it does not own.
//
// Pure: it requires voidbreak.js and nothing else. No server, no
// network, no filesystem, no fixtures. `npm test` runs it.
// =====================================================================
const V = require('../voidbreak.js');
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -- ' + JSON.stringify(extra) : '')); }
};

console.log('\n1. A save written BEFORE the loadout existed');
const old = V.sanitizeSaveData({
  shards: 4200, shardsSpent: 0,
  forge: { vit: 3, pow: 2, swift: 1, core: 0, drive: 1, edge: 2 },
  weapons: { pulse: true, scatter: true, rail: true },
  lastWeapon: 'rail',
  runs: 41, best: 9, kills: 137, beaten: { 1: true, 2: true, 3: true },
  mastery: { rail: 900 },
  universe: { galaxy: 2, systems: { '1:1': 1, '1:2': 1, '1:3': 1, '1:4': 1 }, coins: 3100 }
});
t('loadout exists', !!old.loadout, old.loadout);
t('primary inherits lastWeapon', old.loadout.primary === 'rail', old.loadout);
t('secondary defaults to missile', old.loadout.secondary === 'missile');
t('ability defaults to overdrive', old.loadout.ability === 'overdrive');
t('shards preserved', old.shards === 4200);
t('weapons preserved', old.weapons.rail === true && old.weapons.voidc === false);
t('beaten preserved', Object.keys(old.beaten).length === 3);
t('mastery preserved', old.mastery.rail === 900);
t('universe coins preserved', old.universe.coins === 3100);
t('universe systems preserved', Object.keys(old.universe.systems).length === 4);

console.log('\n2. A totally empty / brand-new account');
t('sanitize(null) is rejected outright', V.sanitizeSaveData(null) === null);
const fresh = V.defaultSaveData();
t('fresh loadout', fresh.loadout.primary === 'pulse' && fresh.loadout.secondary === 'missile');

console.log('\n3. Hostile / malformed loadout input');
const bad = V.sanitizeSaveData({ loadout: { primary: 'BFG9000', secondary: 42, ability: ['x'] } });
t('unknown primary -> pulse', bad.loadout.primary === 'pulse', bad.loadout);
t('non-string secondary -> missile', bad.loadout.secondary === 'missile');
t('array ability -> overdrive', bad.loadout.ability === 'overdrive');
const bad2 = V.sanitizeSaveData({ loadout: 'not-an-object' });
t('loadout as string survives', bad2.loadout.primary === 'pulse');
const bad3 = V.sanitizeSaveData({ weapons: { pulse: true }, loadout: { primary: 'voidc' } });
t('unowned primary rejected', bad3.loadout.primary === 'pulse', bad3.loadout);

console.log('\n4. Merge across two devices');
const devA = V.sanitizeSaveData({ shards: 900, weapons: { pulse: true, rail: true }, loadout: { primary: 'rail', secondary: 'drone', ability: 'blink' } });
const devB = V.sanitizeSaveData({ shards: 300, weapons: { pulse: true, plasma: true } });
const m = V.mergeSaveData(devA, devB);
t('merged keeps higher shards', m.shards === 900);
t('merged unions weapons', m.weapons.rail && m.weapons.plasma);
t('merged keeps A loadout', m.loadout.primary === 'rail' && m.loadout.secondary === 'drone');
// A primary only device B owns must not survive a merge that drops it.
const devC = V.sanitizeSaveData({ weapons: { pulse: true, rail: true }, loadout: { primary: 'rail' } });
const devD = V.sanitizeSaveData({ weapons: { pulse: true } });
t('merge never points at an unowned weapon', V.mergeSaveData(devD, devC).weapons[V.mergeSaveData(devD, devC).loadout.primary] === true);

console.log('\n5. Prestige');
// Prestige needs every weapon, every Forge upgrade maxed, and the
// Origin beaten -- build exactly that save so the reset is really tested.
const allWeapons = {}; V.WEAPON_KEYS.forEach(k => { allWeapons[k] = true; });
const maxForge = {}; V.FORGE_KEYS.forEach(k => { maxForge[k] = 99; });
const rich = V.sanitizeSaveData({
  shards: 9999, weapons: allWeapons, forge: maxForge,
  loadout: { primary: 'voidc', secondary: 'barrier', ability: 'blink' },
  beaten: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true, 8: true },
  universe: { galaxy: 3, systems: { '1:1': 1 }, discovered: { '1:1': ['g1s1_star'] } }
});
t('rich save is prestige-eligible', V.prestigeStatus(rich).eligible, V.prestigeStatus(rich).requirements);
const pr = V.applyPrestige(rich, true);
if (pr && pr.ok) {
  t('prestige resets loadout primary', pr.save.loadout.primary === 'pulse', pr.save.loadout);
  t('prestige resets secondary', pr.save.loadout.secondary === 'missile');
  t('prestige keeps discoveries', Object.keys(pr.save.universe.discovered).length === 1);
} else {
  console.log('  SKIP prestige (not eligible / not exported):', pr && pr.error);
}

console.log('\n6. The arbiter (what /voidbreak/save actually stores)');
const r = V.resolveSaveConflict(old, null, {});
t('first save accepted', !!r.data && r.data.loadout.primary === 'rail', r.reason);
const r2 = V.resolveSaveConflict(fresh, old, {});
t('empty save never beats real progress', r2.data.shards === 4200, r2.reason);
t('arbiter output keeps the loadout', !!r2.data.loadout, r2.data.loadout);

// Picking gear on the Loadout screen changes NO progress at all. That
// upload used to look like "nothing new" to the arbiter, which handed
// back the stored save -- and the client adopted it, snapping the pick
// straight back to the default. The loadout is a choice, so the upload
// wins it, and the change has to count as a real write.
const pick = V.sanitizeSaveData(Object.assign(JSON.parse(JSON.stringify(old)),
  { loadout: { primary: 'scatter', secondary: 'drone', ability: 'blink' } }));
const r3 = V.resolveSaveConflict(pick, old, {});
t('a pure loadout change is stored (secondary + ability)',
  r3.data.loadout.secondary === 'drone' && r3.data.loadout.ability === 'blink', r3.data.loadout);
t('a pure loadout change is stored (primary + lastWeapon)',
  r3.data.loadout.primary === 'scatter' && r3.data.lastWeapon === 'scatter', r3.data.loadout);
t('a pure loadout change counts as a write', r3.changed === true, r3.reason);
const none = V.sanitizeSaveData(Object.assign(JSON.parse(JSON.stringify(old)),
  { loadout: { primary: 'rail', secondary: 'none', ability: 'none' } }));
const r4 = V.resolveSaveConflict(none, r3.data, {});
t('"none" is a real choice, not a reset to default',
  r4.data.loadout.secondary === 'none' && r4.data.loadout.ability === 'none', r4.data.loadout);
const same = V.resolveSaveConflict(JSON.parse(JSON.stringify(r4.data)), r4.data, {});
t('an identical re-upload is still a no-op', same.changed === false, same.reason);
// A device BEHIND on progress still gets to change its gear, and still
// can't drag progress down while doing it.
const behind = V.sanitizeSaveData({ shards: 10, weapons: { pulse: true },
  loadout: { primary: 'pulse', secondary: 'barrier', ability: 'mark' } });
const r5 = V.resolveSaveConflict(behind, old, {});
t('a lower-progress device can still change its loadout',
  r5.data.loadout.secondary === 'barrier' && r5.data.loadout.ability === 'mark', r5.data.loadout);
t('...without lowering progress', r5.data.shards === 4200 && r5.data.weapons.rail === true, r5.data.shards);
// A primary the account doesn't own is refused; the rest of the pick still lands.
const bogus = V.sanitizeSaveData(Object.assign(JSON.parse(JSON.stringify(old)),
  { loadout: { primary: 'voidc', secondary: 'drone', ability: 'blink' } }));
bogus.loadout.primary = 'voidc';
const r6 = V.resolveSaveConflict(bogus, old, {});
t('an unowned primary is never equipped', r6.data.loadout.primary !== 'voidc' && r6.data.weapons.voidc !== true, r6.data.loadout);

console.log('\n7. applyClientSave -- server-owned fields stay server-owned');
const stored = V.sanitizeSaveData({ shards: 500, shardsSpent: 200, shopOwned: ['title_breaker'],
  loadout: { primary: 'pulse', secondary: 'drone', ability: 'mark' } });
stored.shardsSpent = 200; stored.shopOwned = ['title_breaker'];
const claimEverything = V.sanitizeSaveData({ shards: 500, shardsSpent: 0, shopOwned: ['skin_prestige'],
  loadout: { primary: 'pulse', secondary: 'barrier', ability: 'blink' } });
const applied = V.applyClientSave(claimEverything, stored);
t('client cannot zero shardsSpent', applied.shardsSpent === 200, applied.shardsSpent);
t('client cannot grant itself cosmetics', applied.shopOwned.join() === 'title_breaker', applied.shopOwned);
t('client CAN change its own loadout', applied.loadout.secondary === 'barrier', applied.loadout);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
