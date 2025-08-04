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

          const userMessage = event.message.text;

          // 1. Try custom replies
          const matchedReply = await getBestReply(userMessage);

          // 2. Use GPT if no match found
          const finalReply = matchedReply ? matchedReply.reply : await getGPTReply(userMessage);
          console.log("Sending final reply:", finalReply);

          await sendMessage(senderId, finalReply);

          // ✅ Prevent further looping after a successful message
          return;
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

// === GET GPT REPLY ===
async function getGPTReply(userMessage) {
  try {
    const response = await axios.post(
      OPENAI_API_URL,
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: userMessage }]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('GPT API error:', error.response?.data || error.message);
    return 'Sorry, something went wrong.';
  }
}

// === GET BEST CUSTOM REPLY ===
async function getBestReply(messageText) {
  const prompt = `
You are a helpful assistant. A user said: "${messageText}".
Select the best matching reply based on the list below.

${customReplies.map((r, i) => `${i + 1}. ${r.trigger} (${r.context}): ${r.reply}`).join("\n")}

Reply only with the best full reply from the list.
`;

  const replyText = await getGPTReply(prompt);
  console.log("GPT matched reply text:", replyText);

  return customReplies.find(r =>
    replyText.toLowerCase().includes(r.reply.toLowerCase().trim())
  ) || null;
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
