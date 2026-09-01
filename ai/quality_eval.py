"""운영 지식 엔진을 대상으로 하는 결정론적 검색 품질 평가."""

from datetime import datetime

import engine


DEFAULT_CASES = [
    {"name": "퇴직금", "persona": "hr", "query": "퇴직금 계산 방법", "expected_any": ["퇴직금"]},
    {"name": "연차휴가", "persona": "company", "query": "연차휴가는 어떻게 사용하나요", "expected_any": ["연차"]},
    {"name": "FastAPI 스트리밍", "persona": "dev", "query": "FastAPI 스트리밍 응답", "expected_any": ["stream", "스트리밍"]},
    {"name": "여행자보험", "persona": "travel", "query": "해외여행 보험 가입", "expected_any": ["보험"]},
    {"name": "자기소개서", "persona": "resume", "query": "자기소개서 작성 방법", "expected_any": ["자기소개서"]},
    {"name": "최저임금", "persona": "hr", "query": "최저임금 위반 신고", "expected_any": ["최저임금"]},
]


def _clean_case(raw: dict, index: int) -> dict:
    query = str(raw.get("query") or "").strip()[:500]
    if not query:
        raise ValueError(f"평가 케이스 {index + 1}: query가 필요합니다.")
    return {
        "name": str(raw.get("name") or f"case-{index + 1}").strip()[:100],
        "persona": str(raw.get("persona") or "").strip()[:40],
        "query": query,
        "expected_any": [
            str(item).strip().lower()[:100]
            for item in (raw.get("expected_any") or [])[:20] if str(item).strip()
        ],
        "forbidden_any": [
            str(item).strip().lower()[:100]
            for item in (raw.get("forbidden_any") or [])[:20] if str(item).strip()
        ],
    }


def run(cases: list | None = None, min_score: float = 0.15,
        required_pass_rate: float = 0.8) -> dict:
    raw_cases = cases if cases else DEFAULT_CASES
    if len(raw_cases) > 200:
        raise ValueError("한 번에 평가할 수 있는 케이스는 최대 200개입니다.")
    min_score = max(0.0, min(float(min_score), 1.0))
    required_pass_rate = max(0.0, min(float(required_pass_rate), 1.0))
    knowledge_engine = engine.get_engine()
    results = []

    for index, raw in enumerate(raw_cases):
        case = _clean_case(raw, index)
        matches = knowledge_engine.search(
            case["query"], n=1, persona=case["persona"] or None, min_score=0.0,
        )
        top_q, top_a, score, meta = matches[0] if matches else ("", "", 0.0, {})
        searchable = (top_q + "\n" + top_a).lower()
        expected_hit = (
            not case["expected_any"]
            or any(term in searchable for term in case["expected_any"])
        )
        forbidden_hits = [term for term in case["forbidden_any"] if term in searchable]
        reasons = []
        if score < min_score:
            reasons.append(f"점수 {score:.3f} < {min_score:.3f}")
        if not expected_hit:
            reasons.append("기대 키워드 미검출")
        if forbidden_hits:
            reasons.append("금지 키워드 검출: " + ", ".join(forbidden_hits))
        passed = not reasons
        results.append({
            "name": case["name"], "persona": case["persona"], "passed": passed,
            "score": round(float(score), 4), "top_question": top_q[:300],
            "top_source": str(meta.get("source") or "")[:120], "reasons": reasons,
            "retrieval": str(meta.get("retrieval") or "lexical"),
        })

    passed_count = sum(1 for item in results if item["passed"])
    total = len(results)
    pass_rate = passed_count / total if total else 0.0
    return {
        "status": "passed" if pass_rate >= required_pass_rate else "failed",
        "total": total, "passed": passed_count,
        "pass_rate": round(pass_rate, 4),
        "required_pass_rate": round(required_pass_rate, 4),
        "min_score": round(min_score, 4),
        "cases": results, "evaluated_at": datetime.now().isoformat(),
        "suite": "custom" if cases else "default-v1",
    }
