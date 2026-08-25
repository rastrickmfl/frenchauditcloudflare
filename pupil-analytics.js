// GET /api/pupil-analytics?account=<teacher>&targets=acc1,acc2,...&today=YYYY-MM-DD
//   -> { pupils: { acc1: { ratings, streak:{current,longest}, logins:[...] }, ... } }
//
// Teacher-only. One bulk read across three per-pupil stores (ratings from
// pupil-progress, streak record, last-5 logins) for a whole list of target
// accounts at once — three D1 queries total regardless of class size,
// rather than one round trip per pupil. This is the endpoint the class
// RAG breakdown, Independent Study analytics, and streak/activity screens
// all read from.
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

  const [progress, streaks, logins] = await Promise.all([
    kvGetMany(env, "pupil-progress", targets),
    kvGetMany(env, "streaks", targets),
    kvGetMany(env, "logins", targets),
  ]);

  const pupils = {};
  for (const acct of targets) {
    const state = progress[acct];
    const ratings = (state && state.ratings) || {};
    const record = streaks[acct] || defaultRecord();
    if (useToday) {
      // work on a copy — this must never persist a transition on the
      // teacher's behalf
      const copy = Object.assign({}, record);
      applyStreakTransition(copy, today);
      pupils[acct] = {
        ratings,
        streak: { current: copy.current, longest: copy.longest },
        logins: logins[acct] || [],
      };
    } else {
      pupils[acct] = {
        ratings,
        streak: { current: record.current, longest: record.longest },
        logins: logins[acct] || [],
      };
    }
  }

  return json({ pupils });
}
