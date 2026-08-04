const express = require('express');
const fs = require('fs');
const path = require('path');
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

function _readAllBudgetFile() {
  if (!fs.existsSync(BUDGET_FILE)) return {};
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
  } catch (e) {
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
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(all, null, 2));
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
  const projection = [];
  let prevRevenue = a.baseRevenue;

  for (let y = 1; y <= years; y++) {
    const revenue = round2(a.baseRevenue * Math.pow(1 + a.revenueGrowthRate, y));
    const cogs = round2(revenue * a.cogsRatio);
    const grossProfit = round2(revenue - cogs);
    const sga = round2(sgaItems.reduce(
      (sum, item) => sum + item.baseAmount * Math.pow(1 + (item.growthRate || 0), y),
      0
    ));
    const operatingProfit = round2(grossProfit - sga);
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
      revenue, cogs, grossProfit, sga, operatingProfit, netIncome, freeCashFlow,
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
  const baseRevenue = a.baseRevenue;
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

  if (errors.length) return { errors };
  return {
    assumptions: { name, baseYear, years, planType, baseRevenue, revenueGrowthRate, cogsRatio, sgaItems, taxRate, depreciation, scenario }
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
  const items = body.items.map(it => ({
    category: (it && it.category) || '',
    name: (it && it.name) || '',
    amount: Number(it && it.amount) || 0,
  })).filter(it => it.name && it.amount !== 0);
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
      existing.items = items;
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
    const plans = visible.map(p => ({ ...p, budgetComparison: computeBudgetComparison(data, p) }));
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

    function _rollup(plans) {
      const byYear = {};
      plans.forEach(p => (p.projection || []).forEach(r => {
        if (!byYear[r.year]) byYear[r.year] = { year: r.year, revenue: 0, cogs: 0, grossProfit: 0, sga: 0, operatingProfit: 0, netIncome: 0, freeCashFlow: 0 };
        const acc = byYear[r.year];
        acc.revenue += r.revenue || 0; acc.cogs += r.cogs || 0; acc.grossProfit += r.grossProfit || 0;
        acc.sga += r.sga || 0; acc.operatingProfit += r.operatingProfit || 0; acc.netIncome += r.netIncome || 0;
        acc.freeCashFlow += r.freeCashFlow || 0;
      }));
      return Object.values(byYear).map(r => ({
        ...r, revenue: round2(r.revenue), cogs: round2(r.cogs), grossProfit: round2(r.grossProfit),
        sga: round2(r.sga), operatingProfit: round2(r.operatingProfit), netIncome: round2(r.netIncome),
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

    // sgaByCostDept: 위 byDept/company(P&L 롤업)와 별개로, 판관비 항목만 "비용 귀속
    // 부문" 기준으로 재집계 — 계획을 작성한 팀과 실제 비용 귀속 부문이 다른 경우에도
    // 전사 합계와 부문별 실집계를 함께 확인할 수 있게 한다.
    const sgaByCostDept = _sgaRollupByCostDept(scoped);
    // sgaByCategory: 3단계 자료 연계(개인별 급여→팀별 그리드→부문별 집계표)의 마지막
    // 단계 — 판관비 항목을 "구분"(급여/복리후생비/교육훈련비/사회보험 등)별로 나눈 뒤
    // 그 안에서 다시 비용귀속부문 기준으로 집계.
    const sgaByCategory = _sgaRollupByCategory(scoped);
    // sgaByAccountType/sgaByExpenseAccount: sgaByCategory와 동일한 구조로, "구분" 대신
    // 각각 계정과목(판관/용역/경상)·비용계정(실제 회계 계정과목) 기준으로 재집계한 것.
    const sgaByAccountType = _sgaRollupByAccountType(scoped);
    const sgaByExpenseAccount = _sgaRollupByExpenseAccount(scoped);

    res.json({ ok: true, includeDraft, byDept, company: { planCount: scoped.length, projection: _rollup(scoped) }, sgaByCostDept, sgaByCategory, sgaByAccountType, sgaByExpenseAccount });
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
  function _parseSgaUploadRows(rows) {
    const byTeam = {};
    rows.forEach(row => {
      const team = String(row['팀명'] || row['팀'] || '').trim();
      const accountType = row['구분'];
      if (!team || !accountType || !CATEGORIES.includes(accountType)) return;
      const rawName = String(row['항목'] || '').trim();
      const name = rawName.replace(/^\((판|용|경)\)/, '').trim();
      if (!name) return;
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
  function _commitSgaTeamItems(data, companyId, year, team, items, req) {
    const matches = data.businessPlans.filter(p => p.baseYear === year && (p.team || '').trim() === team);
    let plan, autoCreated = false;
    if (matches.length === 0) {
      const costDeptCounts = {};
      items.forEach(it => { const cd = (it.costDept || '').trim(); if (cd) costDeptCounts[cd] = (costDeptCounts[cd] || 0) + 1; });
      const inferredDept = Object.keys(costDeptCounts).sort((a, b) => costDeptCounts[b] - costDeptCounts[a])[0] || team;
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
        createdAt: now, updatedAt: now
      };
      data.businessPlans.push(plan);
      autoCreated = true;
    } else if (matches.length > 1) {
      return { skip: true, reason: `${year}년 기준 팀명 "${team}"에 해당하는 사업계획이 ${matches.length}건이라 자동으로 특정할 수 없습니다.` };
    } else {
      plan = matches[0];
      if (plan.status !== 'draft') {
        return { skip: true, reason: `승인되어 잠긴 계획입니다. 수정요청을 보내 관리자 승인을 받은 뒤 반영할 수 있습니다.` };
      }
    }
    const dept = plan.dept;
    if (!plan.assumptions) plan.assumptions = {};
    if (!Array.isArray(plan.assumptions.sgaItems)) plan.assumptions.sgaItems = [];
    const sgaItems = plan.assumptions.sgaItems;
    const note = `예산(비인건비) 반영(${new Date().toISOString().slice(0, 10)})`;
    const itemDetail = items.map(it => _upsertSgaItem(sgaItems, dept, team, it, note));
    const a = { baseYear: plan.baseYear, years: plan.years !== undefined ? plan.years : plan.projection.length, ...plan.assumptions };
    plan.projection = computeBusinessPlanProjection(a);
    plan.breakEven = computeBreakEven(a);
    plan.updatedAt = new Date().toISOString();
    plan.updatedBy = req.auth.empId;
    return { skip: false, updated: { team, planId: plan.id, dept, itemCount: items.length, planStatus: plan.status, items: itemDetail, autoCreated } };
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
  function _upsertSgaItem(sgaItems, dept, team, it, note) {
    const resolvedCostDept = it.costDept || dept;
    const existing = sgaItems.find(e =>
      e.name === it.name && (e.detail || '').trim() === (it.detail || '').trim() &&
      e.accountType === it.accountType && (e.team || '') === team &&
      (e.costDept || dept) === resolvedCostDept
    );
    const baseAmount = round2((it.months || []).reduce((s, v) => s + (v || 0), 0));
    const category = _guessSgaCategory(it.name);
    if (existing) {
      existing.dept = dept; existing.team = team; existing.costDept = resolvedCostDept;
      existing.detail = it.detail; existing.accountType = it.accountType; existing.expenseAccount = it.expenseAccount || existing.expenseAccount || '';
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

  // "조직별" 인원계획 시트에 섞여 있는 급여/성과급 등 비용 집계 블록(부문별로 여러 줄
  // 반복되는 구조, headcount-plan/upload는 인원현황이 아니라서 이 블록들을 의도적으로
  // 건너뛴다 — 위 KNOWN_HEADCOUNT_COLUMNS 참고)을 사업계획 판관비 항목으로 반영하기
  // 위한 파서. headcount-plan/upload와 동일한 헤더 인식(구분/부문 + 구분_1 + 월)을
  // 쓰지만, 이번엔 그 "이름표"(예: "급여"/"성과급" — 헤더 없는 컬럼에 반복해서 채워진
  // 값)를 항목명으로, 첫 번째 "구분"(부문)을 비용귀속부문(costDept)으로 사용한다 —
  // 한 팀(예: 인사팀)이 작성·관리하는 계획 안에 부문별로 항목이 나뉘어 들어가되, 3단계
  // 롤업(비용귀속부문별 집계)에서는 각자의 실제 부문으로 정확히 귀속되게 하는 것이 목적
  // (사용자 요청: "인사팀 계획 안에서 부문별로 분리되나 최종 취합 시 해당 조직에 귀속").
  function _parseSgaCostBlockRows(rows) {
    const KNOWN_COST_BLOCK_COLUMNS = new Set(['구분', '구분_1', '부문', '계정과목', '평균', ...MONTHS.map(m => `${m}월`)]);
    const items = [];
    rows.forEach(row => {
      const dept = String(row['구분'] || row['부문'] || '').trim();
      if (!dept || dept === '계') return;
      // SheetJS는 헤더가 빈 문자열인 컬럼(이 파일의 "이름표" 컬럼이 정확히 이 경우)의 키를
      // 그대로 ""(빈 문자열)로 준다 — labelKey 자체가 유효하게 ""일 수 있으므로 falsy 체크
      // (!labelKey)로 "못 찾음"을 판별하면 안 되고 undefined 여부로만 판별해야 한다(실측
      // 발견 — falsy 체크였을 때 이 컬럼이 있는 모든 행이 "이름표 없음"으로 잘못 걸러졌음).
      const labelKey = Object.keys(row).find(k => !KNOWN_COST_BLOCK_COLUMNS.has(k) && row[k] !== null && String(row[k]).trim() !== '');
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
    try {
      let plan, applied, resultData;
      await updateBudget(companyId, async (data) => {
        plan = data.businessPlans.find(p => p.id === req.params.id);
        if (!plan) throw new _BudgetRouteError(404, '사업계획을 찾을 수 없습니다.');
        if (plan.status !== 'draft') {
          throw new _BudgetRouteError(403, '승인되어 잠긴 계획입니다. 수정요청을 보내 관리자 승인을 받은 뒤 반영할 수 있습니다.');
        }
        if (!plan.assumptions) plan.assumptions = {};
        if (!Array.isArray(plan.assumptions.sgaItems)) plan.assumptions.sgaItems = [];
        const sgaItems = plan.assumptions.sgaItems;
        const note = `조직별 비용 블록 반영(${new Date().toISOString().slice(0, 10)})`;
        applied = parsedItems.map(it => _upsertSgaItem(sgaItems, plan.dept, plan.team, it, note));
        const a = { baseYear: plan.baseYear, years: plan.years !== undefined ? plan.years : plan.projection.length, ...plan.assumptions };
        plan.projection = computeBusinessPlanProjection(a);
        plan.breakEven = computeBreakEven(a);
        plan.updatedAt = new Date().toISOString();
        plan.updatedBy = req.auth.empId;
        resultData = data;
      });
      res.json({ ok: true, applied, sheetName: rows._sheetName, plan: { ...plan, budgetComparison: computeBudgetComparison(resultData, plan) } });
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
    const byTeam = _parseSgaUploadRows(rows);
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
    res.json({ ok: true, teams, sheetName: rows._sheetName });
  });

  // 미리보기에서 사람이 조정한 팀별 항목을 실제로 저장(생성 또는 upsert). 파일이 아니라
  // 이미 파싱·편집된 JSON을 받는다 — 팀 단위로 하나씩 저장할 수도, 여러 팀을 한 번에
  // 저장할 수도 있다.
  router.post('/business-plan/sga-upload/commit', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const companyId = req.auth.companyId || null;
    const year = Number(req.body.year) || new Date().getFullYear();
    const teams = Array.isArray(req.body.teams) ? req.body.teams : [];
    if (!teams.length) return res.status(400).json({ error: '저장할 팀 데이터가 없습니다.' });
    const { updated, skipped } = await updateBudget(companyId, async (data) => {
      const updated = [], skipped = [];
      teams.forEach(t => {
        const team = String(t && t.team || '').trim();
        const items = Array.isArray(t && t.items) ? t.items : [];
        if (!team) return;
        const result = _commitSgaTeamItems(data, companyId, year, team, items, req);
        if (result.skip) skipped.push({ team, reason: result.reason });
        else updated.push(result.updated);
      });
      data.uploads.push({ type: 'sga', filename: 'manual-review', uploadedAt: new Date().toISOString(), rows: teams.reduce((s, t) => s + (Array.isArray(t.items) ? t.items.length : 0), 0) });
      return { updated, skipped };
    });
    res.json({ ok: true, updated, skipped });
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
    const KNOWN_HEADCOUNT_COLUMNS = new Set(['구분', '구분_1', '부문', '계정과목', '평균', ...MONTHS.map(m => `${m}월`)]);
    let upserted = 0;
    await updateBudget(companyId, async (data) => {
      rows.forEach(row => {
        const dept = String(row['구분'] || row['부문'] || '').trim();
        if (!dept || dept === '계') return;
        const hasUnexpectedLabel = Object.keys(row).some(k => !KNOWN_HEADCOUNT_COLUMNS.has(k) && row[k] !== null && String(row[k]).trim() !== '');
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
          existing.months = monthsArr;
          existing.updatedAt = new Date().toISOString();
        } else {
          data.headcountPlans.push({
            id: `hcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            year, dept, category, months: monthsArr, updatedAt: new Date().toISOString()
          });
        }
        upserted++;
      });
      data.uploads.push({ type: 'headcountPlan', filename: req.file.originalname, uploadedAt: new Date().toISOString(), rows: rows.length });
    });
    res.json({ ok: true, upserted });
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
            taxRate: assumptions.taxRate,
            depreciation: assumptions.depreciation
          },
          projection: computeBusinessPlanProjection(assumptions),
          breakEven: computeBreakEven(assumptions),
          createdBy: req.auth.empId !== undefined ? req.auth.empId : null,
          createdByName: profile ? profile.name : undefined,
          createdAt: now,
          updatedAt: now
        };

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
    res.json({ ok: true, plan: { ...plan, budgetComparison: computeBudgetComparison(data, plan) } });
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
          taxRate: assumptions.taxRate,
          depreciation: assumptions.depreciation
        };
        plan.projection = computeBusinessPlanProjection(assumptions);
        plan.breakEven = computeBreakEven(assumptions);
        plan.updatedAt = new Date().toISOString();
        plan.updatedBy = req.auth.empId;
        resultData = data;
      });
      res.json({ ok: true, plan: { ...plan, budgetComparison: computeBudgetComparison(resultData, plan) } });
    } catch (e) {
      if (e instanceof _BudgetRouteError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
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
        } else {
          if (isOwner) { plan.finalApproval.ownerBy = req.auth.empId; plan.finalApproval.ownerAt = now; }
          if (isLead) { plan.finalApproval.leadBy = req.auth.empId; plan.finalApproval.leadAt = now; }
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

    try {
      let plan, resultData;
      await updateBudget(companyId, async (data) => {
        plan = data.businessPlans.find(p => p.id === req.params.id);
        if (!plan) throw new _BudgetRouteError(404, '사업계획을 찾을 수 없습니다.');
        if (!plan.editRequest) throw new _BudgetRouteError(400, '대기 중인 수정요청이 없습니다.');

        plan.editRequest = null;
        plan.updatedAt = new Date().toISOString();
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
