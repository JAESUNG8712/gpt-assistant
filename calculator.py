# 2024년 기준 사회보험 요율 및 급여 계산 로직

# ── 사회보험 요율 (근로자 부담분) ────────────────────────────────────────────
NATIONAL_PENSION_RATE      = 0.045    # 국민연금 4.5%
HEALTH_INSURANCE_RATE      = 0.03545  # 건강보험 3.545%
LONG_TERM_CARE_RATE        = 0.1295   # 장기요양보험 (건강보험료의 12.95%)
EMPLOYMENT_INSURANCE_RATE  = 0.009    # 고용보험 0.9%

# 국민연금 기준 소득월액 상·하한
NP_MIN = 370_000
NP_MAX = 5_900_000


def _floor10(value: float) -> int:
    """10원 단위 절사"""
    return (int(value) // 10) * 10


# ── 4대보험 ───────────────────────────────────────────────────────────────────

def calc_national_pension(monthly_pay: int) -> int:
    base = max(NP_MIN, min(NP_MAX, monthly_pay))
    return _floor10(base * NATIONAL_PENSION_RATE)


def calc_health_insurance(monthly_pay: int) -> int:
    return _floor10(monthly_pay * HEALTH_INSURANCE_RATE)


def calc_long_term_care(health_insurance: int) -> int:
    return _floor10(health_insurance * LONG_TERM_CARE_RATE)


def calc_employment_insurance(monthly_pay: int) -> int:
    return _floor10(monthly_pay * EMPLOYMENT_INSURANCE_RATE)


# ── 소득세 ────────────────────────────────────────────────────────────────────

def _earned_income_deduction(annual: int) -> int:
    """근로소득공제"""
    if annual <= 5_000_000:
        return int(annual * 0.70)
    if annual <= 15_000_000:
        return 3_500_000 + int((annual - 5_000_000) * 0.40)
    if annual <= 45_000_000:
        return 7_500_000 + int((annual - 15_000_000) * 0.15)
    if annual <= 100_000_000:
        return 12_000_000 + int((annual - 45_000_000) * 0.05)
    return 14_750_000


def _tax_credit(annual_tax: int, annual_income: int) -> int:
    """근로소득 세액공제"""
    if annual_tax <= 1_300_000:
        credit = int(annual_tax * 0.55)
    else:
        credit = 715_000 + int((annual_tax - 1_300_000) * 0.30)

    if annual_income <= 33_000_000:
        cap = 740_000
    elif annual_income <= 70_000_000:
        cap = max(660_000, 740_000 - int((annual_income - 33_000_000) * 0.008))
    else:
        cap = max(500_000, 660_000 - int((annual_income - 70_000_000) * 0.005))

    return min(credit, cap)


def _apply_tax_brackets(taxable: int) -> int:
    if taxable <= 14_000_000:
        return int(taxable * 0.06)
    if taxable <= 50_000_000:
        return int(taxable * 0.15) - 1_260_000
    if taxable <= 88_000_000:
        return int(taxable * 0.24) - 5_760_000
    if taxable <= 150_000_000:
        return int(taxable * 0.35) - 15_440_000
    if taxable <= 300_000_000:
        return int(taxable * 0.38) - 19_940_000
    if taxable <= 500_000_000:
        return int(taxable * 0.40) - 25_940_000
    if taxable <= 1_000_000_000:
        return int(taxable * 0.42) - 35_940_000
    return int(taxable * 0.45) - 65_940_000


def calc_income_tax(monthly_pay: int, dependents: int = 1, non_taxable: int = 200_000) -> int:
    """
    월 소득세 원천징수액 (간이세액표 공식 근사).
    dependents: 본인 포함 부양가족 수
    non_taxable: 비과세 식대 등 (기본 200,000원)
    """
    taxable_monthly = max(0, monthly_pay - non_taxable)
    annual_income = taxable_monthly * 12

    earned_deduction = _earned_income_deduction(annual_income)
    gross = annual_income - earned_deduction
    personal_deduction = 1_500_000 * max(1, dependents)
    taxable_income = max(0, gross - personal_deduction)

    annual_tax = max(0, _apply_tax_brackets(taxable_income))
    credit = _tax_credit(annual_tax, annual_income)
    annual_tax = max(0, annual_tax - credit)

    return _floor10(annual_tax / 12)


def calc_local_income_tax(income_tax: int) -> int:
    """지방소득세 = 소득세의 10%"""
    return _floor10(income_tax * 0.10)


# ── 무급휴가 차감 ──────────────────────────────────────────────────────────────

def calc_unpaid_leave(annual_salary: int, days: float) -> int:
    """일급 기준(월 21.75일) 무급휴가 차감액"""
    monthly = annual_salary / 12
    daily = monthly / 21.75
    return int(daily * days)


# ── 종합 급여 계산 ─────────────────────────────────────────────────────────────

def calculate_salary(employee: dict, adjustments: list | None = None) -> dict:
    """
    employee: {annual_salary, dependents, non_taxable_meal}
    adjustments: list of {type, value, description}
      type: 'unpaid_leave'(일수) | 'condolence_pay'(비과세) | 'extra_pay' | 'other_deduction'
    returns: 지급/공제 내역 전체 dict
    """
    annual_salary    = int(employee["annual_salary"])
    dependents       = int(employee.get("dependents", 1))
    non_taxable_meal = int(employee.get("non_taxable_meal", 200_000))

    monthly_base         = annual_salary // 12
    extra_pay            = 0   # 과세 추가수당
    condolence_pay       = 0   # 경조사비 (비과세)
    unpaid_leave_amount  = 0   # 무급휴가 차감
    other_deduction      = 0   # 기타 공제

    adj_details = []
    for adj in (adjustments or []):
        t, v = adj["type"], float(adj["value"])
        desc = adj.get("description", "")
        if t == "unpaid_leave":
            amt = calc_unpaid_leave(annual_salary, v)
            unpaid_leave_amount += amt
            adj_details.append({"label": f"무급휴가 ({v}일)", "amount": -amt, "description": desc})
        elif t == "condolence_pay":
            condolence_pay += int(v)
            adj_details.append({"label": "경조사비 (비과세)", "amount": int(v), "description": desc})
        elif t == "extra_pay":
            extra_pay += int(v)
            adj_details.append({"label": "추가수당", "amount": int(v), "description": desc})
        elif t == "other_deduction":
            other_deduction += int(v)
            adj_details.append({"label": "기타공제", "amount": -int(v), "description": desc})

    # 과세 급여 = 기본급 - 무급휴가차감 + 추가수당
    taxable_pay = monthly_base - unpaid_leave_amount + extra_pay
    # 총 지급액 = 과세급여 + 비과세 경조사비
    total_pay = taxable_pay + condolence_pay

    # 4대보험 (과세급여 기준)
    national_pension       = calc_national_pension(taxable_pay)
    health_insurance       = calc_health_insurance(taxable_pay)
    long_term_care         = calc_long_term_care(health_insurance)
    employment_insurance   = calc_employment_insurance(taxable_pay)

    # 원천세
    income_tax             = calc_income_tax(taxable_pay, dependents, non_taxable_meal)
    local_income_tax       = calc_local_income_tax(income_tax)

    total_insurance = national_pension + health_insurance + long_term_care + employment_insurance
    total_tax       = income_tax + local_income_tax
    total_deduction = total_insurance + total_tax + other_deduction

    net_pay = total_pay - total_deduction

    return {
        # 지급 항목
        "monthly_base":          monthly_base,
        "extra_pay":             extra_pay,
        "condolence_pay":        condolence_pay,
        "unpaid_leave_amount":   unpaid_leave_amount,
        "total_pay":             total_pay,
        # 공제 항목
        "national_pension":      national_pension,
        "health_insurance":      health_insurance,
        "long_term_care":        long_term_care,
        "employment_insurance":  employment_insurance,
        "total_insurance":       total_insurance,
        "income_tax":            income_tax,
        "local_income_tax":      local_income_tax,
        "total_tax":             total_tax,
        "other_deduction":       other_deduction,
        "total_deduction":       total_deduction,
        # 실수령액
        "net_pay":               net_pay,
        # 조정 내역
        "adj_details":           adj_details,
    }
