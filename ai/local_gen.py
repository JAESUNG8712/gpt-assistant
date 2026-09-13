"""
로컬 생성형 모델(실험적, 기본 비활성) — 외부 LLM API가 전부 없을 때, 순수 추출
(`engine._local_synthesize`/`_compose_with_context`) 대신 소형 GGUF 모델로 실제
문장을 새로 생성해보는 선택적 마지막 단계.

## 기본은 완전히 비활성
`LOCAL_GEN_MODEL_PATH`/`LOCAL_GEN_MODEL_URL` 둘 다 미설정이면 `is_configured()`가
False를 반환하고, 그 시점에 곧바로 빠져나가 `llama_cpp`조차 임포트하지 않는다 —
이 모듈이 존재해도 기본 배포(Render 무료 티어) 동작·의존성·메모리 사용량에는
전혀 영향이 없다. `llama-cpp-python`도 기본 `requirements.txt`가 아니라 별도
`requirements-local-gen.txt`에만 있어 빌드 자체에도 영향 없음(.env.example 참고).

## 실측 경고 (2026-09-13, 이 샌드박스에서 실제 다운로드·추론으로 확인 — 추측 아님)
Render 무료 티어는 512MB RAM / 0.1 CPU(웹 검색으로 재확인). 이 예산 안에 들어가는
크기의 모델을 실제로 받아 한국어로 질의해본 결과:
  - SmolLM2-135M-Instruct Q4 (파일 105MB, 실측 프로세스 RAM 207MB):
    한국어 자체가 깨짐 ("연차는 며칠 발생해지는 일이 없습니다..." 식 붕괴)
  - Gemma-3-270M-it Q4 (파일 253MB, 실측 프로세스 RAM 362MB):
    한국어 문법은 자연스러우나, 제공한 참고자료(예: "15일, 최대 25일")를 완전히
    무시하고 "정해진 빈도에 따라 달라집니다" 식 근거 없는 내용을 지어냄 — 지금
    이미 구축된 순수 추출 엔진(`engine._local_synthesize`)보다 오히려 신뢰도가 낮음
  - Qwen2.5-0.5B-Instruct Q4 (파일 491MB): 파일 크기만으로 이미 512MB 예산을 거의
    다 써 나머지 앱(FastAPI·sklearn·KB)이 못 뜰 위험이 큼
그래서 기본값은 비활성을 유지한다. 유료 플랜으로 업그레이드해 RAM 여유가 생긴
뒤 `LOCAL_GEN_MODEL_URL`을 더 크고(1.5B~3B급) 근거를 실제로 따르는 모델로
바꿔 켜는 것을 권장 — 코드 변경 없이 환경변수만 바꾸면 된다.

## 안전 계약
`generate()`는 미설정·다운로드 실패·로드 실패·추론 실패·타임아웃 등 어떤 경우에도
예외를 던지지 않고 None을 반환한다. 호출측(`llm._local_stream`)은 None이면 기존
순수 추출 엔진으로 그대로 이어간다 — 이 모듈의 실패가 답변 자체를 막지 않는다.
"""
import os
import asyncio
import threading
from typing import Optional

MODEL_PATH = os.getenv("LOCAL_GEN_MODEL_PATH", "").strip()
MODEL_URL = os.getenv("LOCAL_GEN_MODEL_URL", "").strip()
N_CTX = int(os.getenv("LOCAL_GEN_N_CTX", "1024"))
N_THREADS = int(os.getenv("LOCAL_GEN_THREADS", "1"))
MAX_TOKENS = int(os.getenv("LOCAL_GEN_MAX_TOKENS", "220"))
TIMEOUT_SECONDS = float(os.getenv("LOCAL_GEN_TIMEOUT", "45"))
CHAT_FORMAT = os.getenv("LOCAL_GEN_CHAT_FORMAT", "").strip() or None
MAX_CONTEXT_CHARS = int(os.getenv("LOCAL_GEN_MAX_CONTEXT_CHARS", "2500"))

# 정상 답변과 명확히 구분되는 표시 — auto_learn이 이 표시가 있으면 KB 학습에서
# 제외한다(main.py). 검증되지 않은 실험적 생성물이 장기기억으로 들어가는 것을 차단.
MARKER_TAG = "로컬 생성 모델 결과(실험적)"
MARKER = (
    f"🤖 **{MARKER_TAG}** — 외부 AI 없이 소형 모델이 직접 작성한 답변입니다. "
    "검증되지 않았으니 참고용으로만 확인하세요.\n\n"
)

_lock = threading.Lock()
_model = None       # 지연 로드 — 최초 generate() 호출 시에만 llama_cpp/모델 파일 로드
_load_failed = False


def is_configured() -> bool:
    """환경변수가 하나라도 설정돼 있어야 True. 미설정이면 이 모듈은 완전히
    비활성이며 llama_cpp도 전혀 임포트하지 않는다(기본 배포에 영향 없음)."""
    return bool(MODEL_PATH or MODEL_URL)


def _default_cache_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "local_gen_model.gguf")


def _ensure_model_file() -> Optional[str]:
    """모델 파일 경로를 반환. 로컬에 없고 LOCAL_GEN_MODEL_URL이 있으면 1회 다운로드."""
    path = MODEL_PATH or _default_cache_path()
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    if not MODEL_URL:
        return None
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    import httpx
    tmp_path = path + ".part"
    with httpx.stream("GET", MODEL_URL, timeout=600, follow_redirects=True) as resp:
        resp.raise_for_status()
        with open(tmp_path, "wb") as f:
            for chunk in resp.iter_bytes(chunk_size=1 << 20):
                f.write(chunk)
    os.replace(tmp_path, path)
    return path


def _load_model_sync():
    global _model, _load_failed
    if _model is not None or _load_failed:
        return _model
    with _lock:
        if _model is not None or _load_failed:
            return _model
        try:
            path = _ensure_model_file()
            if not path:
                _load_failed = True
                return None
            from llama_cpp import Llama
            kwargs = {"model_path": path, "n_ctx": N_CTX, "n_threads": N_THREADS, "verbose": False}
            if CHAT_FORMAT:
                kwargs["chat_format"] = CHAT_FORMAT
            _model = Llama(**kwargs)
        except Exception as e:
            print(f"⚠️ 로컬 생성 모델 로드 실패(순수 추출 엔진으로 계속 진행): {e}")
            _load_failed = True
            _model = None
    return _model


def _build_messages(user_msg: str, context: str, system: str) -> list:
    ctx = (context or "")[:MAX_CONTEXT_CHARS]
    sys_text = system or "당신은 한국어로 답하는 어시스턴트입니다."
    sys_text += (
        "\n\n아래 참고 자료에 실제로 있는 내용만 근거로 간결하게 답하세요. "
        "참고 자료에 없는 내용은 절대 지어내지 말고, 없으면 '자료에 없음'이라고 밝히세요."
    )
    if ctx:
        sys_text += f"\n\n참고 자료:\n{ctx}"
    return [{"role": "system", "content": sys_text}, {"role": "user", "content": user_msg}]


def _generate_sync(user_msg: str, context: str, system: str) -> Optional[str]:
    model = _load_model_sync()
    if model is None:
        return None
    try:
        messages = _build_messages(user_msg, context, system)
        out = model.create_chat_completion(messages=messages, max_tokens=MAX_TOKENS, temperature=0.3)
        text = (out["choices"][0]["message"]["content"] or "").strip()
        return text or None
    except Exception as e:
        print(f"⚠️ 로컬 생성 모델 추론 실패(순수 추출 엔진으로 계속 진행): {e}")
        return None


async def generate(messages: list, context: str, system: str) -> Optional[str]:
    """미설정·실패·타임아웃 등 어떤 경우에도 None만 반환 — 호출측이 기존 순수
    추출 엔진(engine.local_stream)으로 안전하게 이어가도록 하기 위함."""
    if not is_configured():
        return None
    user_msg = ""
    for m in reversed(messages or []):
        if m.get("role") == "user":
            user_msg = m.get("content", "")
            break
    if not user_msg.strip():
        return None
    loop = asyncio.get_event_loop()
    try:
        text = await asyncio.wait_for(
            loop.run_in_executor(None, _generate_sync, user_msg, context, system),
            timeout=TIMEOUT_SECONDS,
        )
    except Exception as e:
        print(f"⚠️ 로컬 생성 모델 호출 실패/타임아웃(순수 추출 엔진으로 계속 진행): {e}")
        return None
    if not text:
        return None
    return MARKER + text
