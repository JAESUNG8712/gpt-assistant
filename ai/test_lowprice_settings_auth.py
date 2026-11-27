"""저평가 스크리닝 기준 저장 API 인증 회귀 테스트 (외부 API 호출 없음).

이전에는 POST /stock/lowprice/settings 가 인증 없이 열려 있어 누구나 저장된
스크리닝 기준을 바꿀 수 있었다. 저장은 관리자(X-Admin-Token)만 허용하고,
읽기(GET)는 기준값만 돌려주므로 공개로 둔다.
"""
import os
import sys
import tempfile
import types


def main():
    app_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(app_dir)

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        os.environ.pop("TURSO_DATABASE_URL", None)
        os.environ.pop("TURSO_AUTH_TOKEN", None)
        os.environ["DB_PATH"] = os.path.join(tmp, "lowprice.db")
        os.environ["MPLCONFIGDIR"] = os.path.join(tmp, "matplotlib")
        os.environ["BACKUP_TOKEN"] = "test-owner-token"
        os.environ.pop("ANTHROPIC_API_KEY", None)
        os.environ.pop("GROQ_API_KEY", None)

        from fastapi import APIRouter
        from fastapi.testclient import TestClient

        stock_api_stub = types.ModuleType("stock_analysis.stock_api")
        stock_api_stub.router = APIRouter()
        sys.modules["stock_analysis.stock_api"] = stock_api_stub
        import main

        client = TestClient(main.app)
        body = {"max_price": 30000}

        # 1) 토큰 없이 저장하면 거부되고 저장값은 바뀌지 않아야 한다.
        r = client.post("/stock/lowprice/settings", json=body)
        assert r.status_code == 401, f"무인증 저장이 막혀야 함: {r.status_code}"
        assert client.get("/stock/lowprice/settings").json()["max_price"] != 30000

        # 2) 잘못된 토큰도 거부.
        r = client.post("/stock/lowprice/settings", json=body,
                        headers={"X-Admin-Token": "wrong"})
        assert r.status_code == 401, f"잘못된 토큰이 막혀야 함: {r.status_code}"

        # 3) 올바른 관리자 토큰이면 저장된다.
        r = client.post("/stock/lowprice/settings", json=body,
                        headers={"X-Admin-Token": "test-owner-token"})
        assert r.status_code == 200, r.text
        assert client.get("/stock/lowprice/settings").json()["max_price"] == 30000

        # 4) 읽기는 공개 유지.
        assert client.get("/stock/lowprice/settings").status_code == 200

    print("lowprice settings auth tests: PASS")


if __name__ == "__main__":
    main()
