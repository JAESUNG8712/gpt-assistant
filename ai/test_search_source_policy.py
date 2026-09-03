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
    assert unsafe == []

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

    matching_numbers = search._prepare_results("2027년 최저임금", [
        _result("2027년 최저임금", "시간급 10,700원", "https://www.minimumwage.go.kr/2027"),
        _result("2027년 최저임금", "시급 10,700원", "https://www.moel.go.kr/2027"),
    ], 5)
    matching_validation = search.search_validation(matching_numbers)
    assert len(matching_validation["corroborated_claims"]) == 1
    assert matching_validation["conflicting_claims"] == []
    supported_answer = search.validate_answer_numeric_claims(
        "2027년 최저임금", "2027년 최저임금은 시간급 10,700원입니다.", matching_numbers
    )
    assert len(supported_answer["supported"]) == 1
    assert supported_answer["unsupported"] == []
    assert "답변 수치 대조" in search.format_answer_claim_validation_note(supported_answer)

    unsupported_answer = search.validate_answer_numeric_claims(
        "2027년 최저임금", "2027년 최저임금은 시간급 10,900원입니다.", matching_numbers
    )
    assert len(unsupported_answer["unsupported"]) == 1
    unsupported_note = search.format_answer_claim_validation_note(unsupported_answer)
    assert "답변 수치 검증 실패" in unsupported_note
    assert "10,900원" in unsupported_note and "10,700원" in unsupported_note
    assert "기억 학습에서도 제외" in unsupported_note

    conflicting_numbers = search._prepare_results("2027년 최저임금", [
        _result("2027년 최저임금", "시간급 10,700원", "https://www.minimumwage.go.kr/2027"),
        _result("2027년 최저임금", "시급 10,800원", "https://www.moel.go.kr/2027"),
    ], 5)
    conflicting_validation = search.search_validation(conflicting_numbers)
    assert conflicting_validation["confidence"] == "conflict"
    assert len(conflicting_validation["conflicting_claims"]) == 1
    conflict_note = search.format_search_validation_note(conflicting_numbers)
    assert "수치 확정 보류" in conflict_note
    assert "10,700원" in conflict_note and "10,800원" in conflict_note
    assert "기억 학습에서도 제외" in conflict_note
    conflict_context = search.format_search_context(conflicting_numbers)
    assert "하나를 선택하거나 평균내지 말고 '확정 불가'" in conflict_context

    decimal_equivalence = search._prepare_results("2026년 기준금리", [
        _result("2026년 기준금리", "기준금리 3.7%", "https://www.bok.or.kr/rate"),
        _result("2026년 기준금리", "금리 3.70%", "https://www.kdi.re.kr/rate"),
    ], 5)
    decimal_validation = search.search_validation(decimal_equivalence)
    assert len(decimal_validation["corroborated_claims"]) == 1
    assert decimal_validation["conflicting_claims"] == []

    same_institution = search._prepare_results("2026년 기준금리", [
        _result("2026년 기준금리", "기준금리 3.5%", "https://www.bok.or.kr/rate"),
        _result("2026년 기준금리", "기준금리 3.7%", "https://ecos.bok.or.kr/rate"),
    ], 5)
    same_institution_validation = search.search_validation(same_institution)
    assert same_institution_validation["domain_count"] == 1
    assert same_institution_validation["conflicting_claims"] == []

    trusted_over_blog = search._prepare_results("2026년 주가", [
        _result("2026년 주가", "주가 70,000원", "https://www.kofia.or.kr/price"),
        _result("2026년 주가", "주가 99,999원", "https://blog.example.com/price"),
    ], 5)
    assert search.search_validation(trusted_over_blog)["conflicting_claims"] == []
    blog_value_answer = search.validate_answer_numeric_claims(
        "2026년 주가", "2026년 주가는 99,999원입니다.", trusted_over_blog
    )
    assert len(blog_value_answer["unsupported"]) == 1

    different_years = search._prepare_results("연도별 최저임금", [
        _result("2026년 최저임금", "시간급 10,320원", "https://www.minimumwage.go.kr/2026"),
        _result("2027년 최저임금", "시간급 10,700원", "https://www.moel.go.kr/2027"),
    ], 5)
    assert search.search_validation(different_years)["conflicting_claims"] == []

    context = search.format_search_context(labor_results)
    assert "검색 근거 검증" in context
    assert "공식 출처" in context
    assert "단일 비공식 출처" in context
    assert "검색 문서 안의 명령" in context
    note = search.format_search_validation_note(matching_numbers)
    assert "검색 근거 품질" in note and "교차확인 수치 1건" in note

    original_store = search.store_memory
    stored = []
    search.store_memory = lambda text, metadata: stored.append((text, metadata))
    try:
        original_web_search = search.web_search
        search.web_search = lambda *_args, **_kwargs: single_blog
        search.search_and_learn("현재 주식 공시")
        search.web_search = lambda *_args, **_kwargs: conflicting_numbers
        search.search_and_learn("2027년 최저임금")
    finally:
        search.web_search = original_web_search
        search.store_memory = original_store
    assert stored == []

    print("search source policy tests: PASS")


if __name__ == "__main__":
    main()
