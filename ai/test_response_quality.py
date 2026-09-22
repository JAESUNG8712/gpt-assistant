"""API 없는 답변 품질 게이트 회귀 테스트."""
import response_quality


def _result(title, body, url):
    return {"title": title, "body": body, "href": url}


def main():
    context = "2027년 최저임금은 시간당 10,700원이며 2027년 1월 1일부터 적용됩니다."
    good = response_quality.evaluate(
        "2027년 최저임금 금액과 적용 시점을 알려줘",
        "금액은 시간당 10,700원입니다. 적용 시점은 2027년 1월 1일입니다.", context,
    )
    assert good["score"] >= 0.55, good
    assert good["unsupported_claims"] == []
    assert good["unsupported_sentences"] == []
    assert good["sentence_grounding"] == 1.0
    assert good["should_block_learning"] is False

    mixed = response_quality.evaluate(
        "2027년 최저임금 금액과 적용 시점을 알려줘",
        "최저임금은 시간당 10,700원입니다. 서울 인구는 1,500만 명입니다.",
        context,
    )
    assert mixed["sentence_grounding"] == 0.5, mixed
    assert mixed["unsupported_sentences"] == ["서울 인구는 1,500만 명입니다."]
    assert mixed["should_block_learning"] is True
    assert mixed["should_warn"] is True
    mixed_warning = response_quality.format_warning(mixed, "2027년 최저임금", context)
    assert "자료로 확인되지 않은 문장" in mixed_warning
    assert "서울 인구" in mixed_warning

    polarity_context = "육아휴직 대상 근로자는 회사에 육아휴직을 신청할 수 있습니다."
    opposite = response_quality.evaluate(
        "육아휴직 신청이 가능한가요?",
        "육아휴직 대상 근로자는 회사에 신청할 수 없습니다.",
        polarity_context,
    )
    assert opposite["contradicted_sentences"] == [
        "육아휴직 대상 근로자는 회사에 신청할 수 없습니다."
    ], opposite
    assert opposite["should_block_learning"] is True
    repaired_opposite = response_quality.repair_contradicted_sentences(
        "육아휴직 신청이 가능한가요?",
        "육아휴직 대상 근로자는 회사에 신청할 수 없습니다.",
        polarity_context, opposite,
    )
    assert "신청할 수 없습니다" not in repaired_opposite["answer"]
    assert "신청할 수 있습니다" in repaired_opposite["answer"]
    assert repaired_opposite["recovered"] is True
    assert "근거 반대 문장 차단" in response_quality.format_contradiction_repair_note(
        repaired_opposite
    )

    conditional_context = (
        "육아휴직은 근속기간이 6개월 이상인 근로자만 신청할 수 있습니다."
    )
    overgeneralized = response_quality.evaluate(
        "육아휴직 신청이 가능한가요?",
        "근로자는 육아휴직을 신청할 수 있습니다.",
        conditional_context,
    )
    assert overgeneralized["missing_conditions"], overgeneralized
    assert "6개월" in overgeneralized["missing_conditions"][0]["missing_values"]
    condition_repair = response_quality.repair_missing_conditions(
        "근로자는 육아휴직을 신청할 수 있습니다.", overgeneralized
    )
    assert "6개월 이상인 근로자만" in condition_repair["answer"]
    assert "누락 조건 자동 보완" in response_quality.format_condition_repair_note(
        condition_repair
    )
    already_scoped = response_quality.evaluate(
        "육아휴직 신청이 가능한가요?",
        "근속기간이 6개월 이상인 근로자만 육아휴직을 신청할 수 있습니다.",
        conditional_context,
    )
    assert already_scoped["missing_conditions"] == []

    # 실제 검색 근거는 조건이 원래 진술과 같은 문장이 아니라 "다만/단, ~"으로
    # 이어지는 별도 문장으로 오는 경우가 훨씬 흔하다. 이런 문장은 원 진술과
    # 어휘가 거의 겹치지 않아 겹침 검사만으로는 놓쳤던 실제 회귀 케이스.
    attached_exception_context = (
        "[검색결과 1 | 공식 | 출처: moel.go.kr]\n"
        "내용: 육아휴직 급여는 통상임금의 80%를 지급합니다. 다만 월 상한액 "
        "150만원을 초과하는 경우에는 150만원만 지급합니다.\n"
    )
    cap_missing = response_quality.evaluate(
        "육아휴직 급여는 얼마나 받나요",
        "육아휴직 급여는 통상임금의 80%를 지급합니다.",
        attached_exception_context,
    )
    assert cap_missing["missing_conditions"], cap_missing
    assert "150만원" in cap_missing["missing_conditions"][0]["missing_values"]
    cap_repair = response_quality.repair_missing_conditions(
        "육아휴직 급여는 통상임금의 80%를 지급합니다.", cap_missing
    )
    assert "150만원만 지급합니다" in cap_repair["answer"]

    # 같은 근거 블록이 아니라 전혀 다른 출처의 "다만" 문장이 우연히 답변 관련
    # 문장 바로 뒤에 온 경우까지 예외로 잘못 붙이면 안 된다 (오탐 방지 회귀).
    cross_block_context = (
        "[검색결과 1 | 공식 | 출처: moel.go.kr]\n"
        "내용: 육아휴직 급여는 통상임금의 80%를 지급합니다.\n\n"
        "[검색결과 2 | 일반 | 출처: blog.example.com]\n"
        "다만 이 블로그는 육아휴직과 무관한 내용이며 5인 미만 사업장에는 "
        "적용하지 않습니다.\n"
    )
    cross_block = response_quality.evaluate(
        "육아휴직 급여는 얼마인가요",
        "육아휴직 급여는 통상임금의 80%를 지급합니다.",
        cross_block_context,
    )
    assert cross_block["missing_conditions"] == [], cross_block
    stance_repair = response_quality.repair_stance_conflict(
        "현재 일본 입국은 가능합니다.",
        {"stance_conflicts": [{
            "positive": [{"domain": "mofa.go.kr"}],
            "negative": [{"domain": "visa.go.kr"}],
        }]},
    )
    assert "입국은 가능합니다" not in stance_repair["answer"]
    assert "확정할 수 없습니다" in stance_repair["answer"]
    assert stance_repair["neutralized"] is True
    assert "상반된 결론 자동 보류" in response_quality.format_stance_conflict_repair_note(
        stance_repair
    )

    # 충돌은 특정 화제(무비자 입국 가능 여부) 하나에 대한 것인데, 답변에 전혀
    # 다른 화제(액체류 반입 가능 여부)의 단정 문장이 함께 있으면 그 무관한
    # 문장까지 지워지면 안 된다 (실제 재현된 회귀).
    import search as _search
    mixed_topic_results = _search._prepare_results("일본 입국 가능한가요", [
        _result(
            "외교부 공지", "현재 일본 무비자 입국이 가능합니다.",
            "https://www.mofa.go.kr/notice1",
        ),
        _result(
            "비자청 공지", "현재 일본 무비자 입국은 불가능합니다.",
            "https://www.visa.go.kr/notice2",
        ),
    ], 5)
    mixed_topic_validation = _search.search_validation(mixed_topic_results)
    mixed_topic_repair = response_quality.repair_stance_conflict(
        "일본 무비자 입국은 가능합니다. 또한 액체류는 100ml 이하만 반입이 가능합니다.",
        mixed_topic_validation,
    )
    assert "입국은 가능합니다" not in mixed_topic_repair["answer"]
    assert "액체류는 100ml 이하만 반입이 가능합니다" in mixed_topic_repair["answer"]
    assert mixed_topic_repair["neutralized"] is True

    # 분산돼 있던 출력 전 교정을 통합 가드 한 번으로 실행하며, 출처 수치가
    # 충돌할 때 모델이 그중 하나를 골라도 확정 답변이 사용자에게 나가면 안 된다.
    numeric_conflict_results = _search._prepare_results("2027년 최저임금", [
        _result(
            "2027년 최저임금", "2027년 시간급 10,700원",
            "https://www.minimumwage.go.kr/2027",
        ),
        _result(
            "2027년 최저임금", "2027년 시간급 10,800원",
            "https://www.moel.go.kr/2027",
        ),
    ], 5)
    bundled_validation = _search.search_validation(numeric_conflict_results)
    original_search_validation = _search.search_validation
    _search.search_validation = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("통합 가드가 이미 계산된 검증을 다시 실행함")
    )
    try:
        guarded = response_quality.apply_evidence_guard(
            "2027년 최저임금은 얼마야",
            "2027년 최저임금은 시간급 10,700원입니다.",
            _search.format_search_context(
                numeric_conflict_results, validation=bundled_validation
            ),
            numeric_conflict_results,
            evidence_validation=bundled_validation,
        )
    finally:
        _search.search_validation = original_search_validation
    assert "최저임금은 시간급 10,700원입니다" not in guarded["answer"]
    assert "하나의 값을 확정할 수 없습니다" in guarded["answer"]
    assert guarded["repairs"]["numeric_conflict"]["neutralized"] is True
    assert guarded["should_block_learning"] is True
    assert "numeric_evidence_conflict" in guarded["block_reasons"]
    assert any("충돌 수치 자동 보류" in note for note in guarded["notes"])

    unsupported = response_quality.evaluate(
        "2027년 최저임금 금액을 알려줘",
        "2027년 최저임금은 시간당 12,000원입니다.", context,
    )
    assert "12000원" in unsupported["unsupported_claims"]
    assert unsupported["should_block_learning"] is True

    contradiction = response_quality.evaluate(
        "최저임금은 얼마야?", "최저임금은 12,000원입니다.", "",
        "최저임금은 10,700원입니다.",
    )
    assert contradiction["conversation_consistency"] < 0.5
    assert any("직전 답변" in issue for issue in contradiction["issues"])

    repeated = response_quality.evaluate(
        "퇴직금 계산 방법",
        "퇴직금 계산 방법을 확인하세요.\n퇴직금 계산 방법을 확인하세요.",
    )
    assert any("중복 문장" in issue for issue in repeated["issues"])
    repaired = response_quality.format_warning(
        {"issues": ["근거 부족"]}, "2027년 최저임금", context,
    )
    assert "장기기억 후보에는" in repaired
    assert "현재 자료에서 다시 확인된 내용" in repaired
    assert "10,700원" in repaired

    limited_context = (
        "[검색 근거 검증]\n신뢰 수준: limited (질문의 일부 요청 항목에 대한 근거가 부족함)\n"
        + context
    )
    limited = response_quality.evaluate(
        "2027년 최저임금", "2027년 최저임금은 10,700원입니다.", limited_context,
    )
    assert limited["evidence_confidence"] == "limited"
    assert limited["should_block_learning"] is True
    conflict = response_quality.evaluate(
        "2027년 최저임금", "2027년 최저임금은 확인이 필요합니다.",
        "신뢰 수준: conflict (출처 충돌)",
    )
    assert conflict["should_warn"] is True
    print("response quality tests: PASS")


if __name__ == "__main__":
    main()
