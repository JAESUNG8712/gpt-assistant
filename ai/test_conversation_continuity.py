"""후속 질문(대명사·생략) 검색 시 대화 맥락 활용 회귀 테스트.

"그거 더 자세히" 같은 후속 질문은 원문 그대로 KB를 검색하면 아무 것도 찾지
못한다 — intent_agent.analyze()에 최근 대화(history)를 함께 넘겨 이전 대화
주제로 검색어를 구체화하도록 한 변경을 검증한다.
"""
import asyncio
import os
import sys
import tempfile
import types

AI_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI_DIR)


def _unit_tests():
    import intent_agent

    # 1) history가 없으면 프롬프트에 [최근 대화] 블록이 없다 (기존 동작 불변)
    captured = {}

    async def fake_no_history(messages, **_kw):
        captured["prompt"] = messages[0]["content"]
        yield '{"intent": "일반 질문", "refined_query": "원본 질문", "keywords": ["a"], "answer_guide": ""}'

    import llm
    original_stream = llm.chat_stream
    original_has_provider = llm.has_llm_provider
    # 아래 시나리오들은 모두 "LLM이 있고 이런 응답을 준다"를 검증하려는 것이므로,
    # 실행 환경의 실제 API 키 유무와 무관하게 LLM 경로를 타도록 고정한다(그렇지
    # 않으면 LLM이 아예 없다고 판단해 이 모킹을 호출하지 않고 곧장 원본 질문
    # 그대로/결정형 후속질문 폴백을 반환할 수 있음).
    llm.has_llm_provider = lambda: True
    llm.chat_stream = fake_no_history
    try:
        result = asyncio.run(intent_agent.analyze("원본 질문입니다", "hr"))
        assert "[최근 대화]" not in captured["prompt"]
        assert result["ok"] is True

        # 2) history를 주면 프롬프트에 포함되고, 대화 주제를 반영한 refined_query가 그대로 전달된다
        history = [
            {"role": "user", "content": "연차촉진제란 무엇인가요"},
            {"role": "assistant", "content": "연차유급휴가 사용촉진 제도는 ..."},
        ]

        async def fake_with_history(messages, **_kw):
            captured["prompt"] = messages[0]["content"]
            yield '{"intent": "연차 촉진제 상세 설명 요청", "refined_query": "연차유급휴가 사용촉진 제도 상세", "keywords": ["연차촉진제"], "answer_guide": ""}'

        llm.chat_stream = fake_with_history
        result2 = asyncio.run(intent_agent.analyze("그거 더 자세히", "hr", history=history))
        assert "[최근 대화]" in captured["prompt"]
        assert "연차촉진제" in captured["prompt"]
        assert result2["refined_query"] == "연차유급휴가 사용촉진 제도 상세"

        # 3) history가 5개 이상이어도 최근 4개까지만 포함 (프롬프트 비대화 방지)
        long_history = [{"role": "user", "content": f"메시지{i}"} for i in range(10)]

        async def fake_long_history(messages, **_kw):
            captured["prompt"] = messages[0]["content"]
            yield '{"refined_query": "무관"}'

        llm.chat_stream = fake_long_history
        asyncio.run(intent_agent.analyze("아무 질문", "hr", history=long_history))
        assert "메시지9" in captured["prompt"]
        assert "메시지5" not in captured["prompt"]  # 뒤 4개(6,7,8,9)만 포함
    finally:
        llm.chat_stream = original_stream
        llm.has_llm_provider = original_has_provider

    print("conversation continuity unit tests: PASS")


def _integration_tests():
    app_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(app_dir)

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "continuity.db")
        os.environ["MPLCONFIGDIR"] = os.path.join(tmp, "matplotlib")
        os.environ["BACKUP_TOKEN"] = "test-owner-token"
        os.environ.pop("ANTHROPIC_API_KEY", None)
        os.environ.pop("GROQ_API_KEY", None)

        from fastapi.testclient import TestClient
        from fastapi import APIRouter

        stock_api_stub = types.ModuleType("stock_analysis.stock_api")
        stock_api_stub.router = APIRouter()
        sys.modules["stock_analysis.stock_api"] = stock_api_stub
        import main

        client = TestClient(main.app)
        headers = {"X-Admin-Token": "test-owner-token"}

        analyze_calls = []
        original_analyze = main.intent_agent.analyze
        original_chat_stream = main.llm.chat_stream
        original_web_search = main.srch.web_search

        async def recording_analyze(user_msg, persona_id="hr", history=None):
            analyze_calls.append({"message": user_msg, "history": history or []})
            return {"ok": False, "intent": "", "refined_query": user_msg, "keywords": [], "answer_guide": ""}

        async def fake_stream(*_a, **_kw):
            yield "테스트 응답입니다."

        main.intent_agent.analyze = recording_analyze
        main.llm.chat_stream = fake_stream
        main.srch.web_search = lambda *_a, **_kw: []
        try:
            # 1턴: 새 세션이므로 history가 비어 있어야 함
            first = client.post(
                "/chat", headers=headers,
                json={"message": "연차촉진제란 무엇인가요 실제로 궁금합니다", "persona": "hr", "session_id": "continuity-a"},
            )
            assert first.status_code == 200
            assert len(analyze_calls) == 1
            assert analyze_calls[0]["history"] == []

            # 2턴: 같은 세션의 후속 질문 — intent_agent가 1턴 내용을 history로 받아야 함
            second = client.post(
                "/chat", headers=headers,
                json={"message": "그거 더 자세히 설명해주세요", "persona": "hr", "session_id": "continuity-a"},
            )
            assert second.status_code == 200
            assert len(analyze_calls) == 2
            history_texts = " ".join(m["content"] for m in analyze_calls[1]["history"])
            assert "연차촉진제" in history_texts

            # 3턴: 다른 세션 ID는 별개 대화이므로 이전 세션의 history가 섞이면 안 됨
            third = client.post(
                "/chat", headers=headers,
                json={"message": "완전히 새로운 질문입니다 아무 관련 없음", "persona": "hr", "session_id": "continuity-b"},
            )
            assert third.status_code == 200
            assert len(analyze_calls) == 3
            assert analyze_calls[2]["history"] == []
        finally:
            main.intent_agent.analyze = original_analyze
            main.llm.chat_stream = original_chat_stream
            main.srch.web_search = original_web_search

    print("conversation continuity integration tests: PASS")


def main_():
    _unit_tests()
    _integration_tests()


if __name__ == "__main__":
    main_()
