// Byte-level tokenizer: every byte 0-255 is a token.
// Works natively with Korean (UTF-8 multibyte) and any language.

const VOCAB_SIZE = 256;
const EOS = 0;  // treat null byte as end-of-sequence

class Tokenizer {
  get vocabSize() { return VOCAB_SIZE; }

  encode(text) {
    return Array.from(Buffer.from(text, 'utf8'));
  }

  decode(tokens) {
    // Filter out EOS tokens and invalid bytes at sequence boundaries
    const clean = tokens.filter(t => t >= 1 && t <= 255);
    try {
      return Buffer.from(clean).toString('utf8');
    } catch {
      return Buffer.from(clean).toString('latin1');
    }
  }

  // Prepare (input, target) pairs from a text string
  // Each position: input=tokens[i..i+ctxLen-1], target=tokens[i+1..i+ctxLen]
  makePairs(text, ctxLen) {
    const tokens = this.encode(text);
    const pairs = [];
    for (let i = 0; i + ctxLen < tokens.length; i++) {
      pairs.push({
        input:  tokens.slice(i, i + ctxLen),
        target: tokens.slice(i + 1, i + ctxLen + 1),
      });
    }
    return pairs;
  }
}

module.exports = new Tokenizer();
module.exports.VOCAB_SIZE = VOCAB_SIZE;
