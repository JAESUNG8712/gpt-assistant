const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 전체 에이전트 목록 조회
app.get('/api/agents', (req, res) => {
  const data = readData();
  res.json({ agents: data.agents });
});

// 계정 목록 조회
app.get('/api/accounts', (req, res) => {
  const data = readData();
  res.json({ accounts: data.accounts.map(a => ({ id: a.id, email: a.email, name: a.name })) });
});

// 특정 계정의 고정된 에이전트 조회
app.get('/api/accounts/:accountId/pinned-agents', (req, res) => {
  const data = readData();
  const account = data.accounts.find(a => a.id === req.params.accountId);

  if (!account) {
    return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  }

  const pinnedAgents = data.agents.filter(agent =>
    account.pinnedAgents.includes(agent.id)
  );

  res.json({
    account: { id: account.id, email: account.email, name: account.name },
    pinnedAgents,
    count: pinnedAgents.length
  });
});

// 이메일로 계정의 고정된 에이전트 조회
app.get('/api/accounts/by-email/:email/pinned-agents', (req, res) => {
  const data = readData();
  const account = data.accounts.find(a => a.email === req.params.email);

  if (!account) {
    return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  }

  const pinnedAgents = data.agents.filter(agent =>
    account.pinnedAgents.includes(agent.id)
  );

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
  if (idx === -1) {
    return res.status(404).json({ error: '고정되지 않은 에이전트입니다.' });
  }

  account.pinnedAgents.splice(idx, 1);
  writeData(data);

  res.json({ message: `${agent.name} 에이전트 고정이 해제되었습니다.`, agent });
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
