// Local vector knowledge base (JSON file + cosine similarity, no external DB)
const fs = require('fs');
const path = require('path');
const ollama = require('./ollama');

const KB_FILE = path.join(__dirname, '..', 'data', 'knowledge.json');
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const TOP_K = 5;

let _store = null; // in-memory cache

function load() {
  if (_store) return _store;
  try {
    if (fs.existsSync(KB_FILE)) {
      _store = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
    }
  } catch {}
  if (!Array.isArray(_store)) _store = [];
  return _store;
}

function save() {
  fs.mkdirSync(path.dirname(KB_FILE), { recursive: true });
  fs.writeFileSync(KB_FILE, JSON.stringify(_store, null, 2), 'utf8');
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Split text into overlapping chunks
function chunkText(text, size = 400, overlap = 60) {
  const sentences = text.replace(/\r\n/g, '\n').split(/(?<=[.!?。\n])\s+/);
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur.length + s.length > size && cur.length > 0) {
      chunks.push(cur.trim());
      const words = cur.split(' ');
      cur = words.slice(Math.max(0, words.length - Math.floor(overlap / 5))).join(' ') + ' ' + s;
    } else {
      cur += (cur ? ' ' : '') + s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(c => c.length > 20);
}

async function embed(text) {
  const res = await fetch(`${ollama.OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Embed error: ${res.status}`);
  const data = await res.json();
  return data.embedding;
}

async function add({ content, source, sourceDetail = '', score = 1.0, metadata = {} }) {
  const store = load();
  const chunks = chunkText(content);

  for (const chunk of chunks) {
    // Dedup: skip if very similar to existing entry from same source
    const embedding = await embed(chunk);
    const isDuplicate = store.some(e =>
      e.sourceDetail === sourceDetail && cosineSim(e.embedding, embedding) > 0.97
    );
    if (isDuplicate) continue;

    store.push({
      id: Date.now() + Math.random(),
      content: chunk,
      embedding,
      source,
      sourceDetail,
      score,
      metadata,
      createdAt: new Date().toISOString(),
    });
  }

  save();
  return chunks.length;
}

async function search(query, { topK = TOP_K, minScore = 0.3, sourceFilter } = {}) {
  const store = load();
  if (store.length === 0) return [];

  const qEmbed = await embed(query);
  const scored = store
    .filter(e => !sourceFilter || e.source === sourceFilter)
    .map(e => ({ ...e, sim: cosineSim(qEmbed, e.embedding) }))
    .filter(e => e.sim >= minScore)
    .sort((a, b) => (b.sim * b.score) - (a.sim * a.score))
    .slice(0, topK);

  return scored;
}

function stats() {
  const store = load();
  const bySource = {};
  for (const e of store) {
    bySource[e.source] = (bySource[e.source] || 0) + 1;
  }
  return { total: store.length, bySource };
}

function deleteById(id) {
  _store = load().filter(e => e.id !== id);
  save();
}

function clear(source) {
  _store = source ? load().filter(e => e.source !== source) : [];
  save();
}

// Return raw entries without embeddings (for export/sync)
function exportEntries() {
  return load().map(({ embedding, ...rest }) => rest);
}

// Import entries from another device (re-embeds on this machine)
async function importEntries(entries) {
  let count = 0;
  for (const e of entries) {
    try {
      await add({
        content: e.content,
        source: e.source,
        sourceDetail: e.sourceDetail,
        score: e.score || 1.0,
        metadata: e.metadata || {},
      });
      count++;
    } catch {}
  }
  return count;
}

module.exports = { add, search, stats, deleteById, clear, embed, chunkText, exportEntries, importEntries, EMBED_MODEL };
