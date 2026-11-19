"use strict";
// 퇴직 면담(exitInterviews): 관리자 전용 기록 — 쓰기·조회·삭제 권한과 값 검증을 JSON 파일 모드와 PostgreSQL 양쪽에서 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const auth = (token, method, body) => ({
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

async function scenario(t, { api, adminToken, loginUser }) {
  const getData = async token => (await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json());
  const save = async (token, body) => {
    const d = await getData(token);
    return (await api("/save", auth(token, "POST", { _version: d.version, ...body }))).json();
  };
  const list = async token => (await getData(token)).data.exitInterviews || [];
  const find = async (token, id) => (await list(token)).find(r => r.id === id);

  const d = await getData(adminToken);
  assert.equal((await save(adminToken, { employees: [...d.data.employees,
    { id: "mem1", loginId: "mem1", pw: "mem-pw-123456", name: "홍길동", role: "member", active: false, retireDate: "2026-10-01", dept: "영업본부", team: "A팀" },
    { id: "mem2", loginId: "mem2", pw: "mem-pw-123456", name: "재직직원", role: "member", active: true, dept: "영업본부", team: "A팀" },
    { id: "dir1", loginId: "dir1", pw: "mem-pw-123456", name: "이사", role: "director", active: true, dept: "영업본부", team: "" }] })).ok, true);
  const memToken = await loginUser("mem2");
  const dirToken = await loginUser("dir1");

  const iv = (id, extra = {}) => ({ id, empId: "mem1", empName: "홍길동", status: "done", interviewDate: "2026-10-05", retireDate: "2026-10-01",
    reasonCategory: "growth", reasonDetail: "성장 기회 부족", satisfaction: 3, wouldRecommend: "yes", rehireEligible: "hold", feedback: "교육 지원 확대", ...extra });

  await t.test("관리자는 퇴직 면담을 기록·수정할 수 있다", async () => {
    assert.equal((await save(adminToken, { exitInterviews: [iv("x1")] })).ok, true);
    assert.equal((await find(adminToken, "x1")).reasonCategory, "growth");
    await save(adminToken, { exitInterviews: [{ ...(await find(adminToken, "x1")), reasonCategory: "pay", satisfaction: 4 }] });
    const r = await find(adminToken, "x1");
    assert.equal(r.reasonCategory, "pay");
    assert.equal(r.satisfaction, 4);
  });

  await t.test("관리자가 아니면 조회할 수 없고, 생성·수정·삭제도 막힌다(일반 직원·사업부장)", async () => {
    for (const token of [memToken, dirToken]) {
      assert.equal((await list(token)).length, 0);
      await save(token, { exitInterviews: [iv("forged")] });
      const orig = await find(adminToken, "x1");
      await save(token, { exitInterviews: [{ ...orig, reasonDetail: "조작" }] });
      await save(token, { recordTombstones: { exitInterviews: [{ id: "x1", ts: Date.now() }] } });
    }
    assert.equal(await find(adminToken, "forged"), undefined);
    const kept = await find(adminToken, "x1");
    assert.ok(kept, "관리자 기록은 그대로 남아야 한다");
    assert.equal(kept.reasonDetail, "성장 기회 부족");
  });

  await t.test("값 검증: 잘못된 사유·만족도·날짜, 완료인데 사유가 없는 기록은 저장되지 않는다", async () => {
    await save(adminToken, { exitInterviews: [
      iv("bad1", { reasonCategory: "weird" }), iv("bad2", { satisfaction: 9 }), iv("bad3", { interviewDate: "2026-13-40" }),
      iv("bad4", { reasonCategory: "" }), iv("bad5", { empId: "" }), iv("bad6", { rehireEligible: "maybe" }),
    ] });
    for (const id of ["bad1", "bad2", "bad3", "bad4", "bad5", "bad6"]) assert.equal(await find(adminToken, id), undefined, id);
    // 예정 상태는 사유 없이도 저장된다
    await save(adminToken, { exitInterviews: [iv("sched", { status: "scheduled", reasonCategory: "", satisfaction: null, wouldRecommend: "", rehireEligible: "" })] });
    assert.equal((await find(adminToken, "sched")).status, "scheduled");
  });

  await t.test("관리자는 기록을 삭제할 수 있다", async () => {
    await save(adminToken, { recordTombstones: { exitInterviews: [{ id: "sched", ts: Date.now() }] } });
    assert.equal(await find(adminToken, "sched"), undefined);
  });
}

test("퇴직 면담 — JSON 파일 모드", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const admin = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin-pw-123456", name: "관리자" });
  await scenario(t, { api, adminToken: admin.token,
    loginUser: async loginId => (await (await api("/login", auth(null, "POST", { loginId, pw: "mem-pw-123456" }))).json()).token });
});

if (!ADMIN_DATABASE_URL) {
  test("퇴직 면담 — PostgreSQL (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  test("퇴직 면담 — 실제 PostgreSQL 모드", async t => {
    const { Client } = require("pg");
    const dbName = `hrtest_exit_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    t.after(async () => {
      try {
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [dbName]);
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally { await admin.end(); }
    });
    const base = ADMIN_DATABASE_URL.replace(/\/[^/]*(\?.*)?$/, "");
    const server = await startServer({ env: { DATABASE_URL: `${base}/${dbName}` } });
    t.after(() => server.stop());
    const api = (path, options) => fetch(server.baseUrl + path, options);
    const reg = await (await api("/api/companies/register", auth(null, "POST", { companyName: "면담테스트", adminName: "관리자", loginId: "admin", password: "TestPassword123" }))).json();
    assert.equal(reg.ok, true);
    await scenario(t, { api, adminToken: reg.token,
      loginUser: async loginId => (await (await api("/login", auth(null, "POST", { loginId, pw: "mem-pw-123456", companyCode: reg.companyCode }))).json()).token });
  });
}
