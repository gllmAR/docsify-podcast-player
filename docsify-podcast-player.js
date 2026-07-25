/*!
 * docsify-podcast-player
 * Audio player plugin for Docsify hash-routing SPAs.
 *
 * Features:
 *   - Fixes relative src/href paths for <audio>, <video>, <source>, <track>
 *     and media links (Docsify resolves them against index.html, not the page)
 *   - HLS (.m3u8) playback: native on Safari, hls.js everywhere else
 *   - Playlist toolbar with previous / next track when a page has 2+ players
 *   - Optional chapter menu from a JSON file (data-chapters attribute or
 *     auto-detected <name>.json next to the audio file)
 *
 * Usage:
 *   window.$docsify.podcastPlayer = {
 *     hlsCdn: 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
 *     mediaExtensions: null, // override the default extension list
 *   };
 *   <script src="vendor/docsify-podcast-player/docsify-podcast-player.js"></script>
 */
(function () {
  'use strict';

  var DEFAULTS = {
    hlsCdn: 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
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
    el.removeAttribute('src');
    loadHlsJs().then(function (Hls) {
      if (!Hls.isSupported()) {
        el.setAttribute('src', src);
        return;
      }
      var hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(el);
      el._hls = hls;
    }).catch(function () {
      el.setAttribute('src', src);
    });
  }

  // ── Chapters ────────────────────────────────────────────────────────

  function chaptersUrl(el) {
    if (el.dataset.chapters) {
      return isAbsolute(el.dataset.chapters)
        ? el.dataset.chapters
        : resolve(el.dataset.chapters);
    }
    var src = el.dataset.originalSrc || el.getAttribute('src') || '';
    var m = src.match(/^(.*)\.(?:m3u8|m4a|mp3|ogg|opus|flac|wav)(?:[?#]|$)/i);
    if (!m) return null;
    return isAbsolute(m[1]) ? m[1] + '.json' : resolve(m[1] + '.json');
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

  function buildChapterMenu(el, wrap) {
    var url = chaptersUrl(el);
    if (!url) return;
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (chapters) {
      if (!Array.isArray(chapters) || !chapters.length) return;
      var sel = document.createElement('select');
      sel.className = 'podcast-player-chapters';
      sel.setAttribute('aria-label', 'Chapters');
      var opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = '\u2630 Chapitres';
      sel.appendChild(opt0);
      chapters.forEach(function (ch) {
        var o = document.createElement('option');
        o.value = String(ch.startTime || 0);
        o.textContent = formatTime(ch.startTime || 0) + ' \u2014 ' + (ch.title || '');
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        if (sel.value === '') return;
        el.currentTime = parseFloat(sel.value);
        el.play();
        sel.selectedIndex = 0;
      });
      wrap.appendChild(sel);
    }).catch(function () { /* no chapters — fine */ });
  }

  // ── Playlist (prev / next) ──────────────────────────────────────────

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
    target.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (autoplay) target.el.play();
  }

  function buildToolbar(entry, index) {
    var bar = document.createElement('div');
    bar.className = 'podcast-player-toolbar';

    if (playlist.length > 1) {
      var prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'podcast-player-btn podcast-player-prev';
      prev.textContent = '\u23ee';
      prev.title = 'Piste pr\u00e9c\u00e9dente';
      prev.disabled = index === 0;
      prev.addEventListener('click', function () { goTo(index - 1, true); });

      var next = document.createElement('button');
      next.type = 'button';
      next.className = 'podcast-player-btn podcast-player-next';
      next.textContent = '\u23ed';
      next.title = 'Piste suivante';
      next.disabled = index === playlist.length - 1;
      next.addEventListener('click', function () { goTo(index + 1, true); });

      var label = document.createElement('span');
      label.className = 'podcast-player-title';
      label.textContent = (index + 1) + '/' + playlist.length + ' \u00b7 ' +
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

  function enhance(el, index) {
    if (el.dataset.podcastEnhanced) return;
    el.dataset.podcastEnhanced = '1';

    var wrap = document.createElement('div');
    wrap.className = 'podcast-player';
    el.parentNode.insertBefore(wrap, el);

    var bar = buildToolbar(playlist[index], index);
    if (bar.childNodes.length) wrap.appendChild(bar);
    wrap.appendChild(el);
    buildChapterMenu(el, wrap);

    el.addEventListener('play', function () {
      attachHls(el);
      playlist.forEach(function (p) {
        if (p.el !== el) p.el.pause();
      });
    }, { once: false });

    attachHls(el);
  }

  function injectStyles() {
    if (document.getElementById('podcast-player-styles')) return;
    var css = [
      '.podcast-player { margin: 1em 0; }',
      '.podcast-player audio { width: 100%; display: block; }',
      '.podcast-player-toolbar { display: flex; align-items: center;',
      '  gap: .5em; margin-bottom: .25em; }',
      '.podcast-player-btn { border: 1px solid var(--theme-color, #ccc);',
      '  background: transparent; border-radius: 4px; cursor: pointer;',
      '  padding: .15em .6em; font-size: 1em; line-height: 1.4; }',
      '.podcast-player-btn:disabled { opacity: .4; cursor: default; }',
      '.podcast-player-title { font-size: .85em; opacity: .8;',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.podcast-player-chapters { margin-top: .25em; max-width: 100%;',
      '  font-size: .85em; }',
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
      mediaExtensions: user.mediaExtensions || DEFAULTS.mediaExtensions,
    };
    mediaExtRe = new RegExp(
      '\\.(?:' + settings.mediaExtensions.join('|') + ')(?:[?#]|$)', 'i'
    );
    injectStyles();
    window.$docsify = window.$docsify || {};
    window.$docsify.plugins = (window.$docsify.plugins || []).concat(plugin);
  }

  install();
})();
