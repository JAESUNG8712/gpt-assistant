"use strict";
// 수정·삭제된 레코드를 관리자가 "바뀌기 전" 내용으로 복구할 수 있는지 검증한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

const auth = (token, method, body) => ({ method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
async function data(api, token) { const r = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json(); assert.equal(r.ok, true); return r; }
async function restore(api, token, id) {
  const preview = await (await api(`/api/record-revisions/${id}/preview`, auth(token, "GET"))).json();
  assert.equal(preview.ok, true, JSON.stringify(preview));
  return api(`/api/record-revisions/${id}/restore`, auth(token, "POST", { expectedToken: preview.expectedToken }));
}

test("이력은 중첩 인증정보를 보관하지 않고 직원 복구는 현재 2단계 인증을 유지한다", async t => {
  const server = await startServer(); t.after(() => server.stop());
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const { token } = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1" });
  const save = async payload => {
    const d = await data(api, token);
    const response = await api("/save", auth(token, "POST", { _version: d.version, ...payload }));
    const result = await response.json();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.notEqual(result.partial, true, JSON.stringify(result));
  };
  let d = await data(api, token);
  const member = { id: "secure-member", loginId: "secure-member", pw: "member-pw-123",
    name: "이전 이름", role: "member", active: true, twoFactorEnabled: false, twoFactorSecret: "old-otp-test-only",
    updatedAt: new Date().toISOString() };
  await save({ employees: [...d.data.employees, member],
    boardPosts: [{ id: "nested-secret", title: "원본", authorId: d.data.employees[0].id,
      custom: { accessToken: "nested-secret-test-only", label: "업무 설정" } }],
  });
  d = await data(api, token);
  await save({
    employees: d.data.employees.map(e => e.id === member.id ? { ...e, name: "현재 이름",
      twoFactorEnabled: true, twoFactorSecret: "new-otp-test-only", updatedAt: new Date(Date.now() + 2000).toISOString() } : e),
    boardPosts: d.data.boardPosts.map(p => ({ ...p, title: "수정", updatedAt: new Date(Date.now() + 2000).toISOString() })),
  });
  const list = await (await api("/api/record-revisions", auth(token, "GET"))).json();
  const employeeRevision = list.revisions.find(r => r.recordId === member.id);
  const nestedRevision = list.revisions.find(r => r.recordId === "nested-secret");
  assert.ok(employeeRevision); assert.ok(nestedRevision);
  const text = fs.readFileSync(server.dataFile.replace(/\.json$/, "-record-revisions.json"), "utf8");
  assert.ok(!text.includes("old-otp-test-only"));
  assert.ok(!text.includes("nested-secret-test-only"));
  const incomplete = await api(`/api/record-revisions/${nestedRevision.id}/preview`, auth(token, "GET"));
  assert.equal(incomplete.status, 409);
  assert.equal((await incomplete.json()).code, "REVISION_REDACTED");
  const direct = await api(`/api/record-revisions/${nestedRevision.id}/restore`, auth(token, "POST", { expectedToken: "a".repeat(64) }));
  assert.equal(direct.status, 409);
  assert.equal((await direct.json()).code, "REVISION_REDACTED");
  const preview = await (await api(`/api/record-revisions/${employeeRevision.id}/preview`, auth(token, "GET"))).json();
  assert.ok(!preview.changedFields.includes("twoFactorEnabled"));
  assert.equal((await restore(api, token, employeeRevision.id)).status, 200);
  const stored = JSON.parse(fs.readFileSync(server.dataFile, "utf8")).employees.find(e => e.id === member.id);
  assert.equal(stored.name, "이전 이름");
  assert.equal(stored.twoFactorEnabled, true);
  assert.equal(stored.twoFactorSecret, "new-otp-test-only");
  const nested = (await data(api, token)).data.boardPosts.find(p => p.id === "nested-secret");
  assert.equal(nested.title, "수정");
  assert.equal(nested.custom.accessToken, "nested-secret-test-only", "거절된 복구가 업무 원본을 지우면 안 된다");
});

test("수정·삭제 이력이 쌓이고 관리자가 이전 내용으로 복구·되살릴 수 있다", async t => {
  const server = await startServer(); t.after(() => server.stop());
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const token = boot.token;
  let d = await data(api, token);
  const adminId = String(d.data.employees[0].id);
  const base = { authorId: adminId, content: "", catId: "free", createdAt: new Date().toISOString() };
  let r = await api("/save", auth(token, "POST", { _version: d.version, boardPosts: [{ id: "p1", title: "원본 제목", ...base }, { id: "p2", title: "지울 글", ...base }] }));
  assert.equal(r.status, 200);

  // 수정
  d = await data(api, token);
  const p1 = d.data.boardPosts.find(p => p.id === "p1");
  r = await api("/save", auth(token, "POST", { _version: d.version, boardPosts: [{ ...p1, title: "잘못 고친 제목", updatedAt: new Date(Date.now() + 1000).toISOString() }, d.data.boardPosts.find(p => p.id === "p2")] }));
  assert.equal(r.status, 200);
  // 삭제
  d = await data(api, token);
  const p2 = d.data.boardPosts.find(p => p.id === "p2");
  r = await api("/save", auth(token, "POST", { _version: d.version, boardPosts: d.data.boardPosts.filter(p => p.id !== "p2"), recordTombstones: { boardPosts: [{ id: "p2", ts: Date.now(), rev: Number(p2._rev) || 0 }] } }));
  assert.equal(r.status, 200);
  d = await data(api, token);
  assert.equal(d.data.boardPosts.some(p => p.id === "p2"), false);

  const list = await (await api("/api/record-revisions?field=boardPosts", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(list.ok, true);
  const upd = list.revisions.find(x => x.recordId === "p1" && x.operation === "update");
  const del = list.revisions.find(x => x.recordId === "p2" && x.operation === "delete");
  assert.ok(upd, "수정 이력");
  assert.ok(del, "삭제 이력");
  assert.equal(upd.title, "원본 제목");

  assert.equal((await api(`/api/record-revisions/${upd.id}/restore`, auth(token, "POST"))).status, 428, "미리보기 없이 복원할 수 없다");
  const preview = await (await api(`/api/record-revisions/${upd.id}/preview`, auth(token, "GET"))).json();
  assert.equal(preview.affectedRecords, 1);
  assert.equal(preview.existed, true);
  assert.ok(!Object.hasOwn(preview, "snapshot"), "미리보기는 원본 민감값을 반환하지 않는다");
  d = await data(api, token);
  assert.equal((await api("/save", auth(token, "POST", { _version: d.version,
    boardPosts: d.data.boardPosts.map(p => p.id === "p1" ? { ...p, title: "동료의 최신 수정", updatedAt: new Date(Date.now() + 3000).toISOString() } : p) }))).status, 200);
  const conflict = await api(`/api/record-revisions/${upd.id}/restore`, auth(token, "POST", { expectedToken: preview.expectedToken }));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "REVISION_TARGET_CHANGED");
  assert.equal((await data(api, token)).data.boardPosts.find(p => p.id === "p1").title, "동료의 최신 수정");

  // 이전 내용으로 복구
  r = await (await restore(api, token, upd.id)).json();
  assert.equal(r.ok, true);
  assert.equal(r.existed, true);
  // 삭제 되살리기
  r = await (await restore(api, token, del.id)).json();
  assert.equal(r.ok, true);
  assert.equal(r.existed, false);
  d = await data(api, token);
  assert.equal(d.data.boardPosts.find(p => p.id === "p1").title, "원본 제목");
  assert.equal(d.data.boardPosts.find(p => p.id === "p2").title, "지울 글");

  // 복구 자체도 이력으로 남아 다시 되돌릴 수 있다 — 그리고 되살린 글이 다음 저장에서 다시 지워지지 않는다.
  r = await api("/save", auth(token, "POST", { _version: d.version, boardPosts: d.data.boardPosts, recordTombstones: d.data.recordTombstones || {} }));
  assert.equal(r.status, 200);
  d = await data(api, token);
  assert.equal(d.data.boardPosts.some(p => p.id === "p2"), true);
  const after = await (await api("/api/record-revisions?field=boardPosts&q=p1", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.ok(after.revisions.length >= 2, "복구도 새 이력을 남긴다");
});

test("일반 직원은 이력을 보거나 복구할 수 없다", async t => {
  const server = await startServer(); t.after(() => server.stop());
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const d = await data(api, boot.token);
  await api("/save", auth(boot.token, "POST", { _version: d.version, employees: [...d.data.employees, { id: "m1", loginId: "m1", pw: "member-pw-1", name: "직원", role: "member", active: true, dept: "개발" }] }));
  const m = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: "m1", pw: "member-pw-1" }) })).json();
  assert.equal((await api("/api/record-revisions", { headers: { Authorization: `Bearer ${m.token}` } })).status, 403);
  assert.equal((await api("/api/record-revisions/x/restore", auth(m.token, "POST"))).status, 403);
  assert.equal((await api("/api/record-revisions/nope/restore", auth(boot.token, "POST"))).status, 404);
  assert.equal((await api("/api/record-revisions?field=bogus", { headers: { Authorization: `Bearer ${boot.token}` } })).status, 400);
});

test("삭제된 직원을 복구해도 삭제 전 로그인 토큰은 다시 유효해지지 않는다", async t => {
  const server = await startServer(); t.after(() => server.stop());
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const { token } = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1" });
  let d = await data(api, token);
  const member = { id: "revived-member", loginId: "revived-member", pw: "member-pw-123",
    name: "복구 대상", role: "member", active: true, updatedAt: new Date().toISOString() };
  await api("/save", auth(token, "POST", { _version: d.version, employees: [...d.data.employees, member] }));
  const oldLogin = await (await api("/login", auth(token, "POST", { loginId: member.loginId, pw: member.pw }))).json();
  assert.equal(oldLogin.ok, true);
  d = await data(api, token);
  await api("/save", auth(token, "POST", { _version: d.version, employees: d.data.employees.map(e =>
    e.id === member.id ? { ...e, name: "수정 이름", updatedAt: new Date(Date.now() + 1000).toISOString() } : e) }));
  const revisions = await (await api("/api/record-revisions?field=employees", auth(token, "GET"))).json();
  const revision = revisions.revisions.find(r => r.recordId === member.id);
  assert.ok(revision);
  d = await data(api, token);
  await api("/save", auth(token, "POST", { _version: d.version, employees: d.data.employees.filter(e => e.id !== member.id) }));
  assert.equal((await api("/data", auth(oldLogin.token, "GET"))).status, 401);
  assert.equal((await restore(api, token, revision.id)).status, 200);
  assert.equal((await api("/data", auth(oldLogin.token, "GET"))).status, 401, "복구 이후에도 과거 토큰은 철회 상태여야 한다");
});

test("직원 정보를 되돌려도 현재 비밀번호는 바뀌지 않는다", async t => {
  const server = await startServer(); t.after(() => server.stop());
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  let d = await data(api, boot.token);
  await api("/save", auth(boot.token, "POST", { _version: d.version, employees: [...d.data.employees, { id: "m1", loginId: "m1", pw: "member-pw-1", name: "원래이름", role: "member", active: true, dept: "개발" }] }));
  d = await data(api, boot.token);
  const m1 = d.data.employees.find(e => e.id === "m1");
  await api("/save", auth(boot.token, "POST", { _version: d.version, employees: d.data.employees.map(e => e.id === "m1" ? { ...m1, name: "바뀐이름", updatedAt: new Date(Date.now() + 2000).toISOString() } : e) }));
  const list = await (await api("/api/record-revisions?field=employees", { headers: { Authorization: `Bearer ${boot.token}` } })).json();
  const rev = list.revisions.find(x => x.recordId === "m1");
  assert.ok(rev);
  const r = await (await restore(api, boot.token, rev.id)).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  d = await data(api, boot.token);
  assert.equal(d.data.employees.find(e => e.id === "m1").name, "원래이름");
  const login = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: "m1", pw: "member-pw-1" }) })).json();
  assert.equal(login.ok, true, "복구 후에도 기존 비밀번호로 로그인된다");
});

test("복구 이력도 원래 업무 메뉴 권한을 지키고 불완전한 보관본은 복구하지 않는다", async t => {
  const server = await startServer(); t.after(() => server.stop());
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const token = boot.token;
  let d = await data(api, token);
  const adminId = d.data.employees[0].id;
  const restricted = { id: "restricted", loginId: "restricted", pw: "restricted-pw-123",
    name: "제한 관리자", role: "admin", active: true, menuPerms: { history: true, "employment-records": false } };
  await api("/save", auth(token, "POST", { _version: d.version, employees: [...d.data.employees, restricted],
    employmentRecords: [{ id: "contract1", employeeId: adminId, type: "contract", title: "원본 계약", startDate: "2026-01-01" }],
    boardPosts: [{ id: "large-post", authorId: adminId, title: "원본 글", content: "x".repeat(100001), createdAt: new Date().toISOString() }],
  }));
  d = await data(api, token);
  assert.equal(d.data.employmentRecords.length, 1);
  await api("/save", auth(token, "POST", { _version: d.version,
    employmentRecords: d.data.employmentRecords.map(r => ({ ...r, title: "수정 계약", updatedAt: new Date(Date.now() + 1000).toISOString() })),
    boardPosts: d.data.boardPosts.map(r => ({ ...r, title: "수정 글", updatedAt: new Date(Date.now() + 1000).toISOString() })),
  }));
  const revisions = (await (await api("/api/record-revisions", auth(token, "GET"))).json()).revisions;
  const contract = revisions.find(r => r.recordId === "contract1");
  const large = revisions.find(r => r.recordId === "large-post");
  assert.ok(contract); assert.ok(large);
  const login = await (await api("/login", auth(token, "POST", { loginId: restricted.loginId, pw: restricted.pw }))).json();
  assert.equal(login.ok, true);
  const restrictedList = await (await api("/api/record-revisions", auth(login.token, "GET"))).json();
  assert.ok(!restrictedList.revisions.some(r => r.field === "employmentRecords"), "차단한 메뉴의 제목도 이력에서 숨겨야 함");
  assert.equal((await api(`/api/record-revisions/${contract.id}/restore`, auth(login.token, "POST"))).status, 403);
  const incomplete = await api(`/api/record-revisions/${large.id}/restore`, auth(token, "POST"));
  assert.equal(incomplete.status, 409);
  assert.equal((await incomplete.json()).code, "REVISION_INCOMPLETE");
  d = await data(api, token);
  assert.equal(d.data.employmentRecords[0].title, "수정 계약");
  assert.equal(d.data.boardPosts[0].content.length, 100001, "복구가 생략된 큰 본문을 지우면 안 됨");
});

test("확정된 급여의 복구 거부는 성공으로 표시하지 않는다", async t => {
  const server = await startServer(); t.after(() => server.stop());
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const token = boot.token;
  let d = await data(api, token);
  const draft = { id: "salary-restore", empId: d.data.employees[0].id, year: 2026, month: 10,
    gross: 3000000, netPay: 2700000, confirmed: false, updatedAt: new Date().toISOString() };
  await api("/save", auth(token, "POST", { _version: d.version, payslips: [draft] }));
  d = await data(api, token);
  await api("/save", auth(token, "POST", { _version: d.version,
    payslips: [{ ...d.data.payslips[0], confirmed: true, updatedAt: new Date(Date.now() + 1000).toISOString() }] }));
  const list = await (await api("/api/record-revisions?field=payslips", auth(token, "GET"))).json();
  assert.ok(list.revisions.length);
  const res = await restore(api, token, list.revisions[0].id);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "REVISION_RESTORE_REJECTED");
  d = await data(api, token);
  assert.equal(d.data.payslips[0].confirmed, true);
});
