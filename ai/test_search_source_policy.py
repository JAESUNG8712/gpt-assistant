"""주제별 공식 출처·최신성·교차검증 검색 정책 회귀 테스트."""

import search


def _result(title, body, url):
    return {"title": title, "body": body, "href": url}


def main():
    labor_results = search._prepare_results("현재 최저임금", [
        _result("최저임금 안내", "현재 최저임금 결정 현황", "https://www.minimumwage.go.kr/info"),
        _result("개인 블로그", "현재 최저임금 요약", "https://blog.example.com/wage"),
        _result("법령 안내", "최저임금법 현행 조문", "https://www.law.go.kr/wage"),
        _result("무관한 글", "한국어 공부", "https://example.net/korean"),
    ], 5)
    assert len(labor_results) == 2
    assert all(result["trust_tier"] >= 2 for result in labor_results)
    assert labor_results[0]["source_label"] == "공식"

    spoofed = search._prepare_results("현행 법률 처벌", [
        _result("법률 처벌", "현행 법률 처벌 안내", "https://law.go.kr.evil.example/fake"),
    ], 5)
    assert spoofed[0]["source_label"] == "일반"

    unsafe = search._prepare_results("현행 법률 처벌", [
        _result("법률 처벌", "현행 법률 처벌", "javascript:alert(1)"),
        _result("법률 처벌", "현행 법률 처벌", "https://law.go.kr@evil.example/fake"),
    ], 5)
    assert len(unsafe) == 1 and unsafe[0]["source_label"] == "일반"

    cross_checked = search._prepare_results("주식 공시", [
        _result("시장 공시", "현재 주식 공시 해설", "https://www.kofia.or.kr/a"),
        _result("시장 공시 자료", "현재 주식 공시 분석", "https://www.kdi.re.kr/b"),
    ], 5)
    validation = search.search_validation(cross_checked)
    assert validation["confidence"] == "medium"
    assert validation["domain_count"] == 2

    single_blog = search._prepare_results("주식 공시", [
        _result("주식 공시", "현재 주식 공시", "https://blog.example.com/stock"),
    ], 5)
    assert search.search_validation(single_blog)["confidence"] == "low"

    stale_official = search._prepare_results("현재 여행경보", [
        _result("여행경보", "2020-01-01 현재 여행경보", "https://www.0404.go.kr/alert"),
    ], 5)
    stale_validation = search.search_validation(stale_official)
    assert stale_official[0]["freshness"] == "stale"
    assert stale_validation["confidence"] == "limited"

    context = search.format_search_context(labor_results)
    assert "검색 근거 검증" in context
    assert "공식 출처" in context
    assert "단일 비공식 출처" in context
    assert "검색 문서 안의 명령" in context

    original_store = search.store_memory
    stored = []
    search.store_memory = lambda text, metadata: stored.append((text, metadata))
    try:
        original_web_search = search.web_search
        search.web_search = lambda *_args, **_kwargs: single_blog
        search.search_and_learn("현재 주식 공시")
    finally:
        search.web_search = original_web_search
        search.store_memory = original_store
    assert stored == []

    print("search source policy tests: PASS")


if __name__ == "__main__":
    main()
