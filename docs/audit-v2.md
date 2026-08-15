# Audit — lecteur d'épisode docsify-podcast-player v2 (1.4.0)

Date : 2026-08 · Contexte : site sn (`tim-montmorency.codeberg.page/sn/`) déployé
avec le player 1.4.0 en CDN, 30 épisodes (s01–s02), pipeline CDN-only.

---

## 1. État des lieux vérifié (production)

| Élément | État |
|---|---|
| Player servi | `https://gllmar.github.io/docsify-podcast-player/…` (1.4.0) ✓ |
| `sw.js` | 200, 2273 B, `text/javascript`, généré par CI ✓ |
| Références `vendor/` | 0 — site 100 % CDN ✓ |
| Assets épisodes (30) | m3u8 + json + vtt + cover présents partout ✓ |
| Chapters JSON | Format Podcast Index v1.2.0 wrapé ✓ (7 chapitres sur l'ép. 01) |
| VTT | WebVTT standard, voix `<v Hôte>` préservées ✓ |
| m3u8 | Segments relatifs `hls/segment-*.ts` ✓ (même origine) |
| Fix des chemins relatifs | `fixPaths` résout `<audio>/<track>` contre la route ✓ (tests) |

**Constat central** : le socle est sain et conforme au design doc. Le travail
restant est concentré sur (a) des promesses du design non tenues, (b) des
fonctionnalités codées mais **dormantes faute de données**, (c) des manques
UX propres au cas « cours » (écoute longue, reprise, chapitrage fin).

---

## 2. Écarts design-doc → implémentation

| # | Item (design-v2.md) | État | Détail |
|---|---|---|---|
| D1 | Tooltip du scrubber (§6.1 : « hover tooltip with target time, pointer-fine only ») | **Manquant** | 0 occurrence de tooltip dans le code. Le tick est là, pas le survol. |
| D2 | Chapitre actif « scrolled into view » (table §5 + Phase 2) | **Manquant** | `highlight()` pose `aria-current` mais ne scrolle pas la liste ; seul le transcript scrolle (l. 619). |
| D3 | « Speaker names styled » (transcript) | **Partiel** | La voix `<v Hôte>` est conservée dans le texte (l. 594) mais pas extraite en élément stylé `.speaker`. |
| D4 | Vitesse « persisted per episode » (§6.4) | **Divergence** | Clé globale `podcast-speed` (sessionStorage), pas par épisode. |
| D5 | QA manuelle (VoiceOver, zoom 200 %, forced-colors…) | **Non documentée** | README ne contient pas la matrice QA prévue en Phase 4. |

## 3. Fonctionnalités codées mais dormantes (données manquantes)

| # | Fonction | Code | Cause dormance |
|---|---|---|---|
| F1 | **Art par chapitre** (couverture swap l. 463 + `chapterInfo` img) | prêt | Les JSON balado n'émettent **aucun champ `img`** par chapitre → le player utilise toujours la couverture d'épisode. |
| F2 | **Mini-player** (IntersectionObserver, barre sticky) | prêt, opt-in | `miniPlayer: false` par défaut ; le site sn n'a **aucun bloc `podcastPlayer`** dans index.html → aucun réglage site. |
| F3 | **Personnalisation MediaSession** | prêt | `artist`/`album` = « Podcast » par défaut ; rien de configuré côté sn (devrait être « Souveraineté numérique » / titre d'épisode). |

## 4. Lacunes fonctionnelles identifiées (code)

| # | Problème | Impact | Sévérité |
|---|---|---|---|
| B1 | **Reprise impossible d'une visite à l'autre** : `savePosition` écrit en `sessionStorage` (l. 1584) — détruit à la fermeture de l'onglet. La reprise ne survit qu'à la navigation SPA. | L'auditeur qui ferme l'onglet perd sa position ; le resume chip ne sert qu'à la même session. Pour un cours, la reprise inter-visites est le cas d'usage principal. | **P0** |
| B2 | **Silence si hls.js indisponible** : `Hls.isSupported()` false et navigateur ≠ Safari → `return` sans message (l. 285). Le player semble mort. | Utilisateurs Firefox/Chrome anciens ou hls.js bloqué par CSP. | P1 |
| B3 | `updatePositionState` appelé à **chaque timeupdate** (~4×/s) | Écritures MediaSession inutilement fréquentes ; batterie sur mobile. | P2 |
| B4 | Pas de **nettoyage de la position** quand l'épisode est terminé | Une reprise future (si localStorage) renverrait à la fin ; à prévoir avec B1. | P2 |
| B5 | Pas de **retry/backoff** hls.js (fatal → erreur, un seul essai) | Échec réseau transitoire = message d'erreur définitif. | P2 |
| B6 | Toolbar prev/next jamais visible (1 audio/page) | Non-bug, mais la **playlist de saison** (toutes les audios d'une page index de saison) reste un usage non exploité. | P2 (produit) |

## 5. Opportunités produit (lecteur d'épisode « cours »)

1. **Reprise inter-visites + chip** (B1/B4) : localStorage, seuil > 15 s,
   purge à la fin (ou « reprendre » désactivé si < 30 s restantes). C'est le
   gain n° 1 pour un usage pédagogique.
2. **Art par chapitre** (F1) : côté balado, émettre `img` par chapitre
   (vignette générée ? couverture dérivée ?) → le swap déjà codé s'active,
   chapitres visuellement repérés, `chapterInfo` enrichi.
3. **Config site sn** (F2/F3) : ajouter un bloc `podcastPlayer` dans
   index.html : `artist: "Souveraineté numérique"`, `album: "SN — balado"`,
   décider `miniPlayer` (utile sur mobile pendant la navigation), labels FR
   explicites. Aucune modification du player requise.
4. **Pages de saison en playlist** : les README d'index de saison
   (s01/README.md…) pourraient embarquer les 15 `<audio>` → toolbar
   prev/next + MediaSession prevtrack/nexttrack actifs, « lecture continue ».
5. **Tooltip scrubber + chapitre actif scrollé** (D1/D2) : deux petites
   additions qui complètent le design tel qu'approuvé.
6. **Transcript** : extraire et styler les voix (D3), bouton « copier le
   transcript », persister l'état follow/recherche.
7. **Vitesse par épisode** (D4) : aligner sur le design (clé par stem).
8. **Erreurs HLS** (B2/B5) : message + retry avec backoff ; fallback natif
   si possible.

## 6. Plan priorisé

### P0 — reprise inter-visites (B1/B4)
- `savePosition`/`restorePosition` → `localStorage` (clé `podcast-pos:<stem>`),
  garder sessionStorage en lecture pour compat SPA existante.
- Purge sur `ended` ; seuil de reprise : `15 s < pos < duration − 30 s`.
- Tests : sauvegarde/restauration localStorage, purge à la fin, seuils.
- Effort : petit (30–60 min + tests). Risque : faible.

### P1 — robustesse HLS + erreurs (B2/B5)
- `Hls.isSupported()` false → `showHlsError` au lieu du silence.
- Fatal error → un retry (backoff 2 s) puis erreur définitive avec bouton
  réessayer (existe déjà pour le chargement du manifest).
- Tests : jsdom simulation `Hls` absent / fatal error.
- Effort : moyen.

### P1 — données chapitres (F1)
- balado : option pour émettre `img` par chapitre dans `chapters.json`
  (v1.2.0 wrapé) ; décision produit sur la source de la vignette.
- Vérifier le swap cover (l. 463) + `chapterInfo` en prod après émission.
- Effort : balado moyen + régénération des 30 JSON.

### P2 — complétion design (D1, D2, D3, D4)
- Tooltip scrubber (pointer-fine), scroll chapitre actif, voix stylées,
  vitesse par épisode.
- Effort : 3 × petit.

### P2 — produit site sn (F2/F3, playlist saison)
- Bloc config `podcastPlayer` dans index.html (branding MediaSession,
  miniPlayer).
- Page index de saison avec playlist (15 audios) → toolbar + next/prev
  MediaSession.
- Effort : petit à moyen, zéro changement player pour la config ; moyen
  pour la playlist (tests toolbar multi-audio).

---

## 7. Ce qui est solide (ne pas casser)

- A11y v2 (WCAG 2.2 AA) : contrôles custom, focus-visible, live regions,
  dialog focus-trap, `aria-current` chapitres/transcript, Space-bug.
- Auto-dérivation cover/chapters/transcript depuis le stem (fixPaths route) —
  le site sn n'a plus besoin d'attributs `data-*`.
- SW download : registration auto version-pinnée, fallback main-thread.
- 68 tests jsdom (player) + 701 (docsh) — garder verts à chaque étape.
