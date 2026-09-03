"""최저임금 확정값 직접 응답과 웹검색 관련성 필터 회귀 테스트."""

import calculator
import search


class _FakeDDGS:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def text(self, _query, max_results=10):
        return [
            {
                "title": "JobKoreaUSA 채용 정보",
                "body": "미국 취업과 구직 정보",
                "href": "https://jobkoreausa.com/jobs",
            },
            {
                "title": "연도별 최저임금 결정현황",
                "body": "2027년 최저임금 시간급 10,700원 월 환산액 2,236,300원",
                "href": "https://www.minimumwage.go.kr/minWage/policy/decisionMain.do",
            },
            {
                "title": "최저임금 정리 블로그",
                "body": "2027년 최저임금은 10,700원입니다.",
                "href": "https://example.com/minimum-wage",
            },
            {
                "title": "Korean phrases",
                "body": "What malda means in Korean",
                "href": "https://example.net/korean-phrases",
            },
        ][:max_results]


def main():
    answer = calculator.try_any_calc("27년 최저임금 알려줘")
    assert answer is not None
    assert "2027년 최저임금" in answer
    assert "10,700원" in answer
    assert "2,236,300원" in answer
    assert "2026년 8월 5일" in answer
    assert "이미 결정·고시" in answer
    assert "minimumwage.go.kr" in answer
    assert "발표되지 않았" not in answer

    full_year = calculator.try_any_calc("2027년 최저시급과 월급은 얼마인가요?")
    assert full_year is not None and "85,600원" in full_year

    violation = calculator.try_any_calc("2027년 시급 10,500원 최저임금 위반인가요?")
    assert violation is not None
    assert "❌ **위반**" in violation and "10,700원" in violation

    unknown = calculator.try_any_calc("2028년 최저임금 알려줘")
    assert unknown is not None
    assert "검증된 공식 데이터에 없습니다" in unknown
    assert "10,700원" not in unknown

    original_ddgs = search.DDGS
    search.DDGS = _FakeDDGS
    try:
        results = search.web_search("27년 최저임금 알려줘", max_results=5)
    finally:
        search.DDGS = original_ddgs

    assert len(results) == 2
    assert results[0]["url"].startswith("https://www.minimumwage.go.kr/")
    assert all("JobKoreaUSA" not in result["title"] for result in results)
    assert all("Korean phrases" not in result["title"] for result in results)

    print("minimum wage facts tests: PASS")


if __name__ == "__main__":
    main()
