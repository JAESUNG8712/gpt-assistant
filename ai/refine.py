"""
KB 자기개선(자동 정제) — 동적 학습 데이터(자동학습·웹검색·직접입력·문서)에서
1) 근사 중복 항목 통합  2) 반복적으로 싫어요 받은 항목 정리
를 수행한다.

LLM을 전혀 호출하지 않는 순수 기계적 판단만 수행한다 — 내용을 새로 짓거나
"더 낫게" 재작성하지 않는다. 이 프로젝트에서 실제로 반복 발생했던 문제(가상
데이터 생성, 주제 불일치 답변 학습 등)가 전부 "AI가 스스로 내용을 만들어내는"
경로에서 나왔기 때문에, 자기개선 루프는 의도적으로 "지우기"만 하고 "새로
쓰기"는 하지 않는 안전한 범위로 제한한다.

정적 KB(source='정적KB')는 대상에서 제외 — 소스 .py 파일 재시딩(memory.py의
_seed_static_kb_to_db)으로 별도 관리된다.
"""
import math
from collections import Counter, defaultdict

from engine import _feat


def _dedup_text(content: str) -> str:
    """중복 판정용 텍스트 추출 — Q&A 형식(자동학습/직접입력/문서)이면 답변(A)
    부분만 비교 대상으로 삼는다. 질문 표현이 달라도 답변 내용이 사실상 같으면
    중복으로 봐야 하고, 반대로 질문 표현이 비슷해도 답변 내용이 다르면 서로 다른
    정보이므로 절대 합치면 안 되기 때문 — Q까지 섞어서 비교하면 짧은 답변일수록
    질문 쪽 어휘가 유사도를 희석시켜 진짜 중복을 놓치는 문제가 있었음.
    Q&A 형식이 아닌 원본 웹검색 스니펫(title\\nbody)은 그대로 사용한다."""
    if content.startswith("Q: ") and "\nA: " in content:
        return content.split("\nA: ", 1)[1]
    return content


def _question_text(content: str) -> str:
    """질문(Q) 부분만 추출 — Q&A 형식이 아니면 빈 문자열(비교 대상에서 자연히 제외)."""
    if content.startswith("Q: ") and "\nA: " in content:
        return content.split("\nA: ", 1)[0][3:]
    return ""


def _build_vectors(rows: list, text_fn=_dedup_text) -> list:
    """rows(각 dict에 'content' 키 필요) → TF-IDF 벡터 리스트, rows와 같은 순서.
    engine.py의 라이브 인덱스와 독립적으로, 이번에 조회한 rows만으로 새로
    IDF를 계산한다 — 라이브 엔진 인스턴스의 내부 상태·타이밍에 의존하지 않기
    위함(관리자 API가 엔진 로드 전에 호출돼도 안전하게 동작).
    text_fn으로 비교에 쓸 텍스트 추출 방식을 바꿀 수 있다(기본: 답변만 비교)."""
    all_f = [_feat(text_fn(r["content"])[:600]) for r in rows]
    n = len(rows)
    df: dict = defaultdict(int)
    for fs in all_f:
        for f in set(fs):
            df[f] += 1
    idf = {f: math.log((n + 1) / (c + 1)) + 1 for f, c in df.items()}
    vecs = []
    for fs in all_f:
        tf = Counter(fs)
        tot = max(len(fs), 1)
        vecs.append({f: (cnt / tot) * idf.get(f, 1.0) for f, cnt in tf.items()})
    return vecs


def _cos(v1: dict, v2: dict) -> float:
    common = set(v1) & set(v2)
    if not common:
        return 0.0
    dot = sum(v1[k] * v2[k] for k in common)
    n1 = math.sqrt(sum(x * x for x in v1.values())) or 1e-9
    n2 = math.sqrt(sum(x * x for x in v2.values())) or 1e-9
    return dot / (n1 * n2)


def find_duplicate_clusters(rows: list, threshold: float = 0.85) -> list:
    """근사 중복 클러스터를 찾아 [[row, row, ...], ...] 형태로 반환(2개 이상인 것만).
    같은 persona 내에서만 비교한다 — 다른 페르소나의 유사한 문구는 대개 우연이거나
    맥락이 달라 무관한 내용일 가능성이 높아 비교 대상에서 제외."""
    clusters = []
    by_persona: dict = defaultdict(list)
    for r in rows:
        by_persona[r.get("persona", "")].append(r)

    for _persona, group in by_persona.items():
        n = len(group)
        if n < 2:
            continue
        vecs = _build_vectors(group)
        parent = list(range(n))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

        for i in range(n):
            for j in range(i + 1, n):
                if _cos(vecs[i], vecs[j]) >= threshold:
                    union(i, j)

        buckets: dict = defaultdict(list)
        for i in range(n):
            buckets[find(i)].append(group[i])
        for members in buckets.values():
            if len(members) > 1:
                clusters.append(members)

    return clusters


def find_conflicting_pairs(rows: list, q_threshold: float = 0.7, a_threshold: float = 0.3) -> list:
    """질문은 비슷한데 답변이 실질적으로 다른 항목 쌍을 찾아 "검토 후보"로만 반환한다
    — 자동으로 지우거나 어느 쪽이 맞는지 판단하지 않는다(둘 중 뭐가 맞는지는 사람의
    판단이 필요한 영역이라, 자기개선 루프의 "지우기만" 원칙 밖에 있음). find_duplicate_clusters와
    반대 조건: 질문 유사도는 높은데(q_threshold 이상) 답변 유사도는 낮은(a_threshold 미만)
    쌍을 찾는다. Q&A 형식(자동학습/직접입력/문서)이 아닌 원본 웹검색 스니펫은 애초에
    질문이 없어 비교 대상에서 제외된다."""
    qa_rows = [r for r in rows if r["content"].startswith("Q: ") and "\nA: " in r["content"]]
    pairs = []
    by_persona: dict = defaultdict(list)
    for r in qa_rows:
        by_persona[r.get("persona", "")].append(r)

    for _persona, group in by_persona.items():
        n = len(group)
        if n < 2:
            continue
        qvecs = _build_vectors(group, text_fn=_question_text)
        avecs = _build_vectors(group, text_fn=_dedup_text)
        for i in range(n):
            for j in range(i + 1, n):
                q_sim = _cos(qvecs[i], qvecs[j])
                if q_sim < q_threshold:
                    continue
                a_sim = _cos(avecs[i], avecs[j])
                if a_sim < a_threshold:
                    pairs.append({
                        "a": group[i],
                        "b": group[j],
                        "question_similarity": round(q_sim, 3),
                        "answer_similarity": round(a_sim, 3),
                    })
    return pairs


def find_disliked_questions(feedback_rows: list, learned_rows: list) -> list:
    """feedback_boost가 threshold 이하로 떨어진 (persona, q_lower)에 해당하는
    learned_knowledge 행(Q&A 형식만 대상)을 찾아 반환."""
    remove = []
    for d in feedback_rows:
        for r in learned_rows:
            content = r["content"]
            if r["persona"] != d["persona"] or not content.startswith("Q: ") or "\nA: " not in content:
                continue
            q_part = content.split("\nA: ", 1)[0][3:].strip().lower()
            if q_part == d["q_lower"]:
                remove.append(r)
    return remove
