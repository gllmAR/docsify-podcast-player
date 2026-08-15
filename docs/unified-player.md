# Plan — Lecteur unifié (playback persistant à travers la navigation)

Contexte : site sn (Docsify SPA, routing par hash). Aujourd'hui, naviguer
détruit le contenu de la page (`doneEach` remplace le DOM) → l'`<audio>`
de l'épisode est détruit → **la lecture s'arrête**. C'est le défaut
n° 1 de l'expérience d'écoute.

---

## 1. Cause racine (vérifiée)

- Le plugin améliore les `<audio>` **de la page** ; Docsify remplace ce
  sous-arbre à chaque navigation → l'élément média et toute son UI meurent.
- Le mini-player (`pp-mini`) est bien appendu à `document.body` et survit,
  mais il ne **possède pas** l'élément audio : il observe le wrap de la
  page → sans l'audio, plus d'événements `play`/`pause` → il disparaît.
- Le plugin n'a qu'un hook `doneEach` ; aucun hook « avant remplacement »,
  aucun rapatriement d'élément.

## 2. Objectif

Un **lecteur global unique** (pattern Spotify/Apple Music Web) :

- **Un seul élément audio** vivant hors du contenu de page (dans `body`),
  jamais détruit par la navigation.
- Une **UI persistante** (barre compacte en bas + lecteur plein dans la
  page de l'épisode en cours).
- La navigation **ne stoppe plus jamais la lecture** : on écoute l'épisode
  A, on navigue vers B → A continue ; la page de B propose « Écouter B »
  (bascule) et un bandeau « En lecture : A ».
- Toutes les fonctions existantes restent : chapitres, transcript,
  téléchargement, reprise, MediaSession, raccourcis, a11y.

## 3. Décisions (validées 2026-08)

| # | Décision | Choix validé |
|---|---|---|
| D1 | **Comportement à la navigation pendant la lecture** | ✅ **(a)** Continuer l'épisode courant ; la nouvelle page affiche « En lecture : A » + un lecteur B prêt à basculer (Spotify-like). |
| D2 | **UI persistante** | ✅ **(a)** Barre compacte en bas (cover + titre + play + progress) toujours visible pendant la lecture + lecteur plein dans la page de l'épisode joué. |
| D3 | **Portée** | ✅ **(a)** Mode `unified: true` dans docsify-podcast-player (opt-in, site sn l'active ; rétrocompat totale). |
| D4 | **Source de vérité** | ✅ Le lecteur global possède l'audio ; les surfaces de page sont des descripteurs liés au global ; play = charger + jouer. |

## 4. Architecture cible

```
document.body (persistant — jamais remplacé par docsify)
└── .pp-global
    ├── audio#pp-audio            ← l'UNIQUE élément média (hls.js attaché ici)
    ├── .pp-global-bar            ← barre compacte (fixée en bas, safe-area)
    │     [cover 40-48px] [titre + épisode] [progress fine] [play]
    └── .pp-global-panel          ← lecteur plein (même UI que v2/v3)
          [.pp-main : cover + titre + .pp-now]
          [.pp-progress : time — scrubber(ticks+tooltip) — time-total]
          [.pp-transport : back/play/forward · chapPrev/chapNext · speed/vol]
          [.pp-panels : chapitres | transcript]

Contenu de page (remplacé à chaque navigation)
└── surfaces épisode : <audio controls src="…"> améliorées en
    « contrôleurs » liés au global (play = charger + jouer ; état
    reflété : lecture en cours / pause / position ; chapitres actifs)
```

**Liaison page ↔ global** (unidirectionnelle) :
- À chaque `doneEach`, le plugin collecte les descripteurs des épisodes de
  la page (`src`, titre, cover, chapters URL, transcript URL, download).
- Si le global est **inactif** : la première surface devient la source
  par défaut (la page se comporte comme aujourd'hui).
- Si le global **joue l'épisode X** :
  - la surface X (si présente) affiche le lecteur plein lié (état live) ;
  - les autres surfaces affichent « Écouter » (clic = bascule) ;
  - un bandeau « En lecture : X → » (lien vers la page de X) est inséré
    en tête de page si X n'y est pas.

**État global conservé** : `src` + `currentTime` + `paused` +
`playbackRate` + chapitres/transcript cache + position (localStorage).

## 5. Phases d'implémentation

### Phase 0 — Design détaillé (ce doc validé + D1..D4 tranchés)
Livrable : schéma DOM final, contrat de liaison, tests cibles.

### Phase 1 — Noyau global (plugin, `unified: true`) — ✅ livré (1.6.0)
(barre compacte + surfaces + bascule + tests ; le lecteur plein dans la
page de l'épisode joué arrive en Phase 2 — les surfaces restent compactes
jusque-là)
- Création du conteneur `.pp-global` + `audio#pp-audio` à l'install
  (appendu à `body`, jamais retiré).
- `buildGlobalPlayer()` : barre compacte + panneau plein (réutilise les
  blocs v2/v3 : contrôles, scrubber, panneaux — refactorisés en fonctions
  prenant `(audio, container)` au lieu de `(el, wrap)`).
- Descripteur d'épisode : `{ src, title, cover, chaptersUrl, transcriptUrl,
  downloadUrl, stem }` extrait lors de l'enhance de page.
- HLS : `attachHls` s'applique à l'audio global (une seule fois ; retry/
  backoff 1.5.0 conservés).
- MediaSession/metadata/positionState → pilotés par le global.
- Tests jsdom : création du conteneur unique, chargement d'un descripteur,
  play/pause/seek sur l'audio global, une seule instance d'audio.

### Phase 2 — Liaison des surfaces de page — ✅ livré (1.6.1)
(lecteur plein dans la page de l'épisode joué : enhance() paramétré
`(el, index, mediaEl)` — l'UI complète se lie à l'audio global ;
`reEnhance()` fait monter la surface en lecteur plein à la bascule ;
bandeau avec lien « Aller à la page » via `gLoadedRoute` ; tests +2)

> **Évolution 1.6.12 — le déclenchement ne change plus la page.** Le clic
> play sur une surface **ne monte plus** la surface en lecteur plein : la
> page garde son interface compacte, l'interaction passe à la barre
> persistante. Le lecteur plein (panneaux chapitres/transcript/signets)
> n'apparaît que **par navigation** sur la page de l'épisode joué
> (`doneEach` → `enhance(el, i, gAudio)`), y compris via autoAdvance ou le
> lien « Aller à la page ». La synchro des surfaces est centralisée sur les
> listeners globaux (plus aucun listener par surface → pas d'accumulation).
> La barre persistante se **masque** (close) et **réapparaît** : bouton
> flottant `pp-global-reopen` (56 px, cover + play) tant qu'un épisode est
> chargé, et tout déclenchement de lecture la rouvre (`showGlobalBar()`).
- Les `<audio>` de page deviennent des contrôleurs : clic play →
  `global.load(descriptor)` + `play()` ; état du bouton synchronisé
  (`aria-label`, icône) ; time display de la page reflète le global
  (léger : si la page est l'épisode joué).
- Bandeau « En lecture : X » en tête de page (lien vers la page de X ;
  label i18n `nowPlayingEp`).
- Raccourcis clavier : globalisés (le wrap de la page délègue au global).
- Tests : deux `doneEach` simulés (navigation), bascule A→B, reprise d'état
  en revenant sur la page de A.

### Phase 3 — Cohabitation mini-player / barre globale — ✅ livré (1.6.2)
(listeners liés tracés par `bindMedia` + nettoyés au rebind (pas
d'accumulation), retour sur la page de l'épisode joué → lecteur plein,
padding body quand la barre est visible, mini-player supprimé (1.6.5)
- `unified: true` → la barre compacte `.pp-global-bar` **remplace** le
  mini-player (le `miniPlayer` existant reste pour le mode non-unifié).
- Safe-area (`env(safe-area-inset-bottom)`), `position: fixed`, pas de
  recouvrement du contenu (padding-bottom sur le main si nécessaire).

### Phase 4 — Intégration sn (site)
- Épisode READMEs : **inchangés** (`<audio controls src=…>`).
- `index.html` : `podcastPlayer: { unified: true, … }` — le bloc de config
  doit être émis par `docsh run` (l'index est régénéré en CI) : ajouter
  une option `.docsh.toml` (ex. `[site.podcast] unified = true`) ou une
  émission d'un bloc podcastPlayer configurable dans init.py.
- Vérification déployée : navigation A→B pendant la lecture (mobile +
  desktop), bandeau, bascule, reprise.

### Phase 5 — Polish + tests finaux
- QA manuelle : iPhone SE (safe-area, barre compacte), zoom 200 %,
  VoiceOver (la barre persistante doit être annoncée), forced-colors,
  reduced-motion.
- Tests de non-régression : les 52 tests mode non-unifié restent verts ;
  + ~12 tests mode unifié.
- Bump **1.6.0** (unified) ; README (nouvelle section « Unified player »).

## 6. Risques & rétrocompat

| Risque | Mitigation |
|---|---|
| Refactor des blocs UI (contrôles/panneaux) casse le mode actuel | Fonctions paramétrées `(audio, container)` ; les tests existants (52) couvrent le mode non-unifié |
| Double lecture (page + global) | Une seule source de vérité : `activeAudio === global.audio` ; les surfaces ne jouent jamais directement |
| Autoplay bloqué (clic requis) | La bascule vient toujours d'un clic utilisateur ; reprise silencieuse interdite (politique navigateur) |
| hls.js et l'audio global (hors page) | `attachHls` sur l'audio global ; segments relatifs résolus contre l'URL du m3u8 (déjà le cas) |
| Contenu de page avec plusieurs audios (playlist) | Le global charge le descripteur cliqué ; `prev/next` de la barre = historique/suivant de la page visitée |
| `data-*` attributes | Conservés : le descripteur lit `data-cover`, `data-chapters`, `data-download` s'ils existent, sinon auto-dérivation stem |

## 7. Alternatives écartées

1. **Rapatrier l'élément audio à la navigation** (MutationObserver qui
   vole l'`<audio>` avant destruction) — fragile : l'UI (chapitres,
   transcript) reste dans la page et meurt ; duplication en revenant sur
   la page ; pas de barre globale propre. Non retenu.
2. **Siège dans une iframe** — sur-ingénierie, a11y et coûts inutiles.
3. **Audio en `position: fixed` copié** — copier un élément média ne
   transfère pas la lecture (seul le déplacement de l'élément le fait).
4. **Player séparé hors docsify (site-only)** — non réutilisable, duplique
   la logique ; le plugin est le bon propriétaire (tests inclus).

## 8. Impact produit (sn)

- L'écoute devient continue : un auditeur qui consulte le transcript, la
  fiche corpus ou un autre épisode **continue d'écouter**.
- La barre compacte remplace le mini-player (actuellement désactivé sur le
  site) — cohérent avec le layout v3 (audit UI).
- La reprise inter-visites (1.5.0) reste : le global reprend la position
  sauvegardée de l'épisode chargé.

## 9. Correctif — premier appui play (1.6.11)

Race Chrome/Firefox + hls.js : le premier appui appelait `play()` avant que
hls.js (chargé en async) n'ait attaché son MediaSource — l'élément portait
encore le `.m3u8` brut, la promesse rejetait silencieusement, et il fallait
réappuyer. `playMedia()` (utilisé par tous les chemins de lecture : surface,
barre globale, grand lecteur, chapitres, reprise, autoplay, MediaSession,
clavier) tente le play dans le geste, puis **réessaie automatiquement** dès
que le media est prêt (`loadedmetadata`/`canplay`, ou `MANIFEST_PARSED` de
hls.js) — l'élément garde l'activation de geste du premier essai.
