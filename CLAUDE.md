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
