"""요청형 LLM 의미 충돌 검증과 승인 게이트 회귀 테스트."""
import asyncio
import os
import tempfile


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "semantic.db")

        import memory
        import semantic_memory

        memory._seed_static_kb_to_db = lambda: None
        memory.init_db()
        memory.upsert_knowledge(
            "연차 신청 사전 제출 기준은 무엇인가요?",
            "연차 신청서는 사용일 기준 최소 3일 전에 제출해야 합니다.",
            "semantic_test", source="승인학습",
        )
        candidate_id = memory.store_memory_candidate(
            "휴가를 쓰려면 언제 회사에 알려야 하나요?",
            "휴가는 사용하는 당일 오전에만 알리면 언제든 사용할 수 있습니다.",
            "semantic_test", source="생성답변",
        )
        assert not memory.find_memory_contradictions(
            "휴가를 쓰려면 언제 회사에 알려야 하나요?",
            "휴가는 사용하는 당일 오전에만 알리면 언제든 사용할 수 있습니다.",
            "semantic_test",
        )
        context = memory.semantic_contradiction_context(candidate_id)
        existing_id = context["related_memories"][0]["memory_id"]

        original_stream = semantic_memory.llm.chat_stream

        async def fake_stream(*_args, **_kwargs):
            yield (
                '{"verdict":"conflict","confidence":0.94,'
                '"summary":"사전 제출 시점이 3일 전과 당일로 충돌합니다.",'
                f'"conflicts":[{{"memory_id":{existing_id},"reason":"제출 시점 불일치"}},'
                '{"memory_id":999999,"reason":"입력에 없는 ID"}]}'
            )

        semantic_memory.llm.chat_stream = fake_stream
        try:
            result = asyncio.run(semantic_memory.verify(context))
        finally:
            semantic_memory.llm.chat_stream = original_stream
        assert result["verdict"] == "conflict" and result["confidence"] == 0.94
        assert result["conflicts"] == [{"memory_id": existing_id, "reason": "제출 시점 불일치"}]
        saved = memory.save_candidate_semantic_check(candidate_id, result)
        assert saved["verdict"] == "conflict"
        listed = memory.list_memory_candidates("pending", "semantic_test")[0]
        assert listed["semantic_check"]["confidence"] == 0.94
        held = memory.review_memory_candidate(candidate_id, approve=True)
        assert held["status"] == "conflict"
        approved = memory.review_memory_candidate(
            candidate_id, approve=True, force=True,
            review_reason="의미 충돌과 적용 조건을 수동 검토 완료",
        )
        assert approved["status"] == "approved"

    print("semantic memory tests: PASS")


if __name__ == "__main__":
    main()
