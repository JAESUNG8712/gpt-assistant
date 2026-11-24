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
      const removed=await serverRequest("POST","/api/erp/"+kind+"/"+id+"/delete",{});
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
