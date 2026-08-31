"""영구 저장 전에 민감정보를 탐지·마스킹하는 작은 독립 모듈.

LLM에 전달되거나 현재 응답으로 표시되는 텍스트는 바꾸지 않는다. 이 모듈은
대화 이력, 피드백, 문서, 장기기억 후보처럼 재사용되는 저장소에 비밀값이
누적되는 위험만 줄인다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class SensitiveFinding:
    kind: str
    label: str
    start: int
    end: int
    high_risk: bool = True


_PATTERNS = (
    ("resident_id", "주민등록번호", True,
     re.compile(r"(?<!\d)\d{6}[ -]?[1-8]\d{6}(?!\d)")),
    ("auth_header", "인증토큰", True,
     re.compile(r"(?i)\b(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/=-]{12,}")),
    ("api_token", "API키", True,
     re.compile(
         r"(?i)(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|"
         r"github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})"
     )),
    ("secret_assignment", "비밀번호·비밀키", True,
     re.compile(
         r"(?i)(?:\b(?:password|passwd|pwd|api[_ -]?key|access[_ -]?token|secret)\b|"
         r"비밀번호|비밀키|인증토큰)"
         r"\s*[:=]\s*[\"']?[A-Za-z0-9!@#$%^&*()_+./=-]{8,}[\"']?"
     )),
    ("email", "이메일", False,
     re.compile(r"(?i)(?<![\w.+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![\w.-])")),
    ("phone", "전화번호", False,
     re.compile(r"(?<!\d)01[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)")),
)


def _luhn_valid(digits: str) -> bool:
    total = 0
    parity = len(digits) % 2
    for i, char in enumerate(digits):
        value = int(char)
        if i % 2 == parity:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def scan_sensitive_data(text: str) -> list[SensitiveFinding]:
    """텍스트에서 확실도가 높은 비밀값과 개인 연락처를 찾는다."""
    value = text or ""
    findings: list[SensitiveFinding] = []
    for kind, label, high_risk, pattern in _PATTERNS:
        findings.extend(
            SensitiveFinding(kind, label, match.start(), match.end(), high_risk)
            for match in pattern.finditer(value)
        )

    # 카드번호는 일반 숫자열 오탐을 줄이기 위해 Luhn 검증을 통과한 경우만 탐지한다.
    for match in re.finditer(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)", value):
        digits = re.sub(r"\D", "", match.group(0))
        if 13 <= len(digits) <= 19 and _luhn_valid(digits):
            findings.append(SensitiveFinding(
                "payment_card", "결제카드번호", match.start(), match.end(), True
            ))

    # 겹치는 패턴은 더 긴 범위를 우선하고 한 번만 마스킹한다.
    findings.sort(key=lambda item: (item.start, -(item.end - item.start)))
    selected: list[SensitiveFinding] = []
    for finding in findings:
        if any(finding.start < old.end and old.start < finding.end for old in selected):
            continue
        selected.append(finding)
    return selected


def sanitize_for_storage(text: str, include_contact: bool = False) -> tuple[str, list[str]]:
    """고위험 값(선택 시 연락처 포함)을 저장용 표식으로 치환한다."""
    value = text or ""
    findings = [
        finding for finding in scan_sensitive_data(value)
        if finding.high_risk or include_contact
    ]
    if not findings:
        return value, []

    labels: list[str] = []
    pieces, cursor = [], 0
    for finding in findings:
        pieces.append(value[cursor:finding.start])
        pieces.append(f"[민감정보:{finding.label}]")
        cursor = finding.end
        if finding.label not in labels:
            labels.append(finding.label)
    pieces.append(value[cursor:])
    return "".join(pieces), labels


def sensitive_labels(text: str, include_contact: bool = True) -> list[str]:
    """외부 노출 없이 탐지 종류만 반환한다."""
    labels: list[str] = []
    for finding in scan_sensitive_data(text):
        if (finding.high_risk or include_contact) and finding.label not in labels:
            labels.append(finding.label)
    return labels
