// ts2m4a unit tests: m3u8 parsing, TS demux, MP4 mux (validated against
// ffmpeg/ffprobe), payload identity, orchestration, URL mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts2m4a from '../ts2m4a.js';
import { buildFixture, makeFixtureFetch, ffmpegAvailable } from './_fixture.mjs';

const SN_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.005333,
hls/segment-000.ts
#EXTINF:10.005333,
hls/segment-001.ts
#EXT-X-ENDLIST`;

// ── parseM3u8 ─────────────────────────────────────────────────────────

test('parseM3u8: sn-style VOD playlist', () => {
  const pl = ts2m4a.parseM3u8(SN_PLAYLIST, 'https://example.test/pod/ep.m3u8');
  assert.equal(pl.type, 'vod');
  assert.equal(pl.encrypted, false);
  assert.equal(pl.segments.length, 2);
  assert.equal(pl.segments[0].url, 'https://example.test/pod/hls/segment-000.ts');
  assert.equal(pl.segments[0].duration, 10.005333);
  assert.equal(pl.variants.length, 0);
});

test('parseM3u8: live, encrypted, variants', () => {
  const text = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key"
#EXT-X-STREAM-INF:BANDWIDTH=128000
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=256000
high.m3u8`;
  const pl = ts2m4a.parseM3u8(text, 'https://example.test/master.m3u8');
  assert.equal(pl.encrypted, true);
  assert.equal(pl.type, 'live');
  assert.equal(pl.variants.length, 2);
  assert.equal(pl.variants[0].bandwidth, 128000);
  assert.equal(pl.variants[1].url, 'https://example.test/high.m3u8');
});

test('parseM3u8: relative and absolute segment URLs', () => {
  const pl = ts2m4a.parseM3u8(
    '#EXTM3U\n#EXTINF:1,\n../up/seg.ts\n#EXTINF:1,\nhttps://cdn.test/seg2.ts\n',
    'https://example.test/a/b/play.m3u8');
  assert.equal(pl.segments[0].url, 'https://example.test/a/up/seg.ts');
  assert.equal(pl.segments[1].url, 'https://cdn.test/seg2.ts');
});

// ── demux + mux (ffmpeg fixture) ──────────────────────────────────────

test('demuxTs + muxMp4 round-trip validates with ffprobe and is byte-identical', (t) => {
  const fx = buildFixture();
  if (!fx) return t.skip('ffmpeg not available');
  const pl = ts2m4a.parseM3u8(fx.m3u8, fx.playlistUrl);

  let state = {};
  const all = [];
  let sr = 0;
  let ch = 0;
  let prof = 0;
  fx.segments.forEach((seg) => {
    const d = ts2m4a.demuxTs(seg, state);
    state = d.state;
    all.push(...d.frames);
    if (!sr) { sr = d.sampleRate; ch = d.channels; prof = d.profile; }
  });

  assert.equal(sr, 48000, 'sample rate from ADTS headers');
  assert.equal(ch, 2, 'channels from ADTS headers');
  assert.equal(prof, 2, 'AAC-LC profile');
  assert.ok(all.length > 280 && all.length < 290,
    `frame count sane for 6s @48kHz (got ${all.length})`);

  const out = ts2m4a.muxMp4(all, { sampleRate: sr, channels: ch, profile: prof });
  const dir = mkdtempSync(path.join(tmpdir(), 'ts2m4a-out-'));
  const m4aPath = path.join(dir, 'out.m4a');
  writeFileSync(m4aPath, Buffer.from(out));

  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels,profile',
    '-of', 'json', m4aPath,
  ]).toString());
  assert.equal(probe.streams[0].codec_name, 'aac');
  assert.equal(probe.streams[0].sample_rate, '48000');
  assert.equal(probe.streams[0].channels, 2);
  const expected = (all.length * 1024) / 48000;
  assert.ok(Math.abs(parseFloat(probe.format.duration) - expected) < 0.05,
    `duration ${probe.format.duration} ≈ ${expected}`);

  // Payload identity: decode m4a to ADTS, re-split, compare frame payloads.
  const adtsPath = path.join(dir, 'out.adts');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', m4aPath, '-c', 'copy', '-f', 'adts', adtsPath]);
  const reframes = ts2m4a.splitAdts(new Uint8Array(readFileSync(adtsPath)));
  assert.equal(reframes.length, all.length, 'frame count survives round-trip');
  for (let i = 0; i < all.length; i++) {
    assert.equal(reframes[i].length, all[i].length, `frame ${i} size`);
    for (let j = 0; j < all[i].length; j++) {
      assert.equal(reframes[i][j], all[i][j], `frame ${i} byte ${j}`);
    }
  }
});

// ── tsToM4a orchestration ─────────────────────────────────────────────

test('tsToM4a end-to-end with fake fetch', async (t) => {
  const fx = buildFixture();
  if (!fx) return t.skip('ffmpeg not available');
  const out = await ts2m4a.tsToM4a(fx.playlistUrl, { fetchImpl: makeFixtureFetch(fx) });
  assert.ok(out.byteLength > 100000, `m4a size ${out.byteLength}`);
  assert.equal(String.fromCharCode(out[4], out[5], out[6], out[7]), 'ftyp');
  assert.equal(String.fromCharCode(out[8], out[9], out[10], out[11]), 'M4A ');
});

test('tsToM4a rejects encrypted playlists', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:1,\na.ts\n',
  });
  await assert.rejects(ts2m4a.tsToM4a('https://x.test/p.m3u8', { fetchImpl }), /encrypted/);
});

test('tsToM4a rejects live playlists', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => '#EXTM3U\n#EXTINF:1,\na.ts\n',
  });
  await assert.rejects(ts2m4a.tsToM4a('https://x.test/p.m3u8', { fetchImpl }), /live/);
});

test('tsToM4a picks the lowest-bandwidth variant', async (t) => {
  const fx = buildFixture();
  if (!fx) return t.skip('ffmpeg not available');
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    if (requested[requested.length - 1] === 'https://x.test/master.m3u8') {
      return {
        ok: true, status: 200,
        text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=999999\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n',
      };
    }
    return makeFixtureFetch(fx)(url);
  };
  const out = await ts2m4a.tsToM4a('https://x.test/master.m3u8', { fetchImpl });
  assert.ok(requested.includes('https://x.test/low.m3u8'), 'low variant selected');
  assert.ok(!requested.includes('https://x.test/high.m3u8'), 'high variant never fetched');
  assert.ok(out.byteLength > 100000);
});

// ── URL mapping ───────────────────────────────────────────────────────

test('toM3u8Url: local same-origin mapping', () => {
  const local = ts2m4a.toM3u8Url(new URL('https://site.test/pod/ep.m4a'));
  assert.equal(local, 'https://site.test/pod/ep.m3u8');

  const pages = ts2m4a.toM3u8Url(
    new URL('https://tim-montmorency.codeberg.page/sn/episodes/01/x.m4a'));
  assert.equal(pages,
    'https://tim-montmorency.codeberg.page/sn/episodes/01/x.m3u8');
});

test('toM3u8Url: /remote/ under a basePath scope (course site case)', () => {
  const url = 'https://tim-montmorency.codeberg.page/582705MO-2026-1/remote/codeberg.org/tim-montmorency/sn/episodes/01-bitkeeper-git/balado-s01e01-bitkeeper-git.m4a';
  const mapped = ts2m4a.toM3u8Url(new URL(url), {
    scope: 'https://tim-montmorency.codeberg.page/582705MO-2026-1/',
  });
  assert.equal(mapped,
    'https://tim-montmorency.codeberg.page/sn/episodes/01-bitkeeper-git/balado-s01e01-bitkeeper-git.m3u8');
});

test('toM3u8Url: non-codeberg /remote/ host → null', () => {
  const mapped = ts2m4a.toM3u8Url(
    new URL('https://site.test/remote/gitlab.com/foo/bar/x.m4a'),
    { scope: 'https://site.test/' });
  assert.equal(mapped, null);
});

