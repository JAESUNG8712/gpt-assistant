"""채팅 저장·자동학습 판정 파이프라인 회귀 테스트."""
import chat_postprocess


class FakeMemory:
    def __init__(self):
        self.messages = []
        self.candidates = []

    def save_message(self, role, content, **kwargs):
        self.messages.append((role, content, kwargs))

    def auto_learn(self, question, answer, **kwargs):
        self.candidates.append((question, answer, kwargs))
        return 77


def _decision(**overrides):
    values = {
        "is_shared_session": False,
        "is_new_synthesized_answer": True,
        "reply": "검증된 답변",
        "stock_mode": False,
        "memory_search_validation": {"conflicts": []},
        "answer_guard": {"should_block_learning": False},
        "answer_quality": {"should_block_learning": False},
        "law_context": "",
        "search_context": "검색 근거",
        "rag_context": "KB 근거",
        "references": [
            {
                "title": "공식", "url": "https://example.com/a", "source_label": "공식",
                "freshness": "fresh", "date_evidence": "2026-09-22",
            },
            {"title": "중복", "url": "https://example.com/a"},
            {"title": "무효", "url": "javascript:alert(1)"},
        ],
        "top_memory_source": "승인학습",
    }
    values.update(overrides)
    return chat_postprocess.decide_learning(**values)


def main():
    assert chat_postprocess.clean_reply(
        "<think>내부 사고 과정</think>\n최종 답변"
    ) == "최종 답변"

    original_evaluate = chat_postprocess.response_quality.evaluate
    chat_postprocess.response_quality.evaluate = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("비생성 답변을 품질 평가함")
    )
    try:
        skipped_quality, skipped_warning = chat_postprocess.evaluate_generated_answer(
            False, "질문", "답변", "근거", "이전 답변"
        )
    finally:
        chat_postprocess.response_quality.evaluate = original_evaluate
    assert skipped_quality["should_block_learning"] is False
    assert skipped_warning == ""

    allowed = _decision()
    assert allowed.eligible is True
    assert allowed.reasons == []
    assert allowed.source == "웹검색보강"
    assert allowed.evidence == [
        {
            "title": "공식", "url": "https://example.com/a",
            "type": "external_reference", "source_label": "공식",
            "freshness": "fresh", "date_evidence": "2026-09-22",
        },
        {"title": "기존 기억: 승인학습", "type": "memory_context"},
    ]

    blocked = _decision(
        is_shared_session=True,
        stock_mode=True,
        memory_search_validation={"conflicts": ["충돌"]},
        answer_guard={"should_block_learning": True},
        answer_quality={"should_block_learning": True},
    )
    assert blocked.eligible is False
    assert set(blocked.reasons) >= {
        "shared_session", "volatile_stock_answer", "memory_search_conflict",
        "evidence_guard", "quality_guard",
    }

    marker_blocked = _decision(
        reply=(chat_postprocess.LOCAL_FALLBACK_MARKER
               + chat_postprocess.local_gen.MARKER_TAG
               + chat_postprocess.LOCAL_REASONING_MARKER)
    )
    assert set(marker_blocked.reasons) == {
        "raw_fallback", "local_generation", "local_reasoning",
    }

    store = FakeMemory()
    candidate_id = chat_postprocess.persist(
        user_message="질문", assistant_reply="답변\n\n---\n참고 자료",
        candidate_reply="답변", persona_id="hr",
        session_scope="owner:1", command_status={"commands": ["/검색"]},
        answer_quality={
            "score": 0.9, "grade": "high", "issues": list(range(8)),
            "should_block_learning": False,
        },
        learning_decision=allowed, memory_store=store,
    )
    assert candidate_id == 77
    assert [message[0] for message in store.messages] == ["user", "assistant"]
    assistant_meta = store.messages[1][2]["command_status"]["answer_quality"]
    assert assistant_meta["score"] == 0.9
    assert assistant_meta["issues"] == [0, 1, 2, 3, 4]
    learning_meta = store.messages[1][2]["command_status"]["learning_decision"]
    assert learning_meta == {
        "eligible": True, "blocked_reasons": [], "candidate_source": "웹검색보강",
    }
    assert store.candidates[0][2]["source"] == "웹검색보강"
    assert store.candidates[0][2]["evidence"] == allowed.evidence
    assert store.messages[1][1] == "답변\n\n---\n참고 자료"
    assert store.candidates[0][1] == "답변"

    blocked_store = FakeMemory()
    assert chat_postprocess.persist(
        user_message="질문", assistant_reply="답변", persona_id="hr",
        candidate_reply="답변",
        session_scope="owner:1", command_status={}, answer_quality={},
        learning_decision=blocked, memory_store=blocked_store,
    ) is None
    assert len(blocked_store.messages) == 2
    assert blocked_store.candidates == []
    blocked_meta = blocked_store.messages[1][2]["command_status"]["learning_decision"]
    assert blocked_meta["eligible"] is False
    assert "quality_guard" in blocked_meta["blocked_reasons"]

    print("chat postprocess tests: PASS")


if __name__ == "__main__":
    main()
