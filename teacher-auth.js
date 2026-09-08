// Real password authentication for teacher accounts — on top of, not
// instead of, the existing account-code system pupils use unchanged.
//
// Why this exists: every account (pupil or teacher) used to be "protected"
// by nothing but knowing its code, and pupil/teacher codes were both
// listed in full, in plain text, inside the page's own HTML — so a
// teacher code was never actually secret. Teacher accounts can overwrite
// shared class content and read any pupil's analytics, so they're the one
// place that needed a real credential. Pupil accounts deliberately stay
// code-only — see the project's security-hardening notes for the reasoning.
//
// GET  /api/teacher-login is not a thing — POST only, see handleTeacherLogin.
// POST /api/teacher-login   body: {username, password}
//        -> { ok:true, token, account } on success
//        -> { error: "invalid username or password" }, 401 on failure
//           (deliberately the same message whether the username or the
//           password was wrong, so a caller can't use this to enumerate
//           which usernames are valid)
// POST /api/teacher-password   requires X-Teacher-Token header
//        body: {oldPassword, newPassword}
//        -> { ok:true } on success
// POST /api/teacher-logout   requires X-Teacher-Token header
//        -> { ok:true } always (a token that's already invalid/expired is
//           treated as "already logged out", not an error)
//
// Session tokens are a random opaque string, stored server-side with an
// expiry (SESSION_TTL_MS below) — the browser just holds the token and
// sends it back on every teacher-gated call via X-Teacher-Token. Nothing
// about a pupil's own flow changes at all.

// Rate limiting for these routes is handled centrally by index.js (it
// gates every /api/* request the same way, then inspects each response to
// decide whether to count it as a credential failure) — this file stays
// focused on the credential logic itself and doesn't need to know about
// rate limiting at all.

import { ACCOUNT_SET, TEACHER_SET } from "./accounts.js";
import { kvGet, kvSet, kvDelete, json } from "./kv.js";

const AUTH_STORE = "teacher-auth";
const SESSION_STORE = "teacher-sessions";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — log in again the next school day
const MIN_PASSWORD_LEN = 8;

// ---- password hashing --------------------------------------------------
// Salted SHA-256, not a slow KDF (PBKDF2/bcrypt/scrypt) — a deliberate
// choice for this environment, not an oversight. Cloudflare Workers cap
// CPU time per request tightly (low milliseconds on the plan this project
// runs on); a proper slow hash risks the request itself failing on CPU
// limits before it ever gets to check the password. The threat this
// actually needs to resist is *online* guessing (someone hammering
// /api/teacher-login), which is what the rate limiter above is for — a
// stolen hash is only a risk if the database itself is compromised, and
// at that point the hashing algorithm is a secondary concern regardless.

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const hash = await sha256Hex(concatBytes(salt, new TextEncoder().encode(password)));
  return { hash, salt: toHex(salt) };
}
// Constant-time-ish comparison so a failed check doesn't leak how many
// leading hex characters matched via response timing. Not perfect (JS
// engines can still short-circuit in ways outside our control), but cheap
// and strictly better than `===`.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verifyPassword(password, record) {
  if (!record || !record.hash || !record.salt) return false;
  const { hash } = await hashPassword(password, record.salt);
  return safeEqual(hash, record.hash);
}

// ---- sessions -----------------------------------------------------------
function newToken() {
  // 32 random bytes, hex-encoded — 256 bits, plenty for a session token
  // nobody needs to type or remember.
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

// Used by every teacher-gated route (classes/teacher-lists/independent-
// study POST, pupil-analytics, pupil-names, and the teacher-as-viewer
// branch of logins) in place of the old bare `TEACHER_SET.has(account)`
// check. Confirms account really is a teacher account AND the caller
// presented a still-valid session token that was actually issued for that
// specific account — so a stolen/guessed *account name* alone is no
// longer enough, the token from a real login is required too.
export async function verifyTeacherSession(request, env, account) {
  if (!account || !TEACHER_SET.has(account)) return false;
  const token = request.headers.get("x-teacher-token");
  if (!token) return false;
  const session = await kvGet(env, SESSION_STORE, token);
  if (!session) return false;
  if (session.account !== account) return false;
  if (!session.expiresAt || Date.now() > session.expiresAt) return false;
  return true;
}

// ---- routes ---------------------------------------------------------------
// Note: this deliberately does NOT check/record rate limiting itself —
// index.js gates every /api/* call before this runs, and inspects the
// response afterwards (401 here = a credential failure to count) to
// decide whether to record one. That keeps every route's rate-limit
// behaviour in one place instead of duplicated per-handler.
export async function handleTeacherLogin(request, env) {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad json" }, 400);
  }
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  // Same generic message for every failure reason (missing field, unknown
  // username, wrong password) — deliberately not distinguishing which
  // part was wrong, so this can't be used to enumerate valid usernames.
  const invalid = () => json({ error: "invalid username or password" }, 401);

  if (!username || !password) return invalid();
  if (!ACCOUNT_SET.has(username) || !TEACHER_SET.has(username)) return invalid();

  const record = await kvGet(env, AUTH_STORE, username);
  const ok = await verifyPassword(password, record);
  if (!ok) return invalid();

  const token = newToken();
  await kvSet(env, SESSION_STORE, token, { account: username, expiresAt: Date.now() + SESSION_TTL_MS });
  return json({ ok: true, token, account: username });
}

export async function handleTeacherPassword(request, env) {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }
  const token = request.headers.get("x-teacher-token");
  if (!token) return json({ error: "not logged in" }, 401);
  const session = await kvGet(env, SESSION_STORE, token);
  if (!session || !session.expiresAt || Date.now() > session.expiresAt) {
    return json({ error: "session expired — log in again" }, 401);
  }
  const account = session.account;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad json" }, 400);
  }
  const oldPassword = typeof body.oldPassword === "string" ? body.oldPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  const record = await kvGet(env, AUTH_STORE, account);
  const ok = await verifyPassword(oldPassword, record);
  if (!ok) {
    return json({ error: "current password is incorrect" }, 401);
  }
  if (newPassword.length < MIN_PASSWORD_LEN) {
    return json({ error: `new password must be at least ${MIN_PASSWORD_LEN} characters` }, 400);
  }

  const newRecord = await hashPassword(newPassword, null);
  await kvSet(env, AUTH_STORE, account, newRecord);
  return json({ ok: true });
}

export async function handleTeacherLogout(request, env) {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }
  const token = request.headers.get("x-teacher-token");
  if (token) {
    await kvDelete(env, SESSION_STORE, token);
  }
  return json({ ok: true });
}
