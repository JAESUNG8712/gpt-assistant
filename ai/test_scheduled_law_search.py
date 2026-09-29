"""연도별 시행예정법령 검색과 개정문 추출 회귀 테스트."""
import asyncio
import os
import sys

AI_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI_DIR)

import law_search as law
import local_reasoner
import search


class _FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


class _FakeClient:
    calls = []

    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def get(self, url, params):
        self.calls.append((url, dict(params)))
        if url.endswith("lawSearch.do"):
            return _FakeResponse({
                "LawSearch": {"law": [
                    {
                        "현행연혁코드": "시행예정", "법령일련번호": "285279",
                        "법령명한글": "근로기준법", "시행일자": "20270101",
                        "공포일자": "20260407", "공포번호": "21533",
                        "제개정구분명": "일부개정",
                    },
                    {
                        "현행연혁코드": "시행예정", "법령일련번호": "299999",
                        "법령명한글": "근로기준법", "시행일자": "20280101",
                        "공포일자": "20270407", "공포번호": "29999",
                        "제개정구분명": "일부개정",
                    },
                ]}
            })
        return _FakeResponse({
            "법령": {
                "기본정보": {"시행일자": "20270101", "공포일자": "20260407"},
                "개정문": {"개정문내용": [[
                    "근로기준법 일부를 다음과 같이 개정한다.",
                    "제44조의4를 다음과 같이 신설한다.",
                    "제44조의4(도급 사업에서 임금비용의 구분지급) 도급인은 임금비용을 구분하여 지급하여야 한다.",
                    "제1조(시행일) 제44조의4의 개정규정은 2027년 1월 1일부터 시행한다.",
                    "제2조(적용례) 시행 이후 체결하는 도급계약부터 적용한다.",
                ]]},
            }
        })


def _test_scheduled_api_route():
    old_key = law.LAW_API_KEY
    old_client = law.httpx.AsyncClient
    try:
        law.LAW_API_KEY = "test-key"
        law.httpx.AsyncClient = _FakeClient
        _FakeClient.calls = []
        results = asyncio.run(law.search_law_api(
            "27년에 적용되거나 변경되는 근로기준법 내용 확인해줘"
        ))
    finally:
        law.LAW_API_KEY = old_key
        law.httpx.AsyncClient = old_client

    assert len(results) == 1
    assert results[0]["scheduled"] is True
    assert "2027년 1월 1일 시행 예정" in results[0]["body"]
    assert "제44조의4" in results[0]["body"]
    assert "임금비용을 구분하여 지급" in results[0]["body"]
    assert all(call[1]["target"] == "eflaw" for call in _FakeClient.calls)
    assert _FakeClient.calls[0][1]["nw"] == 2


def _test_short_year_and_irrelevant_headings():
    query = "27년에 적용되거나 변경되는 근로기준법 내용 확인해줘"
    assert law._requested_years(query) == ["2027"]
    assert law._is_scheduled_change_query(query)
    planned = local_reasoner.build_reasoning_plan(query)
    assert "2027년" in planned.constraints

    context = (
        "[근로기준법 제1조 목적]\n근로조건의 기준을 정한다.\n"
        "출처: https://www.law.go.kr/법령/근로기준법\n\n"
        "[근로기준법 2027년 1월 1일 시행 예정]\n"
        "2027년 시행 개정 내용: 제44조의4를 다음과 같이 신설한다.\n"
        "출처: https://www.law.go.kr/법령/근로기준법"
    )
    evidence = local_reasoner.select_evidence(query, context)
    assert evidence and any("제44조의4" in item for item in evidence)
    assert all("제1조 목적" not in item for item in evidence)

    irrelevant_only = local_reasoner.grounded_response(
        query,
        "[근로기준법 제1조 목적]\n근로조건의 기준을 정한다.\n"
        "출처: https://www.law.go.kr/법령/근로기준법",
    )
    assert "직접 연결되는 근거를 찾지 못했습니다" in irrelevant_only


def _test_search_query_planning():
    query = "27년에 적용되거나 변경되는 근로기준법 내용 확인해줘"
    requirements = search.analyze_query_requirements(query)
    assert requirements["years"] == ["2027"]
    assert {"date", "comparison"}.issubset(requirements["aspects"])
    planned = search.build_search_queries(query)
    assert planned[0].startswith("2027년")
    assert any("개정 변경 사항" in item for item in planned)


def main_():
    _test_scheduled_api_route()
    _test_short_year_and_irrelevant_headings()
    _test_search_query_planning()
    print("scheduled law search tests: PASS")


if __name__ == "__main__":
    main_()
