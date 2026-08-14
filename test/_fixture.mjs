// Shared fixtures for the ts2m4a / sw-handler / player tests.
// Generates a small real MPEG-TS fixture with ffmpeg (skipped when ffmpeg
// is unavailable) and provides fake fetch implementations over it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function ffmpegAvailable() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let cached = null;

// Returns { m3u8, playlistUrl, segments: Uint8Array[] } or null.
export function buildFixture() {
  if (cached) return cached;
  if (!ffmpegAvailable()) return null;
  const dir = mkdtempSync(path.join(tmpdir(), 'ts2m4a-'));
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
    '-f', 'segment', '-segment_time', '2', '-segment_format', 'mpegts',
    '-segment_list', path.join(dir, 'playlist.m3u8'),
    path.join(dir, 'seg-%02d.ts'),
  ]);
  const m3u8 = readFileSync(path.join(dir, 'playlist.m3u8'), 'utf8');
  const segments = [...m3u8.matchAll(/^([^\n#][^\n]*)$/gm)]
    .map((m) => new Uint8Array(readFileSync(path.join(dir, m[1]))));
  cached = { m3u8, playlistUrl: 'https://fixture.test/pod/playlist.m3u8', segments };
  return cached;
}

// Fake fetch that serves the fixture over HTTP-like URLs: any .m3u8 URL
// returns the playlist text, any other URL returns TS segment bytes.
export function makeFixtureFetch(fx) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith('.m3u8')) {
      return {
        ok: true, status: 200,
        text: async () => fx.m3u8,
        arrayBuffer: async () => new Uint8Array(0).buffer,
      };
    }
    const seg = fx.segments[0];
    return {
      ok: true, status: 200,
      text: async () => '',
      arrayBuffer: async () => seg.buffer.slice(seg.byteOffset, seg.byteOffset + seg.byteLength),
    };
  };
}
