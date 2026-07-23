const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const BUDGET_FILE = path.join(__dirname, 'budget-data.json');
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
  return { headcount: [], items: [], uploads: [], businessPlans: [] };
}

function _readAllBudget() {
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

function _writeAllBudget(all) {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(all, null, 2));
}

function _budgetKey(companyId) {
  return companyId || '_legacy';
}

function readBudget(companyId) {
  const all = _readAllBudget();
  const data = all[_budgetKey(companyId)] || _emptyCompanyBudget();
  // businessPlans는 이번에 신설된 필드라, 이 코드 배포 이전에 이미 저장된 회사 데이터
  // (headcount/items/uploads만 있던 시절)를 읽으면 undefined일 수 있다 — 백필.
  if (!Array.isArray(data.businessPlans)) data.businessPlans = [];
  return data;
}

function writeBudget(companyId, data) {
  const all = _readAllBudget();
  all[_budgetKey(companyId)] = data;
  _writeAllBudget(all);
}

function parseSheet(buffer, filename) {
  const isCsv = /\.csv$/i.test(filename || '');
  const workbook = isCsv
    ? xlsx.read(buffer.toString('utf8'), { type: 'string' })
    : xlsx.read(buffer, { type: 'buffer' });
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
function computeBusinessPlanProjection(a) {
  const years = a.years;
  const sgaItems = Array.isArray(a.sgaItems) ? a.sgaItems : [];
  const projection = [];

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

    projection.push({
      year: a.baseYear + y,
      revenue, cogs, grossProfit, sga, operatingProfit, netIncome, freeCashFlow
    });
  }

  return projection;
}

// body에서 사업계획 가정(assumptions)을 검증·정규화한다. existing이 주어지면(PUT) 그 값을
// 기본값으로 깔고 body에 있는 필드만 덮어써 부분 수정(partial update)을 허용한다.
function _normalizeBusinessPlanInput(body, existing) {
  const base = existing || {};
  const errors = [];

  const name = body.name !== undefined ? body.name : base.name;
  const baseYear = body.baseYear !== undefined ? Number(body.baseYear) : base.baseYear;
  const years = body.years !== undefined ? Number(body.years) : base.years;
  const baseRevenue = body.baseRevenue !== undefined ? Number(body.baseRevenue) : base.baseRevenue;
  const revenueGrowthRate = body.revenueGrowthRate !== undefined ? Number(body.revenueGrowthRate) : base.revenueGrowthRate;
  const cogsRatio = body.cogsRatio !== undefined ? Number(body.cogsRatio) : base.cogsRatio;
  const taxRate = body.taxRate !== undefined ? Number(body.taxRate) : (base.taxRate !== undefined ? base.taxRate : 0.22);
  const depreciation = body.depreciation !== undefined ? Number(body.depreciation) : (base.depreciation !== undefined ? base.depreciation : 0);
  const sgaItemsRaw = body.sgaItems !== undefined ? body.sgaItems : base.sgaItems;

  if (!name || typeof name !== 'string') errors.push('name');
  if (!Number.isFinite(baseYear)) errors.push('baseYear');
  if (!Number.isInteger(years) || years <= 0) errors.push('years');
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
      sgaItems = sgaItemsRaw.map(item => ({
        name: (item && item.name) || '',
        baseAmount: Number(item && item.baseAmount) || 0,
        growthRate: Number(item && item.growthRate) || 0
      }));
    }
  }

  if (errors.length) return { errors };
  return {
    assumptions: { name, baseYear, years, baseRevenue, revenueGrowthRate, cogsRatio, sgaItems, taxRate, depreciation }
  };
}

// 과거에는 클라이언트가 body에 적어 보낸 role을 그대로 신뢰했다(server.js의 다른
// 라우트들이 이미 폐기한 것과 동일한 취약 패턴) — 인증 토큰이 전혀 없어도 body에
// role:"admin"만 넣으면 전체 예산 데이터 조회/업로드/삭제가 가능했다. 이 라우터는
// server.js에서 `app.use(authenticate)` 이후에 마운트되므로 req.auth(서버가 검증한
// 로그인 토큰)를 그대로 쓸 수 있다.
function requireAdmin(req, res) {
  if (!req.auth) {
    res.status(401).json({ error: '로그인이 필요합니다.' });
    return false;
  }
  if (req.auth.role !== 'admin') {
    res.status(403).json({ error: '관리자만 사용할 수 있습니다.' });
    return false;
  }
  return true;
}

// 부서별/월별 인원수 업로드 (첫번째 파일)
router.post('/upload/headcount', upload.single('file'), (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });

  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch (e) {
    return res.status(400).json({ error: '파일을 읽을 수 없습니다. (xlsx/csv만 지원)' });
  }

  const companyId = req.auth.companyId || null;
  const data = readBudget(companyId);
  let upserted = 0;

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

  writeBudget(companyId, data);
  res.json({ message: '인원 현황이 반영되었습니다.', upserted, depts: [...new Set(rows.map(r => r['구분']).filter(Boolean))] });
});

// 사업부/팀별 예산 상세(판관/용역/경상) 업로드 (두번째 파일)
router.post('/upload/detail', upload.single('file'), (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });

  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch (e) {
    return res.status(400).json({ error: '파일을 읽을 수 없습니다. (xlsx/csv만 지원)' });
  }

  const companyId = req.auth.companyId || null;
  const data = readBudget(companyId);
  let upserted = 0;

  rows.forEach(row => {
    const dept = row['부문'];
    const category = row['구분'];
    if (!dept || dept === '계' || !category || !CATEGORIES.includes(category)) return;

    const team = row['팀'] || '';
    const revenueType = row['매출구분'] || '';
    const account = row['항목'] || '';
    const detail = row['세부내역(산정근거)'] || row['세부내역'] || '';

    MONTHS.forEach(m => {
      const amount = toNumber(row[`${m}월`]);
      if (amount === null) return;
      const existing = data.items.find(i =>
        i.dept === dept && i.team === team && i.account === account &&
        i.category === category && i.month === m
      );
      if (existing) {
        existing.amount = amount;
        existing.revenueType = revenueType;
        existing.detail = detail;
      } else {
        data.items.push({ dept, team, revenueType, account, detail, category, month: m, amount });
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

  writeBudget(companyId, data);
  res.json({ message: '예산 상세(판관/용역/경상) 내역이 반영되었습니다.', upserted, depts: [...new Set(rows.map(r => r['부문']).filter(Boolean))] });
});

// 원본 데이터 조회
router.get('/data', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(readBudget(req.auth.companyId || null));
});

// 업로드 이력
router.get('/uploads', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const data = readBudget(req.auth.companyId || null);
  res.json({ uploads: data.uploads });
});

// 사업부별/월별 통합 요약 (인원 + 판관/용역/경상 합산, 중복 제외)
router.get('/summary', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const data = readBudget(req.auth.companyId || null);
  const depts = [...new Set([
    ...data.headcount.map(h => h.dept),
    ...data.items.map(i => i.dept)
  ])];

  const summary = depts.map(dept => {
    const months = MONTHS.map(m => {
      const headcountEntry = data.headcount.find(h => h.dept === dept && h.month === m);
      const deptItems = data.items.filter(i => i.dept === dept && i.month === m);

      const byCategory = {};
      CATEGORIES.forEach(c => { byCategory[c] = 0; });
      deptItems.forEach(i => { byCategory[i.category] += i.amount; });

      // 항목 단위로 이미 고유 키(부서+팀+항목+구분+월)로 upsert 되어 있으므로
      // 단순 합산해도 중복이 발생하지 않음
      const totalAmount = deptItems.reduce((sum, i) => sum + i.amount, 0);

      return {
        month: m,
        headcount: headcountEntry ? headcountEntry.count : null,
        ...byCategory,
        totalAmount,
        hasHeadcountData: !!headcountEntry,
        hasDetailData: deptItems.length > 0
      };
    });

    return { dept, months };
  });

  res.json({ summary });
});

// 데이터 초기화 (본인 회사 데이터만 — 다른 회사 데이터는 건드리지 않음)
router.delete('/data', (req, res) => {
  if (!requireAdmin(req, res)) return;
  writeBudget(req.auth.companyId || null, _emptyCompanyBudget());
  res.json({ message: '예산 데이터가 초기화되었습니다.' });
});

// ── 사업계획 시나리오(다년도 매출/비용 가정 → 추정 손익/현금흐름) ──────────────

// 목록 조회
router.get('/business-plan', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const data = readBudget(req.auth.companyId || null);
  res.json({ ok: true, plans: data.businessPlans });
});

// 신규 생성
router.post('/business-plan', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  const { assumptions, errors } = _normalizeBusinessPlanInput(body, null);
  if (errors) {
    return res.status(400).json({ error: `필수 값이 누락되었거나 형식이 올바르지 않습니다: ${errors.join(', ')}` });
  }

  const companyId = req.auth.companyId || null;
  const data = readBudget(companyId);

  const now = new Date().toISOString();
  const plan = {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: assumptions.name,
    baseYear: assumptions.baseYear,
    assumptions: {
      baseRevenue: assumptions.baseRevenue,
      revenueGrowthRate: assumptions.revenueGrowthRate,
      cogsRatio: assumptions.cogsRatio,
      sgaItems: assumptions.sgaItems,
      taxRate: assumptions.taxRate,
      depreciation: assumptions.depreciation
    },
    projection: computeBusinessPlanProjection(assumptions),
    createdBy: req.auth.empId !== undefined ? req.auth.empId : null,
    createdAt: now,
    updatedAt: now
  };

  data.businessPlans.push(plan);
  writeBudget(companyId, data);
  res.json({ ok: true, plan });
});

// 단건 조회
router.get('/business-plan/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const data = readBudget(req.auth.companyId || null);
  const plan = data.businessPlans.find(p => p.id === req.params.id);
  if (!plan) return res.status(404).json({ error: '사업계획을 찾을 수 없습니다.' });
  res.json({ ok: true, plan });
});

// 가정 갱신 + 재계산
router.put('/business-plan/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const companyId = req.auth.companyId || null;
  const data = readBudget(companyId);
  const plan = data.businessPlans.find(p => p.id === req.params.id);
  if (!plan) return res.status(404).json({ error: '사업계획을 찾을 수 없습니다.' });

  const body = req.body || {};
  // 저장된 plan에는 스펙상 "years"가 별도 필드로 남아있지 않으므로(assumptions에도 없음
  // — projection 생성에만 쓰이는 값), 기존 projection 길이로 되짚어 기본값을 구성한다.
  const existing = { name: plan.name, baseYear: plan.baseYear, years: plan.projection.length, ...plan.assumptions };
  const { assumptions, errors } = _normalizeBusinessPlanInput(body, existing);
  if (errors) {
    return res.status(400).json({ error: `필수 값이 누락되었거나 형식이 올바르지 않습니다: ${errors.join(', ')}` });
  }

  plan.name = assumptions.name;
  plan.baseYear = assumptions.baseYear;
  plan.assumptions = {
    baseRevenue: assumptions.baseRevenue,
    revenueGrowthRate: assumptions.revenueGrowthRate,
    cogsRatio: assumptions.cogsRatio,
    sgaItems: assumptions.sgaItems,
    taxRate: assumptions.taxRate,
    depreciation: assumptions.depreciation
  };
  plan.projection = computeBusinessPlanProjection(assumptions);
  plan.updatedAt = new Date().toISOString();

  writeBudget(companyId, data);
  res.json({ ok: true, plan });
});

// 삭제
router.delete('/business-plan/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const companyId = req.auth.companyId || null;
  const data = readBudget(companyId);
  const idx = data.businessPlans.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '사업계획을 찾을 수 없습니다.' });

  data.businessPlans.splice(idx, 1);
  writeBudget(companyId, data);
  res.json({ ok: true });
});

module.exports = router;
