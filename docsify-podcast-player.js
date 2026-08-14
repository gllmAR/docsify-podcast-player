/*!
 * docsify-podcast-player
 * Audio / podcast player plugin for Docsify hash-routing SPAs.
 *
 * Features:
 *   - Fixes relative src/href paths for <audio>, <video>, <source>, <track>
 *     and media links (Docsify resolves them against index.html, not the page)
 *   - HLS (.m3u8) playback: native on Safari, hls.js everywhere else
 *     (with loading spinner, error recovery)
 *   - Cover art (auto-detected <stem>-cover.png or via data-cover)
 *   - Clickable chapter list with active-chapter highlighting (timeupdate)
 *   - Transcript panel from WebVTT subtitles (clickable cues, error+retry)
 *   - Playlist toolbar with previous / next track
 *   - Playback position persistence (sessionStorage per audio URL)
 *   - Keyboard shortcuts: Space play/pause, arrows seek, M mute, up/down volume
 *   - Download button (.m3u8 only): links to the real .m4a URL — served by
 *     the site's service worker (ts2m4a remux) when active, otherwise a
 *     main-thread TS→M4A remux + blob download. Right-click → copy link
 *     works natively (real URL).
 *
 * Usage:
 *   window.$docsify.podcastPlayer = {
 *     hlsCdn:           'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
 *     showCover:        true,
 *     showChapters:     true,
 *     showTranscript:   true,
 *     showDownload:     true,
 *     downloadLabel:    '⬇ Télécharger',
 *     downloadBusyLabel:'⏳ Préparation…',
 *     downloadErrorLabel: 'Téléchargement indisponible.',
 *     ts2m4aCdn:        'https://gllmar.github.io/docsify-podcast-player/ts2m4a.js',
 *     coverPattern:     '{stem}-cover.png',
 *     chapterLabel:     'Chapitres',
 *     transcriptLabel:  'Transcript',
 *     mediaExtensions:  null,
 *     artist:           'Podcast',
 *     album:            'Podcast',
 *     prevLabel:        '⏮',
 *     nextLabel:        '⏭',
 *     prevTitle:        'Previous track',
 *     nextTitle:        'Next track',
 *     errorLabel:       'Error',
 *     retryLabel:       'Retry',
 *     transcriptError:  'Transcript unavailable.',
 *     seekSeconds:      10,
 *     volumeStep:       0.1,
 *   };
 *   <script src="vendor/docsify-podcast-player/docsify-podcast-player.js"></script>
 */
(function () {
  'use strict';

  var DEFAULTS = {
    hlsCdn: 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
    showCover: true,
    showChapters: true,
    showTranscript: true,
    showDownload: true,
    downloadLabel: '⬇ Télécharger',
    downloadBusyLabel: '⏳ Préparation…',
    downloadErrorLabel: 'Téléchargement indisponible.',
    ts2m4aCdn: 'https://gllmar.github.io/docsify-podcast-player/ts2m4a.js',
    // Optional: fn(resolvedSrc, audioEl) → download URL. Lets a site serve
    // the .m4a through its own service-worker route (e.g. remote-repo
    // pages whose media points at codeberg API URLs). Default: same URL
    // with .m3u8 → .m4a.
    downloadUrl: null,
    coverPattern: '{stem}-cover.png',
    chapterLabel: 'Chapitres',
    transcriptLabel: 'Transcript',
    mediaExtensions: [
      'm3u8', 'm4a', 'mp3', 'wav', 'ogg', 'flac', 'opus', 'aiff', 'webm',
      'mp4', 'mov', 'vtt', 'json', 'xml', 'csv', 'pdf', 'png', 'jpg',
      'jpeg', 'gif', 'webp', 'svg', 'blend', 'stl', 'glb', 'gltf',
    ],
    artist: 'Podcast',
    album: 'Podcast',
    prevLabel: '\u23EE',
    nextLabel: '\u23ED',
    prevTitle: 'Previous track',
    nextTitle: 'Next track',
    errorLabel: 'Error',
    retryLabel: 'Retry',
    transcriptError: 'Transcript unavailable.',
    seekSeconds: 10,
    volumeStep: 0.1,
  };

  var settings = {};
  var mediaExtRe = null;
  var hlsPromise = null;
  var playlist = [];
  var mediaSessionReady = false;
  var activeAudio = null;

  // ── Path fixing ─────────────────────────────────────────────────────

  function isAbsolute(src) {
    if (!src) return true;
    return /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(src);
  }

  function routeDir() {
    var route = window.location.hash.replace(/^#\/?/, '').split('?')[0];
    var idx = route.lastIndexOf('/');
    return idx >= 0 ? route.substring(0, idx + 1) : '';
  }

  function basePath() {
    var bp = window.$docsify && window.$docsify.basePath;
    if (bp !== undefined && bp !== null) return bp.replace(/\/+$/, '');
    return window.location.pathname.replace(/[^/]*$/, '').replace(/\/+$/, '');
  }

  function resolve(src) {
    if (isAbsolute(src)) return src;
    var dir = routeDir();
    var path = dir + src;
    var parts = [];
    path.split('/').forEach(function (seg) {
      if (seg === '..') parts.pop();
      else if (seg !== '.' && seg !== '') parts.push(seg);
    });
    return basePath() + '/' + parts.join('/');
  }

  function fixEl(el) {
    var attr = el.tagName === 'A' ? 'href' : 'src';
    var src = el.getAttribute(attr) || '';
    if (isAbsolute(src)) return;
    if (!mediaExtRe.test(src)) return;
    if (el.dataset.podcastFixed) return;
    el.dataset.podcastFixed = '1';
    el.dataset.originalSrc = src;
    el.setAttribute(attr, resolve(src));
  }

  function fixPaths(root) {
    root.querySelectorAll('audio, video, source, track, a').forEach(fixEl);
  }

  // ── HLS ─────────────────────────────────────────────────────────────

  function nativeHls(el) {
    return !!el.canPlayType &&
      (el.canPlayType('application/vnd.apple.mpegurl') !== '' ||
       el.canPlayType('audio/mpegurl') !== '');
  }

  function loadHlsJs() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsPromise) return hlsPromise;
    hlsPromise = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = settings.hlsCdn;
      s.onload = function () { res(window.Hls); };
      s.onerror = function () { hlsPromise = null; rej(new Error('hls.js load failed')); };
      document.head.appendChild(s);
    });
    return hlsPromise;
  }

  function showHlsLoading(wrap) {
    if (wrap.querySelector('.podcast-player-loading')) return;
    var spinner = document.createElement('span');
    spinner.className = 'podcast-player-loading';
    spinner.textContent = '\u25B6'; // Play symbol as loading indicator
    spinner.title = 'Loading audio\u2026';
    wrap.insertBefore(spinner, wrap.firstChild);
  }

  function hideHlsLoading(wrap) {
    var el = wrap.querySelector('.podcast-player-loading');
    if (el) el.remove();
  }

  function showHlsError(wrap, audioEl, originalSrc) {
    hideHlsLoading(wrap);
    if (wrap.querySelector('.podcast-player-error')) return;
    var err = document.createElement('div');
    err.className = 'podcast-player-error';
    err.textContent = settings.errorLabel;
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'podcast-player-btn podcast-player-retry';
    retry.textContent = settings.retryLabel;
    retry.addEventListener('click', function () {
      err.remove();
      attachHls(audioEl);
    });
    err.appendChild(document.createTextNode(' '));
    err.appendChild(retry);
    wrap.insertBefore(err, audioEl);
  }

  function attachHls(el) {
    var src = el.getAttribute('src') || el.dataset.originalSrc || '';
    if (!/\.m3u8(?:[?#]|$)/i.test(src)) return;
    if (el.dataset.hlsAttached) return;
    if (nativeHls(el)) { el.dataset.hlsAttached = '1'; return; }
    if (el._hlsLoading) return;
    el._hlsLoading = true;
    var original = src;
    var wrap = el.closest('.podcast-player') || el.parentNode;
    showHlsLoading(wrap);
    loadHlsJs().then(function (Hls) {
      el._hlsLoading = false;
      if (!Hls.isSupported()) { hideHlsLoading(wrap); el.dataset.hlsAttached = '1'; return; }
      var hls = new Hls();
      hls.loadSource(original);
      hls.attachMedia(el);
      el._hls = hls;
      el.dataset.hlsAttached = '1';
      hls.on(Hls.Events.MANIFEST_PARSED, function () { hideHlsLoading(wrap); });
      hls.on(Hls.Events.ERROR, function (_evt, data) {
        if (data.fatal) {
          hideHlsLoading(wrap);
          el._hls.destroy();
          el._hls = null;
          el.dataset.hlsAttached = '';
          showHlsError(wrap, el, original);
        }
      });
    }).catch(function () {
      el._hlsLoading = false;
      hideHlsLoading(wrap);
      showHlsError(wrap, el, original);
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  function audioStem(el) {
    var src = el.dataset.originalSrc || el.getAttribute('src') || '';
    return src.replace(/[?#].*$/, '').replace(/\.[a-z0-9]+$/i, '');
  }

  function formatTime(t) {
    t = Math.max(0, Math.floor(t));
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t % 60;
    var mm = (h && m < 10 ? '0' : '') + m;
    var ss = (s < 10 ? '0' : '') + s;
    return (h ? h + ':' : '') + mm + ':' + ss;
  }

  function parseVttTime(stamp) {
    var m = /^(\d+):(\d{2}):(\d{2})[.,](\d{3})$/.exec(stamp) ||
            /^(\d{2}):(\d{2})[.,](\d{3})$/.exec(stamp);
    if (!m) return 0;
    if (m[4] !== undefined) {
      return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    }
    return (+m[1]) * 60 + (+m[2]) + (+m[3]) / 1000;
  }

  // ── Cover art ───────────────────────────────────────────────────────

  function addCover(el, wrap) {
    if (!settings.showCover) return;
    var url;
    if (el.dataset.cover) {
      url = isAbsolute(el.dataset.cover) ? el.dataset.cover : resolve(el.dataset.cover);
    } else {
      var stem = audioStem(el);
      if (!stem) return;
      var pattern = settings.coverPattern.replace('{stem}', stem);
      url = resolve(pattern);
    }
    var img = document.createElement('img');
    img.className = 'podcast-player-cover';
    img.alt = '';
    img.loading = 'lazy';
    img.src = url;
    el._coverUrl = url;
    img.addEventListener('error', function () { img.remove(); });
    wrap.insertBefore(img, wrap.firstChild);
  }

  // ── Chapters ────────────────────────────────────────────────────────

  function chaptersUrl(el) {
    if (el.dataset.chapters) {
      return isAbsolute(el.dataset.chapters)
        ? el.dataset.chapters
        : resolve(el.dataset.chapters);
    }
    var stem = audioStem(el);
    if (!stem) return '';
    return isAbsolute(stem) ? stem + '.json' : resolve(stem + '.json');
  }

  var chapterDataCache = {};

  function buildChapters(el, wrap) {
    if (!settings.showChapters) return;

    function render(list, chapters) {
      list.innerHTML = '';
      chapters.forEach(function (ch, i) {
        var li = document.createElement('li');
        li.dataset.chapterIndex = i;
        var a = document.createElement('a');
        a.href = '#';
        a.textContent = formatTime(ch.startTime || 0) + ' \u2014 ' + (ch.title || '');
        a.addEventListener('click', function (e) {
          e.preventDefault();
          el.currentTime = parseFloat(ch.startTime || 0);
          el.play();
        });
        li.appendChild(a);
        list.appendChild(li);
      });
    }

    function highlight(list, chapters, t) {
      var items = list.querySelectorAll('li');
      var idx = 0;
      for (var i = chapters.length - 1; i >= 0; i--) {
        if (t >= (parseFloat(chapters[i].startTime) || 0)) { idx = i; break; }
      }
      items.forEach(function (li) { li.classList.remove('active'); });
      if (items[idx]) items[idx].classList.add('active');
    }

    var url = chaptersUrl(el);
    if (!url) return;
    var box = document.createElement('details');
    box.className = 'podcast-player-chapters';
    var sum = document.createElement('summary');
    sum.textContent = settings.chapterLabel;
    box.appendChild(sum);
    var list = document.createElement('ol');
    box.appendChild(list);

    var loadFn = function () {
      if (chapterDataCache[url]) {
        render(list, chapterDataCache[url]);
        return;
      }
      list.textContent = '\u2026';
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      }).then(function (chapters) {
        if (!Array.isArray(chapters) || !chapters.length) { box.remove(); return; }
        chapterDataCache[url] = chapters;
        el._chapters = chapters;
        render(list, chapters);
        if (activeAudio === el || el.paused === false) {
          updateMediaSession(el, playlist.findIndex(function(p) { return p.el === el; }));
        }
      }).catch(function () {
        list.innerHTML = '<span class="podcast-player-error-msg">' + settings.errorLabel +
          ' <button class="podcast-player-btn podcast-player-retry" type="button">' +
          settings.retryLabel + '</button></span>';
        list.querySelector('button').addEventListener('click', function () { loadFn(); });
      });
    };
    loadFn();
    wrap.appendChild(box);

    el.addEventListener('timeupdate', function () {
      if (chapterDataCache[url]) highlight(list, chapterDataCache[url], el.currentTime);
    });
  }

  // ── Transcript (from VTT) ───────────────────────────────────────────

  function transcriptUrl(el) {
    var track = el.querySelector('track[kind="subtitles"], track[kind="captions"]');
    if (track && track.getAttribute('src')) {
      var t = track.getAttribute('src');
      return isAbsolute(t) ? t : resolve(t);
    }
    var stem = audioStem(el);
    if (!stem) return '';
    return resolve(stem + '.vtt');
  }

  function parseVtt(text) {
    var cues = [];
    var blocks = text.replace(/\r/g, '').split('\n\n');
    blocks.forEach(function (block) {
      var lines = block.split('\n').filter(function (l) { return l.trim() !== ''; });
      if (!lines.length) return;
      var idx = lines.findIndex(function (l) { return /-->/i.test(l); });
      if (idx === -1) return;
      var times = lines[idx].split('-->');
      var start = parseVttTime(times[0].trim());
      var body = lines.slice(idx + 1).join(' ').trim();
      if (body) cues.push({ start: start, text: body });
    });
    return cues;
  }

  var transcriptCache = {};

  function buildTranscript(el, wrap) {
    if (!settings.showTranscript) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'podcast-player-transcript-btn';
    btn.textContent = settings.transcriptLabel;
    btn.setAttribute('aria-expanded', 'false');
    var panel = document.createElement('div');
    panel.className = 'podcast-player-transcript';
    panel.hidden = true;

    var tUrl = transcriptUrl(el);

    var loadFn = function () {
      if (transcriptCache[tUrl]) {
        buildTranscriptDOM(panel, transcriptCache[tUrl], el);
        return;
      }
      panel.textContent = '\u2026';
      if (!tUrl) { panel.textContent = settings.transcriptError; return; }
      fetch(tUrl).then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      }).then(function (text) {
        var cues = parseVtt(text);
        transcriptCache[tUrl] = cues;
        panel.textContent = '';
        buildTranscriptDOM(panel, cues, el);
      }).catch(function () {
        if (panel.dataset.loaded) return; // preserve existing content
        panel.innerHTML = '<span class="podcast-player-error-msg">' + settings.transcriptError +
          ' <button class="podcast-player-btn podcast-player-retry" type="button">' +
          settings.retryLabel + '</button></span>';
        panel.querySelector('button').addEventListener('click', function () { loadFn(); });
      });
    };

    btn.addEventListener('click', function () {
      if (!panel.dataset.loaded) {
        loadFn();
        panel.dataset.loaded = '1';
      }
      panel.hidden = !panel.hidden;
      btn.setAttribute('aria-expanded', String(!panel.hidden));
    });
    wrap.appendChild(btn);
    wrap.appendChild(panel);
  }

  function buildTranscriptDOM(panel, cues, el) {
    panel.textContent = '';
    var frag = document.createDocumentFragment();
    cues.forEach(function (cue) {
      var p = document.createElement('p');
      var t = document.createElement('button');
      t.type = 'button';
      t.className = 'podcast-player-cue';
      t.textContent = formatTime(cue.start);
      t.addEventListener('click', function () {
        el.currentTime = cue.start;
        el.play();
      });
      p.appendChild(t);
      p.appendChild(document.createTextNode(' ' + cue.text));
      frag.appendChild(p);
    });
    panel.appendChild(frag);
  }

  // ── Download (TS → M4A) ────────────────────────────────────────────

  var ts2m4aPromise = null;

  function loadTs2M4a() {
    if (window.ts2m4a) return Promise.resolve(window.ts2m4a);
    if (ts2m4aPromise) return ts2m4aPromise;
    ts2m4aPromise = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = settings.ts2m4aCdn;
      s.onload = function () {
        if (window.ts2m4a) res(window.ts2m4a);
        else { ts2m4aPromise = null; rej(new Error('ts2m4a missing')); }
      };
      s.onerror = function () { ts2m4aPromise = null; rej(new Error('ts2m4a load failed')); };
      document.head.appendChild(s);
    });
    return ts2m4aPromise;
  }

  function downloadStem(el) {
    var src = el.dataset.originalSrc || el.getAttribute('src') || '';
    return src.split('/').pop().replace(/[?#].*$/, '').replace(/\.m3u8$/i, '');
  }

  // The download control is a plain anchor pointing at the real .m4a URL:
  // right-click → "Copy link address" works natively, and pasting the link
  // yields a proper download wherever the site's service worker is active
  // (the SW synthesizes the m4a from the HLS segments on fetch). Without a
  // controlling SW we fall back to a main-thread remux + blob download.
  function buildDownload(el, wrap) {
    if (!settings.showDownload) return;
    var src = el.getAttribute('src') || el.dataset.originalSrc || '';
    if (!/\.m3u8(?:[?#]|$)/i.test(src)) return;

    var a = document.createElement('a');
    a.className = 'podcast-player-btn podcast-player-download';
    a.textContent = settings.downloadLabel;
    a.download = '';

    var override = el.dataset.download;
    if (override) {
      a.href = isAbsolute(override) ? override : resolve(override);
      wrap.appendChild(a);
      return;
    }

    var href = settings.downloadUrl ? (settings.downloadUrl(resolve(src), el) || '') : '';
    if (!href) href = resolve(src).replace(/\.m3u8(?:[?#].*)?$/i, '.m4a');
    a.href = href;

    a.addEventListener('click', function (ev) {
      var swReady = ('serviceWorker' in navigator) && !!navigator.serviceWorker.controller;
      if (swReady) return;                 // SW answers the real URL
      ev.preventDefault();
      remuxAndDownload(el, a);
    });
    wrap.appendChild(a);
  }

  function remuxAndDownload(el, a) {
    var src = resolve(el.getAttribute('src') || el.dataset.originalSrc || '');
    var label = a.textContent;
    a.textContent = settings.downloadBusyLabel;
    a.setAttribute('aria-disabled', 'true');
    loadTs2M4a().then(function (ts2m4a) {
      return ts2m4a.tsToM4a(src, {
        onProgress: function (i, n) {
          a.textContent = settings.downloadBusyLabel + ' ' + i + '/' + n;
        },
      });
    }).then(function (buf) {
      var blob = new Blob([buf], { type: 'audio/mp4' });
      var url = URL.createObjectURL(blob);
      var tmp = document.createElement('a');
      tmp.href = url;
      tmp.download = downloadStem(el) + '.m4a';
      document.body.appendChild(tmp);
      tmp.click();
      document.body.removeChild(tmp);
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      a.textContent = label;
      a.removeAttribute('aria-disabled');
    }).catch(function () {
      a.textContent = label;
      a.removeAttribute('aria-disabled');
      var err = document.createElement('span');
      err.className = 'podcast-player-error-msg';
      err.textContent = ' ' + settings.downloadErrorLabel;
      a.parentNode.insertBefore(err, a.nextSibling);
      setTimeout(function () { err.remove(); }, 4000);
    });
  }

  // ── Playlist (prev / next) ──────────────────────────────────────────

  function navToEpisode(sel) {
    var link = document.querySelector(sel + ' a') || document.querySelector(sel);
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.charAt(0) === '#') href = href.slice(1);
    if (href) {
      try { sessionStorage.setItem('podcast-autoplay', '1'); } catch (_) { /* ignore */ }
      window.location.hash = href;
    }
  }

  function setupMediaSession() {
    if (mediaSessionReady) return;
    if (!navigator.mediaSession) return;
    mediaSessionReady = true;
    try {
      navigator.mediaSession.setActionHandler('nexttrack', function () {
        navToEpisode('.pagination-item--next');
      });
      navigator.mediaSession.setActionHandler('previoustrack', function () {
        navToEpisode('.pagination-item--previous');
      });
      navigator.mediaSession.setActionHandler('seekforward', function () {
        if (!activeAudio) return;
        var chapters = activeAudio._chapters;
        if (chapters && chapters.length) {
          for (var i = 0; i < chapters.length; i++) {
            if ((parseFloat(chapters[i].startTime) || 0) > activeAudio.currentTime + 0.5) {
              activeAudio.currentTime = parseFloat(chapters[i].startTime) || 0;
              return;
            }
          }
        }
        activeAudio.currentTime = Math.min(activeAudio.duration || Infinity, activeAudio.currentTime + settings.seekSeconds);
      });
      navigator.mediaSession.setActionHandler('seekbackward', function () {
        if (!activeAudio) return;
        var chapters = activeAudio._chapters;
        if (chapters && chapters.length) {
          for (var i = chapters.length - 1; i >= 0; i--) {
            if ((parseFloat(chapters[i].startTime) || 0) < activeAudio.currentTime - 0.5) {
              activeAudio.currentTime = parseFloat(chapters[i].startTime) || 0;
              return;
            }
          }
          activeAudio.currentTime = 0;
          return;
        }
        activeAudio.currentTime = Math.max(0, activeAudio.currentTime - settings.seekSeconds);
      });
      navigator.mediaSession.setActionHandler('seekto', function (details) {
        if (activeAudio && details.seekTime !== undefined) {
          activeAudio.currentTime = details.seekTime;
        }
      });
    } catch (e) { /* ignore */ }
  }

  function updateMediaSession(el, index) {
    if (!navigator.mediaSession || !window.MediaMetadata) return;
    var title = trackTitle(el, index) || (document.title || 'Podcast');
    var artwork = [];
    if (el._coverUrl) {
      artwork.push({ src: el._coverUrl, sizes: '512x512', type: 'image/png' });
    }
    try {
      var meta = {
        title: title,
        artist: settings.artist,
        album: settings.album,
        artwork: artwork,
      };
      if (el._chapters && el._chapters.length) {
        meta.chapterInfo = el._chapters.map(function (ch) {
          return { title: ch.title || '', startTime: parseFloat(ch.startTime) || 0 };
        });
      }
      navigator.mediaSession.metadata = new MediaMetadata(meta);
      navigator.mediaSession.playbackState = 'playing';
    } catch (e) { /* ignore */ }
  }

  function trackTitle(el, i) {
    if (el.dataset.title) return el.dataset.title;
    var src = el.dataset.originalSrc || el.getAttribute('src') || '';
    var name = src.split('/').pop().split('?')[0].replace(/\.[a-z0-9]+$/i, '');
    return name || 'Piste ' + (i + 1);
  }

  function goTo(index, autoplay) {
    if (index < 0 || index >= playlist.length) return;
    playlist.forEach(function (p, i) {
      if (i !== index) p.el.pause();
    });
    var target = playlist[index];
    if (target.el && target.el.closest('body')) {
      try { target.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      catch (_) { target.el.scrollIntoView(); }
    }
    if (autoplay) {
      var p = target.el.play();
      if (p && p.catch) p.catch(function () { /* autoplay blocked — fine */ });
    }
  }

  function buildToolbar(entry, index) {
    var bar = document.createElement('div');
    bar.className = 'podcast-player-toolbar';

    if (playlist.length > 1) {
      var prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'podcast-player-btn podcast-player-prev';
      prev.textContent = settings.prevLabel;
      prev.title = settings.prevTitle;
      prev.disabled = index === 0;
      prev.addEventListener('click', function () { goTo(index - 1, true); });

      var next = document.createElement('button');
      next.type = 'button';
      next.className = 'podcast-player-btn podcast-player-next';
      next.textContent = settings.nextLabel;
      next.title = settings.nextTitle;
      next.disabled = index === playlist.length - 1;
      next.addEventListener('click', function () { goTo(index + 1, true); });

      var label = document.createElement('span');
      label.className = 'podcast-player-title';
      label.textContent = (index + 1) + '/' + playlist.length + ' \u00B7 ' +
        trackTitle(entry.el, index);

      bar.appendChild(prev);
      bar.appendChild(next);
      bar.appendChild(label);

      entry.el.addEventListener('ended', function () {
        goTo(index + 1, true);
      });
    }

    return bar;
  }

  // ── Keyboard shortcuts ──────────────────────────────────────────────

  function setupKeyboard(wrap, el) {
    wrap.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' ||
          e.target.isContentEditable) return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          if (el.paused) el.play(); else el.pause();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          el.currentTime = Math.max(0, el.currentTime - settings.seekSeconds);
          break;
        case 'ArrowRight':
          e.preventDefault();
          el.currentTime = Math.min(el.duration || Infinity, el.currentTime + settings.seekSeconds);
          break;
        case 'ArrowUp':
          e.preventDefault();
          el.volume = Math.min(1, el.volume + settings.volumeStep);
          break;
        case 'ArrowDown':
          e.preventDefault();
          el.volume = Math.max(0, el.volume - settings.volumeStep);
          break;
        case 'KeyM':
          e.preventDefault();
          el.muted = !el.muted;
          break;
      }
    });
  }

  // ── Position persistence ────────────────────────────────────────────

  function positionKey(el) {
    var src = el.dataset.originalSrc || el.getAttribute('src') || '';
    return 'podcast-pos:' + src;
  }

  function savePosition(el) {
    if (!el.duration || el.seeking) return;
    try { sessionStorage.setItem(positionKey(el), String(el.currentTime)); } catch (_) { /* ignore */ }
  }

  function restorePosition(el) {
    try {
      var saved = sessionStorage.getItem(positionKey(el));
      if (saved) {
        var t = parseFloat(saved);
        if (t > 0 && isFinite(t)) el.currentTime = t;
      }
    } catch (_) { /* ignore */ }
  }

  // ── Enhance one <audio> ──────────────────────────────────────────────

  function enhance(el, index) {
    if (el.dataset.podcastEnhanced) return;
    el.dataset.podcastEnhanced = '1';

    if (!el.parentNode) return;
    var wrap = document.createElement('div');
    wrap.className = 'podcast-player';
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', trackTitle(el, index) || 'Podcast player');
    el.parentNode.insertBefore(wrap, el);

    var bar = buildToolbar(playlist[index], index);
    if (bar.childNodes.length) wrap.appendChild(bar);
    wrap.appendChild(el);

    addCover(el, wrap);
    buildChapters(el, wrap);
    buildTranscript(el, wrap);
    buildDownload(el, wrap);

    el.addEventListener('loadedmetadata', function () {
      restorePosition(el);
      try {
        if (sessionStorage.getItem('podcast-autoplay') === '1') {
          sessionStorage.removeItem('podcast-autoplay');
          var p = el.play();
          if (p && p.catch) p.catch(function () { /* autoplay blocked */ });
        }
      } catch (_) { /* ignore */ }
    }, { once: true });
    el.addEventListener('timeupdate', function () { savePosition(el); });
    el.addEventListener('pause', function () {
      savePosition(el);
      if (activeAudio === el) activeAudio = null;
    });

    el.addEventListener('play', function () {
      activeAudio = el;
      attachHls(el);
      updateMediaSession(el, index);
      playlist.forEach(function (p) {
        if (p.el !== el) p.el.pause();
      });
    }, { once: false });

    setupKeyboard(wrap, el);
    attachHls(el);
  }

  // ── Styles ───────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('podcast-player-styles')) return;
    var css = [
      '.podcast-player { margin: 1em 0; display: flex; flex-wrap: wrap;',
      '  gap: 1em; align-items: flex-start; outline: none; }',
      '.podcast-player:focus-visible { box-shadow: 0 0 0 2px var(--theme-color, #36c);',
      '  border-radius: 4px; }',
      '.podcast-player audio { flex: 1 1 280px; width: 100%; min-width: 240px;',
      '  display: block; }',
      '.podcast-player-cover { width: 120px; height: 120px; object-fit: cover;',
      '  border-radius: 8px; flex: 0 0 auto; background: #0001; }',
      '.podcast-player-toolbar { flex: 1 1 100%; display: flex; align-items: center;',
      '  gap: .5em; margin-bottom: .25em; }',
      '.podcast-player-btn { border: 1px solid var(--theme-color, #ccc);',
      '  background: transparent; border-radius: 4px; cursor: pointer;',
      '  padding: .15em .6em; font-size: 1em; line-height: 1.4; }',
      '.podcast-player-btn:hover { background: var(--theme-color, #36c); color: #fff; }',
      '.podcast-player-btn:disabled { opacity: .4; cursor: default; pointer-events: none; }',
      '.podcast-player-title { font-size: .85em; opacity: .8;',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.podcast-player-chapters { flex: 1 1 100%; font-size: .9em; }',
      '.podcast-player-chapters summary { cursor: pointer; font-weight: 600;',
      '  margin: .25em 0; }',
      '.podcast-player-chapters ol { margin: .25em 0; padding-left: 1.4em; }',
      '.podcast-player-chapters li { border-radius: 3px; padding: 0 .25em;',
      '  transition: background .15s; }',
      '.podcast-player-chapters li.active { background: var(--theme-color, #36c)15;',
      '  font-weight: 600; }',
      '.podcast-player-chapters li.active a { color: var(--theme-color, #36c); }',
      '.podcast-player-chapters a { text-decoration: none; }',
      '.podcast-player-chapters a:hover { text-decoration: underline; }',
      '.podcast-player-transcript-btn { border: 1px solid var(--theme-color, #ccc);',
      '  background: transparent; border-radius: 4px; cursor: pointer;',
      '  padding: .15em .6em; margin-top: .25em; font-size: .85em; }',
      '.podcast-player-transcript-btn:hover { background: var(--theme-color, #36c);',
      '  color: #fff; }',
      '.podcast-player-transcript { flex: 1 1 100%; max-height: 18em; overflow: auto;',
      '  border: 1px solid var(--theme-color, #ccc); border-radius: 6px;',
      '  padding: .5em .75em; margin-top: .25em; font-size: .9em; line-height: 1.5; }',
      '.podcast-player-transcript p { margin: .15em 0; }',
      '.podcast-player-cue { border: 0; background: none; color: var(--theme-color, #36c);',
      '  cursor: pointer; font-variant-numeric: tabular-nums; padding: 0;',
      '  font-weight: 600; }',
      '.podcast-player-loading { font-size: 1.5em; color: var(--theme-color, #36c);',
      '  animation: podcast-player-pulse 1s ease-in-out infinite;',
      '  line-height: 1; align-self: center; }',
      '.podcast-player-error { flex: 1 1 100%; color: #c33; font-size: .85em; }',
      '.podcast-player-error-msg { color: #c33; }',
      '.podcast-player-retry { font-size: .85em; }',
      '.podcast-player-download[aria-disabled="true"] { opacity: .5;',
      '  cursor: progress; pointer-events: none; }',
      '@keyframes podcast-player-pulse {',
      '  0%, 100% { opacity: .5; } 50% { opacity: 1; }',
      '}',
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'podcast-player-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Docsify plugin ──────────────────────────────────────────────────

  function plugin(hook) {
    hook.doneEach(function () {
      var root = document.querySelector('.markdown-section') || document;
      fixPaths(root);

      playlist = [];
      root.querySelectorAll('audio').forEach(function (el) {
        playlist.push({ el: el });
      });
      playlist.forEach(function (entry, i) { enhance(entry.el, i); });

      root.querySelectorAll('video').forEach(attachHls);
    });
  }

  function install() {
    var user = (window.$docsify && window.$docsify.podcastPlayer) || {};
    settings = {
      hlsCdn: user.hlsCdn !== undefined ? user.hlsCdn : DEFAULTS.hlsCdn,
      showCover: user.showCover !== undefined ? user.showCover : DEFAULTS.showCover,
      showChapters: user.showChapters !== undefined ? user.showChapters : DEFAULTS.showChapters,
      showTranscript: user.showTranscript !== undefined ? user.showTranscript : DEFAULTS.showTranscript,
      showDownload: user.showDownload !== undefined ? user.showDownload : DEFAULTS.showDownload,
      downloadLabel: user.downloadLabel || DEFAULTS.downloadLabel,
      downloadBusyLabel: user.downloadBusyLabel || DEFAULTS.downloadBusyLabel,
      downloadErrorLabel: user.downloadErrorLabel || DEFAULTS.downloadErrorLabel,
      ts2m4aCdn: user.ts2m4aCdn || DEFAULTS.ts2m4aCdn,
      downloadUrl: typeof user.downloadUrl === 'function' ? user.downloadUrl : null,
      coverPattern: user.coverPattern || DEFAULTS.coverPattern,
      chapterLabel: user.chapterLabel || DEFAULTS.chapterLabel,
      transcriptLabel: user.transcriptLabel || DEFAULTS.transcriptLabel,
      mediaExtensions: user.mediaExtensions || DEFAULTS.mediaExtensions,
      artist: user.artist || DEFAULTS.artist,
      album: user.album || DEFAULTS.album,
      prevLabel: user.prevLabel || DEFAULTS.prevLabel,
      nextLabel: user.nextLabel || DEFAULTS.nextLabel,
      prevTitle: user.prevTitle || DEFAULTS.prevTitle,
      nextTitle: user.nextTitle || DEFAULTS.nextTitle,
      errorLabel: user.errorLabel || DEFAULTS.errorLabel,
      retryLabel: user.retryLabel || DEFAULTS.retryLabel,
      transcriptError: user.transcriptError || DEFAULTS.transcriptError,
      seekSeconds: user.seekSeconds !== undefined ? user.seekSeconds : DEFAULTS.seekSeconds,
      volumeStep: user.volumeStep !== undefined ? user.volumeStep : DEFAULTS.volumeStep,
    };
    mediaExtRe = new RegExp(
      '\\.(?:' + settings.mediaExtensions.join('|') + ')(?:[?#]|$)', 'i'
    );
    injectStyles();
    setupMediaSession();
    window.$docsify = window.$docsify || {};
    window.$docsify.plugins = (window.$docsify.plugins || []).concat(plugin);
  }

  install();
})();
