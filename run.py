"""
급여 자동계산 시스템 실행 스크립트.

사용법:
    python run.py

같은 Wi-Fi에 연결된 iPad / 스마트폰에서도 접속 가능합니다.

[오프라인 모드 설정]
인터넷이 연결된 환경에서 아래 명령어를 한 번만 실행하면
이후 오프라인에서도 앱을 사용할 수 있습니다:

    python download_assets.py
"""

import os
import socket
from app import app


def get_local_ips():
    """같은 네트워크에서 접속 가능한 IP 목록 반환"""
    ips = []
    try:
        # 외부 연결 시도로 실제 사용 중인 인터페이스 IP 파악
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ips.append(s.getsockname()[0])
    except Exception:
        pass
    # 추가 IP (멀티 인터페이스 환경)
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    return ips


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))

    print("\n" + "=" * 52)
    print("  급여관리 시스템 시작")
    print("=" * 52)
    print(f"  PC 브라우저  →  http://localhost:{port}")
    local_ips = get_local_ips()
    if local_ips:
        for ip in local_ips:
            print(f"  iPad / 모바일  →  http://{ip}:{port}")
    else:
        print("  (네트워크 IP를 감지하지 못했습니다)")
    print()
    print("  * iPad와 PC가 같은 Wi-Fi에 연결되어 있어야 합니다.")
    print("  * 종료: Ctrl+C")
    print("=" * 52 + "\n")

    # 0.0.0.0 으로 바인딩해야 외부 기기에서 접속 가능
    app.run(debug=False, host="0.0.0.0", port=port)
