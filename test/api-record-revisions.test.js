"use strict";
// 수정·삭제된 레코드를 관리자가 "바뀌기 전" 내용으로 복구할 수 있는지 검증한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

const auth = (token, method, body) => ({ method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
async function data(api, token) { const r = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json(); assert.equal(r.ok, true); return r; }

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

  // 이전 내용으로 복구
  r = await (await api(`/api/record-revisions/${upd.id}/restore`, auth(token, "POST"))).json();
  assert.equal(r.ok, true);
  assert.equal(r.existed, true);
  // 삭제 되살리기
  r = await (await api(`/api/record-revisions/${del.id}/restore`, auth(token, "POST"))).json();
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
  const r = await (await api(`/api/record-revisions/${rev.id}/restore`, auth(boot.token, "POST"))).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  d = await data(api, boot.token);
  assert.equal(d.data.employees.find(e => e.id === "m1").name, "원래이름");
  const login = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: "m1", pw: "member-pw-1" }) })).json();
  assert.equal(login.ok, true, "복구 후에도 기존 비밀번호로 로그인된다");
});
