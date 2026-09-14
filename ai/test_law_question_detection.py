"""law_search.is_law_question() 회귀 테스트.

2026-09-11 세션에서 발견했으나 전용 테스트 부재·법률 KB 정확도 훼손 위험을 이유로
당시엔 미수정으로 남겨뒀던 버그를 2026-09-14에 실제로 수정하며 함께 추가한
테스트. 옛 `법률?` 패턴이 "법" 단독 한 글자와 항상 매칭돼(=`?`가 "률"에만
적용됨) "이력서 잘 쓰는 법"·"OO 사용법"·"OO 계산법"처럼 법령과 무관한 "방법"
의미의 "법"까지 매번 law.go.kr/DDG 법령 검색을 유발하던 것을 고쳤다. 이 함수는
main.py에서 실시간 법령 검색 트리거 여부만 결정하고 `engine.search()`의 KB
매칭 자체와는 무관해, 법률 KB 정확도 회귀 테스트(test_legal_kb_accuracy.py)에는
영향이 없음을 별도로 확인한다.
"""
import os
import sys

AI_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI_DIR)


def _test_true_positives():
    import law_search as law

    cases = [
        "근로기준법 제7조",
        "최저임금법 위반 처벌",
        "퇴직급여법이 뭐야",
        "이 법령 조항이 뭐야",
        "고용보험법에 따르면",
        "법률상 문제 없나요",
        "이거 불법인가요",
        "해고가 합법인가요",
        "이 계약은 위법인가요",
        "탈법 행위 아닌가요",
        "이 법이 있나요",
        "관련 법 알려줘",
        "법에 따르면 어떻게 되나요",
        "법대로 하자",
        "해당 법은 무엇인가요",
        "근로기준법 시행령 확인",
        "산업재해 손해배상 청구 방법",  # "손해배상"으로 이미 매칭되어야 함
    ]
    for q in cases:
        assert law.is_law_question(q) is True, f"법 관련 질문으로 인식돼야 함: {q!r}"

    print("is_law_question true-positive tests: PASS")


def _test_false_positives_method_sense():
    """'법'이 '방법'의 의존명사·개방형 방법-접미사로 쓰인 일상 표현은 법령
    질문이 아니므로 불필요한 law.go.kr/DDG 검색을 유발하면 안 된다."""
    import law_search as law

    cases = [
        "퇴직금 계산법 알려줘",
        "이 API 사용법이 뭐야",
        "이력서 작성법",
        "요리법 추천",
        "연차수당 계산법",
        "단어 암기법",
        "이력서 잘 쓰는 법",
        "요리하는 법 알려줘",
        "취업 잘 하는 법",
        "빠르게 배우는 법",
        "이 문제 푸는 법 좀",
        "방법을 알려줘",
        "PPT 만드는 법",
        "영어 잘하는 법 있나요",
    ]
    for q in cases:
        assert law.is_law_question(q) is False, f"법 관련 질문이 아니어야 함(방법 의미): {q!r}"

    print("is_law_question false-positive(method sense) tests: PASS")


def _test_main_py_uses_updated_function():
    """main.py의 유일한 호출부가 이 함수를 그대로 쓰는지 확인(회귀 방지용
    최소 통합 확인 — 실제 /chat 호출은 무거운 파이프라인이라 별도 API 통합
    테스트에서 커버됨). main 모듈을 임포트하면 DB 연결 등 무거운 부수효과가
    생기므로 소스 텍스트만 확인한다."""
    main_path = os.path.join(AI_DIR, "main.py")
    with open(main_path, encoding="utf-8") as f:
        src = f.read()
    assert "law.is_law_question(search_msg)" in src

    print("main.py integration point check: PASS")


def main_():
    _test_true_positives()
    _test_false_positives_method_sense()
    _test_main_py_uses_updated_function()


if __name__ == "__main__":
    main_()
