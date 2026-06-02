#!/usr/bin/env python3
"""
kb_add_직무분석.py, kb_add_인사평가_*.py 파일들을
knowledge_hr_management.py로 통합하는 스크립트.

ai/ 디렉토리에서 실행: python3 create_hr_management_kb.py
"""
import os
import glob
import ast
import importlib.util

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(BASE_DIR, "knowledge_hr_management.py")
PATTERNS = [
    os.path.join(BASE_DIR, "kb_add_직무분석.py"),
    os.path.join(BASE_DIR, "kb_add_인사평가_방법.py"),
    os.path.join(BASE_DIR, "kb_add_인사평가_직무별.py"),
    os.path.join(BASE_DIR, "kb_add_인사평가_설계.py"),
]


def load_additions(path):
    spec = importlib.util.spec_from_file_location("additions", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return getattr(mod, "ADDITIONS", [])


def escape_for_repr(text):
    # Use repr() to get a safe Python string literal, then unwrap quotes
    return text


def entry_to_python(entry, indent=4) -> str:
    pad = " " * indent
    q_escaped = entry["q"].replace("\\", "\\\\").replace('"', '\\"')
    a_text = entry["a"]
    # Use triple-quoted string for 'a', escape any triple-quotes inside
    a_escaped = a_text.replace('"""', '\\"\\"\\"')
    return (
        f'{pad}{{\n'
        f'{pad}    "persona": "hr",\n'
        f'{pad}    "q": "{q_escaped}",\n'
        f'{pad}    "a": """{a_escaped}""",\n'
        f'{pad}}},\n'
    )


def main():
    all_additions = []
    found_files = []

    for pattern in PATTERNS:
        if os.path.exists(pattern):
            found_files.append(pattern)
            entries = load_additions(pattern)
            name = os.path.basename(pattern)
            print(f"  → {name}: {len(entries)}개 항목")
            all_additions.extend(entries)
        else:
            print(f"  ⚠️  미완성: {os.path.basename(pattern)} (아직 없음)")

    if not all_additions:
        print("⚠️  추가할 항목 없음")
        return

    print(f"\n총 {len(all_additions)}개 항목으로 {OUTPUT_FILE} 생성...")

    lines = ['"""\n']
    lines.append('HR 관리 지식베이스 — 직무분석, 인사평가\n')
    lines.append('knowledge_base.py에서 자동 import됩니다.\n')
    lines.append('"""\n\n')
    lines.append('HR_MANAGEMENT_KNOWLEDGE = [\n\n')
    lines.append('    # ══════════════════════════════════════════════\n')
    lines.append('    #  직무분석 & 인사평가\n')
    lines.append('    # ══════════════════════════════════════════════\n\n')

    for entry in all_additions:
        lines.append(entry_to_python(entry))

    lines.append(']\n\n')
    lines.append("__all__ = ['HR_MANAGEMENT_KNOWLEDGE']\n")

    content = "".join(lines)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(content)

    # Verify syntax
    try:
        ast.parse(content)
        print("✅ Python 문법 검증 완료")
    except SyntaxError as e:
        print(f"❌ 문법 오류: {e}")
        return

    # Remove processed files
    for path in found_files:
        os.remove(path)
        print(f"   🗑  {os.path.basename(path)} 삭제")

    print(f"\n✅ {OUTPUT_FILE} 생성 완료 ({len(all_additions)}개 항목)")
    print("   다음 단계: knowledge_base.py에 import 추가")


if __name__ == "__main__":
    main()
