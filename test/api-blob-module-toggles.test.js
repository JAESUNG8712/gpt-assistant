"use strict";

// company_features로 "전자결재/커뮤니케이션/KPI/역량평가/인재관리/인사관리" 등 별도
// REST API가 없는(GET /data·POST /save로 통째 오가는 blob 컬렉션) 모듈을 껐을 때:
// (1) GET /data 응답에서 그 컬렉션이 빈 값으로 감춰지고, (2) POST /save로 그 컬렉션에
// 쓰기를 시도해도 서버에 반영되지 않으며, (3) 다시 켜면 정상적으로 조회·저장이 됨을
// 실제 PostgreSQL로 검증한다. company_features는 Postgres 전용 개념이라 DATABASE_URL이
// 없으면 건너뛴다.
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { Client } = require("pg");
const { startServer } = require("./support/start-server");

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!ADMIN_DATABASE_URL) {
  test("blob 모듈 on/off 토글 (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  test("blob 동기화 모듈(전자결재/게시판/KPI/역량평가/인재관리/조직도이력) on/off 토글", async (t) => {
    const dbName = `hrtest_blobtoggle_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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

    const db = new Client({ connectionString: testDbUrl });
    db.on("error", () => {});
    await db.connect();
    const masterPwHash = await bcrypt.hash("master-test-pw-12345", 10);
    await db.query(`INSERT INTO platform_admins (login_id, pw_hash, name) VALUES ($1,$2,$3)`, ["master_test", masterPwHash, "테스트 마스터"]);
    await db.end();

    const reg = await (await api("/api/companies/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "블롭토글", adminName: "관리자", loginId: "admin_x", password: "TestPassword123" }),
    })).json();
    assert.equal(reg.ok, true);
    const hdr = { Authorization: `Bearer ${reg.token}` };

    const masterLogin = await (await api("/master/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "master_test", password: "master-test-pw-12345" }),
    })).json();
    const hdrM = { Authorization: `Bearer ${masterLogin.token}` };

    async function setFeature(key, enabled) {
      const r = await (await api(`/master/companies/${reg.company.id}/features/${key}`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...hdrM },
        body: JSON.stringify({ enabled }),
      })).json();
      assert.equal(r.ok, true);
    }
    async function getData() {
      const r = await (await api("/data", { headers: hdr })).json();
      assert.equal(r.ok, true);
      return r;
    }
    async function save(version, patch) {
      return (await api("/save", {
        method: "POST", headers: { "Content-Type": "application/json", ...hdr },
        body: JSON.stringify({ _version: version, data: patch }),
      })).json();
    }
    // _recordCasVersion은 body 최상위 필드로만 인식된다(POST /save의 clientData 조립부
    // 참고) — 위 save()는 이를 보내지 않으므로 CAS 관련 테스트는 별도 헬퍼를 쓴다.
    async function saveCas(version, patch) {
      return (await api("/save", {
        method: "POST", headers: { "Content-Type": "application/json", ...hdr },
        body: JSON.stringify({ _version: version, data: patch, _recordCasVersion: 1 }),
      })).json();
    }

    // 모듈별로 실제 대표 컬렉션 하나씩 골라 쓰기+조회 왕복 검증. id는 매번 새로 만들어
    // 이전 케이스의 잔여 레코드와 충돌하지 않게 한다.
    const moduleFieldCases = [
      { feature: "approval", field: "approvalDocs", sample: (id) => ({ id, title: "결재문서", status: "draft" }) },
      { feature: "comm", field: "boardPosts", sample: (id) => ({ id, title: "공지", authorId: "1" }) },
      { feature: "kpi", field: "kpiEntries", sample: (id) => ({ id, userId: "1", year: 2026, item: "목표" }) },
      { feature: "comp_eval", field: "compSessions", sample: (id) => ({ id, year: 2026 }) },
      { feature: "talent", field: "coreTalentPool", sample: (id) => ({ id, empId: "1" }) },
      { feature: "hr", field: "orgChartHistory", sample: (id) => ({ id, note: "조직개편" }) },
    ];

    for (const c of moduleFieldCases) {
      await t.test(`${c.feature} 모듈(${c.field}) — 켜져 있을 땐 정상 저장·조회, 끄면 GET에서 숨겨지고 저장이 반영 안 됨, 다시 켜면 복구`, async () => {
        const before = await getData();
        const version0 = before.version;
        const recordId = `rec_${c.field}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
        const rec = c.sample(recordId);

        // 1) 모듈 활성 상태에서 정상 저장 확인
        const saved = await save(version0, { [c.field]: [...(before.data[c.field] || []), rec] });
        assert.equal(saved.ok, true, `정상 저장 실패: ${JSON.stringify(saved)}`);
        const afterSave = await getData();
        assert.ok((afterSave.data[c.field] || []).some(r => r.id === recordId), `${c.field}에 저장된 레코드가 조회에 없음`);

        // 2) 모듈 비활성화 — GET /data에서 그 필드가 빈 배열로 감춰짐
        await setFeature(c.feature, false);
        const hidden = await getData();
        assert.deepEqual(hidden.data[c.field], [], `${c.field}가 비활성 상태에서 숨겨지지 않음`);

        // 3) 비활성 상태에서 새 레코드를 저장 시도해도 서버에 반영되지 않음(다른 무관한
        // 필드는 정상 저장돼야 함 — 요청 전체가 거부되는 게 아니라 이 필드만 무시됨을 확인).
        const recordId2 = `${recordId}_blocked`;
        const blockedSave = await save(hidden.version, {
          [c.field]: [rec, c.sample(recordId2)],
          settings: { ...(hidden.data.settings || {}), _toggleTestMarker: recordId2 },
        });
        assert.equal(blockedSave.ok, true, "쓰기 자체는 401/403이 아니라 조용히 무시되어야 함(다른 필드는 정상 저장)");

        // 4) 다시 켜서 확인 — 비활성 중 시도했던 레코드는 저장되지 않았어야 하고(진짜
        // 데이터 유실 방지 관점에서, 오히려 "저장 안 됨"이 올바른 동작), 무관한 settings
        // 변경은 정상 반영됐어야 한다(module 게이트가 요청 전체를 막지 않는다는 증거).
        await setFeature(c.feature, true);
        const restored = await getData();
        assert.ok((restored.data[c.field] || []).some(r => r.id === recordId), "모듈을 다시 켰는데 기존 레코드가 사라짐(데이터 유실)");
        assert.equal((restored.data[c.field] || []).some(r => r.id === recordId2), false, "비활성 중 저장 시도한 레코드가 실제로 저장돼버림(게이트 실패)");
        assert.equal(restored.data.settings._toggleTestMarker, recordId2, "비활성 모듈과 무관한 settings 저장까지 함께 막힘(과잉차단)");
      });
    }

    await t.test("record-CAS(_recordCasVersion:1)와 모듈 비활성화 상호작용 — 비활성 모듈의 stale _rev가 무관한 저장까지 409로 막지 않는다", async () => {
      // 병행 세션 감사(2026-08-26)에서 발견: _applyRecordCas()가 _revertDisabledFeatureFields()
      // 보다 먼저 실행돼, kpi 모듈을 끈 뒤 stale _rev로 kpiEntries를 담아 보내는 저장이
      // (원래는 모듈 비활성화로 조용히 무시됐어야 할 필드인데도) RECORD_REVISION_CONFLICT
      // 409를 던져 같은 요청에 실린 무관한 boardPosts 변경까지 함께 막던 문제.
      const before = await getData();
      const kpiId = `cas_kpi_${Date.now()}`;
      const original = { id: kpiId, userId: "1", year: 2026, item: "원본목표" };

      // 1) kpi 활성 상태에서 CAS로 최초 생성 — 서버가 _rev=1을 부여한다.
      const created = await saveCas(before.version, { kpiEntries: [...(before.data.kpiEntries || []), original] });
      assert.equal(created.ok, true, `최초 저장 실패: ${JSON.stringify(created)}`);
      assert.equal(created.recordRevisions.kpiEntries[kpiId], 1, "신규 레코드는 _rev=1이어야 함");

      // 2) kpi 모듈 비활성화
      await setFeature("kpi", false);
      const disabled = await getData();

      // 3) stale _rev(0, 실제는 1)로 kpiEntries를 수정 시도 + 전혀 무관한 boardPosts 추가를
      // 같은 요청에 함께 실어 보낸다. updatedAt을 미래로 찍어야 "수정 시도"로 판정되어
      // CAS 비교 대상에 오른다(_applyRecordCas의 timestamp 비교 로직 참고).
      const staleEdit = { ...original, item: "비활성모듈에서시도한수정", updatedAt: new Date(Date.now() + 60000).toISOString(), _rev: 0 };
      const boardPostId = `cas_board_${Date.now()}`;
      const mixedSave = await saveCas(disabled.version, {
        kpiEntries: [staleEdit],
        boardPosts: [...(disabled.data.boardPosts || []), { id: boardPostId, title: "무관한 정상 변경", authorId: "1" }],
      });
      assert.equal(mixedSave.ok, true, "비활성 모듈의 stale CAS가 전체 요청을 409로 막으면 안 됨(수정 전이라면 여기서 실패)");

      // 4) 무관한 boardPosts 변경은 반영되고, kpi 모듈을 다시 켰을 때 원본 kpiEntries는
      // 그대로(수정 시도는 무시됨) 남아있어야 한다 — 충돌 에러도, 잘못된 반영도 아님.
      const afterMixed = await getData();
      assert.ok((afterMixed.data.boardPosts || []).some(p => p.id === boardPostId), "무관한 boardPosts 변경이 함께 유실됨");

      await setFeature("kpi", true);
      const restored = await getData();
      const restoredKpi = (restored.data.kpiEntries || []).find(k => k.id === kpiId);
      assert.ok(restoredKpi, "kpi 모듈을 다시 켰는데 원본 레코드가 사라짐");
      assert.equal(restoredKpi.item, "원본목표", "비활성 모듈 중 시도한 수정이 반영돼버림(모듈 게이트 실패)");
    });

    await t.test("employees(hr 모듈이 꺼져도 대상 아님) — 로그인·직원목록 조회는 계속 정상 동작", async () => {
      await setFeature("hr", false);
      const r = await getData();
      assert.ok(Array.isArray(r.data.employees) && r.data.employees.length > 0, "hr 모듈을 꺼도 employees 자체는 계속 보여야 함(로그인/조직 기반 데이터)");
      await setFeature("hr", true);
    });
  });
}
