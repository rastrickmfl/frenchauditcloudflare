// design-lint.mjs — catches drift from the type-scale, spacing, and
// font-family rules established during the 24–25 Aug 2026 design-audit
// rounds (see claude/cloudflare-migration-status.md in the Cowork project
// for the full history of each rule this checks).
//
// Run before delivering ANY round that touches index.html's CSS or adds
// new screens/cards/buttons:
//
//   node design-lint.mjs
//
// Exits 0 if clean, 1 if any ERROR-level finding exists (WARNINGs don't
// fail the run, but read them anyway — they're usually real drift that
// just happens to coincide with an approved pixel value).
//
// Two passes:
//   1. STATIC — regex over the raw <style> block. Fast, no browser. Catches
//      undefined CSS variable references, out-of-scale literal font sizes/
//      weights, and missing global rules (button font-family, etc).
//   2. RENDERED — boots the real app in headless Chromium (mocked APIs,
//      driven by actual UI clicks — this app is one big IIFE, so there's
//      no exported JS to call directly) and walks a curated list of
//      screens, checking computed styles against the same rules, plus the
//      .btn-row-before-.card spacing rule that only exists once the app
//      actually renders (it's built via JS string templates, not static
//      HTML, so pass 1 can't see it).
//
// New screen? Add it to SCREENS below. New deliberately-oversized/glyph
// element? Add its selector to SKIP_SELECTORS with a one-line reason —
// don't just silence a finding without saying why, the whole point of
// this file is that every exception is written down somewhere.

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, 'index.html');

// The Claude Cowork sandbox this was built in ships Chromium at this fixed
// path (and blocks `playwright install` from re-fetching one). Anywhere
// else — Jacob's own machine, a CI runner — this path won't exist, so fall
// back to whatever Playwright finds on its own (run `npx playwright
// install chromium` once first in that case).
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = {
  proxy: { server: 'direct://' }, // this sandbox routes all traffic through
  args: ['--no-proxy-server'],    // an HTTP(S) proxy that can't reach file:// fetches
};
if (existsSync(SANDBOX_CHROMIUM)) LAUNCH_OPTS.executablePath = SANDBOX_CHROMIUM;

const ALLOWED_FONT_SIZES_PX = [11, 12, 13, 15, 18, 20, 22, 24, 28];
const ALLOWED_FONT_WEIGHTS = [400, 600, 700, 800];
const ALLOWED_WROW_MARGIN_BOTTOM_PX = [4, 6];

// Elements whose size/weight is deliberately outside the 3-level Title/
// Text/Subtext scale — icon glyphs, the flashcard display, tab labels,
// etc. — see the "Type-scale audit" section of the project status doc for
// why each of these is excluded. Matched with element.matches(selector);
// keep this list honest — add a reason comment for every entry.
const SKIP_SELECTORS = [
  '.dc-front',              // flashcard word itself — deliberately large
  '.dc-back',                // flashcard answer — same reasoning
  '.dc-nav-row button',      // circular advance-button glyph
  '.dc-breakdown div',       // session-result stat count, not body text
  '.dc-breakdown div span',  // its "Red/Amber/Green" sub-label — eyebrow-style but sits inside the stat block
  'nav.tabbar button',       // 6 fixed-width tabs, no room to grow
  'nav.tabbar button .ic',   // tab icon glyph
  '.tile .chev',             // chevron glyph
  '.spk',                    // speaker icon-button glyph
  '.del',                    // delete "×" glyph
  '.info-btn',               // "i" icon glyph (styled as a serif italic letter)
  '.info-modal-close',       // "×" icon glyph
  '#printArea',              // physical print stylesheet — different medium entirely
  '#printArea *',
];

function readSource() {
  return readFileSync(INDEX_HTML, 'utf8');
}

// ---------- Pass 1: static source checks ----------
function runStaticChecks(src) {
  const findings = [];

  // Strip @media print{...} block(s) before scanning literal sizes/weights
  // — that's a different medium with its own point sizes, out of scope
  // (matches the "Type-scale audit" section's explicit carve-out).
  const printBlockRe = /@media\s+print\s*\{/g;
  let scanSrc = src;
  let m;
  while ((m = printBlockRe.exec(src))) {
    // naive brace-matching from the block start to find its end
    let depth = 1, i = m.index + m[0].length;
    while (depth > 0 && i < src.length) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    scanSrc = scanSrc.slice(0, m.index) + ' '.repeat(i - m.index) + scanSrc.slice(i);
  }

  // Only look inside the main <style>...</style> block (avoid matching
  // stray "font-size"-looking text inside JS string literals for CSS
  // custom-property NAME extraction, though the literal-value scan below
  // deliberately also covers inline style="" attributes in the JS, since
  // those are real rendered CSS too).
  const styleMatch = scanSrc.match(/<style>([\s\S]*?)<\/style>/);
  const styleBlock = styleMatch ? styleMatch[1] : '';

  // 1. Every var(--fs-*) / var(--fw-*) reference must resolve to a token
  //    actually defined in :root. This is the check that would have
  //    caught the `.streak-title{font-size:var(--fs-subtitle, 16px);}`
  //    bug found and fixed on 25 Aug 2026 — an undefined custom property
  //    silently falls back to whatever default the call site wrote,
  //    which is exactly how a stray 16px snuck past the 18/15/13/12 scale.
  // Brace-matched (not a naive non-greedy regex) — the :root comment block
  // itself contains literal "{"/"}" characters when it references other
  // CSS rules in prose (e.g. "see body{...}"), which would otherwise
  // truncate the match at the first stray "}" and silently hide every
  // token defined after it.
  let rootBlock = '';
  const rootStart = scanSrc.search(/:root\s*\{/);
  if (rootStart !== -1) {
    const openIdx = scanSrc.indexOf('{', rootStart);
    let depth = 1, i = openIdx + 1;
    while (depth > 0 && i < scanSrc.length) {
      if (scanSrc[i] === '{') depth++;
      else if (scanSrc[i] === '}') depth--;
      i++;
    }
    rootBlock = scanSrc.slice(openIdx + 1, i - 1);
  }
  const definedTokens = new Set(
    [...rootBlock.matchAll(/(--fs-[a-z-]+|--fw-[a-z-]+)\s*:/g)].map((x) => x[1])
  );
  const usedTokens = new Set(
    [...scanSrc.matchAll(/var\(\s*(--fs-[a-z-]+|--fw-[a-z-]+)\s*(?:,[^)]*)?\)/g)].map((x) => x[1])
  );
  for (const tok of usedTokens) {
    if (!definedTokens.has(tok)) {
      findings.push({
        level: 'ERROR',
        rule: 'undefined-token',
        detail: `var(${tok}) is used but never defined in :root — it's silently falling back to whatever default (if any) the call site wrote, which won't be one of the approved scale values.`,
      });
    }
  }

  // 2. Bare numeric font-size literals outside the approved set.
  for (const mm of styleBlock.matchAll(/font-size\s*:\s*([0-9]+(?:\.[0-9]+)?)px/g)) {
    const px = parseFloat(mm[1]);
    if (!ALLOWED_FONT_SIZES_PX.includes(px)) {
      findings.push({
        level: 'ERROR',
        rule: 'font-size-scale',
        detail: `font-size:${mm[1]}px in the stylesheet isn't one of the approved values (${ALLOWED_FONT_SIZES_PX.join(', ')}px — tokens plus the documented glyph/display exceptions). If this is a genuinely new deliberate exception, add it to SKIP_SELECTORS in design-lint.mjs with a reason; otherwise it should reference var(--fs-title/text/subtext/eyebrow).`,
      });
    }
  }

  // 3. Bare numeric font-weight literals outside the approved set.
  for (const mm of styleBlock.matchAll(/font-weight\s*:\s*([0-9]+)/g)) {
    const w = parseInt(mm[1], 10);
    if (!ALLOWED_FONT_WEIGHTS.includes(w)) {
      findings.push({
        level: 'ERROR',
        rule: 'font-weight-scale',
        detail: `font-weight:${w} in the stylesheet isn't one of the four weights used anywhere else in the app (${ALLOWED_FONT_WEIGHTS.join(', ')}).`,
      });
    }
  }

  // 4. Global button font-family fix must still be present (25 Aug 2026 —
  //    without this, every <button> silently falls back to the OS UI font
  //    instead of Inter, which is what read as "shorter and bolder").
  if (!/\bbutton\s*\{\s*font-family\s*:\s*inherit\s*;?\s*\}/.test(styleBlock)) {
    findings.push({
      level: 'ERROR',
      rule: 'button-font-family',
      detail: `Couldn't find "button{font-family:inherit;}" (or it's been reformatted enough that this regex no longer matches — check by eye). Buttons will silently fall back to the OS UI font instead of Inter if this is missing.`,
    });
  }

  // 5. Same fix for text inputs/textareas.
  if (!/textarea\s*,\s*input\[type=text\]\s*\{[^}]*font-family\s*:\s*inherit/.test(styleBlock)) {
    findings.push({
      level: 'ERROR',
      rule: 'input-font-family',
      detail: `Couldn't find the textarea/input[type=text] font-family:inherit rule (or it's been reformatted — check by eye).`,
    });
  }

  // 6. .wrow inline margin-bottom convention (informational — context
  //    matters for which of the two established values applies, so this
  //    is a WARNING not an ERROR).
  for (const mm of scanSrc.matchAll(/class="wrow"\s+style="[^"]*margin-bottom\s*:\s*([0-9]+)px/g)) {
    const px = parseInt(mm[1], 10);
    if (!ALLOWED_WROW_MARGIN_BOTTOM_PX.includes(px)) {
      findings.push({
        level: 'WARNING',
        rule: 'wrow-margin-convention',
        detail: `A ".wrow" row uses margin-bottom:${px}px — the established convention is 6px for plain list rows or 4px for a two-line label+progress-bar row (see the "Spacing audit" section of the status doc). If this is intentional, that's fine, but it's worth a second look.`,
      });
    }
  }

  return findings;
}

// ---------- Pass 2: rendered DOM checks ----------
async function launchApp() {
  const browser = await chromium.launch(LAUNCH_OPTS);
  const page = await browser.newPage();

  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/classes**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: { classes: [{ id: 'c1', name: 'Design QA Class', members: ['apple-57', 'apple-58'] }] },
      });
    } else {
      await route.fulfill({ json: { ok: true } });
    }
  });
  await page.route('**/api/pupil-names**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { names: { 'apple-57': 'Test P' } } });
    } else {
      await route.fulfill({ json: { ok: true } });
    }
  });
  await page.route('**/api/teacher-lists**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          lists: [
            { id: 't1', name: 'Design QA List', targetClasses: [], targetPupils: [], words: [{ id: 't_1', fr: 'a', en: 'b' }] },
          ],
        },
      });
    } else {
      await route.fulfill({ json: { ok: true } });
    }
  });
  await page.route('**/api/independent-study**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          tasks: [
            { id: 'is1', name: 'Design QA Task', dueAt: null, targetClasses: [], targetPupils: [], words: [{ id: 'is_1', fr: 'a', en: 'b' }] },
          ],
        },
      });
    } else {
      await route.fulfill({ json: { ok: true } });
    }
  });

  await page.addInitScript(() => {
    try { localStorage.setItem('gcseVocabAudit_account', 'trifle-18'); } catch (e) {}
  });
  await page.goto('file://' + INDEX_HTML);
  await page.waitForTimeout(400);
  return { browser, page };
}

// Curated set of screens to visit. Each is a sequence of UI actions from
// wherever the previous screen left off (they run in order, sharing one
// page) — add a new entry here whenever a new screen/card/button is built,
// rather than assuming the existing set will happen to cover it.
const SCREENS = [
  { name: 'Home', run: async () => {} }, // already there after boot
  {
    name: 'Settings',
    run: async (page) => {
      await page.click('nav.tabbar button[data-route="sync"]');
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'Classes list',
    run: async (page) => {
      await page.click('button:has-text("Manage classes")');
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'Class detail',
    run: async (page) => {
      await page.click('.tile:has-text("Design QA Class")');
      await page.waitForTimeout(300);
    },
  },
  {
    // Generalized 25 Aug 2026 from a per-class-only list into the shared
    // sortable/searchable Pupils table — this entry point opens it
    // pre-filtered to one class.
    name: 'Pupils (filtered to one class)',
    run: async (page) => {
      await page.click('button:has-text("Streaks")');
      await page.waitForTimeout(300);
    },
  },
  {
    // Same screen, reached from Settings with no class pre-selected — the
    // "All classes" scope, plus the class-filter <select> and search
    // <input> that only exist on this screen.
    name: 'Pupils (all classes, from Settings)',
    run: async (page) => {
      await page.click('nav.tabbar button[data-route="sync"]');
      await page.waitForTimeout(200);
      await page.click('button:has-text("Pupils")');
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'Manage vocab lists (list)',
    run: async (page) => {
      // Simplest reliable path back to Settings between sections: the tab
      // bar, rather than chasing each screen's own back-pill label text.
      await page.click('nav.tabbar button[data-route="sync"]');
      await page.waitForTimeout(200);
      await page.click('button:has-text("Manage vocab lists")');
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'Teacher list detail',
    run: async (page) => {
      await page.click('.tile:has-text("Design QA List")');
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'Manage Independent Study (list)',
    run: async (page) => {
      await page.click('nav.tabbar button[data-route="sync"]');
      await page.waitForTimeout(200);
      await page.click('button:has-text("Manage Independent Study")');
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'Independent Study task detail',
    run: async (page) => {
      await page.click('.tile:has-text("Design QA Task")');
      await page.waitForTimeout(300);
    },
  },
];

async function auditCurrentDOM(page, screenName, findings) {
  const skipSelectorsArg = SKIP_SELECTORS;
  const allowedSizes = ALLOWED_FONT_SIZES_PX;
  const allowedWeights = ALLOWED_FONT_WEIGHTS;

  const result = await page.evaluate(
    ({ skipSelectorsArg, allowedSizes, allowedWeights }) => {
      function matchesAny(el, selectors) {
        return selectors.some((sel) => {
          try { return el.matches(sel); } catch (e) { return false; }
        });
      }

      const out = [];
      const root = document.getElementById('app') || document.body;
      const all = root.querySelectorAll('*');

      all.forEach((el) => {
        if (matchesAny(el, skipSelectorsArg)) return;
        const cs = getComputedStyle(el);
        if (el.offsetParent === null && cs.display !== 'flex') return; // skip hidden elements

        // font-family: buttons/inputs/textareas must resolve to Inter,
        // not the OS UI font fallback.
        const tag = el.tagName.toLowerCase();
        if (tag === 'button' || tag === 'input' || tag === 'textarea') {
          if (!/inter/i.test(cs.fontFamily)) {
            out.push({
              level: 'ERROR',
              rule: 'rendered-font-family',
              detail: `<${tag}> on "${'{{SCREEN}}'}" computes font-family "${cs.fontFamily}" — expected it to include Inter.`,
            });
          }
        }

        // font-size / font-weight: only check leaf-ish text nodes (avoid
        // flagging every ancestor wrapper div that merely inherits a fine
        // value — we only care about elements with their own direct text).
        const hasOwnText = Array.from(el.childNodes).some(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0
        );
        if (hasOwnText || tag === 'button' || tag === 'input') {
          const size = Math.round(parseFloat(cs.fontSize));
          if (!allowedSizes.includes(size)) {
            out.push({
              level: 'ERROR',
              rule: 'rendered-font-size',
              detail: `Element <${tag} class="${el.className}"> on "${'{{SCREEN}}'}" computes font-size ${size}px — not one of ${allowedSizes.join(',')}px. Text: "${el.textContent.trim().slice(0, 40)}"`,
            });
          }
          const weight = parseInt(cs.fontWeight, 10);
          if (!allowedWeights.includes(weight)) {
            out.push({
              level: 'ERROR',
              rule: 'rendered-font-weight',
              detail: `Element <${tag} class="${el.className}"> on "${'{{SCREEN}}'}" computes font-weight ${weight} — not one of ${allowedWeights.join(',')}. Text: "${el.textContent.trim().slice(0, 40)}"`,
            });
          }
        }
      });

      // .btn-row immediately followed by a visible .card with no gap.
      root.querySelectorAll('.btn-row').forEach((row) => {
        const sib = row.nextElementSibling;
        if (!sib) return;
        const sibCs = getComputedStyle(sib);
        if (sibCs.display === 'none') return; // hidden card doesn't need a visual gap
        if (sib.classList.contains('card')) {
          const mb = parseFloat(getComputedStyle(row).marginBottom) || 0;
          if (mb < 8) {
            out.push({
              level: 'ERROR',
              rule: 'btn-row-card-spacing',
              detail: `A ".btn-row" on "${'{{SCREEN}}'}" is immediately followed by a ".card" with only ${mb}px gap — needs an explicit margin-bottom (12px is the established fix) on the btn-row.`,
            });
          }
        }
      });

      return out;
    },
    { skipSelectorsArg, allowedSizes: allowedSizes, allowedWeights: allowedWeights }
  );

  result.forEach((f) => {
    f.detail = f.detail.replace(/\{\{SCREEN\}\}/g, screenName);
    findings.push(f);
  });
}

async function runRenderedChecks() {
  const findings = [];
  const { browser, page } = await launchApp();
  page.on('pageerror', (err) => {
    findings.push({ level: 'ERROR', rule: 'page-error', detail: `Uncaught JS error while walking screens: ${err.message}` });
  });

  for (const screen of SCREENS) {
    try {
      await screen.run(page);
      await auditCurrentDOM(page, screen.name, findings);
    } catch (e) {
      findings.push({
        level: 'WARNING',
        rule: 'screen-navigation',
        detail: `Couldn't navigate to/audit "${screen.name}": ${e.message}. If this screen's markup or button labels changed, update SCREENS in design-lint.mjs — this is a test-maintenance gap, not necessarily a real design bug.`,
      });
    }
  }

  await browser.close();
  return findings;
}

// ---------- main ----------
const src = readSource();
const staticFindings = runStaticChecks(src);
const renderedFindings = await runRenderedChecks();
const all = [...staticFindings, ...renderedFindings];

const errors = all.filter((f) => f.level === 'ERROR');
const warnings = all.filter((f) => f.level === 'WARNING');

console.log(`\n=== design-lint: ${all.length} finding(s) — ${errors.length} error(s), ${warnings.length} warning(s) ===\n`);
for (const f of all) {
  console.log(`[${f.level}] (${f.rule}) ${f.detail}`);
}
if (all.length === 0) {
  console.log('Clean — no drift from the font-size/weight/family or spacing rules found.');
}

process.exit(errors.length > 0 ? 1 : 0);
