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
  'hi','hello','hey','الو','هاي','هلا','مرحبا','صباح الخير','مساء الخير','ازيك','عامل ايه','عامله ايه'
].map(normalizeAr);

const HAIR_SKIN_HINTS = [
  'شعر','فروه','هيشان','جفاف','تقصف','قشره','تساقط',
  'بلسم','شامبو','ليف','زيت','ترطيب','تنظيف','تشابك',
  'طفل','اطفال','بشره','حساسه','حبوب','حكه'
].map(normalizeAr);

function isSmallTalk(s) {
  const n = normalizeAr(s);
  if (!n) return false;
  return (n.length <= 20 && GREETINGS.some(g => n.includes(g)));
}
function isHairSkinQuery(s) {
  const n = normalizeAr(s);
  let hits = 0;
  HAIR_SKIN_HINTS.forEach(h => { if (n.includes(h)) hits++; });
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
  threshold: 0.34,
  keys: ['_normTrigger','_normKeywords','_normExamples','reply.title','reply.description']
});

// === HANDLE INCOMING MESSAGES ===
// IMPORTANT: acknowledge immediately, then process async (prevents Messenger timeouts)
app.post('/webhook', (req, res) => {
  try {
    if (req.body.object !== 'page') return res.sendStatus(404);
    res.sendStatus(200); // <-- immediate ack

    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        handleMessagingEvent(event).catch(err =>
          console.error('❌ handleMessagingEvent error:', err?.response?.data || err.message)
        );
      }
    }
  } catch (e) {
    console.error('❌ Webhook crash:', e);
    // we already replied 200; nothing else to do
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
  const reply = await routeAndReply(userMessage);
  await delay(600);
  await sendReply(senderId, reply);
}

// === Router: decide how to answer ===
async function routeAndReply(userMessage) {
  try {
    if (isSmallTalk(userMessage)) {
      const text = await callGPT({
        persona: basePersona({ mode: 'smalltalk' }),
        user: `تحية/سؤال قصير من المستخدم: "${userMessage}".
أجب بتحية قصيرة دافئة وبسؤال واحد بسيط: تحبّي اساعدك في ايه بخصوص شعر او بشرة طفلك؟`,
        tokens: 120
      });
      return text || 'أهلا بيكي! تحبي أساعدك في ايه بخصوص شعر أو بشرة طفلك؟';
    }

    if (isHairSkinQuery(userMessage)) {
      const hits = fuse.search(normalizeAr(userMessage)).slice(0, 2).map(r => r.item.reply);
      const context = JSON.stringify(hits, null, 2);
      const text = await callGPT({
        persona: basePersona({ mode: 'expert' }),
        user:
`سؤال العميل عن العناية بالشعر/البشرة: """${userMessage}"""
معلومات منتجات قد تكون مفيدة (استخدمها كمرجع فقط ولا تنقلها حرفيًا):
${context}

اكتب ردًا طبيًا بسيطًا ولطيفًا: 1) افهم الحالة باختصار، 2) قدّم نصيحة عملية خطوة بخطوة تناسب الأطفال،
3) إن كانت هناك ملائمة واضحة جدًا، اقترح منتجًا واحدًا من البيانات مع سبب مختصر،
4) اسأل سؤال متابعة واحد لتخصيص النصيحة (سن الطفل/نوع الشعر/شدة المشكلة).`,
        tokens: 380
      });
      return text || 'تمام — ممكن تحكيلي سن الطفل ونوع الشعر والمشكلة الأساسية (هيشان/جفاف/تقصف/قشرة) علشان أوصّف روتين مناسب؟';
    }

    const text = await callGPT({
      persona: basePersona({ mode: 'general' }),
      user:
`سؤال عام من العميل: """${userMessage}"""
أجب بإيجاز وبشكل مفيد. لو ينفع تربط بنصيحة عناية بالأطفال أو بنقطة منطقية من منتجات SmartKidz فلتكن إشارة خفيفة جدًا فقط.`,
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
تتكلم بلغة مصرية مهذبة ودافئة. دقيقة وبدون وعود علاجية قطعية.
تذكير مهم: الاستجابة قد تختلف من طفل لآخر؛ لا تعطي تشخيص طبي.`;
  const small = `الهدف: تحية قصيرة وودية + سؤال متابعة واحد لمعرفة الحاجة. لا تعرض منتجات.`;
  const expert = `الهدف: فهم المشكلة وتقديم خطوات عملية آمنة، ثم اقتراح منتج واحد فقط إذا كان مناسبًا بوضوح.`;
  const general = `الهدف: إجابة عامة مفيدة. لا تعرض منتجات إلا لو منطقي جدًا وبجملة واحدة.`;
  if (mode === 'smalltalk') return `${core}\n${small}`;
  if (mode === 'expert') return `${core}\n${expert}`;
  return `${core}\n${general}`;
}

// === GPT caller (handles gpt-5 vs others) ===
async function callGPT({ persona, user, tokens = 300 }) {
  const isGpt5 = /^gpt-5/i.test(GPT_MODEL);
  const payload = {
    model: GPT_MODEL,
    messages: [
      { role: 'system', content: persona },
      { role: 'user', content: user }
    ]
  };
  if (isGpt5) payload.max_completion_tokens = Math.min(tokens, 500);
  else { payload.temperature = 0.65; payload.max_tokens = Math.min(tokens, 500); }

  try {
    const { data } = await axios.post(OPENAI_API_URL, payload, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      timeout: 15000
    });
    return (data.choices?.[0]?.message?.content || '').trim();
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
          await delay(160);
        }
      }
      await delay(200);
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
