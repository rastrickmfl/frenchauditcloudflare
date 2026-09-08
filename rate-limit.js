// Shared login-abuse throttle, used for both the pupil "unknown account"
// signal (checked centrally in index.js after each handler responds) and
// the teacher-login endpoint's "wrong username or password" signal.
//
// Deliberately counts FAILURES, not requests: a pupil typing their own
// correct code, all day, from a shared school WiFi IP with dozens of other
// pupils on it, never touches this at all. Only repeated wrong guesses
// from the same source (an automated script trying many codes/passwords,
// or a genuine but unusually persistent typo streak) do. That's the
// distinction that keeps a whole class from ever being collectively
// locked out by each other's occasional mistakes.
//
// Storage: same kv_store table as everything else (store="rate-limit",
// key=<client IP>), so no new binding needed. One D1 read + (on a
// failure) one D1 write per request — negligible next to the existing
// free-tier budget, since it only writes when something actually failed.

import { kvGet, kvSet } from "./kv.js";

const STORE = "rate-limit";
const WINDOW_MS = 10 * 60 * 1000; // count failures within a rolling 10 minutes
const MAX_FAILURES = 10; // ...and block once this many land inside that window
const LOCKOUT_MS = 15 * 60 * 1000; // ...for 15 minutes

function clientIp(request) {
  // Cloudflare sets this on every request reaching a Worker; falls back to
  // a shared bucket if it's ever missing (e.g. local `wrangler dev`) rather
  // than throwing.
  return request.headers.get("cf-connecting-ip") || "unknown";
}

function emptyRecord() {
  return { failures: [], lockedUntil: null };
}

// Call before doing any credential check. Returns {blocked:false} to
// proceed as normal, or {blocked:true, retryAfterSeconds} to short-circuit
// with a 429 before even looking at what was submitted.
export async function checkRateLimit(env, request) {
  const ip = clientIp(request);
  const record = (await kvGet(env, STORE, ip)) || emptyRecord();
  const now = Date.now();
  if (record.lockedUntil && now < record.lockedUntil) {
    return { blocked: true, retryAfterSeconds: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  return { blocked: false };
}

// Call once it's confirmed the request failed for a credential reason
// (unknown pupil/teacher account code, or a wrong teacher password).
export async function recordFailure(env, request) {
  const ip = clientIp(request);
  const record = (await kvGet(env, STORE, ip)) || emptyRecord();
  const now = Date.now();
  record.failures = (record.failures || []).filter((t) => now - t < WINDOW_MS);
  record.failures.push(now);
  if (record.failures.length >= MAX_FAILURES) {
    record.lockedUntil = now + LOCKOUT_MS;
    record.failures = [];
  } else {
    record.lockedUntil = null;
  }
  await kvSet(env, STORE, ip, record);
}

// Call once a login actually succeeds, so a pupil/teacher who fat-fingered
// it once earlier isn't left carrying a stray count toward a threshold
// they're nowhere near hitting anyway. Not essential to the protection
// (the window already self-clears), just tidier.
export async function recordSuccess(env, request) {
  const ip = clientIp(request);
  await kvSet(env, STORE, ip, emptyRecord());
}
