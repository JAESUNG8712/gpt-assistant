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

    # 자동 모드에서는 모든 일반 질문이 최소 1회의 자체 검토를 거친다.
    # 계산·기억 명령·사내 원문처럼 생성형 판단이 불필요한 경로만 main에서
    # 별도의 결정형 검증 엔진으로 처리한다.
    mode = "deep" if score >= 4 else "prompt"
    if is_shared and _MODE_RANK[mode] > _MODE_RANK["prompt"]:
        mode = "prompt"
        reasons.append("공유 대화 제한")
    return {
        "mode": mode,
        "automatic": True,
        "score": score,
        "reason": " · ".join(dict.fromkeys(reasons)) or "전 질문 기본 자체 검토",
    }


def direct_response_decision() -> dict:
    """계산·명령은 생성형 호출 대신 전용 결정형 엔진으로 결과를 검증한다."""
    return {"mode": "off", "automatic": True, "score": 0, "reason": "결정형 엔진 자체 검증"}


def ambiguity_response_decision() -> dict:
    """모호한 질문은 임의 답변하지 않고 선택지를 만드는 자체 검증 결과다."""
    return {"mode": "off", "automatic": True, "score": 0, "reason": "질문 모호성 자체 검증"}


def specialist_response_decision() -> dict:
    """주식 수집·분석 같은 전용 파이프라인은 그 자체가 다단계 판단 엔진이다."""
    return {"mode": "off", "automatic": True, "score": 0, "reason": "전문 분석 엔진 자체 검증"}
