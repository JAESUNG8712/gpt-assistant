"""
📝 최종 레포트 작성 에이전트
오전 7시 / 저녁 10시 정규 보고서 생성
"""

import json
import os
from datetime import datetime
from typing import Dict, List, Optional

from ..utils.claude_client import (
    generate_executive_summary as claude_executive_summary,
    generate_action_plan as claude_action_plan,
    is_available as claude_available,
)


REPORTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "reports")
os.makedirs(REPORTS_DIR, exist_ok=True)


def _fmt_num(val, fmt=",", fallback="N/A"):
    """값이 숫자이면 포맷, 아니면 fallback 반환"""
    try:
        v = float(val)
        if fmt == ",":
            return f"{v:,.0f}"
        elif fmt == ",.1f":
            return f"{v:,.1f}"
        elif fmt == ".2f":
            return f"{v:.2f}"
        elif fmt == ".1f":
            return f"{v:.1f}"
        elif fmt == ".0f":
            return f"{v:.0f}"
        return str(v)
    except (TypeError, ValueError):
        return fallback if val in (None, "", "N/A") else str(val)


def _fmt_chg(val, fmt=".2f"):
    """등락률/변화 값 포맷 (부호 포함)"""
    try:
        v = float(val)
        sign = "+" if v >= 0 else ""
        if fmt == ".2f":
            return f"{sign}{v:.2f}%"
        elif fmt == ".1f":
            return f"{sign}{v:.1f}%"
        return f"{sign}{v}%"
    except (TypeError, ValueError):
        return str(val) if val not in (None, "") else "N/A"


class ReportWriter:
    """📝 최종 레포트 작성자"""

    def __init__(
        self,
        analyses: Dict,
        financial_data: Dict,
        economic_data: Dict,
        geo_data: Dict,
        industry_data: Dict,
        data_validation: Dict,
        logic_validation: Dict,
        risk_validation: Dict,
    ):
        self.analyses = analyses
        self.financial = financial_data
        self.economic = economic_data
        self.geo = geo_data
        self.industry = industry_data
        self.data_val = data_validation
        self.logic_val = logic_validation
        self.risk_val = risk_validation

        now = datetime.now()
        self.report_time = now
        self.time_label = "오전 7시" if now.hour < 12 else "저녁 10시"
        self.date_str = now.strftime("%Y년 %m월 %d일")

    def run(self) -> str:
        print("📝 [레포트] 최종 보고서 작성 시작")

        self._ai_executive = ""
        self._ai_action = ""
        if claude_available():
            print("🤖 [레포트] Claude AI로 시황요약·액션플랜 생성 중...")
            top_picks = self._get_top_picks_list()
            self._ai_executive = claude_executive_summary(
                self.economic, self.geo, self.analyses, self.risk_val, self.logic_val
            )
            self._ai_action = claude_action_plan(top_picks, self.risk_val, self.economic)

        sections = [
            self._header(),
            self._executive_summary(),
            self._market_overview(),
            self._top_picks(),
            self._securities_reports_section(),
            self._investor_flow(),
            self._sector_analysis(),
            self._detailed_stock_analysis(),
            self._risk_report(),
            self._scenarios(),
            self._action_plan(),
            self._footer(),
        ]

        report = "\n\n".join(sections)
        self._save_report(report)

        print("📝 [레포트] 완료")
        return report

    def _header(self) -> str:
        return f"""{'='*70}
📊 주식 분석 보고서 | {self.date_str} {self.time_label}
{'='*70}
⚙️  분석팀: 총괄관리1 | 재무수집1 | 경제수집1 | 동향수집2 | 취합1 | 분석1 | 검증3 | 레포트1
🕐  생성시각: {self.report_time.strftime('%Y-%m-%d %H:%M:%S')}
{'─'*70}"""

    def _executive_summary(self) -> str:
        macro = self.economic
        geo_risk = self.geo.get("종합리스크지수", {})
        portfolio_val = self.logic_val.get("_포트폴리오검증", {})
        portfolio_risk = self.risk_val.get("_포트폴리오리스크", {})

        buy_count = portfolio_val.get("매수의견수", 0)
        total = portfolio_val.get("전체종목수", 0)
        avg_risk = portfolio_risk.get("평균리스크점수", 0)

        kospi = macro.get("지수", {}).get("KOSPI", {})
        kospi_val = kospi.get("close", "N/A")
        kospi_chg = kospi.get("change_pct", 0)

        ai_section = ""
        if self._ai_executive:
            ai_section = f"\n\n🤖 AI 시황 분석 (Claude):\n{self._ai_executive}"
        else:
            ai_section = f"\n\n💡 오늘의 핵심 메시지:\n  {self._get_key_message()}"

        return f"""【 종합 요약 (Executive Summary) 】
─────────────────────────────────────────────────────────────────────
▸ KOSPI: {_fmt_num(kospi_val, ",.1f")} ({_fmt_chg(kospi_chg)})
▸ 분석 종목: {total}개  |  매수 의견: {buy_count}개  |  관망/매도: {total - buy_count}개
▸ 포트폴리오 평균 리스크: {avg_risk:.0f}/100 ({portfolio_risk.get('포트폴리오위험수준', 'N/A')})
▸ 지정학 리스크: {geo_risk.get('종합지정학리스크', 'N/A')}/100 ({geo_risk.get('수준', 'N/A')}){ai_section}"""

    def _get_key_message(self) -> str:
        portfolio_risk = self.risk_val.get("_포트폴리오리스크", {})
        avg_risk = portfolio_risk.get("평균리스크점수", 50)

        if avg_risk < 30:
            return "시장 환경 우호적 — 저평가 우량주 선별 매수 적기"
        elif avg_risk < 50:
            return "중립적 시장 — 섹터 선별, 분할 매수 전략 권장"
        else:
            return "리스크 주의 구간 — 비중 축소 및 현금 확보 권장"

    def _securities_reports_section(self) -> str:
        """수집된 증권사 리포트 컨센서스 섹션"""
        lines = [
            "【 증권사 애널리스트 리포트 컨센서스 】",
            "─" * 65,
        ]
        found = False
        for name, data in self.financial.items():
            brokerage = data.get("증권사리포트", {})
            if not brokerage or isinstance(brokerage, Exception):
                continue
            reports = brokerage.get("reports", [])
            consensus = brokerage.get("consensus", {})
            if not reports:
                continue
            found = True
            lines += [
                f"",
                f"▶ {name}",
                f"  컨센서스 목표주가: {consensus.get('평균목표주가','N/A')} "
                f"(최고 {consensus.get('최고목표주가','N/A')} / 최저 {consensus.get('최저목표주가','N/A')})",
                f"  수집 리포트: {consensus.get('리포트수',0)}건 | 의견분포: {consensus.get('의견분포',{})}",
            ]
            for r in reports[:4]:
                firm = r.get("증권사","")
                title = r.get("제목","")[:35]
                date = r.get("날짜","")
                tp = r.get("목표주가","")
                op = r.get("투자의견","")
                lines.append(f"    [{date}] {firm:<10} {op:<6} TP:{tp:<10} {title}")

        if not found:
            lines.append("  수집된 리포트 없음 (네이버 금융 연결 확인 필요)")

        return "\n".join(lines)

    def _market_overview(self) -> str:
        eco = self.economic
        geo = self.geo

        interest = eco.get("금리", {})
        fx = eco.get("환율", {})
        inflation = eco.get("물가", {})
        indices = eco.get("지수", {})
        commodities = eco.get("원자재", {})
        calendar = eco.get("경제캘린더", {})

        kr_rate = interest.get("한국기준금리", {})
        us_rate = interest.get("미국연방기금금리", {})
        usdkrw = fx.get("원달러(USD/KRW)", {})
        kr_cpi = inflation.get("한국CPI", {})
        us_cpi = inflation.get("미국CPI", {})
        wti = commodities.get("WTI원유", {})
        gold = commodities.get("금", {})

        geo_issues = geo.get("미중관계", {})
        trade = geo.get("무역정책", {})

        key_events = calendar.get("이번주_주요일정", [])
        events_str = "\n  ".join([f"• {e.get('날짜','')} {e.get('이벤트','')}" for e in key_events])

        sp500 = indices.get("SP500", {})
        nasdaq = indices.get("나스닥", {})
        vix = indices.get("공포지수(VIX)", {})

        return f"""【 시장 환경 분석 】
─────────────────────────────────────────────────────────────────────
■ 금리
  한국 기준금리: {kr_rate.get('현재', 'N/A')}% ({kr_rate.get('방향', 'N/A')})
    → {kr_rate.get('코멘트', '')}
  미국 FOMC: {us_rate.get('목표범위', 'N/A')} ({us_rate.get('방향', 'N/A')})
    → {us_rate.get('코멘트', '')}
  한미 금리차: {interest.get('한미금리차', 'N/A')}%p

■ 환율·물가
  원달러: {_fmt_num(usdkrw.get('현재'), ",")}원 ({usdkrw.get('방향', '')})
    주요요인: {', '.join(usdkrw.get('주요요인', []))}
  한국 CPI: {kr_cpi.get('전년동월비', 'N/A')}% (핵심 {kr_cpi.get('코어CPI', 'N/A')}%)
  미국 CPI: {us_cpi.get('전년동월비', 'N/A')}% — {us_cpi.get('코멘트', '')}

■ 글로벌 지수
  S&P500: {_fmt_num(sp500.get('현재'), ",")} ({_fmt_chg(sp500.get('전일대비_pct', 0))})
  나스닥: {_fmt_num(nasdaq.get('현재'), ",")} ({_fmt_chg(nasdaq.get('전일대비_pct', 0))})
  VIX (공포지수): {vix.get('현재', 'N/A')} → {vix.get('수준', '')} ({vix.get('코멘트', '')})

■ 원자재
  WTI 원유: ${wti.get('현재', 'N/A')}/배럴 ({wti.get('방향', '')})
  금: ${_fmt_num(gold.get('현재'), ",")}/온스 ({gold.get('코멘트', '')})

■ 지정학·무역
  미중관계: {geo_issues.get('현황', 'N/A')}
  관세영향: {str(trade.get('미국관세정책', {}).get('현황', 'N/A'))}

■ 이번 주 주요 일정
  {events_str}"""

    def _top_picks(self) -> str:
        ranked = sorted(
            self.analyses.items(),
            key=lambda x: x[1].get("매매시점", {}).get("종합점수", 0),
            reverse=True
        )

        lines = ["【 TOP 추천 종목 】",
                 "─────────────────────────────────────────────────────────────────────",
                 f"{'순위':<4} {'종목명':<16} {'등급':<12} {'현재가':>10} {'목표가':>10} {'상승여력':>8} {'매매행동':<12}",
                 "─" * 70]

        for i, (name, data) in enumerate(ranked[:7], 1):
            opinion = data.get("투자의견", {})
            intrinsic = data.get("내재가치", {})
            timing = data.get("매매시점", {})
            current = data.get("현재가", 0)
            target = opinion.get("목표주가", 0)
            upside = intrinsic.get("상승여력", 0)
            rating = opinion.get("투자등급", "N/A")
            action = timing.get("매매행동", "관망")

            rating_emoji = {"BUY": "🟢", "OVERWEIGHT": "🔵", "NEUTRAL": "⚪", "UNDERWEIGHT": "🔴"}.get(rating, "⚪")

            lines.append(
                f"{i:<4} {name:<16} {rating_emoji}{rating:<11} "
                f"{current:>10,} {target:>10,} {upside:>+7.1f}% {action:<12}"
            )

        lines.append("")
        warn_stocks = [n for n, v in self.data_val.items() if v.get("경고") and not n.startswith("_")]
        if warn_stocks:
            lines.append(f"  ⚠️  데이터 검증 주의 종목: {', '.join(warn_stocks)}")
            lines.append("       (재무데이터 이상 감지 — 투자 전 추가 확인 권장)")

        return "\n".join(lines)

    def _investor_flow(self) -> str:
        lines = ["【 투자자별 수급 동향 (외국인 / 기관 / 개인) 】",
                 "─────────────────────────────────────────────────────────────────────",
                 f"{'종목명':<16} {'외국인(전체)':<16} {'외국인(5일)':<14} {'기관(전체)':<14} {'기관(5일)':<12} {'수급신호'}",
                 "─" * 90]

        for corp_name, data in self.financial.items():
            supply = data.get("수급", {})
            if "error" in supply or not supply:
                continue

            foreign = supply.get("외국인합계", {})
            institution = supply.get("기관합계", {})
            supply_signal = self.analyses.get(corp_name, {}).get("수급분석", {}).get("종합수급신호", "N/A")

            f_total = foreign.get("순매수_전체", 0)
            f_5d = foreign.get("순매수_최근5일", 0)
            i_total = institution.get("순매수_전체", 0)
            i_5d = institution.get("순매수_최근5일", 0)

            def fmt_val(v):
                if v == 0:
                    return "      0"
                b = v / 1_000_000_000
                sign = "+" if v > 0 else ""
                return f"{sign}{b:.0f}억"

            lines.append(
                f"{corp_name:<16} {fmt_val(f_total):<16} {fmt_val(f_5d):<14} "
                f"{fmt_val(i_total):<14} {fmt_val(i_5d):<12} {supply_signal}"
            )

        lines.append("")
        lines.append("  ℹ️  금액 단위: 억원  |  + 순매수  - 순매도")
        lines.append("  ℹ️  최근5일 수급이 방향성 전환의 선행 지표로 활용됨")
        return "\n".join(lines)

    def _sector_analysis(self) -> str:
        industry = self.industry
        opportunities = [
            {"섹터": "반도체", "기회": "HBM·AI반도체 수요 폭발", "위험": "중국 규제, 납품 지연"},
            {"섹터": "배터리", "기회": "IRA 수혜, EV 전환", "위험": "중국 LFP 경쟁"},
            {"섹터": "바이오", "기회": "CDMO 수주, 바이오시밀러", "위험": "임상 실패"},
            {"섹터": "방산", "기회": "유럽 재무장 수출", "위험": "지정학 해소 시 수요 감소"},
            {"섹터": "AI인프라", "기회": "전력·냉각·네트워크", "위험": "AI 버블"},
        ]

        lines = ["【 섹터별 투자 기회 분석 】",
                 "─────────────────────────────────────────────────────────────────────"]

        semi = industry.get("반도체", {})
        if semi:
            lines.append(f"■ 반도체")
            lines.append(f"  {semi.get('글로벌동향', {}).get('시장규모', '')}")
            lines.append(f"  핵심이슈: {semi.get('주요기업동향', {}).get('삼성전자', '')}")
            lines.append(f"  투자시사점: {semi.get('투자시사점', '')}")
            lines.append("")

        battery = industry.get("배터리EV", {})
        if battery:
            kr_battery = battery.get("한국배터리3사", {})
            lines.append(f"■ 배터리·EV")
            lines.append(f"  LG에너지솔루션: {kr_battery.get('LG에너지솔루션', '')}")
            lines.append(f"  삼성SDI: {kr_battery.get('삼성SDI', '')}")
            lines.append(f"  SK온: {kr_battery.get('SK온', '')}")
            lines.append("")

        for opp in opportunities:
            lines.append(f"  [{opp['섹터']}]  기회: {opp['기회']}  |  위험: {opp['위험']}")

        return "\n".join(lines)

    def _detailed_stock_analysis(self) -> str:
        lines = ["【 종목별 상세 분석 】",
                 "─────────────────────────────────────────────────────────────────────"]

        sorted_analyses = sorted(
            self.analyses.items(),
            key=lambda x: x[1].get("매매시점", {}).get("종합점수", 0),
            reverse=True
        )

        for corp_name, analysis in sorted_analyses:
            opinion = analysis.get("투자의견", {})
            intrinsic = analysis.get("내재가치", {})
            technical = analysis.get("기술적분석", {})
            supply = analysis.get("수급분석", {})
            timing = analysis.get("매매시점", {})
            risk = self.risk_val.get(corp_name, {})
            logic = self.logic_val.get(corp_name, {})

            rating = opinion.get("투자등급", "N/A")
            rating_emoji = {"BUY": "🟢", "OVERWEIGHT": "🔵", "NEUTRAL": "⚪", "UNDERWEIGHT": "🔴"}.get(rating, "⚪")

            lines.append(f"\n▶ {corp_name} ({analysis.get('섹터', '')})  {rating_emoji} {rating}")
            lines.append(f"  현재가: {analysis.get('현재가', 0):,}원  |  목표가: {opinion.get('목표주가', 0):,}원  |  상승여력: {intrinsic.get('상승여력', 0):+.1f}%")
            lines.append(f"  PER: {intrinsic.get('현재PER', 'N/A')}  |  PBR: {intrinsic.get('현재PBR', 'N/A')}  |  업종평균PER: {intrinsic.get('업종적정PER', 'N/A')}")
            lines.append(f"  저평가판단: {intrinsic.get('저평가판단', 'N/A')}  |  저평가스코어: {intrinsic.get('저평가스코어', 0)}/100")
            lines.append(f"  기술적추세: {technical.get('추세', 'N/A')}  |  RSI: {technical.get('RSI_14', 'N/A')}  |  신호: {', '.join(technical.get('기술신호', ['없음']))}")
            lines.append(f"  수급: {supply.get('종합수급신호', 'N/A')}")
            lines.append(f"  매매행동: {timing.get('매매행동', 'N/A')}  |  매수구간: {timing.get('매수구간', 'N/A')}")
            lines.append(f"  매도구간: {timing.get('매도구간', 'N/A')}  |  손절기준: {timing.get('손절기준', 'N/A')}")
            lines.append(f"  리스크수준: {risk.get('리스크수준', 'N/A')} ({risk.get('리스크점수', 'N/A')}/100)")
            lines.append(f"  핵심근거: {' / '.join(timing.get('근거', ['N/A'])[:3])}")
            if opinion.get("주요리스크"):
                lines.append(f"  주요리스크: {' / '.join(opinion.get('주요리스크', []))}")
            if logic.get("검증이슈"):
                lines.append(f"  ⚠️ 검증이슈: {' / '.join(logic.get('검증이슈', []))}")
            ai_text = opinion.get("AI분석", "")
            if ai_text:
                lines.append(f"  🤖 AI분석: {ai_text}")

        return "\n".join(lines)

    def _risk_report(self) -> str:
        portfolio_risk = self.risk_val.get("_포트폴리오리스크", {})
        portfolio_logic = self.logic_val.get("_포트폴리오검증", {})

        lines = ["【 리스크 종합 보고 】",
                 "─────────────────────────────────────────────────────────────────────",
                 f"포트폴리오 평균 리스크: {portfolio_risk.get('평균리스크점수', 'N/A')}/100 ({portfolio_risk.get('포트폴리오위험수준', 'N/A')})",
                 f"고위험 종목: {portfolio_risk.get('고위험종목수', 0)}개 / {portfolio_risk.get('전체종목수', 0)}개",
                 f"권고사항: {portfolio_risk.get('권고사항', 'N/A')}",
                 ""]

        if portfolio_logic.get("포트폴리오경고"):
            lines.append("포트폴리오 경고:")
            for warn in portfolio_logic["포트폴리오경고"]:
                lines.append(f"  {warn}")
            lines.append("")

        high_risk = [
            (name, v) for name, v in self.risk_val.items()
            if not name.startswith("_") and v.get("리스크점수", 0) >= 50
        ]
        if high_risk:
            lines.append("주의 필요 고위험 종목:")
            for name, v in high_risk:
                risks_str = ", ".join([r.get("내용", "") for r in v.get("리스크목록", [])[:3]])
                lines.append(f"  ⚠️ {name}: {risks_str}")

        return "\n".join(lines)

    def _scenarios(self) -> str:
        scenarios = self.risk_val.get("_시나리오분석", {})
        lines = ["【 시나리오 분석 (스트레스 테스트) 】",
                 "─────────────────────────────────────────────────────────────────────"]

        for key, sc in scenarios.items():
            label = key.replace("_", " ")
            prob = sc.get("확률", "")
            lines.append(f"■ {label} (확률: {prob})")
            lines.append(f"  전제: {sc.get('전제', sc.get('예상', ''))}")
            if "예상충격" in sc:
                lines.append(f"  충격: {sc['예상충격']}")
            if "대응" in sc:
                lines.append(f"  대응: {sc['대응']}")
            lines.append("")

        return "\n".join(lines)

    def _action_plan(self) -> str:
        top_buys = [
            (name, data) for name, data in self.analyses.items()
            if data.get("투자의견", {}).get("투자등급") in ["BUY", "OVERWEIGHT"]
        ][:3]

        lines = ["【 오늘의 행동 계획 (Action Plan) 】",
                 "─────────────────────────────────────────────────────────────────────"]

        if self._ai_action:
            lines.append("🤖 AI 액션 플랜 (Claude):")
            lines.append(self._ai_action)
            lines.append("")
            lines.append("■ 매수 검토 종목 (규칙 기반):")
        else:
            lines.append("■ 매수 검토 종목:")

        if top_buys:
            for name, data in top_buys:
                timing = data.get("매매시점", {})
                intrinsic = data.get("내재가치", {})
                lines.append(f"  ✅ {name}: {timing.get('매수구간', '')} / 목표 {intrinsic.get('목표주가', 0):,}원")

        lines.append("")
        lines.append("■ 공통 원칙:")
        lines.append("  • 분할 매수 원칙 (3~5회 분할, 1회 매수 비중 최대 40%)")
        lines.append("  • 손절 기준 준수 (매수가 대비 -8% 이탈 시 즉시 매도)")
        lines.append("  • 목표가 도달 전 70%에서 절반 익절 고려")
        lines.append("  • 미국 관세 뉴스·FOMC 결정 전날은 신규 매수 자제")
        lines.append("")
        lines.append("■ 모니터링 포인트:")
        calendar = self.economic.get("경제캘린더", {})
        for item in calendar.get("시장_핵심변수", []):
            lines.append(f"  🔍 {item}")

        return "\n".join(lines)

    def _get_top_picks_list(self) -> list:
        ranked = sorted(
            self.analyses.items(),
            key=lambda x: x[1].get("매매시점", {}).get("종합점수", 0),
            reverse=True,
        )
        return [
            {
                "종목명": name,
                "목표주가": data.get("투자의견", {}).get("목표주가", 0),
                "의견": data.get("투자의견", {}).get("투자등급", "N/A"),
            }
            for name, data in ranked[:5]
        ]

    def _footer(self) -> str:
        return f"""{'─'*70}
⚠️  투자 주의사항:
  본 보고서는 AI 기반 자동 분석 시스템이 생성한 투자 참고 자료입니다.
  투자 손익에 대한 최종 책임은 투자자 본인에게 있으며,
  반드시 개인의 투자 성향과 리스크 허용 범위를 고려하여 판단하시기 바랍니다.
  과거 수익률이 미래 수익을 보장하지 않습니다.
{'='*70}
다음 보고서: {'저녁 10시' if self.report_time.hour < 12 else '익일 오전 7시'}
{'='*70}"""

    def _save_report(self, report: str):
        timestamp = self.report_time.strftime("%Y%m%d_%H%M")
        filename = f"report_{timestamp}.txt"
        filepath = os.path.join(REPORTS_DIR, filename)

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(report)

        json_data = {
            "생성시각": self.report_time.isoformat(),
            "분석종목": {
                name: {
                    "투자등급": data.get("투자의견", {}).get("투자등급"),
                    "목표주가": data.get("투자의견", {}).get("목표주가"),
                    "상승여력": data.get("내재가치", {}).get("상승여력"),
                    "매매행동": data.get("매매시점", {}).get("매매행동"),
                    "리스크": self.risk_val.get(name, {}).get("리스크수준"),
                }
                for name, data in self.analyses.items()
            },
            "시장환경": {
                "KOSPI": self.economic.get("지수", {}).get("KOSPI", {}).get("close"),
                "원달러": self.economic.get("환율", {}).get("원달러(USD/KRW)", {}).get("현재"),
                "VIX": self.economic.get("지수", {}).get("공포지수(VIX)", {}).get("현재"),
            },
        }

        json_path = os.path.join(REPORTS_DIR, f"report_{timestamp}.json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(json_data, f, ensure_ascii=False, indent=2)

        print(f"📁 보고서 저장: {filepath}")
