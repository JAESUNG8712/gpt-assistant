// AI self-learning: conversation memory, URL ingestion, simulation optimization
const ollama = require('./ollama');
const knowledge = require('./knowledge');
const { fetchPageContent } = require('./search');

// ── 1. Conversation memory ────────────────────────────────────────────────────
async function learnFromConversation(userMsg, aiMsg) {
  const content = `[질문]\n${userMsg}\n\n[답변]\n${aiMsg}`;
  const count = await knowledge.add({
    content,
    source: 'conversation',
    sourceDetail: new Date().toISOString(),
    score: 1.0,
    metadata: { userMsg: userMsg.slice(0, 100) },
  });
  return count;
}

// ── 2. URL / webpage learning ─────────────────────────────────────────────────
async function learnFromUrl(url) {
  const raw = await fetchPageContent(url);
  if (!raw || raw.length < 100) throw new Error('페이지 내용을 가져올 수 없습니다');

  // Summarize long content to extract key points
  let content = raw;
  if (raw.length > 3000) {
    content = await ollama.chat([
      { role: 'system', content: '다음 웹페이지 내용의 핵심 정보를 한국어로 요약하세요. 중요한 사실, 데이터, 개념을 모두 포함하세요.' },
      { role: 'user', content: raw.slice(0, 6000) },
    ]);
  }

  const count = await knowledge.add({
    content,
    source: 'url',
    sourceDetail: url,
    score: 1.0,
    metadata: { originalLength: raw.length },
  });

  return { chunks: count, preview: content.slice(0, 200) };
}

// ── 3. Simulation-based optimization ─────────────────────────────────────────
async function simulateAndLearn(instruction, { iterations = 3, model } = {}) {
  const results = [];

  // Generate N candidate responses
  for (let i = 0; i < iterations; i++) {
    const systemPrompt = `당신은 최고의 AI 어시스턴트입니다. 다음 지시사항에 대해 가장 완벽하고 유용한 답변을 생성하세요.
시도 ${i + 1}/${iterations}: 이전 시도와 다른 각도나 방식으로 접근하세요.`;

    const response = await ollama.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: instruction },
    ], { model });

    results.push({ response, index: i + 1 });
  }

  // Self-evaluate: AI judges which response is best
  const evalPrompt = `다음은 같은 지시사항에 대한 ${iterations}개의 AI 답변입니다.
각 답변을 평가하고 가장 우수한 답변을 선택하세요.

[지시사항]
${instruction}

${results.map((r, i) => `[답변 ${i + 1}]\n${r.response}`).join('\n\n')}

다음 형식으로 응답하세요 (JSON만, 다른 텍스트 없이):
{"best": 1, "score": 9.2, "reason": "이유"}
best는 1~${iterations} 중 하나, score는 0~10`;

  let bestIndex = 0;
  let bestScore = 1.0;
  let evalReason = '';

  try {
    const evalResult = await ollama.chat([
      { role: 'system', content: '당신은 AI 응답 품질 평가 전문가입니다. JSON만 출력하세요.' },
      { role: 'user', content: evalPrompt },
    ], { model });

    const jsonMatch = evalResult.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      bestIndex = Math.max(0, Math.min(iterations - 1, (parsed.best || 1) - 1));
      bestScore = Math.min(1.0, (parsed.score || 7) / 10);
      evalReason = parsed.reason || '';
    }
  } catch {}

  const best = results[bestIndex];

  // Store optimized response in knowledge base
  const content = `[학습된 최적 답변]\n지시: ${instruction}\n\n최적 답변 (${iterations}회 시뮬레이션, 점수: ${(bestScore * 10).toFixed(1)}/10):\n${best.response}`;

  await knowledge.add({
    content,
    source: 'simulation',
    sourceDetail: instruction.slice(0, 100),
    score: bestScore,
    metadata: {
      instruction: instruction.slice(0, 200),
      iterations,
      evalReason,
      allResponses: results.map(r => r.response.slice(0, 100)),
    },
  });

  return {
    bestResponse: best.response,
    bestIndex: bestIndex + 1,
    score: bestScore,
    reason: evalReason,
    allResults: results,
  };
}

// ── 4. Manual knowledge input ─────────────────────────────────────────────────
async function learnManual(content, label = '') {
  const count = await knowledge.add({
    content,
    source: 'manual',
    sourceDetail: label || '직접 입력',
    score: 1.0,
  });
  return count;
}

module.exports = { learnFromConversation, learnFromUrl, simulateAndLearn, learnManual };
