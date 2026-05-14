"""
데모 데이터 시더.
    python seed_demo.py
기존 데이터를 모두 초기화하고 샘플 직원 + 이번 달 조정 항목을 삽입합니다.
"""

import os, sys
from datetime import datetime, date

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

from app import app, db, Employee, Adjustment, TaxConfig
from app import _seed_default_rates

EMPLOYEES = [
    dict(employee_id="EMP001", name="김민준", department="개발팀",   position="팀장",   annual_salary=78_000_000, dependents=3, hire_date=date(2018, 3, 2)),
    dict(employee_id="EMP002", name="이서연", department="개발팀",   position="대리",   annual_salary=48_000_000, dependents=1, hire_date=date(2021, 7, 1)),
    dict(employee_id="EMP003", name="박지훈", department="개발팀",   position="사원",   annual_salary=36_000_000, dependents=1, hire_date=date(2024, 2, 5)),
    dict(employee_id="EMP004", name="최수진", department="인사팀",   position="과장",   annual_salary=58_000_000, dependents=2, hire_date=date(2019, 9, 10)),
    dict(employee_id="EMP005", name="정도현", department="인사팀",   position="사원",   annual_salary=34_000_000, dependents=1, hire_date=date(2023, 4, 3)),
    dict(employee_id="EMP006", name="강예진", department="영업팀",   position="부장",   annual_salary=92_000_000, dependents=4, hire_date=date(2015, 1, 20)),
    dict(employee_id="EMP007", name="윤성호", department="영업팀",   position="대리",   annual_salary=46_000_000, dependents=2, hire_date=date(2020, 11, 16)),
    dict(employee_id="EMP008", name="임채원", department="재무팀",   position="과장",   annual_salary=62_000_000, dependents=3, hire_date=date(2017, 6, 1)),
    dict(employee_id="EMP009", name="오지민", department="재무팀",   position="사원",   annual_salary=38_000_000, dependents=1, hire_date=date(2023, 8, 21)),
    dict(employee_id="EMP010", name="신태양", department="경영지원팀", position="이사",  annual_salary=130_000_000, dependents=4, hire_date=date(2012, 5, 7)),
]

now  = datetime.now()
year = now.year
month= now.month

ADJUSTMENTS = [
    # 무급휴가
    dict(emp_code="EMP002", type="unpaid_leave",    value=1.0,        description="개인 사유"),
    dict(emp_code="EMP005", type="unpaid_leave",    value=0.5,        description="반차"),
    # 경조사비 (비과세)
    dict(emp_code="EMP001", type="condolence_pay",  value=300_000,    description="부모님 회갑"),
    dict(emp_code="EMP008", type="condolence_pay",  value=200_000,    description="배우자 상"),
    # 추가수당
    dict(emp_code="EMP003", type="extra_pay",       value=150_000,    description="야근수당"),
    dict(emp_code="EMP007", type="extra_pay",       value=500_000,    description="영업인센티브"),
    dict(emp_code="EMP010", type="extra_pay",       value=1_000_000,  description="성과급"),
    # 기타공제
    dict(emp_code="EMP009", type="other_deduction", value=50_000,     description="주차비"),
]


def run():
    with app.app_context():
        # 기존 데이터 초기화
        db.drop_all()
        db.create_all()
        _seed_default_rates()

        # 직원 삽입
        emp_map = {}
        for data in EMPLOYEES:
            emp = Employee(
                employee_id      = data["employee_id"],
                name             = data["name"],
                department       = data["department"],
                position         = data["position"],
                annual_salary    = data["annual_salary"],
                dependents       = data["dependents"],
                non_taxable_meal = 200_000,
                hire_date        = data["hire_date"],
            )
            db.session.add(emp)
            db.session.flush()
            emp_map[data["employee_id"]] = emp.id

        # 이번 달 조정 항목 삽입
        for adj in ADJUSTMENTS:
            db.session.add(Adjustment(
                employee_id = emp_map[adj["emp_code"]],
                year=year, month=month,
                type=adj["type"],
                value=adj["value"],
                description=adj["description"],
            ))

        db.session.commit()
        print(f"  ✓ 직원 {len(EMPLOYEES)}명 등록")
        print(f"  ✓ {year}년 {month}월 조정항목 {len(ADJUSTMENTS)}건 등록")
        print(f"  ✓ 2024년 기본 세율 등록")
        print()
        print("  완료! http://localhost:5000 에 접속하세요.")


if __name__ == "__main__":
    run()
