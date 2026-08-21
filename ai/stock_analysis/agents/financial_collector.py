"""
💰 재무 자료 수집 에이전트
DART 공시 + KRX 수급 데이터 수집
"""

import asyncio
from datetime import datetime
from typing import List, Dict

from ..utils.dart_client import (
    CORP_CODES, STOCK_CODE_MAP,
    fetch_financial_statements, fetch_company_info,
    fetch_dividend_info, search_disclosures,
)
from ..utils.krx_client import (
    get_stock_price, get_investor_trading,
    get_market_valuation, get_short_selling,
    lookup_ticker_by_name,
)
from ..utils.securities_report import get_all_reports
from ..utils.news_collector import get_stock_news


class FinancialCollector:
    """💰 재무 자료 수집 담당"""

    def __init__(self, target_stocks: List[str] = None):
        self.target_stocks = target_stocks or list(CORP_CODES.keys())
        self.year = str(datetime.now().year - 1)
        self.results: Dict = {}

    async def run(self) -> Dict:
        print(f"💰 [재무수집] {len(self.target_stocks)}개 종목 수집 시작")

        tasks = [self._collect_single(name) for name in self.target_stocks]
        collected = await asyncio.gather(*tasks, return_exceptions=True)

        for name, result in zip(self.target_stocks, collected):
            if isinstance(result, Exception):
                self.results[name] = {"error": str(result)}
            else:
                self.results[name] = result

        print(f"💰 [재무수집] 완료 — {len(self.results)}개 종목")
        return self.results

    async def _collect_single(self, corp_name: str) -> Dict:
        corp_code = CORP_CODES.get(corp_name)
        ticker = next((k for k, v in STOCK_CODE_MAP.items() if v == corp_name), None)

        # ticker가 없으면 네이버 금융 자동완성으로 탐색 (LG CNS 등 신규 상장 종목)
        # 동기 requests 호출이라 이벤트 루프를 막지 않도록 executor에서 실행
        if not ticker:
            found = await asyncio.get_event_loop().run_in_executor(
                None, lookup_ticker_by_name, corp_name
            )
            if found:
                ticker = found
                STOCK_CODE_MAP[found] = corp_name  # 캐시에 등록
                print(f"💡 [{corp_name}] 네이버에서 ticker 발견: {found}")

        tasks = {}
        if corp_code:
            tasks["재무제표"] = fetch_financial_statements(corp_code, self.year)
            tasks["배당정보"] = fetch_dividend_info(corp_code, self.year)
            tasks["최근공시"] = search_disclosures(corp_name, days=60)

        if ticker:
            tasks["주가"] = get_stock_price(ticker, days=60)
            tasks["수급"] = get_investor_trading(ticker, days=30)
            tasks["밸류에이션"] = get_market_valuation(ticker)
            tasks["공매도"] = get_short_selling(ticker, days=15)
            tasks["증권사리포트"] = get_all_reports(ticker, corp_name)

        # 뉴스·기사·전문가 의견은 종목명만 있어도 수집 가능
        tasks["뉴스"] = get_stock_news(corp_name, ticker or "")

        results = {}
        if tasks:
            values = await asyncio.gather(*tasks.values(), return_exceptions=True)
            for key, val in zip(tasks.keys(), values):
                results[key] = val if not isinstance(val, Exception) else {"error": str(val)}

        results["파생지표"] = self._calc_derived(results)
        return results

    def _calc_derived(self, data: Dict) -> Dict:
        derived = {}
        fs = data.get("재무제표", {})
        price_data = data.get("주가", {})
        val = data.get("밸류에이션", {})

        try:
            revenue = fs.get("매출액", {}).get("current", 0)
            op_profit = fs.get("영업이익", {}).get("current", 0)
            net_profit = fs.get("당기순이익", {}).get("current", 0)
            total_assets = fs.get("자산총계", {}).get("current", 1)
            total_equity = fs.get("자본총계", {}).get("current", 1)
            total_debt = fs.get("부채총계", {}).get("current", 0)

            if revenue > 0:
                derived["영업이익률"] = round(op_profit / revenue * 100, 2)
                derived["순이익률"] = round(net_profit / revenue * 100, 2)

            if total_equity > 0:
                derived["ROE"] = round(net_profit / total_equity * 100, 2)

            if total_assets > 0:
                derived["ROA"] = round(net_profit / total_assets * 100, 2)

            if total_equity > 0:
                derived["부채비율"] = round(total_debt / total_equity * 100, 2)

            prev_revenue = fs.get("매출액", {}).get("previous", 0)
            if prev_revenue > 0:
                derived["매출성장률"] = round((revenue - prev_revenue) / prev_revenue * 100, 2)

            prev_op = fs.get("영업이익", {}).get("previous", 0)
            if prev_op > 0:
                derived["영업이익성장률"] = round((op_profit - prev_op) / prev_op * 100, 2)

            per = val.get("PER", 0)
            pbr = val.get("PBR", 0)
            roe = derived.get("ROE", 0)
            undervalue_score = 0
            if 0 < per < 10:
                undervalue_score += 30
            elif 0 < per < 15:
                undervalue_score += 20
            if 0 < pbr < 1:
                undervalue_score += 30
            elif 0 < pbr < 1.5:
                undervalue_score += 15
            if roe > 15:
                undervalue_score += 20
            elif roe > 10:
                undervalue_score += 10
            op_margin = derived.get("영업이익률", 0)
            if op_margin > 15:
                undervalue_score += 20
            elif op_margin > 8:
                undervalue_score += 10

            derived["저평가스코어"] = undervalue_score

        except Exception as e:
            derived["계산오류"] = str(e)

        return derived

    def get_investor_summary(self) -> List[Dict]:
        summary = []
        for corp_name, data in self.results.items():
            supply = data.get("수급", {})
            if "error" in supply:
                continue
            summary.append({
                "종목": corp_name,
                "외국인": supply.get("외국인합계", {}),
                "기관": supply.get("기관합계", {}),
                "개인": supply.get("개인", {}),
            })
        return summary

    def get_undervalued_candidates(self, min_score: int = 40) -> List[Dict]:
        candidates = []
        for name, data in self.results.items():
            score = data.get("파생지표", {}).get("저평가스코어", 0)
            if score >= min_score:
                val = data.get("밸류에이션", {})
                derived = data.get("파생지표", {})
                candidates.append({
                    "종목": name,
                    "저평가스코어": score,
                    "PER": val.get("PER"),
                    "PBR": val.get("PBR"),
                    "ROE": derived.get("ROE"),
                    "영업이익률": derived.get("영업이익률"),
                    "현재가": data.get("주가", {}).get("close"),
                })
        return sorted(candidates, key=lambda x: x["저평가스코어"], reverse=True)
