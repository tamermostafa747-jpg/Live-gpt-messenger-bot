const customReplies = require('./customReplies');

// GPT-Messenger Bot - index.js

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === CONFIG ===
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// === VERIFY WEBHOOK ===
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// === HANDLE INCOMING MESSAGES ===
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'page') {
      for (const entry of body.entry) {
        for (const event of entry.messaging) {
          console.log('📩 Incoming event:', event);

          const senderId = event.sender.id;

          if (!event.message || !event.message.text) {
            console.log("Unsupported or empty message received.");
            continue;
          }

          const userMessage = event.message.text.trim();
          if (!userMessage) continue;

          // 1. Try custom replies
          const matchedReply = getBestReply(userMessage);

          // 2. Use GPT if no custom match
          const finalReply = matchedReply?.reply || await getGPTReply(userMessage);

          console.log("✅ Final reply:", finalReply);
          await sendMessage(senderId, finalReply);
        }
      }

      return res.sendStatus(200);
    } else {
      return res.sendStatus(404);
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// === GET GPT REPLY (Locked Egyptian Sales Style) ===
async function getGPTReply(userMessage) {
  try {
    const response = await axios.post(
      OPENAI_API_URL,
      {
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `
أنت أخصائي في شركة SmartKidz المتخصصة في منتجات العناية بالشعر والبشرة للأطفال. 
تتحدث باللهجة المصرية الخالصة وبأسلوب محترم ورسمي لكن ودود، مع استخدام تعبيرات مألوفة للأهالي في مصر. 
هدفك الأساسي هو بيع منتجات SmartKidz وإبراز مميزاتها وفوائدها، كما هي محفوظة في ملف customReplies.js، 
وتحاول دائمًا ربط أي إجابة بمنتج من منتجات الشركة حتى لو السؤال عام. 
إذا كان السؤال عن الشعر أو البشرة للأطفال، قدم نصائح بسيطة وأدرج منتج من منتجات الشركة كجزء من الحل. 
ابتعد تمامًا عن اللغة الفصحى أو المصطلحات الغريبة، واستخدم كلمات سهلة وعملية. 
حافظ على أن يكون كلامك قصير ومباشر ويشجع العميل على الشراء أو التجربة.
          `
          },
          {
            role: 'user',
            content: userMessage
          }
        ],
        temperature: 0.4 // Lower temp for consistent tone
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    const reply = response.data.choices[0].message.content.trim();
    console.log("🤖 GPT reply:", reply);
    return reply;

  } catch (err) {
    console.error('Error from OpenAI:', err.message);
    return "حصلت مشكلة أثناء محاولة الرد. ممكن تجرب تاني؟";
  }
}

// === MATCH CUSTOM REPLIES DIRECTLY ===
function getBestReply(userMessage) {
  const lowerMsg = userMessage.toLowerCase();
  const match = customReplies.find(r =>
    lowerMsg.includes(r.trigger.toLowerCase())
  );
  return match ? { reply: match.reply } : null;
}

// === SEND MESSAGE TO FACEBOOK MESSENGER ===
async function sendMessage(recipientId, message) {
  try {
    if (!message || !message.trim()) {
      console.log("⚠️ Empty message detected, skipping send.");
      return;
    }

    await axios.post(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { text: message }
      }
    );

    console.log(`✅ Message sent to ${recipientId}:`, message);

  } catch (error) {
    console.error(
      '❌ Messenger send error:',
      error.response?.data || error.message
    );
  }
}

// === START SERVER ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

