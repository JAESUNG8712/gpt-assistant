"""
👔 총괄 관리자 — 전체 분석 파이프라인 조율
오전 7시 / 저녁 10시 자동 실행 스케줄러 포함
"""

import asyncio
import json
import os
import traceback
from datetime import datetime
from typing import Dict, List, Optional

from .agents.team_config import TEAM_CONFIG, ANALYSIS_PIPELINE, REPORT_SCHEDULE
from .utils.email_sender import send_report, is_configured as email_configured
from .agents.financial_collector import FinancialCollector
from .agents.economic_collector import EconomicCollector
from .agents.global_collector import GeopoliticsCollector, IndustryCollector
from .agents.aggregator import DataAggregator
from .agents.analyzer import StockAnalyzer
from .agents.validators import FinancialDataValidator, LogicValidator, RiskValidator
from .agents.report_writer import ReportWriter


class StockAnalysisPipeline:
    """
    👔 총괄 관리자
    11명 에이전트 팀 전체 파이프라인 조율
    """

    DEFAULT_TARGETS = [
        "삼성전자", "SK하이닉스", "LG에너지솔루션",
        "삼성바이오로직스", "현대차", "기아",
        "POSCO홀딩스", "셀트리온", "KB금융",
        "신한지주", "카카오", "NAVER",
        "LG화학", "삼성SDI", "현대모비스",
    ]

    def __init__(self, target_stocks: Optional[List[str]] = None, verbose: bool = True):
        self.target_stocks = target_stocks or self.DEFAULT_TARGETS
        self.verbose = verbose
        self.last_report: Optional[str] = None
        self.last_run: Optional[datetime] = None
        self.error_log: List[Dict] = []

    def log(self, msg: str):
        if self.verbose:
            ts = datetime.now().strftime("%H:%M:%S")
            print(f"[{ts}] {msg}")

    async def run(self) -> str:
        """전체 분석 파이프라인 실행"""
        start = datetime.now()
        self.log("👔 [총괄] 분석 파이프라인 시작")
        self.log(f"    분석 대상: {len(self.target_stocks)}개 종목")
        self.log(f"    팀 구성: {sum(v['count'] for v in TEAM_CONFIG.values())}명")

        try:
            # ─── STEP 1: 병렬 데이터 수집 ─────────────────────────────────
            self.log("\n── STEP 1: 데이터 수집 (4개 에이전트 병렬 실행) ──")
            financial_data, economic_data, geo_data, industry_data = \
                await self._step1_collect()

            # ─── STEP 2: 데이터 취합 ──────────────────────────────────────
            self.log("\n── STEP 2: 자료 취합 ──")
            aggregated = self._step2_aggregate(
                financial_data, economic_data, geo_data, industry_data)

            # ─── STEP 3: 상세 분석 ────────────────────────────────────────
            self.log("\n── STEP 3: 상세 분석 ──")
            analyses = self._step3_analyze(
                financial_data, economic_data, geo_data, industry_data)

            # ─── STEP 4: 교차 검증 3회 ────────────────────────────────────
            self.log("\n── STEP 4: 교차 검증 (3개 에이전트 병렬 실행) ──")
            data_val, logic_val, risk_val = self._step4_validate(
                financial_data, analyses, economic_data, geo_data, industry_data)

            # ─── STEP 5: 최종 보고서 작성 ────────────────────────────────
            self.log("\n── STEP 5: 최종 보고서 작성 ──")
            report = self._step5_report(
                analyses, financial_data, economic_data,
                geo_data, industry_data, data_val, logic_val, risk_val)

            elapsed = (datetime.now() - start).total_seconds()
            self.log(f"\n👔 [총괄] 파이프라인 완료 — {elapsed:.1f}초")

            self.last_report = report
            self.last_run = datetime.now()

            # 이메일 자동 발송
            if email_configured():
                self.log("\n── 이메일 발송 ──")
                send_report(report)
            else:
                self.log("    (이메일 미설정 — EMAIL_SENDER/EMAIL_PASSWORD/EMAIL_RECIPIENTS 설정 시 자동 발송)")

            return report

        except Exception as e:
            tb = traceback.format_exc()
            self.error_log.append({
                "시각": datetime.now().isoformat(),
                "오류": str(e),
                "traceback": tb,
            })
            self.log(f"❌ [총괄] 오류 발생: {e}")
            return self._error_report(str(e), tb)

    async def _step1_collect(self):
        """4개 수집 에이전트 병렬 실행"""
        fin = FinancialCollector(self.target_stocks)
        eco = EconomicCollector()
        geo = GeopoliticsCollector()
        ind = IndustryCollector()

        results = await asyncio.gather(
            fin.run(),
            eco.run(),
            geo.run(),
            ind.run(),
            return_exceptions=True,
        )

        financial_data = results[0] if not isinstance(results[0], Exception) else {}
        economic_data = results[1] if not isinstance(results[1], Exception) else {}
        geo_data = results[2] if not isinstance(results[2], Exception) else {}
        industry_data = results[3] if not isinstance(results[3], Exception) else {}

        self.log(f"    재무수집: {len(financial_data)}개 종목")
        self.log(f"    경제수집: {len(economic_data)}개 지표")
        self.log(f"    지정학: {len(geo_data)}개 항목")
        self.log(f"    산업동향: {len(industry_data)}개 항목")

        return financial_data, economic_data, geo_data, industry_data

    def _step2_aggregate(self, financial_data, economic_data, geo_data, industry_data):
        agg = DataAggregator(financial_data, economic_data, geo_data, industry_data)
        result = agg.run()
        quality = result.get("데이터품질", {})
        if quality.get("이슈목록"):
            for issue in quality["이슈목록"]:
                self.log(f"    ⚠️  {issue}")
        return result

    def _step3_analyze(self, financial_data, economic_data, geo_data, industry_data):
        analyzer = StockAnalyzer(financial_data, economic_data, geo_data, industry_data)
        analyses = analyzer.run()
        top = analyzer.get_top_picks(3)
        self.log(f"    TOP3: {', '.join([t['종목'] for t in top])}")
        return analyses

    def _step4_validate(self, financial_data, analyses, economic_data, geo_data, industry_data):
        """3개 검증 에이전트 순차 실행 (서로 독립적)"""
        val1 = FinancialDataValidator(financial_data, analyses)
        data_val = val1.run()

        val2 = LogicValidator(analyses, financial_data, economic_data, data_val)
        logic_val = val2.run()

        val3 = RiskValidator(analyses, financial_data, geo_data, industry_data)
        risk_val = val3.run()

        flagged = val1.get_flagged_stocks()
        if flagged:
            self.log(f"    ⚠️  데이터 이상 감지: {[f[0] for f in flagged]}")

        portfolio_issues = logic_val.get("_포트폴리오검증", {}).get("포트폴리오경고", [])
        for warn in portfolio_issues:
            self.log(f"    {warn}")

        return data_val, logic_val, risk_val

    def _step5_report(self, analyses, financial_data, economic_data,
                       geo_data, industry_data, data_val, logic_val, risk_val):
        writer = ReportWriter(
            analyses, financial_data, economic_data,
            geo_data, industry_data, data_val, logic_val, risk_val,
        )
        return writer.run()

    def _error_report(self, error: str, tb: str) -> str:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return f"""{'='*60}
⚠️ 분석 오류 보고서 | {now}
{'='*60}
오류: {error}

{tb}

재실행하거나 관리자에게 문의하세요.
{'='*60}"""

    def print_team_config(self):
        """팀 구성 출력"""
        print("\n" + "="*60)
        print("📊 주식 분석 에이전트 팀 구성")
        print("="*60)
        total = 0
        for step_id, step_desc in ANALYSIS_PIPELINE:
            cfg = TEAM_CONFIG.get(step_id, {})
            print(f"  {cfg.get('emoji', '•')} {cfg.get('role', step_id)}")
            print(f"     → {step_desc}")
            total += cfg.get("count", 1)
        print(f"\n  총 {total}명 에이전트")
        print("="*60 + "\n")


# ── 스케줄러 ───────────────────────────────────────────────────────────

async def schedule_reports(target_stocks: Optional[List[str]] = None):
    """
    오전 7시, 저녁 10시 자동 보고서 생성 스케줄러
    APScheduler 기반 실행
    """
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.cron import CronTrigger
    except ImportError:
        print("⚠️  APScheduler 미설치. pip install apscheduler")
        print("    수동 실행 모드로 전환합니다.")
        await _manual_run(target_stocks)
        return

    pipeline = StockAnalysisPipeline(target_stocks)
    pipeline.print_team_config()

    scheduler = AsyncIOScheduler()

    for session_id, config in REPORT_SCHEDULE.items():
        scheduler.add_job(
            _run_and_print,
            CronTrigger(hour=config["hour"], minute=config["minute"]),
            args=[pipeline, config["label"]],
            id=f"report_{session_id}",
            name=config["label"],
            misfire_grace_time=300,
            coalesce=True,
        )
        print(f"✅ 스케줄 등록: {config['label']} (매일 {config['hour']:02d}:{config['minute']:02d})")

    scheduler.start()
    print(f"\n🔄 스케줄러 실행 중... (Ctrl+C로 종료)\n")

    try:
        while True:
            await asyncio.sleep(60)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        print("\n⏹  스케줄러 종료")


async def _run_and_print(pipeline: StockAnalysisPipeline, label: str):
    print(f"\n{'='*60}")
    print(f"⏰ {label} 시작")
    print(f"{'='*60}")
    report = await pipeline.run()
    print(report)


async def _manual_run(target_stocks: Optional[List[str]] = None):
    pipeline = StockAnalysisPipeline(target_stocks)
    pipeline.print_team_config()
    report = await pipeline.run()
    print(report)


async def run_once(target_stocks: Optional[List[str]] = None) -> str:
    """단발 분석 실행 (API 호출 등)"""
    pipeline = StockAnalysisPipeline(target_stocks)
    return await pipeline.run()
