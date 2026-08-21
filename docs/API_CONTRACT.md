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
   - 자연 만료 전이라도, 그 계정의 role/pw/재직여부(active) 중 하나라도 바뀌면(퇴직 처리,
     강등, 관리자의 비밀번호 강제 초기화 등) 이미 발급된 토큰은 다음 요청부터 즉시 401로
     거부됩니다 — 토큰에 실린 `authVersion`을 매 요청마다 그 계정의 현재 저장값과 대조하기
     때문입니다(2026-08-21, 외부 감사 P0-5). 계속 사용하려면 재로그인해서 새 토큰을 받아야
     합니다. 마스터/impersonation 토큰(`empId` 없음)은 이 검사 대상이 아닙니다.

2. 이후 모든 요청에 헤더 추가:
   ```
   Authorization: Bearer <token>
   ```
   토큰이 없거나 무효하면 대부분의 엔드포인트가 `401 { "ok": false, "message": "로그인이 필요합니다." }`을 반환합니다.
   `role`은 더 이상 요청 body/query로 보내도 무시됩니다 — 서버가 토큰에서 검증한 값만 사용합니다.

3. 예외(인증 불필요): `POST /login`, `GET /status`, `GET /events`(SSE), `GET /online`,
   `POST /api/reset-all`(자체 재검증), `POST /api/auth/2fa/verify-code`, JSON 파일 모드의
   `POST /api/bootstrap/admin`.
   `POST /save`는 **항상 인증이 필요**합니다. 빈 JSON 파일 모드의 최초 관리자는
   `BOOTSTRAP_SECRET`과 `X-Bootstrap-Secret` 헤더를 요구하는 전용 부트스트랩 API로만 생성합니다.

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
| `POST /save` | 전체 상태 저장 | 필요 |
| `POST /api/bootstrap/admin` | 빈 JSON 파일 모드 최초 관리자 생성. `{loginId,name,pw}`와 `X-Bootstrap-Secret` 필요, 한 번만 가능 | 불필요(시크릿 필수) |
| `POST /api/auth/change-password` | 본인 비밀번호 변경. `{currentPassword,newPassword}`; 성공 시 새 Bearer token 반환 | 필요 |
| `GET /status` | 서버 상태(직원 수, 버전 등) | 불필요 |
| `POST /lock`, `POST /unlock` | 동시편집 방지용 레코드 잠금 | 필요 |
| `GET /api/accounting/*` | 회계(계정과목/전표/세금계산서/거래처) | 필요, 대부분 admin |
| `GET/POST /api/erp/*` | 영업/재고/구매(품목/견적/발주/재고) | 필요, 대부분 admin |
| `GET/POST /api/pms/*` | PMS(프로젝트/투입률/업무일지) | 필요 |
| `GET/POST /api/recruit/*` | 채용(공고/지원자/면접) | 필요, 부서별 열람 제한 있음 |
| `POST /api/hr/resume-parse` | 신규 직원 등록 이력서 AI 자동입력 | 필요, admin 전용 |
| `POST /api/reset-all` | 전체 데이터 초기화 | loginId/pw 재검증(토큰 아님) |

### 1.4 이력서 AI 자동입력 — `POST /api/hr/resume-parse`

신규 직원 등록 화면에서 이력서 파일을 업로드하면 서버가 텍스트를 추출(PDF 텍스트레이어/OCR,
DOCX, 이미지 OCR)한 뒤 AI로 파싱해 폼 필드를 채워준다. 채용 모듈의 `/api/recruit/*` 이력서
처리(별도 스키마, dataUrl 기반)와는 완전히 분리된 엔드포인트다.

```http
POST /api/hr/resume-parse
Authorization: Bearer <token>
Content-Type: multipart/form-data

file=<PDF|DOCX|PNG|JPG|WEBP, 최대 15MB>
```

성공 응답(`Cache-Control: no-store`):
```json
{
  "ok": true,
  "fields": {
    "name": "", "birth": "YYYY-MM-DD 또는 빈 문자열", "gender": "남|여|빈 문자열",
    "totalCareer": null, "edu": "고등학교 졸업|전문대 졸업|대학교 졸업|대학원 석사|대학원 박사|빈 문자열",
    "eduSchool": "", "jobGroup": "관리직|영업직|개발직|연구직|생산직|서비스직|기타|빈 문자열",
    "careers": [{ "co": "", "start": "YYYY-MM", "end": "YYYY-MM|현재", "pos": "", "desc": "" }],
    "email": "", "phone": ""
  },
  "meta": { "fileType": "pdf|docx|image", "extraction": "text|ocr", "warnings": [] }
}
```

오류는 항상 `{ "ok": false, "code": "...", "message": "..." }` 형식이다.

| 상태 | code | 의미 |
|---:|---|---|
| 400 | `RESUME_FILE_REQUIRED` / `RESUME_TYPE_UNSUPPORTED` / `RESUME_FILE_INVALID` | 파일 없음 / 지원하지 않는 형식 / 실제 파일 시그니처(매직바이트)가 확장자와 불일치, 또는 DOCX가 실제 OOXML 구조([Content_Types].xml + word/document.xml)를 갖추지 않음(일반 zip을 확장자만 바꿔 올린 경우), 또는 이미지 헤더를 읽을 수 없음 |
| 401 / 403 | 기존 인증 오류 | 비로그인 또는 admin이 아님 |
| 413 | `RESUME_FILE_TOO_LARGE` | `RESUME_MAX_BYTES`(기본 15MB) 초과, 또는 DOCX(zip) 압축 해제 시 항목 수가 `RESUME_ZIP_MAX_ENTRIES`(기본 200) 초과 / 선언된 압축해제크기가 `RESUME_ZIP_MAX_UNCOMPRESSED_BYTES`(기본 30MiB) 초과 |
| 413 | `RESUME_IMAGE_TOO_LARGE` | 이미지 픽셀 수(가로×세로)가 `RESUME_IMAGE_MAX_PIXELS`(기본 40,000,000 = 40MP) 초과 — 디코드 전에 헤더만 읽어 판정 |
| 422 | `RESUME_TEXT_UNREADABLE` | 추출된 텍스트가 20자 미만이거나 문서를 파싱할 수 없음 |
| 429 | `RESUME_RATE_LIMITED` | 로그인 계정 기준 15분에 10회 초과(시간창 기반) |
| 429 | `RESUME_CONCURRENCY_LIMIT` | 동시 처리 중인 이력서 분석 요청이 `RESUME_MAX_CONCURRENT`(기본 3) 초과(같은 순간에 몰린 요청 수 기반, 위 시간창 제한과 별개) |
| 502 | `RESUME_AI_FAILED` | AI provider(Groq)가 비정상 응답 |
| 503 | `RESUME_AI_UNAVAILABLE` / `RESUME_OCR_UNAVAILABLE` | `GROQ_API_KEY` 미설정 / 서버에 OCR 도구(poppler-utils, tesseract-ocr) 미설치 |
| 504 | `RESUME_AI_TIMEOUT` | AI 응답이 `RESUME_AI_TIMEOUT_MS`(기본 30초) 안에 오지 않음 |

AI가 반환한 값도 그대로 신뢰하지 않는다 — `birth`는 실제 달력에 존재하는 날짜인지 왕복
검증하고(`2024-99-99`, `2024-02-30` 등은 빈 문자열로 정규화), `totalCareer`는 0~70
범위를 벗어나면(예: `-1`, `999`) `null`로, `careers[].start`/`end`는 `YYYY-MM` 형식(또는
`end`는 `"현재"`)이 아니면 빈 문자열로 정규화한다.

응답에는 항상 `fields`/`meta`만 담기며, 원문 이력서 텍스트·업로드 파일·AI provider 엔드포인트·API 키는
어떤 경로로도 절대 포함되지 않는다.

### 1.5 환경변수 (`server.js`)

| 변수 | 필수 여부 | 기본값 | 설명 |
|---|---|---|---|
| `DATABASE_URL` | 아니오 | (미설정) | 설정 시 PostgreSQL 모드(운영), 미설정 시 JSON 파일 모드(자체호스팅/오프라인). |
| `DATA_FILE` | JSON 파일 모드만 | `hr-data.json` | 메인 데이터 파일 경로. 재배포 시 초기화되지 않으려면 영속 디스크 경로를 가리켜야 함. |
| `BUDGET_DATA_FILE` | JSON 파일 모드만 | `budget-data.json` | 사업계획/예산/개인별급여상세 데이터 파일 경로(DATABASE_URL 설정 시 무시되고 Postgres `budget_store` 사용). |
| `SESSION_SECRET` | 강력 권장 | 랜덤 생성 | 로그인 토큰 서명 키. 미설정 시 재시작마다 전 세션이 무효화됨. |
| `NODE_ENV` | 아니오 | (미설정) | `production`이면 더미 데이터 저장 차단(`ALLOW_DEMO_DATA`로 해제 가능)이 활성화됨. `scripts/seed-demo.js`는 `development`/`test`에서만 실행됨. |
| `ALLOW_DEMO_DATA` | 아니오 | `false` | `true`면 `NODE_ENV=production`에서도 demo 마커(`source:"demo"`/`empNo:"DEMO-..."`)가 붙은 레코드 저장을 허용(운영에서는 설정하지 않는 것을 권장). |
| `ALLOW_DEMO_SEED` | `scripts/seed-demo.js` 실행 시 필수 | (미설정) | `true`가 아니면 CLI가 즉시 종료됨(운영 환경 오실행 방지 조건 중 하나). |
| `RESUME_MAX_BYTES` | 아니오 | `15728640`(15MB) | 이력서 파일 업로드 크기 상한(원본 바이트 기준). |
| `RESUME_MAX_TEXT_CHARS` | 아니오 | `12000` | AI에 보내는 추출 텍스트 길이 상한. |
| `RESUME_AI_TIMEOUT_MS` | 아니오 | `30000` | 이력서 AI 파싱 타임아웃(밀리초). |
| `RESUME_ZIP_MAX_ENTRIES` | 아니오 | `200` | DOCX(zip) 압축 해제 시 허용하는 최대 항목 수(압축 폭탄 방지). |
| `RESUME_ZIP_MAX_UNCOMPRESSED_BYTES` | 아니오 | `31457280`(30MiB) | DOCX(zip) 선언된 압축해제크기 상한(실제 해제 전에 zip 메타데이터만으로 판정, 압축 폭탄 방지). |
| `RESUME_IMAGE_MAX_PIXELS` | 아니오 | `40000000`(40MP) | 이력서 이미지(png/jpg/webp)의 가로×세로 픽셀 수 상한(디코드 전 헤더만으로 판정). |
| `RESUME_MAX_CONCURRENT` | 아니오 | `3` | 이력서 분석 요청의 동시 처리 개수 상한(시간창 기반 rate limit과 별개). |
| `GROQ_API_KEY` | 이력서/채용 AI 파싱 기능에 필요 | (미설정) | 없으면 이력서 자동입력은 503(`RESUME_AI_UNAVAILABLE`), 채용 모듈 AI 파싱은 기능 자체가 비활성화됨(무료 발급: https://console.groq.com). |
| `DEMO_ADMIN_PASSWORD` | `scripts/seed-demo.js` 실행 시 필수 | (미설정) | 생성될 데모 관리자 계정(`demo_admin`)의 로그인 비밀번호(8자 이상). bcrypt 해시로만 저장되고 콘솔에는 로그인 ID만 출력됨. |
| `BOOTSTRAP_SECRET` | JSON 파일 모드 최초 설정 시 필수 | (미설정) | `POST /api/bootstrap/admin`의 one-time 초기화 시크릿. 미설정이면 endpoint가 503으로 fail-closed하며, `POST /save`는 빈 저장소여도 무인증으로 열리지 않는다. 12자 이상 난수로 설정하고 `X-Bootstrap-Secret` 헤더로 한 번만 전달한다. |

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
