const { test, expect } = require("@playwright/test");

// 결재 금액 구간별 추가 결재자 — 고액 문서에만 결재자를 "더하는" 규정(전결 규정은 줄이는 규정).
// 순수 함수(_applyApprovalAmountTiers)의 경계·예외, 설정 화면의 추가/삭제, 상신 미리보기 연동을 본다.
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

const seedPeople = () => {
  const base = { dept: "금액구간부", team: "금액구간팀", role: "member", active: true, hire: "2020-01-01", menuPerms: {} };
  employees.push(
    { ...base, id: 9701, name: "구간팀장", role: "leader" },
    { ...base, id: 9702, name: "구간재무", dept: "재무부" },
    { ...base, id: 9703, name: "구간퇴직", active: false },
    { ...base, id: 9704, name: "구간대표" },
    { ...base, id: 9705, name: "구간기안자" },
  );
};

test.describe("금액 구간별 추가 결재자", () => {
  test("_applyApprovalAmountTiers: 기준 이상만 추가하고 중복·기안자·퇴직자·잘못된 설정은 건너뛴다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const r = await page.evaluate((seedSrc) => {
      eval(`(${seedSrc})()`);
      const chain = () => [{ empId: 9701, label: "팀장", status: "pending", decidedAt: null, comment: "" }];
      const ids = (list) => list.map((a) => a.empId);
      approvalChainSettings = { ...approvalChainSettings, amountTiers: [
        { minAmount: 10000000, empId: 9704, label: "대표 결재" },   // 일부러 순서를 뒤집어 저장
        { minAmount: 5000000, empId: 9702, label: "재무 결재" },
        { minAmount: 5000000, empId: 9703, label: "퇴직자" },          // 퇴직자 → 건너뜀
        { minAmount: 1000000, empId: 9701, label: "팀장 중복" },       // 이미 결재선에 있음 → 건너뜀
        { minAmount: 1000000, empId: 9705, label: "기안자 본인" },     // 기안자 → 건너뜀
        { minAmount: -5, empId: 9704, label: "잘못된 금액" },          // 무시
        { minAmount: "abc", empId: 9704 }, null, { minAmount: 1 },     // 무시(모양 불량)
      ] };
      const run = (fd) => _applyApprovalAmountTiers(chain(), fd, 9705);
      const below = run({ amount: 4999999 });
      const at = run({ amount: 5000000 });
      const above = run({ amount: 12000000 });
      const viaRequested = run({ requestedAmount: 7000000 });
      const viaEstimated = run({ estimatedCost: 7000000 });
      const viaBudget = run({ budget: 7000000 });
      const noAmount = run({ note: "금액 없음" });
      const zero = run({ amount: 0 });
      const labels = above.map((a) => a.label);
      approvalChainSettings = { ...approvalChainSettings, amountTiers: undefined };
      const noTiers = run({ amount: 99999999 });
      return {
        below: ids(below), at: ids(at), above: ids(above), labels,
        viaRequested: ids(viaRequested), viaEstimated: ids(viaEstimated), viaBudget: ids(viaBudget),
        noAmount: ids(noAmount), zero: ids(zero), noTiers: ids(noTiers),
        addedStatus: above[1].status, originalUntouched: chain().length,
      };
    }, seedPeople.toString());

    expect(r.below).toEqual([9701]);                 // 기준 미만 → 변화 없음
    expect(r.at).toEqual([9701, 9702]);              // 기준 "이상"(경계 포함)
    expect(r.above).toEqual([9701, 9702, 9704]);     // 낮은 구간부터 순서대로, 퇴직자·중복·기안자 제외
    expect(r.labels).toEqual(["팀장", "재무 결재", "대표 결재"]);
    expect(r.viaRequested).toEqual([9701, 9702]);    // 복리후생·대출
    expect(r.viaEstimated).toEqual([9701, 9702]);    // 교육
    expect(r.viaBudget).toEqual([9701, 9702]);       // 출장
    expect(r.noAmount).toEqual([9701]);
    expect(r.zero).toEqual([9701]);
    expect(r.noTiers).toEqual([9701]);               // 설정이 없으면 그대로
    expect(r.addedStatus).toBe("waiting");           // 추가 결재자는 앞 단계가 끝나야 차례가 옴
    expect(pageErrors).toEqual([]);
  });

  test("설정 화면에서 구간을 추가·삭제하고 잘못된 금액은 막는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await page.evaluate((seedSrc) => { eval(`(${seedSrc})()`); approvalChainSettings = { ...approvalChainSettings, amountTiers: [] }; }, seedPeople.toString());

    await page.evaluate(() => gotoPage("approval-templates"));
    await expect(page.locator("#content")).toContainText("설정된 금액 구간이 없습니다");

    await page.locator("button", { hasText: "+ 금액 구간 추가" }).click();
    const picker = page.locator(".modal-box", { hasText: "금액 구간 결재자 선택" });
    await picker.locator("#op-search").fill("구간재무");
    await picker.locator("#op-tree label", { hasText: "구간재무" }).click();
    await picker.locator("button", { hasText: "선택 완료" }).click();

    const modal = page.locator(".modal-box", { hasText: "금액 구간 설정" });
    await expect(modal).toBeVisible();
    // 금액 없이 추가 → 거부(전역 입력 가이드가 필수 항목 누락을 먼저 막는다)
    await modal.locator("button", { hasText: "추가" }).click();
    await expect(page.locator(".toast-error").last()).toBeVisible();
    expect(await page.evaluate(() => (approvalChainSettings.amountTiers || []).length)).toBe(0);
    // 0원·음수도 거부(어느 쪽 검증이 막았든 구간은 만들어지지 않는다)
    await modal.locator("#at-min").fill("0");
    await modal.locator("button", { hasText: "추가" }).click();
    await expect(page.locator(".toast-error").last()).toBeVisible();
    expect(await page.evaluate(() => (approvalChainSettings.amountTiers || []).length)).toBe(0);

    await modal.locator("#at-min").fill("5000000");
    await modal.locator("#at-label").fill("재무 결재");
    await modal.locator("button", { hasText: "추가" }).click();

    await expect(page.locator("#content")).toContainText("5,000,000원 이상 → 구간재무 · 재무 결재");
    expect(await page.evaluate(() => approvalChainSettings.amountTiers)).toEqual([{ minAmount: 5000000, empId: 9702, label: "재무 결재" }]);

    await page.locator("#content span[aria-label='삭제']").click();
    await expect(page.locator("#content")).toContainText("설정된 금액 구간이 없습니다");
    expect(await page.evaluate(() => approvalChainSettings.amountTiers)).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("상신 미리보기: 고액이면 구간 결재자가 결재선에 추가되고, 소액이면 추가되지 않는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await page.evaluate((seedSrc) => {
      eval(`(${seedSrc})()`);
      approvalChainSettings = { ...approvalChainSettings, amountTiers: [{ minAmount: 5000000, empId: 9702, label: "재무 결재" }] };
    }, seedPeople.toString());

    const preview = async (amount) => {
      await page.evaluate(() => openApprovalForm("tpl-expense"));
      await page.fill("#af-expenseDate", "2026-11-03");
      await page.selectOption("#af-expenseType", "기타");
      await page.fill("#af-amount", String(amount));
      await page.fill("#af-purpose", "금액 구간 테스트");
      // 관리자 기안은 자동 결재선이 비어 있으므로 팀장을 직접 지정한 상황을 만든다.
      await page.evaluate(() => { _customApprovers = [{ empId: 9701, label: "팀장", status: "pending", decidedAt: null, comment: "" }]; });
      await page.evaluate(() => previewApprovalForm("tpl-expense"));
      return page.locator(".modal-box", { hasText: "결재 상신 미리보기" });
    };

    let modal = await preview(8000000);
    await expect(modal).toContainText("구간팀장");
    await expect(modal).toContainText("구간재무");
    await expect(modal).toContainText("재무 결재");
    expect(await page.evaluate(() => window._afPendingSubmit.approvers.map((a) => a.empId))).toEqual([9701, 9702]);
    await modal.locator("button", { hasText: "돌아가서 수정" }).click();
    await page.evaluate(() => closeModal());

    modal = await preview(300000);
    await expect(modal).toContainText("구간팀장");
    await expect(modal).not.toContainText("구간재무");
    expect(await page.evaluate(() => window._afPendingSubmit.approvers.map((a) => a.empId))).toEqual([9701]);
    expect(pageErrors).toEqual([]);
  });
  test("양식 지정 구간: 지정한 양식에서만 적용되고, 설정 화면에서 양식을 골라 저장·표시된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const r = await page.evaluate((seedSrc) => {
      eval(`(${seedSrc})()`);
      const chain = () => [{ empId: 9701, label: "팀장", status: "pending", decidedAt: null, comment: "" }];
      const ids = (list) => list.map((a) => a.empId);
      approvalChainSettings = { ...approvalChainSettings, amountTiers: [
        { minAmount: 1000000, empId: 9702, label: "경비만", tplIds: ["tpl-expense"] },
        { minAmount: 1000000, empId: 9704, label: "전체 양식" },
        { minAmount: 1000000, empId: 9705, label: "빈 목록", tplIds: [] },   // 빈 목록 = 전체 양식
      ] };
      const run = (tplId) => ids(_applyApprovalAmountTiers(chain(), { amount: 2000000 }, 1, tplId));
      return { expense: run("tpl-expense"), other: run("tpl-vacation"), noTpl: run(undefined), scope: _normalizedAmountTiers().map(_amountTierScopeText) };
    }, seedPeople.toString());
    expect(r.expense).toEqual([9701, 9702, 9704, 9705]);   // 지정 양식에서는 지정·전체 구간 모두
    expect(r.other).toEqual([9701, 9704, 9705]);           // 다른 양식에서는 양식 지정 구간만 빠진다
    expect(r.noTpl).toEqual([9701, 9704, 9705]);           // 양식을 모르면 양식 지정 구간은 적용하지 않는다
    expect(r.scope).toEqual(["경비 지출 신청", "전체 양식", "전체 양식"]);

    // 설정 화면: 양식 체크박스로 범위를 정하면 저장되고 배지에 범위가 표시된다.
    await page.evaluate(() => { approvalChainSettings = { ...approvalChainSettings, amountTiers: [] }; gotoPage("approval-templates"); });
    await page.locator("button", { hasText: "+ 금액 구간 추가" }).click();
    const picker = page.locator(".modal-box", { hasText: "금액 구간 결재자 선택" });
    await picker.locator("#op-search").fill("구간재무");
    await picker.locator("#op-tree label", { hasText: "구간재무" }).click();
    await picker.locator("button", { hasText: "선택 완료" }).click();
    const modal = page.locator(".modal-box", { hasText: "금액 구간 설정" });
    await modal.locator("#at-min").fill("3000000");
    await modal.locator(".at-tpl[value='tpl-expense']").check();
    await modal.locator(".at-tpl[value='tpl-vacation']").check();
    await modal.locator("button", { hasText: "추가" }).click();
    await expect(page.locator("#content")).toContainText("3,000,000원 이상 → 구간재무");
    await expect(page.locator("#content")).toContainText("경비 지출 신청");
    expect((await page.evaluate(() => approvalChainSettings.amountTiers[0].tplIds)).sort()).toEqual(["tpl-expense", "tpl-vacation"]);
    expect(pageErrors).toEqual([]);
  });
});
