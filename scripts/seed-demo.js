// 로컬 개발/데모용 표본 HR 데이터 파일 생성 CLI (P1-3: 운영 더미 데이터 차단).
//
// 예전에 public/index.html 안에 있던 generateDummyData()/execGenerateDummy()
// (관리자가 운영 화면에서 버튼 한 번으로 지금 로드된 employees/kpiEntries 배열에
// 직접 가짜 데이터를 push하던 기능)를 완전히 대체한다. 그 버튼은 UI에서 제거됐고,
// 이 스크립트가 유일한 생성 경로다 — 실제 운영 서버 프로세스 안에서 실행되지 않고
// (서버를 띄우지 않는다), 항상 새 파일에만 쓰며, 아래 조건을 전부 만족해야만
// 실행된다. 이 조건들은 실수로 운영 환경에서 실행되는 것을 막기 위한 것이지,
// 로컬 개발자 편의를 해치려는 것이 아니다 — 로컬에서 그냥 기본값으로 실행하면
// 대부분 통과한다(운영 배포에서만 막힌다).
//
// Usage:
//   NODE_ENV=development ALLOW_DEMO_SEED=true DEMO_ADMIN_PASSWORD=<8자+ 비밀번호> \
//     node scripts/seed-demo.js --confirm=CREATE_DEMO_FILE --output=./demo-data.json
//
// Options:
//   --confirm=CREATE_DEMO_FILE   (필수) 실수로 실행하는 것을 막는 명시적 확인 플래그
//   --output=<path>              (필수) 생성할 파일 경로. 이 스크립트는 항상 새 파일만
//                                 만든다 — 이미 있는 파일이거나 DATA_FILE/hr-data.json과
//                                 같은 경로면 덮어쓰기 옵션 없이 무조건 거부한다.
//   --count=N                    부서별 팀당 생성할 팀원 수(1~50, 기본 5)
//   --past-years=N               과거 KPI 등급을 몇 년치 포함할지(0~10, 기본 3, 0=미포함)
//   --seed=N                     재현 가능한 데이터가 필요하면 정수 시드 지정(생략 시 매번 다름)
//
// 필수 환경변수:
//   DEMO_ADMIN_PASSWORD  생성될 관리자 계정(demo_admin)의 로그인 비밀번호(8자 이상).
//                        이 값은 bcrypt 해시로만 파일에 저장되고, 콘솔 출력에는
//                        로그인 ID만 나온다 — 비밀번호 자체는 어디에도 출력되지 않는다.
"use strict";
const fs = require("fs");
const path = require("path");
const { buildDemoDataset } = require("../lib/demo-data");

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) { out.flags.add(arg.slice(2)); continue; }
    out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

// --count/--past-years에 "Infinity", 음수, 소수, 비정상적으로 큰 값(예: 10000)이
// 들어와도 조용히 통과시키면 의도치 않게 거대한 더미 데이터셋을 만들 수 있다 —
// 정수이면서 지정한 범위 안에 있을 때만 허용하고, 아니면 즉시 에러로 종료한다.
function finiteInt(value, { name, min, max, fallback }) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── 실행 조건 — 하나라도 빠지면 즉시 종료(파일 생성 시도조차 하지 않음) ──
  const nodeEnv = process.env.NODE_ENV || "";
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    console.error(`[seed-demo] 거부: NODE_ENV가 "development" 또는 "test"여야 합니다(현재: "${nodeEnv || "(미설정)"}"). 운영 환경에서 실수로 실행되는 것을 막기 위한 조건입니다.`);
    process.exit(1);
  }
  if (process.env.DATABASE_URL) {
    console.error("[seed-demo] 거부: DATABASE_URL이 설정되어 있습니다. 이 스크립트는 JSON 파일 모드(자체호스팅/로컬) 전용이며, Postgres(운영) 연결이 잡힌 상태에서는 절대 실행되지 않습니다.");
    process.exit(1);
  }
  if (process.env.ALLOW_DEMO_SEED !== "true") {
    console.error('[seed-demo] 거부: ALLOW_DEMO_SEED=true 환경변수가 필요합니다.');
    process.exit(1);
  }
  if (args.confirm !== "CREATE_DEMO_FILE") {
    console.error('[seed-demo] 거부: --confirm=CREATE_DEMO_FILE 을 명시적으로 전달해야 합니다(실수 방지용 확인 플래그).');
    process.exit(1);
  }
  if (!args.output) {
    console.error("[seed-demo] 거부: --output=<파일경로> 가 필요합니다. 기존 데이터 파일(DATA_FILE)을 대상으로 지정하지 마세요 — 항상 새 파일에 씁니다.");
    process.exit(1);
  }
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 8) {
    console.error("[seed-demo] 거부: DEMO_ADMIN_PASSWORD 환경변수가 없거나 8자 미만입니다(생성될 demo_admin 계정의 로그인 비밀번호).");
    process.exit(1);
  }

  try {
    const outputPath = path.resolve(process.cwd(), args.output);

    // --force로 기존 일반 JSON 파일을 덮어쓸 수 있게 하면, 그 파일이 우연히도(또는
    // 실수로) 실제 DATA_FILE을 가리키는 경로일 때 운영/개발 데이터를 통째로 날릴 수
    // 있다 — 그래서 이 스크립트에는 덮어쓰기 옵션 자체가 없다. seed는 언제나 새
    // 파일만 만든다: DATA_FILE/hr-data.json과 같은 경로는 무조건 거부하고, 이미
    // 존재하는 파일도(그것이 예전에 이 스크립트가 만든 데모 파일이라 해도) 무조건
    // 거부한다 — 다시 만들고 싶으면 다른 경로를 쓰거나 사용자가 직접 지운다.
    const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    const protectedDataFiles = [
      path.resolve(__dirname, "..", "hr-data.json"),
      process.env.DATA_FILE && path.resolve(process.cwd(), process.env.DATA_FILE),
    ].filter(Boolean);
    if (protectedDataFiles.some(p => samePath(outputPath, p))) {
      throw new Error("Refusing to overwrite DATA_FILE/hr-data.json; choose a new demo output file.");
    }
    if (fs.existsSync(outputPath)) {
      throw new Error("Output already exists; choose a new output path (overwrite is disabled).");
    }

    const count = finiteInt(args.count, { name: "--count", min: 1, max: 50, fallback: 5 });
    const pastYears = finiteInt(args["past-years"], { name: "--past-years", min: 0, max: 10, fallback: 3 });
    const seed = args.seed != null ? Number(args.seed) : undefined;

    console.log(`[seed-demo] 생성 중... (count=${count}, pastYears=${pastYears}, seed=${seed ?? "(무작위)"})`);
    const dataset = await buildDemoDataset({ count, pastYears, seed, adminPassword });

    const fileContents = {
      employees: dataset.employees,
      kpiEntries: dataset.kpiEntries,
      _version: 0,
      _seedMeta: dataset.meta, // 디버깅/추적용 — 서버 정상 동작에 영향 없음(알려지지 않은 필드는 무시됨)
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(fileContents, null, 2), "utf8");

    console.log(`[seed-demo] 완료: ${outputPath}`);
    console.log(`[seed-demo]   직원 ${dataset.employees.length}명, KPI ${dataset.kpiEntries.length}건 (demoBatchId=${dataset.meta.demoBatchId})`);
    console.log(`[seed-demo]   로그인 계정: ${dataset.meta.adminLoginId} (비밀번호는 DEMO_ADMIN_PASSWORD 값)`);
    console.log(`[seed-demo] 이 파일로 서버를 띄우려면: DATA_FILE=${outputPath} NODE_ENV=development node server.js`);
    console.log("[seed-demo] 참고: 그 외 생성된 계정(팀장/팀원)의 비밀번호는 무작위로 발급되어 이 콘솔 출력이나 파일 어디에도 평문으로 남지 않습니다(bcrypt 해시만 저장) — 로그인 테스트가 필요하면 서버의 비밀번호 초기화 기능을 사용하세요.");
  } catch (e) {
    console.error("[seed-demo] 오류:", e.message);
    process.exit(1);
  }
}

main();
