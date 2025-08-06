const customReplies = require('./customReplies');
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
          if (!event.message || !event.message.text) continue;

          const senderId = event.sender.id;
          const userMessage = event.message.text.trim();
          if (!userMessage) continue;

          // Get smart reply
          const finalReply = await getSmartReply(userMessage);

          await sendTypingOn(senderId);
          await new Promise(resolve => setTimeout(resolve, 1200));
          await sendReply(senderId, finalReply);
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

// === SMART REPLY FUNCTION ===
async function getSmartReply(userMessage) {
  try {
    const productList = customReplies.map((r, i) => ({
      id: i + 1,
      trigger: r.trigger,
      intro: r.reply.intro,
      image: r.reply.image,
      description: r.reply.description
    }));

    const systemPrompt = `
أنت أخصائي مبيعات وخبير استشارات في شركة SmartKidz المتخصصة في منتجات العناية بالشعر والبشرة للأطفال.
تتحدث باللهجة المصرية المحترمة والمهنية، وهدفك الرئيسي هو مساعدة العميل في اختيار المنتج المناسب من القائمة المرفقة.
إذا كان سؤال العميل مرتبطًا بأي منتج أو عرض من القائمة، اختر المنتج الأنسب وأرسل:
1. جملة الترحيب/المقدمة (intro)
2. رابط الصورة (image)
3. الوصف (description)
4. إضافة نصيحة أو توضيح بسيط منك لتشجيع الشراء

القائمة:
${JSON.stringify(productList, null, 2)}
`;

    const response = await axios.post(
      OPENAI_API_URL,
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.4
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error('Error from OpenAI:', err.response?.data || err.message);
    return "عذرًا، حصلت مشكلة مؤقتة. ممكن تحاول تاني؟";
  }
}

// === SEND TYPING INDICATOR ===
async function sendTypingOn(recipientId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, sender_action: 'typing_on' }
    );
  } catch (error) {
    console.error('Typing indicator error:', error.message);
  }
}

// === SEND REPLY (Supports image + text) ===
async function sendReply(recipientId, replyContent) {
  try {
    const parts = replyContent.split("\n").filter(p => p.trim());
    for (let part of parts) {
      if (part.startsWith("http")) {
        // Send image
        await axios.post(
          `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
          {
            recipient: { id: recipientId },
            message: {
              attachment: { type: 'image', payload: { url: part, is_reusable: true } }
            }
          }
        );
      } else {
        // Send text
        await axios.post(
          `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
          { recipient: { id: recipientId }, message: { text: part } }
        );
      }
    }
  } catch (error) {
    console.error('Messenger send error:', error.message);
  }
}

// === START SERVER ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
