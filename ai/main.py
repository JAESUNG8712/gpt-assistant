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

mem.init_db()

app = FastAPI(title="나만의 AI 어시스턴트")
app.mount("/static", StaticFiles(directory="static"), name="static")


# ── 채팅 ──────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    use_search: bool = False

@app.post("/chat")
async def chat(req: ChatRequest):
    user_msg = req.message.strip()
    if not user_msg:
        raise HTTPException(400, "메시지를 입력하세요.")

    # 인터넷 검색 학습
    search_ctx = ""
    if req.use_search:
        results = srch.search_and_learn(user_msg)
        search_ctx = srch.format_search_context(results)

    # 벡터 기억에서 관련 내용 검색 (RAG)
    rag_ctx = mem.retrieve_context(user_msg)
    context = "\n\n".join(filter(None, [rag_ctx, search_ctx]))

    # 최근 대화 이력
    history = mem.get_recent_messages(10)
    history.append({"role": "user", "content": user_msg})

    # 스트리밍 응답
    collected = []

    async def generate():
        async for token in llm.chat_stream(history, context):
            collected.append(token)
            yield token
        ai_reply = "".join(collected)
        mem.save_message("user", user_msg)
        mem.save_message("assistant", ai_reply)
        mem.store_conversation_memory(user_msg, ai_reply)

    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8")


# ── 대화 이력 ─────────────────────────────────────────

@app.get("/history")
def history(limit: int = 30):
    return {"history": mem.get_history(limit)}

@app.delete("/history")
def clear_history():
    mem.clear_history()
    return {"ok": True}


# ── 문서 학습 ─────────────────────────────────────────

@app.post("/learn/document")
async def learn_document(file: UploadFile = File(...)):
    content = await file.read()
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        text = content.decode("euc-kr", errors="ignore")

    mem.store_document(text, file.filename)
    return {"ok": True, "filename": file.filename, "chars": len(text)}


# ── 인터넷 검색 학습 ──────────────────────────────────

class SearchRequest(BaseModel):
    query: str
    max_results: int = 5

@app.post("/learn/search")
def learn_search(req: SearchRequest):
    results = srch.search_and_learn(req.query, req.max_results)
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


# ── 메인 UI ───────────────────────────────────────────

@app.get("/model-info")
def model_info():
    return llm.current_model_info()


@app.get("/", response_class=HTMLResponse)
def index():
    with open("static/index.html", encoding="utf-8") as f:
        return f.read()
