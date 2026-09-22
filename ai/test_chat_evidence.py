"""채팅 근거 조립 파이프라인 회귀 테스트."""
import chat_evidence


def _bundle():
    return {
        "results": [{"title": "공식 발표", "url": "https://official.example/fact"}],
        "validation": {"confidence": "high"},
        "context": "[검색결과 1]\n공식 발표 내용",
        "note": "\n\n> 검색 근거 품질: 높음",
        "references": [{
            "title": "공식 발표", "url": "https://official.example/fact",
            "source_label": "공식",
        }],
    }


def main():
    bundle = _bundle()
    standard = chat_evidence.prepare_standard(
        "최저임금 알려줘", "[질문 의도] 사실 확인", "[기억 충돌 없음]",
        "[법령 원문] 최저임금법", "[내부 지식] 임금 안내",
        [{"title": "최저임금법", "url": "https://law.go.kr/minimum"}],
        bundle,
    )
    assert standard.bundle is bundle
    assert standard.results is bundle["results"]
    assert "질문 의도" in standard.context
    assert "법령 원문" in standard.context
    assert "내부 지식" in standard.context
    assert "검색결과 1" in standard.context
    assert [ref["source_label"] for ref in standard.references] == ["공식 법령", "공식"]

    stock, labels = chat_evidence.prepare_stock(
        "삼성전자 전망", "[의도] 주식 분석", "보고서", "증권사 의견", "최신 기사",
        bundle, [{"title": "증권사 보고서", "url": "https://broker.example/report"}],
    )
    assert labels == [
        "📋 최근 분석 보고서", "📊 증권사 애널리스트 리포트",
        "📰 최신 뉴스·기사", "🌐 실시간 인터넷 검색", "🧠 AI 주식 전문 지식",
    ]
    assert "[최근 주식 분석 보고서]" in stock.context
    assert "[증권사 애널리스트 리포트 컨센서스]" in stock.context
    assert "[최신 뉴스·기사]" in stock.context
    assert "[실시간 인터넷 검색 결과]" in stock.context
    assert len(stock.references) == 2

    captured = {}
    original_guard = chat_evidence.response_quality.apply_evidence_guard
    def fake_guard(question, answer, context, results, evidence_validation=None):
        captured.update({
            "question": question, "answer": answer, "context": context,
            "results": results, "validation": evidence_validation,
        })
        return {
            "answer": answer, "notes": ["교정 안내"],
            "claim_validation": {"supported": [], "unsupported": []},
            "should_block_learning": False,
        }
    chat_evidence.response_quality.apply_evidence_guard = fake_guard
    try:
        guarded = chat_evidence.guard_generated_answer("질문", "답변", standard)
    finally:
        chat_evidence.response_quality.apply_evidence_guard = original_guard
    assert guarded["answer"] == "답변"
    assert captured["results"] is bundle["results"]
    assert captured["validation"] is bundle["validation"]
    assert captured["context"] == standard.context

    notes = chat_evidence.evidence_notes(
        standard, guarded, {"matched": [], "conflicts": []},
    )
    assert notes[:2] == ["교정 안내", bundle["note"]]

    empty = chat_evidence.prepare_standard(
        "질문", "의도", "", "", "", [],
        {"results": [], "validation": {}, "context": "", "note": "", "references": []},
    )
    assert empty.context == "의도"
    assert empty.references == []

    hidden_law_reference = chat_evidence.prepare_standard(
        "질문", "의도", "", "", "", law_results=[
            {"title": "미사용 법령", "url": "https://law.go.kr/unused"}
        ], search_bundle={
            "results": [], "validation": {}, "context": "", "note": "", "references": [],
        },
    )
    assert hidden_law_reference.references == []

    print("chat evidence pipeline tests: PASS")


if __name__ == "__main__":
    main()
