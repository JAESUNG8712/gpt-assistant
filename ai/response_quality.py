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


def _claim_sentences(text: str) -> list[str]:
    """답변 본문에서 검증 가능한 사실 주장만 고른다.

    검색 품질표시·참고 링크·코드·불확실성 고지는 생성 모델의 사실 주장이
    아니므로 제외한다. 이 구분이 없으면 서버가 붙인 안전 안내 자체를 다시
    '근거 없는 문장'으로 오판하게 된다.
    """
    value = re.sub(r"<think>[\s\S]*?</think>", "", text or "", flags=re.IGNORECASE)
    value = re.sub(r"<!--[\s\S]*?-->", "", value)
    lines, in_code = [], False
    for raw in value.splitlines():
        line = raw.strip()
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code or not line or line.startswith((">", "---", "#")):
            continue
        if re.fullmatch(r"[-*]?\s*\[[^\]]+\]\([^)]*\)", line):
            continue
        lines.append(re.sub(r"^\s*(?:[-*]|\d+[.)])\s+", "", line))
    claims = []
    for sentence in _sentences("\n".join(lines)):
        if re.search(r"확인\s*(?:필요|불가)|자료에서\s*확인되지|추정|가능성", sentence):
            continue
        assertive = bool(re.search(
            r"(?:입니다|이다|됩니다|된다|합니다|한다|있습니다|없습니다|"
            r"적용됩니다|시행됩니다|결정됐|발표됐)(?:[.!?]|$)", sentence,
        ))
        if _measured_claims(sentence) or assertive:
            claims.append(sentence[:400])
    return claims


def _sentence_grounding(question: str, answer: str, context: str) -> tuple[float, list[str]]:
    claims = _claim_sentences(answer)
    if not claims or not context:
        return (1.0 if context else 0.65), []
    evidence = local_reasoner.select_evidence(question, context, limit=8)
    if not evidence:
        return 0.0, claims

    unsupported = []
    for claim in claims:
        claim_tokens = local_reasoner._tokens(claim)
        claim_grams = local_reasoner._chargrams(claim)
        claim_numbers = _measured_claims(claim)
        supported = False
        for source in evidence:
            source_tokens = local_reasoner._tokens(source)
            source_grams = local_reasoner._chargrams(source)
            token_overlap = len(claim_tokens & source_tokens) / max(
                1, min(len(claim_tokens), 8)
            )
            gram_overlap = len(claim_grams & source_grams) / max(
                1, min(len(claim_grams), len(source_grams))
            )
            source_numbers = _measured_claims(source)
            numeric_match = bool(claim_numbers) and claim_numbers.issubset(source_numbers)
            topic_match = bool((claim_tokens - claim_numbers) & source_tokens)
            if token_overlap >= 0.34 or gram_overlap >= 0.48 \
                    or (numeric_match and topic_match):
                supported = True
                break
        if not supported:
            unsupported.append(claim)
    return round(1.0 - len(unsupported) / max(1, len(claims)), 3), unsupported


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
    aggregate_groundedness = (
        min(1.0, len(a_tokens & context_tokens) / max(1, min(len(a_tokens), 12)))
        if context_tokens else 0.65
    )
    sentence_grounding, unsupported_sentences = _sentence_grounding(
        question, answer, context
    )
    groundedness = min(aggregate_groundedness, sentence_grounding) if context_tokens \
        else aggregate_groundedness
    if unsupported_sentences:
        issues.append(
            f"자료로 뒷받침되지 않은 사실 문장 {len(unsupported_sentences)}개"
        )
    if context_tokens and groundedness < 0.2:
        issues.append("제공된 참고 자료와 답변의 연결이 약함")
    confidence_match = re.search(
        r"신뢰\s*수준:\s*(high|medium|limited|low|conflict)", context or "", re.IGNORECASE
    )
    evidence_confidence = confidence_match.group(1).lower() if confidence_match else ""
    confidence_caps = {"high": 1.0, "medium": 0.8, "limited": 0.5, "low": 0.3, "conflict": 0.15}
    if evidence_confidence:
        groundedness = min(groundedness, confidence_caps[evidence_confidence])
    if evidence_confidence in {"low", "conflict"}:
        issues.append("검색 근거의 신뢰도가 낮거나 서로 충돌함")
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
        "unsupported_sentences": unsupported_sentences[:5],
        "sentence_grounding": sentence_grounding,
        "conversation_consistency": conversation_consistency,
        "evidence_confidence": evidence_confidence,
        "should_block_learning": (
            score < 0.55 or bool(unsupported) or bool(unsupported_sentences)
            or evidence_confidence in {"limited", "low", "conflict"}
        ),
        "should_warn": (
            score < 0.4 or bool(unsupported_sentences)
            or evidence_confidence in {"low", "conflict"}
        ),
    }


def format_warning(result: dict, question: str = "", context: str = "") -> str:
    issues = result.get("issues", [])[:3]
    detail = "; ".join(issues) if issues else "충분한 근거를 확인하지 못함"
    base = (
        "\n\n---\n> 🔎 **자동 품질 검토:** 이 답변은 추가 확인이 필요합니다. "
        f"장기기억 후보에는 반영하지 않았습니다. ({detail})"
    )
    unsupported_sentences = result.get("unsupported_sentences", [])[:2]
    if unsupported_sentences:
        base += "\n> **자료로 확인되지 않은 문장**\n" + "\n".join(
            f"> - {sentence}" for sentence in unsupported_sentences
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
