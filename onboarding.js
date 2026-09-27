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

return {
    defaultOnboarding: defaultOnboarding,
    onboardingOf: onboardingOf,
    isOnboarded: isOnboarded,
    applyStep: applyStep,
    STEPS: STEPS
};
});
