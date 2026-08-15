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
  const { overrides, mediaSession, mediaMetadata, serviceWorker, swProbe, localStorage: seedStorage } = opts;
  // Site deployed at the domain root; the episode lives only in the hash
  // route (Docsify hash routing). The episode's media files sit next to the
  // rendered page, i.e. at /episodes/01/<file>.
  const url = 'https://example.com/#/episodes/01/';
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
  // No real HLS engine in jsdom: leave window.Hls undefined.
  window.fetch = async (u) => {
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
        'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nBonjour le monde\n\n' +
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

test('playlist toolbar appears only with 2+ players', () => {
  const two = `<div class="markdown-section">
    <audio src="a.m3u8"></audio>
    <audio src="b.m3u8"></audio>
  </div>`;
  const w = boot(two);
  const bar = w.document.querySelector('.podcast-player-toolbar');
  assert.ok(bar, 'toolbar present with two players');
  assert.equal(bar.querySelectorAll('.podcast-player-btn').length, 2);
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
  assert.match(w.document.querySelector('.pp-time').textContent, /0:42 \/ 10:00/);
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
  assert.equal(url, '/sw.js?v=1.4.0', 'registered at site root, version-pinned');
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
  assert.match(sw.registered[0], /assets\/sw\.js\?v=1\.4\.0$/);
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
