// Independent Study "daily streak" tracking.
//
// GET  /api/streaks?account=<pupil>&today=YYYY-MM-DD
//        -> { streak:{current,longest}, todayCompleted, isSchoolDay, freezeNotice, medal }
//        Read-only from the caller's point of view, but may itself apply a
//        freeze/reset transition (see below) and persist it — the pupil's
//        own app calls this on every Vocab-home render, which is exactly
//        when a missed day needs to be detected and (if this month's
//        freeze is still available) forgiven.
// POST /api/streaks?account=<pupil>   body: { today: "YYYY-MM-DD" }
//        -> { ok:true, streak:{current,longest}, freezeNotice, medal }
//        Called once, when a pupil finishes all 20 cards of a daily streak
//        session. Applies the same missed-day transition first (so a
//        pupil who goes straight from "away for a few days" to completing
//        today still gets a correct fresh-start count), then marks today
//        complete.
//
// Rules (as agreed): a "day" is a UK school day (Mon-Fri only — no term
// calendar). One missed school day per calendar month is auto-forgiven
// (a "freeze"); a second miss in the same month resets the streak to
// zero. Weekends don't count for or against the streak, but a pupil can
// still do a "bonus" session on one — tracked separately (lastBonusDay)
// purely so the home-page banner knows to hide itself for the rest of
// that day.
//
// today is supplied by the client (its own local date) rather than
// derived from the Worker's clock, since a pupil's device timezone is the
// one that actually matters for "did they do it today".

import { ACCOUNT_SET } from "./accounts.js";
import { kvGet, kvSet, json } from "./kv.js";

const STORE = "streaks";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Streak-day milestones. Must be kept in step by hand with the `MEDALS`
// array in index.html (day counts only — names/emoji are display-only and
// live client-side). There's no shared-config file between the Worker and
// the static page, so a future medal added to one must be added to the
// other too (see the design doc's "still open" notes).
const MEDAL_THRESHOLDS = [5, 10, 15, 30, 45, 55, 65, 75, 85, 100, 125, 150];

export function defaultRecord() {
  return {
    current: 0,
    longest: 0,
    lastSchoolDay: null,
    freezeMonth: null,
    // Which specific missed weekday the current freezeMonth's freeze was
    // spent on. Lets a second call against the *same* today (GET renders
    // the banner, then POST completes the session moments later; or two
    // GETs in one day with no completion in between) recognise "I already
    // forgave this exact gap" instead of misreading it as a brand-new
    // second miss this month. See applyStreakTransition below.
    freezeUsedOnDate: null,
    lastBonusDay: null,
    // Highest milestone day-count ever reached (one-way ratchet — never
    // un-set by a later reset) and the date it was crossed (used only to
    // answer "was this earned *today*", not persisted as a lasting flag).
    highestMedalDays: 0,
    highestMedalAwardedOn: null,
  };
}

function dayOfWeek(dateStr) {
  // dateStr is YYYY-MM-DD; parse as UTC so there's no local-TZ drift in the arithmetic.
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
}
function isWeekday(dateStr) {
  const dow = dayOfWeek(dateStr);
  return dow >= 1 && dow <= 5;
}
function weekdayName(dateStr) {
  return WEEKDAY_NAMES[dayOfWeek(dateStr)];
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}
function findMissedWeekdays(fromDateStr, toDateStr) {
  const missed = [];
  let d = addDays(fromDateStr, 1);
  while (d < toDateStr) {
    if (isWeekday(d)) missed.push(d);
    d = addDays(d, 1);
  }
  return missed;
}

// Pure(-ish): given a streak record and today's date, works out whether a
// freeze needs consuming or a reset needs applying. Mutates and returns the
// same record object plus a { changed, freezeNotice } summary — caller
// decides whether/how to persist. Also exported for the teacher analytics
// endpoint, which wants an accurate *display* number without side effects
// (it should call this on a throwaway copy of the record, never on the one
// it read from storage).
//
// Safe to call more than once against the same `today` (e.g. the GET that
// renders the streak banner, followed by the POST that completes a session
// a minute later, or two page loads with nothing in between) — a missed
// weekday that's already been forgiven this call-cycle is recognised via
// freezeUsedOnDate and treated as a no-op rather than a fresh second miss.
export function applyStreakTransition(record, today) {
  let changed = false;
  let freezeNotice = null;

  if (record.lastSchoolDay && isWeekday(today)) {
    const missed = findMissedWeekdays(record.lastSchoolDay, today);
    if (missed.length === 1) {
      const missedDate = missed[0];
      const thisMonth = monthOf(today);
      if (record.freezeMonth !== thisMonth) {
        record.freezeMonth = thisMonth;
        record.freezeUsedOnDate = missedDate;
        changed = true;
        const label = missedDate === addDays(today, -1) ? "yesterday" : "on " + weekdayName(missedDate);
        freezeNotice = { missedLabel: label };
      } else if (record.freezeUsedOnDate === missedDate) {
        // Same gap already forgiven by an earlier call today — not a new
        // miss, leave current alone.
      } else if (record.current !== 0) {
        record.current = 0;
        changed = true;
      }
    } else if (missed.length >= 2 && record.current !== 0) {
      record.current = 0;
      changed = true;
    }
  }

  return { changed, freezeNotice };
}

// Pure: checks record.current against MEDAL_THRESHOLDS and advances the
// ratchet if a new milestone has been reached. Mutates and returns the
// same record plus a { changed } flag — mirrors applyStreakTransition's
// shape so callers can persist both in one write.
//
// A record with no highestMedalDays field yet (anyone whose streak
// predates this feature) is backfilled to whatever threshold their
// *current* streak already qualifies for, without marking it as earned
// today — so nobody gets a false "just earned" celebration for a
// milestone they actually crossed weeks ago.
export function applyMedalTransition(record, today) {
  let changed = false;
  const isLegacyRecord = record.highestMedalDays == null;

  let highest = isLegacyRecord ? 0 : record.highestMedalDays;
  for (const threshold of MEDAL_THRESHOLDS) {
    if (record.current >= threshold) highest = threshold;
  }

  if (isLegacyRecord) {
    record.highestMedalDays = highest;
    record.highestMedalAwardedOn = null; // backfilled, not "just earned"
    changed = true;
  } else if (highest > record.highestMedalDays) {
    record.highestMedalDays = highest;
    record.highestMedalAwardedOn = today;
    changed = true;
  }

  return { changed };
}

function medalPayload(record, today) {
  return {
    highestDays: record.highestMedalDays || null,
    awardedToday: record.highestMedalAwardedOn === today,
  };
}

export async function handleStreaks(request, env, url) {
  const account = url.searchParams.get("account");
  if (!account || !ACCOUNT_SET.has(account)) {
    return json({ error: "unknown account" }, 400);
  }

  if (request.method === "GET") {
    const today = url.searchParams.get("today");
    if (!today || !DATE_RE.test(today)) {
      return json({ error: "today (YYYY-MM-DD) query param required" }, 400);
    }
    const record = (await kvGet(env, STORE, account)) || defaultRecord();
    const { changed: streakChanged, freezeNotice } = applyStreakTransition(record, today);
    const { changed: medalChanged } = applyMedalTransition(record, today);
    if (streakChanged || medalChanged) await kvSet(env, STORE, account, record);
    const schoolDay = isWeekday(today);
    const todayCompleted = schoolDay ? record.lastSchoolDay === today : record.lastBonusDay === today;
    return json({
      streak: { current: record.current, longest: record.longest },
      todayCompleted,
      isSchoolDay: schoolDay,
      freezeNotice,
      medal: medalPayload(record, today),
    });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad json" }, 400);
    }
    const today = body && body.today;
    if (!today || !DATE_RE.test(today)) {
      return json({ error: "today (YYYY-MM-DD) required in body" }, 400);
    }
    const record = (await kvGet(env, STORE, account)) || defaultRecord();
    const { freezeNotice } = applyStreakTransition(record, today);
    if (isWeekday(today)) {
      if (record.lastSchoolDay !== today) {
        record.current += 1;
        record.longest = Math.max(record.longest, record.current);
        record.lastSchoolDay = today;
      }
    } else {
      record.lastBonusDay = today;
    }
    applyMedalTransition(record, today);
    await kvSet(env, STORE, account, record);
    return json({
      ok: true,
      streak: { current: record.current, longest: record.longest },
      freezeNotice,
      medal: medalPayload(record, today),
    });
  }

  return json({ error: "method not allowed" }, 405);
}
