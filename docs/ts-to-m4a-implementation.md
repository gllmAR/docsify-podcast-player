# Implementation plan: TS→M4A SW-synthesized download

Design doc: [`ts-to-m4a-download.md`](./ts-to-m4a-download.md). This plan is the
execution blueprint — files, order, acceptance criteria, rollout.

## 0. Goal recap

Remove `.m4a` from the `sn` repo (~350 MB LFS) while keeping a working
`…/{stem}.m4a` download URL that supports right-click → Copy link → paste →
proper download. A service worker synthesizes the m4a from the HLS segments
(pure remux, no re-encode); the player falls back to main-thread remux when the
SW is not yet active.

## 1. Files & repos

```
docsify-podcast-player/  (gllmar, SSH)              — upstream of everything
├── ts2m4a.js                        NEW  dual-context module (~350 lines)
├── docsify-podcast-player.js        MOD  download button + fallback + config
├── sw.js                            NEW  reference SW (used by sn)
├── test/
│   ├── ts2m4a.test.mjs              NEW  parse/demux/mux unit tests
│   ├── sw-handler.test.mjs          NEW  pure fetch-handler tests
│   ├── podcast-player.test.mjs      MOD  download-button DOM tests (jsdom)
│   └── fixtures/                    NEW  small TS fixture (ffmpeg-generated)
├── demo/index.html                  MOD  download-button demo
└── docs/ts-to-m4a-implementation.md      THIS

sn/  (tim-montmorency, SSH)
├── sw.js                            NEW  committed (copied from plugin repo)
├── vendor/ts2m4a/ts2m4a.js          NEW  tracked local copy (override of CDN)
├── index.html                       MOD  + SW registration (manual, like basepath-fix)
├── .gitattributes                   MOD  − `*.m4a` LFS rule
├── .gitignore                       MOD  + `*.m4a`
├── AGENTS.md                        MOD  + SW/vendor/untrack notes
└── episodes/*/balado-*.m4a          DEL  `git rm --cached` (30 files, local copies kept)

582705MO-2026-01/  (tim-montmorency, SSH)
└── vendor/docsify-podcast-player    BUMP submodule (new player version)
```

## 2. Module API (`ts2m4a.js`, dual-context)

UMD-style export (`window.ts2m4a` / `self.ts2m4a` / `module.exports`) so the
same file runs in the page, the SW (`importScripts`), and Node tests.

```js
ts2m4a.VERSION = '1.0.0';                       // SW cache key + invalidation

ts2m4a.parseM3u8(text, baseUrl) → {
  type: 'vod' | 'live',                         // !ENDLIST → live
  encrypted: boolean,                           // #EXT-X-KEY present
  variants: [{ bandwidth, url }],               // #EXT-X-STREAM-INF (empty = none)
  segments: [{ url, duration }],                // absolute URLs
}

ts2m4a.demuxTs(buffer) → {
  frames: Uint8Array[],                         // raw AAC, ADTS headers stripped
  sampleRate: number, channels: number, profile: number,
}

ts2m4a.muxMp4(frames, { sampleRate, channels }) → Uint8Array
                                              // ftyp + moov + mdat, two-pass (exact stco)

ts2m4a.tsToM4a(m3u8Url, { fetchImpl, poolSize = 6, onProgress }) → Promise<ArrayBuffer>
                                              // fetchImpl injectable (tests / SW / browser)

ts2m4a.handleM4aRequest(url, { fetchImpl, cacheImpl, scope }) → Promise<Response | null>
                                              // pure: SW fetch handler + tests
```

**Demux details** — per segment: sync `0x47`; PID 0 → PAT → PMT (cache PIDs,
they repeat every segment); PES payloads for the audio PID; ADTS split via
`frame_length`. Reject non-`0x0F` stream types with a typed error.

**Mux details** — `AudioSpecificConfig 0x11 0x90` (AAC-LC/48000/2ch);
`mvhd`/`mdhd` timescale = sampleRate; `stts` all 1024; `stsc` all 1; `stsz`
per frame; single `mdat` chunk. Frames total in memory (≤ ~12 MB).

## 3. Player integration (`docsify-podcast-player.js`)

New config (defaults):

```js
showDownload:       true,
downloadLabel:      '⬇ Télécharger',
downloadBusyLabel:  '⏳ Préparation…',
downloadErrorLabel: 'Téléchargement indisponible.',
ts2m4aCdn:          'https://gllmar.github.io/docsify-podcast-player/ts2m4a.js',
```

In `enhance()` (after transcript button), for `.m3u8` sources only:

```js
// plain anchor — native right-click → "Copy link address" comes free
<a class="podcast-player-btn podcast-player-download" href="{m3u8 → .m4a}" download>⬇ Télécharger</a>
```

- `href` = `resolve(src)` with `.m3u8` → `.m4a` (works for local and
  `/remote/…`/pages URLs alike).
- `data-download="url"` overrides `href`; then the anchor is a pure link (no
  JS interception).
- Click handler:
  - SW controlling the page (`navigator.serviceWorker.controller`) → let the
    default navigation happen (SW answers with attachment disposition).
  - No SW (first visit / unsupported) → `preventDefault()`, lazy-load
    `ts2m4a.js` from `ts2m4aCdn` (same pattern as hls.js), main-thread remux
    via `tsToM4a`, blob download; busy label while working, error label +
    retry on failure.
- Styles: reuse `.podcast-player-btn`; no new CSS beyond an optional
  `.podcast-player-download` accent.

## 4. Service worker (`sw.js`)

```js
// registration (index.html, both sites if needed — v1: sn only):
navigator.serviceWorker.register((window.$docsify.basePath || '/') + 'sw.js')
  .then(r => r.update());   // ensure fresh install on deploy
```

- `install`: `self.skipWaiting()`; delete obsolete caches
  (`ts2m4a-v{old}`).
- `activate`: `clients.claim()`.
- `fetch` (GET, path ends `.m4a`, no other interception):
  1. Resolve source playlist (pure function, unit-tested):
     - local: strip `.m4a` → `.m3u8` (same dir);
     - `/remote/codeberg.org/{owner}/{repo}/…` →
       `https://{owner}.codeberg.page/{repo}/…` (same-origin on our sites);
     - anything else → `null` (pass through).
  2. `tsToM4a` → **`Content-Type: audio/mp4`**,
     **`Content-Disposition: attachment; filename="{stem}.m4a"`**,
     `Content-Length`, `Cache-Control: no-cache` (SW cache handles reuse).
  3. Cache synthesized blob in `caches.open('ts2m4a-v' + VERSION)` keyed by
     request URL; repeat downloads served from cache.
  4. Failure (missing m3u8, encrypted, live, fetch error) → 503 text response
     (never a corrupt file).
- Version bump of `ts2m4a.VERSION` → new cache namespace on next SW update.

## 5. Tests (`node --test`, jsdom)

**`ts2m4a.test.mjs`** — fixture generated once via ffmpeg into
`test/fixtures/` (2 × 2 s AAC-LC 48 kHz stereo in MPEG-TS, ~100 KB; committed;
regenerate script documented):
- `parseM3u8`: sn's real playlist text (inline) → 88 segments, `vod`,
  `encrypted: false`; relative URLs resolved.
- `demuxTs`: fixture → >0 frames, 48000 Hz, 2 ch.
- `muxMp4`: mux → temp `.m4a` → `ffprobe`: `aac`, 48000, duration ≈ 4 s;
  `ffmpeg -c copy` to ADTS → **payload byte-identical** to demuxed frames.
- `tsToM4a` with injected `fetchImpl` (no network).

**`sw-handler.test.mjs`** — `handleM4aRequest` with mocked `fetchImpl` +
`cacheImpl`: attachment + filename headers; codeberg `/remote/` mapping;
non-m4a → null; encrypted/live/missing → 503; cache hit path.

**`podcast-player.test.mjs`** (extend) — jsdom: m3u8 audio → anchor rendered
with correct `href`/`download`; `data-download` override; click with SW →
default; click without SW → `preventDefault` + busy label (mock CDN load).

## 6. `sn` repo changes (the footprint win)

1. `.gitattributes`: remove `*.m4a` line.
2. `.gitignore`: add `*.m4a` (builds keep producing it locally for QA).
3. `git rm --cached episodes/*/balado-*.m4a` (30 files; working-tree copies
   kept) — single commit `chore: untrack m4a (SW-synthesized download)`.
4. Add `sw.js` + `vendor/ts2m4a/ts2m4a.js` (tracked, `git add -f` since
   `vendor/` is ignored), `index.html` registration snippet (manual, same
   pattern as basepath-fix), AGENTS.md notes.
5. Push via SSH → CI deploys → SW live on the sn site.
6. Optional: `git lfs prune` (reclaims local cache); Codeberg LFS server
   cleanup is a separate admin step (note only).

## 7. Publishing & rollout order

1. **Plugin repo** — implement ts2m4a.js → player button → tests → `npm test`
   green → `npm run demo` sanity → version bump `1.2.0` → commit → push via
   SSH. Publish `ts2m4a.js` to the gllmar.github.io CDN location (same host as
   the other plugin files — mechanism to confirm during implementation:
   gh-pages branch vs separate repo).
2. **sn** — bump `vendor/docsify-podcast-player` submodule to `1.2.0` → add
   sw.js/ts2m4a/registration → untrack m4a → commit → push → verify deployed
   site (curl m4a URL now SW-answered in browser; 404 without SW is expected).
3. **Course repo** — bump submodule → commit → push (SSH).
4. **Verification pass** (acceptance below) on both live sites.

## 8. Acceptance criteria

- [ ] `npm test` green in the plugin repo.
- [ ] sn ep-01 page: right-click the button → Copy link address → paste in a
      new tab → file downloads as `balado-s01e01-bitkeeper-git.m4a`,
      `audio/mp4`, ~871 s, plays in a standard player.
- [ ] First visit (SW not active): button click still downloads (main-thread
      remux fallback).
- [ ] Old `::note [⬇ …](….m4a)` links keep downloading (SW-served).
- [ ] Course site remote-rendered episode pages: download works (sn SW).
- [ ] `sn`: 30 m4a untracked, no m4a re-added by future builds.
- [ ] All repos synced & pushed via SSH; submodule gitlinks bumped.

## 9. Decisions & open items

**Decided:**
- SW registered on **sn only**; course site media points at sn URLs (same
  origin) → sn SW answers. (Course site can add its own SW later if it ever
  hosts local media.)
- `ts2m4a.js` default source = gllmar.github.io CDN (plain script tag, no
  CORS); sn keeps a tracked local copy as override.
- v1: no variants/encryption/live support (balado never produces them) —
  typed error responses instead.
- Version bump `1.1.0 → 1.2.0`.

**Open:**
1. How gllmar.github.io is served (gh-pages branch? separate repo?) — confirm
   during implementation, then publish ts2m4a.js there.
2. `git lfs prune` locally after untrack (~350 MB reclaim) — OK?
3. Plugin version number `1.2.0` — OK?
