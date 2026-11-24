// e2e 공용 test 객체 — 테스트 "파일"마다 서버를 새로 띄운다.
//
// 이전에는 playwright.config.js의 webServer 하나를 전체 스위트가 함께 썼다. 그래서
// 앞 파일이 남긴 직원·설정·revision이 뒤 파일의 테스트에 그대로 남아, 실행 순서에 따라
// 간헐적으로 실패했다(예: settings 리비전 충돌로 저장이 조용히 거부되는 등).
//
// 이제 각 spec 파일은 `require("./fixtures")`에서 test/expect를 가져온다. 첫 테스트가
// 시작할 때 그 파일 전용 서버(빈 포트, 임시 DATA_FILE, 관리자 사전 시딩)를 띄우고,
// 다음 파일로 넘어가면 이전 서버를 끄고 새로 띄운다. 같은 파일 안의 테스트는 한 서버를
// 공유하므로 파일 내부 순서 의존은 그대로 유지된다. 재시도(retry)는 깨끗한 서버에서
// 다시 돌도록 항상 새로 띄운다.
//
// 워커 프로세스마다 상태가 따로 있으므로 workers를 늘려도 서로 간섭하지 않는다.
"use strict";
const path = require("path");
const { spawn } = require("child_process");
const { test: base, expect } = require("@playwright/test");
const { getFreePort } = require("../test/support/start-server");

const SERVER_SCRIPT = path.join(__dirname, "..", "test", "support", "start-e2e-server.js");
const READY_TIMEOUT_MS = 30000;

// 이 워커 프로세스가 지금 붙잡고 있는 서버. {file, url, proc}
let current = null;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function stopCurrent() {
  if (!current) return;
  const { proc } = current;
  current = null;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise((resolve) => {
    const force = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* 이미 종료됨 */ }
      resolve();
    }, 3000);
    proc.once("exit", () => { clearTimeout(force); resolve(); });
    try { proc.kill("SIGTERM"); } catch { /* 이미 종료됨 */ }
  });
}

async function startServerFor(file) {
  await stopCurrent();
  const port = await getFreePort();
  let stderr = "";
  const proc = spawn(process.execPath, [SERVER_SCRIPT], {
    env: { ...process.env, E2E_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });
  proc.stdout.on("data", () => { /* 드레인만 — 파이프가 막히지 않게 */ });
  const url = `http://127.0.0.1:${port}`;
  current = { file, url, proc };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (proc.exitCode !== null) {
      current = null;
      throw new Error(`e2e 서버가 시작 중 종료됨 (${path.basename(file)}):\n${stderr}`);
    }
    try {
      const res = await fetch(`${url}/status`);
      if (res.status < 500) break;
    } catch { /* 아직 리슨 전 */ }
    if (Date.now() > deadline) {
      await stopCurrent();
      throw new Error(`e2e 서버가 ${READY_TIMEOUT_MS}ms 안에 준비되지 않음 (${path.basename(file)}):\n${stderr}`);
    }
    await sleep(100);
  }
  return url;
}

const test = base.extend({
  // 기본 baseURL(config의 use.baseURL) 대신, 이 테스트가 속한 파일 전용 서버 주소를 준다.
  baseURL: [async ({}, use, testInfo) => {
    const needsFresh = !current || current.file !== testInfo.file || testInfo.retry > 0;
    const url = needsFresh ? await startServerFor(testInfo.file) : current.url;
    await use(url);
  }, { scope: "test" }],

  // 워커가 끝날 때 마지막 서버를 정리한다.
  _e2eServerCleanup: [async ({}, use) => {
    await use();
    await stopCurrent();
  }, { scope: "worker", auto: true }],
});

module.exports = { test, expect };
