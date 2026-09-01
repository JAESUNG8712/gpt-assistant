"""BM25 보조 점수, 문자 폴백, 역색인 후보 축소 회귀 테스트."""

import engine


def test_sparse_candidates():
    search_engine = engine._Engine()
    for i in range(1200):
        search_engine.add(
            f"고유검색항목{i} 전용키워드{i}",
            f"{i}번 항목의 독립 답변입니다.",
            {"persona": "scale"},
        )

    calls = 0
    original_cos = search_engine._cos

    def counted_cos(left, right):
        nonlocal calls
        calls += 1
        return original_cos(left, right)

    search_engine._cos = counted_cos
    results = search_engine.search("고유검색항목777 전용키워드777", persona="scale")
    assert results and results[0][0].startswith("고유검색항목777")
    assert calls < 20, f"역색인 후보 축소 실패: cosine {calls}회"


def test_character_fallback_and_persona_scope():
    search_engine = engine._Engine()
    search_engine.add(
        "가나다라마바사아자차카타파하",
        "문자 오타 폴백 확인용 답변",
        {"persona": "fuzzy", "source": "test"},
    )
    search_engine.add(
        "가나다라마바사아자차카타파하",
        "다른 페르소나 답변",
        {"persona": "other", "source": "test"},
    )
    results = search_engine.search("가나다라마바싸아자차카타파하", persona="fuzzy")
    assert results and results[0][1] == "문자 오타 폴백 확인용 답변"
    assert results[0][3]["retrieval"] == "char_fuzzy"


def test_article_queries_do_not_use_fuzzy_fallback():
    search_engine = engine._Engine()
    search_engine.add(
        "근로기준법 제60조 연차휴가",
        "연차휴가 조항",
        {"persona": "legal"},
    )
    results = search_engine.search("근로기준법 제61조", persona="legal")
    assert all(item[3].get("retrieval") != "char_fuzzy" for item in results)


def main():
    test_sparse_candidates()
    test_character_fallback_and_persona_scope()
    test_article_queries_do_not_use_fuzzy_fallback()
    print("hybrid search tests: PASS")


if __name__ == "__main__":
    main()
