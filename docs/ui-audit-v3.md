# Audit d'interface — où placer les éléments (référence : lecteurs professionnels)

> **✅ Livré en 1.6.7** — layout v3 implémenté (deux rangées, play dominant,
> temps aux extrémités, groupes, help hors barre). Décisions prises à
> l'implémentation :
> - **Help** : bouton `?` dans le toolbar (à côté du download, aligné à
>   droite), plus jamais dans la barre de transport ; raccourci `?` intact.
> - **Download** : déplacé du `.pp-controls` vers le toolbar (près du titre).
> - **Resume chip** : conservé dans le groupe nav juste après play (la
>   rangée transport reste stable ; le déplacer dans `.pp-meta` reste
>   possible, conteneur déjà prêt).
> - **`.pp-controls`** : conservé comme wrapper colonne (`.pp-progress` +
>   `.pp-transport`) — des tests ciblent `.pp-controls`, rétrocompat v1.
> - **`.pp-help`** : la classe reste sur le bouton ; le dialogue est passé
>   en `.pp-help-box` (le partage de classe bouton/dialogue était un bug CSS).
> - **Cover ≥ 900 px** : 150 px.
> - Le « restant au survol » se fait désormais au survol du temps total.

Version analysée : player v2 (1.5.0) · Date : 2026-08 · Site : sn

---

## 1. Layout actuel (v2)

```
.pp-card
├── .pp-main
│   ├── .podcast-player-cover (120 px, art épisode)
│   └── .pp-meta  → .pp-title + .pp-now (chapitre courant)
├── .pp-controls  ← UNE seule rangée, tout dedans, dans cet ordre :
│     [play] [resume chip] [back] [forward] [chapPrev] [chapNext]
│     [12:34 / 45:00] [scrubber+ticks] [speed] [mute+vol] [help]
└── .pp-panels (chapitres | transcript)
(.pp-toolbar au-dessus : download, et prev/next si playlist > 1)
```

**Constats** : la barre mélange transport, progression, temps et réglages
dans une seule rangée ; le temps est inline à côté du scrubber ; le help
est dans la barre principale ; le play n'est pas visuellement dominant.

## 2. Ce que font les lecteurs professionnels

### Spotify (vue podcast)
```
[grand artwork]  [titre épisode / show]              [download, partage…]
[ 12:34  ═══════════════════════ 45:00 ]
[   ↺15   ▶ (gros, rond)   ↻15   ]        [vitesse · file · appareils]
[chapitres]
```
- Progression **pleine largeur, rangée propre**, temps aux extrémités.
- Transport **groupé et centré** (back/play/forward) ; play en évidence.
- Réglages secondaires **à droite** ; chapitres sous le player.
- Actions (download) **près du titre**, pas dans le transport.

### Apple Podcasts
```
[artwork]  [titre / épisode]            [download]
[ 12:34  ═══════════════════ 45:00 ]
[ ↺15  ▶  ↻15 ]   [vitesse · minuterie · partage]
[chapitres]
```
- Même squelette : header (artwork + titre + download), progression pleine
  largeur, transport centré, secondaires à droite.

### YouTube (player standard)
- Barre de progression **fine en haut** du player, pleine largeur.
- Rangée : play centré, next/prev à côté, **volume et réglages à droite**,
  titre au-dessus.

### Pocket Casts / Overcast (podcasts, compacts)
- Carte : cover petite à gauche, titre dessous, scrubber pleine largeur,
  rangée `back 30 / play / fwd 30 / volume / vitesse / minuterie`.

### Patterns communs (synthèse)
| Pattern | Consensus pro | v2 actuel |
|---|---|---|
| Progression | Rangée **propre, pleine largeur** ; `current` à gauche, `total` à droite | ❌ inline au milieu des boutons, temps accolé |
| Transport | `back / play / forward` **groupés**, play plus grand/accentué | ⚠️ groupés mais même taille, pas dominant |
| Secondaires | `vitesse, volume` **aux extrémités** (droite) | ⚠️ à droite mais mêlés au reste |
| Nav chapitres | Dans le transport (Apple) ou dans la liste (Spotify) | ⚠️ entre transport et temps — à regrouper |
| Aide / réglages | **Jamais dans la barre principale** (menu overflow, `?`) | ❌ bouton `?` dans la barre |
| Download | Près du **titre** (header), jamais dans le transport | ✅ déjà dans le toolbar |
| Reprise | Callout près du play | ✅ chip près du play |
| Cover | À gauche, en tête ; compacte sur mobile | ✅ |

## 3. Layout cible v3

```
.pp-card
├── .pp-main
│   ├── .podcast-player-cover (120 → 160 px ≥900)
│   └── .pp-meta  → .pp-title + .pp-now
│       (resume chip : callout sous le titre — visible, hors du flux)
├── .pp-progress            ← nouvelle rangée
│   ├── .pp-time-current (12:34)
│   ├── .pp-scrubber-wrap (scrubber + ticks + tooltip)
│   └── .pp-time-total (45:00)      ← remplace « 12:34 / 45:00 »
├── .pp-transport           ← nouvelle rangée
│   ├── [back] [play ● gros] [forward]
│   ├── [chapPrev] [chapNext]      (si chapitres — groupe nav)
│   ├── spacer (flex:1)
│   └── [speed] [mute] [volume]    (groupe réglages, droite)
└── .pp-panels (chapitres | transcript)
```

Règles :
1. **Deux rangées au lieu d'une** : progression (temps + barre) puis
   transport (boutons). C'est le squelette Spotify/Apple.
2. **Play dominant** : 44–48 px, cercle accent (déjà rond — agrandir le
   contraste de taille vs les autres boutons 40 px).
3. **Groupes** : transport `back/play/forward`, nav chapitres à part, puis
   réglages alignés à droite (speed + volume) — espacement `gap` entre
   groupes (marge 0.5–1 em), pas d'intercalation.
4. **Temps aux extrémités** de la barre : `12:34` à gauche, `45:00` à
   droite (le « restant au survol » reste sur la barre). Le `<time
   datetime>` est conservé sur l'élément courant.
5. **Help retiré de la barre** : accessible via `?` (déjà câblé) et
   `aria-keyshortcuts` ; optionnel : petite icône `?` dans le toolbar à
   côté du download.
6. **Resume chip** : sous le titre dans `.pp-meta` (callout contextuel),
   ou conservé dans le transport juste après play — à trancher à
   l'implémentation (le chip actuel dans la rangée fonctionne ; le
   déplacer dans `.pp-meta` le rend visible sans décaler le transport).
7. **Tiers responsive** :
   - `< 560 px` : `.pp-progress` pleine largeur en premier, `.pp-transport`
     passe en 2 rangées si besoin (wrap), boutons ≥ 44 px, cover 88 px,
     volume compact (56 px).
   - `≥ 560 px` : deux rangées, cover 120 px.
   - `≥ 900 px` : cover 140–160 px ; chapitres/transcript en 2 colonnes
     (déjà le cas) ; volume pleine largeur (70 px).
8. **A11y** : l'ordre DOM = ordre visuel = ordre de tabulation ;
   `aria-keyshortcuts` inchangé ; les groupes n'ont pas besoin de
   `role=group` (des boutons contigus), mais on garde les `aria-label`
   existants. Le `hidden` du résumé reste `aria-live` via le chip.
9. **Rétrocompat** : classes v1 conservées (`.podcast-player-time`,
   `.pp-scrubber`, `.pp-btn-play`, `.pp-speed`…) — les tests existants ne
   changent pas ; `.pp-controls` disparaît au profit de `.pp-progress` +
   `.pp-transport` (aucun test ne cible `.pp-controls`).

## 4. Plan d'implémentation (v3 layout)

| Étape | Contenu | Risque |
|---|---|---|
| 1 | Restructurer `buildControls` : créer `.pp-progress` (time + scrubber + time-total) et `.pp-transport` (groupes) ; déplacer help hors barre | moyen — ordre DOM changé, tests à re-vérifier |
| 2 | CSS : deux rangées, groupes espacés, play dominant, temps aux extrémités ; adapter les tiers 560/900 | moyen — le CSS v2 actuel (ordres flex) est remplacé |
| 3 | Resume chip dans `.pp-meta` (callout) — décision UI | faible |
| 4 | Toolbar : ajouter `?` (aide) optionnel à côté du download | faible |
| 5 | Tests : ordre DOM (progress avant transport), présence des groupes, temps aux extrémités ; garder les 52 existants verts | faible |
| 6 | Bump 1.6.0 + QA manuelle (iPhone SE, desktop, zoom 200 %) | — |

## 5. Points d'attention

- **Ne pas casser** : `.pp-time` (le `<time datetime>`), `aria-valuetext`
  du scrubber, `aria-keyshortcuts`, le focus-trap du dialogue, les tests
  jsdom.
- **Le chip de reprise** : s'il passe dans `.pp-meta`, le champ
  `settings.resumeChip` reste identique (juste le conteneur change).
- **Mini-player** : inchangé (pattern Spotify bottom-bar déjà respecté).
- **Per-chapter art** : le swap de cover (l. 463) reste compatible avec le
  nouveau `.pp-main` (c'est l'`img.cover` qui est swapée).
