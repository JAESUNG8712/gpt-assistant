// GET /api/payroll/payslip.pdf — 급여 명세서 PDF 서버 생성·권한 검증.
// PDF 본문은 pdf-parse로 글자를 다시 읽어 한글과 금액이 실제로 들어갔는지 확인한다.
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
async function login(api, loginId, pw) {
  const r = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  })).json();
  assert.equal(r.ok, true, `${loginId} 로그인 실패: ${JSON.stringify(r)}`);
  return r.token;
}
async function pdfText(buffer) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result.text || "";
}

test("급여 명세서 PDF — 본인/관리자 조회와 권한 경계", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "mem1", loginId: "mem1", pw: "mem1-pw-1", name: "팀원1", empNo: "2024001", role: "member", active: true, dept: "개발본부", team: "A팀", rank: "대리", position: "팀원", hire: "2024-03-01", salary: 60000000 },
    { id: "mem2", loginId: "mem2", pw: "mem2-pw-1", name: "팀원2", empNo: "2024002", role: "member", active: true, dept: "개발본부", team: "A팀", rank: "사원", position: "팀원", hire: "2024-03-01", salary: 40000000 },
    { id: "mem3", loginId: "mem3", pw: "mem3-pw-1", name: "메뉴제한", empNo: "2024003", role: "member", active: true, dept: "개발본부", team: "A팀", rank: "사원", position: "팀원", hire: "2024-03-01", salary: 40000000, menuPerms: { payslip: false } },
  ];
  const seed = await api("/save", auth(adminToken, "POST", {
    _version: initial.version, employees,
    settings: { ...initial.data.settings, companyName: "테스트 주식회사" },
  }));
  assert.equal(seed.status, 200);
  const mem1Token = await login(api, "mem1", "mem1-pw-1");
  const mem3Token = await login(api, "mem3", "mem3-pw-1");

  await t.test("본인 명세서는 PDF로 내려오고 한글·금액이 들어 있다", async () => {
    const res = await api("/api/payroll/payslip.pdf?year=2026&month=5", { headers: { Authorization: `Bearer ${mem1Token}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.match(res.headers.get("content-disposition") || "", /filename\*=UTF-8''/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
    const text = (await pdfText(buf)).replace(/\s+/g, "");
    assert.ok(text.includes("급여명세서"), "제목이 들어 있어야 한다");
    assert.ok(text.includes("팀원1"), "직원 성명이 들어 있어야 한다");
    assert.ok(text.includes("테스트주식회사") || text.includes("테스트"), "회사명이 들어 있어야 한다");
    // 연봉 6,000만원 → 월 기본급 510만원(교통비 포함), 실수령 3,979,202원
    assert.ok(text.includes("3,979,202원"), `실수령액 금액이 보여야 한다: ${text.slice(0, 200)}`);
  });

  await t.test("다른 직원 명세서는 member가 조회할 수 없다(403)", async () => {
    const res = await api("/api/payroll/payslip.pdf?empId=mem2&year=2026&month=5", { headers: { Authorization: `Bearer ${mem1Token}` } });
    assert.equal(res.status, 403);
  });

  await t.test("메뉴 권한 payslip을 끈 본인은 조회할 수 없다(403)", async () => {
    const res = await api("/api/payroll/payslip.pdf?year=2026&month=5", { headers: { Authorization: `Bearer ${mem3Token}` } });
    assert.equal(res.status, 403);
  });

  await t.test("관리자는 다른 직원 명세서를 조회할 수 있다", async () => {
    const res = await api("/api/payroll/payslip.pdf?empId=mem2&year=2026&month=5", { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(res.status, 200);
    const text = (await pdfText(Buffer.from(await res.arrayBuffer()))).replace(/\s+/g, "");
    assert.ok(text.includes("팀원2"));
  });

  await t.test("잘못된 월·없는 직원·토큰 없음은 각각 400·404·401", async () => {
    const bad = await api("/api/payroll/payslip.pdf?year=2026&month=13", { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(bad.status, 400);
    const missing = await api("/api/payroll/payslip.pdf?empId=nobody&year=2026&month=5", { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(missing.status, 404);
    const anon = await api("/api/payroll/payslip.pdf?year=2026&month=5");
    assert.equal(anon.status, 401);
  });

  await t.test("저장된 명세서가 있으면 계산값 대신 저장값을 쓴다", async () => {
    const d = await getData(api, adminToken);
    const saved = {
      id: "payslip-mem1-2026-4", empId: "mem1", year: 2026, month: 4,
      gross: 1000000, totalDeduct: 100000, netPay: 900000,
      payItems: [{ label: "기본급(확정)", amount: 1000000, taxable: true }],
      deductItems: [{ label: "소득세", amount: 100000 }],
      confirmed: true, confirmedAt: "2026-05-01T00:00:00.000Z", updatedAt: new Date().toISOString(),
    };
    const r = await api("/save", auth(adminToken, "POST", { _version: d.version, payslips: [...(d.data.payslips || []), saved] }));
    assert.equal(r.status, 200);
    const res = await api("/api/payroll/payslip.pdf?empId=mem1&year=2026&month=4", { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(res.status, 200);
    const text = (await pdfText(Buffer.from(await res.arrayBuffer()))).replace(/\s+/g, "");
    assert.ok(text.includes("기본급(확정)"), "확정된 명세서의 항목명이 그대로 나와야 한다");
    assert.ok(text.includes("900,000원"), "확정된 실수령액이 나와야 한다");
  });
});
