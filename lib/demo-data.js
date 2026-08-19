// 로컬 개발/데모용 표본 HR 데이터 생성기 (P1-3: 운영 더미 데이터 차단).
//
// 예전에는 public/index.html에 브라우저용 generateDummyData()/execGenerateDummy()가
// 있어, 관리자가 운영 화면의 버튼 하나로 가짜 직원·KPI를 지금 로드된 employees/
// kpiEntries 배열에 곧바로 push했다 — 그 자리에서 다음 자동저장을 타면 실제 회사
// 데이터에 그대로 섞여 들어가는 구조였다. 이 모듈은 그 두 함수를 대체하며 완전히
// 분리된 서버 전용 순수 함수로 다시 작성한 것 — 어떤 전역 상태(employees, genId(),
// currentUser 등)에도 의존하지 않고, 호출할 때마다 완결된 데이터셋 객체 하나를
// 새로 만들어 반환할 뿐 아무 파일도 건드리지 않는다(파일 쓰기는 scripts/seed-demo.js가
// 전담). 비밀번호는 반드시 bcrypt 해시로만 담고("Dummy@123" 같은 평문을 파일에
// 남기지 않음), 모든 레코드에 source:"demo"·demoBatchId·(직원은) empNo:"DEMO-..."
// 표식을 남겨 server.js의 rejectDemoDataForProduction()이 운영 저장 시점에
// 이 표식만 보고도 걸러낼 수 있게 한다.

const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const NAMES_M = ["이준호","박민준","김태양","최현우","정도현","강지훈","윤서진","임동하","한상우","조민재"];
const NAMES_F = ["이지아","박소연","김유리","최서현","정하린","강민지","윤채원","임서현","한지연","조은지"];
const SCHOOLS = ["서울대학교 (2015)","연세대학교 (2016)","고려대학교 (2017)","성균관대학교 (2018)","한양대학교 (2019)"];
const RANKS = ["사원","주임","과장","차장","부장"];
const ADDRS = ["서울시 강남구","서울시 마포구","경기도 성남시","인천시 연수구"];
const GRADES_KPI = ["S","A","B","B","B","C","D"];
const DEPTS = [
  { dept: "경영지원본부", teams: ["인사팀", "IT팀"], jobGroup: "관리직" },
  { dept: "사업본부", teams: ["개발1팀", "개발2팀"], jobGroup: "개발직" },
];
const PAST_KPI_ITEMS_BY_DEPT = {
  "인사팀": [{ w: 35, item: "인사 데이터 관리" }, { w: 35, item: "채용 지원" }, { w: 30, item: "교육 운영" }],
  "IT팀": [{ w: 35, item: "시스템 안정성 관리" }, { w: 35, item: "IT 지원 서비스" }, { w: 30, item: "보안 강화" }],
  "개발1팀": [{ w: 35, item: "개발 생산성" }, { w: 35, item: "코드 품질" }, { w: 30, item: "기술 역량 향상" }],
  "개발2팀": [{ w: 35, item: "제품 개발" }, { w: 35, item: "버그 감소" }, { w: 30, item: "협업 기여" }],
};

function _pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function _pad2(n) { return String(n).padStart(2, "0"); }

// 시드 가능한 간단한 PRNG(mulberry32) — Math.random() 대신 사용해, 같은 seed로
// 호출하면 항상 같은 데이터셋이 나오도록 한다(재현 가능한 테스트/CI에 유용).
// seed를 생략하면 매 호출마다 다른 무작위 데이터가 나온다(기존 브라우저 버튼과
// 동일한 동작).
function _makeRng(seed) {
  let s = seed == null ? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0 : seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// options: { count=5 (부서별 팀원 수), pastYears=3, seed, batchId, bcryptRounds=10 }
// 반환: { employees, kpiEntries, meta:{demoBatchId, generatedAt, options} }
// 비동기인 이유: bcrypt.hash가 Promise 기반이라 다수 계정을 순차 해싱한다(테스트
// 목적의 소량 데이터라 병렬화 없이도 충분히 빠름 — CLI 실행 1회성이라 성능보다
// 예측 가능한 순서를 우선).
async function buildDemoDataset(options = {}) {
  const count = Number(options.count) || 5;
  const pastYears = Number.isFinite(options.pastYears) ? options.pastYears : 3;
  const bcryptRounds = Number(options.bcryptRounds) || 10;
  const rng = _makeRng(options.seed);
  const demoBatchId = options.batchId || `demo_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const nowIso = new Date().toISOString();
  const currentYear = options.currentYear || new Date().getFullYear();

  const employees = [];
  const kpiEntries = [];
  let empSeq = 0;
  let kpiSeq = 0;
  const nextEmpId = () => `demo_emp_${++empSeq}`;
  const nextKpiId = () => `demo_kpi_${++kpiSeq}`;

  // 실제 employees.length 등 "그때그때의 상태"에 의존했던 브라우저 버전과 달리,
  // 여기서는 이 함수 호출 1회 안에서만 유일하면 되는 카운터로 사번을 결정한다 —
  // 매 호출이 새 파일을 만드는 것이 전제(server.js가 아니라 scripts/seed-demo.js가
  // 파일 쓰기를 전담)이므로 "재실행 시 중복 스킵" 로직 자체가 필요 없다.
  let empNoSeq = 0;
  // empNo를 명시하면(관리자 계정처럼 "DEMO-0000"으로 고정하고 싶은 경우) 그 값을
  // 그대로 쓰고 자동 채번 카운터는 건드리지 않는다 — 그러지 않으면 관리자를 맨 앞에
  // 추가할 때마다 이후 일반 직원들의 채번이 하나씩 밀려 재현성(seed 고정 시나리오)이
  // 깨진다.
  function buildEmployeeBase({ loginId, plainPw, name, role, dept, team, rank, position, gender, hire, totalCareer, salary, edu, eduSchool, jobGroup, empNo }) {
    let finalEmpNo = empNo;
    if (!finalEmpNo) {
      empNoSeq += 1;
      finalEmpNo = `DEMO-${String(empNoSeq).padStart(4, "0")}`;
    }
    return {
      loginId, plainPw, name,
      empNo: finalEmpNo,
      role, dept, team, rank, position: position || "",
      gender, hire, birth: `${1990 + Math.floor(rng() * 8)}-${_pad2(Math.floor(rng() * 12) + 1)}-${_pad2(Math.floor(rng() * 28) + 1)}`,
      totalCareer, salary, edu: edu || "대학교 졸업", eduSchool: eduSchool || _pick(SCHOOLS, rng),
      jobGroup: jobGroup || "관리직",
    };
  }

  // 관리자 계정 — 기존엔 leader/member만 있어 "실제로 로그인해 관리자 전용 기능을
  // 테스트"할 방법이 없었다(QA 회귀 테스트가 admin 성공/member 403을 함께 검증하려면
  // 둘 다 실제 로그인 가능한 계정이어야 함). 다른 계정은 비밀번호를 무작위로 생성해
  // 절대 출력하지 않는 것과 달리, 이 계정만은 호출자가 명시적으로 넘긴 비밀번호를
  // 그대로 쓴다(테스트/로컬 QA가 알고 있는 값으로 로그인해야 하므로) — 대신 그 값을
  // 여기서도, seed-demo.js에서도 절대 콘솔에 출력하지 않는다(로그인 ID만 출력).
  const adminLoginId = options.adminLoginId || "demo_admin";
  const adminPassword = options.adminPassword;
  if (!adminPassword || String(adminPassword).length < 8) {
    const e = new Error("admin 비밀번호가 없거나 8자 미만입니다(options.adminPassword / DEMO_ADMIN_PASSWORD).");
    e.code = "INVALID_ADMIN_PASSWORD";
    throw e;
  }
  const adminTpl = buildEmployeeBase({
    loginId: adminLoginId, plainPw: adminPassword, name: "데모 관리자", role: "admin",
    dept: "경영지원본부", team: "", rank: "부장", position: "관리자",
    gender: "남", hire: `${currentYear}-01-01`, totalCareer: 15, salary: 90000000,
    empNo: "DEMO-0000",
  });

  const extraLeaders = [
    buildEmployeeBase({ loginId: "demo_leader_it", plainPw: crypto.randomBytes(9).toString("base64url"), name: "이서연", role: "leader", dept: "경영지원본부", team: "IT팀", rank: "차장", position: "IT팀장", gender: "여", hire: "2017-04-01", totalCareer: 14, salary: 72000000, eduSchool: "이화여자대학교 (2010)" }),
    buildEmployeeBase({ loginId: "demo_leader_dev2", plainPw: crypto.randomBytes(9).toString("base64url"), name: "박준영", role: "leader", dept: "사업본부", team: "개발2팀", rank: "과장", position: "개발2팀장", gender: "남", hire: "2019-06-01", totalCareer: 10, salary: 68000000, jobGroup: "개발직", eduSchool: "포항공대 (2014)" }),
  ];

  const teamsOrgDB = {}; // { dept: Set(team) } — seed-demo.js가 orgDB.teams에 병합할 때 참고용

  async function finalizeEmployee(base, extraKpiEntries) {
    const pwHash = await bcrypt.hash(base.plainPw, bcryptRounds);
    const id = nextEmpId();
    employees.push({
      id, loginId: base.loginId, pw: pwHash, name: base.name, empNo: base.empNo,
      role: base.role, dept: base.dept, team: base.team,
      birth: base.birth, gender: base.gender, hire: base.hire,
      retireDate: "", retireReason: "",
      jobGroup: base.jobGroup, rank: base.rank, rankYear: Math.floor(rng() * 3) + 1,
      salary: base.salary, edu: base.edu, eduSchool: base.eduSchool, totalCareer: base.totalCareer,
      position: base.position, email: base.loginId + "@example-demo.invalid",
      phone: `010-${String(Math.floor(rng() * 9000) + 1000)}-${String(Math.floor(rng() * 9000) + 1000)}`,
      address: _pick(ADDRS, rng), customFields: {}, careers: [], hrHistory: [],
      gradeResults: {}, active: true, updatedAt: nowIso,
      source: "demo", demoBatchId,
    });
    if (base.dept && base.team) {
      (teamsOrgDB[base.dept] = teamsOrgDB[base.dept] || new Set()).add(base.team);
    }
    (extraKpiEntries || []).forEach(k => { k.userId = id; kpiEntries.push(k); });
    return id;
  }

  await finalizeEmployee(adminTpl, []);
  for (const tpl of extraLeaders) await finalizeEmployee(tpl, []);

  for (const { dept, teams, jobGroup } of DEPTS) {
    for (const team of teams) {
      for (let i = 0; i < count; i++) {
        const isFemale = i % 3 === 2;
        const nameSrc = isFemale ? NAMES_F : NAMES_M;
        const name = nameSrc[i % nameSrc.length];
        const rank = _pick(RANKS.slice(0, 3), rng);
        const career = Math.floor(rng() * 8) + 1;
        const salary = 35000000 + career * 3000000;
        const hireYear = currentYear - career;
        const hire = `${hireYear}-${_pad2(Math.floor(rng() * 12) + 1)}-01`;
        // dept/team이 한글이라 영숫자만 남기면(구 코드) 전부 빈 문자열이 돼 서로 다른
        // 팀의 같은 인덱스끼리 loginId가 충돌했다(실측: 모든 팀의 0번째 인원이 전부
        // "demo___0"이 됨) — empNoSeq+1(이 시점 다음에 배정될 사번 순번, 이 함수
        // 호출 안에서 항상 유일)을 그대로 써서 데이터셋 전체에서 유일성을 보장한다.
        const loginId = `demo_emp_${empNoSeq + 1}`;
        const plainPw = crypto.randomBytes(9).toString("base64url");
        const base = buildEmployeeBase({ loginId, plainPw, name, role: "member", dept, team, rank, gender: isFemale ? "여" : "남", hire, totalCareer: career, salary, jobGroup });

        const kpis = [];
        if (pastYears > 0) {
          for (let y = currentYear - pastYears; y <= currentYear - 1; y++) {
            const kpiItems = PAST_KPI_ITEMS_BY_DEPT[team] || [{ w: 40, item: "업무 성과" }, { w: 35, item: "협업 기여" }, { w: 25, item: "자기 개발" }];
            kpiItems.forEach(ki => {
              const ss = Math.floor(rng() * 20) + 70;
              const cs = Math.min(100, ss + Math.floor(rng() * 10) - 3);
              kpis.push({
                id: nextKpiId(), userId: null, year: y, item: ki.item, weight: ki.w,
                prev: "-", goal: ki.item + " 달성", yoy: "-", strategy: "-", evalCriteria: "목표 대비 달성율",
                actual: "완료", rate: Math.floor(rng() * 20 + 85) + "%", detail: "성실히 수행함",
                selfScore: ss, firstScore: Math.min(100, ss + Math.floor(rng() * 6) - 2), firstComment: "성실하게 업무를 수행하였습니다.",
                secondScore: cs, secondComment: "전반적으로 양호한 성과를 보였습니다.", secondCommentPublic: rng() > 0.5,
                goalSub: 1, firstStatus: "approved", firstReason: "", finalStatus: "approved", finalReason: "",
                finalConfirmed: true, finalScore: cs, updatedAt: nowIso,
                source: "demo", demoBatchId,
              });
            });
          }
        }
        await finalizeEmployee(base, kpis);
        const grades = {};
        if (pastYears > 0) {
          for (let y = currentYear - pastYears; y <= currentYear - 1; y++) grades[y] = { grade: _pick(GRADES_KPI, rng), score: null, manual: true, computedAt: nowIso };
          const justAdded = employees[employees.length - 1];
          justAdded.gradeResults = grades;
        }
      }
    }
  }

  return {
    employees, kpiEntries,
    meta: {
      demoBatchId, generatedAt: nowIso, options: { count, pastYears, seed: options.seed ?? null },
      teamsOrgDB: Object.fromEntries(Object.entries(teamsOrgDB).map(([d, s]) => [d, [...s]])),
      adminLoginId, // 비밀번호는 절대 포함하지 않는다 — 호출자(seed-demo.js)는 로그인 ID만 출력한다.
    },
  };
}

module.exports = { buildDemoDataset };
