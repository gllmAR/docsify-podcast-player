# Recherche & audit — Media Session API

Date : 2026-08 · Player 1.6.15 · Recherche web indisponible (pas de clé API) —
audit fondé sur la spec Media Session (MDN / W3C), stable et documentée.

---

## 1. Surface de l'API (référence)

| Fonction | Rôle |
|---|---|
| `navigator.mediaSession.metadata` | `MediaMetadata` affiché par l'OS (écran de verrou, notification, clés média) |
| `MediaMetadata` | `title`, `artist`, `album`, `artwork[]` (`{src, sizes, type}`), `chapterInfo[]` (`{title, startTime, artwork}`) |
| `navigator.mediaSession.playbackState` | `'none' \| 'paused' \| 'playing'` — état visible par l'OS |
| `navigator.mediaSession.setPositionState({duration, playbackRate, position})` | barre de progression système (jette `TypeError` si invalide) |
| `navigator.mediaSession.setActionHandler(action, fn)` | enregistre un handler ; `null` le retire. Actions média : `play`, `pause`, `stop` (déprécié), `seekbackward`, `seekforward`, `seekto`, `previoustrack`, `nexttrack`, `skipad` ; actions hors média (camera/mic/appels) ignorées |
| `details` du handler | `{action, seekTime, seekOffset, fastSeek}` — `seekbackward/forward` portent `seekOffset` ; `seekto` porte `seekTime` |

## 2. Ce que le player supporte (état après 1.6.15)

| Fonction | Support | Où |
|---|---|---|
| `metadata` (title/artist/album/artwork) | ✅ | au play, au chargement des chapitres, au changement de chapitre, au chargement de la cover, à `adoptGlobalSource` (unifié) |
| `artwork` avec MIME + taille réelle | ✅ | sniffé depuis l'extension + `naturalWidth×Height` au load |
| `chapterInfo` (+ artwork par chapitre) | ✅ | au chargement des chapitres |
| `playbackState` | ✅ non-unifié + **✅ unifié (1.6.15)** : posé par les listeners de la barre persistante (`play`/`pause`/`ended`) |
| `setPositionState` | ✅ non-unifié + **✅ unifié (1.6.15)** : `timeupdate`/`durationchange`/`ratechange`/`seeked` de la barre |
| `play` / `pause` | ✅ | pilote `activeAudio` ou, **en unifié sans lecteur plein (1.6.15)**, l'audio global via `currentMedia()` |
| `stop` | ✅ | pause + retour à 0 (comportement déprécié conservé) |
| `seekbackward` / `seekforward` | ✅ | **chapitre-aware** : saut au début du chapitre précédent/suivant ; sans chapitres, ±`seekSeconds` ; **`details.seekOffset` de l'OS respecté (1.6.15)** en l'absence de chapitres / au-delà du dernier |
| `seekto` | ✅ | `details.seekTime` |
| `nexttrack` / `previoustrack` | ✅ | navigation via les liens de pagination docsify (sessionStorage `podcast-autoplay`) |
| `skipad` | — | hors scope (pas de publicité) — volontairement non enregistré |

## 3. Correctifs livrés en 1.6.15

1. **Mode unifié sans lecteur plein** (surface + barre) : les handlers OS
   ne voyaient pas l'audio global (`activeAudio` nul après une pause) —
   `currentMedia()` retombe sur `gAudio` dès qu'une source est chargée.
2. **`playbackState`/`setPositionState` jamais posés depuis la barre** :
   l'OS n'affichait ni état ni progression en flux surface→barre — ajoutés
   aux listeners `play`/`pause`/`ended`/`timeupdate`/`durationchange`.
3. **`details.seekOffset` ignoré** : les boutons hardware (verrou Android,
   claviers média) envoient leur propre offset (souvent 30 s) — maintenant
   respecté quand le skip chapitre ne s'applique pas.

## 4. Matrice de tests (tous verts, jsdom)

| Test | Résultat attendu | ✅ |
|---|---|---|
| handlers `nexttrack`/`previoustrack` → pagination | hash `#/…/next` / `#/…/prev` | ✅ |
| `metadata` posée au play | title = titre de l'épisode | ✅ |
| `artwork` MIME + sizes | `image/png`, `any` ou dimensions réelles | ✅ |
| `chapterInfo` + artwork par chapitre | title/startTime/img mappés | ✅ |
| `setPositionState` (non-unifié) | duration/position reflétés au timeupdate | ✅ |
| `playbackState` (non-unifié) | playing → paused → paused (ended) | ✅ |
| handlers `play`/`pause`/`stop` (non-unifié) | play→1, pause→1, stop→pause+rewind | ✅ |
| `seekforward`/`seekbackward` sans chapitres | ±10 s (seekSeconds), clamp à 0 | ✅ |
| `seekforward`/`seekbackward` avec `seekOffset` | +30 / −15 (offset OS prioritaire) | ✅ |
| `seekto` | seek à `seekTime` | ✅ |
| seek avec chapitres | arrière→début chapitre, avant→début suivant, premier chapitre→0, dernier→+offset | ✅ |
| **unifié** : handlers OS pilotent l'audio global | play/pause/stop/seekto sur `gAudio` (activeAudio nul) | ✅ |
| **unifié** : playbackState + positionState depuis la barre | playing/paused, duration/position posés | ✅ |

Total : 115 tests (4 nouveaux en 1.6.15).

## 5. Décisions

- **Skip chapitre-aware** conservé pour `seekbackward/forward` quand des
  chapitres existent (choix produit podcast) ; l'offset OS ne s'applique
  qu'en l'absence de chapitres ou au-delà du dernier.
- `stop` conservé (déprécié mais inoffensif, attendu par certains OS).
- Pas de `skipad`, pas d'actions hors média (camera/mic/hangup) — sans objet.
- `fastSeek` de `seekto` ignoré (pas de rendu vidéo à sauter).
