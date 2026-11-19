"use strict";
// HR 알림 메일: 근로계약서 서명 요청 안내(관리자 전용, 서버 저장 이메일로만, 계약 내용 비포함).
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");
const { startMockSmtp, parseMessage } = require("./support/mock-smtp");

const auth = (token, method, body) => ({
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

async function setup(t, smtpEnv, extra = {}) {
  const server = await startServer({ env: smtpEnv });
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${boot.token}` } })).json();
  const employees = [
    ...initial.data.employees,
    { id: "member1", loginId: "member1", pw: "member1-test-pw", name: "일반직원", role: "member", active: true, dept: "영업본부", team: "영업1팀", email: "member1@company.test", menuPerms: {} },
    { id: "member2", loginId: "member2", pw: "member2-test-pw", name: "무메일", role: "member", active: true, dept: "영업본부", team: "영업1팀", menuPerms: {} },
    { id: "member3", loginId: "member3", pw: "member3-test-pw", name: "퇴직자", role: "member", active: false, dept: "영업본부", team: "영업1팀", email: "gone@company.test", menuPerms: {} },
  ];
  const seed = await api("/save", auth(boot.token, "POST", { _version: initial.version, data: { ...initial.data, employees, ...extra } }));
  assert.equal(seed.status, 200);
  const login = async (loginId, pw) => (await (await api("/login", auth(null, "POST", { loginId, pw }))).json()).token;
  return { api, adminToken: boot.token, memberToken: await login("member1", "member1-test-pw") };
}
const contract = (id, empId, status = "sent") => ({ id, empId, title: "2027년 정규직 근로계약서", contractType: "정규직", content: "비밀 계약 내용 연봉 1억", status });

test("계약서 메일 안내: 서명 대기 계약만, 저장된 직원 이메일로, 계약 내용 없이 발송된다", async t => {
  const smtp = await startMockSmtp();
  t.after(() => smtp.stop());
  const { api, adminToken, memberToken } = await setup(t, {
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_FROM: "hr@company.test",
  }, { laborContracts: [contract("lc-1", "member1"), contract("lc-draft", "member1", "draft"), contract("lc-nomail", "member2"), contract("lc-gone", "member3")] });
  const url = id => `/api/labor-contracts/${id}/notify-email`;

  assert.equal((await api(url("lc-1"), auth(null, "POST", {}))).status, 401);
  assert.equal((await api(url("lc-1"), auth(memberToken, "POST", {}))).status, 403);
  assert.equal((await api(url("nope"), auth(adminToken, "POST", {}))).status, 404);
  const draft = await api(url("lc-draft"), auth(adminToken, "POST", {}));
  assert.equal(draft.status, 409);
  assert.equal((await draft.json()).code, "CONTRACT_NOT_PENDING");
  const nomail = await api(url("lc-nomail"), auth(adminToken, "POST", {}));
  assert.equal(nomail.status, 400);
  assert.equal((await nomail.json()).code, "EMPLOYEE_EMAIL_MISSING");
  const gone = await api(url("lc-gone"), auth(adminToken, "POST", {}));
  assert.equal(gone.status, 409);
  assert.equal((await gone.json()).code, "EMPLOYEE_INACTIVE");
  assert.equal(smtp.received.length, 0);

  const ok = await api(url("lc-1"), auth(adminToken, "POST", { to: "evil@attacker.test" }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).emailedTo, "member1@company.test");
  assert.equal(smtp.received.length, 1);
  assert.deepEqual(smtp.received[0].to, ["member1@company.test"]);
  const p = parseMessage(smtp.received[0].raw);
  assert.match(p.subject, /근로계약 서명 요청/);
  assert.ok(p.body.includes("일반직원님"));
  assert.ok(!p.body.includes("비밀 계약 내용") && !p.body.includes("1억"), "계약 내용은 메일에 포함하지 않는다");

  // 같은 계약에 대한 반복 발송은 1분 간격 제한
  const again = await api(url("lc-1"), auth(adminToken, "POST", {}));
  assert.equal(again.status, 429);
  assert.equal(smtp.received.length, 1);
});

test("계약서 메일 안내: 메일 서버 미설정 503, 서버 거부는 502(원문 비노출)이고 재시도가 막히지 않는다", async t => {
  const none = await setup(t, { SMTP_HOST: "" }, { laborContracts: [contract("lc-1", "member1")] });
  const r503 = await none.api("/api/labor-contracts/lc-1/notify-email", auth(none.adminToken, "POST", {}));
  assert.equal(r503.status, 503);

  const smtp = await startMockSmtp({ rejectRcpt: true });
  t.after(() => smtp.stop());
  const { api, adminToken } = await setup(t, { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_FROM: "hr@company.test" }, { laborContracts: [contract("lc-1", "member1")] });
  const r1 = await api("/api/labor-contracts/lc-1/notify-email", auth(adminToken, "POST", {}));
  assert.equal(r1.status, 502);
  const body = await r1.json();
  assert.equal(body.code, "MAIL_SEND_FAILED");
  assert.ok(!/550|no such user/i.test(body.message));
  // 실패했으므로 쿨다운이 걸리지 않아 바로 다시 시도할 수 있다(429가 아님)
  assert.equal((await api("/api/labor-contracts/lc-1/notify-email", auth(adminToken, "POST", {}))).status, 502);
});
