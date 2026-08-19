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
//   NODE_ENV=development ALLOW_DEMO_SEED=true node scripts/seed-demo.js \
//     --confirm=CREATE_DEMO_FILE --output=./demo-data.json
//
// Options:
//   --confirm=CREATE_DEMO_FILE   (필수) 실수로 실행하는 것을 막는 명시적 확인 플래그
//   --output=<path>              (필수) 생성할 파일 경로. 기존 파일이 있으면 --force
//                                 없이는 실패한다(덮어쓰지 않음).
//   --force                      --output 경로에 이미 파일이 있어도 덮어쓴다.
//   --count=N                    부서별 팀당 생성할 팀원 수(기본 5)
//   --past-years=N                과거 KPI 등급을 몇 년치 포함할지(기본 3, 0=미포함)
//   --seed=N                     재현 가능한 데이터가 필요하면 정수 시드 지정(생략 시 매번 다름)
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── 실행 조건 4가지 — 하나라도 빠지면 즉시 종료(파일 생성 시도조차 하지 않음) ──
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

  const outputPath = path.resolve(process.cwd(), args.output);
  if (fs.existsSync(outputPath) && !args.flags.has("force")) {
    console.error(`[seed-demo] 거부: ${outputPath} 파일이 이미 존재합니다. 덮어쓰려면 --force를 추가하세요(기존 데이터 유실 위험을 인지했다는 명시적 의사표시).`);
    process.exit(1);
  }

  const count = args.count != null ? Number(args.count) : 5;
  const pastYears = args["past-years"] != null ? Number(args["past-years"]) : 3;
  const seed = args.seed != null ? Number(args.seed) : undefined;

  console.log(`[seed-demo] 생성 중... (count=${count}, pastYears=${pastYears}, seed=${seed ?? "(무작위)"})`);
  const dataset = await buildDemoDataset({ count, pastYears, seed });

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
  console.log(`[seed-demo] 이 파일로 서버를 띄우려면: DATA_FILE=${outputPath} NODE_ENV=development node server.js`);
  console.log("[seed-demo] 참고: 생성된 계정의 비밀번호는 무작위로 발급되어 이 콘솔 출력이나 파일 어디에도 평문으로 남지 않습니다(bcrypt 해시만 저장) — 로그인 테스트가 필요하면 서버의 비밀번호 초기화 기능을 사용하세요.");
}

main().catch(e => {
  console.error("[seed-demo] 오류:", e.message);
  process.exit(1);
});
