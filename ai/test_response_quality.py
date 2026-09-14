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
    assert good["should_block_learning"] is False

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
    assert "장기기억 후보에는" in response_quality.format_warning({"issues": ["근거 부족"]})
    print("response quality tests: PASS")


if __name__ == "__main__":
    main()
