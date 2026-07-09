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
- 2026-07-07: DB를 Railway 로컬 SQLite → Turso 클라우드 DB(무료, SQLite 호환)로 이전 — `memory.py`가 `TURSO_DATABASE_URL`+`TURSO_AUTH_TOKEN` 설정 시 Turso HTTP API(/v2/pipeline)를 순수 Python urllib로 호출(Rust 빌드가 필요한 libsql-experimental은 Render 빌드 실패로 제거), 미설정 시 기존 로컬 SQLite로 자동 전환. 배포도 Render.com 무료 웹서비스(https://ai-assist-aosk.onrender.com)로 이전(Railway $5 플랜 해지). Railway 기존 데이터 934건(학습지식 921·대화 8·피드백 4·설정 1)을 `migrate_to_turso.py` + `/admin/import-db` 엔드포인트로 무손실 이관 완료. Render 무료 티어는 15분 비활성 시 절전(첫 접속 30~60초 웨이크업) — 필요 시 UptimeRobot 등 무료 핑으로 상시 유지 가능. 같은 날 `UnboundLocalError`(law_results/results 미초기화 참조) 수정
- 2026-07-07: 의도 분석 에이전트(`intent_agent.py`) 신설 — `/chat` 0.5단계에서 질문 의도를 LLM으로 분석해 (1) 검색 최적화 정제 질의 생성: KB 매칭 점수가 원본 질의보다 높거나 같을 때만 채택하는 게이트로 회귀 방지, 채택 시 법령/웹 검색에도 동일 질의 적용, (2) 의도·답변요건(`format_intent_context`)을 LLM 컨텍스트 지시문 앞에 주입(주식/비주식 경로 모두)해 질문 의도에 맞춘 답변 유도. 분석 실패·타임아웃(8초, `INTENT_TIMEOUT`) 시 원본 질의 그대로 사용해 기존 동작 완전 유지, `INTENT_AGENT=off`로 비활성화 가능. 직접 계산(CALC) 경로(지연 불필요)와 company 페르소나(사내 문서 전용·외부 LLM 미사용 정책)는 분석 제외
- 2026-07-07: 연차 계산기 기준일 파싱 + 취업규칙 KB 연동 + 계산기 전체 QA. (1) `try_annual_leave_calc()`가 질문 속 기준일("24년 1월 1일 입사자는 26년 1월 1일에 몇 개?")을 무시하고 항상 오늘 기준으로 계산하던 버그 수정 — `_parse_all_dates()` 신설로 다중 날짜 추출, '입사' 키워드 인접성으로 입사일 판별, 나머지 중 가장 늦은 날짜를 기준일로 사용(기준일<입사일이면 경고, 미래 가정 질문도 계산 가능). (2) 계산 결과의 "회사 취업규칙 확인 권장" 고정 문구를 실제 KB 연동으로 대체 — `main.py`의 `_company_rule_supplement()`가 company 페르소나 KB에서 관련 규정 검색(유사도≥0.15), 있으면 규정 본문+출처 표시, 없으면 연차 계산에 한해 일반 안내 문구. (3) QA로 같은 부류 오류 2건 추가 발견·수정: `try_min_wage_check()`도 질문 속 연도("2024년 시급 9900원 위반?")를 무시하고 현재 연도로 판정하던 버그(`_question_year_min_wage()` 신설, 데이터 밖 연도는 None 반환해 KB/LLM 경로로), `_parse_amount()`의 순수 숫자 fallback이 "2024년"의 2024를 금액으로 오인하던 버그(년/월/일 뒤따르는 숫자 제외). 실수령액·4대보험 계산 제목의 "{현재연도}년 기준" 표기도 실제 요율 연도인 "2024년 요율 기준"으로 정직하게 수정. QA 테스트 28건 전체 통과 확인
- 2026-07-07: 복수 계산 의도 종합 응답 — `try_any_calc()` 디스패처를 "첫 매칭 반환"에서 "전체 의도 수집 후 종합"으로 변경. 계산기를 7개 그룹으로 분류(`_CALC_GROUPS`, 같은 그룹 내에서는 첫 매칭만 — 기간연차/단일연차처럼 동일 주제 대체 계산기 중복 방지), 서로 다른 그룹이 2개 이상 매칭되면 "📊 종합 계산 결과" 헤더에 인식된 의도 목록을 표시하고 각 계산 결과를 구분선으로 결합(예: "퇴직금이랑 연차 알려줘" → 연차+퇴직금 두 섹션, 연차 기준일은 퇴직일로 자동 적용). 단일 매칭은 기존 그대로 반환해 회귀 없음. QA 38건 전체 통과
- 2026-07-08: OpenCode 연계 — (1) `llm.py` 폴백 체인에 OpenCode Zen(무료 모델 게이트웨이, OpenAI 호환 https://opencode.ai/zen/v1) 추가: `OPENCODE_ZEN_API_KEY` 설정 시 Claude 다음 2순위로 동작, 기본 모델 `deepseek-v4-flash-free`(환경변수 `ZEN_MODEL`), 모델 종료(404) 시 나머지 무료 모델 4종(`nemotron-3-ultra-free` 등)으로 자동 재시도. 무료 모델 ID 5종은 Zen API 실측으로 확인. (2) 레포 루트에 `opencode.json`(무료 모델 기본 + CLAUDE.md instructions 자동 로드)·`AGENTS.md`(에이전트 작업 규칙 요약) 추가로 OpenCode 코딩 에이전트로 유료 API 없이 이 레포 개발 가능. 상세 가이드 `ai/OPENCODE_GUIDE.md`
- 2026-07-08: KB 오답 학습(오염) 문제 해결 — "출장 규정 알려줘"에 "직장 내 괴롭힘" 답변이 나오던 원인은 과거 오답이 자동학습(source='자동학습')으로 KB에 저장되어 동일 질문 재질의 시 높은 유사도로 직접 서빙되는 구조(정적 KB·토크나이저는 정상임을 로컬 재현으로 확인, '출장'≠'직장' 토큰 분리 정상). 3중 수정: (1) `memory.topic_overlap()` 모듈 승격(retrieve_best 내부 중복 제거) 후 `auto_learn()`에 품질 게이트 4 추가 — 질문 핵심 단어가 답변에 전혀 없으면 주제 불일치로 저장 차단(오염 원천 방지), (2) `retrieve_best()`가 `top_source` 반환, main.py에서 자동학습/대화 출처 항목이 주제 불일치면 KB 직접 서빙을 LLM 재생성으로 강등(기존 오염 항목 노출 방지), (3) `GET /admin/learned?q=키워드`(검색)·`DELETE /admin/learned/{id}`(삭제+엔진 즉시 반영) 관리 API 신설(오염 항목 수동 정리). 추가 발견: `backup.py`가 로컬 SQLite 파일만 덤프해 Turso 이전 후 백업이 빈 ZIP이 되던 버그 — `mem._conn()` 경유로 재작성해 Turso/로컬 모두 실데이터 백업(sqlite_master DDL + INSERT 덤프 생성)
- 2026-07-08: KRX 계정 연동 완료(data.krx.co.kr 무료 회원가입 + Render `KRX_ID`/`KRX_PW` 환경변수) — pykrx 1.2.8부터 일부 API가 로그인을 요구하게 된 것이 "KRX 로그인 실패" 경고의 원인이었음(기능 자체는 `krx_client.py`/`popular_stocks.py`의 네이버 폴백으로 계속 정상 동작 중이었음). 로그인 성공 확인. 같은 날 별도로 `[claude] HTTP 400 오류` 로그의 실제 원인 파악 시도 중 로깅 버그 발견·수정 — `llm.py`의 `_claude_stream`/`_openai_compat_stream`/`_gemini_once`가 `httpx` 스트리밍 응답에 대해 본문을 읽지 않은 채 `raise_for_status()`를 호출해, 예외 처리부의 `e.response.text` 접근이 `ResponseNotRead`로 실패하고 `str(예외)`("Client error '400 Bad Request'...")만 로그에 찍혀 실제 API 오류 사유(예: 크레딧 소진, 잘못된 요청 필드 등)를 알 수 없었음. 세 함수 모두 `raise_for_status()` 전에 `await resp.aread()`로 본문을 먼저 읽도록 수정해 다음 발생 시 실제 오류 메시지가 로그에 남도록 함
- 2026-07-08: 예산관리(`budget_store.py`) 데이터 유실 문제 발견·수정 — Turso 이전 시 `budget_store.py`는 마이그레이션 대상에서 누락되어 있었음. `BUDGET_FILE = os.path.dirname(mem.DB_PATH)/budget-data.json` 형태로 로컬 파일에 저장하는 구조였는데, Railway에서는 `DB_PATH=/app/data/memory.db`가 영속 볼륨 안에 있어 우연히 함께 보존됐지만, Render+Turso 전환 후에는 `DB_PATH` 환경변수를 없애 로컬 파일 경로가 컨테이너 임시 파일시스템(`ai/data/`)으로 떨어지면서 재배포마다 초기화되고 있었음(실제로 재배포 후 `/budget/data`가 빈 상태로 확인됨). Railway 앱이 아직 살아있어 `/budget/sheets`로 원본 데이터(급여RAW 240행, 급여 자료 정리 30행) 백업 후 Render로 이관 완료. 재발 방지: `read_budget()`/`write_budget()`을 로컬 파일 I/O에서 `mem.get_setting()`/`mem.save_setting()`(app_settings 테이블, Turso/SQLite 공용 경유)으로 변경해 대화·학습 데이터와 동일하게 DB에 영속 저장되도록 수정. 코드 변경으로 저장 위치가 바뀌므로 배포 후 Railway 데이터 1회 재이관 필요
- 2026-07-08: "출장 규정 확인해줘" 등 질의 시 화면에 `<!DOCTYPE html>...`로 시작하는 원본 HTML이 그대로 노출되던 문제 진단·수정 — KB 오염이 아니라 프론트엔드 오류 처리 버그였음(운영 KB `/admin/learned` 검색으로 해당 내용이 DB에 없음을 확인해 KB 원인 배제). `index.html`의 `sendMessage()`가 `if (!resp.ok) throw new Error(await resp.text())` 구조라, Render 재배포·콜드스타트 중 프록시가 반환하는 502/503 HTML 오류 페이지 본문을 그대로 에러 메시지로 사용해 채팅창에 원문이 그대로 찍히고 있었음. `friendlyErrorMessage()` 헬퍼 신설 — 502/503/504는 "서버 일시 응답 없음, 잠시 후 재시도" 안내로, JSON 오류는 `detail` 필드만 추출, 그 외 HTML 시작 응답은 원문 노출 없이 상태 코드만 표시하도록 수정. 이력서 분석(`/analyze/resume`) 등 다른 fetch 경로는 이미 `.json().catch()` 패턴으로 안전하게 처리되어 있어 추가 수정 불필요했음
- 2026-07-08: "출장 규정 확인해줘"가 회사 실제 규정과 다르게 나오는 문제 진단·수정. 원인 3가지: (1) Railway→Turso 마이그레이션 시 `kb_static_index`(정적 KB 중복방지 해시 테이블)가 이관 대상에서 제외되어 있어, Render 최초 기동 시 `_seed_static_kb_to_db()`가 기존 해시를 못 찾고 company 페르소나 정적 KB 73개 항목 전체를 중복 저장(총 146개, id 760~832가 750~1698의 중복) — `/admin/learned`로 전수 조사 후 중복 73건 삭제. (2) 오늘 QA 테스트 중 "출장 규정 알려줘"를 hr 페르소나로 여러 차례 호출한 것이 자동학습되어(LLM이 지어낸 가상의 수치가 포함된 답변, source='자동학습') 이후 같은 질문에 오답이 직접 서빙되던 문제 — 해당 2건(id 1796, 1797) 삭제. (3) 근본 구조적 원인: `personas.py`의 `_AUTO_CLASSIFY_KEYWORDS["hr"]` 목록에 "출장" 키워드가 없어 매칭되는 페르소나가 없으면 기본값 `hr`로 라우팅되고, `company`는 "명시적 선택 필요"라는 이유로 자동분류 후보에서 원천 제외되어 있어 사내 실제 규정(company KB에 정확히 존재: 출장일비 국내 1급지 30,000원 등)에 닿지 못하고 hr 페르소나의 낮은 KB 점수로 인한 자동 웹검색이 "공무원 여비규정"(정부기관용, 전혀 다른 규정)을 가져와 답변하고 있었음. 사용자에게 자동 라우팅 개선 여부를 확인 후(권장안 선택) `main.py`에 company KB 우선 라우팅 로직 추가 — `req.persona=="auto"`이고 라우팅된 페르소나가 company가 아닐 때, company KB 매칭 점수가 현재 페르소나 점수보다 높고 0.15 이상이면 company로 전환(페르소나·시스템프롬프트·KB 컨텍스트 전부 재계산). 회사 KB에 명백히 더 정확한 답이 있을 때만 전환되도록 임계값을 두어 오탐 최소화
- 2026-07-08: "출장비 신청 어떻게 해?" 재현 조사 중 정적 KB 자체에 근거 없는 구체적 수치(임원 숙박비 15만원 한도, 일비 3만원 등)가 하드코딩되어 있는 것을 발견 — `knowledge_hr_gaps.py`의 "원거리 출장비" 항목이 실제 출처 없이 "공무원 여비 기준이 민간 기업 벤치마크로 활용됨"이라 서술하며 구체적 금액을 사실처럼 제시하고 있었음. 항목 구성(교통비/숙박비/일비/식비 카테고리)만 남기고 특정 금액·직급별 표는 제거, "회사마다 다르며 반드시 소속 회사 취업규칙을 확인하라"는 명시적 경고문 추가. 근본 원인 추가 발견: Turso 이관 시 `kb_static_index`(중복방지 해시 테이블)가 이관 대상에서 제외되어 있던 문제가 company 페르소나(73건)뿐 아니라 hr/dev/travel 등 전 페르소나 정적 KB에도 동일하게 영향을 미쳐 대규모 중복이 남아있었음 — 관리 API `GET /admin/learned?offset=`(페이지네이션), `GET/POST /admin/learned/duplicates?apply=true`(전체 content 완전일치 중복 탐지·일괄삭제, 가장 오래된 항목만 보존) 신설로 전 페르소나 전수 정리 가능하도록 함. `migrate_to_turso.py`의 `_TABLES`에도 `kb_static_index`를 추가해 향후 재이관 시 동일 문제 재발 방지
- 2026-07-08: 공유 링크(URL 기반 부분 공개) 기능 신설 — 소유자가 특정 페르소나만 선택해 공유 링크를 발급하면, 링크를 받은 사람은 로그인 없이 해당 페르소나로만 채팅 가능(예산관리·백업·학습관리 등 관리 기능은 접근 불가). `memory.py`에 `share_links` 테이블(token/personas(JSON)/enabled/expires_at) 및 `create_share_link`/`get_share_link`/`list_share_links`/`revoke_share_link` 추가. API: `POST/GET /admin/share`(생성/목록, 소유자용), `DELETE /admin/share/{token}`(폐기), `GET /share/{token}`(공개, 링크 유효성+허용 페르소나 확인용). `/chat`에 `share_token` 필드 추가 — 유효하지 않거나 허용되지 않은 페르소나 요청은 403, `auto` 모드는 허용된 페르소나 교집합으로 자동 제한. 기존 "company KB 우선 라우팅" 로직도 공유 링크가 company를 명시적으로 허용한 경우에만 동작하도록 가드 추가(권한 범위 밖 페르소나로 우회 전환되는 것 방지). 프론트엔드(`index.html`): `?share=TOKEN` URL 파라미터 감지 시 `/share/{token}`으로 유효성 확인 후 허용된 페르소나만 노출하고 소유자 전용 UI(예산관리 탭, 공유 링크 관리 버튼) 숨김, 무효/만료 링크는 안내 메시지 표시. 소유자는 페르소나 상단바의 "🔗 공유 링크" 버튼으로 링크 생성·목록·복사·삭제 가능한 모달 사용
