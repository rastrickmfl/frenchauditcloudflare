// Cloudflare Worker entry point. Static assets (index.html,
// seed-demo-account.html) are served from this same directory via the
// ASSETS binding; this script only runs for /api/* (see wrangler.jsonc's
// run_worker_first), mirroring the three Netlify Functions the app used to
// call. Everything else in this directory that ISN'T meant to be public
// (this file, wrangler.jsonc, package.json, the .sql/.md files, etc.) is
// excluded from the asset manifest via .assetsignore.

import { handleState } from "./state.js";
import { handleClasses } from "./classes.js";
import { handleTeacherLists } from "./teacher-lists.js";
import { json } from "./kv.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/state") {
      return handleState(request, env, url);
    }
    if (url.pathname === "/api/classes") {
      return handleClasses(request, env, url);
    }
    if (url.pathname === "/api/teacher-lists") {
      return handleTeacherLists(request, env, url);
    }

    // Any other path that reached the Worker (run_worker_first is scoped to
    // /api/*, so in practice this shouldn't happen) — fall back to assets.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return json({ error: "not found" }, 404);
  },
};
