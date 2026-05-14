# 급여 계산 로직 - 모든 세율은 호출 측에서 rates dict로 주입

# ── 기본 세율 (DB에 데이터가 없을 때 사용하는 폴백) ──────────────────────────
DEFAULT_RATES = {
    # 4대보험 (근로자 부담 %)
    "national_pension_rate":     4.5,      # 국민연금
    "health_insurance_rate":     3.545,    # 건강보험
    "long_term_care_rate":       12.95,    # 장기요양보험 (건강보험료 대비 %)
    "employment_insurance_rate": 0.9,      # 고용보험
    # 국민연금 기준소득월액 상·하한 (원)
    "np_min": 370_000,
    "np_max": 5_900_000,
}

# ── 소득세 누진세율 테이블 (2024년 기준) ─────────────────────────────────────
# (과세표준 상한, 세율, 누진공제액)  상한 None = 초과분 전체
INCOME_TAX_BRACKETS = [
    (14_000_000,   0.06,          0),
    (50_000_000,   0.15,  1_260_000),
    (88_000_000,   0.24,  5_760_000),
    (150_000_000,  0.35, 15_440_000),
    (300_000_000,  0.38, 19_940_000),
    (500_000_000,  0.40, 25_940_000),
    (1_000_000_000,0.42, 35_940_000),
    (None,         0.45, 65_940_000),
]


def _floor10(value: float) -> int:
    """10원 단위 절사"""
    return (int(value) // 10) * 10


def _r(rates: dict | None, key: str):
    """rates dict에서 값을 꺼내되 없으면 DEFAULT_RATES 폴백"""
    v = (rates or {}).get(key)
    return v if v is not None else DEFAULT_RATES[key]


# ── 4대보험 ───────────────────────────────────────────────────────────────────

def calc_national_pension(monthly_pay: int, rates: dict | None = None) -> int:
    np_min = int(_r(rates, "np_min"))
    np_max = int(_r(rates, "np_max"))
    rate   = float(_r(rates, "national_pension_rate")) / 100
    base   = max(np_min, min(np_max, monthly_pay))
    return _floor10(base * rate)


def calc_health_insurance(monthly_pay: int, rates: dict | None = None) -> int:
    rate = float(_r(rates, "health_insurance_rate")) / 100
    return _floor10(monthly_pay * rate)


def calc_long_term_care(health_insurance: int, rates: dict | None = None) -> int:
    rate = float(_r(rates, "long_term_care_rate")) / 100
    return _floor10(health_insurance * rate)


def calc_employment_insurance(monthly_pay: int, rates: dict | None = None) -> int:
    rate = float(_r(rates, "employment_insurance_rate")) / 100
    return _floor10(monthly_pay * rate)


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
    credit = int(annual_tax * 0.55) if annual_tax <= 1_300_000 \
             else 715_000 + int((annual_tax - 1_300_000) * 0.30)
    if annual_income <= 33_000_000:
        cap = 740_000
    elif annual_income <= 70_000_000:
        cap = max(660_000, 740_000 - int((annual_income - 33_000_000) * 0.008))
    else:
        cap = max(500_000, 660_000 - int((annual_income - 70_000_000) * 0.005))
    return min(credit, cap)


def _apply_tax_brackets(taxable: int) -> int:
    for upper, rate, deduction in INCOME_TAX_BRACKETS:
        if upper is None or taxable <= upper:
            return int(taxable * rate) - deduction
    return 0


def calc_income_tax(monthly_pay: int, dependents: int = 1,
                    non_taxable: int = 200_000) -> int:
    """월 소득세 원천징수액 (간이세액표 공식 근사)"""
    taxable_monthly = max(0, monthly_pay - non_taxable)
    annual_income   = taxable_monthly * 12

    earned_deduction = _earned_income_deduction(annual_income)
    gross            = annual_income - earned_deduction
    personal_ded     = 1_500_000 * max(1, dependents)
    taxable_income   = max(0, gross - personal_ded)

    annual_tax = max(0, _apply_tax_brackets(taxable_income))
    credit     = _tax_credit(annual_tax, annual_income)
    annual_tax = max(0, annual_tax - credit)

    return _floor10(annual_tax / 12)


def calc_local_income_tax(income_tax: int) -> int:
    """지방소득세 = 소득세의 10%"""
    return _floor10(income_tax * 0.10)


# ── 무급휴가 차감 ──────────────────────────────────────────────────────────────

def calc_unpaid_leave(annual_salary: int, days: float) -> int:
    """일급 기준(월 21.75일) 무급휴가 차감액"""
    return int((annual_salary / 12 / 21.75) * days)


# ── 종합 급여 계산 ─────────────────────────────────────────────────────────────

def calculate_salary(employee: dict,
                     adjustments: list | None = None,
                     rates: dict | None = None) -> dict:
    """
    employee : {annual_salary, dependents, non_taxable_meal}
    adjustments : [{type, value, description}, ...]
      type: 'unpaid_leave'(일수) | 'condolence_pay'(비과세) | 'extra_pay' | 'other_deduction'
    rates : TaxConfig에서 가져온 연도별 세율 dict (None이면 DEFAULT_RATES 사용)
    """
    annual_salary    = int(employee["annual_salary"])
    dependents       = int(employee.get("dependents", 1))
    non_taxable_meal = int(employee.get("non_taxable_meal", 200_000))

    monthly_base         = annual_salary // 12
    extra_pay            = 0
    condolence_pay       = 0
    unpaid_leave_amount  = 0
    other_deduction      = 0

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

    taxable_pay = monthly_base - unpaid_leave_amount + extra_pay
    total_pay   = taxable_pay + condolence_pay

    national_pension     = calc_national_pension(taxable_pay, rates)
    health_insurance     = calc_health_insurance(taxable_pay, rates)
    long_term_care       = calc_long_term_care(health_insurance, rates)
    employment_insurance = calc_employment_insurance(taxable_pay, rates)

    income_tax           = calc_income_tax(taxable_pay, dependents, non_taxable_meal)
    local_income_tax     = calc_local_income_tax(income_tax)

    total_insurance = national_pension + health_insurance + long_term_care + employment_insurance
    total_tax       = income_tax + local_income_tax
    total_deduction = total_insurance + total_tax + other_deduction
    net_pay         = total_pay - total_deduction

    return {
        "monthly_base":          monthly_base,
        "extra_pay":             extra_pay,
        "condolence_pay":        condolence_pay,
        "unpaid_leave_amount":   unpaid_leave_amount,
        "total_pay":             total_pay,
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
        "net_pay":               net_pay,
        "adj_details":           adj_details,
    }
