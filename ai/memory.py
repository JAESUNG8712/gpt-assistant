"""
대화 이력 저장 — SQLite(로컬) 또는 Turso(클라우드) 자동 전환
  TURSO_DATABASE_URL + TURSO_AUTH_TOKEN 환경변수가 모두 설정되면 Turso 사용
  그렇지 않으면 기존 로컬 SQLite(DB_PATH) 사용
벡터 검색은 engine.py의 TF-IDF 엔진이 담당합니다.
"""
import sqlite3
import os
import contextlib
from datetime import datetime

_APP_DIR = os.path.dirname(os.path.abspath(__file__))

# ── Turso 설정 ────────────────────────────────────────────
TURSO_URL   = os.getenv("TURSO_DATABASE_URL", "").strip()
TURSO_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "").strip()
_USE_TURSO  = bool(TURSO_URL and TURSO_TOKEN)

# ── 로컬 SQLite 경로 (Turso 미사용 시) ───────────────────
_DEFAULT_DB = os.path.join(_APP_DIR, "data", "memory.db")
DB_PATH = os.getenv("DB_PATH", _DEFAULT_DB)
if not _USE_TURSO:
    _db_dir = os.path.dirname(DB_PATH)
    if _db_dir:
        try:
            os.makedirs(_db_dir, exist_ok=True)
        except PermissionError:
            # 지정된 경로에 권한이 없으면 앱 디렉토리 하위로 fallback
            DB_PATH = _DEFAULT_DB
            os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
            print(f"⚠️ DB_PATH 권한 없음 — fallback: {DB_PATH}")

if _USE_TURSO:
    print(f"✅ Turso 클라우드 DB 사용: {TURSO_URL}")
else:
    print(f"📁 로컬 SQLite 사용: {DB_PATH}")


# ── Row / Cursor 호환 래퍼 ────────────────────────────────

class _Row(dict):
    """컬럼명+값 tuple → sqlite3.Row 호환 dict.
    r["col"], r[0], dict(r) 패턴을 모두 지원."""

    __slots__ = ("_vals",)

    def __init__(self, columns, values):
        super().__init__(zip(columns, values))
        object.__setattr__(self, "_vals", tuple(values))

    def __getitem__(self, key):
        if isinstance(key, int):
            return object.__getattribute__(self, "_vals")[key]
        return super().__getitem__(key)


class _EmptyCursor:
    """PRAGMA 등 결과 없는 쿼리용 placeholder."""
    def fetchall(self): return []
    def fetchone(self): return None
    def __iter__(self): return iter([])


class _InMemoryCursor:
    """Turso HTTP 응답 rows를 sqlite3 커서처럼 감싸는 래퍼."""

    def __init__(self, cols, rows):
        self._cols = cols
        self._rows = rows  # list of tuples

    def fetchall(self):
        return [_Row(self._cols, r) for r in self._rows]

    def fetchone(self):
        return _Row(self._cols, self._rows[0]) if self._rows else None

    def __iter__(self):
        return iter(self.fetchall())


# ── Turso HTTP API 클라이언트 (순수 Python — Rust 불필요) ──

class _TursoHttpConn:
    """Turso /v2/pipeline HTTP API 클라이언트.
    libsql-experimental(Rust 빌드 필요) 대신 urllib로 동작."""

    _BATCH = 80  # executemany 1회 HTTP 요청당 최대 행 수

    def __init__(self, db_url: str, token: str):
        # libsql://xxx.turso.io → https://xxx.turso.io/v2/pipeline
        base = db_url.replace("libsql://", "https://").rstrip("/")
        self._endpoint = base + "/v2/pipeline"
        self._token = token

    # ── 값 변환 ──────────────────────────────────────────
    @staticmethod
    def _enc(v):
        """Python → Turso 타입 dict."""
        if v is None:               return {"type": "null"}
        if isinstance(v, bool):     return {"type": "integer", "value": "1" if v else "0"}
        if isinstance(v, int):      return {"type": "integer", "value": str(v)}
        if isinstance(v, float):    return {"type": "float",   "value": v}
        return {"type": "text", "value": str(v)}

    @staticmethod
    def _dec(v):
        """Turso 타입 dict → Python."""
        t, val = v.get("type"), v.get("value")
        if t == "null":    return None
        if t == "integer": return int(val)
        if t == "float":   return float(val)
        return val  # text / blob

    # ── HTTP 전송 ─────────────────────────────────────────
    def _send(self, requests: list) -> list:
        import urllib.request, json as _j
        body = _j.dumps({"requests": requests}).encode()
        req = urllib.request.Request(
            self._endpoint,
            data=body,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type":  "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return _j.loads(resp.read())["results"]

    def _stmt(self, sql: str, params=()):
        return {"sql": sql, "args": [self._enc(p) for p in params]}

    # ── 공개 인터페이스 ───────────────────────────────────
    def execute(self, sql: str, params=()):
        if sql.strip().upper().startswith("PRAGMA"):
            return _EmptyCursor()
        results = self._send([
            {"type": "execute", "stmt": self._stmt(sql, params)},
            {"type": "close"},
        ])
        r = results[0]
        if r.get("type") == "error":
            raise Exception(r.get("error", {}).get("message", "Turso error"))
        data = r["response"]["result"]
        cols = [c["name"] for c in data.get("cols", [])]
        rows = [tuple(self._dec(v) for v in row) for row in data.get("rows", [])]
        return _InMemoryCursor(cols, rows)

    def executemany(self, sql: str, seq):
        items = list(seq)
        for i in range(0, len(items), self._BATCH):
            batch = items[i: i + self._BATCH]
            reqs = [{"type": "execute", "stmt": self._stmt(sql, p)} for p in batch]
            reqs.append({"type": "close"})
            results = self._send(reqs)
            for r in results:
                if r.get("type") == "error":
                    raise Exception(r.get("error", {}).get("message", "Turso executemany error"))

    def commit(self): pass   # HTTP API는 요청별 자동 커밋
    def close(self):  pass

    def __enter__(self): return self
    def __exit__(self, exc_type, exc_val, exc_tb): return False


# ── 연결 컨텍스트 매니저 ──────────────────────────────────

@contextlib.contextmanager
def _conn():
    if _USE_TURSO:
        c = _TursoHttpConn(TURSO_URL, TURSO_TOKEN)
        try:
            yield c
        finally:
            c.close()
    else:
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
        c.execute("""CREATE TABLE IF NOT EXISTS kb_static_index (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_hash TEXT UNIQUE NOT NULL,
            persona TEXT DEFAULT '',
            source TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )""")
        c.execute("""CREATE TABLE IF NOT EXISTS feedback_boost (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            persona TEXT NOT NULL,
            q_lower TEXT NOT NULL,
            boost REAL NOT NULL DEFAULT 1.0,
            updated_at TEXT NOT NULL,
            UNIQUE(persona, q_lower)
        )""")
        c.execute("""CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""")
        c.execute("""CREATE TABLE IF NOT EXISTS share_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT UNIQUE NOT NULL,
            name TEXT DEFAULT '',
            personas TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            expires_at TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )""")
    _seed_static_kb_to_db()


# 정적 KB 항목 저장 길이 상한. 이전에는 2,000자로 잘라 저장해 긴 답변의 뒷부분이
# 통째로 유실됐다(그 상태로 검색·응답에 쓰였으므로 사용자에게는 "지식이 누락된" 것으로
# 보였다). TF-IDF 인덱싱 비용을 감안해 무제한으로 두지는 않되, 실제 KB 항목 길이를
# 충분히 덮는 값으로 올린다.
KB_MAX_CHARS = int(os.getenv("KB_MAX_CHARS", "20000"))


def _seed_static_kb_to_db():
    """정적 KB(Python 파일)를 SQLite/Turso learned_knowledge에 영구 저장.
    서버 재시작 시 재실행해도 안전하며, 소스에서 수정된 항목은 예전 DB 행을 지우고
    새 내용으로 교체한다 — 그렇지 않으면 소스에서 지운 내용(예: 개인정보, 가상 데이터)이
    예전 DB 행에 그대로 남아 계속 서빙된다(2026-07-15 실제 발견).

    2026-08-10 수정 — 이전 구현의 두 가지 결함:
      1) 중복/변경 판정을 `md5(content[:500])`으로 했다. 앞 500자가 같으면 서로 다른
         항목이 같은 해시가 되어 뒤엣것이 조용히 누락됐고, 반대로 **답변을 500자 이후에서
         수정하면 해시가 그대로라 변경이 감지되지 않아 예전 내용이 계속 서빙**됐다
         (위 2026-07-15 사고와 정확히 같은 유형이 앞 500자 밖에서 재발할 수 있는 구조).
      2) `content[:2000]`으로 잘라 저장해 긴 항목의 뒷부분이 유실됐다.
    이제 **전문(full content)을 그대로 비교**해 판정한다. 별도 해시 인덱스 테이블에
    의존하지 않고 실제 저장된 내용과 대조하므로, 판정 기준이 바뀌어도 중복이 생기지 않고
    스스로 정합을 맞춘다(기존 배포에서 넘어올 때도 안전)."""
    import hashlib
    try:
        from knowledge_base import KNOWLEDGE
    except Exception as e:
        print(f"⚠️ KB 시드 스킵: {e}")
        return

    # 소스 항목을 (persona, q) 키로 정규화. 같은 키가 중복 정의돼 있으면 마지막 것을 쓴다.
    desired = {}
    for item in KNOWLEDGE:
        q = item.get("q", "").strip()
        a = item.get("a", "").strip()
        if not q or not a:
            continue
        persona = item.get("persona", "") or ""
        desired[(persona, q.lower())] = f"Q: {q}\nA: {a}"[:KB_MAX_CHARS]

    new_count = 0
    stale_count = 0
    with _conn() as c:
        stored = {}
        for row in c.execute(
            "SELECT id, persona, content FROM learned_knowledge WHERE source='정적KB'"
        ).fetchall():
            row = dict(row)
            content = row["content"] or ""
            if not (content.startswith("Q: ") and "\nA: " in content):
                continue
            q_part = content.split("\nA: ", 1)[0][3:].strip().lower()
            stored.setdefault(((row["persona"] or ""), q_part), []).append(
                (row["id"], content)
            )

        stale_ids, rows_kb, rows_idx = [], [], []
        now = datetime.now().isoformat()
        for key, content in desired.items():
            persona = key[0]
            rows = stored.get(key, [])
            # 내용이 정확히 같은 행이 이미 있으면 그대로 두고, 나머지 중복 행만 정리한다.
            same = [rid for rid, cnt in rows if cnt == content]
            diff = [rid for rid, cnt in rows if cnt != content]
            stale_ids.extend(diff)
            if same:
                stale_ids.extend(same[1:])   # 같은 내용이 여러 행이면 하나만 남긴다
                continue
            rows_kb.append((content, persona, "정적KB", now))
            rows_idx.append((hashlib.md5(content.encode()).hexdigest(), persona, "정적KB", now))

        if stale_ids:
            placeholders = ",".join("?" * len(stale_ids))
            c.execute(f"DELETE FROM learned_knowledge WHERE id IN ({placeholders})", stale_ids)
            stale_count = len(stale_ids)

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
        print(f"  💾 정적 KB {new_count}개 → DB 영구 저장 완료")
    if stale_count:
        print(f"  🧹 정적 KB {stale_count}개 예전 버전/중복 행 정리 완료")


# ── 대화 이력 ─────────────────────────────────────────────

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


# ── 주제 겹침 검사 (검색 게이트 + 자동학습 품질 게이트 공용) ──

_TOPIC_STOP = {
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


def topic_overlap(user_q: str, target_text: str) -> bool:
    """질문의 핵심 단어(일반어 제외)가 대상 텍스트에 하나라도 등장하는지.
    False면 질문과 대상이 서로 다른 주제일 가능성이 높음."""
    import re as _re
    words = set(_re.findall(r'[가-힣]{2,}', user_q)) - _TOPIC_STOP
    # 질문이 모두 일반어라 필터 후 빈 경우 → 통과 (판단 불가)
    if not words:
        return True
    # 부분문자열 매칭: '징계' in '징계를 받을...' → True
    return any(w in target_text for w in words)


# ── 지식 저장 & 검색 (engine.py TF-IDF 연동) ─────────────

def store_memory(text: str, metadata: dict = None):
    """텍스트를 엔진에 학습시키고 DB에 영속 저장.
    완전히 동일한 내용(같은 persona)이 이미 저장되어 있으면 스킵 — 다른 KB 쓰기
    경로(upsert_knowledge/store_document)는 모두 중복 방지 로직이 있는데 이 함수만
    없어서, search_and_learn()이 같거나 유사한 질의로 반복 호출될 때마다 동일한
    웹검색 결과가 새 행으로 무제한 중복 저장되던 문제(KB 오염·비대화)를 방지."""
    meta = metadata or {}
    persona = meta.get("persona", "")
    source = meta.get("source", "")
    content = text[:2000]

    with _conn() as c:
        existing = c.execute(
            "SELECT id FROM learned_knowledge WHERE content=? AND persona=? LIMIT 1",
            (content, persona),
        ).fetchone()
        if not existing:
            c.execute(
                "INSERT INTO learned_knowledge (content, persona, source, created_at) VALUES (?,?,?,?)",
                (content, persona, source, datetime.now().isoformat()),
            )

    if existing:
        return

    try:
        from engine import teach
        teach(text, persona=persona, source=source or "learned")
    except Exception as e:
        print(f"⚠️ 엔진 학습 실패: {e}")


def retrieve_best(query: str, n: int = 5, persona_id: str = None) -> dict:
    """
    TF-IDF 검색 결과를 점수와 함께 반환.
    Returns:
        {
          "context": str,
          "best_score": float,
          "top_answer": str,
          "top_question": str,
        }
    """
    empty = {"context": "", "best_score": 0.0, "top_answer": "", "top_question": "",
             "top_results": [], "top_source": ""}
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
        top_source = ""
        top_results = []

        for q, a, score, meta in results:
            if meta.get("source") == "대화":
                continue
            top_results.append((q, a, score))
            if score > best_score:
                best_score = score
                top_answer = a
                top_question = q
                top_source = meta.get("source", "")

        CONTEXT_ABS_MIN = 0.15

        for i, (q, a, score, meta) in enumerate(results):
            if meta.get("source") == "대화":
                continue
            if best_score < CONTEXT_ABS_MIN:
                break
            if i == 0 and not topic_overlap(query, top_question):
                break
            if i == 0 or score >= best_score * 0.7:
                limit = 1000 if i == 0 else 500
                parts.append(a[:limit])

        return {
            "context": "\n\n".join(parts),
            "best_score": best_score,
            "top_answer": top_answer,
            "top_question": top_question,
            "top_results": top_results,
            "top_source": top_source,
        }
    except Exception as e:
        print(f"⚠️ 컨텍스트 검색 실패: {e}")
        return empty


def store_document(text: str, filename: str, persona_id: str = "hr"):
    """업로드 문서를 청크로 나눠 엔진에 학습 — 동일 파일 재업로드 시 기존 청크 교체"""
    src = f"문서:{filename}"
    with _conn() as c:
        c.execute(
            "DELETE FROM learned_knowledge WHERE source=? AND persona=?",
            (src, persona_id),
        )
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
    if len(question.strip()) < 8 or len(answer.strip()) < 60:
        return
    lower_a = answer.lower()
    if any(kw in lower_a for kw in ["traceback", "error:", "exception:", "오류 발생", "알 수 없는 오류"]):
        return
    # 품질 게이트 4: 질문 핵심 단어가 답변에 전혀 없으면 주제 불일치(오답 가능성 높음) → 저장 안 함
    # (예: "출장 규정" 질문에 "직장 내 괴롭힘" 답변이 저장되어 이후 동일 질문마다
    #  오답이 직접 서빙되는 KB 오염을 원천 차단)
    if not topic_overlap(question, answer):
        print(f"ℹ️ 자동학습 스킵(질문-답변 주제 불일치): {question[:50]}")
        return
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
    """피드백을 질문 단위 가중치로 누적 반영."""
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
        msg_count     = c.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
        doc_count     = c.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        learned_count = c.execute("SELECT COUNT(*) FROM learned_knowledge").fetchone()[0]

    try:
        from engine import get_engine
        engine_count = get_engine().count()
    except Exception:
        engine_count = 0

    return {
        "conversations":  msg_count,
        "documents":      doc_count,
        "vector_chunks":  engine_count,
        "learned_items":  learned_count,
        "engine":         "자체 TF-IDF 엔진 (외부 API 없음)",
        "db_backend":     "Turso (클라우드)" if _USE_TURSO else f"SQLite ({DB_PATH})",
    }


def save_setting(key: str, value: dict):
    """앱 전역 설정 저장 (JSON 직렬화) — 재배포/재시작 후에도 유지"""
    import json
    now = datetime.now().isoformat()
    with _conn() as c:
        c.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)"
            " ON CONFLICT(key) DO UPDATE SET value=?, updated_at=?",
            (key, json.dumps(value, ensure_ascii=False), now,
             json.dumps(value, ensure_ascii=False), now),
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


# ── 공유 링크 (선택된 페르소나만 외부에 공개) ─────────────

def _row_to_share(row: dict) -> dict:
    import json
    return {
        "token": row["token"],
        "name": row["name"],
        "personas": json.loads(row["personas"]),
        "enabled": bool(row["enabled"]),
        "expires_at": row["expires_at"] or None,
        "created_at": row["created_at"],
    }


def create_share_link(name: str, personas: list, expires_at: str = "") -> dict:
    """공유 링크 생성. token은 URL-safe 랜덤 문자열."""
    import json, secrets
    token = secrets.token_urlsafe(16)
    now = datetime.now().isoformat()
    with _conn() as c:
        c.execute(
            "INSERT INTO share_links (token, name, personas, enabled, expires_at, created_at)"
            " VALUES (?,?,?,1,?,?)",
            (token, name, json.dumps(personas, ensure_ascii=False), expires_at, now),
        )
    return {"token": token, "name": name, "personas": personas,
            "enabled": True, "expires_at": expires_at or None, "created_at": now}


def get_share_link(token: str) -> dict:
    """토큰으로 공유 링크 조회. 없으면 None. 만료 여부는 호출측에서 판단."""
    with _conn() as c:
        row = c.execute(
            "SELECT token, name, personas, enabled, expires_at, created_at"
            " FROM share_links WHERE token=?",
            (token,),
        ).fetchone()
    if not row:
        return None
    return _row_to_share(dict(row))


def list_share_links() -> list:
    with _conn() as c:
        rows = c.execute(
            "SELECT token, name, personas, enabled, expires_at, created_at"
            " FROM share_links ORDER BY id DESC"
        ).fetchall()
    return [_row_to_share(dict(r)) for r in rows]


def revoke_share_link(token: str) -> bool:
    with _conn() as c:
        row = c.execute("SELECT id FROM share_links WHERE token=?", (token,)).fetchone()
        if not row:
            return False
        c.execute("DELETE FROM share_links WHERE token=?", (token,))
    return True
