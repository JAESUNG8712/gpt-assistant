// Adam optimizer — implemented from scratch
// Reference: "Adam: A Method for Stochastic Optimization" (Kingma & Ba, 2014)

class Adam {
  constructor({ lr = 3e-4, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, weightDecay = 0.01 } = {}) {
    this.lr = lr;
    this.beta1 = beta1;
    this.beta2 = beta2;
    this.eps = eps;
    this.weightDecay = weightDecay;
    this.t = 0;           // step counter
    this._state = new Map(); // per-parameter momentum/variance
  }

  step(params, embedParam = null, embedGrad = null) {
    this.t++;
    const { lr, beta1, beta2, eps, weightDecay, t } = this;
    const bc1 = 1 - beta1 ** t;
    const bc2 = 1 - beta2 ** t;

    const update = (W, grad) => {
      const n = W.data.length;
      if (!this._state.has(W)) {
        this._state.set(W, {
          m: new Float32Array(n),  // first moment
          v: new Float32Array(n),  // second moment
        });
      }
      const { m, v } = this._state.get(W);
      for (let i = 0; i < n; i++) {
        const g = grad.data[i] + weightDecay * W.data[i];
        m[i] = beta1 * m[i] + (1 - beta1) * g;
        v[i] = beta2 * v[i] + (1 - beta2) * g * g;
        W.data[i] -= lr * (m[i] / bc1) / (Math.sqrt(v[i] / bc2) + eps);
      }
    };

    for (const p of params) update(p.W, p.grad);

    // Sparse embedding update (only touched rows)
    if (embedParam && embedGrad) {
      const W = embedParam, grad = embedGrad;
      const cols = W.cols;
      if (!this._state.has(W)) {
        this._state.set(W, { m: new Float32Array(W.data.length), v: new Float32Array(W.data.length) });
      }
      const { m, v } = this._state.get(W);
      for (let i = 0; i < W.rows; i++) {
        let hasGrad = false;
        const off = i * cols;
        for (let d = 0; d < cols; d++) if (grad.data[off + d] !== 0) { hasGrad = true; break; }
        if (!hasGrad) continue;
        for (let d = 0; d < cols; d++) {
          const g = grad.data[off + d] + weightDecay * W.data[off + d];
          m[off + d] = beta1 * m[off + d] + (1 - beta1) * g;
          v[off + d] = beta2 * v[off + d] + (1 - beta2) * g * g;
          W.data[off + d] -= lr * (m[off + d] / bc1) / (Math.sqrt(v[off + d] / bc2) + eps);
        }
      }
    }
  }

  // Gradient clipping (prevents exploding gradients)
  static clipGrads(params, embedGrad, maxNorm = 1.0) {
    let norm2 = 0;
    for (const p of params) for (const g of p.grad.data) norm2 += g * g;
    if (embedGrad) for (const g of embedGrad.data) norm2 += g * g;
    const norm = Math.sqrt(norm2);
    if (norm > maxNorm) {
      const scale = maxNorm / norm;
      for (const p of params) for (let i = 0; i < p.grad.data.length; i++) p.grad.data[i] *= scale;
      if (embedGrad) for (let i = 0; i < embedGrad.data.length; i++) embedGrad.data[i] *= scale;
    }
    return norm;
  }
}

module.exports = Adam;
