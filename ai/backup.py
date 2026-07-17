"""백업 모듈 — 직접 다운로드 + Google Drive"""
import os
import sqlite3
import json
import zipfile
import io
import pickle
from datetime import datetime
from pathlib import Path

_APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH  = os.getenv("DB_PATH", os.path.join(_APP_DIR, "data", "memory.db"))
# DB_PATH와 같은 디렉터리(영속 볼륨)에 저장 — /tmp는 재배포/재시작마다 초기화되어
# Google Drive 재인증이 매번 필요해지는 문제가 있었음
TOKEN_PATH = os.getenv("GDRIVE_TOKEN_PATH", os.path.join(os.path.dirname(DB_PATH), "gdrive_token.pkl"))

# Google Drive OAuth2 설정 (환경변수)
GDRIVE_CLIENT_ID     = os.getenv("GDRIVE_CLIENT_ID", "")
GDRIVE_CLIENT_SECRET = os.getenv("GDRIVE_CLIENT_SECRET", "")
GDRIVE_REDIRECT_URI  = os.getenv("GDRIVE_REDIRECT_URI", "")  # 배포 URL + /backup/google-callback


# ── 공통: ZIP 생성 ────────────────────────────────────

# data/ 테이블 → 추출 시 파일명 매핑 (카테고리별로 분리 저장)
_TABLES = {
    "conversations":      "by_category/conversations.json",   # 대화 이력
    "learned_knowledge":  "by_category/learned_knowledge.json",  # 정적KB + 자동학습 + 업로드 문서 청크
    "documents":          "by_category/documents.json",       # 업로드 문서 목록
    "feedback":           "by_category/feedback.json",        # 답변 평가(👍/👎)
}


def _export_tables_json(conn: sqlite3.Connection) -> dict:
    """테이블별 전체 행을 사람이 읽기 쉬운 JSON으로 직렬화해 반환 {파일경로: row목록}"""
    conn.row_factory = sqlite3.Row
    exported = {}
    for table, rel_path in _TABLES.items():
        try:
            rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        except sqlite3.OperationalError:
            continue  # 테이블이 없는 구버전 DB 대비
        exported[rel_path] = [dict(r) for r in rows]
    return exported


def _make_zip() -> tuple[bytes, str]:
    """DB를 ZIP으로 압축해 (bytes, filename) 반환.
    - memory.sql       : SQLite 전체 복원용 원본 덤프
    - by_category/*.json : 카테고리별 사람이 읽을 수 있는 JSON (추출/검토용)
    - manifest.json    : 백업 시각, 테이블별 건수 등 요약
    """
    filename = f"gpt-assistant-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        counts = {}
        if os.path.exists(DB_PATH):
            src = sqlite3.connect(DB_PATH)
            try:
                dump = "\n".join(src.iterdump())
                zf.writestr("memory.sql", dump)

                for rel_path, rows in _export_tables_json(src).items():
                    zf.writestr(rel_path, json.dumps(rows, ensure_ascii=False, indent=2))
                    counts[rel_path] = len(rows)
            finally:
                src.close()

        manifest = {
            "backed_up_at": datetime.now().isoformat(),
            "db_path": DB_PATH,
            "row_counts": counts,
            "contents": {
                "memory.sql": "SQLite 전체 덤프 (복원용: sqlite3 new.db < memory.sql)",
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
    """Google OAuth2 인증 URL 생성"""
    import urllib.parse
    params = {
        "client_id":     GDRIVE_CLIENT_ID,
        "redirect_uri":  GDRIVE_REDIRECT_URI,
        "response_type": "code",
        "scope":         "https://www.googleapis.com/auth/drive.file",
        "access_type":   "offline",
        "prompt":        "consent",
    }
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)


async def gdrive_exchange_code(code: str) -> bool:
    """인증 코드 → 토큰 교환 후 저장"""
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

    Path(TOKEN_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(TOKEN_PATH, "wb") as f:
        pickle.dump(token, f)
    return True


def _load_token() -> dict | None:
    if not os.path.exists(TOKEN_PATH):
        return None
    with open(TOKEN_PATH, "rb") as f:
        return pickle.load(f)


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
    with open(TOKEN_PATH, "wb") as f:
        pickle.dump(token, f)
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
    return os.path.exists(TOKEN_PATH)
