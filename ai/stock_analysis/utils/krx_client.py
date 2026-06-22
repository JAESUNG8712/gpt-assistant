"""
KRX(한국거래소) 시세·투자자별 매매 동향 수집
pykrx → 네이버금융 스크래핑 → mock 순으로 fallback
"""

import asyncio
import re
import time
from datetime import datetime, timedelta
from typing import Optional

try:
    from pykrx import stock as krx_stock
    HAS_PYKRX = True
except ImportError:
    HAS_PYKRX = False

try:
    import requests as _requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

_NAVER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://finance.naver.com/",
    "Accept-Language": "ko-KR,ko;q=0.9",
}


def get_today() -> str:
    return datetime.now().strftime("%Y%m%d")


def get_date_before(days: int) -> str:
    return (datetime.now() - timedelta(days=days)).strftime("%Y%m%d")


# ── 네이버 금융: 종목명 → ticker 자동 탐색 ─────────────────

def lookup_ticker_by_name(name: str) -> Optional[str]:
    """네이버 금융 자동완성 API로 종목명 → KRX 티커 변환"""
    if not HAS_REQUESTS:
        return None
    try:
        name_norm = name.replace(" ", "")
        url = "https://ac.stock.naver.com/ac"
        resp = _requests.get(
            url,
            params={"q": name_norm, "target": "stock"},
            headers=_NAVER_HEADERS,
            timeout=6,
        )
        data = resp.json()
        items = data.get("items", [])
        for group in items:
            for item in (group if isinstance(group, list) else []):
                code = item.get("code", "")
                item_name = item.get("name", "").replace(" ", "")
                if code and len(code) == 6 and item_name == name_norm:
                    return code
        # 첫 번째 결과라도 반환
        for group in items:
            for item in (group if isinstance(group, list) else []):
                code = item.get("code", "")
                if code and len(code) == 6:
                    return code
    except Exception:
        pass
    return None


# ── 네이버 금융: 실시간 시세 스크래핑 ─────────────────────

def _fetch_naver_price(ticker: str) -> dict:
    """네이버 금융 시세 페이지에서 현재가·등락률·거래량 스크래핑"""
    if not HAS_REQUESTS:
        return {}
    try:
        url = "https://finance.naver.com/item/sise.naver"
        resp = _requests.get(url, params={"code": ticker}, headers=_NAVER_HEADERS, timeout=8)
        html = resp.content.decode("euc-kr", errors="replace")

        def extract(pattern):
            m = re.search(pattern, html)
            return m.group(1).replace(",", "") if m else ""

        now_val = extract(r'<strong[^>]*id="_nowVal"[^>]*>([\d,]+)<')
        change_pct = extract(r'<span[^>]*id="_rate"[^>]*>([-\d.]+)<')
        volume = extract(r'<strong[^>]*id="_quant"[^>]*>([\d,]+)<')
        high = extract(r'고가</th>[^<]*<td[^>]*><span[^>]*>([\d,]+)<')
        low = extract(r'저가</th>[^<]*<td[^>]*><span[^>]*>([\d,]+)<')

        if not now_val:
            return {}

        close = int(now_val)
        return {
            "ticker": ticker,
            "date": datetime.now().strftime("%Y-%m-%d"),
            "close": close,
            "open": close,
            "high": int(high) if high else close,
            "low": int(low) if low else close,
            "volume": int(volume) if volume else 0,
            "change_pct": float(change_pct) if change_pct else 0.0,
            "_source": "naver",
        }
    except Exception:
        return {}


def _fetch_naver_valuation(ticker: str) -> dict:
    """네이버 금융 종목 메인 페이지에서 PER·PBR·EPS·BPS 스크래핑"""
    if not HAS_REQUESTS:
        return {}
    try:
        url = "https://finance.naver.com/item/main.naver"
        resp = _requests.get(url, params={"code": ticker}, headers=_NAVER_HEADERS, timeout=8)
        html = resp.content.decode("euc-kr", errors="replace")

        def extract(label):
            pattern = rf'{label}</th>[^<]*<td[^>]*>([\d,.N/A]+)<'
            m = re.search(pattern, html)
            if m:
                val = m.group(1).replace(",", "").strip()
                try:
                    return float(val)
                except ValueError:
                    return 0.0
            return 0.0

        per = extract("PER")
        pbr = extract("PBR")
        eps = extract("EPS")
        bps = extract("BPS")

        return {
            "ticker": ticker,
            "date": datetime.now().strftime("%Y-%m-%d"),
            "PER": per,
            "PBR": pbr,
            "EPS": eps,
            "BPS": bps,
            "DIV": 0.0,
            "DPS": 0,
            "_source": "naver",
        }
    except Exception:
        return {}


# ── 공개 API ───────────────────────────────────────────────

async def get_stock_price(ticker: str, days: int = 30) -> dict:
    if HAS_PYKRX:
        try:
            end = get_today()
            start = get_date_before(days)
            df = krx_stock.get_market_ohlcv_by_date(start, end, ticker)
            if df.empty:
                return {"error": f"{ticker} 데이터 없음"}

            latest = df.iloc[-1]
            prev = df.iloc[-2] if len(df) > 1 else df.iloc[-1]

            return {
                "ticker": ticker,
                "date": df.index[-1].strftime("%Y-%m-%d"),
                "close": int(latest["종가"]),
                "open": int(latest["시가"]),
                "high": int(latest["고가"]),
                "low": int(latest["저가"]),
                "volume": int(latest["거래량"]),
                "change_pct": round((latest["종가"] - prev["종가"]) / prev["종가"] * 100, 2) if prev["종가"] else 0.0,
                "history": {
                    str(idx.strftime("%Y-%m-%d")): {
                        "close": int(row["종가"]),
                        "volume": int(row["거래량"]),
                    }
                    for idx, row in df.iterrows()
                },
            }
        except Exception as e:
            pass  # pykrx 실패 시 네이버로 fallback

    # 네이버 금융 fallback
    naver_data = await asyncio.get_event_loop().run_in_executor(None, _fetch_naver_price, ticker)
    if naver_data:
        return naver_data

    return _mock_price_data(ticker)


async def get_investor_trading(ticker: str, days: int = 20) -> dict:
    if not HAS_PYKRX:
        return _mock_investor_data(ticker)

    try:
        end = get_today()
        start = get_date_before(days)
        df = krx_stock.get_market_trading_value_by_date(start, end, ticker)
        if df.empty:
            return _mock_investor_data(ticker)

        summary = {
            "기간": f"{start}~{end}",
            "ticker": ticker,
        }

        for investor in ["외국인합계", "기관합계", "개인"]:
            if investor in df.columns:
                net = int(df[investor].sum())
                recent_5 = int(df[investor].tail(5).sum())
                summary[investor] = {
                    "순매수_전체": net,
                    "순매수_최근5일": recent_5,
                    "방향": "매수우위" if net > 0 else "매도우위",
                }

        summary["일별"] = {
            str(idx.strftime("%Y-%m-%d")): {
                k: int(v) for k, v in row.items()
                if k in ["외국인합계", "기관합계", "개인"]
            }
            for idx, row in df.iterrows()
        }

        return summary
    except Exception:
        # pykrx 접근 불가(클라우드 IP 차단 등) — 샘플 데이터로 fallback
        return _mock_investor_data(ticker)


async def get_market_valuation(ticker: str) -> dict:
    if HAS_PYKRX:
        try:
            today = get_today()
            start = get_date_before(5)
            df = krx_stock.get_market_fundamental_by_date(start, today, ticker)
            if not df.empty:
                latest = df.iloc[-1]
                return {
                    "ticker": ticker,
                    "date": df.index[-1].strftime("%Y-%m-%d"),
                    "PER": float(latest.get("PER", 0)),
                    "PBR": float(latest.get("PBR", 0)),
                    "EPS": float(latest.get("EPS", 0)),
                    "BPS": float(latest.get("BPS", 0)),
                    "DIV": float(latest.get("DIV", 0)),
                    "DPS": float(latest.get("DPS", 0)),
                }
        except Exception:
            pass

    # 네이버 금융 fallback
    naver_val = await asyncio.get_event_loop().run_in_executor(None, _fetch_naver_valuation, ticker)
    if naver_val:
        return naver_val

    return _mock_valuation_data(ticker)


async def get_index_data(index: str = "KOSPI", days: int = 30) -> dict:
    if not HAS_PYKRX:
        return _mock_index_data(index)

    index_map = {"KOSPI": "1001", "KOSDAQ": "2001", "KOSPI200": "1028"}
    code = index_map.get(index, "1001")

    try:
        end = get_today()
        start = get_date_before(days)
        df = krx_stock.get_index_ohlcv_by_date(start, end, code)
        if df.empty:
            return {"error": "지수 데이터 없음"}

        latest = df.iloc[-1]
        prev = df.iloc[-2] if len(df) > 1 else df.iloc[-1]
        return {
            "index": index,
            "date": df.index[-1].strftime("%Y-%m-%d"),
            "close": float(latest["종가"]),
            "change_pct": round((latest["종가"] - prev["종가"]) / prev["종가"] * 100, 2) if prev["종가"] else 0.0,
            "volume": int(latest["거래량"]),
        }
    except Exception as e:
        return {"error": str(e)}


async def get_short_selling(ticker: str, days: int = 10) -> dict:
    if not HAS_PYKRX:
        return {"공매도잔고": "N/A", "_note": "pykrx 미설치"}

    try:
        end = get_today()
        start = get_date_before(days)
        df = krx_stock.get_shorting_balance_by_date(start, end, ticker)
        if df.empty:
            return {"공매도잔고": 0}
        latest = df.iloc[-1]
        return {
            "ticker": ticker,
            "잔고수량": int(latest.get("잔고수량", 0)),
            "잔고금액": int(latest.get("잔고금액", 0)),
            "비중": float(latest.get("잔고비중", 0)),
        }
    except Exception:
        # pykrx 접근 불가(클라우드 IP 차단 등) — 데이터 없음으로 표시 (분석 파이프라인은 계속 진행)
        return {"공매도잔고": "N/A", "_note": "데이터 수집 불가"}


def _mock_price_data(ticker: str) -> dict:
    return {
        "ticker": ticker,
        "date": datetime.now().strftime("%Y-%m-%d"),
        "close": 75_000,
        "open": 74_500,
        "high": 75_800,
        "low": 74_200,
        "volume": 15_234_567,
        "change_pct": 0.87,
        "_note": "데이터 수집 불가 — 샘플 데이터",
    }


def _mock_investor_data(ticker: str) -> dict:
    return {
        "ticker": ticker,
        "기간": f"{get_date_before(20)}~{get_today()}",
        "외국인합계": {"순매수_전체": 234_000_000_000, "순매수_최근5일": 45_000_000_000, "방향": "매수우위"},
        "기관합계": {"순매수_전체": -120_000_000_000, "순매수_최근5일": -30_000_000_000, "방향": "매도우위"},
        "개인": {"순매수_전체": -114_000_000_000, "순매수_최근5일": -15_000_000_000, "방향": "매도우위"},
        "_note": "pykrx 미설치 — 샘플 데이터",
    }


def _mock_valuation_data(ticker: str) -> dict:
    return {
        "ticker": ticker,
        "date": datetime.now().strftime("%Y-%m-%d"),
        "PER": 12.5,
        "PBR": 1.2,
        "EPS": 6_000,
        "BPS": 62_500,
        "DIV": 2.5,
        "DPS": 1_440,
        "_note": "데이터 수집 불가 — 샘플 데이터",
    }


def _mock_index_data(index: str) -> dict:
    values = {"KOSPI": 2_580.0, "KOSDAQ": 750.0, "KOSPI200": 340.0}
    return {
        "index": index,
        "date": datetime.now().strftime("%Y-%m-%d"),
        "close": values.get(index, 2_500.0),
        "change_pct": 0.45,
        "volume": 500_000_000,
        "_note": "pykrx 미설치 — 샘플 데이터",
    }
