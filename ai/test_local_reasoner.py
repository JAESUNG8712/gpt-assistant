"""API 키 없는 로컬 추론·코딩 경로 회귀 테스트."""
import asyncio
import os
import sys
from datetime import date

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
    assert build_reasoning_plan("현재 기준은 뭐야?").intent == "latest"
    composite_plan = build_reasoning_plan("2027년 최저임금 금액과 적용일을 알려줘")
    assert composite_plan.aspects == ("amount", "date")

    conflict_context = (
        "2027년 최저임금은 시간당 10,700원입니다.\n\n"
        "2027년 최저임금은 시간당 11,000원입니다."
    )
    conflict_plan, conflict_evidence = _rank_evidence("2027년 최저임금은 얼마", conflict_context)
    conflict_review = review_reasoning(conflict_plan, conflict_evidence)
    assert conflict_review.conflicts
    conflict_answer = grounded_response("2027년 최저임금은 얼마", conflict_context, "deep")
    assert "판단 보류" in conflict_answer and "10,700원" in conflict_answer and "11,000원" in conflict_answer

    # 서로 다른 연도의 값은 충돌이 아니다. 특정 연도 및 현재 질문은 맞는 연도만 선택한다.
    current_year = date.today().year
    next_year = current_year + 1
    yearly_context = (
        f"{current_year}년 최저임금은 시간당 10,320원입니다.\n\n"
        f"{next_year}년 최저임금은 시간당 10,700원입니다."
    )
    yearly_answer = grounded_response(f"{next_year}년 최저임금은 얼마", yearly_context, "deep")
    assert "판단 보류" not in yearly_answer and "10,700원" in yearly_answer
    assert "10,320원" not in yearly_answer
    latest_answer = grounded_response("현재 최저임금은 얼마", yearly_context, "deep")
    assert "10,320원" in latest_answer and "10,700원" not in latest_answer

    procedure = grounded_response(
        "휴가 신청 절차 알려줘",
        "3. 승인 결과를 확인합니다.\n\n1. 신청서를 작성합니다.\n\n2. 팀장에게 제출합니다.",
        "deep",
    )
    assert procedure.index("1. 신청서를") < procedure.index("2. 팀장에게") < procedure.index("3. 승인 결과")
    comparison = grounded_response(
        "A와 B 차이 비교해줘",
        "A는 속도가 빠르고 비용이 높습니다.\n\nB는 속도가 느리고 비용이 낮습니다.",
    )
    assert "**비교 결과**" in comparison and "A는" in comparison and "B는" in comparison
    table_answer = grounded_response(
        "근속 기간별 연차 일수",
        "| 근속 기간 | 연차 일수 |\n|---|---|\n| 1년 | 15일 |\n| 3년 | 16일 |",
    )
    assert "| 근속 기간 | 연차 일수 |" in table_answer and "| 3년 | 16일 |" in table_answer
    composite_answer = grounded_response(
        "2027년 최저임금 금액과 적용일을 알려줘",
        "[공식 고시] 2027년 최저임금은 시간당 10,700원이며 2027년 1월 1일부터 적용됩니다.",
        "deep",
    )
    assert "요구사항 2개 분해" in composite_answer
    assert "요청별 판단 근거" in composite_answer
    assert "10,700원" in composite_answer and "1월 1일부터" in composite_answer
    assert "확인 필요" not in composite_answer

    # 동일한 내용이면 공식 근거가 일반 문서보다 먼저 선택된다.
    source_plan, source_evidence = _rank_evidence(
        "연차 신청 절차",
        "[검색결과 1 | 일반 | 출처: blog.example]\n내용: 연차 신청서를 제출합니다.\n\n"
        "[검색결과 2 | 공식 | 출처: moel.go.kr]\n내용: 연차 신청서를 제출합니다.",
    )
    source_review = review_reasoning(source_plan, source_evidence)
    assert source_evidence[0].source_label == "moel.go.kr"
    assert source_review.official_count >= 1
    sourced_answer = grounded_response(
        "연차 신청 절차",
        "[검색결과 1 | 공식 | 출처: moel.go.kr]\n내용: 연차 신청서를 제출합니다.",
    )
    assert "출처: moel.go.kr" in sourced_answer
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
    crud_code = code_response("FastAPI CRUD 할일 API 만들어줘")
    assert '@app.post("/todos"' in crud_code and '@app.delete("/todos/{item_id}"' in crud_code
    todo_app = code_response("할 일 웹 앱 만들어줘")
    assert "localStorage" in todo_app and "crypto.randomUUID" in todo_app
    project = code_response("FastAPI 할 일 API를 테스트 포함 프로젝트로 만들어줘", "deep")
    assert "app/main.py" in project and "tests/test_api.py" in project
    assert "pytest -q" in project and "하드코딩 비밀정보" in project

    assert local_answer_fit("2027년 최저임금", "2027년 최저임금", "시간당 10,700원")
    assert not local_answer_fit("2027년 최저임금", "2026년 최저임금", "시간당 10,320원")

    keys = [
        "ANTHROPIC_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENROUTER_API_KEY",
        "GROQ_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "COHERE_API_KEY",
    ]
    old = {name: getattr(llm, name) for name in keys}
    old_provider = llm.LLM_PROVIDER
    old_ollama = llm.OLLAMA_MODEL
    try:
        for name in keys:
            setattr(llm, name, "")
        llm.LLM_PROVIDER = "auto"
        llm.OLLAMA_MODEL = ""
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
        llm.OLLAMA_MODEL = old_ollama

    print("local reasoner tests: PASS")


if __name__ == "__main__":
    main_()
