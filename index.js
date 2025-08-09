// npm i express body-parser axios fuse.js dotenv
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const Fuse = require('fuse.js');
require('dotenv').config();

const intents  = require('./customReplies');   // FAQs / offers / safety
const products = require('./productData');     // Product facts (you can update freely)

// ===== App & config =====
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const OPENAI_API_URL    = 'https://api.openai.com/v1/chat/completions';
const GPT_MODEL         = process.env.GPT_MODEL || 'gpt-5-mini';

// ===== Simple sessions (memory) =====
const SESSIONS = new Map();
const newSession = () => ({
  slots: { age: null, hairType: null, concern: null, audience: 'child' }, // 'child' | 'adult'
  asked: { age: false, hairType: false, concern: false },
  askCount: 0,
  lastAskedAt: 0,
  lastTurnAt: Date.now()
});

// ===== Arabic helpers =====
function normalizeAr(str = '') {
  return String(str).toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

const GREET_WORDS = ['hi','hello','hey','الو','هاي','هلا','مرحبا','صباح الخير','مساء الخير','ازيك','عامل ايه','عامله ايه'].map(normalizeAr);
function isGreeting(t) {
  const n = normalizeAr(t);
  return n && n.length <= 20 && GREET_WORDS.some(g => n.includes(g));
}
function saysAdult(t) {
  const n = normalizeAr(t);
  return /انا مش طفل|انا كبير|انا شخص كبير|انا بالغ|لشعري انا|شعري انا/.test(n);
}
function extractSlots(text) {
  const n = normalizeAr(text);
  const out = {};
  const mAge = n.match(/(^|\s)(\d{1,2})\s*(س|سن|سنه|سنين)(\s|$)/);
  if (mAge) out.age = mAge[2];
  if (n.includes('مجعد') || n.includes('كيرلي')) out.hairType = 'مجعد/كيرلي';
  else if (n.includes('ناعم')) out.hairType = 'ناعم';
  else if (n.includes('خشن')) out.hairType = 'خشن';
  if (n.includes('هيشان')) out.concern = 'هيشان';
  else if (n.includes('جفاف')) out.concern = 'جفاف';
  else if (n.includes('تقصف')) out.concern = 'تقصف';
  else if (n.includes('قشره') || n.includes('قشرة')) out.concern = 'قشرة';
  else if (n.includes('تساقط')) out.concern = 'تساقط';
  return out;
}

// ===== Search indexes =====
const fuseIntents = new Fuse(
  intents.map(x => ({
    ...x,
    _tr: normalizeAr(x.trigger || ''),
    _kw: (x.keywords || []).map(normalizeAr),
    _ex: (x.examples || []).map(normalizeAr)
  })),
  { includeScore: true, threshold: 0.32, keys: ['_tr','_kw','_ex','reply.title','reply.description'] }
);

const fuseProducts = new Fuse(
  products.map(p => ({
    ...p,
    _name: normalizeAr(p.name),
    _tags: (p.tags || []).map(normalizeAr),
    _benefits: normalizeAr((p.benefits || []).join(' ')),
    _ing: normalizeAr((p.ingredients || []).join(' '))
  })),
  { includeScore: true, threshold: 0.38, keys: ['_name','_tags','_benefits','_ing','notes'] }
);

// ===== Health & verify =====
app.get('/',        (_req, res) => res.status(200).send('SmartKidz bot ✅'));
app.get('/health',  (_req, res) => res.status(200).json({ ok: true }));

app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Messenger webhook (ack first, process async) =====
app.post('/webhook', (req, res) => {
  try {
    if (req.body.object !== 'page') return res.sendStatus(404);
    res.sendStatus(200);

    for (const entry of (req.body.entry || [])) {
      for (const event of (entry.messaging || [])) {
        handleEvent(event).catch(err => console.error('handleEvent error:', err?.response?.data || err.message));
      }
    }
  } catch (e) {
    console.error('Webhook crash:', e);
  }
});

async function handleEvent(event) {
  if (event.message && event.message.is_echo) return;

  const senderId   = event.sender?.id;
  const msgText    = event.message?.text || event.postback?.payload || '';
  const attachments= event.message?.attachments || [];
  const userMsg    = String(msgText).trim();
  if (!senderId) return;

  const s = SESSIONS.get(senderId) || newSession();
  s.lastTurnAt = Date.now();

  if (!userMsg && attachments.length) {
    await sendReply(senderId, 'استقبلت مرفق 😊 لو تكتبي سؤالك عن الشعر/البشرة، اقدر اساعدك بسرعة.');
    SESSIONS.set(senderId, s);
    return;
  }
  if (!userMsg) { SESSIONS.set(senderId, s); return; }

  if (saysAdult(userMsg)) s.slots.audience = 'adult';

  const found = extractSlots(userMsg);
  s.slots = { ...s.slots, ...found };

  await sendTypingOn(senderId);

  if (isGreeting(userMsg)) {
    await sendReply(senderId, 'اهلا بيكي 👋 ازاي اقدر اساعدك؟ لو تحبي، احكيلي النوع/المشكلة بسرعة (مثلا: هيشان لشعر كيرلي).');
    SESSIONS.set(senderId, s);
    return;
  }

  const intentHit = fuseIntents.search(normalizeAr(userMsg))?.[0];
  if (intentHit && intentHit.score <= 0.32) {
    const R = intentHit.item.reply || {};
    const blocks = [];
    if (R.title)       blocks.push(`• ${R.title}`);
    if (R.description) blocks.push(R.description);
    if (Array.isArray(R.highlights) && R.highlights.length) blocks.push(R.highlights.map(h => `- ${h}`).join('\n'));
    const out = blocks.join('\n\n').trim() || 'تمام ✅';
    await sendReply(senderId, out);
    if (R.image) await sendReply(senderId, R.image);
    if (Array.isArray(R.gallery)) for (const img of R.gallery) await sendReply(senderId, img);
    SESSIONS.set(senderId, s);
    return;
  }

  const n = normalizeAr(userMsg);
  const topProducts = fuseProducts.search(n).slice(0, 3).map(r => r.item);
  const productsCtx = JSON.stringify(topProducts.map(p => ({
    name: p.name, benefits: p.benefits, ingredients: p.ingredients, notes: p.notes
  })), null, 2);

  const now = Date.now();
  const COOL_MS = 35_000;
  let followUp = '';

  const canAsk =
    s.askCount < 2 &&
    now - s.lastAskedAt > COOL_MS;

  const need = [];
  if (s.slots.audience === 'child') {
    if (!s.slots.age) need.push('age');
  }
  if (!s.slots.hairType) need.push('hairType');
  if (!s.slots.concern)  need.push('concern');

  for (const slot of need) {
    if (canAsk && !s.asked[slot]) {
      if (slot === 'age')      followUp = 'سن الطفل كام؟';
      if (slot === 'hairType') followUp = 'نوع الشعر ايه؟ (مجعد/ناعم/خشن)';
      if (slot === 'concern')  followUp = 'المشكلة الأساسية ايه؟ (هيشان/جفاف/تقصف/قشرة/تساقط)';
      s.asked[slot]  = true;
      s.askCount    += 1;
      s.lastAskedAt  = now;
      break;
    }
  }

  const persona = buildPersona(s.slots.audience);

  const userPrompt = `
رسالة العميل: """${userMsg}"""
سياق الجلسة: ${JSON.stringify(s.slots)}
بيانات المنتجات (مرجع اختياري): ${productsCtx}

اكتب ردًا طبيعيًا وقصيرًا:
1) افهم الحالة باختصار.
2) قدم خطوات عملية آمنة (3 نقاط بحد أقصى).
3) إن كان منطقيًا جدًا، رشّح منتجًا واحدًا من المرجع مع سبب مختصر (سطر واحد). لا تذكر أكثر من منتج.
4) ${followUp ? `اسأل *هذا السؤال فقط* في النهاية: "${followUp}"` : 'لا تسأل أي أسئلة إضافية الآن.'}
`;

  const answer = await callGPT({ persona, user: userPrompt, tokens: 420 });
  await sendReply(senderId, answer || (followUp || 'تمام ✅'));

  SESSIONS.set(senderId, s);
}

// ===== Persona =====
function buildPersona(audience = 'child') {
  const core = `
أنت خبير عناية بالشعر والبشرة لدى SmartKidz.
تتكلم باللهجة المصرية بلطف واحترام، وبدون وعود علاجية قطعية.
قدم نصائح عملية قصيرة مناسبة للفئة المستهدفة.
`;
  const child = `الفئة: طفل. ركّز على اللطف، الحساسية، بساطة الروتين، وعدم الإفراط في المنتجات.`;
  const adult = `الفئة: بالغ. قدّم روتينًا بسيطًا يناسب الشعر/البشرة بدون إفراط في الدعاية.`;
  return `${core}\n${audience === 'adult' ? adult : child}`;
}

// ===== GPT call (GPT-5: only max_completion_tokens) =====
async function callGPT({ persona, user, tokens = 300 }) {
  const isGpt5 = /^gpt-5/i.test(GPT_MODEL);
  const payload = {
    model: GPT_MODEL,
    messages: [
      { role: 'system', content: persona },
      { role: 'user',   content: user }
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
    console.error('OpenAI error:', e?.response?.data || e.message);
    return '';
  }
}

// ===== Messenger helpers =====
async function sendTypingOn(recipientId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, sender_action: 'typing_on' }
    );
  } catch (e) { console.error('Typing error:', e?.response?.data || e.message); }
}

async function sendReply(recipientId, replyContent) {
  try {
    const parts = String(replyContent || '').split('\n').filter(p => p.trim());
    if (!parts.length) parts.push('احكيلي باختصار عايزة ايه علشان أساعدك ❤');

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
          await delay(140);
        }
      }
      await delay(180);
    }
  } catch (e) {
    console.error('Send error:', e?.response?.data || e.message);
  }
}

function delay(ms){ return new Promise(r => setTimeout(r, ms)); }
function chunkText(str, max=1800){ const s=String(str); if(s.length<=max) return [s]; const out=[]; for(let i=0;i<s.length;i+=max) out.push(s.slice(i,i+max)); return out; }

// ===== Start =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 SmartKidz bot on ${PORT} (model: ${GPT_MODEL})`));
