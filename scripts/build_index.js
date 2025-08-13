// scripts/build_index.js
// Build a tiny semantic index (embeddings) from data/kb.xlsx
// Usage: npm run build:index

const path = require('path');
// Force-load .env from the repo root so the script always finds your keys
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const axios = require('axios');
const xlsx = require('xlsx');

const KB_PATH   = process.env.KB_PATH        || path.join(__dirname, '..', 'data', 'kb.xlsx');
const OUT_PATH  = process.env.KB_INDEX_PATH  || path.join(__dirname, '..', 'data', 'kb_index.json');
const EMB_MODEL = process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small';

if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY is missing. Put it in .env');
  process.exit(1);
}

function safeStr(v) {
  return (v ?? '').toString().trim();
}

function bi(ar, en) {
  // bilingual block: Arabic then English, each trimmed; omit empty lines
  const a = safeStr(ar);
  const e = safeStr(en);
  return [a, e].filter(Boolean).join('\n').trim();
}

function rowToDoc(row, type) {
  if (type === 'product') {
    const text = [
      'PRODUCT',
      `id: ${safeStr(row.id)}`,
      `name: ${bi(row.name_ar, row.name_en)}`,
      `features: ${bi(row.features_ar, row.features_en)}`,
      `usage: ${bi(row.usage_ar, row.usage_en)}`,
      `ingredients: ${bi(row.ingredients_ar, row.ingredients_en)}`,
      `tags: ${bi(row.tags_ar, row.tags_en)}`,
      `size: ${safeStr(row.size)}`,
      `age_range_years: ${safeStr(row.age_min)}-${safeStr(row.age_max)}`,
      `price_egp: ${safeStr(row.price_egp)}`,
      `link: ${safeStr(row.link)}`
    ].join('\n');
    return { id: `prod:${safeStr(row.id)}`, type, lang: 'bi', text, meta: row };
  }

  if (type === 'offer') {
    const text = [
      'OFFER',
      `offer_id: ${safeStr(row.offer_id)}`,
      `title: ${bi(row.title_ar, row.title_en)}`,
      `bundle_items: ${safeStr(row.items)}`,
      `price_egp: ${safeStr(row.price_egp)}`,
      `old_price_egp: ${safeStr(row.old_price_egp)}`,
      `valid: ${safeStr(row.valid_from)} -> ${safeStr(row.valid_to)}`,
      `notes: ${bi(row.notes_ar, row.notes_en)}`
    ].join('\n');
    return { id: `offer:${safeStr(row.offer_id)}`, type, lang: 'bi', text, meta: row };
  }

  if (type === 'snippet') {
    const topic = safeStr(row.topic);
    const text = `SNIPPET\ntopic: ${topic}\n${bi(row.text_ar, row.text_en)}`;
    return { id: `snip:${topic || Math.random().toString(36).slice(2, 8)}`, type, lang: 'bi', text, meta: row };
  }

  return null;
}

async function embedAll(chunks) {
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  };

  const results = [];
  const BATCH = 80;

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    process.stdout.write(`Embedding ${i + 1}-${i + batch.length} / ${chunks.length}...\r`);
    const { data } = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: EMB_MODEL, input: batch.map(d => d.text) },
      { headers, timeout: 120000 }
    );
    data.data.forEach((e, j) => results.push({ ...batch[j], vector: e.embedding }));
  }

  process.stdout.write('\n');
  return results;
}

function readSheet(wb, name) {
  const sh = wb.Sheets[name];
  return sh ? xlsx.utils.sheet_to_json(sh, { defval: '' }) : [];
}

(async () => {
  if (!fs.existsSync(KB_PATH)) {
    console.error(`ERROR: Could not find Excel file at ${KB_PATH}`);
    process.exit(1);
  }

  const wb = xlsx.readFile(KB_PATH);
  const products = readSheet(wb, 'products').map(r => rowToDoc(r, 'product')).filter(Boolean);
  const offers   = readSheet(wb, 'offers').map(r => rowToDoc(r, 'offer')).filter(Boolean);
  const snippets = readSheet(wb, 'snippets').map(r => rowToDoc(r, 'snippet')).filter(Boolean);

  const docs = [...products, ...offers, ...snippets];
  if (!docs.length) {
    throw new Error('kb.xlsx is empty (no rows in sheets: products/offers/snippets).');
  }

  console.log(`Loaded rows — products: ${products.length}, offers: ${offers.length}, snippets: ${snippets.length}`);
  const withVecs = await embedAll(docs);

  if (!withVecs.length || !withVecs[0].vector) {
    throw new Error('Embedding step returned no vectors.');
  }

  const dims = withVecs[0].vector.length;
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ model: EMB_MODEL, dims, docs: withVecs }, null, 2));
  console.log(`Built index: ${withVecs.length} docs (dims=${dims}) -> ${OUT_PATH}`);
})().catch(err => {
  console.error('\nBuild failed:', err?.response?.data || err);
  process.exit(1);
});
