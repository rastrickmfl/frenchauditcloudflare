// GET  /api/independent-study?account=<any known account>   -> { tasks: [...] }
//        Returns the saved tasks, or [] if nothing's been saved yet.
// POST /api/independent-study?account=<a teacher account>    -> body is the
//        full tasks array; replaces what's saved. Teacher accounts only —
//        a pupil account gets a 403.
//
// Same shape as teacher-lists.js — Independent Study tasks are teacher-
// authored word sets (same {id,fr,en} word shape, own "is_" id prefix) with
// the same class/pupil targeting, plus a dueAt deadline. Kept as a sibling
// store/route rather than folded into teacher-lists so a task's deadline
// and its Learn/Test entry points stay a separate concept from an
// untimed shared vocab list.

import { ACCOUNT_SET, TEACHER_SET } from "./accounts.js";
import { kvGet, kvSet, json } from "./kv.js";

const STORE = "independent-study";
const DEFAULT_TASKS = [];

export async function handleIndependentStudy(request, env, url) {
  const account = url.searchParams.get("account");

  if (!account || !ACCOUNT_SET.has(account)) {
    return json({ error: "unknown account" }, 400);
  }

  if (request.method === "GET") {
    const data = await kvGet(env, STORE, "tasks");
    return json({ tasks: data || DEFAULT_TASKS });
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
      return json({ error: "expected an array of tasks" }, 400);
    }
    await kvSet(env, STORE, "tasks", body);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}
