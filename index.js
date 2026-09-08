// Cloudflare Worker entry point. Static assets (index.html,
// seed-demo-account.html) are served from this same directory via the
// ASSETS binding; this script only runs for /api/* (see wrangler.jsonc's
// run_worker_first), mirroring the three Netlify Functions the app used to
// call. Everything else in this directory that ISN'T meant to be public
// (this file, wrangler.jsonc, package.json, the .sql/.md files, etc.) is
// excluded from the asset manifest via .assetsignore.
//
// Login-abuse protection (added 8 Sep 2026) lives here, centrally, rather
// than duplicated inside each handler: every /api/* request is checked
// against the shared per-IP rate limiter *before* it reaches a handler,
// and every response is inspected *after* to decide whether it represents
// a credential failure worth counting. See rate-limit.js for the actual
// counting logic and why it only reacts to failures, never to ordinary
// successful use.

import { handleState } from "./state.js";
import { handleClasses } from "./classes.js";
import { handleTeacherLists } from "./teacher-lists.js";
import { handleIndependentStudy } from "./independent-study.js";
import { handleLogins } from "./logins.js";
import { handleStreaks } from "./streaks.js";
import { handlePupilAnalytics } from "./pupil-analytics.js";
import { handlePupilNames } from "./pupil-names.js";
import { handleTeacherLogin, handleTeacherPassword, handleTeacherLogout } from "./teacher-auth.js";
import { checkRateLimit, recordFailure } from "./rate-limit.js";
import { json } from "./kv.js";

// Reading a cloned response body to decide "was this a credential failure"
// is cheap (these are all small JSON bodies) and means none of the actual
// route handlers need to know rate limiting exists at all.
async function isCredentialFailure(pathname, response) {
  if (response.status === 401 && pathname === "/api/teacher-login") return true;
  if (response.status === 400) {
    try {
      const body = await response.clone().json();
      if (body && body.error === "unknown account") return true;
    } catch (e) {
      // not JSON / not the shape we're looking for — fall through
    }
  }
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const rl = await checkRateLimit(env, request);
      if (rl.blocked) {
        return json(
          { error: "too many attempts — try again in a few minutes", retryAfterSeconds: rl.retryAfterSeconds },
          429
        );
      }
    }

    let response;
    if (url.pathname === "/api/state") {
      response = await handleState(request, env, url);
    } else if (url.pathname === "/api/classes") {
      response = await handleClasses(request, env, url);
    } else if (url.pathname === "/api/teacher-lists") {
      response = await handleTeacherLists(request, env, url);
    } else if (url.pathname === "/api/independent-study") {
      response = await handleIndependentStudy(request, env, url);
    } else if (url.pathname === "/api/logins") {
      response = await handleLogins(request, env, url);
    } else if (url.pathname === "/api/streaks") {
      response = await handleStreaks(request, env, url);
    } else if (url.pathname === "/api/pupil-analytics") {
      response = await handlePupilAnalytics(request, env, url);
    } else if (url.pathname === "/api/pupil-names") {
      response = await handlePupilNames(request, env, url);
    } else if (url.pathname === "/api/teacher-login") {
      response = await handleTeacherLogin(request, env);
    } else if (url.pathname === "/api/teacher-password") {
      response = await handleTeacherPassword(request, env);
    } else if (url.pathname === "/api/teacher-logout") {
      response = await handleTeacherLogout(request, env);
    } else if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    } else {
      return json({ error: "not found" }, 404);
    }

    if (url.pathname.startsWith("/api/") && (await isCredentialFailure(url.pathname, response))) {
      await recordFailure(env, request);
    }

    return response;
  },
};
