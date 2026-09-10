"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

test("회계 기본 계정과 회사별 전표 템플릿을 안전하게 CRUD한다", async (t) => {
  const server = await startServer(); t.after(() => server.stop());
  const boot = await bootstrapAdminAndLogin(server, { loginId:"acct_admin", pw:"acct-admin-password", name:"회계 관리자" });
  const api = (path, options={}) => fetch(server.baseUrl+path,{...options,headers:{Authorization:`Bearer ${boot.token}`,...(options.headers||{})}});
  let res=await api("/api/accounting/accounts"), json=await res.json();
  assert.equal(res.status,200); assert.ok(json.accounts.length>=2,"기본 계정과목이 제공돼야 한다");
  const made=[];
  for(const body of [{code:"CUST-511",name:"회사 맞춤 비용",type:"expense",category:"맞춤 비용"},{code:"CUST-253",name:"회사 맞춤 미지급금",type:"liability",category:"맞춤 부채"}]){
    res=await api("/api/accounting/accounts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    assert.equal(res.status,200); made.push((await res.json()).account);
  }
  res=await api("/api/accounting/accounts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"cust-511",name:"중복",type:"expense"})});
  assert.equal(res.status,400,"대소문자만 다른 코드도 중복이어야 한다");
  res=await api("/api/accounting/accounts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"공백 코드",name:"오류",type:"expense"})});
  assert.equal(res.status,400,"안전하지 않은 코드는 거부해야 한다");
  const body={name:"복리후생비 미지급 전표",category:"인사 비용",description:"월 복리후생비 인식 예시",lines:[{accountCode:made[0].code,side:"debit",memo:"복리후생비"},{accountCode:made[1].code,side:"credit",memo:"미지급금"}]};
  res=await api("/api/accounting/voucher-templates",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  assert.equal(res.status,200); const created=(await res.json()).template;
  json=await (await api("/api/accounting/voucher-templates")).json(); assert.equal(json.templates.length,1);
  res=await api("/api/accounting/voucher-templates",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,id:created.id,expectedUpdatedAt:"stale"})});
  assert.equal(res.status,409,"오래된 화면이 템플릿을 덮어쓰면 안 된다");
  res=await api("/api/accounting/voucher-templates",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,name:"잘못된 계정",lines:[{accountCode:"UNKNOWN",side:"debit"},{accountCode:made[1].code,side:"credit"}]})});
  assert.equal(res.status,400);
  const lines=[{accountId:made[0].id,debit:100,credit:0},{accountId:made[1].id,debit:0,credit:100}];
  res=await api("/api/accounting/vouchers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({date:"2026-09-10",description:"",lines})}); assert.equal(res.status,400);
  res=await api("/api/accounting/vouchers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({date:"2026-02-31",description:"존재하지 않는 날짜",lines})}); assert.equal(res.status,400);
  res=await api("/api/accounting/vouchers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({date:"2026-09-10",description:"금액 없는 라인",lines:[...lines,{accountId:made[0].id,debit:0,credit:0}]})}); assert.equal(res.status,400);
  res=await api("/api/accounting/vouchers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({date:"2026-09-10",description:"복리후생비 인식",lines})}); assert.equal(res.status,200);
  res=await api(`/api/accounting/voucher-templates/${encodeURIComponent(created.id)}`,{method:"DELETE"}); assert.equal(res.status,200);
  json=await (await api("/api/accounting/voucher-templates")).json(); assert.equal(json.templates.length,0);
});
