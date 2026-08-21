"""
대화 이력 저장 — SQLite 전용 (ChromaDB 완전 제거)
벡터 검색은 engine.py의 TF-IDF 엔진이 담당합니다.
"""
import sqlite3
import os
import contextlib
from datetime import datetime

# 기본 DB 경로: 앱 디렉토리 기준 상대 경로 (재시작 후에도 유지)
# Render.com: 디스크를 {app_dir}/data 에 마운트하면 자동으로 영속 저장
# 환경변수로 덮어쓰기 가능: DB_PATH=/app/data/memory.db
_APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.getenv("DB_PATH", os.path.join(_APP_DIR, "data", "memory.db"))
_db_dir = os.path.dirname(DB_PATH)
if _db_dir:
    os.makedirs(_db_dir, exist_ok=True)


# ── SQLite 연결 ───────────────────────────────────────

@contextlib.contextmanager
def _conn():
    # busy_timeout: 동시 쓰기 시 즉시 "database is locked" 에러 대신 대기 후 재시도
    # WAL: 읽기와 쓰기가 서로 블로킹하지 않도록 동시성 향상
    # contextmanager로 감싸 `with _conn() as c:` 블록 종료 시 연결이 항상 close되도록 함
    # (sqlite3.Connection을 그대로 with에 넘기면 commit/rollback만 되고 close되지 않아 누수됨)
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=10000")
    try:
        with c:
            yield c
    finally:
        c.close()


def init_db():
    with _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            persona TEXT DEFAULT 'hr',
            created_at TEXT NOT NULL
        )""")
        c.execute("""CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            source TEXT NOT NULL,
            persona TEXT DEFAULT 'hr',
            created_at TEXT NOT NULL
        )""")
        c.execute("""CREATE TABLE IF NOT EXISTS learned_knowledge (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            persona TEXT DEFAULT '',
            source TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )""")
        c.execute("""CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            rating INTEGER NOT NULL,
            persona TEXT DEFAULT 'hr',
            created_at TEXT NOT NULL
        )""")
        # 정적 KB 항목 해시 추적 (중복 방지용)
        c.execute("""CREATE TABLE IF NOT EXISTS kb_static_index (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_hash TEXT UNIQUE NOT NULL,
            persona TEXT DEFAULT '',
            source TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )""")
        # 피드백 기반 검색 가중치 (질문+페르소나 단위, 좋아요/싫어요로 점수 보정)
        c.execute("""CREATE TABLE IF NOT EXISTS feedback_boost (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            persona TEXT NOT NULL,
            q_lower TEXT NOT NULL,
            boost REAL NOT NULL DEFAULT 1.0,
            updated_at TEXT NOT NULL,
            UNIQUE(persona, q_lower)
        )""")
        # 앱 전역 설정 (key-value, JSON 직렬화) — 재배포/재시작 후에도 유지되는 사용자 설정값
        c.execute("""CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""")
    # 정적 KB를 SQLite에 영구 저장 (엔진 재시작 후에도 검색 가능)
    _seed_static_kb_to_db()


def _seed_static_kb_to_db():
    """정적 KB(Python 파일)를 SQLite learned_knowledge에 영구 저장.
    content_hash 기반 중복 방지 — 서버 재시작 시 재실행해도 안전."""
    import hashlib
    try:
        from knowledge_base import KNOWLEDGE
    except Exception as e:
        print(f"⚠️ KB 시드 스킵: {e}")
        return

    new_count = 0
    with _conn() as c:
        existing = {row[0] for row in c.execute("SELECT content_hash FROM kb_static_index")}
        rows_kb, rows_idx = [], []
        for item in KNOWLEDGE:
            q = item.get("q", "").strip()
            a = item.get("a", "").strip()
            if not q or not a:
                continue
            content = f"Q: {q}\nA: {a}"
            h = hashlib.md5(content[:500].encode()).hexdigest()
            if h in existing:
                continue
            persona = item.get("persona", "")
            now = datetime.now().isoformat()
            rows_kb.append((content[:2000], persona, "정적KB", now))
            rows_idx.append((h, persona, "정적KB", now))

        if rows_kb:
            c.executemany(
                "INSERT INTO learned_knowledge (content, persona, source, created_at) VALUES (?,?,?,?)",
                rows_kb,
            )
            c.executemany(
                "INSERT OR IGNORE INTO kb_static_index (content_hash, persona, source, created_at) VALUES (?,?,?,?)",
                rows_idx,
            )
            new_count = len(rows_kb)

    if new_count:
        print(f"  💾 정적 KB {new_count}개 → SQLite 영구 저장 완료")


# ── 대화 이력 ─────────────────────────────────────────

def save_message(role: str, content: str, persona: str = "hr"):
    with _conn() as c:
        c.execute(
            "INSERT INTO conversations (role, content, persona, created_at) VALUES (?,?,?,?)",
            (role, content, persona, datetime.now().isoformat()),
        )


def get_history(limit: int = 20, persona: str = None) -> list:
    with _conn() as c:
        if persona:
            rows = c.execute(
                "SELECT role, content, persona, created_at FROM conversations"
                " WHERE persona=? ORDER BY id DESC LIMIT ?",
                (persona, limit),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT role, content, persona, created_at FROM conversations"
                " ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
    return [dict(r) for r in reversed(rows)]


def get_recent_messages(limit: int = 10, persona: str = None) -> list:
    rows = get_history(limit, persona=persona)
    return [{"role": r["role"], "content": r["content"]} for r in rows]


def clear_history(persona: str = None):
    with _conn() as c:
        if persona:
            c.execute("DELETE FROM conversations WHERE persona=?", (persona,))
        else:
            c.execute("DELETE FROM conversations")


# ── 지식 저장 & 검색 (engine.py TF-IDF 연동) ────────────

def store_memory(text: str, metadata: dict = None):
    """텍스트를 엔진에 학습시키고 SQLite에 영속 저장"""
    meta = metadata or {}
    persona = meta.get("persona", "")

    # SQLite 저장 (영속성)
    with _conn() as c:
        c.execute(
            "INSERT INTO learned_knowledge (content, persona, source, created_at) VALUES (?,?,?,?)",
            (text[:2000], persona, meta.get("source", ""), datetime.now().isoformat()),
        )

    # 엔진 실시간 학습
    try:
        from engine import teach
        teach(text, persona=persona, source=meta.get("source", "learned"))
    except Exception as e:
        print(f"⚠️ 엔진 학습 실패: {e}")


def retrieve_best(query: str, n: int = 5, persona_id: str = None) -> dict:
    """
    TF-IDF 검색 결과를 점수와 함께 반환.
    Returns:
        {
          "context": str,       # LLM에 전달할 컨텍스트 (500자 조각 합산)
          "best_score": float,  # 최고 유사도 점수 (0.0 ~ 1.0+)
          "top_answer": str,    # 1위 KB 항목 전체 답변 (직접 서빙용)
          "top_question": str,  # 1위 KB 항목 질문
        }
    """
    empty = {"context": "", "best_score": 0.0, "top_answer": "", "top_question": "", "top_results": []}
    try:
        from engine import get_engine
        engine = get_engine()
        results = engine.search(query, n=n, persona=persona_id)
        if not results:
            return empty

        parts = []
        best_score = 0.0
        top_answer = ""
        top_question = ""
        top_results = []   # 대화 제외, 점수 내림차순 전체 결과 (company 다중 표시용)

        # 최고 점수 항목 파악 + 전체 결과 수집
        for q, a, score, meta in results:
            if meta.get("source") == "대화":
                continue
            top_results.append((q, a, score))
            if score > best_score:
                best_score = score
                top_answer = a
                top_question = q

        # 컨텍스트 포함 기준:
        # - best_score < 0.15: 관련도 너무 낮음 → 컨텍스트 전체 제외
        # - 1위 항목에 항상 주제 겹침 확인 (점수 무관) → 완전히 다른 주제 차단
        # - 주제 겹침 통과 시: 1위 항목 + 1위 점수의 70% 이상인 항목 포함
        CONTEXT_ABS_MIN = 0.15

        def _has_topic_overlap(user_q: str, match_q: str) -> bool:
            import re as _re
            # 구별력 없는 범용 단어 제외 (조작어, 법률 일반어 등)
            STOP = {
                # 조작어/검색어
                '방법', '알려줘', '어떻게', '주세요', '알아봐', '이란', '하는',
                '대한', '관련', '경우', '때는', '이면', '하면', '것은', '무엇',
                '해줘', '있나', '알고', '궁금', '질문', '입니다', '있어요',
                '최근', '요약', '정리', '설명', '조회', '확인', '검색',
                # 법률·HR 일반어 (너무 흔해 구별력 없음)
                '판례', '기준', '처리', '절차', '규정', '조항', '해당', '적용',
                '내용', '관한', '따른', '위한', '통한', '이상', '이하', '미만',
                '근거', '의무', '권리', '규칙', '법률', '법령', '위반', '처벌',
                # 숫자/단위 (단독으로는 구별력 없음)
                '개년', '개월', '년도', '이후', '이전', '현재', '최신',
            }
            words = set(_re.findall(r'[가-힣]{2,}', user_q)) - STOP
            # 검색어가 모두 일반어라 필터 후 빈 경우 → 통과 (LLM이 판단)
            if not words:
                return True
            # 부분문자열 매칭: '징계' in '징계를 받을...' → True
            # (집합 교집합은 조사 붙은 형태와 매칭 실패 — e.g., '징계' ≠ '징계를')
            return any(w in match_q for w in words)

        for i, (q, a, score, meta) in enumerate(results):
            if meta.get("source") == "대화":
                continue
            if best_score < CONTEXT_ABS_MIN:
                break  # 관련도 불충분 → 컨텍스트 없음
            # 1위 항목은 점수와 무관하게 항상 주제 겹침 확인
            # (TF-IDF는 점수가 높아도 전혀 다른 주제를 반환할 수 있음)
            if i == 0 and not _has_topic_overlap(query, top_question):
                break  # 주제 불일치 → 컨텍스트 전체 제외
            if i == 0 or score >= best_score * 0.7:
                # 1위 항목은 최대 1000자 (판례 등 긴 내용 보존), 나머지는 500자
                limit = 1000 if i == 0 else 500
                parts.append(a[:limit])

        return {
            "context": "\n\n".join(parts),
            "best_score": best_score,
            "top_answer": top_answer,
            "top_question": top_question,
            "top_results": top_results,
        }
    except Exception as e:
        print(f"⚠️ 컨텍스트 검색 실패: {e}")
        return empty


def store_document(text: str, filename: str, persona_id: str = "hr"):
    """업로드 문서를 청크로 나눠 엔진에 학습 — 동일 파일 재업로드 시 기존 청크 교체"""
    src = f"문서:{filename}"
    # 기존 동일 파일 청크 삭제 (SQLite)
    with _conn() as c:
        c.execute(
            "DELETE FROM learned_knowledge WHERE source=? AND persona=?",
            (src, persona_id),
        )
    # 엔진에서도 소프트 삭제
    try:
        from engine import get_engine, _kb_loaded
        if _kb_loaded:
            get_engine().delete_by_source(src, persona_id)
    except Exception:
        pass

    chunks = [text[i:i + 500] for i in range(0, len(text), 400)]
    for i, chunk in enumerate(chunks):
        store_memory(chunk, {
            "source": src,
            "persona": persona_id,
            "chunk": i,
        })
    with _conn() as c:
        c.execute(
            "INSERT INTO documents (name, source, persona, created_at) VALUES (?,?,?,?)",
            (filename, "upload", persona_id, datetime.now().isoformat()),
        )


def upsert_knowledge(question: str, answer: str, persona: str,
                     source: str = "직접입력") -> bool:
    """Q&A를 KB에 저장 — 동일 질문이 있으면 최신 내용으로 업데이트, 없으면 신규 추가.
    Returns True if updated (existing replaced), False if inserted (new entry).
    """
    content = f"Q: {question}\nA: {answer[:1500]}"
    now = datetime.now().isoformat()
    q_lower = question.strip().lower()

    with _conn() as c:
        rows = c.execute(
            "SELECT id, content FROM learned_knowledge"
            " WHERE persona=? AND source NOT IN ('정적KB') ORDER BY id DESC",
            (persona,),
        ).fetchall()

        existing_id = None
        for row in rows:
            rc = dict(row)["content"]
            if rc.startswith("Q: ") and "\nA: " in rc:
                eq = rc.split("\nA: ", 1)[0][3:].strip().lower()
                if eq == q_lower:
                    existing_id = dict(row)["id"]
                    break

        if existing_id:
            c.execute(
                "UPDATE learned_knowledge SET content=?, source=?, created_at=? WHERE id=?",
                (content, source, now, existing_id),
            )
            updated = True
        else:
            c.execute(
                "INSERT INTO learned_knowledge (content, persona, source, created_at) VALUES (?,?,?,?)",
                (content, persona, source, now),
            )
            updated = False

    # 엔진: 기존 동일 질문 삭제 후 새 버전 추가
    try:
        from engine import get_engine, _kb_loaded
        if _kb_loaded:
            get_engine().delete_by_q(question, persona)
            get_engine().add(question, answer[:2000], {"persona": persona, "source": source})
    except Exception as e:
        print(f"⚠️ 엔진 학습 실패: {e}")

    return updated


def auto_learn(question: str, answer: str, persona: str = "hr"):
    """자동 학습: 품질 검증 후 KB 영구 저장"""
    # 품질 게이트 1: 너무 짧은 Q/A 제외
    if len(question.strip()) < 8 or len(answer.strip()) < 60:
        return
    # 품질 게이트 2: 에러·오류 메시지 제외
    lower_a = answer.lower()
    if any(kw in lower_a for kw in ["traceback", "error:", "exception:", "오류 발생", "알 수 없는 오류"]):
        return
    # 품질 게이트 3: 기존 KB와 중복 여부 (이미 engine.py upsert에서 동일 질문 체크)
    upsert_knowledge(question, answer, persona, source="자동학습")


def list_documents() -> list:
    with _conn() as c:
        rows = c.execute(
            "SELECT name, source, persona, created_at FROM documents ORDER BY id DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def save_feedback(question: str, answer: str, rating: int, persona: str = "hr"):
    with _conn() as c:
        c.execute(
            "INSERT INTO feedback (question, answer, rating, persona, created_at) VALUES (?,?,?,?,?)",
            (question[:500], answer[:1000], rating, persona, datetime.now().isoformat())
        )

def apply_feedback_boost(persona: str, question: str, rating: int) -> float:
    """피드백을 질문 단위 가중치로 누적 반영.
    👍: 즉시 1.0 이상으로 끌어올려 유사 질문 검색 시 우선 노출.
    👎: 점수를 낮춰 KB_CONTEXT 임계값 아래로 떨어지면 다음 질문 시 새로 생성되도록 유도."""
    q_lower = question.strip().lower()
    now = datetime.now().isoformat()
    with _conn() as c:
        row = c.execute(
            "SELECT boost FROM feedback_boost WHERE persona=? AND q_lower=?",
            (persona, q_lower),
        ).fetchone()
        cur = row["boost"] if row else 1.0
        if rating > 0:
            boost = min(max(cur, 1.0) * 1.3, 3.0)
        else:
            boost = max(cur * 0.4, 0.05)
        c.execute(
            "INSERT INTO feedback_boost (persona, q_lower, boost, updated_at) VALUES (?,?,?,?)"
            " ON CONFLICT(persona, q_lower) DO UPDATE SET boost=?, updated_at=?",
            (persona, q_lower, boost, now, boost, now),
        )
    return boost


def get_feedback_boosts() -> dict:
    """(persona, q_lower) -> boost 전체 맵 — 엔진 로드 시 1회 호출"""
    with _conn() as c:
        rows = c.execute("SELECT persona, q_lower, boost FROM feedback_boost").fetchall()
    return {(r["persona"], r["q_lower"]): r["boost"] for r in rows}


def get_feedback_stats() -> dict:
    with _conn() as c:
        rows = c.execute("""
            SELECT persona,
                   SUM(CASE WHEN rating=1 THEN 1 ELSE 0 END) as good,
                   SUM(CASE WHEN rating=-1 THEN 1 ELSE 0 END) as bad,
                   COUNT(*) as total
            FROM feedback GROUP BY persona
        """).fetchall()
        return {r['persona']: {'good': r['good'], 'bad': r['bad'], 'total': r['total']} for r in rows}


def memory_stats() -> dict:
    with _conn() as c:
        msg_count = c.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
        doc_count = c.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        learned_count = c.execute("SELECT COUNT(*) FROM learned_knowledge").fetchone()[0]

    try:
        from engine import get_engine
        engine_count = get_engine().count()
    except Exception:
        engine_count = 0

    return {
        "conversations": msg_count,
        "documents": doc_count,
        "vector_chunks": engine_count,
        "learned_items": learned_count,
        "engine": "자체 TF-IDF 엔진 (외부 API 없음)",
    }


def save_setting(key: str, value: dict):
    """앱 전역 설정 저장 (JSON 직렬화) — 재배포/재시작 후에도 유지"""
    import json
    now = datetime.now().isoformat()
    with _conn() as c:
        c.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)"
            " ON CONFLICT(key) DO UPDATE SET value=?, updated_at=?",
            (key, json.dumps(value, ensure_ascii=False), now, json.dumps(value, ensure_ascii=False), now),
        )


def get_setting(key: str, default: dict = None) -> dict:
    """저장된 앱 전역 설정 조회. 없으면 default 반환"""
    import json
    with _conn() as c:
        row = c.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row["value"])
    except Exception:
        return default
