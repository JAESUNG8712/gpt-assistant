import os
import httpx
import json
import asyncio
from typing import AsyncGenerator

# ── 제공자 선택 ──────────────────────────────────────────
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "groq")

# Groq 설정 (무료, https://console.groq.com)
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL   = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")

# Google Gemini 설정 (무료, https://aistudio.google.com/app/apikey)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL   = os.getenv("GEMINI_MODEL", "gemini-2.0-flash-lite")

SYSTEM_PROMPT = """당신은 사용자만을 위한 전용 AI 어시스턴트입니다.
- 사용자의 과거 대화, 업로드한 문서, 인터넷 검색 결과를 바탕으로 답변합니다.
- 한국어로 자연스럽게 대화합니다.
- 참고한 정보가 있으면 [출처: ...] 형식으로 명시합니다."""


# ── Groq 스트리밍 ─────────────────────────────────────
async def _groq_stream(messages: list, system: str) -> AsyncGenerator[str, None]:
    payload = {
        "model": GROQ_MODEL,
        "messages": [{"role": "system", "content": system}] + messages,
        "temperature": 0.7,
        "max_tokens": 2048,
        "stream": True,
    }
    async with httpx.AsyncClient(timeout=60) as client:
        async with client.stream(
            "POST",
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            json=payload,
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    chunk = line[6:]
                    if chunk == "[DONE]":
                        break
                    try:
                        delta = json.loads(chunk)["choices"][0]["delta"].get("content", "")
                        if delta:
                            yield delta
                    except Exception:
                        pass


# ── Gemini 단일 시도 ──────────────────────────────────
async def _gemini_once(messages: list, system: str) -> AsyncGenerator[str, None]:
    contents = []
    for m in messages:
        role = "user" if m["role"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})

    payload = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": contents,
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 2048},
    }
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:streamGenerateContent?alt=sse&key={GEMINI_API_KEY}"
    )
    async with httpx.AsyncClient(timeout=60) as client:
        async with client.stream("POST", url, json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    chunk = line[6:]
                    try:
                        data = json.loads(chunk)
                        text = (
                            data.get("candidates", [{}])[0]
                            .get("content", {})
                            .get("parts", [{}])[0]
                            .get("text", "")
                        )
                        if text:
                            yield text
                    except Exception:
                        pass


# ── Gemini 스트리밍 (429 자동 재시도) ────────────────────
async def _gemini_stream(messages: list, system: str) -> AsyncGenerator[str, None]:
    delays = [10, 20]  # 재시도 대기 시간(초)
    for attempt in range(3):
        try:
            async for token in _gemini_once(messages, system):
                yield token
            return  # 성공 시 종료
        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            if status == 429 and attempt < 2:
                wait = delays[attempt]
                yield f"\n⏳ 요청이 너무 많습니다. {wait}초 후 재시도합니다..."
                await asyncio.sleep(wait)
                # 이전에 보낸 안내 메시지를 지우기 위한 빈 줄
                yield "\r" + " " * 60 + "\r"
                continue
            # API 키 노출 방지: URL에서 key= 이후 제거
            safe_msg = str(e).split("key=")[0] + "key=***"
            raise RuntimeError(f"Gemini API 오류 [{status}]: {safe_msg}") from None
        except Exception as e:
            raise RuntimeError(f"Gemini 연결 오류: {type(e).__name__}") from None


# ── 공통 인터페이스 ───────────────────────────────────
async def chat_stream(
    messages: list,
    context: str = "",
    system_prompt: str = None,
) -> AsyncGenerator[str, None]:
    system = system_prompt or SYSTEM_PROMPT
    if context:
        system += f"\n\n[참고 정보 — 아래 내용을 바탕으로 답변하세요]\n{context}"

    if LLM_PROVIDER == "gemini":
        async for token in _gemini_stream(messages, system):
            yield token
    else:
        async for token in _groq_stream(messages, system):
            yield token


async def chat(messages: list, context: str = "") -> str:
    result = []
    async for token in chat_stream(messages, context):
        result.append(token)
    return "".join(result)


def current_model_info() -> dict:
    if LLM_PROVIDER == "gemini":
        return {"provider": "Google Gemini", "model": GEMINI_MODEL, "free": True}
    return {"provider": "Groq", "model": GROQ_MODEL, "free": True}
