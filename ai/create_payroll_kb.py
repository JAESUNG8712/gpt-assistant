#!/usr/bin/env python3
"""
kb_add_급여계산·연말정산·퇴직연금계산·사회보험세금.py 파일들을
knowledge_payroll.py로 통합하는 스크립트.

ai/ 디렉토리에서 실행: python3 create_payroll_kb.py
"""
import os, glob, ast, importlib.util

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(BASE_DIR, "knowledge_payroll.py")
PATTERNS = [
    os.path.join(BASE_DIR, "kb_add_급여계산.py"),
    os.path.join(BASE_DIR, "kb_add_연말정산.py"),
    os.path.join(BASE_DIR, "kb_add_퇴직연금계산.py"),
    os.path.join(BASE_DIR, "kb_add_사회보험세금.py"),
]


def load_additions(path):
    spec = importlib.util.spec_from_file_location("additions", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return getattr(mod, "ADDITIONS", [])


def entry_to_python(entry, indent=4) -> str:
    pad = " " * indent
    q_escaped = entry["q"].replace("\\", "\\\\").replace('"', '\\"')
    a_escaped = entry["a"].replace('"""', '\\"\\"\\"')
    return (
        f'{pad}{{\n'
        f'{pad}    "persona": "hr",\n'
        f'{pad}    "q": "{q_escaped}",\n'
        f'{pad}    "a": """{a_escaped}""",\n'
        f'{pad}}},\n'
    )


def main():
    all_additions, found_files = [], []
    for pattern in PATTERNS:
        if os.path.exists(pattern):
            found_files.append(pattern)
            entries = load_additions(pattern)
            print(f"  → {os.path.basename(pattern)}: {len(entries)}개 항목")
            all_additions.extend(entries)
        else:
            print(f"  ⚠️  미완성: {os.path.basename(pattern)}")

    if not all_additions:
        print("⚠️  추가할 항목 없음"); return

    print(f"\n총 {len(all_additions)}개 항목으로 {OUTPUT_FILE} 생성...")

    lines = [
        '"""\n급여·4대보험·연말정산·퇴직연금 지식베이스\n'
        'knowledge_base.py에서 자동 import됩니다.\n"""\n\n',
        'PAYROLL_KNOWLEDGE = [\n\n',
        '    # ══════════════════════════════════════════════\n',
        '    #  급여·4대보험·연말정산·퇴직연금·소득세\n',
        '    # ══════════════════════════════════════════════\n\n',
    ]
    for entry in all_additions:
        lines.append(entry_to_python(entry))
    lines.append(']\n\n__all__ = [\'PAYROLL_KNOWLEDGE\']\n')

    content = "".join(lines)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(content)

    try:
        ast.parse(content)
        print("✅ Python 문법 검증 완료")
    except SyntaxError as e:
        print(f"❌ 문법 오류: {e}"); return

    for path in found_files:
        os.remove(path)
        print(f"   🗑  {os.path.basename(path)} 삭제")

    print(f"\n✅ {OUTPUT_FILE} 생성 완료 ({len(all_additions)}개 항목)")


if __name__ == "__main__":
    main()
