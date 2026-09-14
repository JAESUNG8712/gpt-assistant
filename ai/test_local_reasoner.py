"""API 키 없는 로컬 추론·코딩 경로 회귀 테스트."""
import asyncio
import os
import sys

AI_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI_DIR)


def _collect(stream):
    async def run():
        return "".join([chunk async for chunk in stream])
    return asyncio.run(run())


def main_():
    import llm
    from local_reasoner import (
        LOCAL_REASONING_MARKER, build_reasoning_plan, code_response, grounded_response,
        local_answer_fit, resolve_context_query, review_reasoning, select_evidence,
        _rank_evidence,
    )

    context = (
        "[주의: 아래 자료만 사용하세요.]\n\n"
        "[공식 법령] 2027년 최저임금은 시간당 10,700원이며 2027년 1월 1일부터 적용됩니다.\n\n"
        "여행 참고: 제주도 봄철 유채꽃이 유명합니다."
    )
    evidence = select_evidence("2027년 최저임금 적용일", context)
    assert evidence and "10,700원" in evidence[0]
    assert all("제주도" not in item for item in evidence)
    short_title = select_evidence("여행앱", "해외여행 필수 앱\n\n무관한 긴 설명입니다.")
    assert short_title and "해외여행 필수 앱" in short_title[0]
    assert build_reasoning_plan("왜 이 제도가 필요한가?").intent == "cause"
    assert build_reasoning_plan("신청 절차가 어떻게 돼?").intent == "procedure"

    conflict_context = (
        "2027년 최저임금은 시간당 10,700원입니다.\n\n"
        "2027년 최저임금은 시간당 11,000원입니다."
    )
    conflict_plan, conflict_evidence = _rank_evidence("2027년 최저임금은 얼마", conflict_context)
    conflict_review = review_reasoning(conflict_plan, conflict_evidence)
    assert conflict_review.conflicts
    conflict_answer = grounded_response("2027년 최저임금은 얼마", conflict_context, "deep")
    assert "판단 보류" in conflict_answer and "10,700원" in conflict_answer and "11,000원" in conflict_answer
    assert resolve_context_query(
        "1번", "[주의: 사용자 질문 'FastAPI TestClient 사용법'과 직접 관련된 내용만 사용하세요.]",
    ) == "FastAPI TestClient 사용법"

    answer = grounded_response("2027년 최저임금 적용일", context, "deep")
    assert LOCAL_REASONING_MARKER in answer
    assert "<think>" in answer and "10,700원" in answer
    assert "아래 자료만 사용하세요" not in answer

    py_code = code_response("파이썬으로 리스트 중복 제거 함수 짜줘", "prompt")
    assert "def unique_items" in py_code and "assert" in py_code
    html_code = code_response("HTML 웹페이지 만들어줘")
    assert "<!doctype html>" in html_code and "addEventListener" in html_code

    assert local_answer_fit("2027년 최저임금", "2027년 최저임금", "시간당 10,700원")
    assert not local_answer_fit("2027년 최저임금", "2026년 최저임금", "시간당 10,320원")

    keys = [
        "ANTHROPIC_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENROUTER_API_KEY",
        "GROQ_API_KEY", "GEMINI_API_KEY",
    ]
    old = {name: getattr(llm, name) for name in keys}
    old_provider = llm.LLM_PROVIDER
    try:
        for name in keys:
            setattr(llm, name, "")
        llm.LLM_PROVIDER = "auto"
        assert llm.is_offline_mode()
        output = _collect(llm.chat_stream(
            [{"role": "user", "content": "파이썬으로 리스트 정렬 함수 작성해줘"}],
            thinking_mode="deep",
        ))
        assert "def sort_items" in output and "<think>" in output
        assert "일시적인" not in output
    finally:
        for name, value in old.items():
            setattr(llm, name, value)
        llm.LLM_PROVIDER = old_provider

    print("local reasoner tests: PASS")


if __name__ == "__main__":
    main_()
