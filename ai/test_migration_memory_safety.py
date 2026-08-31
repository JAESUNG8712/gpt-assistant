"""구버전 DB를 빈 목적지에 복원할 때 기억 안전 스키마가 보존되는지 검증."""
import os
import sqlite3
import tempfile


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        src_path = os.path.join(tmp, "legacy.db")
        dest_path = os.path.join(tmp, "restored.db")
        with sqlite3.connect(src_path) as c:
            c.execute("""CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL, content TEXT NOT NULL,
                persona TEXT DEFAULT 'hr', created_at TEXT NOT NULL
            )""")
            c.execute(
                "INSERT INTO conversations(role,content,persona,created_at) VALUES (?,?,?,?)",
                ("user", "구버전 대화", "hr", "2026-08-31T00:00:00"),
            )
            c.execute("""CREATE TABLE learned_knowledge (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL, persona TEXT DEFAULT '',
                source TEXT DEFAULT '', created_at TEXT NOT NULL
            )""")
            c.execute(
                "INSERT INTO learned_knowledge(content,persona,source,created_at)"
                " VALUES (?,?,?,?)",
                ("Q: 구버전 질문\nA: 구버전 답변", "hr", "직접입력", "2026-08-31T00:00:00"),
            )

        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = dest_path

        import memory
        import migrate_to_turso

        memory._seed_static_kb_to_db = lambda: None
        stats = migrate_to_turso.migrate(src_path)
        assert stats["conversations"]["inserted"] == 1
        assert stats["learned_knowledge"]["inserted"] == 1

        with sqlite3.connect(dest_path) as c:
            conversation_cols = {
                row[1] for row in c.execute("PRAGMA table_info(conversations)")
            }
            learned_cols = {
                row[1] for row in c.execute("PRAGMA table_info(learned_knowledge)")
            }
            candidate_cols = {
                row[1] for row in c.execute("PRAGMA table_info(memory_candidates)")
            }
            quarantine_cols = {
                row[1] for row in c.execute("PRAGMA table_info(memory_quarantine)")
            }
            tables = {
                row[0] for row in c.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            restored_scope = c.execute(
                "SELECT session_id FROM conversations LIMIT 1"
            ).fetchone()[0]
        assert "session_id" in conversation_cols
        assert {"evidence_json", "verified_at", "valid_until", "version", "updated_at"} <= learned_cols
        assert {"evidence_json", "verified_at", "valid_until", "reviewed_by",
                "review_reason", "review_nonce"} <= candidate_cols
        assert {"evidence_json", "original_verified_at", "original_valid_until",
                "original_version", "original_updated_at"} <= quarantine_cols
        assert {"memory_candidates", "memory_quarantine", "memory_retrieval_events"} <= tables
        assert "memory_revalidation_events" in tables
        assert "memory_revisions" in tables
        assert restored_scope == "legacy"

    print("migration memory safety tests: PASS")


if __name__ == "__main__":
    main()
