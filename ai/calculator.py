"""
HR 날짜·금액 기반 계산기 — Python 직접 계산 (LLM 불필요)
· 연차 계산         · 급여 실수령액      · 퇴직금
· 연장/야간/휴일수당  · 주휴수당          · 최저임금 위반 체크
"""
import re
from datetime import date
from typing import Optional

# ══════════════════════════════════════════════════════
#  1. 파싱 유틸리티
# ══════════════════════════════════════════════════════

def _parse_date(text: str) -> Optional[date]:
    """한국어/숫자 날짜 표현 → date 객체"""
    text = text.replace(' ', '')
    # "24년 8월 17일" / "2024년 8월 17일"
    m = re.search(r'(\d{2,4})년\s*(\d{1,2})월\s*(\d{1,2})일', text)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100: y += 2000
        try: return date(y, mo, d)
        except ValueError: pass
    # "24년 8월" (일 없음 → 1일)
    m = re.search(r'(\d{2,4})년\s*(\d{1,2})월', text)
    if m:
        y, mo = int(m.group(1)), int(m.group(2))
        if y < 100: y += 2000
        try: return date(y, mo, 1)
        except ValueError: pass
    # "2024.08.17"
    m = re.search(r'(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})', text)
    if m:
        try: return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError: pass
    # "24.8.17"
    m = re.search(r'(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})', text)
    if m:
        try: return date(2000+int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError: pass
    return None


_DATE_PATTERNS = [
    r'(\d{2,4})년\s*(\d{1,2})월\s*(\d{1,2})일',       # 24년 8월 17일
    r'(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})',          # 2024.08.17
    r'(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})',          # 24.8.17
    r'(\d{2,4})년\s*(\d{1,2})월',                       # 24년 8월 (일 없음 → 1일)
]


def _parse_all_dates(text: str) -> list:
    """질문 속 모든 날짜를 등장 순서대로 (시작위치, 끝위치, date) 목록으로 반환.
    구체적 패턴(년월일)을 먼저 매치해 부분 패턴(년월)과의 중복을 방지."""
    found = []  # (start, end, date)
    for pi, pattern in enumerate(_DATE_PATTERNS):
        for m in re.finditer(pattern, text):
            # 이미 매치된 구간과 겹치면 스킵 (년월일 매치가 년월 재매치되는 것 차단)
            if any(s < m.end() and m.start() < e for s, e, _ in found):
                continue
            g = m.groups()
            y = int(g[0])
            if y < 100:
                y += 2000
            mo = int(g[1])
            d = int(g[2]) if len(g) >= 3 and g[2] is not None else 1
            if pi == 3:  # 년월 패턴은 그룹이 2개
                d = 1
            try:
                found.append((m.start(), m.end(), date(y, mo, d)))
            except ValueError:
                continue
    found.sort(key=lambda t: t[0])
    return found


def _parse_amount(text: str) -> Optional[int]:
    """
    금액 표현 → 정수(원)
    지원: '300만원', '4800만', '1억2천만', '3.5억', '12000', '12,000원'
    """
    text = text.replace(',', '').replace(' ', '')
    # 억+천만 (예: '1억2천만')
    m = re.search(r'(\d+(?:\.\d+)?)억\s*(\d+(?:\.\d+)?)천만', text)
    if m:
        return int(float(m.group(1)) * 1e8 + float(m.group(2)) * 1e7)
    # 억+만
    m = re.search(r'(\d+(?:\.\d+)?)억\s*(\d+(?:\.\d+)?)만', text)
    if m:
        return int(float(m.group(1)) * 1e8 + float(m.group(2)) * 1e4)
    # 억+천 (만 생략 구어체, 예: '1억5천' == '1억5천만원')
    m = re.search(r'(\d+(?:\.\d+)?)억\s*(\d+(?:\.\d+)?)천(?!\d)', text)
    if m:
        return int(float(m.group(1)) * 1e8 + float(m.group(2)) * 1e7)
    # 억
    m = re.search(r'(\d+(?:\.\d+)?)억', text)
    if m:
        return int(float(m.group(1)) * 1e8)
    # 천만
    m = re.search(r'(\d+(?:\.\d+)?)천만', text)
    if m:
        return int(float(m.group(1)) * 1e7)
    # 만
    m = re.search(r'(\d+(?:\.\d+)?)만', text)
    if m:
        return int(float(m.group(1)) * 1e4)
    # 천
    m = re.search(r'(\d+(?:\.\d+)?)천', text)
    if m:
        return int(float(m.group(1)) * 1e3)
    # 순수 숫자 (4자리 이상) — 단, 날짜 표현("2024년" 등)의 숫자는 금액이 아니므로 제외
    for m in re.finditer(r'(\d{4,})', text):
        nxt = text[m.end():m.end() + 1]
        if nxt in ('년', '월', '일'):
            continue
        return int(m.group(1))
    return None


def _parse_hours(text: str, keywords: list) -> Optional[float]:
    """'연장 10시간', '야간 3시간' 등에서 시간 추출"""
    for kw in keywords:
        m = re.search(rf'{kw}\s*(\d+(?:\.\d+)?)\s*시간', text)
        if m:
            return float(m.group(1))
        m = re.search(rf'(\d+(?:\.\d+)?)\s*시간\s*{kw}', text)
        if m:
            return float(m.group(1))
    return None


def _fmt(n: int) -> str:
    """숫자를 3자리 콤마 + 만원 단위 병기로 포맷"""
    if n >= 10_000:
        man = n // 10_000
        rem = n % 10_000
        if rem:
            return f"{man}만 {rem:,}원 ({n:,}원)"
        return f"{man:,}만원 ({n:,}원)"
    return f"{n:,}원"


# ══════════════════════════════════════════════════════
#  2. 연차 계산
# ══════════════════════════════════════════════════════

_ANNUAL_LEAVE_KEYWORDS = [
    '연차', '유급휴가', '연월차', '휴가 며칠', '휴가 몇 일', '휴가 갯수',
    '연차 몇', '연차 갯수', '연차 개수', '휴가 개수', '연차일수',
    '연차 총', '총 연차', '연차 발생', '누적 연차',
]
_JOIN_KEYWORDS = ['입사', '입사일', '시작', '취업', '입산']


# ── 기간별 연차 누적 계산 ─────────────────────────────────────────

def _calc_leaves_in_period(join_date: date, end_date: date) -> list:
    """입사일부터 end_date까지 발생하는 모든 연차 반환.
    Returns: list of (grant_date, days, gtype)
             gtype: 'monthly' | '1년차' | '2년차' | ...
    """
    import calendar as _cal
    grants = []

    # 1년 미만 월별 연차 (month 1 ~ 11)
    for mo_offset in range(1, 12):
        mo = join_date.month + mo_offset
        yr = join_date.year
        while mo > 12:
            mo -= 12; yr += 1
        try:
            gd = date(yr, mo, join_date.day)
        except ValueError:
            gd = date(yr, mo, _cal.monthrange(yr, mo)[1])
        if gd > end_date:
            break
        grants.append((gd, 1, 'monthly'))

    # 1년 이상 연차 (year_offset = 1, 2, 3, ...)
    for yr_offset in range(1, 50):
        try:
            gd = date(join_date.year + yr_offset, join_date.month, join_date.day)
        except ValueError:
            import calendar as _cal2
            gd = date(join_date.year + yr_offset, join_date.month,
                      _cal2.monthrange(join_date.year + yr_offset, join_date.month)[1])
        if gd > end_date:
            break
        days = min(15 + (yr_offset - 1) // 2, 25)
        grants.append((gd, days, f'{yr_offset}년차'))

    return grants


def try_annual_leave_period_calc(text: str) -> Optional[str]:
    """기간별 연차 발생 총계 계산.
    Handles: "26년 1월 입사자, 26년부터 27년까지 연차 총 갯수"
    """
    tl = text.lower()

    # 연차 관련 키워드 필수
    if not any(kw in tl for kw in _ANNUAL_LEAVE_KEYWORDS):
        return None

    # 기간 패턴 감지 (단순 연차 조회와 구분)
    has_range = bool(re.search(r'\d{2,4}년.{0,6}부터.{0,10}\d{2,4}년.{0,6}까지', tl))
    has_until = bool(re.search(r'\d{2,4}년.{0,6}까지', tl)) and any(k in tl for k in _JOIN_KEYWORDS)
    has_total = ('총' in tl or '합계' in tl or '누적' in tl) and bool(re.search(r'\d{2,4}년', tl))
    if not (has_range or has_until or has_total):
        return None

    # 입사일
    join_date = _parse_date(text)
    if not join_date:
        return None

    # 모든 연도 추출 → from_year / to_year 결정
    years = sorted({
        (2000 + int(m.group(1))) if int(m.group(1)) < 100 else int(m.group(1))
        for m in re.finditer(r'(\d{2,4})년', text)
        if 2020 <= ((2000 + int(m.group(1))) if int(m.group(1)) < 100 else int(m.group(1))) <= 2060
    })
    if len(years) < 2:
        return None

    from_year = min(years)
    to_year   = max(years)
    if to_year < join_date.year:
        return None

    grants = _calc_leaves_in_period(join_date, date(to_year, 12, 31))
    if not grants:
        return None

    # 연도별 그룹핑
    by_year: dict = {}
    for gd, days, gtype in grants:
        yr = gd.year
        if yr not in by_year:
            by_year[yr] = {'monthly': 0, 'annual': []}
        if gtype == 'monthly':
            by_year[yr]['monthly'] += 1
        else:
            by_year[yr]['annual'].append((gd, days, gtype))

    rows = []
    grand_total = 0
    for yr in sorted(by_year.keys()):
        parts, yr_total = [], 0

        m_cnt = by_year[yr]['monthly']
        if m_cnt:
            parts.append(f"월 연차 1일×{m_cnt}개월")
            yr_total += m_cnt

        for gd, days, gtype in by_year[yr]['annual']:
            yr_num = int(gtype.replace('년차', ''))
            extra = (yr_num - 1) // 2
            desc = f"15+{extra}일" if extra else "15일"
            parts.append(f"{gtype} {desc} ({gd.strftime('%m.%d')} 발생)")
            yr_total += days

        grand_total += yr_total
        rows.append(f"| {yr}년 | {' + '.join(parts)} | **{yr_total}일** |")

    table = "\n".join(rows)

    return (
        f"## 연차 발생 현황 ({from_year}~{to_year}년)\n\n"
        f"| 항목 | 내용 |\n|------|------|\n"
        f"| 입사일 | {join_date.strftime('%Y년 %m월 %d일')} |\n"
        f"| 조회 기간 | {from_year}년 ~ {to_year}년 |\n\n"
        f"### 연도별 연차 발생\n"
        f"| 연도 | 발생 내역 | 합계 |\n|------|-----------|------|\n"
        f"{table}\n\n"
        f"### 총 발생 연차: **{grand_total}일**\n\n"
        f"> 근로기준법 제60조 기준\n"
        f"> 1년 미만: 월 1일 (최대 11일) / 1년 이상: 15일 기본, 3년차부터 2년마다 1일 추가 (최대 25일)"
    )




def _calc_annual_leave_result(join_date: date, today: date) -> dict:
    """연차 계산 핵심 로직"""
    years_full = 0
    temp = join_date
    while True:
        try:
            next_y = date(temp.year + 1, temp.month, temp.day)
        except ValueError:
            import calendar
            last_d = calendar.monthrange(temp.year + 1, temp.month)[1]
            next_y = date(temp.year + 1, temp.month, last_d)
        if next_y > today:
            break
        years_full += 1
        temp = next_y

    months_full = 0
    temp2 = join_date
    while True:
        mo = temp2.month + 1
        yr = temp2.year + (1 if mo > 12 else 0)
        mo = mo if mo <= 12 else mo - 12
        try:
            nm = date(yr, mo, temp2.day)
        except ValueError:
            import calendar
            last_d = calendar.monthrange(yr, mo)[1]
            nm = date(yr, mo, last_d)
        if nm > today:
            break
        months_full += 1
        temp2 = nm

    if years_full == 0:
        avail = min(months_full, 11)
        leave_type = "1년 미만"
        calc_note = f"매월 1일 발생 → {months_full}개월 경과 = **{avail}일**"
    else:
        avail = min(15 + (years_full - 1) // 2, 25)
        leave_type = f"{years_full}년차"
        extra = (years_full - 1) // 2
        if extra:
            calc_note = f"15일 + 가산 {extra}일 = **{avail}일**"
        else:
            calc_note = f"기본 **{avail}일**"

    # 다음 발생일
    if years_full == 0:
        mo = join_date.month + months_full + 1
        yr = join_date.year
        while mo > 12:
            mo -= 12; yr += 1
        try:
            next_date = date(yr, mo, join_date.day)
        except ValueError:
            import calendar
            next_date = date(yr, mo, calendar.monthrange(yr, mo)[1])
        next_days = 1
    else:
        ny = years_full + 1
        try:
            next_date = date(join_date.year + ny, join_date.month, join_date.day)
        except ValueError:
            import calendar
            next_date = date(join_date.year + ny, join_date.month,
                             calendar.monthrange(join_date.year + ny, join_date.month)[1])
        next_days = min(15 + (ny - 1) // 2, 25)

    em = months_full - years_full * 12 if years_full else months_full
    tenure = (f"{years_full}년 " if years_full else "") + (f"{em}개월" if em else "")
    return {
        "avail": avail,
        "leave_type": leave_type,
        "calc_note": calc_note,
        "next_date": next_date,
        "next_days": next_days,
        "tenure": tenure.strip() or "1개월 미만",
    }


def try_annual_leave_calc(text: str) -> Optional[str]:
    """연차 계산 (날짜 포함 질문 감지 시).
    질문에 날짜가 2개 이상이면 입사일 외의 날짜를 기준일로 사용
    (예: "24년 1월 1일 입사자는 26년 1월 1일에 몇 개?" → 기준일 2026-01-01)."""
    tl = text.lower()
    if not any(kw in tl for kw in _ANNUAL_LEAVE_KEYWORDS):
        return None
    if not (_parse_date(text) or any(kw in tl for kw in _JOIN_KEYWORDS)):
        return None

    dates = _parse_all_dates(text)
    if not dates:
        return None

    today = date.today()
    explicit_asof = False

    if len(dates) == 1:
        join_date = dates[0][2]
        as_of = today
    else:
        # '입사' 키워드에 인접(앞 8자/뒤 6자)한 날짜를 입사일로 판별
        join_idx = None
        for i, (s, e, d) in enumerate(dates):
            near = text[max(0, s - 8):s] + text[e:e + 6]
            if any(kw in near for kw in _JOIN_KEYWORDS):
                join_idx = i
                break
        if join_idx is None:
            # 인접 키워드 없으면 가장 이른 날짜를 입사일로 간주
            join_idx = min(range(len(dates)), key=lambda i: dates[i][2])
        join_date = dates[join_idx][2]
        as_of = max(d for i, (s, e, d) in enumerate(dates) if i != join_idx)
        explicit_asof = True

    if explicit_asof and as_of < join_date:
        return (
            f"⚠️ 기준일({as_of.strftime('%Y.%m.%d')})이 "
            f"입사일({join_date.strftime('%Y.%m.%d')})보다 앞섭니다. 날짜를 확인해주세요."
        )
    if not explicit_asof and join_date > today:
        return f"입사 예정일({join_date.strftime('%Y.%m.%d')})이 오늘보다 미래입니다."

    asof_label = "질문에 명시된 시점" if explicit_asof else "오늘"
    r = _calc_annual_leave_result(join_date, as_of)
    return (
        f"## 연차 유급휴가 계산 결과\n\n"
        f"| 항목 | 내용 |\n|------|------|\n"
        f"| 입사일 | {join_date.strftime('%Y년 %m월 %d일')} |\n"
        f"| 기준일 | {as_of.strftime('%Y년 %m월 %d일')} ({asof_label}) |\n"
        f"| 근속기간 | {r['tenure']} ({r['leave_type']}) |\n"
        f"| **사용 가능 연차** | **{r['avail']}일** |\n"
        f"| 계산 근거 | {r['calc_note']} |\n"
        f"| 다음 연차 발생 | {r['next_date'].strftime('%Y년 %m월 %d일')} ({r['next_days']}일 예정) |\n\n"
        f"> 근로기준법 제60조 기준 (법정 최저 기준)."
    )


def detect_annual_leave_query(text: str) -> bool:
    tl = text.lower()
    return (any(kw in tl for kw in _ANNUAL_LEAVE_KEYWORDS)
            and (bool(_parse_date(text)) or any(kw in tl for kw in _JOIN_KEYWORDS)))


# ══════════════════════════════════════════════════════
#  3. 급여 실수령액 계산
# ══════════════════════════════════════════════════════

_SALARY_KEYWORDS = [
    '실수령액', '실수령', '실급여', '세후', '손에 쥐는', '공제', '실제 받는',
    '4대보험 얼마', '보험료 얼마', '월급 공제', '월급에서 빠지는',
    '공제금액', '실질임금', '실질급여',
]
_SALARY_AMT_KEYWORDS = ['월급', '연봉', '월 급여', '급여', '임금']


def _calc_net_salary(monthly: int, deps: int = 1) -> dict:
    """4대보험 + 소득세 공제 후 실수령액 계산 (2026년 기준)"""
    # 4대보험 상·하한 적용
    pension_base = min(max(monthly, 370_000), 5_900_000)
    pension      = int(pension_base * 0.0475)
    health       = int(monthly * 0.03595)
    ltcare       = int(health * 0.1314)
    employment   = int(monthly * 0.009)

    # 근로소득세 (간이세액표 공식)
    annual = monthly * 12
    if annual <= 5_000_000:
        ded = annual * 0.70
    elif annual <= 15_000_000:
        ded = 3_500_000 + (annual - 5_000_000) * 0.40
    elif annual <= 45_000_000:
        ded = 7_500_000 + (annual - 15_000_000) * 0.15
    elif annual <= 100_000_000:
        ded = 12_000_000 + (annual - 45_000_000) * 0.05
    else:
        ded = 14_750_000 + (annual - 100_000_000) * 0.02
    ded = min(ded, 20_000_000)

    taxable = max(0, annual - ded - 1_500_000 * deps)
    BRACKETS = [
        (14_000_000,  0.06,       0),
        (50_000_000,  0.15, 1_260_000),
        (88_000_000,  0.24, 5_760_000),
        (150_000_000, 0.35, 15_440_000),
        (300_000_000, 0.38, 19_940_000),
        (500_000_000, 0.40, 25_940_000),
        (float('inf'),0.42, 35_940_000),
    ]
    gross_tax = 0
    for thr, rate, prog in BRACKETS:
        if taxable <= thr:
            gross_tax = max(0, taxable * rate - prog)
            break

    if gross_tax <= 1_300_000:
        credit = gross_tax * 0.55
    else:
        credit = 715_000 + (gross_tax - 1_300_000) * 0.30
    if annual <= 33_000_000:
        clim = 740_000
    elif annual <= 70_000_000:
        clim = max(660_000, 740_000 - (annual - 33_000_000) * 8 / 1000)
    else:
        clim = max(500_000, 660_000 - (annual - 70_000_000) * 0.5)
    credit = min(credit, clim)

    income_tax = max(0, int((gross_tax - credit) / 12))
    local_tax  = int(income_tax * 0.1)

    total_ded = pension + health + ltcare + employment + income_tax + local_tax
    net = monthly - total_ded

    return {
        "monthly": monthly,
        "pension": pension,
        "health": health,
        "ltcare": ltcare,
        "employment": employment,
        "income_tax": income_tax,
        "local_tax": local_tax,
        "total_ded": total_ded,
        "net": net,
    }


def try_salary_calc(text: str) -> Optional[str]:
    """급여 실수령액 계산"""
    tl = text.lower()
    if not any(kw in tl for kw in _SALARY_KEYWORDS):
        return None

    # 금액 추출 (연봉→월급 환산)
    monthly = None
    if '연봉' in tl:
        amt = _parse_amount(re.sub(r'연봉', '', text, count=1))
        if amt:
            monthly = amt // 12
    if monthly is None:
        for kw in _SALARY_AMT_KEYWORDS:
            if kw in tl:
                amt = _parse_amount(re.sub(kw, '', text, count=1))
                if amt and amt >= 100_000:
                    monthly = amt
                    break
    if monthly is None:
        amt = _parse_amount(text)
        if amt and 500_000 <= amt <= 50_000_000:
            monthly = amt

    if not monthly:
        return None
    if monthly < 600_000 or monthly > 100_000_000:
        return None

    # 부양가족 수 추출 (기본 1명 = 본인)
    deps = 1
    m = re.search(r'부양가족\s*(\d+)', text)
    if m:
        deps = max(1, int(m.group(1)) + 1)  # 본인 포함
    m = re.search(r'(\d+)인\s*가족', text)
    if m:
        deps = max(1, int(m.group(1)))

    r = _calc_net_salary(monthly, deps)
    annual_label = f"(연봉 환산: {r['monthly']*12:,}원)" if '연봉' in tl else ""

    return (
        f"## 급여 실수령액 계산 (2026년 요율 기준)\n\n"
        f"**월 급여**: {monthly:,}원 {annual_label}\n"
        f"**부양가족**: {deps}명\n\n"
        f"### 공제 항목\n"
        f"| 항목 | 금액 | 비율 |\n|------|------|------|\n"
        f"| 국민연금 (4.75%) | {r['pension']:,}원 | |\n"
        f"| 건강보험 (3.595%) | {r['health']:,}원 | |\n"
        f"| 장기요양보험 (13.14%) | {r['ltcare']:,}원 | 건강보험료 기준 |\n"
        f"| 고용보험 (0.9%) | {r['employment']:,}원 | |\n"
        f"| 근로소득세 | {r['income_tax']:,}원 | 간이세액표 기준 |\n"
        f"| 지방소득세 (10%) | {r['local_tax']:,}원 | |\n"
        f"| **합계 공제** | **{r['total_ded']:,}원** | {r['total_ded']/monthly*100:.1f}% |\n\n"
        f"### 결과\n"
        f"**실수령액: {r['net']:,}원** "
        f"({r['net']//10000:,}만 {r['net']%10000:,}원)\n\n"
        f"> 2026년 4대보험 요율·간이세액표 기준 — 이후 연도 요율 변경 시 실제 금액과 차이가 있을 수 있습니다.\n"
        f"> 실제 공제액은 부양가족 수, 비과세 항목(식대 20만, 자가운전보조금 20만 등)에 따라 다를 수 있습니다.\n"
        f"> 정확한 계산: 국세청 홈택스 → 근로소득 간이세액표"
    )


# ══════════════════════════════════════════════════════
#  4. 퇴직금 계산
# ══════════════════════════════════════════════════════

_RETIREMENT_KEYWORDS = [
    '퇴직금', '퇴직급여', '퇴직연금', '퇴직 시 받는', '퇴직금 계산',
    '퇴직금 얼마', '퇴직 얼마', '나올 퇴직금',
]


def try_retirement_calc(text: str) -> Optional[str]:
    """퇴직금 계산 (입사일+퇴직일+월급, 또는 근속기간+월급)"""
    tl = text.lower()
    # 방법 1: '퇴직금', '퇴직연금' 등 명시
    has_kw = any(kw in tl for kw in _RETIREMENT_KEYWORDS)
    # 방법 2: '입사' + '퇴직' + 금액 조합 (퇴직금 계산 의도 추론)
    has_combo = ('입사' in tl or '입산' in tl) and '퇴직' in tl
    if not (has_kw or has_combo):
        return None

    today = date.today()

    # 날짜 두 개 추출 (입사일, 퇴직일)
    dates_found = []
    temp = text
    for _ in range(3):
        d = _parse_date(temp)
        if not d:
            break
        dates_found.append(d)
        # 찾은 날짜 제거해 다음 날짜 파싱
        m = re.search(r'\d{2,4}년\s*\d{1,2}월(?:\s*\d{1,2}일)?|\d{2,4}[.\-/]\d{1,2}[.\-/]\d{1,2}', temp)
        if m:
            temp = temp[m.end():]
        else:
            break

    join_date = end_date = None
    if len(dates_found) >= 2:
        join_date, end_date = sorted(dates_found[:2])
    elif len(dates_found) == 1:
        # 퇴직 키워드 없으면 오늘 퇴직 가정
        join_date = dates_found[0]
        end_date = today

    # 근속기간만 명시된 경우 ("3년 근무", "2년 6개월", "6개월")
    total_days = None
    if join_date and end_date:
        total_days = (end_date - join_date).days
    else:
        # "X년 Y개월 근무"
        m = re.search(r'(\d+)년\s*(\d+)개월', tl)
        if m:
            y, mo = int(m.group(1)), int(m.group(2))
            total_days = y * 365 + mo * 30
        else:
            m = re.search(r'(\d+)년\s*(?:근무|일)', tl)
            if m:
                total_days = int(m.group(1)) * 365
            else:
                # "X개월 근무" (1년 미만)
                m = re.search(r'(\d+)개월\s*(?:근무|일)?', tl)
                if m:
                    total_days = int(m.group(1)) * 30
                # "1년 미만" 특수 처리
                elif '1년 미만' in tl or '1년미만' in tl:
                    return (
                        "## 퇴직금 계산 결과\n\n"
                        "⚠️ **퇴직금 수급 불가**: 퇴직금은 계속 근로기간 **1년 이상**인 경우에만 발생합니다.\n\n"
                        "1년(365일) 미만 근무 시 퇴직금이 발생하지 않습니다."
                    )

    if not total_days or total_days < 365:
        if total_days is not None and total_days < 365:
            return (
                "## 퇴직금 계산 결과\n\n"
                "⚠️ **퇴직금 수급 불가**: 퇴직금은 계속 근로기간 **1년 이상**인 경우에만 발생합니다.\n\n"
                f"현재 근속기간: {total_days}일 ({total_days/30:.1f}개월)\n"
                "1년(365일) 미만은 퇴직금 없음."
            )
        return None

    # 월 평균임금 추출
    avg_monthly = None
    for kw in ['평균임금', '월급', '월 급여', '급여', '임금']:
        if kw in tl:
            amt = _parse_amount(re.sub(kw, '', text, count=1))
            if amt and amt >= 500_000:
                avg_monthly = amt
                break
    if avg_monthly is None:
        amt = _parse_amount(text)
        if amt and 500_000 <= amt <= 50_000_000:
            avg_monthly = amt

    if not avg_monthly:
        return None

    # 퇴직금 계산
    avg_daily = avg_monthly * 3 / 91  # 3개월 ÷ 91일
    severance = avg_daily * 30 * (total_days / 365)
    severance = int(severance)

    years = total_days // 365
    months = (total_days % 365) // 30
    tenure = f"{years}년 {months}개월" if months else f"{years}년"

    date_info = ""
    if join_date and end_date:
        date_info = (
            f"| 입사일 | {join_date.strftime('%Y년 %m월 %d일')} |\n"
            f"| 퇴직일 | {end_date.strftime('%Y년 %m월 %d일')} |\n"
        )

    return (
        f"## 퇴직금 계산 결과 (퇴직급여보장법)\n\n"
        f"| 항목 | 내용 |\n|------|------|\n"
        f"{date_info}"
        f"| 근속기간 | {tenure} ({total_days:,}일) |\n"
        f"| 월 평균임금 | {avg_monthly:,}원 |\n"
        f"| 1일 평균임금 | {int(avg_daily):,}원 |\n\n"
        f"### 계산식\n"
        f"```\n"
        f"퇴직금 = 1일 평균임금 × 30일 × (재직일수 ÷ 365)\n"
        f"       = {int(avg_daily):,} × 30 × ({total_days:,} ÷ 365)\n"
        f"       = {severance:,}원\n"
        f"```\n\n"
        f"### **퇴직금: {_fmt(severance)}**\n\n"
        f"| 항목 | 내용 |\n|------|------|\n"
        f"| 지급 기한 | 퇴직 후 14일 이내 |\n"
        f"| IRP 이전 | 300만원 초과 시 IRP 계좌 이전 의무 |\n"
        f"| 소득세 | 퇴직소득세 부과 (분류과세, 연분연승법) |\n\n"
        f"> 상여금 포함 시 실제 퇴직금은 달라질 수 있습니다. (3개월 상여 포함 계산 권장)"
    )


# ══════════════════════════════════════════════════════
#  5. 연장·야간·휴일 수당 계산
# ══════════════════════════════════════════════════════

_OT_KEYWORDS = [
    '연장수당', '야간수당', '휴일수당', '시간외수당', 'ot 수당', 'ot수당',
    '연장근로 수당', '야간근로 수당', '휴일근로 수당', '가산수당',
    '야근수당', '초과근무수당', '연장근로수당', '야간근로수당',
]
_OT_WORK_TYPES = ['연장', '야간', '야근', '휴일', '주말', '공휴일', '초과', 'ot']
_OT_PAY_WORDS  = ['수당', '얼마', '계산', '임금', '받는']


def try_overtime_calc(text: str) -> Optional[str]:
    """연장·야간·휴일 가산임금 계산"""
    tl = text.lower()
    # 방법 1: 복합 키워드 (연장수당, 야근수당 등)
    # 방법 2: 근로 유형 키워드 + 수당/시간 조합 (연장 10시간 수당)
    has_kw = any(kw in tl for kw in _OT_KEYWORDS)
    # 근로유형 + (수당/얼마/시간) + (시급/월급) 조합
    has_combo = (any(wt in tl for wt in _OT_WORK_TYPES)
                 and re.search(r'\d+\s*시간', tl)
                 and (any(pw in tl for pw in _OT_PAY_WORDS)
                      or re.search(r'시급|월급|임금', tl)))
    if not (has_kw or has_combo):
        return None

    # 시급 또는 통상시급 추출
    hourly = None
    for kw in ['시급', '통상시급', '시간급']:
        if kw in tl:
            amt = _parse_amount(re.sub(kw, '', text, count=1))
            if amt and 5_000 <= amt <= 500_000:
                hourly = amt
                break

    # 월급 → 시급 환산 (주40시간, 월 209시간)
    if hourly is None:
        for kw in ['월급', '월 급여', '기본급']:
            if kw in tl:
                amt = _parse_amount(re.sub(kw, '', text, count=1))
                if amt and 500_000 <= amt <= 50_000_000:
                    hourly = amt // 209
                    break

    if hourly is None:
        return None

    # 시간 추출
    overtime_h  = _parse_hours(tl, ['연장', '초과', 'ot', '시간외'])
    night_h     = _parse_hours(tl, ['야간', '야근', '밤'])
    holiday_h_8 = _parse_hours(tl, ['휴일', '공휴일', '주말'])

    if overtime_h is None and night_h is None and holiday_h_8 is None:
        # 시간 없으면 예시 계산
        overtime_h = 10.0

    rows = []
    total = 0

    if overtime_h is not None:
        pay = int(hourly * 1.5 * overtime_h)
        total += pay
        rows.append(f"| 연장근로 {overtime_h:.0f}h | 시급×1.5×{overtime_h:.0f} | {pay:,}원 |")

    if night_h is not None:
        night_pay = int(hourly * 0.5 * night_h)  # 야간 가산분만
        total += night_pay
        rows.append(f"| 야간가산 {night_h:.0f}h | 시급×0.5×{night_h:.0f} | {night_pay:,}원 |")

    if holiday_h_8 is not None:
        over8 = max(0, holiday_h_8 - 8)
        within8 = min(holiday_h_8, 8)
        p8  = int(hourly * 1.5 * within8)
        po8 = int(hourly * 2.0 * over8)
        total += p8 + po8
        rows.append(f"| 휴일근로 8h이내 {within8:.0f}h | 시급×1.5×{within8:.0f} | {p8:,}원 |")
        if over8:
            rows.append(f"| 휴일근로 8h초과 {over8:.0f}h | 시급×2.0×{over8:.0f} | {po8:,}원 |")

    table = "\n".join(rows) if rows else "| 연장 10시간 (예시) | 시급×1.5×10 | 계산값 |"

    return (
        f"## 가산임금(수당) 계산 (근로기준법 제56조)\n\n"
        f"**통상시급**: {hourly:,}원\n\n"
        f"### 가산율 기준\n"
        f"| 구분 | 가산율 | 비고 |\n|------|--------|------|\n"
        f"| 연장근로 | ×1.5 | 법정근로 8h·주40h 초과 |\n"
        f"| 야간근로 | +×0.5 | 오후10시~오전6시 |\n"
        f"| 연장+야간 | ×2.0 | 중복 적용 |\n"
        f"| 휴일근로 8h이내 | ×1.5 | |\n"
        f"| 휴일근로 8h초과 | ×2.0 | |\n\n"
        f"### 계산 결과\n"
        f"| 항목 | 계산식 | 금액 |\n|------|--------|------|\n"
        f"{table}\n"
        f"| **합계** | | **{total:,}원** |\n\n"
        f"> 5인 미만 사업장은 연장·야간·휴일 가산수당 미적용 (기본 시급만 지급)\n"
        f"> 포괄임금제라도 실제 가산임금이 포괄액 초과 시 차액 지급 의무"
    )


# ══════════════════════════════════════════════════════
#  6. 주휴수당 계산
# ══════════════════════════════════════════════════════

_WEEKLY_HOLIDAY_KEYWORDS = ['주휴수당', '주휴', '주휴일수당', '주휴 수당']


def try_weekly_holiday_calc(text: str) -> Optional[str]:
    """주휴수당 계산"""
    tl = text.lower()
    if not any(kw in tl for kw in _WEEKLY_HOLIDAY_KEYWORDS):
        return None

    # 시급
    hourly = None
    for kw in ['시급', '통상시급', '시간급']:
        if kw in tl:
            amt = _parse_amount(re.sub(kw, '', text, count=1))
            if amt and 5_000 <= amt <= 500_000:
                hourly = amt
                break
    if hourly is None:
        amt = _parse_amount(text)
        if amt and 5_000 <= amt <= 500_000:
            hourly = amt

    # 주 소정근로시간
    weekly_h = None
    m = re.search(r'주\s*(\d+)\s*시간', tl)
    if m:
        weekly_h = int(m.group(1))
    m2 = re.search(r'(\d+)\s*시간\s*(?:근무|일)', tl)
    if m2 and not weekly_h:
        weekly_h = int(m2.group(1))

    # 주 5일 근무 기본 (15시간 이상이어야 주휴 발생)
    if weekly_h is None:
        weekly_h = 40  # 기본 주 40시간

    if not hourly:
        return None

    eligible = weekly_h >= 15
    if eligible:
        # 주휴수당 = 1주 소정근로시간 / 40 × 8 × 시급
        weekly_holiday_pay = int(weekly_h / 40 * 8 * hourly)
        # 주 40시간 이상은 8시간 기준
        if weekly_h >= 40:
            weekly_holiday_pay = hourly * 8
    else:
        weekly_holiday_pay = 0

    monthly_holiday_pay = weekly_holiday_pay * 4.345  # 월 평균 주 수

    return (
        f"## 주휴수당 계산 (근로기준법 제55조)\n\n"
        f"| 항목 | 내용 |\n|------|------|\n"
        f"| 통상시급 | {hourly:,}원 |\n"
        f"| 주 소정근로시간 | {weekly_h}시간 |\n"
        f"| 주휴수당 발생 여부 | {'✅ 발생 (주 15시간 이상)' if eligible else '❌ 미발생 (주 15시간 미만)'} |\n\n"
        + (
            f"### 계산식\n"
            f"```\n"
            f"주휴수당 = 주 소정근로시간 ÷ 40 × 8시간 × 시급\n"
            f"         = {weekly_h} ÷ 40 × 8 × {hourly:,}\n"
            f"         = {weekly_holiday_pay:,}원/주\n"
            f"```\n\n"
            f"| 지급 주기 | 금액 |\n|-----------|------|\n"
            f"| 주 1회 | {weekly_holiday_pay:,}원 |\n"
            f"| 월 환산 (×4.345주) | 약 {int(monthly_holiday_pay):,}원 |\n\n"
            f"> 주 15시간 이상 개근 시 유급 주휴일 보장 (근로기준법 제55조)\n"
            f"> 아르바이트·단시간근로자도 동일 적용"
            if eligible else
            f"\n주 15시간 미만 근로자는 주휴수당 미적용 (단시간근로자 특례)\n"
        )
    )


# ══════════════════════════════════════════════════════
#  7. 최저임금 위반 체크
# ══════════════════════════════════════════════════════

_MIN_WAGE_KEYWORDS = [
    '최저임금 위반', '최저시급 위반', '최저임금보다 낮', '최저임금 맞나',
    '최저임금 확인', '시급이 적은', '최저임금 받는지',
]
MIN_WAGE_2024 = 9_860
MIN_WAGE_2025 = 10_030
MIN_WAGE_2026 = 10_320
_MIN_WAGE_TABLE = {2024: MIN_WAGE_2024, 2025: MIN_WAGE_2025, 2026: MIN_WAGE_2026}


def _current_min_wage() -> tuple[int, int]:
    """현재 연도 최저임금과 연도 반환"""
    today = date.today()
    if today.year >= 2026:
        return MIN_WAGE_2026, today.year
    elif today.year >= 2025:
        return MIN_WAGE_2025, today.year
    else:
        return MIN_WAGE_2024, today.year


def _question_year_min_wage(text: str) -> Optional[tuple[int, int]]:
    """질문에 명시된 연도의 최저임금 반환. 보유 데이터(2024~2026) 밖이면 None.
    (예: "2024년 시급 9,900원 위반?" → 2024년 기준으로 판정)"""
    for m in re.finditer(r'(\d{2,4})년', text):
        y = int(m.group(1))
        if y < 100:
            y += 2000
        if y in _MIN_WAGE_TABLE:
            return _MIN_WAGE_TABLE[y], y
        if 2000 <= y <= 2060:
            return None  # 명시된 연도가 데이터 밖 → 직접 계산 포기 (KB/LLM 경로로)
    return _current_min_wage()


def try_min_wage_check(text: str) -> Optional[str]:
    """최저임금 위반 여부 확인"""
    tl = text.lower()
    if not any(kw in tl for kw in _MIN_WAGE_KEYWORDS):
        return None

    # 시급 추출
    hourly = None
    for kw in ['시급', '통상시급', '시간급']:
        if kw in tl:
            amt = _parse_amount(re.sub(kw, '', text, count=1))
            if amt and 1_000 <= amt <= 500_000:
                hourly = amt
                break
    if hourly is None:
        # 월급으로 시급 환산
        for kw in ['월급', '월 급여']:
            if kw in tl:
                amt = _parse_amount(re.sub(kw, '', text, count=1))
                if amt and amt >= 500_000:
                    hourly = amt // 209
                    break
    if hourly is None:
        return None

    # 질문에 연도가 명시되면 그 연도 기준으로 판정 (데이터 밖 연도는 KB/LLM 경로로)
    mw = _question_year_min_wage(text)
    if mw is None:
        return None
    min_wage, year = mw

    diff = hourly - min_wage
    if diff < 0:
        status = f"❌ **위반** (최저임금 {min_wage:,}원보다 {abs(diff):,}원 부족)"
        monthly_short = abs(diff) * 209
        action = (
            f"\n### 대응 방법\n"
            f"- 차액 {abs(diff):,}원/시간 (월 약 {monthly_short:,}원) 즉시 인상 요구\n"
            f"- 고용노동부 신고: ☎ 1350\n"
            f"- 임금체불 진정: 관할 고용노동청 지청\n"
            f"- 위반 사업주: 3년 이하 징역 또는 2,000만원 이하 벌금"
        )
    elif diff == 0:
        status = f"✅ **최저임금 정확히 충족** ({year}년 최저시급 {min_wage:,}원)"
        action = ""
    else:
        status = f"✅ **최저임금 준수** (최저임금 {min_wage:,}원보다 {diff:,}원 높음)"
        action = ""

    return (
        f"## 최저임금 위반 확인 ({year}년 기준)\n\n"
        f"| 항목 | 금액 |\n|------|------|\n"
        f"| 입력 시급 | {hourly:,}원 |\n"
        f"| {year}년 최저시급 | {min_wage:,}원 |\n"
        f"| **판정** | {status} |\n"
        f"{action}\n\n"
        f"| 연도 | 최저시급 | 월환산(209h) |\n|------|---------|-------------|\n"
        f"| 2024년 | 9,860원 | 2,060,740원 |\n"
        f"| 2025년 | 10,030원 | 2,096,270원 |\n"
        f"| 2026년 | 10,320원 | 2,156,880원 |"
    )


# ══════════════════════════════════════════════════════
#  8. 4대보험 요율 계산 (단순 조회)
# ══════════════════════════════════════════════════════

_INSURANCE_KEYWORDS = [
    '4대보험 계산', '4대보험 얼마', '보험료 계산', '국민연금 얼마',
    '건강보험 얼마', '고용보험 얼마', '4대보험료',
]


def try_insurance_calc(text: str) -> Optional[str]:
    """4대보험 보험료 계산"""
    tl = text.lower()
    if not any(kw in tl for kw in _INSURANCE_KEYWORDS):
        return None

    amt = None
    for kw in ['월급', '급여', '임금']:
        if kw in tl:
            a = _parse_amount(re.sub(kw, '', text, count=1))
            if a and 500_000 <= a <= 50_000_000:
                amt = a
                break
    if amt is None:
        a = _parse_amount(text)
        if a and 500_000 <= a <= 50_000_000:
            amt = a
    if not amt:
        return None

    r = _calc_net_salary(amt, 1)
    employer_pension    = int(min(max(amt, 370_000), 5_900_000) * 0.0475)
    employer_health     = int(amt * 0.03595)
    employer_ltcare     = int(employer_health * 0.1314)
    employer_employment = int(amt * 0.009)

    return (
        f"## 4대보험료 계산 (2026년 요율 기준)\n\n"
        f"**월 보수월액**: {amt:,}원\n\n"
        f"| 보험 종류 | 요율 | 근로자 부담 | 사업주 부담 |\n"
        f"|-----------|------|------------|------------|\n"
        f"| 국민연금 | 9.5% | {r['pension']:,}원 | {employer_pension:,}원 |\n"
        f"| 건강보험 | 7.19% | {r['health']:,}원 | {employer_health:,}원 |\n"
        f"| 장기요양보험 | (건강×13.14%) | {r['ltcare']:,}원 | {employer_ltcare:,}원 |\n"
        f"| 고용보험 | 1.8%(0.9%씩) | {r['employment']:,}원 | {employer_employment:,}원 |\n"
        f"| **근로자 합계** | | **{r['pension']+r['health']+r['ltcare']+r['employment']:,}원** | |\n"
        f"| **사업주 합계** | | | **{employer_pension+employer_health+employer_ltcare+employer_employment:,}원** |\n\n"
        f"> 산재보험료: 사업주 전액 부담 (업종별 요율 0.7%~28.8%, 표준 약 0.73%)\n"
        f"> 국민연금 기준소득월액: 하한 37만원, 상한 590만원"
    )


# ══════════════════════════════════════════════════════
#  9. 통합 디스패처
# ══════════════════════════════════════════════════════

# 계산기 그룹: 같은 그룹 안에서는 첫 매칭만 사용 (기간 연차 vs 단일 연차처럼
# 동일 주제의 대체 계산기), 서로 다른 그룹은 전부 수집해 종합 자료로 결합
_CALC_GROUPS = [
    ("연차",            [try_annual_leave_period_calc, try_annual_leave_calc]),
    ("퇴직금",          [try_retirement_calc]),
    ("급여 실수령액",   [try_salary_calc]),
    ("연장·야간·휴일 수당", [try_overtime_calc]),
    ("주휴수당",        [try_weekly_holiday_calc]),
    ("최저임금",        [try_min_wage_check]),
    ("4대보험",         [try_insurance_calc]),
]


def try_any_calc(text: str) -> Optional[str]:
    """
    모든 계산기를 시도해 매칭되는 결과를 전부 수집.
    - 1개 매칭: 해당 결과 그대로 반환 (기존 동작)
    - 2개 이상 매칭: 인식된 의도 목록 + 각 계산 결과를 결합한 종합 자료 반환
      (예: "퇴직금이랑 연차 알려줘" → 퇴직금 + 연차 두 섹션)
    - 매칭 없음: None
    """
    results = []
    for label, fns in _CALC_GROUPS:
        for fn in fns:
            r = fn(text)
            if r:
                results.append((label, r))
                break
    if not results:
        return None
    if len(results) == 1:
        return results[0][1]

    labels = [label for label, _ in results]
    header = (
        f"# 📊 종합 계산 결과\n\n"
        f"질문에서 **{len(results)}가지** 계산 의도를 인식했습니다: "
        + " · ".join(f"**{l}**" for l in labels)
        + "\n\n---\n\n"
    )
    return header + "\n\n---\n\n".join(r for _, r in results)
