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
const GPT_MODEL = process.env.GPT_MODEL || 'gpt-4o'; // set to gpt-5 when you have it

// === Build fuzzy index over intents ===
const fuse = new Fuse(customReplies, {
  includeScore: true,
  threshold: 0.36,                    // lower = stricter
  keys: ['trigger', 'keywords', 'examples', 'reply.title', 'reply.description']
});

// --- Simple Arabic normalization (kill diacritics, unify alif/ya/ta marbuta) ---
function normalizeAr(str = '') {
  return str
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, '')       // tashkeel
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

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
        await new Promise(r => setTimeout(r, 900));
        await sendReply(senderId, finalReply);
      }
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error('❌ Webhook error:', e);
    return res.sendStatus(500);
  }
});

// === SMART REPLY ===
async function getSmartReply(userMessage) {
  try {
    // 1) Try to match a custom intent (fuzzy)
    const norm = normalizeAr(userMessage);
    const results = fuse.search(norm);

    const top = results[0];
    const confident = top && top.score !== undefined && top.score <= 0.36;

    // 2) Build a persona/system prompt
    const baseSystem = `
أنت طبيب أطفال وخبير عناية بشعر وبشرة الأطفال في شركة SmartKidz.
تتكلم بلغة مصرية مهذبة ومهنية، دافئة ومطمئِنة.
الهدف: مساعدة الأهل على اختيار منتج مناسب وتسويق الفوائد الصحية بشكل أمين بلا مبالغة طبية.
تجنب الوعود العلاجية القطعية، واذكر دائمًا إمكانية اختلاف الاستجابة من طفل لآخر.
لو كان السؤال عامًا، قدّم نصيحة عملية واربطها بمنتج مناسب بحكمة.
`;

    let systemPrompt;
    let userPrompt;

    if (confident) {
      // Rephrase + personalize the matched reply through GPT
      const intent = top.item;
      systemPrompt = baseSystem + `
هذه بيانات داخلية عن منتج/عرض من SmartKidz لا تُظهرها كلها حرفيًا، بل استخدمها لصياغة رد إنساني محترف:
${JSON.stringify(intent.reply, null, 2)}

التعليمات:
- لخّص الفائدة والنتائج المتوقعة بشكل لطيف.
- إذا كانت هناك صورة في reply.image أرسل الرابط في سطر منفصل.
- اختم بدعوة خفيفة لاتخاذ خطوة (سؤال توضيحي أو شراء/تجربة).
`;
      userPrompt = userMessage;
    } else {
      // Fallback: generic question → GPT answers + softly links to product
      systemPrompt = baseSystem + `
إن لم تكن هناك معلومة منتج دقيقة، أعطِ إجابة عامة مفيدة، ثم رشّح منتجًا واحدًا من القائمة أدناه بشكل منطقي.
لا تقدّم ادعاءات علاجية. كن موجزًا وواضحًا.
${JSON.stringify(customReplies.map(({ trigger, reply }) => ({
  trigger,
  title: reply.title,
  highlights: reply.highlights
})), null, 2)}
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
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    return gpt.data.choices[0].message.content?.trim() || 'تمام، تحت أمرك.';
  } catch (e) {
    console.error('❌ OpenAI error:', e?.response?.data || e.message);
    return 'عذرًا، حصلت مشكلة مؤقتة—ممكن نجرب تاني؟';
  }
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
    const parts = replyContent.split('\n').filter(p => p.trim());
    for (const part of parts) {
      const isUrl = /^https?:\/\/\S+$/i.test(part.trim());
      if (isUrl) {
        await axios.post(
          `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
          {
            recipient: { id: recipientId },
            message: { attachment: { type: 'image', payload: { url: part.trim(), is_reusable: true } } }
          }
        );
      } else {
        await axios.post(
          `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
          { recipient: { id: recipientId }, message: { text: part } }
        );
      }
    }
  } catch (e) {
    console.error('Send error:', e?.response?.data || e.message);
  }
}

// === START ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
