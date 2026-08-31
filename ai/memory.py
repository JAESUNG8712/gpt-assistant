"""
대화 이력 저장 — SQLite(로컬) 또는 Turso(클라우드) 자동 전환
  TURSO_DATABASE_URL + TURSO_AUTH_TOKEN 환경변수가 모두 설정되면 Turso 사용
  그렇지 않으면 기존 로컬 SQLite(DB_PATH) 사용
벡터 검색은 engine.py의 TF-IDF 엔진이 담당합니다.
"""
import sqlite3
import os
import contextlib
import hashlib
import hmac
import json
import re
from datetime import datetime, timedelta
from urllib.parse import urlsplit, urlunsplit

import privacy as privacy_guard

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


def init_db(seed_static: bool = True):
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
        for column_sql in (
            "ALTER TABLE learned_knowledge ADD COLUMN evidence_json TEXT DEFAULT '[]'",
            "ALTER TABLE learned_knowledge ADD COLUMN verified_at TEXT DEFAULT ''",
            "ALTER TABLE learned_knowledge ADD COLUMN valid_until TEXT DEFAULT ''",
        ):
            try:
                c.execute(column_sql)
            except Exception as e:
                if "duplicate column" not in str(e).lower() and "already exists" not in str(e).lower():
                    raise
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
        # 기존 운영 DB 무손실 마이그레이션. Turso HTTP 래퍼는 PRAGMA 결과를
        # 반환하지 않으므로 ADD COLUMN을 시도하고 "이미 존재" 오류만 무시한다.
        try:
            c.execute("ALTER TABLE conversations ADD COLUMN session_id TEXT DEFAULT 'legacy'")
        except Exception as e:
            if "duplicate column" not in str(e).lower() and "already exists" not in str(e).lower():
                raise
        c.execute("""CREATE TABLE IF NOT EXISTS memory_candidates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_hash TEXT NOT NULL,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            persona TEXT DEFAULT 'hr',
            session_id TEXT DEFAULT '',
            source TEXT DEFAULT '자동응답',
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL,
            reviewed_at TEXT DEFAULT '',
            UNIQUE(content_hash, persona)
        )""")
        for column_sql in (
            "ALTER TABLE memory_candidates ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE memory_candidates ADD COLUMN last_seen_at TEXT DEFAULT ''",
            "ALTER TABLE memory_candidates ADD COLUMN evidence_json TEXT DEFAULT '[]'",
            "ALTER TABLE memory_candidates ADD COLUMN verified_at TEXT DEFAULT ''",
            "ALTER TABLE memory_candidates ADD COLUMN valid_until TEXT DEFAULT ''",
        ):
            try:
                c.execute(column_sql)
            except Exception as e:
                if "duplicate column" not in str(e).lower() and "already exists" not in str(e).lower():
                    raise
        c.execute("""CREATE TABLE IF NOT EXISTS memory_quarantine (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            persona TEXT DEFAULT '',
            source TEXT DEFAULT '',
            original_created_at TEXT DEFAULT '',
            reason TEXT NOT NULL,
            quarantined_at TEXT NOT NULL,
            restored_at TEXT DEFAULT ''
        )""")
        for column_sql in (
            "ALTER TABLE memory_quarantine ADD COLUMN evidence_json TEXT DEFAULT '[]'",
            "ALTER TABLE memory_quarantine ADD COLUMN original_verified_at TEXT DEFAULT ''",
            "ALTER TABLE memory_quarantine ADD COLUMN original_valid_until TEXT DEFAULT ''",
        ):
            try:
                c.execute(column_sql)
            except Exception as e:
                if "duplicate column" not in str(e).lower() and "already exists" not in str(e).lower():
                    raise
        c.execute("""CREATE TABLE IF NOT EXISTS memory_retrieval_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query_hash TEXT NOT NULL,
            persona TEXT DEFAULT '',
            session_kind TEXT DEFAULT 'owner',
            top_source TEXT DEFAULT '',
            best_score REAL NOT NULL DEFAULT 0,
            result_count INTEGER NOT NULL DEFAULT 0,
            used_context INTEGER NOT NULL DEFAULT 0,
            route TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_conversations_scope ON conversations(session_id, persona, id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_candidates_status ON memory_candidates(status, persona, id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_learned_persona_source ON learned_knowledge(persona, source, id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_learned_validity ON learned_knowledge(valid_until, persona, id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_quarantine_active ON memory_quarantine(restored_at, id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_retrieval_created ON memory_retrieval_events(created_at, persona)")
    if seed_static:
        _seed_static_kb_to_db()


_SOURCE_VALIDITY_DEFAULTS = {
    "법령실시간": 30,
    "웹검색보강": 14,
    "KB보강생성": 180,
    "생성답변": 90,
    "승인학습": 180,
    "law.go.kr": 30,
    "mofa_travel_alert": 7,
}

_SOURCE_VALIDITY_ENV = {
    "법령실시간": "MEMORY_VALIDITY_LAW_DAYS",
    "law.go.kr": "MEMORY_VALIDITY_LAW_DAYS",
    "웹검색보강": "MEMORY_VALIDITY_WEB_DAYS",
    "KB보강생성": "MEMORY_VALIDITY_KB_AUGMENTED_DAYS",
    "생성답변": "MEMORY_VALIDITY_GENERATED_DAYS",
    "승인학습": "MEMORY_VALIDITY_APPROVED_DAYS",
    "mofa_travel_alert": "MEMORY_VALIDITY_TRAVEL_DAYS",
}


def _parse_iso_datetime(value: str):
    try:
        return datetime.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def _source_validity_days(source: str) -> int | None:
    """출처별 기본 유효기간. 정적KB·직접입력·문서는 명시 검증 전까지 무기한."""
    value = source or ""
    env_key = _SOURCE_VALIDITY_ENV.get(value)
    if not env_key:
        suffix = re.sub(r"[^A-Z0-9]+", "_", value.upper()).strip("_")
        env_key = f"MEMORY_VALIDITY_{suffix}_DAYS" if suffix else ""
    if env_key and os.getenv(env_key):
        try:
            return max(1, min(int(os.getenv(env_key)), 3650))
        except ValueError:
            pass
    for prefix, days in _SOURCE_VALIDITY_DEFAULTS.items():
        if value.startswith(prefix):
            return days
    return None


def _default_valid_until(source: str, base: datetime = None) -> str:
    days = _source_validity_days(source)
    return ((base or datetime.now()) + timedelta(days=days)).isoformat() if days else ""


def _is_expired(valid_until: str, now: datetime = None) -> bool:
    parsed = _parse_iso_datetime(valid_until)
    return bool(parsed and parsed < (now or datetime.now()))


def _normalize_evidence(evidence=None) -> list[dict]:
    """근거를 비밀값 없이 작은 JSON 구조로 정규화."""
    if isinstance(evidence, str):
        try:
            evidence = json.loads(evidence)
        except (TypeError, ValueError):
            evidence = []
    if not isinstance(evidence, list):
        return []
    items, seen = [], set()
    for raw in evidence[:20]:
        if not isinstance(raw, dict):
            continue
        title, _ = privacy_guard.sanitize_for_storage(
            str(raw.get("title") or raw.get("source") or "")[:240], include_contact=True
        )
        url = str(raw.get("url") or "").strip()[:1000]
        if url and not url.lower().startswith(("http://", "https://")):
            url = ""
        elif url and privacy_guard.sensitive_labels(url, include_contact=True):
            # 서명 URL·API 키·이메일 등이 쿼리/프래그먼트에 실리는 경우가 많다.
            # 클릭 가능한 공개 경로는 유지하되 민감 파라미터는 영구 저장하지 않는다.
            parsed = urlsplit(url)
            url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
        kind = str(raw.get("type") or ("url" if url else "memory"))[:40]
        key = (title, url, kind)
        if key in seen or not any(key):
            continue
        seen.add(key)
        items.append({"title": title, "url": url, "type": kind})
        if len(items) >= 10:
            break
    return items


def _evidence_json(evidence=None) -> str:
    return json.dumps(_normalize_evidence(evidence), ensure_ascii=False, separators=(",", ":"))


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

def _safe_session_id(session_id: str) -> str:
    """클라이언트 세션 식별자를 DB 키로 안전하게 정규화."""
    value = (session_id or "legacy").strip()[:160]
    value = re.sub(r"[^0-9A-Za-z:_-]", "_", value)
    return value or "legacy"


def save_message(role: str, content: str, persona: str = "hr", session_id: str = "legacy"):
    safe_content, labels = privacy_guard.sanitize_for_storage(content)
    if labels:
        print(f"🔒 대화 저장 전 민감정보 마스킹: {', '.join(labels)}")
    with _conn() as c:
        c.execute(
            "INSERT INTO conversations (role, content, persona, created_at, session_id) VALUES (?,?,?,?,?)",
            (role, safe_content, persona, datetime.now().isoformat(), _safe_session_id(session_id)),
        )


def get_history(limit: int = 20, persona: str = None, session_id: str = None) -> list:
    limit = max(1, min(int(limit), 200))
    with _conn() as c:
        if persona and session_id:
            rows = c.execute(
                "SELECT role, content, persona, created_at, session_id FROM conversations"
                " WHERE persona=? AND session_id=? ORDER BY id DESC LIMIT ?",
                (persona, _safe_session_id(session_id), limit),
            ).fetchall()
        elif persona:
            rows = c.execute(
                "SELECT role, content, persona, created_at, session_id FROM conversations"
                " WHERE persona=? ORDER BY id DESC LIMIT ?",
                (persona, limit),
            ).fetchall()
        elif session_id:
            rows = c.execute(
                "SELECT role, content, persona, created_at, session_id FROM conversations"
                " WHERE session_id=? ORDER BY id DESC LIMIT ?",
                (_safe_session_id(session_id), limit),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT role, content, persona, created_at, session_id FROM conversations"
                " ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
    return [dict(r) for r in reversed(rows)]


def get_recent_messages(limit: int = 10, persona: str = None, session_id: str = None) -> list:
    rows = get_history(limit, persona=persona, session_id=session_id)
    return [{"role": r["role"], "content": r["content"]} for r in rows]


def clear_history(persona: str = None, session_id: str = None):
    with _conn() as c:
        if persona and session_id:
            c.execute(
                "DELETE FROM conversations WHERE persona=? AND session_id=?",
                (persona, _safe_session_id(session_id)),
            )
        elif persona:
            c.execute("DELETE FROM conversations WHERE persona=?", (persona,))
        elif session_id:
            c.execute("DELETE FROM conversations WHERE session_id=?", (_safe_session_id(session_id),))
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
    now = datetime.now()
    verified_at = str(meta.get("verified_at") or now.isoformat())
    valid_until = meta.get("valid_until")
    if valid_until is None:
        valid_until = _default_valid_until(source, now)
    evidence_json = _evidence_json(meta.get("evidence", []))

    with _conn() as c:
        existing = c.execute(
            "SELECT id FROM learned_knowledge WHERE content=? AND persona=? LIMIT 1",
            (content, persona),
        ).fetchone()
        if not existing:
            c.execute(
                "INSERT INTO learned_knowledge"
                " (content, persona, source, created_at, evidence_json, verified_at, valid_until)"
                " VALUES (?,?,?,?,?,?,?)",
                (content, persona, source, now.isoformat(), evidence_json, verified_at, valid_until),
            )

    if existing:
        return

    try:
        from engine import teach
        teach(text, persona=persona, source=source or "learned", metadata={
            "evidence_json": evidence_json,
            "verified_at": verified_at,
            "valid_until": valid_until,
        })
    except Exception as e:
        print(f"⚠️ 엔진 학습 실패: {e}")


def _retrieval_terms(text: str) -> set:
    """검색 결과 간 중복 판정용 가벼운 토큰 집합."""
    return {
        token.lower() for token in re.findall(r"[가-힣A-Za-z0-9]{2,}", text or "")
    }


def _diversify_search_results(results: list, limit: int) -> list:
    """상위 점수는 유지하면서 거의 같은 근거 청크의 반복 노출을 줄인다."""
    selected, selected_terms = [], []
    for result in results:
        _q, answer, _score, _meta = result
        terms = _retrieval_terms(answer)
        too_similar = False
        for existing in selected_terms:
            union = terms | existing
            similarity = len(terms & existing) / len(union) if union else 1.0
            if similarity >= 0.82:
                too_similar = True
                break
        if too_similar:
            continue
        selected.append(result)
        selected_terms.append(terms)
        if len(selected) >= limit:
            break
    return selected


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
             "top_results": [], "top_source": "", "top_meta": {}, "expired_skipped": 0}
    try:
        from engine import get_engine
        engine = get_engine()
        # 의미 청크가 겹침 문맥을 포함하므로 상위 n개만 즉시 자르면 유사한 인접
        # 청크가 결과를 독점할 수 있다. 후보를 넓게 받은 뒤 중복을 제거한다.
        candidates = engine.search(query, n=max(n * 4, 12), persona=persona_id)
        expired_skipped = sum(
            1 for _q, _a, _score, meta in candidates if _is_expired(meta.get("valid_until", ""))
        )
        candidates = [
            result for result in candidates if not _is_expired(result[3].get("valid_until", ""))
        ]
        results = _diversify_search_results(candidates, max(1, n))
        if not results:
            return {**empty, "expired_skipped": expired_skipped}

        parts = []
        best_score = 0.0
        top_answer = ""
        top_question = ""
        top_source = ""
        top_meta = {}
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
                top_meta = dict(meta)

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
            "top_meta": top_meta,
            "expired_skipped": expired_skipped,
        }
    except Exception as e:
        print(f"⚠️ 컨텍스트 검색 실패: {e}")
        return empty


_DOC_HEADING_RE = re.compile(
    r"^(?:#{1,6}\s+|제\s*\d+\s*(?:장|절|조)|\d+(?:\.\d+)*[.)]\s+|"
    r"[가-힣A-Za-z][.)]\s+|\[[^\]]{1,60}\]$)"
)


def _is_document_heading(line: str) -> bool:
    value = line.strip()
    if not value or len(value) > 100:
        return False
    return bool(_DOC_HEADING_RE.match(value)) or value.endswith((" 장", " 절"))


def _split_long_document_unit(text: str, max_chars: int) -> list:
    """긴 문단을 문장/행 경계에서 나누고, 불가능할 때만 공백 근처에서 절단."""
    value = text.strip()
    if len(value) <= max_chars:
        return [value] if value else []
    sentences = [s.strip() for s in re.split(r"(?<=[.!?。！？])\s+|\n+", value) if s.strip()]
    if len(sentences) == 1:
        pieces = []
        rest = value
        while len(rest) > max_chars:
            cut = rest.rfind(" ", 0, max_chars + 1)
            if cut < max_chars // 2:
                cut = max_chars
            pieces.append(rest[:cut].strip())
            rest = rest[cut:].strip()
        if rest:
            pieces.append(rest)
        return pieces

    pieces, current = [], ""
    for sentence in sentences:
        if len(sentence) > max_chars:
            if current:
                pieces.append(current)
                current = ""
            pieces.extend(_split_long_document_unit(sentence, max_chars))
        elif not current:
            current = sentence
        elif len(current) + 1 + len(sentence) <= max_chars:
            current += " " + sentence
        else:
            pieces.append(current)
            current = sentence
    if current:
        pieces.append(current)
    return pieces


def chunk_document(text: str, filename: str = "", target_chars: int = 850,
                   max_chars: int = 1200, overlap_chars: int = 140) -> list:
    """제목·문단·문장 경계를 보존한 검색용 의미 청크를 만든다.

    각 청크에 문서명과 현재 섹션을 붙여 검색 결과만 보더라도 출처 맥락을 잃지
    않게 한다. 고정 글자 슬라이싱과 달리 문장 중간 절단은 최후 수단으로만 쓴다.
    """
    target_chars = max(200, min(int(target_chars), 4000))
    max_chars = max(target_chars, min(int(max_chars), 6000))
    overlap_chars = max(0, min(int(overlap_chars), max_chars // 3))
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in normalized.split("\n")]

    # 빈 줄, 명시적 제목, 충분히 끝난 문장 단위로 먼저 의미 문단을 구성한다.
    units, paragraph = [], []
    for line in lines:
        if not line:
            if paragraph:
                units.append(("body", "\n".join(paragraph)))
                paragraph = []
            continue
        if _is_document_heading(line):
            if paragraph:
                units.append(("body", "\n".join(paragraph)))
                paragraph = []
            units.append(("heading", line.lstrip("# ").strip()))
            continue
        paragraph.append(line)
        if len("\n".join(paragraph)) >= 350 and re.search(r"[.!?。！？]$", line):
            units.append(("body", "\n".join(paragraph)))
            paragraph = []
    if paragraph:
        units.append(("body", "\n".join(paragraph)))

    filename_label = re.sub(r"[\r\n]+", " ", filename or "업로드 문서")[:180]
    chunks, current_parts, current_heading = [], [], ""
    seen = set()

    def emit(parts: list, heading: str) -> str:
        body = "\n".join(p for p in parts if p).strip()
        if not body:
            return ""
        prefix = f"[문서: {filename_label}]"
        if heading:
            prefix += f"\n[섹션: {heading[:180]}]"
        chunk = f"{prefix}\n{body}"[:max_chars + 420]
        digest = hashlib.sha256(chunk.encode("utf-8")).hexdigest()
        if digest not in seen:
            chunks.append(chunk)
            seen.add(digest)
        return body[-overlap_chars:].lstrip() if overlap_chars else ""

    for kind, value in units:
        if kind == "heading":
            if current_parts:
                emit(current_parts, current_heading)
                current_parts = []
            current_heading = value
            continue
        for piece in _split_long_document_unit(value, max_chars - 260):
            current_len = sum(len(p) + 1 for p in current_parts)
            if current_parts and (current_len >= target_chars or current_len + len(piece) > max_chars):
                overlap = emit(current_parts, current_heading)
                current_parts = ([f"[앞 문맥] {overlap}"] if overlap else [])
            current_parts.append(piece)
    if current_parts:
        emit(current_parts, current_heading)
    return chunks


def store_document(text: str, filename: str, persona_id: str = "hr") -> int:
    """문서를 의미 청크로 학습하고, 동일 파일의 이전 버전은 격리한다."""
    src = f"문서:{filename}"
    chunks = []
    redacted_labels = set()
    for chunk in chunk_document(text, filename=filename):
        safe_chunk, labels = privacy_guard.sanitize_for_storage(chunk)
        chunks.append(safe_chunk)
        redacted_labels.update(labels)
    if redacted_labels:
        print(f"🔒 문서 저장 전 민감정보 마스킹({filename}): {', '.join(sorted(redacted_labels))}")
    # 파싱 실패/빈 파일이 기존 정상 문서를 지우는 결과가 되지 않도록, 새 청크를
    # 하나도 만들 수 없으면 기존 버전을 그대로 둔 채 호출자에게 0을 반환한다.
    if not chunks:
        return 0
    with _conn() as c:
        previous_rows = [dict(r) for r in c.execute(
            "SELECT id, content, persona, source, created_at FROM learned_knowledge"
            " WHERE source=? AND persona=?",
            (src, persona_id),
        ).fetchall()]
    if previous_rows:
        quarantine_learned_rows(previous_rows, reason=f"문서 재업로드:{filename}")

    for i, chunk in enumerate(chunks):
        store_memory(chunk, {
            "source": src,
            "persona": persona_id,
            "chunk": i,
        })
    # 기존 버전의 소프트 삭제 흔적과 새 청크의 IDF를 DB 전체 기준으로 맞춘다.
    try:
        from engine import reload_engine
        reload_engine()
    except Exception as e:
        print(f"⚠️ 문서 학습 후 엔진 재구축 실패(재시작 시 반영됨): {e}")
    with _conn() as c:
        c.execute(
            "INSERT INTO documents (name, source, persona, created_at) VALUES (?,?,?,?)",
            (filename, "upload", persona_id, datetime.now().isoformat()),
        )
    return len(chunks)


def upsert_knowledge(question: str, answer: str, persona: str,
                     source: str = "직접입력", evidence=None,
                     verified_at: str = "", valid_until: str = None) -> bool:
    """Q&A를 KB에 저장 — 동일 질문이 있으면 최신 내용으로 업데이트, 없으면 신규 추가.
    Returns True if updated (existing replaced), False if inserted (new entry).
    """
    safe_question, q_labels = privacy_guard.sanitize_for_storage(question)
    safe_answer, a_labels = privacy_guard.sanitize_for_storage(answer)
    if q_labels or a_labels:
        print(f"🔒 지식 저장 전 민감정보 마스킹: {', '.join(dict.fromkeys(q_labels + a_labels))}")
    question, answer = safe_question, safe_answer
    content = f"Q: {question}\nA: {answer[:1500]}"
    now_dt = datetime.now()
    now = now_dt.isoformat()
    verified_at = verified_at or now
    if valid_until is None:
        valid_until = _default_valid_until(source, now_dt)
    evidence_json = _evidence_json(evidence)
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
                "UPDATE learned_knowledge SET content=?, source=?, created_at=?,"
                " evidence_json=?, verified_at=?, valid_until=? WHERE id=?",
                (content, source, now, evidence_json, verified_at, valid_until, existing_id),
            )
            updated = True
        else:
            c.execute(
                "INSERT INTO learned_knowledge"
                " (content, persona, source, created_at, evidence_json, verified_at, valid_until)"
                " VALUES (?,?,?,?,?,?,?)",
                (content, persona, source, now, evidence_json, verified_at, valid_until),
            )
            updated = False

    try:
        from engine import get_engine, _kb_loaded
        if _kb_loaded:
            get_engine().delete_by_q(question, persona)
            get_engine().add(question, answer[:2000], {
                "persona": persona, "source": source, "evidence_json": evidence_json,
                "verified_at": verified_at, "valid_until": valid_until,
            })
    except Exception as e:
        print(f"⚠️ 엔진 학습 실패: {e}")

    return updated


def store_memory_candidate(question: str, answer: str, persona: str = "hr",
                           session_id: str = "legacy", source: str = "자동응답",
                           evidence=None, valid_until: str = None) -> int | None:
    """검증 전 답변을 장기기억이 아닌 승인 대기 후보로 저장한다.

    같은 질문·답변 조합은 페르소나별로 한 번만 보관한다. 승인된 후보를 다시
    pending으로 되돌리거나, 거절한 동일 답변을 반복 제안하지 않는다.
    """
    sensitive = privacy_guard.sensitive_labels(
        f"{question}\n{answer}", include_contact=True
    )
    if sensitive:
        print(f"🔒 기억 후보 생성 스킵(민감정보 포함): {', '.join(sensitive)}")
        return None
    q = question.strip()[:1000]
    a = answer.strip()[:4000]
    digest = hashlib.sha256(f"{persona}\n{q.lower()}\n{a}".encode("utf-8")).hexdigest()
    now_dt = datetime.now()
    now = now_dt.isoformat()
    evidence_json = _evidence_json(evidence)
    if valid_until is None:
        valid_until = _default_valid_until(source, now_dt)
    with _conn() as c:
        c.execute(
            "INSERT INTO memory_candidates"
            " (content_hash, question, answer, persona, session_id, source, status,"
            " created_at, seen_count, last_seen_at, evidence_json, verified_at, valid_until)"
            " VALUES (?,?,?,?,?,?,'pending',?,1,?,?,?,?)"
            " ON CONFLICT(content_hash,persona) DO UPDATE SET"
            " seen_count=CASE WHEN status='pending' THEN seen_count+1 ELSE seen_count END,"
            " last_seen_at=CASE WHEN status='pending' THEN excluded.last_seen_at ELSE last_seen_at END,"
            " evidence_json=CASE WHEN status='pending' AND excluded.evidence_json!='[]'"
            " THEN excluded.evidence_json ELSE evidence_json END,"
            " verified_at=CASE WHEN status='pending' THEN excluded.verified_at ELSE verified_at END,"
            " valid_until=CASE WHEN status='pending' THEN excluded.valid_until ELSE valid_until END",
            (digest, q, a, persona, _safe_session_id(session_id), source, now, now,
             evidence_json, now, valid_until),
        )
        row = c.execute(
            "SELECT id, status FROM memory_candidates WHERE content_hash=? AND persona=?",
            (digest, persona),
        ).fetchone()
    return int(row["id"]) if row and row["status"] == "pending" else None


def auto_learn(question: str, answer: str, persona: str = "hr",
               session_id: str = "legacy", source: str = "생성답변",
               evidence=None, valid_until: str = None) -> int | None:
    """자동 학습 후보 생성: 최소 품질 게이트 통과 시 검토 대기열에만 저장."""
    if len(question.strip()) < 8 or len(answer.strip()) < 60:
        return None
    lower_a = answer.lower()
    if any(kw in lower_a for kw in ["traceback", "error:", "exception:", "오류 발생", "알 수 없는 오류"]):
        return None
    # 품질 게이트 4: 질문 핵심 단어가 답변에 전혀 없으면 주제 불일치(오답 가능성 높음) → 저장 안 함
    # (예: "출장 규정" 질문에 "직장 내 괴롭힘" 답변이 저장되어 이후 동일 질문마다
    #  오답이 직접 서빙되는 KB 오염을 원천 차단)
    if not topic_overlap(question, answer):
        print(f"ℹ️ 자동학습 스킵(질문-답변 주제 불일치): {question[:50]}")
        return None
    return store_memory_candidate(
        question, answer, persona, session_id=session_id, source=source,
        evidence=evidence, valid_until=valid_until,
    )


def score_memory_candidate(question: str, answer: str, source: str = "",
                           seen_count: int = 1) -> dict:
    """승인 판단을 돕는 설명 가능한 휴리스틱 품질 점수(자동 승인은 하지 않음)."""
    score, flags = 0.45, []
    answer_len = len((answer or "").strip())
    if 120 <= answer_len <= 2500:
        score += 0.15
    elif answer_len < 80:
        score -= 0.20
        flags.append("답변이 짧음")
    elif answer_len > 3500:
        score -= 0.08
        flags.append("답변이 매우 김")

    if topic_overlap(question, answer):
        score += 0.20
    else:
        score -= 0.30
        flags.append("질문-답변 주제 확인 필요")

    if re.search(r"(?:https?://|출처|근거|제\s*\d+\s*조|참고 자료)", answer or ""):
        score += 0.10
    else:
        flags.append("명시적 근거 없음")
    if re.search(r"(?:^|\n)\s*(?:[-*]|\d+[.)])\s+", answer or ""):
        score += 0.05

    uncertain = ("확인 필요", "자료에서 확인되지", "추정", "추측", "모르겠습니다")
    if any(term in (answer or "") for term in uncertain):
        score -= 0.15
        flags.append("불확실성 표현 포함")
    if source in ("웹검색보강", "법령실시간"):
        score -= 0.05
        flags.append("시점에 따라 바뀔 수 있음")

    seen_count = max(1, int(seen_count or 1))
    if seen_count > 1:
        score += min(0.15, (seen_count - 1) * 0.03)
        flags.append(f"동일 답변 반복 관찰 {seen_count}회")

    return {"quality_score": round(max(0.0, min(score, 1.0)), 2), "quality_flags": flags}


_CONTRADICTION_PAIRS = (
    (("가능", "허용", "할 수 있"), ("불가", "금지", "할 수 없")),
    (("유급", "지급"), ("무급", "미지급")),
    (("의무", "필수"), ("선택", "임의")),
    (("적용", "대상"), ("미적용", "제외", "대상 아님")),
)


def _qa_parts(content: str) -> tuple[str, str]:
    value = content or ""
    if value.startswith("Q: ") and "\nA: " in value:
        question, answer = value.split("\nA: ", 1)
        return question[3:].strip(), answer.strip()
    return value[:500], value


def _jaccard_text(left: str, right: str) -> float:
    a, b = _retrieval_terms(left), _retrieval_terms(right)
    union = a | b
    return len(a & b) / len(union) if union else 1.0


def _contradiction_reasons(old_answer: str, new_answer: str,
                           exact_question: bool) -> list[str]:
    reasons = []
    old_numbers = set(re.findall(r"(?<!\w)\d+(?:[.,]\d+)?\s*(?:%|원|일|개월|년|시간|개)?", old_answer))
    new_numbers = set(re.findall(r"(?<!\w)\d+(?:[.,]\d+)?\s*(?:%|원|일|개월|년|시간|개)?", new_answer))
    if old_numbers and new_numbers and old_numbers != new_numbers:
        reasons.append(
            "수치가 다름: 기존 " + ", ".join(sorted(old_numbers)[:5])
            + " / 후보 " + ", ".join(sorted(new_numbers)[:5])
        )
    for positive, negative in _CONTRADICTION_PAIRS:
        old_pos = any(term in old_answer for term in positive)
        old_neg = any(term in old_answer for term in negative)
        new_pos = any(term in new_answer for term in positive)
        new_neg = any(term in new_answer for term in negative)
        if (old_pos and new_neg) or (old_neg and new_pos):
            reasons.append(f"반대 의미 가능성: {'/'.join(positive[:2])} ↔ {'/'.join(negative[:2])}")
    if exact_question and _jaccard_text(old_answer, new_answer) < 0.35:
        reasons.append("같은 질문의 기존 답변과 내용 차이가 큼")
    return list(dict.fromkeys(reasons))


def find_memory_contradictions(question: str, answer: str, persona: str,
                               limit: int = 5) -> list[dict]:
    """현재 유효한 장기기억 중 후보와 명시적으로 충돌할 가능성이 높은 항목."""
    with _conn() as c:
        rows = c.execute(
            "SELECT id, content, source, evidence_json, verified_at, valid_until"
            " FROM learned_knowledge WHERE persona=? ORDER BY id DESC",
            (persona,),
        ).fetchall()
    q_lower = (question or "").strip().lower()
    conflicts = []
    for row in rows:
        item = dict(row)
        if _is_expired(item.get("valid_until", "")):
            continue
        old_question, old_answer = _qa_parts(item.get("content", ""))
        exact = old_question.strip().lower() == q_lower
        q_similarity = _jaccard_text(question, old_question)
        if not exact and q_similarity < 0.65:
            continue
        reasons = _contradiction_reasons(old_answer, answer, exact)
        if not reasons:
            continue
        conflicts.append({
            "id": item["id"],
            "source": item.get("source", ""),
            "question": old_question[:300],
            "answer_preview": old_answer[:500],
            "reasons": reasons,
            "question_similarity": round(q_similarity, 3),
            "verified_at": item.get("verified_at", ""),
            "valid_until": item.get("valid_until", ""),
            "evidence": _normalize_evidence(item.get("evidence_json", "[]")),
        })
        if len(conflicts) >= max(1, min(int(limit), 20)):
            break
    return conflicts


def list_memory_candidates(status: str = "pending", persona: str = "",
                           limit: int = 50, offset: int = 0) -> list:
    where, params = [], []
    if status:
        where.append("status=?")
        params.append(status)
    if persona:
        where.append("persona=?")
        params.append(persona)
    sql = ("SELECT id, question, answer, persona, session_id, source, status,"
           " created_at, reviewed_at, seen_count, last_seen_at, evidence_json,"
           " verified_at, valid_until FROM memory_candidates")
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
    params.extend([max(1, min(int(limit), 200)), max(0, int(offset))])
    with _conn() as c:
        items = [dict(r) for r in c.execute(sql, params).fetchall()]
    for item in items:
        item["evidence"] = _normalize_evidence(item.pop("evidence_json", "[]"))
        item["validity_status"] = "expired" if _is_expired(item.get("valid_until", "")) else "current"
        item["contradictions"] = find_memory_contradictions(
            item["question"], item["answer"], item["persona"]
        ) if item.get("status") == "pending" else []
        item.update(score_memory_candidate(
            item["question"], item["answer"], item.get("source", ""),
            item.get("seen_count", 1),
        ))
    items.sort(key=lambda item: (item["quality_score"], item["id"]), reverse=True)
    return items


def review_memory_candidate(candidate_id: int, approve: bool, force: bool = False) -> dict | None:
    """후보를 승인해 장기기억으로 승격하거나 거절한다. 반복 호출에도 안전."""
    with _conn() as c:
        row = c.execute(
            "SELECT * FROM memory_candidates WHERE id=?", (candidate_id,)
        ).fetchone()
    if not row:
        return None
    item = dict(row)
    if item["status"] != "pending":
        return item
    if approve:
        # 승인 후보가 이미 검증된 지식과 같은 질문이면 자동으로 덮어쓰지 않는다.
        # 관리자가 기존 항목을 직접 격리하거나 /learn/text로 명시적으로 수정한 뒤
        # 다시 판단할 수 있도록 후보는 pending 상태로 남긴다.
        protected_prefixes = ("정적KB", "직접입력", "문서:")
        with _conn() as c:
            existing_rows = c.execute(
                "SELECT content, source FROM learned_knowledge WHERE persona=?",
                (item["persona"],),
            ).fetchall()
        q_lower = item["question"].strip().lower()
        for existing in existing_rows:
            existing = dict(existing)
            content = existing["content"] or ""
            source = existing["source"] or ""
            if not (content.startswith("Q: ") and "\nA: " in content):
                continue
            existing_q = content.split("\nA: ", 1)[0][3:].strip().lower()
            if existing_q == q_lower and source.startswith(protected_prefixes):
                item["status"] = "protected"
                item["protected_source"] = source
                return item
        contradictions = find_memory_contradictions(
            item["question"], item["answer"], item["persona"]
        )
        if contradictions and not force:
            item["status"] = "conflict"
            item["contradictions"] = contradictions
            return item
        upsert_knowledge(
            item["question"], item["answer"], item["persona"], source="승인학습",
            evidence=_normalize_evidence(item.get("evidence_json", "[]")) + [{
                "title": f"후보 생성 출처: {item.get('source', '')}",
                "type": "generation_source",
            }],
            verified_at=item.get("verified_at", "") or datetime.now().isoformat(),
            valid_until=item.get("valid_until", "") or _default_valid_until(item.get("source", "")),
        )
    new_status = "approved" if approve else "rejected"
    with _conn() as c:
        c.execute(
            "UPDATE memory_candidates SET status=?, reviewed_at=? WHERE id=?",
            (new_status, datetime.now().isoformat(), candidate_id),
        )
    item["status"] = new_status
    return item


def list_memory_revalidation(days: int = 30, persona: str = "",
                             limit: int = 100, offset: int = 0) -> list[dict]:
    """이미 만료됐거나 지정 일수 안에 만료되는 장기기억을 반환한다."""
    days = max(0, min(int(days), 3650))
    cutoff = (datetime.now() + timedelta(days=days)).isoformat()
    where = ["valid_until != ''", "valid_until <= ?"]
    params = [cutoff]
    if persona:
        where.append("persona=?")
        params.append(persona)
    params.extend([max(1, min(int(limit), 500)), max(0, int(offset))])
    with _conn() as c:
        rows = c.execute(
            "SELECT id, content, persona, source, created_at, evidence_json,"
            " verified_at, valid_until FROM learned_knowledge WHERE "
            + " AND ".join(where)
            + " ORDER BY valid_until ASC, id DESC LIMIT ? OFFSET ?",
            params,
        ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item["evidence"] = _normalize_evidence(item.pop("evidence_json", "[]"))
        item["validity_status"] = "expired" if _is_expired(item["valid_until"]) else "expiring"
        item["content_preview"] = item.pop("content", "")[:1000]
        items.append(item)
    return items


def verify_learned_memory(item_id: int, valid_days: int | None = None,
                          evidence=None) -> dict | None:
    """관리자 재검증 시 근거와 검증 시각·새 유효기간을 함께 갱신한다."""
    with _conn() as c:
        row = c.execute(
            "SELECT id, content, persona, source, evidence_json FROM learned_knowledge WHERE id=?",
            (int(item_id),),
        ).fetchone()
    if not row:
        return None
    item = dict(row)
    if valid_days is None or int(valid_days) <= 0:
        valid_days = _source_validity_days(item.get("source", "")) or 180
    valid_days = max(1, min(int(valid_days), 3650))
    now = datetime.now()
    normalized = (_normalize_evidence(evidence) if evidence is not None
                  else _normalize_evidence(item.get("evidence_json", "[]")))
    verified_at = now.isoformat()
    valid_until = (now + timedelta(days=valid_days)).isoformat()
    with _conn() as c:
        c.execute(
            "UPDATE learned_knowledge SET evidence_json=?, verified_at=?, valid_until=? WHERE id=?",
            (_evidence_json(normalized), verified_at, valid_until, int(item_id)),
        )
    return {
        "id": int(item_id), "source": item.get("source", ""), "evidence": normalized,
        "verified_at": verified_at, "valid_until": valid_until, "validity_status": "current",
    }


def quarantine_learned_rows(rows: list, reason: str) -> int:
    """장기기억 행을 복구 가능한 격리소로 옮긴 뒤 원본에서 삭제."""
    if not rows:
        return 0
    now = datetime.now().isoformat()
    ids = sorted({int(r["id"]) for r in rows})
    placeholders = ",".join("?" * len(ids))
    with _conn() as c:
        fresh_rows = [dict(r) for r in c.execute(
            "SELECT id, content, persona, source, created_at, evidence_json,"
            f" verified_at, valid_until FROM learned_knowledge WHERE id IN ({placeholders})",
            ids,
        ).fetchall()]
        for r in fresh_rows:
            # Turso HTTP 백엔드는 문장별 자동 커밋이므로 중간 네트워크 실패 뒤
            # 재시도해도 같은 활성 격리본이 중복 생성되지 않게 조건부 삽입한다.
            c.execute(
                "INSERT INTO memory_quarantine"
                " (original_id, content, persona, source, original_created_at, reason, quarantined_at,"
                " evidence_json, original_verified_at, original_valid_until)"
                " SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS ("
                " SELECT 1 FROM memory_quarantine"
                " WHERE original_id=? AND content=? AND restored_at='')",
                (
                    r["id"], r["content"], r.get("persona", ""), r.get("source", ""),
                    r.get("created_at", ""), reason, now, r.get("evidence_json", "[]"),
                    r.get("verified_at", ""), r.get("valid_until", ""), r["id"], r["content"],
                ),
            )
        c.execute(f"DELETE FROM learned_knowledge WHERE id IN ({placeholders})", ids)
    return len(ids)


def list_quarantined_memories(limit: int = 100, offset: int = 0) -> list:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM memory_quarantine WHERE restored_at=''"
            " ORDER BY id DESC LIMIT ? OFFSET ?",
            (max(1, min(int(limit), 200)), max(0, int(offset))),
        ).fetchall()
    return [dict(r) for r in rows]


def restore_quarantined_memory(quarantine_id: int) -> dict | None:
    with _conn() as c:
        row = c.execute(
            "SELECT * FROM memory_quarantine WHERE id=? AND restored_at=''",
            (quarantine_id,),
        ).fetchone()
    if not row:
        return None
    item = dict(row)
    with _conn() as c:
        c.execute(
            "INSERT INTO learned_knowledge"
            " (content, persona, source, created_at, evidence_json, verified_at, valid_until)"
            " SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS ("
            " SELECT 1 FROM learned_knowledge WHERE content=? AND persona=? AND source=?)",
            (
                item["content"], item["persona"], item["source"],
                item["original_created_at"] or datetime.now().isoformat(),
                item.get("evidence_json", "[]"), item.get("original_verified_at", ""),
                item.get("original_valid_until", ""),
                item["content"], item["persona"], item["source"],
            ),
        )
        c.execute(
            "UPDATE memory_quarantine SET restored_at=? WHERE id=?",
            (datetime.now().isoformat(), quarantine_id),
        )
    return item


def list_documents() -> list:
    with _conn() as c:
        rows = c.execute(
            "SELECT name, source, persona, created_at FROM documents ORDER BY id DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def save_feedback(question: str, answer: str, rating: int, persona: str = "hr"):
    safe_question, _ = privacy_guard.sanitize_for_storage(question, include_contact=True)
    safe_answer, _ = privacy_guard.sanitize_for_storage(answer, include_contact=True)
    with _conn() as c:
        c.execute(
            "INSERT INTO feedback (question, answer, rating, persona, created_at) VALUES (?,?,?,?,?)",
            (safe_question[:500], safe_answer[:1000], rating, persona, datetime.now().isoformat())
        )


def apply_feedback_boost(persona: str, question: str, rating: int) -> float:
    """피드백을 질문 단위 가중치로 누적 반영."""
    safe_question, _ = privacy_guard.sanitize_for_storage(question, include_contact=True)
    q_lower = safe_question.strip().lower()
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


def record_retrieval_event(query: str, persona: str, session_kind: str,
                           top_source: str, best_score: float,
                           result_count: int, used_context: bool,
                           route: str) -> None:
    """원문 질문 없이 RAG 회수 품질만 기록한다.

    운영 관측 데이터가 또 다른 개인정보 저장소가 되지 않도록 질문은 단방향
    키 기반 HMAC만 남기고 세션 ID도 owner/share 종류로만 축약한다. 관측 실패는 채팅을
    중단시키지 않는다.
    """
    try:
        # 단순 SHA-256은 흔한 질문을 사전 대입으로 추측할 수 있다. 운영 비밀값을
        # 키로 쓴 HMAC으로 같은 질문의 반복 여부만 비교 가능하게 한다.
        telemetry_key = (
            os.getenv("MEMORY_TELEMETRY_SALT", "").strip()
            or os.getenv("BACKUP_TOKEN", "").strip()
            or "local-development-only"
        ).encode("utf-8")
        query_hash = hmac.new(
            telemetry_key,
            (query or "").strip().lower().encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        kind = "share" if session_kind == "share" else "owner"
        with _conn() as c:
            c.execute(
                "INSERT INTO memory_retrieval_events"
                " (query_hash, persona, session_kind, top_source, best_score,"
                " result_count, used_context, route, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    query_hash, (persona or "")[:40], kind, (top_source or "")[:120],
                    float(best_score or 0), max(0, int(result_count or 0)),
                    1 if used_context else 0, (route or "")[:40], datetime.now().isoformat(),
                ),
            )
    except Exception as e:
        print(f"⚠️ 기억 검색 관측 기록 실패(채팅은 계속): {e}")


def memory_observability(days: int = 7) -> dict:
    """최근 RAG 검색의 저신뢰율·컨텍스트 사용률·출처 분포를 집계."""
    days = max(1, min(int(days), 365))
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    with _conn() as c:
        summary = c.execute(
            "SELECT COUNT(*) AS total,"
            " SUM(CASE WHEN best_score < 0.15 THEN 1 ELSE 0 END) AS low_confidence,"
            " SUM(CASE WHEN used_context=1 THEN 1 ELSE 0 END) AS context_used"
            " FROM memory_retrieval_events WHERE created_at>=?",
            (cutoff,),
        ).fetchone()
        persona_rows = c.execute(
            "SELECT persona, COUNT(*) AS total, AVG(best_score) AS avg_score"
            " FROM memory_retrieval_events WHERE created_at>=?"
            " GROUP BY persona ORDER BY total DESC",
            (cutoff,),
        ).fetchall()
        source_rows = c.execute(
            "SELECT CASE WHEN top_source='' THEN '(없음)' ELSE top_source END AS source,"
            " COUNT(*) AS total, AVG(best_score) AS avg_score"
            " FROM memory_retrieval_events WHERE created_at>=?"
            " GROUP BY top_source ORDER BY total DESC LIMIT 20",
            (cutoff,),
        ).fetchall()
        route_rows = c.execute(
            "SELECT route, COUNT(*) AS total FROM memory_retrieval_events"
            " WHERE created_at>=? GROUP BY route ORDER BY total DESC",
            (cutoff,),
        ).fetchall()
    total = int(summary["total"] or 0) if summary else 0
    low = int(summary["low_confidence"] or 0) if summary else 0
    used = int(summary["context_used"] or 0) if summary else 0
    return {
        "days": days,
        "total_retrievals": total,
        "low_confidence": low,
        "low_confidence_rate": round(low / total, 4) if total else 0,
        "context_used": used,
        "context_usage_rate": round(used / total, 4) if total else 0,
        "by_persona": [dict(row) for row in persona_rows],
        "by_source": [dict(row) for row in source_rows],
        "by_route": [dict(row) for row in route_rows],
        "privacy": "질문 원문·세션 ID 미저장(질문 HMAC-SHA256 및 owner/share 구분만 저장)",
    }


def memory_retention_policy(apply: bool = False, confirm: str = "") -> dict:
    """환경변수 기반 보존정책을 미리 보거나 명시 확인 후 적용한다.

    승인된 장기지식과 활성 격리소는 자동 삭제 대상이 아니다. apply 기본값은
    False이며 실제 적용에는 고정 확인문구가 필요해 실수로 운영 데이터를 지우지
    않게 한다.
    """
    conversation_days = max(1, int(os.getenv("CONVERSATION_RETENTION_DAYS", "90")))
    pending_days = max(1, int(os.getenv("MEMORY_CANDIDATE_PENDING_DAYS", "45")))
    candidate_history_days = max(
        pending_days, int(os.getenv("MEMORY_CANDIDATE_HISTORY_DAYS", "365"))
    )
    retrieval_days = max(1, int(os.getenv("MEMORY_RETRIEVAL_RETENTION_DAYS", "30")))
    now = datetime.now()
    conversation_cutoff = (now - timedelta(days=conversation_days)).isoformat()
    pending_cutoff = (now - timedelta(days=pending_days)).isoformat()
    candidate_cutoff = (now - timedelta(days=candidate_history_days)).isoformat()
    retrieval_cutoff = (now - timedelta(days=retrieval_days)).isoformat()

    with _conn() as c:
        counts = {
            "conversations_to_delete": c.execute(
                "SELECT COUNT(*) FROM conversations WHERE created_at<?",
                (conversation_cutoff,),
            ).fetchone()[0],
            "pending_candidates_to_expire": c.execute(
                "SELECT COUNT(*) FROM memory_candidates"
                " WHERE status='pending' AND COALESCE(NULLIF(last_seen_at,''),created_at)<?",
                (pending_cutoff,),
            ).fetchone()[0],
            "reviewed_candidates_to_delete": c.execute(
                "SELECT COUNT(*) FROM memory_candidates"
                " WHERE status IN ('approved','rejected','expired')"
                " AND COALESCE(NULLIF(reviewed_at,''),created_at)<?",
                (candidate_cutoff,),
            ).fetchone()[0],
            "retrieval_events_to_delete": c.execute(
                "SELECT COUNT(*) FROM memory_retrieval_events WHERE created_at<?",
                (retrieval_cutoff,),
            ).fetchone()[0],
        }

    result = {
        "apply": bool(apply),
        "policy_days": {
            "conversations": conversation_days,
            "pending_candidates": pending_days,
            "candidate_history": candidate_history_days,
            "retrieval_events": retrieval_days,
        },
        "preview": {key: int(value or 0) for key, value in counts.items()},
        "approved_long_term_knowledge_deleted": 0,
        "active_quarantine_deleted": 0,
    }
    if not apply:
        return result
    if confirm != "PURGE_EXPIRED":
        raise ValueError("실제 적용에는 confirm=PURGE_EXPIRED가 필요합니다.")

    applied_at = now.isoformat()
    with _conn() as c:
        c.execute("DELETE FROM conversations WHERE created_at<?", (conversation_cutoff,))
        c.execute(
            "UPDATE memory_candidates SET status='expired', reviewed_at=?"
            " WHERE status='pending' AND COALESCE(NULLIF(last_seen_at,''),created_at)<?",
            (applied_at, pending_cutoff),
        )
        c.execute(
            "DELETE FROM memory_candidates WHERE status IN ('approved','rejected','expired')"
            " AND COALESCE(NULLIF(reviewed_at,''),created_at)<?",
            (candidate_cutoff,),
        )
        c.execute("DELETE FROM memory_retrieval_events WHERE created_at<?", (retrieval_cutoff,))
    result["applied_at"] = applied_at
    return result


def memory_stats(session_id: str = None) -> dict:
    with _conn() as c:
        if session_id:
            msg_count = c.execute(
                "SELECT COUNT(*) FROM conversations WHERE session_id=?",
                (_safe_session_id(session_id),),
            ).fetchone()[0]
        else:
            msg_count = c.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
        doc_count     = c.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        learned_count = c.execute("SELECT COUNT(*) FROM learned_knowledge").fetchone()[0]
        pending_count = c.execute(
            "SELECT COUNT(*) FROM memory_candidates WHERE status='pending'"
        ).fetchone()[0]
        quarantine_count = c.execute(
            "SELECT COUNT(*) FROM memory_quarantine WHERE restored_at=''"
        ).fetchone()[0]
        retrieval_count = c.execute(
            "SELECT COUNT(*) FROM memory_retrieval_events"
        ).fetchone()[0]

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
        "pending_candidates": pending_count,
        "quarantined_items": quarantine_count,
        "retrieval_events": retrieval_count,
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
