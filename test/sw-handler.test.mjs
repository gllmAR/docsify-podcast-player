// handleM4aRequest tests: routing, headers, mapping, caching, errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts2m4a from '../ts2m4a.js';
import { buildFixture, makeFixtureFetch } from './_fixture.mjs';

function makeEnv(overrides) {
  const cache = { stored: {} };
  const env = {
    fetchImpl: overrides && overrides.fetchImpl,
    cacheImpl: {
      match: (key) => Promise.resolve(cache.stored[key] || null),
      put: (key, resp) => {
        cache.stored[key] = resp;
        return Promise.resolve();
      },
    },
  };
  return { env, cache };
}

test('non-.m4a URLs pass through (null)', async () => {
  const { env } = makeEnv();
  const r = await ts2m4a.handleM4aRequest('https://site.test/pod/ep.m3u8', env);
  assert.equal(r, null);
});

test('successful synthesis: attachment headers + filename', async (t) => {
  const fx = buildFixture();
  if (!fx) return t.skip('ffmpeg not available');
  const { env, cache } = makeEnv();
  env.fetchImpl = async (url) => {
    // serve the fixture for both the playlist and its segments
    return makeFixtureFetch(fx)(url);
  };
  const resp = await ts2m4a.handleM4aRequest('https://site.test/pod/ep.m4a', env);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('Content-Type'), 'audio/mp4');
  assert.equal(resp.headers.get('Content-Disposition'),
    'attachment; filename="ep.m4a"');
  assert.ok(Number(resp.headers.get('Content-Length')) > 100000);
  const body = new Uint8Array(await resp.arrayBuffer());
  assert.equal(String.fromCharCode(body[4], body[5], body[6], body[7]), 'ftyp');
  assert.ok(cache.stored['https://site.test/pod/ep.m4a'], 'response cached');
});

test('cache hit skips synthesis', async (t) => {
  const fx = buildFixture();
  if (!fx) return t.skip('ffmpeg not available');
  let fetches = 0;
  const env = { fetchImpl: null, cacheImpl: null };
  const cache = { stored: {} };
  env.fetchImpl = async (url) => {
    fetches++;
    return makeFixtureFetch(fx)(url);
  };
  env.cacheImpl = {
    match: (key) => Promise.resolve(cache.stored[key] || null),
    put: (key, resp) => { cache.stored[key] = resp; return Promise.resolve(); },
  };
  await ts2m4a.handleM4aRequest('https://site.test/pod/ep.m4a', env);
  const first = fetches;
  const hit = await ts2m4a.handleM4aRequest('https://site.test/pod/ep.m4a', env);
  assert.equal(hit.status, 200);
  assert.equal(fetches, first, 'no network on cache hit');
});

test('synthesis failure → 503 text response (never a corrupt file)', async () => {
  const { env } = makeEnv();
  env.fetchImpl = async () => {
    throw new Error('segment fetch failed');
  };
  const resp = await ts2m4a.handleM4aRequest('https://site.test/pod/ep.m4a', env);
  assert.equal(resp.status, 503);
  assert.match(await resp.text(), /T\u00e9l\u00e9chargement indisponible/);
});

test('encrypted playlist → 503', async () => {
  const { env } = makeEnv();
  env.fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:1,\na.ts\n',
  });
  const resp = await ts2m4a.handleM4aRequest('https://site.test/pod/ep.m4a', env);
  assert.equal(resp.status, 503);
});
