"""
독립 실행 엔트리포인트
- 단발: python -m stock_analysis.run_stock --once
- 스케줄: python -m stock_analysis.run_stock --schedule
- 특정 종목: python -m stock_analysis.run_stock --once --stocks 삼성전자,SK하이닉스
"""

import argparse
import asyncio

from .pipeline import _manual_run, schedule_reports


def parse_args():
    parser = argparse.ArgumentParser(description="주식 분석 시스템")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--once", action="store_true", help="단발 분석 실행")
    group.add_argument("--schedule", action="store_true", help="오전7시/저녁10시 자동 스케줄")
    parser.add_argument("--stocks", type=str, help="분석 대상 종목 (콤마 구분, 예: 삼성전자,SK하이닉스)")
    return parser.parse_args()


async def main():
    args = parse_args()
    target = [s.strip() for s in args.stocks.split(",")] if args.stocks else None

    if args.once:
        await _manual_run(target)
    else:
        await schedule_reports(target)


if __name__ == "__main__":
    asyncio.run(main())
