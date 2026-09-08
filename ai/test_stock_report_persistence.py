"""주식 보고서가 프로세스 재시작 뒤에도 DB에서 복원되는지 검증."""

import importlib
import asyncio
import os
import tempfile
from datetime import datetime, timedelta


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "stock-report.db")

        import stock_report_store as store

        base = datetime(2026, 9, 8, 7, 0, 0)
        for idx in range(22):
            created = base + timedelta(minutes=idx)
            store.save_report(
                f"영구 보고서 {idx}",
                created_at=created.isoformat(),
                filename=f"report_{created.strftime('%Y%m%d_%H%M%S')}.txt",
            )

        items = store.list_reports()
        assert len(items) == store.MAX_REPORTS
        assert items[0]["filename"] == "report_20260908_072100.txt"
        assert store.get_report(items[0]["filename"]) == "영구 보고서 21"
        assert store.get_report("report_20260908_070000.txt") is None

        # 모듈 메모리 상태가 초기화되어도 DB 값으로 동일하게 복원되어야 한다.
        store = importlib.reload(store)
        latest = store.latest_report()
        assert latest["content"] == "영구 보고서 21"
        assert latest["created_at"] == "2026-09-08T07:21:00"

        # 실제 run_once 진입점이 성공 보고서를 영구 저장하고 오류 보고서는
        # 정상 완료로 위장하지 않는지 외부 데이터 수집 없이 검증한다.
        import stock_analysis.pipeline as pipeline_module
        original_pipeline = pipeline_module.StockAnalysisPipeline

        class FakePipeline:
            def __init__(self, _targets=None):
                self.error_log = []
                self.last_run = datetime(2026, 9, 8, 8, 0, 0)

            async def run(self):
                return "run_once 영구 저장 보고서"

        pipeline_module.StockAnalysisPipeline = FakePipeline
        try:
            result = asyncio.run(pipeline_module.run_once(["테스트종목"]))
        finally:
            pipeline_module.StockAnalysisPipeline = original_pipeline
        assert result == "run_once 영구 저장 보고서"
        assert store.latest_report()["content"] == result

        class ErrorPipeline(FakePipeline):
            async def run(self):
                self.error_log = [{"오류": "수집 실패"}]
                return "⚠️ 분석 오류 보고서"

        pipeline_module.StockAnalysisPipeline = ErrorPipeline
        try:
            try:
                asyncio.run(pipeline_module.run_once())
                raise AssertionError("pipeline error was accepted as a report")
            except RuntimeError as exc:
                assert "수집 실패" in str(exc)
        finally:
            pipeline_module.StockAnalysisPipeline = original_pipeline
        assert store.latest_report()["content"] == result

        for invalid in ("../report.txt", "report_latest.txt", "report_20260908_070.txt"):
            try:
                store.get_report(invalid)
                raise AssertionError(f"invalid filename accepted: {invalid}")
            except ValueError:
                pass

    print("stock report persistence tests: PASS")


if __name__ == "__main__":
    main()
