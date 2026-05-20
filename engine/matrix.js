// Pure JavaScript matrix operations using Float32Array
// No external dependencies — all math from scratch

class Matrix {
  constructor(rows, cols, data = null) {
    this.rows = rows;
    this.cols = cols;
    this.data = data instanceof Float32Array
      ? data
      : new Float32Array(rows * cols);
  }

  get(i, j)      { return this.data[i * this.cols + j]; }
  set(i, j, v)   { this.data[i * this.cols + j] = v; }
  clone()        { return new Matrix(this.rows, this.cols, this.data.slice()); }

  // ── Factories ──────────────────────────────────────────────────────────────
  static zeros(rows, cols) { return new Matrix(rows, cols); }

  static fill(rows, cols, v) {
    const m = new Matrix(rows, cols);
    m.data.fill(v);
    return m;
  }

  // Xavier / He initialisation (prevents vanishing/exploding gradients)
  static randn(rows, cols, std) {
    const s = std ?? Math.sqrt(2 / (rows + cols));
    const m = new Matrix(rows, cols);
    for (let i = 0; i < m.data.length; i += 2) {
      const u1 = Math.random() || 1e-10;
      const u2 = Math.random();
      const n  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      m.data[i]   = n * s;
      if (i + 1 < m.data.length)
        m.data[i + 1] = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2) * s;
    }
    return m;
  }

  // ── Element-wise ops ───────────────────────────────────────────────────────
  add(B) {
    const C = new Matrix(this.rows, this.cols);
    for (let i = 0; i < this.data.length; i++) C.data[i] = this.data[i] + B.data[i];
    return C;
  }
  sub(B) {
    const C = new Matrix(this.rows, this.cols);
    for (let i = 0; i < this.data.length; i++) C.data[i] = this.data[i] - B.data[i];
    return C;
  }
  mul(B) {
    const C = new Matrix(this.rows, this.cols);
    for (let i = 0; i < this.data.length; i++) C.data[i] = this.data[i] * B.data[i];
    return C;
  }
  scale(s) {
    const C = new Matrix(this.rows, this.cols);
    for (let i = 0; i < this.data.length; i++) C.data[i] = this.data[i] * s;
    return C;
  }
  addScalar(s) {
    const C = this.clone();
    for (let i = 0; i < C.data.length; i++) C.data[i] += s;
    return C;
  }
  addInPlace(B) {
    for (let i = 0; i < this.data.length; i++) this.data[i] += B.data[i];
    return this;
  }

  // ── Matrix multiply: C = A @ B (cache-friendly i-k-j order) ──────────────
  static matmul(A, B) {
    const C = new Matrix(A.rows, B.cols);
    const Adata = A.data, Bdata = B.data, Cdata = C.data;
    const Brows = B.rows, Bcols = B.cols, Acols = A.cols;
    for (let i = 0; i < A.rows; i++) {
      const iA = i * Acols, iC = i * Bcols;
      for (let k = 0; k < Acols; k++) {
        const aik = Adata[iA + k], kB = k * Bcols;
        for (let j = 0; j < Bcols; j++) Cdata[iC + j] += aik * Bdata[kB + j];
      }
    }
    return C;
  }

  // ── Transpose ─────────────────────────────────────────────────────────────
  T() {
    const B = new Matrix(this.cols, this.rows);
    const Adata = this.data, Bdata = B.data;
    for (let i = 0; i < this.rows; i++)
      for (let j = 0; j < this.cols; j++)
        Bdata[j * this.rows + i] = Adata[i * this.cols + j];
    return B;
  }

  // ── Add bias vector to every row ──────────────────────────────────────────
  addBias(bias) {
    const C = this.clone();
    for (let i = 0; i < C.rows; i++)
      for (let j = 0; j < C.cols; j++)
        C.data[i * C.cols + j] += bias.data[j];
    return C;
  }

  // ── Row-wise softmax (numerically stable) ─────────────────────────────────
  static softmax(X) {
    const R = new Matrix(X.rows, X.cols);
    for (let i = 0; i < X.rows; i++) {
      const off = i * X.cols;
      let max = -Infinity;
      for (let j = 0; j < X.cols; j++) if (X.data[off + j] > max) max = X.data[off + j];
      let sum = 0;
      for (let j = 0; j < X.cols; j++) { R.data[off + j] = Math.exp(X.data[off + j] - max); sum += R.data[off + j]; }
      for (let j = 0; j < X.cols; j++) R.data[off + j] /= sum;
    }
    return R;
  }

  // Softmax backward: given dout and the softmax output p → dz
  static softmaxBackward(dout, p) {
    const dz = new Matrix(p.rows, p.cols);
    for (let i = 0; i < p.rows; i++) {
      const off = i * p.cols;
      let dot = 0;
      for (let j = 0; j < p.cols; j++) dot += p.data[off + j] * dout.data[off + j];
      for (let j = 0; j < p.cols; j++)
        dz.data[off + j] = p.data[off + j] * (dout.data[off + j] - dot);
    }
    return dz;
  }

  // ── ReLU ──────────────────────────────────────────────────────────────────
  relu() {
    const C = new Matrix(this.rows, this.cols);
    for (let i = 0; i < this.data.length; i++) C.data[i] = this.data[i] > 0 ? this.data[i] : 0;
    return C;
  }
  static reluBackward(dout, x) {
    const dx = new Matrix(x.rows, x.cols);
    for (let i = 0; i < x.data.length; i++) dx.data[i] = x.data[i] > 0 ? dout.data[i] : 0;
    return dx;
  }

  // ── Layer Normalization (per row) ─────────────────────────────────────────
  static layerNorm(X, gamma, beta, eps = 1e-5) {
    const Y = new Matrix(X.rows, X.cols);
    const means = new Float32Array(X.rows);
    const rstds = new Float32Array(X.rows);
    for (let i = 0; i < X.rows; i++) {
      const off = i * X.cols;
      let mean = 0;
      for (let j = 0; j < X.cols; j++) mean += X.data[off + j];
      mean /= X.cols;
      let var_ = 0;
      for (let j = 0; j < X.cols; j++) var_ += (X.data[off + j] - mean) ** 2;
      var_ /= X.cols;
      const rstd = 1 / Math.sqrt(var_ + eps);
      means[i] = mean; rstds[i] = rstd;
      for (let j = 0; j < X.cols; j++)
        Y.data[off + j] = (X.data[off + j] - mean) * rstd * gamma.data[j] + beta.data[j];
    }
    return { Y, means, rstds };
  }

  static layerNormBackward(dout, X, gamma, means, rstds) {
    const T = X.rows, d = X.cols;
    const dX = new Matrix(T, d);
    const dGamma = new Float32Array(d);
    const dBeta  = new Float32Array(d);
    for (let i = 0; i < T; i++) {
      const off = i * d, mean = means[i], rstd = rstds[i];
      // xhat = (x - mean) * rstd
      let dot_xhat_dout = 0, sum_dout = 0;
      for (let j = 0; j < d; j++) {
        const xhat = (X.data[off + j] - mean) * rstd;
        dot_xhat_dout += xhat * dout.data[off + j] * gamma.data[j];
        sum_dout       += dout.data[off + j] * gamma.data[j];
        dGamma[j]      += xhat * dout.data[off + j];
        dBeta[j]       += dout.data[off + j];
      }
      for (let j = 0; j < d; j++) {
        const xhat = (X.data[off + j] - mean) * rstd;
        dX.data[off + j] = rstd * (dout.data[off + j] * gamma.data[j]
          - (sum_dout + xhat * dot_xhat_dout) / d);
      }
    }
    return { dX, dGamma: new Matrix(1, d, dGamma), dBeta: new Matrix(1, d, dBeta) };
  }

  // ── Sum across rows → 1 × cols vector ────────────────────────────────────
  sumRows() {
    const out = new Matrix(1, this.cols);
    for (let i = 0; i < this.rows; i++)
      for (let j = 0; j < this.cols; j++) out.data[j] += this.data[i * this.cols + j];
    return out;
  }

  // ── Row of matrix as 1 × cols ─────────────────────────────────────────────
  row(i) { return new Matrix(1, this.cols, this.data.slice(i * this.cols, (i + 1) * this.cols)); }

  // ── Causal (lower-triangular) mask: set upper triangle to -1e9 ────────────
  static causalMask(T) {
    const M = new Matrix(T, T);
    for (let i = 0; i < T; i++)
      for (let j = i + 1; j < T; j++) M.data[i * T + j] = -1e9;
    return M;
  }
}

module.exports = Matrix;
