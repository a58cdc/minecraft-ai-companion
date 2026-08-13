import { world } from "@minecraft/server";
import { CONFIG } from "./config.js";

// Dynamic Propertyはワールドのセーブデータに紐づいて保存されるため、
// サーバーを再起動しても、プレイヤーが日をまたいでログインし直しても記憶が残る。

function storageKey(playerName) {
  // プレイヤー名をキーにすることで、ログイン毎にIDが変わっても記憶を追跡できるようにする
  return `companion_mem_${playerName}`;
}

/**
 * プレイヤーの会話履歴を取得する
 */
export function getHistory(playerName) {
  const raw = world.getDynamicProperty(storageKey(playerName));
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn(`[companion] memory parse error for ${playerName}: ${e}`);
    return [];
  }
}

/**
 * 会話ターンを1つ追記し、上限を超えた古い履歴は捨てる
 */
export function appendTurn(playerName, role, text) {
  const history = getHistory(playerName);
  history.push({ role, text: String(text).slice(0, 600) });

  while (history.length > CONFIG.MAX_HISTORY_TURNS) {
    history.shift();
  }

  const serialized = JSON.stringify(history);

  // Dynamic Propertyの1件あたりのサイズには上限があるため、
  // 万一超えそうな場合は古い履歴をさらに間引く安全策
  if (serialized.length > 30000) {
    while (history.length > 6 && JSON.stringify(history).length > 30000) {
      history.shift();
    }
  }

  world.setDynamicProperty(storageKey(playerName), JSON.stringify(history));
}

/**
 * 記憶を消したいとき用(デバッグ・テスト用)
 */
export function clearHistory(playerName) {
  world.setDynamicProperty(storageKey(playerName), undefined);
}

// ==============================
// 見守り(自発的な声かけ)のON/OFF
// ==============================
function watchKey(playerName) {
  return `companion_watch_${playerName}`;
}

/**
 * 見守りが有効かどうか。未設定(初回)の場合はデフォルトでON扱い。
 */
export function isWatchEnabled(playerName) {
  const raw = world.getDynamicProperty(watchKey(playerName));
  return raw !== "off";
}

export function setWatchEnabled(playerName, enabled) {
  world.setDynamicProperty(watchKey(playerName), enabled ? "on" : "off");
}

// ==============================
// 長期記憶(AIが自律的に読み書きする領域)
// ==============================
// 短期記憶(直近の会話ターン)とは別に保存する、プレイヤーごとの「思い出ノート」。
// AI自身がGeminiのFunction Callingを通じて、書き込み/削除するかどうかを判断する。

function longTermKey(playerName) {
  return `companion_longmem_${playerName}`;
}

let idCounter = 0;

/**
 * 長期記憶の一覧を取得する。 [{id, text, updatedAt}, ...]
 */
export function getLongTermMemory(playerName) {
  const raw = world.getDynamicProperty(longTermKey(playerName));
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn(`[companion] long-term memory parse error for ${playerName}: ${e}`);
    return [];
  }
}

function saveLongTermMemoryList(playerName, list) {
  world.setDynamicProperty(longTermKey(playerName), JSON.stringify(list));
}

/**
 * 長期記憶を1件追加する。上限を超えたら古いものから自動的に間引く。
 * @returns {string} 追加した記憶のid
 */
export function addLongTermMemory(playerName, content) {
  const list = getLongTermMemory(playerName);
  const id = `m${Date.now().toString(36)}${idCounter++ % 1000}`;
  list.push({ id, text: String(content).slice(0, 300), updatedAt: Date.now() });

  while (list.length > CONFIG.MAX_LONG_TERM_ENTRIES) {
    list.shift();
  }

  saveLongTermMemoryList(playerName, list);
  return id;
}

/**
 * idを指定して長期記憶を1件削除する
 * @returns {boolean} 削除できたらtrue
 */
export function removeLongTermMemory(playerName, id) {
  const list = getLongTermMemory(playerName);
  const next = list.filter((m) => m.id !== id);
  const removed = next.length !== list.length;
  if (removed) saveLongTermMemoryList(playerName, next);
  return removed;
}

/**
 * プロンプトに埋め込むための文字列を作る
 */
export function formatLongTermMemory(playerName) {
  const list = getLongTermMemory(playerName);
  if (list.length === 0) return "(まだ長期記憶はありません)";
  return list.map((m) => `- [id:${m.id}] ${m.text}`).join("\n");
}

// ==============================
// 場所の記録(landmark) - 実座標付きの「あの場所どこだっけ」メモ
// ==============================
// 短期記憶・長期記憶とは別に保存する、プレイヤーごとの「地図メモ」。
// 木材の伐採、「見て」で見た木、「これ何?」で聞かれた素材はスクリプト側が自動で記録し、
// 雪原・村・花畑などの環境の言及はAIがsave_landmark関数を通じて記録する。
// 座標は必ずスクリプト側(実際のプレイヤー/ブロックの位置)から取得し、AIには数字を作らせない。

function landmarkKey(playerName) {
  return `companion_landmarks_${playerName}`;
}

let landmarkIdCounter = 0;

/**
 * 場所の記録一覧を取得する。 [{id, label, category, x, y, z, dimensionId, createdAt}, ...]
 */
export function getLandmarks(playerName) {
  const raw = world.getDynamicProperty(landmarkKey(playerName));
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn(`[companion] landmark parse error for ${playerName}: ${e}`);
    return [];
  }
}

function saveLandmarkList(playerName, list) {
  world.setDynamicProperty(landmarkKey(playerName), JSON.stringify(list));
}

function pushLandmark(playerName, entry) {
  const list = getLandmarks(playerName);
  const id = `l${Date.now().toString(36)}${landmarkIdCounter++ % 1000}`;
  list.push({ id, ...entry, createdAt: Date.now() });

  while (list.length > CONFIG.MAX_LANDMARKS) {
    list.shift();
  }

  saveLandmarkList(playerName, list);
  return id;
}

/**
 * 場所を1件記録する(AIのsave_landmark関数呼び出し用)。
 * @returns {string} 追加した記録のid
 */
export function addLandmark(playerName, { label, category, x, y, z, dimensionId }) {
  return pushLandmark(playerName, {
    label: String(label).slice(0, 60),
    category: String(category ?? "other").slice(0, 30),
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z),
    dimensionId: dimensionId ?? "overworld"
  });
}

/**
 * 近くに同じカテゴリ・ラベルの記録が(dedupeRadius以内・dedupeMinutes以内に)既にあれば、
 * 新規追加せずスキップする(伐採の連打などで記録が埋め尽くされるのを防ぐ)。
 * スクリプト側の自動記録(木材の伐採、「見て」で見た木、「これ何?」の素材)で使う。
 *
 * @returns {{added: boolean, id: string}}
 */
export function recordLandmarkIfNew(playerName, { label, category, x, y, z, dimensionId }, dedupeRadius, dedupeMinutes) {
  const list = getLandmarks(playerName);
  const now = Date.now();
  const dedupeMs = dedupeMinutes * 60000;

  const existing = list.find(
    (l) =>
      l.category === category &&
      l.label === label &&
      l.dimensionId === dimensionId &&
      now - l.createdAt < dedupeMs &&
      Math.abs(l.x - x) <= dedupeRadius &&
      Math.abs(l.y - y) <= dedupeRadius &&
      Math.abs(l.z - z) <= dedupeRadius
  );

  if (existing) {
    console.warn(
      `[companion][landmark] 重複のためスキップ: player=${playerName} label=${label} category=${category} (既存id=${existing.id})`
    );
    return { added: false, id: existing.id };
  }

  const id = pushLandmark(playerName, {
    label: String(label).slice(0, 60),
    category: String(category).slice(0, 30),
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z),
    dimensionId
  });

  console.warn(
    `[companion][landmark] 記録: player=${playerName} label=${label} category=${category} 座標=(${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}) id=${id}`
  );

  return { added: true, id };
}

/**
 * idを指定して場所の記録を1件削除する
 * @returns {boolean} 削除できたらtrue
 */
export function removeLandmark(playerName, id) {
  const list = getLandmarks(playerName);
  const next = list.filter((l) => l.id !== id);
  const removed = next.length !== list.length;
  if (removed) saveLandmarkList(playerName, next);
  return removed;
}

/**
 * プロンプトに埋め込むための文字列を作る(新しい順)
 */
export function formatLandmarks(playerName) {
  const list = getLandmarks(playerName);
  if (list.length === 0) return "(まだ記録された場所はありません)";

  return list
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((l) => {
      const agoMin = Math.round((Date.now() - l.createdAt) / 60000);
      const agoText = agoMin < 1 ? "たった今" : agoMin < 60 ? `${agoMin}分前` : `${Math.round(agoMin / 60)}時間前`;
      return `- [id:${l.id}] ${l.label}(${l.category}) 座標(${l.x}, ${l.y}, ${l.z}) ${l.dimensionId} — ${agoText}`;
    })
    .join("\n");
}
