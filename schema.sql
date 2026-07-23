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

-- ── 마스터 관리자(플랫폼 운영자) ──────────────────────────────────────────────
-- 계획 문서("마스터 관리자 + 회사별 기능 커스터마이징") 1단계 후속 — 회사 관리자
-- (employees.role='admin')와는 완전히 별개의 인증 영역이다. 마스터는 특정 회사
-- 소속 직원이 아니라 플랫폼 운영자이므로, HR 특화 필드로 가득한 employees.data
-- (JSONB)에 억지로 끼워넣지 않고 독립 테이블 + 독립 로그인(POST /master/login)을
-- 둔다. 셀프서브 가입 엔드포인트는 없다 — 마스터 계정은 항상 out-of-band로
-- (SQL로 직접, scripts/seed-master-admin.js 참고) 발급한다.
CREATE TABLE IF NOT EXISTS platform_admins (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id   TEXT        UNIQUE NOT NULL,
  pw_hash    TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 마스터는 impersonation으로 전 회사 데이터에 접근 가능해지므로, 그 권한을 내주는
-- 순간(토큰 발급)과 그 권한으로 이뤄지는 모든 동작(기능 토글 등)의 감사 로그는
-- 계획 문서상 선택이 아니라 필수다.
CREATE TABLE IF NOT EXISTS master_audit_log (
  id         BIGSERIAL   PRIMARY KEY,
  master_id  UUID        REFERENCES platform_admins(id),
  action     TEXT        NOT NULL,
  company_id UUID        REFERENCES companies(id),
  detail     JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_master_audit_log_master_id  ON master_audit_log (master_id);
CREATE INDEX IF NOT EXISTS idx_master_audit_log_company_id ON master_audit_log (company_id);
CREATE INDEX IF NOT EXISTS idx_master_audit_log_created_at ON master_audit_log (created_at);

-- ── 회사별 기능 on/off ────────────────────────────────────────────────────────
-- 내장 모듈(채용/회계/PMS 등)은 feature_key를 부여하고 기본값 enabled=true로 취급
-- (행이 아예 없으면 isFeatureEnabled()가 true를 반환 — 기존 동작 그대로 유지,
-- 하위호환). 특정 회사 전용 신규 기능은 기본 enabled=false로 행을 만들어 등록해
-- 그 회사에서만 켠다. 이번 세션은 데이터 모델 + 마스터 콘솔 토글 API +
-- isFeatureEnabled() 조회 헬퍼까지만 구현하고, 기존 라우트에 실제로 이 체크를
-- 소급 적용하는 것은 범위 밖이다(server.js의 isFeatureEnabled() 주석과 이 작업의
-- 커밋 메시지 참고).
CREATE TABLE IF NOT EXISTS company_features (
  company_id  UUID        NOT NULL REFERENCES companies(id),
  feature_key TEXT        NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  config      JSONB       NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, feature_key)
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
-- app_collections/app_singletons의 복합 PK 전환과 동일한 이유·동일한 패턴 — 백필(scripts/
-- migrate-add-company-id.js)이 끝나 company_id IS NULL인 행이 0건일 때만 NOT NULL로 승격한다.
-- 이 제약이 없으면 company_id IS NULL인 행이 (company_id = $N OR $N IS NULL) 형태의 레거시
-- 호환 폴백을 쓰는 조회 곳곳(server.js)에서 모든 회사에 조용히 노출될 수 있다. 과거엔 이
-- 제약을 운영 DB에 수동 SQL로만 걸어 schema.sql과 실제 운영 스키마가 어긋난 적이 있었다
-- (2026-07-22 디스크 장애 대응 기록 참고) — 재해복구/신규설치 경로에서도 항상 자동으로
-- 걸리도록 여기 코드화한다.
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'employees' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM employees WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE employees ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'employees: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
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
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_history_company_id_fkey') THEN
    ALTER TABLE employee_history ADD CONSTRAINT employee_history_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
-- employees의 NOT NULL 승격과 동일한 이유·동일한 패턴(위 주석 참고).
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'employee_history' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM employee_history WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE employee_history ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'employee_history: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;

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
-- employees의 NOT NULL 승격과 동일한 이유·동일한 패턴(위 주석 참고).
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'kpi_entries' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM kpi_entries WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE kpi_entries ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'kpi_entries: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
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
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kpi_history_company_id_fkey') THEN
    ALTER TABLE kpi_history ADD CONSTRAINT kpi_history_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_kpi_hist_company_id ON kpi_history (company_id);
-- employees의 NOT NULL 승격과 동일한 이유·동일한 패턴(위 주석 참고).
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'kpi_history' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM kpi_history WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE kpi_history ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'kpi_history: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;

-- ── Accounting: 계정과목 (chart of accounts) ──────────────────────────────────
-- 멀티테넌트 4단계(회계/ERP/PMS/채용, 2026-07-23): accounts/partners/erp_items/erp_locations/
-- erp_sales_targets/pms_projects/pms_allocations/recruit_jobs 8개 테이블은 id를 클라이언트가
-- override 가능하다(server.js의 `const xId = id || \`prefix_${Date.now()}...\`` 패턴 — id가
-- 요청 body에 있으면 그대로 쓴다). company_id 없이는 서로 다른 회사가 같은 id를 보낼 경우
-- PK 충돌 위험이 있으므로, app_collections/app_singletons(2단계)와 동일하게 PRIMARY KEY를
-- (company_id, id) 복합키로 승격한다(아래 각 테이블 반복 패턴, 상세 주석은 app_collections
-- 섹션 참고). 나머지 회계/ERP/PMS/채용 테이블은 id가 항상 서버 생성(Date.now()+random)이라
-- 충돌 위험이 낮아 employees/kpi_entries(1단계)와 동일하게 company_id를 단순 필터 컬럼으로만
-- 추가한다.
CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_accounts_company_id ON accounts (company_id);
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM accounts WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_pkey') THEN
        ALTER TABLE accounts DROP CONSTRAINT accounts_pkey;
      END IF;
      ALTER TABLE accounts ADD CONSTRAINT accounts_pk_company PRIMARY KEY (company_id, id);
    ELSE
      RAISE NOTICE 'accounts: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_company_id_fkey') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── Accounting: 거래처 (business partners — customer/vendor master data) ─────
CREATE TABLE IF NOT EXISTS partners (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_partners_company_id ON partners (company_id);
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM partners WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_pkey') THEN
        ALTER TABLE partners DROP CONSTRAINT partners_pkey;
      END IF;
      ALTER TABLE partners ADD CONSTRAINT partners_pk_company PRIMARY KEY (company_id, id);
    ELSE
      RAISE NOTICE 'partners: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_company_id_fkey') THEN
    ALTER TABLE partners ADD CONSTRAINT partners_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── Accounting: 전표 (journal vouchers) — server-assigned number, immutable once posted ──
-- id는 항상 서버 생성(Date.now()+random)이라 충돌 위험이 낮음 — company_id는 단순 필터 컬럼.
-- voucher_no의 UNIQUE 제약은 전역 유일에서 회사 단위 유일(UNIQUE(company_id, voucher_no))로
-- 바꾼다 — 각 회사가 JE-{year}-000001부터 독립적으로 번호를 매길 수 있어야 하기 때문이다
-- (voucher_seq도 아래에서 (company_id, year) 복합 PK로 전환).
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
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_vouchers_company_id ON vouchers (company_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vouchers_company_id_fkey') THEN
    ALTER TABLE vouchers ADD CONSTRAINT vouchers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vouchers' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM vouchers WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE vouchers ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'vouchers: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vouchers_company_voucher_no_uniq') THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vouchers_voucher_no_key') THEN
      ALTER TABLE vouchers DROP CONSTRAINT vouchers_voucher_no_key;
    END IF;
    ALTER TABLE vouchers ADD CONSTRAINT vouchers_company_voucher_no_uniq UNIQUE (company_id, voucher_no);
  END IF;
END $$;

-- voucher_seq도 회사별로 분리한다 — PK를 (year)에서 (company_id, year)로 승격.
-- id/seq 값 자체엔 클라이언트 override가 없어(서버가 ON CONFLICT로만 증가) 복합 PK 전환에
-- NOT NULL 선행 조건이 accounts류와 동일하게 필요하다(PRIMARY KEY 컬럼은 자동 NOT NULL).
CREATE TABLE IF NOT EXISTS voucher_seq (
  year INTEGER PRIMARY KEY,
  seq  INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE voucher_seq ADD COLUMN IF NOT EXISTS company_id UUID;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voucher_seq_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM voucher_seq WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voucher_seq_pkey') THEN
        ALTER TABLE voucher_seq DROP CONSTRAINT voucher_seq_pkey;
      END IF;
      ALTER TABLE voucher_seq ADD CONSTRAINT voucher_seq_pk_company PRIMARY KEY (company_id, year);
    ELSE
      RAISE NOTICE 'voucher_seq: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voucher_seq_company_id_fkey') THEN
    ALTER TABLE voucher_seq ADD CONSTRAINT voucher_seq_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── Accounting: 세금계산서 (사내 발행용) ───────────────────────────────────────
-- vouchers와 동일한 패턴(위 주석 참고): company_id 단순 필터 컬럼 + invoice_no 유일성을
-- 회사 단위로 완화.
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
ALTER TABLE tax_invoices ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_tax_invoices_company_id ON tax_invoices (company_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_invoices_company_id_fkey') THEN
    ALTER TABLE tax_invoices ADD CONSTRAINT tax_invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tax_invoices' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM tax_invoices WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE tax_invoices ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'tax_invoices: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_invoices_company_invoice_no_uniq') THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_invoices_invoice_no_key') THEN
      ALTER TABLE tax_invoices DROP CONSTRAINT tax_invoices_invoice_no_key;
    END IF;
    ALTER TABLE tax_invoices ADD CONSTRAINT tax_invoices_company_invoice_no_uniq UNIQUE (company_id, invoice_no);
  END IF;
END $$;

-- tax_invoice_seq도 voucher_seq와 동일한 패턴으로 (company_id, year) 복합 PK로 전환.
CREATE TABLE IF NOT EXISTS tax_invoice_seq (
  year INTEGER PRIMARY KEY,
  seq  INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE tax_invoice_seq ADD COLUMN IF NOT EXISTS company_id UUID;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_invoice_seq_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM tax_invoice_seq WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_invoice_seq_pkey') THEN
        ALTER TABLE tax_invoice_seq DROP CONSTRAINT tax_invoice_seq_pkey;
      END IF;
      ALTER TABLE tax_invoice_seq ADD CONSTRAINT tax_invoice_seq_pk_company PRIMARY KEY (company_id, year);
    ELSE
      RAISE NOTICE 'tax_invoice_seq: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_invoice_seq_company_id_fkey') THEN
    ALTER TABLE tax_invoice_seq ADD CONSTRAINT tax_invoice_seq_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── ERP: 품목 마스터 ────────────────────────────────────────────────────────
-- id 클라이언트 override 가능 — accounts와 동일한 (company_id, id) 복합 PK 패턴.
CREATE TABLE IF NOT EXISTS erp_items (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE erp_items ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_erp_items_company_id ON erp_items (company_id);
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_items_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM erp_items WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_items_pkey') THEN
        ALTER TABLE erp_items DROP CONSTRAINT erp_items_pkey;
      END IF;
      ALTER TABLE erp_items ADD CONSTRAINT erp_items_pk_company PRIMARY KEY (company_id, id);
    ELSE
      RAISE NOTICE 'erp_items: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_items_company_id_fkey') THEN
    ALTER TABLE erp_items ADD CONSTRAINT erp_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── ERP: 창고/위치 마스터 ───────────────────────────────────────────────────
-- erp_items와 동일한 패턴.
CREATE TABLE IF NOT EXISTS erp_locations (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE erp_locations ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_erp_locations_company_id ON erp_locations (company_id);
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_locations_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM erp_locations WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_locations_pkey') THEN
        ALTER TABLE erp_locations DROP CONSTRAINT erp_locations_pkey;
      END IF;
      ALTER TABLE erp_locations ADD CONSTRAINT erp_locations_pk_company PRIMARY KEY (company_id, id);
    ELSE
      RAISE NOTICE 'erp_locations: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_locations_company_id_fkey') THEN
    ALTER TABLE erp_locations ADD CONSTRAINT erp_locations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── ERP: 견적서 (quotations) ────────────────────────────────────────────────
-- id는 항상 서버 생성 — vouchers와 동일하게 단순 필터 컬럼.
CREATE TABLE IF NOT EXISTS erp_quotations (
  id         TEXT        PRIMARY KEY,
  doc_date   DATE        NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','shipped')),
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_erp_quotations_date ON erp_quotations (doc_date);
ALTER TABLE erp_quotations ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_erp_quotations_company_id ON erp_quotations (company_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_quotations_company_id_fkey') THEN
    ALTER TABLE erp_quotations ADD CONSTRAINT erp_quotations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'erp_quotations' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM erp_quotations WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE erp_quotations ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'erp_quotations: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;

-- erp_quote_seq — voucher_seq와 동일한 패턴으로 (company_id, year) 복합 PK.
CREATE TABLE IF NOT EXISTS erp_quote_seq ( year INTEGER PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0 );
ALTER TABLE erp_quote_seq ADD COLUMN IF NOT EXISTS company_id UUID;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_quote_seq_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM erp_quote_seq WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_quote_seq_pkey') THEN
        ALTER TABLE erp_quote_seq DROP CONSTRAINT erp_quote_seq_pkey;
      END IF;
      ALTER TABLE erp_quote_seq ADD CONSTRAINT erp_quote_seq_pk_company PRIMARY KEY (company_id, year);
    ELSE
      RAISE NOTICE 'erp_quote_seq: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_quote_seq_company_id_fkey') THEN
    ALTER TABLE erp_quote_seq ADD CONSTRAINT erp_quote_seq_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── ERP: 발주서 (purchase orders) ───────────────────────────────────────────
-- erp_quotations와 동일한 패턴.
CREATE TABLE IF NOT EXISTS erp_purchase_orders (
  id         TEXT        PRIMARY KEY,
  doc_date   DATE        NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','received','cancelled')),
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_erp_po_date ON erp_purchase_orders (doc_date);
ALTER TABLE erp_purchase_orders ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_erp_po_company_id ON erp_purchase_orders (company_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_purchase_orders_company_id_fkey') THEN
    ALTER TABLE erp_purchase_orders ADD CONSTRAINT erp_purchase_orders_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'erp_purchase_orders' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM erp_purchase_orders WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE erp_purchase_orders ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'erp_purchase_orders: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;

-- erp_po_seq — voucher_seq와 동일한 패턴.
CREATE TABLE IF NOT EXISTS erp_po_seq ( year INTEGER PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0 );
ALTER TABLE erp_po_seq ADD COLUMN IF NOT EXISTS company_id UUID;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_po_seq_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM erp_po_seq WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_po_seq_pkey') THEN
        ALTER TABLE erp_po_seq DROP CONSTRAINT erp_po_seq_pkey;
      END IF;
      ALTER TABLE erp_po_seq ADD CONSTRAINT erp_po_seq_pk_company PRIMARY KEY (company_id, year);
    ELSE
      RAISE NOTICE 'erp_po_seq: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_po_seq_company_id_fkey') THEN
    ALTER TABLE erp_po_seq ADD CONSTRAINT erp_po_seq_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── ERP: 구매요청 (purchase requests — 구성원 요청 → admin 승인/반려/발주 전환) ──
-- id는 항상 서버 생성 — 단순 필터 컬럼.
CREATE TABLE IF NOT EXISTS erp_purchase_requests (
  id         TEXT        PRIMARY KEY,
  doc_date   DATE        NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','converted')),
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_erp_pr_date ON erp_purchase_requests (doc_date);
ALTER TABLE erp_purchase_requests ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_erp_pr_company_id ON erp_purchase_requests (company_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_purchase_requests_company_id_fkey') THEN
    ALTER TABLE erp_purchase_requests ADD CONSTRAINT erp_purchase_requests_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'erp_purchase_requests' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM erp_purchase_requests WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE erp_purchase_requests ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'erp_purchase_requests: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;

-- ── ERP: 재고 입출고 이력 (stock ledger) — append-only, 현재 재고는 합산으로 계산 ──
-- id는 항상 서버 생성 — 단순 필터 컬럼. 재고 잠금(pg_advisory_xact_lock)은 server.js에서
-- company_id를 잠금 키에 포함시켜 회사 간 잠금 간섭을 막는다(스키마 변경 아님).
CREATE TABLE IF NOT EXISTS erp_stock_ledger (
  id          TEXT        PRIMARY KEY,
  item_id     TEXT        NOT NULL,
  location_id TEXT        NOT NULL,
  data        JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_erp_stock_item_loc ON erp_stock_ledger (item_id, location_id);
ALTER TABLE erp_stock_ledger ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_erp_stock_company_id ON erp_stock_ledger (company_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_stock_ledger_company_id_fkey') THEN
    ALTER TABLE erp_stock_ledger ADD CONSTRAINT erp_stock_ledger_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'erp_stock_ledger' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM erp_stock_ledger WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE erp_stock_ledger ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'erp_stock_ledger: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;

-- ── ERP: 영업 목표 (월/연 단위 매출·수주 목표, 전체 또는 담당자별) ────────────
-- id 클라이언트 override 가능 — accounts와 동일한 (company_id, id) 복합 PK 패턴.
CREATE TABLE IF NOT EXISTS erp_sales_targets (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE erp_sales_targets ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_erp_sales_targets_company_id ON erp_sales_targets (company_id);
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_sales_targets_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM erp_sales_targets WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_sales_targets_pkey') THEN
        ALTER TABLE erp_sales_targets DROP CONSTRAINT erp_sales_targets_pkey;
      END IF;
      ALTER TABLE erp_sales_targets ADD CONSTRAINT erp_sales_targets_pk_company PRIMARY KEY (company_id, id);
    ELSE
      RAISE NOTICE 'erp_sales_targets: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_sales_targets_company_id_fkey') THEN
    ALTER TABLE erp_sales_targets ADD CONSTRAINT erp_sales_targets_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── PMS: 프로젝트 마스터 ────────────────────────────────────────────────────
-- id 클라이언트 override 가능 — accounts와 동일한 (company_id, id) 복합 PK 패턴.
CREATE TABLE IF NOT EXISTS pms_projects (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE pms_projects ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_pms_projects_company_id ON pms_projects (company_id);
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pms_projects_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM pms_projects WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pms_projects_pkey') THEN
        ALTER TABLE pms_projects DROP CONSTRAINT pms_projects_pkey;
      END IF;
      ALTER TABLE pms_projects ADD CONSTRAINT pms_projects_pk_company PRIMARY KEY (company_id, id);
    ELSE
      RAISE NOTICE 'pms_projects: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pms_projects_company_id_fkey') THEN
    ALTER TABLE pms_projects ADD CONSTRAINT pms_projects_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── PMS: 직원별 월간 투입률(%) 배정 ──────────────────────────────────────────
-- id 클라이언트 override 가능 — 동일한 (company_id, id) 복합 PK 패턴. 100% 캡 advisory
-- lock(employeeId+year+month 키)은 server.js에서 company_id를 접두로 추가한다(스키마 변경 아님).
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
ALTER TABLE pms_allocations ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_pms_allocations_company_id ON pms_allocations (company_id);
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pms_allocations_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM pms_allocations WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pms_allocations_pkey') THEN
        ALTER TABLE pms_allocations DROP CONSTRAINT pms_allocations_pkey;
      END IF;
      ALTER TABLE pms_allocations ADD CONSTRAINT pms_allocations_pk_company PRIMARY KEY (company_id, id);
    ELSE
      RAISE NOTICE 'pms_allocations: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pms_allocations_company_id_fkey') THEN
    ALTER TABLE pms_allocations ADD CONSTRAINT pms_allocations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── PMS: 일일 업무 투입(분단위 타임라인) ─────────────────────────────────────
-- id는 항상 서버 생성 — 단순 필터 컬럼.
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
ALTER TABLE pms_worklogs ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_pms_worklogs_company_id ON pms_worklogs (company_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pms_worklogs_company_id_fkey') THEN
    ALTER TABLE pms_worklogs ADD CONSTRAINT pms_worklogs_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pms_worklogs' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM pms_worklogs WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE pms_worklogs ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'pms_worklogs: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;

-- ── 채용: 채용공고 ────────────────────────────────────────────────────────────
-- id 클라이언트 override 가능 — accounts와 동일한 (company_id, id) 복합 PK 패턴. 부서 스코프
-- 검사(_recruitCanViewJob 등)는 server.js가 담당하며 company_id 스코프는 그 이전 단계로 추가된다.
CREATE TABLE IF NOT EXISTS recruit_jobs (
  id         TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE recruit_jobs ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_recruit_jobs_company_id ON recruit_jobs (company_id);
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recruit_jobs_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM recruit_jobs WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recruit_jobs_pkey') THEN
        ALTER TABLE recruit_jobs DROP CONSTRAINT recruit_jobs_pkey;
      END IF;
      ALTER TABLE recruit_jobs ADD CONSTRAINT recruit_jobs_pk_company PRIMARY KEY (company_id, id);
    ELSE
      RAISE NOTICE 'recruit_jobs: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recruit_jobs_company_id_fkey') THEN
    ALTER TABLE recruit_jobs ADD CONSTRAINT recruit_jobs_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── 채용: 지원자(이력서/평가 포함) ────────────────────────────────────────────
-- id는 항상 서버 생성 — 단순 필터 컬럼.
CREATE TABLE IF NOT EXISTS recruit_candidates (
  id         TEXT        PRIMARY KEY,
  job_id     TEXT        NOT NULL,
  data       JSONB       NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recruit_candidates_job ON recruit_candidates (job_id);
ALTER TABLE recruit_candidates ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_recruit_candidates_company_id ON recruit_candidates (company_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recruit_candidates_company_id_fkey') THEN
    ALTER TABLE recruit_candidates ADD CONSTRAINT recruit_candidates_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'recruit_candidates' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM recruit_candidates WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE recruit_candidates ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'recruit_candidates: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;

-- ── 채용: 면접 일정 및 평가 ───────────────────────────────────────────────────
-- id는 항상 서버 생성 — 단순 필터 컬럼.
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
ALTER TABLE recruit_interviews ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_recruit_interviews_company_id ON recruit_interviews (company_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recruit_interviews_company_id_fkey') THEN
    ALTER TABLE recruit_interviews ADD CONSTRAINT recruit_interviews_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'recruit_interviews' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM recruit_interviews WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE recruit_interviews ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'recruit_interviews: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;

-- ── Generic HR/ERP collections (attendance, payslips, approvals, certs, etc.) ──
-- One row per record of every id-keyed list the client sends via getFullState()
-- that doesn't have its own dedicated table. `collection` is the field name
-- (e.g. 'attendanceRecords', 'payslips'); `id` is the record's own `id`.
--
-- company_id/PK 설계(멀티테넌트 2단계, 2026-07-21 계획 문서 "마이그레이션 순서" 2단계):
-- 이 테이블의 `id`는 employees.id(_getNextEmployeeId()로 발급되는 진짜 전역 원자적 시퀀스)와
-- 완전히 다르다 — 클라이언트(public/index.html)가 `let _id=547; const genId=()=>++_id;`로
-- 브라우저 세션마다 로컬에서 547부터 증가시키는 평범한 카운터일 뿐이라, 서로 다른 두 회사가
-- 거의 항상 같은 id(예: 둘 다 "548")를 만들어낸다 — 실사용에서 일상적으로 벌어지는 충돌이다.
-- company_id를 단순 필터 컬럼으로만 추가하고 기존 PRIMARY KEY (collection, id)를 그대로
-- 두면, 두 번째 회사가 생기는 즉시 PK 위반으로 저장이 실패한다. employees/kpi_entries(1단계)는
-- id 자체가 전역 유일이라 company_id를 필터 컬럼으로만 추가해도 안전했지만, 이 테이블은
-- 그 가정이 성립하지 않으므로 company_id를 PRIMARY KEY의 일부로 승격한다:
-- PRIMARY KEY (company_id, collection, id) — 회사가 다르면 같은 (collection, id)라도 완전히
-- 별개의 행으로 공존한다.
--
-- 기존(마이그레이션 전) 배포는 company_id 컬럼 자체가 없거나 nullable로 채워지지 않은 행이
-- 남아있을 수 있다 — PRIMARY KEY 컬럼은 Postgres가 자동으로 NOT NULL을 강제하므로, 백필이
-- 끝나기 전(company_id가 NULL인 행이 남아있는 동안)에는 새 복합 PK로 전환할 수 없다. 아래
-- DO 블록은 NULL 잔여 행이 있으면 전환을 건너뛰고 기존 단일열 PK를 그대로 유지한다 —
-- scripts/migrate-add-company-id.js로 백필을 마친 뒤 재부팅하면 그 다음 스키마 적용에서
-- 안전하게 전환된다(운영 배포 순서: 백필 스크립트 먼저 실행 → 새 서버 코드 배포/재기동. 백필
-- 전에 새 server.js 코드가 먼저 뜨면, app_collections 쓰기의 `ON CONFLICT (company_id,
-- collection, id)`가 아직 마이그레이션 전인 옛 PK와 맞지 않아 오류가 나므로 반드시 이 순서를
-- 지켜야 한다).
CREATE TABLE IF NOT EXISTS app_collections (
  collection TEXT        NOT NULL,
  id         TEXT        NOT NULL,
  company_id UUID,
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_collections_pk_company PRIMARY KEY (company_id, collection, id)
);
-- 기존(company_id 컬럼 자체가 없던) 배포와의 호환을 위해 nullable로 추가 — 위 CREATE TABLE은
-- 테이블이 아예 없던 신규 설치에서만 실행되므로(IF NOT EXISTS), 기존 테이블에는 이 ALTER가
-- 실제로 컬럼을 채워 넣는다.
ALTER TABLE app_collections ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_app_collections_collection ON app_collections (collection);
CREATE INDEX IF NOT EXISTS idx_app_collections_company_id ON app_collections (company_id);
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_collections_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM app_collections WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_collections_pkey') THEN
        ALTER TABLE app_collections DROP CONSTRAINT app_collections_pkey;
      END IF;
      ALTER TABLE app_collections ADD CONSTRAINT app_collections_pk_company PRIMARY KEY (company_id, collection, id);
    ELSE
      RAISE NOTICE 'app_collections: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_collections_company_id_fkey') THEN
    ALTER TABLE app_collections ADD CONSTRAINT app_collections_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── Generic singleton config blobs (settings, orgDB, gradeSettings, etc.) ──────
-- One row per top-level config field that isn't a list of records. 동일한 이유로
-- PRIMARY KEY (company_id, key) 복합키로 승격 — 위 app_collections 주석 참고.
CREATE TABLE IF NOT EXISTS app_singletons (
  key        TEXT        NOT NULL,
  company_id UUID,
  data       JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_singletons_pk_company PRIMARY KEY (company_id, key)
);
ALTER TABLE app_singletons ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_app_singletons_company_id ON app_singletons (company_id);
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_singletons_pk_company') THEN
    SELECT COUNT(*) INTO remaining_null FROM app_singletons WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_singletons_pkey') THEN
        ALTER TABLE app_singletons DROP CONSTRAINT app_singletons_pkey;
      END IF;
      ALTER TABLE app_singletons ADD CONSTRAINT app_singletons_pk_company PRIMARY KEY (company_id, key);
    ELSE
      RAISE NOTICE 'app_singletons: company_id IS NULL 인 행이 %건 남아있어 복합 PK 전환을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_singletons_company_id_fkey') THEN
    ALTER TABLE app_singletons ADD CONSTRAINT app_singletons_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- ── Annual confirmed snapshots ────────────────────────────────────────────────
-- 매년 최종 확정 시 전체 데이터를 스냅샷으로 보관 (절대 삭제 불가)
-- id가 SERIAL이라 PK 충돌 위험은 없다(employees/kpi_entries와 동일 부류) — company_id는
-- 단순 필터 컬럼으로 추가하고, eval_year의 UNIQUE 제약만 회사 단위(company_id, eval_year)로
-- 완화한다(두 회사가 같은 연도에 각자 스냅샷을 만들 수 있어야 함 — 이전엔 eval_year 단독
-- UNIQUE라 두 번째 회사가 스냅샷을 만들면 첫 회사 것과 충돌했다).
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
ALTER TABLE annual_snapshots ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_annual_snapshots_company_id ON annual_snapshots (company_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'annual_snapshots_company_id_fkey') THEN
    ALTER TABLE annual_snapshots ADD CONSTRAINT annual_snapshots_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
DO $$
DECLARE remaining_null INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'annual_snapshots' AND column_name = 'company_id' AND is_nullable = 'NO'
  ) THEN
    SELECT COUNT(*) INTO remaining_null FROM annual_snapshots WHERE company_id IS NULL;
    IF remaining_null = 0 THEN
      ALTER TABLE annual_snapshots ALTER COLUMN company_id SET NOT NULL;
    ELSE
      RAISE NOTICE 'annual_snapshots: company_id IS NULL 인 행이 %건 남아있어 NOT NULL 제약을 건너뜁니다. scripts/migrate-add-company-id.js 백필 후 재기동하세요.', remaining_null;
    END IF;
  END IF;
END $$;
-- eval_year 단독 UNIQUE를 회사 단위 복합 UNIQUE로 교체. PRIMARY KEY가 아닌 일반 UNIQUE라
-- NULL 잔여 여부와 무관하게 안전하게 전환 가능(NULL은 UNIQUE 제약에서 서로 다른 값으로
-- 취급되어 여러 레거시 행이 공존해도 위반되지 않음).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'annual_snapshots_company_eval_year_uniq') THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'annual_snapshots_eval_year_key') THEN
      ALTER TABLE annual_snapshots DROP CONSTRAINT annual_snapshots_eval_year_key;
    END IF;
    ALTER TABLE annual_snapshots ADD CONSTRAINT annual_snapshots_company_eval_year_uniq UNIQUE (company_id, eval_year);
  END IF;
END $$;
