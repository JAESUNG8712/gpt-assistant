#!/usr/bin/env python3
"""
법령 KB 추가 파일을 knowledge_labor_laws.py에 병합하는 스크립트.
ai/ 디렉토리에서 실행: python3 merge_kb_additions.py
"""
import os
import glob
import importlib.util

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
KB_FILE = os.path.join(BASE_DIR, "knowledge_labor_laws.py")
ADDITIONS_PATTERN = os.path.join(BASE_DIR, "kb_add_*.py")


def load_additions(path):
    spec = importlib.util.spec_from_file_location("additions", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return getattr(mod, "ADDITIONS", [])


def entry_to_python(entry, indent=4) -> str:
    pad = " " * indent
    q = entry["q"].replace("\\", "\\\\").replace('"', '\\"')
    a = entry["a"]
    return (
        f'{pad}{{\n'
        f'{pad}    "persona": "hr",\n'
        f'{pad}    "q": "{q}",\n'
        f'{pad}    "a": """{a}""",\n'
        f'{pad}}},\n'
    )


def main():
    addition_files = sorted(glob.glob(ADDITIONS_PATTERN))
    if not addition_files:
        print("⚠️  병합할 파일 없음 (kb_add_*.py 파일이 없습니다)")
        return

    all_additions = []
    for path in addition_files:
        law_name = os.path.basename(path).replace("kb_add_", "").replace(".py", "")
        entries = load_additions(path)
        print(f"  → {law_name}: {len(entries)}개 조항")
        all_additions.extend(entries)

    if not all_additions:
        print("⚠️  추가할 항목 없음")
        return

    print(f"\n총 {len(all_additions)}개 항목을 {KB_FILE}에 병합합니다...")

    with open(KB_FILE, encoding="utf-8") as f:
        content = f.read()

    # Find the closing ']' of LABOR_LAW_KNOWLEDGE (before __all__)
    insert_marker = "\n]\n\n__all__"
    if insert_marker not in content:
        # Try alternate ending
        insert_marker = "\n]\n\n__all__"
        if "],\n\n]\n\n__all__" in content:
            insert_marker = "\n]\n\n__all__"

    if insert_marker not in content:
        print("❌ 병합 위치를 찾을 수 없습니다. knowledge_labor_laws.py 구조를 확인하세요.")
        return

    # Build the new entries string
    new_entries = ""
    for entry in all_additions:
        new_entries += entry_to_python(entry)

    # Insert before the closing ]
    new_content = content.replace(
        insert_marker,
        "\n" + new_entries + "]\n\n__all__",
        1  # replace only first occurrence
    )

    if new_content == content:
        print("❌ 내용 변경 없음 — 삽입 위치를 찾지 못했습니다.")
        return

    with open(KB_FILE, "w", encoding="utf-8") as f:
        f.write(new_content)

    print(f"✅ 병합 완료: {len(all_additions)}개 항목 추가됨")

    # Verify the file is valid Python
    import ast
    try:
        with open(KB_FILE, encoding="utf-8") as f:
            ast.parse(f.read())
        print("✅ Python 문법 검증 완료")
    except SyntaxError as e:
        print(f"❌ Python 문법 오류: {e}")
        print("   병합 전 파일로 복원이 필요합니다!")


if __name__ == "__main__":
    main()
