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

# 주요 종목 DART 고유번호 매핑 (corp_code)
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
}

# 종목코드 → 사명 역매핑
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
}


async def fetch_financial_statements(corp_code: str, year: str, report_type: str = "11011") -> dict:
    """
    재무제표 조회 (단일 회사 주요계정)
    report_type: 11011=사업보고서, 11012=반기보고서, 11013=1분기, 11014=3분기
    """
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
    """기업 기본 정보 조회"""
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
    """배당 정보 조회"""
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
    """대주주 현황 조회"""
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
    """최근 공시 검색"""
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
    """DART 재무데이터 파싱"""
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


# ── Mock 데이터 (API 키 없을 때 / 개발·테스트용) ───────────────────────

def _mock_financial_data(corp_code: str, year: str) -> dict:
    """실제 DART API 키 없을 때 사용하는 샘플 구조 반환"""
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
