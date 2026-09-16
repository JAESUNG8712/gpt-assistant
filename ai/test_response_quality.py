"""API 없는 답변 품질 게이트 회귀 테스트."""
import response_quality


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
