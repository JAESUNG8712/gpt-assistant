"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

test("U 접두어 제거는 ID만 바꾸고 비밀번호를 보존한다",async(t)=>{
  const server=await startServer();t.after(()=>server.stop());
  const boot=await bootstrapAdminAndLogin(server,{loginId:"admin",pw:"admin-password",name:"관리자"});
  const api=(path,options={})=>fetch(server.baseUrl+path,{...options,headers:{Authorization:`Bearer ${boot.token}`,...(options.headers||{})}});
  const state=await(await api("/data")).json();
  const additions=[{id:"emp-u-1",name:"직원1",empNo:"1001",loginId:"U1001",pw:"original-password-1",role:"member",active:true},{id:"emp-u-2",name:"직원2",empNo:"1002",loginId:"u1002",pw:"original-password-2",role:"member",active:true},{id:"emp-inactive",name:"퇴직직원",empNo:"1099",loginId:"U1099",pw:"original-password-9",role:"member",active:false},{id:"emp-plain",name:"직원3",empNo:"1003",loginId:"1003",pw:"original-password-3",role:"member",active:true}];
  let res=await api("/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({_version:state.version,data:{...state.data,employees:[...state.data.employees,...additions]}})});assert.equal(res.status,200);
  let preview=await(await api("/api/admin/employee-login-ids/normalize-preview")).json();assert.equal(preview.targets.length,3);assert.equal(preview.conflicts.length,0);assert.equal(preview.canApply,true);
  res=await api("/api/admin/employee-login-ids/normalize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:"WRONG"})});assert.equal(res.status,400);
  res=await api("/api/admin/employee-login-ids/normalize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:"REMOVE_U_PREFIX"})});assert.equal(res.status,200);assert.equal((await res.json()).changed,3);
  for(const [loginId,pw] of [["1001","original-password-1"],["1002","original-password-2"]]){const login=await fetch(server.baseUrl+"/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({loginId,pw})});assert.equal((await login.json()).ok,true,`${loginId}는 기존 비밀번호로 로그인돼야 한다`);}
  const after=await(await api("/data")).json();assert.equal(after.data.employees.find(e=>e.id==="emp-inactive").loginId,"1099");
  preview=await(await api("/api/admin/employee-login-ids/normalize-preview")).json();assert.equal(preview.targets.length,0);
});

test("목표 ID가 이미 있으면 모든 변경을 취소한다",async(t)=>{
  const server=await startServer();t.after(()=>server.stop());
  const boot=await bootstrapAdminAndLogin(server,{loginId:"admin",pw:"admin-password",name:"관리자"});
  const api=(path,options={})=>fetch(server.baseUrl+path,{...options,headers:{Authorization:`Bearer ${boot.token}`,...(options.headers||{})}});
  const state=await(await api("/data")).json();
  const employees=[...state.data.employees,{id:"existing",name:"기존 직원",empNo:"X2001",loginId:"2001",pw:"existing-password",role:"member",active:true},{id:"target",name:"변경 대상",empNo:"2001",loginId:"U2001",pw:"target-password",role:"member",active:true}];
  let res=await api("/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({_version:state.version,data:{...state.data,employees}})});assert.equal(res.status,200);
  const preview=await(await api("/api/admin/employee-login-ids/normalize-preview")).json();assert.equal(preview.conflicts.length,1);assert.equal(preview.canApply,false);
  res=await api("/api/admin/employee-login-ids/normalize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:"REMOVE_U_PREFIX"})});assert.equal(res.status,409);
  const after=await(await api("/data")).json();assert.equal(after.data.employees.find(e=>e.id==="target").loginId,"U2001");
});
