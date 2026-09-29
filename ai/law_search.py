"""
국가법령정보 Open API + DuckDuckGo 폴백 법령 검색

API 키 발급: https://open.law.go.kr (무료)
환경변수: LAW_API_KEY
"""
import asyncio
import os
import re
from datetime import date
import httpx
from ddgs import DDGS

LAW_API_KEY = os.getenv("LAW_API_KEY", "")
_API_BASE = "https://www.law.go.kr/DRF"
_TIMEOUT = 4.0  # 짧게 — 연결 안 되면 빠르게 포기

# 서킷브레이커: ConnectError 발생 시 일정 시간 API 호출 차단
import time as _time
_api_blocked_until: float = 0.0

def _is_api_blocked() -> bool:
    return _time.time() < _api_blocked_until

def _block_api(seconds: int = 3600):
    global _api_blocked_until
    _api_blocked_until = _time.time() + seconds
    print(f"⚠️ law.go.kr API 차단 (해외 IP 또는 네트워크 오류) — {seconds//60}분 후 재시도")

# 쿼리 축약명 → 법령정보 공식 검색어
_LAW_ALIAS_TO_SEARCH = {
    "근로기준법": "근로기준법",
    "퇴직급여법": "근로자퇴직급여 보장법",
    "퇴직급여보장법": "근로자퇴직급여 보장법",
    "근로자퇴직급여": "근로자퇴직급여 보장법",
    "일가정양립법": "남녀고용평등과 일·가정 양립 지원에 관한 법률",
    "남녀고용평등법": "남녀고용평등과 일·가정 양립 지원에 관한 법률",
    "육아휴직법": "남녀고용평등과 일·가정 양립 지원에 관한 법률",
    "최저임금법": "최저임금법",
    "기간제법": "기간제 및 단시간근로자 보호 등에 관한 법률",
    "기간제근로자": "기간제 및 단시간근로자 보호 등에 관한 법률",
    "산업안전보건법": "산업안전보건법",
    "고용보험법": "고용보험법",
    "산재보험법": "산업재해보상보험법",
}

# 법 관련 질문 감지 패턴
_LAW_DETECT = [
    r'제\s*\d+\s*조',                   # 조항 번호 명시 (근로기준법 제23조 등)
    r'(?<!\d)\d+\s*조(?!\d)',           # 숫자 + 조
    r'근로기준법|퇴직급여법|최저임금법|기간제법|산업안전보건법|고용보험법|남녀고용평등법|노동조합법',  # 법률 이름 직접 언급
    r'법률|법령|조항|조문|시행령|시행규칙',   # 법령 문서 명시 ("법률?"→"법률"로 수정, 사유는 아래)
    r'위반|처벌|과태료|형사처벌|손해배상',     # 법적 제재 (판례 단독 제외)
]
# ※ "판례" 단독은 법령 검색 트리거에서 제외:
#   "희망퇴직 판례", "야간수당 판례" 같은 일반 판례 질문은 KB가 직접 서빙
#   법령 API를 트리거하면 DDG에서 무관한 판례가 혼입되는 문제 방지

# 2026-09-11 발견(당시 미수정 기록), 2026-09-14 수정: 예전 `법률?` 패턴은 "률"만
# 선택적으로 만들어 사실상 "법" 단독 한 글자와 항상 매칭됐음 — 한국어에서 "법"은
# ① 법률의 준말("이 법이 있나요")과 ② "방법/~하는 법"의 의존명사(어떤 일을 하는
# 방식)로 완전히 다른 두 의미를 가지는데, 후자가 매우 흔한 일상 표현("이력서 잘
# 쓰는 법", "OO 사용법", "OO 계산법", "요리법")이라 법령과 무관한 질문까지 매번
# law.go.kr/DDG 법령 검색을 유발해 불필요한 지연(실측 24초)이 발생했음. "법"이
# 명사에 공백 없이 바로 붙는 경우("사용법"/"계산법"/"작성법" 등 개방형 방법-접미사)는
# 제외하고, "불법/합법/위법/탈법/준법/편법/무법"(닫힌 집합의 법 관련 합성어)만
# 예외로 인정한다. "법"이 공백/문장 시작 뒤에 독립된 단어로 오는 경우("이 법",
# "관련 법", "법에 따르면")는 법 질문으로 인정하되, 그 앞이 동사 관형형(~는/은/을/던)
# 뒤에 오는 "~하는 법" 구성(방법을 뜻하는 의존명사 용법)이면 제외한다.
_LAW_ADJACENT_COMPOUNDS_RE = re.compile(r'불법|합법|위법|탈법|준법|편법|무법')
_METHOD_SENSE_ENDING_RE = re.compile(r'[가-힣](?:는|은|을|던|았던|었던)\s+$')


def _has_bare_law_reference(text: str) -> bool:
    if _LAW_ADJACENT_COMPOUNDS_RE.search(text):
        return True
    for m in re.finditer(r'(?:^|\s)법(?!률|령)', text):
        prefix = text[:m.start()] + ' '
        if _METHOD_SENSE_ENDING_RE.search(prefix):
            continue  # "~하는/쓰는/만드는 법" — 방법을 뜻하는 의존명사 용법
        return True
    return False


def is_law_question(text: str) -> bool:
    return any(re.search(p, text) for p in _LAW_DETECT) or _has_bare_law_reference(text)


def _get_search_name(query: str) -> str:
    for alias, official in _LAW_ALIAS_TO_SEARCH.items():
        if alias in query:
            return official
    return query


def _extract_article_nums(query: str) -> list[str]:
    return re.findall(r'제?\s*(\d+)\s*조', query)


def _requested_years(query: str) -> list[str]:
    """`27년`과 `2027년`을 동일한 시행연도 조건으로 정규화한다."""
    years = []
    for raw in re.findall(r"(?<!\d)(20\d{2}|\d{2})년", query or ""):
        year = int(raw)
        normalized = str(year + 2000 if year < 100 else year)
        if normalized not in years:
            years.append(normalized)
    return years


def _is_scheduled_change_query(query: str) -> bool:
    """특정 연도의 시행예정 법령·개정내용을 묻는 질문인지 판정한다."""
    return bool(_requested_years(query)) and bool(re.search(
        r"시행|적용|변경|개정|바뀌|달라지|신설|삭제|예정",
        query or "",
    ))


def _flatten_list(val) -> list:
    if val is None:
        return []
    if isinstance(val, dict):
        return [val]
    return val


def _flatten_text(val) -> list[str]:
    """법령 API가 문자열을 여러 겹의 list로 감싸는 응답을 평탄화한다."""
    if isinstance(val, str):
        text = " ".join(val.split()).strip()
        return [text] if text else []
    if isinstance(val, list):
        return [text for item in val for text in _flatten_text(item)]
    if isinstance(val, dict):
        return [text for item in val.values() for text in _flatten_text(item)]
    return []


def _display_date(value: str) -> str:
    raw = re.sub(r"\D", "", str(value or ""))
    if len(raw) != 8:
        return str(value or "")
    return f"{raw[:4]}년 {int(raw[4:6])}월 {int(raw[6:])}일"


def _scheduled_amendment_body(law_item: dict, law_data: dict) -> str:
    """시행예정 법령의 메타데이터와 실제 개정문만 짧게 추린다.

    법 전체의 제1조부터 나열하면 질문과 무관한 목차성 답변이 되므로, 현행
    조문이 아니라 해당 공포본의 ``개정문``과 시행·적용례를 사용한다.
    """
    law_root = law_data.get("법령", {}) if isinstance(law_data, dict) else {}
    basic = law_root.get("기본정보", {}) if isinstance(law_root, dict) else {}
    amendment = law_root.get("개정문", {}) if isinstance(law_root, dict) else {}
    lines = _flatten_text(
        amendment.get("개정문내용", []) if isinstance(amendment, dict) else []
    )
    effective = str(
        law_item.get("시행일자") or (basic.get("시행일자") if isinstance(basic, dict) else "") or ""
    )
    promulgated = str(
        law_item.get("공포일자") or (basic.get("공포일자") if isinstance(basic, dict) else "") or ""
    )
    law_name = str(law_item.get("법령명한글") or "법령")
    amendment_type = str(law_item.get("제개정구분명") or "개정")
    number = str(law_item.get("공포번호") or "").strip()
    summary = (
        f"{law_name}은 {_display_date(effective)} 시행 예정인 {amendment_type} 법령"
        + (f"(법률 제{number}호)" if number else "")
        + "입니다."
    )
    if promulgated:
        summary += f" 공포일은 {_display_date(promulgated)}입니다."

    selected = []
    target_year = effective[:4]
    # 먼저 질문의 핵심인 시행일·적용례를 확보한다.
    for line in lines:
        if target_year and target_year in line and re.search(r"시행|적용", line):
            selected.append(line)
    # 그 다음 실제로 어느 조문이 달라지는지 개정 지시문을 보탠다.
    change_pattern = re.compile(
        r"^제\d+조(?:의\d+)?(?:제\d+항|제\d+호)?[^\n]{0,220}"
        r"(?:신설|삭제|개정|다음과 같이|로 한다|으로 한다|중\s*\"|항을|호를)"
    )
    for index, line in enumerate(lines):
        if not change_pattern.search(line):
            continue
        combined = line
        # 법제처 개정문은 "제44조의4를 다음과 같이 신설한다." 다음 줄에
        # 새 조문의 제목과 실제 의무 내용을 둔다. 지시문만 떼면 무엇이
        # 바뀌는지 다시 알 수 없으므로 바로 뒤의 해당 조문 본문을 묶는다.
        if "다음과 같이" in line and index + 1 < len(lines):
            following = lines[index + 1]
            article = re.match(r"^(제\d+조(?:의\d+)?)", line)
            if article and following.startswith(article.group(1) + "("):
                combined = f"{line} {following}"
        selected.append(combined)
    unique = []
    for line in selected:
        if line not in unique:
            unique.append(line[:700])
        if len(unique) >= 8:
            break
    if not unique:
        unique = [
            line[:700] for line in lines
            if re.search(r"개정|신설|삭제|시행|적용", line)
        ][:5]
    scoped = [
        line if (target_year and target_year in line)
        else f"{target_year}년 시행 개정 내용: {line}"
        for line in unique
    ]
    return "\n".join([summary, *scoped])


def _get_mst(law: dict) -> str:
    """API 버전마다 필드명이 다를 수 있으므로 여러 후보를 시도.

    law.go.kr lawSearch.do 실제 응답 필드명은 "법령일련번호"다(2026-08-24
    GitHub Actions 실행 로그에서 fetch_laws.py 쪽에 실측 확인된 것과 동일한
    API 응답 구조 — "법령MST"/"법령MST번호"/"MST"/"mst"는 존재하지 않는
    필드였음). 이 함수는 `/chat`의 실시간 법령 조회에 쓰이는데, fetch_laws.py의
    같은 버그를 그때 함께 고치지 못해 지금까지 조항 번호가 있는 법령 질문은
    본문을 전혀 가져오지 못한 채 매번 빈 결과로 끝나고 있었다(실측 재현 확인).
    """
    for key in ("법령일련번호", "법령MST", "법령MST번호", "MST", "mst"):
        v = str(law.get(key, "")).strip()
        if v:
            return v
    return ""


async def _search_scheduled_law_api(query: str) -> list[dict]:
    """특정 연도에 시행될 예정 법령의 목록과 실제 개정문을 조회한다."""
    years = _requested_years(query)
    # 이미 지난 연도는 현행·연혁 검색이 담당한다. 시행예정 API는 현재 이후만 조회한다.
    future_years = {year for year in years if int(year) >= date.today().year}
    if not future_years or not LAW_API_KEY or _is_api_blocked():
        return []
    search_name = _get_search_name(query)
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            response = await client.get(
                f"{_API_BASE}/lawSearch.do",
                params={
                    "OC": LAW_API_KEY,
                    "target": "eflaw",
                    "type": "JSON",
                    "query": search_name,
                    "nw": 2,  # 시행예정 법령만
                    "display": 20,
                },
            )
            data = response.json()
            laws = _flatten_list(data.get("LawSearch", {}).get("law"))
            exact = [
                item for item in laws
                if str(item.get("법령명한글", "")).strip() == search_name
            ]
            if exact:
                laws = exact
            laws = [
                item for item in laws
                if str(item.get("시행일자", ""))[:4] in future_years
                and _get_mst(item)
            ]
            laws.sort(key=lambda item: str(item.get("시행일자", "")))
            laws = laws[:5]
            if not laws:
                return []

            async def fetch_detail(item: dict):
                detail = await client.get(
                    f"{_API_BASE}/lawService.do",
                    params={
                        "OC": LAW_API_KEY,
                        "target": "eflaw",
                        "MST": _get_mst(item),
                        "efYd": item.get("시행일자", ""),
                        "type": "JSON",
                    },
                )
                return detail.json()

            details = await asyncio.gather(
                *(fetch_detail(item) for item in laws), return_exceptions=True
            )
            results = []
            for item, detail in zip(laws, details):
                if isinstance(detail, Exception):
                    detail = {}
                body = _scheduled_amendment_body(item, detail)
                effective = str(item.get("시행일자", ""))
                law_name = str(item.get("법령명한글") or search_name)
                results.append({
                    "title": (
                        f"{law_name} {_display_date(effective)} 시행 예정"
                        f" ({item.get('제개정구분명', '개정')})"
                    ),
                    "body": body,
                    "url": f"https://www.law.go.kr/법령/{law_name}",
                    "source": "law.go.kr 시행예정법령 API",
                    "effective_date": effective,
                    "scheduled": True,
                })
            return results
        except httpx.ConnectError:
            _block_api(seconds=3600)
            return []
        except Exception as error:
            print(f"⚠️ law.go.kr 시행예정법령 API 오류: {type(error).__name__}: {error}")
            return []


async def search_law_api(query: str) -> list[dict]:
    """국가법령정보 오픈API 비동기 검색"""
    if not LAW_API_KEY or _is_api_blocked():
        return []

    # 연도별 시행·변경 질문은 현행 조문 제1조~제5조가 아니라 해당 연도에
    # 실제 시행될 공포본의 개정문을 먼저 사용한다.
    if _is_scheduled_change_query(query):
        scheduled = await _search_scheduled_law_api(query)
        if scheduled:
            return scheduled

    search_name = _get_search_name(query)
    article_nums = _extract_article_nums(query)

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            # 1단계: 법령 검색 → MST 번호 획득 (display=5로 여러 개 받아 정확한 법 선택)
            r1 = await client.get(
                f"{_API_BASE}/lawSearch.do",
                params={
                    "OC": LAW_API_KEY,
                    "target": "law",
                    "type": "JSON",
                    "query": search_name,
                    "display": 5,
                },
            )
            data = r1.json()
            all_laws = _flatten_list(data.get("LawSearch", {}).get("law"))
            if not all_laws:
                print(f"⚠️ law.go.kr 검색 결과 없음: query={search_name}, raw={str(data)[:200]}")
                return []

            # 시행령·시행규칙 제외하고 법률 우선 선택
            laws = [l for l in all_laws if "시행령" not in l.get("법령명한글", "")
                    and "시행규칙" not in l.get("법령명한글", "")]
            if not laws:
                laws = all_laws

            mst = _get_mst(laws[0])
            law_name_kr = laws[0].get("법령명한글", search_name)

            if not mst:
                print(f"⚠️ MST 없음. 법령 데이터: {laws[0]}")
                return []

            # 2단계: 법령 본문 조회
            r2 = await client.get(
                f"{_API_BASE}/lawService.do",
                params={
                    "OC": LAW_API_KEY,
                    "target": "law",
                    "MST": mst,
                    "type": "JSON",
                },
            )
            law_data = r2.json()
            articles = _flatten_list(
                law_data.get("법령", {}).get("조문", {}).get("조문단위")
            )

            if not articles:
                print(f"⚠️ 조문 없음. law_data keys: {list(law_data.get('법령', {}).keys())}")
                return []

            # 특정 조문 필터링 — int 비교로 정확히 매칭 (7 ≠ 76, 107)
            if article_nums:
                target_nums = set(int(n) for n in article_nums if n.isdigit())
                matched = [
                    a for a in articles
                    if str(a.get("조문번호", "")).strip().isdigit()
                    and int(a.get("조문번호", -1)) in target_nums
                ]
                articles = matched if matched else articles[:3]
            else:
                articles = articles[:5]

            results = []
            for article in articles:
                num = str(article.get("조문번호", "")).strip()
                title = article.get("조문제목", "")
                content = article.get("조문내용", "")

                clauses = _flatten_list(article.get("항"))
                clause_text = "\n".join(
                    f"  {c.get('항번호', '')}. {c.get('항내용', '')}"
                    for c in clauses if c.get("항내용")
                )

                body = content + ("\n" + clause_text if clause_text else "")
                if not body.strip():
                    continue
                results.append({
                    "title": f"{law_name_kr} 제{num}조{('  ' + title) if title else ''}",
                    "body": body.strip(),
                    "url": f"https://www.law.go.kr/법령/{law_name_kr}",
                    "source": "law.go.kr API",
                })

            return results

        except httpx.ConnectError:
            _block_api(seconds=3600)
            return []
        except Exception as e:
            print(f"⚠️ law.go.kr API 오류: {type(e).__name__}: {e}")
            return []


def _extract_core_terms(query: str) -> str:
    """쿼리에서 핵심 법률 용어만 추출 (DDG 검색 정밀도 향상)"""
    # 법률 용어 우선 추출
    law_terms = re.findall(
        r'근로기준법|퇴직급여|퇴직금|연차|최저임금|고용보험|산재|육아휴직|기간제|해고|임금|'
        r'희망퇴직|권고사직|정리해고|주휴|연장근로|야간근로|성희롱|괴롭힘|근로계약|4대보험',
        query
    )
    if law_terms:
        return " ".join(law_terms[:3])  # 최대 3개 핵심 용어로 제한
    # 법률 용어가 없으면 앞 10자만 사용
    return query[:20]


def search_law_ddg(query: str, max_results: int = 2) -> list[dict]:
    """DuckDuckGo site:law.go.kr 검색 — 조항 번호 지정 쿼리엔 사용하지 않음"""
    core = _extract_core_terms(query)
    try:
        with DDGS() as ddgs:
            results = []
            for r in ddgs.text(f"site:law.go.kr {core}", max_results=max_results):
                results.append({
                    "title": r.get("title", ""),
                    "body": r.get("body", ""),
                    "url": r.get("href", ""),
                    "source": "DuckDuckGo",
                })
            return results
    except Exception as e:
        print(f"⚠️ DuckDuckGo law 검색 오류: {e}")
        return []


async def search_law(query: str) -> list[dict]:
    """법령 검색 진입점: Open API 우선, 실패 시 조항 없는 일반 쿼리만 DuckDuckGo 폴백"""
    results = await search_law_api(query)
    if not results:
        article_nums = _extract_article_nums(query)
        if not article_nums:
            # 조항 번호 없는 일반 법령 질문만 DDG 폴백 허용
            # search_law_ddg는 동기 블로킹 DDG 호출이므로 스레드 실행기로 넘긴다.
            print("ℹ️ law.go.kr API 결과 없음 → DuckDuckGo 폴백")
            results = await asyncio.get_event_loop().run_in_executor(
                None, search_law_ddg, query
            )
        else:
            print("ℹ️ law.go.kr API 결과 없음 (조항 쿼리 → DDG 폴백 생략)")
    return results


def format_law_context(results: list[dict]) -> str:
    if not results:
        return ""
    parts = []
    for r in results:
        parts.append(f"[{r['title']}]\n{r['body']}\n출처: {r['url']}")
    return "📚 국가법령정보(law.go.kr) 검색 결과:\n\n" + "\n\n".join(parts)
