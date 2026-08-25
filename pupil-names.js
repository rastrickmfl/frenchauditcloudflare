// GET  /api/pupil-names?account=<teacher>&targets=acc1,acc2,...
//        -> { names: { acc1: "John S"|null, ... } }
// POST /api/pupil-names?account=<teacher>   body: { target: "apple-45", name: "John S" }
//        -> { ok: true, name: "John S"|null }   (empty/whitespace-only name clears it)
//
// Teacher-only both ways. A pupil never has any reason to read or write
// this store, so unlike /api/state there's no pupil-facing path at all.
//
// Deliberately minimal: this stores one short display label per account —
// e.g. "John S" (first name + surname initial), the format the school
// asked for specifically to avoid holding a full surname here. It's opt-in
// (a class works fine with no names ever entered) and only ever shown to
// teacher accounts, never to pupils. Whether that's sufficient for a given
// school's own data-protection policy is for the school to confirm — this
// endpoint just enforces a length cap and does no other validation.

import { ACCOUNT_SET, TEACHER_SET } from "./accounts.js";
import { kvGetMany, kvSet, json } from "./kv.js";

const STORE = "pupil-names";
const MAX_LEN = 40;

export async function handlePupilNames(request, env, url) {
  const account = url.searchParams.get("account");
  if (!account || !ACCOUNT_SET.has(account)) {
    return json({ error: "unknown account" }, 400);
  }
  if (!TEACHER_SET.has(account)) {
    return json({ error: "teacher accounts only" }, 403);
  }

  if (request.method === "GET") {
    const targetsParam = url.searchParams.get("targets") || "";
    const targets = targetsParam
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t && ACCOUNT_SET.has(t));
    if (targets.length === 0) {
      return json({ names: {} });
    }
    const rows = await kvGetMany(env, STORE, targets);
    const names = {};
    targets.forEach((t) => {
      names[t] = rows[t] || null;
    });
    return json({ names });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad json" }, 400);
    }
    const target = body && body.target;
    if (!target || !ACCOUNT_SET.has(target)) {
      return json({ error: "unknown target account" }, 400);
    }
    if (TEACHER_SET.has(target)) {
      return json({ error: "cannot set a name on a teacher account" }, 400);
    }
    const name = (body.name == null ? "" : String(body.name)).trim().slice(0, MAX_LEN);
    // An empty string clears the name — stored as null so a later GET
    // reports "no name set" rather than an empty label.
    await kvSet(env, STORE, target, name || null);
    return json({ ok: true, name: name || null });
  }

  return json({ error: "method not allowed" }, 405);
}
