import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { askGemini, identifyResourceQuery } from "./gemini.js";
import { getHistory, appendTurn, isWatchEnabled, setWatchEnabled, recordLandmarkIfNew } from "./memory.js";
import {
  describeView,
  findResourceDirection,
  findBiomeDirection,
  getGazeBlock,
  getReferenceLocation,
  isWoodBlockId
} from "./perception.js";

const COMPANION_TAG = "§b[ナビ]§r";
const ERROR_TAG = "§c[ナビ/エラー]§r";

// プレイヤー名 -> 最後にやり取りしたtick(system.currentTick)
const lastInteractionTick = new Map();

// 資源探索の意図がありそうかどうかを軽くふるいにかけるヒントワード。
// これに引っかかったときだけ、追加でGeminiにキーワード抽出をリクエストする(無駄なAPI呼び出しを避けるため)。
const SEARCH_HINT_WORDS = [
  "ある", "あるかな", "どこ", "近く", "探して", "探し", "見つけ", "採れる",
  "座標", "位置", "場所", "方角", "方向"
];

function looksLikeResourceSearch(message) {
  return SEARCH_HINT_WORDS.some((w) => message.includes(w));
}

function isMaterialQuestion(message) {
  return CONFIG.MATERIAL_QUESTION_HINTS.some((w) => message.includes(w));
}

// ==============================
// チャット監視
// ==============================

function onIncomingChat(player, rawMessage, cancelFn) {
  const message = rawMessage.trim();

  cancelFn?.();

  // --- 見守りON/OFFコマンド(Gemini APIを呼ばず即座に応答する) ---
  if (CONFIG.WATCH_OFF_COMMANDS.includes(message)) {
    system.run(() => {
      setWatchEnabled(player.name, false);
      player.sendMessage(`${COMPANION_TAG} 見守りをオフにしたよ。呼びたいときはいつでも話しかけてね。`);
    });
    return;
  }
  if (CONFIG.WATCH_ON_COMMANDS.includes(message)) {
    system.run(() => {
      setWatchEnabled(player.name, true);
      lastInteractionTick.set(player.name, system.currentTick);
      player.sendMessage(`${COMPANION_TAG} 見守りをオンにしたよ。しばらく無言だったら声をかけるね。`);
    });
    return;
  }

  // イベントハンドラの外(次tick)で非同期処理を行う
  system.run(() => handlePlayerMessage(player, message));
}

// お使いのBDS/Script APIのバージョンによって chatSend イベントの有無や場所が異なることがあるため、
// 存在チェックをしたうえで安全に購読する。beforeEvents が使えない場合は afterEvents にフォールバックする
// (その場合、メッセージのキャンセル=非公開チャット化はできない)。
if (world.beforeEvents && world.beforeEvents.chatSend) {
  world.beforeEvents.chatSend.subscribe((ev) => {
    onIncomingChat(ev.sender, ev.message, () => {
      ev.cancel = true;
    });
  });
} else if (world.afterEvents && world.afterEvents.chatSend) {
  console.warn(
    "[companion] world.beforeEvents.chatSend が見つからなかったため、world.afterEvents.chatSend にフォールバックしました。" +
      "この場合、プレイヤーのメッセージを非公開にする(キャンセルする)ことはできません。" +
      "@minecraft/server のバージョンをご確認ください。"
  );
  world.afterEvents.chatSend.subscribe((ev) => {
    onIncomingChat(ev.sender, ev.message, null);
  });
} else {
  console.warn(
    "[companion] chatSend イベント(beforeEvents/afterEvents どちらも)が見つかりませんでした。" +
      "@minecraft/server のバージョンが manifest.json の想定と異なる可能性があります。"
  );
}

// ==============================
// 木材伐採の自動記録
// ==============================
// プレイヤーが木材(丸太など)を伐採したら、自動的に場所として記録する。
// 同じ木を何度も叩くことによる記録の埋め尽くしを防ぐため、広め・長めの重複除去を行う。
if (world.afterEvents && world.afterEvents.playerBreakBlock) {
  world.afterEvents.playerBreakBlock.subscribe((ev) => {
    try {
      const brokenId = ev.brokenBlockPermutation?.type?.id;
      if (!brokenId) return;

      const id = brokenId.replace("minecraft:", "");
      if (!isWoodBlockId(id)) return;

      const loc = ev.block.location;
      const dimensionId = ev.player.dimension.id.replace("minecraft:", "");

      recordLandmarkIfNew(
        ev.player.name,
        { label: id, category: "wood", x: loc.x, y: loc.y, z: loc.z, dimensionId },
        CONFIG.WOOD_LANDMARK_DEDUPE_RADIUS,
        CONFIG.WOOD_LANDMARK_DEDUPE_MINUTES
      );
    } catch (e) {
      console.warn(`[companion] playerBreakBlock処理エラー: ${e}`);
    }
  });
} else {
  console.warn(
    "[companion] world.afterEvents.playerBreakBlock が見つからないため、木材伐採の自動記録は無効です。"
  );
}

async function handlePlayerMessage(player, message) {
  lastInteractionTick.set(player.name, system.currentTick);

  let situationText;
  const isLookCommand = message.includes("見て");
  const isMaterialQ = isMaterialQuestion(message);

  if (isLookCommand || isMaterialQ) {
    situationText = await describeView(player);
    recordGazedMaterialIfApplicable(player, isMaterialQ);
  } else if (looksLikeResourceSearch(message)) {
    situationText = await buildResourceSearchSituation(player, message);
  } else {
    situationText = await describeView(player);
  }

  await reply(player, message, situationText, { saveUserTurn: true });
}

/**
 * 「見て」「これ何?」のタイミングで視線の先の素材を自動記録する。
 * - 視線の先が木材系ブロックなら常に記録(category: "wood")
 * - 「これ何?」で聞かれた場合は、木材かどうかに関わらず記録(category: "material_asked")
 */
function recordGazedMaterialIfApplicable(player, isMaterialQ) {
  const gaze = getGazeBlock(player);
  if (!gaze) return;

  const id = gaze.typeId.replace("minecraft:", "");
  const dimensionId = player.dimension.id.replace("minecraft:", "");
  const loc = gaze.location;

  if (isWoodBlockId(id)) {
    recordLandmarkIfNew(
      player.name,
      { label: id, category: "wood", x: loc.x, y: loc.y, z: loc.z, dimensionId },
      CONFIG.WOOD_LANDMARK_DEDUPE_RADIUS,
      CONFIG.WOOD_LANDMARK_DEDUPE_MINUTES
    );
  }

  if (isMaterialQ) {
    recordLandmarkIfNew(
      player.name,
      { label: id, category: "material_asked", x: loc.x, y: loc.y, z: loc.z, dimensionId },
      CONFIG.MATERIAL_LANDMARK_DEDUPE_RADIUS,
      CONFIG.MATERIAL_LANDMARK_DEDUPE_MINUTES
    );
  }
}

async function buildResourceSearchSituation(player, message) {
  const base = await describeView(player);

  try {
    const query = await identifyResourceQuery(message);
    if (query.category === "none" || query.keywords.length === 0) {
      // 探索の意図ではなかった(例: 「ここにダイヤあるよ」のような報告や世間話)ので、
      // 何も追加のメッセージは出さず通常の会話として処理する
      return base;
    }

    // ここまで来て初めて「本当に探索してほしい」と判定されたので、待ってねメッセージを出す
    player.sendMessage(`${COMPANION_TAG} ちょっと待ってね、周りを探してみる…`);

    const scanResult =
      query.category === "biome"
        ? findBiomeDirection(player, query.keywords)
        : await findResourceDirection(player, query.category, query.keywords);

    return `${base}\n\n【探索結果】\n${scanResult}`;
  } catch (e) {
    // 探索フェーズでのエラーはチャットに通知しつつ、通常の会話は継続する
    player.sendMessage(`${ERROR_TAG} 探索中にエラーが発生しました: ${formatError(e)}`);
    return base;
  }
}

// ==============================
// 無言の見守りループ
// ==============================
system.runInterval(() => {
  for (const player of world.getPlayers()) {
    if (!isWatchEnabled(player.name)) continue;

    const last = lastInteractionTick.get(player.name);

    if (last === undefined) {
      // ログイン直後は基準時刻を記録するだけにする
      lastInteractionTick.set(player.name, system.currentTick);
      continue;
    }

    const idleTicks = system.currentTick - last;
    if (idleTicks >= CONFIG.IDLE_TICKS) {
      // 連続で話しかけ続けないよう、ここで基準時刻をリセットしておく
      lastInteractionTick.set(player.name, system.currentTick);
      system.run(() => sendProactiveMessage(player));
    }
  }
}, CONFIG.WATCH_INTERVAL_TICKS);

async function sendProactiveMessage(player) {
  const situationText = await describeView(player, { isIdleCheck: true });
  const prompt =
    `プレイヤーは最後の会話から${CONFIG.IDLE_MINUTES}分ほど何も話していません。` +
    `詮索しすぎない自然な一言で、そっと話しかけてください。`;

  await reply(player, prompt, situationText, { saveUserTurn: false });
}

// ==============================
// 共通の応答処理
// ==============================
async function reply(player, userMessage, situationText, { saveUserTurn }) {
  const history = getHistory(player.name);
  const landmarkLocation = getReferenceLocation(player);

  try {
    const answer = await askGemini({ playerName: player.name, history, userMessage, situationText, landmarkLocation });
    player.sendMessage(`${COMPANION_TAG} ${answer}`);

    if (saveUserTurn) {
      appendTurn(player.name, "user", userMessage);
    }
    appendTurn(player.name, "model", answer);
  } catch (e) {
    console.warn(`[companion] Gemini呼び出し失敗: ${e}`);
    player.sendMessage(`${ERROR_TAG} APIとの通信でエラーが発生しました: ${formatError(e)}`);
  }
}

function formatError(e) {
  const msg = String(e?.message ?? e);
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

console.warn("[companion] AI Companion スクリプトが読み込まれました。");
