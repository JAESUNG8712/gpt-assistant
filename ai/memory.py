import sqlite3
import os
import hashlib
from datetime import datetime

# Disk 없는 무료 배포 환경에서는 /tmp 사용 (항상 쓰기 가능)
DB_PATH     = os.getenv("DB_PATH", "/tmp/memory.db")
CHROMA_PATH = os.getenv("CHROMA_PATH", "/tmp/chroma")

os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
os.makedirs(CHROMA_PATH, exist_ok=True)


# ── SQLite — 대화 이력 ────────────────────────────────

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
        # 벡터 검색 불가 시 폴백용 텍스트 저장소
        c.execute("""CREATE TABLE IF NOT EXISTS vector_fallback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT UNIQUE NOT NULL,
            content TEXT NOT NULL,
            source TEXT DEFAULT '',
            persona TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )""")

def save_message(role: str, content: str, persona: str = "hr"):
    with _conn() as c:
        c.execute(
            "INSERT INTO conversations (role, content, persona, created_at) VALUES (?,?,?,?)",
            (role, content, persona, datetime.now().isoformat()),
        )

def get_history(limit: int = 20, persona: str = None) -> list[dict]:
    with _conn() as c:
        if persona:
            rows = c.execute(
                "SELECT role, content, persona, created_at FROM conversations WHERE persona=? ORDER BY id DESC LIMIT ?",
                (persona, limit),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT role, content, persona, created_at FROM conversations ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
    return [dict(r) for r in reversed(rows)]

def get_recent_messages(limit: int = 10, persona: str = None) -> list[dict]:
    rows = get_history(limit, persona=persona)
    return [{"role": r["role"], "content": r["content"]} for r in rows]

def clear_history(persona: str = None):
    with _conn() as c:
        if persona:
            c.execute("DELETE FROM conversations WHERE persona=?", (persona,))
        else:
            c.execute("DELETE FROM conversations")


# ── ChromaDB — 벡터 기반 장기 기억 (RAG) ─────────────
# 초기화 실패 시 SQLite 폴백으로 자동 전환 (앱은 계속 실행)

_col = None
CHROMA_AVAILABLE = False

def _init_chroma():
    global _col, CHROMA_AVAILABLE
    try:
        import chromadb
        client = chromadb.PersistentClient(path=CHROMA_PATH)
        _col = client.get_or_create_collection("memory")
        CHROMA_AVAILABLE = True
        print("✅ ChromaDB 초기화 성공")
    except Exception as e:
        print(f"⚠️ ChromaDB 초기화 실패 → SQLite 폴백 모드로 실행: {e}")
        CHROMA_AVAILABLE = False

_init_chroma()


def _doc_id(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()


# ── 벡터 저장 ─────────────────────────────────────────

def store_memory(text: str, metadata: dict = None):
    meta = metadata or {}
    if CHROMA_AVAILABLE and _col is not None:
        try:
            _col.upsert(
                ids=[_doc_id(text)],
                documents=[text],
                metadatas=[meta],
            )
            return
        except Exception as e:
            print(f"⚠️ ChromaDB 저장 실패 → SQLite 폴백: {e}")

    # SQLite 폴백
    with _conn() as c:
        c.execute(
            """INSERT OR REPLACE INTO vector_fallback
               (doc_id, content, source, persona, created_at)
               VALUES (?,?,?,?,?)""",
            (
                _doc_id(text),
                text,
                meta.get("source", ""),
                meta.get("persona", ""),
                datetime.now().isoformat(),
            ),
        )


# ── 벡터 검색 ─────────────────────────────────────────

def retrieve_context(query: str, n: int = 5, persona_id: str = None) -> str:
    if CHROMA_AVAILABLE and _col is not None:
        try:
            count = _col.count()
            if count == 0:
                return ""
            if persona_id:
                results = _col.query(
                    query_texts=[query],
                    n_results=min(n, count),
                    where={"persona": {"$eq": persona_id}},
                )
            else:
                results = _col.query(query_texts=[query], n_results=min(n, count))

            docs  = results.get("documents", [[]])[0]
            metas = results.get("metadatas", [[]])[0]
            parts = []
            for doc, meta in zip(docs, metas):
                src = meta.get("source", "기억")
                parts.append(f"[{src}]\n{doc}")
            return "\n\n".join(parts)
        except Exception as e:
            print(f"⚠️ ChromaDB 검색 실패 → SQLite 폴백: {e}")

    # SQLite 폴백: 키워드 포함된 내용 반환
    with _conn() as c:
        keywords = query.split()[:3]
        conditions = " OR ".join(["content LIKE ?" for _ in keywords])
        params = [f"%{kw}%" for kw in keywords]
        if persona_id:
            conditions = f"({conditions}) AND persona=?"
            params.append(persona_id)
        rows = c.execute(
            f"SELECT content, source FROM vector_fallback WHERE {conditions} LIMIT ?",
            params + [n],
        ).fetchall()
    parts = [f"[{r['source'] or '기억'}]\n{r['content']}" for r in rows]
    return "\n\n".join(parts)


def store_conversation_memory(user_msg: str, ai_msg: str, persona_id: str = "hr"):
    text = f"사용자: {user_msg}\nAI: {ai_msg}"
    store_memory(text, {
        "source": "대화",
        "persona": persona_id,
        "at": datetime.now().isoformat(),
    })

def store_document(text: str, filename: str, persona_id: str = "hr"):
    chunks = [text[i:i+500] for i in range(0, len(text), 400)]
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

def list_documents() -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT name, source, persona, created_at FROM documents ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]

def memory_stats() -> dict:
    with _conn() as c:
        msg_count = c.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
        doc_count = c.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        fallback_count = c.execute("SELECT COUNT(*) FROM vector_fallback").fetchone()[0]

    vector_count = 0
    if CHROMA_AVAILABLE and _col is not None:
        try:
            vector_count = _col.count()
        except Exception:
            vector_count = fallback_count
    else:
        vector_count = fallback_count

    return {
        "conversations": msg_count,
        "documents": doc_count,
        "vector_chunks": vector_count,
        "chroma_available": CHROMA_AVAILABLE,
    }
