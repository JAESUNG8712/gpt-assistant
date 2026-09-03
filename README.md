# 인사평가 통합 시스템 v18.1

한국 기업의 인사평가 생명주기를 통합 관리하는 웹 애플리케이션입니다.

## 운영 브랜치 정책

- 운영 기준 및 GitHub 기본 브랜치는 `hr-production`입니다.
- 운영 반영은 작업 브랜치에서 `hr-production`을 대상으로 Pull Request를 만들고,
  필수 CI가 통과한 뒤 병합합니다.
- `hr-production`에는 직접 push하거나 강제 push하지 않습니다.
- 과거 `main` 및 `claude/*` 브랜치는 별도 이력 보존용이며 운영 배포 기준으로 사용하지
  않습니다. 공통 조상이 없는 브랜치를 강제로 병합하지 마세요.
- 공식 운영 URL은 Render의 `https://hr-system-docker.onrender.com/`입니다. Vercel 배포는
  Git 연결을 끊어 운영 기준으로 사용하지 않으며, 남아 있는 Vercel URL 접근은 공식 Render
  주소로 유도합니다.

## 주요 기능

| 모듈 | 기능 |
|------|------|
| **KPI 관리** | KPI 등록 → 자체평가 → 1차(팀장) → 2차(사업부장) 평가 → 등급 산정 |
| **다면평가** | 역량평가(팀원/팀장), 리더십평가(사업부장) — 360도 평가 |
| **승진 심사** | 직급 체류연수 · 우수등급 취득 · 법정교육 이수 조건 자동 검증 |
| **핵심인재 관리** | 핵심인재 풀 구성, 육성계획 작성 및 승인 |
| **인사 관리** | 입사자 등록, 인사 변동(발령/승진/휴직/퇴직) 이력 관리 |
| **조직 설정** | 부서/팀/직급/직책 구성, 등급 비율, 평가 기간 설정 |
| **데이터 관리** | 자동 백업·복원, CSV 일괄 가져오기/내보내기, 서버 동기화 |

## 역할 체계

| 역할 | 설명 |
|------|------|
| `admin` | 시스템 전체 관리 |
| `director` | 사업부장 — KPI 2차 평가, 부서 전체 조회 |
| `leader` | 팀장 — KPI 1차 평가, 팀원 관리 |
| `member` | 팀원 — KPI 등록, 다면평가 응답, 개인 결과 조회 |

## 테스트(데모) 계정

아래는 서버에 연결하지 못했을 때(또는 서버에 아직 직원이 0명인 최초 배포 부트스트랩
상태일 때)만 쓰이는 `public/index.html`의 오프라인 데모 계정이다(가상의 인물, 실제
회사 데이터 아님). 서버에 이미 직원 데이터가 있는 정상 운영 상태에서는 이 계정으로
로그인되지 않고 반드시 서버가 검증하는 실제 계정을 써야 한다.

| 역할 | ID | 비밀번호 |
|------|----|----------|
| 관리자 | `admin` | `admin` |
| 사업부장 | `u1001` | `1001` |
| 팀장 | `u1002` | `1002` |
| 팀원 | `u1003` | `1003` |
| 팀원 | `u1004` | `1004` |

실제 운영 배포(회사 데이터가 있는 서버)의 로그인 계정은 회사마다 다르며, 관리자가
인사관리 > 직원목록의 "🔑 계정 사번으로 초기화" 기능을 실행하면 아이디는 `u{사번}`,
비밀번호는 `{역할}@{사번뒤4자리}` 형식으로 일괄 재설정된다 — 이 값을 문서에 고정값으로
적어두지 않는 이유는 실행 시점·회사마다 달라지기 때문이다.

## 시작하기

### 방법 1 — Node.js 서버로 실행 (권장: 다중 사용자, 서버 동기화)

```bash
# 의존성 설치
npm install

# 서버 시작 (기본 포트: 3000)
npm start

# 또는 개발 모드 (파일 변경 자동 감지)
npm run dev
```

브라우저에서 `http://localhost:3000` 접속

> 서버로 실행 시 **자동으로 서버 동기화**가 활성화됩니다. 여러 PC에서 동시 접속 및 실시간 데이터 공유가 가능합니다.

### 방법 2 — 파일 직접 열기 (단일 사용자, 오프라인)

```bash
open public/index.html
# 또는 브라우저에서 파일 경로로 열기
```

> 브라우저 localStorage에 데이터가 저장됩니다. 서버 연동 없이 단독으로 사용 가능합니다.

## 서버 API

| 메서드 | 엔드포인트 | 설명 |
|--------|-----------|------|
| GET | `/status` | 서버 상태 및 메타 정보 |
| GET | `/data` | 전체 데이터 조회 |
| POST | `/save` | 데이터 저장 (안전한 필드는 병합하고 stale 레코드·설정 충돌은 409로 차단) |
| GET | `/events` | SSE 실시간 이벤트 스트림 |
| GET | `/online` | 현재 접속 중인 사용자 목록 |
| POST | `/lock` | 편집 잠금 획득 |
| POST | `/unlock` | 편집 잠금 해제 |
| POST | `/log` | 활동 로그 기록 |
| GET | `/activity` | 활동 로그 조회 |
| GET | `/backups` | 백업 목록 조회 |
| POST | `/backups/create` | 수동 백업 생성 |
| POST | `/restore` | 백업에서 복원 |

## 데이터 저장 위치

Render PostgreSQL 운영 배포에서는 실제 데이터가 로컬 `data/` 폴더가 아니라
`DATABASE_URL`이 가리키는 PostgreSQL DB에 저장된다. `data/` 폴더는 JSON 파일 모드
또는 로컬 개발 실행에서만 사용된다.

```
data/
├── hr_data.json       ← 메인 데이터
└── backups/           ← 자동/수동 백업 (최대 20개)
    ├── backup_2025-01-01T00-00-00_manual.json
    └── ...
```

### PostgreSQL JSON 백업/검증(pg_dump 설치 없이)

PostgreSQL 클라이언트(`pg_dump`)를 설치할 수 없는 회사 PC에서는 Node.js 기반 읽기 전용
백업 스크립트를 사용할 수 있다. 기본 저장 위치는 OneDrive의
`DB-Backups/hr-system`이며, 백업 파일에는 인사/급여/회계 정보와 비밀번호 해시 등
민감정보가 포함될 수 있으므로 공유 링크를 만들지 않는다.

```powershell
$BackupDir = Join-Path $env:OneDrive "DB-Backups\hr-system"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$SecureUrl = Read-Host "Render External Database URL 붙여넣기" -AsSecureString
$Ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureUrl)

try {
  $DatabaseUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Ptr)
  Set-Item -Path ("Env:DATABASE" + [char]95 + "URL") -Value $DatabaseUrl
  Set-Item -Path "Env:BACKUP_DIR" -Value $BackupDir

  node scripts/backup-db-json.js
  node scripts/verify-db-json-backup.js
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr)
  Remove-Variable DatabaseUrl -ErrorAction SilentlyContinue
  Remove-Variable SecureUrl -ErrorAction SilentlyContinue
}
```

백업 파일은 `hrsystem-db-json-*.json`, 무결성 확인용 체크섬은
`hrsystem-db-json-*.json.sha256` 형식으로 생성된다. `node scripts/verify-db-json-backup.js`
명령은 최신 백업을 자동으로 찾아 파일 구조·필수 테이블·SHA256을 검증한다.

## 프로젝트 구조

```
.
├── public/
│   └── index.html    ← 메인 애플리케이션 (순수 JS, CSS, HTML)
├── data/             ← 런타임 생성
│   ├── hr_data.json
│   └── backups/
├── server.js         ← Express 서버
├── package.json
└── README.md
```

## 기술 스택

- **프론트엔드**: 순수 JavaScript (ES6+), HTML5, CSS3 (외부 의존성 없음)
- **백엔드**: Node.js + Express
- **실시간 동기화**: Server-Sent Events (SSE)
- **데이터 저장**: JSON 파일 (서버) / localStorage (브라우저)

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 서버 포트 |
