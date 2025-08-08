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
const GPT_MODEL = process.env.GPT_MODEL || 'gpt-4o'; // switch to 'gpt-5' when available

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

// --- Arabic normalization (remove diacritics, unify letters) ---
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
    threshold: 0.36,
    keys: [
      '_normTrigger',
      '_normKeywords',
      '_normExamples',
      'reply.title',
      'reply.description'
    ]
  }
);

// === HANDLE INCOMING MESSAGES ===
app.post('/webhook', async (req, res) => {
  try {
    if (req.body.object !== 'page') return res.sendStatus(404);

    for (const entry of req.body.entry) {
      for (const event of entry.messaging) {
        const text = event?.message?.text;
        if (!text) continue;

        const senderId = event.sender.id;
        const userMessage = text.trim();
        if (!userMessage) continue;

        const finalReply = await getSmartReply(userMessage);

        await sendTypingOn(senderId);
        await delay(900);
        await sendReply(senderId, finalReply);
      }
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error('❌ Webhook error:', e);
    return res.sendStatus(500);
  }
});

// === SMART REPLY (custom → GPT rewrite | fallback → GPT) ===
async function getSmartReply(userMessage) {
  try {
    const norm = normalizeAr(userMessage);
    const results = fuse.search(norm);
    const top = results[0];
    const confident = top && top.score !== undefined && top.score <= 0.36;

    const persona = `
أنت طبيب أطفال وخبير عناية بشعر وبشرة الأطفال في شركة SmartKidz.
تتكلم بلغة مصرية مهذبة ودافئة. هدفك توجيه الأهل لاختيار المنتج الأنسب
وتسويق الفوائد الصحية بشكل أمين بدون مبالغة أو وعود علاجية قطعية.
نوّه أن الاستجابة قد تختلف من طفل لآخر.
`;

    let systemPrompt;
    let userPrompt;

    if (confident) {
      const intent = top.item;
      systemPrompt = persona + `
هذه معلومات داخلية عن منتج/عرض SmartKidz:
${JSON.stringify(intent.reply, null, 2)}

التعليمات:
- أعد الصياغة بأسلوب إنساني محترف يشبه نصيحة طبيب.
- ركّز على الفوائد العملية وتأثيرها على صحة الشعر/البشرة.
- لا تذكر كل شيء حرفيًا؛ لخّص بذكاء وبنبرة مطمئنة.
- اختم بدعوة لطيفة (سؤال توضيحي أو اقتراح تجربة/شراء).
- لا تقدّم ادعاءات طبية أو وعود نهائية.
`;
      userPrompt = userMessage;
    } else {
      systemPrompt = persona + `
السؤال قد يكون عامًا. قدّم إجابة عملية موجزة، ثم رشّح منتجًا واحدًا منطقيًا من القائمة.
لا تطلق وعودًا علاجية. اربط الرد بالفائدة الصحية للأطفال.
قائمة مختصرة للرجوع:
${JSON.stringify(
  customReplies.map(({ trigger, reply }) => ({
    trigger,
    title: reply?.title,
    highlights: reply?.highlights
  })),
  null,
  2
)}
`;
      userPrompt = userMessage;
    }

    const gpt = await axios.post(
      OPENAI_API_URL,
      {
        model: GPT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.65
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    // Build a unified reply payload we can send (text + images)
    const textFromGpt = (gpt.data.choices?.[0]?.message?.content || '').trim();

    // If we matched a custom intent, include its media (image + gallery) after the text
    let images = [];
    if (confident) {
      const r = top.item.reply || {};
      if (r.image) images.push(r.image);
      if (Array.isArray(r.gallery)) images = images.concat(r.gallery.filter(Boolean));
    }

    return formatReply(textFromGpt, images);
  } catch (e) {
    console.error('❌ OpenAI error:', e?.response?.data || e.message);
    return formatReply('عذرًا، حصلت مشكلة مؤقتة—ممكن نجرب تاني؟');
  }
}

// === Helper: combine text + image URLs into one message string ===
function formatReply(text = '', imageUrls = []) {
  const safeText = (text || '').trim();
  const mediaLines = (imageUrls || []).map(u => String(u).trim()).filter(Boolean);
  return [safeText, ...mediaLines].filter(Boolean).join('\n');
}

// === SEND TYPING ===
async function sendTypingOn(recipientId) {
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
  try {
    const parts = String(replyContent).split('\n').filter(p => p.trim());
    for (const part of parts) {
      const isUrl = /^https?:\/\/\S+$/i.test(part.trim());
      if (isUrl) {
        await axios.post(
          `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
          {
            recipient: { id: recipientId },
            message: {
              attachment: { type: 'image', payload: { url: part.trim(), is_reusable: true } }
            }
          }
        );
      } else {
        // Messenger hard limit is ~2000 chars; chunk just in case
        for (const chunk of chunkText(part, 1800)) {
          await axios.post(
            `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            { recipient: { id: recipientId }, message: { text: chunk } }
          );
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
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + max));
    i += max;
  }
  return out;
}

// === START ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
