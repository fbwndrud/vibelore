# vibelore

[한국어](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [Español](README.es.md) | Français | [繁體中文](README.zh-Hant.md) | [ไทย](README.th.md) | [العربية](README.ar.md)

**Un outil local pour écrire des romans web avec l'IA et les transformer en webtoons. L'univers tient bon même après des centaines d'épisodes.**

*Write serial fiction with your AI coding agent, keep the lore consistent for hundreds of chapters, then adapt it into a vertical webtoon. Local, Markdown, no extra API keys for writing.*

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
- Un flux de production de webtoon est inclus : il reprend tels quels les personnages et l'état de l'original, confirme la direction, puis génère chaque scène en une seule image, dialogues compris.

## Démo en 30 secondes

Il suffit de dire ceci dans le chat de l'hôte.

> Écris l'épisode suivant. Montre-le-moi une fois fini, et valide-le quand je l'approuve.

```text
Entretien ─▶ Plan d'arc ─▶ Plan d'épisode ─▶ Brouillon ─▶ Vérif. univers/chronologie ─▶ Revue ─▶ Approbation ─▶ Commit
 (1 fois)    (approuver)    (auto)                       violations hard corrigées      advisory  utilisateur     Markdown
```

Quand le manuscrit et les éléments de la revue arrivent, répondez « approuver » ou « corrige ce passage et recommence ». Le mode `auto` valide
automatiquement si les vérifications et la revue passent. Pour un webtoon, une phrase suffit aussi.

> Fais un webtoon de l'épisode 1. Demande-moi d'abord la direction de production.

```text
Direction ─▶ Mise en scène en anglais ─▶ Vérif. avant génération ─▶ Image de scène avec dialogues ─▶ Revue visuelle réelle
(approuver)   par scène (auto)            blocage hard               générée par l'hôte               résultat final
```

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

La skill pour Claude Code se trouve dans `hosts/claude/skills/`, et ce dépôt peut aussi s'installer comme plugin Codex (`.codex-plugin/plugin.json`).
</details>

Une fois l'installation faite, commencez votre première œuvre. Décrivez en une ou deux phrases l'histoire que vous voulez écrire.

> Je veux commencer un nouveau roman. C'est l'histoire d'un chauffeur de bus de nuit qui écoute les regrets de ses passagers. Commence par l'entretien sur l'œuvre.

L'entretien ne porte que sur les préférences qui changent le résultat, 4 ou 5 à la fois. Pour le sauter, dites « décide automatiquement
sans me demander ». En cas de blocage, consultez le [guide de démarrage](docs/GETTING_STARTED.en.md).

## Ce qu'il fait

- **Entretien sur l'œuvre.** Au lieu d'un nom de genre, il interroge sur le rythme, la difficulté, l'émotion, la récompense et les tabous pour établir un contrat de lecture (StoryProfile), puis génère automatiquement l'univers et les personnages.
- **Conception des arcs.** Il fait d'abord approuver une promesse sur 3 à 20 épisodes avec des événements, pressions et retournements esquissés, et remplit automatiquement les plans par épisode au moment de l'écriture.
- **Vérification et correction à chaque épisode.** Il confronte le brouillon aux personnages, aux formes d'adresse, au point de vue, à la chronologie et aux indices semés, et corrige automatiquement jusqu'à 3 fois en cas de conflit avec des faits établis. Les remarques de goût, comme le style ou le rythme, restent de simples advisory.
- **Référence de style.** Désignez un épisode qui vous plaît comme ancre de style, et les suivants en suivent la texture.
- **Réécriture et retour en arrière.** Réécrivez un épisode antérieur sans toucher à l'univers, ou ramenez toute l'œuvre au point d'un épisode donné.
- **Adaptation en webtoon.** Il reprend l'état de l'original, confirme la direction de l'adaptation, le style graphique et le nombre de cases, puis termine chaque scène en une seule image verticale, dialogues compris.

**Ce qu'il ne fait pas.** Une interface web (le chat de l'hôte sert d'interface), des appels d'API payants par le serveur MCP lui-même (les API d'image
sont exécutées par l'hôte), la revérification automatique des épisodes suivants (si vous corrigez l'épisode 2, demandez vous-même la revérification du 3), une garantie de qualité littéraire,
l'édition simultanée ou le multi-locataire, ni le découpage automatique en PNG/JPEG pour les plateformes.

## Tâches courantes

| Ce que vous voulez | Dites ceci à l'hôte |
|---|---|
| L'épisode 1 ne me plaît pas ; le refaire sans toucher à l'univers | « Réécris l'épisode 1 [dans cette direction] » → vérification → approbation |
| J'ai écrit jusqu'à l'épisode 3 mais je veux corriger le 2 | Réécrire l'épisode 2 → approuver → « recalcule l'état suivant » → demander la revérification de l'épisode 3 si besoin |
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

1. **Fixer la direction.** Il demande le style graphique, le style des bulles et du lettrage, la lecture en défilement vertical ou non, et le nombre de cases.
2. **Dessins de référence.** Il dessine d'abord les références des personnages et des lieux et vous les fait valider. Toutes les scènes suivantes suivent ces dessins.
3. **Adaptation de la scène.** Il fixe la portion de l'original, rédige la mise en scène en anglais et passe la vérification avant génération.
4. **Finition.** Il dessine chaque scène entière en une seule image verticale, dialogues compris, et relit l'image réelle. Les exemples ci-dessus ont été faits ainsi.

La méthode consistant à faire d'abord approuver des crayonnés case par case est deprecated et ne sert qu'à poursuivre les travaux déjà en cours.
</td>
</tr>
</table>

Les images sont dessinées avec la fonction image de l'outil IA ou avec une API d'image. Si une API payante est utilisée, votre accord est demandé d'abord, et l'approbation du roman et celle du webtoon sont distinctes.
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

La langue dans laquelle l'œuvre est écrite se règle avec l'argument facultatif `language` qu'acceptent `lore_profile`, `lore_init`,
`lore_create` et `lore_write`. Quand l'utilisateur indique la langue d'écriture en langage naturel, l'hôte la normalise en étiquette BCP 47
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
- La langue ne peut plus changer une fois la foundation créée. Une valeur différente de la langue enregistrée est refusée avec
  `LANGUAGE_CONTRACT_CONFLICT` au lieu d'être écrasée en silence.
- À chaque épisode, on vérifie que le texte, le résumé et le plan sont écrits dans la langue de l'œuvre, et les invariants sémantiques comme
  le point de vue, l'enregistrement des personnages et le cadre de l'univers sont examinés par le même vérificateur quelle que soit la langue.
- Les webtoons suivent aussi la langue de l'œuvre. Les dialogues ne sont pas traduits : ils entrent dans l'image en texte original dans la langue de l'œuvre,
  et le prompt d'image précise la langue, l'écriture et le sens de lecture (de droite à gauche pour l'arabe).

Les langues vérifiées de bout en bout avec un vrai Claude Sonnet 5, du profil jusqu'à l'approbation de l'épisode 2 et l'audit linguistique final, sont
l'anglais, l'espagnol, le japonais, le français, le coréen, l'arabe, le chinois traditionnel et le thaï. Pour le détail du contrat des
arguments, voir [Langue de l'œuvre et unités de longueur](docs/TOOLS.en.md#work-language-and-length-units).

## Où sont les fichiers

```text
my-novel/
├── world/         cadre de l'univers — vous pouvez le modifier
├── characters/    fiches des personnages — vous pouvez les modifier
├── chapters/      texte — vous pouvez le modifier
├── summaries/     résumés par épisode
├── webtoon/       cadre, adaptations et masters SVG/HTML de webtoon approuvés
└── .vibelore/     journaux de vérification, instantanés de reprise — n'y touchez pas
```

Les manuscrits et les journaux de production restent sur votre ordinateur. Le manuscrit et les images de référence nécessaires à une requête peuvent être envoyés
à l'hôte et au service de modèles connectés. Les limites sont décrites dans le [guide de sécurité](SECURITY.md).
Le droit d'auteur du manuscrit appartient à son auteur, et la licence de ce dépôt ne s'y applique pas.

## Modèles et coûts

- **Le roman** est écrit par le modèle choisi dans la session de l'hôte, tel quel. Pas de clé d'API séparée. On peut utiliser des indications par étape qui confient seulement les étapes de revue à un modèle plus léger ; les étapes qui extraient les faits établis restent sur le modèle de base.
- **Les images du webtoon** nécessitent un outil de l'hôte capable de générer des images ou une API d'image, et la voie API implique sa propre clé et sa propre facturation. Le choix confirmé est enregistré par œuvre et n'est jamais changé d'office.
- **Les modèles de texte locaux** peuvent être branchés par variables d'environnement sur un point de terminaison compatible OpenAI.

Pour la configuration détaillée, voir [Réglages des modèles](docs/MODELS.en.md).

## Questions fréquentes

<details>
<summary>Y a-t-il une interface graphique ?</summary>

Non. Le chat de Claude Code, Codex ou Grok CLI sert d'interface, et les résultats sortent sous forme de fichiers Markdown et de SVG/HTML verticaux.
</details>

<details>
<summary>Est-ce que cela coûte en plus ?</summary>

L'écriture du roman tourne dans le cadre de l'abonnement ou des crédits de l'hôte. vibelore n'appelle aucun modèle directement. Les images du webtoon nécessitent l'outil d'image de l'hôte ou une API d'image, et la voie API suit la facturation de ce compte.
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

Oui. La langue d'écriture se règle dans le profil de l'œuvre, et l'entretien se déroule dans la langue que vous utilisez. Les guides existent en original coréen et en version anglaise (`*.en.md`). Voir [Langue de l'œuvre](#langue-de-lœuvre) plus haut.
</details>

## Pour aller plus loin

Les liens vers la documentation mènent aux versions anglaises. L'original coréen se trouve dans le fichier `.md` du même nom.

- [Guide de démarrage](docs/GETTING_STARTED.en.md) — enregistrement, première œuvre, épisode suivant, en cas de blocage
- [Production de webtoon](docs/WEBTOON.en.md) — direction de l'adaptation, choix obligatoires, production par scène entière et approbation
- [Dépannage et sauvegardes](docs/TROUBLESHOOTING.en.md) — reprise du travail, retouches à la main, retour en arrière, conservation des fichiers
- [Réglages des modèles](docs/MODELS.en.md) — choix des modèles de texte et d'image, voies de coût, modèles locaux
- [Référence des outils](docs/TOOLS.en.md) — le contrat complet des outils appelés par l'hôte
- [Architecture](docs/ARCHITECTURE.en.md) — structure de production du roman et du webtoon, rôles de l'IA et du serveur, limites de stockage
- [Toute la documentation](docs/README.en.md) · [Journaux de vérification par hôte](HOSTS.en.md) · [Contribuer](CONTRIBUTING.md) · [Sécurité](SECURITY.md)

Apache-2.0. Les droits sur les manuscrits et les images appartiennent à ceux qui les ont créés.
