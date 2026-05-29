"""
HR 날짜 기반 계산기 — Python으로 직접 계산 (LLM 불필요)
연차, 퇴직금, 근속기간 등 정확한 수치 계산 후 컨텍스트로 주입
"""
import re
from datetime import date, timedelta
from typing import Optional


# ── 날짜 파싱 ──────────────────────────────────────────

def _parse_date(text: str) -> Optional[date]:
    """
    한국어/숫자 날짜 표현을 date 객체로 변환.
    지원 형식: '24년 8월 17일', '2024년 8월 17일', '2024.08.17', '24/8/17' 등
    """
    text = text.replace(' ', '')

    # "24년 8월 17일" / "2024년 8월 17일"
    m = re.search(r'(\d{2,4})년\s*(\d{1,2})월\s*(\d{1,2})일', text)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000
        try:
            return date(y, mo, d)
        except ValueError:
            pass

    # "24년 8월" (일 없음 → 1일로 처리)
    m = re.search(r'(\d{2,4})년\s*(\d{1,2})월', text)
    if m:
        y, mo = int(m.group(1)), int(m.group(2))
        if y < 100:
            y += 2000
        try:
            return date(y, mo, 1)
        except ValueError:
            pass

    # "2024.08.17" / "2024-08-17"
    m = re.search(r'(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})', text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass

    # "24.8.17"
    m = re.search(r'(\d{2})[.\-](\d{1,2})[.\-](\d{1,2})', text)
    if m:
        try:
            return date(2000 + int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass

    return None


# ── 연차 계산 ──────────────────────────────────────────

def calc_annual_leave(join_date: date, today: date = None) -> dict:
    """
    입사일 기준 현재 사용 가능한 연차 일수 계산 (근로기준법 제60조).

    Returns:
        {
            "join_date": str,
            "today": str,
            "months_worked": int,
            "years_worked": int,
            "available_days": int,        # 현재 사용 가능한 연차
            "next_leave_days": int,        # 다음 연차 발생 예정 일수
            "next_leave_date": str,        # 다음 연차 발생일
            "explanation": str,            # 사람이 읽기 쉬운 설명
        }
    """
    if today is None:
        today = date.today()

    # 근속 기간 계산
    total_days = (today - join_date).days
    years_full = 0
    temp = join_date
    while True:
        next_year = date(temp.year + 1, temp.month, temp.day)
        if next_year > today:
            break
        years_full += 1
        temp = next_year

    months_full = 0
    temp2 = join_date
    while True:
        mo = temp2.month + 1
        yr = temp2.year + (1 if mo > 12 else 0)
        mo = mo if mo <= 12 else mo - 12
        try:
            next_month = date(yr, mo, temp2.day)
        except ValueError:
            import calendar
            last_day = calendar.monthrange(yr, mo)[1]
            next_month = date(yr, mo, last_day)
        if next_month > today:
            break
        months_full += 1
        temp2 = next_month

    # ── 현재 사용 가능한 연차 계산 ──────────────────────
    if years_full == 0:
        # 1년 미만: 개근 시 매월 1일 발생 (최대 11일)
        available_days = min(months_full, 11)
        leave_type = "1년미만"
    else:
        # 1년 이상: 15일 + (years_full - 1) // 2 일 추가 (3년차부터 2년마다 1일)
        available_days = 15 + (years_full - 1) // 2
        available_days = min(available_days, 25)  # 최대 25일
        leave_type = f"{years_full}년차"

    # ── 다음 연차 발생일 ───────────────────────────────
    if years_full == 0:
        # 다음 달 발생
        mo = join_date.month + months_full + 1
        yr = join_date.year
        while mo > 12:
            mo -= 12
            yr += 1
        try:
            next_leave_date = date(yr, mo, join_date.day)
        except ValueError:
            import calendar
            last_day = calendar.monthrange(yr, mo)[1]
            next_leave_date = date(yr, mo, last_day)
        next_leave_days = 1
    else:
        # 다음 연주년
        next_anniversary_year = years_full + 1
        try:
            next_leave_date = date(
                join_date.year + next_anniversary_year,
                join_date.month,
                join_date.day,
            )
        except ValueError:
            import calendar
            last_day = calendar.monthrange(
                join_date.year + next_anniversary_year, join_date.month
            )[1]
            next_leave_date = date(
                join_date.year + next_anniversary_year,
                join_date.month,
                last_day,
            )
        next_leave_days = 15 + (next_anniversary_year - 1) // 2
        next_leave_days = min(next_leave_days, 25)

    # ── 사람이 읽기 쉬운 설명 생성 ───────────────────────
    years_str = f"{years_full}년" if years_full else ""
    extra_months = months_full - years_full * 12 if years_full else months_full
    months_str = f"{extra_months}개월" if extra_months else ""
    tenure_str = (years_str + " " + months_str).strip() or "1개월 미만"

    if years_full == 0:
        calc_note = (
            f"입사 후 매월 개근 시 1일씩 발생 → "
            f"현재 {months_full}개월 경과 = **{available_days}일** 사용 가능"
        )
    else:
        base = 15
        extra = (years_full - 1) // 2
        if extra > 0:
            calc_note = (
                f"기본 15일 + {years_full - 1}년 경과 가산 {extra}일 = **{available_days}일** 사용 가능"
            )
        else:
            calc_note = f"1년 이상: 기본 **{available_days}일** 사용 가능"

    explanation = (
        f"입사일: **{join_date.strftime('%Y년 %m월 %d일')}**  \n"
        f"기준일: **{today.strftime('%Y년 %m월 %d일')}**  \n"
        f"근속기간: **{tenure_str}** ({leave_type})  \n\n"
        f"현재 사용 가능한 연차: **{available_days}일**  \n"
        f"({calc_note})  \n\n"
        f"다음 연차 발생: {next_leave_date.strftime('%Y년 %m월 %d일')} ({next_leave_days}일 예정)\n\n"
        f"> 근로기준법 제60조 기준. 회사별 취업규칙 확인 권장."
    )

    return {
        "join_date": join_date.isoformat(),
        "today": today.isoformat(),
        "months_worked": months_full,
        "years_worked": years_full,
        "available_days": available_days,
        "next_leave_days": next_leave_days,
        "next_leave_date": next_leave_date.isoformat(),
        "explanation": explanation,
    }


# ── 근속기간 계산 ──────────────────────────────────────

def calc_tenure(join_date: date, end_date: date = None) -> dict:
    """
    근속기간 계산 (퇴직금·수습기간 등에 활용).
    end_date가 None이면 오늘 기준.
    """
    if end_date is None:
        end_date = date.today()

    total_days = (end_date - join_date).days
    years = total_days // 365
    remaining_days = total_days % 365
    months = remaining_days // 30
    days = remaining_days % 30

    return {
        "join_date": join_date.isoformat(),
        "end_date": end_date.isoformat(),
        "total_days": total_days,
        "years": years,
        "months": months,
        "days": days,
        "display": f"{years}년 {months}개월 {days}일" if years else f"{months}개월 {days}일",
    }


# ── 쿼리 의도 감지 ─────────────────────────────────────

_ANNUAL_LEAVE_KEYWORDS = [
    '연차', '유급휴가', '연월차', '휴가 며칠', '휴가 몇 일', '휴가 갯수',
    '연차 몇', '연차 갯수', '연차 개수', '휴가 개수',
]

_JOIN_DATE_KEYWORDS = [
    '입사', '입사일', '시작', '취업', '입산',   # '입산'은 '입사'의 오타
]

def detect_annual_leave_query(text: str) -> bool:
    """연차 계산 쿼리인지 감지"""
    text_lower = text.lower()
    has_leave = any(kw in text_lower for kw in _ANNUAL_LEAVE_KEYWORDS)
    has_date = bool(_parse_date(text))
    has_join = any(kw in text_lower for kw in _JOIN_DATE_KEYWORDS)
    return has_leave and (has_date or has_join)


def try_annual_leave_calc(text: str) -> Optional[str]:
    """
    쿼리에서 입사일을 추출해 연차를 계산한다.
    계산 가능하면 Markdown 답변 문자열을 반환, 불가능하면 None.
    """
    if not detect_annual_leave_query(text):
        return None

    join_date = _parse_date(text)
    if join_date is None:
        return None

    today = date.today()
    if join_date > today:
        return f"입사 예정일({join_date.strftime('%Y년 %m월 %d일')})이 오늘보다 미래입니다. 날짜를 다시 확인해 주세요."

    result = calc_annual_leave(join_date, today)
    return f"## 연차 유급휴가 계산 결과\n\n{result['explanation']}"
