import asyncio
import os
import re
import glob as _glob
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse, HTMLResponse, Response, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

import memory as mem
import llm
import search as srch
import backup as bkp
import law_search as law
import calculator as calc

# ── 복합어 정규화 (띄어쓰기 변형 → 정확한 검색어) ─────
_COMPOUND_MAP = [
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
    for spaced, compact in _COMPOUND_MAP:
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
        title, cite = _parse_answer_header(a)
        body = '\n'.join(a.split('\n')[1:]).lstrip('\n')
        header = f"**{title}**"
        if cite:
            header += f"\n📌 출처: {cite}"
        return header + "\n\n" + body if body else a

    SEP = "─" * 22
    parts = [f"📋 **관련 규정 {len(filtered)}건** 검색됨\n"]
    for i, (q, a, s) in enumerate(filtered, 1):
        title, cite = _parse_answer_header(a)
        body = '\n'.join(a.split('\n')[1:]).lstrip('\n')
        header = f"{SEP}\n**{i}. {title}**"
        if cite:
            header += f"\n📌 출처: {cite}"
        parts.append(header + "\n\n" + (body if body else a))

    return '\n'.join(parts)


from personas import PERSONAS, DEFAULT_PERSONA
from stock_analysis.stock_api import router as stock_router

mem.init_db()

# 지식베이스는 engine.py의 _load_knowledge()가 자동 로드 (중복 로드 제거)
# → main.py에서 별도 load_knowledge() 호출 불필요

app = FastAPI(title="나만의 AI 어시스턴트")
app.mount("/static", StaticFiles(directory="static"), name="static")

# 주식 분석 라우터 등록 (/stock/...)
app.include_router(stock_router)


# ── 페르소나 ──────────────────────────────────────────

@app.get("/personas")
def list_personas():
    return {"personas": list(PERSONAS.values())}


# ── 채팅 ──────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    persona: str = DEFAULT_PERSONA
    use_search: bool = False
    thinking_mode: str = "off"  # "off" | "prompt" | "deep"

# ── 주식 분석 파이프라인 트리거 키워드 ──────────────────
_STOCK_PIPELINE_KEYWORDS = [
    "분석 보고서", "보고서 생성", "보고서 만들어", "보고서만들어", "전체 분석", "분석 실행",
    "종목 분석해", "분석해줘", "분석 부탁", "분석 시작", "지금 분석",
    "리포트", "report", "오늘 장", "오늘 분석",
]

def _is_stock_pipeline_request(text: str) -> bool:
    t = text.replace(" ", "")
    return any(kw.replace(" ", "") in t for kw in _STOCK_PIPELINE_KEYWORDS)

_STOCK_REPORTS_DIR = os.path.join(os.path.dirname(__file__), "stock_analysis", "reports")

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
    """메시지에서 종목명 추출"""
    from stock_analysis.utils.dart_client import CORP_CODES
    found = [name for name in CORP_CODES if name in text]
    return found if found else None


def _summarize_stock_report(report: str, targets: list) -> str:
    """전체 보고서에서 핵심 요약만 추출해 채팅용 답변 생성"""
    lines = report.splitlines()
    filename = _list_stock_reports()[0] if _list_stock_reports() else None
    download_hint = (
        f"\n\n📥 **상세 보고서 다운로드**: 사이드바 → '분석 보고서 다운로드' → `{filename}`"
        if filename else ""
    )

    # 요약 섹션(Executive Summary) 추출
    summary_lines = []
    in_summary = False
    for line in lines:
        if "Executive Summary" in line or "종합 요약" in line:
            in_summary = True
        if in_summary:
            summary_lines.append(line)
            # 다음 섹션이 시작되면 종료
            if len(summary_lines) > 3 and line.startswith("【") and "Executive Summary" not in line:
                break

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

    # 조합
    parts = []
    if summary_lines:
        parts.append("\n".join(summary_lines[:15]).strip())
    if target_lines:
        parts.append("\n".join(target_lines[:20]).strip())

    if parts:
        body = "\n\n".join(parts)
    else:
        # fallback: 처음 30줄
        body = "\n".join(lines[:30])

    return body + download_hint


@app.post("/chat")
async def chat(req: ChatRequest):
    user_msg = req.message.strip()
    if not user_msg:
        raise HTTPException(400, "메시지를 입력하세요.")

    # 복합어 정규화: "희망 퇴직" → "희망퇴직" 등 띄어쓰기 변형 통일
    search_msg = _normalize_query(user_msg)

    persona = PERSONAS.get(req.persona, PERSONAS[DEFAULT_PERSONA])
    persona_features = persona.get("features", {})

    from datetime import date as _date
    today = _date.today()
    system_with_date = (
        persona["system_prompt"]
        + f"\n\n오늘 날짜: {today.strftime('%Y년 %m월 %d일')} ({today.year}년)"
    )

    # ── 0단계: Python 직접 계산 (날짜·금액 기반 HR 계산 질문) ─
    # LLM / KB 상태에 무관하게 정확한 수치를 계산해 반환
    # (연차·퇴직금·실수령액·연장수당·주휴수당·최저임금·4대보험 등)
    direct_calc = calc.try_any_calc(user_msg)

    # ── 1단계: 로컬 KB 검색 (정규화된 쿼리 사용) ────────
    kb = mem.retrieve_best(search_msg, n=6, persona_id=req.persona)
    rag_ctx     = kb["context"]
    best_score  = kb["best_score"]
    top_answer  = kb["top_answer"]
    top_results = kb.get("top_results", [])  # company 다중 결과용

    # ── 2단계: law.go.kr 법령 검색 (법 관련 질문만, 페르소나 허용 시) ──────
    law_ctx = ""
    if persona_features.get("use_law", True) and law.is_law_question(search_msg):
        law_results = await law.search_law(search_msg)
        law_ctx = law.format_law_context(law_results)

    # ── 3단계: 인터넷 검색 (사용자가 명시 요청 시) ────────
    search_ctx = ""
    if req.use_search:
        results = srch.search_and_learn(search_msg)
        search_ctx = srch.format_search_context(results)

    # ── 주식 페르소나: 파이프라인 트리거 여부 판단 ────────
    stock_mode = persona_features.get("stock_mode", False)
    run_stock_pipeline = stock_mode and _is_stock_pipeline_request(user_msg)

    # ── 신뢰도 판정 ───────────────────────────────────────
    # CALC       : Python 직접 계산 결과 있음 → 계산 결과 직접 서빙
    # KB (≥0.15) : 로컬 KB 직접 서빙 — LLM 호출 없음
    # CLAUDE(<0.15): KB에 없는 질문 → Claude 호출
    KB_DIRECT  = 0.15   # 이 점수 이상이면 KB로 직접 답변 (LLM 불필요)
    KB_CONTEXT = 0.10   # LLM 호출 시 컨텍스트 포함 기준

    # company 페르소나: 학습된 규정에서만 답변, 외부 LLM 호출 금지
    # 중간 신뢰도(0.10~0.14)도 KB 직접 서빙 (임계값 낮춤)
    company_kb_only = (req.persona == "company")
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
        and req.thinking_mode == "off"
        and not has_law_rt
        and not bool(search_ctx)
        and not direct_calc
    )
    no_local    = (best_score < KB_CONTEXT) and not has_law_rt and not direct_calc

    # stock 페르소나: 파이프라인 미실행 일반 Q&A → 저장된 보고서를 컨텍스트로 주입
    stock_report_ctx = ""
    if stock_mode and not run_stock_pipeline:
        stock_report_ctx = _load_latest_stock_report()

    # 페르소나별 대화 이력 분리: 다른 페르소나 대화가 현재 페르소나 LLM을 혼동시키는 것을 방지
    history = mem.get_recent_messages(10, persona=req.persona)
    history.append({"role": "user", "content": user_msg})

    async def generate():
        collected = []
        try:
            # ── 경로 STOCK: 주식 분석 파이프라인 실행 ────────
            if run_stock_pipeline:
                from stock_analysis.pipeline import run_once as stock_run_once
                targets = _extract_stock_targets(user_msg)
                label = "종목: " + ", ".join(targets) if targets else "기본 15개 종목"
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
                    chunk_size = 150
                    for i in range(0, len(summary), chunk_size):
                        chunk = summary[i:i + chunk_size]
                        collected.append(chunk)
                        yield chunk
                        await asyncio.sleep(0)
                except Exception as e:
                    err = f"\n\n❌ 분석 오류: {e}"
                    collected.append(err)
                    yield err

            # ── 경로 CALC: Python 직접 계산 결과 있음 ────────
            elif direct_calc:
                # 계산 결과를 바로 스트리밍 (LLM 불필요)
                chunk_size = 150
                for i in range(0, len(direct_calc), chunk_size):
                    chunk = direct_calc[i:i + chunk_size]
                    collected.append(chunk)
                    yield chunk
                    await asyncio.sleep(0)

            # ── 경로 A: 고신뢰 KB 직접 서빙 ──────────────
            elif kb_direct:
                if company_kb_only:
                    # 관련 규정 복수 표시 + 출처(조항) 안내
                    answer = _format_company_results(top_results, best_score)
                    if not answer:
                        answer = top_answer
                else:
                    answer = top_answer
                chunk_size = 150
                for i in range(0, len(answer), chunk_size):
                    chunk = answer[i:i + chunk_size]
                    collected.append(chunk)
                    yield chunk
                    await asyncio.sleep(0)

            # ── 경로 C: company 페르소나 — 등록된 규정 없음 안내 ──
            elif company_kb_only:
                # KB에서 답을 찾지 못한 경우 LLM 호출 없이 안내 메시지만 반환
                no_answer_msg = (
                    "현재 등록된 규정에서 확인되지 않습니다.\n"
                    "인사팀에 문의해 주세요."
                )
                chunk_size = 150
                for i in range(0, len(no_answer_msg), chunk_size):
                    chunk = no_answer_msg[i:i + chunk_size]
                    collected.append(chunk)
                    yield chunk
                    await asyncio.sleep(0)

            # ── 경로 B: LLM 보강 (중간 신뢰도 or 법령 실시간) ──
            else:
                # stock 페르소나: 저장된 보고서를 우선 컨텍스트로 사용
                if stock_report_ctx:
                    raw_ctx = stock_report_ctx
                    context = (
                        f"[아래는 가장 최근 주식 분석 보고서입니다. "
                        f"사용자 질문 '{search_msg[:60]}'에 관련된 내용을 이 보고서에서 찾아 답변하세요. "
                        f"보고서에 없는 내용은 전문가 지식으로 보완하세요.]\n\n"
                        + raw_ctx
                    )
                else:
                    raw_ctx = "\n\n".join(filter(None, [law_ctx, rag_ctx, search_ctx]))
                    # 질문 관련성 지시: 무관한 컨텍스트를 LLM이 포함하지 않도록 명시
                    if raw_ctx:
                        context = (
                            f"[주의: 아래 참고 자료 중 사용자 질문 '{search_msg[:60]}'"
                            f"와 직접 관련된 내용만 사용하세요. 질문 주제와 다른 내용(다른 법 조항, 다른 HR 주제 등)은 답변에 포함하지 마세요.]\n\n"
                            + raw_ctx
                        )
                    else:
                        context = ""

                if no_local:
                    yield "> 📭 로컬 자료 없음 — AI 지식으로 답변 후 자동 학습합니다.\n\n"

                if persona_features.get("use_coding", False):
                    async for token in llm.chat_stream_coding(history, context, system_prompt=system_with_date):
                        collected.append(token)
                        yield token
                else:
                    async for token in llm.chat_stream(history, context, system_prompt=system_with_date, thinking_mode=req.thinking_mode):
                        collected.append(token)
                        yield token

            ai_reply = "".join(collected)
            # <think>...</think> 태그를 DB/KB 저장 전에 제거
            # (생각 과정이 대화 이력·자동학습 KB에 오염되는 것 방지)
            ai_reply_clean = re.sub(r'<think>[\s\S]*?</think>\s*', '', ai_reply).strip()

            mem.save_message("user", user_msg, persona=req.persona)
            mem.save_message("assistant", ai_reply_clean or ai_reply, persona=req.persona)

            # ── 자동 학습: 로컬 자료 없었던 경우 영구 저장 ──
            if no_local and ai_reply_clean.strip():
                mem.auto_learn(user_msg, ai_reply_clean, persona=req.persona)
                yield "\n\n---\n> ✅ 자동 학습 완료 — 다음부터는 로컬 저장 자료로 답변합니다."

        except Exception as e:
            import traceback
            print(f"[오류] {type(e).__name__}: {e}\n{traceback.format_exc()}")
            yield f"\n⚠️ 오류: {type(e).__name__}: {e}"

    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8")


# ── 대화 이력 ─────────────────────────────────────────

@app.get("/history")
def history(limit: int = 30, persona: str = None):
    return {"history": mem.get_history(limit, persona=persona)}

@app.delete("/history")
def clear_history(persona: str = None):
    mem.clear_history(persona=persona)
    return {"ok": True}


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
async def learn_document(file: UploadFile = File(...), persona: str = DEFAULT_PERSONA):
    content = await file.read()
    text = _extract_text(content, file.filename)
    mem.store_document(text, file.filename, persona_id=persona)
    return {"ok": True, "filename": file.filename, "chars": len(text)}


# ── 이력서 분석 ────────────────────────────────────────

@app.post("/analyze/resume")
async def analyze_resume(
    file: UploadFile = File(...),
    job_desc: str = "",
    analysis_type: str = "full",
):
    """이력서/자소서 파일을 업로드하면 LLM이 분석 결과를 스트리밍으로 반환"""
    content = await file.read()
    resume_text = _extract_text(content, file.filename)

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
        mem.save_message("user", f"[이력서 분석: {file.filename}]", persona="resume")
        mem.save_message("assistant", clean or ai_reply, persona="resume")

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8")


# ── 인터넷 검색 학습 ──────────────────────────────────

class SearchRequest(BaseModel):
    query: str
    persona: str = DEFAULT_PERSONA
    max_results: int = 5

@app.post("/learn/search")
def learn_search(req: SearchRequest):
    results = srch.search_and_learn(req.query, req.max_results, persona_id=req.persona)
    return {"ok": True, "query": req.query, "learned": len(results), "results": results}


# ── 직접 지식 추가 ────────────────────────────────────

class TextLearnRequest(BaseModel):
    question: str
    answer: str
    persona: str = DEFAULT_PERSONA

@app.post("/learn/text")
def learn_text(req: TextLearnRequest):
    """질문-답변 쌍을 직접 지식베이스에 추가 — 동일 질문이 있으면 최신으로 업데이트"""
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
def receive_feedback(req: FeedbackRequest):
    if req.rating not in (1, -1):
        raise HTTPException(400, "rating은 1 또는 -1만 허용")
    mem.save_feedback(req.question, req.answer, req.rating, req.persona)
    return {"ok": True}

@app.get("/feedback/stats")
def feedback_stats():
    return mem.get_feedback_stats()


# ── 메모리 통계 ───────────────────────────────────────

@app.get("/memory/stats")
def memory_stats():
    return mem.memory_stats()

@app.get("/memory/documents")
def list_documents():
    return {"documents": mem.list_documents()}


# ── 지식 통계 ─────────────────────────────────────────

@app.get("/knowledge/stats")
def knowledge_stats():
    """로드된 KB 항목 수, 페르소나별 분포, SQLite 영구 저장 현황"""
    import sqlite3
    from engine import get_engine
    engine = get_engine()

    persona_counts: dict = {}
    for q, a, meta in engine._qa:
        p = meta.get("persona", "(공통)")
        persona_counts[p] = persona_counts.get(p, 0) + 1

    db_path = mem.DB_PATH
    db_static = 0
    db_dynamic = 0
    if os.path.exists(db_path):
        try:
            conn = sqlite3.connect(db_path)
            db_static = conn.execute(
                "SELECT COUNT(*) FROM learned_knowledge WHERE source='정적KB'"
            ).fetchone()[0]
            db_dynamic = conn.execute(
                "SELECT COUNT(*) FROM learned_knowledge WHERE source!='정적KB'"
            ).fetchone()[0]
            conn.close()
        except Exception:
            pass

    return {
        "engine_total": engine.count(),
        "engine_by_persona": persona_counts,
        "db_static_kb": db_static,
        "db_dynamic_learned": db_dynamic,
        "persistent_storage": {
            "python_files": "영구 (git 커밋됨)",
            "sqlite_static": f"{db_static}개 정적KB → SQLite 백업",
            "sqlite_dynamic": f"{db_dynamic}개 동적 학습 데이터",
        },
    }


# ── 백업 ──────────────────────────────────────────────

@app.get("/backup/download")
def backup_download():
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
def backup_google_auth():
    if not bkp.gdrive_configured():
        raise HTTPException(400, "GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REDIRECT_URI 환경변수를 설정하세요.")
    return {"auth_url": bkp.gdrive_auth_url()}


@app.get("/backup/google-callback")
async def backup_google_callback(code: str = ""):
    if not code:
        raise HTTPException(400, "code 파라미터 없음")
    await bkp.gdrive_exchange_code(code)
    return HTMLResponse("<h2>✅ Google Drive 연동 완료!</h2><p>이 창을 닫고 앱으로 돌아가세요.</p>")


@app.post("/backup/google-drive")
async def backup_google_drive():
    result = await bkp.backup_to_gdrive()
    if not result["ok"]:
        raise HTTPException(400, result["error"])
    return result


# ── 주식 보고서 다운로드 ──────────────────────────────

@app.get("/stock/reports/list")
def stock_reports_list():
    """저장된 주식 분석 보고서 목록"""
    files = _list_stock_reports()
    return {"보고서목록": files, "총개수": len(files)}

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

# ── 모델 정보 & 메인 UI ───────────────────────────────

@app.get("/model-info")
def model_info():
    return llm.current_model_info()

@app.get("/debug/law")
async def debug_law(q: str = "근로기준법 제7조"):
    """law.go.kr API 원본 응답 확인용 (개발 디버그)"""
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

@app.get("/health")
def health():
    import os, shutil
    db_path = mem.DB_PATH
    data_dir = os.path.dirname(db_path)
    disk = shutil.disk_usage(data_dir)
    return {
        "status": "ok",
        "db_path": db_path,
        "disk_persistent": not db_path.startswith("/tmp"),
        "disk_total_mb": round(disk.total / 1024 / 1024),
        "disk_used_mb": round(disk.used / 1024 / 1024),
        "disk_free_mb": round(disk.free / 1024 / 1024),
        "db_exists": os.path.exists(db_path),
        "db_size_kb": round(os.path.getsize(db_path) / 1024) if os.path.exists(db_path) else 0,
        "law_api_key_set": bool(os.getenv("LAW_API_KEY")),
        "law_api_blocked": law._is_api_blocked(),
    }

@app.get("/", response_class=HTMLResponse)
def index():
    import os
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
