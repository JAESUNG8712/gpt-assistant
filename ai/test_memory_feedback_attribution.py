"""검색에 실제 사용된 기억과 사용자 피드백의 안전한 귀속 회귀 테스트."""

import os
import tempfile


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "feedback-attribution.db")
        os.environ["MEMORY_TELEMETRY_SALT"] = "test-only-telemetry-secret"

        import memory
        import engine

        memory._seed_static_kb_to_db = lambda: None
        memory.init_db()
        question = "qz-utility 연차 승인 절차"
        memory.upsert_knowledge(
            question, "연차는 결재 상신 후 승인됩니다.", "utility_test",
            source="승인학습", memory_type="procedure", memory_scope="persona",
        )
        engine.reload_engine()
        result = memory.retrieve_best(
            question, persona_id="utility_test", session_scope="owner:browser-a"
        )
        assert result["context_memory_ids"]
        memory_id = result["context_memory_ids"][0]

        memory.record_retrieval_event(
            question, "utility_test", "owner", "승인학습", result["best_score"],
            1, True, "kb_direct", result["context_memory_ids"], "owner:browser-a",
        )
        assert memory.attribute_feedback_to_memories(
            question, "auto", "owner:browser-b", 1
        )["attributed"] is False
        attributed = memory.attribute_feedback_to_memories(
            question, "auto", "owner:browser-a", 1
        )
        assert attributed["memory_ids"] == [memory_id]
        assert attributed["boosts"][memory_id] == 1.2
        assert attributed["persona"] == "utility_test"
        assert memory.attribute_feedback_to_memories(
            question, "utility_test", "owner:browser-a", 1
        )["attributed"] is False

        with memory._conn() as c:
            item = dict(c.execute(
                "SELECT retrieved_count,helpful_count,harmful_count,utility_boost,last_used_at"
                " FROM learned_knowledge WHERE id=?", (memory_id,),
            ).fetchone())
            event = dict(c.execute(
                "SELECT query_hash,session_hash,memory_ids_json,feedback_rating"
                " FROM memory_retrieval_events ORDER BY id DESC LIMIT 1"
            ).fetchone())
        assert item["retrieved_count"] == 1 and item["helpful_count"] == 1
        assert item["harmful_count"] == 0 and item["utility_boost"] == 1.2
        assert item["last_used_at"]
        assert len(event["query_hash"]) == 64 and len(event["session_hash"]) == 64
        assert question not in str(event) and "owner:browser-a" not in str(event)
        assert event["feedback_rating"] == 1
        engine.set_memory_utility_boost(memory_id, attributed["boosts"][memory_id])
        assert engine._memory_utility_boost_for({"memory_id": memory_id}) == 1.2

        effectiveness = memory.list_memory_effectiveness()
        assert effectiveness[0]["id"] == memory_id
        assert effectiveness[0]["retrieved_count"] == 1

        # 공유 검색 이벤트에는 같은 질문이어도 소유자 피드백을 귀속하지 않는다.
        memory.record_retrieval_event(
            "공유 전용 질문", "utility_test", "share", "승인학습", 0.5,
            1, True, "kb_direct", [memory_id], "share:token:visitor",
        )
        assert memory.attribute_feedback_to_memories(
            "공유 전용 질문", "utility_test", "share:token:visitor", -1
        )["attributed"] is False

    print("memory feedback attribution tests: PASS")


if __name__ == "__main__":
    main()
