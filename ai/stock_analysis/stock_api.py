"""
FastAPI 라우터 — 주식 분석 API 엔드포인트
main.py에 include_router로 통합
"""

import asyncio
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from .pipeline import StockAnalysisPipeline, run_once
from .agents.team_config import TEAM_CONFIG, ANALYSIS_PIPELINE, REPORT_SCHEDULE

router = APIRouter(prefix="/stock", tags=["주식분석"])

# 전역 파이프라인 인스턴스
_pipeline: Optional[StockAnalysisPipeline] = None
_analysis_running = False
_last_report: Optional[str] = None
_last_run: Optional[datetime] = None


def _get_pipeline() -> StockAnalysisPipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = StockAnalysisPipeline()
    return _pipeline


class AnalysisRequest(BaseModel):
    target_stocks: Optional[List[str]] = None


@router.get("/team", summary="에이전트 팀 구성 조회")
def get_team_config():
    """11명 에이전트 팀 구성 및 파이프라인 정보 반환"""
    return {
        "팀구성": [
            {
                "역할": v["role"],
                "이모지": v["emoji"],
                "설명": v["description"],
                "인원": v["count"],
                "주요업무": v["responsibilities"],
            }
            for v in TEAM_CONFIG.values()
        ],
        "파이프라인": [
            {"단계": i+1, "에이전트": k, "설명": v}
            for i, (k, v) in enumerate(ANALYSIS_PIPELINE)
        ],
        "보고서일정": REPORT_SCHEDULE,
        "총인원": sum(v["count"] for v in TEAM_CONFIG.values()),
    }


@router.post("/analyze", summary="주식 분석 즉시 실행")
async def run_analysis(
    request: AnalysisRequest = AnalysisRequest(),
    background_tasks: BackgroundTasks = None,
):
    """전체 분석 파이프라인 즉시 실행 (비동기)"""
    global _analysis_running, _last_report, _last_run

    if _analysis_running:
        raise HTTPException(status_code=429, detail="분석이 이미 실행 중입니다. 잠시 후 시도하세요.")

    async def _run():
        global _analysis_running, _last_report, _last_run
        _analysis_running = True
        try:
            report = await run_once(request.target_stocks)
            _last_report = report
            _last_run = datetime.now()
        finally:
            _analysis_running = False

    background_tasks.add_task(_run)

    return {
        "상태": "분석 시작됨",
        "메시지": "분석이 백그라운드에서 실행 중입니다. /stock/report로 결과를 확인하세요.",
        "예상소요시간": "30~60초",
    }


@router.get("/analyze/sync", summary="주식 분석 동기 실행 (직접 응답)")
async def run_analysis_sync(
    stocks: Optional[str] = Query(None, description="콤마 구분 종목명 (예: 삼성전자,SK하이닉스)"),
):
    """분석 결과를 직접 반환 (시간 소요됨)"""
    target = [s.strip() for s in stocks.split(",")] if stocks else None

    try:
        report = await run_once(target)
        return PlainTextResponse(content=report, media_type="text/plain; charset=utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/report", summary="최근 분석 보고서 조회")
def get_latest_report():
    """가장 최근 생성된 보고서 반환"""
    if _last_report is None:
        raise HTTPException(
            status_code=404,
            detail="아직 보고서가 없습니다. /stock/analyze를 먼저 실행하세요."
        )
    return {
        "보고서": _last_report,
        "생성시각": _last_run.isoformat() if _last_run else None,
    }


@router.get("/report/text", summary="최근 보고서 텍스트 형식", response_class=PlainTextResponse)
def get_latest_report_text():
    """보고서를 plain text로 반환"""
    if _last_report is None:
        return PlainTextResponse("보고서 없음. /stock/analyze 실행 후 조회하세요.")
    return PlainTextResponse(content=_last_report, media_type="text/plain; charset=utf-8")


@router.get("/status", summary="분석 상태 확인")
def get_status():
    return {
        "실행중": _analysis_running,
        "마지막실행": _last_run.isoformat() if _last_run else None,
        "보고서있음": _last_report is not None,
        "다음정기보고서": _next_report_time(),
    }


@router.get("/reports/list", summary="저장된 보고서 목록")
def list_reports():
    """저장된 보고서 파일 목록 반환"""
    import os
    reports_dir = os.path.join(os.path.dirname(__file__), "reports")
    if not os.path.exists(reports_dir):
        return {"보고서목록": []}

    files = sorted([
        f for f in os.listdir(reports_dir)
        if f.startswith("report_") and f.endswith(".txt")
    ], reverse=True)

    return {
        "보고서목록": files[:20],
        "총개수": len(files),
        "저장경로": reports_dir,
    }


@router.get("/reports/{filename}", summary="특정 보고서 조회", response_class=PlainTextResponse)
def get_report_by_filename(filename: str):
    """파일명으로 특정 보고서 조회"""
    import os
    if not filename.startswith("report_") or ".." in filename:
        raise HTTPException(status_code=400, detail="잘못된 파일명")

    reports_dir = os.path.join(os.path.dirname(__file__), "reports")
    filepath = os.path.join(reports_dir, filename)

    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="파일 없음")

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    return PlainTextResponse(content=content, media_type="text/plain; charset=utf-8")


def _next_report_time() -> str:
    now = datetime.now()
    if now.hour < 7:
        return f"오늘 07:00 (오전 정기 보고서)"
    elif now.hour < 22:
        return f"오늘 22:00 (저녁 정기 보고서)"
    else:
        return f"내일 07:00 (오전 정기 보고서)"


def start_scheduler(app, target_stocks=None):
    """FastAPI lifespan에서 APScheduler 시작"""
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.cron import CronTrigger

        scheduler = AsyncIOScheduler()
        pipeline = StockAnalysisPipeline(target_stocks)

        async def _scheduled_run(label: str):
            global _last_report, _last_run
            print(f"\n⏰ {label} 자동 실행")
            report = await pipeline.run()
            _last_report = report
            _last_run = datetime.now()

        for session_id, config in REPORT_SCHEDULE.items():
            scheduler.add_job(
                _scheduled_run,
                CronTrigger(hour=config["hour"], minute=config["minute"]),
                args=[config["label"]],
                id=f"stock_report_{session_id}",
                name=config["label"],
                misfire_grace_time=600,
                coalesce=True,
            )

        scheduler.start()
        print("✅ 주식 분석 스케줄러 시작 (오전 7시 / 저녁 10시)")
        return scheduler

    except ImportError:
        print("⚠️  APScheduler 미설치 — 자동 스케줄 비활성화")
        print("    pip install apscheduler 후 재시작 필요")
        return None
