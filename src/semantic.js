const fs = require('fs');
const path = require('path');

function dot(a,b){ let s=0; for(let i=0;i<a.length;i++) s += a[i]*b[i]; return s; }
function norm(a){ return Math.sqrt(dot(a,a)); }

function loadIndex() {
  const file = process.env.KB_INDEX_PATH || path.join(__dirname, '..', 'data', 'kb_index.json');
  const raw = fs.readFileSync(file, 'utf8');
  const idx = JSON.parse(raw);
  idx.docs.forEach(d => d._n = norm(d.vector));
  return idx;
}

function rankBySimilarity(index, qVec, topK=5) {
  const qn = norm(qVec);
  const scored = index.docs.map(d => ({ d, s: qn ? dot(d.vector, qVec)/(d._n*qn) : 0 }));
  scored.sort((x,y)=>y.s-x.s);
  return scored.slice(0, topK);
}

module.exports = { loadIndex, rankBySimilarity };
