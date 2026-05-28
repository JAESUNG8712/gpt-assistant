"""
LLM 라우터 — 다중 제공자 자동 폴백
우선순위: OpenRouter → Groq → Gemini → 자체 TF-IDF 엔진
429(한도초과) 발생 시 다음 제공자로 자동 전환

무료 API 키 발급:
  OpenRouter : https://openrouter.ai  (무료 모델 한도 없음, 추천)
  Groq       : https://console.groq.com  (하루 14,400건)
  Gemini     : https://aistudio.google.com  (하루 1,500건)
"""
import os
import httpx
import json
import asyncio
import time
from typing import AsyncGenerator

# ── 429 쿨다운 캐시 (서버 메모리 내, 재시작 시 초기화) ────
_rate_limit_until: dict[str, float] = {}  # provider → 쿨다운 만료 타임스탬프

def _is_cooling_down(provider: str) -> bool:
    """해당 제공자가 아직 쿨다운 중이면 True"""
    return time.time() < _rate_limit_until.get(provider, 0)

def _set_cooldown(provider: str, seconds: int = 3600):
    """429 발생 시 지정 시간(기본 1시간) 동안 해당 제공자 스킵"""
    _rate_limit_until[provider] = time.time() + seconds
    print(f"[{provider}] 429 쿨다운 설정: {seconds//60}분 후 재시도 가능")

# ── 제공자 우선순위 설정 ─────────────────────────────
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "auto")

# OpenRouter (무료 모델 한도 없음, 추천)
# 무료 모델 목록: https://openrouter.ai/models?q=free
# 추천 무료 모델:
#   meta-llama/llama-3.3-70b-instruct:free  ← 고품질, 70B
#   meta-llama/llama-3.1-8b-instruct:free   ← 빠름, 8B (구버전)
#   deepseek/deepseek-r1:free               ← 추론 특화
#   google/gemma-3-27b-it:free              ← Google 27B
#   mistralai/mistral-7b-instruct:free      ← 안정적
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL   = os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct:free")
# 기본 모델 404 시 자동으로 시도할 대체 모델들
OPENROUTER_FALLBACK_MODELS = [
    "meta-llama/llama-3.1-8b-instruct:free",
    "mistralai/mistral-7b-instruct:free",
    "google/gemma-3-4b-it:free",
]

# Groq (하루 14,400건 무료)
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL   = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

# Google Gemini (하루 1,500건 무료)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL   = os.getenv("GEMINI_MODEL", "gemini-2.0-flash-lite")

SYSTEM_PROMPT = """당신은 사용자만을 위한 전용 AI 어시스턴트입니다.
- 사용자의 과거 대화, 업로드한 문서, 인터넷 검색 결과를 바탕으로 답변합니다.
- 한국어로 자연스럽게 대화합니다.
- 질문한 내용만 정확히 답한다. 관련 없는 다른 조항·주제는 포함하지 않는다.
- 특정 조항(예: 제1조)을 물으면 그 조항만 설명한다. 다른 조항은 언급하지 않는다."""


# ── 자체 엔진 폴백 ────────────────────────────────────
async def _local_stream(messages: list, context: str, system: str) -> AsyncGenerator[str, None]:
    from engine import local_stream
    async for token in local_stream(messages, context=context, system_prompt=system):
        yield token


# ── OpenAI 호환 스트리밍 (OpenRouter / Groq 공용) ────────
async def _openai_compat_stream(
    messages: list,
    system: str,
    api_key: str,
    base_url: str,
    model: str,
    extra_headers: dict = None,
) -> AsyncGenerator[str, None]:
    """OpenAI 형식 API 공통 스트리밍 (OpenRouter·Groq 모두 동일 포맷)"""
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system}] + messages,
        "temperature": 0.7,
        "max_tokens": 2048,
        "stream": True,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)

    async with httpx.AsyncClient(timeout=60) as client:
        async with client.stream("POST", base_url, headers=headers, json=payload) as resp:
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


async def _openrouter_stream(messages: list, system: str) -> AsyncGenerator[str, None]:
    """404 발생 시 대체 모델로 자동 재시도"""
    base_url = "https://openrouter.ai/api/v1/chat/completions"
    extra_headers = {
        "HTTP-Referer": "https://gpt-assistant-production-320d.up.railway.app",
        "X-Title": "My AI Assistant",
    }
    models_to_try = [OPENROUTER_MODEL] + OPENROUTER_FALLBACK_MODELS

    for model in models_to_try:
        try:
            async for token in _openai_compat_stream(
                messages, system,
                api_key=OPENROUTER_API_KEY,
                base_url=base_url,
                model=model,
                extra_headers=extra_headers,
            ):
                yield token
            return  # 성공
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                print(f"[openrouter] 모델 '{model}' 없음(404), 다음 모델 시도...")
                continue  # 다음 모델로
            raise  # 404 외 오류는 상위로 전파
    # 모든 모델 실패
    raise RuntimeError(f"OpenRouter: 사용 가능한 무료 모델 없음. 시도한 모델: {models_to_try}")


async def _groq_stream(messages: list, system: str) -> AsyncGenerator[str, None]:
    async for token in _openai_compat_stream(
        messages, system,
        api_key=GROQ_API_KEY,
        base_url="https://api.groq.com/openai/v1/chat/completions",
        model=GROQ_MODEL,
    ):
        yield token


# ── Gemini 스트리밍 (별도 포맷) ───────────────────────
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


async def _gemini_stream(messages: list, system: str) -> AsyncGenerator[str, None]:
    for attempt in range(2):
        try:
            async for token in _gemini_once(messages, system):
                yield token
            return
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                if attempt == 0:
                    await asyncio.sleep(15)
                    continue
                else:
                    _set_cooldown("gemini", seconds=3600)
            raise
        except Exception:
            raise


# ── 제공자 우선순위 결정 ──────────────────────────────
def _provider_chain() -> list[str]:
    """사용 가능한 제공자를 우선순위 순서로 반환 (쿨다운 중인 제공자 자동 제외)"""
    if LLM_PROVIDER != "auto":
        return [LLM_PROVIDER]

    chain = []
    if OPENROUTER_API_KEY and not _is_cooling_down("openrouter"):
        chain.append("openrouter")   # 1순위: 무료 모델 한도 없음
    if GROQ_API_KEY and not _is_cooling_down("groq"):
        chain.append("groq")         # 2순위: 하루 14,400건
    if GEMINI_API_KEY and not _is_cooling_down("gemini"):
        chain.append("gemini")       # 3순위: 하루 1,500건
    chain.append("local")            # 최후 폴백: 자체 엔진 (항상 포함)
    return chain


def _resolve_provider() -> str:
    return _provider_chain()[0]


# ── 공통 스트리밍 인터페이스 ──────────────────────────
async def chat_stream(
    messages: list,
    context: str = "",
    system_prompt: str = None,
) -> AsyncGenerator[str, None]:
    system = system_prompt or SYSTEM_PROMPT
    chain = _provider_chain()

    for i, provider in enumerate(chain):
        is_last = (i == len(chain) - 1)

        if provider != "local" and context:
            sys_with_ctx = system + f"\n\n참고 정보:\n{context}"
        else:
            sys_with_ctx = system

        try:
            if provider == "openrouter":
                async for token in _openrouter_stream(messages, sys_with_ctx):
                    yield token
                return

            elif provider == "groq":
                async for token in _groq_stream(messages, sys_with_ctx):
                    yield token
                return

            elif provider == "gemini":
                async for token in _gemini_stream(messages, sys_with_ctx):
                    yield token
                return

            else:  # local
                async for token in _local_stream(messages, context, system):
                    yield token
                return

        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            # 실제 오류 내용을 로그에 남김
            try:
                err_body = e.response.text[:300]
            except Exception:
                err_body = str(e)[:300]
            print(f"[{provider}] HTTP {status} 오류: {err_body}")

            if not is_last:
                next_p = chain[i + 1]
                if status == 401:
                    yield f"\n⚠️ [{provider}] API 키가 올바르지 않습니다 → {next_p}로 전환 중...\n\n"
                elif status == 429:
                    _set_cooldown(provider, seconds=3600)  # 1시간 쿨다운
                    remaining = _rate_limit_until.get(provider, 0) - time.time()
                    mins = int(remaining // 60)
                    yield f"\n⚠️ [{provider}] 일일 한도 초과 ({mins}분 후 자동 복구) → {next_p}로 전환 중...\n\n"
                else:
                    yield f"\n⚠️ [{provider}] 오류 {status} → {next_p}로 전환 중...\n\n"
                await asyncio.sleep(1)
                continue
            else:
                if status == 429:
                    _set_cooldown(provider, seconds=3600)
                yield f"\n⚠️ [{provider}] 오류 {status}: {err_body[:100]}"
                return

        except Exception as e:
            print(f"[{provider}] 예외 발생: {type(e).__name__}: {e}")
            if not is_last:
                next_p = chain[i + 1]
                yield f"\n⚠️ [{provider}] 연결 오류({type(e).__name__}) → {next_p}로 전환 중...\n\n"
                await asyncio.sleep(1)
                continue
            else:
                yield f"\n⚠️ [{provider}] 오류: {type(e).__name__}: {str(e)[:100]}"
                return


async def chat(messages: list, context: str = "") -> str:
    result = []
    async for token in chat_stream(messages, context):
        result.append(token)
    return "".join(result)


def current_model_info() -> dict:
    chain = _provider_chain()
    primary = chain[0]
    labels = {
        "openrouter": {"provider": "OpenRouter", "model": OPENROUTER_MODEL, "limit": "200건/일(무료)"},
        "groq":       {"provider": "Groq",        "model": GROQ_MODEL,        "limit": "14,400건/일"},
        "gemini":     {"provider": "Google Gemini","model": GEMINI_MODEL,      "limit": "1,500건/일"},
        "local":      {"provider": "자체 TF-IDF 엔진", "model": "키워드 검색", "limit": "무제한"},
    }
    info = labels.get(primary, labels["local"])
    info["free"] = True
    info["fallback_chain"] = " → ".join(chain)

    # 쿨다운 중인 제공자 표시
    cooling = {}
    for p in ["openrouter", "groq", "gemini"]:
        if _is_cooling_down(p):
            remaining = int(_rate_limit_until[p] - time.time())
            cooling[p] = f"{remaining // 60}분 후 복구"
    if cooling:
        info["cooling_down"] = cooling

    return info
