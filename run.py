"""
급여 자동계산 시스템 실행 스크립트.

사용법:
    python run.py

브라우저에서 http://localhost:5000 에 접속합니다.

[오프라인 모드 설정]
인터넷이 연결된 환경에서 아래 명령어를 한 번만 실행하면
이후 오프라인에서도 앱을 사용할 수 있습니다:

    python download_assets.py
"""

from app import app

if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    print(f"\n  급여관리 시스템이 시작되었습니다.")
    print(f"  브라우저에서 http://localhost:{port} 에 접속하세요.\n")
    app.run(debug=False, host="127.0.0.1", port=port)
