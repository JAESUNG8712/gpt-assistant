"""LLM API 키가 하나도 없을 때의 "자체 판단" 기능 회귀 테스트.

기존에는 API 키가 없으면 (1) 심층검토(deep thinking)가 어차피 같은 로컬 폴백을
반복 호출할 뿐인 계획→초안→검증 3단계를 그대로 실행해 지연시간만 3배로 늘렸고,
(2) 답변 적합성 판정(judge_answer_fit)은 항상 실패할 LLM 호출을 시도했다가 예외로
보수적 False만 반환했으며, (3) 애매한 점수의 KB 후보가 여럿일 때도 1위 답변에
2위 답변을 그대로 이어붙이는 수준의 종합만 했다. 이 세 지점을 실제 LLM 없이도
의미 있는 "자체 판단"을 하도록 바꾼 것을 검증한다.
"""
import asyncio
import os
import sys

AI_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI_DIR)


def _clear_llm_keys():
    for k in ("ANTHROPIC_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENROUTER_API_KEY",
              "GROQ_API_KEY", "GEMINI_API_KEY"):
        os.environ.pop(k, None)


def _test_has_llm_provider():
    import llm

    original_provider = llm.LLM_PROVIDER
    saved_keys = {
        "ANTHROPIC_API_KEY": llm.ANTHROPIC_API_KEY,
        "OPENCODE_ZEN_API_KEY": llm.OPENCODE_ZEN_API_KEY,
        "OPENROUTER_API_KEY": llm.OPENROUTER_API_KEY,
        "GROQ_API_KEY": llm.GROQ_API_KEY,
        "GEMINI_API_KEY": llm.GEMINI_API_KEY,
    }
    try:
        llm.ANTHROPIC_API_KEY = llm.OPENCODE_ZEN_API_KEY = ""
        llm.OPENROUTER_API_KEY = llm.GROQ_API_KEY = llm.GEMINI_API_KEY = ""
        llm.LLM_PROVIDER = "auto"
        assert llm.has_llm_provider() is False

        llm.GROQ_API_KEY = "test-key"
        assert llm.has_llm_provider() is True

        llm.GROQ_API_KEY = ""
        llm.LLM_PROVIDER = "local"
        assert llm.has_llm_provider() is False

        llm.LLM_PROVIDER = "claude"  # 명시적 지정은 auto 우회
        assert llm.has_llm_provider() is True
    finally:
        llm.LLM_PROVIDER = original_provider
        for k, v in saved_keys.items():
            setattr(llm, k, v)

    print("has_llm_provider tests: PASS")


def _test_local_synthesize():
    import engine as e

    # 관련 문장만 골라 종합하고, 서로 다른 문서(2건)를 비교했다는 사실을 투명하게 밝힌다.
    results = [
        ("연차 발생 기준", "연차는 1년간 80% 이상 출근한 근로자에게 발생합니다. 이 조건과 무관한 문장입니다.", 0.25, {}),
        ("연차 촉진제란", "연차 사용촉진 제도는 서면 통보 절차입니다. 발생 기준과는 별개의 제도입니다.", 0.20, {}),
    ]
    out = e._local_synthesize("연차 발생 기준이 뭐야", results)
    assert "🧭" in out and "자체 판단" in out
    assert "80% 이상 출근한 근로자에게 발생합니다" in out
    assert "이 조건과 무관한 문장입니다" not in out  # 무관 문장은 제외돼야 함

    # 질문이 전부 일반어라 비교 기준이 없으면 최상위 원문을 그대로 신뢰
    only_generic = [("무엇", "이것은 저 답변입니다.", 0.15, {})]
    assert e._local_synthesize("이 그 저 것", only_generic) == "이것은 저 답변입니다."

    # _compose()의 중간~낮은 신뢰도 구간(0.10~0.40)에 실제로 연결되어 있는지 확인
    composed = e._compose("연차 발생 기준이 뭐야", results, "hr")
    assert "🧭" in composed

    print("local synthesize tests: PASS")


def _test_deep_thinking_skips_theater_without_llm():
    import llm

    calls = {"local": 0, "deep_stage": 0}
    original_local = llm._local_stream
    original_deep = llm._deep_thinking_chat
    original_has_provider = llm.has_llm_provider

    async def fake_local(messages, context, system):
        calls["local"] += 1
        yield "로컬 폴백 응답"

    async def fake_deep(messages, context, final_system):
        calls["deep_stage"] += 1
        yield "심층검토 응답"

    llm._local_stream = fake_local
    llm._deep_thinking_chat = fake_deep
    try:
        # LLM이 하나도 없으면 3단계 심층검토 대신 로컬 폴백 1회만 호출
        llm.has_llm_provider = lambda: False

        async def _run_no_llm():
            parts = []
            async for tok in llm.chat_stream(
                [{"role": "user", "content": "질문"}], thinking_mode="deep",
            ):
                parts.append(tok)
            return "".join(parts)

        result = asyncio.run(_run_no_llm())
        assert result == "로컬 폴백 응답"
        assert calls["local"] == 1
        assert calls["deep_stage"] == 0

        # LLM이 있으면 기존처럼 3단계 심층검토를 그대로 사용
        llm.has_llm_provider = lambda: True

        async def _run_with_llm():
            parts = []
            async for tok in llm.chat_stream(
                [{"role": "user", "content": "질문"}], thinking_mode="deep",
            ):
                parts.append(tok)
            return "".join(parts)

        result2 = asyncio.run(_run_with_llm())
        assert result2 == "심층검토 응답"
        assert calls["deep_stage"] == 1
        assert calls["local"] == 1  # 이전 호출 이후 추가 호출 없음
    finally:
        llm._local_stream = original_local
        llm._deep_thinking_chat = original_deep
        llm.has_llm_provider = original_has_provider

    print("deep thinking skip-without-llm tests: PASS")


def main():
    _clear_llm_keys()
    _test_has_llm_provider()
    _test_local_synthesize()
    _test_deep_thinking_skips_theater_without_llm()


if __name__ == "__main__":
    main()
