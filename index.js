// npm i express body-parser axios fuse.js dotenv
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const Fuse = require('fuse.js');
require('dotenv').config();

const intents = require('./customReplies');     // FAQs / Offers / Safety...
const products = require('./productData');      // Product facts (easy to update)

// --- App & config ---
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const GPT_MODEL = process.env.GPT_MODEL || 'gpt-5-mini';

// --- In-memory sessions (simple) ---
const SESSIONS = new Map(); // key: senderId -> { slots, lastTurnAt }
const newSession = () => ({ 
  slots: { age: null, hairType: null, concern: null },
  lastTurnAt: Date.now()
});

// --- Helpers: normalize Arabic, greetings, etc. ---
function normalizeAr(str = '') {
  return String(str).toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ة/g, 'ه')
    .trim();
}

const GREET_WORDS = ['hi','hello','hey','الو','هاي','هلا','مرحبا','صباح الخير','مساء الخير','ازيك','عامل ايه','عامله ايه'].map(normalizeAr);
function isGreeting(t) {
  const n = normalizeAr(t);
  return n.length <= 20 && GREET_WORDS.some(g => n.includes(g));
}

// --- Fuse: intents (FAQs) ---
const fuseIntents = new Fuse(
  intents.map(x => ({
    ...x,
    _tr: normalizeAr(x.trigger || ''),
    _kw: (x.keywords || []).map(normalizeAr),
    _ex: (x.examples || []).map(normalizeAr)
  })),
  { includeScore: true, threshold: 0.32, keys: ['_tr','_kw','_ex','reply.title','reply.description'] }
);

// --- Fuse: product retrieval (title/benefits/ingredients) ---
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

// --- Health & webhook verify ---
app.get('/', (_req, res) => res.status(200).send('SmartKidz bot ✅'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// --- Messenger webhook (ack first, process async) ---
app.post('/webhook', (req, res) => {
  try {
    if (req.body.object !== 'page') return res.sendStatus(404);
    res.sendStatus(200);

    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        handleEvent(event).catch(err => console.error('handleEvent error:', err?.response?.data || err.message));
      }
    }
  } catch (e) {
    console.error('Webhook crash:', e);
  }
});

async function handleEvent(event) {
  if (event.message && event.message.is_echo) return;

  const senderId = event.sender?.id;
  const text = event.message?.text || event.postback?.payload || '';
  const attachments = event.message?.attachments || [];
  const userMsg = String(text).trim();
  if (!senderId) return;

  // create/refresh session
  const s = SESSIONS.get(senderId) || newSession();
  s.lastTurnAt = Date.now();
  SESSIONS.set(senderId, s);

  // attachments only -> nudge to text
  if (!userMsg && attachments.length) {
    await sendReply(senderId, 'استقبلت مرفق 😊 لو تكتبي سؤالك عن شعر/بشرة طفلك، أقدر أساعدك بشكل أدق.');
    return;
  }
  if (!userMsg) return;

  await sendTypingOn(senderId);

  let reply;
  // 1) Friendly greeting, *then* wait for need
  if (isGreeting(userMsg)) {
    reply = 'اهلا بيكي 👋 انا هنا اساعدك في العناية بشعر وبشرة الأطفال. تحبي نبدأ بسؤال صغير: سن الطفل ونوع الشعر ايه؟';
    await sendReply(senderId, reply);
    return;
  }

  // 2) FAQs / Offers / Safety (precise, no over-talking)
  const intentHit = fuseIntents.search(normalizeAr(userMsg))?.[0];
  if (intentHit && intentHit.score <= 0.32) {
    const { reply: R } = intentHit.item;
    const blocks = [];
    if (R.title) blocks.push(`• ${R.title}`);
    if (R.description) blocks.push(R.description);
    if (Array.isArray(R.highlights) && R.highlights.length) blocks.push(R.highlights.map(h => `- ${h}`).join('\n'));
    const textOut = blocks.join('\n\n').trim();
    await sendReply(senderId, textOut || 'تمام ✅');
    // send gallery/image if present
    if (R.image) await sendReply(senderId, R.image);
    if (Array.isArray(R.gallery)) for (const img of R.gallery) await sendReply(senderId, img);
    return;
  }

  // 3) Open hair/skin help → retrieve relevant product facts (optional), fill missing slots gracefully
  const n = normalizeAr(userMsg);
  const topProducts = fuseProducts.search(n).slice(0, 3).map(r => r.item);
  const ctx = JSON.stringify(topProducts.map(p => ({
    name: p.name, benefits: p.benefits, ingredients: p.ingredients, notes: p.notes
  })), null, 2);

  // slot fill (don’t ask twice)
  const needAge = !s.slots.age && /\b(س|سن|العمر)\b/.test(''); // just a marker to document
  const needHair = !s.slots.hairType;
  const needConcern = !s.slots.concern;
  // Try to auto-capture simple values from user message
  if (!s.slots.age) {
    const m = userMsg.match(/\b(\d{1,2})\s*(س|سن|سنه|سنين)\b/);
    if (m) s.slots.age = m[1];
  }
  if (!s.slots.hairType) {
    if (n.includes('مجعد') || n.includes('كيرلي')) s.slots.hairType = 'مجعد/كيرلي';
    else if (n.includes('ناعم')) s.slots.hairType = 'ناعم';
    else if (n.includes('خشن')) s.slots.hairType = 'خشن';
  }
  if (!s.slots.concern) {
    if (n.includes('هيشان')) s.slots.concern = 'هيشان';
    else if (n.includes('جفاف')) s.slots.concern = 'جفاف';
    else if (n.includes('تقصف')) s.slots.concern = 'تقصف';
    else if (n.includes('قشره') || n.includes('قشرة')) s.slots.concern = 'قشرة';
    else if (n.includes('تساقط')) s.slots.concern = 'تساقط';
  }

  // Ask for *one* missing slot max, otherwise answer fully
  let followUp = '';
  if (!s.slots.age)      followUp = 'تمام — سن الطفل كام؟';
  else if (!s.slots.hairType)  followUp = 'نوع الشعر ايه؟ (مجعد/ناعم/خشن)';
  else if (!s.slots.concern)   followUp = 'المشكلة الأساسية ايه؟ (هيشان/جفاف/تقصف/قشرة/تساقط)';

  const persona = `
أنت طبيب أطفال وخبير عناية بشعر/بشرة الأطفال لدى SmartKidz.
- تحدث باللهجة المصرية بأسلوب دافئ ومحترم.
- قدم نصيحة عملية وخطوات بسيطة آمنة، بلا وعود علاجية قطعية.
- إن كان هناك تطابق واضح جدًا مع منتج في "بيانات المنتجات" اقترح منتجًا واحدًا فقط وبجملة قصيرة عن السبب.
- إن لم تكن واثقًا، لا تقترح منتجًا.
- لا تكرر نفس السؤال؛ اسأل سؤال متابعة واحد فقط عند الحاجة.
`;

  const userPrompt = `
رسالة العميل: """${userMsg}"""
بيانات الجلسة: ${JSON.stringify(s.slots)}
بيانات المنتجات (مرجع اختياري): ${ctx}

اكتب ردًا طبيعيًا وقصيرًا:
1) افهم الحالة باختصار.
2) أعطِ خطوات بسيطة مناسبة للأطفال.
3) إن كان منطقيًا جدًا، رشّح منتجًا واحدًا من المرجع مع سبب مختصر (سطر واحد).
4) ${followUp ? `ثم اسأل هذا السؤال فقط: "${followUp}"` : 'لا تسأل أي أسئلة إضافية الآن.'}
`;

  const text = await callGPT({ persona, user: userPrompt, tokens: 420 });
  await sendReply(senderId, text || (followUp || 'تمام ✅'));
  SESSIONS.set(senderId, s);
}

// --- GPT call (GPT-5 uses max_completion_tokens only) ---
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
    console.error('OpenAI error:', e?.response?.data || e.message);
    return '';
  }
}

// --- Messenger send helpers ---
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
    if (!parts.length) parts.push('تمام—قوليلي سن الطفل ونوع الشعر؟');

    for (const part of parts) {
      const isUrl = /^https?:\/\/\S+$/i.test(part.trim());
      if (isUrl) {
        await axios.post(
          `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
          { recipient: { id: recipientId },
            message: { attachment: { type: 'image', payload: { url: part.trim(), is_reusable: true } } } }
        );
      } else {
        // chunk just in case
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

// --- Start ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 SmartKidz bot on ${PORT} (model: ${GPT_MODEL})`));
