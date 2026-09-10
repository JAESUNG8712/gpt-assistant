"""짧은 명령형 입력을 기존 채팅 옵션과 자연어 질문으로 변환한다."""
import re


# 파서, 도움말 API, 웹 자동완성이 함께 사용하는 단일 명령 정의.
# 새 명령을 추가할 때 이 목록만 수정하면 서버와 화면이 동시에 갱신된다.
COMMAND_DEFINITIONS = [
    {"name": "검색", "aliases": ["웹검색", "search"], "kind": "search",
     "icon": "🌐", "label": "인터넷 검색", "description": "최신 자료를 검색해 답변", "category": "답변", "featured": True},
    {"name": "깊게", "aliases": ["심층", "deep"], "kind": "deep",
     "icon": "🧠", "label": "깊은 분석", "description": "한 번 더 검토해 정밀하게 답변", "category": "답변", "featured": True},
    {"name": "빠르게", "aliases": ["빠른", "fast"], "kind": "fast",
     "icon": "⚡", "label": "빠른 답변", "description": "추가 추론 없이 빠르게 답변", "category": "답변"},
    {"name": "간단히", "aliases": ["짧게", "핵심만"], "kind": "concise",
     "icon": "✂️", "label": "간단히", "description": "핵심만 짧게 답변", "category": "형식", "featured": True},
    {"name": "자세히", "aliases": ["상세히"], "kind": "detail",
     "icon": "📝", "label": "자세히", "description": "근거와 실행 단계까지 설명", "category": "형식"},
    {"name": "요약", "aliases": ["요약해"], "kind": "summary",
     "icon": "📌", "label": "요약", "description": "붙여 넣은 내용을 핵심 위주로 요약", "category": "작업"},
    {"name": "번역", "aliases": ["번역해"], "kind": "translate",
     "icon": "🌏", "label": "번역", "description": "한국어와 영어를 자연스럽게 번역", "category": "작업"},
    {"name": "기억", "aliases": ["기억해", "기억해줘"], "kind": "memory_save",
     "icon": "🧠", "label": "개인 기억 저장", "description": "내 선호나 정보를 안전하게 기억", "category": "기억", "featured": True},
    {"name": "기억목록", "aliases": ["내기억", "기억보기"], "kind": "memory_list",
     "icon": "📚", "label": "내 기억 보기", "description": "내가 직접 저장한 기억 목록 확인", "category": "기억",
     "requires_message": False},
    {"name": "잊기", "aliases": ["잊어", "잊어줘"], "kind": "memory_forget",
     "icon": "🧹", "label": "개인 기억 삭제", "description": "지정한 개인 기억을 복구 가능하게 삭제", "category": "기억"},
    {"name": "통합", "aliases": ["자동"], "kind": "persona", "value": "auto",
     "icon": "🤖", "label": "통합 전문가", "description": "질문에 맞는 전문가를 자동 선택", "category": "전문가"},
    {"name": "인사", "aliases": ["hr"], "kind": "persona", "value": "hr",
     "icon": "👥", "label": "인사 전문가", "description": "노무·급여·근로기준 질문", "category": "전문가"},
    {"name": "개발", "aliases": ["코드", "dev"], "kind": "persona", "value": "dev",
     "icon": "💻", "label": "개발 전문가", "description": "코드·서버·기술 질문", "category": "전문가"},
    {"name": "여행", "aliases": [], "kind": "persona", "value": "travel",
     "icon": "✈️", "label": "여행 전문가", "description": "여행 일정·입국·안전 질문", "category": "전문가"},
    {"name": "회사", "aliases": ["사내"], "kind": "persona", "value": "company",
     "icon": "🏢", "label": "회사 규정", "description": "등록된 사내 규정에서 답변", "category": "전문가"},
    {"name": "주식", "aliases": [], "kind": "persona", "value": "stock",
     "icon": "📈", "label": "주식 전문가", "description": "종목·시황·공시 분석", "category": "전문가"},
    {"name": "이력서", "aliases": [], "kind": "persona", "value": "resume",
     "icon": "📄", "label": "이력서 전문가", "description": "이력서·자소서·면접 질문", "category": "전문가"},
    {"name": "도움말", "aliases": ["명령어", "help", "?"], "kind": "help",
     "icon": "❓", "label": "명령어 도움말", "description": "사용 가능한 명령 전체 보기", "category": "도움말",
     "requires_message": False, "featured": True},
]


def _names(kind: str) -> set[str]:
    return {
        name.lower()
        for item in COMMAND_DEFINITIONS if item["kind"] == kind
        for name in [item["name"], *item.get("aliases", [])]
    }


_PERSONA_COMMANDS = {
    name.lower(): item["value"]
    for item in COMMAND_DEFINITIONS if item["kind"] == "persona"
    for name in [item["name"], *item.get("aliases", [])]
}
_COMMAND_LOOKUP = {
    name.lower(): item
    for item in COMMAND_DEFINITIONS
    for name in [item["name"], *item.get("aliases", [])]
}
_SEARCH_COMMANDS = _names("search")
_DEEP_COMMANDS = _names("deep")
_FAST_COMMANDS = _names("fast")
_CONCISE_COMMANDS = _names("concise")
_DETAIL_COMMANDS = _names("detail")
_SUMMARY_COMMANDS = _names("summary")
_TRANSLATE_COMMANDS = _names("translate")
_MEMORY_SAVE_COMMANDS = _names("memory_save")
_MEMORY_LIST_COMMANDS = _names("memory_list")
_MEMORY_FORGET_COMMANDS = _names("memory_forget")
_HELP_COMMANDS = _names("help")
_BARE_COMMANDS = (
    _SEARCH_COMMANDS | _DEEP_COMMANDS | _FAST_COMMANDS
    | _CONCISE_COMMANDS | _DETAIL_COMMANDS | _SUMMARY_COMMANDS | _TRANSLATE_COMMANDS
    | _MEMORY_SAVE_COMMANDS | _MEMORY_FORGET_COMMANDS
)

COMMAND_HELP = """## 간편 명령어

명령 뒤에 질문만 붙이면 됩니다. 여러 명령을 이어서 사용할 수도 있습니다.

- `/검색 27년 최저임금` — 인터넷 검색 포함
- `/깊게 퇴직금 중간정산 조건` — 깊은 생각으로 분석
- `/간단히 연차촉진제 설명` — 핵심만 짧게 답변
- `/자세히 부당해고 대응 절차` — 단계와 근거까지 상세 답변
- `/요약 [내용]` — 붙여 넣은 내용 요약
- `/번역 [내용]` — 한국어↔영어 번역
- `/기억 [내용]` — 내 선호나 정보를 개인 기억으로 저장
- `/기억목록` — 내가 직접 저장한 기억 확인
- `/잊기 [키워드]` — 일치하는 개인 기억을 복구 가능하게 삭제
- `/인사`, `/개발`, `/여행`, `/주식`, `/회사`, `/이력서` — 전문가 지정

예: `/검색 /인사 2027년 최저임금 알려줘`
"""


def command_catalog() -> list[dict]:
    """화면 자동완성에 필요한 안전한 공개 명령 메타데이터를 반환한다."""
    return [
        {
            "name": item["name"],
            "command": f'/{item["name"]}',
            "aliases": [f"/{alias}" for alias in item.get("aliases", [])],
            "icon": item["icon"],
            "label": item["label"],
            "description": item["description"],
            "category": item["category"],
            "kind": item["kind"],
            "persona": item.get("value") if item["kind"] == "persona" else "",
            "requires_message": item.get("requires_message", True),
            "featured": item.get("featured", False),
        }
        for item in COMMAND_DEFINITIONS
    ]


def applied_command_status(commands: list[str]) -> list[dict]:
    """해석된 별칭을 화면 표시용 대표 명령으로 정규화한다."""
    result, seen = [], set()
    for raw_name in commands:
        item = _COMMAND_LOOKUP.get(str(raw_name).lower())
        if not item or item["name"] in seen:
            continue
        seen.add(item["name"])
        result.append({
            "name": item["name"],
            "command": f'/{item["name"]}',
            "icon": item["icon"],
            "label": item["label"],
            "kind": item["kind"],
            "persona": item.get("value") if item["kind"] == "persona" else "",
        })
    return result


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
        "memory_action": "",
        "memory_content": "",
        "applied_commands": [],
    }
    # 질문으로 오해할 여지가 거의 없는 자연스러운 기억 조회 표현도 명령으로 처리한다.
    if re.fullmatch(
        r"(?:내가\s*)?(?:뭘|무엇을)?\s*기억(?:시켰|했)는?(?:지)?\??|"
        r"내\s*기억\s*(?:보여줘|알려줘|목록)|기억한\s*(?:것|내용)\s*(?:보여줘|알려줘)",
        original,
    ):
        result["memory_action"] = "list"
        result["applied_commands"] = ["기억목록"]
        return result
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
        elif command in _MEMORY_SAVE_COMMANDS:
            result["memory_action"] = "save"
            result["memory_content"] = rest
        elif command in _MEMORY_LIST_COMMANDS:
            result["memory_action"] = "list"
        elif command in _MEMORY_FORGET_COMMANDS:
            result["memory_action"] = "forget"
            result["memory_content"] = rest
        else:
            recognized = False

        if not recognized:
            break
        result["applied_commands"].append(command)
        remaining = rest
        # 기억 변경/조회는 그 뒤 문자열 전체를 데이터로 다루는 독립 명령이다.
        # 내용 안의 `/검색` 같은 문자열을 후속 실행 명령으로 오해하지 않는다.
        if result["memory_action"]:
            break
        if not remaining:
            break

    if (result["applied_commands"] and not result["direct_response"] and not remaining
            and not result["memory_action"]):
        result["direct_response"] = (
            "명령 뒤에 처리할 내용을 입력해 주세요. 예: `/검색 27년 최저임금`\n\n"
            "전체 명령은 `/도움말`에서 확인할 수 있습니다."
        )
    if result["applied_commands"]:
        result["message"] = remaining or original
        result["answer_instruction"] = " ".join(instructions)
    return result
