"""기억 유형 분류와 owner/session 범위 격리 회귀 테스트."""

import os
import tempfile


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "memory-types.db")

        import memory
        import engine

        memory._seed_static_kb_to_db = lambda: None
        memory.init_db()
        assert memory.classify_memory_kind("나는 짧게 답변해 주는 것을 선호해요")[0] == "preference"
        assert memory.classify_memory_kind("이번 프로젝트 이름은 오로라입니다") == ("context", "session")
        assert memory.classify_memory_kind("휴가 신청 절차를 알려주세요")[0] == "procedure"

        preference_q = "qzpref 나는 답변을 짧게 받는 것을 선호해요"
        memory.upsert_knowledge(
            preference_q, "핵심부터 간결하게 답변합니다.", "scope_test",
            source="승인학습", memory_type="preference", memory_scope="owner",
        )
        with memory._conn() as c:
            preference_id = c.execute(
                "SELECT id FROM learned_knowledge WHERE content LIKE 'Q: qzpref%'"
            ).fetchone()[0]
        memory.upsert_knowledge(
            preference_q, "핵심 답변을 제공합니다.", "scope_test",
            source="승인학습", memory_type="fact", memory_scope="owner",
            expected_version=1,
        )
        history = memory.get_memory_history(preference_id)
        assert history["revisions"][0]["memory_type"] == "preference"
        memory.rollback_memory(
            preference_id, target_version=1, expected_version=2,
            reason="선호 유형 복원",
        )
        with memory._conn() as c:
            assert c.execute(
                "SELECT memory_type FROM learned_knowledge WHERE id=?", (preference_id,)
            ).fetchone()[0] == "preference"
        context_q = "qzcontext 이번 프로젝트 이름은 오로라입니다"
        memory.upsert_knowledge(
            context_q, "현재 세션의 프로젝트 명칭은 오로라입니다.", "scope_test",
            source="승인학습", memory_type="context", memory_scope="session",
            session_id="owner:browser-a",
        )
        engine.reload_engine()

        assert memory.retrieve_best(
            preference_q, persona_id="scope_test", session_scope="owner:browser-a"
        )["best_score"] > 0
        assert memory.retrieve_best(
            preference_q, persona_id="scope_test", session_scope="share:abc:visitor"
        )["best_score"] == 0
        assert memory.retrieve_best(
            context_q, persona_id="scope_test", session_scope="owner:browser-a"
        )["best_score"] > 0
        assert memory.retrieve_best(
            context_q, persona_id="scope_test", session_scope="owner:browser-b"
        )["best_score"] == 0

        preferences = memory.list_owner_preferences("scope_test")
        assert len(preferences) == 1 and "qzpref" in preferences[0]["content"]

        candidate_id = memory.store_memory_candidate(
            "이번 대화에서 사용할 코드명은 제타입니다",
            "이번 대화 범위에서 코드명을 제타로 기억합니다.",
            "scope_test", session_id="owner:browser-a", source="생성답변",
        )
        candidate = memory.list_memory_candidates("pending", "scope_test")[0]
        assert candidate["id"] == candidate_id
        assert candidate["memory_type"] == "context" and candidate["memory_scope"] == "session"
        approved = memory.review_memory_candidate(candidate_id, approve=True)
        assert approved["status"] == "approved"

        with memory._conn() as c:
            row = dict(c.execute(
                "SELECT id,memory_type,memory_scope,session_id FROM learned_knowledge"
                " WHERE content LIKE 'Q: 이번 대화%'"
            ).fetchone())
        assert row["memory_type"] == "context"
        assert row["memory_scope"] == "session" and row["session_id"] == "owner:browser-a"

        memory.quarantine_learned_rows([row], "scope preservation")
        quarantined = memory.list_quarantined_memories()[0]
        assert quarantined["original_memory_scope"] == "session"
        memory.restore_quarantined_memory(quarantined["id"])
        with memory._conn() as c:
            restored = dict(c.execute(
                "SELECT memory_type,memory_scope,session_id FROM learned_knowledge WHERE id=?",
                (row["id"],),
            ).fetchone())
        assert restored == {
            "memory_type": "context", "memory_scope": "session",
            "session_id": "owner:browser-a",
        }

    print("memory type/scope tests: PASS")


if __name__ == "__main__":
    main()
