const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");
const os      = require("os");
const bcrypt  = require("bcryptjs");
const crypto  = require("crypto");
const pool    = require("./db");
const budgetRouter = require("./budget");

const app  = express();
const PORT = process.env.PORT || 3000;

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
let _dataVersion = 0;
let _lastSaved   = null;
let _activityLog = [];
let _locks       = {};      // { lockKey: { clientId, user, acquiredAt, expiresAt } }
let _sseClients  = {};      // { clientId: { res, user, connectedAt } }

// ── DB bootstrap ──────────────────────────────────────────────────────────────
async function initDB() {
  if (USE_JSON_FILE) {
    if (fs.existsSync(JSON_FILE)) {
      try {
        const raw = fs.readFileSync(JSON_FILE, "utf8");
        _fileStore = JSON.parse(raw);
        _dataVersion = _fileStore._version || 0;
        console.log(`[Storage] JSON File mode. Loaded ${(_fileStore.employees||[]).length} employees, version=${_dataVersion}`);
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
  const { rows } = await pool.query(
    "SELECT value FROM app_meta WHERE key = 'data_version'"
  );
  if (rows.length) _dataVersion = parseInt(rows[0].value) || 0;
  console.log(`[DB] PostgreSQL ready. data_version=${_dataVersion}`);

  // 기초데이터 시딩 (최초 가동 시 비어있는 경우에만)
  const acctCount = await pool.query("SELECT COUNT(*) FROM accounts WHERE NOT is_deleted");
  if (parseInt(acctCount.rows[0].count) === 0) {
    for (const a of DEFAULT_ACCOUNTS) {
      const id = `acc_seed_${a.code}`;
      await pool.query(
        "INSERT INTO accounts (id, data) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING",
        [id, JSON.stringify({ id, ...a, active: true })]
      );
    }
    console.log(`[DB] 기초 계정과목 ${DEFAULT_ACCOUNTS.length}건 시딩 완료`);
  }
  const locCount = await pool.query("SELECT COUNT(*) FROM erp_locations WHERE NOT is_deleted");
  if (parseInt(locCount.rows[0].count) === 0) {
    for (let i = 0; i < DEFAULT_LOCATIONS.length; i++) {
      const l = DEFAULT_LOCATIONS[i];
      const id = `loc_seed_${i + 1}`;
      await pool.query(
        "INSERT INTO erp_locations (id, data) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING",
        [id, JSON.stringify({ id, ...l })]
      );
    }
    console.log(`[DB] 기초 위치(창고) ${DEFAULT_LOCATIONS.length}건 시딩 완료`);
  }
}

const { ID_KEYED_LIST_FIELDS, GENERIC_LIST_FIELDS, SINGLETON_FIELDS } = require("./lib/collections");

// ── Core DB helpers ───────────────────────────────────────────────────────────
async function loadData() {
  if (USE_JSON_FILE) {
    // Return the full stored state so the client restores everything
    // (employees, kpiEntries, settings, coreTalentPool, lowPerfData, etc.)
    return { ..._fileStore, _version: _dataVersion };
  }
  const [empRes, kpiRes, collRes, singRes] = await Promise.all([
    pool.query("SELECT data FROM employees  WHERE is_deleted = FALSE ORDER BY created_at"),
    pool.query("SELECT data FROM kpi_entries WHERE is_deleted = FALSE ORDER BY created_at"),
    pool.query("SELECT collection, data FROM app_collections ORDER BY created_at"),
    pool.query("SELECT key, data FROM app_singletons"),
  ]);
  const result = {
    employees:  empRes.rows.map(r => r.data),
    kpiEntries: kpiRes.rows.map(r => r.data),
    _version:   _dataVersion,
  };
  for (const field of GENERIC_LIST_FIELDS) result[field] = [];
  for (const row of collRes.rows) {
    if (!result[row.collection]) result[row.collection] = [];
    result[row.collection].push(row.data);
  }
  for (const row of singRes.rows) result[row.key] = row.data;
  return result;
}
async function persistData(data, changedBy = "system") {
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

    _fileStore = { ...data, employees };
    _dataVersion++;
    _lastSaved = new Date().toISOString();
    _fileStore._version = _dataVersion;
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
    for (const rawEmp of (data.employees || [])) {
      if (!rawEmp.id) continue;
      const { rows } = await client.query(
        "SELECT data FROM employees WHERE id = $1", [rawEmp.id]
      );
      if (rows.length === 0) {
        let pw = rawEmp.pw;
        if (pw != null && pw !== "") pw = await hashPlaintextPw(pw);
        const emp = { ...rawEmp, pw };
        await client.query(
          "INSERT INTO employees (id, data) VALUES ($1, $2)",
          [emp.id, emp]
        );
        await client.query(
          "INSERT INTO employee_history (employee_id, action, changed_by, data) VALUES ($1,'insert',$2,$3)",
          [emp.id, changedBy, emp]
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
            "INSERT INTO employee_history (employee_id, action, changed_by, data) VALUES ($1,'update',$2,$3)",
            [emp.id, changedBy, emp]
          );
        }
      }
    }
    let duplicateLoginIds = [];
    if ((data.employees || []).length) {
      const { rows: allEmp } = await client.query("SELECT data FROM employees WHERE is_deleted = FALSE");
      duplicateLoginIds = warnDuplicateLoginIds(allEmp.map(r => r.data));
    }

    // ── kpi_entries upsert + history ──────────────────────────────────────────
    for (const kpi of (data.kpiEntries || [])) {
      if (!kpi.id) continue;
      const empId   = kpi.employeeId || kpi.employee_id || null;
      const evalYear = kpi.year ? parseInt(kpi.year) : null;
      const { rows } = await client.query(
        "SELECT data FROM kpi_entries WHERE id = $1", [kpi.id]
      );
      if (rows.length === 0) {
        await client.query(
          "INSERT INTO kpi_entries (id, employee_id, eval_year, data) VALUES ($1,$2,$3,$4)",
          [kpi.id, empId, evalYear, kpi]
        );
        await client.query(
          "INSERT INTO kpi_history (kpi_id, action, changed_by, data) VALUES ($1,'insert',$2,$3)",
          [kpi.id, changedBy, kpi]
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
            "INSERT INTO kpi_history (kpi_id, action, changed_by, data) VALUES ($1,'update',$2,$3)",
            [kpi.id, changedBy, kpi]
          );
        }
      }
    }

    // ── generic id-keyed collections (attendance, payslips, approvals, etc.) ──
    for (const field of GENERIC_LIST_FIELDS) {
      const items = data[field];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || item.id == null) continue;
        const { rows } = await client.query(
          "SELECT data FROM app_collections WHERE collection = $1 AND id = $2",
          [field, String(item.id)]
        );
        const oldTs = rows.length ? (rows[0].data.updatedAt || rows[0].data.createdAt || "") : "";
        const newTs = item.updatedAt || item.createdAt || "";
        if (rows.length && newTs < oldTs) continue; // server has a newer copy, keep it
        await client.query(
          `INSERT INTO app_collections (collection, id, data, updated_at) VALUES ($1,$2,$3,NOW())
           ON CONFLICT (collection, id) DO UPDATE SET data = $3, updated_at = NOW()`,
          [field, String(item.id), JSON.stringify(item)]
        );
      }
    }

    // ── singleton config blobs ─────────────────────────────────────────────────
    for (const key of SINGLETON_FIELDS) {
      if (data[key] === undefined) continue;
      await client.query(
        `INSERT INTO app_singletons (key, data, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
        [key, JSON.stringify(data[key])]
      );
    }

    // ── bump version ──────────────────────────────────────────────────────────
    _dataVersion++;
    _lastSaved = new Date().toISOString();
    await client.query(
      "INSERT INTO app_meta (key, value) VALUES ('data_version', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [String(_dataVersion)]
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
  for (const field of ID_KEYED_LIST_FIELDS) {
    if (clientData[field] !== undefined || serverData[field] !== undefined) {
      merged[field] = mergeArrayById(serverData[field], clientData[field]);
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
function broadcastSSE(eventName, payload, excludeClientId = null) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [cid, client] of Object.entries(_sseClients)) {
    if (cid === excludeClientId) continue;
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
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/budget", budgetRouter);

// ── Core API ──────────────────────────────────────────────────────────────────

// GET /status
app.get("/status", async (req, res) => {
  try {
    if (USE_JSON_FILE) {
      return res.json({
        ok: true,
        version: _dataVersion,
        storageMode: "file",
        meta: {
          lastSaved: _lastSaved,
          empCount:  (_fileStore.employees  || []).length,
          kpiCount:  (_fileStore.kpiEntries || []).length,
        },
        onlineCount: Object.keys(_sseClients).length,
      });
    }
    const [empRes, kpiRes] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM employees  WHERE is_deleted = FALSE"),
      pool.query("SELECT COUNT(*) FROM kpi_entries WHERE is_deleted = FALSE"),
    ]);
    res.json({
      ok: true,
      version: _dataVersion,
      storageMode: "postgresql",
      meta: {
        lastSaved:  _lastSaved,
        empCount:   parseInt(empRes.rows[0].count),
        kpiCount:   parseInt(kpiRes.rows[0].count),
      },
      onlineCount: Object.keys(_sseClients).length,
    });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// GET /data
app.get("/data", async (req, res) => {
  try {
    const data = await loadData();
    res.json({ ok: true, data: stripPwField(data), version: _dataVersion });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// Verifies loginId/pw against server-stored (hashed or legacy-plaintext) records.
// Returns the matched employee (without pw) on success, or null on failure.
async function verifyCredentials(loginId, pw) {
  if (!loginId || !pw) return null;
  const data = await loadData();
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
app.post("/login", async (req, res) => {
  try {
    const { loginId, pw, otp } = req.body || {};
    if (!loginId || !pw) return res.status(400).json({ ok: false, message: "아이디와 비밀번호를 입력하세요." });
    const employee = await verifyCredentials(loginId, pw);
    if (!employee) return res.json({ ok: false, message: "아이디 또는 비밀번호가 올바르지 않습니다." });
    if (employee.twoFactorEnabled) {
      if (!otp) return res.json({ ok: true, requireOtp: true });
      const data = await loadData();
      const raw = (data.employees || []).find(e => e.loginId === loginId && e.active);
      if (!raw || !raw.twoFactorSecret || !totpVerify(raw.twoFactorSecret, otp))
        return res.json({ ok: false, requireOtp: true, message: "인증 코드가 올바르지 않습니다." });
    }
    res.json({ ok: true, employee });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 2단계 인증(TOTP) 설정 ──────────────────────────────────────────────────────
// 1) generate-secret: 비밀번호 재확인 후 새 시크릿 발급(아직 미저장 — 클라이언트가
//    인증 앱에 등록하고 코드로 검증 성공해야 emp.twoFactorSecret/Enabled로 저장됨)
app.post("/api/auth/2fa/generate-secret", async (req, res) => {
  try {
    const { loginId, pw } = req.body || {};
    const employee = await verifyCredentials(loginId, pw);
    if (!employee) return res.status(403).json({ ok: false, message: "비밀번호가 올바르지 않습니다." });
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

// POST /save
app.post("/save", async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object")
    return res.status(400).json({ ok: false, message: "잘못된 데이터" });

  // getFullState() sends { _version, _action, data: { employees, kpiEntries, ... } }
  // Unwrap nested .data if present so persistData sees a flat structure
  const clientData = body.data
    ? { ...body.data, _version: body._version, _user: body._user }
    : body;

  try {
    let finalData = clientData;
    let merged    = false;

    if (clientData._version !== undefined && clientData._version < _dataVersion) {
      const serverData = await loadData();
      finalData = smartMerge(serverData, clientData);
      merged    = true;
    }

    const changedBy = req.query.user || clientData._user || "unknown";
    const { duplicateLoginIds } = await persistData(finalData, changedBy);

    const meta = {
      empCount:  (finalData.employees  || []).length,
      kpiCount:  (finalData.kpiEntries || []).length,
      lastSaved: _lastSaved,
    };
    broadcastSSE("data_updated", { version: _dataVersion, meta }, req.query.clientId);
    res.json({
      ok: true, version: _dataVersion, merged,
      mergedData: merged ? stripPwField(finalData) : undefined,
      meta,
      warnings: duplicateLoginIds && duplicateLoginIds.length ? { duplicateLoginIds } : undefined,
    });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// GET /events — SSE
app.get("/events", (req, res) => {
  const clientId = req.query.clientId || `client_${Date.now()}`;
  const user     = req.query.user     || "unknown";

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  _sseClients[clientId] = { res, user, connectedAt: new Date().toISOString() };
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, version: _dataVersion })}\n\n`);
  res.write(`event: locks_update\ndata: ${JSON.stringify(_locks)}\n\n`);
  broadcastSSE("user_online", { clientId, user, action: "join" }, clientId);

  const heartbeat = setInterval(() => {
    try { res.write(":heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    delete _sseClients[clientId];
    broadcastSSE("user_online", { clientId, user, action: "leave" });
  });
});

// GET /online
app.get("/online", (req, res) => {
  const users = Object.entries(_sseClients).map(([cid, c]) => ({
    clientId: cid, user: c.user, connectedAt: c.connectedAt,
  }));
  res.json({ ok: true, users });
});

// POST /lock
app.post("/lock", (req, res) => {
  const { key, userId, userName, targetLabel, ttlMs = 30 * 60 * 1000 } = req.body;
  if (!key || !userId)
    return res.status(400).json({ ok: false, message: "key, userId 필요" });

  const ex = _locks[key];
  if (ex && ex.userId !== userId && Date.now() < ex.expiresAt)
    return res.json({ ok: false, lock: ex });

  _locks[key] = { userId, userName, targetLabel, acquiredAt: Date.now(), expiresAt: Date.now() + ttlMs };
  broadcastSSE("locks_update", _locks);
  res.json({ ok: true, lock: _locks[key] });
});

// POST /unlock
app.post("/unlock", (req, res) => {
  const { key, userId, force } = req.body;
  if (!key) return res.status(400).json({ ok: false });
  const ex = _locks[key];
  if (ex && (ex.userId === userId || force)) {
    delete _locks[key];
    broadcastSSE("locks_update", _locks);
  }
  res.json({ ok: true });
});

// POST /log
app.post("/log", (req, res) => {
  if (!req.body) return res.status(400).json({ ok: false });
  addActivityLog(req.body);
  res.json({ ok: true });
});

// GET /activity
app.get("/activity", (req, res) => {
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
app.post("/snapshots", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { year = new Date().getFullYear(), confirmedBy = "admin", notes = "" } = req.body || {};
  try {
    const data = await loadData();
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
    const data = await loadData();
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
  try {
    const yr = parseInt(req.params.year);
    const fields = (req.query.fields || "").split(",").map(f => f.trim()).filter(Boolean);
    if (!fields.length) return res.status(400).json({ ok: false, message: "fields 쿼리 필요" });

    const snapshotData = await loadSnapshotData(yr);
    if (!snapshotData) return res.status(404).json({ ok: false, message: "스냅샷 없음" });
    const current = await loadData();

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
  try {
    const snapshotData = await loadSnapshotData(year);
    if (!snapshotData) return res.status(404).json({ ok: false, message: "스냅샷 없음" });

    const current = await loadData();
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

    await persistData(dataToPersist, req.body.user || "restore");

    // persistData only ever inserts/updates; explicitly delete the extras
    // here when the caller opted into a true point-in-time restore.
    if (deleteExtras && !USE_JSON_FILE) {
      for (const [field, extraIds] of Object.entries(extrasByField)) {
        if (!extraIds.length) continue;
        if (field === "employees") {
          await pool.query(
            "INSERT INTO employee_history (employee_id, action, changed_by, data) SELECT id, 'delete', $2, data FROM employees WHERE id = ANY($1)",
            [extraIds, "restore"]
          );
          await pool.query("DELETE FROM employees WHERE id = ANY($1)", [extraIds]);
        } else if (field === "kpiEntries") {
          await pool.query(
            "INSERT INTO kpi_history (kpi_id, action, changed_by, data) SELECT id, 'delete', $2, data FROM kpi_entries WHERE id = ANY($1)",
            [extraIds, "restore"]
          );
          await pool.query("DELETE FROM kpi_entries WHERE id = ANY($1)", [extraIds]);
        } else {
          await pool.query("DELETE FROM app_collections WHERE collection = $1 AND id = ANY($2)", [field, extraIds]);
        }
      }
    }

    const finalData = await loadData();
    broadcastSSE("data_restored", { name, fields: restoredFields, deletedExtras: deleteExtras, version: _dataVersion });
    res.json({ ok: true, version: _dataVersion, restoredFields, deletedExtras: deleteExtras, data: stripPwField(finalData) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── History endpoints ─────────────────────────────────────────────────────────
// In JSON file mode, change history is persisted to hr-data-history.json (see _fileHistory).

// GET /history/employee/:id
app.get("/history/employee/:id", async (req, res) => {
  if (USE_JSON_FILE) {
    const history = (_fileHistory.employees || [])
      .filter(h => h.employee_id === req.params.id)
      .slice(-500).reverse()
      .map(h => ({ history_id: h.id, action: h.action, changed_by: h.changed_by, changed_at: h.changed_at, data: omitPw(h.data) }));
    return res.json({ ok: true, history });
  }
  try {
    const { rows } = await pool.query(
      `SELECT history_id, action, changed_by, changed_at, data
       FROM employee_history WHERE employee_id = $1
       ORDER BY changed_at DESC LIMIT 500`,
      [req.params.id]
    );
    res.json({ ok: true, history: rows.map(r => ({ ...r, data: omitPw(r.data) })) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// GET /history/kpi/:id
app.get("/history/kpi/:id", async (req, res) => {
  if (USE_JSON_FILE) {
    const history = (_fileHistory.kpi || [])
      .filter(h => h.kpi_id === req.params.id)
      .slice(-500).reverse()
      .map(h => ({ history_id: h.id, action: h.action, changed_by: h.changed_by, changed_at: h.changed_at, data: h.data }));
    return res.json({ ok: true, history });
  }
  try {
    const { rows } = await pool.query(
      `SELECT history_id, action, changed_by, changed_at, data
       FROM kpi_history WHERE kpi_id = $1
       ORDER BY changed_at DESC LIMIT 500`,
      [req.params.id]
    );
    res.json({ ok: true, history: rows });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// GET /history/changes?since=ISO_DATE&table=employees|kpi_entries
app.get("/history/changes", async (req, res) => {
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
    const results = {};
    if (!table || table === "employees") {
      const { rows } = await pool.query(
        "SELECT * FROM employee_history WHERE changed_at >= $1 ORDER BY changed_at DESC LIMIT 1000",
        [since]
      );
      results.employeeChanges = rows.map(r => ({ ...r, data: omitPw(r.data) }));
    }
    if (!table || table === "kpi_entries") {
      const { rows } = await pool.query(
        "SELECT * FROM kpi_history WHERE changed_at >= $1 ORDER BY changed_at DESC LIMIT 1000",
        [since]
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
function _nextAcctSeq(kind, year) {
  if (!_fileAccounting[kind]) _fileAccounting[kind] = {};
  const next = (_fileAccounting[kind][year] || 0) + 1;
  _fileAccounting[kind][year] = next;
  return next;
}
function requireAdmin(req, res) {
  if ((req.body || {}).role !== "admin") {
    res.status(403).json({ ok: false, message: "관리자만 사용할 수 있습니다." });
    return false;
  }
  return true;
}
function requireRole(req, res, allowed) {
  const role = (req.body || {}).role;
  if (!allowed.includes(role)) {
    res.status(403).json({ ok: false, message: "이 작업을 수행할 권한이 없습니다." });
    return false;
  }
  return true;
}
function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ── 계정과목 (Chart of accounts) ────────────────────────────────────────────
app.get("/api/accounting/accounts", async (req, res) => {
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, accounts: _fileAccounting.accounts });
    const { rows } = await pool.query("SELECT id, data FROM accounts WHERE is_deleted = FALSE ORDER BY id");
    res.json({ ok: true, accounts: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/accounts", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const { id, code, name, type, category, active = true, user } = req.body || {};
    if (!code || !name || !type)
      return res.status(400).json({ ok: false, message: "계정코드, 계정명, 구분은 필수입니다." });
    const accId = id || `acc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (USE_JSON_FILE) {
      const idx = _fileAccounting.accounts.findIndex(a => a.id === accId);
      const prevHist = idx >= 0 ? (_fileAccounting.accounts[idx].history || []) : [];
      const histEntry = { action: idx >= 0 ? "update" : "create", user: user || "unknown", at: new Date().toISOString() };
      const acc = { id: accId, code, name, type, category: category || "", active, history: [...prevHist, histEntry] };
      if (idx >= 0) _fileAccounting.accounts[idx] = acc; else _fileAccounting.accounts.push(acc);
      _saveFileAccounting();
      return res.json({ ok: true, account: acc });
    }
    const { rows: prevRows } = await pool.query("SELECT data FROM accounts WHERE id = $1", [accId]);
    const prevHist = prevRows.length ? (prevRows[0].data.history || []) : [];
    const histEntry = { action: prevRows.length ? "update" : "create", user: user || "unknown", at: new Date().toISOString() };
    const acc = { id: accId, code, name, type, category: category || "", active, history: [...prevHist, histEntry] };
    await pool.query(
      "INSERT INTO accounts (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()",
      [accId, acc]
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
    const { rows } = await pool.query("SELECT 1 FROM vouchers WHERE data->'lines' @> $1::jsonb LIMIT 1", [JSON.stringify([{ accountId: id }])]);
    if (rows.length) return res.status(400).json({ ok: false, message: "전표에서 사용 중인 계정과목은 삭제할 수 없습니다. 비활성화를 이용하세요." });
    await pool.query("UPDATE accounts SET is_deleted = TRUE WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 전표 (Journal vouchers) ──────────────────────────────────────────────────
async function _getAccountsList() {
  if (USE_JSON_FILE) return _fileAccounting.accounts;
  const { rows } = await pool.query("SELECT id, data FROM accounts WHERE is_deleted = FALSE");
  return rows.map(r => ({ id: r.id, ...r.data }));
}
function _validateVoucherLines(lines, accounts) {
  if (!Array.isArray(lines) || lines.length < 2) return "전표에는 2개 이상의 분개 라인이 필요합니다.";
  const accIds = new Set(accounts.map(a => a.id));
  for (const l of lines) {
    if (!accIds.has(l.accountId)) return `존재하지 않는 계정과목입니다: ${l.accountId}`;
    if ((Number(l.debit) || 0) > 0 && (Number(l.credit) || 0) > 0) return "한 라인에 차변과 대변을 동시에 입력할 수 없습니다.";
  }
  const debitSum = _round2(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const creditSum = _round2(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0));
  if (debitSum !== creditSum) return `차변 합계(${debitSum})와 대변 합계(${creditSum})가 일치하지 않습니다.`;
  if (debitSum <= 0) return "전표 금액은 0보다 커야 합니다.";
  return null;
}

app.get("/api/accounting/vouchers", async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year) : null;
    if (USE_JSON_FILE) {
      let list = _fileAccounting.vouchers;
      if (year) list = list.filter(v => new Date(v.date).getFullYear() === year);
      return res.json({ ok: true, vouchers: list.sort((a, b) => b.date.localeCompare(a.date)) });
    }
    const { rows } = year
      ? await pool.query("SELECT data FROM vouchers WHERE EXTRACT(YEAR FROM voucher_date) = $1 ORDER BY voucher_date DESC", [year])
      : await pool.query("SELECT data FROM vouchers ORDER BY voucher_date DESC");
    res.json({ ok: true, vouchers: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/vouchers", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const { date, description, partner, partnerId, lines, user: createdBy } = req.body || {};
    if (!date) return res.status(400).json({ ok: false, message: "전표일자는 필수입니다." });
    const accounts = await _getAccountsList();
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
    await pool.query("INSERT INTO vouchers (id, voucher_no, voucher_date, status, data) VALUES ($1,$2,$3,'draft',$4)",
      [voucher.id, `DRAFT-${voucher.id}`, date, voucher]);
    res.json({ ok: true, voucher });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/vouchers/:id/post", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;
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
      const { rows } = await client.query("SELECT data, status FROM vouchers WHERE id = $1 FOR UPDATE", [id]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "전표를 찾을 수 없습니다." }); }
      if (rows[0].status !== "draft") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "임시 저장 상태의 전표만 확정할 수 있습니다." }); }
      const { rows: seqRows } = await client.query(
        "INSERT INTO voucher_seq (year, seq) VALUES ($1,1) ON CONFLICT (year) DO UPDATE SET seq = voucher_seq.seq + 1 RETURNING seq",
        [year]
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
    const { rows } = await pool.query("SELECT data FROM vouchers WHERE id = $1 AND status = 'posted'", [id]);
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
    if (USE_JSON_FILE) {
      const v = _fileAccounting.vouchers.find(v => v.id === id);
      if (!v) return res.status(404).json({ ok: false, message: "전표를 찾을 수 없습니다." });
      if (v.status !== "draft") return res.status(400).json({ ok: false, message: "임시 저장 상태의 전표만 삭제할 수 있습니다." });
      _fileAccounting.vouchers = _fileAccounting.vouchers.filter(v => v.id !== id);
      _saveFileAccounting();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT 1 FROM vouchers WHERE id = $1 AND status = 'draft'", [id]);
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
  try {
    const year = req.query.year ? parseInt(req.query.year) : null;
    if (USE_JSON_FILE) {
      let list = _fileAccounting.taxInvoices;
      if (year) list = list.filter(t => new Date(t.issueDate).getFullYear() === year);
      return res.json({ ok: true, taxInvoices: list.sort((a, b) => b.issueDate.localeCompare(a.issueDate)) });
    }
    const { rows } = year
      ? await pool.query("SELECT data FROM tax_invoices WHERE EXTRACT(YEAR FROM issue_date) = $1 ORDER BY issue_date DESC", [year])
      : await pool.query("SELECT data FROM tax_invoices ORDER BY issue_date DESC");
    res.json({ ok: true, taxInvoices: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/tax-invoices", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
        "INSERT INTO tax_invoice_seq (year, seq) VALUES ($1,1) ON CONFLICT (year) DO UPDATE SET seq = tax_invoice_seq.seq + 1 RETURNING seq",
        [year]
      );
      inv.invoiceNo = `TI-${year}-${String(seqRows[0].seq).padStart(6, "0")}`;
      await client.query("INSERT INTO tax_invoices (id, invoice_no, issue_date, status, data) VALUES ($1,$2,$3,'issued',$4)",
        [inv.id, inv.invoiceNo, issueDate, inv]);
      await client.query("COMMIT");
      res.json({ ok: true, taxInvoice: inv });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/tax-invoices/:id/void", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;
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
    const { rows } = await pool.query("SELECT data FROM tax_invoices WHERE id = $1 AND status = 'issued'", [id]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "발행된 세금계산서만 취소할 수 있습니다." });
    const inv = { ...rows[0].data, status: "void", voidReason: reason, voidedBy: req.body.user || "unknown", voidedAt: new Date().toISOString() };
    await pool.query("UPDATE tax_invoices SET status = 'void', data = $2, updated_at = NOW() WHERE id = $1", [id, inv]);
    res.json({ ok: true, taxInvoice: inv });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 수금/지급 (AR/AP payments — 거래처별 미수·미지급 관리) ────────────────────
// JSON 모드: _fileAccounting.payments / PG 모드: app_collections(acctPayments)
app.get("/api/accounting/payments", async (req, res) => {
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, payments: _fileAccounting.payments || [] });
    const { rows } = await pool.query("SELECT data FROM app_collections WHERE collection = 'acctPayments' ORDER BY created_at");
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
    await pool.query("INSERT INTO app_collections (collection, id, data, updated_at) VALUES ('acctPayments',$1,$2,NOW())", [payment.id, payment]);
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
    await pool.query("DELETE FROM app_collections WHERE collection = 'acctPayments' AND id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 거래처 (Business partners — customer/vendor master data) ─────────────────
app.get("/api/accounting/partners", async (req, res) => {
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, partners: _fileAccounting.partners });
    const { rows } = await pool.query("SELECT id, data FROM partners WHERE is_deleted = FALSE ORDER BY id");
    res.json({ ok: true, partners: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/partners", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
    const { rows: prevRows } = await pool.query("SELECT data FROM partners WHERE id = $1", [partnerId]);
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
      "INSERT INTO partners (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()",
      [partnerId, partner]
    );
    res.json({ ok: true, partner });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/accounting/partners/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;
    if (USE_JSON_FILE) {
      const used = _fileAccounting.vouchers.some(v => v.partnerId === id) || _fileAccounting.taxInvoices.some(t => t.partnerId === id);
      if (used) return res.status(400).json({ ok: false, message: "전표 또는 세금계산서에서 사용 중인 거래처는 삭제할 수 없습니다. 비활성화를 이용하세요." });
      _fileAccounting.partners = _fileAccounting.partners.filter(p => p.id !== id);
      _saveFileAccounting();
      return res.json({ ok: true });
    }
    const { rows: vRows } = await pool.query("SELECT 1 FROM vouchers WHERE data->>'partnerId' = $1 LIMIT 1", [id]);
    const { rows: tRows } = await pool.query("SELECT 1 FROM tax_invoices WHERE data->>'partnerId' = $1 LIMIT 1", [id]);
    if (vRows.length || tRows.length) return res.status(400).json({ ok: false, message: "전표 또는 세금계산서에서 사용 중인 거래처는 삭제할 수 없습니다. 비활성화를 이용하세요." });
    await pool.query("UPDATE partners SET is_deleted = TRUE WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, items: _fileErp.items });
    const { rows } = await pool.query("SELECT id, data FROM erp_items WHERE is_deleted = FALSE ORDER BY id");
    res.json({ ok: true, items: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/items", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
    await pool.query("INSERT INTO erp_items (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()", [itemId, item]);
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/items/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;
    if (USE_JSON_FILE) {
      const used = _fileErp.stockLedger.some(l => l.itemId === id) ||
        _fileErp.quotations.some(q => (q.lines || []).some(l => l.itemId === id)) ||
        _fileErp.purchaseOrders.some(p => (p.lines || []).some(l => l.itemId === id));
      if (used) return res.status(400).json({ ok: false, message: "재고 이력 또는 문서에서 사용 중인 품목은 삭제할 수 없습니다. 비활성화를 이용하세요." });
      _fileErp.items = _fileErp.items.filter(i => i.id !== id);
      _saveFileErp();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT 1 FROM erp_stock_ledger WHERE item_id = $1 LIMIT 1", [id]);
    if (rows.length) return res.status(400).json({ ok: false, message: "재고 이력 또는 문서에서 사용 중인 품목은 삭제할 수 없습니다. 비활성화를 이용하세요." });
    await pool.query("UPDATE erp_items SET is_deleted = TRUE WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 창고/위치 마스터 ─────────────────────────────────────────────────────────
app.get("/api/erp/locations", async (req, res) => {
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, locations: _fileErp.locations });
    const { rows } = await pool.query("SELECT id, data FROM erp_locations WHERE is_deleted = FALSE ORDER BY id");
    res.json({ ok: true, locations: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/locations", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
    await pool.query("INSERT INTO erp_locations (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()", [locId, loc]);
    res.json({ ok: true, location: loc });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/locations/:id/delete", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;
    if (USE_JSON_FILE) {
      const used = _fileErp.stockLedger.some(l => l.locationId === id);
      if (used) return res.status(400).json({ ok: false, message: "재고 이력에서 사용 중인 위치는 삭제할 수 없습니다. 비활성화를 이용하세요." });
      _fileErp.locations = _fileErp.locations.filter(l => l.id !== id);
      _saveFileErp();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT 1 FROM erp_stock_ledger WHERE location_id = $1 LIMIT 1", [id]);
    if (rows.length) return res.status(400).json({ ok: false, message: "재고 이력에서 사용 중인 위치는 삭제할 수 없습니다. 비활성화를 이용하세요." });
    await pool.query("UPDATE erp_locations SET is_deleted = TRUE WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 견적서 (Quotations) ─────────────────────────────────────────────────────
app.get("/api/erp/quotations", async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year) : null;
    if (USE_JSON_FILE) {
      let list = _fileErp.quotations;
      if (year) list = list.filter(q => new Date(q.date).getFullYear() === year);
      return res.json({ ok: true, quotations: list.sort((a, b) => b.date.localeCompare(a.date)) });
    }
    const { rows } = year
      ? await pool.query("SELECT data FROM erp_quotations WHERE EXTRACT(YEAR FROM doc_date) = $1 ORDER BY doc_date DESC", [year])
      : await pool.query("SELECT data FROM erp_quotations ORDER BY doc_date DESC");
    res.json({ ok: true, quotations: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/quotations", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
    await pool.query("INSERT INTO erp_quotations (id, doc_date, status, data) VALUES ($1,$2,'draft',$3)", [quote.id, date, quote]);
    res.json({ ok: true, quotation: quote });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/quotations/:id/send", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;
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
      const { rows } = await client.query("SELECT data, status FROM erp_quotations WHERE id = $1 FOR UPDATE", [id]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." }); }
      if (rows[0].status !== "draft") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "임시 저장 상태의 견적서만 발송할 수 있습니다." }); }
      const { rows: seqRows } = await client.query(
        "INSERT INTO erp_quote_seq (year, seq) VALUES ($1,1) ON CONFLICT (year) DO UPDATE SET seq = erp_quote_seq.seq + 1 RETURNING seq", [year]
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
    if (USE_JSON_FILE) {
      const q = _fileErp.quotations.find(q => q.id === id);
      if (!q) return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." });
      if (q.status !== "sent") return res.status(400).json({ ok: false, message: "발송된 견적서만 수주 확정할 수 있습니다." });
      q.status = "accepted"; q.acceptedBy = req.body.user || "unknown"; q.acceptedAt = new Date().toISOString();
      _saveFileErp();
      return res.json({ ok: true, quotation: q });
    }
    const { rows } = await pool.query("SELECT data FROM erp_quotations WHERE id = $1 AND status = 'sent'", [id]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "발송된 견적서만 수주 확정할 수 있습니다." });
    const q = { ...rows[0].data, status: "accepted", acceptedBy: req.body.user || "unknown", acceptedAt: new Date().toISOString() };
    await pool.query("UPDATE erp_quotations SET status = 'accepted', data = $2, updated_at = NOW() WHERE id = $1", [id, q]);
    res.json({ ok: true, quotation: q });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// 출고/매출 처리: 수주 확정된 견적서를 기준으로 재고 출고(원장 차감)와 세금계산서 발행을
// 한 번에 처리한다. 재고 부족 시 거부, 성공 시 견적서는 'shipped'로 종결된다.
app.post("/api/erp/quotations/:id/ship", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;
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
        issueDate: q.date, partnerId: q.partnerId || null, partnerName: q.partnerName, partnerBizNo: "",
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
      const { rows } = await client.query("SELECT data, status FROM erp_quotations WHERE id = $1 FOR UPDATE", [id]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." }); }
      const q0 = rows[0].data;
      if (rows[0].status !== "accepted") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "수주 확정된 견적서만 출고 처리할 수 있습니다." }); }
      if (!q0.locationId) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "출고 위치가 지정되지 않은 견적서입니다." }); }
      for (const l of q0.lines) {
        const { rows: ledgerRows } = await client.query(
          "SELECT data FROM erp_stock_ledger WHERE item_id = $1 AND location_id = $2 FOR UPDATE", [l.itemId, q0.locationId]
        );
        const current = ledgerRows.reduce((sum, r) => sum + (r.data.type === "out" ? -Math.abs(r.data.qty) : Math.abs(r.data.qty)), 0);
        if (current < l.qty) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: `재고 부족: ${l.name || l.itemId} (현재 ${current} / 필요 ${l.qty})` }); }
      }
      for (const l of q0.lines) {
        await client.query(
          "INSERT INTO erp_stock_ledger (id, item_id, location_id, data) VALUES ($1,$2,$3,$4)",
          [`sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, l.itemId, q0.locationId,
           { itemId: l.itemId, locationId: q0.locationId, type: "out", qty: l.qty, refType: "quotation", refId: q0.id, refNo: q0.quoteNo, memo: `견적 출고 (${q0.quoteNo})`, createdBy: user, createdAt: now }]
        );
      }
      const year = new Date(q0.date).getFullYear();
      const { rows: seqRows } = await client.query(
        "INSERT INTO tax_invoice_seq (year, seq) VALUES ($1,1) ON CONFLICT (year) DO UPDATE SET seq = tax_invoice_seq.seq + 1 RETURNING seq", [year]
      );
      const invoiceNo = `TI-${year}-${String(seqRows[0].seq).padStart(6, "0")}`;
      const invTotals = _buildTaxInvoiceTotals(q0.lines);
      const inv = {
        id: `ti_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        invoiceNo, status: "issued", direction: "sales",
        issueDate: q0.date, partnerId: q0.partnerId || null, partnerName: q0.partnerName, partnerBizNo: "",
        ...invTotals,
        createdBy: user, createdAt: now, sourceType: "quotation", sourceId: q0.id, sourceNo: q0.quoteNo,
      };
      await client.query("INSERT INTO tax_invoices (id, invoice_no, issue_date, status, data) VALUES ($1,$2,$3,'issued',$4)", [inv.id, invoiceNo, q0.date, inv]);
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
    const { rows } = await pool.query("SELECT data FROM erp_quotations WHERE id = $1 AND status = 'sent'", [id]);
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
    if (USE_JSON_FILE) {
      const q = _fileErp.quotations.find(q => q.id === id);
      if (!q) return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." });
      if (q.status !== "draft") return res.status(400).json({ ok: false, message: "임시 저장 상태의 견적서만 삭제할 수 있습니다." });
      _fileErp.quotations = _fileErp.quotations.filter(q => q.id !== id);
      _saveFileErp();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT 1 FROM erp_quotations WHERE id = $1 AND status = 'draft'", [id]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "임시 저장 상태의 견적서만 삭제할 수 있습니다." });
    await pool.query("DELETE FROM erp_quotations WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 발주서 (Purchase orders) ────────────────────────────────────────────────
app.get("/api/erp/purchase-orders", async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year) : null;
    if (USE_JSON_FILE) {
      let list = _fileErp.purchaseOrders;
      if (year) list = list.filter(p => new Date(p.date).getFullYear() === year);
      return res.json({ ok: true, purchaseOrders: list.sort((a, b) => b.date.localeCompare(a.date)) });
    }
    const { rows } = year
      ? await pool.query("SELECT data FROM erp_purchase_orders WHERE EXTRACT(YEAR FROM doc_date) = $1 ORDER BY doc_date DESC", [year])
      : await pool.query("SELECT data FROM erp_purchase_orders ORDER BY doc_date DESC");
    res.json({ ok: true, purchaseOrders: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/purchase-orders", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
    await pool.query("INSERT INTO erp_purchase_orders (id, doc_date, status, data) VALUES ($1,$2,'draft',$3)", [po.id, date, po]);
    res.json({ ok: true, purchaseOrder: po });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/purchase-orders/:id/confirm", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;
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
      const { rows } = await client.query("SELECT data, status FROM erp_purchase_orders WHERE id = $1 FOR UPDATE", [id]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "발주서를 찾을 수 없습니다." }); }
      if (rows[0].status !== "draft") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "임시 저장 상태의 발주서만 발주 확정할 수 있습니다." }); }
      const { rows: seqRows } = await client.query(
        "INSERT INTO erp_po_seq (year, seq) VALUES ($1,1) ON CONFLICT (year) DO UPDATE SET seq = erp_po_seq.seq + 1 RETURNING seq", [year]
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
        issueDate: po.date, partnerId: po.partnerId || null, partnerName: po.partnerName, partnerBizNo: "",
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
      const { rows } = await client.query("SELECT data, status FROM erp_purchase_orders WHERE id = $1 FOR UPDATE", [id]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "발주서를 찾을 수 없습니다." }); }
      if (rows[0].status !== "ordered") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: "발주 확정 상태의 발주서만 입고 처리할 수 있습니다." }); }
      const po0 = rows[0].data;
      const now = new Date().toISOString();
      for (const l of po0.lines) {
        await client.query(
          "INSERT INTO erp_stock_ledger (id, item_id, location_id, data) VALUES ($1,$2,$3,$4)",
          [`sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, l.itemId, po0.locationId,
           { itemId: l.itemId, locationId: po0.locationId, type: "in", qty: l.qty, refType: "po", refId: po0.id, refNo: po0.poNo, memo: `발주 입고 (${po0.poNo})`, createdBy: user, createdAt: now }]
        );
      }
      const year = new Date(po0.date).getFullYear();
      const { rows: seqRows } = await client.query(
        "INSERT INTO tax_invoice_seq (year, seq) VALUES ($1,1) ON CONFLICT (year) DO UPDATE SET seq = tax_invoice_seq.seq + 1 RETURNING seq", [year]
      );
      const invoiceNo = `TI-${year}-${String(seqRows[0].seq).padStart(6, "0")}`;
      const invTotals = _buildTaxInvoiceTotals(po0.lines);
      const inv = {
        id: `ti_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        invoiceNo, status: "issued", direction: "purchase",
        issueDate: po0.date, partnerId: po0.partnerId || null, partnerName: po0.partnerName, partnerBizNo: "",
        ...invTotals,
        createdBy: user, createdAt: now, sourceType: "po", sourceId: po0.id, sourceNo: po0.poNo,
      };
      await client.query("INSERT INTO tax_invoices (id, invoice_no, issue_date, status, data) VALUES ($1,$2,$3,'issued',$4)", [inv.id, invoiceNo, po0.date, inv]);
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
    const { rows } = await pool.query("SELECT data FROM erp_purchase_orders WHERE id = $1 AND status != 'received'", [id]);
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
    const { rows } = await pool.query("SELECT 1 FROM erp_purchase_orders WHERE id = $1 AND status = 'draft'", [id]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "임시 저장 상태의 발주서만 삭제할 수 있습니다." });
    await pool.query("DELETE FROM erp_purchase_orders WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 구매요청 (Purchase requests — 구성원이 요청, admin이 승인/반려/발주전환) ─────
app.get("/api/erp/purchase-requests", async (req, res) => {
  try {
    const { role, userId } = req.query;
    if (USE_JSON_FILE) {
      let list = _fileErp.purchaseRequests;
      if (role !== "admin") list = list.filter(r => String(r.requestedById) === String(userId));
      return res.json({ ok: true, purchaseRequests: list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    }
    const { rows } = role === "admin"
      ? await pool.query("SELECT data FROM erp_purchase_requests ORDER BY created_at DESC")
      : await pool.query("SELECT data FROM erp_purchase_requests WHERE data->>'requestedById' = $1 ORDER BY created_at DESC", [String(userId)]);
    res.json({ ok: true, purchaseRequests: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/purchase-requests", async (req, res) => {
  try {
    const { date, items, memo, userId, user: requestedBy } = req.body || {};
    if (!date) return res.status(400).json({ ok: false, message: "요청일자는 필수입니다." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, message: "품목을 1개 이상 입력하세요." });
    if (items.some(it => !it.itemId)) return res.status(400).json({ ok: false, message: "모든 라인에 품목을 선택하세요." });
    const totals = _buildItemLineTotals(items);
    const pr = {
      id: `pr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: "pending",
      date, ...totals, memo: memo || "",
      requestedById: userId != null ? String(userId) : null, requestedBy: requestedBy || "unknown",
      createdAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      _fileErp.purchaseRequests.push(pr);
      _saveFileErp();
      return res.json({ ok: true, purchaseRequest: pr });
    }
    await pool.query("INSERT INTO erp_purchase_requests (id, doc_date, status, data) VALUES ($1,$2,'pending',$3)", [pr.id, date, pr]);
    res.json({ ok: true, purchaseRequest: pr });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/erp/purchase-requests/:id/approve", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;
    const user = req.body.user || "unknown";
    if (USE_JSON_FILE) {
      const pr = _fileErp.purchaseRequests.find(r => r.id === id);
      if (!pr) return res.status(404).json({ ok: false, message: "구매요청을 찾을 수 없습니다." });
      if (pr.status !== "pending") return res.status(400).json({ ok: false, message: "대기 중인 요청만 승인할 수 있습니다." });
      pr.status = "approved"; pr.approvedBy = user; pr.approvedAt = new Date().toISOString();
      _saveFileErp();
      return res.json({ ok: true, purchaseRequest: pr });
    }
    const { rows } = await pool.query("SELECT data FROM erp_purchase_requests WHERE id = $1 AND status = 'pending'", [id]);
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
    const { rows } = await pool.query("SELECT data FROM erp_purchase_requests WHERE id = $1 AND status = 'pending'", [id]);
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
      const { rows } = await client.query("SELECT data, status FROM erp_purchase_requests WHERE id = $1 FOR UPDATE", [id]);
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
      await client.query("INSERT INTO erp_purchase_orders (id, doc_date, status, data) VALUES ($1,$2,'draft',$3)", [po.id, po.date, po]);
      const pr = { ...pr0, status: "converted", convertedPoId: po.id, convertedAt: new Date().toISOString() };
      await client.query("UPDATE erp_purchase_requests SET status = 'converted', data = $2, updated_at = NOW() WHERE id = $1", [id, pr]);
      await client.query("COMMIT");
      res.json({ ok: true, purchaseOrder: po, purchaseRequest: pr });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.delete("/api/erp/purchase-requests/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { role, userId } = req.body || {};
    if (USE_JSON_FILE) {
      const pr = _fileErp.purchaseRequests.find(r => r.id === id);
      if (!pr) return res.status(404).json({ ok: false, message: "구매요청을 찾을 수 없습니다." });
      if (pr.status !== "pending") return res.status(400).json({ ok: false, message: "대기 중인 요청만 삭제할 수 있습니다." });
      if (role !== "admin" && String(pr.requestedById) !== String(userId)) return res.status(403).json({ ok: false, message: "본인 요청만 삭제할 수 있습니다." });
      _fileErp.purchaseRequests = _fileErp.purchaseRequests.filter(r => r.id !== id);
      _saveFileErp();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT data FROM erp_purchase_requests WHERE id = $1 AND status = 'pending'", [id]);
    if (!rows.length) return res.status(400).json({ ok: false, message: "대기 중인 요청만 삭제할 수 있습니다." });
    if (role !== "admin" && String(rows[0].data.requestedById) !== String(userId)) return res.status(403).json({ ok: false, message: "본인 요청만 삭제할 수 있습니다." });
    await pool.query("DELETE FROM erp_purchase_requests WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 재고 (Stock — computed from ledger, plus manual adjustment) ──────────────
app.get("/api/erp/stock", async (req, res) => {
  try {
    let ledger;
    if (USE_JSON_FILE) {
      ledger = _fileErp.stockLedger;
    } else {
      const { rows } = await pool.query("SELECT data FROM erp_stock_ledger");
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
  try {
    const { itemId, locationId } = req.query;
    let ledger;
    if (USE_JSON_FILE) {
      ledger = _fileErp.stockLedger;
    } else {
      const { rows } = await pool.query("SELECT data FROM erp_stock_ledger");
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
    const { itemId, locationId, type, qty, memo, user } = req.body || {};
    if (!itemId || !locationId) return res.status(400).json({ ok: false, message: "품목과 위치를 선택하세요." });
    if (!["in", "out"].includes(type)) return res.status(400).json({ ok: false, message: "입고/출고 구분이 올바르지 않습니다." });
    const qtyNum = Math.abs(Number(qty) || 0);
    if (qtyNum <= 0) return res.status(400).json({ ok: false, message: "수량은 0보다 커야 합니다." });
    let ledger;
    if (USE_JSON_FILE) ledger = _fileErp.stockLedger;
    else { const { rows } = await pool.query("SELECT data FROM erp_stock_ledger WHERE item_id = $1 AND location_id = $2", [itemId, locationId]); ledger = rows.map(r => r.data); }
    const current = ledger.filter(l => l.itemId === itemId && l.locationId === locationId)
      .reduce((s, l) => s + (l.type === "out" ? -Math.abs(l.qty) : Math.abs(l.qty)), 0);
    if (type === "out" && current < qtyNum) return res.status(400).json({ ok: false, message: `현재 재고(${current})보다 많은 수량을 출고할 수 없습니다.` });
    const entry = {
      id: `sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      itemId, locationId, type, qty: qtyNum, refType: "manual", refId: null, refNo: null,
      memo: memo || "", createdBy: user || "unknown", createdAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      _fileErp.stockLedger.push(entry);
      _saveFileErp();
      return res.json({ ok: true, entry });
    }
    await pool.query("INSERT INTO erp_stock_ledger (id, item_id, location_id, data) VALUES ($1,$2,$3,$4)", [entry.id, itemId, locationId, entry]);
    res.json({ ok: true, entry });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// 재고 실사: 여러 품목의 실사 수량을 한 번에 접수해 시스템 재고와의 차이만큼
// 조정 원장(refType:"count")을 생성한다. 차이가 0인 품목은 원장을 남기지 않는다.
app.post("/api/erp/stock/count", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const { locationId, lines, user } = req.body || {};
    if (!locationId || !Array.isArray(lines) || !lines.length)
      return res.status(400).json({ ok: false, message: "위치와 실사 항목이 필요합니다." });
    let ledger;
    if (USE_JSON_FILE) ledger = _fileErp.stockLedger;
    else { const { rows } = await pool.query("SELECT data FROM erp_stock_ledger WHERE location_id = $1", [locationId]); ledger = rows.map(r => r.data); }
    const now = new Date().toISOString();
    const countId = `count_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    if (USE_JSON_FILE) {
      _fileErp.stockLedger.push(...entries);
      _saveFileErp();
      return res.json({ ok: true, adjusted: entries.length, entries });
    }
    for (const e of entries) {
      await pool.query("INSERT INTO erp_stock_ledger (id, item_id, location_id, data) VALUES ($1,$2,$3,$4)", [e.id, e.itemId, e.locationId, e]);
    }
    res.json({ ok: true, adjusted: entries.length, entries });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// 창고 간 이동: 출발 위치에서 출고(out)하고 도착 위치에 입고(in)하는 원장 쌍을 생성한다.
// 두 항목은 같은 transferId/refType:"transfer"로 묶여 이동 이력으로 함께 조회할 수 있다.
app.post("/api/erp/stock/transfer", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
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
      const { rows: ledgerRows } = await client.query("SELECT data FROM erp_stock_ledger WHERE item_id = $1 AND location_id = $2 FOR UPDATE", [itemId, fromLocationId]);
      const current = ledgerRows.reduce((s, r) => s + (r.data.type === "out" ? -Math.abs(r.data.qty) : Math.abs(r.data.qty)), 0);
      if (current < qtyNum) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, message: `출발 위치 재고 부족 (현재 ${current} / 이동 요청 ${qtyNum})` }); }
      const outEntry = { itemId, locationId: fromLocationId, type: "out", qty: qtyNum, refType: "transfer", refId: transferId, refNo: null, memo: memo || "", createdBy, createdAt: now };
      const inEntry = { itemId, locationId: toLocationId, type: "in", qty: qtyNum, refType: "transfer", refId: transferId, refNo: null, memo: memo || "", createdBy, createdAt: now };
      await client.query("INSERT INTO erp_stock_ledger (id, item_id, location_id, data) VALUES ($1,$2,$3,$4)", [`sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, itemId, fromLocationId, outEntry]);
      await client.query("INSERT INTO erp_stock_ledger (id, item_id, location_id, data) VALUES ($1,$2,$3,$4)", [`sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, itemId, toLocationId, inEntry]);
      await client.query("COMMIT");
      res.json({ ok: true, transferId, outEntry, inEntry });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── ERP: 영업 목표 (Sales targets — admin only CRUD, actuals computed client-side) ──
app.get("/api/erp/sales-targets", async (req, res) => {
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, salesTargets: _fileErp.salesTargets });
    const { rows } = await pool.query("SELECT id, data FROM erp_sales_targets WHERE is_deleted = FALSE ORDER BY id");
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
      "INSERT INTO erp_sales_targets (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()",
      [targetId, target]
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
    await pool.query("UPDATE erp_sales_targets SET is_deleted = TRUE WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PMS: 프로젝트 투입률 관리 (Projects / monthly allocation %) ────────────────
app.get("/api/pms/projects", async (req, res) => {
  try {
    if (USE_JSON_FILE) return res.json({ ok: true, projects: _filePms.projects });
    const { rows } = await pool.query("SELECT id, data FROM pms_projects WHERE is_deleted = FALSE ORDER BY created_at DESC");
    res.json({ ok: true, projects: rows.map(r => ({ id: r.id, ...r.data })) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/pms/projects", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader"])) return;
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
    const { rows } = await pool.query("SELECT data FROM pms_projects WHERE id = $1", [projectId]);
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
      "INSERT INTO pms_projects (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()",
      [projectId, project]
    );
    res.json({ ok: true, project });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/pms/projects/:id", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader"])) return;
    const id = req.params.id;
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
    const { rows } = await pool.query("SELECT data FROM pms_projects WHERE id = $1", [id]);
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
    if (USE_JSON_FILE) {
      const project = _filePms.projects.find(p => p.id === id);
      if (!project) return res.status(404).json({ ok: false, message: "프로젝트를 찾을 수 없습니다." });
      project.status = "closed";
      project.updatedAt = new Date().toISOString();
      _saveFilePms();
      return res.json({ ok: true, project });
    }
    const { rows } = await pool.query("SELECT data FROM pms_projects WHERE id = $1", [id]);
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
  try {
    const { year, month, employeeId } = req.query;
    if (USE_JSON_FILE) {
      let list = _filePms.allocations;
      if (year) list = list.filter(a => Number(a.year) === Number(year));
      if (month) list = list.filter(a => Number(a.month) === Number(month));
      if (employeeId) list = list.filter(a => String(a.employeeId) === String(employeeId));
      return res.json({ ok: true, allocations: list });
    }
    const conditions = ["is_deleted = FALSE"];
    const params = [];
    if (year) { params.push(Number(year)); conditions.push(`year = $${params.length}`); }
    if (month) { params.push(Number(month)); conditions.push(`month = $${params.length}`); }
    if (employeeId) { params.push(Number(employeeId)); conditions.push(`employee_id = $${params.length}`); }
    const { rows } = await pool.query(`SELECT data FROM pms_allocations WHERE ${conditions.join(" AND ")} ORDER BY year, month`, params);
    res.json({ ok: true, allocations: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

async function _pmsProjectById(projectId) {
  if (USE_JSON_FILE) return _filePms.projects.find(p => p.id === projectId) || null;
  const { rows } = await pool.query("SELECT data FROM pms_projects WHERE id = $1 AND is_deleted = FALSE", [projectId]);
  return rows[0] ? rows[0].data : null;
}

app.post("/api/pms/allocations", async (req, res) => {
  try {
    const { id, employeeId, year, month, projectId, percent, memo, role, userId } = req.body || {};
    if (!employeeId || !year || !month || !projectId) return res.status(400).json({ ok: false, message: "직원, 연도, 월, 프로젝트는 필수입니다." });
    const percentNum = Number(percent);
    if (isNaN(percentNum) || percentNum <= 0) return res.status(400).json({ ok: false, message: "투입률은 0보다 큰 숫자여야 합니다." });
    if (role !== "admin" && String(employeeId) !== String(userId)) return res.status(403).json({ ok: false, message: "본인 투입률만 등록할 수 있습니다." });
    if (id && role !== "admin") return res.status(403).json({ ok: false, message: "확정된 투입률은 관리자만 변경할 수 있습니다." });
    if (role !== "admin") {
      const project = await _pmsProjectById(projectId);
      if (!project || !(project.members || []).map(String).includes(String(employeeId))) {
        return res.status(403).json({ ok: false, message: "투입 인원으로 등록된 프로젝트만 선택할 수 있습니다." });
      }
    }
    const allocId = id || `alloc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const otherTotal = await _allocationMonthTotal(employeeId, year, month, allocId);
    if (otherTotal + percentNum > 100) return res.status(400).json({ ok: false, message: `투입률 합계가 100%를 초과합니다 (기존 ${otherTotal}% + 신규 ${percentNum}%).` });
    const alloc = {
      id: allocId, employeeId: String(employeeId), year: Number(year), month: Number(month),
      projectId, percent: percentNum, memo: memo || "", updatedAt: new Date().toISOString(),
    };
    if (USE_JSON_FILE) {
      const idx = _filePms.allocations.findIndex(a => a.id === allocId);
      if (idx >= 0) _filePms.allocations[idx] = alloc; else _filePms.allocations.push(alloc);
      _saveFilePms();
      return res.json({ ok: true, allocation: alloc });
    }
    await pool.query(
      "INSERT INTO pms_allocations (id, employee_id, year, month, data) VALUES ($1,$2,$3,$4,$5) " +
      "ON CONFLICT (id) DO UPDATE SET data = $5, employee_id = $2, year = $3, month = $4, updated_at = NOW()",
      [allocId, Number(employeeId), Number(year), Number(month), alloc]
    );
    res.json({ ok: true, allocation: alloc });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/pms/allocations/:id/delete", async (req, res) => {
  try {
    const id = req.params.id;
    const { role } = req.body || {};
    if (role !== "admin") return res.status(403).json({ ok: false, message: "확정된 투입률은 관리자만 삭제할 수 있습니다." });
    if (USE_JSON_FILE) {
      const alloc = _filePms.allocations.find(a => a.id === id);
      if (!alloc) return res.status(404).json({ ok: false, message: "배정 내역을 찾을 수 없습니다." });
      _filePms.allocations = _filePms.allocations.filter(a => a.id !== id);
      _saveFilePms();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT data FROM pms_allocations WHERE id = $1 AND is_deleted = FALSE", [id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "배정 내역을 찾을 수 없습니다." });
    await pool.query("UPDATE pms_allocations SET is_deleted = TRUE WHERE id = $1", [id]);
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
  try {
    const { employeeId, date, year, month } = req.query;
    if (USE_JSON_FILE) {
      let list = _filePms.worklogs;
      if (employeeId) list = list.filter(w => String(w.employeeId) === String(employeeId));
      if (date) list = list.filter(w => w.date === date);
      if (year) list = list.filter(w => w.date && w.date.slice(0, 4) === String(year));
      if (month) list = list.filter(w => w.date && Number(w.date.slice(5, 7)) === Number(month));
      return res.json({ ok: true, worklogs: list });
    }
    const conditions = ["is_deleted = FALSE"];
    const params = [];
    if (employeeId) { params.push(Number(employeeId)); conditions.push(`employee_id = $${params.length}`); }
    if (date) { params.push(date); conditions.push(`work_date = $${params.length}`); }
    if (year) { params.push(String(year)); conditions.push(`EXTRACT(YEAR FROM work_date)::text = $${params.length}`); }
    if (month) { params.push(Number(month)); conditions.push(`EXTRACT(MONTH FROM work_date) = $${params.length}`); }
    const { rows } = await pool.query(`SELECT data FROM pms_worklogs WHERE ${conditions.join(" AND ")} ORDER BY work_date`, params);
    res.json({ ok: true, worklogs: rows.map(r => r.data) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/pms/worklogs", async (req, res) => {
  try {
    const { employeeId, date, blocks, role, userId } = req.body || {};
    if (!employeeId || !date) return res.status(400).json({ ok: false, message: "직원, 날짜는 필수입니다." });
    if (role !== "admin" && String(employeeId) !== String(userId)) return res.status(403).json({ ok: false, message: "본인 업무 기록만 등록할 수 있습니다." });
    const err = _worklogBlocksValid(blocks || []);
    if (err) return res.status(400).json({ ok: false, message: err });
    if (role !== "admin") {
      for (const b of (blocks || [])) {
        const project = await _pmsProjectById(b.projectId);
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
      "INSERT INTO pms_worklogs (id, employee_id, work_date, data) VALUES ($1,$2,$3,$4) " +
      "ON CONFLICT (id) DO UPDATE SET data = $4, updated_at = NOW()",
      [id, Number(employeeId), date, record]
    );
    res.json({ ok: true, worklog: record });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 채용 관리: 채용공고 ────────────────────────────────────────────────────────
async function _recruitAllEmployees() {
  if (USE_JSON_FILE) return _fileStore.employees || [];
  const { rows } = await pool.query("SELECT data FROM employees WHERE is_deleted = FALSE");
  return rows.map(r => r.data);
}
async function _recruitEmpById(empId) {
  const emps = await _recruitAllEmployees();
  return emps.find(e => String(e.id) === String(empId)) || null;
}
// 채용공고 열람 권한: 관리자, 등록자, 해당 부서 팀장/사업부장, 인사팀장, 관리자가 지정한 담당자
async function _recruitCanViewJob(job, userId, role) {
  if (!job) return false;
  if (role === "admin") return true;
  if (String(job.createdBy) === String(userId)) return true;
  if (Array.isArray(job.viewerIds) && job.viewerIds.map(String).includes(String(userId))) return true;
  const emp = await _recruitEmpById(userId);
  if (!emp) return false;
  if (emp.role === "director" && emp.dept === job.department) return true;
  if (emp.role === "leader" && emp.dept === job.department && (!job.team || emp.team === job.team)) return true;
  if (emp.role === "leader" && String(emp.dept || "").includes("인사")) return true;
  return false;
}
app.get("/api/recruit/jobs", async (req, res) => {
  try {
    const { userId, role } = req.query;
    let jobs;
    if (USE_JSON_FILE) {
      jobs = _fileRecruit.jobs;
    } else {
      const { rows } = await pool.query("SELECT id, data FROM recruit_jobs WHERE is_deleted = FALSE ORDER BY created_at DESC");
      jobs = rows.map(r => ({ id: r.id, ...r.data }));
    }
    if (userId && role && role !== "admin") {
      const filtered = [];
      for (const job of jobs) { if (await _recruitCanViewJob(job, userId, role)) filtered.push(job); }
      jobs = filtered;
    }
    res.json({ ok: true, jobs });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/jobs", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const { id, title, department, team, headcount, stages, status, description, purpose, responsibilities, requiredYears, docFile, viewerIds, user: createdBy, userId: createdById } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, message: "채용공고 제목은 필수입니다." });
    const jobId = id || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const defaultStages = ["서류전형", "1차면접", "2차면접", "최종합격"];
    const buildJob = (existing) => ({
      id: jobId, title, department: department || "", team: team || "", headcount: Number(headcount) || 1,
      stages: Array.isArray(stages) && stages.length ? stages : (existing ? existing.stages : defaultStages),
      status: status || "open",
      description: description || "", purpose: purpose || "", responsibilities: responsibilities || "",
      requiredYears: requiredYears != null && requiredYears !== "" ? Number(requiredYears) : (existing ? existing.requiredYears : null),
      docFile: docFile && docFile.fileName ? { fileName: docFile.fileName, type: docFile.type || "", data: docFile.data || "" } : (existing ? existing.docFile : null),
      viewerIds: Array.isArray(viewerIds) ? viewerIds.map(String) : (existing ? existing.viewerIds : []),
      createdBy: existing ? existing.createdBy : (createdBy || createdById || "unknown"),
      createdAt: existing ? existing.createdAt : now, updatedAt: now,
    });
    if (USE_JSON_FILE) {
      const existing = _fileRecruit.jobs.find(j => j.id === jobId);
      const job = buildJob(existing);
      const idx = _fileRecruit.jobs.findIndex(j => j.id === jobId);
      if (idx >= 0) _fileRecruit.jobs[idx] = job; else _fileRecruit.jobs.push(job);
      _saveFileRecruit();
      return res.json({ ok: true, job });
    }
    const { rows } = await pool.query("SELECT data FROM recruit_jobs WHERE id = $1", [jobId]);
    const existing = rows[0] ? rows[0].data : null;
    const job = buildJob(existing);
    await pool.query(
      "INSERT INTO recruit_jobs (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()",
      [jobId, job]
    );
    res.json({ ok: true, job });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/jobs/:id/close", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const id = req.params.id;
    if (USE_JSON_FILE) {
      const job = _fileRecruit.jobs.find(j => j.id === id);
      if (!job) return res.status(404).json({ ok: false, message: "채용공고를 찾을 수 없습니다." });
      job.status = "closed";
      job.updatedAt = new Date().toISOString();
      _saveFileRecruit();
      return res.json({ ok: true, job });
    }
    const { rows } = await pool.query("SELECT data FROM recruit_jobs WHERE id = $1", [id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "채용공고를 찾을 수 없습니다." });
    const job = { ...rows[0].data, status: "closed", updatedAt: new Date().toISOString() };
    await pool.query("UPDATE recruit_jobs SET data = $2, updated_at = NOW() WHERE id = $1", [id, job]);
    res.json({ ok: true, job });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

async function _recruitJobById(jobId) {
  if (USE_JSON_FILE) return _fileRecruit.jobs.find(j => j.id === jobId) || null;
  const { rows } = await pool.query("SELECT data FROM recruit_jobs WHERE id = $1 AND is_deleted = FALSE", [jobId]);
  return rows[0] ? rows[0].data : null;
}

// ── 채용 관리: 지원자(이력서/평가) ──────────────────────────────────────────────
async function _recruitAllCandidates() {
  if (USE_JSON_FILE) return _fileRecruit.candidates;
  const { rows } = await pool.query("SELECT data FROM recruit_candidates WHERE is_deleted = FALSE ORDER BY created_at DESC");
  return rows.map(r => r.data);
}
function _recruitStripResume(c) { return { ...c, resume: c.resume ? { fileName: c.resume.fileName, type: c.resume.type } : null }; }
async function _recruitVisibleCandidates(userId, role) {
  const all = await _recruitAllCandidates();
  if (!userId || !role || role === "admin") return all;
  const interviews = await _recruitAllInterviews();
  const interviewerCandidateIds = new Set(
    interviews.filter(iv => (iv.interviewerIds || []).map(String).includes(String(userId))).map(iv => String(iv.candidateId))
  );
  const visible = [];
  for (const c of all) {
    if (interviewerCandidateIds.has(String(c.id))) { visible.push(c); continue; }
    const job = await _recruitJobById(c.jobId);
    if (job && await _recruitCanViewJob(job, userId, role)) visible.push(c);
  }
  return visible;
}
app.get("/api/recruit/candidates", async (req, res) => {
  try {
    const { status, jobId, q, userId, role } = req.query;
    let list = await _recruitVisibleCandidates(userId, role);
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
  try {
    const { jobId, userId, role } = req.query;
    let list = await _recruitVisibleCandidates(userId, role);
    if (jobId) list = list.filter(c => String(c.jobId) === String(jobId));
    const jobTitleOf = async (id) => { const j = await _recruitJobById(id); return j ? j.title : ""; };
    const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const header = ["채용공고", "지원자명", "연락처", "이메일", "전형단계", "지원일", "최종학력", "경력사항", "마지막연봉", "희망연봉", "학력·경력 공백", "교육/대외활동", "이력서 요약", "메모"];
    const lines = [header.map(esc).join(",")];
    for (const c of list) {
      lines.push([await jobTitleOf(c.jobId), c.name, c.phone || "", c.email || "", c.status, (c.appliedAt || "").slice(0, 10), c.finalEducation || "", c.careerHistory || "", c.lastSalary || "", c.desiredSalary || "", c.careerGaps || "", c.activities || "", c.resumeSummary || "", c.memo || ""].map(esc).join(","));
    }
    res.json({ ok: true, csv: "﻿" + lines.join("\n") });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.get("/api/recruit/candidates/:id", async (req, res) => {
  try {
    const id = req.params.id;
    let candidate;
    if (USE_JSON_FILE) {
      candidate = _fileRecruit.candidates.find(c => c.id === id);
    } else {
      const { rows } = await pool.query("SELECT data FROM recruit_candidates WHERE id = $1 AND is_deleted = FALSE", [id]);
      candidate = rows[0] ? rows[0].data : null;
    }
    if (!candidate) return res.status(404).json({ ok: false, message: "지원자를 찾을 수 없습니다." });
    const job = await _recruitJobById(candidate.jobId);
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
    await execFileP("pdftoppm", ["-png", "-r", "200", "-l", "8", pdfPath, pagePrefix]);
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
  // 회사명은 경력사항이 이어지는 2페이지 이후에도 나오므로 앞쪽 여러 페이지를 처리한다.
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
      // 텍스트 추출로는 절대 나오지 않는다. 이때 앞 4페이지를 OCR해 보강 섹션으로 첨부한다.
      // (프론트엔드 파서는 이 섹션에서 연락처를 찾고, 회사명이 빈 경력 항목을 채운다)
      const hasPhone = /01[0-9][-.\s]{0,2}\d{3,4}[-.\s]{0,2}\d{4}/.test(text);
      const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text);
      if (!hasPhone || !hasEmail) {
        try {
          const ocrText = await _ocrPdfPages(buffer, 4);
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
  "careerHistory": "경력사항. 이력서에 나온 회사마다 한 줄씩, 반드시 다음 형식으로: 'N. 재직기간 | 회사명 | 직급 | 주요업무'. 재직기간은 'YYYY.MM~YYYY.MM' 또는 'YYYY.MM~현재' 형식. 직급이 없으면 빈칸으로 두되 구분자 |는 유지. 주요업무가 없으면 '업무내용 미기재'. 학력/병역/자격증/어학 등 경력과 무관한 내용은 절대 포함하지 말 것. 회사가 여러 개면 줄바꿈으로 구분하고, 재직기간이 가장 최근(현재 재직중 또는 종료일이 늦은 순)인 회사부터 먼저 나열하고 오래된 회사를 마지막에 나열할 것(최근순)",
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

app.post("/api/recruit/candidates", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const { jobId, name, email, phone, resume, memo, resumeSummary, strengths, weaknesses, finalEducation, careerHistory, lastSalary, desiredSalary, activities, careerGaps, user: createdBy } = req.body || {};
    if (!jobId || !name) return res.status(400).json({ ok: false, message: "채용공고, 지원자명은 필수입니다." });
    const job = await _recruitJobById(jobId);
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
      "INSERT INTO recruit_candidates (id, job_id, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data = $3, updated_at = NOW()",
      [candidateId, jobId, candidate]
    );
    res.json({ ok: true, candidate: _recruitStripResume(candidate) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/candidates/:id", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const id = req.params.id;
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
      applyEdits(candidate);
      _saveFileRecruit();
      return res.json({ ok: true, candidate: _recruitStripResume(candidate) });
    }
    const { rows } = await pool.query("SELECT data FROM recruit_candidates WHERE id = $1 AND is_deleted = FALSE", [id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "지원자를 찾을 수 없습니다." });
    const candidate = applyEdits(rows[0].data);
    await pool.query("UPDATE recruit_candidates SET data = $2, updated_at = NOW() WHERE id = $1", [id, candidate]);
    res.json({ ok: true, candidate: _recruitStripResume(candidate) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.get("/api/recruit/candidates/:id/resume", async (req, res) => {
  try {
    const id = req.params.id;
    let candidate;
    if (USE_JSON_FILE) {
      candidate = _fileRecruit.candidates.find(c => c.id === id);
    } else {
      const { rows } = await pool.query("SELECT data FROM recruit_candidates WHERE id = $1 AND is_deleted = FALSE", [id]);
      candidate = rows[0] ? rows[0].data : null;
    }
    if (!candidate || !candidate.resume) return res.status(404).json({ ok: false, message: "이력서를 찾을 수 없습니다." });
    res.json({ ok: true, resume: candidate.resume });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/candidates/:id/status", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const id = req.params.id;
    const { status, reason } = req.body || {};
    if (!status) return res.status(400).json({ ok: false, message: "변경할 전형 단계는 필수입니다." });
    const RECRUIT_PASS_SCORE = 15;
    const checkReasonRequired = async (candidate, job) => {
      const stages = job.stages || [];
      const curIdx = stages.indexOf(candidate.status);
      const newIdx = stages.indexOf(status);
      if (newIdx <= curIdx) return false;
      const interviews = await _recruitAllInterviews();
      const evals = interviews.filter(iv => String(iv.candidateId) === String(candidate.id) && iv.status !== "canceled").flatMap(iv => iv.evaluations || []);
      if (!evals.length) return false;
      const avg = evals.reduce((s, e) => s + (e.totalScore || 0), 0) / evals.length;
      return avg < RECRUIT_PASS_SCORE;
    };
    if (USE_JSON_FILE) {
      const candidate = _fileRecruit.candidates.find(c => c.id === id);
      if (!candidate) return res.status(404).json({ ok: false, message: "지원자를 찾을 수 없습니다." });
      const job = await _recruitJobById(candidate.jobId);
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
    const { rows } = await pool.query("SELECT data FROM recruit_candidates WHERE id = $1 AND is_deleted = FALSE", [id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "지원자를 찾을 수 없습니다." });
    const candidate = rows[0].data;
    const job = await _recruitJobById(candidate.jobId);
    if (!job || !job.stages.includes(status)) return res.status(400).json({ ok: false, message: "해당 채용공고에 없는 전형 단계입니다." });
    if (await checkReasonRequired(candidate, job) && !String(reason || "").trim()) {
      return res.status(400).json({ ok: false, message: "통과 기준 미만 점수로 다음 단계 진행 시 사유를 입력해야 합니다." });
    }
    candidate.status = status;
    candidate.statusReason = reason || "";
    candidate.updatedAt = new Date().toISOString();
    await pool.query("UPDATE recruit_candidates SET data = $2, updated_at = NOW() WHERE id = $1", [id, candidate]);
    res.json({ ok: true, candidate });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── 채용 관리: 면접 일정/평가 (1차·2차 구분, 면접관별 비공개 평가) ────────────────
const RECRUIT_SCORE_CATEGORIES = ["태도", "전문지식", "적극성", "의사소통능력", "조직적합성"];
// 면접 열람 권한: 관리자, 인사팀장, 면접 대상 채용공고를 볼 수 있는 등록자/담당자, 또는 본인이 면접관으로 지정된 경우
async function _recruitIsInterviewPrivileged(interview, userId, role) {
  if (role === "admin") return true;
  const job = await _recruitJobById(interview.jobId);
  if (job && await _recruitCanViewJob(job, userId, role)) return true;
  return false;
}
function _recruitFilterInterviewForViewer(interview, userId, privileged) {
  if (privileged) return interview;
  return { ...interview, evaluations: (interview.evaluations || []).filter(e => String(e.interviewerId) === String(userId)) };
}
async function _recruitAllInterviews() {
  if (USE_JSON_FILE) return _fileRecruit.interviews;
  const { rows } = await pool.query("SELECT data FROM recruit_interviews WHERE is_deleted = FALSE ORDER BY created_at DESC");
  return rows.map(r => r.data);
}
async function _recruitInterviewById(interviewId) {
  if (USE_JSON_FILE) return _fileRecruit.interviews.find(i => i.id === interviewId) || null;
  const { rows } = await pool.query("SELECT data FROM recruit_interviews WHERE id = $1 AND is_deleted = FALSE", [interviewId]);
  return rows[0] ? rows[0].data : null;
}
app.get("/api/recruit/interviews", async (req, res) => {
  try {
    const { jobId, candidateId, userId, role } = req.query;
    let list = await _recruitAllInterviews();
    if (jobId) list = list.filter(i => String(i.jobId) === String(jobId));
    if (candidateId) list = list.filter(i => String(i.candidateId) === String(candidateId));
    const out = [];
    for (const interview of list) {
      const privileged = await _recruitIsInterviewPrivileged(interview, userId, role);
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
    const { jobId, candidateId, round, schedule, interviewerIds, location } = req.body || {};
    if (!jobId || !candidateId || !round || !Array.isArray(interviewerIds) || !interviewerIds.length) {
      return res.status(400).json({ ok: false, message: "채용공고, 지원자, 면접 회차, 면접관은 필수입니다." });
    }
    const job = await _recruitJobById(jobId);
    if (!job) return res.status(404).json({ ok: false, message: "채용공고를 찾을 수 없습니다." });
    const id = `iv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const interview = {
      id, jobId, candidateId, round: Number(round), schedule: schedule || "", location: location || "",
      status: "scheduled", interviewerIds: interviewerIds.map(String), evaluations: [], createdAt: now, updatedAt: now,
    };
    if (USE_JSON_FILE) {
      _fileRecruit.interviews.push(interview);
      _saveFileRecruit();
      return res.json({ ok: true, interview });
    }
    await pool.query(
      "INSERT INTO recruit_interviews (id, job_id, candidate_id, data) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET data = $4, updated_at = NOW()",
      [id, jobId, candidateId, interview]
    );
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/interviews/:id", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const id = req.params.id;
    const { round, schedule, interviewerIds, location } = req.body || {};
    const interview = await _recruitInterviewById(id);
    if (!interview) return res.status(404).json({ ok: false, message: "면접 일정을 찾을 수 없습니다." });
    if (round != null) interview.round = Number(round);
    if (schedule != null) interview.schedule = schedule;
    if (location != null) interview.location = location;
    if (Array.isArray(interviewerIds) && interviewerIds.length) interview.interviewerIds = interviewerIds.map(String);
    interview.updatedAt = new Date().toISOString();
    if (USE_JSON_FILE) {
      _saveFileRecruit();
      return res.json({ ok: true, interview });
    }
    await pool.query("UPDATE recruit_interviews SET data = $2, updated_at = NOW() WHERE id = $1", [id, interview]);
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/interviews/:id/cancel", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const id = req.params.id;
    const { reason } = req.body || {};
    const interview = await _recruitInterviewById(id);
    if (!interview) return res.status(404).json({ ok: false, message: "면접 일정을 찾을 수 없습니다." });
    interview.status = "canceled";
    interview.cancelReason = reason || "";
    interview.canceledAt = new Date().toISOString();
    interview.updatedAt = interview.canceledAt;
    if (USE_JSON_FILE) {
      _saveFileRecruit();
      return res.json({ ok: true, interview });
    }
    await pool.query("UPDATE recruit_interviews SET data = $2, updated_at = NOW() WHERE id = $1", [id, interview]);
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/interviews/:id/evaluation", async (req, res) => {
  try {
    const id = req.params.id;
    const { interviewerId, scores, comment, role } = req.body || {};
    if (!interviewerId || !scores || typeof scores !== "object") {
      return res.status(400).json({ ok: false, message: "면접관, 평가 점수는 필수입니다." });
    }
    const interview = await _recruitInterviewById(id);
    if (!interview) return res.status(404).json({ ok: false, message: "면접 일정을 찾을 수 없습니다." });
    if (role !== "admin" && !interview.interviewerIds.map(String).includes(String(interviewerId))) {
      return res.status(403).json({ ok: false, message: "지정된 면접관만 평가를 입력할 수 있습니다." });
    }
    const candidate = USE_JSON_FILE
      ? _fileRecruit.candidates.find(c => c.id === interview.candidateId)
      : (await pool.query("SELECT data FROM recruit_candidates WHERE id = $1 AND is_deleted = FALSE", [interview.candidateId])).rows[0]?.data;
    const job = candidate ? await _recruitJobById(candidate.jobId) : null;
    if (candidate && job) {
      const stages = (job.stages && job.stages.length) ? job.stages : [];
      const statusIdx = stages.indexOf(candidate.status);
      const roundStageIdx = Math.min(interview.round, stages.length - 1);
      if (statusIdx >= 0 && statusIdx > roundStageIdx) {
        return res.status(400).json({ ok: false, message: "전형 단계가 진행되어 평가를 수정할 수 없습니다." });
      }
    }
    const totalScore = RECRUIT_SCORE_CATEGORIES.reduce((s, k) => s + (Number(scores[k]) || 0), 0);
    const evaluation = { interviewerId: String(interviewerId), scores, totalScore, comment: comment || "", updatedAt: new Date().toISOString() };
    const idx = (interview.evaluations || []).findIndex(e => String(e.interviewerId) === String(interviewerId));
    if (idx >= 0) interview.evaluations[idx] = evaluation; else (interview.evaluations || (interview.evaluations = [])).push(evaluation);
    interview.updatedAt = new Date().toISOString();
    if (USE_JSON_FILE) {
      _saveFileRecruit();
      return res.json({ ok: true, interview });
    }
    await pool.query("UPDATE recruit_interviews SET data = $2, updated_at = NOW() WHERE id = $1", [id, interview]);
    res.json({ ok: true, interview });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/recruit/candidates/:id/delete", async (req, res) => {
  try {
    if (!requireRole(req, res, ["admin", "leader", "director"])) return;
    const id = req.params.id;
    if (USE_JSON_FILE) {
      const candidate = _fileRecruit.candidates.find(c => c.id === id);
      if (!candidate) return res.status(404).json({ ok: false, message: "지원자를 찾을 수 없습니다." });
      _fileRecruit.candidates = _fileRecruit.candidates.filter(c => c.id !== id);
      _saveFileRecruit();
      return res.json({ ok: true });
    }
    const { rows } = await pool.query("SELECT data FROM recruit_candidates WHERE id = $1 AND is_deleted = FALSE", [id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: "지원자를 찾을 수 없습니다." });
    await pool.query("UPDATE recruit_candidates SET is_deleted = TRUE WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.get("/api/recruit/dashboard", async (req, res) => {
  try {
    let jobs, candidates, interviews;
    if (USE_JSON_FILE) {
      jobs = _fileRecruit.jobs;
      candidates = _fileRecruit.candidates;
      interviews = _fileRecruit.interviews;
    } else {
      const jobRows = await pool.query("SELECT data FROM recruit_jobs WHERE is_deleted = FALSE ORDER BY created_at DESC");
      jobs = jobRows.rows.map(r => r.data);
      const candRows = await pool.query("SELECT data FROM recruit_candidates WHERE is_deleted = FALSE");
      candidates = candRows.rows.map(r => r.data);
      const intRows = await pool.query("SELECT data FROM recruit_interviews WHERE is_deleted = FALSE");
      interviews = intRows.rows.map(r => r.data);
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
app.post("/api/reset-all", async (req, res) => {
  try {
    const { loginId, pw } = req.body || {};
    const admin = await verifyCredentials(loginId, pw);
    if (!admin || admin.role !== "admin")
      return res.status(403).json({ ok: false, message: "관리자 인증이 필요합니다." });
    if (USE_JSON_FILE) {
      _fileStore = { employees: [], kpiEntries: [] };
      _fileSnapshots = {};
      _fileHistory = { employees: [], kpi: [] };
      _dataVersion = 0;
      await persistData(_fileStore);
      const snapFile = JSON_FILE.replace(/\.json$/, "-snapshots.json");
      await fs.promises.writeFile(snapFile, JSON.stringify({}, null, 2), "utf8");
      const histFile = JSON_FILE.replace(/\.json$/, "-history.json");
      await fs.promises.writeFile(histFile, JSON.stringify({ employees: [], kpi: [] }, null, 2), "utf8");
    } else {
      await pool.query("DELETE FROM kpi_history");
      await pool.query("DELETE FROM employee_history");
      await pool.query("DELETE FROM kpi_entries");
      await pool.query("DELETE FROM employees");
      await pool.query("DELETE FROM annual_snapshots");
      await pool.query("UPDATE app_meta SET value='0' WHERE key='data_version'");
      _dataVersion = 0;
    }
    console.log("[Reset] All data cleared");
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
      console.log(`║  데이터 버전: ${String(_dataVersion).padEnd(31)}║`);
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
