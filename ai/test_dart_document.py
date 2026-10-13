"""DART 공시서류원본파일(사업보고서/감사보고서 본문) 접근 기능 회귀 테스트.

2026-10-13 세션에서 추가. 기존 dart_client.py는 재무제표 숫자·배당정보·공시
"목록"(메타데이터)만 다뤘고 사업보고서/감사보고서의 실제 본문(사업의 내용,
감사의견 등)에는 접근하지 못했다. opendart.fss.or.kr 공식 개발가이드 페이지가
이 환경에서 503으로 열리지 않아, 실제 호출 코드를 공개한 독립 오픈소스
프로젝트(ChangooLee/mcp-opendart, hypn4/opendart-fss-mcp)의 동작으로 엔드포인트
(document.xml)·파라미터(crtfc_key+rcept_no)·응답 형식(ZIP 바이너리, 내부 .xml)을
교차 확인한 뒤 구현했다. 이 테스트는 네트워크(DART API) 없이도 검증 가능한
순수 로직(공시 유형 필터링, ZIP 추출, XML 태그 제거, mock 안전 저하, 프롬프트
섹션 구성)만 다룬다 — 실제 API 키로의 end-to-end 검증은 배포 후 별도로
필요하다(이 세션엔 DART_API_KEY가 없어 실제 응답 구조까지는 확인하지 못했고,
"추측 금지" 원칙에 따라 교차 확인 가능한 범위까지만 구현했다).
"""
import asyncio
import io
import os
import sys
import zipfile

AI_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI_DIR)

from stock_analysis.utils import dart_client as dart  # noqa: E402
from stock_analysis.utils import claude_client  # noqa: E402


def _test_filter_periodic_reports():
    disclosures = [
        {"report_nm": "분기보고서 (2026.09)", "rcept_no": "1", "rcept_dt": "20261115"},
        {"report_nm": "사업보고서 (2025.12)", "rcept_no": "2", "rcept_dt": "20260331"},
        {"report_nm": "감사보고서", "rcept_no": "3", "rcept_dt": "20260320"},
        {"report_nm": "주요사항보고서(유상증자결정)", "rcept_no": "4", "rcept_dt": "20260401"},
        {"report_nm": "연결감사보고서", "rcept_no": "5", "rcept_dt": "20260325"},
    ]
    result = dart._filter_periodic_reports(disclosures)
    # 사업보고서/감사보고서/연결감사보고서만 남고, 분기보고서·주요사항보고는
    # 제외되어야 한다. rcept_dt 내림차순(최신이 먼저)으로 정렬되어야 한다.
    assert [d["rcept_no"] for d in result] == ["2", "5", "3"]

    print("DART periodic report filter test: PASS")


def _test_extract_best_xml_from_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("small.xml", "<DOCUMENT><P>짧음</P></DOCUMENT>")
        zf.writestr(
            "body.xml",
            "<DOCUMENT><SECTION-1><TITLE>사업의 내용</TITLE>"
            "<P>회사는 반도체 사업을 영위합니다.</P></SECTION-1></DOCUMENT>",
        )
        zf.writestr("readme.txt", "이 파일은 xml이 아니므로 후보에서 제외되어야 함")

    name, raw_xml = dart._extract_best_xml_from_zip(buf.getvalue())
    assert name == "body.xml", f"가장 큰 .xml 파일이 선택되어야 함: {name!r}"
    assert "사업의 내용".encode("utf-8") in raw_xml

    print("DART ZIP best-xml extraction test: PASS")


def _test_extract_best_xml_from_zip_no_xml():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", "xml 없음")
    name, raw_xml = dart._extract_best_xml_from_zip(buf.getvalue())
    assert name is None and raw_xml == b""

    print("DART ZIP no-xml fallback test: PASS")


def _test_strip_dart_xml_tags():
    raw = (
        "<DOCUMENT><SECTION-1><TITLE>사업의 내용</TITLE>"
        "<P>당사는 &amp;quot;반도체&amp;quot; 설계를 주 사업으로 합니다.</P>"
        "<P>　</P>"
        "<P>감사의견: 적정</P></SECTION-1></DOCUMENT>"
    ).encode("utf-8")
    text = dart._strip_dart_xml_tags(raw)
    assert "<" not in text and ">" not in text, "태그가 전부 제거되어야 함"
    assert "사업의 내용" in text
    assert "반도체" in text
    assert "감사의견: 적정" in text

    print("DART XML tag stripping test: PASS")


def _test_fetch_document_text_no_api_key(monkeypatch=None):
    # DART_API_KEY가 없으면(이 세션의 실제 상태) 네트워크 호출 없이 명시적
    # is_mock 플래그가 붙은 안전한 샘플 결과로 저하되어야 한다.
    original = dart.DART_API_KEY
    dart.DART_API_KEY = ""
    try:
        result = asyncio.run(dart.fetch_document_text("20260101000001"))
    finally:
        dart.DART_API_KEY = original
    assert result.get("is_mock") is True
    assert "text" in result

    print("DART fetch_document_text no-API-key safe fallback test: PASS")


def _test_fetch_report_narrative_no_api_key():
    original = dart.DART_API_KEY
    dart.DART_API_KEY = ""
    try:
        result = asyncio.run(dart.fetch_report_narrative("삼성전자"))
    finally:
        dart.DART_API_KEY = original
    assert result.get("is_mock") is True
    assert "삼성전자" in result.get("text", "")

    print("DART fetch_report_narrative no-API-key safe fallback test: PASS")


def _test_fetch_report_narrative_not_found(monkeypatch=None):
    # API 키가 있지만(여기선 흉내만 냄) 해당 종목의 사업보고서/감사보고서를
    # 찾지 못하면 추측하지 않고 명확한 에러를 반환해야 한다.
    original_key = dart.DART_API_KEY
    original_search = dart.search_periodic_reports
    dart.DART_API_KEY = "fake-key-for-test"

    async def empty_search(corp_name, days=400):
        return []

    dart.search_periodic_reports = empty_search
    try:
        result = asyncio.run(dart.fetch_report_narrative("없는회사"))
    finally:
        dart.DART_API_KEY = original_key
        dart.search_periodic_reports = original_search

    assert "error" in result
    assert "text" not in result

    print("DART fetch_report_narrative not-found safe error test: PASS")


def _test_claude_narrative_prompt_section_included():
    narrative = {
        "report_nm": "사업보고서",
        "rcept_dt": "20260331",
        "text": "당사는 메모리 반도체를 주력으로 생산하며, 주요 리스크는 환율 변동입니다.",
    }
    section = claude_client._narrative_prompt_section(narrative)
    assert "사업보고서" in section
    assert "환율 변동" in section
    assert "20260331" in section

    print("claude_client narrative prompt section (included) test: PASS")


def _test_claude_narrative_prompt_section_excluded_for_mock_and_error():
    assert claude_client._narrative_prompt_section({}) == ""
    assert claude_client._narrative_prompt_section({"is_mock": True, "text": "샘플"}) == ""
    assert claude_client._narrative_prompt_section({"error": "실패", "text": ""}) == ""
    assert claude_client._narrative_prompt_section({"text": ""}) == ""

    print("claude_client narrative prompt section (excluded) test: PASS")


def _test_claude_narrative_prompt_section_truncates():
    long_text = "가" * 5000
    narrative = {"report_nm": "사업보고서", "rcept_dt": "20260331", "text": long_text}
    section = claude_client._narrative_prompt_section(narrative)
    assert len(section) < 2000, "프롬프트 섹션은 고정 길이로 잘려야 함"
    assert "...(이하 생략)" in section

    print("claude_client narrative prompt section (truncation) test: PASS")


def _test_analyze_stock_opinion_passes_narrative_into_prompt():
    # Claude API를 실제로 호출하지 않고, _get_client()를 모킹해 실제로 만들어진
    # user_prompt 안에 사업보고서 발췌가 포함되는지 확인한다.
    captured = {}

    class _FakeResponse:
        content = []

    class _FakeMessages:
        def create(self, **kwargs):
            captured["kwargs"] = kwargs
            return _FakeResponse()

    class _FakeClient:
        messages = _FakeMessages()

    original_get_client = claude_client._get_client
    claude_client._get_client = lambda: _FakeClient()
    try:
        analysis_data = {
            "내재가치": {"목표주가": 100000, "현재가": 80000, "상승여력": 25.0},
            "기술적분석": {},
            "수급분석": {},
            "매크로연계": {},
            "매매시점": {"종합점수": 10, "근거": []},
            "사업보고서": {
                "report_nm": "사업보고서",
                "rcept_dt": "20260331",
                "text": "당사의 핵심 사업은 파운드리이며 TSMC와 경쟁합니다.",
            },
        }
        claude_client.analyze_stock_opinion("테스트전자", analysis_data)
    finally:
        claude_client._get_client = original_get_client

    user_prompt = captured["kwargs"]["messages"][0]["content"]
    assert "파운드리" in user_prompt
    assert "사업보고서" in user_prompt

    print("analyze_stock_opinion narrative integration test: PASS")


def main():
    _test_filter_periodic_reports()
    _test_extract_best_xml_from_zip()
    _test_extract_best_xml_from_zip_no_xml()
    _test_strip_dart_xml_tags()
    _test_fetch_document_text_no_api_key()
    _test_fetch_report_narrative_no_api_key()
    _test_fetch_report_narrative_not_found()
    _test_claude_narrative_prompt_section_included()
    _test_claude_narrative_prompt_section_excluded_for_mock_and_error()
    _test_claude_narrative_prompt_section_truncates()
    _test_analyze_stock_opinion_passes_narrative_into_prompt()


if __name__ == "__main__":
    main()
