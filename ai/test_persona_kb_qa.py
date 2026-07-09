"""
범용 페르소나 KB 검색 정확도 QA 하네스 -- company/dev/travel/resume
각 항목에 대해 자동으로 쿼리 변형(구어체 표현, 축약, 붙여쓰기 등)을 생성해
엔진이 원래 항목을 top-1으로 정확히 찾아내는지 측정한다.

test_legal_kb_accuracy.py는 법률 KB 65개 항목에 대해 수작업으로 쿼리를 정의하는
반면, 이 스크립트는 나머지 페르소나(항목 수가 훨씬 많음)에 대해 쿼리를 자동
생성하여 회귀 여부를 빠르게 점검하는 용도다. 실행: python3 test_persona_kb_qa.py
"""
import sys, os, re

AI_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI_DIR)

from engine import _Engine

from knowledge_company import COMPANY_KNOWLEDGE
from knowledge_dev_coding import DEV_CODING_KNOWLEDGE
from knowledge_dev_gaps import DEV_GAP_KNOWLEDGE, TRAVEL_GAP_KNOWLEDGE
from knowledge_travel_additions import TRAVEL_KNOWLEDGE
from knowledge_resume import RESUME_KNOWLEDGE
from knowledge_base import KNOWLEDGE

PERSONA_SETS = {
    "company": COMPANY_KNOWLEDGE,
    "dev": DEV_CODING_KNOWLEDGE + DEV_GAP_KNOWLEDGE,
    "travel": TRAVEL_KNOWLEDGE + TRAVEL_GAP_KNOWLEDGE,
    "resume": RESUME_KNOWLEDGE,
}

CASUAL_SUBS = [
    ("어떻게 되나요?", "어떻게 돼요?"),
    ("무엇인가요?", "뭔가요?"),
    ("있나요?", "있어요?"),
    ("되나요?", "돼요?"),
    ("하나요?", "해요?"),
    ("방법은?", "방법 알려줘"),
    ("무엇인가요", "뭔가요"),
    ("어떻게 하나요", "어떻게 해요"),
]

def strip_repeat_title(q):
    parts = q.split()
    if len(parts) >= 6 and parts[0] == parts[2] and parts[1] == parts[3]:
        return parts[0] + " " + parts[1]
    return None

def gen_variants(item):
    q = item["q"].strip()
    variants = []
    title = strip_repeat_title(q)
    if title:
        variants.append(("exact_title", title))
        toks = title.split()
        if len(toks) >= 2:
            variants.append(("edge_compound", "".join(toks[:2])))
        tail_tokens = q.replace(title, "", 2).split()
        uniq_tail = []
        seen = set()
        for t in tail_tokens:
            if t not in seen:
                uniq_tail.append(t); seen.add(t)
        if len(uniq_tail) >= 2:
            variants.append(("partial_tail", " ".join(uniq_tail[:3])))
    else:
        base = q
        variants.append(("no_punct", base.rstrip("?.! ")))
        casual = base
        for a, b in CASUAL_SUBS:
            if a in casual:
                casual = casual.replace(a, b)
                break
        if casual != base:
            variants.append(("casual", casual))
        toks = re.findall(r"[가-힣A-Za-z0-9]+", base)
        if len(toks) >= 2:
            variants.append(("edge_compound", "".join(toks[:2])))
        if len(toks) >= 4:
            variants.append(("partial", " ".join(toks[1:4])))
    return variants


def main():
    eng = _Engine()
    for item in KNOWLEDGE:
        eng.add(item["q"], item["a"], {"persona": item.get("persona", "hr")})
    eng._build()

    total = 0
    fails = []
    per_persona_total = {}
    per_persona_fail = {}

    for persona, items in PERSONA_SETS.items():
        for item in items:
            variants = gen_variants(item)
            for label, vq in variants:
                if not vq.strip():
                    continue
                total += 1
                per_persona_total[persona] = per_persona_total.get(persona, 0) + 1
                res = eng.search(vq, n=1, persona=persona, min_score=0.0)
                ok = bool(res) and res[0][0] == item["q"] and res[0][2] >= 0.10
                if not ok:
                    per_persona_fail[persona] = per_persona_fail.get(persona, 0) + 1
                    top = res[0] if res else None
                    fails.append({
                        "persona": persona,
                        "label": label,
                        "query": vq,
                        "expected_q": item["q"][:60],
                        "got_q": top[0][:60] if top else None,
                        "score": round(top[2], 3) if top else 0.0,
                    })

    print(f"총 쿼리 수: {total}")
    print(f"실패 수: {len(fails)} ({100*(total-len(fails))/total:.1f}% 통과)\n")
    for p in PERSONA_SETS:
        t = per_persona_total.get(p, 0)
        f = per_persona_fail.get(p, 0)
        print(f"  [{p}] {t-f}/{t} 통과 ({100*(t-f)/t:.1f}%)" if t else f"  [{p}] no queries")

    print("\n--- 실패 상세 ---")
    for f in fails:
        print(f"[{f['persona']}/{f['label']}] Q={f['query']!r}")
        print(f"    기대: {f['expected_q']!r}")
        print(f"    실제: {f['got_q']!r} (score={f['score']})")

if __name__ == "__main__":
    main()
