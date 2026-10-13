// 2026-10-13 종합 고도화 리뷰에서 발견한 버그 회귀 테스트: server.js의 6개 Groq(AI
// 보조기능) 라우트가 내부 catch에서 "... : " + e.message를 그대로 res.json()에
// 실어 production에서도 Groq 업스트림 응답 본문·내부 예외 세부정보를 그대로 노출하고
// 있었다. _safeErrMsg(e, fallback)으로 통일한 뒤 — production에서는 지정한 안내 문구로
// 대체되고(내부 세부정보 비노출), 개발 환경에서는 여전히 원문을 보여줘(디버깅 편의
// 유지) 과잉수정이 아님을 함께 확인한다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

// 6개 라우트가 공유하는 Groq 호출 주소를 가로채는 로컬 mock — 항상 500 + 그 자체로는
// 절대 클라이언트에 노출되면 안 되는 "비밀 업스트림 세부정보" 문자열을 돌려준다.
const LEAK_CANARY = "upstream-secret-detail-should-never-reach-the-browser-xyz123";
function startGroqFailMock() {
  const srv = http.createServer((req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: LEAK_CANARY }));
  });
  return new Promise(resolve => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(r => srv.close(r)) });
    });
  });
}

// 6개 라우트 각각을 "성공시키는 데 필요한 최소 요청"으로 정의 — 전부 admin이 호출
// 가능하고(requireRole이 공통으로 admin을 허용), 입력 검증을 지나 실제로
// _groqFetch(GROQ_API_URL)까지 도달하는 최소 payload만 채운다.
const ROUTES = [
  { path: "/api/recruit/parse-resume-llm", body: { text: "이 문장은 20자가 넘는 더미 이력서 본문 텍스트입니다." } },
  { path: "/api/recruit/suggest-career-companies", body: { text: "이 문장은 20자가 넘는 더미 경력 텍스트입니다.", entries: ["삼성전자"] } },
  { path: "/api/hr/analyze-summary", body: { kind: "core", people: [{ id: 1, name: "홍길동" }] } },
  { path: "/api/hr/analyze-org", body: { kind: "stats", data: { total: 10 } } },
  { path: "/api/hr/draft-kpi-goal", body: { jobRole: "백엔드 개발자", itemName: "API 응답속도" } },
  { path: "/api/hr/draft-eval-comment", body: { stage: "first", memberName: "홍길동", kpis: [{ item: "매출", score: 90 }] } },
];

async function runAgainst(nodeEnv) {
  const groqMock = await startGroqFailMock();
  const server = await startServer({
    env: {
      NODE_ENV: nodeEnv,
      GROQ_API_KEY: "test-fake-groq-key-not-a-real-secret",
      GROQ_API_URL_OVERRIDE: groqMock.url,
    },
  });
  try {
    const { token } = await bootstrapAdminAndLogin(server, { loginId: "e2e_admin_groq", pw: "GroqTest12345" });
    const results = [];
    for (const r of ROUTES) {
      const res = await fetch(server.baseUrl + r.path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(r.body),
      });
      const json = await res.json();
      results.push({ path: r.path, json });
    }
    return results;
  } finally {
    await server.stop();
    await groqMock.close();
  }
}

test("Groq(AI) 라우트 6곳 — production에서는 내부 세부정보를 숨기고, 개발환경에서는 그대로 보여준다", async () => {
  const prodResults = await runAgainst("production");
  for (const { path, json } of prodResults) {
    assert.equal(json.ok, false, `${path}: GROQ_API_KEY는 가짜 값이라 업스트림이 실패해 ok:false여야 한다`);
    assert.ok(
      !JSON.stringify(json).includes(LEAK_CANARY),
      `${path}: production 응답에 내부 업스트림 세부정보(canary)가 그대로 노출됨 — ${JSON.stringify(json)}`
    );
    // 완전히 빈 메시지로 퇴보한 것도 아니어야 한다(과잉수정 방지) — _safeErrMsg의
    // fallback 문구(또는 httpError류의 사용자용 메시지)가 그대로 남아있어야 한다.
    assert.ok(typeof json.message === "string" && json.message.length > 0, `${path}: 메시지가 비어있음`);
  }

  const devResults = await runAgainst("development");
  for (const { path, json } of devResults) {
    assert.equal(json.ok, false, `${path}`);
    assert.ok(
      JSON.stringify(json).includes(LEAK_CANARY),
      `${path}: 개발 환경에서는 디버깅을 위해 원문이 그대로 보여야 하는데 사라짐(과잉수정) — ${JSON.stringify(json)}`
    );
  }
});

// 정적 검사 — 이 6개 라우트의 try/catch 블록이 다시 "... + e.message" 직접 결합 패턴으로
// 되돌아가는 회귀를 소스 레벨에서도 잡는다(런타임 테스트가 놓칠 수 있는 리팩터링 실수 대비).
test("server.js에 \"... : \" + e.message 직접 결합 패턴이 더 이상 없다", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const leakPattern = /["'].*?["']\s*\+\s*e\.message/g;
  const matches = src.match(leakPattern) || [];
  // _groqFetch 내부(10883행 부근)의 "AI 호출 실패: " + e.message, "AI API 오류 " + resp.status
  // 류는 이 헬퍼가 던지는 Error 자체의 생성자 안이라 라우트가 그대로 클라이언트에 노출하는
  // 게 아님(그 Error를 받는 라우트 쪽 catch가 _safeErrMsg를 거친다) — 그대로 유지되는 게
  // 맞으므로 화이트리스트로 허용한다. 그 외에 남아있으면 회귀로 간주해 실패시킨다.
  const allowed = matches.filter(m => m.includes("AI 호출 실패"));
  const unexpected = matches.filter(m => !m.includes("AI 호출 실패"));
  assert.equal(
    unexpected.length, 0,
    `예상치 못한 "...+e.message" 직접노출 패턴이 server.js에 남아있음: ${JSON.stringify(unexpected)}`
  );
});
