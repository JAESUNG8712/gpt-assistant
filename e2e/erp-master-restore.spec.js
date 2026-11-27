const { test, expect } = require("./fixtures");
for (const kind of ["items", "locations"]) {
  test(kind+": stale editor asks before restoring a deleted record and preserves cancelled input", async ({ page }) => {
    const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto("/");await page.fill("#l-id","e2e_admin");await page.fill("#l-pw","E2eTestPw123");
    await page.evaluate(()=>{autoSaveDebounced=()=>{};loadFromServer=async()=>{};connectSSE=async()=>{};});
    await page.click(".login-card button.btn-primary");await expect(page.locator("#main")).toBeVisible();
    const id=await page.evaluate(async kind=>{
      const id="restore-e2e-"+crypto.randomUUID();
      const response=await serverRequest("POST","/api/erp/"+kind,{id,code:id,name:"복원 전 이름"});
      if(!response.ok)throw Error(response.message);
      if(kind==="items"){erpItems=[response.item];openItemModal(id);}
      else {erpLocations=[response.location];openLocationModal(id);}
      const removed=await serverRequest("POST","/api/erp/"+kind+"/"+id+"/delete",{_rev:(response.item||response.location)._rev});
      if(!removed.ok)throw Error(removed.message);
      return id;
    },kind);
    const input=kind==="items"?"#item-name":"#loc-name";
    await page.fill(input,"입력 중인 복원 내용");
    await page.getByRole("button",{name:"저장",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"삭제된 자료 복원 확인"});
    await expect(dialog).toBeVisible();await dialog.getByRole("button",{name:"취소",exact:true}).click();
    await expect(page.locator(input)).toHaveValue("입력 중인 복원 내용");
    expect(await page.evaluate(async ({kind,id})=>(await serverRequest("GET","/api/erp/"+kind))[kind].some(row=>row.id===id),{kind,id})).toBe(false);
    await page.getByRole("button",{name:"저장",exact:true}).click();
    await dialog.getByRole("button",{name:"복원하여 저장",exact:true}).click();
    await expect(page.locator(input)).toHaveCount(0);
    const saved=await page.evaluate(async ({kind,id})=>(await serverRequest("GET","/api/erp/"+kind))[kind].find(row=>row.id===id),{kind,id});
    expect(saved.name).toBe("입력 중인 복원 내용");expect(errors).toEqual([]);
  });
}

for (const kind of ["items", "locations"]) {
  test(kind+": stale editor retains input, reloads explicitly and then saves", async ({page}) => {
    const errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto("/");await page.fill("#l-id","e2e_admin");await page.fill("#l-pw","E2eTestPw123");
    await page.evaluate(()=>{autoSaveDebounced=()=>{};loadFromServer=async()=>{};connectSSE=async()=>{};});
    await page.click(".login-card button.btn-primary");await expect(page.locator("#main")).toBeVisible();
    const id=await page.evaluate(async kind=>{
      const key=kind==="items"?"item":"location";
      const id="conflict-e2e-"+crypto.randomUUID();
      const original=(await serverRequest("POST","/api/erp/"+kind,{id,code:id,name:"원래 내용"}))[key];
      if(!original)throw Error("create failed");
      if(kind==="items"){erpItems=[original];openItemModal(id);}
      else {erpLocations=[original];openLocationModal(id);}
      const saved=await serverRequest("POST","/api/erp/"+kind,{...original,name:"다른 사용자가 저장한 내용"});
      if(!saved.ok)throw Error(saved.message);
      // Background cache refresh must not silently upgrade the open editor revision.
      if(kind==="items")erpItems=[saved[key]];else erpLocations=[saved[key]];
      return id;
    },kind);
    const input=kind==="items"?"#item-name":"#loc-name";
    await page.fill(input,"내가 편집 중인 내용");
    await page.getByRole("button",{name:"저장",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"다른 사용자의 변경 내용 확인"});
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button",{name:"입력 유지",exact:true}).click();
    await expect(page.locator(input)).toHaveValue("내가 편집 중인 내용");
    expect(await page.evaluate(async ({kind,id})=>(await serverRequest("GET","/api/erp/"+kind))[kind].find(row=>row.id===id).name,{kind,id})).toBe("다른 사용자가 저장한 내용");
    await page.getByRole("button",{name:"저장",exact:true}).click();
    await dialog.getByRole("button",{name:"최신 내용 불러오기",exact:true}).click();
    await expect(page.locator(input)).toHaveValue("다른 사용자가 저장한 내용");
    await page.fill(input,"확인 후 수정한 내용");
    await page.getByRole("button",{name:"저장",exact:true}).click();
    await expect(page.locator(input)).toHaveCount(0);
    expect(await page.evaluate(async ({kind,id})=>(await serverRequest("GET","/api/erp/"+kind))[kind].find(row=>row.id===id).name,{kind,id})).toBe("확인 후 수정한 내용");
    expect(errors).toEqual([]);
  });
}

for(const kind of ["items","locations","sales-targets"]){
  test(kind+": delete confirmation rejects changed data and requires a fresh confirmation",async({page})=>{
    await page.goto("/");await page.fill("#l-id","e2e_admin");await page.fill("#l-pw","E2eTestPw123");
    await page.evaluate(()=>{autoSaveDebounced=()=>{};loadFromServer=async()=>{};connectSSE=async()=>{};});
    await page.click(".login-card button.btn-primary");await expect(page.locator("#main")).toBeVisible();
    const original=await page.evaluate(async kind=>{
      const key=kind==="items"?"item":kind==="locations"?"location":"salesTarget";
      const id="delete-race-"+crypto.randomUUID();
      const r=await serverRequest("POST","/api/erp/"+kind,{id,code:id,name:"삭제 전 내용",year:2032,month:3,targetAmount:12345,employeeName:"삭제 대상 담당자"});
      if(!r.ok)throw Error(r.message);
      if(kind==="items"){erpItems=[r[key]];void deleteItem(id);}
      else if(kind==="locations"){erpLocations=[r[key]];void deleteLocation(id);}
      else {_salesDashData=await serverRequest("GET","/api/erp/sales-dashboard");void deleteSalesTarget(id);}
      return r[key];
    },kind);
    const title=kind==="items"?"품목 삭제 확인":kind==="locations"?"창고/위치 삭제 확인":"영업 목표 삭제 확인";
    const button=kind==="items"?"품목 삭제":kind==="locations"?"위치 삭제":"영업 목표 삭제";
    const dialog=page.getByRole("dialog",{name:title});await expect(dialog).toBeVisible();
    if(kind==="sales-targets"){
      await expect(dialog).toContainText("12,345원");await expect(dialog).toContainText("2032 3월");await expect(dialog).toContainText("삭제 대상 담당자");
    }
    await page.evaluate(async({kind,original})=>{
      const r=await serverRequest("POST","/api/erp/"+kind,{...original,name:"다른 사용자가 수정",targetAmount:23456});if(!r.ok)throw Error(r.message);
      if(kind==="items")erpItems=[r.item];else if(kind==="locations")erpLocations=[r.location];
    },{kind,original});
    await dialog.getByRole("button",{name:button,exact:true}).click();
    await expect(page.getByText(/다른 작업에서 변경되어 삭제하지 않았습니다/)).toBeVisible();
    const field=kind==="sales-targets"?"salesTargets":kind;
    expect(await page.evaluate(async({kind,field,id})=>(await serverRequest("GET","/api/erp/"+kind))[field].some(row=>row.id===id),{kind,field,id:original.id})).toBe(true);
    await page.evaluate(async({kind,id})=>{
      if(kind==="items")void deleteItem(id);else if(kind==="locations")void deleteLocation(id);
      else {_salesDashData=await serverRequest("GET","/api/erp/sales-dashboard");void deleteSalesTarget(id);}
    },{kind,id:original.id});
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(kind==="sales-targets"?"23,456원":"다른 사용자가 수정");
    await dialog.getByRole("button",{name:button,exact:true}).click();
    await expect.poll(()=>page.evaluate(async({kind,field,id})=>(await serverRequest("GET","/api/erp/"+kind))[field].some(row=>row.id===id),{kind,field,id:original.id})).toBe(false);
  });
}
