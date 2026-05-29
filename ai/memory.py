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
    result = retrieve_best(query, n=n, persona_id=persona_id)
    return result["context"]


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
    empty = {"context": "", "best_score": 0.0, "top_answer": "", "top_question": ""}
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

        # 최고 점수 항목 먼저 파악
        for q, a, score, meta in results:
            if meta.get("source") == "대화":
                continue
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
            match_words = set(_re.findall(r'[가-힣]{2,}', match_q)) - STOP
            # 검색어가 모두 일반어라 필터 후 빈 경우 → 통과 (LLM이 판단)
            if not words:
                return True
            return bool(words & match_words)

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
        }
    except Exception as e:
        print(f"⚠️ 컨텍스트 검색 실패: {e}")
        return empty


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
