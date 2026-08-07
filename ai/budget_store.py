import os
import json
import csv
import io
import re
import uuid
import datetime

import memory as mem

BUDGET_FILE = os.path.join(os.path.dirname(mem.DB_PATH), "budget-data.json")
MONTHS = list(range(1, 13))
CATEGORIES = ["판관", "용역", "경상"]


def _empty():
    return {"headcount": [], "items": [], "uploads": [], "grid": [], "snapshots": []}


def _now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def read_budget():
    if not os.path.exists(BUDGET_FILE):
        return _empty()
    with open(BUDGET_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    for key, default in _empty().items():
        if key not in data:
            data[key] = default
    return data


def write_budget(data):
    os.makedirs(os.path.dirname(BUDGET_FILE), exist_ok=True)
    with open(BUDGET_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def to_number(v):
    if v is None:
        return None
    s = str(v).strip().replace(",", "")
    if s == "":
        return None
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return None


def parse_rows(content: bytes, filename: str):
    """업로드 파일(xlsx/csv)을 헤더가 있는 dict 행 리스트로 변환"""
    if filename.lower().endswith((".xlsx", ".xls")):
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
        sheet = wb.worksheets[0]
        rows_iter = sheet.iter_rows(values_only=True)
        header = [str(h).strip() if h is not None else "" for h in next(rows_iter)]
        rows = []
        for r in rows_iter:
            rows.append({header[i]: r[i] for i in range(len(header)) if i < len(r)})
        return rows
    else:
        text = content.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text))
        return [dict(row) for row in reader]


def upsert_headcount(rows):
    data = read_budget()
    upserted = 0
    depts = set()

    for row in rows:
        dept = row.get("구분")
        if not dept or dept == "계":
            continue
        depts.add(dept)

        for m in MONTHS:
            value = to_number(row.get(f"{m}월"))
            if value is None:
                continue
            existing = next((h for h in data["headcount"] if h["dept"] == dept and h["month"] == m), None)
            if existing:
                existing["count"] = value
            else:
                data["headcount"].append({"dept": dept, "month": m, "count": value})
            upserted += 1

    data["uploads"].append({"type": "headcount", "rows": len(rows)})
    write_budget(data)
    return upserted, sorted(depts)


def upsert_detail(rows):
    data = read_budget()
    upserted = 0
    depts = set()

    for row in rows:
        dept = row.get("부문")
        category = row.get("구분")
        if not dept or dept == "계" or category not in CATEGORIES:
            continue
        depts.add(dept)

        team = row.get("팀") or ""
        revenue_type = row.get("매출구분") or ""
        account = row.get("항목") or ""
        detail = row.get("세부내역(산정근거)") or row.get("세부내역") or ""

        for m in MONTHS:
            amount = to_number(row.get(f"{m}월"))
            if amount is None:
                continue
            existing = next((
                i for i in data["items"]
                if i["dept"] == dept and i["team"] == team and i["account"] == account
                and i["category"] == category and i["month"] == m
            ), None)
            if existing:
                existing["amount"] = amount
                existing["revenueType"] = revenue_type
                existing["detail"] = detail
            else:
                data["items"].append({
                    "dept": dept, "team": team, "revenueType": revenue_type,
                    "account": account, "detail": detail, "category": category,
                    "month": m, "amount": amount
                })
            upserted += 1

    data["uploads"].append({"type": "detail", "rows": len(rows)})
    write_budget(data)
    return upserted, sorted(depts)


def build_summary():
    data = read_budget()
    depts = sorted(set([h["dept"] for h in data["headcount"]] + [i["dept"] for i in data["items"]]))

    summary = []
    for dept in depts:
        months = []
        for m in MONTHS:
            headcount_entry = next((h for h in data["headcount"] if h["dept"] == dept and h["month"] == m), None)
            dept_items = [i for i in data["items"] if i["dept"] == dept and i["month"] == m]

            by_category = {c: 0 for c in CATEGORIES}
            for i in dept_items:
                by_category[i["category"]] += i["amount"]

            total_amount = sum(i["amount"] for i in dept_items)

            months.append({
                "month": m,
                "headcount": headcount_entry["count"] if headcount_entry else None,
                **by_category,
                "totalAmount": total_amount,
                "hasHeadcountData": headcount_entry is not None,
                "hasDetailData": len(dept_items) > 0
            })
        summary.append({"dept": dept, "months": months})

    return summary


# ------------------- 엑셀형 그리드 (예산 시트) -------------------

def get_grid():
    data = read_budget()
    return data.get("grid") or []


def save_grid(rows):
    data = read_budget()
    data["grid"] = rows
    data["grid_updated_at"] = _now_iso()
    write_budget(data)
    return True


def get_sheets():
    """멀티시트 데이터 반환 — {sheets, active, styles}"""
    data = read_budget()
    if "sheets" in data:
        return {
            "sheets": data["sheets"],
            "active": data.get("active", list(data["sheets"].keys())[0]),
            "styles": data.get("styles", {}),
            "colWidths": data.get("colWidths", {}),
            "rowHeights": data.get("rowHeights", {}),
            "mergedCells": data.get("mergedCells", {}),
            "conditionalFormats": data.get("conditionalFormats", {}),
            "dataValidations": data.get("dataValidations", {}),
        }
    # 기존 단일 grid → Sheet1으로 마이그레이션
    grid = data.get("grid") or []
    return {"sheets": {"Sheet1": grid}, "active": "Sheet1", "styles": {}, "colWidths": {}, "rowHeights": {}}


def save_sheets(payload: dict):
    """멀티시트 데이터 저장 — payload: {sheets, active, styles, colWidths, rowHeights}"""
    data = read_budget()
    data["sheets"] = payload.get("sheets", {})
    data["active"] = payload.get("active", "Sheet1")
    data["styles"] = payload.get("styles", {})
    data["colWidths"] = payload.get("colWidths", {})
    data["rowHeights"] = payload.get("rowHeights", {})
    data["mergedCells"] = payload.get("mergedCells", {})
    data["conditionalFormats"] = payload.get("conditionalFormats", {})
    data["dataValidations"] = payload.get("dataValidations", {})
    data["sheets_updated_at"] = _now_iso()
    # 하위 호환: 활성 시트를 grid에도 동기
    active = data["active"]
    if active in data["sheets"]:
        data["grid"] = data["sheets"][active]
    write_budget(data)
    return True


def parse_grid(content: bytes, filename: str):
    """업로드 파일(xlsx/csv)을 그대로 2차원 문자열 배열(grid)로 변환"""
    if filename.lower().endswith((".xlsx", ".xls")):
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
        sheet = wb.worksheets[0]
        rows = []
        for r in sheet.iter_rows(values_only=True):
            rows.append(["" if v is None else str(v) for v in r])
        return rows
    else:
        text = content.decode("utf-8-sig")
        reader = csv.reader(io.StringIO(text))
        return [list(row) for row in reader]


def export_grid_xlsx(rows):
    import openpyxl
    wb = openpyxl.Workbook()
    sheet = wb.active
    sheet.title = "예산"
    for r_idx, row in enumerate(rows, start=1):
        for c_idx, val in enumerate(row, start=1):
            cell = sheet.cell(row=r_idx, column=c_idx)
            num = to_number(val)
            if num is not None:
                cell.value = num
            # 업로드/입력된 셀 값을 그대로 수식으로 흘려보내면 Excel 수식 인젝션
            # (예: =HYPERLINK(...)) 이 가능해지므로, 숫자가 아니면서 위험한 선행 문자로
            # 시작하는 값은 텍스트로 무력화 (음수 "-500" 등은 위에서 이미 숫자로 처리됨)
            elif isinstance(val, str) and val[:1] in ("=", "+", "-", "@"):
                cell.value = "'" + val
            else:
                cell.value = val
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


# ------------------- 스냅샷(월별 최종 자료) -------------------

def list_snapshots():
    data = read_budget()
    return [
        {"id": s["id"], "label": s["label"], "createdAt": s["createdAt"], "rows": len(s["grid"])}
        for s in data.get("snapshots", [])
    ]


def save_snapshot(label, rows):
    data = read_budget()
    snapshots = data.setdefault("snapshots", [])
    existing = next((s for s in snapshots if s["label"] == label), None)
    if existing:
        existing["grid"] = rows
        existing["createdAt"] = _now_iso()
        snap_id = existing["id"]
    else:
        snap_id = str(uuid.uuid4())
        snapshots.append({
            "id": snap_id, "label": label, "grid": rows, "createdAt": _now_iso()
        })
    write_budget(data)
    return snap_id


def get_snapshot(snap_id):
    data = read_budget()
    return next((s for s in data.get("snapshots", []) if s["id"] == snap_id), None)


def delete_snapshot(snap_id):
    data = read_budget()
    before = len(data.get("snapshots", []))
    data["snapshots"] = [s for s in data.get("snapshots", []) if s["id"] != snap_id]
    write_budget(data)
    return before != len(data["snapshots"])


_CELL_RE = re.compile(r"^[A-Za-z]+\d+$")


def _col_letters(idx):
    """0-based column index -> Excel-style letters"""
    letters = ""
    idx += 1
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def compare_rows(rows_a, rows_b):
    """두 그리드(rows_a=기준, rows_b=비교대상)를 셀 단위로 비교, 숫자면 차이 계산"""
    n_rows = max(len(rows_a), len(rows_b))
    diffs = []
    for r in range(n_rows):
        row_a = rows_a[r] if r < len(rows_a) else []
        row_b = rows_b[r] if r < len(rows_b) else []
        n_cols = max(len(row_a), len(row_b))
        for c in range(n_cols):
            val_a = row_a[c] if c < len(row_a) else ""
            val_b = row_b[c] if c < len(row_b) else ""
            val_a = "" if val_a is None else str(val_a)
            val_b = "" if val_b is None else str(val_b)
            if val_a == val_b:
                continue
            num_a = to_number(val_a)
            num_b = to_number(val_b)
            delta = None
            if num_a is not None and num_b is not None:
                delta = num_b - num_a
            diffs.append({
                "cell": f"{_col_letters(c)}{r + 1}",
                "row": r, "col": c,
                "before": val_a, "after": val_b, "delta": delta
            })
    return diffs
