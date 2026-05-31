import asyncio
import os
import re
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse, HTMLResponse, Response
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
    thinking_mode: str = "off"  # "off" | "prompt" | "deep"

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
    kb = mem.retrieve_best(search_msg, persona_id=req.persona)
    rag_ctx    = kb["context"]
    best_score = kb["best_score"]
    top_answer = kb["top_answer"]

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

    # ── 신뢰도 판정 ───────────────────────────────────────
    # CALC       : Python 직접 계산 결과 있음 → 계산 결과 직접 서빙
    # KB (≥0.15) : 로컬 KB 직접 서빙 — LLM 호출 없음
    # CLAUDE(<0.15): KB에 없는 질문 → Claude 호출
    KB_DIRECT  = 0.15   # 이 점수 이상이면 KB로 직접 답변 (LLM 불필요)
    KB_CONTEXT = 0.10   # LLM 호출 시 컨텍스트 포함 기준

    # law.go.kr에서 실시간 원문이 온 경우 → LLM 보강 (law_ctx 우선)
    has_law_rt  = bool(law_ctx)
    # rag_ctx 비어있으면 overlap 필터 실패 → 직접서빙 금지
    # thinking 모드일 때는 항상 LLM을 거쳐야 <think> 블록이 생성됨
    kb_direct   = (
        best_score >= KB_DIRECT
        and bool(rag_ctx)
        and req.thinking_mode == "off"
        and not has_law_rt
        and not bool(search_ctx)
        and not direct_calc
    )
    no_local    = (best_score < KB_CONTEXT) and not has_law_rt and not direct_calc

    history = mem.get_recent_messages(10)
    history.append({"role": "user", "content": user_msg})

    async def generate():
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

    db_path = os.getenv("DB_PATH", "/tmp/memory.db")
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
