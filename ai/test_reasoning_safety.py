"""2단계 추론이 내부 분석을 노출하지 않고 최종 검증에만 쓰는지 검증."""
import asyncio


async def _collect(generator):
    parts = []
    async for token in generator:
        parts.append(token)
    return "".join(parts)


async def run_tests():
    import llm
    from engine import LOCAL_FALLBACK_MARKER

    original = llm.chat_stream
    calls = []

    async def fake_chat_stream(messages, context="", system_prompt=None, thinking_mode="off"):
        calls.append({"context": context, "system": system_prompt, "mode": thinking_mode})
        if system_prompt == llm.DEEP_ANALYSIS_PROMPT:
            yield "내부 전용 상세 분석: 공개되면 안 되는 작업 메모"
        else:
            yield "근거를 재검증한 최종 답변"

    try:
        llm.chat_stream = fake_chat_stream
        output = await _collect(llm._deep_thinking_chat(
            [{"role": "user", "content": "질문"}], "검증된 참고 자료", "최종 시스템"
        ))
        assert "내부 전용 상세 분석" not in output
        assert "내부 검토했습니다" in output
        assert "근거를 재검증한 최종 답변" in output
        assert len(calls) == 2
        assert "내부 전용 상세 분석" in calls[1]["context"]
        assert "초안의 결론을 그대로 믿지 말고" in calls[1]["context"]
        assert "[참고 자료]\n검증된 참고 자료" in calls[1]["context"]

        calls.clear()

        async def fallback_first(messages, context="", system_prompt=None, thinking_mode="off"):
            calls.append({"context": context, "system": system_prompt})
            if system_prompt == llm.DEEP_ANALYSIS_PROMPT:
                yield LOCAL_FALLBACK_MARKER + " 원문 덤프"
            else:
                yield "최종 폴백 답변"

        llm.chat_stream = fallback_first
        output = await _collect(llm._deep_thinking_chat(
            [{"role": "user", "content": "질문"}], "참고", "최종 시스템"
        ))
        assert LOCAL_FALLBACK_MARKER not in output
        assert LOCAL_FALLBACK_MARKER not in calls[1]["context"]
    finally:
        llm.chat_stream = original

    print("reasoning safety tests: PASS")


if __name__ == "__main__":
    asyncio.run(run_tests())
