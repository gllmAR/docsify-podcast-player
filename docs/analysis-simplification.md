# Analyse complète — la chaîne du lecteur de podcast (2026-08)

Inventaire, flux, simplifications faites, candidats restants.

---

## 1. Inventaire de la chaîne (5 repos / 2 runtimes)

| Composant | Fichier(s) | Lignes | Rôle |
|---|---|---|---|
| **Player** | `docsify-podcast-player.js` | ~2 700 | UI + HLS + MediaSession + suivi VTT + unifié + feed |
| **Remux** | `ts2m4a.js` | 1 024 | TS→M4A (SW + fallback main-thread) — inchangé depuis 1.0.7 |
| **SW** | `sw.js` | 61 | synthèse .m4a à la volée (import ts2m4a CDN) |
| **Tests player** | 3 fichiers | — | 91 tests jsdom |
| **Docsh** | `generators/podcast_feed.py` | ~330 | feed.json + podcast.xml depuis le frontmatter |
| **Docsh** | `init.py` | — | émission config podcastPlayer (`--podcast-unified`) |
| **Docsh** | `title_block.py` | — | tags `start-replace-fm` (source de vérité corps) |
| **Balado** | `rss.py` + `models.py` | ~110 | RSS par épisode (écrit puis supprimé) + PodcastConfig |
| **sn** | `index.html`, `.docsh.toml`, 30 README | — | config + sources |
| **Cours** | `index.html` | — | même config unifiée (embed remote-repo) |
| **CI** | `.forgejo/workflows/pages.yml` | 22 | checkout → docsh run → curl sw.js → tar → deploy |

## 2. Flux de données (une seule source de vérité)

```
frontmatter OKF des épisodes (output_name, season, episode, date, lang)
   │
   ├─► balado build ─► assets (m3u8/vtt/json/cover) + {stem}.xml (supprimé)
   │
   ├─► docsh run (CI, chaque push)
   │     ├─ title_block ─► corps des README (tags start-replace-fm)
   │     ├─ podcast_feed ─► feed.json + podcast.xml (+ lien RSS index)
   │     └─ sidebar/tags/sitemap…
   │
   └─► docsify (hash SPA)
         └─► player 1.6.5 (CDN upstream)
               ├─ surfaces page / lecteur plein (fixPaths route)
               ├─ audio global persistant (barre) + prev/next (feed.json)
               ├─ chapters {stem}.json · transcript {stem}.vtt · cover
               ├─ download via sw.js (ts2m4a)
               └─ MediaSession (artist/album du frontmatter)
```

## 3. Simplifications déjà faites (cette session)

| # | Simplification | Gain |
|---|---|---|
| S1 | `globalLoad`/`globalLoadEntry` → **`adoptGlobalSource()`** (descripteur unique) | ~50 lignes de duplication supprimées ; un seul chemin d'adoption (src/dataset/cover/HLS/rate/UI) |
| S2 | **Mini-player supprimé** (1.6.5) — remplacé par la barre unifiée ; opt-in jamais activé sur sn | ~70 lignes code + CSS + labels + config |
| S3 | Vendor → **CDN-only** (workflow 22 lignes, stock docsh) | zéro vendoring, zéro étape CI |
| S4 | **Étape « rewrite audio refs » supprimée** (3 seds : 1 mort, 2 redondants avec fixPaths) | −1 étape CI |
| S5 | `sw.js` généré par curl CI (registration auto par le plugin) | plus de fichier tracké ni de script index |
| S6 | Feed généré par docsh (un seul générateur, double sortie) | RSS standard + JSON runtime sans duplication de modèle |

## 4. Candidats de simplification restants (priorisés)

### P1 — retirer `balado/rss.py` — ✅ fait
- `write_rss` + appel `cli.py` + flag `--no-rss` supprimés (balado
  `acb02ae`) ; tests RSS retirés ; sn bump + nettoyage `*.xml` de
  `build-all.sh` (`d697ac18`). `PodcastConfig` conservé (ilst MP4).

### P2 — refactor frontmatter du bloc audio — ✅ fait
- docsh `title_block` mode `format="podcast"` (bloc depuis `output_name`,
  srclang/label depuis `lang`, idempotent, stem vide → rien) ; poussé
  upstream.
- 30 README sn : blocs statiques enveloppés dans les tags
  `start-replace-fm` (`54c4d7f6`) — diff minimal (2 lignes/README),
  vérifié idempotent (`docsh run --only title_block` → 0).

### P2 — playlist toolbar v1 (prev/next) — **décision : conserver**
- Fonctionnelle en mode non-unifié multi-audio (feature documentée,
  testée) ; morte sur sn (1 audio/page vérifié) mais le retrait casserait
  la rétrocompat promise. À réévaluer si le mode non-unifié disparaît.

### P2 — docsh `podcast_feed` : fallbacks série — ✅ fait
- `_read_series` : `.docsh.toml [site]` → index.html (2 chemins, kwargs
  `series_*` supprimés) ; test adapté à la config toml.

### P3 — `updateMediaSession(el, index)` / `trackTitle(el, i)`
- Le paramètre `index` (playlist) ne sert qu'au fallback du titre ;
  passer `-1` partout en unifié. Refactor mineur, gain faible.

### P3 — plugin single-file ~2 700 lignes
- Découper en modules ? **Non** : le CDN single-file sans build est une
  contrainte d'architecture (zero-deps, chargement direct). Les sections
  sont déjà commentées (`// ── Unified player ──`…).

## 5. Points de vigilance (ne pas « simplifier »)

| Élément | Pourquoi le garder |
|---|---|
| `fixPaths` + auto-dérivation stem | remplace les seds CI et les `data-*` ; la base de la compat |
| `ts2m4a` 1 024 lignes | remux complexe (containers MP4, tx3g, chap) — stable, testé, ne pas toucher |
| SW + `?v=` pinning | invalidation de cache obligatoire |
| Triple fallback feed (json → RSS → DOM) | rétrocompat totale, sites sans feed |
| Les 3 tiers CSS + tokens | responsive + dark/forced-colors/reduced-motion (WCAG) |
| Tests jsdom (91) | filet de sécurité du refactor |

## 6. État final chiffré

| Métrique | Avant | Après |
|---|---|---|
| Workflow CI | 7 étapes / 45 lignes | 6 étapes / 22 lignes |
| Références `vendor/` | 2 (player + remote-repo) | 0 |
| Fichiers trackés côté site (sw.js) | 1 + registration script | 0 |
| Duplication adoption source | 2 × ~50 lignes | 1 × ~55 lignes |
| Mini-player | ~70 lignes + CSS + labels | supprimé |
| Modèles RSS | balado (par épisode, jeté) + docsh (site) | docsh seul |

## 7. Prochaines actions recommandées

1. **P1** : retirer `balado/rss.py` (feed docsh suffit) — confirmer avec
   l'usage standalone de balado.
2. **P2** : refactor frontmatter du bloc audio (30 README → tag généré) —
   décisions D1–D4 de l'étude en attente.
3. **P2** : trancher la playlist toolbar v1 (retrait vs rétrocompat).
4. **P2** : simplifier les fallbacks série de `podcast_feed`.
5. Ensuite : `autoAdvance` (backlog) — `currentEntry().next` est déjà là.
