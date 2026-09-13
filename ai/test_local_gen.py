"""로컬 생성형 모델(실험적, 기본 비활성) 회귀 테스트.

핵심 계약: LOCAL_GEN_MODEL_PATH/LOCAL_GEN_MODEL_URL이 둘 다 미설정이면(기본값)
llama_cpp를 임포트조차 하지 않고 완전히 비활성이어야 하며, 설정돼 있어도
실패·타임아웃 등 어떤 경우든 예외 없이 None을 반환해 호출측(llm._local_stream)이
기존 순수 추출 엔진으로 안전하게 이어가야 한다. 2026-09-13 실측(SmolLM2-135M
한국어 붕괴, Gemma-3-270M 근거 무시 할루시네이션, Qwen2.5-0.5B 용량 초과)에 따라
기본은 비활성을 유지하고, 활성화 시에도 실패가 곧 서비스 장애로 이어지지
않는지가 이 테스트의 핵심 관심사다.
"""
import asyncio
import os
import sys
import tempfile
import types

AI_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI_DIR)


def _reset_local_gen(module, model_path="", model_url=""):
    module.MODEL_PATH = model_path
    module.MODEL_URL = model_url
    module._model = None
    module._load_failed = False


def _test_disabled_by_default():
    import local_gen
    _reset_local_gen(local_gen)
    assert local_gen.is_configured() is False

    # llama_cpp가 설치되어 있지 않은 CI 환경에서도 안전해야 한다 — is_configured()가
    # False인 경로에서는 아예 시도조차 하지 않으므로 임포트 오류가 날 수 없다.
    result = asyncio.run(local_gen.generate(
        [{"role": "user", "content": "질문"}], "컨텍스트", "시스템",
    ))
    assert result is None
    print("local_gen disabled-by-default: PASS")


def _test_configured_but_model_missing():
    import local_gen
    with tempfile.TemporaryDirectory() as tmp:
        missing_path = os.path.join(tmp, "no-such-model.gguf")
        _reset_local_gen(local_gen, model_path=missing_path)
        assert local_gen.is_configured() is True
        # 파일이 없고 URL도 없으면 다운로드 시도 없이 안전하게 None
        result = asyncio.run(local_gen.generate(
            [{"role": "user", "content": "질문"}], "", "시스템",
        ))
        assert result is None
        assert local_gen._load_failed is True
    _reset_local_gen(local_gen)
    print("local_gen configured-but-missing-file: PASS")


def _test_empty_user_message_no_load_attempt():
    import local_gen
    with tempfile.TemporaryDirectory() as tmp:
        _reset_local_gen(local_gen, model_path=os.path.join(tmp, "x.gguf"))
        calls = []
        original_load = local_gen._load_model_sync
        local_gen._load_model_sync = lambda: calls.append(1)
        try:
            result = asyncio.run(local_gen.generate([], "ctx", "sys"))
            assert result is None
            assert not calls  # 사용자 메시지가 없으면 모델 로드 자체를 시도하지 않음
        finally:
            local_gen._load_model_sync = original_load
    _reset_local_gen(local_gen)
    print("local_gen empty-user-message: PASS")


def _test_successful_generation_has_marker():
    import local_gen

    class _FakeModel:
        def create_chat_completion(self, messages, max_tokens, temperature):
            # 시스템 프롬프트에 참고 자료가 실제로 전달됐는지 확인
            sys_text = messages[0]["content"]
            assert "참고 자료" in sys_text
            assert "연차" in sys_text
            return {"choices": [{"message": {"content": "  연차는 15일입니다.  "}}]}

    with tempfile.TemporaryDirectory() as tmp:
        _reset_local_gen(local_gen, model_path=os.path.join(tmp, "x.gguf"))
        original_load = local_gen._load_model_sync
        local_gen._load_model_sync = lambda: _FakeModel()
        try:
            result = asyncio.run(local_gen.generate(
                [{"role": "user", "content": "연차 며칠이야"}],
                "연차는 근속 1년당 15일 발생합니다.",
                "당신은 어시스턴트입니다.",
            ))
        finally:
            local_gen._load_model_sync = original_load
    _reset_local_gen(local_gen)
    assert result is not None
    assert local_gen.MARKER_TAG in result
    assert "연차는 15일입니다." in result
    print("local_gen successful-generation: PASS")


def _test_inference_exception_returns_none():
    import local_gen

    class _BrokenModel:
        def create_chat_completion(self, *a, **kw):
            raise RuntimeError("모의 추론 실패")

    with tempfile.TemporaryDirectory() as tmp:
        _reset_local_gen(local_gen, model_path=os.path.join(tmp, "x.gguf"))
        original_load = local_gen._load_model_sync
        local_gen._load_model_sync = lambda: _BrokenModel()
        try:
            result = asyncio.run(local_gen.generate(
                [{"role": "user", "content": "질문"}], "", "시스템",
            ))
        finally:
            local_gen._load_model_sync = original_load
    _reset_local_gen(local_gen)
    assert result is None
    print("local_gen inference-exception-safe: PASS")


def _test_timeout_returns_none():
    import local_gen
    import time as _time

    def _slow_generate_sync(user_msg, context, system):
        _time.sleep(0.3)
        return "너무 늦게 온 답변"

    with tempfile.TemporaryDirectory() as tmp:
        _reset_local_gen(local_gen, model_path=os.path.join(tmp, "x.gguf"))
        original_timeout = local_gen.TIMEOUT_SECONDS
        original_fn = local_gen._generate_sync
        local_gen.TIMEOUT_SECONDS = 0.05
        local_gen._generate_sync = _slow_generate_sync
        try:
            result = asyncio.run(local_gen.generate(
                [{"role": "user", "content": "질문"}], "", "시스템",
            ))
        finally:
            local_gen.TIMEOUT_SECONDS = original_timeout
            local_gen._generate_sync = original_fn
    _reset_local_gen(local_gen)
    assert result is None
    print("local_gen timeout-safe: PASS")


def _test_llm_local_stream_prefers_local_gen_when_configured():
    """llm._local_stream()이 local_gen이 성공하면 그 결과를 쓰고, 실패/미설정이면
    기존 engine.local_stream()으로 그대로 이어가는지 확인."""
    import llm
    import local_gen
    import engine

    async def fake_engine_local_stream(messages, context, system_prompt):
        yield "[기존 추출 엔진 응답]"

    original_engine_local_stream = engine.local_stream
    engine.local_stream = fake_engine_local_stream
    try:
        # (a) local_gen 미설정 → 기존 추출 엔진 그대로
        _reset_local_gen(local_gen)

        async def _run_a():
            return [t async for t in llm._local_stream([{"role": "user", "content": "q"}], "", "sys")]
        out_a = asyncio.run(_run_a())
        assert out_a == ["[기존 추출 엔진 응답]"]

        # (b) local_gen이 설정되어 성공적으로 답을 만들면 그 결과 사용
        async def fake_generate(messages, context, system):
            return local_gen.MARKER + "생성된 답변"
        original_generate = local_gen.generate
        local_gen.generate = fake_generate
        local_gen.MODEL_PATH = "dummy.gguf"  # is_configured()만 True로 만들면 됨
        try:
            async def _run_b():
                return [t async for t in llm._local_stream([{"role": "user", "content": "q"}], "", "sys")]
            out_b = asyncio.run(_run_b())
            assert len(out_b) == 1
            assert "생성된 답변" in out_b[0]
        finally:
            local_gen.generate = original_generate
            _reset_local_gen(local_gen)

        # (c) local_gen이 설정은 됐지만 실패(None)하면 기존 추출 엔진으로 폴백
        async def fake_generate_fail(messages, context, system):
            return None
        local_gen.generate = fake_generate_fail
        local_gen.MODEL_PATH = "dummy.gguf"
        try:
            async def _run_c():
                return [t async for t in llm._local_stream([{"role": "user", "content": "q"}], "", "sys")]
            out_c = asyncio.run(_run_c())
            assert out_c == ["[기존 추출 엔진 응답]"]
        finally:
            local_gen.generate = original_generate
            _reset_local_gen(local_gen)
    finally:
        engine.local_stream = original_engine_local_stream

    print("llm._local_stream local_gen integration: PASS")


def _test_auto_learn_excludes_local_gen_marker():
    """local_gen.MARKER_TAG가 포함된 응답은 main.py의 auto_learn 후보에 쌓이지
    않아야 한다(검증되지 않은 실험적 생성물이 장기기억으로 들어가는 것 차단)."""
    app_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(app_dir)

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "local-gen-marker.db")
        os.environ["MPLCONFIGDIR"] = os.path.join(tmp, "matplotlib")
        os.environ["BACKUP_TOKEN"] = "test-owner-token"
        os.environ.pop("ANTHROPIC_API_KEY", None)
        os.environ.pop("GROQ_API_KEY", None)

        from fastapi.testclient import TestClient
        from fastapi import APIRouter

        stock_api_stub = types.ModuleType("stock_analysis.stock_api")
        stock_api_stub.router = APIRouter()
        sys.modules["stock_analysis.stock_api"] = stock_api_stub
        import main
        import local_gen

        client = TestClient(main.app)
        headers = {"X-Admin-Token": "test-owner-token"}

        async def no_intent(*_a, **_kw):
            return {"ok": False, "intent": "", "refined_query": "", "keywords": [], "answer_guide": ""}

        async def fake_local_gen_reply(*_a, **_kw):
            yield local_gen.MARKER + "실험적으로 생성된 미검증 답변입니다."

        original_intent = main.intent_agent.analyze
        original_chat_stream = main.llm.chat_stream
        main.intent_agent.analyze = no_intent
        main.llm.chat_stream = fake_local_gen_reply
        try:
            resp = client.post(
                "/chat", headers=headers,
                json={"message": "로컬생성마커테스트질문", "persona": "hr",
                      "thinking_mode": "off", "session_id": "local-gen-marker"},
            )
            assert resp.status_code == 200
            assert local_gen.MARKER_TAG in resp.text

            with main.mem._conn() as c:
                pending = c.execute(
                    "SELECT COUNT(*) FROM memory_candidates WHERE status='pending'"
                ).fetchone()[0]
            assert pending == 0, "실험적 로컬 생성 응답이 학습 후보로 저장되면 안 됨"
        finally:
            main.intent_agent.analyze = original_intent
            main.llm.chat_stream = original_chat_stream

    print("auto_learn excludes local_gen marker: PASS")


def main_():
    _test_disabled_by_default()
    _test_configured_but_model_missing()
    _test_empty_user_message_no_load_attempt()
    _test_successful_generation_has_marker()
    _test_inference_exception_returns_none()
    _test_timeout_returns_none()
    _test_llm_local_stream_prefers_local_gen_when_configured()
    _test_auto_learn_excludes_local_gen_marker()


if __name__ == "__main__":
    main_()
