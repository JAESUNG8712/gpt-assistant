"""생성 답변을 외부 모델 없이 점검하는 결정적 품질 게이트."""
from __future__ import annotations

import re

import local_reasoner


def _sentences(text: str) -> list[str]:
    return [
        item.strip() for item in re.split(r"(?:\n+|(?<=[.!?])\s+)", text or "")
        if len(item.strip()) >= 8
    ]


def _normalized(text: str) -> str:
    return re.sub(r"[^0-9a-z가-힣]+", "", (text or "").lower())


def _measured_claims(text: str) -> set[str]:
    return {
        re.sub(r"[\s,]", "", item.lower())
        for item in re.findall(
            r"\d[\d,]*(?:\.\d+)?\s*(?:원|만원|억|%|퍼센트|년|월|일|시간)",
            text or "", re.IGNORECASE,
        )
    }


def evaluate(
    question: str, answer: str, context: str = "", previous_answer: str = ""
) -> dict:
    """관련성·근거·완결성·수치·반복을 0~1 범위로 점검한다."""
    issues: list[str] = []
    q_tokens = local_reasoner._tokens(question)
    a_tokens = local_reasoner._tokens(answer)
    relevance = len(q_tokens & a_tokens) / max(1, min(len(q_tokens), 8))
    relevance = min(1.0, relevance)
    if q_tokens and relevance < 0.25:
        issues.append("질문 핵심어와 답변의 연결이 약함")

    plan = local_reasoner.build_reasoning_plan(question)
    aspect_terms = {
        "amount": r"금액|비용|원|계산", "date": r"시점|날짜|연도|년|월|일",
        "comparison": r"비교|차이|반면", "cause": r"원인|이유|때문",
        "procedure": r"절차|단계|방법|먼저", "eligibility": r"조건|대상|요건",
        "latest": r"현재|최신|기준", "fact": r"사실|근거|확인",
    }
    missing_aspects = [
        aspect for aspect in plan.aspects
        if not re.search(aspect_terms.get(aspect, re.escape(aspect)), answer or "")
    ]
    completeness = 1.0 - (len(missing_aspects) / max(1, len(plan.aspects)))
    if missing_aspects:
        issues.append("요청 항목 일부 누락: " + ", ".join(missing_aspects))

    answer_claims = _measured_claims(answer)
    context_claims = _measured_claims(context)
    unsupported = sorted(answer_claims - context_claims) if context_claims else []
    numeric = 1.0 if not unsupported else max(0.0, 1.0 - len(unsupported) * 0.25)
    if unsupported:
        issues.append("참고 자료에서 확인되지 않은 수치·시점: " + ", ".join(unsupported[:4]))

    sentences = [_normalized(item) for item in _sentences(answer)]
    duplicate_count = len(sentences) - len(set(sentences))
    repetition = max(0.0, 1.0 - duplicate_count * 0.25)
    if duplicate_count:
        issues.append(f"동일·중복 문장 {duplicate_count}개")

    previous_claims = _measured_claims(previous_answer)
    changed_claims = answer_claims - previous_claims
    conversation_consistency = 1.0
    if (
        previous_claims and answer_claims and changed_claims
        and not re.search(r"정정|변경|달라|이전|비교|기존", answer or "")
    ):
        conversation_consistency = 0.35
        issues.append("직전 답변과 달라진 수치·시점에 변경 설명이 없음")

    context_tokens = local_reasoner._tokens(context)
    groundedness = (
        min(1.0, len(a_tokens & context_tokens) / max(1, min(len(a_tokens), 12)))
        if context_tokens else 0.65
    )
    if context_tokens and groundedness < 0.2:
        issues.append("제공된 참고 자료와 답변의 연결이 약함")
    if re.search(r"(?:⚠️\s*)?(?:오류|연결 오류|일시적인 오류)", answer or ""):
        issues.append("오류 응답 포함")
        groundedness = 0.0

    score = round(
        relevance * 0.25 + completeness * 0.15 + groundedness * 0.20
        + numeric * 0.15 + repetition * 0.10 + conversation_consistency * 0.15,
        3,
    )
    return {
        "score": score,
        "grade": "good" if score >= 0.7 else "review" if score >= 0.5 else "low",
        "issues": issues,
        "unsupported_claims": unsupported,
        "conversation_consistency": conversation_consistency,
        "should_block_learning": score < 0.55 or bool(unsupported),
        "should_warn": score < 0.4,
    }


def format_warning(result: dict, question: str = "", context: str = "") -> str:
    issues = result.get("issues", [])[:3]
    detail = "; ".join(issues) if issues else "충분한 근거를 확인하지 못함"
    base = (
        "\n\n---\n> 🔎 **자동 품질 검토:** 이 답변은 추가 확인이 필요합니다. "
        f"장기기억 후보에는 반영하지 않았습니다. ({detail})"
    )
    evidence = local_reasoner.select_evidence(question, context, limit=3) if context else []
    if not evidence:
        return base + "\n> 확인 가능한 자료가 부족하므로 검색 또는 구체적인 조건 추가가 필요합니다."
    safe_lines = []
    for item in evidence:
        compact = " ".join(item.split())
        safe_lines.append(f"> - {compact[:260]}")
    return (
        base
        + "\n> **현재 자료에서 다시 확인된 내용**\n"
        + "\n".join(safe_lines)
        + "\n> 위 근거와 충돌하는 원답변 내용은 사용하지 마세요."
    )
