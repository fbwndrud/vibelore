# vibelore

[한국어](../../README.md) | [English](README.en.md) | 日本語 | [Español](README.es.md) | [Français](README.fr.md) | [繁體中文](README.zh-Hant.md) | [ไทย](README.th.md) | [العربية](README.ar.md)

**AIでWeb小説を書き、その小説をウェブトゥーンにするローカルツール。数百話を重ねても設定は崩れません。**

*Write serial fiction with your AI coding agent, keep the lore consistent for hundreds of chapters, then adapt it into webtoon scenes. Local, Markdown, no extra API keys for writing.*

[![Node](https://img.shields.io/badge/node-22.13%2B%20%7C%2024%20%7C%2026-brightgreen)](../GETTING_STARTED.en.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](../../LICENSE)
[![Hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Grok-black)](../../HOSTS.en.md)
[![Showcase](https://img.shields.io/badge/showcase-6%20works-orange)](https://fbwndrud.github.io/vibelore/showcase/)

Claude Code、Codex、Grok CLI などの AI コーディングツールに MCP サーバーとしてつないで使います。本文と絵はその AI が作り、
vibelore は世界観・人物・伏線・時系列を記憶し、毎話チェックし、承認されるまでは何も確定しません。

<table>
<tr>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/vesper/"><img src="https://fbwndrud.github.io/vibelore-showcase-media/vesper/img/ep01-s6.webp" width="200" alt="『ベスパー』第1話 シーン6"></a><br><sub>『ベスパー』 · 人外ロマンティックコメディ</sub></td>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/executionprincess/"><img src="https://fbwndrud.github.io/vibelore-showcase-media/executionprincess/img/ep01-s9.webp" width="200" alt="『処刑1分前の皇女』第1話 シーン9"></a><br><sub>『処刑1分前の皇女』 · ロマンスファンタジー回帰復讐劇</sub></td>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/verdict-live/"><img src="https://fbwndrud.github.io/vibelore-showcase-media/verdict-live/img/ep01-s6.webp" width="200" alt="『判決LIVE』第1話 シーン6"></a><br><sub>『判決LIVE』 · サイバーレッカー・スリラー</sub></td>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/thundertrail/"><img src="https://fbwndrud.github.io/vibelore-showcase-media/thundertrail/img/ep01-s1.webp" width="200" alt="『道の上の稲妻』第1話 シーン1"></a><br><sub>『道の上の稲妻』 · ファンタジー・ロードアクション</sub></td>
</tr>
</table>

どれも vibelore で書いた小説をウェブトゥーンにした実際の結果です。作品ごとに別の AI が作り、作ったときの vibelore バージョンも記しました。

- **[ベスパー](https://fbwndrud.github.io/vibelore/showcase/vesper/)** (vibelore 0.4.2, 最新)：ロッテワールドの夜のパレードのキャラクターを借りた非公式の二次創作です。全50話完結の小説から第1〜3話のウェブトゥーンまで Claude Opus 5.5 が担当しました。第2話はベスパーの灯りがコマ枠の色と明るさを決める演出実験、第3話はイヤホンの無線をフキダシではなくコマ間のミント色の帯で見せる演出実験です。
- **[処刑1分前の皇女](https://fbwndrud.github.io/vibelore/showcase/executionprincess/)** (vibelore 0.3.8)：設計から小説、ウェブトゥーン化まで GPT-6 Sol が担当しました。
- **[判決LIVE](https://fbwndrud.github.io/vibelore/showcase/verdict-live/)** (vibelore 0.3.7–0.3.8)：小説とウェブトゥーン化は Claude Opus 5.5、絵は Codex (OpenAI API `gpt-image-2.5-sunburst`) が担当しました。
- **[道の上の稲妻](https://fbwndrud.github.io/vibelore/showcase/thundertrail/)** (vibelore 0.3.0–0.3.8)：Codex・Claude・Grok が同じ小説をそれぞれ脚色しました。[モデル比較](https://fbwndrud.github.io/vibelore/showcase/thundertrail/compare.html)もあります。

うまくいったシーンだけを選んだわけではありません。レビューで落ちたシーン、プロンプト、コストまで[作品一覧](https://fbwndrud.github.io/vibelore/showcase/)でそのまま見られます。ショーケースの作品とサイトは韓国語です。

---

## AI に長編をそのまま任せると

**❌ vibelore なし**

- 10話あたりから呼び方が変わり、死んだ人物がまた話し、能力のルールがこっそり変わります。
- 3話で仕込んだ伏線を AI も自分も忘れます。
- セッションが切れると「これまでのあらすじ」を貼り直すところから始まります。
- ウェブトゥーンにするには、コマ構成・キャラクターの外見・セリフの配置を毎回一から説明します。

**✅ vibelore と一緒なら**

- 世界・人物・本文は Markdown の正本として残り、毎話の草稿をその正本と照合して **hard 違反は直し、soft 違反は確認します。**
- 作品全体 → アーク → 話の順に計画し、承認したものだけが次の話の制約になります。
- 中断した作業は同じ場所から再開し、チェックを通った原稿だけがコミットされ、話単位で巻き戻せます。
- 作品の言語は `language` 引数ひとつで決め、韓国語以外の言語でも同じ流れを使います。
- 原作の人物と状態をそのまま引き継いで脚色し、原作の範囲・画風・参照画・コマ数・画像モデルを決めたあとシーンをセリフまで一枚の画像で生成するウェブトゥーン制作フローが付いてきます。

## 30秒デモ

ホストのチャット欄にこう言うだけです。

> 次の話を書いて。書き終えたら見せて、私が承認したら確定して。

```text
作品インタビュー ─▶ 作品設計 ─▶ アーク計画 ─▶ 話の計画 ─▶ 草稿 ─▶ 設定・時系列・作品言語チェック ─▶ レビュー ─▶ 承認 ─▶ コミット
 (1回)               (承認)      (承認)        (自動)              hard 違反は修正                   advisory    ユーザー Markdown
```

作品設計は、世界・人物の生成、物語全体（StorySpine）の承認、作品ごとの作家スキル（WriterSkill）の承認の
段階で、これが終わってから執筆が始まります。作品言語のチェックは韓国語の作品を含むすべての作品に適用されます。

原稿とレビューの根拠が届いたら「承認」または「この部分を直してもう一度」と答えます。`auto` モードは必須チェックを
通り、レビューが正常に完了すれば自動でコミットします。レビューの advisory は記録するだけでコミットを止めず、
レビューが終わらなければ承認待ちに戻ります。ウェブトゥーンも一文で足ります。

> 第1話をウェブトゥーンにして。制作の方向性から聞いて。

```text
原作範囲・画風・参照・コマ数・画像モデル ─▶ シーン演出 ─▶ 生成前検証 ─▶ セリフ入りシーン画像 ─▶ 画像レビュー
 (ユーザーが選ぶ)                            (英語)        hard 遮断     セリフは作品言語の原文  不合格なら自動で再設計
```

コマ数は整数（1〜12）か `auto` で、参照画はユーザーが持っている人物・背景の画像ファイルを指定します。
絵は、ホストの内蔵画像ツール（Codex `image_gen` など）か画像 API（OpenAI `gpt-image-2.5-sunburst` など）のうち、
ユーザーが選んだ経路で描きます。生成前検証か画像レビューで不合格になると、欠陥を根拠に設計し直して
生成します（既定2回、最大3回、そのたびに新しい画像呼び出し）。結果はシーン画像と `scene.html` として
`.vibelore/webtoon/candidates/` の下に残ります。

## インストール

使っている AI コーディングツール（Claude Code、Codex、Grok CLI）にリポジトリのアドレスを渡して頼むだけです。

> https://github.com/fbwndrud/vibelore を取得して MCP サーバーとして登録して。

必要なのは Node.js 22.13 以上（22.x）、24.x または 26.x だけです。ビルドも依存関係のインストールもありません。
登録が終わったら AI ツールを一度再起動してください。

<details>
<summary>npm で登録するには</summary>

リポジトリを取得せず、npm パッケージ [`vibelore`](https://www.npmjs.com/package/vibelore) で MCP サーバーを実行します。

```bash
claude mcp add-json vibelore '{"command":"npx","args":["-y","vibelore"]}' --scope project
```

Codex は `command = "npx"`、`args = ["-y", "vibelore"]`、Grok CLI は `grok mcp add vibelore -- npx -y vibelore` です。
Windows では `npx` の前に `cmd /c` を付けます（`"command":"cmd","args":["/c","npx","-y","vibelore"]`）。
特定のバージョンに固定するには `vibelore@<バージョン>` のように書きます。npm の方法は MCP サーバーだけを登録するので、インタビュースキルは
下のリポジトリ方式か Codex プラグインでインストールします。
</details>

<details>
<summary>リポジトリを取得して直接登録するには</summary>

```bash
git clone https://github.com/fbwndrud/vibelore.git
```

Claude Code:

```bash
claude mcp add-json vibelore '{"command":"node","args":["/absolute/path/to/vibelore/src/server.js"]}' --scope project
```

Codex（`~/.codex/config.toml`）:

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

Claude Code 用の執筆ループのスキルは `hosts/claude/skills/novel/`、作品・ウェブトゥーンのインタビュースキルは `skills/story-discovery-interview/` と `skills/webtoon-discovery-interview/` にあります。すべて `.claude/skills/` の下にコピーしてください。このリポジトリは Codex プラグイン（`.codex-plugin/plugin.json`）としてもインストールできます。
</details>

インストールしたら最初の作品を始めてみましょう。書きたい物語を一、二文で伝えれば十分です。

> 新しい小説を始めたい。深夜バスで乗客の後悔を聞く運転手の話だよ。作品インタビューから始めて。

インタビューは結果を変える好みだけを一度に4〜5個ずつ尋ねます。飛ばしたいときは「聞かずに自動で」と
言えば大丈夫です。行き詰まったら[スタートガイド](../GETTING_STARTED.en.md)を見てください。

## 何をしてくれるか

- **作品インタビュー。** ジャンル名の代わりに速度・難度・情緒・報酬・タブーを尋ねて読書契約（StoryProfile）を作り、世界観と人物を自動生成します。
- **アーク設計。** 3〜20話単位の約束と薄い出来事・圧力・転換を先に承認してもらい、話ごとの計画は執筆時に自動で埋めます。
- **毎話のチェックと修正。** 草稿を人物・呼び方・視点・時系列・伏線と照合し、確定した事実と衝突すれば自動で直して再チェックします（チェックは最大3回、その間の修正は最大2回）。文体やリズムのような好みの指摘は advisory としてだけ残します。
- **文体の基準。** 気に入った話を文体アンカーに指定すると、以降の話がその質感に沿います。
- **巻き戻し。** 特定の話の時点まで作品全体をロールバックし、その次の話から書き直します（ロールバック前の状態は復元できるよう保管）。
- **ウェブトゥーン化。** 原作の状態を引き継ぎ、原作の範囲・画風・参照画・コマ数・画像モデルを確認したうえで、シーンをセリフまで一枚の画像に仕上げます。

**しないこと。** Web GUI（ホストのチャット欄がインターフェース）、MCP サーバー自体による有料 API 呼び出し（絵は
ホストが描く）、既定のツールでの前の話の書き直し・以降の状態の再計算（`VIBELORE_MCP_SURFACE=advanced` の
復旧ツール `lore_rewrite`・`lore_refold` でのみ可能）、文学的品質の保証、
同時編集・マルチテナント、プラットフォーム向け PNG/JPEG の自動分割。

## よくある作業

| やりたいこと | ホストにこう言う |
|---|---|
| 最後の話が気に入らない | 原稿を手で直してから「変更点を確認して」→ チェック → 承認 |
| 3話まで書いたが2話からやり直したい | 「1話の時点までロールバックして」→「次の話を書いて」 |
| 5話の時点まで全部戻したい | 「5話の時点までロールバックして」 |
| この話の文体がぴったり、今後もこうしたい | 「3話を文体の基準として承認して。理由：セリフが短く乾いているから」 |
| 設定ファイルを手で直した | 「変更点を確認して」→ 影響範囲と次にやることを教えてくれる |
| なぜこう書いたのか根拠を見たい | 「今回の話のレビュー根拠と実際の執筆リクエストを見せて」 |
| 既存の小説をウェブトゥーンにしたい | 「1話をウェブトゥーンに脚色して。制作の方向性から聞いて」 |
| ウェブトゥーンのシーンを描き直したい | 「1話のこのシーンを［こう］描き直して」 |

修正・再開・バックアップは[トラブルシューティングとバックアップ](../TROUBLESHOOTING.en.md)を見てください。

## ウェブトゥーンはどう作るか

<table>
<tr>
<td><img src="https://fbwndrud.github.io/vibelore-showcase-media/thundertrail/img/ep01-s4.webp" width="180" alt="『道の上の稲妻』第1話 シーン4"></td>
<td><img src="https://fbwndrud.github.io/vibelore-showcase-media/thundertrail/img/ep02-s6.webp" width="180" alt="『道の上の稲妻』第2話 シーン6"></td>
<td valign="top">

すでに書いた小説をそのままウェブトゥーンにします。人物の外見、世界観、その話までの状況は原作から引き継ぐので、説明し直す必要はありません。

1. **原作の範囲と方向。** 移す話・段落の範囲と、画風・文字の表現・配置の裁量を尋ね、英語の演出指示にまとめて確認してもらいます。
2. **参照画。** 人物・背景の参照画像ファイル（1枚以上）をユーザーが指定します。続くシーンは前のシーンの完成画も参照します。
3. **コマ数と描画経路。** コマ数（1〜12 または auto）を選び、ホストが実際に使える描画経路（内蔵ツール、API）とモデル・費用を見て選びます。選択は作品ごとに保たれます。
4. **完成。** シーン演出 → 生成前検証 → セリフまで入った一枚のシーン画像 → 実際の絵のレビュー。不合格なら自動で設計し直して描きます（既定2回、最大3回）。上の制作例はこの方式です。

コマごとにラフを先に承認してもらう方式は deprecated で、すでに進行中の作業だけを続けます。
</td>
</tr>
</table>

絵は、ユーザーが選んだ経路でホストが描きます。最初のシーンの前にホストが実際に使える経路を確かめ、内蔵画像ツール（追加課金なし）を先に提案し、API モデル（別途キー・課金）もあわせて示します。ユーザーの答えを受けて作品ごとに確定し、変えてほしいと言われたときだけ改めて尋ねます。ウェブトゥーンの結果は小説の正本とは別に保存され、小説を変えません。
詳しい手順は[ウェブトゥーン制作ガイド](../WEBTOON.en.md)を見てください。

## なぜ vibelore か

ルールの寄せ集めで小説を代わりに書くツールではありません。読書体験を先に合意し、AI の創作力は生かしつつ、
長編で崩れやすい記憶・因果・一貫性・承認・復旧だけを受け持ちます。

- **読書契約が先。** ジャンル名ではなく速度・難度・情緒・報酬・タブーを決め、その約束を毎話守ります。
- **因果が装飾に勝つ。** 設定を増やすより行動・反応・結果がつながるようにし、人物は説明ではなく選択の積み重ねで作ります。
- **最終権限は人にある。** Markdown 原稿が正本であり、advisory は自動修正の命令ではありません。

| 主体 | 担うこと |
|---|---|
| ユーザー | 望む読書体験、重要な好み、最終承認 |
| ホスト AI | アイデアの判断、シーン構成、散文・セリフ・絵の生成、意味の批評 |
| vibelore | 正本・計画の受け渡し、順序の保証、衝突チェック、レビュー根拠の記録、コミットと復旧 |
| Markdown 正本 | 世界・人物・本文・要約の最終的な事実 |

全体の方向性は[哲学](../PHILOSOPHY.en.md)、構造は[アーキテクチャ](../ARCHITECTURE.en.md)を見てください。

## 対応ジャンル

25個のジャンルプリセットがあり、プリセットごとに追跡する設定項目（時系列、回帰の知識、関係の状態、能力
体系など）が異なります。

`回帰ハンター` `悪役令嬢・異世界` `アカデミーファンタジー` `家門回帰` `追放復讐` `推理スリラー` `アクション`
`コメディ` `歴史` `LitRPG` `配信 LitRPG` `成長もの` `システム・アポカリプス` `塔の攻略` `異世界`
`修練` `仙侠` `玄幻` `ダンジョンコア` `ロマンスファンタジー` `SF` `ホラー` `日常ヒーリング` `現代都市` `その他`

リストにないジャンルや複合ジャンルでも大丈夫です。インタビューがジャンルをトーン・サブジャンル・物語の原動力に分解して
作品プロフィールにし、設定チェックは最も近いプリセットを使います。

## 作品の言語

作品をどの言語で書くかは、`lore_profile`、`lore_init`、`lore_create` が受け取る `language` という
任意の引数で決めます（`lore_write` の `language` は保存された言語と一致するかを確認するだけです）。ユーザーが執筆言語を自然な言葉で伝えると、ホストが BCP 47
タグ（`ja`、`pt-BR`、`zh-Hant` など）に正規化して渡し、言語を選ばなければ引数を省きます。
言語キーのない既存の作品は暗黙の `ko` です。会話の言語と作品の言語は別なので、韓国語で
会話しながら日本語の作品を書けます。

> `/absolute/path/to/my-novel` に `harbor_summer` という作品を作りたい。本文はスペイン語で書いて。

- プロンプトは二系統です。`ko` は韓国語に特化した指示文を、それ以外の言語（英語を含む）は英語の共通
  指示文に目標言語を組み合わせた系統を使います。本文、タイトル、要約、世界・人物の説明、計画とレビューの
  説明値は目標言語に従い、JSON のキー・enum・ID のような機械が読む値は翻訳しません。
- 分量は言語に合った単位で測ります。韓国語は従来の文字数、それ以外の言語は書記素（grapheme）
  または単語数で、アラビア語・ヘブライ語のように結合文字の多い文字体系や、分かち書きのないタイ語も
  同じ契約の中で扱います。
- foundation の前なら新しいプロフィール revision を承認して言語を変えられ、承認された言語と違う値を
  渡すと `LANGUAGE_CONTRACT_CONFLICT` で拒否します。foundation を作ったあとは変えられず、違う値を
  渡すと黙って上書きせずに `WORK_LANGUAGE_IMMUTABLE` で拒否します。
- 話ごとに本文・要約・計画が作品の言語で書かれたかをチェックし、視点・人物の登録・世界設定のような
  意味の不変条件は言語に関係なく同じチェッカーが見ます。
- ウェブトゥーンも作品の言語に従います。セリフは翻訳せず作品の言語の原文のまま画像に入り、
  画像プロンプトに言語・文字体系・読む方向（アラビア語は右から左）を明示します。

小説の執筆とシーンのウェブトゥーンの流れは、英語、スペイン語、日本語、フランス語、韓国語、アラビア語、
繁体字中国語、タイ語の8言語の受け入れサンプルで確認しました。このサンプルのホストモデルは Claude Sonnet 5 でした。引数の契約の
詳細は[作品の言語と分量の単位](../TOOLS.en.md#work-language-and-length-units)を参照してください。

## ファイルはどこに

```text
my-novel/
├── world/         世界設定 — 直接直してかまいません
├── characters/    人物設定 — 直接直してかまいません
├── chapters/      本文 — 直接直してかまいません
├── summaries/     話ごとの要約
├── webtoon/       deprecated なコマごとの作業の承認版・SVG/HTML マスター
└── .vibelore/     チェック記録・復旧スナップショット・ウェブトゥーンのシーン結果（webtoon/candidates/） — 触らないでください
```

原稿と制作記録は自分のコンピューターに残ります。接続したホストやモデルのサービスには、リクエストに必要な原稿と
参照画像が送られることがあります。境界は[セキュリティガイド](../../SECURITY.md)にあります。
原稿の著作権は作者にあり、このリポジトリのライセンスは適用されません。

## モデルとコスト

小説とウェブトゥーンの絵は、モデルを別々に選びます。

### 小説：書く AI アプリのサブスクリプション

小説は、vibelore をつないだ AI アプリ（ホスト）でいま選んでいるモデルが書きます。vibelore に API キーを別に入れることはなく、
そのアプリのサブスクリプションや API クレジットの範囲で動きます。なので必要なのは、使いたいホストの利用権です。

| ホスト | 必要なもの |
|---|---|
| Claude Code | Claude のサブスクリプションまたは Anthropic API キー |
| Codex CLI | ChatGPT のプランまたは OpenAI API キー |
| Grok CLI | xAI アカウント |

**実際に使ったモデル。** 以下のモデルは実際の作品を最後まで書いた組み合わせなので、品質をある程度見積もれます。
成果物は[作品一覧](https://fbwndrud.github.io/vibelore/showcase/)ですべて見られます。

| モデル | 経路 | 書いた作品 |
|---|---|---|
| Claude Opus 5.5 | Claude Code | 『ベスパー』全50話完結、『判決LIVE』第1〜3話、『道の上の稲妻』第5話 |
| Claude Opus 5 | Claude Code | 『道の上の稲妻』第2話 |
| Claude Sonnet 5 | Claude Code | 8言語の多言語版 第1話 |
| GPT-6 Sol | OpenAI API | 『処刑1分前の皇女』第1〜3話、『道の上の稲妻』第7話 |
| GPT-6 Luna | OpenAI API | 『道の上の稲妻』第6話 |
| GPT-6 Astra | Codex CLI | 『道の上の稲妻』第1話 |
| Grok 4.6 · 4.7 | Grok CLI | 『道の上の稲妻』第3・4話 |

**つなげるが、自分たちでは確かめていないもの。** 品質は保証しませんが、試すことはできます。
使ってみた結果を issue で教えていただければ、上の表に加えます。

- **ほかの MCP ホスト。** Gemini CLI のように MCP ツールを呼び出せるアプリなら、つないでそのアプリのモデル（Google Gemini など）で書けます。
- **ローカルモデル。** Ollama・LM Studio のように OpenAI 互換のエンドポイントを開くローカルサーバーを、環境変数でつなぎます。長い原稿と構造化された応答を安定して出せるモデルである必要があります。ウェブトゥーンの画像レビューのリクエストには絵のファイルを添付して送るので、絵を見られるモデルならレビューまで任せられます。

**段階別のモデル割り当て。** 企画・草稿・レビューの段階を別々のモデルに任せるヒント（`modelProfile`）を出せますが、
どの組み合わせがよいかはまだ試していません。今は一つのモデルですべての段階を回すことをおすすめします。

### ウェブトゥーン：ホストの内蔵ツールか画像 API

絵は、ユーザーが選んだ経路でホストが描きます。最初のシーンの前にホストが実際に使える描画経路とモデルを
確かめてすべて示し、選んだものを作品ごとに保存します。脚色・シーン演出・画像レビューは小説と同じホストのモデルが担当します。

| 経路 | 費用 | モデル |
|---|---|---|
| ホストの内蔵画像ツール（例：Codex `image_gen`） | ホストのサブスクリプションの使用量の範囲内、別途キー不要 | ホストが決めます。Codex 0.159.2 の `image_gen` にはモデルを選ぶ引数がないので、Codex が選びます |
| OpenAI の画像 API | 実行環境の `OPENAI_API_KEY` と別途課金 | `gpt-image-2.5-sunburst`（おすすめ）、`gpt-image-2.5-flare`、`gpt-image-2` など、アカウントで使えるモデル |

- 内蔵ツールのあるホストでは、その経路を先に提案します。Claude Code のように内蔵ツールがなければ API の経路を示します。
- 「これからは API で描いて」のように変えてほしいと言われたら、モデルと費用を改めて示し、確認した選択だけをその作品に使います。
- 実行できなかったり上限を超えたりしても、ほかの経路やモデルに勝手に切り替えません。
- 公開した作品の絵はすべて OpenAI API の `gpt-image-2.5-sunburst` で描きました。作品ごとに使ったモデルと費用は、作品一覧の各作品ページで見られます。
- Gemini のようなほかの提供元の画像モデルも、ホストが経路を報告すれば同じ方法で選べますが、自分たちでは確かめていません。

詳しい設定は[モデル設定](../MODELS.en.md)を見てください。

## よくある質問

<details>
<summary>GUI はありますか？</summary>

ありません。Claude Code、Codex、Grok CLI のチャット欄がインターフェースで、結果は Markdown の原稿と、ウェブトゥーンはシーンごとの PNG/JPEG 画像（文字入り）と `scene.html` で出てきます。
</details>

<details>
<summary>別にお金はかかりますか？</summary>

小説の執筆はホストのサブスクリプション・クレジットの範囲で動きます。既定の設定では vibelore がモデルを直接呼び出すことはありません（ローカルモデルをつないだ場合を除く）。ウェブトゥーンの絵は、ホストの内蔵画像ツールを選べばそのホストの使用量の範囲で、画像 API を選べばそのアカウントの別途課金で描きます。
</details>

<details>
<summary>途中で止まったら最初からやり直しですか？</summary>

いいえ。ワークフローが保存されるので「続けて」で同じ場所から再開します。チェックを通った原稿だけがコミットされ、話単位のスナップショットで巻き戻せます。[トラブルシューティング](../TROUBLESHOOTING.en.md#work-stopped-midway)を見てください。
</details>

<details>
<summary>設定や本文を手で直してもいいですか？</summary>

大丈夫です。`world/`、`characters/`、`chapters/` は人が直すためのファイルです。直したあと「変更点を確認して」と言えば、影響範囲と次にやることを教えてくれます。
</details>

<details>
<summary>チェッカーが捕まえたものが、実は意図したどんでん返しだったら？</summary>

hard 違反は確定した事実との衝突なので直しますが、本当にどんでん返しなら先に設定ファイルを変えれば済みます。soft 違反は作者の意図かもしれないので、AI が自動で直さずユーザーに尋ねます。
</details>

<details>
<summary>韓国語以外の言語でも書けますか？</summary>

書けます。執筆言語は作品を作るとき（プロフィールまたは `lore_create`・`lore_init`）に決め、インタビューはユーザーが使う言語で進めます。ガイド文書は韓国語の原文と英語版（`*.en.md`）があります。上の[作品の言語](#作品の言語)を見てください。
</details>

## さらに読む

ドキュメントのリンク先は英語版です。韓国語の原文は同じ名前の `.md` ファイルにあります。

- [スタートガイド](../GETTING_STARTED.en.md) — 登録、最初の作品、次の話、行き詰まったとき
- [ウェブトゥーン制作](../WEBTOON.en.md) — 原作の範囲と必須の選択、シーン統合制作とレビュー
- [トラブルシューティングとバックアップ](../TROUBLESHOOTING.en.md) — 作業の再開、手直し、巻き戻し、ファイルの保管
- [モデル設定](../MODELS.en.md) — テキスト・画像モデルの選択、コストの経路、ローカルモデル
- [ツールリファレンス](../TOOLS.en.md) — ホストが呼び出すツールの全契約
- [アーキテクチャ](../ARCHITECTURE.en.md) — 小説・ウェブトゥーン制作の構造、AI とサーバーの役割、保存の境界
- [全ドキュメント](../README.en.md) · [ホスト別の検証記録](../../HOSTS.en.md) · [コントリビュート](../../CONTRIBUTING.md) · [セキュリティ](../../SECURITY.md)

Apache-2.0。原稿と絵の権利は作った人にあります。
