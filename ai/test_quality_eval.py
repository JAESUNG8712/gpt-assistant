"""운영 검색 품질 평가와 이력 저장 회귀 테스트."""

import os
import tempfile


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "quality-eval.db")

        import engine
        import memory
        import quality_eval

        memory._seed_static_kb_to_db = lambda: None
        memory.init_db()
        test_engine = engine._Engine()
        test_engine.add(
            "FastAPI 스트리밍 응답",
            "StreamingResponse를 사용합니다.",
            {"persona": "dev", "source": "golden"},
        )
        original_get_engine = quality_eval.engine.get_engine
        quality_eval.engine.get_engine = lambda: test_engine
        try:
            result = quality_eval.run([
                {
                    "name": "정상", "persona": "dev", "query": "FastAPI 스트리밍",
                    "expected_any": ["streamingresponse"],
                },
                {
                    "name": "금지어", "persona": "dev", "query": "FastAPI 스트리밍",
                    "expected_any": ["streamingresponse"], "forbidden_any": ["사용합니다"],
                },
            ], min_score=0.1, required_pass_rate=0.5)
        finally:
            quality_eval.engine.get_engine = original_get_engine

        assert result["status"] == "passed"
        assert result["passed"] == 1 and result["total"] == 2
        assert result["cases"][0]["top_source"] == "golden"
        assert result["cases"][1]["reasons"][0].startswith("금지 키워드")
        run_id = memory.record_memory_quality_eval(result)
        assert run_id > 0
        history = memory.list_memory_quality_evals()
        assert history[0]["id"] == run_id
        assert len(history[0]["cases"]) == 2

        try:
            quality_eval.run([{"query": "x"}] * 201)
            raise AssertionError("200개 초과 케이스가 허용됨")
        except ValueError:
            pass

    print("quality eval tests: PASS")


if __name__ == "__main__":
    main()
