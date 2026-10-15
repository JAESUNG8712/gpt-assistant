const { test, expect } = require("@playwright/test");

// 작업6(종합 재점검) — companies.status(trial/active/suspended) enforcement의 부작용
// 점검 중 발견: 서버는 회사가 정지(suspended)되면 모든 요청을 즉시 403 COMPANY_SUSPENDED로
// 정확히 거부하지만(authenticate() 미들웨어, 작업1), 이 결과를 받는 배경 경로 3곳의 클라이언트
// 처리가 서로 달랐다 —
//   1) _doSave()는 이 코드를 구분하지 않고 일반 연결불안정 재시도 루프로 빠져, 3회 실패 후
//      "서버 연결이 불안정합니다. 자동 재연결합니다"라는 오해를 부르는 문구로 실제 정지
//      안내를 덮어썼다(재시도해도 바뀌지 않는 영구 상태인데 계속 재연결을 시도함).
//   2) 하트비트(30초 핑)는 r.ok===false인 분기 자체가 없어 아무 반응도 없이 조용히
//      넘어가(화면이 "정상"처럼 보이는 채로) 매번 똑같이 재시도됐다.
//   3) loadFromServer()만 r.message를 그대로 보여줘 상대적으로 괜찮았지만, 배경 타이머를
//      멈추지 않아 계속 불필요한 요청이 나갔다.
// 세 경로 모두 공용 헬퍼 _handleCompanySuspended()를 거치도록 통일해 수정했다 — 이 테스트는
// 그 세 경로가 전부 올바른 메시지를 보여주고 배경 타이머(자동저장+하트비트)를 멈추는지
// 직접 확인한다(실제 멀티테넌트 companies 테이블은 JSON 파일 모드 e2e 서버에 없으므로,
// 서버가 실제로 보내는 403 응답 형태를 page.route()로 재현한다 — 이 프로젝트의 기존
// 관례, smoke.spec.js:823/859 참고).
const SUSPENDED_BODY = JSON.stringify({
  ok: false,
  code: "COMPANY_SUSPENDED",
  message: "이 회사는 현재 서비스가 일시 정지되었습니다. 관리자에게 문의하세요.",
});

async function loginAsAdmin(page) {
  // loadFromServer()도 함께 막는다 — 안 그러면 로그인 직후 백그라운드로 실행되는 그
  // 실제 호출의 "서버에서 데이터를 불러왔습니다" 성공 토스트가, 이 테스트가 나중에
  // 확인하는 "마지막 토스트"와 경합한다(이 프로젝트의 기존 관례, engagement-pulse.spec.js
  // 등 — 실측으로 재확인: 이 override 없이 실행하면 간헐적으로 이 경합이 재현됨).
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.evaluate(() => { autoSaveDebounced = () => {}; loadFromServer = async () => {}; connectSSE = async () => {}; });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

test.describe("작업6 — companies.status 정지(suspended) 클라이언트 UX", () => {
  test("_doSave()는 정지 응답을 받으면 재시도 없이 실제 안내를 보여주고 자동저장을 멈춘다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    // 정상 로그인 직후 startServerAutoSave()가 이미 실행돼 자동저장 타이머가 돌고 있어야
    // "정지 감지 후 멈춘다"는 전후 비교가 의미를 가진다.
    const timerBefore = await page.evaluate(() => _serverAutoSaveTimer);
    expect(timerBefore).not.toBeNull();

    await page.route("**/save", (route) =>
      route.fulfill({ status: 403, contentType: "application/json", body: SUSPENDED_BODY })
    );

    await page.evaluate(() => _doSave(false));

    const toast = page.locator(".toast").last();
    await expect(toast).toContainText("이 회사는 현재 서비스가 일시 정지되었습니다");
    // 수정 전 버그: 3회 실패해야 "연결 불안정" 문구가 뜨는데, 그 문구가 실제 정지 안내를
    // 덮어썼다 — 이 문구가 보이면 회귀.
    await expect(toast).not.toContainText("연결 불안정");

    const [status, msg, timerAfter] = await page.evaluate(() => [
      serverConfig.status, serverConfig.statusMsg, _serverAutoSaveTimer,
    ]);
    expect(status).toBe("error");
    expect(msg).toContain("일시 정지");
    expect(timerAfter).toBeNull();

    expect(pageErrors).toEqual([]);
  });

  test("하트비트(30초 핑)는 정지 응답을 받으면 조용히 넘어가지 않고 안내를 보여준다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.route("**/status", (route) =>
      route.fulfill({ status: 403, contentType: "application/json", body: SUSPENDED_BODY })
    );

    // 실제 30초를 기다리는 대신 setInterval이 호출하는 동일한 함수(_heartbeatTick)를
    // 직접 호출한다 — 동작은 동일하고, 테스트만 빨라진다(public/index.html의
    // _heartbeatTick 선언부 주석 참고).
    await page.evaluate(() => _heartbeatTick());

    const toast = page.locator(".toast").last();
    await expect(toast).toContainText("이 회사는 현재 서비스가 일시 정지되었습니다");

    const [status, timerAfter] = await page.evaluate(() => [serverConfig.status, _serverAutoSaveTimer]);
    expect(status).toBe("error");
    expect(timerAfter).toBeNull();

    expect(pageErrors).toEqual([]);
  });

  test("loadFromServer()는 정지 응답을 받으면 안내를 보여주고 배경 타이머도 멈춘다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    // 로그인 시점의 loadFromServer() 호출은 이 프로젝트의 기존 관례대로 막아
    // 배경동기화 경합을 피하되, 그 전에 원본 구현을 캡쳐해뒀다가 로그인 후 복원해
    // 실제 동작을 테스트한다.
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.evaluate(() => {
      autoSaveDebounced = () => {};
      connectSSE = async () => {};
      window.__realLoadFromServer = loadFromServer;
      loadFromServer = async () => {};
    });
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
    await page.evaluate(() => { loadFromServer = window.__realLoadFromServer; });

    await page.route("**/data", (route) =>
      route.fulfill({ status: 403, contentType: "application/json", body: SUSPENDED_BODY })
    );

    await page.evaluate(() => loadFromServer());

    const toast = page.locator(".toast").last();
    await expect(toast).toContainText("이 회사는 현재 서비스가 일시 정지되었습니다");

    const [status, timerAfter] = await page.evaluate(() => [serverConfig.status, _serverAutoSaveTimer]);
    expect(status).toBe("error");
    expect(timerAfter).toBeNull();

    expect(pageErrors).toEqual([]);
  });
});
