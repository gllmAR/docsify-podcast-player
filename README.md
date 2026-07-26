# docsify-podcast-player

Audio / podcast player plugin for [Docsify](https://docsify.js.org) hash-routing
sites. Replaces `docsify-media-fix.js` and adds a proper podcast experience:
cover art, clickable chapter list, and a transcript panel generated from the
WebVTT subtitles.

## Features

- **Path fixing** — relative `src`/`href` on `<audio>`, `<video>`, `<source>`,
  `<track>` and media links resolve against the current markdown page instead of
  `index.html`.
- **HLS playback** — `.m3u8` sources play natively on Safari, via
  [hls.js](https://github.com/video-dev/hls.js) (lazy-loaded from CDN) elsewhere.
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
      hlsCdn:        'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
      showCover:      true,
      showChapters:   true,
      showTranscript: true,
      coverPattern:   '{stem}-cover.png', // {stem} = audio file without extension
      chapterLabel:   'Chapitres',
      transcriptLabel:'Transcript',
      mediaExtensions: null,              // null = built-in list
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

::note [⬇ Télécharger l'audio](episode.m4a)
```

Chapters format (`episode.json`):

```json
[
  { "startTime": 0,   "title": "Générique d'ouverture" },
  { "startTime": 233, "title": "Le contexte" }
]
```

## Development

```bash
npm install        # dev dependency: jsdom
npm test           # jsdom-based unit tests
npm run demo       # serve ./demo (open the printed URL)
```

## License

MIT
