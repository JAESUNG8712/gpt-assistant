import os, sys

# ai/ 디렉토리를 기준으로 실행 (Render 루트 배포 대응)
ai_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai")
os.chdir(ai_dir)
sys.path.insert(0, ai_dir)

from main import app  # noqa — re-export for uvicorn
