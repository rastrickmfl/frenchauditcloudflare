// GET  /api/logins?account=<any known account>                 -> { logins: [iso, iso, ...] }
//        Returns the calling account's own last-5 login timestamps, most
//        recent first.
// GET  /api/logins?account=<teacher>&target=<any known account>  -> { logins: [...] }
//        Teacher accounts only — lets a teacher look up a specific pupil's
//        last-5 logins (used by the class streak/activity screen).
// POST /api/logins?account=<any known account>                  -> { ok: true }
//        Appends "now" to that account's own login log, keeping the 5 most
//        recent. Called once per login from the client.
//
// Deliberately just a capped timestamp array, not a full audit log — "last
// 5 logins" was the ask, and a capped array is the simplest thing that
// answers it without unbounded growth per account.

import { ACCOUNT_SET, TEACHER_SET } from "./accounts.js";
import { kvGet, kvSet, json } from "./kv.js";

const STORE = "logins";
const MAX_LOGINS = 5;

export async function handleLogins(request, env, url) {
  const account = url.searchParams.get("account");
  if (!account || !ACCOUNT_SET.has(account)) {
    return json({ error: "unknown account" }, 400);
  }

  if (request.method === "GET") {
    const target = url.searchParams.get("target");
    let who = account;
    if (target && target !== account) {
      if (!TEACHER_SET.has(account)) {
        return json({ error: "teacher accounts only" }, 403);
      }
      if (!ACCOUNT_SET.has(target)) {
        return json({ error: "unknown target" }, 400);
      }
      who = target;
    }
    const data = await kvGet(env, STORE, who);
    return json({ logins: data || [] });
  }

  if (request.method === "POST") {
    const existing = (await kvGet(env, STORE, account)) || [];
    const updated = [new Date().toISOString(), ...existing].slice(0, MAX_LOGINS);
    await kvSet(env, STORE, account, updated);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}
