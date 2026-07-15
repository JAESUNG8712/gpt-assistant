# 인사 ERP 앱 (Swift Playgrounds)

이 저장소의 HR/ERP 백엔드(`server.js`, 루트)에 연결하는 SwiftUI 클라이언트입니다.
AI 어시스턴트(`ai/main.py`)를 연동하는 `../GPTAssistant.swiftpm`과는 완전히 별개의 앱입니다
(백엔드가 다르고, 인증 방식도 다릅니다).

## 배경

`docs/API_CONTRACT.md`(`claude/mobile-hr-app-testing-rDc2F` 브랜치)에 따르면 `server.js`는
로그인/전자결재/근태/경비청구/채용/회계/영업/재고/PMS 등을 아우르는 **100개 이상의
엔드포인트**를 가진 실제 운영 중인 인사·ERP 시스템입니다(`HANDOFF.md` 기준 실직원 256명
데이터 운영 중). `public/index.html` 자체가 2만 줄이 넘는 SPA라, 네이티브 앱으로 전체
기능을 1:1로 재구현하는 것은 이번 작업 범위를 벗어납니다. 대신:

- 인증(로그인 + Bearer 토큰) + "클라이언트 신뢰형 전체 상태 블롭"(`GET /data` / `POST /save`)
  아키텍처를 제대로 구현해 두었고,
- 그 블롭에서 가장 자주 쓰이는 4개 컬렉션(직원·근태·전자결재·경비청구)에 대한 실제 동작하는
  화면을 만들었습니다.
- 회계·영업·재고·PMS·채용 등 나머지 REST 모듈(`/api/accounting/*`, `/api/erp/*`,
  `/api/pms/*`, `/api/recruit/*`)은 아직 화면이 없습니다 — 필요하면 이어서 요청하세요.
  `APIClient`에 인증 패턴은 이미 구현되어 있어 확장은 어렵지 않습니다.

## 왜 전체 상태를 딕셔너리로 다루는가

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

## 구현된 기능

| 화면 | 내용 |
|---|---|
| 로그인 | `POST /login` — 아이디/비밀번호(+2단계 인증 코드), 토큰은 UserDefaults가 아닌 **Keychain**에 저장 |
| 홈 | 내 정보, 오늘 근태 상태 + 출근/퇴근 체크, 대기 결재 건수 요약 |
| 근태 | 내 근태 이력(이번 달 포함 전체) |
| 전자결재 | 내가 결재할 문서 / 내가 상신한 문서, 결재선 확인, 승인·반려 |
| 경비청구 | 내 청구 목록, 신규 작성(항목별 금액/분류/메모), 대기 건 회수 |
| 조직도 | 전 직원 검색(이름/부서/팀) — 읽기 전용 |
| 설정 | 서버 URL, `GET /status`로 연결 확인, 로그아웃 |

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
2. Swift Playgrounds에서 `ios-app/HRERPApp.swiftpm`을 엽니다.
3. 로그인 화면에서 서버 URL(`https://` 필수)과 아이디/비밀번호를 입력합니다.
   테스트 계정 형식은 `HANDOFF.md` 참고(`u{사번}` / `{역할}@{사번뒤4자리}`).
4. 로그인 후 하단 탭에서 홈/근태/전자결재/경비청구/조직도를 확인합니다.

## 범위 밖 (다음 단계 후보)

- 회계(계정과목/전표/세금계산서/거래처), 영업·재고(견적서/발주서/재고), PMS(투입률/업무일지),
  채용(공고/지원자/면접) — 전부 전용 REST 모듈이 이미 있으므로 화면만 추가하면 됩니다.
- 신규 직원 등록/수정, KPI 입력, 전자결재 신규 상신(템플릿 기반 동적 폼이라 별도 설계 필요).
- 2FA 최초 등록 플로우(`/api/auth/2fa/generate-secret`) — 로그인 시 이미 등록된 계정의
  코드 입력만 지원, 신규 등록 화면은 없음.
- 실시간 동기화(`GET /events`, SSE) — 지금은 pull-to-refresh로만 최신화합니다.
