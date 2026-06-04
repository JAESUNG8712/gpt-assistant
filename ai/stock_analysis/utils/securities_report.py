"""
증권사 애널리스트 리포트 수집기
네이버 금융 리서치 + DuckDuckGo 검색으로 공개 리포트 취합
"""

import asyncio
import re
from datetime import datetime
from typing import Dict, List, Optional

import aiohttp

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://finance.naver.com/",
    "Accept-Language": "ko-KR,ko;q=0.9",
}

# 증권사 이름 정규화 맵
FIRM_ALIASES = {
    "미래에셋": "미래에셋증권", "KB": "KB증권", "NH": "NH투자증권",
    "하나": "하나증권", "삼성": "삼성증권", "신한": "신한투자증권",
    "키움": "키움증권", "대신": "대신증권", "한투": "한국투자증권",
    "메리츠": "메리츠증권", "유진": "유진투자증권", "IBK": "IBK투자증권",
    "교보": "교보증권", "현대차": "현대차증권", "DS": "DS투자증권",
    "흥국": "흥국증권", "이베스트": "이베스트투자증권",
}


async def fetch_naver_research(ticker: str, page_size: int = 10) -> List[Dict]:
    """
    네이버 금융 리서치에서 특정 종목 애널리스트 리포트 목록 수집
    Returns: [{증권사, 제목, 날짜, 목표주가, 투자의견, 링크}]
    """
    url = "https://finance.naver.com/research/company_list.naver"
    params = {
        "searchType": "priceTo",
        "x": "0", "y": "0",
        "code": ticker,
        "pageSize": page_size,
    }
    try:
        async with aiohttp.ClientSession(headers=HEADERS) as session:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    return []
                html = await resp.text(encoding="euc-kr", errors="replace")
        return _parse_naver_research(html, ticker)
    except Exception:
        return []


def _parse_naver_research(html: str, ticker: str) -> List[Dict]:
    """네이버 금융 리서치 HTML 파싱"""
    reports = []

    # 각 보고서 행 추출 (td 패턴)
    # 네이버 금융 리서치 테이블 구조:
    # 종목명 | 증권사 | 제목 | 목표주가 | 투자의견 | 날짜
    rows = re.findall(
        r'<td class="tit"[^>]*>.*?</td>.*?'
        r'<td[^>]*>(.*?)</td>.*?'   # 증권사
        r'<td[^>]*>(.*?)</td>.*?'   # 제목 (a href)
        r'<td[^>]*>(.*?)</td>.*?'   # 목표주가
        r'<td[^>]*>(.*?)</td>.*?'   # 투자의견
        r'<td[^>]*>(.*?)</td>',     # 날짜
        html, re.DOTALL
    )

    # 대안 파싱: 개별 패턴으로 추출
    if not rows:
        # 제목 + 링크
        titles = re.findall(
            r'href="(/research/company_read\.naver\?nid=(\d+))"[^>]*>(.*?)</a>',
            html
        )
        # 증권사
        firms = re.findall(r'<td class="file"[^>]*>(.*?)</td>', html, re.DOTALL)
        # 목표주가
        prices = re.findall(r'<td class="num"[^>]*>([\d,]+|N/A|-)</td>', html)
        # 투자의견
        opinions = re.findall(r'<td class="opinion"[^>]*>(.*?)</td>', html, re.DOTALL)
        # 날짜
        dates = re.findall(r'<td class="date"[^>]*>(\d{4}\.\d{2}\.\d{2})</td>', html)

        for i, (path, nid, title) in enumerate(titles):
            firm = _clean(firms[i]) if i < len(firms) else ""
            price = prices[i].replace(",", "") if i < len(prices) else ""
            opinion = _clean(opinions[i]) if i < len(opinions) else ""
            date = dates[i] if i < len(dates) else ""
            reports.append({
                "증권사": _normalize_firm(firm),
                "제목": _clean(title),
                "날짜": date,
                "목표주가": f"{int(price):,}원" if price.isdigit() else price,
                "투자의견": opinion,
                "링크": f"https://finance.naver.com{path}",
                "nid": nid,
            })

    return reports[:10]


async def fetch_report_summary(nid: str) -> str:
    """개별 리포트 요약 텍스트 수집"""
    url = f"https://finance.naver.com/research/company_read.naver?nid={nid}"
    try:
        async with aiohttp.ClientSession(headers=HEADERS) as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                if resp.status != 200:
                    return ""
                html = await resp.text(encoding="euc-kr", errors="replace")
        # 본문 텍스트 추출 (script/style 제거 후 첫 500자)
        text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        # 핵심 내용 앞부분 추출
        return text[:600]
    except Exception:
        return ""


async def search_reports_ddg(stock_name: str) -> List[Dict]:
    """DuckDuckGo로 증권사 리포트 뉴스/기사 보조 수집"""
    try:
        from ddgs import DDGS
        query = f"{stock_name} 증권사 리포트 목표주가 투자의견 site:finance.naver.com OR site:brokerage.co.kr"
        results = []
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=5):
                results.append({
                    "제목": r.get("title", ""),
                    "요약": r.get("body", "")[:300],
                    "출처": r.get("href", ""),
                    "날짜": "",
                    "증권사": _extract_firm_from_text(r.get("body", "")),
                    "투자의견": _extract_opinion(r.get("body", "")),
                    "목표주가": _extract_target_price(r.get("body", "")),
                })
        return results
    except Exception:
        return []


async def get_all_reports(ticker: str, stock_name: str, max_reports: int = 5) -> Dict:
    """
    종목 전체 리포트 수집 (네이버 리서치 + DDG 보조)
    Returns: {reports: [...], summary: "...", consensus: {...}}
    """
    naver_reports, ddg_reports = await asyncio.gather(
        fetch_naver_research(ticker, max_reports),
        search_reports_ddg(stock_name),
        return_exceptions=True,
    )

    if isinstance(naver_reports, Exception):
        naver_reports = []
    if isinstance(ddg_reports, Exception):
        ddg_reports = []

    all_reports = naver_reports + ddg_reports

    # 컨센서스 집계
    consensus = _build_consensus(all_reports)

    # 자연어 요약
    summary = _format_summary(stock_name, all_reports, consensus)

    return {
        "종목명": stock_name,
        "종목코드": ticker,
        "수집건수": len(all_reports),
        "reports": all_reports,
        "consensus": consensus,
        "summary": summary,
    }


def _build_consensus(reports: List[Dict]) -> Dict:
    """수집된 리포트에서 컨센서스(평균 목표주가·의견 분포) 산출"""
    prices = []
    opinions = {"매수": 0, "중립": 0, "매도": 0, "비중확대": 0, "시장수익률": 0}

    for r in reports:
        # 목표주가 숫자 추출
        price_str = r.get("목표주가", "")
        nums = re.findall(r'\d[\d,]+', price_str.replace(",", ""))
        if nums:
            try:
                prices.append(int(nums[0]))
            except ValueError:
                pass
        # 투자의견 집계
        op = r.get("투자의견", "")
        for key in opinions:
            if key in op or key.replace("비중확대", "BUY") in op:
                opinions[key] += 1
                break

    avg_price = int(sum(prices) / len(prices)) if prices else 0
    return {
        "평균목표주가": f"{avg_price:,}원" if avg_price else "N/A",
        "최고목표주가": f"{max(prices):,}원" if prices else "N/A",
        "최저목표주가": f"{min(prices):,}원" if prices else "N/A",
        "의견분포": {k: v for k, v in opinions.items() if v > 0},
        "리포트수": len(reports),
    }


def _format_summary(name: str, reports: List[Dict], consensus: Dict) -> str:
    if not reports:
        return f"{name}: 수집된 증권사 리포트 없음"

    lines = [f"📋 {name} 증권사 리포트 컨센서스"]
    c = consensus
    lines += [
        f"  평균 목표주가: {c['평균목표주가']}  "
        f"(최고 {c['최고목표주가']} / 최저 {c['최저목표주가']})",
        f"  수집 리포트: {c['리포트수']}건",
        f"  의견 분포: {c['의견분포']}",
        "",
        "  최근 리포트:",
    ]
    for r in reports[:5]:
        firm = r.get("증권사") or "출처미상"
        title = r.get("제목", "")[:40]
        date = r.get("날짜", "")
        tp = r.get("목표주가", "")
        op = r.get("투자의견", "")
        lines.append(f"    [{date}] {firm} | {op} {tp} | {title}")

    return "\n".join(lines)


# ── 헬퍼 ──────────────────────────────────────────────

def _clean(html: str) -> str:
    text = re.sub(r'<[^>]+>', '', html)
    return re.sub(r'\s+', ' ', text).strip()


def _normalize_firm(name: str) -> str:
    name = _clean(name)
    for alias, full in FIRM_ALIASES.items():
        if alias in name:
            return full
    return name or "기타"


def _extract_firm_from_text(text: str) -> str:
    for alias, full in FIRM_ALIASES.items():
        if alias in text:
            return full
    return ""


def _extract_opinion(text: str) -> str:
    for kw in ["매수", "비중확대", "중립", "시장수익률", "매도", "BUY", "HOLD", "SELL"]:
        if kw in text:
            return kw
    return ""


def _extract_target_price(text: str) -> str:
    m = re.search(r'목표\s*주가\s*[:\s]*([0-9,]+)\s*원', text)
    if m:
        return f"{m.group(1)}원"
    return ""
