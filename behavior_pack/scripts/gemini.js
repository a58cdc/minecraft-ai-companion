import { http, HttpRequest, HttpRequestMethod, HttpHeader } from "@minecraft/server-net";
import { CONFIG } from "./config.js";
import {
  formatLongTermMemory,
  addLongTermMemory,
  removeLongTermMemory,
  formatLandmarks,
  addLandmark,
  removeLandmark
} from "./memory.js";
import { SEED_KNOWLEDGE } from "./seed_knowledge.js";

/**
 * seed_knowledge.js に書き込まれた、シードマップなど外部ツールによる事前調査情報を
 * プロンプトに埋め込むための文字列を作る。プレイヤー自身が発見したものではないため、
 * 「推定情報」であることが伝わる形式にしている。
 */
function formatSeedKnowledge() {
  if (!Array.isArray(SEED_KNOWLEDGE) || SEED_KNOWLEDGE.length === 0) {
    return "(まだ登録されていません)";
  }
  return SEED_KNOWLEDGE.map(
    (e) => `- ${e.label}(${e.category}) 座標(${e.x}, ${e.y}, ${e.z}) ${e.dimensionId ?? "overworld"}`
  ).join("\n");
}

// Gemini Function Calling で相棒に持たせる「道具」の定義。
// AI自身がこの2つの関数を呼び出すかどうかを判断する。
const TOOLS = [
  {
    function_declarations: [
      {
        name: "save_long_term_memory",
        description:
          "プレイヤーについて長期的に覚えておくべき重要な情報(好み、目標、約束、思い出、進行中のプロジェクトなど)を" +
          "短い一文で保存する。今後の会話でずっと参照される、相棒自身の『思い出ノート』への書き込み。",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "保存する内容。簡潔な日本語の一文でまとめること。"
            }
          },
          required: ["content"]
        }
      },
      {
        name: "forget_long_term_memory",
        description: "古くなった、間違っていた、あるいは不要になった長期記憶を1件削除する。",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "削除したい記憶のid(状況description内の[id:xxxx]の部分)"
            }
          },
          required: ["id"]
        }
      },
      {
        name: "save_landmark",
        description:
          "プレイヤーが言及した印象的な場所や環境(雪原、村、花畑、温泉、桜の木が見える場所、" +
          "ネザーゲートのような構造物など)を、実際の座標と一緒に記録する。後で『あの場所どこだっけ』と" +
          "聞かれたときに使うための地図メモ。座標はスクリプト側が自動で付与するので、あなたはlabelと" +
          "categoryだけを指定すればよい(座標を自分で考える必要はない)。",
        parameters: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "場所の短い名前(例: 雪エリア, 村, 花畑, 温泉, 桜の木, ネザーゲート風の構造物)"
            },
            category: {
              type: "string",
              description: "大まかな種別(例: snow, village, flower_field, hot_spring, cherry_tree, structure, other)"
            }
          },
          required: ["label", "category"]
        }
      },
      {
        name: "forget_landmark",
        description: "記録した場所の情報が古くなった・間違っていたと分かった場合に1件削除する。",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "削除したい場所のid(状況description内の[id:xxxx]の部分)"
            }
          },
          required: ["id"]
        }
      }
    ]
  }
];

async function callGeminiApi(body) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent` +
    `?key=${CONFIG.GEMINI_API_KEY}`;

  const request = new HttpRequest(url);
  request.method = HttpRequestMethod.Post;
  request.headers = [new HttpHeader("Content-Type", "application/json")];
  request.body = JSON.stringify(body);

  const response = await http.request(request);

  if (response.status !== 200) {
    throw new Error(`Gemini API error (status ${response.status}): ${response.body}`);
  }

  return JSON.parse(response.body);
}

function executeFunctionCall(playerName, functionCall, landmarkLocation) {
  const { name, args } = functionCall;

  let result;
  if (name === "save_long_term_memory") {
    const id = addLongTermMemory(playerName, args?.content ?? "");
    result = { status: "saved", id };
  } else if (name === "forget_long_term_memory") {
    const removed = removeLongTermMemory(playerName, args?.id ?? "");
    result = { status: removed ? "removed" : "not_found" };
  } else if (name === "save_landmark") {
    // 座標は必ずスクリプト側(実際のプレイヤー/視線の先の位置)から取る。AIの引数の数字は使わない。
    const loc = landmarkLocation ?? { x: 0, y: 0, z: 0, dimensionId: "overworld" };
    const id = addLandmark(playerName, {
      label: args?.label ?? "不明な場所",
      category: args?.category ?? "other",
      x: loc.x,
      y: loc.y,
      z: loc.z,
      dimensionId: loc.dimensionId
    });
    result = { status: "saved", id, x: Math.round(loc.x), y: Math.round(loc.y), z: Math.round(loc.z) };
  } else if (name === "forget_landmark") {
    const removed = removeLandmark(playerName, args?.id ?? "");
    result = { status: removed ? "removed" : "not_found" };
  } else {
    result = { status: "unknown_function" };
  }

  console.warn(
    `[companion][function-call] player=${playerName} name=${name} args=${JSON.stringify(args)} result=${JSON.stringify(result)}`
  );

  return result;
}

/**
 * Gemini APIへ会話をリクエストし、相棒の返答テキストを返す。
 * 長期記憶・場所の記録の読み書き(Function Calling)にも対応。
 *
 * @param {object} params
 * @param {string} params.playerName
 * @param {Array<{role: "user"|"model", text: string}>} params.history 直近の会話履歴
 * @param {string} params.userMessage 今回プレイヤーが言った/起きたイベントの説明
 * @param {string} params.situationText ゲーム内の状況description
 * @param {{x:number,y:number,z:number,dimensionId:string}} params.landmarkLocation
 *   save_landmark呼び出し時に使う実座標(視線の先、なければプレイヤーの現在地)
 * @returns {Promise<string>} 相棒の返答
 */
export async function askGemini({ playerName, history, userMessage, situationText, landmarkLocation }) {
  const longTermText = formatLongTermMemory(playerName);
  const landmarksText = formatLandmarks(playerName);
  const seedKnowledgeText = formatSeedKnowledge();

  const contents = history.map((turn) => ({
    role: turn.role,
    parts: [{ text: turn.text }]
  }));

  contents.push({
    role: "user",
    parts: [
      {
        text:
          `【長期記憶(あなた自身が過去に保存した、このプレイヤーに関する大事な記憶)】\n${longTermText}\n\n` +
          `【記録した場所のメモ(実座標。プレイヤーやあなた自身がこれまでに実際に発見・記録した場所。` +
          `「どこだっけ」と聞かれたら必ずここに書かれている座標だけを使って答える)】\n${landmarksText}\n\n` +
          `【シード知識(このワールドのシード値をもとに、外部のシードマップツールで事前に調べた推定情報。` +
          `プレイヤーもあなたもまだ実際には行っていない可能性がある座標。案内するときは断定せず、` +
          `『たぶんこの辺りのはず』『シード情報だとこの辺りらしいよ』のように、推定であることが伝わる言い方をすること)】\n` +
          `${seedKnowledgeText}\n\n` +
          `座標について: 上記どちらの一覧にも無い場所は、絶対に座標を作らず、正直に分からないと言うこと。\n\n` +
          `【今の状況】\n${situationText}\n\n` +
          `【プレイヤーの発言/イベント】\n${userMessage}`
      }
    ]
  });

  const baseBody = {
    system_instruction: { parts: [{ text: CONFIG.PERSONALITY_PROMPT }] },
    tools: TOOLS,
    generationConfig: { temperature: 0.9, maxOutputTokens: 300 }
  };

  const MAX_TOOL_ROUNDS = 3;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const json = await callGeminiApi({ ...baseBody, contents });
    const candidateContent = json?.candidates?.[0]?.content;
    const parts = candidateContent?.parts ?? [];

    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const textPart = parts
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text)
      .join("")
      .trim();

    if (functionCalls.length === 0) {
      console.warn(`[companion][function-call] player=${playerName} 関数呼び出しなし(通常の会話として応答)`);
      if (!textPart) throw new Error("Gemini APIから有効な返答が得られませんでした");
      return textPart;
    }

    // モデルが関数を呼び出した場合、その発言を履歴に積んでから結果を返す
    contents.push({ role: "model", parts });

    const functionResponseParts = functionCalls.map((fc) => ({
      functionResponse: {
        name: fc.name,
        response: executeFunctionCall(playerName, fc, landmarkLocation)
      }
    }));

    contents.push({ role: "user", parts: functionResponseParts });
  }

  throw new Error("長期記憶の処理が終わらず、規定回数内に返答を得られませんでした");
}

/**
 * プレイヤーの発言が「資源(鉱石・木材など)を探してほしい」という意図かどうかを判定し、
 * 対応するMinecraftのブロックIDに含まれそうな英単語キーワードを抽出する。
 * 会話の履歴は使わない、軽量な単発リクエスト。
 *
 * @param {string} userMessage
 * @returns {Promise<{category: "ore"|"wood"|"other"|"none", keywords: string[]}>}
 */
export async function identifyResourceQuery(userMessage) {
  const prompt =
    "次のマインクラフト(統合版)プレイヤーの発言が、相棒に対して" +
    "「今からプレイヤーの周囲(ブロックまたはバイオーム)を探してほしい」という『依頼』かどうかを判定してください。\n" +
    "重要: 既に見つけたことの『報告』や、ただの世間話・独り言は依頼ではありません。次の判定例を参考にしてください。\n" +
    "- 「近くにダイヤある？」→ 依頼(ore, keywords:[\"diamond\"])\n" +
    "- 「鉄どこにあるか探して」→ 依頼(ore, keywords:[\"iron\"])\n" +
    "- 「オークの木ある？」→ 依頼(wood, keywords:[\"oak\"])\n" +
    "- 「桜バイオームある？」→ 依頼(biome, keywords:[\"cherry_grove\"])\n" +
    "- 「近くに砂漠ある？」→ 依頼(biome, keywords:[\"desert\"])\n" +
    "- 「ジャングルは近く？」→ 依頼(biome, keywords:[\"jungle\"])\n" +
    "- 「ここにダイヤあるよ」→ 依頼ではない、報告(none)\n" +
    "- 「さっき探してたんだけど見つけたよ」→ 依頼ではない、報告(none)\n" +
    "- 「この家いいでしょ」→ 依頼ではない(none)\n" +
    "依頼だと判定した場合のみ、種別とキーワードを判定してください。\n" +
    "種別は次のいずれか:\n" +
    "  \"ore\"(鉱石) / \"wood\"(木材・丸太) / \"biome\"(特定のバイオームそのものを探したい) / \"other\"(その他のブロック)\n" +
    "keywordsについて:\n" +
    "  ore/wood/other の場合: 対応するMinecraft Bedrock版のブロックIDに含まれそうな英単語を1〜3個" +
    "(すべて小文字、例: iron, oak, coal, emerald, birch など)\n" +
    "  biome の場合: 対応するMinecraft Bedrock版のバイオームID(英語、すべて小文字、アンダースコア区切り、" +
    "\"minecraft:\"は付けない。例: cherry_grove, desert, jungle, mushroom_fields, ice_spikes など)を1〜3個。" +
    "確信が持てない場合は近い候補を複数挙げてよい。\n" +
    "依頼でなければ category を \"none\" にしてください。\n" +
    "出力は次のJSON形式のみとし、他の文章は一切含めないでください。\n" +
    '{"category": "ore"|"wood"|"biome"|"other"|"none", "keywords": ["文字列", ...]}\n\n' +
    `プレイヤーの発言: "${userMessage}"`;

  const json = await callGeminiApi({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json" }
  });

  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

  try {
    const parsed = JSON.parse(text);
    const result = {
      category: ["ore", "wood", "biome", "other"].includes(parsed.category) ? parsed.category : "none",
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map((k) => String(k).toLowerCase()) : []
    };
    console.warn(`[companion][search] 意図判定: category=${result.category} keywords=${JSON.stringify(result.keywords)}`);
    return result;
  } catch (e) {
    console.warn(`[companion][search] 意図判定: 解析失敗のためnone扱い`);
    return { category: "none", keywords: [] };
  }
}
