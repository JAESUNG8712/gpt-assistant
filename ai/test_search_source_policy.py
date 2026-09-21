"""주제별 공식 출처·최신성·교차검증 검색 정책 회귀 테스트."""

from datetime import date, timedelta

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

    # 연도와 "현재"가 함께 있어도 연도 일치가 최신성 검사를 우회하면 안 된다.
    two_days_ago = date.today() - timedelta(days=2)
    explicit_year_status, _ = search._freshness_status(
        f"{two_days_ago.year}년 현재 기준금리",
        _result("기준금리", f"{two_days_ago.isoformat()} 기준금리 안내", "https://bok.or.kr/rate"),
        {"fresh_days": 1},
    )
    assert explicit_year_status == "stale"
    future_day = date.today() + timedelta(days=30)
    future_status, _ = search._freshness_status(
        "현재 기준금리",
        _result("기준금리", f"{future_day.isoformat()} 시행 예정", "https://bok.or.kr/rate"),
        {"fresh_days": 45},
    )
    assert future_status == "unverified"

    # 최신 공식 근거가 있으면 같은 화제의 오래된 반대 결론은 현재 결론을
    # 충돌로 되돌리지 않고, 판단·자동학습에서 시간상 대체되어야 한다.
    fresh_day = date.today().isoformat()
    old_day = (date.today() - timedelta(days=240)).isoformat()
    temporal_stance = search._prepare_results("현재 일본 입국 가능한가요", [
        _result(
            "일본 입국 최신 안내", f"{fresh_day} 대한민국 국민의 일본 입국이 가능합니다.",
            "https://www.mofa.go.kr/current-entry",
        ),
        _result(
            "일본 입국 과거 제한", f"{old_day} 대한민국 국민의 일본 입국이 불가능합니다.",
            "https://www.visa.go.kr/old-entry",
        ),
    ], 5)
    temporal_validation = search.search_validation(temporal_stance)
    assert temporal_validation["stance_conflicts"] == []
    assert temporal_validation["superseded_count"] == 1
    assert temporal_validation["confidence"] == "high"
    temporal_context = search.format_search_context(temporal_stance)
    assert "오래된 근거 1개는 현재 결론과 학습에 사용하지 마세요" in temporal_context
    assert "일본 입국이 불가능합니다" not in temporal_context
    assert "시간상 제외" in temporal_context
    temporal_note = search.format_search_validation_note(temporal_stance)
    assert "오래된 근거 1건 제외" in temporal_note

    temporal_numeric_results = [
        {
            "url": "https://www.bok.or.kr/current", "trust_tier": 3,
            "freshness": "fresh", "numeric_claims": [{
                "key": "current:interest_rate:%", "year": "current",
                "label": "interest_rate", "unit": "%", "value": "3.5",
                "display": "3.5%", "domain": "bok.or.kr",
                "evidence_domain": "bok.or.kr", "trust_tier": 3,
            }],
        },
        {
            "url": "https://www.kdi.re.kr/old", "trust_tier": 2,
            "freshness": "stale", "numeric_claims": [{
                "key": "current:interest_rate:%", "year": "current",
                "label": "interest_rate", "unit": "%", "value": "4",
                "display": "4%", "domain": "kdi.re.kr",
                "evidence_domain": "kdi.re.kr", "trust_tier": 2,
            }],
        },
    ]
    temporal_numeric = search._numeric_claim_validation(temporal_numeric_results)
    assert temporal_numeric["conflicts"] == []
    assert len(temporal_numeric["superseded_results"]) == 1
    stale_numeric_answer = search.validate_answer_numeric_claims(
        "현재 기준금리", "현재 기준금리는 4%입니다.", temporal_numeric_results,
    )
    assert len(stale_numeric_answer["unsupported"]) == 1
    assert stale_numeric_answer["unsupported"][0]["source_values"] == ["3.5%"]

    # 시간상 대체는 같은 화제에서만 일어나야 한다 — 한 배치 안에 fresh 결과가
    # 있다고 해서 완전히 무관한 화제의 stale 결과까지 같이 지워지면 안 된다
    # (실제 재현된 오탐: 무비자 입국 재개 안내(fresh) 옆에 있던 엔화 환전
    # 팁(stale)이 화제와 무관하게 통째로 제외되던 문제).
    unrelated_topics = [
        {
            "url": "https://www.mofa.go.kr/notice1", "trust_tier": 3,
            "freshness": "fresh", "title": "일본 무비자 입국 재개",
            "body": "일본은 2026년 9월부터 무비자 입국을 재개했습니다.",
        },
        {
            "url": "https://travelblog.example.com/tips", "trust_tier": 1,
            "freshness": "stale", "title": "엔화 환전 팁",
            "body": "엔화는 공항보다 시내 환전소가 유리합니다.",
        },
    ]
    unrelated_effective, unrelated_superseded = search._temporally_preferred_results(
        unrelated_topics
    )
    assert len(unrelated_effective) == 2
    assert unrelated_superseded == []

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
    repaired_answer = search.repair_answer_numeric_claims(
        "2027년 최저임금은 시간급 10,900 원입니다.", unsupported_answer
    )
    assert repaired_answer["answer"] == "2027년 최저임금은 시간급 10,700원입니다."
    assert repaired_answer["repairs"][0]["from"] == "10,900원"
    assert "출력 전 자동 교정" in search.format_answer_repair_note(repaired_answer)
    assert "장기기억 후보로 저장하지 않습니다" in search.format_answer_repair_note(repaired_answer)

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
    conflict_answer_repair = search.repair_conflicting_numeric_claims(
        "2027년 최저임금",
        "2027년 최저임금은 시간급 10,700원입니다. 추가 확인이 필요합니다.",
        conflicting_validation,
    )
    assert "최저임금은 시간급 10,700원입니다" not in conflict_answer_repair["answer"]
    assert "하나의 값을 확정할 수 없습니다" in conflict_answer_repair["answer"]
    assert conflict_answer_repair["neutralized"] is True
    assert "충돌 수치 자동 보류" in search.format_numeric_conflict_repair_note(
        conflict_answer_repair
    )
    unresolved_conflict = search.validate_answer_numeric_claims(
        "2027년 최저임금", "2027년 시간급은 10,900원입니다.", conflicting_numbers
    )
    unresolved_repair = search.repair_answer_numeric_claims(
        "2027년 시간급은 10,900원입니다.", unresolved_conflict
    )
    assert unresolved_repair["repairs"] == []
    assert len(unresolved_repair["unresolved"]) == 1
    assert "10,900원" in unresolved_repair["answer"]

    stance_conflict_results = search._prepare_results("일본 입국 가능한가요", [
        _result(
            "일본 입국 허용 안내", "대한민국 국민은 일본에 입국할 수 있습니다.",
            "https://www.mofa.go.kr/jp-entry",
        ),
        _result(
            "일본 입국 제한 안내", "현재 대한민국 국민은 일본에 입국할 수 없습니다.",
            "https://www.visa.go.kr/jp-entry",
        ),
    ], 5)
    stance_validation = search.search_validation(stance_conflict_results)
    assert stance_validation["confidence"] == "conflict"
    assert len(stance_validation["stance_conflicts"]) == 1
    stance_context = search.format_search_context(stance_conflict_results)
    assert "가능·불가능 중 어느 한쪽도 선택하지 말고 '확정 불가'" in stance_context
    stance_note = search.format_search_validation_note(stance_conflict_results)
    assert "가능 여부 확정 보류" in stance_note
    assert "mofa.go.kr" in stance_note and "visa.go.kr" in stance_note

    same_domain_stance = search._prepare_results("일본 입국 가능한가요", [
        _result("입국 허용", "일본에 입국할 수 있습니다.", "https://www.mofa.go.kr/a"),
        _result("입국 제한", "일본에 입국할 수 없습니다.", "https://overseas.mofa.go.kr/b"),
    ], 5)
    assert search.search_validation(same_domain_stance)["stance_conflicts"] == []

    # 서로 다른 화제(무비자 입국 가능 여부 vs 액체류 기내 반입 가능 여부)를 다루는
    # 독립 출처가 각각 긍정·부정 표현을 하나씩만 담고 있다는 이유만으로 같은
    # 쟁점의 반대 결론으로 오판되면 안 된다(실제 재현된 오탐 방지 회귀).
    unrelated_topics = search._prepare_results("일본 여행 준비물", [
        _result("일본 여행 가이드", "일본은 무비자 입국이 가능합니다.", "https://www.mofa.go.kr/japan"),
        _result("면세 반입 안내", "액체류는 100ml 초과 시 기내 반입이 불가능합니다.", "https://customs.go.kr/liquid"),
    ], 5)
    assert search.search_validation(unrelated_topics)["stance_conflicts"] == []

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

    learned_temporal = []
    search.store_memory = lambda text, metadata: learned_temporal.append((text, metadata))
    search.web_search = lambda *_args, **_kwargs: temporal_stance
    try:
        search.search_and_learn("현재 일본 입국 가능한가요")
    finally:
        search.web_search = original_web_search
        search.store_memory = original_store
    assert len(learned_temporal) == 1
    assert "최신 안내" in learned_temporal[0][0]

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
