"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("../support/start-server");

test("expense payment recovers after voucher-only file write without duplicate vouchers", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const boot = await bootstrapAdminAndLogin(server, { loginId: "pay_admin", pw: "pay_admin_pw" });
  const api = async (path, method = "GET", body, extraHeaders = {}) => {
    const response = await fetch(server.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${boot.token}`, "Content-Type": "application/json", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const initial = (await api("/data")).body;
  const claim = {
    id: "expense-test-1", empId: boot.employee.id, empName: "테스트 관리자",
    title: "업무 교통비", total: 12000, status: "approved",
    items: [{ date: "2026-10-01", category: "교통비", amount: 12000 }],
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const badClaim = { ...claim, id: "expense-invalid-amount", total: 0 };
  const mismatchedClaim = { ...claim, id: "expense-mismatched-total", total: 13000 };
  const seeded = await api("/save", "POST", { _version: initial.version, data: { ...initial.data, expenseClaims: [claim, badClaim, mismatchedClaim] } });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  const accountIds = [];
  for (const account of [
    { code: "PAY01", name: "복리후생비", type: "expense" },
    { code: "PAY02", name: "보통예금", type: "asset" },
  ]) {
    const created = await api("/api/accounting/accounts", "POST", account);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    accountIds.push(created.body.account.id);
  }
  const path = `/api/hr/expense-claims/${claim.id}/pay`;
  const payment = { date: "2026-10-02", method: "계좌이체", makeVoucher: true,
    debitAccountId: accountIds[0], creditAccountId: accountIds[1] };
  const badAmount = await api(`/api/hr/expense-claims/${badClaim.id}/pay`, "POST",
    { date: payment.date, method: payment.method, makeVoucher: false });
  assert.equal(badAmount.status, 400, "전표를 만들지 않아도 0원 청구를 지급완료로 표시할 수 없어야 함");
  const mismatchedAmount = await api(`/api/hr/expense-claims/${mismatchedClaim.id}/pay`, "POST",
    { date: payment.date, method: payment.method, makeVoucher: false });
  assert.equal(mismatchedAmount.status, 400, "항목 합계와 청구 합계가 다른 경비를 지급할 수 없어야 함");
  const wrongSide = await api(path, "POST", { ...payment,
    debitAccountId: accountIds[1], creditAccountId: accountIds[0] }, { "Idempotency-Key": "expense-wrong-side" });
  assert.equal(wrongSide.status, 400, "API 직접 호출로 비용·자산 계정을 뒤집으면 거부해야 함");
  assert.equal((await api("/api/accounting/vouchers")).body.vouchers.length, 0);
  const failed = await api(path, "POST", payment, {
    "Idempotency-Key": "expense-fail-once", "X-Test-Expense-Pay-Fail-After-Voucher": "1",
  });
  assert.equal(failed.status, 500);
  assert.equal((await api("/api/accounting/vouchers")).body.vouchers.length, 1);
  assert.equal((await api("/data")).body.data.expenseClaims[0].status, "approved");

  const mismatch = await api(path, "POST", { ...payment, date: "2026-10-03" }, { "Idempotency-Key": "expense-mismatch-key" });
  assert.equal(mismatch.status, 409, "중간 실패 후 다른 날짜로 재시도하면 전표와 지급일이 어긋나므로 차단");

  const recovered = await api(path, "POST", payment, { "Idempotency-Key": "expense-fail-once" });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.claim.status, "paid");
  assert.equal(recovered.body.claim.voucherId, recovered.body.voucher.id);
  assert.equal(recovered.body.claim.voucherNo, null, "임시 전표의 표시 문구는 청구 원장에 저장하지 않는다");
  assert.equal((await api("/api/accounting/vouchers")).body.vouchers.length, 1);
  const blockedDelete = await api(`/api/accounting/vouchers/${recovered.body.voucher.id}`, "DELETE", undefined,
    { "Idempotency-Key": "linked-voucher-delete" });
  assert.equal(blockedDelete.status, 409, "지급 완료 청구의 근거 전표는 일반 삭제할 수 없어야 함");
  const posted = await api(`/api/accounting/vouchers/${recovered.body.voucher.id}/post`, "POST",
    { user: "spoofed-actor" }, { "Idempotency-Key": "linked-voucher-post" });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.voucher.postedBy, "pay_admin", "전표 확정 이력의 사용자는 요청 본문이 아닌 인증 정보에서 가져와야 함");
  const postedClaim = (await api("/data")).body.data.expenseClaims.find(c => c.id === claim.id);
  assert.equal(postedClaim.voucherNo, posted.body.voucher.voucherNo,
    "전표 확정 번호는 연결된 경비 청구 원장에도 반영돼야 함");
  const blockedVoid = await api(`/api/accounting/vouchers/${recovered.body.voucher.id}/void`, "POST",
    { user: "spoofed-actor", reason: "임의 취소" }, { "Idempotency-Key": "linked-voucher-void" });
  assert.equal(blockedVoid.status, 409, "지급 완료 청구의 근거 전표는 일반 취소할 수 없어야 함");

  const repeated = await api(path, "POST", payment, { "Idempotency-Key": "expense-other-key" });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.voucher.id, recovered.body.voucher.id);
  const changedAfterPay = await api(path, "POST", { ...payment, makeVoucher: false },
    { "Idempotency-Key": "expense-changed-after-pay" });
  assert.equal(changedAfterPay.status, 409, "완료된 지급을 다른 옵션으로 재시도할 때 성공으로 오인하면 안 됨");
  assert.equal((await api("/api/accounting/vouchers")).body.vouchers.length, 1);
});

test("concurrent expense payments with different request keys create one voucher", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const boot = await bootstrapAdminAndLogin(server, { loginId: "concurrent_pay_admin", pw: "concurrent_pay_pw" });
  const api = async (path, method = "GET", body, key) => {
    const response = await fetch(server.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${boot.token}`, "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const initial = (await api("/data")).body;
  const claim = { id: "parallel-expense", empId: boot.employee.id, empName: "관리자",
    title: "병행 처리 검증", total: 25000, status: "approved",
    items: [{ date: "2026-10-01", category: "교통비", amount: 25000 }] };
  assert.equal((await api("/save", "POST", { _version: initial.version,
    data: { ...initial.data, expenseClaims: [claim] } })).status, 200);
  const accounts = [];
  for (const row of [{ code: "CON01", name: "출장비", type: "expense" },
    { code: "CON02", name: "보통예금", type: "asset" }]) {
    const created = await api("/api/accounting/accounts", "POST", row);
    assert.equal(created.status, 200);
    accounts.push(created.body.account.id);
  }
  const payment = { date: "2026-10-02", method: "계좌이체", makeVoucher: true,
    debitAccountId: accounts[0], creditAccountId: accounts[1] };
  const path = `/api/hr/expense-claims/${claim.id}/pay`;
  const responses = await Promise.all([
    api(path, "POST", payment, "parallel-payment-a"),
    api(path, "POST", payment, "parallel-payment-b"),
  ]);
  assert.deepEqual(responses.map(result => result.status), [200, 200]);
  assert.equal(responses[0].body.voucher.id, responses[1].body.voucher.id);
  assert.equal((await api("/api/accounting/vouchers")).body.vouchers.length, 1);
  assert.equal((await api("/data")).body.data.expenseClaims[0].status, "paid");
});
