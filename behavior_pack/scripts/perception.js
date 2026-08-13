import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { SEED_KNOWLEDGE } from "./seed_knowledge.js";

/**
 * 木材の種類(キーワード) -> その木が生えやすい代表的なバイオームIDの対応表。
 * 近くに見つからなかった場合の「バイオーム方向フォールバック」に使用する。
 * 必要に応じて自由に追加・修正してください。
 */
const WOOD_BIOME_HINTS = {
  oak: ["minecraft:forest", "minecraft:plains"],
  birch: ["minecraft:birch_forest"],
  spruce: ["minecraft:taiga", "minecraft:snowy_taiga"],
  jungle: ["minecraft:jungle"],
  acacia: ["minecraft:savanna"],
  dark_oak: ["minecraft:dark_forest"],
  mangrove: ["minecraft:mangrove_swamp"],
  cherry: ["minecraft:cherry_grove"],
  crimson: ["minecraft:crimson_forest"],
  warped: ["minecraft:warped_forest"],
  pale_oak: ["minecraft:pale_garden"]
};

/**
 * 視線の先にあるブロックを取得する(外部からも使う共通ヘルパー)。
 * 木材の伐採記録、「これ何?」の素材記録、場所の記録の基準座標などに使う。
 * @returns {{typeId: string, location: {x:number,y:number,z:number}} | null}
 */
export function getGazeBlock(player) {
  try {
    const hit = player.getBlockFromViewDirection({ maxDistance: 32 });
    if (hit && hit.block) {
      return { typeId: hit.block.typeId, location: hit.block.location };
    }
  } catch (e) {
    // レイキャスト失敗時はnullを返す
  }
  return null;
}

/**
 * 「今、場所を記録するならここ」という基準座標を返す。
 * 視線の先に何かがあればその座標、無ければプレイヤー自身の座標を使う。
 * save_landmark関数呼び出し時の座標付与に使う。
 */
export function getReferenceLocation(player) {
  const dimensionId = player.dimension.id.replace("minecraft:", "");
  const gaze = getGazeBlock(player);
  if (gaze) {
    return { x: gaze.location.x, y: gaze.location.y, z: gaze.location.z, dimensionId };
  }
  const loc = player.location;
  return { x: loc.x, y: loc.y, z: loc.z, dimensionId };
}

/**
 * ブロックIDが木材(丸太・木材ブロック・幹など)らしいかどうかを判定する。
 * 資源探索の"wood"カテゴリ判定と、伐採の自動記録の両方で使う共通ロジック。
 */
export function isWoodBlockId(id) {
  return id.includes("_log") || id.includes("_wood") || id.includes("_stem") || id.includes("_hyphae");
}

/**
 * プレイヤーの近く(SEED_NEARBY_RADIUS以内)にあるシード知識を、自発的な話題候補として
 * 文章化する。無ければnullを返す。
 */
function describeNearbySeedKnowledge(player) {
  if (!Array.isArray(SEED_KNOWLEDGE) || SEED_KNOWLEDGE.length === 0) return null;

  const loc = player.location;
  const dimensionId = player.dimension.id.replace("minecraft:", "");

  const nearby = SEED_KNOWLEDGE
    .filter((e) => (e.dimensionId ?? "overworld") === dimensionId)
    .map((e) => {
      const dx = e.x - loc.x;
      const dz = e.z - loc.z;
      return { entry: e, dx, dz, dist: Math.sqrt(dx * dx + dz * dz) };
    })
    .filter((e) => e.dist <= CONFIG.SEED_NEARBY_RADIUS)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, CONFIG.SEED_NEARBY_MAX_ITEMS);

  if (nearby.length === 0) return null;

  return nearby
    .map((n) => {
      const dir = directionText(n.dx, n.dz);
      return `${n.entry.label}(${n.entry.category})が${dir}方向、約${Math.round(n.dist)}ブロック先`;
    })
    .join("、");
}

/**
 * 現在プレイヤーが見ている景色を言葉で説明するdescriptionを作る。
 * 「見て」と言われたとき、および無言タイムアウト時の自発発言の両方で使う。
 *
 * ここで渡す情報は2種類に分けている:
 * 1. 「視線の先で見ているもの」= 具体的な素材・ブロック名(プレイヤーが「これ何?」と聞く場合に使う)
 * 2. 「周辺の地形・環境」= 素材の詳細ではなく、洞窟/建造物/池/花畑/森/崖/動物など
 *    「そこに何があるか」という大まかなランドマーク情報(プレイヤーを中心に判定する)
 */
export async function describeView(player, { isIdleCheck = false } = {}) {
  const loc = player.location;
  const dim = player.dimension;

  let lookingAtText = describeEmptyView(player);
  let distanceText = "";

  const gaze = getGazeBlock(player);
  if (gaze) {
    lookingAtText = gaze.typeId.replace("minecraft:", "");
    const dist = distanceBetween(loc, gaze.location);
    distanceText = dist <= 3 ? "(すぐ目の前)" : `(約${Math.round(dist)}ブロック先)`;
  }

  const time = world.getTimeOfDay();
  const timeText = describeTimeOfDay(time);
  const weatherText = describeWeather(dim);
  const ambientText = await describeAmbientSurroundings(player);
  const nearbySeedText = describeNearbySeedKnowledge(player);

  const lines = [
    `ディメンション: ${dim.id.replace("minecraft:", "")}`,
    `座標: (${Math.floor(loc.x)}, ${Math.floor(loc.y)}, ${Math.floor(loc.z)})`,
    `ゲーム内の時間帯: ${timeText}`,
    `天候: ${weatherText}`,
    `プレイヤーが視線の先で見ているもの(具体的な素材。「これ何?」と聞かれたらこれを使う): ${lookingAtText}${distanceText}`,
    `プレイヤー周辺の地形・環境(素材の詳細ではなく、そこに何があるかの大まかな把握): ${ambientText}`
  ];

  if (nearbySeedText) {
    lines.push(
      `プレイヤーの近くにあるシード知識(外部ツールによる推定、まだ確認していない可能性がある。` +
        `自然な範囲で『この近くに〜があるみたいだよ』のように話題にしてもよい): ${nearbySeedText}`
    );
  }

  if (isIdleCheck) {
    lines.push("※これはプレイヤーがしばらく無言のときに、相棒が自発的に様子を観察した結果です。");
  }

  return lines.join("\n");
}

function distanceBetween(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 視線レイキャストが何もヒットしなかった場合に、
 * 見上げているか(上方向)・見下ろしているか(下方向)・水平方向かで
 * 「空」なのか「深い穴/谷」なのか「ただの遠景」なのかを推測して説明文を作る。
 * これをせずに一律「空」寄りの文言にしてしまうと、深い穴を見下ろしているときに
 * AIが「空が綺麗」のように誤って解釈してしまうことがあるため区別している。
 */
function describeEmptyView(player) {
  let viewDir;
  try {
    viewDir = player.getViewDirection();
  } catch (e) {
    return "何も特定できません(32ブロック以内にブロックが見当たりません)";
  }

  if (viewDir.y > 0.3) {
    return "32ブロック以内にブロックが見当たりません。上空を見上げている可能性が高いです(空や雲が見えているかもしれません)";
  }
  if (viewDir.y < -0.3) {
    return (
      "32ブロック以内にブロックが見当たりません。下を見下ろしているため、" +
      "深い縦穴・採掘中の穴・谷底など、下方向に大きく開けた空間を見ている可能性が高いです" +
      "(『空が綺麗』のような発言はしないでください)"
    );
  }
  return "32ブロック以内に近いブロックが見当たりません。開けた地形や遠景を見ている可能性があります";
}

function describeTimeOfDay(t) {
  // Minecraftの時間は0〜24000 (0=朝6時相当)
  if (t < 1000) return "朝(日の出のころ)";
  if (t < 6000) return "午前中";
  if (t < 11000) return "昼";
  if (t < 12500) return "夕方(日没前)";
  if (t < 13500) return "夕暮れ・夕焼け";
  if (t < 18000) return "夜";
  if (t < 22000) return "深夜";
  return "夜明け前";
}

function describeWeather(dim) {
  try {
    const weather = dim.getWeather(); // "Clear" | "Rain" | "Thunder"
    if (weather === "Clear") return "晴れ";
    if (weather === "Rain") return "雨";
    if (weather === "Thunder") return "雷雨";
    return String(weather);
  } catch (e) {
    // 環境やバージョンによって未対応の場合は不明として返す
    return "不明(取得できませんでした)";
  }
}

// ==============================
// プレイヤー周辺のランドマーク把握
// (洞窟/建造物/池/花畑/森/崖・斜面/動物の多さ、など「そこに何があるか」)
// ==============================

// ブロックIDにこれらの文字列が含まれていれば「人工物っぽい」と判定するヒント一覧。
const ARTIFICIAL_HINTS = [
  "plank", "brick", "glass", "concrete", "wool", "carpet", "terracotta",
  "stairs", "slab", "_door", "fence", "_wall", "quartz_block", "prismarine",
  "purpur", "bookshelf", "chest", "furnace", "crafting_table", "bed",
  "torch", "lantern", "ladder", "rail", "glowstone", "sea_lantern",
  "iron_bars", "hopper", "anvil", "barrel", "smoker", "loom",
  "cartography_table", "stonecutter", "grindstone", "lectern", "bell",
  "scaffolding", "campfire", "composter", "beacon", "piston", "observer",
  "redstone", "lamp", "dispenser", "dropper", "note_block", "jukebox",
  "armor_stand", "item_frame", "painting", "banner", "sign", "cauldron"
];

// 花っぽいと判定するヒント一覧(花畑判定に使う。vegetationとは別に個数を数える)
const FLOWER_HINTS = [
  "poppy", "dandelion", "tulip", "allium", "azure_bluet", "oxeye_daisy",
  "cornflower", "lily_of_the_valley", "sunflower", "lilac", "rose_bush",
  "peony", "wither_rose", "torchflower", "pink_petals", "flowering_azalea"
];

// 植物・自然物っぽいと判定するヒント一覧(花は除く。木々や下草など)
const VEGETATION_HINTS = [
  "leaves", "log", "sapling", "grass", "fern", "vine",
  "mushroom", "kelp", "seagrass", "bamboo", "cactus", "sugar_cane",
  "wheat", "carrot", "potato", "beetroot", "melon", "pumpkin",
  "hay_block", "moss", "lichen", "azalea", "mangrove_roots"
];

function classifyBlockId(id) {
  if (id === "air" || id === "cave_air" || id === "void_air") return "air";
  if (FLOWER_HINTS.some((h) => id.includes(h))) return "flower";
  if (ARTIFICIAL_HINTS.some((h) => id.includes(h))) return "artificial";
  if (VEGETATION_HINTS.some((h) => id.includes(h))) return "vegetation";
  if (id.includes("water") || id.includes("lava")) return "liquid";
  return "natural";
}

/**
 * プレイヤーを中心に立方体状のブロックをスキャンし、種類ごとの個数を数える。
 * system.runJob でtickをまたいで処理し、ラグを抑える。
 */
function scanSceneCounts(dim, center) {
  return new Promise((resolve) => {
    const radius = CONFIG.SCENE_SCAN_RADIUS;
    const counts = { natural: 0, artificial: 0, vegetation: 0, flower: 0, liquid: 0, air: 0, total: 0 };

    function* job() {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dz = -radius; dz <= radius; dz++) {
            try {
              const block = dim.getBlock({
                x: Math.floor(center.x) + dx,
                y: Math.floor(center.y) + dy,
                z: Math.floor(center.z) + dz
              });
              if (block) {
                const category = classifyBlockId(block.typeId.replace("minecraft:", ""));
                counts[category]++;
                counts.total++;
              }
            } catch (e) {
              // 未読み込みチャンクなどは無視
            }
          }
          yield;
        }
      }
      resolve(counts);
    }

    system.runJob(job());
  });
}

/**
 * 指定地点から見て、上方向におおむね空が見えるかどうかを大まかに判定する。
 * 完全に正確ではない簡易判定(木の葉や水は「通過可能」として扱う)。
 */
function hasSkyAccess(dim, origin) {
  const top = Math.floor(origin.y) + 1;
  for (let y = top; y <= top + 40; y++) {
    try {
      const block = dim.getBlock({ x: Math.floor(origin.x), y, z: Math.floor(origin.z) });
      if (!block) continue;
      const id = block.typeId.replace("minecraft:", "");
      const passable = id === "air" || id === "cave_air" || id.includes("leaves") || id.includes("water");
      if (!passable) return false;
    } catch (e) {
      break;
    }
  }
  return true;
}

/**
 * ブロックの内訳(counts)や動物の数などから、「そこに何があるか」の
 * ランドマーク的な特徴を文章の配列として返す(素材の詳細には触れない)。
 */
function describeLandmarkFeatures(counts, enclosed, originY, animalCount) {
  const notes = [];
  const solidTotal = counts.total - counts.air;

  if (solidTotal > 0) {
    const artificialRatio = counts.artificial / solidTotal;
    if (
      counts.artificial >= CONFIG.SCENE_ARTIFICIAL_COUNT_THRESHOLD ||
      artificialRatio > CONFIG.SCENE_ARTIFICIAL_RATIO_THRESHOLD
    ) {
      notes.push("近くに建造物や誰かの拠点のようなものがあるようです");
    }

    const naturalRatio = counts.natural / solidTotal;
    if (enclosed && originY < 55 && naturalRatio > 0.6) {
      notes.push("上空が見えず、洞窟や地下のような場所にいる可能性が高いです");
    }

    const liquidRatio = counts.liquid / solidTotal;
    if (liquidRatio > 0.15) {
      notes.push("近くに池や川など、水辺があるようです");
    }

    const vegetationRatio = counts.vegetation / solidTotal;
    if (vegetationRatio > 0.3) {
      notes.push("木々が多く、森や林のような場所にいるようです");
    }
  }

  if (counts.flower >= CONFIG.FLOWER_COUNT_THRESHOLD) {
    notes.push("花がたくさん咲いていて、花畑のような場所が近くにあるようです");
  }

  if (animalCount >= CONFIG.ANIMAL_COUNT_THRESHOLD) {
    notes.push(`動物が近くに${animalCount}匹ほどいて、賑やかな場所のようです`);
  }

  return notes;
}

const TERRAIN_CHECK_OFFSETS = [
  { dx: 4, dz: 0, label: "東" },
  { dx: -4, dz: 0, label: "西" },
  { dx: 0, dz: 4, label: "南" },
  { dx: 0, dz: -4, label: "北" }
];

const TERRAIN_CLIFF_THRESHOLD = 4; // これ以上の高低差(ブロック)があれば「崖・谷・大きな穴」寄りの表現にする
const TERRAIN_SLOPE_THRESHOLD = 2; // これ以上なら「斜面・坂」寄りの表現にする

/**
 * 指定座標(x, z)の地面のY座標を探す(aroundYを基準に上下探索)。
 * 通過可能ブロック(空気・水・葉など)は無視して最初に当たった不透過ブロックの高さを返す。
 * 見つからなければnull。
 */
function findGroundY(dim, x, z, aroundY) {
  const top = Math.floor(aroundY) + 5;
  const bottom = Math.floor(aroundY) - 20;
  for (let y = top; y >= bottom; y--) {
    try {
      const block = dim.getBlock({ x, y, z });
      if (!block) continue;
      const id = block.typeId.replace("minecraft:", "");
      const passable = id === "air" || id === "cave_air" || id.includes("water") || id.includes("leaves");
      if (!passable) return y;
    } catch (e) {
      break;
    }
  }
  return null;
}

/**
 * プレイヤーの東西南北の地面の高さを比べ、崖・谷・大きな穴・斜面のような
 * 地形の起伏があれば文章の配列として返す(素材には触れない)。
 */
function describeTerrainShape(dim, loc) {
  const x0 = Math.floor(loc.x);
  const z0 = Math.floor(loc.z);
  const notes = [];

  const centerY = findGroundY(dim, x0, z0, loc.y);
  if (centerY === null) return notes;

  let maxAbsDiff = 0;
  let maxDiff = 0;
  let maxLabel = "";

  for (const offset of TERRAIN_CHECK_OFFSETS) {
    const y = findGroundY(dim, x0 + offset.dx, z0 + offset.dz, loc.y);
    if (y === null) continue;
    const diff = centerY - y; // 正: その方向が低い、負: その方向が高い
    if (Math.abs(diff) > maxAbsDiff) {
      maxAbsDiff = Math.abs(diff);
      maxDiff = diff;
      maxLabel = offset.label;
    }
  }

  if (maxAbsDiff >= TERRAIN_CLIFF_THRESHOLD) {
    if (maxDiff > 0) {
      notes.push(`${maxLabel}側が大きく落ち込んでおり、近くに崖・谷・大きな穴のようなものがある可能性があります`);
    } else {
      notes.push(`${maxLabel}側が大きくせり上がっており、近くに崖や壁のような地形がある可能性があります`);
    }
  } else if (maxAbsDiff >= TERRAIN_SLOPE_THRESHOLD) {
    notes.push(`${maxLabel}方向にゆるやかな高低差があり、坂道や斜面に近い場所にいる可能性があります`);
  }

  return notes;
}

/**
 * プレイヤーの近くにいる動物の数を数える(取得できなければ0を返す)。
 */
function countNearbyAnimals(dim, loc) {
  try {
    const entities = dim.getEntities({ location: loc, maxDistance: CONFIG.ANIMAL_CHECK_RADIUS, families: ["animal"] });
    return entities.length;
  } catch (e) {
    return 0;
  }
}

/**
 * プレイヤーを中心とした周辺のランドマーク・地形の様子を1つの文章にまとめて返す(非同期)。
 * 断定はせず、あくまで「〜の可能性が高い」「〜のようです」という推測ベースの表現にしている。
 */
async function describeAmbientSurroundings(player) {
  const dim = player.dimension;
  const loc = player.location;
  const origin = { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) };

  try {
    const counts = await scanSceneCounts(dim, origin);
    const enclosed = !hasSkyAccess(dim, origin);
    const animalCount = countNearbyAnimals(dim, loc);
    const terrainNotes = describeTerrainShape(dim, loc);
    const landmarkNotes = describeLandmarkFeatures(counts, enclosed, origin.y, animalCount);

    const notes = [...terrainNotes, ...landmarkNotes];

    if (notes.length === 0) {
      return "特に目立った特徴はなく、比較的ひらけた地形のようです。";
    }
    return notes.join("。また、") + "。";
  } catch (e) {
    return "周辺の様子をうまく把握できませんでした。";
  }
}

// ==============================
// 資源探索(鉱石・木材・その他何でも)
// ==============================

/**
 * ブロックが探索条件に一致するかどうかを判定する。
 * @param {string} typeId 例: "minecraft:deepslate_iron_ore"
 * @param {"ore"|"wood"|"other"} category
 * @param {string[]} keywords 英単語の部分一致キーワード(小文字)
 */
function isCandidateBlock(typeId, category, keywords) {
  const id = typeId.replace("minecraft:", "").toLowerCase();

  const matchesKeyword = keywords.length === 0 || keywords.some((k) => k && id.includes(k));
  if (!matchesKeyword) return false;

  if (category === "ore") return id.includes("_ore");
  if (category === "wood") return isWoodBlockId(id);
  // "other" はキーワード一致だけで判定(何でも探せるようにするための汎用ルート)
  return true;
}

/**
 * プレイヤーの周辺(立方体半径radius)を非同期にスキャンする。
 * system.runJob でtickをまたいで処理することで、ラグを抑える。
 */
function scanCube(player, category, keywords, radius) {
  return new Promise((resolve) => {
    const center = {
      x: Math.floor(player.location.x),
      y: Math.floor(player.location.y),
      z: Math.floor(player.location.z)
    };
    const dim = player.dimension;
    const found = [];

    function* job() {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dz = -radius; dz <= radius; dz++) {
            try {
              const block = dim.getBlock({
                x: center.x + dx,
                y: center.y + dy,
                z: center.z + dz
              });
              if (block && isCandidateBlock(block.typeId, category, keywords)) {
                found.push({ dx, dy, dz, typeId: block.typeId });
              }
            } catch (e) {
              // 未読み込みチャンクやワールド境界外などは無視
            }
          }
          yield; // 1列処理するごとにyieldしてtick負荷を分散
        }
      }
      resolve(found);
    }

    system.runJob(job());
  });
}

/**
 * seed_knowledge.js に事前登録された情報の中から、カテゴリ・キーワードに一致し、
 * かつプレイヤーと同じディメンションにあるものの中で最も近いものを探す。
 * ライブでの検索(ブロックスキャン/findClosestBiome)が失敗・未発見だった場合のフォールバックに使う。
 */
function findInSeedKnowledge(player, category, keywords) {
  if (!Array.isArray(SEED_KNOWLEDGE) || SEED_KNOWLEDGE.length === 0) return null;

  const loc = player.location;
  const dimensionId = player.dimension.id.replace("minecraft:", "");
  let best = null;

  for (const entry of SEED_KNOWLEDGE) {
    if ((entry.dimensionId ?? "overworld") !== dimensionId) continue;
    if (category && entry.category !== category) continue;

    const label = String(entry.label ?? "").toLowerCase();
    const matches = keywords.length === 0 || keywords.some((k) => k && label.includes(k));
    if (!matches) continue;

    const dx = entry.x - loc.x;
    const dz = entry.z - loc.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (!best || dist < best.dist) {
      best = { entry, dx, dz, dist };
    }
  }

  return best;
}

/**
 * 鉱石・木材・その他何でも、指定されたキーワードの資源をプレイヤーの周囲から探す。
 * まず近距離(NEARBY_RADIUS)で探し、見つからなければ広域(EXTENDED_RADIUS)まで再探索する。
 * それでも見つからない場合は、seed_knowledge.jsの事前登録情報、
 * (木材ならさらに)生えやすいバイオームの方角を代わりに案内する。
 *
 * @param {import("@minecraft/server").Player} player
 * @param {"ore"|"wood"|"other"} category
 * @param {string[]} keywords
 * @returns {Promise<string>} Geminiへの状況descriptionに埋め込むテキスト
 */
export async function findResourceDirection(player, category, keywords) {
  console.warn(`[companion][search] ブロック検索開始: category=${category} keywords=${JSON.stringify(keywords)} radius=${CONFIG.NEARBY_RADIUS}`);

  let found = await scanCube(player, category, keywords, CONFIG.NEARBY_RADIUS);
  let extended = false;

  if (found.length === 0 && CONFIG.EXTENDED_RADIUS > CONFIG.NEARBY_RADIUS) {
    console.warn(`[companion][search] 近距離(${CONFIG.NEARBY_RADIUS})で0件のため、広域(${CONFIG.EXTENDED_RADIUS})を再検索`);
    found = await scanCube(player, category, keywords, CONFIG.EXTENDED_RADIUS);
    extended = true;
  }

  if (found.length > 0) {
    console.warn(`[companion][search] ブロック検索結果: ${found.length}件ヒット(extended=${extended})`);
    return summarizeDirection(found, extended, category);
  }

  console.warn(`[companion][search] ブロック検索結果: 0件`);

  if (category === "wood") {
    const biomeResult = tryFindBiomeDirection(player, keywords);
    if (biomeResult) return biomeResult;
  }

  const seedMatch = findInSeedKnowledge(player, category, keywords);
  if (seedMatch) {
    const dir = directionText(seedMatch.dx, seedMatch.dz);
    console.warn(
      `[companion][search] シード知識でヒット: ${seedMatch.entry.label} 座標=(${seedMatch.entry.x}, ${seedMatch.entry.y}, ${seedMatch.entry.z})`
    );
    return (
      `プレイヤーの近くでは見つかりませんでしたが、シード知識(外部ツールによる事前調査の推定情報。` +
      `実際に確認したわけではない)によると、「${seedMatch.entry.label}」が${dir}方向、` +
      `約${Math.round(seedMatch.dist)}ブロック先にあるようです。断定せず、推定であることが伝わる言い方で案内してください。`
    );
  }

  return (
    `半径${CONFIG.EXTENDED_RADIUS}ブロック以内では見つかりませんでした` +
    `(未読み込みのチャンクは検知できないため、実際にはもっと近くにある可能性もあります)。` +
    `座標や方角は分からないので、絶対に想像で答えないでください。`
  );
}

function summarizeDirection(found, extended, category) {
  found.sort((a, b) => a.dx * a.dx + a.dy * a.dy + a.dz * a.dz - (b.dx * b.dx + b.dy * b.dy + b.dz * b.dz));
  const nearest = found[0];
  const dir = directionText(nearest.dx, nearest.dz);
  const vertical =
    nearest.dy > 0 ? `${nearest.dy}ブロック上の方` : nearest.dy < 0 ? `${-nearest.dy}ブロック下の方` : "ほぼ同じ高さ";
  const dist = Math.round(Math.sqrt(nearest.dx * nearest.dx + nearest.dy * nearest.dy + nearest.dz * nearest.dz));
  const label = category === "ore" ? "鉱石" : category === "wood" ? "木材(丸太)" : "ブロック";
  const rangeNote = extended ? "近くにはなかったので、少し広い範囲まで探しました。" : "";
  const typeNote = nearest.typeId ? `(${nearest.typeId.replace("minecraft:", "")})` : "";

  return (
    `${label}${typeNote}が${found.length}個見つかりました。${rangeNote}` +
    `一番近いものは、プレイヤーから見て${dir}、${vertical}、直線距離で約${dist}ブロックの場所にあります。`
  );
}

function directionText(dx, dz) {
  // Minecraftの座標系: 北=-Z, 南=+Z, 東=+X, 西=-X
  const ns = dz < 0 ? "北" : dz > 0 ? "南" : "";
  const ew = dx > 0 ? "東" : dx < 0 ? "西" : "";
  const combined = ns + ew;
  return combined.length > 0 ? combined : "真上か真下";
}

/**
 * 候補となるバイオームID一覧の中から、プレイヤーに最も近いものを探す共通ヘルパー。
 * Dimension.findClosestBiome はバージョンによって仕様が変わりやすいベータ寄りのAPIのため、
 * 個々の候補で失敗しても無視して次を試す。
 * @returns {{biomeId: string, dx: number, dz: number, dist: number} | null}
 */
// dim.findClosestBiome がそもそも存在しない/関数ではない環境かどうかを一度判定したら記録しておく。
// バージョンによってはこのAPI自体が未実装のため、毎回エラーを踏むより早期に諦めて
// 「このバージョンでは対応していない」という正直な情報をAIに渡すようにする。
let biomeSearchSupported = null; // null=未確認, true/false=確認済み

function isBiomeSearchAvailable(dim) {
  if (biomeSearchSupported !== null) return biomeSearchSupported;
  biomeSearchSupported = typeof dim.findClosestBiome === "function";
  if (!biomeSearchSupported) {
    console.warn(
      "[companion][search] dimension.findClosestBiome が関数として存在しないため、バイオーム検索を無効化します" +
        "(このバージョンのScript APIでは未対応の可能性があります)"
    );
  }
  return biomeSearchSupported;
}

function findClosestBiomeAmong(dim, loc, biomeIds) {
  if (!isBiomeSearchAvailable(dim)) return null;

  let best = null;

  for (const rawId of biomeIds) {
    const biomeId = rawId.startsWith("minecraft:") ? rawId : `minecraft:${rawId}`;
    console.warn(`[companion][search] バイオーム検索: biome=${biomeId}`);
    try {
      const result = dim.findClosestBiome(loc, biomeId);
      if (result) {
        const dx = result.x - loc.x;
        const dz = result.z - loc.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        console.warn(`[companion][search] バイオーム検索結果: ${biomeId} を発見(距離 約${Math.round(dist)}ブロック)`);
        if (!best || dist < best.dist) {
          best = { biomeId, dx, dz, dist };
        }
      } else {
        console.warn(`[companion][search] バイオーム検索結果: ${biomeId} は見つからず`);
      }
    } catch (e) {
      console.warn(`[companion][search] バイオーム検索エラー: ${biomeId} (${e.message ?? e})`);
    }
  }

  return best;
}

/**
 * プレイヤーが「特定のバイオームそのもの」を探してほしいと依頼した場合に使う(category === "biome")。
 * ブロックスキャンは行わず、直接バイオーム検索を行う。
 * @param {import("@minecraft/server").Player} player
 * @param {string[]} keywords Geminiが判定したバイオームIDの候補(例: ["cherry_grove"])
 * @returns {string} Geminiへの状況descriptionに埋め込むテキスト
 */
export function findBiomeDirection(player, keywords) {
  console.warn(`[companion][search] バイオーム直接検索開始: keywords=${JSON.stringify(keywords)}`);
  const dim = player.dimension;
  const loc = player.location;

  if (isBiomeSearchAvailable(dim)) {
    const best = findClosestBiomeAmong(dim, loc, keywords);
    if (best) {
      const dir = directionText(best.dx, best.dz);
      return `「${best.biomeId.replace("minecraft:", "")}」バイオームが${dir}方向、約${Math.round(best.dist)}ブロック先に見つかりました。`;
    }
  }

  // ライブ検索が使えない、または見つからなかった場合はシード知識を確認する
  const seedMatch = findInSeedKnowledge(player, "biome", keywords);
  if (seedMatch) {
    const dir = directionText(seedMatch.dx, seedMatch.dz);
    console.warn(
      `[companion][search] シード知識でヒット: ${seedMatch.entry.label} 座標=(${seedMatch.entry.x}, ${seedMatch.entry.y}, ${seedMatch.entry.z})`
    );
    return (
      `このサーバーのライブ検索では見つけられませんでしたが、シード知識(外部ツールによる事前調査の推定情報。` +
      `実際に確認したわけではない)によると、「${seedMatch.entry.label}」が${dir}方向、` +
      `約${Math.round(seedMatch.dist)}ブロック先にあるようです。断定せず、推定であることが伝わる言い方で案内してください。`
    );
  }

  if (!isBiomeSearchAvailable(dim)) {
    return (
      "このサーバーのScript APIのバージョンでは、バイオームを直接検索する機能(findClosestBiome)が" +
      "利用できません。seed_knowledge.jsにも該当情報が登録されていません。座標や方角は分からないので、" +
      "正直に「その方法では調べられない」と伝えてください。絶対に座標や方角を想像で答えないでください。"
    );
  }

  return (
    "そのバイオームは見つけられませんでした" +
    "(遠くにあって探索範囲外の可能性があります)。座標や方角は分からないので、絶対に想像で答えないでください。"
  );
}

/**
 * 周辺に木材が見つからなかった場合、生えやすいバイオームの方角を探す(木材検索のフォールバック用)。
 */
function tryFindBiomeDirection(player, keywords) {
  const dim = player.dimension;
  const loc = player.location;

  const candidateIds = keywords.flatMap((kw) => WOOD_BIOME_HINTS[kw] ?? []);
  if (candidateIds.length === 0) return null;

  const best = findClosestBiomeAmong(dim, loc, candidateIds);
  if (!best) return null;

  const dir = directionText(best.dx, best.dz);
  return (
    `半径${CONFIG.EXTENDED_RADIUS}ブロック以内には見当たりませんでしたが、` +
    `この種類の木が生えやすい「${best.biomeId.replace("minecraft:", "")}」バイオームが` +
    `${dir}方向、約${Math.round(best.dist)}ブロック先に見つかりました。`
  );
}
