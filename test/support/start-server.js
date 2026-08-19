// server.js를 별도 child process로 띄우는 테스트 전용 헬퍼. server.js 자체는
// require 시점에 app.listen()을 바로 호출하는 구조(startServer()를 export하는
// 형태가 아님)라, in-process로 여러 인스턴스를 올릴 수 없다 — 대신 child_process로
// 완전히 격리된 프로세스를 매 테스트 파일마다 하나씩 띄운다(임시 DATA_FILE/
// BUDGET_DATA_FILE, 랜덤 포트, 고정 SESSION_SECRET, NODE_ENV 상속). 운영 DB나
// 실제 데이터 파일은 절대 건드리지 않는다 — 항상 os.tmpdir() 아래 새 디렉토리에만 쓴다.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return res;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`서버가 ${timeoutMs}ms 안에 응답하지 않았습니다: ${url} (${lastErr && lastErr.message})`);
}

// opts: { env: {...추가 환경변수} }
// 반환: { baseUrl, stop(), dataDir, dataFile, budgetDataFile }
async function startServer(opts = {}) {
  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-test-"));
  const dataFile = path.join(dataDir, "hr-data.json");
  const budgetDataFile = path.join(dataDir, "budget-data.json");

  const env = {
    ...process.env,
    PORT: String(port),
    DATA_FILE: dataFile,
    BUDGET_DATA_FILE: budgetDataFile,
    SESSION_SECRET: "test-session-secret-not-for-production",
    NODE_ENV: process.env.NODE_ENV || "test",
    ...(opts.env || {}),
  };
  // 운영 DB로 실수로 연결되는 사고를 원천 차단 — 이 헬퍼는 파일 모드 테스트 전용이다
  // (Postgres 모드가 필요한 테스트는 DATABASE_URL을 opts.env로 명시적으로 넘겨야 하고,
  // 그 경우도 이 헬퍼가 스스로 만든 임시 테스트 DB를 가리켜야 한다 — test/api/postgres-mode.test.js 참고).
  if (!opts.env || !opts.env.DATABASE_URL) delete env.DATABASE_URL;

  const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "server.js")], {
    cwd: path.join(__dirname, "..", ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = { stdout: "", stderr: "" };
  child.stdout.on("data", d => { logs.stdout += d.toString(); });
  child.stderr.on("data", d => { logs.stderr += d.toString(); });

  let exited = false;
  child.on("exit", () => { exited = true; });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${baseUrl}/status`, 15000);
  } catch (e) {
    child.kill("SIGKILL");
    throw new Error(`${e.message}\n--- stdout ---\n${logs.stdout}\n--- stderr ---\n${logs.stderr}`);
  }

  async function stop() {
    if (exited) return;
    child.kill("SIGTERM");
    await new Promise(resolve => {
      const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} resolve(); }, 3000);
      child.on("exit", () => { clearTimeout(t); resolve(); });
    });
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }

  return { baseUrl, stop, dataDir, dataFile, budgetDataFile, logs, child };
}

module.exports = { startServer, getFreePort };
