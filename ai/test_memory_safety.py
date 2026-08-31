"""기억 안전성 회귀 테스트 — 외부 API 없이 임시 SQLite에서 실행."""
import os
import sqlite3
import tempfile


def main():
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "memory.db")
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = db_path

        # 구버전 conversations 스키마를 먼저 만들어 ADD COLUMN 무손실 마이그레이션 검증.
        with sqlite3.connect(db_path) as c:
            c.execute("""CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                persona TEXT DEFAULT 'hr',
                created_at TEXT NOT NULL
            )""")

        import memory
        memory._seed_static_kb_to_db = lambda: None
        memory.init_db()

        with sqlite3.connect(db_path) as c:
            columns = {r[1] for r in c.execute("PRAGMA table_info(conversations)")}
        assert "session_id" in columns

        # 소유자/공유 세션 간 대화가 섞이지 않아야 한다.
        memory.save_message("user", "소유자 질문", "hr", "owner:browser-a")
        memory.save_message("assistant", "소유자 답변", "hr", "owner:browser-a")
        memory.save_message("user", "공유 질문", "hr", "share:token-x:browser-a")
        owner = memory.get_recent_messages(10, "hr", "owner:browser-a")
        shared = memory.get_recent_messages(10, "hr", "share:token-x:browser-a")
        assert [m["content"] for m in owner] == ["소유자 질문", "소유자 답변"]
        assert [m["content"] for m in shared] == ["공유 질문"]

        # 자동응답은 즉시 장기기억이 아니라 승인 대기 후보로만 저장된다.
        question = "연차휴가 신청 절차를 자세히 알려주세요"
        answer = "연차휴가 신청은 회사 규정과 승인 절차를 먼저 확인해야 합니다. " * 4
        candidate_id = memory.auto_learn(question, answer, "hr", "owner:browser-a")
        assert candidate_id
        with memory._conn() as c:
            learned_before = c.execute(
                "SELECT COUNT(*) FROM learned_knowledge WHERE source='승인학습'"
            ).fetchone()[0]
        assert learned_before == 0
        pending_items = memory.list_memory_candidates("pending")
        assert len(pending_items) == 1
        assert 0 <= pending_items[0]["quality_score"] <= 1
        assert isinstance(pending_items[0]["quality_flags"], list)
        volatile_score = memory.score_memory_candidate(
            "최신 법령 내용을 알려주세요",
            "관련 내용은 추정이며 자료에서 확인되지 않아 별도 확인 필요합니다.",
            "법령실시간",
        )
        assert "시점에 따라 바뀔 수 있음" in volatile_score["quality_flags"]
        assert "불확실성 표현 포함" in volatile_score["quality_flags"]

        reviewed = memory.review_memory_candidate(candidate_id, approve=True)
        assert reviewed and reviewed["status"] == "approved"
        with memory._conn() as c:
            approved = c.execute(
                "SELECT COUNT(*) FROM learned_knowledge WHERE source='승인학습'"
            ).fetchone()[0]
        assert approved == 1

        # 승인 후보는 같은 질문의 직접입력/문서/정적 지식을 자동 덮어쓰면 안 된다.
        protected_q = "보호된 사내 절차는 어떻게 처리하나요"
        memory.upsert_knowledge(protected_q, "관리자가 직접 검증한 기존 답변", "hr")
        protected_id = memory.store_memory_candidate(
            protected_q,
            "자동 응답으로 생성된 새로운 답변이며 충분히 길지만 직접입력을 덮어쓰면 안 됩니다. " * 2,
            "hr",
            "owner:browser-a",
        )
        protected_result = memory.review_memory_candidate(protected_id, approve=True)
        assert protected_result and protected_result["status"] == "protected"
        with memory._conn() as c:
            protected_content = c.execute(
                "SELECT content FROM learned_knowledge"
                " WHERE persona='hr' AND source='직접입력' ORDER BY id DESC LIMIT 1"
            ).fetchone()[0]
        assert "관리자가 직접 검증한 기존 답변" in protected_content
        assert memory.review_memory_candidate(protected_id, approve=False)["status"] == "rejected"

        # 격리는 삭제가 아니라 복구 가능한 이동이어야 한다.
        with memory._conn() as c:
            row = dict(c.execute(
                "SELECT id, content, persona, source, created_at FROM learned_knowledge"
                " WHERE source='승인학습' LIMIT 1"
            ).fetchone())
        assert memory.quarantine_learned_rows([row], "테스트 격리") == 1
        assert memory.quarantine_learned_rows([row], "테스트 재시도") == 1
        assert len(memory.list_quarantined_memories()) == 1
        with memory._conn() as c:
            assert c.execute(
                "SELECT COUNT(*) FROM learned_knowledge WHERE id=?", (row["id"],)
            ).fetchone()[0] == 0
        quarantine_id = memory.list_quarantined_memories()[0]["id"]
        assert memory.restore_quarantined_memory(quarantine_id)
        assert memory.restore_quarantined_memory(quarantine_id) is None
        assert memory.list_quarantined_memories() == []
        with memory._conn() as c:
            assert c.execute(
                "SELECT COUNT(*) FROM learned_knowledge WHERE source='승인학습'"
            ).fetchone()[0] == 1

        stats = memory.memory_stats(session_id="owner:browser-a")
        assert stats["conversations"] == 2
        assert stats["pending_candidates"] == 0
        assert stats["quarantined_items"] == 0

        # 자동정제는 최신 자동응답보다 오래된 직접입력을 우선 보존해야 한다.
        from refine import choose_duplicate_keeper, find_duplicate_clusters
        duplicate_rows = [
            {"id": 10, "persona": "hr", "source": "직접입력",
             "content": "Q: 연차\nA: 연차 신청은 시스템에서 결재를 올립니다."},
            {"id": 99, "persona": "hr", "source": "자동학습",
             "content": "Q: 휴가\nA: 연차 신청은 시스템에서 결재를 올립니다."},
        ]
        clusters = find_duplicate_clusters(duplicate_rows, threshold=0.85)
        assert len(clusters) == 1
        assert choose_duplicate_keeper(clusters[0])["source"] == "직접입력"

    print("memory safety tests: PASS")


if __name__ == "__main__":
    main()
