"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
module.exports = async function masterLifecycle(api, token) {
  const call = async (path, body, expected=200, method="POST") => {
    const response = await api("/api/erp/"+path, {method, headers:{Authorization:"Bearer "+token,"Content-Type":"application/json","Idempotency-Key":randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();
    if(expected!==null)assert.equal(response.status, expected, path+": "+JSON.stringify(data));
    else assert.ok([200,409].includes(response.status),JSON.stringify(data));
    return data;
  };
  for (const [route,field,payload] of [
    ["items","items",{code:"LIFECYCLE",name:"Lifecycle item"}],
    ["locations","locations",{name:"Lifecycle warehouse"}],
    ["sales-targets","salesTargets",{year:2031,targetAmount:50}],
  ]) {
    const id="lifecycle-"+randomUUID(), body={...payload,id};
    const key=field==="items"?"item":field==="locations"?"location":"salesTarget";
    const created=(await call(route,body))[key];
    assert.equal(typeof created._rev,"string");
    assert.equal((await call(route,{...body,name:"blind overwrite"},409)).code,"ERP_MASTER_CONFLICT");
    for(const invalid of [null,0,{},"bad-revision"]){
      assert.equal((await call(route,{...body,_rev:invalid},400)).code,"ERP_MASTER_REVISION_INVALID");
    }
    const edit={...body,_rev:created._rev};
    const requests=await Promise.all([call(route,{...edit,name:"Editor one",targetAmount:51},null),call(route,{...edit,name:"Editor two",targetAmount:52},null)]);
    assert.equal(requests.filter(r=>r.ok).length,1,"exactly one concurrent save wins");
    assert.equal(requests.filter(r=>r.code==="ERP_MASTER_CONFLICT").length,1);
    const winner=requests.find(r=>r.ok)[key];
    assert.notEqual(winner._rev,created._rev);
    assert.deepEqual((await call(route,undefined,200,"GET"))[field].find(row=>row.id===id),winner);
    assert.equal((await call(route,{...edit,restore:true},409)).code,"ERP_MASTER_CONFLICT","restore must not overwrite a live edit");
    assert.equal((await call(route,{...body,id:"missing-"+randomUUID(),_rev:winner._rev},409)).code,"ERP_MASTER_CONFLICT");
    let updated=(await call(route,{...winner,memo:"active edit"}))[key];
    assert.notEqual(updated._rev,winner._rev);
    assert.equal((await call(route+"/"+id+"/delete",{},409)).code,"ERP_MASTER_CONFLICT");
    assert.equal((await call(route+"/"+id+"/delete",{_rev:created._rev},409)).code,"ERP_MASTER_CONFLICT");
    assert.equal((await call(route+"/"+id+"/delete",{_rev:{}},400)).code,"ERP_MASTER_REVISION_INVALID");
    const race=await Promise.all([call(route,{...updated,name:"Concurrent editor"},null),call(route+"/"+id+"/delete",{_rev:updated._rev},null)]);
    assert.equal(race.filter(result=>result.ok).length,1,"edit/delete only one wins");
    assert.ok(race.some(result=>["ERP_MASTER_CONFLICT","ERP_MASTER_DELETED"].includes(result.code)));
    if(race[0].ok) updated=race[0][key];
    else updated=(await call(route,{...body,restore:true}))[key];
    await call(route+"/"+id+"/delete",{_rev:updated._rev});
    await call(route+"/"+id+"/delete",{_rev:updated._rev});
    const hidden=async()=>assert.ok(!(await call(route,undefined,200,"GET"))[field].some(row=>row.id===id));
    await hidden();
    for(const extra of [{},{restore:"true"},{restore:false}])assert.equal((await call(route,{...body,...extra},409)).code,"ERP_MASTER_DELETED");
    await hidden();
    const restored=(await call(route,{...body,restore:true}))[key];
    assert.notEqual(restored._rev,created._rev);
    assert.equal((await call(route,{...body,_rev:created._rev,restore:true},409)).code,"ERP_MASTER_CONFLICT");
    assert.ok((await call(route,undefined,200,"GET"))[field].some(row=>row.id===id));
    assert.equal((await call(route+"/"+id+"/delete",{_rev:updated._rev},409)).code,"ERP_MASTER_CONFLICT","old delete cannot remove restored data");
    await call(route+"/"+id+"/delete",{_rev:restored._rev});
    assert.equal((await call(route,body,409)).code,"ERP_MASTER_DELETED");
  }
  const itemId="refs-"+randomUUID();
  const referenceItem=(await call("items",{id:itemId,code:itemId,name:"Reference item"})).item;
  const items=[{itemId,qty:1,unitPrice:100}];
  const pr=(await call("purchase-requests",{date:"2031-05-01",items})).purchaseRequest;
  assert.equal((await call("items/"+itemId+"/delete",{_rev:referenceItem._rev},400)).code,"ERP_MASTER_IN_USE");
  for(const route of ["quotations","purchase-orders"]) {
    const locationId="refs-"+randomUUID();const referenceLocation=(await call("locations",{id:locationId,name:"Document warehouse"})).location;
    await call(route,{date:"2031-05-01",partnerName:"Test supplier",locationId,items});
    assert.equal((await call("locations/"+locationId+"/delete",{_rev:referenceLocation._rev},400)).code,"ERP_MASTER_IN_USE");
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
    const raceItem=(await call("items",{id,code:id,name:"Race item"})).item;await call("locations",{id:loc,name:"Race location"});
    const raw=(path,body)=>api("/api/erp/"+path,{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json","Idempotency-Key":randomUUID()},body:JSON.stringify(body)});
    const [created,deleted]=await Promise.all([raw(route,{date:"2031-05-01",partnerName:"Race",locationId:loc,items:[{itemId:id,qty:1,unitPrice:1}]}),raw("items/"+id+"/delete",{_rev:raceItem._rev})]);
    assert.deepEqual([created.status,deleted.status].sort(),[200,400],route+" concurrent reference protection");
    const present=(await call("items",undefined,200,"GET")).items.some(row=>row.id===id);
    assert.equal(present,created.status===200);
  }
};
