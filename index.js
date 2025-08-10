// npm i express body-parser axios dotenv
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

// === CONFIG ===
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;

const OPENAI_CHAT_URL   = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESP_URL   = 'https://api.openai.com/v1/responses';

// Default to gpt-4o (natural chat). You can override in Render or .env
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
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// === MESSENGER WEBHOOK (ack first, process async) ===
app.post('/webhook', (req, res) => {
  try {
    if (req.body.object !== 'page') return res.sendStatus(404);
    res.sendStatus(200); // immediate ack

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

  const senderId    = event.sender?.id;
  const text        = event.message?.text || event.postback?.payload || '';
  const attachments = event.message?.attachments || [];
  if (!senderId) return;

  // Attachment-only? Nudge to text.
  if (!text.trim() && attachments.length) {
    await sendReply(senderId, 'لو تكتب سؤالك نصًا أقدر أرد عليك مباشرة 😊');
    return;
  }
  if (!text.trim()) return;

  await sendTypingOn(senderId);

  const reply = await callGPTNatural(text);
  await sendReply(senderId, reply || 'تمام.');
}

// === Language helpers ===
function looksArabic(s = '') {
  return /[\u0600-\u06FF]/.test(String(s));
}

// === GPT CALL (Egyptian tone; fallback to /responses when needed) ===
async function callGPTNatural(userMessage) {
  const arabic = looksArabic(userMessage);

  // Minimal, steady system prompt to keep replies natural & short.
  const systemPrompt = arabic
    ? 'اتكلم بالمصري بشكل بسيط ولطيف. خليك مختصر ومباشر. اسأل سؤال متابعة واحد بس لو محتاج توضيح. تجنّب أي وعود طبية قطعية.'
    : 'Reply in the user’s language in a warm, natural, concise way. Ask at most one short follow-up if needed. Avoid definitive medical claims.';

  const isGpt5 = /^gpt-5/i.test(GPT_MODEL);

  // Primary payload for /chat/completions
  const chatPayload = {
    model: GPT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
  };
  if (isGpt5) {
    chatPayload.max_completion_tokens = 450; // GPT-5 family field; no temperature override
  } else {
    chatPayload.temperature = 0.7;
    chatPayload.max_tokens = 450;
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  };

  try {
    const { data } = await axios.post(OPENAI_CHAT_URL, chatPayload, { headers, timeout: 15000 });
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    const errMsg = e?.response?.data || e.message;
    console.error('OpenAI chat/completions error:', errMsg);

    // Only then try /responses (some orgs/models require it)
    const shouldFallback =
      String(errMsg).includes('/v1/responses') ||
      String(errMsg).includes('model_not_found') ||
      String(errMsg).includes('unsupported') ||
      (String(errMsg).includes('This model') && String(errMsg).includes('does not support'));

    if (!shouldFallback) return 'حصلت مشكلة مؤقتًا—نجرب تاني؟';

    // Lean payload for /responses
    const respPayload = {
      model: GPT_MODEL,
      // For Responses API, we can pass a single string; tone hint stays minimal
      input: `${systemPrompt}\n\nUser: ${userMessage}\nAssistant:`,
    };
    if (isGpt5) {
      respPayload.max_output_tokens = 450;
    } else {
      respPayload.temperature = 0.7;
      respPayload.max_output_tokens = 450;
    }

    try {
      const { data } = await axios.post(OPENAI_RESP_URL, respPayload, { headers, timeout: 15000 });
      // Try a few common shapes
      const msg =
        data?.output?.[0]?.content?.map?.(c => c.text || c)?.join('') ||
        data?.choices?.[0]?.message?.content ||
        data?.output_text ||
        '';
      return String(msg || '').trim();
    } catch (e2) {
      console.error('OpenAI /responses error:', e2?.response?.data || e2.message);
      return 'حصلت مشكلة مؤقتًا—نجرب تاني؟';
    }
  }
}

// === Messenger helpers ===
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

// === Utils ===
function delay(ms){ return new Promise(r => setTimeout(r, ms)); }
function chunkText(str, max=1800){
  const s = String(str);
  if (s.length <= max) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

// === START ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 Passthrough GPT on ${PORT} (model: ${GPT_MODEL})`)
);
