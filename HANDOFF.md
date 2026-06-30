# 작업 인수인계 (Handoff)

## 프로젝트 기본 정보
- GitHub: `jaesung8712/gpt-assistant`
- 작업 브랜치: `claude/mobile-hr-app-testing-rDc2F`
- 실행: `npm install && npm start` → http://localhost:3000 (JSON 파일 모드, `DATABASE_URL` 없으면 자동)
- 테스트 로그인: `admin` / `Admin@123` (실제 직원 256명으로 교체됨 — 로그인ID `u{사번}`, 비밀번호 `{역할}@{사번뒤4자리}`. 예: `u2008001`/`Director@8001`, `u2010009`/`Leader@0009`, `u2026007`/`Member@6007`. 전체 목록은 `public/index.html`의 `let employees=[...]` 참고)
- 인증 모델: 실제 서버 세션/JWT 없음. 클라이언트가 role을 같이 보내고 서버는 `requireAdmin()` 등으로 단순 체크하는 신뢰 구조 (앱 전체에 일관됨, 의도된 설계)

## 최근 완료된 기능 (커밋됨)
- 견적서 → 출고/매출 처리 연동 (`/api/erp/quotations/:id/ship`): 재고 차감 + 세금계산서 자동 발행, 상태 `accepted`→`shipped`
- 영업관리(견적서·발주서) + 재고관리 모듈
- 회계 모듈: 계정과목, 전표, 세금계산서, 거래처(매출처/매입처) 관리
- **버그 A 수정**: `구성원 근태 현황` 바를 모든 페이지에 고정 표시 (대시보드 전용 조건 제거)
- **ERP 확장 4종** (커밋 `499a650`):
  1. 창고 간 이동 — `POST /api/erp/stock/transfer`, 재고관리 페이지에 "↔ 창고 이동" 모달
  2. 매입세금계산서 연동 — PO 입고처리(`/receive`) 시 자동 발행, `direction:"sales"|"purchase"` 필드로 매출/매입 구분 표시
  3. 안전재고 부족 알림 — 알림센터(admin) + 미확인 카운트 반영
  4. 구매요청 승인 워크플로우 — 전 역할 요청 생성 가능, admin 승인/반려/발주전환, 신규 메뉴 `inv-purchase-requests`. 역할별 데이터 필터링은 쿼리스트링(`?role=&userId=`) 기반 (이 엔드포인트만 body 대신 query 사용하는 점 유의)
- **권한설정 UI 개편**: 설정→배포·권한 관리의 메뉴 권한 매트릭스를 대분류(전자결재/커뮤니케이션/내정보·근태/평가/인사/회계/영업관리/재고관리/시스템) 단위로 1차 그룹핑하고, 헤더 클릭 시 하위메뉴 상세조정 화면으로 펼치는 구조로 변경. 대분류 체크박스 클릭 시 하위 메뉴 전체 일괄 선택/해제(`_toggleCategoryPerm`). `_allMenuItems()`(플랫 배열) → `_allMenuItemsByCategory()`(카테고리별 그룹)로 데이터 구조 변경, 펼침 상태는 `_permExpandedCats`로 관리.
- **기초데이터 시딩**: `server.js`에 `DEFAULT_ACCOUNTS`(표준 중소기업 계정과목 64건, 자산/부채/자본/수익/비용)와 `DEFAULT_LOCATIONS`(본사창고) 상수 추가. `initDB()`에서 최초 가동 시 계정과목/위치가 비어있는 경우에만 자동 시딩 — JSON 파일 모드(`_fileAccounting`/`_fileErp` 직접 채움)와 PostgreSQL 모드(JSONB `data` 컬럼에 INSERT) 둘 다 지원.
- **직원 데이터 교체**: 기존 더미 직원(약 100명) 전부 삭제, 사용자가 첨부한 엑셀(`Rawdata_260609`, `Summary` 시트) 256명 실데이터로 교체. `admin` 계정만 유지. 직책 기준 역할 자동분류(대표이사/부문장/사업부장/센터장→director 8명, 팀장→leader 18명, 그외→member 230명). `dept`=엑셀 `사업부`, `team`=엑셀 `팀/파트`. 로그인ID는 `u{사번}`, 초기 비밀번호는 `{역할}@{사번뒤4자리}`.
- **영업 실적 대시보드 + PMS 투입률 관리** (커밋 `50fffa5`, schema는 `44d0f99`):
  - 영업관리 → "영업 실적 대시보드"(admin 전용) 신설: 목표 대비 실적/거래처별 매출 순위/파이프라인(견적서 상태별)/담당자별 실적 4개 탭. 수주액·매출액·순위·파이프라인·담당자 실적은 모두 기존 `erpQuotations`(견적서) 데이터에서 클라이언트가 자동 집계 — 별도 입력 화면 없음. 수주액=`accepted`/`shipped` 상태 합계, 매출액=`shipped` 상태(세금계산서 발행 완료) 합계, 기준 금액은 `supplyTotal`(공급가액). 담당자는 견적서의 `createdBy` 필드 재사용. 유일하게 새로 영속화되는 건 영업 목표(`erp_sales_targets` 테이블/`_fileErp.salesTargets`) — `GET/POST /api/erp/sales-targets`, `POST /api/erp/sales-targets/:id/delete` (admin 전용).
  - 신규 최상위 사이드바 카테고리 "PMS"(`pms-sep`, 전 역할 접근) 신설, 3개 메뉴:
    - 프로젝트 관리(`pms-projects`): 프로젝트 등록/수정/종료는 admin·leader만, 조회는 전 역할. `pms_projects` 테이블/`_filePms.projects`.
    - 내 투입률 입력(`pms-allocation`): 전 직원이 본인 사번으로 월별 프로젝트별 투입률(%) 직접 입력. 본인 또는 admin만 등록/삭제 가능(서버에서 `employeeId`↔`userId` 비교로 검증), 동일 직원·연·월 합계 100% 초과 시 서버에서 거부.
    - 가동률 현황(`pms-utilization`, admin/director/leader 전용): 선택 연/월의 전 직원 투입률 합계를 테이블로 표시, 100% 초과/50% 미만 강조.
  - 새 서버 헬퍼 `requireRole(req,res,allowed)` (`requireAdmin`과 동일한 스타일) — PMS 프로젝트 admin/leader 게이트에 사용.
  - JSON 파일 모드는 `_filePms={projects:[],allocations:[]}`를 별도 파일(`<datafile>-pms.json`)로 저장/로드 (`_fileAccounting`/`_fileErp`와 동일 패턴). Postgres 모드는 `pms_projects`/`pms_allocations`/`erp_sales_targets` 테이블(`data JSONB` 패턴) 사용.

## 진행 중 / 다음 작업
현재 없음. 사용자 지시 대기 중.

### 참고: 향후 확장 시 고려사항
- 구매요청 페이지는 비admin 역할도 접근하므로 `loadErpFromServer()`가 더 이상 admin 전용이 아님 — `_erpLoaded`/`_prLoaded` 플래그로 최초 진입 시 1회 로드, 이후에는 로컬 상태를 직접 mutate (다른 ERP 페이지들과 동일한 패턴)
- 구매요청 메뉴 항목은 `inv-sep` 그룹에 `roles:["admin","director","leader","member"]`로 추가됨 — 그룹/카테고리 자체의 `roles`는 무시되고 leaf item 단위로만 필터링되는 기존 사이드바 구조를 그대로 활용함
- 조직 관리 설정(`depts`/`teamsByDept`, `public/index.html` 약 623번째 줄)의 더미 부서/팀 목록은 직원 데이터 교체와 별개로 갱신되지 않음 — 신규 직원 등록 폼 드롭다운과 실제 부서명이 다를 수 있어, 필요 시 추가 요청으로 실제 조직 구조 반영 가능
- 졸업연도는 엑셀상 날짜 일련번호로 저장되어 있어(예: 45350) 1899-12-30 기준일로 환산해 연도만 추출함 (`excel_serial_to_year` 로직, 변환 스크립트는 임시 파일이라 보존되지 않음 — 재작업 시 동일 로직 재구현 필요)

## 작업 패턴 (반드시 준수)
1. 구현 → `node -c server.js` 문법 체크
2. `index.html`은 `<script>` 블록 추출 + `new Function(s)`로 문법 체크
3. 서버 새로 띄우고 curl로 기능 테스트 (정상 케이스 + 엣지케이스: 재고 부족, 중복 승인 방지, 역할별 권한)
4. Playwright UI 스모크 테스트 (콘솔 에러 0건 확인 + 스크린샷)
   - `chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox']})`
   - 로그인: `#l-id`/`#l-pw` 채우고 `button:has-text("로그인")` 클릭
   - SPA 네비게이션은 `page.evaluate(()=>window.gotoPage('hr-list'))` 사용 (⚠️ `page.goto()`로 새로고침하면 인메모리 세션이 끊겨서 로그아웃됨 — 이번 QA에서 실제로 겪은 실수)
5. 테스트 후 임시 파일/서버 프로세스/데이터 파일(`hr-data*.json`) 정리
6. 커밋 메시지는 한국어, 설명적으로 작성 후 `claude/mobile-hr-app-testing-rDc2F`에 푸시
7. **PR은 사용자가 명시적으로 요청하지 않으면 생성하지 않음**

## 핵심 아키텍처 노트
- `USE_JSON_FILE = !process.env.DATABASE_URL` — JSON 파일 모드(`_fileErp`/`_fileAccounting` 인메모리 + 원자적 파일쓰기) vs Postgres 모드(`pool`, 트랜잭션 + `FOR UPDATE`)
- 서버 권위 모듈(ERP/회계)은 `/api/<module>/*` 전용 REST + 별도 JSON/테이블 — 레거시 `getFullState`/`applyState`/`smartMerge`(직원/KPI 데이터용 클라이언트 신뢰 블롭)와 분리되어 atomic 넘버링/검증 보장
- 재고는 append-only `stockLedger`만 존재, "현재 재고"는 항상 합산으로 계산 (item+location 그룹)
- 문서번호 포맷: `JE-{year}-{seq:6}`(전표), `TI-{year}-{seq:6}`(세금계산서), `QT-...`(견적서), `PO-...`(발주서)
- 견적서 상태: `draft→sent→accepted→shipped(종료)` 또는 `rejected(종료)`
- 발주서 상태: `draft→ordered→received|cancelled`
