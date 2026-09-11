"""계획·초안·독립검증 엔진이 내부 작업물을 노출하지 않는지 검증."""
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
        elif llm.DEEP_DRAFT_ADDITION in system_prompt:
            yield "내부 전용 미검증 답변 초안"
        else:
            yield "근거를 재검증한 최종 답변"

    try:
        llm.chat_stream = fake_chat_stream
        output = await _collect(llm._deep_thinking_chat(
            [{"role": "user", "content": "질문"}], "검증된 참고 자료", "최종 시스템"
        ))
        assert "내부 전용 상세 분석" not in output
        assert "내부 전용 미검증 답변 초안" not in output
        assert "독립적으로 다시 검토했습니다" in output
        assert "근거를 재검증한 최종 답변" in output
        assert len(calls) == 3
        assert "내부 전용 상세 분석" in calls[1]["context"]
        assert "[확인용 참고 자료]\n검증된 참고 자료" in calls[1]["context"]
        assert "내부 전용 상세 분석" in calls[2]["context"]
        assert "내부 전용 미검증 답변 초안" in calls[2]["context"]
        assert "[확인용 참고 자료]\n검증된 참고 자료" in calls[2]["context"]
        assert llm.DEEP_REVIEW_ADDITION in calls[2]["system"]
        assert calls[2]["system"].startswith("최종 시스템")
        assert all(call["mode"] == "off" for call in calls)

        calls.clear()

        async def fallback_first(messages, context="", system_prompt=None, thinking_mode="off"):
            calls.append({"context": context, "system": system_prompt})
            if system_prompt == llm.DEEP_ANALYSIS_PROMPT:
                yield LOCAL_FALLBACK_MARKER + " 원문 덤프"
            elif llm.DEEP_DRAFT_ADDITION in system_prompt:
                yield "⚠️ 일시적인 연결 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
            else:
                yield "최종 폴백 답변"

        llm.chat_stream = fallback_first
        output = await _collect(llm._deep_thinking_chat(
            [{"role": "user", "content": "질문"}], "참고", "최종 시스템"
        ))
        assert LOCAL_FALLBACK_MARKER not in output
        assert len(calls) == 3
        assert LOCAL_FALLBACK_MARKER not in calls[1]["context"]
        assert LOCAL_FALLBACK_MARKER not in calls[2]["context"]
        assert "일시적인 연결 오류" not in calls[2]["context"]
    finally:
        llm.chat_stream = original

    print("reasoning safety tests: PASS")


if __name__ == "__main__":
    asyncio.run(run_tests())
