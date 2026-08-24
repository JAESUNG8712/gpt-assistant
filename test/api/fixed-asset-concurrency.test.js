"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("../support/start-server");

test("fixed asset concurrency: same asset's JSON mutations do not create duplicate depreciation vouchers", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const boot = await bootstrapAdminAndLogin(server, { loginId: "fa_admin", pw: "fixed_asset_pw", name: "자산관리자" });
  const api = (path, options = {}) => fetch(server.baseUrl + path, {
    ...options, headers: { Authorization: `Bearer ${boot.token}`, ...(options.headers || {}) },
  });
  const post = async (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const debit = await (await post("/api/accounting/accounts", { code: "F901", name: "감가상각비", type: "expense" })).json();
  const credit = await (await post("/api/accounting/accounts", { code: "F902", name: "감가상각누계액", type: "asset" })).json();
  const created = await (await post("/api/accounting/fixed-assets", {
    name: "동시성 테스트 자산", acquisitionDate: "2026-01-01", acquisitionCost: 1200, usefulLifeYears: 3,
  })).json();
  const assetId = created.asset.id;
  const body = { depreciationExpenseAccountId: debit.account.id, accumulatedDepreciationAccountId: credit.account.id };

  const [first, second] = await Promise.all([
    post(`/api/accounting/fixed-assets/${assetId}/depreciation-schedule/2026/post`, body),
    post(`/api/accounting/fixed-assets/${assetId}/depreciation-schedule/2026/post`, body),
  ]);
  const statuses = [first.status, second.status].sort();
  // 요청이 실제로 겹치면 409(FIXED_ASSET_BUSY), 첫 요청이 아주 빨리 끝나면 두 번째는
  // 이미 발행된 회차라는 400을 받는다. 어느 경우든 정확히 한 번만 발행돼야 한다.
  assert.equal(statuses[0], 200);
  assert.ok([400, 409].includes(statuses[1]), "두 번째 요청은 중복 발행 대신 거부돼야 함");
  const detail = await (await api(`/api/accounting/fixed-assets/${assetId}`)).json();
  assert.equal(detail.schedule.filter(s => s.status === "posted").length, 1);
});
