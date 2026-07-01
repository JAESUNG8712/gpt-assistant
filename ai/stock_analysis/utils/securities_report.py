"""
증권사 애널리스트 리포트 수집기
네이버 금융 리서치 + DuckDuckGo 검색으로 공개 리포트 취합
"""

import asyncio
import html as _html
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
    Returns: [{증권사, 제목, 날짜, 목표주가, 투자의견, 링크, nid}]

    주의: company_list.naver는 searchType=itemCode&itemCode={ticker}로 조회해야 종목별
    필터링이 적용됨. searchType=priceTo&code={ticker}는 종목과 무관한 전체 목표주가
    변경 리스트를 반환하므로 사용하지 않음(과거 잘못된 파라미터로 인한 버그).
    """
    url = "https://finance.naver.com/research/company_list.naver"
    params = {
        "searchType": "itemCode",
        "itemCode": ticker,
        "x": "0", "y": "0",
    }
    try:
        async with aiohttp.ClientSession(headers=HEADERS, trust_env=True) as session:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    return []
                html = await resp.text(encoding="euc-kr", errors="replace")
        reports = _parse_naver_research(html, ticker)[:page_size]
        await _enrich_with_target_opinion(reports)
        return reports
    except Exception:
        return []


def _parse_naver_research(html: str, ticker: str) -> List[Dict]:
    """네이버 금융 리서치 종목별 리포트 목록 HTML 파싱
    실제 테이블 구조: 종목명 | 제목(nid 링크) | 증권사 | 첨부(PDF) | 작성일 | 조회수
    목표주가·투자의견은 이 목록 페이지에 없고 개별 리포트 본문에만 있어
    _enrich_with_target_opinion()에서 본문을 추가로 가져와 채운다.
    """
    reports = []

    rows = re.findall(
        r'<td[^>]*>\s*<a[^>]+href="/item/main\.naver[^"]*"[^>]*>.*?</a>\s*</td>\s*'
        r'<td[^>]*>\s*<a[^>]+href="company_read\.naver\?nid=(\d+)[^"]*"[^>]*>(.*?)</a>\s*</td>\s*'
        r'<td[^>]*>(.*?)</td>.*?'              # 증권사
        r'<td class="date"[^>]*>([\d.]+)</td>',  # 작성일
        html, re.DOTALL
    )

    for nid, title, firm, date in rows:
        reports.append({
            "증권사": _normalize_firm(_clean(firm)),
            "제목": _clean(title),
            "날짜": date,
            "목표주가": "",
            "투자의견": "",
            "링크": f"https://finance.naver.com/research/company_read.naver?nid={nid}",
            "nid": nid,
        })

    return reports


async def _enrich_with_target_opinion(reports: List[Dict], max_fetch: int = 5) -> None:
    """목록에 없는 목표가·투자의견을 개별 리포트 본문에서 가져와 채움(상위 max_fetch건)"""
    targets = reports[:max_fetch]
    if not targets:
        return
    bodies = await asyncio.gather(
        *(fetch_report_summary(r["nid"]) for r in targets),
        return_exceptions=True,
    )
    for r, body in zip(targets, bodies):
        if isinstance(body, Exception) or not body:
            continue
        price, opinion = _extract_report_meta(body)
        if price:
            r["목표주가"] = price
        if opinion:
            r["투자의견"] = opinion


def _extract_report_meta(body: str) -> tuple:
    """리포트 본문 텍스트에서 '목표가 480,000 | 투자의견 Buy' 형태의 목표가·투자의견 추출"""
    price = ""
    m = re.search(r'목표가\s+([\d,]+)', body)
    if m:
        price = f"{m.group(1)}원"
    opinion = ""
    m = re.search(r'투자의견\s+([A-Za-z가-힣]+)', body)
    if m:
        opinion = m.group(1)
    return price, opinion


async def fetch_report_summary(nid: str) -> str:
    """개별 리포트 요약 텍스트 수집"""
    url = f"https://finance.naver.com/research/company_read.naver?nid={nid}"
    try:
        async with aiohttp.ClientSession(headers=HEADERS, trust_env=True) as session:
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
    """DuckDuckGo로 증권사 리포트 뉴스/기사 보조 수집

    DDGS 호출은 동기 블로킹 I/O라 그대로 코루틴 안에서 실행하면 asyncio.gather()로
    fetch_naver_research()와 함께 묶일 때 이벤트 루프를 점유해 네이버 쪽 요청이
    타임아웃되는 문제가 있었음 — run_in_executor로 별도 스레드에서 실행해 해결.
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _search_reports_ddg_sync, stock_name)


def _search_reports_ddg_sync(stock_name: str) -> List[Dict]:
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

    # 목표주가·투자의견이 전혀 없는 빈 항목(파싱 실패) 제거 — 신뢰 불가 placeholder 방지
    all_reports = [r for r in (naver_reports + ddg_reports) if _is_meaningful(r)]

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
        nums = re.findall(r'[\d,]+', price_str.replace(",", ""))
        if nums:
            try:
                prices.append(int(nums[0]))
            except ValueError:
                pass
        # 투자의견 집계 (영문 등급도 한글 버킷으로 정규화)
        op = _normalize_opinion(r.get("투자의견", ""))
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

_OPINION_EN_TO_KR = {
    "buy": "매수", "strongbuy": "매수", "overweight": "비중확대",
    "hold": "중립", "neutral": "중립", "marketperform": "시장수익률",
    "sell": "매도", "underweight": "매도",
}


def _normalize_opinion(op: str) -> str:
    """영문 투자의견(Buy/Hold/Sell 등)을 한글 버킷명으로 정규화"""
    key = re.sub(r'[^a-zA-Z]', '', op).lower()
    return _OPINION_EN_TO_KR.get(key, op)


def _is_meaningful(r: Dict) -> bool:
    """목표주가·투자의견 중 하나라도 실제 값이 있어야 신뢰 가능한 리포트로 취급"""
    return bool(r.get("목표주가")) or bool(r.get("투자의견"))


def _clean(html: str) -> str:
    text = re.sub(r'<[^>]+>', '', html)
    text = _html.unescape(text)
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
