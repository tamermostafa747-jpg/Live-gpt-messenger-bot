// npm i express axios dotenv cors
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

/* =========================
   CONFIG
========================= */
const VERIFY_TOKEN       = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN  = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const APP_SECRET         = process.env.APP_SECRET || ''; // optional (signature check)
const GPT_MODEL          = process.env.GPT_MODEL || 'gpt-4o-mini';
const GRAPH_API_VERSION  = process.env.GRAPH_API_VERSION || 'v20.0';
const GRAPH_BASE         = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const OPENAI_CHAT_URL    = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESP_URL    = 'https://api.openai.com/v1/responses';
const OPENAI_EMB_URL     = 'https://api.openai.com/v1/embeddings';

// Semantic KB
const KB_INDEX_PATH      = process.env.KB_INDEX_PATH || './data/kb_index.json';
const EMBEDDINGS_MODEL   = process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small';
const TOP_K              = parseInt(process.env.TOP_K || '5', 10);
// ↓ a bit looser to improve recall
const SIM_THRESHOLD      = parseFloat(process.env.SIM_THRESHOLD || '0.65');

// Marketing / Offers
const OFFER_TEXT         = process.env.OFFER_TEXT || 'استفيد من عرضنا الحالي—خصم خاص لفترة محدودة. تحب أساعدك تطلبه دلوقتي؟';

/* quick env sanity */
if (!VERIFY_TOKEN)      console.warn('[WARN] VERIFY_TOKEN is missing.');
if (!PAGE_ACCESS_TOKEN) console.warn('[WARN] PAGE_ACCESS_TOKEN is missing.');
if (!OPENAI_API_KEY)    console.warn('[WARN] OPENAI_API_KEY is missing — replies will fall back.');

/* =========================
   SAFE REQUIRE (PRODUCT CATALOG)
========================= */
function safeRequire(p) { try { return require(p); } catch { return null; } }
const CATALOG_RAW =
  safeRequire('./src/productData.js') ||
  safeRequire('./productData.js') ||
  safeRequire(path.resolve(process.cwd(), 'src', 'productData.js')) ||
  [];
const CATALOG = Array.isArray(CATALOG_RAW)
  ? CATALOG_RAW
  : (Array.isArray(CATALOG_RAW?.default) ? CATALOG_RAW.default : []);

/* Normalize catalog items so we can reference consistently */
function normalizeItem(x = {}) {
  const name =
    x.name || x.title || x.productName || x.enName || x.arName || x.slug || 'منتج';
  const desc = x.description || x.desc || x.details || '';
  const tags = x.tags || x.ingredients || x.features || [];
  const price = x.price || x.currentPrice || x.salePrice || '';
  const size = x.size || x.quantity || x.weight || '';
  const url  = x.url || x.link || x.href || '';
  return { name: String(name), desc: String(desc), tags, price, size, url, raw: x };
}

/* Build concise catalog context; score by simple token overlap with the query */
function buildCatalogContext(userMsg = '', lang = 'ar', limit = 8) {
  if (!CATALOG.length) return null;
  const items = CATALOG.map(normalizeItem);

  const tokens = String(userMsg).toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter(Boolean);

  function score(it) {
    const hay = (it.name + ' ' + it.desc + ' ' + (Array.isArray(it.tags) ? it.tags.join(' ') : it.tags))
      .toLowerCase();
    let s = 0;
    for (const t of tokens) if (hay.includes(t)) s++;
    // slight boost for kids/hair keywords
    if (hay.includes('شعر') || hay.includes('hair')) s += 1.2;
    if (hay.includes('أطفال') || hay.includes('kids') || hay.includes('child')) s += 0.8;
    return s;
  }

  const ranked = items
    .map(it => ({ it, s: score(it) }))
    .sort((a, b) => b.s - a.s);

  const top = ranked.slice(0, limit).map(({ it, s }, i) => {
    const parts = [];
    parts.push(`[${i + 1}] ${it.name}`);
    if (it.size) parts.push(`الحجم: ${it.size}`);
    if (it.price) parts.push(`السعر: ${it.price}`);
    if (Array.isArray(it.tags) && it.tags.length) parts.push(`ملفات/مكونات: ${it.tags.slice(0, 6).join(', ')}`);
    if (it.url) parts.push(`لينك: ${it.url}`);
    return parts.join(' • ');
  });

  const head = lang === 'ar'
    ? 'ملخص سريع لمنتجاتنا (للرجوع فقط):'
    : 'Quick summary of our products (for reference only):';
  return `${head}\n${top.join('\n')}`;
}

/* =========================
   KB LOADING (vectors)
========================= */
let KB = []; // { text, lang, embedding:[...], meta, i }

function loadKB() {
  try {
    const p = path.resolve(KB_INDEX_PATH);
    const raw = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(raw);

    // Try to find the array of docs regardless of shape
    let docs = Array.isArray(json) ? json : (json.docs || json.items || json.entries);
    if (!Array.isArray(docs)) {
      docs = [];
      if (json && typeof json === 'object') {
        for (const v of Object.values(json)) {
          if (Array.isArray(v) && v.length && (v[0]?.embedding || v[0]?.vector || v[0]?.vec)) {
            docs = v;
            break;
          }
        }
      }
    }

    KB = (docs || []).map((d, i) => {
      const text = d.text || d.content || d.meta?.text || '';
      const lang = d.lang || d.meta?.lang || (/[\u0600-\u06FF]/.test(text) ? 'ar' : 'en');
      const embedding = d.embedding || d.vec || d.vector;
      const meta = d.meta || d;
      return Array.isArray(embedding) ? { text, lang, embedding, meta, i } : null;
    }).filter(Boolean);

    console.log(`[KB] Loaded ${KB.length} vectors from ${KB_INDEX_PATH}`);
  } catch (e) {
    console.warn('[KB] Could not load index:', e.message);
  }
}
loadKB();

/* =========================
   APP/JSON PARSING
========================= */
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

/* ---------- CORS for website widget ---------- */
const ALLOWED_ORIGINS = (process.env.WEBCHAT_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
if (ALLOWED_ORIGINS.length === 0) {
  ALLOWED_ORIGINS.push('https://smartkidz-eg.com', 'https://www.smartkidz-eg.com');
}
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked for origin: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // allow preflight

/* =========================
   HEALTH
========================= */
app.get('/', (_req, res) => res.status(200).send('Bot online ✅'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
app.get('/webchat/ping', (_req, res) => res.json({ ok: true }));

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
  if (!APP_SECRET) return true;
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  return signature === expected;
}

/* =========================
   MESSENGER WEBHOOK
========================= */
app.post('/webhook', (req, res) => {
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

  if (!text.trim() && attachments.length) {
    await sendReply(senderId, 'لو تكتب سؤالك نصًا أقدر أرد عليك مباشرة 😊');
    return;
  }
  if (!text.trim()) return;

  await sendTypingOn(senderId);

  let reply;
  try { reply = await callGPTNatural(text); }
  catch (e) { console.error('callGPTNatural error:', e?.response?.data || e.message); }
  await sendReply(senderId, reply || 'تمام.');
}

/* =========================
   GPT + KB HELPERS
========================= */
function looksArabic(s = '') { return /[\u0600-\u06FF]/.test(String(s)); }

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a[i], y = b[i]; dot += x*y; na += x*x; nb += y*y; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

async function embedText(text) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` };
  const { data } = await axios.post(OPENAI_EMB_URL, { model: EMBEDDINGS_MODEL, input: text }, { headers, timeout: 15000 });
  return data?.data?.[0]?.embedding || [];
}

function formatKbContext(results, lang) {
  const head = lang === 'ar'
    ? 'مقتطفات من قاعدة المعرفة (استخدمها فقط إذا كانت مناسبة):'
    : 'Knowledge Base excerpts (use only if relevant):';
  const lines = results.map(({ d, s }, i) =>
    `[${i+1}] (${s.toFixed(2)}) ${String(d.text || '').slice(0, 320)}`
  );
  return `${head}\n${lines.join('\n')}`;
}

async function searchKB(query, lang) {
  if (!OPENAI_API_KEY || !KB.length) return [];
  try {
    const q = await embedText(query);
    const scored = KB.map(d => ({ d, s: cosineSim(q, d.embedding) }));
    scored.sort((a, b) => b.s - a.s);
    return scored.filter(r => (!lang || !r.d.lang || r.d.lang === lang) && r.s >= SIM_THRESHOLD).slice(0, TOP_K);
  } catch (e) {
    console.warn('[KB] search error:', e.message);
    return [];
  }
}

function injectCTA(answer, lang) {
  const hasOfferWord = /عرض|خصم|offer|deal|promo/i.test(answer);
  if (hasOfferWord) return answer;
  const spacer = answer.trim().endsWith('؟') ? '\n' : '\n\n';
  return answer + spacer + (lang === 'ar'
    ? OFFER_TEXT
    : (process.env.OFFER_TEXT_EN || 'Grab our current offer—limited-time discount. Want me to reserve it?'));
}

async function callGPTNatural(userMessage) {
  if (!OPENAI_API_KEY) {
    return 'الخدمة متوقفة مؤقتًا بسبب إعدادات النظام. جرّب لاحقًا من فضلك 🙏';
  }

  const arabic = looksArabic(userMessage);
  const lang = arabic ? 'ar' : 'en';

  // Persona/system prompt tuned for children hair-care
  const persona = arabic
    ? [
        'انت اخصائي/ة عناية بشعر الأطفال في SmartKidz.',
        'اتكلم بالمصري بلُطف وثقة—مختصر، عملي، وخطوة بخطوة.',
        'ركّز على مشاكل الشعر الشائعة عند الأطفال (جفاف، هيشان، تشابك، قشرة خفيفة، فروة حساسة).',
        'اقترح منتجات من كتالوجنا فقط، واذكر سبب الاختيار وطريقة الاستخدام والسن المناسب وعدد المرات.',
        'لو السؤال طبي بحت أو الأعراض شديدة، اطلب مراجعة طبيب أطفال/جلدية بدون تشخيص قطعي.',
        'اسأل سؤال متابعة واحد فقط لو محتاج توضيح (مثال: سن الطفل، طبيعة الشعر، تكرار الغسيل).',
        'لو فيه عرض حالي، افكر العميل بلُطف في الآخر.',
      ].join(' ')
    : [
        'You are a children’s hair-care specialist for SmartKidz.',
        'Speak warmly and concisely, focus on practical steps.',
        'Recommend only items from our catalog, explain why, how to use, age-safety, and frequency.',
        'If symptoms sound severe or medical, advise seeing a pediatrician/dermatologist (no diagnosis).',
        'Ask at most one clarifying question if needed.',
        'Gently mention the current offer at the end.',
      ].join(' ');

  // === Retrieve KB context ===
  let kbContextMsg = null;
  const hits = await searchKB(userMessage, lang);
  if (hits.length) {
    const ctx = formatKbContext(hits, lang);
    const ctxMsg = arabic
      ? 'استخدم المعلومات التالية من قاعدة المعرفة عند الإجابة. إذا كانت غير كافية قل أنك غير متأكد ولا تخترع معلومات.\n\n' + ctx
      : 'Use the following knowledge base context when answering. If insufficient, say you\'re not sure and do not invent facts.\n\n' + ctx;
    kbContextMsg = { role: 'system', content: ctxMsg };
  }

  // Catalog context (lightweight)
  const catalogCtx = buildCatalogContext(userMessage, lang, 8);
  const catalogMsg = catalogCtx ? { role: 'system', content: catalogCtx } : null;

  const isGpt5 = /^gpt-5/i.test(GPT_MODEL);
  const messages = [
    { role: 'system', content: persona },
    ...(kbContextMsg ? [kbContextMsg] : []),
    ...(catalogMsg ? [catalogMsg] : []),
    { role: 'user', content: userMessage }
  ];

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` };

  // Try /chat/completions
  try {
    const payload = { model: GPT_MODEL, messages, ...(isGpt5 ? { max_completion_tokens: 450 } : { temperature: 0.6, max_tokens: 450 }) };
    const { data } = await axios.post(OPENAI_CHAT_URL, payload, { headers, timeout: 20000 });
    const raw = (data.choices?.[0]?.message?.content || '').trim();
    return injectCTA(raw || 'تمام.', lang);
  } catch (e) {
    const errMsg = e?.response?.data || e.message;
    console.error('OpenAI /chat/completions error:', errMsg);

    const shouldFallback =
      String(errMsg).includes('/v1/responses') ||
      String(errMsg).includes('model_not_found') ||
      String(errMsg).includes('unsupported') ||
      (String(errMsg).includes('This model') && String(errMsg).includes('does not support'));

    if (!shouldFallback) return arabic ? 'حصلت مشكلة مؤقتًا—نجرب تاني؟' : 'Temporary issue—try again?';

    // Fallback to /responses
    try {
      const joined = messages.map(m => `${m.role === 'system' ? 'System' : 'User'}: ${m.content}`).join('\n');
      const resp = { model: GPT_MODEL, input: joined + '\nAssistant:', ...(isGpt5 ? { max_output_tokens: 450 } : { temperature: 0.6, max_output_tokens: 450 }) };
      const { data } = await axios.post(OPENAI_RESP_URL, resp, { headers, timeout: 20000 });
      const msg =
        data?.output?.[0]?.content?.map?.(c => c.text || c)?.join('') ||
        data?.choices?.[0]?.message?.content ||
        data?.output_text || '';
      return injectCTA(String(msg || 'تمام.').trim(), lang);
    } catch (e2) {
      console.error('OpenAI /responses error:', e2?.response?.data || e2.message);
      return arabic ? 'حصلت مشكلة مؤقتًا—نجرب تاني؟' : 'Temporary issue—try again?';
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
  } catch (e) { console.error('Typing error:', e?.response?.data || e.message); }
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
  } catch (e) { console.error('Send error:', e?.response?.data || e.message); }
}

/* =========================
   WEBSITE WEBCHAT ENDPOINT
========================= */
app.post('/webchat', async (req, res) => {
  try {
    const userText = (req.body?.text || '').toString().trim();
    if (!userText) return res.status(400).json({ error: 'Missing text' });
    const reply = await callGPTNatural(userText);
    return res.json({ reply });
  } catch (e) {
    console.error('[/webchat] error:', e?.response?.data || e.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

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
  if (CATALOG.length) console.log(`   • Catalog items: ${CATALOG.length}`);
});
