"""
📰 종목 뉴스 + 전문가 의견 수집기
네이버 금융 뉴스 스크래핑 + DuckDuckGo 검색
"""

import asyncio
import html as _html
import re
from typing import List, Dict

try:
    import requests as _requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://finance.naver.com/",
    "Accept-Language": "ko-KR,ko;q=0.9",
}


def _clean_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)
    text = _html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


# ── 네이버 금융 종목 뉴스 ────────────────────────────────────

def _fetch_naver_finance_news(ticker: str, max_results: int = 5) -> List[Dict]:
    """네이버 금융 종목 뉴스 탭 스크래핑"""
    if not HAS_REQUESTS or not ticker:
        return []
    try:
        url = "https://finance.naver.com/item/news_news.naver"
        resp = _requests.get(
            url,
            params={"code": ticker, "page": 1},
            headers=_HEADERS,
            timeout=8,
        )
        html = resp.content.decode("euc-kr", errors="replace")

        # 실제 마크업은 title 속성이 아니라 <a class="tit">링크텍스트</a> 형태로 제목을 담음
        titles = re.findall(r'<td class="title">\s*<a[^>]*>(.*?)</a>', html, re.DOTALL)
        sources = re.findall(r'<td class="info"[^>]*>(.*?)</td>', html, re.DOTALL)
        dates = re.findall(r'<td class="date"[^>]*>\s*(\d{4}\.\d{2}\.\d{2})', html)

        results = []
        for i, title in enumerate(titles[:max_results]):
            src = _clean_html(sources[i]) if i < len(sources) else ""
            date = dates[i] if i < len(dates) else ""
            results.append({
                "제목": _clean_html(title),
                "요약": "",
                "출처": src,
                "날짜": date,
                "유형": "네이버금융뉴스",
            })
        return results
    except Exception:
        return []


# ── DuckDuckGo 뉴스/기사 검색 ────────────────────────────────

def _search_ddg_news(stock_name: str, max_results: int = 5) -> List[Dict]:
    """DuckDuckGo로 종목 관련 뉴스·기사·전문가 의견 검색"""
    try:
        from ddgs import DDGS
        queries = [
            f"{stock_name} 주가 실적 전망",
            f"{stock_name} 증권사 목표주가 투자의견",
        ]
        seen: set = set()
        results: List[Dict] = []

        with DDGS() as ddgs:
            for query in queries:
                for r in ddgs.text(query, max_results=4):
                    title = r.get("title", "")
                    if not title or title in seen:
                        continue
                    seen.add(title)
                    results.append({
                        "제목": title,
                        "요약": r.get("body", "")[:250],
                        "출처": r.get("href", ""),
                        "날짜": "",
                        "유형": "인터넷검색",
                    })
                if len(results) >= max_results:
                    break

        return results[:max_results]
    except Exception:
        return []


# ── 네이버 증권 리서치 뉴스 ──────────────────────────────────

def _fetch_naver_research_news(stock_name: str, max_results: int = 3) -> List[Dict]:
    """네이버 금융 리서치 코너에서 해당 종목 관련 이슈 검색"""
    if not HAS_REQUESTS:
        return []
    try:
        url = "https://search.naver.com/search.naver"
        query = f"{stock_name} 주가 분석 site:finance.naver.com"
        resp = _requests.get(
            url,
            params={"where": "web", "query": query},
            headers={**_HEADERS, "Referer": "https://search.naver.com/"},
            timeout=6,
        )
        html = resp.content.decode("utf-8", errors="replace")

        titles = re.findall(
            r'<a[^>]+class="[^"]*link_tit[^"]*"[^>]*>(.*?)</a>', html, re.DOTALL
        )[:max_results]
        descriptions = re.findall(
            r'<div[^>]+class="[^"]*dsc_wrap[^"]*"[^>]*>(.*?)</div>', html, re.DOTALL
        )[:max_results]

        results = []
        for i, title in enumerate(titles):
            title_clean = _clean_html(title)
            desc = _clean_html(descriptions[i]) if i < len(descriptions) else ""
            if not title_clean:
                continue
            results.append({
                "제목": title_clean[:60],
                "요약": desc[:200],
                "출처": "네이버",
                "날짜": "",
                "유형": "웹검색",
            })
        return results
    except Exception:
        return []


# ── 공개 API ────────────────────────────────────────────────

async def get_stock_news(stock_name: str, ticker: str = "", max_results: int = 8) -> Dict:
    """종목 뉴스 통합 수집 (네이버 금융 + DuckDuckGo)"""
    loop = asyncio.get_event_loop()

    naver_task = loop.run_in_executor(
        None, _fetch_naver_finance_news, ticker, 4
    )
    ddg_task = loop.run_in_executor(
        None, _search_ddg_news, stock_name, 5
    )

    naver_news, ddg_news = await asyncio.gather(
        naver_task, ddg_task, return_exceptions=True
    )

    if isinstance(naver_news, Exception):
        naver_news = []
    if isinstance(ddg_news, Exception):
        ddg_news = []

    # 중복 제거 후 병합 (네이버 금융 뉴스 우선)
    seen: set = set()
    all_news: List[Dict] = []
    for item in list(naver_news) + list(ddg_news):
        title = item.get("제목", "")
        if title and title not in seen:
            seen.add(title)
            all_news.append(item)
        if len(all_news) >= max_results:
            break

    summary = _format_summary(stock_name, all_news)

    return {
        "종목명": stock_name,
        "수집건수": len(all_news),
        "articles": all_news,
        "summary": summary,
    }


def _format_summary(stock_name: str, articles: List[Dict]) -> str:
    if not articles:
        return f"{stock_name}: 최근 뉴스 없음"

    lines = [f"📰 {stock_name} 최근 뉴스 ({len(articles)}건)"]
    for a in articles[:6]:
        date = a.get("날짜") or ""
        source = a.get("출처") or ""
        title = (a.get("제목") or "")[:55]
        desc = (a.get("요약") or "")[:120]
        prefix = f"[{date}] " if date else ""
        src_label = f" ({source})" if source else ""
        lines.append(f"  {prefix}{title}{src_label}")
        if desc:
            lines.append(f"    → {desc}")
    return "\n".join(lines)


def format_news_context(news_data: Dict) -> str:
    """LLM 컨텍스트용 뉴스 포맷"""
    articles = news_data.get("articles", [])
    if not articles:
        return ""

    stock_name = news_data.get("종목명", "")
    lines = [f"## {stock_name} 최신 뉴스/기사"]
    for a in articles:
        date = a.get("날짜") or ""
        title = a.get("제목") or ""
        summary = a.get("요약") or ""
        source = a.get("출처") or ""
        header = f"- [{date} {source}]".strip("[]").strip()
        header = f"- [{header}]" if (date or source) else "-"
        lines.append(f"{header} {title}")
        if summary:
            lines.append(f"  {summary}")
    return "\n".join(lines)
