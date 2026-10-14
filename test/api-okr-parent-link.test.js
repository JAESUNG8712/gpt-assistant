// 작업4(항목D) — OKR 상위목표(parentOkrId) 연계. scope 계층: personal(0) < team(1) <
// company(2), 부모는 자식보다 더 높은 랭크여야 한다(회사 OKR은 랭크가 가장 높아 자동으로
// 부모를 가질 수 없게 된다). 이 검증은 _validateFieldValues('okrObjectives', ...)가 아니라
// 별도의 _okrParentLinkValid() + 전용 2차 패스(JSON모드)/매 아이템 직전 재조회(Postgres모드)
// 로 구현돼 있다 — 같은 /save 요청에 부모·자식 OKR이 함께(디바운스로 묶여) 처음 생성되는
// 흔한 경우에도 존재검사가 거짓으로 실패해 신규 레코드가 드롭되지 않도록 하기 위해서다.
// 이 테스트는 그 "같은 배치에서 부모+자식 동시 생성" 시나리오를 핵심으로 검증한다.
//
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용 — 실제 DB나 운영
// 데이터 파일은 이 테스트가 존재하는지조차 모른다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

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
function makeOkr(id, overrides) {
  const now = new Date().toISOString();
  return {
    id, year: 2025, ownerId: "admin1", ownerName: "관리자1", dept: "", team: "",
    scope: "personal", title: `목표-${id}`, description: "", status: "draft",
    krs: [], parentOkrId: null, comments: [], attachments: [],
    createdAt: now, updatedAt: now, ...overrides,
  };
}

test("OKR parentOkrId — 존재·연도일치·scope계층 검증, 필드만 되돌림(레코드 드롭 아님)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const adminToken = boot.token;

  await t.test("정상 연결: team → company (상위 랭크, 같은 연도, 존재함) 저장됨", async () => {
    const d = await getData(api, adminToken);
    const company1 = makeOkr("okr-co1", { scope: "company", status: "approved" });
    const team1 = makeOkr("okr-tm1", { scope: "team", parentOkrId: "okr-co1" });
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version, okrObjectives: [...(d.data.okrObjectives || []), company1, team1],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const tm = (check.data.okrObjectives || []).find(o => o.id === "okr-tm1");
    assert.ok(tm, "team1이 저장돼야 함");
    assert.equal(tm.parentOkrId, "okr-co1", "유효한 상위목표 연결은 유지돼야 함");
  });

  await t.test("정상 연결: personal → team, personal → company(한 단계 건너뛰기)도 허용", async () => {
    const d = await getData(api, adminToken);
    const personal1 = makeOkr("okr-p1", { scope: "personal", parentOkrId: "okr-tm1" });
    const personal2 = makeOkr("okr-p2", { scope: "personal", parentOkrId: "okr-co1" });
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version, okrObjectives: [...(d.data.okrObjectives || []), personal1, personal2],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const p1 = (check.data.okrObjectives || []).find(o => o.id === "okr-p1");
    const p2 = (check.data.okrObjectives || []).find(o => o.id === "okr-p2");
    assert.equal(p1.parentOkrId, "okr-tm1");
    assert.equal(p2.parentOkrId, "okr-co1");
  });

  await t.test("자기참조 차단: parentOkrId === 자기 id → null로 되돌림(레코드는 그대로 저장)", async () => {
    const d = await getData(api, adminToken);
    const selfRef = makeOkr("okr-self1", { scope: "team", parentOkrId: "okr-self1" });
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version, okrObjectives: [...(d.data.okrObjectives || []), selfRef],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const rec = (check.data.okrObjectives || []).find(o => o.id === "okr-self1");
    assert.ok(rec, "자기참조여도 레코드 자체는 드롭되지 않고 저장돼야 함");
    assert.equal(rec.parentOkrId, null, "자기참조는 null로 되돌려져야 함");
    assert.equal(rec.title, "목표-okr-self1", "parentOkrId 외 다른 필드는 영향 없어야 함");
  });

  await t.test("존재하지 않는 상위목표 참조 → null로 되돌림", async () => {
    const d = await getData(api, adminToken);
    const ghost = makeOkr("okr-ghost1", { scope: "team", parentOkrId: "no-such-okr-id" });
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version, okrObjectives: [...(d.data.okrObjectives || []), ghost],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const rec = (check.data.okrObjectives || []).find(o => o.id === "okr-ghost1");
    assert.ok(rec, "레코드는 그대로 저장돼야 함");
    assert.equal(rec.parentOkrId, null);
  });

  await t.test("연도 불일치 → null로 되돌림(부모는 2025년, 자식은 2026년)", async () => {
    const d = await getData(api, adminToken);
    const mismatch = makeOkr("okr-yrmis1", { scope: "team", year: 2026, parentOkrId: "okr-co1" });
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version, okrObjectives: [...(d.data.okrObjectives || []), mismatch],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const rec = (check.data.okrObjectives || []).find(o => o.id === "okr-yrmis1");
    assert.ok(rec);
    assert.equal(rec.parentOkrId, null, "연도가 다른 부모 연결은 거부돼야 함");
  });

  await t.test("scope 계층 위반 → null로 되돌림(같은 랭크, 역방향, 회사 OKR이 부모를 가지려는 시도)", async () => {
    const d = await getData(api, adminToken);
    const sameRank = makeOkr("okr-samerank1", { scope: "team", parentOkrId: "okr-tm1" }); // team→team
    const reverse = makeOkr("okr-reverse1", { scope: "team", parentOkrId: "okr-p1" }); // team→personal(역방향)
    const companyWithParent = makeOkr("okr-coparent1", { scope: "company", parentOkrId: "okr-co1" }); // company는 부모를 가질 수 없음
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version, okrObjectives: [...(d.data.okrObjectives || []), sameRank, reverse, companyWithParent],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const map = new Map((check.data.okrObjectives || []).map(o => [o.id, o]));
    assert.ok(map.get("okr-samerank1"), "레코드는 저장됨");
    assert.equal(map.get("okr-samerank1").parentOkrId, null, "같은 랭크끼리 연결은 거부");
    assert.equal(map.get("okr-reverse1").parentOkrId, null, "역방향(team→personal) 연결은 거부");
    assert.equal(map.get("okr-coparent1").parentOkrId, null, "회사 OKR은 어떤 부모도 가질 수 없음");
  });

  await t.test("같은 /save 요청에서 부모(신규)·자식(신규)을 동시에 생성해도 연결이 유지된다(배치 축적 검증)", async () => {
    const d = await getData(api, adminToken);
    const newParent = makeOkr("okr-batch-parent1", { scope: "company", status: "approved", year: 2027 });
    const newChild = makeOkr("okr-batch-child1", { scope: "team", year: 2027, parentOkrId: "okr-batch-parent1" });
    // storedList(서버의 기존 저장값)에는 둘 다 아직 없음 — 같은 배치 안에서 서로를 봐야 한다.
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version, okrObjectives: [...(d.data.okrObjectives || []), newParent, newChild],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const child = (check.data.okrObjectives || []).find(o => o.id === "okr-batch-child1");
    assert.ok(child, "자식 레코드가 저장돼야 함");
    assert.equal(child.parentOkrId, "okr-batch-parent1",
      "같은 배치 안에 있는 신규 부모를 참조하는 연결은 유지돼야 한다(storedList에 없어도 형제 레코드로 인정)");
  });

  await t.test("미승인 상태 부모도 서버는 연결을 허용한다(승인요구는 UI 후보필터만의 몫, 서버는 구조적 정합성만 검증)", async () => {
    const d = await getData(api, adminToken);
    const pendingParent = makeOkr("okr-pending-parent1", { scope: "company", status: "pending", year: 2028 });
    const childOfPending = makeOkr("okr-child-of-pending1", { scope: "team", year: 2028, parentOkrId: "okr-pending-parent1" });
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version, okrObjectives: [...(d.data.okrObjectives || []), pendingParent, childOfPending],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const child = (check.data.okrObjectives || []).find(o => o.id === "okr-child-of-pending1");
    assert.equal(child.parentOkrId, "okr-pending-parent1", "미승인 부모라도 존재·연도·scope계층이 맞으면 서버는 허용한다");
  });

  await t.test("기존 레코드 수정: 유효하지 않은 parentOkrId로 바꿔도 title 등 다른 필드 변경은 그대로 반영된다", async () => {
    let d = await getData(api, adminToken);
    const existing = (d.data.okrObjectives || []).find(o => o.id === "okr-tm1");
    assert.ok(existing);
    const updated = { ...existing, title: "제목 변경됨", parentOkrId: "ghost-parent-xyz" };
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version,
      okrObjectives: d.data.okrObjectives.map(o => (o.id === "okr-tm1" ? updated : o)),
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const rec = (check.data.okrObjectives || []).find(o => o.id === "okr-tm1");
    assert.equal(rec.title, "제목 변경됨", "title 변경은 그대로 반영돼야 함");
    assert.equal(rec.parentOkrId, "okr-co1", "존재하지 않는 부모로의 변경 시도는 기존 저장값(okr-co1)으로 되돌려져야 함");
  });

  await t.test("parentOkrId 타입/길이 검증(_validateFieldValues 쪽 모양 검사): 숫자/과도한 길이는 신규 레코드가 드롭된다", async () => {
    const d = await getData(api, adminToken);
    const base = d.data.okrObjectives || [];
    const badType = makeOkr("okr-bad-type1", { scope: "team", parentOkrId: 12345 });
    const badLen = makeOkr("okr-bad-len1", { scope: "team", parentOkrId: "x".repeat(200) });
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version, okrObjectives: [...base, badType, badLen],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const ids = new Set((check.data.okrObjectives || []).map(o => o.id));
    assert.equal(ids.has("okr-bad-type1"), false, "parentOkrId가 숫자면(타입 오류) 레코드 자체가 드롭돼야 함");
    assert.equal(ids.has("okr-bad-len1"), false, "parentOkrId가 과도하게 길면 레코드 자체가 드롭돼야 함");
  });
});

// Postgres 모드 전용 검증 — 매 아이템 직전 validationList를 다시 조회하는 경로(JSON 모드
// 테스트로는 전혀 가지 않는 코드)가, 같은 트랜잭션 안에서 앞서 INSERT된 형제 OKR(부모가
// 같은 배치에서 막 함께 생성된 경우)까지 실제로 보는지 실제 PostgreSQL로 확인한다.
const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("OKR parentOkrId — Postgres 모드 (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");

  test("OKR parentOkrId 연계가 실제 PostgreSQL(운영 모드)에서도 배치 내 형제 인식·거부 처리 동일하게 동작한다", async (t) => {
    const dbName = `hrtest_okrparent_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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
      companyName: "OKR연계테스트회사", adminName: "관리자", loginId: "admin_okrp", password: "AdminPassw0rd1",
    }))).json();
    assert.equal(reg.ok, true);
    const adminToken = reg.token;

    let d = await getData(api, adminToken);
    const company1 = makeOkr("pg-okr-co1", { scope: "company", status: "approved", ownerId: reg.employee?.id || "admin_okrp" });
    const team1 = makeOkr("pg-okr-tm1", { scope: "team", parentOkrId: "pg-okr-co1", ownerId: reg.employee?.id || "admin_okrp" });
    let r = await api("/save", auth(adminToken, "POST", {
      _version: d.version, okrObjectives: [...(d.data.okrObjectives || []), company1, team1],
    }));
    assert.equal(r.status, 200);
    d = await getData(api, adminToken);
    let rec = (d.data.okrObjectives || []).find(o => o.id === "pg-okr-tm1");
    assert.ok(rec, "Postgres 모드에서도 레코드가 저장돼야 함");
    assert.equal(rec.parentOkrId, "pg-okr-co1", "Postgres 모드에서도 유효한 연결은 유지돼야 함");

    // 존재하지 않는 부모 참조는 Postgres 모드에서도 거부(필드만 되돌림).
    const ghost = makeOkr("pg-okr-ghost1", { scope: "team", parentOkrId: "no-such-id", ownerId: reg.employee?.id || "admin_okrp" });
    r = await api("/save", auth(adminToken, "POST", {
      _version: d.version, okrObjectives: [...d.data.okrObjectives, ghost],
    }));
    assert.equal(r.status, 200);
    d = await getData(api, adminToken);
    rec = (d.data.okrObjectives || []).find(o => o.id === "pg-okr-ghost1");
    assert.ok(rec, "Postgres 모드에서도 레코드는 드롭되지 않고 저장돼야 함");
    assert.equal(rec.parentOkrId, null, "Postgres 모드에서도 존재하지 않는 부모는 null로 되돌려져야 함");
  });
}
