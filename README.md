# docsify-podcast-player

Audio/podcast player plugin for [Docsify](https://docsify.js.org) hash-routing sites.

## Features

- **Path fixing** — relative `src`/`href` on `<audio>`, `<video>`, `<source>`, `<track>` and media links resolve against the current markdown page instead of `index.html` (replaces `docsify-media-fix.js`)
- **HLS playback** — `.m3u8` sources play natively on Safari, via [hls.js](https://github.com/video-dev/hls.js) (lazy-loaded from CDN) everywhere else
- **Playlist** — previous / next track buttons when a page contains 2+ players, auto-advance on track end, only one player plays at a time
- **Chapters** — a `<name>.json` file next to the audio (or `data-chapters="…"`) adds a chapter jump menu

## Usage

```html
<script>
  window.$docsify = {
    podcastPlayer: {
      // optional overrides
      hlsCdn: 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
      mediaExtensions: null,
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
```

Chapters format (`episode.json`):

```json
[
  { "startTime": 0, "title": "Générique d'ouverture" },
  { "startTime": 233, "title": "Le contexte" }
]
```

## License

MIT
