"""백업 모듈 — 직접 다운로드 + Google Drive"""
import os
import secrets
import sqlite3
import json
import zipfile
import io
import pickle
from datetime import datetime
from pathlib import Path

_APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH  = os.getenv("DB_PATH", os.path.join(_APP_DIR, "data", "memory.db"))
TOKEN_PATH        = os.getenv("GDRIVE_TOKEN_PATH", "/tmp/gdrive_token.json")
_LEGACY_TOKEN_PATH = os.getenv("GDRIVE_TOKEN_PATH_LEGACY", "/tmp/gdrive_token.pkl")

# Google Drive OAuth2 설정 (환경변수)
GDRIVE_CLIENT_ID     = os.getenv("GDRIVE_CLIENT_ID", "")
GDRIVE_CLIENT_SECRET = os.getenv("GDRIVE_CLIENT_SECRET", "")
GDRIVE_REDIRECT_URI  = os.getenv("GDRIVE_REDIRECT_URI", "")  # 배포 URL + /backup/google-callback

# OAuth CSRF 방지용 state — 인증 URL 발급 시 생성해 콜백에서 검증
_pending_oauth_state: str | None = None


# ── 공통: ZIP 생성 ────────────────────────────────────

# data/ 테이블 → 추출 시 파일명 매핑 (카테고리별로 분리 저장)
_TABLES = {
    "conversations":      "by_category/conversations.json",   # 대화 이력
    "learned_knowledge":  "by_category/learned_knowledge.json",  # 정적KB + 자동학습 + 업로드 문서 청크
    "documents":          "by_category/documents.json",       # 업로드 문서 목록
    "feedback":           "by_category/feedback.json",        # 답변 평가(👍/👎)
}


def _sql_quote(v) -> str:
    """SQL 덤프용 값 이스케이프"""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def _make_zip() -> tuple[bytes, str]:
    """DB를 ZIP으로 압축해 (bytes, filename) 반환.
    memory._conn()을 경유하므로 Turso(클라우드)·로컬 SQLite 어느 쪽이든 실데이터를 백업함.
    - memory.sql       : 전체 복원용 SQL 덤프 (sqlite3 new.db < memory.sql)
    - by_category/*.json : 카테고리별 사람이 읽을 수 있는 JSON (추출/검토용)
    - manifest.json    : 백업 시각, 테이블별 건수 등 요약
    """
    import memory as mem

    filename = f"gpt-assistant-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        counts = {}
        sql_lines = ["BEGIN TRANSACTION;"]
        try:
            # 테이블 목록 + DDL (Turso도 sqlite_master 지원)
            with mem._conn() as c:
                ddl_rows = [dict(r) for r in c.execute(
                    "SELECT name, sql FROM sqlite_master"
                    " WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()]

            tables = []
            for r in ddl_rows:
                if r.get("sql"):
                    sql_lines.append(r["sql"].rstrip(";") + ";")
                tables.append(r["name"])

            for table in tables:
                with mem._conn() as c:
                    rows = [dict(x) for x in c.execute(f"SELECT * FROM {table}").fetchall()]
                counts[table] = len(rows)
                for row in rows:
                    cols = ", ".join(row.keys())
                    vals = ", ".join(_sql_quote(v) for v in row.values())
                    sql_lines.append(f"INSERT INTO {table} ({cols}) VALUES ({vals});")
                rel_path = _TABLES.get(table)
                if rel_path:
                    zf.writestr(rel_path, json.dumps(rows, ensure_ascii=False, indent=2))

            sql_lines.append("COMMIT;")
            zf.writestr("memory.sql", "\n".join(sql_lines))
        except Exception as e:
            zf.writestr("error.txt", f"백업 중 오류: {type(e).__name__}: {e}")

        manifest = {
            "backed_up_at": datetime.now().isoformat(),
            "db_backend": "Turso (클라우드)" if mem._USE_TURSO else f"SQLite ({mem.DB_PATH})",
            "row_counts": counts,
            "contents": {
                "memory.sql": "SQL 전체 덤프 (복원용: sqlite3 new.db < memory.sql)",
                "by_category/*.json": "테이블별 JSON (열람/검색/추출용)",
            },
        }
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return buf.getvalue(), filename


# ── 1. 직접 다운로드 ──────────────────────────────────

def backup_download() -> tuple[bytes, str]:
    """ZIP bytes와 파일명 반환 — FastAPI StreamingResponse로 전달"""
    return _make_zip()


# ── 2. Google Drive ───────────────────────────────────

def gdrive_configured() -> bool:
    return bool(GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET and GDRIVE_REDIRECT_URI)


def gdrive_auth_url() -> str:
    """Google OAuth2 인증 URL 생성 (CSRF 방지용 state 포함)"""
    global _pending_oauth_state
    import urllib.parse
    _pending_oauth_state = secrets.token_urlsafe(24)
    params = {
        "client_id":     GDRIVE_CLIENT_ID,
        "redirect_uri":  GDRIVE_REDIRECT_URI,
        "response_type": "code",
        "scope":         "https://www.googleapis.com/auth/drive.file",
        "access_type":   "offline",
        "prompt":        "consent",
        "state":         _pending_oauth_state,
    }
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)


async def gdrive_exchange_code(code: str, state: str = "") -> bool:
    """인증 코드 → 토큰 교환 후 저장 (state가 발급 시 값과 다르면 CSRF로 간주해 거부)"""
    global _pending_oauth_state
    if not _pending_oauth_state or state != _pending_oauth_state:
        raise ValueError("state 값이 일치하지 않습니다 (CSRF 의심 — 인증을 다시 시작하세요).")
    _pending_oauth_state = None  # 1회용

    import httpx
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id":     GDRIVE_CLIENT_ID,
                "client_secret": GDRIVE_CLIENT_SECRET,
                "redirect_uri":  GDRIVE_REDIRECT_URI,
                "grant_type":    "authorization_code",
                "code":          code,
            },
        )
        resp.raise_for_status()
        token = resp.json()

    _save_token(token)
    return True


def _save_token(token: dict) -> None:
    Path(TOKEN_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(TOKEN_PATH, "w", encoding="utf-8") as f:
        json.dump(token, f)


def _load_token() -> dict | None:
    if os.path.exists(TOKEN_PATH):
        with open(TOKEN_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    # 이전 pickle 포맷 토큰이 남아있으면 1회 마이그레이션 (신뢰할 수 없는 소스의
    # pickle 파일을 역직렬화하는 것을 피하기 위해 자기 자신이 이전에 쓴 레거시
    # 경로에서만 읽는다)
    if os.path.exists(_LEGACY_TOKEN_PATH):
        with open(_LEGACY_TOKEN_PATH, "rb") as f:
            token = pickle.load(f)
        _save_token(token)
        os.remove(_LEGACY_TOKEN_PATH)
        return token
    return None


async def _refresh_access_token(token: dict) -> str:
    """refresh_token으로 access_token 갱신"""
    import httpx
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id":     GDRIVE_CLIENT_ID,
                "client_secret": GDRIVE_CLIENT_SECRET,
                "refresh_token": token["refresh_token"],
                "grant_type":    "refresh_token",
            },
        )
        resp.raise_for_status()
        new_token = resp.json()

    # 갱신된 access_token 저장
    token["access_token"] = new_token["access_token"]
    _save_token(token)
    return token["access_token"]


async def backup_to_gdrive() -> dict:
    """Google Drive에 ZIP 업로드"""
    import httpx

    token = _load_token()
    if not token:
        return {"ok": False, "error": "Google 계정 연동이 필요합니다. 먼저 Google 로그인을 진행하세요."}

    access_token = await _refresh_access_token(token)
    zip_bytes, filename = _make_zip()

    # Drive API — multipart upload
    metadata = json.dumps({
        "name":    filename,
        "parents": [],
    })

    boundary = "boundary_gpt_backup"
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{metadata}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: application/zip\r\n\r\n"
    ).encode() + zip_bytes + f"\r\n--{boundary}--".encode()

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type":  f"multipart/related; boundary={boundary}",
            },
            content=body,
        )
        resp.raise_for_status()
        file_id = resp.json().get("id", "")

    return {"ok": True, "filename": filename, "file_id": file_id, "at": datetime.now().isoformat()}


def gdrive_connected() -> bool:
    """Google Drive 연동 여부 확인"""
    return os.path.exists(TOKEN_PATH) or os.path.exists(_LEGACY_TOKEN_PATH)
