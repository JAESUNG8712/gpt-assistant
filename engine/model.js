// MiniGPT — custom transformer language model
// Architecture: Embedding → N × (Attention + FFN) → LM head
// All math implemented from scratch using engine/matrix.js

const Matrix = require('./matrix');
const { VOCAB_SIZE } = require('./tokenizer');

// ── Hyper-parameters ──────────────────────────────────────────────────────────
const CONFIG = {
  vocabSize: VOCAB_SIZE,  // 256 byte tokens
  ctxLen:    128,         // context window
  dim:       64,          // embedding dimension
  numHeads:  2,           // attention heads (head_dim = 32)
  numLayers: 2,           // transformer blocks
  ffDim:     128,         // feed-forward hidden size
};

// ── Parameter group helper ────────────────────────────────────────────────────
function mkParam(rows, cols) {
  return { W: Matrix.randn(rows, cols), grad: Matrix.zeros(rows, cols) };
}
function mkBias(size) {
  return { W: Matrix.zeros(1, size), grad: Matrix.zeros(1, size) };
}
function mkNorm(size) {
  return {
    gamma: { W: Matrix.fill(1, size, 1), grad: Matrix.zeros(1, size) },
    beta:  { W: Matrix.zeros(1, size),  grad: Matrix.zeros(1, size) },
  };
}

// ── Model initialisation ──────────────────────────────────────────────────────
function createModel(cfg = CONFIG) {
  const { vocabSize, ctxLen, dim, numHeads, numLayers, ffDim } = cfg;
  const headDim = dim / numHeads;

  // Token & positional embeddings
  const embed = Matrix.randn(vocabSize, dim, 0.02);
  const posEmbed = Matrix.randn(ctxLen, dim, 0.01);

  // Transformer layers
  const layers = [];
  for (let l = 0; l < numLayers; l++) {
    layers.push({
      // Self-attention projections
      Wq: mkParam(dim, dim), bq: mkBias(dim),
      Wk: mkParam(dim, dim), bk: mkBias(dim),
      Wv: mkParam(dim, dim), bv: mkBias(dim),
      Wo: mkParam(dim, dim), bo: mkBias(dim),
      // Feed-forward
      W1: mkParam(dim, ffDim), b1: mkBias(ffDim),
      W2: mkParam(ffDim, dim),  b2: mkBias(dim),
      // Layer norms
      ln1: mkNorm(dim),
      ln2: mkNorm(dim),
    });
  }

  // Output head: dim → vocabSize (tied to input embedding for efficiency)
  const lmHead = mkParam(dim, vocabSize);

  return { cfg, embed, posEmbed, layers, lmHead, _embedGrad: null };
}

// ── Forward pass ─────────────────────────────────────────────────────────────
// Returns logits (T × vocabSize) and a cache of intermediates for backward.
function forward(model, tokens) {
  const { cfg, embed, posEmbed, layers, lmHead } = model;
  const T = tokens.length;
  const { dim, numHeads } = cfg;
  const headDim = dim / numHeads;
  const cache = { tokens, T, layerCaches: [] };

  // ── Embedding ──
  let X = new Matrix(T, dim);
  for (let i = 0; i < T; i++) {
    const tok = tokens[i], off = i * dim;
    for (let d = 0; d < dim; d++)
      X.data[off + d] = embed.data[tok * dim + d] + posEmbed.data[i * dim + d];
  }
  cache.X0 = X;

  // ── Transformer layers ──
  for (let l = 0; l < layers.length; l++) {
    const lyr = layers[l];
    const lc  = {};

    // — Attention —
    const Q = Matrix.matmul(X, lyr.Wq.W).addBias(lyr.bq.W);
    const K = Matrix.matmul(X, lyr.Wk.W).addBias(lyr.bk.W);
    const V = Matrix.matmul(X, lyr.Wv.W).addBias(lyr.bv.W);

    // Multi-head attention (split along head dimension)
    const ctxOut = Matrix.zeros(T, dim);
    const headAttn = [];
    const scale = 1 / Math.sqrt(headDim);

    for (let h = 0; h < numHeads; h++) {
      const hStart = h * headDim;
      // Extract head slice
      const Qh = new Matrix(T, headDim);
      const Kh = new Matrix(T, headDim);
      const Vh = new Matrix(T, headDim);
      for (let i = 0; i < T; i++)
        for (let d = 0; d < headDim; d++) {
          Qh.data[i * headDim + d] = Q.data[i * dim + hStart + d];
          Kh.data[i * headDim + d] = K.data[i * dim + hStart + d];
          Vh.data[i * headDim + d] = V.data[i * dim + hStart + d];
        }

      const scores = Matrix.matmul(Qh, Kh.T()).scale(scale).add(Matrix.causalMask(T));
      const attn   = Matrix.softmax(scores);
      const ctx_h  = Matrix.matmul(attn, Vh);

      // Write head output back into full dimension
      for (let i = 0; i < T; i++)
        for (let d = 0; d < headDim; d++)
          ctxOut.data[i * dim + hStart + d] = ctx_h.data[i * headDim + d];

      headAttn.push({ Qh, Kh, Vh, scores, attn, ctx_h });
    }

    const attnProj  = Matrix.matmul(ctxOut, lyr.Wo.W).addBias(lyr.bo.W);
    const res1      = X.add(attnProj);
    const ln1Result = Matrix.layerNorm(res1, lyr.ln1.gamma.W, lyr.ln1.beta.W);

    // — Feed-forward —
    const h1   = Matrix.matmul(ln1Result.Y, lyr.W1.W).addBias(lyr.b1.W).relu();
    const ff   = Matrix.matmul(h1, lyr.W2.W).addBias(lyr.b2.W);
    const res2 = ln1Result.Y.add(ff);
    const ln2Result = Matrix.layerNorm(res2, lyr.ln2.gamma.W, lyr.ln2.beta.W);

    // Save intermediates for backward
    lc.X = X; lc.Q = Q; lc.K = K; lc.V = V;
    lc.headAttn = headAttn; lc.ctxOut = ctxOut;
    lc.attnProj = attnProj; lc.res1 = res1;
    lc.ln1 = ln1Result; lc.h1 = h1;
    lc.ffPre = Matrix.matmul(ln1Result.Y, lyr.W1.W).addBias(lyr.b1.W); // pre-relu
    lc.ff = ff; lc.res2 = res2; lc.ln2 = ln2Result;

    cache.layerCaches.push(lc);
    X = ln2Result.Y;
  }

  cache.Xfinal = X;
  const logits = Matrix.matmul(X, lmHead.W);
  cache.logits = logits;
  return { logits, cache };
}

// ── Loss: cross-entropy on all positions ─────────────────────────────────────
function loss(logits, targets) {
  const T = targets.length;
  const V = logits.cols;
  let L = 0;
  const dLogits = Matrix.zeros(T, V);
  for (let i = 0; i < T; i++) {
    // Numerically stable softmax
    const off = i * V;
    let max = -Infinity;
    for (let j = 0; j < V; j++) if (logits.data[off + j] > max) max = logits.data[off + j];
    let sum = 0;
    const probs = new Float32Array(V);
    for (let j = 0; j < V; j++) { probs[j] = Math.exp(logits.data[off + j] - max); sum += probs[j]; }
    for (let j = 0; j < V; j++) probs[j] /= sum;
    L -= Math.log(Math.max(probs[targets[i]], 1e-10));
    // Gradient of CE + softmax: p - 1_target
    for (let j = 0; j < V; j++) dLogits.data[off + j] = probs[j] / T;
    dLogits.data[off + targets[i]] -= 1 / T;
  }
  return { loss: L / T, dLogits };
}

// ── Backward pass ─────────────────────────────────────────────────────────────
function backward(model, cache, dLogits) {
  const { cfg, embed, layers, lmHead } = model;
  const { T, tokens, layerCaches } = cache;
  const { dim, numHeads } = cfg;
  const headDim = dim / numHeads;
  const scale = 1 / Math.sqrt(headDim);

  // Gradient on lmHead
  lmHead.grad.addInPlace(Matrix.matmul(cache.Xfinal.T(), dLogits));
  let dX = Matrix.matmul(dLogits, lmHead.W.T());

  // Backward through transformer layers (reverse order)
  for (let l = layers.length - 1; l >= 0; l--) {
    const lyr = layers[l];
    const lc  = layerCaches[l];

    // — LN2 backward —
    const { dX: dLN2, dGamma: dgLN2, dBeta: dbLN2 } =
      Matrix.layerNormBackward(dX, lc.res2, lyr.ln2.gamma.W, lc.ln2.means, lc.ln2.rstds);
    lyr.ln2.gamma.grad.addInPlace(dgLN2);
    lyr.ln2.beta.grad.addInPlace(dbLN2);
    // Residual: dres2 = dLN2 (flows to both ln1.Y and ff paths)
    const dres2 = dLN2;

    // — FFN backward —
    lyr.b2.grad.addInPlace(dres2.sumRows());
    lyr.W2.grad.addInPlace(Matrix.matmul(lc.h1.T(), dres2));
    const dH1pre = Matrix.matmul(dres2, lyr.W2.W.T());
    const dH1    = Matrix.reluBackward(dH1pre, lc.ffPre);
    lyr.b1.grad.addInPlace(dH1.sumRows());
    lyr.W1.grad.addInPlace(Matrix.matmul(lc.ln1.Y.T(), dH1));
    const dAfterLN1 = Matrix.matmul(dH1, lyr.W1.W.T());

    // Total gradient into LN1 output (from residual + ff)
    const dLN1input = dAfterLN1.add(dres2);

    // — LN1 backward —
    const { dX: dLN1, dGamma: dgLN1, dBeta: dbLN1 } =
      Matrix.layerNormBackward(dLN1input, lc.res1, lyr.ln1.gamma.W, lc.ln1.means, lc.ln1.rstds);
    lyr.ln1.gamma.grad.addInPlace(dgLN1);
    lyr.ln1.beta.grad.addInPlace(dbLN1);
    const dres1 = dLN1;

    // — Attention output projection backward —
    lyr.bo.grad.addInPlace(dres1.sumRows());
    lyr.Wo.grad.addInPlace(Matrix.matmul(lc.ctxOut.T(), dres1));
    const dCtxOut = Matrix.matmul(dres1, lyr.Wo.W.T());

    // — Multi-head attention backward —
    const dQ = Matrix.zeros(T, dim);
    const dK = Matrix.zeros(T, dim);
    const dV = Matrix.zeros(T, dim);

    for (let h = 0; h < numHeads; h++) {
      const hStart = h * headDim;
      const { Qh, Kh, Vh, scores, attn } = lc.headAttn[h];

      // Extract head gradient slice
      const dCtxH = new Matrix(T, headDim);
      for (let i = 0; i < T; i++)
        for (let d = 0; d < headDim; d++)
          dCtxH.data[i * headDim + d] = dCtxOut.data[i * dim + hStart + d];

      const dAttn = Matrix.matmul(dCtxH, Vh.T());
      const dVh   = Matrix.matmul(attn.T(), dCtxH);
      const dScores = Matrix.softmaxBackward(dAttn, attn).scale(scale);
      const dQh  = Matrix.matmul(dScores, Kh);
      const dKh  = Matrix.matmul(dScores.T(), Qh);

      // Accumulate into full-dim gradients
      for (let i = 0; i < T; i++)
        for (let d = 0; d < headDim; d++) {
          dQ.data[i * dim + hStart + d] += dQh.data[i * headDim + d];
          dK.data[i * dim + hStart + d] += dKh.data[i * headDim + d];
          dV.data[i * dim + hStart + d] += dVh.data[i * headDim + d];
        }
    }

    // — Q, K, V projection backward —
    lyr.bq.grad.addInPlace(dQ.sumRows());
    lyr.bk.grad.addInPlace(dK.sumRows());
    lyr.bv.grad.addInPlace(dV.sumRows());
    lyr.Wq.grad.addInPlace(Matrix.matmul(lc.X.T(), dQ));
    lyr.Wk.grad.addInPlace(Matrix.matmul(lc.X.T(), dK));
    lyr.Wv.grad.addInPlace(Matrix.matmul(lc.X.T(), dV));

    const dXattn = Matrix.matmul(dQ, lyr.Wq.W.T())
      .add(Matrix.matmul(dK, lyr.Wk.W.T()))
      .add(Matrix.matmul(dV, lyr.Wv.W.T()));

    // Residual connection: gradient flows to X directly + through attention
    dX = dres1.add(dXattn);
  }

  // — Embedding backward —
  // dX is gradient w.r.t. the initial embeddings (T × dim)
  if (!model._embedGrad) model._embedGrad = Matrix.zeros(embed.rows, embed.cols);
  for (let i = 0; i < T; i++) {
    const tok = tokens[i], off = i * dim;
    for (let d = 0; d < dim; d++)
      model._embedGrad.data[tok * dim + d] += dX.data[off + d];
  }
}

// ── Collect all parameters for the optimizer ─────────────────────────────────
function allParams(model) {
  const params = [];
  for (const layer of model.layers) {
    for (const key of ['Wq','bq','Wk','bk','Wv','bv','Wo','bo','W1','b1','W2','b2'])
      params.push(layer[key]);
    params.push(layer.ln1.gamma, layer.ln1.beta);
    params.push(layer.ln2.gamma, layer.ln2.beta);
  }
  params.push(model.lmHead);
  return params;
}

// ── Zero gradients ────────────────────────────────────────────────────────────
function zeroGrads(model) {
  for (const p of allParams(model)) p.grad.data.fill(0);
  if (model._embedGrad) model._embedGrad.data.fill(0);
}

// ── Serialise / deserialise weights ──────────────────────────────────────────
function toJSON(model) {
  function serM(m) { return { rows: m.rows, cols: m.cols, data: Array.from(m.data) }; }
  return {
    cfg: model.cfg,
    embed: serM(model.embed),
    posEmbed: serM(model.posEmbed),
    lmHead: { W: serM(model.lmHead.W) },
    layers: model.layers.map(l => ({
      Wq:{W:serM(l.Wq.W)}, bq:{W:serM(l.bq.W)},
      Wk:{W:serM(l.Wk.W)}, bk:{W:serM(l.bk.W)},
      Wv:{W:serM(l.Wv.W)}, bv:{W:serM(l.bv.W)},
      Wo:{W:serM(l.Wo.W)}, bo:{W:serM(l.bo.W)},
      W1:{W:serM(l.W1.W)}, b1:{W:serM(l.b1.W)},
      W2:{W:serM(l.W2.W)}, b2:{W:serM(l.b2.W)},
      ln1:{gamma:{W:serM(l.ln1.gamma.W)},beta:{W:serM(l.ln1.beta.W)}},
      ln2:{gamma:{W:serM(l.ln2.gamma.W)},beta:{W:serM(l.ln2.beta.W)}},
    })),
  };
}

function fromJSON(json) {
  function desM(s) { return new Matrix(s.rows, s.cols, new Float32Array(s.data)); }
  function mkLoadParam(s) {
    return { W: desM(s.W), grad: Matrix.zeros(desM(s.W).rows, desM(s.W).cols) };
  }
  const model = createModel(json.cfg);
  model.embed    = desM(json.embed);
  model.posEmbed = desM(json.posEmbed);
  model.lmHead   = { W: desM(json.lmHead.W), grad: Matrix.zeros(json.cfg.dim, json.cfg.vocabSize) };
  model.layers   = json.layers.map(l => ({
    Wq: mkLoadParam(l.Wq), bq: mkLoadParam(l.bq),
    Wk: mkLoadParam(l.Wk), bk: mkLoadParam(l.bk),
    Wv: mkLoadParam(l.Wv), bv: mkLoadParam(l.bv),
    Wo: mkLoadParam(l.Wo), bo: mkLoadParam(l.bo),
    W1: mkLoadParam(l.W1), b1: mkLoadParam(l.b1),
    W2: mkLoadParam(l.W2), b2: mkLoadParam(l.b2),
    ln1: { gamma: mkLoadParam(l.ln1.gamma), beta: mkLoadParam(l.ln1.beta) },
    ln2: { gamma: mkLoadParam(l.ln2.gamma), beta: mkLoadParam(l.ln2.beta) },
  }));
  return model;
}

module.exports = { CONFIG, createModel, forward, loss, backward, allParams, zeroGrads, toJSON, fromJSON };
