"""
저평가 저가주 스크리너 — 만원 미만 종목 중 저평가 후보 발굴
스크리닝 기준: 주가 < 10,000 / PBR < 1.2 / PER > 0 / 시가총액 > 300억 / 거래량 충분
"""

import os
from datetime import datetime, timedelta
from typing import Dict, List, Optional

try:
    from pykrx import stock as krx_stock
    HAS_PYKRX = True
except ImportError:
    HAS_PYKRX = False


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
    "max_price":      10_000,   # 주가 상한 (원)
    "min_marcap":     30_000_000_000,  # 시가총액 최소 300억 (유령주 제외)
    "max_pbr":        1.2,      # PBR 상한 (장부가치 대비 저평가)
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
        return _mock_results()

    p = {**DEFAULT_PARAMS, **(params or {})}
    date = _recent_date()
    markets = ["KOSPI", "KOSDAQ"] if market == "ALL" else [market]

    candidates = []

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

    # 점수 내림차순 정렬
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


def format_report(candidates: List[Dict], date: str = "") -> str:
    """스크리닝 결과를 보고서 형태로 포맷"""
    if not candidates:
        return "조건에 맞는 저평가 저가주를 찾지 못했습니다."

    now = date or datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        f"{'='*65}",
        f"💰 저평가 저가주 스크리닝 보고서 | {now}",
        f"{'='*65}",
        f"기준: 주가 < 10,000원 | PBR < 1.2 | PER 0.5~20 | 시총 300억+ | 거래량 5만+",
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
