const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const rateLimit = require("express-rate-limit");
const fs      = require("fs");
const path    = require("path");
const os      = require("os");
const bcrypt  = require("bcryptjs");
const crypto  = require("crypto");
const pool    = require("./db");
const multer  = require("multer");
const budgetRouterFactory = require("./budget");

// Express 4는 async 라우트 핸들러 내부의 동기 throw/reject를 자동으로 잡아주지 않는다
// (Express 5와 다른 점) — try/catch 없이 작성된 async 핸들러 하나가 예외를 던지면
// unhandled promise rejection이 되고, Node 15+ 기본 동작상 프로세스 전체가 종료된다.
// 2026-08-03 실제 운영 장애: budget.js의 사업계획 저장 라우트가 디스크 미마운트로 인한
// 파일쓰기 ENOENT를 그대로 던져 인스턴스 전체가 크래시(Exited with status 1)됐음 — 라우트
// 하나의 개별 오류가 전 직원의 HR/ERP 서비스 전체를 다운시키는 사고로 이어진 것. 근본
// 원인(해당 파일쓰기 경로)은 별도로 수정했지만, 앞으로 유사한 미처리 예외가 어디서든
// 발생해도 서버 프로세스 자체는 계속 살아있도록 안전망을 추가한다(로그만 남기고 종료하지
// 않음 — 해당 요청은 클라이언트에 응답 없이 타임아웃되거나 500으로 끝날 수 있으나, 다른
// 모든 사용자의 세션·요청에는 영향이 없다).
process.on("unhandledRejection", (reason) => {
  console.error("⚠️  [unhandledRejection] 처리되지 않은 프로미스 거부(요청 하나가 실패했을 뿐 서버는 계속 실행됩니다):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️  [uncaughtException] 처리되지 않은 예외(요청 하나가 실패했을 뿐 서버는 계속 실행됩니다):", err);
});

const app  = express();
const PORT = process.env.PORT || 3000;
// Render 등 PaaS는 리버스 프록시를 거쳐 요청을 전달하며 X-Forwarded-For 헤더를 붙인다.
// trust proxy를 켜지 않으면 express-rate-limit이 실제 클라이언트 IP를 신뢰할 수 없다고
// 판단해 요청 처리 중 에러를 던지고(ERR_ERL_UNEXPECTED_X_FORWARDED_FOR), 그 여파로
// /login 요청 자체가 정상 완료되지 못해 로그인해도 토큰이 발급되지 않는 문제가 있었다.
// 1을 지정해 "맨 앞 프록시 1홉만 신뢰"하도록 설정(플랫폼이 직접 종단하는 표준 구성).
app.set("trust proxy", 1);

// ── 세션 토큰 (HMAC 서명, stateless) ────────────────────────────────────────────
// /login 성공 시 발급되어 이후 모든 요청의 Authorization: Bearer <token> 헤더로 전달됨.
// req.body.role을 그대로 신뢰하던 과거 방식(클라이언트가 role만 바꿔 보내면 관리자 권한
// 우회 가능)을 대체하기 위해 도입 — role은 이제 서버가 로그인 시 검증한 값만 담긴 토큰에서
// 읽는다. SESSION_SECRET 미설정 시 배포 로그에 경고를 남기고 프로세스 시작마다 임의 시크릿을
// 생성한다(재시작 시 기존 토큰은 모두 무효화되어 재로그인이 필요해짐 — 운영 배포에서는
// SESSION_SECRET 환경변수를 반드시 고정값으로 설정할 것).
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.warn("⚠️  SESSION_SECRET 환경변수가 설정되지 않았습니다 — 임시 시크릿으로 동작하며, 서버 재시작 시 모든 로그인 세션이 무효화됩니다. 운영 배포에서는 반드시 고정값을 설정하세요.");
}
const SESSION_TTL_SEC = 12 * 60 * 60; // 12시간

// ttlSec: optional override for the default 12h session TTL. Used by master-admin
// impersonation tokens (POST /master/companies/:id/impersonate), which are meant to be
// short-lived (1h) since they grant full access to a company's data.
function signToken(payload, ttlSec = SESSION_TTL_SEC) {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + ttlSec * 1000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
// 모든 요청에서 Authorization 헤더를 검증해 req.auth에 실어둔다(없거나 무효면 null).
// 라우트 자체를 막지는 않고 값만 채워두며, 실제 인가는 requireAuth/requireAdmin/requireRole이 담당한다.
//
// P0-5 방어(2026-08-19 외부 감사, _nextAuthVersion 주석 참고): 서명 검증(verifyToken)만으로는
// "발급 당시엔 유효했다"만 증명할 뿐, 그 사이 서버에서 그 계정이 퇴직 처리(active:false)·
// 강등(role 하향)·비밀번호 강제 초기화됐는지는 전혀 반영하지 못한다 — 토큰이 자연 만료
// (기본 12시간)될 때까지 계속 유효했다. empId가 있는 토큰(마스터·impersonation 토큰은
// empId가 null이라 대상이 아님)에 한해 지금 저장된 employees 레코드의 authVersion·active와
// 대조해, 하나라도 안 맞으면 그 토큰을 무효(req.auth = null, 미인증과 동일하게 취급)로
// 처리한다 — 재로그인해야 새 버전의 토큰을 받는다.
// authenticate()와 _employeeAuthStillValid() 양쪽이 같은 employees 레코드 조회를
// 중복으로 하지 않도록 분리한 헬퍼. 조회 자체가 실패하면(DB 장애 등) undefined를 반환해
// "레코드가 확인상 없음(null)"과 "확인 자체를 못함(undefined)"을 구분한다 — 후자는
// 아래에서 기존과 동일하게 가용성 우선(fail-open)으로 처리된다.
async function _fetchCurrentEmployeeForAuth(auth) {
  if (auth.empId == null) return null; // 마스터/impersonation 토큰 — employees 대상 아님
  try {
    if (USE_JSON_FILE) {
      return (_fileStore.employees || []).find(e => String(e.id) === String(auth.empId)) || null;
    }
    const { rows } = await pool.query("SELECT data FROM employees WHERE id = $1 AND is_deleted = FALSE", [auth.empId]);
    return (rows[0] && rows[0].data) || null;
  } catch {
    return undefined;
  }
}
async function _employeeAuthStillValid(auth, prefetchedEmployee) {
  // 이 검사 자체가 어떤 이유로든 실패하면(예상치 못한 예외 포함) 가용성을 우선해 통과시킨다
  // — authenticate()가 async 미들웨어라 여기서 예외가 새면 Express 4가 자동으로 못 잡아
  // unhandled rejection이 되고, 그 요청은 응답도 타임아웃도 없이 멈춰버린다(P0-4 수정
  // 중 실측으로 확인한 것과 동일한 클래스의 사고 — 이 검사는 반드시 실패해도 요청을
  // 멈추지 않아야 한다).
  try {
    if (auth.empId == null) return true;
    const current = prefetchedEmployee !== undefined ? prefetchedEmployee : await _fetchCurrentEmployeeForAuth(auth);
    if (current === undefined) return true; // 조회 자체가 실패 — fail-open
    if (!current) return false; // 레코드 자체가 삭제됨
    if (current.active === false) return false;
    return (Number(current.authVersion) || 0) === (Number(auth.authVersion) || 0);
  } catch {
    return true;
  }
}
async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const auth = verifyToken(token);
  if (!auth) { req.auth = null; return next(); }
  // 세션 철회 검사(_employeeAuthStillValid)와 menuPerms 조회가 같은 employees 레코드를
  // 쓰므로 한 번만 가져와 공유한다(요청당 추가 조회 없음). menuPerms는 "권한 관리" 화면에서
  // 개인별로 끈 메뉴 목록 — requirePage()가 REST API 라우트에서 이 값을 그대로 검사한다.
  const employee = await _fetchCurrentEmployeeForAuth(auth);
  req.auth = (await _employeeAuthStillValid(auth, employee)) ? { ...auth, menuPerms: (employee && employee.menuPerms) || {} } : null;
  next();
}
function requireAuth(req, res) {
  if (!req.auth) {
    res.status(401).json({ ok: false, message: "로그인이 필요합니다." });
    return false;
  }
  return true;
}
// 원문 에러메시지 노출 방어(2026-08-19 외부 감사 P1). 이 파일 전반의 `catch (e) {
// res.status(...).json({ ok:false, message: e.message }) }` 관례는 두 가지를 구분하지
// 않았다 — httpError()로 의도적으로 만든, 이미 사용자용으로 다듬어진 에러(예: "비밀번호가
// 8자 이상이어야 합니다")와, DB 드라이버·파일시스템 등에서 올라온 예기치 못한 내부
// 예외(SQL 문법·파일 경로 등 운영 세부정보가 그대로 섞여 나올 수 있음)를 똑같이
// e.message 그대로 클라이언트에 보냈다. httpError()가 던지는 에러는 항상 status(및
// 대부분 code)를 함께 싣는 반면, 예기치 못한 예외는 보통 이 필드가 없다는 점을 이용해
// 구분한다 — status/statusCode가 있으면(의도적으로 다듬어진 메시지) 그대로 통과시키고,
// 없으면 운영(NODE_ENV=production)에서만 일반 문구로 대체한다(개발/로컬은 디버깅 편의를
// 위해 항상 원문 그대로).
function _safeErrMsg(e) {
  if (e && (e.status || e.statusCode)) return e.message;
  if (process.env.NODE_ENV === "production") return "서버 오류가 발생했습니다.";
  return e && e.message;
}

// ── Storage mode ──────────────────────────────────────────────────────────────
// When DATABASE_URL is not set, persist everything to a local JSON file.
const USE_JSON_FILE = !process.env.DATABASE_URL;
const JSON_FILE     = process.env.DATA_FILE || path.join(__dirname, "hr-data.json");

// 메인 데이터(_persistDataLocked)는 이미 tmp파일+rename으로 원자적 쓰기를 하고 있었지만,
// 스냅샷/변경이력/회계/RCPS/고정자산/ERP/PMS/채용 등 나머지 위성 JSON 파일들(JSON 파일
// 모드 전용 — 자체호스팅/오프라인 배포에서만 쓰이고 운영 Render 배포는 Postgres를 씀)은
// fs.writeFileSync로 대상 파일을 직접 덮어쓰고 있어, 쓰는 도중 프로세스가 강제종료(SIGKILL,
// OOM kill 등)되면 파일이 잘리거나 손상된 채로 남을 위험이 있었다(실측: kill -9로 재현하면
// 잘린 파일이 남고, 다음 부팅 시 JSON.parse가 던지는 예외를 로딩 코드가 try/catch로 삼켜
// "파일을 읽을 수 없음" 경고와 함께 그 모듈 데이터가 통째로 빈 상태로 되돌아감 — 그 시점까지
// 누적된 데이터가 조용히 유실됨). 나머지 위성 파일 쓰기도 전부 이 헬퍼(tmp에 먼저 쓰고
// rename)로 통일해 같은 보호를 적용한다 — POSIX에서 같은 파일시스템 내 rename은 원자적이라
// 쓰다 만 tmp 파일이 있어도 원본은 마지막으로 완전히 쓰기 끝난 버전 그대로 남는다.
function _atomicWriteFileSync(filePath, content) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

// In-memory store for JSON file mode (mirrors the full client state)
let _fileStore = { employees: [], kpiEntries: [] };
// 회계 모듈 전용 저장소 (계정과목/전표/세금계산서) — 클라이언트 신뢰형 블롭과 분리해
// 서버가 직접 번호 발급·차대변 검증·확정 후 불변성을 보장하는 트랜잭션 기반으로 관리한다.
let _fileAccounting = { accounts: [], vouchers: [], taxInvoices: [], partners: [], payments: [], voucherSeq: {}, taxInvoiceSeq: {} };
// 영업/재고 모듈 전용 저장소 (품목·위치·견적서·발주서·재고 입출고 이력) — 회계 모듈과 동일하게
// 클라이언트 신뢰형 블롭과 분리해 서버가 번호 발급·상태 전환·재고 반영을 직접 관리한다.
let _fileErp = { items: [], locations: [], quotations: [], purchaseOrders: [], purchaseRequests: [], stockLedger: [], quoteSeq: {}, poSeq: {}, salesTargets: [] };
let _fileAcctRcps = { issuances: [], schedule: [], valuations: [] };
// 고정자산 모듈 전용 저장소 (취득·감가상각 스케줄) — RCPS와 동일한 클라이언트-비신뢰 패턴.
let _fileAcctFixedAssets = { assets: [], schedule: [] };
let _filePms = { projects: [], allocations: [], worklogs: [] };
let _fileRecruit = { jobs: [], candidates: [], interviews: [] };
// 활동 로그(관리자 전용 "활동 로그" 화면) — 2026-08-18 DB 영속성 감사에서 발견: 이전에는
// _activityLog가 process 메모리에만 있고 이 위성 파일들처럼 디스크에 저장되지 않아, 재시작
// (재배포)마다 활동 이력이 전부 사라졌다. 다른 위성 저장소와 동일한 패턴(부팅 시 로드,
// 변경 시 _atomicWriteFileSync로 원자적 저장)으로 영속화한다.
let _fileActivityLog = [];

// 기초데이터: 표준 중소기업 계정과목 (최초 가동 시 비어있으면 자동 시딩)
const DEFAULT_ACCOUNTS = [
  { code: "101", name: "현금", type: "asset", category: "유동자산" },
  { code: "102", name: "보통예금", type: "asset", category: "유동자산" },
  { code: "108", name: "외상매출금", type: "asset", category: "유동자산" },
  { code: "110", name: "받을어음", type: "asset", category: "유동자산" },
  { code: "120", name: "미수금", type: "asset", category: "유동자산" },
  { code: "131", name: "선급금", type: "asset", category: "유동자산" },
  { code: "133", name: "선급비용", type: "asset", category: "유동자산" },
  { code: "146", name: "상품", type: "asset", category: "유동자산" },
  { code: "150", name: "제품", type: "asset", category: "유동자산" },
  { code: "153", name: "원재료", type: "asset", category: "유동자산" },
  { code: "201", name: "토지", type: "asset", category: "비유동자산" },
  { code: "202", name: "건물", type: "asset", category: "비유동자산" },
  { code: "208", name: "차량운반구", type: "asset", category: "비유동자산" },
  { code: "212", name: "비품", type: "asset", category: "비유동자산" },
  { code: "219", name: "감가상각누계액", type: "asset", category: "비유동자산" },
  { code: "230", name: "임차보증금", type: "asset", category: "비유동자산" },
  { code: "240", name: "소프트웨어", type: "asset", category: "비유동자산" },
  { code: "251", name: "외상매입금", type: "liability", category: "유동부채" },
  { code: "252", name: "지급어음", type: "liability", category: "유동부채" },
  { code: "253", name: "미지급금", type: "liability", category: "유동부채" },
  { code: "254", name: "예수금", type: "liability", category: "유동부채" },
  { code: "255", name: "부가세예수금", type: "liability", category: "유동부채" },
  { code: "257", name: "선수금", type: "liability", category: "유동부채" },
  { code: "260", name: "단기차입금", type: "liability", category: "유동부채" },
  { code: "262", name: "미지급세금", type: "liability", category: "유동부채" },
  { code: "264", name: "미지급비용", type: "liability", category: "유동부채" },
  { code: "293", name: "장기차입금", type: "liability", category: "비유동부채" },
  { code: "295", name: "퇴직급여충당부채", type: "liability", category: "비유동부채" },
  { code: "331", name: "자본금", type: "equity", category: "자본" },
  { code: "351", name: "이익준비금", type: "equity", category: "자본" },
  { code: "375", name: "미처분이익잉여금", type: "equity", category: "자본" },
  { code: "401", name: "상품매출", type: "revenue", category: "매출" },
  { code: "404", name: "제품매출", type: "revenue", category: "매출" },
  { code: "411", name: "용역매출", type: "revenue", category: "매출" },
  { code: "901", name: "이자수익", type: "revenue", category: "영업외수익" },
  { code: "904", name: "잡이익", type: "revenue", category: "영업외수익" },
  { code: "501", name: "원재료비", type: "expense", category: "매출원가" },
  { code: "504", name: "노무비", type: "expense", category: "매출원가" },
  { code: "511", name: "복리후생비", type: "expense", category: "판매비와관리비" },
  { code: "512", name: "여비교통비", type: "expense", category: "판매비와관리비" },
  { code: "513", name: "접대비", type: "expense", category: "판매비와관리비" },
  { code: "514", name: "통신비", type: "expense", category: "판매비와관리비" },
  { code: "515", name: "수도광열비", type: "expense", category: "판매비와관리비" },
  { code: "516", name: "전력비", type: "expense", category: "판매비와관리비" },
  { code: "517", name: "세금과공과", type: "expense", category: "판매비와관리비" },
  { code: "518", name: "감가상각비", type: "expense", category: "판매비와관리비" },
  { code: "519", name: "임차료", type: "expense", category: "판매비와관리비" },
  { code: "520", name: "수선비", type: "expense", category: "판매비와관리비" },
  { code: "521", name: "보험료", type: "expense", category: "판매비와관리비" },
  { code: "522", name: "차량유지비", type: "expense", category: "판매비와관리비" },
  { code: "524", name: "운반비", type: "expense", category: "판매비와관리비" },
  { code: "525", name: "교육훈련비", type: "expense", category: "판매비와관리비" },
  { code: "526", name: "도서인쇄비", type: "expense", category: "판매비와관리비" },
  { code: "527", name: "회의비", type: "expense", category: "판매비와관리비" },
  { code: "529", name: "포장비", type: "expense", category: "판매비와관리비" },
  { code: "530", name: "사무용품비", type: "expense", category: "판매비와관리비" },
  { code: "531", name: "소모품비", type: "expense", category: "판매비와관리비" },
  { code: "533", name: "광고선전비", type: "expense", category: "판매비와관리비" },
  { code: "534", name: "지급수수료", type: "expense", category: "판매비와관리비" },
  { code: "536", name: "잡비", type: "expense", category: "판매비와관리비" },
  { code: "801", name: "급여", type: "expense", category: "판매비와관리비" },
  { code: "803", name: "상여금", type: "expense", category: "판매비와관리비" },
  { code: "805", name: "퇴직급여", type: "expense", category: "판매비와관리비" },
  { code: "951", name: "이자비용", type: "expense", category: "영업외비용" },
  { code: "956", name: "잡손실", type: "expense", category: "영업외비용" },
];

const DEFAULT_LOCATIONS = [
  { name: "본사창고", address: "" },
];
// In-memory annual snapshots for JSON file mode
let _fileSnapshots = {}; // { year: { data, empCount, kpiCount, label, createdAt } }
// In-memory change history for JSON file mode (mirrors employee_history/kpi_history)
let _fileHistory = { employees: [], kpi: [] }; // { employees: [{id,action,changedBy,changedAt,data}], kpi: [...] }
const MAX_FILE_HISTORY = 5000; // per list, oldest trimmed first

const MAX_ACTIVITY_LOGS = 1000;

// ── Password security helpers ────────────────────────────────────────────────
// Passwords are hashed at rest. The client never receives `pw` (stripped from
// every response below), so employees it didn't touch arrive back with no
// `pw` field — the existing hash must be preserved rather than overwritten.
function isHashedPw(pw) {
  return typeof pw === "string" && /^\$2[aby]\$/.test(pw);
}
async function hashPlaintextPw(pw) {
  return isHashedPw(pw) ? pw : await bcrypt.hash(pw, 10);
}
// authVersion(2026-08-19 외부 감사 P0-5 — 아래 _nextAuthVersion/authenticate 참고)은 GET
// /data 응답(클라이언트가 로컬에 보관·재전송하는 전체 상태)에서는 제외한다 — 서버가 매
// 저장마다 이 값을 클라이언트 입력과 무관하게 스스로 재계산하므로 노출할 필요가 없다.
// omitPw()는 노출하지 않는 대상에서 뺀다 — verifyCredentials()가 이 함수의 반환값에서
// authVersion을 읽어 로그인 토큰에 실어야 하기 때문(아래 /login 참고, 토큰 발급 직후에는
// 그 값을 다시 벗겨 클라이언트 응답의 employee 필드로 보낸다).
function stripPwField(data) {
  if (!data || !Array.isArray(data.employees)) return data;
  return { ...data, employees: data.employees.map(({ pw, twoFactorSecret, authVersion, ...rest }) => rest) };
}

// `/save`는 전체 상태를 받는 레거시 호환 API다. 일반 사용자가 이 객체의 employees나
// singleton 설정을 통째로 바꿔 role/password/전사 정책을 위조하지 못하도록, 해당 영역은
// 항상 저장본을 기준으로 재구성한다. 본인 프로필에서 실제로 수정하도록 제공한 필드만
// 좁게 허용한다. 새 직원 생성과 권한/급여/입사정보 변경은 관리자 전용 흐름을 사용한다.
const SELF_EDITABLE_EMPLOYEE_FIELDS = new Set([
  "email", "phone", "address", "edu", "eduSchool", "totalCareer", "careers",
]);
function _boundedText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : null;
}
function _sanitizeOwnCareers(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 30).map(row => ({
    co: _boundedText(row?.co, 120) || "",
    start: _boundedText(row?.start, 16) || "",
    end: _boundedText(row?.end, 16) || "",
    pos: _boundedText(row?.pos, 120) || "",
    desc: _boundedText(row?.desc, 1000) || "",
  }));
}
function _mergeOwnProfile(stored, incoming) {
  const out = { ...stored };
  for (const key of SELF_EDITABLE_EMPLOYEE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
    if (key === "totalCareer") {
      const n = Number(incoming[key]);
      if (Number.isFinite(n) && n >= 0 && n <= 80) out[key] = Math.round(n * 10) / 10;
    } else if (key === "careers") {
      const careers = _sanitizeOwnCareers(incoming[key]);
      if (careers) out[key] = careers;
    } else {
      const text = _boundedText(incoming[key], key === "address" ? 300 : 160);
      if (text !== null) out[key] = text;
    }
  }
  out.updatedAt = new Date().toISOString();
  return out;
}
function _isPrivilegedStateWriter(actor) {
  return !!actor && (actor.role === "admin" || actor.role === "master" || actor.actingAsMaster);
}
function preserveServerOwnedStateForNonAdmin(incoming, stored, actor) {
  if (_isPrivilegedStateWriter(actor)) return incoming;
  const out = { ...incoming };
  const incomingEmployees = new Map((Array.isArray(incoming?.employees) ? incoming.employees : [])
    .filter(e => e && e.id != null)
    .map(e => [String(e.id), e]));
  out.employees = (stored?.employees || []).map(emp => {
    const candidate = incomingEmployees.get(String(emp.id));
    return candidate && String(emp.id) === String(actor?.empId)
      ? _mergeOwnProfile(emp, candidate)
      : emp;
  });
  // Settings, role policy and tombstones are global server-owned state. Letting a
  // non-admin send a redacted/stale copy would also delete fields it cannot read.
  for (const key of SINGLETON_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(stored || {}, key)) out[key] = stored[key];
    else delete out[key];
  }
  return out;
}
function employeeDirectoryView(employee) {
  if (!employee || typeof employee !== "object") return employee;
  const { id, name, empNo, role, dept, team, rank, position, active, hire } = employee;
  return { id, name, empNo, role, dept, team, rank, position, active, hire };
}
// Single employee record (e.g. an employee_history row's `data` column) — strip its own pw
// and 2FA secret fields, neither of which the client should ever receive back.
function omitPw(emp) {
  if (!emp || typeof emp !== "object") return emp;
  const { pw, twoFactorSecret, ...rest } = emp;
  return rest;
}

// The client-trusted "full state blob" model (see docs/API_CONTRACT.md §1.2) means every
// authenticated user's GET /data — and the equivalent data returned by POST /save's merge
// response and snapshot restore — otherwise returns every OTHER employee's sensitive
// records verbatim, regardless of role. stripPwField() already keeps password hashes out
// of the wire; this does the same for the fields below, using the PAGE_ROLES/client-side
// visibility rules already enforced in public/index.html as the source of truth for who
// legitimately needs broad access:
//   - payslips: only "payroll-mgmt" (admin-only) manages other people's payslips, so
//     every other role sees just their own.
//   - kpiEntries: "first-eval"/"second-eval"/"grade-view"/"eval-progress" all exclude
//     "member" (leader/director/admin need broad access to run evaluations; member does
//     not), so member is narrowed to their own entries while other roles are untouched.
//   - lowPerfData(저성과자 관리): 대상자 본인에게도 비공개인 자료(기록 자체에 "본인에게
//     비공개" 문구가 들어있음, client의 _canViewLowPerformer()는 admin이거나
//     settings.lowPerformerViewers에 등록된 직원만 true) — 그 외 전원은 전체를 빈 배열로.
//   - coreTalentPool(핵심인재 풀): "core-talent" 관리 화면은 admin 전용, 비밀리에 검토되는
//     승진 후보 정보라 admin이 아니면 본인 항목만 남긴다(talent-dev 페이지가 "내가
//     선정되었는지"만 확인하면 되므로 본인 레코드는 유지해도 안전).
//   - compResponses(다면평가 응답): 평가 대상자가 evaluatorId+자유텍스트(strengths/
//     improvements/answers)를 보고 "누가 이 코멘트를 썼는지" 알 수 있어 평가 익명성이
//     깨졌다(실측 확인) — admin 또는 본인이 제출한(evaluatorId===본인) 레코드는 원본 그대로,
//     그 외(본인이 평가 대상인 레코드 포함)는 제출 여부 확인용 필드(id/sessionId/
//     evaluatorId/submittedAt)만 남기고 코멘트·점수 내용은 제거한다.
//   - welfarePoints(복지포인트 사용내역): desc 필드에 사용목적(의료비 등)이 그대로 들어가
//     동료가 볼 수 있었다 — admin이거나 settings.welfarePointsViewers에 등록된 직원이
//     아니면 본인 것만 남긴다(_canViewWelfareAll()과 동일 기준).
//   - payrollAdjustments(급여 조정/인센티브/경조사비 금액): payslips와 동급 민감도 —
//     admin 아니면 본인 것만.
//   - gradeAdjustHistory(평가등급 조정 이력, 사유 포함): "comp-grade-view" 화면이 admin
//     전용이라 admin 아니면 본인 것만.
//   - certRequests(증명서 발급 신청, 사유에 "대출용" 등 개인 재무상황이 드러남): 승인/반려가
//     client의 approveCertRequest()에서 admin 전용으로 하드코딩돼 있어 admin 아니면 본인 것만.
//   - changeRequests(KPI 수정요청): kpiEntries와 동일한 코멘트를 담고 있어 kpiEntries와 동일한
//     기준(member만 본인 것으로 제한, leader/director/admin은 평가 운영을 위해 그대로 유지).
//   - attendanceRecords(근태): "hr-attendance" 화면이 admin/director 전용(leader 제외)이라
//     admin·director 아니면(leader 포함) 본인 것만.
//   - scheduleEvents(개인 일정): scope==="personal"인 항목만 작성자 본인에게만 남기고, team/
//     dept/company scope는 원래 공개가 의도이므로 그대로 둔다.
//   - compGradeResults(다면평가 최종등급/점수, {empId:{year:{...}}} 형태의 nested 싱글톤):
//     admin 아니면 본인 키만 남긴다.
//   - approvalDocs(전자결재): 결재선(상신자/결재자/참조자/수신자) 밖의 사람에게는 원래도
//     노출되면 안 되는 설계인데(병가 사유 등 인사 문서가 섞여 있음) 서버가 전량 반환했다 —
//     client의 결재함 화면들이 실제로 쓰는 가시성 규칙(authorId/approvers[].empId/
//     _refsToVisibleEmpIds(receivers)/_refsToVisibleEmpIds(cc))을 그대로 서버에 재현한다.
// No-op when `auth` is absent (e.g. bootstrap-exempt paths never reach here with real data).
// asOf: 문서 기준일(상신일). 부서/팀 그룹 참조는 조회 시점 소속으로 매번 다시 계산되므로,
// 그대로 두면 오늘 입사한 사람이 입사 전 그 부서 앞 문서까지 전부 열람할 수 있다.
// 클라이언트(_refToEmpIds)와 동일한 기준으로 문서 기준일 이후 입사자를 제외한다.
function _refToEmpIdsServer(ref, employees, asOf) {
  if (typeof ref === "number") return [ref];
  if (typeof ref !== "string") return [];
  if (/^\d+$/.test(ref)) return [Number(ref)];
  if (ref.startsWith("emp:")) return [Number(ref.slice(4))];
  const joinedBy = e => !asOf || !e.hire || String(e.hire).slice(0, 10) <= String(asOf).slice(0, 10);
  if (ref.startsWith("dept:")) { const d = ref.slice(5); return employees.filter(e => e.active && e.dept === d && joinedBy(e)).map(e => e.id); }
  if (ref.startsWith("team:")) { const [d, t] = ref.slice(5).split("::"); return employees.filter(e => e.active && e.dept === d && e.team === t && joinedBy(e)).map(e => e.id); }
  return [];
}
function _refsToVisibleEmpIdsServer(refs, employees, asOf) {
  const direct = [], group = [];
  (refs || []).forEach(ref => {
    const isGroup = typeof ref === "string" && (ref.startsWith("dept:") || ref.startsWith("team:"));
    (isGroup ? group : direct).push(..._refToEmpIdsServer(ref, employees, isGroup ? asOf : undefined));
  });
  const directSet = new Set(direct);
  const visibleGroup = group.filter(id => {
    if (directSet.has(id)) return true;
    const e = employees.find(e => e.id === id);
    return !(e && e.hideGroupApproval);
  });
  return [...new Set([...direct, ...visibleGroup])];
}
function filterDataForRole(data, auth) {
  if (!data || !auth) return data;
  const out = { ...data };
  const settings = out.settings || {};
  const myId = String(auth.empId);
  if (auth.role !== "admin" && Array.isArray(out.payslips)) {
    out.payslips = out.payslips.filter(p => p && String(p.empId) === myId);
  }
  if (auth.role === "member" && Array.isArray(out.kpiEntries)) {
    out.kpiEntries = out.kpiEntries.filter(k => k && String(k.userId) === myId);
  }
  const canViewLowPerf = auth.role === "admin" ||
    (settings.lowPerformerViewers || []).map(String).includes(myId);
  if (!canViewLowPerf && Array.isArray(out.lowPerfData)) {
    out.lowPerfData = [];
  }
  if (auth.role !== "admin" && Array.isArray(out.coreTalentPool)) {
    // 이 필터가 "본인 레코드만"으로 도입된 뒤(2026-07-20), 클라이언트의
    // _canViewTalentDev()가 원래 의도한 "director는 자기 사업부에 선정자가 있으면
    // talent-dev 페이지 접근 가능" 로직이 조용히 무력화돼 있었다 — director가 받는
    // coreTalentPool이 항상 본인 레코드만(대개 0건)이라 selectedDepts가 절대 채워지지
    // 않았기 때문. director는 자기 부서 소속 선정자까지, talentDevViewers 지정
    // 담당자는(쓰기 게이팅과 동일하게) 전체를 볼 수 있게 복원한다.
    const employees = Array.isArray(out.employees) ? out.employees : [];
    const isTalentDevViewer = (settings.talentDevViewers || []).map(String).includes(myId);
    if (!isTalentDevViewer) {
      const myDept = auth.role === "director" ? employees.find(e => String(e.id) === myId)?.dept : null;
      out.coreTalentPool = out.coreTalentPool.filter(p => {
        if (!p) return false;
        if (String(p.empId) === myId) return true;
        if (!myDept) return false;
        const e = employees.find(e => e.id === p.empId);
        return !!(e && e.dept === myDept);
      });
    }
  }
  if (auth.role !== "admin" && Array.isArray(out.compResponses)) {
    out.compResponses = out.compResponses.map(r => {
      if (!r) return r;
      if (String(r.evaluatorId) === myId) return r;
      const { answers, collab, strengths, improvements, ...safe } = r;
      return safe;
    });
  }
  const canViewWelfareAll = auth.role === "admin" ||
    (settings.welfarePointsViewers || []).map(String).includes(myId);
  if (!canViewWelfareAll && Array.isArray(out.welfarePoints)) {
    out.welfarePoints = out.welfarePoints.filter(w => w && String(w.empId) === myId);
  }
  if (auth.role !== "admin" && Array.isArray(out.payrollAdjustments)) {
    out.payrollAdjustments = out.payrollAdjustments.filter(a => a && String(a.empId) === myId);
  }
  if (auth.role !== "admin" && Array.isArray(out.gradeAdjustHistory)) {
    out.gradeAdjustHistory = out.gradeAdjustHistory.filter(a => a && String(a.empId) === myId);
  }
  if (auth.role !== "admin" && Array.isArray(out.certRequests)) {
    out.certRequests = out.certRequests.filter(c => c && String(c.empId) === myId);
  }
  if (auth.role === "member" && Array.isArray(out.changeRequests)) {
    out.changeRequests = out.changeRequests.filter(c => c && String(c.reqUserId) === myId);
  }
  if (auth.role !== "admin" && auth.role !== "director" && Array.isArray(out.attendanceRecords)) {
    out.attendanceRecords = out.attendanceRecords.filter(r => r && String(r.empId) === myId);
  }
  if (auth.role !== "admin" && Array.isArray(out.scheduleEvents)) {
    out.scheduleEvents = out.scheduleEvents.filter(s => !s || s.scope !== "personal" || String(s.authorId) === myId);
  }
  // 아래 필드들은 화면(클라이언트) 단에서는 이미 "본인 것만"/"관리자·director(dept)·leader(dept+team)만"
  // 으로 좁혀서 보여주고 있었지만(개별 화면 코드로 확인), GET /data 자체에는 이 좁히기가 없어
  // 로그인만 되어 있으면 브라우저 devtools로 회사 전체 데이터를 그대로 볼 수 있었다 — 이미 이
  // 함수가 payslips/attendanceRecords 등에 적용해온 것과 동일한 클래스의 누락. 클라이언트가 실제로
  // 쓰는 스코프 규칙(각 화면의 dept/team 필터)을 그대로 서버에 재현한다.
  {
    const employees = Array.isArray(out.employees) ? out.employees : [];
    const myEmp = employees.find(e => String(e.id) === myId) || null;
    // director는 같은 dept, leader는 같은 dept+team 소속 레코드까지 허용(각 화면의
    // "director→dept, leader→dept+team" 스코핑과 동일 — hr-mandatory-training/
    // hr-leave-mgmt/overtime-req 승인 화면이 실제로 이 기준을 쓴다).
    function _deptTeamVisible(rec, empField) {
      if (auth.role === "admin") return true;
      if (rec && String(rec[empField]) === myId) return true;
      if (auth.role !== "director" && auth.role !== "leader") return false;
      if (!myEmp) return false;
      const owner = employees.find(e => rec && String(e.id) === String(rec[empField]));
      if (!owner) return false;
      if (auth.role === "director") return owner.dept === myEmp.dept;
      return owner.dept === myEmp.dept && owner.team === myEmp.team;
    }
    if (Array.isArray(out.expenseClaims)) {
      // expense-admin 화면·승인(_APPROVAL_GATED_FIELDS.expenseClaims)이 admin 전용이라
      // director/leader에게 팀 범위를 열어줄 필요가 없다 — 자기 것만.
      out.expenseClaims = out.expenseClaims.filter(r => auth.role === "admin" || (r && String(r.empId) === myId));
    }
    if (Array.isArray(out.overtimeRequests)) {
      out.overtimeRequests = out.overtimeRequests.filter(r => _deptTeamVisible(r, "empId"));
    }
    if (Array.isArray(out.mandatoryTraining)) {
      out.mandatoryTraining = out.mandatoryTraining.filter(r => _deptTeamVisible(r, "empId"));
    }
    if (Array.isArray(out.leaveUsagePlans)) {
      out.leaveUsagePlans = out.leaveUsagePlans.filter(r => _deptTeamVisible(r, "empId"));
    }
    if (Array.isArray(out.healthCheckupLog)) {
      // welfare-settings(종합검진 완료처리)가 admin 전용이라 자기 것만.
      out.healthCheckupLog = out.healthCheckupLog.filter(r => auth.role === "admin" || (r && String(r.empId) === myId));
    }
    if (Array.isArray(out.certLog)) {
      // 증명서 발급대장(_renderCertLogSection)이 admin 전용이라 자기 것만.
      out.certLog = out.certLog.filter(r => auth.role === "admin" || (r && String(r.empId) === myId));
    }
    if (auth.role !== "admin" && Array.isArray(out.onboardingFlows)) {
      // "온보딩/오프보딩"(onboarding) 화면 자체가 PAGE_ROLES상 admin 전용, 본인 열람 UI 없음.
      out.onboardingFlows = [];
    }
    if (auth.role !== "admin" && Array.isArray(out.tieNotifications)) {
      // director는 자기 사업부(dept) 소속 동점자 처리만(renderApprovals의 기존 필터와 동일).
      out.tieNotifications = auth.role === "director" && myEmp
        ? out.tieNotifications.filter(t => t && t.dept === myEmp.dept)
        : [];
    }
    if (Array.isArray(out.orgChartHistory)) {
      // 조직 변경이력은 admin 또는 settings.orgHistoryViewers에 등록된 인원만(_canViewOrgHistory와 동일).
      const canView = auth.role === "admin" ||
        (settings.orgHistoryViewers || []).map(String).includes(myId);
      if (!canView) out.orgChartHistory = [];
    }
  }
  if (auth.role !== "admin" && out.compGradeResults && typeof out.compGradeResults === "object") {
    out.compGradeResults = Object.prototype.hasOwnProperty.call(out.compGradeResults, myId)
      ? { [myId]: out.compGradeResults[myId] } : {};
  }
  if (auth.role !== "admin" && Array.isArray(out.approvalDocs)) {
    const employees = Array.isArray(out.employees) ? out.employees : [];
    out.approvalDocs = out.approvalDocs.filter(d => {
      if (!d) return false;
      if (String(d.authorId) === myId) return true;
      if (Array.isArray(d.approvers) && d.approvers.some(a => a && String(a.empId) === myId)) return true;
      const _asOf = d.submittedAt || d.createdAt;
      if (_refsToVisibleEmpIdsServer(d.receivers, employees, _asOf).map(String).includes(myId)) return true;
      if (_refsToVisibleEmpIdsServer(d.cc, employees, _asOf).map(String).includes(myId)) return true;
      return false;
    });
  }
  // employees 자체는 이전에 좁혀지지 않아 로그인 사용자라면 누구나 회사 전체의 민감
  // 개인정보를 받았다. 업무상 필요한 최소 범위만 역할·조직 단위로 남긴다.
  if (auth.role !== "admin" && Array.isArray(out.employees)) {
    const employees = out.employees;
    const myEmp = employees.find(e => String(e?.id) === myId) || null;
    const canSeeBroadPersonal = auth.role === "leader" || auth.role === "director";
    out.employees = employees.map(e => {
      if (!e) return e;
      const isSelf = String(e.id) === myId;
      const sameDept = myEmp && e.dept === myEmp.dept;
      const sameDeptTeam = sameDept && e.team === myEmp.team;
      const canSeeSalary = isSelf ||
        (auth.role === "director" && sameDept) ||
        (auth.role === "leader" && sameDeptTeam);
      const canSeeBirth = isSelf || canSeeBroadPersonal;
      const canSeeAddress = isSelf;
      if (canSeeSalary && canSeeBirth && canSeeAddress) return e;
      const copy = { ...e };
      if (!canSeeSalary) delete copy.salary;
      if (!canSeeBirth) delete copy.birth;
      if (!canSeeAddress) delete copy.address;
      return copy;
    });
  }
  return out;
}

// ── TOTP (RFC 6238) 2단계 인증 — 외부 의존성 없이 자체 구현 ────────────────────
const TOTP_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let bits = "", out = "";
  for (const byte of buf) bits += byte.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += TOTP_ALPHABET[parseInt(bits.substr(i, 5), 2)];
  return out;
}
function base32Decode(str) {
  let bits = "", bytes = [];
  for (const c of String(str || "").toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    const val = TOTP_ALPHABET.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substr(i, 8), 2));
  return Buffer.from(bytes);
}
function generateTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
function totpAt(secretBase32, forTimeMs) {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(forTimeMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24 | (hmac[offset + 1] & 0xff) << 16 | (hmac[offset + 2] & 0xff) << 8 | (hmac[offset + 3] & 0xff)) % 1000000;
  return String(code).padStart(6, "0");
}
// ±1 스텝(30초) 오차를 허용해 클라이언트-서버 시계 오차에 대응
function totpVerify(secretBase32, token) {
  if (!/^\d{6}$/.test(String(token || "").trim())) return false;
  const t = String(token).trim();
  for (let w = -1; w <= 1; w++) {
    if (totpAt(secretBase32, Date.now() + w * 30000) === t) return true;
  }
  return false;
}

// The client merges employees by `id` only (smartMerge), so two distinct
// records can legitimately end up sharing the same loginId (e.g. concurrent
// creation in two browser tabs) — that breaks login lookup (Array.find takes
// whichever appears first). We don't auto-rename loginIds (that could lock
// someone out silently); just surface it so an admin can resolve it in the UI.
function warnDuplicateLoginIds(employees) {
  const seen = new Map();
  const duplicates = [];
  for (const e of (employees || [])) {
    if (!e.loginId || e.active === false) continue;
    if (seen.has(e.loginId)) {
      console.warn(`[Integrity] 중복 loginId 감지: "${e.loginId}" (employee ids: ${seen.get(e.loginId)}, ${e.id})`);
      duplicates.push({ loginId: e.loginId, employeeIds: [seen.get(e.loginId), e.id] });
    } else {
      seen.set(e.loginId, e.id);
    }
  }
  return duplicates;
}

// ── In-memory state (SSE / locks only) ───────────────────────────────────────
// 멀티테넌트 전환 전에는 _dataVersion/_lastSaved가 프로세스 전체에 하나뿐인 스칼라였고,
// _locks의 키도 평문("emp:123")이었으며 _sseClients/broadcastSSE는 붙어있는 모든 클라이언트에게
// 무조건 전체 브로드캐스트했다 — 전 배포가 암묵적으로 "회사는 하나"라는 가정 위에 있었다는 뜻.
// 회사가 둘 이상이면 이건 실제 테넌트 간 데이터 유출이 된다(다른 회사의 버전 변화량으로 활동
// 수준이 흘러나가고, 잠금 키가 우연히 겹칠 수 있고, SSE로 다른 회사 사용자명·편집 현황이 그대로
// 노출됨). JSON 파일 모드(자체 호스팅, 항상 단일 회사)는 이 구분이 필요 없으므로 아래 헬퍼들은
// USE_JSON_FILE일 때 전부 하나의 고정 스코프(_GLOBAL_SCOPE)로 수렴해 기존 동작을 그대로 보존한다.
const _GLOBAL_SCOPE = "__global__";
function _scopeKey(companyId) {
  return USE_JSON_FILE ? _GLOBAL_SCOPE : (companyId || _GLOBAL_SCOPE);
}
// companyId(또는 JSON 모드의 _GLOBAL_SCOPE) → { version, lastSaved } 낙관적 동시성 카운터.
// 회사별로 완전히 독립된 버전 계열을 가지므로, 회사 A의 저장이 회사 B의 다음 저장에 "버전이
// 달라졌으니 병합 필요"라는 불필요한(그리고 활동량을 흘리는) 신호를 주지 않는다.
let _versionState = new Map();
function _getVersion(companyId)   { return (_versionState.get(_scopeKey(companyId)) || { version: 0 }).version; }
function _getLastSaved(companyId) { return (_versionState.get(_scopeKey(companyId)) || { lastSaved: null }).lastSaved; }
function _setVersion(companyId, version, lastSaved = null) {
  _versionState.set(_scopeKey(companyId), { version, lastSaved });
}
// _persistDataLocked 안에서 저장이 실제로 커밋된 뒤에만 호출 — 버전을 올리고 lastSaved를 찍는다.
function _bumpVersion(companyId) {
  const key = _scopeKey(companyId);
  const st = { version: (_versionState.get(key) || { version: 0 }).version + 1, lastSaved: new Date().toISOString() };
  _versionState.set(key, st);
  return st;
}
// 잠금 키도 회사별로 완전히 분리한다 — `${_scopeKey(companyId)}:${key}` 형태로 저장하고,
// 클라이언트에는 항상 접두어를 벗긴 원래 키 형태로만 노출한다(_locksForCompany 참고).
let _locks       = {};      // { "companyId:lockKey": { clientId, user, acquiredAt, expiresAt } }
let _sseClients  = {};      // { clientId: { res, user, companyId, connectedAt } }
function _locksForCompany(companyId) {
  const prefix = `${_scopeKey(companyId)}:`;
  const out = {};
  for (const [k, v] of Object.entries(_locks)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}
function _onlineCountFor(companyId) {
  // companyId가 없는 호출(비인증 GET /status 등)은 기존 동작(전체 합계)을 그대로 유지한다.
  if (!companyId) return Object.keys(_sseClients).length;
  return Object.values(_sseClients).filter(c => c.companyId === _scopeKey(companyId)).length;
}

// 신규 직원 id는 원래 클라이언트가 로컬 카운터(서버 _idCounter 스냅샷에서 시작해
// 세션 안에서만 ++)로 발급했는데, 이 카운터는 "마지막으로 GET /data 했을 때"의
// 스냅샷일 뿐이라 여러 HR 담당자가 거의 동시에 각자 신규 직원을 등록하면 전부 같은
// 스냅샷에서 출발해 같은 id를 발급하는 경우가 흔했다 — mergeArrayById는 id로만
// 레코드를 구분하므로 서로 다른 신규 입사자 등록이 하나의 id로 충돌해 한 명만
// 남고 나머지는 조용히 사라졌다(실측: 30명 동시 등록 시 27명 유실). 서버가 원자적으로
// 발급하는 이 엔드포인트로 교체해 충돌 가능성을 근본적으로 없앤다.
let _nextEmployeeIdSeq = null;
const EMPLOYEE_ID_SEQ_FILE = () => JSON_FILE.replace(/\.json$/, "-empidseq.json");
async function _getNextEmployeeId() {
  if (USE_JSON_FILE) {
    if (_nextEmployeeIdSeq == null) {
      let fromFile = 0;
      try { fromFile = JSON.parse(fs.readFileSync(EMPLOYEE_ID_SEQ_FILE(), "utf8")).seq || 0; } catch {}
      const fromData = Math.max(0, ...((_fileStore.employees || []).map(e => Number(e.id) || 0)));
      _nextEmployeeIdSeq = Math.max(fromFile, fromData);
    }
    _nextEmployeeIdSeq++;
    // fire-and-forget persist; even if this write is lost to a crash, the next startup
    // re-derives a safe floor from the max existing employee id above.
    fs.promises.writeFile(EMPLOYEE_ID_SEQ_FILE(), JSON.stringify({ seq: _nextEmployeeIdSeq }), "utf8").catch(() => {});
    return _nextEmployeeIdSeq;
  }
  await pool.query(
    "INSERT INTO app_meta (key, value) SELECT 'next_employee_id', (COALESCE(MAX(id::bigint), 0) + 1)::text FROM employees ON CONFLICT (key) DO NOTHING"
  );
  // 카운터가 최초 생성된 이후에도, POST /save의 범용 upsert 경로(회사 admin이 기존
  // id를 그대로 들고 있는 직원 배열을 저장하는 정상 흐름 — 백업 복원 등)를 통해 이
  // 카운터를 거치지 않고 그보다 큰 id의 직원이 추가될 수 있다. 그러면 카운터가 실제
  // 데이터보다 뒤처져, 다음 발급 id가 이미 존재하는 id와 충돌해 신규 회사 가입/직원
  // 등록이 500(duplicate key)으로 실패한다(실측 확인 — 클라이언트가 서버 인증 성공
  // 후에도 로컬에 남아있던 잔여 employees 배열을 그대로 저장해버리는 별개의 버그를
  // 조사하던 중 발견, public/index.html doLogin()/submitCompanyRegister() 참고).
  // 매 호출마다 카운터를 "현재 값과 MAX(id)+1 중 더 큰 값"으로 올려 이 드리프트를
  // 스스로 복구한다(절대 낮추지 않음 — 낮추면 오히려 새로운 충돌을 만듦). UPDATE는
  // 행 잠금을 거니 동시 호출끼리도 안전하게 직렬화된다.
  await pool.query(
    "UPDATE app_meta SET value = GREATEST(value::bigint, (SELECT COALESCE(MAX(id::bigint),0)+1 FROM employees))::text WHERE key = 'next_employee_id'"
  );
  const { rows } = await pool.query(
    "UPDATE app_meta SET value = (value::bigint + 1)::text WHERE key = 'next_employee_id' RETURNING value"
  );
  return Number(rows[0].value);
}

// ── 저장 요청 직렬화 ──────────────────────────────────────────────────────────
// 두 클라이언트가 거의 동시에 POST /save 하면, 버전 체크→(필요시)병합→실제 저장이
// 서로 인터리빙되면서 나중에 끝난 요청이 먼저 끝난 요청의 변경사항을 통째로 덮어써
// 데이터가 유실되는 문제가 있었다(응답은 ok:true인데 실제로는 반영 안 되는 경우 포함).
// 이 큐로 "버전 체크 → 병합 → persistData" 전체를 하나의 원자적 구간으로 묶어,
// 뒤에 도착한 요청은 앞선 요청이 완전히 끝난 뒤 최신 _dataVersion을 보고 판단하게 한다.
let _saveMutex = Promise.resolve();
function _withSaveLock(fn) {
  const run = _saveMutex.then(fn, fn);
  _saveMutex = run.then(() => {}, () => {});
  return run;
}

// _withSaveLock은 한 Node 프로세스 안에서만 유효하다. Postgres 모드에서 인스턴스를
// 둘 이상 띄우면 각 프로세스가 서로의 메모리 큐·버전을 볼 수 없어 같은 회사의 전체
// 상태 저장이 동시에 진행되고 마지막 요청이 앞선 요청을 덮어쓸 수 있다. 회사별 PG
// advisory lock과 DB의 app_meta 버전을 이용해, 인스턴스 경계를 넘어 같은 저장 구간을
// 직렬화한다. 잠금은 이 함수의 전용 커넥션에만 유지하며 실제 저장은 기존 트랜잭션을
// 그대로 사용하므로 기존 JSON 모드 및 개별 저장 API의 동작에는 영향이 없다.
async function _refreshVersionFromDb(companyId, client) {
  if (USE_JSON_FILE) return;
  const { rows } = await client.query("SELECT value FROM app_meta WHERE key = $1", [`data_version:${_scopeKey(companyId)}`]);
  const value = rows.length ? Number(rows[0].value) : 0;
  _setVersion(companyId, Number.isSafeInteger(value) && value >= 0 ? value : 0);
}
async function _withDistributedSaveLock(companyId, fn) {
  if (USE_JSON_FILE) return fn();
  const client = await pool.connect();
  let locked = false;
  try {
    // 무한 대기 대신 15초 후 재시도를 안내한다. 정상적인 자동저장은 대개 수 초 안에
    // 끝나므로, 네트워크가 끊긴 오래된 작업이 모든 후속 저장을 막는 일을 피한다.
    await client.query("SET lock_timeout = '15s'");
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [`full-state-save:${_scopeKey(companyId)}`]);
    locked = true;
    await _refreshVersionFromDb(companyId, client);
    return await fn();
  } catch (e) {
    if (e && e.code === "55P03") {
      throw httpError(409, "SAVE_LOCK_TIMEOUT", "다른 사용자의 저장이 진행 중입니다. 잠시 후 다시 시도하세요.");
    }
    throw e;
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`full-state-save:${_scopeKey(companyId)}`]); } catch {}
    }
    try { await client.query("RESET lock_timeout"); } catch {}
    client.release();
  }
}

// ── DB bootstrap ──────────────────────────────────────────────────────────────
async function initDB() {
  if (USE_JSON_FILE) {
    if (fs.existsSync(JSON_FILE)) {
      try {
        const raw = fs.readFileSync(JSON_FILE, "utf8");
        _fileStore = JSON.parse(raw);
        _setVersion(null, _fileStore._version || 0);
        console.log(`[Storage] JSON File mode. Loaded ${(_fileStore.employees||[]).length} employees, version=${_getVersion(null)}`);
      } catch (e) {
        console.warn("[Storage] Could not read data file, starting fresh:", e.message);
      }
      // POST /save의 rejectDemoDataForProduction() 게이트는 "다음 저장 요청"이 와야만
      // 작동한다 — DATA_FILE 자체가 이미 더미 데이터로 시작한 채(실수로 seed-demo.js
      // 산출물을 DATA_FILE로 지정, 개발 스냅샷을 그대로 복사 등) 부팅되면 그 요청이
      // 영영 안 올 수도 있어 운영 서비스가 더미 데이터를 계속 보여줄 수 있다. 여기서
      // 한 번 더 검사해, 걸리면 파일을 전혀 쓰지 않은 채(읽기만 했다) 서버 기동 자체를
      // 중단한다 — initDB()가 reject되면 아래 initDB().catch()가 process.exit(1)한다.
      rejectDemoDataForProduction(_fileStore);
    } else {
      console.log("[Storage] JSON File mode. New file will be created at:", JSON_FILE);
    }
    // Load snapshots from separate file
    const snapFile = JSON_FILE.replace(/\.json$/, "-snapshots.json");
    if (fs.existsSync(snapFile)) {
      try {
        _fileSnapshots = JSON.parse(fs.readFileSync(snapFile, "utf8"));
        console.log(`[Storage] Loaded ${Object.keys(_fileSnapshots).length} snapshots`);
      } catch (e) {
        console.warn("[Storage] Could not read snapshots file:", e.message);
      }
    }
    // Load change history from separate file (audit trail, JSON file mode)
    const histFile = JSON_FILE.replace(/\.json$/, "-history.json");
    if (fs.existsSync(histFile)) {
      try {
        _fileHistory = JSON.parse(fs.readFileSync(histFile, "utf8"));
        console.log(`[Storage] Loaded history: ${(_fileHistory.employees||[]).length} employee entries, ${(_fileHistory.kpi||[]).length} kpi entries`);
      } catch (e) {
        console.warn("[Storage] Could not read history file:", e.message);
      }
    }
    // Load accounting module data from separate file
    const acctFile = JSON_FILE.replace(/\.json$/, "-accounting.json");
    if (fs.existsSync(acctFile)) {
      try {
        _fileAccounting = { ..._fileAccounting, ...JSON.parse(fs.readFileSync(acctFile, "utf8")) };
        console.log(`[Storage] Loaded accounting: ${_fileAccounting.accounts.length} accounts, ${_fileAccounting.vouchers.length} vouchers, ${_fileAccounting.taxInvoices.length} tax invoices, ${(_fileAccounting.partners||[]).length} partners`);
      } catch (e) {
        console.warn("[Storage] Could not read accounting file:", e.message);
      }
    }
    // Load RCPS(상환전환우선주) module data from separate file
    const rcpsFile = JSON_FILE.replace(/\.json$/, "-rcps.json");
    if (fs.existsSync(rcpsFile)) {
      try {
        _fileAcctRcps = { ..._fileAcctRcps, ...JSON.parse(fs.readFileSync(rcpsFile, "utf8")) };
        console.log(`[Storage] Loaded RCPS: ${_fileAcctRcps.issuances.length} issuances, ${_fileAcctRcps.schedule.length} schedule rows, ${_fileAcctRcps.valuations.length} valuations`);
      } catch (e) {
        console.warn("[Storage] Could not read RCPS file:", e.message);
      }
    }
    // Load fixed-assets module data from separate file
    const faFile = JSON_FILE.replace(/\.json$/, "-fixedassets.json");
    if (fs.existsSync(faFile)) {
      try {
        _fileAcctFixedAssets = { ..._fileAcctFixedAssets, ...JSON.parse(fs.readFileSync(faFile, "utf8")) };
        console.log(`[Storage] Loaded fixed assets: ${_fileAcctFixedAssets.assets.length} assets, ${_fileAcctFixedAssets.schedule.length} schedule rows`);
      } catch (e) {
        console.warn("[Storage] Could not read fixed-assets file:", e.message);
      }
    }
    // Load sales/inventory (ERP) module data from separate file
    const erpFile = JSON_FILE.replace(/\.json$/, "-erp.json");
    if (fs.existsSync(erpFile)) {
      try {
        _fileErp = { ..._fileErp, ...JSON.parse(fs.readFileSync(erpFile, "utf8")) };
        if (!_fileErp.salesTargets) _fileErp.salesTargets = [];
        console.log(`[Storage] Loaded ERP: ${_fileErp.items.length} items, ${_fileErp.locations.length} locations, ${_fileErp.quotations.length} quotations, ${_fileErp.purchaseOrders.length} purchase orders, ${_fileErp.salesTargets.length} sales targets`);
      } catch (e) {
        console.warn("[Storage] Could not read ERP file:", e.message);
      }
    }
    // Load PMS module data from separate file
    const pmsFile = JSON_FILE.replace(/\.json$/, "-pms.json");
    if (fs.existsSync(pmsFile)) {
      try {
        _filePms = { ..._filePms, ...JSON.parse(fs.readFileSync(pmsFile, "utf8")) };
        console.log(`[Storage] Loaded PMS: ${_filePms.projects.length} projects, ${_filePms.allocations.length} allocations`);
      } catch (e) {
        console.warn("[Storage] Could not read PMS file:", e.message);
      }
    }
    // Load recruiting module data from separate file
    const recruitFile = JSON_FILE.replace(/\.json$/, "-recruit.json");
    if (fs.existsSync(recruitFile)) {
      try {
        _fileRecruit = { ..._fileRecruit, ...JSON.parse(fs.readFileSync(recruitFile, "utf8")) };
        console.log(`[Storage] Loaded recruiting: ${_fileRecruit.jobs.length} jobs, ${_fileRecruit.candidates.length} candidates`);
      } catch (e) {
        console.warn("[Storage] Could not read recruiting file:", e.message);
      }
    }
    // Load activity log from separate file (bounded ring buffer, JSON file mode)
    const activityFile = JSON_FILE.replace(/\.json$/, "-activity.json");
    if (fs.existsSync(activityFile)) {
      try {
        _fileActivityLog = JSON.parse(fs.readFileSync(activityFile, "utf8"));
        if (!Array.isArray(_fileActivityLog)) _fileActivityLog = [];
        console.log(`[Storage] Loaded activity log: ${_fileActivityLog.length} entries`);
      } catch (e) {
        console.warn("[Storage] Could not read activity log file:", e.message);
      }
    }
    // 기초데이터 시딩 (최초 가동 시 비어있는 경우에만)
    if (!_fileAccounting.accounts || _fileAccounting.accounts.length === 0) {
      _fileAccounting.accounts = DEFAULT_ACCOUNTS.map(a => ({ id: `acc_seed_${a.code}`, active: true, ...a }));
      _saveFileAccounting();
      console.log(`[Storage] 기초 계정과목 ${_fileAccounting.accounts.length}건 시딩 완료`);
    }
    if (!_fileErp.locations || _fileErp.locations.length === 0) {
      _fileErp.locations = DEFAULT_LOCATIONS.map((l, i) => ({ id: `loc_seed_${i + 1}`, ...l }));
      _saveFileErp();
      console.log(`[Storage] 기초 위치(창고) ${_fileErp.locations.length}건 시딩 완료`);
    }
    return;
  }
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
  // data_version은 회사별로 완전히 분리된 카운터라 app_meta에 'data_version:<companyId>'
  // 키로 여러 행 저장된다(레거시 단일 회사 배포에서 마이그레이션 전에 쓰던 'data_version'
  // 단일 키는 아래에서 _GLOBAL_SCOPE로 그대로 흡수해 회귀 없이 이어받는다).
  const { rows } = await pool.query(
    "SELECT key, value FROM app_meta WHERE key = 'data_version' OR key LIKE 'data_version:%'"
  );
  let loadedCompanies = 0;
  for (const r of rows) {
    const scope = r.key === "data_version" ? _GLOBAL_SCOPE : r.key.slice("data_version:".length);
    _versionState.set(scope, { version: parseInt(r.value) || 0, lastSaved: null });
    loadedCompanies++;
  }
  console.log(`[DB] PostgreSQL ready. tracked data_version rows=${loadedCompanies}`);

  // 기초데이터(계정과목/위치) 전역 1회 시딩 로직 — 멀티테넌트 4단계(accounts/erp_locations에
  // company_id 적용) 이전에는 "테이블이 비어있으면 전역으로 한 번" 시딩했지만, 이제 두 테이블
  // 모두 (company_id, id) 복합 PK라 company_id는 물리적으로 NOT NULL이다(신규 설치는 스키마
  // 적용 즉시 이 복합 PK로 전환됨 — 실측 확인: `ON CONFLICT (id)`가 더 이상 존재하지 않는
  // 제약을 가리켜 서버 기동 자체가 실패했었음). 회사 없는 "전역 기초데이터"라는 개념 자체가
  // 이 스키마에서 더 이상 성립하지 않으므로, 이 자리의 전역 시딩은 제거하고 회사별 시딩으로
  // 대체했다 — 실제 시딩은 `/api/companies/register`(신규 가입 시 관리자 계정과 함께)에서
  // `_seedCompanyDefaults()`로 수행한다. (레거시 백필 데이터의 company_id NULL 행은 그대로
  // 유지되며, GET 라우트의 `(company_id = $N OR company_id IS NULL)` 패턴으로 계속 노출된다 —
  // 이 자리에서 새로 만들지 않을 뿐이다.)

  // 위 JSON 파일 모드 분기에는 부팅 시점 더미 데이터 fail-fast(rejectDemoDataForProduction)를
  // 걸어뒀는데, 이 Postgres 분기에는 걸지 않고 있었다 — 그런데 실제 운영 배포(DATABASE_URL이
  // 설정된 이 경로)는 정확히 이 분기를 타므로, 그 보호가 진짜 운영 서비스에는 전혀 적용되지
  // 않는 사각지대였다. 멀티테넌트(회사별 분리) 구조라 employees 전체를 메모리로 끌어오는 대신,
  // 더미 마커에 해당하는 행이 하나라도 있는지만 DB에 직접 물어본다(LIMIT 1, 인덱스 없이도
  // 부팅 1회성 쿼리라 비용이 크지 않음). 걸리면 파일 모드와 동일하게 서버 기동 자체를 막는다
  // (DB 자체는 전혀 건드리지 않는다 — SELECT만 실행).
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_DATA !== "true") {
    const [empDemo, kpiDemo] = await Promise.all([
      pool.query(
        `SELECT 1 FROM employees WHERE is_deleted = FALSE AND (
           data->>'source' = 'demo' OR data->>'empNo' ~* '^DEMO-' OR data->>'empNo' ~* '^DM[^0-9]{1,4}[0-9]{2,4}$'
         ) LIMIT 1`
      ),
      pool.query(`SELECT 1 FROM kpi_entries WHERE is_deleted = FALSE AND data->>'source' = 'demo' LIMIT 1`),
    ]);
    if (empDemo.rowCount > 0 || kpiDemo.rowCount > 0) {
      throw new Error("운영 환경에는 더미 데이터를 저장할 수 없습니다. (DB에 이미 존재하는 demo 마커 레코드 발견 — 부팅 중단)");
    }
  }
}

// 신규 가입 회사에 기초 계정과목/위치를 시딩한다(과거 "전역 최초 1회" 시딩을 대체 — 위 initDB()
// 주석 참고). Postgres 트랜잭션 client를 받아 회사 등록과 같은 트랜잭션 안에서 실행된다.
async function _seedCompanyDefaults(client, companyId) {
  for (const a of DEFAULT_ACCOUNTS) {
    const id = `acc_seed_${a.code}`;
    await client.query(
      "INSERT INTO accounts (id, company_id, data) VALUES ($1,$2,$3) ON CONFLICT (company_id, id) DO NOTHING",
      [id, companyId, JSON.stringify({ id, ...a, active: true })]
    );
  }
  for (let i = 0; i < DEFAULT_LOCATIONS.length; i++) {
    const l = DEFAULT_LOCATIONS[i];
    const id = `loc_seed_${i + 1}`;
    await client.query(
      "INSERT INTO erp_locations (id, company_id, data) VALUES ($1,$2,$3) ON CONFLICT (company_id, id) DO NOTHING",
      [id, companyId, JSON.stringify({ id, ...l })]
    );
  }
}

const { ID_KEYED_LIST_FIELDS, GENERIC_LIST_FIELDS, SINGLETON_FIELDS } = require("./lib/collections");

// ── Core DB helpers ───────────────────────────────────────────────────────────
// companyId: employees/kpi_entries(1단계, 2026-07-20)에 이어 app_collections/app_singletons
// (2단계, 2026-07-21 — approvalDocs·expenseClaims·attendanceRecords·settings 등 나머지
// 20여개 필드)도 이제 company_id로 스코프한다. 이 두 테이블은 employees/kpi_entries와 달리
// PRIMARY KEY 자체가 (company_id, collection, id)/(company_id, key) 복합키다 — 클라이언트의
// genId()가 회사 간에 공유되는 로컬 카운터(547부터 증가)라 서로 다른 회사가 같은 id를 만드는
// 게 일상적이기 때문(schema.sql 주석 참고). companyId를 생략하면(레거시 호출부 방어용) 기존처럼
// 전체를 반환한다 — 단일 회사만 존재하는 배포에서는 이 기본 동작이 곧 정상 동작이다.
async function loadData(companyId) {
  if (USE_JSON_FILE) {
    // Return the full stored state so the client restores everything
    // (employees, kpiEntries, settings, coreTalentPool, lowPerfData, etc.)
    return { ..._fileStore, _version: _getVersion(companyId) };
  }
  const empParams = companyId ? [companyId] : [];
  const empFilter = companyId ? "AND company_id = $1" : "";
  const collFilter = companyId ? "WHERE company_id = $1" : "";
  const [empRes, kpiRes, collRes, singRes] = await Promise.all([
    pool.query(`SELECT data FROM employees  WHERE is_deleted = FALSE ${empFilter} ORDER BY created_at`, empParams),
    pool.query(`SELECT data FROM kpi_entries WHERE is_deleted = FALSE ${empFilter} ORDER BY created_at`, empParams),
    pool.query(`SELECT collection, data FROM app_collections ${collFilter} ORDER BY created_at`, empParams),
    pool.query(`SELECT key, data FROM app_singletons ${collFilter}`, empParams),
  ]);
  const result = {
    employees:  empRes.rows.map(r => r.data),
    kpiEntries: kpiRes.rows.map(r => r.data),
    _version:   _getVersion(companyId),
  };
  for (const field of GENERIC_LIST_FIELDS) result[field] = [];
  for (const row of collRes.rows) {
    if (!result[row.collection]) result[row.collection] = [];
    result[row.collection].push(row.data);
  }
  for (const row of singRes.rows) result[row.key] = row.data;
  return result;
}
// Public entry point — acquires the save lock itself. Callers that are
// already inside `_withSaveLock` (the /save route) must call
// `_persistDataLocked` directly instead, to avoid deadlocking on the
// non-reentrant mutex.
// 전자결재 승인 위조 방어.
// approvalDocs는 전용 REST 라우트가 아니라 범용 blob 동기화(POST /save)를 타는 필드라,
// "결재는 지정된 결재자 본인만 할 수 있다"는 규칙이 클라이언트 화면에만 있고 서버에는
// 전혀 없었다. 그래서 인증된 사용자면 누구나 approvalDocs 배열을 손으로 고쳐 보내는 것만으로
// 남의 문서를(심지어 자기가 올린 문서를) 승인 완료로 만들 수 있었다 — 실측: 상신자 본인과
// 완전히 무관한 타 부서 사용자 둘 다 200으로 통과해 status가 approved로 바뀜.
// 병가·경조사·지출처럼 실제 권한이 걸린 문서라 결재 자체가 무의미해지는 문제다.
//
// 정책: 어떤 결재자 칸이 approved/rejected로 "바뀌는" 것은 그 칸의 당사자(empId ===
// 요청자)이거나 관리자일 때만 허용한다. waiting→pending 승격(앞 결재자가 승인하면 다음
// 차례가 열리는 정상 연쇄)과 그 외 상태는 그대로 둔다. 위조로 판정되면 요청을 통째로
// 거부하지 않고 해당 칸만 저장된 값으로 되돌린다 — 이 앱은 매 저장마다 클라이언트가 가진
// 전체 상태를 재전송하는 구조라, 한 칸 때문에 저장 전체를 막으면 무관한 정상 변경까지
// 함께 날아가기 때문이다.
function _sanitizeApprovalDoc(incoming, stored, actor) {
  if (!incoming || !Array.isArray(incoming.approvers)) return incoming;
  if (actor && actor.role === "admin") return incoming;  // 관리자 결재자 변경 등은 기존대로 허용
  const actorId = actor && actor.empId != null ? String(actor.empId) : null;
  const storedApprovers = (stored && Array.isArray(stored.approvers)) ? stored.approvers : null;

  // 결재자 "신원"(empId) 자체를 바꾸는 것은 관리자 전용 기능(pickNewApprover, 퇴직자
  // 결재선 정체 해소용)에서만 일어나야 하는 조작이다. 그런데 아래의 status 전이 검사는
  // "그 칸의 empId가 요청자 본인과 같으면 통과"라는 규칙만 봐서, 이미 존재하는 문서의
  // approvers[i].empId를 아직 status가 안 바뀐 상태(pending→pending 등)로 먼저 자신의
  // empId로 바꿔치기한 뒤, 다음 저장에서 그 칸을 승인 처리하면 "본인 결재"로 오인해
  // 통과시켜버리는 2단계 우회가 있었다(실측: 문서와 무관한 사원이 대기중인 결재 단계를
  // 자기 자신으로 바꾸고 스스로 승인 완료). 신원 자체가 바뀌는 것은 status 값과 무관하게
  // 항상 막아야 하므로, 이미 저장된 문서(stored 존재)라면 approvers 배열의 길이·각 칸의
  // empId가 저장본과 정확히 같은 순서로 일치하는지부터 먼저 확인한다 — 신규 문서 생성
  // 시점(stored 없음)은 결재선을 그 자리에서 새로 구성하는 정상 흐름이라 이 검사 대상이
  // 아니다.
  if (storedApprovers) {
    const identityChanged = incoming.approvers.length !== storedApprovers.length ||
      incoming.approvers.some((a, i) => a && storedApprovers[i] && String(a.empId) !== String(storedApprovers[i].empId));
    if (identityChanged) {
      return { ...incoming, approvers: storedApprovers.map(a => ({ ...a })), status: stored.status };
    }
  }

  const storedList = storedApprovers || [];
  let reverted = false;
  const approvers = incoming.approvers.map((a, i) => {
    if (!a) return a;
    const prev = storedList[i] && String(storedList[i].empId) === String(a.empId)
      ? storedList[i]
      : storedList.find(s => s && String(s.empId) === String(a.empId));
    const prevStatus = prev ? prev.status : "waiting";
    if (a.status === prevStatus) return a;
    if (a.status !== "approved" && a.status !== "rejected") return a;  // 연쇄 승격 등은 허용
    if (actorId && String(a.empId) === actorId) return a;              // 당사자 본인의 결재
    reverted = true;
    return prev ? { ...prev } : { ...a, status: "waiting", decidedAt: null, comment: "" };
  });
  if (!reverted) return incoming;
  // 결재자 칸을 되돌렸으면 그 칸들로부터 파생되는 문서 전체 상태도 저장된 값으로 되돌린다
  // (상신 취소·삭제요청처럼 결재자와 무관한 status 변경은 reverted가 false라 영향 없음).
  return { ...incoming, approvers, status: stored ? stored.status : "in_progress" };
}
// 경비청구·초과근무·증명서도 approvalDocs와 똑같은 구조적 문제를 갖고 있었다 — 승인 권한
// 검사가 클라이언트 함수(approveExpenseClaim의 role!=="admin", _otCanApprove,
// approveCertRequest의 role!=="admin")에만 있고, 실제 저장은 범용 blob 동기화(/save)로
// 나가기 때문에 서버가 아무것도 검증하지 않았다. 실측: 사원(member)이 자기가 올린
// 경비청구(금액)·초과근무(수당)·증명서 신청을 전부 스스로 승인 완료로 만들 수 있었다.
// 각 컬렉션의 "승인 상태로 전이"만 게이팅하고, 신청·수정·취소 등 나머지는 그대로 둔다.
function _otCanApproveServer(rec, actor, actorEmp) {
  if (!actor) return false;
  if (String(rec.empId) === String(actor.empId)) return false;   // 본인 신청은 본인이 승인 불가
  if (actor.role === "admin") return true;
  if (!actorEmp) return false;
  if (actor.role === "director") return rec.dept === actorEmp.dept;
  if (actor.role === "leader") return rec.dept === actorEmp.dept && rec.team === actorEmp.team;
  return false;
}
// welfarePoints는 승인 상태 전이가 아니라 "레코드 생성" 자체가 곧 금전 효과라 별도 규칙이
// 필요하다. 부여(grant)는 관리자 화면(doGrantWelfare)에서만 만들어지는데 서버 검증이 없어,
// 사원이 /save로 `type:"grant"` 레코드를 직접 만들어 자기에게 무제한 부여할 수 있었다
// (실측: member가 자기에게 500만원 자가 부여 성공). 사용(use)은 본인 것만 만들 수 있고,
// 잔액 초과 여부도 클라이언트에서만 보고 있었다.
function _welfareRecordAllowed(rec, actor, actorEmp, settings) {
  if (!actor) return false;
  // points는 잔액 계산(grants합 - uses합)에 그대로 더해지는 값이라, 부호·범위 검증이 없으면
  // "use" 레코드에 음수 points를 넣는 것만으로 잔액 초과 사용 방지 로직(_dropOverspentWelfare)을
  // 완전히 우회해 자기 잔액을 무제한으로 부풀릴 수 있다(실측: 사원이 grant 100,000원 상태에서
  // points:-500,000짜리 "use" 레코드 하나로 잔액이 600,000원까지 늘어남 — 관리자 전용 grant
  // 제한을 사실상 무력화). 클라이언트(doGrantWelfare/doUseWelfare)도 항상 amount>0인 정수만
  // 보내므로, 양의 유한값(1억원 이하)만 허용 — role/actingAsMaster 여부와 무관하게 항상 적용한다.
  const pts = Number(rec.points);
  if (!Number.isFinite(pts) || pts <= 0 || pts > 100000000) return false;
  if (actor.role === "admin") return true;
  // 복지포인트 담당자로 지정된 직원(settings.welfarePointsViewers)은 관리자가 아니어도
  // "복지포인트 현황(전체)" 화면(_canViewWelfareAll로 게이팅)에서 부여를 처리한다 —
  // 읽기 필터가 이미 같은 기준을 쓰므로 쓰기도 동일하게 맞춘다. 이 예외가 없으면
  // 지정 담당자의 부여가 서버에서 조용히 되돌려진다.
  if (((settings || {}).welfarePointsViewers || []).map(String).includes(String(actor.empId))) return true;
  if (rec.type === "grant") return false;                              // 그 외 부여는 관리자만
  if (rec.type === "use") return String(rec.empId) === String(actor.empId);  // 사용은 본인만
  return false;
}
// 관리자 전용 화면에서만 만들어져야 하는 레코드들. 여기도 전부 blob 동기화(/save)를 타는데
// 서버 검증이 없어, 사원(member)이 자기에게 유리한 레코드를 직접 만들어 넣을 수 있었다
// (실측: 급여명세서 실수령 9,900만원 자가 생성, 인센티브 1,000만원 자가 지급,
//  KPI 등급 C→S 자가 조정, 핵심인재 자가 등록, 결재 양식 임의 생성 등 10개 컬렉션 전부 열림).
// roles: 이 역할이면 누구 레코드든 쓸 수 있음(해당 화면의 PAGE_ROLES와 일치)
// ownField: 그 필드가 본인 id면 역할과 무관하게 허용(본인 출퇴근 체크·본인 증명서 발급 등)
const _WRITE_GATED_FIELDS = {
  payslips:           { roles: ["admin"] },                                   // payroll-mgmt
  payrollAdjustments: { roles: ["admin"] },                                   // payroll-mgmt
  // KPI 등급 현황(grade-view, admin/director/leader 공개) 화면의 "수정" 버튼은
  // admin뿐 아니라 director에게도 노출된다(openAdjustGradeModal이 admin||director를
  // 명시적으로 허용) — director가 자기 사업부 직원의 등급을 조정하면 실제 등급
  // (employees.gradeResults, 게이팅 대상 아님)은 반영되지만 이 감사이력만 조용히
  // 되돌려지고 있었다. director는 자기 사업부(dept) 레코드에 한해 허용.
  gradeAdjustHistory: { roles: ["admin"], directorDeptField: "dept" },        // comp-grade-view / grade-view
  coreTalentPool:     { roles: ["admin"] },                                   // core-talent
  approvalTemplates:  { roles: ["admin"] },                                   // approval-templates
  // hr-mandatory-training(admin/director/leader)의 일괄 등록 외에, 누구나 접근 가능한 개인
  // "법정의무교육" 화면(mandatory-training)에 본인 이수 자가등록 버튼("이수 등록")이 있다 —
  // ownField가 없으면 leader 미만(대부분의 사원)의 자가등록이 서버에서 조용히 되돌려진다.
  mandatoryTraining:  { roles: ["admin", "director", "leader"], ownField: "empId" },
  // 근태: 결재 완료 시 승인자의 화면이 기안자(타인)의 근태를 쓴다(_setAttRec) — 리더 이상은
  // 타인 기록도 써야 하고, 사원은 본인 출퇴근 체크만.
  attendanceRecords:  { roles: ["admin", "director", "leader"], ownField: "empId" },
  leaveUsagePlans:    { roles: ["admin", "director", "leader"], ownField: "empId" },
  certLog:            { roles: ["admin"], ownField: "empId" },                // 본인 증명서 발급 기록은 허용
  boardPosts:         { roles: ["admin"], ownField: "authorId" },             // 본인 명의 게시글만
  // 결재 위임: 위임하는 쪽(empId)이 본인이어야 한다. 검증이 없으면 남의 결재권을 자기에게
  // 위임하는 레코드를 만들어 결재 권한을 통째로 탈취할 수 있다.
  approvalDelegations: { roles: ["admin"], ownField: "empId" },
  // 다면평가 응답은 평가자 본인 명의로만(타인 명의 제출 = 평가 위조)
  compResponses:      { roles: ["admin"], ownField: "evaluatorId" },
  compSessions:       { roles: ["admin"] },                                   // eval-ops
  changeRequests:     { roles: ["admin", "director", "leader"], ownField: "reqUserId" },
  // 육성계획: 본인(핵심인재 본인이 자기 IDP 작성) 또는 지정 담당자(settings.talentDevViewers)
  talentDevPlans:     { roles: ["admin", "director", "leader"], ownField: "empId", viewersSetting: "talentDevViewers" },
  // 동점자 처리(renderApprovals의 "동점자 처리" 탭)는 director에게도 노출되어(자기 사업부
  // 소속분만, t.dept===u.dept) "처리 완료 표시"(markTieResolved) 버튼을 director가 누를 수
  // 있다 — admin만 허용하면 director의 처리가 조용히 되돌려져 알림이 영구히 안 사라진다.
  tieNotifications:   { roles: ["admin"], directorDeptField: "dept" },
  // 종합검진 완료 처리 토글(_toggleHcDone)은 welfare-settings(관리자 전용) 화면에만 있다
  healthCheckupLog:   { roles: ["admin"] },
  onboardingFlows:    { roles: ["admin"] },
  orgChartHistory:    { roles: ["admin"] },
  integrationLogs:    { roles: ["admin"] },
  roomReservations:   { roles: ["admin"], ownField: "bookedBy" },
  scheduleEvents:     { roles: ["admin", "director", "leader"], ownField: "authorId" },
  // 저성과자 관리: 읽기와 같은 기준(관리자 또는 settings.lowPerformerViewers 등록자)
  lowPerfData:        { roles: ["admin"], viewersSetting: "lowPerformerViewers" },
};
function _writeGateAllowed(field, rec, actor, actorEmp, settings) {
  const rule = _WRITE_GATED_FIELDS[field];
  if (!rule || !actor) return false;
  if (rule.roles.includes(actor.role)) return true;
  if (rule.ownField && String(rec[rule.ownField]) === String(actor.empId)) return true;
  if (rule.viewersSetting && ((settings || {})[rule.viewersSetting] || []).map(String).includes(String(actor.empId))) return true;
  // director 한정, 그 부서 소속 레코드만 허용(예: KPI 등급조정 이력·동점자 처리 — 클라이언트가
  // 이미 director를 자기 사업부(dept)로만 스코핑해 버튼을 노출하고 있는 화면들).
  if (rule.directorDeptField && actor.role === "director" && actorEmp &&
      rec[rule.directorDeptField] === actorEmp.dept) return true;
  return false;
}
const _APPROVAL_GATED_FIELDS = {
  expenseClaims:    { decided: ["approved", "rejected", "paid"], can: (rec, actor) => !!actor && actor.role === "admin" },
  certRequests:     { decided: ["approved", "rejected"],         can: (rec, actor) => !!actor && actor.role === "admin" },
  overtimeRequests: { decided: ["approved", "rejected"],         can: _otCanApproveServer },
  welfarePoints:    { record: _welfareRecordAllowed },
  ...Object.fromEntries(Object.keys(_WRITE_GATED_FIELDS).map(f =>
    [f, { record: (rec, actor, actorEmp, settings) => _writeGateAllowed(f, rec, actor, actorEmp, settings) }])),
};
// 반환값: 저장할 레코드, 또는 null(= 이 레코드는 아예 쓰지 않음 — 권한 없이 새로 만들어진 것)
function _sanitizeGatedRecord(field, incoming, stored, actor, actorEmp, settings) {
  const rule = _APPROVAL_GATED_FIELDS[field];
  if (!rule || !incoming) return incoming;
  if (rule.record) {
    // 바뀌지 않은 레코드는 그대로 통과(매 저장마다 전체 배열이 재전송되므로 대부분이 여기).
    if (stored && JSON.stringify(stored) === JSON.stringify(incoming)) return incoming;
    if (rule.record(incoming, actor, actorEmp, settings)) return incoming;
    return stored ? { ...stored } : null;
  }
  const prevStatus = stored ? stored.status : "pending";
  if (incoming.status === prevStatus) return incoming;
  if (!rule.decided.includes(incoming.status)) return incoming;   // 신청·취소 등은 그대로
  if (rule.can(incoming, actor, actorEmp)) return incoming;
  // 권한 없는 승인/반려 — 저장된 레코드로 되돌린다(신규 레코드면 pending으로).
  return stored ? { ...stored } : { ...incoming, status: "pending" };
}
// 복지포인트 잔액 초과 사용 차단. 클라이언트(doUseWelfare)가 잔액을 계산해 막고 있지만
// 서버 재검증이 없어, 두 세션에서 거의 동시에 사용하면 둘 다 통과해 잔액이 마이너스로
// 내려갈 수 있었다. 저장 직전에 그 직원·그 연도의 부여/사용 합계를 다시 계산해 초과분을
// 걸러낸다(관리자 저장은 정산·조정 목적일 수 있어 그대로 둔다).
function _dropOverspentWelfare(incomingList, storedList, actor) {
  if (!Array.isArray(incomingList) || !actor || actor.role === "admin") return incomingList;
  const storedIds = new Set((storedList || []).map(r => String(r.id)));
  const newUses = incomingList.filter(r => r && r.type === "use" && !storedIds.has(String(r.id)));
  if (!newUses.length) return incomingList;
  const sumOf = (list, empId, year, type) => (list || [])
    .filter(r => r && String(r.empId) === String(empId) && r.type === type && String(r.year) === String(year))
    .reduce((s, r) => s + (Number(r.points) || 0), 0);
  const rejected = new Set();
  for (const u of newUses) {
    const grants = sumOf(storedList, u.empId, u.year, "grant");
    const usedBefore = sumOf(storedList, u.empId, u.year, "use");
    const usedNewAccepted = newUses
      .filter(x => x !== u && !rejected.has(String(x.id)) && String(x.empId) === String(u.empId) && String(x.year) === String(u.year))
      .reduce((s, x) => s + (Number(x.points) || 0), 0);
    if (usedBefore + usedNewAccepted + (Number(u.points) || 0) > grants) rejected.add(String(u.id));
  }
  if (!rejected.size) return incomingList;
  return incomingList.filter(r => !(r && rejected.has(String(r.id))));
}
// 같은 회의실·겹치는 시간대 예약을 서버에서도 거부한다. 클라이언트(_roomConflicts)는
// 이미 같은 로직으로 이중예약을 막고 있지만, 화면을 거치지 않고 /save를 직접 호출하면
// 이 검사 자체가 없어 같은 회의실·같은 시간대에 서로 다른 예약이 그대로 저장됐다.
// 알고리즘은 _roomConflicts와 동일 — allDay/날짜범위/시간대 겹침을 그대로 재현한다.
function _roomReservationConflicts(rec, storedList, excludeId) {
  return (storedList || []).some(r => {
    if (!r) return false;
    if (excludeId != null && String(r.id) === String(excludeId)) return false;
    if (r.roomId !== rec.roomId) return false;
    const rEnd = r.endDate || r.date;
    const startDate = rec.date, endDate = rec.endDate || rec.date;
    if (endDate < r.date || startDate > rEnd) return false;
    if (rec.allDay || r.allDay) return true;
    if (startDate !== endDate || r.date !== rEnd) return true;
    return r.startTime < rec.endTime && r.endTime > rec.startTime;
  });
}
const _HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// 화면 폼은 값을 제한하지만(예: <input type=number min=1 max=24>, 시작<종료 검사) 이
// 범용 blob 동기화(/save) 경로는 위 승인 게이팅(권한) 통과 이후에도 값 자체의 범위·형식은
// 전혀 검증하지 않아, API를 직접 호출하면 오염된 값이 그대로 저장돼 아래 화면들의 합계·
// 평균 계산에 그대로 쓰였다(각 분기 주석에 실측 결과 기록). 위반 시 false를 반환해
// 호출부가 그 레코드를 저장본으로 되돌리거나(신규면 드롭) 하도록 한다 — 승인 게이팅과
// 동일하게 "이 레코드만 되돌리고 나머지 정상 변경은 그대로 저장"하는 원칙을 따른다.
function _validateFieldValues(field, rec, storedList) {
  if (!rec) return true;
  if (field === "overtimeRequests") {
    // hours는 승인 후 급여 계산의 초과근무수당(otReqAllowance = hours * 시급 * 배율)에
    // 그대로 곱해진다 — 실측: API로 hours:9999를 제출하면 검증 없이 그대로 저장됨(승인
    // 자체는 본인이 아닌 리더 이상만 가능하지만, 승인자가 화면상 값을 못 알아채고 승인하면
    // 그 즉시 수당이 왜곡된다). 클라이언트(_otCalcHours)도 항상 0<hours<=24(30분 단위)만
    // 만들어내므로 서버도 동일 범위로 제한한다.
    const hrs = Number(rec.hours);
    if (!Number.isFinite(hrs) || hrs <= 0 || hrs > 24) return false;
  } else if (field === "attendanceRecords") {
    // checkIn/checkOut은 "HH:mm" 문자열을 그대로 split(":")해 근무시간(분)을 계산하는 데
    // 쓰인다 — 실측: checkOut을 "99:99"로 보내면 검증 없이 저장되고, 이후 급여/근태 화면의
    // 근무시간 합산에서 (99*60+99)-(0*60+0)=6039분(≈100시간)으로 잡혀 실제 8시간짜리 근무가
    // 100시간 근무로 부풀려짐. 00:00~23:59 형식만 허용(빈 값은 "아직 체크 안 함"으로 허용).
    const timeOk = (t) => t === "" || t == null || _HHMM_RE.test(String(t));
    if (!timeOk(rec.checkIn) || !timeOk(rec.checkOut)) return false;
  } else if (field === "compResponses") {
    // answers는 {문항id: 1~5점}이며 항목평균(itemAvgs)·전체평균 계산에 그대로 쓰인다 —
    // 실측: 문항 점수를 999로 보내면 검증 없이 저장되고 그 항목 평균이 왜곡된다.
    const answers = rec.answers;
    if (answers && typeof answers === "object") {
      for (const v of Object.values(answers)) {
        if (v == null) continue;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 5) return false;
      }
    }
  } else if (field === "roomReservations") {
    // 시작<종료·날짜범위·이중예약을 서버에서도 검사(위 _roomReservationConflicts 주석 참고).
    if (!rec.allDay) {
      if (!_HHMM_RE.test(String(rec.startTime || "")) || !_HHMM_RE.test(String(rec.endTime || "")) || rec.startTime >= rec.endTime) return false;
    }
    const startDate = rec.date, endDate = rec.endDate || rec.date;
    if (!startDate || endDate < startDate) return false;
    if (_roomReservationConflicts(rec, storedList, rec.id)) return false;
  } else if (field === "leaveUsagePlans") {
    // items[].days는 화면에 "계획 합계"로 표시되고 잔여연차와 비교되는 참고용 계획 수치다
    // (실제 연차 차감은 approvalDocs의 승인된 연차 신청서에서 계산되어 이 필드가 잔액 자체를
    // 왜곡하지는 않지만, 날짜범위가 뒤집히거나 일수가 음수/비정상이면 계획 화면 자체가 깨진다).
    if (Array.isArray(rec.items)) {
      for (const it of rec.items) {
        if (!it) continue;
        if (it.startDate && it.endDate && it.endDate < it.startDate) return false;
        if (it.days != null) {
          const d = Number(it.days);
          if (!Number.isFinite(d) || d <= 0 || d > 366) return false;
        }
      }
    }
  }
  return true;
}
// KPI 승인 위조 방어. kpiEntries는 employees처럼 자체 테이블(JSON모드는 _fileStore.kpiEntries)을
// 쓰고 위 _APPROVAL_GATED_FIELDS 승인게이팅 경로(GENERIC_LIST_FIELDS 전용, app_collections만
// 대상)를 타지 않는다 — 그래서 firstStatus(팀장 1차승인)/finalStatus·finalConfirmed(사업부장
// 최종확정)/firstScore·secondScore(평가 점수) 같은 승인 관련 필드에 서버 검증이 전혀 없었다.
// 실측(이 세션 QA로 발견): 사원이 자기 KPI 항목을 firstStatus:"approved", finalStatus:"approved",
// finalConfirmed:true로 직접 /save 호출해 팀장→사업부장 승인 절차 전체를 건너뛰고 스스로
// 100점 만점으로 확정할 수 있었다. approvalDocs/expenseClaims 등과 동일한 원칙 — 권한 없는
// 필드만 저장본 값으로 되돌리고(신규 레코드면 미승인 기본값으로), 같은 요청에 실린 무관한
// 정상 변경(목표 등록/제출, 자체평가 입력 등)은 그대로 저장한다.
// 권한 기준은 클라이언트 renderApprovalList/renderEvalTab이 실제로 버튼을 노출하는 조건과
// 동일: 1차승인·1차점수는 그 팀원의 팀장(같은 dept+team)만, 최종확정·2차점수는 그 직원의
// 사업부장(같은 dept)만 — director는 1차승인을, leader는 최종확정을 할 수 없다.
function _sanitizeKpiEntry(incoming, stored, actor, actorEmp, empById) {
  if (!incoming) return incoming;
  let out = incoming;
  const cloneOnce = () => { if (out === incoming) out = { ...incoming }; };
  // 기존 레코드의 소유자(userId)를 바꿔치기하는 것 자체를 항상 차단 — 이미 승인된 레코드를
  // 자기 것으로 재지정해 승인 상태만 그대로 가로채는 것을 막는다(approvalDocs의 결재자
  // 신원 변경 차단과 동일한 발상).
  if (stored && incoming.userId != null && String(incoming.userId) !== String(stored.userId)) {
    cloneOnce();
    out.userId = stored.userId;
  }
  const ownerId = out.userId ?? stored?.userId;
  const ownerEmp = ownerId != null ? empById.get(String(ownerId)) : null;
  const canFirst = actor.role === "leader" && actorEmp && ownerEmp &&
    ownerEmp.dept === actorEmp.dept && ownerEmp.team === actorEmp.team;
  const canFinal = actor.role === "director" && actorEmp && ownerEmp &&
    ownerEmp.dept === actorEmp.dept;

  const storedFirstStatus = stored?.firstStatus || "";
  if ((incoming.firstStatus || "") !== storedFirstStatus &&
      (incoming.firstStatus === "approved" || incoming.firstStatus === "rejected") && !canFirst) {
    cloneOnce();
    out.firstStatus = storedFirstStatus;
    out.firstReason = stored?.firstReason || "";
  }
  if (!canFirst && (incoming.firstScore !== (stored?.firstScore ?? null) ||
      (incoming.firstComment || "") !== (stored?.firstComment || ""))) {
    cloneOnce();
    out.firstScore = stored?.firstScore ?? null;
    out.firstComment = stored?.firstComment || "";
  }

  const storedFinalStatus = stored?.finalStatus || "";
  if ((incoming.finalStatus || "") !== storedFinalStatus &&
      (incoming.finalStatus === "approved" || incoming.finalStatus === "rejected") && !canFinal) {
    cloneOnce();
    out.finalStatus = storedFinalStatus;
    out.finalReason = stored?.finalReason || "";
    out.finalConfirmed = stored?.finalConfirmed || false;
    out.finalScore = stored?.finalScore ?? null;
  }
  if (!canFinal) {
    if (incoming.secondScore !== (stored?.secondScore ?? null) ||
        (incoming.secondComment || "") !== (stored?.secondComment || "")) {
      cloneOnce();
      out.secondScore = stored?.secondScore ?? null;
      out.secondComment = stored?.secondComment || "";
      out.secondCommentPublic = stored?.secondCommentPublic || false;
    }
    // finalConfirmed는 연말 일괄확정(admin 전용, 이미 우회됨) 외에는 항상 finalStatus
    // 승인과 함께 세팅되지만, 독립적으로 flip되는 경로가 생기더라도 방어.
    if (incoming.finalConfirmed && !(stored?.finalConfirmed)) {
      cloneOnce();
      out.finalConfirmed = stored?.finalConfirmed || false;
      out.finalScore = stored?.finalScore ?? null;
    }
  }
  return out;
}
// employees 쓰기 권한 위조 방어(2026-08-19 외부 감사 P0-1/P0-2 결합 대응). employees도
// approvalDocs/kpiEntries와 같은 처지다 — 전용 REST 라우트가 아니라 범용 blob 동기화
// (POST /save)를 타서, "role은 관리자만 바꿀 수 있다"는 규칙이 관리자 전용 UI(직원정보수정
// 화면)에만 있고 서버에는 전혀 없었다. 실측(2026-08-19 외부 감사 재현): member로 로그인해
// GET /data로 자기 레코드를 받아 role만 "admin"으로 고쳐 POST /save로 재전송하면 그대로
// 저장되고, 그 뒤 재로그인한 토큰이 실제로 role:"admin"이었다 — 완전한 권한 상승.
//
// 이 함수는 role뿐 아니라 salary/birth/address도 함께 방어한다 — filterDataForRole()에서
// 같은 감사(P0-2)로 이 세 필드를 non-admin에게 숨기기 시작했는데, 이 앱은 매 저장마다
// 클라이언트가 가진 employees 전체 배열을 재전송하는 구조라, 그 필드가 "빠진" 로컬 상태를
// 그대로 재저장하면(흔한 자동저장 패턴) 서버가 그걸 "지우겠다는 요청"으로 오인해 다른
// 직원의 실제 값을 지워버릴 수 있다(감사가 "P0-1/P0-2는 같은 릴리스에 함께" 넣으라고
// 지적한 지점). 권한 기준은 openSelfEdit()의 실제 self-service 경로와 일치시킨다 —
// salary는 어떤 화면에도 non-admin 본인수정 경로가 없어 항상 저장값으로 되돌리고, birth/
// address는 본인 레코드(isSelf)에 한해 그대로 통과시킨다.
//
// actor가 없는 호출(초기 부트스트랩·/restore 등 신뢰된 경로)은 대상이 아니며, 호출부에서
// `actor && actor.role !== "admin"`일 때만 이 함수를 적용한다(관리자는 그대로 통과 —
// approvalDocs 결재자 변경과 동일한 관례).
function _sanitizeEmployeeRecord(rawEmp, stored, actor) {
  if (!rawEmp) return rawEmp;
  let out = rawEmp;
  const cloneOnce = () => { if (out === rawEmp) out = { ...rawEmp }; };
  const desiredRole = stored ? stored.role : "member";
  if (out.role !== desiredRole) { cloneOnce(); out.role = desiredRole; }
  const storedSalary = stored ? stored.salary : undefined;
  if (out.salary !== storedSalary) { cloneOnce(); out.salary = storedSalary; }
  const isSelf = actor && actor.empId != null && String(actor.empId) === String(rawEmp.id);
  if (!isSelf) {
    const storedBirth = stored ? stored.birth : undefined;
    const storedAddress = stored ? stored.address : undefined;
    if (out.birth !== storedBirth) { cloneOnce(); out.birth = storedBirth; }
    if (out.address !== storedAddress) { cloneOnce(); out.address = storedAddress; }
  }
  return out;
}
// 세션/토큰 철회 방어(2026-08-19 외부 감사 P0-5). 로그인 토큰(JWT류, signToken())은 만료
// 시각까지(SESSION_TTL_SEC, 기본 12시간) 스스로 유효함을 증명하는 완전한 stateless 토큰이라,
// 서버가 그 사이에 employees 레코드를 바꿔도(퇴직 처리로 active:false, 강등으로 role 하향,
// 관리자의 비밀번호 강제 초기화 등) 이미 발급된 토큰 자체는 계속 유효했다 — 실측 가능한
// 문제: 방금 퇴직 처리된 직원이 여전히 들고 있는 토큰으로 자연 만료 전까지 계속 API를
// 호출할 수 있었다. role/pw/active 중 하나라도 실제로 바뀌면 그 레코드의 authVersion을
// 1 증가시키고, 로그인 시 발급하는 토큰에 그 시점의 authVersion을 함께 실어(authenticate()
// 미들웨어 참고) 매 요청마다 "토큰에 찍힌 버전 == 지금 저장된 버전"을 대조 — 다르면 그
// 토큰은 즉시 무효로 취급된다(재로그인해야 새 버전의 토큰을 받음). 새 레코드(ex 없음)는
// 비교 대상이 없으므로 0에서 시작.
function _nextAuthVersion(ex, emp, pw) {
  if (!ex) return 0;
  const prev = Number(ex.authVersion) || 0;
  const changed = pw !== ex.pw || emp.role !== ex.role || !!emp.active !== !!ex.active;
  return changed ? prev + 1 : prev;
}
async function persistData(data, changedBy = "system", companyId = null, actor = null) {
  return _withSaveLock(() => _withDistributedSaveLock(companyId, () => _persistDataLocked(data, changedBy, companyId, actor)));
}
async function _persistDataLocked(data, changedBy = "system", companyId = null, actor = null) {
  // kpiEntries.weight(비중,%)는 화면 입력칸엔 별다른 제한이 없고(saveKpiDraft가 Number(...)||20
  // 폴백만 함) 서버도 전혀 검증하지 않아, API를 직접 호출하면 음수·수천% 같은 값이 그대로
  // 저장됐다 — 이 값은 다면/역량 등급 산정(assignCompPoolGrades 호출부의 weighted average,
  // totalWt=sum(weight), wtScore=sum(secondScore*weight/totalWt))에 분모·가중치로 그대로
  // 쓰여, 한 항목의 weight를 극단값으로 넣으면 그 직원의 최종 등급(승급/성과급에 연결)이
  // 임의로 조작될 수 있었다(실측 재현 확인). kpiEntries는 employees처럼 자체 테이블을 쓰고
  // GENERIC_LIST_FIELDS의 승인게이팅 경로를 타지 않으므로, JSON/Postgres 두 분기가 공유하는
  // 이 지점(둘 다 data.kpiEntries를 그대로 읽는다)에서 0~100 범위로 clamp — 다른 필드는
  // 건드리지 않고 이 값만 보정해, 문제 있는 weight 하나 때문에 정상적인 나머지 목표 데이터가
  // 통째로 버려지지 않게 한다.
  if (Array.isArray(data.kpiEntries)) {
    for (const kpi of data.kpiEntries) {
      if (!kpi || kpi.weight == null) continue;
      const w = Number(kpi.weight);
      kpi.weight = Number.isFinite(w) ? Math.min(100, Math.max(0, w)) : 0;
    }
  }
  // KPI 승인 위조 방어(_sanitizeKpiEntry 주석 참고) — admin은 그대로 통과(기존 관례와 동일).
  // loadData()로 이 저장이 반영되기 "전" 스냅샷(직원 dept/team, 기존 kpiEntries)을 한 번만
  // 불러와 JSON/Postgres 두 모드에서 공통으로 사용 — 요청자의 부서/팀·기존 승인 상태는
  // 클라이언트가 보낸 값(위조 가능)이 아니라 이 스냅샷에서 판단한다.
  if (Array.isArray(data.kpiEntries) && data.kpiEntries.length && actor && actor.role !== "admin") {
    const _kpiGatePrior = await loadData(companyId);
    const _kpiEmpById = new Map((_kpiGatePrior.employees || []).map(e => [String(e.id), e]));
    const _kpiStoredById = new Map((_kpiGatePrior.kpiEntries || []).map(k => [String(k.id), k]));
    const _kpiActorEmp = actor.empId != null ? _kpiEmpById.get(String(actor.empId)) : null;
    data.kpiEntries = data.kpiEntries.map(kpi =>
      _sanitizeKpiEntry(kpi, kpi && kpi.id != null ? _kpiStoredById.get(String(kpi.id)) : null, actor, _kpiActorEmp, _kpiEmpById));
  }
  if (USE_JSON_FILE) {
    // Save the full client state to the JSON file
    const existingById = {};
    for (const e of (_fileStore.employees || [])) existingById[e.id] = e;
    const existingKpiById = {};
    for (const k of (_fileStore.kpiEntries || [])) existingKpiById[k.id] = k;

    // NOTE: GET /data strips `pw` before it ever reaches the client (see
    // stripPwField), so the client can never learn the server-side bcrypt
    // hash — it always resends each employee's original plaintext password
    // on every save (getFullState() always includes the full `employees`
    // array, on every autosave, for every module: leave requests, board
    // posts, attendance edits, etc.). Previously this branch re-ran
    // bcrypt.hash(pw,10) for every one of ~258 employees on every single
    // save regardless of whether anything actually changed, which took
    // 20+ seconds (measured) and blew past the client's 15s save timeout —
    // the root cause of intermittent "저장이 안 되는" failures across the
    // whole app. Only re-hash when the record is new or has genuinely been
    // updated since the last save (same updatedAt-newer-than-stored check
    // already used below to decide whether to record history); otherwise
    // keep the existing hash untouched.
    // data.employees(및 kpiEntries)가 아예 없는(undefined) 저장 요청 — 예: settings만
    // 바꾸는 저장 — 은 기존 목록을 그대로 유지해야 한다. 그런데 아래 employees는 항상
    // `data.employees || []`를 매핑해 만들어지고, 그 결과가 아래 최종 `_fileStore = {...}`
    // 조립에서 무조건 덮어쓰기 때문에, employees 필드를 생략한 어떤 인증된 요청(관리자가
    // 아니어도 됨, /save는 requireAuth만 요구)이든 현재 버전과 일치하기만 하면(스마트머지를
    // 건너뛰는 정상 경로) 회사 전체 직원 목록이 그 자리에서 빈 배열로 지워졌다(실측 재현:
    // POST /save body에 employees를 아예 넣지 않고 현재 _version만 맞춰 보내면 로그인 계정
    // 포함 전 직원이 통째로 삭제됨). Postgres/SaaS 모드(실제 운영 배포)는 upsert-only 구조라
    // (아래 else 분기, "들어온 id만 갱신하고 없는 건 안 지운다") 이 문제가 없고, 여기 JSON
    // 파일(자체 호스팅) 모드에만 있던 결함이다. employees 키 자체가 없을 때만(명시적으로
    // 빈 배열 `[]`을 보낸 경우는 "전원 삭제"라는 의도된 요청일 수 있어 그대로 존중) 기존
    // 목록을 보존한다.
    const employeesInputMissing = data.employees === undefined;
    const _empActorNonAdmin = !!(actor && actor.role !== "admin");
    const employees = employeesInputMissing ? (_fileStore.employees || []) : await Promise.all((data.employees || []).map(async (rawEmpIn) => {
      const ex0 = existingById[rawEmpIn.id];
      const rawEmp = _empActorNonAdmin ? _sanitizeEmployeeRecord(rawEmpIn, ex0, actor) : rawEmpIn;
      const ex = existingById[rawEmp.id];
      const oldTs = ex ? (ex.updatedAt || ex.createdAt || "") : "";
      const newTs = rawEmp.updatedAt || rawEmp.createdAt || "";
      const changed = !ex || newTs > oldTs;
      // 비밀번호는 관리자 또는 본인만 바꿀 수 있다(doChangePW()가 유일한 정상 self-service
      // 경로 — 현재 비밀번호로 /login 재인증 후 자기 레코드의 pw만 바꾼다). 그 외에는 무시하고
      // 기존 해시를 그대로 유지한다(2026-08-19 외부 감사 P0-1 — 남의 레코드에 새 pw를 실어
      // 보내면 그대로 저장돼 계정을 탈취할 수 있었다).
      const isSelf = actor && actor.empId != null && String(actor.empId) === String(rawEmp.id);
      const pwAllowed = !_empActorNonAdmin || isSelf;
      let pw = rawEmp.pw;
      if (!changed || !pwAllowed) pw = ex ? ex.pw : undefined;
      else if (pw == null || pw === "") pw = ex?.pw;
      else pw = await hashPlaintextPw(pw);
      const emp = { ...rawEmp, pw };
      emp.authVersion = _nextAuthVersion(ex, emp, pw);
      if (!ex) {
        _recordFileHistory("employees", emp.id, "insert", changedBy, emp);
      } else if (changed) {
        _recordFileHistory("employees", emp.id, "update", changedBy, emp);
      }
      return emp;
    }));
    const duplicateLoginIds = warnDuplicateLoginIds(employees);

    // Same fix as above: only log kpi history when the record is new or
    // genuinely newer than what's stored, instead of `>=` which re-logged
    // a redundant "update" entry for every unchanged kpi entry on every
    // save, flooding out real audit history against the MAX_FILE_HISTORY cap.
    for (const kpi of (data.kpiEntries || [])) {
      if (!kpi.id) continue;
      const ex = existingKpiById[kpi.id];
      if (!ex) {
        _recordFileHistory("kpi", kpi.id, "insert", changedBy, kpi);
      } else {
        const oldTs = ex.updatedAt || ex.createdAt || "";
        const newTs = kpi.updatedAt || kpi.createdAt || "";
        if (newTs > oldTs) _recordFileHistory("kpi", kpi.id, "update", changedBy, kpi);
      }
    }
    _saveFileHistory();

    // payslips/kpiEntries/lowPerfData/coreTalentPool/welfarePoints are now filtered by role
    // before ever reaching a non-privileged client (see filterDataForRole in GET /data) —
    // that client's local copy of these fields is intentionally incomplete (only their own
    // records, or empty entirely for lowPerfData), so a plain overwrite of `_fileStore[field]`
    // with `data[field]` on their next autosave would wipe out every other employee's record.
    // Always merge these fields by id against what's already stored (same union semantics
    // smartMerge uses for a stale save) instead of trusting the incoming array to be the
    // complete set, then apply this save's own tombstones so genuine deletions still take
    // effect. Safe by construction: mergeArrayById only touches ids actually present in the
    // incoming array, so ids a filtered client never received (and therefore can't send back)
    // are left untouched from _fileStore.
    const _tomb = data.recordTombstones || {};
    // 승인 게이팅(_sanitizeGatedRecord 주석 참고): 경비청구·초과근무·증명서의 승인/반려
    // 전이는 저장 직전에 저장본과 대조해 권한 없는 것을 되돌린다. 요청자의 부서/팀은
    // 클라이언트가 보낸 data.employees(위조 가능)가 아니라 저장본에서 읽는다.
    const _actorEmpJson = actor && actor.empId != null
      ? (_fileStore.employees || []).find(e => String(e.id) === String(actor.empId)) || null
      : null;
    for (const gatedField of Object.keys(_APPROVAL_GATED_FIELDS)) {
      if (!Array.isArray(data[gatedField])) continue;
      const storedList = _fileStore[gatedField] || [];
      const storedById = new Map(storedList.map(r => [String(r.id), r]));
      data[gatedField] = data[gatedField]
        .map(r => {
          if (!r || r.id == null) return r;
          const stored = storedById.get(String(r.id));
          let out = _sanitizeGatedRecord(gatedField, r, stored, actor, _actorEmpJson, _fileStore.settings);
          // 값 범위·형식 검증(_validateFieldValues 주석 참고) — 권한 검사를 통과한 뒤에도
          // 값 자체가 오염돼 있으면 저장본으로 되돌린다(신규 레코드면 드롭).
          if (out && !_validateFieldValues(gatedField, out, storedList)) out = stored ? { ...stored } : null;
          return out;
        })
        .filter(r => r !== null);
      if (gatedField === "welfarePoints") {
        data[gatedField] = _dropOverspentWelfare(data[gatedField], storedList, actor);
      }
    }
    function _mergeProtectedField(field) {
      let merged = mergeArrayById(_fileStore[field], data[field]);
      const dead = _tomb[field];
      if (dead && dead.length) {
        const deadIds = new Set(dead.map(t => t.id));
        merged = merged.filter(r => !(r && deadIds.has(r.id)));
      }
      return merged;
    }
    const kpiEntriesFinal   = _mergeProtectedField("kpiEntries");
    const payslipsFinal     = _mergeProtectedField("payslips");
    const lowPerfDataFinal  = _mergeProtectedField("lowPerfData");
    const coreTalentPoolFinal = _mergeProtectedField("coreTalentPool");
    const welfarePointsFinal  = _mergeProtectedField("welfarePoints");
    const payrollAdjustmentsFinal = _mergeProtectedField("payrollAdjustments");
    const gradeAdjustHistoryFinal = _mergeProtectedField("gradeAdjustHistory");
    const certRequestsFinal       = _mergeProtectedField("certRequests");
    const changeRequestsFinal     = _mergeProtectedField("changeRequests");
    const attendanceRecordsFinal  = _mergeProtectedField("attendanceRecords");
    const scheduleEventsFinal     = _mergeProtectedField("scheduleEvents");
    // 오늘 filterDataForRole()에 새로 추가한 9개 필드도 동일하게 보호 — 필터링된(불완전한)
    // 로컬 배열이 그대로 재저장돼 다른 직원의 레코드를 지우는 사고를 막는다(위 6개 필드와
    // 동일한 이유). Postgres 모드는 원래 upsert-only(들어온 id만 갱신)라 이미 안전.
    const expenseClaimsFinal    = _mergeProtectedField("expenseClaims");
    const overtimeRequestsFinal = _mergeProtectedField("overtimeRequests");
    const mandatoryTrainingFinal = _mergeProtectedField("mandatoryTraining");
    const leaveUsagePlansFinal  = _mergeProtectedField("leaveUsagePlans");
    const healthCheckupLogFinal = _mergeProtectedField("healthCheckupLog");
    const certLogFinal          = _mergeProtectedField("certLog");
    const onboardingFlowsFinal  = _mergeProtectedField("onboardingFlows");
    const tieNotificationsFinal = _mergeProtectedField("tieNotifications");
    const orgChartHistoryFinal  = _mergeProtectedField("orgChartHistory");
    // 결재 위조 방어(_sanitizeApprovalDoc 주석 참고): 병합 전에 들어온 문서를 저장본과
    // 대조해 권한 없는 결재 칸 변경을 되돌린다.
    const approvalDocsFinal = (() => {
      const storedList = _fileStore.approvalDocs || [];
      const storedById = new Map(storedList.map(d => [String(d.id), d]));
      const incoming = Array.isArray(data.approvalDocs)
        ? data.approvalDocs.map(d => (d && d.id != null) ? _sanitizeApprovalDoc(d, storedById.get(String(d.id)), actor) : d)
        : data.approvalDocs;
      let merged = mergeArrayById(storedList, incoming);
      const dead = _tomb["approvalDocs"];
      if (dead && dead.length) {
        const deadIds = new Set(dead.map(t => t.id));
        merged = merged.filter(r => !(r && deadIds.has(r.id)));
      }
      return merged;
    })();
    // compGradeResults is a nested singleton ({empId:{year:{...}}}), not an id-keyed array —
    // filterDataForRole() now narrows it to the requester's own key for non-admin, so (like the
    // array fields above) a plain overwrite would wipe out every other employee's grade result.
    // mergeNestedObject() unions per-employee/per-year keys from both sides instead (same helper
    // smartMerge() already uses for the version-conflict path — this covers the direct-overwrite
    // path too, which smartMerge never touches).
    const compGradeResultsFinal = data.compGradeResults !== undefined
      ? mergeNestedObject(_fileStore.compGradeResults, data.compGradeResults)
      : _fileStore.compGradeResults;
    // compResponses is filtered differently — not whole-record hiding but per-record FIELD
    // stripping (evaluator identity/content removed for records the requester didn't author,
    // to protect multi-rater anonymity; see filterDataForRole). A stripped copy still carries
    // the record's id with the *same* updatedAt/createdAt as the original, so plain
    // mergeArrayById's ">=" tie-break would let the incoming stripped copy overwrite the full
    // stored record on every non-admin autosave. Guard against that: an incoming record
    // missing the content-only field `answers` (present only on a full/unstripped record) is
    // treated as a redacted echo and ignored whenever a full record already exists server-side.
    function _mergeCompResponses() {
      const existingById = {};
      for (const r of (_fileStore.compResponses || [])) if (r && r.id != null) existingById[r.id] = r;
      const incoming = Array.isArray(data.compResponses) ? data.compResponses : [];
      const merged = { ...existingById };
      for (const item of incoming) {
        if (!item || item.id == null) continue;
        const ex = existingById[item.id];
        if (ex && !("answers" in item)) continue; // redacted echo — keep the full stored record
        if (!ex || (item.updatedAt || item.createdAt || "") >= (ex.updatedAt || ex.createdAt || "")) {
          merged[item.id] = item;
        }
      }
      let result = Object.values(merged);
      const dead = _tomb.compResponses;
      if (dead && dead.length) {
        const deadIds = new Set(dead.map(t => t.id));
        result = result.filter(r => !(r && deadIds.has(r.id)));
      }
      return result;
    }
    const compResponsesFinal = _mergeCompResponses();

    // Defense in depth alongside the smartMerge fix above: even for a save that skips
    // smartMerge (client claims to be exactly at the current version), keep any existing
    // collection the incoming payload doesn't mention instead of dropping it — a plain
    // `{...data, employees}` would silently delete every field absent from `data`.
    _fileStore = {
      ..._fileStore, ...data, employees,
      kpiEntries: kpiEntriesFinal, payslips: payslipsFinal,
      lowPerfData: lowPerfDataFinal, coreTalentPool: coreTalentPoolFinal,
      welfarePoints: welfarePointsFinal, compResponses: compResponsesFinal,
      payrollAdjustments: payrollAdjustmentsFinal, gradeAdjustHistory: gradeAdjustHistoryFinal,
      certRequests: certRequestsFinal, changeRequests: changeRequestsFinal,
      attendanceRecords: attendanceRecordsFinal, scheduleEvents: scheduleEventsFinal,
      expenseClaims: expenseClaimsFinal, overtimeRequests: overtimeRequestsFinal,
      mandatoryTraining: mandatoryTrainingFinal, leaveUsagePlans: leaveUsagePlansFinal,
      healthCheckupLog: healthCheckupLogFinal, certLog: certLogFinal,
      onboardingFlows: onboardingFlowsFinal, tieNotifications: tieNotificationsFinal,
      orgChartHistory: orgChartHistoryFinal,
      approvalDocs: approvalDocsFinal, compGradeResults: compGradeResultsFinal,
    };
    const verState = _bumpVersion(companyId);
    _fileStore._version = verState.version;
    // Write atomically via a temp file
    const tmp = JSON_FILE + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(_fileStore, null, 2), "utf8");
    await fs.promises.rename(tmp, JSON_FILE);
    return { duplicateLoginIds };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── employees upsert + history ────────────────────────────────────────────
    // id 컬럼 자체는 여전히 전역 유일(설계상 회사마다 새 시퀀스를 쓰지 않음, _getNextEmployeeId
    // 참고)이라 정상 흐름에서는 다른 회사의 id와 충돌하지 않는다. 그래도 클라이언트가 (스푸핑
    // 등으로) 다른 회사 소유의 id를 보내는 경우에 대비해, 기존 행의 company_id가 요청자의
    // company_id와 다르면 그 레코드는 조용히 건너뛴다(404/403 대신 무시 — 다른 회사 리소스의
    // 존재 자체를 노출하지 않는다는 이 세션의 인가 원칙과 동일).
    const _empActorNonAdmin = !!(actor && actor.role !== "admin");
    for (const rawEmpIn of (data.employees || [])) {
      if (!rawEmpIn.id) continue;
      const { rows } = await client.query(
        "SELECT data, company_id FROM employees WHERE id = $1", [rawEmpIn.id]
      );
      if (rows.length && companyId && rows[0].company_id && rows[0].company_id !== companyId) continue;
      const rawEmp = _empActorNonAdmin
        ? _sanitizeEmployeeRecord(rawEmpIn, rows.length ? rows[0].data : null, actor)
        : rawEmpIn;
      // 비밀번호는 관리자 또는 본인만(2026-08-19 외부 감사 P0-1 — JSON 파일 모드와 동일한
      // 방어를 Postgres/SaaS 모드에도 적용).
      const isSelf = actor && actor.empId != null && String(actor.empId) === String(rawEmp.id);
      const pwAllowed = !_empActorNonAdmin || isSelf;
      if (rows.length === 0) {
        let pw = rawEmp.pw;
        if (!pwAllowed) pw = undefined;
        else if (pw != null && pw !== "") pw = await hashPlaintextPw(pw);
        const emp = { ...rawEmp, pw, authVersion: 0 };
        await client.query(
          "INSERT INTO employees (id, data, company_id) VALUES ($1, $2, $3)",
          [emp.id, emp, companyId]
        );
        await client.query(
          "INSERT INTO employee_history (employee_id, action, changed_by, data, company_id) VALUES ($1,'insert',$2,$3,$4)",
          [emp.id, changedBy, emp, companyId]
        );
      } else {
        const oldTs = rows[0].data.updatedAt || rows[0].data.createdAt || "";
        const newTs = rawEmp.updatedAt || rawEmp.createdAt || "";
        // Strictly-newer check (not >=): the client always resends every
        // employee's plaintext pw on every save (GET /data strips the hash,
        // so it can never echo it back), so an equal timestamp means "no
        // real change" — treating it as a change re-ran bcrypt.hash(pw,10)
        // for every employee on every save (20+ seconds for ~258 employees,
        // blowing past the client's 15s save timeout). See matching fix in
        // the JSON-file branch above.
        if (newTs > oldTs) {
          let pw = rawEmp.pw;
          if (!pwAllowed) pw = rows[0].data.pw;
          else if (pw == null || pw === "") pw = rows[0].data.pw;
          else pw = await hashPlaintextPw(pw);
          const emp = { ...rawEmp, pw, authVersion: _nextAuthVersion(rows[0].data, { ...rawEmp, pw }, pw) };
          await client.query(
            "UPDATE employees SET data = $2, updated_at = NOW() WHERE id = $1",
            [emp.id, emp]
          );
          await client.query(
            "INSERT INTO employee_history (employee_id, action, changed_by, data, company_id) VALUES ($1,'update',$2,$3,$4)",
            [emp.id, changedBy, emp, companyId]
          );
        }
      }
    }
    let duplicateLoginIds = [];
    if ((data.employees || []).length) {
      const { rows: allEmp } = companyId
        ? await client.query("SELECT data FROM employees WHERE is_deleted = FALSE AND company_id = $1", [companyId])
        : await client.query("SELECT data FROM employees WHERE is_deleted = FALSE");
      duplicateLoginIds = warnDuplicateLoginIds(allEmp.map(r => r.data));
    }

    // ── kpi_entries upsert + history ──────────────────────────────────────────
    for (const kpi of (data.kpiEntries || [])) {
      if (!kpi.id) continue;
      const empId   = kpi.employeeId || kpi.employee_id || null;
      const evalYear = kpi.year ? parseInt(kpi.year) : null;
      const { rows } = await client.query(
        "SELECT data, company_id FROM kpi_entries WHERE id = $1", [kpi.id]
      );
      if (rows.length && companyId && rows[0].company_id && rows[0].company_id !== companyId) continue;
      if (rows.length === 0) {
        await client.query(
          "INSERT INTO kpi_entries (id, employee_id, eval_year, data, company_id) VALUES ($1,$2,$3,$4,$5)",
          [kpi.id, empId, evalYear, kpi, companyId]
        );
        await client.query(
          "INSERT INTO kpi_history (kpi_id, action, changed_by, data, company_id) VALUES ($1,'insert',$2,$3,$4)",
          [kpi.id, changedBy, kpi, companyId]
        );
      } else {
        const oldTs = rows[0].data.updatedAt || rows[0].data.createdAt || "";
        const newTs = kpi.updatedAt || kpi.createdAt || "";
        if (newTs >= oldTs) {
          await client.query(
            "UPDATE kpi_entries SET data = $2, employee_id = $3, eval_year = $4, updated_at = NOW() WHERE id = $1",
            [kpi.id, kpi, empId, evalYear]
          );
          await client.query(
            "INSERT INTO kpi_history (kpi_id, action, changed_by, data, company_id) VALUES ($1,'update',$2,$3,$4)",
            [kpi.id, changedBy, kpi, companyId]
          );
        }
      }
    }

    // ── generic id-keyed collections (attendance, payslips, approvals, etc.) ──
    // Historically upsert-only: a record removed from the client's array (a user clicking
    // "삭제") was simply never re-sent, but nothing here ever issued a DELETE, so it stayed
    // in app_collections forever and could resurface on the next full load. recordTombstones
    // (see mergeArrayById/smartMerge) now records exactly which ids were locally deleted, so
    // apply those as real deletes here — the same fix kpi_entries gets just below.
    //
    // company_id (2단계): 이 테이블의 PK가 (company_id, collection, id) 복합키로 바뀌었으므로
    // (schema.sql 참고), "이미 존재하는 레코드인지" 조회하는 tie-break SELECT도 반드시
    // company_id로 스코프해야 한다 — 스코프하지 않으면 id가 우연히 같은 다른 회사의 레코드를
    // "기존 레코드"로 착각해(예: 그 회사의 최신 updatedAt이 이 회사가 지금 저장하려는 값보다
    // 최신으로 보이면) 이 회사의 정당한 저장을 조용히 건너뛰는 버그가 생긴다. companyId는
    // 항상 req.auth.companyId(서버가 검증한 토큰)에서만 오므로, 클라이언트가 다른 회사의
    // company_id를 지정해 쓰기를 스푸핑할 방법 자체가 없다 — employees/kpi_entries처럼
    // "다른 회사 소유면 건너뛴다"는 별도 방어 코드가 필요 없는 이유이기도 하다(회사가 다르면
    // 애초에 별개의 PK 행이라 서로 절대 겹치지 않는다). company_id IS NULL(백필 전 레거시 행)도
    // 함께 매칭해 마이그레이션 전환 기간 동안 자기 자신의 레거시 데이터를 정상적으로 이어받게
    // 한다 — 이 완화는 tie-break 조회에만 적용하고, 실제 INSERT/UPDATE는 항상 이 요청의
    // 진짜 companyId로만 기록한다.
    const recordTombstones = data.recordTombstones || {};
    // 복지포인트 잔액 초과 사용 차단은 그 직원·연도의 전체 원장이 필요해 항목별 SELECT로는
    // 부족하다 — 신규 use 레코드가 실제로 있을 때만 컬렉션을 한 번 읽어 걸러낸다.
    if (Array.isArray(data.welfarePoints) && actor && actor.role !== "admin") {
      const { rows: wpRows } = await client.query(
        "SELECT data FROM app_collections WHERE collection = 'welfarePoints' AND (company_id = $1 OR company_id IS NULL)",
        [companyId || null]
      );
      data.welfarePoints = _dropOverspentWelfare(data.welfarePoints, wpRows.map(r => r.data), actor);
    }
    // 승인 게이팅에 쓸 요청자의 부서/팀. 클라이언트가 보낸 data.employees는 위조 가능하므로
    // 저장본에서 읽는다. 초과근무 승인처럼 실제로 필요할 때 한 번만 조회하고 재사용한다.
    let _actorEmpPg, _actorEmpPgLoaded = false;
    const _getActorEmpPg = async () => {
      if (_actorEmpPgLoaded) return _actorEmpPg;
      _actorEmpPgLoaded = true;
      _actorEmpPg = null;
      if (actor && actor.empId != null) {
        const { rows } = await client.query(
          "SELECT data FROM employees WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL)",
          [actor.empId, companyId || null]
        );
        _actorEmpPg = rows.length ? rows[0].data : null;
      }
      return _actorEmpPg;
    };
    // 저성과자 열람·수정 허용자 목록(settings.lowPerformerViewers)도 클라이언트가 보낸
    // data.settings가 아니라 저장본에서 읽는다.
    let _settingsPg, _settingsPgLoaded = false;
    const _getSettingsPg = async () => {
      if (_settingsPgLoaded) return _settingsPg;
      _settingsPgLoaded = true;
      const { rows } = await client.query(
        "SELECT data FROM app_singletons WHERE key = 'settings' AND (company_id = $1 OR company_id IS NULL)",
        [companyId || null]
      );
      _settingsPg = rows.length ? rows[0].data : {};
      return _settingsPg;
    };
    // 이중예약 검사(_roomReservationConflicts)는 그 회의실의 기존 예약 전체가 필요해
    // 단건 SELECT로는 부족하다 — roomReservations를 실제로 쓸 때만 한 번 조회해 재사용한다.
    let _roomReservationsPg, _roomReservationsPgLoaded = false;
    const _getRoomReservationsPg = async () => {
      if (_roomReservationsPgLoaded) return _roomReservationsPg;
      _roomReservationsPgLoaded = true;
      const { rows } = await client.query(
        "SELECT data FROM app_collections WHERE collection = 'roomReservations' AND (company_id = $1 OR company_id IS NULL)",
        [companyId || null]
      );
      _roomReservationsPg = rows.map(r => r.data);
      return _roomReservationsPg;
    };
    for (const field of GENERIC_LIST_FIELDS) {
      const items = data[field];
      if (Array.isArray(items)) {
        for (const item of items) {
          if (!item || item.id == null) continue;
          const { rows } = companyId
            ? await client.query(
                "SELECT data FROM app_collections WHERE collection = $1 AND id = $2 AND (company_id = $3 OR company_id IS NULL)",
                [field, String(item.id), companyId]
              )
            : await client.query(
                "SELECT data FROM app_collections WHERE collection = $1 AND id = $2",
                [field, String(item.id)]
              );
          // compResponses is filtered by filterDataForRole() with per-record FIELD stripping
          // (evaluator identity/content removed for records the requester didn't author, to
          // protect multi-rater anonymity), not whole-record hiding like the other generic
          // fields — a redacted echo carries the same id/updatedAt as the real record, so the
          // usual "newer wins" tie-break would let it silently overwrite the full stored
          // content on every non-admin autosave. A record missing `answers` (present only on
          // a full/unstripped record) is that redacted echo — ignore it whenever a full
          // record already exists server-side, regardless of timestamp.
          if (field === "compResponses" && rows.length && !("answers" in item)) continue;
          const oldTs = rows.length ? (rows[0].data.updatedAt || rows[0].data.createdAt || "") : "";
          const newTs = item.updatedAt || item.createdAt || "";
          if (rows.length && newTs < oldTs) continue; // server has a newer copy, keep it
          // 결재 위조 방어(_sanitizeApprovalDoc / _sanitizeGatedRecord 주석 참고).
          // 저장본은 바로 위에서 이미 조회했으므로 추가 쿼리 없이 그대로 대조한다.
          const storedItem = rows.length ? rows[0].data : null;
          let toWrite = item;
          if (field === "approvalDocs") {
            toWrite = _sanitizeApprovalDoc(item, storedItem, actor);
          } else if (_APPROVAL_GATED_FIELDS[field]) {
            toWrite = _sanitizeGatedRecord(field, item, storedItem, actor, await _getActorEmpPg(), await _getSettingsPg());
            if (toWrite === null) continue;   // 권한 없이 새로 만들어진 레코드 — 쓰지 않음
          }
          // 값 범위·형식 검증(_validateFieldValues 주석 참고, JSON모드와 동일 규칙).
          if (toWrite && !_validateFieldValues(field, toWrite, field === "roomReservations" ? await _getRoomReservationsPg() : null)) {
            toWrite = storedItem;
            if (toWrite === null) continue;
          }
          await client.query(
            `INSERT INTO app_collections (collection, id, company_id, data, updated_at) VALUES ($1,$2,$3,$4,NOW())
             ON CONFLICT (company_id, collection, id) DO UPDATE SET data = $4, updated_at = NOW()`,
            [field, String(item.id), companyId, JSON.stringify(toWrite)]
          );
        }
      }
      // roomReservations predates the generic recordTombstones mechanism and still tracks
      // its own deletions in data.roomReservationTombstones (see mergeTombstones) — fold
      // both sources in so DB mode actually deletes them too, not just JSON-file mode.
      const extraDead = field === "roomReservations" ? (data.roomReservationTombstones || []) : [];
      const deadIds = [...(recordTombstones[field] || []), ...extraDead].map(t => String(t.id));
      if (deadIds.length) {
        // (company_id = $3 OR $3 IS NULL): companyId가 있으면 이 회사 소유 행만(레거시 NULL
        // 행은 건드리지 않음 — 삭제는 되돌릴 수 없는 작업이라 employees/kpiEntries의 /restore
        // deleteExtras와 동일하게 보수적으로 처리), companyId를 모르면(레거시 호출부 방어용)
        // 기존처럼 전역으로 삭제한다.
        await client.query(
          "DELETE FROM app_collections WHERE collection = $1 AND id = ANY($2) AND (company_id = $3 OR $3 IS NULL)",
          [field, deadIds, companyId]
        );
      }
    }
    {
      const deadKpiIds = (recordTombstones.kpiEntries || []).map(t => t.id);
      if (deadKpiIds.length) {
        await client.query(
          companyId ? "DELETE FROM kpi_entries WHERE id = ANY($1) AND company_id = $2" : "DELETE FROM kpi_entries WHERE id = ANY($1)",
          companyId ? [deadKpiIds, companyId] : [deadKpiIds]
        );
      }
    }

    // ── singleton config blobs ─────────────────────────────────────────────────
    // company_id (2단계): app_singletons도 PK가 (company_id, key) 복합키로 바뀌었으므로
    // 위 app_collections와 동일한 이유로 조회는 company_id(+레거시 NULL)로 스코프하고, 쓰기는
    // 항상 이 요청의 진짜 companyId로만 기록한다.
    for (const key of SINGLETON_FIELDS) {
      if (data[key] === undefined) continue;
      let valueToStore = data[key];
      // compGradeResults is now narrowed to the requester's own key for non-admin by
      // filterDataForRole() (see GET /data) — a plain overwrite here would wipe out every
      // other employee's grade result on that requester's next autosave. Merge per-employee/
      // per-year keys against what's already stored instead (same helper smartMerge() uses
      // for the version-conflict path; this covers the direct-overwrite path too).
      if (key === "compGradeResults") {
        const { rows } = companyId
          ? await client.query("SELECT data FROM app_singletons WHERE key = $1 AND (company_id = $2 OR company_id IS NULL)", [key, companyId])
          : await client.query("SELECT data FROM app_singletons WHERE key = $1", [key]);
        valueToStore = mergeNestedObject(rows.length ? rows[0].data : null, data[key]);
      }
      await client.query(
        `INSERT INTO app_singletons (key, company_id, data, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (company_id, key) DO UPDATE SET data = $3, updated_at = NOW()`,
        [key, companyId, JSON.stringify(valueToStore)]
      );
    }

    // ── bump version (회사별로 분리된 카운터, _bumpVersion 참고) ──────────────────
    const verState = _bumpVersion(companyId);
    await client.query(
      "INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [`data_version:${_scopeKey(companyId)}`, String(verState.version)]
    );

    await client.query("COMMIT");
    return { duplicateLoginIds };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Smart merge: prefer newer record by updatedAt (kept for conflict resolution)
// Merges two arrays of records sharing an `id` field, keeping whichever side's
// record has the newer updatedAt/createdAt. Used so a client saving with a
// stale local copy of a list (e.g. attendanceRecords) doesn't blow away records
// another client added/edited in the meantime.
function mergeArrayById(serverArr, clientArr) {
  if (!Array.isArray(clientArr)) return Array.isArray(serverArr) ? serverArr : [];
  if (!Array.isArray(serverArr)) return clientArr;
  const map = {};
  for (const item of serverArr) {
    if (item && item.id != null) map[item.id] = item;
  }
  for (const item of clientArr) {
    if (item == null || item.id == null) continue;
    const ex = map[item.id];
    if (!ex || (item.updatedAt || item.createdAt || "") >= (ex.updatedAt || ex.createdAt || "")) {
      map[item.id] = item;
    }
  }
  return Object.values(map);
}

// Collections sent by getFullState() that are arrays of records keyed by `id`.
// Everything else in clientData (settings, orgDB, gradeSettings, etc. — small
// singleton config objects) is left to simple last-write-wins via the spread
// below, since they're rarely edited concurrently and don't have per-record ids.
// Deleted-record tombstones: a plain union merge of id-keyed arrays can never
// distinguish "this client doesn't know about this record" (keep it) from
// "this client deleted this record" (drop it), so a deletion that's still
// only in transit can get silently resurrected by another client's concurrent
// save. roomReservationTombstones records {id, ts} of locally-deleted
// reservation ids; mergeTombstones unions both sides (newest ts wins, entries
// older than 30 days are pruned) so the merged tombstone set can filter
// resurrected ids back out of the merged roomReservations array.
function mergeTombstones(serverList, clientList) {
  const byId = {};
  for (const t of [...(serverList || []), ...(clientList || [])]) {
    if (!t || t.id == null) continue;
    if (!byId[t.id] || t.ts > byId[t.id].ts) byId[t.id] = t;
  }
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return Object.values(byId).filter(t => t.ts >= cutoff);
}

// Same idea as roomReservationTombstones/mergeTombstones above, generalized to every
// id-keyed collection (employees, kpiEntries, approvalDocs, expenseClaims, ...) instead
// of just room reservations. serverObj/clientObj are shaped {field: [{id,ts},...]}.
// Merging per-field with mergeTombstones() keeps the newest tombstone for each id and
// prunes entries older than 30 days, same as the room-reservation-only version.
function mergeRecordTombstones(serverObj, clientObj) {
  const merged = {};
  for (const field of new Set([...Object.keys(serverObj || {}), ...Object.keys(clientObj || {})])) {
    merged[field] = mergeTombstones((serverObj || {})[field], (clientObj || {})[field]);
  }
  return merged;
}

// Merges two plain objects keyed by an outer id (e.g. employee id) whose
// values are themselves objects keyed by a second level (e.g. year) —
// compGradeResults[empId][year] = {grade,score,...}. Unlike mergeArrayById,
// this never collapses a non-array side to [] — it unions both sides key by
// key so a concurrent save-conflict merge can't wipe out other employees'
// already-computed grade results.
function mergeNestedObject(serverObj, clientObj) {
  const sOk = serverObj && typeof serverObj === "object" && !Array.isArray(serverObj);
  const cOk = clientObj && typeof clientObj === "object" && !Array.isArray(clientObj);
  if (!sOk) return cOk ? clientObj : {};
  if (!cOk) return serverObj;
  const merged = { ...serverObj };
  for (const key of Object.keys(clientObj)) {
    const sInner = merged[key], cInner = clientObj[key];
    const sInnerOk = sInner && typeof sInner === "object" && !Array.isArray(sInner);
    const cInnerOk = cInner && typeof cInner === "object" && !Array.isArray(cInner);
    merged[key] = (sInnerOk && cInnerOk) ? { ...sInner, ...cInner } : cInner;
  }
  return merged;
}

function smartMerge(serverData, clientData) {
  if (!serverData) return clientData;
  const merged = { ...serverData, ...clientData };
  const recordTombstones = mergeRecordTombstones(serverData.recordTombstones, clientData.recordTombstones);
  merged.recordTombstones = recordTombstones;
  for (const field of ID_KEYED_LIST_FIELDS) {
    if (clientData[field] !== undefined || serverData[field] !== undefined) {
      // compResponses is filtered by filterDataForRole() via per-record FIELD stripping
      // (see the detailed comment in _persistDataLocked) rather than whole-record hiding —
      // a redacted echo carries the same id/updatedAt as the real record, so plain
      // mergeArrayById() would let it win the "newer wins" tie-break and overwrite the full
      // stored content. Drop redacted echoes (missing `answers`) before merging whenever the
      // server already has a full record for that id.
      const clientArr = field === "compResponses" && Array.isArray(clientData[field])
        ? clientData[field].filter(item => {
            if (!item || item.id == null) return true;
            const hasServerFull = Array.isArray(serverData[field]) && serverData[field].some(s => s && s.id === item.id && "answers" in s);
            return !(hasServerFull && !("answers" in item));
          })
        : clientData[field];
      let mergedField = mergeArrayById(serverData[field], clientArr);
      // A record deleted by one client (tombstoned) can otherwise be resurrected here:
      // mergeArrayById() only sees "present on one side" vs "present on both", so a
      // stale client that still has the now-deleted record locally would win it back.
      const dead = recordTombstones[field];
      if (dead && dead.length && Array.isArray(mergedField)) {
        const deadIds = new Set(dead.map(t => t.id));
        mergedField = mergedField.filter(r => !(r && deadIds.has(r.id)));
      }
      merged[field] = mergedField;
    }
  }
  if (clientData.compGradeResults !== undefined || serverData.compGradeResults !== undefined) {
    merged.compGradeResults = mergeNestedObject(serverData.compGradeResults, clientData.compGradeResults);
  }
  const tombstones = mergeTombstones(serverData.roomReservationTombstones, clientData.roomReservationTombstones);
  merged.roomReservationTombstones = tombstones;
  if (tombstones.length && Array.isArray(merged.roomReservations)) {
    const deadIds = new Set(tombstones.map(t => t.id));
    merged.roomReservations = merged.roomReservations.filter(r => !deadIds.has(r.id));
  }
  return merged;
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
// companyId를 넘기면 그 회사에 연결된 클라이언트에게만 전송한다(다른 회사 사용자명·접속
// 여부·편집 잠금 상태가 노출되는 걸 막기 위함 — 멀티테넌트 전환 전에는 이 필터가 없어 붙어있는
// 모든 클라이언트에게 무조건 브로드캐스트했다). companyId를 생략하면(레거시 호출부 방어용
// 기본값) 기존처럼 전체 브로드캐스트한다 — JSON 파일 모드는 애초에 회사 구분이 없으므로 이
// 기본 동작이 곧 정상 동작이다.
function broadcastSSE(eventName, payload, excludeClientId = null, companyId = undefined) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  const scoped = companyId !== undefined ? _scopeKey(companyId) : null;
  for (const [cid, client] of Object.entries(_sseClients)) {
    if (cid === excludeClientId) continue;
    if (scoped !== null && client.companyId !== scoped) continue;
    try { client.res.write(msg); } catch {}
  }
}

// 2026-08-18: 예전에는 이 함수가 순수 동기 함수로 _activityLog(process 메모리 배열, 회사
// 구분 없는 단일 배열)에만 기록해, ① 서버가 재시작될 때마다(이 프로젝트는 재배포가 매우
// 잦음) 활동 이력이 전부 조용히 사라졌고, ② 회사 A의 관리자가 회사 B의 활동 로그(자유텍스트
// target/detail 포함)를 함께 볼 수 있었다 — DB 영속성 감사에서 둘 다 발견. 다른 위성 모듈
// (회계/ERP/RCPS 등)과 동일한 패턴으로 JSON 파일 모드는 원자적 파일 쓰기, Postgres 모드는
// activity_log 테이블(company_id로 스코프)에 영속화한다.
async function addActivityLog(entry, companyId = null) {
  const record = { ...entry, id: Date.now() + Math.random(), ts: new Date().toISOString() };
  if (USE_JSON_FILE) {
    _fileActivityLog.unshift(record);
    if (_fileActivityLog.length > MAX_ACTIVITY_LOGS)
      _fileActivityLog = _fileActivityLog.slice(0, MAX_ACTIVITY_LOGS);
    const activityFile = JSON_FILE.replace(/\.json$/, "-activity.json");
    try { _atomicWriteFileSync(activityFile, JSON.stringify(_fileActivityLog, null, 2)); }
    catch (e) { console.warn("[Storage] Could not write activity log file:", e.message); }
    return;
  }
  try {
    await pool.query(
      "INSERT INTO activity_log (company_id, data) VALUES ($1, $2)",
      [companyId, record]
    );
    // 이 회사의 최근 MAX_ACTIVITY_LOGS건만 남기고 오래된 행을 정리한다(경합이 있어도
    // 일시적으로 몇 건 더 남을 뿐, 다음 삽입에서 다시 정리되므로 안전하다).
    await pool.query(
      `DELETE FROM activity_log WHERE (company_id = $1 OR ($1 IS NULL AND company_id IS NULL))
       AND id NOT IN (
         SELECT id FROM activity_log WHERE (company_id = $1 OR ($1 IS NULL AND company_id IS NULL))
         ORDER BY created_at DESC LIMIT $2
       )`,
      [companyId, MAX_ACTIVITY_LOGS]
    );
  } catch (e) {
    console.warn("[DB] Could not persist activity log:", e.message);
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
// CSP는 끈다: 프론트엔드(public/index.html)가 인라인 onclick 핸들러와 인라인 <script>를
// 전면적으로 사용하는 구조라 기본 CSP를 켜면 앱 전체가 깨진다. 나머지 기본 보안 헤더
// (X-Content-Type-Options, X-Frame-Options, HSTS 등)만 적용한다.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "50mb" }));
app.use(authenticate);
app.use(express.static(path.join(__dirname, "public")));
// 사업계획(팀별 작성 → 사업부장 승인 → 예산담당자+기획팀장 최종확정) 워크플로우가
// 요청자의 dept/team을 알아야 해서, budget.js가 자체적으로 갖지 못하는 employees 조회를
// 이 접근자로 주입한다. loadData()는 함수 선언(호이스팅)이라 이 시점(아직 텍스트상으로는
// 뒤에 정의됨)에 참조해도 실제 실행은 요청이 들어온 뒤라 안전하다.
async function getEmployeeProfileForBudget(companyId, empId) {
  if (empId == null) return null;
  const data = await loadData(companyId);
  const emp = (data.employees || []).find(e => String(e.id) === String(empId));
  if (!emp) return null;
  return { dept: emp.dept || "", team: emp.team || "", role: emp.role, name: emp.name };
}
// 팀명 → 그 팀이 실제로 소속된 부문/사업부/센터를 재직자 dept 필드로 역산한다. 예산
// 업로드 엑셀의 "비용 귀속" 컬럼에 팀이 스스로의 이름을 적어두는 관행이 있어(예:
// "인사팀"이 자기 이름을 비용귀속으로 표기), 그걸 그대로 별도 조직 버킷으로 쓰면
// "인사팀"이 그 팀의 실제 상위 조직("경영지원본부")과 나란한 별개 항목으로 잡혀 사업부
// 롤업이 쪼개지는 문제가 있었다(사용자 보고: "인사팀이 별도로 있어서 중복 합산되는 것
// 같다"). 재직자 중 그 팀 소속(가능하면 재직중인 사람 우선)의 dept 최빈값을 그 팀의
// 실제 소속으로 본다.
async function getTeamDeptForBudget(companyId, team) {
  if (!team) return null;
  const data = await loadData(companyId);
  // 예산 엑셀의 "팀명" 컬럼 표기와 실제 재직자 테이블의 team 필드 표기가 "팀" 접미사
  // 유무만 다른 경우가 실사용 파일에서 확인됨(예: 엑셀엔 "인사", 재직자 team엔 "인사팀"
  // 또는 그 반대) — 정확히 일치하는 재직자가 없으면 "팀" 접미사만 정규화해 한 번 더 시도.
  const norm = s => String(s || "").trim().replace(/팀$/, "");
  let emps = (data.employees || []).filter(e => (e.team || "") === team);
  if (!emps.length) emps = (data.employees || []).filter(e => norm(e.team) === norm(team));
  if (!emps.length) return null;
  const active = emps.filter(e => e.active);
  const pool = active.length ? active : emps;
  const counts = {};
  pool.forEach(e => { if (e.dept) counts[e.dept] = (counts[e.dept] || 0) + 1; });
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
}
// 예산 엑셀 업로드(예산 시트·조직별 비용 블록) 처리 중 "비용계정"을 자동으로 채우기
// 위한 회사 계정과목 목록 조회 — GET /api/accounting/accounts/expense-lite와 동일한
// 필터(비용 계정만)·동일한 파일/DB 분기를 그대로 재사용한다(회계 모듈 전체를 열어주지
// 않고 코드/이름만 budget.js에 넘김).
async function getExpenseAccountsForBudget(companyId) {
  let accounts;
  if (USE_JSON_FILE) {
    accounts = _fileAccounting.accounts;
  } else {
    const { rows } = await pool.query(
      "SELECT id, data FROM accounts WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL) ORDER BY id",
      [companyId]
    );
    accounts = rows.map(r => ({ id: r.id, ...r.data }));
  }
  return accounts.filter(a => a.type === "expense" && a.active !== false).map(a => ({ code: a.code, name: a.name }));
}
// P0-4 방어(2026-08-19 외부 감사): GET /api/budget/emp-pay-plan/by-ids가 요청자가 보낸
// ids를 검증 없이 그대로 조회하고 있었다 — 화면(addBpEmpDetailRows())은 항상 자기 팀/부문
// 소속 id만 골라 보내지만, 그건 클라이언트가 스스로를 제약하는 것일 뿐 서버는 아무 값이나
// 받아들였다(실측: 회사 전체 employees의 id를 나열해 보내면 전 직원의 개인별 급여상세
// (RSU·인센티브 등)를 한 번에 열람 가능). 요청자별 dept/team을 함께 내려줘 budget.js가
// "관리자는 무제한, director는 같은 dept, 그 외(leader/member)는 같은 dept+team, 항상
// 본인은 허용"으로 걸러내도록 한다.
async function getEmployeeScopesForBudget(companyId, ids) {
  const data = await loadData(companyId);
  const byId = new Map((data.employees || []).map(e => [String(e.id), { dept: e.dept || "", team: e.team || "" }]));
  const out = {};
  for (const id of ids) { const e = byId.get(String(id)); if (e) out[String(id)] = e; }
  return out;
}
app.use("/api/budget", budgetRouterFactory({
  getEmployeeProfile: getEmployeeProfileForBudget, getTeamDept: getTeamDeptForBudget,
  getExpenseAccounts: getExpenseAccountsForBudget, getEmployeeScopes: getEmployeeScopesForBudget,
}));

// /login 브루트포스 방어: IP당 15분에 20회로 제한(정상 사용자가 실수로 몇 번 틀리는
// 정도는 통과시키되, 자동화된 무차별 대입 시도는 차단).
// skipSuccessfulRequests 없이는 "성공한" 로그인도 카운트에 포함돼, 같은 사무실
// 공인IP 뒤에서 20명 넘는 직원이 15분 안에 정상적으로 로그인만 해도(월요일 출근
// 시간대 등) 뒤늦게 로그인하는 직원들이 429로 막히는 문제가 있었다(부하 테스트
// 에이전트가 실측: 같은 IP에서 30명 동시 로그인 시 20명만 성공, 11명 429).
// 브루트포스 방어의 목적은 "틀린 비밀번호 시도" 횟수를 제한하는 것이지 정상
// 로그인 총량을 제한하는 게 아니므로, 성공한 요청은 카운트에서 제외한다.
// 주의: /login은 성공/실패 모두 HTTP 200으로 응답하고 결과는 JSON body의 `ok`
// 필드로만 구분한다. skipSuccessfulRequests의 기본 판정 기준(requestWasSuccessful)은
// statusCode<400 여부만 보므로, 그 기본값 그대로 두면 모든 로그인 시도(비밀번호가
// 틀려도)가 "성공"으로 취급돼 카운트에서 전부 빠지고 브루트포스 방어가 완전히
// 무력화된다(회귀 재검증 에이전트가 실측: 같은 계정에 틀린 비밀번호 60회 연속
// 시도해도 429가 한 번도 발생하지 않음). /login 라우트가 실제 결과에 따라 채워주는
// res.locals.loginOk를 판정 기준으로 사용해 진짜 성공만 카운트에서 제외한다.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.locals.loginOk === true,
  message: { ok: false, message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요." },
});

// ── Core API ──────────────────────────────────────────────────────────────────

// GET /status
// 인증이 필수가 아닌 라우트(부트스트랩 이전에도 호출돼야 함)라 companyId를 모를 수 있다 —
// 이미 로그인해 유효한 토큰을 보내는 호출은 그 회사로 스코프하고, 그렇지 않으면(레거시
// 단일 회사 배포·최초 부트스트랩 전 등) 기존처럼 전체 합계를 반환한다.
app.get("/status", async (req, res) => {
  try {
    const companyId = req.auth?.companyId || null;
    if (USE_JSON_FILE) {
      return res.json({
        ok: true,
        version: _getVersion(companyId),
        storageMode: "file",
        meta: {
          lastSaved: _getLastSaved(companyId),
          empCount:  (_fileStore.employees  || []).length,
          kpiCount:  (_fileStore.kpiEntries || []).length,
        },
        onlineCount: _onlineCountFor(companyId),
      });
    }
    const [empRes, kpiRes] = await Promise.all([
      companyId
        ? pool.query("SELECT COUNT(*) FROM employees  WHERE is_deleted = FALSE AND company_id = $1", [companyId])
        : pool.query("SELECT COUNT(*) FROM employees  WHERE is_deleted = FALSE"),
      companyId
        ? pool.query("SELECT COUNT(*) FROM kpi_entries WHERE is_deleted = FALSE AND company_id = $1", [companyId])
        : pool.query("SELECT COUNT(*) FROM kpi_entries WHERE is_deleted = FALSE"),
    ]);
    res.json({
      ok: true,
      version: _getVersion(companyId),
      storageMode: "postgresql",
      meta: {
        lastSaved:  _getLastSaved(companyId),
        empCount:   parseInt(empRes.rows[0].count),
        kpiCount:   parseInt(kpiRes.rows[0].count),
      },
      onlineCount: _onlineCountFor(companyId),
    });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// GET /data
app.get("/data", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const companyId = req.auth.companyId || null;
    const data = await loadData(companyId);
    res.json({ ok: true, data: filterDataForRole(stripPwField(data), req.auth), version: _getVersion(companyId) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// POST /api/employees/next-id — see _getNextEmployeeId() for why this exists.
app.post("/api/employees/next-id", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    res.json({ ok: true, id: await _getNextEmployeeId() });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 회사(테넌트) 식별 ────────────────────────────────────────────────────────
// 회사 코드(companies.slug)는 사람이 입력하므로 대소문자/공백 표기 차이를 흡수한다.
// 회사 가입(POST /api/companies/register)의 slug 생성과 로그인의 companyCode 조회 양쪽에서
// 동일한 정규화를 거쳐야 "가입 시 만든 코드로 로그인이 안 된다"는 불일치가 생기지 않는다.
function _slugify(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
// slug(회사 코드) → company_id. JSON 파일 모드는 companies 테이블 자체가 없는 단일 회사
// 배포판이라 항상 null(호출부에서 무시됨).
async function _resolveCompanyId(companyCode) {
  if (USE_JSON_FILE || !companyCode) return null;
  const { rows } = await pool.query("SELECT id FROM companies WHERE slug = $1", [_slugify(companyCode)]);
  return rows.length ? rows[0].id : null;
}

// Verifies loginId/pw against server-stored (hashed or legacy-plaintext) records,
// scoped to a single company (companyId is a companies.id UUID in Postgres/SaaS
// mode, or null in JSON file mode where there's no company concept at all).
// Returns the matched employee (without pw) on success, or null on failure —
// null covers "company not found", "loginId not found", and "wrong password"
// alike, on purpose (계정 존재 여부를 추측할 수 없게 동일한 실패로 처리).
async function verifyCredentials(companyId, loginId, pw) {
  if (!loginId || !pw) return null;
  if (!USE_JSON_FILE && !companyId) return null; // Postgres/SaaS 모드는 회사가 반드시 있어야 함
  const data = await loadData(companyId);
  const emp = (data.employees || []).find(e => e.loginId === loginId && e.active);
  if (!emp || !emp.pw) return null;
  const valid = isHashedPw(emp.pw) ? await bcrypt.compare(pw, emp.pw) : emp.pw === pw;
  if (!valid) return null;
  return omitPw(emp);
}

// POST /login — verifies credentials against server-stored (hashed) passwords
// without exposing any employee's password hash to the client. If the account
// has 2FA enabled, a valid `otp` must also be supplied in the same request
// (stateless — no server-side session between the password and OTP steps).
// Postgres/SaaS 모드는 이제 companyCode(회사 코드, companies.slug)가 필수다 — 로그인이
// 이제 "회사 안에서" loginId/비밀번호를 검증하는 구조로 바뀌었기 때문(과거엔 loginId가
// 서버 전체에서 유일하다고 가정했음). JSON 파일 모드(단일 회사 자체 호스팅)는 companyCode를
// 아예 요구하지 않고 기존 그대로 동작한다.
app.post("/login", loginLimiter, async (req, res) => {
  // /login always answers with HTTP 200 (success/failure both live in the JSON body's
  // `ok` field, since that's what the client checks) — loginLimiter's
  // skipSuccessfulRequests relies on requestWasSuccessful, whose default just checks
  // `statusCode < 400`, so every attempt (right password or wrong) looked "successful"
  // and the brute-force counter never incremented at all. res.locals.loginOk lets
  // requestWasSuccessful (below) key off the real outcome instead of the status code.
  res.locals.loginOk = false;
  try {
    const { companyCode, loginId, pw, otp } = req.body || {};
    if (USE_JSON_FILE) {
      if (!loginId || !pw) return res.status(400).json({ ok: false, message: "아이디와 비밀번호를 입력하세요." });
    } else {
      if (!companyCode || !loginId || !pw) return res.status(400).json({ ok: false, message: "회사 코드, 아이디, 비밀번호를 입력하세요." });
    }
    // 회사를 못 찾아도(companyId === null) 여기서 바로 끊지 않고 verifyCredentials까지
    // 그대로 흘려보낸다 — "회사 없음"과 "아이디/비밀번호 틀림"을 같은 실패 메시지로
    // 응답해 계정·회사 존재 여부를 추측할 수 없게 하기 위함.
    const companyId = USE_JSON_FILE ? null : await _resolveCompanyId(companyCode);
    const employee = await verifyCredentials(companyId, loginId, pw);
    if (!employee) return res.json({ ok: false, message: "아이디 또는 비밀번호가 올바르지 않습니다." });
    if (employee.twoFactorEnabled) {
      if (!otp) { res.locals.loginOk = true; return res.json({ ok: true, requireOtp: true }); }
      const data = await loadData(companyId);
      const raw = (data.employees || []).find(e => e.loginId === loginId && e.active);
      if (!raw || !raw.twoFactorSecret || !totpVerify(raw.twoFactorSecret, otp))
        return res.json({ ok: false, requireOtp: true, message: "인증 코드가 올바르지 않습니다." });
    }
    // 서버가 실제로 검증한 계정 정보로만 토큰을 발급한다(클라이언트가 보낸 role은 무시).
    // authVersion을 함께 실어 매 요청마다 authenticate()가 "그 사이 role/pw/active가
    // 바뀌지 않았는지" 대조할 수 있게 한다(P0-5, _nextAuthVersion 주석 참고).
    const token = signToken({ empId: employee.id, loginId: employee.loginId, role: employee.role, companyId, authVersion: employee.authVersion || 0 });
    res.locals.loginOk = true;
    res.json({ ok: true, employee, token });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// 전체 employees 배열을 받는 레거시 /save에서는 일반 사용자가 role·권한·타인 계정을
// 바꿀 수 없도록 서버 저장본을 보존한다. 따라서 비밀번호 변경은 이처럼 현재 계정만
// 서버에서 읽고 검증·갱신하는 전용 경로로 처리한다.
app.post("/api/auth/change-password", loginLimiter, async (req, res) => {
  res.locals.loginOk = false;
  if (!requireAuth(req, res)) return;
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== "string" || typeof newPassword !== "string" ||
      Buffer.byteLength(newPassword, "utf8") < 8 || Buffer.byteLength(newPassword, "utf8") > 128) {
    return res.status(400).json({ ok: false, code: "INVALID_PASSWORD", message: "새 비밀번호는 8~128자여야 합니다." });
  }
  try {
    const companyId = req.auth.companyId || null;
    const stored = await loadData(companyId);
    const current = (stored.employees || []).find(e => String(e.id) === String(req.auth.empId) && e.active);
    const valid = current && current.pw && (isHashedPw(current.pw)
      ? await bcrypt.compare(currentPassword, current.pw)
      : currentPassword === current.pw);
    if (!valid) return res.status(403).json({ ok: false, code: "CURRENT_PASSWORD_INVALID", message: "현재 비밀번호가 올바르지 않습니다." });

    const now = new Date().toISOString();
    const nextPasswordHash = await hashPlaintextPw(newPassword);
    const nextData = {
      ...stored,
      employees: stored.employees.map(e => String(e.id) === String(current.id)
        ? { ...e, pw: nextPasswordHash, updatedAt: now }
        : e),
    };
    await persistData(nextData, `auth:${req.auth.loginId || req.auth.empId}`, companyId, req.auth);
    const refreshed = (await loadData(companyId)).employees.find(e => String(e.id) === String(current.id));
    const token = signToken({
      empId: refreshed.id, loginId: refreshed.loginId, role: refreshed.role,
      companyId, authVersion: Number(refreshed.authVersion || 0),
    });
    res.locals.loginOk = true;
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ ok: false, code: "PASSWORD_CHANGE_FAILED", message: _safeErrMsg(e) });
  }
});

// ── 2단계 인증(TOTP) 설정 ──────────────────────────────────────────────────────
// 1) generate-secret: 비밀번호 재확인 후 새 시크릿 발급(아직 미저장 — 클라이언트가
//    인증 앱에 등록하고 코드로 검증 성공해야 emp.twoFactorSecret/Enabled로 저장됨)
// /login과 동일하게 verifyCredentials()로 비밀번호를 직접 검증하는 엔드포인트인데
// loginLimiter가 없어, /login에는 20회/15분 제한이 걸려도 이 라우트로는 같은 계정 비밀번호를
// 무제한 추측할 수 있었다(실측: 틀린 비밀번호 25회 연속 시도해도 429 없이 전부 즉시 403).
// /login과 동일한 loginLimiter를 재사용해 같은 IP의 시도를 함께 카운트한다.
// companyId: 이 라우트는 보통 이미 로그인된 사용자가 본인 계정에 2FA를 설정하려고
// 비밀번호를 재확인하는 흐름이라(설정 화면 진입 자체가 로그인 후이므로) 이미 붙어있는
// Authorization 토큰의 companyId를 우선 사용하고, 없으면(레거시 호출) body의 companyCode로
// 보조한다 — /login과 달리 프런트엔드가 아직 companyCode를 body에 채워 보내도록 갱신되지
// 않았어도 로그인된 세션에서는 그대로 동작한다.
app.post("/api/auth/2fa/generate-secret", loginLimiter, async (req, res) => {
  res.locals.loginOk = false;
  try {
    const { loginId, pw, companyCode } = req.body || {};
    const companyId = USE_JSON_FILE ? null : (req.auth?.companyId || await _resolveCompanyId(companyCode));
    const employee = await verifyCredentials(companyId, loginId, pw);
    if (!employee) return res.status(403).json({ ok: false, message: "비밀번호가 올바르지 않습니다." });
    res.locals.loginOk = true;
    const secret = generateTotpSecret();
    const otpauthUrl = `otpauth://totp/HR-ERP:${encodeURIComponent(loginId)}?secret=${secret}&issuer=HR-ERP`;
    res.json({ ok: true, secret, otpauthUrl });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});
// 2) verify-code: 설정 확인 및 로그인 화면에서의 순수 코드 검증(상태 없음)에 공용으로 사용
app.post("/api/auth/2fa/verify-code", async (req, res) => {
  try {
    const { secret, otp } = req.body || {};
    if (!secret || !otp) return res.status(400).json({ ok: false, message: "secret과 otp가 필요합니다." });
    res.json({ ok: totpVerify(secret, otp) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 셀프서브 회사 가입 ──────────────────────────────────────────────────────────
// 최소 loginLimiter(IP당 15분/20회)만큼, 계획 문서 지침대로 더 엄격하게 IP당 1시간/10회로
// 제한한다 — 앱스토어 유통 특성상 여러 사용자가 통신사 NAT 뒤에서 같은 공인 IP를 공유할 수
// 있어 정상 사용자를 과도하게 막지 않으면서도 자동화된 정크 회사 생성을 억제하는 값이다.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." },
});

// POST /api/companies/register — 셀프서브 회사 가입. 유일하게 인증 없이 쓰기가 허용되는
// 경로다 — 과거 POST /save의 "직원이 0명이면 인증 없이 1회 허용"하던 부트스트랩 예외가
// 이 역할을 대신했지만, 두 번째 회사가 가입하는 순간 "서버에 직원이 0명 = 아직 아무도
// 안 만든 최초 상태"라는 가정 자체가 깨지므로(이미 다른 회사가 얼마든지 존재할 수 있음)
// 그 예외는 완전히 폐기했다(_employeesEmpty()/POST /save 주석 참고). Postgres/SaaS 전용 —
// companies 테이블이 아예 없는 JSON 파일 모드(자체 호스팅, 항상 단일 회사)에서는 이 개념
// 자체가 필요 없다.
//
// 회사 생성 → 관리자 1명 생성 → 토큰 발급까지 하나의 DB 트랜잭션 안에서 처리해 "회사는
// 만들어졌는데 관리자 계정이 없어 아무도 로그인할 수 없는" 반쪽짜리 상태가 남지 않게 한다.
app.post("/api/companies/register", registerLimiter, async (req, res) => {
  if (USE_JSON_FILE) {
    return res.status(400).json({ ok: false, message: "이 서버는 단일 회사 자체 호스팅 모드로 동작 중이라 회사 가입을 지원하지 않습니다." });
  }
  try {
    const { companyName, companyCode, adminName, loginId, password } = req.body || {};
    if (!companyName || !adminName || !loginId || !password) {
      return res.status(400).json({ ok: false, message: "회사명, 관리자 이름, 아이디, 비밀번호를 모두 입력하세요." });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ ok: false, message: "비밀번호는 8자 이상이어야 합니다." });
    }
    const baseSlug = _slugify(companyCode || companyName);
    if (!baseSlug) {
      return res.status(400).json({ ok: false, message: "회사 코드로 사용할 수 있는 문자가 없습니다(영문/숫자/한글을 포함해주세요)." });
    }

    // employees.id는 회사와 무관하게 여전히 전역 유일 시퀀스다(설계상 결정 — id 자체를
    // 복합키로 바꾸는 대규모 리라이트를 피하기 위함, 계획 문서 참고). 트랜잭션 밖에서 먼저
    // 발급받아도 안전하다(_getNextEmployeeId 자체가 원자적 증가라 이 트랜잭션의 성공 여부와
    // 무관하게 독립적으로 유효하다 — 트랜잭션이 실패하면 그 번호는 그냥 비게 될 뿐이다).
    const empId = await _getNextEmployeeId();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // 같은 baseSlug로 거의 동시에 가입 요청이 들어오면 아래 "빈 slug 찾기" 루프가
      // 레이스 컨디션을 겪을 수 있어(둘 다 "company-2"가 비어있다고 보고 동시에 시도) advisory
      // lock으로 같은 baseSlug의 가입 시도를 트랜잭션 안에서 직렬화한다.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`company-register:${baseSlug}`]);

      let slug = baseSlug, suffix = 1;
      for (;;) {
        const { rows } = await client.query("SELECT 1 FROM companies WHERE slug = $1", [slug]);
        if (!rows.length) break;
        suffix += 1;
        slug = `${baseSlug}-${suffix}`;
        if (suffix > 50) throw new Error("사용 가능한 회사 코드를 찾지 못했습니다. 다른 회사명을 입력해주세요.");
      }

      const companyRes = await client.query(
        "INSERT INTO companies (slug, name, status) VALUES ($1,$2,'trial') RETURNING id, slug, name, status",
        [slug, companyName]
      );
      const company = companyRes.rows[0];

      // 4단계(accounts/erp_locations에 company_id 적용)로 이 두 테이블도 회사별로 격리됐다 —
      // 예전엔 initDB()가 서버 최초 가동 시 전역으로 1회만 시딩했지만(위 initDB() 주석 참고),
      // 이제 그 전역 시딩은 구조적으로 불가능해져 제거됐다. 그 대신 회사가 새로 가입할 때마다
      // 이 트랜잭션 안에서 기초 계정과목/위치를 함께 시딩한다.
      const now = new Date().toISOString();
      const pwHash = await hashPlaintextPw(password);
      const adminEmp = {
        id: empId, loginId, pw: pwHash, name: adminName, empNo: "A001", role: "admin",
        dept: "", team: "", birth: "", gender: "", hire: now.slice(0, 10), retireDate: "", retireReason: "",
        jobGroup: "", rank: "", rankYear: 0, salary: 0, edu: "", eduSchool: "", totalCareer: 0,
        active: true, position: "", email: "", phone: "", address: "", customFields: {},
        careers: [], hrHistory: [], gradeResults: {}, createdAt: now, updatedAt: now, authVersion: 0,
      };
      await client.query(
        "INSERT INTO employees (id, data, company_id) VALUES ($1,$2,$3)",
        [String(empId), adminEmp, company.id]
      );
      await client.query(
        "INSERT INTO employee_history (employee_id, action, changed_by, data, company_id) VALUES ($1,'insert',$2,$3,$4)",
        [String(empId), "company-register", adminEmp, company.id]
      );
      await _seedCompanyDefaults(client, company.id);

      await client.query("COMMIT");

      // 서버가 방금 생성·검증한 값으로만 토큰을 발급한다(클라이언트가 보낸 role 등은 무시 —
      // 이 세션 전체에 이미 적용된 하드닝 기조와 동일).
      const token = signToken({ empId: adminEmp.id, loginId: adminEmp.loginId, role: adminEmp.role, companyId: company.id, authVersion: 0 });
      console.log(`[Companies] 신규 회사 가입: ${company.name} (slug=${company.slug}, id=${company.id})`);
      res.json({
        ok: true,
        company: { id: company.id, slug: company.slug, name: company.name, status: company.status },
        // companyCode를 최상위 필드로도 함께 내려준다 — 클라이언트(public/index.html의
        // submitCompanyRegister(), 별도 세션에서 동시 구현됨)가 응답의 slug를 그대로
        // 안내하는 대신 계획 문서 필드명 그대로 r.companyCode를 읽어 로컬 캐시(다음
        // 로그인 화면에 자동 채움)에 저장하도록 이미 작성돼 있어, company.slug 하나만
        // 내려주면 회사명에서 자동 생성됐거나(-2 접미사 등) 사용자가 입력한 것과 실제
        // 배정된 코드가 달라졌을 때 사용자가 그 코드를 알 방법이 없어진다.
        companyCode: company.slug,
        employee: omitPw(adminEmp),
        token,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    res.status(500).json({ ok: false, message: _safeErrMsg(e) });
  }
});

// ── 마스터 관리자(플랫폼 운영자) ──────────────────────────────────────────────
// 계획 문서 "마스터 관리자 + 회사별 기능 커스터마이징" 참고 — company_id/토큰 설계(1단계)
// 위에 얹는 후속 단계다. 완전히 SaaS(Postgres) 전용 개념이라 JSON 파일 모드(자체 호스팅,
// 항상 단일 회사)에서는 /master/* 전부 명시적으로 거부한다 — POST /api/companies/register가
// 쓰는 것과 동일한 가드 패턴을 그대로 따른다.
function _requireSaas(req, res) {
  if (USE_JSON_FILE) {
    res.status(400).json({ ok: false, message: "이 서버는 단일 회사 자체 호스팅 모드로 동작 중이라 마스터 관리자 기능을 지원하지 않습니다." });
    return false;
  }
  return true;
}
// companies.id는 UUID 컬럼이라, req.params.id가 UUID 형식이 아닌 채로 그대로
// pool.query에 넘기면 Postgres가 "invalid input syntax for type uuid"로 예외를
// 던져 의도한 404(존재하지 않는 회사) 대신 500이 나간다(실측 확인). 형식이 애초에
// UUID가 아니면 DB를 조회할 것도 없이 "존재하지 않는 회사"와 동일하게 404로
// 응답한다 — 아래 /master/companies/:id/* 라우트 3곳 모두에서 사용.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function _requireValidCompanyIdParam(req, res) {
  if (!UUID_RE.test(req.params.id)) {
    res.status(404).json({ ok: false, message: "존재하지 않는 회사입니다." });
    return false;
  }
  return true;
}

// requireAdmin/requireRole과 동일한 시그니처·반환 컨벤션(성공 시 true, 실패 시 이 함수가
// 직접 res.status(...).json(...)을 쓰고 false를 반환)을 그대로 따른다. role==='master'인
// 토큰만 통과시킨다 — 회사 로그인(POST /login, POST /api/companies/register)이 발급하는
// 토큰은 role이 'admin'/'leader'/'director'/'member' 중 하나일 뿐 절대 'master'가 될 수
// 없으므로(아래 두 라우트의 signToken 호출부 참고), 위조되거나 impersonation으로 얻은 회사
// 토큰(role:'admin')으로 이 관문을 통과할 방법이 애초에 없다 — 새 우회 경로를 만들지 않기
// 위해 requireMaster는 requireAdmin과 별개로 role 문자열만 비교한다.
function requireMaster(req, res) {
  if (!requireAuth(req, res)) return false;
  if (req.auth.role !== "master") {
    res.status(403).json({ ok: false, message: "마스터 관리자만 사용할 수 있습니다." });
    return false;
  }
  return true;
}

// /login과 동일한 이유로 전용 rate limiter가 필요하다(이 라우트도 항상 HTTP 200으로
// 응답하고 성공/실패는 JSON body의 `ok`로만 구분하므로, express-rate-limit의 기본
// 성공 판정(statusCode<400)을 그대로 쓰면 브루트포스 방어가 무력화된다 — /login에 있는
// 것과 동일한 문제, res.locals.masterLoginOk로 실제 결과를 판정 기준에 연결한다).
// /login과는 별도의 카운터를 쓴다(loginLimiter를 공유하면 같은 IP에서 회사 로그인
// 실패를 반복한 사용자가 마스터 로그인 시도 자체를 못 하게 되는 등 서로 다른 두
// 자격증명 체계의 실패가 하나의 카운터에 섞이는 게 부적절하다고 판단).
// ── TEMPORARY — 오늘 잦은 회사코드 오타(printrobo 사고 등과 무관, 이번엔 "tirautech"를
// "thirautech"로 바로잡는 요청)에 대응하기 위한 1회성 유틸리티. 이전 fix-company-name과
// 동일한 보안 패턴(x-migration-secret 404 게이트). 완료 확인 즉시 제거할 것.
app.post("/admin/fix-company-slug", async (req, res) => {
  if (!process.env.MIGRATION_ADMIN_SECRET || req.headers["x-migration-secret"] !== process.env.MIGRATION_ADMIN_SECRET) {
    return res.status(404).end();
  }
  const oldSlug = (req.body && req.body.oldSlug || "").trim();
  const newSlug = (req.body && req.body.newSlug || "").trim();
  if (!oldSlug || !newSlug) return res.status(400).json({ ok: false, message: "oldSlug, newSlug required" });
  if (req.body.confirm !== true) return res.status(400).json({ ok: false, message: "confirm:true 가 명시적으로 필요합니다." });
  try {
    const dup = await pool.query(`SELECT 1 FROM companies WHERE slug = $1`, [newSlug]);
    if (dup.rows.length) return res.status(409).json({ ok: false, message: `slug "${newSlug}" 는 이미 사용 중입니다.` });
    const result = await pool.query(
      `UPDATE companies SET slug = $1 WHERE slug = $2 RETURNING id, slug, name`,
      [newSlug, oldSlug]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, message: "해당 slug의 회사를 찾을 수 없습니다." });
    res.json({ ok: true, company: result.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── TEMPORARY — 테넌트 격리 의심 사례(다른 회사 토큰으로 GET /data 호출 시
// payrollAdjustments/boardPosts/roomReservations 등에 다른 회사 실데이터로 보이는 값이
// 섞여 나온다는 사용자 제보) 진단용 읽기 전용 엔드포인트. app_collections는 오늘 복합 PK
// (company_id, collection, id)로 전환 완료돼 company_id가 구조적으로 NULL일 수 없으므로,
// 서버 조회 로직(엄격한 WHERE company_id=$1)이 실제로 다른 회사 행을 잘못 반환하는 건지,
// 아니면 그 행 자체가 이미 (쓰기 시점에) 특정 회사 소유로 잘못 기록된 것인지(클라이언트가
// 회사 전환 시 이전 회사의 로컬 캐시를 지우지 않고 재전송했을 가능성)를 실제 데이터로
// 구분하기 위해 추가. 완료 확인 즉시 제거할 것.
app.get("/admin/inspect-collection", async (req, res) => {
  if (!process.env.MIGRATION_ADMIN_SECRET || req.headers["x-migration-secret"] !== process.env.MIGRATION_ADMIN_SECRET) {
    return res.status(404).end();
  }
  const collection = req.query.collection;
  if (!collection) return res.status(400).json({ ok: false, message: "collection required" });
  try {
    const { rows } = await pool.query(
      `SELECT ac.id, ac.company_id, c.slug AS company_slug, c.name AS company_name,
              ac.created_at, ac.updated_at, ac.data
       FROM app_collections ac
       LEFT JOIN companies c ON c.id = ac.company_id
       WHERE ac.collection = $1
       ORDER BY ac.updated_at DESC
       LIMIT 200`,
      [collection]
    );
    const nullCompanyCount = await pool.query(
      `SELECT COUNT(*)::bigint AS c FROM app_collections WHERE collection = $1 AND company_id IS NULL`,
      [collection]
    );
    res.json({ ok: true, collection, totalReturned: rows.length, nullCompanyIdCount: Number(nullCompanyCount.rows[0].c) || 0, rows });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── TEMPORARY — 위 inspect-collection으로 확인된 test 회사의 오염 데이터(티라유텍
// app_collections 전체 21건이 test 가입 순간 클라이언트 로컬캐시 재전송으로 그대로
// 복제됨) 정리용. company_id 하나로 지정한 회사의 app_collections 행 전체를 지운다
// (그 회사가 아직 자체 데이터가 없는 순수 테스트/오염 상태일 때만 안전 — 사용 전 반드시
// inspect-collection으로 내용 확인 후 진행). 완료 확인 즉시 제거할 것.
app.post("/admin/purge-company-collections", async (req, res) => {
  if (!process.env.MIGRATION_ADMIN_SECRET || req.headers["x-migration-secret"] !== process.env.MIGRATION_ADMIN_SECRET) {
    return res.status(404).end();
  }
  const companySlug = (req.body && req.body.companySlug || "").trim();
  if (!companySlug) return res.status(400).json({ ok: false, message: "companySlug required" });
  if (req.body.confirm !== true) return res.status(400).json({ ok: false, message: "confirm:true 가 명시적으로 필요합니다." });
  try {
    const companyRes = await pool.query(`SELECT id, name FROM companies WHERE slug = $1`, [companySlug]);
    if (!companyRes.rows.length) return res.status(404).json({ ok: false, message: "해당 slug의 회사를 찾을 수 없습니다." });
    const companyId = companyRes.rows[0].id;
    const del = await pool.query(`DELETE FROM app_collections WHERE company_id = $1`, [companyId]);
    res.json({ ok: true, companySlug, companyId, deletedRows: del.rowCount });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

const masterLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.locals.masterLoginOk === true,
  message: { ok: false, message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요." },
});

// POST /master/login — {loginId, password}. companyCode가 없다: 마스터는 특정 회사에
// 속하지 않는 플랫폼 운영자 계정이라 회사 스코프 자체가 없다(platform_admins는
// employees와 완전히 분리된 테이블, 셀프서브 가입 없음 — 계정은 항상 SQL로 직접
// 발급, scripts/seed-master-admin.js 참고). 성공 시 발급하는 토큰의 payload 모양
// ({masterId, loginId, role:'master'})은 회사 토큰({empId, loginId, role, companyId})과
// 겹치는 필드가 없어(companyId/empId 부재) requireMaster가 role 문자열만 봐도 안전하다.
app.post("/master/login", masterLoginLimiter, async (req, res) => {
  res.locals.masterLoginOk = false;
  if (!_requireSaas(req, res)) return;
  try {
    const { loginId, password } = req.body || {};
    if (!loginId || !password) return res.status(400).json({ ok: false, message: "아이디와 비밀번호를 입력하세요." });
    const { rows } = await pool.query("SELECT id, login_id, pw_hash, name FROM platform_admins WHERE login_id = $1", [loginId]);
    const admin = rows[0];
    // /login과 동일한 하드닝 기조: "아이디 없음"과 "비밀번호 틀림"을 구분하지 않는 동일한
    // 실패 메시지로 응답해 계정 존재 여부를 추측할 수 없게 한다. 항상 hashPlaintextPw()로
    // 해시된 값만 pw_hash에 들어간다는 것을 시딩 경로(scripts/seed-master-admin.js)에서
    // 보장하므로, employees.pw와 달리 레거시 평문 허용 분기 없이 bcrypt.compare만 쓴다.
    const valid = admin ? await bcrypt.compare(password, admin.pw_hash) : false;
    if (!admin || !valid) return res.json({ ok: false, message: "아이디 또는 비밀번호가 올바르지 않습니다." });
    res.locals.masterLoginOk = true;
    const token = signToken({ masterId: admin.id, loginId: admin.login_id, role: "master" });
    res.json({ ok: true, master: { id: admin.id, loginId: admin.login_id, name: admin.name }, token });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// GET /master/companies — 전 회사 목록 + 가벼운 통계(직원 수/KPI 건수, GET /status가
// 이미 쓰는 것과 동일한 집계 방식을 회사별로 한 번에 GROUP BY해 재사용).
app.get("/master/companies", async (req, res) => {
  if (!_requireSaas(req, res)) return;
  if (!requireMaster(req, res)) return;
  try {
    const { rows: companies } = await pool.query(
      "SELECT id, slug, name, status, created_at FROM companies ORDER BY created_at DESC"
    );
    const [{ rows: empCounts }, { rows: kpiCounts }] = await Promise.all([
      pool.query("SELECT company_id, COUNT(*) FROM employees  WHERE is_deleted = FALSE AND company_id IS NOT NULL GROUP BY company_id"),
      pool.query("SELECT company_id, COUNT(*) FROM kpi_entries WHERE is_deleted = FALSE AND company_id IS NOT NULL GROUP BY company_id"),
    ]);
    const empMap = Object.fromEntries(empCounts.map(r => [r.company_id, parseInt(r.count, 10)]));
    const kpiMap = Object.fromEntries(kpiCounts.map(r => [r.company_id, parseInt(r.count, 10)]));
    res.json({
      ok: true,
      companies: companies.map(c => ({
        id: c.id, slug: c.slug, name: c.name, status: c.status, createdAt: c.created_at,
        empCount: empMap[c.id] || 0, kpiCount: kpiMap[c.id] || 0,
      })),
    });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// POST /master/companies/:id/impersonate — "이 회사로 들어가기". 계획 문서 설계 그대로:
// 새 인가 체계를 만들지 않고 1단계에서 이미 만든 회사 스코프 로직(모든 requireAuth/
// requireAdmin 라우트가 req.auth.companyId만 보고 동작)을 그대로 재사용한다 — 이 토큰이
// role:'admin'으로 발급되는 순간부터 나머지 100개 이상의 라우트는 이게 impersonation인지
// 실제 회사 admin 로그인인지 전혀 구분할 필요가 없다(actingAsMaster 필드는 감사 용도로만
// 쓰인다, 위 POST /save의 changedBy 보강 참고). 감사 로그 기록이 실패하면(예: DB 순단)
// 토큰 발급 자체도 실패해야 한다는 계획 문서 요구사항에 따라, INSERT를 signToken() 호출보다
// 먼저 실행하고 실패 시 그대로 예외를 던져(catch에서 500) 토큰을 절대 내주지 않는다.
app.post("/master/companies/:id/impersonate", async (req, res) => {
  if (!_requireSaas(req, res)) return;
  if (!requireMaster(req, res)) return;
  if (!_requireValidCompanyIdParam(req, res)) return;
  try {
    const companyId = req.params.id;
    const { rows } = await pool.query("SELECT id, slug, name FROM companies WHERE id = $1", [companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "존재하지 않는 회사입니다." });
    const company = rows[0];

    await pool.query(
      "INSERT INTO master_audit_log (master_id, action, company_id, detail) VALUES ($1,'impersonate',$2,$3)",
      [req.auth.masterId, company.id, JSON.stringify({ masterLoginId: req.auth.loginId, companySlug: company.slug })]
    );

    // empId/loginId는 일부러 null — 이 토큰이 특정 직원 계정을 흉내내는 게 아니라 마스터가
    // "회사 관리자 권한으로" 들어가는 것임을 분명히 한다(그래도 role:'admin'이라 회사
    // 스코프 라우트는 정상 동작 — admin 권한이 필요한 대부분의 코드는 req.auth.role만 보지
    // empId가 실제 직원 레코드와 일치하는지는 요구하지 않는다). 1시간 만료로 세션 TTL을
    // 짧게 준다(기본 12시간보다 훨씬 민감한 권한이므로).
    const token = signToken(
      { empId: null, loginId: null, role: "admin", companyId: company.id, actingAsMaster: req.auth.masterId },
      60 * 60
    );
    res.json({ ok: true, company: { id: company.id, slug: company.slug, name: company.name }, token });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// company_features 조회 헬퍼 — 다른 라우트가 향후 점진적으로 도입할 수 있도록 만들어 둔다.
// 행이 없으면(대부분의 내장 모듈이 해당) 기본 true를 반환한다(하위호환 — 계획 문서 명시:
// "기존 내장 모듈은... 기본값 enabled=true, 기존 동작 그대로 유지"). 의도적으로 이번
// 세션에는 이 헬퍼를 기존 라우트(채용/회계/PMS 등 100개 이상)에 실제로 배선하지 않는다 —
// 그건 각 라우트마다 "이 기능이 꺼져 있으면 403" 분기를 새로 넣는 별도의 큰 작업이라
// 위험도가 다르고, 이번 작업 범위(마스터 계층의 데이터 모델 + API)를 벗어난다. 커밋
// 메시지에도 동일하게 명시.
async function isFeatureEnabled(companyId, featureKey) {
  if (USE_JSON_FILE || !companyId) return true;
  const { rows } = await pool.query(
    "SELECT enabled FROM company_features WHERE company_id = $1 AND feature_key = $2",
    [companyId, featureKey]
  );
  return rows.length ? rows[0].enabled : true;
}

// GET /master/companies/:id/features — 그 회사의 feature_key별 설정 전체.
app.get("/master/companies/:id/features", async (req, res) => {
  if (!_requireSaas(req, res)) return;
  if (!requireMaster(req, res)) return;
  if (!_requireValidCompanyIdParam(req, res)) return;
  try {
    const companyId = req.params.id;
    const { rows: companyRows } = await pool.query("SELECT id FROM companies WHERE id = $1", [companyId]);
    if (!companyRows.length) return res.status(404).json({ ok: false, message: "존재하지 않는 회사입니다." });
    const { rows } = await pool.query(
      "SELECT feature_key, enabled, config, updated_at FROM company_features WHERE company_id = $1 ORDER BY feature_key",
      [companyId]
    );
    res.json({
      ok: true,
      features: rows.map(r => ({ featureKey: r.feature_key, enabled: r.enabled, config: r.config, updatedAt: r.updated_at })),
    });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// PUT /master/companies/:id/features/:key — {enabled, config?}. upsert + 감사 로그.
app.put("/master/companies/:id/features/:key", async (req, res) => {
  if (!_requireSaas(req, res)) return;
  if (!requireMaster(req, res)) return;
  if (!_requireValidCompanyIdParam(req, res)) return;
  try {
    const companyId = req.params.id;
    const featureKey = req.params.key;
    const { enabled, config } = req.body || {};
    if (typeof enabled !== "boolean")
      return res.status(400).json({ ok: false, message: "enabled(boolean)는 필수입니다." });
    const { rows: companyRows } = await pool.query("SELECT id FROM companies WHERE id = $1", [companyId]);
    if (!companyRows.length) return res.status(404).json({ ok: false, message: "존재하지 않는 회사입니다." });

    const { rows } = await pool.query(
      `INSERT INTO company_features (company_id, feature_key, enabled, config, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (company_id, feature_key) DO UPDATE SET enabled = $3, config = $4, updated_at = NOW()
       RETURNING feature_key, enabled, config, updated_at`,
      [companyId, featureKey, enabled, config || {}]
    );
    await pool.query(
      "INSERT INTO master_audit_log (master_id, action, company_id, detail) VALUES ($1,'feature_toggle',$2,$3)",
      [req.auth.masterId, companyId, JSON.stringify({ featureKey, enabled, config: config || {} })]
    );
    const row = rows[0];
    res.json({ ok: true, feature: { featureKey: row.feature_key, enabled: row.enabled, config: row.config, updatedAt: row.updated_at } });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// 완전히 새로 배포된 서버는 직원이 0명이라 아무도 /login으로 토큰을 발급받을 수 없다
// (프론트엔드의 최초 admin 로그인은 클라이언트에 내장된 샘플 계정으로 로컬에서만
// 이뤄지고, 그 계정 데이터를 서버에 처음 올리는 것이 바로 이 /save 호출이기 때문).
// JSON 파일 모드(자체 호스팅, 항상 단일 회사)는 이 부트스트랩 예외를 아래 POST /save에서
// 여전히 그대로 사용한다. Postgres/SaaS 모드는 "서버에 직원이 0명 = 아직 아무도 안 만든
// 최초 상태"라는 가정이 두 번째 회사가 가입하는 순간 깨지므로(이미 다른 회사가 얼마든지
// 존재할 수 있음) 이 함수를 부트스트랩 예외의 근거로 더 이상 쓰지 않는다 — 최초 회사/관리자
// 계정 생성은 이제 POST /api/companies/register가 전담한다(아래 참고).
async function _employeesEmpty() {
  if (USE_JSON_FILE) return (_fileStore.employees || []).length === 0;
  const { rows } = await pool.query("SELECT COUNT(*) FROM employees WHERE is_deleted = FALSE");
  return parseInt(rows[0].count, 10) === 0;
}
// P0-3 방어(2026-08-19 외부 감사): JSON 파일 모드의 부트스트랩 예외(직원 0명일 때 POST
// /save를 무인증으로 1회 허용)는 로컬/사내망 전용 자체호스팅을 전제로 설계됐다 — 최초
// 배포 직후 곧바로 관리자 계정을 만들어 올릴 수 있어야 하기 때문. 그런데 같은 서버가
// 인터넷에 노출된 채로 "배포 완료~관리자가 처음 로그인하기 전" 사이의 짧은 창에 공격자가
// 먼저 이 요청을 보내면, 공격자가 만든 계정이 최초 admin이 되어 서버 전체를 선점당할 수
// 있다(부트스트랩 자체는 role/employees 어떤 값이든 검증 없이 받아들이므로) — 실측 가능한
// 취약점.
//
// BOOTSTRAP_SECRET 환경변수를 설정한 배포에 한해서만(opt-in) 이 요청에 X-Bootstrap-Secret
// 헤더로 같은 값을 실어 보내야만 부트스트랩을 허용하도록 강제한다. NODE_ENV=production
// 여부와 무관하게 오직 "이 값을 설정했는지"만으로 켜지는 이유: (1) 이 취약점은 JSON 파일
// (자체호스팅) 모드에만 있고, 이 저장소의 실제 운영 배포는 Postgres/SaaS 모드라 애초에
// 이 코드 경로를 타지 않는다 — 즉 이 서버 자신의 실제 서비스에는 영향이 없는 방어다.
// (2) demo-data 게이트(rejectDemoDataForProduction)처럼 NODE_ENV=production이면 자동으로
// 켜지게 만들면, 이미 배포돼 있던 자체호스팅 인스턴스가 이 커밋을 반영해 재배포되는
// 순간(운영자가 이 신규 요구사항을 미처 모른 채) 최초 관리자 계정을 만들 방법이 갑자기
// 사라지는 회귀가 된다 — 보안 강화를 원하는 운영자가 능동적으로 이 값을 설정해야만
// 적용되는 opt-in 방식이 자체호스팅 zero-config 기본 경험을 깨지 않으면서 원하는 사람에게는
// 실제 보호를 제공한다.
function _bootstrapSecretMatches(req) {
  const secret = process.env.BOOTSTRAP_SECRET;
  const provided = req.headers["x-bootstrap-secret"];
  if (!secret || typeof provided !== "string") return false;
  const a = Buffer.from(secret), b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// POST /save
function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// P1-3: 운영 더미 데이터 차단. public/index.html의 generateDummyData()/
// execGenerateDummy()(관리자 화면 버튼으로 가짜 직원·KPI를 즉시 employees/kpiEntries에
// push하던 기능)는 브라우저 소스에서 완전히 제거했지만, 오래된 캐시된 페이지나
// DevTools 콘솔에서 과거 코드를 그대로 실행해 demo 마커가 붙은 레코드를 그대로
// /save로 보내는 경로까지는 UI 제거만으로 막을 수 없다 — 이게 서버 쪽 마지막
// 방어선이다. 이제 더미 데이터를 만드는 유일한 정상 경로인 scripts/seed-demo.js
// (lib/demo-data.js)가 생성하는 레코드는 항상 source:"demo" 또는 empNo:"DEMO-..."
// 표식을 남기므로, 운영(NODE_ENV=production) 환경에서 그 표식이 하나라도 섞여
// 들어오면 저장 자체를 거부한다. ALLOW_DEMO_DATA=true로 명시적으로 풀지 않는 한
// 항상 켜져 있다 — NODE_ENV가 production이 아닌 자체호스팅/오프라인/개발 배포는
// 애초에 이 게이트 대상이 아니다(그런 환경엔 seed-demo.js를 정상적으로 쓸 수 있어야
// 하므로). 더미 마커가 없는 평범한 저장(기존 직원 삭제 포함)은 이 게이트와 무관하게
// 그대로 통과한다 — "새로 demo 마커가 붙은 레코드가 섞여 들어오는 저장"만 막는다.
// 레거시 패턴: P1-3 이전(lib/demo-data.js로 옮기기 전)의 브라우저 내장
// generateDummyData()는 empNo를 "DM"+부서/팀 초성 2글자+3자리 숫자로 만들었다
// (예: 경영지원본부/인사팀 → "DM경인001"). 지금 저장 경로는 항상 "DEMO-"만
// 남기지만, 그 이전에 만들어진 스냅샷/백업 파일이 복원되거나 그대로 DATA_FILE로
// 지정되는 경로까지 막으려면 이 옛 패턴도 함께 봐야 한다.
const LEGACY_DEMO_EMPNO_RE = /^DM[^\d]{1,4}\d{2,4}$/i;
function _isDemoMarkedEmployee(e) {
  return !!(e && (e.source === "demo" || /^DEMO-/i.test(String(e.empNo || "")) || LEGACY_DEMO_EMPNO_RE.test(String(e.empNo || ""))));
}
function rejectDemoDataForProduction(data) {
  if (process.env.NODE_ENV !== "production" || process.env.ALLOW_DEMO_DATA === "true") return;
  const demoEmployee = (data?.employees || []).find(_isDemoMarkedEmployee);
  // employees 쪽은 전부 정상(예: 실제 직원 위에 KPI만 데모 배치로 잘못 얹힌 경우)이어도
  // kpiEntries에 source:"demo"가 섞여 있으면 그 자체로 운영에 있어서는 안 되는 데이터다
  // — employees만 검사하면 이 "KPI만 더미" 케이스를 조용히 통과시켜버린다.
  const demoKpi = (data?.kpiEntries || []).find(k => k?.source === "demo");
  if (demoEmployee || demoKpi) {
    throw httpError(403, "DEMO_DATA_FORBIDDEN", "운영 환경에는 더미 데이터를 저장할 수 없습니다.");
  }
}

// 파일 모드의 최초 관리자 생성은 전체 state를 받는 /save가 아니라, 별도의 1회성
// bootstrap endpoint만 사용한다. 빈/손상 볼륨에서 외부 첫 요청자가 임의 admin과 전사
// 설정을 주입할 수 있었던 anonymous /save 예외를 제거한다.
const bootstrapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, code: "BOOTSTRAP_RATE_LIMITED", message: "초기화 시도가 너무 많습니다." },
});
function _validBootstrapSecret(req) {
  const expected = Buffer.from(process.env.BOOTSTRAP_SECRET || "", "utf8");
  const actual = Buffer.from(req.get("X-Bootstrap-Secret") || "", "utf8");
  return expected.length > 0 && actual.length === expected.length && crypto.timingSafeEqual(expected, actual);
}
function _validBootstrapAdmin({ loginId, name, pw }) {
  return /^[A-Za-z0-9._-]{3,64}$/.test(String(loginId || "")) &&
    String(name || "").trim().length >= 1 && String(name).trim().length <= 100 &&
    Buffer.byteLength(String(pw || ""), "utf8") >= 12 && Buffer.byteLength(String(pw || ""), "utf8") <= 128;
}
app.post("/api/bootstrap/admin", bootstrapLimiter, async (req, res) => {
  if (!USE_JSON_FILE) return res.status(404).json({ ok: false, code: "BOOTSTRAP_NOT_SUPPORTED" });
  if (!process.env.BOOTSTRAP_SECRET) {
    return res.status(503).json({ ok: false, code: "BOOTSTRAP_UNAVAILABLE", message: "BOOTSTRAP_SECRET이 설정되지 않았습니다." });
  }
  if (!_validBootstrapSecret(req)) {
    return res.status(401).json({ ok: false, code: "BOOTSTRAP_UNAUTHORIZED", message: "초기화 권한이 없습니다." });
  }
  const { loginId, name, pw } = req.body || {};
  if (!_validBootstrapAdmin({ loginId, name, pw })) {
    return res.status(400).json({ ok: false, code: "INVALID_BOOTSTRAP_INPUT", message: "초기 관리자 정보를 확인하세요." });
  }
  try {
    await _withSaveLock(async () => {
      if (!(await _employeesEmpty())) throw httpError(409, "ALREADY_INITIALIZED", "이미 초기화되었습니다.");
      const now = new Date().toISOString();
      const id = `admin_${crypto.randomUUID()}`;
      const state = await loadData(null);
      state.employees = [{
        id, loginId: String(loginId), name: String(name).trim(), empNo: "A001", role: "admin", active: true,
        pw: await hashPlaintextPw(String(pw)), authVersion: 0,
        dept: "", team: "", birth: "", gender: "", hire: now.slice(0, 10), retireDate: "", retireReason: "",
        jobGroup: "", rank: "", rankYear: 0, salary: 0, edu: "", eduSchool: "", totalCareer: 0,
        position: "", email: "", phone: "", address: "", customFields: {}, careers: [], hrHistory: [], gradeResults: {},
        createdAt: now, updatedAt: now,
      }];
      state.kpiEntries = Array.isArray(state.kpiEntries) ? state.kpiEntries : [];
      await _persistDataLocked(state, "bootstrap", null, { role: "admin", empId: id });
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    const status = Number.isInteger(e.status) ? e.status : 500;
    res.status(status).json({ ok: false, code: e.code, message: status < 500 ? e.message : "초기화하지 못했습니다." });
  }
});

app.post("/save", async (req, res) => {
  // 전체 상태를 받는 /save에는 예외를 두지 않는다. 빈 파일 모드의 최초 관리자는
  // BOOTSTRAP_SECRET을 요구하는 전용 /api/bootstrap/admin으로만 생성한다.
  if (!requireAuth(req, res)) return;
  const companyId = req.auth?.companyId || null;
  const body = req.body;
  if (!body || typeof body !== "object")
    return res.status(400).json({ ok: false, message: "잘못된 데이터" });

  // getFullState() sends { _version, _action, data: { employees, kpiEntries, ... } }
  // Unwrap nested .data if present so persistData sees a flat structure
  const clientData = body.data
    ? { ...body.data, _version: body._version, _user: body._user }
    : body;

  try {
    const { finalData, merged, duplicateLoginIds } = await _withSaveLock(() => _withDistributedSaveLock(companyId, async () => {
      let finalData = clientData;
      let merged    = false;
      let serverData;
      const getServerData = async () => (serverData ??= await loadData(companyId));

      // Re-checked *inside* the lock so a request that arrived while another
      // save was in flight sees the version that request just committed,
      // instead of a stale snapshot taken before either had run.
      // Was `< _dataVersion` only, which trusted the client-supplied _version to decide
      // whether a full-overwrite is safe. A client (even a non-admin one) sending a
      // _version larger than the server's current value skipped smartMerge entirely and
      // fell straight through to a full overwrite — in JSON-file mode that meant any
      // collection field simply omitted from the request body (kpiEntries, approvalDocs,
      // expenseClaims, ...) was silently deleted server-side (see _persistDataLocked).
      // Merging whenever the versions merely differ (not just when client is behind)
      // closes that gap; the client is always supposed to know the exact current
      // version it started editing from, so anything other than an exact match is
      // treated as "possibly stale/incomplete, merge to be safe."
      if (clientData._version !== undefined && clientData._version !== _getVersion(companyId)) {
        finalData = smartMerge(await getServerData(), clientData);
        merged    = true;
      }

      if (!_isPrivilegedStateWriter(req.auth)) {
        finalData = preserveServerOwnedStateForNonAdmin(finalData, await getServerData(), req.auth);
      }

      // changedBy는 원래부터 클라이언트가 보낸 문자열을 그대로 신뢰하는 필드였다(req.auth
      // 기반이 아님 — 기존 설계, 이번 작업 범위 밖). 다만 이 저장이 마스터 impersonation
      // 토큰(actingAsMaster가 실린 토큰, POST /master/companies/:id/impersonate 참고)으로
      // 이뤄졌다면, 클라이언트가 보낸 _user 값이 "관리자"처럼 평범해 보여도 employee_history/
      // kpi_history에는 실제로 마스터가 대신 쓴 것임을 남겨야 한다(계획 문서: impersonation으로
      // 이뤄진 쓰기 작업도 감사 대상). master_audit_log가 impersonate 발급 자체는 이미 기록하므로,
      // 여기서는 그 토큰으로 실제 어떤 저장이 일어났는지를 기존 변경이력에 얹기만 한다.
      const identity = `auth:${req.auth.loginId || req.auth.empId}`;
      const changedBy = req.auth?.actingAsMaster
        ? `master:${req.auth.actingAsMaster} as ${identity}`
        : identity;
      // persist하기 바로 직전에 게이트 — smartMerge()가 이미 끝난 뒤(finalData)라서,
      // 클라이언트가 직접 보낸 요청과 병합을 거친 요청 양쪽 모두 동일하게 걸린다.
      rejectDemoDataForProduction(finalData);
      const { duplicateLoginIds } = await _persistDataLocked(finalData, changedBy, companyId, req.auth || null);
      return { finalData, merged, duplicateLoginIds };
    }));

    const meta = {
      empCount:  (finalData.employees  || []).length,
      kpiCount:  (finalData.kpiEntries || []).length,
      lastSaved: _getLastSaved(companyId),
    };
    broadcastSSE("data_updated", { version: _getVersion(companyId), meta }, req.query.clientId, companyId);
    res.json({
      ok: true, version: _getVersion(companyId), merged,
      mergedData: merged ? filterDataForRole(stripPwField(finalData), req.auth) : undefined,
      meta,
      warnings: duplicateLoginIds && duplicateLoginIds.length ? { duplicateLoginIds } : undefined,
    });
  } catch (e) {
    // rejectDemoDataForProduction() 등 httpError()로 만든 오류는 e.status/e.code를
    // 갖고 있어 그 상태코드로 응답한다(예: 403 DEMO_DATA_FORBIDDEN) — 그 외의 예외는
    // 기존과 동일하게 500으로 처리한다(e.code가 없으면 JSON.stringify가 그 필드를
    // 조용히 생략하므로 기존 호출부의 응답 형태에 영향 없음).
    const status = Number.isInteger(e.status) ? e.status : 500;
    res.status(status).json({ ok: false, code: e.code, message: _safeErrMsg(e) });
  }
});

// GET /events — SSE
app.get("/events", async (req, res) => {
  // 브라우저 내장 EventSource는 커스텀 헤더(Authorization)를 붙일 수 없어 다른 라우트처럼
  // requireAuth를 그대로 쓸 수 없다 — 그래서 인증 자체가 아예 없었고, 로그인하지 않은
  // 상태로도 실시간 이벤트(잠금 상태에 포함된 편집자 이름, 접속/이탈 이벤트의 사용자명 등)를
  // 그대로 구독할 수 있었다. SSE에서 흔히 쓰는 방식대로 토큰을 쿼리스트링으로 전달받아
  // authenticate 미들웨어와 동일한 verifyToken()으로 검증한다.
  const auth = req.auth || verifyToken(req.query.token);
  if (!auth || !(await _employeeAuthStillValid(auth))) return res.status(401).json({ ok: false, message: "로그인이 필요합니다." });
  const companyId = auth.companyId || null;
  const clientId = req.query.clientId || `client_${Date.now()}`;
  const user     = req.query.user     || "unknown";

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  // companyId는 항상 _scopeKey()로 정규화해 저장한다 — broadcastSSE/온라인 카운트가 같은
  // 정규화된 값끼리 비교하므로(JSON 모드는 전부 _GLOBAL_SCOPE로 수렴) 그래야 일치한다.
  _sseClients[clientId] = { res, user, companyId: _scopeKey(companyId), connectedAt: new Date().toISOString() };
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, version: _getVersion(companyId) })}\n\n`);
  // 다른 회사의 잠금 키가 섞여 들어오지 않도록 이 회사 소유분만(접두어를 벗겨) 전송한다.
  res.write(`event: locks_update\ndata: ${JSON.stringify(_locksForCompany(companyId))}\n\n`);
  broadcastSSE("user_online", { clientId, user, action: "join" }, clientId, companyId);

  const heartbeat = setInterval(() => {
    try { res.write(":heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    delete _sseClients[clientId];
    broadcastSSE("user_online", { clientId, user, action: "leave" }, null, companyId);
  });
});

// GET /online
app.get("/online", (req, res) => {
  if (!requireAuth(req, res)) return;
  const companyId = _scopeKey(req.auth.companyId || null);
  const users = Object.entries(_sseClients)
    .filter(([, c]) => c.companyId === companyId)
    .map(([cid, c]) => ({ clientId: cid, user: c.user, connectedAt: c.connectedAt }));
  res.json({ ok: true, users });
});

// POST /lock
app.post("/lock", (req, res) => {
  if (!requireAuth(req, res)) return;
  const companyId = req.auth.companyId || null;
  const { key, userId, userName, targetLabel, ttlMs = 30 * 60 * 1000 } = req.body;
  if (!key || !userId)
    return res.status(400).json({ ok: false, message: "key, userId 필요" });
  // 잠금 키를 회사별로 완전히 분리한다 — 접두어 없이는 이론상 두 회사가 같은 키(예: "emp:123",
  // employee id는 전역 유일이라 실제로는 충돌하지 않지만 방어적으로) 로 서로의 잠금을
  // 덮어쓰거나 뺏을 수 있었다.
  const fullKey = `${_scopeKey(companyId)}:${key}`;

  const ex = _locks[fullKey];
  if (ex && ex.userId !== userId && Date.now() < ex.expiresAt)
    return res.json({ ok: false, lock: ex });

  _locks[fullKey] = { userId, userName, targetLabel, acquiredAt: Date.now(), expiresAt: Date.now() + ttlMs };
  broadcastSSE("locks_update", _locksForCompany(companyId), null, companyId);
  res.json({ ok: true, lock: _locks[fullKey] });
});

// POST /unlock
app.post("/unlock", (req, res) => {
  if (!requireAuth(req, res)) return;
  const companyId = req.auth.companyId || null;
  const { key, userId, force } = req.body;
  if (!key) return res.status(400).json({ ok: false });
  const fullKey = `${_scopeKey(companyId)}:${key}`;
  const ex = _locks[fullKey];
  // force:true는 아직 만료되지 않은(30분 이내) 남의 잠금을 강제로 뺏는 것이므로, 이미
  // 만료된 잠금(프론트가 "비활성 잠금"으로 판단해 일반 사용자에게도 버튼을 보여주는
  // 경우) 또는 admin에게만 허용한다. 그 외에는 예전에는 인증만 있으면 누구든 force로
  // 남의 진행 중인 편집 잠금을 강제로 풀 수 있었다.
  const isExpired = !ex || Date.now() >= ex.expiresAt;
  if (force && !isExpired && (!req.auth || req.auth.role !== "admin")) {
    return res.status(403).json({ ok: false, message: "관리자만 잠금을 강제 해제할 수 있습니다." });
  }
  if (ex && (ex.userId === userId || force)) {
    delete _locks[fullKey];
    broadcastSSE("locks_update", _locksForCompany(companyId), null, companyId);
  }
  res.json({ ok: true });
});

// POST /log
app.post("/log", async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!req.body) return res.status(400).json({ ok: false });
  await addActivityLog(req.body, req.auth.companyId || null);
  res.json({ ok: true });
});

// GET /activity
app.get("/activity", async (req, res) => {
  // "activity-log" 페이지는 PAGE_ROLES상 admin 전용인데 requireAuth만 있어 member 토큰으로도
  // 자유텍스트 target/detail이 담긴 활동 로그를 조회할 수 있었다(실측 확인).
  if (!requireAdmin(req, res)) return;
  const limit = parseInt(req.query.limit) || 300;
  if (USE_JSON_FILE) {
    return res.json({ ok: true, logs: _fileActivityLog.slice(0, limit) });
  }
  // 이전에는 _activityLog(process 메모리, 회사 구분 없는 단일 배열)를 그대로 반환해,
  // 회사 A의 관리자가 회사 B의 활동 로그(자유텍스트 target/detail 포함)를 함께 볼 수 있었다
  // — DB 영속성 감사 도중 함께 발견한 별도의 크로스테넌트 유출. DB에서 이 회사(레거시
  // company_id NULL 데이터 포함) 것만 조회한다.
  const companyId = req.auth.companyId || null;
  try {
    const { rows } = await pool.query(
      "SELECT data FROM activity_log WHERE (company_id = $1 OR ($1 IS NULL AND company_id IS NULL)) ORDER BY created_at DESC LIMIT $2",
      [companyId, limit]
    );
    return res.json({ ok: true, logs: rows.map(r => r.data) });
  } catch (e) {
    return res.status(500).json({ ok: false, message: _safeErrMsg(e) });
  }
});

// ── Annual snapshots ──────────────────────────────────────────────────────────

// ── Snapshot helpers for JSON file mode ──────────────────────────────────────
function _saveFileSnapshots() {
  // Persist snapshots alongside the main data file
  const snapFile = JSON_FILE.replace(/\.json$/, "-snapshots.json");
  _atomicWriteFileSync(snapFile, JSON.stringify(_fileSnapshots, null, 2));
}

// ── Change history helpers for JSON file mode (audit trail) ──────────────────
function _recordFileHistory(kind, id, action, changedBy, data) {
  const list = _fileHistory[kind];
  list.push({ id: `${kind}_${list.length + 1}`, [kind === "employees" ? "employee_id" : "kpi_id"]: id, action, changed_by: changedBy, changed_at: new Date().toISOString(), data });
  if (list.length > MAX_FILE_HISTORY) list.splice(0, list.length - MAX_FILE_HISTORY);
}
function _saveFileHistory() {
  const histFile = JSON_FILE.replace(/\.json$/, "-history.json");
  _atomicWriteFileSync(histFile, JSON.stringify(_fileHistory, null, 2));
}

// GET /snapshots — list all annual snapshots
app.get("/snapshots", async (req, res) => {
  // "history" 페이지는 admin 전용이고, 목록 응답에도 admin이 입력한 notes(대외비 메모 등)가
  // 포함돼 있어 /snapshots/:year와 동일하게 requireAdmin으로 승격한다.
  if (!requireAdmin(req, res)) return;
  const companyId = req.auth.companyId || null;
  try {
    if (USE_JSON_FILE) {
      const snaps = Object.entries(_fileSnapshots).map(([y, s]) => ({
        eval_year: parseInt(y), emp_count: s.empCount, kpi_count: s.kpiCount,
        confirmed_by: s.confirmedBy, confirmed_at: s.createdAt, notes: s.label,
      })).sort((a, b) => b.eval_year - a.eval_year);
      return res.json({ ok: true, snapshots: snaps });
    }
    const { rows } = await pool.query(
      "SELECT id, eval_year, emp_count, kpi_count, confirmed_by, confirmed_at, notes FROM annual_snapshots WHERE (company_id = $1 OR company_id IS NULL) ORDER BY eval_year DESC",
      [companyId]
    );
    res.json({ ok: true, snapshots: rows });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// Every top-level field a full snapshot can contain, in the order they're
// listed for the "선택 복원" (partial restore) UI. "budget"은 loadData() 소관이 아니라
// budget.js의 별도 budget_store 저장소를 통째로 담는 특수 필드 — POST /restore에서
// 일반 필드(ID-keyed 병합 또는 싱글턴 통째 교체)와 다르게 updateBudget()으로 별도 처리된다.
const SNAPSHOT_FIELDS = ["employees", "kpiEntries", ...GENERIC_LIST_FIELDS, ...SINGLETON_FIELDS, "budget"];

// Summarizes which fields a snapshot actually has data for, with a record
// count for array fields, so the client can offer a "필요한 부분만 복원" picker.
function describeSnapshotFields(snapshotData) {
  return SNAPSHOT_FIELDS
    .filter(f => snapshotData[f] !== undefined)
    .map(f => ({ field: f, count: Array.isArray(snapshotData[f]) ? snapshotData[f].length : undefined }));
}

// POST /snapshots — create a full-DB confirmed snapshot, tagged by year
// annual_snapshots는 company_id 컬럼(NULL 잔여가 없으면 NOT NULL)과 UNIQUE(company_id,
// eval_year) 복합 제약으로 이미 마이그레이션돼 있다(schema.sql 참고) — 두 회사가 같은
// 연도에 각자 스냅샷을 만들어도 서로 충돌·덮어쓰기 없이 공존한다. loadData(companyId)가
// 반환하는 employees/kpiEntries/app_collections/app_singletons 유래 필드도 전부 이
// 회사로 스코프된 데이터라 스냅샷 내용물 역시 정확히 이 회사 것만 담긴다.
app.post("/snapshots", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { year = new Date().getFullYear(), confirmedBy = "admin", notes = "" } = req.body || {};
  const companyId = req.auth.companyId || null;
  try {
    const data = await loadData(req.auth.companyId);
    // budget_store(사업계획/예산/개인별급여상세)는 loadData()가 다루는 employees/kpiEntries/
    // app_collections/app_singletons 계열과 완전히 별도의 테이블·저장소(budget.js 전담)라
    // 기존 스냅샷에서 통째로 빠져있었다(사용자 보고) — readBudget()으로 함께 읽어 스냅샷
    // 본문(JSONB/파일 blob)에 "budget" 키로 얹는다. annual_snapshots 스키마 변경 불필요:
    // snapshot_data 자체가 이미 JSONB라 새 키를 추가로 담는 데 제약이 없다.
    data.budget = await budgetRouterFactory.readBudget(req.auth.companyId);
    const yr = parseInt(year);
    const empCount = (data.employees || []).length;
    const kpiCount = (data.kpiEntries || []).length;
    if (USE_JSON_FILE) {
      _fileSnapshots[yr] = { data, empCount, kpiCount, confirmedBy, label: notes || `${yr}년 확정 스냅샷`, createdAt: new Date().toISOString() };
      _saveFileSnapshots();
      return res.json({ ok: true, year: yr, empCount, kpiCount });
    }
    await pool.query(
      // annual_snapshots는 company_id NOT NULL + UNIQUE(company_id, eval_year)로 이미
      // 업그레이드돼 있는데 INSERT는 예전 그대로 company_id를 넣지 않고
      // `ON CONFLICT (eval_year)`를 쓰고 있어, Postgres(운영) 모드에서 스냅샷/백업 생성이
      // 100% 500 에러로 실패했다("there is no unique or exclusion constraint matching
      // the ON CONFLICT", 실측 확인). 컬럼과 충돌 대상을 현재 스키마에 맞춘다.
      `INSERT INTO annual_snapshots (company_id, eval_year, snapshot_data, emp_count, kpi_count, confirmed_by, notes)
       VALUES ($7,$1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id, eval_year) DO UPDATE
         SET snapshot_data = $2, emp_count = $3, kpi_count = $4,
             confirmed_by = $5, confirmed_at = NOW(), notes = $6`,
      [yr, JSON.stringify(data), empCount, kpiCount, confirmedBy, notes, companyId]
    );
    res.json({ ok: true, year: yr, empCount, kpiCount });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// GET /snapshots/:year — retrieve a specific year's snapshot, including a
// `fields` summary (name + record count) so the client can pick which parts
// to restore instead of always restoring everything.
app.get("/snapshots/:year", async (req, res) => {
  // /data·/save·/restore와 달리 이 라우트만 filterDataForRole()을 거치지 않아 taken
  // member 토큰으로도 스냅샷 안의 타 직원 payslips(급여)·kpiEntries(평가 코멘트)가 그대로
  // 반환되고 있었다(실측 확인) — "연도별 스냅샷" 기능 자체가 PAGE_ROLES상 admin 전용
  // ("history" 페이지)이므로 requireAuth를 requireAdmin으로 승격해 원천 차단한다.
  if (!requireAdmin(req, res)) return;
  try {
    const yr = parseInt(req.params.year);
    if (USE_JSON_FILE) {
      const s = _fileSnapshots[yr];
      if (!s) return res.status(404).json({ ok: false, message: "스냅샷 없음" });
      return res.json({ ok: true, snapshot: { eval_year: yr, ...s, snapshot_data: stripPwField(s.data), data: stripPwField(s.data), fields: describeSnapshotFields(s.data) } });
    }
    const { rows } = await pool.query(
      "SELECT * FROM annual_snapshots WHERE eval_year = $1 AND (company_id = $2 OR company_id IS NULL)", [yr, req.auth.companyId || null]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: "스냅샷 없음" });
    res.json({ ok: true, snapshot: { ...rows[0], snapshot_data: stripPwField(rows[0].snapshot_data), fields: describeSnapshotFields(rows[0].snapshot_data) } });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── Backups (alias → snapshots, backward compat with existing frontend) ───────

// GET /backups
app.get("/backups", async (req, res) => {
  // /snapshots의 별칭이며 동일하게 admin이 입력한 label(=notes)이 포함돼 있어 동일 기준 적용.
  if (!requireAdmin(req, res)) return;
  const companyId = req.auth.companyId || null;
  try {
    if (USE_JSON_FILE) {
      const backups = Object.entries(_fileSnapshots).map(([y, s]) => ({
        name: `snapshot_${y}.json`, label: s.label, type: "annual",
        createdAt: s.createdAt, empCount: s.empCount, kpiCount: s.kpiCount,
      })).sort((a, b) => b.name.localeCompare(a.name));
      return res.json({ ok: true, backups });
    }
    const { rows } = await pool.query(
      "SELECT id, eval_year, emp_count AS \"empCount\", kpi_count AS \"kpiCount\", confirmed_by, confirmed_at AS \"createdAt\", notes FROM annual_snapshots WHERE (company_id = $1 OR company_id IS NULL) ORDER BY eval_year DESC",
      [companyId]
    );
    const backups = rows.map(r => ({
      name:      `snapshot_${r.eval_year}.json`,
      label:     r.notes || `${r.eval_year}년 확정 스냅샷`,
      type:      "annual",
      createdAt: r.createdAt,
      empCount:  r.empCount,
      kpiCount:  r.kpiCount,
    }));
    res.json({ ok: true, backups });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// POST /backups/create — create a full-DB snapshot for the current year
app.post("/backups/create", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { label = "수동 스냅샷", type = "manual" } = req.body || {};
  const year = parseInt(req.body.year || new Date().getFullYear());
  const companyId = req.auth.companyId || null;
  try {
    const data = await loadData(req.auth.companyId);
    if (!data.employees.length && !data.kpiEntries.length)
      return res.status(404).json({ ok: false, message: "데이터 없음" });
    // POST /snapshots와 동일하게 budget_store도 함께 담는다(위 주석 참고).
    data.budget = await budgetRouterFactory.readBudget(req.auth.companyId);

    const empCount = data.employees.length;
    const kpiCount = (data.kpiEntries || []).length;
    if (USE_JSON_FILE) {
      _fileSnapshots[year] = { data, empCount, kpiCount, confirmedBy: "admin", label, createdAt: new Date().toISOString() };
      _saveFileSnapshots();
      return res.json({ ok: true, name: `snapshot_${year}.json` });
    }
    await pool.query(
      // annual_snapshots는 company_id NOT NULL + UNIQUE(company_id, eval_year)로 이미
      // 업그레이드돼 있는데 INSERT는 예전 그대로 company_id를 넣지 않고
      // `ON CONFLICT (eval_year)`를 쓰고 있어, Postgres(운영) 모드에서 스냅샷/백업 생성이
      // 100% 500 에러로 실패했다("there is no unique or exclusion constraint matching
      // the ON CONFLICT", 실측 확인). 컬럼과 충돌 대상을 현재 스키마에 맞춘다.
      `INSERT INTO annual_snapshots (company_id, eval_year, snapshot_data, emp_count, kpi_count, confirmed_by, notes)
       VALUES ($7,$1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id, eval_year) DO UPDATE
         SET snapshot_data = $2, emp_count = $3, kpi_count = $4,
             confirmed_by = $5, confirmed_at = NOW(), notes = $6`,
      [year, JSON.stringify(data), empCount, kpiCount, "admin", label, companyId]
    );
    res.json({ ok: true, name: `snapshot_${year}.json` });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

async function loadSnapshotData(year, companyId) {
  if (USE_JSON_FILE) {
    const s = _fileSnapshots[year];
    return s ? s.data : null;
  }
  // 복원은 현재 데이터를 통째로 덮어쓰는 파괴적 동작이라 회사 범위를 반드시 좁혀야 한다
  // (좁히지 않으면 다른 회사의 스냅샷으로 복원돼 전 직원 데이터가 남의 것으로 바뀐다).
  const { rows } = await pool.query(
    "SELECT snapshot_data FROM annual_snapshots WHERE eval_year = $1 AND (company_id = $2 OR company_id IS NULL)",
    [year, companyId]
  );
  return rows.length ? rows[0].snapshot_data : null;
}

// ids present in `curArr` (current live data) but absent from `snapArr` (the
// snapshot) — these are the records a restore would otherwise silently keep,
// since persistData only inserts/updates and never deletes on its own.
function extraIdsNotInSnapshot(curArr, snapArr) {
  if (!Array.isArray(curArr) || !Array.isArray(snapArr)) return [];
  const snapIds = new Set(snapArr.filter(x => x && x.id != null).map(x => String(x.id)));
  return curArr.filter(x => x && x.id != null && !snapIds.has(String(x.id))).map(x => String(x.id));
}

// snapshot wins for ids present in both; ids only in `curArr` are kept as-is
// (used when the caller does NOT want extras deleted).
function unionPreferSnapshot(curArr, snapArr) {
  if (!Array.isArray(snapArr)) return Array.isArray(curArr) ? curArr : [];
  if (!Array.isArray(curArr)) return snapArr;
  const map = {};
  for (const item of curArr)  if (item && item.id != null) map[item.id] = item;
  for (const item of snapArr) if (item && item.id != null) map[item.id] = item;
  return Object.values(map);
}

// GET /snapshots/:year/diff?fields=a,b,c — for each field, reports how many
// records currently exist that are NOT in the snapshot. Lets the client warn
// "복원 시 N건이 삭제됩니다" before the admin opts into deleteExtras.
app.get("/snapshots/:year/diff", async (req, res) => {
  // 같은 "연도별 스냅샷"(admin 전용) 기능의 일부 — /snapshots/:year와 동일하게 승격.
  if (!requireAdmin(req, res)) return;
  try {
    const yr = parseInt(req.params.year);
    const fields = (req.query.fields || "").split(",").map(f => f.trim()).filter(Boolean);
    if (!fields.length) return res.status(400).json({ ok: false, message: "fields 쿼리 필요" });

    const snapshotData = await loadSnapshotData(yr, req.auth.companyId || null);
    if (!snapshotData) return res.status(404).json({ ok: false, message: "스냅샷 없음" });
    const current = await loadData(req.auth.companyId);

    const diff = fields.map(f => {
      const extraIds = extraIdsNotInSnapshot(current[f], snapshotData[f]);
      return { field: f, extraCount: extraIds.length, extraIds };
    });
    res.json({ ok: true, diff });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// POST /restore — restore from a snapshot year. By default restores every
// field in the snapshot; pass `fields: ["employees", "attendanceRecords", ...]`
// to restore only those parts, leaving everything else untouched. Pass
// `deleteExtras: true` to also remove records that exist now but weren't in
// the snapshot (a true point-in-time restore); without it, those extra
// records are simply left in place (snapshot data is merged in, not swapped).
app.post("/restore", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const name = req.body.name || "";
  const fields = Array.isArray(req.body.fields) && req.body.fields.length ? req.body.fields : null;
  const deleteExtras = !!req.body.deleteExtras;
  const yearMatch = name.match(/(\d{4})/);
  if (!yearMatch) return res.status(400).json({ ok: false, message: "name에서 연도를 찾을 수 없음" });
  const year = parseInt(yearMatch[1]);
  const companyId = req.auth.companyId || null;
  try {
    const snapshotData = await loadSnapshotData(year, companyId);
    if (!snapshotData) return res.status(404).json({ ok: false, message: "스냅샷 없음" });

    const current = await loadData(companyId);
    const targetFields = fields || describeSnapshotFields(snapshotData).map(f => f.field);
    const restoreBudget = targetFields.includes("budget") && snapshotData.budget !== undefined;
    const dataToPersist = { ...current };
    const restoredFields = [];
    const extrasByField = {};
    for (const f of targetFields) {
      if (f === "budget") continue; // budget_store는 loadData()/persistData() 소관이 아니라
      // 아래에서 updateBudget()으로 별도 처리 — persistData에 그대로 넘기면 알려지지 않은
      // 필드라 조용히 무시될 뿐이라, 처음부터 일반 필드 병합 루프에서 제외한다.
      if (snapshotData[f] === undefined) continue;
      if (Array.isArray(snapshotData[f]) && ID_KEYED_LIST_FIELDS.includes(f)) {
        // record collection (objects with an `id`) — merge/delete by id
        if (deleteExtras) {
          extrasByField[f] = extraIdsNotInSnapshot(current[f], snapshotData[f]);
          dataToPersist[f] = snapshotData[f];
        } else {
          dataToPersist[f] = unionPreferSnapshot(current[f], snapshotData[f]);
        }
      } else {
        // singleton config blob (object, or a plain scalar array like
        // disabledTplIds) — no per-record id to merge by, snapshot wins outright
        dataToPersist[f] = snapshotData[f];
      }
      restoredFields.push(f);
    }

    // 운영 환경의 더미 스냅샷은 어떤 삭제보다 먼저 거부한다. 이전에는 deleteExtras가
    // 현재 레코드를 삭제한 다음 여기서 403을 내므로, 거부된 복원만으로 데이터가 사라질 수 있었다.
    rejectDemoDataForProduction(dataToPersist);

    // persistData()가 신규/변경 레코드를 반영해도, deleteExtras가 지우려는 레코드들은
    // persistData 호출 결과와 무관하게 이미 계산돼 있다(extraIds는 restore 시작 시점의
    // `current` 스냅샷에서 뽑은 것). 예전에는 이 삭제 루프가 persistData() "다음"에
    // 별도 트랜잭션으로 실행돼, 중간에 서버가 죽거나 삭제 쪽이 실패하면 "새 레코드는
    // 반영됐는데 지워졌어야 할 레코드는 남아있는" 어중간한 상태가 될 수 있었다(P2 —
    // "복원 시 본문 저장과 불필요 레코드 삭제가 별도 트랜잭션"). persistData()보다 먼저
    // 실행하도록 순서를 바꾸면, 삭제가 실패해 여기서 예외가 나도 persistData()가 아직
    // 실행되지 않아 아무 변경도 반영되지 않은 상태로 남고(재시도해도 안전, idempotent),
    // 삭제가 성공한 뒤 persistData()가 실패해도 "이미 지워질 레코드는 지워졌고 새 값은
    // 아직 반영 전"이라는, 재시도로 동일하게 복구 가능한 상태가 된다 — 두 경우 모두
    // "부분 복원"이 영구히 고착되지 않는다(완전한 단일 DB 트랜잭션은 아니지만, 실패
    // 시나리오 전부가 재시도로 수렴하는 순서로 재배치).
    // extraIds는 이미 companyId로 스코프된 `current`(loadData(companyId))에서 계산됐으므로
    // 다른 회사 소유 id가 섞일 수 없지만, company_id 조건도 함께 걸어 방어를 한 겹 더 둔다.
    if (deleteExtras && !USE_JSON_FILE) {
      for (const [field, extraIds] of Object.entries(extrasByField)) {
        if (!extraIds.length) continue;
        if (field === "employees") {
          await pool.query(
            "INSERT INTO employee_history (employee_id, action, changed_by, data, company_id) SELECT id, 'delete', $2, data, company_id FROM employees WHERE id = ANY($1) AND (company_id = $3 OR $3 IS NULL)",
            [extraIds, "restore", companyId]
          );
          await pool.query("DELETE FROM employees WHERE id = ANY($1) AND (company_id = $2 OR $2 IS NULL)", [extraIds, companyId]);
        } else if (field === "kpiEntries") {
          await pool.query(
            "INSERT INTO kpi_history (kpi_id, action, changed_by, data, company_id) SELECT id, 'delete', $2, data, company_id FROM kpi_entries WHERE id = ANY($1) AND (company_id = $3 OR $3 IS NULL)",
            [extraIds, "restore", companyId]
          );
          await pool.query("DELETE FROM kpi_entries WHERE id = ANY($1) AND (company_id = $2 OR $2 IS NULL)", [extraIds, companyId]);
        } else {
          // 2단계(2026-07-21) 이전에는 여기 company_id 조건이 아예 없어, 회사 A의 스냅샷
          // 복원이 우연히 같은 collection+id를 가진 회사 B의 살아있는 레코드까지 삭제할 수
          // 있었다(app_collections가 아직 전역 공유였을 때는 collection+id 자체가 PK였으므로
          // ANY($2) 매치가 곧 유일한 행을 가리켰지만, id는 클라이언트의 로컬 카운터라 두 회사가
          // 같은 id를 쓰는 게 흔해 실제로 위험했다). 위 employees/kpiEntries 분기와 동일한
          // (company_id = $N OR $N IS NULL) 패턴으로 이 회사(+레거시 NULL) 소유 행만 삭제한다.
          await pool.query(
            "DELETE FROM app_collections WHERE collection = $1 AND id = ANY($2) AND (company_id = $3 OR $3 IS NULL)",
            [field, extraIds, companyId]
          );
        }
      }
    }

    // /restore는 관리자 전용이라 결재 위조 방어(_sanitizeApprovalDoc)를 그대로 통과한다 —
    // 스냅샷 복원은 과거 시점의 결재 상태를 있는 그대로 되돌리는 것이 목적이다.
    // 반면 더미 데이터 게이트는 그대로 적용한다 — POST /save와 동일하게, 개발 환경에서
    // 만든(더미 데이터가 섞인) 스냅샷을 운영 환경에 그대로 복원하는 경로를 막아야 한다.
    await persistData(dataToPersist, req.body.user || "restore", companyId, req.auth || null);

    // budget_store(사업계획/예산/개인별급여상세)는 위 일반 필드 병합 루프에서 제외했으므로
    // (persistData 소관 밖) 별도로 복원한다 — 다른 singleton 필드와 동일하게 "스냅샷이
    // 통째로 이긴다"(부분 병합 아님): budget_store 전체를 스냅샷 시점 값으로 교체한다.
    // updateBudget()이 이미 락(JSON 모드는 동기 원자성, Postgres 모드는 SELECT...FOR UPDATE)을
    // 쥐고 있어 이 복원 자체가 동시 사업계획 저장과 경합하지 않는다.
    if (restoreBudget) {
      await budgetRouterFactory.updateBudget(companyId, async (data) => {
        Object.keys(data).forEach(k => { delete data[k]; });
        Object.assign(data, snapshotData.budget);
        return data;
      });
      restoredFields.push("budget");
    }

    const finalData = await loadData(companyId);
    broadcastSSE("data_restored", { name, fields: restoredFields, deletedExtras: deleteExtras, version: _getVersion(companyId) }, null, companyId);
    res.json({ ok: true, version: _getVersion(companyId), restoredFields, deletedExtras: deleteExtras, data: filterDataForRole(stripPwField(finalData), req.auth) });
  } catch (e) {
    // rejectDemoDataForProduction()이 httpError()로 만든 오류는 e.status/e.code를 갖고
    // 있다(예: 403 DEMO_DATA_FORBIDDEN) — POST /save와 동일하게 그 상태코드로 응답한다.
    // 이 검사가 없으면 정당한 403 거부가 500(서버 오류)으로 뭉개져, 클라이언트가
    // "게이트에 걸림"과 "진짜 서버 오류"를 구분할 수 없었다.
    const status = Number.isInteger(e.status) ? e.status : 500;
    res.status(status).json({ ok: false, code: e.code, message: _safeErrMsg(e) });
  }
});

// ── History endpoints ─────────────────────────────────────────────────────────
// In JSON file mode, change history is persisted to hr-data-history.json (see _fileHistory).

// GET /history/employee/:id
// company_id로 스코프한다 — employee_history에 company_id 컬럼이 붙은(2026-07-20) 이후에도
// 이 라우트는 그 필터가 없어, 회사 A의 admin이 회사 B 직원의 id만 알면(다른 API의 목록
// 등을 통해 유추 가능) 변경이력 전체(과거 연락처·주소·연봉 등 PII 포함)를 조회할 수 있었다
// — company_id를 모르는 legacy 단일 회사 배포/과거 데이터(NULL)는 그대로 보여준다.
app.get("/history/employee/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (USE_JSON_FILE) {
    const history = (_fileHistory.employees || [])
      .filter(h => h.employee_id === req.params.id)
      .slice(-500).reverse()
      .map(h => ({ history_id: h.id, action: h.action, changed_by: h.changed_by, changed_at: h.changed_at, data: omitPw(h.data) }));
    return res.json({ ok: true, history });
  }
  try {
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query(
      `SELECT history_id, action, changed_by, changed_at, data
       FROM employee_history WHERE employee_id = $1 AND (company_id = $2 OR company_id IS NULL)
       ORDER BY changed_at DESC LIMIT 500`,
      [req.params.id, companyId]
    );
    res.json({ ok: true, history: rows.map(r => ({ ...r, data: omitPw(r.data) })) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// GET /history/kpi/:id — 위 /history/employee/:id와 동일한 이유로 company_id 스코프.
app.get("/history/kpi/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (USE_JSON_FILE) {
    const history = (_fileHistory.kpi || [])
      .filter(h => h.kpi_id === req.params.id)
      .slice(-500).reverse()
      .map(h => ({ history_id: h.id, action: h.action, changed_by: h.changed_by, changed_at: h.changed_at, data: h.data }));
    return res.json({ ok: true, history });
  }
  try {
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query(
      `SELECT history_id, action, changed_by, changed_at, data
       FROM kpi_history WHERE kpi_id = $1 AND (company_id = $2 OR company_id IS NULL)
       ORDER BY changed_at DESC LIMIT 500`,
      [req.params.id, companyId]
    );
    res.json({ ok: true, history: rows });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// GET /history/changes?since=ISO_DATE&table=employees|kpi_entries
// 위 두 라우트보다 더 심각한 형태의 같은 문제 — company_id 필터가 없으면 단건 조회가 아니라
// 전 회사의 변경이력을 한 번에 벌크로 덤프해줘 버린다(회사 A의 admin이 회사 B~Z 전체의
// 직원·평가 변경이력을 그대로 받아볼 수 있었음).
app.get("/history/changes", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const since = req.query.since || new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const table = req.query.table;
  if (USE_JSON_FILE) {
    const results = {};
    if (!table || table === "employees") {
      results.employeeChanges = (_fileHistory.employees || [])
        .filter(h => h.changed_at >= since)
        .map(h => ({ history_id: h.id, employee_id: h.employee_id, action: h.action, changed_by: h.changed_by, changed_at: h.changed_at, data: omitPw(h.data) }))
        .slice(-1000).reverse();
    }
    if (!table || table === "kpi_entries") {
      results.kpiChanges = (_fileHistory.kpi || [])
        .filter(h => h.changed_at >= since)
        .map(h => ({ history_id: h.id, kpi_id: h.kpi_id, action: h.action, changed_by: h.changed_by, changed_at: h.changed_at, data: h.data }))
        .slice(-1000).reverse();
    }
    return res.json({ ok: true, ...results });
  }
  try {
    const companyId = req.auth.companyId || null;
    const results = {};
    if (!table || table === "employees") {
      const { rows } = await pool.query(
        "SELECT * FROM employee_history WHERE changed_at >= $1 AND (company_id = $2 OR company_id IS NULL) ORDER BY changed_at DESC LIMIT 1000",
        [since, companyId]
      );
      results.employeeChanges = rows.map(r => ({ ...r, data: omitPw(r.data) }));
    }
    if (!table || table === "kpi_entries") {
      const { rows } = await pool.query(
        "SELECT * FROM kpi_history WHERE changed_at >= $1 AND (company_id = $2 OR company_id IS NULL) ORDER BY changed_at DESC LIMIT 1000",
        [since, companyId]
      );
      results.kpiChanges = rows;
    }
    res.json({ ok: true, ...results });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── Accounting module (계정과목 / 전표 / 세금계산서) ──────────────────────────
// Unlike employees/kpiEntries (client computes full state, server merges),
// this module is server-authoritative: the server assigns sequential numbers,
// validates 차변/대변 balance, and makes posted/issued records immutable.
// JSON file mode keeps everything in `_fileAccounting`; PostgreSQL mode uses
// dedicated tables (see schema.sql).

function _saveFileAccounting() {
  const acctFile = JSON_FILE.replace(/\.json$/, "-accounting.json");
  _atomicWriteFileSync(acctFile, JSON.stringify(_fileAccounting, null, 2));
}
function _saveFileAcctRcps() {
  const rcpsFile = JSON_FILE.replace(/\.json$/, "-rcps.json");
  _atomicWriteFileSync(rcpsFile, JSON.stringify(_fileAcctRcps, null, 2));
}
function _saveFileAcctFixedAssets() {
  const faFile = JSON_FILE.replace(/\.json$/, "-fixedassets.json");
  _atomicWriteFileSync(faFile, JSON.stringify(_fileAcctFixedAssets, null, 2));
}
function _nextAcctSeq(kind, year) {
  if (!_fileAccounting[kind]) _fileAccounting[kind] = {};
  const next = (_fileAccounting[kind][year] || 0) + 1;
  _fileAccounting[kind][year] = next;
  return next;
}
// 과거에는 req.body.role(클라이언트가 그대로 적어 보낸 값)을 그대로 신뢰했으나,
// 이는 누구든 body에 role:"admin"만 넣어 보내면 인가를 우회할 수 있는 구조였다.
// 이제는 /login에서 서버가 발급한 토큰(req.auth, authenticate 미들웨어가 검증)만 신뢰한다.
function requireAdmin(req, res) {
  if (!requireAuth(req, res)) return false;
  if (req.auth.role !== "admin") {
    res.status(403).json({ ok: false, message: "관리자만 사용할 수 있습니다." });
    return false;
  }
  return true;
}
function requireRole(req, res, allowed) {
  if (!requireAuth(req, res)) return false;
  if (!allowed.includes(req.auth.role)) {
    res.status(403).json({ ok: false, message: "이 작업을 수행할 권한이 없습니다." });
    return false;
  }
  return true;
}
// "권한 관리" 화면(개인별로 특정 메뉴를 role 기본값과 별개로 추가 제한)은 지금까지
// 클라이언트에서만 검사됐다(사이드바 숨김 + gotoPage() 가드) — 서버는 전혀 확인하지
// 않아 브라우저 개발자도구로 그 화면이 쓰는 API를 직접 호출하면 그대로 통과됐다
// (2026-08-21 사용자 지적, 실측 확인 — menuPerms 기능 자체가 원래 그렇게 설계돼 있던
// 것으로, 이번에 새로 생긴 약점은 아님). 전용 REST API를 가진 화면(회계/PMS/채용/재고/
// 영업/사업계획 등)에 한해 서버측으로도 강제한다 — role 기반 requireAdmin/requireRole과
// 나란히 개인 단위 추가 체크로 동작. authenticate()가 이미 req.auth.menuPerms에 실어둔
// 값을 그대로 쓰므로 이 함수 자체는 추가 조회를 하지 않는다. 클라이언트 gotoPage()와
// 동일하게 role과 무관하게(admin 포함) menuPerms[pageId]===false면 차단한다 — 클라이언트
// 쪽 관례를 그대로 반영.
//
// 적용 범위: 전용 REST 엔드포인트를 가진 화면들에만 적용했다. KPI/역량평가/직원정보처럼
// 요청 하나(POST /save)에 여러 화면의 변경사항이 뒤섞여 오는 전체상태 blob 저장 방식
// 화면들은, 이 요청이 어느 "페이지"에서 왔는지 서버가 구분할 방법이 구조적으로 없어
// 이번 범위에서 제외했다(어설프게 흉내내면 오히려 다른 화면의 정상 저장까지 함께
// 막는 새 버그를 만들 위험이 큼 — CLAUDE.md 기록 참고).
function requirePage(req, res, pageId) {
  if (!requireAuth(req, res)) return false;
  const perms = req.auth.menuPerms || {};
  if (perms[pageId] === false) {
    res.status(403).json({ ok: false, message: "이 메뉴에 대한 접근 권한이 없습니다." });
    return false;
  }
  return true;
}
function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ── 계정과목 (Chart of accounts) ────────────────────────────────────────────
app.get("/api/accounting/accounts", async (req, res) => {
  // 회계 모듈 조회 전체가 PAGE_ROLES상 admin 전용("acct-*")인데 requireAuth만 있어 member
  // 토큰으로도 API 직접호출 시 전표·거래처·세금계산서 등 전체 조회가 가능했다(실측 확인).
  if (!requireAdmin(req, res)) return;
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, accounts: _fileAccounting.accounts });
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query(
      "SELECT id, data FROM accounts WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL) ORDER BY id",
      [companyId]
    );
    res.json({ ok: true, accounts: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// 기본 계정과목 일괄등록 — DEFAULT_ACCOUNTS(급여/복리후생비/여비교통비 등 일반적으로
// 쓰는 계정)는 신규 회사 가입 시 자동 시딩되지만, 그 이전부터 있던 회사는 이 목록이
// 확장돼도 소급 적용되지 않는다. code가 아직 없는 항목만 추가해 기존 계정과목을
// 덮어쓰지 않는다(이미 같은 code로 직접 만들어 쓰고 있는 회사는 그대로 유지).
app.post("/api/accounting/accounts/seed-defaults", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!requirePage(req, res, "acct-accounts")) return;
  try {
    const now = new Date().toISOString();
    const user = (req.body && req.body.user) || req.auth.loginId || "unknown";
    if (USE_JSON_FILE) {
      const existingCodes = new Set(_fileAccounting.accounts.map(a => a.code));
      const toAdd = DEFAULT_ACCOUNTS.filter(a => !existingCodes.has(a.code));
      toAdd.forEach(a => {
        _fileAccounting.accounts.push({
          id: `acc_seed_${a.code}_${Date.now()}`, ...a, active: true,
          history: [{ action: "create", user, at: now }],
        });
      });
      if (toAdd.length) _saveFileAccounting();
      return res.json({ ok: true, added: toAdd.length, accounts: toAdd });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query(
      "SELECT data->>'code' AS code FROM accounts WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL)",
      [companyId]
    );
    const existingCodes = new Set(rows.map(r => r.code));
    const toAdd = DEFAULT_ACCOUNTS.filter(a => !existingCodes.has(a.code));
    for (const a of toAdd) {
      const accId = `acc_seed_${a.code}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const acc = { id: accId, ...a, active: true, history: [{ action: "create", user, at: now }] };
      await pool.query(
        "INSERT INTO accounts (id, company_id, data) VALUES ($1,$2,$3) ON CONFLICT (company_id, id) DO NOTHING",
        [accId, companyId, acc]
      );
    }
    res.json({ ok: true, added: toAdd.length, accounts: toAdd });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// 비용계정 선택용 최소 조회 — 사업계획(전 역할 공개) 작성 화면의 "비용계정" 검색선택
// 필드가 실제 회계 계정과목을 참조해야 하는데, 전체 계정과목 조회(위 GET .../accounts)는
// 회계 모듈 전체가 admin 전용이라 그대로 재사용하면 일반 직원은 사업계획을 작성할 수
// 없게 된다. 비용(type==="expense") 계정의 코드/이름만 반환해 회계 모듈의 다른 민감
// 정보(원가구분·변경이력 등)는 노출하지 않는다.
app.get("/api/accounting/accounts/expense-lite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    let accounts;
    if (USE_JSON_FILE) {
      accounts = _fileAccounting.accounts;
    } else {
      const companyId = req.auth.companyId || null;
      const { rows } = await pool.query(
        "SELECT id, data FROM accounts WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL) ORDER BY id",
        [companyId]
      );
      accounts = rows.map(r => ({ id: r.id, ...r.data }));
    }
    const lite = accounts
      .filter(a => a.type === "expense" && a.active !== false)
      .map(a => ({ id: a.id, code: a.code, name: a.name }));
    res.json({ ok: true, accounts: lite });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/accounting/accounts", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-accounts")) return;
    const { id, code, name, type, category, costCategory: costCategoryRaw, costSubType: costSubTypeRaw, active = true, user } = req.body || {};
    if (!code || !name || !type)
      return res.status(400).json({ ok: false, message: "계정코드, 계정명, 구분은 필수입니다." });
    // 원가구분: "mfg"(제조원가)|"sga"(판관비)|null. costSubType은 costCategory가 "mfg"일 때만
    // 의미가 있으므로 그 외에는 항상 null로 정규화한다(원가명세서 집계 로직이 이 불변조건에 의존).
    const costCategory = ["mfg", "sga"].includes(costCategoryRaw) ? costCategoryRaw : null;
    const costSubType = costCategory === "mfg" && ["material", "labor", "overhead"].includes(costSubTypeRaw) ? costSubTypeRaw : null;
    const accId = id || `acc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (USE_JSON_FILE) {
      const idx = _fileAccounting.accounts.findIndex(a => a.id === accId);
      // 계정코드는 회사 내에서 유일해야 한다 — 그렇지 않으면 같은 코드를 가리키는
      // 서로 다른 계정이 여러 개 생겨(예: "TEST-100"이 3건) 전표 계정 선택·집계에서
      // 어느 것을 골랐는지 알 수 없는 혼란이 생긴다(실측 재현으로 발견).
      const dup = _fileAccounting.accounts.find(a => a.id !== accId && !a.isDeleted && a.code === code);
      if (dup) return res.status(400).json({ ok: false, message: `이미 사용 중인 계정코드입니다: ${code} (${dup.name})` });
      const prevHist = idx >= 0 ? (_fileAccounting.accounts[idx].history || []) : [];
      const histEntry = { action: idx >= 0 ? "update" : "create", user: user || "unknown", at: new Date().toISOString() };
      const acc = { id: accId, code, name, type, category: category || "", costCategory, costSubType, active, history: [...prevHist, histEntry] };
      if (idx >= 0) _fileAccounting.accounts[idx] = acc; else _fileAccounting.accounts.push(acc);
      _saveFileAccounting();
      return res.json({ ok: true, account: acc });
    }
    const companyId = req.auth.companyId || null;
    const { rows: dupRows } = await pool.query(
      "SELECT data FROM accounts WHERE id <> $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL) AND data->>'code' = $3 LIMIT 1",
      [accId, companyId, code]
    );
    if (dupRows.length) return res.status(400).json({ ok: false, message: `이미 사용 중인 계정코드입니다: ${code} (${dupRows[0].data.name})` });
    const { rows: prevRows } = await pool.query(
      "SELECT data FROM accounts WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [accId, companyId]
    );
    const prevHist = prevRows.length ? (prevRows[0].data.history || []) : [];
    const histEntry = { action: prevRows.length ? "update" : "create", user: user || "unknown", at: new Date().toISOString() };
    const acc = { id: accId, code, name, type, category: category || "", costCategory, costSubType, active, history: [...prevHist, histEntry] };
    await pool.query(
      "INSERT INTO accounts (id, company_id, data) VALUES ($1,$2,$3) ON CONFLICT (company_id, id) DO UPDATE SET data = $3, updated_at = NOW()",
      [accId, companyId, acc]
    );
    res.json({ ok: true, account: acc });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/accounting/accounts/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-accounts")) return;
    const id = req.params.id;
    if (USE_JSON_FILE) {
      const used = _fileAccounting.vouchers.some(v => (v.lines || []).some(l => l.accountId === id));
      if (used) return res.status(400).json({ ok: false, message: "전표에서 사용 중인 계정과목은 삭제할 수 없습니다. 비활성화를 이용하세요." });
      _fileAccounting.accounts = _fileAccounting.accounts.filter(a => a.id !== id);
      _saveFileAccounting();
      return res.json({ ok: true });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query(
      "SELECT 1 FROM vouchers WHERE data->'lines' @> $1::jsonb AND (company_id = $2 OR company_id IS NULL) LIMIT 1",
      [JSON.stringify([{ accountId: id }]), companyId]
    );
    if (rows.length) return res.status(400).json({ ok: false, message: "전표에서 사용 중인 계정과목은 삭제할 수 없습니다. 비활성화를 이용하세요." });
    await pool.query(
      "UPDATE accounts SET is_deleted = TRUE WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, companyId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 전표 (Journal vouchers) ──────────────────────────────────────────────────
// dbClient: 호출부가 이미 FOR UPDATE 잠금을 쥔 트랜잭션 안에서 이 함수를 호출하는 경우
// (예: RCPS/고정자산 상각전표 발행이 _issuePostedVoucher()에 externalClient를 넘길 때) 그
// client를 그대로 재사용해야 한다 — 항상 pool.query()로 새 커넥션을 요청하면, 동시 요청이
// 많아 풀(max 20)이 전부 그 잠금 트랜잭션들로 채워졌을 때 이 추가 조회가 빈 커넥션을 영원히
// 기다리는 자기교착에 빠진다(채용 모듈 _pgLockedUpdate·budget.js getTeamDept()에서 이미
// 겪은 것과 동일한 클래스 — 실측: 동시 25건 발행 시 24건이 5초 뒤 커넥션 타임아웃으로 실패).
async function _getAccountsList(companyId, dbClient) {
  if (USE_JSON_FILE) return _fileAccounting.accounts;
  const { rows } = await (dbClient || pool).query(
    "SELECT id, data FROM accounts WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL)", [companyId || null]
  );
  return rows.map(r => ({ id: r.id, ...r.data }));
}
// 견적서 출고/발주서 입고 시 자동 발행되는 세금계산서에 거래처 마스터의 사업자번호를 채워 넣는다.
// (수동 발행 세금계산서는 클라이언트가 거래처 선택 시 자동으로 채워 보내지만, 자동 발행 경로는
// 거래처 마스터를 조회하지 않고 항상 빈 문자열을 넣고 있어 거래처 정보 불일치가 발생했었다.)
async function _lookupPartnerBizNo(partnerId, companyId, dbClient) {
  if (!partnerId) return "";
  if (USE_JSON_FILE) {
    const p = _fileAccounting.partners.find(p => p.id === partnerId);
    return p?.bizNo || "";
  }
  const { rows } = await (dbClient || pool).query(
    "SELECT data FROM partners WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [partnerId, companyId || null]
  );
  return rows[0]?.data?.bizNo || "";
}
function _validateVoucherLines(lines, accounts) {
  if (!Array.isArray(lines) || lines.length < 2) return "전표에는 2개 이상의 분개 라인이 필요합니다.";
  const accById = new Map(accounts.map(a => [a.id, a]));
  for (const l of lines) {
    const acc = accById.get(l.accountId);
    if (!acc) return `존재하지 않는 계정과목입니다: ${l.accountId}`;
    if (acc.active === false) return `미사용 처리된 계정과목은 전표에 사용할 수 없습니다: ${acc.code} ${acc.name}`;
    if ((Number(l.debit) || 0) > 0 && (Number(l.credit) || 0) > 0) return "한 라인에 차변과 대변을 동시에 입력할 수 없습니다.";
  }
  const debitSum = _round2(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const creditSum = _round2(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0));
  if (debitSum !== creditSum) return `차변 합계(${debitSum})와 대변 합계(${creditSum})가 일치하지 않습니다.`;
  if (debitSum <= 0) return "전표 금액은 0보다 커야 합니다.";
  return null;
}

app.get("/api/accounting/vouchers", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const year = req.query.year ? parseInt(req.query.year) : null;
    if (USE_JSON_FILE) {
      let list = _fileAccounting.vouchers;
      if (year) list = list.filter(v => new Date(v.date).getFullYear() === year);
      return res.json({ ok: true, vouchers: list.sort((a, b) => b.date.localeCompare(a.date)) });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = year
      ? await pool.query("SELECT data FROM vouchers WHERE EXTRACT(YEAR FROM voucher_date) = $1 AND (company_id = $2 OR company_id IS NULL) ORDER BY voucher_date DESC", [year, companyId])
      : await pool.query("SELECT data FROM vouchers WHERE (company_id = $1 OR company_id IS NULL) ORDER BY voucher_date DESC", [companyId]);
    res.json({ ok: true, vouchers: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/accounting/vouchers", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const { date, description, partner, partnerId, lines, user: createdBy } = req.body || {};
    if (!date) return res.status(400).json({ ok: false, message: "전표일자는 필수입니다." });
    const accounts = await _getAccountsList(companyId);
    const err = _validateVoucherLines(lines, accounts);
    if (err) return res.status(400).json({ ok: false, message: err });
    const debitSum = _round2(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0));
    const voucher = {
      id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      voucherNo: null, status: "draft",
      date, description: description || "", partner: partner || "", partnerId: partnerId || null,
      lines: lines.map(l => ({ accountId: l.accountId, debit: _round2(l.debit) || 0, credit: _round2(l.credit) || 0, memo: l.memo || "" })),
      amount: debitSum,
      createdBy: createdBy || "unknown", createdAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      _fileAccounting.vouchers.push(voucher);
      _saveFileAccounting();
      return res.json({ ok: true, voucher });
    }
    await pool.query("INSERT INTO vouchers (id, voucher_no, voucher_date, status, data, company_id) VALUES ($1,$2,$3,'draft',$4,$5)",
      [voucher.id, `DRAFT-${voucher.id}`, date, voucher, companyId]);
    res.json({ ok: true, voucher });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/accounting/vouchers/:id/post", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-vouchers")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const year = new Date().getFullYear();
    if (USE_JSON_FILE) {
      const v = _fileAccounting.vouchers.find(v => v.id === id);
      if (!v) return res.status(404).json({ ok: false, message: "전표를 찾을 수 없습니다." });
      if (v.status !== "draft") return res.status(400).json({ ok: false, message: "임시 저장 상태의 전표만 확정할 수 있습니다." });
      const seq = _nextAcctSeq("voucherSeq", year);
      v.voucherNo = `JE-${year}-${String(seq).padStart(6, "0")}`;
      v.status = "posted";
      v.postedBy = req.body.user || "unknown";
      v.postedAt = new Date().toISOString();
      _saveFileAccounting();
      return res.json({ ok: true, voucher: v });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data, status FROM vouchers WHERE id = $1 AND (company_id = $2 OR company_id IS NULL) FOR UPDATE", [id, companyId]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "전표를 찾을 수 없습니다." }); }
      if (rows[0].status !== "draft") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "임시 저장 상태의 전표만 확정할 수 있습니다." }); }
      const { rows: seqRows } = await client.query(
        "INSERT INTO voucher_seq (company_id, year, seq) VALUES ($1,$2,1) ON CONFLICT (company_id, year) DO UPDATE SET seq = voucher_seq.seq + 1 RETURNING seq",
        [companyId, year]
      );
      const voucherNo = `JE-${year}-${String(seqRows[0].seq).padStart(6, "0")}`;
      const v = { ...rows[0].data, voucherNo, status: "posted", postedBy: req.body.user || "unknown", postedAt: new Date().toISOString() };
      await client.query("UPDATE vouchers SET voucher_no = $2, status = 'posted', data = $3, updated_at = NOW() WHERE id = $1", [id, voucherNo, v]);
      await client.query("COMMIT");
      res.json({ ok: true, voucher: v });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// 감가상각(고정자산)·유효이자율 상각(RCPS) 전표는 발행 시 해당 회차 스케줄을
// status:"posted" + voucherId로 표시한다. 그런데 전표 취소(void)는 전표 status만 바꾸고
// 스케줄은 건드리지 않아, 취소된 전표를 가리키는 스케줄이 영구히 "posted"로 남았다 —
// 그 회차는 재발행도 안 되고("이미 전표가 발행된 연도입니다"), 자산 삭제·취득조건 수정도
// "발행된 전표가 있다"는 이유로 막혀, 화면에서 되돌릴 방법이 전혀 없는 상태가 됐다.
// 전표를 취소하면 그 전표가 만든 스케줄 표시도 함께 되돌린다(취소의 자연스러운 역연산).
function _unpostScheduleRowsJson(voucherId) {
  let n = 0;
  for (const [store, save] of [[_fileAcctFixedAssets, _saveFileAcctFixedAssets], [_fileAcctRcps, _saveFileAcctRcps]]) {
    if (!store || !Array.isArray(store.schedule)) continue;
    let touched = false;
    for (const s of store.schedule) {
      if (s.voucherId === voucherId) {
        s.status = "pending"; s.voucherId = null; touched = true; n++;
      }
    }
    if (touched) save();
  }
  return n;
}
async function _unpostScheduleRowsPg(voucherId, companyId, client) {
  let n = 0;
  for (const table of ["fixed_asset_depreciation_schedule", "rcps_amortization_schedule"]) {
    const r = await client.query(
      `UPDATE ${table} SET data = data || jsonb_build_object('status','pending','voucherId',NULL), updated_at = NOW()
       WHERE data->>'voucherId' = $1 AND (company_id = $2 OR company_id IS NULL)`,
      [voucherId, companyId]
    );
    n += r.rowCount || 0;
  }
  return n;
}
app.post("/api/accounting/vouchers/:id/void", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-vouchers")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const reason = (req.body || {}).reason;
    if (!reason) return res.status(400).json({ ok: false, message: "취소 사유를 입력하세요." });
    if (USE_JSON_FILE) {
      const v = _fileAccounting.vouchers.find(v => v.id === id);
      if (!v) return res.status(404).json({ ok: false, message: "전표를 찾을 수 없습니다." });
      if (v.status !== "posted") return res.status(400).json({ ok: false, message: "확정된 전표만 취소할 수 있습니다." });
      v.status = "void"; v.voidReason = reason; v.voidedBy = req.body.user || "unknown"; v.voidedAt = new Date().toISOString();
      _saveFileAccounting();
      const unposted = _unpostScheduleRowsJson(id);
      return res.json({ ok: true, voucher: v, unpostedSchedules: unposted });
    }
    // 전표 취소와 스케줄 되돌리기는 한 트랜잭션이어야 한다 — 중간에 실패해 전표만 취소되면
    // 원래 고치려던 "되돌릴 수 없는 상태"가 그대로 다시 만들어진다.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM vouchers WHERE id = $1 AND status = 'posted' AND (company_id = $2 OR company_id IS NULL) FOR UPDATE", [id, companyId]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "확정된 전표만 취소할 수 있습니다." }); }
      const v = { ...rows[0].data, status: "void", voidReason: reason, voidedBy: req.body.user || "unknown", voidedAt: new Date().toISOString() };
      await client.query("UPDATE vouchers SET status = 'void', data = $2, updated_at = NOW() WHERE id = $1", [id, v]);
      const unposted = await _unpostScheduleRowsPg(id, companyId, client);
      await client.query("COMMIT");
      res.json({ ok: true, voucher: v, unpostedSchedules: unposted });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.delete("/api/accounting/vouchers/:id", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-vouchers")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    if (USE_JSON_FILE) {
      const v = _fileAccounting.vouchers.find(v => v.id === id);
      if (!v) return res.status(404).json({ ok: false, message: "전표를 찾을 수 없습니다." });
      if (v.status !== "draft") return res.status(400).json({ ok: false, message: "임시 저장 상태의 전표만 삭제할 수 있습니다." });
      _fileAccounting.vouchers = _fileAccounting.vouchers.filter(v => v.id !== id);
      _saveFileAccounting();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT 1 FROM vouchers WHERE id = $1 AND status = 'draft' AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "임시 저장 상태의 전표만 삭제할 수 있습니다." });
    await pool.query("DELETE FROM vouchers WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 세금계산서 (사내 발행용) ──────────────────────────────────────────────────
function _buildTaxInvoiceTotals(items) {
  const lines = (items || []).map(it => {
    const supplyAmount = _round2((Number(it.qty) || 0) * (Number(it.unitPrice) || 0));
    const taxAmount = _round2(supplyAmount * 0.1);
    return { name: it.name || "", qty: Number(it.qty) || 0, unitPrice: Number(it.unitPrice) || 0, supplyAmount, taxAmount };
  });
  const supplyTotal = _round2(lines.reduce((s, l) => s + l.supplyAmount, 0));
  const taxTotal = _round2(lines.reduce((s, l) => s + l.taxAmount, 0));
  return { lines, supplyTotal, taxTotal, grandTotal: _round2(supplyTotal + taxTotal) };
}

app.get("/api/accounting/tax-invoices", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const year = req.query.year ? parseInt(req.query.year) : null;
    if (USE_JSON_FILE) {
      let list = _fileAccounting.taxInvoices;
      if (year) list = list.filter(t => new Date(t.issueDate).getFullYear() === year);
      return res.json({ ok: true, taxInvoices: list.sort((a, b) => b.issueDate.localeCompare(a.issueDate)) });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = year
      ? await pool.query("SELECT data FROM tax_invoices WHERE EXTRACT(YEAR FROM issue_date) = $1 AND (company_id = $2 OR company_id IS NULL) ORDER BY issue_date DESC", [year, companyId])
      : await pool.query("SELECT data FROM tax_invoices WHERE (company_id = $1 OR company_id IS NULL) ORDER BY issue_date DESC", [companyId]);
    res.json({ ok: true, taxInvoices: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/accounting/tax-invoices", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const { issueDate, partnerId, partnerName, partnerBizNo, items, user: createdBy } = req.body || {};
    if (!issueDate || !partnerName) return res.status(400).json({ ok: false, message: "발행일과 거래처명은 필수입니다." });
    // 발행일이 "존재하기만 하면" 통과시키고 있어 파싱 불가능한 값도 그대로 들어왔다(고정자산
    // 취득일과 동일한 클래스의 버그, _isValidDateStr 주석 참고) — 실측: issueDate:"not-a-date"로
    // 발행하면 year=NaN이 되어 invoiceNo가 "TI-NaN-000001"로 발급되고, 조회(GET .../tax-invoices?
    // year=)의 연도 필터(new Date(t.issueDate).getFullYear()===year)가 NaN과는 절대 일치하지
    // 않아 이 세금계산서가 어떤 연도별 조회·부가세 신고자료(vat-report)에도 잡히지 않는
    // "존재하지만 영원히 안 보이는" 세금계산서가 됐다. YYYY-MM-DD 형식 검증 + 1900~2100년
    // 범위(실제 세금계산서 발행일로 있을 수 없는 극단값 차단, 정상 소급/미래 발행은 허용)로 제한.
    if (!_isValidDateStr(issueDate)) return res.status(400).json({ ok: false, message: "발행일이 올바른 날짜가 아닙니다(YYYY-MM-DD)." });
    const issueYear = new Date(issueDate).getFullYear();
    if (issueYear < 1900 || issueYear > 2100) return res.status(400).json({ ok: false, message: "발행일이 유효한 범위를 벗어났습니다(1900~2100년)." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, message: "품목을 1개 이상 입력하세요." });
    const totals = _buildTaxInvoiceTotals(items);
    const year = new Date(issueDate).getFullYear();
    const direction = req.body.direction === "purchase" ? "purchase" : "sales";
    const inv = {
      id: `ti_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      invoiceNo: null, status: "issued", direction,
      issueDate, partnerId: partnerId || null, partnerName, partnerBizNo: partnerBizNo || "",
      ...totals,
      createdBy: createdBy || "unknown", createdAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      const seq = _nextAcctSeq("taxInvoiceSeq", year);
      inv.invoiceNo = `TI-${year}-${String(seq).padStart(6, "0")}`;
      _fileAccounting.taxInvoices.push(inv);
      _saveFileAccounting();
      return res.json({ ok: true, taxInvoice: inv });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: seqRows } = await client.query(
        "INSERT INTO tax_invoice_seq (company_id, year, seq) VALUES ($1,$2,1) ON CONFLICT (company_id, year) DO UPDATE SET seq = tax_invoice_seq.seq + 1 RETURNING seq",
        [companyId, year]
      );
      inv.invoiceNo = `TI-${year}-${String(seqRows[0].seq).padStart(6, "0")}`;
      await client.query("INSERT INTO tax_invoices (id, invoice_no, issue_date, status, data, company_id) VALUES ($1,$2,$3,'issued',$4,$5)",
        [inv.id, inv.invoiceNo, issueDate, inv, companyId]);
      await client.query("COMMIT");
      res.json({ ok: true, taxInvoice: inv });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/accounting/tax-invoices/:id/void", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-tax-invoices")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const reason = (req.body || {}).reason;
    if (!reason) return res.status(400).json({ ok: false, message: "취소 사유를 입력하세요." });
    if (USE_JSON_FILE) {
      const inv = _fileAccounting.taxInvoices.find(t => t.id === id);
      if (!inv) return res.status(404).json({ ok: false, message: "세금계산서를 찾을 수 없습니다." });
      if (inv.status !== "issued") return res.status(400).json({ ok: false, message: "발행된 세금계산서만 취소할 수 있습니다." });
      inv.status = "void"; inv.voidReason = reason; inv.voidedBy = req.body.user || "unknown"; inv.voidedAt = new Date().toISOString();
      _saveFileAccounting();
      return res.json({ ok: true, taxInvoice: inv });
    }
    const { rows } = await pool.query("SELECT data FROM tax_invoices WHERE id = $1 AND status = 'issued' AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "발행된 세금계산서만 취소할 수 있습니다." });
    const inv = { ...rows[0].data, status: "void", voidReason: reason, voidedBy: req.body.user || "unknown", voidedAt: new Date().toISOString() };
    await pool.query("UPDATE tax_invoices SET status = 'void', data = $2, updated_at = NOW() WHERE id = $1", [id, inv]);
    res.json({ ok: true, taxInvoice: inv });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 수금/지급 (AR/AP payments — 거래처별 미수·미지급 관리) ────────────────────
// JSON 모드: _fileAccounting.payments / PG 모드: app_collections(acctPayments)
// company_id (2단계, 2026-07-21 발견·수정): 이 3개 라우트는 loadData()/_persistDataLocked()를
// 거치지 않고 app_collections를 직접 쿼리하고 있어, 회사 스코프 배선 대상에서 완전히 누락돼
// 있었다 — 회사 B의 admin이 자기 회사에 로그인한 채로 이 API를 호출하면 회사 A를 포함한
// 전 회사의 수금/지급 내역(거래처명·금액)을 그대로 보고 삭제까지 할 수 있는 상태였다.
// acctPayments는 id에 `pay_${Date.now()}_${random}`을 쓰므로 회사 간 id 충돌 가능성은 사실상
// 없지만(실사용상 문제였던 건 id 충돌이 아니라 스코프 누락 그 자체), 그래도 다른 라우트들과
// 동일한 컬럼 구조(company_id가 PK의 일부)를 그대로 쓰므로 조회/쓰기/삭제 모두 일관되게
// company_id를 채워 넣는다.
app.get("/api/accounting/payments", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, payments: _fileAccounting.payments || [] });
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query(
      "SELECT data FROM app_collections WHERE collection = 'acctPayments' AND (company_id = $1 OR company_id IS NULL) ORDER BY created_at",
      [companyId]
    );
    res.json({ ok: true, payments: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});
app.post("/api/accounting/payments", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-receivables")) return;
    const { direction, date, partnerId, partnerName, amount, method, memo, taxInvoiceId, user } = req.body || {};
    if (!["in", "out"].includes(direction)) return res.status(400).json({ ok: false, message: "direction은 in(수금) 또는 out(지급)이어야 합니다." });
    if (!date || !partnerName || !(Number(amount) > 0)) return res.status(400).json({ ok: false, message: "일자, 거래처, 금액(0보다 큼)은 필수입니다." });
    const payment = {
      id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      direction, date, partnerId: partnerId || null, partnerName,
      amount: _round2(amount), method: method || "계좌이체", memo: memo || "",
      taxInvoiceId: taxInvoiceId || null,
      createdBy: user || "unknown", createdAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      if (!_fileAccounting.payments) _fileAccounting.payments = [];
      _fileAccounting.payments.push(payment);
      _saveFileAccounting();
      return res.json({ ok: true, payment });
    }
    const companyId = req.auth.companyId || null;
    await pool.query(
      "INSERT INTO app_collections (collection, id, company_id, data, updated_at) VALUES ('acctPayments',$1,$2,$3,NOW())",
      [payment.id, companyId, payment]
    );
    res.json({ ok: true, payment });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});
app.post("/api/accounting/payments/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-receivables")) return;
    const id = req.params.id;
    // 존재하지 않는 id로 삭제해도 200 {ok:true}를 돌려주고 있어(다른 모듈은 전부 404),
    // 화면은 "삭제되었습니다"를 띄우는데 실제로는 아무것도 지워지지 않은 상태와
    // 정상 삭제를 구분할 수 없었다. 실제로 지운 건수를 보고 판정한다.
    if (USE_JSON_FILE) {
      const before = (_fileAccounting.payments || []).length;
      _fileAccounting.payments = (_fileAccounting.payments || []).filter(p => p.id !== id);
      if (_fileAccounting.payments.length === before) {
        return res.status(404).json({ ok: false, message: "수금/지급 내역을 찾을 수 없습니다." });
      }
      _saveFileAccounting();
      return res.json({ ok: true });
    }
    const companyId = req.auth.companyId || null;
    const delRes = await pool.query(
      "DELETE FROM app_collections WHERE collection = 'acctPayments' AND id = $1 AND (company_id = $2 OR $2 IS NULL)",
      [id, companyId]
    );
    if (!delRes.rowCount) return res.status(404).json({ ok: false, message: "수금/지급 내역을 찾을 수 없습니다." });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 거래처 (Business partners — customer/vendor master data) ─────────────────
app.get("/api/accounting/partners", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, partners: _fileAccounting.partners });
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query(
      "SELECT id, data FROM partners WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL) ORDER BY id", [companyId]
    );
    res.json({ ok: true, partners: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/accounting/partners", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const { id, name, bizNo, ceoName, type, address, contactName, phone, email, registerReason, attachments, active = true, user } = req.body || {};
    if (!name || !type)
      return res.status(400).json({ ok: false, message: "거래처명, 거래유형은 필수입니다." });
    const partnerId = id || `partner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (USE_JSON_FILE) {
      const idx = _fileAccounting.partners.findIndex(p => p.id === partnerId);
      const prevHist = idx >= 0 ? (_fileAccounting.partners[idx].history || []) : [];
      const histEntry = { action: idx >= 0 ? "update" : "create", user: user || "unknown", at: new Date().toISOString() };
      const partner = {
        id: partnerId, name, bizNo: bizNo || "", ceoName: ceoName || "", type,
        address: address || "", contactName: contactName || "", phone: phone || "", email: email || "",
        registerReason: registerReason || (idx >= 0 ? _fileAccounting.partners[idx].registerReason : "") || "",
        attachments: attachments || (idx >= 0 ? _fileAccounting.partners[idx].attachments : []) || [],
        active, history: [...prevHist, histEntry],
      };
      if (idx >= 0) _fileAccounting.partners[idx] = partner; else _fileAccounting.partners.push(partner);
      _saveFileAccounting();
      return res.json({ ok: true, partner });
    }
    const { rows: prevRows } = await pool.query(
      "SELECT data FROM partners WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [partnerId, companyId]
    );
    const prevHist = prevRows.length ? (prevRows[0].data.history || []) : [];
    const histEntry = { action: prevRows.length ? "update" : "create", user: user || "unknown", at: new Date().toISOString() };
    const partner = {
      id: partnerId, name, bizNo: bizNo || "", ceoName: ceoName || "", type,
      address: address || "", contactName: contactName || "", phone: phone || "", email: email || "",
      registerReason: registerReason || (prevRows[0]?.data.registerReason) || "",
      attachments: attachments || (prevRows[0]?.data.attachments) || [],
      active, history: [...prevHist, histEntry],
    };
    await pool.query(
      "INSERT INTO partners (id, company_id, data) VALUES ($1,$2,$3) ON CONFLICT (company_id, id) DO UPDATE SET data = $3, updated_at = NOW()",
      [partnerId, companyId, partner]
    );
    res.json({ ok: true, partner });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/accounting/partners/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-partners")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    if (USE_JSON_FILE) {
      const used = _fileAccounting.vouchers.some(v => v.partnerId === id) || _fileAccounting.taxInvoices.some(t => t.partnerId === id);
      if (used) return res.status(400).json({ ok: false, message: "전표 또는 세금계산서에서 사용 중인 거래처는 삭제할 수 없습니다. 비활성화를 이용하세요." });
      _fileAccounting.partners = _fileAccounting.partners.filter(p => p.id !== id);
      _saveFileAccounting();
      return res.json({ ok: true });
    }
    const { rows: vRows } = await pool.query("SELECT 1 FROM vouchers WHERE data->>'partnerId' = $1 AND (company_id = $2 OR company_id IS NULL) LIMIT 1", [id, companyId]);
    const { rows: tRows } = await pool.query("SELECT 1 FROM tax_invoices WHERE data->>'partnerId' = $1 AND (company_id = $2 OR company_id IS NULL) LIMIT 1", [id, companyId]);
    if (vRows.length || tRows.length) return res.status(400).json({ ok: false, message: "전표 또는 세금계산서에서 사용 중인 거래처는 삭제할 수 없습니다. 비활성화를 이용하세요." });
    await pool.query("UPDATE partners SET is_deleted = TRUE WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 원가명세서 (Cost statement) ───────────────────────────────────────────────
// 계정과목에 태깅된 원가구분(costCategory/costSubType)을 기준으로, 확정(posted)된 전표의
// 분개 라인 중 원가계정에 해당하는 것만(costCategory가 null이 아닌 계정) 차변 금액으로 집계한다.
app.get("/api/accounting/cost-statement", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ ok: false, message: "from, to 날짜 범위는 필수입니다." });
    const companyId = req.auth.companyId || null;
    let vouchers;
    if (USE_JSON_FILE) {
      vouchers = _fileAccounting.vouchers.filter(v => v.status === "posted" && v.date >= from && v.date <= to);
    } else {
      const { rows } = await pool.query(
        "SELECT data FROM vouchers WHERE status = 'posted' AND voucher_date BETWEEN $1 AND $2 AND (company_id = $3 OR company_id IS NULL)",
        [from, to, companyId]
      );
      vouchers = rows.map(r => r.data);
    }
    const accounts = await _getAccountsList(companyId);
    const accById = new Map(accounts.map(a => [a.id, a]));
    const mfg = { material: 0, labor: 0, overhead: 0, total: 0 };
    const sga = { total: 0 };
    const byAccountMap = new Map();
    for (const v of vouchers) {
      for (const l of (v.lines || [])) {
        const acc = accById.get(l.accountId);
        if (!acc || !acc.costCategory) continue;
        const amount = _round2(l.debit) || 0;
        if (amount === 0) continue;
        if (acc.costCategory === "mfg") {
          mfg.total = _round2(mfg.total + amount);
          if (["material", "labor", "overhead"].includes(acc.costSubType)) {
            mfg[acc.costSubType] = _round2(mfg[acc.costSubType] + amount);
          }
        } else if (acc.costCategory === "sga") {
          sga.total = _round2(sga.total + amount);
        } else {
          continue; // 알 수 없는 원가구분 값은 집계에서 제외
        }
        const prev = byAccountMap.get(l.accountId) || {
          accountId: l.accountId, code: acc.code, name: acc.name,
          costCategory: acc.costCategory, costSubType: acc.costSubType || null, amount: 0,
        };
        prev.amount = _round2(prev.amount + amount);
        byAccountMap.set(l.accountId, prev);
      }
    }
    res.json({ ok: true, from, to, mfg, sga, byAccount: Array.from(byAccountMap.values()) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── RCPS(상환전환우선주) 발행·유효이자율법 상각·공정가치평가 ──────────────────────
// 연 1회 이자지급·연단위 상각을 가정하는 단순화 모델이다(반기/월할 계산은 다루지 않음).
// company_id는 이 모듈의 3개 테이블 모두 NOT NULL(레거시 데이터 없음, 백필 불필요)이므로
// req.auth.companyId를 항상 그대로 채워 넣는다 — accounts/vouchers류처럼 "OR company_id IS NULL"
// 로 레거시 단일회사 데이터를 함께 허용할 필요가 없다.
function _yearsBetween(d1, d2) {
  const ms = new Date(d2) - new Date(d1);
  return Math.round(ms / (365.25 * 86400000));
}
function _addYearsStr(dateStr, k) {
  const d = new Date(dateStr);
  d.setUTCFullYear(d.getUTCFullYear() + k);
  return d.toISOString().slice(0, 10);
}
// 전표를 곧바로 "확정(posted)" 상태로 생성한다 — 기존 POST vouchers(draft 생성) +
// POST vouchers/:id/post(확정) 2단계 흐름과 완전히 동일한 company_id 스코프·차대검증
// (_validateVoucherLines)·voucher_seq 채번 로직을 그대로 재사용해, RCPS 자동 전표(상각/평가손익)를
// 한 번의 호출로 발행한다. 검증 실패 시 statusCode:400을 실어 던진다(호출부에서 그대로 응답).
// externalClient: 호출부가 이미 트랜잭션을 열어둔 pg client가 있으면(예: 다른 행에 FOR UPDATE
// 잠금을 건 상태) 그 커넥션을 그대로 재사용해 INSERT까지 처리한다 — 잠금을 쥔 채로 별도
// pool.connect()를 또 호출하면(동시 요청이 많을 때 잠금 대기자들이 커넥션 풀을 다 점유해)
// 커넥션 풀 고갈로 데드락에 준하는 상태에 빠질 수 있어, 이 경우 BEGIN/COMMIT/release는
// 호출부 책임으로 남기고 여기서는 쿼리만 실행한다.
async function _issuePostedVoucher(companyId, { date, description, partnerId, partner, lines, user }, externalClient) {
  const accounts = await _getAccountsList(companyId, externalClient);
  const err = _validateVoucherLines(lines, accounts);
  if (err) throw Object.assign(new Error(err), { statusCode: 400 });
  const debitSum = _round2(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const year = new Date(date).getFullYear();
  const baseVoucher = {
    id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    date, description: description || "", partner: partner || "", partnerId: partnerId || null,
    lines: lines.map(l => ({ accountId: l.accountId, debit: _round2(l.debit) || 0, credit: _round2(l.credit) || 0, memo: l.memo || "" })),
    amount: debitSum,
    createdBy: user || "unknown", createdAt: new Date().toISOString(),
  };
  if (USE_JSON_FILE) {
    const seq = _nextAcctSeq("voucherSeq", year);
    const voucher = { ...baseVoucher, voucherNo: `JE-${year}-${String(seq).padStart(6, "0")}`, status: "posted", postedBy: user || "unknown", postedAt: new Date().toISOString() };
    _fileAccounting.vouchers.push(voucher);
    _saveFileAccounting();
    return voucher;
  }
  if (externalClient) {
    const { rows: seqRows } = await externalClient.query(
      "INSERT INTO voucher_seq (company_id, year, seq) VALUES ($1,$2,1) ON CONFLICT (company_id, year) DO UPDATE SET seq = voucher_seq.seq + 1 RETURNING seq",
      [companyId, year]
    );
    const voucherNo = `JE-${year}-${String(seqRows[0].seq).padStart(6, "0")}`;
    const voucher = { ...baseVoucher, voucherNo, status: "posted", postedBy: user || "unknown", postedAt: new Date().toISOString() };
    await externalClient.query("INSERT INTO vouchers (id, voucher_no, voucher_date, status, data, company_id) VALUES ($1,$2,$3,'posted',$4,$5)",
      [voucher.id, voucherNo, date, voucher, companyId]);
    return voucher; // BEGIN/COMMIT/ROLLBACK/release는 호출부 책임
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: seqRows } = await client.query(
      "INSERT INTO voucher_seq (company_id, year, seq) VALUES ($1,$2,1) ON CONFLICT (company_id, year) DO UPDATE SET seq = voucher_seq.seq + 1 RETURNING seq",
      [companyId, year]
    );
    const voucherNo = `JE-${year}-${String(seqRows[0].seq).padStart(6, "0")}`;
    const voucher = { ...baseVoucher, voucherNo, status: "posted", postedBy: user || "unknown", postedAt: new Date().toISOString() };
    await client.query("INSERT INTO vouchers (id, voucher_no, voucher_date, status, data, company_id) VALUES ($1,$2,$3,'posted',$4,$5)",
      [voucher.id, voucherNo, date, voucher, companyId]);
    await client.query("COMMIT");
    return voucher;
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}

app.post("/api/accounting/rcps/issuances", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-rcps")) return;
    const companyId = req.auth.companyId || null;
    const { name, issueDate, faceAmount, sharesIssued, parValue, couponRate, effectiveRate, maturityDate, user } = req.body || {};
    let { redemptionAmount } = req.body || {};
    if (!name || !issueDate || !(Number(faceAmount) > 0) || couponRate === undefined || couponRate === null ||
        effectiveRate === undefined || effectiveRate === null || !maturityDate) {
      return res.status(400).json({ ok: false, message: "name, issueDate, faceAmount, couponRate, effectiveRate, maturityDate는 필수입니다." });
    }
    if (!(new Date(maturityDate) > new Date(issueDate))) {
      return res.status(400).json({ ok: false, message: "만기일은 발행일 이후여야 합니다." });
    }
    const faceAmt = Number(faceAmount);
    const coupon = Number(couponRate);
    const eff = Number(effectiveRate);
    // couponRate/effectiveRate는 소수 표기(예: 5%→0.05)를 가정한다. 음수(비정상적인 이자율)나
    // 1 이상(예: "150%"를 "1.5" 대신 "150"으로 잘못 입력)의 값은 계산 자체는 되지만 결과가
    // 명백히 무의미해지므로(예: 유효이자율 15000%) 여기서 막는다.
    if (!(coupon >= 0 && coupon < 1)) {
      return res.status(400).json({ ok: false, message: "couponRate는 0 이상 1 미만의 소수여야 합니다(예: 연 5% → 0.05)." });
    }
    if (!(eff >= 0 && eff < 1)) {
      return res.status(400).json({ ok: false, message: "effectiveRate는 0 이상 1 미만의 소수여야 합니다(예: 연 8% → 0.08)." });
    }
    redemptionAmount = _round2(redemptionAmount != null && redemptionAmount !== "" ? Number(redemptionAmount) : faceAmt);
    const N = _yearsBetween(issueDate, maturityDate);
    if (N < 1) return res.status(400).json({ ok: false, message: "발행일과 만기일 사이는 최소 1년 이상이어야 합니다." });

    // 유효이자율법 현재가치 계산: 매 회차 표시이자(statedInterestAmt) + 만기 상환금액을
    // 유효이자율로 할인 → 부채요소 최초 인식액. 발행총액과의 차액이 자본/파생상품 요소.
    const statedInterestAmt = _round2(faceAmt * coupon);
    let liabilityInitial = 0;
    for (let t = 1; t <= N; t++) liabilityInitial += statedInterestAmt / Math.pow(1 + eff, t);
    liabilityInitial += redemptionAmount / Math.pow(1 + eff, N);
    liabilityInitial = _round2(liabilityInitial);
    const equityResidual = _round2(faceAmt - liabilityInitial);

    const issuanceId = `rcps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const issuance = {
      id: issuanceId, name, issueDate, faceAmount: faceAmt,
      sharesIssued: sharesIssued != null && sharesIssued !== "" ? Number(sharesIssued) : null,
      parValue: parValue != null && parValue !== "" ? Number(parValue) : null,
      couponRate: coupon, effectiveRate: eff, maturityDate, redemptionAmount,
      liabilityInitial, equityResidual, status: "active", isDeleted: false,
      createdBy: user || "unknown", createdAt: new Date().toISOString(),
    };

    // 상각표 생성: 마지막 회차는 반올림 누적오차 보정을 위해 amortization을
    // (redemptionAmount - beginningBalance)로 강제해 endingBalance가 정확히 상환금액과 일치하게 만든다.
    const schedule = [];
    let beginningBalance = liabilityInitial;
    for (let seq = 1; seq <= N; seq++) {
      let effectiveInterest = _round2(beginningBalance * eff);
      const statedInterest = statedInterestAmt;
      let amortization = _round2(effectiveInterest - statedInterest);
      let endingBalance = _round2(beginningBalance + amortization);
      // periodDate는 원칙적으로 issueDate+seq년(연 1회 이자지급 가정)이지만, 마지막 회차만은
      // maturityDate가 정확히 그 연배수가 아닐 수 있어(N이 반올림으로 정해지므로) issueDate+N년이
      // 실제 만기일과 몇 달씩 어긋날 수 있다 — 그대로 두면 상환 시점보다 앞/뒤로 몇 달 어긋난
      // 날짜에 마지막 상각전표가 잡혀 실제 만기와 안 맞는다. endingBalance를 redemptionAmount로
      // 강제 보정하는 것과 동일한 취지로, 마지막 회차의 periodDate는 항상 실제 maturityDate로 맞춘다.
      const periodDate = seq === N ? maturityDate : _addYearsStr(issueDate, seq);
      if (seq === N) {
        amortization = _round2(redemptionAmount - beginningBalance);
        effectiveInterest = _round2(amortization + statedInterest);
        endingBalance = redemptionAmount;
      }
      schedule.push({
        id: `rcpssch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${seq}`,
        issuanceId, seq, periodDate,
        beginningBalance, statedInterest, effectiveInterest, amortization, endingBalance,
        status: "pending", voucherId: null,
      });
      beginningBalance = endingBalance;
    }

    if (USE_JSON_FILE) {
      _fileAcctRcps.issuances.push(issuance);
      _fileAcctRcps.schedule.push(...schedule);
      _saveFileAcctRcps();
      return res.json({ ok: true, issuance, schedule });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO rcps_issuances (id, company_id, data) VALUES ($1,$2,$3)", [issuanceId, companyId, issuance]);
      for (const s of schedule) {
        await client.query(
          "INSERT INTO rcps_amortization_schedule (id, issuance_id, company_id, seq, data) VALUES ($1,$2,$3,$4,$5)",
          [s.id, issuanceId, companyId, s.seq, s]
        );
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    res.json({ ok: true, issuance, schedule });
  } catch (e) { res.status(e.statusCode || 500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.get("/api/accounting/rcps/issuances", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (USE_JSON_FILE) {
      return res.json({ ok: true, issuances: _fileAcctRcps.issuances.filter(i => !i.isDeleted).sort((a, b) => b.issueDate.localeCompare(a.issueDate)) });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query(
      "SELECT id, data FROM rcps_issuances WHERE is_deleted = FALSE AND company_id = $1 ORDER BY data->>'issueDate' DESC",
      [companyId]
    );
    res.json({ ok: true, issuances: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.get("/api/accounting/rcps/issuances/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = req.params.id;
    if (USE_JSON_FILE) {
      const issuance = _fileAcctRcps.issuances.find(i => i.id === id && !i.isDeleted);
      if (!issuance) return res.status(404).json({ ok: false, message: "RCPS 발행 건을 찾을 수 없습니다." });
      const schedule = _fileAcctRcps.schedule.filter(s => s.issuanceId === id).sort((a, b) => a.seq - b.seq);
      const valuations = _fileAcctRcps.valuations.filter(v => v.issuanceId === id).sort((a, b) => a.valuationDate.localeCompare(b.valuationDate));
      return res.json({ ok: true, issuance, schedule, valuations });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query("SELECT data FROM rcps_issuances WHERE id = $1 AND company_id = $2 AND is_deleted = FALSE", [id, companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "RCPS 발행 건을 찾을 수 없습니다." });
    const issuance = { id, ...rows[0].data };
    const { rows: schedRows } = await pool.query("SELECT data FROM rcps_amortization_schedule WHERE issuance_id = $1 AND company_id = $2 ORDER BY seq", [id, companyId]);
    const { rows: valRows } = await pool.query("SELECT data FROM rcps_fair_value_valuations WHERE issuance_id = $1 AND company_id = $2 ORDER BY data->>'valuationDate'", [id, companyId]);
    res.json({ ok: true, issuance, schedule: schedRows.map(r => r.data), valuations: valRows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.get("/api/accounting/rcps/issuances/:id/schedule", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = req.params.id;
    if (USE_JSON_FILE) {
      return res.json({ ok: true, schedule: _fileAcctRcps.schedule.filter(s => s.issuanceId === id).sort((a, b) => a.seq - b.seq) });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query("SELECT data FROM rcps_amortization_schedule WHERE issuance_id = $1 AND company_id = $2 ORDER BY seq", [id, companyId]);
    res.json({ ok: true, schedule: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.get("/api/accounting/rcps/issuances/:id/valuations", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = req.params.id;
    if (USE_JSON_FILE) {
      return res.json({ ok: true, valuations: _fileAcctRcps.valuations.filter(v => v.issuanceId === id).sort((a, b) => a.valuationDate.localeCompare(b.valuationDate)) });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query("SELECT data FROM rcps_fair_value_valuations WHERE issuance_id = $1 AND company_id = $2 ORDER BY data->>'valuationDate'", [id, companyId]);
    res.json({ ok: true, valuations: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/accounting/rcps/issuances/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-rcps")) return;
    const id = req.params.id;
    if (USE_JSON_FILE) {
      const issuance = _fileAcctRcps.issuances.find(i => i.id === id && !i.isDeleted);
      if (!issuance) return res.status(404).json({ ok: false, message: "RCPS 발행 건을 찾을 수 없습니다." });
      const hasPosted = _fileAcctRcps.schedule.some(s => s.issuanceId === id && s.status === "posted");
      const hasValuation = _fileAcctRcps.valuations.some(v => v.issuanceId === id);
      if (hasPosted || hasValuation) return res.status(400).json({ ok: false, message: "이미 회계처리가 진행된 발행 건은 삭제할 수 없습니다." });
      issuance.isDeleted = true;
      _saveFileAcctRcps();
      return res.json({ ok: true });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query("SELECT 1 FROM rcps_issuances WHERE id = $1 AND company_id = $2 AND is_deleted = FALSE", [id, companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "RCPS 발행 건을 찾을 수 없습니다." });
    const { rows: postedRows } = await pool.query(
      "SELECT 1 FROM rcps_amortization_schedule WHERE issuance_id = $1 AND company_id = $2 AND data->>'status' = 'posted' LIMIT 1", [id, companyId]
    );
    const { rows: valRows } = await pool.query(
      "SELECT 1 FROM rcps_fair_value_valuations WHERE issuance_id = $1 AND company_id = $2 LIMIT 1", [id, companyId]
    );
    if (postedRows.length || valRows.length) return res.status(400).json({ ok: false, message: "이미 회계처리가 진행된 발행 건은 삭제할 수 없습니다." });
    await pool.query("UPDATE rcps_issuances SET is_deleted = TRUE WHERE id = $1 AND company_id = $2", [id, companyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// scheduleId 단위로 "동시에 처리 중"인 요청을 직렬화하기 위한 가드. JSON 파일 모드는
// (Postgres의 FOR UPDATE 잠금과 달리) 여러 요청이 각자 await 지점 사이에 인터리빙되며 같은
// scheduleId를 동시에 통과할 수 있어 — 상태 확인은 동기적이지만 전표 발행(_issuePostedVoucher)이
// 비동기라 그 사이에 다른 요청이 끼어들 수 있음 — 별도의 동기적 in-flight Set으로 막는다.
const _rcpsSchedulePostInFlight = new Set();

app.post("/api/accounting/rcps/schedule/:scheduleId/post", async (req, res) => {
  const scheduleId = req.params.scheduleId;
  let lockedJsonMode = false;
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-rcps")) return;
    const companyId = req.auth.companyId || null;
    const { user, interestExpenseAccountId, cashAccountId, rcpsLiabilityAccountId } = req.body || {};
    if (!interestExpenseAccountId || !cashAccountId || !rcpsLiabilityAccountId) {
      return res.status(400).json({ ok: false, message: "이자비용, 현금, RCPS부채 계정과목은 모두 필수입니다." });
    }
    let scheduleRow, issuance;
    let pgClient = null;
    if (USE_JSON_FILE) {
      // 동시 요청 중 정확히 한 요청만 이 scheduleId를 처리하도록 동기적으로 선점한다.
      if (_rcpsSchedulePostInFlight.has(scheduleId)) {
        return res.status(409).json({ ok: false, message: "이 회차는 다른 요청이 이미 처리 중입니다. 잠시 후 다시 시도해주세요." });
      }
      _rcpsSchedulePostInFlight.add(scheduleId);
      lockedJsonMode = true;
      scheduleRow = _fileAcctRcps.schedule.find(s => s.id === scheduleId);
      if (!scheduleRow) return res.status(404).json({ ok: false, message: "상각 스케줄을 찾을 수 없습니다." });
      if (scheduleRow.status === "posted") return res.status(400).json({ ok: false, message: "이미 전표가 발행된 회차입니다." });
      issuance = _fileAcctRcps.issuances.find(i => i.id === scheduleRow.issuanceId);
    } else {
      // Postgres 모드: SELECT ... FOR UPDATE로 이 회차 행을 잠가, 같은 scheduleId를 노리는
      // 동시 요청은 이 트랜잭션이 COMMIT/ROLLBACK될 때까지 뒤 요청의 SELECT에서 대기하게 만든다
      // (vouchers/:id/post가 이미 쓰던 것과 동일한 패턴).
      pgClient = await pool.connect();
      await pgClient.query("BEGIN");
      const { rows } = await pgClient.query(
        "SELECT data FROM rcps_amortization_schedule WHERE id = $1 AND company_id = $2 FOR UPDATE",
        [scheduleId, companyId]
      );
      if (!rows.length) {
        await pgClient.query("ROLLBACK"); pgClient.release();
        return res.status(404).json({ ok: false, message: "상각 스케줄을 찾을 수 없습니다." });
      }
      scheduleRow = rows[0].data;
      if (scheduleRow.status === "posted") {
        await pgClient.query("ROLLBACK"); pgClient.release();
        return res.status(400).json({ ok: false, message: "이미 전표가 발행된 회차입니다." });
      }
      const { rows: issRows } = await pgClient.query("SELECT data FROM rcps_issuances WHERE id = $1 AND company_id = $2", [scheduleRow.issuanceId, companyId]);
      issuance = issRows[0]?.data;
    }
    if (!issuance) {
      if (pgClient) { await pgClient.query("ROLLBACK"); pgClient.release(); }
      return res.status(404).json({ ok: false, message: "RCPS 발행 건을 찾을 수 없습니다." });
    }

    try {
      const { effectiveInterest, statedInterest, amortization } = scheduleRow;
      // amortization>=0(할인발행 상각, 부채 증가)이면 세 번째 라인이 RCPS부채 대변, amortization<0
      // (할증발행 상각, 부채 감소)이면 차변으로 뒤집는다. effectiveInterest는 이미 상각표 생성 시점에
      // statedInterest+amortization으로 계산돼 있어 첫 번째 라인의 차변 금액은 두 경우 모두 동일하게
      // 쓰면 자동으로 차대가 맞는다(할증발행: effectiveInterest+|amortization| = statedInterest = 대변합계).
      const lines = amortization >= 0
        ? [
            { accountId: interestExpenseAccountId, debit: effectiveInterest, credit: 0 },
            { accountId: cashAccountId, debit: 0, credit: statedInterest },
            { accountId: rcpsLiabilityAccountId, debit: 0, credit: amortization },
          ]
        : [
            { accountId: interestExpenseAccountId, debit: effectiveInterest, credit: 0 },
            { accountId: cashAccountId, debit: 0, credit: statedInterest },
            { accountId: rcpsLiabilityAccountId, debit: Math.abs(amortization), credit: 0 },
          ];

      const voucher = await _issuePostedVoucher(companyId, {
        date: scheduleRow.periodDate,
        description: `RCPS 상각 (${issuance.name} ${scheduleRow.seq}회차)`,
        lines, user,
      }, pgClient);

      const updatedSchedule = { ...scheduleRow, status: "posted", voucherId: voucher.id };
      if (USE_JSON_FILE) {
        const idx = _fileAcctRcps.schedule.findIndex(s => s.id === scheduleId);
        _fileAcctRcps.schedule[idx] = updatedSchedule;
        _saveFileAcctRcps();
      } else {
        await pgClient.query("UPDATE rcps_amortization_schedule SET data = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2", [scheduleId, companyId, updatedSchedule]);
        await pgClient.query("COMMIT");
      }
      res.json({ ok: true, schedule: updatedSchedule, voucher });
    } catch (e) {
      if (pgClient) await pgClient.query("ROLLBACK");
      throw e;
    } finally {
      if (pgClient) pgClient.release();
    }
  } catch (e) { res.status(e.statusCode || 500).json({ ok: false, message: _safeErrMsg(e) }); }
  finally {
    if (lockedJsonMode) _rcpsSchedulePostInFlight.delete(scheduleId);
  }
});

app.post("/api/accounting/rcps/valuations", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-rcps")) return;
    const companyId = req.auth.companyId || null;
    const { issuanceId, valuationDate, fairValue, method, memo, gainAccountId, lossAccountId, derivativeLiabilityAccountId, user } = req.body || {};
    if (!issuanceId || !valuationDate || fairValue === undefined || fairValue === null || fairValue === "") {
      return res.status(400).json({ ok: false, message: "issuanceId, valuationDate, fairValue는 필수입니다." });
    }
    let issuance, priorList;
    if (USE_JSON_FILE) {
      issuance = _fileAcctRcps.issuances.find(i => i.id === issuanceId && !i.isDeleted);
      if (!issuance) return res.status(404).json({ ok: false, message: "RCPS 발행 건을 찾을 수 없습니다." });
      priorList = _fileAcctRcps.valuations.filter(v => v.issuanceId === issuanceId).sort((a, b) => b.valuationDate.localeCompare(a.valuationDate));
    } else {
      const { rows } = await pool.query("SELECT data FROM rcps_issuances WHERE id = $1 AND company_id = $2 AND is_deleted = FALSE", [issuanceId, companyId]);
      if (!rows.length) return res.status(404).json({ ok: false, message: "RCPS 발행 건을 찾을 수 없습니다." });
      issuance = rows[0].data;
      const { rows: valRows } = await pool.query(
        "SELECT data FROM rcps_fair_value_valuations WHERE issuance_id = $1 AND company_id = $2 ORDER BY data->>'valuationDate' DESC", [issuanceId, companyId]
      );
      priorList = valRows.map(r => r.data);
    }
    const priorCarrying = priorList.length ? Number(priorList[0].fairValue) : Number(issuance.equityResidual);
    const gainLoss = _round2(Number(fairValue) - priorCarrying);

    let voucher = null;
    if (gainLoss > 0) {
      // 부채(파생상품) 장부금액 증가 = 평가손실
      if (!lossAccountId || !derivativeLiabilityAccountId) {
        return res.status(400).json({ ok: false, message: "평가손실 발생 시 lossAccountId, derivativeLiabilityAccountId는 필수입니다." });
      }
      voucher = await _issuePostedVoucher(companyId, {
        date: valuationDate,
        description: `RCPS 공정가치평가 (${issuance.name})`,
        lines: [
          { accountId: lossAccountId, debit: gainLoss, credit: 0 },
          { accountId: derivativeLiabilityAccountId, debit: 0, credit: gainLoss },
        ],
        user,
      });
    } else if (gainLoss < 0) {
      // 부채(파생상품) 장부금액 감소 = 평가이익
      if (!gainAccountId || !derivativeLiabilityAccountId) {
        return res.status(400).json({ ok: false, message: "평가이익 발생 시 gainAccountId, derivativeLiabilityAccountId는 필수입니다." });
      }
      voucher = await _issuePostedVoucher(companyId, {
        date: valuationDate,
        description: `RCPS 공정가치평가 (${issuance.name})`,
        lines: [
          { accountId: derivativeLiabilityAccountId, debit: Math.abs(gainLoss), credit: 0 },
          { accountId: gainAccountId, debit: 0, credit: Math.abs(gainLoss) },
        ],
        user,
      });
    }

    const valuation = {
      id: `rcpsval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      issuanceId, valuationDate, priorCarrying, fairValue: Number(fairValue), gainLoss,
      method: method || "", memo: memo || "", voucherId: voucher ? voucher.id : null,
      createdBy: user || "unknown", createdAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      _fileAcctRcps.valuations.push(valuation);
      _saveFileAcctRcps();
    } else {
      await pool.query(
        "INSERT INTO rcps_fair_value_valuations (id, issuance_id, company_id, data) VALUES ($1,$2,$3,$4)",
        [valuation.id, issuanceId, companyId, valuation]
      );
    }
    res.json({ ok: true, valuation, voucher });
  } catch (e) { res.status(e.statusCode || 500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 부가세 신고자료 (기존 tax_invoices 집계, 신규 테이블 없음) ───────────────────
// 국세청 홈택스 신고서 양식이 아니라 사내 참고용 집계다. 발행(issued) 상태의 세금계산서만
// 대상으로 하며(취소분 제외), direction별(매출/매입) 합계·거래처별·월별 브레이크다운을 계산한다.
app.get("/api/accounting/vat-report", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { from, to } = req.query || {};
    if (!from || !to) return res.status(400).json({ ok: false, message: "from, to(YYYY-MM-DD)는 필수입니다." });
    let list;
    if (USE_JSON_FILE) {
      list = _fileAccounting.taxInvoices.filter(t => t.status === "issued" && t.issueDate >= from && t.issueDate <= to);
    } else {
      const companyId = req.auth.companyId || null;
      const { rows } = await pool.query(
        "SELECT data FROM tax_invoices WHERE status = 'issued' AND issue_date >= $1 AND issue_date <= $2 AND (company_id = $3 OR company_id IS NULL) ORDER BY issue_date",
        [from, to, companyId]
      );
      list = rows.map(r => r.data);
    }
    const sales = list.filter(t => t.direction !== "purchase");
    const purchase = list.filter(t => t.direction === "purchase");
    const sum = (arr, key) => _round2(arr.reduce((s, t) => s + (Number(t[key]) || 0), 0));

    function _breakdown(arr) {
      const byPartner = {}, byMonth = {};
      for (const t of arr) {
        const pk = t.partnerName || "(미상)";
        if (!byPartner[pk]) byPartner[pk] = { partnerName: pk, supplyTotal: 0, taxTotal: 0, count: 0 };
        byPartner[pk].supplyTotal = _round2(byPartner[pk].supplyTotal + (Number(t.supplyTotal) || 0));
        byPartner[pk].taxTotal = _round2(byPartner[pk].taxTotal + (Number(t.taxTotal) || 0));
        byPartner[pk].count += 1;
        const mk = String(t.issueDate || "").slice(0, 7);
        if (!byMonth[mk]) byMonth[mk] = { month: mk, supplyTotal: 0, taxTotal: 0, count: 0 };
        byMonth[mk].supplyTotal = _round2(byMonth[mk].supplyTotal + (Number(t.supplyTotal) || 0));
        byMonth[mk].taxTotal = _round2(byMonth[mk].taxTotal + (Number(t.taxTotal) || 0));
        byMonth[mk].count += 1;
      }
      return {
        byPartner: Object.values(byPartner).sort((a, b) => b.supplyTotal - a.supplyTotal),
        byMonth: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
      };
    }

    const salesSupply = sum(sales, "supplyTotal"), salesTax = sum(sales, "taxTotal");
    const purchaseSupply = sum(purchase, "supplyTotal"), purchaseTax = sum(purchase, "taxTotal");
    res.json({
      ok: true, from, to,
      sales: { supplyTotal: salesSupply, taxTotal: salesTax, count: sales.length, ..._breakdown(sales) },
      purchase: { supplyTotal: purchaseSupply, taxTotal: purchaseTax, count: purchase.length, ..._breakdown(purchase) },
      vatPayable: _round2(salesTax - purchaseTax), // 매출세액(예수금) - 매입세액(대급금). 양수면 납부, 음수면 환급.
    });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 고정자산 관리 (취득·감가상각·처분) ────────────────────────────────────────
// RCPS 모듈과 동일한 이유로 신규 기능(레거시 NULL 데이터 없음) — company_id NOT NULL.
// 감가상각 스케줄은 RCPS 상각표와 동일하게 등록 시점에 내용연수만큼 일괄 생성해 영속화하고,
// 이후 "상각전표 발행" 액션(연도 단위)으로 개별 확정한다. 동시발행 방지는 RCPS
// (rcps/schedule/:scheduleId/post)와 완전히 동일한 패턴(JSON모드: in-flight Set,
// Postgres모드: SELECT ... FOR UPDATE)을 재사용한다.
function _isValidDateStr(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return false;
  const d = new Date(v);
  return !isNaN(d.getTime());
}
function _buildDepreciationSchedule(assetId, asset) {
  const cost = Number(asset.acquisitionCost) || 0;
  const salvage = Math.max(0, Math.min(Number(asset.salvageValue) || 0, cost));
  const life = Math.max(1, Math.round(Number(asset.usefulLifeYears) || 1));
  const startYear = new Date(asset.acquisitionDate).getFullYear();
  const method = asset.depreciationMethod === "declining" ? "declining" : "straight";
  // 정률법 상각률: 잔존가액이 있으면 표준 공식(1-(잔존/취득)^(1/내용연수)), 잔존가액이 0이면
  // 그 공식이 성립하지 않아(첫 회차에 100% 상각) "간단한 고정 상각률" 요구사항에 맞춰
  // 실무에서 흔히 쓰는 정액법의 2배(double-declining) 상각률로 대체한다.
  const rate = method === "declining"
    ? (salvage > 0 && cost > 0 ? 1 - Math.pow(salvage / cost, 1 / life) : Math.min(1, 2 / life))
    : 0;
  const schedule = [];
  let beginning = cost;
  for (let seq = 1; seq <= life; seq++) {
    const year = startYear + seq - 1;
    let expense = method === "straight" ? _round2((cost - salvage) / life) : _round2(beginning * rate);
    let ending = _round2(beginning - expense);
    if (seq === life) {
      // 마지막 회차는 반올림 누적오차를 보정해 기말장부가액이 정확히 잔존가액과 일치하게 한다
      // (RCPS 상각표 마지막 회차 보정과 동일한 취지).
      expense = _round2(beginning - salvage);
      ending = salvage;
    }
    schedule.push({
      id: `fasch_${assetId}_${year}`, assetId, year, seq,
      beginningValue: beginning, depreciationExpense: expense, endingValue: ending,
      status: "pending", voucherId: null,
    });
    beginning = ending;
  }
  return schedule;
}

app.post("/api/accounting/fixed-assets", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-fixed-assets")) return;
    const companyId = req.auth.companyId || null;
    const { name, assetNumber, category, acquisitionDate, acquisitionCost, usefulLifeYears, salvageValue, depreciationMethod, locationId, user } = req.body || {};
    if (!name || !acquisitionDate || !(Number(acquisitionCost) > 0) || !(Number(usefulLifeYears) > 0)) {
      return res.status(400).json({ ok: false, message: "자산명, 취득일, 취득원가(0보다 큼), 내용연수(0보다 큼)는 필수입니다." });
    }
    // 취득일이 "존재하기만 하면" 통과시키고 있어 파싱 불가능한 값도 그대로 들어왔다.
    // _buildDepreciationSchedule의 new Date(...).getFullYear()가 NaN이 되면 상각 연도가 전부
    // NaN이 되어 스케줄 id(fasch_<자산>_NaN)가 회차마다 똑같아지고(JSON모드에선 중복 id로
    // 저장), Postgres모드에선 year 컬럼 INSERT가 깨져 DB 원문 오류가 그대로 500으로 나갔다.
    if (!_isValidDateStr(acquisitionDate)) {
      return res.status(400).json({ ok: false, message: "취득일이 올바른 날짜가 아닙니다(YYYY-MM-DD)." });
    }
    const salvage = Number(salvageValue) || 0;
    if (salvage < 0 || salvage > Number(acquisitionCost)) {
      return res.status(400).json({ ok: false, message: "잔존가액은 0 이상 취득원가 이하이어야 합니다." });
    }
    const method = depreciationMethod === "declining" ? "declining" : "straight";
    const assetId = `fa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const asset = {
      id: assetId, name, assetNumber: assetNumber || "", category: category || "",
      acquisitionDate, acquisitionCost: Number(acquisitionCost), usefulLifeYears: Math.round(Number(usefulLifeYears)),
      salvageValue: salvage, depreciationMethod: method, locationId: locationId || null,
      status: "in_use", disposalDate: null, isDeleted: false,
      createdBy: user || "unknown", createdAt: new Date().toISOString(),
    };
    const schedule = _buildDepreciationSchedule(assetId, asset);
    if (USE_JSON_FILE) {
      _fileAcctFixedAssets.assets.push(asset);
      _fileAcctFixedAssets.schedule.push(...schedule);
      _saveFileAcctFixedAssets();
      return res.json({ ok: true, asset, schedule });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO fixed_assets (id, company_id, data) VALUES ($1,$2,$3)", [assetId, companyId, asset]);
      for (const s of schedule) {
        await client.query(
          "INSERT INTO fixed_asset_depreciation_schedule (id, asset_id, company_id, year, data) VALUES ($1,$2,$3,$4,$5)",
          [s.id, assetId, companyId, s.year, s]
        );
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    res.json({ ok: true, asset, schedule });
  } catch (e) { res.status(e.statusCode || 500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.get("/api/accounting/fixed-assets", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (USE_JSON_FILE) {
      return res.json({ ok: true, assets: _fileAcctFixedAssets.assets.filter(a => !a.isDeleted).sort((a, b) => b.acquisitionDate.localeCompare(a.acquisitionDate)) });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query(
      "SELECT id, data FROM fixed_assets WHERE is_deleted = FALSE AND company_id = $1 ORDER BY data->>'acquisitionDate' DESC",
      [companyId]
    );
    res.json({ ok: true, assets: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.get("/api/accounting/fixed-assets/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = req.params.id;
    if (USE_JSON_FILE) {
      const asset = _fileAcctFixedAssets.assets.find(a => a.id === id && !a.isDeleted);
      if (!asset) return res.status(404).json({ ok: false, message: "고정자산을 찾을 수 없습니다." });
      const schedule = _fileAcctFixedAssets.schedule.filter(s => s.assetId === id).sort((a, b) => a.year - b.year);
      return res.json({ ok: true, asset, schedule });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query("SELECT data FROM fixed_assets WHERE id = $1 AND company_id = $2 AND is_deleted = FALSE", [id, companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "고정자산을 찾을 수 없습니다." });
    const asset = { id, ...rows[0].data };
    const { rows: schedRows } = await pool.query("SELECT data FROM fixed_asset_depreciation_schedule WHERE asset_id = $1 AND company_id = $2 ORDER BY year", [id, companyId]);
    res.json({ ok: true, asset, schedule: schedRows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.get("/api/accounting/fixed-assets/:id/depreciation-schedule", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = req.params.id;
    if (USE_JSON_FILE) {
      return res.json({ ok: true, schedule: _fileAcctFixedAssets.schedule.filter(s => s.assetId === id).sort((a, b) => a.year - b.year) });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query("SELECT data FROM fixed_asset_depreciation_schedule WHERE asset_id = $1 AND company_id = $2 ORDER BY year", [id, companyId]);
    res.json({ ok: true, schedule: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/accounting/fixed-assets/:id", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-fixed-assets")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const body = req.body || {};
    let asset, schedule;
    if (USE_JSON_FILE) {
      asset = _fileAcctFixedAssets.assets.find(a => a.id === id && !a.isDeleted);
      if (!asset) return res.status(404).json({ ok: false, message: "고정자산을 찾을 수 없습니다." });
      schedule = _fileAcctFixedAssets.schedule.filter(s => s.assetId === id);
    } else {
      const { rows } = await pool.query("SELECT data FROM fixed_assets WHERE id = $1 AND company_id = $2 AND is_deleted = FALSE", [id, companyId]);
      if (!rows.length) return res.status(404).json({ ok: false, message: "고정자산을 찾을 수 없습니다." });
      asset = rows[0].data;
      const { rows: schedRows } = await pool.query("SELECT data FROM fixed_asset_depreciation_schedule WHERE asset_id = $1 AND company_id = $2", [id, companyId]);
      schedule = schedRows.map(r => r.data);
    }
    if (body.acquisitionDate !== undefined && !_isValidDateStr(body.acquisitionDate)) {
      return res.status(400).json({ ok: false, message: "취득일이 올바른 날짜가 아닙니다(YYYY-MM-DD)." });
    }
    const hasPosted = schedule.some(s => s.status === "posted");
    const DEPR_FIELDS = ["acquisitionDate", "acquisitionCost", "usefulLifeYears", "salvageValue", "depreciationMethod"];
    const changingDepr = DEPR_FIELDS.some(f => body[f] !== undefined && String(body[f]) !== String(asset[f]));
    if (changingDepr && hasPosted) {
      return res.status(400).json({ ok: false, message: "이미 상각전표가 발행된 자산은 취득원가·내용연수·잔존가액·상각방법·취득일을 변경할 수 없습니다." });
    }
    const updated = {
      ...asset,
      name: body.name !== undefined ? body.name : asset.name,
      assetNumber: body.assetNumber !== undefined ? body.assetNumber : asset.assetNumber,
      category: body.category !== undefined ? body.category : asset.category,
      locationId: body.locationId !== undefined ? body.locationId : asset.locationId,
      acquisitionDate: body.acquisitionDate !== undefined ? body.acquisitionDate : asset.acquisitionDate,
      acquisitionCost: body.acquisitionCost !== undefined ? Number(body.acquisitionCost) : asset.acquisitionCost,
      usefulLifeYears: body.usefulLifeYears !== undefined ? Math.round(Number(body.usefulLifeYears)) : asset.usefulLifeYears,
      salvageValue: body.salvageValue !== undefined ? Number(body.salvageValue) : asset.salvageValue,
      depreciationMethod: body.depreciationMethod !== undefined ? (body.depreciationMethod === "declining" ? "declining" : "straight") : asset.depreciationMethod,
      updatedBy: body.user || "unknown", updatedAt: new Date().toISOString(),
    };
    let newSchedule = schedule;
    if (changingDepr) newSchedule = _buildDepreciationSchedule(id, updated);
    if (USE_JSON_FILE) {
      const idx = _fileAcctFixedAssets.assets.findIndex(a => a.id === id);
      _fileAcctFixedAssets.assets[idx] = updated;
      if (changingDepr) _fileAcctFixedAssets.schedule = _fileAcctFixedAssets.schedule.filter(s => s.assetId !== id).concat(newSchedule);
      _saveFileAcctFixedAssets();
      return res.json({ ok: true, asset: updated, schedule: newSchedule });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE fixed_assets SET data = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2", [id, companyId, updated]);
      if (changingDepr) {
        await client.query("DELETE FROM fixed_asset_depreciation_schedule WHERE asset_id = $1 AND company_id = $2", [id, companyId]);
        for (const s of newSchedule) {
          await client.query(
            "INSERT INTO fixed_asset_depreciation_schedule (id, asset_id, company_id, year, data) VALUES ($1,$2,$3,$4,$5)",
            [s.id, id, companyId, s.year, s]
          );
        }
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    res.json({ ok: true, asset: updated, schedule: newSchedule });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/accounting/fixed-assets/:id/dispose", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-fixed-assets")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const { disposalDate, user } = req.body || {};
    if (!disposalDate) return res.status(400).json({ ok: false, message: "처분일은 필수입니다." });
    let asset;
    if (USE_JSON_FILE) {
      asset = _fileAcctFixedAssets.assets.find(a => a.id === id && !a.isDeleted);
    } else {
      const { rows } = await pool.query("SELECT data FROM fixed_assets WHERE id = $1 AND company_id = $2 AND is_deleted = FALSE", [id, companyId]);
      asset = rows[0]?.data;
    }
    if (!asset) return res.status(404).json({ ok: false, message: "고정자산을 찾을 수 없습니다." });
    if (asset.status === "disposed") return res.status(400).json({ ok: false, message: "이미 처분된 자산입니다." });
    if (new Date(disposalDate) < new Date(asset.acquisitionDate)) return res.status(400).json({ ok: false, message: "처분일은 취득일 이후여야 합니다." });
    const updated = { ...asset, status: "disposed", disposalDate, disposedBy: user || "unknown", disposedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (USE_JSON_FILE) {
      const idx = _fileAcctFixedAssets.assets.findIndex(a => a.id === id);
      _fileAcctFixedAssets.assets[idx] = updated;
      _saveFileAcctFixedAssets();
      return res.json({ ok: true, asset: updated });
    }
    await pool.query("UPDATE fixed_assets SET data = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2", [id, companyId, updated]);
    res.json({ ok: true, asset: updated });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/accounting/fixed-assets/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-fixed-assets")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    if (USE_JSON_FILE) {
      const asset = _fileAcctFixedAssets.assets.find(a => a.id === id && !a.isDeleted);
      if (!asset) return res.status(404).json({ ok: false, message: "고정자산을 찾을 수 없습니다." });
      const hasPosted = _fileAcctFixedAssets.schedule.some(s => s.assetId === id && s.status === "posted");
      if (hasPosted) return res.status(400).json({ ok: false, message: "이미 상각전표가 발행된 자산은 삭제할 수 없습니다." });
      asset.isDeleted = true;
      _saveFileAcctFixedAssets();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT 1 FROM fixed_assets WHERE id = $1 AND company_id = $2 AND is_deleted = FALSE", [id, companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "고정자산을 찾을 수 없습니다." });
    const { rows: postedRows } = await pool.query(
      "SELECT 1 FROM fixed_asset_depreciation_schedule WHERE asset_id = $1 AND company_id = $2 AND data->>'status' = 'posted' LIMIT 1", [id, companyId]
    );
    if (postedRows.length) return res.status(400).json({ ok: false, message: "이미 상각전표가 발행된 자산은 삭제할 수 없습니다." });
    await pool.query("UPDATE fixed_assets SET is_deleted = TRUE WHERE id = $1 AND company_id = $2", [id, companyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// scheduleId(RCPS)와 동일한 이유로, assetId+year 단위 in-flight 가드가 필요하다.
const _faSchedulePostInFlight = new Set();

app.post("/api/accounting/fixed-assets/:id/depreciation-schedule/:year/post", async (req, res) => {
  const assetId = req.params.id;
  const year = parseInt(req.params.year);
  const lockKey = `${assetId}:${year}`;
  let lockedJsonMode = false;
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "acct-fixed-assets")) return;
    const companyId = req.auth.companyId || null;
    const { user, depreciationExpenseAccountId, accumulatedDepreciationAccountId } = req.body || {};
    if (!depreciationExpenseAccountId || !accumulatedDepreciationAccountId) {
      return res.status(400).json({ ok: false, message: "감가상각비, 감가상각누계액 계정과목은 모두 필수입니다." });
    }
    let scheduleRow, asset;
    let pgClient = null;
    if (USE_JSON_FILE) {
      // 동시 요청 중 정확히 한 요청만 이 assetId+year를 처리하도록 동기적으로 선점한다(RCPS와 동일 패턴).
      if (_faSchedulePostInFlight.has(lockKey)) {
        return res.status(409).json({ ok: false, message: "이 연도는 다른 요청이 이미 처리 중입니다. 잠시 후 다시 시도해주세요." });
      }
      _faSchedulePostInFlight.add(lockKey);
      lockedJsonMode = true;
      scheduleRow = _fileAcctFixedAssets.schedule.find(s => s.assetId === assetId && s.year === year);
      if (!scheduleRow) return res.status(404).json({ ok: false, message: "해당 연도의 상각 스케줄을 찾을 수 없습니다." });
      if (scheduleRow.status === "posted") return res.status(400).json({ ok: false, message: "이미 전표가 발행된 연도입니다." });
      asset = _fileAcctFixedAssets.assets.find(a => a.id === assetId);
    } else {
      // Postgres 모드: SELECT ... FOR UPDATE로 이 (asset_id, year) 행을 잠가, 같은 조합을 노리는
      // 동시 요청은 이 트랜잭션이 COMMIT/ROLLBACK될 때까지 뒤 요청의 SELECT에서 대기하게 만든다
      // (RCPS rcps/schedule/:scheduleId/post가 이미 쓰던 것과 동일한 패턴).
      pgClient = await pool.connect();
      await pgClient.query("BEGIN");
      const { rows } = await pgClient.query(
        "SELECT data FROM fixed_asset_depreciation_schedule WHERE asset_id = $1 AND year = $2 AND company_id = $3 FOR UPDATE",
        [assetId, year, companyId]
      );
      if (!rows.length) {
        await pgClient.query("ROLLBACK"); pgClient.release();
        return res.status(404).json({ ok: false, message: "해당 연도의 상각 스케줄을 찾을 수 없습니다." });
      }
      scheduleRow = rows[0].data;
      if (scheduleRow.status === "posted") {
        await pgClient.query("ROLLBACK"); pgClient.release();
        return res.status(400).json({ ok: false, message: "이미 전표가 발행된 연도입니다." });
      }
      const { rows: assetRows } = await pgClient.query("SELECT data FROM fixed_assets WHERE id = $1 AND company_id = $2", [assetId, companyId]);
      asset = assetRows[0]?.data;
    }
    if (!asset) {
      if (pgClient) { await pgClient.query("ROLLBACK"); pgClient.release(); }
      return res.status(404).json({ ok: false, message: "고정자산을 찾을 수 없습니다." });
    }
    if (asset.status === "disposed" && asset.disposalDate && year > new Date(asset.disposalDate).getFullYear()) {
      if (pgClient) { await pgClient.query("ROLLBACK"); pgClient.release(); }
      return res.status(400).json({ ok: false, message: "처분일 이후 연도의 감가상각비는 발행할 수 없습니다." });
    }

    try {
      const voucher = await _issuePostedVoucher(companyId, {
        date: `${year}-12-31`,
        description: `감가상각비 (${asset.name} ${year}년)`,
        lines: [
          { accountId: depreciationExpenseAccountId, debit: scheduleRow.depreciationExpense, credit: 0 },
          { accountId: accumulatedDepreciationAccountId, debit: 0, credit: scheduleRow.depreciationExpense },
        ],
        user,
      }, pgClient);

      const updatedSchedule = { ...scheduleRow, status: "posted", voucherId: voucher.id };
      if (USE_JSON_FILE) {
        const idx = _fileAcctFixedAssets.schedule.findIndex(s => s.assetId === assetId && s.year === year);
        _fileAcctFixedAssets.schedule[idx] = updatedSchedule;
        _saveFileAcctFixedAssets();
      } else {
        await pgClient.query(
          "UPDATE fixed_asset_depreciation_schedule SET data = $4, updated_at = NOW() WHERE asset_id = $1 AND year = $2 AND company_id = $3",
          [assetId, year, companyId, updatedSchedule]
        );
        await pgClient.query("COMMIT");
      }
      res.json({ ok: true, schedule: updatedSchedule, voucher });
    } catch (e) {
      if (pgClient) await pgClient.query("ROLLBACK");
      throw e;
    } finally {
      if (pgClient) pgClient.release();
    }
  } catch (e) { res.status(e.statusCode || 500).json({ ok: false, message: _safeErrMsg(e) }); }
  finally {
    if (lockedJsonMode) _faSchedulePostInFlight.delete(lockKey);
  }
});

// ── 영업/재고 모듈 (품목 / 위치 / 견적서 / 발주서 / 재고 입출고) ──────────────────
// 회계 모듈과 동일하게 서버-권위형: 번호 발급·상태 전환·발주 입고 시 재고 반영을
// 서버가 직접 처리한다. JSON 파일 모드는 `_fileErp`, PostgreSQL 모드는 전용 테이블 사용.

function _saveFileErp() {
  const erpFile = JSON_FILE.replace(/\.json$/, "-erp.json");
  _atomicWriteFileSync(erpFile, JSON.stringify(_fileErp, null, 2));
}
function _saveFilePms() {
  const pmsFile = JSON_FILE.replace(/\.json$/, "-pms.json");
  _atomicWriteFileSync(pmsFile, JSON.stringify(_filePms, null, 2));
}
function _saveFileRecruit() {
  const recruitFile = JSON_FILE.replace(/\.json$/, "-recruit.json");
  _atomicWriteFileSync(recruitFile, JSON.stringify(_fileRecruit, null, 2));
}
function _nextErpSeq(kind, year) {
  if (!_fileErp[kind]) _fileErp[kind] = {};
  const next = (_fileErp[kind][year] || 0) + 1;
  _fileErp[kind][year] = next;
  return next;
}
// 수량·단가에 음수가 들어와도 아무 검증 없이 통과해, 견적서 → 출고(재고 차감) → 세금계산서
// 발행까지 그대로 흘러갔다. 그 결과 마이너스 공급가액 세금계산서가 만들어지고 부가세
// 신고자료(/api/accounting/vat-report)의 매출세액 집계가 왜곡되며, 출고 시에는 "음수 출고"가
// 사실상 입고로 작용해 있지도 않은 재고가 늘어난다. 금액을 되돌리는 것은 반품·수정 전표로
// 해야 할 일이지 음수 라인으로 할 일이 아니므로, 입력 단계에서 거부한다.
// 재고 원장은 itemId/locationId를 참조만 하고 존재 검증은 하지 않아, 오타나 연동 실수로
// 없는 id를 보내면 어떤 품목·창고 화면에도 안 보이는 유령 원장 행이 조용히 쌓였다
// (재고 합계에는 잡히므로 "품목명이 빈 칸인 수량"으로만 드러난다).
async function _erpRefsExist(itemId, locationIds, companyId) {
  const locs = locationIds.filter(Boolean);
  if (USE_JSON_FILE) {
    if (itemId && !(_fileErp.items || []).some(i => i.id === itemId)) return "품목을 찾을 수 없습니다.";
    for (const l of locs) {
      if (!(_fileErp.locations || []).some(x => x.id === l)) return "위치(창고)를 찾을 수 없습니다.";
    }
    return null;
  }
  if (itemId) {
    const { rows } = await pool.query(
      "SELECT 1 FROM erp_items WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL)", [itemId, companyId]
    );
    if (!rows.length) return "품목을 찾을 수 없습니다.";
  }
  for (const l of locs) {
    const { rows } = await pool.query(
      "SELECT 1 FROM erp_locations WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL)", [l, companyId]
    );
    if (!rows.length) return "위치(창고)를 찾을 수 없습니다.";
  }
  return null;
}
function _validateItemLines(items) {
  for (const it of (items || [])) {
    const q = Number(it.qty), p = Number(it.unitPrice);
    if (!Number.isFinite(q) || q <= 0) return `수량은 0보다 큰 숫자여야 합니다(${it.name || it.itemId || "품목"}).`;
    if (!Number.isFinite(p) || p < 0) return `단가는 0 이상의 숫자여야 합니다(${it.name || it.itemId || "품목"}).`;
  }
  return null;
}
function _buildItemLineTotals(items) {
  const lines = (items || []).map(it => {
    const supplyAmount = _round2((Number(it.qty) || 0) * (Number(it.unitPrice) || 0));
    const taxAmount = _round2(supplyAmount * 0.1);
    return { itemId: it.itemId || null, name: it.name || "", qty: Number(it.qty) || 0, unitPrice: Number(it.unitPrice) || 0, supplyAmount, taxAmount };
  });
  const supplyTotal = _round2(lines.reduce((s, l) => s + l.supplyAmount, 0));
  const taxTotal = _round2(lines.reduce((s, l) => s + l.taxAmount, 0));
  return { lines, supplyTotal, taxTotal, grandTotal: _round2(supplyTotal + taxTotal) };
}

// ── 품목 마스터 ───────────────────────────────────────────────────────────────
app.get("/api/erp/items", async (req, res) => {
  // 다른 회사 품목이 보이면 안 되므로 company_id로 필터하되, role 제약은 그대로 requireAuth
  // 유지 — member도 구매요청(inv-purchase-requests) 등록을 위해 이 품목 목록을 조회해야 한다.
  if (!requireAuth(req, res)) return;
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, items: _fileErp.items });
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query(
      "SELECT id, data FROM erp_items WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL) ORDER BY id", [companyId]
    );
    res.json({ ok: true, items: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/items", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "inv-items")) return;
    const companyId = req.auth.companyId || null;
    const { id, code, name, productName, assetNo, unit, category, safetyStock = 0, unitCost = 0, active = true } = req.body || {};
    if (!code || !name) return res.status(400).json({ ok: false, message: "품목코드, 품목명은 필수입니다." });
    const itemId = id || `item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const item = { id: itemId, code, name, productName: productName || "", assetNo: assetNo || "", unit: unit || "EA", category: category || "", safetyStock: Number(safetyStock) || 0, unitCost: Number(unitCost) || 0, active };
    if (USE_JSON_FILE) {
      const idx = _fileErp.items.findIndex(i => i.id === itemId);
      if (idx >= 0) _fileErp.items[idx] = item; else _fileErp.items.push(item);
      _saveFileErp();
      return res.json({ ok: true, item });
    }
    await pool.query("INSERT INTO erp_items (id, company_id, data) VALUES ($1,$2,$3) ON CONFLICT (company_id, id) DO UPDATE SET data = $3, updated_at = NOW()", [itemId, companyId, item]);
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/items/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "inv-items")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    if (USE_JSON_FILE) {
      const used = _fileErp.stockLedger.some(l => l.itemId === id) ||
        _fileErp.quotations.some(q => (q.lines || []).some(l => l.itemId === id)) ||
        _fileErp.purchaseOrders.some(p => (p.lines || []).some(l => l.itemId === id));
      if (used) return res.status(400).json({ ok: false, message: "재고 이력 또는 문서에서 사용 중인 품목은 삭제할 수 없습니다. 비활성화를 이용하세요." });
      _fileErp.items = _fileErp.items.filter(i => i.id !== id);
      _saveFileErp();
      return res.json({ ok: true });
    }
    // JSON 파일 모드는 재고원장 + 견적서 + 발주서 3곳을 검사하는데, Postgres 모드는
    // 재고원장만 보고 있어 견적서·발주서에서 사용 중인 품목이 그대로 삭제됐다(운영은
    // Postgres). 삭제되면 그 문서의 품목명 자리에 마스터에서 못 찾은 원본 id(UUID)가
    // 그대로 노출된다(_erpItemName). 양 모드의 검사 범위를 동일하게 맞춘다.
    const { rows } = await pool.query(
      `SELECT 1 WHERE
         EXISTS (SELECT 1 FROM erp_stock_ledger WHERE item_id = $1 AND (company_id = $2 OR company_id IS NULL))
      OR EXISTS (SELECT 1 FROM erp_quotations q WHERE (q.company_id = $2 OR q.company_id IS NULL)
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(q.data->'lines','[]'::jsonb)) ln WHERE ln->>'itemId' = $1))
      OR EXISTS (SELECT 1 FROM erp_purchase_orders po WHERE (po.company_id = $2 OR po.company_id IS NULL)
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(po.data->'lines','[]'::jsonb)) ln WHERE ln->>'itemId' = $1))`,
      [id, companyId]);
    if (rows.length) return res.status(400).json({ ok: false, message: "재고 이력 또는 문서에서 사용 중인 품목은 삭제할 수 없습니다. 비활성화를 이용하세요." });
    await pool.query("UPDATE erp_items SET is_deleted = TRUE WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 창고/위치 마스터 ─────────────────────────────────────────────────────────
app.get("/api/erp/locations", async (req, res) => {
  // items와 동일하게 role은 requireAuth 유지, company_id 필터만 추가.
  if (!requireAuth(req, res)) return;
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, locations: _fileErp.locations });
    const companyId = req.auth.companyId || null;
    const { rows } = await pool.query(
      "SELECT id, data FROM erp_locations WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL) ORDER BY id", [companyId]
    );
    res.json({ ok: true, locations: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/locations", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "inv-locations")) return;
    const companyId = req.auth.companyId || null;
    const { id, name, address, active = true } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, message: "위치명은 필수입니다." });
    const locId = id || `loc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const loc = { id: locId, name, address: address || "", active };
    if (USE_JSON_FILE) {
      const idx = _fileErp.locations.findIndex(l => l.id === locId);
      if (idx >= 0) _fileErp.locations[idx] = loc; else _fileErp.locations.push(loc);
      _saveFileErp();
      return res.json({ ok: true, location: loc });
    }
    await pool.query("INSERT INTO erp_locations (id, company_id, data) VALUES ($1,$2,$3) ON CONFLICT (company_id, id) DO UPDATE SET data = $3, updated_at = NOW()", [locId, req.auth.companyId || null, loc]);
    res.json({ ok: true, location: loc });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/locations/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "inv-locations")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    if (USE_JSON_FILE) {
      const used = _fileErp.stockLedger.some(l => l.locationId === id);
      if (used) return res.status(400).json({ ok: false, message: "재고 이력에서 사용 중인 위치는 삭제할 수 없습니다. 비활성화를 이용하세요." });
      _fileErp.locations = _fileErp.locations.filter(l => l.id !== id);
      _saveFileErp();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT 1 FROM erp_stock_ledger WHERE location_id = $1 AND (company_id = $2 OR company_id IS NULL) LIMIT 1", [id, companyId]);
    if (rows.length) return res.status(400).json({ ok: false, message: "재고 이력에서 사용 중인 위치는 삭제할 수 없습니다. 비활성화를 이용하세요." });
    await pool.query("UPDATE erp_locations SET is_deleted = TRUE WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 견적서 (Quotations) ─────────────────────────────────────────────────────
app.get("/api/erp/quotations", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const year = req.query.year ? parseInt(req.query.year) : null;
    if (USE_JSON_FILE) {
      let list = _fileErp.quotations;
      if (year) list = list.filter(q => new Date(q.date).getFullYear() === year);
      return res.json({ ok: true, quotations: list.sort((a, b) => b.date.localeCompare(a.date)) });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = year
      ? await pool.query("SELECT data FROM erp_quotations WHERE EXTRACT(YEAR FROM doc_date) = $1 AND (company_id = $2 OR company_id IS NULL) ORDER BY doc_date DESC", [year, companyId])
      : await pool.query("SELECT data FROM erp_quotations WHERE (company_id = $1 OR company_id IS NULL) ORDER BY doc_date DESC", [companyId]);
    res.json({ ok: true, quotations: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/quotations", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-quotations")) return;
    const companyId = req.auth.companyId || null;
    const { date, validUntil, partnerId, partnerName, locationId, items, memo, user: createdBy } = req.body || {};
    if (!date || !partnerName) return res.status(400).json({ ok: false, message: "견적일자와 거래처명은 필수입니다." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, message: "품목을 1개 이상 입력하세요." });
    const _lineErr = _validateItemLines(items);
    if (_lineErr) return res.status(400).json({ ok: false, message: _lineErr });
    const totals = _buildItemLineTotals(items);
    const quote = {
      id: `qt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      quoteNo: null, status: "draft",
      date, validUntil: validUntil || "", partnerId: partnerId || null, partnerName, locationId: locationId || null,
      ...totals, memo: memo || "",
      createdBy: createdBy || "unknown", createdAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      _fileErp.quotations.push(quote);
      _saveFileErp();
      return res.json({ ok: true, quotation: quote });
    }
    await pool.query("INSERT INTO erp_quotations (id, doc_date, status, data, company_id) VALUES ($1,$2,'draft',$3,$4)", [quote.id, date, quote, companyId]);
    res.json({ ok: true, quotation: quote });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/quotations/:id/send", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-quotations")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const year = new Date().getFullYear();
    if (USE_JSON_FILE) {
      const q = _fileErp.quotations.find(q => q.id === id);
      if (!q) return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." });
      if (q.status !== "draft") return res.status(400).json({ ok: false, message: "임시 저장 상태의 견적서만 발송할 수 있습니다." });
      const seq = _nextErpSeq("quoteSeq", year);
      q.quoteNo = `QT-${year}-${String(seq).padStart(6, "0")}`;
      q.status = "sent"; q.sentBy = req.body.user || "unknown"; q.sentAt = new Date().toISOString();
      _saveFileErp();
      return res.json({ ok: true, quotation: q });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data, status FROM erp_quotations WHERE id = $1 AND (company_id = $2 OR company_id IS NULL) FOR UPDATE", [id, companyId]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." }); }
      if (rows[0].status !== "draft") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "임시 저장 상태의 견적서만 발송할 수 있습니다." }); }
      const { rows: seqRows } = await client.query(
        "INSERT INTO erp_quote_seq (company_id, year, seq) VALUES ($1,$2,1) ON CONFLICT (company_id, year) DO UPDATE SET seq = erp_quote_seq.seq + 1 RETURNING seq", [companyId, year]
      );
      const quoteNo = `QT-${year}-${String(seqRows[0].seq).padStart(6, "0")}`;
      const q = { ...rows[0].data, quoteNo, status: "sent", sentBy: req.body.user || "unknown", sentAt: new Date().toISOString() };
      await client.query("UPDATE erp_quotations SET status = 'sent', data = $2, updated_at = NOW() WHERE id = $1", [id, q]);
      await client.query("COMMIT");
      res.json({ ok: true, quotation: q });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/quotations/:id/accept", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-quotations")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    if (USE_JSON_FILE) {
      const q = _fileErp.quotations.find(q => q.id === id);
      if (!q) return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." });
      if (q.status !== "sent") return res.status(400).json({ ok: false, message: "발송된 견적서만 수주 확정할 수 있습니다." });
      q.status = "accepted"; q.acceptedBy = req.body.user || "unknown"; q.acceptedAt = new Date().toISOString();
      _saveFileErp();
      return res.json({ ok: true, quotation: q });
    }
    const { rows } = await pool.query("SELECT data FROM erp_quotations WHERE id = $1 AND status = 'sent' AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "발송된 견적서만 수주 확정할 수 있습니다." });
    const q = { ...rows[0].data, status: "accepted", acceptedBy: req.body.user || "unknown", acceptedAt: new Date().toISOString() };
    await pool.query("UPDATE erp_quotations SET status = 'accepted', data = $2, updated_at = NOW() WHERE id = $1", [id, q]);
    res.json({ ok: true, quotation: q });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// erp_stock_ledger는 append-only 원장이라(현재고 = item+location의 모든 행 합) 그
// item+location에 이미 존재하는 행만 잠그는 `SELECT ... FOR UPDATE`로는 동시성을 막을 수
// 없다 — 동시에 들어오는 다른 트랜잭션의 새 INSERT는 그 잠금의 대상이 아니기 때문("phantom"
// 문제). 실측 확인: FOR UPDATE를 쓰던 ship/transfer조차 재고가 마이너스로 내려갈 만큼
// 동시 출고가 겹쳐 처리됐다. pg_advisory_xact_lock은 "그 시점에 존재하는 행"이 아니라
// item+location이라는 논리적 키 자체에 잠금을 걸어, 그 조합을 다루는 모든 동시 요청을
// 트랜잭션이 끝날 때까지 확실히 순번대로 세운다(요청 시점에 해당 행이 있었는지와 무관).
// 여러 키를 한 트랜잭션에서 잠글 때는 항상 정렬된 순서로 잠가야 서로 다른 순서로 잠그는
// 두 트랜잭션이 맞물려 교착(deadlock)되는 것을 막을 수 있다.
// companyId를 키 문자열 앞에 붙여, 서로 다른 회사가 우연히 같은 itemId/locationId(레거시
// 데이터 등)를 갖더라도 advisory lock이 회사 간에 섞이지 않게 한다.
async function _lockStockKeys(client, companyId, pairs) {
  const keys = [...new Set(pairs.map(([itemId, locationId]) => `stock:${companyId || ""}:${itemId}:${locationId}`))].sort();
  for (const k of keys) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [k]);
}

// 출고/매출 처리: 수주 확정된 견적서를 기준으로 재고 출고(원장 차감)와 세금계산서 발행을
// 한 번에 처리한다. 재고 부족 시 거부, 성공 시 견적서는 'shipped'로 종결된다.
app.post("/api/erp/quotations/:id/ship", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-quotations")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const user = req.body.user || "unknown";
    const now = new Date().toISOString();
    if (USE_JSON_FILE) {
      const q = _fileErp.quotations.find(q => q.id === id);
      if (!q) return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." });
      if (q.status !== "accepted") return res.status(400).json({ ok: false, message: "수주 확정된 견적서만 출고 처리할 수 있습니다." });
      if (!q.locationId) return res.status(400).json({ ok: false, message: "출고 위치가 지정되지 않은 견적서입니다." });
      for (const l of q.lines) {
        const current = _fileErp.stockLedger
          .filter(s => s.itemId === l.itemId && s.locationId === q.locationId)
          .reduce((sum, s) => sum + (s.type === "out" ? -Math.abs(s.qty) : Math.abs(s.qty)), 0);
        if (current < l.qty) return res.status(400).json({ ok: false, message: `재고 부족: ${l.name || l.itemId} (현재 ${current} / 필요 ${l.qty})` });
      }
      for (const l of q.lines) {
        _fileErp.stockLedger.push({
          id: `sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          itemId: l.itemId, locationId: q.locationId, type: "out", qty: l.qty,
          refType: "quotation", refId: q.id, refNo: q.quoteNo, memo: `견적 출고 (${q.quoteNo})`,
          createdBy: user, createdAt: now,
        });
      }
      const year = new Date(q.date).getFullYear();
      const seq = _nextAcctSeq("taxInvoiceSeq", year);
      const invoiceNo = `TI-${year}-${String(seq).padStart(6, "0")}`;
      const invTotals = _buildTaxInvoiceTotals(q.lines);
      const inv = {
        id: `ti_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        invoiceNo, status: "issued", direction: "sales",
        issueDate: q.date, partnerId: q.partnerId || null, partnerName: q.partnerName, partnerBizNo: await _lookupPartnerBizNo(q.partnerId, companyId),
        ...invTotals,
        createdBy: user, createdAt: now, sourceType: "quotation", sourceId: q.id, sourceNo: q.quoteNo,
      };
      _fileAccounting.taxInvoices.push(inv);
      q.status = "shipped"; q.shippedBy = user; q.shippedAt = now; q.taxInvoiceId = inv.id; q.taxInvoiceNo = inv.invoiceNo;
      _saveFileErp();
      _saveFileAccounting();
      return res.json({ ok: true, quotation: q, taxInvoice: inv });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data, status FROM erp_quotations WHERE id = $1 AND (company_id = $2 OR company_id IS NULL) FOR UPDATE", [id, companyId]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." }); }
      const q0 = rows[0].data;
      if (rows[0].status !== "accepted") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "수주 확정된 견적서만 출고 처리할 수 있습니다." }); }
      if (!q0.locationId) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "출고 위치가 지정되지 않은 견적서입니다." }); }
      await _lockStockKeys(client, companyId, q0.lines.map(l => [l.itemId, q0.locationId]));
      for (const l of q0.lines) {
        const { rows: ledgerRows } = await client.query(
          "SELECT data FROM erp_stock_ledger WHERE item_id = $1 AND location_id = $2 AND (company_id = $3 OR company_id IS NULL) FOR UPDATE", [l.itemId, q0.locationId, companyId]
        );
        const current = ledgerRows.reduce((sum, r) => sum + (r.data.type === "out" ? -Math.abs(r.data.qty) : Math.abs(r.data.qty)), 0);
        if (current < l.qty) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: `재고 부족: ${l.name || l.itemId} (현재 ${current} / 필요 ${l.qty})` }); }
      }
      for (const l of q0.lines) {
        await client.query(
          "INSERT INTO erp_stock_ledger (id, item_id, location_id, data, company_id) VALUES ($1,$2,$3,$4,$5)",
          [`sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, l.itemId, q0.locationId,
           { itemId: l.itemId, locationId: q0.locationId, type: "out", qty: l.qty, refType: "quotation", refId: q0.id, refNo: q0.quoteNo, memo: `견적 출고 (${q0.quoteNo})`, createdBy: user, createdAt: now }, companyId]
        );
      }
      const year = new Date(q0.date).getFullYear();
      const { rows: seqRows } = await client.query(
        "INSERT INTO tax_invoice_seq (company_id, year, seq) VALUES ($1,$2,1) ON CONFLICT (company_id, year) DO UPDATE SET seq = tax_invoice_seq.seq + 1 RETURNING seq", [companyId, year]
      );
      const invoiceNo = `TI-${year}-${String(seqRows[0].seq).padStart(6, "0")}`;
      const invTotals = _buildTaxInvoiceTotals(q0.lines);
      const inv = {
        id: `ti_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        invoiceNo, status: "issued", direction: "sales",
        issueDate: q0.date, partnerId: q0.partnerId || null, partnerName: q0.partnerName, partnerBizNo: await _lookupPartnerBizNo(q0.partnerId, companyId, client),
        ...invTotals,
        createdBy: user, createdAt: now, sourceType: "quotation", sourceId: q0.id, sourceNo: q0.quoteNo,
      };
      await client.query("INSERT INTO tax_invoices (id, invoice_no, issue_date, status, data, company_id) VALUES ($1,$2,$3,'issued',$4,$5)", [inv.id, invoiceNo, q0.date, inv, companyId]);
      const q = { ...q0, status: "shipped", shippedBy: user, shippedAt: now, taxInvoiceId: inv.id, taxInvoiceNo: inv.invoiceNo };
      await client.query("UPDATE erp_quotations SET status = 'shipped', data = $2, updated_at = NOW() WHERE id = $1", [id, q]);
      await client.query("COMMIT");
      res.json({ ok: true, quotation: q, taxInvoice: inv });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/quotations/:id/reject", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-quotations")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const reason = (req.body || {}).reason;
    if (!reason) return res.status(400).json({ ok: false, message: "반려/실주 사유를 입력하세요." });
    if (USE_JSON_FILE) {
      const q = _fileErp.quotations.find(q => q.id === id);
      if (!q) return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." });
      if (q.status !== "sent") return res.status(400).json({ ok: false, message: "발송된 견적서만 처리할 수 있습니다." });
      q.status = "rejected"; q.rejectReason = reason; q.rejectedBy = req.body.user || "unknown"; q.rejectedAt = new Date().toISOString();
      _saveFileErp();
      return res.json({ ok: true, quotation: q });
    }
    const { rows } = await pool.query("SELECT data FROM erp_quotations WHERE id = $1 AND status = 'sent' AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "발송된 견적서만 처리할 수 있습니다." });
    const q = { ...rows[0].data, status: "rejected", rejectReason: reason, rejectedBy: req.body.user || "unknown", rejectedAt: new Date().toISOString() };
    await pool.query("UPDATE erp_quotations SET status = 'rejected', data = $2, updated_at = NOW() WHERE id = $1", [id, q]);
    res.json({ ok: true, quotation: q });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.delete("/api/erp/quotations/:id", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-quotations")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    if (USE_JSON_FILE) {
      const q = _fileErp.quotations.find(q => q.id === id);
      if (!q) return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." });
      if (q.status !== "draft") return res.status(400).json({ ok: false, message: "임시 저장 상태의 견적서만 삭제할 수 있습니다." });
      _fileErp.quotations = _fileErp.quotations.filter(q => q.id !== id);
      _saveFileErp();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT 1 FROM erp_quotations WHERE id = $1 AND status = 'draft' AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "임시 저장 상태의 견적서만 삭제할 수 있습니다." });
    await pool.query("DELETE FROM erp_quotations WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 발주서 (Purchase orders) ────────────────────────────────────────────────
app.get("/api/erp/purchase-orders", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const year = req.query.year ? parseInt(req.query.year) : null;
    if (USE_JSON_FILE) {
      let list = _fileErp.purchaseOrders;
      if (year) list = list.filter(p => new Date(p.date).getFullYear() === year);
      return res.json({ ok: true, purchaseOrders: list.sort((a, b) => b.date.localeCompare(a.date)) });
    }
    const companyId = req.auth.companyId || null;
    const { rows } = year
      ? await pool.query("SELECT data FROM erp_purchase_orders WHERE EXTRACT(YEAR FROM doc_date) = $1 AND (company_id = $2 OR company_id IS NULL) ORDER BY doc_date DESC", [year, companyId])
      : await pool.query("SELECT data FROM erp_purchase_orders WHERE (company_id = $1 OR company_id IS NULL) ORDER BY doc_date DESC", [companyId]);
    res.json({ ok: true, purchaseOrders: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/purchase-orders", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-purchase-orders")) return;
    const companyId = req.auth.companyId || null;
    const { date, deliveryDate, partnerId, partnerName, locationId, items, memo, user: createdBy } = req.body || {};
    if (!date || !partnerName) return res.status(400).json({ ok: false, message: "발주일자와 거래처명은 필수입니다." });
    if (!locationId) return res.status(400).json({ ok: false, message: "입고 위치를 선택하세요." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, message: "품목을 1개 이상 입력하세요." });
    if (items.some(it => !it.itemId)) return res.status(400).json({ ok: false, message: "모든 라인에 품목을 선택하세요." });
    const _lineErr = _validateItemLines(items);
    if (_lineErr) return res.status(400).json({ ok: false, message: _lineErr });
    const totals = _buildItemLineTotals(items);
    const po = {
      id: `po_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      poNo: null, status: "draft",
      date, deliveryDate: deliveryDate || "", partnerId: partnerId || null, partnerName, locationId,
      ...totals, memo: memo || "",
      createdBy: createdBy || "unknown", createdAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      _fileErp.purchaseOrders.push(po);
      _saveFileErp();
      return res.json({ ok: true, purchaseOrder: po });
    }
    await pool.query("INSERT INTO erp_purchase_orders (id, doc_date, status, data, company_id) VALUES ($1,$2,'draft',$3,$4)", [po.id, date, po, companyId]);
    res.json({ ok: true, purchaseOrder: po });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/purchase-orders/:id/confirm", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-purchase-orders")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const year = new Date().getFullYear();
    if (USE_JSON_FILE) {
      const po = _fileErp.purchaseOrders.find(p => p.id === id);
      if (!po) return res.status(404).json({ ok: false, message: "발주서를 찾을 수 없습니다." });
      if (po.status !== "draft") return res.status(400).json({ ok: false, message: "임시 저장 상태의 발주서만 발주 확정할 수 있습니다." });
      const seq = _nextErpSeq("poSeq", year);
      po.poNo = `PO-${year}-${String(seq).padStart(6, "0")}`;
      po.status = "ordered"; po.orderedBy = req.body.user || "unknown"; po.orderedAt = new Date().toISOString();
      _saveFileErp();
      return res.json({ ok: true, purchaseOrder: po });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data, status FROM erp_purchase_orders WHERE id = $1 AND (company_id = $2 OR company_id IS NULL) FOR UPDATE", [id, companyId]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "발주서를 찾을 수 없습니다." }); }
      if (rows[0].status !== "draft") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "임시 저장 상태의 발주서만 발주 확정할 수 있습니다." }); }
      const { rows: seqRows } = await client.query(
        "INSERT INTO erp_po_seq (company_id, year, seq) VALUES ($1,$2,1) ON CONFLICT (company_id, year) DO UPDATE SET seq = erp_po_seq.seq + 1 RETURNING seq", [companyId, year]
      );
      const poNo = `PO-${year}-${String(seqRows[0].seq).padStart(6, "0")}`;
      const po = { ...rows[0].data, poNo, status: "ordered", orderedBy: req.body.user || "unknown", orderedAt: new Date().toISOString() };
      await client.query("UPDATE erp_purchase_orders SET status = 'ordered', data = $2, updated_at = NOW() WHERE id = $1", [id, po]);
      await client.query("COMMIT");
      res.json({ ok: true, purchaseOrder: po });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/purchase-orders/:id/receive", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-purchase-orders")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const user = req.body.user || "unknown";
    if (USE_JSON_FILE) {
      const po = _fileErp.purchaseOrders.find(p => p.id === id);
      if (!po) return res.status(404).json({ ok: false, message: "발주서를 찾을 수 없습니다." });
      if (po.status !== "ordered") return res.status(400).json({ ok: false, message: "발주 확정 상태의 발주서만 입고 처리할 수 있습니다." });
      const now = new Date().toISOString();
      for (const l of po.lines) {
        _fileErp.stockLedger.push({
          id: `sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          itemId: l.itemId, locationId: po.locationId, type: "in", qty: l.qty,
          refType: "po", refId: po.id, refNo: po.poNo, memo: `발주 입고 (${po.poNo})`,
          createdBy: user, createdAt: now,
        });
      }
      const year = new Date(po.date).getFullYear();
      const seq = _nextAcctSeq("taxInvoiceSeq", year);
      const invoiceNo = `TI-${year}-${String(seq).padStart(6, "0")}`;
      const invTotals = _buildTaxInvoiceTotals(po.lines);
      const inv = {
        id: `ti_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        invoiceNo, status: "issued", direction: "purchase",
        issueDate: po.date, partnerId: po.partnerId || null, partnerName: po.partnerName, partnerBizNo: await _lookupPartnerBizNo(po.partnerId, companyId),
        ...invTotals,
        createdBy: user, createdAt: now, sourceType: "po", sourceId: po.id, sourceNo: po.poNo,
      };
      _fileAccounting.taxInvoices.push(inv);
      po.status = "received"; po.receivedBy = user; po.receivedAt = now; po.taxInvoiceId = inv.id; po.taxInvoiceNo = inv.invoiceNo;
      _saveFileErp();
      _saveFileAccounting();
      return res.json({ ok: true, purchaseOrder: po, taxInvoice: inv });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data, status FROM erp_purchase_orders WHERE id = $1 AND (company_id = $2 OR company_id IS NULL) FOR UPDATE", [id, companyId]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "발주서를 찾을 수 없습니다." }); }
      if (rows[0].status !== "ordered") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "발주 확정 상태의 발주서만 입고 처리할 수 있습니다." }); }
      const po0 = rows[0].data;
      const now = new Date().toISOString();
      for (const l of po0.lines) {
        await client.query(
          "INSERT INTO erp_stock_ledger (id, item_id, location_id, data, company_id) VALUES ($1,$2,$3,$4,$5)",
          [`sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, l.itemId, po0.locationId,
           { itemId: l.itemId, locationId: po0.locationId, type: "in", qty: l.qty, refType: "po", refId: po0.id, refNo: po0.poNo, memo: `발주 입고 (${po0.poNo})`, createdBy: user, createdAt: now }, companyId]
        );
      }
      const year = new Date(po0.date).getFullYear();
      const { rows: seqRows } = await client.query(
        "INSERT INTO tax_invoice_seq (company_id, year, seq) VALUES ($1,$2,1) ON CONFLICT (company_id, year) DO UPDATE SET seq = tax_invoice_seq.seq + 1 RETURNING seq", [companyId, year]
      );
      const invoiceNo = `TI-${year}-${String(seqRows[0].seq).padStart(6, "0")}`;
      const invTotals = _buildTaxInvoiceTotals(po0.lines);
      const inv = {
        id: `ti_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        invoiceNo, status: "issued", direction: "purchase",
        issueDate: po0.date, partnerId: po0.partnerId || null, partnerName: po0.partnerName, partnerBizNo: await _lookupPartnerBizNo(po0.partnerId, companyId, client),
        ...invTotals,
        createdBy: user, createdAt: now, sourceType: "po", sourceId: po0.id, sourceNo: po0.poNo,
      };
      await client.query("INSERT INTO tax_invoices (id, invoice_no, issue_date, status, data, company_id) VALUES ($1,$2,$3,'issued',$4,$5)", [inv.id, invoiceNo, po0.date, inv, companyId]);
      const po = { ...po0, status: "received", receivedBy: user, receivedAt: now, taxInvoiceId: inv.id, taxInvoiceNo: inv.invoiceNo };
      await client.query("UPDATE erp_purchase_orders SET status = 'received', data = $2, updated_at = NOW() WHERE id = $1", [id, po]);
      await client.query("COMMIT");
      res.json({ ok: true, purchaseOrder: po, taxInvoice: inv });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/purchase-orders/:id/cancel", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-purchase-orders")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const reason = (req.body || {}).reason;
    if (!reason) return res.status(400).json({ ok: false, message: "취소 사유를 입력하세요." });
    if (USE_JSON_FILE) {
      const po = _fileErp.purchaseOrders.find(p => p.id === id);
      if (!po) return res.status(404).json({ ok: false, message: "발주서를 찾을 수 없습니다." });
      if (po.status === "received") return res.status(400).json({ ok: false, message: "이미 입고 처리된 발주서는 취소할 수 없습니다." });
      po.status = "cancelled"; po.cancelReason = reason; po.cancelledBy = req.body.user || "unknown"; po.cancelledAt = new Date().toISOString();
      _saveFileErp();
      return res.json({ ok: true, purchaseOrder: po });
    }
    const { rows } = await pool.query("SELECT data FROM erp_purchase_orders WHERE id = $1 AND status != 'received' AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "이미 입고 처리된 발주서는 취소할 수 없습니다." });
    const po = { ...rows[0].data, status: "cancelled", cancelReason: reason, cancelledBy: req.body.user || "unknown", cancelledAt: new Date().toISOString() };
    await pool.query("UPDATE erp_purchase_orders SET status = 'cancelled', data = $2, updated_at = NOW() WHERE id = $1", [id, po]);
    res.json({ ok: true, purchaseOrder: po });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.delete("/api/erp/purchase-orders/:id", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-purchase-orders")) return;
    const id = req.params.id;
    if (USE_JSON_FILE) {
      const po = _fileErp.purchaseOrders.find(p => p.id === id);
      if (!po) return res.status(404).json({ ok: false, message: "발주서를 찾을 수 없습니다." });
      if (po.status !== "draft") return res.status(400).json({ ok: false, message: "임시 저장 상태의 발주서만 삭제할 수 있습니다." });
      _fileErp.purchaseOrders = _fileErp.purchaseOrders.filter(p => p.id !== id);
      _saveFileErp();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT 1 FROM erp_purchase_orders WHERE id = $1 AND status = 'draft' AND (company_id = $2 OR company_id IS NULL)", [id, req.auth.companyId || null]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "임시 저장 상태의 발주서만 삭제할 수 있습니다." });
    await pool.query("DELETE FROM erp_purchase_orders WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 구매요청 (Purchase requests — 구성원이 요청, admin이 승인/반려/발주전환) ─────
app.get("/api/erp/purchase-requests", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    if (USE_JSON_FILE) {
      let list = _fileErp.purchaseRequests;
      if (role !== "admin") list = list.filter(r => String(r.requestedById) === String(userId));
      return res.json({ ok: true, purchaseRequests: list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    }
    const { rows } = role === "admin"
      ? await pool.query("SELECT data FROM erp_purchase_requests WHERE (company_id = $1 OR company_id IS NULL) ORDER BY created_at DESC", [companyId])
      : await pool.query("SELECT data FROM erp_purchase_requests WHERE data->>'requestedById' = $1 AND (company_id = $2 OR company_id IS NULL) ORDER BY created_at DESC", [String(userId), companyId]);
    res.json({ ok: true, purchaseRequests: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/purchase-requests", async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requirePage(req, res, "inv-purchase-requests")) return;
  try {
    const { empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    const { date, items, memo, user: requestedBy } = req.body || {};
    if (!date) return res.status(400).json({ ok: false, message: "요청일자는 필수입니다." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, message: "품목을 1개 이상 입력하세요." });
    if (items.some(it => !it.itemId)) return res.status(400).json({ ok: false, message: "모든 라인에 품목을 선택하세요." });
    const _lineErr = _validateItemLines(items);
    if (_lineErr) return res.status(400).json({ ok: false, message: _lineErr });
    const totals = _buildItemLineTotals(items);
    const pr = {
      id: `pr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: "pending",
      date, ...totals, memo: memo || "",
      // 과거에는 req.body.userId(클라이언트가 그대로 적어 보낸 값)를 그대로 신뢰해, member
      // 토큰으로도 userId만 admin의 id로 바꿔 보내면 admin 명의로 구매요청이 등록되고
      // (아래 DELETE 라우트의 본인 소유권 검사가 이 값을 근거로 판단하므로) 실제 요청자가
      // 삭제 권한까지 스푸핑할 수 있었다(실측 확인). 서버가 검증한 로그인 토큰(req.auth)만 신뢰한다.
      requestedById: String(userId), requestedBy: requestedBy || "unknown",
      createdAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      _fileErp.purchaseRequests.push(pr);
      _saveFileErp();
      return res.json({ ok: true, purchaseRequest: pr });
    }
    await pool.query("INSERT INTO erp_purchase_requests (id, doc_date, status, data, company_id) VALUES ($1,$2,'pending',$3,$4)", [pr.id, date, pr, companyId]);
    res.json({ ok: true, purchaseRequest: pr });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/purchase-requests/:id/approve", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "inv-purchase-requests")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const user = req.body.user || "unknown";
    if (USE_JSON_FILE) {
      const pr = _fileErp.purchaseRequests.find(r => r.id === id);
      if (!pr) return res.status(404).json({ ok: false, message: "구매요청을 찾을 수 없습니다." });
      if (pr.status !== "pending") return res.status(400).json({ ok: false, message: "대기 중인 요청만 승인할 수 있습니다." });
      pr.status = "approved"; pr.approvedBy = user; pr.approvedAt = new Date().toISOString();
      _saveFileErp();
      return res.json({ ok: true, purchaseRequest: pr });
    }
    const { rows } = await pool.query("SELECT data FROM erp_purchase_requests WHERE id = $1 AND status = 'pending' AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "대기 중인 요청만 승인할 수 있습니다." });
    const pr = { ...rows[0].data, status: "approved", approvedBy: user, approvedAt: new Date().toISOString() };
    await pool.query("UPDATE erp_purchase_requests SET status = 'approved', data = $2, updated_at = NOW() WHERE id = $1", [id, pr]);
    res.json({ ok: true, purchaseRequest: pr });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/purchase-requests/:id/reject", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "inv-purchase-requests")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const reason = (req.body || {}).reason;
    if (!reason) return res.status(400).json({ ok: false, message: "반려 사유를 입력하세요." });
    if (USE_JSON_FILE) {
      const pr = _fileErp.purchaseRequests.find(r => r.id === id);
      if (!pr) return res.status(404).json({ ok: false, message: "구매요청을 찾을 수 없습니다." });
      if (pr.status !== "pending") return res.status(400).json({ ok: false, message: "대기 중인 요청만 반려할 수 있습니다." });
      pr.status = "rejected"; pr.rejectReason = reason; pr.rejectedBy = req.body.user || "unknown"; pr.rejectedAt = new Date().toISOString();
      _saveFileErp();
      return res.json({ ok: true, purchaseRequest: pr });
    }
    const { rows } = await pool.query("SELECT data FROM erp_purchase_requests WHERE id = $1 AND status = 'pending' AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "대기 중인 요청만 반려할 수 있습니다." });
    const pr = { ...rows[0].data, status: "rejected", rejectReason: reason, rejectedBy: req.body.user || "unknown", rejectedAt: new Date().toISOString() };
    await pool.query("UPDATE erp_purchase_requests SET status = 'rejected', data = $2, updated_at = NOW() WHERE id = $1", [id, pr]);
    res.json({ ok: true, purchaseRequest: pr });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/purchase-requests/:id/convert-to-po", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "inv-purchase-requests")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const { partnerId, partnerName, locationId, user: createdBy } = req.body || {};
    if (!partnerName) return res.status(400).json({ ok: false, message: "거래처명은 필수입니다." });
    if (!locationId) return res.status(400).json({ ok: false, message: "입고 위치를 선택하세요." });
    if (USE_JSON_FILE) {
      const pr = _fileErp.purchaseRequests.find(r => r.id === id);
      if (!pr) return res.status(404).json({ ok: false, message: "구매요청을 찾을 수 없습니다." });
      if (pr.status !== "approved") return res.status(400).json({ ok: false, message: "승인된 요청만 발주로 전환할 수 있습니다." });
      const po = {
        id: `po_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        poNo: null, status: "draft",
        date: new Date().toISOString().slice(0, 10), deliveryDate: "", partnerId: partnerId || null, partnerName, locationId,
        lines: pr.lines, supplyTotal: pr.supplyTotal, taxTotal: pr.taxTotal, grandTotal: pr.grandTotal,
        memo: pr.memo, createdBy: createdBy || "unknown", createdAt: new Date().toISOString(),
        sourcePurchaseRequestId: pr.id,
      };
      _fileErp.purchaseOrders.push(po);
      pr.status = "converted"; pr.convertedPoId = po.id; pr.convertedAt = new Date().toISOString();
      _saveFileErp();
      return res.json({ ok: true, purchaseOrder: po, purchaseRequest: pr });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data, status FROM erp_purchase_requests WHERE id = $1 AND (company_id = $2 OR company_id IS NULL) FOR UPDATE", [id, companyId]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "구매요청을 찾을 수 없습니다." }); }
      if (rows[0].status !== "approved") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "승인된 요청만 발주로 전환할 수 있습니다." }); }
      const pr0 = rows[0].data;
      const po = {
        id: `po_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        poNo: null, status: "draft",
        date: new Date().toISOString().slice(0, 10), deliveryDate: "", partnerId: partnerId || null, partnerName, locationId,
        lines: pr0.lines, supplyTotal: pr0.supplyTotal, taxTotal: pr0.taxTotal, grandTotal: pr0.grandTotal,
        memo: pr0.memo, createdBy: createdBy || "unknown", createdAt: new Date().toISOString(),
        sourcePurchaseRequestId: pr0.id,
      };
      await client.query("INSERT INTO erp_purchase_orders (id, doc_date, status, data, company_id) VALUES ($1,$2,'draft',$3,$4)", [po.id, po.date, po, companyId]);
      const pr = { ...pr0, status: "converted", convertedPoId: po.id, convertedAt: new Date().toISOString() };
      await client.query("UPDATE erp_purchase_requests SET status = 'converted', data = $2, updated_at = NOW() WHERE id = $1", [id, pr]);
      await client.query("COMMIT");
      res.json({ ok: true, purchaseOrder: po, purchaseRequest: pr });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.delete("/api/erp/purchase-requests/:id", async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requirePage(req, res, "inv-purchase-requests")) return;
  try {
    const id = req.params.id;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    if (USE_JSON_FILE) {
      const pr = _fileErp.purchaseRequests.find(r => r.id === id);
      if (!pr) return res.status(404).json({ ok: false, message: "구매요청을 찾을 수 없습니다." });
      if (pr.status !== "pending") return res.status(400).json({ ok: false, message: "대기 중인 요청만 삭제할 수 있습니다." });
      if (role !== "admin" && String(pr.requestedById) !== String(userId)) return res.status(403).json({ ok: false, message: "본인 요청만 삭제할 수 있습니다." });
      _fileErp.purchaseRequests = _fileErp.purchaseRequests.filter(r => r.id !== id);
      _saveFileErp();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT data FROM erp_purchase_requests WHERE id = $1 AND status = 'pending' AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "대기 중인 요청만 삭제할 수 있습니다." });
    if (role !== "admin" && String(rows[0].data.requestedById) !== String(userId)) return res.status(403).json({ ok: false, message: "본인 요청만 삭제할 수 있습니다." });
    await pool.query("DELETE FROM erp_purchase_requests WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 재고 (Stock — computed from ledger, plus manual adjustment) ──────────────
app.get("/api/erp/stock", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    let ledger;
    if (USE_JSON_FILE) {
      ledger = _fileErp.stockLedger;
    } else {
      const { rows } = await pool.query("SELECT data FROM erp_stock_ledger WHERE (company_id = $1 OR company_id IS NULL)", [req.auth.companyId || null]);
      ledger = rows.map(r => r.data);
    }
    const map = {};
    for (const l of ledger) {
      const key = `${l.itemId}::${l.locationId}`;
      const delta = l.type === "out" ? -Math.abs(l.qty) : Math.abs(l.qty);
      map[key] = (map[key] || 0) + delta;
    }
    const stock = Object.entries(map).map(([key, qty]) => {
      const [itemId, locationId] = key.split("::");
      return { itemId, locationId, qty };
    });
    res.json({ ok: true, stock });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.get("/api/erp/stock/ledger", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { itemId, locationId } = req.query;
    let ledger;
    if (USE_JSON_FILE) {
      ledger = _fileErp.stockLedger;
    } else {
      const { rows } = await pool.query("SELECT data FROM erp_stock_ledger WHERE (company_id = $1 OR company_id IS NULL)", [req.auth.companyId || null]);
      ledger = rows.map(r => r.data);
    }
    if (itemId) ledger = ledger.filter(l => l.itemId === itemId);
    if (locationId) ledger = ledger.filter(l => l.locationId === locationId);
    res.json({ ok: true, ledger: ledger.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/stock/adjust", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "inv-stock")) return;
    const companyId = req.auth.companyId || null;
    const { itemId, locationId, type, qty, memo, user } = req.body || {};
    if (!itemId || !locationId) return res.status(400).json({ ok: false, message: "품목과 위치를 선택하세요." });
    if (!["in", "out"].includes(type)) return res.status(400).json({ ok: false, message: "입고/출고 구분이 올바르지 않습니다." });
    // Math.abs()로 감싸고 있어 qty:-5를 보내면 조용히 5로 바뀌어 처리됐다 — 입고/출고 방향은
    // type이 정하므로 음수 수량은 사용자의 오입력이거나 연동 버그이지 "절대값으로 처리하라"는
    // 뜻이 아니다. 조용히 고치지 말고 거부한다.
    const qtyRaw = Number(qty);
    if (!Number.isFinite(qtyRaw) || qtyRaw <= 0) return res.status(400).json({ ok: false, message: "수량은 0보다 큰 숫자여야 합니다." });
    const qtyNum = qtyRaw;
    const refErr = await _erpRefsExist(itemId, [locationId], companyId);
    if (refErr) return res.status(404).json({ ok: false, message: refErr });
    const entry = {
      id: `sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      itemId, locationId, type, qty: qtyNum, refType: "manual", refId: null, refNo: null,
      memo: memo || "", createdBy: user || "unknown", createdAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      const current = _fileErp.stockLedger.filter(l => l.itemId === itemId && l.locationId === locationId)
        .reduce((s, l) => s + (l.type === "out" ? -Math.abs(l.qty) : Math.abs(l.qty)), 0);
      if (type === "out" && current < qtyNum) return res.status(400).json({ ok: false, message: `현재 재고(${current})보다 많은 수량을 출고할 수 없습니다.` });
      _fileErp.stockLedger.push(entry);
      _saveFileErp();
      return res.json({ ok: true, entry });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await _lockStockKeys(client, companyId, [[itemId, locationId]]);
      const { rows } = await client.query("SELECT data FROM erp_stock_ledger WHERE item_id = $1 AND location_id = $2 AND (company_id = $3 OR company_id IS NULL)", [itemId, locationId, companyId]);
      const current = rows.reduce((s, r) => s + (r.data.type === "out" ? -Math.abs(r.data.qty) : Math.abs(r.data.qty)), 0);
      if (type === "out" && current < qtyNum) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: `현재 재고(${current})보다 많은 수량을 출고할 수 없습니다.` }); }
      await client.query("INSERT INTO erp_stock_ledger (id, item_id, location_id, data, company_id) VALUES ($1,$2,$3,$4,$5)", [entry.id, itemId, locationId, entry, companyId]);
      await client.query("COMMIT");
      res.json({ ok: true, entry });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// 재고 실사: 여러 품목의 실사 수량을 한 번에 접수해 시스템 재고와의 차이만큼
// 조정 원장(refType:"count")을 생성한다. 차이가 0인 품목은 원장을 남기지 않는다.
app.post("/api/erp/stock/count", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "inv-stock")) return;
    const companyId = req.auth.companyId || null;
    const { locationId, lines, user } = req.body || {};
    if (!locationId || !Array.isArray(lines) || !lines.length)
      return res.status(400).json({ ok: false, message: "위치와 실사 항목이 필요합니다." });
    // 실사 수량은 "창고에서 실제로 센 개수"라 음수가 될 수 없다. 검증이 없어 countedQty:-50이
    // 그대로 접수되면 그 차이만큼 출고 원장이 생겨 재고가 마이너스로 내려갔다.
    const negLine = lines.find(l => l && l.itemId && Number.isFinite(Number(l.countedQty)) && Number(l.countedQty) < 0);
    if (negLine) {
      return res.status(400).json({ ok: false, message: "실사 수량은 0 이상이어야 합니다." });
    }
    {
      const locErr = await _erpRefsExist(null, [locationId], companyId);
      if (locErr) return res.status(404).json({ ok: false, message: locErr });
      for (const l of lines) {
        if (!l || !l.itemId) continue;
        const itemErr = await _erpRefsExist(l.itemId, [], companyId);
        if (itemErr) return res.status(404).json({ ok: false, message: itemErr });
      }
    }
    const now = new Date().toISOString();
    const countId = `count_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (USE_JSON_FILE) {
      const ledger = _fileErp.stockLedger;
      const entries = [];
      for (const l of lines) {
        const itemId = l.itemId, countedQty = Number(l.countedQty);
        if (!itemId || !Number.isFinite(countedQty)) continue;
        const current = ledger.filter(x => x.itemId === itemId && x.locationId === locationId)
          .reduce((s, x) => s + (x.type === "out" ? -Math.abs(x.qty) : Math.abs(x.qty)), 0);
        const diff = countedQty - current;
        if (diff === 0) continue;
        entries.push({
          id: `sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${entries.length}`,
          itemId, locationId, type: diff > 0 ? "in" : "out", qty: Math.abs(diff),
          refType: "count", refId: countId, refNo: null,
          memo: `재고실사 조정 (시스템 ${current} → 실사 ${countedQty})`,
          createdBy: user || "unknown", createdAt: now,
        });
      }
      _fileErp.stockLedger.push(...entries);
      _saveFileErp();
      return res.json({ ok: true, adjusted: entries.length, entries });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await _lockStockKeys(client, companyId, lines.filter(l => l.itemId).map(l => [l.itemId, locationId]));
      const { rows } = await client.query("SELECT data FROM erp_stock_ledger WHERE location_id = $1 AND (company_id = $2 OR company_id IS NULL)", [locationId, companyId]);
      const ledger = rows.map(r => r.data);
      const entries = [];
      for (const l of lines) {
        const itemId = l.itemId, countedQty = Number(l.countedQty);
        if (!itemId || !Number.isFinite(countedQty)) continue;
        const current = ledger.filter(x => x.itemId === itemId && x.locationId === locationId)
          .reduce((s, x) => s + (x.type === "out" ? -Math.abs(x.qty) : Math.abs(x.qty)), 0);
        const diff = countedQty - current;
        if (diff === 0) continue;
        entries.push({
          id: `sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${entries.length}`,
          itemId, locationId, type: diff > 0 ? "in" : "out", qty: Math.abs(diff),
          refType: "count", refId: countId, refNo: null,
          memo: `재고실사 조정 (시스템 ${current} → 실사 ${countedQty})`,
          createdBy: user || "unknown", createdAt: now,
        });
      }
      for (const e of entries) {
        await client.query("INSERT INTO erp_stock_ledger (id, item_id, location_id, data, company_id) VALUES ($1,$2,$3,$4,$5)", [e.id, e.itemId, e.locationId, e, companyId]);
      }
      await client.query("COMMIT");
      res.json({ ok: true, adjusted: entries.length, entries });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// 창고 간 이동: 출발 위치에서 출고(out)하고 도착 위치에 입고(in)하는 원장 쌍을 생성한다.
// 두 항목은 같은 transferId/refType:"transfer"로 묶여 이동 이력으로 함께 조회할 수 있다.
app.post("/api/erp/stock/transfer", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "inv-stock")) return;
    const companyId = req.auth.companyId || null;
    const { itemId, fromLocationId, toLocationId, qty, memo, user } = req.body || {};
    if (!itemId || !fromLocationId || !toLocationId) return res.status(400).json({ ok: false, message: "품목과 출발/도착 위치를 선택하세요." });
    if (fromLocationId === toLocationId) return res.status(400).json({ ok: false, message: "출발 위치와 도착 위치가 같을 수 없습니다." });
    const qtyRawT = Number(qty);
    if (!Number.isFinite(qtyRawT) || qtyRawT <= 0) return res.status(400).json({ ok: false, message: "수량은 0보다 큰 숫자여야 합니다." });
    const qtyNum = qtyRawT;
    const refErrT = await _erpRefsExist(itemId, [fromLocationId, toLocationId], companyId);
    if (refErrT) return res.status(404).json({ ok: false, message: refErrT });
    const transferId = `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const createdBy = user || "unknown";
    if (USE_JSON_FILE) {
      const current = _fileErp.stockLedger.filter(l => l.itemId === itemId && l.locationId === fromLocationId)
        .reduce((s, l) => s + (l.type === "out" ? -Math.abs(l.qty) : Math.abs(l.qty)), 0);
      if (current < qtyNum) return res.status(400).json({ ok: false, message: `출발 위치 재고 부족 (현재 ${current} / 이동 요청 ${qtyNum})` });
      const outEntry = { id: `sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, itemId, locationId: fromLocationId, type: "out", qty: qtyNum, refType: "transfer", refId: transferId, refNo: null, memo: memo || "", createdBy, createdAt: now };
      const inEntry = { id: `sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, itemId, locationId: toLocationId, type: "in", qty: qtyNum, refType: "transfer", refId: transferId, refNo: null, memo: memo || "", createdBy, createdAt: now };
      _fileErp.stockLedger.push(outEntry, inEntry);
      _saveFileErp();
      return res.json({ ok: true, transferId, outEntry, inEntry });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await _lockStockKeys(client, companyId, [[itemId, fromLocationId], [itemId, toLocationId]]);
      const { rows: ledgerRows } = await client.query("SELECT data FROM erp_stock_ledger WHERE item_id = $1 AND location_id = $2 AND (company_id = $3 OR company_id IS NULL)", [itemId, fromLocationId, companyId]);
      const current = ledgerRows.reduce((s, r) => s + (r.data.type === "out" ? -Math.abs(r.data.qty) : Math.abs(r.data.qty)), 0);
      if (current < qtyNum) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: `출발 위치 재고 부족 (현재 ${current} / 이동 요청 ${qtyNum})` }); }
      const outEntry = { itemId, locationId: fromLocationId, type: "out", qty: qtyNum, refType: "transfer", refId: transferId, refNo: null, memo: memo || "", createdBy, createdAt: now };
      const inEntry = { itemId, locationId: toLocationId, type: "in", qty: qtyNum, refType: "transfer", refId: transferId, refNo: null, memo: memo || "", createdBy, createdAt: now };
      await client.query("INSERT INTO erp_stock_ledger (id, item_id, location_id, data, company_id) VALUES ($1,$2,$3,$4,$5)", [`sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, itemId, fromLocationId, outEntry, companyId]);
      await client.query("INSERT INTO erp_stock_ledger (id, item_id, location_id, data, company_id) VALUES ($1,$2,$3,$4,$5)", [`sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, itemId, toLocationId, inEntry, companyId]);
      await client.query("COMMIT");
      res.json({ ok: true, transferId, outEntry, inEntry });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── ERP: 영업 목표 (Sales targets — admin only CRUD, actuals computed client-side) ──
app.get("/api/erp/sales-targets", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, salesTargets: _fileErp.salesTargets });
    const { rows } = await pool.query(
      "SELECT id, data FROM erp_sales_targets WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL) ORDER BY id", [req.auth.companyId || null]
    );
    res.json({ ok: true, salesTargets: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/sales-targets", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-dashboard")) return;
    const { id, year, month, employeeId, employeeName, targetAmount, memo } = req.body || {};
    if (!year) return res.status(400).json({ ok: false, message: "연도는 필수입니다." });
    if (targetAmount == null || isNaN(Number(targetAmount))) return res.status(400).json({ ok: false, message: "목표 금액은 필수입니다." });
    const targetId = id || `target_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const target = {
      id: targetId,
      year: Number(year), month: month != null && month !== "" ? Number(month) : null,
      employeeId: employeeId != null ? String(employeeId) : null, employeeName: employeeName || "",
      targetAmount: Number(targetAmount), memo: memo || "",
      updatedAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      const idx = _fileErp.salesTargets.findIndex(t => t.id === targetId);
      if (idx >= 0) _fileErp.salesTargets[idx] = target; else _fileErp.salesTargets.push(target);
      _saveFileErp();
      return res.json({ ok: true, salesTarget: target });
    }
    await pool.query(
      "INSERT INTO erp_sales_targets (id, company_id, data) VALUES ($1,$2,$3) ON CONFLICT (company_id, id) DO UPDATE SET data = $3, updated_at = NOW()",
      [targetId, req.auth.companyId || null, target]
    );
    res.json({ ok: true, salesTarget: target });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/erp/sales-targets/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!requirePage(req, res, "sales-dashboard")) return;
    const id = req.params.id;
    if (USE_JSON_FILE) {
      _fileErp.salesTargets = _fileErp.salesTargets.filter(t => t.id !== id);
      _saveFileErp();
      return res.json({ ok: true });
    }
    await pool.query("UPDATE erp_sales_targets SET is_deleted = TRUE WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, req.auth.companyId || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── PMS: 프로젝트 투입률 관리 (Projects / monthly allocation %) ────────────────
// PMS 데이터에는 거래처·메모·투입 인원이 포함된다. 화면에서만 숨기면 API 호출로
// 다른 팀 프로젝트를 읽거나 수정할 수 있으므로, 조회/변경 권한을 서버에서 판정한다.
function _pmsMemberIds(project) {
  return new Set([
    ...(Array.isArray(project?.members) ? project.members : []),
    project?.pmId,
    project?.createdById,
  ].filter(Boolean).map(String));
}

async function _pmsEmployeeMap(companyId) {
  const data = await loadData(companyId);
  return new Map((data.employees || []).map(employee => [String(employee.id), employee]));
}

function _pmsCanViewProject(project, auth, employeesById) {
  if (!project || !auth) return false;
  if (auth.role === "admin") return true;
  const actorId = String(auth.empId);
  const members = _pmsMemberIds(project);
  if (members.has(actorId)) return true;

  const actor = employeesById.get(actorId);
  if (!actor) return false;
  const participants = [...members].map(id => employeesById.get(id)).filter(Boolean);
  if (auth.role === "leader") {
    return participants.some(employee => employee.dept === actor.dept && employee.team === actor.team);
  }
  if (auth.role === "director") {
    return participants.some(employee => employee.dept === actor.dept);
  }
  return false;
}

function _pmsCanManageProject(project, auth) {
  if (!project || !auth) return false;
  if (auth.role === "admin") return true;
  // 팀장은 자신이 생성했거나 PM으로 지정된 프로젝트만 변경할 수 있다. 단순히
  // 같은 팀이라는 이유만으로 다른 팀장의 프로젝트를 변경하지 않도록 한다.
  return auth.role === "leader" && (
    String(project.pmId || "") === String(auth.empId) ||
    String(project.createdById || "") === String(auth.empId)
  );
}

function _pmsNormalizeMembers(members, pmId, createdById) {
  return [...new Set([
    ...(Array.isArray(members) ? members : []),
    pmId,
    createdById,
  ].filter(Boolean).map(String))];
}

function _pmsConflict(res, project) {
  return res.status(409).json({
    ok: false,
    code: "PMS_PROJECT_CONFLICT",
    message: "다른 사용자가 먼저 수정했습니다. 최신 내용을 불러온 뒤 다시 시도하세요.",
    project,
  });
}

app.get("/api/pms/projects", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const companyId = req.auth.companyId || null;
    const employeesById = await _pmsEmployeeMap(companyId);
    let projects;
    if (USE_JSON_FILE) {
      projects = _filePms.projects;
    } else {
      const { rows } = await pool.query(
        "SELECT id, data FROM pms_projects WHERE is_deleted = FALSE AND company_id IS NOT DISTINCT FROM $1 ORDER BY created_at DESC",
        [companyId]
      );
      projects = rows.map(r => ({ id: r.id, ...r.data }));
    }
    const visible = projects
      .filter(project => _pmsCanViewProject(project, req.auth, employeesById))
      .map(project => ({ ...project, canManage: _pmsCanManageProject(project, req.auth) }));
    res.json({ ok: true, projects: visible });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/pms/projects", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader"])) return;
    if (!requirePage(req, res, "pms-projects")) return;
    const companyId = req.auth.companyId || null;
    const { id, name, startDate, endDate, partnerId, pmId, memo, members } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, message: "프로젝트명은 필수입니다." });
    // 생성 API를 upsert로 두면 id만 아는 사용자가 기존 프로젝트를 덮어쓸 수 있다.
    if (id) return res.status(400).json({ ok: false, message: "프로젝트 ID는 서버가 생성합니다." });
    const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const createdById = String(req.auth.empId);
    const employeesById = await _pmsEmployeeMap(companyId);
    const creator = employeesById.get(createdById);
    const effectivePmId = String(pmId || createdById);
    if (USE_JSON_FILE) {
      const project = {
        id: projectId, name, startDate: startDate || "", endDate: endDate || "",
        partnerId: partnerId || null, pmId: effectivePmId,
        status: "active", memo: memo || "",
        members: _pmsNormalizeMembers(members, effectivePmId, createdById),
        createdById, createdByName: creator?.name || "unknown", createdBy: creator?.name || "unknown",
        createdAt: now, updatedAt: now,
      };
      _filePms.projects.push(project);
      _saveFilePms();
      return res.json({ ok: true, project });
    }
    const project = {
      id: projectId, name, startDate: startDate || "", endDate: endDate || "",
      partnerId: partnerId || null, pmId: effectivePmId,
      status: "active", memo: memo || "",
      members: _pmsNormalizeMembers(members, effectivePmId, createdById),
      createdById, createdByName: creator?.name || "unknown", createdBy: creator?.name || "unknown",
      createdAt: now, updatedAt: now,
    };
    await pool.query(
      "INSERT INTO pms_projects (id, company_id, data) VALUES ($1,$2,$3)",
      [projectId, companyId, project]
    );
    res.json({ ok: true, project });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/pms/projects/:id", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader"])) return;
    if (!requirePage(req, res, "pms-projects")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const { name, startDate, endDate, partnerId, pmId, status, memo, members, expectedUpdatedAt } = req.body || {};
    if (USE_JSON_FILE) {
      const project = _filePms.projects.find(p => p.id === id);
      if (!project) return res.status(404).json({ ok: false, message: "프로젝트를 찾을 수 없습니다." });
      if (!_pmsCanManageProject(project, req.auth)) return res.status(403).json({ ok: false, message: "이 프로젝트를 변경할 권한이 없습니다." });
      if (expectedUpdatedAt && project.updatedAt !== expectedUpdatedAt) return _pmsConflict(res, project);
      if (name != null) project.name = name;
      if (startDate != null) project.startDate = startDate;
      if (endDate != null) project.endDate = endDate;
      if (partnerId != null) project.partnerId = partnerId;
      if (pmId != null) project.pmId = String(pmId);
      if (status != null) project.status = status;
      if (memo != null) project.memo = memo;
      project.members = _pmsNormalizeMembers(Array.isArray(members) ? members : project.members, project.pmId, project.createdById);
      project.updatedAt = new Date().toISOString();
      _saveFilePms();
      return res.json({ ok: true, project });
    }
    const { rows } = await pool.query("SELECT data FROM pms_projects WHERE id = $1 AND company_id IS NOT DISTINCT FROM $2 AND is_deleted = FALSE", [id, companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "프로젝트를 찾을 수 없습니다." });
    const project = { ...rows[0].data };
    if (!_pmsCanManageProject(project, req.auth)) return res.status(403).json({ ok: false, message: "이 프로젝트를 변경할 권한이 없습니다." });
    if (expectedUpdatedAt && project.updatedAt !== expectedUpdatedAt) return _pmsConflict(res, project);
    if (name != null) project.name = name;
    if (startDate != null) project.startDate = startDate;
    if (endDate != null) project.endDate = endDate;
    if (partnerId != null) project.partnerId = partnerId;
    if (pmId != null) project.pmId = String(pmId);
    if (status != null) project.status = status;
    if (memo != null) project.memo = memo;
    project.members = _pmsNormalizeMembers(Array.isArray(members) ? members : project.members, project.pmId, project.createdById);
    project.updatedAt = new Date().toISOString();
    // id는 tenant마다 재사용될 수 있다(pms_projects PK = company_id + id). company_id 없이
    // 갱신하면 다른 회사의 동일 id 프로젝트까지 함께 덮어쓰는 교차-tenant 데이터 손상이 난다.
    const updateParams = [id, project, companyId];
    let sql = "UPDATE pms_projects SET data = $2, updated_at = NOW() WHERE id = $1 AND company_id IS NOT DISTINCT FROM $3";
    if (expectedUpdatedAt) { updateParams.push(expectedUpdatedAt); sql += " AND data->>'updatedAt' = $4"; }
    const result = await pool.query(sql, updateParams);
    if (!result.rowCount) {
      const latest = await _pmsProjectById(id, companyId);
      return _pmsConflict(res, latest);
    }
    res.json({ ok: true, project });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/pms/projects/:id/close", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader"])) return;
    if (!requirePage(req, res, "pms-projects")) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const { expectedUpdatedAt } = req.body || {};
    if (USE_JSON_FILE) {
      const project = _filePms.projects.find(p => p.id === id);
      if (!project) return res.status(404).json({ ok: false, message: "프로젝트를 찾을 수 없습니다." });
      if (!_pmsCanManageProject(project, req.auth)) return res.status(403).json({ ok: false, message: "이 프로젝트를 종료할 권한이 없습니다." });
      if (expectedUpdatedAt && project.updatedAt !== expectedUpdatedAt) return _pmsConflict(res, project);
      project.status = "closed";
      project.updatedAt = new Date().toISOString();
      _saveFilePms();
      return res.json({ ok: true, project });
    }
    const { rows } = await pool.query("SELECT data FROM pms_projects WHERE id = $1 AND company_id IS NOT DISTINCT FROM $2 AND is_deleted = FALSE", [id, companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "프로젝트를 찾을 수 없습니다." });
    const current = rows[0].data;
    if (!_pmsCanManageProject(current, req.auth)) return res.status(403).json({ ok: false, message: "이 프로젝트를 종료할 권한이 없습니다." });
    if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) return _pmsConflict(res, current);
    const project = { ...current, status: "closed", updatedAt: new Date().toISOString() };
    const updateParams = [id, project, companyId];
    let sql = "UPDATE pms_projects SET data = $2, updated_at = NOW() WHERE id = $1 AND company_id IS NOT DISTINCT FROM $3";
    if (expectedUpdatedAt) { updateParams.push(expectedUpdatedAt); sql += " AND data->>'updatedAt' = $4"; }
    const result = await pool.query(sql, updateParams);
    if (!result.rowCount) {
      const latest = await _pmsProjectById(id, companyId);
      return _pmsConflict(res, latest);
    }
    res.json({ ok: true, project });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// 직원별 월간 투입률(%) 배정 — 본인 또는 admin만 등록/삭제 가능, 합계 100% 초과 금지
async function _allocationMonthTotal(employeeId, year, month, excludeId) {
  if (USE_JSON_FILE) {
    return _filePms.allocations
      .filter(a => String(a.employeeId) === String(employeeId) && Number(a.year) === Number(year) && Number(a.month) === Number(month) && a.id !== excludeId)
      .reduce((s, a) => s + (Number(a.percent) || 0), 0);
  }
  const { rows } = await pool.query(
    "SELECT data FROM pms_allocations WHERE employee_id = $1 AND year = $2 AND month = $3 AND is_deleted = FALSE AND id != $4",
    [employeeId, year, month, excludeId || ""]
  );
  return rows.reduce((s, r) => s + (Number(r.data.percent) || 0), 0);
}

app.get("/api/pms/allocations", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    let { year, month, employeeId } = req.query;
    // "가동률 현황"(pms-utilization) 화면은 PAGE_ROLES상 admin/director/leader 전용인데
    // 이 API는 requireAuth만 있어 member 토큰으로 ?employeeId=<타인 id>를 직접 넣으면
    // 무관 부서 타 직원의 프로젝트 투입률까지 그대로 조회됐다(실측 확인). member는
    // 쿼리로 무엇을 보내든 본인 employeeId로 강제한다.
    if (role === "member") employeeId = String(userId);
    if (USE_JSON_FILE) {
      let list = _filePms.allocations;
      if (year) list = list.filter(a => Number(a.year) === Number(year));
      if (month) list = list.filter(a => Number(a.month) === Number(month));
      if (employeeId) list = list.filter(a => String(a.employeeId) === String(employeeId));
      return res.json({ ok: true, allocations: list });
    }
    const conditions = ["is_deleted = FALSE", "(company_id = $1 OR company_id IS NULL)"];
    const params = [companyId];
    if (year) { params.push(Number(year)); conditions.push(`year = $${params.length}`); }
    if (month) { params.push(Number(month)); conditions.push(`month = $${params.length}`); }
    if (employeeId) { params.push(Number(employeeId)); conditions.push(`employee_id = $${params.length}`); }
    const { rows } = await pool.query(`SELECT data FROM pms_allocations WHERE ${conditions.join(" AND ")} ORDER BY year, month`, params);
    res.json({ ok: true, allocations: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

async function _pmsProjectById(projectId, companyId) {
  if (USE_JSON_FILE) return _filePms.projects.find(p => p.id === projectId) || null;
  const { rows } = await pool.query(
    "SELECT data FROM pms_projects WHERE id = $1 AND is_deleted = FALSE AND company_id IS NOT DISTINCT FROM $2", [projectId, companyId || null]
  );
  return rows[0] ? rows[0].data : null;
}

app.post("/api/pms/allocations", async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requirePage(req, res, "pms-allocation")) return;
  try {
    const { id, employeeId, year, month, projectId, percent, memo } = req.body || {};
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    if (!employeeId || !year || !month || !projectId) return res.status(400).json({ ok: false, message: "직원, 연도, 월, 프로젝트는 필수입니다." });
    const percentNum = Number(percent);
    if (isNaN(percentNum) || percentNum <= 0) return res.status(400).json({ ok: false, message: "투입률은 0보다 큰 숫자여야 합니다." });
    // 화면은 셀렉트로 월을 고르지만 서버는 값을 전혀 보지 않아 month=99 같은 값이 그대로
    // 저장됐다 — 그런 행은 어떤 월별 집계에도 잡히지 않아 조용히 유실된 것처럼 보인다.
    const yearNum = Number(year), monthNum = Number(month);
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ ok: false, message: "월은 1~12 사이여야 합니다." });
    }
    if (!Number.isInteger(yearNum) || yearNum < 1900 || yearNum > 2200) {
      return res.status(400).json({ ok: false, message: "연도가 올바르지 않습니다." });
    }
    if (role !== "admin" && String(employeeId) !== String(userId)) return res.status(403).json({ ok: false, message: "본인 투입률만 등록할 수 있습니다." });
    if (id && role !== "admin") return res.status(403).json({ ok: false, message: "확정된 투입률은 관리자만 변경할 수 있습니다." });
    // 프로젝트 존재 검증은 원래 non-admin 분기 안에만 있어, admin은 존재하지 않는 projectId로도
    // 투입률을 만들 수 있었다(화면에서 프로젝트명이 빈 칸으로 보이는 유령 행) — 존재 검증은
    // 역할과 무관하게 항상 하고, "멤버여야 한다"는 제약만 non-admin에 남긴다.
    const project = await _pmsProjectById(projectId, companyId);
    if (!project) return res.status(404).json({ ok: false, message: "프로젝트를 찾을 수 없습니다." });
    if (project.status !== "active") return res.status(409).json({ ok: false, message: "종료된 프로젝트에는 투입률을 등록할 수 없습니다." });
    if (role !== "admin") {
      if (!(project.members || []).map(String).includes(String(employeeId))) {
        return res.status(403).json({ ok: false, message: "투입 인원으로 등록된 프로젝트만 선택할 수 있습니다." });
      }
    }
    const allocId = id || `alloc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const alloc = {
      id: allocId, employeeId: String(employeeId), year: Number(year), month: Number(month),
      projectId, percent: percentNum, memo: memo || "", updatedAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      const otherTotal = await _allocationMonthTotal(employeeId, year, month, allocId);
      if (otherTotal + percentNum > 100) return res.status(400).json({ ok: false, message: `투입률 합계가 100%를 초과합니다 (기존 ${otherTotal}% + 신규 ${percentNum}%).` });
      const idx = _filePms.allocations.findIndex(a => a.id === allocId);
      if (idx >= 0) _filePms.allocations[idx] = alloc; else _filePms.allocations.push(alloc);
      _saveFilePms();
      return res.json({ ok: true, allocation: alloc });
    }
    // 여러 요청이 같은 직원·같은 달의 투입률을 거의 동시에 등록하면, 각자 "합계 조회 →
    // 100% 이하인지 확인 → 등록"을 순서 보장 없이 수행해(check-then-act) 합계가 100%를
    // 넘게 등록될 수 있었다(실측: 15건 동시 등록 시 캡이 완전히 무력화되어 합계 120%까지
    // 초과). employeeId+year+month 조합에 advisory lock을 걸어 같은 달을 다루는 요청을
    // 확실히 순번대로 세운다. companyId를 키 앞에 붙여 회사 간 잠금 충돌을 막는다.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`alloc:${companyId || ""}:${employeeId}:${year}:${month}`]);
      const { rows } = await client.query(
        "SELECT data FROM pms_allocations WHERE employee_id = $1 AND year = $2 AND month = $3 AND is_deleted = FALSE AND id != $4 AND (company_id = $5 OR company_id IS NULL)",
        [employeeId, year, month, allocId, companyId]
      );
      const otherTotal = rows.reduce((s, r) => s + (Number(r.data.percent) || 0), 0);
      if (otherTotal + percentNum > 100) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, message: `투입률 합계가 100%를 초과합니다 (기존 ${otherTotal}% + 신규 ${percentNum}%).` });
      }
      await client.query(
        "INSERT INTO pms_allocations (id, employee_id, year, month, data, company_id) VALUES ($1,$2,$3,$4,$5,$6) " +
        "ON CONFLICT (company_id, id) DO UPDATE SET data = $5, employee_id = $2, year = $3, month = $4, updated_at = NOW()",
        [allocId, Number(employeeId), Number(year), Number(month), alloc, companyId]
      );
      await client.query("COMMIT");
      res.json({ ok: true, allocation: alloc });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/pms/allocations/:id/delete", async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requirePage(req, res, "pms-allocation")) return;
  try {
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    if (req.auth.role !== "admin") return res.status(403).json({ ok: false, message: "확정된 투입률은 관리자만 삭제할 수 있습니다." });
    if (USE_JSON_FILE) {
      const alloc = _filePms.allocations.find(a => a.id === id);
      if (!alloc) return res.status(404).json({ ok: false, message: "배정 내역을 찾을 수 없습니다." });
      _filePms.allocations = _filePms.allocations.filter(a => a.id !== id);
      _saveFilePms();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT data FROM pms_allocations WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "배정 내역을 찾을 수 없습니다." });
    await pool.query("UPDATE pms_allocations SET is_deleted = TRUE WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// 직원별 일일 업무 투입(분단위 타임라인) — 본인 또는 admin만 등록 가능, 하루 24시간/겹침 검증
function _worklogBlocksValid(blocks) {
  if (!Array.isArray(blocks)) return "blocks 형식이 올바르지 않습니다.";
  // Number("abc") || 0 이면 "abc:00"가 00:00으로 조용히 바뀌고 25:00도
  // 통과한다. 업무일지는 집계·중복판정의 근거이므로 시각은 엄격한 HH:mm만 허용한다.
  const toMin = (t) => {
    const m = /^(\d{2}):(\d{2})$/.exec(String(t || ""));
    if (!m) return NaN;
    const hour = Number(m[1]), minute = Number(m[2]);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : NaN;
  };
  const sorted = [...blocks].sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    const s = toMin(b.startTime), e = toMin(b.endTime);
    if (!b.projectId || !b.task || isNaN(s) || isNaN(e) || e <= s) return "프로젝트, 업무명과 시작·종료 시간을 확인하세요.";
    if (i > 0 && s < toMin(sorted[i - 1].endTime)) return "업무 시간이 중복됩니다.";
    total += (e - s);
  }
  if (total > 1440) return "하루 합계가 24시간을 초과합니다.";
  return null;
}

app.get("/api/pms/worklogs", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    let { employeeId, date, year, month } = req.query;
    // "팀 전체" 보기(_pmsWorklogViewTabs)는 admin/leader/director에게만 노출되는데, 이
    // API는 requireAuth만 있어 member가 employeeId 쿼리를 생략하거나 타인 id를 넣으면
    // 전 직원의 업무일지가 그대로 조회됐다(실측 확인). member는 본인 employeeId로 강제한다.
    if (role === "member") employeeId = String(userId);
    if (USE_JSON_FILE) {
      let list = _filePms.worklogs;
      if (employeeId) list = list.filter(w => String(w.employeeId) === String(employeeId));
      if (date) list = list.filter(w => w.date === date);
      if (year) list = list.filter(w => w.date && w.date.slice(0, 4) === String(year));
      if (month) list = list.filter(w => w.date && Number(w.date.slice(5, 7)) === Number(month));
      return res.json({ ok: true, worklogs: list });
    }
    const conditions = ["is_deleted = FALSE", "(company_id = $1 OR company_id IS NULL)"];
    const params = [companyId];
    if (employeeId) { params.push(Number(employeeId)); conditions.push(`employee_id = $${params.length}`); }
    if (date) { params.push(date); conditions.push(`work_date = $${params.length}`); }
    if (year) { params.push(String(year)); conditions.push(`EXTRACT(YEAR FROM work_date)::text = $${params.length}`); }
    if (month) { params.push(Number(month)); conditions.push(`EXTRACT(MONTH FROM work_date) = $${params.length}`); }
    const { rows } = await pool.query(`SELECT data FROM pms_worklogs WHERE ${conditions.join(" AND ")} ORDER BY work_date`, params);
    res.json({ ok: true, worklogs: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/pms/worklogs", async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requirePage(req, res, "pms-worklog")) return;
  try {
    const { employeeId, date, blocks, expectedUpdatedAt } = req.body || {};
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    if (!employeeId || !date) return res.status(400).json({ ok: false, message: "직원, 날짜는 필수입니다." });
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    const workDate = dateMatch && new Date(Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3])));
    if (!workDate || workDate.getUTCFullYear() !== Number(dateMatch[1]) || workDate.getUTCMonth() !== Number(dateMatch[2]) - 1 || workDate.getUTCDate() !== Number(dateMatch[3])) {
      return res.status(400).json({ ok: false, message: "업무일자는 YYYY-MM-DD 형식의 실제 날짜여야 합니다." });
    }
    if (role !== "admin" && String(employeeId) !== String(userId)) return res.status(403).json({ ok: false, message: "본인 업무 기록만 등록할 수 있습니다." });
    const err = _worklogBlocksValid(blocks || []);
    if (err) return res.status(400).json({ ok: false, message: err });
    for (const b of (blocks || [])) {
      const project = await _pmsProjectById(b.projectId, companyId);
      if (!project) return res.status(404).json({ ok: false, message: "프로젝트를 찾을 수 없습니다." });
      if (project.status !== "active") return res.status(409).json({ ok: false, message: "종료된 프로젝트에는 업무 기록을 등록할 수 없습니다." });
      if (role !== "admin" && !(project.members || []).map(String).includes(String(employeeId))) {
          return res.status(403).json({ ok: false, message: "투입 인원으로 등록된 프로젝트만 선택할 수 있습니다." });
      }
    }
    const id = `wl_${employeeId}_${date}`;
    const record = { id, employeeId: String(employeeId), date, blocks, updatedAt: new Date().toISOString() };
    // 이 레코드는 하루치 blocks 배열 전체를 매번 통째로 재전송하는 구조라(항목별 id가
    // 없음), 같은 사용자가 두 탭을 열어두고 서로 다른 블록을 거의 동시에 추가하면
    // 뒤에 끝난 요청이 앞선 요청이 방금 추가한 블록을 그대로 덮어써 조용히 사라진다
    // (실측: 09:00 블록 저장 직후 11:00 블록을 동시 저장 → 09:00 블록 소멸). 여러
    // 사용자가 함께 쓰는 레코드가 아니라 락으로 순서를 정해도(먼저 쓴 요청의 결과를
    // 나중 요청이 모른 채 자기 스냅샷으로 그대로 이어쓰므로) 근본 해결이 안 된다 —
    // 클라이언트가 조회 시점의 updatedAt을 함께 보내면, 그 사이 다른 저장이 먼저
    // 끼어들었는지 서버가 판별해 충돌 시 명시적으로 거부(침묵 유실 대신 사용자가
    // 새로고침 후 재시도하도록)한다. expectedUpdatedAt을 안 보내는 구버전 클라이언트는
    // 기존처럼 무조건 덮어쓴다(하위호환).
    if (USE_JSON_FILE) {
      const idx = _filePms.worklogs.findIndex(w => w.id === id);
      const existing = idx >= 0 ? _filePms.worklogs[idx] : null;
      if (expectedUpdatedAt !== undefined) {
        const currentTs = existing ? existing.updatedAt : null;
        if ((currentTs || null) !== (expectedUpdatedAt || null)) {
          return res.status(409).json({ ok: false, message: "다른 저장으로 데이터가 변경되었습니다. 새로고침 후 다시 시도해주세요.", conflict: true, worklog: existing });
        }
      }
      if (idx >= 0) _filePms.worklogs[idx] = record; else _filePms.worklogs.push(record);
      _saveFilePms();
      return res.json({ ok: true, worklog: record });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // "SELECT ... FOR UPDATE"만으로는 부족하다 — 이 레코드가 아직 한 번도 저장된 적이
      // 없으면(가장 흔한 최초 저장 경합) 잠글 행 자체가 없어 두 트랜잭션 모두 existing=null을
      // 보고 그대로 통과해버린다(실측: 동시 최초저장 2건이 expectedUpdatedAt(둘 다 null)
      // 검사를 둘 다 통과해 하나가 침묵 유실). PMS 투입률 캡과 동일한 패턴으로 이 id
      // 자체에 advisory lock을 걸어 "행이 존재하든 안 하든" 같은 id를 다루는 요청을
      // 확실히 순번대로 세운다.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`wl:${companyId || ""}:${id}`]);
      const { rows } = await client.query(
        "SELECT data FROM pms_worklogs WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL) FOR UPDATE",
        [id, companyId]
      );
      const existing = rows.length ? rows[0].data : null;
      if (expectedUpdatedAt !== undefined) {
        const currentTs = existing ? existing.updatedAt : null;
        if ((currentTs || null) !== (expectedUpdatedAt || null)) {
          await client.query("ROLLBACK");
          return res.status(409).json({ ok: false, message: "다른 저장으로 데이터가 변경되었습니다. 새로고침 후 다시 시도해주세요.", conflict: true, worklog: existing });
        }
      }
      await client.query(
        "INSERT INTO pms_worklogs (id, employee_id, work_date, data, company_id) VALUES ($1,$2,$3,$4,$5) " +
        "ON CONFLICT (id) DO UPDATE SET data = $4, updated_at = NOW()",
        [id, Number(employeeId), date, record, companyId]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true, worklog: record });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 채용 관리: 채용공고 ────────────────────────────────────────────────────────
// company_id: 이 채용 모듈 helper들은 서로를 호출하며 얽혀 있어(job→emp→candidate→interview),
// 아래에서 회사 범위를 빠짐없이 관통시키지 않으면 부서 스코프 검사(_recruitCanViewJob 등)
// 이전에 다른 회사 데이터 자체가 조회돼버릴 수 있다 — companyId를 모든 helper의 첫/마지막
// 인자로 일관되게 추가한다.
// cache: _pgLockedUpdate의 트랜잭션 안에서는 절대 새 pool 커넥션을 요청하면 안 된다.
// 락을 잡은 요청이 이미 풀 클라이언트 1개를 점유한 채로 mutate 콜백 안에서 또 pool.query를
// 부르면, 같은 행에 요청이 몰릴 때 풀(max 20)이 전부 트랜잭션에 묶이고 그 안의 중첩 쿼리가
// 남은 커넥션을 영원히 기다려 자기교착에 빠진다(실측: 같은 면접에 동시 평가 40건 → 20건이
// "timeout exceeded when trying to connect"로 실패, 그동안 채용과 무관한 다른 요청까지 4.8초
// 지연). 풀은 프로세스 전역 공유라 피해가 이 모듈 밖으로 번진다. 2026-08-05에 budget.js에서
// 고친 "락 안에서 getTeamDept() 호출" 데드락과 같은 클래스다.
// 해법도 같다 — 필요한 조회를 락 진입 "전"에 끝내 cache에 담고, 락 안에서는 그 cache만 본다.
async function _recruitBuildCache(companyId, need = {}) {
  const cache = { companyId };
  const tasks = [];
  if (need.employees) tasks.push(_recruitAllEmployees(companyId).then(v => { cache.employees = v; }));
  if (need.jobs) tasks.push(_recruitAllJobs(companyId).then(v => { cache.jobs = v; }));
  if (need.interviews) tasks.push(_recruitAllInterviews(companyId).then(v => { cache.interviews = v; }));
  if (need.candidates) tasks.push(_recruitAllCandidates(companyId).then(v => { cache.candidates = v; }));
  await Promise.all(tasks);
  return cache;
}
async function _recruitAllEmployees(companyId, cache) {
  if (cache && cache.employees) return cache.employees;
  if (USE_JSON_FILE) return _fileStore.employees || [];
  const { rows } = await pool.query(
    "SELECT data FROM employees WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL)", [companyId || null]
  );
  return rows.map(r => r.data);
}
async function _recruitEmpById(empId, companyId, cache) {
  const emps = await _recruitAllEmployees(companyId, cache);
  return emps.find(e => String(e.id) === String(empId)) || null;
}
// 채용공고 열람 권한: 관리자, 등록자, 해당 부서 팀장/사업부장, 인사팀장, 관리자가 지정한 담당자
async function _recruitCanViewJob(job, userId, role, companyId, cache) {
  if (!job) return false;
  if (role === "admin") return true;
  if (String(job.createdBy) === String(userId)) return true;
  if (Array.isArray(job.viewerIds) && job.viewerIds.map(String).includes(String(userId))) return true;
  const emp = await _recruitEmpById(userId, companyId, cache);
  if (!emp) return false;
  if (emp.role === "director" && emp.dept === job.department) return true;
  if (emp.role === "leader" && emp.dept === job.department && (!job.team || emp.team === job.team)) return true;
  if (emp.role === "leader" && String(emp.dept || "").includes("인사")) return true;
  return false;
}
app.get("/api/recruit/jobs", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    let jobs;
    if (USE_JSON_FILE) {
      jobs = _fileRecruit.jobs;
    } else {
      const { rows } = await pool.query("SELECT id, data FROM recruit_jobs WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL) ORDER BY created_at DESC", [companyId]);
      jobs = rows.map(r => ({ id: r.id, ...r.data }));
    }
    if (userId && role && role !== "admin") {
      const filtered = [];
      for (const job of jobs) { if (await _recruitCanViewJob(job, userId, role, companyId)) filtered.push(job); }
      jobs = filtered;
    }
    res.json({ ok: true, jobs });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/recruit/jobs", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-jobs")) return;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    const { id, title, department, team, headcount, stages, status, description, purpose, responsibilities, requiredYears, docFile, viewerIds, user: createdBy, userId: createdById } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, message: "채용공고 제목은 필수입니다." });
    if (headcount != null && headcount !== "") {
      const hc = Number(headcount);
      if (!Number.isInteger(hc) || hc < 0 || hc > 9999) {
        return res.status(400).json({ ok: false, message: "채용 인원은 0 이상의 정수여야 합니다." });
      }
    }
    const jobId = id || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const defaultStages = ["서류전형", "1차면접", "2차면접", "최종합격"];
    // 이 라우트는 생성/수정을 겸하는데, 이전에는 department/team/headcount/status를 요청에
    // 안 실어보내면(예: 부분 수정 폼) 무조건 기본값으로 덮어써서 기존 값이 조용히 날아갔다
    // (실측: team "영업1팀"→"", headcount 2→1) — requiredYears/docFile/viewerIds/stages와
    // 동일하게 "값이 안 왔으면 기존 값 유지" 패턴으로 통일한다.
    const buildJob = (existing) => ({
      id: jobId, title,
      department: department != null ? department : (existing ? existing.department : ""),
      team: team != null ? team : (existing ? existing.team : ""),
      headcount: headcount != null && headcount !== "" ? (Number(headcount) || 1) : (existing ? existing.headcount : 1),
      stages: Array.isArray(stages) && stages.length ? stages : (existing ? existing.stages : defaultStages),
      status: status != null ? status : (existing ? existing.status : "open"),
      description: description || "", purpose: purpose || "", responsibilities: responsibilities || "",
      requiredYears: requiredYears != null && requiredYears !== "" ? Number(requiredYears) : (existing ? existing.requiredYears : null),
      docFile: docFile && docFile.fileName ? { fileName: docFile.fileName, type: docFile.type || "", data: docFile.data || "" } : (existing ? existing.docFile : null),
      viewerIds: Array.isArray(viewerIds) ? viewerIds.map(String) : (existing ? existing.viewerIds : []),
      createdBy: existing ? existing.createdBy : (createdBy || createdById || "unknown"),
      createdAt: existing ? existing.createdAt : now, updatedAt: now,
    });
    if (USE_JSON_FILE) {
      const existing = _fileRecruit.jobs.find(j => j.id === jobId);
      // GET /api/recruit/jobs는 이미 _recruitCanViewJob으로 부서 스코프를 걸고 있는데,
      // 같은 리소스를 수정하는 이 라우트는 role만 확인하고 그 검사가 없어 무관 부서
      // 리더/디렉터도 다른 부서 공고를 수정할 수 있었다(실측 확인). 신규 생성(existing
      // 없음)은 스코프 검사 대상이 아니므로 기존 공고를 수정하는 경우에만 적용한다.
      if (existing && !(await _recruitCanViewJob(existing, userId, role, companyId))) {
        return res.status(403).json({ ok: false, message: "수정 권한이 없습니다." });
      }
      const job = buildJob(existing);
      const idx = _fileRecruit.jobs.findIndex(j => j.id === jobId);
      if (idx >= 0) _fileRecruit.jobs[idx] = job; else _fileRecruit.jobs.push(job);
      _saveFileRecruit();
      return res.json({ ok: true, job });
    }
    const { rows } = await pool.query("SELECT data FROM recruit_jobs WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [jobId, companyId]);
    const existing = rows[0] ? rows[0].data : null;
    if (existing && !(await _recruitCanViewJob(existing, userId, role, companyId))) {
      return res.status(403).json({ ok: false, message: "수정 권한이 없습니다." });
    }
    const job = buildJob(existing);
    await pool.query(
      "INSERT INTO recruit_jobs (id, company_id, data) VALUES ($1,$2,$3) ON CONFLICT (company_id, id) DO UPDATE SET data = $3, updated_at = NOW()",
      [jobId, companyId, job]
    );
    res.json({ ok: true, job });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/recruit/jobs/:id/close", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-jobs")) return;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    const id = req.params.id;
    if (USE_JSON_FILE) {
      const job = _fileRecruit.jobs.find(j => j.id === id);
      if (!job) return res.status(404).json({ ok: false, message: "채용공고를 찾을 수 없습니다." });
      if (!(await _recruitCanViewJob(job, userId, role, companyId))) return res.status(403).json({ ok: false, message: "마감 권한이 없습니다." });
      job.status = "closed";
      job.updatedAt = new Date().toISOString();
      _saveFileRecruit();
      return res.json({ ok: true, job });
    }
    const { rows } = await pool.query("SELECT data FROM recruit_jobs WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "채용공고를 찾을 수 없습니다." });
    if (!(await _recruitCanViewJob(rows[0].data, userId, role, companyId))) return res.status(403).json({ ok: false, message: "마감 권한이 없습니다." });
    const job = { ...rows[0].data, status: "closed", updatedAt: new Date().toISOString() };
    // recruit_jobs의 PK는 (company_id, id) 복합키라 서로 다른 회사가 같은 id 문자열을
    // 각자 가질 수 있다(클라이언트가 job 생성 시 id를 직접 지정할 수 있어 실제로 재현됨) —
    // 이 UPDATE가 company_id 없이 id만으로 걸리면 우연히(또는 의도적으로) 같은 id를 가진
    // 다른 회사의 채용공고까지 함께 덮어써버린다(실측: 공고 close 한 번으로 다른 회사의
    // 공고 제목·부서·상태가 이 회사 값으로 전부 뒤바뀜). SELECT와 동일하게 company_id로 스코프.
    await pool.query("UPDATE recruit_jobs SET data = $3, updated_at = NOW() WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, companyId, job]);
    res.json({ ok: true, job });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

async function _recruitAllJobs(companyId) {
  if (USE_JSON_FILE) return _fileRecruit.jobs;
  const { rows } = await pool.query(
    "SELECT id, data FROM recruit_jobs WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL)", [companyId || null]
  );
  return rows.map(r => ({ id: r.id, ...r.data }));
}
async function _recruitJobById(jobId, companyId, cache) {
  if (cache && cache.jobs) return cache.jobs.find(j => String(j.id) === String(jobId)) || null;
  if (USE_JSON_FILE) return _fileRecruit.jobs.find(j => j.id === jobId) || null;
  const { rows } = await pool.query(
    "SELECT data FROM recruit_jobs WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL)", [jobId, companyId || null]
  );
  return rows[0] ? rows[0].data : null;
}

// ── 채용 관리: 지원자(이력서/평가) ──────────────────────────────────────────────
async function _recruitAllCandidates(companyId) {
  if (USE_JSON_FILE) return _fileRecruit.candidates;
  const { rows } = await pool.query(
    "SELECT data FROM recruit_candidates WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL) ORDER BY created_at DESC", [companyId || null]
  );
  return rows.map(r => r.data);
}
function _recruitStripResume(c) { return { ...c, resume: c.resume ? { fileName: c.resume.fileName, type: c.resume.type } : null }; }
async function _recruitVisibleCandidates(userId, role, companyId) {
  const all = await _recruitAllCandidates(companyId);
  if (!userId || !role || role === "admin") return all;
  const interviews = await _recruitAllInterviews(companyId);
  const interviewerCandidateIds = new Set(
    interviews.filter(iv => (iv.interviewerIds || []).map(String).includes(String(userId))).map(iv => String(iv.candidateId))
  );
  const visible = [];
  for (const c of all) {
    if (interviewerCandidateIds.has(String(c.id))) { visible.push(c); continue; }
    const job = await _recruitJobById(c.jobId, companyId);
    if (job && await _recruitCanViewJob(job, userId, role, companyId)) visible.push(c);
  }
  return visible;
}
app.get("/api/recruit/candidates", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { status, jobId, q } = req.query;
    const { role, empId: userId } = req.auth;
    let list = await _recruitVisibleCandidates(userId, role, req.auth.companyId || null);
    if (status) list = list.filter(c => c.status === status);
    if (jobId) list = list.filter(c => String(c.jobId) === String(jobId));
    if (q) {
      const needle = String(q).toLowerCase();
      list = list.filter(c => [c.name, c.email, c.phone].some(v => String(v || "").toLowerCase().includes(needle)));
    }
    res.json({ ok: true, candidates: list.map(_recruitStripResume) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.get("/api/recruit/candidates/export", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { jobId } = req.query;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    let list = await _recruitVisibleCandidates(userId, role, companyId);
    if (jobId) list = list.filter(c => String(c.jobId) === String(jobId));
    const jobTitleOf = async (id) => { const j = await _recruitJobById(id, companyId); return j ? j.title : ""; };
    const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const header = ["채용공고", "지원자명", "연락처", "이메일", "전형단계", "지원일", "최종학력", "경력사항", "마지막연봉", "희망연봉", "학력·경력 공백", "교육/대외활동", "이력서 요약", "메모"];
    const lines = [header.map(esc).join(",")];
    for (const c of list) {
      lines.push([await jobTitleOf(c.jobId), c.name, c.phone || "", c.email || "", c.status, (c.appliedAt || "").slice(0, 10), c.finalEducation || "", c.careerHistory || "", c.lastSalary || "", c.desiredSalary || "", c.careerGaps || "", c.activities || "", c.resumeSummary || "", c.memo || ""].map(esc).join(","));
    }
    res.json({ ok: true, csv: "﻿" + lines.join("\n") });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// 리스트 조회(_recruitVisibleCandidates)와 동일한 열람 권한 규칙을 단건 조회에도 적용한다.
// (과거엔 목록 API만 부서별 열람 제한이 걸려 있었고, id로 직접 조회하는 이 엔드포인트에는
// 아무 권한 검사가 없어 지원자 ID만 알면 타 부서 지원자 정보까지 그대로 열람 가능했음)
async function _recruitCanViewCandidate(candidate, userId, role, companyId, cache) {
  if (!candidate) return false;
  if (!userId || !role || role === "admin") return true;
  const interviews = await _recruitAllInterviews(companyId, cache);
  const isInterviewer = interviews.some(iv => String(iv.candidateId) === String(candidate.id) && (iv.interviewerIds || []).map(String).includes(String(userId)));
  if (isInterviewer) return true;
  const job = await _recruitJobById(candidate.jobId, companyId, cache);
  return job ? await _recruitCanViewJob(job, userId, role, companyId, cache) : false;
}
app.get("/api/recruit/candidates/:id", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const id = req.params.id;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    let candidate;
    if (USE_JSON_FILE) {
      candidate = _fileRecruit.candidates.find(c => c.id === id);
    } else {
      const { rows } = await pool.query("SELECT data FROM recruit_candidates WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
      candidate = rows[0] ? rows[0].data : null;
    }
    if (!candidate) return res.status(404).json({ ok: false, message: "지원자를 찾을 수 없습니다." });
    if (!(await _recruitCanViewCandidate(candidate, userId, role, companyId))) return res.status(403).json({ ok: false, message: "열람 권한이 없습니다." });
    const job = await _recruitJobById(candidate.jobId, companyId);
    res.json({ ok: true, candidate, job });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

function _execFileP(cmd, args) {
  const { execFile } = require("child_process");
  return new Promise((resolve, reject) => {
    // OMP_THREAD_LIMIT=1: tesseract가 프로세스당 다수 스레드를 만들면 여러 페이지
    // 동시 처리 시 CPU 경합으로 사실상 멈추는 문제 방지 (제한된 컨테이너 환경)
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 20, timeout: 60000, env: { ...process.env, OMP_THREAD_LIMIT: "1" } }, (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}
async function _ocrPdfBuffer(buffer) {
  const execFileP = _execFileP;
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "resume-ocr-"));
  const pdfPath = path.join(tmpDir, "in.pdf");
  const pagePrefix = path.join(tmpDir, "page");
  try {
    await fs.promises.writeFile(pdfPath, buffer);
    // 4페이지 → 2페이지로 제한(해상도는 200dpi 유지) — Render Free 플랜(0.1 CPU)에서
    // 8페이지는 실측 60초 이상 걸려 클라이언트/플랫폼 타임아웃으로 응답 자체가
    // 유실된다(2026-07-22 Docker 런타임 전환 후 실측 확인). 처음엔 dpi를 150으로
    // 낮춰봤으나 속도 개선은 미미한 반면(페이지 수가 진짜 원인) 이메일 등 작은
    // 글자의 OCR 정확도가 떨어져(예: "artvita@naver.com"이 "artvita@na"로 잘림)
    // 200dpi 그대로 두고 페이지 수만 줄이는 쪽으로 확정했다(실측 4~5초로 충분히 빠름).
    await execFileP("pdftoppm", ["-png", "-r", "200", "-l", "2", pdfPath, pagePrefix]);
    const files = (await fs.promises.readdir(tmpDir)).filter(f => f.startsWith("page") && f.endsWith(".png")).sort();
    const texts = [];
    for (const f of files) texts.push(await execFileP("tesseract", [path.join(tmpDir, f), "stdout", "-l", "kor+eng"]));
    return texts.join("\n");
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
async function _ocrPdfPages(buffer, lastPage) {
  // 마스킹된 인쇄용 PDF 보강 OCR — 연락처·회사명이 이미지로만 렌더링된 경우 사용.
  // 페이지 수/해상도 선택 이유는 위 _ocrPdfBuffer 주석 참고 — 200dpi 유지, 호출부에서
  // lastPage를 2로 줄여 Render Free 플랜(0.1 CPU)에서도 타임아웃 없이 완료되게 한다.
  const execFileP = _execFileP;
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "resume-ocr1-"));
  const pdfPath = path.join(tmpDir, "in.pdf");
  const pagePrefix = path.join(tmpDir, "page");
  try {
    await fs.promises.writeFile(pdfPath, buffer);
    await execFileP("pdftoppm", ["-png", "-r", "200", "-f", "1", "-l", String(lastPage || 1), pdfPath, pagePrefix]);
    const files = (await fs.promises.readdir(tmpDir)).filter(f => f.startsWith("page") && f.endsWith(".png")).sort();
    if (!files.length) return "";
    const texts = [];
    for (const f of files) texts.push(await execFileP("tesseract", [path.join(tmpDir, f), "stdout", "-l", "kor+eng"]));
    return texts.join("\n");
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
app.post("/api/recruit/extract-pdf-text", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-candidates")) return;
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== "string") return res.status(400).json({ ok: false, message: "파일 데이터가 없습니다." });
    const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
    const buffer = Buffer.from(base64, "base64");
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    let text = result.text || "";
    if (text.replace(/--\s*\d+\s*of\s*\d+\s*--/g, "").trim().length < 20) {
      try {
        text = await _ocrPdfBuffer(buffer);
      } catch (ocrErr) {
        return res.json({ ok: true, text: "", ocrFailed: true, message: "스캔된 PDF로 보이며 OCR 처리에 실패했습니다(서버에 poppler-utils/tesseract-ocr 필요): " + ocrErr.message });
      }
    } else {
      // 텍스트 레이어는 있지만 연락처(휴대폰/이메일)가 없는 경우 — 잡코리아 등
      // 채용 사이트 인쇄용 PDF는 개인정보(연락처)와 회사명을 이미지로만 렌더링하므로
      // 텍스트 추출로는 절대 나오지 않는다. 이때 앞 2페이지를 OCR해 보강 섹션으로 첨부한다
      // (프론트엔드 파서는 이 섹션에서 연락처를 찾고, 회사명이 빈 경력 항목을 채운다).
      // 연락처는 사실상 항상 1페이지에 있어 2페이지로도 충분하고, 4페이지는 Render
      // Free 플랜(0.1 CPU)에서 타임아웃으로 응답이 통째로 유실되는 위험이 더 컸다
      // (아래 _ocrPdfPages 주석 참고).
      const hasPhone = /01[0-9][-.\s]{0,2}\d{3,4}[-.\s]{0,2}\d{4}/.test(text);
      const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text);
      if (!hasPhone || !hasEmail) {
        try {
          const ocrText = await _ocrPdfPages(buffer, 2);
          if (ocrText && ocrText.trim()) text += "\n\n[OCR 보강 텍스트]\n" + ocrText;
        } catch (e) { /* OCR 도구 미설치 등 — 텍스트 추출 결과만 반환 */ }
      }
    }
    res.json({ ok: true, text });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});
app.post("/api/recruit/extract-docx-text", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-candidates")) return;
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== "string") return res.status(400).json({ ok: false, message: "파일 데이터가 없습니다." });
    const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
    const buffer = Buffer.from(base64, "base64");
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    res.json({ ok: true, text: result.value || "" });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});
async function _extractHwpBuffer(buffer) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "resume-hwp-"));
  const hwpPath = path.join(tmpDir, "in.hwp");
  const outDir = path.join(tmpDir, "out");
  try {
    await fs.promises.writeFile(hwpPath, buffer);
    await _execFileP("hwp5html", ["--output", outDir, hwpPath]);
    const html = await fs.promises.readFile(path.join(outDir, "index.xhtml"), "utf8");
    const text = html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&#13;/g, "\n")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
    return text;
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
app.post("/api/recruit/extract-hwp-text", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-candidates")) return;
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== "string") return res.status(400).json({ ok: false, message: "파일 데이터가 없습니다." });
    const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
    const buffer = Buffer.from(base64, "base64");
    let text = "";
    try {
      text = await _extractHwpBuffer(buffer);
    } catch (hwpErr) {
      return res.json({ ok: true, text: "", message: "HWP 파일에서 텍스트를 추출하지 못했습니다(서버에 pyhwp 필요): " + hwpErr.message });
    }
    res.json({ ok: true, text });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});
async function _ocrImageBuffer(buffer, ext) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "resume-img-"));
  const imgPath = path.join(tmpDir, "in." + (ext || "png"));
  try {
    await fs.promises.writeFile(imgPath, buffer);
    return await _execFileP("tesseract", [imgPath, "stdout", "-l", "kor+eng"]);
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
app.post("/api/recruit/extract-image-text", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-candidates")) return;
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== "string") return res.status(400).json({ ok: false, message: "파일 데이터가 없습니다." });
    const mimeM = dataUrl.match(/^data:image\/(\w+);base64,/);
    const ext = mimeM ? mimeM[1].replace("jpeg", "jpg") : "png";
    const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
    const buffer = Buffer.from(base64, "base64");
    let text = "";
    try {
      text = await _ocrImageBuffer(buffer, ext);
    } catch (ocrErr) {
      return res.json({ ok: true, text: "", message: "이미지에서 텍스트를 추출하지 못했습니다(서버에 tesseract-ocr 필요): " + ocrErr.message });
    }
    res.json({ ok: true, text });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

const RESUME_FIELDS_SCHEMA_PROMPT = `너는 한국어 이력서 텍스트에서 정보를 추출하는 도우미다. 아래 텍스트(OCR/문서 추출 결과라 줄바꿈이 깨지거나 표가 뒤섞여 있을 수 있음)를 읽고, 다음 JSON 스키마로만 응답해라. 마크다운이나 설명 없이 JSON 객체 하나만 출력해라. 모르거나 이력서에 없는 값은 빈 문자열 ""로 둔다.
{
  "name": "지원자 이름",
  "email": "이메일",
  "phone": "전화번호",
  "finalEducation": "최종학력 (학교명 / 전공 / 졸업년도 / 학점 형식으로, 가장 높은 학위 기준)",
  "careerHistory": "경력사항. 이력서에 나온 회사마다 한 줄씩, 반드시 다음 형식으로: 'N. 재직기간 | 회사명 | 직급 | 주요업무'. 재직기간은 'YYYY.MM~YYYY.MM' 또는 'YYYY.MM~현재' 형식. 직급이 없으면 빈칸으로 두되 구분자 |는 유지. 주요업무가 없으면 '업무내용 미기재'. 학력/병역/자격증/어학 등 경력과 무관한 내용은 절대 포함하지 말 것. 회사가 여러 개면 줄바꿈으로 구분하고, 재직기간이 가장 최근(현재 재직중 또는 종료일이 늦은 순)인 회사부터 먼저 나열하고 오래된 회사를 마지막에 나열할 것(최근순). 회사명 칸에는 지원자가 실제로 재직/소속되어 급여를 받은 회사만 적을 것 — 프리랜서·SI 경력에서 주요업무 문장에 자주 등장하는 '~프로젝트 수행', '~시스템 구축' 등의 대상 기업(발주처/고객사)은 재직 회사가 아니니 절대 회사명 칸에 넣지 말 것. 재직 회사명을 원문에서 확실히 찾을 수 없으면 그 항목의 회사명 칸은 빈 문자열로 남길 것(발주처명으로 채우지 말 것)",
  "lastSalary": "마지막(최근/현재) 연봉. 없으면 빈 문자열",
  "desiredSalary": "희망연봉. 없으면 빈 문자열",
  "activities": "정규 경력 외 교육/연수/대외활동/프로젝트 등 요약",
  "careerGaps": "경력 사이에 3개월 이상 공백이 있으면 \\"YYYY.MM ~ YYYY.MM (n개월 공백)\\" 형식으로, 없으면 빈 문자열",
  "resumeSummary": "경력 사항이 아닌 자기소개서(성장과정/장단점/특이한 경험/지원동기/포부) 또는 자기소개 내용을 2~4문장으로 요약. 자기소개서가 없으면 전체 이력서를 간단히 요약",
  "notableInfo": "메모로 남길 만한 기타 특이사항(예: 장기 공백 사유, 해외 경험, 수상/특이 경력, 입사 가능 시기, 병역 특이사항 등). 없으면 빈 문자열"
}`;
async function _groqParseResume(text) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RESUME_FIELDS_SCHEMA_PROMPT },
        { role: "user", content: text.slice(0, 12000) },
      ],
    }),
  });
  if (!resp.ok) throw new Error("Groq API 오류 " + resp.status + ": " + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}
app.post("/api/recruit/parse-resume-llm", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-candidates")) return;
    const { text } = req.body || {};
    if (!text || typeof text !== "string" || text.trim().length < 20) {
      return res.json({ ok: false, message: "분석할 텍스트가 부족합니다." });
    }
    let fields;
    try {
      fields = await _groqParseResume(text);
    } catch (e) {
      return res.json({ ok: false, message: "AI 분석에 실패했습니다: " + e.message });
    }
    if (!fields) return res.json({ ok: false, message: "AI 분석 기능이 설정되지 않았습니다(GROQ_API_KEY 필요)." });
    res.json({ ok: true, fields });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── HR 신규 직원 등록: AI 이력서 자동입력(P1) ───────────────────────────────────
// 기존에는 public/index.html의 handleResumeFile()이 브라우저에서 직접
// https://api.anthropic.com/v1/messages를 인증 헤더 없이 호출하고 있어(브라우저에는
// API 키를 둘 방법이 없으므로 이 호출은 항상 인증 실패로 끝난다 — 신규 직원 등록의
// 이력서 자동입력 기능 자체가 애초부터 동작한 적이 없었다) 이 단일 multipart
// 엔드포인트로 대체한다. 위 채용(recruit) 모듈이 이미 갖춘 서버측 텍스트 추출
// (PDF 텍스트레이어+OCR/DOCX/이미지 OCR) 저수준 버퍼 헬퍼(_ocrPdfBuffer/
// _ocrPdfPages/_ocrImageBuffer, 위에서 정의됨)를 그대로 재사용하되, dataUrl(JSON
// body) 기반 기존 /api/recruit/extract-*-text·parse-resume-llm 라우트는 채용 흐름의
// 기존 계약을 그대로 유지하기 위해 전혀 건드리지 않는다(요구사항: "기존 채용 이력서
// 흐름은 깨지지 않게 유지").
const RESUME_MAX_BYTES = Number(process.env.RESUME_MAX_BYTES) || 15 * 1024 * 1024;
const RESUME_MAX_TEXT_CHARS = Number(process.env.RESUME_MAX_TEXT_CHARS) || 12000;
const RESUME_AI_TIMEOUT_MS = Number(process.env.RESUME_AI_TIMEOUT_MS) || 30000;
// DOCX(zip)는 multer의 fileSize 제한(원본 파일 크기)만으로는 압축 폭탄을 막지
// 못한다 — 15MB짜리 zip이 안에 수백 개 항목이나 수백 MB로 압축 해제되는 내용을
// 담을 수 있다. jszip은 loadAsync() 시점에는 각 항목을 실제로 해제(inflate)하지
// 않고 중앙 디렉터리 메타데이터(선언된 압축해제크기)만 읽으므로, 이 값을 실제
// 해제 전에 먼저 검사해 거부할 수 있다.
const RESUME_ZIP_MAX_ENTRIES = Number(process.env.RESUME_ZIP_MAX_ENTRIES) || 200;
const RESUME_ZIP_MAX_UNCOMPRESSED_BYTES = Number(process.env.RESUME_ZIP_MAX_UNCOMPRESSED_BYTES) || 30 * 1024 * 1024;
// 이미지도 마찬가지로 파일 바이트 자체는 작아도(png/webp는 고압축률) 디코드하면
// 거대한 픽셀 배열이 될 수 있어(압축 폭탄과 동일한 부류의 위험) tesseract에
// 넘기기 전에 헤더만 읽어(전체 디코드 없이) 픽셀 수를 먼저 확인한다.
const RESUME_IMAGE_MAX_PIXELS = Number(process.env.RESUME_IMAGE_MAX_PIXELS) || 40_000_000; // 40MP
// 이력서 분석은 OCR/AI 호출이 있어 요청 하나가 몇 초~수십 초씩 서버 리소스(CPU/
// 프로세스 슬롯)를 붙잡는다 — resumeParseLimiter(시간창 기준 총 호출 수)와 별개로,
// "지금 동시에 처리 중인 개수"도 제한해야 짧은 시간에 몰린 요청들이 서버를 과부하
// 상태로 몰아넣는 것을 막을 수 있다.
const RESUME_MAX_CONCURRENT = Number(process.env.RESUME_MAX_CONCURRENT) || 3;
let _resumeInFlight = 0;
const hrResumeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: RESUME_MAX_BYTES, files: 1, fields: 0 } });

// 사용자별 호출 한도(과다 AI 호출로 인한 비용/부하 남용 방지) — /login과 달리 IP가
// 아니라 로그인 계정 기준으로 센다(사무실 공인IP 뒤에서 여러 관리자가 동시에 써도
// 서로의 한도를 갉아먹지 않도록, 이 프로젝트의 기존 loginLimiter 설계 이유와 동일).
// 비로그인 요청(토큰이 없거나 무효)만 IP로 폴백하는데, express-rate-limit은 커스텀
// keyGenerator가 req.ip를 직접 문자열로 쓰면(IPv6 정규화 없이) 같은 /64 대역 안에서
// 주소를 바꿔가며 한도를 우회할 수 있다고 정적 소스 검사로 경고한다(ERR_ERL_KEY_GEN_IPV6,
// 실측: 실제로 요청은 막지 않고 매 기동 시 콘솔에 경고만 남기지만, 지적 자체는 타당하므로
// 라이브러리가 제공하는 rateLimit.ipKeyGenerator()로 정규화한다.
const resumeParseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.auth && req.auth.empId != null) ? `emp:${req.auth.empId}` : rateLimit.ipKeyGenerator(req.ip),
  handler: (req, res) => res.status(429).json({ ok: false, code: "RESUME_RATE_LIMITED", message: "이력서 분석 요청이 너무 많습니다. 잠시 후 다시 시도하세요." }),
});

// 확장자만이 아니라 실제 파일 시그니처(매직바이트)로 형식을 판정한다 — 확장자를
// 위장한 파일(예: 실행파일을 .pdf로 이름만 바꾼 경우)을 그대로 통과시키지 않기 위함.
function _sniffResumeFileType(buffer, filename) {
  const ext = (filename || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", ok: ext === "pdf" };
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return { kind: "image", mime: "png", ok: ext === "png" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { kind: "image", mime: "jpeg", ok: ext === "jpg" || ext === "jpeg" };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return { kind: "image", mime: "webp", ok: ext === "webp" };
  // DOCX(OOXML)는 ZIP 컨테이너 — 로컬 파일 헤더(PK\x03\x04) 또는 빈 아카이브(PK\x05\x06)
  // 시그니처로 판별한다(내부 word/document.xml 존재 여부까지는 확인하지 않음 — 실제
  // Word 문서가 아닌 zip을 올리면 뒤이은 mammoth 파싱 단계에서 RESUME_TEXT_UNREADABLE로
  // 자연스럽게 걸러진다).
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05) && (buffer[3] === 0x04 || buffer[3] === 0x06)) return { kind: "docx", ok: ext === "docx" };
  return { kind: null, ok: false };
}

// 헤더만 읽어 픽셀 크기를 판정한다(전체 디코드 없이) — 40MP 제한(RESUME_IMAGE_MAX_PIXELS)을
// 실제 디코드/OCR 전에 먼저 적용하기 위함. 셋 다 표준 파일 포맷 스펙을 그대로 따른
// 순수 JS 구현이라 별도 이미지 라이브러리(sharp 등) 의존성이 필요 없다.
function _pngDimensions(buf) {
  if (buf.length < 24 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
function _jpegDimensions(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; } // 마커 정렬이 어긋났으면 재동기화
    const marker = buf[offset + 1];
    // 페이로드가 없는 마커(SOI/RST0-7/TEM 등)는 길이 필드가 없으니 바로 다음으로.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
    if (offset + 4 > buf.length) return null;
    const segLen = buf.readUInt16BE(offset + 2);
    // SOF0~SOF15(DHT/JPG/DAC 제외) 마커에 높이/너비가 들어있다.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    if (marker === 0xda) return null; // Start-Of-Scan 이후엔 더 이상 헤더 세그먼트가 없음
    offset += 2 + segLen;
  }
  return null;
}
function _webpDimensions(buf) {
  if (buf.length < 30 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return null;
  const fourcc = buf.toString("latin1", 12, 16);
  if (fourcc === "VP8X") { // 확장 포맷: 24비트 리틀엔디언 (캔버스크기-1)
    return { width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1, height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
  }
  if (fourcc === "VP8 ") { // 손실(lossy): 14비트 값 2개(리틀엔디언), 상위 2비트는 스케일 플래그
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === "VP8L") { // 무손실: signature 0x2f 다음 4바이트에 (너비-1)/(높이-1)이 비트팩됨
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  return null;
}
function _getImageDimensions(buffer, mime) {
  if (mime === "png") return _pngDimensions(buffer);
  if (mime === "jpeg") return _jpegDimensions(buffer);
  if (mime === "webp") return _webpDimensions(buffer);
  return null;
}

// DOCX(OOXML)가 실제로 OOXML 구조([Content_Types].xml + word/document.xml)를
// 갖췄는지, 그리고 압축 해제 시 항목 수/총 크기가 정상 범위인지 확인한다 —
// 일반 zip(예: 안에 아무 텍스트 파일 하나만 넣고 확장자만 .docx로 바꾼 것)이나
// zip 폭탄이 magic-byte 검사(둘 다 PK 시그니처로 시작하므로)만으로는 걸러지지
// 않기 때문에 한 단계 더 깊이 검사한다. JSZip.loadAsync()는 중앙 디렉터리
// 메타데이터만 읽고 각 항목을 실제로 inflate하지 않으므로, 폭탄 판정 자체가
// 압축 해제로 인한 자원 소모 없이 이뤄진다.
async function _validateDocxZip(buffer) {
  const JSZip = require("jszip");
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (e) {
    const err = new Error("잘못된 ZIP/DOCX 구조"); err.code = "NOT_DOCX"; throw err;
  }
  const names = Object.keys(zip.files);
  if (names.length > RESUME_ZIP_MAX_ENTRIES) {
    const err = new Error("압축 파일 항목이 너무 많습니다"); err.code = "TOO_LARGE"; throw err;
  }
  let totalUncompressed = 0;
  for (const name of names) {
    totalUncompressed += (zip.files[name]._data && zip.files[name]._data.uncompressedSize) || 0;
    if (totalUncompressed > RESUME_ZIP_MAX_UNCOMPRESSED_BYTES) {
      const err = new Error("압축 해제 크기가 너무 큽니다"); err.code = "TOO_LARGE"; throw err;
    }
  }
  if (!names.includes("[Content_Types].xml") || !names.includes("word/document.xml")) {
    const err = new Error("DOCX 구조가 아닙니다"); err.code = "NOT_DOCX"; throw err;
  }
}

const HR_RESUME_FIELDS_SCHEMA_PROMPT = `너는 한국어 이력서 텍스트에서 정보를 추출하는 도우미다. 아래 텍스트(문서 추출/OCR 결과라 줄바꿈이 깨지거나 표가 뒤섞여 있을 수 있음)를 읽고, 다음 JSON 스키마로만 응답해라. 마크다운이나 설명 없이 JSON 객체 하나만 출력해라. 모르거나 이력서에 없는 값은 빈 문자열(배열은 빈 배열, 숫자는 null)로 둔다.
{
  "name": "이름",
  "birth": "생년월일 YYYY-MM-DD 형식, 모르면 빈 문자열",
  "gender": "남 또는 여, 모르면 빈 문자열",
  "totalCareer": 총 경력년수(소수 가능한 숫자, 모르면 null),
  "edu": "최종학력 — 반드시 다음 중 하나: 고등학교 졸업/전문대 졸업/대학교 졸업/대학원 석사/대학원 박사. 모르면 빈 문자열",
  "eduSchool": "최종학력 학교명 (졸업년도가 있으면 괄호로 병기)",
  "jobGroup": "직군 — 반드시 다음 중 하나: 관리직/영업직/개발직/연구직/생산직/서비스직/기타. 모르면 빈 문자열",
  "careers": [{"co":"회사명","start":"YYYY-MM","end":"YYYY-MM 또는 현재","pos":"직위","desc":"주요업무 한줄요약"}],
  "email": "이메일",
  "phone": "전화번호"
}`;
// 테스트 전용 오버라이드 — 실제 Groq 엔드포인트를 하드코딩하지 않고 이 상수 하나만
// 거치게 해, 자동화 테스트가 502(provider 실패)/504(timeout) 응답 매핑을 실제
// Groq API 키 없이도 로컬 mock 서버로 검증할 수 있게 한다(test/api/file-mode.test.js
// 참고). 프로덕션에서는 이 환경변수를 설정하지 않으므로 항상 실제 Groq 엔드포인트를
// 그대로 쓴다 — 채용 모듈(_groqParseResume 등)의 기존 Groq 호출은 이 오버라이드와
// 무관하게 손대지 않았다(기존 계약 유지).
const HR_RESUME_GROQ_URL = process.env.HR_RESUME_GROQ_URL_OVERRIDE || "https://api.groq.com/openai/v1/chat/completions";
// 채용 모듈의 _groqParseResume()과 스키마·용도가 다르므로(신규 직원 등록 폼 필드
// vs 채용 지원자 카드 필드) 별도 함수로 둔다 — provider 실패(502)/timeout(504)/
// 키 미설정(503)을 호출부가 구분할 수 있도록 e.code에 원인을 실어 던진다.
async function _hrResumeGroqParse(text) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) { const e = new Error("GROQ_API_KEY 미설정"); e.code = "NOT_CONFIGURED"; throw e; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESUME_AI_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(HR_RESUME_GROQ_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: HR_RESUME_FIELDS_SCHEMA_PROMPT },
          { role: "user", content: text.slice(0, RESUME_MAX_TEXT_CHARS) },
        ],
      }),
    });
  } catch (e) {
    if (e.name === "AbortError") { const te = new Error("AI 응답 시간 초과"); te.code = "TIMEOUT"; throw te; }
    const fe = new Error("AI 호출 실패: " + e.message); fe.code = "PROVIDER_FAILED"; throw fe;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) { const e = new Error("Groq API 오류 " + resp.status); e.code = "PROVIDER_FAILED"; throw e; }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(content); }
  catch (e) { const pe = new Error("AI 응답 파싱 실패"); pe.code = "PROVIDER_FAILED"; throw pe; }
}

// AI가 스키마를 어겨도(예: edu에 목록에 없는 값, birth에 자유형식 날짜) 그 값을 폼에
// 그대로 흘려보내면 <select>는 일치하는 옵션이 없어 조용히 빈 값/첫 옵션이 되고,
// <input type="date">는 잘못된 형식이면 빈 값이 된다 — 여기서 미리 화이트리스트/형식
// 검증을 거쳐, 스키마를 벗어난 값은 서버 단계에서 빈 문자열로 정규화한다.
const HR_EDU_VALUES = new Set(["고등학교 졸업", "전문대 졸업", "대학교 졸업", "대학원 석사", "대학원 박사"]);
const HR_JOBGROUP_VALUES = new Set(["관리직", "영업직", "개발직", "연구직", "생산직", "서비스직", "기타"]);
// AI가 "YYYY-MM-DD" 형식은 맞지만 실존하지 않는 날짜(2024-99-99, 2024-02-30 등)를
// 만들어낼 수 있어(모델이 형식만 흉내내고 실제 달력을 검증하지 않음) 정규식만으로는
// 못 거른다 — 자릿수/범위를 먼저 보고, 그다음 Date로 왕복 변환해 실제로 그 날짜가
// 존재하는지(예: 2월 30일이 3월 2일로 밀리지 않는지) 확인한다.
function _isValidCalendarDateStr(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
const HR_YEARMONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function _sanitizeHrResumeFields(raw) {
  const f = raw && typeof raw === "object" ? raw : {};
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const birth = str(f.birth);
  const gender = str(f.gender);
  const edu = str(f.edu);
  const jobGroup = str(f.jobGroup);
  const totalCareer = Number(f.totalCareer);
  const careers = Array.isArray(f.careers) ? f.careers.slice(0, 30).map(c => {
    const start = str(c && c.start).slice(0, 20);
    const end = str(c && c.end).slice(0, 20);
    return {
      co: str(c && c.co).slice(0, 200),
      // 형식이 맞아도(YYYY-MM) "2024-13"처럼 존재하지 않는 달은 정규식 자체가
      // 이미 01~12 범위로 제한하므로 별도 왕복검증이 필요 없다(연-월은 항상 1일로
      // 취급해 윤년/말일 이슈가 없음 — 연-월-일 조합인 birth와의 차이).
      start: HR_YEARMONTH_RE.test(start) ? start : "",
      end: (end === "현재" || HR_YEARMONTH_RE.test(end)) ? end : "",
      pos: str(c && c.pos).slice(0, 100), desc: str(c && c.desc).slice(0, 500),
    };
  }).filter(c => c.co || c.start || c.end || c.pos) : [];
  return {
    name: str(f.name).slice(0, 100),
    birth: _isValidCalendarDateStr(birth) ? birth : "",
    gender: gender === "남" || gender === "여" ? gender : "",
    // 총 경력년수는 사람의 실제 근로 가능 기간을 벗어날 수 없다 — AI가 이력서를
    // 잘못 읽어 -1(파싱 오류)이나 999(단위 착각 등) 같은 값을 내놓아도 그대로
    // 폼에 흘려보내면 눈에 띄지 않는 오염된 값으로 저장될 위험이 있어 범위를 둔다.
    totalCareer: (Number.isFinite(totalCareer) && totalCareer >= 0 && totalCareer <= 70) ? totalCareer : null,
    edu: HR_EDU_VALUES.has(edu) ? edu : "",
    eduSchool: str(f.eduSchool).slice(0, 200),
    jobGroup: HR_JOBGROUP_VALUES.has(jobGroup) ? jobGroup : "",
    careers,
    email: str(f.email).slice(0, 200),
    phone: str(f.phone).slice(0, 50),
  };
}

// execFile이 실행 파일 자체를 못 찾을 때(poppler-utils/tesseract-ocr 미설치)의 에러
// 코드는 항상 "ENOENT"다 — 이 경우와 "설치는 돼있지만 이 문서를 못 읽음"을 구분해,
// 전자는 "환경이 준비되지 않음"(503 RESUME_OCR_UNAVAILABLE), 후자는 "이 파일을 못
// 읽음"(422 RESUME_TEXT_UNREADABLE)으로 서로 다르게 응답한다.
function _isOcrToolMissing(e) { return !!(e && e.code === "ENOENT"); }

app.post("/api/hr/resume-parse",
  // 이력서(개인정보) 관련 응답은 성공·실패를 막론하고 중간 프록시·브라우저 캐시에
  // 남지 않도록 한다 — 체인의 다른 어느 단계에서 응답이 끝나든(권한 거부·rate limit·
  // 파일 오류·AI 오류·성공) 항상 적용되도록 가장 먼저 실행한다.
  (req, res, next) => { res.set("Cache-Control", "no-store"); next(); },
  resumeParseLimiter,
  // 권한 검사를 multer(파일 파싱)보다 먼저 실행한다 — 인가되지 않은 요청은 서버가
  // 대용량 multipart 본문을 메모리에 버퍼링하기 전에 즉시 거부된다(전역 authenticate
  // 미들웨어가 이미 req.auth를 채워둔 상태이므로 파일을 읽지 않고도 판단 가능).
  (req, res, next) => { if (!requireAdmin(req, res)) return; next(); },
  // 동시 처리 개수 제한 — multer가 파일을 버퍼링하기 전에 게이트해, 이미 정원이
  // 찬 상태에서는 대용량 본문을 굳이 메모리에 올리지 않는다. 브라우저 연결이 먼저
  // 끊겨도 OCR/AI 작업은 잠시 계속될 수 있으므로 close에서 바로 슬롯을 반납하면
  // 재시도로 동시 제한을 우회할 수 있다. 실제 작업 handler의 finally에서 반납한다.
  (req, res, next) => {
    if (_resumeInFlight >= RESUME_MAX_CONCURRENT) {
      return res.status(429).json({ ok: false, code: "RESUME_CONCURRENCY_LIMIT", message: "이력서 분석 요청이 동시에 너무 많습니다. 잠시 후 다시 시도하세요." });
    }
    _resumeInFlight++;
    let released = false;
    const release = () => { if (released) return; released = true; _resumeInFlight = Math.max(0, _resumeInFlight - 1); };
    res.on("finish", release);
    req._releaseResumeSlot = release;
    req._resumeTaskStarted = false;
    req.on("aborted", () => { if (!req._resumeTaskStarted) release(); });
    next();
  },
  (req, res, next) => {
    hrResumeUpload.single("file")(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ ok: false, code: "RESUME_FILE_TOO_LARGE", message: `이력서 파일은 ${Math.floor(RESUME_MAX_BYTES / (1024*1024))}MB 이하만 업로드할 수 있습니다.` });
      return res.status(400).json({ ok: false, code: "RESUME_FILE_INVALID", message: "이력서 파일을 처리할 수 없습니다." });
    });
  },
  async (req, res) => {
    req._resumeTaskStarted = true;
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ ok: false, code: "RESUME_FILE_REQUIRED", message: "파일을 선택해주세요." });
      const sniff = _sniffResumeFileType(file.buffer, file.originalname);
      if (!sniff.kind) return res.status(400).json({ ok: false, code: "RESUME_TYPE_UNSUPPORTED", message: "PDF, DOCX, PNG, JPG, WEBP 파일만 지원합니다." });
      if (!sniff.ok) return res.status(400).json({ ok: false, code: "RESUME_FILE_INVALID", message: "파일 내용이 확장자와 일치하지 않습니다." });

      let text = "";
      let extraction = "text";
      const warnings = [];
      if (sniff.kind === "pdf") {
        const { PDFParse } = require("pdf-parse");
        try {
          const parser = new PDFParse({ data: file.buffer });
          const result = await parser.getText();
          text = result.text || "";
        } catch (e) {
          return res.status(422).json({ ok: false, code: "RESUME_TEXT_UNREADABLE", message: "PDF에서 텍스트를 추출할 수 없습니다." });
        }
        if (text.replace(/--\s*\d+\s*of\s*\d+\s*--/g, "").trim().length < 20) {
          try {
            text = await _ocrPdfBuffer(file.buffer);
            extraction = "ocr";
          } catch (ocrErr) {
            if (_isOcrToolMissing(ocrErr)) return res.status(503).json({ ok: false, code: "RESUME_OCR_UNAVAILABLE", message: "OCR 기능을 사용할 수 없습니다(서버에 OCR 도구가 설치되지 않았습니다). 관리자에게 문의하세요." });
            return res.status(422).json({ ok: false, code: "RESUME_TEXT_UNREADABLE", message: "스캔된 PDF에서 텍스트를 추출하지 못했습니다." });
          }
        } else {
          const hasPhone = /01[0-9][-.\s]{0,2}\d{3,4}[-.\s]{0,2}\d{4}/.test(text);
          const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text);
          if (!hasPhone || !hasEmail) {
            // 연락처 보강용 OCR은 실패해도 이미 확보한 텍스트 레이어 결과가 있으니
            // 요청 전체를 실패시키지 않고 조용히 건너뛴다(핵심 정보는 이미 있을 수 있음).
            try {
              const ocrText = await _ocrPdfPages(file.buffer, 2);
              if (ocrText && ocrText.trim()) { text += "\n\n" + ocrText; warnings.push("일부 정보는 OCR로 보강했습니다."); }
            } catch (e) { /* poppler/tesseract 미설치 등 — 텍스트 추출 결과만 사용 */ }
          }
        }
      } else if (sniff.kind === "docx") {
        // magic-byte 검사는 "PK로 시작하는 zip"이라는 것만 확인했을 뿐, 실제 워드
        // 문서 구조인지·압축 해제 시 정상 범위인지는 아직 모른다 — mammoth에 넘기기
        // 전에 먼저 확인한다(hello.txt 하나만 담긴 zip을 확장자만 .docx로 바꿔 올린
        // 경우 400, zip 폭탄 성격의 항목수/크기 초과는 413).
        try {
          await _validateDocxZip(file.buffer);
        } catch (zipErr) {
          if (zipErr.code === "TOO_LARGE") return res.status(413).json({ ok: false, code: "RESUME_FILE_TOO_LARGE", message: "DOCX 파일의 압축 해제 크기가 너무 큽니다." });
          return res.status(400).json({ ok: false, code: "RESUME_FILE_INVALID", message: "파일 내용이 확장자와 일치하지 않습니다." });
        }
        try {
          const mammoth = require("mammoth");
          const result = await mammoth.extractRawText({ buffer: file.buffer });
          text = result.value || "";
        } catch (e) {
          return res.status(422).json({ ok: false, code: "RESUME_TEXT_UNREADABLE", message: "DOCX에서 텍스트를 추출할 수 없습니다." });
        }
      } else if (sniff.kind === "image") {
        // 디코드(OCR) 전에 헤더만 읽어 픽셀 수를 먼저 확인한다 — 파일 바이트 자체는
        // 작아도 디코드하면 거대한 픽셀 배열이 되는 이미지(png/webp 압축 폭탄 부류)를
        // tesseract에 넘기기 전에 걸러낸다. 헤더를 못 읽으면(포맷은 맞는데 구조가
        // 손상됨) 안전하게 거부한다 — 판정 불가 상태로 큰 이미지를 그냥 통과시키지 않는다.
        const dims = _getImageDimensions(file.buffer, sniff.mime);
        if (!dims) return res.status(400).json({ ok: false, code: "RESUME_FILE_INVALID", message: "이미지 파일을 읽을 수 없습니다." });
        if (dims.width * dims.height > RESUME_IMAGE_MAX_PIXELS) {
          return res.status(413).json({ ok: false, code: "RESUME_IMAGE_TOO_LARGE", message: `이미지 해상도가 너무 큽니다(최대 ${Math.floor(RESUME_IMAGE_MAX_PIXELS / 1_000_000)}MP).` });
        }
        try {
          text = await _ocrImageBuffer(file.buffer, sniff.mime === "jpeg" ? "jpg" : sniff.mime);
          extraction = "ocr";
        } catch (ocrErr) {
          if (_isOcrToolMissing(ocrErr)) return res.status(503).json({ ok: false, code: "RESUME_OCR_UNAVAILABLE", message: "OCR 기능을 사용할 수 없습니다(서버에 OCR 도구가 설치되지 않았습니다). 관리자에게 문의하세요." });
          return res.status(422).json({ ok: false, code: "RESUME_TEXT_UNREADABLE", message: "이미지에서 텍스트를 추출할 수 없습니다." });
        }
      }

      if (!text || text.trim().length < 20) {
        return res.status(422).json({ ok: false, code: "RESUME_TEXT_UNREADABLE", message: "문서에서 읽을 수 있는 내용이 너무 적습니다." });
      }

      let fields;
      try {
        const raw = await _hrResumeGroqParse(text);
        fields = _sanitizeHrResumeFields(raw);
      } catch (aiErr) {
        if (aiErr.code === "NOT_CONFIGURED") return res.status(503).json({ ok: false, code: "RESUME_AI_UNAVAILABLE", message: "이력서 자동분석 기능이 설정되지 않았습니다(관리자에게 문의하세요)." });
        if (aiErr.code === "TIMEOUT") return res.status(504).json({ ok: false, code: "RESUME_AI_TIMEOUT", message: "이력서 분석 시간이 초과됐습니다. 다시 시도해주세요." });
        return res.status(502).json({ ok: false, code: "RESUME_AI_FAILED", message: "이력서 분석 중 오류가 발생했습니다." });
      }

      // 원문 파일/텍스트는 응답에 절대 포함하지 않는다(fields만 반환) — 개인정보(이력서
      // 원문)가 클라이언트 콘솔/네트워크 로그에 불필요하게 남지 않도록.
      res.json({ ok: true, fields, meta: { fileType: sniff.kind, extraction, warnings } });
    } catch (e) {
      res.status(500).json({ ok: false, code: "RESUME_UNKNOWN_ERROR", message: "이력서 처리 중 오류가 발생했습니다." });
    } finally {
      req._releaseResumeSlot?.();
    }
  }
);

// 경력표에서 회사명이 빈 항목(대개 인쇄용 이력서 PDF가 회사명을 이미지로만 렌더링해
// OCR 좌표 매칭으로도 못 찾은 경우, 2026-07-22 실측)에 한해 AI에게 후보를 물어보는
// 용도. 클라이언트는 이 응답을 절대 입력칸에 자동으로 채우지 않고 "AI 추정값 —
// 클릭하여 적용" 형태로만 보여준다(정규식/OCR 추출값과 달리 AI는 확신이 없어도
// 그럴듯한 값을 지어낼 수 있어, 사람이 확인 후 직접 승인해야 실제 데이터가 되도록
// 설계). 그래서 프롬프트도 "모르면 반드시 빈 문자열"을 강하게 요구한다.
async function _groqSuggestCareerCompanies(text, entries) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const targetIdx = entries.filter((e) => !String(e.company || "").trim()).map((e) => e.idx);
  if (!targetIdx.length) return [];
  const system = `너는 한국어 이력서 원문을 읽고, 회사명이 비어있는 경력 항목의 회사명을 추정하는 도우미다.
아래 JSON의 entries는 이 지원자의 경력사항 전체를 이력서에 기재된 순서(최근 회사부터 과거 순) 그대로 담고 있다. 각 항목은 idx/period(재직기간)/duties(주요업무)와, 이미 확정된 값이 있으면 company(회사명)를 포함한다.
company가 이미 채워진 항목은 정규식/OCR로 이미 확정된 정답이니 절대 건드리지 말고, **오직 targetIdx 목록에 있는(=company가 빈 문자열인) 항목에 대해서만** 회사명을 추정해라.

**핵심 힌트 — entries의 순서를 앵커로 써라**: 이력서 원문 안에는 여러 회사명이 등장하지만, OCR/텍스트 추출 과정에서 표 레이아웃이 깨져 회사명이 실제로 속한 재직기간과 다른 위치로 밀려 보일 수 있다. 그래서 원문에서 그럴듯한 회사명을 찾았다고 바로 답하지 말고, 반드시 company가 이미 채워진 앞뒤 항목들의 위치(=시간 순서)를 기준으로, 그 사이 시간대에 맞는 회사명 후보를 원문에서 찾아 배정해라. 예를 들어 idx 2의 company가 "A"이고 idx 5의 company가 "B"로 이미 확정되어 있다면, idx 3·4(빈 항목)에 들어갈 회사명은 원문에서 A와 B "사이"에 등장하는 회사명이어야 한다 — A나 B와 같은 이름을 다시 쓰거나, A보다 앞(더 최근)이나 B보다 뒤(더 과거)에 나오는 회사명을 엉뚱하게 배정하지 마라.

**중요 — 발주처/고객사와 재직 회사를 혼동하지 마라**: 프리랜서·SI 경력이 많은 이력서에서는 업무내용(duties) 문장 자체에 "삼성전기 MES 구축", "한국선급 시스템 프로젝트", "GS칼텍스 파트너시스템 프로젝트" 처럼 그 프로젝트를 발주한 고객사 이름이 등장하는 경우가 매우 흔하다. 이런 문장 속 기업명은 지원자가 프로젝트를 수행해 준 대상(고객사)일 뿐, 지원자가 소속되어 급여를 받은 회사가 아니다. 재직 회사명은 보통 그 경력 항목의 재직기간 바로 옆이나 위쪽에 별도의 짧은 회사명 형태(예: "㈜", "주식회사", "…기술", "…정보", "…솔루션", 영문 약칭 등)로 독립적으로 등장한다. duties 문장 안에서 그럴듯한 기업명을 발견했다고 그것을 회사명으로 쓰지 말고, 반드시 원문 다른 위치에서 그 항목의 "재직 회사명" 자체가 독립적으로 언급된 경우에만 답하라.

원문에서 확실히 찾을 수 없거나 확신이 없으면 절대 추측해서 지어내지 말고 반드시 빈 문자열로 남겨라. 특히 위에서 설명한 고객사/발주처 이름이나, 순서상 맞지 않는 다른 항목의 회사명을 재활용하는 것은 틀린 답이니 하지 마라.
반드시 다음 JSON 스키마로만 응답해라(마크다운이나 설명 금지):
{"suggestions": [{"idx": 0, "company": "회사명 또는 빈 문자열"}]}
idx는 반드시 targetIdx 목록에 있는 값이어야 하고, targetIdx 개수만큼 정확히 응답해라. company가 이미 채워진 항목의 idx로는 응답하지 마라.`;
  const userContent = JSON.stringify({ resumeText: text.slice(0, 12000), entries, targetIdx });
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!resp.ok) throw new Error("Groq API 오류 " + resp.status + ": " + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  return Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
}
app.post("/api/recruit/suggest-career-companies", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-candidates")) return;
    const { text, entries } = req.body || {};
    if (!text || typeof text !== "string" || text.trim().length < 20) {
      return res.json({ ok: false, message: "분석할 텍스트가 부족합니다." });
    }
    if (!Array.isArray(entries) || !entries.length) {
      return res.json({ ok: true, suggestions: [] });
    }
    let suggestions;
    try {
      suggestions = await _groqSuggestCareerCompanies(text, entries);
    } catch (e) {
      return res.json({ ok: false, message: "AI 분석에 실패했습니다: " + e.message });
    }
    if (suggestions === null) return res.json({ ok: false, message: "AI 분석 기능이 설정되지 않았습니다(GROQ_API_KEY 필요)." });
    res.json({ ok: true, suggestions });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

async function _groqSummarizePeople(kind, people) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const KIND_LABEL = { core: "핵심인재", low: "저성과자", block9: "9-Block 인재" };
  const label = KIND_LABEL[kind] || "인재";
  const system = `너는 한국어 인사(HR) 데이터를 분석하는 도우미다. 아래 ${label} 명단(JSON 배열, 각 항목은 이름/부서/KPI등급/역량등급/연도별 평가이력 등)을 보고, 각 인원별로 다음 JSON 스키마로만 응답해라. 마크다운이나 설명 없이 JSON 객체 하나만 출력해라.
{
  "summaries": [
    { "empId": "직원ID(입력값 그대로)", "name": "이름", "summary": "이 인원이 왜 이 명단에 해당하는지 평가 데이터 근거를 2~3문장으로 요약. 추측하지 말고 주어진 데이터만 근거로 작성" }
  ]
}`;
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(people).slice(0, 12000) },
      ],
    }),
  });
  if (!resp.ok) throw new Error("Groq API 오류 " + resp.status + ": " + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content).summaries || [];
}
app.post("/api/hr/analyze-summary", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const { kind, people } = req.body || {};
    if (!["core", "low", "block9"].includes(kind)) return res.status(400).json({ ok: false, message: "kind 값이 올바르지 않습니다." });
    if (!Array.isArray(people) || !people.length) return res.json({ ok: false, message: "분석할 인원 데이터가 없습니다." });
    let summaries;
    try {
      summaries = await _groqSummarizePeople(kind, people);
    } catch (e) {
      return res.json({ ok: false, message: "AI 분석에 실패했습니다: " + e.message });
    }
    if (!summaries) return res.json({ ok: false, message: "AI 분석 기능이 설정되지 않았습니다(GROQ_API_KEY 필요)." });
    res.json({ ok: true, summaries });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

async function _groqDraftKpiGoal(jobRole, itemName) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const system = `너는 한국 기업의 인사(HR) KPI 목표 설정을 돕는 도우미다. 아래 직무에 해당하는 사람이 작성할 법한 KPI 목표 설정 초안을 작성해라. 마크다운이나 설명 없이 아래 JSON 스키마 객체 하나만 출력해라.
{
  "item": "KPI 항목명 (간결하게)",
  "goal": "당해년도 목표 (구체적, 측정 가능하게)",
  "strategy": "달성 전략 (2~3문장)",
  "evalCriteria": "평가 기준 (측정 방법/기준)"
}`;
  const userMsg = `직무: ${jobRole}${itemName ? `\nKPI 항목명(참고): ${itemName}` : ""}`;
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
    }),
  });
  if (!resp.ok) throw new Error("Groq API 오류 " + resp.status + ": " + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}
async function _groqAnalyzeOrgData(kind, data) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const KIND_LABEL = { stats: "인사 통계(인원현황/입퇴사/근속/조직구성)", promotion: "승진 심사 현황" };
  const label = KIND_LABEL[kind] || "인사 데이터";
  const system = `너는 한국 기업의 인사(HR) 데이터를 분석하는 컨설턴트다. 아래 ${label} 데이터(JSON)를 보고 조직 운영상 문제가 될 수 있는 이슈를 찾아내고 대응 방안 초안을 제시해라. 데이터에 실제로 나타난 수치/패턴에 근거해서만 작성하고, 데이터에 없는 사실을 추측하거나 단정하지 마라. 이슈가 뚜렷하지 않으면 issues를 빈 배열로 둬라. 마크다운이나 설명 없이 아래 JSON 스키마 객체 하나만 출력해라.
{
  "overview": "전체 데이터에 대한 종합 분석 요약 (3~5문장)",
  "issues": [
    { "title": "이슈 제목 (간결하게)", "detail": "이슈 내용과 근거 데이터 (2~3문장)", "action": "대응 방안 초안 (2~3문장, 구체적 실행 방안)", "severity": "high|medium|low" }
  ]
}`;
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(data).slice(0, 12000) },
      ],
    }),
  });
  if (!resp.ok) throw new Error("Groq API 오류 " + resp.status + ": " + (await resp.text()).slice(0, 300));
  const respData = await resp.json();
  const content = respData?.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  return { overview: parsed.overview || "", issues: Array.isArray(parsed.issues) ? parsed.issues : [] };
}
app.post("/api/hr/analyze-org", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const { kind, data } = req.body || {};
    if (!["stats", "promotion"].includes(kind)) return res.status(400).json({ ok: false, message: "kind 값이 올바르지 않습니다." });
    if (!data) return res.json({ ok: false, message: "분석할 데이터가 없습니다." });
    let analysis;
    try {
      analysis = await _groqAnalyzeOrgData(kind, data);
    } catch (e) {
      return res.json({ ok: false, message: "AI 분석에 실패했습니다: " + e.message });
    }
    if (!analysis) return res.json({ ok: false, message: "AI 분석 기능이 설정되지 않았습니다(GROQ_API_KEY 필요)." });
    res.json({ ok: true, ...analysis });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/hr/draft-kpi-goal", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director", "member"])) return;
    const { jobRole, itemName } = req.body || {};
    if (!jobRole) return res.status(400).json({ ok: false, message: "jobRole 값이 필요합니다." });
    let draft;
    try {
      draft = await _groqDraftKpiGoal(jobRole, itemName);
    } catch (e) {
      return res.json({ ok: false, message: "AI 초안 생성에 실패했습니다: " + e.message });
    }
    if (!draft) return res.json({ ok: false, message: "AI 초안 생성 기능이 설정되지 않았습니다(GROQ_API_KEY 필요)." });
    res.json({ ok: true, draft });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

async function _groqDraftEvalComment(stage, memberName, kpis) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const stageLabel = stage === "second" ? "2차(사업부장)" : "1차(팀장)";
  const system = `너는 한국 기업의 ${stageLabel} 인사평가 의견 작성을 돕는 도우미다. 아래 직원의 KPI 항목별 목표/실적/점수 데이터(JSON 배열)를 보고, 평가자가 작성할 법한 종합 평가 의견 초안을 작성해라. 주어진 데이터만 근거로 작성하고 추측하지 마라. 마크다운이나 설명 없이 아래 JSON 스키마 객체 하나만 출력해라.
{
  "comment": "종합 평가 의견 (4~6문장, 성과/역량/발전가능성/개선점을 포함)"
}`;
  const userMsg = `직원: ${memberName}\nKPI 데이터: ${JSON.stringify(kpis).slice(0, 8000)}`;
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
    }),
  });
  if (!resp.ok) throw new Error("Groq API 오류 " + resp.status + ": " + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content).comment || "";
}
app.post("/api/hr/draft-eval-comment", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const { stage, memberName, kpis } = req.body || {};
    if (!["first", "second"].includes(stage)) return res.status(400).json({ ok: false, message: "stage 값이 올바르지 않습니다." });
    if (!Array.isArray(kpis) || !kpis.length) return res.json({ ok: false, message: "평가할 KPI 데이터가 없습니다." });
    let comment;
    try {
      comment = await _groqDraftEvalComment(stage, memberName || "", kpis);
    } catch (e) {
      return res.json({ ok: false, message: "AI 초안 생성에 실패했습니다: " + e.message });
    }
    if (!comment) return res.json({ ok: false, message: "AI 초안 생성 기능이 설정되지 않았습니다(GROQ_API_KEY 필요)." });
    res.json({ ok: true, comment });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// The recruit routes below (candidates/:id, candidates/:id/status, interviews/:id,
// interviews/:id/cancel, interviews/:id/evaluation, interviews/:id/verdict) all used to do
// a plain `SELECT data ...` (no lock) → mutate the JS object → `UPDATE ... SET data = $2`
// in Postgres mode, with no protection against two requests targeting the same row at
// nearly the same time. Confirmed by concurrency testing: 10 interviewers submitting
// evaluations for the same interview nearly simultaneously left only the last commit's
// evaluation — the other 9 vanished silently (every request still got HTTP 200). JSON-file
// mode happened to be safe only because it mutates a shared in-memory object with no
// `await` in between (Node's single-threaded event loop can't interleave it), which is an
// accident of implementation, not a design guarantee — Postgres mode's real `await` between
// the SELECT and UPDATE is exactly the window where a second request's own SELECT..UPDATE
// can interleave and silently lose the first request's write.
// `SELECT ... FOR UPDATE` inside a transaction closes that window: a second request's
// SELECT for the same row blocks until the first request's transaction commits, then reads
// the already-merged data instead of a stale pre-commit snapshot.
class _RecruitRouteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// companyId: recruit_candidates/recruit_interviews는 nullable 단순 company_id 컬럼이라
// (레거시 NULL 데이터 포함) 다른 회사 소유 id로는 아예 잠글 수 없도록 필터한다 — 회사가
// 다르면 부서 스코프 검사(mutate 콜백 안의 _recruitCanViewCandidate 등) 이전에 404.
async function _pgLockedUpdate(table, id, mutate, companyId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT data FROM ${table} WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL) FOR UPDATE`, [id, companyId || null]
    );
    if (!rows.length) throw new _RecruitRouteError(404, "레코드를 찾을 수 없습니다.");
    const data = await mutate(rows[0].data);
    // recruit_candidates/recruit_interviews의 id는 (jobs와 달리) 단일컬럼 PK라 서버가
    // 생성한 값만 쓰이고 클라이언트가 지정할 수 없어 현재는 회사간 id 충돌이 사실상
    // 불가능하지만, 위 SELECT와 동일하게 company_id로 UPDATE도 스코프해 이 함수가 잠근
    // 것과 실제로 쓰는 행이 항상 같은 행이도록 방어한다(jobs close 라우트에서 발견된
    // "SELECT는 스코프됐는데 UPDATE는 안 됨" 클래스의 버그 재발 방지).
    await client.query(`UPDATE ${table} SET data = $2, updated_at = NOW() WHERE id = $1 AND (company_id = $3 OR company_id IS NULL)`, [id, data, companyId || null]);
    await client.query("COMMIT");
    return data;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

app.post("/api/recruit/candidates", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-candidates")) return;
    const companyId = req.auth.companyId || null;
    const { jobId, name, email, phone, resume, memo, resumeSummary, strengths, weaknesses, finalEducation, careerHistory, lastSalary, desiredSalary, activities, careerGaps, user: createdBy } = req.body || {};
    if (!jobId || !name) return res.status(400).json({ ok: false, message: "채용공고, 지원자명은 필수입니다." });
    const job = await _recruitJobById(jobId, companyId);
    if (!job) return res.status(404).json({ ok: false, message: "채용공고를 찾을 수 없습니다." });
    if (!(await _recruitCanViewJob(job, req.auth.empId, req.auth.role, companyId))) {
      return res.status(403).json({ ok: false, message: "해당 채용공고에 지원자를 등록할 권한이 없습니다." });
    }
    if (job.status !== "open") return res.status(409).json({ ok: false, message: "마감된 채용공고에는 지원자를 등록할 수 없습니다." });
    const candidateId = `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const candidate = {
      id: candidateId, jobId, name, email: email || "", phone: phone || "",
      status: job.stages[0], memo: memo || "",
      resumeSummary: resumeSummary || "", strengths: strengths || "", weaknesses: weaknesses || "",
      finalEducation: finalEducation || "", careerHistory: careerHistory || "", lastSalary: lastSalary || "", desiredSalary: desiredSalary || "", activities: activities || "", careerGaps: careerGaps || "",
      resume: resume && resume.fileName ? { fileName: resume.fileName, type: resume.type || "", data: resume.data || "" } : null,
      evaluations: [], appliedAt: now, createdBy: createdBy || "unknown",
      createdAt: now, updatedAt: now,
    };
    if (USE_JSON_FILE) {
      _fileRecruit.candidates.push(candidate);
      _saveFileRecruit();
      return res.json({ ok: true, candidate: _recruitStripResume(candidate) });
    }
    await pool.query(
      "INSERT INTO recruit_candidates (id, job_id, data, company_id) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET data = $3, updated_at = NOW()",
      [candidateId, jobId, candidate, companyId]
    );
    res.json({ ok: true, candidate: _recruitStripResume(candidate) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/recruit/candidates/:id", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-candidates")) return;
    const id = req.params.id;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    const { name, email, phone, memo, resumeSummary, strengths, weaknesses, finalEducation, careerHistory, lastSalary, desiredSalary, activities, careerGaps, resume } = req.body || {};
    const applyEdits = (candidate) => {
      if (name != null) candidate.name = name;
      if (email != null) candidate.email = email;
      if (phone != null) candidate.phone = phone;
      if (memo != null) candidate.memo = memo;
      if (resumeSummary != null) candidate.resumeSummary = resumeSummary;
      if (strengths != null) candidate.strengths = strengths;
      if (weaknesses != null) candidate.weaknesses = weaknesses;
      if (finalEducation != null) candidate.finalEducation = finalEducation;
      if (careerHistory != null) candidate.careerHistory = careerHistory;
      if (lastSalary != null) candidate.lastSalary = lastSalary;
      if (desiredSalary != null) candidate.desiredSalary = desiredSalary;
      if (activities != null) candidate.activities = activities;
      if (careerGaps != null) candidate.careerGaps = careerGaps;
      if (resume && resume.fileName) candidate.resume = { fileName: resume.fileName, type: resume.type || "", data: resume.data || "" };
      candidate.updatedAt = new Date().toISOString();
      return candidate;
    };
    if (USE_JSON_FILE) {
      const candidate = _fileRecruit.candidates.find(c => c.id === id);
      if (!candidate) return res.status(404).json({ ok: false, message: "지원자를 찾을 수 없습니다." });
      if (!(await _recruitCanViewCandidate(candidate, userId, role, companyId))) return res.status(403).json({ ok: false, message: "수정 권한이 없습니다." });
      applyEdits(candidate);
      _saveFileRecruit();
      return res.json({ ok: true, candidate: _recruitStripResume(candidate) });
    }
    let candidate;
    try {
      // 락 진입 전에 권한 판정에 필요한 조회를 전부 끝낸다(_recruitBuildCache 주석 참고).
      const rc = await _recruitBuildCache(companyId, { employees: true, jobs: true, interviews: true });
      candidate = await _pgLockedUpdate("recruit_candidates", id, async (c) => {
        if (!(await _recruitCanViewCandidate(c, userId, role, companyId, rc))) throw new _RecruitRouteError(403, "수정 권한이 없습니다.");
        return applyEdits(c);
      }, companyId);
    } catch (e) {
      if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: _safeErrMsg(e) });
      throw e;
    }
    res.json({ ok: true, candidate: _recruitStripResume(candidate) });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.get("/api/recruit/candidates/:id/resume", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const id = req.params.id;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    let candidate;
    if (USE_JSON_FILE) {
      candidate = _fileRecruit.candidates.find(c => c.id === id);
    } else {
      const { rows } = await pool.query("SELECT data FROM recruit_candidates WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
      candidate = rows[0] ? rows[0].data : null;
    }
    if (!candidate || !candidate.resume) return res.status(404).json({ ok: false, message: "이력서를 찾을 수 없습니다." });
    if (!(await _recruitCanViewCandidate(candidate, userId, role, companyId))) return res.status(403).json({ ok: false, message: "열람 권한이 없습니다." });
    res.json({ ok: true, resume: candidate.resume });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/recruit/candidates/:id/status", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-candidates")) return;
    const id = req.params.id;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    const { status, reason } = req.body || {};
    if (!status) return res.status(400).json({ ok: false, message: "변경할 전형 단계는 필수입니다." });
    const RECRUIT_PASS_SCORE = 15;
    const checkReasonRequired = async (candidate, job, cache) => {
      const stages = job.stages || [];
      const curIdx = stages.indexOf(candidate.status);
      const newIdx = stages.indexOf(status);
      if (newIdx <= curIdx) return false;
      const interviews = await _recruitAllInterviews(companyId, cache);
      const evals = interviews.filter(iv => String(iv.candidateId) === String(candidate.id) && iv.status !== "canceled").flatMap(iv => iv.evaluations || []);
      if (!evals.length) return false;
      const avg = evals.reduce((s, e) => s + (e.totalScore || 0), 0) / evals.length;
      return avg < RECRUIT_PASS_SCORE;
    };
    if (USE_JSON_FILE) {
      const candidate = _fileRecruit.candidates.find(c => c.id === id);
      if (!candidate) return res.status(404).json({ ok: false, message: "지원자를 찾을 수 없습니다." });
      if (!(await _recruitCanViewCandidate(candidate, userId, role, companyId))) return res.status(403).json({ ok: false, message: "수정 권한이 없습니다." });
      const job = await _recruitJobById(candidate.jobId, companyId);
      if (!job || !job.stages.includes(status)) return res.status(400).json({ ok: false, message: "해당 채용공고에 없는 전형 단계입니다." });
      if (await checkReasonRequired(candidate, job) && !String(reason || "").trim()) {
        return res.status(400).json({ ok: false, message: "통과 기준 미만 점수로 다음 단계 진행 시 사유를 입력해야 합니다." });
      }
      candidate.status = status;
      candidate.statusReason = reason || "";
      candidate.updatedAt = new Date().toISOString();
      _saveFileRecruit();
      return res.json({ ok: true, candidate });
    }
    let candidate;
    try {
      const rc = await _recruitBuildCache(companyId, { employees: true, jobs: true, interviews: true });
      candidate = await _pgLockedUpdate("recruit_candidates", id, async (c) => {
        if (!(await _recruitCanViewCandidate(c, userId, role, companyId, rc))) throw new _RecruitRouteError(403, "수정 권한이 없습니다.");
        const job = await _recruitJobById(c.jobId, companyId, rc);
        if (!job || !job.stages.includes(status)) throw new _RecruitRouteError(400, "해당 채용공고에 없는 전형 단계입니다.");
        if (await checkReasonRequired(c, job, rc) && !String(reason || "").trim()) {
          throw new _RecruitRouteError(400, "통과 기준 미만 점수로 다음 단계 진행 시 사유를 입력해야 합니다.");
        }
        c.status = status;
        c.statusReason = reason || "";
        c.updatedAt = new Date().toISOString();
        return c;
      }, companyId);
    } catch (e) {
      if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: _safeErrMsg(e) });
      throw e;
    }
    res.json({ ok: true, candidate });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── 채용 관리: 면접 일정/평가 (1차·2차 구분, 면접관별 비공개 평가) ────────────────
const RECRUIT_SCORE_CATEGORIES = ["태도", "전문지식", "적극성", "의사소통능력", "조직적합성"];
const RECRUIT_SCORE_MIN = 1, RECRUIT_SCORE_MAX = 5;
// 면접 열람 권한: 관리자, 인사팀장, 면접 대상 채용공고를 볼 수 있는 등록자/담당자, 또는 본인이 면접관으로 지정된 경우
async function _recruitIsInterviewPrivileged(interview, userId, role, companyId, cache) {
  if (role === "admin") return true;
  const job = await _recruitJobById(interview.jobId, companyId, cache);
  if (job && await _recruitCanViewJob(job, userId, role, companyId, cache)) return true;
  return false;
}
function _recruitFilterInterviewForViewer(interview, userId, privileged) {
  if (privileged) return interview;
  return { ...interview, evaluations: (interview.evaluations || []).filter(e => String(e.interviewerId) === String(userId)) };
}
async function _recruitAllInterviews(companyId, cache) {
  if (cache && cache.interviews) return cache.interviews;
  if (USE_JSON_FILE) return _fileRecruit.interviews;
  const { rows } = await pool.query(
    "SELECT data FROM recruit_interviews WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL) ORDER BY created_at DESC", [companyId || null]
  );
  return rows.map(r => r.data);
}
app.get("/api/recruit/interviews", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { jobId, candidateId } = req.query;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    let list = await _recruitAllInterviews(companyId);
    if (jobId) list = list.filter(i => String(i.jobId) === String(jobId));
    if (candidateId) list = list.filter(i => String(i.candidateId) === String(candidateId));
    const out = [];
    for (const interview of list) {
      const privileged = await _recruitIsInterviewPrivileged(interview, userId, role, companyId);
      const isInterviewer = (interview.interviewerIds || []).map(String).includes(String(userId));
      if (!privileged && !isInterviewer) continue;
      out.push(_recruitFilterInterviewForViewer(interview, userId, privileged));
    }
    res.json({ ok: true, interviews: out });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/recruit/interviews", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-eval")) return;
    const companyId = req.auth.companyId || null;
    const { jobId, candidateId, round, schedule, interviewerIds, location, leadInterviewerId } = req.body || {};
    if (!jobId || !candidateId || !round || !Array.isArray(interviewerIds) || !interviewerIds.length) {
      return res.status(400).json({ ok: false, message: "채용공고, 지원자, 면접 회차, 면접관은 필수입니다." });
    }
    // round는 전형 단계 인덱스로 쓰이므로(평가 시 stages[round] 비교) 음수/소수가 들어가면
    // 단계 판정이 어긋난다 — 서버가 값을 전혀 보지 않아 round:-5가 그대로 저장됐다.
    const roundNum = Number(round);
    if (!Number.isInteger(roundNum) || roundNum < 1 || roundNum > 20) {
      return res.status(400).json({ ok: false, message: "면접 회차는 1~20 사이의 정수여야 합니다." });
    }
    const job = await _recruitJobById(jobId, companyId);
    if (!job) return res.status(404).json({ ok: false, message: "채용공고를 찾을 수 없습니다." });
    if (!(await _recruitCanViewJob(job, req.auth.empId, req.auth.role, companyId))) {
      return res.status(403).json({ ok: false, message: "해당 채용공고에 면접을 등록할 권한이 없습니다." });
    }
    if (job.status !== "open") return res.status(409).json({ ok: false, message: "마감된 채용공고에는 면접을 등록할 수 없습니다." });
    const candidate = (await _recruitAllCandidates(companyId)).find(c => String(c.id) === String(candidateId));
    if (!candidate) return res.status(404).json({ ok: false, message: "지원자를 찾을 수 없습니다." });
    if (String(candidate.jobId) !== String(jobId)) return res.status(400).json({ ok: false, message: "지원자가 선택한 채용공고와 일치하지 않습니다." });
    if (!Array.isArray(job.stages) || roundNum >= job.stages.length) {
      return res.status(400).json({ ok: false, message: "채용공고의 전형 단계 범위를 벗어난 면접 회차입니다." });
    }
    const id = `iv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const normInterviewerIds = interviewerIds.map(String);
    const interview = {
      id, jobId, candidateId, round: roundNum, schedule: schedule || "", location: location || "",
      status: "scheduled", interviewerIds: normInterviewerIds,
      leadInterviewerId: (leadInterviewerId && normInterviewerIds.includes(String(leadInterviewerId))) ? String(leadInterviewerId) : "",
      finalVerdict: null, evaluations: [], createdAt: now, updatedAt: now,
    };
    if (USE_JSON_FILE) {
      _fileRecruit.interviews.push(interview);
      _saveFileRecruit();
      return res.json({ ok: true, interview });
    }
    await pool.query(
      "INSERT INTO recruit_interviews (id, job_id, candidate_id, data, company_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET data = $4, updated_at = NOW()",
      [id, jobId, candidateId, interview, companyId]
    );
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/recruit/interviews/:id", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-eval")) return;
    const id = req.params.id;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    const { round, schedule, interviewerIds, location, leadInterviewerId } = req.body || {};
    const applyEdits = (interview) => {
      if (round != null) interview.round = Number(round);
      if (schedule != null) interview.schedule = schedule;
      if (location != null) interview.location = location;
      if (Array.isArray(interviewerIds) && interviewerIds.length) interview.interviewerIds = interviewerIds.map(String);
      if (leadInterviewerId !== undefined) {
        interview.leadInterviewerId = (leadInterviewerId && interview.interviewerIds.includes(String(leadInterviewerId))) ? String(leadInterviewerId) : "";
      } else if (interview.leadInterviewerId && !interview.interviewerIds.includes(String(interview.leadInterviewerId))) {
        interview.leadInterviewerId = "";
      }
      interview.updatedAt = new Date().toISOString();
      return interview;
    };
    if (USE_JSON_FILE) {
      const interview = _fileRecruit.interviews.find(i => i.id === id);
      if (!interview) return res.status(404).json({ ok: false, message: "면접 일정을 찾을 수 없습니다." });
      if (!(await _recruitIsInterviewPrivileged(interview, userId, role, companyId))) return res.status(403).json({ ok: false, message: "수정 권한이 없습니다." });
      applyEdits(interview);
      _saveFileRecruit();
      return res.json({ ok: true, interview });
    }
    let interview;
    try {
      const rc = await _recruitBuildCache(companyId, { employees: true, jobs: true });
      interview = await _pgLockedUpdate("recruit_interviews", id, async (iv) => {
        if (!(await _recruitIsInterviewPrivileged(iv, userId, role, companyId, rc))) throw new _RecruitRouteError(403, "수정 권한이 없습니다.");
        return applyEdits(iv);
      }, companyId);
    } catch (e) {
      if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: _safeErrMsg(e) });
      throw e;
    }
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/recruit/interviews/:id/cancel", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-eval")) return;
    const id = req.params.id;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    const { reason } = req.body || {};
    const applyCancel = (interview) => {
      interview.status = "canceled";
      interview.cancelReason = reason || "";
      interview.canceledAt = new Date().toISOString();
      interview.updatedAt = interview.canceledAt;
      return interview;
    };
    if (USE_JSON_FILE) {
      const interview = _fileRecruit.interviews.find(i => i.id === id);
      if (!interview) return res.status(404).json({ ok: false, message: "면접 일정을 찾을 수 없습니다." });
      if (!(await _recruitIsInterviewPrivileged(interview, userId, role, companyId))) return res.status(403).json({ ok: false, message: "취소 권한이 없습니다." });
      applyCancel(interview);
      _saveFileRecruit();
      return res.json({ ok: true, interview });
    }
    let interview;
    try {
      const rc = await _recruitBuildCache(companyId, { employees: true, jobs: true });
      interview = await _pgLockedUpdate("recruit_interviews", id, async (iv) => {
        if (!(await _recruitIsInterviewPrivileged(iv, userId, role, companyId, rc))) throw new _RecruitRouteError(403, "취소 권한이 없습니다.");
        return applyCancel(iv);
      }, companyId);
    } catch (e) {
      if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: _safeErrMsg(e) });
      throw e;
    }
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/recruit/interviews/:id/evaluation", async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requirePage(req, res, "recruit-eval")) return;
  try {
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const { interviewerId, scores, comment } = req.body || {};
    const { role, empId: authUserId } = req.auth;
    if (!interviewerId || !scores || typeof scores !== "object") {
      return res.status(400).json({ ok: false, message: "면접관, 평가 점수는 필수입니다." });
    }
    // 화면 폼은 1~5 셀렉트라 정상 경로로는 벗어날 수 없지만, 서버는 값 범위를 전혀 보지 않아
    // API 직접 호출로 9999/-500 같은 값이 그대로 저장됐다(총점 9511). 이 총점은 다중 심사위원
    // 편차 경고(_ivScoreSpread, 8점 기준)와 전형 단계 통과 기준(RECRUIT_PASS_SCORE) 판정에
    // 그대로 쓰이므로, 오염되면 채용 의사결정 자체가 왜곡된다.
    const _badScore = RECRUIT_SCORE_CATEGORIES.find(k => {
      if (scores[k] === undefined || scores[k] === null || scores[k] === "") return false;
      const n = Number(scores[k]);
      return !Number.isFinite(n) || n < RECRUIT_SCORE_MIN || n > RECRUIT_SCORE_MAX;
    });
    if (_badScore) {
      return res.status(400).json({ ok: false, message: `평가 점수는 ${RECRUIT_SCORE_MIN}~${RECRUIT_SCORE_MAX} 사이여야 합니다(${_badScore}).` });
    }
    const _unknownKey = Object.keys(scores).find(k => !RECRUIT_SCORE_CATEGORIES.includes(k));
    if (_unknownKey) {
      return res.status(400).json({ ok: false, message: `평가 항목이 올바르지 않습니다: ${_unknownKey}` });
    }
    // 각 면접관의 평가는 evaluations 배열 안 자기 interviewerId 항목만 upsert하는
    // 구조라, 여러 면접관이 거의 동시에 제출하면(락 없는 SELECT→mutate→UPDATE) 나중에
    // commit된 한 명의 평가만 남고 나머지는 조용히 사라졌다(실측: 10명 동시 제출 시
    // 1명만 생존) — interview row를 _pgLockedUpdate로 잠가 순번대로 처리한다.
    const applyEvaluation = async (interview, rc) => {
      if (role !== "admin" && !interview.interviewerIds.map(String).includes(String(interviewerId))) {
        throw new _RecruitRouteError(403, "지정된 면접관만 평가를 입력할 수 있습니다.");
      }
      // interviewerId는 "누구의 평가로 기록할지"를 정하는 값이라 role만 검증해서는
      // 다른 지정 면접관 행세로 남의 평가를 덮어쓸 수 있었다 — 본인 명의로만 입력 가능해야 한다.
      if (role !== "admin" && String(interviewerId) !== String(authUserId)) {
        throw new _RecruitRouteError(403, "본인 명의로만 평가를 입력할 수 있습니다.");
      }
      const candidate = rc && rc.candidates
        ? rc.candidates.find(c => String(c.id) === String(interview.candidateId))
        : (USE_JSON_FILE
          ? _fileRecruit.candidates.find(c => c.id === interview.candidateId)
          : (await pool.query("SELECT data FROM recruit_candidates WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL)", [interview.candidateId, companyId])).rows[0]?.data);
      const job = candidate ? await _recruitJobById(candidate.jobId, companyId, rc) : null;
      if (candidate && job) {
        const stages = (job.stages && job.stages.length) ? job.stages : [];
        const statusIdx = stages.indexOf(candidate.status);
        const roundStageIdx = Math.min(interview.round, stages.length - 1);
        if (statusIdx >= 0 && statusIdx > roundStageIdx) {
          throw new _RecruitRouteError(400, "전형 단계가 진행되어 평가를 수정할 수 없습니다.");
        }
      }
      const totalScore = RECRUIT_SCORE_CATEGORIES.reduce((s, k) => s + (Number(scores[k]) || 0), 0);
      const evaluation = { interviewerId: String(interviewerId), scores, totalScore, comment: comment || "", updatedAt: new Date().toISOString() };
      const idx = (interview.evaluations || []).findIndex(e => String(e.interviewerId) === String(interviewerId));
      if (idx >= 0) interview.evaluations[idx] = evaluation; else (interview.evaluations || (interview.evaluations = [])).push(evaluation);
      interview.updatedAt = new Date().toISOString();
      return interview;
    };
    if (USE_JSON_FILE) {
      const interview = _fileRecruit.interviews.find(i => i.id === id);
      if (!interview) return res.status(404).json({ ok: false, message: "면접 일정을 찾을 수 없습니다." });
      try {
        await applyEvaluation(interview);
      } catch (e) {
        if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: _safeErrMsg(e) });
        throw e;
      }
      _saveFileRecruit();
      return res.json({ ok: true, interview });
    }
    let interview;
    try {
      const rc = await _recruitBuildCache(companyId, { jobs: true, candidates: true });
      interview = await _pgLockedUpdate("recruit_interviews", id, (iv) => applyEvaluation(iv, rc), companyId);
    } catch (e) {
      if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: _safeErrMsg(e) });
      throw e;
    }
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

const RECRUIT_VERDICTS = ["pass", "hold", "fail"];
app.post("/api/recruit/interviews/:id/verdict", async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requirePage(req, res, "recruit-eval")) return;
  try {
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const { verdict, comment } = req.body || {};
    const { role, empId: userId } = req.auth;
    if (!RECRUIT_VERDICTS.includes(verdict)) {
      return res.status(400).json({ ok: false, message: "판정 값이 올바르지 않습니다." });
    }
    const applyVerdict = (interview) => {
      if (!interview.leadInterviewerId) {
        throw new _RecruitRouteError(400, "심사위원장이 지정되지 않아 최종 판정을 입력할 수 없습니다.");
      }
      if (role !== "admin" && String(userId) !== String(interview.leadInterviewerId)) {
        throw new _RecruitRouteError(403, "지정된 심사위원장만 최종 판정을 입력할 수 있습니다.");
      }
      interview.finalVerdict = { verdict, comment: comment || "", decidedBy: String(userId), decidedAt: new Date().toISOString() };
      interview.updatedAt = new Date().toISOString();
      return interview;
    };
    if (USE_JSON_FILE) {
      const interview = _fileRecruit.interviews.find(i => i.id === id);
      if (!interview) return res.status(404).json({ ok: false, message: "면접 일정을 찾을 수 없습니다." });
      try {
        applyVerdict(interview);
      } catch (e) {
        if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: _safeErrMsg(e) });
        throw e;
      }
      _saveFileRecruit();
      return res.json({ ok: true, interview });
    }
    let interview;
    try {
      interview = await _pgLockedUpdate("recruit_interviews", id, async (iv) => applyVerdict(iv), companyId);
    } catch (e) {
      if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: _safeErrMsg(e) });
      throw e;
    }
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.post("/api/recruit/candidates/:id/delete", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    if (!requirePage(req, res, "recruit-candidates")) return;
    const id = req.params.id;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    if (USE_JSON_FILE) {
      const candidate = _fileRecruit.candidates.find(c => c.id === id);
      if (!candidate) return res.status(404).json({ ok: false, message: "지원자를 찾을 수 없습니다." });
      if (!(await _recruitCanViewCandidate(candidate, userId, role, companyId))) return res.status(403).json({ ok: false, message: "삭제 권한이 없습니다." });
      _fileRecruit.candidates = _fileRecruit.candidates.filter(c => c.id !== id);
      _saveFileRecruit();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT data FROM recruit_candidates WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "지원자를 찾을 수 없습니다." });
    if (!(await _recruitCanViewCandidate(rows[0].data, userId, role, companyId))) return res.status(403).json({ ok: false, message: "삭제 권한이 없습니다." });
    await pool.query("UPDATE recruit_candidates SET is_deleted = TRUE WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

app.get("/api/recruit/dashboard", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    let jobs, candidates, interviews;
    if (USE_JSON_FILE) {
      jobs = _fileRecruit.jobs;
      candidates = _fileRecruit.candidates;
      interviews = _fileRecruit.interviews;
    } else {
      const jobRows = await pool.query("SELECT data FROM recruit_jobs WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL) ORDER BY created_at DESC", [companyId]);
      jobs = jobRows.rows.map(r => r.data);
      const candRows = await pool.query("SELECT data FROM recruit_candidates WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL)", [companyId]);
      candidates = candRows.rows.map(r => r.data);
      const intRows = await pool.query("SELECT data FROM recruit_interviews WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL)", [companyId]);
      interviews = intRows.rows.map(r => r.data);
    }
    // /api/recruit/jobs·/candidates는 이미 _recruitCanViewJob으로 부서 스코프를 거는데
    // 이 대시보드는 그 필터가 없어, 무관 부서 리더가 GET으로는 원래 안 보이던 공고의 id를
    // 여기서 알아낸 뒤 그 id로 지원자 상세(이름/이메일/휴대폰)까지 열람할 수 있었다(실측
    // 확인, jobs 쓰기라우트 스코프 누락과 결합해 end-to-end로 재현됨). 동일한 필터 적용.
    if (userId && role && role !== "admin") {
      const filtered = [];
      for (const job of jobs) { if (await _recruitCanViewJob(job, userId, role, companyId)) filtered.push(job); }
      jobs = filtered;
    }
    const stats = jobs.map(job => {
      const jobCandidates = candidates.filter(c => String(c.jobId) === String(job.id));
      const stageStats = job.stages.map(stage => {
        const inStage = jobCandidates.filter(c => c.status === stage);
        const scores = inStage.flatMap(c => (interviews || [])
          .filter(iv => String(iv.candidateId) === String(c.id))
          .flatMap(iv => (iv.evaluations || []).map(e => e.totalScore))
          .filter(n => n != null));
        const avgScore = scores.length ? _round2(scores.reduce((s, n) => s + n, 0) / scores.length) : null;
        return { stage, count: inStage.length, avgScore };
      });
      return { jobId: job.id, title: job.title, status: job.status, totalCandidates: jobCandidates.length, stages: stageStats };
    });
    res.json({ ok: true, stats });
  } catch (e) { res.status(500).json({ ok: false, message: _safeErrMsg(e) }); }
});

// ── Reset All Data ────────────────────────────────────────────────────────────
// 전체 데이터 삭제라는 파괴적 동작을 비밀번호 검증만으로 허용하는데 rate limit이 없어
// 무제한 비밀번호 추측이 가능했다(실측 확인) — /login과 동일한 loginLimiter 적용.
// Postgres/SaaS 모드: verifyCredentials가 이제 회사 스코프라 이 라우트도 companyId가
// 필요하다(이미 로그인된 세션의 토큰에서 우선 가져오고, 없으면 body의 companyCode로
// 보조 — /api/auth/2fa/generate-secret과 동일한 패턴). 삭제 자체도 반드시 그 회사의
// employees/kpi_entries만 지우도록 company_id로 필터한다 — 예전에는 회사 구분이 없어
// "전체 데이터 삭제"가 정말 DB 전체(모든 회사)를 지웠는데, 멀티테넌트에서 그대로 두면
// 한 회사의 admin이 자기 비밀번호만으로 다른 모든 회사의 데이터까지 지울 수 있는 셈이라
// 반드시 회사 범위로 좁혀야 한다. annual_snapshots는 company_id 컬럼을 갖고 있지만
// (schema.sql 참고), "전체 초기화"는 현재 진행중인 업무 데이터를 지우는 기능이지 이미
// 확정된 연도별 아카이브까지 지우는 기능이 아니므로 의도적으로 건드리지 않는다 — 예전
// 동작과 달리 이제 reset-all은 스냅샷을 지우지 않는다.
app.post("/api/reset-all", loginLimiter, async (req, res) => {
  res.locals.loginOk = false;
  try {
    const { loginId, pw, companyCode } = req.body || {};
    const companyId = USE_JSON_FILE ? null : (req.auth?.companyId || await _resolveCompanyId(companyCode));
    const admin = await verifyCredentials(companyId, loginId, pw);
    if (!admin || admin.role !== "admin")
      return res.status(403).json({ ok: false, message: "관리자 인증이 필요합니다." });
    res.locals.loginOk = true;
    if (USE_JSON_FILE) {
      _fileStore = { employees: [], kpiEntries: [] };
      _fileSnapshots = {};
      _fileHistory = { employees: [], kpi: [] };
      _setVersion(null, 0);
      await persistData(_fileStore);
      const snapFile = JSON_FILE.replace(/\.json$/, "-snapshots.json");
      await fs.promises.writeFile(snapFile, JSON.stringify({}, null, 2), "utf8");
      const histFile = JSON_FILE.replace(/\.json$/, "-history.json");
      await fs.promises.writeFile(histFile, JSON.stringify({ employees: [], kpi: [] }, null, 2), "utf8");
    } else {
      // "전체 초기화"가 employees/kpi_entries(및 이력)만 지우고 app_collections/
      // app_singletons(approvalDocs·attendanceRecords·settings·orgDB 등 GENERIC_LIST_FIELDS/
      // SINGLETON_FIELDS 전체, lib/collections.js 참고)는 그대로 남겨두고 있었다
      // (2026-08-19 외부 감사 P1). JSON 파일 모드는 `_fileStore = {employees:[],
      // kpiEntries:[]}`로 이 필드들이 전부 같은 객체의 속성이라 자연스럽게 함께 비워지는데,
      // Postgres 모드는 이 필드들이 별도 테이블에 있어 빠져 있었던 것 — 초기화 직후에도
      // 이전 결재문서·근태기록 등이 서버에 그대로 남아 있다가 다음 조회 시 되살아나는
      // 것처럼 보였다. accounting/ERP/PMS/채용/budget_store는 이 버튼의 기존 범위 밖(JSON
      // 파일 모드도 별도 파일이라 건드리지 않음)이라 그대로 유지한다. 여러 테이블에 걸친
      // 파괴적 삭제라 중간 실패 시 절반만 지워진 상태로 남지 않도록 트랜잭션으로 묶는다.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM kpi_history WHERE company_id = $1", [companyId]);
        await client.query("DELETE FROM employee_history WHERE company_id = $1", [companyId]);
        await client.query("DELETE FROM kpi_entries WHERE company_id = $1", [companyId]);
        await client.query("DELETE FROM employees WHERE company_id = $1", [companyId]);
        await client.query("DELETE FROM app_collections WHERE company_id = $1", [companyId]);
        await client.query("DELETE FROM app_singletons WHERE company_id = $1", [companyId]);
        await client.query("DELETE FROM app_meta WHERE key = $1", [`data_version:${_scopeKey(companyId)}`]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      _setVersion(companyId, 0);
    }
    console.log(`[Reset] Company data cleared (companyId=${companyId || "(json-file/global)"})`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: _safeErrMsg(e) });
  }
});

// ── Fallback SPA ──────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Local IP helper ───────────────────────────────────────────────────────────
function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

// ── Start ─────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    const server = app.listen(PORT, "0.0.0.0", () => {
      const localIPs = getLocalIPs();
      console.log("\n╔══════════════════════════════════════════════╗");
      console.log("║      HR 인사평가 시스템 서버 시작됨          ║");
      console.log("╠══════════════════════════════════════════════╣");
      console.log(`║  저장 방식: ${USE_JSON_FILE ? "JSON 파일 (오프라인)" : "PostgreSQL (DB)  "}      ║`);
      // 버전은 이제 회사별로 분리돼 있어(멀티테넌트) 배너에는 단일 스칼라 대신 추적 중인
      // 스코프(회사) 수를 보여준다. JSON 파일 모드는 여전히 하나의 전역 버전뿐이다.
      const versionLabel = USE_JSON_FILE ? String(_getVersion(null)) : `회사 ${_versionState.size}개 추적 중`;
      console.log(`║  데이터 버전: ${versionLabel.padEnd(31)}║`);
      console.log("╠══════════════════════════════════════════════╣");
      console.log(`║  이 PC에서 접속:                             ║`);
      console.log(`║    http://localhost:${PORT}                     ║`);
      if (localIPs.length) {
        console.log(`║                                              ║`);
        console.log(`║  같은 네트워크(Wi-Fi)의 다른 기기에서 접속: ║`);
        localIPs.forEach(ip => {
          const url = `http://${ip}:${PORT}`.padEnd(44);
          console.log(`║    ${url}║`);
        });
      }
      console.log("╚══════════════════════════════════════════════╝\n");
      if (USE_JSON_FILE) {
        console.log(`[저장 파일] ${JSON_FILE}`);
        console.log("[안내] 서버를 종료해도 데이터는 파일에 보존됩니다.\n");
      }
      // budget.js(사업계획/예산)는 Postgres/SaaS 모드에서도 여전히 파일 기반(budget-data.json)이라,
      // 이 경로가 영속 디스크를 안 가리키면 코드 재배포(컨테이너 재빌드)마다 사업계획 데이터
      // 전체가 초기화된다 — 사용자가 실제로 겪은 사고(작성 중이던 사업계획이 배포 후 사라짐)의
      // 원인. render.yaml처럼 DATA_FILE을 영속 디스크 경로로 지정해두고도 BUDGET_DATA_FILE을
      // 빠뜨리기 쉬워 기동 로그에 항상 경고를 남긴다.
      if (!process.env.BUDGET_DATA_FILE) {
        console.log("⚠️  [경고] BUDGET_DATA_FILE 환경변수가 설정되지 않았습니다 — 사업계획/예산 데이터(budget-data.json)가 영속 디스크가 아닌 앱 소스 경로에 저장되어, 코드 재배포(재빌드)마다 초기화됩니다.");
        console.log("    render.yaml의 envVars에 BUDGET_DATA_FILE=<DATA_FILE과 동일한 영속 디스크 경로>/budget-data.json 을 추가하세요.\n");
      }
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`\n[오류] 포트 ${PORT}가 이미 사용 중입니다.`);
        console.error(`다른 포트를 사용하려면: PORT=3001 node server.js\n`);
      } else {
        console.error("[오류]", err.message);
      }
      process.exit(1);
    });
  })
  .catch((err) => {
    console.error("[치명적 오류] 서버 초기화 실패:", err.message);
    process.exit(1);
  });
