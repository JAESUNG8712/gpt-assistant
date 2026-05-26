# GPT Assistant 프로젝트

## 계정 정보
- 이메일: myangle87@naver.com
- 계정명: jaesung8712
- GitHub 레포: jaesung8712/gpt-assistant
- 개발 브랜치: claude/account-pinned-agents-v6W7p

---

## 팀 에이전트 구성 (고정, 변경 지시 전까지 유지)

아래 8인 팀 구성은 명시적으로 변경 요청이 없는 한 항상 이 구성을 기준으로 작업한다.

| 역할 | 담당 | 설명 |
|---|---|---|
| 🗂️ 기획자 | 1명 | 사용자 요구사항 파악, 기능 정의, 일정 조율, 와이어프레임 |
| 🖥️ 프론트엔드 개발자 | 1명 | UI/UX 구현, 반응형 디자인, HTML/CSS/JS, React/Vue |
| ⚙️ 백엔드 개발자 | 1명 | 서버 로직, REST API, DB 설계, 인증/인가 |
| 🌐 네트워크 개발자 | 1명 | 네트워크 아키텍처, 서버 배포, CDN, WebSocket |
| 🔒 보안 담당자 | 1명 | 취약점 분석, 보안 감사, 암호화, OWASP 기준 점검 |
| 🧪 QA 담당자 1 | 1명 | 기능 테스트, 시나리오 설계, 결함 리포팅 |
| 🔬 QA 담당자 2 | 1명 | 성능 테스트, 자동화 테스트, 크로스브라우저 검증 |
| 📚 문서 작성자 | 1명 | 사용자 매뉴얼, API 문서, 개발 가이드, 운영 절차서 |

---

## 작업 규칙

- 사용자가 요청하면 기획자 역할로 요구사항을 먼저 정리하고, 각 담당 역할별로 구분하여 작업을 진행한다.
- 팀 구성 변경은 사용자가 명시적으로 요청할 때만 수정한다.
- 새 세션이 시작되어도 이 파일을 기준으로 동일한 팀 구성과 규칙을 유지한다.
- 작업 중 중요한 결정 사항이 생기면 이 파일의 "프로젝트 기록" 섹션에 추가한다.

---

## 기술 스택

- **런타임**: Node.js
- **서버**: Express.js
- **데이터 저장**: data.json (로컬 파일 기반)
- **프론트엔드**: 순수 HTML/CSS/JS (외부 프레임워크 없음)

---

## 자체 AI 시스템 (`ai/` 디렉토리)

사용자가 직접 소유하는 AI 어시스턴트. 유료 서비스 의존 없이 운영 가능.

### 구조
- `ai/main.py` — FastAPI 서버 (모든 API 엔드포인트)
- `ai/llm.py` — Groq API 연동 (Llama 3.1 8B, 무료)
- `ai/memory.py` — SQLite(대화이력) + ChromaDB(벡터RAG)
- `ai/search.py` — DuckDuckGo 인터넷 검색 학습
- `ai/backup.py` — OneDrive 백업 (Microsoft Graph API)
- `ai/static/index.html` — iPad PWA 채팅 UI

### 배포 방법 (Render.com 무료)
1. `ai/` 폴더를 Render Web Service로 배포
2. 환경변수 `GROQ_API_KEY` 설정 (https://console.groq.com 무료 발급)
3. Disk 마운트: `/app/data` 1GB (대화/학습 데이터 영속 저장)
4. iPad Safari에서 배포 URL 접속 → "홈 화면에 추가" → PWA로 사용

### OneDrive 백업 설정
- Azure Portal에서 앱 등록 후 Client ID/Secret/Refresh Token 발급
- `.env` 파일에 설정하면 UI에서 버튼 한 번으로 백업

### 파인튜닝 (추후)
- 파인튜닝은 GPU 필요 → Google Colab 또는 Hugging Face 무료 컴퓨트 활용
- 현재는 RAG(검색 증강 생성)로 동일한 효과 구현

---

## 프로젝트 기록

<!-- 중요한 결정 사항, 요구사항, 변경 이력을 여기에 추가 -->

- 2026-05-26: 8인 팀 에이전트 구성 확정 (기획자 1, FE 1, BE 1, 네트워크 1, 보안 1, QA 2, 문서 1)
- 2026-05-26: 에이전트 미설정 계정에 기본팀 자동 적용 기능 구현
- 2026-05-26: 프로젝트 맥락 영속 저장 기능(메모리 API) 구현
- 2026-05-26: 자체 AI 시스템 구현 (Groq+RAG+OneDrive 백업, iPad PWA)
