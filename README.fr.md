# vibelore

[한국어](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [Español](README.es.md) | Français | [繁體中文](README.zh-Hant.md) | [ไทย](README.th.md) | [العربية](README.ar.md)

**Un outil local pour écrire des romans web avec l'IA et les transformer en webtoons. L'univers tient bon même après des centaines d'épisodes.**

*Write serial fiction with your AI coding agent, keep the lore consistent for hundreds of chapters, then adapt it into webtoon scenes. Local, Markdown, no extra API keys for writing.*

[![Node](https://img.shields.io/badge/node-22.13%2B%20%7C%2024%20%7C%2026-brightgreen)](docs/GETTING_STARTED.en.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Grok-black)](HOSTS.en.md)
[![Showcase](https://img.shields.io/badge/showcase-3%20works-orange)](https://fbwndrud.github.io/vibelore/showcase/)

On l'utilise en le branchant comme serveur MCP sur un outil de programmation IA comme Claude Code, Codex ou Grok CLI. Cette IA écrit le texte et dessine les images ;
vibelore mémorise l'univers, les personnages, les indices semés et la chronologie, vérifie chaque épisode et ne fige rien avant votre approbation.

<table>
<tr>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/executionprincess/"><img src="docs/showcase/executionprincess/img/ep01-s9.webp" width="260" alt="La princesse une minute avant son exécution, épisode 1, scène 9"></a><br><sub><i>La princesse une minute avant son exécution</i> · fantasy romantique, régression et vengeance</sub></td>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/verdict-live/"><img src="docs/showcase/verdict-live/img/ep01-s6.webp" width="260" alt="Verdict LIVE, épisode 1, scène 6"></a><br><sub><i>Verdict LIVE</i> · thriller sur le lynchage en ligne</sub></td>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/thundertrail/"><img src="docs/showcase/thundertrail/img/ep01-s1.webp" width="260" alt="L'Éclair sur la route, épisode 1, scène 1"></a><br><sub><i>L'Éclair sur la route</i> · road movie d'action fantastique</sub></td>
</tr>
</table>

Ce sont tous des résultats réels de romans écrits avec vibelore puis adaptés en webtoon. Chaque œuvre a été réalisée par une IA différente.

- **[La princesse une minute avant son exécution](https://fbwndrud.github.io/vibelore/showcase/executionprincess/)** : GPT-6 Sol s'est chargé de tout, de la conception au roman et à l'adaptation en webtoon.
- **[Verdict LIVE](https://fbwndrud.github.io/vibelore/showcase/verdict-live/)** : Claude Opus 5.5 a écrit le roman et l'adaptation en webtoon, et Codex a dessiné les images.
- **[L'Éclair sur la route](https://fbwndrud.github.io/vibelore/showcase/thundertrail/)** : Codex, Claude et Grok ont chacun adapté le même roman. Il existe aussi une [comparaison des modèles](https://fbwndrud.github.io/vibelore/showcase/thundertrail/compare.html).

Nous n'avons pas choisi que les scènes réussies. Les scènes recalées à la revue, les prompts et même les coûts sont visibles tels quels dans la [liste des œuvres](https://fbwndrud.github.io/vibelore/showcase/). Les œuvres et le site de la vitrine sont en coréen.

---

## Si l'on confie simplement un long roman à une IA

**❌ Sans vibelore**

- Vers l'épisode 10, les formes d'adresse changent, des personnages morts reparlent et les règles des pouvoirs changent en douce.
- L'IA comme vous oubliez l'indice semé à l'épisode 3.
- Quand la session se coupe, on recommence en recollant « le résumé jusqu'ici ».
- Pour en faire un webtoon, on réexplique à chaque fois depuis zéro le découpage des cases, l'apparence des personnages et le placement des dialogues.

**✅ Avec vibelore**

- L'univers, les personnages et le texte restent un canon en Markdown, et le brouillon de chaque épisode est confronté à ce canon : **les violations hard sont corrigées, les violations soft vous sont soumises.**
- La planification suit l'ordre œuvre entière → arc → épisode, et seul ce que vous approuvez devient une contrainte pour l'épisode suivant.
- Un travail interrompu reprend au même endroit, seuls les manuscrits qui passent les vérifications sont validés, et l'on peut revenir en arrière épisode par épisode.
- La langue de l'œuvre se règle avec un seul argument `language`, et les langues autres que le coréen suivent le même flux.
- Un flux de production de webtoon est inclus : il reprend tels quels les personnages et l'état de l'original, fixe la portion de l'original, le style graphique, les références, le nombre de cases et le modèle d'image, puis génère chaque scène en une seule image, dialogues compris.

## Démo en 30 secondes

Il suffit de dire ceci dans le chat de l'hôte.

> Écris l'épisode suivant. Montre-le-moi une fois fini, et valide-le quand je l'approuve.

```text
Entretien ─▶ Conception de l'œuvre ─▶ Plan d'arc ─▶ Plan d'épisode ─▶ Brouillon ─▶ Vérif. univers/chronologie/langue ─▶ Revue ─▶ Approbation ─▶ Commit
 (1 fois)     (approuver)              (approuver)   (auto)                         violations hard corrigées            advisory utilisateur    Markdown
```

La conception de l'œuvre regroupe la génération de l'univers et des personnages, l'approbation de l'histoire complète (StorySpine) et
celle de la skill d'écrivain propre à l'œuvre (WriterSkill) ; l'écriture ne commence qu'ensuite. La vérification de la langue de l'œuvre s'applique à toutes les œuvres, y compris coréennes.

Quand le manuscrit et les éléments de la revue arrivent, répondez « approuver » ou « corrige ce passage et recommence ». Le mode `auto` valide
automatiquement quand les vérifications obligatoires passent et que la revue se termine normalement. Les advisory de la revue sont
enregistrés sans bloquer le commit, et si la revue ne se termine pas, le brouillon repart en attente d'approbation. Pour un webtoon, une phrase suffit aussi.

> Fais un webtoon de l'épisode 1. Demande-moi d'abord la direction de production.

```text
Portion·style·références·cases·modèle d'image ─▶ Mise en scène ─▶ Vérif. avant génération ─▶ Image de scène avec dialogues ─▶ Revue de l'image
 (vos choix)                                      (en anglais)     blocage hard               texte original, langue de l'œuvre échec : nouveau plan automatique
```

Le nombre de cases est un entier (1-12) ou `auto`, et les références sont des fichiers d'image de personnages et de décors que vous fournissez.
Le modèle d'image se choisit parmi les modèles de l'API OpenAI `gpt-image-2`, `gpt-image-2.5-sunburst` (par défaut) et
`gpt-image-2.5-flare`, et c'est l'hôte qui l'appelle. Si la vérification avant génération ou la revue de l'image échoue, la scène est
replanifiée à partir des défauts puis régénérée (2 fois par défaut, 3 au maximum, chaque fois un appel d'image payant). Le résultat est
l'image de la scène plus `scene.html`, sous `.vibelore/webtoon/candidates/`.

## Installation

Donnez l'adresse du dépôt à l'outil de programmation IA que vous utilisez (Claude Code, Codex, Grok CLI) et demandez-lui.

> Récupère https://github.com/fbwndrud/vibelore et enregistre-le comme serveur MCP.

Il suffit de Node.js 22.13 ou plus récent (22.x), 24.x ou 26.x. Ni compilation ni installation de dépendances.
Une fois l'enregistrement fait, redémarrez l'outil IA une fois.

<details>
<summary>Pour l'enregistrer avec npm</summary>

Lancez le serveur MCP depuis le paquet npm [`vibelore`](https://www.npmjs.com/package/vibelore) sans récupérer le dépôt.

```bash
claude mcp add-json vibelore '{"command":"npx","args":["-y","vibelore"]}' --scope project
```

Pour Codex, c'est `command = "npx"`, `args = ["-y", "vibelore"]` ; pour Grok CLI, `grok mcp add vibelore -- npx -y vibelore`.
Sous Windows, ajoutez `cmd /c` devant `npx` (`"command":"cmd","args":["/c","npx","-y","vibelore"]`).
Pour figer une version précise, écrivez `vibelore@<version>`. La voie npm n'enregistre que le serveur MCP : installez donc les skills d'entretien
avec la méthode du dépôt ci-dessous ou le plugin Codex.
</details>

<details>
<summary>Pour récupérer le dépôt et l'enregistrer vous-même</summary>

```bash
git clone https://github.com/fbwndrud/vibelore.git
```

Claude Code :

```bash
claude mcp add-json vibelore '{"command":"node","args":["/absolute/path/to/vibelore/src/server.js"]}' --scope project
```

Codex (`~/.codex/config.toml`) :

```toml
[mcp_servers.vibelore]
command = "node"
args = ["/absolute/path/to/vibelore/src/server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 6000
```

Grok CLI :

```bash
grok mcp add vibelore -- node /absolute/path/to/vibelore/src/server.js
```

Pour Claude Code, la skill de la boucle d'écriture se trouve dans `hosts/claude/skills/novel/`, et les skills d'entretien sur l'œuvre et sur le webtoon dans `skills/story-discovery-interview/` et `skills/webtoon-discovery-interview/`. Copiez-les toutes sous `.claude/skills/`. Ce dépôt peut aussi s'installer comme plugin Codex (`.codex-plugin/plugin.json`).
</details>

Une fois l'installation faite, commencez votre première œuvre. Décrivez en une ou deux phrases l'histoire que vous voulez écrire.

> Je veux commencer un nouveau roman. C'est l'histoire d'un chauffeur de bus de nuit qui écoute les regrets de ses passagers. Commence par l'entretien sur l'œuvre.

L'entretien ne porte que sur les préférences qui changent le résultat, 4 ou 5 à la fois. Pour le sauter, dites « décide automatiquement
sans me demander ». En cas de blocage, consultez le [guide de démarrage](docs/GETTING_STARTED.en.md).

## Ce qu'il fait

- **Entretien sur l'œuvre.** Au lieu d'un nom de genre, il interroge sur le rythme, la difficulté, l'émotion, la récompense et les tabous pour établir un contrat de lecture (StoryProfile), puis génère automatiquement l'univers et les personnages.
- **Conception des arcs.** Il fait d'abord approuver une promesse sur 3 à 20 épisodes avec des événements, pressions et retournements esquissés, et remplit automatiquement les plans par épisode au moment de l'écriture.
- **Vérification et correction à chaque épisode.** Il confronte le brouillon aux personnages, aux formes d'adresse, au point de vue, à la chronologie et aux indices semés, et en cas de conflit avec des faits établis, corrige et revérifie automatiquement (3 vérifications au plus, avec au plus 2 corrections entre elles). Les remarques de goût, comme le style ou le rythme, restent de simples advisory.
- **Référence de style.** Désignez un épisode qui vous plaît comme ancre de style, et les suivants en suivent la texture.
- **Retour en arrière.** Ramenez toute l'œuvre au point d'un épisode donné et réécrivez à partir du suivant (l'état antérieur est conservé pour pouvoir être restauré).
- **Adaptation en webtoon.** Il reprend l'état de l'original, confirme la portion de l'original, le style graphique, les références, le nombre de cases et le modèle d'image, puis termine chaque scène en une seule image, dialogues compris.

**Ce qu'il ne fait pas.** Une interface web (le chat de l'hôte sert d'interface), des appels d'API payants par le serveur MCP lui-même (les API d'image
sont exécutées par l'hôte), la réécriture d'un épisode antérieur ou le recalcul de l'état suivant avec les outils par défaut (seuls les outils
de reprise `lore_rewrite` et `lore_refold` de `VIBELORE_MCP_SURFACE=advanced` le font), une garantie de qualité littéraire,
l'édition simultanée ou le multi-locataire, ni le découpage automatique en PNG/JPEG pour les plateformes.

## Tâches courantes

| Ce que vous voulez | Dites ceci à l'hôte |
|---|---|
| Le dernier épisode ne me plaît pas | Modifiez le manuscrit à la main, puis « Vérifie les changements » → vérification → approbation |
| J'ai écrit jusqu'à l'épisode 3 mais je veux tout refaire à partir du 2 | « Reviens en arrière jusqu'à l'épisode 1 » → « Écris l'épisode suivant » |
| Je veux tout ramener au point de l'épisode 5 | « Reviens en arrière jusqu'à l'épisode 5 » |
| Le style de cet épisode est parfait, je veux garder ça | « Approuve l'épisode 3 comme référence de style. Raison : les dialogues sont courts et secs » |
| J'ai modifié un fichier d'univers à la main | « Vérifie les changements » → il indique la portée de l'impact et la suite à donner |
| Je veux voir pourquoi c'est écrit ainsi | « Montre-moi les éléments de revue et la vraie requête d'écriture de cet épisode » |
| Je veux faire un webtoon d'un roman existant | « Adapte l'épisode 1 en webtoon. Demande-moi d'abord la direction de production » |
| Je veux redessiner une scène du webtoon | « Redessine cette scène de l'épisode 1 [ainsi] » |

Pour les corrections, la reprise et les sauvegardes, consultez [Dépannage et sauvegardes](docs/TROUBLESHOOTING.en.md).

## Comment se fait un webtoon

<table>
<tr>
<td><img src="docs/showcase/thundertrail/img/ep01-s4.webp" width="180" alt="L'Éclair sur la route, épisode 1, scène 4"></td>
<td><img src="docs/showcase/thundertrail/img/ep02-s6.webp" width="180" alt="L'Éclair sur la route, épisode 2, scène 6"></td>
<td valign="top">

Il transforme tel quel en webtoon un roman déjà écrit. L'apparence des personnages, l'univers et la situation jusqu'à cet épisode viennent de l'original : inutile de les réexpliquer.

1. **Portion de l'original et direction.** Il demande quel épisode et quels paragraphes adapter, le style graphique, le lettrage et la liberté de composition, puis résume le tout en mise en scène en anglais à valider.
2. **Références.** Vous indiquez des fichiers d'image de référence des personnages et des décors (au moins un). Une scène qui en suit une autre utilise aussi l'image finie de la scène précédente.
3. **Cases et modèle d'image.** Vous choisissez le nombre de cases (1-12 ou auto) et le modèle d'image avec son coût. Le choix du modèle est conservé par œuvre.
4. **Finition.** Mise en scène → vérification avant génération → une image de scène avec les dialogues dessinés → revue de l'image réelle. En cas d'échec, il replanifie et redessine automatiquement (2 fois par défaut, 3 au maximum). Les exemples ci-dessus ont été faits ainsi.

La méthode consistant à faire d'abord approuver des crayonnés case par case est deprecated et ne sert qu'à poursuivre les travaux déjà en cours.
</td>
</tr>
</table>

Les images sont dessinées par le modèle d'image OpenAI que vous choisissez (`gpt-image-2`, `gpt-image-2.5-sunburst` (par défaut) ou `gpt-image-2.5-flare`), que l'hôte appelle par l'API. Il faut une clé d'API et une facturation propres ; avant la première scène, on vous montre le modèle, le coût et ce qui est envoyé, et votre réponse fixe le choix pour l'œuvre. Les résultats du webtoon sont stockés à part du canon du roman et ne le modifient jamais.
Pour le détail des étapes, consultez le [guide de production de webtoon](docs/WEBTOON.en.md).

## Pourquoi vibelore

Ce n'est pas un outil qui écrit le roman à votre place à partir d'un jeu de règles. Il s'accorde d'abord sur l'expérience de lecture, préserve la capacité créative de l'IA,
et ne prend en charge que la mémoire, la causalité, la cohérence, l'approbation et la reprise, qui cèdent facilement dans une œuvre longue.

- **Le contrat de lecture d'abord.** Pas un nom de genre, mais le rythme, la difficulté, l'émotion, la récompense et les tabous, et cette promesse est tenue à chaque épisode.
- **La causalité l'emporte sur la décoration.** Plutôt que d'ajouter des éléments d'univers, il fait s'enchaîner actions, réactions et conséquences, et construit les personnages par l'accumulation de leurs choix, pas par des explications.
- **Le dernier mot revient à l'humain.** Le manuscrit Markdown est le canon, et un advisory n'est pas un ordre de correction automatique.

| Acteur | Rôle |
|---|---|
| Utilisateur | L'expérience de lecture souhaitée, les préférences importantes, l'approbation finale |
| IA hôte | Juger les idées, construire les scènes, générer la prose, les dialogues et les images, critique sémantique |
| vibelore | Transmettre le canon et les plans, garantir l'ordre, vérifier les conflits, consigner les éléments de revue, commit et reprise |
| Canon Markdown | Les faits définitifs de l'univers, des personnages, du texte et des résumés |

Pour l'orientation générale, voir la [philosophie](docs/PHILOSOPHY.en.md) ; pour la structure, l'[architecture](docs/ARCHITECTURE.en.md).

## Genres pris en charge

Il existe 25 presets de genre, et chaque preset suit des éléments d'univers différents (chronologie, savoir issu de la régression, état des relations, système
de pouvoirs, etc.).

`Chasseur régressé` `Méchante isekai` `Fantasy d'académie` `Régression de maison noble` `Vengeance du banni` `Thriller à énigme` `Action`
`Comédie` `Historique` `LitRPG` `LitRPG de streaming` `Progression` `Apocalypse à système` `Ascension de la tour` `Isekai`
`Cultivation` `Xianxia` `Xuanhuan` `Cœur de donjon` `Fantasy romantique` `SF` `Horreur` `Tranche de vie réconfortante` `Urbain contemporain` `Autre`

Les genres absents de la liste et les genres mixtes fonctionnent aussi. L'entretien décompose le genre en ton, sous-genre et moteur narratif pour établir
le profil de l'œuvre, et la vérification de l'univers utilise le preset le plus proche.

## Langue de l'œuvre

La langue dans laquelle l'œuvre est écrite se règle avec l'argument facultatif `language` qu'acceptent `lore_profile`, `lore_init`
et `lore_create` (le `language` de `lore_write` vérifie seulement qu'il correspond à la langue enregistrée). Quand l'utilisateur indique la langue d'écriture en langage naturel, l'hôte la normalise en étiquette BCP 47
(`ja`, `pt-BR`, `zh-Hant`, etc.) et la transmet ; si aucune langue n'est choisie, l'argument est omis.
Les œuvres existantes sans clé de langue sont un `ko` implicite. La langue de la conversation et celle de l'œuvre sont indépendantes : on peut
écrire une œuvre en japonais en conversant en coréen.

> Je veux créer une œuvre nommée `harbor_summer` dans `/absolute/path/to/my-novel`. Écris le texte en espagnol.

- Il existe deux familles de prompts. `ko` utilise des instructions propres au coréen, et toutes les autres langues (anglais compris) une famille qui
  combine les instructions communes en anglais avec la langue cible. Le texte, les titres, les résumés, les descriptions de l'univers et des personnages et les valeurs
  descriptives des plans et des revues suivent la langue cible, tandis que les valeurs lues par la machine, comme les clés JSON, les enums et les ID, ne sont pas traduites.
- La longueur se mesure dans une unité adaptée à la langue. Le coréen garde le décompte de caractères existant ; les autres langues utilisent les graphèmes
  ou les mots, et les écritures riches en caractères combinants comme l'arabe et l'hébreu, ou le thaï, qui ne sépare pas les mots par des espaces,
  sont traitées dans le même contrat.
- Avant la création de la foundation, on peut changer de langue en approuvant une nouvelle revision du profil, et une valeur différente
  de la langue approuvée est refusée avec `LANGUAGE_CONTRACT_CONFLICT`. Une fois la foundation créée, la langue ne peut plus changer, et
  une valeur différente est refusée avec `WORK_LANGUAGE_IMMUTABLE` au lieu d'être écrasée en silence.
- À chaque épisode, on vérifie que le texte, le résumé et le plan sont écrits dans la langue de l'œuvre, et les invariants sémantiques comme
  le point de vue, l'enregistrement des personnages et le cadre de l'univers sont examinés par le même vérificateur quelle que soit la langue.
- Les webtoons suivent aussi la langue de l'œuvre. Les dialogues ne sont pas traduits : ils entrent dans l'image en texte original dans la langue de l'œuvre,
  et le prompt d'image précise la langue, l'écriture et le sens de lecture (de droite à gauche pour l'arabe).

L'écriture de romans et le flux de webtoon par scène ont été vérifiés sur un échantillon de recette en 8 langues : l'anglais, l'espagnol,
le japonais, le français, le coréen, l'arabe, le chinois traditionnel et le thaï. Le modèle hôte de cet échantillon était Claude Sonnet 5. Pour le détail du contrat des
arguments, voir [Langue de l'œuvre et unités de longueur](docs/TOOLS.en.md#work-language-and-length-units).

## Où sont les fichiers

```text
my-novel/
├── world/         cadre de l'univers — vous pouvez le modifier
├── characters/    fiches des personnages — vous pouvez les modifier
├── chapters/      texte — vous pouvez le modifier
├── summaries/     résumés par épisode
├── webtoon/       résultats approuvés et masters SVG/HTML du travail case par case (deprecated)
└── .vibelore/     journaux de vérification, instantanés de reprise, résultats des scènes de webtoon (webtoon/candidates/) — n'y touchez pas
```

Les manuscrits et les journaux de production restent sur votre ordinateur. Le manuscrit et les images de référence nécessaires à une requête peuvent être envoyés
à l'hôte et au service de modèles connectés. Les limites sont décrites dans le [guide de sécurité](SECURITY.md).
Le droit d'auteur du manuscrit appartient à son auteur, et la licence de ce dépôt ne s'y applique pas.

## Modèles et coûts

- **Le roman** est écrit par le modèle choisi dans la session de l'hôte, tel quel. Pas de clé d'API séparée. On peut donner des indications par étape qui confient les étapes de planification, de brouillon et de revue à un modèle plus léger (en relais par l'hôte ce sont des indications ; seul un modèle local change réellement) ; les étapes qui extraient les faits établis restent sur le modèle de base sauf réglage explicite.
- **Les images du webtoon** viennent de l'API d'image OpenAI (`gpt-image-2`, `gpt-image-2.5-sunburst` (par défaut), `gpt-image-2.5-flare`), appelée par l'hôte, avec sa propre clé et sa propre facturation. Le modèle confirmé est enregistré par œuvre et n'est jamais changé ni remplacé d'office.
- **Les modèles de texte locaux** peuvent être branchés par variables d'environnement sur un point de terminaison compatible OpenAI.

Pour la configuration détaillée, voir [Réglages des modèles](docs/MODELS.en.md).

## Questions fréquentes

<details>
<summary>Y a-t-il une interface graphique ?</summary>

Non. Le chat de Claude Code, Codex ou Grok CLI sert d'interface, et les résultats sortent sous forme de manuscrits Markdown et, pour les webtoons, d'une image PNG/JPEG par scène (lettrage compris) avec `scene.html`.
</details>

<details>
<summary>Est-ce que cela coûte en plus ?</summary>

L'écriture du roman tourne dans le cadre de l'abonnement ou des crédits de l'hôte. Par défaut, vibelore n'appelle aucun modèle directement (sauf si vous branchez un modèle local). Les images du webtoon viennent de l'API d'image OpenAI, appelée par l'hôte, et suivent la facturation de ce compte.
</details>

<details>
<summary>Si cela s'arrête en cours de route, faut-il tout recommencer ?</summary>

Non. Les workflows sont enregistrés : « continue » reprend au même endroit. Seuls les manuscrits qui passent les vérifications sont validés, et les instantanés par épisode permettent de revenir en arrière. Voir [Dépannage](docs/TROUBLESHOOTING.en.md#work-stopped-midway).
</details>

<details>
<summary>Puis-je modifier l'univers ou le texte à la main ?</summary>

Oui. `world/`, `characters/` et `chapters/` sont faits pour être modifiés par des humains. Après modification, dites « vérifie les changements » et il indiquera la portée de l'impact et la suite à donner.
</details>

<details>
<summary>Et si ce que le vérificateur a relevé est en fait un rebondissement voulu ?</summary>

Une violation hard est un conflit avec des faits établis, elle est donc corrigée ; s'il s'agit vraiment d'un rebondissement, modifiez d'abord le fichier d'univers. Une violation soft peut relever de l'intention de l'auteur : l'IA ne la corrige pas automatiquement et vous pose la question.
</details>

<details>
<summary>Peut-on écrire dans d'autres langues que le coréen ?</summary>

Oui. La langue d'écriture se règle à la création de l'œuvre (dans le profil ou avec `lore_create`/`lore_init`), et l'entretien se déroule dans la langue que vous utilisez. Les guides existent en original coréen et en version anglaise (`*.en.md`). Voir [Langue de l'œuvre](#langue-de-lœuvre) plus haut.
</details>

## Pour aller plus loin

Les liens vers la documentation mènent aux versions anglaises. L'original coréen se trouve dans le fichier `.md` du même nom.

- [Guide de démarrage](docs/GETTING_STARTED.en.md) — enregistrement, première œuvre, épisode suivant, en cas de blocage
- [Production de webtoon](docs/WEBTOON.en.md) — portion de l'original et choix obligatoires, production par scène entière et revue
- [Dépannage et sauvegardes](docs/TROUBLESHOOTING.en.md) — reprise du travail, retouches à la main, retour en arrière, conservation des fichiers
- [Réglages des modèles](docs/MODELS.en.md) — choix des modèles de texte et d'image, voies de coût, modèles locaux
- [Référence des outils](docs/TOOLS.en.md) — le contrat complet des outils appelés par l'hôte
- [Architecture](docs/ARCHITECTURE.en.md) — structure de production du roman et du webtoon, rôles de l'IA et du serveur, limites de stockage
- [Toute la documentation](docs/README.en.md) · [Journaux de vérification par hôte](HOSTS.en.md) · [Contribuer](CONTRIBUTING.md) · [Sécurité](SECURITY.md)

Apache-2.0. Les droits sur les manuscrits et les images appartiennent à ceux qui les ont créés.
