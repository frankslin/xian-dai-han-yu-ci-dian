# AGENTS.md — 现代汉语词典 第7版 online reader

Guidance for AI agents (and humans) working in this repo. Read this before
touching URL handling, the dictionary data pipeline, or the design system.

## What this is

A static, no-build web reader for **scanned page images of 《现代汉语词典》
第7版** (1897 images in `images/`, one per physical page/cover/endpaper),
plus a headword/pinyin lookup that jumps to an **approximate** page and shows
the matched dictionary entry's text, derived from a third-party full-text
transcription. Everything is client-side; there is no server/build step
beyond the one-off Python script that generates `data/dict/*.json`.

Interaction design (page-flip mechanics, sticky nav/controls, edge/tap/swipe
paging, panel UI) is modeled on the `shuiluo-jinmen-collection` reader's
design system: neutral surfaces, one accent color, 8px grid, hairline
dividers, light/dark aware.

## Repository layout

| Path | Committed? | What |
|------|-----------|------|
| `index.html` | yes | markup shell only — all logic lives in `static/app.js` |
| `static/styles.css` | yes | design system + component styles |
| `static/app.js` | yes | viewer, TOC panel, dictionary search, URL sync, consent gate |
| `static/favicon.png` | yes | favicon |
| `images/000N.{png,jpg}` | yes | the actual scanned page images — `.png` for image index 5–1894, `.jpg` outside that range (cover/endpapers). Never touched by this session's work; treat as ground truth. |
| `data/toc.json` | yes | **source of truth** for chapter bookmarks (`sections`) and pinyin-syllable page anchors (`syllables`), both keyed by raw **image index** (not printed page number). Originally hand-authored inside `index.html` as `BOOKMARKS`/`SEARCH_BOOKMARKS`; extracted out so both `app.js` and `tools/build_dict_index.py` share one copy. Edit this file directly if a bookmark/anchor needs fixing — do not reintroduce a duplicate copy in `index.html`. |
| `data/dict/manifest.json` | yes (generated) | maps each pinyin-initial letter → its shard key, plus per-shard row counts/byte sizes |
| `data/dict/<range>.json` | yes (generated) | dictionary entries, sharded by contiguous pinyin-initial-letter range (e.g. `a-b.json`, `z.json`) sized to be roughly even; `west.json` holds the separate Western-letter-headword section (AI, ABC, α粒子, …) |
| `tools/build_dict_index.py` | yes | generates `data/dict/*` from the cached source text — see below |
| `tools/.cache/` | **gitignored** | cached raw source text (`XDHYCD7th.txt`, `西文字母开头的词语.txt`), ~7.7MB — a derivative/community transcription, not redistributed as-is, only its derived index is committed |

## URL semantics — do not change without being asked

These have been stable across this app's history; several users may have
bookmarked/shared links using them.

- `?page=N` / `?p=N` — **logical/printed page N** (the number printed on the
  physical page, i.e. body page 1 is the first page of the character index).
  Maps to image index `N + OFFSET` where `OFFSET = 94` (`BODY_START_IMAGE - 1`,
  `BODY_START_IMAGE = 95`).
- `?id=N` / `?image=N` / `?img=N` — **raw image index** N directly (used for
  front matter / cover / endpapers, which have no printed page number).
- `?q=` — mirrors the 查字 panel's search box text.
- `?w=` — mirrors the currently-open dictionary entry, as
  `"<shardKey>:<indexWithinShard>"` (e.g. `w=a-b:4450`). Reloading a URL with
  `?w=` fetches **only** that one shard (via `data/dict/manifest.json` →
  `ensureShard(key)`), not the whole corpus — preserve this when touching the
  restore-from-URL logic in `app.js`'s `startApp()`.

The current page is always reflected back via `history.replaceState` (never
`pushState` — there is intentionally no browser-back page-by-page history).
`page`/`id` are mutually exclusive in the URL (whichever mode is current wins
and the other params are stripped); `q`/`w` are independent and layer on top.

## The usage-consent gate

`static/app.js`'s `startApp()` — which shows the first page image and fetches
`data/toc.json` — does not run until the user answers the consent gate
(`#gate` in `index.html`, wired at the bottom of `app.js`). This is
intentional and required by the project owner: **no page image, no TOC, no
dictionary shard is ever fetched before consent**, verified by watching
network requests in a headless browser (zero requests to `images/` or
`data/` pre-consent). Consent is remembered in `localStorage['usageConsent']`
so returning visitors aren't re-asked. If you add new eager-loading behavior
(prefetch, service worker, etc.), it must also wait for `startApp()`.

## Dictionary data pipeline

`tools/build_dict_index.py` builds `data/dict/*` from the community
full-text transcription at github.com/CNMan/XDHYCD7th (cached under
`tools/.cache/`, not committed — re-fetch with `curl` if missing; see the
script's own header comment for the exact URLs). Re-run after editing the
script or after re-fetching an updated source text:

```bash
mkdir -p tools/.cache
curl -s https://raw.githubusercontent.com/CNMan/XDHYCD7th/master/XDHYCD7th.txt -o tools/.cache/XDHYCD7th.txt
curl -s https://raw.githubusercontent.com/CNMan/XDHYCD7th/master/西文字母开头的词语.txt -o tools/.cache/西文字母开头的词语.txt
python3 tools/build_dict_index.py            # writes data/dict/*.json (~8.7MB total)
```

**Why approximate pages, and how**: the source transcription has no
per-entry page number. Every single-character headword resets a "current
pinyin-syllable bucket" (looked up against `data/toc.json`'s `syllables`
anchors); every multi-character word entry inherits the bucket of the
character entry above it — this exactly mirrors how the physical dictionary
nests word entries under their lead character, so it needs no pinyin
segmentation of multi-syllable words. Within a bucket, entries are spread
proportionally across its page range by order of appearance. **This is a
best-effort estimate, not ground truth** — the UI must keep saying so
(`.enote` in the entry detail view). Known limitations, deliberately not
"fixed" by guessing at values we can't verify:
- `data/toc.json`'s `hong` syllable anchor is non-monotonic relative to its
  neighbors (a pre-existing data quirk, present identically in two
  independently-hosted copies of an earlier version of this app — not a bug
  introduced here). `build_syllable_table()` in the build script is written
  to tolerate this (it searches forward for the next anchor whose page is
  `>=` the current one when computing a bucket's end boundary) rather than
  guess-correcting the source value.
- ~42 single-character entries (out of 65k+) fail syllable lookup (rare
  supplementary-plane characters with no visible pinyin in the source,
  disyllabic single-character readings like 浬/呎/吋, a handful of syllables
  missing from `toc.json`'s table like `zen`/`reng`/`nen`/`lo`). These fall
  back to carrying forward the previous entry's bucket, which in practice
  still lands within a few pages of the truth. Re-run the build script and
  check its printed miss count if you touch the parsing/normalization logic.

**Sharding**: `data/dict/manifest.json` maps each pinyin-initial letter to a
shard file; shards are contiguous letter *ranges* (not one per letter — `s`,
`y`, `z` alone have 10x the entries of `o`/`e`), sized via
`partition_letters()`'s minimize-the-largest-shard binary search so no
single letter's outsized entry count dominates one file. `--shards N` (CLI
flag, default 10) controls the target count. **A pinyin query only needs its
first letter's shard**; a hanzi query's pinyin isn't known ahead of time, so
it needs every shard — still each fetched at most once (see `shardCache` in
`app.js`). Keep this fetch-only-what's-needed property when changing search
logic — it's why the 查字 panel can default to open (see below) without
costing 8.7MB on every desktop page load.

## UI/UX decisions worth knowing before you "fix" them

- **查字 panel opens by default on desktop/tablet** (`≥860px`, matching the
  `.stage`/`.nav`/`.controls` reflow breakpoint in `styles.css`), **closed by
  default on phones** (full-screen overlay there) — unless the URL has `q=`
  or `w=`, in which case it opens on any screen size. This was an explicit
  request; don't silently revert to closed-by-default without asking.
- **No page-turn animation** — page changes are an instant image swap
  (`flip()`/`goto()` in `app.js`). A 3D page-flip was tried and explicitly
  removed; don't reintroduce it without asking. (Also: these are
  already-single-page scans, not two-page spreads, so the
  `shuiluo-jinmen-collection` reader's centre-fold flip never quite applied
  here even when it existed.)
- **No bottom progress slider, no first/last-page buttons** — removed by
  request; the control bar is prev / page badge / jump box / zoom / next
  only.
- **Tap-zone hover tint is intentionally very subtle** (`color-mix(in srgb,
  var(--text) 5%, transparent)` fading out within 16% of the zone width) —
  an earlier, much stronger accent-blue wash across >half the screen was
  reported as ugly and replaced. Keep new hover/affordance treatments
  similarly restrained.
- The exact-jump behavior (`getPageNumberByName`/`getImageIndexFromNumericInput`,
  surfaced as the "精确" quick-suggestion row in dict search results) predates
  the fuzzy dictionary search and must keep working standalone even if
  `data/dict/` fails to load (see the `manifestError` fallback path in
  `renderDictResults`).

## Design system

`static/styles.css` top-of-file `:root` block holds the tokens (`--bg`,
`--surface`, `--accent`, `--s1`…`--s6` spacing, `--r1`/`--r2` radii,
`--panel-w`, etc.), each with a `prefers-color-scheme: dark` override.
Follow the existing tokens rather than hardcoding colors/sizes — this keeps
light/dark theming and the `body.invert` night-reading mode working
uniformly.

## Verifying changes

See the `preview` skill (`.claude/skills/preview/SKILL.md`) for driving the
app headlessly (this sandbox has no installed browser) — it documents the
`libasound.so.2` stub workaround headless Chromium needs here, and a ready
driver script. Always verify by watching actual network requests / DOM state
in that harness (not just "it renders"), especially for anything touching
the consent gate, URL params, or shard fetching — those are exactly the
things that look fine visually while being subtly wrong.
