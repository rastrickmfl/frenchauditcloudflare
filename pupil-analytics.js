// GET /api/pupil-analytics?account=<teacher>&targets=acc1,acc2,...&today=YYYY-MM-DD
//   -> { pupils: { acc1: { ratings, streak:{current,longest}, logins:[...],
//                          name, showHigher, customLists:[...] }, ... } }
//
// Teacher-only. One bulk read across four per-pupil stores (ratings +
// showHigher + saved Custom AQA Vocabulary Sets from pupil-progress, streak
// record, last-5 logins, optional display name) for a whole list of target
// accounts at once — four D1 queries total regardless of class size,
// rather than one round trip per pupil. This is the endpoint the class
// RAG breakdown, Independent Study analytics, streak/activity, and
// per-pupil drill-down screens all read from.
//
// `name` and `customLists` were added alongside the per-pupil drill-down
// screen (25 Aug 2026) — every existing caller only ever read `ratings`/
// `streak`/`logins` off each pupil, so this is purely additive.
//
// `today`, if given, is used to compute an accurate *display* streak
// (applying the same missed-day/freeze logic /api/streaks uses) without
// persisting anything — a teacher looking at this shouldn't be able to
// spend a pupil's monthly freeze just by opening the page. If omitted,
// the raw last-saved streak numbers are returned as-is.

import { ACCOUNT_SET, TEACHER_SET } from "./accounts.js";
import { kvGetMany, json } from "./kv.js";
import { applyStreakTransition, defaultRecord } from "./streaks.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function handlePupilAnalytics(request, env, url) {
  const account = url.searchParams.get("account");
  if (!account || !ACCOUNT_SET.has(account)) {
    return json({ error: "unknown account" }, 400);
  }
  if (!TEACHER_SET.has(account)) {
    return json({ error: "teacher accounts only" }, 403);
  }
  if (request.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  const targetsParam = url.searchParams.get("targets") || "";
  const targets = targetsParam
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t && ACCOUNT_SET.has(t));
  if (targets.length === 0) {
    return json({ pupils: {} });
  }

  const today = url.searchParams.get("today");
  const useToday = today && DATE_RE.test(today);

  const [progress, streaks, logins, names] = await Promise.all([
    kvGetMany(env, "pupil-progress", targets),
    kvGetMany(env, "streaks", targets),
    kvGetMany(env, "logins", targets),
    kvGetMany(env, "pupil-names", targets),
  ]);

  const pupils = {};
  for (const acct of targets) {
    const state = progress[acct];
    const ratings = (state && state.ratings) || {};
    const record = streaks[acct] || defaultRecord();
    const extra = {
      name: names[acct] || null,
      // matches index.html's own defaultState() — a pupil who has never
      // synced any state yet defaults to Foundation + Higher client-side,
      // so a brand-new account shouldn't look artificially Foundation-only
      // here just because nothing's been saved for them.
      showHigher: state ? !!state.showHigher : true,
      customLists: (state && state.savedCustomLists) || [],
    };
    if (useToday) {
      // work on a copy — this must never persist a transition on the
      // teacher's behalf
      const copy = Object.assign({}, record);
      applyStreakTransition(copy, today);
      pupils[acct] = Object.assign({
        ratings,
        streak: { current: copy.current, longest: copy.longest },
        logins: logins[acct] || [],
      }, extra);
    } else {
      pupils[acct] = Object.assign({
        ratings,
        streak: { current: record.current, longest: record.longest },
        logins: logins[acct] || [],
      }, extra);
    }
  }

  return json({ pupils });
}
