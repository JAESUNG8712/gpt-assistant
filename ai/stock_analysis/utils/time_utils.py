"""주식 분석에서 사용하는 한국 표준시(KST) 기준 시각."""

from datetime import datetime
from zoneinfo import ZoneInfo


KST = ZoneInfo("Asia/Seoul")


def now_kst() -> datetime:
    """기존 코드의 naive datetime 연산과 호환되는 KST 현재 시각을 반환한다."""
    return datetime.now(KST).replace(tzinfo=None)
