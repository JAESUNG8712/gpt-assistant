"""
🔍 상세 분석 에이전트
저평가 종목 발굴, 기술적 분석, 매수/매도 시점 도출
"""

import math
from datetime import datetime
from typing import Dict

from ..utils.claude_client import analyze_stock_opinion, is_available as claude_available


class StockAnalyzer:
    """🔍 상세 분석 담당"""

    SECTOR_MAP = {
        "삼성전자": "반도체", "SK하이닉스": "반도체",
        "LG에너지솔루션": "배터리", "삼성SDI": "배터리",
        "삼성바이오로직스": "바이오", "셀트리온": "바이오",
        "현대차": "자동차", "기아": "자동차", "현대모비스": "자동차",
        "POSCO홀딩스": "철강·소재",
        "KB금융": "금융", "신한지주": "금융",
        "카카오": "IT플랫폼", "NAVER": "IT플랫폼",
        "LG화학": "화학·소재",
    }

    SECTOR_FAIR_PER = {
        "반도체": 18, "배터리": 20, "바이오": 30,
        "자동차": 10, "철강·소재": 8, "금융": 7,
        "IT플랫폼": 25, "화학·소재": 10,
    }

    def __init__(self, financial_data: Dict, economic_data: Dict,
                 geo_data: Dict, industry_data: Dict):
        self.financial = financial_data
        self.economic = economic_data
        self.geo = geo_data
        self.industry = industry_data
        self.analyses: Dict = {}

    def run(self) -> Dict:
        print("🔍 [상세분석] 저평가 종목 및 매매 시점 분석 시작")

        for corp_name, data in self.financial.items():
            if "error" in data:
                continue
            self.analyses[corp_name] = self._analyze_stock(corp_name, data)

        if claude_available():
            print("🤖 [상세분석] Claude API로 AI 투자의견 보강 중...")
            for corp_name, result in self.analyses.items():
                ai_opinion = analyze_stock_opinion(corp_name, result)
                result["투자의견"]["AI분석"] = ai_opinion

        print(f"🔍 [상세분석] {len(self.analyses)}개 종목 분석 완료")
        return self.analyses

    def _analyze_stock(self, name: str, data: Dict) -> Dict:
        val = data.get("밸류에이션", {})
        derived = data.get("파생지표", {})
        price_data = data.get("주가", {})
        supply = data.get("수급", {})
        sector = self.SECTOR_MAP.get(name, "기타")

        intrinsic = self._calc_intrinsic_value(name, data, sector)
        technical = self._technical_analysis(price_data)
        supply_analysis = self._supply_analysis(supply)
        macro_factor = self._macro_factor_analysis(sector)
        timing = self._timing_analysis(intrinsic, technical, supply_analysis, macro_factor)
        opinion = self._generate_opinion(timing, intrinsic, val, derived)

        return {
            "종목명": name,
            "섹터": sector,
            "현재가": price_data.get("close", 0),
            "내재가치": intrinsic,
            "기술적분석": technical,
            "수급분석": supply_analysis,
            "매크로연계": macro_factor,
            "매매시점": timing,
            "투자의견": opinion,
            "분석시각": datetime.now().isoformat(),
        }

    def _calc_intrinsic_value(self, name: str, data: Dict, sector: str) -> Dict:
        val = data.get("밸류에이션", {})
        derived = data.get("파생지표", {})
        price = data.get("주가", {}).get("close", 0)

        per = val.get("PER", 0)
        pbr = val.get("PBR", 0)
        eps = val.get("EPS", 0)
        bps = val.get("BPS", 0)
        roe = derived.get("ROE", 0)
        fair_per = self.SECTOR_FAIR_PER.get(sector, 15)

        target_by_per = eps * fair_per if eps > 0 else 0
        fair_pbr = roe / 10 if roe > 0 else 1.0
        target_by_pbr = bps * fair_pbr if bps > 0 else 0

        if target_by_per > 0 and target_by_pbr > 0:
            target_price = (target_by_per * 0.6 + target_by_pbr * 0.4)
        elif target_by_per > 0:
            target_price = target_by_per
        elif target_by_pbr > 0:
            target_price = target_by_pbr
        else:
            target_price = price * 1.1

        upside = (target_price - price) / price * 100 if price > 0 else 0

        undervalue_score = derived.get("저평가스코어", 0)
        if upside > 30 and undervalue_score >= 50:
            valuation_grade = "강한저평가"
        elif upside > 15 and undervalue_score >= 30:
            valuation_grade = "저평가"
        elif upside > 0:
            valuation_grade = "적정"
        else:
            valuation_grade = "고평가"

        return {
            "목표주가": int(target_price),
            "현재가": price,
            "상승여력": round(upside, 1),
            "PER기반목표": int(target_by_per),
            "PBR기반목표": int(target_by_pbr),
            "업종적정PER": fair_per,
            "현재PER": per,
            "현재PBR": pbr,
            "저평가판단": valuation_grade,
            "저평가스코어": undervalue_score,
        }

    def _technical_analysis(self, price_data: Dict) -> Dict:
        history = price_data.get("history", {})
        if not history:
            return {"상태": "데이터부족", "신호": "중립"}

        closes = [v["close"] for v in history.values() if "close" in v]
        if len(closes) < 5:
            return {"상태": "데이터부족", "신호": "중립"}

        current = closes[-1]

        ma5 = sum(closes[-5:]) / 5
        ma20 = sum(closes[-20:]) / 20 if len(closes) >= 20 else ma5
        ma60 = sum(closes[-60:]) / 60 if len(closes) >= 60 else ma20

        rsi = self._calc_rsi(closes, 14)
        bb = self._calc_bollinger(closes, 20)

        if current > ma5 > ma20 > ma60:
            trend = "강한상승추세"
        elif current > ma20:
            trend = "상승추세"
        elif current < ma20 and current < ma60:
            trend = "하락추세"
        else:
            trend = "횡보"

        signals = []
        if rsi < 30:
            signals.append("RSI과매도(매수신호)")
        elif rsi > 70:
            signals.append("RSI과매수(매도신호)")

        if current < bb["lower"]:
            signals.append("볼린저하단(반등가능)")
        elif current > bb["upper"]:
            signals.append("볼린저상단(조정가능)")

        if current > ma5 and len(closes) > 5 and closes[-2] < ma5:
            signals.append("5일선 돌파(단기매수)")

        overall_signal = "매수" if rsi < 40 and current > ma20 else \
                         "매도" if rsi > 65 and current < ma5 else "중립"

        return {
            "추세": trend,
            "RSI_14": round(rsi, 1),
            "MA5": int(ma5),
            "MA20": int(ma20),
            "MA60": int(ma60),
            "볼린저상단": int(bb["upper"]),
            "볼린저중간": int(bb["mid"]),
            "볼린저하단": int(bb["lower"]),
            "기술신호": signals,
            "종합신호": overall_signal,
        }

    def _calc_rsi(self, closes: list, period: int = 14) -> float:
        if len(closes) < period + 1:
            return 50.0
        gains, losses = [], []
        for i in range(1, period + 1):
            diff = closes[-i] - closes[-(i+1)]
            if diff > 0:
                gains.append(diff)
                losses.append(0)
            else:
                gains.append(0)
                losses.append(abs(diff))
        avg_gain = sum(gains) / period
        avg_loss = sum(losses) / period
        if avg_loss == 0:
            return 100.0
        rs = avg_gain / avg_loss
        return 100 - (100 / (1 + rs))

    def _calc_bollinger(self, closes: list, period: int = 20) -> Dict:
        if not closes:
            return {"upper": 0, "mid": 0, "lower": 0}
        data = closes[-period:] if len(closes) >= period else closes
        mid = sum(data) / len(data)
        variance = sum((x - mid) ** 2 for x in data) / len(data)
        std = math.sqrt(variance)
        return {"upper": mid + 2 * std, "mid": mid, "lower": mid - 2 * std}

    def _supply_analysis(self, supply: Dict) -> Dict:
        if "error" in supply or not supply:
            return {"상태": "데이터부족"}

        foreign = supply.get("외국인합계", {})
        institution = supply.get("기관합계", {})
        individual = supply.get("개인", {})

        def score(data):
            net = data.get("순매수_전체", 0)
            recent = data.get("순매수_최근5일", 0)
            if net == 0:
                return 0
            base = 50 if net > 0 else -50
            recency_bonus = 20 if recent > 0 and net > 0 else -20 if recent < 0 and net < 0 else 0
            return base + recency_bonus

        foreign_score = score(foreign)
        institution_score = score(institution)

        if foreign_score > 30 and institution_score > 30:
            combined_signal = "강력매수신호 (외국인+기관 동반매수)"
        elif foreign_score > 30:
            combined_signal = "외국인 주도 매수"
        elif institution_score > 30:
            combined_signal = "기관 주도 매수"
        elif foreign_score < -30 and institution_score < -30:
            combined_signal = "매도압력 (외국인+기관 동반매도)"
        else:
            combined_signal = "수급 중립"

        return {
            "외국인": {
                "순매수(전체)": foreign.get("순매수_전체", 0),
                "순매수(5일)": foreign.get("순매수_최근5일", 0),
                "방향": foreign.get("방향", "N/A"),
                "강도점수": foreign_score,
            },
            "기관": {
                "순매수(전체)": institution.get("순매수_전체", 0),
                "순매수(5일)": institution.get("순매수_최근5일", 0),
                "방향": institution.get("방향", "N/A"),
                "강도점수": institution_score,
            },
            "개인": {
                "순매수(전체)": individual.get("순매수_전체", 0),
                "방향": individual.get("방향", "N/A"),
            },
            "종합수급신호": combined_signal,
        }

    def _macro_factor_analysis(self, sector: str) -> Dict:
        macro = self.economic
        base_rate_kr = macro.get("금리", {}).get("한국기준금리", {}).get("현재", 3.0)
        usdkrw = macro.get("환율", {}).get("원달러(USD/KRW)", {}).get("현재", 1380)

        sector_analysis = {
            "반도체": {
                "영향": "AI 수요 폭발 → HBM 공급 부족 → 긍정",
                "환율": f"원화 강세({usdkrw}원) → 수출 수익성 소폭 하락",
                "금리": "금리 인하 기대 → IT주 밸류에이션 확장 긍정",
                "종합": "긍정" if usdkrw > 1350 else "중립",
            },
            "배터리": {
                "영향": "IRA 수혜 지속, EV 전환 가속",
                "리스크": "중국 LFP 경쟁, 수요 성장 둔화 우려",
                "종합": "중립~긍정",
            },
            "바이오": {
                "영향": "금리 인하 시 바이오 밸류에이션 회복",
                "리스크": "임상 실패 리스크",
                "종합": "중립",
            },
            "자동차": {
                "영향": "환율 약세 시 수출 수익성 개선",
                "리스크": "관세 협상, EV 전환 비용",
                "종합": "중립",
            },
            "금융": {
                "영향": f"기준금리 {base_rate_kr}% → 순이자마진 안정",
                "리스크": "경기 침체 시 부실채권 증가",
                "종합": "중립",
            },
        }

        return sector_analysis.get(sector, {
            "영향": "매크로 영향 중립",
            "종합": "중립",
        })

    def _timing_analysis(self, intrinsic: Dict, technical: Dict,
                          supply: Dict, macro: Dict) -> Dict:
        signals = []
        score = 0

        upside = intrinsic.get("상승여력", 0)
        if upside > 30:
            score += 30
            signals.append(f"상승여력 {upside:.1f}% (목표가 대비 충분)")
        elif upside > 15:
            score += 15
            signals.append(f"상승여력 {upside:.1f}%")
        elif upside < -10:
            score -= 30
            signals.append("고평가 구간 (매도 고려)")

        rsi = technical.get("RSI_14", 50)
        tech_signal = technical.get("종합신호", "중립")
        if tech_signal == "매수":
            score += 25
            signals.append(f"기술적 매수 신호 (RSI {rsi})")
        elif tech_signal == "매도":
            score -= 25
            signals.append(f"기술적 매도 신호 (RSI {rsi})")

        supply_signal = supply.get("종합수급신호", "")
        if "강력매수" in supply_signal:
            score += 30
            signals.append("외국인+기관 동반 매수 (강한 수급)")
        elif "외국인" in supply_signal and "매수" in supply_signal:
            score += 20
            signals.append("외국인 순매수 지속")
        elif "동반매도" in supply_signal:
            score -= 20
            signals.append("외국인+기관 동반 매도")

        macro_view = macro.get("종합", "중립")
        if macro_view == "긍정":
            score += 15
            signals.append("매크로 환경 우호적")
        elif macro_view == "부정":
            score -= 15

        if score >= 60:
            action = "적극매수"
            buy_zone = "현재 구간"
            sell_zone = f"목표가({intrinsic.get('목표주가', 0):,}원) 도달 시"
        elif score >= 30:
            action = "매수"
            buy_zone = "현재~5% 하락 시"
            sell_zone = "목표가의 90% 도달 시"
        elif score >= 0:
            action = "관망"
            buy_zone = "10% 이상 추가 하락 시"
            sell_zone = "단기 반등 시 일부 매도"
        else:
            action = "매도/비중축소"
            buy_zone = "추가 하락 후 재검토"
            sell_zone = "현재 구간 매도 고려"

        return {
            "종합점수": score,
            "매매행동": action,
            "매수구간": buy_zone,
            "매도구간": sell_zone,
            "손절기준": "매수가 대비 -8% 이탈 시",
            "근거": signals,
        }

    def _generate_opinion(self, timing: Dict, intrinsic: Dict,
                           val: Dict, derived: Dict) -> Dict:
        action = timing.get("매매행동", "관망")
        upside = intrinsic.get("상승여력", 0)

        if action in ["적극매수", "매수"]:
            rating = "BUY" if action == "적극매수" else "OVERWEIGHT"
            risk = "낮음~중간"
        elif action == "관망":
            rating = "NEUTRAL"
            risk = "중간"
        else:
            rating = "UNDERWEIGHT"
            risk = "중간~높음"

        return {
            "투자등급": rating,
            "목표주가": intrinsic.get("목표주가", 0),
            "상승여력": upside,
            "투자기간": "6~12개월",
            "리스크수준": risk,
            "핵심논리": timing.get("근거", []),
            "주요리스크": self._get_risks(val, derived),
        }

    def _get_risks(self, val: Dict, derived: Dict) -> list:
        risks = []
        per = val.get("PER", 0)
        debt = derived.get("부채비율", 0)
        op_margin = derived.get("영업이익률", 0)

        if per > 25:
            risks.append("밸류에이션 부담 (고PER)")
        if debt > 150:
            risks.append(f"부채비율 높음 ({debt:.0f}%)")
        if op_margin < 5:
            risks.append("영업이익률 저조")
        if not risks:
            risks.append("큰 리스크 없음 (현 수준)")

        return risks

    def get_top_picks(self, n: int = 5) -> list:
        ranked = sorted(
            self.analyses.items(),
            key=lambda x: x[1].get("매매시점", {}).get("종합점수", 0),
            reverse=True
        )
        return [
            {
                "순위": i + 1,
                "종목": name,
                "등급": data.get("투자의견", {}).get("투자등급", "N/A"),
                "목표주가": data.get("투자의견", {}).get("목표주가", 0),
                "상승여력": data.get("내재가치", {}).get("상승여력", 0),
                "매매행동": data.get("매매시점", {}).get("매매행동", "관망"),
                "점수": data.get("매매시점", {}).get("종합점수", 0),
            }
            for i, (name, data) in enumerate(ranked[:n])
        ]
