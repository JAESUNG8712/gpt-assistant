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

function readBudget() {
  if (!fs.existsSync(BUDGET_FILE)) {
    return { headcount: [], items: [], uploads: [] };
  }
  return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
}

function writeBudget(data) {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(data, null, 2));
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

  const data = readBudget();
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

  writeBudget(data);
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

  const data = readBudget();
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

  writeBudget(data);
  res.json({ message: '예산 상세(판관/용역/경상) 내역이 반영되었습니다.', upserted, depts: [...new Set(rows.map(r => r['부문']).filter(Boolean))] });
});

// 원본 데이터 조회
router.get('/data', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(readBudget());
});

// 업로드 이력
router.get('/uploads', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const data = readBudget();
  res.json({ uploads: data.uploads });
});

// 사업부별/월별 통합 요약 (인원 + 판관/용역/경상 합산, 중복 제외)
router.get('/summary', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const data = readBudget();
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

// 데이터 초기화
router.delete('/data', (req, res) => {
  if (!requireAdmin(req, res)) return;
  writeBudget({ headcount: [], items: [], uploads: [] });
  res.json({ message: '예산 데이터가 초기화되었습니다.' });
});

module.exports = router;
