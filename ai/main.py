import os
import re
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse, HTMLResponse
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
from personas import PERSONAS, DEFAULT_PERSONA

mem.init_db()

# 지식베이스는 engine.py의 _load_knowledge()가 자동 로드 (중복 로드 제거)
# → main.py에서 별도 load_knowledge() 호출 불필요

app = FastAPI(title="나만의 AI 어시스턴트")
app.mount("/static", StaticFiles(directory="static"), name="static")


# ── 페르소나 ──────────────────────────────────────────

@app.get("/personas")
def list_personas():
    return {"personas": list(PERSONAS.values())}


# ── 채팅 ──────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    persona: str = DEFAULT_PERSONA
    use_search: bool = False

@app.post("/chat")
async def chat(req: ChatRequest):
    user_msg = req.message.strip()
    if not user_msg:
        raise HTTPException(400, "메시지를 입력하세요.")

    # 복합어 정규화: "희망 퇴직" → "희망퇴직" 등 띄어쓰기 변형 통일
    search_msg = _normalize_query(user_msg)

    persona = PERSONAS.get(req.persona, PERSONAS[DEFAULT_PERSONA])

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
    kb = mem.retrieve_best(search_msg, persona_id=req.persona)
    rag_ctx    = kb["context"]
    best_score = kb["best_score"]
    top_answer = kb["top_answer"]

    # ── 2단계: law.go.kr 법령 검색 (법 관련 질문만) ──────
    law_ctx = ""
    if law.is_law_question(search_msg):
        law_results = await law.search_law(search_msg)
        law_ctx = law.format_law_context(law_results)

    # ── 3단계: 인터넷 검색 (사용자가 명시 요청 시) ────────
    search_ctx = ""
    if req.use_search:
        results = srch.search_and_learn(search_msg)
        search_ctx = srch.format_search_context(results)

    # ── 신뢰도 판정 ───────────────────────────────────────
    # CALC  : Python 직접 계산 결과 있음 → 계산 결과 + LLM 보강
    # HIGH  (≥0.55): 로컬 KB 직접 서빙 — LLM 호출 없음
    # MED   (≥0.10): 로컬 KB를 컨텍스트로 LLM 보강 답변
    # LOW   (< 0.10): 로컬 자료 없음 → LLM 생성 → 자동 학습
    KB_DIRECT  = 0.55
    KB_CONTEXT = 0.10

    # law.go.kr에서 실시간 원문이 온 경우 → LLM 보강 (law_ctx 우선)
    has_law_rt  = bool(law_ctx)
    # rag_ctx 비어있으면 주제 불일치로 overlap 필터 통과 못한 것 → 직접서빙 금지
    kb_direct   = (best_score >= KB_DIRECT) and bool(rag_ctx) and not has_law_rt and not bool(search_ctx) and not direct_calc
    no_local    = (best_score < KB_CONTEXT) and not has_law_rt and not direct_calc

    history = mem.get_recent_messages(10)
    history.append({"role": "user", "content": user_msg})

    async def generate():
        import asyncio
        collected = []
        try:
            # ── 경로 CALC: Python 직접 계산 결과 있음 ────────
            if direct_calc:
                # 계산 결과를 바로 스트리밍 (LLM 불필요)
                chunk_size = 150
                for i in range(0, len(direct_calc), chunk_size):
                    chunk = direct_calc[i:i + chunk_size]
                    collected.append(chunk)
                    yield chunk
                    await asyncio.sleep(0)

            # ── 경로 A: 고신뢰 KB 직접 서빙 ──────────────
            elif kb_direct:
                # LLM을 쓰지 않고 KB 답변을 그대로 스트리밍
                chunk_size = 150
                for i in range(0, len(top_answer), chunk_size):
                    chunk = top_answer[i:i + chunk_size]
                    collected.append(chunk)
                    yield chunk
                    await asyncio.sleep(0)

            # ── 경로 B: LLM 보강 (중간 신뢰도 or 법령 실시간) ──
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

                async for token in llm.chat_stream(history, context, system_prompt=system_with_date):
                    collected.append(token)
                    yield token

            ai_reply = "".join(collected)
            mem.save_message("user", user_msg, persona=req.persona)
            mem.save_message("assistant", ai_reply, persona=req.persona)

            # ── 자동 학습: 로컬 자료 없었던 경우 영구 저장 ──
            if no_local and ai_reply.strip():
                mem.auto_learn(user_msg, ai_reply, persona=req.persona)
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


# ── 문서 학습 ─────────────────────────────────────────

@app.post("/learn/document")
async def learn_document(file: UploadFile = File(...), persona: str = DEFAULT_PERSONA):
    content = await file.read()
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        text = content.decode("euc-kr", errors="ignore")

    mem.store_document(text, file.filename, persona_id=persona)
    return {"ok": True, "filename": file.filename, "chars": len(text)}


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
    """질문-답변 쌍을 직접 지식베이스에 추가"""
    from engine import get_engine
    engine = get_engine()
    q = req.question.strip()
    a = req.answer.strip()
    if not q or not a:
        raise HTTPException(400, "질문과 답변을 모두 입력하세요.")
    engine.add(q, a, {'persona': req.persona, 'source': '직접입력'})
    mem.store_memory(
        f"Q: {q}\nA: {a}",
        {'source': '직접입력', 'persona': req.persona}
    )
    return {"ok": True, "question": q, "persona": req.persona}


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


# ── OneDrive 백업 ─────────────────────────────────────

@app.post("/backup/onedrive")
async def backup_onedrive():
    result = await bkp.backup_to_onedrive()
    if not result["ok"]:
        raise HTTPException(400, result["error"])
    return result


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
    db_path = os.getenv("DB_PATH", "/tmp/memory.db")
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
