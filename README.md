# AI Companion for Minecraft Bedrock（相棒AI「ナビ」）

マインクラフト統合版（iOS / Android / PC等）に寄り添う、体を持たないAI相棒を作るアドオンです。
PC上で動く **Bedrock Dedicated Server (BDS)** の中で直接 Gemini API を呼び出す構成なので、
別途Node.jsサーバーなどを用意する必要はありません。BDS自体が「専用サーバー」の役割を果たします。

## 全体構成

```
[スマホなど] --Bedrock接続(LAN/フレンド)--> [PC: Bedrock Dedicated Server]
                                              └─ behavior_pack (Script API)
                                                   ├─ チャット監視 ("見て" "ダイヤある？" など)
                                                   ├─ 視線レイキャスト / 周辺ブロックスキャン
                                                   ├─ 無言7分の見守りタイマー
                                                   └─ HTTP --> Gemini API
                                              記憶はワールドの Dynamic Property に保存
                                              (ログアウト/再ログインしても保持される)
```

- `@minecraft/server`：チャット監視、レイキャスト、ブロック取得、記憶の保存など
- `@minecraft/server-net`：Gemini APIへのHTTPリクエスト（**BDS上でのみ動作**するAPIです）

## ファイル構成

```
minecraft-ai-companion/
├─ behavior_pack/
│  ├─ manifest.json
│  └─ scripts/
│     ├─ config.js       … APIキー・人格プロンプト・各種しきい値
│     ├─ gemini.js        … Gemini API呼び出し
│     ├─ memory.js        … 会話記憶の保存/読み込み(Dynamic Property)
│     ├─ perception.js    … 視線先の認識・周辺鉱石スキャン
│     └─ main.js           … チャット監視・見守りループ(エントリーポイント)
└─ config/default/permissions.json … server-netモジュール許可のサンプル
```

## セットアップ手順

### 1. Bedrock Dedicated Serverを用意する
Minecraft公式サイトからBDS（Windows/Linux版）をPCにダウンロード・展開してください。
（すでにBDSを運用中の場合はそのワールドに組み込んでOKです）

### 2. behavior_packを配置する
`behavior_pack` フォルダを、BDSの `behavior_packs/AICompanion` などにコピーし、
`worlds/<ワールド名>/world_behavior_packs.json` に manifest.json の uuid/versionを追記して有効化してください。

### 3. server-netモジュールを許可する
このアドオンは `@minecraft/server-net` というベータ版APIを使うため、BDS側で明示的に許可が必要です。
`config/default/permissions.json`（またはパック個別の `config/<pack_uuid>/permissions.json`）に、
本リポジトリのサンプルのように `allowed_modules` へ `"@minecraft/server-net"` を追加してください。

さらに、ワールドで「ベータAPI (Beta APIs)」系の実験的機能を有効にする必要があります。
**この設定手順はMinecraftのバージョンによって変わりやすいため、必ず公式ドキュメント
(https://learn.microsoft.com/minecraft/creator/) の最新情報で確認してください。**

### 4. Gemini APIキーを設定する
1. https://aistudio.google.com/ でAPIキーを取得
2. `behavior_pack/scripts/config.js` の `GEMINI_API_KEY` を書き換える
3. `GEMINI_MODEL` は https://ai.google.dev/gemini-api/docs/models で現在使えるモデル名を確認して設定する
   （モデル名は更新されやすいため、うまく動かない場合はまずここを疑ってください）

### 5. スマホから接続する
BDSを起動したら、スマホのマインクラフトから「サーバーを追加」でPCのローカルIP（例: `192.168.x.x`）と
ポート（既定19132）を指定して接続します。同じWi-Fi内であればこれで繋がります。

### 6. 遊んでみる
- 何かを見ながら「見て」と話しかける → 視線の先のブロックをもとに会話
- 「近くにダイヤはある？」と聞く → 半径8ブロックをスキャンして方角を教えてくれる
- 何もせず7分放置する → 相棒が今の状況を見て自発的に話しかけてくる
- 一度ログアウトしても、また同じ名前でログインすれば会話の記憶が引き継がれる

## 追加機能

### 地形・環境の把握(視線の先=素材、周辺=ランドマーク)
状況descriptionには性質の異なる2種類の情報を渡しています。

1. **視線の先で見ているもの**：具体的な素材・ブロック名(例: `deepslate_diamond_ore`)。プレイヤーが
   「これ何?」と尋ねてきたときに備えて、ここだけは素材まで具体的に伝えます。視線が届く距離も32ブロックまで
   延長し、「すぐ目の前」「約20ブロック先」のように距離も付記します。
2. **プレイヤー周辺の地形・環境**：素材の詳細には触れず、「そこに何があるか」というランドマーク単位の
   大まかな情報です。プレイヤーを中心に`SCENE_SCAN_RADIUS`（既定8ブロック）の立方体を非同期スキャンし、
   以下を推測します。
   - 建造物・拠点らしきものがあるか
   - 洞窟・地下にいる可能性が高いか(上空が見えないか)
   - 池や川など水辺が近いか
   - 森や林のように木々が多いか
   - 花畑のように花が多いか(`FLOWER_COUNT_THRESHOLD`で調整)
   - 近くに動物がたくさんいるか(`dimension.getEntities({ families: ["animal"] })`で取得、`ANIMAL_COUNT_THRESHOLD`で調整)
   - 崖・谷・大きな穴・斜面のような地形の起伏があるか(プレイヤーの東西南北の地面の高さを比較)

これらは断定ではなく「〜の可能性が高いです」「〜のようです」という推測込みの文章としてGeminiに渡され、
Geminiがそれをもとに自然な言葉で反応します。閾値は`config.js`の`SCENE_ARTIFICIAL_COUNT_THRESHOLD`/
`SCENE_ARTIFICIAL_RATIO_THRESHOLD`/`FLOWER_COUNT_THRESHOLD`/`ANIMAL_COUNT_THRESHOLD`で、判定に使う
ブロックIDのヒント一覧は`perception.js`の`ARTIFICIAL_HINTS`/`FLOWER_HINTS`/`VEGETATION_HINTS`で調整できます。

### 見守りのON/OFF
チャットで次のように話しかけると切り替えられます（Gemini APIは呼ばれず即座に反応します）。
- オフにする：「見守りオフ」
- オンに戻す：「見守りオン」

設定はプレイヤーごとにDynamic Propertyへ保存されるため、ログアウトしても状態が保持されます。

### どんな鉱石・木材(何でも)探索できる仕組み
「〇〇ある？」「〇〇どこ？」「〇〇探して」のような発言をヒントワードで検知すると、まずGeminiに
「これは資源探索の意図か・対応する英語キーワードは何か」を判定させ（`identifyResourceQuery`）、
そのキーワードでワールドのブロックIDを直接スキャンします。鉱石・木材の種類をハードコードしていないため、
Minecraft内に存在するブロックであれば基本的に何でも対応します（例:「鉄ある？」「オークの木ある？」「エメラルドは？」）。

### 段階的な探索範囲
1. まずプレイヤーの上下左右 `NEARBY_RADIUS`（既定8ブロック）を検索
2. 見つからなければ `EXTENDED_RADIUS`（既定24ブロック）まで自動的に広げて再検索
3. それでも見つからなければ、鉱石は素直に「見つかりませんでした」と伝えます
4. 木材の場合のみ、その木が生えやすい代表バイオーム(`perception.js`の`WOOD_BIOME_HINTS`)を
   `Dimension.findClosestBiome` で探し、見つかればその方角と距離を案内します
   （このAPIはバージョンによって挙動が変わりやすいベータ寄りの機能のため、失敗時は静かに諦めて
   「見つかりませんでした」に切り替わります）

いずれの場合も、最終的にチャットへ表示される文章はスキャン結果というテキスト情報をGeminiに渡し、
Gemini自身が生成した返答です（＝APIを通したAIの出力です）。

### 長期記憶（AIが自律的に読み書きする思い出ノート）
短期的な直近の会話履歴（`companion_mem_*`）とは別に、`companion_longmem_*` というプレイヤーごとの
「思い出ノート」領域を用意しました。GeminiのFunction Calling機能を使い、AI自身が
「これは長く覚えておくべきだ」と判断した内容だけを `save_long_term_memory` 関数で保存し、
古くなった記憶は `forget_long_term_memory` 関数で自分で削除できます。
この長期記憶は毎回のやり取りで必ずプロンプトに含まれるため、AIは自由に参照できます。
上限件数（既定50件）を超えると古いものから自動的に間引かれる安全策も入れています。

### 場所の記録(landmark) - 「あの場所どこだっけ」に座標付きで答える
短期記憶・長期記憶とは別に、プレイヤーごとの「地図メモ」(`companion_landmarks_*`)を保存します。
次の3パターンで自動・半自動に記録されます。

1. **木材の伐採**：`world.afterEvents.playerBreakBlock`で、伐採したブロックが木材系なら自動記録(category: `wood`)
2. **「見て」で見た木、「これ何?」で聞いた素材**：視線の先が木材なら自動記録(`wood`)、「これ何?」は素材の種類を問わず記録(`material_asked`)
3. **プレイヤーが言及した環境**(雪原・村・花畑・温泉・桜の木が見える場所・ネザーゲート風の構造物など)：
   GeminiのFunction Calling(`save_landmark`)で、AIが「記録すべき」と判断したときに記録(category例: `snow`, `village`, `flower_field`, `hot_spring`, `cherry_tree`, `structure`)

**座標の出所について**：いずれの場合も、座標はAIの引数ではなく**スクリプト側が実際に取得した位置**
(視線の先のブロック座標、無ければプレイヤーの現在地)を使います。AIには数字を作らせない、これまでの
座標捏造対策と同じ設計です。

**重複除去(同じ場所で記録が埋め尽くされるのを防ぐ)**：伐採のように同じ場所で何度も発生するイベントは、
一定の半径・時間内であれば新規追加せずスキップします。既定値は次の通りで、`config.js`で調整できます。

| 種別 | 半径 | 時間 |
|---|---|---|
| 木材伐採・視線 (`WOOD_LANDMARK_DEDUPE_RADIUS`/`MINUTES`) | 10ブロック | 30分 |
| これ何?で聞いた素材 (`MATERIAL_LANDMARK_DEDUPE_RADIUS`/`MINUTES`) | 6ブロック | 20分 |
| AIが記録する環境メモ (`ENV_LANDMARK_DEDUPE_RADIUS`/`MINUTES`) | 8ブロック | 20分 |

さらに全体の保存件数にも上限(`MAX_LANDMARKS`、既定150件)を設けており、超えた場合は古いものから
自動的に間引かれます。

**質問への回答**：「さっき見つけたペールオーク、どこだっけ?」「雪のエリアってどこだったっけ?」のように
尋ねると、毎回のプロンプトに埋め込まれる「記録した場所のメモ」一覧からGeminiが該当するものを探し、
**必ず実際の座標を含めて**回答するよう指示しています。該当する記録が無い場合は、座標を作らず正直に
「分からない」と答えるようになっています。

### シード知識(未探索エリアも「知っている」状態にする)
`behavior_pack/scripts/seed_knowledge.js` に、[Chunkbase Seed Map](https://www.chunkbase.com/apps/seed-map)
などの外部シードマップツールで事前に調べたバイオーム・構造物の座標を書き込んでおくと、プレイヤーがまだ
「見て」いないエリアや伐採していない木のバイオームについても、ナビが案内できるようになります。

**手順(手動で数件だけ登録する場合)**：
1. Chunkbase Seed Mapを開き、ワールドのシード値を入力、エディションを「Bedrock」、バージョンをお使いのものに合わせる
2. 知りたいバイオームや構造物を検索して座標を控える
3. `seed_knowledge.js` の `SEED_KNOWLEDGE` 配列に、`{ label, category, x, y, z, dimensionId }` の形式で追記する

```js
export const SEED_KNOWLEDGE = [
  { label: "cherry_grove", category: "biome", x: 580, y: 70, z: -3200, dimensionId: "overworld" },
  { label: "village", category: "structure", x: 120, y: 65, z: 300, dimensionId: "overworld" },
];
```

**手順(Pythonで広範囲のバイオームを一括抽出する場合)**：
同梱の `extract_seed_biomes.py` を使うと、指定した範囲のオーバーワールドのバイオームをまとめて
`seed_knowledge.js` 形式で書き出せます。

1. `pip install numpy scipy` と、Java版のバイオーム生成を再現する `pybiomes`
   (`pip install git+https://github.com/ScriptLineStudios/pybiomes --recursive`、ソースビルドのため
   C言語のビルド環境が必要な場合があります)をインストール
2. スクリプト冒頭の `SEED` / `CENTER_X` / `CENTER_Z` / `SCAN_RADIUS` / `STEP` などを書き換える
3. `python extract_seed_biomes.py` を実行する
4. まず出力される「サニティチェック」の結果が、実際にゲーム内で見えているスポーン地点付近の
   バイオームと一致するか確認する(一致しない場合はバージョン指定などを見直す)
5. 問題なければ出力された `seed_knowledge.js` を、アドオンの `behavior_pack/scripts/seed_knowledge.js`
   にそのままコピーする

**このスクリプトの限界**：
- Java版のバイオーム生成を再現する `cubiomes`(pybiomesの内部実装)を使っているため、
  1.18以降で共通化された**バイオーム・地形**はかなり正確に再現できますが、
  **村・要塞などの構造物は、Java版と統合版で配置アルゴリズムが異なるため対象外**です。
  構造物は上記の手動手順(Chunkbase)で個別に追加してください
- 開発環境の制約上、このスクリプトは実際には動作検証していません。まず小さい範囲で試し、
  ゲーム内の実際の景色と照らし合わせてから、本番の範囲で実行することを強くお勧めします

**注意点**：
- これは「ナビが自分でシード値から地形を計算している」わけではなく、外部ツール(またはこのPython
  スクリプト)で調べた結果を事前に登録しておく仕組みです。ナビ自身がリアルタイムでBedrockのワールド
  生成アルゴリズムを再現しているわけではありません
- Bedrock版は構造物の座標精度がJava版よりやや落ちる場合があるとChunkbase側が注記しています。あくまで目安です
- ナビには「これは外部ツールによる推定情報で、実際に確認したものではない」と伝えているため、
  「たぶんこの辺りのはず」のような、断定しすぎない言い方で案内するはずです
- 資源検索(`findResourceDirection`)・バイオーム検索(`findBiomeDirection`)は、まずプレイヤー周辺の
  ライブ検索を試み、見つからなかった場合にのみこのシード知識を参照します(近くにあるものは優先的に
  ライブ検索の結果が使われます)
- プレイヤーから`SEED_NEARBY_RADIUS`(既定400ブロック)以内にシード知識があるときは、`describeView`が
  それを状況descriptionに含めるため、「見て」への返答や無言時の自発発言の中で、ナビが
  「この近くに〜があるみたいだよ」と自然に触れてくれることがあります(強制ではなく、自然な範囲で)

**landmark機能(場所の記録)との役割分担**：シード知識は「世界生成そのもの」(バイオーム・構造物)にしか
使えません。実際にプレイヤーが伐採した場所、「これ何?」で聞いた具体的なブロック、プレイヤー自身が
言及した発見など、**シード値からは分からないプレイヤー固有の体験**はlandmark機能でしか記録できないため、
シード知識を導入してもlandmark機能(`recordLandmarkIfNew`・長期記憶など)は残しています。

## よくある質問

**Q. 鉱石は上下左右8ブロックまで検知して、なければ「ない」と教えてくれますか？**
A. 今回の更新で仕様が変わりました。まず8ブロックで探し、見つからなければ24ブロックまで自動的に
範囲を広げて再探索し、それでも無ければ正直に「見つかりませんでした」と伝えます。

**Q. チャットに表示されるのはAPIを通したAIの出力ですか？**
A. はい。ブロックスキャンの結果は一度テキストの状況descriptionとしてまとめ、それをGeminiに渡して、
Geminiが生成した文章だけをチャットに表示しています。

**Q. 記憶はプレイヤーごとに分かれますか？**
A. はい。短期記憶・長期記憶・見守りON/OFF設定のすべてを `player.name` をキーにして個別に保存しているため、
プレイヤー間で記憶が混ざることはありません。

**Q. API通信はPC側で行われますか？**
A. はい。すべてBedrock Dedicated Server（PC）上で動くScript APIの中で完結しており、iPhone側は
入出力（チャット表示・入力）を行うだけです。Gemini APIキーもPCのファイルにしか存在しません。

**Q. 複数人が同じサーバーに接続して遊んだ場合、どうなりますか？**
A. 各プレイヤーの発言は `ev.cancel = true` によって他のプレイヤーには見えない個別チャットとして扱われ、
`player.sendMessage()` で本人にしか返信が届きません。会話履歴・長期記憶・見守り設定もプレイヤー名ごとに
完全に分かれているため、Aさんの発言や記憶がBさんに影響することはありません。無言タイマーもプレイヤーごとに
独立してカウントされます。
ただし、Gemini APIキーは1つのプロジェクトを全員で共有する形になるため、同時に複数人が話しかけると
Gemini APIのレート制限・利用量（無料枠の場合は特に）に早く到達する可能性がある点は留意してください。

**Q. AIは常に時間帯と天候を意識していますか？**
A. はい。`describeView` が呼ばれるたびに、ゲーム内の時間帯（朝・昼・夕焼け・夜など）と
`Dimension.getWeather()` から取得した天候（晴れ・雨・雷雨）を状況descriptionに含めており、
これは「見て」への返答・資源探索への返答・無言時の自発的な声かけ、すべてのケースで毎回渡されます。

## カスタマイズのポイント

- **性格・口調**：`config.js` の `PERSONALITY_PROMPT` を書き換えるだけで相棒のキャラクターを変えられます
- **見守り間隔**：`config.js` の `IDLE_MINUTES`
- **探索範囲**：`config.js` の `NEARBY_RADIUS` / `EXTENDED_RADIUS`
- **木材のバイオーム対応表**：`perception.js` の `WOOD_BIOME_HINTS`
- **長期記憶の保存上限**：`config.js` の `MAX_LONG_TERM_ENTRIES`
- **他プレイヤーにもチャットを見せたい場合**：`main.js` の `ev.cancel = true;` をコメントアウト
  （ただしその場合、個別の会話が全員に見えてしまう点に注意してください）

## 既知の制約・注意点

- `@minecraft/server-net` はBDS専用APIで、Realmsやシングルプレイのワールドでは動作しません
- Gemini APIキーは平文で `config.js` に置く構成です。公開リポジトリにpushしないよう `.gitignore` を推奨します
- 会話記憶（短期）はDynamic Propertyのサイズ上限があるため、直近24ターン程度に自動的にトリムされます
- 資源探索は「読み込まれているチャンク」しかスキャンできません。プレイヤーから遠く離れた
  未読み込みの領域にある資源は検知できないため、「近くにない」＝「本当に世界のどこにもない」を
  意味するわけではない点に注意してください
- 木材のバイオームフォールバックで使う `Dimension.findClosestBiome` はベータ寄りのAPIのため、
  お使いのMinecraftバージョンによっては動作しない場合があります。その場合は自動的に
  「見つかりませんでした」という通常の応答にフォールバックします
- Script APIのモジュールバージョンは頻繁に更新されるため、`manifest.json` の `dependencies` に書いた
  バージョン番号がお使いのMinecraftバージョンと合わない場合は、公式ドキュメントで最新値に置き換えてください。
  **バージョン不一致があると、コンソールに`TypeError: cannot read property 'subscribe' of undefined`のような
  エラーが出て、パックが正常に動かないことがあります。** 正確な値が分からない場合は、サーバーのエラーログに
  実際の警告が出ていないか確認するか、Microsoft Learnの該当バージョンのドキュメントを参照してください。
  `@minecraft/server`側だけでなく`@minecraft/server-net`側もバージョンが古いとエラーになることがあるので、
  似たようなエラーが出た場合はそちらも確認してください。
