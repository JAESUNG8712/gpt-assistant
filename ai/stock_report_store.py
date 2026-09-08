"""주식 보고서 영구 저장소 — Turso/SQLite 공용 app_settings 기반."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

import memory as mem


INDEX_KEY = "stock_report:index:v1"
REPORT_KEY_PREFIX = "stock_report:content:v1:"
MAX_REPORTS = 20
MAX_REPORT_BYTES = 2 * 1024 * 1024
# 새 DB 보고서는 초 단위, 기존 로컬 보고서는 분 단위 파일명을 사용했다.
_VALID_FILENAME = re.compile(r"^report_\d{8}_\d{4}(?:\d{2})?\.txt$")
_storage_ready = False


def _ensure_storage() -> None:
    """FastAPI 밖에서 파이프라인을 직접 실행해도 저장 테이블을 준비한다."""
    global _storage_ready
    if _storage_ready:
        return
    with mem._conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""")
    _storage_ready = True


def _safe_filename(filename: str) -> str:
    if not isinstance(filename, str) or not _VALID_FILENAME.fullmatch(filename):
        raise ValueError("잘못된 주식 보고서 파일명입니다.")
    return filename


def _report_key(filename: str) -> str:
    return REPORT_KEY_PREFIX + _safe_filename(filename)


def save_report(
    content: str,
    *,
    created_at: Optional[str] = None,
    filename: Optional[str] = None,
) -> dict:
    """보고서 본문과 최신순 색인을 하나의 DB 백엔드에 저장한다."""
    _ensure_storage()
    if not isinstance(content, str) or not content.strip():
        raise ValueError("빈 주식 보고서는 저장할 수 없습니다.")
    size = len(content.encode("utf-8"))
    if size > MAX_REPORT_BYTES:
        raise ValueError(f"주식 보고서가 저장 한도({MAX_REPORT_BYTES} bytes)를 초과했습니다.")

    created_at = created_at or datetime.now().isoformat()
    if filename is None:
        try:
            created = datetime.fromisoformat(created_at)
        except ValueError as exc:
            raise ValueError("created_at은 ISO 날짜 형식이어야 합니다.") from exc
        filename = f"report_{created.strftime('%Y%m%d_%H%M%S')}.txt"
    filename = _safe_filename(filename)

    item = {"filename": filename, "created_at": created_at, "size": size}
    mem.save_setting(
        _report_key(filename),
        {"content": content, **item},
    )

    index = mem.get_setting(INDEX_KEY, {"items": []}) or {"items": []}
    existing = [
        row for row in index.get("items", [])
        if isinstance(row, dict) and row.get("filename") != filename
    ]
    items = sorted([item, *existing], key=lambda row: row.get("created_at", ""), reverse=True)
    removed = items[MAX_REPORTS:]
    mem.save_setting(INDEX_KEY, {"items": items[:MAX_REPORTS]})
    for row in removed:
        old_name = row.get("filename", "")
        if _VALID_FILENAME.fullmatch(old_name):
            mem.delete_setting(_report_key(old_name))
    return item


def list_reports() -> list[dict]:
    _ensure_storage()
    index = mem.get_setting(INDEX_KEY, {"items": []}) or {"items": []}
    items = []
    for row in index.get("items", []):
        if not isinstance(row, dict):
            continue
        filename = row.get("filename", "")
        if _VALID_FILENAME.fullmatch(filename):
            items.append({
                "filename": filename,
                "created_at": row.get("created_at", ""),
                "size": int(row.get("size", 0) or 0),
            })
    return sorted(items, key=lambda row: row["created_at"], reverse=True)[:MAX_REPORTS]


def get_report(filename: str) -> Optional[str]:
    _ensure_storage()
    payload = mem.get_setting(_report_key(filename))
    if not isinstance(payload, dict):
        return None
    content = payload.get("content")
    return content if isinstance(content, str) and content else None


def latest_report() -> Optional[dict]:
    items = list_reports()
    if not items:
        return None
    item = items[0]
    content = get_report(item["filename"])
    return {**item, "content": content} if content is not None else None
