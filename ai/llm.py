import os
import httpx
from typing import AsyncGenerator

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL   = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")

SYSTEM_PROMPT = """당신은 사용자만을 위한 전용 AI 어시스턴트입니다.
- 사용자의 과거 대화, 업로드한 문서, 인터넷 검색 결과를 바탕으로 답변합니다.
- 한국어로 자연스럽게 대화합니다.
- 참고한 정보가 있으면 [출처: ...] 형식으로 명시합니다."""

async def chat_stream(messages: list, context: str = "") -> AsyncGenerator[str, None]:
    system = SYSTEM_PROMPT
    if context:
        system += f"\n\n[참고 정보]\n{context}"

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
                    import json
                    try:
                        delta = json.loads(chunk)["choices"][0]["delta"].get("content", "")
                        if delta:
                            yield delta
                    except Exception:
                        pass


async def chat(messages: list, context: str = "") -> str:
    result = []
    async for token in chat_stream(messages, context):
        result.append(token)
    return "".join(result)
