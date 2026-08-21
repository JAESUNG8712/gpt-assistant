"""
📋 자료 취합 에이전트
4개 수집 에이전트 데이터를 통합·정규화
"""

from datetime import datetime
from typing import Dict, List


class DataAggregator:
    """📋 자료 취합 담당"""

    def __init__(
        self,
        financial_data: Dict,
        economic_data: Dict,
        geo_data: Dict,
        industry_data: Dict,
    ):
        self.financial = financial_data
        self.economic = economic_data
        self.geo = geo_data
        self.industry = industry_data

    def run(self) -> Dict:
        print("📋 [취합] 데이터 통합 및 정규화 시작")

        aggregated = {
            "수집시각": datetime.now().isoformat(),
            "재무": self._normalize_financial(),
            "경제": self._normalize_economic(),
            "지정학": self._normalize_geo(),
            "산업": self._normalize_industry(),
            "통합요약": self._create_summary(),
            "데이터품질": self._assess_data_quality(),
        }

        print("📋 [취합] 완료")
        return aggregated

    def _normalize_financial(self) -> Dict:
        normalized = {}
        for name, data in self.financial.items():
            if isinstance(data, Exception):
                continue
            normalized[name] = {
                "재무": data.get("재무제표", {}),
                "밸류": data.get("밸류에이션", {}),
                "주가": data.get("주가", {}),
                "수급": data.get("수급", {}),
                "지표": data.get("파생지표", {}),
                "공시": data.get("최근공시", []),
            }
        return normalized

    def _normalize_economic(self) -> Dict:
        return {
            "금리_한국": self.economic.get("금리", {}).get("한국기준금리", {}),
            "금리_미국": self.economic.get("금리", {}).get("미국연방기금금리", {}),
            "환율_원달러": self.economic.get("환율", {}).get("원달러(USD/KRW)", {}),
            "물가_한국": self.economic.get("물가", {}).get("한국CPI", {}),
            "물가_미국": self.economic.get("물가", {}).get("미국CPI", {}),
            "지수": self.economic.get("지수", {}),
            "원자재": self.economic.get("원자재", {}),
            "캘린더": self.economic.get("경제캘린더", {}),
        }

    def _normalize_geo(self) -> Dict:
        return {
            "미중관계": self.geo.get("미중관계", {}),
            "한반도": self.geo.get("한반도지정학", {}),
            "무역": self.geo.get("무역정책", {}),
            "리스크지수": self.geo.get("종합리스크지수", {}),
        }

    def _normalize_industry(self) -> Dict:
        return {
            "반도체": self.industry.get("반도체", {}),
            "배터리EV": self.industry.get("배터리EV", {}),
            "바이오": self.industry.get("바이오제약", {}),
            "AI": self.industry.get("AI기술", {}),
            "공급망": self.industry.get("공급망", {}),
        }

    def _create_summary(self) -> Dict:
        corp_count = len([k for k, v in self.financial.items() if "error" not in v])

        undervalued = [
            name for name, data in self.financial.items()
            if data.get("파생지표", {}).get("저평가스코어", 0) >= 40
        ]

        supply_strong = [
            name for name, data in self.financial.items()
            if data.get("수급", {}).get("외국인합계", {}).get("방향") == "매수우위"
        ]

        macro_signal = self.economic.get("종합판단", "정보없음")

        return {
            "분석종목수": corp_count,
            "저평가후보": undervalued,
            "외국인매수우위종목": supply_strong,
            "매크로신호": macro_signal,
            "지정학리스크": self.geo.get("종합리스크지수", {}).get("종합지정학리스크", 50),
        }

    def _assess_data_quality(self) -> Dict:
        issues = []

        sample_count = sum(
            1 for data in self.financial.values()
            if "_note" in str(data) and "샘플" in str(data.get("재무제표", {}).get("_note", ""))
        )
        if sample_count > 0:
            issues.append(f"DART API 미연결: {sample_count}개 종목 샘플 데이터 사용")

        pykrx_missing = any(
            "샘플" in str(data.get("주가", {}).get("_note", ""))
            for data in self.financial.values()
        )
        if pykrx_missing:
            issues.append("KRX 실시간 데이터: 수집 불가 — 샘플 데이터 사용")

        return {
            "데이터신뢰도": "낮음 (샘플)" if issues else "높음 (실시간)",
            "이슈목록": issues,
            "권고": "실제 운영 시 DART_API_KEY, BOK_API_KEY 설정 필요" if issues else "정상",
        }
