// @ts-check
// e2e 설정. Chromium 한 종류만, CI에서만 재시도 1회, 실패 시 trace/screenshot을
// 보존해 원격에서도 실패 원인을 볼 수 있게 한다. 서버는 webServer가 아니라
// e2e/fixtures.js가 spec 파일마다 띄우고 끈다(파일 간 상태 간섭 방지).
// 이 환경(및 대부분의 사내/CI 컨테이너)은 브라우저가 /opt/pw-browsers 아래
// 미리 설치돼 있고 재다운로드가 막혀 있으므로, executablePath로 그 경로를
// 명시한다 — 다른 환경(로컬 개발자 PC 등)에서는 이 경로가 없을 수 있으니
// PLAYWRIGHT_CHROMIUM_PATH로 재정의할 수 있게 하고, 지정이 없으면 Playwright의
// 기본 탐색(자체 다운로드한 브라우저)에 맡긴다 — 로컬 개발 PC에서 처음 실행하는
// 경우 `npx playwright install chromium`으로 브라우저를 먼저 설치해야 한다.
const path = require("path");
const { defineConfig, devices } = require("@playwright/test");

const isCI = !!process.env.CI;
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
});
