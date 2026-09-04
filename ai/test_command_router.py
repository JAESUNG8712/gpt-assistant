"""간편 명령 라우터 회귀 테스트."""
import command_router


def main():
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

    unknown = command_router.parse_command("/알수없음 원문 유지")
    assert unknown["message"] == "/알수없음 원문 유지"
    assert unknown["applied_commands"] == []

    ordinary = command_router.parse_command("회사 규정을 알려줘")
    assert ordinary["message"] == "회사 규정을 알려줘"
    assert ordinary["persona"] == ""

    print("command router tests: PASS")


if __name__ == "__main__":
    main()
