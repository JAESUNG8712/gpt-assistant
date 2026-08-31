"""문서 의미 청킹·재업로드 격리 회귀 테스트."""
import os
import tempfile


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "chunks.db")

        import memory
        import engine

        memory._seed_static_kb_to_db = lambda: None
        engine.reload_engine = lambda: None
        memory.init_db()

        long_leave = " ".join(
            f"연차휴가 신청 문장 {i}입니다. 승인 전에 잔여 일수를 확인합니다."
            for i in range(1, 18)
        )
        source = f"""# 휴가 규정
{long_leave}

# 출장 규정
| 구분 | 한도 | 증빙 |
| 숙박 | 150000원 | 영수증 |
| 교통 | 실비 | 승차권 |

출장비는 귀임 후 7일 이내에 정산합니다.
"""
        chunks = memory.chunk_document(
            source, "사내규정.md", target_chars=300, max_chars=480, overlap_chars=60
        )
        assert len(chunks) >= 3
        assert all(chunk.startswith("[문서: 사내규정.md]") for chunk in chunks)
        assert any("[섹션: 휴가 규정]" in chunk for chunk in chunks)
        assert any("[섹션: 출장 규정]" in chunk for chunk in chunks)
        table_chunk = next(chunk for chunk in chunks if "| 숙박 |" in chunk)
        assert "| 구분 | 한도 | 증빙 |\n| 숙박 | 150000원 | 영수증 |" in table_chunk
        assert any("[앞 문맥]" in chunk for chunk in chunks)
        assert len(chunks) == len(set(chunks))

        # 겹침 때문에 거의 같은 청크가 검색 결과를 독점하지 않아야 한다.
        near_same_a = "연차 신청 승인 잔여일 확인 전자결재 인사팀 처리 절차 안내"
        near_same_b = "연차 신청 승인 잔여일 확인 전자결재 인사팀 처리 절차 안내 추가"
        distinct = "출장 숙박비 교통비 영수증 귀임 정산 기한"
        diversified = memory._diversify_search_results(
            [
                ("연차", near_same_a, 0.9, {"source": "문서:규정"}),
                ("연차2", near_same_b, 0.85, {"source": "문서:규정"}),
                ("출장", distinct, 0.7, {"source": "문서:규정"}),
            ],
            3,
        )
        assert [row[0] for row in diversified] == ["연차", "출장"]

        first_count = memory.store_document(source, "사내규정.md", "company")
        assert first_count >= 2
        replacement = """# 출장 규정
출장비는 귀임 후 5일 이내에 정산하며 전자 영수증을 첨부합니다.
"""
        second_count = memory.store_document(replacement, "사내규정.md", "company")
        assert second_count == 1
        with memory._conn() as c:
            live = [r[0] for r in c.execute(
                "SELECT content FROM learned_knowledge"
                " WHERE source='문서:사내규정.md' AND persona='company'"
            ).fetchall()]
        assert len(live) == 1 and "5일 이내" in live[0]
        assert all("7일 이내" not in content for content in live)
        assert len(memory.list_quarantined_memories()) == first_count

        # 빈 파일/파싱 실패 재업로드는 현재 정상 버전을 격리하면 안 된다.
        assert memory.store_document("   \n\n", "사내규정.md", "company") == 0
        with memory._conn() as c:
            assert c.execute(
                "SELECT COUNT(*) FROM learned_knowledge"
                " WHERE source='문서:사내규정.md' AND persona='company'"
            ).fetchone()[0] == 1

    print("document chunking tests: PASS")


if __name__ == "__main__":
    main()
