"""
의도 분석 에이전트 — 사용자 질문의 의도를 파악해 검색·답변 품질을 높인다.

역할:
  1. 질문 의도 한 줄 요약 (intent)
  2. KB/법령/웹 검색에 최적화된 정제 질의 생성 (refined_query)
  3. 핵심 키워드 추출 (keywords)
  4. 답변에 꼭 포함해야 할 요소 안내 (answer_guide)

동작 원칙:
  - LLM 호출 실패·타임아웃 시 원본 질문 그대로 사용 (기존 동작 유지)
  - 환경변수 INTENT_AGENT=off 로 완전 비활성화 가능
  - 정제 질의는 KB 검색 점수가 원본보다 좋을 때만 채택 (main.py에서 게이트)
"""
import asyncio
import json
import os
import re

INTENT_ENABLED = os.getenv("INTENT_AGENT", "on").lower() not in ("off", "0", "false")
_TIMEOUT = float(os.getenv("INTENT_TIMEOUT", "8"))

_SYSTEM = """당신은 질문 의도 분석 전문 에이전트입니다.
사용자의 질문을 분석해 아래 JSON만 출력합니다. JSON 외 다른 텍스트는 절대 출력하지 않습니다.

{"intent": "질문의 핵심 의도 한 문장", "refined_query": "검색 엔진에 넣기 좋은 명사 중심의 정제된 검색어", "keywords": ["핵심", "키워드"], "answer_guide": "답변에 반드시 포함해야 할 요소"}

규칙:
- intent: 사용자가 진짜 알고 싶어하는 것을 한 문장으로. 모호한 질문이면 가장 개연성 높은 해석을 택한다.
- refined_query: 조사·감탄사·잡담을 제거하고 도메인 용어로 바꾼 검색어 (예: "연차 촉진제 기준 알려줘" → "연차유급휴가 사용촉진 제도 요건"). 원 질문의 주제를 벗어나지 않는다. 60자 이내.
- keywords: 2~6개, 검색 구별력 있는 단어만.
- answer_guide: 좋은 답변이 갖춰야 할 요소 (예: "법적 근거 조항, 적용 요건, 실무 절차 순으로 설명"). 100자 이내.
- 질문이 이미 명확하면 refined_query는 원 질문과 거의 같아도 된다. 억지로 바꾸지 않는다."""


def _parse_json(raw: str) -> dict:
    """LLM 출력에서 JSON 객체 추출 (코드펜스·앞뒤 잡텍스트 허용)"""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError("JSON 없음")
    return json.loads(m.group(0))


async def _llm_once(prompt: str) -> str:
    import llm
    parts = []
    async for tok in llm.chat_stream(
        [{"role": "user", "content": prompt}],
        system_prompt=_SYSTEM,
        thinking_mode="off",
    ):
        parts.append(tok)
    return "".join(parts)


def _empty(user_msg: str) -> dict:
    return {"ok": False, "intent": "", "refined_query": user_msg,
            "keywords": [], "answer_guide": ""}


async def analyze(user_msg: str, persona_id: str = "hr") -> dict:
    """질문 의도 분석. 실패 시 ok=False + 원본 질문 반환 (호출측 동작 불변)."""
    msg = user_msg.strip()
    if not INTENT_ENABLED or len(msg) < 4:
        return _empty(user_msg)

    prompt = f"[도메인: {persona_id}]\n질문: {msg}"
    try:
        raw = await asyncio.wait_for(_llm_once(prompt), timeout=_TIMEOUT)
        data = _parse_json(raw)
    except Exception as e:
        print(f"ℹ️ 의도 분석 스킵 ({type(e).__name__}: {e})")
        return _empty(user_msg)

    refined = str(data.get("refined_query") or "").strip()[:120]
    if not refined:
        refined = user_msg
    keywords = [str(k).strip() for k in (data.get("keywords") or []) if str(k).strip()][:8]

    return {
        "ok": True,
        "intent": str(data.get("intent") or "").strip()[:150],
        "refined_query": refined,
        "keywords": keywords,
        "answer_guide": str(data.get("answer_guide") or "").strip()[:200],
    }


def format_intent_context(info: dict) -> str:
    """LLM 컨텍스트 지시문에 붙일 의도 분석 결과 텍스트. 분석 실패 시 빈 문자열."""
    if not info.get("ok"):
        return ""
    parts = []
    if info.get("intent"):
        parts.append(f"사용자 질문의 핵심 의도: {info['intent']}")
    if info.get("answer_guide"):
        parts.append(f"좋은 답변의 요건: {info['answer_guide']}")
    if not parts:
        return ""
    return "[의도 분석] " + " / ".join(parts) + " — 답변은 이 의도에 정확히 맞춰 작성하세요."
