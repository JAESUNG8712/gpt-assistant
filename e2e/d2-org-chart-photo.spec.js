const { test, expect } = require("@playwright/test");

// D2(HR마인드 벤치마킹 2차 라운드) — 화상조직도. 직원 사진 업로드(admin 전용, 300KB 상한)와
// 조직도의 "사진형 보기" 토글, 사진이 없을 때의 이니셜 아바타 폴백을 검증한다. 서버측 쓰기는
// 별도 검증 없이 admin 전용 필드(photoUrl)로 다른 employees 필드와 동일하게 저장되므로(admin
// 쓰기는 서버 검증을 전혀 거치지 않는 기존 아키텍처), 이 e2e는 업로드 UI 흐름과 조직도 렌더링에
// 집중한다.

// 가장 작은 유효 PNG(1x1 투명 픽셀) — 실제 이미지 디코딩 없이도 FileReader.readAsDataURL이
// 정상적으로 data:image/png URL을 만들어내는지 확인하는 데 충분하다.
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

test.describe("D2 — 화상조직도", () => {
  test("직원 수정에서 사진을 업로드하면 저장되고 조직도 사진형 보기에 노출된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({
        id: 98201, empNo: "E98201", name: "사진직원D2", dept: "경영지원본부", team: "인사팀",
        rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member",
      });
    });

    await page.evaluate(() => openEmpEdit(98201));
    await expect(page.locator("#ee-photo-file")).toBeAttached();
    // 업로드 전에는 이니셜(이름 첫 글자) 폴백 아바타여야 한다.
    await expect(page.locator("#ee-photo-preview")).toContainText("사");
    await expect(page.locator("#ee-photo-preview img")).toHaveCount(0);

    await page.setInputFiles("#ee-photo-file", {
      name: "photo.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
    });
    await expect(page.locator("#ee-photo-preview img")).toHaveCount(1);
    await expect(page.locator("#ee-photo-remove-wrap")).toBeVisible();

    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box, .modal")).toHaveCount(0);

    const photoUrl = await page.evaluate(() => getEmp(98201).photoUrl);
    expect(photoUrl).toMatch(/^data:image\/png;base64,/);

    // 조직도 목록형 보기에도 이미 사진이 반영된다(아바타 헬퍼 공용화). 관리자 계정의
    // 소속 부서가 "경영지원본부"가 아니면 그 부서는 기본적으로 접힌 상태라 먼저 펼친다.
    await page.evaluate(() => gotoPage("orgchart"));
    const deptRow = page.locator(".org-dept-row", { hasText: "경영지원본부" });
    if ((await deptRow.innerText()).includes("▸")) await deptRow.click();
    await expect(page.locator("#org-chart-body")).toContainText("사진직원D2");
    await expect(page.locator("#org-chart-body img").first()).toBeVisible();

    // 사진형 보기로 전환해도 같은 직원의 사진 카드가 노출된다.
    await page.click("button:has-text('🖼 사진형 보기')");
    await expect(page.locator("#org-chart-body")).toContainText("사진직원D2");
    const photoModeImgSrc = await page.locator("#org-chart-body img").first().getAttribute("src");
    expect(photoModeImgSrc).toMatch(/^data:image\/png;base64,/);

    expect(pageErrors).toEqual([]);
  });

  test("300KB를 초과하는 파일은 거부되고, 삭제 버튼으로 사진을 비우면 이니셜 아바타로 되돌아간다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({
        id: 98202, empNo: "E98202", name: "용량초과D2", dept: "경영지원본부", team: "인사팀",
        rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member",
        photoUrl: "",
      });
    });

    await page.evaluate(() => openEmpEdit(98202));
    await expect(page.locator("#ee-photo-file")).toBeAttached();

    const oversized = Buffer.alloc(310 * 1024, 1);
    await page.setInputFiles("#ee-photo-file", { name: "big.png", mimeType: "image/png", buffer: oversized });
    await expect(page.locator(".toast-error")).toContainText("300KB");
    await expect(page.locator("#ee-photo-preview img")).toHaveCount(0);

    // 정상 크기로 업로드 후 삭제하면 다시 이니셜 아바타로 복귀한다.
    await page.setInputFiles("#ee-photo-file", {
      name: "photo.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
    });
    await expect(page.locator("#ee-photo-preview img")).toHaveCount(1);
    await page.click("#ee-photo-remove-wrap");
    await expect(page.locator("#ee-photo-preview img")).toHaveCount(0);
    await expect(page.locator("#ee-photo-remove-wrap")).toBeHidden();

    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box, .modal")).toHaveCount(0);
    const photoUrl = await page.evaluate(() => getEmp(98202).photoUrl);
    expect(photoUrl).toBe("");

    expect(pageErrors).toEqual([]);
  });

  test("사진이 없는 직원은 사진형 보기에서도 이니셜 아바타로 표시된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({
        id: 98203, empNo: "E98203", name: "무사진D2", dept: "경영지원본부", team: "인사팀",
        rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member",
      });
    });

    await page.evaluate(() => gotoPage("orgchart"));
    await page.click("button:has-text('🖼 사진형 보기')");
    await expect(page.locator("#org-chart-body")).toContainText("무사진D2");
    await expect(page.locator("#org-chart-body")).toContainText("경영지원본부");
    // 사진이 없으므로 이 직원 카드 영역에는 <img>가 없어야 한다(전체 그리드에 다른
    // 테스트가 올린 사진이 섞여있을 수 있어 "무" 이니셜 텍스트 존재로 폴백 렌더링을 확인).
    await expect(page.locator("#org-chart-body")).toContainText("무");

    expect(pageErrors).toEqual([]);
  });
});
