// 관리자 운영센터: 로그인·메뉴 사용·저장소·관리자 보안 현황을 한 화면에서 점검한다.
// 데이터 원본은 회사 범위+admin 권한이 적용된 /status와 /activity만 사용한다.
(function(){
  const state={status:null,readiness:null,logs:[],days:7,query:"",action:"all",error:""};
  const labels={login_succeeded:"로그인 성공",login_failed:"로그인 실패",login_otp_failed:"2단계 인증 실패",menu_opened:"메뉴 열람",kpi_submitted:"KPI 제출",kpi_approved:"KPI 승인",kpi_rejected:"KPI 반려",emp_registered:"직원 등록",emp_modified:"직원 수정",emp_retired:"퇴직 처리","데이터 저장":"데이터 저장",role_changed:"권한(역할) 변경",menu_perm_changed:"메뉴 권한 변경",menu_perm_group_applied:"메뉴 권한 일괄 적용",training_course_created:"교육 과정 개설",training_course_updated:"교육 과정 수정",training_course_deleted:"교육 과정 삭제",garnishment_registered:"급여 압류 등록",garnishment_updated:"급여 압류 수정",garnishment_canceled:"급여 압류 해지",severance_settlement_registered:"퇴직금 정산 등록",social_insurance_registered:"4대보험 신고 등록",social_insurance_updated:"4대보험 신고 수정",social_insurance_deleted:"4대보험 신고 삭제"};
  // 권한변경로그(D1) — 위 3개 액션만 따로 빠르게 필터링할 수 있는 바로가기.
  const PERM_ACTIONS=["role_changed","menu_perm_changed","menu_perm_group_applied"];
  const logTime=row=>new Date(row?.time||row?.ts||row?.createdAt||0);
  function pageLabel(id){
    for(const rows of Object.values(typeof _menuGroupsCache==="object"?_menuGroupsCache:{})){const found=(rows||[]).find(x=>x.id===id);if(found)return found.label;}
    return id||"-";
  }
  function filtered(){
    const since=Date.now()-Number(state.days||7)*86400000,q=String(state.query||"").trim().toLowerCase();
    return state.logs.filter(row=>{
      const at=logTime(row);if(!Number.isFinite(at.getTime())||at.getTime()<since)return false;
      if(state.action==="__perm__")return PERM_ACTIONS.includes(row.action)&&(!q||[row.userName,row.action,row.target,row.detail].some(v=>String(v||"").toLowerCase().includes(q)));
      if(state.action!=="all"&&row.action!==state.action)return false;
      return !q||[row.userName,row.action,row.target,row.detail].some(v=>String(v||"").toLowerCase().includes(q));
    });
  }
  function card(label,value,sub,color=""){return `<div class="kpi-card"><div class="kpi-label">${h(label)}</div><div class="kpi-val"${color?` style="color:${color}"`:""}>${value}</div><div class="kpi-sub">${sub}</div></div>`;}
  async function render(){
    const c=$("#content");if(!c)return;if(currentUser?.role!=="admin"){_pageAccessDenied();return;}
    c.innerHTML='<div class="card"><div class="card-body p-empty">관리자 운영 현황을 불러오는 중입니다…</div></div>';
    state.error="";
    try{
      const [status,readiness,activity]=await Promise.all([serverRequest("GET","/status",null,8000),serverRequest("GET","/readyz",null,8000),serverRequest("GET","/activity?limit=1000",null,10000)]);
      state.status=status;state.readiness=readiness;state.logs=activity.logs||[];
    }catch(e){state.error=e.message||"운영 현황을 불러오지 못했습니다.";}
    draw();
  }
  function draw(){
    const c=$("#content");if(!c)return;
    const status=state.status||{},ready=state.readiness||{},rows=filtered();
    const active=(employees||[]).filter(e=>e.active!==false),admins=active.filter(e=>e.role==="admin"),twoFa=admins.filter(e=>e.twoFactorEnabled).length;
    const failures=rows.filter(e=>["login_failed","login_otp_failed"].includes(e.action));
    const menuCounts={};rows.filter(e=>e.action==="menu_opened").forEach(e=>menuCounts[e.target]=(menuCounts[e.target]||0)+1);
    const topMenus=Object.entries(menuCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const lastSaved=status.meta?.lastSaved?new Date(status.meta.lastSaved):null;
    const warnings=[];
    if(ready.ok===false)warnings.push(["danger","저장소 준비 상태가 정상적이지 않습니다. 배포 로그와 DB 연결 상태를 확인하세요."]);
    if(admins.length&&!twoFa)warnings.push(["warn","2단계 인증을 사용하는 활성 관리자 계정이 없습니다."]);
    if(failures.length>=5)warnings.push(["warn",`선택 기간에 로그인 실패가 ${failures.length}건 감지되었습니다.`]);
    if(lastSaved&&Date.now()-lastSaved.getTime()>86400000)warnings.push(["warn","마지막 저장이 24시간 이상 경과했습니다. 자동 저장과 백업 상태를 확인하세요."]);
    if(!warnings.length)warnings.push(["success","현재 선택 기간에서 즉시 조치가 필요한 운영 경고가 없습니다."]);
    const actions=[...new Set(state.logs.map(x=>x.action).filter(Boolean))].sort();
    const tableRows=rows.slice(0,200).map(row=>{const at=logTime(row),fail=String(row.action).includes("failed");return `<tr><td style="white-space:nowrap">${Number.isFinite(at.getTime())?h(at.toLocaleString("ko-KR")):"-"}</td><td>${h(row.userName||"-")}</td><td><span class="badge" style="${fail?"background:#fee2e2;color:#b91c1c":""}">${h(labels[row.action]||row.action||"-")}</span></td><td>${h(row.action==="menu_opened"?pageLabel(row.target):row.target||"-")}</td><td class="text-gray">${h(row.detail||"")}</td></tr>`;}).join("");
    c.innerHTML=`<div class="flex justify-between items-c mb3" style="gap:12px;flex-wrap:wrap"><div><h2>🛡 관리자 운영센터</h2><div class="fz12 text-gray">접속·메뉴 사용·저장소·관리자 보안을 한 화면에서 점검합니다.</div></div><div class="flex gap2"><button class="btn btn-secondary btn-sm" onclick="adminOperations.exportCsv()">CSV 내보내기</button><button class="btn btn-primary btn-sm" onclick="adminOperations.render()">새로고침</button></div></div>
      ${state.error?`<div class="notice danger mb3">${h(state.error)}</div>`:""}
      <div class="kpi-grid mb3">${card("서비스 상태",ready.ok?"정상":"확인 필요",h(ready.storageMode||status.storageMode||"-"),ready.ok?"#16a34a":"#dc2626")}${card("현재 접속",`${Number(status.onlineCount)||0}<small>명</small>`,`활성 직원 ${active.length}명`)}${card("로그인 실패",`${failures.length}<small>건</small>`,`최근 ${state.days}일`,failures.length?"#dc2626":"#16a34a")}${card("관리자 2단계 인증",`${twoFa}<small>/${admins.length}명</small>`,"활성 관리자 기준")}${card("데이터 버전",String(Number(status.version)||0),`마지막 저장 ${lastSaved&&Number.isFinite(lastSaved.getTime())?h(lastSaved.toLocaleString("ko-KR")):"확인 불가"}`)}</div>
      <div class="grid2 mb3"><div class="card"><div class="card-head"><h3>운영 경고</h3></div><div class="card-body">${warnings.map(([tone,text])=>`<div class="notice ${tone} mb2">${h(text)}</div>`).join("")}</div></div><div class="card"><div class="card-head"><h3>자주 사용한 메뉴</h3><span class="fz11 text-gray">최근 ${state.days}일</span></div><div class="card-body">${topMenus.length?topMenus.map(([id,n],i)=>`<div class="flex justify-between items-c mb2"><span>${i+1}. ${h(pageLabel(id))}</span><b>${n}회</b></div>`).join(""):'<div class="p-empty">집계된 메뉴 사용 이력이 없습니다.</div>'}</div></div></div>
      <div class="card mb3"><div class="card-head"><h3>관리 바로가기</h3></div><div class="card-body flex gap2" style="flex-wrap:wrap">${[["deploy-perm","권한 관리"],["settings-org","조직 관리"],["data-mgmt","백업·복원"],["history","수정 이력"],["integrations","연동 설정"]].map(([id,text])=>`<button class="btn btn-secondary btn-sm" onclick="gotoPage('${id}')">${text}</button>`).join("")}</div></div>
      <div class="card"><div class="card-head"><h3>접속·활동 이력</h3><span class="fz11 text-gray">${rows.length}건${rows.length>200?" · 최근 200건 표시":""}</span></div><div class="card-body" style="padding-bottom:8px"><div class="filter-bar" style="flex-wrap:wrap"><select class="fc" style="width:110px" onchange="adminOperations.setDays(this.value)">${[1,7,30,90].map(d=>`<option value="${d}" ${state.days===d?"selected":""}>최근 ${d}일</option>`).join("")}</select><select class="fc" style="width:170px" onchange="adminOperations.setAction(this.value)"><option value="all">전체 활동</option><option value="__perm__" ${state.action==="__perm__"?"selected":""}>🔑 권한변경로그만</option>${actions.map(a=>`<option value="${h(a)}" ${state.action===a?"selected":""}>${h(labels[a]||a)}</option>`).join("")}</select><input id="admin-ops-query" class="fc" style="min-width:220px;flex:1" value="${h(state.query)}" placeholder="사용자·활동·대상 검색" onkeydown="if(event.key==='Enter')adminOperations.search(this.value)"><button class="btn btn-secondary btn-sm" onclick="adminOperations.search(document.getElementById('admin-ops-query').value)">검색</button><button class="btn btn-secondary btn-sm" onclick="adminOperations.reset()">초기화</button></div></div><div class="tbl-wrap"><table><thead><tr><th>시각</th><th>사용자</th><th>활동</th><th>대상</th><th>상세</th></tr></thead><tbody>${tableRows||'<tr><td colspan="5" class="p-empty">조건에 맞는 이력이 없습니다.</td></tr>'}</tbody></table></div></div>`;
  }
  function exportCsv(){const rows=filtered();if(!rows.length){showToast("내보낼 이력이 없습니다.","info");return;}dlCSV(`관리자_운영이력_${new Date().toISOString().slice(0,10)}.csv`,["시각","사용자","활동","대상","상세"],rows.map(row=>{const at=logTime(row);return[Number.isFinite(at.getTime())?at.toISOString():"",row.userName||"",labels[row.action]||row.action||"",row.action==="menu_opened"?pageLabel(row.target):row.target||"",row.detail||""];}));}
  window.adminOperations={render,exportCsv,setDays:v=>{state.days=Number(v);draw();},setAction:v=>{state.action=v;draw();},search:v=>{state.query=v;draw();},reset:()=>{state.query="";state.action="all";draw();}};
  window.renderAdminOperationsPage=render;
})();
