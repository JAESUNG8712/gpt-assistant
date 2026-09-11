"""KB 직접 서빙 전 LLM 답변 적합성 판정(intent_agent.judge_answer_fit) 회귀 테스트.

어휘 유사도(TF-IDF/BM25)만으로는 "표현은 비슷하지만 실제로는 다른 사안"인 근접-오답을
걸러낼 수 없다는 구조적 한계를 메우기 위해 도입한 기능. 애매한 점수 구간(KB_JUDGE_UPPER
미만)에서만 LLM에게 "이 답이 진짜 이 질문에 맞는가"를 판단시켜, 부적합하면 KB 직접
서빙 대신 LLM 재생성(kb_augmented) 경로로 안전하게 강등한다.
"""
import asyncio
import json
import os
import sys
import tempfile
import types

AI_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI_DIR)


def _unit_tests():
    import intent_agent

    # 1) LLM이 fit=true를 반환하면 그대로 True
    async def fake_true(*_a, **_kw):
        yield '{"fit": true, "reason": "동일 사안"}'

    import llm
    original_stream = llm.chat_stream
    original_has_provider = llm.has_llm_provider
    # 아래 LLM 모킹 시나리오들은 "LLM이 있고 이런 응답을 준다"는 것을 검증하려는
    # 것이므로, 실제 실행 환경에 API 키가 있는지와 무관하게 항상 LLM 경로를 타도록
    # has_llm_provider()를 True로 고정한다(그렇지 않으면 로컬 휴리스틱 경로로
    # 빠져서 이 모킹이 전혀 호출되지 않을 수 있음).
    llm.has_llm_provider = lambda: True
    llm.chat_stream = fake_true
    try:
        assert asyncio.run(intent_agent.judge_answer_fit(
            "전세 계약 갱신 거절 사유", "전세 계약 갱신 거절", "임대인은 실거주 등 정당한 사유가 있어야 거절할 수 있습니다.", "hr"
        )) is True

        # 2) LLM이 fit=false를 반환하면 False
        async def fake_false(*_a, **_kw):
            yield '{"fit": false, "reason": "다른 계약 유형"}'
        llm.chat_stream = fake_false
        assert asyncio.run(intent_agent.judge_answer_fit(
            "월세 보증금 반환 지연", "전세 보증금 반환 지연", "전세 보증금은 임대차 종료 후 지체없이 반환해야 합니다.", "hr"
        )) is False

        # 3) LLM 호출 실패/타임아웃/파싱 실패 시 보수적으로 False (fail-safe)
        async def fake_broken(*_a, **_kw):
            raise RuntimeError("모의 네트워크 오류")
            yield ""  # pragma: no cover
        llm.chat_stream = fake_broken
        assert asyncio.run(intent_agent.judge_answer_fit(
            "질문", "후보질문", "후보답변", "hr"
        )) is False

        async def fake_malformed(*_a, **_kw):
            yield "이건 JSON이 아닙니다"
        llm.chat_stream = fake_malformed
        assert asyncio.run(intent_agent.judge_answer_fit(
            "질문", "후보질문", "후보답변", "hr"
        )) is False

        # 4) 빈 질문/답변은 LLM 호출 없이 True (안전한 조기 반환)
        calls = []
        async def fake_should_not_be_called(*_a, **_kw):
            calls.append(1)
            yield '{"fit": false}'
        llm.chat_stream = fake_should_not_be_called
        assert asyncio.run(intent_agent.judge_answer_fit("질문", "q", "", "hr")) is True
        assert asyncio.run(intent_agent.judge_answer_fit("", "q", "답변", "hr")) is True
        assert not calls  # 호출 자체가 없었어야 함

        # 5) 환경변수로 비활성화하면 LLM 호출 없이 항상 True
        os.environ["ANSWER_FIT_JUDGE"] = "off"
        intent_agent.FIT_JUDGE_ENABLED = False
        try:
            assert asyncio.run(intent_agent.judge_answer_fit(
                "질문", "후보질문", "후보답변", "hr"
            )) is True
            assert not calls
        finally:
            intent_agent.FIT_JUDGE_ENABLED = True
            os.environ.pop("ANSWER_FIT_JUDGE", None)

        # 6) 실제 LLM API가 하나도 없으면 호출을 시도조차 하지 않고 로컬 휴리스틱
        # (memory.topic_overlap — 질문 핵심어가 답변에 있는지)으로 즉시 판정한다.
        # 명백히 관련 있는 매치는 fit=True, 명백히 무관한 매치는 fit=False로
        # 정확히 갈리는 것을 확인한다(둘 다 "계약"·"갱신"처럼 흔한 절차 용어만
        # 겹치는 미묘한 근접-오답까지는 이 휴리스틱이 못 잡는다는 한계가 실측으로
        # 확인되어 있음 — test_no_llm_reasoning.py 참고. 그렇다고 LLM 없이 항상
        # False로 강등하면 "연차 촉진제 기준이 뭐야"처럼 명백히 맞는 매치까지
        # 전부 불필요하게 문장 단위로 쪼개는 대가가 더 커서, 명백한 무관함만
        # 걸러내는 이 절충안을 택했다).
        llm.has_llm_provider = lambda: False
        calls.clear()
        assert asyncio.run(intent_agent.judge_answer_fit(
            "연차 촉진제 기준이 뭐야", "q", "연차 촉진제는 회사가 서면으로 통보하는 절차입니다.", "hr"
        )) is True
        assert asyncio.run(intent_agent.judge_answer_fit(
            "전세 계약 갱신 거절 사유", "q", "퇴직금은 평균임금 기준으로 계산합니다.", "hr"
        )) is False
        assert not calls  # LLM 호출 자체가 없었어야 함
    finally:
        llm.chat_stream = original_stream
        llm.has_llm_provider = original_has_provider

    print("answer_fit_judge unit tests: PASS")


def _integration_tests():
    app_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(app_dir)

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "answer-fit.db")
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

        QUESTION = "동일 사안 후보 질문"
        ANSWER = "이것은 KB에 저장된 원문 답변 본문입니다."

        def fake_retrieve_best(source):
            def _f(*_a, **_kw):
                return {
                    "context": ANSWER, "best_score": 0.20, "top_answer": ANSWER,
                    "top_question": QUESTION, "top_results": [(QUESTION, ANSWER, 0.20)],
                    "top_source": source, "top_meta": {}, "context_memory_ids": [],
                    "expired_skipped": 0,
                }
            return _f

        async def no_intent(*_a, **_kw):
            return {"ok": False, "intent": "", "refined_query": "", "keywords": [], "answer_guide": ""}

        async def fake_generated_stream(*_a, **_kw):
            yield "LLM이 새로 작성한 대체 답변입니다."

        original_retrieve_best = main.mem.retrieve_best
        original_intent = main.intent_agent.analyze
        original_judge = main.intent_agent.judge_answer_fit
        original_chat_stream = main.llm.chat_stream
        main.intent_agent.analyze = no_intent
        main.llm.chat_stream = fake_generated_stream
        try:
            # (a) 정적KB 출처 + 애매한 점수 구간 + LLM 판정 "부적합" → 직접 서빙 강등
            main.mem.retrieve_best = fake_retrieve_best("정적KB")

            async def judge_false(*_a, **_kw):
                return False
            main.intent_agent.judge_answer_fit = judge_false

            demoted = client.post(
                "/chat", headers=headers,
                json={"message": "적합성판정테스트질문A", "persona": "hr",
                      "thinking_mode": "off", "session_id": "fit-a"},
            )
            assert demoted.status_code == 200
            assert ANSWER not in demoted.text
            assert "내부 지식베이스" not in demoted.text
            assert "LLM이 새로 작성한 대체 답변" in demoted.text
            with main.mem._conn() as c:
                route_a = c.execute(
                    "SELECT route FROM memory_retrieval_events ORDER BY rowid DESC LIMIT 1"
                ).fetchone()[0]
            assert route_a == "kb_augmented", route_a

            # (b) 같은 조건이지만 LLM 판정 "적합" → 기존처럼 직접 서빙
            async def judge_true(*_a, **_kw):
                return True
            main.intent_agent.judge_answer_fit = judge_true

            served = client.post(
                "/chat", headers=headers,
                json={"message": "적합성판정테스트질문B", "persona": "hr",
                      "thinking_mode": "off", "session_id": "fit-b"},
            )
            assert served.status_code == 200
            assert ANSWER in served.text
            assert "내부 지식베이스" in served.text
            with main.mem._conn() as c:
                route_b = c.execute(
                    "SELECT route FROM memory_retrieval_events ORDER BY rowid DESC LIMIT 1"
                ).fetchone()[0]
            assert route_b == "kb_direct", route_b

            # (c) 점수가 확신 구간(KB_JUDGE_UPPER 이상)이면 판정 자체를 생략(호출 안 함)하고 직접 서빙
            judge_calls = []

            async def judge_should_not_be_called(*_a, **_kw):
                judge_calls.append(1)
                return False
            main.intent_agent.judge_answer_fit = judge_should_not_be_called

            def fake_retrieve_best_confident(*_a, **_kw):
                return {
                    "context": ANSWER, "best_score": 0.80, "top_answer": ANSWER,
                    "top_question": QUESTION, "top_results": [(QUESTION, ANSWER, 0.80)],
                    "top_source": "정적KB", "top_meta": {}, "context_memory_ids": [],
                    "expired_skipped": 0,
                }
            main.mem.retrieve_best = fake_retrieve_best_confident

            confident = client.post(
                "/chat", headers=headers,
                json={"message": "적합성판정테스트질문C", "persona": "hr",
                      "thinking_mode": "off", "session_id": "fit-c"},
            )
            assert confident.status_code == 200
            assert ANSWER in confident.text
            assert not judge_calls  # 확신 구간에서는 판정 호출 자체가 없어야 함

            # (d) company 페르소나는 판정 대상에서 제외 — 판정이 항상 False여도 직접 서빙 유지
            main.intent_agent.judge_answer_fit = judge_false
            main.mem.retrieve_best = fake_retrieve_best("정적KB")

            company_resp = client.post(
                "/chat", headers=headers,
                json={"message": "적합성판정테스트질문D", "persona": "company", "session_id": "fit-d"},
            )
            assert company_resp.status_code == 200
            assert ANSWER in company_resp.text
            with main.mem._conn() as c:
                route_d = c.execute(
                    "SELECT route FROM memory_retrieval_events ORDER BY rowid DESC LIMIT 1"
                ).fetchone()[0]
            assert route_d == "kb_direct", route_d
        finally:
            main.mem.retrieve_best = original_retrieve_best
            main.intent_agent.analyze = original_intent
            main.intent_agent.judge_answer_fit = original_judge
            main.llm.chat_stream = original_chat_stream

    print("answer_fit_judge integration tests: PASS")


def main_():
    _unit_tests()
    _integration_tests()


if __name__ == "__main__":
    main_()
