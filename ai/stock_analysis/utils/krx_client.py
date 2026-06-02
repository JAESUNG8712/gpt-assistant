"""
KRX(한국거래소) 시세·투자자별 매매 동향 수집
pykrx 라이브러리 활용
"""

import asyncio
from datetime import datetime, timedelta
from typing import Optional

try:
    from pykrx import stock as krx_stock
    HAS_PYKRX = True
except ImportError:
    HAS_PYKRX = False


def get_today() -> str:
    return datetime.now().strftime("%Y%m%d")


def get_date_before(days: int) -> str:
    return (datetime.now() - timedelta(days=days)).strftime("%Y%m%d")


async def get_stock_price(ticker: str, days: int = 30) -> dict:
    """종목 주가 데이터 (OHLCV)"""
    if not HAS_PYKRX:
        return _mock_price_data(ticker)

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
            "change_pct": round((latest["종가"] - prev["종가"]) / prev["종가"] * 100, 2),
            "history": {
                str(idx.strftime("%Y-%m-%d")): {
                    "close": int(row["종가"]),
                    "volume": int(row["거래량"]),
                }
                for idx, row in df.iterrows()
            },
        }
    except Exception as e:
        return {"error": str(e), "ticker": ticker}


async def get_investor_trading(ticker: str, days: int = 20) -> dict:
    """
    투자자별 매매 동향 (외국인 / 기관 / 개인)
    """
    if not HAS_PYKRX:
        return _mock_investor_data(ticker)

    try:
        end = get_today()
        start = get_date_before(days)
        df = krx_stock.get_market_trading_value_by_date(start, end, ticker)
        if df.empty:
            return {"error": f"{ticker} 투자자 데이터 없음"}

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
    except Exception as e:
        return {"error": str(e), "ticker": ticker}


async def get_market_valuation(ticker: str) -> dict:
    """PER, PBR, 배당수익률 등 밸류에이션 지표"""
    if not HAS_PYKRX:
        return _mock_valuation_data(ticker)

    try:
        today = get_today()
        start = get_date_before(5)
        df = krx_stock.get_market_fundamental_by_date(start, today, ticker)
        if df.empty:
            return {"error": "밸류에이션 데이터 없음"}

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
    except Exception as e:
        return {"error": str(e)}


async def get_index_data(index: str = "KOSPI", days: int = 30) -> dict:
    """지수 데이터 조회"""
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
            "change_pct": round((latest["종가"] - prev["종가"]) / prev["종가"] * 100, 2),
            "volume": int(latest["거래량"]),
        }
    except Exception as e:
        return {"error": str(e)}


async def get_short_selling(ticker: str, days: int = 10) -> dict:
    """공매도 현황"""
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
    except Exception as e:
        return {"error": str(e)}


# ── Mock 데이터 ───────────────────────────────────────────

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
        "_note": "pykrx 미설치 — 샘플 데이터",
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
        "_note": "pykrx 미설치 — 샘플 데이터",
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
