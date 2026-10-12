"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

const auth = (token, method, body) => ({ method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
async function data(api, token) { const r = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json(); assert.equal(r.ok, true); return r; }
async function login(api, loginId, pw) { const r = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId, pw }) })).json(); assert.equal(r.ok, true); return r.token; }

test("계약·징계 원장은 관리자 전용으로 저장·조회된다", async t => {
  const server = await startServer(); t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  let d = await data(api, boot.token);
  const employees = [...d.data.employees,
    { id: "member1", loginId: "member1", pw: "member-test-pw-1", name: "직원", role: "member", active: true, dept: "개발" },
    { id: "limitedAdmin", loginId: "limitedAdmin", pw: "limited-admin-pw-1", name: "제한 관리자", role: "admin", active: true, dept: "인사", menuPerms: { "employment-records": false } },
    { id: "inactiveAdmin", loginId: "inactiveAdmin", pw: "inactive-admin-pw-1", name: "퇴직 관리자", role: "admin", active: false, dept: "인사" },
  ];
  const original = { id: "er1", employeeId: "member1", type: "contract", title: "기간제 근로계약", status: "active", startDate: "2026-01-01", endDate: "2026-12-31" };
  let r = await api("/save", auth(boot.token, "POST", { _version: d.version, employees, employmentRecords: [original] }));
  assert.equal(r.status, 200);
  d = await data(api, boot.token);
  assert.equal(d.data.employmentRecords.length, 1);
  assert.equal(d.data.employmentRecords[0].createdBy, String(boot.user?.id || d.data.employees.find(e => e.loginId === "admin").id));
  const orphan={...original,id:"orphan",employeeId:"missing-employee"};
  r=await api("/save",auth(boot.token,"POST",{_version:d.version,employmentRecords:[...d.data.employmentRecords,orphan]}));
  assert.equal(r.status,200);
  assert.deepEqual((await r.json()).warnings.rejectedRecords,[{field:"employmentRecords",id:"orphan"}]);
  d=await data(api,boot.token);
  assert.equal(d.data.employmentRecords.some(x=>x.id==="orphan"),false,"없는 직원의 계약 기록은 저장하지 않는다");
  r=await api("/save",auth(boot.token,"POST",{_version:d.version,employmentRecords:[{...d.data.employmentRecords[0],employeeId:"missing-employee"}]}));
  assert.equal(r.status,200);
  assert.equal((await r.json()).partial,true);
  d=await data(api,boot.token);
  assert.equal(d.data.employmentRecords[0].employeeId,"member1","기존 계약의 대상 변경도 검증한다");
  const ownerId=String(boot.user?.id || d.data.employees.find(e=>e.loginId==="admin").id);
  r=await api("/save",auth(boot.token,"POST",{_version:d.version,employmentRecords:[{...d.data.employmentRecords[0],reviewStatus:"completed",reviewDecision:"renew"}]}));
  assert.equal(r.status,200);
  let saveResult=await r.json();
  assert.equal(saveResult.partial,true);
  assert.deepEqual(saveResult.warnings.rejectedRecords,[{field:"employmentRecords",id:"er1"}]);
  d=await data(api,boot.token);
  assert.equal(d.data.employmentRecords[0].reviewStatus,"open","담당자 없는 완료 처리는 거부한다");
  for(const invalidOwner of ["member1","missing-owner","limitedAdmin","inactiveAdmin"]){
    r=await api("/save",auth(boot.token,"POST",{_version:d.version,employmentRecords:[{...d.data.employmentRecords[0],reviewOwnerId:invalidOwner,reviewStatus:"completed",reviewDecision:"renew"}]}));
    assert.equal(r.status,200);
    saveResult=await r.json();
    assert.equal(saveResult.partial,true,`${invalidOwner}는 검토 담당자가 될 수 없다`);
    d=await data(api,boot.token);
    assert.equal(d.data.employmentRecords[0].reviewStatus,"open");
  }
  r=await api("/save",auth(boot.token,"POST",{_version:d.version,employmentRecords:[{...d.data.employmentRecords[0],reviewOwnerId:ownerId,reviewStatus:"completed",reviewDecision:"renew",reviewNote:"갱신 조건 확인",reviewEvents:[{actorId:"forged"}]}]}));
  assert.equal(r.status,200);d=await data(api,boot.token);
  assert.equal(d.data.employmentRecords[0].reviewStatus,"completed");
  assert.equal(d.data.employmentRecords[0].reviewEvents.length,1);
  assert.equal(d.data.employmentRecords[0].reviewEvents[0].actorId,ownerId,"검토 이력은 서버가 작성한다");
  r=await api("/save",auth(boot.token,"POST",{_version:d.version,employmentRecords:[d.data.employmentRecords[0]]}));
  assert.equal(r.status,200);d=await data(api,boot.token);
  assert.equal(d.data.employmentRecords[0].reviewEvents.length,1,"동일 상태 재저장에 중복 이력이 생기지 않는다");
  const staleVersion=d.version;
  r=await api("/save",auth(boot.token,"POST",{_version:d.version,boardPosts:[{id:"merge-probe",title:"동시 저장 확인",updatedAt:new Date().toISOString()}]}));
  assert.equal(r.status,200);
  r=await api("/save",auth(boot.token,"POST",{_version:staleVersion,employmentRecords:[d.data.employmentRecords[0]]}));
  saveResult=await r.json();
  assert.equal(saveResult.merged,true,"서버가 stale 요청을 병합했음을 명시한다");
  assert.equal(saveResult.mergedData.employmentRecords[0].reviewStatus,"completed","병합 응답은 실제 저장 상태를 돌려준다");
  d=await data(api,boot.token);
  for(let i=0;i<50;i++){
    r=await api("/save",auth(boot.token,"POST",{_version:d.version,employmentRecords:[{...d.data.employmentRecords[0],reviewNote:`검토 ${i}`}]}));
    assert.equal(r.status,200);
    d=await data(api,boot.token);
  }
  assert.equal(d.data.employmentRecords[0].reviewEvents.length,51,"검토 이력은 50건을 넘어도 손실 없이 누적한다");
  r=await api("/save",auth(boot.token,"POST",{_version:d.version,employmentRecords:[d.data.employmentRecords[0]]}));
  assert.equal(r.status,200);
  d=await data(api,boot.token);
  assert.equal(d.data.employmentRecords[0].reviewEvents.length,51,"무관한 저장이 검토 이력을 줄이면 안 된다");

  const member = await login(api, "member1", "member-test-pw-1");
  const memberData = await data(api, member);
  assert.deepEqual(memberData.data.employmentRecords, [], "일반 사용자 응답에는 민감 원장이 없어야 한다");

  r = await api("/save", auth(member, "POST", { _version: memberData.version, employmentRecords: [{ ...original, id: "forged", title: "위조" }] }));
  assert.equal(r.status, 200);
  d = await data(api, boot.token);
  assert.equal(d.data.employmentRecords.some(x => x.id === "forged"), false, "일반 사용자의 신규 원장 기록은 거부돼야 한다");

  const limitedAdmin = await login(api, "limitedAdmin", "limited-admin-pw-1");
  const limitedData = await data(api, limitedAdmin);
  assert.deepEqual(limitedData.data.employmentRecords, [], "메뉴가 차단된 관리자에게도 원장을 내려주지 않아야 한다");
  r = await api("/save", auth(limitedAdmin, "POST", { _version: limitedData.version, employmentRecords: [{ ...original, id: "menu-forged" }] }));
  assert.equal(r.status, 200);
  d = await data(api, boot.token);
  assert.equal(d.data.employmentRecords.some(x => x.id === "menu-forged"), false, "메뉴가 차단된 관리자의 쓰기도 거부돼야 한다");

  const malformed = { id: "bad", employeeId: "member1", type: "contract", title: "역전", status: "active", startDate: "2026-12-31", endDate: "2026-01-01" };
  r = await api("/save", auth(boot.token, "POST", { _version: d.version, employmentRecords: [...d.data.employmentRecords, malformed] }));
  assert.equal(r.status, 200);
  saveResult=await r.json();
  assert.equal(saveResult.partial,true);
  assert.deepEqual(saveResult.warnings.rejectedRecords,[{field:"employmentRecords",id:"bad"}]);
  assert.equal(saveResult.mergedData.employmentRecords.some(x => x.id === "bad"),false,"거부된 입력을 병합 응답에 다시 내려주면 안 된다");
  d = await data(api, boot.token);
  assert.equal(d.data.employmentRecords.some(x => x.id === "bad"), false, "역전된 계약기간은 서버에서 거부돼야 한다");
  r = await api("/save", auth(boot.token, "POST", { _version: d.version, employmentRecords: [{ ...original, id: "invalid-calendar", startDate: "2026-02-30" }] }));
  assert.equal(r.status, 200);
  d = await data(api, boot.token);
  assert.equal(d.data.employmentRecords.some(x => x.id === "invalid-calendar"), false, "존재하지 않는 계약 날짜도 저장하지 않는다");
});
