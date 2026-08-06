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
function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  req.auth = verifyToken(token);
  next();
}
function requireAuth(req, res) {
  if (!req.auth) {
    res.status(401).json({ ok: false, message: "로그인이 필요합니다." });
    return false;
  }
  return true;
}

// ── Storage mode ──────────────────────────────────────────────────────────────
// When DATABASE_URL is not set, persist everything to a local JSON file.
const USE_JSON_FILE = !process.env.DATABASE_URL;
const JSON_FILE     = process.env.DATA_FILE || path.join(__dirname, "hr-data.json");

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
function stripPwField(data) {
  if (!data || !Array.isArray(data.employees)) return data;
  return { ...data, employees: data.employees.map(({ pw, twoFactorSecret, ...rest }) => rest) };
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
function _refToEmpIdsServer(ref, employees) {
  if (typeof ref === "number") return [ref];
  if (typeof ref !== "string") return [];
  if (/^\d+$/.test(ref)) return [Number(ref)];
  if (ref.startsWith("emp:")) return [Number(ref.slice(4))];
  if (ref.startsWith("dept:")) { const d = ref.slice(5); return employees.filter(e => e.active && e.dept === d).map(e => e.id); }
  if (ref.startsWith("team:")) { const [d, t] = ref.slice(5).split("::"); return employees.filter(e => e.active && e.dept === d && e.team === t).map(e => e.id); }
  return [];
}
function _refsToVisibleEmpIdsServer(refs, employees) {
  const direct = [], group = [];
  (refs || []).forEach(ref => {
    const isGroup = typeof ref === "string" && (ref.startsWith("dept:") || ref.startsWith("team:"));
    (isGroup ? group : direct).push(..._refToEmpIdsServer(ref, employees));
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
    out.coreTalentPool = out.coreTalentPool.filter(p => p && String(p.empId) === myId);
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
      if (_refsToVisibleEmpIdsServer(d.receivers, employees).map(String).includes(myId)) return true;
      if (_refsToVisibleEmpIdsServer(d.cc, employees).map(String).includes(myId)) return true;
      return false;
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
let _activityLog = [];
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
async function persistData(data, changedBy = "system", companyId = null) {
  return _withSaveLock(() => _persistDataLocked(data, changedBy, companyId));
}
async function _persistDataLocked(data, changedBy = "system", companyId = null) {
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
    const employees = await Promise.all((data.employees || []).map(async (rawEmp) => {
      const ex = existingById[rawEmp.id];
      const oldTs = ex ? (ex.updatedAt || ex.createdAt || "") : "";
      const newTs = rawEmp.updatedAt || rawEmp.createdAt || "";
      const changed = !ex || newTs > oldTs;
      let pw = rawEmp.pw;
      if (!changed) pw = ex.pw;
      else if (pw == null || pw === "") pw = ex?.pw;
      else pw = await hashPlaintextPw(pw);
      const emp = { ...rawEmp, pw };
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
    const approvalDocsFinal       = _mergeProtectedField("approvalDocs");
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
    for (const rawEmp of (data.employees || [])) {
      if (!rawEmp.id) continue;
      const { rows } = await client.query(
        "SELECT data, company_id FROM employees WHERE id = $1", [rawEmp.id]
      );
      if (rows.length && companyId && rows[0].company_id && rows[0].company_id !== companyId) continue;
      if (rows.length === 0) {
        let pw = rawEmp.pw;
        if (pw != null && pw !== "") pw = await hashPlaintextPw(pw);
        const emp = { ...rawEmp, pw };
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
          if (pw == null || pw === "") pw = rows[0].data.pw;
          else pw = await hashPlaintextPw(pw);
          const emp = { ...rawEmp, pw };
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
          await client.query(
            `INSERT INTO app_collections (collection, id, company_id, data, updated_at) VALUES ($1,$2,$3,$4,NOW())
             ON CONFLICT (company_id, collection, id) DO UPDATE SET data = $4, updated_at = NOW()`,
            [field, String(item.id), companyId, JSON.stringify(item)]
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

function addActivityLog(entry) {
  _activityLog.unshift({ ...entry, id: Date.now() + Math.random(), ts: new Date().toISOString() });
  if (_activityLog.length > MAX_ACTIVITY_LOGS)
    _activityLog = _activityLog.slice(0, MAX_ACTIVITY_LOGS);
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
app.use("/api/budget", budgetRouterFactory({ getEmployeeProfile: getEmployeeProfileForBudget, getTeamDept: getTeamDeptForBudget, getExpenseAccounts: getExpenseAccountsForBudget }));

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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// GET /data
app.get("/data", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const companyId = req.auth.companyId || null;
    const data = await loadData(companyId);
    res.json({ ok: true, data: filterDataForRole(stripPwField(data), req.auth), version: _getVersion(companyId) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// POST /api/employees/next-id — see _getNextEmployeeId() for why this exists.
app.post("/api/employees/next-id", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    res.json({ ok: true, id: await _getNextEmployeeId() });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
    const token = signToken({ empId: employee.id, loginId: employee.loginId, role: employee.role, companyId });
    res.locals.loginOk = true;
    res.json({ ok: true, employee, token });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 2) verify-code: 설정 확인 및 로그인 화면에서의 순수 코드 검증(상태 없음)에 공용으로 사용
app.post("/api/auth/2fa/verify-code", async (req, res) => {
  try {
    const { secret, otp } = req.body || {};
    if (!secret || !otp) return res.status(400).json({ ok: false, message: "secret과 otp가 필요합니다." });
    res.json({ ok: totpVerify(secret, otp) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
        careers: [], hrHistory: [], gradeResults: {}, createdAt: now, updatedAt: now,
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
      const token = signToken({ empId: adminEmp.id, loginId: adminEmp.loginId, role: adminEmp.role, companyId: company.id });
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
    res.status(500).json({ ok: false, message: e.message });
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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

// POST /save
app.post("/save", async (req, res) => {
  // Postgres/SaaS 모드는 항상 인증 필수(부트스트랩 예외 폐기, 위 주석 참고).
  // JSON 파일 모드만 기존 부트스트랩 흐름(직원 0명일 때 1회 무인증 허용)을 그대로 유지한다.
  const bootstrapExempt = USE_JSON_FILE && await _employeesEmpty();
  if (!bootstrapExempt && !requireAuth(req, res)) return;
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
    const { finalData, merged, duplicateLoginIds } = await _withSaveLock(async () => {
      let finalData = clientData;
      let merged    = false;

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
        const serverData = await loadData(companyId);
        finalData = smartMerge(serverData, clientData);
        merged    = true;
      }

      // changedBy는 원래부터 클라이언트가 보낸 문자열을 그대로 신뢰하는 필드였다(req.auth
      // 기반이 아님 — 기존 설계, 이번 작업 범위 밖). 다만 이 저장이 마스터 impersonation
      // 토큰(actingAsMaster가 실린 토큰, POST /master/companies/:id/impersonate 참고)으로
      // 이뤄졌다면, 클라이언트가 보낸 _user 값이 "관리자"처럼 평범해 보여도 employee_history/
      // kpi_history에는 실제로 마스터가 대신 쓴 것임을 남겨야 한다(계획 문서: impersonation으로
      // 이뤄진 쓰기 작업도 감사 대상). master_audit_log가 impersonate 발급 자체는 이미 기록하므로,
      // 여기서는 그 토큰으로 실제 어떤 저장이 일어났는지를 기존 변경이력에 얹기만 한다.
      const rawChangedBy = req.query.user || clientData._user || "unknown";
      const changedBy = req.auth?.actingAsMaster ? `master:${req.auth.actingAsMaster} as ${rawChangedBy}` : rawChangedBy;
      const { duplicateLoginIds } = await _persistDataLocked(finalData, changedBy, companyId);
      return { finalData, merged, duplicateLoginIds };
    });

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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// GET /events — SSE
app.get("/events", (req, res) => {
  // 브라우저 내장 EventSource는 커스텀 헤더(Authorization)를 붙일 수 없어 다른 라우트처럼
  // requireAuth를 그대로 쓸 수 없다 — 그래서 인증 자체가 아예 없었고, 로그인하지 않은
  // 상태로도 실시간 이벤트(잠금 상태에 포함된 편집자 이름, 접속/이탈 이벤트의 사용자명 등)를
  // 그대로 구독할 수 있었다. SSE에서 흔히 쓰는 방식대로 토큰을 쿼리스트링으로 전달받아
  // authenticate 미들웨어와 동일한 verifyToken()으로 검증한다.
  const auth = req.auth || verifyToken(req.query.token);
  if (!auth) return res.status(401).json({ ok: false, message: "로그인이 필요합니다." });
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
app.post("/log", (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!req.body) return res.status(400).json({ ok: false });
  addActivityLog(req.body);
  res.json({ ok: true });
});

// GET /activity
app.get("/activity", (req, res) => {
  // "activity-log" 페이지는 PAGE_ROLES상 admin 전용인데 requireAuth만 있어 member 토큰으로도
  // 자유텍스트 target/detail이 담긴 활동 로그를 조회할 수 있었다(실측 확인).
  if (!requireAdmin(req, res)) return;
  const limit = parseInt(req.query.limit) || 300;
  res.json({ ok: true, logs: _activityLog.slice(0, limit) });
});

// ── Annual snapshots ──────────────────────────────────────────────────────────

// ── Snapshot helpers for JSON file mode ──────────────────────────────────────
function _saveFileSnapshots() {
  // Persist snapshots alongside the main data file
  const snapFile = JSON_FILE.replace(/\.json$/, "-snapshots.json");
  fs.writeFileSync(snapFile, JSON.stringify(_fileSnapshots, null, 2), "utf8");
}

// ── Change history helpers for JSON file mode (audit trail) ──────────────────
function _recordFileHistory(kind, id, action, changedBy, data) {
  const list = _fileHistory[kind];
  list.push({ id: `${kind}_${list.length + 1}`, [kind === "employees" ? "employee_id" : "kpi_id"]: id, action, changed_by: changedBy, changed_at: new Date().toISOString(), data });
  if (list.length > MAX_FILE_HISTORY) list.splice(0, list.length - MAX_FILE_HISTORY);
}
function _saveFileHistory() {
  const histFile = JSON_FILE.replace(/\.json$/, "-history.json");
  fs.writeFileSync(histFile, JSON.stringify(_fileHistory, null, 2), "utf8");
}

// GET /snapshots — list all annual snapshots
app.get("/snapshots", async (req, res) => {
  // "history" 페이지는 admin 전용이고, 목록 응답에도 admin이 입력한 notes(대외비 메모 등)가
  // 포함돼 있어 /snapshots/:year와 동일하게 requireAdmin으로 승격한다.
  if (!requireAdmin(req, res)) return;
  try {
    if (USE_JSON_FILE) {
      const snaps = Object.entries(_fileSnapshots).map(([y, s]) => ({
        eval_year: parseInt(y), emp_count: s.empCount, kpi_count: s.kpiCount,
        confirmed_by: s.confirmedBy, confirmed_at: s.createdAt, notes: s.label,
      })).sort((a, b) => b.eval_year - a.eval_year);
      return res.json({ ok: true, snapshots: snaps });
    }
    const { rows } = await pool.query(
      "SELECT id, eval_year, emp_count, kpi_count, confirmed_by, confirmed_at, notes FROM annual_snapshots ORDER BY eval_year DESC"
    );
    res.json({ ok: true, snapshots: rows });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// Every top-level field a full snapshot can contain, in the order they're
// listed for the "선택 복원" (partial restore) UI.
const SNAPSHOT_FIELDS = ["employees", "kpiEntries", ...GENERIC_LIST_FIELDS, ...SINGLETON_FIELDS];

// Summarizes which fields a snapshot actually has data for, with a record
// count for array fields, so the client can offer a "필요한 부분만 복원" picker.
function describeSnapshotFields(snapshotData) {
  return SNAPSHOT_FIELDS
    .filter(f => snapshotData[f] !== undefined)
    .map(f => ({ field: f, count: Array.isArray(snapshotData[f]) ? snapshotData[f].length : undefined }));
}

// POST /snapshots — create a full-DB confirmed snapshot, tagged by year
// 주의(알려진 한계): annual_snapshots 테이블 자체는 아직 company_id가 없다(계획 문서
// 6단계 예정 — budget.js와 함께 Postgres 이전 대상). loadData(companyId)가 반환하는
// employees/kpiEntries/app_collections/app_singletons 유래 필드는 전부(2단계, 2026-07-21
// 완료) 이 회사로 스코프된 데이터라 스냅샷 *내용물*은 정확히 이 회사 것만 담긴다 — 다만
// annual_snapshots 자체가 company_id 없이 eval_year 단독 PK(`ON CONFLICT (eval_year)`)라서,
// 두 회사가 같은 연도에 스냅샷을 만들면 서로의 스냅샷 행을 덮어쓰는 문제는 여전히 남아있다
// (내용물 유출은 아니고, 스냅샷 자체가 통째로 교체되는 가용성 문제 — 6단계에서 해결 예정).
app.post("/snapshots", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { year = new Date().getFullYear(), confirmedBy = "admin", notes = "" } = req.body || {};
  try {
    const data = await loadData(req.auth.companyId);
    const yr = parseInt(year);
    const empCount = (data.employees || []).length;
    const kpiCount = (data.kpiEntries || []).length;
    if (USE_JSON_FILE) {
      _fileSnapshots[yr] = { data, empCount, kpiCount, confirmedBy, label: notes || `${yr}년 확정 스냅샷`, createdAt: new Date().toISOString() };
      _saveFileSnapshots();
      return res.json({ ok: true, year: yr, empCount, kpiCount });
    }
    await pool.query(
      `INSERT INTO annual_snapshots (eval_year, snapshot_data, emp_count, kpi_count, confirmed_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (eval_year) DO UPDATE
         SET snapshot_data = $2, emp_count = $3, kpi_count = $4,
             confirmed_by = $5, confirmed_at = NOW(), notes = $6`,
      [yr, JSON.stringify(data), empCount, kpiCount, confirmedBy, notes]
    );
    res.json({ ok: true, year: yr, empCount, kpiCount });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
      "SELECT * FROM annual_snapshots WHERE eval_year = $1", [yr]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: "스냅샷 없음" });
    res.json({ ok: true, snapshot: { ...rows[0], snapshot_data: stripPwField(rows[0].snapshot_data), fields: describeSnapshotFields(rows[0].snapshot_data) } });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── Backups (alias → snapshots, backward compat with existing frontend) ───────

// GET /backups
app.get("/backups", async (req, res) => {
  // /snapshots의 별칭이며 동일하게 admin이 입력한 label(=notes)이 포함돼 있어 동일 기준 적용.
  if (!requireAdmin(req, res)) return;
  try {
    if (USE_JSON_FILE) {
      const backups = Object.entries(_fileSnapshots).map(([y, s]) => ({
        name: `snapshot_${y}.json`, label: s.label, type: "annual",
        createdAt: s.createdAt, empCount: s.empCount, kpiCount: s.kpiCount,
      })).sort((a, b) => b.name.localeCompare(a.name));
      return res.json({ ok: true, backups });
    }
    const { rows } = await pool.query(
      "SELECT id, eval_year, emp_count AS \"empCount\", kpi_count AS \"kpiCount\", confirmed_by, confirmed_at AS \"createdAt\", notes FROM annual_snapshots ORDER BY eval_year DESC"
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// POST /backups/create — create a full-DB snapshot for the current year
app.post("/backups/create", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { label = "수동 스냅샷", type = "manual" } = req.body || {};
  const year = parseInt(req.body.year || new Date().getFullYear());
  try {
    const data = await loadData(req.auth.companyId);
    if (!data.employees.length && !data.kpiEntries.length)
      return res.status(404).json({ ok: false, message: "데이터 없음" });

    const empCount = data.employees.length;
    const kpiCount = (data.kpiEntries || []).length;
    if (USE_JSON_FILE) {
      _fileSnapshots[year] = { data, empCount, kpiCount, confirmedBy: "admin", label, createdAt: new Date().toISOString() };
      _saveFileSnapshots();
      return res.json({ ok: true, name: `snapshot_${year}.json` });
    }
    await pool.query(
      `INSERT INTO annual_snapshots (eval_year, snapshot_data, emp_count, kpi_count, confirmed_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (eval_year) DO UPDATE
         SET snapshot_data = $2, emp_count = $3, kpi_count = $4,
             confirmed_by = $5, confirmed_at = NOW(), notes = $6`,
      [year, JSON.stringify(data), empCount, kpiCount, "admin", label]
    );
    res.json({ ok: true, name: `snapshot_${year}.json` });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

async function loadSnapshotData(year) {
  if (USE_JSON_FILE) {
    const s = _fileSnapshots[year];
    return s ? s.data : null;
  }
  const { rows } = await pool.query("SELECT snapshot_data FROM annual_snapshots WHERE eval_year = $1", [year]);
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

    const snapshotData = await loadSnapshotData(yr);
    if (!snapshotData) return res.status(404).json({ ok: false, message: "스냅샷 없음" });
    const current = await loadData(req.auth.companyId);

    const diff = fields.map(f => {
      const extraIds = extraIdsNotInSnapshot(current[f], snapshotData[f]);
      return { field: f, extraCount: extraIds.length, extraIds };
    });
    res.json({ ok: true, diff });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
    const snapshotData = await loadSnapshotData(year);
    if (!snapshotData) return res.status(404).json({ ok: false, message: "스냅샷 없음" });

    const current = await loadData(companyId);
    const targetFields = fields || describeSnapshotFields(snapshotData).map(f => f.field);
    const dataToPersist = { ...current };
    const restoredFields = [];
    const extrasByField = {};
    for (const f of targetFields) {
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

    await persistData(dataToPersist, req.body.user || "restore", companyId);

    // persistData only ever inserts/updates; explicitly delete the extras
    // here when the caller opted into a true point-in-time restore.
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

    const finalData = await loadData(companyId);
    broadcastSSE("data_restored", { name, fields: restoredFields, deletedExtras: deleteExtras, version: _getVersion(companyId) }, null, companyId);
    res.json({ ok: true, version: _getVersion(companyId), restoredFields, deletedExtras: deleteExtras, data: filterDataForRole(stripPwField(finalData), req.auth) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── Accounting module (계정과목 / 전표 / 세금계산서) ──────────────────────────
// Unlike employees/kpiEntries (client computes full state, server merges),
// this module is server-authoritative: the server assigns sequential numbers,
// validates 차변/대변 balance, and makes posted/issued records immutable.
// JSON file mode keeps everything in `_fileAccounting`; PostgreSQL mode uses
// dedicated tables (see schema.sql).

function _saveFileAccounting() {
  const acctFile = JSON_FILE.replace(/\.json$/, "-accounting.json");
  fs.writeFileSync(acctFile, JSON.stringify(_fileAccounting, null, 2), "utf8");
}
function _saveFileAcctRcps() {
  const rcpsFile = JSON_FILE.replace(/\.json$/, "-rcps.json");
  fs.writeFileSync(rcpsFile, JSON.stringify(_fileAcctRcps, null, 2), "utf8");
}
function _saveFileAcctFixedAssets() {
  const faFile = JSON_FILE.replace(/\.json$/, "-fixedassets.json");
  fs.writeFileSync(faFile, JSON.stringify(_fileAcctFixedAssets, null, 2), "utf8");
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// 기본 계정과목 일괄등록 — DEFAULT_ACCOUNTS(급여/복리후생비/여비교통비 등 일반적으로
// 쓰는 계정)는 신규 회사 가입 시 자동 시딩되지만, 그 이전부터 있던 회사는 이 목록이
// 확장돼도 소급 적용되지 않는다. code가 아직 없는 항목만 추가해 기존 계정과목을
// 덮어쓰지 않는다(이미 같은 code로 직접 만들어 쓰고 있는 회사는 그대로 유지).
app.post("/api/accounting/accounts/seed-defaults", async (req, res) => {
  if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/accounts", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
      const prevHist = idx >= 0 ? (_fileAccounting.accounts[idx].history || []) : [];
      const histEntry = { action: idx >= 0 ? "update" : "create", user: user || "unknown", at: new Date().toISOString() };
      const acc = { id: accId, code, name, type, category: category || "", costCategory, costSubType, active, history: [...prevHist, histEntry] };
      if (idx >= 0) _fileAccounting.accounts[idx] = acc; else _fileAccounting.accounts.push(acc);
      _saveFileAccounting();
      return res.json({ ok: true, account: acc });
    }
    const companyId = req.auth.companyId || null;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/accounts/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 전표 (Journal vouchers) ──────────────────────────────────────────────────
async function _getAccountsList(companyId) {
  if (USE_JSON_FILE) return _fileAccounting.accounts;
  const { rows } = await pool.query(
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/vouchers/:id/post", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/vouchers/:id/void", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
      return res.json({ ok: true, voucher: v });
    }
    const { rows } = await pool.query("SELECT data FROM vouchers WHERE id = $1 AND status = 'posted' AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "확정된 전표만 취소할 수 있습니다." });
    const v = { ...rows[0].data, status: "void", voidReason: reason, voidedBy: req.body.user || "unknown", voidedAt: new Date().toISOString() };
    await pool.query("UPDATE vouchers SET status = 'void', data = $2, updated_at = NOW() WHERE id = $1", [id, v]);
    res.json({ ok: true, voucher: v });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.delete("/api/accounting/vouchers/:id", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/tax-invoices", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const { issueDate, partnerId, partnerName, partnerBizNo, items, user: createdBy } = req.body || {};
    if (!issueDate || !partnerName) return res.status(400).json({ ok: false, message: "발행일과 거래처명은 필수입니다." });
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/tax-invoices/:id/void", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.post("/api/accounting/payments", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.post("/api/accounting/payments/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;
    if (USE_JSON_FILE) {
      _fileAccounting.payments = (_fileAccounting.payments || []).filter(p => p.id !== id);
      _saveFileAccounting();
      return res.json({ ok: true });
    }
    const companyId = req.auth.companyId || null;
    await pool.query(
      "DELETE FROM app_collections WHERE collection = 'acctPayments' AND id = $1 AND (company_id = $2 OR $2 IS NULL)",
      [id, companyId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/partners/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  const accounts = await _getAccountsList(companyId);
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
  } catch (e) { res.status(e.statusCode || 500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/rcps/issuances/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(e.statusCode || 500).json({ ok: false, message: e.message }); }
  finally {
    if (lockedJsonMode) _rcpsSchedulePostInFlight.delete(scheduleId);
  }
});

app.post("/api/accounting/rcps/valuations", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(e.statusCode || 500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 고정자산 관리 (취득·감가상각·처분) ────────────────────────────────────────
// RCPS 모듈과 동일한 이유로 신규 기능(레거시 NULL 데이터 없음) — company_id NOT NULL.
// 감가상각 스케줄은 RCPS 상각표와 동일하게 등록 시점에 내용연수만큼 일괄 생성해 영속화하고,
// 이후 "상각전표 발행" 액션(연도 단위)으로 개별 확정한다. 동시발행 방지는 RCPS
// (rcps/schedule/:scheduleId/post)와 완전히 동일한 패턴(JSON모드: in-flight Set,
// Postgres모드: SELECT ... FOR UPDATE)을 재사용한다.
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
    const companyId = req.auth.companyId || null;
    const { name, assetNumber, category, acquisitionDate, acquisitionCost, usefulLifeYears, salvageValue, depreciationMethod, locationId, user } = req.body || {};
    if (!name || !acquisitionDate || !(Number(acquisitionCost) > 0) || !(Number(usefulLifeYears) > 0)) {
      return res.status(400).json({ ok: false, message: "자산명, 취득일, 취득원가(0보다 큼), 내용연수(0보다 큼)는 필수입니다." });
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
  } catch (e) { res.status(e.statusCode || 500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/fixed-assets/:id", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/fixed-assets/:id/dispose", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/fixed-assets/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(e.statusCode || 500).json({ ok: false, message: e.message }); }
  finally {
    if (lockedJsonMode) _faSchedulePostInFlight.delete(lockKey);
  }
});

// ── 영업/재고 모듈 (품목 / 위치 / 견적서 / 발주서 / 재고 입출고) ──────────────────
// 회계 모듈과 동일하게 서버-권위형: 번호 발급·상태 전환·발주 입고 시 재고 반영을
// 서버가 직접 처리한다. JSON 파일 모드는 `_fileErp`, PostgreSQL 모드는 전용 테이블 사용.

function _saveFileErp() {
  const erpFile = JSON_FILE.replace(/\.json$/, "-erp.json");
  fs.writeFileSync(erpFile, JSON.stringify(_fileErp, null, 2), "utf8");
}
function _saveFilePms() {
  const pmsFile = JSON_FILE.replace(/\.json$/, "-pms.json");
  fs.writeFileSync(pmsFile, JSON.stringify(_filePms, null, 2), "utf8");
}
function _saveFileRecruit() {
  const recruitFile = JSON_FILE.replace(/\.json$/, "-recruit.json");
  fs.writeFileSync(recruitFile, JSON.stringify(_fileRecruit, null, 2), "utf8");
}
function _nextErpSeq(kind, year) {
  if (!_fileErp[kind]) _fileErp[kind] = {};
  const next = (_fileErp[kind][year] || 0) + 1;
  _fileErp[kind][year] = next;
  return next;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/items", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/items/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
    const { rows } = await pool.query("SELECT 1 FROM erp_stock_ledger WHERE item_id = $1 AND (company_id = $2 OR company_id IS NULL) LIMIT 1", [id, companyId]);
    if (rows.length) return res.status(400).json({ ok: false, message: "재고 이력 또는 문서에서 사용 중인 품목은 삭제할 수 없습니다. 비활성화를 이용하세요." });
    await pool.query("UPDATE erp_items SET is_deleted = TRUE WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/locations", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/locations/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/quotations", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const { date, validUntil, partnerId, partnerName, locationId, items, memo, user: createdBy } = req.body || {};
    if (!date || !partnerName) return res.status(400).json({ ok: false, message: "견적일자와 거래처명은 필수입니다." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, message: "품목을 1개 이상 입력하세요." });
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/quotations/:id/send", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/quotations/:id/accept", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/quotations/:id/reject", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.delete("/api/erp/quotations/:id", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/purchase-orders", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const { date, deliveryDate, partnerId, partnerName, locationId, items, memo, user: createdBy } = req.body || {};
    if (!date || !partnerName) return res.status(400).json({ ok: false, message: "발주일자와 거래처명은 필수입니다." });
    if (!locationId) return res.status(400).json({ ok: false, message: "입고 위치를 선택하세요." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, message: "품목을 1개 이상 입력하세요." });
    if (items.some(it => !it.itemId)) return res.status(400).json({ ok: false, message: "모든 라인에 품목을 선택하세요." });
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/purchase-orders/:id/confirm", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/purchase-orders/:id/receive", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/purchase-orders/:id/cancel", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.delete("/api/erp/purchase-orders/:id", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/purchase-requests", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    const { date, items, memo, user: requestedBy } = req.body || {};
    if (!date) return res.status(400).json({ ok: false, message: "요청일자는 필수입니다." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, message: "품목을 1개 이상 입력하세요." });
    if (items.some(it => !it.itemId)) return res.status(400).json({ ok: false, message: "모든 라인에 품목을 선택하세요." });
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/purchase-requests/:id/approve", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/purchase-requests/:id/reject", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/purchase-requests/:id/convert-to-po", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.delete("/api/erp/purchase-requests/:id", async (req, res) => {
  if (!requireAuth(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/stock/adjust", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const { itemId, locationId, type, qty, memo, user } = req.body || {};
    if (!itemId || !locationId) return res.status(400).json({ ok: false, message: "품목과 위치를 선택하세요." });
    if (!["in", "out"].includes(type)) return res.status(400).json({ ok: false, message: "입고/출고 구분이 올바르지 않습니다." });
    const qtyNum = Math.abs(Number(qty) || 0);
    if (qtyNum <= 0) return res.status(400).json({ ok: false, message: "수량은 0보다 커야 합니다." });
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// 재고 실사: 여러 품목의 실사 수량을 한 번에 접수해 시스템 재고와의 차이만큼
// 조정 원장(refType:"count")을 생성한다. 차이가 0인 품목은 원장을 남기지 않는다.
app.post("/api/erp/stock/count", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const { locationId, lines, user } = req.body || {};
    if (!locationId || !Array.isArray(lines) || !lines.length)
      return res.status(400).json({ ok: false, message: "위치와 실사 항목이 필요합니다." });
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// 창고 간 이동: 출발 위치에서 출고(out)하고 도착 위치에 입고(in)하는 원장 쌍을 생성한다.
// 두 항목은 같은 transferId/refType:"transfer"로 묶여 이동 이력으로 함께 조회할 수 있다.
app.post("/api/erp/stock/transfer", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const { itemId, fromLocationId, toLocationId, qty, memo, user } = req.body || {};
    if (!itemId || !fromLocationId || !toLocationId) return res.status(400).json({ ok: false, message: "품목과 출발/도착 위치를 선택하세요." });
    if (fromLocationId === toLocationId) return res.status(400).json({ ok: false, message: "출발 위치와 도착 위치가 같을 수 없습니다." });
    const qtyNum = Math.abs(Number(qty) || 0);
    if (qtyNum <= 0) return res.status(400).json({ ok: false, message: "수량은 0보다 커야 합니다." });
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/sales-targets", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/sales-targets/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;
    if (USE_JSON_FILE) {
      _fileErp.salesTargets = _fileErp.salesTargets.filter(t => t.id !== id);
      _saveFileErp();
      return res.json({ ok: true });
    }
    await pool.query("UPDATE erp_sales_targets SET is_deleted = TRUE WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, req.auth.companyId || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PMS: 프로젝트 투입률 관리 (Projects / monthly allocation %) ────────────────
app.get("/api/pms/projects", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, projects: _filePms.projects });
    const { rows } = await pool.query(
      "SELECT id, data FROM pms_projects WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL) ORDER BY created_at DESC",
      [req.auth.companyId || null]
    );
    res.json({ ok: true, projects: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/pms/projects", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader"])) return;
    const companyId = req.auth.companyId || null;
    const { id, name, startDate, endDate, partnerId, pmId, status, memo, members, user: createdBy, userId: createdById } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, message: "프로젝트명은 필수입니다." });
    const projectId = id || `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    if (USE_JSON_FILE) {
      const existing = _filePms.projects.find(p => p.id === projectId);
      const project = {
        id: projectId, name, startDate: startDate || "", endDate: endDate || "",
        partnerId: partnerId || null, pmId: String(pmId || (existing ? existing.pmId : createdById) || ""),
        status: status || "active", memo: memo || "",
        members: Array.isArray(members) ? members.map(String) : (existing ? existing.members : []),
        createdBy: existing ? existing.createdBy : (createdBy || "unknown"),
        createdAt: existing ? existing.createdAt : now, updatedAt: now,
      };
      const idx = _filePms.projects.findIndex(p => p.id === projectId);
      if (idx >= 0) _filePms.projects[idx] = project; else _filePms.projects.push(project);
      _saveFilePms();
      return res.json({ ok: true, project });
    }
    const { rows } = await pool.query("SELECT data FROM pms_projects WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [projectId, companyId]);
    const existing = rows[0] ? rows[0].data : null;
    const project = {
      id: projectId, name, startDate: startDate || "", endDate: endDate || "",
      partnerId: partnerId || null, pmId: String(pmId || (existing ? existing.pmId : createdById) || ""),
      status: status || "active", memo: memo || "",
      members: Array.isArray(members) ? members.map(String) : (existing ? existing.members : []),
      createdBy: existing ? existing.createdBy : (createdBy || "unknown"),
      createdAt: existing ? existing.createdAt : now, updatedAt: now,
    };
    await pool.query(
      "INSERT INTO pms_projects (id, company_id, data) VALUES ($1,$2,$3) ON CONFLICT (company_id, id) DO UPDATE SET data = $3, updated_at = NOW()",
      [projectId, companyId, project]
    );
    res.json({ ok: true, project });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/pms/projects/:id", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader"])) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const { name, startDate, endDate, partnerId, pmId, status, memo, members } = req.body || {};
    if (USE_JSON_FILE) {
      const project = _filePms.projects.find(p => p.id === id);
      if (!project) return res.status(404).json({ ok: false, message: "프로젝트를 찾을 수 없습니다." });
      if (name != null) project.name = name;
      if (startDate != null) project.startDate = startDate;
      if (endDate != null) project.endDate = endDate;
      if (partnerId != null) project.partnerId = partnerId;
      if (pmId != null) project.pmId = String(pmId);
      if (status != null) project.status = status;
      if (memo != null) project.memo = memo;
      if (Array.isArray(members)) project.members = members.map(String);
      project.updatedAt = new Date().toISOString();
      _saveFilePms();
      return res.json({ ok: true, project });
    }
    const { rows } = await pool.query("SELECT data FROM pms_projects WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "프로젝트를 찾을 수 없습니다." });
    const project = { ...rows[0].data };
    if (name != null) project.name = name;
    if (startDate != null) project.startDate = startDate;
    if (endDate != null) project.endDate = endDate;
    if (partnerId != null) project.partnerId = partnerId;
    if (pmId != null) project.pmId = String(pmId);
    if (status != null) project.status = status;
    if (memo != null) project.memo = memo;
    if (Array.isArray(members)) project.members = members.map(String);
    project.updatedAt = new Date().toISOString();
    await pool.query("UPDATE pms_projects SET data = $2, updated_at = NOW() WHERE id = $1", [id, project]);
    res.json({ ok: true, project });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/pms/projects/:id/close", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader"])) return;
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    if (USE_JSON_FILE) {
      const project = _filePms.projects.find(p => p.id === id);
      if (!project) return res.status(404).json({ ok: false, message: "프로젝트를 찾을 수 없습니다." });
      project.status = "closed";
      project.updatedAt = new Date().toISOString();
      _saveFilePms();
      return res.json({ ok: true, project });
    }
    const { rows } = await pool.query("SELECT data FROM pms_projects WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)", [id, companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "프로젝트를 찾을 수 없습니다." });
    const project = { ...rows[0].data, status: "closed", updatedAt: new Date().toISOString() };
    await pool.query("UPDATE pms_projects SET data = $2, updated_at = NOW() WHERE id = $1", [id, project]);
    res.json({ ok: true, project });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

async function _pmsProjectById(projectId, companyId) {
  if (USE_JSON_FILE) return _filePms.projects.find(p => p.id === projectId) || null;
  const { rows } = await pool.query(
    "SELECT data FROM pms_projects WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL)", [projectId, companyId || null]
  );
  return rows[0] ? rows[0].data : null;
}

app.post("/api/pms/allocations", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { id, employeeId, year, month, projectId, percent, memo } = req.body || {};
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    if (!employeeId || !year || !month || !projectId) return res.status(400).json({ ok: false, message: "직원, 연도, 월, 프로젝트는 필수입니다." });
    const percentNum = Number(percent);
    if (isNaN(percentNum) || percentNum <= 0) return res.status(400).json({ ok: false, message: "투입률은 0보다 큰 숫자여야 합니다." });
    if (role !== "admin" && String(employeeId) !== String(userId)) return res.status(403).json({ ok: false, message: "본인 투입률만 등록할 수 있습니다." });
    if (id && role !== "admin") return res.status(403).json({ ok: false, message: "확정된 투입률은 관리자만 변경할 수 있습니다." });
    if (role !== "admin") {
      const project = await _pmsProjectById(projectId, companyId);
      if (!project || !(project.members || []).map(String).includes(String(employeeId))) {
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/pms/allocations/:id/delete", async (req, res) => {
  if (!requireAuth(req, res)) return;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// 직원별 일일 업무 투입(분단위 타임라인) — 본인 또는 admin만 등록 가능, 하루 24시간/겹침 검증
function _worklogBlocksValid(blocks) {
  if (!Array.isArray(blocks)) return "blocks 형식이 올바르지 않습니다.";
  const toMin = (t) => { const p = String(t || "").split(":"); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); };
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/pms/worklogs", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { employeeId, date, blocks } = req.body || {};
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    if (!employeeId || !date) return res.status(400).json({ ok: false, message: "직원, 날짜는 필수입니다." });
    if (role !== "admin" && String(employeeId) !== String(userId)) return res.status(403).json({ ok: false, message: "본인 업무 기록만 등록할 수 있습니다." });
    const err = _worklogBlocksValid(blocks || []);
    if (err) return res.status(400).json({ ok: false, message: err });
    if (role !== "admin") {
      for (const b of (blocks || [])) {
        const project = await _pmsProjectById(b.projectId, companyId);
        if (!project || !(project.members || []).map(String).includes(String(employeeId))) {
          return res.status(403).json({ ok: false, message: "투입 인원으로 등록된 프로젝트만 선택할 수 있습니다." });
        }
      }
    }
    const id = `wl_${employeeId}_${date}`;
    const record = { id, employeeId: String(employeeId), date, blocks, updatedAt: new Date().toISOString() };
    if (USE_JSON_FILE) {
      const idx = _filePms.worklogs.findIndex(w => w.id === id);
      if (idx >= 0) _filePms.worklogs[idx] = record; else _filePms.worklogs.push(record);
      _saveFilePms();
      return res.json({ ok: true, worklog: record });
    }
    await pool.query(
      "INSERT INTO pms_worklogs (id, employee_id, work_date, data, company_id) VALUES ($1,$2,$3,$4,$5) " +
      "ON CONFLICT (id) DO UPDATE SET data = $4, updated_at = NOW()",
      [id, Number(employeeId), date, record, companyId]
    );
    res.json({ ok: true, worklog: record });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 채용 관리: 채용공고 ────────────────────────────────────────────────────────
// company_id: 이 채용 모듈 helper들은 서로를 호출하며 얽혀 있어(job→emp→candidate→interview),
// 아래에서 회사 범위를 빠짐없이 관통시키지 않으면 부서 스코프 검사(_recruitCanViewJob 등)
// 이전에 다른 회사 데이터 자체가 조회돼버릴 수 있다 — companyId를 모든 helper의 첫/마지막
// 인자로 일관되게 추가한다.
async function _recruitAllEmployees(companyId) {
  if (USE_JSON_FILE) return _fileStore.employees || [];
  const { rows } = await pool.query(
    "SELECT data FROM employees WHERE is_deleted = FALSE AND (company_id = $1 OR company_id IS NULL)", [companyId || null]
  );
  return rows.map(r => r.data);
}
async function _recruitEmpById(empId, companyId) {
  const emps = await _recruitAllEmployees(companyId);
  return emps.find(e => String(e.id) === String(empId)) || null;
}
// 채용공고 열람 권한: 관리자, 등록자, 해당 부서 팀장/사업부장, 인사팀장, 관리자가 지정한 담당자
async function _recruitCanViewJob(job, userId, role, companyId) {
  if (!job) return false;
  if (role === "admin") return true;
  if (String(job.createdBy) === String(userId)) return true;
  if (Array.isArray(job.viewerIds) && job.viewerIds.map(String).includes(String(userId))) return true;
  const emp = await _recruitEmpById(userId, companyId);
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/jobs", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    const { id, title, department, team, headcount, stages, status, description, purpose, responsibilities, requiredYears, docFile, viewerIds, user: createdBy, userId: createdById } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, message: "채용공고 제목은 필수입니다." });
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/jobs/:id/close", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
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
    await pool.query("UPDATE recruit_jobs SET data = $2, updated_at = NOW() WHERE id = $1", [id, job]);
    res.json({ ok: true, job });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

async function _recruitJobById(jobId, companyId) {
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// 리스트 조회(_recruitVisibleCandidates)와 동일한 열람 권한 규칙을 단건 조회에도 적용한다.
// (과거엔 목록 API만 부서별 열람 제한이 걸려 있었고, id로 직접 조회하는 이 엔드포인트에는
// 아무 권한 검사가 없어 지원자 ID만 알면 타 부서 지원자 정보까지 그대로 열람 가능했음)
async function _recruitCanViewCandidate(candidate, userId, role, companyId) {
  if (!candidate) return false;
  if (!userId || !role || role === "admin") return true;
  const interviews = await _recruitAllInterviews(companyId);
  const isInterviewer = interviews.some(iv => String(iv.candidateId) === String(candidate.id) && (iv.interviewerIds || []).map(String).includes(String(userId)));
  if (isInterviewer) return true;
  const job = await _recruitJobById(candidate.jobId, companyId);
  return job ? await _recruitCanViewJob(job, userId, role, companyId) : false;
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.post("/api/recruit/extract-docx-text", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== "string") return res.status(400).json({ ok: false, message: "파일 데이터가 없습니다." });
    const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
    const buffer = Buffer.from(base64, "base64");
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    res.json({ ok: true, text: result.value || "" });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
    await client.query(`UPDATE ${table} SET data = $2, updated_at = NOW() WHERE id = $1`, [id, data]);
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
    const companyId = req.auth.companyId || null;
    const { jobId, name, email, phone, resume, memo, resumeSummary, strengths, weaknesses, finalEducation, careerHistory, lastSalary, desiredSalary, activities, careerGaps, user: createdBy } = req.body || {};
    if (!jobId || !name) return res.status(400).json({ ok: false, message: "채용공고, 지원자명은 필수입니다." });
    const job = await _recruitJobById(jobId, companyId);
    if (!job) return res.status(404).json({ ok: false, message: "채용공고를 찾을 수 없습니다." });
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/candidates/:id", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
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
      candidate = await _pgLockedUpdate("recruit_candidates", id, async (c) => {
        if (!(await _recruitCanViewCandidate(c, userId, role, companyId))) throw new _RecruitRouteError(403, "수정 권한이 없습니다.");
        return applyEdits(c);
      }, companyId);
    } catch (e) {
      if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: e.message });
      throw e;
    }
    res.json({ ok: true, candidate: _recruitStripResume(candidate) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/candidates/:id/status", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const id = req.params.id;
    const { role, empId: userId } = req.auth;
    const companyId = req.auth.companyId || null;
    const { status, reason } = req.body || {};
    if (!status) return res.status(400).json({ ok: false, message: "변경할 전형 단계는 필수입니다." });
    const RECRUIT_PASS_SCORE = 15;
    const checkReasonRequired = async (candidate, job) => {
      const stages = job.stages || [];
      const curIdx = stages.indexOf(candidate.status);
      const newIdx = stages.indexOf(status);
      if (newIdx <= curIdx) return false;
      const interviews = await _recruitAllInterviews(companyId);
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
      candidate = await _pgLockedUpdate("recruit_candidates", id, async (c) => {
        if (!(await _recruitCanViewCandidate(c, userId, role, companyId))) throw new _RecruitRouteError(403, "수정 권한이 없습니다.");
        const job = await _recruitJobById(c.jobId, companyId);
        if (!job || !job.stages.includes(status)) throw new _RecruitRouteError(400, "해당 채용공고에 없는 전형 단계입니다.");
        if (await checkReasonRequired(c, job) && !String(reason || "").trim()) {
          throw new _RecruitRouteError(400, "통과 기준 미만 점수로 다음 단계 진행 시 사유를 입력해야 합니다.");
        }
        c.status = status;
        c.statusReason = reason || "";
        c.updatedAt = new Date().toISOString();
        return c;
      }, companyId);
    } catch (e) {
      if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: e.message });
      throw e;
    }
    res.json({ ok: true, candidate });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 채용 관리: 면접 일정/평가 (1차·2차 구분, 면접관별 비공개 평가) ────────────────
const RECRUIT_SCORE_CATEGORIES = ["태도", "전문지식", "적극성", "의사소통능력", "조직적합성"];
// 면접 열람 권한: 관리자, 인사팀장, 면접 대상 채용공고를 볼 수 있는 등록자/담당자, 또는 본인이 면접관으로 지정된 경우
async function _recruitIsInterviewPrivileged(interview, userId, role, companyId) {
  if (role === "admin") return true;
  const job = await _recruitJobById(interview.jobId, companyId);
  if (job && await _recruitCanViewJob(job, userId, role, companyId)) return true;
  return false;
}
function _recruitFilterInterviewForViewer(interview, userId, privileged) {
  if (privileged) return interview;
  return { ...interview, evaluations: (interview.evaluations || []).filter(e => String(e.interviewerId) === String(userId)) };
}
async function _recruitAllInterviews(companyId) {
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/interviews", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const companyId = req.auth.companyId || null;
    const { jobId, candidateId, round, schedule, interviewerIds, location, leadInterviewerId } = req.body || {};
    if (!jobId || !candidateId || !round || !Array.isArray(interviewerIds) || !interviewerIds.length) {
      return res.status(400).json({ ok: false, message: "채용공고, 지원자, 면접 회차, 면접관은 필수입니다." });
    }
    const job = await _recruitJobById(jobId, companyId);
    if (!job) return res.status(404).json({ ok: false, message: "채용공고를 찾을 수 없습니다." });
    const id = `iv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const normInterviewerIds = interviewerIds.map(String);
    const interview = {
      id, jobId, candidateId, round: Number(round), schedule: schedule || "", location: location || "",
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/interviews/:id", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
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
      interview = await _pgLockedUpdate("recruit_interviews", id, async (iv) => {
        if (!(await _recruitIsInterviewPrivileged(iv, userId, role, companyId))) throw new _RecruitRouteError(403, "수정 권한이 없습니다.");
        return applyEdits(iv);
      }, companyId);
    } catch (e) {
      if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: e.message });
      throw e;
    }
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/interviews/:id/cancel", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
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
      interview = await _pgLockedUpdate("recruit_interviews", id, async (iv) => {
        if (!(await _recruitIsInterviewPrivileged(iv, userId, role, companyId))) throw new _RecruitRouteError(403, "취소 권한이 없습니다.");
        return applyCancel(iv);
      }, companyId);
    } catch (e) {
      if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: e.message });
      throw e;
    }
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/interviews/:id/evaluation", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const id = req.params.id;
    const companyId = req.auth.companyId || null;
    const { interviewerId, scores, comment } = req.body || {};
    const { role, empId: authUserId } = req.auth;
    if (!interviewerId || !scores || typeof scores !== "object") {
      return res.status(400).json({ ok: false, message: "면접관, 평가 점수는 필수입니다." });
    }
    // 각 면접관의 평가는 evaluations 배열 안 자기 interviewerId 항목만 upsert하는
    // 구조라, 여러 면접관이 거의 동시에 제출하면(락 없는 SELECT→mutate→UPDATE) 나중에
    // commit된 한 명의 평가만 남고 나머지는 조용히 사라졌다(실측: 10명 동시 제출 시
    // 1명만 생존) — interview row를 _pgLockedUpdate로 잠가 순번대로 처리한다.
    const applyEvaluation = async (interview) => {
      if (role !== "admin" && !interview.interviewerIds.map(String).includes(String(interviewerId))) {
        throw new _RecruitRouteError(403, "지정된 면접관만 평가를 입력할 수 있습니다.");
      }
      // interviewerId는 "누구의 평가로 기록할지"를 정하는 값이라 role만 검증해서는
      // 다른 지정 면접관 행세로 남의 평가를 덮어쓸 수 있었다 — 본인 명의로만 입력 가능해야 한다.
      if (role !== "admin" && String(interviewerId) !== String(authUserId)) {
        throw new _RecruitRouteError(403, "본인 명의로만 평가를 입력할 수 있습니다.");
      }
      const candidate = USE_JSON_FILE
        ? _fileRecruit.candidates.find(c => c.id === interview.candidateId)
        : (await pool.query("SELECT data FROM recruit_candidates WHERE id = $1 AND is_deleted = FALSE AND (company_id = $2 OR company_id IS NULL)", [interview.candidateId, companyId])).rows[0]?.data;
      const job = candidate ? await _recruitJobById(candidate.jobId, companyId) : null;
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
        if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: e.message });
        throw e;
      }
      _saveFileRecruit();
      return res.json({ ok: true, interview });
    }
    let interview;
    try {
      interview = await _pgLockedUpdate("recruit_interviews", id, applyEvaluation, companyId);
    } catch (e) {
      if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: e.message });
      throw e;
    }
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

const RECRUIT_VERDICTS = ["pass", "hold", "fail"];
app.post("/api/recruit/interviews/:id/verdict", async (req, res) => {
  if (!requireAuth(req, res)) return;
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
        if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: e.message });
        throw e;
      }
      _saveFileRecruit();
      return res.json({ ok: true, interview });
    }
    let interview;
    try {
      interview = await _pgLockedUpdate("recruit_interviews", id, async (iv) => applyVerdict(iv), companyId);
    } catch (e) {
      if (e instanceof _RecruitRouteError) return res.status(e.status).json({ ok: false, message: e.message });
      throw e;
    }
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/candidates/:id/delete", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
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
    await pool.query("UPDATE recruit_candidates SET is_deleted = TRUE WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
// 반드시 회사 범위로 좁혀야 한다. annual_snapshots는 아직 company_id가 없는 전역
// 테이블이라(알려진 한계, 계획 문서 6단계 예정) 이 회사 범위 삭제에서는 건드리지 않는다
// (다른 회사의 확정 스냅샷까지 함께 지워지는 걸 막기 위해 — 예전 동작과 달리 이제 reset-all은
// 스냅샷을 지우지 않는다).
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
      await pool.query("DELETE FROM kpi_history WHERE company_id = $1", [companyId]);
      await pool.query("DELETE FROM employee_history WHERE company_id = $1", [companyId]);
      await pool.query("DELETE FROM kpi_entries WHERE company_id = $1", [companyId]);
      await pool.query("DELETE FROM employees WHERE company_id = $1", [companyId]);
      await pool.query("DELETE FROM app_meta WHERE key = $1", [`data_version:${_scopeKey(companyId)}`]);
      _setVersion(companyId, 0);
    }
    console.log(`[Reset] Company data cleared (companyId=${companyId || "(json-file/global)"})`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
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
