// server.js를 PostgreSQL 모드(DATABASE_URL 설정)로 별도 프로세스에 띄워 멀티테넌트
// 핵심 흐름(회사 가입/로그인/격리)을 검증한다. 운영 DB는 절대 쓰지 않는다 — 이
// 테스트는 매 실행마다 임의 이름의 새 데이터베이스를 만들어서만 쓰고 끝나면 지운다.
//
// DATABASE_URL(또는 TEST_DATABASE_URL)이 없으면(로컬에 Postgres가 없는 개발자 등)
// 이 파일 전체를 건너뛴다 — file-mode.test.js만으로도 핵심 API 계약은 커버되므로
// Postgres 미설치가 전체 테스트 스위트를 막지 않게 하기 위함. CI는
// services: postgres로 이 환경변수를 채워 넣는다(.github/workflows 참고).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startServer, startServerExpectingBootFailure } = require("../support/start-server");

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!ADMIN_DATABASE_URL) {
  test("postgres-mode API suite (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  test("postgres-mode API suite", async (t) => {
    const dbName = `hrtest_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const testDbUrl = _withDatabaseName(ADMIN_DATABASE_URL, dbName);

    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    // 식별자는 사용자 입력이 아니라 이 파일이 스스로 만든 타임스탬프+난수 이름이라
    // 안전하게 그대로 SQL에 붙여넣을 수 있다(외부 입력 없음).
    await admin.query(`CREATE DATABASE ${dbName}`);

    t.after(async () => {
      try {
        // 테스트 서버들을 stop()에서 이미 종료했지만, 혹시 남은 커넥션이 있으면
        // DROP DATABASE가 "다른 세션이 사용 중"으로 실패할 수 있어 먼저 강제 종료한다.
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [dbName]
        );
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally {
        await admin.end();
      }
    });

    let serverA; // 공용 서버 인스턴스(schema.sql은 서버 부팅 시 자동 적용됨)
    let serverB;
    t.after(async () => { if (serverA) await serverA.stop(); });
    t.after(async () => { if (serverB) await serverB.stop(); });
    serverA = await startServer({ env: { DATABASE_URL: testDbUrl } });
    const api = (p, opts) => fetch(serverA.baseUrl + p, opts);

    let companyACode, companyAToken;

    await t.test("1) POST /api/companies/register — 회사 가입 성공", async () => {
      const res = await api("/api/companies/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: "테스트회사A", adminName: "관리자A", loginId: "admin_a", password: "TestPassword123" }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.ok(json.companyCode);
      assert.ok(json.token);
      assert.equal(json.employee.pw, undefined);
      assert.equal(json.employee.loginId, "admin_a");
      companyACode = json.companyCode;
      companyAToken = json.token;
    });

    await t.test("2) 반환된 companyCode로 로그인 성공", async () => {
      const res = await api("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyCode: companyACode, loginId: "admin_a", pw: "TestPassword123" }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.ok(json.token);
    });

    await t.test("3) Postgres 모드에서 companyCode 누락 시 400", async () => {
      const res = await api("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: "admin_a", pw: "TestPassword123" }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.ok, false);
    });

    await t.test("4) 회사별 token으로 GET /data — 본인 회사 데이터만 반환", async () => {
      const res = await api("/data", { headers: { Authorization: `Bearer ${companyAToken}` } });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.data.employees.length, 1);
      assert.equal(json.data.employees[0].loginId, "admin_a");
    });

    await t.test("4b) 인증 원본 조회 장애 시 서명 토큰을 fail-open하지 않고 503으로 거부", async () => {
      const faultClient = new Client({ connectionString: testDbUrl });
      await faultClient.connect();
      try {
        // 운영 DB를 건드리지 않는 이 테스트 전용 임시 DB에서만 employees를 잠시 숨겨,
        // 토큰 서명은 유효하지만 현재 active/authVersion/menuPerms를 조회할 수 없는 상태를
        // 재현한다. 과거 구현은 이 경우 stale token을 그대로 허용했다.
        await faultClient.query("ALTER TABLE employees RENAME TO employees_auth_state_test");
        const res = await api("/data", { headers: { Authorization: `Bearer ${companyAToken}` } });
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), {
          ok: false,
          code: "AUTH_STATE_UNAVAILABLE",
          message: "로그인 상태를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.",
        });
      } finally {
        await faultClient.query("ALTER TABLE IF EXISTS employees_auth_state_test RENAME TO employees");
        await faultClient.end();
      }

      // 장애가 사라지면 같은 토큰과 정상 PostgreSQL 인증 경로는 그대로 동작해야 한다.
      const recovered = await api("/data", { headers: { Authorization: `Bearer ${companyAToken}` } });
      assert.equal(recovered.status, 200);
      assert.equal((await recovered.json()).ok, true);
    });

    await t.test("4c) 전표 업무 쓰기와 멱등성 완료 기록은 같은 transaction에서 commit", async () => {
      const commonHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${companyAToken}` };
      const seeded = await api("/api/accounting/accounts/seed-defaults", {
        method: "POST", headers: commonHeaders, body: "{}",
      });
      assert.equal(seeded.status, 200);
      const accountRows = await (await api("/api/accounting/accounts/picker", {
        headers: { Authorization: `Bearer ${companyAToken}` },
      })).json();
      assert.ok(accountRows.accounts.length >= 2);
      const payload = {
        date: "2026-08-25", description: "멱등성 원자성 테스트",
        lines: [
          { accountId: accountRows.accounts[0].id, debit: 1000, credit: 0 },
          { accountId: accountRows.accounts[1].id, debit: 0, credit: 1000 },
        ],
      };
      const key = "pg-voucher-atomic-test-0001";

      // 업무 INSERT 뒤 멱등성 응답 기록 직전에 오류를 주입한다. 둘이 같은 transaction이면
      // 첫 요청의 voucher와 claim이 모두 rollback되어 같은 키 재시도가 정상 성공해야 한다.
      const failed = await api("/api/accounting/vouchers", {
        method: "POST",
        headers: { ...commonHeaders, "Idempotency-Key": key, "X-Test-Idempotency-Fail-Before-Complete": "1" },
        body: JSON.stringify(payload),
      });
      assert.equal(failed.status, 500);

      const succeeded = await api("/api/accounting/vouchers", {
        method: "POST", headers: { ...commonHeaders, "Idempotency-Key": key }, body: JSON.stringify(payload),
      });
      assert.equal(succeeded.status, 200);
      const firstBody = await succeeded.json();
      const replay = await api("/api/accounting/vouchers", {
        method: "POST", headers: { ...commonHeaders, "Idempotency-Key": key }, body: JSON.stringify(payload),
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.headers.get("x-idempotency-replayed"), "true");
      assert.deepEqual(await replay.json(), firstBody);

      const dbCheck = new Client({ connectionString: testDbUrl });
      await dbCheck.connect();
      try {
        const rows = await dbCheck.query("SELECT COUNT(*)::int AS count FROM vouchers WHERE data->>'description' = $1", [payload.description]);
        assert.equal(rows.rows[0].count, 1, "실패 요청이나 replay가 중복 전표를 만들면 안 됨");
      } finally { await dbCheck.end(); }
    });

    let companyBToken;
    await t.test("5) 두 번째 회사 가입 — 다른 companyCode 자동 배정", async () => {
      const res = await api("/api/companies/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: "테스트회사B", adminName: "관리자B", loginId: "admin_b", password: "TestPassword456" }),
      });
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.notEqual(json.companyCode, companyACode);
      companyBToken = json.token;
    });

    await t.test("6) 회사 간 데이터 격리 — B 토큰으로는 A의 직원이 보이지 않음", async () => {
      const res = await api("/data", { headers: { Authorization: `Bearer ${companyBToken}` } });
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.data.employees.length, 1);
      assert.equal(json.data.employees[0].loginId, "admin_b");
      assert.ok(!json.data.employees.some(e => e.loginId === "admin_a"), "회사 B의 응답에 회사 A 직원이 섞이면 안 됨");
    });

    await t.test("7) 회사 간 데이터 격리 — B가 A의 companyCode로 admin_a 계정 로그인 시도는 실패", async () => {
      const res = await api("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyCode: companyACode, loginId: "admin_b", pw: "TestPassword456" }),
      });
      const json = await res.json();
      assert.equal(json.ok, false, "회사 B 계정으로 회사 A의 companyCode를 대며 로그인하면 안 됨");
    });

    await t.test("7b) 서로 다른 서버 인스턴스의 동시 전체 저장도 두 변경을 모두 보존한다", async () => {
      serverB = await startServer({ env: { DATABASE_URL: testDbUrl } });
      const apiB = (p, opts) => fetch(serverB.baseUrl + p, opts);
      const [aStateRes, bStateRes] = await Promise.all([
        api("/data", { headers: { Authorization: `Bearer ${companyAToken}` } }),
        apiB("/data", { headers: { Authorization: `Bearer ${companyAToken}` } }),
      ]);
      const aState = await aStateRes.json();
      const bState = await bStateRes.json();
      assert.equal(aState.version, bState.version, "동시 편집 시작점은 같은 DB 버전이어야 함");

      const [saveA, saveB] = await Promise.all([
        api("/save", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${companyAToken}` },
          body: JSON.stringify({ _version: aState.version, boardPosts: [{ id: "parallel-a", title: "A 서버 저장", updatedAt: new Date().toISOString() }] }),
        }),
        apiB("/save", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${companyAToken}` },
          body: JSON.stringify({ _version: bState.version, boardPosts: [{ id: "parallel-b", title: "B 서버 저장", updatedAt: new Date().toISOString() }] }),
        }),
      ]);
      assert.equal(saveA.status, 200);
      assert.equal(saveB.status, 200);
      const finalState = await (await api("/data", { headers: { Authorization: `Bearer ${companyAToken}` } })).json();
      const ids = new Set((finalState.data.boardPosts || []).map(post => post.id));
      assert.ok(ids.has("parallel-a"), "A 인스턴스 변경이 유실되면 안 됨");
      assert.ok(ids.has("parallel-b"), "B 인스턴스 변경이 유실되면 안 됨");
    });

    await t.test("7b-2) 서로 다른 서버 인스턴스의 동시 복지포인트 사용은 잔액을 초과하지 않는다", async () => {
      const adminState = await (await api("/data", { headers: { Authorization: `Bearer ${companyAToken}` } })).json();
      const member = { id: 900001, loginId: "welfare_member", pw: "WelfarePassword123", role: "member", name: "복지동시성회원", empNo: "WF-900001", dept: "테스트", team: "QA", active: true, createdAt: "2097-01-01T00:00:00.000Z", updatedAt: "2097-01-01T00:00:00.000Z" };
      const grant = { id: "pg-wp-concurrency-grant", empId: member.id, points: 100000, type: "grant", year: 2097, desc: "동시성 검증 부여", date: "2097-01-01", by: adminState.data.employees[0].id };
      const seed = await api("/save", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${companyAToken}` },
        body: JSON.stringify({ _version: adminState.version, data: { ...adminState.data, employees: [...adminState.data.employees, member], welfarePoints: [...(adminState.data.welfarePoints || []), grant] } }),
      });
      assert.equal(seed.status, 200);
      const login = await (await api("/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyCode: companyACode, loginId: member.loginId, pw: member.pw }),
      })).json();
      assert.equal(login.ok, true);
      const apiB = (p, opts) => fetch(serverB.baseUrl + p, opts);
      const [stateA, stateB] = await Promise.all([
        api("/data", { headers: { Authorization: `Bearer ${login.token}` } }).then(r => r.json()),
        apiB("/data", { headers: { Authorization: `Bearer ${login.token}` } }).then(r => r.json()),
      ]);
      const makePayload = (state, id) => ({ _version: state.version, data: { ...state.data, welfarePoints: [...(state.data.welfarePoints || []), { id, empId: member.id, points: 70000, type: "use", year: 2097, desc: "동시 사용", date: "2097-02-01", by: member.id }] } });
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` };
      const [useA, useB] = await Promise.all([
        api("/save", { method: "POST", headers, body: JSON.stringify(makePayload(stateA, "pg-wp-use-a")) }),
        apiB("/save", { method: "POST", headers, body: JSON.stringify(makePayload(stateB, "pg-wp-use-b")) }),
      ]);
      assert.equal(useA.status, 200);
      assert.equal(useB.status, 200);
      const finalState = await (await api("/data", { headers: { Authorization: `Bearer ${companyAToken}` } })).json();
      const ledger = (finalState.data.welfarePoints || []).filter(r => String(r.empId) === String(member.id) && r.year === 2097);
      const granted = ledger.filter(r => r.type === "grant").reduce((sum, r) => sum + r.points, 0);
      const used = ledger.filter(r => r.type === "use").reduce((sum, r) => sum + r.points, 0);
      assert.equal(granted, 100000);
      assert.equal(used, 70000, "두 인스턴스의 70,000원 동시 사용 중 한 건만 반영돼야 함");
      assert.ok(granted - used >= 0);
    });

    await t.test("7c) 스냅샷 복원은 HR 삭제와 budget_store 교체를 함께 커밋한다", async () => {
      const dbCheck = new Client({ connectionString: testDbUrl });
      await dbCheck.connect();
      let companyAId;
      try {
        const company = await dbCheck.query("SELECT id FROM companies WHERE slug = $1", [companyACode]);
        companyAId = company.rows[0].id;
        await dbCheck.query(
          "INSERT INTO budget_store (company_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (company_id) DO UPDATE SET data = EXCLUDED.data",
          [companyAId, JSON.stringify({ restoreMarker: "snapshot", headcount: [], budget: [], businessPlans: [] })]
        );
      } finally {
        await dbCheck.end();
      }

      let res = await api("/snapshots", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${companyAToken}` },
        body: JSON.stringify({ year: 2098, confirmedBy: "QA", notes: "원자 복원 검증" }),
      });
      assert.equal(res.status, 200);

      const before = await (await api("/data", { headers: { Authorization: `Bearer ${companyAToken}` } })).json();
      res = await api("/save", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${companyAToken}` },
        body: JSON.stringify({
          _version: before.version,
          boardPosts: [...(before.data.boardPosts || []), { id: "restore-extra", title: "복원 뒤 삭제돼야 함", updatedAt: new Date().toISOString() }],
        }),
      });
      assert.equal(res.status, 200);

      const dbMutate = new Client({ connectionString: testDbUrl });
      await dbMutate.connect();
      try {
        await dbMutate.query("UPDATE budget_store SET data = $2::jsonb WHERE company_id = $1", [companyAId, JSON.stringify({ restoreMarker: "current", headcount: [], budget: [], businessPlans: [] })]);
      } finally {
        await dbMutate.end();
      }

      res = await api("/restore", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${companyAToken}` },
        body: JSON.stringify({ name: "snapshot_2098.json", fields: ["boardPosts", "budget"], deleteExtras: true }),
      });
      assert.equal(res.status, 200);
      const restored = await res.json();
      assert.equal(restored.ok, true);
      assert.ok(restored.restoredFields.includes("budget"));
      assert.ok(!restored.data.boardPosts.some(p => p.id === "restore-extra"), "deleteExtras가 snapshot 이후 게시글을 지워야 함");

      const dbVerify = new Client({ connectionString: testDbUrl });
      await dbVerify.connect();
      try {
        const budget = await dbVerify.query("SELECT data FROM budget_store WHERE company_id = $1", [companyAId]);
        assert.equal(budget.rows[0].data.restoreMarker, "snapshot", "budget_store도 동일 복원 트랜잭션에 포함돼야 함");
      } finally {
        await dbVerify.end();
      }
    });

    // POST /api/reset-all이 employees/kpi_entries만 지우고 app_collections/app_singletons
    // (approvalDocs·attendanceRecords·settings·orgDB 등, lib/collections.js의 GENERIC_LIST_
    // FIELDS/SINGLETON_FIELDS)는 그대로 남겨두고 있었다(2026-08-19 외부 감사 P1) — JSON 파일
    // 모드는 _fileStore 객체 전체를 교체해 이 필드들이 자연히 함께 비워지는데 Postgres
    // 모드는 별도 테이블이라 빠져 있었다. 두 회사(A/B)를 만들어 둘 다 boardPosts/settings를
    // 심고, A만 초기화한 뒤 A는 완전히 비고 B는 전혀 영향받지 않음을 확인한다(멀티테넌트
    // 격리가 이 파괴적 삭제에도 지켜지는지가 핵심).
    await t.test("8) POST /api/reset-all — app_collections/app_singletons까지 완전히 비우고, 다른 회사는 그대로 유지", async () => {
      let res = await api("/data", { headers: { Authorization: `Bearer ${companyAToken}` } });
      let json = await res.json();
      const versionA = json.version;
      const empIdA = json.data.employees[0].id;
      res = await api("/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${companyAToken}` },
        body: JSON.stringify({ _version: versionA, boardPosts: [{ id: "p1", title: "회사A 게시글", authorId: empIdA }], settings: { welcomeMsg: "회사A 설정" } }),
      });
      assert.equal(res.status, 200, "회사 A 시드 실패");

      res = await api("/data", { headers: { Authorization: `Bearer ${companyBToken}` } });
      json = await res.json();
      const versionB = json.version;
      const empIdB = json.data.employees[0].id;
      res = await api("/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${companyBToken}` },
        body: JSON.stringify({ _version: versionB, boardPosts: [{ id: "p2", title: "회사B 게시글", authorId: empIdB }], settings: { welcomeMsg: "회사B 설정" } }),
      });
      assert.equal(res.status, 200, "회사 B 시드 실패");

      // 외부 세션이 회사별 full-state advisory lock을 잠시 잡은 동안 /save를 먼저
      // 시작하고 reset을 뒤이어 보낸다. 같은 서버의 save mutex 때문에 reset은 save가
      // 끝날 때까지 대기해야 하며, 최종 상태는 반드시 reset 결과(빈 상태)여야 한다.
      // reset이 save lock에 참여하지 않으면 두 요청이 서로 인터리빙해 삭제한 데이터가
      // 다시 나타나거나 data_version 캐시가 DB와 달라질 수 있다.
      const raceState = await (await api("/data", { headers: { Authorization: `Bearer ${companyAToken}` } })).json();
      const lockClient = new Client({ connectionString: testDbUrl });
      await lockClient.connect();
      const companyRowForLock = await lockClient.query("SELECT id FROM companies WHERE slug = $1", [companyACode]);
      const companyAIdForLock = companyRowForLock.rows[0].id;
      const lockKey = `full-state-save:${companyAIdForLock}`;
      await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
      let savePromise, resetPromise;
      try {
        savePromise = api("/save", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${companyAToken}` },
          body: JSON.stringify({
            _version: raceState.version,
            boardPosts: [...(raceState.data.boardPosts || []), { id: "reset-race", title: "초기화와 경합", authorId: empIdA, updatedAt: new Date().toISOString() }],
          }),
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        resetPromise = api("/api/reset-all", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${companyAToken}` },
          body: JSON.stringify({ loginId: "admin_a", pw: "TestPassword123" }),
        });
        await new Promise(resolve => setTimeout(resolve, 100));
      } finally {
        await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
        await lockClient.end();
      }
      const [saveRes, resetRes] = await Promise.all([savePromise, resetPromise]);
      assert.equal(saveRes.status, 200, "경합 저장 실패");
      json = await resetRes.json();
      assert.equal(json.ok, true, "reset-all 실패: " + JSON.stringify(json));

      const dbCheck = new Client({ connectionString: testDbUrl });
      await dbCheck.connect();
      try {
        const companyRow = await dbCheck.query("SELECT id FROM companies WHERE slug = $1", [companyACode]);
        const companyAId = companyRow.rows[0].id;
        const empCount = (await dbCheck.query("SELECT COUNT(*) FROM employees WHERE company_id = $1", [companyAId])).rows[0].count;
        const collCount = (await dbCheck.query("SELECT COUNT(*) FROM app_collections WHERE company_id = $1", [companyAId])).rows[0].count;
        const singCount = (await dbCheck.query("SELECT COUNT(*) FROM app_singletons WHERE company_id = $1", [companyAId])).rows[0].count;
        assert.equal(Number(empCount), 0, "회사 A의 employees가 완전히 비어야 함");
        assert.equal(Number(collCount), 0, "회사 A의 app_collections가 완전히 비어야 함(boardPosts 등)");
        assert.equal(Number(singCount), 0, "회사 A의 app_singletons이 완전히 비어야 함(settings 등)");
      } finally {
        await dbCheck.end();
      }

      res = await api("/data", { headers: { Authorization: `Bearer ${companyBToken}` } });
      json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.data.employees.length, 1, "회사 A 초기화가 회사 B의 employees에 영향을 주면 안 됨");
      assert.equal(json.data.boardPosts.length, 1, "회사 A 초기화가 회사 B의 boardPosts에 영향을 주면 안 됨");
      assert.equal(json.data.settings.welcomeMsg, "회사B 설정", "회사 A 초기화가 회사 B의 settings에 영향을 주면 안 됨");
    });
  });

  // rejectDemoDataForProduction()의 부팅 시점(initDB()) 검사는 처음엔 JSON 파일 모드
  // 분기에만 있었고 Postgres 분기에는 없었다 — 그런데 실제 운영 배포는 정확히 이 Postgres
  // 분기를 타므로, 그 보호가 진짜 서비스에는 전혀 적용되지 않는 사각지대였다(발견 즉시
  // Postgres 분기에도 동일하게 배선). employees/kpi_entries 테이블에 더미 마커가 있는
  // 상태로 DB가 시작되면(예: 개발 DB를 실수로 운영에 연결) production 부팅이 fail-fast
  // 해야 한다는 것을 실제 DB에 직접 행을 심어 검증한다.
  test("postgres-mode: 부팅 시점 fail-fast(DB에 이미 더미 마커가 있는 상태에서 production 부팅)", async (t) => {
    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    t.after(() => admin.end());

    async function withFreshDb(fn) {
      const dbName = `hrtest_bootfail_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      const dbUrl = _withDatabaseName(ADMIN_DATABASE_URL, dbName);
      await admin.query(`CREATE DATABASE ${dbName}`);
      try {
        await fn(dbUrl, dbName);
      } finally {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [dbName]
        );
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      }
    }

    // schema.sql을 미리 적용하고(회사/직원을 직접 INSERT하려면 스키마가 있어야 함) 데모
    // 마커가 섞인 행을 심은 뒤, 그 DB를 가리키는 production 서버가 부팅을 거부하는지 확인.
    async function seedDemoDataAndExpectBootFailure(seedFn) {
      await withFreshDb(async (dbUrl, dbName) => {
        const db = new Client({ connectionString: dbUrl });
        await db.connect();
        const schema = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "schema.sql"), "utf8");
        await db.query(schema);
        await db.query(
          "INSERT INTO companies (id, slug, name, status) VALUES ('11111111-1111-1111-1111-111111111111', $1, 'QA Test Co', 'active')",
          [dbName]
        );
        await seedFn(db);
        await db.end();

        const result = await startServerExpectingBootFailure({ env: { NODE_ENV: "production", DATABASE_URL: dbUrl } });
        assert.notEqual(result.exitCode, 0, "더미 마커가 있는 DB로 production 부팅은 실패해야 함");
        assert.match(result.logs.stderr + result.logs.stdout, /더미 데이터/);
        result.cleanup();
      });
    }

    await t.test("source:\"demo\" 직원이 이미 DB에 있으면 부팅이 실패한다", async () => {
      await seedDemoDataAndExpectBootFailure(async (db) => {
        await db.query(
          "INSERT INTO employees (id, data, company_id) VALUES ('e1', $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "e1", loginId: "admin", name: "관리자", role: "admin", active: true })]
        );
        await db.query(
          "INSERT INTO employees (id, data, company_id) VALUES ('e2', $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "e2", loginId: "demo1", name: "데모직원", role: "member", active: true, source: "demo", empNo: "DEMO-0002" })]
        );
      });
    });

    await t.test("레거시 DM 패턴 empNo가 이미 DB에 있으면 부팅이 실패한다", async () => {
      await seedDemoDataAndExpectBootFailure(async (db) => {
        await db.query(
          "INSERT INTO employees (id, data, company_id) VALUES ('e1', $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "e1", loginId: "admin", name: "관리자", role: "admin", active: true })]
        );
        await db.query(
          "INSERT INTO employees (id, data, company_id) VALUES ('e3', $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "e3", loginId: "dummy1", name: "홍길동", role: "member", active: true, empNo: "DM경인001" })]
        );
      });
    });

    await t.test("KPI만 더미인 경우도 부팅이 실패한다", async () => {
      await seedDemoDataAndExpectBootFailure(async (db) => {
        await db.query(
          "INSERT INTO employees (id, data, company_id) VALUES ('e1', $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "e1", loginId: "admin", name: "관리자", role: "admin", active: true })]
        );
        await db.query(
          "INSERT INTO kpi_entries (id, employee_id, eval_year, data, company_id) VALUES ('k1', 'e1', 2025, $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "k1", source: "demo" })]
        );
      });
    });

    await t.test("더미 마커 없는 정상 데이터는 production에서도 정상 부팅된다(false positive 아님)", async () => {
      await withFreshDb(async (dbUrl, dbName) => {
        const db = new Client({ connectionString: dbUrl });
        await db.connect();
        const schema = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "schema.sql"), "utf8");
        await db.query(schema);
        await db.query(
          "INSERT INTO companies (id, slug, name, status) VALUES ('11111111-1111-1111-1111-111111111111', $1, 'QA Test Co', 'active')",
          [dbName]
        );
        await db.query(
          "INSERT INTO employees (id, data, company_id) VALUES ('e1', $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "e1", loginId: "admin", name: "관리자", role: "admin", active: true })]
        );
        await db.end();

        const server = await startServer({ env: { NODE_ENV: "production", DATABASE_URL: dbUrl } });
        try {
          const res = await fetch(server.baseUrl + "/status");
          assert.equal(res.status, 200);
        } finally {
          await server.stop();
        }
      });
    });
  });
}

function _withDatabaseName(connStr, dbName) {
  const u = new URL(connStr);
  u.pathname = `/${dbName}`;
  return u.toString();
}
