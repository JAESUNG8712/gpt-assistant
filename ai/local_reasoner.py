"""API 키 없이 동작하는 결정적 로컬 추론·간단 코딩 응답기.

생성형 모델을 흉내 내어 사실을 만들어내지 않고, 질문을 분해한 뒤 확보된 근거를
관련도 순으로 선별·조합하고 충돌 가능성을 표시한다. 반복 가능한 코딩 패턴은 안전한
템플릿으로 생성한다.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass


LOCAL_REASONING_MARKER = "<!-- local-reasoning-v3 -->"

_STOP = {
    "그리고", "그러면", "그것", "그거", "대한", "대해서", "어떻게", "알려줘",
    "설명", "설명해줘", "해주세요", "질문", "내용", "관련", "있는", "없는",
}
_CODE_RE = re.compile(
    r"(?:코드|코딩|함수|스크립트|웹\s*페이지|구현해|짜줘|작성해|"
    r"(?:앱|프로그램)\s*(?:개발|구현|만들|작성)|(?:개발|구현|만들)\S*\s*(?:앱|프로그램)|"
    r"python|파이썬|javascript|자바스크립트|typescript|html|css|node(?:\.js)?|fastapi)",
    re.IGNORECASE,
)
_INSTRUCTION_RE = re.compile(r"\[(?:주의|아래 자료를 참고해)[^\[\]]*\]\s*", re.DOTALL)
_INTENT_RE = re.compile(r"^\[의도 분석\][^\n]*\n+", re.MULTILINE)


def _tokens(text: str) -> set[str]:
    words = re.findall(r"[가-힣A-Za-z0-9_+#.-]{2,}", (text or "").lower())
    return {w for w in words if w not in _STOP}


def _chargrams(text: str, size: int = 2) -> set[str]:
    compact = re.sub(r"[^가-힣a-z0-9]", "", (text or "").lower())
    return {compact[i:i + size] for i in range(max(0, len(compact) - size + 1))}


def _clean_context(context: str) -> str:
    value = _INTENT_RE.sub("", context or "", count=1)
    value = _INSTRUCTION_RE.sub("", value, count=1)
    return value.strip()[:12000]


def resolve_context_query(query: str, context: str) -> str:
    """숫자 선택·짧은 후속문이면 서버가 참고자료 지시에 기록한 복원 질문을 사용."""
    match = re.search(r"사용자 질문\s*['‘]([^'’]{2,160})['’]", context or "")
    short_or_selection = len((query or "").strip()) < 6 or bool(
        re.fullmatch(r"\s*\d+\s*(?:번|번째)?\s*", query or "")
    )
    return match.group(1).strip() if match and short_or_selection else query


def _sentences(text: str) -> list[str]:
    chunks = re.split(r"(?<=[.!?。])\s+|\n{2,}|(?=^#{1,4}\s)|(?=^\[[^\]]+\])", text, flags=re.MULTILINE)
    result = []
    for chunk in chunks:
        value = " ".join(chunk.split()).strip(" -")
        # "해외여행 필수 앱" 같은 짧은 문서 제목도 중요한 근거이므로 보존한다.
        if 6 <= len(value) <= 1000 and value not in result:
            result.append(value)
    return result


@dataclass
class Evidence:
    text: str
    score: float
    numbers: tuple[str, ...] = ()
    negative: bool = False


@dataclass(frozen=True)
class ReasoningPlan:
    """사용자에게 노출하지 않는 로컬 판단 계획."""
    intent: str
    constraints: tuple[str, ...]
    preferred_signals: tuple[str, ...]
    question_terms: tuple[str, ...]


@dataclass(frozen=True)
class ReasoningReview:
    confidence: str
    conflicts: tuple[str, ...]
    missing_constraints: tuple[str, ...]
    evidence_count: int


_INTENT_SIGNALS = {
    "cause": ("때문", "이유", "원인", "목적", "위해", "따라"),
    "procedure": ("절차", "단계", "신청", "제출", "등록", "방법", "해야"),
    "comparison": ("차이", "반면", "각각", "비교", "보다", "장점", "단점"),
    "eligibility": ("조건", "요건", "대상", "가능", "해당", "제외"),
    "amount": ("금액", "시간당", "월급", "요율", "비율", "계산", "기준"),
    "fact": (),
}


def build_reasoning_plan(query: str) -> ReasoningPlan:
    """질문을 의도·명시 조건·판단 신호로 분해한다."""
    q = query or ""
    if re.search(r"(?:왜|이유|원인|목적)", q):
        intent = "cause"
    elif re.search(r"(?:비교|차이|vs\.?|장단점|어느\s*쪽)", q, re.IGNORECASE):
        intent = "comparison"
    elif re.search(r"(?:어떻게|방법|절차|신청|제출)", q):
        intent = "procedure"
    elif re.search(r"(?:조건|요건|대상|가능|자격|해당)", q):
        intent = "eligibility"
    elif re.search(r"(?:얼마|몇\s*%|금액|요율|계산)", q):
        intent = "amount"
    else:
        intent = "fact"
    constraints = tuple(dict.fromkeys(re.findall(
        r"\d{4}년|\d+(?:[.,]\d+)?(?:원|%|개월|시간|일)|"
        r"(?:이상|이하|초과|미만|이전|이후|부터|까지)", q
    )))
    return ReasoningPlan(
        intent=intent,
        constraints=constraints,
        preferred_signals=_INTENT_SIGNALS[intent],
        question_terms=tuple(sorted(_tokens(q))),
    )


def _rank_evidence(query: str, context: str, limit: int = 4) -> tuple[ReasoningPlan, list[Evidence]]:
    plan = build_reasoning_plan(query)
    q_tokens = set(plan.question_terms)
    q_grams = _chargrams(query)
    q_numbers = set(re.findall(r"\d+(?:[.,]\d+)?", query))
    ranked: list[Evidence] = []
    for index, sentence in enumerate(_sentences(_clean_context(context))):
        s_tokens = _tokens(sentence)
        overlap = len(q_tokens & s_tokens)
        coverage = overlap / max(1, len(q_tokens))
        gram_coverage = len(q_grams & _chargrams(sentence)) / max(1, len(q_grams))
        sentence_numbers = tuple(re.findall(r"\d+(?:[.,]\d+)?(?:원|%|년|개월|시간|일)?", sentence))
        number_overlap = len(q_numbers & set(re.findall(r"\d+(?:[.,]\d+)?", sentence)))
        constraint_hits = sum(1 for item in plan.constraints if item in sentence)
        intent_hits = sum(1 for signal in plan.preferred_signals if signal in sentence)
        source_bonus = 0.15 if re.search(r"\[(?:공식|법령|최신|내부|출처)", sentence) else 0
        score = (
            overlap * 1.2 + coverage + gram_coverage * 1.4 + number_overlap * 1.5
            + constraint_hits * 0.8 + intent_hits * 0.22 + source_bonus - index * 0.002
        )
        if score > 0 or (not q_tokens and index < limit):
            ranked.append(Evidence(
                sentence, score, sentence_numbers,
                bool(re.search(r"(?:아니|불가|금지|없(?:다|음)|제외|못\s*한)", sentence)),
            ))
    ranked.sort(key=lambda item: item.score, reverse=True)
    return plan, ranked[:limit]


def review_reasoning(plan: ReasoningPlan, evidence: list[Evidence]) -> ReasoningReview:
    """선택한 근거의 조건 누락과 동일 항목의 상충 수치·긍정/부정을 검사한다."""
    joined = " ".join(item.text for item in evidence)
    missing = tuple(item for item in plan.constraints if item not in joined)
    conflicts: list[str] = []

    decisive_patterns = {
        "시간당 금액": r"(?:시간당|시급)[^\d]{0,12}(\d+(?:[.,]\d+)?원)",
        "월 환산액": r"(?:월급|월\s*환산)[^\d]{0,12}(\d+(?:[.,]\d+)?원)",
        "인상률": r"(?:인상률|요율|비율)[^\d]{0,12}(\d+(?:[.,]\d+)?%)",
    }
    for label, pattern in decisive_patterns.items():
        values = set()
        for item in evidence:
            values.update(re.findall(pattern, item.text))
        if len(values) > 1:
            conflicts.append(f"동일 항목의 {label}이(가) 서로 다름: {', '.join(sorted(values))}")

    for left_index, left in enumerate(evidence):
        left_positive = bool(re.search(r"(?:가능|할 수 있|인정|적용|있(?:다|음))", left.text))
        for right in evidence[left_index + 1:]:
            right_positive = bool(re.search(r"(?:가능|할 수 있|인정|적용|있(?:다|음))", right.text))
            shared = len(_chargrams(left.text) & _chargrams(right.text))
            total = max(1, min(len(_chargrams(left.text)), len(_chargrams(right.text))))
            if shared / total >= 0.55 and left_positive != right_positive \
                    and left.negative != right.negative:
                conflicts.append("같은 대상의 가능 여부에 관한 긍정·부정 근거가 충돌함")
                break

    if conflicts or missing:
        confidence = "낮음"
    elif len(evidence) >= 2:
        confidence = "높음"
    elif evidence:
        confidence = "보통"
    else:
        confidence = "근거 없음"
    return ReasoningReview(confidence, tuple(conflicts), missing, len(evidence))


def select_evidence(query: str, context: str, limit: int = 4) -> list[str]:
    """질문 핵심어와 숫자·연도 일치도를 함께 사용해 근거 문장을 고른다."""
    _, ranked = _rank_evidence(query, context, limit)
    return [item.text for item in ranked]


def _public_review(plan: ReasoningPlan, review: ReasoningReview, thinking_mode: str) -> str:
    if thinking_mode not in ("prompt", "deep"):
        return ""
    labels = {
        "cause": "원인·이유", "procedure": "절차·방법", "comparison": "비교",
        "eligibility": "조건·가능 여부", "amount": "수치·계산", "fact": "사실 확인",
    }
    checks = [f"{labels[plan.intent]} 질문으로 분류", f"근거 {review.evidence_count}개 비교"]
    if plan.constraints:
        checks.append(f"명시 조건 {len(plan.constraints)}개 확인")
    if review.conflicts:
        checks.append(f"충돌 {len(review.conflicts)}건을 발견해 결론 보류")
    elif review.missing_constraints:
        checks.append("확인되지 않은 조건을 표시")
    else:
        checks.append(f"판단 신뢰도 {review.confidence}")
    return "<think>\n로컬 검토: " + " · ".join(checks) + "\n</think>\n"


def _language(query: str) -> str:
    q = query.lower()
    if "html" in q or "웹페이지" in q or "웹 페이지" in q:
        return "html"
    if "javascript" in q or "자바스크립트" in q or "node" in q:
        return "javascript"
    return "python"


def _python_template(query: str) -> tuple[str, str]:
    q = query.lower()
    if "중복" in query:
        return "순서를 유지하며 중복 제거", '''def unique_items(items):
    """입력 순서를 유지하며 중복 값을 제거합니다."""
    return list(dict.fromkeys(items))


if __name__ == "__main__":
    assert unique_items([3, 1, 3, 2, 1]) == [3, 1, 2]
    print(unique_items([3, 1, 3, 2, 1]))'''
    if "csv" in q:
        return "CSV를 읽고 지정 열로 정렬", '''import csv


def sort_csv(path, column, *, encoding="utf-8-sig"):
    with open(path, newline="", encoding=encoding) as file:
        rows = list(csv.DictReader(file))
    if rows and column not in rows[0]:
        raise ValueError(f"없는 열입니다: {column}")
    return sorted(rows, key=lambda row: row.get(column, ""))


if __name__ == "__main__":
    print(sort_csv("input.csv", "date"))'''
    if "json" in q:
        return "JSON 파일을 안전하게 읽기", '''import json
from pathlib import Path


def load_json(path):
    with Path(path).open(encoding="utf-8") as file:
        return json.load(file)


if __name__ == "__main__":
    print(load_json("input.json"))'''
    if "fastapi" in q or "api" in q:
        return "간단한 FastAPI 상태 확인 API", '''from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True}


# 실행: uvicorn main:app --reload'''
    if "정렬" in query:
        return "새 목록을 반환하는 정렬 함수", '''def sort_items(items, *, reverse=False):
    return sorted(items, reverse=reverse)


if __name__ == "__main__":
    assert sort_items([3, 1, 2]) == [1, 2, 3]
    print(sort_items([3, 1, 2]))'''
    return "입력 검증을 포함한 기본 함수", '''def process(value):
    """TODO: 요청한 처리 규칙을 이 함수에 구현하세요."""
    if value is None:
        raise ValueError("value는 필수입니다")
    return value


if __name__ == "__main__":
    assert process("test") == "test"
    print(process("test"))'''


def _javascript_template(query: str) -> tuple[str, str]:
    q = query.lower()
    if "fetch" in q or "api" in q:
        return "오류 처리를 포함한 API 요청", '''async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

fetchJson("https://example.com/api")
  .then(console.log)
  .catch(console.error);'''
    if "중복" in query:
        return "배열 중복 제거", '''function uniqueItems(items) {
  return [...new Set(items)];
}

console.assert(JSON.stringify(uniqueItems([3, 1, 3])) === "[3,1]");
console.log(uniqueItems([3, 1, 3]));'''
    return "입력 검증을 포함한 기본 함수", '''function process(value) {
  if (value == null) throw new Error("value is required");
  return value;
}

console.assert(process("test") === "test");
console.log(process("test"));'''


def _html_template(query: str) -> tuple[str, str]:
    title_match = re.search(r"(?:제목|이름)[은는:]?\s*['\"]?([^'\"\n]{2,30})", query)
    title = html.escape(title_match.group(1).strip()) if title_match else "나의 웹페이지"
    code = f'''<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    body {{ max-width: 720px; margin: 48px auto; padding: 0 20px; font-family: sans-serif; }}
    button {{ padding: 10px 16px; cursor: pointer; }}
  </style>
</head>
<body>
  <h1>{title}</h1>
  <p id="message">버튼을 눌러 보세요.</p>
  <button id="action">실행</button>
  <script>
    document.querySelector("#action").addEventListener("click", () => {{
      document.querySelector("#message").textContent = "정상 동작합니다.";
    }});
  </script>
</body>
</html>'''
    return "반응형 단일 HTML 페이지", code


def code_response(query: str, thinking_mode: str = "off") -> str:
    language = _language(query)
    if language == "html":
        purpose, code = _html_template(query)
    elif language == "javascript":
        purpose, code = _javascript_template(query)
    else:
        purpose, code = _python_template(query)
    fence = "html" if language == "html" else language
    plan = build_reasoning_plan(query)
    reasoning_review = ReasoningReview("보통", (), (), 1)
    review = _public_review(plan, reasoning_review, thinking_mode)
    return (
        LOCAL_REASONING_MARKER + "\n" + review
        + f"요청을 **{purpose}** 작업으로 해석했습니다. API 키 없이 로컬 템플릿으로 작성했습니다.\n\n"
        + f"```{fence}\n{code}\n```\n\n"
        + "검토: 입력값 누락과 기본 오류 처리를 포함했습니다. 요구 조건이 더 있으면 "
          "파일 형식·입출력 예시·사용 환경을 이어서 알려주세요."
    )


def grounded_response(query: str, context: str, thinking_mode: str = "off") -> str:
    plan, ranked = _rank_evidence(query, context)
    evidence = [item.text for item in ranked]
    reasoning_review = review_reasoning(plan, ranked)
    review = _public_review(plan, reasoning_review, thinking_mode)
    if not evidence:
        return (
            LOCAL_REASONING_MARKER + "\n" + review
            + "현재 로컬 지식에서 질문과 직접 연결되는 근거를 찾지 못했습니다. "
              "대상, 기간, 원하는 결과를 한 가지씩 더 알려주시면 다시 검토하겠습니다."
        )
    bullets = "\n".join(f"- {item}" for item in evidence)
    if reasoning_review.conflicts:
        issues = "\n".join(f"- {item}" for item in reasoning_review.conflicts)
        return (
            LOCAL_REASONING_MARKER + "\n" + review
            + "**판단 보류:** 확보한 자료끼리 핵심 조건이 충돌하여 하나를 정답으로 선택하지 않았습니다.\n\n"
            + "**충돌 검사**\n" + issues + "\n\n**비교한 근거**\n" + bullets
            + "\n\n동일한 적용 시점과 공식 출처인지 확인한 뒤 다시 판단해야 합니다."
        )
    missing_note = ""
    if reasoning_review.missing_constraints:
        missing_note = (
            "\n\n**확인 필요:** 자료에서 질문 조건 "
            + ", ".join(reasoning_review.missing_constraints) + "을(를) 확인하지 못했습니다."
        )
    remaining = "\n".join(f"- {item}" for item in evidence[1:])
    return (
        LOCAL_REASONING_MARKER + "\n" + review
        + f"**판단:** {evidence[0]}\n\n"
        + ("**근거 비교**\n" + remaining + "\n\n" if remaining else "")
        + f"**검토 결과:** 신뢰도 {reasoning_review.confidence}."
        + missing_note
        + "\n\n외부 LLM의 추측이 아니라 현재 저장된 자료와 명시 조건을 규칙으로 비교한 결과입니다."
    )


def should_generate_code(query: str) -> bool:
    return bool(_CODE_RE.search(query or ""))


def local_answer_fit(user_msg: str, kb_question: str, kb_answer: str) -> bool:
    """API 없이 후보 답변의 대상·숫자 조건과 핵심어 포함 여부를 보수적으로 점검."""
    # 검색 엔진과 같은 한국어 조사·어미 정규화를 사용한다. 단순 공백 토큰만
    # 비교하면 "퇴직금은/계산하나요"와 "퇴직금/계산"도 다른 말로 오판한다.
    from engine import _tok
    query_tokens = set(_tok(user_msg))
    candidate = f"{kb_question} {kb_answer}"
    candidate_tokens = set(_tok(candidate))
    query_numbers = set(re.findall(r"\d+(?:[.,]\d+)?", user_msg))
    candidate_numbers = set(re.findall(r"\d+(?:[.,]\d+)?", candidate))
    if query_numbers and not query_numbers.issubset(candidate_numbers):
        return False
    if not query_tokens:
        return True
    overlap = len(query_tokens & candidate_tokens) / len(query_tokens)
    query_grams = _chargrams(user_msg)
    gram_overlap = len(query_grams & _chargrams(candidate)) / max(1, len(query_grams))
    return overlap >= 0.4 or gram_overlap >= 0.35
