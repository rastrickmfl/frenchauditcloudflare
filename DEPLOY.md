# Deploying to Cloudflare

This replaces the old Netlify setup. It's a **Cloudflare Worker with static
assets**, not Cloudflare Pages — Cloudflare's current guidance is to build
new projects on Workers (Pages Functions still work, but Workers is the
actively-developed path and what their own migration tooling steers you
towards). Practically this means one `wrangler.jsonc`, one `index.js` entry
point, and `wrangler deploy` instead of `wrangler pages deploy`.

**Everything is flat in one directory (repo root), on purpose** — see the
note at the top of `README.md`.

## Fixing the repo, if you already pushed the earlier version

The first upload (via GitHub's web "Add file → Upload files") flattened
subfolders that the original zip had (`public/`, `src/`, `src/routes/`,
`schema/`) — so `index.js`'s `import "./routes/state.js"` and similar
paths, plus `wrangler.jsonc`'s `"./src/index.js"` / `"./public"` /
`"./schema"` paths, all pointed at folders that no longer existed. It also
turned `.gitignore` into a file literally named `download` (dotfiles and
GitHub's upload dialog don't always get on).

This zip's contents fix that by removing the folders entirely — every file
referenced above now lives at the same level, and `wrangler.jsonc` points
at `.` instead of `./public`/`./src`. To apply the fix:

1. On GitHub, delete every file currently in the repo (including the
   `download` file — that's the old `.gitignore`, no longer needed since
   this version includes a correctly-named one, though a leading dot may
   again get dropped on upload — check what lands and rename it back to
   `.gitignore` if so, or just skip it; it's not required for the site to
   work).
2. Drag in every file from **inside** this zip (not the zip itself) —
   `index.html`, `index.js`, `state.js`, `classes.js`, `teacher-lists.js`,
   `accounts.js`, `kv.js`, `accounts.json`, `0001_init.sql`,
   `wrangler.jsonc`, `.assetsignore`, `.gitignore`, `package.json`,
   `README.md`, `DEPLOY.md`, `seed-demo-account.html`. All flat, no
   folders to create this time.
3. Commit directly to your default branch (or a branch + PR, your call).

If you'd rather do it from a terminal with `git` instead of the GitHub web
UI, that avoids this whole class of problem going forward — happy to talk
through that if useful.

## What's already done (via the Cloudflare Developer Platform connector)

- A **D1 database** `frenchvocab-db` (id `1bf5077b-7e81-4b0e-bbbf-ea8ec617521a`)
  exists on your Cloudflare account, already wired up in `wrangler.jsonc`.
- Its schema (`0001_init.sql` — a single `kv_store` table that emulates the
  old Netlify Blobs `get`/`setJSON` calls) has already been applied to that
  **live** database.
- All three API routes (`state`, `classes`, `teacher-lists`) have been
  rewritten onto D1 and smoke-tested locally with `wrangler dev` in this
  exact flat layout — see "What was tested" below.

## What you still need to do

### 1. Get this flat layout into the GitHub repo

See "Fixing the repo" above if you already pushed the broken version;
otherwise just push/upload these files as-is.

### 2. Connect the repo to a Cloudflare Worker (Workers Builds)

This is the equivalent of Netlify's "auto-deploy on push" — but without the
300-credits/month ceiling that started this whole migration.

1. Cloudflare dashboard → **Workers & Pages** → **Create application** →
   **Import a repository**.
2. Pick the GitHub repo.
3. Build command: none needed (no framework build step). Deploy command:
   `npx wrangler deploy`.
4. **Important:** the Worker name Cloudflare creates must match `"name"` in
   `wrangler.jsonc` (`gcse-french-vocab-audit`), or the build fails.
5. Save and deploy. Every future push to your main branch redeploys
   automatically; other branches get preview deployments.

### 3. Verify on the `*.workers.dev` URL

Re-run the checks below (or open the site and click through as a pupil and
as a teacher account) against the real deployed URL, not just local dev.

### 4. Point your real domain at it (if you have one), once you're happy

Workers & Pages → your Worker → **Settings** → **Domains & Routes** → add
your custom domain. Leave the old Netlify site live but frozen for a week
or two as a fallback, same as the original plan.

### 5. Set up a backup habit

`npx wrangler d1 export frenchvocab-db --remote --output=backup.sql`
(wired up as `npm run db:export`) dumps the whole database — pupil
progress, class rosters, teacher lists — to a single SQL file. Worth doing
weekly, or before any big change.

## Local development

```bash
npm install
npm run db:schema:apply:local   # first time only — sets up local D1
npm run dev                     # wrangler dev, on http://localhost:8787
```

Both scripts point `--persist-to` at `../.frenchvocab-wrangler-state` (one
level above this folder) rather than the default `.wrangler/state` —
because the assets directory is `.` (this whole folder), letting Wrangler's
local D1 files live inside it too makes `wrangler dev` reload in a loop
every time it writes to the database. Keeping local state just outside the
project folder avoids that.

## What was tested (local `wrangler dev`, in this exact flat layout)

- `GET /api/state?account=<unknown>` → 400 `{"error":"unknown account"}`
- `POST /api/state?account=otter-72` with a JSON body → 200 `{"ok":true}`,
  and a follow-up `GET` returns exactly that body back
- `POST /api/classes` as a pupil account → 403 `{"error":"teacher accounts only"}`
- `POST /api/classes` / `POST /api/teacher-lists` as a teacher account → 200
- `GET /` → serves `index.html` (200)
- `GET /seed-demo-account.html` → 200
- Non-asset files correctly return 404, confirming `.assetsignore` is
  working: `/wrangler.jsonc`, `/index.js`, `/accounts.json`,
  `/package.json`, `/.assetsignore`, `/0001_init.sql`

No behavioural differences found from the original Netlify Functions.

## If Netlify Blobs already has real pupil data worth migrating

The phased plan's Step 5 still applies: pull the current `pupil-progress`,
`classes`, and `teacher-lists` stores via the Netlify Blobs API/CLI, then
load each key into `kv_store` with `wrangler d1 execute` (or a short script
using the D1 connector). Only worth doing if the live Netlify deployment
has been used by real pupils already — ask before assuming.
