"""
법령 데이터 다운로더 — law.go.kr Open API

실행 방법:
  python fetch_laws.py              # 일반 실행
  LAW_API_KEY=xxx python fetch_laws.py  # 키 직접 지정

출력: law_data_cache.json (engine.py가 자동 로드)
"""
import os
import sys
import json
import time
import urllib.request
import urllib.parse

try:
    import httpx
except ImportError:
    httpx = None

LAW_API_KEY = os.getenv("LAW_API_KEY", "")
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "law_data_cache.json")

# 수집할 법령 목록
LAWS_TO_FETCH = [
    ("근로기준법",         "근로기준법"),
    ("근로자퇴직급여보장법", "근로자퇴직급여 보장법"),
    ("최저임금법",         "최저임금법"),
    ("기간제법",           "기간제 및 단시간근로자 보호 등에 관한 법률"),
    ("남녀고용평등법",     "남녀고용평등과 일·가정 양립 지원에 관한 법률"),
    ("산업안전보건법",     "산업안전보건법"),
    ("고용보험법",         "고용보험법"),
    ("산업재해보상보험법", "산업재해보상보험법"),
]


def _http_get(url: str, params: dict) -> dict:
    """httpx 또는 urllib로 GET 요청 (의존성 없이 동작)"""
    query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    full_url = f"{url}?{query}"
    if httpx:
        r = httpx.get(full_url, timeout=20)
        r.raise_for_status()
        return r.json()
    else:
        with urllib.request.urlopen(full_url, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))


def _flatten(val):
    if val is None:
        return []
    if isinstance(val, dict):
        return [val]
    return val


def _get_mst(law: dict) -> str:
    # law.go.kr lawSearch.do 실제 응답 필드명은 "법령일련번호"다(2026-08-24
    # GitHub Actions 실행 로그에서 실측 확인 — "법령MST"/"법령MST번호"/"MST"라는
    # 필드는 애초에 존재하지 않아, 이 함수가 이제까지 단 한 번도 MST를 못 찾고
    # 매 실행마다 0개 조문으로 조용히 끝나던 근본 원인이었음. 법령상세링크의
    # 쿼리파라미터 MST=<값>이 법령일련번호와 동일함을 대조해 확인함).
    for key in ("법령일련번호", "법령MST", "법령MST번호", "MST"):
        v = str(law.get(key, "")).strip()
        if v:
            return v
    return ""


def fetch_one_law(law_key: str, search_name: str) -> list[dict]:
    """법령 전체 조문 다운로드 → KB 포맷으로 반환"""
    # 1단계: 법령 검색으로 MST 획득
    data = _http_get(
        "https://www.law.go.kr/DRF/lawSearch.do",
        {"OC": LAW_API_KEY, "target": "law", "type": "JSON",
         "query": search_name, "display": 5},
    )
    all_laws = _flatten(data.get("LawSearch", {}).get("law"))
    if not all_laws:
        print(f"  ⚠️  {law_key}: 검색 결과 없음")
        return []

    # 시행령·시행규칙 제외 → 법률 우선
    laws = [l for l in all_laws
            if "시행령" not in l.get("법령명한글", "")
            and "시행규칙" not in l.get("법령명한글", "")]
    if not laws:
        laws = all_laws

    mst = _get_mst(laws[0])
    official_name = laws[0].get("법령명한글", law_key)
    if not mst:
        print(f"  ⚠️  {law_key}: MST 값 없음 ({laws[0]})")
        return []

    time.sleep(0.3)  # API 과부하 방지

    # 2단계: 법령 본문 전체 조회
    law_data = _http_get(
        "https://www.law.go.kr/DRF/lawService.do",
        {"OC": LAW_API_KEY, "target": "law", "MST": mst, "type": "JSON"},
    )
    articles = _flatten(
        law_data.get("법령", {}).get("조문", {}).get("조문단위")
    )
    if not articles:
        print(f"  ⚠️  {law_key}: 조문 없음")
        return []

    results = []
    for article in articles:
        num   = str(article.get("조문번호", "")).strip()
        title = article.get("조문제목", "")
        content = article.get("조문내용", "")

        clauses = _flatten(article.get("항"))
        clause_lines = [
            f"{c.get('항번호', '')}. {c.get('항내용', '')}"
            for c in clauses if c.get("항내용")
        ]

        full_text = content
        if clause_lines:
            full_text += "\n" + "\n".join(clause_lines)
        full_text = full_text.strip()
        if not full_text or not num:
            continue

        q = f"{official_name} 제{num}조{(' ' + title) if title else ''}"
        a = (f"## {official_name} 제{num}조"
             f"{(' (' + title + ')') if title else ''}\n\n"
             f"**조문**:\n{full_text}")

        results.append({
            "q": q,
            "a": a,
            "persona": "hr",
            "source": "law.go.kr",
            "law": official_name,
            "article_num": num,
        })

    return results


def main():
    if not LAW_API_KEY:
        print("⚠️  LAW_API_KEY 없음 — 법령 다운로드 건너뜀")
        # 기존 캐시 유지 (삭제하지 않음)
        sys.exit(0)

    print(f"📥 law.go.kr 법령 데이터 다운로드 시작 ({len(LAWS_TO_FETCH)}개 법령)")
    all_results = []
    success, fail = 0, 0

    for law_key, search_name in LAWS_TO_FETCH:
        print(f"  → {law_key} ...")
        try:
            items = fetch_one_law(law_key, search_name)
            all_results.extend(items)
            print(f"     ✅ {len(items)}개 조문")
            success += 1
        except Exception as e:
            print(f"     ❌ 오류: {type(e).__name__}: {e}")
            fail += 1
        time.sleep(0.5)

    if all_results:
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(all_results, f, ensure_ascii=False, indent=2)
        print(f"\n✅ 완료: {len(all_results)}개 조문 저장 → {OUTPUT_FILE}")
        print(f"   성공: {success}개 법령 / 실패: {fail}개 법령")
    else:
        # 연결 실패 시 기존 캐시 유지 (워크플로우는 성공으로 종료)
        print("\n⚠️  law.go.kr 연결 실패 또는 결과 없음")
        print("   → 기존 캐시 유지 (로컬 KB로 동작)")
        print(f"   힌트: GitHub Actions / Railway 서버에서 law.go.kr 접속이")
        print(f"         차단된 경우 방법 1(로컬 KB)이 대신 사용됩니다.")
        sys.exit(0)  # 실패가 아닌 경고로 처리 — 워크플로우 green 유지


if __name__ == "__main__":
    main()
