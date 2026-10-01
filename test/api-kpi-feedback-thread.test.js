// Epic A 마지막 항목 — "평가 중 수시 피드백 교환"(kpiEntries[].feedbackThread). 목표
// 등록~결과 확정 사이 언제든 본인과 평가자(같은 dept+team의 leader, 같은 dept의
// director, admin)가 공식 점수와 무관하게 자유롭게 메시지를 주고받을 수 있어야 하고,
// 서버(_sanitizeKpiEntry)는 "자기 명의로 끝에 추가만"(append-only)을 강제해야 한다 —
// 과거 메시지 수정·삭제·타인 명의 도용·무관한 제3자의 끼어들기는 전부 차단되어야 한다.
//
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용 — 실제 DB나
// 운영 데이터 파일은 이 테스트가 존재하는지조차 모른다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

async function login(api, loginId, pw) {
  const r = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  })).json();
  assert.equal(r.ok, true, `${loginId} 로그인 실패: ${JSON.stringify(r)}`);
  return r.token;
}

function auth(token, method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

async function getData(api, token) {
  const r = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(r.ok, true);
  return r;
}

test("KPI 피드백 스레드(feedbackThread) — 본인·평가자만 자기 명의로 append만 가능", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "leaderA", loginId: "leaderA", pw: "leaderA-pw-1", name: "팀장A", role: "leader", active: true, dept: "개발본부", team: "A팀", menuPerms: {} },
    { id: "dir1", loginId: "dir1", pw: "dir1-pw-1", name: "사업부장1", role: "director", active: true, dept: "개발본부", menuPerms: {} },
    // dir2: 개발본부와 무관한 다른 부서(영업본부) — "타 부서라 차단" 대조군.
    { id: "dir2", loginId: "dir2", pw: "dir2-pw-1", name: "사업부장2(무관부서)", role: "director", active: true, dept: "영업본부", menuPerms: {} },
    { id: "memberA", loginId: "memberA", pw: "memberA-pw-1", name: "팀원A", role: "member", active: true, dept: "개발본부", team: "A팀", menuPerms: {} },
    // memberC: memberA와 전혀 무관한(다른 팀) 사원 — "제3자 끼어들기" 차단 대조군.
    { id: "memberC", loginId: "memberC", pw: "memberC-pw-1", name: "팀원C(무관)", role: "member", active: true, dept: "개발본부", team: "C팀", menuPerms: {} },
  ];
  const kpiEntries = [
    { id: "kpiA", userId: "memberA", year: 2026, item: "목표A", weight: 30, firstStatus: "pending", finalStatus: "pending" },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees, kpiEntries }));
  assert.equal(seed.status, 200);

  const leaderAToken = await login(api, "leaderA", "leaderA-pw-1");
  const dir1Token = await login(api, "dir1", "dir1-pw-1");
  const dir2Token = await login(api, "dir2", "dir2-pw-1");
  const memberAToken = await login(api, "memberA", "memberA-pw-1");
  const memberCToken = await login(api, "memberC", "memberC-pw-1");

  async function kpiOf() {
    const d = await getData(api, adminToken);
    return d.data.kpiEntries.find(k => k.id === "kpiA");
  }
  // 레코드 내용은 항상 admin(전체 가시성) 기준으로 가져오고, _version만 실제 행위자의
  // 토큰으로 조회한다 — member 역할은 GET /data가 본인 소유 kpiEntries만 돌려주므로
  // (filterDataForRole, 정상적인 최소권한 동작), 소유자가 아닌 memberC가 "자기 GET
  // 결과에서 레코드를 찾아 수정"하는 방식으로는 애초에 그 레코드에 접근조차 못 한다 —
  // 이 테스트는 "내용을 이미 알고 있는 공격자가 /save에 직접 그 내용을 실어 보내면
  // 서버가 차단하는가"를 검증하려는 것이므로, 내용은 admin 경로로 획득해 구성한다.
  async function appendFeedback(token, empId, message) {
    const base = await kpiOf();
    const d = await getData(api, token);
    const thread = [...(base.feedbackThread || []), { id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, empId, authorName: empId, role: "member", message, createdAt: new Date().toISOString() }];
    const kpiEntries = [{ ...base, feedbackThread: thread }];
    return api("/save", auth(token, "POST", { _version: d.version, kpiEntries }));
  }

  await t.test("본인(소유자)은 자기 명의로 첫 메시지를 추가할 수 있다", async () => {
    const r = await appendFeedback(memberAToken, "memberA", "실적 집계 중 궁금한 점이 있습니다.");
    assert.equal(r.status, 200);
    const kpi = await kpiOf();
    assert.equal(kpi.feedbackThread.length, 1);
    assert.equal(kpi.feedbackThread[0].empId, "memberA");
  });

  await t.test("같은 dept+team의 팀장(평가자)은 이어서 자기 명의로 메시지를 추가할 수 있다", async () => {
    const r = await appendFeedback(leaderAToken, "leaderA", "확인했습니다, 다음 주까지 반영해주세요.");
    assert.equal(r.status, 200);
    const kpi = await kpiOf();
    assert.equal(kpi.feedbackThread.length, 2);
    assert.equal(kpi.feedbackThread[1].empId, "leaderA");
    // 이전 메시지(memberA)는 그대로 보존되어야 한다.
    assert.equal(kpi.feedbackThread[0].message, "실적 집계 중 궁금한 점이 있습니다.");
  });

  await t.test("같은 dept의 사업부장(평가자)도 자기 명의로 메시지를 추가할 수 있다", async () => {
    const r = await appendFeedback(dir1Token, "dir1", "좋습니다, 승인하겠습니다.");
    assert.equal(r.status, 200);
    const kpi = await kpiOf();
    assert.equal(kpi.feedbackThread.length, 3);
    assert.equal(kpi.feedbackThread[2].empId, "dir1");
  });

  await t.test("무관한 부서의 사업부장은 메시지를 추가할 수 없다(차단, 전체 되돌림)", async () => {
    const before = await kpiOf();
    const r = await appendFeedback(dir2Token, "dir2", "무관한 사업부장의 끼어들기");
    assert.equal(r.status, 200);
    const after = await kpiOf();
    assert.deepEqual(after.feedbackThread, before.feedbackThread, "무관 부서 사업부장의 추가는 전부 거부돼야 한다");
  });

  await t.test("무관한 제3자(다른 팀 사원)는 메시지를 추가할 수 없다(차단)", async () => {
    const before = await kpiOf();
    const r = await appendFeedback(memberCToken, "memberC", "무관한 사원의 끼어들기");
    assert.equal(r.status, 200);
    const after = await kpiOf();
    assert.deepEqual(after.feedbackThread, before.feedbackThread);
  });

  await t.test("자기 명의가 아닌(타인 사칭) 메시지는 추가할 수 없다", async () => {
    const before = await kpiOf();
    // leaderA 토큰으로 호출하지만 메시지의 empId는 dir1(타인) 명의로 위조 시도.
    const r = await appendFeedback(leaderAToken, "dir1", "타인 명의 사칭 시도");
    assert.equal(r.status, 200);
    const after = await kpiOf();
    assert.deepEqual(after.feedbackThread, before.feedbackThread, "타인 명의 사칭은 거부돼야 한다");
  });

  await t.test("이미 있는 메시지를 수정하거나 지우는 것은 허용되지 않는다(append-only)", async () => {
    const before = await kpiOf();
    const d = await getData(api, memberAToken);
    const kpi = d.data.kpiEntries.find(k => k.id === "kpiA");
    // 과거 메시지의 내용을 몰래 바꿔치기 — prefix가 더 이상 일치하지 않으므로 거부돼야 한다.
    const tampered = kpi.feedbackThread.map((m, i) => i === 0 ? { ...m, message: "조작된 과거 메시지" } : m);
    const kpiEntries = d.data.kpiEntries.map(k => k.id === "kpiA" ? { ...k, feedbackThread: tampered } : k);
    const r = await api("/save", auth(memberAToken, "POST", { _version: d.version, kpiEntries }));
    assert.equal(r.status, 200);
    const after = await kpiOf();
    assert.deepEqual(after.feedbackThread, before.feedbackThread, "과거 메시지 변조는 거부되고 원본이 그대로 유지돼야 한다");
  });

  await t.test("최종 스레드는 3건 모두 순서대로, 원래 내용 그대로 보존되어 있다", async () => {
    const kpi = await kpiOf();
    assert.equal(kpi.feedbackThread.length, 3);
    assert.deepEqual(kpi.feedbackThread.map(m => m.empId), ["memberA", "leaderA", "dir1"]);
  });
});
