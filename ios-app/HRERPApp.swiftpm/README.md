# 인사 ERP 앱 (Swift Playgrounds)

이 저장소의 HR/ERP 백엔드(`server.js`, 루트)에 연결하는 SwiftUI 클라이언트입니다.
AI 어시스턴트(`ai/main.py`)를 연동하는 `../GPTAssistant.swiftpm`과는 완전히 별개의 앱입니다
(백엔드가 다르고, 인증 방식도 다릅니다).

## 배경

`docs/API_CONTRACT.md`(`claude/mobile-hr-app-testing-rDc2F` 브랜치)에 따르면 `server.js`는
로그인/전자결재/근태/경비청구/채용/회계/영업/재고/PMS 등을 아우르는 **100개 이상의
엔드포인트**를 가진 실제 운영 중인 인사·ERP 시스템입니다(`HANDOFF.md` 기준 실직원 256명
데이터 운영 중). `public/index.html` 자체가 2만 줄이 넘는 SPA라, 네이티브 앱으로 전체
쓰기(CRUD) 기능까지 1:1로 재구현하는 것은 여전히 이번 범위를 벗어납니다. 대신:

- 인증(로그인 + Bearer 토큰) + "클라이언트 신뢰형 전체 상태 블롭"(`GET /data` / `POST /save`)
  아키텍처를 구현하고, 그 블롭에서 가장 자주 쓰이는 4개 컬렉션(직원·근태·전자결재·경비청구)에
  실제 쓰기 가능한 화면을 만들었습니다.
- 회계·영업/재고·PMS·채용은 서버가 전용 REST 테이블로 관리하는 **독립 리소스**라, 조회
  중심(+ PMS 투입률은 입력까지)으로 화면을 추가해 커버리지를 크게 넓혔습니다. 자세한 내용은
  아래 "구현된 기능" 표 참고.

## 디자인

실제 웹 앱(`public/index.html`)과 동일한 디자인 언어를 그대로 옮겼습니다 — 배경 `#f1f5f9`,
흰색 카드 + 옅은 테두리(`#e2e8f0`), 포인트 컬러 `#2563eb`. 기본 다크 `List`/`Form` 대신
`Theme.swift`의 `AppCard`/`StatTile`/`ModuleCard`/`StatusPill` 등 공용 컴포넌트로 통일했고,
시스템 다크모드와 무관하게 항상 라이트 테마로 고정됩니다(`.preferredColorScheme(.light)`) —
웹 앱 자체가 라이트 전용이라 다크모드 지원이 의미가 없기 때문입니다.

## 왜 전체 상태를 딕셔너리로 다루는가 (근태·전자결재·경비청구·직원)

`GET /data`는 `employees`, `kpiEntries`, `settings`, `orgDB`, `coreTalentPool` 등
**30개 이상의 필드**를 가진 하나의 큰 JSON을 반환하고, `POST /save`는 그 전체를 통째로
다시 업로드하는 구조입니다(`lib/collections.js`의 `ID_KEYED_LIST_FIELDS`/`SINGLETON_FIELDS`
참고). 이 앱이 이해하지 못하는 필드까지 정적 Swift 구조체로 디코드했다가 다시 인코드해서
되돌리면, 구조체에 없는 필드가 저장 과정에서 통째로 사라집니다(실제 서비스 데이터 유실).

그래서 `HRDataStore`는 전체 블롭을 `[String: Any]`로만 들고 있다가, 변경이 필요한 부분만
(예: 근태 레코드 하나, 결재 문서의 결재자 상태 하나) 직접 딕셔너리 키를 수정하고, 나머지는
손대지 않은 채 그대로 다시 `POST /save`로 돌려보냅니다. 표시용으로만 쓰는 타입(`Employee`,
`AttendanceRecord`, `ApprovalDocSummary`, `ExpenseClaim`)은 읽기 전용 `Decodable`이며
저장 경로에는 관여하지 않습니다.

반면 회계/영업재고/PMS/채용(`/api/accounting/*`, `/api/erp/*`, `/api/pms/*`,
`/api/recruit/*`)은 서버가 각자 전용 테이블로 직접 관리하는 독립 리소스라 이 유실 위험이
없습니다 — 그래서 `ModuleModels.swift`의 모델들은 평범한 `Decodable` 구조체입니다.

## 구현된 기능

| 탭 | 화면 | 내용 |
|---|---|---|
| 홈 | 대시보드 | 내 정보, 오늘 근태 상태 + 출근/퇴근 체크, 대기 결재·전체 직원 수 요약 |
| 근태 | 내 근태 | 내 근태 이력 전체 |
| 전자결재 | 결재함 | 내가 결재할 문서 / 내가 상신한 문서, 결재선 확인, 승인·반려 |
| 경비청구 | 청구 목록 | 내 청구 목록, 신규 작성(항목별 금액/분류/메모), 대기 건 회수 |
| 더보기 → 조직도 | 직원 검색 | 전 직원 검색(이름/부서/팀) — 읽기 전용 |
| 더보기 → 회계 | 계정과목 · 전표 | 목록 조회 (차대변 라인·거래처·상태 포함) — 읽기 전용 |
| 더보기 → 영업/재고 | 품목 · 견적서 · 발주서 · 재고현황 | 목록 조회 (품목명·창고명 매핑 포함) — 읽기 전용 |
| 더보기 → PMS | 프로젝트 · 투입률 | 프로젝트 목록 조회 + **내 투입률 직접 입력**(월별 100% 초과 시 서버가 거부) |
| 더보기 → 채용 | 공고 · 지원자 | 목록 조회 + 지원자 이름/이메일 검색 — 읽기 전용 |
| 설정 | 계정/서버 | 로그인 계정 정보, 서버 URL, `GET /status` 연결 확인, 로그아웃 |

로그인: `POST /login` — 아이디/비밀번호(+2단계 인증 코드), 토큰은 UserDefaults가 아닌
**Keychain**에 저장됩니다.

### 전자결재 승인/반려 로직 관련 주의

`public/index.html`의 `approveApprovalDoc()`/`rejectApprovalDoc()` 로직(결재자
`waiting`→`pending` 순차 진행, 전원 승인 시 문서 `approved`)을 그대로 옮겼습니다. 다만
템플릿별 부가 효과(예: 근태 신청 승인 시 근태 레코드 자동 반영, 거래처 등록 신청 승인 시
거래처 자동 생성)는 `_applyAttendanceApproval()`/`_autoRegisterVendorFromApproval()` 등
`index.html`에만 있는 로직이라 이번 앱에는 옮기지 않았습니다 — 그런 특수 템플릿 문서를
이 앱으로 승인하면 결재선 상태는 정상 반영되지만 부가 효과는 발생하지 않습니다.

## 사용 방법

1. `server.js`를 배포합니다(예: `https://hrsystem-uweb.onrender.com`, 배포 브랜치
   `claude/mobile-hr-app-testing-rDc2F`).
2. Swift Playgrounds에서 `ios-app/HRERPApp.swiftpm`을 엽니다 — 서버 URL은
   `AppSettings.defaultServerURLString`에 기본값으로 미리 채워져 있습니다.
3. 로그인 화면에서 실제 계정(웹에서 쓰던 아이디/비밀번호)으로 로그인합니다.
   `HANDOFF.md`에 적힌 시드 데이터 예시 계정은 이후 실사용 중 비밀번호가 바뀌었을 수 있어
   보장되지 않습니다.
4. 로그인 후 하단 탭에서 홈/근태/전자결재/경비청구/더보기/설정을 확인합니다.

## 범위 밖 (다음 단계 후보)

- 회계·영업재고·채용은 **조회 전용**입니다 — 계정과목/전표 등록, 견적서/발주서 작성,
  채용공고 등록 등 쓰기 기능은 아직 없습니다(각 엔드포인트에 대응하는 POST 메서드를
  `APIClient`에 추가하고 입력 폼만 만들면 되는 구조라, 확장은 이어서 가능).
- 신규 직원 등록/수정, KPI 입력, 전자결재 신규 상신(템플릿 기반 동적 폼이라 별도 설계 필요).
- 2FA 최초 등록 플로우(`/api/auth/2fa/generate-secret`) — 로그인 시 이미 등록된 계정의
  코드 입력만 지원, 신규 등록 화면은 없음.
- 실시간 동기화(`GET /events`, SSE) — 지금은 pull-to-refresh로만 최신화합니다.
