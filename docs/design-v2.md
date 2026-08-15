# Design v2 — docsify-podcast-player overhaul

> Status: **proposal** — design document for the 1.3.0 refactor.
> Goals: accessibility (WCAG 2.2 AA), ergonomics, responsiveness.
> Scope: player UI + a11y + responsive only — playback/remux/SW machinery
> (ts2m4a, MediaSession, path fixing, HLS) stays untouched and backwards
> compatible.

---

## 1. Current-state audit (v1.2.6)

The player is a thin enhancement layer over the native `<audio>` element:

```
.podcast-player (flex-wrap, tabindex=0, role=region)
├── img.podcast-player-cover        (120×120, swap per chapter)
├── audio[controls]                 (native controls — the whole UI)
├── div.podcast-player-toolbar      (prev/next when 2+ players)
├── details.podcast-player-chapters (summary + ol of links)
├── button.podcast-player-transcript-btn + div.podcast-player-transcript
└── a.podcast-player-download       (real .m4a URL)
```

Injected CSS: ~55 rules, `var(--theme-color)` theming, flex-wrap layout.

### What works well (keep)

- Real-URL download + SW synthesis + main-thread fallback (copy-link works)
- MediaSession: metadata, artwork (truthful type/sizes), chapterInfo with
  per-chapter art, positionState, play/pause/stop/seek handlers
- Chapter list, transcript from VTT, position persistence, autoplay resume
- Path fixing for docsify hash routing; works on the course site via
  remote-repo pages
- Pure-JS, zero dependencies, single-file CDN distribution, 46 passing tests

### Accessibility gaps (the main driver of this refactor)

| # | Gap | Impact |
|---|-----|--------|
| A1 | UI **is** the native audio controls — appearance/behavior differ per browser/theme; docsify themes often restyle them poorly | inconsistent, hard to theme, no brand identity |
| A2 | No custom **progress bar / seek slider**; scrubber a11y (valuetext, step, chapter ticks) impossible | screen-reader users can't seek precisely |
| A3 | Prev/next toolbar buttons are bare glyphs (`⏮ ⏭`) with `title` only | SR reads "⏮"; no `aria-label` |
| A4 | Space key handler toggles play even when focus is on a button → double-toggle bug (button click + play/pause) | keyboard users get inverted state |
| A5 | Chapter links are `<a href="#">` with no `aria-current` on the active chapter | no programmatic "where am I" |
| A6 | Transcript: no `aria-controls`, no active-cue `aria-current`, no autoscroll, cue buttons unlabeled | SR can't follow along |
| A7 | No visually-hidden **aria-live region** — busy/error/state changes are silent | download progress, errors, speed changes unannounced |
| A8 | Errors are styled divs, no `role="alert"` | not announced |
| A9 | Loading indicator is a ▶ char with `title` only | not announced (`role="status"` missing) |
| A10 | No focus-visible ring on buttons (only the wrap) | keyboard users can't see focus |
| A11 | Touch targets ~22–28 px (`padding: .15em .6em`) | < 44 px WCAG 2.5.5 |
| A12 | `prefers-reduced-motion` not honored (pulse animation) | vestibular issues |
| A13 | Color contrast depends on `--theme-color` (often #36c on white = 4.7:1 OK, but docsify dark themes / low-contrast accents fail) | needs tokens + fallbacks |
| A14 | No `aria-keyshortcuts`, no shortcut help; shortcuts undocumented for SR users | discoverability |
| A15 | Multiple players: active one has no programmatic indicator | SR can't tell which is playing |

### Responsive gaps

- One flex-wrap layout for all widths; cover fixed 120 px; controls crowd on
  ≤ 400 px viewports
- Transcript fixed `max-height: 18em`; no mobile-specific touch layout
- No sticky mini-player for long episodes (common podcast UX)
- No safe-area handling, no print behavior

### Ergonomics gaps

- No back/forward buttons (keyboard-only today)
- No chapter prev/next jump buttons
- No playback-speed control (we set `playbackRate` in MediaSession but expose
  no UI)
- No visible time (current/total) — native controls only
- No volume control of our own (native only)
- Transcript doesn't follow playback (no active cue highlight / autoscroll)

---

## 2. Design principles

1. **A11y first** — WCAG 2.2 AA targets: keyboard operable, focus visible,
   names/labels everywhere, live announcements, reduced motion, contrast
   tokens, `aria-current`, `aria-live` done right (never announce every
   second of playback).
2. **Progressive enhancement** — native `<audio controls>` stays in the DOM
   as the no-JS / failure fallback. Custom UI is layered on; if enhancement
   throws, the native player remains usable.
3. **Themeable tokens** — CSS custom properties on `.podcast-player`,
   deriving from `--theme-color` with safe fallbacks, light + dark
   (`prefers-color-scheme`), forced-colors support.
4. **Mobile-first responsive** — 3 tiers (base / ≥560 px / ≥900 px), 44 px
   touch targets, optional sticky mini-player.
5. **Ergonomic by default** — standard podcast controls: play, back/forward
   10 s, chapter prev/next, scrubber with chapter ticks, speed, volume,
   transcript that follows playback.
6. **Zero new dependencies, single-file** — stays a self-contained CDN
   plugin; styles remain injected (overridable), no framework.
7. **Backwards compatible** — existing config keys keep working; new keys
   additive; existing markup (plain `<audio>`) keeps being enhanced; the 46
   existing tests stay green and new ones are added.

---

## 3. Target DOM architecture (v2)

```
.podcast-player            [role=group] [aria-label="Titre de l'épisode"]
                            [data-state=loading|ready|playing|paused|error]
├── .pp-card
│   ├── .pp-main
│   │   ├── .pp-cover          (img, 120→160px, swap per chapter; role=img
│   │   │                       aria-label = episode title — not empty)
│   │   └── .pp-meta
│   │       ├── .pp-title      (h3 — episode title)
│   │       ├── .pp-sub        (artist · album — muted)
│   │       └── .pp-now        (current chapter, aria-live=off, updated at
│   │                            chapter boundaries only)
│   ├── .pp-controls           (one row; wraps on narrow)
│   │   ├── .pp-btn-play       (aria-label Pause/Écouter — dynamic)
│   │   ├── .pp-btn-back       (aria-label "Reculer de 10 s")
│   │   ├── .pp-btn-forward    (aria-label "Avancer de 10 s")
│   │   ├── .pp-btn-chap-prev  (aria-label "Chapitre précédent" — if chapters)
│   │   ├── .pp-btn-chap-next  (aria-label "Chapitre suivant" — if chapters)
│   │   ├── .pp-time           (<time> current / total, tabular-nums, aria-live=off)
│   │   ├── .pp-scrubber       (input[type=range], chapter tick marks)
│   │   ├── .pp-speed          (button cycling 0.75/1/1.25/1.5/2×)
│   │   ├── .pp-volume         (mute button [aria-pressed] + input[type=range])
│   │   └── .pp-btn-download   (a, real .m4a URL — unchanged machinery)
│   ├── .pp-panels             (grid 2 cols ≥900px)
│   │   ├── details.pp-chapters (summary + ol; li buttons aria-current)
│   │   └── .pp-transcript      (toggle button [aria-expanded][aria-controls]
│   │                            + region; active cue aria-current + autoscroll)
│   └── .pp-live               (visually-hidden aria-live=polite region)
└── audio[controls]            (kept; hidden visually once enhanced via
                                .podcast-player[data-enhanced] audio)

Also injected, once per page:
<style id="podcast-player-styles-v2"> … </style>
```

Key decisions:

- **Custom controls replace the native UI visually** (`audio` hidden by
  `[data-enhanced]`), because a11y and theming of native controls cannot be
  controlled. The native element remains functional (it *is* the media
  element). If `enhance()` throws before `data-enhanced` is set, native
  controls stay visible.
- **Scrubber is a real `<input type="range">`**: free keyboard/AT support,
  `aria-valuetext="12:34 / 45:00"`, `step="1"` with ArrowLeft/Right handled
  as ±10 s (custom handler), PageUp/PageDown = chapter jump, Home/End.
  Chapter ticks drawn via CSS `background` gradient (decorative, never
  semantic).
- **The live region is one element** used for: download started/finished/
  failed, speed change, mute state, error alerts (`role="alert"` separate
  assertive element), never for ticking playback time.
- **Chapter list** stays `<details>/<summary>` (native disclosure, keyboard
  safe); items become `<button>` with `aria-current="true"` on active;
  active item `scrollIntoView({block:'nearest'})`.
- **Transcript**: `aria-controls` on the toggle; active cue `aria-current`;
  autoscroll (reduced-motion aware); speaker labels from VTT `<v>` rendered
  as styled names (`.pp-speaker`).
- **Playlist** (2+ players): active card gets `data-active` + `aria-current`
  region indicator; only one plays (already).

---

## 4. Styling system

### Tokens (CSS custom properties, all overridable)

```css
.podcast-player {
  --pp-accent:        var(--theme-color, #3b6ea5);
  --pp-accent-contrast:#fff;              /* text on accent */
  --pp-bg:            #ffffff;
  --pp-bg-alt:        #f6f7f9;
  --pp-text:          #1c1e21;
  --pp-text-muted:    #5c6470;            /* ≥4.5:1 on --pp-bg */
  --pp-border:        #d4d9e0;
  --pp-radius:        12px;
  --pp-control:       40px;               /* height of control row */
  --pp-touch:         44px;               /* mobile touch targets */
  --pp-cover:         120px;
  --pp-focus:         2px solid var(--pp-accent);
  --pp-shadow:        0 1px 3px rgb(0 0 0 / .12);
}
@media (prefers-color-scheme: dark) { .podcast-player { …dark tokens… } }
@media (forced-colors: active)      { .podcast-player { …border-based… } }
```

### Rules

- All selectors scoped under `.podcast-player` (or `.pp-`); zero globals.
- Focus-visible ring on every interactive element (`outline`/`box-shadow`).
- Disabled controls: `opacity .45` **plus** a non-color cue (icon dim only
  acceptable when `aria-disabled` present; buttons use real `disabled`).
- Active states: color **+** weight/border (never color alone).
- Reduced motion: kills pulse/spin/smooth scroll; scrubber & autoscroll
  become instant.
- Print: `.podcast-player { display:none }` unless `data-print="keep-title"`.
- The CSS is injected once with id `podcast-player-styles-v2`; sites can
  override tokens via their own stylesheet (documented in README).

### Layout tiers

| Tier | Width | Layout |
|------|-------|--------|
| base | < 560 px | cover 88 px; controls wrap (row1: play/back/fwd/speed/download; row2: scrubber; time inline); panels stacked; touch targets 44 px |
| ≥ 560 | ≥ 560 px | cover 120 px; single control row; scrubber flexes; panels stacked or 2-col |
| ≥ 900 | ≥ 900 px | cover 140–160 px; `.pp-panels` grid 2 columns (chapters \| transcript); hover tooltip on scrubber (desktop pointer only) |

### Sticky mini-player (opt-in, default off)

`miniPlayer: true` → after scroll past the player, a fixed bottom bar:
cover thumb 44 px · title (truncated) · play/pause · close. Uses
`position: sticky` equivalent via IntersectionObserver; adds
`padding-bottom: env(safe-area-inset-bottom)`; `aria-label="Mini-lecteur"`;
dismissible; disabled during print.

---

## 5. Accessibility specification (WCAG 2.2 AA mapping)

| Control | Semantics / behavior |
|---------|----------------------|
| Play/pause | `<button>` `aria-label` = "Pause" while playing, "Écouter" while paused; icon + text swap; focus stays on button |
| Back/Forward | `aria-label="Reculer de 10 s"` / "Avancer de 10 s" (label uses configured `seekSeconds`) |
| Chapter prev/next | only when chapters exist; jump to previous/next boundary (same logic as MediaSession handlers — reuse) |
| Scrubber | `input[type=range]` `aria-label="Position"` `aria-valuetext="12:34 sur 45:00"`; keys: ←/→ ±10 s, PageUp/PageDown chapter, Home/End 0/fin |
| Time | `<time datetime="PT12M34S">12:34 / 45:00</time>`, `aria-live="off"` (never announce ticking) |
| Speed | button `aria-label="Vitesse : 1×"` cycling `[0.75, 1, 1.25, 1.5, 2]`; change announced once via live region |
| Volume | mute button `aria-pressed`; range `aria-label="Volume"` 0–100; muted announced once |
| Chapters | `<details><summary>`; `<ol><li><button>` with `aria-current="true"` on active; active scrolled into view |
| Transcript | toggle `aria-expanded` + `aria-controls`; panel `role="region" aria-label="Transcript"`; active cue `aria-current="true"` + autoscroll; cue button `aria-label="Écouter à 12:34"` |
| Download | `a` with `aria-label="Télécharger <filename>"`; busy → `aria-busy` + live announcement; error → `role="alert"` |
| Loading | `role="status"` `aria-label="Chargement…"` (spinner) |
| Errors | `role="alert"` (assertive) containers; retry button labeled |
| Live region | one `aria-live="polite"` visually hidden element; announcements only on discrete events |
| Shortcuts | `aria-keyshortcuts` on the wrap + optional `?` help dialog listing: Space play/pause, ←/→ ±10 s, ↑/↓ volume, M mute, J/L −/+10 s, T transcript, C chapters, PageUp/PageDown chapter |
| Space bug | keydown handler ignores events originating from buttons/links/inputs (fix A4) |
| Focus | after transcript toggle → focus panel; after download busy → return to button; `:focus-visible` everywhere |

### Keyboard shortcuts (final set)

| Keys | Action |
|------|--------|
| Space | play/pause (not when a control is focused) |
| ← / → | −/+ 10 s |
| J / L | −/+ 10 s (aliases) |
| ↑ / ↓ | volume ± 10 % |
| M | mute toggle |
| PageUp / PageDown | previous / next chapter |
| T | toggle transcript |
| C | toggle chapters |
| ? | shortcuts help (dialog, focus trapped, Esc closes) |

---

## 6. Ergonomics — new interactions

1. **Scrubber with chapter ticks** — tick marks from chapters JSON; hover
   tooltip with target time (pointer-fine only).
2. **Back/forward buttons** — always visible (seekSeconds config).
3. **Chapter prev/next** — when chapters exist.
4. **Speed cycle** — 0.75 / 1 / 1.25 / 1.5 / 2; persisted per episode in
   sessionStorage; synced to MediaSession `playbackRate`.
5. **Transcript follows playback** — active cue highlighted + autoscroll
   (toggleable `data-follow`), speaker names styled, click = seek + play.
6. **Active player indicator** — `data-active` card ring + `aria-current`.
7. **Time display** — current / total, remaining shown on hover (desktop).
8. **Resume chip** — if saved position > 15 s, show "Reprendre à 12:34" chip
   next to play (P2, config `resumeChip: true`).
9. **Volume** — inline range + mute; persisted in localStorage.
10. **Mini-player** — opt-in sticky bar (P2).

---

## 7. Backwards compatibility & config

- All existing keys keep their meaning (`showCover`, `showChapters`,
  `showTranscript`, `showDownload`, `downloadLabel`, …, `seekSeconds`,
  `volumeStep`, `ts2m4aCdn`, `coverPattern`, `chapterLabel`,
  `transcriptLabel`, `prevLabel/nextLabel/prevTitle/nextTitle`, `artist`,
  `album`, `errorLabel`, `retryLabel`, `transcriptError`).
- New keys (all optional):

```js
podcastPlayer: {
  // v2 UI
  showTime:         true,
  showSpeed:        true,
  showVolume:       true,
  showChapterNav:   true,        // chapter prev/next buttons
  backForward:      10,          // seconds (defaults to seekSeconds)
  speedOptions:     [0.75, 1, 1.25, 1.5, 2],
  miniPlayer:       false,
  transcriptFollow: true,
  helpDialog:       true,        // '?' shortcuts dialog
  resumeChip:       false,       // P2
  print:            'hide',      // 'hide' | 'keep-title' | 'keep'
  // i18n (FR default, EN available)
  labels: { play:'Écouter', pause:'Pause', back:'Reculer de {s} s', … },
}
```

- `data-*` attributes unchanged: `data-cover`, `data-chapters`,
  `data-download`, `data-title`, `data-original-src` (internal).
- Version bump **1.3.0**; ts2m4a untouched (still 1.0.7).
- Deployment: push player → CDN → `docsh vendor` refreshes sn + course
  (no markup change on either site).

---

## 8. Implementation plan (phases)

| Phase | Scope | Risk | Tests |
|-------|-------|------|-------|
| **0 — Foundation** | Tokens, dark/forced-colors/reduced-motion, focus rings, Space-bug fix, live region + role=alert, aria-labels on toolbar glyphs, touch targets, print rule | low | existing 46 stay green + new: tokens present, space-on-button no-op, live announcements captured |
| **1 — Custom controls** | Replace native UI: play/back/fwd/time/scrubber/volume/speed; hide native under `[data-enhanced]`; scrubber a11y; time display; fallback on throw | medium | jsdom: roles, aria-valuetext updates, keyboard seek, volume range, speed cycle + persistence |
| **2 — Panels** | Chapters a11y (`aria-current`, buttons, scroll-into-view), transcript a11y (aria-controls, follow, speakers), chapter prev/next buttons, active-player indicator | medium | jsdom: current chapter flips, autoscroll calls, focus management |
| **3 — Responsive + mini-player** | 3-tier CSS, 44 px targets, optional sticky mini-player (IntersectionObserver), print | medium | jsdom: tier classes on resize mock, mini-player toggle |
| **4 — Polish + docs** | Shortcuts help dialog, resume chip (P2), README redesign section, demo update, a11y statement, changelog | low | full suite + manual checklist |

**Rollout**: 1.3.0 → CDN → sn/course `docsh vendor` → verify deployed pages
(sn + course remote-repo pages + download route unchanged).

**Manual QA matrix** (documented in README): VoiceOver (macOS/iOS) smoke,
keyboard-only pass, 200 % zoom, forced-colors, reduced-motion, iPhone SE /
desktop widths, dark theme site (sn uses dark-ish theme).

---

## 9. Open questions (for approval)

1. **Native controls**: hide them entirely under custom UI (recommended) or
   keep both? — Recommend hide (A1).
2. **Speed set**: `[0.75, 1, 1.25, 1.5, 2]` OK?
3. **Labels language**: French-first (site is FR) with English fallback —
   OK? (Today's labels are FR.)
4. **Mini-player**: opt-in default (recommended) or on by default?
5. **Resume chip** (P2) and **transcript search** (P2) — include now or defer?
6. **Breakpoints** 560/900 px — fine with the docsify content width?

---

## 10. References

- WCAG 2.2 — https://www.w3.org/TR/WCAG22/ (2.1.1 Keyboard, 2.4.7 Focus
  Visible, 2.5.5 Target Size, 2.5.8 Target Size Minimum, 1.4.3 Contrast,
  2.3.3 Animation from Interactions, 1.4.4 Resize Text, 2.4.11 Focus Not
  Obscured)
- ARIA APG media player pattern — https://www.w3.org/WAI/ARIA/apg/patterns/media-player/
- MDN `<audio>`/Media Session (already wired) — see research in balado README
