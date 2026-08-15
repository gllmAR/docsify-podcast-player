# Plan — Migration de sn vers le lecteur unifié (via CDN upstream)

Objectif : activer `podcastPlayer: { unified: true }` sur
`tim-montmorency.codeberg.page/sn/` — le player est chargé du CDN upstream
(`gllmar.github.io`, déjà le cas) ; **aucun README d'épisode ne change**,
aucun vendoring.

État vérifié : 30 pages avec audio, **exactement 1 `<audio>` par page** —
l'hypothèse « une source par page » du lecteur unifié est satisfaite.

---

## 0. Déjà en place (rien à refaire)

- Player **1.6.2** servi en CDN upstream (Phases 1–3 unifiées : barre
  persistante, surfaces, lecteur plein en page, bandeau + lien, cleanup
  des listeners, padding body).
- Le plugin s'auto-enregistre (`downloadSw`), `sw.js` généré par CI, site
  CDN-only.

## 1. Contrainte clé

L'`index.html` du site est **régénéré par `docsh run` en CI** — un bloc
`podcastPlayer` ajouté à la main serait écrasé. La config doit être émise
par docsh.

## 2. Étapes

### A. docsh — émettre la config podcastPlayer — ✅ fait (poussé upstream a699227f)

Dans `docsh/src/docsh/init.py` (subtree sn ; à pousser upstream ensuite) :

1. Nouvelles options `.docsh.toml` :
   ```toml
   [site.podcast]
   unified = true          # lecteur unifié
   artist = "Souveraineté numérique"
   album = "SN — balado"
   # miniPlayer / resumeChip / speedOptions… (facultatif, défauts OK)
   ```
2. `InitConfig` : champs `podcast_unified`, `podcast_artist`,
   `podcast_album` (+ éventuellement les autres clés v2).
3. Émission dans le template d'index (à côté du bloc
   `podcastPlayer` existant si présent) :
   ```html
   <script>
     window.$docsify.podcastPlayer = {
       unified: true,
       artist: 'Souveraineté numérique',
       album: 'SN — balado',
     };
   </script>
   ```
   (généré **avant** `<script src="…docsify-podcast-player.js">`)
4. Tests docsh (`test_init.py`) : le bloc est émis quand
   `podcast_unified` est vrai, absent sinon ; valeurs passées intactes.
5. `docsh run` côté sn → l'index régénéré contient le bloc.

### B. Activation sn — ✅ fait (66c3c5e9, déployé 6423056)

- `.docsh.toml` : ajouter `[site.podcast]` (ci-dessus).
- `docsh run` local → vérifier l'index (bloc présent, script player CDN
  inchangé, aucun `vendor/`).
- Commit + push → CI (runner rétabli) : `docsh run` → curl `sw.js` →
  deploy.

### C. Vérification déployée (QA checklist)

| # | Test | Attendu |
|---|---|---|
| 1 | Lire l'ép. 01, naviguer vers l'ép. 02 | La lecture **continue** ; barre en bas ; page 02 = surface + bandeau « En lecture : 01 » [Basculer] [Aller à la page] |
| 2 | Clic « Aller à la page » | Retour sur la page de l'ép. 01 → **lecteur plein** lié |
| 3 | Basculer sur 02 | Page 02 passe en lecteur plein ; chapitres/transcript de 02 |
| 4 | Clic chapitre + cue transcript | Seek de l'audio global (même source) |
| 5 | Fermer l'onglet, revenir | Reprise à la position (localStorage) via chip/surface |
| 6 | Téléchargement | SW actif (m4a synthétisé) — inchangé |
| 7 | iPhone SE / mobile | Barre + safe-area, pas de recouvrement du footer (padding body) |
| 8 | VoiceOver | Barre annoncée (region), boutons labellisés |
| 9 | MediaSession (écran verrouillé) | Titre « Épisode X », artist « Souveraineté numérique », chapitres |
| 10 | Zoom 200 %, forced-colors, reduced-motion | Pas de casse |

### D. Rollback (si anomalie)

1. `.docsh.toml` : `unified = false` (ou retirer `[site.podcast]`).
2. `docsh run` → push → CI redeploie.
3. Le player 1.6.2 gère les deux modes — l'ancien comportement (player
   par page, arrêt à la navigation) revient sans changement de code.

## 3. Risques & mitigations

| Risque | Mitigation |
|---|---|
| Modif docsh dans le subtree sn divergente de l'upstream | Pousser la feature upstream (session docsh) ; le subtree local suffit pour CI |
| Cache navigateur du player JS (GitHub Pages ~10 min) | Attendre ~10 min après le push 1.6.2 avant la QA ; hard-refresh |
| Le bandeau « Aller à la page » dépend de `gLoadedRoute` (hash au moment du clic play) | OK pour le routing par hash docsify ; lien via `location.hash` |
| Plusieurs audios sur une même page (playlist saison) | Non présent sur sn (vérifié) ; si ajouté plus tard → toutes les surfaces (pas de lecteur plein) — comportement défini |
| `autoAdvance` (backlog) dépendra du mode unifié | L'unifié est le prérequis — déjà en place |
| CI de nouveau en panne | Re-déclencher via commit vide ; le site actuel reste servi tel quel |

## 4. Ordre de livraison

1. **Player 1.6.2** en CDN — ✅ fait.
2. **A** (docsh emission + tests) — ✅ fait (subtree push upstream).
3. **B** (activation sn + deploy) — ✅ fait ; vérifié en prod :
   `podcastPlayer: { unified: true, artist: 'Souveraineté numérique',
   album: 'SN — balado' }`, player 1.6.2 CDN, sw.js 200.
4. **C** (QA checklist ci-dessous) — **restant** : validation réelle
   navigateur (écoute + navigation, mobile, VoiceOver…).
5. Ensuite : `autoAdvance` (backlog) — « à la fin, naviguer vers le
   prochain épisode », qui s'appuiera sur `gLoadedRoute`/`data-next`.
