// ==============================
// シード知識(SEED_KNOWLEDGE)
// ==============================
// このワールドのシード値をもとに、Chunkbase (https://www.chunkbase.com/apps/seed-map) などの
// 外部シードマップツールで事前に調べたバイオーム・構造物の座標をここに書き込んでおくと、
// ナビはまだ探検していないエリアについても「知っている」状態で会話・案内ができるようになります。
//
// 使い方:
// 1. Chunkbaseの Seed Map (https://www.chunkbase.com/apps/seed-map) を開く
// 2. シード値 "6942710633571786" を入力し、エディションを "Bedrock"、バージョンをお使いのものに合わせる
// 3. 知りたいバイオームや構造物を検索して座標を控える
// 4. 下の SEED_KNOWLEDGE 配列に、1件ずつ追記する
//
// 注意:
// - Bedrock版は構造物の座標精度がJava版よりやや落ちる場合があります(公式ツール側の注記)。
//   ここに書いた座標はあくまで「外部ツールによる推定値」であり、実際に行って確認したものではありません。
// - ナビにはこれを「外部ツールによる推定情報」として渡すので、プレイヤーに案内するときも
//   「たぶんこの辺りのはず」というニュアンスで話すよう指示しています(捏造ではなく、出典が違うだけです)。
// - dimensionId は "overworld" | "nether" | "the_end" のいずれかを想定しています。

export const SEED_KNOWLEDGE = [
  // 記入例(このまま残しても実害はありませんが、実際の座標に置き換えることを推奨します):
  // { label: "cherry_grove", category: "biome", x: 580, y: 70, z: -3200, dimensionId: "overworld" },
  // { label: "village", category: "structure", x: 120, y: 65, z: 300, dimensionId: "overworld" },
  // { label: "desert", category: "biome", x: -800, y: 64, z: 1200, dimensionId: "overworld" },
  // { label: "ancient_city", category: "structure", x: 200, y: -40, z: -600, dimensionId: "overworld" },
];
