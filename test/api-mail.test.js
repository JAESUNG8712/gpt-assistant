"use strict";
// 메일 발송 기반: 상태/테스트 API(관리자 전용)와 채용 결과 통보의 실제 이메일 발송.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");
const { startMockSmtp, parseMessage } = require("./support/mock-smtp");

const auth = (token, method, body) => ({
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

async function setup(t, smtpEnv) {
  const server = await startServer({ env: smtpEnv });
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${boot.token}` } })).json();
  const employees = [
    ...initial.data.employees,
    { id: "dir_sales", loginId: "dir_sales", pw: "dir-sales-pw", name: "영업본부장", role: "director", active: true, dept: "영업본부", team: "", menuPerms: {} },
    { id: "member1", loginId: "member1", pw: "member1-test-pw", name: "일반직원", role: "member", active: true, dept: "영업본부", team: "영업1팀", menuPerms: {} },
  ];
  const seed = await api("/save", auth(boot.token, "POST", { _version: initial.version, data: { ...initial.data, employees } }));
  assert.equal(seed.status, 200);
  const login = async (loginId, pw) => (await (await api("/login", auth(null, "POST", { loginId, pw }))).json()).token;
  return { api, adminToken: boot.token, dirToken: await login("dir_sales", "dir-sales-pw"), memberToken: await login("member1", "member1-test-pw") };
}

test("메일 API: 설정 상태·테스트 메일은 관리자만, 비밀번호는 노출되지 않는다", async t => {
  const smtp = await startMockSmtp();
  t.after(() => smtp.stop());
  const { api, adminToken, memberToken, dirToken } = await setup(t, {
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_FROM: "hr@company.test", SMTP_USER: "mailer", SMTP_PASS: "TOP-SECRET-PW",
  });
  for (const token of [memberToken, dirToken]) {
    assert.equal((await api("/api/mail/status", auth(token, "GET"))).status, 403);
    assert.equal((await api("/api/mail/test", auth(token, "POST", { to: "a@b.co" }))).status, 403);
  }
  assert.equal((await api("/api/mail/status", auth(null, "GET"))).status, 401);
  const st = await (await api("/api/mail/status", auth(adminToken, "GET"))).json();
  assert.equal(st.mail.configured, true);
  assert.equal(st.mail.from, "hr@company.test");
  assert.ok(!JSON.stringify(st).includes("TOP-SECRET-PW"));
  assert.equal((await api("/api/mail/test", auth(adminToken, "POST", { to: "not-email" }))).status, 400);
  const ok = await api("/api/mail/test", auth(adminToken, "POST", { to: "admin@company.test" }));
  assert.equal(ok.status, 200);
  assert.equal(smtp.received.length, 1);
  assert.deepEqual(smtp.received[0].auth, { user: "mailer", pass: "TOP-SECRET-PW" });
  assert.deepEqual(smtp.received[0].to, ["admin@company.test"]);
});

test("메일 API: 서버 메일 미설정이면 테스트는 503, 상태는 configured:false", async t => {
  const { api, adminToken } = await setup(t, { SMTP_HOST: "" });
  const st = await (await api("/api/mail/status", auth(adminToken, "GET"))).json();
  assert.equal(st.mail.configured, false);
  const r = await api("/api/mail/test", auth(adminToken, "POST", { to: "a@b.co" }));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, "MAIL_NOT_CONFIGURED");
});

test("채용 통보: sendEmail이면 서버에 저장된 지원자 이메일로 실제 발송되고 이력에 남는다", async t => {
  const smtp = await startMockSmtp();
  t.after(() => smtp.stop());
  const { api, adminToken, dirToken, memberToken } = await setup(t, {
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_FROM: "hr@company.test",
  });
  const job = await (await api("/api/recruit/jobs", auth(dirToken, "POST", { title: "영업 담당자", department: "영업본부" }))).json();
  const cand = await (await api("/api/recruit/candidates", auth(dirToken, "POST", { jobId: job.job.id, name: "홍길동", email: "hong@applicant.test" }))).json();
  const noMail = await (await api("/api/recruit/candidates", auth(dirToken, "POST", { jobId: job.job.id, name: "무메일" }))).json();
  const url = id => `/api/recruit/candidates/${id}/notice`;

  // 이메일 없이 발급(기존 동작) — 메일 미발송
  const plain = await (await api(url(cand.candidate.id), auth(dirToken, "POST", { result: "pass", message: "합격" }))).json();
  assert.equal(plain.ok, true);
  assert.equal(smtp.received.length, 0);
  assert.equal(plain.candidate.noticeHistory[0].emailedTo, undefined);

  // 본문이 비면 거부, 지원자 이메일이 없으면 400, 권한 없으면 403
  assert.equal((await api(url(cand.candidate.id), auth(dirToken, "POST", { result: "pass", message: " ", sendEmail: true }))).status, 400);
  const miss = await api(url(noMail.candidate.id), auth(dirToken, "POST", { result: "pass", message: "합격", sendEmail: true }));
  assert.equal(miss.status, 400);
  assert.equal((await miss.json()).code, "CANDIDATE_EMAIL_MISSING");
  assert.equal((await api(url(cand.candidate.id), auth(memberToken, "POST", { result: "pass", message: "x", sendEmail: true }))).status, 403);
  assert.equal(smtp.received.length, 0);

  // 정상 발송 — 수신 주소는 저장된 값이고 제목에 공고명·결과가 들어간다
  const sent = await api(url(cand.candidate.id), auth(dirToken, "POST", { result: "fail", message: "아쉽게도 이번에는\n.함께하지 못하게 되었습니다.", sendEmail: true, to: "evil@attacker.test" }));
  assert.equal(sent.status, 200);
  const body = await sent.json();
  const last = body.candidate.noticeHistory.at(-1);
  assert.equal(last.emailedTo, "hong@applicant.test");
  assert.equal(smtp.received.length, 1);
  assert.deepEqual(smtp.received[0].to, ["hong@applicant.test"]);
  const p = parseMessage(smtp.received[0].raw);
  assert.match(p.subject, /영업 담당자.*불합격/);
  assert.equal(p.body, "아쉽게도 이번에는\n.함께하지 못하게 되었습니다.");
  void adminToken;
});

test("채용 통보: 메일 서버 거부/미설정이면 이력이 남지 않고 오류를 돌려준다", async t => {
  const smtp = await startMockSmtp({ rejectRcpt: true });
  t.after(() => smtp.stop());
  const { api, dirToken } = await setup(t, { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_FROM: "hr@company.test" });
  const job = await (await api("/api/recruit/jobs", auth(dirToken, "POST", { title: "공고", department: "영업본부" }))).json();
  const cand = await (await api("/api/recruit/candidates", auth(dirToken, "POST", { jobId: job.job.id, name: "지원자", email: "x@applicant.test" }))).json();
  const r = await api(`/api/recruit/candidates/${cand.candidate.id}/notice`, auth(dirToken, "POST", { result: "pass", message: "합격", sendEmail: true }));
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body.code, "MAIL_SEND_FAILED");
  assert.ok(!/550|no such user/i.test(body.message), "서버 응답 원문을 노출하지 않는다");
  const list = await (await api("/api/recruit/candidates", auth(dirToken, "GET"))).json();
  assert.equal((list.candidates.find(c => c.id === cand.candidate.id).noticeHistory || []).length, 0);
});

test("채용 통보: 메일 서버가 설정되지 않았으면 503", async t => {
  const { api, dirToken } = await setup(t, { SMTP_HOST: "" });
  const job = await (await api("/api/recruit/jobs", auth(dirToken, "POST", { title: "공고", department: "영업본부" }))).json();
  const cand = await (await api("/api/recruit/candidates", auth(dirToken, "POST", { jobId: job.job.id, name: "지원자", email: "x@applicant.test" }))).json();
  const r = await api(`/api/recruit/candidates/${cand.candidate.id}/notice`, auth(dirToken, "POST", { result: "pass", message: "합격", sendEmail: true }));
  assert.equal(r.status, 503);
});
