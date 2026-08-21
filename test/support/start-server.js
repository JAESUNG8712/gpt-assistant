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

// startServer()와 startServerExpectingBootFailure() 둘 다 쓰는 공통 준비 단계
// (임시 디렉터리·포트·환경변수 조립) — 중복 없이 한 곳에만 둔다.
function _prepareChildEnv(opts) {
  const port = opts.port; // 호출부가 getFreePort()로 미리 뽑아 넘긴다
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), opts.dirPrefix || "hr-test-"));
  const dataFile = path.join(dataDir, "hr-data.json");
  const budgetDataFile = path.join(dataDir, "budget-data.json");
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_FILE: dataFile,
    BUDGET_DATA_FILE: budgetDataFile,
    SESSION_SECRET: "test-session-secret-not-for-production",
    BOOTSTRAP_SECRET: "test-bootstrap-secret",
    NODE_ENV: process.env.NODE_ENV || "test",
    ...(opts.env || {}),
  };
  // 운영 DB로 실수로 연결되는 사고를 원천 차단 — 이 헬퍼는 파일 모드 테스트 전용이다
  // (Postgres 모드가 필요한 테스트는 DATABASE_URL을 opts.env로 명시적으로 넘겨야 하고,
  // 그 경우도 이 헬퍼가 스스로 만든 임시 테스트 DB를 가리켜야 한다 — test/api/postgres-mode.test.js 참고).
  if (!opts.env || !opts.env.DATABASE_URL) delete env.DATABASE_URL;
  return { dataDir, dataFile, budgetDataFile, env };
}

function _spawnServer(env, cwd) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "server.js")], {
    cwd, env, stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = { stdout: "", stderr: "" };
  child.stdout.on("data", d => { logs.stdout += d.toString(); });
  child.stderr.on("data", d => { logs.stderr += d.toString(); });
  return { child, logs };
}

// opts: { env: {...추가 환경변수} }
// 반환: { baseUrl, stop(), dataDir, dataFile, budgetDataFile }
async function startServer(opts = {}) {
  const port = await getFreePort();
  const { dataDir, dataFile, budgetDataFile, env } = _prepareChildEnv({ ...opts, port });
  const { child, logs } = _spawnServer(env, path.join(__dirname, "..", ".."));

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

// 파일 모드의 최초 관리자는 더 이상 익명 /save로 만들지 않는다. 테스트도 같은 공개
// bootstrap 계약을 사용해 운영 보안 경로가 실수로 되돌아가는 회귀를 막는다.
async function bootstrapAdminAndLogin(server, { loginId, pw, name = "테스트 관리자" }) {
  const secret = "test-bootstrap-secret";
  const boot = await fetch(server.baseUrl + "/api/bootstrap/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bootstrap-Secret": secret },
    body: JSON.stringify({ loginId, pw, name }),
  });
  if (boot.status !== 201) throw new Error(`bootstrap failed: ${boot.status} ${await boot.text()}`);
  const login = await fetch(server.baseUrl + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  });
  const json = await login.json();
  if (!json.ok || !json.token) throw new Error(`bootstrap login failed: ${JSON.stringify(json)}`);
  return json;
}

// server.js가 부팅 자체를 거부하도록(예: production + DATA_FILE에 더미 마커) 의도한
// 시나리오 전용 — startServer()는 실패 시에도 /status를 15초 동안 계속 폴링하다가
// 타임아웃하므로 "정상적으로 빨리 죽는지"를 확인하는 용도로 쓰기엔 매번 15초씩 낭비된다.
// 대신 이 헬퍼는 child의 'exit' 이벤트를 직접 기다린다 — 실제 서버는 이 시나리오에서
// 수백 ms 안에 process.exit(1)하므로(initDB().catch()), 정상적으로 빠르게 끝난다.
// opts.seedData가 있으면 서버를 띄우기 전에 그 내용을 DATA_FILE에 미리 써 둔다.
async function startServerExpectingBootFailure(opts = {}) {
  const port = await getFreePort();
  const { dataDir, dataFile, budgetDataFile, env } = _prepareChildEnv({ ...opts, port, dirPrefix: "hr-test-bootfail-" });
  if (opts.seedData) fs.writeFileSync(dataFile, JSON.stringify(opts.seedData));
  const { child, logs } = _spawnServer(env, path.join(__dirname, "..", ".."));

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`서버가 fail-fast로 종료될 것으로 기대했으나 ${opts.timeoutMs || 5000}ms 안에 종료되지 않았습니다.\n--- stdout ---\n${logs.stdout}\n--- stderr ---\n${logs.stderr}`));
    }, opts.timeoutMs || 5000);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });

  return {
    exitCode, logs, dataDir, dataFile, budgetDataFile,
    // 실패 시나리오 검증 후 남은 파일 정리(성공적으로 부팅 실패했다면 파일은 손대지
    // 않은 채로 남아있어야 하므로, 호출부가 그 내용을 먼저 확인한 뒤 이걸 부른다).
    cleanup: () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} },
  };
}

module.exports = { startServer, startServerExpectingBootFailure, getFreePort, bootstrapAdminAndLogin };
