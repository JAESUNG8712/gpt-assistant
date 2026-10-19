"use strict";
// 저장이 거부·되돌려질 때 응답이 "왜"(reason/level/message)를 함께 알리는지 검증한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

const auth = (token, method, body) => ({ method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
async function data(api, token) { const r = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json(); assert.equal(r.ok, true); return r; }
async function login(api, loginId, pw) { const r = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId, pw }) })).json(); assert.equal(r.ok, true); return r.token; }

test("거부된 저장은 사유 코드·수준·사용자용 메시지를 함께 돌려준다", async t => {
  const server = await startServer(); t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  let d = await data(api, boot.token);
  const employees = [...d.data.employees,
    { id: "member1", loginId: "member1", pw: "member-test-pw-1", name: "직원", role: "member", active: true, dept: "개발", team: "A" }];
  let r = await api("/save", auth(boot.token, "POST", { _version: d.version, employees }));
  assert.equal(r.status, 200);
  d = await data(api, boot.token);

  // 1) 존재하지 않는 직원을 참조하는 계약 기록 → EMPLOYEE_REF
  r = await api("/save", auth(boot.token, "POST", { _version: d.version, employmentRecords: [{ id: "x1", employeeId: "ghost", type: "contract", title: "t", status: "active", startDate: "2026-01-01" }] }));
  let body = await r.json();
  assert.equal(body.partial, true);
  const row = body.warnings.rejectedRecords.find(x => x.id === "x1");
  assert.equal(row.reason, "EMPLOYEE_REF");
  assert.equal(row.level, "error");
  assert.ok(row.message.length > 5);

  // 2) 일반 직원이 관리자 전용 컬렉션에 쓰기 → 사유가 반드시 존재(조용히 버리지 않음)
  const memberToken = await login(api, "member1", "member-test-pw-1");
  const md = await data(api, memberToken);
  r = await api("/save", auth(memberToken, "POST", { _version: md.version, employmentRecords: [{ id: "forged", employeeId: "member1", type: "contract", title: "위조", status: "active", startDate: "2026-01-01" }] }));
  body = await r.json();
  assert.equal(body.partial, true);
  const forged = body.warnings.rejectedRecords.find(x => x.id === "forged");
  assert.ok(forged, "거부 항목이 보고되어야 한다");
  assert.ok(forged.reason && forged.level && forged.message);

  // 3) 정상 저장은 partial이 아니다(오탐 없음)
  d = await data(api, boot.token);
  r = await api("/save", auth(boot.token, "POST", { _version: d.version, boardPosts: [{ id: "bp1", title: "공지", content: "x", catId: "free", authorId: "admin" }] }));
  body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(!!body.partial, false, JSON.stringify(body.warnings));
});
