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
    "conversations": ["role", "content", "persona", "created_at"],
    "learned_knowledge": ["content", "persona", "source", "created_at"],
    "documents": ["name", "source", "persona", "created_at"],
    "feedback": ["question", "answer", "rating", "persona", "created_at"],
    "app_settings": ["key", "value", "updated_at"],
    "feedback_boost": ["persona", "q_lower", "boost", "updated_at"],
    "kb_static_index": ["content_hash", "persona", "source", "created_at"],
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
