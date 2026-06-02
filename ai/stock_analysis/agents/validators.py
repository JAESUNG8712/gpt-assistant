"""
✅🔬⚠️ 교차 검증 에이전트 (3명)
검증1: 재무 데이터 정확성
검증2: 분석 논리 일관성
검증3: 리스크 독립 검증
"""

from datetime import datetime
from typing import Dict, List, Tuple


class FinancialDataValidator:
    """✅ 교차 검증 1 — 재무 데이터 검증"""

    # 업종별 정상 범위 기준
    NORMAL_RANGES = {
        "영업이익률": (-5, 60),
        "ROE": (-30, 50),
        "부채비율": (0, 400),
        "PER": (0, 100),
        "PBR": (0, 20),
    }

    def __init__(self, financial_data: Dict, analyses: Dict):
        self.financial = financial_data
        self.analyses = analyses
        self.issues: Dict = {}

    def run(self) -> Dict:
        print("✅ [검증1] 재무 데이터 검증 시작")
        results = {}

        for corp_name, data in self.financial.items():
            issues = []
            flags = []

            # 1. 이상치 탐지
            derived = data.get("파생지표", {})
            val = data.get("밸류에이션", {})

            for metric, (lo, hi) in self.NORMAL_RANGES.items():
                value = derived.get(metric) or val.get(metric)
                if value is not None:
                    if not (lo <= value <= hi):
                        flags.append(f"⚠️ {metric} 비정상값: {value} (정상범위 {lo}~{hi})")

            # 2. 재무제표 일관성 검증
            fs = data.get("재무제표", {})
            assets = fs.get("자산총계", {}).get("current", 0)
            debt = fs.get("부채총계", {}).get("current", 0)
            equity = fs.get("자본총계", {}).get("current", 0)

            if assets > 0 and abs(assets - (debt + equity)) / assets > 0.05:
                flags.append(f"🚨 자산=부채+자본 불일치 (자산:{assets:,} / 부채+자본:{debt+equity:,})")

            # 3. 전년 대비 급격한 변화 탐지
            revenue = fs.get("매출액", {})
            rev_growth = derived.get("매출성장률", 0)
            if abs(rev_growth or 0) > 100:
                flags.append(f"⚠️ 매출 급변 ({rev_growth:.1f}%) — 확인 필요")

            op_growth = derived.get("영업이익성장률", 0)
            if abs(op_growth or 0) > 200:
                flags.append(f"⚠️ 영업이익 급변 ({op_growth:.1f}%) — 분기 실적 확인 필요")

            # 4. 밸류에이션 데이터 신뢰도
            if val.get("_note") and "샘플" in str(val.get("_note", "")):
                issues.append("ℹ️ 밸류에이션: DART/KRX API 미연결 — 샘플 데이터 사용 중")

            status = "검증통과" if not flags else "검토필요"
            results[corp_name] = {
                "상태": status,
                "경고": flags,
                "주의": issues,
                "검증항목수": len(self.NORMAL_RANGES) + 3,
                "이상항목수": len(flags),
            }

        self.issues = results
        print(f"✅ [검증1] 완료 — 이상 감지: {sum(1 for v in results.values() if v['상태'] != '검증통과')}건")
        return results

    def get_clean_stocks(self) -> List[str]:
        """이상 없는 종목 목록"""
        return [name for name, v in self.issues.items() if v["상태"] == "검증통과"]

    def get_flagged_stocks(self) -> List[Tuple[str, List]]:
        """이상 감지 종목 목록"""
        return [(name, v["경고"]) for name, v in self.issues.items() if v["경고"]]


class LogicValidator:
    """🔬 교차 검증 2 — 분석 논리 검증"""

    def __init__(self, analyses: Dict, financial_data: Dict,
                 economic_data: Dict, data_validation: Dict):
        self.analyses = analyses
        self.financial = financial_data
        self.economic = economic_data
        self.data_val = data_validation
        self.results: Dict = {}

    def run(self) -> Dict:
        print("🔬 [검증2] 분석 논리 검증 시작")

        for corp_name, analysis in self.analyses.items():
            self.results[corp_name] = self._validate_logic(corp_name, analysis)

        # 포트폴리오 전체 일관성 검증
        self.results["_포트폴리오검증"] = self._validate_portfolio()

        print("🔬 [검증2] 완료")
        return self.results

    def _validate_logic(self, name: str, analysis: Dict) -> Dict:
        issues = []

        intrinsic = analysis.get("내재가치", {})
        technical = analysis.get("기술적분석", {})
        supply = analysis.get("수급분석", {})
        timing = analysis.get("매매시점", {})
        opinion = analysis.get("투자의견", {})

        # 1. 내재가치 vs 투자등급 일관성
        upside = intrinsic.get("상승여력", 0)
        rating = opinion.get("투자등급", "")
        if upside < 0 and rating in ["BUY", "OVERWEIGHT"]:
            issues.append("❌ 논리 불일치: 고평가 종목에 매수 의견 — 재검토 필요")
        if upside > 25 and rating == "UNDERWEIGHT":
            issues.append("❌ 논리 불일치: 저평가 종목에 매도 의견 — 재검토 필요")

        # 2. RSI vs 매수 신호 일관성
        rsi = technical.get("RSI_14", 50)
        action = timing.get("매매행동", "")
        if rsi > 75 and "매수" in action:
            issues.append(f"⚠️ RSI 과매수({rsi:.1f}) 상황에서 매수 의견 — 단기 조정 리스크")
        if rsi < 25 and "매도" in action:
            issues.append(f"⚠️ RSI 과매도({rsi:.1f}) 상황에서 매도 의견 — 반등 가능성 검토")

        # 3. 수급 vs 매매 판단 일관성
        supply_signal = supply.get("종합수급신호", "")
        if "동반매도" in supply_signal and "매수" in action:
            issues.append("⚠️ 외국인+기관 동반매도 중 매수 — 수급 리스크 주의")

        # 4. 데이터 품질 교차 확인
        data_status = self.data_val.get(name, {}).get("상태", "")
        if data_status == "검토필요" and rating == "BUY":
            issues.append("⚠️ 데이터 이상 감지 종목 — 재무 검증 후 투자 결정 권고")

        # 5. 목표주가 합리성
        target = opinion.get("목표주가", 0)
        current = analysis.get("현재가", 0)
        if current > 0 and target > 0:
            ratio = target / current
            if ratio > 3:
                issues.append(f"⚠️ 목표주가 현재가의 {ratio:.1f}배 — 과도한 상승 기대 검토")
            if ratio < 0.5:
                issues.append(f"⚠️ 목표주가 현재가의 {ratio:.1f}배 — 과도한 하락 기대 검토")

        passed = len(issues) == 0
        return {
            "논리검증통과": passed,
            "검증이슈": issues,
            "검증항목수": 5,
            "이슈수": len(issues),
        }

    def _validate_portfolio(self) -> Dict:
        """포트폴리오 전체 관점 검증"""
        buy_count = sum(
            1 for name, a in self.analyses.items()
            if a.get("투자의견", {}).get("투자등급", "") in ["BUY", "OVERWEIGHT"]
        )
        total = len(self.analyses)

        warnings = []
        if buy_count > total * 0.7:
            warnings.append(f"⚠️ 매수 의견 과다 ({buy_count}/{total}) — 선별 강화 권고")
        if buy_count == 0:
            warnings.append("⚠️ 매수 의견 없음 — 시장 상황 재검토 필요")

        # 섹터 집중도
        sector_counts = {}
        for name, a in self.analyses.items():
            sector = a.get("섹터", "기타")
            sector_counts[sector] = sector_counts.get(sector, 0) + 1

        max_sector = max(sector_counts.values()) if sector_counts else 0
        if max_sector > total * 0.5:
            dominant = max(sector_counts, key=sector_counts.get)
            warnings.append(f"⚠️ 섹터 집중 ({dominant}: {max_sector}/{total}) — 분산 검토")

        return {
            "전체종목수": total,
            "매수의견수": buy_count,
            "매수비율": round(buy_count / total * 100, 1) if total > 0 else 0,
            "섹터분포": sector_counts,
            "포트폴리오경고": warnings,
        }


class RiskValidator:
    """⚠️ 교차 검증 3 — 리스크 독립 검증"""

    def __init__(self, analyses: Dict, financial_data: Dict,
                 geo_data: Dict, industry_data: Dict):
        self.analyses = analyses
        self.financial = financial_data
        self.geo = geo_data
        self.industry = industry_data
        self.results: Dict = {}

    def run(self) -> Dict:
        print("⚠️ [검증3] 리스크 독립 검증 시작")

        for corp_name, analysis in self.analyses.items():
            self.results[corp_name] = self._assess_risks(corp_name, analysis)

        self.results["_시나리오분석"] = self._stress_test()
        self.results["_포트폴리오리스크"] = self._portfolio_risk()

        print("⚠️ [검증3] 완료")
        return self.results

    def _assess_risks(self, name: str, analysis: Dict) -> Dict:
        sector = analysis.get("섹터", "기타")
        financial = self.financial.get(name, {})
        derived = financial.get("파생지표", {})
        price_data = financial.get("주가", {})

        risks = []
        risk_score = 0  # 0~100 (높을수록 위험)

        # 1. 재무 리스크
        debt_ratio = derived.get("부채비율", 0)
        if debt_ratio > 200:
            risks.append({"유형": "재무", "내용": f"고부채비율 {debt_ratio:.0f}%", "수준": "높음"})
            risk_score += 20
        elif debt_ratio > 100:
            risks.append({"유형": "재무", "내용": f"부채비율 주의 {debt_ratio:.0f}%", "수준": "중간"})
            risk_score += 10

        op_margin = derived.get("영업이익률", 0)
        if op_margin < 0:
            risks.append({"유형": "수익성", "내용": "영업손실 지속", "수준": "높음"})
            risk_score += 25
        elif op_margin < 3:
            risks.append({"유형": "수익성", "내용": "영업이익률 낮음", "수준": "중간"})
            risk_score += 10

        # 2. 유동성 리스크 (거래량)
        volume = price_data.get("volume", 0)
        market_cap = (price_data.get("close", 0) or 0) * 1_000_000  # 대략
        if volume < 100_000:
            risks.append({"유형": "유동성", "내용": "일평균 거래량 부족", "수준": "높음"})
            risk_score += 15

        # 3. 섹터별 구조적 리스크
        sector_risks = {
            "반도체": [{"유형": "산업", "내용": "중국 수출규제, 업황 사이클", "수준": "중간"}],
            "배터리": [{"유형": "산업", "내용": "중국 LFP 경쟁, EV 수요 불확실", "수준": "중간"}],
            "바이오": [{"유형": "산업", "내용": "임상 실패, FDA 규제", "수준": "높음"}],
            "IT플랫폼": [{"유형": "규제", "내용": "플랫폼 독과점 규제 리스크", "수준": "중간"}],
        }
        risks.extend(sector_risks.get(sector, []))

        # 4. 지정학 리스크 연계
        geo_risk = self.geo.get("종합리스크지수", {}).get("종합지정학리스크", 45)
        if geo_risk > 60:
            risks.append({"유형": "지정학", "내용": "지정학 리스크 높음", "수준": "높음"})
            risk_score += 15
        elif geo_risk > 40:
            risk_score += 5

        # 5. 기술적 리스크 (하락추세)
        tech = analysis.get("기술적분석", {})
        if "하락추세" in tech.get("추세", ""):
            risks.append({"유형": "기술적", "내용": "하락추세 진행 중", "수준": "중간"})
            risk_score += 10

        level = "낮음" if risk_score < 25 else "중간" if risk_score < 50 else "높음"

        return {
            "리스크점수": min(risk_score, 100),
            "리스크수준": level,
            "리스크목록": risks,
            "리스크수": len(risks),
            "투자가능여부": "가능" if risk_score < 50 else "주의필요",
        }

    def _stress_test(self) -> Dict:
        """스트레스 테스트 — 3가지 시나리오"""
        return {
            "시나리오1_미중관계악화": {
                "전제": "미중 관세 협상 결렬, 반도체 추가 제재",
                "예상충격": "KOSPI -10~15%, 반도체 -20%+",
                "대응": "반도체 비중 축소, 방산·내수주 비중 확대",
                "확률": "20%",
            },
            "시나리오2_금리급등": {
                "전제": "미국 인플레 재점화, 연준 금리 인상 재개",
                "예상충격": "성장주(IT·바이오) -15~25%, 금융주 수혜",
                "대응": "가치주·배당주 비중 확대, PER 높은 종목 비중 축소",
                "확률": "15%",
            },
            "시나리오3_경기침체": {
                "전제": "한국 GDP 성장률 0% 이하, 수출 급감",
                "예상충격": "KOSPI -20~30%, 내수·금융주 특히 취약",
                "대응": "현금 비중 확대 (20~30%), 방어적 종목(통신·유틸) 집중",
                "확률": "10%",
            },
            "기본시나리오": {
                "전제": "현 추세 지속 — 수출 회복, 금리 인하 기대",
                "예상": "KOSPI 2,700~2,900 박스권, 반도체 주도",
                "확률": "55%",
            },
        }

    def _portfolio_risk(self) -> Dict:
        """포트폴리오 종합 리스크"""
        risk_scores = [
            v.get("리스크점수", 50)
            for k, v in self.results.items()
            if not k.startswith("_") and "리스크점수" in v
        ]

        avg_risk = sum(risk_scores) / len(risk_scores) if risk_scores else 50
        high_risk_count = sum(1 for s in risk_scores if s >= 50)

        return {
            "평균리스크점수": round(avg_risk, 1),
            "고위험종목수": high_risk_count,
            "전체종목수": len(risk_scores),
            "포트폴리오위험수준": "낮음" if avg_risk < 30 else "중간" if avg_risk < 55 else "높음",
            "권고사항": (
                "현재 포트폴리오 위험 관리 양호"
                if avg_risk < 40
                else "고위험 종목 비중 점검 권고"
            ),
        }
