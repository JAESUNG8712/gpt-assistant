"""짧은 KB 질의 모호성 판정 회귀 테스트."""

import os
import sys

AI_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI_DIR)

from engine import get_engine
from search_ambiguity import ambiguity_candidates, format_clarification, resolve_selection


def _results(query, persona):
    return [
        (question, answer, score)
        for question, answer, score, _meta in get_engine().search(
            query, n=6, persona=persona, min_score=0.0
        )
    ]


def main():
    api = ambiguity_candidates("API 테스트", _results("API 테스트", "dev"))
    assert len(api) >= 2
    assert "FastAPI TestClient" in api[0]["title"]
    assert "1. **" in format_clarification(api)
    history = [{
        "role": "user",
        "content": "API 테스트",
        "command_status": {"clarification_options": api},
    }, {
        "role": "assistant",
        "content": format_clarification(api),
    }]
    assert resolve_selection("1번", history)["question"] == api[0]["question"]
    assert resolve_selection("2번째", history)["question"] == api[1]["question"]
    assert not resolve_selection("5번", history)
    assert not resolve_selection("1번", [{"role": "user", "content": "다른 질문"}])

    travel = ambiguity_candidates("여행 코스 추천", _results("여행 코스 추천", "travel"))
    assert len(travel) >= 2
    assert any("부산" in item["title"] for item in travel)
    assert any("제주" in item["title"] for item in travel)

    resume = ambiguity_candidates("이력서", _results("이력서", "resume"))
    assert len(resume) >= 2

    # 구체 질의나 1위가 뚜렷한 질의는 기존처럼 즉답한다.
    assert not ambiguity_candidates("여행앱", _results("여행앱", "travel"))
    minimum_wage = "최저임금법 어기면 처벌받나요"
    assert not ambiguity_candidates(minimum_wage, _results(minimum_wage, "hr"))
    assert not ambiguity_candidates(
        "FastAPI TestClient로 통합 테스트 작성 방법",
        _results("FastAPI TestClient로 통합 테스트 작성 방법", "dev"),
    )

    # 제목만 조금 다른 사실상 같은 답 두 개는 선택지로 부풀리지 않는다.
    duplicate_results = [
        ("q1", "## 부당해고 주요 판례", 0.9),
        ("q2", "## 부당해고 주요 판례 및 기준", 0.85),
    ]
    assert not ambiguity_candidates("부당해고", duplicate_results)
    print("search ambiguity tests: PASS")


if __name__ == "__main__":
    main()
