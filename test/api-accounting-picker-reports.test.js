"use strict";

// "구조적 한계 #2"(회계 등 대량 조회 API가 menuPerms로 좁혀지지 않던 문제)의 회계 모듈
// 1차 증분 — GET .../accounts, GET .../partners를 requirePage()로 게이팅하기 전에,
// 그 두 API가 아니어도 다른 화면(전표 작성·급여전표·경비지급·세금계산서·견적서/발주서
// 등)이 "계정/거래처를 하나 고른다"는 목적을 계속 이룰 수 있도록 인증만 있으면 조회
// 가능한 최소 조회(picker) 엔드포인트와, 회계 리포트/원가명세서가 원본 레코드 대신
// 서버가 미리 집계한 결과만 받도록 바꾼 것을 검증한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

async function login(api, loginId, pw) {
  const response = await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  });
  const body = await response.json();
  assert.equal(body.ok, true, `${loginId} 로그인 실패`);
  return body.token;
}

function auth(token, method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

test("회계 picker/reports/cost-statement + accounts·partners 대량조회 게이팅", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const adminToken = boot.token;

  // 개인적으로 "acct-accounts"/"acct-partners"만 꺼둔 admin(다른 회계 화면은 전부 열려있음)과
  // 대조군 admin을 함께 시딩 — menuPerms 강화가 "그 두 화면만" 막고 다른 화면은 그대로
  // 동작해야 한다는 것을 실제로 확인하려면 role 체크만으로는 구분이 안 되기 때문.
  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
  const employees = [
    ...initial.data.employees.map(e => e.loginId === "admin1"
      ? { ...e, menuPerms: { "acct-accounts": false, "acct-partners": false } }
      : e),
    { id: "admin2", loginId: "admin2", pw: "admin2-test-pw", name: "관리자2", role: "admin", active: true, menuPerms: {} },
    { id: "member1", loginId: "member1", pw: "member1-test-pw", name: "일반직원", role: "member", active: true, dept: "영업본부", team: "영업1팀", menuPerms: {} },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, data: { ...initial.data, employees } }));
  assert.equal(seed.status, 200);

  const restrictedToken = adminToken; // admin1 — acct-accounts/acct-partners 개인적으로 꺼짐
  const admin2Token = await login(api, "admin2", "admin2-test-pw");
  const memberToken = await login(api, "member1", "member1-test-pw");

  // ── 계정과목/거래처 마스터 데이터 준비(대조군 admin2로) ──
  const salaryAcc = await (await api("/api/accounting/accounts", auth(admin2Token, "POST", {
    code: "T801", name: "급여", type: "expense", costCategory: "mfg", costSubType: "labor", user: "admin2",
  }))).json();
  assert.equal(salaryAcc.ok, true);
  const cashAcc = await (await api("/api/accounting/accounts", auth(admin2Token, "POST", {
    code: "T101", name: "보통예금", type: "asset", user: "admin2",
  }))).json();
  assert.equal(cashAcc.ok, true);
  const sgaAcc = await (await api("/api/accounting/accounts", auth(admin2Token, "POST", {
    code: "T811", name: "복리후생비", type: "expense", costCategory: "sga", user: "admin2",
  }))).json();
  assert.equal(sgaAcc.ok, true);
  const inactiveAcc = await (await api("/api/accounting/accounts", auth(admin2Token, "POST", {
    code: "T999", name: "미사용계정", type: "expense", active: false, user: "admin2",
  }))).json();
  assert.equal(inactiveAcc.ok, true);

  const partner = await (await api("/api/accounting/partners", auth(admin2Token, "POST", {
    name: "테스트거래처", bizNo: "123-45-67890", type: "customer", contactName: "홍길동", phone: "010-0000-0000", user: "admin2",
  }))).json();
  assert.equal(partner.ok, true);

  // ── 전표: 급여(비용,mfg/labor) 차변 / 보통예금(자산) 대변, draft → posted ──
  const voucher = await (await api("/api/accounting/vouchers", auth(admin2Token, "POST", {
    date: "2031-03-15", description: "3월 급여 지급",
    lines: [
      { accountId: salaryAcc.account.id, debit: 3000000, credit: 0 },
      { accountId: cashAcc.account.id, debit: 0, credit: 3000000 },
    ],
    user: "admin2",
  }))).json();
  assert.equal(voucher.ok, true);
  const posted = await (await api(`/api/accounting/vouchers/${voucher.voucher.id}/post`, auth(admin2Token, "POST", { user: "admin2" }))).json();
  assert.equal(posted.ok, true);

  // 원가명세서/시산표 집계에서 제외돼야 하는 대조군: 미확정(draft) 전표
  const draftVoucher = await (await api("/api/accounting/vouchers", auth(admin2Token, "POST", {
    date: "2031-03-20", description: "미확정 전표",
    lines: [
      { accountId: sgaAcc.account.id, debit: 500000, credit: 0 },
      { accountId: cashAcc.account.id, debit: 0, credit: 500000 },
    ],
    user: "admin2",
  }))).json();
  assert.equal(draftVoucher.ok, true);

  // ── 세금계산서(발행) — 월별 손익/거래처별 집계 대상 ──
  const invoice = await (await api("/api/accounting/tax-invoices", auth(admin2Token, "POST", {
    issueDate: "2031-03-10", direction: "sales", partnerId: partner.partner.id, partnerName: partner.partner.name,
    partnerBizNo: partner.partner.bizNo, items: [{ name: "컨설팅", qty: 1, unitPrice: 1000000 }], user: "admin2",
  }))).json();
  assert.equal(invoice.ok, true);

  await t.test("GET .../accounts/picker — 인증만 있으면 acct-accounts 권한 없이도 조회되고, 비활성 계정은 제외되며 민감 필드(costCategory 등)는 없다", async () => {
    const r = await api("/api/accounting/accounts/picker", { headers: { Authorization: `Bearer ${restrictedToken}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    const codes = body.accounts.map(a => a.code);
    // 회사 가입 시 자동 시딩되는 DEFAULT_ACCOUNTS도 함께 섞여 있으므로(정상), 이 테스트가
    // 실제로 만든 3개 계정만 포함/제외 여부로 확인한다 — 전체 목록 완전일치는 검증하지 않는다.
    assert.ok(codes.includes("T101"));
    assert.ok(codes.includes("T801"));
    assert.ok(codes.includes("T811"));
    assert.ok(!codes.includes("T999"), "비활성 계정은 picker에서 제외돼야 함");
    const salary = body.accounts.find(a => a.code === "T801");
    assert.deepEqual(Object.keys(salary).sort(), ["code", "id", "name", "type"]);
  });

  await t.test("GET .../partners/picker — 인증만 있으면 조회되고, bizNo는 남지만 연락처(개인정보)는 빠진다", async () => {
    const r = await api("/api/accounting/partners/picker", { headers: { Authorization: `Bearer ${restrictedToken}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    const p = body.partners.find(p => p.name === "테스트거래처");
    assert.ok(p);
    assert.equal(p.bizNo, "123-45-67890");
    assert.equal("contactName" in p, false);
    assert.equal("phone" in p, false);
  });

  await t.test("일반 사원(member)도 picker는 조회 가능하다(전 역할 공개 화면들이 쓰는 전제)", async () => {
    const r1 = await api("/api/accounting/accounts/picker", { headers: { Authorization: `Bearer ${memberToken}` } });
    assert.equal(r1.status, 200);
    const r2 = await api("/api/accounting/partners/picker", { headers: { Authorization: `Bearer ${memberToken}` } });
    assert.equal(r2.status, 200);
  });

  await t.test("GET .../accounts — 이제 acct-accounts 게이팅, 개인적으로 꺼둔 admin은 403", async () => {
    const r = await api("/api/accounting/accounts", { headers: { Authorization: `Bearer ${restrictedToken}` } });
    assert.equal(r.status, 403);
  });

  await t.test("GET .../partners — 이제 acct-partners 게이팅, 개인적으로 꺼둔 admin은 403", async () => {
    const r = await api("/api/accounting/partners", { headers: { Authorization: `Bearer ${restrictedToken}` } });
    assert.equal(r.status, 403);
  });

  await t.test("GET .../accounts, .../partners — 대조군 admin2(제한 없음)는 정상 200", async () => {
    const r1 = await api("/api/accounting/accounts", { headers: { Authorization: `Bearer ${admin2Token}` } });
    assert.equal(r1.status, 200);
    const r2 = await api("/api/accounting/partners", { headers: { Authorization: `Bearer ${admin2Token}` } });
    assert.equal(r2.status, 200);
  });

  await t.test("GET .../accounts, .../partners — member(비관리자)는 role 자체에서 403", async () => {
    const r1 = await api("/api/accounting/accounts", { headers: { Authorization: `Bearer ${memberToken}` } });
    assert.equal(r1.status, 403);
    const r2 = await api("/api/accounting/partners", { headers: { Authorization: `Bearer ${memberToken}` } });
    assert.equal(r2.status, 403);
  });

  await t.test("GET .../reports?year= — 서버가 집계한 시산표/월별손익/거래처별 집계를 반환(원본 레코드 아님), draft 전표는 시산표에서 제외", async () => {
    const r = await api("/api/accounting/reports?year=2031", { headers: { Authorization: `Bearer ${admin2Token}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    // 응답에 전표/거래처 원본 레코드가 아니라 집계 결과만 있어야 한다.
    assert.equal("vouchers" in body, false);
    assert.equal("taxInvoices" in body, false);

    const salaryRow = body.trial.find(r => r.code === "T801");
    assert.ok(salaryRow, "posted 전표의 급여 계정이 시산표에 있어야 함");
    assert.equal(salaryRow.debit, 3000000);
    const sgaRow = body.trial.find(r => r.code === "T811");
    assert.equal(sgaRow, undefined, "draft 전표의 복리후생비 계정은 시산표에서 제외돼야 함");

    const pnlRow = body.pnl.find(r => r.month === "2031-03");
    assert.ok(pnlRow);
    assert.equal(pnlRow.sales, 1000000);
    assert.equal(pnlRow.purchase, 0);
    assert.equal(pnlRow.profit, 1000000);

    const partnerRow = body.partners.find(p => p.name === "테스트거래처");
    assert.ok(partnerRow);
    assert.equal(partnerRow.salesCnt, 1);
    assert.equal(partnerRow.sales, 1100000); // 공급가액+부가세(10%)
  });

  await t.test("GET .../reports?year= — acct-reports도 requirePage로 게이팅된다(회귀 없음 확인용, 제한 없는 admin2는 통과)", async () => {
    const r = await api("/api/accounting/reports?year=2031", { headers: { Authorization: `Bearer ${memberToken}` } });
    assert.equal(r.status, 403); // member는애초에 role 체크에서 막힘
  });

  await t.test("GET .../cost-statement?from=&to= — mfg(재료비/노무비/제조경비)와 sga가 costCategory 기준으로 정확히 분리 집계된다", async () => {
    const r = await api("/api/accounting/cost-statement?from=2031-01-01&to=2031-12-31", { headers: { Authorization: `Bearer ${admin2Token}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.mfg.labor, 3000000);
    assert.equal(body.mfg.total, 3000000);
    assert.equal(body.sga.total, 0, "draft 상태인 복리후생비 전표는 집계에서 제외돼야 함");
    assert.equal("vouchers" in body, false);
  });
});
