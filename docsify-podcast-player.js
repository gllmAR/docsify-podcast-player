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
  var PLUGIN_VERSION = '1.7.3';

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
    showBookmarks: true,              // bookmark button + panel (localStorage)
    showCaptions: true,               // CC line showing the active VTT cue
    backForward: 10,                  // back/forward buttons (seconds)
    speedOptions: [0.75, 1, 1.25, 1.5, 2],
    transcriptFollow: true,
    transcriptSearch: true,
    helpDialog: true,
    resumeChip: true,
    print: 'hide',                    // 'hide' | 'keep-title'
    downloadSw: true,                 // true=auto-detect 'sw.js' at site
                                     // root, false=off, string=explicit path
    unified: false,                   // persistent global player (see docs/unified-player.md)
    autoAdvance: true,                // at end: load + navigate to the next episode (unified)
    feedUrl: true,                    // episode catalog: true=auto-detect
                                     // 'feed.json' then 'podcast.xml', string=path,
                                     // false=off (DOM-only behaviour)
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
      prevEp: 'Épisode précédent', nextEp: 'Épisode suivant',
      nextEpAnnounce: 'Prochain épisode : {t}', share: 'Partager', linkCopied: 'Lien copié',
      followSuspended: 'Suivi de la lecture suspendu',
      followResumed: 'Suivi de la lecture repris',
      cueAt: 'Écouter à {t}',
      resume: 'Reprendre à {t}',
      captions: 'Sous-titres',
      captionsOn: 'Sous-titres affichés', captionsOff: 'Sous-titres masqués',
      bookmark: 'Marquer', bookmarks: 'Signets',
      bookmarkAdded: 'Signet ajouté à {t}',
      bookmarkRemoved: 'Signet retiré à {t}',
      bookmarkDelete: 'Supprimer le signet à {t}',
      bookmarkEmpty: 'Aucun signet pour cet épisode.',
      global: 'Lecteur',
      closeMini: 'Fermer le lecteur (arrête la lecture)',
      openMini: 'Rouvrir le lecteur', minimize: 'Réduire le lecteur',
      details: 'Détails (chapitres, transcript, signets)',
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
      prevEp: 'Previous episode', nextEp: 'Next episode',
      nextEpAnnounce: 'Next episode: {t}', share: 'Share', linkCopied: 'Link copied',
      followSuspended: 'Playback following suspended',
      followResumed: 'Playback following resumed',
      cueAt: 'Listen at {t}',
      resume: 'Resume at {t}',
      captions: 'Captions',
      captionsOn: 'Captions shown', captionsOff: 'Captions hidden',
      bookmark: 'Bookmark', bookmarks: 'Bookmarks',
      bookmarkAdded: 'Bookmark added at {t}',
      bookmarkRemoved: 'Bookmark removed at {t}',
      bookmarkDelete: 'Delete bookmark at {t}',
      bookmarkEmpty: 'No bookmarks for this episode.',
      global: 'Player',
      closeMini: 'Close player (stops playback)',
      openMini: 'Reopen player', minimize: 'Minimize player',
      details: 'Details (chapters, transcript, bookmarks)',
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
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        hideHlsLoading(wrap);
        // A play was requested before the MediaSource was attached: retry
        // now that the manifest is parsed (the element keeps its gesture
        // activation from the first attempt).
        if (el._playPending) playMedia(el);
      });
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
    img.addEventListener('error', function () {
      // No cover on this episode: drop the image and keep MediaSession
      // artwork from pointing at a broken URL.
      img.remove();
      el._coverUrl = '';
      updateMediaSession(el, playlist.findIndex(function (p) { return p.el === el; }));
    });
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
          playMedia(media);
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
        // Cache hit (re-render / re-enhance of the same episode): restore
        // the exact state the fetch path would — chapters on the media
        // (chapter nav buttons + keyboard), nav group visibility, ticks.
        media._chapters = chapterDataCache[url];
        if (media._chapGroupEl) media._chapGroupEl.hidden = false;
        drawScrubberTicks(media);
        render(list, chapterDataCache[url]);
        if (activeAudio === media || media.paused === false) {
          updateMediaSession(media, playlist.findIndex(function(p) { return p.media === media; }));
        }
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
        if (media._chapGroupEl) media._chapGroupEl.hidden = false;
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
    bindMedia(media, 'timeupdate', function () {
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
      var end = parseVttTime(times[1].trim());
      var body = lines.slice(idx + 1).join(' ').trim();
      if (body) cues.push({ start: start, end: end, text: body });
    });
    return cues;
  }

  var transcriptCache = {};

  // Shared VTT loader: the transcript panel and the caption line both draw
  // from transcriptCache (one fetch per episode).
  function loadCuesFor(media) {
    var el = media._sourceEl || media;
    var url = transcriptUrl(el);
    if (!url) return Promise.resolve(null);
    if (transcriptCache[url]) return Promise.resolve(transcriptCache[url]);
    if (media._cuesLoading) return media._cuesLoading;
    media._cuesLoading = fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    }).then(function (text) {
      var cues = parseVtt(text);
      transcriptCache[url] = cues;
      return cues;
    }).catch(function () { return null; });
    return media._cuesLoading;
  }

  // Caption line: show the active VTT cue (synced on every timeupdate).
  function updateCaption(media) {
    var el = media._captionEl;
    if (!el) return;
    el.textContent = '';
    el.hidden = true;
    if (!media._captionsOn) return;
    var cues = media._cues;
    if (!cues || !cues.length) return;
    var t = media.currentTime || 0;
    var cue = null;
    for (var i = 0; i < cues.length; i++) {
      if (t >= cues[i].start && t < cues[i].end) { cue = cues[i]; break; }
      if (t < cues[i].start) break;
    }
    if (!cue) return;
    // Speaker label if present: "<v Hôte>…</v>" → styled element.
    var voice = /^<v\s+([^>]*)>(.*)<\/v>\s*$/i.exec(cue.text);
    var text = voice ? (voice[2] || '') : cue.text;
    text = text.replace(/<[^>]+>/g, '').trim();      // strip inner tags
    if (!text) return;
    if (voice) {
      var sp = document.createElement('span');
      sp.className = 'pp-cue-speaker';
      sp.textContent = (voice[1] || '').trim();
      el.appendChild(sp);
      el.appendChild(document.createTextNode(' ' + text));
    } else {
      el.appendChild(document.createTextNode(text));
    }
    el.hidden = false;
  }

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

    bindMedia(media, 'timeupdate', function () {
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
    share: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/></svg>',
    minimize: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="6 9 12 15 18 9"/></svg>',
  };

  function icon(name) {
    var span = document.createElement('span');
    span.className = 'pp-icon';
    span.innerHTML = ICONS[name] || '';
    return span;
  }

  function buildControls(media, el, wrap, card) {
    var controls = document.createElement('div');
    controls.className = 'pp-controls';
    card.appendChild(controls);

    // v3 layout: a progress row (current time — scrubber — total) above
    // a transport row with grouped controls (nav · chapters · settings).
    var progress = document.createElement('div');
    progress.className = 'pp-progress';
    controls.appendChild(progress);
    var transport = document.createElement('div');
    transport.className = 'pp-transport';
    controls.appendChild(transport);
    var navGroup = document.createElement('div');
    navGroup.className = 'pp-group pp-group-nav';
    transport.appendChild(navGroup);
    var chapGroup = document.createElement('div');
    chapGroup.className = 'pp-group pp-group-chap';
    // Sober UI: the chapter-nav group appears only once chapters exist.
    chapGroup.hidden = true;
    media._chapGroupEl = chapGroup;
    transport.appendChild(chapGroup);
    var spacer = document.createElement('div');
    spacer.className = 'pp-spacer';
    transport.appendChild(spacer);
    var settingsGroup = document.createElement('div');
    settingsGroup.className = 'pp-group pp-group-settings';
    transport.appendChild(settingsGroup);

    // ── Play / pause ──
    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'podcast-player-btn pp-btn pp-btn-play';
    play.setAttribute('aria-label', settings.labels.play);
    play.appendChild(icon('play'));
    media._playBtn = play;
    play.addEventListener('click', function () {
      if (media.paused) playMedia(media); else media.pause();
    });
    navGroup.appendChild(play);

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
    navGroup.appendChild(back);

    var forward = document.createElement('button');
    forward.type = 'button';
    forward.className = 'podcast-player-btn pp-btn pp-btn-forward';
    forward.setAttribute('aria-label', tpl(settings.labels.forward, { s: backSec }));
    forward.appendChild(icon('forward'));
    forward.addEventListener('click', function () {
      media.currentTime = Math.min(media.duration || Infinity, media.currentTime + backSec);
    });
    navGroup.appendChild(forward);

    // ── Chapter prev / next ──
    var chapPrev = document.createElement('button');
    chapPrev.type = 'button';
    chapPrev.className = 'podcast-player-btn pp-btn pp-btn-chap-prev';
    chapPrev.setAttribute('aria-label', settings.labels.chapPrev);
    chapPrev.appendChild(icon('chapPrev'));
    chapPrev.disabled = true;
    chapPrev.addEventListener('click', function () { chapterJump(media, -1); });
    chapGroup.appendChild(chapPrev);

    var chapNext = document.createElement('button');
    chapNext.type = 'button';
    chapNext.className = 'podcast-player-btn pp-btn pp-btn-chap-next';
    chapNext.setAttribute('aria-label', settings.labels.chapNext);
    chapNext.appendChild(icon('chapNext'));
    chapNext.disabled = true;
    chapNext.addEventListener('click', function () { chapterJump(media, 1); });
    chapGroup.appendChild(chapNext);
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
      time.textContent = '0:00';
      media._timeEl = time;
      timeWrap.appendChild(time);
      progress.appendChild(timeWrap);
      var totalWrap = document.createElement('span');
      totalWrap.className = 'pp-time-total-wrap';
      var total = document.createElement('span');
      total.className = 'pp-time-total';
      total.setAttribute('aria-live', 'off');
      total.textContent = '0:00';
      media._timeTotalEl = total;
      totalWrap.appendChild(total);
      var remaining = document.createElement('span');
      remaining.className = 'pp-remaining';
      remaining.setAttribute('aria-hidden', 'true');
      remaining.textContent = '0:00';
      media._remainingEl = remaining;
      totalWrap.appendChild(remaining);
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

    progress.appendChild(scrubWrap);
    // Total time at the right end of the progress row (after the scrubber).
    if (settings.showTime !== false) progress.appendChild(totalWrap);

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
      settingsGroup.appendChild(speed);
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
      settingsGroup.appendChild(volWrap);
    }

    // ── Bookmark (mark / unmark the current position) ──
    if (settings.showBookmarks) {
      var bm = document.createElement('button');
      bm.type = 'button';
      bm.className = 'podcast-player-btn pp-btn pp-bookmark';
      bm.setAttribute('aria-pressed', 'false');
      bm.setAttribute('aria-label', settings.labels.bookmark);
      bm.appendChild(icon('bookmark'));
      media._bookmarkBtn = bm;
      bm.addEventListener('click', function () {
        toggleBookmark(media, el, wrap);
      });
      settingsGroup.appendChild(bm);
    }

    // ── Captions (CC): show the active subtitle cue during playback ──
    if (settings.showCaptions) {
      var cc = document.createElement('button');
      cc.type = 'button';
      cc.className = 'podcast-player-btn pp-btn pp-captions';
      cc.setAttribute('aria-pressed', 'false');
      cc.setAttribute('aria-label', settings.labels.captions);
      cc.textContent = 'CC';
      media._captionsBtn = cc;
      cc.addEventListener('click', function () {
        media._captionsOn = !media._captionsOn;
        try { sessionStorage.setItem('pp-captions', media._captionsOn ? '1' : '0'); } catch (_) { /* ignore */ }
        cc.setAttribute('aria-pressed', media._captionsOn ? 'true' : 'false');
        announce(wrap, media._captionsOn ? settings.labels.captionsOn : settings.labels.captionsOff);
        if (media._captionsOn && !media._cues) {
          loadCuesFor(media).then(function (cues) {
            media._cues = cues || [];
            updateCaption(media);
          });
        } else {
          updateCaption(media);
        }
      });
      settingsGroup.appendChild(cc);
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
    playMedia(media);
    announce(wrapFor(media), tpl(settings.labels.cueAt, { t: formatTime(media.currentTime) }));
  }

  function wrapFor(media) {
    return media.closest('.podcast-player') || document.body;
  }

  // Play an element robustly. The first attempt runs inside the user
  // gesture; when it fails because the media is not playable yet (hls.js
  // still loading/attaching its MediaSource, or no metadata), the play is
  // retried automatically as soon as the element becomes ready — the
  // element keeps the gesture activation from the first attempt, so the
  // retry is allowed by the autoplay policy. Fixes the "first play does
  // nothing, second press works" race with async hls.js attachment.
  function playMedia(el) {
    if (el._playPending) return;           // a retry is already armed
    el._playPending = true;
    var p;
    try { p = el.play(); } catch (_) { p = null; }
    if (!p || !p.catch) { el._playPending = false; return; } // sync env (jsdom)
    p.then(function () { el._playPending = false; },
           function () { /* rejection handled by the retry below */ });
    p.catch(function () {
      if (!el._playPending) return;
      var retry = function () {
        if (!el._playPending) return;
        var p2;
        try { p2 = el.play(); } catch (_) { p2 = null; }
        if (p2 && p2.catch) {
          // Give the next gesture a fresh attempt if this retry also fails.
          p2.catch(function () { el._playPending = false; });
        } else {
          el._playPending = false;
        }
      };
      if (el.readyState >= 2) { retry(); return; }
      var once = function () {
        el.removeEventListener('loadedmetadata', once);
        el.removeEventListener('canplay', once);
        retry();
      };
      el.addEventListener('loadedmetadata', once);
      el.addEventListener('canplay', once);
    });
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
    var currentIdx = chapterIndexAt(media, media.currentTime);
    media._chapters.forEach(function (ch, i) {
      var start = parseFloat(ch.startTime) || 0;
      if (start <= 0 || start >= dur) return; // skip edge ticks
      // Clickable chapter marker on the scrubber bar (G4): clicking the
      // marker jumps to the chapter start; clicking elsewhere on the track
      // keeps the native exact seek. Pointer-fine only (see CSS); keyboard
      // users keep the existing chapter list.
      var m = document.createElement('i');
      m.className = 'pp-chap-marker' + (i === currentIdx ? ' active' : '');
      m.dataset.index = String(i);
      m.style.left = (start / dur * 100).toFixed(2) + '%';
      m.title = ch.title || ('Chapitre ' + (i + 1));
      m.addEventListener('click', function () {
        media.currentTime = start;
        playMedia(media);
        announce(wrapFor(media), tpl(settings.labels.cueAt, { t: formatTime(start) }));
      });
      ticks.appendChild(m);
    });
  }

  function updateTimeDisplay(media) {
    if (media._timeEl) {
      media._timeEl.textContent = formatTime(media.currentTime);
      media._timeEl.dateTime = timeDatetime(media.currentTime);
    }
    if (media._timeTotalEl) {
      media._timeTotalEl.textContent =
        isFinite(media.duration) ? formatTime(media.duration) : '\u221E';
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
    updateBookmarkButton(media);
    updateCaption(media);
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
    box.className = 'pp-help-box';

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
      // Cover art + tags are known on the page: pass them to the muxer so
      // the M4A carries the real cover (any format, data-cover included)
      // and the visible title — not only the best-effort README/cover.png.
      var coverPromise = el._coverUrl
        ? fetch(el._coverUrl).then(function (r) {
            return r.ok ? r.arrayBuffer() : null;
          }).catch(function () { return null; })
        : Promise.resolve(null);
      return coverPromise.then(function (buf) {
        var index = playlist.findIndex(function (p) { return p.el === el; });
        var metadata = {
          title: trackTitle(el, index),
          artist: settings.artist,
          album: settings.album,
        };
        if (el.dataset.episode) metadata.trackNumber = el.dataset.episode;
        if (el.dataset.date) metadata.date = el.dataset.date;
        if (buf) metadata.cover = new Uint8Array(buf);
        return ts2m4a.tsToM4a(src, {
          onProgress: function (i, n) {
            a.textContent = settings.downloadBusyLabel + ' ' + i + '/' + n;
          },
          metadata: metadata,
        });
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
    // The OS controls always drive the persistent player in unified mode,
    // even when no full player is on the page (activeAudio is then null).
    function currentMedia() {
      if (activeAudio) return activeAudio;
      if (gAudio && gAudio.getAttribute('src')) return gAudio;
      return null;
    }
    function seekStep(details) {
      return (details && isFinite(details.seekOffset) && details.seekOffset > 0)
        ? details.seekOffset : settings.seekSeconds;
    }
    try {
      navigator.mediaSession.setActionHandler('play', function () {
        var m = currentMedia();
        if (m) playMedia(m);
        else if (playlist.length) goTo(0, true);
      });
      navigator.mediaSession.setActionHandler('pause', function () {
        var m = currentMedia();
        if (m) m.pause();
      });
      navigator.mediaSession.setActionHandler('stop', function () {
        var m = currentMedia();
        if (m) { m.pause(); m.currentTime = 0; }
      });
      navigator.mediaSession.setActionHandler('nexttrack', function () {
        navToEpisode('.pagination-item--next');
      });
      navigator.mediaSession.setActionHandler('previoustrack', function () {
        navToEpisode('.pagination-item--previous');
      });
      navigator.mediaSession.setActionHandler('seekforward', function (details) {
        var m = currentMedia();
        if (!m) return;
        var chapters = m._chapters;
        if (chapters && chapters.length) {
          // Chapter-aware skip: jump to the next chapter start.
          for (var i = 0; i < chapters.length; i++) {
            if ((parseFloat(chapters[i].startTime) || 0) > m.currentTime + 0.5) {
              m.currentTime = parseFloat(chapters[i].startTime) || 0;
              return;
            }
          }
        }
        var step = seekStep(details);
        m.currentTime = Math.min(m.duration || Infinity, m.currentTime + step);
      });
      navigator.mediaSession.setActionHandler('seekbackward', function (details) {
        var m = currentMedia();
        if (!m) return;
        var chapters = m._chapters;
        if (chapters && chapters.length) {
          // Chapter-aware skip: jump to the previous chapter start.
          for (var i = chapters.length - 1; i >= 0; i--) {
            if ((parseFloat(chapters[i].startTime) || 0) < m.currentTime - 0.5) {
              m.currentTime = parseFloat(chapters[i].startTime) || 0;
              return;
            }
          }
          m.currentTime = 0;
          return;
        }
        var step = seekStep(details);
        m.currentTime = Math.max(0, m.currentTime - step);
      });
      navigator.mediaSession.setActionHandler('seekto', function (details) {
        var m = currentMedia();
        if (m && details.seekTime !== undefined) {
          m.currentTime = details.seekTime;
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
      playMedia(target.el);
    }
  }

  function buildToolbar(entry, index, media, wrap) {
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

    // Help ("?" shortcut) lives in the toolbar, out of the transport bar.
    if (settings.helpDialog) {
      var help = document.createElement('button');
      help.type = 'button';
      help.className = 'podcast-player-btn pp-btn pp-help';
      help.setAttribute('aria-label', settings.labels.help);
      help.title = '?';
      help.appendChild(icon('help'));
      help.addEventListener('click', function () {
        openHelpDialog(wrap, media, help);
      });
      media._helpBtn = help;
      bar.appendChild(help);
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
          if (el.paused) playMedia(el); else el.pause();
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

  // ── Bookmarks (per episode, localStorage) ───────────────────────────

  function bookmarksKey(el) {
    var src = el.dataset.originalSrc || el.getAttribute('src') || '';
    return 'podcast-bookmarks:' + src;
  }

  function readBookmarks(el) {
    var out = [];
    try {
      var raw = localStorage.getItem(bookmarksKey(el));
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          out = arr.filter(function (b) {
            return b && isFinite(parseFloat(b.t));
          }).map(function (b) { return { t: parseFloat(b.t), at: b.at || 0 }; });
        }
      }
    } catch (_) { /* ignore */ }
    return out;
  }

  function writeBookmarks(el, list) {
    try { localStorage.setItem(bookmarksKey(el), JSON.stringify(list)); } catch (_) { /* ignore */ }
  }

  // Mark/unmark the current position (toggle within a 3 s window).
  function toggleBookmark(media, el, wrap) {
    var t = media.currentTime || 0;
    if (!isFinite(t) || t <= 0) return;
    var list = readBookmarks(el);
    var near = -1;
    for (var i = 0; i < list.length; i++) {
      if (Math.abs(list[i].t - t) < 3) { near = i; break; }
    }
    if (near >= 0) {
      list.splice(near, 1);
      announce(wrap, tpl(settings.labels.bookmarkRemoved, { t: formatTime(t) }));
    } else {
      list.push({ t: t, at: Date.now() });
      list.sort(function (a, b) { return a.t - b.t; });
      announce(wrap, tpl(settings.labels.bookmarkAdded, { t: formatTime(t) }));
    }
    writeBookmarks(el, list);
    if (media._bookmarkListEl) renderBookmarks(media, el, media._bookmarkListEl);
    updateBookmarkButton(media);
  }

  function updateBookmarkButton(media) {
    var btn = media._bookmarkBtn;
    if (!btn) return;
    var srcEl = media._sourceEl || media;
    var t = media.currentTime || 0;
    var pressed = false;
    readBookmarks(srcEl).forEach(function (b) {
      if (Math.abs(b.t - t) < 3) pressed = true;
    });
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }

  function renderBookmarks(media, el, list) {
    var box = list.closest('details');
    var sum = box ? box.querySelector('summary') : null;
    var marks = readBookmarks(el);
    list.innerHTML = '';
    if (sum) {
      sum.textContent = settings.labels.bookmarks +
        (marks.length ? ' (' + marks.length + ')' : '');
    }
    if (!marks.length) {
      var empty = document.createElement('li');
      empty.className = 'pp-bookmark-empty';
      empty.textContent = settings.labels.bookmarkEmpty;
      list.appendChild(empty);
      return;
    }
    marks.forEach(function (b) {
      var li = document.createElement('li');
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'podcast-player-btn pp-bookmark-go';
      go.textContent = formatTime(b.t);
      go.setAttribute('aria-label', tpl(settings.labels.cueAt, { t: formatTime(b.t) }));
      go.addEventListener('click', function () {
        media.currentTime = b.t;
        playMedia(media);
      });
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'podcast-player-btn pp-bookmark-del';
      del.setAttribute('aria-label', tpl(settings.labels.bookmarkDelete, { t: formatTime(b.t) }));
      del.appendChild(icon('close'));
      del.addEventListener('click', function () {
        var l = readBookmarks(el);
        for (var i = 0; i < l.length; i++) {
          if (Math.abs(l[i].t - b.t) < 0.5) { l.splice(i, 1); break; }
        }
        writeBookmarks(el, l);
        renderBookmarks(media, el, list);
        updateBookmarkButton(media);
      });
      li.appendChild(go);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  function buildBookmarks(el, media, wrap, panels) {
    if (!settings.showBookmarks) return;
    var box = document.createElement('details');
    box.className = 'podcast-player-bookmarks pp-bookmarks';
    var sum = document.createElement('summary');
    sum.textContent = settings.labels.bookmarks;
    box.appendChild(sum);
    var list = document.createElement('ol');
    box.appendChild(list);
    panels.appendChild(box);
    media._bookmarkListEl = list;
    renderBookmarks(media, el, list);
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
    if (media !== el) cleanupMediaListeners(media);
    media._sourceEl = el; // bookmarks/positions key on the page element
    var wrap = document.createElement('div');
    wrap.className = 'podcast-player';
    wrap.dataset.print = settings.print || 'hide';
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', trackTitle(el, index) || 'Podcast player');
    el.parentNode.insertBefore(wrap, el);

    var bar = buildToolbar(playlist[index], index, media, wrap);
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
    // Sober: never repeat "Podcast · Podcast" when artist === album.
    var credits = Array.from(new Set(
      [settings.artist, settings.album].filter(Boolean)));
    if (credits.length) {
      sub.textContent = credits.join(' \u00B7 ');
    } else {
      sub.style.display = 'none';
    }
    meta.appendChild(titleEl);
    meta.appendChild(sub);
    // Resume chip: contextual callout under the title — out of the
    // transport row, so the transport stays quiet (audit v3, rule 6).
    if (settings.resumeChip) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'podcast-player-btn pp-resume';
      chip.hidden = true;
      chip.addEventListener('click', function () {
        media.currentTime = media._resumeAt || 0;
        playMedia(media);
        chip.hidden = true;
      });
      media._resumeChip = chip;
      el._resumeChip = chip;
      meta.appendChild(chip);
    }
    main.appendChild(meta);

    addCover(media, wrap, main);

    var controls = buildControls(media, el, wrap, card);
    // Download sits next to the title (toolbar), not inside the transport.
    buildDownload(el, wrap, bar);

    // Caption line (active VTT cue), between the controls and the panels.
    var caption = document.createElement('div');
    caption.className = 'pp-caption';
    caption.hidden = true;
    card.appendChild(caption);
    media._captionEl = caption;
    var captionsPref = '1';
    try {
      var cp = sessionStorage.getItem('pp-captions');
      if (cp !== null) captionsPref = cp;
    } catch (_) { /* ignore */ }
    media._captionsOn = captionsPref === '1';
    if (media._captionsBtn) {
      media._captionsBtn.setAttribute('aria-pressed', media._captionsOn ? 'true' : 'false');
    }
    if (media._captionsOn) {
      loadCuesFor(media).then(function (cues) {
        media._cues = cues || [];
        updateCaption(media);
      });
    }

    var panels = document.createElement('div');
    panels.className = 'pp-panels';
    card.appendChild(panels);
    buildChapters(media, wrap, panels);
    buildTranscript(media, wrap, panels);
    buildBookmarks(el, media, wrap, panels);

    wrap.appendChild(el);

    bindMedia(media, 'loadedmetadata', function () {
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
          playMedia(media);
        }
      } catch (_) { /* ignore */ }
    }, { once: true });
    bindMedia(media, 'timeupdate', function () {
      savePosition(media);
      updatePositionState(media);
      updateTimeDisplay(media);
    });
    bindMedia(media, 'durationchange', function () {
      updatePositionState(media);
      updateTimeDisplay(media);
    });
    bindMedia(media, 'ratechange', function () { updatePositionState(media); });
    bindMedia(media, 'seeked', function () {
      updatePositionState(media);
      updateTimeDisplay(media);
    });
    bindMedia(media, 'pause', function () {
      savePosition(media);
      setPlaybackState('paused');
      syncPlayUI(media, false);
      wrap.classList.remove('pp-active');
      if (activeAudio === media) activeAudio = null;
    });
    bindMedia(media, 'ended', function () {
      setPlaybackState('paused');
      syncPlayUI(media, false);
      clearPosition(media);
      if (media._resumeChip) media._resumeChip.hidden = true;
    });

    bindMedia(media, 'play', function () {
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
      // ── Controls (v3: progress row + transport row) ──
      '.pp-controls { display: flex; flex-direction: column; gap: .55em; }',
      '.pp-progress { display: flex; align-items: center; gap: .6em; }',
      '.pp-transport { display: flex; align-items: center; gap: .75em; flex-wrap: wrap; }',
      '.pp-group { display: inline-flex; align-items: center; gap: .35em; }',
      '.pp-group[hidden] { display: none; }',
      '.pp-spacer { flex: 1 1 auto; min-width: .5em; }',
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
      '  border-color: var(--pp-accent); border-radius: 50%;',
      '  min-height: 48px; min-width: 48px; font-size: 1.05em; }',
      '.pp-btn-play:hover { filter: brightness(1.08); }',
      '.podcast-player-time { font-variant-numeric: tabular-nums; font-size: .85em;',
      '  color: var(--pp-text-muted); white-space: nowrap; }',
      '.pp-time-wrap { position: relative; display: inline-flex; align-items: baseline;',
      '  flex: 0 0 auto; }',
      '.pp-time-total-wrap { display: inline-flex; align-items: baseline; flex: 0 0 auto; }',
      '.pp-time-total { font-variant-numeric: tabular-nums; font-size: .85em;',
      '  color: var(--pp-text-muted); white-space: nowrap; }',
      '.pp-remaining { display: none; font-variant-numeric: tabular-nums; font-size: .85em;',
      '  color: var(--pp-text-muted); white-space: nowrap; }',
      '@media (hover: hover) and (pointer: fine) {',
      '  .pp-time-total-wrap:hover .pp-time-total { display: none; }',
      '  .pp-time-total-wrap:hover .pp-remaining { display: inline; }',
      '}',
      '.pp-scrubber-wrap { position: relative; flex: 1 1 auto; min-width: 90px;',
      '  display: flex; align-items: center; }',
      '.pp-scrubber { flex: 1; width: 100%; min-width: 0; accent-color: var(--pp-accent); }',
      '.pp-ticks { position: absolute; left: 0; right: 0; top: 50%;',
      '  transform: translateY(-50%); pointer-events: none; height: 0; }',
      '.pp-ticks i { position: absolute; top: 0; width: 14px; height: 14px;',
      '  margin-top: -7px; transform: translateX(-50%); }',
      '.pp-ticks i::after { content: ""; position: absolute; left: 50%; top: 0;',
      '  width: 2px; height: 14px; margin-left: -1px; border-radius: 1px;',
      '  background: var(--pp-tick); }',
      '.pp-ticks i.active::after { background: var(--pp-accent); }',
      '@media (hover: hover) and (pointer: fine) {',
      '  .pp-ticks i { pointer-events: auto; cursor: pointer; }',
      '  .pp-ticks i:hover::after { background: var(--pp-accent); }',
      '}',
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
      '.pp-meta .pp-resume { align-self: flex-start; margin-top: .5em; }',
      '.pp-bookmark[aria-pressed="true"] { color: var(--pp-accent);',
      '  border-color: var(--pp-accent); }',
      // ── Captions (CC line) ──
      '.pp-caption { margin: 0; padding: .45em .7em; border-radius: 8px;',
      '  background: var(--pp-bg-alt); border: 1px solid var(--pp-border);',
      '  font-size: .95em; line-height: 1.45; }',
      '.pp-caption[hidden] { display: none; }',
      '.pp-caption .pp-cue-speaker { font-weight: 700; }',
      '.pp-captions { min-width: 2.6em; font-weight: 700; }',
      '.pp-captions[aria-pressed="true"] { color: var(--pp-accent);',
      '  border-color: var(--pp-accent); }',
      // ── Bookmarks panel ──
      '.podcast-player-bookmarks { font-size: .92em; }',
      '.podcast-player-bookmarks summary { cursor: pointer; font-weight: 600;',
      '  padding: .3em 0; }',
      '.podcast-player-bookmarks ol { margin: .3em 0; padding-left: 1.3em;',
      '  list-style: none; }',
      '.podcast-player-bookmarks li { display: flex; align-items: center;',
      '  gap: .45em; margin-bottom: .3em; }',
      '.pp-bookmark-empty { color: var(--pp-text-muted); font-style: italic; }',
      '.pp-bookmark-go { min-height: 2em; min-width: 3.6em; padding: .1em .5em;',
      '  font-size: .9em; font-variant-numeric: tabular-nums; }',
      '.pp-bookmark-del { min-height: 2em; min-width: 2em; padding: .1em; }',
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
      '.podcast-player-toolbar .pp-help { margin-left: auto; }',
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
      // ── Help dialog ──
      '.pp-help-overlay {',
      '  position: fixed; inset: 0; z-index: 10000; display: flex;',
      '  align-items: center; justify-content: center;',
      '  background: rgb(0 0 0 / .45); padding: 1em;',
      '}',
      '.pp-help-box {',
      '  background: var(--pp-bg); color: var(--pp-text);',
      '  border: 1px solid var(--pp-border); border-radius: var(--pp-radius);',
      '  padding: 1.2em; max-width: 30em; width: 100%; max-height: 80vh; overflow: auto;',
      '  box-shadow: var(--pp-shadow);',
      '}',
      '.pp-help-box h4 { margin: 0 0 .6em; }',
      '.pp-help-box table { border-collapse: collapse; width: 100%; font-size: .92em; }',
      '.pp-help-box td { padding: .25em .5em; border-bottom: 1px solid var(--pp-border); }',
      '.pp-help-box td:first-child { font-weight: 600; white-space: nowrap; }',
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
      'body.pp-has-global { padding-bottom: 64px; }',
      // Single view: progress row + subtitle row + transport row in the bar.
      '.pp-global-bar { flex-direction: column; gap: .45em; }',
      '.pp-global-progress { display: flex; align-items: center; gap: .6em;',
      '  min-width: 0; }',
      '.pp-global-transport { display: flex; align-items: center; gap: .35em;',
      '  width: 100%; }',
      '.pp-global-transport-right { margin-left: auto; display: inline-flex;',
      '  align-items: center; gap: .35em; }',
      '.pp-global-speed { min-width: 3em; }',
      '.pp-global-captions { min-width: 2.6em; font-weight: 700; }',
      '.pp-global-captions[aria-pressed="true"] { color: var(--pp-accent);',
      '  border-color: var(--pp-accent); }',
      '.pp-global-details-btn[aria-expanded="true"] { color: var(--pp-accent);',
      '  border-color: var(--pp-accent); }',
      '.pp-global-details-panel { max-height: 55vh; overflow: auto; padding: .5em .9em;',
      '  border-top: 1px solid var(--pp-border); }',
      '.pp-global-details-panel[hidden] { display: none; }',
      '.pp-global-caption { max-width: 42em; margin: 0 auto; padding: .4em 1em;',
      '  font-size: .95em; line-height: 1.45; text-align: center;',
      '  background: rgb(0 0 0 / .78); color: #fff; border-radius: 10px; }',
      '.pp-global-caption[hidden] { display: none; }',
      '.pp-global-caption .pp-cue-speaker { font-weight: 700;',
      '  color: var(--pp-accent); }',
      '.pp-global-reopen { position: fixed; right: 1em;',
      '  bottom: calc(1em + env(safe-area-inset-bottom)); z-index: 9001;',
      '  width: 56px; height: 56px; min-width: 56px; min-height: 56px; padding: 0;',
      '  border-radius: 50%; overflow: hidden; background: var(--pp-bg);',
      '  border: 1px solid var(--pp-border); box-shadow: var(--pp-shadow); }',
      '.pp-global-reopen[hidden] { display: none; }',
      '.pp-global-reopen-cover { position: absolute; inset: 0; width: 100%;',
      '  height: 100%; object-fit: cover; }',
      '.pp-global-reopen-icon { position: absolute; inset: 0; display: flex;',
      '  align-items: center; justify-content: center; color: #fff;',
      '  text-shadow: 0 1px 3px rgb(0 0 0 / .6); }',
      '@media (max-width: 559px) {',
      '  body.pp-has-global { padding-bottom: 72px; }',
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
      '  .pp-transcript-search, .pp-help-box { border: 1px solid CanvasText; }',
      '  .pp-ticks i::after { background: CanvasText; }',
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
      '  .pp-controls { gap: .45em; }',
      '  .podcast-player-btn { min-height: 44px; min-width: 44px; }',
      '  .pp-progress { gap: .45em; }',
      '  .pp-transport { gap: .6em; row-gap: .4em; }',
      '  .pp-volume-range { width: 56px; }',
      '}',
      // ── Wide tier (≥900px) ──
      '@media (min-width: 900px) {',
      '  .podcast-player { --pp-cover: 150px; }',
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

  // Listeners bound to a shared media element (unified mode) are tracked
  // per page and removed when the next page binds — they must not
  // accumulate across docsify navigations.
  function bindMedia(media, evt, fn) {
    media.addEventListener(evt, fn);
    if (media._ppCleanup) media._ppCleanup.push([evt, fn]);
    else media._ppCleanup = [[evt, fn]];
  }

  function cleanupMediaListeners(media) {
    var fns = media._ppCleanup;
    if (!fns) return;
    media._ppCleanup = null;
    fns.forEach(function (pair) {
      try { media.removeEventListener(pair[0], pair[1]); } catch (_) { /* ignore */ }
    });
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
  var gReopenBtn = null; // floating "reopen the persistent bar" button
  var gDetails = null;      // "details" panel (chapters/transcript/bookmarks)
  var gDetailsBtn = null;  // toggle button for it

  function ensureGlobalPlayer() {
    if (gAudio) return;
    gWrap = document.createElement('div');
    gWrap.className = 'pp-global';
    gWrap.setAttribute('role', 'region');
    gWrap.setAttribute('aria-label', settings.labels.global || 'Lecteur');
    gAudio = document.createElement('audio');
    gAudio.className = 'pp-global-audio';
    gWrap.appendChild(gAudio);

    var bar = document.createElement('div');
    bar.className = 'pp-global-bar';
    var progressRow = document.createElement('div');
    progressRow.className = 'pp-global-progress';
    bar.appendChild(progressRow);
    var cover = document.createElement('img');
    cover.className = 'pp-global-cover';
    cover.alt = '';
    cover.addEventListener('error', function () { cover.style.display = 'none'; });
    progressRow.appendChild(cover);
    var meta = document.createElement('div');
    meta.className = 'pp-global-meta';
    var title = document.createElement('span');
    title.className = 'pp-global-title';
    meta.appendChild(title);
    var now = document.createElement('span');
    now.className = 'pp-global-now';
    meta.appendChild(now);
    progressRow.appendChild(meta);
    var scrub = document.createElement('input');
    scrub.type = 'range';
    scrub.className = 'pp-global-scrubber';
    scrub.min = 0; scrub.max = 0; scrub.step = 1; scrub.value = 0;
    scrub.setAttribute('aria-label', settings.labels.position);
    progressRow.appendChild(scrub);
    var time = document.createElement('span');
    time.className = 'pp-global-time';
    time.setAttribute('aria-live', 'off');
    progressRow.appendChild(time);
    var navPrev = document.createElement('button');
    navPrev.type = 'button';
    navPrev.className = 'podcast-player-btn pp-btn pp-global-prev';
    navPrev.setAttribute('aria-label', settings.labels.prevEp);
    navPrev.appendChild(icon('chapPrev'));
    navPrev.disabled = true;
    progressRow.appendChild(navPrev);
    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'podcast-player-btn pp-btn pp-global-play';
    play.setAttribute('aria-label', settings.labels.play);
    play.appendChild(icon('play'));
    progressRow.appendChild(play);
    var navNext = document.createElement('button');
    navNext.type = 'button';
    navNext.className = 'podcast-player-btn pp-btn pp-global-next';
    navNext.setAttribute('aria-label', settings.labels.nextEp);
    navNext.appendChild(icon('chapNext'));
    navNext.disabled = true;
    progressRow.appendChild(navNext);

    // Subtitle row: the active cue, integrated inside the player between
    // the progress row and the transport row.
    var gCaption = document.createElement('div');
    gCaption.className = 'pp-global-caption';
    gCaption.hidden = true;
    bar.appendChild(gCaption);
    gAudio._captionEl = gCaption;

    // Single-view transport row: everything lives in the bar.
    var transport = document.createElement('div');
    transport.className = 'pp-global-transport';
    bar.appendChild(transport);
    var backSec = settings.backForward || settings.seekSeconds || 10;
    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'podcast-player-btn pp-btn pp-global-back';
    back.setAttribute('aria-label', tpl(settings.labels.back, { s: backSec }));
    back.appendChild(icon('back'));
    back.addEventListener('click', function () {
      gAudio.currentTime = Math.max(0, gAudio.currentTime - backSec);
    });
    transport.appendChild(back);
    var forward = document.createElement('button');
    forward.type = 'button';
    forward.className = 'podcast-player-btn pp-btn pp-global-forward';
    forward.setAttribute('aria-label', tpl(settings.labels.forward, { s: backSec }));
    forward.appendChild(icon('forward'));
    forward.addEventListener('click', function () {
      gAudio.currentTime = Math.min(gAudio.duration || Infinity, gAudio.currentTime + backSec);
    });
    transport.appendChild(forward);
    var right = document.createElement('span');
    right.className = 'pp-global-transport-right';
    transport.appendChild(right);
    var speedBtn = document.createElement('button');
    speedBtn.type = 'button';
    speedBtn.className = 'podcast-player-btn pp-btn pp-global-speed';
    speedBtn.setAttribute('aria-label', tpl(settings.labels.speed, { x: 1 }));
    speedBtn.textContent = '1\u00D7';
    speedBtn.addEventListener('click', function () {
      var opts = settings.speedOptions || [1];
      var cur = gAudio.playbackRate || 1;
      var next = opts[0];
      for (var i = 0; i < opts.length; i++) {
        if (Math.abs(opts[i] - cur) < 0.001) { next = opts[(i + 1) % opts.length]; break; }
      }
      gAudio.playbackRate = next;
      try { sessionStorage.setItem(speedKey(gAudio), String(next)); } catch (_) { /* ignore */ }
      speedBtn.textContent = next + '\u00D7';
      speedBtn.setAttribute('aria-label', tpl(settings.labels.speed, { x: next }));
      announce(gWrap, tpl(settings.labels.speedChanged, { x: next }));
      updatePositionState(gAudio);
    });
    right.appendChild(speedBtn);
    var ccBtn = document.createElement('button');
    ccBtn.type = 'button';
    ccBtn.className = 'podcast-player-btn pp-btn pp-global-captions';
    ccBtn.setAttribute('aria-pressed', 'false');
    ccBtn.setAttribute('aria-label', settings.labels.captions);
    ccBtn.textContent = 'CC';
    ccBtn.addEventListener('click', function () {
      gAudio._captionsOn = !gAudio._captionsOn;
      try { sessionStorage.setItem('pp-captions', gAudio._captionsOn ? '1' : '0'); } catch (_) { /* ignore */ }
      ccBtn.setAttribute('aria-pressed', gAudio._captionsOn ? 'true' : 'false');
      announce(gWrap, gAudio._captionsOn ? settings.labels.captionsOn : settings.labels.captionsOff);
      if (gAudio._captionsOn && !gAudio._cues) {
        loadCuesFor(gAudio).then(function (cues) {
          gAudio._cues = cues || [];
          updateCaption(gAudio);
        });
      } else {
        updateCaption(gAudio);
      }
    });
    right.appendChild(ccBtn);
    var shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'podcast-player-btn pp-btn pp-global-share';
    shareBtn.setAttribute('aria-label', settings.labels.share);
    shareBtn.appendChild(icon('share'));
    shareBtn.addEventListener('click', shareCurrent);
    right.appendChild(shareBtn);
    var detailsBtn = document.createElement('button');
    detailsBtn.type = 'button';
    detailsBtn.className = 'podcast-player-btn pp-btn pp-global-details-btn';
    detailsBtn.setAttribute('aria-expanded', 'false');
    detailsBtn.setAttribute('aria-label', settings.labels.details);
    detailsBtn.textContent = '\u2261';
    detailsBtn.title = settings.labels.details;
    detailsBtn.addEventListener('click', function () { toggleGlobalDetails(); });
    right.appendChild(detailsBtn);
    gDetailsBtn = detailsBtn;
    var minimize = document.createElement('button');
    minimize.type = 'button';
    minimize.className = 'podcast-player-btn pp-btn pp-global-minimize';
    minimize.setAttribute('aria-label', settings.labels.minimize);
    minimize.title = settings.labels.minimize;
    minimize.appendChild(icon('minimize'));
    right.appendChild(minimize);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'podcast-player-btn pp-btn pp-global-close';
    close.setAttribute('aria-label', settings.labels.closeMini);
    close.title = settings.labels.closeMini;
    close.appendChild(icon('close'));
    right.appendChild(close);

    play.addEventListener('click', function () {
      if (gAudio.paused) playMedia(gAudio); else gAudio.pause();
    });
    navPrev.addEventListener('click', function () { globalFeedJump(-1); });
    navNext.addEventListener('click', function () { globalFeedJump(1); });
    // Hide (minimize): the bar collapses, playback continues.
    minimize.addEventListener('click', function () { minimizeGlobal(); });
    // Quit: stops playback and unloads the episode (distinct from hide).
    close.addEventListener('click', function () {
      quitGlobal();
    });
    scrub.addEventListener('input', function () {
      gAudio.currentTime = parseFloat(scrub.value) || 0;
      syncGlobalBar();
    });

    function syncSurfaces(playing) {
      gSurfaces.forEach(function (s) { try { s(playing); } catch (_) { /* ignore */ } });
    }
    gAudio.addEventListener('play', function () {
      activeAudio = gAudio;
      updateMediaSession(gAudio, -1);
      setPlaybackState('playing');
      updatePositionState(gAudio);
      syncPlayUI(gAudio, true);
      syncGlobalPlayUI(true);
      syncSurfaces(true);
      showGlobalBar(); // reappear if the user closed the bar
    });
    gAudio.addEventListener('pause', function () {
      setPlaybackState('paused');
      syncPlayUI(gAudio, false);
      syncGlobalPlayUI(false);
      syncSurfaces(false);
    });
    gAudio.addEventListener('ended', function () {
      clearPosition(gAudio);
      setPlaybackState('paused');
      syncPlayUI(gAudio, false);
      syncGlobalPlayUI(false);
      syncSurfaces(false);
      autoAdvanceNext();
    });
    gAudio.addEventListener('loadedmetadata', function () {
      restorePosition(gAudio);
      var t = timeParam();
      if (isFinite(t) && t > 0) {
        gAudio.currentTime = Math.min(t, isFinite(gAudio.duration) ? gAudio.duration : t);
        try {
          if (/[?&]autoplay=1/.test(window.location.hash)) {
            playMedia(gAudio);
          }
        } catch (_) { /* ignore */ }
      }
      syncGlobalBar();
    });
    gAudio.addEventListener('timeupdate', function () {
      savePosition(gAudio);
      syncGlobalBar();
      updateTimeDisplay(gAudio);
      updatePositionState(gAudio);
    });
    gAudio.addEventListener('durationchange', function () {
      syncGlobalBar();
      updatePositionState(gAudio);
    });
    gAudio.addEventListener('ratechange', function () { updatePositionState(gAudio); });

    // "Details" panel: chapters/transcript/bookmarks, collapsed by default.
    var details = document.createElement('div');
    details.className = 'pp-global-details-panel';
    details.hidden = true;
    gWrap.appendChild(details);
    gDetails = details;

    gWrap.appendChild(bar);
    gWrap.hidden = true;
    ensureLiveRegion(gWrap);
    document.body.appendChild(gWrap);

    // Floating "reopen player" button: the persistent bar can be closed
    // (close keeps the audio playing) and brought back at any time.
    var reopen = document.createElement('button');
    reopen.type = 'button';
    reopen.className = 'podcast-player-btn pp-global-reopen';
    reopen.setAttribute('aria-label', settings.labels.openMini);
    reopen.hidden = true;
    var rImg = document.createElement('img');
    rImg.className = 'pp-global-reopen-cover';
    rImg.alt = '';
    reopen.appendChild(rImg);
    var rIcon = document.createElement('span');
    rIcon.className = 'pp-global-reopen-icon';
    rIcon.appendChild(icon('play'));
    reopen.appendChild(rIcon);
    reopen.addEventListener('click', function () {
      showGlobalBar();
      updateReopenButton();
    });
    document.body.appendChild(reopen);
    gReopenBtn = reopen;
    loadFeed();
  }

  // Show the persistent bar (also from the floating reopen button); the
  // reopen button hides whenever the bar is visible.
  function showGlobalBar() {
    gWrap.hidden = false;
    document.body.classList.add('pp-has-global');
    if (gReopenBtn) gReopenBtn.hidden = true;
  }

  // Build (or rebuild) the "details" panel of the bottom player:
  // chapters/transcript/bookmarks — collapsed by default, never in the page.
  function buildGlobalDetails() {
    if (!gDetails) return;
    cleanupMediaListeners(gAudio);
    gDetails.innerHTML = '';
    var panels = document.createElement('div');
    panels.className = 'pp-panels';
    gDetails.appendChild(panels);
    buildChapters(gAudio, gWrap, panels);
    buildTranscript(gAudio, gWrap, panels);
    buildBookmarks(gAudio, gAudio, gWrap, panels);
  }

  function toggleGlobalDetails() {
    if (!gDetails) return;
    gDetails.hidden = !gDetails.hidden;
    if (gDetailsBtn) {
      gDetailsBtn.setAttribute('aria-expanded', gDetails.hidden ? 'false' : 'true');
    }
  }

  // Quit the persistent player: stop playback and unload the episode.
  // Hiding (minimize) is a different action — it never touches playback.
  function quitGlobal() {
    gAudio.pause();
    if (gAudio._hls) { try { gAudio._hls.destroy(); } catch (_) { /* ignore */ } }
    gAudio._hls = null;
    gAudio.dataset.hlsAttached = '';
    gAudio.removeAttribute('src');
    gLoadedSrc = '';
    gLoadedRoute = '';
    gAudio._coverUrl = '';
    gWrap.querySelectorAll('.pp-global-title').forEach(function (tEl) {
      tEl.textContent = '';
    });
    gWrap.hidden = true;
    document.body.classList.remove('pp-has-global');
    updateReopenButton();
    try { if (navigator.mediaSession) navigator.mediaSession.metadata = null; } catch (_) { /* ignore */ }
  }

  // The floating reopen button appears only when the bar was hidden while
  // an episode is still loaded (never after a quit).
  function updateReopenButton() {
    if (!gReopenBtn) return;
    var loaded = gAudio && gAudio.getAttribute('src');
    if (gWrap.hidden && loaded) {
      gReopenBtn.hidden = false;
      var img = gReopenBtn.querySelector('.pp-global-reopen-cover');
      if (img && gAudio._coverUrl && img.getAttribute('src') !== gAudio._coverUrl) {
        img.src = gAudio._coverUrl;
      }
    } else {
      gReopenBtn.hidden = true;
    }
  }

  // Episode prev/next from the catalog (bar buttons and the expanded
  // panel header share the same action).
  function globalFeedJump(dir) {
    loadFeed().then(function () {
      var entry = neighborEntry(dir);
      if (!entry) return;
      globalLoadEntry(entry);
      playMedia(gAudio);
    });
  }

  // Hide (minimize): the bar collapses, playback continues.
  function minimizeGlobal() {
    gWrap.hidden = true;
    document.body.classList.remove('pp-has-global');
    updateReopenButton();
  }

  function timeParam() {
    var m = /[?&]t=([^&]+)/.exec(window.location.hash);
    if (!m) return NaN;
    var raw = decodeURIComponent(m[1]);
    var mm = /^(\d+):(\d{1,2})$/.exec(raw);
    if (mm) return (+mm[1]) * 60 + (+mm[2]);
    var s = parseFloat(raw);
    return isFinite(s) ? s : NaN;
  }

  // At episode end: load the next episode from the catalog, try to keep
  // playing (autoplay may be blocked), and navigate to its page.
  function autoAdvanceNext() {
    if (!settings.autoAdvance) return;
    loadFeed().then(function () {
      var entry = neighborEntry(1);
      if (!entry) return;
      announce(gWrap, tpl(settings.labels.nextEpAnnounce, { t: entry.title }));
      globalLoadEntry(entry);
      playMedia(gAudio);
      if (entry.pageUrl && gFeed && gFeed.series && gFeed.series.baseUrl) {
        var base = gFeed.series.baseUrl.replace(/\/$/, '');
        if (entry.pageUrl.indexOf(base) === 0) {
          window.location.hash = '#/' + entry.pageUrl.slice(base.length).replace(/^\//, '');
        }
      }
    });
  }

  // Copy a shareable link pointing at the playing episode + current time.
  function shareCurrent() {
    if (!gAudio.getAttribute('src')) return;
    var t = formatTime(Math.floor(gAudio.currentTime || 0));
    var base = location.origin + location.pathname;
    var route = gLoadedRoute || window.location.hash.split('?')[0];
    var url = base + route + '?t=' + t;
    var done = function () { announce(gWrap, settings.labels.linkCopied); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, done);
    } else {
      done();
    }
  }

  function syncGlobalNav() {
    if (!gBarReady()) return;
    var cur = currentEntry();
    gWrap.querySelectorAll('.pp-global-prev').forEach(function (prev) {
      prev.disabled = !cur || !cur.prev;
    });
    gWrap.querySelectorAll('.pp-global-next').forEach(function (next) {
      next.disabled = !cur || !cur.next;
    });
  }

  function syncGlobalBar() {
    if (!gBarReady()) return;
    var bar = gWrap.querySelector('.pp-global-bar');
    gWrap.querySelectorAll('.pp-global-title').forEach(function (tEl) {
      tEl.textContent = trackTitle(gAudio, -1);
    });
    bar.querySelector('.pp-global-time').textContent =
      formatTime(gAudio.currentTime) + ' / ' +
      (isFinite(gAudio.duration) ? formatTime(gAudio.duration) : '\u221E');
    if (gAudio._coverUrl) {
      gWrap.querySelectorAll('.pp-global-cover').forEach(function (img) {
        if (img.getAttribute('src') !== gAudio._coverUrl) img.src = gAudio._coverUrl;
      });
    }
    var scrub = bar.querySelector('.pp-global-scrubber');
    scrub.max = String(Math.max(0, Math.floor(isFinite(gAudio.duration) ? gAudio.duration : 0)));
    scrub.value = String(Math.max(0, Math.min(Math.floor(gAudio.currentTime), scrub.max)));
    syncGlobalNav();
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

  // ── Feed / catalog (feed.json, RSS fallback) ───────────────────────
  var gFeed = null;       // { series, episodes[] }
  var gFeedPromise = null;

  function loadFeed() {
    if (!settings.feedUrl) return Promise.resolve(null);
    if (gFeedPromise) return gFeedPromise;
    gFeedPromise = doLoadFeed().then(function (data) {
      gFeed = data;
      syncGlobalNav();
      return data;
    }).catch(function () { return null; });
    return gFeedPromise;
  }

  function doLoadFeed() {
    var cached = null;
    try { cached = sessionStorage.getItem('pp-feed'); } catch (_) { /* ignore */ }
    if (cached) {
      try { return Promise.resolve(JSON.parse(cached)); } catch (_) { /* ignore */ }
    }
    var root = siteRootUrl();
    var path = settings.feedUrl === true ? 'feed.json' : String(settings.feedUrl);
    return fetch(root + path).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (data) {
      try { sessionStorage.setItem('pp-feed', JSON.stringify(data)); } catch (_) { /* ignore */ }
      return data;
    }).catch(function () {
      if (settings.feedUrl !== true) throw new Error('no feed');
      return fetch(root + 'podcast.xml').then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      }).then(parseRssFeed);
    });
  }

  function xmlText(item, tag) {
    var n = item.getElementsByTagName(tag)[0];
    return n && n.textContent ? n.textContent.trim() : '';
  }
  function xmlAttr(item, tag, attr) {
    var n = item.getElementsByTagName(tag)[0];
    return n ? n.getAttribute(attr) || '' : '';
  }

  function parseRssFeed(xmlText_) {
    var doc = new DOMParser().parseFromString(xmlText_, 'application/xml');
    var channel = doc.getElementsByTagName('channel')[0];
    var series = {
      title: xmlText(channel, 'title'),
      description: xmlText(channel, 'description'),
      author: xmlText(channel, 'itunes:author'),
      artwork: xmlAttr(channel, 'itunes:image', 'href'),
      baseUrl: xmlText(channel, 'link'),
    };
    var items = doc.getElementsByTagName('item');
    var episodes = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var ep = {
        guid: xmlText(item, 'guid') || '',
        title: xmlText(item, 'title'),
        description: xmlText(item, 'description'),
        pageUrl: xmlText(item, 'link'),
        audioUrl: xmlAttr(item, 'enclosure', 'url'),
        coverUrl: xmlAttr(item, 'podcast:images', 'srcset').split(' ')[0] || '',
        chaptersUrl: xmlAttr(item, 'podcast:chapters', 'url'),
        transcriptUrl: xmlAttr(item, 'podcast:transcript', 'url'),
        date: xmlText(item, 'pubDate'),
        season: parseInt(xmlText(item, 'itunes:season') || '0') || 0,
        episode: parseInt(xmlText(item, 'itunes:episode') || '0') || 0,
      };
      ep.next = (items[i + 1] ? xmlText(items[i + 1], 'link') : '');
      ep.prev = (i > 0 ? xmlText(items[i - 1], 'link') : '');
      episodes.push(ep);
    }
    return { version: '1.0', series: series, episodes: episodes };
  }

  function pathOf(url) {
    return String(url || '').replace(/^https?:\/\/[^/]+/, '');
  }

  function currentEntry() {
    if (!gFeed || !gFeed.episodes) return null;
    var want = pathOf(gLoadedSrc);
    for (var i = 0; i < gFeed.episodes.length; i++) {
      if (pathOf(gFeed.episodes[i].audioUrl) === want) return gFeed.episodes[i];
    }
    return null;
  }

  function neighborEntry(dir) {
    var cur = currentEntry();
    if (!cur) return null;
    var key = dir < 0 ? 'prev' : 'next';
    var targetUrl = cur[key];
    if (!targetUrl) return null;
    for (var i = 0; i < gFeed.episodes.length; i++) {
      if (gFeed.episodes[i].pageUrl === targetUrl) return gFeed.episodes[i];
    }
    return null;
  }

  // Load an episode straight from the catalog (no page navigation).
  function globalLoadEntry(entry) {
    if (!entry || !entry.audioUrl) return;
    var route = '';
    if (entry.pageUrl && gFeed && gFeed.series && gFeed.series.baseUrl) {
      var base = gFeed.series.baseUrl.replace(/\/$/, '');
      if (entry.pageUrl.indexOf(base) === 0) {
        route = '#/' + entry.pageUrl.slice(base.length).replace(/^\//, '');
      }
    }
    var data = {};
    if (entry.title) data.title = entry.title;
    if (entry.chaptersUrl) data.chapters = entry.chaptersUrl;
    if (entry.transcriptUrl) data.transcript = entry.transcriptUrl;
    if (entry.downloadUrl) data.download = entry.downloadUrl;
    adoptGlobalSource({
      src: entry.audioUrl,
      route: route,
      data: data,
      coverUrl: entry.coverUrl || '',
    });
  }

  // Load an episode (a page <audio> element) into the global player.
  // Adopt a source descriptor into the persistent global player: media
  // src, dataset, cover, HLS reset, rate restore, UI sync. Returns true
  // when a source was adopted.
  function adoptGlobalSource(desc) {
    ensureGlobalPlayer();
    if (!desc || !desc.src) return false;
    gLoadedSrc = pathOf(desc.src);
    gLoadedRoute = desc.route || '';
    gAudio.setAttribute('src', desc.src);
    ['title', 'cover', 'chapters', 'download', 'originalSrc'].forEach(function (k) {
      if (desc.data && desc.data[k]) gAudio.dataset[k] = desc.data[k];
      else delete gAudio.dataset[k];
    });
    gAudio._coverUrl = desc.coverUrl || '';
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
    buildGlobalDetails();
    // Captions preference (per session) + cue load for the CC strip.
    var captionsPref = '1';
    try {
      var cp = sessionStorage.getItem('pp-captions');
      if (cp !== null) captionsPref = cp;
    } catch (_) { /* ignore */ }
    gAudio._captionsOn = captionsPref === '1';
    var ccBtn = gWrap.querySelector('.pp-global-captions');
    if (ccBtn) ccBtn.setAttribute('aria-pressed', gAudio._captionsOn ? 'true' : 'false');
    if (gAudio._captionsOn) {
      loadCuesFor(gAudio).then(function (cues) {
        gAudio._cues = cues || [];
        updateCaption(gAudio);
      });
    }
    updateMediaSession(gAudio, -1);
    showGlobalBar();
    syncGlobalBar();
    syncGlobalPlayUI();
    gSurfaces.forEach(function (s) { try { s(false); } catch (_) { /* ignore */ } });
    return true;
  }

  function globalLoad(sourceEl) {
    var src = sourceEl.getAttribute('src') || sourceEl.dataset.originalSrc || '';
    var data = {};
    ['title', 'cover', 'chapters', 'download', 'originalSrc'].forEach(function (k) {
      if (sourceEl.dataset[k]) data[k] = sourceEl.dataset[k];
    });
    var coverUrl = sourceEl._coverUrl;
    if (!coverUrl) {
      var stem = audioStem(sourceEl);
      if (stem) coverUrl = resolve(settings.coverPattern.replace('{stem}', stem));
    }
    // Triggering playback never changes the page interface: the compact
    // surface stays, the persistent bar takes over the interaction.
    adoptGlobalSource({
      src: src,
      route: window.location.hash || '',
      data: data,
      coverUrl: coverUrl,
    });
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
    wrap.dataset.enhanced = '1';
    // Hide the native <audio controls> inside the enhanced container.
    wrap.appendChild(el);

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
    var credits = Array.from(new Set(
      [settings.artist, settings.album].filter(Boolean)));
    if (credits.length) {
      sub.textContent = credits.join(' \u00B7 ');
    } else {
      sub.style.display = 'none';
    }
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
      showGlobalBar();
      if (globalIsCurrent(el)) {
        if (gAudio.paused) playMedia(gAudio); else gAudio.pause();
      } else {
        globalLoad(el);
        playMedia(gAudio);
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
        playMedia(gAudio);
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
      transcriptFollow: user.transcriptFollow !== undefined ? user.transcriptFollow : DEFAULTS.transcriptFollow,
      transcriptSearch: user.transcriptSearch !== undefined ? user.transcriptSearch : DEFAULTS.transcriptSearch,
      helpDialog: user.helpDialog !== undefined ? user.helpDialog : DEFAULTS.helpDialog,
      resumeChip: user.resumeChip !== undefined ? user.resumeChip : DEFAULTS.resumeChip,
      showBookmarks: user.showBookmarks !== undefined ? user.showBookmarks : DEFAULTS.showBookmarks,
      showCaptions: user.showCaptions !== undefined ? user.showCaptions : DEFAULTS.showCaptions,
      downloadSw: user.downloadSw !== undefined ? user.downloadSw : DEFAULTS.downloadSw,
      unified: user.unified !== undefined ? user.unified : DEFAULTS.unified,
      feedUrl: user.feedUrl !== undefined ? user.feedUrl : DEFAULTS.feedUrl,
      autoAdvance: user.autoAdvance !== undefined ? user.autoAdvance : DEFAULTS.autoAdvance,
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
