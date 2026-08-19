// 운영 더미 데이터 게이트(rejectDemoDataForProduction) 전용 회귀 테스트.
// mkdtemp의 DATA_FILE/BUDGET_DATA_FILE, 랜덤 PORT, child process `node server.js`만
// 사용한다 — 실제 DB나 운영 데이터 파일은 이 테스트가 존재하는지조차 모른다(항상
// os.tmpdir() 아래 새 디렉터리에만 쓰고, 끝나면 지운다).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startServer, startServerExpectingBootFailure } = require("./support/start-server");

async function seedAdminAndLogin(server, empId = 1) {
  const pw = await bcrypt.hash("Admin@123", 10);
  const saveRes = await fetch(server.baseUrl + "/save", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { employees: [{ id: empId, loginId: "admin", pw, name: "관리자", role: "admin", active: true }] } }),
  });
  assert.equal(saveRes.status, 200, "부트스트랩 admin 저장 실패");
  const loginRes = await fetch(server.baseUrl + "/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId: "admin", pw: "Admin@123" }),
  });
  const { token } = await loginRes.json();
  assert.ok(token, "로그인 토큰 발급 실패");
  return token;
}

test("demo data gate: production 서버에서 POST /save가 더미 마커를 거부한다", async (t) => {
  const server = await startServer({ env: { NODE_ENV: "production" } });
  t.after(() => server.stop());
  const token = await seedAdminAndLogin(server);

  await t.test("source:\"demo\" 직원 저장 시도 => 403 DEMO_DATA_FORBIDDEN", async () => {
    const res = await fetch(server.baseUrl + "/save", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({
        _version: 1,
        data: {
          employees: [
            { id: 1, loginId: "admin", pw: "x", name: "관리자", role: "admin", active: true },
            { id: 2, loginId: "demo1", pw: "x", name: "데모직원", role: "member", active: true, source: "demo", empNo: "DEMO-0002" },
          ],
        },
      }),
    });
    const json = await res.json();
    assert.equal(res.status, 403);
    assert.equal(json.code, "DEMO_DATA_FORBIDDEN");
  });

  await t.test("레거시 DM 패턴(empNo:\"DM경인001\") => 403 DEMO_DATA_FORBIDDEN", async () => {
    const res = await fetch(server.baseUrl + "/save", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({
        _version: 1,
        data: {
          employees: [
            { id: 1, loginId: "admin", pw: "x", name: "관리자", role: "admin", active: true },
            { id: 3, loginId: "dummy001", pw: "x", name: "홍길동", role: "member", active: true, empNo: "DM경인001" },
          ],
        },
      }),
    });
    const json = await res.json();
    assert.equal(res.status, 403);
    assert.equal(json.code, "DEMO_DATA_FORBIDDEN");
  });

  await t.test("KPI만 더미(source:\"demo\", employees는 깨끗함) => 403 DEMO_DATA_FORBIDDEN", async () => {
    const res = await fetch(server.baseUrl + "/save", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({
        _version: 1,
        data: {
          employees: [{ id: 1, loginId: "admin", pw: "x", name: "관리자", role: "admin", active: true }],
          kpiEntries: [{ id: "k1", userId: 1, year: 2025, source: "demo" }],
        },
      }),
    });
    const json = await res.json();
    assert.equal(res.status, 403);
    assert.equal(json.code, "DEMO_DATA_FORBIDDEN");
  });

  await t.test("더미 마커 없는 평범한 저장은 그대로 통과한다(false positive 아님)", async () => {
    const res = await fetch(server.baseUrl + "/save", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({
        _version: 1,
        data: { employees: [{ id: 1, loginId: "admin", pw: "x", name: "관리자", role: "admin", active: true, phone: "010-1111-2222" }] },
      }),
    });
    assert.equal(res.status, 200);
  });
});

test("demo data gate: 부팅 시점 fail-fast(DATA_FILE에 이미 더미 마커가 있는 상태에서 production 부팅)", async (t) => {
  await t.test("source:\"demo\" 직원이 이미 DATA_FILE에 있으면 부팅 자체가 실패하고 파일이 그대로 남는다", async () => {
    const pw = await bcrypt.hash("Whatever123", 10);
    const seedData = {
      employees: [{ id: 1, loginId: "admin", pw, name: "관리자", role: "admin", active: true, source: "demo", empNo: "DEMO-0001" }],
      kpiEntries: [], _version: 1,
    };
    const result = await startServerExpectingBootFailure({ env: { NODE_ENV: "production" }, seedData });
    assert.notEqual(result.exitCode, 0, "정상 종료(0)가 아니라 오류로 종료돼야 함");
    assert.match(result.logs.stderr + result.logs.stdout, /더미 데이터/);
    const onDisk = JSON.parse(require("fs").readFileSync(result.dataFile, "utf8"));
    assert.equal(onDisk.employees.length, 1, "실패한 부팅이 파일을 건드리면 안 됨(읽기만 하고 쓰지 않아야 함)");
    result.cleanup();
  });

  await t.test("레거시 DM 패턴 empNo가 이미 DATA_FILE에 있으면 부팅이 실패한다", async () => {
    const pw = await bcrypt.hash("Whatever123", 10);
    const seedData = {
      employees: [
        { id: 1, loginId: "admin", pw, name: "관리자", role: "admin", active: true },
        { id: 2, loginId: "dummy1", pw, name: "홍길동", role: "member", active: true, empNo: "DM경인001" },
      ],
      kpiEntries: [], _version: 1,
    };
    const result = await startServerExpectingBootFailure({ env: { NODE_ENV: "production" }, seedData });
    assert.notEqual(result.exitCode, 0);
    result.cleanup();
  });

  await t.test("KPI만 더미인 경우도 부팅이 실패한다", async () => {
    const pw = await bcrypt.hash("Whatever123", 10);
    const seedData = {
      employees: [{ id: 1, loginId: "admin", pw, name: "관리자", role: "admin", active: true }],
      kpiEntries: [{ id: "k1", userId: 1, year: 2025, source: "demo" }],
      _version: 1,
    };
    const result = await startServerExpectingBootFailure({ env: { NODE_ENV: "production" }, seedData });
    assert.notEqual(result.exitCode, 0);
    result.cleanup();
  });

  await t.test("더미 마커 없는 정상 데이터는 production에서도 정상 부팅된다(false positive 아님)", async (t2) => {
    const server = await startServer({ env: { NODE_ENV: "production" } });
    t2.after(() => server.stop());
    const res = await fetch(server.baseUrl + "/status");
    assert.equal(res.status, 200);
  });

  await t.test("ALLOW_DEMO_DATA=true로 명시 해제하면 더미 마커가 있어도 정상 부팅된다(탈출구)", async () => {
    const pw = await bcrypt.hash("Whatever123", 10);
    const seedData = {
      employees: [{ id: 1, loginId: "admin", pw, name: "관리자", role: "admin", active: true, source: "demo", empNo: "DEMO-0001" }],
      kpiEntries: [], _version: 1,
    };
    // 이번엔 정상 부팅을 기대하므로 startServer()(느긋한 /status 폴링)를 쓴다.
    const dataDir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "hr-test-allowdemo-"));
    const dataFile = require("path").join(dataDir, "hr-data.json");
    require("fs").writeFileSync(dataFile, JSON.stringify(seedData));
    const server = await startServer({ env: { NODE_ENV: "production", ALLOW_DEMO_DATA: "true", DATA_FILE: dataFile } });
    try {
      const res = await fetch(server.baseUrl + "/status");
      assert.equal(res.status, 200);
    } finally {
      await server.stop();
      require("fs").rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test("demo data gate: production에서 개발 스냅샷을 /restore로 복원하면 403이고 실제로 반영되지 않는다", async (t) => {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-test-restoregate-"));
  const dataFile = path.join(dataDir, "hr-data.json");
  const snapFile = path.join(dataDir, "hr-data-snapshots.json");
  const pwHash = await bcrypt.hash("Admin@123", 10);

  // 운영 부팅이 성공하도록 라이브 데이터는 깨끗하게 유지하고, 스냅샷(별도 파일)에만
  // 더미 마커가 섞인 "개발 환경에서 만든 스냅샷"을 시뮬레이션한다.
  fs.writeFileSync(dataFile, JSON.stringify({
    employees: [{ id: 1, loginId: "admin", pw: pwHash, name: "관리자", role: "admin", active: true }],
    kpiEntries: [], _version: 1,
  }));
  fs.writeFileSync(snapFile, JSON.stringify({
    2025: {
      data: {
        employees: [
          { id: 1, loginId: "admin", pw: pwHash, name: "관리자", role: "admin", active: true },
          { id: 99, loginId: "demo1", pw: pwHash, name: "데모직원", role: "member", active: true, source: "demo", empNo: "DEMO-0099" },
        ],
        kpiEntries: [],
      },
      empCount: 2, kpiCount: 0, confirmedBy: "admin", label: "2025년 개발 스냅샷", createdAt: new Date().toISOString(),
    },
  }));

  const server = await startServer({ env: { NODE_ENV: "production", DATA_FILE: dataFile } });
  t.after(async () => { await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const loginRes = await fetch(server.baseUrl + "/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId: "admin", pw: "Admin@123" }),
  });
  const { token } = await loginRes.json();
  assert.ok(token);

  await t.test("복원 시도는 403 DEMO_DATA_FORBIDDEN", async () => {
    const res = await fetch(server.baseUrl + "/restore", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ name: "2025년 개발 스냅샷", fields: ["employees"], deleteExtras: false }),
    });
    const json = await res.json();
    assert.equal(res.status, 403);
    assert.equal(json.code, "DEMO_DATA_FORBIDDEN");
  });

  await t.test("거부된 복원이 실제로 반영되지 않았다(살아있는 데이터는 admin 1명 그대로)", async () => {
    const dataRes = await fetch(server.baseUrl + "/data", { headers: { Authorization: "Bearer " + token } });
    const dataJson = await dataRes.json();
    const employees = dataJson.data ? dataJson.data.employees : dataJson.employees;
    assert.equal(employees.length, 1);
    assert.ok(!employees.some(e => e.source === "demo"));
  });
});
