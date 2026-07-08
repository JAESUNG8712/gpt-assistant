# OpenCode 연계 가이드 — 유료 API 없이 사용하기

OpenCode(https://opencode.ai)는 오픈소스 AI 코딩 에이전트입니다.
이 프로젝트는 두 가지 방식으로 OpenCode와 연계되어 있습니다.

---

## 1. AI 어시스턴트 서버가 OpenCode Zen 무료 모델 사용

`ai/llm.py`의 제공자 폴백 체인에 **OpenCode Zen**(무료 모델 게이트웨이)이 통합되어 있습니다.

```
Claude(유료·선택) → OpenCode Zen(무료) → OpenRouter(무료) → Groq(무료) → Gemini(무료) → 자체 엔진
```

### 설정 방법

1. https://opencode.ai/auth 접속 → GitHub 로그인
2. API 키 발급 (무료 모델만 사용하면 과금 없음)
3. Render 환경변수에 추가:
   - `OPENCODE_ZEN_API_KEY` = 발급받은 키
   - `ZEN_MODEL` = 사용할 모델 (선택, 기본값 `deepseek-v4-flash-free`)
4. 재배포하면 자동으로 폴백 체인에 포함됨

### Zen 무료 모델 목록 (2026-07 기준, limited time)

| 모델 ID | 비고 |
|---|---|
| `deepseek-v4-flash-free` | 기본값 — 빠르고 품질 좋음 |
| `nemotron-3-ultra-free` | NVIDIA 대형 모델 |
| `mimo-v2.5-free` | Xiaomi |
| `hy3-free` | Tencent Hunyuan |
| `north-mini-code-free` | 코딩 특화 |

기본 모델이 종료(404)되면 위 목록 순서로 자동 재시도합니다 (`ZEN_FALLBACK_MODELS`).

> 참고: 무료 모델은 "한시적(limited time)" 제공입니다. 전부 종료되어도
> 폴백 체인의 Groq/Gemini가 이어받으므로 서비스는 중단되지 않습니다.

---

## 2. OpenCode로 이 프로젝트 개발하기 (유료 API 불필요)

레포 루트에 `opencode.json`(무료 모델 기본 설정)과 `AGENTS.md`(작업 규칙)가 준비되어 있습니다.

### 설치 및 실행

```bash
# 설치 (macOS/Linux)
curl -fsSL https://opencode.ai/install | bash

# 또는 npm
npm install -g opencode-ai

# 프로젝트에서 실행
cd gpt-assistant
opencode auth login       # opencode 선택 → 브라우저 로그인 (무료)
opencode                  # TUI 시작 — 무료 모델(deepseek-v4-flash-free)로 바로 작동
```

### 이미 있는 무료 키를 쓰고 싶다면

Groq 키(현재 Render에서 사용 중)를 그대로 쓸 수 있습니다:

```bash
opencode auth login       # 목록에서 Groq 선택 → GROQ_API_KEY 입력
```

TUI에서 `/models` 명령으로 `groq/llama-3.3-70b-versatile` 선택.

### 참고

- OpenCode는 `AGENTS.md`와 `opencode.json`의 `instructions`(CLAUDE.md)를 자동으로 읽어
  이 프로젝트의 팀 구성·작업 규칙·기록을 따릅니다.
- 문서: https://opencode.ai/docs/ko
