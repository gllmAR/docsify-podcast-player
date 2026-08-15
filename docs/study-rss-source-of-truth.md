# Étude — RSS comme source de vérité du lecteur (catalogue + métadonnées)

Question : un fichier (RSS ? autre ?) régénéré à chaque passage de
`docsh` devrait donner au lecteur **toute** l'information nécessaire
(catalogue, métadonnées, liens), au lieu de ne dépendre que du DOM de la
page. Est-ce que RSS est le bon format, et quel est le bon système ?

---

## 1. Inventaire — ce dont le lecteur a besoin

| Besoin | Données | Usage actuel |
|---|---|---|
| Série | titre, description, auteur, langue, artwork, URL site | MediaSession, affichage `.pp-sub` |
| Épisode | titre, date, durée, saison, numéro, explicit, lang | MediaSession, affichage, reprise |
| Audio | URL m3u8 (lecture HLS) + m4a (download) | play + SW download |
| Cover | épisode + par chapitre (img) | artwork, swap cover |
| Chapitres | URL du `{stem}.json` (Podcast Index v1.2.0) | liste + ticks + chapterInfo |
| Transcript | URL du `{stem}.vtt` | panneau transcript |
| Navigation | épisode précédent / suivant (URL page) | barre globale, `autoAdvance` (backlog) |
| GUID | identifiant stable par épisode | cache, reprise, dédup |

## 2. État actuel (vérifié)

- balado **émet déjà un RSS standard** (`balado/rss.py`) : RSS 2.0 +
  `itunes` + `podcast` (Podcast Index) — titre, description, auteur,
  durée, episode, season, episodeType, explicit, pubDate, enclosure
  audio, `podcast:chapters` (URL JSON), `podcast:transcript` (URL VTT).
  Le modèle `PodcastConfig` contient **tout** le nécessaire.
- MAIS : par épisode uniquement (`{out_name}.xml`), écrit au build balado,
  puis **supprimé** par `build-all.sh` (artefact intermédiaire, gitignoré).
- Aucun feed de site/saison ; rien n'est régénéré par `docsh`.
- Le lecteur dérive tout du DOM de la page (stem → cover/chapters/
  transcript) — pas de catalogue, pas de prev/next global.

## 3. RSS est-il le bon format ?

**Oui, comme standard d'échange** : RSS 2.0 + namespaces `itunes` +
`podcast` est LE format de l'écosystème podcast (Apple, Spotify, Podcast
Index 2.0) — un `podcast.xml` bien formé rend le site *distribuable* tel
quel, et la couverture (chapters/transcript) y est standard.

**Mais RSS seul n'est pas idéal comme source de données runtime du
lecteur** :

| Point | RSS | JSON (manifest) |
|---|---|---|
| Parsing navigateur | `DOMParser` XML — ok | natif, plus simple/rapide |
| Richesse | chapters/transcript = **URLs** (pas le contenu) | idem (le contenu reste par épisode) |
| Catalogue (prev/next) | ordre par pubDate — implicite | champ explicite `next`/`prev` |
| Taille / lookup | feed entier à parser pour un épisode | idem (30 épisodes ≈ 20 Ko — négligeable) |
| Standard écosystème | **Oui** | Non (format maison) |

Conclusion : **RSS est le bon format pour le monde extérieur ; pour le
lecteur, une sérialisation JSON du même modèle est meilleure.** La bonne
architecture est une **double sérialisation d'un même modèle**.

## 4. Le système recommandé

```
Source de vérité : frontmatter des épisodes (OKF) — output_name, season,
episode, title, date, lang, description + assets dérivés (stem)

docsh (nouveau générateur, à chaque passage — après title_block) :
├── podcast.xml   ← RSS 2.0 + itunes + podcast : canal site (tous les
│                   épisodes, ordonnés par date, saisons, chapters/
│                   transcript par item, artwork, link) — pour les apps
│                   et la distribution
└── feed.json     ← même modèle en JSON : { series: {title, author, lang,
                    artwork, url}, episodes: [{guid, title, pageUrl,
                    audioUrl (m3u8), downloadUrl (m4a), coverUrl,
                    chaptersUrl, transcriptUrl, duration, date, season,
                    episode, explicit, next, prev}] } — la source du
                    lecteur

index.html : <link rel="alternate" type="application/rss+xml" href="podcast.xml">
             (découverte — émis par le générateur ou docsh init)

Lecteur (mode unifié) :
  boot → fetch feed.json (cache sessionStorage)
       → fallback : parser podcast.xml (DOMParser) si feed.json absent
       → fallback : comportement actuel (DOM de la page) si ni l'un ni
         l'autre (rétrocompat totale)
  usages : prev/next dans la barre globale (playlist de saison),
           autoAdvance (next → pageUrl), métadonnées MediaSession pour
           tout épisode sans visiter sa page, résolution des liens
```

- Le **`{stem}.json`** (chapters v1.2.0) reste : standard Podcast Index,
  déjà consommé par le lecteur et les apps.
- Le `next`/`prev` est **calculé par docsh** (ordre saison/numéro) — base
  de `autoAdvance` sans champ frontmatter supplémentaire (la précédente
  étude prévoyait `next:` — le feed rend ce champ superflu).

## 5. Pourquoi pas les alternatives

| Alternative | Verdict |
|---|---|
| **RSS seul** | OK pour les apps ; parsing XML + pas de prev/next explicite + format moins typé pour le lecteur. Inconvénient mineur si on accepte — mais le JSON est quasi gratuit (même modèle) |
| **JSON Feed (jsonfeed.org)** | Standard JSON mais extensions podcast (chapters/transcript/season) non normalisées — le RSS + namespace podcast est plus complet côté écosystème |
| **Podcast Index API** | API vivante, clé, dépendance réseau — incompatible avec un site statique ; le site EST la source |
| **Étendre le `{stem}.json` seul** | Pas de catalogue → pas de prev/next/autoAdvance sans fichier supplémentaire de toute façon |
| **Frontmatter seul (étude précédente)** | Complémentaire : le frontmatter alimente le générateur ; le lecteur, lui, a besoin d'un fichier machine-readable — pas du markdown |

## 6. Points d'intégration

1. **docsh** — nouveau générateur `podcast_feed` :
   - lit les README d'épisodes (frontmatter OKF + tags `start-replace-fm`
     déjà en place),
   - résout les URLs (base = `sitemap.base_url` du `.docsh.toml`),
   - valide les assets (m3u8/vtt/json/cover — comme l'étude frontmatter),
   - émet `podcast.xml` + `feed.json` (idempotent),
   - tests (structure RSS, feed.json, ordre, next/prev, validation).
2. **balado** — inchangé (ses `PodcastConfig`/`write_rss` servent déjà de
   référence de modèle ; le XML par épisode peut rester un artefact ou
   être supprimé — le feed de site le remplace).
3. **Player** — config `feedUrl` (défaut auto-détecté `feed.json` puis
   `podcast.xml`), consommé en mode unifié ; le feed alimente la barre
   (prev/next), `autoAdvance`, et les métadonnées.
4. **Site du cours** (remote-repo) : le feed du site sn reste la source —
   aucune duplication.

## 7. Décisions à trancher

| # | Question | Recommandation |
|---|---|---|
| D1 | Double sérialisation (`feed.json` + `podcast.xml`) vs RSS seul vs JSON seul | **Double** (même modèle, coût marginal, RSS = distribution) |
| D2 | Générateur docsh vs émission balado | **docsh** (exigence « mis à jour à chaque passage de docsh » ; frontmatter suffit, pas besoin de l'audio construit) |
| D3 | Lecteur : feed.json → RSS → DOM (triple fallback) | **Oui** (rétrocompat totale) |
| D4 | `next`/`prev` calculés par docsh dans le feed | **Oui** (base de `autoAdvance`, rend le champ frontmatter superflu) |
| D5 | `<link rel="alternate">` dans l'index | **Oui** (découverte) |

## 8. Plan d'exécution (si validé)

1. docsh : générateur `podcast_feed` (modèle partagé RSS/JSON) + tests
   (subtree sn → upstream, comme la feature précédente).
2. Player : `feedUrl` + consommation unifiée (prev/next, autoAdvance)
   + tests jsdom (feed.json présent, RSS fallback, DOM fallback).
3. sn : activer le générateur (ordre dans GENERATOR_ORDER), commit →
   CI : `docsh run` régénère `podcast.xml` + `feed.json` à chaque pass.
4. QA : feed valide (validateur RSS), lecteur navigue A→B→C via le feed,
   autoAdvance à la fin.
