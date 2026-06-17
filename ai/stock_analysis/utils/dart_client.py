"""
DART(전자공시시스템) OpenAPI 클라이언트
https://opendart.fss.or.kr/
"""

import os
import asyncio
import aiohttp
import json
from datetime import datetime, timedelta
from typing import Optional

DART_API_KEY = os.getenv("DART_API_KEY", "")
DART_BASE_URL = "https://opendart.fss.or.kr/api"

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
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
                if data.get("status") == "000":
                    return _parse_financial_statements(data.get("list", []))
                return {"error": data.get("message", "DART API 오류")}
    except Exception as e:
        return {"error": str(e)}


async def fetch_company_info(corp_code: str) -> dict:
    if not DART_API_KEY:
        return _mock_company_info(corp_code)

    url = f"{DART_BASE_URL}/company.json"
    params = {"crtfc_key": DART_API_KEY, "corp_code": corp_code}

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
                return data if data.get("status") == "000" else {"error": data.get("message")}
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
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
                return data if data.get("status") == "000" else {"error": data.get("message")}
    except Exception as e:
        return {"error": str(e)}


async def fetch_major_shareholders(corp_code: str, year: str) -> dict:
    if not DART_API_KEY:
        return _mock_shareholders_data()

    url = f"{DART_BASE_URL}/hyslrSttus.json"
    params = {
        "crtfc_key": DART_API_KEY,
        "corp_code": corp_code,
        "bsns_year": year,
        "reprt_code": "11011",
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
                return data if data.get("status") == "000" else {"error": data.get("message")}
    except Exception as e:
        return {"error": str(e)}


async def search_disclosures(corp_name: str, days: int = 30) -> list:
    if not DART_API_KEY:
        return _mock_disclosures(corp_name)

    end_date = datetime.now().strftime("%Y%m%d")
    start_date = (datetime.now() - timedelta(days=days)).strftime("%Y%m%d")

    url = f"{DART_BASE_URL}/list.json"
    params = {
        "crtfc_key": DART_API_KEY,
        "corp_name": corp_name,
        "bgn_de": start_date,
        "end_de": end_date,
        "page_count": 20,
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
                return data.get("list", []) if data.get("status") == "000" else []
    except Exception as e:
        return []


def _parse_financial_statements(items: list) -> dict:
    result = {}
    for item in items:
        account = item.get("account_nm", "")
        value = item.get("thstrm_amount", "0").replace(",", "")
        prev_value = item.get("frmtrm_amount", "0").replace(",", "")
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
    }


def _mock_company_info(corp_code: str) -> dict:
    name = next((k for k, v in CORP_CODES.items() if v == corp_code), "Unknown")
    return {
        "corp_name": name,
        "corp_code": corp_code,
        "stock_code": "000000",
        "ceo_nm": "대표이사명",
        "induty_code": "제조업",
        "_note": "샘플 데이터",
    }


def _mock_dividend_data() -> dict:
    return {"현금배당수익률": "2.5%", "주당현금배당금": "1,440원", "_note": "샘플 데이터"}


def _mock_shareholders_data() -> dict:
    return {
        "최대주주": "이재용 외",
        "지분율": "21.0%",
        "_note": "샘플 데이터",
    }


def _mock_disclosures(corp_name: str) -> list:
    return [
        {
            "corp_name": corp_name,
            "report_nm": "분기보고서",
            "rcept_dt": datetime.now().strftime("%Y%m%d"),
            "_note": "샘플 데이터",
        }
    ]
