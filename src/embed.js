const axios = require('axios');
const EMB_MODEL = process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small';

async function embedQuery(text){
  const { data } = await axios.post('https://api.openai.com/v1/embeddings', {
    model: EMB_MODEL, input: [text]
  }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }});
  return data.data[0].embedding;
}

module.exports = { embedQuery };
