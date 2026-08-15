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
 *   ts2m4a.parseVtt(text)           → [{ start, end, text }] (WebVTT cues)
 *   ts2m4a.parseFrontmatter(text)   → { key: value } (quoted/bare/boolean)
 *
 * The muxer embeds, when available: full iTunes ilst metadata (title, artist,
 * album, cover, encoder, track number, date, grouping, compilation, gapless),
 * a `tx3g` subtitle track from the episode .vtt, and a QuickTime chapter
 * track from the episode chapters JSON (bare array or Podcast Index v1.2.0).
 *
 * Unsupported (thrown as errors): encrypted playlists (#EXT-X-KEY), live
 * playlists (no #EXT-X-ENDLIST), non-AAC audio streams. Multi-variant
 * playlists pick the lowest-bandwidth variant (best audio-only choice).
 *
 * MIT — Guillaume Arseneault
 */
(function (root) {
  'use strict';

  var VERSION = '1.0.7';

  var SAMPLE_RATES = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000, 7350, 0, 0, 0,
  ];

  // ── Byte helpers ────────────────────────────────────────────────────

  function u16(n) { return [n >> 8 & 0xFF, n & 0xFF]; }
  function u24(n) { return [n >> 16 & 0xFF, n >> 8 & 0xFF, n & 0xFF]; }
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
    // Full UTF-8 for text payloads (charCodeAt low bytes would mangle
    // non-ASCII characters like em-dashes and accented letters).
    var enc = unescape(encodeURIComponent(s));
    var out = new Uint8Array(enc.length);
    for (var i = 0; i < enc.length; i++) out[i] = enc.charCodeAt(i);
    return out;
  }

  // Latin-1 bytes for box 4CCs (©nam etc. must stay single-byte).
  function str4(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
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
    out.set(str4(type), 4);
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

  // MPEG-4 descriptor length as a 4-byte varint (0x80 0x80 0x80 nn),
  // matching the style Apple's parsers see from ffmpeg.
  function descr4(tag, payload) {
    var len = payload.length;
    var head = new Uint8Array([tag, 0x80, 0x80, 0x80, len & 0x7F]);
    return bytes([head, payload]);
  }

  function esdsBox(asc, opts) {
    opts = opts || {};
    var dsi = descr4(0x05, asc);
    var slc = descr4(0x06, new Uint8Array([0x02]));
    var dcd = descr4(0x04, bytes([
      new Uint8Array([0x40, 0x15]),                      // MPEG-4 Audio, streamType 5
      new Uint8Array(u24(opts.bufferSizeDB || 0)),       // bufferSizeDB
      new Uint8Array(u32(opts.maxBitrate || 0)),
      new Uint8Array(u32(opts.avgBitrate || 0)),
      dsi,
    ]));
    var es = descr4(0x03, bytes([
      new Uint8Array([0, 1, 0]),                         // ES_ID 1, flags 0
      dcd, slc,
    ]));
    return fullbox('esds', 0, es);
  }

  function stsdBox(sampleRate, channels, asc, esdsOpts) {
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
      box('mp4a', bytes([mp4a, esdsBox(asc, esdsOpts)])),
    ]));
  }

  // Build the optional text tracks: a tx3g subtitle track (from VTT cues)
  // and a QuickTime chapter track (from the episode chapters JSON). The
  // audio trak gets a `tref` → `chap` reference when chapters are present.
  // Returns [{ kind: 'subtitle'|'chapter', handler, items: [{ text, durationMs }] }].
  function textTrackSpecs(subtitles, chapters, movieDurationMs) {
    var specs = [];
    if (Array.isArray(subtitles) && subtitles.length) {
      var sItems = [];
      subtitles.forEach(function (c) {
        var t = String(c.text || '').replace(/\s+/g, ' ').trim();
        var start = parseFloat(c.start);
        var end = parseFloat(c.end);
        if (!t || !isFinite(start) || !isFinite(end) || end <= start) return;
        sItems.push({ text: t, durationMs: Math.round((end - start) * 1000) });
      });
      if (sItems.length) specs.push({ kind: 'subtitle', handler: 'sbtl', items: sItems });
    }
    if (Array.isArray(chapters) && chapters.length) {
      var cItems = [];
      chapters.forEach(function (c, i) {
        var t = String(c.title || '').trim();
        var start = parseFloat(c.startTime);
        if (!t || !isFinite(start)) return;
        var end = (i + 1 < chapters.length)
          ? parseFloat(chapters[i + 1].startTime)
          : movieDurationMs / 1000;
        if (!isFinite(end)) end = movieDurationMs / 1000;
        var dur = Math.round((end - start) * 1000);
        if (dur <= 0) return;
        cItems.push({ text: t, durationMs: dur });
      });
      if (cItems.length) specs.push({ kind: 'chapter', handler: 'text', items: cItems });
    }
    return specs;
  }

  // One sample's bytes. Subtitle (tx3g) samples are raw UTF-8 text;
  // chapter (QuickTime `text`) samples carry a u16 length prefix + the
  // title (+ the `encd` box ffmpeg writes, tolerated by all readers).
  function textSampleBytes(item, kind) {
    var t = str(item.text);
    if (kind !== 'chapter') return t;
    var encd = new Uint8Array([
      0x00, 0x00, 0x00, 0x0C, 'e'.charCodeAt(0), 'n'.charCodeAt(0),
      'c'.charCodeAt(0), 'd'.charCodeAt(0), 0x00, 0x00, 0x01, 0x00,
    ]);
    return bytes([new Uint8Array(u16(t.length)), t, encd]);
  }

  // Legacy QuickTime `text` sample entry (as ffmpeg writes for chapters).
  function textSampleEntry() {
    var stub = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, // displayFlags
      0x00, 0x00,             // horizontal + vertical justification
      0x00, 0x00, 0x00, 0x00, // background color
      0x00, 0x00, 0x00, 0x00, // default text box top/left
      0x00, 0x00, 0x00, 0x00, // default text box bottom/right
      0x00, 0x00, 0x00, 0x00, // StyleRecord start/end char
      0x00, 0x01,             // fontID
      0x00, 0x00,             // fontStyleFlags + fontSize
      0x00, 0x00, 0x00, 0x00, // foreground color
      0x00, 0x00, 0x00, 0x0D, 'f', 't', 'a', 'b', // FontTableBox size + 'ftab'
      0x00, 0x01,             // entry count
      0x00, 0x01,             // font ID
      0x00,                   // font name length
    ]);
    return box('text', stub);
  }

  // One tx3g sample entry (stsd entry) with a minimal font table.
  function tx3gSampleEntry() {
    var fontTable = bytes([
      new Uint8Array([0, 0]),                              // displayFlags
      new Uint8Array([1]),                                 // font-count
      new Uint8Array([0, 1]),                              // font-ID 1
      bytes([str('sans-serif'), new Uint8Array([0])]),     // font-name + NUL
    ]);
    var entry = bytes([
      new Uint8Array([0, 0, 0, 0]),                        // displayFlags
      new Uint8Array([1]),                                 // h-justification: center
      new Uint8Array([0xFF]),                              // v-justification: -1 (bottom)
      new Uint8Array([0, 0, 0, 0]),                        // background-color-rgba
      new Uint8Array(8),                                   // default text box (4×u16)
      new Uint8Array(8),                                   // reserved
      box('ftab', fontTable),
    ]);
    return box('tx3g', entry);
  }

  // One text trak (`text` for chapters, `tx3g` for subtitles).
  // `startOffset` = offset of this track's samples inside mdat.
  // Track timescale 1000 (ms), like the movie.
  function buildTextTrack(trackId, kind, handler, items, startOffset) {
    var samples = items.map(function (it) { return textSampleBytes(it, kind); });
    var totalBytes = 0;
    samples.forEach(function (s) { totalBytes += s.length; });
    var totalMs = 0;
    items.forEach(function (it) { totalMs += Math.max(1, Math.round(it.durationMs)); });

    // stts: merge consecutive equal deltas
    var sttsEntries = [];
    items.forEach(function (it) {
      var d = Math.max(1, Math.round(it.durationMs));
      var last = sttsEntries[sttsEntries.length - 1];
      if (last && last.delta === d) last.count++;
      else sttsEntries.push({ count: 1, delta: d });
    });
    var sttsPayload = [verFlags(0, 0), new Uint8Array(u32(sttsEntries.length))];
    sttsEntries.forEach(function (e) {
      sttsPayload.push(new Uint8Array(u32(e.count)), new Uint8Array(u32(e.delta)));
    });

    var stszPayload = [verFlags(0, 0), new Uint8Array([0, 0, 0, 0]),
      new Uint8Array(u32(samples.length))];
    var sizes = new Uint8Array(4 * samples.length);
    var view = new DataView(sizes.buffer);
    samples.forEach(function (s, i) { view.setUint32(i * 4, s.length); });
    stszPayload.push(sizes);

    var stbl = box('stbl', bytes([
      box('stsd', bytes([
        verFlags(0, 0),
        new Uint8Array([0, 0, 0, 1]),                      // entry_count
        kind === 'chapter' ? textSampleEntry() : tx3gSampleEntry(),
      ])),
      box('stts', bytes(sttsPayload)),
      box('stsc', bytes([verFlags(0, 0), new Uint8Array([0, 0, 0, 1]),
        new Uint8Array([0, 0, 0, 1]), new Uint8Array(u32(samples.length)),
        new Uint8Array([0, 0, 0, 1])])),
      box('stsz', bytes(stszPayload)),
      box('stco', bytes([verFlags(0, 0), new Uint8Array([0, 0, 0, 1]),
        new Uint8Array(u32(startOffset))])),
    ]));

    var minf = box('minf', bytes([
      fullbox('nmhd', 0, new Uint8Array(0)),               // null media header
      box('dinf', fullbox('dref', 0, bytes([
        new Uint8Array([0, 0, 0, 1]),
        fullbox('url ', 1, new Uint8Array(0)),
      ]))),
      stbl,
    ]));

    var mdia = box('mdia', bytes([
      fullbox('mdhd', 0, bytes([
        new Uint8Array(8),
        new Uint8Array(u32(1000)),                         // timescale (ms)
        new Uint8Array(u32(totalMs)),
        new Uint8Array([0x55, 0xC4, 0, 0]),                // language 'und'
      ])),
      fullbox('hdlr', 0, bytes([
        new Uint8Array(4), str4(handler), new Uint8Array(12),
        str4(kind === 'chapter' ? 'ChapterHandler' : 'SubtitleHandler'),
        new Uint8Array(1),
      ])),
      minf,
    ]));

    return box('trak', bytes([
      fullbox('tkhd', 7, bytes([
        new Uint8Array(8),
        new Uint8Array(u32(trackId)),
        new Uint8Array(4),
        new Uint8Array(u32(totalMs)),
        new Uint8Array(8),
        new Uint8Array([0, 0]),                            // layer
        new Uint8Array([0, 0]),                            // alternate_group
        new Uint8Array([0, 0]),                            // volume 0 (text)
        new Uint8Array(2),                                 // reserved
        new Uint8Array([
          0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x00, 0x00, 0x00,
        ]),
        new Uint8Array(8),                                 // width + height
      ])),
      mdia,
    ]));
  }

  function buildMoov(frames, opts, mdatOffset) {
    var sampleRate = opts.sampleRate || 48000;
    var channels = opts.channels || 2;
    var profile = opts.profile || 2;
    var asc = makeAsc(profile, sampleRate, channels);
    var count = frames.length;
    var duration = count * 1024;                         // AAC frames: 1024 samples
    // Movie timescale 1000 (ms), like ffmpeg — Apple tools expect it.
    var movieDuration = Math.round(duration * 1000 / sampleRate);
    // esds stats from the actual frames
    var maxFrame = 0;
    var totalBytes = 0;
    for (var fi = 0; fi < count; fi++) {
      if (frames[fi].length > maxFrame) maxFrame = frames[fi].length;
      totalBytes += frames[fi].length;
    }
    var esdsOpts = {
      bufferSizeDB: maxFrame,
      maxBitrate: Math.round(maxFrame * 8 * sampleRate / 1024),
      avgBitrate: Math.round(totalBytes * 8 * sampleRate / duration),
    };

    var stbl = box('stbl', bytes([
      stsdBox(sampleRate, channels, asc, esdsOpts),
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
      // Audio roll sample group (gapless/priming signalling, as ffmpeg writes)
      box('sgpd', bytes([
        new Uint8Array([1, 0, 0, 0]),                    // version 1
        str4('roll'),
        new Uint8Array([0, 0, 0, 2]),                    // default_length
        new Uint8Array([0, 0, 0, 1]),                    // entry_count
        new Uint8Array([0xFF, 0xFF]),                    // roll_distance -1
      ])),
      box('sbgp', bytes([
        verFlags(0, 0),
        str4('roll'),
        new Uint8Array([0, 0, 0, 1]),                    // entry_count
        new Uint8Array(u32(count)),                      // sample_count (all)
        new Uint8Array([0, 0, 0, 1]),                    // group_description_index
      ])),
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
        new Uint8Array(4), str4('soun'), new Uint8Array(12),
        str4('SoundHandler'), new Uint8Array(1),          // name + NUL
      ])),
      minf,
    ]));

    // Text tracks (subtitle + chapter) and their sample offsets in mdat:
    // audio frames first, then subtitle samples, then chapter samples.
    var specs = textTrackSpecs(opts.subtitles, opts.chapters, movieDuration);
    var subTrak = null;
    var chapTrak = null;
    var subBytes = 0;
    var chapBytes = 0;
    var subOffset = mdatOffset + totalBytes;
    if (specs.length) {
      specs.forEach(function (spec) {
        var n = 0;
        spec.items.forEach(function (it) { n += textSampleBytes(it, spec.kind).length; });
        if (spec.kind === 'subtitle') {
          subBytes = n;
          subTrak = buildTextTrack(2, 'subtitle', 'sbtl', spec.items, subOffset);
        } else {
          chapBytes = n;
          chapTrak = buildTextTrack(3, 'chapter', 'text', spec.items, subOffset + subBytes);
        }
      });
    }

    var audioTrak = box('trak', bytes([
      fullbox('tkhd', 7, bytes([
        new Uint8Array(8),
        new Uint8Array([0, 0, 0, 1]),                    // track_ID
        new Uint8Array(4),
        new Uint8Array(u32(movieDuration)),
        new Uint8Array(8),
        new Uint8Array([0, 0]),                          // layer
        new Uint8Array([0, 0]),                          // alternate_group
        new Uint8Array([0x01, 0x00]),                    // volume 1.0
        new Uint8Array(2),                               // reserved
        new Uint8Array([
          0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x00, 0x00, 0x00,
        ]),
        new Uint8Array(8),                               // width + height
      ])),
      (chapTrak ? box('tref', box('chap', new Uint8Array(u32(3)))) :
        new Uint8Array(0)),
      box('edts', fullbox('elst', 0, bytes([
        new Uint8Array([0, 0, 0, 1]),                    // entry_count
        new Uint8Array(u32(movieDuration)),               // segment_duration (movie scale)
        new Uint8Array(u32(0)),                          // media_time (no priming offset)
        new Uint8Array([0x00, 0x01, 0x00, 0x00]),        // media_rate 1.0
      ]))),
      mdia,
    ]));

    var tracks = [audioTrak];
    if (subTrak) tracks.push(subTrak);
    if (chapTrak) tracks.push(chapTrak);
    var nextTrackId = 1 + (subTrak ? 1 : 0) + (chapTrak ? 1 : 0) + 1;

    return box('moov', bytes([
      fullbox('mvhd', 0, bytes([
        new Uint8Array(8),
        new Uint8Array(u32(1000)),                       // movie timescale (ms)
        new Uint8Array(u32(movieDuration)),
        new Uint8Array([0x00, 0x01, 0x00, 0x00]),        // rate 1.0
        new Uint8Array([0x01, 0x00]),                    // volume 1.0
        new Uint8Array(10),                              // reserved
        new Uint8Array([
          0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x00, 0x00, 0x00,
        ]),
        new Uint8Array(24),                              // pre_defined
        new Uint8Array(u32(nextTrackId)),
      ])),
      bytes(tracks),
      (opts.metadata ? buildMetaBox(opts.metadata) : new Uint8Array(0)),
    ]));
  }

  // iTunes-style metadata: moov > udta > meta > ilst (©nam/©ART/©alb/covr)
  function buildMetaBox(metadata) {
    function dataBox(flags, payload) {
      return box('data', bytes([
        verFlags(0, flags),
        new Uint8Array([0, 0, 0, 0]),            // locale
        payload,
      ]));
    }
    function item(name, flags, payload) {
      return box(name, dataBox(flags, payload));
    }
    var entries = [];
    if (metadata.title) {
      entries.push(item('\u00A9nam', 1, str(metadata.title)));
    }
    if (metadata.artist) {
      entries.push(item('\u00A9ART', 1, str(metadata.artist)));
      entries.push(item('aART', 1, str(metadata.artist)));
    }
    if (metadata.album) {
      entries.push(item('\u00A9alb', 1, str(metadata.album)));
    }
    if (metadata.cover && metadata.cover.length) {
      // flags 14 = PNG, 13 = JPEG (heuristic from the magic bytes)
      var coverFlags = (metadata.cover[0] === 0xFF && metadata.cover[1] === 0xD8) ? 13 : 14;
      entries.push(item('covr', coverFlags, metadata.cover));
    }
    // Full iTunes tag set (like ffmpeg's muxer): encoder, track number,
    // release date, grouping (show/series), compilation, gapless.
    entries.push(item('\u00A9too', 1, str('ts2m4a v' + VERSION)));
    if (metadata.trackNumber) {
      var tn = parseInt(metadata.trackNumber, 10);
      if (isFinite(tn) && tn > 0 && tn < 65536) {
        entries.push(item('trkn', 0, bytes([
          new Uint8Array([0, 0]), new Uint8Array(u16(tn)),
          new Uint8Array([0, 0]), new Uint8Array([0, 0]),
        ])));
      }
    }
    if (metadata.date) {
      entries.push(item('\u00A9day', 1, str(String(metadata.date))));
    }
    if (metadata.grouping) {
      entries.push(item('\u00A9grp', 1, str(metadata.grouping)));
    }
    if (metadata.compilation !== undefined) {
      entries.push(item('cpil', 0, new Uint8Array([metadata.compilation ? 1 : 0])));
    }
    if (metadata.gapless !== undefined) {
      entries.push(item('pgap', 0, new Uint8Array([metadata.gapless ? 1 : 0])));
    }
    var ilst = box('ilst', bytes(entries));
    var hdlr = fullbox('hdlr', 0, bytes([
      new Uint8Array(4),
      str('mdir'), str('appl'),
      new Uint8Array(12),
      new Uint8Array(0),
    ]));
    var meta = fullbox('meta', 0, bytes([hdlr, ilst]));
    return box('udta', meta);
  }

  function muxMp4(frames, opts) {
    opts = opts || {};
    var ftyp = box('ftyp', bytes([
      str('M4A '),
      new Uint8Array([0, 0, 0, 0]),                      // minor_version
      str('M4A '), str('isom'), str('iso2'),
    ]));
    // mdat payload: audio frames, then subtitle samples, then chapter samples
    // (offsets must match buildMoov's stco layout).
    var totalBytes = 0;
    for (var i = 0; i < frames.length; i++) totalBytes += frames[i].length;
    var count = frames.length;
    var sampleRate = opts.sampleRate || 48000;
    var movieDuration = Math.round(count * 1024 * 1000 / sampleRate);
    var specs = textTrackSpecs(opts.subtitles, opts.chapters, movieDuration);
    var mdatParts = [bytes(frames)];
    specs.forEach(function (spec) {
      spec.items.forEach(function (it) { mdatParts.push(textSampleBytes(it, spec.kind)); });
    });
    var mdat = box('mdat', bytes(mdatParts));
    // Pass 1: moov with placeholder stco to learn its length.
    var moovGuess = buildMoov(frames, opts, 0);
    var mdatOffset = ftyp.length + moovGuess.length + 8;
    // Pass 2: moov with the real mdat offset (same length).
    var moov = buildMoov(frames, opts, mdatOffset);
    return bytes([ftyp, moov, mdat]);
  }

  // ── Orchestration ───────────────────────────────────────────────────

  // Parse a simple YAML-ish frontmatter block (--- … ---). Handles quoted
  // strings, bare numbers, and true/false (e.g. `episode: 24`).
  function parseFrontmatter(text) {
    var m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) return {};
    var out = {};
    m[1].split(/\r?\n/).forEach(function (line) {
      var kv = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(?:"([^"]*)"|([^\s#][^#]*)?)\s*$/.exec(line);
      if (!kv) return;
      var key = kv[1];
      var raw = kv[2] !== undefined ? kv[2] : (kv[3] !== undefined ? kv[3].trim() : '');
      if (raw === 'true') out[key] = true;
      else if (raw === 'false') out[key] = false;
      else if (/^-?\d+$/.test(raw)) out[key] = parseInt(raw, 10);
      else out[key] = raw;
    });
    return out;
  }

  // Best-effort episode metadata: <dir>/README.md frontmatter + cover PNG,
  // plus the episode chapters JSON (bare array or Podcast Index v1.2.0
  // wrapper) and the WebVTT transcript for the tx3g subtitle track.
  function fetchMetadata(m3u8Url, fetchImpl) {
    var dir = m3u8Url.replace(/[^/]*$/, '');
    var stem = m3u8Url.replace(/\.m3u8(?:[?#].*)?$/i, '');
    var meta = {};
    function getText(url) {
      return fetchImpl(url).then(function (r) {
        if (!r.ok) throw new Error('fetch ' + r.status);
        return r.text();
      });
    }
    return getText(dir + 'README.md').then(function (text) {
      var fm = parseFrontmatter(text);
      meta.title = fm.title;
      meta.artist = fm.author;
      meta.album = fm.author;
      meta.trackNumber = fm.episode;
      meta.date = fm.date;
      meta.grouping = fm.grouping || (fm.season ? 'Saison ' + fm.season : '');
      meta.compilation = fm.compilation;
      meta.gapless = fm.gapless;
      return fetchImpl(stem + '-cover.png');
    }).then(function (r) {
      if (!r.ok) throw new Error('no cover');
      return r.arrayBuffer();
    }).then(function (buf) {
      meta.cover = new Uint8Array(buf);
      return meta;
    }).catch(function () {
      return meta;
    }).then(function (m) {
      // Chapters + subtitles are optional; never fail the download on them.
      return getText(stem + '.json').then(function (json) {
        var data;
        try { data = JSON.parse(json); } catch (_) { return m; }
        // Podcast Index v1.2.0 wrapper: { "version": "1.2.0", "chapters": […] }
        m.chapters = Array.isArray(data) ? data
          : (data && Array.isArray(data.chapters) ? data.chapters : []);
        return m;
      }).catch(function () { return m; });
    }).then(function (m) {
      return getText(stem + '.vtt').then(function (vtt) {
        m.subtitles = parseVtt(vtt);
        return m;
      }).catch(function () { return m; });
    });
  }

  // Parse WebVTT cue timing (00:00:01.000 --> 00:00:04.000) into cues.
  function parseVtt(text) {
    var cues = [];
    var lines = String(text || '').split(/\r?\n/);
    var cur = null;
    lines.forEach(function (line) {
      var m = /^(\d{2}:\d{2}:\d{2})[.,](\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2})[.,](\d{3})/.exec(line) ||
              /^(\d{2}:\d{2})[.,](\d{3})\s*-->\s*(\d{2}:\d{2})[.,](\d{3})/.exec(line);
      if (m) {
        if (cur && cur.text) cues.push(cur);
        var st = (m[1].length === 8 ? vttHMS(m[1]) : vttMS(m[1])) + (+m[2]) / 1000;
        var en = (m[3].length === 8 ? vttHMS(m[3]) : vttMS(m[3])) + (+m[4]) / 1000;
        cur = { start: st, end: en, text: '' };
        return;
      }
      if (cur && line && line.indexOf('-->') < 0 && line.indexOf('WEBVTT') < 0 &&
          !/^\d+$/.test(line.trim()) && !/^NOTE\b/.test(line)) {
        var t = line.replace(/<[^>]+>/g, '').replace(/^<v\s+[^>]*>/i, '').trim();
        if (t) cur.text += (cur.text ? '\n' : '') + t;
      }
    });
    if (cur && cur.text) cues.push(cur);
    return cues;
  }

  function vttHMS(s) {
    var p = s.split(':');
    return (+p[0]) * 3600 + (+p[1]) * 60 + (+p[2]);
  }

  function vttMS(s) {
    var p = s.split(':');
    return (+p[0]) * 60 + (+p[1]);
  }

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
        return fetchMetadata(playlistUrl, fetchImpl).then(function (metadata) {
          return muxMp4(allFrames, {
            sampleRate: sampleRate, channels: channels, profile: profile,
            metadata: metadata,
            chapters: metadata.chapters,
            subtitles: metadata.subtitles,
          });
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
    // /remote/ virtual routes may sit under the site's basePath (the SW
    // scope); match them scope-relative.
    var path = full;
    if (env && env.scope) {
      var sp = new URL(env.scope).pathname.replace(/\/+$/, '/');
      if (sp !== '/' && path.indexOf(sp) === 0) path = path.slice(sp.length - 1);
    }
    // /remote/{host}/{owner}/{repo}/… → codeberg pages convention
    var m = /^\/remote\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    if (m) {
      if (m[1] !== 'codeberg.org') return null;
      return 'https://' + m[2] + '.codeberg.page/' + m[3] +
             m[4].replace(/\.m4a$/i, '.m3u8');
    }
    // Local: the .m3u8 sits next to the .m4a on the same origin
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
    parseVtt: parseVtt,
    parseFrontmatter: parseFrontmatter,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ts2m4a;
  root.ts2m4a = ts2m4a;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
