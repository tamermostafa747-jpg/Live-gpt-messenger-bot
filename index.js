// npm i express body-parser axios fuse.js dotenv
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const Fuse = require('fuse.js');
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
const GPT_MODEL = process.env.GPT_MODEL || 'gpt-5-mini';

// === SIMPLE IN-MEMORY CONVERSATION STATE (last 6 turns per user) ===
const MEMORY = new Map();
const MAX_TURNS = 6;               // user+assistant turns to keep
const CLEANUP_MS = 1000 * 60 * 60; // 1h cleanup

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of MEMORY.entries()) {
    if (now - (s.updatedAt || now) > CLEANUP_MS) MEMORY.delete(id);
  }
}, CLEANUP_MS);

// === HEALTH CHECK ===
app.get('/', (_req, res) => res.status(200).send('SmartKidz bot up ✅'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// === VERIFY WEBHOOK ===
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Arabic normalization ---
function normalizeAr(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

// === Simple detectors ===
const GREETINGS = [
  'hi','hello','hey','الو','هاي','هلا','مرحبا',
  'صباح الخير','مساء الخير','ازيك','عامل ايه','عامله ايه','اهلا'
].map(normalizeAr);

const HAIR_SKIN_HINTS = [
  'شعر','فروه','هيشان','جفاف','تقصف','قشره','تساقط',
  'بلسم','شامبو','ليف','زيت','ترطيب','تنظيف','تشابك',
  'طفل','اطفال','بشره','حساسه','حبوب','حكه','تهيج','قشرة'
].map(normalizeAr);

function isSmallTalk(s) {
  const n = normalizeAr(s);
  if (!n) return false;
  return (n.length <= 24 && GREETINGS.some(g => n.includes(g)));
}
function isHairSkinQuery(s) {
  const n = normalizeAr(s);
  let hits = 0; HAIR_SKIN_HINTS.forEach(h => { if (n.includes(h)) hits++; });
  return hits >= 1;
}

// === Fuse index for product intents ===
const fusedData = customReplies.map(it => ({
  ...it,
  _normTrigger: normalizeAr(it.trigger || ''),
  _normKeywords: (it.keywords || []).map(normalizeAr),
  _normExamples: (it.examples || []).map(normalizeAr)
}));

const fuse = new Fuse(fusedData, {
  includeScore: true,
  threshold: 0.32, // a bit stricter to avoid random matches
  keys: ['_normTrigger','_normKeywords','_normExamples','reply.title','reply.description']
});

// === HANDLE INCOMING MESSAGES ===
// ack immediately to avoid Messenger timeouts; process async
app.post('/webhook', (req, res) => {
  try {
    if (req.body.object !== 'page') return res.sendStatus(404);
    res.sendStatus(200);

    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        handleMessagingEvent(event).catch(err =>
          console.error('❌ handleMessagingEvent error:', err?.response?.data || err.message)
        );
      }
    }
  } catch (e) {
    console.error('❌ Webhook crash:', e);
  }
});

async function handleMessagingEvent(event) {
  if (event.message && event.message.is_echo) return;

  const senderId = event.sender?.id;
  const text = event.message?.text;
  const postback = event.postback?.payload;
  const attachments = event.message?.attachments || [];
  const userMessage = (text || postback || '').toString().trim();
  if (!senderId) return;

  if (!userMessage && attachments.length) {
    await sendReply(senderId, 'استقبلت مرفق 😊 ابعتي سؤالك نصًا علشان اقدر اساعدك بسرعة.');
    return;
  }
  if (!userMessage) return;

  await sendTypingOn(senderId);
  const reply = await routeAndReply(senderId, userMessage);
  await delay(550);
  await sendReply(senderId, reply);
}

// === Router: decide how to answer ===
async function routeAndReply(senderId, userMessage) {
  try {
    // keep convo memory
    const state = MEMORY.get(senderId) || { history: [], updatedAt: Date.now() };
    state.history.push({ role: 'user', content: userMessage });
    state.history = state.history.slice(-MAX_TURNS);
    state.updatedAt = Date.now();
    MEMORY.set(senderId, state);

    // 1) greeting → keep it short, ask a single follow-up
    if (isSmallTalk(userMessage)) {
      const text = await callGPT({
        senderId,
        persona: basePersona({ mode: 'smalltalk' }),
        user: `تحية قصيرة: "${userMessage}". 
أجب بتحية ودودة جدًا + سؤال متابعة واحد فقط: تحبّي اساعدك في ايه بخصوص شعر أو بشرة طفلك؟`,
        tokens: 120
      });
      return text || 'أهلا بيكي! تحبي أساعدك في ايه بخصوص شعر أو بشرة طفلك؟';
    }

    // 2) hair/skin → expert answer; include *relevant* product snippets if any
    if (isHairSkinQuery(userMessage)) {
      const hits = fuse.search(normalizeAr(userMessage)).slice(0, 2).map(r => r.item.reply);
      const context = JSON.stringify(hits, null, 2);
      const text = await callGPT({
        senderId,
        persona: basePersona({ mode: 'expert' }),
        user:
`سؤال العميل عن العناية بالشعر/البشرة: """${userMessage}"""
معلومات منتجات للاستئناس (لا تنقلها حرفيًا):
${context}

اكتب ردًا بسيطًا ودقيقًا: 
1) افهم المشكلة بإيجاز، 2) قدّم خطوات عملية مناسبة للأطفال، 
3) لو فيه ملائمة واضحة جدًا اقترح منتجًا واحدًا فقط ولماذا،
4) اختتم بسؤال متابعة واحد لتخصيص النصيحة (سن الطفل/نوع الشعر/شدة المشكلة).`,
        tokens: 380
      });
      return text || 'تمام — ممكن تحكيلي سن الطفل ونوع الشعر والمشكلة الأساسية (هيشان/جفاف/تقصف/قشرة) علشان أوصّف روتين مناسب؟';
    }

    // 3) anything else → normal assistant; *very* light product nudge only if logical
    const text = await callGPT({
      senderId,
      persona: basePersona({ mode: 'general' }),
      user:
`سؤال عام: """${userMessage}"""
جاوب بإيجاز ومساعدة عملية. 
لو منطقي جدًا فقط، اشِر لجانب من منتجات SmartKidz بجملة واحدة بدون بيع مباشر.`,
      tokens: 280
    });
    return text || 'حاضر! احكيلي أكتر تحبي نساعدك في ايه؟';
  } catch (e) {
    console.error('❌ route error:', e?.response?.data || e.message);
    return 'عذرًا، حصلت مشكلة مؤقتة—ممكن نجرب تاني؟';
  }
}

// === Persona builder ===
function basePersona({ mode }) {
  const core = `
أنت طبيب أطفال وخبير عناية بشعر وبشرة الأطفال لدى SmartKidz.
تتكلم بلغة مصرية مهذبة ودافئة، وبدون وعود علاجية قطعية.
تذكير: الاستجابة قد تختلف من طفل لآخر؛ لا تقدّم تشخيصًا طبيًا.`;
  const small = `الهدف: تحية قصيرة جدًا + سؤال متابعة واحد لمعرفة الحاجة. لا تعرض منتجات.`;
  const expert = `الهدف: فهم المشكلة وتقديم خطوات عملية آمنة، ثم اقتراح منتج واحد فقط إذا كان مناسبًا بوضوح.`;
  const general = `الهدف: إجابة عامة مفيدة. لا تعرض منتجات إلا لو منطقي جدًا وبجملة واحدة.`;
  if (mode === 'smalltalk') return `${core}\n${small}`;
  if (mode === 'expert') return `${core}\n${expert}`;
  return `${core}\n${general}`;
}

// === GPT caller (handles gpt-5 vs others) ===
async function callGPT({ senderId, persona, user, tokens = 300 }) {
  // assemble short memory
  const history = (MEMORY.get(senderId)?.history || []).slice(-MAX_TURNS);
  const isGpt5 = /^gpt-5/i.test(GPT_MODEL);

  const messages = [{ role: 'system', content: persona }];
  for (const turn of history) messages.push(turn);
  messages.push({ role: 'user', content: user });

  const payload = { model: GPT_MODEL, messages };
  if (isGpt5) payload.max_completion_tokens = Math.min(tokens, 500);
  else { payload.temperature = 0.6; payload.max_tokens = Math.min(tokens, 500); }

  try {
    const { data } = await axios.post(OPENAI_API_URL, payload, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      timeout: 15000
    });

    const answer = (data.choices?.[0]?.message?.content || '').trim();
    // save assistant answer to memory
    const state = MEMORY.get(senderId) || { history: [], updatedAt: Date.now() };
    state.history.push({ role: 'assistant', content: answer });
    state.history = state.history.slice(-MAX_TURNS);
    state.updatedAt = Date.now();
    MEMORY.set(senderId, state);

    return answer;
  } catch (e) {
    console.error('❌ OpenAI error:', e?.response?.data || e.message);
    return '';
  }
}

// === Messenger helpers ===
async function sendTypingOn(recipientId) {
  if (!recipientId) return;
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
  if (!recipientId) return;
  try {
    const parts = String(replyContent || '').split('\n').filter(p => p.trim());
    if (parts.length === 0) parts.push('تمام—تقدري تقوليلي سن الطفل ونوع الشعر علشان أساعدك أحسن؟');

    for (const part of parts) {
      const isUrl = /^https?:\/\/\S+$/i.test(part.trim());
      if (isUrl) {
        await axios.post(
          `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
          { recipient: { id: recipientId },
            message: { attachment: { type: 'image', payload: { url: part.trim(), is_reusable: true } } } }
        );
      } else {
        for (const chunk of chunkText(part, 1800)) {
          await axios.post(
            `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            { recipient: { id: recipientId }, message: { text: chunk } }
          );
          await delay(150);
        }
      }
      await delay(180);
    }
  } catch (e) {
    console.error('Send error:', e?.response?.data || e.message);
  }
}

// === Utils ===
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function chunkText(str, max = 1800) {
  const s = String(str); if (s.length <= max) return [s];
  const out = []; for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

// === START ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} (model: ${GPT_MODEL})`));
