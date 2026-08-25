// Independent Study "daily streak" tracking.
//
// GET  /api/streaks?account=<pupil>&today=YYYY-MM-DD
//        -> { streak:{current,longest}, todayCompleted, isSchoolDay, freezeNotice }
//        Read-only from the caller's point of view, but may itself apply a
//        freeze/reset transition (see below) and persist it — the pupil's
//        own app calls this on every Vocab-home render, which is exactly
//        when a missed day needs to be detected and (if this month's
//        freeze is still available) forgiven.
// POST /api/streaks?account=<pupil>   body: { today: "YYYY-MM-DD" }
//        -> { ok:true, streak:{current,longest}, freezeNotice }
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

export function defaultRecord() {
  return { current: 0, longest: 0, lastSchoolDay: null, freezeMonth: null, lastBonusDay: null };
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
export function applyStreakTransition(record, today) {
  let changed = false;
  let freezeNotice = null;

  if (record.lastSchoolDay && isWeekday(today)) {
    const missed = findMissedWeekdays(record.lastSchoolDay, today);
    if (missed.length === 1) {
      const thisMonth = monthOf(today);
      if (record.freezeMonth !== thisMonth) {
        record.freezeMonth = thisMonth;
        changed = true;
        const missedDate = missed[0];
        const label = missedDate === addDays(today, -1) ? "yesterday" : "on " + weekdayName(missedDate);
        freezeNotice = { missedLabel: label };
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
    const { changed, freezeNotice } = applyStreakTransition(record, today);
    if (changed) await kvSet(env, STORE, account, record);
    const schoolDay = isWeekday(today);
    const todayCompleted = schoolDay ? record.lastSchoolDay === today : record.lastBonusDay === today;
    return json({
      streak: { current: record.current, longest: record.longest },
      todayCompleted,
      isSchoolDay: schoolDay,
      freezeNotice,
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
    await kvSet(env, STORE, account, record);
    return json({ ok: true, streak: { current: record.current, longest: record.longest }, freezeNotice });
  }

  return json({ error: "method not allowed" }, 405);
}
