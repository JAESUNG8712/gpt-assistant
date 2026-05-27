from duckduckgo_search import DDGS
from memory import store_memory
from datetime import datetime

def web_search(query: str, max_results: int = 5) -> list[dict]:
    results = []
    with DDGS() as ddgs:
        for r in ddgs.text(query, max_results=max_results):
            results.append({
                "title": r.get("title", ""),
                "body":  r.get("body", ""),
                "url":   r.get("href", ""),
            })
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
    parts = []
    for r in results:
        parts.append(f"[{r['title']}]\n{r['body']}\n출처: {r['url']}")
    return "\n\n".join(parts)
