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

from calculator import calculate_salary, DEFAULT_RATES

# ── App setup ─────────────────────────────────────────────────────────────────

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "salary-calc-secret-2024")

BASE_DIR   = os.path.abspath(os.path.dirname(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
app.config["SQLALCHEMY_DATABASE_URI"] = (
    f"sqlite:///{os.path.join(BASE_DIR, 'instance', 'salary.db')}"
)
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
    dependents       = db.Column(db.Integer, default=1)
    non_taxable_meal = db.Column(db.Integer, default=200_000)
    hire_date        = db.Column(db.Date)
    is_active        = db.Column(db.Boolean, default=True)
    created_at       = db.Column(db.DateTime, default=datetime.utcnow)

    adjustments = db.relationship("Adjustment", backref="employee", lazy=True,
                                  cascade="all, delete-orphan")
    records     = db.relationship("SalaryRecord", backref="employee", lazy=True,
                                  cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "annual_salary":    self.annual_salary,
            "dependents":       self.dependents,
            "non_taxable_meal": self.non_taxable_meal,
        }


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


class SalaryRecord(db.Model):
    """확정 급여 내역 — (employee_id, year, month) 유일"""
    __tablename__  = "salary_records"
    __table_args__ = (
        db.UniqueConstraint("employee_id", "year", "month", name="uq_salary_record"),
    )

    id                   = db.Column(db.Integer, primary_key=True)
    employee_id          = db.Column(db.Integer, db.ForeignKey("employees.id"), nullable=False)
    year                 = db.Column(db.Integer, nullable=False)
    month                = db.Column(db.Integer, nullable=False)
    emp_name             = db.Column(db.String(50))
    emp_code             = db.Column(db.String(20))
    department           = db.Column(db.String(50))
    position             = db.Column(db.String(50))
    annual_salary        = db.Column(db.Integer)
    monthly_base         = db.Column(db.Integer)
    extra_pay            = db.Column(db.Integer, default=0)
    condolence_pay       = db.Column(db.Integer, default=0)
    unpaid_leave_amount  = db.Column(db.Integer, default=0)
    total_pay            = db.Column(db.Integer)
    national_pension     = db.Column(db.Integer)
    health_insurance     = db.Column(db.Integer)
    long_term_care       = db.Column(db.Integer)
    employment_insurance = db.Column(db.Integer)
    income_tax           = db.Column(db.Integer)
    local_income_tax     = db.Column(db.Integer)
    other_deduction      = db.Column(db.Integer, default=0)
    total_deduction      = db.Column(db.Integer)
    net_pay              = db.Column(db.Integer)
    saved_at             = db.Column(db.DateTime, default=datetime.utcnow)


class TaxConfig(db.Model):
    """연도별 세율 설정 — year 컬럼이 유일키"""
    __tablename__ = "tax_configs"

    id   = db.Column(db.Integer, primary_key=True)
    year = db.Column(db.Integer, unique=True, nullable=False)

    # 4대보험 요율 (근로자 부담, %)
    national_pension_rate     = db.Column(db.Float, nullable=False, default=4.5)
    health_insurance_rate     = db.Column(db.Float, nullable=False, default=3.545)
    long_term_care_rate       = db.Column(db.Float, nullable=False, default=12.95)  # 건강보험료 대비
    employment_insurance_rate = db.Column(db.Float, nullable=False, default=0.9)

    # 국민연금 기준소득월액 상·하한 (원)
    np_min = db.Column(db.Integer, nullable=False, default=370_000)
    np_max = db.Column(db.Integer, nullable=False, default=5_900_000)

    note       = db.Column(db.String(200))  # 변경 사유 메모
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_rates_dict(self) -> dict:
        return {
            "national_pension_rate":     self.national_pension_rate,
            "health_insurance_rate":     self.health_insurance_rate,
            "long_term_care_rate":       self.long_term_care_rate,
            "employment_insurance_rate": self.employment_insurance_rate,
            "np_min":                    self.np_min,
            "np_max":                    self.np_max,
        }


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
    return f"{int(v):,}원"


app.jinja_env.filters["won"] = fmt_won


def _has_local_bootstrap():
    return os.path.exists(os.path.join(STATIC_DIR, "css", "bootstrap.min.css"))


@app.context_processor
def inject_globals():
    return {
        "now":             datetime.now(),
        "local_bootstrap": _has_local_bootstrap(),
    }


def get_tax_rates(year: int) -> dict:
    """
    해당 연도의 TaxConfig를 반환.
    없으면 직전 연도 → 최신 연도 순서로 폴백.
    DB가 비어 있으면 calculator.DEFAULT_RATES를 그대로 반환.
    """
    cfg = TaxConfig.query.filter_by(year=year).first()
    if cfg is None:
        cfg = (TaxConfig.query
               .filter(TaxConfig.year <= year)
               .order_by(TaxConfig.year.desc())
               .first())
    if cfg is None:
        cfg = TaxConfig.query.order_by(TaxConfig.year.desc()).first()
    return cfg.to_rates_dict() if cfg else DEFAULT_RATES


def _seed_default_rates():
    """최초 실행 시 2024년 기본 세율을 DB에 삽입"""
    if TaxConfig.query.count() == 0:
        db.session.add(TaxConfig(
            year=2024,
            national_pension_rate=4.5,
            health_insurance_rate=3.545,
            long_term_care_rate=12.95,
            employment_insurance_rate=0.9,
            np_min=370_000,
            np_max=5_900_000,
            note="기본 세율 (2024년 기준)",
        ))
        db.session.commit()


# ── Routes: Dashboard ─────────────────────────────────────────────────────────

@app.route("/")
def index():
    year, month = current_ym()
    rates       = get_tax_rates(year)
    employees   = Employee.query.filter_by(is_active=True).all()

    total_net = total_pay = total_deduction = 0
    for emp in employees:
        adjs   = Adjustment.query.filter_by(employee_id=emp.id, year=year, month=month).all()
        result = calculate_salary(
            emp.to_dict(),
            [{"type": a.type, "value": a.value, "description": a.description} for a in adjs],
            rates,
        )
        total_net       += result["net_pay"]
        total_pay       += result["total_pay"]
        total_deduction += result["total_deduction"]

    tax_cfg = TaxConfig.query.filter_by(year=year).first()

    return render_template(
        "index.html",
        year=year, month=month,
        total_employees=len(employees),
        total_net=total_net,
        total_pay=total_pay,
        total_deduction=total_deduction,
        tax_cfg=tax_cfg,
    )


# ── Routes: Employees ─────────────────────────────────────────────────────────

@app.route("/employees")
def employees_list():
    employees = Employee.query.order_by(Employee.employee_id).all()
    return render_template("employees/list.html", employees=employees)


@app.route("/employees/template")
def employees_template():
    """직원 일괄 업로드용 CSV 양식 다운로드"""
    rows = [
        ["사번", "이름", "부서", "직급", "연봉", "부양가족수", "비과세식대", "입사일"],
        ["EMP001", "홍길동", "개발팀", "대리", "42000000", "2", "200000", "2022-03-01"],
        ["EMP002", "김영희", "인사팀", "과장", "55000000", "3", "200000", "2019-07-15"],
        ["EMP003", "이철수", "영업팀", "사원", "36000000", "1", "200000", "2024-01-02"],
    ]
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    buf.seek(0)
    return send_file(
        io.BytesIO(buf.getvalue().encode("utf-8-sig")),
        mimetype="text/csv",
        as_attachment=True,
        download_name="직원_일괄등록_템플릿.csv",
    )


@app.route("/employees/upload", methods=["GET", "POST"])
def employees_upload():
    preview_rows = []
    errors       = []

    if request.method == "POST":
        action   = request.form.get("action", "preview")
        on_dup   = request.form.get("on_duplicate", "skip")  # skip | update
        file     = request.files.get("file")

        if not file or file.filename == "":
            flash("파일을 선택해주세요.", "danger")
            return render_template("employees/upload.html")

        # ── 파일 파싱 ──────────────────────────────────────────────────────
        fname = file.filename.lower()
        try:
            if fname.endswith((".xlsx", ".xls")):
                df = pd.read_excel(file, dtype=str)
            else:
                try:
                    df = pd.read_csv(file, encoding="utf-8-sig", dtype=str)
                except Exception:
                    file.seek(0)
                    df = pd.read_csv(file, encoding="cp949", dtype=str)
        except Exception as e:
            flash(f"파일 읽기 오류: {e}", "danger")
            return render_template("employees/upload.html")

        required_cols = {"사번", "이름", "연봉"}
        if not required_cols.issubset(set(df.columns)):
            flash(f"필수 컬럼이 없습니다. 필요: {required_cols}", "danger")
            return render_template("employees/upload.html")

        # ── 행별 검증 ──────────────────────────────────────────────────────
        for i, row in df.iterrows():
            def col(name, default=""):
                v = str(row.get(name, default) or "").strip()
                return v if v not in ("nan", "None", "") else default

            emp_code    = col("사번")
            name        = col("이름")
            department  = col("부서")
            position    = col("직급")
            salary_raw  = col("연봉")
            dep_raw     = col("부양가족수", "1")
            meal_raw    = col("비과세식대", "200000")
            hire_raw    = col("입사일")

            row_error = None
            annual_salary = None
            existing = Employee.query.filter_by(employee_id=emp_code).first() if emp_code else None

            if not emp_code:
                row_error = "사번 없음"
            elif not name:
                row_error = "이름 없음"
            else:
                try:
                    annual_salary = int(salary_raw.replace(",", ""))
                except ValueError:
                    row_error = f"연봉 '{salary_raw}' 숫자 아님"

            try:
                dependents = int(dep_raw) if dep_raw else 1
            except ValueError:
                dependents = 1
            try:
                non_taxable_meal = int(meal_raw.replace(",", "")) if meal_raw else 200_000
            except ValueError:
                non_taxable_meal = 200_000
            try:
                hire_date = date.fromisoformat(hire_raw) if hire_raw else None
            except ValueError:
                hire_date = None

            status = "중복 (업데이트 예정)" if existing and on_dup == "update" \
                else "중복 (건너뜀)" if existing and on_dup == "skip" \
                else "신규"

            preview_rows.append({
                "row":             i + 2,
                "emp_code":        emp_code,
                "name":            name,
                "department":      department,
                "position":        position,
                "annual_salary":   annual_salary,
                "dependents":      dependents,
                "non_taxable_meal":non_taxable_meal,
                "hire_date":       hire_date,
                "existing":        existing,
                "status":          status,
                "error":           row_error,
            })
            if row_error:
                errors.append(f"행 {i+2}: {row_error}")

        # ── 저장 ──────────────────────────────────────────────────────────
        if action == "apply":
            if errors:
                flash(f"오류가 있는 행이 있어 저장할 수 없습니다. ({len(errors)}건)", "danger")
            else:
                added = updated = skipped = 0
                for pr in preview_rows:
                    if pr["error"]:
                        continue
                    existing = Employee.query.filter_by(employee_id=pr["emp_code"]).first()
                    if existing:
                        if on_dup == "update":
                            existing.name             = pr["name"]
                            existing.department       = pr["department"]
                            existing.position         = pr["position"]
                            existing.annual_salary    = pr["annual_salary"]
                            existing.dependents       = pr["dependents"]
                            existing.non_taxable_meal = pr["non_taxable_meal"]
                            if pr["hire_date"]:
                                existing.hire_date = pr["hire_date"]
                            updated += 1
                        else:
                            skipped += 1
                    else:
                        db.session.add(Employee(
                            employee_id      = pr["emp_code"],
                            name             = pr["name"],
                            department       = pr["department"],
                            position         = pr["position"],
                            annual_salary    = pr["annual_salary"],
                            dependents       = pr["dependents"],
                            non_taxable_meal = pr["non_taxable_meal"],
                            hire_date        = pr["hire_date"],
                        ))
                        added += 1
                db.session.commit()
                parts = []
                if added:   parts.append(f"{added}명 신규 등록")
                if updated: parts.append(f"{updated}명 업데이트")
                if skipped: parts.append(f"{skipped}명 건너뜀")
                flash(", ".join(parts) + " 완료.", "success")
                return redirect(url_for("employees_list"))

    return render_template(
        "employees/upload.html",
        preview_rows=preview_rows,
        errors=errors,
    )


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
        new_code = request.form["employee_id"].strip()
        conflict = Employee.query.filter(
            Employee.employee_id == new_code, Employee.id != emp_id
        ).first()
        if conflict:
            flash(f"사번 '{new_code}'은 이미 사용 중입니다.", "danger")
            return render_template("employees/form.html", action="edit", emp=emp, data=request.form)

        hire_date = emp.hire_date
        if request.form.get("hire_date"):
            try:
                hire_date = date.fromisoformat(request.form["hire_date"])
            except ValueError:
                pass

        emp.employee_id      = new_code
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
    rates     = get_tax_rates(year)
    employees = Employee.query.filter_by(is_active=True).order_by(Employee.employee_id).all()
    tax_cfg   = TaxConfig.query.filter_by(year=year).first()

    results = []
    for emp in employees:
        adjs     = Adjustment.query.filter_by(employee_id=emp.id, year=year, month=month).all()
        adj_list = [{"type": a.type, "value": a.value, "description": a.description} for a in adjs]
        result   = calculate_salary(emp.to_dict(), adj_list, rates)
        results.append({"emp": emp, "result": result, "adjs": adjs})

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
        tax_cfg=tax_cfg,
        rates=rates,
    )


@app.route("/salary/<int:year>/<int:month>/export")
def salary_export(year, month):
    rates     = get_tax_rates(year)
    employees = Employee.query.filter_by(is_active=True).order_by(Employee.employee_id).all()

    rows = []
    for emp in employees:
        adjs     = Adjustment.query.filter_by(employee_id=emp.id, year=year, month=month).all()
        adj_list = [{"type": a.type, "value": a.value, "description": a.description} for a in adjs]
        r        = calculate_salary(emp.to_dict(), adj_list, rates)
        rows.append({
            "사번":             emp.employee_id,
            "이름":             emp.name,
            "부서":             emp.department or "",
            "직급":             emp.position or "",
            "기본급":           r["monthly_base"],
            "추가수당":         r["extra_pay"],
            "경조사비(비과세)": r["condolence_pay"],
            "무급휴가차감":     r["unpaid_leave_amount"],
            "총지급액":         r["total_pay"],
            "국민연금":         r["national_pension"],
            "건강보험":         r["health_insurance"],
            "장기요양보험":     r["long_term_care"],
            "고용보험":         r["employment_insurance"],
            "소득세":           r["income_tax"],
            "지방소득세":       r["local_income_tax"],
            "기타공제":         r["other_deduction"],
            "총공제액":         r["total_deduction"],
            "실수령액":         r["net_pay"],
        })

    df  = pd.DataFrame(rows)
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


# ── Routes: Salary Confirm / History ─────────────────────────────────────────

@app.route("/salary/<int:year>/<int:month>/confirm", methods=["POST"])
def salary_confirm(year, month):
    rates     = get_tax_rates(year)
    employees = Employee.query.filter_by(is_active=True).all()
    saved = skipped = 0

    for emp in employees:
        if SalaryRecord.query.filter_by(employee_id=emp.id, year=year, month=month).first():
            skipped += 1
            continue

        adjs     = Adjustment.query.filter_by(employee_id=emp.id, year=year, month=month).all()
        adj_list = [{"type": a.type, "value": a.value, "description": a.description} for a in adjs]
        r        = calculate_salary(emp.to_dict(), adj_list, rates)

        db.session.add(SalaryRecord(
            employee_id=emp.id, year=year, month=month,
            emp_name=emp.name, emp_code=emp.employee_id,
            department=emp.department or "", position=emp.position or "",
            annual_salary=emp.annual_salary,
            monthly_base=r["monthly_base"], extra_pay=r["extra_pay"],
            condolence_pay=r["condolence_pay"], unpaid_leave_amount=r["unpaid_leave_amount"],
            total_pay=r["total_pay"],
            national_pension=r["national_pension"], health_insurance=r["health_insurance"],
            long_term_care=r["long_term_care"], employment_insurance=r["employment_insurance"],
            income_tax=r["income_tax"], local_income_tax=r["local_income_tax"],
            other_deduction=r["other_deduction"], total_deduction=r["total_deduction"],
            net_pay=r["net_pay"],
        ))
        saved += 1

    db.session.commit()

    if saved:
        msg = f"{year}년 {month}월 급여가 확정되었습니다. ({saved}명 저장"
        if skipped:
            msg += f", {skipped}명 이미 저장됨"
        flash(msg + ")", "success")
    else:
        flash(f"{year}년 {month}월은 이미 모든 직원이 확정 저장되어 있습니다.", "warning")

    return redirect(url_for("salary_calculate", year=year, month=month))


@app.route("/salary/history")
def salary_history():
    year  = request.args.get("year",  type=int, default=datetime.now().year)
    month = request.args.get("month", type=int, default=datetime.now().month)

    records = (SalaryRecord.query
               .filter_by(year=year, month=month)
               .order_by(SalaryRecord.emp_code).all())

    summary = {
        "total_pay":       sum(r.total_pay       for r in records),
        "total_deduction": sum(r.total_deduction for r in records),
        "net_pay":         sum(r.net_pay         for r in records),
    }
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
    year  = request.args.get("year",  type=int, default=datetime.now().year)
    month = request.args.get("month", type=int, default=datetime.now().month)
    records = (SalaryRecord.query.filter_by(year=year, month=month)
               .order_by(SalaryRecord.emp_code).all())

    rows = [{
        "사번": r.emp_code, "이름": r.emp_name, "부서": r.department, "직급": r.position,
        "기본급": r.monthly_base, "추가수당": r.extra_pay,
        "경조사비(비과세)": r.condolence_pay, "무급휴가차감": r.unpaid_leave_amount,
        "총지급액": r.total_pay,
        "국민연금": r.national_pension, "건강보험": r.health_insurance,
        "장기요양보험": r.long_term_care, "고용보험": r.employment_insurance,
        "소득세": r.income_tax, "지방소득세": r.local_income_tax,
        "기타공제": r.other_deduction, "총공제액": r.total_deduction, "실수령액": r.net_pay,
    } for r in records]

    df  = pd.DataFrame(rows) if rows else pd.DataFrame()
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


# ── Routes: Adjustments Upload ────────────────────────────────────────────────

@app.route("/salary/upload", methods=["GET", "POST"])
def salary_upload():
    year, month  = current_ym()
    preview_rows = []
    errors       = []

    if request.method == "POST":
        year   = int(request.form.get("year",  year))
        month  = int(request.form.get("month", month))
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

            adj_type  = ADJ_TYPE_MAP.get(raw_type)
            emp       = Employee.query.filter_by(employee_id=emp_code).first()
            row_error = None

            if not emp:
                row_error = f"사번 '{emp_code}' 없음"
            elif not adj_type:
                row_error = f"구분 '{raw_type}' 미지원"
            else:
                try:
                    float(raw_val)
                except ValueError:
                    row_error = f"값 '{raw_val}' 숫자 아님"

            preview_rows.append({
                "row": i + 2, "emp_code": emp_code,
                "emp_name": emp.name if emp else "-",
                "type": ADJ_TYPE_LABEL.get(adj_type, raw_type) if adj_type else raw_type,
                "raw_type": adj_type, "value": raw_val, "desc": desc,
                "error": row_error, "emp_id": emp.id if emp else None,
            })
            if row_error:
                errors.append(f"행 {i+2}: {row_error}")

        if action == "apply":
            if errors:
                flash(f"오류가 있는 행이 있어 저장할 수 없습니다. ({len(errors)}건)", "danger")
            else:
                for pr in preview_rows:
                    db.session.add(Adjustment(
                        employee_id=pr["emp_id"], year=year, month=month,
                        type=pr["raw_type"], value=float(pr["value"]), description=pr["desc"],
                    ))
                db.session.commit()
                flash(f"{len(preview_rows)}건이 {year}년 {month}월 조정 내역으로 저장되었습니다.", "success")
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
    csv.writer(buf).writerows(rows)
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
    db.session.delete(adj)
    db.session.commit()
    flash("조정 항목이 삭제되었습니다.", "success")
    return redirect(url_for("salary_calculate", year=year, month=month))


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

    db.session.add(Adjustment(
        employee_id=int(emp_id), year=year, month=month,
        type=adj_type, value=value, description=desc,
    ))
    db.session.commit()
    flash("조정 항목이 추가되었습니다.", "success")
    return redirect(url_for("salary_calculate", year=year, month=month))


# ── Routes: Tax Config (세율 설정) ────────────────────────────────────────────

@app.route("/settings/tax")
def tax_settings():
    configs = TaxConfig.query.order_by(TaxConfig.year.desc()).all()
    return render_template("settings/tax.html", configs=configs, default_rates=DEFAULT_RATES)


@app.route("/settings/tax/new", methods=["GET", "POST"])
def tax_settings_new():
    if request.method == "POST":
        year = int(request.form["year"])
        if TaxConfig.query.filter_by(year=year).first():
            flash(f"{year}년 세율이 이미 존재합니다. 수정 화면에서 변경해주세요.", "danger")
            return redirect(url_for("tax_settings"))

        db.session.add(TaxConfig(
            year                     = year,
            national_pension_rate    = float(request.form["national_pension_rate"]),
            health_insurance_rate    = float(request.form["health_insurance_rate"]),
            long_term_care_rate      = float(request.form["long_term_care_rate"]),
            employment_insurance_rate= float(request.form["employment_insurance_rate"]),
            np_min                   = int(request.form["np_min"].replace(",", "")),
            np_max                   = int(request.form["np_max"].replace(",", "")),
            note                     = request.form.get("note", ""),
        ))
        db.session.commit()
        flash(f"{year}년 세율이 등록되었습니다.", "success")
        return redirect(url_for("tax_settings"))

    # GET: 직전 연도 값을 기본값으로 채움
    copy_year = request.args.get("copy_year", type=int)
    base_cfg  = (TaxConfig.query.filter_by(year=copy_year).first()
                 if copy_year else
                 TaxConfig.query.order_by(TaxConfig.year.desc()).first())

    return render_template("settings/tax_form.html",
                           action="new",
                           cfg=base_cfg,
                           prefill_year=(copy_year + 1) if copy_year else datetime.now().year)


@app.route("/settings/tax/<int:year>/edit", methods=["GET", "POST"])
def tax_settings_edit(year):
    cfg = TaxConfig.query.filter_by(year=year).first_or_404()
    if request.method == "POST":
        cfg.national_pension_rate     = float(request.form["national_pension_rate"])
        cfg.health_insurance_rate     = float(request.form["health_insurance_rate"])
        cfg.long_term_care_rate       = float(request.form["long_term_care_rate"])
        cfg.employment_insurance_rate = float(request.form["employment_insurance_rate"])
        cfg.np_min                    = int(request.form["np_min"].replace(",", ""))
        cfg.np_max                    = int(request.form["np_max"].replace(",", ""))
        cfg.note                      = request.form.get("note", "")
        cfg.updated_at                = datetime.utcnow()
        db.session.commit()
        flash(f"{year}년 세율이 저장되었습니다.", "success")
        return redirect(url_for("tax_settings"))

    return render_template("settings/tax_form.html", action="edit", cfg=cfg, prefill_year=year)


@app.route("/settings/tax/<int:year>/delete", methods=["POST"])
def tax_settings_delete(year):
    cfg = TaxConfig.query.filter_by(year=year).first_or_404()
    db.session.delete(cfg)
    db.session.commit()
    flash(f"{year}년 세율이 삭제되었습니다.", "success")
    return redirect(url_for("tax_settings"))


# ── Entry point ───────────────────────────────────────────────────────────────

with app.app_context():
    db.create_all()
    _seed_default_rates()

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
