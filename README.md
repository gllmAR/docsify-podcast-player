# docsify-podcast-player

Audio / podcast player plugin for [Docsify](https://docsify.js.org) hash-routing
sites. Replaces `docsify-media-fix.js` and adds a proper podcast experience:
cover art, clickable chapter list, a transcript panel generated from the
WebVTT subtitles, and a download button whose `.m4a` is synthesized in the
browser — so the repo never has to store the m4a.

## Features

- **Path fixing** — relative `src`/`href` on `<audio>`, `<video>`, `<source>`,
  `<track>` and media links resolve against the current markdown page instead of
  `index.html`.
- **HLS playback** — `.m3u8` sources play natively on Safari, via
  [hls.js](https://github.com/video-dev/hls.js) (lazy-loaded from CDN) elsewhere.
- **Download (TS → M4A)** — a download button links to the real
  `…/{stem}.m4a` URL. The site's [service worker](#download--service-worker)
  synthesizes the file from the HLS segments at fetch time; without a SW the
  player remuxes in the main thread (lazy-loaded `ts2m4a.js`, no re-encode).
  Right-click → "Copy link address" works natively and pasting the link
  downloads the file. `data-download` overrides the target with a real file.
- **Cover art** — auto-detected `<stem>-cover.png` next to the audio file, or
  set explicitly with `data-cover="…"`.
- **Chapters** — a `<name>.json` file next to the audio (or `data-chapters="…"`)
  renders a clickable chapter list that seeks the player.
- **Transcript** — the WebVTT subtitles track becomes a toggleable, clickable
  transcript (each cue seeks the player).
- **Playlist** — previous / next track buttons when a page contains 2+ players,
  auto-advance on track end, only one player plays at a time.

## Usage

```html
<script>
  window.$docsify = {
    podcastPlayer: {
      // optional overrides (all shown with their defaults)
      hlsCdn:            'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
      showCover:          true,
      showChapters:       true,
      showTranscript:     true,
      showDownload:       true,
      downloadLabel:      '⬇ Télécharger',
      downloadBusyLabel:  '⏳ Préparation…',
      downloadErrorLabel: 'Téléchargement indisponible.',
      ts2m4aCdn:          'https://gllmar.github.io/docsify-podcast-player/ts2m4a.js',
      coverPattern:       '{stem}-cover.png', // {stem} = audio file without extension
      chapterLabel:       'Chapitres',
      transcriptLabel:    'Transcript',
      mediaExtensions:    null,              // null = built-in list
    },
  };
</script>
<script src="vendor/docsify-podcast-player/docsify-podcast-player.js"></script>
```

In markdown:

```html
<audio controls preload="none" src="episode.m3u8">
  <track kind="subtitles" src="episode.vtt" srclang="fr" label="Français" default>
</audio>

<!-- optional: keep a markdown download link — same URL, SW-served -->
::note [⬇ Télécharger l'audio](episode.m4a)
```

`data-download="direct.m4a"` on the `<audio>` points the button at a real
stored file instead of the synthesized URL.

Chapters format (`episode.json`):

```json
[
  { "startTime": 0,   "title": "Générique d'ouverture" },
  { "startTime": 233, "title": "Le contexte" }
]
```

## Download & service worker

The download button targets a real `.m4a` URL (docsify-remote-repo
resolves codeberg media through same-origin Pages URLs). When a service
worker controls the page, same-origin hrefs outside its scope (e.g.
remote-repo media under `/sn/` on a site scoped to `/582705MO-2026-1/`) are
rewritten into scope-local `/remote/…` routes the site's SW answers — so
click, middle-click, new tab and copy-paste all download. Whether a click
actually downloads depends on what answers that URL:

1. **Service worker active and in scope** (recommended): [`sw.js`](./sw.js)
   intercepts `.m4a` requests, remuxes the HLS segments with `ts2m4a`
   (`importScripts` from the plugin CDN — cached with the SW script at
   install), and responds with `Content-Disposition: attachment`. Results
   are cached in Cache Storage.
2. **No service worker**: the player catches the click and remuxes in the
   main thread (lazy-loads `ts2m4a.js` from `ts2m4aCdn`), downloading a
   blob. Copy-link still yields the real URL.

Register the SW once in `index.html` (after the docsify config):

```html
<script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(
      (window.$docsify && window.$docsify.basePath || '/') + 'sw.js'
    ).then(function (r) { r.update(); });
  }
</script>
```

The only file to track in your site is `sw.js` (copy it from this repo;
`ts2m4a` is imported from the CDN, no vendored copy).

Route mapping (`ts2m4a.handleM4aRequest`):

- local: `…/{stem}.m4a` → `…/{stem}.m3u8` (same directory, same origin)
- `/remote/codeberg.org/{owner}/{repo}/…` (scope-relative) →
  `https://{owner}.codeberg.page/{repo}/…`

Notes:

- `ts2m4a` supports AAC-LC in MPEG-TS (what `balado`/ffmpeg produce). Encrypted
  or live playlists and non-AAC streams return a 503 — never a corrupt file.
- Multi-variant playlists: the lowest-bandwidth variant is chosen.
- iOS Safari: the main-thread blob fallback opens the file in a tab (platform
  limitation); the SW path is unaffected (attachment header).
- The synthesized file carries iTunes-style metadata (`©nam`/`©ART`/`©alb`/`covr`
  from the episode `README.md` frontmatter + cover PNG, plus `©too` encoder,
  `trkn`, `©day`, `©grp`, `cpil`, `pgap` when the frontmatter provides the
  data), a spec-correct `mvhd`/`tkhd` identity matrix (Quick Look shows title,
  artist, album and the waveform thumbnail), a `tx3g` subtitle track from the
  episode `.vtt`, and a QuickTime chapter track from the episode
  `chapters.json` (bare array or Podcast Index v1.2.0 wrapper).
- MediaSession: metadata (title/artist/album) with truthful artwork (MIME
  sniffed from the URL, real `sizes` once the cover loads), `chapterInfo`
  with per-chapter `img` artwork, `setPositionState` on playback progress,
  `playbackState` following play/pause/ended, and `play`/`pause`/`stop`/
  seek/next/prev action handlers.

## Development

```bash
npm install        # dev dependency: jsdom
npm test           # node --test: ts2m4a unit tests + jsdom player tests
                   # (demux/mux round-trip validated against ffmpeg/ffprobe;
                   #  tests skip automatically when ffmpeg is unavailable)
npm run demo       # serve ./demo (open the printed URL)
```

## License

MIT
