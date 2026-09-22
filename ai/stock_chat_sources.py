"""주식 채팅에 필요한 외부 자료를 병렬로 수집한다."""
import asyncio
from dataclasses import dataclass, field
from typing import Callable

import search as srch


@dataclass(frozen=True)
class StockSourceCollection:
    search_results: list[dict] = field(default_factory=list)
    news_context: str = ""
    broker_context: str = ""
    broker_references: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


async def _collect_news(
    targets: list[str], ticker_for_name: Callable[[str], str], get_stock_news, format_news_context,
) -> tuple[str, list[str]]:
    results = await asyncio.gather(*[
        get_stock_news(name, ticker_for_name(name), max_results=6)
        for name in targets
    ], return_exceptions=True)
    parts, errors = [], []
    for name, result in zip(targets, results):
        if isinstance(result, Exception):
            errors.append(f"news:{name}:{type(result).__name__}")
            continue
        try:
            context = format_news_context(result)
        except Exception as exc:
            errors.append(f"news-format:{name}:{type(exc).__name__}")
            continue
        if context:
            parts.append(context)
    return "\n\n".join(parts), errors


async def _collect_broker(
    targets: list[str], ticker_for_name: Callable[[str], str], get_all_reports,
) -> tuple[str, list[dict], list[str]]:
    results = await asyncio.gather(*[
        get_all_reports(ticker_for_name(name), name, max_reports=5)
        for name in targets
    ], return_exceptions=True)
    parts, references, errors = [], [], []
    for name, result in zip(targets, results):
        if isinstance(result, Exception):
            errors.append(f"broker:{name}:{type(result).__name__}")
            continue
        if not isinstance(result, dict):
            errors.append(f"broker:{name}:InvalidResult")
            continue
        summary = result.get("summary", "")
        if summary:
            parts.append(summary)
        for report in result.get("reports", []):
            if not isinstance(report, dict) or not report.get("링크"):
                continue
            references.append({
                "title": f"{name} - {report.get('제목', '')}",
                "url": report["링크"],
            })
    return "\n\n".join(parts), references, errors


async def collect(
    query: str,
    targets: list[str],
    ticker_for_name: Callable[[str], str],
    *,
    web_search=None,
    get_stock_news=None,
    format_news_context=None,
    get_all_reports=None,
) -> StockSourceCollection:
    """검색·뉴스·증권사 자료를 병렬 수집하고 소스별 실패를 격리한다.

    한 종목이나 한 공급자가 실패해도 나머지 정상 자료를 보존한다. 선택적 함수
    인자는 네트워크 없는 회귀 테스트에서만 사용하며 운영에서는 실제 공급자를
    지연 import한다.
    """
    if web_search is None:
        web_search = srch.web_search
    limited_targets = targets[:3]
    if limited_targets and (get_stock_news is None or format_news_context is None):
        from stock_analysis.utils.news_collector import (
            get_stock_news as real_get_stock_news,
            format_news_context as real_format_news_context,
        )
        get_stock_news = get_stock_news or real_get_stock_news
        format_news_context = format_news_context or real_format_news_context
    if limited_targets and get_all_reports is None:
        from stock_analysis.utils.securities_report import get_all_reports as real_get_all_reports
        get_all_reports = real_get_all_reports

    loop = asyncio.get_running_loop()
    tasks = [loop.run_in_executor(None, lambda: web_search(query))]
    if limited_targets:
        tasks.extend([
            _collect_news(
                limited_targets, ticker_for_name, get_stock_news, format_news_context,
            ),
            _collect_broker(limited_targets, ticker_for_name, get_all_reports),
        ])
    gathered = await asyncio.gather(*tasks, return_exceptions=True)

    errors = []
    search_results = gathered[0]
    if isinstance(search_results, Exception):
        errors.append(f"search:{type(search_results).__name__}")
        search_results = []
    elif not isinstance(search_results, list):
        errors.append("search:InvalidResult")
        search_results = []

    news_context, broker_context, broker_references = "", "", []
    if limited_targets:
        news_result, broker_result = gathered[1], gathered[2]
        if isinstance(news_result, Exception):
            errors.append(f"news:{type(news_result).__name__}")
        else:
            news_context, news_errors = news_result
            errors.extend(news_errors)
        if isinstance(broker_result, Exception):
            errors.append(f"broker:{type(broker_result).__name__}")
        else:
            broker_context, broker_references, broker_errors = broker_result
            errors.extend(broker_errors)

    return StockSourceCollection(
        search_results=search_results,
        news_context=news_context,
        broker_context=broker_context,
        broker_references=broker_references,
        errors=errors,
    )
