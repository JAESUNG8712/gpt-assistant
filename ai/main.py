import os
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

    persona = PERSONAS.get(req.persona, PERSONAS[DEFAULT_PERSONA])

    # 인터넷 검색 학습
    search_ctx = ""
    if req.use_search:
        results = srch.search_and_learn(user_msg)
        search_ctx = srch.format_search_context(results)

    # RAG: 벡터 기억에서 관련 내용 검색
    rag_ctx = mem.retrieve_context(user_msg, persona_id=req.persona)
    context = "\n\n".join(filter(None, [rag_ctx, search_ctx]))

    # 최근 대화 이력
    history = mem.get_recent_messages(10)
    history.append({"role": "user", "content": user_msg})

    collected = []

    async def generate():
        try:
            async for token in llm.chat_stream(history, context, system_prompt=persona["system_prompt"]):
                collected.append(token)
                yield token
            ai_reply = "".join(collected)
            mem.save_message("user", user_msg, persona=req.persona)
            mem.save_message("assistant", ai_reply, persona=req.persona)
            # 대화 기록은 conversations 테이블에만 저장 (TF-IDF 엔진에 넣지 않음)
            # → 엔진에 저장하면 다른 질문 검색 시 오염 발생
        except Exception as e:
            import traceback
            err = f"[오류] {type(e).__name__}: {e}\n{traceback.format_exc()}"
            print(err)
            yield f"\n⚠️ 오류 발생: {type(e).__name__}: {e}\nRailway Logs를 확인해주세요."

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

@app.get("/health")
def health():
    return {"status": "ok"}

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
