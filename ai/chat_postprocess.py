"""채팅 답변 품질 평가, 저장, 기억 후보 판정을 담당한다."""
from dataclasses import dataclass, field
import re

import local_gen
import memory as mem
import response_quality
from engine import LOCAL_FALLBACK_MARKER
from local_reasoner import LOCAL_REASONING_MARKER


@dataclass(frozen=True)
class LearningDecision:
    eligible: bool
    reasons: list[str] = field(default_factory=list)
    source: str = ""
    evidence: list[dict] = field(default_factory=list)


def evaluate_generated_answer(
    enabled: bool,
    question: str,
    answer: str,
    context: str,
    previous_answer: str,
) -> tuple[dict, str]:
    """생성 답변만 품질 평가하고 필요하면 사용자 경고문도 함께 반환한다."""
    if not enabled:
        return {"should_block_learning": False, "should_warn": False}, ""
    quality = response_quality.evaluate(question, answer, context, previous_answer)
    warning = (
        response_quality.format_warning(quality, question, context)
        if quality.get("should_warn") else ""
    )
    return quality, warning


def clean_reply(text: str) -> str:
    """모델 내부 사고 태그가 대화 이력과 기억 후보로 전파되지 않게 제거한다."""
    return re.sub(r"<think>[\s\S]*?</think>\s*", "", text).strip()


def quality_metadata(
    answer_quality: dict, learning_decision: LearningDecision | None = None
) -> dict | None:
    metadata = {}
    if "score" in answer_quality:
        metadata["answer_quality"] = {
            "score": answer_quality.get("score"),
            "grade": answer_quality.get("grade", ""),
            "issues": answer_quality.get("issues", [])[:5],
            "learning_blocked": answer_quality.get("should_block_learning", False),
        }
    if learning_decision is not None:
        metadata["learning_decision"] = {
            "eligible": learning_decision.eligible,
            "blocked_reasons": learning_decision.reasons,
            "candidate_source": learning_decision.source,
        }
    return metadata or None


def _candidate_source(law_context: str, search_context: str, rag_context: str) -> str:
    if law_context:
        return "법령실시간"
    if search_context:
        return "웹검색보강"
    if rag_context:
        return "KB보강생성"
    return "생성답변"


def _learning_evidence(references: list[dict], top_memory_source: str) -> list[dict]:
    """실제로 추적 가능한 외부 URL만 중복 없이 기억 후보 근거로 보존한다."""
    evidence, seen = [], set()
    for reference in references:
        url = str(reference.get("url") or "").strip()
        if not url.startswith(("http://", "https://")) or url in seen:
            continue
        seen.add(url)
        item = {
            "title": str(reference.get("title") or "").strip(),
            "url": url,
            "type": "external_reference",
        }
        for key in ("source_label", "freshness", "date_evidence"):
            value = str(reference.get(key) or "").strip()
            if value:
                item[key] = value
        evidence.append(item)
    if top_memory_source:
        evidence.append({
            "title": f"기존 기억: {top_memory_source}",
            "type": "memory_context",
        })
    return evidence


def decide_learning(
    *,
    is_shared_session: bool,
    is_new_synthesized_answer: bool,
    reply: str,
    stock_mode: bool,
    memory_search_validation: dict,
    answer_guard: dict,
    answer_quality: dict,
    law_context: str,
    search_context: str,
    rag_context: str,
    references: list[dict],
    top_memory_source: str,
) -> LearningDecision:
    """기억 후보 저장 여부와 차단 이유를 누락 없이 한곳에서 판정한다."""
    reasons = []
    if is_shared_session:
        reasons.append("shared_session")
    if not is_new_synthesized_answer:
        reasons.append("not_synthesized")
    if not reply.strip():
        reasons.append("empty_answer")
    if stock_mode:
        reasons.append("volatile_stock_answer")
    if memory_search_validation.get("conflicts"):
        reasons.append("memory_search_conflict")
    if answer_guard.get("should_block_learning"):
        reasons.append("evidence_guard")
    if answer_quality.get("should_block_learning"):
        reasons.append("quality_guard")
    if LOCAL_FALLBACK_MARKER in reply:
        reasons.append("raw_fallback")
    if local_gen.MARKER_TAG in reply:
        reasons.append("local_generation")
    if LOCAL_REASONING_MARKER in reply:
        reasons.append("local_reasoning")

    return LearningDecision(
        eligible=not reasons,
        reasons=reasons,
        source=_candidate_source(law_context, search_context, rag_context),
        evidence=_learning_evidence(references, top_memory_source),
    )


def persist(
    *,
    user_message: str,
    assistant_reply: str,
    candidate_reply: str,
    persona_id: str,
    session_scope: str,
    command_status: dict,
    answer_quality: dict,
    learning_decision: LearningDecision,
    memory_store=mem,
) -> int | None:
    """대화 저장 후 허용된 답변만 검토 대기 기억 후보로 보낸다."""
    memory_store.save_message(
        "user", user_message, persona=persona_id, session_id=session_scope,
        command_status=command_status,
    )
    memory_store.save_message(
        "assistant", assistant_reply, persona=persona_id, session_id=session_scope,
        command_status=quality_metadata(answer_quality, learning_decision),
    )
    if not learning_decision.eligible:
        return None
    return memory_store.auto_learn(
        user_message,
        candidate_reply,
        persona=persona_id,
        session_id=session_scope,
        source=learning_decision.source,
        evidence=learning_decision.evidence,
    )
