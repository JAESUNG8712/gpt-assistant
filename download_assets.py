"""
오프라인 사용을 위한 정적 파일 다운로드 스크립트.
인터넷이 연결된 환경에서 한 번만 실행하면 이후 오프라인 사용이 가능합니다.

    python download_assets.py
"""

import os
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))

ASSETS = [
    (
        "https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css",
        os.path.join(BASE, "static", "css", "bootstrap.min.css"),
    ),
    (
        "https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js",
        os.path.join(BASE, "static", "js", "bootstrap.bundle.min.js"),
    ),
    (
        "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css",
        os.path.join(BASE, "static", "css", "bootstrap-icons.min.css"),
    ),
    (
        "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff2",
        os.path.join(BASE, "static", "fonts", "bootstrap-icons.woff2"),
    ),
]


def download():
    for url, dest in ASSETS:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.exists(dest):
            print(f"  skip (already exists): {os.path.basename(dest)}")
            continue
        print(f"  downloading {os.path.basename(dest)} ...", end=" ", flush=True)
        try:
            urllib.request.urlretrieve(url, dest)
            print("ok")
        except Exception as e:
            print(f"FAILED: {e}")

    # bootstrap-icons.css 에서 폰트 경로를 로컬 경로로 수정
    icon_css = os.path.join(BASE, "static", "css", "bootstrap-icons.min.css")
    if os.path.exists(icon_css):
        with open(icon_css, "r", encoding="utf-8") as f:
            content = f.read()
        content = content.replace("../fonts/", "/static/fonts/")
        with open(icon_css, "w", encoding="utf-8") as f:
            f.write(content)
        print("  patched bootstrap-icons.min.css font path")


if __name__ == "__main__":
    print("정적 파일 다운로드 중...")
    download()
    print("완료. 이제 오프라인에서도 앱을 실행할 수 있습니다.")
