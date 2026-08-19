// @ts-check
// P1-3 e2e 스캐폴드. Chromium 한 종류만, CI에서만 재시도 1회, 실패 시
// trace/screenshot/video를 보존해 원격에서도 실패 원인을 볼 수 있게 한다.
// 이 환경(및 대부분의 사내/CI 컨테이너)은 브라우저가 /opt/pw-browsers 아래
// 미리 설치돼 있고 재다운로드가 막혀 있으므로, executablePath로 그 경로를
// 명시한다 — 다른 환경(로컬 개발자 PC 등)에서는 이 경로가 없을 수 있으니
// PLAYWRIGHT_CHROMIUM_PATH로 재정의할 수 있게 하고, 지정이 없으면 Playwright의
// 기본 탐색(자체 다운로드한 브라우저)에 맡긴다.
const path = require("path");
const { defineConfig, devices } = require("@playwright/test");

const PORT = process.env.E2E_PORT || "4300";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || (
  require("fs").existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined
);

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ...(chromiumExecutablePath ? { launchOptions: { executablePath: chromiumExecutablePath } } : {}),
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `node ${path.join(__dirname, "test", "support", "start-e2e-server.js")}`,
    url: `${BASE_URL}/status`,
    timeout: 30000,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: PORT },
    stdout: "pipe",
    stderr: "pipe",
  },
});
