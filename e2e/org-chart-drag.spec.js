const { test, expect } = require("@playwright/test");

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  // 로그인 직후 백그라운드 서버 재동기화(SSE/자동로드)가 테스트가 시딩한
  // 순수 인메모리 상태를 덮어쓰는 경합을 막는다(이 프로젝트의 확립된 관례).
  await page.evaluate(() => {
    autoSaveDebounced = () => {};
    loadFromServer = async () => {};
    connectSSE = async () => {};
  });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

test.describe("조직도 부서/팀 블록 드래그앤드롭(화면 배치만)", () => {
  test("부서 순서를 드래그로 바꿔도 실제 조직 배정은 그대로 유지된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await loginAsAdmin(page);

    await page.evaluate(() => {
      orgDB.depts = ["드래그A부", "드래그B부", "드래그C부"];
      orgDB.teams["드래그A부"] = [];
      employees.push(
        { id: 9501, empNo: "E9501", name: "부서A직원", dept: "드래그A부", team: "", rank: "사원", position: "", active: true, hire: "2020-01-01", hrHistory: [] },
        { id: 9502, empNo: "E9502", name: "부서B직원", dept: "드래그B부", team: "", rank: "사원", position: "", active: true, hire: "2020-01-01", hrHistory: [] },
        { id: 9503, empNo: "E9503", name: "부서C직원", dept: "드래그C부", team: "", rank: "사원", position: "", active: true, hire: "2020-01-01", hrHistory: [] },
      );
    });

    await page.evaluate(() => gotoPage("orgchart"));
    await expect(page.locator(".org-dept-row")).toHaveCount(3);

    // 렌더링 순서 확인(기존 orgDB.depts 순서 그대로: A, B, C)
    let order = await page.locator(".org-dept-row").allTextContents();
    expect(order[0]).toContain("드래그A부");
    expect(order[1]).toContain("드래그B부");
    expect(order[2]).toContain("드래그C부");

    // 관리자에게만 드래그 핸들(그립 아이콘)과 draggable 속성이 노출된다
    const dragCount = await page.locator('.org-dept-row[draggable="true"]').count();
    expect(dragCount).toBe(3);

    // 드래그 시뮬레이션: "드래그B부"를 "드래그A부" 자리로 이동(함수를 직접 호출 — 네이티브 HTML5
    // 드래그 이벤트는 Playwright에서 불안정하므로, 이 프로젝트 e2e 관례대로 핸들러를 직접 호출)
    const result = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".org-dept-row")];
      const bRow = rows.find((r) => r.textContent.includes("드래그B부"));
      const aRow = rows.find((r) => r.textContent.includes("드래그A부"));
      _orgDeptDragStart(bRow, "드래그B부");
      _orgDeptDrop({ preventDefault() {} }, aRow, "드래그A부");
      return {
        orgChartOrder: settings.orgChartOrder,
        orgDBDepts: orgDB.depts.slice(),
        deptFields: employees.filter((e) => [9501, 9502, 9503].includes(e.id)).map((e) => e.dept),
      };
    });

    expect(result.orgChartOrder.depts).toEqual(["드래그B부", "드래그A부", "드래그C부"]);
    // 실제 조직 배정(orgDB.depts 마스터 목록, 직원의 dept 필드)은 전혀 바뀌지 않는다 — "화면 배치만"
    expect(result.orgDBDepts).toEqual(["드래그A부", "드래그B부", "드래그C부"]);
    expect(result.deptFields).toEqual(["드래그A부", "드래그B부", "드래그C부"]);

    // 화면에도 바뀐 순서(B, A, C)가 즉시 반영된다
    order = await page.locator(".org-dept-row").allTextContents();
    expect(order[0]).toContain("드래그B부");
    expect(order[1]).toContain("드래그A부");
    expect(order[2]).toContain("드래그C부");

    // 서버 저장 자체(POST /save → GET /data 왕복)는 이 프로젝트 e2e 스위트가
    // 전 spec 파일에서 서버 프로세스/DATA_FILE을 공유하는 구조라, 여기서 실제
    // 영속화를 수행하면 이 테스트가 시딩한 더미 orgDB/직원 데이터가 다른 spec
    // 파일의 테스트에 누출될 위험이 있다(hr-history-scheduling.spec.js 등
    // 다른 spec들도 실제 영속 검증은 각자 자기 데이터로만 수행하는 것과 동일한
    // 이유로, 이 테스트는 클라이언트 측 상태·DOM 검증만으로 기능을 충분히
    // 검증한다 — settings.orgChartOrder 서버 영속 자체는 다른 singleton
    // 필드(settings)와 동일한 기존 저장 경로를 그대로 타므로 별도 검증 불필요).

    expect(pageErrors).toEqual([]);
  });

  test("팀 순서는 같은 부서 안에서만 바뀌고, 다른 부서 팀으로의 드롭은 무시된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await loginAsAdmin(page);

    await page.evaluate(() => {
      orgDB.depts = ["팀드래그부"];
      orgDB.teams["팀드래그부"] = ["팀1", "팀2", "팀3"];
      employees.push(
        { id: 9601, empNo: "E9601", name: "팀1직원", dept: "팀드래그부", team: "팀1", rank: "사원", position: "", active: true, hire: "2020-01-01", hrHistory: [] },
        { id: 9602, empNo: "E9602", name: "팀2직원", dept: "팀드래그부", team: "팀2", rank: "사원", position: "", active: true, hire: "2020-01-01", hrHistory: [] },
        { id: 9603, empNo: "E9603", name: "팀3직원", dept: "팀드래그부", team: "팀3", rank: "사원", position: "", active: true, hire: "2020-01-01", hrHistory: [] },
      );
      window._orgCollapsed = new Set(); // 전 부서/팀을 펼친 상태로 시작
    });

    await page.evaluate(() => gotoPage("orgchart"));
    await expect(page.locator(".org-team-row")).toHaveCount(3);

    // 팀2를 팀1 자리로 이동
    const result1 = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".org-team-row")];
      const t2 = rows.find((r) => r.textContent.includes("팀2"));
      const t1 = rows.find((r) => r.textContent.includes("팀1"));
      _orgTeamDragStart(t2, "팀드래그부", "팀2");
      _orgTeamDrop({ preventDefault() {} }, t1, "팀드래그부", "팀1");
      return settings.orgChartOrder.teams["팀드래그부"];
    });
    expect(result1).toEqual(["팀2", "팀1", "팀3"]);

    // 무관 부서로의 드롭 시도(부서명 불일치) — 아무 변화 없어야 함
    const before = await page.evaluate(() => JSON.parse(JSON.stringify(settings.orgChartOrder)));
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".org-team-row")];
      const t3 = rows.find((r) => r.textContent.includes("팀3"));
      _orgTeamDragStart(t3, "팀드래그부", "팀3");
      // 존재하지 않는 다른 부서로 드롭 시도
      _orgTeamDrop({ preventDefault() {} }, t3, "무관부서", "팀1");
    });
    const after = await page.evaluate(() => settings.orgChartOrder);
    expect(after).toEqual(before);

    expect(pageErrors).toEqual([]);
  });

  test("일반 직원(member)에게는 드래그 핸들이 노출되지 않는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await loginAsAdmin(page);

    await page.evaluate(() => {
      orgDB.depts = ["멤버뷰부"];
      employees.push({ id: 9701, empNo: "E9701", name: "멤버뷰직원", dept: "멤버뷰부", team: "", rank: "사원", position: "", active: true, hire: "2020-01-01", hrHistory: [] });
      // 관리자 화면에서 currentUser만 member로 바꿔 렌더링 분기(isAdmin)를 검증
      currentUser = { ...currentUser, role: "member" };
    });

    await page.evaluate(() => gotoPage("orgchart"));
    await expect(page.locator(".org-dept-row")).toHaveCount(1);
    const dragCount = await page.locator('.org-dept-row[draggable="true"]').count();
    expect(dragCount).toBe(0);
    const gripText = await page.locator(".org-dept-row").first().textContent();
    expect(gripText).not.toContain("⠿");

    expect(pageErrors).toEqual([]);
  });

  test("부서명에 작은따옴표가 있어도 접기/펼치기가 정상 동작한다(XSS 이스케이프 확인)", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await loginAsAdmin(page);

    await page.evaluate(() => {
      orgDB.depts = ["Sales'Ops"];
      orgDB.teams["Sales'Ops"] = ["Ops'Team"];
      employees.push({ id: 9801, empNo: "E9801", name: "특수문자부서직원", dept: "Sales'Ops", team: "Ops'Team", rank: "사원", position: "", active: true, hire: "2020-01-01", hrHistory: [] });
      window._orgCollapsed = new Set();
    });

    await page.evaluate(() => gotoPage("orgchart"));
    await expect(page.locator(".org-dept-row")).toHaveCount(1);
    await expect(page.locator(".org-team-row")).toHaveCount(1);

    // 부서 클릭 시 정상적으로 접힘/펼침 토글(구문 오류 없이 onclick이 실행됨)
    await page.locator(".org-dept-row").click();
    await expect(page.locator(".org-team-row")).toHaveCount(0);
    await page.locator(".org-dept-row").click();
    await expect(page.locator(".org-team-row")).toHaveCount(1);

    // 팀 클릭도 정상 토글
    await page.locator(".org-team-row").click();
    const collapsedState = await page.evaluate(() => window._orgCollapsed.has("team:Sales'Ops:Ops'Team"));
    expect(collapsedState).toBe(true);

    expect(pageErrors).toEqual([]);
  });
});
