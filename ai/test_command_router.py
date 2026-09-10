"""간편 명령 라우터 회귀 테스트."""
import command_router


def main():
    catalog = command_router.command_catalog()
    assert len(catalog) >= 18
    assert len({item["command"] for item in catalog}) == len(catalog)
    assert all(item["command"].startswith("/") for item in catalog)
    all_names = [name.lower() for item in catalog for name in [item["command"], *item["aliases"]]]
    assert len(all_names) == len(set(all_names))
    assert next(item for item in catalog if item["command"] == "/도움말")["requires_message"] is False
    assert all(item["kind"] for item in catalog)

    normalized = command_router.applied_command_status(["deep", "hr", "심층"])
    assert [item["command"] for item in normalized] == ["/깊게", "/인사"]
    assert [item["kind"] for item in normalized] == ["deep", "persona"]

    search = command_router.parse_command("검색 27년 최저임금")
    assert search["message"] == "27년 최저임금"
    assert search["use_search"] is True

    colon_search = command_router.parse_command("검색:27년 최저임금")
    assert colon_search["message"] == "27년 최저임금"
    assert colon_search["use_search"] is True

    chained = command_router.parse_command("/검색 /인사 2027년 최저임금 알려줘")
    assert chained["message"] == "2027년 최저임금 알려줘"
    assert chained["use_search"] is True
    assert chained["persona"] == "hr"

    concise = command_router.parse_command("/간단히 연차촉진제 설명")
    assert concise["message"] == "연차촉진제 설명"
    assert "간결하게" in concise["answer_instruction"]

    translate = command_router.parse_command("/번역 Good morning")
    assert translate["message"] == "Good morning"
    assert "번역" in translate["answer_instruction"]

    deep = command_router.parse_command("/깊게 /개발 FastAPI 오류 분석")
    assert deep["thinking_mode"] == "deep"
    assert deep["persona"] == "dev"
    assert deep["message"] == "FastAPI 오류 분석"

    help_command = command_router.parse_command("/도움말")
    assert "간편 명령어" in help_command["direct_response"]

    missing = command_router.parse_command("/검색")
    assert "명령 뒤에" in missing["direct_response"]

    remember = command_router.parse_command("기억해 답변은 핵심부터 짧게 해줘")
    assert remember["memory_action"] == "save"
    assert remember["memory_content"] == "답변은 핵심부터 짧게 해줘"

    memories = command_router.parse_command("내가 뭘 기억시켰지?")
    assert memories["memory_action"] == "list"
    assert memories["direct_response"] == ""

    forget = command_router.parse_command("/잊기 핵심부터")
    assert forget["memory_action"] == "forget"
    assert forget["memory_content"] == "핵심부터"

    literal_memory = command_router.parse_command("/기억 /검색은 최신 정보에 사용")
    assert literal_memory["memory_content"] == "/검색은 최신 정보에 사용"
    assert literal_memory["use_search"] is False

    unknown = command_router.parse_command("/알수없음 원문 유지")
    assert unknown["message"] == "/알수없음 원문 유지"
    assert unknown["applied_commands"] == []

    ordinary = command_router.parse_command("회사 규정을 알려줘")
    assert ordinary["message"] == "회사 규정을 알려줘"
    assert ordinary["persona"] == ""

    aliases = command_router.parse_command("/deep /hr 연차 조건")
    assert aliases["thinking_mode"] == "deep"
    assert aliases["persona"] == "hr"

    print("command router tests: PASS")


if __name__ == "__main__":
    main()
