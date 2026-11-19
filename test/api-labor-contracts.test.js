"use strict";
// 근로계약 전자서명(laborContracts): 관리자가 작성·발송, 직원은 본인 계약에만 서명/거절.
// 서버가 상태 전이·내용 불변·본인 확인·삭제 제한을 강제하는지 JSON 파일 모드와 PostgreSQL 양쪽에서 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const auth = (token, method, body) => ({
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function scenario(t, { api, adminToken, loginMember }) {
  const getData = async token => (await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json());
  const save = async (token, body, extra = {}) => {
    const d = await getData(token);
    return (await api("/save", auth(token, "POST", { _version: d.version, ...body, ...extra }))).json();
  };
  const contractsOf = async token => (await getData(token)).data.laborContracts || [];
  const find = async (token, id) => (await contractsOf(token)).find(c => c.id === id);

  let d = await getData(adminToken);
  const employees = [...d.data.employees,
    { id: "mem1", loginId: "mem1", pw: "mem-pw-123456", name: "홍길동", role: "member", active: true, dept: "영업본부", team: "A팀" },
    { id: "mem2", loginId: "mem2", pw: "mem-pw-123456", name: "김철수", role: "member", active: true, dept: "영업본부", team: "A팀" }];
  assert.equal((await save(adminToken, { employees })).ok, true);
  const mem1 = await loginMember("mem1");
  const mem2 = await loginMember("mem2");

  const draft = (id, empId, extra = {}) => ({ id, empId, title: "근로계약서", contractType: "정규직", startDate: "2027-01-01", endDate: "", content: "제1조 (목적) 본 계약은...", status: "draft", ...extra });

  await t.test("관리자가 작성한 계약은 작성중에는 본인에게도 보이지 않는다", async () => {
    assert.equal((await save(adminToken, { laborContracts: [draft("lc1", "mem1"), draft("lc2", "mem2")] })).ok, true);
    assert.equal((await contractsOf(adminToken)).length, 2);
    assert.equal((await contractsOf(mem1)).length, 0);
  });

  await t.test("직원은 계약을 만들거나 작성중 계약을 고칠 수 없다", async () => {
    await save(mem1, { laborContracts: [draft("lc-forged", "mem1", { status: "sent" })] });
    assert.equal(await find(adminToken, "lc-forged"), undefined);
    await save(mem1, { laborContracts: [draft("lc1", "mem1", { title: "조작", status: "signed", signatureName: "홍길동" })] });
    const c = await find(adminToken, "lc1");
    assert.equal(c.title, "근로계약서");
    assert.equal(c.status, "draft");
  });

  await t.test("발송하면 내용 해시가 기록되고 본인에게만 보이며, 발송 후 내용은 바꿀 수 없다", async () => {
    const lc1 = await find(adminToken, "lc1");
    assert.equal((await save(adminToken, { laborContracts: [{ ...lc1, status: "sent" }, { ...(await find(adminToken, "lc2")), status: "sent" }] })).ok, true);
    const sent = await find(adminToken, "lc1");
    assert.equal(sent.status, "sent");
    assert.match(sent.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(sent.sentAt);
    assert.equal(sent.history.at(-1).action, "sent");
    const own = await contractsOf(mem1);
    assert.deepEqual(own.map(c => c.id), ["lc1"]);
    // 발송 후 본문 수정 시도는 무시된다
    await save(adminToken, { laborContracts: [{ ...sent, content: "몰래 바꾼 내용" }] });
    assert.equal((await find(adminToken, "lc1")).content, "제1조 (목적) 본 계약은...");
  });

  await t.test("서명은 본인 이름·본인 계약·정상 서명 이미지일 때만 되고 내용은 그대로 유지된다", async () => {
    const own = await find(mem1, "lc1");
    await save(mem1, { laborContracts: [{ ...own, status: "signed", signatureName: "다른사람" }] });
    assert.equal((await find(mem1, "lc1")).status, "sent");
    await save(mem1, { laborContracts: [{ ...own, status: "signed", signatureName: "홍길동", signatureData: "data:image/png;base64,<script>" }] });
    assert.equal((await find(mem1, "lc1")).status, "sent");
    // 다른 직원 계약 서명 시도
    const other = await find(adminToken, "lc2");
    await save(mem1, { laborContracts: [{ ...other, status: "signed", signatureName: "홍길동" }] });
    assert.equal((await find(adminToken, "lc2")).status, "sent");
    // 정상 서명(제목을 함께 조작해도 무시)
    await save(mem1, { laborContracts: [{ ...own, title: "조작", status: "signed", signatureName: "홍길동", signatureData: PNG }] });
    const signed = await find(adminToken, "lc1");
    assert.equal(signed.status, "signed");
    assert.equal(signed.title, "근로계약서");
    assert.equal(signed.signatureName, "홍길동");
    assert.equal(signed.signedHash, signed.contentHash);
    assert.ok(signed.signedAt);
    assert.equal(signed.history.at(-1).action, "signed");
  });

  await t.test("서명된 계약은 관리자도 바꾸거나 취소·삭제할 수 없다", async () => {
    const signed = await find(adminToken, "lc1");
    await save(adminToken, { laborContracts: [{ ...signed, status: "cancelled" }] });
    assert.equal((await find(adminToken, "lc1")).status, "signed");
    await save(adminToken, { recordTombstones: { laborContracts: [{ id: "lc1", ts: Date.now() }] } });
    assert.equal((await find(adminToken, "lc1")).status, "signed");
  });

  await t.test("거절 사유 없이는 거절할 수 없고, 거절 후 관리자가 되돌려 수정·재발송하면 서명 정보가 초기화된다", async () => {
    const own = await find(mem2, "lc2");
    await save(mem2, { laborContracts: [{ ...own, status: "declined", declineReason: " " }] });
    assert.equal((await find(mem2, "lc2")).status, "sent");
    await save(mem2, { laborContracts: [{ ...own, status: "declined", declineReason: "급여 조건 재협의 필요" }] });
    const declined = await find(adminToken, "lc2");
    assert.equal(declined.status, "declined");
    assert.equal(declined.declineReason, "급여 조건 재협의 필요");
    const oldHash = declined.contentHash;
    // 거절 상태에서는 내용 수정 불가, draft로 되돌리면 수정 가능
    await save(adminToken, { laborContracts: [{ ...declined, content: "무시되는 수정" }] });
    assert.equal((await find(adminToken, "lc2")).content, "제1조 (목적) 본 계약은...");
    await save(adminToken, { laborContracts: [{ ...declined, status: "draft", content: "수정된 조건" }] });
    let re = await find(adminToken, "lc2");
    assert.equal(re.status, "draft");
    assert.equal(re.content, "수정된 조건");
    assert.equal(re.declineReason, undefined);
    await save(adminToken, { laborContracts: [{ ...re, status: "sent" }] });
    re = await find(adminToken, "lc2");
    assert.equal(re.status, "sent");
    assert.notEqual(re.contentHash, oldHash);
  });

  await t.test("작성중 계약은 관리자가 삭제할 수 있다", async () => {
    await save(adminToken, { laborContracts: [draft("lc3", "mem1")] });
    assert.ok(await find(adminToken, "lc3"));
    await save(adminToken, { recordTombstones: { laborContracts: [{ id: "lc3", ts: Date.now() }] } });
    assert.equal(await find(adminToken, "lc3"), undefined);
  });

  await t.test("값 검증: 본문이 없거나 기간이 역전되거나 잘못된 상태의 계약은 저장되지 않는다", async () => {
    await save(adminToken, { laborContracts: [draft("bad1", "mem1", { content: "" }), draft("bad2", "mem1", { startDate: "2027-05-01", endDate: "2027-01-01" }), draft("bad3", "mem1", { status: "weird" })] });
    for (const id of ["bad1", "bad2", "bad3"]) assert.equal(await find(adminToken, id), undefined, id);
  });
}

test("근로계약 전자서명 — JSON 파일 모드", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const admin = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin-pw-123456", name: "관리자" });
  await scenario(t, {
    api, adminToken: admin.token,
    loginMember: async loginId => (await (await api("/login", auth(null, "POST", { loginId, pw: "mem-pw-123456" }))).json()).token,
  });
});

if (!ADMIN_DATABASE_URL) {
  test("근로계약 전자서명 — PostgreSQL (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  test("근로계약 전자서명 — 실제 PostgreSQL 모드", async t => {
    const { Client } = require("pg");
    const dbName = `hrtest_labor_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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
    const reg = await (await api("/api/companies/register", auth(null, "POST", { companyName: "계약테스트", adminName: "관리자", loginId: "admin", password: "TestPassword123" }))).json();
    assert.equal(reg.ok, true);
    await scenario(t, {
      api, adminToken: reg.token,
      loginMember: async loginId => (await (await api("/login", auth(null, "POST", { loginId, pw: "mem-pw-123456", companyCode: reg.companyCode }))).json()).token,
    });
  });
}
