"use strict";
const assert = require("node:assert/strict");
const { totp } = require("./totp");
const auth = (token, method = "GET", body) => ({ method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body) });

async function exerciseTwoFactor(api, adminToken, companyCode) {
  const member = { id: "two-factor-member", loginId: "two-factor-member", name: "인증 시험", role: "member", active: true,
    pw: "SyntheticPassword123", updatedAt: new Date().toISOString() };
  const state = async token => {
    const r = await api("/data", auth(token)); assert.equal(r.status, 200);
    return r.json();
  };
  const adminSave = async change => {
    const d = await state(adminToken);
    const r = await api("/save", auth(adminToken, "POST", { _version: d.version, employees: change(d.data.employees) }));
    assert.equal(r.status, 200, await r.text());
  };
  await adminSave(rows => [...rows, member]);
  const login = async otp => (await api("/login", auth(null, "POST", { loginId: member.loginId, pw: member.pw, companyCode, otp }))).json();
  const initial = await login(); assert.ok(initial.token);
  assert.equal((await api("/api/auth/2fa/settings", auth(null, "POST", {}))).status, 401);
  assert.equal((await api("/api/auth/2fa/generate-secret", auth(null, "POST", { pw: member.pw }))).status, 401);
  const generated = await (await api("/api/auth/2fa/generate-secret", auth(initial.token, "POST", {
    loginId: "not-the-current-user", pw: member.pw,
  }))).json();
  assert.equal(generated.ok, true, JSON.stringify(generated));
  const secret = generated.secret;
  assert.match(secret, /^[A-Z2-7]{32}$/);
  const update = (token, body) => api("/api/auth/2fa/settings", auth(token, "POST", body));
  assert.equal((await update(initial.token, { enabled: true, currentPassword: "wrong", secret, otp: totp(secret) })).status, 403);
  // Two requests admitted under the same session must not both mutate settings.
  const attempts = await Promise.all([0, 1].map(() => update(initial.token, {
    enabled: true, currentPassword: member.pw, secret, otp: totp(secret), employeeId: "someone-else",
  })));
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 401]);
  const enabled = await attempts.find(r => r.status === 200).json();
  assert.ok(enabled.token); assert.equal(enabled.twoFactorEnabled, true);
  assert.equal((await api("/data", auth(initial.token))).status, 401);
  assert.equal((await login()).requireOtp, true);
  const otpLogin = await login(totp(secret)); assert.ok(otpLogin.token);
  const visible = (await state(enabled.token)).data.employees.find(e => e.id === member.id);
  assert.equal(Object.hasOwn(visible, "twoFactorSecret"), false);
  // Admin updates and stale/malicious full-state payloads must preserve hidden auth.
  await adminSave(rows => rows.map(e => e.id === member.id ? { ...e, name: "수정된 이름",
    twoFactorEnabled: false, twoFactorSecret: "attacker-controlled", updatedAt: new Date(Date.now() + 1000).toISOString() } : e));
  assert.equal((await login()).requireOtp, true);
  assert.ok((await login(totp(secret))).token, "일반 정보 저장 후에도 기존 인증 코드로 로그인해야 한다");
  const invalidCodes = new Set([-2, -1, 0, 1, 2].map(w => totp(secret, Date.now() + w * 30000)));
  let invalid = "000000";
  while (invalidCodes.has(invalid)) invalid = String(Number(invalid) + 1).padStart(6, "0");
  const denied = await update(enabled.token, { enabled: false, currentPassword: member.pw,
    secret: "CLIENT_SECRET_MUST_NOT_BE_TRUSTED", otp: invalid });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "INVALID_OTP");
  const disabledResponse = await update(enabled.token, { enabled: false, currentPassword: member.pw, otp: totp(secret) });
  assert.equal(disabledResponse.status, 200);
  const disabled = await disabledResponse.json(); assert.equal(disabled.twoFactorEnabled, false);
  assert.equal((await api("/data", auth(enabled.token))).status, 401);
  assert.equal((await api("/data", auth(otpLogin.token))).status, 401);
  assert.ok((await login()).token);
  assert.equal((await state(disabled.token)).data.employees.find(e => e.id === member.id).name, "수정된 이름");
}
module.exports = { exerciseTwoFactor };
