"""질문 난이도에 맞춰 답변 전 검토 수준을 보수적으로 선택한다."""
from __future__ import annotations

import re


_VALID_MODES = {"auto", "off", "prompt", "deep"}
_MODE_RANK = {"off": 0, "prompt": 1, "deep": 2}

_COMPLEX_SIGNALS = (
    "비교", "분석", "원인", "전략", "계획", "설계", "검토", "진단",
    "장단점", "트레이드오프", "우선순위", "대안", "최적", "개선", "리팩토링",
)
_HIGH_STAKES = (
    "법적 대응", "소송", "해고", "징계", "산재", "계약서", "합의서",
    "투자", "매수", "매도", "손절", "대출", "개인정보", "보안 사고",
    "데이터 삭제", "복구", "운영 장애", "실서비스 장애",
)
_MULTI_PART = re.compile(
    r"(?:그리고|동시에|각각|반면|하지만|또한|첫째|둘째|1\s*[.)]|2\s*[.)]|\bversus\b|\bvs\.?\b)",
    re.IGNORECASE,
)
_SIMPLE = re.compile(
    r"^(?:안녕|고마워|감사|잘\s*지내|도움말|뭐해|누구야)[!.?\s]*$",
    re.IGNORECASE,
)


def choose_mode(
    text: str,
    requested_mode: str = "auto",
    *,
    persona: str = "",
    persona_prefers_thinking: bool = False,
    is_shared: bool = False,
) -> dict:
    """내부 추론을 만들지 않고 입력의 구조적 신호만으로 검토 수준을 정한다."""
    requested = requested_mode if requested_mode in _VALID_MODES else "auto"

    # 사내 규정은 등록 문서를 그대로 제공하는 폐쇄형 경로라 LLM 재해석을 금한다.
    if persona == "company":
        return {
            "mode": "off", "automatic": requested == "auto", "score": 0,
            "reason": "사내 문서 직접 답변",
        }

    if requested != "auto":
        mode = requested
        reason = "사용자 직접 선택"
        if is_shared and mode == "deep":
            mode, reason = "prompt", "공유 대화 1회 검토 제한"
        return {"mode": mode, "automatic": False, "score": 0, "reason": reason}

    value = (text or "").strip()
    if not value or _SIMPLE.fullmatch(value):
        return {"mode": "off", "automatic": True, "score": 0, "reason": "간단한 대화"}

    score = 0
    reasons: list[str] = []
    length = len(value)
    if length >= 120:
        score += 2
        reasons.append("긴 요청")
    elif length >= 55:
        score += 1
        reasons.append("상세 요청")

    complex_count = sum(1 for signal in _COMPLEX_SIGNALS if signal in value)
    if complex_count:
        score += min(complex_count + 1, 3)
        reasons.append("분석·의사결정")
    if _MULTI_PART.search(value) or value.count("?") >= 2:
        score += 1
        reasons.append("복수 조건")
    if any(signal in value for signal in _HIGH_STAKES):
        score += 4
        reasons.append("중요 판단")
    if any(signal in value for signal in ("근거", "예외", "리스크", "반례", "검증")):
        score += 1
        reasons.append("근거 검토")
    if persona_prefers_thinking:
        score = max(score, 2)
        reasons.append("전문 분석 분야")

    mode = "deep" if score >= 4 else "prompt" if score >= 2 else "off"
    if is_shared and _MODE_RANK[mode] > _MODE_RANK["prompt"]:
        mode = "prompt"
        reasons.append("공유 대화 제한")
    return {
        "mode": mode,
        "automatic": True,
        "score": score,
        "reason": " · ".join(dict.fromkeys(reasons)) or "즉답 가능",
    }


def direct_response_decision() -> dict:
    """계산·명령처럼 이미 결정적인 응답 경로는 추가 LLM 검토를 생략한다."""
    return {"mode": "off", "automatic": True, "score": 0, "reason": "직접 처리 가능한 요청"}
