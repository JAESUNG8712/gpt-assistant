# GPT Assistant — 에이전트 작업 규칙 (OpenCode / 기타 AI 코딩 에이전트용)

이 프로젝트의 상세 규칙·팀 구성·프로젝트 기록은 **`CLAUDE.md`** 를 따른다.
(`opencode.json`의 `instructions`에 CLAUDE.md가 등록되어 있어 자동 로드됨)

## 핵심 요약

- **레포**: jaesung8712/gpt-assistant / 개발 브랜치: `claude/account-pinned-agents-v6W7p`
- **구조**: `ai/` = FastAPI 기반 자체 AI 어시스턴트 (Groq/무료 LLM + TF-IDF RAG + Turso DB)
- **배포**: Render.com 무료 (https://ai-assist-aosk.onrender.com), DB는 Turso 클라우드
- **언어**: 커밋 메시지·주석·문서는 한국어

## 작업 규칙

1. 8인 팀 에이전트 구성(CLAUDE.md 참조)은 명시적 요청 없이 변경하지 않는다.
2. 중요한 결정은 CLAUDE.md의 "프로젝트 기록" 섹션에 날짜와 함께 추가한다.
3. 계산기(`ai/calculator.py`) 수정 시 QA 테스트를 반드시 재실행한다.
4. LLM 관련 수정 시 무료 제공자 폴백 체인(claude → zen → openrouter → groq → gemini → local)이 깨지지 않는지 확인한다.
5. 답변에 할루시네이션 방지 원칙 유지: 자료에 없는 내용 생성 금지, 출처 표시.

## 무료 모델로 개발하기

이 레포는 `opencode.json`에 OpenCode Zen 무료 모델(`deepseek-v4-flash-free`)이 기본 설정되어 있다.
`opencode auth login` 후 바로 사용 가능하며, 유료 API 키가 필요 없다.
자세한 안내: `ai/OPENCODE_GUIDE.md`
