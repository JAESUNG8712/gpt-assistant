"""
해외안전여행(외교부) 국가·지역별 여행경보 다운로더 — 공공데이터포털 Open API
fetch_laws.py와 동일한 구조/관례를 따른다.

실행 방법:
  python fetch_travel_alerts.py                      # 일반 실행
  TRAVEL_ALERT_API_KEY=xxx python fetch_travel_alerts.py  # 키 직접 지정

출력: travel_alert_cache.json (engine.py가 자동 로드)

API: data.go.kr "외교부_국가·지역별 여행경보"
  https://www.data.go.kr/data/15076237/openapi.do
  엔드포인트: https://apis.data.go.kr/1262000/TravelAlarmService2/getTravelAlarmList2
  (2026-08-11 실측: ServiceKey 파라미터 미등록 시 SERVICE_KEY_IS_NOT_REGISTERED_ERROR를
   정확히 반환하는 것으로 엔드포인트·파라미터명 자체는 확인됨. 다만 실제 키로 받는
   성공 응답의 정확한 필드 구조까지는 이 환경에서 검증하지 못했음 — data.go.kr의
   표준 응답 포맷(response.body.items.item)을 가정하고 방어적으로 파싱하되,
   실패 시 원본 응답을 그대로 출력해 최초 실행 시 바로 진단 가능하게 함)
"""
import os
import sys
import json
import urllib.request
import urllib.parse

try:
    import httpx
except ImportError:
    httpx = None

API_KEY = os.getenv("TRAVEL_ALERT_API_KEY", "")
ENDPOINT = "https://apis.data.go.kr/1262000/TravelAlarmService2/getTravelAlarmList2"
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "travel_alert_cache.json")

# 여행경보 단계 코드 → 한글 설명 (외교부 공식 4단계 체계)
ALARM_LEVEL_LABELS = {
    "1": "1단계(여행유의)",
    "2": "2단계(여행자제)",
    "3": "3단계(출국권고)",
    "4": "4단계(여행금지)",
}


def _http_get(url: str, params: dict) -> dict:
    """httpx 또는 urllib로 GET 요청 (의존성 없이 동작) — fetch_laws.py와 동일 패턴"""
    query = "&".join(f"{k}={urllib.parse.quote(str(v), safe='')}" for k, v in params.items())
    full_url = f"{url}?{query}"
    if httpx:
        r = httpx.get(full_url, timeout=20)
        r.raise_for_status()
        return r.json()
    else:
        with urllib.request.urlopen(full_url, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))


def _extract_items(data: dict) -> list[dict]:
    """data.go.kr 표준 응답 포맷에서 item 리스트 추출 — 포맷이 예상과 다르면
    빈 리스트를 반환하고 호출부에서 원본을 출력해 진단할 수 있게 한다."""
    body = data.get("response", {}).get("body", {})
    items = body.get("items", {})
    if isinstance(items, dict):
        item = items.get("item", [])
    else:
        item = items
    if isinstance(item, dict):
        item = [item]
    return item or []


def fetch_all_alerts() -> list[dict]:
    """레벨 1 이상(여행유의 이상) 여행경보가 발령된 국가 목록을 KB 포맷으로 반환.
    특정 국가로 필터링하지 않고 한 번에 조회 — 활성 경보 국가 수가 전체 국가 수보다
    훨씬 적어(보통 수십 개 수준) numOfRows를 넉넉히 잡으면 페이지네이션 없이 충분."""
    data = _http_get(ENDPOINT, {
        "ServiceKey": API_KEY,
        "returnType": "JSON",
        "numOfRows": 500,
        "pageNo": 1,
    })

    header = data.get("response", {}).get("header", {})
    result_code = str(header.get("resultCode", "")).strip()
    if result_code and result_code not in ("00", "0"):
        raise RuntimeError(
            f"API 오류 응답: {header.get('resultMsg', result_code)} "
            f"(원본: {json.dumps(data, ensure_ascii=False)[:500]})"
        )

    items = _extract_items(data)
    if not items:
        print(f"  ⚠️  응답에서 항목을 찾지 못함 — 원본 구조:")
        print(f"     {json.dumps(data, ensure_ascii=False)[:1000]}")
        return []

    results = []
    for it in items:
        country = (it.get("country_nm") or "").strip()
        level = str(it.get("alarm_lvl") or "").strip()
        written = (it.get("written_dt") or "").strip()
        continent = (it.get("continent_nm") or "").strip()
        if not country or not level:
            continue

        level_label = ALARM_LEVEL_LABELS.get(level, f"{level}단계")
        q = f"{country} 여행경보 위험도 안전"
        a = (
            f"## {country} 여행경보\n\n"
            f"**현재 발령 단계**: {level_label}\n"
            + (f"**대륙**: {continent}\n" if continent else "")
            + (f"**발령/갱신일**: {written}\n" if written else "")
            + "\n외교부 해외안전여행(0404.go.kr)에서 최신 정보와 상세 사유를 확인하세요. "
            "여행경보 단계는 상황에 따라 수시로 변동될 수 있습니다."
        )
        results.append({
            "q": q,
            "a": a,
            "persona": "travel",
            "source": "mofa_travel_alert",
            "country": country,
            "alarm_level": level,
        })

    return results


def main():
    if not API_KEY:
        print("⚠️  TRAVEL_ALERT_API_KEY 없음 — 여행경보 다운로드 건너뜀")
        # 기존 캐시 유지 (삭제하지 않음)
        sys.exit(0)

    print("📥 외교부 해외안전여행 여행경보 데이터 다운로드 시작")
    try:
        results = fetch_all_alerts()
    except Exception as e:
        print(f"❌ 오류: {type(e).__name__}: {e}")
        print("   → 기존 캐시 유지 (연결 실패로 간주, 워크플로우는 경고로 종료)")
        sys.exit(0)  # law.go.kr 스크립트와 동일하게 실패를 경고로 처리 — 워크플로우 green 유지

    if results:
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"\n✅ 완료: {len(results)}개국 여행경보 저장 → {OUTPUT_FILE}")
    else:
        print("\n⚠️  결과 없음 — 기존 캐시 유지")
        sys.exit(0)


if __name__ == "__main__":
    main()
