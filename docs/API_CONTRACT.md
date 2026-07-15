# API 계약 문서 (네이티브/외부 클라이언트용)

이 문서는 이 저장소의 백엔드 API를 **다른 클라이언트(예: Swift Playgrounds로 만드는 iOS/macOS 앱)**가
연동할 때 참고하는 계약서입니다. 백엔드 코드(`server.js`, `ai/main.py`)가 바뀌면 이 문서도 같이
갱신됩니다 — 항상 이 문서가 최신 기준입니다.

이 저장소에는 서로 완전히 독립된 백엔드가 두 개 있습니다. 만들려는 앱이 어느 쪽을 붙이는지에 따라
아래 두 섹션 중 필요한 것만 보시면 됩니다.

---

## 1. HR/ERP 시스템 (`server.js`)

- **운영 URL**: `https://hrsystem-uweb.onrender.com`
- **저장소 경로**: 루트 (`server.js`, `public/index.html`)
- **배포 브랜치**: `claude/mobile-hr-app-testing-rDc2F`

### 1.1 인증

1. `POST /login`
   ```json
   // 요청
   { "loginId": "u2008001", "pw": "비밀번호", "otp": "123456 (2FA 설정된 계정만, 선택)" }
   // 응답 (성공)
   { "ok": true, "employee": { "id": 2, "name": "...", "role": "admin|director|leader|member", ... }, "token": "eyJ..." }
   // 응답 (2FA 필요)
   { "ok": true, "requireOtp": true, "message": "..." }
   // 응답 (실패)
   { "ok": false, "message": "아이디 또는 비밀번호가 올바르지 않습니다." }
   ```
   - `employee` 객체에는 `pw` 필드가 없습니다(서버가 항상 제거).
   - `token`은 HMAC 서명된 문자열이며 **12시간 후 만료**됩니다. 만료되면 다시 `/login`을 호출해야 합니다.
   - IP당 15분에 20회로 요청 제한이 걸려 있습니다(초과 시 429).

2. 이후 모든 요청에 헤더 추가:
   ```
   Authorization: Bearer <token>
   ```
   토큰이 없거나 무효하면 대부분의 엔드포인트가 `401 { "ok": false, "message": "로그인이 필요합니다." }`을 반환합니다.
   `role`은 더 이상 요청 body/query로 보내도 무시됩니다 — 서버가 토큰에서 검증한 값만 사용합니다.

3. 예외(인증 불필요): `POST /login`, `GET /status`, `GET /events`(SSE), `GET /online`,
   `POST /api/reset-all`(자체 재검증), `POST /api/auth/2fa/verify-code`.
   `POST /save`는 **서버에 직원이 0명인 최초 배포 상태에서만** 예외적으로 인증 없이 허용됩니다
   (최초 관리자 계정 업로드용, 그 외엔 항상 인증 필요).

### 1.2 핵심 데이터 모델: "클라이언트 신뢰형 전체 상태 블롭"

이 앱의 가장 중요한 특징입니다 — 일반적인 REST CRUD가 아닙니다.

- `GET /data` — 앱의 거의 모든 데이터(직원, KPI, 결재문서, 근태, 경비청구 등 30개 이상 필드)를
  **하나의 큰 JSON 객체**로 통째로 반환합니다. 응답 형태: `{ "ok": true, "data": {...}, "version": 42 }`
- `POST /save` — 클라이언트가 로컬에서 수정한 **전체 상태를 통째로** 다시 업로드합니다. 서버는
  `_version`을 비교해 클라이언트가 최신이면 그대로 덮어쓰고, 뒤처졌으면 자동 병합(smartMerge)합니다.
  요청 형태: `{ "_version": 42, "data": { "employees": [...], "kpiEntries": [...], ... } }`
  (필드를 일부만 보내면 나머지는 서버의 기존 값을 그대로 두는 게 아니라 **병합 로직에 따라 처리**되니,
  가능하면 항상 전체 상태를 유지하며 필요한 부분만 수정해서 보내는 걸 권장합니다.)
- 실시간 동기화가 필요하면 `GET /events`(Server-Sent Events)를 구독하세요 — 다른 클라이언트가
  저장하면 `data_updated` 이벤트가 오고, 그때 `GET /data`를 다시 호출해 반영하면 됩니다.

새 네이티브 클라이언트를 만든다면, 이 "전체 블롭 GET/POST" 패턴을 그대로 따르거나, 특정 화면에 필요한
필드만 골라 쓰는 게 쉽습니다(예: 직원 목록 화면만 만들려면 `GET /data` 응답에서 `data.employees`만
사용).

### 1.3 대표 엔드포인트 (전체는 `server.js` 참고, 100개 이상 존재)

| 메서드/경로 | 설명 | 인증 |
|---|---|---|
| `GET /data` | 전체 상태 조회 | 필요 |
| `POST /save` | 전체 상태 저장 | 필요(부트스트랩 예외) |
| `GET /status` | 서버 상태(직원 수, 버전 등) | 불필요 |
| `POST /lock`, `POST /unlock` | 동시편집 방지용 레코드 잠금 | 필요 |
| `GET /api/accounting/*` | 회계(계정과목/전표/세금계산서/거래처) | 필요, 대부분 admin |
| `GET/POST /api/erp/*` | 영업/재고/구매(품목/견적/발주/재고) | 필요, 대부분 admin |
| `GET/POST /api/pms/*` | PMS(프로젝트/투입률/업무일지) | 필요 |
| `GET/POST /api/recruit/*` | 채용(공고/지원자/면접) | 필요, 부서별 열람 제한 있음 |
| `POST /api/reset-all` | 전체 데이터 초기화 | loginId/pw 재검증(토큰 아님) |

---

## 2. AI 어시스턴트 (`ai/main.py`)

- **운영 URL**: `https://ai-assist-aosk.onrender.com`
- **저장소 경로**: `ai/` 폴더
- **배포 브랜치**: `claude/account-pinned-agents-v6W7p` (HR 시스템과 다른 브랜치! 별도 확인 필요)

### 2.1 인증
현재 이 API는 대부분 인증이 없는 공개 API입니다(`/admin/*`, `/backup/*`는 `BACKUP_TOKEN` 환경변수
기반 게이팅 — 별도 세션에서 처리 예정인 이슈이니 참고만 하세요).

### 2.2 핵심 엔드포인트

- `GET /personas` — 사용 가능한 페르소나(hr, legal, stock 등) 목록
  ```json
  { "personas": [ { "id": "hr", "name": "...", ... }, ... ] }
  ```
- `POST /chat` — 메인 채팅 엔드포인트
  ```json
  // 요청
  { "message": "연차는 며칠 쓸 수 있어?", "persona": "hr", "use_search": false, "thinking_mode": "off" }
  // persona: "auto"로 보내면 질문 내용을 분석해 자동으로 적합한 페르소나로 라우팅
  // thinking_mode: "off" | "prompt" | "deep"
  ```
  응답은 스트리밍 또는 일반 JSON(구현 세부는 `ai/main.py:447` 참고). 답변이 길면 다운로드 링크
  (`/answer/download/{filename}`)가 마크다운 링크로 포함될 수 있습니다.
- `POST /feedback` — 답변에 대한 좋아요/싫어요 (다음 유사 질문 검색 가중치에 반영됨)
- `GET /health` — 헬스체크
- `GET /backup/download` — 학습 데이터 전체를 ZIP으로 다운로드(SQL 덤프 + 카테고리별 JSON)

### 2.3 주식 분석 (선택)
`ai/stock_analysis/` 하위 별도 파이프라인 — `GET /stock/team`, `POST /stock/analyze`,
`GET /stock/report/text` 등. 이 저장소의 CLAUDE.md 참고.

---

## 3. 이 문서 사용 방법 (다른 세션/Swift Playgrounds 앱 개발 시)

1. 새 세션을 시작할 때 이 문서(`docs/API_CONTRACT.md`)를 먼저 읽어달라고 요청하세요.
2. 어느 백엔드(HR 시스템 vs AI 어시스턴트)를 연동할지 명확히 알려주세요 — URL과 인증 방식이 다릅니다.
3. 이 문서와 실제 코드(`server.js`, `ai/main.py`)가 어긋나 보이면 코드가 항상 우선입니다 — 발견하면
   이 문서를 갱신해달라고 요청하거나 직접 고쳐도 됩니다.
4. 백엔드 쪽에 새 기능이 필요하면(예: 모바일 전용 경량 API), 이 문서에 "다음 세션에 요청할 백엔드
   작업" 섹션을 추가해 남겨두면 원래 세션에서 이어서 처리할 수 있습니다.
