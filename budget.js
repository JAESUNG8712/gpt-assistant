const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const xlsx = require('xlsx');
const pool = require('./db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// 메인 데이터(employees/kpi_entries)가 Postgres 모드(DATABASE_URL 설정)면 budget.js도
// 같은 기준으로 Postgres에 저장한다(budget_store 테이블, schema.sql 참고) — 이전에는
// DB 모드에서도 로컬 JSON 파일(budget-data.json)만 썼는데, Render 등 PaaS의 컨테이너
// 파일시스템은 재배포마다 초기화되고 영속 디스크(Persistent Disk)는 유료 플랜에서만
// 쓸 수 있어(2026-08-03 실사용자 확인 — 무료/스타터 플랜은 디스크 자체를 못 씀) 이
// 파일이 재배포마다 항상 사라지는 근본적인 한계가 있었다. DATABASE_URL이 없는
// 배포(자체호스팅/오프라인 단일회사 모드)는 기존과 동일하게 로컬 JSON 파일을 그대로 쓴다.
const USE_DB = !!process.env.DATABASE_URL;
// 파일 모드 폴백 경로 — server.js의 DATA_FILE(hr-data.json)과 동일한 패턴.
const BUDGET_FILE = process.env.BUDGET_DATA_FILE || path.join(__dirname, 'budget-data.json');
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const CATEGORIES = ['판관', '용역', '경상'];
// "조직별" 인원계획 시트의 메타 컬럼(부문/계정과목 구분용 컬럼 — 실제 항목명/값이 아닌
// 컬럼) 집합 — _parseSgaCostBlockRows()(비용 블록 파서)와 headcount-plan/upload
// 라우트(인원현황 파서) 양쪽이 "이 컬럼들 외에 값이 있는 컬럼이 있으면 그건 비용 블록의
// 이름표(급여/성과급 등)"라는 동일한 판별에 동일한 값 목록을 각자 따로 선언해 썼던 것을
// 하나로 통합(값 자체는 완전히 동일했음).
const KNOWN_ORG_SHEET_META_COLUMNS = new Set(['구분', '구분_1', '부문', '계정과목', '평균', ...MONTHS.map(m => `${m}월`)]);

// company_id 네임스페이스 (멀티테넌트 4단계): 이 라우터는 Postgres/SaaS 모드에서도
// budget-data.json 파일 하나를 그대로 쓰고 있어(다른 회계/ERP 모듈과 달리 전용 테이블이
// 없음), 회사 구분 없이 전 회사가 같은 파일을 공유해 예산 데이터가 그대로 섞여 있었다.
// 파일 최상위를 `{ [companyId]: { headcount, items, uploads } }` 구조로 바꾸고, 기존에
// 이미 데이터가 있던(회사 개념 도입 전) 평면 구조 파일은 읽는 시점에 자동으로 `_legacy`
// 키 아래로 감싸 마이그레이션한다 — 최상위에 headcount/items/uploads 배열이 직접 있으면
// 레거시 평면 구조로 간주한다(반대로 신형식은 최상위 값이 항상 companyId(UUID) 또는
// `_legacy` 키를 가진 객체이므로 이 두 형태는 구조적으로 겹치지 않는다). companyId가 없는
// 호출(JSON 파일/자체호스팅 단일회사 모드)도 동일하게 `_legacy` 키를 사용해, 회사 개념이
// 아예 없는 배포에서는 예전과 동일하게 단일 저장소로 계속 동작한다.
function _emptyCompanyBudget() {
  return {
    headcount: [], items: [], uploads: [], businessPlans: [],
    // 사업계획 워크플로우 전사 설정: 예산담당자(ownerIds, 전사 고정 다수 가능)와
    // 기획팀장(teamLeaderId, 전사 고정 1명)은 관리자만 지정 가능. inputOpen은 팀의
    // 사업계획 작성/수정 가능 여부를 제어하는 전사 단일 스위치로, 예산담당자·기획팀장·
    // 관리자 모두 켜고 끌 수 있다(사용자 요청).
    budgetPlanSettings: { ownerIds: [], teamLeaderId: null, inputOpen: true },
    // 개인별 급여 상세(계획용, 3단계 자료 연계의 1단계): 직원별·연도별로 판관비 표준
    // 항목(급여 세부/복리후생비/RSU 등) 각각의 연간 금액을 입력해두면, 사업계획 판관비
    // 그리드에서 팀 단위로 자동 합산해 채워 넣는 데 쓰인다. 실적(이미 지급된 급여)이
    // 아니라 계획 수립용 가정 데이터 — 실적은 별도로 budget.html의 판관/용역/경상 상세
    // 업로드를 통해 관리한다(요청서에 따라 계획/실적을 서로 다른 메뉴로 분리).
    empPayPlans: [],
    // 개인별 급여 상세 화면의 자동계산(퇴직급여 증가분, 4대보험+주민세)에 쓰이는 요율
    // 설정 — 회사마다, 그리고 매년 실제 요율이 달라지므로 하드코딩하지 않고 관리자가
    // 직접 입력/수정하도록 한다(기본값은 참고용 예시일 뿐 최신 고시 요율로 반드시
    // 확인 후 조정해야 함 — 화면에도 동일한 안내를 표시).
    // 월별 인원 계획(예측용) — budget.html의 기존 headcount(실적/현황 업로드)와는 별개로,
    // "사업계획" 롤업 화면에서 부문별 계획 인원을 확인하기 위한 데이터. 계정과목(판관/용역/
    // 경상)별로 나뉠 수도, 부문 전체 합계 한 줄일 수도 있다(category가 빈 값이면 미분류).
    headcountPlans: [],
    empPayPlanSettings: {
      severance: { dcRate: 8.33, dbMonthsPerYear: 1 }, // dcRate: DC형 연간 적립률(%, 기본값=1/12), dbMonthsPerYear: DB형 근속 1년당 인정 개월수
      socialInsurance: { pension: 4.5, health: 3.545, longTermCare: 12.95, employment: 0.9, localTax: 10 }, // %, longTermCare는 건강보험료 대비 %, 나머지는 급여 대비 %(간이) — 전부 회사부담분 기준
    },
  };
}

// 같은 손상된 내용을 프로세스 생애 동안 반복해서 백업 파일로 찍어내지 않기 위한
// 중복방지 캐시(sha1 해시 집합) — _readAllBudgetFile()은 매 호출(모든 읽기/쓰기 요청)마다
// 파일을 새로 읽으므로, 백업이 없으면 파일이 고쳐지기 전까지 요청마다 새 백업 파일이
// 쌓일 수 있다.
const _budgetCorruptionBackedUp = new Set();

function _readAllBudgetFile() {
  if (!fs.existsSync(BUDGET_FILE)) return {};
  let rawText;
  try {
    rawText = fs.readFileSync(BUDGET_FILE, 'utf8');
  } catch (e) {
    console.error('[budget] BUDGET_FILE을 읽을 수 없습니다:', e.message);
    return {};
  }
  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (e) {
    // 파일이 손상됐다(쓰는 도중 강제종료로 잘림, 수동 편집 실수 등) — 여기서 그냥
    // 빈 데이터({})만 반환하면, 호출자(updateBudget 등)가 그 "비어 보이는" 상태에 뭔가를
    // 저장하는 순간 _writeAllBudgetFile()이 이 상태를 그대로 새 파일에 써버려, 손상되기
    // 전까지 쌓여있던 모든 회사의 사업계획/예산/개인별 급여상세 데이터가 영구히 사라진다
    // (P2 — 사용자 보고: "손상되면 빈 데이터로 간주할 수 있어, 이후 저장에서 손상 전
    // 데이터를 덮어쓸 위험"). 다음 저장이 이 파일을 덮어쓰기 전에, 손상된 원본 바이트를
    // 타임스탬프가 붙은 별도 파일로 먼저 백업해둔다(수동 복구를 위한 최후의 수단 — 잘린/
    // 깨진 JSON에서 어디까지가 유효한 데이터인지 프로그램이 안전하게 자동 판단할 방법이
    // 없어 자동 복구는 시도하지 않는다).
    const contentHash = crypto.createHash('sha1').update(rawText).digest('hex');
    if (!_budgetCorruptionBackedUp.has(contentHash)) {
      _budgetCorruptionBackedUp.add(contentHash);
      const backupPath = `${BUDGET_FILE}.corrupted-${Date.now()}`;
      try {
        fs.writeFileSync(backupPath, rawText, 'utf8');
        console.error(`[budget] BUDGET_FILE JSON 파싱 실패 — 손상된 원본을 ${backupPath}에 백업하고 빈 데이터로 계속 진행합니다:`, e.message);
      } catch (backupErr) {
        console.error('[budget] BUDGET_FILE 손상 감지, 백업 시도도 실패:', backupErr.message, '/ 원래 오류:', e.message);
      }
    }
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  if (Array.isArray(raw.headcount) || Array.isArray(raw.items) || Array.isArray(raw.uploads)) {
    // 레거시 평면 구조 파일 — `_legacy` 네임스페이스로 감싸 마이그레이션.
    return { _legacy: { headcount: raw.headcount || [], items: raw.items || [], uploads: raw.uploads || [] } };
  }
  return raw;
}

function _writeAllBudgetFile(all) {
  // BUDGET_FILE의 상위 디렉토리가 없으면(디스크 마운트 지연·미설정 등) writeFileSync가
  // ENOENT를 던진다 — 2026-08-03 실제 운영 장애 원인(mkdir 없이 바로 write를 시도해
  // 디렉토리 부재 시 그대로 크래시). 매 쓰기 전에 디렉토리를 보장해 이 경로의 크래시를
  // 원천 차단한다(디스크가 정말 마운트되지 않은 경우엔 컨테이너 임시 파일시스템에라도
  // 디렉토리를 만들어 저장을 계속 진행 — 전체 서비스 중단보다는 나은 폴백).
  try { fs.mkdirSync(path.dirname(BUDGET_FILE), { recursive: true }); } catch (e) {}
  // 원자적 쓰기(tmp파일+rename) — 쓰는 도중 프로세스가 강제종료되면 직접 덮어쓰기는
  // 파일이 잘린 채 남아 다음 부팅 시 JSON.parse가 실패하고(_readAllBudgetFile의
  // catch로 빈 데이터로 되돌아감) 그 시점까지의 사업계획/예산 데이터가 유실될 수 있다
  // (server.js의 동일한 문제·수정과 같은 이유, kill -9로 재현 검증).
  const tmp = `${BUDGET_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
  fs.renameSync(tmp, BUDGET_FILE);
}

function _budgetKey(companyId) {
  return companyId || '_legacy';
}

// DB 모드에서 이 회사(key)의 행이 아직 없으면, 과거에 파일 모드로 저장된 데이터가
// 남아있는지(디스크가 없어져도 이번 컨테이너에 우연히 남아있거나, DATABASE_URL을
// 이번에 처음 설정한 경우 등) 1회성으로 확인해 있으면 그대로 옮겨온다 — 없으면 그냥
// 빈 데이터로 시작(파일이 아예 없거나 손상돼도 예외를 던지지 않고 조용히 무시).
async function _migrateFileToDbIfPresent(key) {
  let fileData;
  try {
    fileData = _readAllBudgetFile()[key];
  } catch (e) {
    return null;
  }
  if (!fileData) return null;
  await pool.query(
    'INSERT INTO budget_store (company_id, data) VALUES ($1,$2) ON CONFLICT (company_id) DO NOTHING',
    [key, JSON.stringify(fileData)]
  );
  return fileData;
}

// businessPlans/budgetPlanSettings 등은 여러 차례에 걸쳐 신설된 필드라, 그 이전에 이미
// 저장된 회사 데이터를 읽으면 undefined일 수 있다 — readBudget()/updateBudget() 양쪽이
// 공유하는 백필 로직.
function _fillBudgetDefaults(data) {
  if (!data) data = _emptyCompanyBudget();
  if (!Array.isArray(data.businessPlans)) data.businessPlans = [];
  if (!data.budgetPlanSettings || typeof data.budgetPlanSettings !== 'object') {
    data.budgetPlanSettings = { ownerIds: [], teamLeaderId: null, inputOpen: true };
  } else {
    if (!Array.isArray(data.budgetPlanSettings.ownerIds)) data.budgetPlanSettings.ownerIds = [];
    if (data.budgetPlanSettings.teamLeaderId === undefined) data.budgetPlanSettings.teamLeaderId = null;
    if (data.budgetPlanSettings.inputOpen === undefined) data.budgetPlanSettings.inputOpen = true;
  }
  if (!Array.isArray(data.empPayPlans)) data.empPayPlans = [];
  if (!Array.isArray(data.headcountPlans)) data.headcountPlans = [];
  if (!data.empPayPlanSettings || typeof data.empPayPlanSettings !== 'object') {
    data.empPayPlanSettings = {
      severance: { dcRate: 8.33, dbMonthsPerYear: 1 },
      socialInsurance: { pension: 4.5, health: 3.545, longTermCare: 12.95, employment: 0.9, localTax: 10 },
    };
  } else {
    if (!data.empPayPlanSettings.severance) data.empPayPlanSettings.severance = { dcRate: 8.33, dbMonthsPerYear: 1 };
    if (!data.empPayPlanSettings.socialInsurance) data.empPayPlanSettings.socialInsurance = { pension: 4.5, health: 3.545, longTermCare: 12.95, employment: 0.9, localTax: 10 };
  }
  return data;
}

// 읽기 전용 조회(GET 라우트)용 — 잠금 없이 현재 스냅샷만 읽는다.
async function readBudget(companyId) {
  const key = _budgetKey(companyId);
  let data;
  if (USE_DB) {
    const { rows } = await pool.query('SELECT data FROM budget_store WHERE company_id=$1', [key]);
    data = rows.length ? rows[0].data : await _migrateFileToDbIfPresent(key);
  } else {
    data = _readAllBudgetFile()[key];
  }
  return _fillBudgetDefaults(data);
}

// 읽기→수정→쓰기(POST/PUT/DELETE 라우트)용 — DB 모드에서 이 구간을 원자적으로 만든다.
// server.js의 _pgLockedUpdate와 동일한 패턴: 트랜잭션 안에서 SELECT ... FOR UPDATE로
// 그 회사의 행을 잠근 뒤 mutate 콜백을 실행하고 그 결과를 UPDATE, 전부 하나의 트랜잭션
// 안에서 커밋한다. budget.js가 로컬 JSON 파일을 쓰던 시절에는 read/write가 둘 다
// 동기 함수(fs.readFileSync/writeFileSync)라 그 사이에 await 지점이 전혀 없었고, Node의
// 단일 스레드 특성상 다른 요청이 끼어들 여지가 구조적으로 없어 저절로 원자적이었다 —
// Postgres로 옮기며 readBudget()/writeBudget()을 각각 독립된 비동기 함수로 분리한
// 순간, 그 사이(각 await 동안)에 다른 요청이 끼어들어 서로의 변경사항을 지우는
// lost-update 위험이 새로 생겼다(KPI/경비청구 등에서 여러 차례 발견된 것과 정확히
// 같은 버그 클래스 — CLAUDE.md 2026-07-19/07-20 참고). mutate는 (data) => 반환값
// 형태의 async 함수여야 하며, updateBudget()은 그 반환값을 그대로 돌려준다.
async function updateBudget(companyId, mutate) {
  const key = _budgetKey(companyId);
  if (!USE_DB) {
    // 파일 모드: 동기 read-mutate-write가 이미 원자적이므로 락 없이 그대로 재사용.
    const all = _readAllBudgetFile();
    const data = _fillBudgetDefaults(all[key]);
    const result = await mutate(data);
    all[key] = data;
    _writeAllBudgetFile(all);
    return result;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let { rows } = await client.query('SELECT data FROM budget_store WHERE company_id=$1 FOR UPDATE', [key]);
    let data;
    if (rows.length) {
      data = rows[0].data;
    } else {
      // 이 회사의 행이 아직 없다 — 과거 파일 데이터가 남아있으면 그걸로, 없으면 빈
      // 데이터로 최초 생성(락을 쥔 채로 안전하게 수행). ON CONFLICT DO NOTHING을 써서
      // 동시에 다른 요청이 먼저 같은 회사의 첫 행을 만드는 경우에도 에러 없이(일반
      // INSERT였다면 unique_violation을 던져 트랜잭션 전체가 abort 상태가 되고, 그
      // 안에서 catch 후 이어지는 쿼리마저 "current transaction is aborted"로 전부
      // 실패하는 문제가 있었음 — 실측으로 발견) 조용히 대기·통과하고, 뒤이은 SELECT
      // ... FOR UPDATE가 (내가 만들었든 상대가 먼저 만들었든) 항상 존재하는 행을
      // 잠가서 가져온다.
      let fileData = null;
      try { fileData = _readAllBudgetFile()[key]; } catch (e) { /* 파일 없음/손상 — 무시 */ }
      const initial = fileData || _emptyCompanyBudget();
      await client.query(
        'INSERT INTO budget_store (company_id, data) VALUES ($1,$2) ON CONFLICT (company_id) DO NOTHING',
        [key, JSON.stringify(initial)]
      );
      ({ rows } = await client.query('SELECT data FROM budget_store WHERE company_id=$1 FOR UPDATE', [key]));
      data = rows[0].data;
    }
    data = _fillBudgetDefaults(data);
    const result = await mutate(data);
    await client.query('UPDATE budget_store SET data=$2, updated_at=NOW() WHERE company_id=$1', [key, JSON.stringify(data)]);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// requiredHeaderGroups를 지정하면(예: [['팀명','팀'],['항목']]) 단순히 "첫 시트의 1행"만
// 헤더로 보는 대신, 워크북의 모든 시트·앞부분 행(최대 20행)을 훑어 그룹마다 하나 이상의
// 헤더 텍스트를 포함하는 행을 찾아 그 행을 헤더로 삼아 파싱한다 — 실제 회사 원본 엑셀처럼
// 여러 시트가 한 파일에 섞여 있고(예: "RAW자료"/"예산"/"조직별") 실제 데이터 시트의 헤더가
// 제목행 등으로 인해 1행이 아닌 경우(예: 2행)에도 올바른 시트·행을 자동으로 찾아낸다.
// 못 찾으면 빈 배열을 반환하되 어떤 시트들을 확인했는지 `_triedSheets`에 남겨 진단에 쓴다.
// requiredHeaderGroups를 생략하면(레거시 호출부) 기존과 동일하게 첫 시트·1행을 그대로 쓴다.
// excludedHeaders — 실제 회사 원본 파일에서 "예산"(비인건비) 시트가 "구분"·"1월" 컬럼을
// 모두 갖고 있어("판관/용역/경상" 분류용 "구분" 컬럼이 우연히 이름이 같음), 워크북 순서상
// "예산" 시트가 "조직별"(인원계획) 시트보다 먼저 나오면 인원계획 업로드가 엉뚱하게 예산
// 시트를 파싱하는 사고가 실제로 재현됨(사용자 첨부 원본 파일로 확인) — 이 목록에 있는
// 헤더가 하나라도 있는 행은 후보에서 제외해 "예산" 시트를 걸러낸다.
function parseSheet(buffer, filename, requiredHeaderGroups, excludedHeaders) {
  const isCsv = /\.csv$/i.test(filename || '');
  const workbook = isCsv
    ? xlsx.read(buffer.toString('utf8'), { type: 'string' })
    : xlsx.read(buffer, { type: 'buffer' });
  if (Array.isArray(requiredHeaderGroups) && requiredHeaderGroups.length) {
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      // header:1 모드는 기본적으로 시트의 !ref 범위를 대상으로 하고, 반환 배열의 인덱스는
      // 그 범위의 시작행 기준 "상대" 위치다. 맨 위 몇 행이 완전히 비어 있는 시트는 !ref가
      // 0행이 아닌 곳부터 시작하는데(예: 사용자 원본 파일의 "조직별" 시트는 !ref가 "A2:V91"
      // — 실제 첫 행이 엑셀 2행), 그 상대 인덱스를 그대로 아래 range 옵션(절대 행 번호를
      // 기대함)에 넘기면 엉뚱한 행(제목행 등)을 헤더로 잘못 잡는 오차가 생긴다(실제 파일로
      // 재현·발견 — 이 어긋남 때문에 "조직별" 업로드가 바로 위의 "예산" 시트 헤더 행을
      // 잘못 읽어들이고 있었음). !ref의 시작행을 더해 절대 행 번호로 보정한다.
      const refStartRow = sheet['!ref'] ? xlsx.utils.decode_range(sheet['!ref']).s.r : 0;
      const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
      for (let i = 0; i < Math.min(raw.length, 20); i++) {
        const rowVals = (raw[i] || []).map(v => String(v).trim());
        if (Array.isArray(excludedHeaders) && excludedHeaders.some(h => rowVals.includes(h))) continue;
        if (requiredHeaderGroups.every(group => group.some(h => rowVals.includes(h)))) {
          const absoluteRow = refStartRow + i;
          const rows = xlsx.utils.sheet_to_json(sheet, { range: absoluteRow, defval: null, raw: true });
          rows._sheetName = sheetName;
          rows._headerRow = absoluteRow;
          return rows;
        }
      }
    }
    const empty = [];
    empty._sheetName = null;
    empty._headerRow = -1;
    empty._triedSheets = workbook.SheetNames;
    return empty;
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return xlsx.utils.sheet_to_json(sheet, { defval: null, raw: true });
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// 사업계획 시나리오: 기준연도 매출/비용 가정으로 N개년 추정 손익·현금흐름을 계산.
// POST(신규 생성)와 PUT(가정 변경 후 재계산) 양쪽에서 동일 로직을 재사용한다.
// planType==='costOnly'(비용전용 팀)여도 baseRevenue/cogsRatio가 0으로 정규화되어 그대로
// 들어오므로 이 함수 자체는 손댈 필요가 없다 — revenue=0, cogs=0, grossProfit=0이 되고
// operatingProfit은 판관비(예산 항목)의 음수가 되어 "그 해 예산 지출액"을 자연스럽게 표현한다.
function computeBusinessPlanProjection(a) {
  const years = a.years;
  const sgaItems = Array.isArray(a.sgaItems) ? a.sgaItems : [];
  // 건별 매출 항목(revenueItems)이 있으면 "기준연도 매출 총액 × 성장률" 단일 가정 대신
  // 건별 예상매출(고객사·수주시점별)을 그대로 합산한 값을 매출로 쓴다 — sgaItems와 동일한
  // growthRate 복리 방식으로 다음 연도를 추정(하위호환: revenueItems가 없으면 기존과
  // 완전히 동일하게 baseRevenue*성장률 방식 그대로 유지).
  const revenueItems = Array.isArray(a.revenueItems) ? a.revenueItems : [];
  const useItemizedRevenue = revenueItems.length > 0;
  const projection = [];
  let prevRevenue = useItemizedRevenue ? round2(revenueItems.reduce((s, item) => s + (item.baseAmount || 0), 0)) : a.baseRevenue;

  for (let y = 1; y <= years; y++) {
    const revenue = useItemizedRevenue
      ? round2(revenueItems.reduce((s, item) => s + (item.baseAmount || 0) * Math.pow(1 + (item.growthRate || 0), y), 0))
      : round2(a.baseRevenue * Math.pow(1 + a.revenueGrowthRate, y));
    const cogsFromRatio = round2(revenue * a.cogsRatio);
    // 판관비 항목(sgaItems)의 계정과목(판관/용역/경상)에 따라 서로 다른 손익 라인으로
    // 반영한다 — 실사용자의 실제 회사 손익 양식을 확인한 결과, "용역"은 외주·용역인건비
    // 등 매출원가를 구성하는 항목이라 매출원가에 더해야 하고, "경상"은 판관비와는 별개로
    // 경상적으로 집행되는 연구개발비(고정 운영비) 라인으로 분리해서 봐야 했다 — 그동안은
    // 계정과목 구분과 무관하게 전 항목이 그냥 "판관비" 한 줄로 합산되고 있었다(사용자
    // 보고). "판관"이거나 계정과목이 비어있는(과거 데이터·수동입력) 항목은 기존과 동일하게
    // 전통적 판관비로 취급 — 하위호환을 위해 기본값을 판관으로 둔다.
    let serviceCost = 0, sga = 0, rdExpense = 0;
    sgaItems.forEach(item => {
      const amt = (item.baseAmount || 0) * Math.pow(1 + (item.growthRate || 0), y);
      if (item.accountType === '용역') serviceCost += amt;
      else if (item.accountType === '경상') rdExpense += amt;
      else sga += amt;
    });
    serviceCost = round2(serviceCost);
    sga = round2(sga);
    rdExpense = round2(rdExpense);
    const cogs = round2(cogsFromRatio + serviceCost);
    const grossProfit = round2(revenue - cogs);
    const operatingProfit = round2(grossProfit - sga - rdExpense);
    const netIncome = round2(operatingProfit * (1 - a.taxRate));
    const freeCashFlow = round2(netIncome + (a.depreciation || 0));

    // 비율 분석(소수, 예: 0.15 = 15%). 매출이 0이거나 전년 매출이 0이면 나눗셈이
    // 무의미하므로 null로 표시(프론트에서 '-'로 렌더링).
    const grossMarginRatio = revenue > 0 ? round2(grossProfit / revenue) : null;
    const operatingMarginRatio = revenue > 0 ? round2(operatingProfit / revenue) : null;
    const netMarginRatio = revenue > 0 ? round2(netIncome / revenue) : null;
    const revenueGrowthYoY = prevRevenue > 0 ? round2((revenue - prevRevenue) / prevRevenue) : null;
    prevRevenue = revenue;

    projection.push({
      year: a.baseYear + y,
      revenue, cogs, cogsFromRatio, serviceCost, grossProfit, sga, rdExpense, operatingProfit, netIncome, freeCashFlow,
      grossMarginRatio, operatingMarginRatio, netMarginRatio, revenueGrowthYoY
    });
  }

  return projection;
}

// 손익분기점(BEP) 분석: 판관비 항목 중 fixed!==false인 항목(기본값 true 취급 — 즉 항목별
// 지정이 없으면 요청서 명세대로 "판관비 전체를 고정비로 가정")의 기준연도 금액 합을
// 고정비로 삼는다. fixed:false로 지정한 항목은 매출 대비 비율로 환산해 매출원가율에
// 더한 "변동비율"로 취급한다(기본 케이스는 BEP매출 = 고정비/(1-매출원가율)과 동일).
// 기준연도(baseYear) 시점 스냅샷으로만 계산한다(요청서 명세 — 연도별이 아님).
// planType==='costOnly'는 baseRevenue가 0이라 bepRevenue/safetyMarginRatio가 무의미해져
// null로 나오는데(0으로 나누기 방지 가드가 이미 있음) 이는 의도된 동작 — 비용전용 계획엔
// 손익분기점 개념 자체가 적용되지 않는다.
function computeBreakEven(a) {
  // computeBusinessPlanProjection과 동일하게, revenueItems가 있으면 그 합계를 기준연도
  // 매출로 쓴다(하위호환: 없으면 기존 baseRevenue 그대로).
  const revenueItemsForBep = Array.isArray(a.revenueItems) ? a.revenueItems : [];
  const baseRevenue = revenueItemsForBep.length
    ? round2(revenueItemsForBep.reduce((s, item) => s + (item.baseAmount || 0), 0))
    : a.baseRevenue;
  const sgaItems = Array.isArray(a.sgaItems) ? a.sgaItems : [];
  const fixedCost = round2(sgaItems.reduce(
    (sum, item) => sum + (item.fixed === false ? 0 : (item.baseAmount || 0)), 0
  ));
  const variableSga = round2(sgaItems.reduce(
    (sum, item) => sum + (item.fixed === false ? (item.baseAmount || 0) : 0), 0
  ));
  const variableSgaRatio = baseRevenue > 0 ? variableSga / baseRevenue : 0;
  const variableCostRatio = round2(a.cogsRatio + variableSgaRatio);

  const result = {
    baseYear: a.baseYear,
    fixedCost,
    variableCostRatio,
    currentRevenue: baseRevenue,
    bepRevenue: null,
    safetyMarginRatio: null
  };

  if (baseRevenue <= 0 || variableCostRatio >= 1) {
    result.note = baseRevenue <= 0
      ? '매출이 없는(비용전용) 계획이라 손익분기점을 계산하지 않습니다.'
      : '변동비율(매출원가율 등)이 100% 이상이라 손익분기 매출액을 계산할 수 없습니다.';
    return result;
  }

  result.bepRevenue = round2(fixedCost / (1 - variableCostRatio));
  result.safetyMarginRatio = baseRevenue > 0 ? round2((baseRevenue - result.bepRevenue) / baseRevenue) : null;
  return result;
}

// budgetComparison과 동일한 이유(저장된 값이 아니라 조회 시점에 매번 재계산)로,
// projection/breakEven도 저장된 스냅샷을 그대로 믿지 않고 plan.assumptions로부터 다시
// 계산해 응답한다 — computeBusinessPlanProjection()의 계산식 자체가 나중에 바뀌면(예:
// 계정과목별 P&L 라인 분리를 수정한 이번 건), 이미 저장돼 있던 예전 계획들도 재저장·
// 재업로드 없이 곧바로 올바른 값으로 보이게 하기 위함(그러지 않으면 사용자가 계획마다
// 일일이 재저장해야만 수정된 계산식이 반영되는 불편이 생김). 쓰기 라우트가 저장하는
// plan.projection 스냅샷 자체는 그대로 유지(디버깅·진단 도구 참고용) — 이 함수는 오직
// 조회 응답에만 신선한 값을 덮어씌운다.
function _freshPlanCalc(plan) {
  const a = { baseYear: plan.baseYear, years: plan.years !== undefined ? plan.years : (plan.projection || []).length, ...plan.assumptions };
  return { projection: computeBusinessPlanProjection(a), breakEven: computeBreakEven(a) };
}

// 예산 실적 대비 비교(선택 기능): 실제 업로드된(섹션 1~3) 판관 카테고리 금액 합계와
// 사업계획의 기준연도 판관비 가정 합계를 단순 비교해 괴리를 안내한다. 저장하지 않고
// 조회 시점마다 재계산(업로드 데이터가 계획 저장 이후에도 바뀔 수 있으므로).
// plan.dept가 있으면(팀별 계획 워크플로우 도입 이후) 그 팀/부서의 실적만 걸러서 비교한다 —
// 이 필터가 없으면 전사 실적 전체를 팀 하나의 계획과 비교하게 되어(회사 전체 판관비 실적이
// 우연히 계획보다 훨씬 크므로) 실제로는 예산을 절감한 팀도 "실적이 계획을 크게 초과"로
// 잘못 표시되는 문제가 있었다. plan.team이 있으면 그 팀 실적만, team이 비어있으면(사업부장
// 단위 계획) 그 부문 전체(여러 팀 합산) 실적을 비교 대상으로 삼는다. dept가 없는(레거시
// 전사 스크래치) 계획은 기존과 동일하게 전사 실적 전체와 비교한다.
function computeBudgetComparison(data, plan) {
  const actualSga = round2((data.items || [])
    .filter(i => i.category === '판관')
    .filter(i => !plan.dept || (i.dept === plan.dept && (!plan.team || (i.team || '') === plan.team)))
    .reduce((sum, i) => sum + i.amount, 0));
  if (actualSga <= 0) return null;
  const sgaItems = Array.isArray(plan.assumptions && plan.assumptions.sgaItems) ? plan.assumptions.sgaItems : [];
  const assumptionSga = round2(sgaItems.reduce((sum, item) => sum + (item.baseAmount || 0), 0));
  if (assumptionSga <= 0) return null;
  const diff = round2(actualSga - assumptionSga);
  const diffRatio = round2(diff / assumptionSga);
  return { actualSga, assumptionSga, diff, diffRatio };
}

// 판관비 항목(sgaItems)을 비용 귀속 부문(costDept) 기준으로 재집계 — 계획을 작성한
// 팀(plan.dept)과 실제 비용이 귀속되는 부문이 다를 수 있어(예: 기획팀이 작성한 계획 안에
// 경영지원부문 귀속 비용이 섞여 있는 경우), plan.dept 기준 롤업(byDept)과는 별개로
// "이 비용이 실제로 누구 예산인지" 기준의 조직단위 집계를 제공한다. company는 전사 합계.
function _sgaRollupByCostDept(plans) {
  const byCostDeptMap = {};
  const companyMonths = Array(12).fill(0);
  let companyTotal = 0;
  plans.forEach(p => {
    const items = (p.assumptions && p.assumptions.sgaItems) || [];
    items.forEach(item => {
      const cd = item.costDept || p.dept || '(미지정)';
      if (!byCostDeptMap[cd]) byCostDeptMap[cd] = { costDept: cd, months: Array(12).fill(0), total: 0 };
      const bucket = byCostDeptMap[cd];
      if (Array.isArray(item.months)) {
        item.months.forEach((v, i) => { bucket.months[i] += (v || 0); companyMonths[i] += (v || 0); });
      }
      bucket.total += item.baseAmount || 0;
      companyTotal += item.baseAmount || 0;
    });
  });
  const byCostDept = Object.values(byCostDeptMap)
    .map(r => ({ ...r, months: r.months.map(round2), total: round2(r.total) }))
    .sort((a, b) => b.total - a.total);
  return { byCostDept, company: { months: companyMonths.map(round2), total: round2(companyTotal) } };
}

// 판관비 항목(sgaItems)을 임의의 필드(구분/계정과목/비용계정 등, getKey로 지정) 기준으로
// 나눈 뒤, 그 안에서 다시 비용귀속부문(costDept) 기준으로 재집계하는 공용 로직.
// _sgaRollupByCategory/_sgaRollupByAccountType/_sgaRollupByExpenseAccount가 공유한다.
function _sgaRollupByField(plans, getKey, defaultLabel) {
  const byKeyMap = {};
  plans.forEach(p => {
    const items = (p.assumptions && p.assumptions.sgaItems) || [];
    items.forEach(item => {
      const key = getKey(item) || defaultLabel;
      const cd = item.costDept || p.dept || '(미지정)';
      if (!byKeyMap[key]) byKeyMap[key] = { byCostDeptMap: {}, companyMonths: Array(12).fill(0), companyTotal: 0 };
      const keyBucket = byKeyMap[key];
      if (!keyBucket.byCostDeptMap[cd]) keyBucket.byCostDeptMap[cd] = { costDept: cd, months: Array(12).fill(0), total: 0 };
      const bucket = keyBucket.byCostDeptMap[cd];
      if (Array.isArray(item.months)) {
        item.months.forEach((v, i) => { bucket.months[i] += (v || 0); keyBucket.companyMonths[i] += (v || 0); });
      }
      bucket.total += item.baseAmount || 0;
      keyBucket.companyTotal += item.baseAmount || 0;
    });
  });
  return Object.keys(byKeyMap).map(key => {
    const keyBucket = byKeyMap[key];
    const byCostDept = Object.values(keyBucket.byCostDeptMap)
      .map(r => ({ ...r, months: r.months.map(round2), total: round2(r.total) }))
      .sort((a, b) => b.total - a.total);
    return {
      key,
      byCostDept,
      company: { months: keyBucket.companyMonths.map(round2), total: round2(keyBucket.companyTotal) }
    };
  }).sort((a, b) => b.company.total - a.company.total);
}

// 3단계 자료 연계(개인별 급여 → 팀별 월별 그리드 → 부문별 집계표) 중 마지막 단계:
// 판관비 항목(sgaItems)을 "구분"(category — 급여/복리후생비/교육훈련비/지급수수료/사회보험/
// 퇴직급여 등, `_BP_DEFAULT_SGA_TEMPLATE`이 이미 각 항목에 붙여두는 표준 분류) 별로 나눈 뒤,
// 그 안에서 다시 비용귀속부문(costDept) 기준으로 재집계한다. 표준 판관비 항목 템플릿의
// category 값을 그대로 재사용하므로 별도 입력·매핑 없이 항목을 입력하는 순간 이 집계에
// 자동으로 반영된다. company는 그 구분의 전사 합계.
function _sgaRollupByCategory(plans) {
  return _sgaRollupByField(plans, item => item.category, '(미분류)')
    .map(r => ({ category: r.key, byCostDept: r.byCostDept, company: r.company }));
}

// 판관비 항목을 "계정과목"(accountType — 판관/용역/경상, budget.js CATEGORIES와 동일한
// 값 체계) 기준으로 나눈 뒤 비용귀속부문별 재집계. 항목 입력 시 선택한 계정과목이 그대로
// 반영되며 별도 매핑이 필요 없다.
function _sgaRollupByAccountType(plans) {
  return _sgaRollupByField(plans, item => item.accountType, '(미지정)')
    .map(r => ({ accountType: r.key, byCostDept: r.byCostDept, company: r.company }));
}

// 판관비 항목을 "비용계정"(expenseAccount — 실제 회계 계정과목 검색선택 필드) 기준으로
// 나눈 뒤 비용귀속부문별 재집계. 비용계정을 지정하지 않은 항목은 '(미지정)'으로 묶인다.
function _sgaRollupByExpenseAccount(plans) {
  return _sgaRollupByField(plans, item => item.expenseAccount, '(미지정)')
    .map(r => ({ expenseAccount: r.key, byCostDept: r.byCostDept, company: r.company }));
}

// 표준 판관비 "구분"(category) 목록 — public/index.html의 _BP_DEFAULT_SGA_TEMPLATE 카테고리와
// 동일한 문자열을 이 파일에도 별도로 유지한다(두 파일 간 코드 공유가 없는 이 코드베이스의
// 기존 관례 — emp-pay-plan 쪽 38항목 템플릿도 마찬가지로 클라이언트에만 있고 서버는 이름
// 문자열만으로 취급). "예산" 엑셀 업로드처럼 항목명이 "구분" 그 자체로 뭉뚱그려 들어오는
// 경우(개인별 급여 상세처럼 세부 항목명이 아니라 부서 단위 개산 총액)를 표준 구분에
// 매핑하기 위한 용도.
const _SGA_CANONICAL_CATEGORIES = ['급여', '복리후생비', '교육훈련비', '지급수수료', '지급임차료', '건물관리비', '보험료', '소모품비', '도서인쇄비', '통신비', '협회비', '세금과공과', '퇴직급여', '사회보험'];
const _SGA_CATEGORY_ALIASES = { '세금과공과금': '세금과공과', '임차료': '지급임차료' };
function _guessSgaCategory(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return '';
  if (_SGA_CANONICAL_CATEGORIES.includes(name)) return name;
  if (_SGA_CATEGORY_ALIASES[name]) return _SGA_CATEGORY_ALIASES[name];
  const found = _SGA_CANONICAL_CATEGORIES.find(c => name.includes(c) || c.includes(name));
  return found || name;
}

// 항목명으로 회사 비용계정(코드+이름)을 추정 — public/index.html의 클라이언트측
// _bpGuessExpenseAccount()와 동일한 "서로 포함 관계" 매칭을 서버에도 이식한 것. 예산
// 시트·조직별 비용 블록 업로드가 (수동 미리보기 화면을 거치지 않는 통합 업로드 등에서도)
// 항상 비용계정을 채우도록 서버 쪽에도 동일 로직을 둔다 — 확신할 수 있는 매칭만 채우고
// 애매하면 빈 값으로 남겨 사람이 "예산 항목 관리"에서 직접 검색선택하게 한다.
function _guessExpenseAccount(itemName, accounts) {
  const name = String(itemName || '').trim();
  if (!name || !Array.isArray(accounts) || !accounts.length) return '';
  const found = accounts.find(a => a.name && (name.includes(a.name) || a.name.includes(name)));
  return found ? `${found.code ? found.code + ' ' : ''}${found.name}` : '';
}

// body에서 사업계획 가정(assumptions)을 검증·정규화한다. existing이 주어지면(PUT) 그 값을
// 기본값으로 깔고 body에 있는 필드만 덮어써 부분 수정(partial update)을 허용한다.
// planType==='costOnly'(비용전용 팀)면 매출 관련 3필드(baseRevenue/revenueGrowthRate/
// cogsRatio)를 명시하지 않아도 0으로 기본값 처리하고, 법인세율도 0으로 기본값 처리한다
// (팀 단위 비용예산에 법인세를 적용하는 것은 실질적 의미가 없어, 순이익=영업이익(=−예산)이
// 되어 "그 해 예산 지출액"을 그대로 보여주도록 함 — taxRate를 명시적으로 보냈다면 그 값을
// 존중한다).
function _normalizeBusinessPlanInput(body, existing) {
  const base = existing || {};
  const errors = [];

  const name = body.name !== undefined ? body.name : base.name;
  const baseYear = body.baseYear !== undefined ? Number(body.baseYear) : base.baseYear;
  const years = body.years !== undefined ? Number(body.years) : base.years;
  const planType = body.planType !== undefined ? body.planType : (base.planType || 'revenue');
  const isCostOnly = planType === 'costOnly';

  const baseRevenue = body.baseRevenue !== undefined ? Number(body.baseRevenue)
    : (base.baseRevenue !== undefined ? base.baseRevenue : (isCostOnly ? 0 : undefined));
  const revenueGrowthRate = body.revenueGrowthRate !== undefined ? Number(body.revenueGrowthRate)
    : (base.revenueGrowthRate !== undefined ? base.revenueGrowthRate : (isCostOnly ? 0 : undefined));
  const cogsRatio = body.cogsRatio !== undefined ? Number(body.cogsRatio)
    : (base.cogsRatio !== undefined ? base.cogsRatio : (isCostOnly ? 0 : undefined));
  const taxRate = body.taxRate !== undefined ? Number(body.taxRate)
    : (base.taxRate !== undefined ? base.taxRate : (isCostOnly ? 0 : 0.22));
  const depreciation = body.depreciation !== undefined ? Number(body.depreciation) : (base.depreciation !== undefined ? base.depreciation : 0);
  const sgaItemsRaw = body.sgaItems !== undefined ? body.sgaItems : base.sgaItems;
  const revenueItemsRaw = body.revenueItems !== undefined ? body.revenueItems : base.revenueItems;
  // 시나리오명(낙관/기본/보수 등): 완전히 선택 필드 — 기존에 저장된 계획에는 없을 수
  // 있으므로 undefined/null/빈 문자열 전부 허용하고 별도 검증하지 않는다.
  const scenario = body.scenario !== undefined ? (body.scenario || null) : (base.scenario !== undefined ? base.scenario : null);

  if (!name || typeof name !== 'string') errors.push('name');
  if (!Number.isFinite(baseYear)) errors.push('baseYear');
  if (!Number.isInteger(years) || years <= 0) errors.push('years');
  if (planType !== 'revenue' && planType !== 'costOnly') errors.push('planType');
  if (!Number.isFinite(baseRevenue)) errors.push('baseRevenue');
  if (!Number.isFinite(revenueGrowthRate)) errors.push('revenueGrowthRate');
  if (!Number.isFinite(cogsRatio)) errors.push('cogsRatio');
  if (!Number.isFinite(taxRate)) errors.push('taxRate');
  if (!Number.isFinite(depreciation)) errors.push('depreciation');

  let sgaItems = [];
  if (sgaItemsRaw !== undefined) {
    if (!Array.isArray(sgaItemsRaw)) {
      errors.push('sgaItems');
    } else {
      sgaItems = sgaItemsRaw.map(item => {
        // 항목별 월별 상세(부문/팀명/비용귀속부문/세부내역/구분/1~12월/비고) — 실적 업로드
        // 포맷(부문/팀/비용귀속부문/항목/세부내역/구분/월별금액)과 동일한 형태로 계획도
        // 항목 단위 월별 금액을 입력받는다. months가 있으면 그 12개월 합계를 그 해
        // 기준연도 금액(baseAmount)으로 쓰고, 이후 연도는 기존과 동일하게 growthRate로
        // 추정한다. months가 없으면(과거에 저장된 단순 항목) 기존처럼 baseAmount를
        // 그대로 사용 — 하위호환.
        const monthsRaw = item && Array.isArray(item.months) ? item.months : null;
        const months = monthsRaw && monthsRaw.length === 12 ? monthsRaw.map(v => Number(v) || 0) : null;
        const baseAmount = months
          ? round2(months.reduce((s, v) => s + v, 0))
          : (Number(item && item.baseAmount) || 0);
        return {
          dept: (item && item.dept) || null,
          team: (item && item.team) || '',
          costDept: (item && item.costDept) || null,
          name: (item && item.name) || '',
          detail: (item && item.detail) || '',
          category: (item && item.category) || '',
          // accountType(계정과목): 판관/용역/경상 — budget.js CATEGORIES와 동일한 값 체계를
          // 계획 항목에도 두어, 향후 실적(업로드된 판관/용역/경상 상세)과 더 정밀하게 비교할
          // 수 있게 한다. expenseAccount(비용계정): 실제 회계 계정과목(코드+이름)을 자유
          // 텍스트로 저장 — 전표 발행에 쓰이는 것이 아니라 계획서 표시/참고용이라 존재 여부를
          // 엄격히 검증하지 않는다(회사 계정과목 목록에 없는 값이어도 그대로 허용).
          accountType: (item && item.accountType) || '',
          expenseAccount: (item && item.expenseAccount) || '',
          months,
          note: (item && item.note) || '',
          baseAmount,
          growthRate: Number(item && item.growthRate) || 0,
          // 손익분기점(BEP) 분석용: 이 항목을 고정비로 볼지 여부. 지정하지 않으면(undefined)
          // true로 취급 — "판관비 전체를 고정비로 가정"하는 요청서 기본 동작과 일치.
          fixed: !(item && item.fixed === false)
        };
      });
    }
  }

  // 매출 사업계획(planType==='revenue')의 매출 항목 — 기존엔 "기준연도 매출 총액 +
  // 성장률" 단일 가정 하나만 입력받아, 팀별 판관비 그리드와 달리 실제 영업 파이프라인
  // (고객사·건별 예상매출·수주시점·인식기준)을 담을 방법이 없었다(사용자 보고: "매출
  // 사업계획이 비용 계획 수립 화면과 동일하게 구성되어 있다"). sgaItems와 동일한 패턴
  // (항목별 12개월 배열 → baseAmount 자동 계산, growthRate로 다음 연도 추정)을 매출에도
  // 적용하되, 건별 영업 정보(client/expectedWinDate/recognitionBasis)와 계획 대비 실적을
  // 비교하기 위한 actualMonths(실적, 별도 라우트로만 갱신 — 아래 /revenue-actuals 참고)를
  // 추가로 둔다. revenueItems가 있으면 baseRevenue(단일 총액 가정)보다 우선해서 손익
  // 계산에 쓰인다(computeBusinessPlanProjection/computeBreakEven 참고) — 없으면(과거
  // 계획·costOnly) 기존처럼 baseRevenue 그대로 사용해 하위호환.
  let revenueItems = [];
  if (revenueItemsRaw !== undefined) {
    if (!Array.isArray(revenueItemsRaw)) {
      errors.push('revenueItems');
    } else {
      revenueItems = revenueItemsRaw.map(item => {
        const monthsRaw = item && Array.isArray(item.months) ? item.months : null;
        const months = (monthsRaw && monthsRaw.length === 12 ? monthsRaw : Array(12).fill(0)).map(v => Number(v) || 0);
        // actualMonths는 이 라우트(계획 작성/수정)로는 절대 덮어쓰지 않는다 — 기존 값을
        // 그대로 보존하고, 신규 항목이면 0으로 시작. 실적은 오직 /revenue-actuals
        // 라우트로만 기록되도록 분리(계획 잠금 여부와 무관하게 실적 입력이 가능해야
        // 하는데, 이 라우트는 draft 상태에서만 허용되는 계획 수정 경로이기 때문).
        const existingItem = Array.isArray(base.revenueItems) ? base.revenueItems.find(e => e.id === (item && item.id)) : null;
        const actualMonths = existingItem && Array.isArray(existingItem.actualMonths) && existingItem.actualMonths.length === 12
          ? existingItem.actualMonths : Array(12).fill(0);
        const baseAmount = round2(months.reduce((s, v) => s + v, 0));
        return {
          id: (item && item.id) || `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          client: (item && item.client) || '',
          projectName: (item && item.projectName) || '',
          expectedAmount: Number(item && item.expectedAmount) || 0,
          expectedWinDate: (item && item.expectedWinDate) || '',
          recognitionBasis: (item && item.recognitionBasis) || '',
          status: (item && item.status) || '',
          note: (item && item.note) || '',
          months, actualMonths, baseAmount,
          growthRate: Number(item && item.growthRate) || 0
        };
      });
    }
  }

  if (errors.length) return { errors };
  return {
    assumptions: { name, baseYear, years, planType, baseRevenue, revenueGrowthRate, cogsRatio, sgaItems, revenueItems, taxRate, depreciation, scenario }
  };
}

// ── 인가 헬퍼 ────────────────────────────────────────────────────────────────
function requireAuth(req, res) {
  if (!req.auth) {
    res.status(401).json({ error: '로그인이 필요합니다.' });
    return false;
  }
  return true;
}

// 과거에는 클라이언트가 body에 적어 보낸 role을 그대로 신뢰했다(server.js의 다른
// 라우트들이 이미 폐기한 것과 동일한 취약 패턴) — 인증 토큰이 전혀 없어도 body에
// role:"admin"만 넣으면 전체 예산 데이터 조회/업로드/삭제가 가능했다. 이 라우터는
// server.js에서 `app.use(authenticate)` 이후에 마운트되므로 req.auth(서버가 검증한
// 로그인 토큰)를 그대로 쓸 수 있다.
function requireAdmin(req, res) {
  if (!requireAuth(req, res)) return false;
  if (req.auth.role !== 'admin') {
    res.status(403).json({ error: '관리자만 사용할 수 있습니다.' });
    return false;
  }
  return true;
}

// dept가 없는(레거시/회사 전체 스크래치) 계획은 팀 소유 개념이 없어 관리자만 다룰 수 있다.
// dept가 있는 팀별 계획은 같은 dept+team 소속 직원 누구나(요청서: "팀별 계획 작성 권한 —
// 팀장만? 사업부장도?" 질문에 "모두다 작성/수정은 가능"으로 답변) 수정 가능하고, 그 팀이
// 속한 사업부장(director, team 필드는 이 코드베이스 관례상 빈 문자열)도 같은 권한을 갖는다.
function _canEditPlan(isAdmin, profile, plan) {
  if (isAdmin) return true;
  if (!plan.dept) return false;
  if (!profile) return false;
  if (profile.dept === plan.dept && (profile.team || '') === (plan.team || '')) return true;
  return _isDivisionHead(false, profile, plan);
}

// 사업부장 승인: director 역할이면서 dept가 그 계획의 dept와 일치해야 한다(director는
// team이 빈 문자열인 본부 단위 소속이 이 코드베이스의 기존 관례).
function _isDivisionHead(isAdmin, profile, plan) {
  if (isAdmin) return true;
  if (!profile || !plan.dept) return false;
  return profile.role === 'director' && profile.dept === plan.dept;
}

function _isBudgetOwner(isAdmin, settings, empId) {
  if (isAdmin) return true;
  return (settings.ownerIds || []).map(String).includes(String(empId));
}

function _isPlanningLead(isAdmin, settings, empId) {
  if (isAdmin) return true;
  return settings.teamLeaderId != null && String(settings.teamLeaderId) === String(empId);
}

// 목록/상세 조회 가시성: 관리자·예산담당자·기획팀장은 전체, 사업부장(director)은 자기
// dept, 그 외(팀원/팀장)는 자기 dept+team 계획만. dept가 없는(레거시) 계획은 관리자만.
function _canViewPlan(isAdmin, profile, settings, empId, plan) {
  if (isAdmin) return true;
  if (!plan.dept) return false;
  if (_isBudgetOwner(false, settings, empId) || _isPlanningLead(false, settings, empId)) return true;
  if (profile && profile.role === 'director' && profile.dept === plan.dept) return true;
  return _canEditPlan(false, profile, plan);
}

// updateBudget()의 mutate 콜백 안에서 검증 실패 등으로 라우트를 조기 종료해야 할 때
// 던지는 에러 — server.js의 _RecruitRouteError와 동일한 패턴. updateBudget()이 이 에러를
// 만나면(다른 에러와 동일하게) 트랜잭션을 롤백하고 그대로 재던지므로, 검증 실패 시
// 불필요한 UPDATE 없이(그리고 DB 모드에서는 락도 즉시 풀며) 라우트 핸들러의 catch에서
// status/message로 변환해 응답한다.
class _BudgetRouteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── 사업계획 변경 이력(감사 추적) ─────────────────────────────────────────────
// 지금까지 사업계획은 승인/최종확정/수정요청 각각의 필드(divisionApproval/finalApproval/
// editRequest)에 "가장 최근" 처리자·시각만 남고, 그 이전에 누가 무엇을 바꿨는지는 매
// 저장마다 덮어써져 사라졌다(예: PUT으로 세 번 수정되면 처음 두 번의 작성자·시각은
// 완전히 유실). 승인·예산 워크플로우가 있는 기능에서 "왜 이 숫자가 바뀌었는지" 추적이
// 안 되는 것은 이 코드베이스의 다른 모듈(회계 전표/거래처/견적서 등, server.js의
// history:[{action,user,at}] 배열 + public/index.html의 _showRecordHistory/
// _buildHistoryRows 공용 뷰어)이 이미 갖추고 있는 관례라 사업계획에만 없는 것은
// 명백한 공백이었다. 같은 형태({action,user,at,detail})로 plan.history[]에 append-only
// 기록해 그 클라이언트 공용 뷰어를 그대로 재사용한다(서버 쪽에 새 조회 API는 불필요 —
// plan 객체 자체에 이미 포함되어 GET /business-plan·GET /business-plan/:id 응답에
// 자동으로 실린다). action은 이미 한글로 저장해(_buildHistoryRows가 'create'/'update'
// 두 키만 한글로 치환하고 나머지는 그대로 통과시키는 구조이므로) 클라이언트 공용
// 함수를 전혀 수정하지 않고도 그대로 자연스럽게 표시된다.
const MAX_PLAN_HISTORY = 200; // server.js의 MAX_FILE_HISTORY/MAX_ACTIVITY_LOGS와 동일한 취지의 상한
function _pushPlanHistory(plan, action, userName, detail) {
  if (!Array.isArray(plan.history)) plan.history = [];
  plan.history.push({ action, user: userName || undefined, at: new Date().toISOString(), detail: detail || undefined });
  if (plan.history.length > MAX_PLAN_HISTORY) plan.history = plan.history.slice(-MAX_PLAN_HISTORY);
}
// getEmployeeProfile()로 조회한 profile이 없을 수 있는 경우(예: 관리자 본인의 employees
// 레코드가 없는 경우 등)를 표시용 이름으로 안전하게 보정.
function _actorName(profile, isAdmin) {
  return profile ? profile.name : (isAdmin ? '관리자' : undefined);
}
// 쉼표 3자리 구분 — Node의 toLocaleString()은 ICU 빌드 여부에 따라 동작이 달라질 수 있어
// (이 코드베이스가 서버 사이드에서 toLocaleString을 쓰지 않는 이유이기도 함) 사용하지 않고
// 직접 구현. 이력 상세 문구(예: "판관비 합계 1,000,000원 → 1,200,000원")에만 쓰이는
// 표시용 포맷팅이라 정밀도 요구가 없다. 원단위 절상(올림) — public/index.html의 _bpFmt와
// 동일한 표시 규칙(사용자 요청).
function _fmtNum(n) {
  return Math.ceil(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const router = express.Router();

// 부서별/월별 인원수 업로드 (첫번째 파일)
router.post('/upload/headcount', upload.single('file'), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });

  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch (e) {
    return res.status(400).json({ error: '파일을 읽을 수 없습니다. (xlsx/csv만 지원)' });
  }

  const companyId = req.auth.companyId || null;
  let upserted = 0;

  await updateBudget(companyId, async (data) => {
    rows.forEach(row => {
      const dept = row['구분'];
      if (!dept || dept === '계') return;

      MONTHS.forEach(m => {
        const value = toNumber(row[`${m}월`]);
        if (value === null) return;
        const existing = data.headcount.find(h => h.dept === dept && h.month === m);
        if (existing) {
          existing.count = value;
        } else {
          data.headcount.push({ dept, month: m, count: value });
        }
        upserted++;
      });
    });

    data.uploads.push({
      type: 'headcount',
      filename: req.file.originalname,
      uploadedAt: new Date().toISOString(),
      rows: rows.length
    });
  });
  res.json({ message: '인원 현황이 반영되었습니다.', upserted, depts: [...new Set(rows.map(r => r['구분']).filter(Boolean))] });
});

// 사업부/팀별 예산 상세(판관/용역/경상) 업로드 (두번째 파일)
router.post('/upload/detail', upload.single('file'), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });

  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch (e) {
    return res.status(400).json({ error: '파일을 읽을 수 없습니다. (xlsx/csv만 지원)' });
  }

  const companyId = req.auth.companyId || null;
  let upserted = 0;

  await updateBudget(companyId, async (data) => {
    rows.forEach(row => {
      const dept = row['부문'];
      const category = row['구분'];
      if (!dept || dept === '계' || !category || !CATEGORIES.includes(category)) return;

      const team = row['팀'] || row['팀명'] || '';
      const revenueType = row['매출구분'] || '';
      const account = row['항목'] || '';
      const detail = row['세부내역(산정근거)'] || row['세부내역'] || '';
      // 비용 귀속 부문: 실제 비용을 쓰는 팀(부문/팀)과 그 비용이 손익상 귀속되는 부문이
      // 다를 수 있어(예: 기획팀이 발생시킨 비용이 경영지원부문 예산으로 잡히는 경우) 별도
      // 컬럼으로 받는다. 비어있으면 부문(dept)과 동일하게 취급(기존 업로드 파일과의 하위호환).
      const costDept = row['비용 귀속 부문'] || row['비용귀속부문'] || dept;
      const note = row['비고'] || '';

      MONTHS.forEach(m => {
        const amount = toNumber(row[`${m}월`]);
        if (amount === null) return;
        const existing = data.items.find(i =>
          i.dept === dept && i.team === team && i.account === account &&
          i.category === category && i.month === m && (i.costDept || i.dept) === costDept
        );
        if (existing) {
          existing.amount = amount;
          existing.revenueType = revenueType;
          existing.detail = detail;
          existing.costDept = costDept;
          existing.note = note;
        } else {
          data.items.push({ dept, team, revenueType, account, detail, category, costDept, note, month: m, amount });
        }
        upserted++;
      });
    });

    data.uploads.push({
      type: 'detail',
      filename: req.file.originalname,
      uploadedAt: new Date().toISOString(),
      rows: rows.length
    });
  });
  res.json({ message: '예산 상세(판관/용역/경상) 내역이 반영되었습니다.', upserted, depts: [...new Set(rows.map(r => r['부문']).filter(Boolean))] });
});

// 원본 데이터 조회
router.get('/data', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(await readBudget(req.auth.companyId || null));
});

// 업로드 이력
router.get('/uploads', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const data = await readBudget(req.auth.companyId || null);
  res.json({ uploads: data.uploads });
});

// 사업부별/월별 통합 요약 (인원 + 판관/용역/경상 합산, 중복 제외)
// ?groupBy=costDept 를 주면 실제 비용이 쓰인 부문(dept)이 아니라 손익상 귀속되는
// 부문(costDept)을 기준으로 재집계한다(전사 합계는 프론트가 이 배열을 그대로 합산해
// 보여주므로 groupBy와 무관하게 항상 동일 — "전사"와 "조직단위" 양쪽을 같은 응답으로
// 커버). 인원 현황(headcount)은 비용귀속부문 개념이 없어 groupBy=costDept일 때는 항상 null.
router.get('/summary', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const data = await readBudget(req.auth.companyId || null);
  const groupBy = req.query.groupBy === 'costDept' ? 'costDept' : 'dept';
  const keyOf = item => (groupBy === 'costDept' ? (item.costDept || item.dept) : item.dept);

  const groups = [...new Set([
    ...(groupBy === 'dept' ? data.headcount.map(h => h.dept) : []),
    ...data.items.map(keyOf)
  ])].filter(Boolean);

  const summary = groups.map(groupKey => {
    const months = MONTHS.map(m => {
      const headcountEntry = groupBy === 'dept' ? data.headcount.find(h => h.dept === groupKey && h.month === m) : null;
      const groupItems = data.items.filter(i => keyOf(i) === groupKey && i.month === m);

      const byCategory = {};
      CATEGORIES.forEach(c => { byCategory[c] = 0; });
      groupItems.forEach(i => { byCategory[i.category] += i.amount; });

      // 항목 단위로 이미 고유 키(부서+팀+항목+구분+월+비용귀속부문)로 upsert 되어 있으므로
      // 단순 합산해도 중복이 발생하지 않음
      const totalAmount = groupItems.reduce((sum, i) => sum + i.amount, 0);

      return {
        month: m,
        headcount: headcountEntry ? headcountEntry.count : null,
        ...byCategory,
        totalAmount,
        hasHeadcountData: !!headcountEntry,
        hasDetailData: groupItems.length > 0
      };
    });

    return { dept: groupKey, months };
  });

  res.json({ summary, groupBy });
});

// 데이터 초기화 (본인 회사 데이터만 — 다른 회사 데이터는 건드리지 않음)
// 프런트엔드(public/budget.html)의 확인창 문구가 "업로드된 모든 예산 데이터를
// 초기화할까요?"로, 인원/판관·용역·경상 상세 "업로드" 데이터만을 가리킨다 — 사업계획
// (businessPlans)은 파일 업로드가 아니라 화면에서 직접 입력하는 별개 기능이고 자체
// 삭제 버튼(DELETE /business-plan/:id)도 따로 있으므로, 여기서 같이 지우면 사용자가
// 예상치 못하게 사업계획 시나리오를 통째로 잃게 된다. businessPlans/budgetPlanSettings는
// 보존한다.
router.delete('/data', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const companyId = req.auth.companyId || null;
  // businessPlans/budgetPlanSettings와 마찬가지로 empPayPlans(개인별 급여 상세 계획)·
  // empPayPlanSettings(그 화면의 자동계산 요율 설정, 기존에 누락돼 있던 것을 함께 수정)·
  // headcountPlans(월별 인원 계획, 엑셀 업로드지만 사업계획 롤업에 쓰이는 계획 데이터라
  // budget.html의 "실적 업로드" 초기화 범위 밖)도 파일 "업로드"(실적/현황) 데이터가
  // 아니라 화면/사업계획 쪽에서 관리하는 별개 데이터라 함께 보존한다.
  await updateBudget(companyId, async (data) => {
    const kept = {
      businessPlans: data.businessPlans,
      budgetPlanSettings: data.budgetPlanSettings,
      empPayPlans: data.empPayPlans,
      empPayPlanSettings: data.empPayPlanSettings,
      headcountPlans: data.headcountPlans,
    };
    Object.assign(data, _emptyCompanyBudget(), kept);
  });
  res.json({ message: '예산 데이터가 초기화되었습니다.' });
});

// ── 개인별 급여 상세(계획용, 3단계 자료 연계의 1단계) ──────────────────────────
// 직원별·연도별로 표준 판관비 항목(급여 세부/복리후생비/RSU 등) 각각의 연간 금액을
// 입력해두는 화면의 백엔드. 민감한 개인별 급여 정보라 조회·입력 모두 관리자 전용.
router.get('/emp-pay-plan', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const companyId = req.auth.companyId || null;
  const data = await readBudget(companyId);
  const year = req.query.year ? Number(req.query.year) : null;
  const plans = year ? data.empPayPlans.filter(p => p.year === year) : data.empPayPlans;
  res.json({ ok: true, plans });
});

router.post('/emp-pay-plan', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const companyId = req.auth.companyId || null;
  const body = req.body || {};
  const empId = body.empId;
  const year = Number(body.year);
  if (empId === undefined || empId === null || !Number.isFinite(year)) {
    return res.status(400).json({ error: 'empId와 year는 필수입니다.' });
  }
  if (!Array.isArray(body.items)) return res.status(400).json({ error: 'items는 배열이어야 합니다.' });
  const rawItems = body.items.map(it => ({
    category: (it && it.category) || '',
    name: (it && it.name) || '',
    amount: Number(it && it.amount) || 0,
  })).filter(it => it.name);
  const items = rawItems.filter(it => it.amount !== 0);
  // mode:'merge' — 엑셀 업로드처럼 "파일에 있는 항목만" 반영해야 하는 경우.
  // 기본(mode 없음)은 기존처럼 전체 교체 = 화면 그리드가 36개 항목을 모두 제출하는
  // 정상 경로이며, 사용자가 어떤 항목을 일부러 비운 것도 그대로 반영돼야 하므로 옳다.
  // 그런데 엑셀 업로드는 헤더 이름이 표준 항목명과 완전히 일치하는 열만 인식하므로,
  // 열 제목에 공백 하나만 달라도 그 항목이 인식되지 않는다 — 전체 교체로 처리하면
  // 36개가 저장된 직원에게 1개 열만 인식된 파일을 올렸을 때 나머지 35개가 조용히
  // 사라진다(실측 지적). merge에서는 파일에 실제로 등장한 항목명만 갱신하고,
  // 파일에서 0으로 명시한 항목은 삭제로 간주한다(등장하지 않은 항목은 그대로 보존).
  const mergeMode = body.mode === 'merge';
  const presentNames = new Set(rawItems.map(it => it.name));
  // 퇴직급여 증가분 자동계산에 쓰이는 개인별 파라미터 — items와 별개로 저장(계산에
  // 필요한 "가정값"일 뿐 그 자체가 판관비 라인 항목은 아님).
  const severanceType = body.severanceType === 'DB' ? 'DB' : (body.severanceType === 'DC' ? 'DC' : null);
  const severanceMultiplier = body.severanceMultiplier !== undefined ? (Number(body.severanceMultiplier) || 1) : undefined;
  const severanceBaseline = body.severanceBaseline !== undefined ? (Number(body.severanceBaseline) || 0) : undefined;

  let resultPlans;
  await updateBudget(companyId, async (data) => {
    const existing = data.empPayPlans.find(p => String(p.empId) === String(empId) && p.year === year);
    const now = new Date().toISOString();
    if (existing) {
      existing.empName = body.empName || existing.empName;
      if (mergeMode) {
        const kept = (existing.items || []).filter(prev => !presentNames.has(prev.name));
        existing.items = kept.concat(items);
      } else {
        existing.items = items;
      }
      if (severanceType !== null || body.severanceType !== undefined) existing.severanceType = severanceType;
      if (severanceMultiplier !== undefined) existing.severanceMultiplier = severanceMultiplier;
      if (severanceBaseline !== undefined) existing.severanceBaseline = severanceBaseline;
      existing.updatedAt = now;
    } else {
      data.empPayPlans.push({
        id: `epp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        empId, empName: body.empName || '', year, items,
        severanceType, severanceMultiplier: severanceMultiplier !== undefined ? severanceMultiplier : 1, severanceBaseline: severanceBaseline || 0,
        createdAt: now, updatedAt: now,
      });
    }
    resultPlans = data.empPayPlans.filter(p => p.year === year);
  });
  res.json({ ok: true, plans: resultPlans });
});

// 개인별 급여 상세 자동계산(퇴직급여 증가분, 4대보험+주민세)에 쓰이는 요율 설정 —
// admin 전용(설정 조회 자체가 emp-pay-plan 화면 전용 정보이므로 조회 화면과 동일한
// 인가 수준을 맞춘다).
router.get('/emp-pay-plan/settings', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const data = await readBudget(req.auth.companyId || null);
  res.json({ ok: true, settings: data.empPayPlanSettings });
});
router.post('/emp-pay-plan/settings', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const companyId = req.auth.companyId || null;
  const body = req.body || {};
  let resultSettings;
  await updateBudget(companyId, async (data) => {
    if (body.severance) {
      data.empPayPlanSettings.severance = {
        dcRate: Number(body.severance.dcRate) || 0,
        dbMonthsPerYear: Number(body.severance.dbMonthsPerYear) || 0,
      };
    }
    if (body.socialInsurance) {
      data.empPayPlanSettings.socialInsurance = {
        pension: Number(body.socialInsurance.pension) || 0,
        health: Number(body.socialInsurance.health) || 0,
        longTermCare: Number(body.socialInsurance.longTermCare) || 0,
        employment: Number(body.socialInsurance.employment) || 0,
        localTax: Number(body.socialInsurance.localTax) || 0,
      };
    }
    resultSettings = data.empPayPlanSettings;
  });
  res.json({ ok: true, settings: resultSettings });
});

// 사업계획 그리드의 자동입력 버튼(전 역할 공개)이 쓰는 조회 — 관리자 전용 목록 조회와
// 달리 요청자가 명시적으로 지정한 empId들의 항목만 반환한다. 클라이언트는 이미 전체
// employees[] 배열(연봉 포함, 이 앱에서 기존부터 전 역할에 공개되어 온 정보)을 들고 있어
// "이 팀 소속 직원 id 목록"을 스스로 판단할 수 있으므로, 그 id들에 한해서만 상세 항목을
// 내려준다(회사 전체 개인별 급여 상세를 한 번에 열람하는 것은 여전히 관리자 전용).
router.get('/emp-pay-plan/by-ids', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const companyId = req.auth.companyId || null;
  const year = req.query.year ? Number(req.query.year) : null;
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!year || !ids.length) return res.json({ ok: true, plans: [] });
  const data = await readBudget(companyId);
  const plans = data.empPayPlans.filter(p => p.year === year && ids.includes(String(p.empId)));
  res.json({ ok: true, plans });
});

router.delete('/emp-pay-plan/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const companyId = req.auth.companyId || null;
  const found = await updateBudget(companyId, async (data) => {
    const idx = data.empPayPlans.findIndex(p => p.id === req.params.id);
    if (idx === -1) return false;
    data.empPayPlans.splice(idx, 1);
    return true;
  });
  if (!found) return res.status(404).json({ error: '데이터를 찾을 수 없습니다.' });
  res.json({ ok: true });
});

module.exports = function budgetRouterFactory(deps) {
  deps = deps || {};
  const getEmployeeProfile = deps.getEmployeeProfile || (async () => null);
  // 팀명 → 그 팀이 소속된 부문/사업부/센터를 재직자 dept 필드로 역산 조회. 예산(비인건비)
  // 엑셀의 "비용 귀속" 컬럼에 팀이 스스로의 이름을 적는(자기 자신을 비용귀속으로 표기)
  // 관행이 있어, 그걸 그대로 쓰면 그 팀 이름이 "경영지원본부" 같은 실제 상위 조직과
  // 나란한 별도의 비용귀속부문 버킷으로 잡혀 사업부 단위 롤업이 쪼개지는 문제가 있었다
  // (실사용자 보고: "인사팀이 별도로 있어서 중복 합산되는 것 같다"). 미주입 시(테스트 등)
  // null만 반환 — 아래 로직은 이 경우 팀명을 그대로 쓰는 기존 동작으로 자연 폴백한다.
  const getTeamDept = deps.getTeamDept || (async () => null);
  // 회사의 비용 계정과목(코드+이름) 목록 — 예산 시트·조직별 비용 블록 업로드 시 "비용계정"
  // 필드가 비어있으면 항목명으로 자동 매칭해 채우는 데 쓴다. 미주입 시(테스트 등) 빈
  // 배열만 반환 — 아래 매칭 로직은 이 경우 아무것도 채우지 않고 조용히 넘어간다(기존
  // "예산 항목 관리" 화면의 수동 검색선택으로 채울 수 있으므로 실패해도 안전).
  const getExpenseAccounts = deps.getExpenseAccounts || (async () => []);

  // ── 사업계획 워크플로우 설정(예산담당자/기획팀장 지정, 입력기간 on/off) ──────────

  // 아무 로그인 사용자나 조회 가능 — 팀원이 "지금 입력 가능한지"를 알아야 하므로 admin
  // 전용으로 가두지 않는다. ownerIds/teamLeaderId 자체(누가 담당자인지)를 아는 것도
  // 민감정보가 아니다(오히려 몰라야 문의를 못 함).
  router.get('/business-plan/settings', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const data = await readBudget(req.auth.companyId || null);
    res.json({ ok: true, settings: data.budgetPlanSettings });
  });

  // 예산담당자/기획팀장 지정 자체는 관리자만(민감한 권한 부여이므로 다른 지정 패턴
  // — 저성과자 관리 뷰어 등 — 과 동일하게 admin 전용).
  router.post('/business-plan/settings/roster', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const body = req.body || {};
    if (body.ownerIds !== undefined && !Array.isArray(body.ownerIds)) {
      return res.status(400).json({ error: 'ownerIds는 배열이어야 합니다.' });
    }
    let resultSettings;
    await updateBudget(companyId, async (data) => {
      if (body.ownerIds !== undefined) data.budgetPlanSettings.ownerIds = body.ownerIds.map(String);
      if (body.teamLeaderId !== undefined) {
        data.budgetPlanSettings.teamLeaderId = body.teamLeaderId === null ? null : String(body.teamLeaderId);
      }
      resultSettings = data.budgetPlanSettings;
    });
    res.json({ ok: true, settings: resultSettings });
  });

  // 입력기간 on/off: 예산담당자·기획팀장·관리자만(사용자 요청 그대로).
  router.post('/business-plan/settings/input-window', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const isAdmin = req.auth.role === 'admin';
    const open = !!(req.body && req.body.inputOpen);
    let forbidden = false, resultSettings;
    await updateBudget(companyId, async (data) => {
      if (!_isBudgetOwner(isAdmin, data.budgetPlanSettings, req.auth.empId) && !_isPlanningLead(isAdmin, data.budgetPlanSettings, req.auth.empId)) {
        forbidden = true;
        return;
      }
      data.budgetPlanSettings.inputOpen = open;
      resultSettings = data.budgetPlanSettings;
    });
    if (forbidden) return res.status(403).json({ error: '예산담당자, 기획팀장, 관리자만 입력기간을 설정할 수 있습니다.' });
    res.json({ ok: true, settings: resultSettings });
  });

  // ── 사업계획(팀별 작성 → 사업부장 승인 → 예산담당자+기획팀장 최종확정) ──────────

  // 로그인한 사용자 본인의 dept/team/role — 토큰(payload)에는 empId/role/companyId만 있고
  // dept/team이 없어서, budget.html이 "사업부장 승인" 버튼처럼 dept 기준 권한을 화면에서
  // 미리 판단하려면 이 정보가 필요하다(QA에서 발견: 권한 없는 사용자에게도 승인 버튼이
  // 노출되던 문제 — 서버 인가 자체는 항상 정확했지만 UI가 사전 판단할 재료가 없었음).
  router.get('/business-plan/my-profile', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const profile = await getEmployeeProfile(companyId, req.auth.empId);
    res.json({ ok: true, profile });
  });

  // 목록 조회: 관리자/예산담당자/기획팀장은 전체, 사업부장은 자기 dept, 팀원/팀장은
  // 자기 dept+team 계획만 본다.
  router.get('/business-plan', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const data = await readBudget(companyId);
    const isAdmin = req.auth.role === 'admin';
    const profile = await getEmployeeProfile(companyId, req.auth.empId);
    const visible = data.businessPlans.filter(p => _canViewPlan(isAdmin, profile, data.budgetPlanSettings, req.auth.empId, p));
    // budgetComparison은 저장된 값이 아니라 조회 시점 실제 업로드 데이터 기준으로 매번
    // 재계산(계획 저장 이후에도 실적 업로드가 바뀔 수 있으므로) — 응답에만 얹고 저장하지 않음.
    const plans = visible.map(p => ({ ...p, ..._freshPlanCalc(p), budgetComparison: computeBudgetComparison(data, p) }));
    res.json({ ok: true, plans });
  });

  // 회사/사업부 롤업: 팀별 계획(dept가 있는 것만, 레거시 스크래치 계획은 제외)을 연도(절대
  // 연도) 기준으로 합산한다. 기본은 사업부장 승인 이상(divisionApproved/finalConfirmed)만
  // 반영 — "회사 전체 예산을 취합·관리"한다는 요청 취지상 draft(미승인) 숫자가 섞이면
  // 신뢰할 수 없는 집계가 되기 때문. ?includeDraft=true로 draft까지 포함해 볼 수 있다.
  // 접근: 관리자/예산담당자/기획팀장은 전체, 사업부장은 자기 dept만.
  router.get('/business-plan/rollup', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const data = await readBudget(companyId);
    const isAdmin = req.auth.role === 'admin';
    const isFullAccess = isAdmin
      || _isBudgetOwner(isAdmin, data.budgetPlanSettings, req.auth.empId)
      || _isPlanningLead(isAdmin, data.budgetPlanSettings, req.auth.empId);
    const profile = await getEmployeeProfile(companyId, req.auth.empId);
    const isDirector = profile && profile.role === 'director';
    if (!isFullAccess && !isDirector) {
      return res.status(403).json({ error: '접근 권한이 없습니다.' });
    }
    const includeDraft = req.query.includeDraft === 'true';
    let scoped = data.businessPlans.filter(p => p.dept);
    if (!isFullAccess) scoped = scoped.filter(p => p.dept === profile.dept);
    if (!includeDraft) scoped = scoped.filter(p => p.status === 'divisionApproved' || p.status === 'finalConfirmed');
    // P&L 롤업(_rollup/byDept)이 저장된 스냅샷이 아니라 항상 최신 계산식 기준의 projection을
    // 쓰도록 신선화 — _freshPlanCalc() 주석 참고(계산식이 바뀌면 예전 계획도 재저장 없이
    // 곧바로 올바르게 집계됨). sgaByCostDept 등은 assumptions.sgaItems를 직접 쓰므로
    // 이 신선화와 무관하게 이미 항상 최신값이다.
    scoped = scoped.map(p => ({ ...p, ..._freshPlanCalc(p) }));

    function _rollup(plans) {
      const byYear = {};
      plans.forEach(p => (p.projection || []).forEach(r => {
        if (!byYear[r.year]) byYear[r.year] = { year: r.year, revenue: 0, cogs: 0, cogsFromRatio: 0, serviceCost: 0, grossProfit: 0, sga: 0, rdExpense: 0, operatingProfit: 0, netIncome: 0, freeCashFlow: 0 };
        const acc = byYear[r.year];
        acc.revenue += r.revenue || 0; acc.cogs += r.cogs || 0; acc.cogsFromRatio += r.cogsFromRatio || 0; acc.serviceCost += r.serviceCost || 0; acc.grossProfit += r.grossProfit || 0;
        acc.sga += r.sga || 0; acc.rdExpense += r.rdExpense || 0; acc.operatingProfit += r.operatingProfit || 0; acc.netIncome += r.netIncome || 0;
        acc.freeCashFlow += r.freeCashFlow || 0;
      }));
      return Object.values(byYear).map(r => ({
        ...r, revenue: round2(r.revenue), cogs: round2(r.cogs), cogsFromRatio: round2(r.cogsFromRatio), serviceCost: round2(r.serviceCost), grossProfit: round2(r.grossProfit),
        sga: round2(r.sga), rdExpense: round2(r.rdExpense), operatingProfit: round2(r.operatingProfit), netIncome: round2(r.netIncome),
        freeCashFlow: round2(r.freeCashFlow)
      })).sort((a, b) => a.year - b.year);
    }

    const depts = [...new Set(scoped.map(p => p.dept))];
    const byDept = depts.map(dept => {
      const deptPlans = scoped.filter(p => p.dept === dept);
      return {
        dept,
        planCount: deptPlans.length,
        plans: deptPlans.map(p => ({ id: p.id, name: p.name, team: p.team, status: p.status, planType: p.planType })),
        projection: _rollup(deptPlans)
      };
    });

    // sgaByCostDept/sgaByCategory/sgaByAccountType/sgaByExpenseAccount는 전부 화면에
    // "(기준연도)"로 표시되는, 한 해 예산을 보기 위한 표다 — 그런데 baseAmount는 각 항목이
    // 속한 계획의 baseYear 한 해 치 금액인데도 이 네 집계는 scoped(연도 필터 없음, 여러
    // 연도의 계획이 함께 존재할 수 있음)를 그대로 넘겨받아 연도 구분 없이 전부 더하고
    // 있었다 — 회사가 2027년·2028년 계획을 동시에 갖고 있으면(당연히 있을 수 있는 정상
    // 상황, 미리 다음 해 계획을 세워두는 것) "기준연도" 표라면서 실제로는 두 해 예산을
    // 합산해 "전사 합계"가 정확히 2배로 부풀어 보이는 문제였다(사용자 보고: "계속 중복으로
    // 올려서 중첩된 것 아니냐" — 실측 결과 항목 자체의 중복이 아니라 이 집계 함수들이
    // 연도를 안 가리는 것이 원인이었음, 회사 전체 P&L(company.projection)은 연도별로
    // 이미 올바르게 나뉘어 있어 이 문제가 없었음). ?year=를 받으면 이 네 집계만 그 연도의
    // 계획으로 한정 — byDept/company.projection은 기존처럼 연도별 추이를 그대로 보여줘야
    // 하므로(의도된 기능) 그쪽은 건드리지 않는다. year 파라미터를 생략하면(레거시 호출부)
    // 기존과 동일하게 전체 연도 합산 동작 유지.
    const sgaYear = req.query.year ? Number(req.query.year) : null;
    const sgaScoped = sgaYear ? scoped.filter(p => p.baseYear === sgaYear) : scoped;
    // sgaByCostDept: 위 byDept/company(P&L 롤업)와 별개로, 판관비 항목만 "비용 귀속
    // 부문" 기준으로 재집계 — 계획을 작성한 팀과 실제 비용 귀속 부문이 다른 경우에도
    // 전사 합계와 부문별 실집계를 함께 확인할 수 있게 한다.
    const sgaByCostDept = _sgaRollupByCostDept(sgaScoped);
    // sgaByCategory: 3단계 자료 연계(개인별 급여→팀별 그리드→부문별 집계표)의 마지막
    // 단계 — 판관비 항목을 "구분"(급여/복리후생비/교육훈련비/사회보험 등)별로 나눈 뒤
    // 그 안에서 다시 비용귀속부문 기준으로 집계.
    const sgaByCategory = _sgaRollupByCategory(sgaScoped);
    // sgaByAccountType/sgaByExpenseAccount: sgaByCategory와 동일한 구조로, "구분" 대신
    // 각각 계정과목(판관/용역/경상)·비용계정(실제 회계 계정과목) 기준으로 재집계한 것.
    const sgaByAccountType = _sgaRollupByAccountType(sgaScoped);
    const sgaByExpenseAccount = _sgaRollupByExpenseAccount(sgaScoped);

    res.json({ ok: true, includeDraft, sgaYear, byDept, company: { planCount: scoped.length, projection: _rollup(scoped) }, sgaByCostDept, sgaByCategory, sgaByAccountType, sgaByExpenseAccount });
  });

  // 항목별 실적 참고(신규 자동화, 작성 단계 실시간 안내): 사업계획 작성/수정 폼에서 판관비
  // 항목을 입력하는 동안, 같은 부문/팀의 budget.html 업로드 실적(data.items, category==="판관")을
  // 항목명 기준으로 집계해 참고 금액으로 보여준다. 기존 computeBudgetComparison()이 계획
  // "전체" 판관비 합계 대 실적 합계만 비교하던 것(조회 시점의 읽기전용 카드에만 노출)의
  // 항목 단위 세분화 버전 — 이미 응답으로 노출되던 총액 비교를 항목 단위로 더 잘게 쪼갠
  // 것일 뿐이라 별도의 새로운 정보 노출은 아니다. 접근 권한은 _canViewPlan()과 동일한
  // 기준(관리자/예산담당자/기획팀장 전체, 그 부문 사업부장, 그 부문+팀 소속 본인)을
  // dept/team 문자열 기준으로 재현 — 계획이 아직 생성되기 전(신규 작성 중)에도 쓸 수
  // 있어야 하므로 plan id가 아니라 dept/team 쿼리 파라미터를 받는다.
  function _actualsByItemForDeptTeam(data, dept, team) {
    const filtered = (data.items || []).filter(i =>
      i.category === '판관' && i.dept === dept && (!team || (i.team || '') === team)
    );
    const map = {};
    filtered.forEach(i => {
      const key = i.account || '(미상)';
      if (!map[key]) map[key] = { name: key, total: 0 };
      map[key].total += i.amount || 0;
    });
    return Object.values(map).map(r => ({ ...r, total: round2(r.total) })).sort((a, b) => b.total - a.total);
  }
  router.get('/business-plan/actuals-by-item', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const dept = (req.query.dept || '').trim();
    const team = (req.query.team || '').trim();
    if (!dept) return res.json({ ok: true, items: [] });
    const isAdmin = req.auth.role === 'admin';
    const data = await readBudget(companyId);
    const profile = await getEmployeeProfile(companyId, req.auth.empId);
    const allowed = isAdmin
      || _isBudgetOwner(isAdmin, data.budgetPlanSettings, req.auth.empId)
      || _isPlanningLead(isAdmin, data.budgetPlanSettings, req.auth.empId)
      || (profile && profile.dept === dept && (!team || (profile.team || '') === team))
      || (profile && profile.role === 'director' && profile.dept === dept);
    if (!allowed) return res.status(403).json({ error: '조회 권한이 없습니다.' });
    res.json({ ok: true, items: _actualsByItemForDeptTeam(data, dept, team) });
  });

  // 예산(비인건비 판관/용역/경상) 엑셀 일괄 업로드 — 관리자 전용. 열 구성: "팀명"(필수,
  // 사업계획을 이미 작성한 팀 이름과 정확히 일치해야 매칭됨) + "비용 귀속"(선택, 비우면
  // 팀명의 부문과 동일하게 취급) + "항목"(예: "(판)지급수수료" — 앞의 (판)/(용)/(경) 접두는
  // 제거하고 저장) + "세부내역" + "구분"(판관/용역/경상, 필수) + "1월"~"12월". 각 행을
  // 팀명 기준으로 묶어 그 팀의 baseYear=year인 사업계획을 찾아 sgaItems에 upsert한다(이름이
  // 같은 기존 행이 있으면 갱신, 없으면 새 행 추가) — 개인별 급여상세 자동입력과 동일한
  // "이름 기준 upsert" 방식이라, 같은 이름의 행을 개인급여상세 자동입력이 이미 채워뒀다면
  // 그 행이 이 업로드로 덮어써질 수 있음(이 코드베이스 전반에서 이미 통용되는 "한 이름당
  // 한 행" 관례를 그대로 따름 — 필요하면 업로드 후 그리드에서 직접 조정). 해당 연도·팀명의
  // 계획이 없거나(먼저 그 팀이 사업계획을 작성해야 함) 여러 건이라 특정할 수 없으면 그
  // 팀은 건너뛰고 이유를 응답에 담는다. 반영 즉시 그 팀의 손익 추정치가 재계산되고,
  // 사업부/회사 롤업(3단계 집계)에도 자동으로 연계된다.
  // 엑셀 → byTeam({팀명: [{name,detail,accountType,costDept,months}]}) 파싱 로직을 별도
  // 함수로 분리 — /parse(미리보기, 저장 없음)와 과거 즉시저장 방식 양쪽에서 재사용하기 위함.
  // 인식하지 못한 행은 예전엔 조용히 버려졌다 — 8행 중 5행이 사유도 개수도 없이 사라지고,
  // 전 행이 걸러지면 화면에 안내 문구 한 줄만 남아 "업로드했는데 아무 일도 안 일어난다"로
  // 보였다(실측). 버린 행을 사유와 함께 모아 호출부가 사용자에게 보여줄 수 있게 한다.
  function _parseSgaUploadRows(rows, dropped) {
    const byTeam = {};
    const drop = (row, reason) => {
      if (!Array.isArray(dropped)) return;
      if (dropped.length >= 50) return; // 너무 많으면 앞부분만 (응답 비대화 방지)
      dropped.push({
        row: row.__rowNum__ !== undefined ? row.__rowNum__ + 1 : undefined,
        team: String(row['팀명'] || row['팀'] || '').trim(),
        name: String(row['항목'] || '').trim(),
        category: row['구분'] === undefined ? '' : String(row['구분']).trim(),
        reason
      });
    };
    rows.forEach(row => {
      const team = String(row['팀명'] || row['팀'] || '').trim();
      const accountType = row['구분'];
      if (!team) { drop(row, '팀명이 비어 있음'); return; }
      if (!accountType || !CATEGORIES.includes(accountType)) {
        drop(row, `구분이 ${CATEGORIES.join('/')} 중 하나여야 함(현재: "${accountType === undefined ? '' : String(accountType).trim()}")`);
        return;
      }
      const rawName = String(row['항목'] || '').trim();
      const name = rawName.replace(/^\((판|용|경)\)/, '').trim();
      if (!name) { drop(row, '항목명이 비어 있음'); return; }
      const detail = String(row['세부내역(산정근거)'] || row['세부내역'] || '').trim();
      const costDept = String(row['비용 귀속'] || row['비용귀속'] || row['비용 귀속 부문'] || row['비용귀속부문'] || '').trim();
      const months = MONTHS.map(m => toNumber(row[`${m}월`]) || 0);
      (byTeam[team] = byTeam[team] || []).push({ name, detail, accountType, costDept, months });
    });
    return byTeam;
  }

  // 팀 하나의 항목 배열(items)을 실제로 사업계획에 반영(생성 또는 upsert)하는 공용 로직.
  // 업로드 즉시저장이 아니라 "업로드 → 미리보기에서 조정 → 저장" 흐름으로 바뀌면서, 이
  // 로직이 두 곳(엑셀 커밋/검색화면에서의 수동 저장)에서 공유된다. 잠긴(draft가 아닌)
  // 기존 계획은 여기서 직접 덮어쓰지 않고 skip 사유를 반환한다(수정요청 절차를 우회하지
  // 않기 위함 — 예전 즉시저장 업로드는 이 검사가 없어 잠긴 계획도 조용히 덮어쓸 수
  // 있었던 결함이 있었는데, 미리보기·검색편집 화면 신설을 계기로 함께 바로잡음).
  // "비용 귀속" 컬럼은 팀명 컬럼과 완전히 같은 문자열로 자기참조하지 않는 경우가 실제로
  // 흔하다 — 실사용자 원본 파일에서 "팀명"은 "인사"인데 "비용 귀속"은 "인사팀"(끝에 "팀"만
  // 붙임)이었음. 끝에 붙는 "팀" 접미사 유무만 정규화해 비교한다("팀"만 벗기는 이유: "R&BD
  // 센터"/"엔지니어링솔루션사업부"처럼 실제로 다른 조직을 가리키는 값에서 "센터"/"사업부"
  // 등 다른 접미사까지 벗기면 서로 다른 조직명이 우연히 같아져 오탐할 위험이 있어, 이
  // 자기참조 패턴에서 실제로 관찰된 "팀" 접미사 하나만 좁게 취급한다).
  function _normalizeTeamNameForSelfRef(s) {
    return String(s || '').trim().replace(/팀$/, '');
  }
  function _isSelfReferentialCostDept(costDept, team) {
    if (!costDept || !team) return false;
    return _normalizeTeamNameForSelfRef(costDept) === _normalizeTeamNameForSelfRef(team);
  }
  // 이 로직 도입 이전에 costDept가 팀 자기 자신의 이름(또는 그 변형)으로 저장된 기존
  // 항목을, plan.dept가 바로잡힌 시점에 함께 바로잡는다(그러지 않으면 재업로드 시
  // _upsertSgaItem의 매칭 키가 안 맞아 옛 "인사팀" 버킷 항목은 그대로 남고 새 "경영지원
  // 부문" 항목이 중복 생성됨).
  function _migrateSelfReferentialCostDept(sgaItems, team, dept) {
    if (!dept || _isSelfReferentialCostDept(dept, team)) return;
    (sgaItems || []).forEach(it => { if (_isSelfReferentialCostDept(it.costDept, team)) it.costDept = dept; });
  }
  // 항목들의 costDept 값 중 팀 자기 자신을 가리키는 값(변형 포함)을 제외한 나머지(실제로
  // 다른 조직명이 명시된 값)만으로 최빈값을 구한다 — getTeamDept()로 재직자 기준 실제
  // 소속을 못 찾았을 때의 폴백. 자기참조는 애초에 유의미한 조직 정보가 아니므로 제외.
  function _inferPlanDeptFromItems(items, team) {
    const costDeptCounts = {};
    items.forEach(it => { const cd = (it.costDept || '').trim(); if (cd && !_isSelfReferentialCostDept(cd, team)) costDeptCounts[cd] = (costDeptCounts[cd] || 0) + 1; });
    return Object.keys(costDeptCounts).sort((a, b) => costDeptCounts[b] - costDeptCounts[a])[0] || null;
  }
  // teamDeptCache: {team: dept|null} — 반드시 호출부가 updateBudget()의 잠금(트랜잭션)에
  // 진입하기 *전에* getTeamDept()로 미리 채워 넣어야 한다. 예전에는 이 함수가 필요할 때마다
  // (신규 계획 생성 시·자가치유 시) 그 자리에서 직접 `await getTeamDept(companyId, team)`을
  // 호출했는데, getTeamDept()→server.js의 loadData()는 내부적으로 employees/kpi_entries/
  // app_collections/app_singletons를 Promise.all로 동시 조회하는 별도의 4개 pool.query()
  // 호출이다 — 즉 이 함수가 이미 updateBudget()의 SELECT...FOR UPDATE로 budget_store 행을
  // 잠근 채(pg 커넥션 풀에서 커넥션 1개를 이미 점유한 상태) "그 안에서" 추가로 커넥션을
  // 4개 더 요청하는 구조였다. 여러 신규 팀(사업계획이 아직 없는 팀)을 동시에 여러 명이
  // 업로드하는 등, 이 코드경로를 동시에 타는 요청 수가 커넥션 풀 크기(db.js의 `max:20`)에
  // 근접·초과하면, 이미 트랜잭션을 열고 커넥션을 점유한 요청들이 각자 loadData()의 추가
  // 커넥션을 서로 기다리며 자기 자신들끼리 커넥션 풀을 고갈시키는 자기교착(self-deadlock)이
  // 실제로 재현됨(로컬 PostgreSQL, 신규 회사 8곳×동시 신규팀 10건=80개 동시 요청으로 실측 —
  // pg-pool이 `connectionTimeoutMillis`(5초) 뒤 "timeout exceeded when trying to connect"로
  // 에러를 던지고, 이 라우트들(sga-upload/commit 등)은 updateBudget() 호출에 try/catch가
  // 없어 그 에러가 처리되지 않은 프로미스 거부로 전역 안전망에만 잡혀 로그로 남을 뿐 그
  // 요청에 대한 HTTP 응답을 영영 보내지 않아 — 브라우저는 응답을 무한정 기다리며 멈춘 것처럼
  // 보임). budget_store 자체의 데이터는 항상 정상적으로 롤백돼 손상되지 않았지만(트랜잭션
  // 전체가 실패하므로 부분 반영·중복 생성은 없었음), 요청이 응답 없이 멈추는 것은 실사용에서
  // 명백한 장애다. 해결책은 이 함수가 잠금 "안에서" 다시 조회하지 않는 것 — 호출부(현재는
  // sga-upload/commit·cost-block-upload 두 곳)가 관련된 모든 team의 dept를 updateBudget()
  // 호출 *전에* 한 번에 조회해 이 캐시에 담아 넘긴다. 캐시에 없는 team이 들어오면(호출부가
  // 누락했거나 테스트 등) 안전하게 null로 취급해 기존 폴백(_inferPlanDeptFromItems/팀명
  // 그대로)으로 자연스럽게 이어진다 — 이 함수 자체는 다시 getTeamDept()를 호출하지 않는다.
  // userName은 변경 이력(history[]) 기록용 표시 이름 — 호출부가 getEmployeeProfile()로
  // 미리 조회해 넘긴다(이 함수 자체는 employees 조회 권한이 없어 잠금 밖에서 해야 함은
  // teamDeptCache와 동일한 이유).
  async function _commitSgaTeamItems(data, companyId, year, team, items, req, teamDeptCache, userName, expenseAccounts) {
    const cache = teamDeptCache || {};
    // 비용계정이 비어있는 항목은 항목명으로 자동 추정해 채운다(사용자 요청: "비용 계정에
    // 공백으로 뜨는 부분을 항목에 맞게 매치") — 확신할 수 있는 매칭만 채우고, 못 찾으면
    // 기존과 동일하게 빈 값으로 남겨 "예산 항목 관리"에서 직접 검색선택하게 한다.
    if (Array.isArray(expenseAccounts) && expenseAccounts.length) {
      items.forEach(it => { if (!it.expenseAccount) it.expenseAccount = _guessExpenseAccount(it.name, expenseAccounts); });
    }
    const matches = data.businessPlans.filter(p => p.baseYear === year && (p.team || '').trim() === team);
    let plan, autoCreated = false;
    if (matches.length === 0) {
      const resolvedTeamDept = Object.prototype.hasOwnProperty.call(cache, team) ? cache[team] : null;
      const inferredDept = resolvedTeamDept || _inferPlanDeptFromItems(items, team) || team;
      const { assumptions: newA } = _normalizeBusinessPlanInput({ name: `${team} ${year}년 예산업로드`, baseYear: year, years: 1, planType: 'costOnly' }, null);
      const now = new Date().toISOString();
      plan = {
        id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: newA.name, baseYear: newA.baseYear, years: newA.years, scenario: newA.scenario, planType: newA.planType,
        dept: inferredDept, team,
        status: 'draft', divisionApproval: null,
        finalApproval: { ownerBy: null, ownerAt: null, leadBy: null, leadAt: null },
        editRequest: null,
        assumptions: { baseRevenue: newA.baseRevenue, revenueGrowthRate: newA.revenueGrowthRate, cogsRatio: newA.cogsRatio, sgaItems: [], taxRate: newA.taxRate, depreciation: newA.depreciation },
        projection: [], breakEven: {},
        createdBy: req.auth.empId !== undefined ? req.auth.empId : null,
        createdAt: now, updatedAt: now, history: []
      };
      _pushPlanHistory(plan, '등록(예산 업로드로 자동 생성)', userName);
      data.businessPlans.push(plan);
      autoCreated = true;
    } else if (matches.length > 1) {
      return { skip: true, reason: `${year}년 기준 팀명 "${team}"에 해당하는 사업계획이 ${matches.length}건이라 자동으로 특정할 수 없습니다.` };
    } else {
      plan = matches[0];
      if (plan.status !== 'draft') {
        return { skip: true, reason: `승인되어 잠긴 계획입니다. 수정요청을 보내 관리자 승인을 받은 뒤 반영할 수 있습니다.` };
      }
      // 자가치유: 예전에(이 로직 추가 이전) dept가 팀 자기 자신의 이름으로 잘못 저장된
      // 계획이면, 재업로드 시점에 실제 소속 조직으로 바로잡는다.
      if (_isSelfReferentialCostDept(plan.dept, team)) {
        const resolvedTeamDept = Object.prototype.hasOwnProperty.call(cache, team) ? cache[team] : null;
        const fixedDept = resolvedTeamDept || _inferPlanDeptFromItems(items, team);
        if (fixedDept && fixedDept !== plan.dept) plan.dept = fixedDept;
      }
    }
    const dept = plan.dept;
    if (!plan.assumptions) plan.assumptions = {};
    if (!Array.isArray(plan.assumptions.sgaItems)) plan.assumptions.sgaItems = [];
    const sgaItems = plan.assumptions.sgaItems;
    _migrateSelfReferentialCostDept(sgaItems, team, dept);
    const note = `예산(비인건비) 반영(${new Date().toISOString().slice(0, 10)})`;
    const itemDetail = items.map(it => _upsertSgaItem(sgaItems, dept, team, it, note));
    const pruned = _pruneRedundantBudgetSummaryItems(sgaItems);
    const a = { baseYear: plan.baseYear, years: plan.years !== undefined ? plan.years : plan.projection.length, ...plan.assumptions };
    plan.projection = computeBusinessPlanProjection(a);
    plan.breakEven = computeBreakEven(a);
    plan.updatedAt = new Date().toISOString();
    plan.updatedBy = req.auth.empId;
    _pushPlanHistory(plan, '예산(비인건비) 엑셀 업로드 반영', userName,
      `${items.length}건 항목 반영` + (pruned.length ? ` · 조직별 비용 블록과 중복된 ${pruned.length}건 자동 제거(${pruned.map(p => p.detail || p.name).join(', ')})` : ''));
    return { skip: false, updated: { team, planId: plan.id, dept, itemCount: items.length, planStatus: plan.status, items: itemDetail, autoCreated, prunedDuplicates: pruned.length } };
  }

  // _commitSgaTeamItems()(팀명 기준 예산 업로드)와 조직별 비용 블록 업로드(아래
  // /cost-block-upload) 양쪽이 공유하는 "항목 하나를 sgaItems 배열에 upsert"하는 공용
  // 로직. 같은 항목명(예: "지급수수료")이 세부내역(거래처·용도 등)만 다른 채, 또는
  // 비용귀속부문만 다른 채(조직별 비용 블록 — 같은 "급여"가 부문마다 별도 줄로 존재) 한
  // 팀 안에 여러 줄로 실존하는 경우가 흔해 name만으로 매칭하면 서로 다른 지출 줄이 서로를
  // 덮어써 소실된다. accountType·costDept도 매칭 키에 포함한다 — costDept는 저장된 값이
  // 항상 "명시값 또는 팀 dept로 보정된 값"이므로, 비교 시에도 반드시 동일하게 보정한 값끼리
  // 비교해야 한다(그렇지 않으면 재업로드 시 매번 새 중복 항목이 생기는 버그가 됨 — 실측
  // 발견 후 수정). detail은 trim해서 비교(공백 차이로 인한 중복 생성 방지).
  // costDept가 비어있거나 팀 자기 자신의 이름과 같으면(엑셀의 "비용 귀속" 컬럼에 팀이
  // 스스로를 적는 관행) plan.dept(재직자 기준으로 해석된 실제 소속 조직)로 귀속시킨다 —
  // 그러지 않으면 "인사팀" 같은 팀 이름이 "경영지원본부" 같은 실제 상위 조직과 나란히
  // 별도의 비용귀속부문 버킷으로 잡혀 사업부 롤업이 쪼개지는 문제가 있었다(사용자 보고).
  function _upsertSgaItem(sgaItems, dept, team, it, note) {
    const resolvedCostDept = (it.costDept && !_isSelfReferentialCostDept(it.costDept, team)) ? it.costDept : dept;
    // 출처(예산 시트 / 조직별 비용 블록)가 다른 항목끼리는 절대 같은 항목으로 보지 않는다.
    // 예전에는 이름·세부내역·계정과목·팀·비용귀속부문만 비교해서, 두 시트가 같은 이름·같은
    // 부문의 줄을 갖고 있으면(예: "급여"의 비용귀속부문이 마침 plan.dept와 같아지는 흔한
    // 경우) 서로 덮어쓰면서 note(출처)까지 뒤바뀌었다. 그 결과 예산 시트를 다시 올리면
    // note가 "예산 반영"으로 뒤집힌 그 항목을 _pruneRedundantBudgetSummaryItems()가
    // "조직별에 같은 이름이 있으니 중복"으로 판단해 삭제해버려, 조직별로 분리해둔 부문
    // 금액이 통째로 사라졌다(실측 재현: 예산→조직별→예산 재업로드 순서에서 전략사업부
    // 급여가 소멸). 출처를 키에 포함하면 두 줄이 각자 유지되고, prune이 의도대로
    // "조직별 분해가 있으면 예산 시트의 합계 줄만 제거"하도록 안정적으로 동작한다.
    // 사람이 그리드에서 직접 만든 항목(note 없음/커스텀)은 어느 업로드와도 계속 매칭되게
    // 남겨둬야 기존처럼 업로드로 갱신할 수 있으므로, "반대편 출처"만 배제한다.
    const incomingIsCostBlock = _isCostBlockNote(note);
    const incomingIsBudget = _isBudgetUploadNote(note);
    const sourceCompatible = e => {
      if (incomingIsCostBlock) return !_isBudgetUploadNote(e.note);
      if (incomingIsBudget) return !_isCostBlockNote(e.note);
      return true;
    };
    const existing = sgaItems.find(e =>
      e.name === it.name && (e.detail || '').trim() === (it.detail || '').trim() &&
      e.accountType === it.accountType && (e.team || '') === team &&
      (e.costDept || dept) === resolvedCostDept && sourceCompatible(e)
    );
    const baseAmount = round2((it.months || []).reduce((s, v) => s + (v || 0), 0));
    const category = _guessSgaCategory(it.name);
    if (existing) {
      existing.dept = dept; existing.team = team; existing.costDept = resolvedCostDept;
      // 비용계정은 반대 우선순위: existing이 이미 값을 갖고 있으면(자동추정이든 사람이
      // 직접 검색선택으로 고쳤든) 그대로 유지하고, 비어있을 때만 이번 업로드의 값(자동
      // 추정 포함)으로 채운다 — 그러지 않으면 재업로드 때마다 자동 추정이 사람의 수동
      // 수정을 조용히 덮어써버리는 문제가 생긴다(다른 필드는 "새로 올라온 값이 항상
      // 이긴다"가 맞지만, 비용계정만은 "빈 값만 채운다"가 안전함).
      existing.detail = it.detail; existing.accountType = it.accountType; existing.expenseAccount = existing.expenseAccount || it.expenseAccount || '';
      existing.months = it.months; existing.baseAmount = baseAmount; existing.note = note;
      if (!existing.category) existing.category = category;
    } else {
      sgaItems.push({
        dept, team, costDept: resolvedCostDept, name: it.name, detail: it.detail,
        category: it.category || category, accountType: it.accountType, expenseAccount: it.expenseAccount || '', months: it.months,
        note, baseAmount, growthRate: 0, fixed: true
      });
    }
    return { name: it.name, detail: it.detail, accountType: it.accountType, costDept: resolvedCostDept, baseAmount };
  }

  // 실사용자 원본 파일 구조상, "예산" 시트(비인건비)에는 팀이 스스로 보고하는 항목 외에
  // 급여/인센티브/복리후생비/교육훈련비/사회보험/퇴직급여처럼 "조직별" 시트가 이미 부문별로
  // 쪼개서 제공하는 것과 **똑같은 총액**을 계정과목(판관/용역/경상) 기준으로만 재구성해
  // 중복으로 담고 있는 행이 실제로 존재함(사용자가 실제 배포 화면에서 발견·보고 — 예:
  // "사회보험(주민세 포함)" 항목이 인사팀의 경영지원부문 몫으로도 한 번, 조직별 시트의
  // 7개 사업부 몫으로도 한 번 더 잡혀 두 배로 집계됨. 손계산으로 두 합계가 소수점까지
  // 정확히 일치함을 확인해 우연이 아니라 같은 데이터의 이중 기재임을 확정). 이 항목들은
  // "예산" 시트의 세부내역(또는 세부내역이 없으면 항목명) 텍스트가 "조직별" 시트의 비용
  // 블록 이름표(예: "사회보험(주민세 포함)", "교육훈련비(휴넷,사외)", "퇴직급여", "급여")와
  // 정확히 일치한다는 공통점이 있어, 이를 근거로 자동 식별해 제거한다 — RSU 지급·인센티브
  // 등 세부내역이 비용 블록 이름표와 다른 항목(조직별 시트에 대응 항목이 없는 진짜 추가
  // 비용)은 정확히 일치하지 않으므로 그대로 남는다.
  //
  // note 접두어로만 판별해(_commitSgaTeamItems/cost-block-upload가 붙이는 고정 문자열)
  // 사용자가 그리드에서 직접 입력·수정한 항목은 절대 건드리지 않는다 — 자동 삭제는
  // "예산 엑셀 업로드로 자동 생성된" 항목에 한해서만, 그것도 지금 이 plan 안에 "조직별
  // 비용 블록 업로드로 자동 생성된" 대응 항목이 실제로 존재할 때만 적용된다. 업로드
  // 순서(예산 먼저／조직별 먼저)와 무관하게 항상 일관되게 정리되도록 두 라우트(
  // _commitSgaTeamItems·cost-block-upload) 양쪽 upsert 직후에 동일하게 호출한다.
  function _isBudgetUploadNote(note) { return typeof note === 'string' && note.startsWith('예산(비인건비) 반영'); }
  function _isCostBlockNote(note) { return typeof note === 'string' && note.startsWith('조직별 비용 블록 반영'); }
  function _pruneRedundantBudgetSummaryItems(sgaItems) {
    if (!Array.isArray(sgaItems) || !sgaItems.length) return [];
    const costBlockNames = new Set(
      sgaItems.filter(it => _isCostBlockNote(it.note)).map(it => (it.name || '').trim()).filter(Boolean)
    );
    if (!costBlockNames.size) return [];
    const removed = [];
    for (let i = sgaItems.length - 1; i >= 0; i--) {
      const it = sgaItems[i];
      if (!_isBudgetUploadNote(it.note)) continue;
      const key = (it.detail || it.name || '').trim();
      if (key && costBlockNames.has(key)) {
        removed.push(it);
        sgaItems.splice(i, 1);
      }
    }
    return removed;
  }

  // ── 진단 도구: 이력에 걸쳐 여러 번 바뀐 sgaItems 매칭 키(name → +detail → +accountType →
  // +team → +costDept 순으로 항목 추가) 때문에, 오래전(더 느슨한 키 시절)에 저장된 항목이
  // 오늘 코드의 더 엄격한 키로는 "기존 항목"으로 인식되지 못해 재업로드 시 그 옆에 새
  // 항목이 하나 더 생기고, 옛 항목은 그 후로 다시는 매칭되지 않아 영구히 고아로 남을 수
  // 있다는 우려(실사용자 문의)를 검증하기 위해 실제로 재현 테스트한 결과: `name`만 있고
  // `accountType`/`team`/`costDept`/`detail` 자체가 아예 없던 최초 스키마(2026-07-27
  // 최초 도입분) 항목, 또는 `accountType`/`expenseAccount`만 없던 중간 스키마(2026-07-28
  // 오전분) 항목은 정확히 이 방식으로 실제 중복을 만든다는 것을 확인했다(격리 테스트로
  // 재현). 반면 자기참조 costDept 미치유·세부내역 공백차이는 이미 healing 로직(위
  // _migrateSelfReferentialCostDept, trim 비교)이 매 업로드마다 자동으로 바로잡아 중복이
  // 생기지 않음도 함께 확인했다. 이 함수는 그 "여전히 위험할 수 있는 두 옛 스키마"를
  // 화면에서 사람이 직접 확인할 수 있게 하는 읽기전용 진단이다 — 절대 자동으로
  // 삭제·수정하지 않는다(실제 재무 데이터라 잘못 지우면 되돌릴 수 없음).
  //
  // 판정 기준(과잉 오탐 방지가 최우선 — 서로 다른 부문이 각자 별도로 갖는 "급여" 항목
  // 등 정상적으로 별개인 라인은 어떤 경우에도 플래그하면 안 된다):
  //  1) exactDuplicates: name + detail(trim) + accountType + team + costDept가 5개 필드
  //     전부 완전히 같은 항목이 2개 이상 — _upsertSgaItem()의 매칭 키 정의상 정상적인
  //     업로드/자동생성 경로로는 절대 발생할 수 없는 조합이다. 이게 하나라도 있다면 그
  //     자체로 명백한 버그(매칭 로직 결함이든, 수기 JSON 편집이든)의 증거다.
  //  2) staleSchemaFields: 오늘 코드의 upsert가 항상 채우는 필드(accountType/team/
  //     costDept)가 하나라도 undefined(값이 아예 없음 — 사용자가 UI에서 "미지정"을 선택해
  //     빈 문자열로 저장한 것과는 다름)이거나, team이 있는데 이 계획 자신의 team과 다른
  //     항목 — 오늘 코드의 어떤 저장 경로도 이런 모양을 만들지 않으므로, 과거의 더 이른
  //     스키마 시절에 저장된 채 그 후로 한 번도 오늘 코드의 upsert를 거치지 않은 "화석"
  //     항목일 가능성이 높다는 신호다(아직 중복이 없어도, 다음에 같은 이름으로 재업로드가
  //     들어오면 새 항목이 하나 더 생길 잠재 위험이 있다는 뜻이라 미리 보여준다).
  //  3) likelyHistoricalDuplicates: 2)에서 걸린 화석 항목과 이름(name)이 같으면서 동시에
  //     오늘 형식(accountType/team/costDept 전부 존재, team이 이 계획과 일치)을 갖춘
  //     "정상" 항목이 같은 계획 안에 함께 있는 경우 — 화석 항목이 실제로 중복(같은
  //     예산 라인이 두 번 잡혀 합계가 부풀려짐)을 이미 만들어냈을 가능성이 가장 높은
  //     조합이라 별도로 강조해 짝지어 보여준다. name만 기준으로 짝짓기 때문에, 우연히
  //     이름이 같지만 실제로는 서로 다른 별개 지출(예: 다른 costDept의 정당한 별도 항목)
  //     끼리도 여기 함께 나열될 수 있다 — 그래서 각 항목의 costDept/detail/금액을 전부
  //     함께 보여줘 사람이 실제로 같은 것인지 최종 판단하게 한다(자동 판정하지 않음).
  function _diagnosePlanDuplicates(plan) {
    const items = (plan.assumptions && Array.isArray(plan.assumptions.sgaItems)) ? plan.assumptions.sgaItems : [];
    const planTeam = (plan.team || '').trim();
    const withIndex = items.map((it, index) => ({ it, index }));

    // 1) 완전 동일 키 중복 — 정상 경로로는 나올 수 없는 조합.
    const exactKeyGroups = {};
    withIndex.forEach(({ it, index }) => {
      const key = JSON.stringify([it.name, (it.detail || '').trim(), it.accountType, it.team, it.costDept]);
      (exactKeyGroups[key] = exactKeyGroups[key] || []).push(index);
    });
    const exactDuplicates = Object.values(exactKeyGroups)
      .filter(idxs => idxs.length > 1)
      .map(idxs => ({ indexes: idxs, items: idxs.map(i => items[i]) }));

    // 2) 화석(오래된 스키마) 항목 — 오늘 upsert가 항상 채우는 필드가 비어있거나(정확히
    //    undefined), team이 있는데 이 계획 자신의 team과 다른 경우.
    const staleSchemaFields = withIndex
      .filter(({ it }) => {
        const missingKeyField = it.accountType === undefined || it.team === undefined || it.costDept === undefined;
        const teamMismatch = it.team !== undefined && (it.team || '').trim() !== planTeam;
        return missingKeyField || teamMismatch;
      })
      .map(({ it, index }) => ({
        index, item: it,
        reasons: [
          it.accountType === undefined ? 'accountType 필드 없음(최초 스키마 흔적일 수 있음)' : null,
          it.team === undefined ? 'team 필드 없음(팀 개념 도입 이전 스키마 흔적일 수 있음)' : null,
          it.costDept === undefined ? 'costDept 필드 없음(비용귀속부문 도입 이전 스키마 흔적일 수 있음)' : null,
          (it.team !== undefined && (it.team || '').trim() !== planTeam) ? `team 값("${it.team}")이 이 계획의 team("${planTeam}")과 다름` : null,
        ].filter(Boolean),
      }));

    // 3) 화석 항목과 이름이 같은 "정상 형식" 항목이 함께 있는 경우 — 실제 중복 가능성이
    //    가장 높은 조합이라 짝지어 강조.
    const modernByName = {};
    withIndex.forEach(({ it, index }) => {
      const isModern = it.accountType !== undefined && it.team !== undefined && it.costDept !== undefined && (it.team || '').trim() === planTeam;
      if (isModern) (modernByName[it.name] = modernByName[it.name] || []).push(index);
    });
    const likelyHistoricalDuplicates = staleSchemaFields
      .filter(s => modernByName[s.item.name] && modernByName[s.item.name].length)
      .map(s => ({
        name: s.item.name,
        staleItem: { index: s.index, item: s.item, reasons: s.reasons },
        modernItems: modernByName[s.item.name].map(i => ({ index: i, item: items[i] })),
      }));

    return {
      itemCount: items.length,
      exactDuplicates,
      staleSchemaFields,
      likelyHistoricalDuplicates,
      clean: exactDuplicates.length === 0 && likelyHistoricalDuplicates.length === 0,
    };
  }

  // "조직별" 인원계획 시트에 섞여 있는 급여/성과급 등 비용 집계 블록(부문별로 여러 줄
  // 반복되는 구조, headcount-plan/upload는 인원현황이 아니라서 이 블록들을 의도적으로
  // 건너뛴다 — 아래 headcount-plan/upload 라우트의 동일 판별 참고)을 사업계획 판관비
  // 항목으로 반영하기 위한 파서. headcount-plan/upload와 동일한 헤더 인식(구분/부문 +
  // 구분_1 + 월, KNOWN_ORG_SHEET_META_COLUMNS 공유)을 쓰지만, 이번엔 그 "이름표"(예:
  // "급여"/"성과급" — 헤더 없는 컬럼에 반복해서 채워진 값)를 항목명으로, 첫 번째 "구분"
  // (부문)을 비용귀속부문(costDept)으로 사용한다 — 한 팀(예: 인사팀)이 작성·관리하는
  // 계획 안에 부문별로 항목이 나뉘어 들어가되, 3단계 롤업(비용귀속부문별 집계)에서는
  // 각자의 실제 부문으로 정확히 귀속되게 하는 것이 목적(사용자 요청: "인사팀 계획 안에서
  // 부문별로 분리되나 최종 취합 시 해당 조직에 귀속").
  function _parseSgaCostBlockRows(rows) {
    const items = [];
    rows.forEach(row => {
      const dept = String(row['구분'] || row['부문'] || '').trim();
      if (!dept || dept === '계') return;
      // SheetJS는 헤더가 빈 문자열인 컬럼(이 파일의 "이름표" 컬럼이 정확히 이 경우)의 키를
      // 그대로 ""(빈 문자열)로 준다 — labelKey 자체가 유효하게 ""일 수 있으므로 falsy 체크
      // (!labelKey)로 "못 찾음"을 판별하면 안 되고 undefined 여부로만 판별해야 한다(실측
      // 발견 — falsy 체크였을 때 이 컬럼이 있는 모든 행이 "이름표 없음"으로 잘못 걸러졌음).
      const labelKey = Object.keys(row).find(k => !KNOWN_ORG_SHEET_META_COLUMNS.has(k) && row[k] !== null && String(row[k]).trim() !== '');
      if (labelKey === undefined) return; // 이름표(항목명) 없는 행 — 순수 인원현황 블록 등, 이 파서의 대상이 아님
      const name = String(row[labelKey]).trim();
      const catRaw = String(row['계정과목'] || row['구분_1'] || '').trim();
      const accountType = CATEGORIES.includes(catRaw) ? catRaw : '';
      if (!accountType) return;
      const months = MONTHS.map(m => toNumber(row[`${m}월`]) || 0);
      if (months.every(v => !v)) return;
      items.push({ name, detail: '', accountType, costDept: dept, months });
    });
    return items;
  }

  // 위 파서로 추출한 조직별 비용 블록 항목을, 이미 열려있는(부문/사업부/센터 조회로 특정된)
  // 계획 하나에 직접 반영한다 — 팀명 컬럼이 파일에 없어(부문 컬럼뿐) _commitSgaTeamItems의
  // "팀명으로 계획을 찾는" 방식이 애초에 적용될 수 없으므로, plan id를 URL로 직접 받는
  // 별도 라우트로 둔다. 관리자 전용, draft 상태일 때만(다른 쓰기 라우트와 동일 기준).
  router.post('/business-plan/:id/cost-block-upload', upload.single('file'), async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    let rows;
    try {
      rows = parseSheet(req.file.buffer, req.file.originalname, [['구분', '부문'], ['1월']], ['팀명', '항목']);
    } catch (e) {
      return res.status(400).json({ error: '파일을 읽을 수 없습니다. (xlsx/csv만 지원)' });
    }
    if (rows._headerRow === -1) {
      return res.status(400).json({ error: `업로드한 파일에서 "구분"(또는 "부문")·"1월" 컬럼을 찾지 못했습니다(확인한 시트: ${rows._triedSheets.join(', ')}). "조직별" 인원계획 시트와 같은 형식이어야 합니다.` });
    }
    const parsedItems = _parseSgaCostBlockRows(rows);
    if (!parsedItems.length) {
      return res.status(400).json({ error: '조직별 비용 블록(계정과목이 판관/용역/경상 중 하나이고 항목명이 있는 행)을 찾지 못했습니다.' });
    }
    const companyId = req.auth.companyId || null;
    // updateBudget()의 잠금(트랜잭션) 진입 전에 이 계획의 team이 무엇인지 먼저(잠금 없는
    // 조회로) 확인해 getTeamDept()를 미리 끝내둔다 — _commitSgaTeamItems()의 teamDeptCache
    // 주석과 동일한 이유(잠금 안에서 getTeamDept를 호출하면 loadData()의 추가 pool 커넥션
    // 요청이 이미 점유된 트랜잭션 커넥션과 맞물려 커넥션 풀 자기교착을 일으킬 수 있었음).
    // 조회 시점과 잠금 진입 사이에 team이 바뀌는 것은 극히 드문 경합이고, 설령 발생해도
    // 이번 요청에서는 자가치유가 그냥 한 번 건너뛰어질 뿐 데이터 손상으로 이어지지 않는다.
    const preData = await readBudget(companyId);
    const prePlan = preData.businessPlans.find(p => p.id === req.params.id);
    const [preResolvedTeamDept, expenseAccounts, profile] = await Promise.all([
      prePlan ? getTeamDept(companyId, prePlan.team) : Promise.resolve(null),
      getExpenseAccounts(companyId),
      getEmployeeProfile(companyId, req.auth.empId),
    ]);
    // "조직별" 시트는 팀명 컬럼이 없듯 비용계정 컬럼도 없어 파싱 단계에서 항상 비어있다 —
    // 예산 시트 항목과 동일하게 항목명(급여/사회보험 등 블록 이름표) 기준으로 자동 추정해
    // 채운다(사용자 요청: "조직별 비용도 이에 맞춰서 비용 계정 확인해서 업로드").
    if (expenseAccounts.length) {
      parsedItems.forEach(it => { it.expenseAccount = _guessExpenseAccount(it.name, expenseAccounts); });
    }
    try {
      let plan, applied, resultData, prunedResult = [];
      await updateBudget(companyId, async (data) => {
        plan = data.businessPlans.find(p => p.id === req.params.id);
        if (!plan) throw new _BudgetRouteError(404, '사업계획을 찾을 수 없습니다.');
        if (plan.status !== 'draft') {
          throw new _BudgetRouteError(403, '승인되어 잠긴 계획입니다. 수정요청을 보내 관리자 승인을 받은 뒤 반영할 수 있습니다.');
        }
        // 자가치유: dept가 팀 자기 자신의 이름으로 잘못 저장된 계획이면 재직자 기준 실제
        // 소속으로 바로잡는다(sga-upload/commit의 동일 로직과 동일한 이유).
        if (_isSelfReferentialCostDept(plan.dept, plan.team)) {
          const resolvedTeamDept = plan.team === (prePlan && prePlan.team) ? preResolvedTeamDept : null;
          if (resolvedTeamDept && resolvedTeamDept !== plan.dept) plan.dept = resolvedTeamDept;
        }
        if (!plan.assumptions) plan.assumptions = {};
        if (!Array.isArray(plan.assumptions.sgaItems)) plan.assumptions.sgaItems = [];
        const sgaItems = plan.assumptions.sgaItems;
        _migrateSelfReferentialCostDept(sgaItems, plan.team, plan.dept);
        const note = `조직별 비용 블록 반영(${new Date().toISOString().slice(0, 10)})`;
        applied = parsedItems.map(it => _upsertSgaItem(sgaItems, plan.dept, plan.team, it, note));
        const pruned = _pruneRedundantBudgetSummaryItems(sgaItems);
        const a = { baseYear: plan.baseYear, years: plan.years !== undefined ? plan.years : plan.projection.length, ...plan.assumptions };
        plan.projection = computeBusinessPlanProjection(a);
        plan.breakEven = computeBreakEven(a);
        plan.updatedAt = new Date().toISOString();
        plan.updatedBy = req.auth.empId;
        _pushPlanHistory(plan, '조직별 비용 블록 업로드 반영', _actorName(profile, true),
          `${applied.length}건 항목 반영` + (pruned.length ? ` · 예산(비인건비) 시트와 중복된 ${pruned.length}건 자동 제거(${pruned.map(p => p.detail || p.name).join(', ')})` : ''));
        prunedResult = pruned;
        resultData = data;
      });
      res.json({ ok: true, applied, prunedDuplicates: prunedResult.length, sheetName: rows._sheetName, plan: { ...plan, budgetComparison: computeBudgetComparison(resultData, plan) } });
    } catch (e) {
      if (e instanceof _BudgetRouteError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // 엑셀 업로드 → 미리보기(저장하지 않음). 팀별로 파싱된 항목과, 이미 존재하는 계획이
  // 있다면 그 상태(draft/잠김)까지 함께 반환해 클라이언트가 팀별로 편집 가능한 그리드를
  // 미리 보여줄 수 있게 한다. 실제 반영은 /sga-upload/commit에서 이뤄진다.
  router.post('/business-plan/sga-upload/parse', upload.single('file'), async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    let rows;
    try {
      rows = parseSheet(req.file.buffer, req.file.originalname, [['팀명', '팀'], ['항목']]);
    } catch (e) {
      return res.status(400).json({ error: '파일을 읽을 수 없습니다. (xlsx/csv만 지원)' });
    }
    if (rows._headerRow === -1) {
      return res.status(400).json({ error: `업로드한 파일에서 "팀명"·"항목" 컬럼을 찾지 못했습니다(확인한 시트: ${rows._triedSheets.join(', ')}). 여러 시트가 섞인 원본 파일이라면 "예산" 데이터가 있는 시트에 팀명/항목 등 헤더가 올바르게 있는지 확인해주세요.` });
    }
    const companyId = req.auth.companyId || null;
    const year = Number(req.query.year) || new Date().getFullYear();
    const data = await readBudget(companyId);
    const dropped = [];
    const byTeam = _parseSgaUploadRows(rows, dropped);
    const teams = Object.entries(byTeam).map(([team, items]) => {
      const matches = data.businessPlans.filter(p => p.baseYear === year && (p.team || '').trim() === team);
      const existing = matches.length === 1 ? matches[0] : null;
      return {
        team, items,
        existingPlanId: existing ? existing.id : null,
        existingStatus: existing ? existing.status : null,
        ambiguous: matches.length > 1
      };
    });
    res.json({ ok: true, teams, sheetName: rows._sheetName, dropped, droppedCount: dropped.length });
  });

  // 미리보기에서 사람이 조정한 팀별 항목을 실제로 저장(생성 또는 upsert). 파일이 아니라
  // 이미 파싱·편집된 JSON을 받는다 — 팀 단위로 하나씩 저장할 수도, 여러 팀을 한 번에
  // 저장할 수도 있다.
  router.post('/business-plan/sga-upload/commit', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const profile = await getEmployeeProfile(companyId, req.auth.empId);
    const userName = _actorName(profile, true);
    const year = Number(req.body.year) || new Date().getFullYear();
    const teams = Array.isArray(req.body.teams) ? req.body.teams : [];
    if (!teams.length) return res.status(400).json({ error: '저장할 팀 데이터가 없습니다.' });
    // updateBudget()의 잠금(트랜잭션) 진입 전에 관련된 모든 team의 실제 소속 부문을 미리
    // 조회해 캐시에 담는다 — _commitSgaTeamItems()의 teamDeptCache 주석 참고(잠금 안에서
    // 다시 조회하면 커넥션 풀 자기교착으로 요청이 응답 없이 멈출 수 있었음, 실측 발견).
    const uniqueTeams = [...new Set(teams.map(t => String(t && t.team || '').trim()).filter(Boolean))];
    const teamDeptCache = {};
    const [expenseAccounts] = await Promise.all([
      getExpenseAccounts(companyId),
      Promise.all(uniqueTeams.map(async team => { teamDeptCache[team] = await getTeamDept(companyId, team); })),
    ]);
    try {
      const { updated, skipped } = await updateBudget(companyId, async (data) => {
        const updated = [], skipped = [];
        for (const t of teams) {
          const team = String(t && t.team || '').trim();
          const items = Array.isArray(t && t.items) ? t.items : [];
          if (!team) continue;
          const result = await _commitSgaTeamItems(data, companyId, year, team, items, req, teamDeptCache, userName, expenseAccounts);
          if (result.skip) skipped.push({ team, reason: result.reason });
          else updated.push(result.updated);
        }
        data.uploads.push({ type: 'sga', filename: 'manual-review', uploadedAt: new Date().toISOString(), rows: teams.reduce((s, t) => s + (Array.isArray(t.items) ? t.items.length : 0), 0) });
        return { updated, skipped };
      });
      res.json({ ok: true, updated, skipped });
    } catch (e) {
      if (e instanceof _BudgetRouteError) return res.status(e.status).json({ error: e.message });
      console.error('[budget] sga-upload/commit failed:', e.message);
      res.status(500).json({ error: '저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
    }
  });

  // 월별 인원 계획(예측용) 엑셀 업로드 — 관리자 전용. 열 구성: "구분"(부문, 필수) +
  // "계정과목"(선택, 판관/용역/경상 중 하나면 인식, 그 외/빈값은 미분류) + "1월"~"12월".
  // budget.html의 기존 headcount(실적/현황 업로드)와는 완전히 별개 데이터 — 그쪽은
  // "지금까지의 실적"이고 이것은 "사업계획" 롤업에서 참고하는 예측치라, 서로 다른 화면·
  // 다른 초기화 범위로 관리한다.
  router.post('/business-plan/headcount-plan/upload', upload.single('file'), async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    let rows;
    try {
      rows = parseSheet(req.file.buffer, req.file.originalname, [['구분', '부문'], ['1월']], ['팀명', '항목']);
    } catch (e) {
      return res.status(400).json({ error: '파일을 읽을 수 없습니다. (xlsx/csv만 지원)' });
    }
    if (rows._headerRow === -1) {
      return res.status(400).json({ error: `업로드한 파일에서 "구분"(또는 "부문")·"1월" 컬럼을 찾지 못했습니다(확인한 시트: ${rows._triedSheets.join(', ')}). 여러 시트가 섞인 원본 파일이라면 인원계획 데이터가 있는 시트에 헤더가 올바르게 있는지 확인해주세요.` });
    }
    const companyId = req.auth.companyId || null;
    const year = Number(req.query.year) || new Date().getFullYear();
    // 실사용 원본 파일의 "조직별" 시트는 부문별 "인원 현황" 블록 하나만 있는 게 아니라,
    // 같은 부문·계정과목 조합이 급여/인센티브/복리후생비/교육훈련비/사회보험/퇴직급여
    // 등 비용 집계 블록으로 여러 번 더 반복되는 구조였다(실측 발견) — 이 블록들은 맨 앞의
    // 이름 없는 컬럼에 그 블록의 이름표(예: "급여")가 채워져 있는 것으로만 구분 가능한데,
    // 그 구분 없이 그대로 업서트하면 나중 블록이 앞선 인원수를 계속 덮어써 최종적으로는
    // 마지막 블록(대개 "퇴직급여")의 금액이 인원수인 것처럼 저장되는 심각한 데이터 오염이
    // 있었다. 이 비용 집계 블록들은 시스템이 3단계 롤업(sgaByCategory)에서 RAW자료+예산
    // 데이터로 이미 동일한 값을 자동 산출하므로 별도 저장이 불필요(이전 세션에 이미 확정된
    // 방침) — "구분/부문/계정과목/n월/평균" 외의 컬럼에 값이 있는 행(=비용 블록의 이름표
    // 행)은 인원 현황이 아니므로 건너뛴다.
    let upserted = 0;
    const seenKeys = new Set(); // 같은 부문+계정과목이 파일에 여러 번 나오는 경우를 구분하기 위함
    let overwritten = 0;
    await updateBudget(companyId, async (data) => {
      rows.forEach(row => {
        const dept = String(row['구분'] || row['부문'] || '').trim();
        if (!dept || dept === '계') return;
        const hasUnexpectedLabel = Object.keys(row).some(k => !KNOWN_ORG_SHEET_META_COLUMNS.has(k) && row[k] !== null && String(row[k]).trim() !== '');
        if (hasUnexpectedLabel) return;
        // SheetJS는 동일한 헤더 텍스트("구분")가 한 시트에 두 번 나오면 두 번째 것을
        // "구분_1"로 자동 개명한다(실사용 원본 파일의 "조직별" 시트가 정확히 이 구조 —
        // 부문용 "구분"과 계정과목용 "구분" 두 컬럼이 똑같이 "구분"이라는 이름을 씀).
        // "구분2"는 그 실제 명명 규칙과 맞지 않아 이 값을 절대 찾지 못하던 기존 버그였다.
        const catRaw = String(row['계정과목'] || row['구분_1'] || '').trim();
        const category = CATEGORIES.includes(catRaw) ? catRaw : '';
        const months = MONTHS.map(m => toNumber(row[`${m}월`]));
        if (months.every(v => v === null)) return;
        const monthsArr = months.map(v => v === null ? 0 : v);
        const existing = data.headcountPlans.find(h => h.year === year && h.dept === dept && (h.category || '') === category);
        if (existing) {
          // 같은 연도+부문+계정과목 행이 파일에 여러 번 나오면 뒤엣것이 앞엣것을 덮어쓴다.
          // 예전엔 그때마다 upserted를 올려 "2건 반영"처럼 보고했지만 실제 저장은 1건이라
          // 사용자가 오해했다(실측). 실제 저장 건수만 세고, 덮어쓴 행은 따로 알린다.
          if (seenKeys.has(`${dept}\u0000${category}`)) overwritten++;
          existing.months = monthsArr;
          existing.updatedAt = new Date().toISOString();
        } else {
          data.headcountPlans.push({
            id: `hcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            year, dept, category, months: monthsArr, updatedAt: new Date().toISOString()
          });
        }
        if (!seenKeys.has(`${dept}\u0000${category}`)) { seenKeys.add(`${dept}\u0000${category}`); upserted++; }
      });
      data.uploads.push({ type: 'headcountPlan', filename: req.file.originalname, uploadedAt: new Date().toISOString(), rows: rows.length });
    });
    res.json({ ok: true, upserted, overwritten });
  });

  // 월별 인원 계획 조회 — 롤업과 동일한 접근범위(관리자/예산담당자/기획팀장은 전체,
  // 사업부장은 자기 dept만).
  router.get('/business-plan/headcount-plan', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const data = await readBudget(companyId);
    const isAdmin = req.auth.role === 'admin';
    const isFullAccess = isAdmin
      || _isBudgetOwner(isAdmin, data.budgetPlanSettings, req.auth.empId)
      || _isPlanningLead(isAdmin, data.budgetPlanSettings, req.auth.empId);
    const profile = await getEmployeeProfile(companyId, req.auth.empId);
    const isDirector = profile && profile.role === 'director';
    if (!isFullAccess && !isDirector) {
      return res.status(403).json({ error: '접근 권한이 없습니다.' });
    }
    const year = Number(req.query.year) || new Date().getFullYear();
    let plans = data.headcountPlans.filter(h => h.year === year);
    if (!isFullAccess) plans = plans.filter(h => h.dept === profile.dept);
    res.json({ ok: true, plans });
  });

  // 신규 생성: 관리자가 아니면 dept/team은 항상 작성자 본인 소속으로 강제(다른 팀
  // 명의로 계획을 만드는 스푸핑 방지) — body에 dept/team을 보내도 무시한다. 관리자는
  // 특정 팀을 대신 만들거나(dept/team 지정), 레거시 방식(dept 생략 = 회사 전체
  // 스크래치 계획, 즉시 finalConfirmed)도 그대로 가능하다.
  router.post('/business-plan', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const isAdmin = req.auth.role === 'admin';
    // getEmployeeProfile()은 budget_store와 무관한 별도 조회(employees 조회)이므로,
    // updateBudget()의 락을 쥐기 전에 끝내 락 보유 시간을 최소화한다.
    const profile = await getEmployeeProfile(companyId, req.auth.empId);
    const body = req.body || {};

    try {
      let plan, resultData;
      await updateBudget(companyId, async (data) => {
        let dept, team;
        if (isAdmin) {
          dept = body.dept !== undefined ? (body.dept || null) : null;
          team = body.team !== undefined ? (body.team || '') : '';
        } else {
          if (!profile) throw new _BudgetRouteError(403, '소속 정보를 확인할 수 없습니다.');
          dept = profile.dept || null;
          team = profile.team || '';
          if (!dept) throw new _BudgetRouteError(403, '소속 사업부 정보가 없어 사업계획을 작성할 수 없습니다. 관리자에게 문의하세요.');
          if (!data.budgetPlanSettings.inputOpen) {
            throw new _BudgetRouteError(403, '현재 사업계획 입력기간이 아닙니다. 예산담당자·기획팀장에게 문의하세요.');
          }
        }

        const { assumptions, errors } = _normalizeBusinessPlanInput(body, null);
        if (errors) {
          throw new _BudgetRouteError(400, `필수 값이 누락되었거나 형식이 올바르지 않습니다: ${errors.join(', ')}`);
        }

        const now = new Date().toISOString();
        plan = {
          id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: assumptions.name,
          baseYear: assumptions.baseYear,
          years: assumptions.years,
          scenario: assumptions.scenario,
          planType: assumptions.planType,
          dept, team,
          // dept가 없는(레거시/관리자 스크래치) 계획은 팀 워크플로우 대상이 아니므로 승인
          // 단계 없이 곧바로 finalConfirmed로 취급 — 관리자는 어떤 상태든 항상 수정 가능하므로
          // 실질 동작은 이전(승인 개념 도입 전)과 동일하다.
          status: dept ? 'draft' : 'finalConfirmed',
          divisionApproval: null,
          finalApproval: { ownerBy: null, ownerAt: null, leadBy: null, leadAt: null },
          editRequest: null,
          assumptions: {
            baseRevenue: assumptions.baseRevenue,
            revenueGrowthRate: assumptions.revenueGrowthRate,
            cogsRatio: assumptions.cogsRatio,
            sgaItems: assumptions.sgaItems,
            revenueItems: assumptions.revenueItems,
            taxRate: assumptions.taxRate,
            depreciation: assumptions.depreciation
          },
          projection: computeBusinessPlanProjection(assumptions),
          breakEven: computeBreakEven(assumptions),
          createdBy: req.auth.empId !== undefined ? req.auth.empId : null,
          createdByName: profile ? profile.name : undefined,
          createdAt: now,
          updatedAt: now,
          history: []
        };
        _pushPlanHistory(plan, '등록', _actorName(profile, isAdmin));

        data.businessPlans.push(plan);
        resultData = data;
      });
      res.json({ ok: true, plan: { ...plan, budgetComparison: computeBudgetComparison(resultData, plan) } });
    } catch (e) {
      if (e instanceof _BudgetRouteError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // 단건 조회
  router.get('/business-plan/:id', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const data = await readBudget(companyId);
    const plan = data.businessPlans.find(p => p.id === req.params.id);
    if (!plan) return res.status(404).json({ error: '사업계획을 찾을 수 없습니다.' });
    const isAdmin = req.auth.role === 'admin';
    const profile = await getEmployeeProfile(companyId, req.auth.empId);
    if (!_canViewPlan(isAdmin, profile, data.budgetPlanSettings, req.auth.empId, plan)) {
      return res.status(403).json({ error: '조회 권한이 없습니다.' });
    }
    res.json({ ok: true, plan: { ...plan, ..._freshPlanCalc(plan), budgetComparison: computeBudgetComparison(data, plan) } });
  });

  // 진단 도구(읽기전용, 관리자 전용) — 사업계획 매칭 키 이력 변화(name → +detail →
  // +accountType → +team → +costDept)로 인해 옛 스키마 항목이 오늘 코드의 upsert로는
  // 다시 매칭되지 못해 중복이 생겼는지 사람이 직접 확인할 수 있게 한다. 위
  // _diagnosePlanDuplicates() 주석에 판정 기준 전체가 설명돼 있다 — 절대 아무것도
  // 자동으로 고치거나 지우지 않는다(실제 재무 데이터라 잘못 지우면 되돌릴 수 없으므로,
  // 발견한 항목을 그대로 보여주고 최종 판단·정리는 관리자가 직접 하도록 한다).
  router.get('/business-plan/:id/diagnose-duplicates', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const data = await readBudget(companyId);
    const plan = data.businessPlans.find(p => p.id === req.params.id);
    if (!plan) return res.status(404).json({ error: '사업계획을 찾을 수 없습니다.' });
    res.json({ ok: true, planId: plan.id, planName: plan.name, team: plan.team, dept: plan.dept, baseYear: plan.baseYear, diagnosis: _diagnosePlanDuplicates(plan) });
  });

  // 위 단건 진단을 전체 사업계획에 대해 한 번에 돌려주는 요약 버전 — 회사 전체를 팀별로
  // 하나하나 열어보지 않아도 어느 계획에 의심스러운 항목이 있는지 한눈에 파악할 수 있게
  // 한다(연도 필터는 선택, 생략하면 전 연도 전체 계획을 스캔).
  router.get('/business-plan/diagnose-duplicates/all', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const data = await readBudget(companyId);
    const year = req.query.year ? Number(req.query.year) : null;
    const plans = year ? data.businessPlans.filter(p => p.baseYear === year) : data.businessPlans;
    const results = plans.map(p => {
      const diagnosis = _diagnosePlanDuplicates(p);
      return { planId: p.id, planName: p.name, team: p.team, dept: p.dept, baseYear: p.baseYear, status: p.status, diagnosis };
    }).filter(r => !r.diagnosis.clean);
    res.json({
      ok: true,
      scannedPlanCount: plans.length,
      flaggedPlanCount: results.length,
      totalExactDuplicates: results.reduce((s, r) => s + r.diagnosis.exactDuplicates.length, 0),
      totalLikelyHistoricalDuplicates: results.reduce((s, r) => s + r.diagnosis.likelyHistoricalDuplicates.length, 0),
      results,
    });
  });

  // 가정 갱신 + 재계산 — status가 'draft'일 때만(그리고 팀 소속 또는 관리자만) 가능.
  // 잠긴(divisionApproved/finalConfirmed) 계획은 /request-edit → 관리자 승인을 거쳐야
  // 다시 draft로 풀린 뒤에 수정할 수 있다(관리자 본인은 잠금 상태와 무관하게 직접 수정 가능
  // — 이 코드베이스 전반의 "관리자는 항상 전권" 관례와 동일).
  router.put('/business-plan/:id', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const isAdmin = req.auth.role === 'admin';
    const profile = await getEmployeeProfile(companyId, req.auth.empId);
    const body = req.body || {};

    try {
      let plan, resultData;
      await updateBudget(companyId, async (data) => {
        plan = data.businessPlans.find(p => p.id === req.params.id);
        if (!plan) throw new _BudgetRouteError(404, '사업계획을 찾을 수 없습니다.');

        if (!_canEditPlan(isAdmin, profile, plan)) {
          throw new _BudgetRouteError(403, '수정 권한이 없습니다.');
        }
        if (!isAdmin) {
          if (plan.status !== 'draft') {
            throw new _BudgetRouteError(403, '승인되어 잠긴 계획입니다. 수정요청을 보내 관리자 승인을 받은 뒤 수정할 수 있습니다.');
          }
          if (plan.dept && !data.budgetPlanSettings.inputOpen) {
            throw new _BudgetRouteError(403, '현재 사업계획 입력기간이 아닙니다.');
          }
        }

        // 저장된 plan에는(이번 신설 이전 버전) "years"/"planType"이 별도 필드로 남아있지
        // 않을 수 있으므로(신설 이후 저장분은 있음) 없으면 기존 값으로 되짚어 기본값을 구성한다.
        const existing = {
          name: plan.name,
          baseYear: plan.baseYear,
          years: plan.years !== undefined ? plan.years : plan.projection.length,
          scenario: plan.scenario !== undefined ? plan.scenario : null,
          planType: plan.planType || 'revenue',
          ...plan.assumptions
        };
        const { assumptions, errors } = _normalizeBusinessPlanInput(body, existing);
        if (errors) {
          throw new _BudgetRouteError(400, `필수 값이 누락되었거나 형식이 올바르지 않습니다: ${errors.join(', ')}`);
        }

        // 변경 이력 상세용 — 덮어쓰기 전(before) 판관비 합계를 기록해두고, 아래에서
        // 실제 필드를 갱신한 뒤 after 합계와 비교한다(plan.updatedAt/updatedBy는 항상
        // "가장 최근" 값만 남아 이전 수정 내역이 사라지므로, history[]에 매 수정마다
        // 하나씩 append해 그 유실을 막는다 — 이 라우트 신설의 핵심 동기).
        const beforeSgaTotal = (existing.sgaItems || []).reduce((s, it) => s + (it.baseAmount || 0), 0);

        plan.name = assumptions.name;
        plan.baseYear = assumptions.baseYear;
        plan.years = assumptions.years;
        plan.scenario = assumptions.scenario;
        plan.planType = assumptions.planType;
        plan.assumptions = {
          baseRevenue: assumptions.baseRevenue,
          revenueGrowthRate: assumptions.revenueGrowthRate,
          cogsRatio: assumptions.cogsRatio,
          sgaItems: assumptions.sgaItems,
          revenueItems: assumptions.revenueItems,
          taxRate: assumptions.taxRate,
          depreciation: assumptions.depreciation
        };
        plan.projection = computeBusinessPlanProjection(assumptions);
        plan.breakEven = computeBreakEven(assumptions);
        plan.updatedAt = new Date().toISOString();
        plan.updatedBy = req.auth.empId;
        const afterSgaTotal = assumptions.sgaItems.reduce((s, it) => s + (it.baseAmount || 0), 0);
        const revenueTotal = (assumptions.revenueItems || []).reduce((s, it) => s + (it.baseAmount || 0), 0);
        _pushPlanHistory(plan, '수정', _actorName(profile, isAdmin),
          `판관비 합계 ${_fmtNum(beforeSgaTotal)}원 → ${_fmtNum(afterSgaTotal)}원 (항목 ${assumptions.sgaItems.length}건)`
          + ((assumptions.revenueItems || []).length ? ` · 매출 항목 ${assumptions.revenueItems.length}건, 합계 ${_fmtNum(revenueTotal)}원` : ''));
        resultData = data;
      });
      res.json({ ok: true, plan: { ...plan, budgetComparison: computeBudgetComparison(resultData, plan) } });
    } catch (e) {
      if (e instanceof _BudgetRouteError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // 매출 항목(revenueItems)의 월별 실적 입력 — 계획(PUT /business-plan/:id)과 의도적으로
  // 분리된 별도 라우트다. 실적은 "실제로 그 달이 지나간 뒤" 기록하는 것이라 계획이 이미
  // 사업부장 승인·최종확정으로 잠긴 뒤에도 계속 입력할 수 있어야 하는데, PUT 라우트는
  // draft 상태만 허용하도록 설계돼 있어(계획 숫자 자체를 함부로 못 바꾸게) 그대로 재사용할
  // 수 없다. 이 라우트는 잠금 상태와 무관하게 허용하되, 대신 건드릴 수 있는 범위를
  // "해당 항목의 actualMonths"로만 엄격히 제한해(다른 계획 필드는 body로 무엇을 보내도
  // 전혀 반영되지 않음) 승인된 계획의 실제 예산 수치가 이 경로로 우회 변경되는 일이
  // 없도록 한다. 조회 권한과 동일한 소속(팀/부서) 또는 관리자만 입력 가능.
  router.put('/business-plan/:id/revenue-actuals', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const isAdmin = req.auth.role === 'admin';
    const profile = await getEmployeeProfile(companyId, req.auth.empId);
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: '입력할 실적 데이터가 없습니다.' });

    try {
      let plan, resultData, updatedCount = 0;
      await updateBudget(companyId, async (data) => {
        plan = data.businessPlans.find(p => p.id === req.params.id);
        if (!plan) throw new _BudgetRouteError(404, '사업계획을 찾을 수 없습니다.');
        if (!_canEditPlan(isAdmin, profile, plan)) {
          throw new _BudgetRouteError(403, '실적 입력 권한이 없습니다.');
        }
        const revenueItems = (plan.assumptions && Array.isArray(plan.assumptions.revenueItems)) ? plan.assumptions.revenueItems : [];
        items.forEach(reqItem => {
          const target = revenueItems.find(it => it.id === (reqItem && reqItem.id));
          if (!target) return;
          const monthsRaw = reqItem && Array.isArray(reqItem.actualMonths) ? reqItem.actualMonths : null;
          if (!monthsRaw || monthsRaw.length !== 12) return;
          target.actualMonths = monthsRaw.map(v => Number(v) || 0);
          updatedCount++;
        });
        if (!updatedCount) throw new _BudgetRouteError(400, '일치하는 매출 항목을 찾지 못했습니다.');
        plan.updatedAt = new Date().toISOString();
        const actualTotal = revenueItems.reduce((s, it) => s + (it.actualMonths || []).reduce((s2, v) => s2 + v, 0), 0);
        _pushPlanHistory(plan, '매출 실적 입력', _actorName(profile, isAdmin), `${updatedCount}개 항목 · 누적 실적 합계 ${_fmtNum(actualTotal)}원`);
        resultData = data;
      });
      res.json({ ok: true, updated: updatedCount, plan: { ...plan, ..._freshPlanCalc(plan), budgetComparison: computeBudgetComparison(resultData, plan) } });
    } catch (e) {
      if (e instanceof _BudgetRouteError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // 계획(revenueItems) 대 실적(actualMonths) 비교 리포트 — 사용자가 실제로 쓰는 "N월
  // 누계 계획비 차이" 형태(사업명/계획/실적/Gap)의 근거 데이터를 그대로 제공한다.
  // ?month=5 처럼 기준월을 주면 1월~그 달까지 누계로, 생략하면 연간 전체로 집계한다.
  // 조회 권한은 계획 조회와 동일(_canViewPlan) — 실적도 계획만큼 민감한 영업 정보라
  // 소속 밖에는 보여주지 않는다.
  router.get('/business-plan/:id/revenue-monitor', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const isAdmin = req.auth.role === 'admin';
    const data = await readBudget(companyId);
    const plan = data.businessPlans.find(p => p.id === req.params.id);
    if (!plan) return res.status(404).json({ error: '사업계획을 찾을 수 없습니다.' });
    const profile = await getEmployeeProfile(companyId, req.auth.empId);
    if (!_canViewPlan(isAdmin, profile, data.budgetPlanSettings, req.auth.empId, plan)) {
      return res.status(403).json({ error: '조회 권한이 없습니다.' });
    }
    const monthLimit = req.query.month ? Math.min(12, Math.max(1, Number(req.query.month) || 12)) : 12;
    const revenueItems = (plan.assumptions && Array.isArray(plan.assumptions.revenueItems)) ? plan.assumptions.revenueItems : [];
    const sumThrough = arr => round2((arr || []).slice(0, monthLimit).reduce((s, v) => s + (v || 0), 0));
    const items = revenueItems.map(it => {
      const planAmt = sumThrough(it.months);
      const actualAmt = sumThrough(it.actualMonths);
      return {
        id: it.id, client: it.client, projectName: it.projectName || it.client,
        expectedAmount: it.expectedAmount, expectedWinDate: it.expectedWinDate,
        recognitionBasis: it.recognitionBasis, status: it.status, note: it.note,
        plan: planAmt, actual: actualAmt, gap: round2(actualAmt - planAmt)
      };
    });
    const totals = items.reduce((acc, it) => ({
      plan: round2(acc.plan + it.plan), actual: round2(acc.actual + it.actual), gap: round2(acc.gap + it.gap)
    }), { plan: 0, actual: 0, gap: 0 });
    res.json({ ok: true, planId: plan.id, planName: plan.name, dept: plan.dept, team: plan.team, monthLimit, items, totals });
  });

  // 사업부장 승인 → 잠금(divisionApproved)
  router.post('/business-plan/:id/approve-division', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const isAdmin = req.auth.role === 'admin';
    const profile = await getEmployeeProfile(companyId, req.auth.empId);

    try {
      let plan, resultData;
      await updateBudget(companyId, async (data) => {
        plan = data.businessPlans.find(p => p.id === req.params.id);
        if (!plan) throw new _BudgetRouteError(404, '사업계획을 찾을 수 없습니다.');
        if (!plan.dept) throw new _BudgetRouteError(400, '팀 소속 계획이 아니라 승인 절차가 적용되지 않습니다.');
        if (plan.status !== 'draft') throw new _BudgetRouteError(400, '이미 승인되었거나 draft 상태가 아닙니다.');
        if (!_isDivisionHead(isAdmin, profile, plan)) {
          throw new _BudgetRouteError(403, '해당 사업부장(또는 관리자)만 승인할 수 있습니다.');
        }

        plan.status = 'divisionApproved';
        plan.divisionApproval = { by: req.auth.empId, byName: profile ? profile.name : (isAdmin ? '관리자' : undefined), at: new Date().toISOString() };
        plan.updatedAt = new Date().toISOString();
        _pushPlanHistory(plan, '사업부장 승인(잠금)', _actorName(profile, isAdmin));
        resultData = data;
      });
      res.json({ ok: true, plan: { ...plan, budgetComparison: computeBudgetComparison(resultData, plan) } });
    } catch (e) {
      if (e instanceof _BudgetRouteError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // 예산담당자 또는 기획팀장 최종승인 — 두 승인이 모두 기록되면 finalConfirmed로 전환.
  // 관리자가 호출하면 두 승인을 한 번에 채워 즉시 확정한다(관리자 전권 관례).
  router.post('/business-plan/:id/final-approve', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const isAdmin = req.auth.role === 'admin';
    const profile = await getEmployeeProfile(companyId, req.auth.empId);

    try {
      let plan, resultData;
      await updateBudget(companyId, async (data) => {
        plan = data.businessPlans.find(p => p.id === req.params.id);
        if (!plan) throw new _BudgetRouteError(404, '사업계획을 찾을 수 없습니다.');
        if (plan.status !== 'divisionApproved') {
          throw new _BudgetRouteError(400, '사업부장 승인이 완료된 계획만 최종승인할 수 있습니다.');
        }

        const isOwner = _isBudgetOwner(false, data.budgetPlanSettings, req.auth.empId);
        const isLead = _isPlanningLead(false, data.budgetPlanSettings, req.auth.empId);
        if (!isAdmin && !isOwner && !isLead) {
          throw new _BudgetRouteError(403, '예산담당자, 기획팀장, 관리자만 최종승인할 수 있습니다.');
        }

        const now = new Date().toISOString();
        if (!plan.finalApproval) plan.finalApproval = { ownerBy: null, ownerAt: null, leadBy: null, leadAt: null };
        if (isAdmin) {
          plan.finalApproval.ownerBy = plan.finalApproval.ownerBy || req.auth.empId;
          plan.finalApproval.ownerAt = plan.finalApproval.ownerAt || now;
          plan.finalApproval.leadBy = plan.finalApproval.leadBy || req.auth.empId;
          plan.finalApproval.leadAt = plan.finalApproval.leadAt || now;
          _pushPlanHistory(plan, '관리자 즉시 최종확정', _actorName(profile, isAdmin));
        } else {
          const labels = [];
          if (isOwner) { plan.finalApproval.ownerBy = req.auth.empId; plan.finalApproval.ownerAt = now; labels.push('예산담당자 최종승인'); }
          if (isLead) { plan.finalApproval.leadBy = req.auth.empId; plan.finalApproval.leadAt = now; labels.push('기획팀장 최종승인'); }
          if (labels.length) _pushPlanHistory(plan, labels.join(' / '), _actorName(profile, isAdmin));
        }
        if (plan.finalApproval.ownerBy != null && plan.finalApproval.leadBy != null) {
          plan.status = 'finalConfirmed';
        }
        plan.updatedAt = new Date().toISOString();
        resultData = data;
      });
      res.json({ ok: true, plan: { ...plan, budgetComparison: computeBudgetComparison(resultData, plan) } });
    } catch (e) {
      if (e instanceof _BudgetRouteError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // 잠긴(divisionApproved/finalConfirmed) 계획의 수정요청 — 팀 소속(또는 관리자)이
  // 사유와 함께 제출. 계획 자체는 계속 잠긴 채로 유지되고, 관리자 승인/반려만 대기.
  router.post('/business-plan/:id/request-edit', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const isAdmin = req.auth.role === 'admin';
    const profile = await getEmployeeProfile(companyId, req.auth.empId);
    const reason = (req.body && req.body.reason || '').trim();

    try {
      let plan, resultData;
      await updateBudget(companyId, async (data) => {
        plan = data.businessPlans.find(p => p.id === req.params.id);
        if (!plan) throw new _BudgetRouteError(404, '사업계획을 찾을 수 없습니다.');
        if (plan.status === 'draft') throw new _BudgetRouteError(400, '이미 수정 가능한 상태입니다.');

        if (!_canEditPlan(isAdmin, profile, plan) && !_isDivisionHead(isAdmin, profile, plan)) {
          throw new _BudgetRouteError(403, '수정요청 권한이 없습니다.');
        }
        if (!reason) throw new _BudgetRouteError(400, '수정요청 사유를 입력하세요.');

        plan.editRequest = { requestedBy: req.auth.empId, requestedByName: profile ? profile.name : undefined, reason, requestedAt: new Date().toISOString() };
        _pushPlanHistory(plan, '수정요청 제출', _actorName(profile, isAdmin), reason);
        resultData = data;
      });
      res.json({ ok: true, plan: { ...plan, budgetComparison: computeBudgetComparison(resultData, plan) } });
    } catch (e) {
      if (e instanceof _BudgetRouteError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // 수정요청 승인(관리자 전용) — draft로 되돌리고 기존 승인 기록을 전부 초기화한다
  // (수정 후 내용이 달라지므로 사업부장·예산담당자·기획팀장 승인을 처음부터 다시 받아야 함).
  router.post('/business-plan/:id/edit-request/approve', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const profile = await getEmployeeProfile(companyId, req.auth.empId);

    try {
      let plan, resultData;
      await updateBudget(companyId, async (data) => {
        plan = data.businessPlans.find(p => p.id === req.params.id);
        if (!plan) throw new _BudgetRouteError(404, '사업계획을 찾을 수 없습니다.');
        if (!plan.editRequest) throw new _BudgetRouteError(400, '대기 중인 수정요청이 없습니다.');

        plan.status = 'draft';
        plan.divisionApproval = null;
        plan.finalApproval = { ownerBy: null, ownerAt: null, leadBy: null, leadAt: null };
        plan.editRequest = null;
        plan.updatedAt = new Date().toISOString();
        _pushPlanHistory(plan, '수정요청 승인(재오픈, 승인이력 초기화)', _actorName(profile, true));
        resultData = data;
      });
      res.json({ ok: true, plan: { ...plan, budgetComparison: computeBudgetComparison(resultData, plan) } });
    } catch (e) {
      if (e instanceof _BudgetRouteError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // 수정요청 반려(관리자 전용) — 계획은 잠긴 채로 유지, 요청만 제거.
  router.post('/business-plan/:id/edit-request/reject', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const profile = await getEmployeeProfile(companyId, req.auth.empId);

    try {
      let plan, resultData;
      await updateBudget(companyId, async (data) => {
        plan = data.businessPlans.find(p => p.id === req.params.id);
        if (!plan) throw new _BudgetRouteError(404, '사업계획을 찾을 수 없습니다.');
        if (!plan.editRequest) throw new _BudgetRouteError(400, '대기 중인 수정요청이 없습니다.');

        plan.editRequest = null;
        plan.updatedAt = new Date().toISOString();
        _pushPlanHistory(plan, '수정요청 반려', _actorName(profile, true));
        resultData = data;
      });
      res.json({ ok: true, plan: { ...plan, budgetComparison: computeBudgetComparison(resultData, plan) } });
    } catch (e) {
      if (e instanceof _BudgetRouteError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // 삭제 — 관리자는 언제든, 팀 소속은 draft 상태일 때만(잠긴 뒤에는 수정요청 절차를
  // 거쳐야 하므로 삭제도 동일 기준 적용).
  router.delete('/business-plan/:id', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const companyId = req.auth.companyId || null;
    const isAdmin = req.auth.role === 'admin';
    const profile = isAdmin ? null : await getEmployeeProfile(companyId, req.auth.empId);

    try {
      await updateBudget(companyId, async (data) => {
        const idx = data.businessPlans.findIndex(p => p.id === req.params.id);
        if (idx === -1) throw new _BudgetRouteError(404, '사업계획을 찾을 수 없습니다.');
        const plan = data.businessPlans[idx];

        if (!isAdmin) {
          if (!_canEditPlan(isAdmin, profile, plan)) throw new _BudgetRouteError(403, '삭제 권한이 없습니다.');
          if (plan.status !== 'draft') throw new _BudgetRouteError(403, '승인되어 잠긴 계획은 삭제할 수 없습니다.');
        }

        data.businessPlans.splice(idx, 1);
      });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof _BudgetRouteError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  return router;
};

// server.js의 연도별 스냅샷/복원(POST /snapshots, POST /restore)이 budget_store(사업계획/
// 예산/개인별급여상세)도 함께 백업·복원할 수 있도록 노출한다 — 기존에는 이 라우터 팩토리
// 함수 하나만 export돼 있어, /snapshots가 employees/kpiEntries 등 loadData() 소관 필드만
// 담고 budget_store는 완전히 빠져있었다(사용자 보고: "백업/복원에 예산·사업계획·급여계획
// 데이터가 빠집니다"). 팩토리 함수 자체의 호출 계약(require("./budget")(deps))은 그대로
// 유지한 채, 그 함수 객체에 정적 속성으로 추가하는 형태라 기존 마운트 코드에 영향이 없다.
module.exports.readBudget = readBudget;
module.exports.updateBudget = updateBudget;
