# Étude — Le lecteur d'épisode piloté par le frontmatter

Objectif : remplacer le bloc `<audio>` **statique** dans le corps des
README d'épisodes par un bloc **généré depuis le frontmatter**
(convention « frontmatter = source de vérité », déjà établie pour OKF,
`start-replace-fm`, médiagraphie).

---

## 1. État actuel (vérifié)

- Chaque épisode (30/30) a dans son frontmatter : `output_name`
  (`"balado-s01e01-bitkeeper-git"`), `season`, `episode`, `title`,
  `date`, `lang`, `format: "m4a"`.
- Le corps contient un bloc statique :
  ```html
  <audio controls preload="none" src="balado-s01e01-bitkeeper-git.m3u8" style="width:100%">
    <track kind="subtitles" src="balado-s01e01-bitkeeper-git.vtt" srclang="fr" label="Français" default>
  </audio>
  ```
- **Personne ne génère ce bloc** : ni balado (lit le frontmatter pour
  construire l'audio, ignore le corps), ni docsh. Il est écrit à la main
  et a survécu au refactor snabaldo.
- Vérifié : `output_name` == stem du `src` m3u8 **pour les 30 épisodes**
  (0 mismatch). Le bloc est donc **entièrement dérivable** du frontmatter
  sans champ supplémentaire.
- docsh possède déjà le mécanisme idempotent `start-replace-fm`
  (`generators/title_block.py` : scan des blocs, lecture du frontmatter,
  rendu par `format=`, remplacement) — l'extension est naturelle.

## 2. Proposition

### Cible (corps d'épisode)

```html
<!-- start-replace-fm field="output_name" format="podcast" -->
<audio controls preload="none" src="balado-s01e01-bitkeeper-git.m3u8" style="width:100%">
  <track kind="subtitles" src="balado-s01e01-bitkeeper-git.vtt" srclang="fr" label="Français" default>
</audio>
<!-- end-replace-fm -->
```

### Côté docsh (petit)

- `title_block.py` : nouveau mode `format="podcast"` dans
  `_render_field(value, field, fmt, …)` — émet le bloc depuis
  `output_name` (+ `lang` → `srclang`, `label` i18n fr/en). Le rendu
  est **identique** au markup actuel (aucune régression plugin /
  remote-repo).
- Validation intégrée : si les assets `{stem}.m3u8` / `.vtt` / `.json` /
  `-cover.png` n'existent pas → avertissement (le générateur connaît le
  stem) — transforme un lien mort silencieux en signal.
- Tests : rendu du bloc, idempotence, avertissement asset manquant.

### Migration des 30 README (mécanique)

- Remplacer le bloc statique par les tags `start-replace-fm` (même
  contenu) — un script idempotent, puis `docsh run --only title_block`
  régénère. Diff minimal : seules les 2 lignes de tags s'ajoutent.

## 3. Valeur ajoutée

| Bénéfice | Détail |
|---|---|
| **Source de vérité unique** | Renommer un épisode (changement de `output_name`/slug) → le bloc suit ; zéro src mort possible |
| **Préparation `autoAdvance`** | Le frontmatter peut porter `next: "02-gratuit-libre"` (ou dérivation `episode+1`) → le générateur émet `data-next="…"` sur l'`<audio>` → le mode navigation du backlog (fin d'épisode → page suivante) a son support de données |
| **data-title cohérent** | Émettre `data-title="{title}"` → MediaSession correct sans dépendre du nom de fichier |
| **Validation assets** | m3u8/vtt/json/cover vérifiés à la génération |
| **Zéro changement player** | Le plugin docsify-podcast-player améliore le bloc généré comme aujourd'hui (fixPaths, auto-dérivation cover/chapters) |
| **Zéro changement balado** | balado lit le frontmatter ; le corps ne l'intéresse pas |
| **Remote-repo (site du cours)** | Le bloc généré est identique → l'embedding `/remote/…` inchangé |

## 4. Coûts & risques

| Point | Évaluation |
|---|---|
| docsh : extension `_render_field` + tests | Petit (1 mode + ~3 tests) |
| Migration 30 README | Mécanique, idempotente, diff minimal |
| Convention | Le tag s'appelle `start-replace-fm` mais n'est pas un « champ » à proprement parler (`format="podcast"` sur `output_name`) — acceptable, ou tag dédié `start-replace-podcast` (plus propre, un peu plus de code) |
| `label`/`srclang` | Dérivés de `lang` (fr partout aujourd'hui) — garder le label « Français » explicite si `lang=fr` |
| `style="width:100%"` | Conservé dans le template généré (compat) |
| Ordre dans le corps | Le bloc doit rester à sa position actuelle (le tag remplace le bloc sur place — pas de déplacement) |

## 5. Décisions à trancher

| # | Question | Recommandation |
|---|---|---|
| D1 | Champ dérivé de `output_name` vs champ explicite `audio:` | **Dérivé de `output_name`** (0 champ nouveau ; `audio:` seulement si une exception future le justifie) |
| D2 | Mode `format="podcast"` dans title_block vs nouveau générateur `start-replace-podcast` | **Mode dans title_block** (réutilise scan/remplacement/test existants) |
| D3 | Émettre dès maintenant `data-title` (+ `data-next` si `next:` présent) ? | **Oui pour `data-title`** ; `data-next` seulement quand `autoAdvance` sera implémenté |
| D4 | Validation des assets dans le générateur | **Oui** (avertissement non bloquant) |

## 6. Plan d'exécution (si validé)

1. docsh : mode `podcast` + validation + tests (subtree sn → upstream).
2. Script de migration : insérer les tags autour des blocs existants
   (30 fichiers), `docsh run --only title_block` pour vérifier
   l'idempotence.
3. Commit sn + push (CI redeploy — aucun changement visible en prod
   puisque le rendu est identique).
4. Plus tard : `next:` dans le frontmatter → `data-next` → `autoAdvance`.
