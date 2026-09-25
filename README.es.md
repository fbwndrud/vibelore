# vibelore

[한국어](README.md) | [English](README.en.md) | [日本語](README.ja.md) | Español | [Français](README.fr.md) | [繁體中文](README.zh-Hant.md) | [ไทย](README.th.md) | [العربية](README.ar.md)

**Una herramienta local para escribir novelas web con IA y convertirlas en webtoons. El canon no se derrumba ni después de cientos de capítulos.**

*Write serial fiction with your AI coding agent, keep the lore consistent for hundreds of chapters, then adapt it into a vertical webtoon. Local, Markdown, no extra API keys for writing.*

[![Node](https://img.shields.io/badge/node-22.13%2B%20%7C%2024%20%7C%2026-brightgreen)](docs/GETTING_STARTED.en.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Grok-black)](HOSTS.en.md)
[![Showcase](https://img.shields.io/badge/showcase-3%20works-orange)](https://fbwndrud.github.io/vibelore/showcase/)

Se usa conectándolo como servidor MCP a una herramienta de programación con IA como Claude Code, Codex o Grok CLI. Esa IA escribe el texto y dibuja las imágenes;
vibelore recuerda el mundo, los personajes, los presagios y la línea temporal, revisa cada capítulo y no da nada por definitivo antes de tu aprobación.

<table>
<tr>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/executionprincess/"><img src="docs/showcase/executionprincess/img/ep01-s9.webp" width="260" alt="La princesa un minuto antes de su ejecución, capítulo 1, escena 9"></a><br><sub><i>La princesa un minuto antes de su ejecución</i> · fantasía romántica de regresión y venganza</sub></td>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/verdict-live/"><img src="docs/showcase/verdict-live/img/ep01-s6.webp" width="260" alt="Veredicto LIVE, capítulo 1, escena 6"></a><br><sub><i>Veredicto LIVE</i> · thriller de ciberacoso mediático</sub></td>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/thundertrail/"><img src="docs/showcase/thundertrail/img/ep01-s1.webp" width="260" alt="Relámpago en el camino, capítulo 1, escena 1"></a><br><sub><i>Relámpago en el camino</i> · acción fantástica de carretera</sub></td>
</tr>
</table>

Todos son resultados reales de adaptar a webtoon novelas escritas con vibelore. Cada obra la hizo una IA distinta.

- **[La princesa un minuto antes de su ejecución](https://fbwndrud.github.io/vibelore/showcase/executionprincess/)**: GPT-6 Sol se encargó de todo, desde el diseño hasta la novela y la adaptación a webtoon.
- **[Veredicto LIVE](https://fbwndrud.github.io/vibelore/showcase/verdict-live/)**: Claude Opus 5.5 escribió la novela y la adaptación a webtoon, y Codex dibujó las imágenes.
- **[Relámpago en el camino](https://fbwndrud.github.io/vibelore/showcase/thundertrail/)**: Codex, Claude y Grok adaptaron cada uno la misma novela. También hay una [comparación de modelos](https://fbwndrud.github.io/vibelore/showcase/thundertrail/compare.html).

No elegimos solo las escenas que salieron bien. Las escenas que no pasaron la revisión, los prompts y hasta los costes se pueden ver tal cual en la [lista de obras](https://fbwndrud.github.io/vibelore/showcase/). Las obras y el sitio de la muestra están en coreano.

---

## Si le entregas una novela larga a una IA sin más

**❌ Sin vibelore**

- Hacia el capítulo 10 cambian las formas de tratamiento, los personajes muertos vuelven a hablar y las reglas de los poderes cambian sin avisar.
- Tanto la IA como tú olvidáis el presagio sembrado en el capítulo 3.
- Cuando se corta la sesión, empiezas pegando otra vez «el resumen hasta ahora».
- Para convertirla en webtoon, explicas desde cero cada vez la composición de viñetas, el aspecto de los personajes y la colocación de los diálogos.

**✅ Con vibelore**

- El mundo, los personajes y el texto quedan como canon en Markdown, y el borrador de cada capítulo se contrasta con ese canon: **las violaciones hard se corrigen y las soft se consultan.**
- Se planifica en el orden obra completa → arco → capítulo, y solo lo que apruebas se convierte en restricción para el siguiente capítulo.
- El trabajo interrumpido se reanuda en el mismo punto, solo se confirman los manuscritos que pasan las comprobaciones y puedes volver atrás capítulo a capítulo.
- El idioma de la obra se fija con un único argumento `language`, y los idiomas distintos del coreano usan el mismo flujo.
- Incluye un flujo de producción de webtoon que toma tal cual los personajes y el estado del original, confirma la dirección y genera cada escena en una sola imagen, diálogos incluidos.

## Demo de 30 segundos

Basta con decir esto en el chat del host.

> Escribe el siguiente capítulo. Enséñamelo cuando termines y confírmalo cuando lo apruebe.

```text
Entrevista ─▶ Plan de arco ─▶ Plan de capítulo ─▶ Borrador ─▶ Comprobación de ambientación/cronología ─▶ Revisión ─▶ Aprobación ─▶ Commit
  (1 vez)      (aprobar)        (automático)                  violaciones hard corregidas           advisory     usuario       Markdown
```

Cuando lleguen el manuscrito y la evidencia de la revisión, responde «aprobar» o «corrige esta parte y vuelve a intentarlo». El modo `auto` confirma
automáticamente si pasa las comprobaciones y la revisión. Para un webtoon también basta una frase.

> Convierte el capítulo 1 en webtoon. Pregúntame primero por la dirección de producción.

```text
Dirección ─▶ Dirección en inglés ─▶ Verificación previa ─▶ Imagen de escena con diálogo ─▶ Revisión visual real
(aprobar)    por escena (auto)       bloqueo hard           la genera el host                 resultado final
```

## Instalación

Dale la dirección del repositorio a la herramienta de programación con IA que uses (Claude Code, Codex, Grok CLI) y pídeselo.

> Descarga https://github.com/fbwndrud/vibelore y regístralo como servidor MCP.

Solo necesitas Node.js 22.13 o posterior (22.x), 24.x o 26.x. No hay compilación ni instalación de dependencias.
Cuando termine el registro, reinicia una vez la herramienta de IA.

<details>
<summary>Para registrarlo con npm</summary>

Ejecuta el servidor MCP desde el paquete npm [`vibelore`](https://www.npmjs.com/package/vibelore) sin descargar el repositorio.

```bash
claude mcp add-json vibelore '{"command":"npx","args":["-y","vibelore"]}' --scope project
```

En Codex es `command = "npx"`, `args = ["-y", "vibelore"]`; en Grok CLI, `grok mcp add vibelore -- npx -y vibelore`.
En Windows, pon `cmd /c` delante de `npx` (`"command":"cmd","args":["/c","npx","-y","vibelore"]`).
Para fijar una versión concreta, escribe `vibelore@<versión>`. La vía npm registra solo el servidor MCP, así que las skills de entrevista
se instalan con el método del repositorio de abajo o con el plugin de Codex.
</details>

<details>
<summary>Para descargar el repositorio y registrarlo tú mismo</summary>

```bash
git clone https://github.com/fbwndrud/vibelore.git
```

Claude Code:

```bash
claude mcp add-json vibelore '{"command":"node","args":["/absolute/path/to/vibelore/src/server.js"]}' --scope project
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.vibelore]
command = "node"
args = ["/absolute/path/to/vibelore/src/server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 6000
```

Grok CLI:

```bash
grok mcp add vibelore -- node /absolute/path/to/vibelore/src/server.js
```

La skill para Claude Code está en `hosts/claude/skills/`, y este repositorio también se puede instalar como plugin de Codex (`.codex-plugin/plugin.json`).
</details>

Una vez instalado, empieza tu primera obra. Basta con contar en una o dos frases la historia que quieres escribir.

> Quiero empezar una novela nueva. Es la historia de un conductor de autobús nocturno que escucha los remordimientos de sus pasajeros. Empieza por la entrevista de la obra.

La entrevista solo pregunta por las preferencias que cambian el resultado, 4 o 5 cada vez. Para saltarla, di «decide automáticamente
sin preguntar». Si te atascas, consulta la [guía de inicio](docs/GETTING_STARTED.en.md).

## Qué hace

- **Entrevista de la obra.** En lugar de un nombre de género, pregunta por el ritmo, la dificultad, la emoción, la recompensa y los tabúes para crear un contrato de lectura (StoryProfile), y genera automáticamente el mundo y los personajes.
- **Diseño de arcos.** Primero obtiene tu aprobación para una promesa de 3 a 20 capítulos con sucesos, presiones y giros esbozados, y rellena automáticamente los planes por capítulo al escribir.
- **Comprobación y corrección en cada capítulo.** Contrasta el borrador con los personajes, las formas de tratamiento, el punto de vista, la cronología y los presagios, y corrige automáticamente hasta 3 veces si choca con hechos establecidos. Las observaciones de gusto, como el estilo o el ritmo, quedan solo como advisory.
- **Referencia de estilo.** Si marcas como ancla de estilo un capítulo que te guste, los siguientes siguen su textura.
- **Reescritura y vuelta atrás.** Reescribe un capítulo anterior sin tocar la ambientación, o devuelve toda la obra al punto de un capítulo concreto.
- **Adaptación a webtoon.** Toma el estado del original, confirma la dirección de la adaptación, el estilo de dibujo y el número de viñetas, y termina cada escena como una sola imagen vertical, diálogos incluidos.

**Lo que no hace.** Una GUI web (el chat del host es la interfaz), llamadas a API de pago desde el propio servidor MCP (las API de imagen
las ejecuta el host), recomprobación automática de los capítulos posteriores (si corriges el capítulo 2, pide tú la recomprobación del 3), garantías de calidad literaria,
edición simultánea o multiinquilino, ni división automática en PNG/JPEG para plataformas.

## Tareas habituales

| Lo que quieres | Dile esto al host |
|---|---|
| No me gusta el capítulo 1; rehacerlo sin tocar la ambientación | «Reescribe el capítulo 1 [en esta dirección]» → comprobación → aprobación |
| Escribí hasta el capítulo 3 pero quiero corregir el 2 | Reescribir el capítulo 2 → aprobar → «recalcula el estado posterior» → pedir la recomprobación del capítulo 3 si hace falta |
| Quiero volver todo al punto del capítulo 5 | «Vuelve atrás hasta el capítulo 5» |
| El estilo de este capítulo es justo el que quiero | «Aprueba el capítulo 3 como referencia de estilo. Motivo: los diálogos son cortos y secos» |
| He editado a mano un archivo de ambientación | «Revisa los cambios» → te indica el alcance del impacto y el siguiente paso |
| Quiero ver por qué se escribió así | «Enséñame la evidencia de revisión y la petición de escritura real de este capítulo» |
| Quiero convertir una novela existente en webtoon | «Adapta el capítulo 1 a webtoon. Pregúntame primero por la dirección de producción» |
| Quiero redibujar una escena del webtoon | «Redibuja esta escena del capítulo 1 [así]» |

Para correcciones, reanudación y copias de seguridad, consulta [Solución de problemas y copias de seguridad](docs/TROUBLESHOOTING.en.md).

## Cómo se hace un webtoon

<table>
<tr>
<td><img src="docs/showcase/thundertrail/img/ep01-s4.webp" width="180" alt="Relámpago en el camino, capítulo 1, escena 4"></td>
<td><img src="docs/showcase/thundertrail/img/ep02-s6.webp" width="180" alt="Relámpago en el camino, capítulo 2, escena 6"></td>
<td valign="top">

Convierte tal cual en webtoon una novela que ya escribiste. El aspecto de los personajes, el mundo y la situación hasta ese capítulo se toman del original, así que no hace falta volver a explicarlos.

1. **Fijar la dirección.** Pregunta por el estilo de dibujo, el estilo de bocadillos y rotulación, si se lee en scroll vertical y el número de viñetas.
2. **Arte de referencia.** Primero dibuja el arte de referencia de personajes y lugares y te pide confirmación. Todas las escenas posteriores siguen ese arte.
3. **Adaptación de la escena.** Fija el rango del original, redacta la dirección en inglés y pasa la verificación previa a la generación.
4. **Final.** Dibuja cada escena completa como una sola imagen vertical, diálogos incluidos, y revisa la imagen real. Los ejemplos de arriba se hicieron así.

El método de aprobar primero bocetos por viñeta está deprecated y solo continúa trabajos ya en curso.
</td>
</tr>
</table>

Las imágenes se dibujan con la función de imagen de la herramienta de IA o con una API de imagen. Si se usa una API de pago, primero se te consulta, y la aprobación de la novela y la del webtoon son independientes.
Para los pasos detallados, consulta la [guía de producción de webtoon](docs/WEBTOON.en.md).

## Por qué vibelore

No es una herramienta que escriba la novela por ti a partir de un conjunto de reglas. Primero acuerda la experiencia de lectura, aprovecha la capacidad creativa de la IA
y se responsabiliza solo de la memoria, la causalidad, la coherencia, la aprobación y la recuperación, que son lo que suele romperse en una obra larga.

- **Primero el contrato de lectura.** No un nombre de género, sino ritmo, dificultad, emoción, recompensa y tabúes, y esa promesa se cumple en cada capítulo.
- **La causalidad gana a la decoración.** En lugar de añadir ambientación, hace que acciones, reacciones y consecuencias se encadenen, y construye los personajes por acumulación de decisiones, no por explicación.
- **La última palabra es de la persona.** El manuscrito en Markdown es el canon, y un advisory no es una orden de corrección automática.

| Parte | Se encarga de |
|---|---|
| Usuario | La experiencia de lectura que quiere, las preferencias importantes, la aprobación final |
| IA host | Juzgar ideas, construir escenas, generar prosa, diálogos e imágenes, crítica semántica |
| vibelore | Pasar el canon y los planes, garantizar el orden, comprobar conflictos, registrar la evidencia de revisión, commit y recuperación |
| Canon en Markdown | Los hechos finales del mundo, los personajes, el texto y los resúmenes |

Para la dirección general, consulta la [filosofía](docs/PHILOSOPHY.en.md); para la estructura, la [arquitectura](docs/ARCHITECTURE.en.md).

## Géneros compatibles

Hay 25 presets de género, y cada uno sigue elementos de ambientación distintos (cronología, conocimiento de la regresión, estado de las relaciones, sistema
de poderes, etc.).

`Cazador regresor` `Villana isekai` `Fantasía de academia` `Regresión de casa noble` `Venganza del desterrado` `Thriller de misterio` `Acción`
`Comedia` `Histórico` `LitRPG` `LitRPG de streaming` `Progresión` `Apocalipsis de sistema` `Ascenso de la torre` `Isekai`
`Cultivo` `Xianxia` `Xuanhuan` `Núcleo de mazmorra` `Fantasía romántica` `Ciencia ficción` `Terror` `Vida cotidiana reconfortante` `Urbano contemporáneo` `Otros`

También funcionan géneros que no están en la lista y géneros mixtos. La entrevista descompone el género en tono, subgénero y motor narrativo para crear
el perfil de la obra, y la comprobación de ambientación usa el preset más cercano.

## Idioma de la obra

El idioma en que se escribe la obra se fija con el argumento opcional `language` que aceptan `lore_profile`, `lore_init`,
`lore_create` y `lore_write`. Cuando el usuario indica el idioma de escritura en lenguaje natural, el host lo normaliza a una etiqueta BCP 47
(`ja`, `pt-BR`, `zh-Hant`, etc.) y la pasa; si no se elige idioma, se omite el argumento.
Las obras existentes sin clave de idioma son un `ko` implícito. El idioma de la conversación y el de la obra son independientes, así que puedes
escribir una obra en japonés mientras conversas en coreano.

> Quiero crear una obra llamada `harbor_summer` en `/absolute/path/to/my-novel`. Escribe el texto en español.

- Hay dos familias de prompts. `ko` usa instrucciones específicas para coreano, y el resto de idiomas (inglés incluido) usa una familia que
  combina las instrucciones comunes en inglés con el idioma objetivo. El texto, los títulos, los resúmenes, las descripciones del mundo y de los personajes y los valores
  descriptivos de planes y revisiones siguen el idioma objetivo, mientras que los valores que lee la máquina, como claves JSON, enums e ID, no se traducen.
- La extensión se mide en una unidad adecuada al idioma. El coreano usa el recuento de caracteres de siempre; los demás idiomas, grafemas
  o palabras, y los sistemas de escritura con muchos caracteres combinantes, como el árabe y el hebreo, o el tailandés, que no separa las palabras con espacios,
  se tratan dentro del mismo contrato.
- El idioma no se puede cambiar después de crear la foundation. Pasar un valor distinto del idioma guardado se rechaza con
  `LANGUAGE_CONTRACT_CONFLICT` en lugar de sobrescribirlo en silencio.
- En cada capítulo se comprueba que el texto, el resumen y el plan estén escritos en el idioma de la obra, y los invariantes semánticos como
  el punto de vista, el registro de personajes y la ambientación del mundo la examina el mismo revisor sea cual sea el idioma.
- Los webtoons también siguen el idioma de la obra. Los diálogos no se traducen: entran en la imagen como texto original en el idioma de la obra,
  y el prompt de imagen indica el idioma, la escritura y la dirección de lectura (de derecha a izquierda en árabe).

Los idiomas verificados de principio a fin con un Claude Sonnet 5 real, desde el perfil hasta la aprobación del capítulo 2 y la auditoría final de idioma, son
inglés, español, japonés, francés, coreano, árabe, chino tradicional y tailandés. Para los detalles del contrato de
argumentos, consulta [Idioma de la obra y unidades de extensión](docs/TOOLS.en.md#work-language-and-length-units).

## Dónde están los archivos

```text
my-novel/
├── world/         ambientación del mundo — puedes editarla
├── characters/    fichas de personajes — puedes editarlas
├── chapters/      texto — puedes editarlo
├── summaries/     resúmenes por capítulo
├── webtoon/       ambientación, adaptaciones y másteres SVG/HTML de webtoon aprobados
└── .vibelore/     registros de comprobación, instantáneas de recuperación — no los toques
```

Los manuscritos y los registros de producción se quedan en tu ordenador. Al host y al servicio de modelos conectados se les pueden enviar el manuscrito y las
imágenes de referencia que necesite una petición. Los límites están en la [guía de seguridad](SECURITY.md).
Los derechos de autor del manuscrito pertenecen a su autor, y la licencia de este repositorio no se le aplica.

## Modelos y costes

- **La novela** la escribe tal cual el modelo que elegiste en la sesión del host. No hay una clave de API aparte. Puedes usar indicaciones por etapa que asignan solo las etapas de revisión a un modelo más ligero; las etapas que extraen hechos establecidos se quedan con el modelo base.
- **Las imágenes del webtoon** necesitan una herramienta del host capaz de generarlas o una API de imagen, y la vía API tiene su propia clave y facturación. La elección confirmada se guarda por obra y no se cambia por cuenta propia.
- **Los modelos de texto locales** se pueden conectar mediante variables de entorno a un endpoint compatible con OpenAI.

Para la configuración detallada, consulta [Configuración de modelos](docs/MODELS.en.md).

## Preguntas frecuentes

<details>
<summary>¿Tiene GUI?</summary>

No. El chat de Claude Code, Codex o Grok CLI es la interfaz, y los resultados salen como archivos Markdown y SVG/HTML verticales.
</details>

<details>
<summary>¿Cuesta dinero aparte?</summary>

La escritura de la novela funciona dentro de la suscripción o los créditos del host. vibelore no llama directamente a ningún modelo. Las imágenes del webtoon necesitan la herramienta de imagen del host o una API de imagen, y la vía API sigue la facturación de esa cuenta.
</details>

<details>
<summary>Si se detiene a medias, ¿tengo que empezar de nuevo?</summary>

No. Los flujos de trabajo se guardan, así que con «continúa» se reanuda en el mismo punto. Solo se confirman los manuscritos que pasan las comprobaciones, y las instantáneas por capítulo permiten volver atrás. Consulta [Solución de problemas](docs/TROUBLESHOOTING.en.md#work-stopped-midway).
</details>

<details>
<summary>¿Puedo editar a mano la ambientación o el texto?</summary>

Sí. `world/`, `characters/` y `chapters/` están para que las personas los editen. Después de editar, di «revisa los cambios» y te indicará el alcance del impacto y el siguiente paso.
</details>

<details>
<summary>¿Y si lo que detectó el revisor es en realidad un giro que yo quería?</summary>

Una violación hard es un choque con hechos establecidos, así que se corrige; si de verdad es un giro, cambia primero el archivo de ambientación. Una violación soft puede ser intención del autor, así que la IA no la corrige automáticamente y te pregunta.
</details>

<details>
<summary>¿Puedo escribir en idiomas distintos del coreano?</summary>

Sí. El idioma de escritura se fija en el perfil de la obra, y la entrevista se hace en el idioma que uses. Las guías tienen el original en coreano y versiones en inglés (`*.en.md`). Consulta [Idioma de la obra](#idioma-de-la-obra) más arriba.
</details>

## Más lecturas

Los enlaces a la documentación llevan a las versiones en inglés. El original en coreano está en el archivo `.md` del mismo nombre.

- [Guía de inicio](docs/GETTING_STARTED.en.md) — registro, primera obra, siguiente capítulo, cuando te atascas
- [Producción de webtoon](docs/WEBTOON.en.md) — dirección de la adaptación, elecciones obligatorias, producción por escena completa y aprobación
- [Solución de problemas y copias de seguridad](docs/TROUBLESHOOTING.en.md) — reanudar el trabajo, ediciones a mano, vuelta atrás, conservar archivos
- [Configuración de modelos](docs/MODELS.en.md) — elección de modelos de texto e imagen, vías de coste, modelos locales
- [Referencia de herramientas](docs/TOOLS.en.md) — el contrato completo de las herramientas que llama el host
- [Arquitectura](docs/ARCHITECTURE.en.md) — estructura de producción de novela y webtoon, papel de la IA y del servidor, límites de almacenamiento
- [Toda la documentación](docs/README.en.md) · [Registros de verificación por host](HOSTS.en.md) · [Contribuir](CONTRIBUTING.md) · [Seguridad](SECURITY.md)

Apache-2.0. Los derechos de los manuscritos y las imágenes pertenecen a quienes los crearon.
