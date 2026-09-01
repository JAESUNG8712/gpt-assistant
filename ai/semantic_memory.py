"""관리자 요청 시에만 실행되는 장기기억 의미 충돌 검증기."""
import asyncio
import json
import os
import re

import llm


_TIMEOUT = max(5.0, min(float(os.getenv("MEMORY_SEMANTIC_CHECK_TIMEOUT", "25")), 60.0))
_SYSTEM = """당신은 장기기억 간 의미 충돌을 검토하는 검증기입니다.
제공된 후보 답변과 기존 기억만 비교하고 아래 JSON 객체만 출력하세요.
상세 사고과정이나 JSON 밖의 설명은 출력하지 마세요.

{"verdict":"conflict|consistent|uncertain|unrelated","confidence":0.0,"summary":"검토자가 이해할 한 문장","conflicts":[{"memory_id":1,"reason":"구체적 충돌"}]}

판정 원칙:
- conflict: 동일 조건에 대해 수치, 허용/금지, 의무/선택, 적용 대상이 양립 불가능함.
- consistent: 표현은 달라도 핵심 사실이 양립함.
- uncertain: 적용 시점·대상·예외가 달라 보이지만 자료만으로 확정할 수 없음.
- unrelated: 같은 페르소나이지만 사실상 다른 질문임.
- 숫자가 다르더라도 시점·단위·상한/하한이 다르면 곧바로 conflict로 단정하지 않음.
- conflicts의 memory_id는 입력에 제공된 기존 기억 ID만 사용함.
- 이 결과는 자동 승인이 아니라 관리자 판단 보조임."""


def _parse_json(raw: str) -> dict:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", (raw or "").strip())
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError("JSON 응답 없음")
    return json.loads(match.group(0))


async def _collect(prompt: str) -> str:
    parts = []
    async for token in llm.chat_stream(
        [{"role": "user", "content": prompt}],
        system_prompt=_SYSTEM,
        thinking_mode="off",
    ):
        parts.append(token)
        if sum(len(part) for part in parts) > 5000:
            break
    return "".join(parts)


async def verify(context: dict) -> dict:
    related = context.get("related_memories") or []
    if not related:
        return {
            "verdict": "unrelated", "confidence": 1.0,
            "summary": "비교할 기존 기억이 없습니다.", "conflicts": [],
        }
    payload = {
        "candidate": context.get("candidate", {}),
        "existing_memories": related,
    }
    try:
        raw = await asyncio.wait_for(
            _collect("다음 기억을 비교하세요:\n" + json.dumps(payload, ensure_ascii=False)),
            timeout=_TIMEOUT,
        )
        result = _parse_json(raw)
    except Exception as exc:
        return {
            "verdict": "unavailable", "confidence": 0.0,
            "summary": f"의미 검증을 완료하지 못했습니다({type(exc).__name__}).",
            "conflicts": [],
        }

    allowed_ids = {int(item["memory_id"]) for item in related}
    conflicts = []
    for item in result.get("conflicts") or []:
        try:
            memory_id = int(item.get("memory_id"))
        except (AttributeError, TypeError, ValueError):
            continue
        if memory_id in allowed_ids:
            conflicts.append({"memory_id": memory_id, "reason": str(item.get("reason") or "")})
    result["conflicts"] = conflicts
    return result
