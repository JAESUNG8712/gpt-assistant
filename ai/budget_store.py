import os
import json
import csv
import io

import memory as mem

BUDGET_FILE = os.path.join(os.path.dirname(mem.DB_PATH), "budget-data.json")
MONTHS = list(range(1, 13))
CATEGORIES = ["판관", "용역", "경상"]


def _empty():
    return {"headcount": [], "items": [], "uploads": []}


def read_budget():
    if not os.path.exists(BUDGET_FILE):
        return _empty()
    with open(BUDGET_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


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
