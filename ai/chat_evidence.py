"""채팅 생성 경로의 근거 컨텍스트·검증·표시를 한곳에서 조립한다.

네트워크 검색과 토큰 스트리밍은 ``main.py``가 담당하고, 이 모듈은 입력을 받아
결과만 반환하는 순수한 조립 계층으로 유지한다. 일반 답변과 주식 답변이 동일한
검색 근거 묶음과 품질 가드를 사용하게 해 경로별 판정 불일치를 막는다.
"""
from dataclasses import dataclass

import response_quality
import search as srch


@dataclass(frozen=True)
class PreparedEvidence:
    """한 생성 답변에서 끝까지 공유하는 근거 상태."""

    context: str
    references: list[dict]
    bundle: dict

    @property
    def results(self) -> list[dict]:
        return self.bundle.get("results", [])

    @property
    def validation(self) -> dict:
        return self.bundle.get("validation", {})


def _law_references(law_results: list[dict]) -> list[dict]:
    return [
        {
            "title": result.get("title", ""),
            "url": result.get("url", ""),
            "source_label": "공식 법령",
        }
        for result in law_results
        if result.get("url")
    ]


def prepare_standard(
    query: str,
    intent_context: str,
    memory_conflict_context: str,
    law_context: str,
    rag_context: str,
    law_results: list[dict],
    search_bundle: dict,
) -> PreparedEvidence:
    """일반 채팅의 컨텍스트와 참고자료를 동일한 근거 묶음에서 만든다."""
    search_context = search_bundle.get("context", "")
    raw_context = "\n\n".join(filter(None, [
        memory_conflict_context, law_context, rag_context, search_context,
    ]))
    if raw_context:
        context = (
            (intent_context + "\n\n" if intent_context else "")
            + f"[주의: 아래 참고 자료 중 사용자 질문 '{query[:60]}'"
              "와 직접 관련된 내용만 사용하세요. "
              "질문 주제와 다른 내용(다른 법 조항, 다른 HR 주제 등)은 답변에 포함하지 마세요. "
              "자료에 명시된 수치·사실만 인용하고, 자료에 없는 내용은 절대 만들어내지 마세요. "
              "불확실하거나 자료 밖의 내용은 '확인 필요' 또는 '자료에서 확인되지 않음'으로 표시하세요. "
              "법령 원문·웹검색 결과 등 출처를 답변에서 간략히 언급하세요.]\n\n"
            + raw_context
        )
    else:
        context = intent_context

    references = _law_references(law_results) if law_context else []
    references.extend(search_bundle.get("references", []))
    return PreparedEvidence(context, references, search_bundle)


def prepare_stock(
    query: str,
    intent_context: str,
    stock_report_context: str,
    broker_context: str,
    news_context: str,
    search_bundle: dict,
    broker_references: list[dict] | None = None,
) -> tuple[PreparedEvidence, list[str]]:
    """주식 채팅의 자료별 레이블과 생성 컨텍스트를 일관된 순서로 조립한다."""
    search_context = search_bundle.get("context", "")
    source_labels = []
    context_parts = []
    if stock_report_context:
        source_labels.append("📋 최근 분석 보고서")
        context_parts.append(f"[최근 주식 분석 보고서]\n{stock_report_context}")
    if broker_context:
        source_labels.append("📊 증권사 애널리스트 리포트")
        context_parts.append(f"[증권사 애널리스트 리포트 컨센서스]\n{broker_context}")
    if news_context:
        source_labels.append("📰 최신 뉴스·기사")
        context_parts.append(f"[최신 뉴스·기사]\n{news_context}")
    if search_context:
        source_labels.append("🌐 실시간 인터넷 검색")
        context_parts.append(f"[실시간 인터넷 검색 결과]\n{search_context}")
    source_labels.append("🧠 AI 주식 전문 지식")

    if context_parts:
        context = (
            (intent_context + "\n\n" if intent_context else "")
            + f"[아래 자료를 참고해 사용자 질문 '{query[:60]}'에 답변하세요. "
              "각 자료의 출처 레이블(예: [최신 뉴스], [증권사 리포트])을 답변 내에 명시하여 "
              "사용자가 어느 자료에서 나온 정보인지 알 수 있게 하세요. "
              "자료에 명시된 수치·사실만 사용하고, 자료에 없는 구체적 수치는 추측하지 마세요. "
              "불확실한 내용은 '자료에서 확인되지 않음'으로 명시하세요.]\n\n"
            + "\n\n---\n\n".join(context_parts)
        )
    else:
        context = ""

    references = list(broker_references or [])
    references.extend(search_bundle.get("references", []))
    return PreparedEvidence(context, references, search_bundle), source_labels


def guard_generated_answer(query: str, answer: str, evidence: PreparedEvidence) -> dict:
    """미리 계산한 근거 판정을 재사용해 생성 답변을 교정한다."""
    return response_quality.apply_evidence_guard(
        query,
        answer,
        evidence.context,
        evidence.results,
        evidence_validation=evidence.validation,
    )


def evidence_notes(
    evidence: PreparedEvidence,
    answer_guard: dict,
    memory_search_validation: dict,
) -> list[str]:
    """사용자에게 보일 검증 안내를 실행 순서대로 반환한다."""
    notes = list(answer_guard.get("notes", []))
    for note in (
        evidence.bundle.get("note", ""),
        srch.format_memory_search_conflict_warning(memory_search_validation),
        srch.format_answer_claim_validation_note(
            answer_guard.get("claim_validation", {})
        ),
    ):
        if note:
            notes.append(note)
    return notes
