"use strict";
// 품목·창고(활성 마스터)의 동시 수정 보호 — expectedUpdatedAt 낙관적 락(JSON/PostgreSQL).
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

async function scenario(baseUrl, token, tag, legacyInsert) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const post = async (path, body) => {
    const res = await fetch(baseUrl + path, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  for (const [route, key, payload] of [
    ["items", "item", { code: `${tag}-I`, name: "원본 품목", unit: "EA" }],
    ["locations", "location", { name: `${tag}-원본 창고` }],
  ]) {
    const created = await post(`/api/erp/${route}`, payload);
    assert.equal(created.status, 200);
    const rec = created.json[key];
    assert.ok(rec.updatedAt, "저장 시 updatedAt이 기록된다");

    // 최신 revision으로 수정 → 성공, updatedAt 갱신
    await new Promise(r => setTimeout(r, 5));
    const edit1 = await post(`/api/erp/${route}`, { ...payload, id: rec.id, name: "수정 1", expectedUpdatedAt: rec.updatedAt });
    assert.equal(edit1.status, 200, JSON.stringify(edit1.json));
    assert.notEqual(edit1.json[key].updatedAt, rec.updatedAt);

    // 같은 옛 revision으로 한 번 더 → 409(최신본 포함)
    const stale = await post(`/api/erp/${route}`, { ...payload, id: rec.id, name: "수정 2(옛 화면)", expectedUpdatedAt: rec.updatedAt });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, "ERP_MASTER_CONFLICT");
    assert.equal(stale.json.latest.name, "수정 1");

    // revision 없이 기존 레코드 수정 → 428
    const missing = await post(`/api/erp/${route}`, { ...payload, id: rec.id, name: "수정 3" });
    assert.equal(missing.status, 428);
    assert.equal(missing.json.code, "ERP_REVISION_REQUIRED");

    // 같은 revision으로 동시에 두 번 수정 → 정확히 하나만 성공
    const cur = edit1.json[key];
    const [a, b] = await Promise.all([
      post(`/api/erp/${route}`, { ...payload, id: rec.id, name: "동시 A", expectedUpdatedAt: cur.updatedAt }),
      post(`/api/erp/${route}`, { ...payload, id: rec.id, name: "동시 B", expectedUpdatedAt: cur.updatedAt }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);

    // 새 레코드(id를 직접 지정)는 revision 없이 등록된다
    const fresh = await post(`/api/erp/${route}`, { ...payload, id: `${tag}-${route}-new`, name: "새 레코드" });
    assert.equal(fresh.status, 200);
  }
  if (legacyInsert) await legacyInsert(); // 레거시(updatedAt 없는) 행은 빈 revision으로 수정할 수 있다
}

test("품목·창고 수정의 낙관적 락 (JSON)", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { token } = await bootstrapAdminAndLogin(server, { loginId: "revadmin", pw: "RevisionPassw0rd!" });
  await scenario(server.baseUrl, token, "RJ");
});

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("품목·창고 수정의 낙관적 락 — PostgreSQL (skipped: no test DB)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");
  test("품목·창고 수정의 낙관적 락 — PostgreSQL", async t => {
    const dbName = `hrtest_erp_rev_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const base = ADMIN_DATABASE_URL.replace(/\/[^/]*(\?.*)?$/, "");
    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    let server, db;
    t.after(async () => {
      try {
        if (db) await db.end().catch(() => {});
        if (server) await server.stop();
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [dbName]);
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally { await admin.end(); }
    });
    server = await startServer({ env: { DATABASE_URL: `${base}/${dbName}` } });
    const reg = await (await fetch(server.baseUrl + "/api/companies/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "락 회사", adminName: "관리자", loginId: "rv_admin", password: "AdminPassw0rd1" }),
    })).json();
    if (!reg.ok) throw new Error(JSON.stringify(reg));
    await scenario(server.baseUrl, reg.token, "RP");

    // 레거시 행(updatedAt 없음)은 빈 revision("")으로 수정할 수 있다.
    db = new Client({ connectionString: `${base}/${dbName}` });
    await db.connect();
    const co = (await db.query("SELECT id FROM companies LIMIT 1")).rows[0].id;
    await db.query("INSERT INTO erp_items (id, company_id, data) VALUES ('legacy-item', $1, $2)", [co, { id: "legacy-item", code: "LEG", name: "레거시", unit: "EA" }]);
    const headers = { Authorization: `Bearer ${reg.token}`, "Content-Type": "application/json" };
    const ok = await fetch(server.baseUrl + "/api/erp/items", { method: "POST", headers, body: JSON.stringify({ id: "legacy-item", code: "LEG", name: "레거시 수정", expectedUpdatedAt: "" }) });
    assert.equal(ok.status, 200);
    const again = await fetch(server.baseUrl + "/api/erp/items", { method: "POST", headers, body: JSON.stringify({ id: "legacy-item", code: "LEG", name: "또 수정", expectedUpdatedAt: "" }) });
    assert.equal(again.status, 409); // 이제 updatedAt이 생겼으므로 빈 revision은 옛 값
  });
}
