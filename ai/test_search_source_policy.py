"""주제별 공식 출처·최신성·교차검증 검색 정책 회귀 테스트."""

from datetime import date

import search


def _result(title, body, url):
    return {"title": title, "body": body, "href": url}


def main():
    assert search.should_auto_verify(f"{date.today().year + 1}년 최저임금")
    assert search.should_auto_verify("현재 기준금리")
    assert not search.should_auto_verify(f"{date.today().year - 2}년 일반 역사 사건")
    requirements = search.analyze_query_requirements(
        "2026년과 2027년 최저임금 금액과 적용일을 비교해줘"
    )
    assert requirements["years"] == ["2026", "2027"]
    assert {"amount", "date", "comparison"}.issubset(requirements["aspects"])
    planned = search.build_search_queries(
        "2026년과 2027년 최저임금 금액을 비교해줘"
    )
    assert planned[0].startswith("2026년과 2027년")
    assert any(item.startswith("2026년 최저임금") for item in planned[1:])
    assert any(item.startswith("2027년 최저임금") for item in planned[1:])

    wrong_year = search._prepare_results("2027년 최저임금", [
        _result("2026년 최저임금", "2026년 시간급 10,320원", "https://www.minimumwage.go.kr/2026"),
    ], 5)
    assert wrong_year == []
    wrong_comparison_year = search._prepare_results("2026년과 2027년 최저임금 비교", [
        _result("2025년 최저임금", "2025년 시간급 안내", "https://www.minimumwage.go.kr/2025"),
    ], 5)
    assert wrong_comparison_year == []

    labor_results = search._prepare_results("현재 최저임금", [
        _result("최저임금 안내", "현재 최저임금 결정 현황", "https://www.minimumwage.go.kr/info"),
        _result("개인 블로그", "현재 최저임금 요약", "https://blog.example.com/wage"),
        _result("법령 안내", "최저임금법 현행 조문", "https://www.law.go.kr/wage"),
        _result("무관한 글", "한국어 공부", "https://example.net/korean"),
    ], 5)
    assert len(labor_results) == 2
    assert all(result["trust_tier"] >= 2 for result in labor_results)
    assert labor_results[0]["source_label"] == "공식"

    diverse = search._prepare_results("최저임금 안내", [
        _result("최저임금 안내 1", "최저임금 핵심 사실", "https://www.minimumwage.go.kr/a"),
        _result("최저임금 안내 2", "최저임금 상세 사실", "https://www.minimumwage.go.kr/b"),
        _result("최저임금 전문 안내", "최저임금 해설", "https://www.easylaw.go.kr/c"),
    ], 2)
    assert {search._evidence_domain(search._domain(item["url"])) for item in diverse} == {
        "minimumwage.go.kr", "easylaw.go.kr",
    }

    partial = search._prepare_results("2027년 최저임금 금액과 적용일", [
        _result("2027년 최저임금", "2027년 시간급 10,700원", "https://www.minimumwage.go.kr/2027"),
    ], 5)
    partial_validation = search.search_validation(partial)
    assert partial_validation["confidence"] == "limited"
    assert partial_validation["missing_aspects"] == ["date"]
    assert partial_validation["evidence_coverage"] < 1
    partial_context = search.format_search_context(partial)
    assert "질문 근거 충족률" in partial_context
    assert "질문 분해:" in partial_context
    assert "적용·시행 시점" in partial_context
    gap_queries = search.build_gap_search_queries(
        "2027년 최저임금 적용일", partial,
    )
    assert any("적용 시행일" in item for item in gap_queries)

    search_calls = []
    class FakeDDGS:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def text(self, query, max_results=5):
            search_calls.append(query)
            if "적용 시행일" in query:
                return [_result(
                    "2027년 최저임금 적용일", "2027년 1월 1일부터 적용",
                    "https://www.moel.go.kr/2027-date",
                )]
            return [_result(
                "2027년 최저임금", "2027년 시간급 10,700원",
                "https://www.minimumwage.go.kr/2027",
            )]

    original_ddgs = search.DDGS
    search.DDGS = FakeDDGS
    try:
        autonomously_filled = search.web_search("2027년 최저임금 적용일", 5)
    finally:
        search.DDGS = original_ddgs
    assert len(search_calls) >= 2
    assert search.search_validation(
        autonomously_filled, query="2027년 최저임금 적용일"
    )["missing_aspects"] == []

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

    stale_memory = search.validate_memory_against_search(
        "2027년 최저임금",
        "기존 기억: 2027년 최저임금은 시간급 10,900원입니다.",
        matching_numbers,
    )
    assert len(stale_memory["conflicts"]) == 1
    memory_rule = search.format_memory_search_conflict_note(stale_memory)
    assert "10,900원" in memory_rule and "10,700원" in memory_rule
    assert "검색에서 확인된 공공·전문기관 값을 우선" in memory_rule
    memory_warning = search.format_memory_search_conflict_warning(stale_memory)
    assert "기억 최신성 교정" in memory_warning
    assert "자동 학습에서 제외" in memory_warning
    current_memory = search.validate_memory_against_search(
        "2027년 최저임금",
        "기존 기억: 2027년 최저임금은 시간급 10,700원입니다.",
        matching_numbers,
    )
    assert current_memory["conflicts"] == []
    assert search.format_memory_search_conflict_note(current_memory) == ""

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

    # 2026-09-14 발견·수정: 질의 단어에 붙은 조사가 검색 결과 문장의 조사와 달라
    # ("최저임금은" 질문 vs "최저임금이" 결과) 리터럴 부분일치가 실패해 명백히
    # 관련된 공식 출처 결과까지 관련성 0으로 완전히 제외되던 버그. 단일 핵심
    # 명사 하나만으로 구성된 질문일수록(다른 단어가 하나도 안 겹치면 구제 불가)
    # 영향이 컸다.
    particle_score, particle_ok, particle_meta = search._result_relevance(
        "최저임금은 얼마예요",
        _result(
            "2027년 최저임금 결정",
            "2027년 최저임금이 시간당 10,700원으로 결정되었습니다.",
            "https://www.minimumwage.go.kr/2027",
        ),
    )
    assert particle_ok is True and particle_score > 0
    assert particle_meta["matched_anchors"] == ["최저임금은"]

    procedure_score, procedure_ok, _ = search._result_relevance(
        "육아휴직을 신청하는 방법",
        _result(
            "육아휴직 신청 안내",
            "육아휴직 신청은 회사에 서면으로 제출하면 됩니다.",
            "https://www.moel.go.kr/parental-leave",
        ),
    )
    assert procedure_ok is True and procedure_score > 0

    # 정말 무관한 내용은 여전히 걸러져야 한다(조사 보정이 과도하게 관대해지지 않았는지 확인).
    unrelated_score, unrelated_ok, _ = search._result_relevance(
        "최저임금은 얼마예요",
        _result("여행지 추천", "제주도 여행 코스를 소개합니다.", "https://blog.example.com/travel"),
    )
    assert unrelated_ok is False and unrelated_score == 0

    print("search source policy tests: PASS")


if __name__ == "__main__":
    main()
