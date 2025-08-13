// node scripts/build_index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xlsx = require('xlsx');

const KB_PATH = process.env.KB_PATH || path.join(__dirname, '..', 'data', 'kb.xlsx');
const OUT_PATH = process.env.KB_INDEX_PATH || path.join(__dirname, '..', 'data', 'kb_index.json');
const EMB_MODEL = process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small';

function rowToDoc(row, type) {
  const bi = (ar, en) => `${ar || ''}\n${en || ''}`.trim();
  if (type === 'product') {
    const text = [
      `PRODUCT`,
      `id: ${row.id}`,
      `name: ${bi(row.name_ar, row.name_en)}`,
      `features: ${bi(row.features_ar, row.features_en)}`,
      `usage: ${bi(row.usage_ar, row.usage_en)}`,
      `ingredients: ${bi(row.ingredients_ar, row.ingredients_en)}`,
      `tags: ${bi(row.tags_ar, row.tags_en)}`,
      `size: ${row.size || ''}`,
      `age_range_years: ${row.age_min || ''}-${row.age_max || ''}`,
      `price_egp: ${row.price_egp || ''}`,
      `link: ${row.link || ''}`
    ].join('\n');
    return { id: `prod:${row.id}`, type, lang: 'bi', text, meta: row };
  }
  if (type === 'offer') {
    const text = [
      `OFFER`,
      `offer_id: ${row.offer_id}`,
      `title: ${bi(row.title_ar, row.title_en)}`,
      `bundle_items: ${row.items || ''}`,
      `price_egp: ${row.price_egp || ''}`,
      `old_price_egp: ${row.old_price_egp || ''}`,
      `valid: ${row.valid_from || ''} -> ${row.valid_to || ''}`,
      `notes: ${bi(row.notes_ar, row.notes_en)}`
    ].join('\n');
    return { id: `offer:${row.offer_id}`, type, lang: 'bi', text, meta: row };
  }
  if (type === 'snippet') {
    const text = `SNIPPET\ntopic: ${row.topic}\n${bi(row.text_ar, row.text_en)}`;
    return { id: `snip:${row.topic}`, type, lang: 'bi', text, meta: row };
  }
}

async function embedAll(chunks) {
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  const results = [];
  const B = 80;
  for (let i = 0; i < chunks.length; i += B) {
    const batch = chunks.slice(i, i + B);
    const { data } = await axios.post('https://api.openai.com/v1/embeddings', {
      model: EMB_MODEL,
      input: batch.map(d => d.text)
    }, { headers });
    data.data.forEach((e, j) => results.push({ ...batch[j], vector: e.embedding }));
  }
  return results;
}

function readSheet(wb, name) {
  const sh = wb.Sheets[name];
  return sh ? xlsx.utils.sheet_to_json(sh, { defval: '' }) : [];
}

(async () => {
  const wb = xlsx.readFile(KB_PATH);
  const products = readSheet(wb, 'products').map(r => rowToDoc(r, 'product'));
  const offers   = readSheet(wb, 'offers').map(r => rowToDoc(r, 'offer'));
  const snippets = readSheet(wb, 'snippets').map(r => rowToDoc(r, 'snippet'));
  const docs = [...products, ...offers, ...snippets];

  if (!docs.length) throw new Error('kb.xlsx is empty');

  const withVecs = await embedAll(docs);
  const dims = withVecs[0].vector.length;
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ model: EMB_MODEL, dims, docs: withVecs }, null, 2));
  console.log(`Built index: ${withVecs.length} docs -> ${OUT_PATH}`);
})();
