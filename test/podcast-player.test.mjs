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
  const { overrides, mediaSession, mediaMetadata } = opts;
  // Site deployed at the domain root; the episode lives only in the hash
  // route (Docsify hash routing). The episode's media files sit next to the
  // rendered page, i.e. at /episodes/01/<file>.
  const url = 'https://example.com/#/episodes/01/';
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  global.window = window;
  global.document = window.document;

  window.$docsify = Object.assign({ plugins: [] }, overrides || {});
  if (mediaSession) {
    Object.defineProperty(window.navigator, 'mediaSession',
      { value: mediaSession, configurable: true });
  }
  if (mediaMetadata) window.MediaMetadata = mediaMetadata;
  // No real HLS engine in jsdom: leave window.Hls undefined.
  window.fetch = async (u) => {
    if (String(u).endsWith('.json')) {
      return { ok: true, json: async () => ([
        { startTime: 0, title: 'Générique' },
        { startTime: 30, title: 'Introduction' },
      ]) };
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

