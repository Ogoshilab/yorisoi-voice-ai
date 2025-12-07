// ===============================
// 寄り添い型 AI サーバ (Node + Express)
// 安全フィルタ・ICF推定・情動スコア・TTS対応
// ===============================

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { OpenAI } from "openai";
import fs from "fs";

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: "20mb" }));

// ====== OpenAI クライアント ======
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ====== 情動スコア（0〜100） ======
let emotionScore = 70;
let emotionHistory = [];

// ====== ICF タグ辞書 ======
const icfTags = JSON.parse(fs.readFileSync("./icf-tags.json", "utf8"));

// ====== ネガティブ／ポジティブ辞書 ======
const negativeWords = ["疲れ", "つらい", "不安", "悲しい", "こわい", "もうだめ", "消えたい", "死にたい", "いやだ"];
const positiveWords = ["うれしい", "楽しい", "安心", "大丈夫", "できた", "ありがとう", "ほっと"];

// ====== 危険キーワード ======
const dangerWords = ["死にたい", "消えたい", "自殺", "限界", "もう無理"];

// =========================================
// 情動スコア更新
// =========================================
function updateEmotionScore(text) {
  let score = emotionScore;

  for (const w of negativeWords) {
    if (text.includes(w)) score -= 5;
  }
  for (const w of positiveWords) {
    if (text.includes(w)) score += 5;
  }

  score = Math.max(0, Math.min(100, score));
  emotionScore = score;
  emotionHistory.push({ time: Date.now(), score });

  return score;
}

// =========================================
// ICF 推定
// =========================================
function detectICF(text) {
  const detected = [];

  if (text.includes("眠") || text.includes("寝")) detected.push(icfTags.sleep);
  if (text.includes("不安") || text.includes("怖")) detected.push(icfTags.emotion);
  if (text.includes("疲") || text.includes("忙")) detected.push(icfTags.stress);
  if (text.includes("勉強") || text.includes("テスト")) detected.push(icfTags.learning);
  if (text.includes("学校")) detected.push(icfTags.school);
  if (text.includes("友") || text.includes("人間関係")) detected.push(icfTags.relationships);
  if (text.includes("家") || text.includes("親")) detected.push(icfTags.family);
  if (text.includes("仕事") || text.includes("職場")) detected.push(icfTags.work);

  return detected;
}
// =========================================
// 危険キーワード検出
// =========================================
function detectDanger(text) {
  return dangerWords.some(w => text.includes(w));
}

// =========================================
// 危険時の安全メッセージ
// =========================================
function dangerResponse() {
  return (
    "今、とてもつらい気持ちなのですね。あなたの気持ちは大切で、" +
    "ひとりで抱えなくて大丈夫です。\n\n" +
    "安心できる大人や、信頼できる先生・家族と一緒に話してもらえると安全です。" +
    "私はここにいますが、命に関わる内容では専門家の力も必要です。\n\n" +
    "まずは深呼吸を一つしてみませんか？\n" +
    "吸う息を４つ数えながら、吐く息を６つ数えながら、ゆっくりで大丈夫です。"
  );
}

// =========================================
// 深呼吸誘導（安全版）
// =========================================
function breathingGuide() {
  return (
    "\n\n少しだけ呼吸を整える時間を一緒にとりましょう。" +
    "無理のない範囲で大丈夫です。\n" +
    "① 鼻から4秒かけて吸う\n" +
    "② 2秒そのまま\n" +
    "③ 口から6秒かけてゆっくり吐く\n" +
    "あなたのペースでOKですからね。"
  );
}

// =========================================
// OpenAI の会話（寄り添い仕様）
// =========================================
async function generateAIResponse(userText, icfList, emotionScore) {

  const systemPrompt = `
あなたは「寄り添い型AIパートナー」です。
・診断・指示命令・否定・価値観押しつけは禁止
・専門的判断（医療・法律）はしない
・子どもの気持ちを大切にし、安心感を優先
・ゆっくり優しく、相手の言葉を繰り返しながら共感する
・ICF情報があれば参考にしつつ、軽く触れる程度に
・emotionScoreが50未満のときは、落ち着かせる言葉を少し多めに入れる

【ICFヒント】
${icfList.map(x => `${x.code}:${x.label}`).join(", ")}

【emotionScore】
${emotionScore}
`;

  const chatRequest = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText }
    ],
    max_tokens: 200
  };

  const res = await client.chat.completions.create(chatRequest);
  return res.choices[0].message.content;
}
// =========================================
// 音声（TTS）生成
// =========================================
async function synthesizeVoice(text) {
  const speech = await client.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",         // 優しく落ち着いた声
    input: text
  });

  const buffer = Buffer.from(await speech.arrayBuffer());
  return buffer.toString("base64");
}

// =========================================
// メインAPI: /api/chat
// =========================================
app.post("/api/chat", async (req, res) => {
  try {
    const userText = req.body.message || "";

    // ---- 情動スコア更新 ----
    const score = updateEmotionScore(userText);

    // ---- ICF 推定 ----
    const icfList = detectICF(userText);

    // ---- 危険検知 ----
    if (detectDanger(userText)) {
      const safeText = dangerResponse();
      const voice = await synthesizeVoice(safeText);

      return res.json({
        text: safeText,
        audio: voice,
        danger: true,
        score,
        icf: icfList
      });
    }

    // ---- AI応答 ----
    let aiText = await generateAIResponse(userText, icfList, score);

    // emotionScore が低い時だけ深呼吸ガイドを追加
    if (score < 50) {
      aiText += breathingGuide();
    }

    // ---- 音声合成 ----
    const voice = await synthesizeVoice(aiText);

    return res.json({
      text: aiText,
      audio: voice,
      danger: false,
      score,
      icf: icfList
    });

  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// =========================================
// 情動スコア履歴API（オプション）
// =========================================
app.get("/api/emotion-history", (req, res) => {
  res.json(emotionHistory);
});
// =========================================
// サーバ起動
// =========================================
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("yorisoi-voice-ai server is running.");
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

