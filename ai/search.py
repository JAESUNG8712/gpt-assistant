from ddgs import DDGS
from memory import store_memory
from datetime import datetime
from urllib.parse import urlparse
import re


def _domain(url: str) -> str:
    """URL에서 도메인명만 추출 (www. 제외)"""
    try:
        return urlparse(url).netloc.removeprefix("www.")
    except Exception:
        return url[:40]


_SEARCH_STOPWORDS = {
    "알려줘", "알려", "무엇", "뭐야", "얼마", "대한", "관련", "검색",
    "최신", "정보", "해주세요", "해줘", "인가요", "그리고", "또는",
}


def _query_terms(query: str) -> list[str]:
    terms = re.findall(r"[가-힣A-Za-z]{2,}|\d{2,4}년?", query.lower())
    return [term for term in terms if term not in _SEARCH_STOPWORDS]


def _result_relevance(query: str, result: dict) -> tuple[int, bool]:
    """질문과 무관한 검색 스니펫은 참고자료와 학습 대상에서 제외한다."""
    url = result.get("href") or result.get("url") or ""
    haystack = f"{result.get('title', '')} {result.get('body', '')} {url}".lower()
    compact = re.sub(r"\s+", "", haystack)
    terms = _query_terms(query)
    matches = sum(1 for term in terms if re.sub(r"\s+", "", term) in compact)

    wage_query = "최저임금" in query or "최저시급" in query
    if wage_query and not ("최저임금" in compact or "최저시급" in compact):
        return 0, False
    if terms and matches == 0:
        return 0, False

    domain = _domain(url).lower()
    official_bonus = 4 if domain.endswith(".go.kr") else 0
    return matches * 2 + official_bonus, True


def web_search(query: str, max_results: int = 5) -> list[dict]:
    ranked = []
    with DDGS() as ddgs:
        for position, r in enumerate(ddgs.text(query, max_results=max(10, max_results * 3))):
            score, relevant = _result_relevance(query, r)
            if not relevant:
                continue
            ranked.append((score, -position, {
                "title": r.get("title", ""),
                "body":  r.get("body", ""),
                "url":   r.get("href", ""),
            }))
    ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [item[2] for item in ranked[:max_results]]

def search_and_learn(query: str, max_results: int = 5, persona_id: str = "hr") -> list[dict]:
    results = web_search(query, max_results)
    for r in results:
        text = f"{r['title']}\n{r['body']}"
        store_memory(text, {
            "source":  f"웹검색:{r['url']}",
            "query":   query,
            "persona": persona_id,
            "at":      datetime.now().isoformat(),
        })
    return results

def format_search_context(results: list[dict]) -> str:
    """LLM 컨텍스트용: 각 결과에 출처 도메인을 명시해 LLM이 출처를 인용할 수 있게 함"""
    parts = []
    for i, r in enumerate(results, 1):
        url = r.get("url", "")
        domain = _domain(url) if url else "출처 없음"
        title = r.get("title", "").strip()
        body = r.get("body", "").strip()
        parts.append(
            f"[검색결과 {i} | 출처: {domain}]\n"
            f"제목: {title}\n"
            f"내용: {body}\n"
            f"URL: {url}"
        )
    return "\n\n".join(parts)
