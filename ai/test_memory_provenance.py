"""기억 출처·유효기간·충돌 검토·재검증 회귀 테스트."""
import os
import tempfile
from datetime import datetime, timedelta


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "provenance.db")

        import memory

        memory._seed_static_kb_to_db = lambda: None
        memory.init_db()

        # 후보는 답변을 만든 외부 근거와 출처별 유효기간을 함께 가진다.
        candidate_id = memory.store_memory_candidate(
            "프로젝트 보존 기간은 며칠인가요?",
            "프로젝트 보존 기간은 내부 운영 기준에 따라 45일이며 이후 안전하게 삭제합니다.",
            "company", source="웹검색보강",
            evidence=[{"title": "운영 기준", "url": "https://example.com/policy", "type": "web"}],
        )
        candidate = memory.list_memory_candidates("pending", "company")[0]
        assert candidate["id"] == candidate_id
        assert candidate["evidence"][0]["url"] == "https://example.com/policy"
        assert candidate["verified_at"] and candidate["valid_until"]

        # 같은 질문의 수치가 바뀌면 일반 승인을 중단하고 명시적 강제 승인만 허용한다.
        memory.upsert_knowledge(
            "프로젝트 보존 기간은 며칠인가요?",
            "프로젝트 보존 기간은 현재 30일입니다.",
            "company", source="승인학습",
            evidence=[{"title": "기존 운영 기준", "type": "review"}],
        )
        conflicts = memory.find_memory_contradictions(
            candidate["question"], candidate["answer"], "company"
        )
        assert conflicts and any("수치가 다름" in r for r in conflicts[0]["reasons"])
        held = memory.review_memory_candidate(candidate_id, approve=True)
        assert held["status"] == "conflict"
        with memory._conn() as c:
            assert c.execute(
                "SELECT status FROM memory_candidates WHERE id=?", (candidate_id,)
            ).fetchone()[0] == "pending"
        approved = memory.review_memory_candidate(candidate_id, approve=True, force=True)
        assert approved["status"] == "approved"

        # 직접입력·문서·정적 KB는 강제 플래그로도 자동 덮어쓰지 못한다.
        memory.upsert_knowledge(
            "보호 정책 질문 qzxv는 무엇인가요?", "보호 정책의 직접 검증 답변입니다.",
            "company", source="직접입력",
        )
        protected_id = memory.store_memory_candidate(
            "보호 정책 질문 qzxv는 무엇인가요?", "보호 정책의 자동 생성 대체 답변입니다. " * 4,
            "company", source="생성답변",
        )
        protected = memory.review_memory_candidate(protected_id, approve=True, force=True)
        assert protected["status"] == "protected"

        # 만료 기억은 엔진에 존재해도 검색 답변 후보에서 제외된다.
        expired_until = (datetime.now() - timedelta(days=1)).isoformat()
        memory.upsert_knowledge(
            "만료 검색 고유어 qzxvexpiry는 무엇인가요?",
            "qzxvexpiry 만료 검색 답변은 더 이상 사용하면 안 됩니다.",
            "expiry_test", source="승인학습", valid_until=expired_until,
        )
        from engine import reload_engine
        reload_engine()
        result = memory.retrieve_best("qzxvexpiry 만료 검색", n=5, persona_id="expiry_test")
        assert result["expired_skipped"] >= 1
        assert "사용하면 안 됩니다" not in result["top_answer"]

        # 만료/임박 목록에서 찾아 재검증하면 새 유효기간과 근거가 반영된다.
        due = memory.list_memory_revalidation(days=30, persona="expiry_test")
        assert len(due) == 1 and due[0]["validity_status"] == "expired"
        memory_id = due[0]["id"]
        verified = memory.verify_learned_memory(
            memory_id, valid_days=60,
            evidence=[{"title": "재검증 문서", "url": "https://example.com/reverified"}],
        )
        assert datetime.fromisoformat(verified["valid_until"]) > datetime.now() + timedelta(days=59)
        assert memory.list_memory_revalidation(days=30, persona="expiry_test") == []

        # 격리·복구 과정에서도 출처 근거와 검증 시각·유효기간이 보존된다.
        with memory._conn() as c:
            row = dict(c.execute(
                "SELECT * FROM learned_knowledge WHERE id=?", (memory_id,)
            ).fetchone())
        assert memory.quarantine_learned_rows([row], "출처 보존 테스트") == 1
        quarantined = memory.list_quarantined_memories()[0]
        assert "재검증 문서" in quarantined["evidence_json"]
        memory.restore_quarantined_memory(quarantined["id"])
        with memory._conn() as c:
            restored = dict(c.execute(
                "SELECT evidence_json, verified_at, valid_until FROM learned_knowledge"
                " WHERE content=? AND persona=?", (row["content"], row["persona"])
            ).fetchone())
        assert restored["evidence_json"] == quarantined["evidence_json"]
        assert restored["verified_at"] == quarantined["original_verified_at"]
        assert restored["valid_until"] == quarantined["original_valid_until"]

    print("memory provenance tests: PASS")


if __name__ == "__main__":
    main()
