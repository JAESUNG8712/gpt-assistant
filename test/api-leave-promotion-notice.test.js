// 연차 사용촉진 안내 메일 자동 발송(서버 스케줄러). 실제 서버 자식 프로세스 + 모의 SMTP로,
// 통보 기간 중 설정을 켠 회사의 잔여 연차 재직자에게 한 번씩만 발송되고 기록이 남는지 확인한다.
// 날짜는 LEAVE_PROMOTION_TEST_DATE로 고정하고(테스트 환경에서만 적용), 폴링은 200ms로 줄인다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");
const { startMockSmtp, parseMessage } = require("./support/mock-smtp");

const auth = (token, method, body) => ({
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});
const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await wait(100);
  }
}

async function setup(t, { today, enabled, smtpPort }) {
  const server = await startServer({
    env: {
      SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_FROM: "hr@company.test",
      LEAVE_PROMOTION_TEST_DATE: today, HR_SCHEDULER_POLL_MS: "200",
    },
  });
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${boot.token}` } })).json();
  const employees = [
    ...initial.data.employees,
    { id: "m1", loginId: "m1", pw: "m1-test-pw", name: "잔여직원", role: "member", active: true, dept: "영업본부", team: "영업1팀", email: "m1@company.test", hire: "2020-01-15", menuPerms: {} },
    { id: "m2", loginId: "m2", pw: "m2-test-pw", name: "무메일", role: "member", active: true, dept: "영업본부", team: "영업1팀", hire: "2020-01-15", menuPerms: {} },
    { id: "m3", loginId: "m3", pw: "m3-test-pw", name: "퇴직자", role: "member", active: false, dept: "영업본부", team: "영업1팀", email: "gone@company.test", hire: "2020-01-15", menuPerms: {} },
  ];
  const seed = await api("/save", auth(boot.token, "POST", {
    _version: initial.version,
    employees,
    settings: { ...(initial.data.settings || {}), leavePromotionMail: { enabled } },
  }));
  assert.equal(seed.status, 200);
  const login = async (loginId, pw) => (await (await api("/login", auth(null, "POST", { loginId, pw }))).json()).token;
  return { api, adminToken: boot.token, memberToken: await login("m1", "m1-test-pw") };
}

test("설정을 켠 회사: 통보 기간(2차) 중 잔여 연차 재직자에게 한 번만 발송되고 기록된다", async t => {
  const smtp = await startMockSmtp();
  t.after(() => smtp.stop());
  const { api, adminToken, memberToken } = await setup(t, { today: "2026-11-02", enabled: true, smtpPort: smtp.port });

  const sent = await waitFor(() => smtp.received.length >= 1 && smtp.received);
  assert.ok(sent, "메일이 발송되어야 함");
  // 대상은 잔여 연차가 있는 재직자 1명뿐(무메일·퇴직자는 제외)
  await wait(800); // 여러 주기가 더 돌아도
  assert.equal(smtp.received.length, 1, "같은 연도·차수에는 한 번만 발송");
  assert.deepEqual(smtp.received[0].to, ["m1@company.test"]);
  const p = parseMessage(smtp.received[0].raw);
  assert.match(p.subject, /연차 사용촉진 2차 안내/);
  assert.match(p.body, /미사용 연차가 17일 남아 있습니다/);

  // 발송 기록은 관리자만 본다
  const adminData = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
  const notices = adminData.data.leavePromotionNotices || [];
  assert.equal(notices.length, 1);
  assert.equal(notices[0].id, "lpn-2026-2-m1");
  assert.equal(notices[0].remain, 17);
  const memberData = await (await api("/data", { headers: { Authorization: `Bearer ${memberToken}` } })).json();
  assert.deepEqual(memberData.data.leavePromotionNotices, []);
});

test("설정을 끈 회사: 통보 기간이어도 발송하지 않는다", async t => {
  const smtp = await startMockSmtp();
  t.after(() => smtp.stop());
  await setup(t, { today: "2026-07-05", enabled: false, smtpPort: smtp.port });
  await wait(1000);
  assert.equal(smtp.received.length, 0);
});

test("통보 기간 밖이면 설정을 켰어도 발송하지 않는다", async t => {
  const smtp = await startMockSmtp();
  t.after(() => smtp.stop());
  await setup(t, { today: "2026-09-15", enabled: true, smtpPort: smtp.port });
  await wait(1000);
  assert.equal(smtp.received.length, 0);
});

test("관리자가 발송 기록을 직접 써도 서버가 게이팅한다(직원 위조 차단)", async t => {
  const smtp = await startMockSmtp();
  t.after(() => smtp.stop());
  const { api, memberToken } = await setup(t, { today: "2026-09-15", enabled: false, smtpPort: smtp.port });
  const d = await (await api("/data", { headers: { Authorization: `Bearer ${memberToken}` } })).json();
  const forged = await api("/save", auth(memberToken, "POST", {
    _version: d.version,
    leavePromotionNotices: [{ id: "lpn-2026-1-m1", year: 2026, round: 1, empId: "m1", sentAt: new Date().toISOString() }],
  }));
  assert.equal(forged.status, 200);
  const after = await (await api("/data", { headers: { Authorization: `Bearer ${memberToken}` } })).json();
  assert.deepEqual(after.data.leavePromotionNotices, []);
});
