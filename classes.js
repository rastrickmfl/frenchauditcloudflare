// GET  /api/classes?account=<any known account>   -> { classes: [...] }
//        Returns the saved roster, or [] if nothing's been saved yet
//        (equivalent to the old DEFAULT_CLASSES = [] fallback — no
//        school-specific roster ships in source, same reasoning as before).
// POST /api/classes?account=<a teacher account>    -> body is the full
//        classes array; replaces the saved roster. Teacher accounts only —
//        a pupil account gets a 403.
//
// Direct port of netlify/functions/classes.mjs onto D1.

import { ACCOUNT_SET, TEACHER_SET } from "./accounts.js";
import { kvGet, kvSet, json } from "./kv.js";

const STORE = "classes";
const DEFAULT_CLASSES = [];

export async function handleClasses(request, env, url) {
  const account = url.searchParams.get("account");

  if (!account || !ACCOUNT_SET.has(account)) {
    return json({ error: "unknown account" }, 400);
  }

  if (request.method === "GET") {
    const data = await kvGet(env, STORE, "roster");
    return json({ classes: data || DEFAULT_CLASSES });
  }

  if (request.method === "POST") {
    if (!TEACHER_SET.has(account)) {
      return json({ error: "teacher accounts only" }, 403);
    }
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad json" }, 400);
    }
    if (!Array.isArray(body)) {
      return json({ error: "expected an array of classes" }, 400);
    }
    await kvSet(env, STORE, "roster", body);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}
