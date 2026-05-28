"""
국가법령정보 Open API + DuckDuckGo 폴백 법령 검색

API 키 발급: https://open.law.go.kr (무료)
환경변수: LAW_API_KEY
"""
import os
import re
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
    r'제\s*\d+\s*조',
    r'(?<!\d)\d+\s*조(?!\d)',
    r'노동법|근로기준법|퇴직급여|최저임금|기간제|육아휴직|남녀고용|일가정|산업안전|고용보험|산재|근로계약|해고|임금|근로시간',
    r'법률?|법령|조항|조문|규정|시행령|시행규칙',
    r'위반|처벌|과태료|형사|손해배상|판례',
]

def is_law_question(text: str) -> bool:
    return any(re.search(p, text) for p in _LAW_DETECT)


def _get_search_name(query: str) -> str:
    for alias, official in _LAW_ALIAS_TO_SEARCH.items():
        if alias in query:
            return official
    return query


def _extract_article_nums(query: str) -> list[str]:
    return re.findall(r'제?\s*(\d+)\s*조', query)


def _flatten_list(val) -> list:
    if val is None:
        return []
    if isinstance(val, dict):
        return [val]
    return val


def _get_mst(law: dict) -> str:
    """API 버전마다 필드명이 다를 수 있으므로 여러 후보를 시도"""
    for key in ("법령MST", "법령MST번호", "MST", "mst"):
        v = str(law.get(key, "")).strip()
        if v:
            return v
    return ""


async def search_law_api(query: str) -> list[dict]:
    """국가법령정보 오픈API 비동기 검색"""
    if not LAW_API_KEY or _is_api_blocked():
        return []

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


def search_law_ddg(query: str, max_results: int = 3) -> list[dict]:
    """DuckDuckGo site:law.go.kr 검색 — 조항 번호 지정 쿼리엔 사용하지 않음"""
    try:
        with DDGS() as ddgs:
            results = []
            for r in ddgs.text(f"site:law.go.kr {query}", max_results=max_results):
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
            print("ℹ️ law.go.kr API 결과 없음 → DuckDuckGo 폴백")
            results = search_law_ddg(query)
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
