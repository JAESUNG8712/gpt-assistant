"""질문 난이도 기반 자동 검토 수준 선택 회귀 테스트."""
import asyncio

import deliberation


def main():
    simple = deliberation.choose_mode("안녕", "auto")
    assert simple["mode"] == "prompt" and simple["automatic"] is True
    assert "기본 자체 검토" in simple["reason"]

    factual = deliberation.choose_mode("2027년 최저임금 얼마야?", "auto")
    assert factual["mode"] == "prompt"

    comparison = deliberation.choose_mode("두 구현 방식의 장단점을 비교해줘", "auto")
    assert comparison["mode"] == "prompt"
    assert "분석·의사결정" in comparison["reason"]

    complex_request = deliberation.choose_mode(
        "실서비스 장애의 원인을 분석하고 복구 전략과 재발 방지 대안을 각각 비교해줘",
        "auto",
    )
    assert complex_request["mode"] == "deep"

    high_stakes = deliberation.choose_mode("해고 통보를 받았는데 법적 대응을 알려줘", "auto")
    assert high_stakes["mode"] == "deep" and "중요 판단" in high_stakes["reason"]

    specialist = deliberation.choose_mode(
        "오늘 시장 상황 알려줘", "auto", persona="stock",
        persona_prefers_thinking=True,
    )
    assert specialist["mode"] == "prompt"

    explicit_fast = deliberation.choose_mode("복잡한 분석", "off")
    assert explicit_fast == {
        "mode": "off", "automatic": False, "score": 0, "reason": "사용자 직접 선택",
    }
    shared = deliberation.choose_mode("투자 전략과 손절 기준을 분석해줘", "deep", is_shared=True)
    assert shared["mode"] == "prompt" and shared["automatic"] is False

    company = deliberation.choose_mode("규정을 깊게 분석해줘", "deep", persona="company")
    assert company["mode"] == "off" and company["reason"] == "사내 문서 직접 답변"

    direct = deliberation.direct_response_decision()
    assert direct["mode"] == "off" and "자체 검증" in direct["reason"]

    ambiguous = deliberation.ambiguity_response_decision()
    assert ambiguous["mode"] == "off" and "모호성" in ambiguous["reason"]

    specialist_check = deliberation.specialist_response_decision()
    assert specialist_check["mode"] == "off" and "전문 분석" in specialist_check["reason"]

    # 코딩 전용 경로에서도 thinking_mode가 더 이상 유실되지 않는다.
    import llm
    original_chat_stream = llm.chat_stream
    calls = []

    async def fake_chat_stream(messages, context="", system_prompt=None, thinking_mode="off"):
        calls.append(thinking_mode)
        yield "검토된 개발 답변"

    async def run_coding():
        parts = []
        async for token in llm.chat_stream_coding(
            [{"role": "user", "content": "장애 원인 분석"}],
            thinking_mode="deep",
        ):
            parts.append(token)
        return "".join(parts)

    llm.chat_stream = fake_chat_stream
    try:
        assert asyncio.run(run_coding()) == "검토된 개발 답변"
    finally:
        llm.chat_stream = original_chat_stream
    assert calls == ["deep"]

    print("deliberation tests: PASS")


if __name__ == "__main__":
    main()
