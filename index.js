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
            return;
          }

          if (event.message && event.message.text) {
            const userMessage = event.message.text;

            // 1. Try custom replies
            const matchedReply = await getBestReply(userMessage);

            // 2. Use GPT if no match found
            const finalReply = matchedReply?.reply || await getGPTReply(userMessage);
            console.log("Sending final reply:", finalReply);

            await sendMessage(senderId, finalReply);

            // ✅ Prevent further looping after a successful message
            return;
          }
        }
      }
      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// === GET GPT REPLY ===
async function getGPTReply(userMessage) {
  try {
    const response = await axios.post(
      OPENAI_API_URL,
      {
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'أنت مساعد ذكي ترد على الرسائل باللهجة المصرية بشكل ودود وسهل الفهم.'
          },
          {
            role: 'user',
            content: userMessage
          }
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

    const reply = response.data.choices[0].message.content;
    console.log("🤖 GPT reply:", reply);
    return reply;
  } catch (err) {
    console.error('Error from OpenAI:', err.message);
    return "حصلت مشكلة وأنا بحاول أرد. جرب تاني من فضلك.";
  }
}

// === MATCH CUSTOM REPLIES ===
async function getBestReply(prompt) {
  const replyText = await getGPTReply(prompt);
  console.log("GPT matched reply text:", replyText);

  return (
    customReplies.find(r =>
      replyText.toLowerCase().includes(r.reply.toLowerCase().trim())
    ) || null
  );
}

// === SEND MESSAGE TO FACEBOOK MESSENGER ===
async function sendMessage(recipientId, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { text: message }
      }
    );
  } catch (error) {
    console.error('Messenger send error:', error.response?.data || error.message);
  }
}

// === START SERVER ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
