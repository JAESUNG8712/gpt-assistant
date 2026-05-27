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
from knowledge_base import get_all_knowledge

mem.init_db()

# 서버 시작 시 지식베이스 자동 로드
def load_knowledge():
    items = get_all_knowledge()
    for text, meta in items:
        mem.store_memory(text, meta)
    print(f"✅ 지식베이스 로드 완료: {len(items)}개 청크")

load_knowledge()

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
        async for token in llm.chat_stream(history, context, system_prompt=persona["system_prompt"]):
            collected.append(token)
            yield token
        ai_reply = "".join(collected)
        mem.save_message("user", user_msg, persona=req.persona)
        mem.save_message("assistant", ai_reply, persona=req.persona)
        mem.store_conversation_memory(user_msg, ai_reply, persona_id=req.persona)

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

@app.get("/", response_class=HTMLResponse)
def index():
    with open("static/index.html", encoding="utf-8") as f:
        return f.read()
