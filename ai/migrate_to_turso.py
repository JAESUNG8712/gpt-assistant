"""
Railway SQLite DB → Turso 이관 스크립트

사용법:
  1. Railway에서 DB 다운로드: GET /backup/download → ZIP 압축 해제 → memory.db 추출
  2. 환경변수 설정: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
  3. 실행: python migrate_to_turso.py memory.db

  또는 API 엔드포인트 사용:
  POST /admin/import-db  (multipart, field: file)
  → Railway에서 다운받은 ZIP 또는 memory.db 파일 업로드
"""
import sqlite3
import sys
import os


# 이관할 테이블과 컬럼.
# kb_static_index 반드시 포함 — 이 테이블이 비어있는 상태로 learned_knowledge만
# 이관하면, 새 DB에서 init_db()의 _seed_static_kb_to_db()가 기존 정적 KB 항목의
# 해시를 찾지 못해 전체를 중복 재삽입한다(2026-07-08 실제 발생, 73~수백 건 중복).
_TABLES = {
    "conversations": ["role", "content", "persona", "created_at", "session_id"],
    "learned_knowledge": ["content", "persona", "source", "created_at", "evidence_json",
                          "verified_at", "valid_until", "version", "updated_at",
                          "memory_type", "memory_scope", "session_id", "helpful_count",
                          "harmful_count", "retrieved_count", "utility_boost", "last_used_at"],
    "documents": ["name", "source", "persona", "created_at"],
    "feedback": ["question", "answer", "rating", "persona", "created_at"],
    "app_settings": ["key", "value", "updated_at"],
    "feedback_boost": ["persona", "q_lower", "boost", "updated_at"],
    "kb_static_index": ["content_hash", "persona", "source", "created_at"],
    "memory_candidates": ["content_hash", "question", "answer", "persona", "session_id",
                          "source", "status", "created_at", "reviewed_at", "seen_count",
                          "last_seen_at", "evidence_json", "verified_at", "valid_until",
                          "reviewed_by", "review_reason", "review_nonce",
                          "semantic_check_json", "semantic_checked_at",
                          "memory_type", "memory_scope"],
    "memory_quarantine": ["original_id", "content", "persona", "source",
                          "original_created_at", "reason", "quarantined_at", "restored_at",
                          "evidence_json", "original_verified_at", "original_valid_until",
                          "original_version", "original_updated_at", "original_memory_type",
                          "original_memory_scope", "original_session_id",
                          "original_helpful_count", "original_harmful_count",
                          "original_retrieved_count", "original_utility_boost",
                          "original_last_used_at"],
    "memory_retrieval_events": ["query_hash", "persona", "session_kind", "top_source",
                                "best_score", "result_count", "used_context", "route",
                                "created_at", "memory_ids_json", "session_hash",
                                "feedback_rating", "feedback_at"],
    "memory_revalidation_events": ["memory_id", "source", "mode", "status", "note",
                                   "checked_at"],
    "memory_revisions": ["memory_id", "version", "content", "persona", "source",
                         "created_at", "evidence_json", "verified_at", "valid_until",
                         "action", "reason", "actor", "recorded_at", "memory_type",
                         "memory_scope", "session_id"],
    "memory_quality_eval_runs": ["suite", "status", "total", "passed", "pass_rate",
                                 "required_pass_rate", "min_score", "result_json",
                                 "created_at"],
}


def migrate(src_db_path: str) -> dict:
    """
    src_db_path: 로컬 SQLite 파일 경로
    현재 memory.py _conn() 대상(Turso 또는 로컬 SQLite)으로 데이터 이관.
    Returns: {table: {inserted, skipped}}
    """
    import memory as mem  # noqa: 이 스크립트 실행 시 memory.py와 같은 디렉토리에 있어야 함

    if not os.path.exists(src_db_path):
        raise FileNotFoundError(f"소스 DB 파일을 찾을 수 없습니다: {src_db_path}")

    # 빈 목적지 DB에서도 단독 실행할 수 있도록 스키마부터 만든다. 정적 KB는
    # 이관이 끝난 뒤 시딩해야, 구버전 백업의 정적 행과 먼저 충돌·중복되지 않는다.
    mem.init_db(seed_static=False)

    src = sqlite3.connect(src_db_path)
    src.row_factory = sqlite3.Row
    stats = {}

    for table, cols in _TABLES.items():
        # 소스 테이블 존재 여부 확인
        exists = src.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        if not exists:
            stats[table] = {"inserted": 0, "skipped": 0, "note": "테이블 없음"}
            continue

        # 구버전 백업에는 session_id나 안전 메모리 테이블의 일부 열이 없을 수 있다.
        # 실제 존재하는 열만 교집합으로 이관해 이전 백업도 계속 복원 가능하게 한다.
        source_cols = {r[1] for r in src.execute(f"PRAGMA table_info({table})").fetchall()}
        cols = [col for col in cols if col in source_cols]
        if not cols:
            stats[table] = {"inserted": 0, "skipped": 0, "note": "이관 가능한 열 없음"}
            continue
        rows = src.execute(f"SELECT {','.join(cols)} FROM {table}").fetchall()
        inserted = skipped = 0
        placeholders = ",".join(["?"] * len(cols))
        col_list = ",".join(cols)
        sql = f"INSERT OR IGNORE INTO {table} ({col_list}) VALUES ({placeholders})"

        batch = []
        for row in rows:
            batch.append(tuple(row[c] for c in cols))

        if batch:
            try:
                with mem._conn() as c:
                    c.executemany(sql, batch)
                inserted = len(batch)
            except Exception as e:
                skipped = len(batch)
                stats[table] = {"inserted": 0, "skipped": skipped, "error": str(e)}
                continue

        stats[table] = {"inserted": inserted, "skipped": skipped}

    src.close()

    # 정적 KB 시드 (이미 있으면 중복 방지로 스킵됨)
    mem._seed_static_kb_to_db()

    return stats


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("사용법: python migrate_to_turso.py <memory.db 경로>")
        sys.exit(1)

    db_path = sys.argv[1]
    print(f"이관 시작: {db_path}")

    result = migrate(db_path)
    total_inserted = sum(v.get("inserted", 0) for v in result.values())
    print(f"\n✅ 이관 완료 — 총 {total_inserted}건 삽입")
    for table, stat in result.items():
        note = stat.get("note", "")
        err  = stat.get("error", "")
        print(f"  {table}: {stat.get('inserted',0)}건 삽입, {stat.get('skipped',0)}건 스킵"
              + (f" ({note})" if note else "") + (f" ❌ {err}" if err else ""))
