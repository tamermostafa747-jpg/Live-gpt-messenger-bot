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

// === Small talk detection (fast, no GPT) ===
const SMALL_TALK_PATTERNS = [
  { key: 'greet',  re: /^(?:hi|hello|hey|السلام|مرحبا|اهلا|هاي)\b/i, ar: /^(?:اهلا|مرحبا|سلام|مساء الخير|صباح الخير)/ },
  { key: 'how',    re: /(how are you|how r u|how’s it going)/i, ar: /(اخبارك|عامل ايه|عامل ايه|ازيك|عامله ايه)/ },
  { key: 'thanks', re: /\b(thanks|thank you|thx)\b/i, ar: /(شكرا|متشكر)/ },
  { key: 'bye',    re: /\b(bye|goodbye|see you|later)\b/i, ar: /(مع السلامه|باي|سلام)/ },
];

function matchSmallTalk(msg) {
  const m = msg.trim();
  const n = normalizeAr(m);
  // English
  for (const p of SMALL_TALK_PATTERNS) {
    if (p.re && p.re.test(m)) return p.key;
    if (p.ar && p.ar.test(n)) return p.key;
  }
  return null;
}

const SMALL_TALK_RESPONSES = {
  greet: [
    'اهلا وسهلا! 👋 ازيك؟ لو حابة نتكلم عن روتين شعر طفلك قوليلي سنه ونوع الشعر.',
    'مرحبا بيكي! 😊 اقدر اساعدك ازاي؟'
  ],
  how: [
    'تمام الحمد لله 🙏 انتي عاملة ايه؟ لو في استفسار عن العناية بشعر الأطفال انا جاهزة.',
  ],
  thanks: [
    'العفو 🙌 لو احتجتي اي حاجة تانية انا هنا.',
  ],
  bye: [
    'باي 👋 يسعدني نكمل كلامنا في اي وقت.',
  ],
};

// === Build fuzzy index over intents ===
const fuse = new Fuse(
  customReplies.map(it => ({
    ...it,
    _normTrigger: normalizeAr(it.trigger || ''),
    _normKeywords: (it.keywords || []).map(normalizeAr),
    _normExamples: (it.examples || []).map(normalizeAr)
  })),
  {
    includeScore: true,
    threshold: 0.30, // a bit stricter to avoid over-firing
    keys: ['_normTrigger', '_normKeywords', '_normExamples', 'reply.title', 'reply.description']
  }
);

// Helper to count keyword hits in user message
function keywordHitCount(userNorm, keywords = []) {
  const ks = keywords.map(normalizeAr).filter(Boolean);
  let c = 0;
  for (const k of ks) if (userNorm.includes(k)) c++;
  return c;
}

// === HANDLE INCOMING MESSAGES ===
app.post('/webhook', async (req, res) => {
  try {
    if (req.body.object !== 'page') return res.sendStatus(404);

    for (const entry of req.body.entry) {
      for (const event of entry.messaging) {
        if (event.message && event.message.is_echo) continue;

        const senderId = event.sender?.id;
        const text = event.message?.text;
        const attachments = event.message?.attachments || [];
        const postback = event.postback?.payload;

        let userMessage = (text || postback || '').toString().trim();

        if (!userMessage && attachments.length) {
          await sendReply(
            senderId,
            'استقبلت مرفق 😊 لو تحبّي أقدر أساعدك أكتر لما تبعتي سؤالك نصًا عن شعر الطفل أو المنتجات.'
          );
          continue;
        }

        if (!senderId || !userMessage) continue;

        const finalReply = await getSmartReply(userMessage);
        await sendTypingOn(senderId);
        await delay(700);
        await sendReply(senderId, finalReply);
      }
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error('❌ Webhook error:', e);
    return res.sendStatus(500);
  }
});

// === SMART REPLY flow ===
async function getSmartReply(userMessage) {
  try {
    // 1) Small talk first (no product pitch)
    const st = matchSmallTalk(userMessage);
    if (st) {
      const variants = SMALL_TALK_RESPONSES[st] || [];
      const reply = variants[Math.floor(Math.random() * variants.length)] || 'اهلا بيكي 👋';
      return reply;
    }

    // 2) Try custom intents (require BOTH: confident score AND at least 1 keyword hit)
    const norm = normalizeAr(userMessage);
    const results = fuse.search(norm);
    const top = results[0];
    let confident = false;
    let matchedIntent = null;

    if (top && top.score !== undefined && top.score <= 0.30) {
      const hits = keywordHitCount(norm, top.item.keywords || []);
      if (hits > 0) {
        confident = true;
        matchedIntent = top.item;
      }
    }

    // 3) Build persona for GPT
    const persona = `
أنت طبيب أطفال وخبير عناية بشعر وبشرة الأطفال في شركة SmartKidz.
تتكلم بلغة مصرية مهذبة ودافئة. الهدف: حوار طبيعي أولًا، ثم المساعدة.
لا تقدم عرض منتج إلا عند وجود طلب واضح أو تطابق مع الكلمات المفتاحية.
لو السؤال عام وغير واضح، اسأل سؤال توضيحي قصير.
نوّه أن الاستجابة تختلف من طفل لآخر وتجنب الوعود القطعية.
`;

    // 4) If clear product intent → let GPT rephrase our product info nicely (plus media)
    if (confident && matchedIntent) {
      const systemPrompt = persona + `
هذه بيانات داخلية عن منتج/عرض SmartKidz لا تُعرض حرفيًا:
${JSON.stringify(matchedIntent.reply, null, 2)}

التعليمات:
- رد باختصار إنساني ولطيف بناءً على سؤال المستخدم.
- لا تسوق بشكل مباشر إلا لو السؤال يطلب ذلك.
- إن احتجت، اسأل سؤال توضيحي واحد بحد أقصى.
- لا تقدم ادعاءات علاجية.
`;
      const text = await callGpt(systemPrompt, userMessage);

      // attach images/gallery if any
      const media = [];
      const r = matchedIntent.reply || {};
      if (r.image) media.push(r.image);
      if (Array.isArray(r.gallery)) media.push(...r.gallery.filter(Boolean));

      return formatReply(text, media);
    }

    // 5) Otherwise → general chat: be human, ask 1 clarifying question, no pitch
    const systemPrompt = persona + `
لا تقدم معلومات عن المنتجات الآن إلا لو المستخدم طلبها صراحة.
ابدأ برد بشري طبيعي ثم اسأل سؤال توضيحي واحد متعلق بالشعر أو الهدف.
`;
    const text = await callGpt(systemPrompt, userMessage);
    return text || 'تمام 👌 ممكن توضحيلي هدفك؟ تقليل هيشان؟ فك تشابك؟ ترطيب؟';

  } catch (e) {
    console.error('❌ getSmartReply error:', e?.response?.data || e.message);
    return 'عذرًا، حصلت مشكلة مؤقتة—ممكن نجرب تاني؟';
  }
}

// === OpenAI call (GPT-5/mini friendly) ===
async function callGpt(systemPrompt, userPrompt) {
  const isGpt5 = /^gpt-5/i.test(GPT_MODEL);
  const payload = {
    model: GPT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };
  if (isGpt5) {
    payload.max_completion_tokens = 400;
  } else {
    payload.temperature = 0.65;
    payload.max_tokens = 400;
  }

  const { data } = await axios.post(OPENAI_API_URL, payload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    timeout: 15000
  });

  let text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text) {
    text = 'تمام 👌 احكيلي سن الطفل ونوع الشعر والمشكلة الأساسية (هيشان/جفاف/تشابك).';
  }
  console.log('GPT preview:', text.slice(0, 200));
  return text;
}

// === Helper: combine text + image URLs into one message string ===
function formatReply(text = '', imageUrls = []) {
  const safeText = (text || '').trim();
  const mediaLines = (imageUrls || []).map(u => String(u).trim()).filter(Boolean);
  return [safeText, ...mediaLines].filter(Boolean).join('\n');
}

// === SEND TYPING ===
async function sendTypingOn(recipientId) {
  if (!recipientId) return;
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, sender_action: 'typing_on' }
    );
  } catch (e) {
    console.error('Typing error:', e.message);
  }
}

// === SEND MESSAGE (supports images & multi-line) ===
async function sendReply(recipientId, replyContent) {
  if (!recipientId) return;
  try {
    let parts = String(replyContent).split('\n').map(p => p.trim()).filter(Boolean);

    if (!parts.length) {
      parts = [
        'تمام 🙌 ابعتيلي سن الطفل، نوع الشعر (ناعم/مموج/كيرلي)، والمشكلة الأساسية (هيشان/جفاف/تشابك)، وأنا أختارلك الروتين المناسب.'
      ];
    }

    for (const part of parts) {
      const isUrl = /^https?:\/\/\S+$/i.test(part);
      if (isUrl) {
        await axios.post(
          `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
          {
            recipient: { id: recipientId },
            message: { attachment: { type: 'image', payload: { url: part, is_reusable: true } } }
          }
        );
      } else {
        for (const chunk of chunkText(part, 1800)) {
          await axios.post(
            `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            { recipient: { id: recipientId }, message: { text: chunk } }
          );
          await delay(200);
        }
      }
      await delay(250);
    }
  } catch (e) {
    console.error('Send error:', e?.response?.data || e.message);
  }
}

// === Utils ===
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
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT} (model: ${GPT_MODEL})`)
);
