/*!
 * docsify-podcast-player v2
 * Audio / podcast player plugin for Docsify hash-routing SPAs.
 *
 * Features:
 *   - Fixes relative src/href paths for <audio>, <video>, <source>, <track>
 *     and media links (Docsify resolves them against index.html, not the page)
 *   - HLS (.m3u8) playback: native on Safari, hls.js everywhere else
 *     (with loading spinner, error recovery)
 *   - Cover art (auto-detected <stem>-cover.png or via data-cover)
 *   - Clickable chapter list with active-chapter highlighting (timeupdate),
 *     per-chapter cover swap and current-chapter label
 *   - Transcript panel from WebVTT subtitles (clickable cues, search,
 *     follows playback, error+retry)
 *   - Custom, accessible controls: play/pause, back/forward, chapter
 *     prev/next, seek scrubber with chapter ticks, time, speed, volume,
 *     download — keyboard operable, ARIA-labelled, reduced-motion aware
 *   - Playlist toolbar with previous / next track
 *   - Playback position persistence (sessionStorage per audio URL) +
 *     resume chip
 *   - Sticky mini-player (opt-in)
 *   - Keyboard shortcuts help dialog
 *   - MediaSession: metadata, artwork, chapterInfo, positionState, handlers
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
 *     showSpeed:        true,
 *     showVolume:       true,
 *     showChapterNav:   true,
 *     miniPlayer:       false,
 *     transcriptFollow: true,
 *     transcriptSearch: true,
 *     helpDialog:       true,
 *     resumeChip:       true,
 *     backForward:      10,
 *     speedOptions:     [0.75, 1, 1.25, 1.5, 2],
 *     print:            'hide',          // 'hide' | 'keep-title'
 *     downloadSw:       true,            // SW download synthesis (see README)
 *     labels:           { ... },         // FR by default, EN fallback
 *     … (all v1 options still supported)
 *   };
 *   <script src="vendor/docsify-podcast-player/docsify-podcast-player.js"></script>
 */
(function () {
  'use strict';

  // Plugin release — version-pins the service worker script URL (?v=) so
  // browsers force an SW update as soon as a new release ships.
  var PLUGIN_VERSION = '1.6.1';

  // ── v1 defaults (backwards compatible) ──────────────────────────────
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
    // ── v2 defaults ──────────────────────────────────────────────────
    showTime: true,
    showSpeed: true,
    showVolume: true,
    showChapterNav: true,
    backForward: 10,                  // back/forward buttons (seconds)
    speedOptions: [0.75, 1, 1.25, 1.5, 2],
    miniPlayer: false,
    transcriptFollow: true,
    transcriptSearch: true,
    helpDialog: true,
    resumeChip: true,
    print: 'hide',                    // 'hide' | 'keep-title'
    downloadSw: true,                 // true=auto-detect 'sw.js' at site
                                     // root, false=off, string=explicit path
    unified: false,                   // persistent global player (see docs/unified-player.md)
    labels: null,                     // FR by default, EN fallback
  };

  // ── i18n (French first, English fallback) ──────────────────────────
  var LABELS = {
    fr: {
      play: 'Écouter', pause: 'Pause',
      back: 'Reculer de {s} s', forward: 'Avancer de {s} s',
      chapPrev: 'Chapitre précédent', chapNext: 'Chapitre suivant',
      position: 'Position', volume: 'Volume', mute: 'Couper le son',
      unmute: 'Rétablir le son',
      speed: 'Vitesse : {x}×',
      remaining: 'restant',
      download: 'Télécharger l\u2019épisode',
      loading: 'Chargement\u2026',
      chapters: 'Chapitres', transcript: 'Transcript',
      transcriptFollow: 'Suivre la lecture', transcriptSearch: 'Filtrer le transcript',
      refollow: 'Reprendre le suivi',
      switchEp: 'Basculer', goToPage: 'Aller à la page',
      followSuspended: 'Suivi de la lecture suspendu',
      followResumed: 'Suivi de la lecture repris',
      cueAt: 'Écouter à {t}',
      resume: 'Reprendre à {t}',
      miniPlayer: 'Mini-lecteur', closeMini: 'Fermer le mini-lecteur',
      help: 'Raccourcis clavier', closeHelp: 'Fermer',
      error: 'Erreur', retry: 'Réessayer',
      nowPlaying: 'En lecture', title: 'Épisode',
      downloadStarted: 'Téléchargement démarré',
      downloadFailed: 'Téléchargement indisponible.',
      muted: 'Son coupé', unmuted: 'Son rétabli',
      speedChanged: 'Vitesse : {x}×',
    },
    en: {
      play: 'Play', pause: 'Pause',
      back: 'Back {s} s', forward: 'Forward {s} s',
      chapPrev: 'Previous chapter', chapNext: 'Next chapter',
      position: 'Position', volume: 'Volume', mute: 'Mute',
      unmute: 'Unmute',
      speed: 'Speed: {x}×',
      remaining: 'left',
      download: 'Download episode',
      loading: 'Loading\u2026',
      chapters: 'Chapters', transcript: 'Transcript',
      transcriptFollow: 'Follow playback', transcriptSearch: 'Filter transcript',
      refollow: 'Resume following',
      switchEp: 'Switch', goToPage: 'Go to page',
      followSuspended: 'Playback following suspended',
      followResumed: 'Playback following resumed',
      cueAt: 'Listen at {t}',
      resume: 'Resume at {t}',
      miniPlayer: 'Mini player', closeMini: 'Close mini player',
      help: 'Keyboard shortcuts', closeHelp: 'Close',
      error: 'Error', retry: 'Retry',
      nowPlaying: 'Now playing', title: 'Episode',
      downloadStarted: 'Download started',
      downloadFailed: 'Download unavailable.',
      muted: 'Muted', unmuted: 'Unmuted',
      speedChanged: 'Speed: {x}×',
    },
  };

  var settings = {};
  var mediaExtRe = null;
  var hlsPromise = null;
  var playlist = [];
  var mediaSessionReady = false;
  var activeAudio = null;

  function tpl(str, vars) {
    return String(str).replace(/\{(\w+)\}/g, function (_, k) {
      return vars[k] !== undefined ? vars[k] : '{' + k + '}';
    });
  }

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
    spinner.className = 'podcast-player-loading pp-loading';
    spinner.setAttribute('role', 'status');
    spinner.setAttribute('aria-label', settings.labels.loading);
    spinner.textContent = '\u25B6';
    wrap.appendChild(spinner);
  }

  function hideHlsLoading(wrap) {
    var el = wrap.querySelector('.podcast-player-loading');
    if (el) el.remove();
  }

  function showHlsError(wrap, audioEl, originalSrc) {
    hideHlsLoading(wrap);
    if (wrap.querySelector('.podcast-player-error')) return;
    var err = document.createElement('div');
    err.className = 'podcast-player-error pp-error';
    err.setAttribute('role', 'alert');
    err.textContent = settings.labels.error + ' ' + settings.errorLabel;
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'podcast-player-btn podcast-player-retry';
    retry.textContent = settings.labels.retry || settings.retryLabel;
    retry.addEventListener('click', function () {
      err.remove();
      attachHls(audioEl);
    });
    err.appendChild(document.createTextNode(' '));
    err.appendChild(retry);
    wrap.insertBefore(err, wrap.querySelector('.pp-card').nextSibling || null);
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
      if (!Hls.isSupported()) {
        hideHlsLoading(wrap);
        showHlsError(wrap, el, original);
        return;
      }
      var hls = new Hls();
      hls.loadSource(original);
      hls.attachMedia(el);
      el._hls = hls;
      el.dataset.hlsAttached = '1';
      hls.on(Hls.Events.MANIFEST_PARSED, function () { hideHlsLoading(wrap); });
      hls.on(Hls.Events.ERROR, function (_evt, data) {
        if (!data.fatal) return;
        hideHlsLoading(wrap);
        // One automatic retry with backoff, then a final error.
        var retries = el._hlsFatalRetries || 0;
        if (retries < 1) {
          el._hlsFatalRetries = retries + 1;
          try { el._hls.destroy(); } catch (_) { /* ignore */ }
          el._hls = null;
          el.dataset.hlsAttached = '';
          setTimeout(function () { attachHls(el); }, 2000);
          return;
        }
        try { el._hls.destroy(); } catch (_) { /* ignore */ }
        el._hls = null;
        el.dataset.hlsAttached = '';
        showHlsError(wrap, el, original);
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

  function timeDatetime(t) {
    t = Math.max(0, Math.floor(t));
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t % 60;
    return 'PT' + (h ? h + 'H' : '') + (m || h ? m + 'M' : '') + s + 'S';
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

  // ── Live region (announcements) ─────────────────────────────────────

  function ensureLiveRegion(wrap) {
    var live = wrap.querySelector('.pp-live');
    if (live) return live;
    live = document.createElement('span');
    live.className = 'pp-live';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('role', 'status');
    wrap.appendChild(live);
    return live;
  }

  function announce(wrap, msg) {
    if (!msg) return;
    var live = ensureLiveRegion(wrap);
    // Reset so repeated identical messages are announced again.
    live.textContent = '';
    setTimeout(function () { live.textContent = msg; }, 20);
  }

  // ── Cover art ───────────────────────────────────────────────────────

  function addCover(el, wrap, mainRow) {
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
    img.className = 'podcast-player-cover pp-cover';
    img.alt = '';
    img.loading = 'lazy';
    img.src = url;
    el._coverUrl = url;
    el._coverImg = img;
    img.addEventListener('load', function () {
      if (img.naturalWidth && img.naturalHeight) {
        el._coverSize = img.naturalWidth + 'x' + img.naturalHeight;
        if (activeAudio === el || el.paused === false) {
          updateMediaSession(el, playlist.findIndex(function (p) { return p.el === el; }));
        }
      }
    });
    img.addEventListener('error', function () { img.remove(); });
    mainRow.insertBefore(img, mainRow.firstChild);
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

  function buildChapters(media, wrap, panels) {
    if (!settings.showChapters) return;

    function render(list, chapters) {
      list.innerHTML = '';
      chapters.forEach(function (ch, i) {
        var li = document.createElement('li');
        li.dataset.chapterIndex = i;
        var a = document.createElement('button');
        a.type = 'button';
        a.className = 'podcast-player-chapter-link pp-chapter-link';
        a.textContent = formatTime(ch.startTime || 0) + ' \u2014 ' + (ch.title || '');
        a.setAttribute('aria-label', ch.title || ('Chapitre ' + (i + 1)));
        a.addEventListener('click', function () {
          media.currentTime = parseFloat(ch.startTime || 0);
          media.play();
          announce(wrap, tpl(settings.labels.cueAt, { t: formatTime(ch.startTime || 0) }));
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
      items.forEach(function (li, k) {
        var active = k === idx;
        li.classList.toggle('active', active);
        var btn = li.querySelector('button');
        if (btn) {
          if (active) btn.setAttribute('aria-current', 'true');
          else btn.removeAttribute('aria-current');
        }
      });
      // Keep the active chapter in view, but only when it changes (never
      // fight the user's own scrolling).
      if (idx !== list._lastActiveIdx) {
        list._lastActiveIdx = idx;
        var target = items[idx];
        if (target) {
          try { target.scrollIntoView({ block: 'nearest' }); } catch (_) { /* jsdom */ }
        }
      }
      return idx;
    }

    function updateChapterPresentation(media, chapters, t) {
      var idx = highlight(list, chapters, t);
      var ch = chapters[idx] || null;
      if (media._chapterNowEl) {
        media._chapterNowEl.textContent = ch && ch.title ? ch.title : '';
        media._chapterNowEl.style.display = (ch && ch.title) ? '' : 'none';
      }
      var target = media._coverUrl;
      if (ch && ch.img) {
        target = isAbsolute(ch.img) ? ch.img : resolve(ch.img);
      }
      if (media._coverImg && target && media._coverImg.getAttribute('src') !== target) {
        media._coverImg.src = target;
      }
      if (media._lastChapterIdx !== idx) {
        media._lastChapterIdx = idx;
        if (activeAudio === media || media.paused === false) {
          updateMediaSession(media, playlist.findIndex(function (p) { return p.media === media; }));
        }
      }
      return idx;
    }

    var url = chaptersUrl(media);
    if (!url) return;
    var box = document.createElement('details');
    box.className = 'podcast-player-chapters pp-chapters';
    var sum = document.createElement('summary');
    sum.textContent = settings.chapterLabel || settings.labels.chapters;
    box.appendChild(sum);
    var now = document.createElement('span');
    now.className = 'podcast-player-chapter-now pp-now';
    now.style.display = 'none';
    media._chapterNowEl = now;
    box.appendChild(now);
    var list = document.createElement('ol');
    box.appendChild(list);
    panels.appendChild(box);

    var loadFn = function () {
      if (chapterDataCache[url]) {
        render(list, chapterDataCache[url]);
        return;
      }
      list.textContent = '\u2026';
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      }).then(function (data) {
        var chapters = Array.isArray(data) ? data
          : (data && Array.isArray(data.chapters) ? data.chapters : []);
        if (!chapters.length) { box.remove(); return; }
        chapterDataCache[url] = chapters;
        media._chapters = chapters;
        drawScrubberTicks(media);
        render(list, chapters);
        if (activeAudio === media || media.paused === false) {
          updateMediaSession(media, playlist.findIndex(function(p) { return p.media === media; }));
        }
      }).catch(function () {
        list.innerHTML = '<span class="podcast-player-error-msg">' + settings.errorLabel +
          ' <button class="podcast-player-btn podcast-player-retry" type="button">' +
          settings.retryLabel + '</button></span>';
        list.querySelector('button').addEventListener('click', function () { loadFn(); });
      });
    };
    loadFn();
    media.addEventListener('timeupdate', function () {
      if (chapterDataCache[url]) {
        updateChapterPresentation(media, chapterDataCache[url], media.currentTime);
      }
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

  function buildTranscript(media, wrap, panels) {
    if (!settings.showTranscript) return;
    var panelId = 'pp-transcript-' + Math.random().toString(36).slice(2, 8);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'podcast-player-transcript-btn pp-transcript-btn';
    btn.textContent = settings.transcriptLabel || settings.labels.transcript;
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', panelId);
    var panel = document.createElement('div');
    panel.className = 'podcast-player-transcript pp-transcript';
    panel.id = panelId;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', settings.labels.transcript);
    panel.hidden = true;

    var follow = true;
    if (settings.transcriptFollow === false) follow = false;

    var tUrl = transcriptUrl(media);

    function renderCues(panel, cues, filter) {
      var frag = document.createDocumentFragment();
      panel._lastCueIdx = -1;
      cues.forEach(function (cue) {
        if (filter && cue.text.toLowerCase().indexOf(filter) === -1) return;
        var p = document.createElement('p');
        p.dataset.cueStart = cue.start;
        var t = document.createElement('button');
        t.type = 'button';
        t.className = 'podcast-player-cue pp-cue';
        t.textContent = formatTime(cue.start);
        t.setAttribute('aria-label', tpl(settings.labels.cueAt, { t: formatTime(cue.start) }));
        t.addEventListener('click', function () {
          media.currentTime = cue.start;
          media.play();
        });
        p.appendChild(t);
        // Speaker label if present: "<v Hôte>…</v>" → styled element.
        var voice = /^<v\s+([^>]*)>(.*)<\/v>\s*$/i.exec(cue.text);
        if (voice) {
          var sp = document.createElement('span');
          sp.className = 'pp-cue-speaker';
          sp.textContent = (voice[1] || '').trim();
          p.appendChild(sp);
          p.appendChild(document.createTextNode(' ' + (voice[2] || '').trim()));
        } else {
          p.appendChild(document.createTextNode(' ' + cue.text));
        }
        frag.appendChild(p);
      });
      panel.appendChild(frag);
    }

    function activeCueIndex(cues, t) {
      var idx = -1;
      for (var i = 0; i < cues.length; i++) {
        if (t >= cues[i].start) idx = i;
        else break;
      }
      return idx;
    }

    function updateFollow(cues, t) {
      if (!follow || !panel.dataset.loaded) return;
      var idx = activeCueIndex(cues, t);
      // Match cues by start time so highlighting stays correct when the
      // list is filtered by the search box.
      var activeStart = idx >= 0 ? cues[idx].start : -1;
      var activeEl = null;
      var ps = panel.querySelectorAll('p');
      ps.forEach(function (p) {
        var active = parseFloat(p.dataset.cueStart) === activeStart;
        if (active) {
          p.setAttribute('aria-current', 'true');
          activeEl = p;
        } else {
          p.removeAttribute('aria-current');
        }
      });
      // Auto-scroll only when the active cue changes AND the user has not
      // taken over with manual scrolling.
      if (activeEl && !scrolling && idx !== panel._lastCueIdx) {
        panel._lastCueIdx = idx;
        try { activeEl.scrollIntoView({ block: 'nearest' }); } catch (_) { /* jsdom */ }
      }
    }

    function suspendFollow() {
      if (!follow || scrolling) return;
      scrolling = true;
      var rf = panels.querySelector('.pp-refollow');
      if (rf) rf.hidden = false;
      announce(wrap, settings.labels.followSuspended);
    }

    function resumeFollow() {
      scrolling = false;
      panel._lastCueIdx = -1;
      var rf = panels.querySelector('.pp-refollow');
      if (rf) rf.hidden = true;
      announce(wrap, settings.labels.followResumed);
    }

    var scrolling = false;

    // User takes over with the wheel / touch → suspend auto-scroll.
    panel.addEventListener('wheel', function () { suspendFollow(); }, { passive: true });
    panel.addEventListener('touchmove', function () { suspendFollow(); }, { passive: true });

    var loadFn = function () {
      if (transcriptCache[tUrl]) {
        renderCues(panel, transcriptCache[tUrl], '');
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
        renderCues(panel, cues, '');
      }).catch(function () {
        if (panel.dataset.loaded) return;
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
      if (!panel.hidden) {
        try { panel.focus({ preventScroll: true }); } catch (_) { panel.focus(); }
      }
    });

    var header = document.createElement('div');
    header.className = 'pp-transcript-header';
    header.appendChild(btn);

    if (settings.transcriptSearch) {
      var search = document.createElement('input');
      search.type = 'search';
      search.className = 'pp-transcript-search';
      search.setAttribute('aria-label', settings.labels.transcriptSearch);
      search.placeholder = settings.labels.transcriptSearch;
      search.addEventListener('input', function () {
        panel.textContent = '';
        panel._lastCueIdx = -1; // follow keeps working on the filtered list
        var q = search.value.trim().toLowerCase();
        if (transcriptCache[tUrl]) renderCues(panel, transcriptCache[tUrl], q);
      });
      header.appendChild(search);
    }

    if (settings.transcriptFollow) {
      var fb = document.createElement('button');
      fb.type = 'button';
      fb.className = 'pp-follow';
      fb.setAttribute('aria-pressed', 'true');
      fb.textContent = settings.labels.transcriptFollow;
      fb.addEventListener('click', function () {
        follow = !follow;
        fb.setAttribute('aria-pressed', String(follow));
        if (follow) resumeFollow();
      });
      header.appendChild(fb);

      // Floating "resume following" button — appears when the user scrolls
      // the transcript manually (auto-scroll suspended).
      var rf = document.createElement('button');
      rf.type = 'button';
      rf.className = 'podcast-player-btn pp-refollow';
      rf.hidden = true;
      rf.textContent = settings.labels.refollow;
      rf.setAttribute('aria-label', settings.labels.refollow);
      rf.addEventListener('click', function () { resumeFollow(); });
      panels.appendChild(rf);
    }

    panels.appendChild(header);
    panels.appendChild(panel);

    media.addEventListener('timeupdate', function () {
      if (panel.dataset.loaded && transcriptCache[tUrl]) {
        updateFollow(transcriptCache[tUrl], media.currentTime);
      }
    });
  }

  // ── Custom controls (v2) ────────────────────────────────────────────

  var ICONS = {
    play: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>',
    forward: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>',
    chapPrev: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>',
    chapNext: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
    volume: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>',
    muted: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    help: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };

  function icon(name) {
    var span = document.createElement('span');
    span.className = 'pp-icon';
    span.innerHTML = ICONS[name] || '';
    return span;
  }

  function buildControls(media, wrap, card) {
    var controls = document.createElement('div');
    controls.className = 'pp-controls';
    card.appendChild(controls);

    // ── Play / pause ──
    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'podcast-player-btn pp-btn pp-btn-play';
    play.setAttribute('aria-label', settings.labels.play);
    play.appendChild(icon('play'));
    media._playBtn = play;
    play.addEventListener('click', function () {
      if (media.paused) media.play(); else media.pause();
    });
    controls.appendChild(play);

    // ── Resume chip ──
    if (settings.resumeChip) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'podcast-player-btn pp-resume';
      chip.hidden = true;
      chip.addEventListener('click', function () {
        media.currentTime = media._resumeAt || 0;
        media.play();
        chip.hidden = true;
      });
      media._resumeChip = chip;
      controls.appendChild(chip);
    }

    // ── Back / forward ──
    var backSec = settings.backForward || settings.seekSeconds || 10;
    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'podcast-player-btn pp-btn pp-btn-back';
    back.setAttribute('aria-label', tpl(settings.labels.back, { s: backSec }));
    back.appendChild(icon('back'));
    back.addEventListener('click', function () {
      media.currentTime = Math.max(0, media.currentTime - backSec);
    });
    controls.appendChild(back);

    var forward = document.createElement('button');
    forward.type = 'button';
    forward.className = 'podcast-player-btn pp-btn pp-btn-forward';
    forward.setAttribute('aria-label', tpl(settings.labels.forward, { s: backSec }));
    forward.appendChild(icon('forward'));
    forward.addEventListener('click', function () {
      media.currentTime = Math.min(media.duration || Infinity, media.currentTime + backSec);
    });
    controls.appendChild(forward);

    // ── Chapter prev / next ──
    var chapPrev = document.createElement('button');
    chapPrev.type = 'button';
    chapPrev.className = 'podcast-player-btn pp-btn pp-btn-chap-prev';
    chapPrev.setAttribute('aria-label', settings.labels.chapPrev);
    chapPrev.appendChild(icon('chapPrev'));
    chapPrev.disabled = true;
    chapPrev.addEventListener('click', function () { chapterJump(media, -1); });
    controls.appendChild(chapPrev);

    var chapNext = document.createElement('button');
    chapNext.type = 'button';
    chapNext.className = 'podcast-player-btn pp-btn pp-btn-chap-next';
    chapNext.setAttribute('aria-label', settings.labels.chapNext);
    chapNext.appendChild(icon('chapNext'));
    chapNext.disabled = true;
    chapNext.addEventListener('click', function () { chapterJump(media, 1); });
    controls.appendChild(chapNext);
    media._chapPrevBtn = chapPrev;
    media._chapNextBtn = chapNext;

    // ── Time ──
    if (settings.showTime !== false) {
      var timeWrap = document.createElement('span');
      timeWrap.className = 'pp-time-wrap';
      var time = document.createElement('time');
      time.className = 'podcast-player-time pp-time';
      time.setAttribute('aria-live', 'off');
      time.dateTime = 'PT0S';
      time.textContent = '0:00 / 0:00';
      media._timeEl = time;
      timeWrap.appendChild(time);
      var remaining = document.createElement('span');
      remaining.className = 'pp-remaining';
      remaining.setAttribute('aria-hidden', 'true');
      remaining.textContent = '0:00';
      media._remainingEl = remaining;
      timeWrap.appendChild(remaining);
      controls.appendChild(timeWrap);
    }

    // ── Scrubber ──
    var scrubWrap = document.createElement('span');
    scrubWrap.className = 'pp-scrubber-wrap';
    var ticks = document.createElement('span');
    ticks.className = 'pp-ticks';
    ticks.setAttribute('aria-hidden', 'true');
    scrubWrap.appendChild(ticks);
    media._ticksEl = ticks;
    var scrub = document.createElement('input');
    scrub.type = 'range';
    scrub.className = 'pp-scrubber';
    scrub.min = 0;
    scrub.max = 0;
    scrub.step = 1;
    scrub.value = 0;
    scrub.setAttribute('aria-label', settings.labels.position);
    scrub.setAttribute('aria-valuetext', '0:00 / 0:00');
    media._scrubber = scrub;
    scrub.addEventListener('input', function () {
      var t = parseFloat(scrub.value) || 0;
      media.currentTime = t;
      updateTimeDisplay(media);
    });
    scrub.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(media, -backSec); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(media, backSec); }
      else if (e.key === 'Home') { e.preventDefault(); media.currentTime = 0; }
      else if (e.key === 'End') { e.preventDefault(); media.currentTime = media.duration || 0; }
    });
    scrubWrap.appendChild(scrub);

    // ── Scrubber tooltip (pointer-fine only, decorative) ──
    var tip = document.createElement('span');
    tip.className = 'pp-tooltip';
    tip.setAttribute('aria-hidden', 'true');
    scrubWrap.appendChild(tip);
    scrub.addEventListener('pointermove', function (e) {
      if (!pointerFine()) return;
      var r = scrub.getBoundingClientRect();
      var pct = r.width ? (e.clientX - r.left) / r.width : 0;
      pct = Math.max(0, Math.min(1, pct));
      tip.textContent = formatTime((isFinite(media.duration) ? media.duration : 0) * pct);
      tip.style.left = (pct * 100).toFixed(1) + '%';
    });
    scrub.addEventListener('pointerleave', function () {
      if (!pointerFine()) return;
      tip.style.left = '-9999px';
    });

    controls.appendChild(scrubWrap);

    // ── Speed ──
    if (settings.showSpeed) {
      var speed = document.createElement('button');
      speed.type = 'button';
      speed.className = 'podcast-player-btn pp-btn pp-speed';
      speed.setAttribute('aria-label', tpl(settings.labels.speed, { x: 1 }));
      speed.textContent = '1\u00D7';
      media._speedBtn = speed;
      speed.addEventListener('click', function () {
        var opts = settings.speedOptions || [1];
        var cur = media.playbackRate || 1;
        var next = opts[0];
        for (var i = 0; i < opts.length; i++) {
          if (Math.abs(opts[i] - cur) < 0.001) { next = opts[(i + 1) % opts.length]; break; }
        }
        media.playbackRate = next;
        try { sessionStorage.setItem(speedKey(media), String(next)); } catch (_) { /* ignore */ }
        speed.textContent = next + '\u00D7';
        speed.setAttribute('aria-label', tpl(settings.labels.speed, { x: next }));
        announce(wrap, tpl(settings.labels.speedChanged, { x: next }));
        updatePositionState(media);
      });
      controls.appendChild(speed);
    }

    // ── Volume ──
    if (settings.showVolume) {
      var volWrap = document.createElement('span');
      volWrap.className = 'pp-volume';
      var mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'podcast-player-btn pp-btn pp-mute';
      mute.setAttribute('aria-pressed', 'false');
      mute.setAttribute('aria-label', settings.labels.mute);
      mute.appendChild(icon('volume'));
      mute.addEventListener('click', function () {
        media.muted = !media.muted;
        syncMuteUI(media);
        announce(wrap, media.muted ? settings.labels.muted : settings.labels.unmuted);
      });
      volWrap.appendChild(mute);
      var vol = document.createElement('input');
      vol.type = 'range';
      vol.className = 'pp-volume-range';
      vol.min = 0;
      vol.max = 100;
      vol.value = 100;
      vol.setAttribute('aria-label', settings.labels.volume);
      // Restore persisted volume (0–1), if any.
      try {
        var savedVol = parseFloat(localStorage.getItem('pp-volume'));
        if (isFinite(savedVol) && savedVol >= 0 && savedVol <= 1) {
          media.volume = savedVol;
          vol.value = String(Math.round(savedVol * 100));
        }
      } catch (_) { /* storage unavailable */ }
      vol.addEventListener('input', function () {
        media.volume = (parseFloat(vol.value) || 0) / 100;
        if (media.volume > 0 && media.muted) media.muted = false;
        syncMuteUI(media);
        try { localStorage.setItem('pp-volume', String(media.volume)); } catch (_) { /* ignore */ }
      });
      volWrap.appendChild(vol);
      media._muteBtn = mute;
      media._volRange = vol;
      controls.appendChild(volWrap);
    }

    // ── Help ──
    if (settings.helpDialog) {
      var help = document.createElement('button');
      help.type = 'button';
      help.className = 'podcast-player-btn pp-btn pp-help';
      help.setAttribute('aria-label', settings.labels.help);
      help.appendChild(icon('help'));
      media._helpBtn = help;
      help.addEventListener('click', function () { openHelpDialog(wrap, media, help); });
      controls.appendChild(help);
    }

    return controls;
  }

  function syncPlayUI(media, playing) {
    if (!media._playBtn) return;
    if (playing === undefined) playing = !media.paused;
    media._playBtn.innerHTML = '';
    media._playBtn.appendChild(icon(playing ? 'pause' : 'play'));
    media._playBtn.setAttribute('aria-label', playing ? settings.labels.pause : settings.labels.play);
  }

  function syncMuteUI(media) {
    if (!media._muteBtn) return;
    media._muteBtn.innerHTML = '';
    media._muteBtn.appendChild(icon(media.muted ? 'muted' : 'volume'));
    media._muteBtn.setAttribute('aria-pressed', String(!!media.muted));
    media._muteBtn.setAttribute('aria-label', media.muted ? settings.labels.unmute : settings.labels.mute);
  }

  function seekBy(media, delta) {
    media.currentTime = Math.max(0, Math.min(media.duration || Infinity, media.currentTime + delta));
  }

  function chapterJump(media, dir) {
    var chapters = media._chapters;
    if (!chapters || !chapters.length) return;
    var t = media.currentTime;
    var idx = -1;
    for (var i = 0; i < chapters.length; i++) {
      if (t >= (parseFloat(chapters[i].startTime) || 0)) idx = i;
    }
    var target;
    if (dir < 0) {
      if (idx < 0) {
        target = chapters.length - 1; // before first chapter: wrap to last
      } else {
        var start = parseFloat(chapters[idx].startTime) || 0;
        // first press inside a chapter → its start; second press → previous
        target = (t - start > 1) ? idx : idx - 1;
      }
    } else {
      target = idx + 1;
    }
    if (target < 0 || target >= chapters.length) return;
    media.currentTime = parseFloat(chapters[target].startTime) || 0;
    media.play();
    announce(wrapFor(media), tpl(settings.labels.cueAt, { t: formatTime(media.currentTime) }));
  }

  function wrapFor(media) {
    return media.closest('.podcast-player') || document.body;
  }

  // Decorative hover interactions only on precise-pointer devices.
  function pointerFine() {
    try {
      return !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
    } catch (_) { return false; }
  }

  function drawScrubberTicks(media) {
    var ticks = media._ticksEl;
    if (!ticks) return;
    ticks.textContent = '';
    if (!media._chapters || !media._chapters.length) return;
    if (!isFinite(media.duration) || media.duration <= 0) return;
    var dur = media.duration;
    media._chapters.forEach(function (ch) {
      var start = parseFloat(ch.startTime) || 0;
      if (start <= 0 || start >= dur) return; // skip edge ticks
      var i = document.createElement('i');
      i.style.left = (start / dur * 100).toFixed(2) + '%';
      ticks.appendChild(i);
    });
  }

  function updateTimeDisplay(media) {
    if (media._timeEl) {
      media._timeEl.textContent = formatTime(media.currentTime) + ' / ' +
        (isFinite(media.duration) ? formatTime(media.duration) : '\u221E');
      media._timeEl.dateTime = timeDatetime(media.currentTime);
    }
    if (media._remainingEl) {
      var rem = (isFinite(media.duration) ? media.duration : 0) - media.currentTime;
      media._remainingEl.textContent = (rem > 0 ? '\u2212' : '') + formatTime(Math.abs(rem)) +
        ' ' + settings.labels.remaining;
    }
    if (media._scrubber) {
      var dur = isFinite(media.duration) ? media.duration : 0;
      media._scrubber.max = Math.max(0, Math.floor(dur));
      media._scrubber.value = String(Math.max(0, Math.min(Math.floor(media.currentTime), media._scrubber.max)));
      media._scrubber.setAttribute('aria-valuetext',
        formatTime(media.currentTime) + ' / ' + formatTime(dur));
      drawScrubberTicks(media);
    }
    if (media._chapPrevBtn && media._chapters && media._chapters.length) {
      var ch = chapterIndexAt(media, media.currentTime);
      media._chapPrevBtn.disabled = ch <= 0;
      media._chapNextBtn.disabled = ch < 0 || ch >= media._chapters.length - 1;
    }
  }

  function chapterIndexAt(media, t) {
    var chapters = media._chapters || [];
    var idx = -1;
    for (var i = 0; i < chapters.length; i++) {
      if (t >= (parseFloat(chapters[i].startTime) || 0)) idx = i;
    }
    return idx;
  }

  // ── Mini-player ─────────────────────────────────────────────────────

  function buildMiniPlayer(media, wrap) {
    if (!settings.miniPlayer) return;
    if (!('IntersectionObserver' in window)) return;
    var mini = document.createElement('div');
    mini.className = 'pp-mini';
    mini.setAttribute('role', 'region');
    mini.setAttribute('aria-label', settings.labels.miniPlayer);
    mini.hidden = true;

    var thumb = document.createElement('img');
    thumb.className = 'pp-mini-cover';
    thumb.alt = '';
    if (media._coverUrl) thumb.src = media._coverUrl;
    mini.appendChild(thumb);

    var title = document.createElement('span');
    title.className = 'pp-mini-title';
    title.textContent = trackTitle(media, playlist.findIndex(function (p) { return p.media === media; }));
    mini.appendChild(title);

    var pb = document.createElement('button');
    pb.type = 'button';
    pb.className = 'podcast-player-btn pp-btn pp-mini-play';
    pb.setAttribute('aria-label', settings.labels.play);
    pb.appendChild(icon('play'));
    pb.addEventListener('click', function () {
      if (media.paused) media.play(); else media.pause();
    });
    mini.appendChild(pb);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'podcast-player-btn pp-btn pp-mini-close';
    close.setAttribute('aria-label', settings.labels.closeMini);
    close.appendChild(icon('close'));
    close.addEventListener('click', function () { mini.hidden = true; });
    mini.appendChild(close);

    document.body.appendChild(mini);
    media._miniEl = mini;

    var visible = true;
    var io = new IntersectionObserver(function (entries) {
      var e = entries[0];
      visible = e.isIntersecting;
      syncMini();
    }, { threshold: 0 });
    io.observe(wrap);
    media.addEventListener('play', syncMini);
    media.addEventListener('pause', syncMini);
    media.addEventListener('ended', syncMini);

    function syncMini() {
      var playing = !media.paused && !media.ended;
      if (!visible && playing) {
        mini.hidden = false;
        pb.innerHTML = '';
        pb.appendChild(icon('pause'));
        pb.setAttribute('aria-label', settings.labels.pause);
        if (media._coverImg && media._coverImg.src) thumb.src = media._coverImg.src;
      } else {
        mini.hidden = true;
      }
    }
  }

  // ── Help dialog ─────────────────────────────────────────────────────

  function openHelpDialog(wrap, media, trigger) {
    var old = document.getElementById('pp-help-dialog');
    if (old) old.remove();

    var overlay = document.createElement('div');
    overlay.className = 'pp-help-overlay';
    overlay.id = 'pp-help-dialog';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', settings.labels.help);

    var box = document.createElement('div');
    box.className = 'pp-help';

    var h = document.createElement('h4');
    h.textContent = settings.labels.help;
    box.appendChild(h);

    var rows = [
      ['Space', settings.labels.play + ' / ' + settings.labels.pause],
      ['\u2190 \u2192', tpl(settings.labels.back, { s: backSecLabel() })],
      ['J / L', tpl(settings.labels.back, { s: backSecLabel() })],
      ['\u2191 \u2193', settings.labels.volume],
      ['M', settings.labels.mute + ' / ' + settings.labels.unmute],
      ['PageUp / PageDown', settings.labels.chapPrev + ' / ' + settings.labels.chapNext],
      ['T', settings.labels.transcript],
      ['C', settings.labels.chapters],
      ['?', settings.labels.help],
    ];
    var table = document.createElement('table');
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var k = document.createElement('td');
      k.textContent = r[0];
      var d = document.createElement('td');
      d.textContent = r[1];
      tr.appendChild(k); tr.appendChild(d);
      table.appendChild(tr);
    });
    box.appendChild(table);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'podcast-player-btn pp-help-close';
    close.textContent = settings.labels.closeHelp;
    close.addEventListener('click', function () { closeHelp(); });
    box.appendChild(close);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function closeHelp() {
      overlay.remove();
      if (trigger) trigger.focus();
    }

    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeHelp(); }
      else if (e.key === 'Tab') {
        var f = overlay.querySelectorAll('button');
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    close.focus();
  }

  function backSecLabel() {
    return String(settings.backForward || settings.seekSeconds || 10);
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

  function downloadStem(media) {
    var src = media.dataset.originalSrc || media.getAttribute('src') || '';
    return src.split('/').pop().replace(/[?#].*$/, '').replace(/\.m3u8$/i, '');
  }

  function buildDownload(el, wrap, controls) {
    if (!settings.showDownload) return;
    var src = el.getAttribute('src') || el.dataset.originalSrc || '';
    if (!/\.m3u8(?:[?#]|$)/i.test(src)) return;

    var a = document.createElement('a');
    a.className = 'podcast-player-btn podcast-player-download pp-btn pp-btn-download';
    a.textContent = settings.downloadLabel;
    a.download = '';
    a.setAttribute('aria-label', settings.labels.download + ' \u2014 ' + downloadStem(el) + '.m4a');

    var override = el.dataset.download;
    if (override) {
      a.href = isAbsolute(override) ? override : resolve(override);
      controls.appendChild(a);
      return;
    }

    a.href = resolve(src).replace(/\.m3u8(?:[?#].*)?$/i, '.m4a');

    if (('serviceWorker' in navigator) && navigator.serviceWorker.controller) {
      var ctrlScope = navigator.serviceWorker.controller.scriptURL
        .replace(/[^/]*$/, '');
      if (a.href.indexOf(ctrlScope) !== 0) {
        var pages = /^https?:\/\/([^/]+)\.codeberg\.page\/([^/]+)(\/.*)$/
          .exec(a.href);
        if (pages) {
          a.href = location.origin + basePath() + '/remote/codeberg.org/' +
                   pages[1] + '/' + pages[2] + pages[3];
        }
      }
    }

    a.addEventListener('click', function (ev) {
      var swReady = false;
      if (('serviceWorker' in navigator) && navigator.serviceWorker.controller) {
        var ctrlScope = navigator.serviceWorker.controller.scriptURL
          .replace(/[^/]*$/, '');
        swReady = a.href.indexOf(ctrlScope) === 0;
      }
      if (swReady) return;
      ev.preventDefault();
      remuxAndDownload(el, a, wrap);
    });
    controls.appendChild(a);
  }

  function remuxAndDownload(el, a, wrap) {
    var src = resolve(el.getAttribute('src') || el.dataset.originalSrc || '');
    var label = a.textContent;
    a.textContent = settings.downloadBusyLabel;
    a.setAttribute('aria-disabled', 'true');
    a.setAttribute('aria-busy', 'true');
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
      a.removeAttribute('aria-busy');
      announce(wrap, settings.labels.downloadStarted);
    }).catch(function () {
      a.textContent = label;
      a.removeAttribute('aria-disabled');
      a.removeAttribute('aria-busy');
      var err = document.createElement('span');
      err.className = 'podcast-player-error-msg pp-error';
      err.setAttribute('role', 'alert');
      err.textContent = ' ' + settings.labels.downloadFailed;
      a.parentNode.insertBefore(err, a.nextSibling);
      announce(wrap, settings.labels.downloadFailed);
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
      navigator.mediaSession.setActionHandler('play', function () {
        if (activeAudio) activeAudio.play();
        else if (playlist.length) goTo(0, true);
      });
      navigator.mediaSession.setActionHandler('pause', function () {
        if (activeAudio) activeAudio.pause();
      });
      navigator.mediaSession.setActionHandler('stop', function () {
        if (activeAudio) { activeAudio.pause(); activeAudio.currentTime = 0; }
      });
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

  function artworkEntry(url, size) {
    var type = '';
    var m = /\.(png|jpe?g|webp|gif|avif)$/i.exec(String(url).split('?')[0]);
    if (m) {
      type = m[1].toLowerCase();
      if (type === 'jpg') type = 'jpeg';
      type = 'image/' + type;
    }
    var entry = { src: url, sizes: size || 'any' };
    if (type) entry.type = type;
    return entry;
  }

  function updatePositionState(el) {
    var ms = navigator.mediaSession;
    if (!ms || typeof ms.setPositionState !== 'function') return;
    if (!isFinite(el.duration) || el.duration <= 0) return;
    try {
      ms.setPositionState({
        duration: el.duration,
        playbackRate: el.playbackRate || 1,
        position: el.currentTime || 0,
      });
    } catch (e) { /* ignore */ }
  }

  function setPlaybackState(state) {
    var ms = navigator.mediaSession;
    if (!ms) return;
    try { ms.playbackState = state; } catch (e) { /* ignore */ }
  }

  function updateMediaSession(el, index) {
    if (!navigator.mediaSession || !window.MediaMetadata) return;
    var title = trackTitle(el, index) || (document.title || 'Podcast');
    var artwork = [];
    if (el._coverUrl) {
      artwork.push(artworkEntry(el._coverUrl, el._coverSize || 'any'));
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
          var info = { title: ch.title || '', startTime: parseFloat(ch.startTime) || 0 };
          if (ch.img) {
            var imgUrl = isAbsolute(ch.img) ? ch.img : resolve(ch.img);
            info.artwork = [artworkEntry(imgUrl)];
          }
          return info;
        });
      }
      navigator.mediaSession.metadata = new MediaMetadata(meta);
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
    bar.className = 'podcast-player-toolbar pp-toolbar';

    if (playlist.length > 1) {
      var prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'podcast-player-btn podcast-player-prev pp-btn';
      prev.textContent = settings.prevLabel;
      prev.title = settings.prevTitle;
      prev.setAttribute('aria-label', settings.prevTitle);
      prev.disabled = index === 0;
      prev.addEventListener('click', function () { goTo(index - 1, true); });

      var next = document.createElement('button');
      next.type = 'button';
      next.className = 'podcast-player-btn podcast-player-next pp-btn';
      next.textContent = settings.nextLabel;
      next.title = settings.nextTitle;
      next.setAttribute('aria-label', settings.nextTitle);
      next.disabled = index === playlist.length - 1;
      next.addEventListener('click', function () { goTo(index + 1, true); });

      var label = document.createElement('span');
      label.className = 'podcast-player-title pp-title-label';
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

  function isInteractiveTarget(e) {
    var t = e.target;
    if (!t || t === e.currentTarget) return false;
    if (t.closest('input, textarea, select, button, a, [contenteditable="true"]')) return true;
    return false;
  }

  function setupKeyboard(wrap, el) {
    wrap.setAttribute('aria-keyshortcuts',
      'Space ArrowLeft ArrowRight ArrowUp ArrowDown KeyJ KeyL KeyM PageUp PageDown KeyT KeyC Slash');
    wrap.addEventListener('keydown', function (e) {
      // Never hijack keys while a control is focused (buttons, sliders…),
      // whether the event targets the control itself or bubbles from a container.
      if (isInteractiveTarget(e)) return;
      var fe = document.activeElement;
      if (fe && fe !== document.body && fe !== document.documentElement &&
          fe.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
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
        case 'KeyJ':
          e.preventDefault();
          el.currentTime = Math.max(0, el.currentTime - (settings.backForward || settings.seekSeconds || 10));
          break;
        case 'KeyL':
          e.preventDefault();
          el.currentTime = Math.min(el.duration || Infinity, el.currentTime + (settings.backForward || settings.seekSeconds || 10));
          break;
        case 'Slash':
          if (e.shiftKey) { // '?' — shortcuts help
            e.preventDefault();
            openHelpDialog(wrap, el, el._helpBtn || null);
          }
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
          syncMuteUI(el);
          announce(wrap, el.muted ? settings.labels.muted : settings.labels.unmuted);
          break;
        case 'PageUp':
          e.preventDefault();
          chapterJump(el, -1);
          break;
        case 'PageDown':
          e.preventDefault();
          chapterJump(el, 1);
          break;
        case 'KeyT':
          e.preventDefault();
          toggleTranscript(wrap);
          break;
        case 'KeyC':
          e.preventDefault();
          toggleChapters(wrap);
          break;
      }
    });
  }

  function toggleTranscript(wrap) {
    var btn = wrap.querySelector('.podcast-player-transcript-btn');
    if (btn) btn.click();
  }

  function toggleChapters(wrap) {
    var det = wrap.querySelector('.podcast-player-chapters');
    if (det) det.open = !det.open;
  }

  // ── Position persistence ────────────────────────────────────────────

  function speedKey(el) {
    var src = el.dataset.originalSrc || el.getAttribute('src') || '';
    return 'podcast-speed:' + src;
  }

  function positionKey(el) {
    var src = el.dataset.originalSrc || el.getAttribute('src') || '';
    return 'podcast-pos:' + src;
  }

  // Position survives across visits (localStorage); sessionStorage is a
  // legacy fallback for saves from older releases.
  function readPosition(el) {
    var key = positionKey(el);
    var v = null;
    try { v = localStorage.getItem(key); } catch (_) { /* ignore */ }
    if (v === null || v === '') {
      try { v = sessionStorage.getItem(key); } catch (_) { /* ignore */ }
    }
    var t = parseFloat(v);
    return isFinite(t) && t > 0 ? t : NaN;
  }

  function clearPosition(el) {
    var key = positionKey(el);
    try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
    try { sessionStorage.removeItem(key); } catch (_) { /* ignore */ }
  }

  function savePosition(el) {
    if (!el.duration || el.seeking) return;
    try { localStorage.setItem(positionKey(el), String(el.currentTime)); } catch (_) { /* ignore */ }
  }

  function restorePosition(el) {
    var t = readPosition(el);
    if (isFinite(t)) el.currentTime = t;
  }

  // ── Enhance one <audio> ──────────────────────────────────────────────

  function enhance(el, index, mediaEl) {
    if (el.dataset.podcastEnhanced) return;
    el.dataset.podcastEnhanced = '1';

    if (!el.parentNode) return;
    // Unified mode: the UI binds to the persistent global audio; the page
    // element stays as the source descriptor (src/dataset). Non-unified:
    // media === el (unchanged behaviour).
    var media = mediaEl || el;
    var wrap = document.createElement('div');
    wrap.className = 'podcast-player';
    wrap.dataset.print = settings.print || 'hide';
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', trackTitle(el, index) || 'Podcast player');
    el.parentNode.insertBefore(wrap, el);

    var bar = buildToolbar(playlist[index], index);
    if (bar.childNodes.length) wrap.appendChild(bar);

    var card = document.createElement('div');
    card.className = 'pp-card';
    wrap.appendChild(card);

    var main = document.createElement('div');
    main.className = 'pp-main';
    card.appendChild(main);

    var meta = document.createElement('div');
    meta.className = 'pp-meta';
    var titleEl = document.createElement('h3');
    titleEl.className = 'pp-title';
    titleEl.textContent = trackTitle(el, index) || '';
    var sub = document.createElement('div');
    sub.className = 'pp-sub';
    sub.textContent = [settings.artist, settings.album].filter(Boolean).join(' \u00B7 ');
    meta.appendChild(titleEl);
    meta.appendChild(sub);
    main.appendChild(meta);

    addCover(media, wrap, main);

    var controls = buildControls(media, wrap, card);
    buildDownload(el, wrap, controls);

    var panels = document.createElement('div');
    panels.className = 'pp-panels';
    card.appendChild(panels);
    buildChapters(media, wrap, panels);
    buildTranscript(media, wrap, panels);

    wrap.appendChild(el);

    media.addEventListener('loadedmetadata', function () {
      restorePosition(media);
      updatePositionState(media);
      if (settings.resumeChip && el._resumeChip) {
        var saved = readPosition(el);
        if (isFinite(saved) && saved > 15 && isFinite(el.duration) && saved < el.duration - 30) {
          media._resumeAt = saved;
          media._resumeChip.textContent = tpl(settings.labels.resume, { t: formatTime(saved) });
          media._resumeChip.hidden = false;
        }
      }
      try {
        if (sessionStorage.getItem('podcast-autoplay') === '1') {
          sessionStorage.removeItem('podcast-autoplay');
          var p = media.play();
          if (p && p.catch) p.catch(function () { /* autoplay blocked */ });
        }
      } catch (_) { /* ignore */ }
    }, { once: true });
    media.addEventListener('timeupdate', function () {
      savePosition(media);
      updatePositionState(media);
      updateTimeDisplay(media);
    });
    media.addEventListener('durationchange', function () {
      updatePositionState(media);
      updateTimeDisplay(media);
    });
    media.addEventListener('ratechange', function () { updatePositionState(media); });
    media.addEventListener('seeked', function () {
      updatePositionState(media);
      updateTimeDisplay(media);
    });
    media.addEventListener('pause', function () {
      savePosition(media);
      setPlaybackState('paused');
      syncPlayUI(media, false);
      wrap.classList.remove('pp-active');
      if (activeAudio === media) activeAudio = null;
    });
    media.addEventListener('ended', function () {
      setPlaybackState('paused');
      syncPlayUI(media, false);
      clearPosition(media);
      if (media._resumeChip) media._resumeChip.hidden = true;
    });

    media.addEventListener('play', function () {
      activeAudio = media;
      attachHls(media);
      updateMediaSession(media, index);
      setPlaybackState('playing');
      updatePositionState(media);
      syncPlayUI(media, true);
      wrap.classList.add('pp-active');
      playlist.forEach(function (p) {
        if (p.el !== el) {
          p.el.pause();
          var w = p.el.closest('.podcast-player');
          if (w) w.classList.remove('pp-active');
        }
      });
    }, { once: false });

    // Restore persisted speed (per-episode key, legacy global fallback)
    try {
      var sp = parseFloat(sessionStorage.getItem(speedKey(el)) ||
        sessionStorage.getItem('podcast-speed'));
      if (sp && settings.speedOptions && settings.speedOptions.indexOf(sp) !== -1) {
        el.playbackRate = sp;
        if (el._speedBtn) {
          el._speedBtn.textContent = sp + '\u00D7';
          el._speedBtn.setAttribute('aria-label', tpl(settings.labels.speed, { x: sp }));
        }
      }
    } catch (_) { /* ignore */ }

    setupKeyboard(wrap, media);
    if (!settings.unified) buildMiniPlayer(el, wrap);
    attachHls(media);
    if (!media.paused) syncPlayUI(media, true);

    // Mark enhanced: hide native controls via CSS.
    wrap.dataset.enhanced = '1';
  }

  // ── Styles (v2) ──────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('podcast-player-styles-v2')) return;
    var css = [
      // ── Tokens ──
      '.podcast-player {',
      '  --pp-accent: var(--theme-color, #3b6ea5);',
      '  --pp-accent-contrast: #fff;',
      '  --pp-bg: #ffffff;',
      '  --pp-bg-alt: #f4f6f8;',
      '  --pp-text: #1c1e21;',
      '  --pp-text-muted: #5b6470;',
      '  --pp-border: #d5dae1;',
      '  --pp-radius: 12px;',
      '  --pp-control: 40px;',
      '  --pp-cover: 120px;',
      '  --pp-shadow: 0 1px 3px rgb(0 0 0 / .10), 0 4px 16px rgb(0 0 0 / .06);',
      '  --pp-focus: 0 0 0 2px var(--pp-bg), 0 0 0 4px var(--pp-accent);',
      '  --pp-tick: rgb(127 127 127 / .55);',
      '}',
      '@media (prefers-color-scheme: dark) {',
      '  .podcast-player {',
      '    --pp-bg: #1f2328;',
      '    --pp-bg-alt: #262b31;',
      '    --pp-text: #e8eaed;',
      '    --pp-text-muted: #a8b0ba;',
      '    --pp-border: #3a4149;',
      '    --pp-shadow: 0 1px 3px rgb(0 0 0 / .5);',
      '  }',
      '}',
      // ── Card ──
      '.podcast-player { margin: 1.25em 0; outline: none; }',
      '.podcast-player:focus-visible, .podcast-player .pp-card:focus-visible {',
      '  box-shadow: var(--pp-focus); border-radius: var(--pp-radius); }',
      '.pp-card {',
      '  background: var(--pp-bg); color: var(--pp-text);',
      '  border: 1px solid var(--pp-border); border-radius: var(--pp-radius);',
      '  box-shadow: var(--pp-shadow);',
      '  padding: .9em; display: flex; flex-direction: column; gap: .7em;',
      '}',
      '.podcast-player.pp-active .pp-card {',
      '  border-color: var(--pp-accent); box-shadow: 0 0 0 1px var(--pp-accent), var(--pp-shadow);',
      '}',
      '.pp-main { display: flex; gap: 1em; align-items: flex-start; }',
      '.podcast-player-cover {',
      '  width: var(--pp-cover); height: var(--pp-cover); object-fit: cover;',
      '  border-radius: 8px; flex: 0 0 auto; background: var(--pp-bg-alt);',
      '}',
      '.pp-meta { min-width: 0; flex: 1 1 auto; }',
      '.pp-title { margin: 0 0 .15em; font-size: 1.05em; line-height: 1.3; }',
      '.pp-sub { color: var(--pp-text-muted); font-size: .85em; margin-bottom: .2em; }',
      '.podcast-player-chapter-now {',
      '  color: var(--pp-accent); font-size: .85em; font-weight: 600;',
      '}',
      // ── Native audio hidden when enhanced ──
      '.podcast-player[data-enhanced="1"] audio {',
      '  position: absolute; width: 1px; height: 1px; overflow: hidden;',
      '  clip: rect(0 0 0 0); white-space: nowrap; clip-path: inset(50%);',
      '}',
      // ── Controls ──
      '.pp-controls { display: flex; flex-wrap: wrap; align-items: center; gap: .4em; }',
      '.podcast-player-btn {',
      '  border: 1px solid var(--pp-border); background: var(--pp-bg-alt);',
      '  color: var(--pp-text); border-radius: 8px; cursor: pointer;',
      '  min-height: var(--pp-control); min-width: var(--pp-control);',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  gap: .35em; padding: .2em .6em; font-size: .95em; line-height: 1.2;',
      '  transition: background .15s, border-color .15s, color .15s;',
      '}',
      '.podcast-player-btn:hover { border-color: var(--pp-accent); }',
      '.podcast-player-btn:focus-visible, .pp-scrubber:focus-visible,',
      '.pp-volume-range:focus-visible, .pp-transcript-search:focus-visible,',
      '.podcast-player-chapter-link:focus-visible, .podcast-player-cue:focus-visible {',
      '  outline: none; box-shadow: var(--pp-focus); }',
      '.podcast-player-btn:disabled { opacity: .45; cursor: default; }',
      '.pp-icon { display: inline-flex; }',
      '.pp-btn-play { background: var(--pp-accent); color: var(--pp-accent-contrast);',
      '  border-color: var(--pp-accent); border-radius: 50%; }',
      '.pp-btn-play:hover { filter: brightness(1.08); }',
      '.podcast-player-time { font-variant-numeric: tabular-nums; font-size: .85em;',
      '  color: var(--pp-text-muted); white-space: nowrap; }',
      '.pp-time-wrap { position: relative; display: inline-flex; align-items: baseline; }',
      '.pp-remaining { display: none; font-variant-numeric: tabular-nums; font-size: .85em;',
      '  color: var(--pp-text-muted); white-space: nowrap; }',
      '@media (hover: hover) and (pointer: fine) {',
      '  .pp-time-wrap:hover .podcast-player-time { display: none; }',
      '  .pp-time-wrap:hover .pp-remaining { display: inline; }',
      '}',
      '.pp-scrubber-wrap { position: relative; flex: 1 1 120px; min-width: 90px;',
      '  display: flex; align-items: center; }',
      '.pp-scrubber { flex: 1; width: 100%; min-width: 0; accent-color: var(--pp-accent); }',
      '.pp-ticks { position: absolute; left: 0; right: 0; top: 50%;',
      '  transform: translateY(-50%); pointer-events: none; height: 0; }',
      '.pp-ticks i { position: absolute; top: 0; width: 2px; height: 14px;',
      '  margin-top: -7px; border-radius: 1px; background: var(--pp-tick); }',
      '.pp-tooltip { position: absolute; top: -1.9em; transform: translateX(-50%);',
      '  background: var(--pp-text); color: var(--pp-bg); font-size: .72em;',
      '  padding: .2em .55em; border-radius: 4px; pointer-events: none;',
      '  white-space: nowrap; opacity: 0; transition: opacity .12s; z-index: 2; }',
      '@media (hover: hover) and (pointer: fine) {',
      '  .pp-scrubber-wrap:hover .pp-tooltip { opacity: 1; }',
      '}',
      '.pp-volume { display: inline-flex; align-items: center; gap: .3em; }',
      '.pp-volume-range { width: 70px; accent-color: var(--pp-accent); }',
      '.pp-speed { min-width: 3em; }',
      '.pp-resume { color: var(--pp-accent); border-color: var(--pp-accent); }',
      // ── Panels ──
      '.pp-panels { display: grid; gap: .7em; }',
      '@media (min-width: 900px) { .pp-panels { grid-template-columns: 1fr 1fr; } }',
      '.podcast-player-chapters { font-size: .92em; }',
      '.podcast-player-chapters summary { cursor: pointer; font-weight: 600;',
      '  padding: .3em 0; }',
      '.podcast-player-chapters ol { margin: .3em 0; padding-left: 1.3em;',
      '  max-height: 16em; overflow: auto; }',
      '.podcast-player-chapters li { border-radius: 6px; }',
      '.podcast-player-chapter-link {',
      '  display: block; width: 100%; text-align: left; border: 0; background: none;',
      '  color: var(--pp-text); padding: .35em .4em; border-radius: 6px;',
      '  cursor: pointer; font-size: .95em; line-height: 1.35;',
      '}',
      '.podcast-player-chapter-link:hover { background: var(--pp-bg-alt); }',
      '.podcast-player-chapters li.active .podcast-player-chapter-link {',
      '  background: var(--pp-accent); color: var(--pp-accent-contrast);',
      '  font-weight: 600;',
      '}',
      '.podcast-player-transcript-btn {',
      '  border: 1px solid var(--pp-border); background: var(--pp-bg-alt);',
      '  color: var(--pp-text); border-radius: 8px; cursor: pointer;',
      '  padding: .3em .7em; font-size: .9em;',
      '}',
      '.podcast-player-transcript-btn:hover { border-color: var(--pp-accent); }',
      '.podcast-player-transcript {',
      '  position: relative; max-height: 18em; overflow: auto; border: 1px solid var(--pp-border);',
      '  border-radius: 8px; padding: .5em .8em; font-size: .92em; line-height: 1.55;',
      '}',
      '.pp-refollow { position: sticky; bottom: .4em; float: right; margin: 0 0 -.4em;',
      '  background: var(--pp-accent); color: var(--pp-accent-contrast);',
      '  border-color: var(--pp-accent); font-size: .85em; }',
      '.pp-refollow[hidden] { display: none; }',
      '.podcast-player-transcript p { margin: .2em 0; padding: .1em .3em; border-radius: 6px; }',
      '.podcast-player-transcript p[aria-current="true"] {',
      '  background: var(--pp-accent); color: var(--pp-accent-contrast);',
      '}',
      '.podcast-player-cue {',
      '  border: 0; background: none; padding: 0; margin-right: .3em;',
      '  color: var(--pp-accent); cursor: pointer;',
      '  font-variant-numeric: tabular-nums; font-weight: 600;',
      '}',
      '.pp-cue-speaker { font-weight: 700; color: var(--pp-text); }',
      '.podcast-player-transcript p[aria-current="true"] .podcast-player-cue {',
      '  color: var(--pp-accent-contrast);',
      '}',
      '.pp-transcript-header { display: flex; flex-wrap: wrap; gap: .5em;',
      '  align-items: center; margin-bottom: .4em; }',
      '.pp-transcript-search {',
      '  border: 1px solid var(--pp-border); border-radius: 8px; padding: .3em .6em;',
      '  font-size: .9em; background: var(--pp-bg); color: var(--pp-text);',
      '  flex: 1 1 140px; min-width: 100px;',
      '}',
      '.pp-follow {',
      '  border: 1px solid var(--pp-border); background: var(--pp-bg-alt);',
      '  border-radius: 8px; padding: .3em .6em; font-size: .85em; cursor: pointer;',
      '  color: var(--pp-text);',
      '}',
      '.pp-follow[aria-pressed="true"] { border-color: var(--pp-accent);',
      '  color: var(--pp-accent); }',
      // ── Toolbar ──
      '.podcast-player-toolbar { display: flex; align-items: center; gap: .5em;',
      '  margin-bottom: .4em; }',
      '.podcast-player-title { font-size: .85em; color: var(--pp-text-muted);',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      // ── Loading / error / live ──
      '.podcast-player-loading { color: var(--pp-accent); font-size: 1.2em;',
      '  animation: pp-pulse 1.2s ease-in-out infinite; }',
      '.podcast-player-error { color: #c33; font-size: .9em; padding: .3em 0; }',
      '.podcast-player-error-msg { color: #c33; font-size: .9em; }',
      '.podcast-player-retry { min-height: 2em; min-width: 5em; margin-left: .4em; }',
      '.pp-live { position: absolute; width: 1px; height: 1px; overflow: hidden;',
      '  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }',
      '.podcast-player { position: relative; }',
      '@keyframes pp-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }',
      // ── Mini player ──
      '.pp-mini {',
      '  position: fixed; left: 0; right: 0; bottom: 0; z-index: 9999;',
      '  display: flex; align-items: center; gap: .7em; padding: .5em 1em;',
      '  padding-bottom: calc(.5em + env(safe-area-inset-bottom));',
      '  background: var(--pp-bg); color: var(--pp-text);',
      '  border-top: 1px solid var(--pp-border); box-shadow: 0 -2px 12px rgb(0 0 0 / .15);',
      '}',
      '.pp-mini-cover { width: 40px; height: 40px; object-fit: cover; border-radius: 6px; }',
      '.pp-mini-title { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis;',
      '  white-space: nowrap; font-size: .9em; }',
      // ── Help dialog ──
      '.pp-help-overlay {',
      '  position: fixed; inset: 0; z-index: 10000; display: flex;',
      '  align-items: center; justify-content: center;',
      '  background: rgb(0 0 0 / .45); padding: 1em;',
      '}',
      '.pp-help {',
      '  background: var(--pp-bg); color: var(--pp-text);',
      '  border: 1px solid var(--pp-border); border-radius: var(--pp-radius);',
      '  padding: 1.2em; max-width: 30em; width: 100%; max-height: 80vh; overflow: auto;',
      '  box-shadow: var(--pp-shadow);',
      '}',
      '.pp-help h4 { margin: 0 0 .6em; }',
      '.pp-help table { border-collapse: collapse; width: 100%; font-size: .92em; }',
      '.pp-help td { padding: .25em .5em; border-bottom: 1px solid var(--pp-border); }',
      '.pp-help td:first-child { font-weight: 600; white-space: nowrap; }',
      '.pp-help-close { margin-top: .8em; }',
      // ── Unified player (global bar + surfaces) ──
      '.pp-global { position: fixed; left: 0; right: 0; bottom: 0; z-index: 9000;',
      '  padding: .5em .8em calc(.5em + env(safe-area-inset-bottom));',
      '  background: var(--pp-bg); border-top: 1px solid var(--pp-border);',
      '  box-shadow: 0 -2px 12px rgb(0 0 0 / .08); }',
      '.pp-global[hidden] { display: none; }',
      '.pp-global-bar { display: flex; align-items: center; gap: .6em;',
      '  max-width: 1100px; margin: 0 auto; }',
      '.pp-global-cover { width: 44px; height: 44px; object-fit: cover;',
      '  border-radius: 6px; flex: 0 0 auto; background: var(--pp-bg-alt); }',
      '.pp-global-meta { min-width: 0; flex: 0 1 24%; display: flex;',
      '  flex-direction: column; line-height: 1.25; }',
      '.pp-global-title { font-weight: 600; font-size: .88em;',
      '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.pp-global-now { font-size: .75em; color: var(--pp-text-muted);',
      '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.pp-global-scrubber { flex: 1 1 auto; min-width: 60px;',
      '  accent-color: var(--pp-accent); }',
      '.pp-global-time { font-size: .78em; font-variant-numeric: tabular-nums;',
      '  color: var(--pp-text-muted); white-space: nowrap; }',
      '.pp-surface { padding: .8em; border: 1px solid var(--pp-border);',
      '  border-radius: var(--pp-radius); background: var(--pp-bg);',
      '  color: var(--pp-text); }',
      '.pp-surface-main { display: flex; gap: .9em; align-items: center; }',
      '.pp-surface .podcast-player-cover { width: 56px; height: 56px; }',
      '.pp-surface .pp-title { font-size: .98em; margin: 0; }',
      '.pp-surface-controls { display: flex; align-items: center; gap: .5em;',
      '  margin-top: .6em; }',
      '.pp-now-playing { display: flex; align-items: center; gap: .5em;',
      '  margin-top: .6em; font-size: .85em; color: var(--pp-text-muted); }',
      '.pp-now-playing[hidden] { display: none; }',
      '.pp-now-playing .pp-switch { font-size: .85em; }',
      '@media (max-width: 559px) {',
      '  .pp-global-cover { width: 38px; height: 38px; }',
      '  .pp-global-meta { flex-basis: 40%; }',
      '  .pp-global-time { display: none; }',
      '}',
      // ── Reduced motion ──
      '@media (prefers-reduced-motion: reduce) {',
      '  .podcast-player-loading { animation: none; }',
      '  .podcast-player, .podcast-player * { transition: none !important; }',
      '  .podcast-player * { scroll-behavior: auto !important; }',
      '}',
      // ── Forced colors ──
      '@media (forced-colors: active) {',
      '  .podcast-player-btn, .pp-card, .podcast-player-transcript,',
      '  .pp-transcript-search, .pp-help { border: 1px solid CanvasText; }',
      '  .pp-ticks i { background: CanvasText; }',
      '  .pp-btn-play, .podcast-player-chapters li.active,',
      '  .podcast-player-transcript p[aria-current="true"] {',
      '    background: Highlight; color: HighlightText; }',
      '}',
      // ── Print ──
      '@media print {',
      '  .podcast-player[data-print="hide"] { display: none; }',
      '  .podcast-player[data-print="keep-title"] .pp-controls,',
      '  .podcast-player[data-print="keep-title"] .pp-panels,',
      '  .podcast-player[data-print="keep-title"] audio,',
      '  .podcast-player[data-print="keep-title"] .podcast-player-cover { display: none; }',
      '  .podcast-player[data-print="keep-title"] .pp-card { box-shadow: none; border: 0; }',
      '}',
      // ── Base tier (<560px) ──
      '@media (max-width: 559px) {',
      '  .podcast-player { --pp-cover: 88px; }',
      '  .pp-controls { gap: .3em; }',
      '  .podcast-player-btn { min-height: 44px; min-width: 44px; }',
      '  .pp-scrubber-wrap { flex: 1 1 100%; order: 10; }',
      '  .pp-time-wrap { order: 9; }',
      '  .pp-volume-range { width: 56px; }',
      '}',
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'podcast-player-styles-v2';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Service worker (download synthesis) ─────────────────────────────

  var swRegistered = false;

  // Site root URL (with trailing slash) — where sw.js lives.
  function siteRootUrl() {
    var bp = window.$docsify && window.$docsify.basePath;
    if (bp && /^https?:\/\//.test(String(bp))) return String(bp).replace(/\/?$/, '/');
    if (bp && bp !== '/') return String(bp).replace(/^\/?(.*?)\/?$/, '/$1/');
    return location.pathname.replace(/[^/]*$/, '');
  }

  function probeSw(root, path) {
    return fetch(root + path, { method: 'HEAD', cache: 'no-store' })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }

  // Register the download-synthesis service worker once per page. The SW
  // script must be same-origin (spec constraint), so the site serves it at
  // its root; the plugin only wires up the registration — no dedicated
  // script needed in index.html. ?v=<version> pins the script URL so a new
  // plugin release automatically forces an SW update in browsers.
  function registerDownloadSw() {
    if (swRegistered) return;
    if (!settings.downloadSw) return;
    if (!('serviceWorker' in navigator)) return;
    swRegistered = true; // attempt once per page load
    var root = siteRootUrl();
    var path = settings.downloadSw === true ? 'sw.js' : String(settings.downloadSw);
    var doRegister = function () {
      navigator.serviceWorker.register(root + path + '?v=' + PLUGIN_VERSION)
        .then(function (r) { if (r && r.update) r.update(); })
        .catch(function () { /* main-thread remux fallback still works */ });
    };
    if (settings.downloadSw === true) {
      var cached = null;
      try { cached = sessionStorage.getItem('pp-sw-probe'); } catch (_) { /* ignore */ }
      if (cached === '1') { doRegister(); return; }
      if (cached === '0') return;
      probeSw(root, path).then(function (ok) {
        try { sessionStorage.setItem('pp-sw-probe', ok ? '1' : '0'); } catch (_) { /* ignore */ }
        if (ok) doRegister();
      });
    } else {
      doRegister();
    }
  }

  // ── Unified player (persistent playback across navigation) ──────────
  // `unified: true` — a single persistent audio element lives in a fixed
  // bottom bar (never destroyed by docsify's page swaps). Page <audio>
  // elements become lightweight surfaces that load their episode into the
  // global player on play. Navigation no longer stops playback.

  var gAudio = null;   // the one persistent media element
  var gWrap = null;    // .pp-global container (fixed bottom bar)
  var gLoadedSrc = ''; // source currently loaded in the global player
  var gLoadedRoute = ''; // docsify route where the current source lives
  var gSurfaces = [];  // live page-surface sync functions (pruned on enhance)

  function ensureGlobalPlayer() {
    if (gAudio) return;
    gWrap = document.createElement('div');
    gWrap.className = 'pp-global';
    gWrap.setAttribute('role', 'region');
    gWrap.setAttribute('aria-label', settings.labels.miniPlayer || 'Lecteur');
    gAudio = document.createElement('audio');
    gAudio.className = 'pp-global-audio';
    gWrap.appendChild(gAudio);

    var bar = document.createElement('div');
    bar.className = 'pp-global-bar';
    var cover = document.createElement('img');
    cover.className = 'pp-global-cover';
    cover.alt = '';
    bar.appendChild(cover);
    var meta = document.createElement('div');
    meta.className = 'pp-global-meta';
    var title = document.createElement('span');
    title.className = 'pp-global-title';
    meta.appendChild(title);
    var now = document.createElement('span');
    now.className = 'pp-global-now';
    meta.appendChild(now);
    bar.appendChild(meta);
    var scrub = document.createElement('input');
    scrub.type = 'range';
    scrub.className = 'pp-global-scrubber';
    scrub.min = 0; scrub.max = 0; scrub.step = 1; scrub.value = 0;
    scrub.setAttribute('aria-label', settings.labels.position);
    bar.appendChild(scrub);
    var time = document.createElement('span');
    time.className = 'pp-global-time';
    time.setAttribute('aria-live', 'off');
    bar.appendChild(time);
    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'podcast-player-btn pp-btn pp-global-play';
    play.setAttribute('aria-label', settings.labels.play);
    play.appendChild(icon('play'));
    bar.appendChild(play);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'podcast-player-btn pp-btn pp-global-close';
    close.setAttribute('aria-label', settings.labels.closeMini);
    close.appendChild(icon('close'));
    bar.appendChild(close);

    play.addEventListener('click', function () {
      if (gAudio.paused) { var p = gAudio.play(); if (p && p.catch) p.catch(function () {}); }
      else gAudio.pause();
    });
    close.addEventListener('click', function () {
      gAudio.pause();
      gWrap.hidden = true;
    });
    scrub.addEventListener('input', function () {
      gAudio.currentTime = parseFloat(scrub.value) || 0;
      syncGlobalBar();
    });

    gAudio.addEventListener('play', function () { syncGlobalPlayUI(true); });
    gAudio.addEventListener('pause', function () { syncGlobalPlayUI(false); });
    gAudio.addEventListener('ended', function () {
      clearPosition(gAudio);
      syncGlobalPlayUI(false);
    });
    gAudio.addEventListener('loadedmetadata', function () {
      restorePosition(gAudio);
      syncGlobalBar();
    });
    gAudio.addEventListener('timeupdate', function () {
      savePosition(gAudio);
      syncGlobalBar();
    });
    gAudio.addEventListener('durationchange', syncGlobalBar);
    gAudio.addEventListener('ratechange', function () { updatePositionState(gAudio); });

    gWrap.appendChild(bar);
    gWrap.hidden = true;
    document.body.appendChild(gWrap);
  }

  function syncGlobalBar() {
    if (!gBarReady()) return;
    var bar = gWrap.querySelector('.pp-global-bar');
    bar.querySelector('.pp-global-title').textContent = trackTitle(gAudio, -1);
    bar.querySelector('.pp-global-time').textContent =
      formatTime(gAudio.currentTime) + ' / ' +
      (isFinite(gAudio.duration) ? formatTime(gAudio.duration) : '\u221E');
    if (gAudio._coverUrl) {
      var img = bar.querySelector('.pp-global-cover');
      if (img.getAttribute('src') !== gAudio._coverUrl) img.src = gAudio._coverUrl;
    }
    var scrub = bar.querySelector('.pp-global-scrubber');
    scrub.max = String(Math.max(0, Math.floor(isFinite(gAudio.duration) ? gAudio.duration : 0)));
    scrub.value = String(Math.max(0, Math.min(Math.floor(gAudio.currentTime), scrub.max)));
  }

  function gBarReady() {
    return !!(gWrap && gWrap.querySelector('.pp-global-bar'));
  }

  function syncGlobalPlayUI(playing) {
    if (!gBarReady()) return;
    if (playing === undefined) playing = !gAudio.paused && !gAudio.ended;
    var play = gWrap.querySelector('.pp-global-play');
    play.innerHTML = '';
    play.appendChild(icon(playing ? 'pause' : 'play'));
    play.setAttribute('aria-label', playing ? settings.labels.pause : settings.labels.play);
  }

  // Load an episode (a page <audio> element) into the global player.
  function globalLoad(sourceEl) {
    ensureGlobalPlayer();
    var src = sourceEl.getAttribute('src') || sourceEl.dataset.originalSrc || '';
    if (!src) return;
    gLoadedSrc = src;
    gLoadedRoute = window.location.hash || '';
    gAudio.setAttribute('src', src);
    ['title', 'cover', 'chapters', 'download', 'originalSrc'].forEach(function (k) {
      if (sourceEl.dataset[k]) gAudio.dataset[k] = sourceEl.dataset[k];
      else delete gAudio.dataset[k];
    });
    if (sourceEl._coverUrl) gAudio._coverUrl = sourceEl._coverUrl;
    else {
      var stem = audioStem(sourceEl);
      if (stem) gAudio._coverUrl = resolve(settings.coverPattern.replace('{stem}', stem));
    }
    if (gAudio._hls) { try { gAudio._hls.destroy(); } catch (_) { /* ignore */ } }
    gAudio._hls = null;
    gAudio.dataset.hlsAttached = '';
    gAudio._hlsFatalRetries = 0;
    gAudio._chapters = null;
    try {
      var sp = parseFloat(sessionStorage.getItem(speedKey(gAudio)) ||
        sessionStorage.getItem('podcast-speed'));
      if (sp && settings.speedOptions && settings.speedOptions.indexOf(sp) !== -1) {
        gAudio.playbackRate = sp;
      }
    } catch (_) { /* ignore */ }
    attachHls(gAudio);
    updateMediaSession(gAudio, -1);
    gWrap.hidden = false;
    syncGlobalBar();
    syncGlobalPlayUI();
    gSurfaces.forEach(function (s) { try { s(false); } catch (_) { /* ignore */ } });
    // Upgrade the source's page surface into the full player (Phase 2).
    reEnhance(sourceEl);
  }

  // Rebuild a page <audio>'s UI according to the global state: full player
  // when it is the loaded source, compact surface otherwise.
  function reEnhance(el) {
    if (!el || !el.parentNode) return;
    var host = el._ppHost || el.parentNode;
    if (el._ppSurface) { el._ppSurface.remove(); el._ppSurface = null; }
    var oldWrap = el.closest('.podcast-player');
    if (oldWrap) oldWrap.remove();
    el.dataset.podcastEnhanced = '';
    if (!el.isConnected && host) host.insertBefore(el, host.firstChild);
    if (settings.unified) {
      if (globalIsCurrent(el)) enhance(el, 0, gAudio);
      else unifiedEnhance(el, 0);
    } else {
      enhance(el, 0);
    }
  }

  function globalIsCurrent(el) {
    return gLoadedSrc === (el.getAttribute('src') || el.dataset.originalSrc || '');
  }

  // Page surfaces in unified mode.
  function unifiedEnhance(el, index) {
    if (el.dataset.podcastEnhanced) return;
    el.dataset.podcastEnhanced = '1';
    if (!el.parentNode) return;
    ensureGlobalPlayer();
    el._ppHost = el.parentNode;

    var wrap = document.createElement('div');
    wrap.className = 'podcast-player pp-surface';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', trackTitle(el, index) || 'Podcast player');
    el.parentNode.insertBefore(wrap, el);
    el._ppSurface = wrap;

    var main = document.createElement('div');
    main.className = 'pp-surface-main';
    wrap.appendChild(main);
    addCover(el, wrap, main);

    var meta = document.createElement('div');
    meta.className = 'pp-meta';
    var titleEl = document.createElement('h3');
    titleEl.className = 'pp-title';
    titleEl.textContent = trackTitle(el, index) || '';
    meta.appendChild(titleEl);
    var sub = document.createElement('div');
    sub.className = 'pp-sub';
    sub.textContent = [settings.artist, settings.album].filter(Boolean).join(' \u00B7 ');
    meta.appendChild(sub);
    main.appendChild(meta);

    // "Now playing" banner when the global player runs a different episode.
    var banner = document.createElement('div');
    banner.className = 'pp-now-playing';
    banner.hidden = true;
    banner.appendChild(document.createTextNode(settings.labels.nowPlaying + ' : '));
    var bTitle = document.createElement('b');
    bTitle.className = 'pp-now-playing-title';
    banner.appendChild(bTitle);
    var switchBtn = document.createElement('button');
    switchBtn.type = 'button';
    switchBtn.className = 'podcast-player-btn pp-btn pp-switch';
    switchBtn.textContent = settings.labels.switchEp;
    switchBtn.setAttribute('aria-label', settings.labels.switchEp);
    switchBtn.addEventListener('click', function () { play.click(); });
    banner.appendChild(switchBtn);
    var goBtn = document.createElement('button');
    goBtn.type = 'button';
    goBtn.className = 'podcast-player-btn pp-btn pp-goto';
    goBtn.textContent = settings.labels.goToPage;
    goBtn.setAttribute('aria-label', settings.labels.goToPage);
    goBtn.addEventListener('click', function () {
      if (gLoadedRoute) window.location.hash = gLoadedRoute;
    });
    banner.appendChild(goBtn);
    wrap.appendChild(banner);

    var controls = document.createElement('div');
    controls.className = 'pp-surface-controls';
    wrap.appendChild(controls);

    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'podcast-player-btn pp-btn pp-btn-play';
    play.setAttribute('aria-label', settings.labels.play);
    play.appendChild(icon('play'));
    play.addEventListener('click', function () {
      var src = el.getAttribute('src') || el.dataset.originalSrc || '';
      if (!src) return;
      if (globalIsCurrent(el)) {
        if (gAudio.paused) { var p = gAudio.play(); if (p && p.catch) p.catch(function () {}); }
        else gAudio.pause();
      } else {
        globalLoad(el);
        var p2 = gAudio.play();
        if (p2 && p2.catch) p2.catch(function () { /* autoplay blocked */ });
      }
    });
    controls.appendChild(play);

    // Resume chip (position saved per episode, localStorage).
    if (settings.resumeChip) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'podcast-player-btn pp-resume';
      chip.hidden = true;
      chip.addEventListener('click', function () {
        globalLoad(el);
        gAudio.currentTime = el._resumeAt || 0;
        var p = gAudio.play();
        if (p && p.catch) p.catch(function () {});
      });
      controls.appendChild(chip);
      var saved = readPosition(el);
      if (isFinite(saved) && saved > 15) {
        el._resumeAt = saved;
        chip.textContent = tpl(settings.labels.resume, { t: formatTime(saved) });
        chip.hidden = false;
      }
    }

    buildDownload(el, wrap, controls);

    function syncSurface(playing) {
      var mine = globalIsCurrent(el);
      if (playing === undefined) playing = mine && !gAudio.paused && !gAudio.ended;
      else playing = playing && mine;
      play.innerHTML = '';
      play.appendChild(icon(playing ? 'pause' : 'play'));
      play.setAttribute('aria-label', playing ? settings.labels.pause : settings.labels.play);
      banner.hidden = !(gLoadedSrc && !mine);
      if (!banner.hidden) {
        bTitle.textContent = gAudio.dataset.title || '';
      }
    }
    gAudio.addEventListener('play', function () { syncSurface(true); });
    gAudio.addEventListener('pause', function () { syncSurface(false); });
    gAudio.addEventListener('ended', function () { syncSurface(false); });
    syncSurface._el = wrap;
    gSurfaces = gSurfaces.filter(function (s) {
      return s._el && s._el.isConnected;
    });
    gSurfaces.push(syncSurface);
    syncSurface(false);
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
      playlist.forEach(function (entry, i) {
        if (settings.unified) unifiedEnhance(entry.el, i);
        else enhance(entry.el, i);
      });

      root.querySelectorAll('video').forEach(attachHls);

      registerDownloadSw();
    });
  }

  function pickLabels() {
    var lang = ((document.documentElement && document.documentElement.lang) || 'fr')
      .toLowerCase();
    return (lang.indexOf('fr') === 0 ? LABELS.fr : LABELS.en);
  }

  function install() {
    var user = (window.$docsify && window.$docsify.podcastPlayer) || {};
    var labels = user.labels || pickLabels();
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
      // v2
      showTime: user.showTime !== undefined ? user.showTime : DEFAULTS.showTime,
      showSpeed: user.showSpeed !== undefined ? user.showSpeed : DEFAULTS.showSpeed,
      showVolume: user.showVolume !== undefined ? user.showVolume : DEFAULTS.showVolume,
      showChapterNav: user.showChapterNav !== undefined ? user.showChapterNav : DEFAULTS.showChapterNav,
      backForward: user.backForward !== undefined ? user.backForward
        : (DEFAULTS.backForward || DEFAULTS.seekSeconds),
      speedOptions: user.speedOptions || DEFAULTS.speedOptions,
      miniPlayer: user.miniPlayer !== undefined ? user.miniPlayer : DEFAULTS.miniPlayer,
      transcriptFollow: user.transcriptFollow !== undefined ? user.transcriptFollow : DEFAULTS.transcriptFollow,
      transcriptSearch: user.transcriptSearch !== undefined ? user.transcriptSearch : DEFAULTS.transcriptSearch,
      helpDialog: user.helpDialog !== undefined ? user.helpDialog : DEFAULTS.helpDialog,
      resumeChip: user.resumeChip !== undefined ? user.resumeChip : DEFAULTS.resumeChip,
      downloadSw: user.downloadSw !== undefined ? user.downloadSw : DEFAULTS.downloadSw,
      unified: user.unified !== undefined ? user.unified : DEFAULTS.unified,
      print: user.print || DEFAULTS.print,
      labels: labels,
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
