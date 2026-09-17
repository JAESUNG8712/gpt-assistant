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
            r"\d[\d,]*(?:\.\d+)?\s*(?:만원|개월|퍼센트|시간|원|억|%|년|월|일|세|명|건)",
            text or "", re.IGNORECASE,
        )
    }


_CONDITION_PATTERNS = {
    "only": r"경우에만|에\s*한해|로\s*한정|[가-힣0-9)]만(?=\s|[,.]|$)",
    "minimum": r"이상",
    "maximum": r"이하",
    "over": r"초과",
    "under": r"미만",
    "exception": r"제외|예외",
    "required": r"필요|필수|해야|하여야",
}


def _condition_signature(text: str) -> tuple[set[str], set[str]]:
    markers = {
        name for name, pattern in _CONDITION_PATTERNS.items()
        if re.search(pattern, text or "")
    }
    return markers, _measured_claims(text)


_CONTINUATION_RE = re.compile(r"^(?:다만|단서|예외적으로|단,)")


def _overlaps_answer(answer_tokens, answer_grams, source: str) -> bool:
    source_tokens = local_reasoner._tokens(source)
    source_grams = local_reasoner._chargrams(source)
    token_overlap = len(answer_tokens & source_tokens) / max(1, min(len(answer_tokens), 10))
    gram_overlap = len(answer_grams & source_grams) / max(
        1, min(len(answer_grams), len(source_grams))
    )
    return token_overlap >= 0.34 or gram_overlap >= 0.48


def _missing_conditions(question: str, answer: str, context: str) -> list[dict]:
    """답변과 직접 겹치는 근거가 가진 핵심 조건·예외가 빠졌는지 찾는다.

    "단, ~인 경우" 처럼 예외 조건이 원래 진술과 별도 문장으로 붙는 경우, 그 문장
    자체는 답변과 어휘가 거의 겹치지 않아(연결어·다른 대상 표현 위주) 기존
    겹침 검사만으로는 걸러졌다. 같은 근거 블록에서 답변과 직접 겹치는 문장
    바로 뒤에 "다만/단서/예외적으로"로 시작하는 문장이 붙어 있으면, 그 조건이
    직전 문장의 진술에 붙는 예외라고 보고 겹침 요건 없이도 함께 검사한다.
    """
    if not answer or not context or "```" in answer:
        return []
    answer_markers, answer_values = _condition_signature(answer)
    answer_tokens = local_reasoner._tokens(answer)
    answer_grams = local_reasoner._chargrams(answer)
    ranked = set(local_reasoner.select_evidence(question, context, limit=12))
    units = local_reasoner._evidence_units(context)
    missing, seen = [], set()
    previous_anchor = False
    previous_label = None
    for index, (source, _authority, label) in enumerate(units):
        # 서로 다른 근거 블록(예: 검색결과 1과 2)은 각기 다른 출처 라벨을 가지므로,
        # 라벨이 바뀌면 직전 문장을 앵커로 보지 않는다 — 그렇지 않으면 앞 블록의
        # 답변 관련 문장 바로 다음에 등장한, 전혀 무관한 다른 블록의 "다만" 문장을
        # 같은 진술의 예외로 잘못 붙이게 된다.
        if label != previous_label:
            previous_anchor = False
        direct_overlap = _overlaps_answer(answer_tokens, answer_grams, source)
        is_attached_exception = (
            not direct_overlap and previous_anchor
            and bool(_CONTINUATION_RE.match(source.strip()))
        )
        # 다음 반복에서 "이 문장이 답변과 직접 겹치는 앵커였는지"를 판단할 수
        # 있도록 갱신한다. 후보 대상(select_evidence)에도 있고 실제 겹침도
        # 있어야 다음 문장의 예외를 붙여도 될 만큼 확실한 앵커로 인정한다.
        previous_anchor = direct_overlap and source in ranked
        previous_label = label
        if source not in ranked and not is_attached_exception:
            continue
        if not (direct_overlap or is_attached_exception):
            continue
        source_markers, source_values = _condition_signature(source)
        if not source_markers:
            continue
        missing_markers = sorted(source_markers - answer_markers)
        # 조건 문장에 포함된 수치만 함께 보존한다. 금액·날짜가 우연히 같은 문서에
        # 있다는 이유만으로 모든 숫자를 조건으로 강제하지 않는다.
        missing_values = sorted(source_values - answer_values) if missing_markers else []
        if not missing_markers and not missing_values:
            continue
        compact = re.sub(r"^(?:내용|제목):\s*", "", " ".join(source.split())).strip()
        identity = _normalized(compact)
        if not compact or identity in seen:
            continue
        seen.add(identity)
        missing.append({
            "evidence": compact[:400],
            "missing_markers": missing_markers,
            "missing_values": missing_values,
        })
        if len(missing) >= 3:
            break
    return missing


def repair_missing_conditions(answer: str, quality: dict) -> dict:
    """빠진 적용 조건을 근거 문장 그대로 별도 구역에 보완한다."""
    missing = quality.get("missing_conditions", [])
    if not missing or "```" in (answer or ""):
        return {"answer": answer or "", "added": []}
    added = []
    normalized_answer = _normalized(answer)
    for item in missing:
        evidence = item.get("evidence", "").strip()
        if evidence and _normalized(evidence) not in normalized_answer and evidence not in added:
            added.append(evidence)
    if not added:
        return {"answer": answer or "", "added": []}
    repaired = (answer or "").rstrip() + "\n\n**반드시 함께 확인할 적용 조건**\n" + "\n".join(
        f"- {item}" for item in added
    )
    return {"answer": repaired, "added": added}


def format_condition_repair_note(repair: dict) -> str:
    added = repair.get("added", [])
    if not added:
        return ""
    return (
        "\n\n> 📌 **누락 조건 자동 보완**: 결론에 빠져 있던 적용 조건·예외 "
        f"{len(added)}개를 근거에서 복원했습니다. "
        "보완이 발생한 답변은 장기기억 후보로 저장하지 않습니다."
    )


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


def _polarity(text: str) -> int:
    """명시적인 가능·허용(+1) / 불가·금지(-1)만 보수적으로 판정한다."""
    value = text or ""
    if re.search(
        r"불가능|금지|허용되지|인정되지|적용되지|해당하지|"
        r"할\s*수\s*없|없(?:습니다|다|음)|아니(?:다|며|고|라고)|제외",
        value,
    ):
        return -1
    if re.search(
        r"(?<!불)가능|허용(?:됩니다|된다|함)|인정(?:됩니다|된다|함)|"
        r"적용(?:됩니다|된다|함)|해당(?:됩니다|된다|함)|할\s*수\s*있|"
        r"있(?:습니다|다|음)",
        value,
    ):
        return 1
    return 0


def _sentence_grounding(
    question: str, answer: str, context: str
) -> tuple[float, list[str], list[str]]:
    claims = _claim_sentences(answer)
    if not claims or not context:
        return (1.0 if context else 0.65), [], []
    evidence = local_reasoner.select_evidence(question, context, limit=8)
    if not evidence:
        return 0.0, claims, []

    unsupported, contradicted = [], []
    for claim in claims:
        claim_tokens = local_reasoner._tokens(claim)
        claim_grams = local_reasoner._chargrams(claim)
        claim_numbers = _measured_claims(claim)
        claim_polarity = _polarity(claim)
        supported = False
        opposite_seen = False
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
            semantic_match = (
                token_overlap >= 0.34 or gram_overlap >= 0.48
                or (numeric_match and topic_match)
            )
            if not semantic_match:
                continue
            source_polarity = _polarity(source)
            if claim_polarity and source_polarity and claim_polarity != source_polarity:
                opposite_seen = True
                continue
            if semantic_match:
                supported = True
                break
        if not supported:
            unsupported.append(claim)
            if opposite_seen:
                contradicted.append(claim)
    return (
        round(1.0 - len(unsupported) / max(1, len(claims)), 3),
        unsupported,
        contradicted,
    )


def repair_contradicted_sentences(
    question: str, answer: str, context: str, quality: dict
) -> dict:
    """근거와 방향이 반대인 문장을 출력 전 제거하고, 빈 답변이면 근거로 복구한다."""
    contradicted = quality.get("contradicted_sentences", [])
    if not contradicted or "```" in (answer or ""):
        return {"answer": answer or "", "removed": [], "recovered": False}
    repaired = answer or ""
    removed = []
    for sentence in contradicted:
        if sentence in repaired:
            repaired = repaired.replace(sentence, "")
            removed.append(sentence)
    repaired = re.sub(r"(?m)^\s*(?:[-*]|\d+[.)])\s*$", "", repaired)
    repaired = re.sub(r"\n{3,}", "\n\n", repaired).strip()
    recovered = False
    if len(_normalized(repaired)) < 8:
        recovered = True
        if re.search(r"신뢰\s*수준:\s*conflict", context or "", re.IGNORECASE):
            repaired = "확인된 자료끼리 결론이 달라 현재 내용만으로는 확정할 수 없습니다."
        else:
            # 질문 일반 유사도만으로 고르면 함께 들어온 과거 KB 문장이 공식 검색
            # 근거보다 앞설 수 있다. 제거된 문장과 주제가 같고 방향만 반대인 근거를
            # 우선 골라, 실제로 모순을 발견하게 한 문장으로 복구한다.
            evidence_pool = local_reasoner.select_evidence(question, context, limit=12)
            replacements = []
            for removed_sentence in removed:
                removed_tokens = local_reasoner._tokens(removed_sentence)
                removed_grams = local_reasoner._chargrams(removed_sentence)
                removed_polarity = _polarity(removed_sentence)
                ranked = []
                for source in evidence_pool:
                    source_polarity = _polarity(source)
                    if not removed_polarity or source_polarity != -removed_polarity:
                        continue
                    token_overlap = len(removed_tokens & local_reasoner._tokens(source)) / max(
                        1, min(len(removed_tokens), 8)
                    )
                    source_grams = local_reasoner._chargrams(source)
                    gram_overlap = len(removed_grams & source_grams) / max(
                        1, min(len(removed_grams), len(source_grams))
                    )
                    if token_overlap >= 0.34 or gram_overlap >= 0.48:
                        ranked.append((token_overlap + gram_overlap, source))
                if ranked:
                    best = max(ranked, key=lambda item: item[0])[1]
                    if best not in replacements:
                        replacements.append(best)
            evidence = replacements or local_reasoner.select_evidence(question, context, limit=3)
            repaired = (
                "**확인된 자료 기준**\n"
                + "\n".join(f"- {' '.join(item.split())[:300]}" for item in evidence)
                if evidence else
                "현재 자료에서 확정 가능한 내용을 찾지 못했습니다. 추가 확인이 필요합니다."
            )
    return {"answer": repaired, "removed": removed, "recovered": recovered}


def format_contradiction_repair_note(repair: dict) -> str:
    removed = repair.get("removed", [])
    if not removed:
        return ""
    return (
        "\n\n> 🛡️ **근거 반대 문장 차단**: 참고 자료와 결론 방향이 반대인 문장 "
        f"{len(removed)}개를 출력 전에 제거했습니다. "
        + ("확인된 근거만으로 답변을 다시 구성했습니다. " if repair.get("recovered") else "")
        + "차단이 발생한 답변은 장기기억 후보로 저장하지 않습니다."
    )


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
    sentence_grounding, unsupported_sentences, contradicted_sentences = _sentence_grounding(
        question, answer, context
    )
    missing_conditions = _missing_conditions(question, answer, context)
    groundedness = min(aggregate_groundedness, sentence_grounding) if context_tokens \
        else aggregate_groundedness
    if unsupported_sentences:
        issues.append(
            f"자료로 뒷받침되지 않은 사실 문장 {len(unsupported_sentences)}개"
        )
    if contradicted_sentences:
        issues.append(
            f"참고 자료와 결론 방향이 반대인 문장 {len(contradicted_sentences)}개"
        )
    if missing_conditions:
        issues.append(f"근거의 적용 조건·예외 누락 {len(missing_conditions)}개")
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
        "contradicted_sentences": contradicted_sentences[:5],
        "missing_conditions": missing_conditions,
        "sentence_grounding": sentence_grounding,
        "conversation_consistency": conversation_consistency,
        "evidence_confidence": evidence_confidence,
        "should_block_learning": (
            score < 0.55 or bool(unsupported) or bool(unsupported_sentences)
            or bool(contradicted_sentences)
            or bool(missing_conditions)
            or evidence_confidence in {"limited", "low", "conflict"}
        ),
        "should_warn": (
            score < 0.4 or bool(unsupported_sentences) or bool(contradicted_sentences)
            or bool(missing_conditions)
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
