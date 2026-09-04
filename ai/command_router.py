"""짧은 명령형 입력을 기존 채팅 옵션과 자연어 질문으로 변환한다."""
import re


_PERSONA_COMMANDS = {
    "통합": "auto",
    "자동": "auto",
    "인사": "hr",
    "hr": "hr",
    "개발": "dev",
    "코드": "dev",
    "dev": "dev",
    "여행": "travel",
    "회사": "company",
    "사내": "company",
    "주식": "stock",
    "이력서": "resume",
}

_SEARCH_COMMANDS = {"검색", "웹검색", "search"}
_DEEP_COMMANDS = {"깊게", "심층", "deep"}
_FAST_COMMANDS = {"빠르게", "빠른", "fast"}
_CONCISE_COMMANDS = {"간단히", "짧게", "핵심만"}
_DETAIL_COMMANDS = {"자세히", "상세히"}
_SUMMARY_COMMANDS = {"요약", "요약해"}
_TRANSLATE_COMMANDS = {"번역", "번역해"}
_HELP_COMMANDS = {"도움말", "명령어", "help", "?"}
_BARE_COMMANDS = (
    _SEARCH_COMMANDS | _DEEP_COMMANDS | _FAST_COMMANDS
    | _CONCISE_COMMANDS | _DETAIL_COMMANDS | _SUMMARY_COMMANDS | _TRANSLATE_COMMANDS
)

COMMAND_HELP = """## 간편 명령어

명령 뒤에 질문만 붙이면 됩니다. 여러 명령을 이어서 사용할 수도 있습니다.

- `/검색 27년 최저임금` — 인터넷 검색 포함
- `/깊게 퇴직금 중간정산 조건` — 깊은 생각으로 분석
- `/간단히 연차촉진제 설명` — 핵심만 짧게 답변
- `/자세히 부당해고 대응 절차` — 단계와 근거까지 상세 답변
- `/요약 [내용]` — 붙여 넣은 내용 요약
- `/번역 [내용]` — 한국어↔영어 번역
- `/인사`, `/개발`, `/여행`, `/주식`, `/회사`, `/이력서` — 전문가 지정

예: `/검색 /인사 2027년 최저임금 알려줘`
"""


def _command_match(text: str, allow_bare: bool) -> tuple[str, str] | None:
    slash = re.match(r"^[/!]([^\s:：]+)\s*[:：]?\s*(.*)$", text, re.DOTALL)
    if slash:
        return slash.group(1).lower(), slash.group(2).strip()
    if allow_bare:
        bare = re.match(r"^([^\s:：]+)(?:\s*[:：]\s*|\s+)(.+)$", text, re.DOTALL)
        if bare and bare.group(1).lower() in _BARE_COMMANDS:
            return bare.group(1).lower(), bare.group(2).strip()
    return None


def parse_command(text: str) -> dict:
    """최대 4개의 선행 명령을 해석한다. 알 수 없는 명령은 원문 질문으로 유지한다."""
    original = (text or "").strip()
    result = {
        "message": original,
        "persona": "",
        "use_search": False,
        "thinking_mode": "",
        "answer_instruction": "",
        "direct_response": "",
        "applied_commands": [],
    }
    remaining = original
    instructions = []

    for index in range(4):
        matched = _command_match(remaining, allow_bare=(index == 0))
        if not matched:
            break
        command, rest = matched
        recognized = True

        if command in _HELP_COMMANDS:
            result["direct_response"] = COMMAND_HELP
            result["applied_commands"].append(command)
            remaining = ""
            break
        if command in _PERSONA_COMMANDS:
            result["persona"] = _PERSONA_COMMANDS[command]
        elif command in _SEARCH_COMMANDS:
            result["use_search"] = True
        elif command in _DEEP_COMMANDS:
            result["thinking_mode"] = "deep"
        elif command in _FAST_COMMANDS:
            result["thinking_mode"] = "off"
        elif command in _CONCISE_COMMANDS:
            instructions.append("핵심 결론을 먼저 쓰고, 5개 이하의 짧은 항목으로 간결하게 답하세요.")
        elif command in _DETAIL_COMMANDS:
            instructions.append("핵심 결론, 근거, 단계별 실행 방법, 주의사항 순서로 상세히 답하세요.")
        elif command in _SUMMARY_COMMANDS:
            instructions.append("사용자가 제공한 내용을 핵심 사실과 실행 항목 중심으로 요약하세요.")
        elif command in _TRANSLATE_COMMANDS:
            instructions.append("입력이 한국어면 자연스러운 영어로, 그 외 언어면 자연스러운 한국어로 번역하세요.")
        else:
            recognized = False

        if not recognized:
            break
        result["applied_commands"].append(command)
        remaining = rest
        if not remaining:
            break

    if result["applied_commands"] and not result["direct_response"] and not remaining:
        result["direct_response"] = (
            "명령 뒤에 처리할 내용을 입력해 주세요. 예: `/검색 27년 최저임금`\n\n"
            "전체 명령은 `/도움말`에서 확인할 수 있습니다."
        )
    if result["applied_commands"]:
        result["message"] = remaining or original
        result["answer_instruction"] = " ".join(instructions)
    return result
