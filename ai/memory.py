"""
대화 이력 저장 — SQLite 전용 (ChromaDB 완전 제거)
벡터 검색은 engine.py의 TF-IDF 엔진이 담당합니다.
"""
import sqlite3
import os
from datetime import datetime

DB_PATH = os.getenv("DB_PATH", "/tmp/memory.db")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


# ── SQLite 연결 ───────────────────────────────────────

def _conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


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


def retrieve_context(query: str, n: int = 5, persona_id: str = None) -> str:
    """TF-IDF 엔진에서 관련 컨텍스트 검색 (대화 기록 제외, 지식베이스·문서만 반환)"""
    try:
        from engine import get_engine
        engine = get_engine()
        results = engine.search(query, n=n, persona=persona_id)
        if not results:
            return ""
        parts = []
        for q, a, score, meta in results:
            # 이전 대화 기록은 컨텍스트에서 제외 (다른 질문을 오염시킴)
            if meta.get("source") == "대화":
                continue
            parts.append(a[:500])
        return "\n\n".join(parts)
    except Exception as e:
        print(f"⚠️ 컨텍스트 검색 실패: {e}")
        return ""


def store_conversation_memory(user_msg: str, ai_msg: str, persona_id: str = "hr"):
    text = f"사용자: {user_msg}\nAI: {ai_msg}"
    store_memory(text, {
        "source": "대화",
        "persona": persona_id,
        "at": datetime.now().isoformat(),
    })


def store_document(text: str, filename: str, persona_id: str = "hr"):
    """업로드 문서를 청크로 나눠 엔진에 학습"""
    chunks = [text[i:i + 500] for i in range(0, len(text), 400)]
    for i, chunk in enumerate(chunks):
        store_memory(chunk, {
            "source": f"문서:{filename}",
            "persona": persona_id,
            "chunk": i,
        })
    with _conn() as c:
        c.execute(
            "INSERT INTO documents (name, source, persona, created_at) VALUES (?,?,?,?)",
            (filename, "upload", persona_id, datetime.now().isoformat()),
        )


def auto_learn(question: str, answer: str, persona: str = "hr"):
    """자동 학습: Q&A 쌍을 KB에 영구 저장 (재시작 후에도 유지)"""
    content = f"Q: {question}\nA: {answer[:1500]}"
    with _conn() as c:
        c.execute(
            "INSERT INTO learned_knowledge (content, persona, source, created_at) VALUES (?,?,?,?)",
            (content, persona, "자동학습", datetime.now().isoformat()),
        )
    # 엔진이 이미 로드된 경우에만 실시간 반영 (미로드 시 재시작 때 SQLite에서 자동 복원)
    try:
        import engine as eng
        if eng._kb_loaded:
            eng._engine.add(question, answer[:2000], {"persona": persona, "source": "자동학습"})
    except Exception as e:
        print(f"⚠️ 자동학습 엔진 반영 실패: {e}")


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
