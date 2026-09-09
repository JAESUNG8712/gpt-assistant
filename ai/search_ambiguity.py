"""짧고 모호한 KB 질의를 보수적으로 감지해 선택 질문을 만든다."""

import re


MIN_CANDIDATE_SCORE = 0.15
MIN_RUNNER_UP_RATIO = 0.82
MAX_QUERY_TERMS = 3
MAX_COMPACT_QUERY_LENGTH = 24
_SELECTION_RE = re.compile(r"^\s*([1-4])\s*(?:번|번째)?\s*[.!?]?\s*$")


def _clean_title(answer: str, question: str) -> str:
    first = next((line.strip() for line in (answer or "").splitlines() if line.strip()), "")
    title = re.sub(r"^#{1,6}\s*", "", first)
    title = title.replace("**", "").strip(" :-")
    return (title or question.strip())[:80]


def _title_terms(title: str) -> set[str]:
    return {
        token.lower() for token in re.findall(r"[가-힣A-Za-z0-9]{2,}", title or "")
    }


def _near_duplicate(left: str, right: str) -> bool:
    a, b = _title_terms(left), _title_terms(right)
    if not a or not b:
        return left.strip().lower() == right.strip().lower()
    return len(a & b) / len(a | b) >= 0.72


def ambiguity_candidates(query: str, top_results: list) -> list[dict]:
    """실제로 서로 다른 상위 후보가 경합하는 짧은 질문만 반환한다."""
    if len(top_results) < 2:
        return []

    from engine import _tok

    query_terms = set(_tok(query or ""))
    compact_query = re.sub(r"[^0-9A-Za-z가-힣]+", "", query or "")
    if not query_terms or len(query_terms) > MAX_QUERY_TERMS:
        return []
    if len(compact_query) > MAX_COMPACT_QUERY_LENGTH:
        return []

    best_score = float(top_results[0][2] or 0)
    if best_score < MIN_CANDIDATE_SCORE:
        return []

    candidates = []
    cutoff = max(MIN_CANDIDATE_SCORE, best_score * MIN_RUNNER_UP_RATIO)
    for question, answer, score in top_results:
        if float(score or 0) < cutoff:
            continue
        title = _clean_title(answer, question)
        if any(_near_duplicate(title, item["title"]) for item in candidates):
            continue
        # 후보는 응답 헤더/대화 메타데이터에도 기록되므로 비정상적으로 긴 동적
        # 지식 질문이 헤더 크기를 키우지 않도록 선택 재검색에 충분한 길이로 제한한다.
        candidates.append({
            "title": title,
            "question": str(question)[:500],
            "score": float(score),
        })
        if len(candidates) >= 4:
            break

    return candidates if len(candidates) >= 2 else []


def format_clarification(candidates: list[dict]) -> str:
    lines = [
        "질문 범위가 여러 가지로 해석될 수 있어요. 원하는 번호나 내용을 말씀해 주세요.",
        "",
    ]
    lines.extend(f"{index}. **{item['title']}**" for index, item in enumerate(candidates, 1))
    lines.extend(["", "> 예: `1번` 또는 원하는 내용을 조금 더 구체적으로 입력"])
    return "\n".join(lines)


def resolve_selection(message: str, history: list[dict]) -> dict:
    """직전 모호성 안내에 대한 번호 답변을 저장된 후보와 연결한다."""
    match = _SELECTION_RE.match(message or "")
    if not match or not history:
        return {}

    # 선택지는 안내를 만든 직전 사용자 행에 저장된다. 더 오래된 선택지를 뒤져
    # 현재 대화의 숫자를 잘못 해석하지 않도록 가장 최근 사용자 행만 확인한다.
    latest_user = next(
        (row for row in reversed(history) if row.get("role") == "user"), None
    )
    if not latest_user:
        return {}
    status = latest_user.get("command_status") or {}
    options = status.get("clarification_options") or []
    index = int(match.group(1)) - 1
    if index < 0 or index >= len(options):
        return {}
    selected = options[index]
    if not isinstance(selected, dict) or not str(selected.get("question") or "").strip():
        return {}
    return selected
