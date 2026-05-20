const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'phi4-mini';

async function isAvailable() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function listModels() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => m.name);
  } catch {
    return [];
  }
}

const NUM_CTX = parseInt(process.env.OLLAMA_CTX || '8192');

async function chat(messages, { model = DEFAULT_MODEL, stream = false } = {}) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream,
      options: { num_ctx: NUM_CTX },   // 컨텍스트 창 확장
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama ${res.status}: ${err}`);
  }

  if (stream) return res;

  const data = await res.json();
  return data.message?.content || '';
}

// 문자 수 기준 토큰 추정 (한글 1자 ≈ 1.5토큰, 영문 1자 ≈ 0.25토큰)
function estimateTokens(text) {
  const korean = (text.match(/[가-힣]/g) || []).length;
  const other = text.length - korean;
  return Math.ceil(korean * 1.5 + other * 0.25);
}

module.exports = { isAvailable, listModels, chat, estimateTokens, OLLAMA_URL, DEFAULT_MODEL, NUM_CTX };
