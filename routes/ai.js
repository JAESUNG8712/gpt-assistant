const express = require('express');
const os = require('os');
const router = express.Router();
const ollama = require('../services/ollama');
const { search } = require('../services/search');
const knowledge = require('../services/knowledge');
const learner = require('../services/learner');

function getLocalIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

const SYSTEM_PROMPT = `당신은 자가 학습하는 개인 AI 어시스턴트입니다. 한국어로 대화하세요.

응답 우선순위:
1. 학습된 지식(과거 대화, 문서, 최적화된 답변)이 있으면 최우선 활용
2. 웹 검색 결과가 있으면 최신 정보로 보완
3. 학습 내용이나 검색 결과가 없으면 내재 지식으로 답변

학습된 지식을 활용했다면 "[학습된 내용 기반]" 을 답변 앞에 표시하세요.`;

// 컨텍스트 예산 배분 (전체 num_ctx의 비율)
const CTX_BUDGET = {
  system: 0.20,      // 시스템 프롬프트: 20%
  knowledge: 0.25,   // 지식DB: 25%
  search: 0.20,      // 웹 검색: 20%
  history: 0.25,     // 대화 기록: 25%
  response: 0.10,    // 답변 여유: 10%
};

// 글자 수로 토큰 추정 후 예산 내로 자르기
function budgetTrim(text, maxTokens) {
  const maxChars = maxTokens * 2; // 보수적으로 1토큰=2자
  return text.length > maxChars ? text.slice(0, maxChars) + '\n...(내용 생략)' : text;
}

// 오래된 대화를 요약으로 압축 (최근 N쌍만 유지)
async function trimHistory(messages, maxTokens, model) {
  const KEEP_RECENT = 6; // 최근 6개 메시지(3쌍)는 항상 유지

  if (messages.length <= KEEP_RECENT) return messages;

  const old = messages.slice(0, -KEEP_RECENT);
  const recent = messages.slice(-KEEP_RECENT);

  // 오래된 대화를 요약
  const oldText = old.map(m => `${m.role === 'user' ? '사용자' : 'AI'}: ${m.content}`).join('\n');
  try {
    const summary = await ollama.chat([
      { role: 'system', content: '다음 대화를 3문장 이내로 핵심만 요약하세요. 중요한 결정사항, 합의된 내용, 사용자 정보를 포함하세요.' },
      { role: 'user', content: oldText },
    ], { model });
    return [
      { role: 'system', content: `[이전 대화 요약]\n${summary}` },
      ...recent,
    ];
  } catch {
    // 요약 실패 시 최근만 유지
    return recent;
  }
}

// GET /ai/status
router.get('/status', async (req, res) => {
  const available = await ollama.isAvailable();
  const models = available ? await ollama.listModels() : [];
  const kbStats = knowledge.stats();
  const port = process.env.PORT || 3000;
  const localIPs = getLocalIPs();
  res.json({
    available,
    models,
    defaultModel: ollama.DEFAULT_MODEL,
    embedModel: knowledge.EMBED_MODEL,
    knowledge: kbStats,
    network: {
      port,
      ips: localIPs,
      urls: localIPs.map(ip => `http://${ip}:${port}/ai-chat.html`),
    },
  });
});

// POST /ai/chat  (SSE streaming with RAG)
router.post('/chat', async (req, res) => {
  const { messages, useSearch = false, useKnowledge = true, model, autoLearn = true } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 배열이 필요합니다' });
  }

  try {
    const userQuery = messages[messages.length - 1]?.content || '';
    let systemContent = SYSTEM_PROMPT;
    let sources = [];
    let knowledgeSources = [];

    // 컨텍스트 예산 계산 (토큰 기준)
    const totalBudget = ollama.NUM_CTX;
    const kbBudget    = Math.floor(totalBudget * CTX_BUDGET.knowledge);
    const searchBudget = Math.floor(totalBudget * CTX_BUDGET.search);
    const historyBudget = Math.floor(totalBudget * CTX_BUDGET.history);

    // ── RAG: search local knowledge base (예산 제한 적용) ──
    if (useKnowledge) {
      try {
        const kbResults = await knowledge.search(userQuery, { topK: 4, minScore: 0.35 });
        if (kbResults.length > 0) {
          knowledgeSources = kbResults.map(r => ({
            source: r.source,
            detail: r.sourceDetail,
            sim: r.sim.toFixed(2),
          }));
          let kbSection = '\n\n=== 학습된 지식 (유사도 순) ===';
          for (let i = 0; i < kbResults.length; i++) {
            const r = kbResults[i];
            kbSection += `\n\n[지식 ${i + 1}] (출처: ${r.source} | 유사도: ${(r.sim * 100).toFixed(0)}%)\n${r.content}`;
          }
          systemContent += budgetTrim(kbSection, kbBudget);
        }
      } catch {}
    }

    // ── Web search (예산 제한 적용) ──
    if (useSearch) {
      try {
        const results = await search(userQuery, { fetchContent: true });
        sources = results.map(r => ({ title: r.title, url: r.url }));
        if (results.length > 0) {
          let searchSection = '\n\n=== 웹 검색 결과 ===';
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            searchSection += `\n\n[${i + 1}] ${r.title}\n${r.snippet}`;
            if (r.content) searchSection += `\n${r.content.slice(0, 600)}`;
            searchSection += `\n출처: ${r.url}`;
          }
          systemContent += budgetTrim(searchSection, searchBudget);
        }
      } catch {}
    }

    // ── 대화 기록 압축 (히스토리가 길면 요약) ──
    const trimmedMessages = await trimHistory(messages, historyBudget, model);

    const fullMessages = [{ role: 'system', content: systemContent }, ...trimmedMessages];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (knowledgeSources.length > 0) {
      res.write(`event: knowledge\ndata: ${JSON.stringify(knowledgeSources)}\n\n`);
    }
    if (sources.length > 0) {
      res.write(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`);
    }

    // Stream from Ollama
    const ollamaRes = await ollama.chat(fullMessages, { stream: true, model });
    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullAiResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.message?.content) {
            fullAiResponse += data.message.content;
            res.write(`event: token\ndata: ${JSON.stringify({ token: data.message.content })}\n\n`);
          }
          if (data.done) {
            res.write(`event: done\ndata: {}\n\n`);
          }
        } catch {}
      }
    }

    res.end();

    // Auto-learn from this conversation (async, after response)
    if (autoLearn && fullAiResponse && userQuery.length > 5) {
      learner.learnFromConversation(userQuery, fullAiResponse).catch(() => {});
    }

  } catch (err) {
    const payload = { error: err.message };
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    } else {
      res.status(500).json(payload);
    }
  }
});

// POST /ai/search  (web search only)
router.post('/search', async (req, res) => {
  const { query, fetchContent = false } = req.body;
  if (!query) return res.status(400).json({ error: 'query가 필요합니다' });
  try {
    const results = await search(query, { fetchContent });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /ai/learn/url  — learn from a URL
router.post('/learn/url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url이 필요합니다' });
  try {
    const result = await learner.learnFromUrl(url);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /ai/learn/manual  — manually add knowledge
router.post('/learn/manual', async (req, res) => {
  const { content, label } = req.body;
  if (!content) return res.status(400).json({ error: 'content가 필요합니다' });
  try {
    const chunks = await learner.learnManual(content, label);
    res.json({ ok: true, chunks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /ai/learn/simulate  — simulation-based optimization
router.post('/learn/simulate', async (req, res) => {
  const { instruction, iterations = 3, model } = req.body;
  if (!instruction) return res.status(400).json({ error: 'instruction이 필요합니다' });

  // SSE for progress updates
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    res.write(`event: progress\ndata: ${JSON.stringify({ step: 'start', total: iterations })}\n\n`);

    // Override learner to send progress events
    const results = [];
    for (let i = 0; i < iterations; i++) {
      res.write(`event: progress\ndata: ${JSON.stringify({ step: 'generate', current: i + 1, total: iterations })}\n\n`);

      const systemPrompt = `당신은 최고의 AI 어시스턴트입니다. 다음 지시사항에 대해 가장 완벽하고 유용한 답변을 생성하세요.
시도 ${i + 1}/${iterations}: ${i === 0 ? '기본 접근법으로' : i === 1 ? '더 구체적인 예시를 포함하여' : '다른 관점에서 창의적으로'} 답변하세요.`;

      const response = await ollama.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: instruction },
      ], { model });

      results.push({ response, index: i + 1 });
    }

    res.write(`event: progress\ndata: ${JSON.stringify({ step: 'evaluate' })}\n\n`);

    // Self-evaluation
    const evalPrompt = `다음 ${iterations}개의 답변을 평가하고 최선을 선택하세요.

[지시사항]: ${instruction}

${results.map((r, i) => `[답변 ${i + 1}]\n${r.response}`).join('\n\n')}

JSON만 출력: {"best": 1, "score": 8.5, "reason": "선택 이유"}`;

    let bestIndex = 0, bestScore = 1.0, evalReason = '';
    try {
      const evalResult = await ollama.chat([
        { role: 'system', content: '품질 평가자. JSON만 출력.' },
        { role: 'user', content: evalPrompt },
      ], { model });
      const m = evalResult.match(/\{[^}]+\}/);
      if (m) {
        const p = JSON.parse(m[0]);
        bestIndex = Math.max(0, Math.min(iterations - 1, (p.best || 1) - 1));
        bestScore = Math.min(1.0, (p.score || 7) / 10);
        evalReason = p.reason || '';
      }
    } catch {}

    res.write(`event: progress\ndata: ${JSON.stringify({ step: 'save' })}\n\n`);

    const best = results[bestIndex];
    const content = `[시뮬레이션 최적 답변]\n지시: ${instruction}\n\n최적 답변 (${iterations}회 시뮬레이션, 점수: ${(bestScore * 10).toFixed(1)}/10):\n${best.response}`;
    await knowledge.add({
      content,
      source: 'simulation',
      sourceDetail: instruction.slice(0, 100),
      score: bestScore,
      metadata: { instruction: instruction.slice(0, 200), iterations, evalReason },
    });

    res.write(`event: done\ndata: ${JSON.stringify({
      bestResponse: best.response,
      bestIndex: bestIndex + 1,
      score: bestScore,
      reason: evalReason,
      iterations,
    })}\n\n`);
    res.end();

  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// GET /ai/knowledge  — list knowledge stats
router.get('/knowledge', (req, res) => {
  res.json(knowledge.stats());
});

// DELETE /ai/knowledge  — clear knowledge by source
router.delete('/knowledge', (req, res) => {
  const { source } = req.query;
  knowledge.clear(source || undefined);
  res.json({ ok: true });
});

module.exports = router;
