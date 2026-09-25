# vibelore

[한국어](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | 繁體中文 | [ไทย](README.th.md) | [العربية](README.ar.md)

**用 AI 寫網路小說，再把小說做成網漫的本機工具。連載數百話，設定也不會崩壞。**

*Write serial fiction with your AI coding agent, keep the lore consistent for hundreds of chapters, then adapt it into webtoon scenes. Local, Markdown, no extra API keys for writing.*

[![Node](https://img.shields.io/badge/node-22.13%2B%20%7C%2024%20%7C%2026-brightgreen)](docs/GETTING_STARTED.en.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Grok-black)](HOSTS.en.md)
[![Showcase](https://img.shields.io/badge/showcase-3%20works-orange)](https://fbwndrud.github.io/vibelore/showcase/)

把它以 MCP 伺服器的形式接到 Claude Code、Codex、Grok CLI 等 AI 程式設計工具上使用。正文與圖畫由那個 AI 產生，
vibelore 負責記住世界觀、人物、伏筆與時間線，每一話都做檢查，在你核准之前什麼都不會定案。

<table>
<tr>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/executionprincess/"><img src="docs/showcase/executionprincess/img/ep01-s9.webp" width="260" alt="《處刑前一分鐘的皇女》第1話 場景9"></a><br><sub>《處刑前一分鐘的皇女》 · 浪漫奇幻回歸復仇劇</sub></td>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/verdict-live/"><img src="docs/showcase/verdict-live/img/ep01-s6.webp" width="260" alt="《判決 LIVE》第1話 場景6"></a><br><sub>《判決 LIVE》 · 網路公審驚悚劇</sub></td>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/thundertrail/"><img src="docs/showcase/thundertrail/img/ep01-s1.webp" width="260" alt="《路上的閃電》第1話 場景1"></a><br><sub>《路上的閃電》 · 奇幻公路動作</sub></td>
</tr>
</table>

全都是把用 vibelore 寫的小說改編成網漫的實際成果。每部作品由不同的 AI 製作。

- **[處刑前一分鐘的皇女](https://fbwndrud.github.io/vibelore/showcase/executionprincess/)**：從設計、小說到網漫改編，全由 GPT-6 Sol 負責。
- **[判決 LIVE](https://fbwndrud.github.io/vibelore/showcase/verdict-live/)**：小說與網漫改編由 Claude Opus 5.5 負責，圖畫由 Codex 繪製。
- **[路上的閃電](https://fbwndrud.github.io/vibelore/showcase/thundertrail/)**：Codex、Claude、Grok 各自改編了同一部小說。另有[模型比較](https://fbwndrud.github.io/vibelore/showcase/thundertrail/compare.html)。

我們沒有只挑成功的場景。審查沒通過的場景、提示詞，甚至成本，都能在[作品列表](https://fbwndrud.github.io/vibelore/showcase/)中原樣查看。展示作品與網站為韓文。

---

## 如果直接把長篇交給 AI

**❌ 沒有 vibelore**

- 大約從第10話開始，稱呼改變、死去的人物又開口說話、能力規則悄悄變了。
- 第3話埋下的伏筆，AI 和你都忘了。
- 工作階段一中斷，就得從重新貼上「前情提要」開始。
- 要改成網漫時，每次都得從頭說明分格構成、角色外貌與對白位置。

**✅ 有 vibelore**

- 世界、人物與正文以 Markdown 正典保存，每一話的草稿都與正典比對：**hard 違規會修正，soft 違規會詢問你。**
- 依作品整體 → 篇章弧 → 單話的順序規劃，只有你核准的內容才會成為下一話的約束。
- 中斷的工作從原處繼續，只有通過檢查的稿件才會提交，並可逐話回溯。
- 作品語言只用一個 `language` 參數決定，韓語以外的語言也走同樣的流程。
- 附帶網漫製作流程：直接沿用原作的人物與狀態進行改編，決定原作範圍、畫風、參考圖、格數與圖片模型後，把每個場景連同對白生成為一張圖。

## 30 秒示範

在主機的聊天框這樣說就行。

> 寫下一話。寫完給我看，我核准後再定案。

```text
作品訪談 ─▶ 作品設計 ─▶ 篇章弧規劃 ─▶ 單話規劃 ─▶ 初稿 ─▶ 設定・時間線・作品語言檢查 ─▶ 審查 ─▶ 核准 ─▶ 提交
 (1次)       (核准)      (核准)        (自動)              hard 違規會修正               advisory 使用者 Markdown
```

作品設計是生成世界與人物、核准整體故事（StorySpine）、核准作品專屬的作家技能（WriterSkill）的階段，
完成後才開始寫作。作品語言檢查適用於所有作品，包括韓語作品。

稿件與審查依據送到後，回答「核准」或「這部分改一下再來」即可。`auto` 模式在通過必要檢查、且審查
正常完成後會自動提交。審查的 advisory 只記錄、不阻擋提交；審查沒有完成時，會回到等待核准。網漫也只要一句話。

> 把第1話做成網漫。先問我製作方向。

```text
原作範圍・畫風・參考圖・格數・圖片模型 ─▶ 場景演出 ─▶ 生成前驗證 ─▶ 含對白的場景圖 ─▶ 圖片審查
 (使用者選擇)                              (英文)      hard 阻擋     對白為作品語言原文 不合格時自動重新設計
```

格數是整數（1～12）或 `auto`，參考圖由使用者指定自己持有的人物與背景圖片檔。
圖片模型從 OpenAI API 的 `gpt-image-2`、`gpt-image-2.5-sunburst`（預設）、`gpt-image-2.5-flare` 中選擇，
由主機呼叫。生成前驗證或圖片審查不合格時，會根據缺陷重新設計並生成（預設 2 次、最多 3 次，
每次都會產生圖片費用）。結果是場景圖片與 `scene.html`，存放在 `.vibelore/webtoon/candidates/` 之下。

## 安裝

把儲存庫位址交給你使用的 AI 程式設計工具（Claude Code、Codex、Grok CLI）並請它幫忙即可。

> 下載 https://github.com/fbwndrud/vibelore 並註冊為 MCP 伺服器。

只需要 Node.js 22.13 以上（22.x）、24.x 或 26.x。沒有建置，也不必安裝相依套件。
註冊完成後，請重新啟動 AI 工具一次。

<details>
<summary>用 npm 註冊</summary>

不下載儲存庫，改用 npm 套件 [`vibelore`](https://www.npmjs.com/package/vibelore) 執行 MCP 伺服器。

```bash
claude mcp add-json vibelore '{"command":"npx","args":["-y","vibelore"]}' --scope project
```

Codex 為 `command = "npx"`、`args = ["-y", "vibelore"]`，Grok CLI 為 `grok mcp add vibelore -- npx -y vibelore`。
在 Windows 上，請在 `npx` 前加上 `cmd /c`（`"command":"cmd","args":["/c","npx","-y","vibelore"]`）。
若要固定特定版本，請寫成 `vibelore@<版本>`。npm 方式只註冊 MCP 伺服器，因此訪談技能請用
下方的儲存庫方式或 Codex 外掛安裝。
</details>

<details>
<summary>下載儲存庫並自行註冊</summary>

```bash
git clone https://github.com/fbwndrud/vibelore.git
```

Claude Code：

```bash
claude mcp add-json vibelore '{"command":"node","args":["/absolute/path/to/vibelore/src/server.js"]}' --scope project
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.vibelore]
command = "node"
args = ["/absolute/path/to/vibelore/src/server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 6000
```

Grok CLI：

```bash
grok mcp add vibelore -- node /absolute/path/to/vibelore/src/server.js
```

Claude Code 用的寫作迴圈技能在 `hosts/claude/skills/novel/`，作品與網漫訪談技能在 `skills/story-discovery-interview/` 和 `skills/webtoon-discovery-interview/`。請全部複製到 `.claude/skills/` 之下。本儲存庫也可以作為 Codex 外掛（`.codex-plugin/plugin.json`）安裝。
</details>

安裝好後就開始第一部作品吧。用一兩句話說出想寫的故事即可。

> 我想開始寫一部新小說。是一個在深夜公車上聆聽乘客悔恨的司機的故事。先從作品訪談開始。

訪談只會詢問會改變結果的偏好，每次 4～5 個。想跳過就說「不用問，自動決定」
即可。遇到困難時請看[入門指南](docs/GETTING_STARTED.en.md)。

## 它能做什麼

- **作品訪談。** 不問類型名稱，而是詢問節奏、難度、情緒、回報與禁忌，建立閱讀契約（StoryProfile），並自動生成世界觀與人物。
- **篇章弧設計。** 先請你核准以 3～20 話為單位的承諾，以及簡要的事件、壓力與轉折；各話計畫則在寫作時自動補上。
- **每話檢查與修正。** 將草稿與人物、稱呼、視角、時間線、伏筆比對，與既定事實衝突時會自動修正並重新檢查（檢查最多 3 次，其間修正最多 2 次）。文體、節奏等偏好類意見只留作 advisory。
- **文體基準。** 把喜歡的一話指定為文體錨點，之後各話就會依循那種質感。
- **回溯。** 把整部作品回溯到特定一話的時間點，再從下一話重新寫起（回溯前的狀態會保留以便復原）。
- **網漫改編。** 沿用原作狀態，確認原作範圍、畫風、參考圖、格數與圖片模型後，把每個場景連同對白完成為一張圖片。

**不做的事。** 網頁 GUI（主機聊天框就是介面）、由 MCP 伺服器本身呼叫付費 API（圖片 API
由主機執行）、用預設工具重寫前面的話或重新計算之後的狀態（只有 `VIBELORE_MCP_SURFACE=advanced` 的
復原工具 `lore_rewrite`、`lore_refold` 能做到）、文學品質保證、
同時編輯與多租戶、針對平台的 PNG/JPEG 自動切割。

## 常見操作

| 想做的事 | 這樣對主機說 |
|---|---|
| 不滿意最後一話 | 手動修改稿件後說「確認變更」→ 檢查 → 核准 |
| 寫到第3話了，但想從第2話重來 | 「回溯到第1話的時間點」→「寫下一話」 |
| 想全部回到第5話的時間點 | 「回溯到第5話的時間點」 |
| 這一話的文體剛剛好，以後就這樣 | 「把第3話核准為文體基準。理由：對白短而冷淡」 |
| 我手動改了設定檔 | 「確認變更」→ 告訴你影響範圍與下一步 |
| 想看為什麼這樣寫的依據 | 「給我看這一話的審查依據和實際寫作請求」 |
| 想把既有小說做成網漫 | 「把第1話改編成網漫。先問我製作方向」 |
| 想重畫網漫的某個場景 | 「把第1話的這個場景〔這樣〕重畫」 |

修正、繼續與備份請看[疑難排解與備份](docs/TROUBLESHOOTING.en.md)。

## 網漫怎麼做

<table>
<tr>
<td><img src="docs/showcase/thundertrail/img/ep01-s4.webp" width="180" alt="《路上的閃電》第1話 場景4"></td>
<td><img src="docs/showcase/thundertrail/img/ep02-s6.webp" width="180" alt="《路上的閃電》第2話 場景6"></td>
<td valign="top">

把已經寫好的小說原樣做成網漫。人物外貌、世界觀和到那一話為止的情況都從原作沿用，不必重新說明。

1. **原作範圍與方向。** 詢問要改編的話與段落範圍，以及畫風、文字呈現與版面自由度，整理成英文演出指示請你確認。
2. **參考圖。** 由使用者指定人物與背景的參考圖片檔（至少 1 張）。接續的場景也會參考前一個場景的完成圖。
3. **格數與圖片模型。** 選擇格數（1～12 或 auto）以及圖片模型與費用。模型選擇按作品保留。
4. **完成。** 場景演出 → 生成前驗證 → 連同對白的一張場景圖 → 審查實際的圖。不合格時會自動重新設計並重畫（預設 2 次、最多 3 次）。上面的製作範例都是這種方式。

先逐格核准草圖的方式已 deprecated，只用於繼續已在進行中的工作。
</td>
</tr>
</table>

圖畫由主機透過 API 呼叫使用者選擇的 OpenAI 圖片模型（`gpt-image-2`、`gpt-image-2.5-sunburst`（預設）、`gpt-image-2.5-flare`）繪製。需要另外的 API 金鑰與計費；在第一個場景之前會顯示模型、費用與傳送範圍，依使用者的回答按作品確定。網漫結果與小說正本分開儲存，不會改動小說。
詳細步驟請看[網漫製作指南](docs/WEBTOON.en.md)。

## 為什麼是 vibelore

它不是用一堆規則代替你寫小說的工具。它先就閱讀體驗達成共識，保留 AI 的創作能力，
只負責長篇中容易崩壞的記憶、因果、一致性、核准與復原。

- **閱讀契約優先。** 不是類型名稱，而是決定節奏、難度、情緒、回報與禁忌，並在每一話守住這個承諾。
- **因果勝過裝飾。** 與其增加設定，不如讓行動、反應與結果環環相扣；人物靠選擇的累積塑造，而不是靠說明。
- **最終權限在人。** Markdown 稿件就是正典，advisory 不是自動修正的命令。

| 主體 | 負責的事 |
|---|---|
| 使用者 | 想要的閱讀體驗、重要偏好、最終核准 |
| 主機 AI | 判斷構想、構成場景、生成散文・對白・圖畫、語意評論 |
| vibelore | 傳遞正典與計畫、保證順序、衝突檢查、記錄審查依據、提交與復原 |
| Markdown 正典 | 世界、人物、正文、摘要的最終事實 |

整體方向請看[理念](docs/PHILOSOPHY.en.md)，結構請看[架構](docs/ARCHITECTURE.en.md)。

## 支援類型

共有 25 種類型預設，每種預設追蹤的設定項目（時間線、回歸知識、關係狀態、能力
體系等）各不相同。

`回歸獵人` `惡役千金異世界` `學院奇幻` `家門回歸` `流放復仇` `推理驚悚` `動作`
`喜劇` `歷史` `LitRPG` `直播 LitRPG` `成長流` `系統末日` `爬塔` `異世界`
`修煉` `仙俠` `玄幻` `地下城核心` `浪漫奇幻` `SF` `恐怖` `日常療癒` `現代都市` `其他`

列表中沒有的類型或混合類型也可以。訪談會把類型拆解成調性、子類型與故事動力，做成
作品檔案，設定檢查則使用最接近的預設。

## 作品語言

作品用哪種語言寫，由 `lore_profile`、`lore_init`、`lore_create` 接受的 `language` 選用參數決定
（`lore_write` 的 `language` 只確認是否與已儲存的語言一致）。使用者用自然語言說出寫作語言時，主機會將其正規化為 BCP 47
標籤（`ja`、`pt-BR`、`zh-Hant` 等）傳入；沒有選擇語言時就省略此參數。
沒有語言鍵的既有作品視為隱含的 `ko`。對話語言與作品語言彼此獨立，因此可以一邊用韓語
對話，一邊寫日語作品。

> 我想在 `/absolute/path/to/my-novel` 建立一部名為 `harbor_summer` 的作品。正文請用西班牙語寫。

- 提示詞分為兩個系列。`ko` 使用韓語專用的指示，其他語言（包括英語）則使用英文共通
  指示加上目標語言的系列。正文、標題、摘要、世界與人物說明、計畫與審查的
  說明值都依循目標語言，而 JSON 鍵、enum、ID 等機器讀取的值不翻譯。
- 分量以適合該語言的單位計算。韓語沿用既有的字數，其他語言則用字素（grapheme）
  或詞數；阿拉伯語、希伯來語這類結合字元多的文字系統，以及詞與詞之間不空格的泰語，
  都在同一份契約中處理。
- 建立 foundation 之前，可以核准新的檔案 revision 來更改語言；傳入與已核准語言不同的值時，
  以 `LANGUAGE_CONTRACT_CONFLICT` 拒絕。建立 foundation 之後就不能更改，傳入不同的值時
  不會悄悄覆寫，而是以 `WORK_LANGUAGE_IMMUTABLE` 拒絕。
- 每一話都會檢查正文、摘要與計畫是否以作品語言撰寫；視角、人物登錄、世界設定等
  語意不變條件，無論語言為何都由同一個檢查者審視。
- 網漫也依循作品語言。對白不翻譯，以作品語言的原文直接放進圖片，
  圖片提示詞中會明示語言、文字系統與閱讀方向（阿拉伯語為由右至左）。

小說寫作與場景網漫流程已用英語、西班牙語、日語、法語、韓語、阿拉伯語、繁體中文、泰語
8 種語言的驗收樣本確認，該樣本的主機模型為 Claude Sonnet 5。參數契約的
細節請參考[作品語言與分量單位](docs/TOOLS.en.md#work-language-and-length-units)。

## 檔案在哪裡

```text
my-novel/
├── world/         世界設定 — 可以直接修改
├── characters/    人物設定 — 可以直接修改
├── chapters/      正文 — 可以直接修改
├── summaries/     各話摘要
├── webtoon/       deprecated 逐格工作的核准版・SVG/HTML 母版
└── .vibelore/     檢查紀錄・復原快照・網漫場景結果（webtoon/candidates/） — 請勿動它
```

稿件與製作紀錄都留在你的電腦上。請求所需的稿件與參考圖片可能會傳送到連接的主機與模型服務。
界線請看[安全指南](SECURITY.md)。
稿件的著作權屬於作者，本儲存庫的授權不適用於稿件。

## 模型與費用

- **小說**直接由你在主機工作階段中選擇的模型撰寫，不需要另外的 API 金鑰。可以給出把規劃、初稿與審查階段交給較輕量模型的分階段提示（在主機中繼時只是提示，只有本機模型會實際切換）；抽取既定事實的階段若未另外指定，仍維持基準模型。
- **網漫圖片**由主機呼叫 OpenAI 圖片 API（`gpt-image-2`、`gpt-image-2.5-sunburst`（預設）、`gpt-image-2.5-flare`）生成，另有金鑰與計費。確認過的模型按作品儲存，不會擅自更改或替換。
- **本機文字模型**可以透過環境變數連接到相容 OpenAI 的端點。

詳細設定請看[模型設定](docs/MODELS.en.md)。

## 常見問題

<details>
<summary>有 GUI 嗎？</summary>

沒有。Claude Code、Codex、Grok CLI 的聊天框就是介面，結果以 Markdown 稿件產出；網漫則是每個場景一張 PNG/JPEG 圖片（含文字）加上 `scene.html`。
</details>

<details>
<summary>需要另外付費嗎？</summary>

小說寫作在主機的訂閱或點數範圍內運作，預設設定下 vibelore 不會直接呼叫模型（連接本機模型時除外）。網漫圖片由主機呼叫 OpenAI 圖片 API，依該帳號的計費方式收費。
</details>

<details>
<summary>中途停下來就要從頭再來嗎？</summary>

不用。工作流程會被儲存，說「繼續」就能從原處恢復。只有通過檢查的稿件才會提交，也能用各話快照回溯。請看[疑難排解](docs/TROUBLESHOOTING.en.md#work-stopped-midway)。
</details>

<details>
<summary>可以手動修改設定或正文嗎？</summary>

可以。`world/`、`characters/`、`chapters/` 本來就是給人修改的檔案。改完後說「確認變更」，就會告訴你影響範圍與下一步。
</details>

<details>
<summary>檢查器抓到的其實是我刻意安排的反轉怎麼辦？</summary>

hard 違規是與既定事實的衝突，所以會修正；若真的是反轉，先修改設定檔即可。soft 違規可能是作者的意圖，因此 AI 不會自動修正，而是詢問你。
</details>

<details>
<summary>可以用韓語以外的語言寫嗎？</summary>

可以。寫作語言在建立作品時決定（在作品檔案中或透過 `lore_create`、`lore_init`），訪談則以你使用的語言進行。說明文件有韓文原文與英文版（`*.en.md`）。請看上方的[作品語言](#作品語言)。
</details>

## 延伸閱讀

文件連結指向英文版。韓文原文位於同名的 `.md` 檔案。

- [入門指南](docs/GETTING_STARTED.en.md) — 註冊、第一部作品、下一話、卡住時
- [網漫製作](docs/WEBTOON.en.md) — 原作範圍與必選項目、整場景製作與審查
- [疑難排解與備份](docs/TROUBLESHOOTING.en.md) — 恢復工作、手動修改、回溯、保存檔案
- [模型設定](docs/MODELS.en.md) — 文字與圖片模型的選擇、費用路徑、本機模型
- [工具參考](docs/TOOLS.en.md) — 主機呼叫的工具完整契約
- [架構](docs/ARCHITECTURE.en.md) — 小說與網漫的製作結構、AI 與伺服器的角色、儲存界線
- [全部文件](docs/README.en.md) · [各主機驗證紀錄](HOSTS.en.md) · [貢獻](CONTRIBUTING.md) · [安全](SECURITY.md)

Apache-2.0。稿件與圖畫的權利屬於創作者。
