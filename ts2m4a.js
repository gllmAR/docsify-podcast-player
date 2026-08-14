/*!
 * ts2m4a — MPEG-TS → M4A remuxer (AAC-LC only, no re-encoding).
 *
 * Converts an HLS audio stream (.m3u8 + MPEG-TS segments containing ADTS
 * AAC) into a single .m4a (ISO-BMFF MP4) file entirely in the browser,
 * service worker, or Node. The AAC payload is copied as-is: quality is
 * bit-identical to the source, and the remux is fast (muxing is a few
 * milliseconds per megabyte; fetching dominates).
 *
 * API (exposed as `window.ts2m4a` / `self.ts2m4a` / `module.exports`):
 *   ts2m4a.VERSION              — bump to invalidate service-worker caches
 *   ts2m4a.parseM3u8(text, baseUrl) → playlist descriptor
 *   ts2m4a.demuxTs(buffer, state?)  → { frames, carry, sampleRate, … }
 *   ts2m4a.splitAdts(bytes)         → array of raw AAC frames (payload only)
 *   ts2m4a.muxMp4(frames, opts)     → Uint8Array (ftyp + moov + mdat)
 *   ts2m4a.tsToM4a(m3u8Url, opts)   → Promise<Uint8Array>
 *   ts2m4a.handleM4aRequest(url, env) → Promise<Response|null> (SW route)
 *
 * Unsupported (thrown as errors): encrypted playlists (#EXT-X-KEY), live
 * playlists (no #EXT-X-ENDLIST), non-AAC audio streams. Multi-variant
 * playlists pick the lowest-bandwidth variant (best audio-only choice).
 *
 * MIT — Guillaume Arseneault
 */
(function (root) {
  'use strict';

  var VERSION = '1.0.1';

  var SAMPLE_RATES = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000, 7350, 0, 0, 0,
  ];

  // ── Byte helpers ────────────────────────────────────────────────────

  function u16(n) { return [n >> 8 & 0xFF, n & 0xFF]; }
  function u32(n) {
    return [n >>> 24 & 0xFF, n >>> 16 & 0xFF, n >>> 8 & 0xFF, n & 0xFF];
  }

  function bytes(arrays) {
    var total = 0;
    for (var i = 0; i < arrays.length; i++) total += arrays[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < arrays.length; j++) {
      out.set(arrays[j], off);
      off += arrays[j].length;
    }
    return out;
  }

  function str(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // MPEG-4 descriptor: tag + 7-bit varint length + payload
  function descr(tag, payload) {
    var len = payload.length;
    var lenBytes = [];
    do {
      var b = len & 0x7F;
      len >>>= 7;
      if (len) b |= 0x80;
      lenBytes.unshift(b);
    } while (len);
    return bytes([new Uint8Array([tag]), new Uint8Array(lenBytes), payload]);
  }

  function box(type, payload) {
    var p = payload || new Uint8Array(0);
    var out = new Uint8Array(8 + p.length);
    var view = new DataView(out.buffer);
    view.setUint32(0, out.length);
    out.set(str(type), 4);
    out.set(p, 8);
    return out;
  }

  function verFlags(version, flags) {
    return new Uint8Array([version, flags >> 16 & 0xFF, flags >> 8 & 0xFF, flags & 0xFF]);
  }

  function fullbox(type, flags, payload) {
    return box(type, bytes([verFlags(0, flags), payload || new Uint8Array(0)]));
  }

  function resolveUrl(base, ref) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref;
    var m;
    if (ref.charAt(0) === '/') {
      m = /^(https?:\/\/[^/]+)/.exec(base);
      return (m ? m[1] : '') + ref;
    }
    var parts = base.split('/').slice(0, -1);
    ref.split('/').forEach(function (seg) {
      if (seg === '..') parts.pop();
      else if (seg !== '.' && seg !== '') parts.push(seg);
    });
    return parts.join('/');
  }

  // ── M3U8 ────────────────────────────────────────────────────────────

  function parseM3u8(text, baseUrl) {
    var lines = text.split(/\r?\n/);
    var segments = [];
    var variants = [];
    var encrypted = false;
    var type = 'live';
    var lastDur = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.charAt(0) !== '#') {
        segments.push({ url: resolveUrl(baseUrl, line), duration: lastDur });
        continue;
      }
      if (line.indexOf('#EXTINF:') === 0) {
        var m = /#EXTINF:\s*([\d.]+)/.exec(line);
        lastDur = m ? parseFloat(m[1]) : 0;
      } else if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
        var bw = /BANDWIDTH=(\d+)/.exec(line);
        for (var k = i + 1; k < lines.length; k++) {
          var vline = lines[k].trim();
          if (!vline || vline.charAt(0) === '#') continue;
          variants.push({
            bandwidth: bw ? parseInt(bw[1], 10) : 0,
            url: resolveUrl(baseUrl, vline),
          });
          i = k;
          break;
        }
      } else if (line.indexOf('#EXT-X-KEY:') === 0) {
        encrypted = true;
      } else if (line.indexOf('#EXT-X-ENDLIST') === 0) {
        type = 'vod';
      }
    }
    return { type: type, encrypted: encrypted, variants: variants, segments: segments };
  }

  // ── MPEG-TS demux ───────────────────────────────────────────────────

  // Parse one MPEG-TS buffer. `state` carries PID knowledge + ADTS carry
  // across segments (PIDs and AAC frames may span segment boundaries).
  function demuxTs(buf, state) {
    state = state || {};
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var pidPmt = state.pidPmt || -1;
    var pidAudio = state.pidAudio || -1;
    var chunks = [];   // PES payload chunks for THIS buffer only
    var i = 0;
    var len = u8.length;

    for (; i + 188 <= len; i += 188) {
      if (u8[i] !== 0x47) {
        while (i + 188 < len && u8[i] !== 0x47) i++;   // resync
        if (i + 188 > len) break;
      }
      var pid = ((u8[i + 1] & 0x1F) << 8) | u8[i + 2];
      var pusi = (u8[i + 1] & 0x40) !== 0;
      var afc = (u8[i + 3] >> 4) & 0x03;
      var off = i + 4;
      if (afc === 0) continue;                          // reserved
      if (afc & 0x02) off += 1 + u8[off];               // adaptation field
      if (!(afc & 0x01)) continue;                      // payload only
      if (off >= i + 188) continue;

      if (pid === 0 && pusi) {
        // PAT → program → PMT PID
        var ps = off + 1 + u8[off];                     // pointer_field
        if (ps + 12 > i + 188) continue;
        if (u8[ps] !== 0x00) continue;                  // table_id PAT
        pidPmt = ((u8[ps + 10] & 0x1F) << 8) | u8[ps + 11];
        state.pidPmt = pidPmt;
        continue;
      }
      if (pid === pidPmt && pidPmt >= 0 && pusi) {
        // PMT → audio PID
        var s2 = off + 1 + u8[off];
        if (s2 + 16 > i + 188) continue;
        if (u8[s2] !== 0x02) continue;                  // table_id PMT
        var secLen = ((u8[s2 + 1] & 0x0F) << 8) | u8[s2 + 2];
        var pil = ((u8[s2 + 10] & 0x0F) << 8) | u8[s2 + 11];
        var pos = s2 + 12 + pil;
        var end = s2 + 3 + secLen - 4;                  // minus CRC32
        while (pos + 5 <= end) {
          var st = u8[pos];
          var esPid = ((u8[pos + 1] & 0x1F) << 8) | u8[pos + 2];
          if (st === 0x0F) { pidAudio = esPid; state.pidAudio = esPid; }
          pos += 5 + (((u8[pos + 3] & 0x0F) << 8) | u8[pos + 4]);
        }
        continue;
      }
      if (pid === pidAudio && pidAudio >= 0) {
        var start = off;
        if (pusi && u8[off] === 0 && u8[off + 1] === 0 && u8[off + 2] === 1) {
          var hlen = u8[off + 8];                       // PES header length
          start = off + 9 + hlen;
        }
        if (start < i + 188) chunks.push(u8.subarray(start, i + 188));
      }
    }

    return splitChunksToFrames(chunks, state);
  }

  // ADTS parsing over PES chunks, with carry between calls (a frame may
  // span the PES/segment boundary).
  function splitChunksToFrames(chunks, state) {
    var frames = [];
    var sampleRate = 0;
    var channels = 0;
    var profile = 0;
    var carry = state.carry || null;

    chunks.forEach(function (ch) {
      var data = carry ? bytes([carry, ch]) : ch;
      carry = null;
      var i = 0;
      while (i + 7 <= data.length) {
        if (data[i] !== 0xFF || (data[i + 1] & 0xF6) !== 0xF0) { i++; continue; }
        var frameLen = ((data[i + 3] & 0x03) << 11) | (data[i + 4] << 3) |
                       ((data[i + 5] >> 5) & 0x07);
        if (frameLen < 7 || i + frameLen > data.length) break;
        var srIdx = (data[i + 2] >> 2) & 0x0F;
        var chCfg = ((data[i + 2] & 0x01) << 2) | ((data[i + 3] >> 6) & 0x03);
        var profIdx = (data[i + 2] >> 6) & 0x03;
        var hdrLen = (data[i + 1] & 0x01) ? 7 : 9;      // protection_absent
        frames.push(data.subarray(i + hdrLen, i + frameLen));
        sampleRate = SAMPLE_RATES[srIdx] || 0;
        channels = chCfg;
        profile = profIdx + 1;
        i += frameLen;
      }
      if (i < data.length) carry = data.subarray(i);
    });

    state.carry = carry;
    return { frames: frames, carry: carry, sampleRate: sampleRate,
             channels: channels, profile: profile, state: state };
  }

  // Split an ADTS stream (as found in a .aac file) into raw AAC frames.
  function splitAdts(u8) {
    var frames = [];
    var i = 0;
    while (i + 7 <= u8.length) {
      if (u8[i] !== 0xFF || (u8[i + 1] & 0xF6) !== 0xF0) { i++; continue; }
      var frameLen = ((u8[i + 3] & 0x03) << 11) | (u8[i + 4] << 3) |
                     ((u8[i + 5] >> 5) & 0x07);
      if (frameLen < 7 || i + frameLen > u8.length) break;
      var hdrLen = (u8[i + 1] & 0x01) ? 7 : 9;
      frames.push(u8.subarray(i + hdrLen, i + frameLen));
      i += frameLen;
    }
    return frames;
  }

  // ── MP4 mux ─────────────────────────────────────────────────────────

  function makeAsc(profile, sampleRate, channels) {
    var srIdx = SAMPLE_RATES.indexOf(sampleRate);
    if (srIdx < 0) srIdx = 3;                            // 48000 fallback
    var objType = Math.max(1, Math.min(4, profile));     // audioObjectType
    return new Uint8Array([
      (objType << 3) | (srIdx >> 1),
      ((srIdx & 0x01) << 7) | (channels << 3),
    ]);
  }

  function esdsBox(asc) {
    var dsi = descr(0x05, asc);
    var slc = descr(0x06, new Uint8Array([0x02]));
    var dcd = descr(0x04, bytes([
      new Uint8Array([0x40, 0x15, 0, 0, 0]),             // MPEG-4 Audio, streamType 5
      new Uint8Array(u32(0)),                            // maxBitrate
      new Uint8Array(u32(0)),                            // avgBitrate
      dsi,
    ]));
    var es = descr(0x03, bytes([
      new Uint8Array([0, 0, 0]),                         // ES_ID 0, flags 0
      dcd, slc,
    ]));
    return fullbox('esds', 0, es);
  }

  function stsdBox(sampleRate, channels, asc) {
    var mp4a = bytes([
      new Uint8Array(6),                                 // reserved
      new Uint8Array([0, 1]),                            // data_reference_index
      new Uint8Array(8),                                 // reserved
      new Uint8Array(u16(channels)),
      new Uint8Array([0, 16]),                           // sample size (16 bits)
      new Uint8Array(4),                                 // pre_defined + reserved
      new Uint8Array(u32(sampleRate << 16)),             // 16.16 fixed point
    ]);
    return box('stsd', bytes([
      verFlags(0, 0),
      new Uint8Array([0, 0, 0, 1]),                      // entry_count
      box('mp4a', bytes([mp4a, esdsBox(asc)])),
    ]));
  }

  function buildMoov(frames, opts, mdatOffset) {
    var sampleRate = opts.sampleRate || 48000;
    var channels = opts.channels || 2;
    var profile = opts.profile || 2;
    var asc = makeAsc(profile, sampleRate, channels);
    var count = frames.length;
    var duration = count * 1024;                         // AAC frames: 1024 samples

    var stbl = box('stbl', bytes([
      stsdBox(sampleRate, channels, asc),
      box('stts', bytes([verFlags(0, 0), new Uint8Array([0, 0, 0, 1]),
        new Uint8Array(u32(count)), new Uint8Array(u32(1024))])),
      box('stsc', bytes([verFlags(0, 0), new Uint8Array([0, 0, 0, 1]),
        new Uint8Array([0, 0, 0, 1]), new Uint8Array(u32(count)),
        new Uint8Array([0, 0, 0, 1])])),
      (function () {
        var sizes = new Uint8Array(4 * count);
        var view = new DataView(sizes.buffer);
        for (var i = 0; i < count; i++) view.setUint32(i * 4, frames[i].length);
        return box('stsz', bytes([verFlags(0, 0), new Uint8Array([0, 0, 0, 0]),
          new Uint8Array(u32(count)), sizes]));
      })(),
      box('stco', bytes([verFlags(0, 0), new Uint8Array([0, 0, 0, 1]),
        new Uint8Array(u32(mdatOffset))])),
    ]));

    var minf = box('minf', bytes([
      fullbox('smhd', 0, new Uint8Array(4)),             // balance + reserved
      box('dinf', fullbox('dref', 0, bytes([
        new Uint8Array([0, 0, 0, 1]),
        fullbox('url ', 1, new Uint8Array(0)),           // self-contained
      ]))),
      stbl,
    ]));

    var mdia = box('mdia', bytes([
      fullbox('mdhd', 0, bytes([
        new Uint8Array(8),
        new Uint8Array(u32(sampleRate)),
        new Uint8Array(u32(duration)),
        new Uint8Array([0x55, 0xC4, 0, 0]),              // language 'und'
      ])),
      fullbox('hdlr', 0, bytes([
        new Uint8Array(4), str('soun'), new Uint8Array(12), new Uint8Array(0),
      ])),
      minf,
    ]));

    var trak = box('trak', bytes([
      fullbox('tkhd', 7, bytes([
        new Uint8Array(8),
        new Uint8Array([0, 0, 0, 1]),                    // track_ID
        new Uint8Array(4),
        new Uint8Array(u32(duration)),
        new Uint8Array(8),
        new Uint8Array([0, 0]),                          // layer
        new Uint8Array([0, 0]),                          // alternate_group
        new Uint8Array([0x01, 0x00]),                    // volume 1.0
        new Uint8Array(2),                               // reserved
        new Uint8Array([
          0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
          0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x00, 0x00, 0x00,
        ]),
        new Uint8Array(8),                               // width + height
      ])),
      mdia,
    ]));

    return box('moov', bytes([
      fullbox('mvhd', 0, bytes([
        new Uint8Array(8),
        new Uint8Array(u32(sampleRate)),
        new Uint8Array(u32(duration)),
        new Uint8Array([0x00, 0x01, 0x00, 0x00]),        // rate 1.0
        new Uint8Array([0x01, 0x00]),                    // volume 1.0
        new Uint8Array(10),                              // reserved
        new Uint8Array([
          0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
          0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x00, 0x00, 0x00,
        ]),
        new Uint8Array(24),                              // pre_defined
        new Uint8Array([0, 0, 0, 2]),                    // next_track_ID
      ])),
      trak,
    ]));
  }

  function muxMp4(frames, opts) {
    opts = opts || {};
    var ftyp = box('ftyp', bytes([
      str('M4A '),
      new Uint8Array([0, 0, 0, 0]),                      // minor_version
      str('M4A '), str('isom'), str('iso2'),
    ]));
    var mdat = box('mdat', bytes(frames));
    // Pass 1: moov with placeholder stco to learn its length.
    var moovGuess = buildMoov(frames, opts, 0);
    var mdatOffset = ftyp.length + moovGuess.length + 8;
    // Pass 2: moov with the real mdat offset (same length).
    var moov = buildMoov(frames, opts, mdatOffset);
    return bytes([ftyp, moov, mdat]);
  }

  // ── Orchestration ───────────────────────────────────────────────────

  function tsToM4a(m3u8Url, opts) {
    opts = opts || {};
    var fetchImpl = opts.fetchImpl || fetch;
    var poolSize = opts.poolSize || 6;
    var onProgress = opts.onProgress || function () {};

    return fetchImpl(m3u8Url).then(function (r) {
      if (!r.ok) throw new Error('playlist ' + r.status);
      return r.text();
    }).then(function (text) {
      var pl = parseM3u8(text, m3u8Url);
      if (pl.encrypted) throw new Error('encrypted playlists are not supported');

      var playlistUrl = m3u8Url;
      if (!pl.segments.length) {
        if (!pl.variants.length) throw new Error('empty playlist');
        var best = pl.variants.reduce(function (a, b) {
          return b.bandwidth < a.bandwidth ? b : a;
        });
        playlistUrl = best.url;                          // pick lowest-bandwidth variant
      }
      if (playlistUrl !== m3u8Url) return tsToM4a(playlistUrl, opts);
      if (pl.type !== 'vod') throw new Error('live playlists are not supported');

      return fetchAllSegments(pl.segments, fetchImpl, poolSize).then(function (buffers) {
        var state = {};
        var allFrames = [];
        var sampleRate = 0;
        var channels = 0;
        var profile = 0;
        buffers.forEach(function (buf, idx) {
          var d = demuxTs(buf, state);
          state = d.state;
          allFrames.push.apply(allFrames, d.frames);
          if (!sampleRate) sampleRate = d.sampleRate;
          if (!channels) channels = d.channels;
          if (!profile) profile = d.profile;
          onProgress(idx + 1, buffers.length);
        });
        if (!allFrames.length) throw new Error('no audio frames found');
        if (!sampleRate) throw new Error('could not determine sample rate');
        return muxMp4(allFrames, {
          sampleRate: sampleRate, channels: channels, profile: profile,
        });
      });
    });
  }

  function fetchAllSegments(segments, fetchImpl, poolSize) {
    var results = new Array(segments.length);
    var next = 0;
    function worker() {
      if (next >= segments.length) return Promise.resolve();
      var idx = next++;
      return fetchImpl(segments[idx].url).then(function (r) {
        if (!r.ok) throw new Error('segment ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        results[idx] = buf;
        return worker();
      });
    }
    var workers = [];
    var n = Math.min(poolSize, segments.length);
    for (var i = 0; i < n; i++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }

  // ── Service-worker route handler (pure, unit-testable) ──────────────

  // env: { fetchImpl, cacheImpl: { match, put }, originFor(host, owner, repo) }
  // Returns Promise<Response> — or null when the URL is not ours.
  function handleM4aRequest(requestUrl, env) {
    env = env || {};
    var url = typeof requestUrl === 'string' ? new URL(requestUrl) : requestUrl;
    var path = url.pathname;
    if (!/\.m4a$/i.test(path)) return Promise.resolve(null);

    var m3u8Url = toM3u8Url(url, env);
    if (!m3u8Url) return Promise.resolve(null);

    var cacheKey = url.href;
    var fetchImpl = env.fetchImpl || fetch;

    function build() {
      return tsToM4a(m3u8Url, { fetchImpl: fetchImpl }).then(function (buf) {
        var stem = path.split('/').pop().replace(/\.m4a$/i, '');
        var resp = new Response(buf, {
          status: 200,
          headers: {
            'Content-Type': 'audio/mp4',
            'Content-Disposition': 'attachment; filename="' + stem + '.m4a"',
            'Content-Length': String(buf.byteLength),
          },
        });
        if (env.cacheImpl && env.cacheImpl.put) {
          env.cacheImpl.put(cacheKey, resp.clone()).catch(function () {});
        }
        return resp;
      }).catch(function (err) {
        return new Response('T\u00e9l\u00e9chargement indisponible: ' + err.message, {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      });
    }

    if (env.cacheImpl && env.cacheImpl.match) {
      return env.cacheImpl.match(cacheKey).then(function (hit) {
        return hit || build();
      });
    }
    return build();
  }

  function toM3u8Url(url, env) {
    var full = url.pathname;
    // Virtual .m4a routes may sit under the site's basePath (e.g. a SW
    // scoped to /my-site/ answering /my-site/remote/...). Match the
    // /remote/ form against the scope-relative path.
    var path = full;
    if (env && env.scope) {
      var sp = new URL(env.scope).pathname.replace(/\/+$/, '/');
      if (sp !== '/' && path.indexOf(sp) === 0) path = path.slice(sp.length - 1);
    }
    // /remote/{host}/{owner}/{repo}/… → codeberg pages convention
    var m = /^\/remote\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    if (m) {
      if (m[1] !== 'codeberg.org') return null;
      if (env && env.originFor) {
        return env.originFor(m[2], m[3]) + m[4].replace(/\.m4a$/i, '.m3u8');
      }
      return 'https://' + m[2] + '.codeberg.page/' + m[3] + m[4].replace(/\.m4a$/i, '.m3u8');
    }
    // Local: .m3u8 sits next to the .m4a (full path, scope included)
    return url.origin + full.replace(/\.m4a$/i, '.m3u8');
  }

  var ts2m4a = {
    VERSION: VERSION,
    parseM3u8: parseM3u8,
    demuxTs: demuxTs,
    splitAdts: splitAdts,
    muxMp4: muxMp4,
    tsToM4a: tsToM4a,
    handleM4aRequest: handleM4aRequest,
    toM3u8Url: toM3u8Url,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ts2m4a;
  root.ts2m4a = ts2m4a;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
