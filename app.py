import io
import os
import csv
from datetime import datetime, date

import pandas as pd
from flask import (
    Flask, render_template, request, redirect,
    url_for, flash, send_file,
)
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.exc import IntegrityError

from calculator import calculate_salary

# ── App setup ─────────────────────────────────────────────────────────────────

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "salary-calc-secret-2024")

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{os.path.join(BASE_DIR, 'instance', 'salary.db')}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["UPLOAD_FOLDER"] = os.path.join(BASE_DIR, "uploads")

os.makedirs(os.path.join(BASE_DIR, "instance"), exist_ok=True)
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

db = SQLAlchemy(app)


# ── Models ────────────────────────────────────────────────────────────────────

class Employee(db.Model):
    __tablename__ = "employees"

    id               = db.Column(db.Integer, primary_key=True)
    employee_id      = db.Column(db.String(20), unique=True, nullable=False)
    name             = db.Column(db.String(50), nullable=False)
    department       = db.Column(db.String(50))
    position         = db.Column(db.String(50))
    annual_salary    = db.Column(db.Integer, nullable=False)
    dependents       = db.Column(db.Integer, default=1)        # 본인 포함 부양가족 수
    non_taxable_meal = db.Column(db.Integer, default=200_000)  # 비과세 식대
    hire_date        = db.Column(db.Date)
    is_active        = db.Column(db.Boolean, default=True)
    created_at       = db.Column(db.DateTime, default=datetime.utcnow)

    adjustments = db.relationship("Adjustment", backref="employee", lazy=True,
                                  cascade="all, delete-orphan")
    records = db.relationship("SalaryRecord", backref="employee", lazy=True,
                              cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "annual_salary":    self.annual_salary,
            "dependents":       self.dependents,
            "non_taxable_meal": self.non_taxable_meal,
        }


class SalaryRecord(db.Model):
    """확정된 급여 내역 - (employee_id, year, month) 조합은 유일."""
    __tablename__ = "salary_records"
    __table_args__ = (
        db.UniqueConstraint("employee_id", "year", "month", name="uq_salary_record"),
    )

    id                  = db.Column(db.Integer, primary_key=True)
    employee_id         = db.Column(db.Integer, db.ForeignKey("employees.id"), nullable=False)
    year                = db.Column(db.Integer, nullable=False)
    month               = db.Column(db.Integer, nullable=False)

    # 확정 시점 스냅샷
    emp_name            = db.Column(db.String(50))
    emp_code            = db.Column(db.String(20))
    department          = db.Column(db.String(50))
    position            = db.Column(db.String(50))
    annual_salary       = db.Column(db.Integer)

    # 지급
    monthly_base        = db.Column(db.Integer)
    extra_pay           = db.Column(db.Integer, default=0)
    condolence_pay      = db.Column(db.Integer, default=0)
    unpaid_leave_amount = db.Column(db.Integer, default=0)
    total_pay           = db.Column(db.Integer)

    # 공제
    national_pension    = db.Column(db.Integer)
    health_insurance    = db.Column(db.Integer)
    long_term_care      = db.Column(db.Integer)
    employment_insurance= db.Column(db.Integer)
    income_tax          = db.Column(db.Integer)
    local_income_tax    = db.Column(db.Integer)
    other_deduction     = db.Column(db.Integer, default=0)
    total_deduction     = db.Column(db.Integer)

    net_pay             = db.Column(db.Integer)
    saved_at            = db.Column(db.DateTime, default=datetime.utcnow)


class Adjustment(db.Model):
    __tablename__ = "adjustments"

    id          = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.Integer, db.ForeignKey("employees.id"), nullable=False)
    year        = db.Column(db.Integer, nullable=False)
    month       = db.Column(db.Integer, nullable=False)
    type        = db.Column(db.String(30), nullable=False)
    value       = db.Column(db.Float, nullable=False)
    description = db.Column(db.String(200))
    created_at  = db.Column(db.DateTime, default=datetime.utcnow)


# ── Helpers ───────────────────────────────────────────────────────────────────

ADJ_TYPE_MAP = {
    "무급휴가":  "unpaid_leave",
    "경조사비":  "condolence_pay",
    "추가수당":  "extra_pay",
    "기타공제":  "other_deduction",
    "unpaid_leave":    "unpaid_leave",
    "condolence_pay":  "condolence_pay",
    "extra_pay":       "extra_pay",
    "other_deduction": "other_deduction",
}

ADJ_TYPE_LABEL = {
    "unpaid_leave":    "무급휴가",
    "condolence_pay":  "경조사비 (비과세)",
    "extra_pay":       "추가수당",
    "other_deduction": "기타공제",
}

MONTHS = list(range(1, 13))


def current_ym():
    now = datetime.now()
    return now.year, now.month


def fmt_won(v):
    """Format integer as Korean currency string"""
    return f"{int(v):,}원"


app.jinja_env.filters["won"] = fmt_won


STATIC_DIR = os.path.join(BASE_DIR, "static")

def _has_local_bootstrap():
    return os.path.exists(os.path.join(STATIC_DIR, "css", "bootstrap.min.css"))


@app.context_processor
def inject_globals():
    return {
        "now": datetime.now(),
        "local_bootstrap": _has_local_bootstrap(),
    }


# ── Routes: Dashboard ─────────────────────────────────────────────────────────

@app.route("/")
def index():
    year, month = current_ym()
    total_employees = Employee.query.filter_by(is_active=True).count()
    employees = Employee.query.filter_by(is_active=True).all()

    total_net = 0
    total_pay = 0
    total_deduction = 0
    for emp in employees:
        adjs = Adjustment.query.filter_by(employee_id=emp.id, year=year, month=month).all()
        result = calculate_salary(emp.to_dict(), [{"type": a.type, "value": a.value, "description": a.description} for a in adjs])
        total_net       += result["net_pay"]
        total_pay       += result["total_pay"]
        total_deduction += result["total_deduction"]

    return render_template(
        "index.html",
        year=year, month=month,
        total_employees=total_employees,
        total_net=total_net,
        total_pay=total_pay,
        total_deduction=total_deduction,
    )


# ── Routes: Employees ─────────────────────────────────────────────────────────

@app.route("/employees")
def employees_list():
    employees = Employee.query.order_by(Employee.employee_id).all()
    return render_template("employees/list.html", employees=employees)


@app.route("/employees/new", methods=["GET", "POST"])
def employee_new():
    if request.method == "POST":
        emp_id = request.form["employee_id"].strip()
        if Employee.query.filter_by(employee_id=emp_id).first():
            flash(f"사번 '{emp_id}'은 이미 등록되어 있습니다.", "danger")
            return render_template("employees/form.html", action="new", data=request.form)

        hire_date = None
        if request.form.get("hire_date"):
            try:
                hire_date = date.fromisoformat(request.form["hire_date"])
            except ValueError:
                pass

        emp = Employee(
            employee_id      = emp_id,
            name             = request.form["name"].strip(),
            department       = request.form.get("department", "").strip(),
            position         = request.form.get("position", "").strip(),
            annual_salary    = int(request.form["annual_salary"].replace(",", "")),
            dependents       = int(request.form.get("dependents", 1)),
            non_taxable_meal = int(request.form.get("non_taxable_meal", 200_000)),
            hire_date        = hire_date,
        )
        db.session.add(emp)
        db.session.commit()
        flash(f"{emp.name} 직원이 등록되었습니다.", "success")
        return redirect(url_for("employees_list"))

    return render_template("employees/form.html", action="new", data={})


@app.route("/employees/<int:emp_id>/edit", methods=["GET", "POST"])
def employee_edit(emp_id):
    emp = Employee.query.get_or_404(emp_id)
    if request.method == "POST":
        new_emp_code = request.form["employee_id"].strip()
        conflict = Employee.query.filter(
            Employee.employee_id == new_emp_code,
            Employee.id != emp_id
        ).first()
        if conflict:
            flash(f"사번 '{new_emp_code}'은 이미 사용 중입니다.", "danger")
            return render_template("employees/form.html", action="edit", emp=emp, data=request.form)

        hire_date = emp.hire_date
        if request.form.get("hire_date"):
            try:
                hire_date = date.fromisoformat(request.form["hire_date"])
            except ValueError:
                pass

        emp.employee_id      = new_emp_code
        emp.name             = request.form["name"].strip()
        emp.department       = request.form.get("department", "").strip()
        emp.position         = request.form.get("position", "").strip()
        emp.annual_salary    = int(request.form["annual_salary"].replace(",", ""))
        emp.dependents       = int(request.form.get("dependents", 1))
        emp.non_taxable_meal = int(request.form.get("non_taxable_meal", 200_000))
        emp.hire_date        = hire_date
        db.session.commit()
        flash(f"{emp.name} 직원 정보가 수정되었습니다.", "success")
        return redirect(url_for("employees_list"))

    return render_template("employees/form.html", action="edit", emp=emp, data={})


@app.route("/employees/<int:emp_id>/delete", methods=["POST"])
def employee_delete(emp_id):
    emp = Employee.query.get_or_404(emp_id)
    name = emp.name
    db.session.delete(emp)
    db.session.commit()
    flash(f"{name} 직원이 삭제되었습니다.", "success")
    return redirect(url_for("employees_list"))


# ── Routes: Salary Calculation ────────────────────────────────────────────────

@app.route("/salary")
def salary_index():
    year, month = current_ym()
    return redirect(url_for("salary_calculate", year=year, month=month))


@app.route("/salary/<int:year>/<int:month>")
def salary_calculate(year, month):
    employees = Employee.query.filter_by(is_active=True).order_by(Employee.employee_id).all()

    results = []
    for emp in employees:
        adjs = Adjustment.query.filter_by(employee_id=emp.id, year=year, month=month).all()
        adj_list = [{"type": a.type, "value": a.value, "description": a.description} for a in adjs]
        result = calculate_salary(emp.to_dict(), adj_list)
        results.append({
            "emp":    emp,
            "result": result,
            "adjs":   adjs,
        })

    summary = {
        "total_pay":       sum(r["result"]["total_pay"]       for r in results),
        "total_deduction": sum(r["result"]["total_deduction"] for r in results),
        "net_pay":         sum(r["result"]["net_pay"]         for r in results),
    }

    prev_month = (month - 2) % 12 + 1
    prev_year  = year if month > 1 else year - 1
    next_month = month % 12 + 1
    next_year  = year if month < 12 else year + 1

    return render_template(
        "salary/calculate.html",
        year=year, month=month,
        results=results, summary=summary,
        prev_year=prev_year, prev_month=prev_month,
        next_year=next_year, next_month=next_month,
        adj_type_label=ADJ_TYPE_LABEL,
    )


@app.route("/salary/<int:year>/<int:month>/export")
def salary_export(year, month):
    employees = Employee.query.filter_by(is_active=True).order_by(Employee.employee_id).all()

    rows = []
    for emp in employees:
        adjs = Adjustment.query.filter_by(employee_id=emp.id, year=year, month=month).all()
        adj_list = [{"type": a.type, "value": a.value, "description": a.description} for a in adjs]
        r = calculate_salary(emp.to_dict(), adj_list)
        rows.append({
            "사번":          emp.employee_id,
            "이름":          emp.name,
            "부서":          emp.department or "",
            "직급":          emp.position or "",
            "기본급":        r["monthly_base"],
            "추가수당":      r["extra_pay"],
            "경조사비(비과세)": r["condolence_pay"],
            "무급휴가차감":  r["unpaid_leave_amount"],
            "총지급액":      r["total_pay"],
            "국민연금":      r["national_pension"],
            "건강보험":      r["health_insurance"],
            "장기요양보험":  r["long_term_care"],
            "고용보험":      r["employment_insurance"],
            "소득세":        r["income_tax"],
            "지방소득세":    r["local_income_tax"],
            "기타공제":      r["other_deduction"],
            "총공제액":      r["total_deduction"],
            "실수령액":      r["net_pay"],
        })

    df = pd.DataFrame(rows)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name=f"{year}년{month}월 급여")
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=f"급여명세_{year}{month:02d}.xlsx",
    )


# ── Routes: Adjustments Upload ────────────────────────────────────────────────

@app.route("/salary/upload", methods=["GET", "POST"])
def salary_upload():
    year, month = current_ym()
    preview_rows = []
    errors = []

    if request.method == "POST":
        year  = int(request.form.get("year",  year))
        month = int(request.form.get("month", month))
        action = request.form.get("action", "preview")

        file = request.files.get("csv_file")
        if not file or file.filename == "":
            flash("파일을 선택해주세요.", "danger")
            return render_template("salary/upload.html", year=year, month=month, months=MONTHS)

        try:
            df = pd.read_csv(file, encoding="utf-8-sig", dtype=str)
        except Exception:
            try:
                file.seek(0)
                df = pd.read_csv(file, encoding="cp949", dtype=str)
            except Exception as e:
                flash(f"파일 읽기 오류: {e}", "danger")
                return render_template("salary/upload.html", year=year, month=month, months=MONTHS)

        required_cols = {"사번", "구분", "값"}
        if not required_cols.issubset(set(df.columns)):
            flash(f"CSV에 필수 컬럼이 없습니다. 필요: {required_cols}", "danger")
            return render_template("salary/upload.html", year=year, month=month, months=MONTHS)

        for i, row in df.iterrows():
            emp_code = str(row["사번"]).strip()
            raw_type = str(row["구분"]).strip()
            raw_val  = str(row["값"]).strip()
            desc     = str(row.get("비고", "")).strip() if "비고" in df.columns else ""

            adj_type = ADJ_TYPE_MAP.get(raw_type)
            emp = Employee.query.filter_by(employee_id=emp_code).first()

            row_error = None
            if not emp:
                row_error = f"사번 '{emp_code}' 없음"
            elif not adj_type:
                row_error = f"구분 '{raw_type}' 미지원"
            else:
                try:
                    val = float(raw_val)
                except ValueError:
                    row_error = f"값 '{raw_val}' 숫자 아님"

            preview_rows.append({
                "row":      i + 2,
                "emp_code": emp_code,
                "emp_name": emp.name if emp else "-",
                "type":     ADJ_TYPE_LABEL.get(adj_type, raw_type) if adj_type else raw_type,
                "raw_type": adj_type,
                "value":    raw_val,
                "desc":     desc,
                "error":    row_error,
                "emp_id":   emp.id if emp else None,
            })
            if row_error:
                errors.append(f"행 {i+2}: {row_error}")

        if action == "apply":
            if errors:
                flash(f"오류가 있는 행이 있어 저장할 수 없습니다. ({len(errors)}건)", "danger")
            else:
                saved = 0
                for pr in preview_rows:
                    adj = Adjustment(
                        employee_id = pr["emp_id"],
                        year        = year,
                        month       = month,
                        type        = pr["raw_type"],
                        value       = float(pr["value"]),
                        description = pr["desc"],
                    )
                    db.session.add(adj)
                    saved += 1
                db.session.commit()
                flash(f"{saved}건이 {year}년 {month}월 조정 내역으로 저장되었습니다.", "success")
                return redirect(url_for("salary_calculate", year=year, month=month))

    return render_template(
        "salary/upload.html",
        year=year, month=month, months=MONTHS,
        preview_rows=preview_rows, errors=errors,
    )


@app.route("/salary/template")
def download_template():
    rows = [
        ["사번", "구분", "값", "비고"],
        ["EMP001", "무급휴가", "1.5", "반차 3회"],
        ["EMP001", "경조사비", "300000", "배우자 상"],
        ["EMP002", "추가수당", "150000", "연장근무수당"],
        ["EMP003", "기타공제", "50000", ""],
    ]
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerows(rows)
    buf.seek(0)
    return send_file(
        io.BytesIO(buf.getvalue().encode("utf-8-sig")),
        mimetype="text/csv",
        as_attachment=True,
        download_name="급여조정_업로드_템플릿.csv",
    )


@app.route("/adjustments/<int:adj_id>/delete", methods=["POST"])
def adjustment_delete(adj_id):
    adj = Adjustment.query.get_or_404(adj_id)
    year, month = adj.year, adj.month
    emp_db_id = adj.employee_id
    db.session.delete(adj)
    db.session.commit()
    flash("조정 항목이 삭제되었습니다.", "success")
    return redirect(url_for("salary_calculate", year=year, month=month))


# ── Routes: Manual Adjustment ─────────────────────────────────────────────────

@app.route("/salary/<int:year>/<int:month>/adjustment/add", methods=["POST"])
def adjustment_add(year, month):
    emp_id   = request.form.get("employee_id")
    adj_type = request.form.get("type")
    value    = request.form.get("value", "0").replace(",", "")
    desc     = request.form.get("description", "")

    if not emp_id or not adj_type:
        flash("직원 및 구분을 선택해주세요.", "danger")
        return redirect(url_for("salary_calculate", year=year, month=month))

    try:
        value = float(value)
    except ValueError:
        flash("값이 올바르지 않습니다.", "danger")
        return redirect(url_for("salary_calculate", year=year, month=month))

    adj = Adjustment(
        employee_id = int(emp_id),
        year        = year,
        month       = month,
        type        = adj_type,
        value       = value,
        description = desc,
    )
    db.session.add(adj)
    db.session.commit()
    flash("조정 항목이 추가되었습니다.", "success")
    return redirect(url_for("salary_calculate", year=year, month=month))


# ── Routes: Salary Record (확정/이력) ─────────────────────────────────────────

@app.route("/salary/<int:year>/<int:month>/confirm", methods=["POST"])
def salary_confirm(year, month):
    """현재 월 계산 결과를 급여 내역으로 확정 저장. 이미 저장된 직원은 건너뜀."""
    employees = Employee.query.filter_by(is_active=True).all()
    saved, skipped = 0, 0

    for emp in employees:
        existing = SalaryRecord.query.filter_by(
            employee_id=emp.id, year=year, month=month
        ).first()
        if existing:
            skipped += 1
            continue

        adjs = Adjustment.query.filter_by(employee_id=emp.id, year=year, month=month).all()
        adj_list = [{"type": a.type, "value": a.value, "description": a.description} for a in adjs]
        r = calculate_salary(emp.to_dict(), adj_list)

        rec = SalaryRecord(
            employee_id         = emp.id,
            year                = year,
            month               = month,
            emp_name            = emp.name,
            emp_code            = emp.employee_id,
            department          = emp.department or "",
            position            = emp.position or "",
            annual_salary       = emp.annual_salary,
            monthly_base        = r["monthly_base"],
            extra_pay           = r["extra_pay"],
            condolence_pay      = r["condolence_pay"],
            unpaid_leave_amount = r["unpaid_leave_amount"],
            total_pay           = r["total_pay"],
            national_pension    = r["national_pension"],
            health_insurance    = r["health_insurance"],
            long_term_care      = r["long_term_care"],
            employment_insurance= r["employment_insurance"],
            income_tax          = r["income_tax"],
            local_income_tax    = r["local_income_tax"],
            other_deduction     = r["other_deduction"],
            total_deduction     = r["total_deduction"],
            net_pay             = r["net_pay"],
        )
        db.session.add(rec)
        saved += 1

    db.session.commit()

    if saved:
        msg = f"{year}년 {month}월 급여가 확정되었습니다. ({saved}명 저장"
        if skipped:
            msg += f", {skipped}명은 이미 저장되어 있어 건너뜀"
        flash(msg + ")", "success")
    else:
        flash(f"{year}년 {month}월은 이미 모든 직원이 확정 저장되어 있습니다.", "warning")

    return redirect(url_for("salary_calculate", year=year, month=month))


@app.route("/salary/history")
def salary_history():
    """연월별 확정 급여 내역 목록"""
    year  = request.args.get("year",  type=int, default=datetime.now().year)
    month = request.args.get("month", type=int, default=datetime.now().month)

    records = (
        SalaryRecord.query
        .filter_by(year=year, month=month)
        .order_by(SalaryRecord.emp_code)
        .all()
    )

    summary = {
        "total_pay":       sum(r.total_pay       for r in records),
        "total_deduction": sum(r.total_deduction for r in records),
        "net_pay":         sum(r.net_pay         for r in records),
    }

    # 저장된 연월 목록 (드롭다운용)
    months_available = (
        db.session.query(SalaryRecord.year, SalaryRecord.month)
        .distinct()
        .order_by(SalaryRecord.year.desc(), SalaryRecord.month.desc())
        .all()
    )

    return render_template(
        "salary/history.html",
        year=year, month=month,
        records=records, summary=summary,
        months_available=months_available,
        months=MONTHS,
    )


@app.route("/salary/history/export")
def history_export():
    """확정 내역 엑셀 내보내기"""
    year  = request.args.get("year",  type=int, default=datetime.now().year)
    month = request.args.get("month", type=int, default=datetime.now().month)

    records = (
        SalaryRecord.query
        .filter_by(year=year, month=month)
        .order_by(SalaryRecord.emp_code)
        .all()
    )

    rows = [{
        "사번":          r.emp_code,
        "이름":          r.emp_name,
        "부서":          r.department,
        "직급":          r.position,
        "기본급":        r.monthly_base,
        "추가수당":      r.extra_pay,
        "경조사비(비과세)": r.condolence_pay,
        "무급휴가차감":  r.unpaid_leave_amount,
        "총지급액":      r.total_pay,
        "국민연금":      r.national_pension,
        "건강보험":      r.health_insurance,
        "장기요양보험":  r.long_term_care,
        "고용보험":      r.employment_insurance,
        "소득세":        r.income_tax,
        "지방소득세":    r.local_income_tax,
        "기타공제":      r.other_deduction,
        "총공제액":      r.total_deduction,
        "실수령액":      r.net_pay,
    } for r in records]

    df = pd.DataFrame(rows) if rows else pd.DataFrame()
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name=f"{year}년{month}월 급여확정")
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=f"급여확정_{year}{month:02d}.xlsx",
    )


@app.route("/salary/records/<int:rec_id>/delete", methods=["POST"])
def record_delete(rec_id):
    rec = SalaryRecord.query.get_or_404(rec_id)
    year, month = rec.year, rec.month
    db.session.delete(rec)
    db.session.commit()
    flash("확정 내역이 삭제되었습니다.", "success")
    return redirect(url_for("salary_history", year=year, month=month))


# ── Entry point ───────────────────────────────────────────────────────────────

with app.app_context():
    db.create_all()

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
