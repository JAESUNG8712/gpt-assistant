// scripts/seed-demo.js CLI 전용 회귀 테스트. child process로 실제 스크립트를 실행해
// exit code와 생성된 파일 내용을 검증한다 — 실제 DB/운영 데이터 파일은 건드리지
// 않는다(항상 os.tmpdir() 아래 임시 디렉터리의 --output 경로에만 쓴다).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const bcrypt = require("bcryptjs");
const { buildDemoDataset } = require("../lib/demo-data");

const SEED_SCRIPT = path.join(__dirname, "..", "scripts", "seed-demo.js");

function runSeed(args, env, cwd) {
  return spawnSync(process.execPath, [SEED_SCRIPT, ...args], {
    cwd: cwd || __dirname,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("seed-demo CLI: 정상 실행은 admin 1명 + bcrypt 해시만 있는 비밀번호 + demo 마커를 생성한다", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-test-seeddemo-"));
  const outputPath = path.join(dataDir, "demo.json");
  const result = runSeed(
    ["--confirm=CREATE_DEMO_FILE", `--output=${outputPath}`, "--count=1", "--past-years=0"],
    { NODE_ENV: "development", ALLOW_DEMO_SEED: "true", DEMO_ADMIN_PASSWORD: "TestAdminPw123" }
  );
  assert.equal(result.status, 0, "정상 실행은 exit 0이어야 함: " + result.stderr);
  assert.ok(fs.existsSync(outputPath));

  const content = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const admin = content.employees.find(e => e.role === "admin");
  assert.ok(admin, "admin 역할 직원이 정확히 1명 있어야 함");
  assert.equal(content.employees.filter(e => e.role === "admin").length, 1);
  assert.equal(admin.loginId, "demo_admin");
  assert.equal(admin.empNo, "DEMO-0000");
  assert.equal(admin.source, "demo");

  // 비밀번호는 bcrypt 해시로만 저장돼야 한다 — 평문("TestAdminPw123")이 파일 어디에도
  // 그대로 남아있지 않아야 하고, 저장된 해시가 실제로 그 평문과 매칭돼야 한다.
  assert.match(admin.pw, /^\$2[aby]\$/, "관리자 비밀번호는 bcrypt 해시 형식이어야 함");
  assert.ok(await bcrypt.compare("TestAdminPw123", admin.pw), "저장된 해시가 실제 비밀번호와 일치해야 함");
  const rawFileText = fs.readFileSync(outputPath, "utf8");
  assert.ok(!rawFileText.includes("TestAdminPw123"), "평문 비밀번호가 파일에 그대로 남아있으면 안 됨");

  // 콘솔 출력에도 평문 비밀번호가 절대 없어야 하고, 로그인 ID는 안내돼야 한다.
  assert.ok(!result.stdout.includes("TestAdminPw123"), "콘솔 출력에 평문 비밀번호가 있으면 안 됨");
  assert.match(result.stdout, /demo_admin/);

  // 나머지 직원들도 전부 demo 마커를 갖고 있어야 한다.
  for (const e of content.employees) {
    assert.ok(e.source === "demo", `모든 직원은 source:"demo"를 가져야 함(위반: ${e.loginId})`);
    assert.match(e.empNo, /^DEMO-\d{4}$/);
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("seed-demo CLI: DEMO_ADMIN_PASSWORD 누락/짧음은 exit 1이고 파일을 만들지 않는다", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-test-seeddemo-pw-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  await t.test("DEMO_ADMIN_PASSWORD 미설정 => exit 1", () => {
    const outputPath = path.join(dataDir, "no-pw.json");
    const result = runSeed(["--confirm=CREATE_DEMO_FILE", `--output=${outputPath}`], { NODE_ENV: "development", ALLOW_DEMO_SEED: "true" });
    assert.equal(result.status, 1);
    assert.ok(!fs.existsSync(outputPath));
  });

  await t.test("DEMO_ADMIN_PASSWORD가 8자 미만 => exit 1", () => {
    const outputPath = path.join(dataDir, "short-pw.json");
    const result = runSeed(["--confirm=CREATE_DEMO_FILE", `--output=${outputPath}`], { NODE_ENV: "development", ALLOW_DEMO_SEED: "true", DEMO_ADMIN_PASSWORD: "short1" });
    assert.equal(result.status, 1);
    assert.ok(!fs.existsSync(outputPath));
  });
});

test("seed-demo CLI: --count 범위 검증(0, -1, Infinity, 51은 exit 1 / 1~50은 통과)", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-test-seeddemo-count-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const baseEnv = { NODE_ENV: "development", ALLOW_DEMO_SEED: "true", DEMO_ADMIN_PASSWORD: "TestAdminPw123" };

  for (const bad of ["0", "-1", "Infinity", "51", "3.5"]) {
    await t.test(`--count=${bad} => exit 1, 파일 생성 안 됨`, () => {
      const outputPath = path.join(dataDir, `count-${bad.replace(/[^\w.-]/g, "_")}.json`);
      const result = runSeed(["--confirm=CREATE_DEMO_FILE", `--output=${outputPath}`, `--count=${bad}`], baseEnv);
      assert.equal(result.status, 1, `count=${bad}는 exit 1이어야 함, stderr=${result.stderr}`);
      assert.ok(!fs.existsSync(outputPath));
    });
  }

  await t.test("--count=1과 --count=50(경계값)은 정상 통과", () => {
    for (const ok of ["1", "50"]) {
      const outputPath = path.join(dataDir, `count-ok-${ok}.json`);
      const result = runSeed(["--confirm=CREATE_DEMO_FILE", `--output=${outputPath}`, `--count=${ok}`, "--past-years=0"], baseEnv);
      assert.equal(result.status, 0, `count=${ok}는 exit 0이어야 함, stderr=${result.stderr}`);
      assert.ok(fs.existsSync(outputPath));
    }
  });
});

test("seed-demo CLI: --past-years 범위 검증(0~10만 허용)", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-test-seeddemo-py-"));
  const baseEnv = { NODE_ENV: "development", ALLOW_DEMO_SEED: "true", DEMO_ADMIN_PASSWORD: "TestAdminPw123" };
  const outputBad = path.join(dataDir, "py-bad.json");
  const badResult = runSeed(["--confirm=CREATE_DEMO_FILE", `--output=${outputBad}`, "--past-years=11", "--count=1"], baseEnv);
  assert.equal(badResult.status, 1);
  assert.ok(!fs.existsSync(outputBad));

  const outputOk = path.join(dataDir, "py-ok.json");
  const okResult = runSeed(["--confirm=CREATE_DEMO_FILE", `--output=${outputOk}`, "--past-years=0", "--count=1"], baseEnv);
  assert.equal(okResult.status, 0, okResult.stderr);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("seed-demo CLI: 기존 파일을 절대 덮어쓰지 않는다(--force 옵션 자체가 없음)", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-test-seeddemo-noforce-"));
  const outputPath = path.join(dataDir, "existing.json");
  fs.writeFileSync(outputPath, JSON.stringify({ marker: "original content, must survive" }));
  const baseEnv = { NODE_ENV: "development", ALLOW_DEMO_SEED: "true", DEMO_ADMIN_PASSWORD: "TestAdminPw123" };

  const result = runSeed(["--confirm=CREATE_DEMO_FILE", `--output=${outputPath}`, "--count=1", "--past-years=0", "--force"], baseEnv);
  assert.equal(result.status, 1, "--force를 붙여도 이 스크립트엔 그런 옵션이 없어 그대로 거부돼야 함");
  const stillOriginal = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(stillOriginal.marker, "original content, must survive");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("seed-demo CLI: DATA_FILE과 같은 경로로는 절대 쓰지 않는다", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-test-seeddemo-protect-"));
  const protectedPath = path.join(dataDir, "protected.json");
  const baseEnv = { NODE_ENV: "development", ALLOW_DEMO_SEED: "true", DEMO_ADMIN_PASSWORD: "TestAdminPw123", DATA_FILE: protectedPath };
  const result = runSeed(["--confirm=CREATE_DEMO_FILE", `--output=${protectedPath}`, "--count=1", "--past-years=0"], baseEnv);
  assert.equal(result.status, 1);
  assert.ok(!fs.existsSync(protectedPath));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("seed-demo CLI: 실행 조건(NODE_ENV/DATABASE_URL/ALLOW_DEMO_SEED/confirm) 하나라도 빠지면 exit 1", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-test-seeddemo-guards-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const fullEnv = { NODE_ENV: "development", ALLOW_DEMO_SEED: "true", DEMO_ADMIN_PASSWORD: "TestAdminPw123" };
  const fullArgs = (out) => ["--confirm=CREATE_DEMO_FILE", `--output=${out}`, "--count=1", "--past-years=0"];

  await t.test("NODE_ENV=production => exit 1", () => {
    const out = path.join(dataDir, "g1.json");
    const r = runSeed(fullArgs(out), { ...fullEnv, NODE_ENV: "production" });
    assert.equal(r.status, 1); assert.ok(!fs.existsSync(out));
  });
  await t.test("DATABASE_URL이 설정되어 있으면 => exit 1", () => {
    const out = path.join(dataDir, "g2.json");
    const r = runSeed(fullArgs(out), { ...fullEnv, DATABASE_URL: "postgres://fake/fake" });
    assert.equal(r.status, 1); assert.ok(!fs.existsSync(out));
  });
  await t.test("ALLOW_DEMO_SEED 미설정 => exit 1", () => {
    const out = path.join(dataDir, "g3.json");
    const r = runSeed(fullArgs(out), { ...fullEnv, ALLOW_DEMO_SEED: undefined });
    assert.equal(r.status, 1); assert.ok(!fs.existsSync(out));
  });
  await t.test("--confirm 누락 => exit 1", () => {
    const out = path.join(dataDir, "g4.json");
    const r = runSeed([`--output=${out}`, "--count=1"], fullEnv);
    assert.equal(r.status, 1); assert.ok(!fs.existsSync(out));
  });
});

test("lib/demo-data buildDemoDataset(): adminPassword 미지정/짧음은 reject된다(직접 호출 시에도 방어)", async () => {
  await assert.rejects(() => buildDemoDataset({ count: 1, pastYears: 0 }), /admin 비밀번호/);
  await assert.rejects(() => buildDemoDataset({ count: 1, pastYears: 0, adminPassword: "short" }), /admin 비밀번호/);
  const ds = await buildDemoDataset({ count: 1, pastYears: 0, adminPassword: "ValidPassword123" });
  assert.equal(ds.meta.adminLoginId, "demo_admin");
});
