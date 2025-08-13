// npm i express axios dotenv
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

/* =========================
   CONFIG
========================= */
const VERIFY_TOKEN       = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN  = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const APP_SECRET         = process.env.APP_SECRET || ''; // optional (signature check)
const GPT_MODEL          = process.env.GPT_MODEL || 'gpt-4o';
const GRAPH_API_VERSION  = process.env.GRAPH_API_VERSION || 'v20.0';
const GRAPH_BASE         = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const OPENAI_CHAT_URL    = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESP_URL    = 'https://api.openai.com/v1/responses';

/* quick env sanity */
if (!VERIFY_TOKEN)      console.warn('[WARN] VERIFY_TOKEN is missing.');
if (!PAGE_ACCESS_TOKEN) console.warn('[WARN] PAGE_ACCESS_TOKEN is missing.');
if (!OPENAI_API_KEY)    console.warn('[WARN] OPENAI_API_KEY is missing — replies will fall back.');

/* =========================
   APP/JSON PARSING
========================= */
const app = express();

// keep raw body so we can validate X-Hub-Signature-256 if APP_SECRET provided
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true }));

/* =========================
   HEALTH
========================= */
app.get('/', (_req, res) => res.status(200).send('Bot online ✅'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

/* =========================
   VERIFY WEBHOOK (Meta)
========================= */
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* optional request signature check */
function verifySignature(req) {
  if (!APP_SECRET) return true; // skip if not configured
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  return signature === expected;
}

/* =========================
   MESSENGER WEBHOOK
========================= */
app.post('/webhook', (req, res) => {
  // Acknowledge first to avoid timeouts
  res.sendStatus(200);

  try {
    if (!verifySignature(req)) {
      console.warn('[SECURITY] Invalid X-Hub-Signature-256');
      return;
    }
    if (req.body.object !== 'page') return;

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

/* =========================
   EVENT HANDLER
========================= */
async function handleEvent(event) {
  if (!event) return;
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

  let reply;
  try {
    reply = await callGPTNatural(text);
  } catch (e) {
    console.error('callGPTNatural error:', e?.response?.data || e.message);
  }
  await sendReply(senderId, reply || 'تمام.');
}

/* =========================
   GPT HELPERS
========================= */
function looksArabic(s = '') {
  return /[\u0600-\u06FF]/.test(String(s));
}

async function callGPTNatural(userMessage) {
  if (!OPENAI_API_KEY) {
    // graceful fallback if key is missing
    return 'الخدمة متوقفة مؤقتًا بسبب إعدادات النظام. جرّب لاحقًا من فضلك 🙏';
  }

  const arabic = looksArabic(userMessage);
  const systemPrompt = arabic
    ? 'اتكلم بالمصري بشكل بسيط ولطيف. خليك مختصر ومباشر. اسأل سؤال متابعة واحد لو محتاج توضيح. تجنّب أي وعود طبية قطعية.'
    : 'Reply in the user’s language in a warm, natural, concise way. Ask at most one short follow-up if needed. Avoid definitive medical claims.';

  const isGpt5 = /^gpt-5/i.test(GPT_MODEL);

  const chatPayload = {
    model: GPT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    ...(isGpt5 ? { max_completion_tokens: 450 } : { temperature: 0.7, max_tokens: 450 })
  };

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  };

  try {
    const { data } = await axios.post(OPENAI_CHAT_URL, chatPayload, { headers, timeout: 15000 });
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    const errMsg = e?.response?.data || e.message;
    console.error('OpenAI /chat/completions error:', errMsg);

    const shouldFallback =
      String(errMsg).includes('/v1/responses') ||
      String(errMsg).includes('model_not_found') ||
      String(errMsg).includes('unsupported') ||
      (String(errMsg).includes('This model') && String(errMsg).includes('does not support'));

    if (!shouldFallback) return 'حصلت مشكلة مؤقتًا—نجرب تاني؟';

    const respPayload = {
      model: GPT_MODEL,
      input: `${systemPrompt}\n\nUser: ${userMessage}\nAssistant:`,
      ...(isGpt5 ? { max_output_tokens: 450 } : { temperature: 0.7, max_output_tokens: 450 })
    };

    try {
      const { data } = await axios.post(OPENAI_RESP_URL, respPayload, { headers, timeout: 15000 });
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

/* =========================
   MESSENGER HELPERS
========================= */
async function sendTypingOn(recipientId) {
  try {
    await axios.post(
      `${GRAPH_BASE}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
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
          `${GRAPH_BASE}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
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

/* =========================
   UTILS
========================= */
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function chunkText(str, max = 1800) {
  const s = String(str);
  if (s.length <= max) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Messenger bot running on ${PORT}`);
  console.log(`   • Graph API: ${GRAPH_API_VERSION}`);
  console.log(`   • Model: ${GPT_MODEL}`);
});
