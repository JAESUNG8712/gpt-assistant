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
  근접-오답을 구분할 수 없음이 실측으로 확인되어, LLM이 없으면 곧장 False로
  강등하고 개선된 다중 후보 추출에 판단을 맡기도록 변경.
- 1위 KB 문서가 압도적으로 확실한데도 관련 없는 하위 후보(예: 전혀 다른 여행지
  가이드)의 문장이 섞여 들어와 내용이 희석되던 문제 → 1위 대비 상대 점수 60%
  미만인 후보는 종합 대상에서 제외.
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
        "| 근속연수 | 연차일수 |\n"
        "|--------|--------|\n"
        "| 1년 | 15일 |\n"
        "| 3년 | 16일 |\n"
    )
    units = e._split_sentences(text)
    plain = [u for u, _ in units]
    # 표 구분선(|---|---|)은 장식이므로 결과에 없어야 하고, 각 표 행·목록 항목은
    # 서로 뭉치지 않고 독립된 단위로 분리돼야 한다(예전엔 전체가 문장부호 없는
    # 하나의 거대한 "문장"으로 합쳐져 결과가 표 전체를 통째로 삼키거나, 반대로
    # 이미 있던 "- " 표시가 결과에 다시 붙어 "- - " 처럼 중복되는 문제가 있었음).
    assert not any(set(u.strip('-| :')) == set() for u in plain)  # 장식만 있는 줄 없음
    assert "매월 개근 시 1일 발생" in plain
    assert "1년 | 15일" in plain
    assert "3년 | 16일" in plain
    assert not any(u.startswith('- ') for u in plain)  # 앞머리 "- " 중복 없음
    headings = [u for u, is_h in units if is_h]
    assert "연차 유급휴가 계산" in headings

    print("markdown sentence-splitting tests: PASS")


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


def _test_judge_answer_fit_demotes_without_llm():
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
        # 실측 결과 단어-겹침 휴리스틱(mem.topic_overlap)은 "전세 계약 갱신 거절"이
        # "계약"·"갱신" 같은 흔한 단어만 겹친다는 이유로 기간제 근로자 문서를
        # fit=True로 잘못 판정했다 — 이제는 LLM 없이는 시도조차 하지 않고 곧장
        # False(강등)로 처리해, 강등 후 engine의 다중 후보 추출이 대신 판단하게
        # 한다(이 함수의 기존 "판정 실패 시 보수적으로 False" 원칙과 동일한 결과).
        result = asyncio.run(intent_agent.judge_answer_fit(
            "전세 계약 갱신 거절 사유가 뭐야", "기간제 근로자 무기계약 전환",
            "계약 반복 갱신이 관행이었다면 기대권이 발생합니다. 갱신 거절 통보를 받으면 30일 이내 이의제기할 수 있습니다.",
            "hr",
        ))
        assert result is False
        assert not calls  # LLM 호출 자체가 없었어야 함
    finally:
        llm.has_llm_provider = original_has_provider
        llm.chat_stream = original_stream

    print("judge_answer_fit no-llm demotion tests: PASS")


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
    _test_compose_with_context_extracts_instead_of_dumping()
    _test_judge_answer_fit_demotes_without_llm()
    _test_deep_thinking_skips_theater_without_llm()


if __name__ == "__main__":
    main()
