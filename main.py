import os, sys, importlib.util

# ai/ 디렉토리를 기준으로 실행 (Render 루트 배포 대응)
ai_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai")
os.chdir(ai_dir)
sys.path.insert(0, ai_dir)

# ai/main.py를 직접 로드 (순환 import 방지)
_spec = importlib.util.spec_from_file_location("ai_main", os.path.join(ai_dir, "main.py"))
_mod = importlib.util.module_from_spec(_spec)
sys.modules["ai_main"] = _mod
_spec.loader.exec_module(_mod)

app = _mod.app
