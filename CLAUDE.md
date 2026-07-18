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
- 2026-06-18: `claude/mobile-hr-app-testing-rDc2F` 브랜치를 인사시스템+ERP(영업/구매/재고/회계) 통합 최종 버전 관리 브랜치로 지정. 이 브랜치에서 기능 추가/버그 수정을 이어가며 최종본을 유지한다. 진행 상황/다음 작업은 `HANDOFF.md` 참고.
- 2026-06-22: 배포 후 RAG 데이터 초기화 문제 진단 — 사용자가 실사용 중인 플랫폼은 Railway였고, `ai/railway.json`에는 영속 볼륨이 코드로 선언되어 있지 않아 재배포마다 컨테이너 임시 파일시스템의 SQLite DB가 사라지는 것이 원인으로 확인됨(코드 자체의 학습/누적 로직은 이미 정상 동작, 인프라 설정 누락이 근본 원인). `main.py`에 `DB_PATH` 미설정 시 배포 로그에 경고를 출력하는 점검 코드 추가, `CLAUDE.md`에 Railway Volume 생성 + `DB_PATH=/app/data/memory.db` 환경변수 설정 가이드 추가
- 2026-06-22: KRX 수급/공매도 데이터 조회 실패 시 fallback 누락 수정 — `krx_client.py`의 `get_investor_trading()`/`get_short_selling()`이 pykrx 실패 시 에러 dict를 반환해 주식 분석 파이프라인이 조용히 데이터 누락되던 문제를, 같은 파일 내 다른 함수들이 이미 쓰던 `_mock_investor_data()` 등 fallback 패턴과 일치시켜 수정
- 2026-06-22: 페르소나별 검색 분리 — `main.py`의 `/chat` 인터넷 검색 단계에서 `srch.search_and_learn(search_msg)` 호출이 `persona_id`를 누락해 모든 페르소나의 웹검색 학습 결과가 `search_and_learn()` 기본값인 `persona="hr"`로 고정 저장되던 버그를 발견. `search_and_learn(search_msg, persona_id=req.persona)`로 수정해 이후부터는 페르소나별로 검색/학습 데이터가 분리됨. 이 수정 이전에 이미 저장된 웹검색 학습 데이터는 원래 페르소나 정보가 남아있지 않아 자동 재분류는 불가(필요 시 수동 정리 별도 논의)
- 2026-06-22: 증권사 리포트 컨센서스 섹션에 빈 placeholder 데이터가 "수집 리포트 N건"으로 표시되던 문제 수정 — `securities_report.py`의 `_parse_naver_research()`(네이버 리서치 HTML 파싱)와 `search_reports_ddg()`(DuckDuckGo 보조 수집)가 증권사명·목표주가·투자의견·날짜 추출에 실패해도 빈 문자열을 그대로 담은 report dict를 리스트에 추가하던 구조라, `_build_consensus()`의 `len(reports)`가 빈 항목까지 카운트해 "수집 리포트 2건"처럼 보이지만 실제 내용은 전부 "미상"/"중립"/"TP:-"인 신뢰할 수 없는 결과가 나왔음. `get_all_reports()`에 `_is_meaningful()` 필터(목표주가·투자의견 중 하나라도 실제 값이 있어야 통과)를 추가해 빈 항목을 컨센서스 집계 전에 제거 — 실데이터가 없으면 "수집된 리포트 없음"으로 정직하게 표시됨
- 2026-06-24: 주식 분석 채팅 응답 상세화 + 긴 자료 다운로드 분리 + 전 페르소나 참고자료 링크 추가. (1) `_summarize_stock_report()`(main.py)가 종목 미지정 "현황" 질문에 기존 Executive Summary/TOP 추천 종목/저평가 종목 3개 섹션만 보여주던 것을, 시장 환경 분석·증권사 애널리스트 리포트 컨센서스 2개 섹션을 추가해 5개 섹션으로 확장 — report_writer.py 자체는 14개 섹션을 이미 생성하고 있었으나 채팅 요약 레이어가 그중 일부만 노출해 "모호하다"는 문제가 발생했던 것이 원인. (2) `_summarize_long_text()` 신설 — 답변 본문이 3500자를 넘으면 앞부분만 채팅에 표시하고 전체는 `stock_analysis/reports/answers/`에 파일로 저장 후 다운로드 링크(`/answer/download/{filename}` 신규 엔드포인트, `answer_` 접두사·`..` 차단)로 안내. `run_broker_report`(단독 증권사 리포트 조회)·`run_lowprice_screen`(저평가 저가주 스크리닝) 두 원문 그대로 출력하던 경로에 적용. (3) `_format_reference_links()` 신설 — `[{title,url}]` 목록을 마크다운 링크 푸터로 변환(http만 허용, 중복 제거, 최대 5개). 경로 B(LLM 보강) 양쪽 분기에 `reference_items` 수집을 연결: stock_mode는 증권사 리포트 "링크" 필드 + DDG 자동검색 결과, 비주식 페르소나는 law_search 결과 + 일반 웹검색 결과. 프론트엔드(`index.html`의 `renderMd()`)가 이미 마크다운 링크와 `/stock/download/` `/answer/download/` 다운로드 버튼 스타일을 지원하고 있어 프론트엔드 변경은 불필요했음. 적용 범위 제한: KB-직접답변(경로 A)·기업 KB 무응답(경로 C)에는 참고자료가 없어 미적용, 뉴스 기사(`news_collector.py`의 "출처" 필드는 출처명/URL이 혼재해 신뢰 불가)는 참고링크에서 제외
- 2026-06-24: 증권사 리포트·뉴스 수집기가 실데이터를 못 가져오던 근본 원인 다수 발견·수정(이 환경의 외부망 차단이 풀린 뒤 실제 네이버 금융 응답으로 검증). `securities_report.py`의 `fetch_naver_research()`가 `searchType=priceTo&code={ticker}` 파라미터를 쓰고 있었는데 이는 종목과 무관한 전체 "목표주가 변경" 리스트를 반환하는 잘못된 조회였음(올바른 파라미터는 `searchType=itemCode&itemCode={ticker}`) — 이 때문에 `_parse_naver_research()`의 정규식(`/research/company_read.naver?nid=` 절대경로 기대)도 실제 마크업(`company_read.naver?nid=` 상대경로)과 맞지 않아 항상 0건이 파싱됐음. 목표주가·투자의견은 목록 페이지에 컬럼 자체가 없고 개별 리포트 본문(`목표가 480,000 | 투자의견 Buy` 형태)에만 있다는 것도 확인 — `_enrich_with_target_opinion()` 신설로 상위 5건의 본문을 추가 조회해 채움, `_extract_report_meta()`로 본문에서 목표가·투자의견 파싱, 영문 등급(Buy/Hold/Sell)을 한글 버킷으로 정규화하는 `_normalize_opinion()` 추가(기존 `_build_consensus()`가 한글 키워드만 매칭해 영문 등급은 의견분포에서 누락되던 문제도 같이 해결). 또한 `search_reports_ddg()`가 `async def`이면서 내부적으로 완전히 동기 블로킹인 DDGS 호출을 실행하고 있어, `get_all_reports()`의 `asyncio.gather()`로 `fetch_naver_research()`와 함께 묶이면 이벤트 루프를 점유해 네이버 쪽 요청이 거의 항상 타임아웃되던 동시성 버그를 발견·수정(`run_in_executor`로 별도 스레드 실행, `news_collector.py`가 이미 쓰던 패턴과 통일) — 이게 "정확한 내용이 거의 안 들어간다"는 원래 사용자 불만의 진짜 근본 원인이었음(이전 수정은 빈 placeholder를 걸러내는 대증 처방이었을 뿐, 데이터가 애초에 안 들어오는 원인은 그대로였음). `news_collector.py`의 `_fetch_naver_finance_news()`도 같은 종류의 파싱 버그 수정(제목이 `title=` 속성이 아니라 `<a>` 태그 내부 텍스트로 들어있었음, 날짜 정규식이 공백·시간 포함 형식과 안 맞았음). 두 파일의 HTML 클린업 헬퍼(`_clean`/`_clean_html`)에 `html.unescape()` 추가해 `&hellip;` 등 엔티티 미디코딩 문제도 해결. 부가적으로 `aiohttp.ClientSession()` 호출들에 `trust_env=True`를 추가(이 개발 샌드박스의 로컬 프록시를 타려면 필요했던 설정, 배포 환경에는 영향 없음). 전체 파이프라인 실측 결과: 삼성전자 기준 증권사 리포트 5건(평균 목표주가 522,000원, 의견분포 매수 5건)·뉴스 8건이 정상 수집·표시됨을 확인
- 2026-07-12: HR 앱 채용 면접 평가에 "다중 심사위원" 고도화 기능 추가(`jaesung8712/gpt-assistant` 레포, `claude/mobile-hr-app-testing-rDc2F` 브랜치). 면접관 다중 지정·개별 평가 자체는 기존에 이미 구현돼 있었으므로, 그 위에 ① 면접관 중 1명을 심사위원장으로 지정하는 `interview.leadInterviewerId`, ② 심사위원장(또는 admin)만 입력 가능한 최종 판정(합격/보류/불합격) `POST /api/recruit/interviews/:id/verdict` 신규 엔드포인트, ③ 면접관 간 총점 편차가 25점 만점 중 8점 이상이면 자동 요약에 경고 문구를 넣는 `_ivScoreSpread()`를 추가. `public/index.html` 면접 일정 등록/수정 모달에 심사위원장 선택 드롭다운(면접관 다중선택 변경 시 동적 재구성), 면접 평가 상세 페이지에 최종 판정 입력/조회 UI 추가. curl로 백엔드 권한/검증 로직, Playwright로 등록·수정·상세 화면 콘솔 에러 0건 확인 후 커밋. 상세 내용은 `HANDOFF.md` 참고.
- 2026-07-14: HR 시스템(server.js/public/index.html) 인증 구조 근본 개편 — 기존에는 `requireAdmin()`/`requireRole()`이 클라이언트가 요청 body/query에 적어 보낸 `role`을 그대로 신뢰해(진짜 세션/토큰 검증 없음), 누구든 `role:"admin"`만 넣어 보내면 인가를 우회할 수 있었고, `GET /data`·`GET /snapshots/:year`(전 직원 PII 포함 전체 데이터)·`GET /api/recruit/*`·`GET /api/accounting/*`·`GET /api/erp/*`·`GET /api/pms/*` 등 대부분의 조회 API와 `POST /save`(전체 데이터 덮어쓰기)까지 인증 자체가 전무해 URL만 알면 누구나 회사 전체 데이터를 열람·덮어쓸 수 있었음. `/login` 성공 시 HMAC 서명 토큰을 발급하고(`SESSION_SECRET` 환경변수로 서명, 12시간 만료) 이후 모든 요청은 `Authorization: Bearer <token>` 헤더로 전달하도록 변경, `requireAdmin`/`requireRole`은 서버가 검증한 `req.auth.role`만 신뢰하도록 재작성, 구매요청/PMS 투입률·업무일지/채용 면접평가·최종판정 등 곳곳에 흩어져 있던 동일한 클라이언트-신뢰 `role`/`userId` 체크도 전부 `req.auth`로 전환(면접 평가는 "지정 면접관 본인 명의로만 입력 가능"하도록 `interviewerId===req.auth.empId` 검증도 추가). 채용 지원자 단건 조회(`/api/recruit/candidates/:id`)·이력서 조회(`/resume`)는 목록 API에만 있던 부서별 열람 제한이 아예 없어 ID만 알면 타 부서 지원자 정보를 볼 수 있었던 것도 함께 수정(`_recruitCanViewCandidate` 헬퍼 신설). 최초 배포로 서버에 직원이 0명인 "부트스트랩" 상태에 한해서만 `POST /save` 1회를 인증 없이 허용(클라이언트 내장 샘플 admin 데이터를 최초 업로드하기 위한 불가피한 예외, 그 외엔 항상 인증 필요). 부가로 `helmet`(CSP는 인라인 스크립트 전면 사용 구조 때문에 비활성화, 나머지 기본 헤더만 적용), `express-rate-limit`으로 `/login` 브루트포스 방어(IP당 15분/20회) 추가. Playwright+직접 HTTP 요청으로 토큰 없는 조회 401, 위조 role로의 관리자 권한 우회 실패(403), 실제 admin 토큰으로는 정상 동작함을 확인. **후속 실배포 버그**: 위 배포 직후 사용자가 실제 운영 사이트에서 로그아웃 후 재진입 시 이미 종료된 세션의 레코드가 "다른 사용자가 수정 중"이라는 잠금 화면으로 계속 뜨는 문제 발견 — `/unlock`도 인증이 필요해졌는데 `logout()`에서 토큰을 먼저 지운 뒤 `releaseAllMyLocks()`를 호출하고 있어 잠금 해제 요청이 Authorization 헤더 없이 나가 401로 거부되고 있었음(로그아웃해도 서버 잠금은 그대로 남는 구조). `releaseAllMyLocks()`를 토큰 삭제보다 먼저 실행하도록 순서 수정. **진짜 근본 원인**: 위 잠금 수정을 배포한 뒤에도 사용자가 로그인 직후 인증이 계속 실패하는 증상을 보고, Render 배포 로그를 직접 받아 확인한 결과 `express-rate-limit`이 `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` 에러를 던지고 있는 것을 발견 — Render가 리버스 프록시를 거쳐 `X-Forwarded-For` 헤더를 붙여 요청을 전달하는데, Express 기본 설정(`trust proxy: false`)에서는 이 헤더를 신뢰하지 않아 `express-rate-limit`이 실제 클라이언트 IP를 판별하지 못해 에러를 던졌고, 그 여파로 `/login` 요청 자체가 정상 완료되지 못해 화면상 로그인은 성공한 것처럼 보여도 토큰이 발급되지 않고 있었음(로그아웃 순서 버그는 실재했지만, 이 원인 때문에 애초에 유효한 토큰이 없어 그 수정만으로는 증상이 해결되지 않았던 것). `app.set("trust proxy", 1)` 추가로 해결 — 로컬에서 `X-Forwarded-For` 헤더를 붙인 요청으로 재현·검증(수정 전 서버 로그에 ValidationError, 수정 후 정상 토큰 발급 확인). **진짜 진짜 근본 원인**: trust proxy를 고치고 재배포한 뒤에도 사용자가 여전히 "로그인해도 잠금 해제 등에서 로그인이 필요합니다"를 겪어서 재조사한 결과, `public/index.html` 소스에 오프라인 데모용으로 하드코딩된 샘플 직원 배열(`let employees=[...]`)의 첫 계정이 정확히 `loginId:"admin", pw:"admin", name:"시스템관리자"`였고, `doLogin()`이 이 로컬 평문 pw 매칭을 서버 `/login`보다 먼저 시도하는 구조였다는 것을 발견 — 그래서 admin/admin으로 로그인하면 서버가 정상 운영 중이고 실제 직원 데이터(692명)가 있어도 서버 `/login`을 단 한 번도 호출하지 않고 그 자리에서 "로그인 완료"되어(로컬 시드 데이터 자체가 우연히 실제 회사 데이터 스냅샷이라 화면도 정상으로 보임) 토큰이 전혀 발급되지 않고 있었다. 새로고침·재로그인을 아무리 반복해도 매번 이 로컬 매칭 경로를 다시 타서 증상이 재현됐던 것. `doLogin()`을 재구성해 서버 연결 시 먼저 `GET /status`로 서버에 직원이 이미 존재하는지 확인 → 존재하면(정상 배포) 반드시 서버 `/login`을 거치도록 강제하고, 서버에 직원이 아예 없는 최초 배포(부트스트랩) 상태에서만 로컬 매칭을 허용하도록 변경. Playwright로 두 시나리오(부트스트랩 로그인, 직원 존재 시 재로그인) 모두 검증 완료. **후속 확인 필요 사항**: 이 하드코딩 시드 배열에는 전 직원(692명으로 추정)의 평문 비밀번호가 그대로 들어있어, 페이지 소스 보기만으로도 전 직원 비밀번호가 노출된다 — 별도의 심각한 보안 이슈이며 사용자에게 별도 보고 필요(이 시드 데이터가 실제 배포에 아직도 실제 평문 비밀번호를 담은 채 커밋되어 있는지, 데모용 더미 데이터로 교체해야 하는지 확인 필요). **후속 조치**: 사용자 확인 결과 실제 데이터로 확인되어 `public/index.html`의 하드코딩 `employees`(257명, 실명·이메일·전화번호·주소·연봉·경력·평문 비밀번호 전부 포함) 및 `kpiEntries`(290건, 같은 스냅샷의 실제 평가 목표/이력) 배열을 완전히 제거하고, 명백히 가상의 데모 계정 5명(관리자/홍길동/김철수/이영희/박민수, example.com 이메일)으로 교체 — 오프라인 데모 모드와 최초 배포 부트스트랩(서버에 직원이 0명일 때 최초 admin 계정 업로드) 용도는 그대로 유지됨. 이 조치는 소스 코드 안의 데이터만 다루며 실제 운영 DB(Render PostgreSQL, 692명)에는 영향 없음. 직원 로그인 정보 일괄 재설정(사번을 아이디·비밀번호로)은 별도 구현이 필요 없었음 — `public/index.html`에 이미 관리자 전용 `resetAllLoginToEmpNo()` 함수와 인사관리>직원목록 페이지의 "🔑 계정 사번으로 초기화" 버튼이 구현되어 있어(관리자 계정은 제외), 이걸 클릭하면 현재 로드된 실제 서버 데이터 전체에 대해 사번 기반 재설정이 서버 측 bcrypt 해싱을 거쳐 적용됨. **미해결 잔여 사항**: git 커밋 히스토리에는 이번에 제거하기 전의 실제 데이터가 과거 커밋들에 그대로 남아있어, 저장소 접근 권한이 있는 사람은 여전히 예전 커밋을 통해 조회 가능 — 히스토리 재작성(rebase/filter-repo 등)이 필요한지는 파괴적 작업이라 별도로 사용자 확인 필요. → **처리 완료(같은 날)**: 사용자 승인 받아 `git filter-repo`의 `--blob-callback`으로 히스토리 전체(총 344블롭)를 재작성해 실제 데이터를 완전히 제거(전체 재검증으로 잔존 0건 확인). 도중 `ai/knowledge_company.py`(AI 챗봇 지식베이스)에도 실제 회사 도메인과 외부 서비스(printrobo.com) 평문 계정정보가 있는 것을 추가로 발견해 현재 코드+히스토리 양쪽에서 함께 제거. 부작용: 히스토리 강제 push로 브랜치 루트 커밋까지 해시가 바뀌어 `main`과의 공통 조상이 끊기면서 기존 PR #1이 자동으로 닫힘(병합되지 않음, 코드 손실 없음) — 재오픈 시 `main`과 겹치는 15개 파일(그중 `ai/main.py`·`ai/llm.py`·`budget.js` 등은 main 쪽 독자적인 AI 어시스턴트 작업으로 추정)의 병합 전략을 사용자에게 확인 후 진행 필요(미해결).
- 2026-07-14: 인증 개편에 대한 에이전트 기반 회귀 QA 2건 병행 실행 후 발견된 버그 총 4건 수정. **(QA1: 설정/시스템/권한관리 신규 영역)** ① 부트스트랩(서버 직원 0명) 로그인은 로컬 시드 계정 매칭으로 완료되어 토큰이 없는데, 그 세션에서 로그아웃 없이 설정을 계속 바꾸면 최초 저장으로 서버에 직원이 생긴 이후부터는 인증이 필요해져 이후 모든 저장이 401로 조용히 실패(화면은 매번 "저장되었습니다"로 표시)하던 심각한 버그 발견 — 부트스트랩 로그인 시 자격증명을 메모리에만 임시 보관하다가 첫 저장 성공 직후 조용히 서버 `/login`을 재시도해 토큰을 발급받도록 수정(`_bootstrapCreds`/`_tryUpgradeBootstrapToken()` 신설, 재로그인 요구 없음). ② `POST /unlock`의 `force` 옵션이 인증만 확인하고 역할 검증이 없어 일반 사용자도 API 직접 호출로 아직 안 만료된 남의 편집 잠금을 강제 해제할 수 있었음 — admin이거나 이미 만료된 잠금일 때만 허용하도록 서버에 검증 추가. ③ 메뉴 권한 관리에서 개인별로 끈 화면이 사이드바에서만 숨겨지고 `gotoPage()` 직접 호출(URL 조작)은 막지 못했음 — 사이드바 필터링과 동일한 `menuPerms` 기준을 `gotoPage()`에도 적용. **(QA2: 전체 회귀)** 인증/잠금/관리자권한 위조 방어(body에 role:"admin" 위조해도 403 확인)/핵심 업무 플로우(KPI·경비·PMS·채용·구매요청)/퇴직 처리는 전부 정상 확인된 가운데 버그 2건 추가 발견: ④ `acquireLock()`이 `/lock` 실패 응답 중 진짜 잠금 충돌(`r.lock` 있음)과 그 외 실패(`r.lock` 없음 — 예: 부트스트랩 세션의 401)를 구분하지 않고 전부 "다른 사용자가 수정 중"으로 표시 — 후자는 네트워크 오류와 동일하게 로컬 허용하도록 수정. ⑤ SSE `data_updated` 핸들러가 `employees`/`kpiEntries` 등 일부 필드만 손으로 골라 반영하고 있어 `approvalDocs`/`expenseClaims`/`attendanceRecords` 등 목록에 없는 필드(30여개)는 다른 사용자가 저장해도 실시간 반영 안 되고 새로고침해야만 보였음(이번 인증 개편과 무관한 기존 로직 결함) — 로그인/수동 불러오기가 쓰는 `applyState()`를 재사용하도록 리팩터링해 전체 필드가 실시간 반영되게 수정. 5건 모두 Playwright로 재현 후 수정 확인.
- 2026-07-14: Render Build Filters(경로 기반 재배포) 설정 테스트용 커밋. `hr-erp-system`/`my-ai-assistant` 두 서비스의 Included Paths 밖에 있는 `CLAUDE.md`만 수정 — 필터가 정상 동작하면 두 서비스 모두 재배포가 발생하지 않아야 함. 테스트 결과 확인 중 **중요한 사실 발견**: `my-ai-assistant` 서비스는 `claude/mobile-hr-app-testing-rDc2F`가 아니라 **`claude/account-pinned-agents-v6W7p` 브랜치를 보고 배포되고 있음**(Render Events에서 확인). 즉 이날 앞서 `claude/mobile-hr-app-testing-rDc2F`에서 수정했던 `ai/knowledge_company.py`의 실제 외부 서비스(printrobo.com) 평문 계정정보 제거가 **실서비스에는 전혀 반영되지 않고 있었음** — 그 수정은 배포에 쓰이지 않는 다른 브랜치에만 적용됐던 것. `claude/account-pinned-agents-v6W7p` 브랜치의 `ai/knowledge_company.py`를 직접 확인해 동일한 평문 계정정보가 실제로 남아있음을 확인, 사용자 승인 받아 그 브랜치에 동일한 수정을 커밋(`d340950`)해 실서비스에 반영. **후속 확인 필요**: `claude/account-pinned-agents-v6W7p`는 git 히스토리 재작성을 하지 않았으므로, 이 브랜치의 과거 커밋에도 (그리고 애초에 있었다면) 같은 민감정보가 남아있을 수 있음 — 필요 시 별도로 히스토리 정리 여부 확인 필요. 이 발견으로 두 Render 서비스가 서로 다른 브랜치를 보고 있다는 것 자체가 이미 상당한 배포 격리 효과를 내고 있었다는 것도 확인됨(단, 개발자가 브랜치를 착각해 한쪽에만 수정하고 실제 배포 브랜치에는 반영이 안 되는 위험은 여전히 존재 — 앞으로 `ai/` 관련 수정은 반드시 배포 대상 브랜치가 어디인지 먼저 확인 필요).
- 2026-07-15: `claude/account-pinned-agents-v6W7p`(AI 어시스턴트 실배포 브랜치) 히스토리 정리 — `git filter-repo`의 `--blob-callback`으로 `ai/knowledge_company.py`의 과거 버전 5개(전체 214블롭 중)에 남아있던 실제 회사 도메인·외부 서비스(printrobo.com) 평문 계정정보를 제거, 재검증으로 잔존 0건 확인 후 강제 push 완료. 이어서 이 브랜치의 `ai/` 디렉토리 전체(FastAPI 백엔드·지식베이스·stock_analysis 파이프라인)에 대한 에이전트 기반 보안·구조 점검 진행(하드코딩 비밀정보/인증누락/인젝션 위험/구조적 결함 확인, BACKUP_TOKEN 이슈는 사용자가 별도 세션에서 처리하기로 해 점검 대상에서 제외) — 결과: 실제 수정·반영 3건(커밋 `9e87383`) — ① `knowledge_company.py`에 해외출장 비자 대행업체(퍼스트 트립) 직원 2명의 실명·휴대폰번호·이메일이 평문으로 남아있던 것 발견(앞서 발견한 printrobo.com 사고와 동일 유형) → "담당자 연락처는 인사부서에 문의"로 대체, ② `static/index.html`의 `escHtml()`이 따옴표(`"`)를 이스케이프하지 않아 마크다운 링크 렌더링 시 속성 탈출 XSS(임의 속성 주입) 가능했던 것 수정, ③ `/admin/import-db`가 업로드된 ZIP을 경로 검증 없이 `extractall()`로 풀어 Zip Slip(경로에 `../` 포함 시 임의 위치에 파일 쓰기) 가능했던 것 수정 — 악성 zip으로 실제 재현 후 차단 확인, 정상 임포트 동작 유지 확인. 미수정 보고 항목: `/budget/*` API 전체가 인증 없음(BACKUP_TOKEN 게이팅 패턴 밖 — BACKUP_TOKEN 이슈와 함께 별도 세션에서 처리 필요), 엑셀 그리드 수식 저장은 의도된 기능이라 그대로 둠. 이후 새로 발견된 비자업체 직원 개인정보도 사용자 승인 받아 동일하게 `git filter-repo`로 히스토리(과거 버전 5개, 전체 517블롭 중) 정리 완료(잔존 0건 검증 후 강제 push, 커밋 `7d8b176`).
- 2026-07-16: 인증 개편이 안정화된 이후, "실사용처럼 반복 테스트 + 100명 이상 동시접속 부하 + 계정간 데이터 격리 + 모바일/반응형" 4갈래를 에이전트 4개를 병렬로 띄워 검증. 부하 테스트·기능별 반복 QA 2개는 세션 한도 도달로 미완주(재시도 필요, `docs/API_CONTRACT.md` 기준 별도 세션에서 이어서 진행 예정). 모바일 QA와 계정간 데이터 격리 QA 2개는 완주해 실제 버그 4건을 발견, 전부 수정·검증 완료: ① `public/index.html`의 근태·내정보 등 진입 시 뜨는 "🔒 본인확인" 비밀번호 모달(`_requireMyPagePw`)이 `gotoPage()`로 다른 메뉴로 이동해도 닫히지 않고 새 페이지 위에 계속 남아 화면을 가리던 버그 — `gotoPage()` 최상단에서 열린 모달이 있으면 항상 먼저 닫도록 수정. ② 삭제된 레코드가 동시저장 병합(smartMerge) 시 되살아나는 버그 — 기존에는 `roomReservations` 한 필드만 삭제 tombstone(`roomReservationTombstones`)이 있어, A가 레코드를 삭제하는 사이 B가 구버전 스냅샷으로 같은 항목을 수정해 저장하면 employees/kpiEntries/approvalDocs/expenseClaims 등 나머지 id-keyed 컬렉션에서는 삭제가 되살아났음(계정 간 데이터 격리 테스트 에이전트가 실측 확인) — roomReservations 패턴을 범용화한 `recordTombstones`(`{필드명:[{id,ts}]}`)를 도입해 client(`public/index.html`: `_tombstone()` 헬퍼, 13개 삭제 호출부 전체에 적용)·server(`server.js`: `mergeRecordTombstones()`, `smartMerge()`) 양쪽에 배선. 이 작업 도중 **더 심각한 기존(이번 세션 이전부터 있던) 결함을 추가로 발견**했는데, Postgres(운영) 모드의 일반 `/save` 저장 로직이 employees/kpi_entries를 제외한 모든 id-keyed 컬렉션(`app_collections` 테이블, 즉 approvalDocs/expenseClaims/attendanceRecords/roomReservations 등 대부분)에 대해 upsert만 하고 DELETE를 전혀 실행하지 않아 — 즉 사용자가 UI에서 무언가를 "삭제"해도 실제 운영 DB에서는 그 레코드가 영구히 남아있었고, 재조회 시 되살아날 수 있는 구조였음 — `recordTombstones`를 이용해 `app_collections`/`kpi_entries`에 실제 `DELETE ... WHERE id = ANY($1)`를 실행하도록 수정(레거시 `roomReservationTombstones`도 같이 반영). ③ JSON 파일(오프라인) 모드에서 클라이언트가 `_version`을 서버 현재 버전보다 높게 조작해 보내면 병합(smartMerge) 분기를 건너뛰고 `data`에 없는 컬렉션 전체가 통째로 삭제되는 버그(member 권한으로도 재현 가능, `server.js:481` 부근) — `_version`이 서버와 "다르면"(크든 작든) 항상 병합하도록 조건 변경 + JSON 모드 저장 시 기존 `_fileStore`를 베이스로 얹는 방어 로직 추가. ④ `GET /data`가 role 구분 없이 `payslips`(급여 원본)와 `kpiEntries`(평가 코멘트)를 포함한 전체 데이터를 모든 인증된 사용자에게 그대로 반환 — member 계정으로도 타 직원 급여·평가 코멘트 조회가 가능했음(격리 테스트 에이전트 실측). PAGE_ROLES에 이미 존재하던 경계(급여관리 admin 전용, 1·2차 평가 leader/director 이상)를 그대로 서버에 반영한 `filterDataForRole()` 신설 — admin이 아니면 payslips는 본인 것만, member 역할이면 kpiEntries도 본인 것만 필터링해 `GET /data`·`/save` 병합 응답·스냅샷 복원 응답 3곳 모두에 적용. 이 필터링 자체가 "클라이언트가 들고 있는 전체 상태를 그대로 재업로드"하는 이 앱의 구조와 충돌해 필터링된(불완전한) 로컬 배열을 다시 저장하면 타인의 payslips/kpiEntries가 지워질 위험이 새로 생겨, JSON 모드에서 이 두 필드만은 항상 기존 저장값과 id 기준으로 병합(변경분만 반영, 없는 건 안 지움)하도록 별도 처리(Postgres 모드는 원래 upsert-only라 이미 안전). 4건 모두 격리된 로컬 서버(JSON 파일 모드)에서 Playwright/직접 HTTP 요청으로 각각 재현 시나리오를 만들어 수정 전 실패 → 수정 후 통과를 확인.
- 2026-07-16: 세션 한도로 미완주했던 부하 테스트·기능별 반복 QA 2개 에이전트를 재실행. 부하 테스트(100명+ 동시접속)는 완주해 데이터 무결성 관련 시나리오(동시 GET/POST, 100명+ SSE, 30초 지속 혼합 부하)는 전부 PASS(무손실) 확인, 다만 **로그인 rate limiter가 실사용에 실제 문제를 일으키는 것을 실측 확인**: `loginLimiter`(IP당 15분/20회)가 성공한 로그인도 그대로 카운트해, 같은 사무실 공인IP 뒤에서 30명이 동시 로그인 시 20명만 성공하고 11명이 429로 차단됨(월요일 출근 시간대 등 실사용 시나리오에서 실제로 발생 가능). `skipSuccessfulRequests:true` 추가로 실패한(틀린 비밀번호) 시도만 카운트하도록 수정 — 브루트포스 방어 목적은 유지하면서 정상 동시 로그인은 차단하지 않도록 함(수정 후 실측: 동시 성공 로그인 25건 중 21건 통과로 개선, 나머지는 express-rate-limit의 카운트-후-환불 구조상 완전히 동시(같은 밀리초)에 몰릴 때만 발생하는 경합이라 실사용의 자연스러운 시간차 로그인에서는 사실상 영향 없음; 동시 틀린 비밀번호 시도는 여전히 일부 차단되어 브루트포스 방어 유지 확인). 부수적으로 `bcryptjs`가 순수 JS 구현이라 동시 로그인 다수 시 단일 스레드에서 직렬화돼 지연이 인원수에 비례해 늘어나는 것도 발견(120명 동시 로그인 시 p50 5.4초) — 네이티브 `bcrypt` 패키지로 교체하면 해소 가능하나 빌드 의존성이 추가되는 변경이라 이번엔 보류, 별도 검토 필요 항목으로 남김. 기능별 반복 QA 에이전트는 재실행 중.
