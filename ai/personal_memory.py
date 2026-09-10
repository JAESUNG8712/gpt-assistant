"""소유자가 채팅 명령으로 직접 통제하는 개인 기억 기능."""
from __future__ import annotations

import re

import memory as mem
import privacy as privacy_guard


SOURCE = "개인기억"
MAX_CONTENT_LEN = 1000


def _answer_from_content(content: str) -> str:
    if content.startswith("Q: ") and "\nA: " in content:
        return content.split("\nA: ", 1)[1].strip()
    return content.strip()


def list_memories(limit: int = 20) -> list[dict]:
    """사용자가 채팅으로 직접 저장한 소유자 기억만 반환한다."""
    with mem._conn() as conn:
        rows = conn.execute(
            "SELECT id,content,memory_type,updated_at FROM learned_knowledge"
            " WHERE source=? AND memory_scope='owner' ORDER BY id DESC LIMIT ?",
            (SOURCE, max(1, min(int(limit), 50))),
        ).fetchall()
    return [
        {**dict(row), "value": _answer_from_content(dict(row)["content"])}
        for row in rows
    ]


def _reload_engine() -> None:
    from engine import reload_engine
    reload_engine()


def _preference_slot(value: str) -> str:
    """서로 충돌할 수 있는 대표 선호를 안정적인 한 칸으로 묶는다."""
    slot_patterns = (
        ("답변 길이", r"(?:짧|간단|간결|핵심|자세|상세).{0,16}(?:답변|설명)|(?:답변|설명).{0,16}(?:짧|간단|간결|핵심|자세|상세)"),
        ("말투", r"존댓말|반말|말투|어조|톤으로"),
        ("답변 언어", r"(?:한국어|영어|일본어|중국어).{0,12}(?:답변|설명|말해|써줘)"),
        ("답변 형식", r"(?:표|목록|불릿|글머리|단계별).{0,12}(?:답변|정리|설명|형식)"),
    )
    for slot, pattern in slot_patterns:
        if re.search(pattern, value):
            return slot
    return ""


def _save(content: str) -> str:
    value = " ".join((content or "").strip().split())
    if not value:
        return "기억할 내용을 함께 입력해 주세요. 예: `/기억 답변은 핵심부터 짧게 해줘`"
    if len(value) > MAX_CONTENT_LEN:
        return f"개인 기억은 한 번에 {MAX_CONTENT_LEN}자까지 저장할 수 있습니다. 내용을 나눠서 알려주세요."
    labels = privacy_guard.sensitive_labels(value, include_contact=True)
    if re.search(
        r"(?i)비밀번호|비밀키|인증토큰|암호|(?:api|access)[_ -]?(?:key|token)|password|passwd|secret",
        value,
    ) and "비밀번호·인증정보" not in labels:
        labels.append("비밀번호·인증정보")
    if labels:
        return (
            "안전을 위해 민감정보가 포함된 내용은 기억하지 않았습니다. "
            f"감지 항목: {', '.join(labels)}\n"
            "비밀번호·인증키·주민번호·카드번호·전화번호·이메일은 제외하고 다시 알려주세요."
        )

    memory_type, _ = mem.classify_memory_kind(value, value, SOURCE)
    if re.search(
        r"(?:답변|설명|말투|호칭).{0,16}(?:짧|간단|자세|상세|먼저|위주|형식|존댓말|반말)|"
        r"(?:짧|간단|자세|상세|먼저|위주|존댓말|반말).{0,16}(?:답변|설명|말투|호칭)",
        value,
    ):
        memory_type = "preference"
    # 직접 명령한 기억은 대화가 바뀌어도 유지하되, 선호가 아닌 개인 사실을
    # 모든 프롬프트에 무조건 주입하지 않도록 원래 유형은 보존한다.
    preference_slot = _preference_slot(value) if memory_type == "preference" else ""
    question = (
        f"사용자의 개인 선호 [{preference_slot}]"
        if preference_slot else f"사용자의 개인 기억: {value}"
    )
    updated = mem.upsert_knowledge(
        question, value, "",
        source=SOURCE, memory_type=memory_type, memory_scope="owner",
        valid_until="",
        reason="사용자 채팅 명령으로 개인 기억 저장",
    )
    verb = "갱신했습니다" if updated else "기억했습니다"
    return f"✅ 개인 기억으로 {verb}.\n\n- {value}\n\n`/기억목록`으로 확인하고 `/잊기 키워드`로 지울 수 있습니다."


def _forget(keyword: str) -> str:
    value = " ".join((keyword or "").strip().split())
    if not value:
        return "잊을 기억의 키워드를 입력해 주세요. 예: `/잊기 짧게 답변`"
    memories = list_memories(limit=50)
    if value in {"전부", "모두", "전체"}:
        return "모든 개인 기억을 지우려면 `/잊기 전부 확인`이라고 한 번 더 입력해 주세요."
    if value in {"전부 확인", "모두 확인", "전체 확인"}:
        if not memories:
            return "지울 개인 기억이 없습니다."
        count = mem.quarantine_learned_rows(memories, "사용자 채팅 명령: 개인 기억 전체 삭제")
        _reload_engine()
        return f"🧹 개인 기억 {count}개를 모두 삭제했습니다. 관리자 격리함에서는 복구할 수 있습니다."

    keyword_lower = value.lower()
    matches = [item for item in memories if keyword_lower in item["value"].lower()]
    if not matches:
        return f"`{value}`와 일치하는 개인 기억을 찾지 못했습니다. `/기억목록`에서 확인해 주세요."
    if len(matches) > 1:
        lines = "\n".join(
            f"{index}. {item['value'][:160]}" for index, item in enumerate(matches[:10], 1)
        )
        return (
            f"`{value}`와 일치하는 기억이 {len(matches)}개라 임의로 지우지 않았습니다. "
            "더 구체적인 키워드로 다시 지시해 주세요.\n\n" + lines
        )
    mem.quarantine_learned_rows(matches, "사용자 채팅 명령: 개인 기억 삭제")
    _reload_engine()
    return f"🧹 다음 개인 기억을 삭제했습니다. 관리자 격리함에서는 복구할 수 있습니다.\n\n- {matches[0]['value']}"


def execute(action: str, content: str = "", *, is_shared: bool = False) -> str:
    """파싱된 개인 기억 명령을 실행하고 사용자용 응답을 반환한다."""
    if not action:
        return ""
    if is_shared:
        return "🔒 공유 대화에서는 소유자의 개인 기억을 조회하거나 변경할 수 없습니다."
    if action == "save":
        return _save(content)
    if action == "forget":
        return _forget(content)
    if action == "list":
        memories = list_memories()
        if not memories:
            return "아직 직접 저장한 개인 기억이 없습니다. `/기억 [내용]`으로 알려주세요."
        lines = "\n".join(
            f"{index}. {item['value']}" for index, item in enumerate(memories, 1)
        )
        return f"📚 현재 직접 저장한 개인 기억 {len(memories)}개입니다.\n\n{lines}"
    return "지원하지 않는 기억 명령입니다."
