"""주식 채팅 외부 자료 병렬 수집 회귀 테스트."""
import asyncio

import stock_chat_sources


async def _run():
    def fake_search(query):
        return [{"title": query, "url": "https://search.example/result"}]

    def ticker(name):
        return {"삼성전자": "005930", "현대차": "005380"}[name]

    async def fake_news(name, ticker_code, max_results):
        assert max_results == 6
        if name == "현대차":
            raise RuntimeError("뉴스 공급자 장애")
        return [{"title": f"{name} 뉴스", "ticker": ticker_code}]

    def fake_news_context(results):
        return results[0]["title"]

    async def fake_reports(ticker_code, name, max_reports):
        assert max_reports == 5
        if name == "현대차":
            raise TimeoutError("리포트 지연")
        return {
            "summary": f"{name} 컨센서스",
            "reports": [
                {"제목": "전망", "링크": "https://broker.example/report"},
                {"제목": "링크 없음", "링크": ""},
            ],
        }

    collected = await stock_chat_sources.collect(
        "반도체 전망", ["삼성전자", "현대차"], ticker,
        web_search=fake_search,
        get_stock_news=fake_news,
        format_news_context=fake_news_context,
        get_all_reports=fake_reports,
    )
    assert collected.search_results[0]["title"] == "반도체 전망"
    assert collected.news_context == "삼성전자 뉴스"
    assert collected.broker_context == "삼성전자 컨센서스"
    assert collected.broker_references == [{
        "title": "삼성전자 - 전망", "url": "https://broker.example/report",
    }]
    assert any(error.startswith("news:현대차:RuntimeError") for error in collected.errors)
    assert any(error.startswith("broker:현대차:TimeoutError") for error in collected.errors)

    search_only = await stock_chat_sources.collect(
        "시장 전망", [], lambda _name: "", web_search=fake_search,
    )
    assert search_only.search_results
    assert search_only.news_context == ""
    assert search_only.broker_context == ""
    assert search_only.errors == []

    failed_search = await stock_chat_sources.collect(
        "실패 검색", [], lambda _name: "",
        web_search=lambda _query: (_ for _ in ()).throw(ConnectionError("검색 장애")),
    )
    assert failed_search.search_results == []
    assert failed_search.errors == ["search:ConnectionError"]


def _test_ddg_report_url_key_matches_naver():
    """DDG로 찾은 증권사 리포트도 naver 리포트와 같은 '링크' 키로 URL을 담아야 한다.

    get_all_reports()가 naver+DDG 결과를 한 리스트로 합친 뒤, 참고 링크 구성
    (stock_chat_sources._collect_broker 등)은 전부 '링크' 키 하나만 읽는다.
    DDG 경로가 예전처럼 '출처'를 쓰면 DDG로만 찾은 리포트의 링크가 조용히
    누락된다(실측 재현했던 회귀).
    """
    import ddgs
    import stock_analysis.utils.securities_report as sr

    class FakeDDGS:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def text(self, query, max_results=5):
            return [{
                "title": "삼성전자 목표주가 상향",
                "body": "목표주가 100,000원 매수 의견",
                "href": "https://finance.naver.com/ddg-only-report",
            }]

    # _search_reports_ddg_sync()는 함수 내부에서 `from ddgs import DDGS`로
    # 지연 임포트하므로, ddgs 모듈의 DDGS 자체를 교체해야 실제 호출 시점에
    # 가짜 구현을 사용한다(모듈 속성 sr.DDGS를 바꾸는 것으로는 적용되지 않음).
    original_ddgs = ddgs.DDGS
    ddgs.DDGS = FakeDDGS
    try:
        results = sr._search_reports_ddg_sync("삼성전자")
    finally:
        ddgs.DDGS = original_ddgs
    assert len(results) == 1
    assert results[0]["링크"] == "https://finance.naver.com/ddg-only-report"
    assert "출처" not in results[0]
    print("ddg report url key regression: PASS")


def main():
    asyncio.run(_run())
    _test_ddg_report_url_key_matches_naver()
    print("stock chat source collection tests: PASS")


if __name__ == "__main__":
    main()
