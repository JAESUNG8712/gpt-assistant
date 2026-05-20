// Training loop + text generation for MiniGPT
const fs   = require('fs');
const path = require('path');
const { forward, loss, backward, allParams, zeroGrads, createModel, toJSON, fromJSON, CONFIG } = require('./model');
const tokenizer = require('./tokenizer');
const Adam = require('./optimizer');

const WEIGHTS_FILE = path.join(__dirname, '..', 'data', 'minigpt-weights.json');
const LOG_FILE     = path.join(__dirname, '..', 'data', 'minigpt-log.json');

// ── Singleton model + optimizer ───────────────────────────────────────────────
let _model = null;
let _opt   = null;
let _log   = { steps: 0, losses: [], trainedChars: 0 };
let _training = false;

function getModel() {
  if (_model) return _model;
  if (fs.existsSync(WEIGHTS_FILE)) {
    try {
      _model = fromJSON(JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')));
      console.log('[MiniGPT] 저장된 가중치 불러옴');
    } catch { _model = createModel(); }
  } else {
    _model = createModel();
    console.log('[MiniGPT] 새 모델 초기화');
  }
  if (fs.existsSync(LOG_FILE)) {
    try { _log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  }
  _opt = new Adam({ lr: 3e-4 });
  return _model;
}

function saveModel() {
  fs.mkdirSync(path.dirname(WEIGHTS_FILE), { recursive: true });
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(toJSON(_model)), 'utf8');
  fs.writeFileSync(LOG_FILE, JSON.stringify(_log), 'utf8');
}

// ── Train one batch ───────────────────────────────────────────────────────────
function trainStep(tokens) {
  const model = getModel();
  const ctxLen = model.cfg.ctxLen;
  if (tokens.length < ctxLen + 1) return null;

  // Random window from the token sequence
  const start  = Math.floor(Math.random() * (tokens.length - ctxLen));
  const input  = tokens.slice(start, start + ctxLen);
  const target = tokens.slice(start + 1, start + ctxLen + 1);

  zeroGrads(model);
  const { logits, cache } = forward(model, input);
  const { loss: L, dLogits } = loss(logits, target);
  backward(model, cache, dLogits);

  const params = allParams(model);
  Adam.clipGrads(params, model._embedGrad, 1.0);
  _opt.step(params, model.embed, model._embedGrad);

  _log.steps++;
  _log.losses.push(parseFloat(L.toFixed(4)));
  if (_log.losses.length > 200) _log.losses = _log.losses.slice(-200);
  return L;
}

// ── Train on text corpus (async, yields to event loop) ────────────────────────
async function trainOnText(text, { steps = 200, onProgress } = {}) {
  if (_training) return { error: '이미 학습 중입니다' };
  _training = true;

  const model = getModel();
  const tokens = tokenizer.encode(text);
  _log.trainedChars += text.length;

  let totalLoss = 0;
  for (let i = 0; i < steps; i++) {
    const L = trainStep(tokens);
    if (L !== null) totalLoss += L;

    // Yield every 10 steps so server stays responsive
    if (i % 10 === 0) {
      if (onProgress) onProgress({ step: i + 1, total: steps, loss: L });
      await new Promise(r => setImmediate(r));
    }
  }

  saveModel();
  _training = false;
  return { steps, avgLoss: totalLoss / steps, totalSteps: _log.steps };
}

// ── Text generation ──────────────────────────────────────────────────────────
function generate(prompt, { maxNew = 200, temperature = 0.8, topK = 40 } = {}) {
  const model = getModel();
  const ctxLen = model.cfg.ctxLen;
  let tokens = tokenizer.encode(prompt);
  if (tokens.length === 0) tokens = [10]; // newline as default start

  const generated = [];

  for (let step = 0; step < maxNew; step++) {
    // Use last ctxLen tokens as context
    const ctx = tokens.slice(-ctxLen);
    const { logits } = forward(model, ctx);
    const T = ctx.length;
    const lastLogits = logits.row(T - 1); // shape (1, vocabSize)

    // Temperature scaling + top-k sampling
    const V = model.cfg.vocabSize;
    const scaled = new Float32Array(V);
    for (let j = 0; j < V; j++) scaled[j] = lastLogits.data[j] / Math.max(temperature, 1e-6);

    // Top-k masking
    if (topK < V) {
      const sorted = Array.from(scaled).map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
      const threshold = sorted[topK].v;
      for (let j = 0; j < V; j++) if (scaled[j] < threshold) scaled[j] = -1e9;
    }

    // Softmax + sample
    let max = -Infinity;
    for (let j = 0; j < V; j++) if (scaled[j] > max) max = scaled[j];
    let sum = 0;
    const probs = new Float32Array(V);
    for (let j = 0; j < V; j++) { probs[j] = Math.exp(scaled[j] - max); sum += probs[j]; }
    let r = Math.random() * sum, nextTok = V - 1;
    for (let j = 0; j < V; j++) { r -= probs[j]; if (r <= 0) { nextTok = j; break; } }

    tokens.push(nextTok);
    generated.push(nextTok);
  }

  return tokenizer.decode(generated);
}

function stats() {
  const model = getModel();
  const paramCount = allParams(model).reduce((s, p) => s + p.W.data.length, 0)
    + model.embed.data.length + model.posEmbed.data.length;
  return {
    steps: _log.steps,
    trainedChars: _log.trainedChars,
    recentLoss: _log.losses.slice(-10),
    avgLoss: _log.losses.length > 0
      ? (_log.losses.slice(-50).reduce((a, b) => a + b, 0) / Math.min(_log.losses.length, 50)).toFixed(4)
      : null,
    params: paramCount,
    config: model.cfg,
    isTraining: _training,
    hasWeights: fs.existsSync(WEIGHTS_FILE),
  };
}

module.exports = { getModel, trainOnText, generate, stats, saveModel };
