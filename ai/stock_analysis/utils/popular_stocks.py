"""
인기 종목 자동 수집 — 다중 소스 fallback
1순위: pykrx (로컬 환경)
2순위: 네이버 금융 스크래핑 (Railway 등 서버 환경)
3순위: 정적 큐레이션 목록
"""

import json
import os
import re
import time
from datetime import datetime, timedelta
from typing import Dict, List, Tuple

try:
    from pykrx import stock as krx_stock
    HAS_PYKRX = True
except Exception as _pykrx_err:
    HAS_PYKRX = False
    print(f"[krx] pykrx 초기화 실패 — pykrx 없이 동작합니다: "
          f"{type(_pykrx_err).__name__}: {_pykrx_err}")

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

CACHE_FILE = os.path.join(os.path.dirname(__file__), "popular_cache.json")
_CACHE_TTL_HOURS = 24

_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://finance.naver.com/",
    "Accept-Language": "ko-KR,ko;q=0.9",
}

# 수집 실패 시 기본 제공할 주요 종목 (시가총액/거래량 상위 30개)
_STATIC_FALLBACK: Dict[str, str] = {
    "삼성전자": "005930", "SK하이닉스": "000660", "LG에너지솔루션": "373220",
    "삼성바이오로직스": "207940", "현대차": "005380", "기아": "000270",
    "POSCO홀딩스": "005490", "삼성SDI": "006400", "LG화학": "051910",
    "셀트리온": "068270", "KB금융": "105560", "신한지주": "055550",
    "하나금융지주": "086790", "카카오": "035720", "NAVER": "035420",
    "LG전자": "066570", "현대모비스": "012330", "삼성물산": "028260",
    "SK이노베이션": "096770", "두산에너빌리티": "034020",
    "한국전력": "015760", "고려아연": "010130", "KT&G": "033780",
    "삼성전기": "009150", "SK": "034730", "포스코퓨처엠": "003670",
    "에코프로비엠": "247540", "에코프로": "086520",
    "HD현대일렉트릭": "267260", "두산로보틱스": "454910",
}


# ── 소스 1: pykrx ─────────────────────────────────────────

def _fetch_via_pykrx(top_n: int = 50, market: str = "ALL") -> Dict[str, str]:
    if not HAS_PYKRX:
        return {}

    # 최근 3 영업일 후퇴 시도 (공휴일 대응)
    base = datetime.now()
    if base.hour < 9:
        base -= timedelta(days=1)
    dates = []
    tmp = base
    for _ in range(10):
        if tmp.weekday() < 5:
            dates.append(tmp.strftime("%Y%m%d"))
            if len(dates) >= 3:
                break
        tmp -= timedelta(days=1)

    markets = ["KOSPI", "KOSDAQ"] if market == "ALL" else [market]
    result: Dict[str, str] = {}

    for date in dates:
        if result:
            break
        for mkt in markets:
            try:
                df = krx_stock.get_market_ohlcv_by_ticker(date, market=mkt)
                if df is None or df.empty:
                    continue
                col = next(
                    (c for c in ["거래대금", "TradingValue"] if c in df.columns),
                    None,
                )
                if col is None:
                    nums = df.select_dtypes(include="number").columns.tolist()
                    col = nums[-1] if nums else None
                if col is None:
                    continue
                df = df.sort_values(col, ascending=False).head(top_n)
                for ticker in df.index:
                    name = krx_stock.get_market_ticker_name(ticker)
                    if name and len(name) <= 15:
                        result[name] = str(ticker)
            except Exception:
                continue

    return result


# ── 소스 2: 네이버 금융 스크래핑 ─────────────────────────────

def _fetch_via_naver(top_n: int = 50) -> Dict[str, str]:
    """
    네이버 금융 거래량 상위 페이지 스크래핑.
    Railway 등 서버 환경에서 pykrx 대체.
    """
    if not HAS_REQUESTS:
        return {}

    result: Dict[str, str] = {}
    # sosok=0: KOSPI, sosok=1: KOSDAQ
    for sosok in ["0", "1"]:
        if len(result) >= top_n:
            break
        for page in range(1, 4):  # 최대 3페이지 = 약 60종목
            try:
                url = "https://finance.naver.com/sise/sise_quant.naver"
                resp = requests.get(
                    url,
                    params={"sosok": sosok, "page": page},
                    headers=_HTTP_HEADERS,
                    timeout=10,
                )
                html = resp.content.decode("euc-kr", errors="replace")

                # 종목 코드 + 이름 추출
                matches = re.findall(
                    r'href="/item/main\.naver\?code=(\d{6})"[^>]*>([^<]+)</a>',
                    html,
                )
                found_on_page = 0
                for ticker, name in matches:
                    name = name.strip()
                    if not name or len(name) > 15:
                        continue
                    if name in result:
                        continue
                    result[name] = ticker
                    found_on_page += 1

                # 결과 없으면 더 이상 페이지 없음
                if found_on_page == 0:
                    break

                time.sleep(0.3)  # 요청 간 짧은 딜레이
            except Exception:
                break

    return result


# ── 공개 API ───────────────────────────────────────────────

def fetch_popular_stocks(top_n: int = 50, market: str = "ALL") -> Tuple[Dict[str, str], str]:
    """
    다중 소스로 인기 종목 수집.
    Returns: (결과 dict, 사용된 소스 이름)
    """
    # 1순위: pykrx
    pykrx_result = _fetch_via_pykrx(top_n, market)
    if pykrx_result:
        return pykrx_result, "pykrx"

    # 2순위: 네이버 금융
    naver_result = _fetch_via_naver(top_n)
    if naver_result:
        return naver_result, "네이버금융"

    # 3순위: 정적 목록 (항상 성공)
    return dict(list(_STATIC_FALLBACK.items())[:top_n]), "정적목록"


def load_cache() -> Tuple[Dict[str, str], str]:
    if not os.path.exists(CACHE_FILE):
        return {}, ""
    try:
        with open(CACHE_FILE, encoding="utf-8") as f:
            d = json.load(f)
        return d.get("stocks", {}), d.get("updated_at", "")
    except Exception:
        return {}, ""


def save_cache(stocks: Dict[str, str], source: str = ""):
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump({
                "stocks": stocks,
                "updated_at": datetime.now().isoformat(),
                "source": source,
            }, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def is_cache_fresh() -> bool:
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
    인기 종목 수집 후 CORP_CODES / STOCK_CODE_MAP에 등록.
    캐시 신선하면 재사용 (force=True 이면 강제 갱신).
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

    popular, source = fetch_popular_stocks(top_n)

    added = _register(popular, CORP_CODES, STOCK_CODE_MAP)
    save_cache(popular, source)

    return {
        "추가종목": added,
        "전체인기종목": list(popular.keys()),
        "총종목수": len(CORP_CODES),
        "갱신시각": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "소스": source,
        "캐시": False,
    }


def _register(
    popular: Dict[str, str],
    corp_codes: Dict[str, str],
    stock_map: Dict[str, str],
) -> List[str]:
    added = []
    for name, ticker in popular.items():
        if name not in corp_codes:
            corp_codes[name] = ""
            added.append(name)
        if ticker not in stock_map:
            stock_map[ticker] = name
    return added
