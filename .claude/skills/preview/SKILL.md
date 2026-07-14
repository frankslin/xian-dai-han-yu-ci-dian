---
name: preview
description: Serve and headlessly drive the 现代汉语词典 reader to verify changes (page navigation, consent gate, dictionary search, URL params). Use when asked to run/preview/verify this app, or before reporting a change to index.html/static/*/data/* as done. Covers the local static server, and the libasound.so.2 stub headless Chromium needs in a container with no ALSA and no apt/network access for a real one.
---

# Previewing this reader

This is a plain static site (no build step) — `index.html` + `static/` +
`data/` + `images/`, served as-is. Read `AGENTS.md` first for what the app
is and its non-obvious constraints (URL semantics, consent gate, sharded
dict data); this skill is just the *how* of driving it to check your work.

## Serve locally

```bash
python3 -m http.server 8931 --directory /path/to/xian-dai-han-yu-ci-dian &
curl -sf http://localhost:8931/ >/dev/null && echo up   # poll, don't sleep-guess
```

Stop with `pkill -f "http.server 8931"` before relaunching (`EADDRINUSE`
otherwise, or just pick a different port).

## Headless browser setup (one-time per environment)

No browser is installed by default. Install playwright-core + chromium in a
scratch directory (not this repo):

```bash
cd <scratch dir> && npm init -y >/dev/null && npm i playwright-core
npx playwright-core install chromium
```

Chromium `dlopen()`s ALSA at startup even headless/muted; if the container
has no `libasound.so.2` (check `ldconfig -p | grep asound`), generate a stub
that exports the exact symbols/ALSA-version-nodes this specific chromium
binary needs (an empty/wrong-shaped stub fails with `undefined symbol:
snd_pcm_open, version ALSA_0.9` — the version nodes matter, not just the
symbol names):

```bash
bash /path/to/xian-dai-han-yu-ci-dian/.claude/skills/preview/setup-libasound-stub.sh
# prints: export LD_LIBRARY_PATH=<out-dir>:$LD_LIBRARY_PATH  — eval that
```

Re-run it if you switch to a different downloaded chromium version (the
required symbol set is read straight off that binary via `objdump -T`, so it
self-adapts — no hardcoded symbol list to maintain).

## Drive it

`preview.mjs` in this folder navigates, screenshots, and reports console
errors + every request under `/data/` and `/images/` — the request list
matters as much as the screenshot for this project, because the interesting
bugs here are usually "fetched something it shouldn't have" (consent gate
bypassed, dict panel eagerly pulling the whole sharded corpus) rather than
visual breakage:

```bash
export LD_LIBRARY_PATH=<out-dir-from-above>:$LD_LIBRARY_PATH
node .claude/skills/preview/preview.mjs 'http://localhost:8931/' out.png
node .claude/skills/preview/preview.mjs 'http://localhost:8931/?page=999' p999.png
```

For anything beyond a single nav+screenshot (clicking through the consent
gate, typing into the search box, checking which shard got fetched for a
given query, confirming a `?w=` reload only pulls one shard) — write a
one-off script alongside `preview.mjs` using the same `playwright-core`
import pattern (`import pw from 'playwright-core'; const { chromium } =
pw;` — it's CommonJS, not a named export) and the same `LD_LIBRARY_PATH`.
Prefer asserting on **DOM state / `localStorage` / captured request URLs**
via `page.evaluate()`/the `request` event over eyeballing screenshots —
screenshots are for visual layout only.

### Reading screenshots on this box

This sandbox has no CJK font installed, so Chinese **UI chrome text** (nav
labels, buttons, search results) renders as tofu boxes in screenshots — this
is cosmetic to the *test environment*, not a bug; a real browser has system
CJK fonts. The scanned **page images** themselves render real characters
(they're bitmaps), so judge layout/crop from those, and judge chrome-text
correctness from `innerText`/`textContent` assertions, not the screenshot.

## What to actually check

Beyond "does it render": per `AGENTS.md`'s "UI/UX decisions" section, the
properties worth asserting on when they're in scope for your change:
- **Consent gate**: fresh load (no `localStorage['usageConsent']`) →
  `dataRequests` and `imageRequests` are both empty until `#gateYes` is
  clicked.
- **URL semantics**: `?page=N`/`?id=N` on direct load show the right image;
  after navigating, the URL updates via `replaceState` (check
  `page.url()`), not `pushState` (no new history entries).
- **Sharded dict fetching**: a pinyin query fetches exactly one
  `data/dict/<shard>.json`; repeating a query already searched fetches
  nothing new; a hanzi query fetches only shards not already cached; a
  `?w=<shard>:<idx>` reload fetches only the manifest + that one shard.
- **Panel default state**: open on desktop-width (`≥860px`) viewports,
  closed on phone-width ones, unless the URL carries `q=`/`w=`.
