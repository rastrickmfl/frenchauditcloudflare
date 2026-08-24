// GET  /api/teacher-lists?account=<any known account>   -> { lists: [...] }
//        Returns the saved lists, or [] if nothing's been saved yet.
// POST /api/teacher-lists?account=<a teacher account>    -> body is the
//        full lists array; replaces what's saved. Teacher accounts only —
//        a pupil account gets a 403.
//
// Direct port of netlify/functions/teacher-lists.mjs onto D1.

import { ACCOUNT_SET, TEACHER_SET } from "./accounts.js";
import { kvGet, kvSet, json } from "./kv.js";

const STORE = "teacher-lists";
const DEFAULT_LISTS = [];

export async function handleTeacherLists(request, env, url) {
  const account = url.searchParams.get("account");

  if (!account || !ACCOUNT_SET.has(account)) {
    return json({ error: "unknown account" }, 400);
  }

  if (request.method === "GET") {
    const data = await kvGet(env, STORE, "lists");
    return json({ lists: data || DEFAULT_LISTS });
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
      return json({ error: "expected an array of lists" }, 400);
    }
    await kvSet(env, STORE, "lists", body);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}
