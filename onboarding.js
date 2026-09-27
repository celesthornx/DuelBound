// =====================================================================
// ONBOARDING -- the first-login journey (story intro -> "new or
// veteran?" -> Voidbreak's guided training sector) as account state.
//
// Pure module in the same role catalog.js/battlepass.js play: no
// sockets, no storage, no HTTP. server.js owns persistence and calls
// these to decide what a record is and how it may change.
//
// WHY A NEW RECORD RATHER THAN `tutorialComplete`
// ------------------------------------------------
// The old duel-arena tutorial stored account.tutorialComplete. That
// field could not be reused: every account created after it shipped
// was born with `false`, and anyone who left that tutorial without
// finishing or skipping it still carries that `false` today -- they
// are real, returning players, and reading their stale flag as "has
// not onboarded" would push them through a cutscene and hide a Home
// Planet they may already have built on.
//
// THE MIGRATION IS "MISSING MEANS DONE"
// -------------------------------------
// defaultAccount() writes an explicit all-false record for a brand-new
// account. An account without the record predates this feature and is
// by definition an existing player, so onboardingOf() resolves a
// missing record to all-true. Nothing has to rewrite the store, and no
// code path can hide anything from an existing account by omission --
// the same "absent is the safe state" shape the old tutorialComplete
// migration had, without needing a write to make it true.
//
// Every flag only ever goes false -> true (applyStep). A client asking
// to "un-complete" something has no verb for it.
//
// SHARED, LIKE voidbreakUniverse.js
// ---------------------------------
// server.js requires this; index.html loads it with a <script> tag so a
// GUEST (no account, no server record) runs the exact same rules against
// its local mirror instead of a second, hand-copied version of them.
// Nothing here is a secret or decides a currency on its own authority --
// the server re-applies these rules to its own stored record on every
// write -- which is why it is on server.js's PUBLIC_FILES allowlist.
// =====================================================================

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.VBOnboarding = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

function defaultOnboarding() {
    return {
        introComplete: false,     // story cutscene finished or skipped
        tutorialComplete: false,  // training sector finished or skipped; unlocks Home Planet + shops
        path: "",                 // "" (not chosen yet) | "new" | "veteran"
        unlockSeen: false         // the one-time "HOME PLANET UNLOCKED" callout has been shown
    };
}

const COMPLETE = Object.freeze({ introComplete: true, tutorialComplete: true, path: "veteran", unlockSeen: true });

// The account's onboarding state, always a complete, well-typed copy.
function onboardingOf(account) {
    const rec = account && account.onboarding;
    if (!rec || typeof rec !== "object") return Object.assign({}, COMPLETE);
    return {
        introComplete: rec.introComplete === true,
        tutorialComplete: rec.tutorialComplete === true,
        path: (rec.path === "new" || rec.path === "veteran") ? rec.path : "",
        unlockSeen: rec.unlockSeen === true
    };
}

// The one gate everything unlockable reads: Home Planet, the shops,
// idle income, the daily reward. Server-side it is what turns a hidden
// button into an enforced rule.
function isOnboarded(account) {
    return onboardingOf(account).tutorialComplete;
}

const STEPS = ["intro", "choice", "tutorial", "unlockSeen"];

// Applies one step to a record and returns the NEW record (the input is
// never mutated), or { error } for an unknown step. Monotonic by
// construction: every branch only sets flags to true.
//
//   intro      -- the cutscene ended (finished or skipped)
//   choice     -- "I'm new here" (path "new") or "I've played before"
//                 (path "veteran", which completes everything the
//                 tutorial would have, so the veteran lands unlocked)
//   tutorial   -- the training sector ended (finished or skipped)
//   unlockSeen -- the hub has shown the unlock callout once
//
// A path, once chosen, is never changed: the choice is never offered
// twice, so a second answer is simply ignored.
function applyStep(rec, step, path) {
    if (STEPS.indexOf(step) === -1) return { error: "Unknown step" };
    const next = Object.assign({}, rec);
    if (step === "intro") {
        next.introComplete = true;
    } else if (step === "choice") {
        if (path !== "new" && path !== "veteran") return { error: "Unknown path" };
        next.introComplete = true;
        if (!next.path) next.path = path;
        if (next.path === "veteran") next.tutorialComplete = true;
    } else if (step === "tutorial") {
        next.introComplete = true;
        next.tutorialComplete = true;
        if (!next.path) next.path = "new";
    } else if (step === "unlockSeen") {
        next.unlockSeen = true;
    }
    return { record: next };
}

// =====================================================================
// DAILY REWARD -- a 7-day login streak, paid in account Coins.
//
// Lives here beside onboarding because it is the same kind of thing:
// small account state about showing up, with pure rules the server
// applies to its stored record and the hub only renders.
//
// Dates are UTC calendar days ("YYYY-MM-DD") from the SERVER's clock
// (server.js's todayUTC), never the player's -- a device clock or time
// zone cannot mint an extra day.
//
// THE RULE FOR A MISSED DAY: the streak resets to day 1. Claiming on
// the day after the last claim continues it; claiming any later starts
// over. Day 7 pays the big reward, then day 8 is day 1 of a new cycle.
// One claim per UTC day, enforced against the stored lastClaimDate, so
// a replay/refresh/second tab cannot claim twice.
//
// Coins only, deliberately: Void Shards feed a finished, balanced
// economy (Forge, Shard Shop, Mastery, Prestige), and account Coins are
// already what Daily Challenges pay. A week of streak (375) is about
// two days of Daily Challenges. (Proposed numbers.)
// =====================================================================
var DAILY_REWARDS = [20, 25, 30, 40, 50, 60, 150];

function defaultDailyReward() { return { streak: 0, lastClaimDate: "" }; }

function dailyRecord(rec) {
    var r = (rec && typeof rec === "object") ? rec : {};
    return {
        streak: Math.max(0, Math.floor(Number(r.streak) || 0)),
        lastClaimDate: (typeof r.lastClaimDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.lastClaimDate)) ? r.lastClaimDate : ""
    };
}

function previousDay(dateStr) {
    var d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

// What the pilot sees today: whether they can claim, which day of the
// 7 the claim is (or was), and the whole table so day 7 is visible.
function dailyState(rec, today) {
    var r = dailyRecord(rec);
    var claimable = r.lastClaimDate !== today;
    var continuing = r.lastClaimDate !== "" && r.lastClaimDate === previousDay(today);
    // The streak the next claim produces -- or, already claimed, today's.
    var streakForDay = claimable ? (continuing ? r.streak + 1 : 1) : Math.max(1, r.streak);
    var cycleDay = ((streakForDay - 1) % DAILY_REWARDS.length) + 1;
    return {
        claimable: claimable,
        streak: (claimable && !continuing) ? 0 : r.streak,
        cycleDay: cycleDay,
        reward: DAILY_REWARDS[cycleDay - 1],
        rewards: DAILY_REWARDS.slice(),
        lastClaimDate: r.lastClaimDate,
        today: today
    };
}

// Returns { record, reward, cycleDay } or { error } if today is claimed.
function claimDaily(rec, today) {
    var st = dailyState(rec, today);
    if (!st.claimable) return { error: "Already claimed today" };
    var r = dailyRecord(rec);
    var continuing = r.lastClaimDate !== "" && r.lastClaimDate === previousDay(today);
    return {
        record: { streak: continuing ? r.streak + 1 : 1, lastClaimDate: today },
        reward: st.reward,
        cycleDay: st.cycleDay
    };
}

return {
    DAILY_REWARDS: DAILY_REWARDS,
    defaultDailyReward: defaultDailyReward,
    dailyState: dailyState,
    claimDaily: claimDaily,
    previousDay: previousDay,
    defaultOnboarding: defaultOnboarding,
    onboardingOf: onboardingOf,
    isOnboarded: isOnboarded,
    applyStep: applyStep,
    STEPS: STEPS
};
});
