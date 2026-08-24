// GET  /api/state?account=otter-14   -> { state: <saved JSON or null> }
// POST /api/state?account=otter-14   -> body is the state object itself; saves it
//
// Direct port of netlify/functions/state.mjs onto D1 — same validation,
// same response shapes, same status codes, so index.html needed zero changes.

import { ACCOUNT_SET } from "./accounts.js";
import { kvGet, kvSet, json } from "./kv.js";

const STORE = "pupil-progress";

export async function handleState(request, env, url) {
  const account = url.searchParams.get("account");

  if (!account || !ACCOUNT_SET.has(account)) {
    return json({ error: "unknown account" }, 400);
  }

  if (request.method === "GET") {
    const data = await kvGet(env, STORE, account);
    return json({ state: data || null });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad json" }, 400);
    }
    await kvSet(env, STORE, account, body);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}
