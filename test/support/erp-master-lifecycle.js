"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
module.exports = async function masterLifecycle(api, token) {
  const call = async (path, body, expected=200, method="POST") => {
    const response = await api("/api/erp/"+path, {method, headers:{Authorization:"Bearer "+token,"Content-Type":"application/json","Idempotency-Key":randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();
    assert.equal(response.status, expected, path+": "+JSON.stringify(data));
    return data;
  };
  for (const [route,field,payload] of [
    ["items","items",{code:"LIFECYCLE",name:"Lifecycle item"}],
    ["locations","locations",{name:"Lifecycle warehouse"}],
    ["sales-targets","salesTargets",{year:2031,targetAmount:50}],
  ]) {
    const id="lifecycle-"+randomUUID(), body={...payload,id};
    const created = await call(route,body);
    // 품목·창고는 수정 시 낙관적 락(expectedUpdatedAt)이 필수 — 영업 목표는 기존 동작
    const revisioned = route === "items" || route === "locations";
    const rec = created.item || created.location || {};
    if (revisioned) {
      assert.equal((await call(route,{...body,memo:"no revision"},428)).code,"ERP_REVISION_REQUIRED");
      assert.equal((await call(route,{...body,memo:"stale",expectedUpdatedAt:"1999-01-01T00:00:00.000Z"},409)).code,"ERP_MASTER_CONFLICT");
    }
    await call(route,{...body,memo:"active edit",...(revisioned?{expectedUpdatedAt:rec.updatedAt}:{})});
    await call(route+"/"+id+"/delete",{});
    const hidden=async()=>assert.ok(!(await call(route,undefined,200,"GET"))[field].some(row=>row.id===id));
    await hidden();
    for(const extra of [{},{restore:"true"},{restore:false}])assert.equal((await call(route,{...body,...extra},409)).code,"ERP_MASTER_DELETED");
    await hidden();
    await call(route,{...body,restore:true});
    assert.ok((await call(route,undefined,200,"GET"))[field].some(row=>row.id===id));
    await call(route+"/"+id+"/delete",{});
    assert.equal((await call(route,body,409)).code,"ERP_MASTER_DELETED");
  }
  const itemId="refs-"+randomUUID();
  await call("items",{id:itemId,code:itemId,name:"Reference item"});
  const items=[{itemId,qty:1,unitPrice:100}];
  const pr=(await call("purchase-requests",{date:"2031-05-01",items})).purchaseRequest;
  assert.equal((await call("items/"+itemId+"/delete",{},400)).code,"ERP_MASTER_IN_USE");
  for(const route of ["quotations","purchase-orders"]) {
    const locationId="refs-"+randomUUID();await call("locations",{id:locationId,name:"Document warehouse"});
    await call(route,{date:"2031-05-01",partnerName:"Test supplier",locationId,items});
    assert.equal((await call("locations/"+locationId+"/delete",{},400)).code,"ERP_MASTER_IN_USE");
    await call(route,{date:"2031-05-01",partnerName:"Test supplier",locationId:"missing-location",items},400);
  }
  await call("purchase-requests",{date:"2031-05-01",items:[{itemId:"missing-item",qty:1,unitPrice:1}]},400);
  await call("purchase-requests/"+pr.id+"/approve",{});
  await call("purchase-requests/"+pr.id+"/convert-to-po",{partnerName:"Test supplier",locationId:"missing-location"},400);
  assert.equal((await call("purchase-requests",undefined,200,"GET")).purchaseRequests.find(row=>row.id===pr.id).status,"approved");
  const location=(await call("locations",{name:"Free text validation"})).location;
  const freeItems=[{name:"Unlinked item",qty:1,unitPrice:100}];
  await call("purchase-requests",{date:"2031-05-01",items:freeItems},400);
  const stockBefore=(await call("stock/ledger",undefined,200,"GET")).ledger;
  const freeQuote=(await call("quotations",{date:"2031-05-01",partnerName:"Customer",locationId:location.id,items:freeItems})).quotation;
  await call("quotations/"+freeQuote.id+"/send",{});await call("quotations/"+freeQuote.id+"/accept",{});
  assert.equal((await call("quotations/"+freeQuote.id+"/ship",{},400)).code,"ERP_STOCK_REFERENCE_REQUIRED");
  assert.deepEqual((await call("stock/ledger",undefined,200,"GET")).ledger,stockBefore);
  // Concurrent create/delete may pick either winner but never leave a dangling reference.
  for (const route of ["quotations","purchase-orders","purchase-requests"]) {
    const id="race-"+randomUUID(),loc="race-"+randomUUID();
    await call("items",{id,code:id,name:"Race item"});await call("locations",{id:loc,name:"Race location"});
    const raw=(path,body)=>api("/api/erp/"+path,{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json","Idempotency-Key":randomUUID()},body:JSON.stringify(body)});
    const [created,deleted]=await Promise.all([raw(route,{date:"2031-05-01",partnerName:"Race",locationId:loc,items:[{itemId:id,qty:1,unitPrice:1}]}),raw("items/"+id+"/delete",{})]);
    assert.deepEqual([created.status,deleted.status].sort(),[200,400],route+" concurrent reference protection");
    const present=(await call("items",undefined,200,"GET")).items.some(row=>row.id===id);
    assert.equal(present,created.status===200);
  }
};
