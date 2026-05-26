import os
import httpx
import sqlite3
import json
import zipfile
import io
from datetime import datetime

# OneDrive (Microsoft Graph API)
# 환경변수: ONEDRIVE_CLIENT_ID, ONEDRIVE_CLIENT_SECRET, ONEDRIVE_REFRESH_TOKEN, ONEDRIVE_TENANT_ID
CLIENT_ID     = os.getenv("ONEDRIVE_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("ONEDRIVE_CLIENT_SECRET", "")
REFRESH_TOKEN = os.getenv("ONEDRIVE_REFRESH_TOKEN", "")
TENANT_ID     = os.getenv("ONEDRIVE_TENANT_ID", "common")
DB_PATH       = os.getenv("DB_PATH", "data/memory.db")
CHROMA_PATH   = os.getenv("CHROMA_PATH", "data/chroma")


async def _get_access_token() -> str:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token",
            data={
                "client_id":     CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "refresh_token": REFRESH_TOKEN,
                "grant_type":    "refresh_token",
                "scope":         "Files.ReadWrite offline_access",
            },
        )
        resp.raise_for_status()
        return resp.json()["access_token"]


async def backup_to_onedrive() -> dict:
    if not CLIENT_ID or not REFRESH_TOKEN:
        return {"ok": False, "error": "OneDrive 인증 정보가 설정되지 않았습니다. .env 파일을 확인하세요."}

    # 백업할 데이터 수집
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # SQLite DB 백업
        if os.path.exists(DB_PATH):
            with sqlite3.connect(DB_PATH) as src:
                dump = "\n".join(src.iterdump())
            zf.writestr("memory.sql", dump)

        # 메타 정보
        meta = {
            "backed_up_at": datetime.now().isoformat(),
            "db_path": DB_PATH,
        }
        zf.writestr("meta.json", json.dumps(meta, ensure_ascii=False, indent=2))

    buf.seek(0)
    filename = f"gpt-assistant-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"

    token = await _get_access_token()
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.put(
            f"https://graph.microsoft.com/v1.0/me/drive/root:/GPT-Assistant/{filename}:/content",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type":  "application/zip",
            },
            content=buf.read(),
        )
        resp.raise_for_status()

    return {"ok": True, "filename": filename, "at": datetime.now().isoformat()}
