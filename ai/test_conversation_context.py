"""후속 질문 맥락 복원과 코딩 자동 분류 회귀 테스트."""
import asyncio

import intent_agent
import llm
from personas import classify_personas


def main():
    history = [
        {"role": "user", "content": "Python으로 CSV 파일을 읽어 날짜순으로 정렬해줘"},
        {"role": "assistant", "content": "pandas를 이용한 예시를 제공했습니다."},
    ]

    resolved = intent_agent.resolve_followup_query("그 코드를 함수로 바꿔줘", history)
    assert "Python으로 CSV" in resolved
    assert "함수로 바꿔줘" in resolved
    assert intent_agent.resolve_followup_query("제주도 3박 4일 일정", history) == "제주도 3박 4일 일정"
    chained = intent_agent.resolve_followup_query(
        "그럼 예외는?",
        history + [{"role": "user", "content": "그 코드를 함수로 바꿔줘"}],
    )
    assert "Python으로 CSV" in chained and "예외" in chained
    assert classify_personas(resolved)[0] == "dev"
    assert classify_personas("간단한 HTML 웹페이지 만들어줘")[0] == "dev"

    original_llm_once = intent_agent._llm_once
    original_enabled = intent_agent.INTENT_ENABLED
    prompts = []

    async def context_result(prompt, system=intent_agent._SYSTEM):
        prompts.append(prompt)
        return (
            '{"intent":"기존 CSV 정렬 코드를 함수화",'
            '"refined_query":"Python CSV 날짜 정렬 함수 구현",'
            '"keywords":["Python","CSV","함수"],'
            '"answer_guide":"실행 가능한 함수와 예외 처리 제공","uses_context":true}'
        )

    async def broken(*_args, **_kwargs):
        raise RuntimeError("모의 제공자 장애")

    async def independent_result(prompt, system=intent_agent._SYSTEM):
        return (
            '{"intent":"새 제주 여행 질문","refined_query":"제주도 여행 일정",'
            '"keywords":["제주도"],"answer_guide":"일정 제안","uses_context":false}'
        )

    original_has_provider = llm.has_llm_provider
    try:
        intent_agent.INTENT_ENABLED = True
        # 아래 세 시나리오는 "LLM이 있고 이렇게 응답(또는 실패)한다"를 검증하려는
        # 것이므로, 실행 환경의 실제 키 유무와 무관하게 LLM 경로를 타도록 고정한다
        # (그렇지 않으면 LLM 자체가 없다고 판단해 이 모킹을 호출하지 않고 곧장
        # 결정형 폴백으로 반환할 수 있음).
        llm.has_llm_provider = lambda: True
        intent_agent._llm_once = context_result
        info = asyncio.run(intent_agent.analyze("그 코드를 함수로 바꿔줘", "dev", history))
        assert info["ok"] and info["uses_context"]
        assert info["refined_query"] == "Python CSV 날짜 정렬 함수 구현"
        assert "최근 대화" in prompts[0] and "현재 질문" in prompts[0]

        # 접속 표현이 있어도 모델이 새 주제로 판정하면 과거 주제를 억지로 섞지 않는다.
        intent_agent._llm_once = independent_result
        independent = asyncio.run(intent_agent.analyze("그럼 제주도 여행은?", "travel", history))
        assert not independent["uses_context"]
        assert independent["refined_query"] == "제주도 여행 일정"

        # LLM이 실패해도 단어 유사도 검색으로 되돌아가지 않고 직전 사용자 주제를 보존한다.
        intent_agent._llm_once = broken
        fallback = asyncio.run(intent_agent.analyze("그건 왜?", "dev", history))
        assert fallback["ok"] and fallback["uses_context"]
        assert "Python으로 CSV" in fallback["refined_query"]

        # 환경변수로 의도 LLM을 꺼도 결정적 맥락 폴백은 계속 동작한다.
        intent_agent.INTENT_ENABLED = False
        disabled = asyncio.run(intent_agent.analyze("이어서 설명해줘", "dev", history))
        assert disabled["ok"] and disabled["uses_context"]
    finally:
        intent_agent._llm_once = original_llm_once
        intent_agent.INTENT_ENABLED = original_enabled
        llm.has_llm_provider = original_has_provider

    print("conversation context tests: PASS")


if __name__ == "__main__":
    main()
