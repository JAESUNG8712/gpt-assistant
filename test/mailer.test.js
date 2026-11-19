"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { sendMail, getMailConfig, publicMailStatus, isValidEmail, buildMessage } = require("../lib/mailer");
const { startMockSmtp, parseMessage } = require("./support/mock-smtp");

const envFor = (smtp, extra = {}) => ({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_FROM: "hr@company.test", SMTP_TIMEOUT_MS: "3000", ...extra });

test("메일 설정: 미설정·상태 요약에는 비밀번호가 없다", () => {
  assert.equal(getMailConfig({}).configured, false);
  assert.equal(getMailConfig({ SMTP_HOST: "x", SMTP_FROM: "not-email" }).configured, false);
  const st = publicMailStatus({ SMTP_HOST: "smtp.test", SMTP_FROM: "hr@x.test", SMTP_USER: "u", SMTP_PASS: "SECRET" });
  assert.equal(st.configured, true);
  assert.equal(st.auth, true);
  assert.ok(!JSON.stringify(st).includes("SECRET"));
  assert.equal(getMailConfig({ SMTP_HOST: "x", SMTP_FROM: "a@b.co", SMTP_SECURE: "true" }).port, 465);
});

test("이메일 형식 검증", () => {
  assert.equal(isValidEmail("a@b.co"), true);
  for (const bad of ["", "a@b", "a b@c.co", "a@b.co\r\nBcc: x@y.z", "<a@b.co>", null]) assert.equal(isValidEmail(bad), false, String(bad));
});

test("메시지 직렬화: 한글 제목·본문, 헤더 인젝션 거부", () => {
  const raw = buildMessage({ from: "hr@x.test", to: "a@b.co", subject: "채용 결과", text: "안녕하세요" });
  const p = parseMessage(raw);
  assert.equal(p.subject, "채용 결과");
  assert.equal(p.body.trim(), "안녕하세요");
  assert.throws(() => buildMessage({ from: "hr@x.test", to: "a@b.co", subject: "x\r\nBcc: e@e.co", text: "t" }), /줄바꿈/);
  assert.throws(() => buildMessage({ from: "hr@x.test", to: "a@b.co\r\nBcc: e@e.co", subject: "x", text: "t" }), /줄바꿈/);
});

test("SMTP 발송: 평문 서버(루프백) 인증 PLAIN, 한글, 점으로 시작하는 줄", async t => {
  const smtp = await startMockSmtp();
  t.after(() => smtp.stop());
  const text = "첫 줄\n.점으로 시작\n끝";
  await sendMail({ to: "cand@test.kr", subject: "합격 안내", text }, envFor(smtp, { SMTP_USER: "user1", SMTP_PASS: "pw1" }));
  assert.equal(smtp.received.length, 1);
  const m = smtp.received[0];
  assert.deepEqual(m.auth, { user: "user1", pass: "pw1" });
  assert.equal(m.from, "hr@company.test");
  assert.deepEqual(m.to, ["cand@test.kr"]);
  const p = parseMessage(m.raw);
  assert.equal(p.subject, "합격 안내");
  assert.equal(p.body, text);
});

test("SMTP 발송: AUTH LOGIN 폴백", async t => {
  const smtp = await startMockSmtp({ authMethods: "LOGIN" });
  t.after(() => smtp.stop());
  await sendMail({ to: "c@test.kr", subject: "s", text: "t" }, envFor(smtp, { SMTP_USER: "u2", SMTP_PASS: "p2" }));
  assert.deepEqual(smtp.received[0].auth, { user: "u2", pass: "p2" });
});

test("SMTP 발송: 수신 거부·미설정·잘못된 수신자는 오류", async t => {
  const smtp = await startMockSmtp({ rejectRcpt: true });
  t.after(() => smtp.stop());
  await assert.rejects(() => sendMail({ to: "c@test.kr", subject: "s", text: "t" }, envFor(smtp)), /거부/);
  await assert.rejects(() => sendMail({ to: "c@test.kr", subject: "s", text: "t" }, {}), e => e.code === "MAIL_NOT_CONFIGURED");
  await assert.rejects(() => sendMail({ to: "bad", subject: "s", text: "t" }, envFor(smtp)), e => e.code === "MAIL_BAD_RECIPIENT");
});

test("SMTP 발송: 암호화 없는 비루프백 서버로는 인증을 보내지 않는다", async () => {
  // 비루프백 호스트 이름이지만 연결 전에 거부되어야 하므로 포트는 임의 값이어도 된다.
  const net = require("node:net");
  const srv = net.createServer(s => { s.write("220 x\r\n"); s.on("data", d => { if (/EHLO/.test(String(d))) s.write("250-x\r\n250 AUTH PLAIN\r\n"); }); });
  await new Promise(r => srv.listen(0, "0.0.0.0", r));
  const env = { SMTP_HOST: "127.0.0.2", SMTP_PORT: String(srv.address().port), SMTP_FROM: "hr@x.test", SMTP_USER: "u", SMTP_PASS: "p", SMTP_TIMEOUT_MS: "2000" };
  try {
    await assert.rejects(() => sendMail({ to: "c@test.kr", subject: "s", text: "t" }, env), e => e.code === "MAIL_INSECURE_AUTH");
  } finally {
    srv.close(); srv.closeAllConnections && srv.closeAllConnections();
  }
});
