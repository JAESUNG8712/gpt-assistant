"""
저평가 저가주 스크리너 — 2만원 미만 종목 중 저평가 후보 발굴
스크리닝 기준: 주가 < 20,000 / PBR < 1.5 / PER > 0 / 시가총액 > 300억 / 거래량 충분

pykrx가 클라우드 환경(Railway 등)에서 KRX 직접 API 호출이 차단되어 빈 결과만
반환하는 경우가 있음(이미 popular_stocks.py/krx_client.py에서 같은 문제로
네이버 금융 fallback을 쓰고 있음). 이 모듈은 pykrx 전체 종목 스캔이 실패하면
2단계로 네이버 금융을 이용해 KOSPI+KOSDAQ 전 종목을 스캔한다.
  1단계: finance.naver.com 시가총액 순위 페이지(전 종목, 페이지네이션)에서
         종목코드/현재가/PER/거래량/시가총액을 긁어와 가격·PER·거래량·시총
         기준으로 1차 필터링 (PBR 정보가 없는 페이지라 PBR 필터는 아직 적용 안 함)
  2단계: 1차 통과 종목만 네이버 모바일 API로 개별 조회해 PBR/BPS/배당률을
         얻고 최종 필터·점수 계산
전체 종목을 긁지만 1차 필터로 후보를 좁혀두기 때문에 2단계 호출 수가
적어 실행 시간이 과도하게 늘지 않는다. 1단계 자체가 실패하면(네트워크
차단 등) 인기 종목 캐시 기반의 좁은 후보군 fallback(_screen_via_naver)으로
한 번 더 재시도한다.
"""

import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Dict, List, Optional

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

_NAVER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://finance.naver.com/",
}


def _recent_date() -> str:
    dt = datetime.now()
    if dt.hour < 9:
        dt -= timedelta(days=1)
    for _ in range(7):
        if dt.weekday() < 5:
            return dt.strftime("%Y%m%d")
        dt -= timedelta(days=1)
    return (datetime.now() - timedelta(days=3)).strftime("%Y%m%d")


# 스크리닝 기본값
DEFAULT_PARAMS = {
    "max_price":      20_000,   # 주가 상한 (원)
    "min_marcap":     30_000_000_000,  # 시가총액 최소 300억 (유령주 제외)
    "max_pbr":        1.5,      # PBR 상한 (장부가치 대비 저평가)
    "min_per":        0.5,      # PER 최소 (적자 기업 제외)
    "max_per":        20.0,     # PER 상한 (지나치게 고평가 제외)
    "min_volume":     50_000,   # 최소 일 거래량 (유동성 확보)
    "top_n":          20,       # 최종 결과 상위 N개
}


def screen_low_price_stocks(
    market: str = "ALL",
    params: Optional[Dict] = None,
) -> List[Dict]:
    """
    만원 미만 저평가 종목 스크리닝.
    Returns: 점수 순 정렬된 후보 종목 리스트
    """
    if not HAS_PYKRX:
        return _screen_full_market_via_naver(params) or _screen_via_naver(params) or _mock_results()

    p = {**DEFAULT_PARAMS, **(params or {})}
    date = _recent_date()
    markets = ["KOSPI", "KOSDAQ"] if market == "ALL" else [market]

    candidates = []
    fetched_any_market = False

    for mkt in markets:
        try:
            # 1) 전체 종목 시세 (주가 + 거래량)
            ohlcv = krx_stock.get_market_ohlcv_by_ticker(date, mkt)
            # 2) 전체 종목 펀더멘털 (PER, PBR, EPS, BPS, DIV)
            fund = krx_stock.get_market_fundamental_by_ticker(date, mkt)
            # 3) 시가총액
            cap = krx_stock.get_market_cap_by_ticker(date, mkt)

            if ohlcv is None or ohlcv.empty:
                continue
            fetched_any_market = True

            for ticker in ohlcv.index:
                try:
                    close   = int(ohlcv.loc[ticker, "종가"])
                    volume  = int(ohlcv.loc[ticker, "거래량"])
                    marcap  = int(cap.loc[ticker, "시가총액"]) if ticker in cap.index else 0

                    per = float(fund.loc[ticker, "PER"]) if ticker in fund.index else 0
                    pbr = float(fund.loc[ticker, "PBR"]) if ticker in fund.index else 0
                    bps = float(fund.loc[ticker, "BPS"]) if ticker in fund.index else 0
                    div = float(fund.loc[ticker, "DIV"]) if ticker in fund.index else 0

                    # ── 필터링 ──────────────────────────────
                    if close <= 0 or close >= p["max_price"]:
                        continue
                    if marcap < p["min_marcap"]:
                        continue
                    if volume < p["min_volume"]:
                        continue
                    if pbr <= 0 or pbr > p["max_pbr"]:
                        continue
                    if per < p["min_per"] or per > p["max_per"]:
                        continue

                    # ── 저평가 점수 계산 (0~100) ──────────
                    score = _calc_score(close, per, pbr, bps, div, volume, marcap)

                    name = krx_stock.get_market_ticker_name(ticker)
                    candidates.append({
                        "종목코드": ticker,
                        "종목명": name or ticker,
                        "시장": mkt,
                        "현재가": close,
                        "PER": round(per, 1),
                        "PBR": round(pbr, 2),
                        "BPS": int(bps),
                        "배당수익률": round(div, 2),
                        "시가총액억": round(marcap / 1e8, 0),
                        "거래량": volume,
                        "저평가점수": score,
                        "괴리율": round((bps - close) / bps * 100, 1) if bps and close and bps > 0 and bps > close else 0,
                    })
                except Exception:
                    continue
        except Exception:
            continue

    # pykrx가 모든 시장에서 전체 종목 시세 자체를 못 가져온 경우(클라우드 IP 차단 등)
    # — 조건에 안 맞아 0건인 것과 구분해 네이버 fallback으로 재시도
    if not fetched_any_market:
        return _screen_full_market_via_naver(params) or _screen_via_naver(params) or _mock_results()

    # 점수 내림차순 정렬
    candidates.sort(key=lambda x: x["저평가점수"], reverse=True)
    return candidates[:p["top_n"]]


# ── 네이버 모바일 API fallback (pykrx가 클라우드에서 차단될 때) ──────

def _parse_naver_marketcap_eok(text: str) -> float:
    """'2,104조 6,603억' / '480억' 형식을 억원 단위 숫자로 변환"""
    if not text:
        return 0.0
    text = text.replace(",", "")
    jo_m = re.search(r"([\d.]+)조", text)
    eok_m = re.search(r"([\d.]+)억", text)
    jo = float(jo_m.group(1)) if jo_m else 0.0
    eok = float(eok_m.group(1)) if eok_m else 0.0
    return jo * 10_000 + eok


def _fetch_naver_snapshot(ticker: str) -> Optional[Dict]:
    """네이버 모바일 종합 API로 단일 종목의 시세+펀더멘털 조회"""
    if not HAS_REQUESTS:
        return None
    try:
        basic = requests.get(
            f"https://m.stock.naver.com/api/stock/{ticker}/basic",
            headers=_NAVER_HEADERS, timeout=6,
        ).json()
        integ = requests.get(
            f"https://m.stock.naver.com/api/stock/{ticker}/integration",
            headers=_NAVER_HEADERS, timeout=6,
        ).json()

        close = float(str(basic.get("closePrice", "0")).replace(",", "") or 0)

        infos = {i["code"]: i.get("value", "") for i in integ.get("totalInfos", [])}
        volume = float(str(infos.get("accumulatedTradingVolume", "0")).replace(",", "") or 0)
        marcap = _parse_naver_marketcap_eok(infos.get("marketValue", "")) * 1e8
        per = float(re.sub(r"[^\d.]", "", infos.get("per", "")) or 0)
        pbr = float(re.sub(r"[^\d.]", "", infos.get("pbr", "")) or 0)
        bps = float(re.sub(r"[^\d.]", "", infos.get("bps", "")) or 0)
        div = float(re.sub(r"[^\d.]", "", infos.get("dividendYieldRatio", "")) or 0)

        if close <= 0:
            return None
        return {
            "close": int(close), "volume": int(volume), "marcap": int(marcap),
            "per": per, "pbr": pbr, "bps": bps, "div": div,
        }
    except Exception:
        return None


# ── 네이버 전체 시장 순위 페이지 스캔 (pykrx 차단 시 1순위 fallback) ──

_MARKET_SUM_URL = "https://finance.naver.com/sise/sise_market_sum.naver"
_MAX_KOSPI_PAGES = 30   # KOSPI 상장종목 ~960개 → 50개/페이지 기준 여유있게
_MAX_KOSDAQ_PAGES = 45  # KOSDAQ 상장종목 ~1,700개 → 50개/페이지 기준 여유있게


def _fetch_market_summary_page(sosok: str, page: int) -> List[Dict]:
    """네이버 금융 시가총액 순위 페이지 1개 파싱 → [{ticker,name,close,marcap_eok,volume,per,market}]"""
    if not HAS_REQUESTS:
        return []
    try:
        resp = requests.get(
            _MARKET_SUM_URL, params={"sosok": sosok, "page": page},
            headers=_NAVER_HEADERS, timeout=8,
        )
        html = resp.content.decode("euc-kr", errors="replace")
    except Exception:
        return []

    market = "KOSPI" if sosok == "0" else "KOSDAQ"
    rows = re.findall(r"<tr[^>]*>.*?</tr>", html, re.S)
    out = []
    for r in rows:
        m = re.search(r'code=(\d{6})[^>]*>([^<]+)</a>', r)
        if not m:
            continue
        ticker, name = m.group(1), m.group(2).strip()
        tds = [re.sub(r"<[^>]+>", "", t).strip() for t in re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)]
        if len(tds) < 11:
            continue
        try:
            close = float(tds[2].replace(",", "") or 0)
            marcap_eok = float(tds[6].replace(",", "") or 0)
            volume = float(tds[9].replace(",", "") or 0)
            per = float(tds[10].replace(",", "") or 0)
        except ValueError:
            continue
        out.append({
            "ticker": ticker, "name": name, "close": close,
            "marcap_eok": marcap_eok, "volume": volume, "per": per, "market": market,
        })
    return out


def _fetch_full_market_listing() -> List[Dict]:
    """KOSPI+KOSDAQ 전 종목 시가총액 순위를 병렬로 긁어와 중복 제거 후 반환"""
    if not HAS_REQUESTS:
        return []

    tasks = [("0", p) for p in range(1, _MAX_KOSPI_PAGES + 1)]
    tasks += [("1", p) for p in range(1, _MAX_KOSDAQ_PAGES + 1)]

    rows: List[Dict] = []
    with ThreadPoolExecutor(max_workers=16) as ex:
        futures = [ex.submit(_fetch_market_summary_page, sosok, page) for sosok, page in tasks]
        for fut in as_completed(futures):
            rows.extend(fut.result())

    seen = set()
    listing = []
    for r in rows:
        if r["ticker"] in seen:
            continue
        seen.add(r["ticker"])
        listing.append(r)
    return listing


def _screen_full_market_via_naver(params: Optional[Dict] = None) -> List[Dict]:
    """pykrx 전체 종목 스캔 실패 시 1순위 fallback: 네이버 시가총액 순위 페이지로
    KOSPI+KOSDAQ 전 종목을 1차 필터링(가격/PER/거래량/시총)한 뒤, 통과한 종목만
    네이버 모바일 API로 개별 조회해 PBR/BPS/배당률을 확인하고 최종 필터링한다."""
    if not HAS_REQUESTS:
        print("[lowprice_screener] requests 모듈 없음 — 전체시장 네이버 fallback 불가")
        return []

    p = {**DEFAULT_PARAMS, **(params or {})}
    listing = _fetch_full_market_listing()
    print(f"[lowprice_screener] 전체시장 종목 {len(listing)}개 수집")
    if not listing:
        return []

    stage1 = [
        r for r in listing
        if 0 < r["close"] < p["max_price"]
        and r["marcap_eok"] * 1e8 >= p["min_marcap"]
        and r["volume"] >= p["min_volume"]
        and p["min_per"] <= r["per"] <= p["max_per"]
    ]
    print(f"[lowprice_screener] 1차 필터(가격/PER/거래량/시총) 통과 {len(stage1)}개 — PBR 확인 단계 진입")
    if not stage1:
        return []

    candidates = []
    ok, fail = 0, 0
    with ThreadPoolExecutor(max_workers=16) as ex:
        futures = {ex.submit(_fetch_naver_snapshot, r["ticker"]): r for r in stage1}
        for fut in as_completed(futures):
            row = futures[fut]
            snap = fut.result()
            if not snap:
                fail += 1
                continue
            ok += 1
            close, volume, marcap = snap["close"], snap["volume"], snap["marcap"]
            per, pbr, bps, div = snap["per"], snap["pbr"], snap["bps"], snap["div"]

            if close <= 0 or close >= p["max_price"]:
                continue
            if marcap and marcap < p["min_marcap"]:
                continue
            if volume < p["min_volume"]:
                continue
            if pbr <= 0 or pbr > p["max_pbr"]:
                continue
            if per < p["min_per"] or per > p["max_per"]:
                continue

            score = _calc_score(close, per, pbr, bps, div, volume, marcap)
            candidates.append({
                "종목코드": row["ticker"],
                "종목명": row["name"],
                "시장": row["market"],
                "현재가": close,
                "PER": round(per, 1),
                "PBR": round(pbr, 2),
                "BPS": int(bps),
                "배당수익률": round(div, 2),
                "시가총액억": round(marcap / 1e8, 0),
                "거래량": volume,
                "저평가점수": score,
                "괴리율": round((bps - close) / bps * 100, 1) if bps and close and bps > 0 and bps > close else 0,
            })

    print(f"[lowprice_screener] 전체시장 PBR 확인 결과 성공={ok} 실패={fail} 최종통과={len(candidates)}")
    candidates.sort(key=lambda x: x["저평가점수"], reverse=True)
    return candidates[:p["top_n"]]


def _candidate_pool() -> Dict[str, str]:
    """fallback 스캔용 종목 후보군(이름→코드) — 인기 종목 캐시 + 정적 큐레이션 목록"""
    pool: Dict[str, str] = {}
    try:
        from .popular_stocks import load_cache, fetch_popular_stocks, _STATIC_FALLBACK
        cached, _ = load_cache()
        pool.update(cached)
        if len(pool) < 30:
            fetched, source = fetch_popular_stocks(top_n=80)
            pool.update(fetched)
            print(f"[lowprice_screener] 인기종목 신규수집 소스={source} {len(fetched)}개")
        pool.update(_STATIC_FALLBACK)
    except Exception as e:
        print(f"[lowprice_screener] 후보군 수집 실패: {e}")
    return pool


def _screen_via_naver(params: Optional[Dict] = None) -> List[Dict]:
    """pykrx 전체 종목 스캔 실패 시: 인기 종목 후보군을 네이버 모바일 API로 개별 조회.
    전체 시장 스캔이 아니라 후보군(최대 ~150종목) 한정 스캔이라 커버리지가 좁다."""
    if not HAS_REQUESTS:
        print("[lowprice_screener] requests 모듈 없음 — 네이버 fallback 불가")
        return []

    p = {**DEFAULT_PARAMS, **(params or {})}
    pool = _candidate_pool()
    print(f"[lowprice_screener] 네이버 fallback 후보군 {len(pool)}개 조회 시작")
    if not pool:
        return []

    candidates = []
    ok, fail = 0, 0
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = {ex.submit(_fetch_naver_snapshot, ticker): (name, ticker) for name, ticker in pool.items()}
        for fut in as_completed(futures):
            name, ticker = futures[fut]
            snap = fut.result()
            if not snap:
                fail += 1
                continue
            ok += 1
            close, volume, marcap = snap["close"], snap["volume"], snap["marcap"]
            per, pbr, bps, div = snap["per"], snap["pbr"], snap["bps"], snap["div"]

            if close <= 0 or close >= p["max_price"]:
                continue
            if marcap and marcap < p["min_marcap"]:
                continue
            if volume < p["min_volume"]:
                continue
            if pbr <= 0 or pbr > p["max_pbr"]:
                continue
            if per < p["min_per"] or per > p["max_per"]:
                continue

            score = _calc_score(close, per, pbr, bps, div, volume, marcap)
            candidates.append({
                "종목코드": ticker,
                "종목명": name,
                "시장": "-",
                "현재가": close,
                "PER": round(per, 1),
                "PBR": round(pbr, 2),
                "BPS": int(bps),
                "배당수익률": round(div, 2),
                "시가총액억": round(marcap / 1e8, 0),
                "거래량": volume,
                "저평가점수": score,
                "괴리율": round((bps - close) / bps * 100, 1) if bps and close and bps > 0 and bps > close else 0,
            })

    print(f"[lowprice_screener] 네이버 fallback 조회 결과 성공={ok} 실패={fail} 기준통과={len(candidates)}")
    candidates.sort(key=lambda x: x["저평가점수"], reverse=True)
    return candidates[:p["top_n"]]


def _calc_score(close: float, per: float, pbr: float, bps: float,
                div: float, volume: int, marcap: int) -> int:
    """저평가 종합 점수 (0~100)"""
    score = 0

    # PBR 점수 (40점): 낮을수록 우수
    if pbr < 0.3:   score += 40
    elif pbr < 0.5: score += 33
    elif pbr < 0.7: score += 25
    elif pbr < 1.0: score += 16
    else:           score += 8

    # PER 점수 (30점): 낮을수록 우수 (단, 0 이하 제외)
    if 0 < per < 5:    score += 30
    elif per < 8:      score += 24
    elif per < 12:     score += 18
    elif per < 15:     score += 12
    else:              score += 5

    # BPS 대비 괴리율 (20점): 주가가 장부가치보다 낮을수록 우수
    if bps > 0:
        gap = (bps - close) / bps
        if gap > 0.7:   score += 20
        elif gap > 0.5: score += 16
        elif gap > 0.3: score += 12
        elif gap > 0.1: score += 7
        # close > bps: 0점

    # 배당수익률 (10점)
    if div >= 5:    score += 10
    elif div >= 3:  score += 7
    elif div >= 1:  score += 4

    return min(score, 100)


def format_report(candidates: List[Dict], date: str = "", params: Optional[Dict] = None) -> str:
    """스크리닝 결과를 보고서 형태로 포맷"""
    if not candidates:
        return "조건에 맞는 저평가 저가주를 찾지 못했습니다."

    p = {**DEFAULT_PARAMS, **(params or {})}
    now = date or datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        f"{'='*65}",
        f"💰 저평가 저가주 스크리닝 보고서 | {now}",
        f"{'='*65}",
        f"기준: 주가 < {p['max_price']:,}원 | PBR < {p['max_pbr']} | "
        f"PER {p['min_per']}~{p['max_per']} | 시총 {p['min_marcap']/1e8:,.0f}억+ | "
        f"거래량 {p['min_volume']:,}+",
        f"대상: KOSPI + KOSDAQ 전체",
        "",
        f"{'순위':<4} {'종목명':<14} {'시장':<7} {'현재가':>7} {'PER':>6} {'PBR':>5} "
        f"{'BPS':>8} {'배당%':>6} {'시총억':>7} {'점수':>5}",
        "─" * 65,
    ]

    for i, c in enumerate(candidates, 1):
        lines.append(
            f"{i:<4} {c['종목명']:<14} {c['시장']:<7} "
            f"{c['현재가']:>7,} {c['PER']:>6.1f} {c['PBR']:>5.2f} "
            f"{c['BPS']:>8,} {c['배당수익률']:>6.1f} "
            f"{c['시가총액억']:>7,.0f} {c['저평가점수']:>5}"
        )

    lines += [
        "",
        "【 TOP 5 상세 분석 】",
        "─" * 65,
    ]
    for c in candidates[:5]:
        gap_str = f"장부가 대비 {c['괴리율']:.1f}% 저평가" if c["괴리율"] > 0 else "장부가 초과"
        lines += [
            f"",
            f"▶ {c['종목명']} ({c['종목코드']}) — {c['시장']}",
            f"  현재가: {c['현재가']:,}원  |  BPS: {c['BPS']:,}원  |  {gap_str}",
            f"  PER: {c['PER']}배  |  PBR: {c['PBR']}배  |  배당수익률: {c['배당수익률']}%",
            f"  시가총액: {c['시가총액억']:,.0f}억원  |  저평가점수: {c['저평가점수']}/100",
        ]

    lines += [
        "",
        "─" * 65,
        "⚠️  본 스크리닝은 기계적 수치 분석이며 투자 권유가 아닙니다.",
        "    최종 투자 판단은 반드시 추가 분석 후 본인이 결정하세요.",
        f"{'='*65}",
    ]
    return "\n".join(lines)


def _mock_results() -> List[Dict]:
    """pykrx 미설치 시 mock 데이터"""
    return [
        {"종목코드": "000100", "종목명": "(샘플)저평가A", "시장": "KOSPI",
         "현재가": 3200, "PER": 6.2, "PBR": 0.45, "BPS": 7100,
         "배당수익률": 3.5, "시가총액억": 480, "거래량": 120000,
         "저평가점수": 78, "괴리율": 54.9},
        {"종목코드": "001200", "종목명": "(샘플)저평가B", "시장": "KOSDAQ",
         "현재가": 5800, "PER": 9.1, "PBR": 0.68, "BPS": 8500,
         "배당수익률": 2.1, "시가총액억": 620, "거래량": 80000,
         "저평가점수": 62, "괴리율": 31.8},
    ]
