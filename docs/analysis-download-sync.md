# Analyse — cover art, MediaSession et sous-titres du fichier téléchargé

Date : 2026-08 · Version analysée : player 1.6.10 / ts2m4a 1.0.8

---

## 1. Couverture du cover art — où l'image doit apparaître

| Emplacement | Source | Avant 1.6.10 | Après |
|---|---|---|---|
| Carte du player (`.pp-main`) | `data-cover` ou `<stem>-cover.png` (pattern) | ✅ | ✅ (erreur → image retirée + `_coverUrl` vidé) |
| Surface compacte (mode unifié) | idem (par épisode de page) | ✅ | ✅ |
| Barre globale (mini-player) | `gAudio._coverUrl` (feed) | ⚠️ erreur 404 → icône cassée | ✅ erreur → image masquée |
| MediaSession `artwork` | `_coverUrl` + taille réelle au load | ⚠️ gardait l'URL même si 404 | ✅ 404 → artwork retiré |
| MediaSession `chapterInfo[].artwork` | `ch.img` par chapitre | ✅ | ✅ |
| **Fichier M4A téléchargé** | `fetchMetadata` : `README.md` + `-cover.png` | ⚠️ `.png` codé en dur ; rien si pas de README | ✅ jpg en fallback + **override par le plugin** (cover réelle de la page, n'importe quel format) |

### Correctifs 1.6.10
- `remuxAndDownload` passe désormais au muxeur : `title` (titre affiché), `artist`/`album` (config), `trackNumber` (`data-episode`), `date` (`data-date`), et la **cover réelle** (`el._coverUrl`, fetchée en `Uint8Array`) — y compris `data-cover` ou un `.jpg`/`.webp`. Le M4A ne dépend plus de la présence d'un `README.md` ni d'un fichier `-cover.png`.
- `tsToM4a` fusionne `opts.metadata` **par-dessus** `fetchMetadata` (les valeurs connues de la page gagnent).
- `fetchMetadata` essaie `-cover.png` puis `-cover.jpg` (côté SW, sans connaissance de la page).
- Barre globale : `error` → cover masquée (pas d'icône cassée).
- `addCover` : `error` → `_coverUrl` vidé + MediaSession rafraîchi (pas d'artwork pointant vers une image morte).

## 2. MediaSession — état des lieux

| Donnée | Déclencheur | État |
|---|---|---|
| `metadata` (title/artist/album/artwork) | play, load chapitres, changement de chapitre, load cover, `globalLoad` (unifié) | ✅ |
| `chapterInfo` (title/startTime/img) | load chapitres | ✅ |
| `positionState` | timeupdate, play, ratechange, seek | ✅ |
| `playbackState` | play/pause/ended | ✅ |
| Handlers (play/pause/stop/next/prev/seek) | init | ✅ |

Correctif : artwork nettoyé quand la cover 404 (voir §1).

## 3. Sous-titres post-download — analyse de synchronisation

### 3.1 Constat (bug, corrigé en 1.0.8)

Le muxeur (`ts2m4a.js`) convertissait chaque cue VTT en échantillon
`{ text, durationMs }` **sans conserver son timestamp de début**. La piste
tx3g était construite par **accumulation des durées** (stts), donc :

```
VTT source :  cue A 00:00:05 → 00:00:08   cue B 00:02:00 → 00:02:03
Piste muxée : cue A @ 0 s          cue B @ 3 s        ← 2 min de dérive !
```

Conséquences :
- le premier cue apparaissait à 0 s au lieu de son vrai début (intro/ambiance) ;
- **tout silence ou écart entre deux cues accumulait la dérive** sur la suite ;
- la piste chapitres avait le même défaut (chapitres non contigus ou début > 0).

Les tests ffprobe existants validaient la *structure* (streams/chapitres
présents) mais pas le *timing* — d'où le passage à travers.

### 3.2 Correctif — ligne du temps fidèle

`textTrackSpecs` produit maintenant une **ligne du temps avec échantillons
vides** (blank) :

- tri par `startMs` ;
- blank de 0 → premier début (silence initial) ;
- blank entre la fin d'un cue et le début du suivant (**les gaps sont
  conservés**) ;
- clamp à la durée du film ; cues au-delà ignorés.

Chaque cue joue donc **exactement à son timestamp VTT d'origine**, sur un
fichier dont l'audio provient du même `.m3u8` que le lecteur → **le
sous-titre reste synchrone avec l'audio**, y compris après seek.

### 3.3 Vérification automatisée

Nouveau test : mux de cues à 0.5 s et 3.0 s + chapitres à 0.5 s/2.5 s, puis
`ffprobe -show_entries packet=pts_time` sur la piste sous-titres :
`blank@0, cue@0.5, blank@2.5, cue@3.0, blank@5.0` — les pts correspondent
aux timestamps d'origine (tolérance 50 ms), et `Intro` démarre à 0.5 s.

### 3.4 Ce qui reste hors champ

- Le player **web** (suivi transcript / cues) se synchronise sur le
  `timeupdate` de l'audio — pas de changement.
- La version audio du téléchargement = même m3u8 que la lecture → même
  chronologie. Si un site servait un m3u8 différent au download, il faudrait
  re-caler les cues — hors cas d'usage (même `{stem}.m3u8`).

## 4. Diffusion

- ts2m4a 1.0.8 publié sur la CDN ; `sn/sw.js` pointe `?v=1.0.8` (le SW
  récupère le muxeur corrigé au prochain install/update).
- Player 1.6.10 : les téléchargements côté page (chemin direct sans SW)
  embarquent tags + cover réelle dès la publication.
