const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
});

test("채용 조회 실패는 빈 목록 성공으로 표시하지 않고 재시도할 수 있다", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const original = serverRequest;
    try {
      _recruitLoaded = false;
      serverRequest = async () => ({ ok: false, message: "일시적 연결 오류" });
      const failed = await loadRecruitFromServer(true);
      const failedState = { failed, loaded: _recruitLoaded, error: _recruitLoadError };
      serverRequest = async (_method, endpoint) => endpoint.includes("/jobs")
        ? { ok: true, jobs: [{ id: "job-1", title: "개발자" }] }
        : endpoint.includes("/candidates") ? { ok: true, candidates: [] }
        : { ok: true, interviews: [] };
      const retried = await loadRecruitFromServer(true);
      return { failedState, retried, loaded: _recruitLoaded, error: _recruitLoadError, jobs: recruitJobs.length };
    } finally { serverRequest = original; }
  });
  expect(result.failedState).toEqual({ failed: false, loaded: false, error: "일시적 연결 오류" });
  expect(result).toMatchObject({ retried: true, loaded: true, error: "", jobs: 1 });
});

test("로그아웃 뒤 도착한 이전 채용 응답은 다음 세션 캐시를 채우지 않는다", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const original = serverRequest;
    const pending = [];
    try {
      serverRequest = () => new Promise(resolve => pending.push(resolve));
      const staleLoad = loadRecruitFromServer(true);
      await Promise.resolve();
      clearProtectedModuleState();
      pending[0]({ ok: true, jobs: [{ id: "old-company-job" }] });
      pending[1]({ ok: true, candidates: [{ id: "old-company-candidate" }] });
      pending[2]({ ok: true, interviews: [{ id: "old-company-interview" }] });
      await staleLoad;
      return { loaded: _recruitLoaded, jobs: recruitJobs.length, candidates: recruitCandidates.length, interviews: recruitInterviews.length };
    } finally { serverRequest = original; }
  });
  expect(result).toEqual({ loaded: false, jobs: 0, candidates: 0, interviews: 0 });
});

test("로그아웃은 다른 회사 자료가 남지 않도록 클라이언트 상태를 새로 시작한다", async ({ page }) => {
  await page.evaluate(() => {
    employmentRecords = [{ id: "old-company-private", title: "이전 회사 계약" }];
    settings.oldCompanyMarker = "이전 회사 설정";
  });
  await page.click("#topbar-logout-btn");
  await expect(page.locator("#l-id")).toBeVisible();
  const state = await page.evaluate(() => ({
    contracts: employmentRecords.length,
    marker: settings.oldCompanyMarker || null,
    token: localStorage.getItem("hr_kpi_auth_token"),
  }));
  expect(state).toEqual({ contracts: 0, marker: null, token: null });
});

test("이전 세션의 늦은 401 응답은 새 로그인 토큰을 지우지 않는다", async ({ page }) => {
  const tokenAfterResponse = await page.evaluate(async () => {
    const originalFetch = window.fetch, originalToken = _authToken;
    let finishRequest;
    try {
      window.fetch = () => new Promise(resolve => { finishRequest = resolve; });
      _setAuthToken("old-session-token");
      const pending = serverRequest("GET", "/data");
      _setAuthToken("new-session-token");
      finishRequest(new Response(JSON.stringify({ ok: false }), { status: 401, headers: { "Content-Type": "application/json" } }));
      await pending;
      return _authToken;
    } finally { window.fetch = originalFetch; _setAuthToken(originalToken); }
  });
  expect(tokenAfterResponse).toBe("new-session-token");
});
