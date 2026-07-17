from ddgs import DDGS
from memory import store_memory
from datetime import datetime
from urllib.parse import urlparse


def _domain(url: str) -> str:
    """URL에서 도메인명만 추출 (www. 제외)"""
    try:
        return urlparse(url).netloc.removeprefix("www.")
    except Exception:
        return url[:40]


def web_search(query: str, max_results: int = 5) -> list[dict]:
    results = []
    try:
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=max_results):
                results.append({
                    "title": r.get("title", ""),
                    "body":  r.get("body", ""),
                    "url":   r.get("href", ""),
                })
    except Exception as e:
        print(f"⚠️ DuckDuckGo 검색 오류: {e}")
        return []
    return results

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
