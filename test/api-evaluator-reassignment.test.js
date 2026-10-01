// Epic B 항목 #9 — "사업부장·팀장의 하위조직원 평가자 조정". 지금까지 다면평가 평가자
// 지정(compSessions)·기준 설정(evaluatorConfig)은 admin 전용이었다 — director/leader가
// 자기 하위조직원의 평가자를 스스로 조정할 방법이 서버에 전혀 없었다. 이번에 추가한
// _canManageCompSessionTarget(server.js)이 kpiEntries의 director/leader 승인 범위와
// 동일한 조직단위 기준(director=같은 dept, leader=같은 dept+team)으로 admin 외에도
// 허용하는지, 그리고 범위 밖 시도는 여전히 차단되는지 검증한다.
//
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용 — 실제 DB나
// 운영 데이터 파일은 이 테스트가 존재하는지조차 모른다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

async function login(api, loginId, pw, companyCode) {
  const r = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw, ...(companyCode ? { companyCode } : {}) }),
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

test("다면평가 평가자 지정(compSessions/evaluatorConfig) — director/leader 자기 하위조직원 범위 자기서비스", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "dirA", loginId: "dirA", pw: "dirA-pw-1", name: "사업부장A", role: "director", active: true, dept: "개발본부", menuPerms: {} },
    // dirB: 다른 부서(영업본부) 사업부장 — "범위 밖" 대조군.
    { id: "dirB", loginId: "dirB", pw: "dirB-pw-1", name: "사업부장B(무관)", role: "director", active: true, dept: "영업본부", menuPerms: {} },
    { id: "leaderA1", loginId: "leaderA1", pw: "leaderA1-pw-1", name: "팀장A1", role: "leader", active: true, dept: "개발본부", team: "A1팀", menuPerms: {} },
    // leaderA2: 같은 dept(개발본부)지만 다른 팀 — leader 범위 밖 대조군.
    { id: "leaderA2", loginId: "leaderA2", pw: "leaderA2-pw-1", name: "팀장A2", role: "leader", active: true, dept: "개발본부", team: "A2팀", menuPerms: {} },
    { id: "memA1", loginId: "memA1", pw: "memA1-pw-1", name: "팀원A1", role: "member", active: true, dept: "개발본부", team: "A1팀", menuPerms: {} },
    { id: "memA2", loginId: "memA2", pw: "memA2-pw-1", name: "팀원A2", role: "member", active: true, dept: "개발본부", team: "A2팀", menuPerms: {} },
    // "comp-eval" 메뉴를 개인적으로 꺼둔 director — menuPerms 게이팅 확인용.
    { id: "dirNoPerm", loginId: "dirNoPerm", pw: "dirNoPerm-pw-1", name: "메뉴차단사업부장", role: "director", active: true, dept: "개발본부", menuPerms: { "comp-eval": false } },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees }));
  assert.equal(seed.status, 200);

  const dirAToken = await login(api, "dirA", "dirA-pw-1");
  const dirBToken = await login(api, "dirB", "dirB-pw-1");
  const leaderA1Token = await login(api, "leaderA1", "leaderA1-pw-1");
  const leaderA2Token = await login(api, "leaderA2", "leaderA2-pw-1");
  const memA1Token = await login(api, "memA1", "memA1-pw-1");
  const dirNoPermToken = await login(api, "dirNoPerm", "dirNoPerm-pw-1");

  async function sessionsOf() {
    const d = await getData(api, adminToken);
    return d.data.compSessions || [];
  }
  async function evaluatorConfigOf() {
    const d = await getData(api, adminToken);
    return d.data.evaluatorConfig || {};
  }

  await t.test("director는 같은 dept 팀원(leaderA1)의 평가자 세션을 신규 생성할 수 있다", async () => {
    const d = await getData(api, dirAToken);
    const compSessions = [
      ...(d.data.compSessions || []),
      { id: "sess-leaderA1", year: 2026, targetId: "leaderA1", type: "comp", evaluatorIds: ["memA1"], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ];
    const r = await api("/save", auth(dirAToken, "POST", { _version: d.version, compSessions }));
    assert.equal(r.status, 200);
    const sessions = await sessionsOf();
    const s = sessions.find(s => s.id === "sess-leaderA1");
    assert.ok(s, "세션이 저장되어야 한다");
    assert.deepEqual(s.evaluatorIds, ["memA1"]);
  });

  await t.test("무관한 부서의 director(dirB)는 같은 조작을 시도해도 거부된다(전체 되돌림)", async () => {
    const before = await sessionsOf();
    const d = await getData(api, dirBToken);
    const compSessions = [
      ...(d.data.compSessions || []),
      { id: "sess-leaderA2-byDirB", year: 2026, targetId: "leaderA2", type: "comp", evaluatorIds: ["memA2"], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ];
    const r = await api("/save", auth(dirBToken, "POST", { _version: d.version, compSessions }));
    assert.equal(r.status, 200);
    const after = await sessionsOf();
    assert.equal(after.find(s => s.id === "sess-leaderA2-byDirB"), undefined, "무관 부서 director의 신규 세션 생성은 거부돼야 한다");
    assert.deepEqual(after.map(s => s.id).sort(), before.map(s => s.id).sort());
  });

  await t.test("leader는 같은 dept+team 팀원(memA1)의 평가자 세션을 수정할 수 있다", async () => {
    const d = await getData(api, leaderA1Token);
    const compSessions = (d.data.compSessions || []).map(s =>
      s.id === "sess-leaderA1" ? s : s
    ).concat([
      { id: "sess-memA1", year: 2026, targetId: "memA1", type: "comp", evaluatorIds: ["leaderA1"], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ]);
    const r = await api("/save", auth(leaderA1Token, "POST", { _version: d.version, compSessions }));
    assert.equal(r.status, 200);
    const sessions = await sessionsOf();
    assert.ok(sessions.find(s => s.id === "sess-memA1"), "같은 팀 팀원의 세션 생성이 허용되어야 한다");
  });

  await t.test("같은 dept이지만 다른 team의 leader(leaderA2)는 memA1 세션을 수정할 수 없다", async () => {
    const before = await sessionsOf();
    const d = await getData(api, leaderA2Token);
    const compSessions = (d.data.compSessions || []).map(s =>
      s.id === "sess-memA1" ? { ...s, evaluatorIds: ["leaderA2"], updatedAt: new Date().toISOString() } : s
    );
    const r = await api("/save", auth(leaderA2Token, "POST", { _version: d.version, compSessions }));
    assert.equal(r.status, 200);
    const after = await sessionsOf();
    const s = after.find(x => x.id === "sess-memA1");
    const beforeS = before.find(x => x.id === "sess-memA1");
    assert.deepEqual(s.evaluatorIds, beforeS.evaluatorIds, "다른 팀 leader의 수정 시도는 거부되고 원본이 유지돼야 한다");
  });

  await t.test("member는 어떤 compSessions도 생성/수정할 수 없다", async () => {
    const before = await sessionsOf();
    const d = await getData(api, memA1Token);
    const compSessions = [
      ...(d.data.compSessions || []),
      { id: "sess-by-member", year: 2026, targetId: "memA2", type: "comp", evaluatorIds: ["memA1"], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ];
    const r = await api("/save", auth(memA1Token, "POST", { _version: d.version, compSessions }));
    assert.equal(r.status, 200);
    const after = await sessionsOf();
    assert.equal(after.find(s => s.id === "sess-by-member"), undefined);
    assert.deepEqual(after.map(s => s.id).sort(), before.map(s => s.id).sort());
  });

  await t.test("comp-eval 메뉴를 개인적으로 끈 director는 같은 dept 대상이어도 거부된다(menuPerms 게이팅)", async () => {
    const before = await sessionsOf();
    const d = await getData(api, dirNoPermToken);
    const compSessions = [
      ...(d.data.compSessions || []),
      { id: "sess-by-dirNoPerm", year: 2026, targetId: "leaderA2", type: "comp", evaluatorIds: ["memA2"], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ];
    const r = await api("/save", auth(dirNoPermToken, "POST", { _version: d.version, compSessions }));
    assert.equal(r.status, 200);
    const after = await sessionsOf();
    assert.equal(after.find(s => s.id === "sess-by-dirNoPerm"), undefined, "menuPerms로 comp-eval이 꺼져있으면 거부돼야 한다");
    assert.deepEqual(after.map(s => s.id).sort(), before.map(s => s.id).sort());
  });

  await t.test("admin은 범위와 무관하게 항상 compSessions를 쓸 수 있다(회귀 확인)", async () => {
    const d = await getData(api, adminToken);
    const compSessions = [
      ...(d.data.compSessions || []),
      { id: "sess-by-admin", year: 2026, targetId: "memA2", type: "comp", evaluatorIds: ["leaderA2"], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ];
    const r = await api("/save", auth(adminToken, "POST", { _version: d.version, compSessions }));
    assert.equal(r.status, 200);
    const after = await sessionsOf();
    assert.ok(after.find(s => s.id === "sess-by-admin"));
  });

  // ── evaluatorConfig(싱글톤, {targetId:{...}}) ───────────────────────────────
  await t.test("director는 같은 dept 대상(leaderA1)의 evaluatorConfig 키를 쓸 수 있다", async () => {
    const d = await getData(api, dirAToken);
    const evaluatorConfig = { ...(d.data.evaluatorConfig || {}), leaderA1: { directorMax: null, leaderMax: 2, memberMax: null, fixedEvaluatorIds: null, note: "dirA 설정" } };
    const r = await api("/save", auth(dirAToken, "POST", { _version: d.version, evaluatorConfig }));
    assert.equal(r.status, 200);
    const cfg = await evaluatorConfigOf();
    assert.equal(cfg.leaderA1?.note, "dirA 설정");
  });

  await t.test("무관 부서 director(dirB)는 leaderA2 키를 쓸 수 없다(그 키만 저장본 유지)", async () => {
    const beforeCfg = await evaluatorConfigOf();
    const d = await getData(api, dirBToken);
    const evaluatorConfig = { ...(d.data.evaluatorConfig || {}), leaderA2: { directorMax: null, leaderMax: 9, memberMax: null, fixedEvaluatorIds: null, note: "dirB 위조 시도" } };
    const r = await api("/save", auth(dirBToken, "POST", { _version: d.version, evaluatorConfig }));
    assert.equal(r.status, 200);
    const cfg = await evaluatorConfigOf();
    assert.deepEqual(cfg.leaderA2, beforeCfg.leaderA2, "무관 부서 director의 키 쓰기는 거부되고 원본(없으면 undefined)이 유지돼야 한다");
  });

  await t.test("leader는 같은 dept+team 대상(memA1)의 evaluatorConfig 키를 쓸 수 있다", async () => {
    const d = await getData(api, leaderA1Token);
    const evaluatorConfig = { ...(d.data.evaluatorConfig || {}), memA1: { directorMax: null, leaderMax: null, memberMax: 3, fixedEvaluatorIds: null, note: "leaderA1 설정" } };
    const r = await api("/save", auth(leaderA1Token, "POST", { _version: d.version, evaluatorConfig }));
    assert.equal(r.status, 200);
    const cfg = await evaluatorConfigOf();
    assert.equal(cfg.memA1?.note, "leaderA1 설정");
  });

  await t.test("다른 팀 leader(leaderA2)는 memA1 키를 바꿀 수 없다", async () => {
    const beforeCfg = await evaluatorConfigOf();
    const d = await getData(api, leaderA2Token);
    const evaluatorConfig = { ...(d.data.evaluatorConfig || {}), memA1: { directorMax: null, leaderMax: null, memberMax: 999, fixedEvaluatorIds: null, note: "leaderA2 위조 시도" } };
    const r = await api("/save", auth(leaderA2Token, "POST", { _version: d.version, evaluatorConfig }));
    assert.equal(r.status, 200);
    const cfg = await evaluatorConfigOf();
    assert.deepEqual(cfg.memA1, beforeCfg.memA1, "다른 팀 leader의 키 쓰기는 거부되고 원본이 유지돼야 한다");
  });

  await t.test("member는 evaluatorConfig를 전혀 쓸 수 없다(기존 동작 유지)", async () => {
    const beforeCfg = await evaluatorConfigOf();
    const d = await getData(api, memA1Token);
    const evaluatorConfig = { ...(d.data.evaluatorConfig || {}), memA2: { directorMax: null, leaderMax: null, memberMax: 1, fixedEvaluatorIds: null, note: "member 위조 시도" } };
    const r = await api("/save", auth(memA1Token, "POST", { _version: d.version, evaluatorConfig }));
    assert.equal(r.status, 200);
    const cfg = await evaluatorConfigOf();
    assert.deepEqual(cfg.memA2, beforeCfg.memA2);
  });

  await t.test("admin은 범위와 무관하게 evaluatorConfig 전체를 쓸 수 있다(회귀 확인)", async () => {
    const d = await getData(api, adminToken);
    const evaluatorConfig = { ...(d.data.evaluatorConfig || {}), leaderA2: { directorMax: null, leaderMax: 1, memberMax: null, fixedEvaluatorIds: null, note: "admin 설정" } };
    const r = await api("/save", auth(adminToken, "POST", { _version: d.version, evaluatorConfig }));
    assert.equal(r.status, 200);
    const cfg = await evaluatorConfigOf();
    assert.equal(cfg.leaderA2?.note, "admin 설정");
  });
});

// Postgres 모드 전용 검증 — _getEmployeeByIdPg()와 GENERIC_LIST_FIELDS 루프(compSessions)
// 경로는 JSON 모드 테스트(위)로는 전혀 가지 않는, 이번에 새로 추가한 코드 경로다. 실제
// 멀티테넌트 SaaS 운영 모드와 동일하게 회사 가입까지 거쳐 director/leader 범위 판정이
// Postgres에서도 동일하게 동작하는지 확인한다.
const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("다면평가 평가자 지정 — Postgres 모드 (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");

  test("director/leader의 compSessions·evaluatorConfig 자기 하위조직원 조정이 실제 PostgreSQL(운영 모드)에서도 동일하게 동작한다", async (t) => {
    const dbName = `hrtest_evalreassign_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const base = ADMIN_DATABASE_URL.replace(/\/[^/]*(\?.*)?$/, "");
    const testDbUrl = `${base}/${dbName}`;
    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    t.after(async () => {
      try {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [dbName]
        );
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally {
        await admin.end();
      }
    });

    const server = await startServer({ env: { DATABASE_URL: testDbUrl } });
    t.after(() => server.stop());
    const api = (path, options) => fetch(server.baseUrl + path, options);

    const reg = await (await api("/api/companies/register", auth(null, "POST", {
      companyName: "평가자조정테스트회사", adminName: "관리자", loginId: "admin_evr", password: "AdminPassw0rd1",
    }))).json();
    assert.equal(reg.ok, true);
    const adminToken = reg.token;
    const companyCode = reg.companyCode;

    let d = await getData(api, adminToken);
    const employees = [
      ...d.data.employees,
      { id: "pg-dirA", loginId: "pg-dirA", pw: "pg-dirA-pw-1", name: "사업부장A", role: "director", active: true, dept: "개발본부" },
      { id: "pg-dirB", loginId: "pg-dirB", pw: "pg-dirB-pw-1", name: "사업부장B(무관)", role: "director", active: true, dept: "영업본부" },
      { id: "pg-leaderA1", loginId: "pg-leaderA1", pw: "pg-leaderA1-pw-1", name: "팀장A1", role: "leader", active: true, dept: "개발본부", team: "A1팀" },
      { id: "pg-memA1", loginId: "pg-memA1", pw: "pg-memA1-pw-1", name: "팀원A1", role: "member", active: true, dept: "개발본부", team: "A1팀" },
    ];
    let r = await api("/save", auth(adminToken, "POST", { _version: d.version, employees }));
    assert.equal(r.status, 200);

    const dirAToken = await login(api, "pg-dirA", "pg-dirA-pw-1", companyCode);
    const dirBToken = await login(api, "pg-dirB", "pg-dirB-pw-1", companyCode);
    const leaderA1Token = await login(api, "pg-leaderA1", "pg-leaderA1-pw-1", companyCode);

    // compSessions: 같은 dept director는 신규 세션 생성 가능, 무관 부서 director는 거부.
    d = await getData(api, dirAToken);
    r = await api("/save", auth(dirAToken, "POST", {
      _version: d.version,
      compSessions: [...(d.data.compSessions || []), { id: "pg-sess-leaderA1", year: 2027, targetId: "pg-leaderA1", type: "comp", evaluatorIds: ["pg-memA1"], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    }));
    assert.equal(r.status, 200);
    d = await getData(api, adminToken);
    assert.ok((d.data.compSessions || []).find(s => s.id === "pg-sess-leaderA1"), "Postgres 모드에서도 같은 dept director의 세션 생성이 저장돼야 함");

    d = await getData(api, dirBToken);
    r = await api("/save", auth(dirBToken, "POST", {
      _version: d.version,
      compSessions: [...(d.data.compSessions || []), { id: "pg-sess-by-dirB", year: 2027, targetId: "pg-memA1", type: "comp", evaluatorIds: ["pg-leaderA1"], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    }));
    assert.equal(r.status, 200);
    d = await getData(api, adminToken);
    assert.equal((d.data.compSessions || []).find(s => s.id === "pg-sess-by-dirB"), undefined, "Postgres 모드도 무관 부서 director의 세션 생성은 거부돼야 함");

    // evaluatorConfig: 같은 dept+team leader는 키 쓰기 가능, 무관 부서 director는 거부.
    d = await getData(api, leaderA1Token);
    r = await api("/save", auth(leaderA1Token, "POST", {
      _version: d.version,
      evaluatorConfig: { ...(d.data.evaluatorConfig || {}), "pg-memA1": { directorMax: null, leaderMax: null, memberMax: 2, fixedEvaluatorIds: null, note: "leaderA1(pg)" } },
    }));
    assert.equal(r.status, 200);
    d = await getData(api, adminToken);
    assert.equal(d.data.evaluatorConfig?.["pg-memA1"]?.note, "leaderA1(pg)", "Postgres 모드에서도 같은 dept+team leader의 evaluatorConfig 쓰기가 저장돼야 함");

    d = await getData(api, dirBToken);
    r = await api("/save", auth(dirBToken, "POST", {
      _version: d.version,
      evaluatorConfig: { ...(d.data.evaluatorConfig || {}), "pg-leaderA1": { directorMax: null, leaderMax: 9, memberMax: null, fixedEvaluatorIds: null, note: "dirB 위조(pg)" } },
    }));
    assert.equal(r.status, 200);
    d = await getData(api, adminToken);
    assert.equal(d.data.evaluatorConfig?.["pg-leaderA1"], undefined, "Postgres 모드도 무관 부서 director의 evaluatorConfig 쓰기는 거부돼야 함");
  });
}
