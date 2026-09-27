// =====================================================================
// ONBOARDING + DAILY REWARD RULE TESTS
//
// What this protects: that no existing player is ever pushed through
// onboarding or has anything locked (a missing record reads as done),
// that onboarding flags only ever go up, and that the daily streak pays
// exactly one claim per UTC day with the documented missed-day reset.
//
// Pure: it requires onboarding.js and nothing else. `npm test` runs it.
// =====================================================================
const O = require('../onboarding.js');
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -- ' + JSON.stringify(extra) : '')); }
};

console.log('\n1. Existing players are unaffected');
const legacy = { name: 'Old Pilot', tutorialComplete: false };   // a duel-tutorial era account
t('a missing record reads as fully onboarded', O.isOnboarded(legacy));
t('...and never shows the unlock callout', O.onboardingOf(legacy).unlockSeen === true);
t('the old tutorialComplete:false is ignored', O.onboardingOf(legacy).introComplete === true);
t('a malformed record is treated as missing', O.isOnboarded({ onboarding: 'yes' }));

console.log('\n2. A brand-new account walks the journey');
let rec = O.defaultOnboarding();
t('new account starts locked', !O.isOnboarded({ onboarding: rec }) && !rec.introComplete);
rec = O.applyStep(rec, 'intro').record;
t('intro recorded', rec.introComplete && !rec.tutorialComplete);
rec = O.applyStep(rec, 'choice', 'new').record;
t('"new" path recorded, still locked', rec.path === 'new' && !rec.tutorialComplete);
const second = O.applyStep(rec, 'choice', 'veteran').record;
t('the choice cannot be changed once made', second.path === 'new' && !second.tutorialComplete);
rec = O.applyStep(rec, 'tutorial').record;
t('training unlocks', O.isOnboarded({ onboarding: rec }) && !rec.unlockSeen);
rec = O.applyStep(rec, 'unlockSeen').record;
t('callout recorded once', rec.unlockSeen);
const vet = O.applyStep(O.defaultOnboarding(), 'choice', 'veteran').record;
t('"played before" unlocks immediately but still announces it', vet.tutorialComplete && vet.introComplete && !vet.unlockSeen);
t('unknown step refused', !!O.applyStep(rec, 'reset').error);
t('unknown path refused', !!O.applyStep(O.defaultOnboarding(), 'choice', 'admin').error);
const input = O.defaultOnboarding();
O.applyStep(input, 'tutorial');
t('applyStep never mutates its input', input.tutorialComplete === false);

console.log('\n3. Daily reward -- 7-day streak, one claim per UTC day');
let d = O.defaultDailyReward();
const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08'];
const paid = [];
for (const day of days) { const c = O.claimDaily(d, day); paid.push(c.reward); d = c.record; }
t('days 1-6 escalate, day 7 is the big one', paid.slice(0, 7).join() === '20,25,30,40,50,60,150', paid);
t('day 8 starts a new cycle', paid[7] === 20, paid);
t('a second claim on the same day is refused', !!O.claimDaily(d, '2026-09-08').error);
const st = O.dailyState(d, '2026-09-08');
t('state after claiming: not claimable', st.claimable === false && st.cycleDay === 1);
const missed = O.claimDaily({ streak: 5, lastClaimDate: '2026-09-01' }, '2026-09-03');
t('a missed day resets the streak to day 1', missed.record.streak === 1 && missed.reward === 20, missed);
const sixth = O.claimDaily({ streak: 6, lastClaimDate: '2026-09-26' }, '2026-09-27');
t('a six-day streak claims day 7 for 150', sixth.cycleDay === 7 && sixth.reward === 150, sixth);
t('month boundary counts as consecutive', O.claimDaily({ streak: 2, lastClaimDate: '2026-09-30' }, '2026-10-01').record.streak === 3);
t('a garbage stored record is treated as never claimed', O.dailyState({ streak: 'x', lastClaimDate: 12 }, '2026-09-27').cycleDay === 1);
t('an older account with no record can claim day 1', O.claimDaily(undefined, '2026-09-27').reward === 20);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
