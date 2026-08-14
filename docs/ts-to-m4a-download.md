# Study: client-side TS → M4A download (real URL, service-worker synthesis)

**Goal.** Stop storing `.m4a` files in the `sn` repo (30 × ~11.8 MB ≈ **350 MB of
LFS storage** today) while keeping a **copyable, paste-able download link** that
yields a proper `.m4a` file. The repo keeps a single source of truth for the
audio — the HLS segments — and the M4A is synthesized at fetch time.

## 1. Verified facts (episode 01, `sn`)

| Fact | Value |
|---|---|
| Segment container | MPEG-TS, 188-byte packets |
| Audio codec in segments | **AAC-LC, 48 kHz, stereo** (~131 kbps, ADTS) |
| Segment size / count | ~10 s each, 88 segments, `hls/` total ≈ **12 MB** |
| Playlist | Single VOD playlist, `#EXT-X-ENDLIST`, **no variants, no encryption** |
| Current m4a | 11.8 MB, **no embedded art, no tags** — remux loses nothing |
| m4a vs ts size | m4a ≈ 11.8 MB vs 12 MB of TS — same AAC payload, ~1.7 % container overhead |
| Deployment | `sn` and the course site are **same-origin** (`tim-montmorency.codeberg.page`) — no CORS anywhere; `.ts` served correctly via Pages/LFS (verified live) |

Conclusion: TS → M4A is a **pure remux** (demux MPEG-TS, strip ADTS headers,
mux AAC frames into MP4). **No re-encoding** → identical quality, no WebCodecs,
tiny code footprint. Hand-rolled, matching the repo's philosophy.

## 2. Pipeline

```
fetch …/{stem}.m3u8 → parse segment list → fetch .ts (pooled, ~6 parallel)
→ TS demux (PAT/PMT → audio PID → PES → ADTS frames)
→ strip ADTS headers, keep raw AAC frames (+ sample rate, channels)
→ MP4 mux (ftyp + moov + mdat) → Response(audio/mp4, Content-Disposition: attachment)
```

Memory: ~12 MB buffered. Speed: fetch-bound; muxing a 15-min episode is well
under a second.

### 2.1 TS demux
- 188-byte packets, sync `0x47`; PID from bytes 1–2, PUSI flag, skip
  adaptation field.
- PID 0 → PAT → PMT; PMT → audio PID + `stream_type 0x0F` (ADTS AAC).
- Collect PES payloads (start code `0x000001`, strip PES header), split the
  ADTS stream into frames via the ADTS header (`frame_length`,
  `sampling_frequency_index`, `channel_configuration`, `profile`).

### 2.2 MP4 mux
AAC-LC 48 kHz stereo → `AudioSpecificConfig = 0x11 0x90` (objectType 2,
sampleRateIndex 3, channelConfig 2); every frame = 1024 samples:
- `ftyp` (`isom`/`M4A` brands), `moov` (`mvhd` timescale 48000, `trak`/`mdia`
  with `hdlr soun`, `smhd`, `dref`, `stsd` mp4a+esds, `stts` all 1024,
  `stsc` 1/chunk, `stsz` per-frame, `stco`), `mdat` raw AAC frames.

Two-pass (frames buffered) → exact `stco` offsets. Muxer ≈ **300–350 lines**,
0 dependencies. Phase 2 optional: `meta`/`ilst` (©nam/©ART/`covr`) — the current
m4a has none, so nothing is lost initially.

## 3. The copy-link requirement → real URL + service worker

**A blob: URL cannot satisfy copy-link** (ephemeral, origin-bound, dies with
the page). The download target must be a **real, stable URL** — so we keep the
exact URLs that exist today (`…/{stem}.m4a`) and make a **service worker**
synthesize the file at fetch time. Nothing in the site markup changes;
bookmarks and pasted links keep working.

### 3.1 Service worker (`sw.js`, one per site, scope = site root)

- Registered from `index.html`: `navigator.serviceWorker.register(basePath + '/sw.js')`
  with `skipWaiting()` + `clients.claim()` so pasted links work as soon as
  possible after first visit.
- `fetch` handler: request path ends in `.m4a` →
  1. Resolve the source playlist: local path `…/{stem}.m3u8`, or — for
     `/remote/{host}/{owner}/{repo}/…` paths (course site) — map
     `codeberg.org/{owner}/{repo}` → `https://{owner}.codeberg.page/{repo}`
     (same convention as `docsify-remote-repo`'s mediaBase; same origin here,
     so no CORS).
  2. Fetch segments, remux (shared `ts2m4a.js` module, `importScripts`-compatible).
  3. Respond: `Content-Type: audio/mp4`,
     `Content-Disposition: attachment; filename="{stem}.m4a"`,
     `Content-Length`.
  4. Cache the synthesized blob in Cache Storage (repeat downloads instant,
     works offline); invalidation by playlist mtime/version.
- Everything else passes through untouched.

### 3.2 Player download control — a plain anchor

```html
<a class="podcast-player-btn podcast-player-download"
   href="…/{stem}.m4a" download>⬇ Télécharger</a>
```

- **Left click** → navigation → SW responds with attachment disposition →
  browser downloads the file.
- **Right click → Copy link address** → the copied value is the real URL.
- **Paste** into the address bar / new tab / messenger (same browser) → SW
  serves → proper download.
- **Fallback** (SW not active yet, e.g. very first visit): the player catches
  the click and remuxes on the main thread (same `ts2m4a.js`) → blob download;
  the `href` remains the real URL, so copy-link is never degraded.
- `data-download` attribute overrides the href (e.g. a real stored file).

### 3.3 What copy-link can and cannot do

| Link target | Paste, same browser | New tab, same browser | curl / other device / messenger → file |
|---|---|---|---|
| blob: URL | ✗ dies with page | ✗ | ✗ |
| data: URL (16 MB) | ✓ ugly | ✓ | ✗ mostly blocked |
| **Real URL + SW synthesis** | ✓ | ✓ | ✗ (404 without SW installed) |
| Stored m4a (today) | ✓ | ✓ | ✓ (costs ~350 MB LFS) |

A link that works for **any client, any device** strictly requires the file on
a server; Codeberg Pages is static, so SW synthesis is the closest
storage-free option. If universal sharing is a hard requirement, keep the
m4a stored and drop the remux idea.

### 3.4 Markdown-side (`sn` episode pages)

The existing pattern keeps working unchanged (same URL, now SW-served):

```markdown
::note [⬇ Télécharger l'audio](balado-s01e01-bitkeeper-git.m4a)
```

The player also renders its own button automatically for `.m3u8` sources.

## 4. Repo-side changes (`sn`) — the footprint win

1. `.gitattributes`: remove the `*.m4a` LFS rule.
2. `.gitignore`: add `*.m4a` (builds still produce it locally for QA).
3. `git rm --cached episodes/*/balado-*.m4a` (keep working-tree copies) —
   one commit; local LFS cache prunable with `git lfs prune`.
4. Optional later: purge m4a pointers from history + Codeberg LFS GC
   (server-side; pointer blobs are tiny, not needed for the win).
5. `build-all.sh`: unchanged — m4a stays a local build artifact.

Result: **≈ 350 MB less LFS storage** (roughly half the audio bytes), one
source of truth, download URL unchanged.

## 5. Risks / edge cases

| Case | Handling |
|---|---|
| SW not installed (other browser/device) | link 404s → documented limitation; fallback remux covers same-browser first visit |
| Playlist variants | pick lowest-bandwidth audio variant |
| Encrypted HLS (`#EXT-X-KEY`) | error response (balado doesn't encrypt) |
| Live playlist (no ENDLIST) | error response |
| `EXT-X-DISCONTINUITY` | treat as continuous; verify in tests |
| AAC encoder delay | remuxed file may start ~20 ms in — negligible |
| 12 MB memory spike | acceptable; stream-mux later (phase 2) |
| iOS Safari `download` attr | blob fallback opens in tab (platform limit); SW path unaffected (attachment header) |
| SW update staleness | version bump + `skipWaiting` on `ts2m4a.js` change |

Rejected alternatives: **mux.js** (+50–100 KB third-party, against the
lightweight philosophy), **WebCodecs re-encode** (lossy, unnecessary).

## 7. Prior art — who already solves this

### A. The architecture (stable URL → on-demand synthesis) is standard — at the edge

Commercial platforms generate the "download file" from stored HLS on request,
keeping the URL stable:

- **Cloudflare Stream** — "Download videos": the MP4 is generated on demand at
  the edge from the stored HLS ([docs](https://developers.cloudflare.com/stream/viewing-videos/download-videos/)).
- **Mux** — assets expose a server-generated MP4 download URL
  ([docs](https://www.mux.com/docs)).
- **Bunny Stream** — MP4 fallback generated for HLS streams.

This validates the "URL never changes, file is synthesized at request time"
architecture. Static hosts (Codeberg Pages) can't run edge code — the service
worker is the static-host equivalent of the same pattern.

### B. Browser-side TS→MP4 conversion is a solved sub-problem

| Library | Size | Role in our problem |
|---|---|---|
| [mux.js](https://github.com/videojs/mux.js) (videojs) | 114 KB UMD dist (~40 KB gz; custom m2ts+mp4 builds smaller) | Battle-tested TS→fMP4 transmuxer (video.js's engine) |
| [hls.js](https://github.com/video-dev/hls.js) | 617 KB min | Already loaded in our player; internally remuxes TS→fMP4 (`FRAG_PARSED` recipes exist) but yields *fragmented* MP4 — needs a moov fix-up for a classic `.m4a`; couples download to hls.js internals |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | 32 KB min | Pure-TS MP4 muxer (WebCodecs-oriented, accepts raw chunks); pairs with a small TS→AAC demuxer |
| [mediabunny](https://github.com/Vanilagy/mediabunny) | 10 MB unpacked | Closest off-the-shelf toolkit: **reads/writes MPEG-TS, MP4, HLS, ADTS…** full in-browser conversion; heavy for a docsify plugin, but a phase-2 swap-in for exotic formats |

### C. SW-side synthetic responses

- [Workbox](https://github.com/GoogleChrome/workbox) (Google) — the standard SW
  framework; `registerRoute` + a custom handler returning
  `new Response(body, { headers })` with `Content-Disposition` is a documented
  pattern. Our need is a single route → plain SW suffices; Workbox only adds
  value if we want caching/versioning batteries.
- SW attachment semantics: a SW Response is plain HTTP; browsers honor
  `Content-Disposition: attachment` on navigations — the copy-paste flow
  depends on this standard behavior.

### D. HLS "downloader" tooling

Browser extensions (the "HLS Downloader" class) and yt-dlp merge segments
server- or extension-side: TS concatenation (VLC-playable), mux.js transmux, or
ffmpeg.wasm (20–30 MB wasm). None integrate with a static docsify site or
produce a copyable, stable URL.

### E. Verdict

Nobody ships "HLS-only static repo + real `.m4a` URL + SW synthesis + docsify".
The architecture is proven at the edge (A), the conversion pieces are proven in
the browser (B), and the SW plumbing is standard (C). **Hand-rolled ~300-line
remux stays justified**: fixed codec (AAC-LC 48 kHz stereo), single variant,
VOD, no encryption → ~3–4 KB vs mux.js ~40 KB gz vs mediabunny megabytes.
Escape hatch: if future episodes add MP3-in-TS, variants, or encryption, swap
our demuxer for a custom mux.js build — the URL/SW design doesn't change.

## 6. Implementation plan

1. `ts2m4a.js` — dual-context module (main thread + SW, UMD-style
   `window`/`self` export): `parseM3u8`, `demuxTs`, `muxMp4`.
2. `sw.js` — fetch handler, repo→Pages mapping, attachment headers, Cache
   Storage; register from `index.html` (sn site + course site).
3. Player — anchor-based download button, main-thread remux fallback,
   `data-download` override, busy/error states.
4. Tests (`test/`): ffmpeg-generated TS fixture → remuxed m4a parses
   (`ffprobe`), duration ≈ source, AAC payload identical; SW handler tested
   as a pure function.
5. `sn`: untrack m4a (section 4), update notes; bump plugin submodule in
   `sn` + course repo; push via SSH.
