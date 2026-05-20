const express = require('express');
const router  = express.Router();
const trainer = require('../engine/trainer');

// GET /engine/status
router.get('/status', (req, res) => {
  res.json(trainer.stats());
});

// POST /engine/train  — train on text (SSE progress stream)
router.post('/train', async (req, res) => {
  const { text, steps = 300 } = req.body;
  if (!text || text.length < 10)
    return res.status(400).json({ error: '학습할 텍스트가 너무 짧습니다 (10자 이상)' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`event: start\ndata: ${JSON.stringify({ steps, chars: text.length })}\n\n`);

  try {
    const result = await trainer.trainOnText(text, {
      steps: Math.min(steps, 2000),
      onProgress: ({ step, total, loss }) => {
        res.write(`event: progress\ndata: ${JSON.stringify({ step, total, loss })}\n\n`);
      },
    });
    res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// POST /engine/chat  — generate response (SSE token stream)
router.post('/chat', async (req, res) => {
  const { prompt = '', maxNew = 300, temperature = 0.8, topK = 40 } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    // Generate in chunks for streaming effect
    const chunkSize = 20;
    const iters = Math.ceil(maxNew / chunkSize);
    let fullText = '';

    for (let i = 0; i < iters; i++) {
      const chunk = trainer.generate(prompt + fullText, {
        maxNew: chunkSize,
        temperature,
        topK,
      });
      fullText += chunk;
      res.write(`event: token\ndata: ${JSON.stringify({ token: chunk })}\n\n`);
      // Yield to event loop
      await new Promise(r => setImmediate(r));
    }

    // Auto-learn from this exchange
    const trainingText = `${prompt}\n${fullText}\n`;
    trainer.trainOnText(trainingText, { steps: 50 }).catch(() => {});

    res.write(`event: done\ndata: {}\n\n`);
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// GET /engine/export  — download weights as JSON (for iPad transfer)
router.get('/export', (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const wf = path.join(__dirname, '..', 'data', 'minigpt-weights.json');
  const lf = path.join(__dirname, '..', 'data', 'minigpt-log.json');
  if (!fs.existsSync(wf)) return res.status(404).json({ error: '저장된 가중치 없음. 먼저 학습을 실행하세요.' });
  const weights = fs.readFileSync(wf, 'utf8');
  const log = fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8') : '{}';
  const bundle = JSON.stringify({ weights: JSON.parse(weights), log: JSON.parse(log), exportedAt: new Date().toISOString() });
  res.setHeader('Content-Disposition', 'attachment; filename="minigpt-weights.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(bundle);
});

// POST /engine/import  — upload weights from iPad
router.post('/import', express.json({ limit: '200mb' }), (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const { weights, log } = req.body;
  if (!weights) return res.status(400).json({ error: 'weights 필드 없음' });
  const wf = path.join(__dirname, '..', 'data', 'minigpt-weights.json');
  const lf = path.join(__dirname, '..', 'data', 'minigpt-log.json');
  fs.mkdirSync(path.dirname(wf), { recursive: true });
  fs.writeFileSync(wf, JSON.stringify(weights), 'utf8');
  if (log) fs.writeFileSync(lf, JSON.stringify(log), 'utf8');
  res.json({ ok: true });
});

// POST /engine/reset  — reinitialise model weights
router.post('/reset', (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const wf = path.join(__dirname, '..', 'data', 'minigpt-weights.json');
  const lf = path.join(__dirname, '..', 'data', 'minigpt-log.json');
  try { fs.unlinkSync(wf); } catch {}
  try { fs.unlinkSync(lf); } catch {}
  res.json({ ok: true, message: '모델이 초기화되었습니다. 서버를 재시작하세요.' });
});

module.exports = router;
