"use strict";

// 2026-10-12 종합 고도화 리뷰("추가로 고도화,개선, 추가할 내용 확인해줘")에서 발견한
// 2개 Tier-2 보안 항목의 회귀 테스트.
//
// 1) POST /log — action 문자열의 형식만 검증하고 "실제로 그 사건이 일어났는지"는
//    확인하지 않아, 인증된 사용자라면 누구나 자기 신원으로 "role_changed"/
//    "menu_perm_changed"/"menu_perm_group_applied" 같은 위조 감사기록을 남길 수 있었다
//    (D1 권한변경로그 기능의 신뢰성을 무너뜨림). 이 3개 action을 실제로 만들어낼 수 있는
//    유일한 화면(권한 관리·직원 수정의 역할 변경)이 전부 관리자 전용이라는 사실에 맞춰,
//    이제 admin만 이 3개를 자가보고할 수 있다 — 그 외 action(본인 KPI 제출 등)은 "자신에
//    대한 사실 주장"이라 위조해도 보안 영향이 없어 그대로 둔다.
// 2) employees[].photoUrl — 클라이언트(uploadEmpEditPhoto())가 이미지 타입·300KB 크기를
//    검증하지만 전부 브라우저 측 검사일 뿐, /save를 직접 호출하면 서버가 전혀 확인하지
//    않아 임의 크기·형식의 문자열이 그대로 저장돼 전 직원이 매 GET /data마다 받는
//    employees 배열의 응답 크기를 무한히 부풀릴 수 있었다. 이제 _sanitizeEmployeeRecord()가
//    "data:image/*;base64,..." 형식 + 420000자(300KB 원본의 base64 인코딩 상한) 이하만
//    허용하고, 위반 시 그 필드만 저장값으로 되돌린다(요청 전체를 거부하지 않음).
//
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용 — 실제 DB나
// 운영 데이터 파일은 이 테스트가 존재하는지조차 모른다.
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

async function login(api, loginId, pw, companyCode) {
  const r = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw, ...(companyCode ? { companyCode } : {}) }),
  })).json();
  assert.equal(r.ok, true, `${loginId} 로그인 실패: ${JSON.stringify(r)}`);
  return r.token;
}

async function getData(api, token) {
  const r = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(r.ok, true);
  return r;
}

test("POST /log — 권한류 action(role_changed 등)은 admin만 자가보고할 수 있다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "mem1", loginId: "mem1", pw: "mem1-pw-123", name: "팀원1", role: "member", active: true, dept: "개발본부", team: "A팀" },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees }));
  assert.equal(seed.status, 200);
  const memberToken = await login(api, "mem1", "mem1-pw-123");

  await t.test("member가 role_changed를 자가보고하면 403으로 거부되고 기록되지 않는다", async () => {
    const r = await api("/log", auth(memberToken, "POST", { action: "role_changed", target: "위조", detail: "member → admin" }));
    assert.equal(r.status, 403);
    const logs = await (await api("/activity", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    assert.ok(!logs.logs.some(l => l.action === "role_changed"), "위조 시도가 실제로는 기록되면 안 됨");
  });

  await t.test("member가 menu_perm_changed/menu_perm_group_applied를 자가보고해도 동일하게 403", async () => {
    for (const action of ["menu_perm_changed", "menu_perm_group_applied"]) {
      const r = await api("/log", auth(memberToken, "POST", { action, target: "위조", detail: "위조 시도" }));
      assert.equal(r.status, 403, `${action}은 403이어야 함`);
    }
  });

  await t.test("member의 benign action(kpi_submitted 등) 자가보고는 그대로 허용된다(회귀 방지)", async () => {
    const r = await api("/log", auth(memberToken, "POST", { action: "kpi_submitted", target: "KPI 제출", detail: "1건" }));
    assert.equal(r.status, 200);
    const logs = await (await api("/activity", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const entry = logs.logs.find(l => l.action === "kpi_submitted");
    assert.ok(entry, "benign action은 정상 기록돼야 함");
    assert.equal(entry.userId, "emp:mem1", "기록 주체는 토큰(신원) 기준이어야 함(_authenticatedActorKey)");
  });

  await t.test("admin이 role_changed를 보고하면 정상 허용되고 실제로 기록된다", async () => {
    const r = await api("/log", auth(adminToken, "POST", { action: "role_changed", target: "팀원1 권한 변경", detail: "member → leader" }));
    assert.equal(r.status, 200);
    const logs = await (await api("/activity", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const entry = logs.logs.find(l => l.action === "role_changed");
    assert.ok(entry, "admin의 role_changed 보고는 정상 기록돼야 함");
  });
});

test("employees[].photoUrl — 서버측 크기/형식 검증(300KB 데이터 URI만 허용)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "emp1", loginId: "emp1", pw: "emp1-pw-1234", name: "직원1", role: "member", active: true, dept: "개발본부", team: "A팀" },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees }));
  assert.equal(seed.status, 200);

  async function savePhoto(photoUrl) {
    const d = await getData(api, adminToken);
    const next = d.data.employees.map(e => String(e.id) === "emp1" ? { ...e, photoUrl } : e);
    const r = await api("/save", auth(adminToken, "POST", { _version: d.version, employees: next }));
    assert.equal(r.status, 200);
    const after = await getData(api, adminToken);
    return after.data.employees.find(e => String(e.id) === "emp1").photoUrl;
  }

  await t.test("정상 data:image 형식(소용량)은 그대로 저장된다", async () => {
    const valid = "data:image/png;base64," + "A".repeat(100);
    const stored = await savePhoto(valid);
    assert.equal(stored, valid);
  });

  await t.test("420000자를 넘는 photoUrl은 거부되고 기존 저장값이 유지된다", async () => {
    const before = (await getData(api, adminToken)).data.employees.find(e => String(e.id) === "emp1").photoUrl;
    const tooLarge = "data:image/png;base64," + "A".repeat(500000);
    const stored = await savePhoto(tooLarge);
    assert.equal(stored, before, "크기 초과 photoUrl은 거부돼 이전 값이 유지돼야 함");
  });

  await t.test("이미지 데이터 URI 형식이 아닌 임의 문자열은 거부된다", async () => {
    const before = (await getData(api, adminToken)).data.employees.find(e => String(e.id) === "emp1").photoUrl;
    const junk = "그냥 임의의 긴 텍스트 데이터".repeat(50);
    const stored = await savePhoto(junk);
    assert.equal(stored, before, "이미지 데이터 URI가 아닌 값은 거부돼야 함");
  });

  await t.test("빈 문자열(사진 제거)은 항상 허용된다", async () => {
    const stored = await savePhoto("");
    assert.equal(stored, "");
  });

  await t.test("non-admin(본인 아님)의 photoUrl 쓰기는 preserveServerOwnedStateForNonAdmin에 의해 이미 차단된다(회귀 방지)", async () => {
    const valid = "data:image/png;base64," + "B".repeat(100);
    await savePhoto(valid);
    const before = await getData(api, adminToken);
    const seed2 = await api("/save", auth(adminToken, "POST", {
      _version: before.version,
      employees: [...before.data.employees, { id: "emp2", loginId: "emp2", pw: "emp2-pw-1234", name: "직원2", role: "member", active: true, dept: "개발본부", team: "B팀" }],
    }));
    assert.equal(seed2.status, 200);

    const emp2Token = await login(api, "emp2", "emp2-pw-1234");
    const d = await getData(api, emp2Token);
    const tampered = d.data.employees.map(e => String(e.id) === "emp1" ? { ...e, photoUrl: "data:image/png;base64," + "Z".repeat(100) } : e);
    const r = await api("/save", auth(emp2Token, "POST", { _version: d.version, employees: tampered }));
    assert.equal(r.status, 200, "위조 저장 요청 자체는 200으로 받아들여져야 함(부분 되돌림 방식)");

    const after = (await getData(api, adminToken)).data.employees.find(e => String(e.id) === "emp1").photoUrl;
    assert.equal(after, valid, "non-admin의 타인 photoUrl 변경은 반영되면 안 됨");
  });
});

// JSON 파일 모드와 Postgres 모드가 _sanitizePhotoUrl() 호출부를 각자 따로 구현하고
// 있어(server.js의 두 분기), JSON 모드만 테스트하면 Postgres 분기의 실수(예: storedEmpRow
// 전달 누락)를 놓칠 수 있다 — 실제 운영 배포가 타는 경로이므로 별도로 검증한다.
const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("employees[].photoUrl — Postgres 모드 (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");

  test("employees[].photoUrl 서버측 검증이 실제 PostgreSQL(운영 모드)에서도 정상 동작한다", async (t) => {
    const dbName = `hrtest_photourl_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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

    const reg = await (await api("/api/companies/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "photoUrl테스트회사", adminName: "관리자", loginId: "admin_pu", password: "AdminPassw0rd1" }),
    })).json();
    assert.equal(reg.ok, true);
    const adminToken = reg.token;

    let d = await getData(api, adminToken);
    const seed = await api("/save", auth(adminToken, "POST", {
      _version: d.version,
      employees: [...d.data.employees, { id: "pg-emp1", loginId: "pg-emp1", pw: "pg-emp1-pw-1", name: "직원1", role: "member", active: true, dept: "개발본부" }],
    }));
    assert.equal(seed.status, 200);

    // Postgres 모드는 JSON 파일 모드와 달리 "updatedAt이 기존 저장값보다 엄격히 더 최신일
    // 때만" UPDATE를 실행한다(불필요한 재해싱 방지 최적화, _persistDataLocked 주석 참고) —
    // JSON 모드는 매 저장마다 제출된 레코드를 항상 그대로 반영하므로 이 차이가 없다. 매
    // 호출마다 updatedAt을 명시적으로 늘려 실제로 UPDATE가 실행되도록 한다.
    let _photoSaveSeq = 0;
    async function savePhoto(photoUrl) {
      const cur = await getData(api, adminToken);
      const updatedAt = new Date(Date.now() + (++_photoSaveSeq) * 1000).toISOString();
      const next = cur.data.employees.map(e => String(e.id) === "pg-emp1" ? { ...e, photoUrl, updatedAt } : e);
      const r = await api("/save", auth(adminToken, "POST", { _version: cur.version, employees: next }));
      assert.equal(r.status, 200);
      const after = await getData(api, adminToken);
      return after.data.employees.find(e => String(e.id) === "pg-emp1").photoUrl;
    }

    await t.test("정상 data:image 형식은 그대로 저장된다", async () => {
      const valid = "data:image/jpeg;base64," + "A".repeat(100);
      assert.equal(await savePhoto(valid), valid);
    });

    await t.test("420000자를 넘는 photoUrl은 거부되고 기존 값이 유지된다", async () => {
      const before = (await getData(api, adminToken)).data.employees.find(e => String(e.id) === "pg-emp1").photoUrl;
      const tooLarge = "data:image/jpeg;base64," + "A".repeat(500000);
      assert.equal(await savePhoto(tooLarge), before);
    });
  });
}
