// @ts-check
// P1-3 e2e 스캐폴드. Chromium 한 종류만, CI에서만 재시도 1회, 실패 시
// trace/screenshot을 보존해 원격에서도 실패 원인을 볼 수 있게 한다.
// 이 환경(및 대부분의 사내/CI 컨테이너)은 브라우저가 /opt/pw-browsers 아래
// 미리 설치돼 있고 재다운로드가 막혀 있으므로, executablePath로 그 경로를
// 명시한다 — 다른 환경(로컬 개발자 PC 등)에서는 이 경로가 없을 수 있으니
// PLAYWRIGHT_CHROMIUM_PATH로 재정의할 수 있게 하고, 지정이 없으면 Playwright의
// 기본 탐색(자체 다운로드한 브라우저)에 맡긴다 — 로컬 개발 PC에서 처음 실행하는
// 경우 `npx playwright install chromium`으로 브라우저를 먼저 설치해야 한다.
const path = require("path");
const { defineConfig, devices } = require("@playwright/test");

const isCI = !!process.env.CI;
const PORT = process.env.E2E_PORT || "4300";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || (
  require("fs").existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined
);

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // video는 Playwright 내장 ffmpeg가 필요한데, 시스템 Chrome/자체 설치 브라우저를
    // 쓰는 로컬 환경에는 그게 없을 수 있어(실측: 로컬 실행이 이 때문에 실패) CI에서만
    // 켠다 — CI는 `npx playwright install --with-deps`로 ffmpeg까지 항상 설치된다.
    video: isCI ? "retain-on-failure" : "off",
    ...(chromiumExecutablePath ? { launchOptions: { executablePath: chromiumExecutablePath } } : {}),
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `node ${path.join(__dirname, "test", "support", "start-e2e-server.js")}`,
    url: `${BASE_URL}/status`,
    timeout: 30000,
    // 이전엔 로컬에서만 true(기존 실행 중인 서버 재사용)였는데, 실패한 실행이 고정
    // 포트(4300)의 e2e 서버 프로세스를 죽이지 못하고 남겨두면 다음 실행이 그 오래된
    // (이번 테스트가 시딩하지 않은) 프로세스를 그대로 재사용해버리는 문제가 실측됐다
    // — 항상 새로 띄우고 테스트가 끝나면 Playwright가 종료시키도록 고정한다. 여러
    // QA를 동시에 로컬에서 돌리고 싶으면 포트 충돌을 피하기 위해 각자 다른
    // E2E_PORT를 지정해서 실행한다(예: E2E_PORT=4301 npx playwright test).
    reuseExistingServer: false,
    env: { E2E_PORT: PORT },
    stdout: "pipe",
    stderr: "pipe",
  },
});
