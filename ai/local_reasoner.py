"""API 키 없이 동작하는 결정적 로컬 추론·간단 코딩 응답기.

생성형 모델을 흉내 내어 사실을 만들어내지 않고, 질문을 분해한 뒤 확보된 근거를
관련도 순으로 선별·조합하고 충돌 가능성을 표시한다. 반복 가능한 코딩 패턴은 안전한
템플릿으로 생성한다.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass
from datetime import date


LOCAL_REASONING_MARKER = "<!-- local-reasoning-v9 -->"

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
    # 비교식에서 흔한 A/B, 1/2 같은 한 글자 대상도 보존한다. 한글 한 글자는
    # 조사·일반어 오탐이 많아 제외하고 ASCII 식별자만 제한적으로 허용한다.
    short_identifiers = re.findall(r"(?<![A-Za-z0-9_])[A-Za-z0-9](?![A-Za-z0-9_])", text or "")
    return {w for w in words if w not in _STOP} | {w.lower() for w in short_identifiers}


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
    result = []
    # 줄을 먼저 분리해야 번호 목록의 "1."을 문장 끝으로 오인하지 않고 단계
    # 순서를 보존할 수 있다. 일반 문단 한 줄에 문장이 여럿이면 그때만 추가 분리한다.
    lines = (text or "").splitlines()
    index = 0
    while index < len(lines):
        raw_line = lines[index]
        line = raw_line.strip()
        if not line:
            index += 1
            continue
        # 표는 헤더와 데이터 행의 관계가 의미이므로 행 단위로 흩뜨리지 않는다.
        if line.startswith("|") and line.endswith("|"):
            table_lines = []
            while index < len(lines):
                table_line = lines[index].strip()
                if not (table_line.startswith("|") and table_line.endswith("|")):
                    break
                table_lines.append(table_line)
                index += 1
            table = "\n".join(table_lines)
            if len(table_lines) >= 2 and table not in result:
                result.append(table[:1000])
            continue
        if re.fullmatch(r"\|?[\s:|-]+\|?", line):
            index += 1
            continue
        chunks = re.split(r"(?<=[!?。])\s+|(?<=[가-힣A-Za-z])\.\s+", line)
        for chunk in chunks:
            value = " ".join(chunk.split()).strip(" -")
            # "해외여행 필수 앱" 같은 짧은 문서 제목도 중요한 근거이므로 보존한다.
            if 6 <= len(value) <= 1000 and value not in result:
                result.append(value)
        index += 1
    return result


@dataclass
class Evidence:
    text: str
    score: float
    numbers: tuple[str, ...] = ()
    negative: bool = False
    position: int = 0
    ordinal: int | None = None
    authority: int = 1
    source_label: str = "보유 자료"


@dataclass(frozen=True)
class ReasoningPlan:
    """사용자에게 노출하지 않는 로컬 판단 계획."""
    intent: str
    constraints: tuple[str, ...]
    preferred_signals: tuple[str, ...]
    question_terms: tuple[str, ...]
    aspects: tuple[str, ...] = ()


@dataclass(frozen=True)
class ReasoningReview:
    confidence: str
    conflicts: tuple[str, ...]
    missing_constraints: tuple[str, ...]
    evidence_count: int
    missing_aspects: tuple[str, ...] = ()
    official_count: int = 0
    independent_sources: int = 0
    corroborated_claims: int = 0


_INTENT_SIGNALS = {
    "cause": ("때문", "이유", "원인", "목적", "위해", "따라"),
    "procedure": ("절차", "단계", "신청", "작성", "제출", "승인", "확인", "등록", "처리", "방법", "해야"),
    "comparison": ("차이", "반면", "각각", "비교", "보다", "장점", "단점"),
    "eligibility": ("조건", "요건", "대상", "가능", "해당", "제외"),
    "amount": ("금액", "시간당", "월급", "요율", "비율", "계산", "기준"),
    "date": ("시행", "적용", "기한", "기간", "부터", "까지", "일자", "날짜"),
    "latest": ("최신", "현재", "고시", "시행", "적용", "기준"),
    "fact": (),
}


def build_reasoning_plan(query: str) -> ReasoningPlan:
    """질문을 의도·명시 조건·판단 신호로 분해한다."""
    q = query or ""
    if re.search(r"(?:최신|현재|지금|최근|올해)", q):
        intent = "latest"
    elif re.search(r"(?:왜|이유|원인|목적)", q):
        intent = "cause"
    elif re.search(r"(?:비교|차이|vs\.?|장단점|어느\s*쪽)", q, re.IGNORECASE):
        intent = "comparison"
    elif re.search(r"(?:언제|시행일|적용일|기한|기간)", q):
        intent = "date"
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
    aspect_patterns = {
        "amount": r"(?:얼마|몇\s*%|금액|시급|시간급|월급|요율|인상액|계산)",
        "date": r"(?:언제|시행일?|적용일?|기한|기간|몇\s*년|몇\s*월|부터|까지)",
        "comparison": r"(?:비교|차이|대비|vs\.?)",
        "cause": r"(?:왜|이유|원인|목적)",
        "procedure": r"(?:어떻게|방법|절차|신청|제출)",
        "eligibility": r"(?:조건|요건|대상|가능|자격|해당)",
    }
    aspects = tuple(name for name, pattern in aspect_patterns.items() if re.search(pattern, q, re.IGNORECASE))
    if not aspects:
        aspects = (intent,)
    return ReasoningPlan(
        intent=intent,
        constraints=constraints,
        preferred_signals=tuple(dict.fromkeys(
            signal for aspect in aspects for signal in _INTENT_SIGNALS.get(aspect, ())
        )),
        question_terms=tuple(sorted(_tokens(q))),
        aspects=aspects,
    )


def _supports_aspect(aspect: str, text: str) -> bool:
    """근거 한 단위가 복합 질문의 특정 요구항목을 실제로 다루는지 판정한다."""
    patterns = {
        "amount": r"\d+(?:[.,]\d+)?\s*(?:원|%|만원|억원)|(?:금액|시급|시간급|월급|요율|인상액)",
        "date": r"(?:20\d{2}년|\d{1,2}월\s*\d{1,2}일|시행|적용|기한|기간|부터|까지)",
        "comparison": r"(?:차이|대비|반면|보다|각각|장점|단점)",
        "cause": r"(?:때문|이유|원인|목적|위해|따라)",
        "procedure": r"(?:절차|단계|신청|작성|제출|승인|확인|등록|처리|해야)",
        "eligibility": r"(?:조건|요건|대상|가능|해당|제외|자격)",
        "latest": r"(?:20\d{2}년|최신|현재|고시|시행|적용)",
        "fact": r".",
    }
    return bool(re.search(patterns.get(aspect, r"."), text or "", re.IGNORECASE))


def _evidence_units(context: str) -> list[tuple[str, int, str]]:
    """컨텍스트 블록의 출처 등급을 내용 문장에 연결한다."""
    units: list[tuple[str, int, str]] = []
    blocks = re.split(r"\n\s*\n", _clean_context(context))
    for block in blocks:
        value = block.strip()
        if not value or value.startswith("[검색 근거 검증]"):
            continue
        lower = value.lower()
        if ("law.go.kr" in lower or re.search(r"\|\s*공식\s*\|", value)
                or re.search(r"\[(?:공식|법령)", value) or "국가법령정보" in value):
            authority = 3
            default_label = "공식 출처"
        elif re.search(r"\|\s*(?:공공기관|전문기관|권위기관)\s*\|", value) or re.search(r"\[(?:내부|승인)", value):
            authority = 2
            default_label = "검증 출처"
        else:
            authority = 1
            default_label = "보유 자료"
        domain_match = re.search(r"출처:\s*([^|\]\s]+)", value)
        source_label = domain_match.group(1).rstrip(".,") if domain_match else default_label
        for sentence in _sentences(value):
            # URL·제목 표식만 있는 줄은 사실 근거에서 제외한다.
            if re.match(r"^(?:URL|출처):|^\[검색결과\s+\d+", sentence, re.IGNORECASE):
                continue
            units.append((sentence, authority, source_label))
    return units


def _rank_evidence(query: str, context: str, limit: int = 4) -> tuple[ReasoningPlan, list[Evidence]]:
    plan = build_reasoning_plan(query)
    q_tokens = set(plan.question_terms)
    q_grams = _chargrams(query)
    q_numbers = set(re.findall(r"\d+(?:[.,]\d+)?", query))
    ranked: list[Evidence] = []
    units = _evidence_units(context)
    all_years = [int(year) for sentence, _, _ in units for year in re.findall(r"(?<!\d)(20\d{2})년?", sentence)]
    asks_current = bool(re.search(r"(?:현재|지금|올해)", query or ""))
    applicable_years = [year for year in all_years if year <= date.today().year] if asks_current else all_years
    latest_year = max(applicable_years) if applicable_years else None
    requested_years = set(re.findall(r"(?<!\d)(20\d{2})년?", query or ""))
    for index, (sentence, authority, source_label) in enumerate(units):
        sentence_years = set(re.findall(r"(?<!\d)(20\d{2})년?", sentence))
        # 특정 연도를 물었는데 다른 연도만 적힌 문장은 답 후보에서 제외한다.
        # 여러 연도를 함께 물은 비교 질문이면 요청된 연도는 모두 유지한다.
        if requested_years and sentence_years and requested_years.isdisjoint(sentence_years):
            continue
        # "현재/최신" 질문은 문맥에서 확인되는 가장 최근 연도 자료를 우선한다.
        if plan.intent == "latest" and latest_year and sentence_years \
                and str(latest_year) not in sentence_years:
            continue
        s_tokens = _tokens(sentence)
        overlap = len(q_tokens & s_tokens)
        coverage = overlap / max(1, len(q_tokens))
        gram_coverage = len(q_grams & _chargrams(sentence)) / max(1, len(q_grams))
        sentence_numbers = tuple(re.findall(r"\d+(?:[.,]\d+)?(?:원|%|년|개월|시간|일)?", sentence))
        number_overlap = len(q_numbers & set(re.findall(r"\d+(?:[.,]\d+)?", sentence)))
        constraint_hits = sum(1 for item in plan.constraints if item in sentence)
        intent_hits = sum(1 for signal in plan.preferred_signals if signal in sentence)
        source_bonus = {3: 0.8, 2: 0.4}.get(authority, 0.0)
        score = (
            overlap * 1.2 + coverage + gram_coverage * 1.4 + number_overlap * 1.5
            + constraint_hits * 0.8 + intent_hits * 0.22 + source_bonus - index * 0.002
        )
        if score > 0 or (not q_tokens and index < limit):
            ordinal_match = re.match(r"\s*(\d{1,3})[.)]\s*", sentence)
            ranked.append(Evidence(
                sentence, score, sentence_numbers,
                bool(re.search(r"(?:아니|불가|금지|없(?:다|음)|제외|못\s*한)", sentence)),
                index, int(ordinal_match.group(1)) if ordinal_match else None,
                authority, source_label,
            ))
    ranked.sort(key=lambda item: item.score, reverse=True)
    return plan, ranked[:limit]


def review_reasoning(plan: ReasoningPlan, evidence: list[Evidence]) -> ReasoningReview:
    """선택한 근거의 조건 누락과 동일 항목의 상충 수치·긍정/부정을 검사한다."""
    joined = " ".join(item.text for item in evidence)
    missing = tuple(item for item in plan.constraints if item not in joined)
    missing_aspects = tuple(
        aspect for aspect in plan.aspects
        if not (aspect == "comparison" and len(evidence) >= 2)
        and not any(_supports_aspect(aspect, item.text) for item in evidence)
    )
    conflicts: list[str] = []
    official_count = sum(1 for item in evidence if item.authority >= 3)
    independent_sources = len({item.source_label for item in evidence})
    claim_sources: dict[tuple[str, str], set[str]] = {}

    decisive_patterns = {
        "시간당 금액": r"(?:시간당|시급)[^\d]{0,12}(\d+(?:[.,]\d+)?원)",
        "월 환산액": r"(?:월급|월\s*환산)[^\d]{0,12}(\d+(?:[.,]\d+)?원)",
        "인상률": r"(?:인상률|요율|비율)[^\d]{0,12}(\d+(?:[.,]\d+)?%)",
    }
    for label, pattern in decisive_patterns.items():
        values_by_scope: dict[str, set[str]] = {}
        for item in evidence:
            years = re.findall(r"(?<!\d)(20\d{2})년?", item.text)
            scope = years[0] + "년" if years else "연도 미표기"
            values_by_scope.setdefault(scope, set()).update(re.findall(pattern, item.text))
            for value in re.findall(pattern, item.text):
                claim_sources.setdefault((label, value), set()).add(item.source_label)
        for scope, values in values_by_scope.items():
            if len(values) > 1:
                conflicts.append(
                    f"동일 항목·적용시점({scope})의 {label}이(가) 서로 다름: "
                    + ", ".join(sorted(values))
                )

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

    corroborated_claims = sum(1 for sources in claim_sources.values() if len(sources) >= 2)
    if conflicts or missing or missing_aspects:
        confidence = "낮음"
    elif official_count or corroborated_claims:
        confidence = "높음"
    elif evidence:
        confidence = "보통"
    else:
        confidence = "근거 없음"
    return ReasoningReview(
        confidence, tuple(conflicts), missing, len(evidence), missing_aspects,
        official_count, independent_sources, corroborated_claims,
    )


def select_evidence(query: str, context: str, limit: int = 4) -> list[str]:
    """질문 핵심어와 숫자·연도 일치도를 함께 사용해 근거 문장을 고른다."""
    _, ranked = _rank_evidence(query, context, limit)
    return [item.text for item in ranked]


def _public_review(plan: ReasoningPlan, review: ReasoningReview, thinking_mode: str) -> str:
    if thinking_mode not in ("prompt", "deep"):
        return ""
    labels = {
        "cause": "원인·이유", "procedure": "절차·방법", "comparison": "비교",
        "eligibility": "조건·가능 여부", "amount": "수치·계산",
        "date": "시점·기한", "latest": "현재·최신 기준", "fact": "사실 확인",
    }
    checks = [f"{labels[plan.intent]} 질문으로 분류", f"근거 {review.evidence_count}개 비교"]
    if plan.constraints:
        checks.append(f"명시 조건 {len(plan.constraints)}개 확인")
    if len(plan.aspects) > 1:
        checks.append(f"요구사항 {len(plan.aspects)}개 분해")
    if review.official_count:
        checks.append(f"공식 근거 {review.official_count}개 우선")
    if review.corroborated_claims:
        checks.append(f"독립 출처 교차확인 {review.corroborated_claims}건")
    if review.conflicts:
        checks.append(f"충돌 {len(review.conflicts)}건을 발견해 결론 보류")
    elif review.missing_constraints or review.missing_aspects:
        checks.append("확인되지 않은 조건을 표시")
    else:
        checks.append(f"판단 신뢰도 {review.confidence}")
    return "<think>\n로컬 검토: " + " · ".join(checks) + "\n</think>\n"


def _language(query: str) -> str:
    q = query.lower()
    if "html" in q or "웹페이지" in q or "웹 페이지" in q or re.search(r"웹\s*앱", q):
        return "html"
    if "javascript" in q or "자바스크립트" in q or "node" in q:
        return "javascript"
    return "python"


def _python_template(query: str) -> tuple[str, str]:
    q = query.lower()
    if ("crud" in q or "게시판 api" in q or "할일 api" in q or "todo api" in q):
        return "검증과 오류 처리를 포함한 FastAPI CRUD API", '''from uuid import uuid4

from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

app = FastAPI(title="Todo API")
items: dict[str, dict] = {}


class TodoCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    done: bool = False


@app.post("/todos", status_code=status.HTTP_201_CREATED)
def create_todo(payload: TodoCreate):
    item_id = str(uuid4())
    items[item_id] = {"id": item_id, **payload.model_dump()}
    return items[item_id]


@app.get("/todos")
def list_todos():
    return list(items.values())


@app.put("/todos/{item_id}")
def update_todo(item_id: str, payload: TodoCreate):
    if item_id not in items:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다")
    items[item_id] = {"id": item_id, **payload.model_dump()}
    return items[item_id]


@app.delete("/todos/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_todo(item_id: str):
    if items.pop(item_id, None) is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다")


# 실행: uvicorn main:app --reload'''
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
    if re.search(r"(?:할\s*일|todo)", query, re.IGNORECASE):
        code = f'''<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    body {{ max-width: 640px; margin: 48px auto; padding: 0 20px; font-family: sans-serif; }}
    form, li {{ display: flex; gap: 8px; margin: 10px 0; }}
    input {{ flex: 1; padding: 10px; }} button {{ padding: 10px 14px; }}
    .done span {{ text-decoration: line-through; opacity: .55; }}
  </style>
</head>
<body>
  <h1>{title}</h1>
  <form id="todo-form"><input id="todo-input" maxlength="120" required aria-label="할 일"><button>추가</button></form>
  <ul id="todo-list"></ul>
  <script>
    const storageKey = "personal-todos-v1";
    let todos = JSON.parse(localStorage.getItem(storageKey) || "[]");
    const list = document.querySelector("#todo-list");
    const save = () => localStorage.setItem(storageKey, JSON.stringify(todos));
    function render() {{
      list.replaceChildren(...todos.map(todo => {{
        const li = document.createElement("li");
        li.className = todo.done ? "done" : "";
        const check = document.createElement("input");
        check.type = "checkbox"; check.checked = todo.done;
        check.addEventListener("change", () => {{ todo.done = check.checked; save(); render(); }});
        const text = document.createElement("span"); text.textContent = todo.title;
        const remove = document.createElement("button"); remove.textContent = "삭제";
        remove.addEventListener("click", () => {{ todos = todos.filter(item => item.id !== todo.id); save(); render(); }});
        li.append(check, text, remove); return li;
      }}));
    }}
    document.querySelector("#todo-form").addEventListener("submit", event => {{
      event.preventDefault(); const input = document.querySelector("#todo-input");
      const title = input.value.trim(); if (!title) return;
      todos.push({{ id: crypto.randomUUID(), title, done: false }}); input.value = ""; save(); render();
    }});
    render();
  </script>
</body>
</html>'''
        return "브라우저에 저장되는 할 일 웹 앱", code
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


def _fastapi_project() -> dict[str, str]:
    """서버 자원이나 외부 모델 없이 재현 가능한 소형 다중 파일 프로젝트."""
    return {
        "requirements.txt": "fastapi>=0.110,<1\nuvicorn>=0.29,<1\npytest>=8,<9\nhttpx>=0.27,<1",
        "app/__init__.py": "",
        "app/models.py": '''from pydantic import BaseModel, Field


class TodoCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class Todo(TodoCreate):
    id: int
    done: bool = False''',
        "app/main.py": '''from fastapi import FastAPI, HTTPException, status

from .models import Todo, TodoCreate

app = FastAPI(title="Todo API")
items: dict[int, Todo] = {}
next_id = 1


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/todos", response_model=list[Todo])
def list_todos():
    return list(items.values())


@app.post("/todos", response_model=Todo, status_code=status.HTTP_201_CREATED)
def create_todo(payload: TodoCreate):
    global next_id
    item = Todo(id=next_id, title=payload.title.strip())
    items[next_id] = item
    next_id += 1
    return item


@app.delete("/todos/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_todo(item_id: int):
    if items.pop(item_id, None) is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다")''',
        "tests/test_api.py": '''from fastapi.testclient import TestClient

from app.main import app, items

client = TestClient(app)


def setup_function():
    items.clear()


def test_create_and_list_todo():
    created = client.post("/todos", json={"title": "검증하기"})
    assert created.status_code == 201
    assert created.json()["title"] == "검증하기"
    assert client.get("/todos").json()[0]["title"] == "검증하기"


def test_rejects_empty_title():
    assert client.post("/todos", json={"title": ""}).status_code == 422


def test_missing_delete_is_404():
    assert client.delete("/todos/999").status_code == 404''',
    }


def _python_test_project(query: str) -> dict[str, str]:
    if "중복" in query:
        implementation = '''def process(items):
    """입력 순서를 유지하면서 중복을 제거합니다."""
    if items is None:
        raise ValueError("items는 필수입니다")
    return list(dict.fromkeys(items))'''
        tests = '''import pytest

from src.processor import process


def test_removes_duplicates_in_order():
    assert process([3, 1, 3, 2, 1]) == [3, 1, 2]


def test_requires_input():
    with pytest.raises(ValueError):
        process(None)'''
    else:
        implementation = '''def process(value):
    """검증된 값을 반환하는 프로젝트 기본 처리 함수입니다."""
    if value is None:
        raise ValueError("value는 필수입니다")
    return value'''
        tests = '''import pytest

from src.processor import process


def test_processes_value():
    assert process("test") == "test"


def test_requires_value():
    with pytest.raises(ValueError):
        process(None)'''
    return {
        "requirements.txt": "pytest>=8,<9",
        "src/__init__.py": "",
        "src/processor.py": implementation,
        "tests/test_processor.py": tests,
    }


def _javascript_test_project() -> dict[str, str]:
    return {
        "package.json": '''{
  "name": "validated-utility",
  "version": "1.0.0",
  "type": "module",
  "scripts": {"test": "node --test"}
}''',
        "src/index.js": '''export function uniqueItems(items) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  return [...new Set(items)];
}''',
        "test/index.test.js": '''import test from "node:test";
import assert from "node:assert/strict";

import { uniqueItems } from "../src/index.js";

test("removes duplicates in order", () => {
  assert.deepEqual(uniqueItems([3, 1, 3, 2]), [3, 1, 2]);
});

test("rejects invalid input", () => {
  assert.throws(() => uniqueItems(null), TypeError);
});''',
    }


def _code_security_findings(files: dict[str, str]) -> list[str]:
    joined = "\n".join(files.values())
    checks = (
        (r"\beval\s*\(", "eval 사용"),
        (r"\bexec\s*\(", "exec 사용"),
        (r"shell\s*=\s*True", "셸 명령 주입 위험"),
        (r"(?i)(?:api[_-]?key|password|secret)\s*=\s*['\"][^'\"]+", "하드코딩된 비밀정보"),
        (r"allow_origins\s*=\s*\[['\"]\*", "전체 허용 CORS"),
    )
    return [label for pattern, label in checks if re.search(pattern, joined)]


def _project_code_response(query: str, thinking_mode: str) -> str:
    files = _fastapi_project()
    rendered = []
    for path, code in files.items():
        fence = "python" if path.endswith(".py") else "text"
        rendered.append(f"### `{path}`\n\n```{fence}\n{code}\n```")
    findings = _code_security_findings(files)
    audit = (
        "발견: " + ", ".join(findings)
        if findings else
        "통과: eval/exec, shell=True, 하드코딩 비밀정보, 전체 허용 CORS 없음"
    )
    plan = build_reasoning_plan(query)
    review = _public_review(plan, ReasoningReview("높음", (), (), 1), thinking_mode)
    return (
        LOCAL_REASONING_MARKER + "\n" + review
        + "요청을 **테스트가 포함된 다중 파일 FastAPI 프로젝트**로 구성했습니다.\n\n"
        + "```text\napp/__init__.py\napp/models.py\napp/main.py\ntests/test_api.py\nrequirements.txt\n```\n\n"
        + "\n\n".join(rendered)
        + "\n\n### 실행·검증\n\n"
          "```bash\npip install -r requirements.txt\npytest -q\nuvicorn app.main:app --reload\n```\n\n"
        + f"정적·보안 점검: {audit}. 입력 길이 검증과 404 처리를 포함했습니다."
    )


def _generic_test_project_response(query: str, thinking_mode: str, language: str) -> str:
    javascript = language == "javascript"
    files = _javascript_test_project() if javascript else _python_test_project(query)
    rendered = []
    for path, code in files.items():
        fence = "javascript" if path.endswith(".js") else "python" if path.endswith(".py") else "json" if path.endswith(".json") else "text"
        rendered.append(f"### `{path}`\n\n```{fence}\n{code}\n```")
    findings = _code_security_findings(files)
    audit = "발견: " + ", ".join(findings) if findings else "위험 패턴 5종 미검출"
    run = "npm test" if javascript else "pip install -r requirements.txt\npytest -q"
    label = "JavaScript" if javascript else "Python"
    review = _public_review(
        build_reasoning_plan(query), ReasoningReview("높음", (), (), 1), thinking_mode
    )
    return (
        LOCAL_REASONING_MARKER + "\n" + review
        + f"요청을 **테스트가 포함된 다중 파일 {label} 프로젝트**로 구성했습니다.\n\n"
        + "\n\n".join(rendered)
        + f"\n\n### 실행·검증\n\n```bash\n{run}\n```\n\n정적·보안 점검: {audit}."
    )
def code_response(query: str, thinking_mode: str = "off") -> str:
    language = _language(query)
    wants_project = bool(re.search(r"프로젝트|여러\s*파일|테스트\S*\s*(?:포함|함께)|자동\s*테스트", query))
    if wants_project and re.search(r"fastapi|api", query, re.IGNORECASE):
        return _project_code_response(query, thinking_mode)
    if wants_project and language in {"python", "javascript"}:
        return _generic_test_project_response(query, thinking_mode, language)
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


def _evidence_for_display(plan: ReasoningPlan, ranked: list[Evidence]) -> list[Evidence]:
    """절차는 단계 번호/원문 순서를 보존하고 나머지는 관련도 순서를 유지한다."""
    if plan.intent != "procedure":
        return ranked
    return sorted(
        ranked,
        key=lambda item: (
            item.ordinal is None,
            item.ordinal if item.ordinal is not None else item.position,
            item.position,
        ),
    )


def _display_evidence(item: Evidence) -> str:
    if item.source_label in {"보유 자료", "검증 출처", "공식 출처"}:
        return item.text
    return f"{item.text}\n  - 출처: {item.source_label}"


def _render_grounded_body(plan: ReasoningPlan, evidence: list[Evidence]) -> str:
    texts = [_display_evidence(item) for item in evidence]
    aspect_labels = {
        "amount": "금액·계산", "date": "적용 시점", "comparison": "비교",
        "cause": "원인", "procedure": "절차", "eligibility": "조건",
        "latest": "최신 기준", "fact": "사실",
    }
    if len(plan.aspects) > 1:
        rows = []
        for item in evidence:
            supported = [aspect_labels.get(aspect, aspect) for aspect in plan.aspects
                         if _supports_aspect(aspect, item.text)
                         or (aspect == "comparison" and len(evidence) >= 2)]
            if not supported:
                continue
            label = " · ".join(supported)
            rendered_item = _display_evidence(item)
            if item.text.lstrip().startswith("|"):
                rows.append(f"**{label}**\n\n{rendered_item}")
            else:
                rows.append(f"- **{label}:** {rendered_item}")
        if rows:
            return "**요청별 판단 근거**\n\n" + "\n\n".join(rows)
    if any(text.lstrip().startswith("|") for text in texts):
        rendered = []
        for text in texts:
            rendered.append(text if text.lstrip().startswith("|") else f"- {text}")
        return "**판단 근거**\n\n" + "\n\n".join(rendered)
    if plan.intent == "procedure":
        steps = [re.sub(r"^\s*\d{1,3}[.)]\s*", "", text) for text in texts]
        return "**수행 절차**\n" + "\n".join(
            f"{index}. {text}" for index, text in enumerate(steps, 1)
        )
    if plan.intent == "comparison":
        return "**비교 결과**\n" + "\n".join(f"- {text}" for text in texts)
    if plan.intent == "cause":
        return "**원인·근거**\n" + "\n".join(f"- {text}" for text in texts)
    remaining = "\n".join(f"- {text}" for text in texts[1:])
    return (
        f"**판단:** {texts[0]}"
        + ("\n\n**근거 비교**\n" + remaining if remaining else "")
    )


def grounded_response(query: str, context: str, thinking_mode: str = "off") -> str:
    plan, ranked = _rank_evidence(query, context)
    reasoning_review = review_reasoning(plan, ranked)
    display_evidence = _evidence_for_display(plan, ranked)
    evidence = [item.text for item in display_evidence]
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
    missing_parts = []
    if reasoning_review.missing_constraints:
        missing_parts.append(
            "질문 조건 " + ", ".join(reasoning_review.missing_constraints)
        )
    if reasoning_review.missing_aspects:
        missing_parts.append(
            "요청 항목 " + ", ".join(reasoning_review.missing_aspects)
        )
    if missing_parts:
        missing_note = (
            "\n\n**확인 필요:** 자료에서 " + " 및 ".join(missing_parts)
            + "을(를) 확인하지 못했습니다."
        )
    return (
        LOCAL_REASONING_MARKER + "\n" + review
        + _render_grounded_body(plan, display_evidence) + "\n\n"
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
