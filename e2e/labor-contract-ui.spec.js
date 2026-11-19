const { test, expect } = require("@playwright/test");

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  // 서버에는 저장하지 않는다(공유 서버 상태 오염 방지) — 저장/동기화 함수를 막고 화면 동작만 검증한다.
  await page.evaluate(() => { autoSaveDebounced = () => {}; loadFromServer = async () => {}; connectSSE = async () => {}; _doSave = async () => {}; });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => {
    employees.push({ id: "lc-emp1", name: "홍길동", empNo: "LC001", role: "member", active: true, dept: "영업본부", team: "A팀" });
    laborContracts = [];
    serverConfig.enabled = true; serverConfig.url = location.origin;
  });
}

test("관리자: 계약서를 작성·발송하면 서명 대기로 표시되고 입력값은 검증된다", async ({ page }) => {
  await loginAsAdmin(page);
  await page.evaluate(() => renderLaborContractsPage());
  await expect(page.locator("#content")).toContainText("작성된 근로계약서가 없습니다");
  await page.evaluate(() => openLaborContractModal(null));
  await page.getByRole("button", { name: "저장 후 발송" }).click();
  await expect(page.locator(".toast").last()).toContainText("입력값을 확인");
  await page.fill("#lc-emp-search", "홍길");
  await page.selectOption("#lc-emp", "lc-emp1");
  await page.fill("#lc-title", "2027년 <img src=x onerror=window.__lcxss=1> 근로계약서");
  await page.fill("#lc-start", "2027-05-01");
  await page.fill("#lc-end", "2027-01-01");
  await page.getByRole("button", { name: "저장 후 발송" }).click();
  await expect(page.locator(".toast").last()).toContainText("종료일");
  await page.fill("#lc-end", "");
  await page.getByRole("button", { name: "저장 후 발송" }).click();
  await expect(page.locator("#content")).toContainText("서명 대기");
  expect(await page.evaluate(() => laborContracts.map(c => [c.empId, c.status]))).toEqual([["lc-emp1", "sent"]]);
  // 제목은 이스케이프되어 스크립트가 실행되지 않는다
  expect(await page.evaluate(() => window.__lcxss)).toBeUndefined();
  await expect(page.locator("#content img")).toHaveCount(0);
});

test("직원: 받은 계약만 보이고(작성중 제외) 본인 이름으로만 서명할 수 있다", async ({ page }) => {
  await loginAsAdmin(page);
  await page.evaluate(() => {
    laborContracts = [
      { id: "a", empId: "lc-emp1", title: "서명대기 계약", contractType: "정규직", startDate: "2027-01-01", endDate: "", content: "내용 A", status: "sent", contentHash: "h".repeat(64), sentAt: new Date().toISOString() },
      { id: "b", empId: "lc-emp1", title: "작성중 계약", contractType: "정규직", content: "내용 B", status: "draft" },
      { id: "c", empId: "other", title: "타인 계약", content: "내용 C", status: "sent" },
    ];
    currentUser = { ...currentUser, id: "lc-emp1", name: "홍길동", role: "member" };
    renderMyContractsPage();
  });
  const content = page.locator("#content");
  await expect(content).toContainText("서명대기 계약");
  await expect(content).not.toContainText("작성중 계약");
  await expect(content).not.toContainText("타인 계약");
  await page.getByRole("button", { name: "검토·서명" }).click();
  await page.getByRole("button", { name: "서명하기" }).click();
  await expect(page.locator(".toast").last()).toContainText("본인 이름");
  await page.fill("#lc-sign-name", "다른사람");
  await page.getByRole("button", { name: "서명하기" }).click();
  await expect(page.locator(".toast").last()).toContainText("다릅니다");
  await page.fill("#lc-sign-name", "홍길동");
  await page.getByRole("button", { name: "서명하기" }).click();
  await expect(page.locator(".toast").last()).toContainText("동의");
  await page.check("#lc-sign-agree");
  const cv = page.locator("#lc-sign-canvas");
  const box = await cv.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + 80); await page.mouse.up();
  await page.getByRole("button", { name: "서명하기" }).click();
  await expect(page.locator(".toast").last()).toContainText("서명이 완료");
  const signed = await page.evaluate(() => laborContracts.find(c => c.id === "a"));
  expect(signed.status).toBe("signed");
  expect(signed.signatureName).toBe("홍길동");
  expect(signed.signatureData).toMatch(/^data:image\/png;base64,/);
  await expect(content).toContainText("서명 완료");
});

test("직원: 거절하려면 사유가 필요하고, 거절하면 거절됨으로 표시된다", async ({ page }) => {
  await loginAsAdmin(page);
  await page.evaluate(() => {
    laborContracts = [{ id: "a", empId: "lc-emp1", title: "계약", content: "내용", status: "sent", contentHash: "h".repeat(64) }];
    currentUser = { ...currentUser, id: "lc-emp1", name: "홍길동", role: "member" };
    renderMyContractsPage();
  });
  await page.getByRole("button", { name: "검토·서명" }).click();
  await page.getByRole("button", { name: "거절", exact: true }).click();
  await expect(page.locator(".toast").last()).toContainText("거절 사유");
  await page.fill("#lc-decline-reason", "급여 조건 재협의 필요");
  await page.getByRole("button", { name: "거절", exact: true }).click();
  await expect(page.locator("#content")).toContainText("거절됨");
  expect(await page.evaluate(() => laborContracts[0].declineReason)).toBe("급여 조건 재협의 필요");
});

test("알림센터: 서명할 계약이 있으면 안내가 표시된다", async ({ page }) => {
  await loginAsAdmin(page);
  const found = await page.evaluate(() => {
    laborContracts = [{ id: "a", empId: "lc-emp1", title: "알림 계약", content: "내용", status: "sent" }];
    currentUser = { ...currentUser, id: "lc-emp1", name: "홍길동", role: "member" };
    gotoPage("notification-center");
    return true;
  });
  expect(found).toBe(true);
  await expect(page.locator("#content")).toContainText("서명할 근로계약 1건");
});

test("관리자: 서명 대기 계약에만 메일 안내 버튼이 보이고 서버 API를 호출한다", async ({ page }) => {
  await loginAsAdmin(page);
  const calls = [];
  await page.route("**/api/labor-contracts/*/notify-email", async route => {
    calls.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, emailedTo: "x@y.test" }) });
  });
  await page.evaluate(() => {
    laborContracts = [
      { id: "s1", empId: "lc-emp1", title: "대기 계약", contractType: "정규직", content: "A", status: "sent" },
      { id: "d1", empId: "lc-emp1", title: "작성중 계약", contractType: "정규직", content: "B", status: "draft" },
    ];
    renderLaborContractsPage();
  });
  await expect(page.getByRole("button", { name: /메일 안내/ })).toHaveCount(1);
  await page.getByRole("button", { name: /메일 안내/ }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toContain("/api/labor-contracts/s1/notify-email");
  await expect(page.locator(".toast").last()).toContainText("안내 메일을 보냈습니다");
});
