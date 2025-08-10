// npm i express body-parser axios dotenv
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

// === CONFIG ===
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const OPENAI_API_URL    = 'https://api.openai.com/v1/chat/completions';

// Default to gpt-4o for more natural chat; you can override in env
const GPT_MODEL         = process.env.GPT_MODEL || 'gpt-4o';

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === HEALTH ===
app.get('/', (_req, res) => res.status(200).send('Bot online ✅'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// === VERIFY WEBHOOK (Meta) ===
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// === MESSENGER WEBHOOK (ack first, process async) ===
app.post('/webhook', (req, res) => {
  try {
    if (req.body.object !== 'page') return res.sendStatus(404);
    res.sendStatus(200); // immediate ack to Meta

    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        handleEvent(event).catch(err =>
          console.error('handleEvent error:', err?.response?.data || err.message)
        );
      }
    }
  } catch (e) {
    console.error('Webhook crash:', e);
  }
});

async function handleEvent(event) {
  if (event.message && event.message.is_echo) return;

  const senderId   = event.sender?.id;
  const text       = event.message?.text || event.postback?.payload || '';
  const attachments = event.message?.attachments || [];

  if (!senderId) return;

  // If only attachments came in, nudge user to send text
  if (!text.trim() && attachments.length) {
    await sendReply(senderId, 'لو تكتب سؤالك نصًا أقدر أرد عليك مباشرة 😊');
    return;
  }
  if (!text.trim()) return;

  await sendTypingOn(senderId);

  const reply = await callGPTGeneric(text);
  await sendReply(senderId, reply || 'تمام.');
}

// === PURE GPT CALL (no persona/rules) ===
async function callGPTGeneric(userMessage) {
  const isGpt5 = /^gpt-5/i.test(GPT_MODEL);

  const payload = {
    model: GPT_MODEL,
    messages: [{ role: 'user', content: userMessage }],
  };

  // Param differences by family:
  if (isGpt5) {
    // GPT-5: use max_completion_tokens; temperature is fixed
    payload.max_completion_tokens = 450;
  } else {
    // GPT-4o / classic: max_tokens + temperature supported
    payload.max_tokens = 450;
    payload.temperature = 0.7;
  }

  try {
    const { data } = await axios.post(OPENAI_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      timeout: 15000,
    });

    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    console.error('OpenAI error:', e?.response?.data || e.message);
    return 'حصلت مشكلة مؤقتًا—نجرب تاني؟';
  }
}

// === MESSENGER SEND HELPERS ===
async function sendTypingOn(recipientId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, sender_action: 'typing_on' }
    );
  } catch (e) {
    console.error('Typing error:', e?.response?.data || e.message);
  }
}

async function sendReply(recipientId, replyContent) {
  try {
    const parts = String(replyContent || '').split('\n').filter(p => p.trim());
    if (!parts.length) parts.push('تمام.');

    for (const part of parts) {
      // Chunk text for Messenger’s limits (~2000 chars)
      for (const chunk of chunkText(part, 1800)) {
        await axios.post(
          `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
          { recipient: { id: recipientId }, message: { text: chunk } }
        );
        await delay(120);
      }
      await delay(150);
    }
  } catch (e) {
    console.error('Send error:', e?.response?.data || e.message);
  }
}

// === UTILS ===
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function chunkText(str, max = 1800) {
  const s = String(str);
  if (s.length <= max) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

// === START ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Passthrough GPT on ${PORT} (model: ${GPT_MODEL})`));
