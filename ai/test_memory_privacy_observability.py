"""민감정보 차단·반복 후보·검색 관측·보존정책 회귀 테스트."""
import os
import tempfile


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "privacy-memory.db")
        os.environ["CONVERSATION_RETENTION_DAYS"] = "1"
        os.environ["MEMORY_CANDIDATE_PENDING_DAYS"] = "1"
        os.environ["MEMORY_CANDIDATE_HISTORY_DAYS"] = "1"
        os.environ["MEMORY_RETRIEVAL_RETENTION_DAYS"] = "1"

        import privacy
        import memory

        memory._seed_static_kb_to_db = lambda: None
        memory.init_db()

        secret_text = (
            "주민번호 900101-1234567, 카드 4111-1111-1111-1111, "
            "키 sk-abcdefghijklmnop1234, 연락 test@example.com / 010-1234-5678"
        )
        labels = privacy.sensitive_labels(secret_text)
        assert {"주민등록번호", "결제카드번호", "API키", "이메일", "전화번호"} <= set(labels)
        safe_default, default_labels = privacy.sanitize_for_storage(secret_text)
        assert "900101-1234567" not in safe_default
        assert "4111-1111-1111-1111" not in safe_default
        assert "sk-abcdefghijklmnop1234" not in safe_default
        assert "test@example.com" in safe_default  # 일반 대화의 연락처 맥락은 유지
        assert "API키" in default_labels
        safe_full, full_labels = privacy.sanitize_for_storage(secret_text, include_contact=True)
        assert "test@example.com" not in safe_full and "010-1234-5678" not in safe_full
        assert {"이메일", "전화번호"} <= set(full_labels)

        memory.save_message("user", secret_text, "hr", "owner:privacy")
        stored = memory.get_history(5, "hr", "owner:privacy")[0]["content"]
        assert "sk-abcdefghijklmnop1234" not in stored
        assert "[민감정보:API키]" in stored

        # 자동 기억 후보는 연락처만 포함해도 만들지 않는다.
        assert memory.store_memory_candidate(
            "담당자 이메일을 기억해줘 test@example.com",
            "담당자 이메일은 test@example.com입니다. 필요할 때 이 주소를 사용하세요.",
            "company",
        ) is None

        question = "연차휴가 신청 절차를 자세하게 알려주세요"
        answer = "연차휴가 신청 절차는 사내 규정 확인과 결재 상신 순서로 진행합니다. " * 4
        candidate_id = memory.auto_learn(question, answer, "hr", "owner:privacy")
        assert candidate_id
        assert memory.auto_learn(question, answer, "hr", "owner:privacy") == candidate_id
        candidate = memory.list_memory_candidates("pending")[0]
        assert candidate["seen_count"] == 2
        assert "동일 답변 반복 관찰 2회" in candidate["quality_flags"]

        memory.record_retrieval_event(
            "연차휴가 질문 원문", "hr", "owner", "직접입력", 0.42, 3, True, "kb_direct"
        )
        memory.record_retrieval_event(
            "자료 없는 질문 원문", "dev", "share", "", 0.04, 0, False, "llm_only"
        )
        observed = memory.memory_observability(7)
        assert observed["total_retrievals"] == 2
        assert observed["low_confidence"] == 1
        assert observed["context_used"] == 1
        with memory._conn() as c:
            event_rows = c.execute(
                "SELECT query_hash, session_kind FROM memory_retrieval_events ORDER BY id"
            ).fetchall()
        assert all(len(row["query_hash"]) == 64 for row in event_rows)
        assert "연차휴가 질문 원문" not in str([dict(row) for row in event_rows])
        assert {row["session_kind"] for row in event_rows} == {"owner", "share"}

        # 보존정책은 기본 미리보기이고, 확인문구 없이는 실제 적용되지 않는다.
        old = "2020-01-01T00:00:00"
        with memory._conn() as c:
            c.execute(
                "INSERT INTO conversations(role,content,persona,created_at,session_id)"
                " VALUES ('user','오래된 대화','hr',?,'owner:old')", (old,)
            )
            c.execute(
                "UPDATE memory_candidates SET created_at=?, last_seen_at=? WHERE id=?",
                (old, old, candidate_id),
            )
            c.execute(
                "INSERT INTO memory_candidates"
                " (content_hash,question,answer,persona,status,created_at,reviewed_at,seen_count,last_seen_at)"
                " VALUES ('old-rejected','과거 질문','과거 답변','hr','rejected',?,?,1,?)",
                (old, old, old),
            )
            c.execute(
                "INSERT INTO memory_retrieval_events"
                " (query_hash,persona,best_score,result_count,used_context,route,created_at)"
                " VALUES ('oldhash','hr',0,0,0,'llm_only',?)", (old,)
            )
            c.execute(
                "INSERT INTO learned_knowledge(content,persona,source,created_at)"
                " VALUES ('Q: 장기보존\nA: 승인 지식','hr','승인학습',?)", (old,)
            )

        preview = memory.memory_retention_policy()
        assert preview["apply"] is False
        assert preview["preview"]["conversations_to_delete"] >= 1
        assert preview["preview"]["pending_candidates_to_expire"] == 1
        assert preview["preview"]["reviewed_candidates_to_delete"] == 1
        try:
            memory.memory_retention_policy(apply=True)
            raise AssertionError("확인문구 없는 보존정책 적용이 허용됨")
        except ValueError:
            pass

        applied = memory.memory_retention_policy(apply=True, confirm="PURGE_EXPIRED")
        assert applied["apply"] is True
        with memory._conn() as c:
            assert c.execute(
                "SELECT COUNT(*) FROM conversations WHERE session_id='owner:old'"
            ).fetchone()[0] == 0
            assert c.execute(
                "SELECT status FROM memory_candidates WHERE id=?", (candidate_id,)
            ).fetchone()[0] == "expired"
            assert c.execute(
                "SELECT COUNT(*) FROM memory_candidates WHERE content_hash='old-rejected'"
            ).fetchone()[0] == 0
            assert c.execute(
                "SELECT COUNT(*) FROM learned_knowledge WHERE source='승인학습'"
            ).fetchone()[0] == 1

    print("memory privacy/observability tests: PASS")


if __name__ == "__main__":
    main()
