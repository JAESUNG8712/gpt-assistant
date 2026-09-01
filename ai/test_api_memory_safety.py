"""FastAPI 수준 기억·세션 보안 회귀 테스트 (외부 API 호출 없음)."""
import os
import sys
import tempfile
import types


def main():
    app_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(app_dir)

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "api-memory.db")
        os.environ["MPLCONFIGDIR"] = os.path.join(tmp, "matplotlib")
        os.environ["BACKUP_TOKEN"] = "test-owner-token"
        os.environ.pop("ANTHROPIC_API_KEY", None)
        os.environ.pop("GROQ_API_KEY", None)

        from fastapi.testclient import TestClient
        from fastapi import APIRouter

        # 이 테스트는 기억·인증 API만 검증한다. 주식 라우터의 대형 외부 데이터
        # 의존성(pykrx 등)을 로드하지 않아도 동일한 main 앱 경로를 테스트할 수
        # 있도록 빈 라우터로 격리한다.
        stock_api_stub = types.ModuleType("stock_analysis.stock_api")
        stock_api_stub.router = APIRouter()
        sys.modules["stock_analysis.stock_api"] = stock_api_stub
        import main

        client = TestClient(main.app)
        owner_token = "test-owner-token"

        # 소유자 데이터 API와 일반 채팅은 인증 없이는 열리지 않아야 한다.
        assert client.get("/history").status_code == 401
        assert client.get("/admin/memory-candidates").status_code == 401
        assert client.get("/admin/memory-revalidation").status_code == 401
        assert client.get("/admin/memory-observability").status_code == 401
        assert client.post("/admin/memory-retention").status_code == 401
        assert client.post(
            "/learn/text",
            json={"question": "테스트 질문", "answer": "테스트 답변", "persona": "hr"},
        ).status_code == 401
        assert client.post(
            "/chat", json={"message": "인증 없는 질문", "persona": "company"}
        ).status_code == 401

        # 고위험 비밀값은 관리자가 직접 입력해도 장기지식으로 저장하지 않는다.
        secret_learn = client.post(
            "/learn/text",
            params={"token": owner_token},
            json={
                "question": "API 키를 기억해줘",
                "answer": "키는 sk-abcdefghijklmnop1234 입니다.",
                "persona": "dev",
            },
        )
        assert secret_learn.status_code == 400

        # 관측 통계와 보존정책은 인증 후 조회 가능하되 실제 정리는 확인문구 필수.
        assert client.get(
            "/admin/memory-observability", params={"token": owner_token}
        ).status_code == 200
        retention_preview = client.post(
            "/admin/memory-retention", params={"token": owner_token}
        )
        assert retention_preview.status_code == 200
        assert retention_preview.json()["apply"] is False
        assert client.post(
            "/admin/memory-retention",
            params={"token": owner_token, "apply": "true"},
        ).status_code == 400

        # 만료 기억 재검증 API는 인증 후 근거와 새 유효기간을 갱신한다.
        from datetime import datetime, timedelta
        main.mem.upsert_knowledge(
            "API 재검증 질문 qzxv", "API 재검증 대상 답변입니다.", "dev",
            source="승인학습",
            valid_until=(datetime.now() - timedelta(days=1)).isoformat(),
        )
        due_response = client.get(
            "/admin/memory-revalidation",
            params={"token": owner_token, "persona": "dev", "days": 30},
        )
        assert due_response.status_code == 200
        due_item = next(
            item for item in due_response.json()["items"]
            if "API 재검증 질문 qzxv" in item["content_preview"]
        )
        verify_response = client.post(
            f"/admin/learned/{due_item['id']}/verify",
            params={"token": owner_token},
            json={
                "valid_days": 45,
                "evidence": [{"title": "관리자 검증", "url": "https://example.com/api-verify"}],
                "confirm_current": True,
                "verification_note": "관리자가 공식 근거와 대조 완료",
                "expected_version": due_item["version"],
            },
        )
        assert verify_response.status_code == 200
        assert verify_response.json()["item"]["evidence"][0]["title"] == "관리자 검증"
        history_response = client.get(
            f"/admin/learned/{due_item['id']}/history", params={"token": owner_token}
        )
        assert history_response.status_code == 200
        assert history_response.json()["current"]["version"] == 2
        rollback_response = client.post(
            f"/admin/learned/{due_item['id']}/rollback",
            params={"token": owner_token},
            json={"target_version": 1, "expected_version": 2, "reason": "API 롤백 검증"},
        )
        assert rollback_response.status_code == 200
        stale_rollback = client.post(
            f"/admin/learned/{due_item['id']}/rollback",
            params={"token": owner_token},
            json={"target_version": 1, "expected_version": 2, "reason": "오래된 요청"},
        )
        assert stale_rollback.status_code == 409
        assert client.get(
            "/admin/memory-revalidation/events", params={"token": owner_token}
        ).json()["items"][0]["status"] == "verified"

        # 자동 재검증은 허용 목록의 공공 출처만 실제 수집기로 위임한다.
        assert client.post(
            "/admin/memory-revalidation/authoritative",
            params={"token": owner_token, "source": "https://internal.invalid"},
        ).status_code == 400
        original_law_refresh = main.admin_refresh_law_cache
        main.admin_refresh_law_cache = lambda token="": {"fetched": 17, "errors": []}
        try:
            refreshed = client.post(
                "/admin/memory-revalidation/authoritative",
                params={"token": owner_token, "source": "law.go.kr"},
            )
            assert refreshed.status_code == 200
            assert refreshed.json()["fetched"] == 17
        finally:
            main.admin_refresh_law_cache = original_law_refresh

        # 모순 후보는 409로 중단되고 force=true인 명시 승인만 승격한다.
        main.mem.upsert_knowledge(
            "API 충돌 기간은 며칠인가요?", "API 충돌 기간은 30일입니다.",
            "company", source="승인학습",
        )
        conflict_id = main.mem.store_memory_candidate(
            "API 충돌 기간은 며칠인가요?", "API 충돌 기간은 새 기준에서 60일입니다.",
            "company", source="생성답변",
        )
        conflict_response = client.post(
            f"/admin/memory-candidates/{conflict_id}/approve",
            params={"token": owner_token},
        )
        assert conflict_response.status_code == 409
        assert conflict_response.json()["detail"]["code"] == "memory_conflict"
        forced_response = client.post(
            f"/admin/memory-candidates/{conflict_id}/approve",
            params={"token": owner_token, "force": "true", "reason": "충돌 근거 검토 완료"},
        )
        assert forced_response.status_code == 200
        assert forced_response.json()["status"] == "approved"

        semantic_id = main.mem.store_memory_candidate(
            "API 의미 검증 휴가 통보 시점은 언제인가요?",
            "API 의미 검증 답변은 휴가 당일 통보가 가능하다고 안내합니다.",
            "dev", source="생성답변",
        )
        original_semantic_verify = main.semantic_memory.verify

        async def fake_semantic_verify(_context):
            return {
                "verdict": "uncertain", "confidence": 0.82,
                "summary": "적용 시점 조건을 추가 확인해야 합니다.", "conflicts": [],
            }

        main.semantic_memory.verify = fake_semantic_verify
        try:
            semantic_response = client.post(
                f"/admin/memory-candidates/{semantic_id}/semantic-check",
                params={"token": owner_token},
            )
            assert semantic_response.status_code == 200
            assert semantic_response.json()["result"]["verdict"] == "uncertain"
        finally:
            main.semantic_memory.verify = original_semantic_verify
        assert main.mem.review_memory_candidate(semantic_id, approve=False)["status"] == "rejected"

        # 공유 링크는 허용된 페르소나만 사용할 수 있고 소유자 이력 API 권한은 없다.
        share = main.mem.create_share_link("API QA", ["company"], "")
        share_payload = {
            "message": "공유 세션만의 무작위 질문 qzxv-91827",
            "persona": "company",
            "share_token": share["token"],
            "session_id": "browser-shared",
        }
        denied = client.post("/chat", json={**share_payload, "persona": "hr"})
        assert denied.status_code == 403
        shared_response = client.post("/chat", json=share_payload)
        assert shared_response.status_code == 200
        assert "현재 등록된 규정" in shared_response.text
        assert client.get("/history", params={"session_id": "browser-shared"}).status_code == 401

        share_scope = main._share_session_scope(share["token"], "browser-shared")
        shared_history = main.mem.get_history(
            10, persona="company", session_id=share_scope
        )
        assert len(shared_history) == 2
        assert main.mem.list_memory_candidates("pending") == []

        # 같은 브라우저 표식이어도 소유자와 공유 세션은 별도 범위에 저장된다.
        owner_payload = {
            "message": "소유자 세션만의 무작위 질문 qzxv-48210",
            "persona": "company",
            "session_id": "browser-shared",
        }
        owner_response = client.post(
            "/chat", json=owner_payload, headers={"X-Admin-Token": owner_token}
        )
        assert owner_response.status_code == 200
        owner_history_response = client.get(
            "/history",
            params={"session_id": "browser-shared", "persona": "company", "token": owner_token},
        )
        assert owner_history_response.status_code == 200
        owner_history = owner_history_response.json()["history"]
        assert len(owner_history) == 2
        assert all("공유 세션만의" not in row["content"] for row in owner_history)
        assert main.mem.list_memory_candidates("pending") == []

        # 공유 채팅의 웹검색은 답변 근거로만 쓰고 원문/합성답변을 DB에 학습하지 않는다.
        search_share = main.mem.create_share_link("검색 QA", ["hr"], "")
        original_web_search = main.srch.web_search
        original_intent = main.intent_agent.analyze
        original_chat_stream = main.llm.chat_stream

        async def no_intent(*_args, **_kwargs):
            return {"ok": False, "intent": "", "refined_query": "", "keywords": [], "answer_guide": ""}

        async def fake_stream(*_args, **_kwargs):
            yield "공유 검색 질문에 대한 검증용 합성 답변입니다. 검색 자료는 답변에만 사용합니다."

        main.srch.web_search = lambda *_args, **_kwargs: [{
            "title": "검증 검색 결과", "body": "공유 검색 테스트용 본문", "url": "https://example.com/test"
        }]
        main.intent_agent.analyze = no_intent
        main.llm.chat_stream = fake_stream
        try:
            with main.mem._conn() as c:
                web_rows_before = c.execute(
                    "SELECT COUNT(*) FROM learned_knowledge WHERE source LIKE '웹검색:%'"
                ).fetchone()[0]
            searched = client.post("/chat", json={
                "message": "공유 웹검색 무작위 질문 qzxv-59284",
                "persona": "hr",
                "share_token": search_share["token"],
                "session_id": "browser-search",
            })
            assert searched.status_code == 200
            assert "검증용 합성 답변" in searched.text
            with main.mem._conn() as c:
                web_rows_after = c.execute(
                    "SELECT COUNT(*) FROM learned_knowledge WHERE source LIKE '웹검색:%'"
                ).fetchone()[0]
            assert web_rows_after == web_rows_before
            assert main.mem.list_memory_candidates("pending") == []
        finally:
            main.srch.web_search = original_web_search
            main.intent_agent.analyze = original_intent
            main.llm.chat_stream = original_chat_stream

        # 완전일치 정리도 페르소나를 넘지 않고 신뢰 출처를 남긴 뒤 격리해야 한다.
        duplicate_content = "Q: 격리 API 테스트 qzxv-731\nA: 동일한 테스트 답변"
        with main.mem._conn() as c:
            c.executemany(
                "INSERT INTO learned_knowledge(content,persona,source,created_at)"
                " VALUES (?,?,?,?)",
                [
                    (duplicate_content, "hr", "직접입력", "2026-08-31T00:00:00"),
                    (duplicate_content, "hr", "자동학습", "2026-08-31T00:01:00"),
                    (duplicate_content, "dev", "직접입력", "2026-08-31T00:02:00"),
                ],
            )
        preview = client.get(
            "/admin/learned/duplicates", params={"token": owner_token}
        ).json()
        assert preview["duplicate_rows_to_remove"] == 1
        applied = client.get(
            "/admin/learned/duplicates",
            params={"token": owner_token, "apply": "true"},
        )
        assert applied.status_code == 200
        assert applied.json()["quarantined"] == 1
        quarantined = client.get(
            "/admin/memory-quarantine", params={"token": owner_token}
        ).json()["items"]
        assert len(quarantined) == 1
        restored = client.post(
            f"/admin/memory-quarantine/{quarantined[0]['id']}/restore",
            params={"token": owner_token},
        )
        assert restored.status_code == 200

    print("API memory safety tests: PASS")


if __name__ == "__main__":
    main()
