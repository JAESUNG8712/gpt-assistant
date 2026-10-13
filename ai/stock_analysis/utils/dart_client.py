"""
DART(전자공시시스템) OpenAPI 클라이언트
https://opendart.fss.or.kr/
"""

import os
import io
import re
import html
import zipfile
import aiohttp
from datetime import timedelta
from .time_utils import now_kst

DART_API_KEY = os.getenv("DART_API_KEY", "")
DART_BASE_URL = "https://opendart.fss.or.kr/api"

# 사업보고서/감사보고서 등 "본문 내용"을 담은 정기공시로 좁히기 위한 report_nm
# 부분일치 키워드. DART list.json에는 공시유형 상세코드(pblntf_detail_ty)가
# 있지만 이 환경(opendart.fss.or.kr 공식 문서 503, 접속 불가)에서는 정확한
# 코드값을 실측 확인할 수 없어, 이미 이 파일의 search_disclosures()가 쓰고
# 있는 report_nm 텍스트 매칭을 그대로 재사용하는 보수적인 방식을 택했다.
REPORT_NARRATIVE_TYPES = ("사업보고서", "감사보고서")

CORP_CODES = {
    "삼성전자": "00126380",
    "SK하이닉스": "00164779",
    "LG에너지솔루션": "01426928",
    "삼성바이오로직스": "00434003",
    "현대차": "00164742",
    "기아": "00110894",
    "POSCO홀딩스": "00354900",
    "셀트리온": "00421045",
    "KB금융": "00401828",
    "신한지주": "00382199",
    "카카오": "00918444",
    "NAVER": "00526929",
    "LG화학": "00346810",
    "삼성SDI": "00126371",
    "현대모비스": "00164758",
    # 추가 종목
    "LG전자": "00401731",
    "LG씨앤에스": "01188768",
    "LG CNS": "01188768",
    "LGCNS": "01188768",
    "LG": "00120139",
    "대우건설": "00047019",
    "SK텔레콤": "00178079",
    "SK이노베이션": "00631518",
    "KT": "00307508",
    "포스코": "00354900",
    "삼성물산": "00149655",
    "삼성생명": "00150004",
    "하이브": "01313883",
    "카카오뱅크": "01390409",
    "크래프톤": "01410980",
    "두산에너빌리티": "00178703",
    # AI 테마 종목
    "효성중공업": "00817829",
    "LS일렉트릭": "00575945",
    "두산로보틱스": "01710695",
    "대한광통신": "00105994",
    "스피어": "01862530",
    # AI 인프라·반도체·데이터센터
    "HD현대일렉트릭": "00552949",
    "제일엠앤에스": "01162810",
    "이수페타시스": "00583055",
    "코어라인소프트": "01629809",
    "리노공업": "00361052",
    "RFHIC": "01046754",
    "아이큐어": "01252730",
    "서진시스템": "01065390",
    "오픈엣지테크놀로지": "01702461",
    "퓨리오사AI": "01762345",
}

STOCK_CODE_MAP = {
    "005930": "삼성전자",
    "000660": "SK하이닉스",
    "373220": "LG에너지솔루션",
    "207940": "삼성바이오로직스",
    "005380": "현대차",
    "000270": "기아",
    "005490": "POSCO홀딩스",
    "068270": "셀트리온",
    "105560": "KB금융",
    "055550": "신한지주",
    "035720": "카카오",
    "035420": "NAVER",
    "051910": "LG화학",
    "006400": "삼성SDI",
    "012330": "현대모비스",
    # 추가 종목
    "066570": "LG전자",
    "003550": "LG",
    "047040": "대우건설",
    "034730": "SK",
    "017670": "SK텔레콤",
    "096770": "SK이노베이션",
    "030200": "KT",
    "028260": "삼성물산",
    "032830": "삼성생명",
    "352820": "하이브",
    "323410": "카카오뱅크",
    "259960": "크래프톤",
    "042660": "두산에너빌리티",
    # AI 테마 종목
    "298040": "효성중공업",
    "010120": "LS일렉트릭",
    "454910": "두산로보틱스",
    "010170": "대한광통신",
    "403360": "스피어",
    "267260": "HD현대일렉트릭",
    "033320": "이수페타시스",
    "014620": "서진시스템",
    "408100": "오픈엣지테크놀로지",
    "064400": "LG CNS",
    "058470": "리노공업",
    "218410": "RFHIC",
    "175250": "아이큐어",
    "412540": "제일엠앤에스",
    "384470": "코어라인소프트",
    # 퓨리오사AI는 비상장(private)이라 KRX 종목코드 없음 — CORP_CODES(DART 전용)에만 존재
}


async def fetch_financial_statements(corp_code: str, year: str, report_type: str = "11011") -> dict:
    if not DART_API_KEY:
        return _mock_financial_data(corp_code, year)

    url = f"{DART_BASE_URL}/fnlttSinglAcnt.json"
    params = {
        "crtfc_key": DART_API_KEY,
        "corp_code": corp_code,
        "bsns_year": year,
        "reprt_code": report_type,
    }

    try:
        async with aiohttp.ClientSession(trust_env=True) as session:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
                if data.get("status") == "000":
                    return _parse_financial_statements(data.get("list", []))
                return {"error": data.get("message", "DART API 오류")}
    except Exception as e:
        return {"error": str(e)}


async def fetch_dividend_info(corp_code: str, year: str) -> dict:
    if not DART_API_KEY:
        return _mock_dividend_data()

    url = f"{DART_BASE_URL}/alotMatter.json"
    params = {
        "crtfc_key": DART_API_KEY,
        "corp_code": corp_code,
        "bsns_year": year,
        "reprt_code": "11011",
    }

    try:
        async with aiohttp.ClientSession(trust_env=True) as session:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
                return data if data.get("status") == "000" else {"error": data.get("message")}
    except Exception as e:
        return {"error": str(e)}


async def search_disclosures(corp_name: str, days: int = 30) -> list:
    if not DART_API_KEY:
        return _mock_disclosures(corp_name)

    end_date = now_kst().strftime("%Y%m%d")
    start_date = (now_kst() - timedelta(days=days)).strftime("%Y%m%d")

    url = f"{DART_BASE_URL}/list.json"
    params = {
        "crtfc_key": DART_API_KEY,
        "corp_name": corp_name,
        "bgn_de": start_date,
        "end_de": end_date,
        "page_count": 20,
    }

    try:
        async with aiohttp.ClientSession(trust_env=True) as session:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
                return data.get("list", []) if data.get("status") == "000" else []
    except Exception as e:
        print(f"⚠️  DART 공시 검색 오류 ({corp_name}): {e}")
        return []


def _filter_periodic_reports(disclosures: list) -> list:
    """공시 목록에서 사업보고서/감사보고서 등 '본문 내용'이 있는 정기공시만
    추려 최신순으로 정렬한다(네트워크 호출 없는 순수 함수 — 테스트 용이)."""
    filtered = [
        d for d in disclosures
        if any(t in d.get("report_nm", "") for t in REPORT_NARRATIVE_TYPES)
    ]
    filtered.sort(key=lambda d: d.get("rcept_dt", ""), reverse=True)
    return filtered


async def search_periodic_reports(corp_name: str, days: int = 400) -> list:
    """사업보고서/감사보고서 목록만 추려 최신순으로 반환.

    사업보고서는 보통 회계연도 종료 후 90일 이내 제출되므로, 기존
    search_disclosures()의 기본 30일 창으로는 놓치기 쉽다 — 그래서 넉넉하게
    400일을 기본값으로 둔다.
    """
    disclosures = await search_disclosures(corp_name, days=days)
    return _filter_periodic_reports(disclosures)


def _extract_best_xml_from_zip(raw_zip: bytes):
    """ZIP 바이트에서 가장 큰 .xml 멤버 하나를 골라 (파일명, 바이트) 반환.

    DART 공시서류원본파일(document.xml)의 ZIP에는 공시서류 XML(들)이 들어있는데,
    실제 호출 코드를 공개한 독립 오픈소스 프로젝트(ChangooLee/mcp-opendart)의
    get_disclosure_document 구현을 교차 확인해 같은 접근(여러 .xml 중 본문일
    가능성이 높은 것을 고르는 방식)을 재사용했다 — 그 프로젝트는 키워드 점수로
    고르지만, 이 프로젝트는 "본문이 가장 많이 들어있을 파일은 보통 가장 큰
    파일"이라는 더 단순하고 안전한 가정만 쓴다(특정 키워드 집합을 추측해
    틀리는 위험을 피함).
    """
    with zipfile.ZipFile(io.BytesIO(raw_zip)) as zf:
        xml_names = [n for n in zf.namelist() if n.lower().endswith(".xml")]
        if not xml_names:
            return None, b""
        best = max(xml_names, key=lambda n: zf.getinfo(n).file_size)
        return best, zf.read(best)


def _strip_dart_xml_tags(raw_xml: bytes) -> str:
    """DART 공시서류 XML에서 태그를 제거해 읽을 수 있는 본문 평문만 추출.

    DART 공시서류 XML은 일반 산업표준 스키마가 아니라 HWP 변환 과정에서 생긴
    자체 태그 구조라, "본문"이라는 단일 필드를 정확히 뽑아낼 문서화된 방법이
    없다(이 역시 ChangooLee/mcp-opendart 쪽 코드로 교차 확인됨 — 그 프로젝트도
    전용 파서 없이 텍스트 포함 여부로만 처리). 투자 분석 참고 자료로 쓰기에는
    태그를 제거한 평문이면 충분하므로, 태그 제거 → 엔티티 복원 → 공백 정리의
    안전한 방식을 쓴다.
    """
    try:
        text = raw_xml.decode("utf-8")
    except UnicodeDecodeError:
        text = raw_xml.decode("cp949", errors="ignore")
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


async def fetch_document_text(rcept_no: str, max_chars: int = 12000) -> dict:
    """공시서류원본파일(document.xml) 조회 — 사업보고서/감사보고서 등 공시
    본문 텍스트를 가져온다.

    opendart.fss.or.kr 공식 개발가이드 페이지가 이 환경에서 503으로 접속되지
    않아, 실제 호출 코드를 공개한 독립 오픈소스 프로젝트(ChangooLee/mcp-opendart,
    hypn4/opendart-fss-mcp)로 엔드포인트 이름(document.xml)·파라미터
    (crtfc_key+rcept_no)·응답 형식(ZIP 바이너리, 내부에 .xml 파일)을 교차
    확인했다. 응답이 예상과 다르면(ZIP 서명 'PK' 없음 등) 추측으로 더 파고들지
    않고 에러를 반환해 호출부가 안전하게 저하되도록 한다.
    """
    if not DART_API_KEY:
        return _mock_document_text(rcept_no)

    url = f"{DART_BASE_URL}/document.xml"
    params = {"crtfc_key": DART_API_KEY, "rcept_no": rcept_no}

    try:
        async with aiohttp.ClientSession(trust_env=True) as session:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=20)) as resp:
                raw = await resp.read()
    except Exception as e:
        return {"error": str(e), "rcept_no": rcept_no}

    if not raw or raw[:2] != b"PK":
        try:
            snippet = raw.decode("utf-8", errors="ignore")[:200]
        except Exception:
            snippet = ""
        return {
            "error": f"공시서류원본파일 응답이 ZIP 형식이 아님: {snippet}",
            "rcept_no": rcept_no,
        }

    try:
        name, raw_xml = _extract_best_xml_from_zip(raw)
    except zipfile.BadZipFile as e:
        return {"error": f"ZIP 압축 해제 실패: {e}", "rcept_no": rcept_no}

    if not name:
        return {"error": "ZIP 안에 XML 파일이 없음", "rcept_no": rcept_no}

    text = _strip_dart_xml_tags(raw_xml)
    return {
        "rcept_no": rcept_no,
        "text": text[:max_chars],
        "truncated": len(text) > max_chars,
        "source_file": name,
    }


async def fetch_report_narrative(corp_name: str) -> dict:
    """사업보고서/감사보고서의 실제 본문(사업의 내용·감사의견 등)을 조회.

    재무제표 숫자만으로는 알 수 없는 사업 내용·리스크 요인·감사의견을 종목
    분석(/chat 분석 요청, 주식 분석 파이프라인)에서 함께 참고할 수 있도록
    한다. DART_API_KEY가 없거나 해당 종목의 정기공시를 찾지 못하면 명확한
    사유와 함께 안전하게 빈 결과로 저하된다 — 추측한 본문을 만들어내지 않음.
    """
    if not DART_API_KEY:
        return _mock_report_narrative(corp_name)

    try:
        reports = await search_periodic_reports(corp_name)
    except Exception as e:
        return {"error": str(e)}

    if not reports:
        return {"error": f"'{corp_name}'의 사업보고서/감사보고서 공시를 찾지 못함"}

    picked = reports[0]
    rcept_no = picked.get("rcept_no", "")
    if not rcept_no:
        return {"error": "접수번호(rcept_no)를 찾지 못함"}

    doc = await fetch_document_text(rcept_no)
    base = {
        "report_nm": picked.get("report_nm", ""),
        "rcept_dt": picked.get("rcept_dt", ""),
        "rcept_no": rcept_no,
        "viewer_url": f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={rcept_no}",
    }
    if doc.get("error"):
        base["error"] = doc["error"]
        return base

    base["text"] = doc.get("text", "")
    base["truncated"] = doc.get("truncated", False)
    return base


def _mock_document_text(rcept_no: str) -> dict:
    return {
        "rcept_no": rcept_no,
        "text": "DART_API_KEY 미설정 — 공시서류 본문 샘플 데이터 (실제 내용 아님)",
        "truncated": False,
        "is_mock": True,
    }


def _mock_report_narrative(corp_name: str) -> dict:
    return {
        "report_nm": "사업보고서(샘플)",
        "rcept_dt": now_kst().strftime("%Y%m%d"),
        "rcept_no": "",
        "text": (
            f"[{corp_name}] DART_API_KEY 미설정 — 사업보고서/감사보고서 본문을 "
            "조회할 수 없어 샘플 안내문을 표시합니다 (실제 공시 내용 아님)."
        ),
        "truncated": False,
        "is_mock": True,
    }


def _parse_financial_statements(items: list) -> dict:
    result = {}
    for item in items:
        account = item.get("account_nm", "")
        value = (item.get("thstrm_amount") or "0").replace(",", "")
        prev_value = (item.get("frmtrm_amount") or "0").replace(",", "")
        try:
            result[account] = {
                "current": int(value) if value else 0,
                "previous": int(prev_value) if prev_value else 0,
            }
        except ValueError:
            pass
    return result


def _mock_financial_data(corp_code: str, year: str) -> dict:
    return {
        "매출액": {"current": 2_365_000_000_000, "previous": 2_020_000_000_000},
        "영업이익": {"current": 65_000_000_000, "previous": -4_580_000_000_000},
        "당기순이익": {"current": 50_000_000_000, "previous": -9_000_000_000_000},
        "자산총계": {"current": 220_000_000_000_000, "previous": 210_000_000_000_000},
        "부채총계": {"current": 80_000_000_000_000, "previous": 85_000_000_000_000},
        "자본총계": {"current": 140_000_000_000_000, "previous": 125_000_000_000_000},
        "_note": "DART_API_KEY 미설정 — 샘플 데이터 (실제 값 아님)",
        "_corp_code": corp_code,
        "_year": year,
        # report_writer.py의 _mock_data_warning()이 재귀 탐색으로 감지하는 플래그.
        # krx_client.py의 mock 함수들은 이미 이 플래그를 달고 있었는데 이 함수는
        # _note 텍스트만 있어 탐지되지 않고 있었다(2026-08-11 보안 점검에서 발견).
        "is_mock": True,
    }


def _mock_dividend_data() -> dict:
    return {
        "현금배당수익률": "2.5%",
        "주당현금배당금": "1,440원",
        "_note": "샘플 데이터",
        "is_mock": True,
    }


def _mock_disclosures(corp_name: str) -> list:
    return [
        {
            "corp_name": corp_name,
            "report_nm": "분기보고서",
            "rcept_dt": now_kst().strftime("%Y%m%d"),
            "_note": "샘플 데이터",
            "is_mock": True,
        }
    ]
