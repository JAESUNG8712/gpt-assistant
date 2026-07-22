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
- `ai/memory.py` — SQLite(대화이력·학습지식·문서·피드백 저장)
- `ai/engine.py` — 자체 TF-IDF 검색 엔진 (ChromaDB는 완전 제거, 벡터DB 미사용)
- `ai/search.py` — DuckDuckGo 인터넷 검색 학습
- `ai/backup.py` — 직접 다운로드(ZIP) + Google Drive 백업 (OAuth2)
- `ai/static/index.html` — iPad PWA 채팅 UI

### 배포 방법 (Render.com 무료)
1. `ai/` 폴더를 Render Web Service로 배포
2. 환경변수 `GROQ_API_KEY` 설정 (https://console.groq.com 무료 발급)
3. Disk 마운트: `/app/data` 1GB (대화/학습 데이터 영속 저장) — `ai/render.yaml`에 이미 정의되어 있음
4. iPad Safari에서 배포 URL 접속 → "홈 화면에 추가" → PWA로 사용

### 배포 방법 (Railway 사용 시 — 영속 디스크 필수 설정)
`ai/railway.json`은 빌드/시작 커맨드만 정의하고 **Volume은 코드로 선언되지 않음** —
Railway 대시보드에서 직접 만들어야 한다. 이걸 안 하면 매 재배포·컨테이너 재시작마다
SQLite DB가 컨테이너 임시 파일시스템에 생성되어 학습된 RAG 데이터가 전부 초기화된다.
1. Railway 프로젝트 → 서비스 선택 → **Volumes** 탭 → "New Volume" 생성
2. Mount Path를 `/app/data`로 지정
3. 서비스 환경변수에 `DB_PATH=/app/data/memory.db` 추가
4. 재배포 후에도 `ai/data/memory.db`가 Volume에 저장되어 영속됨 (배포 로그에 `⚠️ DB_PATH 환경변수가 설정되지 않았습니다` 경고가 더 이상 안 뜨면 정상 설정됨)

### 백업 (직접 다운로드 + Google Drive)
- `GET /backup/download` — DB 전체를 ZIP(SQL 덤프 + 카테고리별 JSON + manifest)으로 즉시 다운로드
- Google Drive 연동(선택): Google Cloud Console에서 OAuth2 Client ID/Secret 발급 후 `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REDIRECT_URI` 환경변수 설정 → UI에서 Google 로그인 1회 후 버튼으로 백업

### 검색 엔진 (TF-IDF, ChromaDB 미사용)
- `ai/engine.py`의 자체 TF-IDF 엔진이 정적 KB(`ai/knowledge_*.py`)와 학습된 지식(`learned_knowledge` 테이블)을 통합 검색
- 학습/추가 시 `_dirty` 플래그로 표시되고 다음 검색 시 전체 corpus를 재구축하는 구조 (대규모 데이터에선 재구축 비용 고려 필요)

### 파인튜닝 (추후)
- 파인튜닝은 GPU 필요 → Google Colab 또는 Hugging Face 무료 컴퓨트 활용
- 현재는 RAG(검색 증강 생성)로 동일한 효과 구현

---

## 주식 분석 에이전트 팀 (11명)

`ai/stock_analysis/` 디렉토리의 주식 분석 전용 에이전트 팀.

| 역할 | 담당 | 설명 |
|---|---|---|
| 👔 총괄 관리자 | 1명 | 전체 파이프라인 조율, 분석 대상 선정, 최종 승인 |
| 💰 재무 자료 수집 | 1명 | DART 공시·재무제표, KRX 수급(외국인/기관/개인) |
| 📊 경제 자료 수집 | 1명 | 금리·환율·물가·지수·원자재 등 거시경제 지표 |
| 🌍 세계 동향 수집 1 | 1명 | 지정학 리스크, 무역 분쟁, 주요국 정치 |
| 🌐 세계 동향 수집 2 | 1명 | 산업 트렌드, AI·반도체·배터리·바이오 동향 |
| 📋 자료 취합 | 1명 | 4개 수집 에이전트 데이터 통합·정규화 |
| 🔍 상세 분석 | 1명 | 저평가 스크리닝, DCF/PER/PBR, 매수·매도 시점 |
| ✅ 교차 검증 1 | 1명 | 재무 데이터 이상치·회계 처리 검증 |
| 🔬 교차 검증 2 | 1명 | 분석 논리 일관성·편향 검증 |
| ⚠️ 교차 검증 3 | 1명 | 리스크 독립 검증, 스트레스 테스트 |
| 📝 레포트 작성 | 1명 | 오전 7시 / 저녁 10시 정기 보고서 생성 |

### 환경 변수
- `DART_API_KEY` — DART OpenAPI (https://opendart.fss.or.kr)
- `BOK_API_KEY` — 한국은행 ECOS API (https://ecos.bok.or.kr)
- `ANTHROPIC_API_KEY` — Claude API (https://console.anthropic.com) — 미설정 시 규칙 기반 분석으로 fallback

### Claude API 통합
- 모델: `claude-opus-4-8` (적응형 사고 `thinking: adaptive`)
- 적용 위치: `ai/stock_analysis/utils/claude_client.py`
  - `analyze_stock_opinion()` — 종목별 AI 투자의견 (StockAnalyzer)
  - `generate_executive_summary()` — 시황 종합 요약 (ReportWriter)
  - `generate_action_plan()` — 실행 가능한 투자 액션 플랜 (ReportWriter)
- Prompt caching 적용 (시스템 프롬프트 고정 텍스트)
- API 키 미설정 시 자동 fallback → 규칙 기반 분석 유지

### API
- `GET  /stock/team` — 팀 구성 조회
- `POST /stock/analyze` — 분석 실행 (백그라운드)
- `GET  /stock/analyze/sync` — 분석 동기 실행
- `GET  /stock/report/text` — 최근 보고서 텍스트
- `GET  /stock/status` — 실행 상태

---

## 프로젝트 기록

<!-- 중요한 결정 사항, 요구사항, 변경 이력을 여기에 추가 -->

- 2026-05-26: 8인 팀 에이전트 구성 확정 (기획자 1, FE 1, BE 1, 네트워크 1, 보안 1, QA 2, 문서 1)
- 2026-05-26: 에이전트 미설정 계정에 기본팀 자동 적용 기능 구현
- 2026-05-26: 프로젝트 맥락 영속 저장 기능(메모리 API) 구현
- 2026-05-26: 자체 AI 시스템 구현 (Groq+RAG+OneDrive 백업, iPad PWA)
- 2026-06-02: 주식 분석 11인 에이전트 팀 구현 (DART+KRX+매크로+지정학+검증3회+정기보고서)
- 2026-06-02: Claude API (claude-opus-4-8) 통합 — 종목별 AI 투자의견·시황요약·액션플랜 자동 생성, prompt caching 적용
- 2026-06-17: 백업 구조 개선 — `ai/backup.py`에 카테고리별 JSON 추출(by_category/*.json) + manifest.json 추가, ZIP 다운로드/Google Drive 백업 모두 적용
- 2026-06-17: 법률 KB 검색 정확도 개선 — `knowledge_legal.py`/`knowledge_legal2.py` 65개 항목 중 정확도 80% 미만 44개 항목의 `q` 필드에 자연어 변형 키워드 보강 (전체 정확도 67.1% → 92.8%, `test_legal_kb_accuracy.py`로 검증)
- 2026-06-17: 문서/코드 불일치 수정 — CLAUDE.md의 ChromaDB 설명을 실제 구현(TF-IDF `ai/engine.py`)에 맞게 수정, OneDrive→Google Drive 백업 설명 수정
- 2026-06-17: 법률 KB 확장 — `ai/knowledge_legal3.py` 신설, 모자보건법·일가정양립법(남녀고용평등법)·영유아보육법·아동수당법 등 가족·돌봄 관련 법령 추가
- 2026-06-17: 주식 리포트 채팅 요약 개선 — `_extract_report_section()` 헬퍼로 TOP 추천 종목·저평가 종목 섹션을 항상 채팅 응답에 포함 (특정 종목 미언급 시에도 동일), `report_writer.py`에 `_undervalued_picks()` 섹션 신설(분석 대상 종목 중 저평가/강한저평가 등급만 별도 정리)
- 2026-06-17: 검색 엔진 매칭 정교화 — `python-mecab-ko` 형태소 분석기를 옵션으로 도입(미설치 시 규칙 기반 토크나이저로 자동 폴백)해 붙여쓰기 복합어 분해 보강, 도메인별(개발/여행/채용) 동의어 그룹 추가(법률/HR KB와 겹치는 단어는 회귀 방지를 위해 제외). 법률 KB 정확도 92.8% → 93.0%로 유지·개선 확인
- 2026-06-17: 검색·답변 내용 영구 RAG 누적 + 피드백 학습 구현 — `/chat` 응답을 (stock 페르소나 제외) 항상 `auto_learn`으로 영구 저장하도록 확장(기존엔 `no_local` 케이스만 학습), `feedback_boost` SQLite 테이블 신설로 페르소나+질문 단위 좋아요/싫어요 누적 가중치 저장(좋아요 → 1.3배 부스트 최대 3.0, 싫어요 → 0.4배 감산 최저 0.05), `engine.py` 검색 점수에 가중치 곱 적용해 싫어요 받은 답변은 다음 동일 질문 시 새로 생성되고 좋아요 받은 답변은 유사 질문에서도 우선 노출되도록 함, `/feedback` 엔드포인트에서 즉시 라이브 반영 + 엔진 로드 시 SQLite에서 복원하여 재시작 후에도 유지
- 2026-06-22: 배포 후 RAG 데이터 초기화 문제 진단 — 사용자가 실사용 중인 플랫폼은 Railway였고, `ai/railway.json`에는 영속 볼륨이 코드로 선언되어 있지 않아 재배포마다 컨테이너 임시 파일시스템의 SQLite DB가 사라지는 것이 원인으로 확인됨(코드 자체의 학습/누적 로직은 이미 정상 동작, 인프라 설정 누락이 근본 원인). `main.py`에 `DB_PATH` 미설정 시 배포 로그에 경고를 출력하는 점검 코드 추가, `CLAUDE.md`에 Railway Volume 생성 + `DB_PATH=/app/data/memory.db` 환경변수 설정 가이드 추가
- 2026-06-22: KRX 수급/공매도 데이터 조회 실패 시 fallback 누락 수정 — `krx_client.py`의 `get_investor_trading()`/`get_short_selling()`이 pykrx 실패 시 에러 dict를 반환해 주식 분석 파이프라인이 조용히 데이터 누락되던 문제를, 같은 파일 내 다른 함수들이 이미 쓰던 `_mock_investor_data()` 등 fallback 패턴과 일치시켜 수정
- 2026-06-22: 페르소나별 검색 분리 — `main.py`의 `/chat` 인터넷 검색 단계에서 `srch.search_and_learn(search_msg)` 호출이 `persona_id`를 누락해 모든 페르소나의 웹검색 학습 결과가 `search_and_learn()` 기본값인 `persona="hr"`로 고정 저장되던 버그를 발견. `search_and_learn(search_msg, persona_id=req.persona)`로 수정해 이후부터는 페르소나별로 검색/학습 데이터가 분리됨. 이 수정 이전에 이미 저장된 웹검색 학습 데이터는 원래 페르소나 정보가 남아있지 않아 자동 재분류는 불가(필요 시 수동 정리 별도 논의)
- 2026-06-22: 증권사 리포트 컨센서스 섹션에 빈 placeholder 데이터가 "수집 리포트 N건"으로 표시되던 문제 수정 — `securities_report.py`의 `_parse_naver_research()`(네이버 리서치 HTML 파싱)와 `search_reports_ddg()`(DuckDuckGo 보조 수집)가 증권사명·목표주가·투자의견·날짜 추출에 실패해도 빈 문자열을 그대로 담은 report dict를 리스트에 추가하던 구조라, `_build_consensus()`의 `len(reports)`가 빈 항목까지 카운트해 "수집 리포트 2건"처럼 보이지만 실제 내용은 전부 "미상"/"중립"/"TP:-"인 신뢰할 수 없는 결과가 나왔음. `get_all_reports()`에 `_is_meaningful()` 필터(목표주가·투자의견 중 하나라도 실제 값이 있어야 통과)를 추가해 빈 항목을 컨센서스 집계 전에 제거 — 실데이터가 없으면 "수집된 리포트 없음"으로 정직하게 표시됨
- 2026-06-24: 주식 분석 채팅 응답 상세화 + 긴 자료 다운로드 분리 + 전 페르소나 참고자료 링크 추가. (1) `_summarize_stock_report()`(main.py)가 종목 미지정 "현황" 질문에 기존 Executive Summary/TOP 추천 종목/저평가 종목 3개 섹션만 보여주던 것을, 시장 환경 분석·증권사 애널리스트 리포트 컨센서스 2개 섹션을 추가해 5개 섹션으로 확장 — report_writer.py 자체는 14개 섹션을 이미 생성하고 있었으나 채팅 요약 레이어가 그중 일부만 노출해 "모호하다"는 문제가 발생했던 것이 원인. (2) `_summarize_long_text()` 신설 — 답변 본문이 3500자를 넘으면 앞부분만 채팅에 표시하고 전체는 `stock_analysis/reports/answers/`에 파일로 저장 후 다운로드 링크(`/answer/download/{filename}` 신규 엔드포인트, `answer_` 접두사·`..` 차단)로 안내. `run_broker_report`(단독 증권사 리포트 조회)·`run_lowprice_screen`(저평가 저가주 스크리닝) 두 원문 그대로 출력하던 경로에 적용. (3) `_format_reference_links()` 신설 — `[{title,url}]` 목록을 마크다운 링크 푸터로 변환(http만 허용, 중복 제거, 최대 5개). 경로 B(LLM 보강) 양쪽 분기에 `reference_items` 수집을 연결: stock_mode는 증권사 리포트 "링크" 필드 + DDG 자동검색 결과, 비주식 페르소나는 law_search 결과 + 일반 웹검색 결과. 프론트엔드(`index.html`의 `renderMd()`)가 이미 마크다운 링크와 `/stock/download/` `/answer/download/` 다운로드 버튼 스타일을 지원하고 있어 프론트엔드 변경은 불필요했음. 적용 범위 제한: KB-직접답변(경로 A)·기업 KB 무응답(경로 C)에는 참고자료가 없어 미적용, 뉴스 기사(`news_collector.py`의 "출처" 필드는 출처명/URL이 혼재해 신뢰 불가)는 참고링크에서 제외
- 2026-06-24: 증권사 리포트·뉴스 수집기가 실데이터를 못 가져오던 근본 원인 다수 발견·수정(이 환경의 외부망 차단이 풀린 뒤 실제 네이버 금융 응답으로 검증). `securities_report.py`의 `fetch_naver_research()`가 `searchType=priceTo&code={ticker}` 파라미터를 쓰고 있었는데 이는 종목과 무관한 전체 "목표주가 변경" 리스트를 반환하는 잘못된 조회였음(올바른 파라미터는 `searchType=itemCode&itemCode={ticker}`) — 이 때문에 `_parse_naver_research()`의 정규식(`/research/company_read.naver?nid=` 절대경로 기대)도 실제 마크업(`company_read.naver?nid=` 상대경로)과 맞지 않아 항상 0건이 파싱됐음. 목표주가·투자의견은 목록 페이지에 컬럼 자체가 없고 개별 리포트 본문(`목표가 480,000 | 투자의견 Buy` 형태)에만 있다는 것도 확인 — `_enrich_with_target_opinion()` 신설로 상위 5건의 본문을 추가 조회해 채움, `_extract_report_meta()`로 본문에서 목표가·투자의견 파싱, 영문 등급(Buy/Hold/Sell)을 한글 버킷으로 정규화하는 `_normalize_opinion()` 추가(기존 `_build_consensus()`가 한글 키워드만 매칭해 영문 등급은 의견분포에서 누락되던 문제도 같이 해결). 또한 `search_reports_ddg()`가 `async def`이면서 내부적으로 완전히 동기 블로킹인 DDGS 호출을 실행하고 있어, `get_all_reports()`의 `asyncio.gather()`로 `fetch_naver_research()`와 함께 묶이면 이벤트 루프를 점유해 네이버 쪽 요청이 거의 항상 타임아웃되던 동시성 버그를 발견·수정(`run_in_executor`로 별도 스레드 실행, `news_collector.py`가 이미 쓰던 패턴과 통일) — 이게 "정확한 내용이 거의 안 들어간다"는 원래 사용자 불만의 진짜 근본 원인이었음(이전 수정은 빈 placeholder를 걸러내는 대증 처방이었을 뿐, 데이터가 애초에 안 들어오는 원인은 그대로였음). `news_collector.py`의 `_fetch_naver_finance_news()`도 같은 종류의 파싱 버그 수정(제목이 `title=` 속성이 아니라 `<a>` 태그 내부 텍스트로 들어있었음, 날짜 정규식이 공백·시간 포함 형식과 안 맞았음). 두 파일의 HTML 클린업 헬퍼(`_clean`/`_clean_html`)에 `html.unescape()` 추가해 `&hellip;` 등 엔티티 미디코딩 문제도 해결. 부가적으로 `aiohttp.ClientSession()` 호출들에 `trust_env=True`를 추가(이 개발 샌드박스의 로컬 프록시를 타려면 필요했던 설정, 배포 환경에는 영향 없음). 전체 파이프라인 실측 결과: 삼성전자 기준 증권사 리포트 5건(평균 목표주가 522,000원, 의견분포 매수 5건)·뉴스 8건이 정상 수집·표시됨을 확인
- 2026-07-15: `ios-app/GPTAssistant.swiftpm` 신설 — Swift Playgrounds용 SwiftUI 클라이언트 앱 추가. `docs/API_CONTRACT.md`를 요청받았으나 이 브랜치(`claude/add-jaesung8712-gpt-assistant-boed6i`)에는 해당 파일(과 `docs/` 폴더 자체)이 존재하지 않아, `ai/main.py`·`ai/personas.py`·`ai/memory.py`를 직접 읽어 실제 엔드포인트(`GET /personas`, `POST /chat`, `GET·DELETE /history`, `POST /feedback`, `GET /health`)를 기준으로 구현. `/chat`이 SSE가 아니라 `text/plain` 바이트 스트림임을 확인하고 `URLSession.bytes(for:)` + 자체 `IncrementalUTF8Decoder`(청크 경계에서 한글 등 멀티바이트 문자가 잘리는 것 방지)로 스트리밍 렌더링을 구현. 파일 업로드가 필요한 `/learn/document`·`/analyze/resume`·`/budget/*`·`/backup/*`·`/stock/*`는 범위 밖으로 제외하고 채팅·페르소나 선택·이력·피드백 핵심 흐름만 포함. 사용법은 `ios-app/README.md` 참고
- 2026-07-15: 위 iOS 앱 작업 직후 `docs/API_CONTRACT.md`가 실제로는 `claude/mobile-hr-app-testing-rDc2F` 브랜치에 존재함을 확인. 이 문서에 따르면 저장소에는 완전히 독립된 두 백엔드가 있음 — ① HR/ERP 시스템(`server.js`, 이 저장소 루트, 로그인+Bearer 토큰 인증, 회계·영업·재고·PMS·채용 등 100개 이상 엔드포인트, 실운영 URL `https://hrsystem-uweb.onrender.com`, 배포 브랜치가 곧 `claude/mobile-hr-app-testing-rDc2F` 자신), ② AI 어시스턴트(`ai/main.py`, 대부분 무인증, 실운영 URL `https://ai-assist-aosk.onrender.com`, 배포 브랜치는 `claude/account-pinned-agents-v6W7p` — iOS 앱을 만들 때 실제로 읽은 브랜치와는 또 다름). 두 브랜치의 `ai/main.py`를 직접 diff한 결과 632줄 차이가 있었으나, iOS 앱이 쓰는 핵심 엔드포인트(`/personas`,`/chat`,`/history`,`/feedback`)의 요청/응답 형태는 동일했음. 유일한 실질적 차이는 `/health`— Turso(클라우드 DB) 모드에서는 `db_exists`/`disk_free_mb` 필드가 응답에서 아예 빠짐(로컬 SQLite일 때만 포함) — 이로 인해 iOS 앱의 `HealthResponse` 디코딩이 깨질 수 있었던 버그를 발견해 옵셔널로 수정, 신규 `db_backend` 필드도 반영. 또한 실제 배포본에는 `/chat` 메시지 4000자 초과 시 400 거부(`_MAX_CHAT_MESSAGE_LEN`)가 있어 클라이언트 측에도 동일한 사전 검증 추가, FastAPI `HTTPException`의 `{"detail":"..."}` 형태를 파싱해 에러 메시지를 더 깔끔하게 표시하도록 개선. HR/ERP(`server.js`) 연동은 사용자 확인 결과 이후 단계로 보류 — 다음 작업으로 로그인/Bearer 토큰 인증부터 새로 구현 예정.
- 2026-07-15: `ios-app/HRERPApp.swiftpm` 신설 — `server.js`(HR/ERP 시스템) 전용 별도 Swift Playgrounds 앱(사용자 요청: AI 어시스턴트 앱과 완전히 분리). `server.js`·`lib/collections.js`·`public/index.html`(claude/mobile-hr-app-testing-rDc2F 브랜치)을 직접 읽어 인증(`POST /login` → HMAC 서명 Bearer 토큰, Keychain에 저장) + "클라이언트 신뢰형 전체 상태 블롭"(`GET /data`/`POST /save`) 패턴을 구현. `lib/collections.js`의 `ID_KEYED_LIST_FIELDS`/`SINGLETON_FIELDS`로 실제 필드명(30개 이상) 확인, 이 중 근태(`attendanceRecords`)·전자결재(`approvalDocs`)·경비청구(`expenseClaims`)·직원(`employees`) 4개만 화면으로 구현 — 100개 이상 엔드포인트 전체(회계/영업/재고/PMS/채용)를 한 번에 구현하는 건 `public/index.html` 자체가 2만 줄이 넘는 SPA라 비현실적이라 판단해 사용자에게 알리고 범위를 좁힘. 핵심 설계 결정: `HRDataStore`가 `/data` 응답 전체를 정적 Codable 구조체가 아닌 `[String: Any]`로 그대로 보관하다가 필요한 필드만 딕셔너리 키 단위로 직접 수정 후 그대로 `/save`— 이 앱이 모르는 필드(`settings`/`orgDB`/`coreTalentPool` 등)까지 Codable로 왕복시키면 인코딩 시 그 필드들이 통째로 사라져 서버 데이터가 유실되는 위험이 있었기 때문(표시 전용 타입 `Employee`/`AttendanceRecord`/`ApprovalDocSummary`/`ExpenseClaim`은 Decodable만, 저장 경로에는 관여하지 않음). 전자결재 승인/반려는 `index.html`의 `approveApprovalDoc()`/`rejectApprovalDoc()`(결재자 waiting→pending 순차 진행) 로직을 그대로 이식했으나, 템플릿별 부가효과(근태 자동반영 등)는 미구현. 앱 재시작 후 직원 정보 복원을 위해 토큰 payload(base64url JSON, 서명 미검증)에서 empId만 읽어 `/data`의 employees와 매칭하는 방식 사용. 사용법·범위·다음 단계는 `ios-app/HRERPApp.swiftpm/README.md` 참고. `ios-app/README.md`는 두 앱을 안내하는 인덱스로 재구성.
- 2026-07-16: 실기기(Swift Playgrounds) 테스트로 버그 다수 발견·수정 + HR/ERP 앱 UI 전면 개편·기능 확장. (1) 버그 수정: `ExpenseView.swift`에서 `@MainActor` 타입의 `static let categories`를 nonisolated 컨텍스트(중첩 구조체 기본값 초기화)에서 참조해 Swift 6 언어 모드 컴파일 에러 발생 — 최상위 파일-스코프 상수로 이동해 해결(Swift Playgrounds가 Swift 6 언어 모드로 컴파일한다는 것도 이 과정에서 확인). 두 앱 모두 `AppSettings` 기본 서버 URL을 빈 문자열에서 실제 배포 주소로 변경(Swift Playgrounds가 실행마다 UserDefaults를 초기화하는 것처럼 보여 매번 재입력해야 했음), 추가로 이미 `http://`로 잘못 저장된 값을 실행 시점에 자동으로 `https://`로 교정하는 로직 추가(App Transport Security가 http를 막아 로그인이 이유 없이 실패하는 문제 재발 방지). HR/ERP 로그인 화면에 비밀번호 표시 토글 추가. `admin`/`Admin@123` 등 HANDOFF.md에 기재된 시드 계정이 실제 배포 서버에서는 거부됨을 curl로 직접 검증해 확인 — 앱 버그가 아니라 실사용 중 계정 데이터가 문서 작성 시점 이후 바뀐 것으로 결론. (2) UI 전면 개편: `public/index.html`(실제 웹 앱)의 CSS에서 실제 색상 값을 그대로 추출(배경 `#f1f5f9`, 흰 카드 `#fff`+테두리 `#e2e8f0`, 포인트 컬러 `#2563eb`)해 `Theme.swift`에 `AppCard`/`StatTile`/`ModuleCard`/`StatusPill`/`AppScreen`(LazyVStack 기반, 직원 257명 등 대량 목록 스크롤 성능 고려) 공용 컴포넌트 신설, 전체 화면을 여기에 맞춰 재작성하고 `.preferredColorScheme(.light)`로 고정(웹 앱이 라이트 전용이라 다크모드 지원 자체가 의미 없음). 이 과정에서 `.swipeActions`는 List 전용이라 AppScreen(ScrollView 기반)에서는 동작하지 않는다는 걸 발견해 경비청구 회수 버튼을 인라인 버튼으로 교체(회귀 방지). (3) 기능 확장: `server.js`의 회계(`/api/accounting/*`)·영업재고(`/api/erp/*`)·PMS(`/api/pms/*`)·채용(`/api/recruit/*`) REST 엔드포인트 응답 필드를 직접 읽어(`계정과목`·`전표`·`품목`·`견적서`·`발주서`·`재고`·`프로젝트`·`투입률`·`공고`·`지원자`) `ModuleModels.swift`에 모델 추가 — 이 리소스들은 GET /data의 "전체 블롭"과 달리 서버가 전용 테이블로 관리하는 독립 리소스라 평범한 Decodable로 디코드해도 데이터 유실 위험이 없음(블롭과의 핵심 차이를 README에 명시). 새 탭 "더보기"(`ERPHubView`)에 조직도까지 포함해 5개 모듈 진입점 구성, 회계/영업재고/채용은 조회 전용, PMS는 내 투입률 직접 입력(월별 100% 초과 시 서버가 거부)까지 구현. 전체 CRUD 100% 구현은 여전히 범위 밖임을 README에 명시.
- 2026-07-16: 실기기 확인 결과 조직도(직원 상세 미확인) + 전자결재(신규 작성 불가) 두 가지 실사용 공백을 발견해 보강. (1) 조직도: `EmployeeDirectoryView`의 행을 `NavigationLink`로 바꿔 `EmployeeDetailView` 신설(사번·아이디·역할·직군·직급·이메일·전화번호·주소·입사일·생년월일·성별·학력 표시) — `employees.push()` 실제 필드를 다시 확인해 `Employee` 모델에 추가, 급여(salary)는 민감정보라 의도적으로 제외(서버 GET /data 자체는 역할별로 이 필드를 가리지 않고 그대로 내려주지만, 클라이언트에서 노출하지 않기로 결정). (2) 전자결재 신규 상신: `approvalDocs`가 회계/PMS 등과 달리 전용 REST 엔드포인트 없이 GET /data 블롭의 일부라는 걸 재확인 — `HRDataStore.appendApprovalDoc()`을 경비청구와 동일한 "append-only, 다른 레코드 안 건드림" 패턴으로 추가하고, `ApprovalsView`에 상신 시트(제목/내용 + 결재자 다중 선택 검색 피커, `ApproverPickerView` 신설)를 구현. `index.html`이 14개 결재 템플릿(휴가·경조사·출장 등 동적 필드)을 지원하는 것과 달리, 이번엔 "일반 결재"(`tpl-general`: 제목+내용 2필드)만 지원 — 나머지 템플릿은 `approvalTemplates` 컬렉션을 읽어 동적 폼을 그려야 해서 범위 밖으로 명시. `ApprovalDocSummary`에 `formData` 필드도 추가해 결재 상세 화면에 내용이 보이도록 함(템플릿마다 값 타입이 달라 실패해도 전체 목록 디코딩이 깨지지 않게 커스텀 `init(from:)`으로 best-effort 처리).
- 2026-07-16: HR/ERP 앱 사이드바/탭바 병행 지원(넓은 화면 좌측 메뉴) + 대시보드 확장 + 알림 피드 + 조직도 상세 + 전자결재 신규 상신을 구현한 직후, 사용자 요청("기능별 에이전트로 QA 진행해서 개선점 도출")에 따라 4개 영역(네비게이션/세션, 데이터 무결성, 동시 접속/저장, 보안)으로 백그라운드 QA 에이전트를 병렬로 띄워 실데이터 기준 점검 후 발견된 문제를 수정. (1) [치명적] `RootView`가 `horizontalSizeClass == .regular`일 때 `SidebarRootView`(NavigationSplitView), 아닐 때 `MainTabView`(TabView)를 보여주도록 분기해 넓은 화면에서 웹과 동일한 좌측 메뉴 레이아웃을 구현했는데, 두 레이아웃 모두 원래 탭/섹션 전환 시 `NavigationStack(path:)` + `NavigationPath()` 리셋으로 "뒤로가기 한 번 더 눌러야 메뉴가 보이는" 문제를 고치려 했었음 — QA 에이전트가 `NavigationLink(value:)`/`.navigationDestination(for:)` 없이 전부 옛 방식 `NavigationLink { View } label: { }`(뷰 빌더 방식)만 쓰고 있어 `NavigationPath`가 애초에 아무것도 추적하지 못한다는 걸 grep으로 확인 — `MainTabView`/`SidebarRootView` 양쪽 다 각 `NavigationStack`에 `.id(UUID())`를 걸어 탭/섹션 전환 시 스택 자체를 통째로 재생성하는 방식으로 교체(push 방식과 무관하게 항상 확실히 리셋됨). (2) 회계/영업재고/PMS/채용/알림 5개 화면이 `HRDataStore`(블롭 컬렉션)와 달리 각자 독립 REST 엔드포인트를 직접 호출하면서 401(토큰 만료)을 일반 오류 메시지로만 표시하고 로그인 화면으로 안 돌아가던 것을, `HRDataStore.reload/save`와 동일하게 `session.handleUnauthorized()`를 호출하도록 통일. (3) `APIClient.decodeList`가 `[T].self`로 배열 전체를 한 번에 디코드해 레코드 하나만 스키마와 안 맞아도 목록 전체가 실패하던 것을, `HRDataStore.decodeArray`가 이미 쓰던 레코드 단위 `compactMap` 디코드로 교체(문제 레코드만 건너뜀). (4) PMS 투입률 입력 프로젝트 피커가 멤버 여부와 무관하게 전체 프로젝트를 보여줘 실수로 잘못된 프로젝트에 입력하기 쉬웠던 것을, 내가 멤버로 등록된 프로젝트(+ 멤버 제한 없는 프로젝트)로 좁히고 `role == "admin"`은 전체 유지. (5) `KeychainTokenStore`가 `SecItemAdd`/`SecItemDelete`의 OSStatus를 무시하던 것을 확인하도록 수정, 접근성을 `kSecAttrAccessibleAfterFirstUnlock`에서 `...ThisDeviceOnly`로 변경(토큰이 iCloud Keychain 동기화 대상에 안 들어가도록). 서버 쪽 저장 방식(`smartMerge`가 삭제를 tombstone 없이 처리 못해 동시 저장 시 근태/경비청구/전자결재가 되살아날 수 있는 위험) 은 `server.js` 변경이 필요해 이번 범위에서 고치지 않고 README에 "알려진 한계"로 명시. 상세 내용은 `ios-app/HRERPApp.swiftpm/README.md`의 "이번 QA 라운드에서 고친 것"/"알려진 한계" 섹션 참고.
- 2026-07-16: 사용자 요청 5가지(사이드바, 알림, 대시보드 확장/평가 등 기능 확장, 탐색 상태 버그, QA) 중 4가지 반영. (1) 탐색 버그 수정 — 원인은 각 탭/모듈이 자체 `NavigationStack`을 갖고 있어 탭을 벗어났다 돌아와도 이전 push 깊이가 그대로 남아있던 것. `DashboardView`/`AttendanceView`/`ApprovalsView`/`ExpenseView`/`SettingsView`/`ERPHubView`에서 자체 `NavigationStack` 래퍼를 전부 제거해 "내용만 있는" 뷰로 통일하고(시트 내부의 `NavigationStack`은 유지 — 시트는 항상 새로 열리므로 문제 없음), `MainTabView`가 탭마다 별도 `NavigationPath`를 쥐고 `onChange(of: selectedTab)`에서 선택되지 않은 탭들의 path를 리셋하도록 재구성. (2) 사이드바 — 실제 웹 앱(`public/index.html`)처럼 화면을 넓히면 좌측에 전체 메뉴가 나오도록 `RootView`가 `horizontalSizeClass`로 `MainTabView`(compact, 하단 탭+더보기 허브)와 `SidebarRootView`(regular, `NavigationSplitView`)를 분기. 사이드바 쪽은 허브 그룹 없이 12개 섹션을 평평하게 나열(`AppSection` enum 신설) — 웹 사이드바가 카테고리 없이 다 펼쳐져 있는 것과 동일하게 맞춤. 두 레이아웃 모두 같은 화면 컴포넌트를 재사용(각 화면이 자체 NavigationStack을 갖지 않게 된 (1)의 리팩터링 덕에 가능해짐). (3) 알림 — `NotificationsView` 신설. 실제 푸시(APNs) 인프라는 서버에 없어 인앱 피드로 구현: 내가 처리할 결재 + 대기중인 내 경비청구(이미 보유한 데이터) + 안전재고 미만 품목(품목+재고 API를 별도 조회해 계산, 재고관리 페이지의 "안전재고 부족 알림"과 동일 조건). (4) 대시보드 확장 + 평가(KPI) — `kpiEntries`(자기평가→1차→2차→최종확정 다면평가) 구조를 `index.html`에서 확인, 목표 작성/점수 입력 등 쓰기 워크플로 전체는 범위 밖으로 명시하고 읽기 전용 `KPIView` 신설(내 목표·자기/1차/2차/최종 점수). 홈 화면에 결재·경비청구·직원수·KPI 건수 스탯 4개 + 전체 섹션 바로가기 그리드 추가. (5) QA는 아직 미착수 — 다음 턴에 진행 예정.
- 2026-07-21: 사용자 요청("실사용처럼 여러 번 반복 테스트, 100명 이상 동시 접속, 계정 간 데이터 상호 영향, 모바일/앱 사용 시 문제 전부 확인")에 따라 실제 운영 서버(`https://hrsystem-uweb.onrender.com`, 실직원 257명)를 대상으로 실측 QA를 진행. 관리자 계정(admin/admin)으로 전용 더미 테스트 계정 2개(qa_test_1/qa_test_2, empId 259/260, 서버의 원자적 발급 엔드포인트 `POST /api/employees/next-id`로 id 채번)를 새로 만들어, 4개 백그라운드 에이전트(동시접속 부하·계정 간 데이터 격리·기능별 반복 회귀·모바일 클라이언트 코드 정합성)를 병렬로 띄워 검증. 발견·수정한 클라이언트(iOS 앱) 버그: (1) `HRDataStore.withdrawExpenseClaim`이 배열에서 레코드만 지우고 서버의 `recordTombstones`를 기록하지 않아, 동시 저장 충돌 시 회수한 경비청구가 되살아날 수 있던 것을 웹 앱(`index.html`의 `_tombstone()`)과 동일하게 수정 — 이 과정에서 이전 라운드 문서에 "tombstone을 대부분 컬렉션이 지원 안 함"이라고 적었던 게 부정확했음을 확인·정정(실제로는 대부분 컬렉션에 일반화되어 있었음). (2) 새 경비청구/전자결재 문서 id가 순수 밀리초 타임스탬프(`Int(Date().timeIntervalSince1970*1000)`)라 두 기기가 같은 밀리초에 저장하면 하나가 조용히 사라지는 것을 부하 테스트로 실제 재현(강제 동일 id 동시 저장 시 50% 유실 확인) — `Models.swift`에 `newClientRecordId()`(끝에 무작위 3자리 추가, JS Number 정밀도 한계인 2^53 이내 유지)를 신설해 두 파일 적용. (3) `HRDataStore.reload()`/`save()`가 겹쳐 호출되면 두 저장 응답이 도착 순서대로 반영되며 나중 응답이 최신 상태를 덮어쓸 수 있어 `isLoading` 재진입 가드 추가. (4) `PMSView.NewAllocationView.save()`에 401 처리가 빠져있던 것을 다른 쓰기 경로와 통일. 서버(`server.js`) 쪽에서만 고칠 수 있어 이번 범위 밖으로 README에 새로 기록한 실측 발견 사항: `employees` 컬렉션은 Postgres 모드에서 INSERT/UPDATE만 수행하고 `recordTombstones`/배열에서 빠진 id를 전혀 확인하지 않아 직원 삭제가 사실상 반영되지 않음(테스트 계정 정리 시 직접 겪음 — 정상 삭제 시도가 `ok:true`로 성공 응답했지만 재조회하니 그대로 남아있었고, 하드 삭제는 훨씬 파괴적인 `POST /restore(deleteExtras:true)` 스냅샷 복원 경로뿐이라 대신 `active:false`+`retireDate`로 비활성화 처리); 전자결재 동시 승인/반려 시 `smartMerge`가 문서 레코드 전체를 승자독식으로 병합해(approvers 배열 내부 병합 없음) 한쪽 결정이 `ok:true` 응답에도 불구하고 조용히 사라짐(실측 재현); `POST /save`가 경비청구 레코드 삭제 시 소유자(empId) 검증을 전혀 하지 않아 다른 계정 토큰으로 API를 직접 호출하면 남의 pending 경비청구를 지울 수 있음(실측 확인, 앱 UI는 막지만 API 레벨 방어 없음); approvalDocs에 스키마 검증이 없어 결재자 0명 문서·자기결재가 API 레벨에선 막히지 않음(앱 UI는 막음); Render 무료 티어에서 100~200 동시 접속 시 90~97.5% 성공률·응답 지연 6.5~18.6초로 저하(서버 다운/데이터 손상은 없음). 테스트로 만든 데이터는 전부 정리 확인, qa_test_1/qa_test_2 계정은 위 employees 삭제 미반영 문제로 완전 삭제 대신 비활성화 처리. 상세 내용은 `ios-app/HRERPApp.swiftpm/README.md`의 "알려진 한계"/"2차 QA 라운드... 추가로 고친 것" 섹션 참고.
- 2026-07-21: 사용자 요청("관리자로 들어갈 경우 웹 버전 관리자와 같은 자료 수정 권한 부여, 미구현 웹 기능도 같이 구현")에 대해 규모가 매우 커서(직원 CRUD·회계/영업재고/채용/PMS 쓰기·KPI 전체 평가 워크플로·설정 관리 등) 우선순위를 물었고, 사용자가 "직원 관리 먼저(신규/수정/퇴사)"를 선택해 구현. `public/index.html`의 `submitHRForm()`(신규 등록, 서버 원자적 id 발급 `POST /api/employees/next-id` 사용)·`submitHRChange()`(발령·변동 이력)·`submitRetire()`(퇴직 처리, `active:false`+`retireDate`/`retireReason`+대기중 경비청구 자동 반려)를 그대로 읽어 iOS 앱에 이식. `role=="admin"` 계정에만 노출: 조직도 화면 ＋ 버튼(신규 등록, 필수 항목 검증+사번/로그인ID 중복 클라이언트 사전 차단), 직원 상세 화면 `···` 메뉴의 "정보 수정"(부서/팀/역할/직군/직급/직책/연봉/연락처, 바뀐 필드만 `hrHistory`에 감사 기록)·"퇴직 처리"(재직자만, 확인 후 즉시 비활성화). 웹의 "발령·변동 이력" 8개 유형별 전용 폼과 미래 날짜 예약 적용, 로그인ID/비밀번호 변경은 범위 밖으로 명시. `APIClient.nextEmployeeId(token:)`, `HRDataStore.rawEmployeeDict/createEmployee/updateEmployee/retireEmployee` 신설(전부 raw 딕셔너리 직접 수정 패턴 유지 — Employee Decodable 구조체는 여전히 표시 전용). `Employee`에 `retireDate` 필드 추가, `EmployeeDetailView`를 `employee` 스냅샷 대신 `employeeId`+`store`로 바꿔 수정 직후 화면에 즉시 반영되도록 함. 구현 직후 관리자 계정(admin)으로 실제 프로덕션 서버에 신규 등록→정보 수정→퇴직 처리 전 과정(Swift 코드가 만드는 것과 동일한 페이로드 형태)을 curl로 직접 실행해 검증 완료(생성 직후 필드 반영, hrHistory 기록, 퇴직 후 로그인 차단까지 전부 확인) — 테스트로 만든 계정은 검증 과정 자체가 곧 퇴직 처리라 별도 정리 불필요. 상세 내용은 `ios-app/HRERPApp.swiftpm/README.md`의 "관리자 전용: 직원 관리" 섹션 참고. 회계/영업재고/채용/PMS 쓰기, KPI 평가 워크플로, 설정 관리 등 나머지 관리자 기능은 다음 단계로 보류.
- 2026-07-21: 관리자 쓰기 권한 확장 2번째 단계 — 경비청구·전자결재 관리자 기능 구현(직원 관리 다음 우선순위). (1) 경비 정산 관리(`ExpenseAdminView` 신설, 더보기 → 경비 정산 관리): `index.html`의 `renderExpenseAdminPage()`/`approveExpenseClaim()`/`rejectExpenseClaim()`/`payExpenseClaim()`을 그대로 이식 — 전 직원 청구 조회(상태 필터/검색), 승인/반려(반려 사유 필수), 지급 처리(지급일·방법 + 선택적 회계 전표 자동 생성 `POST /api/accounting/vouchers`, 전표 생성 실패 시 지급 처리 자체 취소). `APIClient.createVoucher()`, `HRDataStore.approveExpenseClaim/rejectExpenseClaim/markExpensePaid` 신설, `ExpenseClaim`에 `approvedBy/rejectReason/paidAt/payMethod/voucherNo` 필드 추가. (2) 전체 결재 관리(`ApprovalAdminView` 신설, 더보기 → 전체 결재 관리): 웹 앱엔 없는 화면 — 관리자가 결재선 밖의 문서까지 전체 조회하고 정체된 진행중 문서를 "관리자 강제 반려"로 종료(대기 중인 결재자 전원을 반려 처리 + 코멘트에 관리자명·사유 기록, 강제 승인은 만들지 않고 강제 반려만 제공해 범위를 신중히 좁힘). `HRDataStore.adminForceRejectApproval()` 신설, 기존 `private struct ApprovalDetailView`를 `internal`로 승격해 결재함/관리자 화면이 공유. 두 화면 모두 `AppSection`에 `adminOnly` 플래그 추가해 사이드바/더보기 허브에서 `role=="admin"`일 때만 노출(서버가 이 접근 자체를 막지 않으므로 클라이언트 쪽 방어에 의존 — 기존 "알려진 한계"와 동일한 제약). 구현 직후 프로덕션 서버에 실제 페이로드로 경비청구 승인→지급(전표 생성·삭제 포함)과 결재 강제반려 전 과정을 curl로 검증 완료, 테스트 데이터는 모두 정리(전표는 draft 상태라 `DELETE /api/accounting/vouchers/:id`로 삭제, 경비청구/결재문서는 tombstone과 함께 배열에서 제거). 다음 단계: 회계/영업재고/채용 쓰기, KPI 평가 워크플로.
- 2026-07-21: 관리자 쓰기 권한 확장 3~6단계 — 회계/영업재고/채용/KPI 순서로 이어서 구현(경비·결재 다음 우선순위, 사용자가 "쭉 계속 진행해줘"로 순서대로 요청). (3) 회계 쓰기(`AccountingView` 확장): 계정과목 등록/수정(`POST /api/accounting/accounts`), 전표 작성(차대변 다중 라인, `POST /api/accounting/vouchers`, 항상 임시 상태로 생성)→확정(post)/취소(void, 사유 필수)/삭제(임시만). `APIClient.saveAccount/deleteAccount/postVoucher/voidVoucher/deleteVoucher` 신설. (4) 영업재고 쓰기(`SalesInventoryView` 확장): 품목 등록, 재고 입/출고 조정(`POST /api/erp/stock/adjust`), 견적서·발주서 신규 작성(다중 품목 라인) — 서버가 지원하는 송부/수락/출고(견적서), 확정/입고/취소(발주서) 등 다단계 상태 전이는 재고 반영·번호 발급 로직이 단계마다 달라 범위를 크게 벗어나 등록(draft) 단계까지만 구현. (5) 채용 쓰기(`RecruitView` 확장): 채용공고 등록, 지원자 등록, 전형 단계 변경 — 서버가 이 3개 엔드포인트만 `admin` 외 `leader`/`director`에게도 허용(`requireRole(["admin","leader","director"])`)한다는 걸 발견해 다른 관리자 기능과 다르게 게이팅(`canManageRecruit`). `RecruitJob`에 `stages` 필드 추가. (6) KPI 쓰기(`KPIView` 확장): 본인 목표 등록(항목/비중/목표/전략 등)과 목표 제출(비중 합계 100% 검증, 웹과 동일), 자체평가 입력(실적/달성율/세부내용/자체점수) — 1차/2차평가는 팀장·사업부장이 팀원 여러 명의 KPI를 한 번에 배치 처리하는 모달(1차 승인 게이트 `firstStatus` 선행 필요)이고 최종확정·동점자처리·등급조정은 부서별 자동 등급 산정(`tryAutoGradeAfterSecond`/`tryCalcDeptGradesSilent`)과 깊이 얽혀 있어 범위 밖으로 유지. `KPIEntry`/`NewKPIGoalPayload` 확장, `HRDataStore.appendKPIGoal/submitKPIGoals/updateKPISelfEval` 신설. 4개 기능 모두 프로덕션 서버에 실제 페이로드로 생성→상태전이→정리 전 과정을 curl로 검증 완료, 테스트 데이터는 매번 정리(삭제 가능한 것은 삭제, 서버가 하드삭제를 막는 것은 web과 동일하게 비활성화/취소 상태로 남김). 다음 단계(사용자 요청): 전체 기능 QA 에이전트 병렬 검토(기능 오류·보안 문제).
- 2026-07-21: 관리자 쓰기 기능 6종(직원/경비/결재/회계/영업재고/채용/KPI) 구현 완료 직후, 사용자 요청("다 진행하고 나서는 에이전트를 배부하여서 기능 구현의 오류라던지 보안상 문제가 발생하지 않는지 검토")에 따라 4개 백그라운드 에이전트(권한/보안 게이팅, 신규 기능 통합 실측, 동시성/데이터정합성 정적검토, 신규 Swift 코드 정적 감사 — Swift 컴파일러가 이 환경에 없어 수동 대조로 대체)를 병렬로 띄워 전체 검토. 발견·수정한 버그: `HRDataStore.save()`/`reload()`의 기존 재진입 가드(`guard !isLoading else { return false }`)가 겹치는 호출을 조용히 버려서, 여러 화면이 쓰는 "raw를 먼저 동기적으로 수정 → save() 호출" 패턴과 만나면 "승인/지급 처리했는데 서버엔 저장 안 됨" 상태가 될 수 있었음(경비청구 승인 중 pull-to-refresh가 겹치는 등의 시나리오, 화면엔 이미 처리된 것처럼 보이고 에러 메시지도 놓치기 쉬움 — 이전 QA 라운드에서 근태 체크 정도의 낮은 영향으로 판단해 넣은 가드였는데, 이번에 금전(경비 지급)·결재 승인까지 다루게 되면서 영향도가 커진 것을 재발견). `inFlightSave`/`inFlightReload` Task 기반으로 교체해 겹치는 호출은 건너뛰지 않고 진행 중인 저장이 끝나길 기다린 뒤 최신 raw로 재시도하도록 수정. 나머지 검토 결과는 전부 "문제없음"으로 확인됨: 관리자 전용 UI 진입점 전부 role 체크로 가려져 우회 경로 없음(직접 실측: member 계정으로 회계/영업재고/채용공고 시도 시 전부 403, leader는 채용공고만 성공 — 서버 설계와 일치), 새 뮤테이션들이 tombstone 설계 원칙(배열 삭제 시에만 필요)을 올바르게 따름, employees 삭제 미반영 서버 버그가 이번 기능(수정/퇴직은 UPDATE 경로만 사용)에 영향 없음, 직원퇴직→경비자동반려·경비승인→전표생성→확정·결재강제반려→재승인차단 등 통합 시나리오 프로덕션 실측 전부 정상, 정적 코드 감사에서 실제 컴파일 에러 후보 없음(EnvironmentObject 주입 누락·모델 필드 오타·API 시그니처 불일치·private 스코프 위반·Identifiable 누락 등 중점 점검). 상세 내용은 `ios-app/HRERPApp.swiftpm/README.md`의 "3차 QA 라운드" 섹션 참고. 이로써 사용자가 요청한 "경비부터 쭉 이어서 구현 + 전체 QA 검토" 작업 완료.
- 2026-07-21: 사용자가 "혹시 아까 보류하던 작업이 있으면 진행"이라며 남아있던 범위 밖 항목 3개(KPI 1차/2차평가·최종확정, 견적서/발주서 상태 전이, 직원 관리 확장) 전체를 다중 선택해 이어서 구현. (1) KPI 평가자 워크플로: `KPIApprovalView` 신설(더보기 → KPI 평가 관리, `AppSection.evaluatorOnly`로 leader/director/admin에게만 노출) — 팀원 스코프(admin=전체, director=같은 부서, leader=같은 부서+팀)별로 1차 승인/반려, 1차/2차 점수 배치 입력, 최종 확정을 구현. `HRDataStore`에 `approveKPIFirst/rejectKPI/saveKPIFirstEval/saveKPISecondEval/finalizeKPI` 신설, `KPIEntry`에 `firstStatus/firstReason/finalReason` 추가. 동점자 처리·부서별 자동 등급 산정은 여전히 범위 밖. (2) 견적서/발주서 상태 전이: `TradeDocDetailView` 신설(관리자가 목록에서 문서를 눌러 진입) — 견적서 발송→수주확정/반려→출고, 발주서 발주확정→입고/취소, draft 단계 삭제까지 구현. `APIClient`에 `sendQuotation/acceptQuotation/shipQuotation/rejectQuotation/deleteQuotation`·`confirmPurchaseOrder/receivePurchaseOrder/cancelPurchaseOrder/deletePurchaseOrder` 신설(응답 키만 다르고 구조가 같아 `postTradeDocAction`/`deleteTradeDoc` 공용 헬퍼로 처리). (3) 직원 관리 확장: `EmployeeDetailView`에 로그인ID 변경(중복 검사 포함)·비밀번호 초기화(`ResetPasswordView`)·발령·변동 이력 유형별 전용 폼(`HRChangeView`: 전보/급여/승진/직급변경/직책/기타, 미래 날짜 입력 시 `HRDataStore.appendHRChange()`가 `applied:false`+`pendingUpdates`로 예약 저장) 추가, `HRDataStore.applyDueHRChanges()`가 조직도 화면 진입 시(`EmployeeDirectoryView.task`) 날짜가 도래한 예약 변경을 실제로 반영. 세 기능 모두 코드 balance 점검(중괄호/괄호 카운트, 라인 단위 재독) 완료했으나, 이 시점에 실운영 서버가 `POST /login`에 회사 코드(company code) 필드를 요구하기 시작한 것을 발견해(로그인 재시도 2회 동일 응답 확인, 무해한 후보값 4개로 성격만 확인하고 실제 값 추측은 중단) 라이브 검증이 막혀 있었음 — 사용자가 "회사 코드 알려주겠음"이라 답했으나 아직 전달 전.
- 2026-07-21: 사용자가 "첫 로그인 화면으로도 이동이 안 되는 등 실행이 안 되는 것 같다"고 보고. Swift 컴파일러가 없는 이 환경에서 새로 추가된 파일 전체(`KPIApprovalView`/`EmployeeDetailView`/`SalesInventoryView`/`APIClient`/`HRDataStore`/`AppSection`/`SidebarRootView`/`ERPHubView`)를 한 줄씩 재검토하고 전체 파일 중괄호·괄호 balance를 스크립트로 재확인했으나 컴파일 에러 후보를 전혀 찾지 못함 — 반면 `LoginView.swift`에는 애초에 회사 코드 입력란 자체가 없어서, 위 항목에서 발견한 "서버가 회사 코드를 요구하기 시작함" 문제와 겹쳐 **모든 로그인 시도가 실패해 로그인 화면을 벗어나지 못하는 것**이 "실행이 안 된다"는 증상의 실제 원인으로 결론. `AppSettings`에 `companyCode`(서버 주소처럼 UserDefaults에 영속 저장) 추가, `APIClient.login()`/`SessionStore.login()`에 `companyCode` 파라미터 추가(값이 있을 때만 JSON 바디의 `companyCode` 키로 실어 보냄), `LoginView`·`SettingsView`에 "회사 코드" 입력란 추가(로그인 폼 필수 항목화). 실제 서버가 기대하는 JSON 키 이름은 이 저장소의 `server.js`(및 배포 브랜치 `claude/mobile-hr-app-testing-rDc2F`)에 해당 필드가 아직 반영되어 있지 않아 코드로 직접 확인하지 못했다 — `companyCode`는 관례적인 추정값이며, 실제 키 이름이 다르면 `APIClient.swift`의 `body["companyCode"]` 한 줄만 고치면 된다는 점을 README에 명시. 사용자가 회사 코드 값을 전달하면 이 필드로 입력해 실제 로그인·이후 라이브 검증(KPI 평가·견적서/발주서 상태 전이·직원 관리 확장 3개 기능 포함)을 진행할 예정.
- 2026-07-22: 사용자가 회사 코드 후보(`thiraurtech`→`thirautech`→`tirautech`)와 계정 2세트를 순서대로 알려줘 실제 프로덕션 서버에 curl로 로그인 테스트. 정확한 철자는 `tirautech`였고 admin/admin으로 로그인 성공, `GET /data`로 직원 262명 규모의 실제 회사 데이터까지 확인 — `companyCode` 필드명 추정이 맞았음도 이걸로 검증됨(클라이언트 추가 수정 불필요). 동시에 사용자가 준 두 번째 계정(회사 코드 `test`/admin/admin1234, 오늘 새로 만들어진 직원 1명짜리 회사)으로도 로그인해 두 회사의 `GET /data`를 비교하다가 멀티테넌시 데이터 격리 버그를 발견: `employees`/`attendanceRecords`/`approvalDocs`는 회사별로 정상 분리됐지만 `payrollAdjustments`·`boardPosts`·`roomReservations`는 두 회사에서 완전히 동일한 레코드가 내려옴(직원 1명뿐인 `test` 회사 계정으로 `tirautech`의 급여조정·게시판·회의실 예약 데이터가 그대로 조회됨) — 서버(DB) 쪽 컬렉션별 회사 필터링 누락이 원인으로 보이는 신규 발견 사항이며 클라이언트에서 고칠 수 없어 README "알려진 한계"에 추가.
- 2026-07-22: 사용자 요청("회사 전환/신규가입/로그인 시 이전 세션의 로컬 캐시를 완전히 초기화한 뒤 새 회사 세션을 시작하도록 클라이언트 코드 수정") — 위 멀티테넌시 격리 버그를 목격한 직후, 서버 버그와는 별개로 클라이언트에서도 방어적 조치를 추가해달라는 요청. `HRDataStore`는 로그인/로그아웃마다 `MainTabView`/`SidebarRootView`가 SwiftUI에 의해 통째로 재생성되면서 사실상 매번 새 인스턴스로 시작하지만(뷰 트리 조건 분기가 바뀔 때의 암묵적 보장), 나중에 성능상 이유로 앱 전역 공유 인스턴스로 리팩터링하면 조용히 깨질 수 있는 가정이라 이를 명시적으로 보장하도록 수정. `HRDataStore`에 `loadedToken`(직전에 데이터를 불러온 토큰)과 `generation`(리셋마다 증가하는 카운터)을 추가 — `reload()`가 현재 세션 토큰이 직전과 다르면(로그아웃 후 재로그인은 같은 계정이어도 토큰이 매번 새로 발급되어 반드시 다름) `reset()`으로 `raw`(직원목록·예약·게시글 등 서버가 내려준 모든 배열)·버전·에러 상태를 전부 비운 뒤 새 데이터를 받아오고, `reload()`/`save()` 양쪽 모두 응답이 도착했을 때 그 요청을 시작한 시점의 `generation`과 현재 `generation`을 대조해 다르면(그 사이 세션이 바뀌었다는 뜻) 응답을 버리도록 해 "로그아웃 직전에 시작된 요청이 새 회사 로그인 이후 도착해 새 세션 데이터를 이전 회사 값으로 덮어쓰는" 경쟁 상태까지 막았다. 단순 새로고침(토큰 불변)은 이 경로를 안 타 화면 깜빡임도 없음. 이 앱에는 회원가입(신규 회사 생성) 화면 자체가 없어 그 시나리오는 해당 없음을 README에 명시.
