const { test, expect } = require("@playwright/test");

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.evaluate(() => {
    autoSaveDebounced = () => {};
    loadFromServer = async () => {};
    connectSSE = async () => {};
  });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

// 스킬 격차 모달이 부족 스킬명과 맞는 모집 예정·중 교육 과정만 추천하는지 확인한다.
test("스킬 격차 모달은 부족 스킬과 맞는 모집 중 교육만 추천한다", async ({ page }) => {
  await loginAsAdmin(page);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const sug = await page.evaluate(() => {
    employees = [{ id: "sg1", name: "격차직원", active: true, role: "member", dept: "SG본부", team: "A", rank: "대리", position: "PM" }];
    jobSkillProfiles = [{ id: "sgj1", title: "ERP PM", dept: "SG본부", position: "PM", status: "active", skills: [{ name: "제조ERP", level: 4, weight: 1 }] }];
    employeeSkillProfiles = [{ id: "sgp1", empId: "sg1", skills: [{ name: "제조ERP", level: 2 }] }];
    trainingCourses = [
      { id: "tc1", title: "제조ERP 실무 과정", status: "open", startDate: "2030-01-10" },
      { id: "tc2", title: "제조ERP 입문", status: "completed" },
      { id: "tc3", title: "엑셀 기초", status: "open" },
      { id: "tc4", title: "<img src=x onerror=window.__xss=1>제조ERP", status: "planned" },
    ];
    const out = _trainingSuggestionsForSkill("제조ERP").map(c => c.id);
    render(); gotoPage("skills-architecture");
    openJobSkillGapModal("sgj1");
    return out;
  });
  expect(sug).toEqual(["tc1", "tc4"]);
  const modal = page.locator(".modal-box");
  await expect(modal).toContainText("추천 교육");
  await expect(modal).toContainText("제조ERP 실무 과정");
  await expect(modal).not.toContainText("엑셀 기초");
  await expect(modal).not.toContainText("제조ERP 입문");
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(errors).toHaveLength(0);
});
