-- ── App metadata ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO app_meta (key, value) VALUES ('data_version', '0') ON CONFLICT DO NOTHING;

-- ── 회사(테넌트) ──────────────────────────────────────────────────────────────
-- 멀티테넌트 SaaS 전환(2026-07-20 계획, CLAUDE.md 참고)의 기반. gen_random_uuid()는
-- pgcrypto 확장이 있어야 하는 Postgres 버전이 있어 명시적으로 활성화해둔다.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS companies (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT        UNIQUE NOT NULL,
  name       TEXT        NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Employees ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- company_id는 기존 단일 회사 데이터와의 호환을 위해 우선 nullable로 추가한다 — 마이그레이션
-- 스크립트(scripts/migrate-add-company-id.js)가 기존 행을 전부 백필한 뒤에야 애플리케이션
-- 차원에서 NOT NULL을 전제로 동작하게 된다(스키마 레벨 NOT NULL 제약은 백필 확인 후 별도로 건다).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_employees_company_id ON employees (company_id);
-- ADD CONSTRAINT는 "IF NOT EXISTS" 구문이 없다. EXCEPTION WHEN duplicate_object로 잡는 방식은
-- 제약이 실제로는 이미 존재하는데도 그 밑에 깔린 인덱스 쪽에서 duplicate_table로 먼저 걸려
-- 잡히지 않는 경우가 있어(실측 확인 — 매 부팅마다 idempotent하게 재적용되는 이 스키마 파일의
-- 특성상 반드시 안전해야 함), pg_constraint 카탈로그를 직접 확인하는 방식으로 통일한다.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_company_id_fkey') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
-- loginId는 employees.data JSONB 안에 있어(전용 컬럼 아님) 생성 컬럼으로 뽑아내 회사 단위
-- 유일성 제약을 건다. 과거엔 warnDuplicateLoginIds()로 경고만 하고 실제 DB 제약이 없었다.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS login_id TEXT GENERATED ALWAYS AS (data->>'loginId') STORED;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_company_login_id_uniq') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_company_login_id_uniq UNIQUE (company_id, login_id);
  END IF;
END $$;

-- 변경 이력: 삽입·수정·삭제 모두 기록 (덮어쓰기 없음)
CREATE TABLE IF NOT EXISTS employee_history (
  history_id  BIGSERIAL   PRIMARY KEY,
  employee_id TEXT        NOT NULL,
  action      TEXT        NOT NULL CHECK (action IN ('insert','update','delete')),
  changed_by  TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data        JSONB       NOT NULL
);
ALTER TABLE employee_history ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_emp_hist_employee_id ON employee_history (employee_id);
CREATE INDEX IF NOT EXISTS idx_emp_hist_changed_at  ON employee_history (changed_at);
CREATE INDEX IF NOT EXISTS idx_emp_hist_company_id  ON employee_history (company_id);

-- ── KPI entries ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kpi_entries (
  id          TEXT        PRIMARY KEY,
  employee_id TEXT,
  eval_year   INTEGER,
  data        JSONB       NOT NULL,
  is_deleted  BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_at  TIMESTAMPTZ,
  deleted_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE kpi_entries ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_kpi_employee_id ON kpi_entries (employee_id);
CREATE INDEX IF NOT EXISTS idx_kpi_eval_year   ON kpi_entries (eval_year);
CREATE INDEX IF NOT EXISTS idx_kpi_company_id  ON kpi_entries (company_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kpi_entries_company_id_fkey') THEN
    ALTER TABLE kpi_entries ADD CONSTRAINT kpi_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS kpi_history (
  history_id BIGSERIAL   PRIMARY KEY,
  kpi_id     TEXT        NOT NULL,
  action     TEXT        NOT NULL CHECK (action IN ('insert','update','delete')),
  changed_by TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data       JSONB       NOT NULL
);
ALTER TABLE kpi_history ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_kpi_hist_kpi_id     ON kpi_history (kpi_id);
CREATE INDEX IF NOT EXISTS idx_kpi_hist_changed_at ON kpi_history (changed_at);
CREATE INDEX IF NOT EXISTS idx_kpi_hist_company_id ON kpi_history (company_id);

-- ── Accounting: 계정과목 (chart of accounts) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Accounting: 거래처 (business partners — customer/vendor master data) ─────
CREATE TABLE IF NOT EXISTS partners (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Accounting: 전표 (journal vouchers) — server-assigned number, immutable once posted ──
CREATE TABLE IF NOT EXISTS vouchers (
  id           TEXT        PRIMARY KEY,
  voucher_no   TEXT        UNIQUE NOT NULL,
  voucher_date DATE        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','void')),
  data         JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vouchers_date ON vouchers (voucher_date);

CREATE TABLE IF NOT EXISTS voucher_seq (
  year INTEGER PRIMARY KEY,
  seq  INTEGER NOT NULL DEFAULT 0
);

-- ── Accounting: 세금계산서 (사내 발행용) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS tax_invoices (
  id         TEXT        PRIMARY KEY,
  invoice_no TEXT        UNIQUE NOT NULL,
  issue_date DATE        NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tax_invoices_date ON tax_invoices (issue_date);

CREATE TABLE IF NOT EXISTS tax_invoice_seq (
  year INTEGER PRIMARY KEY,
  seq  INTEGER NOT NULL DEFAULT 0
);

-- ── ERP: 품목 마스터 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp_items (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── ERP: 창고/위치 마스터 ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp_locations (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── ERP: 견적서 (quotations) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp_quotations (
  id         TEXT        PRIMARY KEY,
  doc_date   DATE        NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','shipped')),
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_erp_quotations_date ON erp_quotations (doc_date);
CREATE TABLE IF NOT EXISTS erp_quote_seq ( year INTEGER PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0 );

-- ── ERP: 발주서 (purchase orders) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp_purchase_orders (
  id         TEXT        PRIMARY KEY,
  doc_date   DATE        NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','received','cancelled')),
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_erp_po_date ON erp_purchase_orders (doc_date);
CREATE TABLE IF NOT EXISTS erp_po_seq ( year INTEGER PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0 );

-- ── ERP: 구매요청 (purchase requests — 구성원 요청 → admin 승인/반려/발주 전환) ──
CREATE TABLE IF NOT EXISTS erp_purchase_requests (
  id         TEXT        PRIMARY KEY,
  doc_date   DATE        NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','converted')),
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_erp_pr_date ON erp_purchase_requests (doc_date);

-- ── ERP: 재고 입출고 이력 (stock ledger) — append-only, 현재 재고는 합산으로 계산 ──
CREATE TABLE IF NOT EXISTS erp_stock_ledger (
  id          TEXT        PRIMARY KEY,
  item_id     TEXT        NOT NULL,
  location_id TEXT        NOT NULL,
  data        JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_erp_stock_item_loc ON erp_stock_ledger (item_id, location_id);

-- ── ERP: 영업 목표 (월/연 단위 매출·수주 목표, 전체 또는 담당자별) ────────────
CREATE TABLE IF NOT EXISTS erp_sales_targets (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── PMS: 프로젝트 마스터 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pms_projects (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── PMS: 직원별 월간 투입률(%) 배정 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pms_allocations (
  id          TEXT        PRIMARY KEY,
  employee_id INTEGER     NOT NULL,
  year        INTEGER     NOT NULL,
  month       INTEGER     NOT NULL,
  data        JSONB       NOT NULL,
  is_deleted  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pms_alloc_emp_period ON pms_allocations (employee_id, year, month);

-- ── PMS: 일일 업무 투입(분단위 타임라인) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS pms_worklogs (
  id          TEXT        PRIMARY KEY,
  employee_id INTEGER     NOT NULL,
  work_date   DATE        NOT NULL,
  data        JSONB       NOT NULL,
  is_deleted  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pms_worklogs_emp_date ON pms_worklogs (employee_id, work_date);

-- ── 채용: 채용공고 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recruit_jobs (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 채용: 지원자(이력서/평가 포함) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recruit_candidates (
  id         TEXT        PRIMARY KEY,
  job_id     TEXT        NOT NULL,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recruit_candidates_job ON recruit_candidates (job_id);

-- ── 채용: 면접 일정 및 평가 ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recruit_interviews (
  id           TEXT        PRIMARY KEY,
  job_id       TEXT        NOT NULL,
  candidate_id TEXT        NOT NULL,
  data         JSONB       NOT NULL,
  is_deleted   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recruit_interviews_candidate ON recruit_interviews (candidate_id);
CREATE INDEX IF NOT EXISTS idx_recruit_interviews_job       ON recruit_interviews (job_id);

-- ── Generic HR/ERP collections (attendance, payslips, approvals, certs, etc.) ──
-- One row per record of every id-keyed list the client sends via getFullState()
-- that doesn't have its own dedicated table. `collection` is the field name
-- (e.g. 'attendanceRecords', 'payslips'); `id` is the record's own `id`.
CREATE TABLE IF NOT EXISTS app_collections (
  collection TEXT        NOT NULL,
  id         TEXT        NOT NULL,
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_app_collections_collection ON app_collections (collection);

-- ── Generic singleton config blobs (settings, orgDB, gradeSettings, etc.) ──────
-- One row per top-level config field that isn't a list of records.
CREATE TABLE IF NOT EXISTS app_singletons (
  key        TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Annual confirmed snapshots ────────────────────────────────────────────────
-- 매년 최종 확정 시 전체 데이터를 스냅샷으로 보관 (절대 삭제 불가)
CREATE TABLE IF NOT EXISTS annual_snapshots (
  id             SERIAL      PRIMARY KEY,
  eval_year      INTEGER     UNIQUE NOT NULL,
  snapshot_data  JSONB       NOT NULL,
  emp_count      INTEGER     NOT NULL DEFAULT 0,
  kpi_count      INTEGER     NOT NULL DEFAULT 0,
  confirmed_by   TEXT,
  confirmed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes          TEXT
);
