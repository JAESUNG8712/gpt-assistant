const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const budgetRouter = require('./budget');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/budget', budgetRouter);

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 에이전트 미설정 시 기본팀 자동 적용
function ensureDefaultTeam(account, data) {
  if (account.pinnedAgents.length === 0 && data.defaultTeam) {
    account.pinnedAgents = [...data.defaultTeam];
    writeData(data);
  }
}

// 전체 에이전트 목록
app.get('/api/agents', (req, res) => {
  const data = readData();
  res.json({ agents: data.agents });
});

// 계정 목록
app.get('/api/accounts', (req, res) => {
  const data = readData();
  res.json({
    accounts: data.accounts.map(a => ({ id: a.id, email: a.email, name: a.name }))
  });
});

// 고정된 에이전트 조회 (ID)
app.get('/api/accounts/:accountId/pinned-agents', (req, res) => {
  const data = readData();
  const account = data.accounts.find(a => a.id === req.params.accountId);
  if (!account) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });

  ensureDefaultTeam(account, data);

  const pinnedAgents = data.agents.filter(a => account.pinnedAgents.includes(a.id));
  res.json({
    account: { id: account.id, email: account.email, name: account.name },
    pinnedAgents,
    count: pinnedAgents.length
  });
});

// 고정된 에이전트 조회 (이메일)
app.get('/api/accounts/by-email/:email/pinned-agents', (req, res) => {
  const data = readData();
  const account = data.accounts.find(a => a.email === req.params.email);
  if (!account) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });

  ensureDefaultTeam(account, data);

  const pinnedAgents = data.agents.filter(a => account.pinnedAgents.includes(a.id));
  res.json({
    account: { id: account.id, email: account.email, name: account.name },
    pinnedAgents,
    count: pinnedAgents.length
  });
});

// 에이전트 고정
app.post('/api/accounts/:accountId/pinned-agents/:agentId', (req, res) => {
  const data = readData();
  const account = data.accounts.find(a => a.id === req.params.accountId);
  const agent = data.agents.find(a => a.id === req.params.agentId);
  if (!account) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  if (!agent) return res.status(404).json({ error: '에이전트를 찾을 수 없습니다.' });
  if (account.pinnedAgents.includes(req.params.agentId)) {
    return res.status(409).json({ error: '이미 고정된 에이전트입니다.' });
  }
  account.pinnedAgents.push(req.params.agentId);
  writeData(data);
  res.json({ message: `${agent.name} 에이전트가 고정되었습니다.`, agent });
});

// 에이전트 고정 해제
app.delete('/api/accounts/:accountId/pinned-agents/:agentId', (req, res) => {
  const data = readData();
  const account = data.accounts.find(a => a.id === req.params.accountId);
  const agent = data.agents.find(a => a.id === req.params.agentId);
  if (!account) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  if (!agent) return res.status(404).json({ error: '에이전트를 찾을 수 없습니다.' });
  const idx = account.pinnedAgents.indexOf(req.params.agentId);
  if (idx === -1) return res.status(404).json({ error: '고정되지 않은 에이전트입니다.' });
  account.pinnedAgents.splice(idx, 1);
  writeData(data);
  res.json({ message: `${agent.name} 에이전트 고정이 해제되었습니다.`, agent });
});

// 프로젝트 메모리(맥락) 조회
app.get('/api/accounts/:accountId/memory', (req, res) => {
  const data = readData();
  const account = data.accounts.find(a => a.id === req.params.accountId);
  if (!account) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  res.json({ memory: account.memory || {} });
});

// 프로젝트 맥락 추가 (대화/결정 사항 기억)
app.post('/api/accounts/:accountId/memory/context', (req, res) => {
  const { content, type = 'note' } = req.body;
  if (!content) return res.status(400).json({ error: 'content가 필요합니다.' });

  const data = readData();
  const account = data.accounts.find(a => a.id === req.params.accountId);
  if (!account) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });

  if (!account.memory) account.memory = { projectContext: [], decisions: [] };
  if (!account.memory.projectContext) account.memory.projectContext = [];

  const entry = { id: Date.now(), type, content, savedAt: new Date().toISOString() };
  account.memory.projectContext.push(entry);
  writeData(data);
  res.json({ message: '맥락이 저장되었습니다.', entry });
});

// 결정 사항 저장
app.post('/api/accounts/:accountId/memory/decisions', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content가 필요합니다.' });

  const data = readData();
  const account = data.accounts.find(a => a.id === req.params.accountId);
  if (!account) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });

  if (!account.memory) account.memory = { projectContext: [], decisions: [] };
  if (!account.memory.decisions) account.memory.decisions = [];

  const entry = { id: Date.now(), content, decidedAt: new Date().toISOString() };
  account.memory.decisions.push(entry);
  writeData(data);
  res.json({ message: '결정 사항이 저장되었습니다.', entry });
});

// 메모리 항목 삭제
app.delete('/api/accounts/:accountId/memory/context/:entryId', (req, res) => {
  const data = readData();
  const account = data.accounts.find(a => a.id === req.params.accountId);
  if (!account) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });

  const id = parseInt(req.params.entryId);
  account.memory.projectContext = (account.memory.projectContext || []).filter(e => e.id !== id);
  writeData(data);
  res.json({ message: '항목이 삭제되었습니다.' });
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
