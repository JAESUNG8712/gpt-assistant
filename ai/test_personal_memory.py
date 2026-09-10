"""채팅 기반 개인 기억 저장·조회·삭제 안전성 회귀 테스트."""
import os
import tempfile


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "personal-memory.db")

        import memory
        import personal_memory

        memory._seed_static_kb_to_db = lambda: None
        memory.init_db()

        saved = personal_memory.execute("save", "답변은 핵심부터 짧게 해줘")
        assert "기억했습니다" in saved
        listed = personal_memory.execute("list")
        assert "답변은 핵심부터 짧게 해줘" in listed

        with memory._conn() as conn:
            row = dict(conn.execute(
                "SELECT * FROM learned_knowledge WHERE source='개인기억'"
            ).fetchone())
        assert row["persona"] == ""
        assert row["memory_scope"] == "owner"
        assert row["memory_type"] == "preference"

        updated = personal_memory.execute("save", "이제 답변은 자세히 설명해줘")
        assert "갱신했습니다" in updated
        memories = personal_memory.list_memories()
        assert len(memories) == 1
        assert memories[0]["value"] == "이제 답변은 자세히 설명해줘"
        history = memory.get_memory_history(memories[0]["id"])
        assert len(history["revisions"]) == 1
        assert "핵심부터 짧게" in history["revisions"][0]["content"]

        blocked = personal_memory.execute("save", "내 이메일은 owner@example.com")
        assert "기억하지 않았습니다" in blocked and "이메일" in blocked
        short_secret = personal_memory.execute("save", "내 비밀번호는 1234")
        assert "기억하지 않았습니다" in short_secret and "비밀번호" in short_secret
        assert len(personal_memory.list_memories()) == 1

        shared = personal_memory.execute("list", is_shared=True)
        assert "공유 대화" in shared

        deleted = personal_memory.execute("forget", "자세히")
        assert "삭제했습니다" in deleted
        assert personal_memory.list_memories() == []
        assert memory.list_quarantined_memories()[0]["source"] == "개인기억"

    print("personal memory tests: PASS")


if __name__ == "__main__":
    main()
