import os, sys

# ai/ 디렉토리를 기준으로 실행
ai_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai")
os.chdir(ai_dir)
sys.path.insert(0, ai_dir)

# 실제 fetch_laws 실행
import fetch_laws  # noqa
