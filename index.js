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

          // Ignore non-text events like delivery receipts or read confirmations
          if (!event.message || !event.message.text || event.delivery || event.read) {
            continue;
          }

          const userMessage = event.message.text.trim();
          if (!userMessage) continue;

          // 1. Try custom replies (exact match first, then partial)
          const matchedReply = getBestReply(userMessage);

          // 2. If no custom reply, use GPT
          const finalReply = matchedReply?.reply || await getGPTReply(userMessage);

          console.log("✅ Final reply:", finalReply);

          await sendTypingOn(senderId);
          await new Promise(res => setTimeout(res, 1500)); // Simulate thinking
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

// === GET GPT REPLY (Professional Egyptian Sales Style) ===
async function getGPTReply(userMessage) {
  try {
    const response = await axios.post(
      OPENAI_API_URL,
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `
أنت أخصائي مبيعات وخبير استشارات في شركة SmartKidz المتخصصة في منتجات العناية بالشعر والبشرة للأطفال. 
تتحدث باللهجة المصرية الرسمية والمحترمة، مع لمسة ود ودافئ، بدون أي عبارات عامية مبالغ فيها أو مصطلحات غير مألوفة.
هدفك الأساسي هو بيع منتجات SmartKidz وإبراز فوائدها ومميزاتها كما هي محفوظة في ملف customReplies.js، 
مع تقديم معلومات علمية موثوقة ونصائح عملية للآباء والأمهات.

التوجيهات:
- اربط أي إجابة بمنتج من منتجات الشركة، حتى لو السؤال عام.
- إذا كان السؤال عن الشعر أو البشرة للأطفال، قدم نصائح عملية وأدرج منتج من الشركة كجزء من الحل.
- لا تستخدم لغة سوقية أو تعبيرات غير لائقة.
- اجعل الرد قصيرًا ومباشرًا، ويشجع العميل على اتخاذ خطوة شراء أو تجربة المنتج.

🔹 مثال:
المستخدم: ابني شعره بيقصف بعد البحر.
الرد: للحفاظ على شعر طفلك بعد البحر، أنصحك باستخدام شامبو SmartKidz المغذي لأنه بيشيل آثار الملح وبيحافظ على ترطيب الشعر. ومعاه بلسم SmartKidz هتلاقي فرق ملحوظ في النعومة والحيوية.
            `
          },
          {
            role: 'user',
            content: userMessage
          }
        ],
        temperature: 0.3 // Consistent, professional tone
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
    console.error('Error from OpenAI:', err.response?.data || err.message);
    return "حدثت مشكلة أثناء محاولة الرد. من فضلك حاول مرة أخرى.";
  }
}

// === MATCH CUSTOM REPLIES DIRECTLY ===
function getBestReply(userMessage) {
  const lowerMsg = userMessage.toLowerCase().trim();

  // Exact match first
  let exactMatch = customReplies.find(r => lowerMsg === r.trigger.toLowerCase());
  if (exactMatch) return { reply: exactMatch.reply };

  // Partial match second
  let partialMatch = customReplies.find(r => lowerMsg.includes(r.trigger.toLowerCase()));
  return partialMatch ? { reply: partialMatch.reply } : null;
}

// === SEND TYPING INDICATOR ===
async function sendTypingOn(recipientId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        sender_action: "typing_on"
      }
    );
  } catch (error) {
    console.error('❌ Typing indicator error:', error.response?.data || error.message);
  }
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
