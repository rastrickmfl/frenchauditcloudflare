# frenchvocab (Cloudflare edition)

GCSE French vocab pupil web app — pupil accounts backed by Cloudflare D1.

Runs as a single Cloudflare Worker with static assets. **Everything lives
flat in this one directory** (repo root) rather than in subfolders —
GitHub's "Upload files" web UI doesn't reliably preserve folder structure
when you drag in loose files (that's what happened the first time this was
pushed), so the project is laid out to not depend on it.

- `index.html` — the app itself (unchanged from the Netlify version)
- `seed-demo-account.html` — internal demo-seeding tool (unchanged)
- `index.js` — Worker entry point; routes `/api/*` to `state.js`,
  `classes.js`, `teacher-lists.js`, everything else falls through to the
  static assets
- `state.js`, `classes.js`, `teacher-lists.js` — one-to-one ports of the old
  `netlify/functions/*.mjs`, now reading/writing D1 instead of Netlify Blobs
- `accounts.js` — the pupil/teacher account allowlists (previously
  duplicated in each Netlify Function; now one shared module)
- `kv.js` — a small key-value wrapper over D1's `kv_store` table, so the
  route handlers still read like `get`/`setJSON` calls
- `0001_init.sql` — the D1 schema (one `kv_store(store, key, value,
  updated_at)` table) — already applied to the live database; kept here as
  a reference / for re-applying to a fresh database if ever needed
- `accounts.json` — reference copy of the pupil account list (not read by
  the app at runtime — same as in the original repo)
- `.assetsignore` — tells Cloudflare which of the files above are *not*
  public static assets (the `.js`/`.json`/`.sql`/`.md`/config files) — only
  `index.html` and `seed-demo-account.html` are actually served to visitors
- `design-lint.mjs` — a design-consistency check for `index.html` (font
  sizes/weights/families, spacing conventions). Run `npm run design:lint`
  before delivering any round that touches CSS or adds a new screen/card/
  button — see the file's own header comment and the Cowork project's
  status doc ("Design-system enforcement" section) for what it checks and
  why each rule exists.

See `DEPLOY.md` for how to get this live on Cloudflare, and for how to fix
a repo that already has the earlier flattened/broken version pushed to it.
