# Analyse d'usage — le lecteur de podcast vs l'écosystème

Note : recherche web indisponible (pas de clé API) — analyse fondée sur les
fonctionnalités publiques documentées des lecteurs majeurs (Spotify, Apple
Podcasts, Pocket Casts, YouTube, AntennaPod, Overcast) + l'état de notre
player (1.6.5).

---

## 1. Panorama des lecteurs similaires

| Lecteur | Type | Fonctionnalités qui font référence |
|---|---|---|
| **Spotify Web** | streaming + podcasts | mini-player global, queue/Up Next, vitesse 0.5–3.5×, chapitres (liste + artwork), reprise multi-appareils, recommandations |
| **Apple Podcasts Web** | podcasts | chapitres, vitesse, sleep timer, « up next », transcript synchro (iOS), partage à timestamp, sync iCloud |
| **Pocket Casts Web** | podcasts | chapitres, vitesse, sleep timer, skip 30 s, queue + filtres, transcripts (partiels), sync de compte |
| **YouTube (Web)** | vidéo/podcast | mini-player, queue, vitesse, chapitres cliquables sur la barre, transcript auto, raccourcis j/k/l |
| **AntennaPod** | mobile (Android) | chapitres, vitesse + pitch, sleep timer, queue, **bookmarks**, skip, OPML |
| **Overcast** | mobile (iOS) | **Smart Speed** (saute les silences), Voice Boost, chapitres, vitesse, sleep timer, **clips partageables** |
| **Embeds (Buzzsprout/Castos)** | widget épisode | lecteur simple, chapitres, partage |
| **Plyr / MediaElement.js** | libs | contrôles custom a11y, fullscreen, captions |
| **docsify audio** | docsify | plugins audio basiques (sans le niveau podcast) |

## 2. Comment ils fonctionnent — les patterns qui comptent

1. **Transport** — play central ; back/forward **15–30 s** (Apple 15, Pocket
   Casts 30) ; vitesse variable (jusqu'à 3.5×) ; **sleep timer** présent
   partout (15/30/60 min ou fin d'épisode).
2. **Progression** — barre pleine largeur, temps aux extrémités, **chapitres
   cliquables sur la barre** (segments), preview au survol (artwork).
3. **Mini-player / barre persistante** — cover + titre + play + progress ;
   clic → « now playing » complet. C'est exactement notre barre unifiée.
4. **Queue / Up Next** — file manuelle (« jouer ensuite »), auto-advance à
   la fin ; les apps podcasts proposent toujours le prochain épisode.
5. **Transcript synchro** — cue actif, clic = seek+play, recherche ;
   Apple/YouTube le font ; nous l'avons (suivi, recherche, voix stylées).
6. **Reprise** — position mémorisée et **synchro multi-appareils** (compte) ;
   notre localStorage est la version « sans compte ».
7. **Bookmarks / clips** — marquer un moment, partager un lien **avec
   timestamp** (Apple, Overcast, YouTube `?t=`) — standard.
8. **Partage** — lien horodaté + citation ; essentiel pour un cours.
9. **Fin d'épisode** — « Suivant : X » + auto-advance (Spotify enchaîne,
   Pocket Casts propose, jamais d'arrêt sec).
10. **A11y** — clavier (espace, j/k/l), focus, contrastes ; nous sommes
    déjà au niveau (WCAG 2.2, raccourcis).

## 3. Gap analysis — notre player (1.6.5) vs ces patterns

### Déjà au niveau (ou meilleur)
- Barre persistante unifiée (mini-player pattern) ✓
- Vitesse par épisode, reprise inter-visites ✓
- Chapitres (liste, aria-current, ticks, scroll) + transcript complet
  (suivi, recherche, voix, suspension au scroll manuel) ✓
- Feed catalogue + prev/next dans la barre ✓
- MediaSession (écran verrouillé + chapitres) ✓
- A11y WCAG 2.2, raccourcis, live regions ✓
- Download SW (les apps web n'ont même pas ça) ✓

### Manques (gaps) — par ordre d'impact pour un cours

| # | Gap | Standard chez | Effort | Impact cours |
|---|---|---|---|---|
| G1 | **`autoAdvance`** (fin → épisode suivant, URL change) | tous | moyen | **élevé** (backlog déjà demandé) |
| G2 | **Partage avec timestamp** (`?t=12:34` → seek) | Apple, YouTube, Overcast | petit | **élevé** (référencer un moment d'un épisode) |
| G3 | **Sleep timer** (15/30/60/fin) | tous les apps podcast | petit | moyen |
| G4 | **Chapitres cliquables sur la barre** (segments) | Spotify, YouTube | moyen | moyen |
| G5 | **Bandeau fin d'épisode** (« Suivant : X ») | Pocket Casts | petit | moyen |
| G6 | **Bookmarks** (marqueurs localStorage) | AntennaPod | moyen | moyen |
| G7 | **Queue / « jouer ensuite »** | Spotify, Apple | moyen | faible-moyen |
| G8 | **Copier le transcript** | — | petit | moyen (backlog) |
| G9 | **Sauter l'intro** (chapitre 0) | Pocket Casts | petit | moyen (générique balado) |
| G10 | Sync multi-appareils | compte requis | — | **hors scope** (site statique) |
| G11 | Smart Speed (silences) | Overcast | — | hors scope (analyse audio) |
| G12 | Scrub preview artwork | Spotify | moyen | faible |

## 4. Recommandations priorisées

### P1 — ✅ livré (1.6.6)
1. **`autoAdvance`** — à `ended` : annonce live « Prochain épisode : X »,
   chargement du suivant (feed), tentative de play, navigation vers sa
   page (hash docsify). Config `autoAdvance` (défaut on en unifié).
2. **Partage horodaté** — `?t=MM:SS` (ou secondes) seek au chargement
   (`&autoplay=1` tente la lecture) ; bouton partage dans la barre qui
   copie le lien horodaté de l'épisode joué.

### Ergonomie — ✅ livré (1.6.7)
- **Layout v3** (`docs/ui-audit-v3.md`) : deux rangées — progression pleine
  largeur avec temps aux extrémités, transport groupé (back/play/forward ·
  nav chapitres · réglages à droite), play dominant 48 px, help déplacé
  dans le toolbar, download près du titre.

### P2
3. **Sleep timer** (G3) — cycle 15/30/60/fin d'épisode, bouton dans la
   barre (menu), annonce live, persistance de session.
4. ~~**Chapitres cliquables sur la barre** (G4)~~ — ✅ livré 1.6.8 : zones
   cliquables sur le scrubber aux positions des chapitres (pointer:fine ;
   clavier via la liste existante), titre en `title`, marqueur du chapitre
   courant accentué.
5. **Bandeau fin d'épisode** (G5) — « Suivant : {titre} » + bouton play ;
   complète l'autoAdvance.
6. ~~**Bookmarks** (G6)~~ — ✅ livré 1.6.8 : bouton « marquer » (toggle
   ±3 s, `aria-pressed`) + panneau « Signets » par épisode (localStorage),
   aller à / supprimer.
7. **Copier le transcript** (G8) + **sauter l'intro** (G9, config
   `skipIntroSeconds` ou chapitre 0).

### P3 / écartés
- Queue manuelle (G7) — le prev/next feed + autoAdvance couvrent l'essentiel.
- Sync multi-appareils (G10), Smart Speed (G11) — hors scope statique.
- Scrub preview artwork (G12) — le tooltip temps existe déjà.

## 5. Ce qui nous rend déjà différent (à préserver)

- **Download réel** (SW ts2m4a) — aucun lecteur web ne le fait nativement.
- **Transcript + voix stylées + suivi** — niveau Apple Podcasts, avec le
  comportement « suspension au scroll manuel » qu'aucun n'a.
- **Intégration docsh/OKF** — le lecteur est une pièce d'un système où le
  frontmatter génère le feed, les chapitres, les transcripts et les
  références ; les apps web sont des silos.
- **Zéro dépendance, CDN, a11y WCAG 2.2** — prêt pour le cours (et le
  gabarit `docsify-gabarit-cours` peut réutiliser la même config).

## 6. Verdict d'usage

Pour un **podcast de cours** (écoute linéaire, chapitrage, transcript de
référence, téléchargement), notre player est déjà au niveau des apps
grand public sur le cœur (lecture persistante, chapitres, transcript,
reprise). Les trois améliorations qui le rendraient **meilleur qu'elles
pour ce cas d'usage** : **autoAdvance** (G1), **partage horodaté** (G2) et
**bookmarks** (G6) — exactement les besoins d'un auditeur-étudiant qui
veut citer un passage.
