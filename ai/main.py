import asyncio
import hashlib
import hmac
import os
import re
import glob as _glob
from datetime import datetime as _datetime
from typing import Dict, Optional
from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.responses import StreamingResponse, HTMLResponse, Response, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

import memory as mem
import budget_store as budget
import llm
import search as srch
import backup as bkp
import law_search as law
import calculator as calc
import intent_agent

# ── 사용자 입력 전처리: 띄어쓰기 복합어 → 붙여쓰기 (질의 조인) ─────
# engine.py에도 이름이 비슷한 _COMPOUND_MAP이 있어 중복처럼 보이지만 방향이
# 반대다 — engine.py 쪽은 색인/검색 시 "붙여쓰기 → 띄어쓰기"로 토큰을 분해하고,
# 여기 _QUERY_JOIN_MAP은 사용자가 직접 입력한 "띄어쓰기 → 붙여쓰기"로 질의 자체를
# 정규화한다. 실측 결과(21개 항목 전수) 이 조인 단계를 건너뛰면 검색 점수가
# 동일하거나(4건) 최대 19배까지 떨어짐(17건, 예: "권고 사직" 0.76→0.04) —
# KB의 q 필드가 붙여쓰기(compact) 위주로 저장돼 있어 q필드 5배 가중치의 이득을
# 그대로 받으려면 질의도 붙여쓰기여야 하기 때문. 두 맵은 서로를 대체하지 않는
# 별개의 보완 단계이므로 통합하지 않는다(2026-07-09 QA로 확인).
_QUERY_JOIN_MAP = [
    ('희망 퇴직', '희망퇴직'), ('권고 사직', '권고사직'), ('정리 해고', '정리해고'),
    ('부당 해고', '부당해고'), ('연장 근로', '연장근로'), ('야간 근로', '야간근로'),
    ('주휴 수당', '주휴수당'), ('연차 수당', '연차수당'), ('최저 임금', '최저임금'),
    ('육아 휴직', '육아휴직'), ('출산 휴가', '출산휴가'), ('근로 계약', '근로계약'),
    ('퇴직 금', '퇴직금'), ('퇴직 연금', '퇴직연금'), ('4대 보험', '4대보험'),
    ('임금 체불', '임금체불'), ('직장 내', '직장내'), ('통상 임금', '통상임금'),
    ('포괄 임금', '포괄임금'), ('연봉 협상', '연봉협상'), ('성과 급', '성과급'),
]

def _normalize_query(text: str) -> str:
    """사용자가 띄어쓰기로 입력한 복합어를 붙여서 KB 검색 정확도 향상"""
    result = text
    for spaced, compact in _QUERY_JOIN_MAP:
        result = result.replace(spaced, compact)
    return result


def _parse_answer_header(answer: str):
    """답변 첫 줄에서 (제목, 출처) 추출. Returns (title, citation)."""
    first_line = answer.split('\n')[0].strip().rstrip(':').strip()
    m = re.search(r'\((.+)\)\s*$', first_line)
    if m:
        citation = m.group(1)
        title = first_line[:m.start()].strip()
        return title, citation
    return first_line, ""


def _split_kb_answer(a: str) -> tuple:
    """저장된 KB 답변에서 (제목, 출처, 본문)을 분리. 첫 줄이 제목(+괄호 출처), 나머지가 본문.
    KB 답변 3곳(company 복수결과·단일결과, 계산결과 보충)에서 동일 파싱이
    중복 구현되어 있던 것을 통합."""
    title, cite = _parse_answer_header(a)
    body = '\n'.join(a.split('\n')[1:]).lstrip('\n')
    return title, cite, body


def _format_kb_header(title: str, cite: str) -> str:
    header = f"**{title}**"
    if cite:
        header += f"\n📌 출처: {cite}"
    return header


def _format_company_results(top_results: list, best_score: float) -> str:
    """company 페르소나: 관련 규정 복수 결과 + 출처 포맷.
    - 1위 점수의 40% 이상 항목 최대 4개 표시
    - 각 항목에 제목·출처·본문 구분 표시
    """
    if not top_results:
        return ""

    # 관련 항목 필터: 1위 점수의 40% 이상, 최소 0.10
    rel_min = max(best_score * 0.40, 0.10)
    filtered = [(q, a, s) for q, a, s in top_results if s >= rel_min][:4]
    if not filtered:
        filtered = [top_results[0]]

    if len(filtered) == 1:
        q, a, s = filtered[0]
        title, cite, body = _split_kb_answer(a)
        header = _format_kb_header(title, cite)
        return header + "\n\n" + body if body else a

    SEP = "─" * 22
    parts = [f"📋 **관련 규정 {len(filtered)}건** 검색됨\n"]
    for i, (q, a, s) in enumerate(filtered, 1):
        title, cite, body = _split_kb_answer(a)
        header = f"{SEP}\n**{i}. {title}**"
        if cite:
            header += f"\n📌 출처: {cite}"
        parts.append(header + "\n\n" + (body if body else a))

    return '\n'.join(parts)


def _company_rule_supplement(query: str) -> str:
    """직접 계산(CALC) 결과에 붙일 사내 취업규칙 보충 섹션.
    company KB에서 관련 규정을 찾으면 본문과 출처를 표시. 없으면 빈 문자열."""
    try:
        kb = mem.retrieve_best(query, n=3, persona_id="company")
    except Exception:
        return ""
    if kb["best_score"] >= 0.15 and kb["top_answer"]:
        title, cite, body = _split_kb_answer(kb["top_answer"])
        body = body or kb["top_answer"]
        return (
            "\n\n---\n### 📋 회사 취업규칙 관련 규정\n"
            + _format_kb_header(title, cite) + "\n\n"
            + body[:600]
            + f"\n\n📚 사내 규정 KB 검색 결과 (유사도 {kb['best_score']:.2f})"
            + " · 법정 기준과 다른 경우 근로자에게 유리한 쪽이 적용됩니다."
        )
    return ""


_GENERIC_RULE_NOTE = (
    "\n\n> 회사 취업규칙이 법정 기준보다 유리하게 정한 경우 취업규칙이 우선 적용됩니다. "
    "(학습된 사내 규정에서 관련 조항을 찾지 못해 법정 기준으로만 계산했습니다.)"
)


from personas import PERSONAS, DEFAULT_PERSONA, classify_personas, build_combined_persona
from stock_analysis.stock_api import router as stock_router

mem.init_db()

# 지식베이스는 engine.py의 _load_knowledge()가 자동 로드 (중복 로드 제거)
# → main.py에서 별도 load_knowledge() 호출 불필요

# ── 영속 디스크 점검 ──────────────────────────────────
# DB_PATH가 마운트된 영속 볼륨을 가리키지 않으면, 재배포·재시작 시
# 컨테이너 파일시스템이 초기화되면서 학습된 RAG 데이터가 전부 사라진다.
# (Railway/Render 등은 명시적으로 Volume을 만들고 마운트 경로를 DB_PATH로
# 지정해야 데이터가 유지됨 — 기본값은 앱 디렉토리 내부 임시 경로)
if not os.getenv("DB_PATH") and not (os.getenv("TURSO_DATABASE_URL") and os.getenv("TURSO_AUTH_TOKEN")):
    print(
        "⚠️  DB_PATH 환경변수가 설정되지 않았습니다. "
        "현재 DB는 앱 디렉토리 내부에 저장되어 재배포 시 초기화됩니다. "
        "영속 볼륨을 마운트하고 DB_PATH=<마운트경로>/memory.db 를 설정하거나, "
        "TURSO_DATABASE_URL + TURSO_AUTH_TOKEN으로 Turso 클라우드 DB를 사용하세요."
    )

if bkp.gdrive_configured() and not os.getenv("GDRIVE_TOKEN_PATH"):
    print(
        "⚠️  GDRIVE_TOKEN_PATH 환경변수가 설정되지 않아 Google Drive 연동 토큰이 "
        "기본값(/tmp/gdrive_token.json)에 저장됩니다. 컨테이너 재시작·재배포 시 /tmp가 "
        "초기화되는 배포 환경(Render/Railway 등)에서는 매번 Google 계정 재연동이 필요합니다. "
        "영속 볼륨 경로로 GDRIVE_TOKEN_PATH=<마운트경로>/gdrive_token.json 을 설정하세요."
    )

BACKUP_TOKEN = os.getenv("BACKUP_TOKEN", "")
if not BACKUP_TOKEN:
    print(
        "⚠️  BACKUP_TOKEN 환경변수가 설정되지 않았습니다. "
        "/backup/*, /admin/* (DB 이관·학습데이터 조회/삭제·공유링크 관리), "
        "/budget/* (예산 조회·수정·삭제), /history 삭제 기능이 "
        "모두 503으로 비활성화됩니다(fail-closed — 설정 누락 시 열리지 않고 닫힙니다). "
        "소유자 채팅도 비활성화되며, 유효한 공유 링크 채팅만 별도 접근키로 동작합니다. "
        "BACKUP_TOKEN을 설정한 뒤 소유자 채팅은 X-Admin-Token 헤더, 관리 API는 "
        "?token=<값>으로 인증하세요."
    )


def _require_backup_token(token: str = "", credential_label: str = "token 파라미터") -> None:
    # fail-closed: BACKUP_TOKEN이 설정되지 않았으면 "검사 통과"가 아니라 "거부"다.
    # 이전에는 `if BACKUP_TOKEN and ...` 라서 토큰 미설정 시 조건이 통째로 거짓이 되어
    # 게이팅된 줄 알았던 /admin/import-db(DB 통째 교체)·/backup/download(전체 DB 유출)까지
    # 전부 무인증으로 열려 있었다(2026-08-10 실배포에서 BACKUP_TOKEN 미설정 확인).
    # 보안 검사는 설정 누락 시 열리는 쪽이 아니라 닫히는 쪽으로 실패해야 한다.
    if not BACKUP_TOKEN:
        raise HTTPException(
            503,
            "서버에 BACKUP_TOKEN이 설정되지 않아 이 기능은 비활성화되어 있습니다. "
            "환경변수 BACKUP_TOKEN을 설정한 뒤 ?token=<값> 으로 요청하세요.",
        )
    if not hmac.compare_digest(token, BACKUP_TOKEN):
        raise HTTPException(401, f"유효한 {credential_label}가 필요합니다.")


def _owner_session_scope(session_id: str) -> str:
    return "owner:" + mem._safe_session_id(session_id)


def _share_session_scope(share_token: str, session_id: str) -> str:
    # 공유 토큰 원문을 대화 DB에 남기지 않고 안정적인 범위 키만 만든다.
    token_hash = hashlib.sha256(share_token.encode("utf-8")).hexdigest()[:20]
    return f"share:{token_hash}:" + mem._safe_session_id(session_id)


def _require_owner_header(request: Request) -> None:
    """일반 채팅은 URL에 토큰을 노출하지 않고 헤더로 소유자를 인증."""
    _require_backup_token(
        request.headers.get("X-Admin-Token", ""), "X-Admin-Token 헤더"
    )


# 업로드 파일 크기 상한. 이전에는 아무 제한 없이 `await file.read()`로 전체를 메모리에
# 올려, 큰 파일 하나로 프로세스 메모리를 소진시킬 수 있었다(Render Free는 512MB).
# 엑셀/문서 업로드 실사용 크기를 크게 웃도는 값으로 잡되, 무제한은 막는다.
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "20"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024


async def _read_upload_limited(file) -> bytes:
    """업로드 본문을 상한까지만 읽는다. 상한을 넘으면 413으로 거부."""
    chunks, total = [], 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(
                413,
                f"업로드 파일이 너무 큽니다(최대 {MAX_UPLOAD_MB}MB). "
                f"파일을 나누거나 MAX_UPLOAD_MB 환경변수를 조정하세요.",
            )
        chunks.append(chunk)
    return b"".join(chunks)


app = FastAPI(title="나만의 AI 어시스턴트")
@app.middleware("http")
async def no_cache_html(request, call_next):
    """HTML은 항상 최신 배포 코드가 로드되도록 캐시 금지 (iPad PWA 스테일 캐시 방지)"""
    response = await call_next(request)
    if request.url.path.endswith(".html") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    return response

app.mount("/static", StaticFiles(directory="static"), name="static")

# 주식 분석 라우터 등록 (/stock/...)
app.include_router(stock_router)
print("✅ 주식 분석 시스템 로드 완료 (/stock/* 엔드포인트)")


# ── 페르소나 ──────────────────────────────────────────

@app.get("/personas")
def list_personas():
    return {"personas": list(PERSONAS.values())}


# ── 채팅 ──────────────────────────────────────────────

# 메시지 길이 상한 — 검증 없이 그대로 검색·LLM 파이프라인에 흘려보내면 초대형 메시지
# 1건(예: 32,000자)이 이벤트루프를 30~90초 이상 점유해 전체 앱(다른 요청 포함)이
# 멈추는 DoS가 QA로 재현됨(main.py의 여러 블로킹 구간 run_in_executor 수정과는
# 별개로, 애초에 이런 크기의 입력 자체를 막는 검증이 없었음)
_MAX_CHAT_MESSAGE_LEN = 4000


class ChatRequest(BaseModel):
    message: str
    persona: str = DEFAULT_PERSONA
    use_search: bool = False
    thinking_mode: str = "off"  # "off" | "prompt" | "deep"
    share_token: str = ""  # 공유 링크로 접속한 방문자의 토큰 (비어있으면 소유자 세션)
    session_id: str = "legacy"

# ── 주식 분석 파이프라인 트리거 키워드 ──────────────────
_STOCK_PIPELINE_KEYWORDS = [
    "분석 보고서", "보고서 생성", "보고서 만들어", "보고서만들어", "전체 분석", "분석 실행",
    "종목 분석해", "분석해줘", "분석 부탁", "분석 시작", "지금 분석",
    "리포트", "report", "오늘 장", "오늘 분석",
    "오늘 주요", "오늘주요", "증감 사유", "증감사유", "주가 현황", "주가현황",
    "시장 현황", "시장현황", "장 현황", "장현황", "주식 현황", "주식현황",
    "시황 분석", "시황분석", "오늘 시황", "오늘시황", "현재 시장", "현재시장",
]

# ── 증권사 리포트 단독 조회 트리거 키워드 ──────────────────
_BROKER_REPORT_KEYWORDS = [
    "증권사 리포트", "증권사리포트", "애널리스트 리포트", "애널리스트리포트",
    "증권 리포트", "리서치 리포트", "목표주가 컨센서스", "컨센서스 조회",
    "증권사 의견", "증권사의견", "애널리스트 의견", "리포트 찾아",
]

def _is_broker_report_request(text: str) -> bool:
    t = text.replace(" ", "")
    return any(kw.replace(" ", "") in t for kw in _BROKER_REPORT_KEYWORDS)

# ── 저가주 스크리닝 트리거 키워드 ────────────────────────
_LOWPRICE_KEYWORDS = [
    "만원 미만", "만원미만", "저가주", "소액주", "저평가 주", "저평가주",
    "싼 주식", "싼주식", "10000원 이하", "1만원 이하", "1만원미만",
    "저평가 종목", "저평가종목", "저평가 찾아", "저평가찾아",
    "저평가된 종목", "저평가된종목", "저평가된 항목", "저평가된항목",
    "저평가 항목", "저평가항목", "저평가 주식", "저평가주식",
    "저평가 발굴", "저평가발굴", "저평가 추천", "저평가추천",
    "숨겨진 종목", "숨겨진종목", "가치주", "소형주 저평가",
]

def _is_stock_pipeline_request(text: str) -> bool:
    t = text.replace(" ", "")
    return any(kw.replace(" ", "") in t for kw in _STOCK_PIPELINE_KEYWORDS)

def _stock_name_with_request(text: str) -> bool:
    """종목명 + 조회/분석 의도 동사 조합이면 파이프라인 트리거
    예: 'LG전자 확인해줘', '삼성전자 어때?', '현대차 투자해도 돼?'
    """
    from stock_analysis.utils.dart_client import CORP_CODES
    text_norm = text.replace(" ", "")
    has_stock = any(name.replace(" ", "") in text_norm for name in CORP_CODES)
    if not has_stock:
        return False
    _INTENT = [
        "확인", "봐줘", "봐", "알려줘", "알려", "보여줘", "보여",
        "어때", "어떤가", "어떨", "어떻", "어떠",
        "투자", "매수", "매도", "살까", "팔까", "사야", "팔아야",
        "추천", "전망", "예측", "주가", "시세", "현재가", "목표가",
        "괜찮", "좋아", "올라", "내려", "상승", "하락",
        "담아", "빠져", "들어가", "뺄까", "체크",
    ]
    return any(v in text for v in _INTENT)

def _is_lowprice_screen_request(text: str) -> bool:
    t = text.replace(" ", "")
    return any(kw.replace(" ", "") in t for kw in _LOWPRICE_KEYWORDS)


def _parse_won_amount(text: str) -> Optional[int]:
    """'1만원', '5천원', '1만5천원', '20000원' 형태의 금액 표현을 원 단위 정수로 변환"""
    t = text.replace(",", "").replace(" ", "")
    m = re.search(r'(\d+(?:\.\d+)?)만(?:(\d+(?:\.\d+)?)천)?원', t)
    if m:
        amount = float(m.group(1)) * 10_000
        if m.group(2):
            amount += float(m.group(2)) * 1_000
        return int(amount)
    m = re.search(r'(\d+(?:\.\d+)?)천원', t)
    if m:
        return int(float(m.group(1)) * 1_000)
    m = re.search(r'(\d+)원', t)
    if m:
        return int(m.group(1))
    return None


_RELAX_KEYWORDS = [
    "상향", "올려", "올리", "완화", "느슨", "넓게", "넓혀", "늘려",
    "늘리", "더 많이", "여유있게", "범위 넓", "범위넓",
]
_TIGHTEN_KEYWORDS = [
    "하향", "낮춰", "낮추", "엄격", "좁게", "좁혀", "줄여", "줄이",
    "더 적게", "타이트", "범위 좁", "범위좁",
]


def _parse_lowprice_params(text: str) -> Optional[Dict]:
    """사용자 메시지에서 저평가 스크리닝 기준(가격 상한·PBR·PER)을 추출
    1) 절대값 표현 우선: '5천원 이하 저평가주', 'PBR 1 이하', 'PER 10 이하인 저평가 종목'
    2) 절대값이 없으면 상대 조정 표현 처리: '기준 상향 조정', '조건 완화', '더 엄격하게' 등
       → 기존 결과가 0건이거나 너무 적을 때 기준 자체(만원/PBR/PER)를 넓히거나 좁혀달라는 의도
    명시/추론되지 않은 항목은 low_price_screener.DEFAULT_PARAMS 값을 그대로 사용
    """
    from stock_analysis.utils.low_price_screener import DEFAULT_PARAMS

    params: Dict = {}

    price_m = re.search(r'([0-9,]+\s*(?:만\s*\d*\s*천?|천)?\s*원)\s*(이하|미만|이내)', text)
    if price_m:
        amount = _parse_won_amount(price_m.group(1))
        if amount:
            params["max_price"] = amount

    pbr_m = re.search(r'PBR\s*([\d.]+)\s*(이하|미만)', text, re.IGNORECASE)
    if pbr_m:
        params["max_pbr"] = float(pbr_m.group(1))

    per_m = re.search(r'PER\s*([\d.]+)\s*(이하|미만)', text, re.IGNORECASE)
    if per_m:
        params["max_per"] = float(per_m.group(1))

    if params:
        return params

    # 절대값이 없을 때만 상대 조정 키워드로 기준 자체를 넓히거나(완화) 좁힘(강화)
    if any(kw in text for kw in _RELAX_KEYWORDS):
        if "max_price" not in params:
            params["max_price"] = int(DEFAULT_PARAMS["max_price"] * 1.5)
        params["max_pbr"] = round(DEFAULT_PARAMS["max_pbr"] * 1.5, 2)
        params["max_per"] = round(DEFAULT_PARAMS["max_per"] * 1.3, 1)
    elif any(kw in text for kw in _TIGHTEN_KEYWORDS):
        if "max_price" not in params:
            params["max_price"] = int(DEFAULT_PARAMS["max_price"] * 0.7)
        params["max_pbr"] = round(DEFAULT_PARAMS["max_pbr"] * 0.7, 2)
        params["max_per"] = round(DEFAULT_PARAMS["max_per"] * 0.7, 1)

    return params or None

_STOCK_REPORTS_DIR = os.path.join(os.path.dirname(__file__), "stock_analysis", "reports")
_ANSWERS_DIR = os.path.join(os.path.dirname(__file__), "stock_analysis", "reports", "answers")
os.makedirs(_ANSWERS_DIR, exist_ok=True)


def _summarize_long_text(content: str, label: str, max_chars: int = 3500) -> str:
    """답변 원문이 너무 길면 앞부분만 보여주고 전체는 파일로 저장해 다운로드 링크로 제공"""
    if len(content) <= max_chars:
        return content
    ts = _datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_label = re.sub(r"[^0-9A-Za-z가-힣_-]", "", label)[:30] or "answer"
    filename = f"answer_{safe_label}_{ts}.txt"
    with open(os.path.join(_ANSWERS_DIR, filename), "w", encoding="utf-8") as f:
        f.write(content)
    head = content[:max_chars].rstrip()
    return (
        f"{head}\n\n...(내용이 길어 핵심만 표시했습니다)\n\n---\n"
        f"[⬇️ 전체 내용 다운로드 ({filename})](/answer/download/{filename})"
    )


async def _stream_chunks(text: str, chunk_size: int = 150):
    """긴 텍스트를 chunk_size 단위로 잘라 순차 yield — /chat generate()의
    여러 응답 경로(계산 결과, KB 직접 답변, 무응답 안내 등)에서 동일한
    'chunk_size만큼 잘라 스트리밍' 로직이 반복 구현되어 있던 것을 통합."""
    for i in range(0, len(text), chunk_size):
        yield text[i:i + chunk_size]
        await asyncio.sleep(0)


def _ticker_for_name(name: str) -> str:
    """종목명 → ticker 역방향 조회. STOCK_CODE_MAP은 지연 import(패키지 전체를
    미리 로드하지 않기 위함)라 여러 곳에서 반복 구현되어 있던 것을 통합."""
    from stock_analysis.utils.dart_client import STOCK_CODE_MAP
    return next((k for k, v in STOCK_CODE_MAP.items() if v == name), "")


def _format_reference_links(items: list, max_items: int = 5) -> str:
    """[{title,url}] 형태의 참고 자료 목록을 마크다운 링크 섹션으로 변환.
    클릭 시 해당 페이지로 바로 이동하도록 target=_blank 처리(프론트엔드 renderMd에서 적용)."""
    from urllib.parse import urlparse
    seen, links = set(), []
    for it in items:
        url = str(it.get("url") or "").strip()
        if not url or not url.startswith("http") or url in seen:
            continue
        seen.add(url)
        raw_title = str(it.get("title") or "").strip().replace("\n", " ")
        if raw_title:
            title = raw_title[:70]
        else:
            # 타이틀 없으면 도메인명을 표시
            try:
                domain = urlparse(url).netloc.removeprefix("www.")
            except Exception:
                domain = url[:40]
            title = domain
        links.append(f"- [{title}]({url})")
        if len(links) >= max_items:
            break
    if not links:
        return ""
    return "\n\n---\n📎 **참고 자료** (클릭하면 해당 페이지로 이동)\n" + "\n".join(links)

def _load_latest_stock_report(max_chars: int = 8000) -> str:
    """저장된 가장 최신 보고서를 로드해 컨텍스트로 반환"""
    if not os.path.isdir(_STOCK_REPORTS_DIR):
        return ""
    files = sorted(
        _glob.glob(os.path.join(_STOCK_REPORTS_DIR, "report_*.txt")),
        reverse=True,
    )
    if not files:
        return ""
    try:
        with open(files[0], encoding="utf-8") as f:
            content = f.read()
        return content[:max_chars]
    except Exception:
        return ""

def _list_stock_reports() -> list:
    """저장된 보고서 파일 목록 반환 (최신순)"""
    if not os.path.isdir(_STOCK_REPORTS_DIR):
        return []
    files = sorted(
        _glob.glob(os.path.join(_STOCK_REPORTS_DIR, "report_*.txt")),
        reverse=True,
    )
    return [os.path.basename(f) for f in files[:20]]

def _extract_stock_targets(text: str) -> list:
    """메시지에서 종목명 추출 — 없으면 빈 리스트 반환"""
    from stock_analysis.utils.dart_client import CORP_CODES
    # 공백 정규화: "LG 전자" → "LG전자" 매칭
    text_norm = text.replace(" ", "").replace(" ", "")
    # 긴 이름 우선 정렬 (구체적 매칭이 짧은 substring보다 먼저)
    candidates = sorted(CORP_CODES.keys(), key=len, reverse=True)
    matched, matched_norm = [], []
    for name in candidates:
        name_norm = name.replace(" ", "")
        if name_norm in text_norm:
            # 이미 매칭된 더 구체적인 이름의 부분집합이면 제외 ("LG" < "LG전자")
            if not any(name_norm in m for m in matched_norm):
                matched.append(name)
                matched_norm.append(name_norm)
    return matched


def _extract_report_section(lines: list, header_keywords: list, max_lines: int = 20) -> list:
    """'【 ... 】' 헤더로 시작하는 보고서 섹션 하나를 키워드로 찾아 추출"""
    out = []
    in_section = False
    for line in lines:
        is_header = line.strip().startswith("【")
        if is_header and any(kw in line for kw in header_keywords):
            in_section = True
        elif is_header and in_section:
            break  # 다음 섹션 시작 → 종료
        if in_section:
            out.append(line)
            if len(out) >= max_lines:
                break
    return out


def _top_n_stock_detail_lines(lines: list, n: int = 3) -> list:
    """'종목별 상세 분석' 섹션(매매시점 종합점수 내림차순 정렬됨, report_writer.py 참고)에서
    상위 n개 종목의 상세 블록만 추출 — AI 투자의견 narrative, 매수/매도구간, 손절기준,
    핵심근거 등 표에는 없는 구체적 내용이 여기에만 있는데, 특정 종목을 지목하지 않은
    일반 "현황" 질문에서는 지금까지 전혀 노출되지 않고 있었음."""
    out = []
    in_section = False
    stock_count = 0
    for line in lines:
        is_header = line.strip().startswith("【")
        if is_header and "종목별 상세 분석" in line:
            in_section = True
            continue
        elif is_header and in_section:
            break
        if in_section:
            if line.strip().startswith("▶"):
                stock_count += 1
                if stock_count > n:
                    break
            out.append(line)
    return out


def _summarize_stock_report(report: str, targets: list) -> str:
    """전체 보고서에서 핵심 요약만 추출해 채팅용 답변 생성
    종합 요약뿐 아니라 TOP 추천 종목·저평가 종목도 항상 포함시켜
    채팅 응답의 중간 내용(추천 종목 등)이 비지 않도록 한다."""
    lines = report.splitlines()
    _reports = _list_stock_reports()
    filename = _reports[0] if _reports else None
    if filename:
        download_hint = (
            f"\n\n---\n"
            f"[⬇️ 상세 분석 보고서 전체 다운로드 ({filename})](/stock/download/{filename})"
        )
    else:
        download_hint = ""

    summary_lines = _extract_report_section(lines, ["Executive Summary", "종합 요약"], max_lines=15)
    market_lines = _extract_report_section(lines, ["시장 환경"], max_lines=20)
    top_picks_lines = _extract_report_section(lines, ["TOP 추천 종목"], max_lines=15)
    undervalued_lines = _extract_report_section(lines, ["저평가 종목"], max_lines=15)
    broker_lines = _extract_report_section(lines, ["증권사 애널리스트 리포트"], max_lines=15)
    # 특정 종목을 지목하지 않은 일반 질문에서도 TOP 추천 종목 표만 보여주고 끝나지 않도록,
    # 매매시점 점수 상위 3개 종목은 AI 투자의견·매수/매도구간·손절기준까지 상세 노출
    top_detail_lines = [] if targets else _top_n_stock_detail_lines(lines, n=3)
    # "오늘 뭘 해야 하나"에 대한 구체적 답 — AI 액션 플랜(있으면)·매수 검토 종목·손절 원칙·
    # 모니터링 포인트가 이 섹션에만 있는데 지금까지 표만 보여주고 끝나 막연했던 부분
    action_lines = _extract_report_section(lines, ["오늘의 행동 계획", "Action Plan"], max_lines=20)

    # 요청 종목 관련 섹션 추출
    target_lines = []
    if targets:
        current_target = None
        for line in lines:
            for t in targets:
                if t in line and ("【" in line or "■" in line or "▶" in line):
                    current_target = t
                    target_lines.append(line)
                    break
            else:
                if current_target and target_lines:
                    target_lines.append(line)
                    # 5줄이면 다음 종목으로
                    if len(target_lines) > 8:
                        current_target = None

    # 조합 — 종합 요약 + TOP 추천 종목 + 저평가 종목은 항상 포함
    # 특정 종목을 지목하지 않은 일반 "현황" 질문일 때는 시장 환경·증권사 컨센서스·
    # 상위 종목 상세(AI 투자의견·매수매도구간·손절기준)·오늘의 행동 계획도 추가해
    # 표만 나열된 막연한 요약이 아니라 실제 구체적 근거·행동 지침이 담긴 답변이 되도록 함
    parts = []
    if summary_lines:
        parts.append("\n".join(summary_lines).strip())
    if not targets and market_lines:
        parts.append("\n".join(market_lines).strip())
    if top_picks_lines:
        parts.append("\n".join(top_picks_lines).strip())
    if undervalued_lines:
        parts.append("\n".join(undervalued_lines).strip())
    if top_detail_lines:
        parts.append("【 핵심 종목 상세 (TOP 3) 】\n" + "\n".join(top_detail_lines).strip())
    if not targets and broker_lines:
        parts.append("\n".join(broker_lines).strip())
    if not targets and action_lines:
        parts.append("\n".join(action_lines).strip())
    if target_lines:
        parts.append("\n".join(target_lines[:20]).strip())

    if parts:
        body = "\n\n".join(parts)
    else:
        # fallback: 처음 30줄
        body = "\n".join(lines[:30])

    return body + download_hint


@app.post("/chat")
async def chat(req: ChatRequest, request: Request):
    user_msg = req.message.strip()
    if not user_msg:
        raise HTTPException(400, "메시지를 입력하세요.")
    if len(user_msg) > _MAX_CHAT_MESSAGE_LEN:
        raise HTTPException(
            400,
            f"메시지가 너무 깁니다 (최대 {_MAX_CHAT_MESSAGE_LEN}자, 현재 {len(user_msg)}자). "
            "긴 문서는 /learn/document 업로드를 이용해 주세요.",
        )

    # 복합어 정규화: "희망 퇴직" → "희망퇴직" 등 띄어쓰기 변형 통일
    search_msg = _normalize_query(user_msg)

    # 공유 링크 접속 시: 허용된 페르소나 목록으로 라우팅 범위를 제한
    allowed_personas = None
    is_shared_session = bool(req.share_token)
    if req.share_token:
        share = mem.get_share_link(req.share_token)
        if not share or not share["enabled"]:
            raise HTTPException(403, "유효하지 않은 공유 링크입니다.")
        if share["expires_at"] and share["expires_at"] < _datetime.now().isoformat():
            raise HTTPException(403, "만료된 공유 링크입니다.")
        allowed_personas = share["personas"]
        if req.persona != "auto" and req.persona not in allowed_personas:
            raise HTTPException(403, "이 공유 링크에서 사용할 수 없는 전문가입니다.")
        session_scope = _share_session_scope(req.share_token, req.session_id)
    else:
        _require_owner_header(request)
        session_scope = _owner_session_scope(req.session_id)

    # "auto"(통합 검색) 선택 시 질문 내용을 분석해 가장 적합한 전문 페르소나(들)로 자동 라우팅.
    # 여러 도메인에 걸친 질문(예: 인사+주식)이면 build_combined_persona로 종합 답변 생성.
    # persona_id는 KB/대화이력 저장 등 단일 키가 필요한 곳에 쓰는 대표(1순위) 도메인.
    persona_id = req.persona
    matched_persona_ids = [persona_id]
    if persona_id == "auto":
        matched_persona_ids = classify_personas(search_msg)
        if allowed_personas is not None:
            # 공유 링크 허용 범위와 교집합만 채택, 없으면 허용 목록의 첫 번째로 폴백
            restricted = [p for p in matched_persona_ids if p in allowed_personas]
            matched_persona_ids = restricted or [allowed_personas[0]]
        persona_id = matched_persona_ids[0]

    from datetime import date as _date
    today = _date.today()

    def _build_persona_context(ids: list):
        """matched_persona_ids → (persona, persona_features, stock_mode, system_with_date).
        company KB 우선 라우팅 전환 시에도 동일 로직을 재사용해 두 곳에서
        따로 구현되어 있던 중복을 통합."""
        p = build_combined_persona(ids)
        feats = p.get("features", {})
        return p, feats, feats.get("stock_mode", False), (
            p["system_prompt"]
            + f"\n\n오늘 날짜: {today.strftime('%Y년 %m월 %d일')} ({today.year}년)"
        )

    persona, persona_features, stock_mode, system_with_date = _build_persona_context(matched_persona_ids)

    # 페르소나에 deep_thinking 설정 시 thinking 모드 자동 활성화 (사용자가 off로 두더라도)
    effective_thinking_mode = req.thinking_mode
    if persona_features.get("deep_thinking") and req.thinking_mode == "off":
        effective_thinking_mode = "prompt"

    # ── 0단계: Python 직접 계산 (날짜·금액 기반 HR 계산 질문) ─
    # LLM / KB 상태에 무관하게 정확한 수치를 계산해 반환
    # (연차·퇴직금·실수령액·연장수당·주휴수당·최저임금·4대보험 등)
    direct_calc = calc.try_any_calc(user_msg)
    # 계산 결과에 사내 취업규칙 보충: KB에 관련 규정이 있으면 본문 표시,
    # 없으면 연차 계산에 한해 일반 안내 문구 (그 외 계산은 취업규칙 무관한 경우가 많아 생략)
    if direct_calc:
        _rule_section = _company_rule_supplement(search_msg)
        if _rule_section:
            direct_calc += _rule_section
        elif calc.detect_annual_leave_query(user_msg):
            direct_calc += _GENERIC_RULE_NOTE

    # ── 0.5단계: 의도 분석 에이전트 ──────────────────────
    # 질문 의도를 파악해 검색 최적화 질의를 생성. 실패·타임아웃 시 원본 질의 그대로 사용.
    # 제외: 직접 계산 즉답 경로(지연 불필요), company 페르소나(사내 문서 전용 — 외부 LLM 미사용 정책)
    if direct_calc or persona_id == "company":
        intent_info = {"ok": False, "intent": "", "refined_query": user_msg, "keywords": [], "answer_guide": ""}
    else:
        intent_info = await intent_agent.analyze(user_msg, persona_id)
    refined_query = ""
    if intent_info.get("ok"):
        refined_query = _normalize_query(intent_info.get("refined_query", "").strip())

    # ── 1단계: 로컬 KB 검색 (정규화된 쿼리 사용) ────────
    kb = mem.retrieve_best(search_msg, n=6, persona_id=persona_id)
    # 정제 질의가 있으면 두 질의 중 KB 매칭 점수가 높은 쪽을 채택
    # (의도 분석이 빗나가도 원본 검색 결과보다 나빠지지 않도록 게이트)
    if refined_query and refined_query != search_msg:
        kb_refined = mem.retrieve_best(refined_query, n=6, persona_id=persona_id)
        if kb_refined["best_score"] >= kb["best_score"]:
            kb = kb_refined
            search_msg = refined_query  # 이후 법령/웹 검색도 정제 질의 사용
    rag_ctx     = kb["context"]
    best_score  = kb["best_score"]
    top_answer  = kb["top_answer"]
    top_results = kb.get("top_results", [])  # company 다중 결과용

    # ── company KB 우선 라우팅 ──────────────────────────
    # auto 분류가 일반 페르소나(hr 등)로 갔지만, 실제로는 사내 문서(company KB)에
    # 훨씬 정확한 답이 있는 경우 그쪽으로 전환. company는 자동분류 키워드에서
    # 의도적으로 제외되어 있어(개인정보·접근범위 이슈로 명시적 선택 원칙), 이 경우
    # "출장 규정" 같은 질문이 hr 페르소나로 떨어져 사내 규정과 무관한 일반 웹검색
    # 결과(예: 공무원 여비규정)로 답변되는 문제가 있었음 — company KB 매칭 점수가
    # 뚜렷하게 더 높을 때만(0.15 이상 & 현재 점수 초과) 전환해 오탐을 최소화.
    # 공유 링크 방문자에게는 링크 생성 시 명시적으로 company를 허용한 경우에만 전환
    _company_routing_allowed = allowed_personas is None or "company" in allowed_personas
    if req.persona == "auto" and persona_id != "company" and not stock_mode and _company_routing_allowed:
        kb_company = mem.retrieve_best(search_msg, n=6, persona_id="company")
        if kb_company["best_score"] >= 0.15 and kb_company["best_score"] > best_score:
            persona_id = "company"
            matched_persona_ids = ["company"]
            persona, persona_features, stock_mode, system_with_date = _build_persona_context(matched_persona_ids)
            kb = kb_company
            rag_ctx     = kb["context"]
            best_score  = kb["best_score"]
            top_answer  = kb["top_answer"]
            top_results = kb.get("top_results", [])

    # ── 2단계: law.go.kr 법령 검색 (법 관련 질문만, 페르소나 허용 시) ──────
    law_ctx = ""
    law_results = []  # 아래 reference_items 참조 시 항상 정의되어 있어야 함
    if persona_features.get("use_law", True) and law.is_law_question(search_msg):
        law_results = await law.search_law(search_msg)
        law_ctx = law.format_law_context(law_results)

    # ── 3단계: 인터넷 검색 ───────────────────────────────
    # 사용자가 명시 요청한 경우뿐 아니라, 로컬 KB 신뢰도가 낮을 때도 자동으로 보강 검색
    # (company는 사내 문서 전용 정책상 제외, stock은 자체 리포트/뉴스 수집 경로를 이미 사용)
    KB_CONTEXT = 0.10   # LLM 호출 시 컨텍스트 포함 기준 / 자동 웹검색 트리거 기준
    auto_web_search = (
        not req.use_search
        and not stock_mode
        and persona_id != "company"
        and best_score < KB_CONTEXT
    )
    search_ctx = ""
    results = []  # 아래 reference_items 참조 시 항상 정의되어 있어야 함
    if req.use_search or auto_web_search:
        # 채팅 중 검색 결과 원문은 검증 전 데이터이므로 즉시 장기기억에 쓰지 않는다.
        # 합성 답변만 기억 후보로 보내고, 검색 자체는 스레드에서 실행한다.
        results = await asyncio.get_event_loop().run_in_executor(
            None, lambda: srch.web_search(search_msg)
        )
        search_ctx = srch.format_search_context(results)

    # ── 주식 페르소나: 파이프라인 / 스크리닝 트리거 여부 판단 ────────
    # 공유 링크는 대화형 조회만 허용한다. 장시간·고비용 분석/스크리닝/리포트
    # 생성은 소유자 세션에서만 실행해 공유 URL을 통한 비용 유발을 막는다.
    run_stock_pipeline = not is_shared_session and stock_mode and (
        _is_stock_pipeline_request(user_msg) or _stock_name_with_request(user_msg)
    )
    run_lowprice_screen = (
        not is_shared_session and stock_mode and _is_lowprice_screen_request(user_msg)
    )
    run_broker_report = (
        not is_shared_session and stock_mode and _is_broker_report_request(user_msg)
    )

    # ── 신뢰도 판정 ───────────────────────────────────────
    # CALC       : Python 직접 계산 결과 있음 → 계산 결과 직접 서빙
    # KB (≥0.15) : 로컬 KB 직접 서빙 — LLM 호출 없음
    # CLAUDE(<0.15): KB에 없는 질문 → Claude 호출
    KB_DIRECT  = 0.15   # 이 점수 이상이면 KB로 직접 답변 (LLM 불필요)

    # company 페르소나: 학습된 규정에서만 답변, 외부 LLM 호출 금지
    # 중간 신뢰도(0.10~0.14)도 KB 직접 서빙 (임계값 낮춤)
    company_kb_only = (persona_id == "company")
    kb_threshold = KB_CONTEXT if company_kb_only else KB_DIRECT

    # law.go.kr에서 실시간 원문이 온 경우 → LLM 보강 (law_ctx 우선)
    has_law_rt  = bool(law_ctx)
    # company 페르소나: rag_ctx가 비어있어도 top_answer가 있으면 KB 직접 서빙 허용
    # (rag_ctx는 CONTEXT_ABS_MIN=0.15 미만에서 비워짐 → company의 0.10 임계값과 불일치 해소)
    # thinking 모드일 때는 항상 LLM을 거쳐야 <think> 블록이 생성됨
    _has_kb_answer = bool(rag_ctx) or (company_kb_only and bool(top_answer))
    kb_direct   = (
        best_score >= kb_threshold
        and _has_kb_answer
        and effective_thinking_mode == "off"
        and not has_law_rt
        and not bool(search_ctx)
        and not direct_calc
    )
    # 자동학습 항목 오염 방어: 자동학습/대화 출처 항목은 저장 당시 질문(q)이 사용자 질문과
    # 같아도 답변(a)이 다른 주제일 수 있음(과거 오답이 학습된 경우).
    # 질문 핵심 단어가 답변에 전혀 없으면 직접 서빙하지 않고 LLM 재생성 경로로 강등.
    if kb_direct and kb.get("top_source") in ("자동학습", "대화") \
            and not mem.topic_overlap(search_msg, top_answer):
        print(f"ℹ️ KB 직접 서빙 강등(자동학습 답변 주제 불일치): {search_msg[:50]}")
        kb_direct = False
    no_local    = (best_score < KB_CONTEXT) and not has_law_rt and not direct_calc and not bool(search_ctx)

    # stock 페르소나: 파이프라인 미실행 일반 Q&A → 저장된 보고서를 컨텍스트로 주입
    stock_report_ctx = ""
    if stock_mode and not run_stock_pipeline:
        stock_report_ctx = _load_latest_stock_report()

    # 페르소나별 대화 이력 분리: 다른 페르소나 대화가 현재 페르소나 LLM을 혼동시키는 것을 방지
    history = mem.get_recent_messages(10, persona=persona_id, session_id=session_scope)
    history.append({"role": "user", "content": user_msg})

    async def generate():
        collected = []
        try:
            # ── 경로 STOCK: 주식 분석 파이프라인 실행 ────────
            if run_stock_pipeline:
                from stock_analysis.pipeline import run_once as stock_run_once
                targets = _extract_stock_targets(user_msg) or None
                label = ("종목: " + ", ".join(targets)) if targets else "기본 15개 종목"
                notice = (
                    f"📊 **주식 분석 파이프라인 실행 중...**\n"
                    f"{label} 분석\n"
                    f"⏳ 30~60초 소요됩니다.\n\n"
                )
                for ch in notice:
                    collected.append(ch)
                    yield ch
                    await asyncio.sleep(0)

                try:
                    report = await stock_run_once(targets)
                    summary = _summarize_stock_report(report, targets)
                    async for chunk in _stream_chunks(summary):
                        collected.append(chunk)
                        yield chunk
                except Exception as e:
                    err = f"\n\n❌ 분석 오류: {e}"
                    collected.append(err)
                    yield err

            # ── 경로 BROKER: 증권사 리포트 단독 조회 ──────────
            elif run_broker_report:
                targets = _extract_stock_targets(user_msg)
                if not targets:
                    msg = "🔍 조회할 종목명을 함께 입력해주세요.\n예: '삼성전자 증권사 리포트 찾아줘'"
                    collected.append(msg)
                    yield msg
                else:
                    notice = f"📋 **{', '.join(targets)} 증권사 리포트 수집 중...**\n⏳ 잠시 기다려주세요.\n\n"
                    for ch in notice:
                        collected.append(ch)
                        yield ch
                        await asyncio.sleep(0)
                    try:
                        from stock_analysis.utils.securities_report import get_all_reports
                        # 주의: 'results'로 이름 지으면 generate() 전체에서 results가 지역변수로
                        # 취급되어, 바깥(chat)의 results를 읽는 경로 B에서 UnboundLocalError 발생
                        broker_summaries = []
                        link_items = []
                        for name in targets:
                            ticker = _ticker_for_name(name)
                            r = await get_all_reports(ticker, name)
                            broker_summaries.append(r.get("summary", f"{name}: 리포트 없음"))
                            for rep in r.get("reports", []):
                                link_items.append({"title": f"{name} - {rep.get('제목','')}", "url": rep.get("링크", "")})
                        output = "\n\n".join(broker_summaries)
                        output = _summarize_long_text(output, "broker_" + "_".join(targets))
                        output += _format_reference_links(link_items)
                        async for chunk in _stream_chunks(output, chunk_size=200):
                            collected.append(chunk)
                            yield chunk
                    except Exception as e:
                        err = f"\n\n❌ 리포트 수집 오류: {e}"
                        collected.append(err)
                        yield err

            # ── 경로 LOWPRICE: 저평가 저가주 스크리닝 ────────
            elif run_lowprice_screen:
                from stock_analysis.utils.low_price_screener import (
                    screen_low_price_stocks, format_report, DEFAULT_PARAMS
                )
                lowprice_params = _parse_lowprice_params(user_msg)
                saved_settings = mem.get_setting("lowprice_screen")
                # 채팅 중 명시한 조건이 최우선, 없으면 앱에서 저장한 설정, 둘 다 없으면 코드 기본값
                lowprice_params = lowprice_params or saved_settings
                p = {**DEFAULT_PARAMS, **(lowprice_params or {})}
                notice = (
                    f"🔍 **저평가 저가주 스크리닝 중...**\n"
                    f"KOSPI + KOSDAQ 전체 종목 스캔 (가격 < {p['max_price']:,}원 / "
                    f"PBR < {p['max_pbr']} / PER {p['min_per']}~{p['max_per']})\n"
                    f"⏳ 30~60초 소요됩니다.\n\n"
                )
                for ch in notice:
                    collected.append(ch)
                    yield ch
                    await asyncio.sleep(0)
                try:
                    # pykrx 차단 시 네이버 fallback까지 합쳐 60초를 훌쩍 넘기는 경우가 있어
                    # (관찰된 사례: 응답이 안내문구만 남고 끊김) 일부 리버스 프록시가
                    # 일정 시간 응답 데이터가 없으면 연결을 끊는다. 결과를 기다리는 동안
                    # 보이지 않는 문자(zero-width space)를 주기적으로 흘려보내 커넥션을 유지한다.
                    future = asyncio.get_event_loop().run_in_executor(
                        None, screen_low_price_stocks, "ALL", lowprice_params
                    )
                    while True:
                        done, _ = await asyncio.wait({future}, timeout=4)
                        if done:
                            break
                        collected.append("​")
                        yield "​"
                    candidates = future.result()
                    report = format_report(candidates, params=lowprice_params)
                    report = _summarize_long_text(report, "lowprice")
                    async for chunk in _stream_chunks(report, chunk_size=200):
                        collected.append(chunk)
                        yield chunk
                except Exception as e:
                    err = f"\n\n❌ 스크리닝 오류: {e}"
                    collected.append(err)
                    yield err

            # ── 경로 CALC: Python 직접 계산 결과 있음 ────────
            elif direct_calc:
                # 계산 결과를 바로 스트리밍 (LLM 불필요)
                async for chunk in _stream_chunks(direct_calc):
                    collected.append(chunk)
                    yield chunk

            # ── 경로 A: 고신뢰 KB 직접 서빙 ──────────────
            elif kb_direct:
                if company_kb_only:
                    # 관련 규정 복수 표시 + 출처(조항) 안내
                    answer = _format_company_results(top_results, best_score)
                    if not answer:
                        answer = top_answer
                else:
                    answer = top_answer
                # 출처 레이블: 어느 KB에서 나온 답변인지 사용자에게 표시
                source_label = f"\n\n---\n📚 **출처**: 내부 지식베이스 (유사도 {best_score:.2f})"
                answer = answer + source_label
                async for chunk in _stream_chunks(answer):
                    collected.append(chunk)
                    yield chunk

            # ── 경로 C: company 페르소나 — 등록된 규정 없음 안내 ──
            elif company_kb_only:
                # KB에서 답을 찾지 못한 경우 LLM 호출 없이 안내 메시지만 반환
                no_answer_msg = (
                    "현재 등록된 규정에서 확인되지 않습니다.\n"
                    "인사팀에 문의해 주세요."
                )
                async for chunk in _stream_chunks(no_answer_msg):
                    collected.append(chunk)
                    yield chunk

            # ── 경로 B: LLM 보강 (중간 신뢰도 or 법령 실시간) ──
            else:
                reference_items = []  # 답변 끝에 붙일 참고 자료 링크 ([{title, url}])
                if len(matched_persona_ids) > 1:
                    combo_notice = f"🔎 **{persona['name']} 통합 분석**\n\n"
                    collected.append(combo_notice)
                    yield combo_notice
                if stock_mode:
                    # stock 페르소나: 뉴스 + 증권사 리포트 + 인터넷 검색 병렬 수집
                    sources = []
                    if stock_report_ctx:
                        sources.append("📋 최근 분석 보고서")

                    yield "> 🔍 뉴스·기사·증권사 리포트·인터넷 검색 중"

                    # 언급 종목 추출
                    _chat_targets = _extract_stock_targets(user_msg)

                    # ① DuckDuckGo 일반 검색 (기존)
                    _ddg_task = asyncio.get_event_loop().run_in_executor(
                        None, lambda: srch.web_search(search_msg)
                    )

                    # ② 종목별 뉴스 수집 (병렬)
                    _news_ctx = ""
                    _news_task = None
                    if _chat_targets:
                        async def _collect_news():
                            from stock_analysis.utils.news_collector import get_stock_news, format_news_context
                            tasks_n = []
                            for _n in _chat_targets[:3]:
                                tasks_n.append(get_stock_news(_n, _ticker_for_name(_n), max_results=6))
                            results_n = await asyncio.gather(*tasks_n, return_exceptions=True)
                            parts = []
                            for res in results_n:
                                if isinstance(res, Exception):
                                    continue
                                ctx = format_news_context(res)
                                if ctx:
                                    parts.append(ctx)
                            return "\n\n".join(parts)
                        _news_task = asyncio.ensure_future(_collect_news())

                    # ③ 종목별 증권사 리포트 수집 (병렬)
                    _broker_ctx = ""
                    _broker_task = None
                    if _chat_targets:
                        async def _collect_broker():
                            from stock_analysis.utils.securities_report import get_all_reports
                            tasks_b = []
                            for _n in _chat_targets[:3]:
                                tasks_b.append(get_all_reports(_ticker_for_name(_n), _n, max_reports=5))
                            results_b = await asyncio.gather(*tasks_b, return_exceptions=True)
                            parts = []
                            for _n, res in zip(_chat_targets[:3], results_b):
                                if isinstance(res, Exception):
                                    continue
                                s = res.get("summary", "")
                                if s:
                                    parts.append(s)
                                for rep in res.get("reports", []):
                                    reference_items.append({"title": f"{_n} - {rep.get('제목','')}", "url": rep.get("링크", "")})
                            return "\n\n".join(parts)
                        _broker_task = asyncio.ensure_future(_collect_broker())

                    # 모든 비동기 작업 완료 대기
                    _gather_tasks = [_ddg_task]
                    if _news_task:
                        _gather_tasks.append(_news_task)
                    if _broker_task:
                        _gather_tasks.append(_broker_task)

                    _gather_results = await asyncio.gather(*_gather_tasks, return_exceptions=True)

                    auto_search_results = _gather_results[0] if not isinstance(_gather_results[0], Exception) else []
                    auto_search_ctx = srch.format_search_context(auto_search_results)
                    for r in auto_search_results:
                        reference_items.append({"title": r.get("title", ""), "url": r.get("url", "")})

                    idx = 1
                    if _news_task:
                        _news_ctx = _gather_results[idx] if not isinstance(_gather_results[idx], Exception) else ""
                        idx += 1
                    if _broker_task:
                        _broker_ctx = _gather_results[idx] if not isinstance(_gather_results[idx], Exception) else ""

                    # 소스 레이블 구성
                    if _broker_ctx:
                        sources.append("📊 증권사 애널리스트 리포트")
                    if _news_ctx:
                        sources.append("📰 최신 뉴스·기사")
                    if auto_search_ctx:
                        sources.append("🌐 실시간 인터넷 검색")
                    sources.append("🧠 AI 주식 전문 지식")
                    yield f" → {'  |  '.join(sources)}\n\n"

                    # 컨텍스트 조합
                    ctx_parts = []
                    if stock_report_ctx:
                        ctx_parts.append(f"[최근 주식 분석 보고서]\n{stock_report_ctx}")
                    if _broker_ctx:
                        ctx_parts.append(f"[증권사 애널리스트 리포트 컨센서스]\n{_broker_ctx}")
                    if _news_ctx:
                        ctx_parts.append(f"[최신 뉴스·기사]\n{_news_ctx}")
                    if auto_search_ctx:
                        ctx_parts.append(f"[실시간 인터넷 검색 결과]\n{auto_search_ctx}")

                    if ctx_parts:
                        _intent_ctx = intent_agent.format_intent_context(intent_info)
                        context = (
                            (_intent_ctx + "\n\n" if _intent_ctx else "")
                            + f"[아래 자료를 참고해 사용자 질문 '{search_msg[:60]}'에 답변하세요. "
                            f"각 자료의 출처 레이블(예: [최신 뉴스], [증권사 리포트])을 답변 내에 명시하여 "
                            f"사용자가 어느 자료에서 나온 정보인지 알 수 있게 하세요. "
                            f"자료에 명시된 수치·사실만 사용하고, 자료에 없는 구체적 수치는 추측하지 마세요. "
                            f"불확실한 내용은 '자료에서 확인되지 않음'으로 명시하세요.]\n\n"
                            + "\n\n---\n\n".join(ctx_parts)
                        )
                    else:
                        context = ""
                else:
                    if law_ctx:
                        reference_items.extend(
                            {"title": r.get("title", ""), "url": r.get("url", "")} for r in law_results
                        )
                    if search_ctx:
                        reference_items.extend(
                            {"title": r.get("title", ""), "url": r.get("url", "")} for r in results
                        )
                    raw_ctx = "\n\n".join(filter(None, [law_ctx, rag_ctx, search_ctx]))
                    # 질문 관련성 지시: 무관한 컨텍스트를 LLM이 포함하지 않도록 명시
                    _intent_ctx = intent_agent.format_intent_context(intent_info)
                    if raw_ctx:
                        context = (
                            (_intent_ctx + "\n\n" if _intent_ctx else "")
                            + f"[주의: 아래 참고 자료 중 사용자 질문 '{search_msg[:60]}'"
                            f"와 직접 관련된 내용만 사용하세요. "
                            f"질문 주제와 다른 내용(다른 법 조항, 다른 HR 주제 등)은 답변에 포함하지 마세요. "
                            f"자료에 명시된 수치·사실만 인용하고, 자료에 없는 내용은 절대 만들어내지 마세요. "
                            f"불확실하거나 자료 밖의 내용은 '확인 필요' 또는 '자료에서 확인되지 않음'으로 표시하세요. "
                            f"법령 원문·웹검색 결과 등 출처를 답변에서 간략히 언급하세요.]\n\n"
                            + raw_ctx
                        )
                    else:
                        context = _intent_ctx

                    if no_local:
                        yield "> 📭 로컬 자료 없음 — AI 지식으로 답변 후 자동 학습합니다.\n\n"

                if persona_features.get("use_coding", False):
                    async for token in llm.chat_stream_coding(history, context, system_prompt=system_with_date):
                        collected.append(token)
                        yield token
                else:
                    async for token in llm.chat_stream(history, context, system_prompt=system_with_date, thinking_mode=effective_thinking_mode):
                        collected.append(token)
                        yield token

                ref_footer = _format_reference_links(reference_items)
                if ref_footer:
                    collected.append(ref_footer)
                    yield ref_footer

            ai_reply = "".join(collected)
            # <think>...</think> 태그를 DB/KB 저장 전에 제거
            # (생각 과정이 대화 이력·자동학습 KB에 오염되는 것 방지)
            ai_reply_clean = re.sub(r'<think>[\s\S]*?</think>\s*', '', ai_reply).strip()

            mem.save_message("user", user_msg, persona=persona_id, session_id=session_scope)
            mem.save_message(
                "assistant", ai_reply_clean or ai_reply,
                persona=persona_id, session_id=session_scope,
            )

            # ── 자동 학습 후보: 검증되지 않은 답변은 영구 RAG에 바로 넣지 않음 ──
            # 최소 품질 게이트를 통과한 답변도 memory_candidates(pending)에만 저장하고,
            # 소유자가 승인한 경우에만 source='승인학습' 장기기억으로 승격한다.
            # stock 페르소나는 실시간 시장 데이터 기반이어야 하므로 자동 학습에서 계속 제외
            # (LLM 일반 지식이 KB에 누적되면 이후 오염 답변 재발 위험)
            # LOCAL_FALLBACK_MARKER 포함 응답(모든 LLM API 소진 시 원본 자료 그대로 노출한
            # 미합성 폴백)은 정상 답변이 아니므로 auto_learn에서 제외 — 안 그러면 이 저품질
            # 원본 덤프가 KB에 학습되어 이후 정상 답변을 덮어쓰는 재오염 위험이 있음
            from engine import LOCAL_FALLBACK_MARKER
            # 이미 KB에서 직접 서빙한 답변과 Python 계산 결과는 새 지식이 아니므로
            # 후보 대기열에 다시 쌓지 않는다. LLM이 새로 합성한 답변만 검토 대상으로 둔다.
            is_new_synthesized_answer = not kb_direct and not direct_calc and not company_kb_only
            if (not is_shared_session and is_new_synthesized_answer
                    and ai_reply_clean.strip() and not stock_mode
                    and LOCAL_FALLBACK_MARKER not in ai_reply_clean):
                candidate_source = (
                    "법령실시간" if law_ctx else
                    "웹검색보강" if search_ctx else
                    "KB보강생성" if rag_ctx else
                    "생성답변"
                )
                candidate_id = mem.auto_learn(
                    user_msg, ai_reply_clean, persona=persona_id,
                    session_id=session_scope, source=candidate_source,
                )
                if no_local and candidate_id:
                    yield ("\n\n---\n> 📝 기억 후보로 저장했습니다. "
                           "검토·승인된 내용만 장기기억에 반영됩니다.")

        except Exception as e:
            import traceback
            print(f"[오류] {type(e).__name__}: {e}\n{traceback.format_exc()}")
            yield f"\n⚠️ 오류: {type(e).__name__}: {e}"

    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8")


# ── 대화 이력 ─────────────────────────────────────────

@app.get("/history")
def history(limit: int = 30, persona: str = None, session_id: str = "legacy",
            token: str = ""):
    _require_backup_token(token)
    return {"history": mem.get_history(
        limit, persona=persona, session_id=_owner_session_scope(session_id)
    )}

@app.delete("/history")
def clear_history(persona: str = None, session_id: str = "legacy", token: str = ""):
    _require_backup_token(token)
    mem.clear_history(persona=persona, session_id=_owner_session_scope(session_id))
    return {"ok": True}

@app.delete("/history/stock/reset")
def reset_stock_history(session_id: str = "legacy", token: str = ""):
    """stock 페르소나 대화 이력 + 자동학습 KB 완전 초기화 (오염 제거용)"""
    _require_backup_token(token)
    mem.clear_history(persona="stock", session_id=_owner_session_scope(session_id))
    try:
        # mem._conn() 경유 — Turso/로컬 SQLite 공용. auto_learn()이 실제로 쓰는
        # source 값은 '자동학습'(한글)이며 'auto_learn'/'learned' 문자열은 존재한 적
        # 없어 예전 코드는 이 필터가 항상 0건 매칭되는 상태였음(정적KB·직접입력은
        # 보존 대상이라 의도적으로 제외).
        with mem._conn() as c:
            c.execute(
                "DELETE FROM learned_knowledge WHERE persona='stock' AND source='자동학습'"
            )
        try:
            from engine import get_engine, _kb_loaded
            if _kb_loaded:
                get_engine().delete_by_source("자동학습", "stock")
        except Exception:
            pass
    except Exception as e:
        print(f"⚠️ stock 자동학습 KB 초기화 실패: {e}")
    return {"ok": True, "message": "stock 페르소나 대화 이력 및 자동학습 데이터 초기화 완료"}


# ── 파일 텍스트 추출 유틸 ──────────────────────────────

def _extract_text(content: bytes, filename: str) -> str:
    """PDF / DOCX / TXT에서 텍스트 추출"""
    ext = filename.rsplit(".", 1)[-1].lower()

    if ext == "pdf":
        try:
            from pdfminer.high_level import extract_text as _pdf_text
            import io
            return _pdf_text(io.BytesIO(content))
        except ImportError:
            pass
        try:
            import subprocess
            r = subprocess.run(["pdftotext", "-", "-"], input=content, capture_output=True, timeout=30)
            if r.returncode == 0:
                return r.stdout.decode("utf-8", errors="ignore")
        except Exception:
            pass
        raise HTTPException(422, "PDF 파싱 실패. pdfminer.six 패키지가 필요합니다.")

    if ext in ("docx",):
        try:
            from docx import Document as _Docx
            import io
            doc = _Docx(io.BytesIO(content))
            return "\n".join(p.text for p in doc.paragraphs if p.text.strip())
        except ImportError:
            raise HTTPException(422, "DOCX 파싱 실패. python-docx 패키지가 필요합니다.")

    # txt, md, csv 등 텍스트 계열
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("euc-kr", errors="ignore")


# ── 문서 학습 ─────────────────────────────────────────

@app.post("/learn/document")
async def learn_document(file: UploadFile = File(...), persona: str = DEFAULT_PERSONA,
                         token: str = ""):
    _require_backup_token(token)
    content = await _read_upload_limited(file)
    # PDF 파싱(pdfminer/pdftotext)은 최대 수십 초 걸리는 블로킹 호출이므로 스레드 실행기로 넘긴다.
    text = await asyncio.get_event_loop().run_in_executor(None, _extract_text, content, file.filename)
    chunk_count = mem.store_document(text, file.filename, persona_id=persona)
    if chunk_count == 0:
        raise HTTPException(400, "문서에서 학습할 텍스트를 추출하지 못했습니다.")
    return {
        "ok": True, "filename": file.filename, "chars": len(text),
        "chunks": chunk_count, "chunking": "semantic-v2",
    }


# ── 이력서 분석 ────────────────────────────────────────

@app.post("/analyze/resume")
async def analyze_resume(
    file: UploadFile = File(...),
    job_desc: str = "",
    analysis_type: str = "full",
    session_id: str = "legacy",
    token: str = "",
):
    """이력서/자소서 파일을 업로드하면 LLM이 분석 결과를 스트리밍으로 반환"""
    _require_backup_token(token)
    content = await _read_upload_limited(file)
    resume_text = await asyncio.get_event_loop().run_in_executor(None, _extract_text, content, file.filename)

    if not resume_text.strip():
        raise HTTPException(400, "파일에서 텍스트를 추출할 수 없습니다.")

    # 분석 유형별 프롬프트
    type_prompts = {
        "summary": "핵심 프로필 요약 (3~5줄) 만 작성해 주세요.",
        "feedback": "강점과 개선 제안을 항목별로 상세히 작성해 주세요.",
        "full": (
            "아래 순서로 분석해 주세요:\n"
            "1. 핵심 프로필 요약 (3줄)\n"
            "2. 강점 분석\n"
            "3. 개선 제안 (항목별 구체적 피드백)\n"
            "4. 전반적 평가 (A~F 등급 + 이유)"
        ),
    }
    task = type_prompts.get(analysis_type, type_prompts["full"])

    job_section = f"\n\n지원 직무/회사 정보:\n{job_desc}" if job_desc.strip() else ""
    system = PERSONAS["resume"]["system_prompt"]

    user_message = (
        f"아래 이력서를 분석해 주세요. {task}"
        f"{job_section}\n\n"
        f"--- 이력서 내용 ---\n{resume_text[:8000]}"
    )

    messages = [{"role": "user", "content": user_message}]

    async def stream():
        collected = []
        async for token in llm.chat_stream(messages, context="", system_prompt=system):
            collected.append(token)
            yield token
        ai_reply = "".join(collected)
        clean = re.sub(r"<think>[\s\S]*?</think>\s*", "", ai_reply).strip()
        scope = _owner_session_scope(session_id)
        mem.save_message(
            "user", f"[이력서 분석: {file.filename}]",
            persona="resume", session_id=scope,
        )
        mem.save_message(
            "assistant", clean or ai_reply, persona="resume", session_id=scope,
        )

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8")


# ── 인터넷 검색 학습 ──────────────────────────────────

class SearchRequest(BaseModel):
    query: str
    persona: str = DEFAULT_PERSONA
    max_results: int = 5

@app.post("/learn/search")
def learn_search(req: SearchRequest, token: str = ""):
    _require_backup_token(token)
    results = srch.search_and_learn(req.query, req.max_results, persona_id=req.persona)
    return {"ok": True, "query": req.query, "learned": len(results), "results": results}


# ── 직접 지식 추가 ────────────────────────────────────

class TextLearnRequest(BaseModel):
    question: str
    answer: str
    persona: str = DEFAULT_PERSONA

@app.post("/learn/text")
def learn_text(req: TextLearnRequest, token: str = ""):
    """질문-답변 쌍을 직접 지식베이스에 추가 — 동일 질문이 있으면 최신으로 업데이트"""
    _require_backup_token(token)
    q = req.question.strip()
    a = req.answer.strip()
    if not q or not a:
        raise HTTPException(400, "질문과 답변을 모두 입력하세요.")
    updated = mem.upsert_knowledge(q, a, req.persona, source="직접입력")
    return {"ok": True, "question": q, "persona": req.persona,
            "action": "updated" if updated else "inserted"}


# ── 피드백 ───────────────────────────────────────────

class FeedbackRequest(BaseModel):
    question: str
    answer: str
    rating: int  # 1 = 좋아요, -1 = 별로
    persona: str = DEFAULT_PERSONA

@app.post("/feedback")
def receive_feedback(req: FeedbackRequest, token: str = ""):
    _require_backup_token(token)
    if req.rating not in (1, -1):
        raise HTTPException(400, "rating은 1 또는 -1만 허용")
    mem.save_feedback(req.question, req.answer, req.rating, req.persona)
    # 좋아요 → 동일/유사 질문 검색 가중치 상승, 싫어요 → 가중치 하락(다음엔 새 답변 유도)
    boost = mem.apply_feedback_boost(req.persona, req.question, req.rating)
    from engine import set_feedback_boost
    set_feedback_boost(req.persona, req.question.strip().lower(), boost)
    return {"ok": True}

@app.get("/feedback/stats")
def feedback_stats(token: str = ""):
    _require_backup_token(token)
    return mem.get_feedback_stats()


# ── 메모리 통계 ───────────────────────────────────────

@app.get("/memory/stats")
def memory_stats(session_id: str = "legacy", token: str = ""):
    _require_backup_token(token)
    return mem.memory_stats(session_id=_owner_session_scope(session_id))

@app.get("/memory/documents")
def list_documents(token: str = ""):
    _require_backup_token(token)
    return {"documents": mem.list_documents()}


# ── 지식 통계 ─────────────────────────────────────────

@app.get("/knowledge/stats")
def knowledge_stats():
    """로드된 KB 항목 수, 페르소나별 분포, DB 영구 저장 현황"""
    from engine import get_engine
    engine = get_engine()

    persona_counts: dict = {}
    for q, a, meta in engine._qa:
        p = meta.get("persona", "(공통)")
        persona_counts[p] = persona_counts.get(p, 0) + 1

    # mem._conn() 경유 — Turso/로컬 SQLite 공용. 예전 코드는 sqlite3.connect(mem.DB_PATH)로
    # 로컬 파일을 직접 열어, Turso 사용 시 그 파일이 없어 항상 0으로 나오는 문제가 있었음.
    db_static = 0
    db_dynamic = 0
    try:
        with mem._conn() as c:
            db_static = c.execute(
                "SELECT COUNT(*) FROM learned_knowledge WHERE source='정적KB'"
            ).fetchone()[0]
            db_dynamic = c.execute(
                "SELECT COUNT(*) FROM learned_knowledge WHERE source!='정적KB'"
            ).fetchone()[0]
    except Exception:
        pass

    return {
        "engine_total": engine.count(),
        "engine_by_persona": persona_counts,
        "db_static_kb": db_static,
        "db_dynamic_learned": db_dynamic,
        "db_backend": "Turso (클라우드)" if mem._USE_TURSO else f"SQLite ({mem.DB_PATH})",
        "persistent_storage": {
            "python_files": "영구 (git 커밋됨)",
            "sqlite_static": f"{db_static}개 정적KB → DB 백업",
            "sqlite_dynamic": f"{db_dynamic}개 동적 학습 데이터",
        },
    }


# ── DB 이관 (Railway → Turso 1회용) ─────────────────────

@app.post("/admin/import-db")
async def admin_import_db(file: UploadFile = File(...), token: str = ""):
    """Railway SQLite(memory.db) 또는 백업 ZIP을 업로드해 현재 DB로 이관.
    ZIP 업로드 시 내부의 memory.db를 자동으로 찾아 사용."""
    _require_backup_token(token)
    import tempfile, zipfile, shutil
    import migrate_to_turso as mig

    suffix = ".db" if file.filename.endswith(".db") else ".zip"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    db_path = tmp_path
    extracted_dir = None
    try:
        if suffix == ".zip":
            extracted_dir = tempfile.mkdtemp()
            with zipfile.ZipFile(tmp_path, "r") as z:
                # Zip Slip 방지: 압축 해제 대상 경로가 extracted_dir 밖으로 벗어나는
                # 항목(경로에 "../" 등을 포함한 조작된 zip)은 무시하고 건너뜀.
                base = os.path.realpath(extracted_dir)
                for member in z.infolist():
                    dest = os.path.realpath(os.path.join(base, member.filename))
                    if dest == base or dest.startswith(base + os.sep):
                        z.extract(member, base)
            candidates = []
            for root, _, files in os.walk(extracted_dir):
                for f in files:
                    if f.endswith(".db"):
                        candidates.append(os.path.join(root, f))
            if not candidates:
                raise HTTPException(400, "ZIP 안에서 .db 파일을 찾을 수 없습니다.")
            db_path = candidates[0]

        stats = mig.migrate(db_path)
        total = sum(v.get("inserted", 0) for v in stats.values())
        return {"ok": True, "total_inserted": total, "tables": stats}
    finally:
        os.unlink(tmp_path)
        if extracted_dir:
            shutil.rmtree(extracted_dir, ignore_errors=True)


# ── 학습 데이터 관리 (오답 학습 정리용) ─────────────────

@app.get("/admin/learned")
def admin_learned_list(q: str = "", persona: str = "", limit: int = 30, offset: int = 0, token: str = ""):
    """learned_knowledge 검색 — 잘못 학습된 항목을 찾을 때 사용.
    예: /admin/learned?q=출장  (내용에 '출장' 포함 항목 조회)"""
    _require_backup_token(token)
    where, params = [], []
    if q:
        where.append("content LIKE ?")
        params.append(f"%{q}%")
    if persona:
        where.append("persona=?")
        params.append(persona)
    sql = "SELECT id, persona, source, created_at, content FROM learned_knowledge"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id ASC LIMIT ? OFFSET ?"
    params.append(max(1, min(int(limit), 200)))
    params.append(max(0, int(offset)))
    with mem._conn() as c:
        rows = [dict(r) for r in c.execute(sql, params).fetchall()]
    for r in rows:
        r["content"] = r["content"][:300]
    return {"count": len(rows), "items": rows}


@app.get("/admin/learned/duplicates")
def admin_learned_duplicates(apply: bool = False, token: str = ""):
    """전체 learned_knowledge에서 content 완전 일치 중복 그룹을 찾아 반환.
    동일 페르소나 안에서만 중복으로 판단하고, apply=true면 신뢰 출처 우선·동률 시
    최신 항목을 남긴 뒤 나머지를 복구 가능한 격리소로 이동한다.
    Turso 이관 시 kb_static_index가 함께 이관되지 않아 정적 KB가 중복 시딩되는
    문제(2026-07-08 발견)의 전 페르소나 전수 정리용."""
    _require_backup_token(token)
    from collections import defaultdict
    from refine import choose_duplicate_keeper
    with mem._conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id, persona, source, created_at, content FROM learned_knowledge ORDER BY id ASC"
        ).fetchall()]

    by_content = defaultdict(list)
    for r in rows:
        by_content[(r.get("persona", ""), r["content"])].append(r)

    groups = [items for items in by_content.values() if len(items) > 1]
    remove_rows = []
    for items in groups:
        keeper = choose_duplicate_keeper(items)
        remove_rows.extend(r for r in items if r["id"] != keeper["id"])
    remove_ids = sorted(r["id"] for r in remove_rows)

    result = {
        "total_rows": len(rows),
        "duplicate_groups": len(groups),
        "duplicate_rows_to_remove": len(remove_ids),
    }

    if apply and remove_ids:
        result["quarantined"] = mem.quarantine_learned_rows(
            remove_rows, reason="관리자 정리:완전일치 중복"
        )
        from engine import reload_engine
        reload_engine()
    else:
        result["quarantine_ids_preview"] = remove_ids[:20]

    return result


@app.delete("/admin/learned/{item_id}")
def admin_learned_delete(item_id: int, token: str = ""):
    """잘못 학습된 항목을 복구 가능한 격리소로 이동하고 엔진을 재구축."""
    _require_backup_token(token)
    with mem._conn() as c:
        row = c.execute(
            "SELECT id, persona, source, created_at, content"
            " FROM learned_knowledge WHERE id=?", (item_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, f"id={item_id} 항목 없음")
        row = dict(row)
    mem.quarantine_learned_rows([row], reason="관리자 수동 격리")
    from engine import reload_engine
    reload_engine()
    return {"ok": True, "quarantined": item_id, "content_preview": row["content"][:120]}


# ── 승인 기반 기억 후보 ────────────────────────────────

@app.get("/admin/memory-candidates")
def admin_memory_candidates(status: str = "pending", persona: str = "",
                            limit: int = 50, offset: int = 0, token: str = ""):
    _require_backup_token(token)
    return {"items": mem.list_memory_candidates(status, persona, limit, offset)}


@app.post("/admin/memory-candidates/{candidate_id}/approve")
def admin_memory_candidate_approve(candidate_id: int, token: str = ""):
    _require_backup_token(token)
    item = mem.review_memory_candidate(candidate_id, approve=True)
    if not item:
        raise HTTPException(404, "기억 후보를 찾을 수 없습니다.")
    if item["status"] == "protected":
        raise HTTPException(
            409,
            f"같은 질문의 더 높은 신뢰도 지식({item['protected_source']})이 있어 "
            "자동 승격하지 않았습니다. 기존 항목을 검토한 뒤 다시 처리하세요.",
        )
    return {"ok": item["status"] == "approved", "status": item["status"], "id": candidate_id}


@app.post("/admin/memory-candidates/{candidate_id}/reject")
def admin_memory_candidate_reject(candidate_id: int, token: str = ""):
    _require_backup_token(token)
    item = mem.review_memory_candidate(candidate_id, approve=False)
    if not item:
        raise HTTPException(404, "기억 후보를 찾을 수 없습니다.")
    return {"ok": item["status"] == "rejected", "status": item["status"], "id": candidate_id}


@app.get("/admin/memory-quarantine")
def admin_memory_quarantine(limit: int = 100, offset: int = 0, token: str = ""):
    _require_backup_token(token)
    return {"items": mem.list_quarantined_memories(limit, offset)}


@app.post("/admin/memory-quarantine/{quarantine_id}/restore")
def admin_memory_quarantine_restore(quarantine_id: int, token: str = ""):
    _require_backup_token(token)
    item = mem.restore_quarantined_memory(quarantine_id)
    if not item:
        raise HTTPException(404, "복구할 격리 기억을 찾을 수 없습니다.")
    from engine import reload_engine
    reload_engine()
    return {"ok": True, "restored": quarantine_id}


@app.post("/admin/refine")
def admin_refine(apply: bool = False, dup_threshold: float = 0.85,
                  dislike_boost_max: float = 0.1, token: str = ""):
    """KB 자기개선(자동 정제) — LLM 호출 없는 순수 기계적 정리 후보를 찾는다.
    새 내용을 지어내거나 재작성하지 않고 "지우기"만 한다 — 이 프로젝트에서 실제
    반복됐던 KB 오염 사고가 전부 AI가 스스로 내용을 만들어내는 경로에서 나왔기
    때문에 자기개선 루프는 의도적으로 이 안전한 범위로 제한한다.
    (1) 근사 중복 통합: 동일 페르소나 내 동적 학습 데이터(정적KB 제외) 중 TF-IDF
        유사도가 dup_threshold 이상인 항목들을 보수적으로 묶어 출처 신뢰도 우선,
        동률이면 최신 항목을 남기고 나머지를 복구 가능한 격리소로 이동.
    (2) 반복 비추천 항목 정리: feedback_boost.boost가 dislike_boost_max 이하로
        떨어진(연속 싫어요로 최소 세 번 이상 하향된) 질문에 해당하는 학습 항목을
        격리하고, 그 feedback_boost 행도 함께 삭제 — 그렇지 않으면 같은 질문이
        나중에 다시(더 나은 내용으로) 학습되어도 옛 하향 가중치 때문에 부당하게
        계속 억눌리게 됨.
    (3) 충돌 후보 보고(삭제 안 함): 질문은 비슷한데 답변이 실질적으로 다른 쌍을
        찾아 결과에 포함만 한다 — 둘 중 어느 게 맞는지는 사람이 판단할 영역이라
        apply=true여도 이 항목들은 절대 자동 삭제하지 않는다.
    apply=false(기본)면 무엇이 격리될지 미리보기만 반환한다. 정기 스케줄은 항상
    미리보기로 실행되며, 관리자가 확인 후 apply=true를 수동 실행해야 실제 격리된다."""
    _require_backup_token(token)
    from refine import (
        choose_duplicate_keeper,
        find_conflicting_pairs,
        find_disliked_questions,
        find_duplicate_clusters,
    )

    with mem._conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id, persona, source, created_at, content FROM learned_knowledge"
            " WHERE source != '정적KB'"
        ).fetchall()]
        feedback_rows = [dict(r) for r in c.execute(
            "SELECT persona, q_lower, boost FROM feedback_boost WHERE boost <= ?",
            (dislike_boost_max,),
        ).fetchall()]

    clusters = find_duplicate_clusters(rows, threshold=dup_threshold)
    dup_remove = []
    for members in clusters:
        # 검증된 직접입력·승인지식·문서를 자동응답/웹 스니펫보다 우선 보존한다.
        # 같은 우선순위 안에서만 최신 항목을 남긴다.
        keeper = choose_duplicate_keeper(members)
        dup_remove.extend(r for r in members if r["id"] != keeper["id"])

    disliked_remove = find_disliked_questions(feedback_rows, rows)
    conflicts = find_conflicting_pairs(rows)

    remove_by_id = {r["id"]: r for r in dup_remove + disliked_remove}
    remove_ids = sorted(remove_by_id)

    result = {
        "scanned_rows": len(rows),
        "duplicate_clusters": len(clusters),
        "duplicate_rows_to_remove": len(dup_remove),
        "disliked_rows_to_remove": len(disliked_remove),
        "total_rows_to_remove": len(remove_ids),
        "conflicting_pairs_found": len(conflicts),
        "conflicting_pairs_preview": [
            {
                "persona": c["a"]["persona"],
                "question_similarity": c["question_similarity"],
                "answer_similarity": c["answer_similarity"],
                "a": {"id": c["a"]["id"], "content": c["a"]["content"][:200]},
                "b": {"id": c["b"]["id"], "content": c["b"]["content"][:200]},
            }
            for c in conflicts[:20]
        ],
    }

    if apply and remove_ids:
        quarantined = mem.quarantine_learned_rows(
            [remove_by_id[rid] for rid in remove_ids],
            reason="자동정제:근사중복/반복비추천",
        )
        if feedback_rows:
            with mem._conn() as c:
                c.executemany(
                    "DELETE FROM feedback_boost WHERE persona=? AND q_lower=?",
                    [(d["persona"], d["q_lower"]) for d in feedback_rows],
                )
        # 부분 source 삭제 대신 DB 전체를 기준으로 재구축해 문서의 정상 청크가
        # 실행 중 인덱스에서 함께 사라지는 문제를 막는다.
        from engine import reload_engine
        reload_engine()
        result["quarantined"] = quarantined
    else:
        result["preview_remove_ids"] = remove_ids[:30]

    return result


def _replace_source_knowledge(source: str, items: list[dict], default_persona: str) -> int:
    """learned_knowledge에서 특정 source의 기존 행을 전부 지우고 새 항목으로 교체 +
    라이브 엔진에도 즉시 반영. law.go.kr·mofa_travel_alert처럼 "매번 전체를 다시
    가져오는 권위 있는 외부 자료"에 적합한 전체 교체 방식 — upsert_knowledge()와
    달리 이전 실행에서 사라진 항목(예: 경보가 해제된 국가)도 자동으로 없어진다."""
    now = _datetime.now().isoformat()
    rows = [
        (f"Q: {it['q']}\nA: {it['a']}", it.get("persona", default_persona), source, now)
        for it in items
    ]
    with mem._conn() as c:
        c.execute("DELETE FROM learned_knowledge WHERE source=?", (source,))
        c.executemany(
            "INSERT INTO learned_knowledge (content, persona, source, created_at) VALUES (?,?,?,?)",
            rows,
        )
    try:
        from engine import get_engine, _kb_loaded
        if _kb_loaded:
            eng = get_engine()
            eng.delete_by_source(source)
            for it in items:
                eng.add(it["q"], it["a"], {"persona": it.get("persona", default_persona), "source": source})
    except Exception as e:
        print(f"⚠️ 엔진 즉시 반영 실패(재시작 시 반영됨): {e}")
    return len(items)


@app.post("/admin/refresh-law-cache")
def admin_refresh_law_cache(token: str = ""):
    """law.go.kr 법령 원문을 배포된 서버가 직접 가져와 DB에 저장 + 라이브 엔진에
    즉시 반영한다. 예전에는 GitHub Actions가 CI 러너에서 fetch_laws.py를 실행해
    결과 JSON을 git에 커밋하는 방식이었는데, 스케줄 트리거는 항상 저장소 기본
    브랜치에서 실행되고 그 브랜치가 Render 배포 브랜치와 달라 커밋된 갱신분이
    서비스에 절대 반영되지 않는 구조적 문제가 있었음(2026-08-30 발견). 이 방식은
    git을 거치지 않으므로 그 문제가 원천적으로 없다. 외부 스케줄러(GitHub Actions
    등)가 이 엔드포인트를 주기적으로 호출하면 된다."""
    _require_backup_token(token)
    from fetch_laws import LAWS_TO_FETCH, fetch_one_law, LAW_API_KEY as _law_key
    if not _law_key:
        raise HTTPException(400, "LAW_API_KEY 환경변수가 서버에 설정되지 않았습니다.")

    all_results = []
    errors = []
    for law_key, search_name in LAWS_TO_FETCH:
        try:
            all_results.extend(fetch_one_law(law_key, search_name))
        except Exception as e:
            errors.append(f"{law_key}: {type(e).__name__}: {e}")

    if not all_results:
        raise HTTPException(502, f"법령 데이터를 하나도 가져오지 못했습니다: {errors}")

    # 일부 법령만 실패해도(예: 실측된 사례 — 8개 중 2개가 일시적 DNS 오류) 여기서
    # 전체 교체를 강행하면, 그 법령들의 지난주 성공분까지 함께 지워지고 이번엔
    # 재삽입되지 않아 순감소가 발생한다. 매주 도는 정기 작업이라 이번 주 실패는
    # 다음 주에 다시 시도되므로, 부분 실패 시에는 교체하지 않고 이전 성공분을
    # 그대로 보존하는 쪽이 안전하다.
    if errors:
        raise HTTPException(
            502,
            f"{len(errors)}개 법령 조회 실패로 갱신을 건너뜁니다(기존 데이터 보존): {errors}",
        )

    saved = _replace_source_knowledge("law.go.kr", all_results, "hr")
    return {"fetched": saved, "laws_attempted": len(LAWS_TO_FETCH), "errors": errors}


@app.post("/admin/refresh-travel-alerts")
def admin_refresh_travel_alerts(token: str = ""):
    """외교부 해외안전여행 여행경보를 배포된 서버가 직접 가져와 DB에 저장 + 라이브
    엔진에 즉시 반영 — admin_refresh_law_cache와 동일한 이유로 git 커밋 대신 이
    방식을 쓴다."""
    _require_backup_token(token)
    from fetch_travel_alerts import fetch_all_alerts, API_KEY as _travel_key
    if not _travel_key:
        raise HTTPException(400, "TRAVEL_ALERT_API_KEY 환경변수가 서버에 설정되지 않았습니다.")

    try:
        results = fetch_all_alerts()
    except Exception as e:
        raise HTTPException(502, f"여행경보 데이터 조회 실패: {type(e).__name__}: {e}")

    if not results:
        raise HTTPException(502, "여행경보 데이터를 하나도 가져오지 못했습니다.")

    saved = _replace_source_knowledge("mofa_travel_alert", results, "travel")
    return {"fetched": saved}


# ── 공유 링크 (일부 페르소나만 URL로 외부 공개) ──────────

class ShareCreateRequest(BaseModel):
    name: str = ""
    personas: list[str]
    expires_at: str = ""  # ISO 문자열, 빈 값이면 만료 없음


@app.post("/admin/share")
def admin_share_create(req: ShareCreateRequest, token: str = ""):
    """선택한 페르소나만 접근 가능한 공유 링크 생성.
    반환된 token을 프론트엔드가 '/?share=<token>' 형태 URL로 안내."""
    _require_backup_token(token)
    invalid = [p for p in req.personas if p not in PERSONAS]
    if not req.personas:
        raise HTTPException(400, "공유할 페르소나를 1개 이상 선택하세요.")
    if invalid:
        raise HTTPException(400, f"존재하지 않는 페르소나: {invalid}")
    link = mem.create_share_link(req.name.strip(), req.personas, req.expires_at.strip())
    return {"ok": True, **link}


@app.get("/admin/share")
def admin_share_list(token: str = ""):
    _require_backup_token(token)
    return {"items": mem.list_share_links()}


@app.delete("/admin/share/{share_token}")
def admin_share_revoke(share_token: str, token: str = ""):
    _require_backup_token(token)
    ok = mem.revoke_share_link(share_token)
    if not ok:
        raise HTTPException(404, "존재하지 않는 공유 링크입니다.")
    return {"ok": True, "revoked": share_token}


@app.get("/share/{token}")
def share_info(token: str):
    """공유 링크 유효성 확인 — 프론트엔드가 페이지 로드 시 호출해 허용된
    페르소나 목록만 UI에 노출하는 데 사용. 인증 없이 접근 가능(공유 링크 자체가 접근키)."""
    share = mem.get_share_link(token)
    if not share or not share["enabled"]:
        raise HTTPException(404, "유효하지 않은 공유 링크입니다.")
    if share["expires_at"] and share["expires_at"] < _datetime.now().isoformat():
        raise HTTPException(410, "만료된 공유 링크입니다.")
    personas_info = [
        {"id": pid, "name": PERSONAS[pid]["name"], "icon": PERSONAS[pid]["icon"]}
        for pid in share["personas"] if pid in PERSONAS
    ]
    return {"valid": True, "name": share["name"], "personas": personas_info}


# ── 백업 ──────────────────────────────────────────────

@app.post("/backup/request-link")
def backup_request_link(token: str = ""):
    """/backup/download용 1분짜리 1회용 다운로드 토큰 발급 (기존 BACKUP_TOKEN 인증 필요).
    <a href> 다운로드 링크에는 이 단기 토큰만 실어, 서버 접근 로그·브라우저
    히스토리에 재사용 가능한 영구 BACKUP_TOKEN이 남지 않도록 한다."""
    _require_backup_token(token)
    return {"dl": bkp.issue_download_link_token(), "expires_in": bkp._DOWNLOAD_LINK_TTL_SECONDS}


@app.get("/backup/download")
def backup_download(token: str = "", dl: str = ""):
    if dl:
        if not bkp.consume_download_link_token(dl):
            raise HTTPException(401, "다운로드 링크가 만료되었거나 이미 사용되었습니다. 새로고침 후 다시 시도하세요.")
    else:
        # 하위 호환: /backup/request-link를 거치지 않고 기존처럼 장기
        # BACKUP_TOKEN을 직접 ?token=으로 넘기는 것도 계속 허용한다(스크립트·
        # curl 등 기존 사용을 깨지 않기 위함). static/index.html의 다운로드
        # 버튼은 항상 위 request-link 경로로 받은 단기 토큰(dl=)을 쓰도록
        # 바뀌었으므로, 실사용 경로에서는 더 이상 영구 비밀키가 URL에 실리지 않는다.
        _require_backup_token(token)
    zip_bytes, filename = bkp.backup_download()
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/backup/google-status")
def backup_google_status():
    return {
        "configured": bkp.gdrive_configured(),
        "connected":  bkp.gdrive_connected(),
    }


@app.get("/backup/google-auth")
def backup_google_auth(token: str = ""):
    _require_backup_token(token)
    if not bkp.gdrive_configured():
        raise HTTPException(400, "GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REDIRECT_URI 환경변수를 설정하세요.")
    return {"auth_url": bkp.gdrive_auth_url()}


@app.get("/backup/google-callback")
async def backup_google_callback(code: str = "", state: str = ""):
    if not code:
        raise HTTPException(400, "code 파라미터 없음")
    try:
        await bkp.gdrive_exchange_code(code, state)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return HTMLResponse("<h2>✅ Google Drive 연동 완료!</h2><p>이 창을 닫고 앱으로 돌아가세요.</p>")


@app.post("/backup/google-drive")
async def backup_google_drive(token: str = ""):
    _require_backup_token(token)
    result = await bkp.backup_to_gdrive()
    if not result["ok"]:
        raise HTTPException(400, result["error"])
    return result


# ── 주식 보고서 다운로드 ──────────────────────────────

@app.post("/stock/popular/sync")
async def stock_popular_sync(top_n: int = 50):
    """KRX 거래대금 상위 종목 강제 갱신 (백그라운드 아님)"""
    from stock_analysis.utils.popular_stocks import refresh_popular_stocks
    # refresh_popular_stocks는 동기 블로킹 KRX 스캔이므로 스레드 실행기로 넘긴다.
    result = await asyncio.get_event_loop().run_in_executor(
        None, lambda: refresh_popular_stocks(top_n=top_n, force=True)
    )
    return result


class LowPriceSettingsRequest(BaseModel):
    max_price: Optional[int] = None
    max_pbr: Optional[float] = None
    max_per: Optional[float] = None

@app.get("/stock/lowprice/settings")
def get_lowprice_settings():
    """저평가 저가주 스크리닝 기준 조회 — 앱 저장값이 있으면 우선, 없으면 코드 기본값"""
    from stock_analysis.utils.low_price_screener import DEFAULT_PARAMS
    saved = mem.get_setting("lowprice_screen") or {}
    return {**DEFAULT_PARAMS, **saved}

@app.post("/stock/lowprice/settings")
def save_lowprice_settings(req: LowPriceSettingsRequest):
    """저평가 저가주 스크리닝 기준을 앱 내에서 저장 — 이후 채팅에서 별도 조건을 명시하지 않으면 이 값을 사용"""
    params = {k: v for k, v in req.dict().items() if v is not None}
    if not params:
        raise HTTPException(400, "변경할 값이 없습니다")
    saved = mem.get_setting("lowprice_screen") or {}
    saved.update(params)
    mem.save_setting("lowprice_screen", saved)
    from stock_analysis.utils.low_price_screener import DEFAULT_PARAMS
    return {"ok": True, "settings": {**DEFAULT_PARAMS, **saved}}

@app.get("/stock/download/{filename}")
def stock_report_download(filename: str):
    """주식 분석 보고서 파일 다운로드"""
    if not filename.startswith("report_") or ".." in filename:
        raise HTTPException(status_code=400, detail="잘못된 파일명")
    filepath = os.path.join(_STOCK_REPORTS_DIR, filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="파일 없음")
    return FileResponse(
        filepath,
        media_type="text/plain; charset=utf-8",
        filename=filename,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )

@app.get("/answer/download/{filename}")
def answer_download(filename: str):
    """길어서 요약 표시된 채팅 답변의 전체 원문 다운로드"""
    if not filename.startswith("answer_") or ".." in filename:
        raise HTTPException(status_code=400, detail="잘못된 파일명")
    filepath = os.path.join(_ANSWERS_DIR, filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="파일 없음")
    return FileResponse(
        filepath,
        media_type="text/plain; charset=utf-8",
        filename=filename,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )

# ── 모델 정보 & 메인 UI ───────────────────────────────

@app.get("/model-info")
def model_info():
    return llm.current_model_info()

@app.get("/debug/law")
async def debug_law(q: str = "근로기준법 제7조", token: str = ""):
    """law.go.kr API 원본 응답 확인용 (개발 디버그)"""
    _require_backup_token(token)
    import httpx, traceback
    api_key = os.getenv("LAW_API_KEY", "")
    if not api_key:
        return {"ok": False, "error": "LAW_API_KEY 환경변수 없음"}
    search_name = law._get_search_name(q)
    url = "https://www.law.go.kr/DRF/lawSearch.do"
    params = {"OC": api_key, "target": "law", "type": "JSON", "query": search_name, "display": 5}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r1 = await client.get(url, params=params)
            return {
                "ok": True,
                "query": q,
                "search_name": search_name,
                "http_status": r1.status_code,
                "raw": r1.json(),
            }
    except Exception as e:
        return {
            "ok": False,
            "query": q,
            "search_name": search_name,
            "error_type": type(e).__name__,
            "error": str(e),
            "traceback": traceback.format_exc()[-500:],
        }

# ── 예산관리 (budget) API ─────────────────────────
@app.post("/budget/upload/headcount")
async def budget_upload_headcount(file: UploadFile = File(...), token: str = ""):
    """① 부서별 월 인원 현황 업로드 — 동일 부서/월 재업로드 시 자동 갱신"""
    _require_backup_token(token)
    content = await _read_upload_limited(file)
    try:
        rows = budget.parse_rows(content, file.filename)
    except budget.TooManyRowsError as e:
        # 행 수 상한 초과는 "읽을 수 없는 파일"이 아니라 사용자가 조치할 수 있는 상황이라
        # 원인을 그대로 알려준다(일반 파싱 실패 메시지에 묻히지 않게).
        raise HTTPException(status_code=413, detail=str(e))
    except Exception:
        raise HTTPException(status_code=400, detail="파일을 읽을 수 없습니다. (xlsx/csv만 지원)")
    upserted, depts = budget.upsert_headcount(rows)
    return {"message": "인원 현황이 반영되었습니다.", "upserted": upserted, "depts": depts}

@app.post("/budget/upload/detail")
async def budget_upload_detail(file: UploadFile = File(...), token: str = ""):
    """② 판관/용역/경상 상세 업로드 — ①의 부서와 자동 연계, 동일 키 재업로드 시 자동 갱신"""
    _require_backup_token(token)
    content = await _read_upload_limited(file)
    try:
        rows = budget.parse_rows(content, file.filename)
    except budget.TooManyRowsError as e:
        # 행 수 상한 초과는 "읽을 수 없는 파일"이 아니라 사용자가 조치할 수 있는 상황이라
        # 원인을 그대로 알려준다(일반 파싱 실패 메시지에 묻히지 않게).
        raise HTTPException(status_code=413, detail=str(e))
    except Exception:
        raise HTTPException(status_code=400, detail="파일을 읽을 수 없습니다. (xlsx/csv만 지원)")
    upserted, depts = budget.upsert_detail(rows)
    return {"message": "예산 상세(판관/용역/경상) 내역이 반영되었습니다.", "upserted": upserted, "depts": depts}

@app.get("/budget/data")
def budget_data(token: str = ""):
    _require_backup_token(token)
    return budget.read_budget()

@app.get("/budget/summary")
def budget_summary(token: str = ""):
    """부서 기준으로 인원 현황과 판관/용역/경상 상세를 연계한 통합 요약 (중복 없이 합산)"""
    _require_backup_token(token)
    return {"summary": budget.build_summary()}

@app.delete("/budget/data")
def budget_reset(token: str = ""):
    _require_backup_token(token)
    budget.write_budget(budget._empty())
    return {"message": "예산 데이터가 초기화되었습니다."}


class GridSaveRequest(BaseModel):
    rows: list


class SnapshotRequest(BaseModel):
    label: str
    rows: list


@app.get("/budget/grid")
def budget_grid_get(token: str = ""):
    _require_backup_token(token)
    return {"rows": budget.get_grid()}


@app.post("/budget/grid")
def budget_grid_save(req: GridSaveRequest, token: str = ""):
    _require_backup_token(token)
    budget.save_grid(req.rows)
    return {"message": "저장되었습니다."}


@app.post("/budget/grid/upload")
async def budget_grid_upload(file: UploadFile = File(...), token: str = ""):
    _require_backup_token(token)
    content = await _read_upload_limited(file)
    try:
        rows = budget.parse_grid(content, file.filename)
    except budget.TooManyRowsError as e:
        # 행 수 상한 초과는 "읽을 수 없는 파일"이 아니라 사용자가 조치할 수 있는 상황이라
        # 원인을 그대로 알려준다(일반 파싱 실패 메시지에 묻히지 않게).
        raise HTTPException(status_code=413, detail=str(e))
    except Exception:
        raise HTTPException(status_code=400, detail="파일을 읽을 수 없습니다. (xlsx/csv만 지원)")
    budget.save_grid(rows)
    return {"message": "업로드되었습니다.", "rows": len(rows)}


@app.get("/budget/grid/download")
def budget_grid_download(token: str = ""):
    _require_backup_token(token)
    rows = budget.get_grid()
    buf = budget.export_grid_xlsx(rows)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename*=UTF-8''budget.xlsx"},
    )


@app.get("/budget/grid/snapshots")
def budget_snapshots_list(token: str = ""):
    _require_backup_token(token)
    return {"snapshots": budget.list_snapshots()}


@app.post("/budget/grid/snapshot")
def budget_snapshot_save(req: SnapshotRequest, token: str = ""):
    _require_backup_token(token)
    snap_id = budget.save_snapshot(req.label, req.rows)
    return {"message": "스냅샷이 저장되었습니다.", "id": snap_id}


@app.get("/budget/grid/snapshot/{snap_id}")
def budget_snapshot_get(snap_id: str, token: str = ""):
    _require_backup_token(token)
    snap = budget.get_snapshot(snap_id)
    if not snap:
        raise HTTPException(status_code=404, detail="스냅샷을 찾을 수 없습니다.")
    return snap


@app.delete("/budget/grid/snapshot/{snap_id}")
def budget_snapshot_delete(snap_id: str, token: str = ""):
    _require_backup_token(token)
    ok = budget.delete_snapshot(snap_id)
    if not ok:
        raise HTTPException(status_code=404, detail="스냅샷을 찾을 수 없습니다.")
    return {"message": "삭제되었습니다."}


@app.get("/budget/sheets")
def budget_get_sheets(token: str = ""):
    """멀티시트 전체 데이터 조회"""
    _require_backup_token(token)
    return budget.get_sheets()


@app.post("/budget/sheets")
async def budget_save_sheets(request: Request, token: str = ""):
    """멀티시트 전체 데이터 저장"""
    _require_backup_token(token)
    payload = await request.json()
    budget.save_sheets(payload)
    return {"ok": True}


@app.get("/budget/grid/compare")
def budget_grid_compare(a: str = "current", b: str = "current", token: str = ""):
    """a, b는 스냅샷 id 또는 'current'(현재 작업 그리드)"""
    _require_backup_token(token)
    def _rows_of(key):
        if key == "current":
            return budget.get_grid()
        snap = budget.get_snapshot(key)
        if not snap:
            raise HTTPException(status_code=404, detail=f"스냅샷을 찾을 수 없습니다: {key}")
        return snap["grid"]

    rows_a = _rows_of(a)
    rows_b = _rows_of(b)
    diffs = budget.compare_rows(rows_a, rows_b)
    return {"diffs": diffs, "count": len(diffs)}



@app.get("/health")
def health():
    import shutil
    result = {
        "status": "ok",
        "db_backend": "Turso (클라우드)" if mem._USE_TURSO else "SQLite (로컬)",
        "law_api_key_set": bool(os.getenv("LAW_API_KEY")),
        "law_api_blocked": law._is_api_blocked(),
    }
    if mem._USE_TURSO:
        # Turso 사용 시 로컬 디스크 지표는 무의미 — DB는 클라우드에 있음
        # (URL 자체는 노출하지 않음 — 인증 없는 엔드포인트이므로 인프라 정보 최소 노출)
        result["turso_configured"] = True
    else:
        db_path = mem.DB_PATH
        data_dir = os.path.dirname(db_path)
        disk = shutil.disk_usage(data_dir)
        result.update({
            "db_path": db_path,
            "disk_persistent": not db_path.startswith("/tmp"),
            "disk_total_mb": round(disk.total / 1024 / 1024),
            "disk_used_mb": round(disk.used / 1024 / 1024),
            "disk_free_mb": round(disk.free / 1024 / 1024),
            "db_exists": os.path.exists(db_path),
            "db_size_kb": round(os.path.getsize(db_path) / 1024) if os.path.exists(db_path) else 0,
        })
    return result

@app.get("/", response_class=HTMLResponse)
def index():
    # 여러 경로 시도 (배포 환경마다 working directory가 다를 수 있음)
    candidates = [
        "static/index.html",
        os.path.join(os.path.dirname(__file__), "static", "index.html"),
        "/app/static/index.html",
    ]
    for path in candidates:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return f.read()
    return HTMLResponse("<h1>static/index.html 파일을 찾을 수 없습니다</h1>", status_code=500)


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
