const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const customReplies = require('./customReplies');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === CONFIG ===
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const GPT_MODEL = 'gpt-4o'; // Or 'gpt-5' when available to your account

// === VERIFY WEBHOOK ===
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// === HANDLE INCOMING MESSAGES ===
app.post('/webhook', async (req, res) => {
  try {
    if (req.body.object === 'page') {
      for (const entry of req.body.entry) {
        for (const event of entry.messaging) {
          if (event.message && event.message.text) {
            const senderId = event.sender.id;
            const userMessage = event.message.text.trim();

            if (!userMessage) continue;

            // Determine reply
            const finalReply = await getSmartReply(userMessage);

            await sendTypingOn(senderId);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await sendReply(senderId, finalReply);
          }
        }
      }
      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// === SMART REPLY FUNCTION ===
async function getSmartReply(userMessage) {
  try {
    // Check if matches custom trigger
    const matched = customReplies.find(r =>
      userMessage.toLowerCase().includes(r.trigger.toLowerCase())
    );

    let contextMessage;
    if (matched) {
      // Let GPT rewrite the custom reply to sound natural & warm
      contextMessage = `
أنت خبير عناية بشعر وبشرة الأطفال في شركة SmartKidz.
تحدث بلغة مهنية ودافئة، وكأنك طبيب متخصص، مع هدف تسويق الفوائد الصحية لمنتجاتنا.
هذه هي المعلومات التي يجب أن تعتمد عليها في الرد:
${matched.reply}
اجعل الرد شخصي ويشجع العميل على الشراء.
      `;
    } else {
      // Generic fallback - let GPT handle
      contextMessage = `
أنت خبير عناية بشعر وبشرة الأطفال في شركة SmartKidz.
جاوب على السؤال التالي بإجابات ودودة ومفيدة.
اربط الإجابة بمنتجات SmartKidz بطريقة ذكية حتى لو السؤال عام.
      `;
    }

    const response = await axios.post(
      OPENAI_API_URL,
      {
        model: GPT_MODEL,
        messages: [
          { role: 'system', content: contextMessage },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.7
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
    console.error('❌ Error from OpenAI:', err.response?.data || err.message);
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
    console.error('❌ Typing indicator error:', error.message);
  }
}

// === SEND REPLY ===
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
    console.error('❌ Messenger send error:', error.message);
  }
}

// === START SERVER ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
