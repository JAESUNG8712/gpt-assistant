"""
인기 종목 자동 수집 — pykrx 거래량/거래대금 기준 상위 종목을 CORP_CODES에 동적 등록
"""

import json
import os
from datetime import datetime, timedelta
from typing import Dict, List, Tuple

try:
    from pykrx import stock as krx_stock
    HAS_PYKRX = True
except ImportError:
    HAS_PYKRX = False

CACHE_FILE = os.path.join(os.path.dirname(__file__), "popular_cache.json")
_CACHE_TTL_HOURS = 24  # 캐시 유효시간


def _get_recent_trading_date() -> str:
    """최근 거래일 반환 (주말 건너뜀)"""
    dt = datetime.now()
    # 오전 9시 이전이면 전전일부터 탐색
    if dt.hour < 9:
        dt -= timedelta(days=1)
    for _ in range(7):
        if dt.weekday() < 5:  # 월~금
            return dt.strftime("%Y%m%d")
        dt -= timedelta(days=1)
    return (datetime.now() - timedelta(days=3)).strftime("%Y%m%d")


def fetch_popular_stocks(top_n: int = 50, market: str = "ALL") -> Dict[str, str]:
    """
    pykrx 거래대금 기준 상위 종목 수집.
    Returns: {종목명: KRX티커코드}
    """
    if not HAS_PYKRX:
        return {}

    date = _get_recent_trading_date()
    result: Dict[str, str] = {}

    markets = ["KOSPI", "KOSDAQ"] if market == "ALL" else [market]
    for mkt in markets:
        try:
            df = krx_stock.get_market_trading_value_by_ticker(date, date, mkt)
            if df is None or df.empty:
                continue
            df = df.sort_values("거래대금", ascending=False).head(top_n)
            for ticker in df.index:
                name = krx_stock.get_market_ticker_name(ticker)
                if name and len(name) <= 15:  # 너무 긴 이름(ETF 등) 제외
                    result[name] = ticker
        except Exception:
            continue

    return result


def load_cache() -> Tuple[Dict[str, str], str]:
    """캐시 파일에서 인기 종목 로드. Returns: (data, updated_at)"""
    if not os.path.exists(CACHE_FILE):
        return {}, ""
    try:
        with open(CACHE_FILE, encoding="utf-8") as f:
            d = json.load(f)
        return d.get("stocks", {}), d.get("updated_at", "")
    except Exception:
        return {}, ""


def save_cache(stocks: Dict[str, str]):
    """인기 종목을 캐시 파일에 저장"""
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump({
                "stocks": stocks,
                "updated_at": datetime.now().isoformat(),
            }, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def is_cache_fresh() -> bool:
    """캐시가 TTL 이내인지 확인"""
    _, updated_at = load_cache()
    if not updated_at:
        return False
    try:
        age = datetime.now() - datetime.fromisoformat(updated_at)
        return age.total_seconds() < _CACHE_TTL_HOURS * 3600
    except Exception:
        return False


def refresh_popular_stocks(top_n: int = 50, force: bool = False) -> Dict:
    """
    인기 종목을 새로 수집해서 CORP_CODES / STOCK_CODE_MAP에 동적 등록.
    캐시가 신선하면 캐시 사용 (force=True이면 강제 갱신).
    Returns: {"추가종목": [...], "총종목수": N, "갱신시각": "..."}
    """
    from .dart_client import CORP_CODES, STOCK_CODE_MAP

    if not force and is_cache_fresh():
        cached, updated_at = load_cache()
        _register(cached, CORP_CODES, STOCK_CODE_MAP)
        return {
            "추가종목": list(cached.keys()),
            "총종목수": len(CORP_CODES),
            "갱신시각": updated_at,
            "캐시": True,
        }

    if not HAS_PYKRX:
        return {"오류": "pykrx 미설치 — pip install pykrx", "총종목수": len(CORP_CODES)}

    popular = fetch_popular_stocks(top_n)
    if not popular:
        return {"오류": "종목 수집 실패 (KRX 연결 확인)", "총종목수": len(CORP_CODES)}

    added = _register(popular, CORP_CODES, STOCK_CODE_MAP)
    save_cache(popular)

    return {
        "추가종목": added,
        "전체인기종목": list(popular.keys()),
        "총종목수": len(CORP_CODES),
        "갱신시각": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "캐시": False,
    }


def _register(
    popular: Dict[str, str],
    corp_codes: Dict[str, str],
    stock_map: Dict[str, str],
) -> List[str]:
    """popular {이름: 티커}를 CORP_CODES·STOCK_CODE_MAP에 등록. 새로 추가된 이름 목록 반환."""
    added = []
    for name, ticker in popular.items():
        if name not in corp_codes:
            corp_codes[name] = ""  # DART 코드 미상 → mock 데이터 사용
            added.append(name)
        if ticker not in stock_map:
            stock_map[ticker] = name
    return added
