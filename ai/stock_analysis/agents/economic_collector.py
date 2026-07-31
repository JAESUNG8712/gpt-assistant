"""
📊 경제 자료 수집 에이전트
거시경제 지표, 금리, 환율, 지수 데이터 수집
"""

import asyncio
import aiohttp
import json
import os
from datetime import datetime, timedelta
from typing import Dict, Optional


BOK_API_KEY = os.getenv("BOK_API_KEY", "")
BOK_BASE_URL = "https://ecos.bok.or.kr/api"


async def _fetch_bok_latest(stat_code: str, item_code: str, cycle: str = "M",
                             lookback_periods: int = 12) -> Optional[dict]:
    """한국은행 ECOS 통계 API에서 지정 통계의 가장 최근 값 1건을 조회.
    BOK_API_KEY 미설정/요청 실패/데이터 없음 시 None 반환 (호출부에서 정적 fallback 사용)."""
    if not BOK_API_KEY:
        return None

    end = datetime.now()
    if cycle == "D":
        start = end - timedelta(days=lookback_periods)
        fmt = "%Y%m%d"
    else:
        start = end - timedelta(days=31 * lookback_periods)
        fmt = "%Y%m"

    url = (
        f"{BOK_BASE_URL}/StatisticSearch/{BOK_API_KEY}/json/kr/1/100/"
        f"{stat_code}/{cycle}/{start.strftime(fmt)}/{end.strftime(fmt)}/{item_code}"
    )
    try:
        async with aiohttp.ClientSession(trust_env=True) as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
                rows = data.get("StatisticSearch", {}).get("row", [])
                if not rows:
                    return None
                latest = rows[-1]
                return {"value": float(latest["DATA_VALUE"]), "time": latest["TIME"]}
    except Exception:
        return None


class EconomicCollector:
    """📊 경제 자료 수집 담당"""

    def __init__(self):
        self.results: Dict = {}

    async def run(self) -> Dict:
        print("📊 [경제수집] 거시경제 지표 수집 시작")

        tasks = [
            self._collect_interest_rates(),
            self._collect_exchange_rates(),
            self._collect_inflation(),
            self._collect_market_indices(),
            self._collect_commodities(),
            self._collect_economic_calendar(),
        ]

        (
            rates, fx, inflation, indices, commodities, calendar
        ) = await asyncio.gather(*tasks, return_exceptions=True)

        self.results = {
            "금리": rates if not isinstance(rates, Exception) else {"error": str(rates)},
            "환율": fx if not isinstance(fx, Exception) else {"error": str(fx)},
            "물가": inflation if not isinstance(inflation, Exception) else {"error": str(inflation)},
            "지수": indices if not isinstance(indices, Exception) else {"error": str(indices)},
            "원자재": commodities if not isinstance(commodities, Exception) else {"error": str(commodities)},
            "경제캘린더": calendar if not isinstance(calendar, Exception) else {"error": str(calendar)},
            "수집시각": datetime.now().isoformat(),
        }
        self.results["시장심리"] = self.get_market_sentiment()
        # aggregator.py/claude_client.py가 최상위 "종합판단" 키를 읽는데
        # get_macro_signal()이 호출되지 않아 늘 "정보없음"/"중립" 기본값으로 빠지던 문제 수정
        self.results["종합판단"] = self.get_macro_signal()["종합판단"]

        print("📊 [경제수집] 완료")
        return self.results

    async def _collect_interest_rates(self) -> Dict:
        # 한국기준금리(722Y001/0101000)는 BOK_API_KEY 설정 시 ECOS에서 실시간 조회,
        # 미설정/조회실패 시 아래 정적값으로 fallback (그 외 항목은 ECOS에 안정적인
        # 동등 시계열이 없어 정적값 유지)
        rate_info = {
            "현재": 3.00,
            "단위": "%",
            "결정일": "2025-11-28",
            "방향": "동결",
            "코멘트": "물가안정 목표 2% 수렴 중, 완화 기조 전환 가능성 관찰",
            "_데이터출처": "정적 샘플 (BOK_API_KEY 미설정)",
        }
        live = await _fetch_bok_latest("722Y001", "0101000", cycle="M")
        if live:
            rate_info["현재"] = live["value"]
            rate_info["결정일"] = live["time"]
            rate_info["_데이터출처"] = "한국은행 ECOS API (실시간)"

        return {
            "한국기준금리": rate_info,
            "미국연방기금금리": {
                "현재": 4.25,
                "목표범위": "4.25~4.50%",
                "최근FOMC": "2026-05",
                "방향": "동결",
                "코멘트": "관세 충격 경계, 연내 1~2회 인하 시장 기대",
            },
            "한미금리차": -1.25,
            "ECB정책금리": 2.65,
            "일본기준금리": 0.50,
            "한국3년국채수익률": 3.12,
            "미국10년국채수익률": 4.45,
        }

    async def _collect_exchange_rates(self) -> Dict:
        # 원달러(USD/KRW) 매매기준율(731Y003/0000001)은 BOK_API_KEY 설정 시
        # ECOS에서 실시간 조회, 미설정/조회실패 시 정적값 fallback
        usd_krw = {
            "현재": 1_378.0,
            "전일대비": -3.5,
            "1개월전": 1_412.0,
            "방향": "원화강세",
            "주요요인": ["미국 관세 완화 기대", "외국인 주식 순매수"],
            "_데이터출처": "정적 샘플 (BOK_API_KEY 미설정)",
        }
        live = await _fetch_bok_latest("731Y003", "0000001", cycle="D", lookback_periods=30)
        if live:
            usd_krw["전일대비"] = None
            usd_krw["현재"] = live["value"]
            usd_krw["_데이터출처"] = f"한국은행 ECOS API (실시간, 기준일 {live['time']})"

        return {
            "원달러(USD/KRW)": usd_krw,
            "원유로(EUR/KRW)": 1_520.0,
            "원엔(JPY/KRW)": 9.15,
            "달러인덱스(DXY)": 99.8,
            "위안달러(USD/CNY)": 7.28,
        }

    async def _collect_inflation(self) -> Dict:
        return {
            "한국CPI": {
                "전년동월비": 2.1,
                "전월비": 0.2,
                "기준월": "2026-04",
                "코어CPI": 1.9,
            },
            "미국CPI": {
                "전년동월비": 2.8,
                "기준월": "2026-04",
                "코어CPI": 3.2,
                "코멘트": "관세 영향으로 하반기 재상승 우려",
            },
            "한국PPI": {"전년동월비": 1.5, "기준월": "2026-04"},
            "글로벌인플레이션추세": "안정화 국면, 미국 관세 재인상 리스크 존재",
        }

    async def _collect_market_indices(self) -> Dict:
        try:
            from ..utils.krx_client import get_index_data
            kospi = await get_index_data("KOSPI")
            kosdaq = await get_index_data("KOSDAQ")
        except Exception:
            kospi = {"close": 2_582.0, "change_pct": 0.45}
            kosdaq = {"close": 748.0, "change_pct": 0.82}

        return {
            "KOSPI": kospi,
            "KOSDAQ": kosdaq,
            "SP500": {"현재": 5_308.0, "전일대비_pct": 0.62, "_note": "최근 데이터 기준"},
            "나스닥": {"현재": 16_780.0, "전일대비_pct": 0.75},
            "다우존스": {"현재": 42_100.0, "전일대비_pct": 0.35},
            "닛케이225": {"현재": 37_800.0, "전일대비_pct": -0.21},
            "상해종합": {"현재": 3_180.0, "전일대비_pct": 0.15},
            "공포지수(VIX)": {"현재": 18.5, "수준": "보통", "코멘트": "20 미만은 안정 국면"},
        }

    async def _collect_commodities(self) -> Dict:
        return {
            "WTI원유": {"현재": 78.5, "단위": "USD/배럴", "1개월변화": -3.2, "방향": "하락"},
            "브렌트원유": {"현재": 82.1, "단위": "USD/배럴"},
            "금": {"현재": 3_320.0, "단위": "USD/온스", "1년변화": +28.5, "코멘트": "안전자산 수요 강세"},
            "구리": {"현재": 9_850.0, "단위": "USD/톤", "코멘트": "중국 경기 회복 기대 반영"},
            "LNG": {"현재": 11.2, "단위": "USD/MMBtu"},
            "철광석": {"현재": 105.0, "단위": "USD/톤"},
            "반도체소재_실리콘": {"동향": "공급 타이트, 가격 상승 압력"},
        }

    async def _collect_economic_calendar(self) -> Dict:
        return {
            "이번주_주요일정": [
                {"날짜": "2026-06-04", "이벤트": "미국 ISM 서비스업 PMI 발표"},
                {"날짜": "2026-06-05", "이벤트": "한국 외환보유액 발표"},
                {"날짜": "2026-06-06", "이벤트": "미국 ADP 고용보고서"},
                {"날짜": "2026-06-07", "이벤트": "미국 비농업 고용지표(NFP) 발표 — 핵심"},
            ],
            "이번달_주요이벤트": [
                "FOMC 회의 (2026-06-17~18) — 금리 결정",
                "한국은행 금통위 (2026-06-12) — 기준금리 결정",
                "한국 1분기 GDP 확정치 발표",
            ],
            "시장_핵심변수": [
                "미국 관세 정책 변화 (트럼프 행정부 협상 진전 여부)",
                "연준 금리 인하 시점 (시장: 9월 인하 가능성 68%)",
                "중국 경기 부양책 추가 여부",
                "삼성전자 HBM 엔비디아 납품 재개 여부",
            ],
        }

    def get_market_sentiment(self) -> str:
        vix = self.results.get("지수", {}).get("공포지수(VIX)", {}).get("현재", 20)
        if vix < 15:
            return "과열 (탐욕)"
        elif vix < 20:
            return "안정 (중립)"
        elif vix < 30:
            return "경계 (불안)"
        else:
            return "공포 (패닉)"

    def get_macro_signal(self) -> Dict:
        return {
            "금리방향": "인하사이클 진입 예상 (2026년 하반기)",
            "환율": "원화 완만한 강세 예상 (무역흑자, 외인유입)",
            "경기": "한국 수출 회복세, 내수 부진 지속",
            "시장심리": self.get_market_sentiment(),
            "종합판단": "중립~긍정. 반도체 업종 선도, 금리인하 기대 유효",
        }
