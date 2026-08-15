import { JSDOM } from 'jsdom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = readFileSync(path.join(__dirname, '..', 'docsify-podcast-player.js'), 'utf8');

// A fake Docsify environment: a page at /cours/episodes/01/ with one audio
// player whose relative sources must be rewritten against the page route.
const PAGE_HTML = `<!doctype html><html><head></head><body>
  <div class="markdown-section">
    <audio controls preload="none" src="ep.m3u8" data-title="Épisode 1">
      <track kind="subtitles" src="ep.vtt" srclang="fr" label="Français" default>
    </audio>
  </div>
</body></html>`;

function boot(html, opts) {
  opts = opts || {};
  const { overrides, mediaSession, mediaMetadata, serviceWorker, swProbe, hls, feed, localStorage: seedStorage } = opts;
  // Site deployed at the domain root; the episode lives only in the hash
  // route (Docsify hash routing). The episode's media files sit next to the
  // rendered page, i.e. at /episodes/01/<file>.
  const url = opts.url || 'https://example.com/#/episodes/01/';
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  global.window = window;
  global.document = window.document;

  window.$docsify = Object.assign({ plugins: [] }, overrides || {});
  if (seedStorage) {
    for (const k of Object.keys(seedStorage)) {
      window.localStorage.setItem(k, String(seedStorage[k]));
    }
  }
  if (mediaSession) {
    Object.defineProperty(window.navigator, 'mediaSession',
      { value: mediaSession, configurable: true });
  }
  if (mediaMetadata) window.MediaMetadata = mediaMetadata;
  if (serviceWorker) {
    Object.defineProperty(window.navigator, 'serviceWorker',
      { value: serviceWorker, configurable: true });
  }
  // No real HLS engine in jsdom: window.Hls is undefined unless the test opts in.
  if (hls) window.Hls = hls;
  const FEED_JSON = JSON.stringify({
    version: '1.0',
    series: { title: 'Test', description: '', author: '', artwork: '', baseUrl: 'https://example.com' },
    episodes: [
      { guid: 'a', title: 'Épisode 1', pageUrl: 'https://example.com/episodes/01/',
        audioUrl: 'https://example.com/episodes/01/ep.m3u8', chaptersUrl: '', transcriptUrl: '',
        coverUrl: '', date: '', season: 1, episode: 1,
        next: 'https://example.com/episodes/02/', prev: '' },
      { guid: 'b', title: 'Épisode 2', pageUrl: 'https://example.com/episodes/02/',
        audioUrl: 'https://example.com/episodes/02/ep2.m3u8', chaptersUrl: '', transcriptUrl: '',
        coverUrl: '', date: '', season: 1, episode: 2,
        next: '', prev: 'https://example.com/episodes/01/' },
    ],
  });
  const FEED_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel><title>Test</title><description>D</description><link>https://example.com</link>
<item><title>Épisode 1</title><guid>a</guid><link>https://example.com/episodes/01/</link><enclosure url="https://example.com/episodes/01/ep.m3u8" type="application/vnd.apple.mpegurl"/><podcast:chapters url="x.json" type="application/json+chapters"/><podcast:transcript url="x.vtt" type="text/vtt"/><itunes:season>1</itunes:season><itunes:episode>1</itunes:episode></item>
<item><title>Épisode 2</title><guid>b</guid><link>https://example.com/episodes/02/</link><enclosure url="https://example.com/episodes/02/ep2.m3u8" type="application/vnd.apple.mpegurl"/><podcast:chapters url="y.json" type="application/json+chapters"/><podcast:transcript url="y.vtt" type="text/vtt"/><itunes:season>1</itunes:season><itunes:episode>2</itunes:episode></item>
</channel></rss>`;
  window.fetch = async (u) => {
    if (String(u).endsWith('feed.json')) {
      return feed === 'json' ? { ok: true, json: async () => JSON.parse(FEED_JSON) }
        : { ok: false, status: 404 };
    }
    if (String(u).endsWith('podcast.xml')) {
      return feed === 'rss' ? { ok: true, text: async () => FEED_RSS }
        : { ok: false, status: 404 };
    }
    if (String(u).endsWith('sw.js')) {
      // SW auto-detect probe (HEAD): ok only when the test opts in.
      return { ok: swProbe === 'ok', status: swProbe === 'ok' ? 200 : 404 };
    }
    if (String(u).endsWith('.json')) {
      // Podcast Index v1.2.0 wrapped format (what balado now emits).
      return { ok: true, json: async () => ({
        version: '1.2.0',
        chapters: [
          { startTime: 0, title: 'Générique', img: 'ch1.jpg' },
          { startTime: 30, title: 'Introduction' },
        ],
      }) };
    }
    if (String(u).endsWith('.vtt')) {
      return { ok: true, text: async () => (
        'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Hôte>Bonjour le monde</v>\n\n' +
        '00:00:05.000 --> 00:00:08.000\nDeuxième ligne du transcript'
      ) };
    }
    return { ok: false, status: 404 };
  };

  window.eval(PLUGIN);

  // Simulate Docsify calling our plugin after each route render.
  const hook = { doneEach: (cb) => cb() };
  window.$docsify.plugins.forEach((p) => p(hook));
  return window;
}

function fire(elm, type) {
  elm.dispatchEvent(new elm.ownerDocument.defaultView.Event(type, { bubbles: true }));
}

test('rewrites relative media paths against the page route', () => {
  const w = boot(PAGE_HTML);
  const audio = w.document.querySelector('audio');
  assert.equal(audio.dataset.podcastFixed, '1');
  // fixPaths keeps the original (relative) src in data-original-src…
  assert.equal(audio.dataset.originalSrc, 'ep.m3u8');
  // …and rewrites the track (not stripped by HLS) to the absolute route.
  const track = w.document.querySelector('track');
  assert.ok(track.getAttribute('src').endsWith('/episodes/01/ep.vtt'),
    'track src should be rewritten to the page route');
});

test('wraps the audio element in a .podcast-player container', () => {
  const w = boot(PAGE_HTML);
  const wrap = w.document.querySelector('.podcast-player');
  assert.ok(wrap, 'player wrapper present');
  assert.equal(wrap.querySelector('audio'), w.document.querySelector('audio'));
});

test('renders cover art from the auto-detected <stem>-cover.png', () => {
  const w = boot(PAGE_HTML);
  const cover = w.document.querySelector('.podcast-player-cover');
  assert.ok(cover, 'cover image present');
  assert.ok(cover.getAttribute('src').endsWith('/episodes/01/ep-cover.png'));
});

test('builds a clickable chapter list from the JSON', async () => {
  const w = boot(PAGE_HTML);
  await new Promise((r) => setTimeout(r, 10));
  const details = w.document.querySelector('.podcast-player-chapters');
  assert.ok(details, 'chapters block present');
  const items = details.querySelectorAll('ol li');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /Générique/);
  assert.match(items[1].textContent, /Introduction/);
});

test('transcript button loads and renders VTT cues', async () => {
  const w = boot(PAGE_HTML);
  const btn = w.document.querySelector('.podcast-player-transcript-btn');
  assert.ok(btn, 'transcript button present');
  btn.click();
  await new Promise((r) => setTimeout(r, 10));
  const paras = w.document.querySelectorAll('.podcast-player-transcript p');
  assert.equal(paras.length, 2);
  assert.match(paras[0].textContent, /Bonjour le monde/);
  assert.match(paras[1].textContent, /Deuxième ligne/);
});

test('playlist prev/next appear only with 2+ players; help always in toolbar', () => {
  const two = `<div class="markdown-section">
    <audio src="a.m3u8"></audio>
    <audio src="b.m3u8"></audio>
  </div>`;
  const w = boot(two);
  const bar = w.document.querySelector('.podcast-player-toolbar');
  assert.ok(bar, 'toolbar present with two players');
  assert.equal(bar.querySelectorAll('.podcast-player-prev, .podcast-player-next').length, 2);
  assert.ok(bar.querySelector('.pp-help'), 'help button in the toolbar');

  const one = boot(PAGE_HTML);
  const bar1 = one.document.querySelector('.podcast-player-toolbar');
  assert.ok(bar1, 'toolbar present with a single player (help lives there)');
  assert.equal(
    bar1.querySelectorAll('.podcast-player-prev, .podcast-player-next').length, 0,
    'no playlist nav with one player');
  assert.ok(bar1.querySelector('.pp-help'), 'help button present with one player');
});

// ── MediaSession (next/prev episode navigation) ──────────────────────────

test('MediaSession next/prev jump to the adjacent episode via pagination links', () => {
  const handlers = {};
  // docsify-pagination puts the class on a wrapper <div> with the <a> inside.
  const html = `<!doctype html><html><head></head><body>
    <div class="markdown-section">
      <audio controls src="ep.m3u8" data-title="Épisode 1"></audio>
    </div>
    <div class="pagination">
      <div class="pagination-item pagination-item--previous"><a href="#/episodes/00-last/"></a></div>
      <div class="pagination-item pagination-item--next"><a href="#/episodes/02-next/"></a></div>
    </div>
  </body></html>`;
  const w = boot(html, {
    mediaSession: {
      setActionHandler: (a, h) => { handlers[a] = h; },
      metadata: null, playbackState: '',
    },
    mediaMetadata: class { constructor(o) { Object.assign(this, o); } },
  });
  assert.ok(handlers.nexttrack, 'nexttrack handler registered');
  assert.ok(handlers.previoustrack, 'previoustrack handler registered');

  handlers.nexttrack();
  assert.equal(w.location.hash, '#/episodes/02-next/');
  handlers.previoustrack();
  assert.equal(w.location.hash, '#/episodes/00-last/');
});

test('MediaSession metadata is set on play', () => {
  let metadata = null;
  const w = boot(PAGE_HTML, {
    mediaSession: {
      setActionHandler() {},
      set metadata(m) { metadata = m; },
      get metadata() { return metadata; },
      playbackState: '',
    },
    mediaMetadata: class { constructor(o) { Object.assign(this, o); } },
  });
  const audio = w.document.querySelector('audio');
  fire(audio, 'play');
  assert.ok(metadata, 'MediaSession metadata was set');
  assert.match(metadata.title, /Épisode 1/);
});

// ── MediaSession metadata quality (artwork, chapters, position) ───────

test('MediaSession artwork carries a truthful MIME type and reported size', async () => {
  let metadata = null;
  const w = boot(PAGE_HTML, {
    mediaSession: {
      setActionHandler() {},
      set metadata(m) { metadata = m; },
      get metadata() { return metadata; },
      playbackState: '',
    },
    mediaMetadata: class { constructor(o) { Object.assign(this, o); } },
  });
  const audio = w.document.querySelector('audio');
  fire(audio, 'play');
  assert.ok(metadata.artwork.length >= 1);
  const art = metadata.artwork[0];
  assert.match(art.src, /ep-cover\.png$/);
  assert.equal(art.type, 'image/png', 'MIME sniffed from the URL extension');
  assert.ok(art.sizes, 'sizes present (any or real dimensions)');
});

test('MediaSession chapterInfo maps title/startTime and per-chapter img artwork', async () => {
  let metadata = null;
  const w = boot(PAGE_HTML, {
    mediaSession: {
      setActionHandler() {},
      set metadata(m) { metadata = m; },
      get metadata() { return metadata; },
      playbackState: '',
    },
    mediaMetadata: class { constructor(o) { Object.assign(this, o); } },
  });
  const audio = w.document.querySelector('audio');
  fire(audio, 'play');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(metadata.chapterInfo, 'chapterInfo set from the v1.2.0 wrapper');
  assert.equal(metadata.chapterInfo.length, 2);
  assert.equal(metadata.chapterInfo[0].startTime, 0);
  assert.ok(metadata.chapterInfo[0].artwork, 'per-chapter artwork present');
  assert.equal(metadata.chapterInfo[0].artwork[0].type, 'image/jpeg');
  assert.equal(metadata.chapterInfo[1].artwork, undefined,
    'chapters without img carry no artwork entry');
});

test('MediaSession setPositionState reports duration/rate/position on timeupdate', async () => {
  const states = [];
  const w = boot(PAGE_HTML, {
    mediaSession: {
      setActionHandler() {},
      metadata: null,
      playbackState: '',
      setPositionState(s) { states.push(s); },
    },
    mediaMetadata: class { constructor(o) { Object.assign(this, o); } },
  });
  const audio = w.document.querySelector('audio');
  Object.defineProperty(audio, 'duration', { value: 600, configurable: true });
  Object.defineProperty(audio, 'currentTime', { value: 42, configurable: true });
  audio.playbackRate = 1;                 // jsdom fires ratechange here
  fire(audio, 'timeupdate');
  assert.ok(states.length >= 1);
  const last = states[states.length - 1];
  assert.equal(last.duration, 600);
  assert.equal(last.playbackRate, 1);
  assert.equal(last.position, 42);
});

test('MediaSession playbackState follows play/pause/ended', async () => {
  let state = '';
  const w = boot(PAGE_HTML, {
    mediaSession: {
      setActionHandler() {},
      metadata: null,
      set playbackState(s) { state = s; },
      get playbackState() { return state; },
    },
    mediaMetadata: class { constructor(o) { Object.assign(this, o); } },
  });
  const audio = w.document.querySelector('audio');
  fire(audio, 'play');
  assert.equal(state, 'playing');
  fire(audio, 'pause');
  assert.equal(state, 'paused');
  fire(audio, 'ended');
  assert.equal(state, 'paused');
});

test('MediaSession play/pause/stop handlers control the active audio', async () => {
  const handlers = {};
  const w = boot(PAGE_HTML, {
    mediaSession: {
      setActionHandler: (a, h) => { handlers[a] = h; },
      metadata: null, playbackState: '',
    },
    mediaMetadata: class { constructor(o) { Object.assign(this, o); } },
  });
  assert.ok(handlers.play, 'play handler registered');
  assert.ok(handlers.pause, 'pause handler registered');
  assert.ok(handlers.stop, 'stop handler registered');
  const audio = w.document.querySelector('audio');
  let played = 0, paused = 0, pos = 99;
  audio.play = () => { played++; };
  audio.pause = () => { paused++; };
  Object.defineProperty(audio, 'currentTime', {
    get: () => pos, set: (v) => { pos = v; }, configurable: true,
  });
  fire(audio, 'play');          // makes it the activeAudio
  handlers.play();
  assert.equal(played, 1, 'play handler plays the active audio');
  handlers.pause();
  assert.equal(paused, 1, 'pause handler pauses the active audio');
  handlers.stop();
  assert.equal(paused, 2, 'stop pauses');
  assert.equal(pos, 0, 'stop rewinds to the start');
});

test('chapters JSON v1.2.0 wrapper renders the same list as a bare array', async () => {
  const w = boot(PAGE_HTML);
  await new Promise((r) => setTimeout(r, 10));
  const items = w.document.querySelectorAll('.podcast-player-chapters ol li');
  assert.equal(items.length, 2, 'wrapped format unwrapped for the chapter list');
  assert.match(items[0].textContent, /Générique/);
});

test('per-chapter cover swap + current-chapter label follow timeupdate', async () => {
  const w = boot(PAGE_HTML);
  await new Promise((r) => setTimeout(r, 10));
  const audio = w.document.querySelector('audio');
  const cover = w.document.querySelector('.podcast-player-cover');
  const now = w.document.querySelector('.podcast-player-chapter-now');
  assert.ok(cover && now, 'cover and chapter label present');
  assert.ok(cover.getAttribute('src').endsWith('/episodes/01/ep-cover.png'),
    'starts with the episode cover');

  // Chapter 1 (Générique, img ch1.jpg) starts at 0.
  Object.defineProperty(audio, 'currentTime', { value: 5, configurable: true });
  fire(audio, 'timeupdate');
  assert.ok(cover.getAttribute('src').endsWith('/episodes/01/ch1.jpg'),
    `cover swapped to the chapter img (got ${cover.getAttribute('src')})`);
  assert.equal(now.textContent, 'Générique');
  assert.equal(now.style.display, '');

  // Chapter 2 (Introduction, no img) starts at 30 → restore episode cover.
  Object.defineProperty(audio, 'currentTime', { value: 35, configurable: true });
  fire(audio, 'timeupdate');
  assert.ok(cover.getAttribute('src').endsWith('/episodes/01/ep-cover.png'),
    'cover restored when the chapter has no img');
  assert.equal(now.textContent, 'Introduction');
});


// ── Download button (TS → M4A) ────────────────────────────────────────

test('download anchor renders for .m3u8 with the real .m4a href', () => {
  const w = boot(PAGE_HTML);
  const a = w.document.querySelector('.podcast-player-download');
  assert.ok(a, 'download anchor present');
  assert.equal(a.tagName, 'A');
  assert.ok(a.href.endsWith('/episodes/01/ep.m4a'),
    `href points at the .m4a URL (got ${a.href})`);
  assert.ok(a.hasAttribute('download'), 'download attribute present');
});

test('no download button for non-HLS sources', () => {
  const html = `<div class="markdown-section">
    <audio controls src="ep.mp3"></audio>
  </div>`;
  const w = boot(html);
  assert.equal(w.document.querySelector('.podcast-player-download'), null);
});

test('data-download overrides the href', () => {
  const html = `<div class="markdown-section">
    <audio controls src="ep.m3u8" data-download="direct.m4a"></audio>
  </div>`;
  const w = boot(html);
  const a = w.document.querySelector('.podcast-player-download');
  assert.ok(a.href.endsWith('/episodes/01/direct.m4a'));
});

test('click with a controlling service worker lets the default navigation happen', () => {
  const w = boot(PAGE_HTML);
  Object.defineProperty(w.navigator, 'serviceWorker', {
    value: { controller: { scriptURL: 'https://example.com/sw.js' } },
    configurable: true,
  });
  w.ts2m4a = { tsToM4a: async () => { throw new Error('must not be called'); } };
  const a = w.document.querySelector('.podcast-player-download');
  const ev = new w.Event('click', { cancelable: true });
  a.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, 'SW path: default navigation');
});

test('click without SW falls back to main-thread remux + blob download', async () => {
  const w = boot(PAGE_HTML);
  let created = null;
  let tmpDownload = null;
  w.ts2m4a = { tsToM4a: async () => new Uint8Array([1, 2, 3]) };
  w.URL.createObjectURL = () => 'blob:fake';
  w.URL.revokeObjectURL = () => {};
  const origCreate = w.document.createElement.bind(w.document);
  w.document.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'a') {
      const origClick = el.click.bind(el);
      el.click = () => { tmpDownload = el.download; origClick(); };
    }
    return el;
  };

  const a = w.document.querySelector('.podcast-player-download');
  const ev = new w.Event('click', { cancelable: true });
  a.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'fallback intercepts the click');
  assert.match(a.textContent, /Préparation/, 'busy label while remuxing');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.textContent, '⬇ Télécharger', 'label restored');
  assert.equal(tmpDownload, 'ep.m4a', 'blob download filename');
  const blob = created;
  assert.ok(!blob || blob.size === 3, 'blob carries the remuxed bytes');
});

test('pages-URL downloads rewrite to an in-scope /remote/ route (course site)', () => {
  const html = `<div class="markdown-section">
    <audio controls src="https://tim-montmorency.codeberg.page/sn/episodes/01/x.m3u8"></audio>
  </div>`;
  // Course SW controls the page from the start (same origin as the page).
  const w = boot(html, {
    serviceWorker: { controller: { scriptURL: 'https://example.com/sw.js' } },
  });
  w.ts2m4a = { tsToM4a: async () => { throw new Error('must not remux'); } };
  const a = w.document.querySelector('.podcast-player-download');
  assert.ok(a.href.startsWith('https://example.com/remote/codeberg.org/tim-montmorency/sn/episodes/01/x.m4a'),
    `href rewritten into the SW scope (got ${a.href})`);
  const ev = new w.Event('click', { cancelable: true });
  a.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, 'SW path: default navigation');
});

test('click without SW falls back to main-thread remux + blob download', async () => {
  const w = boot(PAGE_HTML);
  let created = null;
  let tmpDownload = null;
  w.ts2m4a = { tsToM4a: async () => new Uint8Array([1, 2, 3]) };
  w.URL.createObjectURL = () => 'blob:fake';
  w.URL.revokeObjectURL = () => {};
  const origCreate = w.document.createElement.bind(w.document);
  w.document.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'a') {
      const origClick = el.click.bind(el);
      el.click = () => { tmpDownload = el.download; origClick(); };
    }
    return el;
  };

  const a = w.document.querySelector('.podcast-player-download');
  const ev = new w.Event('click', { cancelable: true });
  a.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'fallback intercepts the click');
  assert.match(a.textContent, /Préparation/, 'busy label while remuxing');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.textContent, '⬇ Télécharger', 'label restored');
  assert.equal(tmpDownload, 'ep.m4a', 'blob download filename');
  const blob = created;
  assert.ok(!blob || blob.size === 3, 'blob carries the remuxed bytes');
});

test('click falls back when the download URL is outside the SW scope (remote-repo pages)', async () => {
  const html = `<div class="markdown-section">
    <audio controls src="https://tim-montmorency.codeberg.page/sn/episodes/01/x.m3u8"></audio>
  </div>`;
  const w = boot(html);
  // Course SW controls the page but its scope is /582705MO-2026-01/;
  // the download href lives under /sn/ → outside the scope.
  Object.defineProperty(w.navigator, 'serviceWorker', {
    value: { controller: { scriptURL: 'https://tim-montmorency.codeberg.page/582705MO-2026-01/sw.js' } },
    configurable: true,
  });
  let remuxed = false;
  w.ts2m4a = { tsToM4a: async () => { remuxed = true; return new Uint8Array([1]); } };
  w.URL.createObjectURL = () => 'blob:fake';
  w.URL.revokeObjectURL = () => {};
  const a = w.document.querySelector('.podcast-player-download');
  const ev = new w.Event('click', { cancelable: true });
  a.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'fallback intercepts out-of-scope downloads');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(remuxed, true, 'main-thread remux ran');
});

// ── v2: custom controls, accessibility, responsive ────────────────────

test('v2: custom play button toggles icon + aria-label with playback state', () => {
  const w = boot(PAGE_HTML);
  const audio = w.document.querySelector('audio');
  const play = w.document.querySelector('.pp-btn-play');
  assert.ok(play, 'custom play button present');
  assert.equal(play.getAttribute('aria-label'), 'Écouter');
  fire(audio, 'play');
  assert.equal(play.getAttribute('aria-label'), 'Pause');
  fire(audio, 'pause');
  assert.equal(play.getAttribute('aria-label'), 'Écouter');
});

test('v2: Space on a focused button does not double-toggle playback', () => {
  const w = boot(PAGE_HTML);
  const wrap = w.document.querySelector('.podcast-player');
  const back = w.document.querySelector('.pp-btn-back');
  const audio = w.document.querySelector('audio');
  let played = 0, paused = 0;
  audio.play = () => { played++; };
  audio.pause = () => { paused++; };
  back.focus();
  const ev = new w.KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
  wrap.dispatchEvent(ev);
  assert.equal(played + paused, 0, 'space on a button must not toggle playback');
  // Space on the wrap itself still toggles
  wrap.focus();
  const ev2 = new w.KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
  wrap.dispatchEvent(ev2);
  assert.equal(played, 1, 'space on the wrap toggles play');
});

test('v2: back/forward buttons seek by the configured amount', () => {
  const w = boot(PAGE_HTML);
  const audio = w.document.querySelector('audio');
  let t = 50;
  Object.defineProperty(audio, 'currentTime', {
    get: () => t, set: (v) => { t = v; }, configurable: true,
  });
  Object.defineProperty(audio, 'duration', { value: 600, configurable: true });
  w.document.querySelector('.pp-btn-forward').click();
  assert.equal(t, 60);
  w.document.querySelector('.pp-btn-back').click();
  assert.equal(t, 50);
});

test('v2: scrubber reflects time and carries aria-valuetext', () => {
  const w = boot(PAGE_HTML);
  const audio = w.document.querySelector('audio');
  const scrub = w.document.querySelector('.pp-scrubber');
  assert.ok(scrub, 'scrubber present');
  assert.equal(scrub.type, 'range');
  Object.defineProperty(audio, 'duration', { value: 600, configurable: true });
  Object.defineProperty(audio, 'currentTime', { value: 42, configurable: true });
  fire(audio, 'timeupdate');
  assert.equal(scrub.max, '600');
  assert.equal(scrub.value, '42');
  assert.match(scrub.getAttribute('aria-valuetext'), /0:42 \/ 10:00/);
  // v3: times split at the ends of the progress row.
  assert.equal(w.document.querySelector('.pp-time').textContent, '0:42');
  assert.equal(w.document.querySelector('.pp-time-total').textContent, '10:00');
});

test('v2: speed button cycles options and announces', async () => {
  const w = boot(PAGE_HTML);
  const audio = w.document.querySelector('audio');
  const speed = w.document.querySelector('.pp-speed');
  assert.ok(speed, 'speed button present');
  audio.playbackRate = 1;
  speed.click();
  assert.equal(audio.playbackRate, 1.25);
  assert.equal(speed.textContent, '1.25×');
  const live = w.document.querySelector('.pp-live');
  await new Promise((r) => setTimeout(r, 30));
  assert.match(live.textContent, /Vitesse/);
});

test('v2: mute button toggles aria-pressed and icon', () => {
  const w = boot(PAGE_HTML);
  const audio = w.document.querySelector('audio');
  const mute = w.document.querySelector('.pp-mute');
  assert.ok(mute, 'mute button present');
  audio.muted = false;
  mute.click();
  assert.equal(audio.muted, true);
  assert.equal(mute.getAttribute('aria-pressed'), 'true');
  mute.click();
  assert.equal(audio.muted, false);
  assert.equal(mute.getAttribute('aria-pressed'), 'false');
});

test('v2: chapter prev/next buttons jump between chapters', () => {
  const w = boot(PAGE_HTML);
  return new Promise((resolve) => {
    setTimeout(() => {
      const audio = w.document.querySelector('audio');
      const prev = w.document.querySelector('.pp-btn-chap-prev');
      const next = w.document.querySelector('.pp-btn-chap-next');
      assert.ok(prev && next, 'chapter nav buttons present');
      let t = 35; // inside chapter 2 (starts at 30)
      Object.defineProperty(audio, 'currentTime', {
        get: () => t, set: (v) => { t = v; }, configurable: true,
      });
      audio.play = () => {};
      fire(audio, 'timeupdate');
      next.disabled = true; // last chapter
      prev.click();
      assert.equal(t, 30, 'prev jumps to current chapter start');
      resolve();
    }, 20);
  });
});

test('v2: transcript toggle uses aria-expanded + aria-controls', async () => {
  const w = boot(PAGE_HTML);
  const btn = w.document.querySelector('.podcast-player-transcript-btn');
  assert.ok(btn.getAttribute('aria-controls'), 'aria-controls present');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  btn.click();
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  const panel = w.document.querySelector('.podcast-player-transcript');
  assert.equal(panel.hidden, false);
});

test('v2: resume chip appears when a saved position exists', async () => {
  const html = `<!doctype html><html><head></head><body>
    <div class="markdown-section">
      <audio controls preload="none" src="ep.m3u8"></audio>
    </div>
  </body></html>`;
  const w = boot(html);
  const audio = w.document.querySelector('audio');
  w.sessionStorage.setItem('podcast-pos:ep.m3u8', '120');
  Object.defineProperty(audio, 'duration', { value: 600, configurable: true });
  fire(audio, 'loadedmetadata');
  await new Promise((r) => setTimeout(r, 10));
  const chip = w.document.querySelector('.pp-resume');
  assert.ok(chip, 'resume chip present');
  assert.equal(chip.hidden, false);
  assert.match(chip.textContent, /Reprendre à 2:00/);
});

test('v2: help dialog opens on ? button, Esc closes and restores focus', async () => {
  const w = boot(PAGE_HTML);
  const help = w.document.querySelector('.pp-help');
  help.click();
  await new Promise((r) => setTimeout(r, 10));
  const dlg = w.document.getElementById('pp-help-dialog');
  assert.ok(dlg, 'help dialog present');
  assert.equal(dlg.getAttribute('role'), 'dialog');
  const esc = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  dlg.dispatchEvent(esc);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.document.getElementById('pp-help-dialog'), null, 'dialog closed');
  assert.equal(w.document.activeElement, help, 'focus restored to the help button');
});

test('v2: native audio controls are visually hidden once enhanced', () => {
  const w = boot(PAGE_HTML);
  const wrap = w.document.querySelector('.podcast-player');
  assert.equal(wrap.dataset.enhanced, '1');
  const css = [...w.document.querySelectorAll('style')]
    .map((s) => s.textContent).join('\n');
  assert.match(css, /data-enhanced="1"\] audio/, 'CSS hides native audio');
  assert.match(css, /prefers-reduced-motion/, 'reduced-motion rule present');
  assert.match(css, /forced-colors/, 'forced-colors rule present');
  assert.match(css, /@media print/, 'print rule present');
  assert.match(css, /--pp-accent/, 'design tokens present');
});

test('v2: download failure announces via role=alert and live region', async () => {
  const w = boot(PAGE_HTML);
  w.ts2m4a = { tsToM4a: async () => { throw new Error('boom'); } };
  const a = w.document.querySelector('.podcast-player-download');
  a.click();
  await new Promise((r) => setTimeout(r, 30));
  const alert = w.document.querySelector('.podcast-player-error-msg[role="alert"]');
  assert.ok(alert, 'role=alert error element present');
  const live = w.document.querySelector('.pp-live');
  assert.match(live.textContent, /Téléchargement indisponible/);
});

test('v2: time is a <time> element with datetime + hover-remaining span', () => {
  const w = boot(PAGE_HTML);
  const audio = w.document.querySelector('audio');
  const time = w.document.querySelector('.pp-time');
  assert.equal(time.tagName, 'TIME', 'time element');
  assert.equal(time.dateTime, 'PT0S');
  const rem = w.document.querySelector('.pp-remaining');
  assert.ok(rem, 'remaining span present');
  assert.equal(rem.getAttribute('aria-hidden'), 'true');
  Object.defineProperty(audio, 'duration', { value: 600, configurable: true });
  Object.defineProperty(audio, 'currentTime', { value: 42, configurable: true });
  fire(audio, 'timeupdate');
  assert.equal(time.dateTime, 'PT42S');
  assert.match(rem.textContent, /9:18/);
  assert.match(rem.textContent, /restant/);
});

test('v3: controls split into progress row and transport row', () => {
  const w = boot(PAGE_HTML);
  const controls = w.document.querySelector('.pp-controls');
  assert.ok(controls, 'controls container kept');
  const progress = w.document.querySelector('.pp-progress');
  const transport = w.document.querySelector('.pp-transport');
  assert.ok(progress && transport, 'progress + transport rows present');
  // DOM order = visual order = tab order: progress row first.
  assert.equal(controls.firstElementChild, progress, 'progress row first');
  assert.equal(progress.nextElementSibling, transport, 'transport row second');
  // Progress row: current time at the left end, total at the right end.
  assert.equal(progress.firstElementChild.className, 'pp-time-wrap');
  assert.equal(progress.lastElementChild.className, 'pp-time-total-wrap');
  // Transport row: nav group (back/play/forward), chapters group, spacer,
  // settings group (speed/volume).
  const nav = transport.querySelector('.pp-group-nav');
  const chap = transport.querySelector('.pp-group-chap');
  const settings = transport.querySelector('.pp-group-settings');
  assert.ok(nav && chap && settings, 'three groups present');
  assert.ok(nav.querySelector('.pp-btn-back'), 'back in nav group');
  assert.ok(nav.querySelector('.pp-btn-play'), 'play in nav group');
  assert.ok(nav.querySelector('.pp-btn-forward'), 'forward in nav group');
  assert.ok(chap.querySelector('.pp-btn-chap-prev'), 'chapter prev in its group');
  assert.ok(chap.querySelector('.pp-btn-chap-next'), 'chapter next in its group');
  assert.ok(settings.querySelector('.pp-speed'), 'speed in settings group');
  assert.ok(settings.querySelector('.pp-volume'), 'volume in settings group');
  assert.ok(transport.querySelector('.pp-spacer'), 'spacer between groups');
  // Help is out of the transport bar — it lives in the toolbar instead.
  assert.ok(!transport.querySelector('.pp-help'), 'no help button in the transport');
  const toolbar = w.document.querySelector('.pp-toolbar');
  assert.ok(toolbar, 'toolbar present');
  assert.ok(toolbar.querySelector('.pp-help'), 'help button moved to the toolbar');
});

test('v3: play button is dominant (48px round) and rows are stacked', () => {
  const w = boot(PAGE_HTML);
  const css = [...w.document.querySelectorAll('style')]
    .map((s) => s.textContent).join('\n');
  assert.match(css, /\.pp-btn-play \{[^}]*min-height: 48px/s, 'play larger than 40px default');
  assert.match(css, /\.pp-controls \{[^}]*flex-direction: column/s, 'two-row stack');
  assert.match(css, /\.pp-time-total-wrap:hover \.pp-time-total \{ display: none; \}/,
    'hover swap now targets the total');
});

test('v3: chapter markers on the scrubber are clickable and jump to the chapter', async () => {
  const w = boot(PAGE_HTML);
  await new Promise((r) => setTimeout(r, 30)); // chapters fetch resolves
  const audio = w.document.querySelector('audio');
  Object.defineProperty(audio, 'duration', { value: 600, configurable: true });
  let t = 0;
  Object.defineProperty(audio, 'currentTime', {
    get: () => t, set: (v) => { t = v; }, configurable: true,
  });
  audio.play = () => {};
  fire(audio, 'timeupdate');
  const markers = w.document.querySelectorAll('.pp-ticks i');
  assert.equal(markers.length, 1, 'one marker at 30 s (edge ticks skipped)');
  assert.ok(markers[0].title, 'marker carries the chapter title');
  markers[0].click();
  assert.equal(t, 30, 'clicking the marker seeks to the chapter start');
});

test('v3: bookmarks — mark at current position, list, seek, toggle remove', () => {
  const w = boot(PAGE_HTML);
  const audio = w.document.querySelector('audio');
  let t = 0;
  Object.defineProperty(audio, 'currentTime', {
    get: () => t, set: (v) => { t = v; }, configurable: true,
  });
  audio.play = () => {};
  const btn = w.document.querySelector('.pp-bookmark');
  assert.ok(btn, 'bookmark button present');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');

  t = 120;
  fire(audio, 'timeupdate');
  btn.click();
  const stored = JSON.parse(w.localStorage.getItem('podcast-bookmarks:ep.m3u8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].t, 120);
  const list = w.document.querySelector('.pp-bookmarks ol');
  assert.ok(list.querySelector('.pp-bookmark-go'), 'list item rendered');
  assert.equal(list.querySelector('.pp-bookmark-go').textContent, '2:00');

  // Seek from the list.
  t = 5;
  list.querySelector('.pp-bookmark-go').click();
  assert.equal(t, 120, 'clicking the bookmark seeks to it');

  // Toggle: clicking the button near an existing bookmark removes it.
  t = 121;
  btn.click();
  assert.equal(JSON.parse(w.localStorage.getItem('podcast-bookmarks:ep.m3u8')).length, 0);
  assert.ok(w.document.querySelector('.pp-bookmark-empty'), 'empty state shown');
});

test('v3: bookmark button reflects a bookmark at the current position', () => {
  const w = boot(PAGE_HTML);
  const audio = w.document.querySelector('audio');
  let t = 0;
  Object.defineProperty(audio, 'currentTime', {
    get: () => t, set: (v) => { t = v; }, configurable: true,
  });
  audio.play = () => {};
  const btn = w.document.querySelector('.pp-bookmark');
  t = 42;
  btn.click(); // marks 42
  fire(audio, 'timeupdate');
  assert.equal(btn.getAttribute('aria-pressed'), 'true', 'pressed at the marked position');
  t = 100;
  fire(audio, 'timeupdate');
  assert.equal(btn.getAttribute('aria-pressed'), 'false', 'released away from the mark');
});

test('v2: chapter ticks drawn on the scrubber once duration is known', async () => {
  const w = boot(PAGE_HTML);
  await new Promise((r) => setTimeout(r, 10));
  const audio = w.document.querySelector('audio');
  const ticks = w.document.querySelector('.pp-ticks');
  assert.ok(ticks, 'ticks layer present');
  assert.equal(ticks.getAttribute('aria-hidden'), 'true');
  Object.defineProperty(audio, 'duration', { value: 600, configurable: true });
  fire(audio, 'timeupdate');
  const marks = ticks.querySelectorAll('i');
  assert.equal(marks.length, 1, 'one inner tick for the chapter at 30s');
  assert.equal(marks[0].style.left, '5%');
});

test('v2: scrubber Home/End seek to start and end', () => {
  const w = boot(PAGE_HTML);
  const audio = w.document.querySelector('audio');
  const scrub = w.document.querySelector('.pp-scrubber');
  let t = 50;
  Object.defineProperty(audio, 'currentTime', {
    get: () => t, set: (v) => { t = v; }, configurable: true,
  });
  Object.defineProperty(audio, 'duration', { value: 600, configurable: true });
  scrub.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
  assert.equal(t, 0, 'Home seeks to 0');
  scrub.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  assert.equal(t, 600, 'End seeks to duration');
});

test('v2: J/L keyboard aliases seek ±seekSeconds', () => {
  const w = boot(PAGE_HTML);
  const wrap = w.document.querySelector('.podcast-player');
  const audio = w.document.querySelector('audio');
  let t = 50;
  Object.defineProperty(audio, 'currentTime', {
    get: () => t, set: (v) => { t = v; }, configurable: true,
  });
  Object.defineProperty(audio, 'duration', { value: 600, configurable: true });
  wrap.dispatchEvent(new w.KeyboardEvent('keydown', { code: 'KeyJ', bubbles: true, cancelable: true }));
  assert.equal(t, 40, 'J seeks back 10s');
  wrap.dispatchEvent(new w.KeyboardEvent('keydown', { code: 'KeyL', bubbles: true, cancelable: true }));
  assert.equal(t, 50, 'L seeks forward 10s');
});

test('v2: "?" opens the shortcuts dialog and Esc closes it', () => {
  const w = boot(PAGE_HTML);
  const wrap = w.document.querySelector('.podcast-player');
  wrap.dispatchEvent(new w.KeyboardEvent('keydown', { code: 'Slash', shiftKey: true, bubbles: true, cancelable: true }));
  const dialog = w.document.getElementById('pp-help-dialog');
  assert.ok(dialog, 'help dialog opened by ?');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  dialog.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.ok(!w.document.getElementById('pp-help-dialog'), 'Esc closes the dialog');
});

test('v2: volume persists to localStorage and restores on boot', () => {
  const w = boot(PAGE_HTML);
  const audio = w.document.querySelector('audio');
  const vol = w.document.querySelector('.pp-volume-range');
  vol.value = '42';
  fire(vol, 'input');
  assert.equal(w.localStorage.getItem('pp-volume'), '0.42');

  const w2 = boot(PAGE_HTML, { localStorage: { 'pp-volume': '0.5' } });
  const audio2 = w2.document.querySelector('audio');
  assert.equal(audio2.volume, 0.5, 'volume restored from localStorage');
  assert.equal(w2.document.querySelector('.pp-volume-range').value, '50');
});

// ── v2: service-worker self-registration (download synthesis) ────────

function makeSwFake() {
  return {
    registered: [],
    updateCalls: 0,
    register(url) {
      this.registered.push(url);
      return Promise.resolve({ update: () => { this.updateCalls++; } });
    },
  };
}

test('v2: auto-detects and registers sw.js at the site root (version-pinned)', async () => {
  const sw = makeSwFake();
  const w = boot(PAGE_HTML, { serviceWorker: sw, swProbe: 'ok' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sw.registered.length, 1, 'registered once');
  const url = sw.registered[0];
  assert.match(url, /^\/sw\.js\?v=\d+\.\d+\.\d+$/, 'registered at site root, version-pinned');
  assert.equal(sw.updateCalls, 1, 'update() called after registration');
});

test('v2: skips registration when the sw.js probe fails', async () => {
  const sw = makeSwFake();
  const w = boot(PAGE_HTML, { serviceWorker: sw }); // probe → 404
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sw.registered.length, 0, 'no registration without sw.js');
});

test('v2: explicit downloadSw path registers without a probe', async () => {
  const sw = makeSwFake();
  const w = boot(PAGE_HTML, {
    overrides: { podcastPlayer: { downloadSw: 'assets/sw.js' } },
    serviceWorker: sw,
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sw.registered.length, 1);
  assert.match(sw.registered[0], /assets\/sw\.js\?v=\d+\.\d+\.\d+$/);
});

test('v2: downloadSw:false disables registration', async () => {
  const sw = makeSwFake();
  const w = boot(PAGE_HTML, {
    overrides: { podcastPlayer: { downloadSw: false } },
    serviceWorker: sw, swProbe: 'ok',
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sw.registered.length, 0);
});

test('v2: registers at most once per page even with several players', async () => {
  const html = `<!doctype html><html><head></head><body>
    <div class="markdown-section">
      <audio controls src="a.m3u8"></audio>
      <audio controls src="b.m3u8"></audio>
    </div>
  </body></html>`;
  const sw = makeSwFake();
  const w = boot(html, { serviceWorker: sw, swProbe: 'ok' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sw.registered.length, 1, 'one registration per page');
});

// ── v2 improvements: cross-visit resume, HLS errors, tooltip, speakers ─

test('v2: position persists to localStorage and is cleared on ended', async () => {
  const w = boot(PAGE_HTML);
  const audio = w.document.querySelector('audio');
  Object.defineProperty(audio, 'duration', { value: 600, configurable: true });
  Object.defineProperty(audio, 'currentTime', { value: 120, configurable: true });
  fire(audio, 'timeupdate');
  assert.equal(w.localStorage.getItem('podcast-pos:ep.m3u8'), '120',
    'position saved to localStorage');
  fire(audio, 'ended');
  assert.equal(w.localStorage.getItem('podcast-pos:ep.m3u8'), null,
    'position purged on ended');
});

test('v2: resume chip reads localStorage (cross-visit) and hides near the end', async () => {
  const html = `<!doctype html><html><head></head><body>
    <div class="markdown-section">
      <audio controls preload="none" src="ep.m3u8"></audio>
    </div>
  </body></html>`;
  // Cross-visit resume: seed localStorage before boot.
  const w = boot(html, { localStorage: { 'podcast-pos:ep.m3u8': '120' } });
  const audio = w.document.querySelector('audio');
  Object.defineProperty(audio, 'duration', { value: 600, configurable: true });
  fire(audio, 'loadedmetadata');
  await new Promise((r) => setTimeout(r, 10));
  const chip = w.document.querySelector('.pp-resume');
  assert.equal(chip.hidden, false, 'chip shown from localStorage');
  assert.match(chip.textContent, /Reprendre à 2:00/);

  // Near the end (< 30 s margin) → no chip.
  const w2 = boot(html, { localStorage: { 'podcast-pos:ep.m3u8': '580' } });
  Object.defineProperty(w2.document.querySelector('audio'), 'duration', { value: 600, configurable: true });
  fire(w2.document.querySelector('audio'), 'loadedmetadata');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w2.document.querySelector('.pp-resume').hidden, true,
    'no chip within the last 30 s');
});

test('v2: HLS unsupported shows an error instead of silent playback', async () => {
  const w = boot(PAGE_HTML, { hls: { isSupported: () => false } });
  await new Promise((r) => setTimeout(r, 20));
  const err = w.document.querySelector('.podcast-player-error');
  assert.ok(err, 'error box present when hls.js is unavailable');
  assert.equal(err.getAttribute('role'), 'alert');
});

test('v2: HLS fatal error retries once with backoff, then shows the error', async () => {
  const instances = [];
  class FakeHls {
    constructor() { this.callbacks = {}; this.destroyed = false; instances.push(this); }
    loadSource() {}
    attachMedia() {}
    on(evt, cb) { this.callbacks[evt] = cb; }
    destroy() { this.destroyed = true; }
  }
  FakeHls.isSupported = () => true;
  FakeHls.Events = { MANIFEST_PARSED: 'mp', ERROR: 'err' };
  const w = boot(PAGE_HTML, { hls: FakeHls });
  const audio = w.document.querySelector('audio');
  fire(audio, 'play');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(instances.length, 1, 'first hls instance attached');
  instances[0].callbacks.err('err', { fatal: true });
  assert.equal(instances[0].destroyed, true, 'first instance destroyed');
  // Backoff retry: a second instance attaches after 2 s.
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(instances.length, 2, 'retry attaches a second instance');
  instances[1].callbacks.err('err', { fatal: true });
  await new Promise((r) => setTimeout(r, 20));
  const err = w.document.querySelector('.podcast-player-error');
  assert.ok(err, 'final error shown after retry');
});

test('v2: speaker labels from <v> tags are styled separately', async () => {
  const w = boot(PAGE_HTML);
  const btn = w.document.querySelector('.podcast-player-transcript-btn');
  btn.click();
  await new Promise((r) => setTimeout(r, 20));
  const speaker = w.document.querySelector('.pp-cue-speaker');
  assert.ok(speaker, 'speaker element present');
  assert.equal(speaker.textContent, 'Hôte');
  const p = speaker.closest('p');
  assert.match(p.textContent, /Bonjour le monde/);
});

test('v2: speed is persisted per episode', () => {
  const w = boot(PAGE_HTML);
  const speed = w.document.querySelector('.pp-speed');
  speed.click();
  assert.equal(w.sessionStorage.getItem('podcast-speed:ep.m3u8'), '1.25');
});

// ── v2: good VTT follow mode ─────────────────────────────────────────

function openTranscript(w) {
  const btn = w.document.querySelector('.podcast-player-transcript-btn');
  btn.click();
}

test('v2: follow scrolls only when the active cue changes', async () => {
  const w = boot(PAGE_HTML);
  openTranscript(w);
  await new Promise((r) => setTimeout(r, 20));
  const audio = w.document.querySelector('audio');
  let calls = 0;
  w.Element.prototype.scrollIntoView = function () {
    if (this.closest && this.closest('.podcast-player-transcript')) calls++;
  };
  let t = 1; // cue 0 (1 s)
  Object.defineProperty(audio, 'currentTime', { get: () => t, set: (v) => { t = v; }, configurable: true });
  fire(audio, 'timeupdate');
  assert.equal(calls, 1, 'scrolled on entering cue 0');
  t = 1.5; // still cue 0
  fire(audio, 'timeupdate');
  assert.equal(calls, 1, 'no scroll while in the same cue');
  t = 6; // cue 1 (5 s)
  fire(audio, 'timeupdate');
  assert.equal(calls, 2, 'scrolled on entering cue 1');
});

test('v2: manual wheel scroll suspends follow; refollow button resumes', async () => {
  const w = boot(PAGE_HTML);
  openTranscript(w);
  await new Promise((r) => setTimeout(r, 20));
  const audio = w.document.querySelector('audio');
  const panel = w.document.querySelector('.podcast-player-transcript');
  const rf = w.document.querySelector('.pp-refollow');
  assert.ok(rf, 'refollow button present');
  assert.equal(rf.hidden, true, 'hidden while following');
  let calls = 0;
  w.Element.prototype.scrollIntoView = function () {
    if (this.closest && this.closest('.podcast-player-transcript')) calls++;
  };
  let t = 1;
  Object.defineProperty(audio, 'currentTime', { get: () => t, set: (v) => { t = v; }, configurable: true });
  fire(audio, 'timeupdate');
  assert.equal(calls, 1);
  // User takes over with the wheel.
  panel.dispatchEvent(new w.Event('wheel'));
  assert.equal(rf.hidden, false, 'refollow button appears');
  await new Promise((r) => setTimeout(r, 30));
  assert.match(w.document.querySelector('.pp-live').textContent, /suspendu/);
  t = 6; // cue change, but suspended
  fire(audio, 'timeupdate');
  assert.equal(calls, 1, 'no auto-scroll while suspended');
  // Resume via the floating button.
  rf.click();
  assert.equal(rf.hidden, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.match(w.document.querySelector('.pp-live').textContent, /repris/);
  fire(audio, 'timeupdate'); // next tick re-follows → scroll to cue 1
  assert.equal(calls, 2, 'scrolls to the current cue on resume');
});

test('v2: follow toggle off stops auto-scroll entirely', async () => {
  const w = boot(PAGE_HTML);
  openTranscript(w);
  await new Promise((r) => setTimeout(r, 20));
  const fb = w.document.querySelector('.pp-follow');
  fb.click(); // follow off
  assert.equal(fb.getAttribute('aria-pressed'), 'false');
  const audio = w.document.querySelector('audio');
  let calls = 0;
  w.Element.prototype.scrollIntoView = function () {
    if (this.closest && this.closest('.podcast-player-transcript')) calls++;
  };
  let t = 1;
  Object.defineProperty(audio, 'currentTime', { get: () => t, set: (v) => { t = v; }, configurable: true });
  fire(audio, 'timeupdate');
  t = 6;
  fire(audio, 'timeupdate');
  assert.equal(calls, 0, 'no scrolling when follow is off');
  // Re-enable → resumes and announces.
  fb.click();
  assert.equal(fb.getAttribute('aria-pressed'), 'true');
  await new Promise((r) => setTimeout(r, 30));
  assert.match(w.document.querySelector('.pp-live').textContent, /repris/);
});

test('v2: active cue highlight stays correct in a filtered (search) list', async () => {
  const w = boot(PAGE_HTML);
  openTranscript(w);
  await new Promise((r) => setTimeout(r, 20));
  const search = w.document.querySelector('.pp-transcript-search');
  search.value = 'Deuxième'; // only cue 1 matches
  fire(search, 'input');
  const audio = w.document.querySelector('audio');
  let t = 1;
  Object.defineProperty(audio, 'currentTime', { get: () => t, set: (v) => { t = v; }, configurable: true });
  fire(audio, 'timeupdate');
  // Cue 1 is the only visible one; at t=1 it is NOT active.
  const ps = w.document.querySelectorAll('.podcast-player-transcript p');
  assert.equal(ps.length, 1);
  assert.equal(ps[0].hasAttribute('aria-current'), false);
  t = 6; // now inside cue 1 → highlighted
  fire(audio, 'timeupdate');
  assert.equal(ps[0].getAttribute('aria-current'), 'true');
});

// ── v2: unified player (persistent playback) ─────────────────────────

const UNIFIED_HTML = `<!doctype html><html><head></head><body>
  <div class="markdown-section">
    <audio controls preload="none" src="ep.m3u8" data-title="Épisode 1"></audio>
  </div>
</body></html>`;

function bootUnified(html, opts) {
  return boot(html || UNIFIED_HTML, Object.assign(
    { overrides: { podcastPlayer: { unified: true } } }, opts || {}));
}

test('unified: one persistent global player in body, surfaces on the page', () => {
  const w = bootUnified();
  const globals = w.document.querySelectorAll('body > .pp-global');
  assert.equal(globals.length, 1, 'single .pp-global container');
  assert.equal(globals[0].querySelectorAll('audio').length, 1, 'one global audio');
  const surface = w.document.querySelector('.pp-surface');
  assert.ok(surface, 'page audio becomes a surface');
  assert.ok(!w.document.querySelector('.pp-controls'), 'no full control bar in the page');
  assert.ok(globals[0].querySelector('.pp-global-bar'), 'global bar present');
});

test('unified: surface play loads the episode into the global player', async () => {
  const w = bootUnified();
  const play = w.document.querySelector('.pp-surface .pp-btn-play');
  play.click();
  await new Promise((r) => setTimeout(r, 20));
  const gAudio = w.document.querySelector('.pp-global audio');
  assert.ok(gAudio.getAttribute('src'), 'global audio has a src');
  assert.equal(gAudio.dataset.title, 'Épisode 1', 'descriptor copied');
  assert.equal(w.document.querySelector('.pp-global').hidden, false, 'bar visible');
  const gTitle = w.document.querySelector('.pp-global-title');
  assert.equal(gTitle.textContent, 'Épisode 1');
  // Play event → pause UI on the bar and the (upgraded) full player.
  fire(gAudio, 'play');
  assert.equal(w.document.querySelector('.pp-global-play').getAttribute('aria-label'), 'Pause');
  assert.equal(w.document.querySelector('.pp-controls .pp-btn-play').getAttribute('aria-label'), 'Pause');
});

test('unified: navigation keeps playing; new episode page shows a banner and switches', async () => {
  const w = bootUnified();
  w.document.querySelector('.pp-surface .pp-btn-play').click();
  await new Promise((r) => setTimeout(r, 20));
  const gAudio = w.document.querySelector('.pp-global audio');
  const srcA = gAudio.getAttribute('src');
  assert.ok(srcA, 'episode A loaded');

  // Simulate docsify navigation to episode B's page.
  const section = w.document.querySelector('.markdown-section');
  section.innerHTML = '<audio controls preload="none" src="ep2.m3u8" data-title="Épisode 2"></audio>';
  w.$docsify.plugins.forEach((p) => p({ doneEach: (cb) => cb() }));

  assert.equal(gAudio.getAttribute('src'), srcA, 'playback source untouched by navigation');
  const banner = w.document.querySelector('.pp-now-playing');
  assert.equal(banner.hidden, false, 'now-playing banner shown');
  assert.equal(banner.querySelector('.pp-now-playing-title').textContent, 'Épisode 1');
  assert.ok(banner.querySelector('.pp-goto'), 'go-to-page link in the banner');
  // Surface of B: play switches the global source and upgrades the page.
  w.document.querySelector('.pp-surface .pp-btn-play').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(gAudio.getAttribute('src').indexOf('ep2.m3u8') !== -1, 'switched to episode B');
  assert.ok(w.document.querySelector('.pp-controls'), 'B page upgraded to the full player');
  assert.ok(!w.document.querySelector('.pp-now-playing'), 'banner gone after switch');
});

test('unified: resume chip loads the saved position into the global player', async () => {
  const w = bootUnified(UNIFIED_HTML, { localStorage: { 'podcast-pos:ep.m3u8': '120' } });
  const chip = w.document.querySelector('.pp-surface .pp-resume');
  assert.ok(chip, 'resume chip on the surface');
  assert.equal(chip.hidden, false);
  assert.match(chip.textContent, /Reprendre à 2:00/);
  chip.click();
  await new Promise((r) => setTimeout(r, 20));
  const gAudio = w.document.querySelector('.pp-global audio');
  assert.ok(gAudio.getAttribute('src'), 'episode loaded by the chip');
});

test('unified: same-source play toggles pause instead of reloading', async () => {
  const w = bootUnified();
  const play = w.document.querySelector('.pp-surface .pp-btn-play');
  play.click();
  await new Promise((r) => setTimeout(r, 20));
  const gAudio = w.document.querySelector('.pp-global audio');
  const src = gAudio.getAttribute('src');
  play.click(); // toggle → pause
  assert.equal(gAudio.getAttribute('src'), src, 'source not reloaded on toggle');
});

test('unified: the page of the loaded episode upgrades to the full player', async () => {
  const w = bootUnified();
  w.document.querySelector('.pp-surface .pp-btn-play').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(w.document.querySelector('.pp-controls'), 'full controls in the page');
  assert.ok(w.document.querySelector('.pp-panels'), 'chapters/transcript panels in the page');
  assert.ok(!w.document.querySelector('.pp-surface'), 'compact surface replaced');
  assert.ok(w.document.querySelector('.pp-global audio'), 'global audio still in body');
  assert.ok(w.document.querySelector('.pp-global-bar'), 'bottom bar still present');
});

test('unified: full-player chapter click seeks the global audio', async () => {
  const w = bootUnified();
  w.document.querySelector('.pp-surface .pp-btn-play').click();
  await new Promise((r) => setTimeout(r, 30)); // chapters fetch resolves
  const gAudio = w.document.querySelector('.pp-global audio');
  let t = 0;
  Object.defineProperty(gAudio, 'currentTime', {
    get: () => t, set: (v) => { t = v; }, configurable: true,
  });
  const links = w.document.querySelectorAll('.pp-chapter-link');
  assert.ok(links.length >= 2, 'chapter buttons present in the full player');
  links[1].click(); // chapter at 30 s
  assert.equal(t, 30, 'chapter click seeks the global audio');
});

test('unified: bound listeners do not accumulate across navigations', async () => {
  const w = bootUnified();
  w.document.querySelector('.pp-surface .pp-btn-play').click();
  await new Promise((r) => setTimeout(r, 20));
  const gAudio = w.document.querySelector('.pp-global audio');
  let net = 0;
  const origAdd = gAudio.addEventListener.bind(gAudio);
  const origRemove = gAudio.removeEventListener.bind(gAudio);
  gAudio.addEventListener = (t, f) => { net++; origAdd(t, f); };
  gAudio.removeEventListener = (t, f) => { net--; origRemove(t, f); };
  const snapshot = net;

  const section = w.document.querySelector('.markdown-section');
  for (let i = 0; i < 2; i++) {
    // Navigate to episode B (banner surface) …
    section.innerHTML = '<audio controls preload="none" src="ep2.m3u8" data-title="Épisode 2"></audio>';
    w.$docsify.plugins.forEach((p) => p({ doneEach: (cb) => cb() }));
    // … and back to episode A (full player rebinds after cleanup).
    section.innerHTML = '<audio controls preload="none" src="ep.m3u8" data-title="Épisode 1"></audio>';
    w.$docsify.plugins.forEach((p) => p({ doneEach: (cb) => cb() }));
  }
  assert.equal(net, snapshot, 'listener count returns to the baseline after cleanup');
});

test('unified: returning to the playing episode page shows the full player', async () => {
  const w = bootUnified();
  w.document.querySelector('.pp-surface .pp-btn-play').click();
  await new Promise((r) => setTimeout(r, 20));
  const section = w.document.querySelector('.markdown-section');
  section.innerHTML = '<audio controls preload="none" src="ep2.m3u8" data-title="Épisode 2"></audio>';
  w.$docsify.plugins.forEach((p) => p({ doneEach: (cb) => cb() }));
  assert.ok(w.document.querySelector('.pp-surface'), 'B shows a compact surface');
  section.innerHTML = '<audio controls preload="none" src="ep.m3u8" data-title="Épisode 1"></audio>';
  w.$docsify.plugins.forEach((p) => p({ doneEach: (cb) => cb() }));
  assert.ok(w.document.querySelector('.pp-controls'), 'back on A: full player bound');
  assert.ok(!w.document.querySelector('.pp-now-playing'), 'no banner on the playing page');
});

test('unified: no double player — native audio hidden inside the surface', () => {
  const w = bootUnified();
  const surface = w.document.querySelector('.pp-surface');
  assert.equal(surface.dataset.enhanced, '1', 'surface enhanced → native audio hidden by CSS');
  const audio = w.document.querySelector('.markdown-section audio');
  assert.ok(surface.contains(audio), 'native audio tucked inside the surface');
  assert.equal(w.document.querySelectorAll('.podcast-player').length, 1,
    'exactly one player UI on the page');
});

// ── unified: feed catalog (feed.json / RSS fallback) ────────────────

test('unified: feed.json enables next/prev in the bar and loads neighbors', async () => {
  const w = bootUnified(UNIFIED_HTML, { feed: 'json' });
  w.document.querySelector('.pp-surface .pp-btn-play').click(); // episode A
  await new Promise((r) => setTimeout(r, 40));
  const prev = w.document.querySelector('.pp-global-prev');
  const next = w.document.querySelector('.pp-global-next');
  assert.ok(prev && next, 'prev/next buttons in the bar');
  assert.equal(prev.disabled, true, 'no previous episode');
  assert.equal(next.disabled, false, 'next episode available');
  next.click();
  await new Promise((r) => setTimeout(r, 30));
  const gAudio = w.document.querySelector('.pp-global audio');
  assert.ok(gAudio.getAttribute('src').endsWith('/episodes/02/ep2.m3u8'),
    'next episode loaded from the catalog');
  assert.equal(gAudio.dataset.title, 'Épisode 2');
  // Now on B: prev enabled, next disabled.
  assert.equal(prev.disabled, false);
  assert.equal(next.disabled, true);
});

test('unified: prev/next stay disabled without a catalog', async () => {
  const w = bootUnified(UNIFIED_HTML); // no feed
  w.document.querySelector('.pp-surface .pp-btn-play').click();
  await new Promise((r) => setTimeout(r, 40));
  const prev = w.document.querySelector('.pp-global-prev');
  const next = w.document.querySelector('.pp-global-next');
  assert.equal(prev.disabled, true, 'prev disabled without feed');
  assert.equal(next.disabled, true, 'next disabled without feed');
});

test('unified: RSS fallback parses the catalog when feed.json is absent', async () => {
  const w = bootUnified(UNIFIED_HTML, { feed: 'rss' });
  w.document.querySelector('.pp-surface .pp-btn-play').click();
  await new Promise((r) => setTimeout(r, 40));
  const next = w.document.querySelector('.pp-global-next');
  assert.equal(next.disabled, false, 'RSS catalog parsed (next available)');
  next.click();
  await new Promise((r) => setTimeout(r, 30));
  const gAudio = w.document.querySelector('.pp-global audio');
  assert.ok(gAudio.getAttribute('src').endsWith('/episodes/02/ep2.m3u8'));
});

// ── P1: autoAdvance + timestamp sharing ─────────────────────────────

test('unified: ended auto-advances to the next episode and navigates', async () => {
  const w = bootUnified(UNIFIED_HTML, { feed: 'json' });
  w.document.querySelector('.pp-surface .pp-btn-play').click();
  await new Promise((r) => setTimeout(r, 40));
  const gAudio = w.document.querySelector('.pp-global audio');
  fire(gAudio, 'ended');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(gAudio.getAttribute('src').endsWith('/episodes/02/ep2.m3u8'),
    'next episode loaded on ended');
  assert.ok(w.location.hash.indexOf('/episodes/02/') !== -1,
    'navigated to the next episode page');
  const live = w.document.querySelector('.pp-global .pp-live');
  assert.match(live.textContent, /Prochain épisode : Épisode 2/);
});

test('unified: autoAdvance:false keeps the source on ended', async () => {
  const w = bootUnified(UNIFIED_HTML, {
    overrides: { podcastPlayer: { unified: true, autoAdvance: false } },
    feed: 'json',
  });
  w.document.querySelector('.pp-surface .pp-btn-play').click();
  await new Promise((r) => setTimeout(r, 40));
  const gAudio = w.document.querySelector('.pp-global audio');
  const src = gAudio.getAttribute('src');
  fire(gAudio, 'ended');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(gAudio.getAttribute('src'), src, 'source unchanged');
});

test('unified: ?t=MM:SS in the URL seeks the global player', async () => {
  const w = bootUnified(UNIFIED_HTML, { url: 'https://example.com/#/episodes/01/?t=12:34' });
  const gAudio = w.document.querySelector('.pp-global audio');
  let t = 0;
  Object.defineProperty(gAudio, 'currentTime', {
    get: () => t, set: (v) => { t = v; }, configurable: true,
  });
  w.document.querySelector('.pp-surface .pp-btn-play').click();
  await new Promise((r) => setTimeout(r, 20));
  fire(gAudio, 'loadedmetadata');
  assert.equal(t, 754, 'seeked to 12:34');
});

test('unified: share button copies a timestamped link', async () => {
  const w = bootUnified(UNIFIED_HTML);
  w.document.querySelector('.pp-surface .pp-btn-play').click();
  await new Promise((r) => setTimeout(r, 20));
  const gAudio = w.document.querySelector('.pp-global audio');
  Object.defineProperty(gAudio, 'currentTime', { value: 42, configurable: true });
  w.document.querySelector('.pp-global-share').click();
  await new Promise((r) => setTimeout(r, 40));
  const live = w.document.querySelector('.pp-global .pp-live');
  assert.match(live.textContent, /Lien copié/);
});
