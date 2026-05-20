// iPad 전용 서버 (iSH + Node.js)
// Ollama 없이 자체 MiniGPT 엔진만 실행
const express = require('express');
const path    = require('path');
const os      = require('os');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 자체 AI 엔진 (외부 의존성 없음)
const engineRouter = require('./routes/engine');
app.use('/engine', engineRouter);

// 동기화 (PC ↔ iPad 파일 교환)
try {
  const syncRouter = require('./routes/sync');
  app.use('/sync', syncRouter);
} catch {}

// 상태 확인
app.get('/server-status', (req, res) => {
  res.json({
    mode: 'iPad-standalone',
    platform: os.platform(),
    arch: os.arch(),
    memory: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) + 'GB',
    uptime: Math.floor(os.uptime()) + 's',
    engine: 'MiniGPT (custom JS transformer)',
    externalAI: false,
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'engine-studio.html'));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log('\n=== iPad AI 서버 시작 ===');
  console.log('AI 스튜디오: http://localhost:' + PORT + '/engine-studio.html');
  console.log('엔진 상태:   http://localhost:' + PORT + '/engine/status');
  console.log('외부 AI: 없음 (완전 자체 구동)');
  console.log('========================\n');
});
