"""LLM API 키가 하나도 없을 때의 "자체 판단" 기능 회귀 테스트.

1차로 (1) 심층검토(deep thinking) 3단계 반복 호출 생략, (2) 답변 적합성 판정
(judge_answer_fit)의 로컬 휴리스틱 대체, (3) 여러 KB 후보의 문장 단위 추출
종합(_local_synthesize)을 구현했으나, 실제 로컬 서버를 띄워 라이브로 검증하는
과정에서 세 가지가 전부 제대로 동작하지 않음을 추가로 발견해 수정했다:

- `_split_sentences()`가 표·목록이 섞인 마크다운을 제대로 못 나눠 표 전체가
  하나의 거대한 "문장"으로 뭉치거나 반대로 "- " 표시가 중복되는 문제 → 줄
  단위로 먼저 나누고 표 구분선은 제외하도록 재작성.
- 실제 컨텍스트 기반 답변(`_compose_with_context`)은 `_local_synthesize`가
  적용되지 않는 별개의 "원문 그대로 덤프" 경로였음(오히려 LLM 없을 때 가장
  자주 타는 경로) → 여기도 동일한 문장 단위 추출을 적용.
- `mem.topic_overlap` 기반 로컬 적합성 판정 휴리스틱은 실제 KB로 검증한 결과
  "전세 계약 갱신 거절"이 "계약"·"갱신" 같은 흔한 단어만 겹친다는 이유로
  기간제 근로자 문서를 fit=True로 오판정 — 단어 겹침만으로는 이 함수가 막으려던
  근접-오답을 구분할 수 없음이 실측으로 확인되어, 한때 LLM이 없으면 곧장
  False로 전량 강등하도록 단순화했다.
- 1위 KB 문서가 압도적으로 확실한데도 관련 없는 하위 후보(예: 전혀 다른 여행지
  가이드)의 문장이 섞여 들어와 내용이 희석되던 문제 → 1위 대비 상대 점수 60%
  미만인 후보는 종합 대상에서 제외.

이어서 위 "전량 강등" 단순화 자체도 실측 결과 과했음을 발견해 재조정했다:
"퇴직금은 어떻게 계산하나요"처럼 명백히 맞는 고빈도 매치까지 전부 강등해
잘 정리된 KB 원문을 불필요하게 문장 단위로 쪼개는 대가가, "전세" 같은
드문 근접-오답을 놓치는 대가보다 컸다. 게다가 이 과정에서 `memory.
topic_overlap()` 자체의 별도 버그도 발견했다 — 공백 단위 정규식으로 어절을
그대로 추출해 "퇴직금은"·"계산하나요"처럼 조사·활용형이 붙은 원문을
비교하는 바람에, 대상 텍스트의 "퇴직금"·"계산" 같은 조사 없는 어근과
글자 그대로 일치하지 않아 명백히 맞는 매치조차 주제 불일치로 오판정하고
있었다(2026-07-08 도입 이후 계속 존재). `engine._tok()`(어미 제거 후 어근+원형
함께 보존)로 교체해 이 오판정을 해결 — 이 함수는 main.py의 자동학습/대화
출처 KB 직접서빙 강등 게이트에도 쓰이므로 LLM 유무와 무관하게 이득이다.
수정된 topic_overlap을 다시 로컬 적합성 판정에 사용하도록 되돌리되, "전세"류
근접-오답까지 잡지는 못한다는 한계는 그대로 남겨두고 문서화했다(진짜 의미
이해가 필요한 영역).
"""
import asyncio
import os
import sys

AI_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI_DIR)


def _clear_llm_keys():
    for k in ("ANTHROPIC_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENROUTER_API_KEY",
              "GROQ_API_KEY", "GEMINI_API_KEY"):
        os.environ.pop(k, None)


def _test_has_llm_provider():
    import llm

    original_provider = llm.LLM_PROVIDER
    saved_keys = {
        "ANTHROPIC_API_KEY": llm.ANTHROPIC_API_KEY,
        "OPENCODE_ZEN_API_KEY": llm.OPENCODE_ZEN_API_KEY,
        "OPENROUTER_API_KEY": llm.OPENROUTER_API_KEY,
        "GROQ_API_KEY": llm.GROQ_API_KEY,
        "GEMINI_API_KEY": llm.GEMINI_API_KEY,
    }
    try:
        llm.ANTHROPIC_API_KEY = llm.OPENCODE_ZEN_API_KEY = ""
        llm.OPENROUTER_API_KEY = llm.GROQ_API_KEY = llm.GEMINI_API_KEY = ""
        llm.LLM_PROVIDER = "auto"
        assert llm.has_llm_provider() is False

        llm.GROQ_API_KEY = "test-key"
        assert llm.has_llm_provider() is True

        llm.GROQ_API_KEY = ""
        llm.LLM_PROVIDER = "local"
        assert llm.has_llm_provider() is False

        llm.LLM_PROVIDER = "claude"  # 명시적 지정은 auto 우회
        assert llm.has_llm_provider() is True
    finally:
        llm.LLM_PROVIDER = original_provider
        for k, v in saved_keys.items():
            setattr(llm, k, v)

    print("has_llm_provider tests: PASS")


def _test_local_synthesize():
    import engine as e

    # 관련 문장만 골라 종합하고, 서로 다른 문서(2건)를 비교했다는 사실을 투명하게 밝힌다.
    results = [
        ("연차 발생 기준", "연차는 1년간 80% 이상 출근한 근로자에게 발생합니다. 이 조건과 무관한 문장입니다.", 0.25, {}),
        ("연차 촉진제란", "연차 사용촉진 제도는 서면 통보 절차입니다. 발생 기준과는 별개의 제도입니다.", 0.20, {}),
    ]
    out = e._local_synthesize("연차 발생 기준이 뭐야", results)
    assert "🧭" in out and "자체 판단" in out
    assert "80% 이상 출근한 근로자에게 발생합니다" in out
    assert "이 조건과 무관한 문장입니다" not in out  # 무관 문장은 제외돼야 함

    # 질문이 전부 일반어라 비교 기준이 없으면 최상위 원문을 그대로 신뢰
    only_generic = [("무엇", "이것은 저 답변입니다.", 0.15, {})]
    assert e._local_synthesize("이 그 저 것", only_generic) == "이것은 저 답변입니다."

    # _compose()의 중간~낮은 신뢰도 구간(0.10~0.40)에 실제로 연결되어 있는지 확인
    composed = e._compose("연차 발생 기준이 뭐야", results, "hr")
    assert "🧭" in composed

    print("local synthesize tests: PASS")


def _test_local_synthesize_ignores_weak_runner_ups():
    import engine as e

    # 1위가 압도적으로 확실하면(비율 60% 미만) 관련 없는 하위 후보의 문장이
    # 섞여 들어와 1위 문서 내용이 희석되지 않아야 한다(실제 "여행앱" 질의로
    # 재현됐던 문제 — 약하게 관련된 다른 여행 후기 문서들이 끼어들었었음).
    results = [
        ("여행앱 추천", "트립닷컴은 항공권 예약에 강합니다. 여행 필수 앱 목록입니다.", 0.39, {}),
        ("호주 여행 가이드", "여행 적기는 4~6월입니다. 시드니는 인기 관광지입니다.", 0.20, {}),
        ("태국 여행 가이드", "여행 적기는 11~2월입니다. 방콕 왕궁이 유명합니다.", 0.17, {}),
    ]
    out = e._local_synthesize("여행앱 알려줘", results)
    assert "여행 필수 앱" in out
    assert "시드니" not in out and "방콕" not in out  # 약한 하위 후보는 배제

    # 반대로 1위와 근접한 후보(비율 60% 이상)는 여전히 함께 비교 대상이 된다 —
    # 근접-오답을 걸러내려면 이 경우엔 하위 후보도 봐야 하기 때문.
    close_results = [
        ("기간제 근로자 전환", "계약 갱신 거절 통보를 받으면 30일 이내 이의제기할 수 있습니다.", 0.156, {}),
        ("임대차3법 가이드", "임대인 거절 사유가 있는 경우에만 계약갱신청구권 행사를 거절할 수 있습니다.", 0.146, {}),
    ]
    out2 = e._local_synthesize("전세 계약 갱신 거절 사유가 뭐야", close_results)
    assert "임대인 거절 사유" in out2  # 근접한 2위 문서의 정답이 함께 검토됨

    print("local synthesize weak-runner-up filter tests: PASS")


def _test_split_sentences_handles_markdown():
    import engine as e

    text = (
        "## 연차 유급휴가 계산\n\n"
        "**1년 미만 근무자**\n"
        "- 매월 개근 시 1일 발생\n\n"
        "1. 신청서 제출\n"
        "2. 팀장 승인\n\n"
        "| 근속연수 | 연차일수 |\n"
        "|--------|--------|\n"
        "| 1년 | 15일 |\n"
        "| 3년 | 16일 |\n"
    )
    units = e._split_sentences(text)
    # 표(헤더+구분선+데이터행)는 행 단위로 쪼개지지 않고 통째로 한 단위로
    # 유지돼야 한다 — 행별로 쪼개면 "근속연수" 헤더와 "15일" 값이 서로 다른
    # 조각으로 떨어져 어느 열이 무엇을 뜻하는지 알 수 없게 된다(예전엔 반대로
    # 표 전체가 문장부호 없는 하나의 거대한 "문장"으로 뭉치는 문제도 있었음).
    tables = [u for u in units if u["is_table"]]
    assert len(tables) == 1
    assert "근속연수" in tables[0]["text"] and "15일" in tables[0]["text"]
    assert "|---" not in tables[0]["text"].split("\n")[0]  # 헤더행 자체엔 구분선 없음
    assert "|--------|" in tables[0]["text"]  # 구분선은 표 블록 안에 그대로 보존

    plain = [u["text"] for u in units if not u["is_table"] and not u["is_heading"]]
    assert "매월 개근 시 1일 발생" in plain
    assert not any(p.startswith('- ') for p in plain)  # 마커는 별도 필드로 분리, 본문에 중복 없음

    headings = [u["text"] for u in units if u["is_heading"]]
    assert "연차 유급휴가 계산" in headings

    # 목록 스타일(글머리표 "-"/번호 "1.")이 marker에 원래 형태로 보존된다.
    bullet_unit = next(u for u in units if u["text"] == "매월 개근 시 1일 발생")
    assert bullet_unit["marker"] == "- "
    step1 = next(u for u in units if u["text"] == "신청서 제출")
    assert step1["marker"] == "1. "
    step2 = next(u for u in units if u["text"] == "팀장 승인")
    assert step2["marker"] == "2. "

    # _render_unit()으로 되돌리면 표는 표 그대로, 목록은 원래 번호·글머리표 그대로 복원된다.
    assert e._render_unit(tables[0]) == tables[0]["text"]
    assert e._render_unit(bullet_unit) == "- 매월 개근 시 1일 발생"
    assert e._render_unit(step1) == "1. 신청서 제출"

    print("markdown sentence-splitting tests: PASS")


def _test_local_synthesize_preserves_table_structure():
    import engine as e

    results = [
        ("연차 발생 기준", (
            "## 연차 발생 기준\n\n"
            "| 근속 기간 | 연차 일수 |\n"
            "|---------|---------|\n"
            "| 1년 미만 | 월 1일 |\n"
            "| 1년 이상 | 15일 |\n"
        ), 0.3, {}),
    ]
    out = e._local_synthesize("연차 발생 기준이 궁금해", results)
    # 표가 행 단위로 흩어지지 않고 마크다운 표 형태 그대로 남아있어야 한다
    # (파이프 구분자·헤더·구분선·데이터행이 모두 한 블록으로 이어져 있는지 확인).
    assert "| 근속 기간 | 연차 일수 |" in out
    assert "|---------|---------|" in out
    assert "| 1년 이상 | 15일 |" in out

    print("local synthesize table preservation tests: PASS")


def _test_compose_with_context_extracts_instead_of_dumping():
    import engine as e

    context = (
        "## 기간제 근로자 무기계약 전환\n\n"
        "계약 반복 갱신이 관행이었다면 기대권이 발생합니다.\n"
        "갱신 거절 통보를 받으면 30일 이내 이의제기할 수 있습니다.\n\n"
        "## 임대차3법 가이드\n\n"
        "임대인 거절 사유가 있는 경우에만 계약갱신청구권 행사를 거절할 수 있습니다.\n"
        "전월세상한제로 갱신 시 임대료 인상은 5% 이내로 제한됩니다."
    )
    out = e._compose_with_context("전세 계약 갱신 거절 사유가 뭐야", context, "hr")
    assert e.LOCAL_FALLBACK_MARKER in out
    # 예전에는 context를 그대로 통째로 보여줬지만, 이제는 질문과 실제로 관련된
    # 부분(전세/임대차 쪽 근거)을 추려 보여준다 — 원본 그대로 노출이 아님을 확인.
    assert "임대인 거절 사유" in out
    assert "- " in out  # 발췌 목록 형태로 정리됨

    # 관련 문장을 하나도 못 찾을 만큼 질문에 실질 토큰이 없으면(전부 일반어)
    # 안전하게 원문 일부를 그대로 보여주는 예전 동작으로 대체된다.
    fallback = e._compose_with_context("그거 뭐야", context, "hr")
    assert e.LOCAL_FALLBACK_MARKER in fallback
    assert "그대로 보여드립니다" in fallback

    print("compose_with_context extraction tests: PASS")


def _test_judge_answer_fit_without_llm():
    import asyncio
    import intent_agent
    import llm

    original_has_provider = llm.has_llm_provider
    original_stream = llm.chat_stream
    calls = []

    async def should_not_be_called(*_a, **_kw):
        calls.append(1)
        yield '{"fit": true}'

    llm.has_llm_provider = lambda: False
    llm.chat_stream = should_not_be_called
    try:
        # LLM이 없으면 호출을 시도조차 하지 않고 memory.topic_overlap 기반
        # 로컬 휴리스틱으로 즉시 판정한다. 처음엔 "LLM 없이는 항상 False(전량
        # 강등)"로 단순화했으나, 이렇게 하면 "퇴직금은 어떻게 계산하나요"처럼
        # 명백히 맞는 고빈도 매치까지 전부 강등되어 잘 정리된 KB 원문이
        # 불필요하게 문장 단위로 쪼개지는 것을 실측으로 확인했다 — 명백히 맞는
        # 매치는 그대로 fit=True로 두고, 명백히 무관한 매치만 걸러내는 것이
        # 더 나은 절충안이다.
        related = asyncio.run(intent_agent.judge_answer_fit(
            "퇴직금은 어떻게 계산하나요", "퇴직금 계산 방법",
            "퇴직금 계산 방법: 퇴직금 = 평균임금 × 30일 × (재직일수 ÷ 365)", "hr",
        ))
        assert related is True

        unrelated = asyncio.run(intent_agent.judge_answer_fit(
            "전세 계약 갱신 거절 사유가 뭐야", "퇴직금 계산 방법",
            "퇴직금은 평균임금 기준으로 계산합니다.", "hr",
        ))
        assert unrelated is False
        assert not calls  # 두 판정 모두 LLM 호출 자체가 없었어야 함

        # 알려진 한계: "계약"·"갱신"처럼 흔한 절차 용어만 겹치는 근접-오답
        # (대상은 전세/임대차인데 실제로는 기간제 근로자 계약 문서)은 이
        # 로컬 휴리스틱으로는 구분되지 않는다 — 진짜 의미 이해가 필요한
        # 영역이라 로컬 휴리스틱의 근본적 한계로 받아들인다(2026-09-11 실측).
        near_miss = asyncio.run(intent_agent.judge_answer_fit(
            "전세 계약 갱신 거절 사유가 뭐야", "기간제 근로자 무기계약 전환",
            "계약 반복 갱신이 관행이었다면 기대권이 발생합니다. 갱신 거절 통보를 받으면 30일 이내 이의제기할 수 있습니다.",
            "hr",
        ))
        assert near_miss is True  # 한계로 남겨둔 오탐 — engine의 추출 종합이 보완
    finally:
        llm.has_llm_provider = original_has_provider
        llm.chat_stream = original_stream

    print("judge_answer_fit without-llm tests: PASS")


def _test_deep_thinking_skips_theater_without_llm():
    import llm

    calls = {"local": 0, "deep_stage": 0}
    original_local = llm._local_stream
    original_deep = llm._deep_thinking_chat
    original_has_provider = llm.has_llm_provider

    async def fake_local(messages, context, system):
        calls["local"] += 1
        yield "로컬 폴백 응답"

    async def fake_deep(messages, context, final_system):
        calls["deep_stage"] += 1
        yield "심층검토 응답"

    llm._local_stream = fake_local
    llm._deep_thinking_chat = fake_deep
    try:
        # LLM이 하나도 없으면 3단계 심층검토 대신 로컬 폴백 1회만 호출
        llm.has_llm_provider = lambda: False

        async def _run_no_llm():
            parts = []
            async for tok in llm.chat_stream(
                [{"role": "user", "content": "질문"}], thinking_mode="deep",
            ):
                parts.append(tok)
            return "".join(parts)

        result = asyncio.run(_run_no_llm())
        assert result == "로컬 폴백 응답"
        assert calls["local"] == 1
        assert calls["deep_stage"] == 0

        # LLM이 있으면 기존처럼 3단계 심층검토를 그대로 사용
        llm.has_llm_provider = lambda: True

        async def _run_with_llm():
            parts = []
            async for tok in llm.chat_stream(
                [{"role": "user", "content": "질문"}], thinking_mode="deep",
            ):
                parts.append(tok)
            return "".join(parts)

        result2 = asyncio.run(_run_with_llm())
        assert result2 == "심층검토 응답"
        assert calls["deep_stage"] == 1
        assert calls["local"] == 1  # 이전 호출 이후 추가 호출 없음
    finally:
        llm._local_stream = original_local
        llm._deep_thinking_chat = original_deep
        llm.has_llm_provider = original_has_provider

    print("deep thinking skip-without-llm tests: PASS")


def main():
    _clear_llm_keys()
    _test_has_llm_provider()
    _test_local_synthesize()
    _test_local_synthesize_ignores_weak_runner_ups()
    _test_split_sentences_handles_markdown()
    _test_local_synthesize_preserves_table_structure()
    _test_compose_with_context_extracts_instead_of_dumping()
    _test_judge_answer_fit_without_llm()
    _test_deep_thinking_skips_theater_without_llm()


if __name__ == "__main__":
    main()
