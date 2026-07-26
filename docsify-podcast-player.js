/*!
 * docsify-podcast-player
 * Audio / podcast player plugin for Docsify hash-routing SPAs.
 *
 * Features:
 *   - Fixes relative src/href paths for <audio>, <video>, <source>, <track>
 *     and media links (Docsify resolves them against index.html, not the page)
 *   - HLS (.m3u8) playback: native on Safari, hls.js everywhere else
 *   - Cover art (auto-detected <stem>-cover.png or via data-cover)
 *   - Clickable chapter list from a JSON file (data-chapters or auto-detected
 *     <name>.json next to the audio file)
 *   - Transcript panel generated from the WebVTT subtitles track (clickable
 *     cues that seek the player)
 *   - Playlist toolbar with previous / next track when a page has 2+ players
 *
 * Usage:
 *   window.$docsify.podcastPlayer = {
 *     hlsCdn:   'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
 *     showCover:     true,
 *     showChapters:  true,
 *     showTranscript:true,
 *     coverPattern:  '{stem}-cover.png',   // {stem} = audio file without ext
 *     chapterLabel:  'Chapitres',
 *     transcriptLabel:'Transcript',
 *     mediaExtensions: null,               // override the default list
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
    coverPattern: '{stem}-cover.png',
    chapterLabel: 'Chapitres',
    transcriptLabel: 'Transcript',
    mediaExtensions: [
      'm3u8', 'm4a', 'mp3', 'wav', 'ogg', 'flac', 'opus', 'aiff', 'webm',
      'mp4', 'mov', 'vtt', 'json', 'xml', 'csv', 'pdf', 'png', 'jpg',
      'jpeg', 'gif', 'webp', 'svg', 'blend', 'stl', 'glb', 'gltf',
    ],
  };

  var settings = {};
  var mediaExtRe = null;
  var hlsPromise = null;
  var playlist = [];
  var mediaSessionReady = false;

  // ── Path fixing ─────────────────────────────────────────────────────

  function isAbsolute(src) {
    return !src || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(src);
  }

  function routeDir() {
    var route = window.location.hash.replace(/^#\/?/, '').split('?')[0];
    return route.substring(0, route.lastIndexOf('/') + 1);
  }

  function basePath() {
    var bp = (window.$docsify && window.$docsify.basePath) || '';
    if (bp) return bp.replace(/\/+$/, '');
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

  function attachHls(el) {
    var src = el.getAttribute('src') || '';
    if (!/\.m3u8(?:[?#]|$)/i.test(src)) return;
    if (el.dataset.hlsAttached || nativeHls(el)) return;
    el.dataset.hlsAttached = '1';
    var original = src;
    el.removeAttribute('src');
    loadHlsJs().then(function (Hls) {
      if (!Hls.isSupported()) { el.setAttribute('src', original); return; }
      var hls = new Hls();
      hls.loadSource(original);
      hls.attachMedia(el);
      el._hls = hls;
    }).catch(function () { el.setAttribute('src', original); });
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
      var pattern = settings.coverPattern.replace('{stem}', audioStem(el));
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
    return isAbsolute(stem) ? stem + '.json' : resolve(stem + '.json');
  }

  function buildChapters(el, wrap) {
    if (!settings.showChapters) return;
    var url = chaptersUrl(el);
    if (!url) return;
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (chapters) {
      if (!Array.isArray(chapters) || !chapters.length) return;
      var box = document.createElement('details');
      box.className = 'podcast-player-chapters';
      var sum = document.createElement('summary');
      sum.textContent = settings.chapterLabel;
      box.appendChild(sum);
      var list = document.createElement('ol');
      chapters.forEach(function (ch) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = '#';
        a.textContent = formatTime(ch.startTime || 0) + ' — ' + (ch.title || '');
        a.addEventListener('click', function (e) {
          e.preventDefault();
          el.currentTime = parseFloat(ch.startTime || 0);
          el.play();
        });
        li.appendChild(a);
        list.appendChild(li);
      });
      box.appendChild(list);
      wrap.appendChild(box);
    }).catch(function () { /* no chapters — fine */ });
  }

  // ── Transcript (from VTT) ───────────────────────────────────────────

  function transcriptUrl(el) {
    var track = el.querySelector('track[kind="subtitles"], track[kind="captions"]');
    if (track && track.getAttribute('src')) {
      var t = track.getAttribute('src');
      return isAbsolute(t) ? t : resolve(t);
    }
    return resolve(audioStem(el) + '.vtt');
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
    btn.addEventListener('click', function () {
      if (!panel.dataset.loaded) {
        fetch(transcriptUrl(el)).then(function (r) {
          if (!r.ok) throw new Error(r.status);
          return r.text();
        }).then(function (text) {
          var cues = parseVtt(text);
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
          panel.dataset.loaded = '1';
        }).catch(function () { panel.textContent = 'Transcript indisponible.'; });
      }
      panel.hidden = !panel.hidden;
      btn.setAttribute('aria-expanded', String(!panel.hidden));
    });
    wrap.appendChild(btn);
    wrap.appendChild(panel);
  }

  // ── Playlist (prev / next) ──────────────────────────────────────────

  // MediaSession next/previous-track actions jump to the adjacent episode
  // using the prev/next links docsify-pagination renders on every page.
  // docsify-pagination puts the class on a wrapper <div> with the <a>
  // inside, so we look for the inner anchor (falling back to the element
  // itself in case the class is on the <a> directly).
  function navToEpisode(sel) {
    var link = document.querySelector(sel + ' a') || document.querySelector(sel);
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.charAt(0) === '#') href = href.slice(1);
    if (href) window.location.hash = href;
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
    } catch (e) { /* some actions unsupported — ignore */ }
  }

  function updateMediaSession(el, index) {
    if (!navigator.mediaSession || !window.MediaMetadata) return;
    var title = trackTitle(el, index) || (document.title || 'Podcast');
    var artwork = [];
    if (el._coverUrl) {
      artwork.push({ src: el._coverUrl, sizes: '512x512', type: 'image/png' });
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: 'Souveraineté numérique',
        album: 'Souveraineté numérique',
        artwork: artwork,
      });
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
    if (target.el.scrollIntoView) target.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (autoplay) target.el.play();
  }

  function buildToolbar(entry, index) {
    var bar = document.createElement('div');
    bar.className = 'podcast-player-toolbar';

    if (playlist.length > 1) {
      var prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'podcast-player-btn podcast-player-prev';
      prev.textContent = '⏮';
      prev.title = 'Piste précédente';
      prev.disabled = index === 0;
      prev.addEventListener('click', function () { goTo(index - 1, true); });

      var next = document.createElement('button');
      next.type = 'button';
      next.className = 'podcast-player-btn podcast-player-next';
      next.textContent = '⏭';
      next.title = 'Piste suivante';
      next.disabled = index === playlist.length - 1;
      next.addEventListener('click', function () { goTo(index + 1, true); });

      var label = document.createElement('span');
      label.className = 'podcast-player-title';
      label.textContent = (index + 1) + '/' + playlist.length + ' · ' +
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

  // ── Enhance one <audio> ──────────────────────────────────────────────

  function enhance(el, index) {
    if (el.dataset.podcastEnhanced) return;
    el.dataset.podcastEnhanced = '1';

    var wrap = document.createElement('div');
    wrap.className = 'podcast-player';
    el.parentNode.insertBefore(wrap, el);

    var bar = buildToolbar(playlist[index], index);
    if (bar.childNodes.length) wrap.appendChild(bar);
    wrap.appendChild(el);

    addCover(el, wrap);
    buildChapters(el, wrap);
    buildTranscript(el, wrap);

    el.addEventListener('play', function () {
      attachHls(el);
      updateMediaSession(el, index);
      playlist.forEach(function (p) {
        if (p.el !== el) p.el.pause();
      });
    }, { once: false });

    attachHls(el);
  }

  // ── Styles ───────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('podcast-player-styles')) return;
    var css = [
      '.podcast-player { margin: 1em 0; display: flex; flex-wrap: wrap;',
      '  gap: 1em; align-items: flex-start; }',
      '.podcast-player audio { flex: 1 1 280px; width: 100%; min-width: 240px;',
      '  display: block; }',
      '.podcast-player-cover { width: 120px; height: 120px; object-fit: cover;',
      '  border-radius: 8px; flex: 0 0 auto; background: #0001; }',
      '.podcast-player-toolbar { flex: 1 1 100%; display: flex; align-items: center;',
      '  gap: .5em; margin-bottom: .25em; }',
      '.podcast-player-btn { border: 1px solid var(--theme-color, #ccc);',
      '  background: transparent; border-radius: 4px; cursor: pointer;',
      '  padding: .15em .6em; font-size: 1em; line-height: 1.4; }',
      '.podcast-player-btn:disabled { opacity: .4; cursor: default; }',
      '.podcast-player-title { font-size: .85em; opacity: .8;',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.podcast-player-chapters { flex: 1 1 100%; font-size: .9em; }',
      '.podcast-player-chapters summary { cursor: pointer; font-weight: 600;',
      '  margin: .25em 0; }',
      '.podcast-player-chapters ol { margin: .25em 0; padding-left: 1.4em; }',
      '.podcast-player-chapters a { text-decoration: none; }',
      '.podcast-player-chapters a:hover { text-decoration: underline; }',
      '.podcast-player-transcript-btn { border: 1px solid var(--theme-color, #ccc);',
      '  background: transparent; border-radius: 4px; cursor: pointer;',
      '  padding: .15em .6em; margin-top: .25em; font-size: .85em; }',
      '.podcast-player-transcript { flex: 1 1 100%; max-height: 18em; overflow: auto;',
      '  border: 1px solid var(--theme-color, #ccc); border-radius: 6px;',
      '  padding: .5em .75em; margin-top: .25em; font-size: .9em; line-height: 1.5; }',
      '.podcast-player-transcript p { margin: .15em 0; }',
      '.podcast-player-cue { border: 0; background: none; color: var(--theme-color, #36c);',
      '  cursor: pointer; font-variant-numeric: tabular-nums; padding: 0;',
      '  font-weight: 600; }',
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
      hlsCdn: user.hlsCdn || DEFAULTS.hlsCdn,
      showCover: user.showCover !== undefined ? user.showCover : DEFAULTS.showCover,
      showChapters: user.showChapters !== undefined ? user.showChapters : DEFAULTS.showChapters,
      showTranscript: user.showTranscript !== undefined ? user.showTranscript : DEFAULTS.showTranscript,
      coverPattern: user.coverPattern || DEFAULTS.coverPattern,
      chapterLabel: user.chapterLabel || DEFAULTS.chapterLabel,
      transcriptLabel: user.transcriptLabel || DEFAULTS.transcriptLabel,
      mediaExtensions: user.mediaExtensions || DEFAULTS.mediaExtensions,
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
