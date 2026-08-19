// Playwright e2e(playwright.config.js의 webServer.command)가 직접 실행하는 진입점.
// server.js는 별도 startServer() export 없이 require 시점에 곧바로 app.listen()을
// 호출하는 구조라, 여기서는 필요한 환경변수를 먼저 세팅한 뒤 그 파일을 그대로
// require해서 같은 프로세스 안에서 띄운다(Playwright의 webServer가 이 스크립트
// 자체의 생명주기를 관리해준다 — 별도 child_process spawn 불필요).
//
// 관리자 계정은 서버가 뜬 "뒤"에 POST /save로 비동기 부트스트랩하는 대신, 서버를
// 띄우기 "전"에 DATA_FILE을 미리 (bcrypt로 해시한 비밀번호까지) 직접 써둔다 —
// Playwright의 webServer.url 준비확인은 GET /status가 200만 반환하면 곧바로
// "준비됨"으로 판단해 다음 단계(첫 e2e 테스트)로 넘어가므로, 서버 기동 "후"에
// 비동기로 관리자를 만드는 방식은 그 사이에 로그인 테스트가 먼저 도착하는
// 레이스 컨디션이 될 수 있다. 파일을 미리 채워두면 app.listen()이 성공적으로
// 응답하는 시점엔 이미 관리자 계정이 메모리에 로드돼 있어 이 레이스 자체가 없다.
// 임시 데이터 파일에만 쓰며, 운영 DATA_FILE/DATABASE_URL은 절대 건드리지 않는다.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const bcrypt = require("bcryptjs");

const port = process.env.E2E_PORT || "4300";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-e2e-"));
const dataFile = path.join(dataDir, "hr-data.json");

const E2E_ADMIN = { loginId: "e2e_admin", pw: "E2eTestPw123" };

function seedDataFileSync() {
  const pwHash = bcrypt.hashSync(E2E_ADMIN.pw, 10);
  const now = new Date().toISOString();
  const seed = {
    employees: [
      {
        id: 1, loginId: E2E_ADMIN.loginId, pw: pwHash, role: "admin", name: "E2E관리자", empNo: "E1",
        dept: "", team: "", birth: "", gender: "", hire: now.slice(0, 10), retireDate: "", retireReason: "",
        jobGroup: "", rank: "", rankYear: 0, salary: 0, edu: "", eduSchool: "", totalCareer: 0,
        active: true, position: "", email: "", phone: "", address: "", customFields: {},
        careers: [], hrHistory: [], gradeResults: {}, createdAt: now, updatedAt: now,
      },
    ],
    kpiEntries: [],
    _version: 1,
  };
  fs.writeFileSync(dataFile, JSON.stringify(seed, null, 2), "utf8");
}

seedDataFileSync();

process.env.PORT = port;
process.env.DATA_FILE = dataFile;
process.env.BUDGET_DATA_FILE = path.join(dataDir, "budget-data.json");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "e2e-session-secret-not-for-production";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
delete process.env.DATABASE_URL;

console.log(`[start-e2e-server] DATA_FILE=${dataFile} (관리자 ${E2E_ADMIN.loginId}/${E2E_ADMIN.pw} 사전 시딩됨)`);
require(path.join(__dirname, "..", "..", "server.js"));
