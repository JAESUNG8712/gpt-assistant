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
_TIMEOUT = 8.0

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
    """쿼리에서 공식 법령 검색명 추출"""
    for alias, official in _LAW_ALIAS_TO_SEARCH.items():
        if alias in query:
            return official
    # 법령명이 명시되지 않은 경우 쿼리 그대로
    return query


def _extract_article_nums(query: str) -> list[str]:
    return re.findall(r'제?\s*(\d+)\s*조', query)


def _flatten_list(val) -> list:
    """API 응답에서 단일 dict가 오는 경우 list로 통일"""
    if val is None:
        return []
    if isinstance(val, dict):
        return [val]
    return val


async def search_law_api(query: str) -> list[dict]:
    """국가법령정보 오픈API 비동기 검색"""
    if not LAW_API_KEY:
        return []

    search_name = _get_search_name(query)
    article_nums = _extract_article_nums(query)

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            # 1단계: 법령 검색 → MST 번호 획득
            r1 = await client.get(
                f"{_API_BASE}/lawSearch.do",
                params={
                    "OC": LAW_API_KEY,
                    "target": "law",
                    "type": "JSON",
                    "query": search_name,
                    "display": 1,
                },
            )
            data = r1.json()
            laws = _flatten_list(data.get("LawSearch", {}).get("law"))
            if not laws:
                return []

            mst = laws[0].get("법령MST번호", "")
            law_name_kr = laws[0].get("법령명한글", search_name)
            if not mst:
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

            # 특정 조문 필터링
            if article_nums:
                matched = [a for a in articles if str(a.get("조문번호", "")) in article_nums]
                articles = matched if matched else articles[:5]
            else:
                articles = articles[:5]

            results = []
            for article in articles:
                num = article.get("조문번호", "")
                title = article.get("조문제목", "")
                content = article.get("조문내용", "")

                clauses = _flatten_list(article.get("항"))
                clause_text = "\n".join(
                    f"  {c.get('항번호', '')}. {c.get('항내용', '')}"
                    for c in clauses if c.get("항내용")
                )

                body = content + ("\n" + clause_text if clause_text else "")
                results.append({
                    "title": f"{law_name_kr} 제{num}조{'  ' + title if title else ''}",
                    "body": body.strip(),
                    "url": f"https://www.law.go.kr/법령/{law_name_kr}",
                    "source": "law.go.kr API",
                })

            return results

        except Exception as e:
            print(f"⚠️ law.go.kr API 오류: {e}")
            return []


def search_law_ddg(query: str, max_results: int = 3) -> list[dict]:
    """DuckDuckGo site:law.go.kr 검색 (폴백)"""
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
    """법령 검색 진입점: Open API 우선, 실패 시 DuckDuckGo 폴백"""
    results = await search_law_api(query)
    if not results:
        print("ℹ️ law.go.kr API 결과 없음 → DuckDuckGo 폴백")
        results = search_law_ddg(query)
    return results


def format_law_context(results: list[dict]) -> str:
    if not results:
        return ""
    parts = []
    for r in results:
        parts.append(f"[{r['title']}]\n{r['body']}\n출처: {r['url']}")
    return "📚 국가법령정보(law.go.kr) 검색 결과:\n\n" + "\n\n".join(parts)
