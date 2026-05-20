// Knowledge sync service: PC <-> iPad via file exchange
const fs = require('fs');
const path = require('path');
const knowledge = require('./knowledge');

const SYNC_DIR = process.env.SYNC_DIR || path.join(__dirname, '..', 'sync');
const PC_EXPORT_FILE  = path.join(SYNC_DIR, 'pc-knowledge.json');
const PC_EXPORT_MD    = path.join(SYNC_DIR, 'pc-knowledge.md');
const IPAD_PROMPT_FILE = path.join(SYNC_DIR, 'ipad-system-prompt.txt');
const IPAD_IMPORT_FILE = path.join(SYNC_DIR, 'ipad-export.json');
const META_FILE       = path.join(SYNC_DIR, 'sync-meta.json');

function ensureDir() {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
}

// ── Export PC knowledge → sync folder ────────────────────────────────────────
function exportPC() {
  ensureDir();

  const entries = knowledge.exportEntries();
  const exportData = {
    version: '1.0',
    device: 'PC',
    exportedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  };

  fs.writeFileSync(PC_EXPORT_FILE, JSON.stringify(exportData, null, 2), 'utf8');

  // Markdown version (human-readable)
  fs.writeFileSync(PC_EXPORT_MD, buildMarkdown(entries), 'utf8');

  // iPad system prompt (compressed, top 60 entries by score)
  const systemPrompt = buildIpadPrompt(entries);
  fs.writeFileSync(IPAD_PROMPT_FILE, systemPrompt, 'utf8');

  updateMeta({ lastPcExport: new Date().toISOString(), pcCount: entries.length });

  return {
    json: PC_EXPORT_FILE,
    markdown: PC_EXPORT_MD,
    prompt: IPAD_PROMPT_FILE,
    count: entries.length,
  };
}

// ── Import iPad export → PC knowledge base ────────────────────────────────────
async function importIPad(filePath = IPAD_IMPORT_FILE) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`파일 없음: ${filePath}`);
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Support PocketPal chat export format and our own format
  const entries = normalizeIpadExport(raw);

  const count = await knowledge.importEntries(entries);
  updateMeta({ lastIpadImport: new Date().toISOString(), lastIpadCount: count });

  return { imported: count, total: entries.length };
}

// ── Convert various iPad export formats to our entry format ──────────────────
function normalizeIpadExport(raw) {
  // Our own format
  if (raw.entries && Array.isArray(raw.entries)) {
    return raw.entries.map(e => ({ ...e, source: e.source || 'ipad_sync' }));
  }

  // PocketPal AI / LLM Farm chat export (array of messages)
  if (Array.isArray(raw)) {
    const entries = [];
    for (let i = 0; i < raw.length - 1; i++) {
      const m = raw[i];
      const next = raw[i + 1];
      if (m.role === 'user' && next?.role === 'assistant') {
        entries.push({
          content: `[iPad 대화]\n질문: ${m.content}\n답변: ${next.content}`,
          source: 'ipad_sync',
          sourceDetail: `[iPad] ${m.timestamp || new Date().toISOString()}`,
          score: 1.0,
        });
        i++; // skip assistant message
      }
    }
    return entries;
  }

  // Generic: treat whole file content as one knowledge entry
  return [{
    content: typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2),
    source: 'ipad_sync',
    sourceDetail: '[iPad] 수동 가져오기',
    score: 1.0,
  }];
}

// ── Build iPad system prompt from PC knowledge ────────────────────────────────
function buildIpadPrompt(entries, maxChars = 8000) {
  const sourceLabel = {
    conversation: '대화 학습',
    url: 'URL 학습',
    simulation: '시뮬레이션',
    manual: '직접 입력',
    ipad_sync: 'iPad 동기화',
  };

  // Sort by score desc, take best entries
  const sorted = [...entries]
    .sort((a, b) => (b.score || 1) - (a.score || 1))
    .slice(0, 80);

  let prompt = `당신은 자가 학습 AI 어시스턴트입니다. 다음은 PC에서 학습된 지식입니다. 이 내용을 바탕으로 답변하세요.\n\n`;
  prompt += `=== 학습된 지식 (총 ${entries.length}개 중 상위 ${sorted.length}개) ===\n\n`;

  for (const e of sorted) {
    const label = sourceLabel[e.source] || e.source;
    const addition = `[${label}] ${e.content}\n\n`;
    if (prompt.length + addition.length > maxChars) break;
    prompt += addition;
  }

  return prompt;
}

// ── Build Markdown for human review ──────────────────────────────────────────
function buildMarkdown(entries) {
  const bySource = {};
  for (const e of entries) {
    (bySource[e.source] = bySource[e.source] || []).push(e);
  }

  const labels = {
    conversation: '💬 대화 학습',
    url: '🌐 URL 학습',
    simulation: '🔬 시뮬레이션 최적화',
    manual: '✍️ 직접 입력',
    ipad_sync: '📱 iPad 동기화',
  };

  let md = `# AI 지식 베이스 내보내기\n\n`;
  md += `- 생성: ${new Date().toLocaleString('ko-KR')}\n`;
  md += `- 총 ${entries.length}개\n\n`;

  for (const [src, items] of Object.entries(bySource)) {
    md += `## ${labels[src] || src} (${items.length}개)\n\n`;
    for (const item of items.slice(0, 30)) {
      md += `### ${item.sourceDetail || ''}\n\n${item.content}\n\n---\n\n`;
    }
  }

  return md;
}

// ── Sync metadata ─────────────────────────────────────────────────────────────
function updateMeta(update) {
  ensureDir();
  let meta = {};
  if (fs.existsSync(META_FILE)) {
    try { meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch {}
  }
  Object.assign(meta, update);
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
}

function getMeta() {
  if (!fs.existsSync(META_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; }
}

function getSyncFiles() {
  ensureDir();
  const files = [
    { name: 'pc-knowledge.json', path: PC_EXPORT_FILE, label: 'PC 지식 (JSON)', desc: '→ iPad 앱에 가져오기' },
    { name: 'pc-knowledge.md',   path: PC_EXPORT_MD,   label: 'PC 지식 (Markdown)', desc: '사람이 읽을 수 있는 형식' },
    { name: 'ipad-system-prompt.txt', path: IPAD_PROMPT_FILE, label: 'iPad 시스템 프롬프트', desc: '→ 앱의 시스템 프롬프트에 붙여넣기' },
  ];
  return files.map(f => ({
    ...f,
    exists: fs.existsSync(f.path),
    size: fs.existsSync(f.path) ? fs.statSync(f.path).size : 0,
    mtime: fs.existsSync(f.path) ? fs.statSync(f.path).mtime.toISOString() : null,
  }));
}

module.exports = {
  exportPC, importIPad, getMeta, getSyncFiles,
  SYNC_DIR, PC_EXPORT_FILE, PC_EXPORT_MD, IPAD_PROMPT_FILE, IPAD_IMPORT_FILE,
};
