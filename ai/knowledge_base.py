"""
각 페르소나별 사전 학습 지식 베이스.
서버 시작 시 ChromaDB에 자동으로 로드됩니다.
"""

KNOWLEDGE = {
    "hr": [
        {
            "title": "채용 프로세스 전체 흐름",
            "content": """채용 프로세스는 크게 7단계로 나뉩니다.
1. 채용 계획: 인력 수요 파악, 직무기술서(JD) 작성, 채용 공고 사이트 결정
2. 채용 공고: 사람인, 잡코리아, 링크드인, 원티드 등 플랫폼 활용
3. 서류 전형: 이력서·자기소개서 검토, 지원자격 적합도 평가
4. 1차 면접(실무): 직무역량, 기술 적합도 확인
5. 2차 면접(임원): 조직문화 적합도, 리더십, 성장가능성 평가
6. 처우 협의: 연봉, 직급, 시작일 협의
7. 입사 온보딩: 오리엔테이션, 부서 배치, 멘토 배정"""
        },
        {
            "title": "4대보험 계산법과 요율",
            "content": """4대보험 2024년 기준 요율 (근로자 부담분):
- 국민연금: 보수월액의 4.5% (사업주도 4.5% 부담)
- 건강보험: 보수월액의 3.545% (장기요양보험 0.9182% 별도)
- 고용보험: 보수월액의 0.9% (사업주 추가 부담)
- 산재보험: 전액 사업주 부담 (업종별 상이)

급여 250만원 기준 근로자 공제액:
- 국민연금: 112,500원
- 건강보험: 88,620원 + 장기요양 8,130원
- 고용보험: 22,500원
- 합계 약 231,750원 공제"""
        },
        {
            "title": "근로기준법 핵심 내용",
            "content": """근로기준법 주요 조항:
- 법정 근로시간: 주 40시간, 1일 8시간
- 연장근로: 주 12시간 한도, 가산수당 50%
- 야간근로(22시~06시): 가산수당 50%
- 휴일근로: 가산수당 50%(8시간 이내), 100%(초과)
- 최저임금 2024년: 시간당 9,860원
- 주휴수당: 주 15시간 이상 근무 시 유급 주휴일 1일 보장
- 퇴직금: 1년 이상 근무 시 30일분 평균임금 × 근속연수"""
        },
        {
            "title": "연차 유급휴가 계산법",
            "content": """연차휴가 발생 기준 (근로기준법 제60조):
- 1년 미만 근무: 매월 개근 시 1일씩 최대 11일 발생
- 1년 이상 근무: 15일 기본 + 2년마다 1일 추가 (최대 25일)
- 계산 예시:
  * 1년차: 15일
  * 3년차: 16일 (15 + 1)
  * 5년차: 17일 (15 + 2)
  * 21년차 이상: 25일 (상한)
- 연차수당: 미사용 연차 × 1일 통상임금
- 연차사용촉진제도 활용 시 미사용 연차수당 면제 가능"""
        },
        {
            "title": "KPI와 OKR 성과관리",
            "content": """KPI(핵심성과지표) vs OKR(목표-핵심결과):

KPI:
- 정량적 목표치를 설정하고 달성 여부로 평가
- 예: 매출 목표 10억, 고객 만족도 90점 이상
- 연 1~2회 평가, 보상과 직결

OKR:
- Objective(목표) + Key Results(핵심결과) 3~5개
- 예: O=고객 경험 혁신, KR1=NPS 50점 달성, KR2=이탈률 20% 감소
- 분기별 설정·검토, 도전적 목표(달성률 70%가 이상적)
- 보상과 직결하지 않음 → 도전적 목표 설정 유도

성과면담 핵심: STAR 기법 활용
- Situation(상황) → Task(과제) → Action(행동) → Result(결과)"""
        },
        {
            "title": "직장 내 괴롭힘 방지법",
            "content": """직장 내 괴롭힘 방지법 (2019년 7월 시행):
- 정의: 지위/관계 우위를 이용해 업무상 적정 범위를 넘는 신체적·정신적 고통 행위
- 해당 행위: 폭언, 모욕, 따돌림, 과도한 업무 부여, 사적 심부름 강요
- 신고 절차: 사용자에게 신고 → 즉시 조사 → 피해자 분리·보호 → 징계 조치
- 사용자 의무: 신고접수 시 즉시 조사, 피해자 불이익 처우 금지
- 위반 시: 3년 이하 징역 또는 3천만원 이하 벌금
- 신고 기관: 고용노동부 고객상담센터 1350"""
        },
        {
            "title": "퇴직금 계산법",
            "content": """퇴직금 계산 공식:
퇴직금 = 1일 평균임금 × 30일 × (재직일수 / 365)

평균임금: 퇴직일 이전 3개월 임금 총액 ÷ 해당 기간 일수

예시 계산 (월급 300만원, 3년 근무):
- 3개월 임금: 900만원
- 3개월 일수: 91일
- 1일 평균임금: 약 98,901원
- 퇴직금: 98,901 × 30 × (1,095/365) = 약 8,910,990원 ≈ 891만원

퇴직연금 종류:
- DB형(확정급여): 회사가 운용, 퇴직 시 확정 금액 수령
- DC형(확정기여): 매년 연봉의 1/12 이상 개인 계좌 적립, 본인이 운용"""
        },
    ],

    "dev": [
        {
            "title": "Python 핵심 문법과 자주 쓰는 패턴",
            "content": """Python 자주 쓰는 핵심 패턴:

리스트 컴프리헨션:
squares = [x**2 for x in range(10) if x % 2 == 0]

딕셔너리 컴프리헨션:
word_len = {word: len(word) for word in ['apple', 'banana']}

f-string (권장):
name = "홍길동"
print(f"안녕하세요, {name}님! 나이: {2024 - 1990}세")

데코레이터:
def timer(func):
    import time
    def wrapper(*args, **kwargs):
        start = time.time()
        result = func(*args, **kwargs)
        print(f"실행 시간: {time.time()-start:.3f}초")
        return result
    return wrapper

컨텍스트 매니저:
with open('file.txt', 'r', encoding='utf-8') as f:
    content = f.read()

enumerate와 zip:
for i, val in enumerate(['a', 'b', 'c']):
    print(i, val)
for a, b in zip([1,2,3], ['x','y','z']):
    print(a, b)"""
        },
        {
            "title": "JavaScript/TypeScript 핵심 문법",
            "content": """JavaScript/TypeScript 핵심:

비동기 처리 (async/await):
async function fetchData(url) {
  try {
    const res = await fetch(url);
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('오류:', err);
  }
}

구조 분해 할당:
const { name, age = 25 } = user;
const [first, ...rest] = array;

스프레드 연산자:
const merged = { ...obj1, ...obj2 };
const combined = [...arr1, ...arr2];

TypeScript 타입 정의:
interface User {
  id: number;
  name: string;
  email?: string;  // 선택적 속성
}
type Result<T> = { data: T; error: null } | { data: null; error: string };

화살표 함수와 고차함수:
const doubled = [1,2,3].map(x => x * 2);
const evens = [1,2,3,4].filter(x => x % 2 === 0);
const sum = [1,2,3,4].reduce((acc, x) => acc + x, 0);"""
        },
        {
            "title": "React 핵심 훅과 패턴",
            "content": """React 자주 쓰는 훅:

useState:
const [count, setCount] = useState(0);
const [user, setUser] = useState({ name: '', age: 0 });

useEffect:
useEffect(() => {
  // 마운트 시 실행
  fetchUser(id).then(setUser);
  return () => { /* 언마운트 시 클린업 */ };
}, [id]); // id 바뀔 때마다 재실행

useCallback (함수 메모이제이션):
const handleClick = useCallback(() => {
  setCount(c => c + 1);
}, []); // 의존성 없으면 한 번만 생성

useMemo (값 메모이제이션):
const expensiveResult = useMemo(() => heavyCalc(data), [data]);

커스텀 훅:
function useFetch(url) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch(url).then(r => r.json()).then(d => {
      setData(d); setLoading(false);
    });
  }, [url]);
  return { data, loading };
}"""
        },
        {
            "title": "FastAPI 백엔드 개발 패턴",
            "content": """FastAPI 핵심 패턴:

기본 CRUD 엔드포인트:
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()

class Item(BaseModel):
    name: str
    price: float
    is_active: bool = True

items_db = {}

@app.get("/items/{item_id}")
async def get_item(item_id: int):
    if item_id not in items_db:
        raise HTTPException(status_code=404, detail="아이템 없음")
    return items_db[item_id]

@app.post("/items/", status_code=201)
async def create_item(item: Item):
    item_id = len(items_db) + 1
    items_db[item_id] = item
    return {"id": item_id, **item.dict()}

의존성 주입:
from fastapi import Depends

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@app.get("/users/")
def get_users(db=Depends(get_db)):
    return db.query(User).all()"""
        },
        {
            "title": "SQL 핵심 쿼리와 최적화",
            "content": """SQL 자주 쓰는 쿼리 패턴:

집계 함수:
SELECT department, COUNT(*) as cnt, AVG(salary) as avg_sal
FROM employees
WHERE is_active = 1
GROUP BY department
HAVING COUNT(*) > 5
ORDER BY avg_sal DESC;

JOIN 종류:
-- INNER JOIN: 두 테이블 모두 일치하는 행
SELECT u.name, o.total
FROM users u
INNER JOIN orders o ON u.id = o.user_id;

-- LEFT JOIN: 왼쪽 테이블 모든 행 + 일치하는 오른쪽
SELECT u.name, COUNT(o.id) as order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
GROUP BY u.id;

윈도우 함수:
SELECT name, salary,
  RANK() OVER (PARTITION BY dept ORDER BY salary DESC) as rank,
  AVG(salary) OVER (PARTITION BY dept) as dept_avg
FROM employees;

인덱스 최적화:
-- 자주 검색하는 컬럼에 인덱스
CREATE INDEX idx_email ON users(email);
-- WHERE, JOIN, ORDER BY에 사용하는 컬럼 우선"""
        },
        {
            "title": "Git 워크플로우와 협업",
            "content": """Git 핵심 명령어와 워크플로우:

기본 워크플로우:
git clone <url>           # 저장소 복제
git checkout -b feature/x # 기능 브랜치 생성
git add .                 # 변경사항 스테이징
git commit -m "feat: 로그인 기능 추가"  # 커밋
git push origin feature/x # 원격에 푸시
# GitHub에서 PR 생성 → 리뷰 → merge

커밋 메시지 컨벤션 (Conventional Commits):
feat: 새 기능
fix: 버그 수정
docs: 문서 수정
style: 코드 포맷 (로직 변경 없음)
refactor: 리팩토링
test: 테스트 추가
chore: 빌드/설정 변경

유용한 명령어:
git stash          # 변경사항 임시 저장
git stash pop      # 임시 저장 복원
git log --oneline  # 커밋 히스토리 한 줄로
git rebase -i HEAD~3  # 최근 3개 커밋 정리
git cherry-pick <sha>  # 특정 커밋만 가져오기"""
        },
        {
            "title": "알고리즘 핵심 패턴 (Python)",
            "content": """자주 나오는 알고리즘 패턴:

투 포인터:
def two_sum(nums, target):
    left, right = 0, len(nums) - 1
    while left < right:
        s = nums[left] + nums[right]
        if s == target: return [left, right]
        elif s < target: left += 1
        else: right -= 1

슬라이딩 윈도우:
def max_sum_subarray(nums, k):
    window_sum = sum(nums[:k])
    max_sum = window_sum
    for i in range(k, len(nums)):
        window_sum += nums[i] - nums[i-k]
        max_sum = max(max_sum, window_sum)
    return max_sum

BFS (최단 경로):
from collections import deque
def bfs(graph, start):
    visited = {start}
    queue = deque([start])
    while queue:
        node = queue.popleft()
        for neighbor in graph[node]:
            if neighbor not in visited:
                visited.add(neighbor)
                queue.append(neighbor)

동적 프로그래밍 (피보나치):
def fib(n, memo={}):
    if n in memo: return memo[n]
    if n <= 1: return n
    memo[n] = fib(n-1) + fib(n-2)
    return memo[n]"""
        },
    ],

    "travel": [
        {
            "title": "한국 국내 여행지 추천",
            "content": """한국 주요 여행지 가이드:

제주도:
- 한라산 등반 (성판악/관음사 코스, 6~8시간)
- 성산일출봉 (유네스코 세계자연유산)
- 협재·함덕 해수욕장
- 카카오프렌즈 빌리지, 테디베어 뮤지엄
- 맛집: 흑돼지 바비큐, 갈치조림, 고등어회
- 렌터카 필수, 성수기(7~8월) 2~3개월 전 예약

부산:
- 해운대·광안리 해수욕장
- 감천문화마을 (마추픽추 느낌의 벽화 마을)
- 자갈치시장 (해산물)
- 국제시장, 남포동 BIFF 광장
- 송정·기장 서핑
- KTX 서울-부산 2시간 30분

경주:
- 불국사·석굴암 (유네스코)
- 경주 야경: 동궁과 월지(안압지)
- 첨성대, 대릉원 고분군
- 황리단길 (MZ 감성 카페·맛집)
- 당일치기 or 1박 2일 추천"""
        },
        {
            "title": "동남아 여행 완벽 가이드",
            "content": """동남아 인기 여행지:

태국 방콕:
- 왕궁·왓포·왓아룬 (3대 사원)
- 카오산로드 (배낭여행자 거리)
- 짜뚜짝 시장 (주말 벼룩시장)
- 아시아티크 (야시장)
- 툭툭, 수상버스 이용 추천
- 비자: 30일 무비자
- 최적 시기: 11~2월 (건기)

베트남 다낭/호이안:
- 미케 해수욕장 (세계 6대 해변)
- 바나힐 (케이블카, 골든브릿지)
- 호이안 구시가지 야경 (유네스코)
- 쌀국수(포), 반미, 화이트로즈 만두
- 비자: 45일 무비자 (2023년부터)
- 항공: 인천-다낭 직항 5시간

발리:
- 우붓 (계단식 논, 원숭이 숲)
- 꾸따·스미냑·짐바란 해변
- 탕쿠반 프라후 화산
- 서핑 (레슨 추천): 반냑 비치
- 비자: 30일 무비자, 도착비자 $35
- 이동: 국내선 덴파사르(DPS) 공항"""
        },
        {
            "title": "일본 여행 완벽 가이드",
            "content": """일본 주요 여행지:

도쿄:
- 신주쿠·시부야·아키하바라·하라주쿠
- 아사쿠사 (센소지 절)
- 팀랩 (미디어아트 전시)
- 도쿄 디즈니랜드/씨
- IC카드(Suica/Pasmo) 필수
- 라멘, 스시, 야키토리, 돈카츠

오사카:
- 도톤보리 (글리코 간판, 타코야키)
- 오사카성
- 우메다 스카이빌딩
- 유니버설 스튜디오 재팬 (USJ)
- 닛폰바시 (전자상가)

교토:
- 아라시야마 대나무숲
- 기온 (게이샤 거리)
- 후시미 이나리 신사 (수천 개 도리이)
- 킨카쿠지 (금각사)
- 렌터 자전거로 이동 편리

교통:
- JR패스 (신칸센 무제한): 7일권 약 5만엔
- 비자: 한국 여권 90일 무비자"""
        },
        {
            "title": "항공권 저렴하게 구하는 방법",
            "content": """항공권 최저가 구하기 노하우:

예약 시기:
- 국내선: 출발 1~3개월 전
- 단거리 국제선 (일본·동남아): 2~4개월 전
- 장거리 (유럽·미주): 3~6개월 전
- 화요일·수요일 검색 시 저렴한 경우 많음

저가항공 활용:
- 국내: 제주항공, 진에어, 티웨이, 에어서울
- 동남아: 에어아시아, 비엣젯, 스쿠트
- 일본: 피치항공, 제트스타, 에어아시아재팬

꿀팁:
- 구글 플라이트에서 날짜 유연하게 검색
- 스카이스캐너 '전체 날짜' 검색으로 최저가 달 확인
- 프로모 알림 설정 (카카오 채널, 항공사 앱)
- 경유편: 직항보다 20~40% 저렴, 시간 여유 필요
- 마일리지 카드 활용 (KB국민 항공마일리지카드 등)
- 기내 수하물 추가 비용 계산해서 비교 (저가항공 함정)"""
        },
        {
            "title": "여행 준비 완벽 체크리스트",
            "content": """여행 준비 단계별 체크리스트:

출발 2~3개월 전:
□ 여권 유효기간 확인 (잔여 6개월 이상)
□ 항공권 예약
□ 숙소 예약 (성수기는 더 일찍)
□ 비자 필요 여부 확인

출발 1개월 전:
□ 여행자 보험 가입 (해외 의료비 중요)
□ 환전 또는 트래블 카드 준비
□ 해외 데이터 로밍/유심 준비
□ 국제운전면허증 (렌터카 계획 시)

출발 1주일 전:
□ 짐 싸기 (위탁 수하물 무게 확인)
□ 숙소·항공권 예약 확인서 출력/저장
□ 여행지 주요 정보 오프라인 저장
□ 비상 연락처 메모

여행 중 필수:
- 여권·신용카드 사본 따로 보관
- 현금 + 카드 분리 보관
- 대사관 연락처 저장 (긴급 시)
- 여행지 지역 앱 설치 (그랩, 고젝 등)"""
        },
        {
            "title": "환전과 여행 경비 절약 팁",
            "content": """환전 & 여행 경비 절약:

환전 방법 비교:
1. 은행 환전: 우대율 최대 90% (인터넷뱅킹 신청)
2. 공항 환전소: 수수료 높음 (비추)
3. 트래블 카드 (하나 트래블로그, 신한 SOL트래블): 수수료 없음, 현지 ATM 출금 가능
4. 현지 ATM: 글로벌 카드 수수료 확인 필요
5. 달러로 미리 환전 후 현지 환전 (동남아 유리)

경비 절약 팁:
- 숙소: 에어비앤비 vs 호스텔 vs 부티크호텔 비교
- 식비: 현지인 식당, 시장, 편의점 활용
- 교통: 대중교통 우선, 우버/그랩 활용
- 관광: 무료 미술관·공원 먼저, 시티패스 비교
- 쇼핑: 면세한도 $800 (1인), 부가세 환급(VAT Refund) 챙기기

여행자 보험 핵심:
- 해외 의료비 1억 이상 보장 상품 선택
- 여행취소보험 포함 여부 확인
- 출발 전 가입 필수 (출발 후 불가)"""
        },
    ],
}


def get_all_knowledge():
    """모든 페르소나의 지식을 (텍스트, 메타데이터) 리스트로 반환"""
    items = []
    for persona_id, chunks in KNOWLEDGE.items():
        for chunk in chunks:
            text = f"[{chunk['title']}]\n{chunk['content']}"
            meta = {"source": f"지식베이스:{chunk['title']}", "persona": persona_id}
            items.append((text, meta))
    return items
