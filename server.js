// server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Client, middleware } = require("@line/bot-sdk");
const { google } = require("googleapis");

const app = express();
const port = process.env.PORT || 3000;

// LINE Bot config
const lineConfig = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new Client(lineConfig);

app.use(middleware(lineConfig));
app.use(express.json());

// Context per user
const userContext = {};

// Google Sheets append
async function appendToSheet(userMessage, aiReply) {
  try {
    if (!process.env.GOOGLE_PRIVATE_KEY) return;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
    const auth = new google.auth.JWT(
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      privateKey,
      ["https://www.googleapis.com/auth/spreadsheets"]
    );
    await auth.authorize();
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      requestBody: { values: [[new Date().toISOString(), userMessage, aiReply]] },
    });
  } catch (err) {
    console.error("❌ Google Sheet error:", err?.message || err);
  }
}

// Helpers
function detectCause(message) {
  if (!message) return false;
  const keywords = ["เครียด", "เรียนหนัก", "การบ้าน", "งานเยอะ", "นอนไม่พอ"];
  return keywords.some(k => message.includes(k));
}
function detectViolence(message) {
  if (!message) return false;
  const keywords = ["ตบ", "ตี", "ทำร้าย"];
  return keywords.some(k => message.includes(k));
}
const randomChoice = arr => arr[Math.floor(Math.random() * arr.length)];

// Webhook
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  if (!events.length) return res.status(200).send("No events");

  try {
    await Promise.all(events.map(async (event) => {
      if (event.type !== "message" || event.message.type !== "text") return;

      const userMessage = event.message.text.trim();
      const userId = event.source?.userId || "unknown_user";

      if (!userContext[userId]) {
        userContext[userId] = {
          conversation: "",
          hasProvidedCause: false,
          lastAiReply: "",
          providedAdvice: false,
          seriousIncident: false
        };
      }
      const ctx = userContext[userId];
      ctx.conversation += "\n" + userMessage;

      let aiReply = "";

      // greeting / thanks / bye
      const greetingKeywords = ["สวัสดี", "hi", "hello"];
      const thanksKeywords = ["ขอบคุณ", "thanks"];
      const byeKeywords = ["ลาก่อน", "bye"];

      if (greetingKeywords.some(w => userMessage.includes(w))) {
        aiReply = randomChoice([
          "🌸 สวัสดีครับ/ค่ะ มีอะไรให้ผมช่วยคุณมั้ย?",
          "😊 สวัสดีครับ/ค่ะ ยินดีต้อนรับครับ!"
        ]);
      } else if (thanksKeywords.some(w => userMessage.includes(w))) {
        aiReply = randomChoice([
          "😄 ด้วยความยินดีครับ/ค่ะ",
          "😊 ยินดีครับ/ค่ะ มีอะไรให้ช่วยต่อไหม?"
        ]);
      } else if (byeKeywords.some(w => userMessage.includes(w))) {
        aiReply = randomChoice([
          "🌞 ขอให้คุณมีวันที่ดีครับ/ค่ะ แล้วเจอกันใหม่!",
          "😊 ดูแลตัวเองด้วยนะครับ/ค่ะ"
        ]);
      } else if (detectViolence(userMessage)) {
        ctx.seriousIncident = true;
        ctx.providedAdvice = true;
        aiReply = `ผมเข้าใจว่าคุณเสียใจและกังวลมากครับ/ค่ะ
หากใครได้รับบาดเจ็บ รีบติดต่อฉุกเฉินทันที
หากมีความเสี่ยงต่อความปลอดภัย ควรติดต่อเจ้าหน้าที่
หากคุณอยากทำร้ายตัวเองหรือผู้อื่น โปรดโทรฉุกเฉินเดี๋ยวนั้นครับ/ค่ะ`;
      } else if (!ctx.hasProvidedCause) {
        // Ask one concise follow-up
        aiReply = randomChoice([
          "ขอโทษครับ/ค่ะ ช่วยบอกสั้น ๆ ว่าอะไรทำให้คุณเครียดตอนนี้?",
          "ช่วยบอกหน่อยครับ/ค่ะ ปัญหาหลักของคุณคืออะไร?"
        ]);
        ctx.hasProvidedCause = true;
      } else if (!ctx.providedAdvice) {
        // Provide advice using AI
        const headers = {};
        if (process.env.OLLAMA_API_KEY) headers["Authorization"] = `Bearer ${process.env.OLLAMA_API_KEY}`;

        const prompt = `คุณคือจิตแพทย์ออนไลน์
ผู้ใช้ได้ระบุปัญหาแล้ว ให้คำแนะนำเชิงปฏิบัติที่เหมาะสมและสั้น (3-5 ข้อความ)
เน้นสิ่งที่ผู้ใช้ทำได้ทันที เช่น การจัดเวลา เทคนิคการพักผ่อน วิธีผ่อนคลาย
ตอบเป็นภาษาไทยเท่านั้น
ห้ามขึ้นต้นด้วยสวัสดีหรือ emoji

บริบทผู้ใช้:
${ctx.conversation}

ให้คำแนะนำสั้น ๆ และกำลังใจสั้น ๆ`;

        try {
          const response = await axios.post(
            "http://localhost:11434/api/generate",
            { model: "llama3:8b", prompt, stream: false },
            { headers }
          );
          aiReply = response?.data?.response || "ขอโทษครับ เกิดปัญหาในการประมวลผล";
          ctx.providedAdvice = true;

          // ✂️ ลบ greeting ถ้ามี (กันพลาด)
          aiReply = aiReply.replace(/^(สวัสดี|🌸|😊|🌞)\s*/g, "").trim();

        } catch (err) {
          console.error("❌ AI error:", err?.message || err);
          aiReply = "ขอโทษครับ เกิดข้อผิดพลาดในการประมวลผลข้อความของคุณ";
        }
      }

      // prevent exact repeat
      if (ctx.lastAiReply === aiReply) aiReply += " (ผมพร้อมฟังต่อครับ/ค่ะ)";
      ctx.lastAiReply = aiReply;

      // reply
      try {
        await lineClient.replyMessage(event.replyToken, { type: "text", text: aiReply });
      } catch (err) {
        console.error("❌ LINE reply failed:", err?.message || err);
      }

      // log sheet (non-blocking)
      appendToSheet(userMessage, aiReply);
    }));

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err?.message || err);
    res.status(500).send("Internal Server Error");
  }
});

app.listen(port, () => console.log(`🚀 Server running at http://localhost:${port}`));
