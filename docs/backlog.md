# Backlog — docsify-podcast-player

État au 2026-08 · Trié par priorité (P0 = prochain, P2 = plus tard).

## En cours

- [ ] **Lecteur unifié** (`unified: true`) — plan : `docs/unified-player.md`.
      Playback persistant à travers la navigation Docsify (barre compacte +
      lecteur plein en page, bandeau « En lecture », surfaces liées).
- [ ] **Layout v3** — plan : `docs/ui-audit-v3.md`. Deux rangées (progress +
      transport), play dominant, groupes, temps aux extrémités, help hors
      barre. À faire dans la continuité du lecteur unifié (même refactor
      UI).

## Backlog

- [x] **Mode navigation pilotée par le lecteur** (`autoAdvance`) — livré 1.6.6
      Le lecteur contrôle l'URL : à la fin d'un épisode, il navigue vers la
      page du prochain épisode (URL change via le routeur docsify).
      - Config : `autoAdvance: true | 'next-episode' | url` ;
        attribut `data-next="…/page-episode/"` sur l'`<audio>` (le site
        peut l'émettre depuis le frontmatter `episode:`/`season:`).
      - Comportement : à `ended` → (position purgée, comme 1.5.0) →
        `location.hash = next` → la page suivante charge, le lecteur
        unifié reprend (auto-play si autorisé par la politique navigateur,
        sinon état « prêt à jouer » + chip de reprise).
      - Variante chapitre : à la fin d'un chapitre (dernier avant la fin),
        option `autoAdvance: 'next-chapter'` → sauter au chapitre suivant ;
        à la fin du dernier chapitre → navigation vers le prochain épisode.
      - A11y : annonce live « Prochain épisode : X » avant navigation ;
        l'URL doit rester partageable (hash routing).
      - Tests : `ended` → hash changé ; `data-next` absolu/relatif ;
        chapitre final → navigation ; auto-play refusé → état prêt.
- [ ] **Art par chapitre côté balado** — émettre `img` dans les
      `chapters.json` (le player swap déjà la cover, l. 463) ; décision
      produit sur la vignette (cover dérivée ? générée ?).
- [ ] **Config site sn** — bloc `podcastPlayer` émis par `docsh run`
      (branding MediaSession : artist « Souveraineté numérique », album ;
      `unified: true` ; éventuellement `miniPlayer`).
- [ ] **Pages de saison en playlist** — les index de saison (s01/README.md…)
      embarquent les 15 `<audio>` → toolbar prev/next + MediaSession
      prev/next actifs (complément naturel de l'auto-advance).
- [ ] **Persistance follow transcript** — état suivi/recherche du
      transcript par épisode (sessionStorage).
- [ ] **Copier le transcript** — bouton « copier » (texte brut du VTT).
- [ ] **Matrice QA manuelle** dans le README (VoiceOver, zoom 200 %,
      forced-colors, reduced-motion, iPhone SE) — promesse Phase 4 du
      design v2, non documentée.

## Fait (1.5.x)

- 1.5.0 — reprise inter-visites (localStorage), erreurs HLS (retry/backoff,
  message si hls.js absent), tooltip scrubber, scroll chapitre au
  changement, voix `<v>` stylées, vitesse par épisode.
- 1.5.1 — suivi VTT « bon » : scroll seulement au changement de cue,
  suspension par scroll manuel (wheel/touch) + bouton flottant « reprendre
  le suivi », highlight correct dans la liste filtrée, annonces live,
  a11y du suivi.
