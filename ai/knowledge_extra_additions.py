"""
추가 지식베이스 — Dev(TypeScript, 클라우드, 테스트) + HR(2026 최저임금) + 여행 추가
"""

EXTRA_KNOWLEDGE = [

    # ── HR — 2026 최저임금 및 최신 정보 ──────────────────

    {
        "persona": "hr",
        "q": "2026년 최저임금 최저시급 얼마 내년 최저임금",
        "a": """## 연도별 최저임금 현황

| 연도 | 최저시급 | 월 환산 (209시간) | 전년 대비 인상률 |
|------|---------|----------------|--------------|
| 2024년 | 9,860원 | 2,060,740원 | +2.5% |
| 2025년 | 10,030원 | 2,096,270원 | +1.7% |
| **2026년** | **10,320원** | **2,156,880원** | **+2.9%** |

### 2026년 최저임금 적용 기준
- **시행일**: 2026년 1월 1일부터
- **적용 대상**: 모든 사업장, 국적·고용 형태 무관 (파견·아르바이트 포함)
- **위반 시 제재**: 3년 이하 징역 또는 2,000만원 이하 벌금

### 최저임금 계산 방법
- **월급 → 시급 환산**: 월급 ÷ 209시간 (주 40시간 근무 기준)
- 예: 200만원 ÷ 209 ≒ 9,569원 → **2026년 최저임금 10,320원 위반**

### 2026년 최저임금 월급 환산
- 주 40시간 (월 209시간): **2,156,880원**
- 주 44시간 (월 226시간): 2,332,320원
- 주 15시간 단시간 (월 65시간): 670,800원

### 신고
- 최저임금 미지급 신고: 고용노동부 고객상담센터 **☎ 1350**
- 온라인 신고: 고용노동부 홈페이지 → 민원마당""",
    },

    {
        "persona": "hr",
        "q": "임금체불 신고 방법 고용노동부 체불 임금 해결",
        "a": """## 임금체불 대응 완전 가이드

### 임금체불이란?
근로자에게 지급해야 할 임금(급여·퇴직금·연차수당 등)을 기한 내 지급하지 않는 것
→ **근로기준법 제36조, 제43조 위반 (형사처벌 대상)**

### 단계별 대응 방법

**1단계: 증거 수집**
- 근로계약서 사본
- 급여명세서·통장 입금 내역
- 카카오톡·문자 등 임금 약정 메시지
- 출퇴근 기록 (주휴수당·연장수당 포함 시)

**2단계: 내용증명 발송**
- 우체국 내용증명으로 임금 지급 촉구 공문 발송
- 심리적 압박 + 법적 분쟁 기록 남김

**3단계: 고용노동부 진정**
- 고용노동부 고객상담센터: **☎ 1350**
- 온라인 신고: 고용노동부 홈페이지 → 민원마당 → 임금체불 진정
- 가까운 **고용노동청(지청)** 방문
- 필요 서류: 진정서, 근로계약서, 급여 관련 서류

**4단계: 노동청 조사·사업주 처벌**
- 근로감독관이 사업주 조사
- 시정 명령 → 불이행 시 검찰 송치
- **3년 이하 징역 또는 3,000만원 이하 벌금**

**5단계: 소액체당금·대지급금 제도 활용**
- 사업주가 지급 불능(폐업·파산) 시 **근로복지공단**이 대신 지급
- 체당금 상한: 최대 2,100만원

### 시효
- 임금채권 소멸시효: **3년** (퇴직금: 3년)
- 퇴직 후 3년 내 신고 가능""",
    },

    {
        "persona": "hr",
        "q": "근로계약서 미작성 처벌 근로계약서 안 쓰면 어떻게",
        "a": """## 근로계약서 미작성 — 처벌과 대응

### 근로계약서 작성 의무 (근로기준법 제17조)
사용자는 근로계약 체결 시 다음 사항을 서면으로 명시하고 교부해야 함:
- 임금 (구성·계산방법·지급 방법)
- 소정근로시간
- 휴일·유급휴가
- 취업 장소·업무 내용

### 위반 시 처벌
| 위반 내용 | 처벌 |
|-----------|------|
| 서면 명시·교부 위반 | **500만원 이하 과태료** |
| 단시간·기간제 근로계약서 미교부 | 동일 |

### 근로계약서 없어도 근로관계 성립
- 구두 계약만으로도 근로계약은 유효
- 실제 근무 사실만 입증되면 임금·퇴직금 청구 가능

### 근로계약서 없을 때 근로자 대응
1. 임금 약정 입증 자료 확보 (문자·카카오톡·급여이체 내역)
2. 출근 기록 (사원증·CCTV·메신저 기록)
3. 고용노동부에 서면 미교부 신고 → 과태료 부과

### 서면 교부 시 주의사항
- 기간제·단시간 근로자: **반드시 서면 교부** (위반 시 과태료)
- 18세 미만 연소근로자: 친권자·후견인에게도 교부 의무
- 파견 근로자: 파견사업주와 파견 계약 서면화 별도 필요""",
    },

    {
        "persona": "hr",
        "q": "포괄임금제 적법 요건 연장수당 야간수당 포함",
        "a": """## 포괄임금제 적법 요건과 문제점

### 포괄임금제란?
기본급에 연장·야간·휴일수당 등을 포함시켜 고정 월급으로 지급하는 방식

### 적법한 포괄임금제 요건 (대법원 판례)
1. **근로시간 산정이 어려운 업종** (감시·단속적 근로, 재량 근무 등)
2. **노사 합의** (근로자 동의 + 취업규칙·근로계약서 명시)
3. **포괄임금이 실제 법정수당보다 적지 않을 것**

### 위법한 포괄임금제
- 사무직·생산직 등 근로시간 산정이 가능한 직종에 적용
- 실제 연장근로 시간보다 포괄 수당이 부족한 경우
- 근로자 동의 없이 일방적으로 적용

### 핵심 판례 (2024년 최근 동향)
- 대법원: "실제 가산임금이 포괄액 초과 시 차액 지급 의무"
- 사무직·IT 개발자에게 포괄임금제 남용 → 법원에서 다수 인정 거부

### 포괄임금 위반 시 대응
1. 연장근로 시간 기록 보존 (PC 로그·카드 태그·카카오워크 등)
2. 포괄액과 실제 법정수당 차액 계산
3. 고용노동부 진정 or 노동위원회 구제 신청

### 계산 방법
법정 연장수당 = 통상시급 × 1.5 × 연장시간
포괄임금 내 연장수당 = 월 포함 금액 ÷ 약정 연장시간
→ 차액이 있으면 청구 가능""",
    },

    {
        "persona": "hr",
        "q": "직장 내 성희롱 예방 신고 처리 절차",
        "a": """## 직장 내 성희롱 예방·신고·처리

### 성희롱 정의 (남녀고용평등법 제2조)
직장 내 지위를 이용하거나 업무 관련하여 성적 언동으로 불쾌감·굴욕감을 주는 행위

### 성희롱 유형
| 유형 | 예시 |
|------|------|
| 언어적 | 성적 발언, 음담패설, 외모 품평 |
| 시각적 | 음란물 전송, 음란한 눈빛 |
| 신체적 | 불필요한 신체 접촉, 포옹 강요 |
| 기타 | SNS·메신저 성적 메시지 |

### 사업주 의무
- **연 1회 이상** 예방 교육 실시 (상시 10인 이상 사업장)
- 신고 접수 시 즉시 조사 및 피해자 보호 조치
- 가해자 징계 등 적절한 조치

### 신고 방법
1. **사내 고충처리 창구** 신고 (사업주에게)
2. **고용노동부** 신고 (1350)
3. **국가인권위원회** 진정 (☎ 1331)
4. **노동위원회** 구제 신청

### 피해자 보호
- 신고 이후 불이익 처우 금지 (해고·불이익 → 3년 이하 징역)
- 피해자 요청 시 부서 이동 등 보호 조치 의무

### 가해자 처벌
- 사업주가 성희롱 가해자인 경우: 1,000만원 이하 과태료
- 성희롱 후 불이익 처우: 3년 이하 징역 또는 3,000만원 이하 벌금""",
    },

    # ── Dev — TypeScript, Vue, 테스트, 클라우드 ──────────

    {
        "persona": "dev",
        "q": "TypeScript 기초 타입 인터페이스 제네릭 tsconfig",
        "a": """## TypeScript 핵심 정리

### 기본 타입
```typescript
let name: string = "홍길동";
let age: number = 30;
let active: boolean = true;
let items: string[] = ["a", "b"];
let tuple: [string, number] = ["hello", 42];
```

### 인터페이스 vs 타입 별칭
```typescript
// 인터페이스 — 객체 구조 정의, extends로 확장
interface User {
  id: number;
  name: string;
  email?: string;  // optional
}

// 타입 별칭 — 더 유연 (유니온·교차 타입 가능)
type Status = "active" | "inactive" | "pending";
type AdminUser = User & { role: "admin" };
```

### 제네릭
```typescript
function identity<T>(arg: T): T {
  return arg;
}

// 제네릭 인터페이스
interface ApiResponse<T> {
  data: T;
  status: number;
  message: string;
}

const res: ApiResponse<User> = { data: {...}, status: 200, message: "ok" };
```

### 유틸리티 타입
```typescript
Partial<T>    // 모든 속성 optional
Required<T>   // 모든 속성 required
Readonly<T>   // 읽기 전용
Pick<T, K>    // K 속성만 선택
Omit<T, K>   // K 속성 제외
Record<K, V>  // K를 키, V를 값으로 하는 객체
```

### tsconfig 핵심 설정
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,          // 모든 strict 옵션 활성화
    "esModuleInterop": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

### strict 모드 주요 옵션
- `strictNullChecks`: null/undefined 명시적 처리 필요
- `noImplicitAny`: any 타입 암묵적 추론 금지""",
    },

    {
        "persona": "dev",
        "q": "Vue.js 3 기초 Composition API setup ref reactive",
        "a": """## Vue 3 Composition API 핵심

### Options API → Composition API 비교
```javascript
// Options API (Vue 2 스타일)
export default {
  data() { return { count: 0 } },
  methods: { increment() { this.count++ } }
}

// Composition API (Vue 3 권장)
import { ref, reactive, computed, onMounted } from 'vue'

export default {
  setup() {
    const count = ref(0)           // 원시값 반응형
    const state = reactive({       // 객체 반응형
      name: '홍길동',
      items: []
    })
    const doubled = computed(() => count.value * 2)

    onMounted(() => {
      console.log('컴포넌트 마운트')
    })

    return { count, state, doubled }
  }
}
```

### `<script setup>` 문법 (Vue 3.2+, 가장 간결)
```vue
<script setup>
import { ref, computed, onMounted } from 'vue'

const count = ref(0)
const doubled = computed(() => count.value * 2)

function increment() {
  count.value++
}

onMounted(() => fetchData())
</script>

<template>
  <button @click="increment">{{ count }} (×2: {{ doubled }})</button>
</template>
```

### Props & Emits
```vue
<script setup>
const props = defineProps({ title: String, count: Number })
const emit = defineEmits(['update', 'close'])

function handleClick() {
  emit('update', props.count + 1)
}
</script>
```

### v-model 바인딩
```vue
<input v-model="name" />    <!-- 양방향 바인딩 -->
<input :value="name" @input="name = $event.target.value" />  <!-- 동일 -->
```

### 라우터 (Vue Router 4)
```javascript
import { useRouter, useRoute } from 'vue-router'

const router = useRouter()
const route = useRoute()

console.log(route.params.id)
router.push('/home')
```""",
    },

    {
        "persona": "dev",
        "q": "Next.js 기초 App Router 서버 컴포넌트 SSR SSG",
        "a": """## Next.js 13+ App Router 핵심

### App Router 구조
```
app/
  layout.tsx          ← 공통 레이아웃
  page.tsx            ← 루트 페이지 (/)
  about/
    page.tsx          ← /about
  blog/
    [slug]/
      page.tsx        ← /blog/:slug (동적 라우트)
  api/
    route.ts          ← API 엔드포인트
```

### 서버 컴포넌트 vs 클라이언트 컴포넌트
```typescript
// 서버 컴포넌트 (기본값) — async 사용 가능
async function BlogList() {
  const posts = await fetch('https://api.example.com/posts').then(r => r.json())
  return <ul>{posts.map(p => <li key={p.id}>{p.title}</li>)}</ul>
}

// 클라이언트 컴포넌트 — "use client" 선언 필수
'use client'
import { useState } from 'react'

function Counter() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(c => c+1)}>{count}</button>
}
```

### 데이터 패칭 방식
```typescript
// SSG (정적 생성) — 빌드 시 1회
const data = await fetch(url, { cache: 'force-cache' })

// SSR (서버사이드 렌더링) — 매 요청마다
const data = await fetch(url, { cache: 'no-store' })

// ISR (점진적 재검증) — n초마다 재생성
const data = await fetch(url, { next: { revalidate: 60 } })
```

### API Route
```typescript
// app/api/users/route.ts
import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({ users: [] })
}

export async function POST(request: Request) {
  const body = await request.json()
  return NextResponse.json({ created: true, ...body }, { status: 201 })
}
```

### 메타데이터
```typescript
export const metadata = {
  title: '내 앱',
  description: '앱 설명',
}
```""",
    },

    {
        "persona": "dev",
        "q": "Python pytest 테스트 작성 단위 테스트 mocking",
        "a": """## pytest 테스트 작성 완전 가이드

### 기본 테스트
```python
# tests/test_calculator.py
def test_add():
    assert 1 + 2 == 3

def test_divide_by_zero():
    with pytest.raises(ZeroDivisionError):
        1 / 0
```

### 픽스처 (Fixture) — 테스트 사전 준비
```python
import pytest

@pytest.fixture
def user():
    return {"id": 1, "name": "테스트유저", "email": "test@example.com"}

@pytest.fixture
def db_session():
    session = create_test_session()
    yield session        # 테스트 실행
    session.rollback()   # 정리

def test_get_user(user):
    assert user["name"] == "테스트유저"
```

### 매개변수화 테스트
```python
@pytest.mark.parametrize("input,expected", [
    (2, 4), (3, 9), (4, 16), (-2, 4)
])
def test_square(input, expected):
    assert input ** 2 == expected
```

### Mocking (unittest.mock)
```python
from unittest.mock import patch, MagicMock

def test_api_call():
    with patch('mymodule.requests.get') as mock_get:
        mock_get.return_value.json.return_value = {"status": "ok"}
        mock_get.return_value.status_code = 200

        result = my_api_function()
        assert result["status"] == "ok"
        mock_get.assert_called_once()
```

### FastAPI 테스트
```python
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_read_main():
    response = client.get("/")
    assert response.status_code == 200

def test_create_item():
    response = client.post("/items", json={"name": "test", "price": 10.0})
    assert response.status_code == 201
    assert response.json()["name"] == "test"
```

### pytest 실행 명령
```bash
pytest                      # 전체 테스트
pytest tests/test_api.py    # 파일 지정
pytest -v                   # 자세한 출력
pytest -k "test_add"        # 이름 필터
pytest --cov=src            # 커버리지 측정
```""",
    },

    {
        "persona": "dev",
        "q": "GitHub Actions CI/CD 워크플로우 자동화 배포",
        "a": """## GitHub Actions CI/CD 가이드

### 기본 워크플로우 구조
```yaml
# .github/workflows/ci.yml
name: CI Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: |
          pip install -r requirements.txt
          pip install pytest pytest-cov

      - name: Run tests
        run: pytest --cov=src --cov-report=xml

      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

### CD — Render.com 자동 배포
```yaml
  deploy:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'

    steps:
      - name: Deploy to Render
        run: |
          curl -X POST ${{ secrets.RENDER_DEPLOY_HOOK_URL }}
```

### Docker 빌드 & 푸시
```yaml
      - name: Build and push Docker image
        uses: docker/build-push-action@v4
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:latest
            ghcr.io/${{ github.repository }}:${{ github.sha }}
```

### 환경 변수·시크릿
```yaml
      - name: Run with secrets
        env:
          API_KEY: ${{ secrets.API_KEY }}
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
        run: python deploy.py
```

### 매트릭스 전략 (여러 환경 병렬 테스트)
```yaml
    strategy:
      matrix:
        python-version: ['3.10', '3.11', '3.12']
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
```""",
    },

    {
        "persona": "dev",
        "q": "Redis 캐시 사용법 Python 연동 TTL 세션 캐싱",
        "a": """## Redis 핵심 사용법

### Redis 소개
- 인메모리 키-값 데이터 구조 서버
- 캐싱, 세션 저장, 메시지 큐, 실시간 리더보드에 사용

### Python 연동 (redis-py)
```python
import redis

r = redis.Redis(host='localhost', port=6379, db=0, decode_responses=True)

# 기본 CRUD
r.set('user:1', 'John')
r.get('user:1')          # 'John'
r.delete('user:1')

# TTL (Time To Live) — 만료 시간 설정
r.setex('session:abc', 3600, 'user_data')  # 1시간 후 자동 삭제
r.expire('key', 1800)   # 기존 키에 TTL 추가
r.ttl('session:abc')    # 남은 시간(초)

# 해시 (딕셔너리)
r.hset('user:1', mapping={'name': '홍길동', 'age': '30'})
r.hget('user:1', 'name')
r.hgetall('user:1')

# 리스트 (큐)
r.lpush('queue', 'task1', 'task2')
r.rpop('queue')  # FIFO

# 집합
r.sadd('tags', 'python', 'redis')
r.smembers('tags')
```

### FastAPI 캐싱 패턴
```python
from functools import wraps
import json

def cache(ttl: int = 300):
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            key = f"{func.__name__}:{args}:{kwargs}"
            cached = r.get(key)
            if cached:
                return json.loads(cached)
            result = await func(*args, **kwargs)
            r.setex(key, ttl, json.dumps(result))
            return result
        return wrapper
    return decorator

@app.get("/users/{user_id}")
@cache(ttl=60)
async def get_user(user_id: int):
    return await db.fetch_user(user_id)
```

### 세션 저장
```python
import uuid

def create_session(user_id: int) -> str:
    session_id = str(uuid.uuid4())
    r.setex(f"session:{session_id}", 86400, str(user_id))  # 24시간
    return session_id

def get_session(session_id: str):
    return r.get(f"session:{session_id}")
```""",
    },

    {
        "persona": "dev",
        "q": "PostgreSQL 고급 쿼리 인덱스 성능 튜닝 EXPLAIN",
        "a": """## PostgreSQL 성능 최적화

### 인덱스 생성 및 활용
```sql
-- 기본 B-tree 인덱스 (등치·범위 검색)
CREATE INDEX idx_users_email ON users(email);

-- 복합 인덱스 (쿼리 패턴에 맞게)
CREATE INDEX idx_orders_user_date ON orders(user_id, created_at DESC);

-- 부분 인덱스 (조건부)
CREATE INDEX idx_active_users ON users(email) WHERE active = true;

-- GIN 인덱스 (배열·JSONB·전문 검색)
CREATE INDEX idx_tags ON posts USING GIN(tags);
CREATE INDEX idx_data ON items USING GIN(metadata jsonb_path_ops);
```

### EXPLAIN ANALYZE로 성능 분석
```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM orders
WHERE user_id = 42 AND status = 'pending'
ORDER BY created_at DESC
LIMIT 10;
```

**읽는 법**
- `Seq Scan`: 테이블 전체 스캔 (느림) → 인덱스 필요
- `Index Scan`: 인덱스 사용 (빠름)
- `cost=`: 예상 비용 (낮을수록 좋음)
- `actual time=`: 실제 소요 시간(ms)

### 윈도우 함수
```sql
-- 각 부서별 급여 순위
SELECT name, dept, salary,
       RANK() OVER (PARTITION BY dept ORDER BY salary DESC) as rank,
       LAG(salary) OVER (ORDER BY created_at) as prev_salary
FROM employees;
```

### UPSERT (INSERT OR UPDATE)
```sql
INSERT INTO users (email, name) VALUES ('test@example.com', '홍길동')
ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW();
```

### JSON 조회
```sql
-- JSONB 필드 검색
SELECT * FROM products WHERE metadata->>'category' = 'electronics';
SELECT * FROM products WHERE metadata @> '{"brand": "Samsung"}';
```

### 자주 쓰는 성능 팁
1. 자주 조회하는 컬럼에 인덱스 추가
2. `SELECT *` 대신 필요한 컬럼만 명시
3. `LIMIT` 없는 대용량 쿼리 주의
4. 연결 풀링: `pg_bouncer` 또는 SQLAlchemy 풀 사용""",
    },

    {
        "persona": "dev",
        "q": "클린 아키텍처 SOLID 원칙 설계 패턴 Python",
        "a": """## 클린 아키텍처 & SOLID 원칙

### SOLID 원칙
```python
# S — 단일 책임 원칙 (SRP)
# 나쁜 예: 하나의 클래스에 여러 역할
class User:
    def save(self): ...          # DB 접근
    def send_email(self): ...    # 이메일 전송
    def generate_report(self):  # 리포트 생성

# 좋은 예: 역할 분리
class UserRepository:
    def save(self, user): ...

class EmailService:
    def send_welcome(self, user): ...

# O — 개방-폐쇄 원칙 (OCP): 확장에 열림, 수정에 닫힘
from abc import ABC, abstractmethod

class Notifier(ABC):
    @abstractmethod
    def notify(self, message: str): ...

class EmailNotifier(Notifier):
    def notify(self, message): send_email(message)

class SlackNotifier(Notifier):
    def notify(self, message): send_slack(message)

# I — 인터페이스 분리 (ISP): 필요한 것만 구현
class Readable(ABC):
    @abstractmethod
    def read(self) -> str: ...

class Writable(ABC):
    @abstractmethod
    def write(self, data: str): ...

# D — 의존성 역전 (DIP): 추상에 의존
class UserService:
    def __init__(self, repo: UserRepository):  # 인터페이스에 의존
        self.repo = repo
```

### 레이어드 아키텍처 (FastAPI 예시)
```
app/
  api/          ← 컨트롤러 (HTTP 요청/응답)
    routes/
  services/     ← 비즈니스 로직
  repositories/ ← 데이터 접근 (DB)
  models/       ← 도메인 모델
  schemas/      ← Pydantic 입출력 스키마
```

### 의존성 주입
```python
from fastapi import Depends

def get_user_repo():
    return UserRepository(db_session)

def get_user_service(repo: UserRepository = Depends(get_user_repo)):
    return UserService(repo)

@router.get("/users/{id}")
def get_user(id: int, service: UserService = Depends(get_user_service)):
    return service.get_user(id)
```""",
    },

    {
        "persona": "dev",
        "q": "웹 보안 OWASP XSS SQL 인젝션 CSRF 방어",
        "a": """## 웹 보안 핵심 — OWASP Top 10 대응

### 1. SQL 인젝션 방지
```python
# 나쁜 예 (취약)
cursor.execute(f"SELECT * FROM users WHERE name = '{user_input}'")

# 좋은 예 (파라미터 바인딩)
cursor.execute("SELECT * FROM users WHERE name = ?", (user_input,))

# SQLAlchemy ORM 사용 (자동 이스케이프)
user = db.query(User).filter(User.name == user_input).first()
```

### 2. XSS (Cross-Site Scripting) 방지
```javascript
// 나쁜 예
element.innerHTML = userInput;  // 스크립트 실행 가능

// 좋은 예
element.textContent = userInput;  // 텍스트로만 처리

// React는 기본적으로 자동 이스케이프
// dangerouslySetInnerHTML은 XSS 위험, 사용 최소화
```

### 3. CSRF 방지 (FastAPI)
```python
from fastapi import Request

# CSRF 토큰 생성 & 검증
import secrets

def generate_csrf_token():
    return secrets.token_hex(32)

async def verify_csrf(request: Request):
    token = request.headers.get('X-CSRF-Token')
    if not token or token != request.session.get('csrf_token'):
        raise HTTPException(403, "CSRF token invalid")
```

### 4. 인증·인가 (JWT)
```python
from jose import jwt
from datetime import datetime, timedelta

SECRET_KEY = "your-secret-key"  # 환경변수로 관리!

def create_token(user_id: int) -> str:
    expire = datetime.utcnow() + timedelta(hours=24)
    return jwt.encode({"sub": str(user_id), "exp": expire}, SECRET_KEY)

def verify_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
```

### 5. 환경변수 관리
```python
# .env 파일 (절대 Git에 커밋 금지!)
SECRET_KEY=your-secret-key
DATABASE_URL=postgresql://...
API_KEY=sk-...

# .gitignore에 반드시 추가
echo ".env" >> .gitignore

# Python에서 로드
from dotenv import load_dotenv
import os
load_dotenv()
SECRET_KEY = os.getenv("SECRET_KEY")
```

### 6. 입력 유효성 검증 (Pydantic)
```python
from pydantic import BaseModel, EmailStr, validator

class UserCreate(BaseModel):
    email: EmailStr
    password: str
    age: int

    @validator('password')
    def password_strength(cls, v):
        if len(v) < 8:
            raise ValueError('비밀번호 8자 이상')
        return v

    @validator('age')
    def valid_age(cls, v):
        if not 1 <= v <= 150:
            raise ValueError('유효하지 않은 나이')
        return v
```""",
    },

    {
        "persona": "dev",
        "q": "Python 데코레이터 패턴 활용법 함수 클래스 데코레이터",
        "a": """## Python 데코레이터 완전 정복

### 함수 데코레이터 기초
```python
from functools import wraps

def my_decorator(func):
    @wraps(func)   # 원본 함수 메타데이터 보존
    def wrapper(*args, **kwargs):
        print("함수 실행 전")
        result = func(*args, **kwargs)
        print("함수 실행 후")
        return result
    return wrapper

@my_decorator
def say_hello(name):
    print(f"Hello, {name}!")
```

### 인자를 받는 데코레이터
```python
def retry(max_attempts=3, delay=1.0):
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            for attempt in range(max_attempts):
                try:
                    return await func(*args, **kwargs)
                except Exception as e:
                    if attempt == max_attempts - 1:
                        raise
                    await asyncio.sleep(delay * (attempt + 1))
        return wrapper
    return decorator

@retry(max_attempts=3, delay=0.5)
async def fetch_data(url: str):
    async with httpx.AsyncClient() as client:
        return await client.get(url)
```

### 클래스 데코레이터
```python
class Timer:
    def __init__(self, func):
        wraps(func)(self)
        self.func = func
        self.calls = 0

    def __call__(self, *args, **kwargs):
        import time
        self.calls += 1
        start = time.perf_counter()
        result = self.func(*args, **kwargs)
        elapsed = time.perf_counter() - start
        print(f"{self.func.__name__}: {elapsed:.3f}s (호출 {self.calls}회)")
        return result

@Timer
def expensive_function():
    time.sleep(0.1)
```

### 실전 패턴
```python
# 로깅 데코레이터
def log_calls(logger=None):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            _log = logger or logging.getLogger(func.__module__)
            _log.info(f"Calling {func.__name__} with {args}, {kwargs}")
            try:
                result = func(*args, **kwargs)
                _log.info(f"{func.__name__} returned {result}")
                return result
            except Exception as e:
                _log.error(f"{func.__name__} raised {e}")
                raise
        return wrapper
    return decorator

# 캐시 데코레이터 (내장)
from functools import lru_cache

@lru_cache(maxsize=128)
def fibonacci(n: int) -> int:
    if n < 2: return n
    return fibonacci(n-1) + fibonacci(n-2)
```""",
    },

    # ── 여행 — 추가 국내 및 실용 정보 ──────────────────────

    {
        "persona": "travel",
        "q": "일본 여행 비자 면제 JR 패스 교통 카드 스이카 이코카",
        "a": """## 일본 여행 교통 완전 가이드

### 비자
- 한국→일본: **무비자 90일** (여권만 있으면 됨)

### 교통 카드 (IC카드)
| 카드 | 지역 | 특징 |
|------|------|------|
| 스이카 (Suica) | 도쿄·전국 | 아이폰 Apple Pay 등록 가능 |
| 이코카 (ICOCA) | 오사카·간사이 | 관광지 매장 결제 가능 |
| 파스모 (PASMO) | 도쿄 | 스이카와 거의 동일 |

**어디서나 교환 가능** — 스이카·이코카는 일본 전국 전철·버스·편의점에서 사용

### JR 패스 (기차 무제한 탑승권)
- **외국인 전용** (일본 입국 전 구매, 한국에서 구입 가능)
- 신칸센·특급열차 포함 (노조미·미즈호 제외)
- 가격: 7일 50,000엔~, 14일 80,000엔~

**JR 패스 추천 경우**
- 도쿄↔오사카↔교토 왕복 시 (신칸센 왕복만 약 30,000엔)
- 다도시 여행 (도쿄→오사카→히로시마→후쿠오카)

**JR 패스 비추 경우**
- 1개 도시만 머무를 때 (오사카만 등)

### 신칸센 예약
- JR 패스 없으면: JR 티켓 창구 or 스마트 EX 앱 예약
- 도쿄↔오사카 (노조미, 2시간 30분): 편도 약 15,000엔

### 앱 추천
- **구글 지도** (전철 갈아타기 완벽)
- **Yahoo 乗換案内** (일본 현지 환승 특화)
- **스이카 앱** (충전·잔액 확인)""",
    },

    {
        "persona": "travel",
        "q": "캄보디아 앙코르와트 여행 씨엠립 코스 비용",
        "a": """## 캄보디아 앙코르와트 여행

### 앙코르 유적지 개요
- 12세기 크메르왕국 건설한 세계 최대 종교 건축물 군락
- 씨엠립(Siem Reap)에서 툭툭이로 15분

### 입장권
| 구분 | 1일권 | 3일권 | 7일권 |
|------|--------|--------|--------|
| 성인 | $37 | $62 | $72 |
| 아동(12세미만) | 무료 | - | - |

- 구매: 앙코르 공식 티켓센터 (현금·카드)
- **일몰 1시간 전 입장 가능** (무료는 아님)

### 추천 코스

**일출 코스** (오전 4:30 출발)
- 앙코르와트 일출 (연못 반영 사진 최고)
- 바이욘 사원 (사면불탑)
- 타프롬 (나무뿌리 유적, 영화 툼레이더 촬영지)

**일몰 코스** (오후)
- 프놈바켕 언덕 (일몰 전망, 매우 붐빔)
- 앙코르톰 성 내부

### 교통
- 툭툭이 대여: 1일 12~20달러 (앙코르 소코스)
- 에어컨 택시: 1일 35~50달러

### 씨엠립 숙박·음식
- 게스트하우스: 10~15달러 (학원가 주변)
- 크메르 요리: 아목(생선카레), 롯 (볶음면)
- 퍼브 스트리트 (Pub Street): 바·식당 집결

### 교통
- 서울→씨엠립: 직항 6시간 (10~20만원)
- 입국: 비자 온어라이벌 35달러 (공항)""",
    },

    {
        "persona": "travel",
        "q": "유럽 기차 여행 유레일 패스 국가 간 이동 야간열차",
        "a": """## 유럽 기차 여행 완전 가이드

### 유레일 패스 종류
| 종류 | 내용 | 적합 |
|------|------|------|
| 글로벌 패스 | 33개국 모두 | 다국가 배낭여행 |
| 원컨트리 패스 | 1개국 집중 | 이탈리아·스페인 등 |
| 2~4국 패스 | 선택 국가 | 인접 국가 여행 |

**가격**: 5일 연속 290유로~ (성인)
**구매**: Rail Europe, Eurail.com (한국 인터넷 구매 가능)

### 예약 필요 vs 불필요
- **예약 불필요**: 지역 완행열차, 인터시티 일부
- **예약 필수**: 타리스·탈리스 (파리↔암스테르담), 유로스타 (런던↔파리), 야간열차

### 인기 야간열차 노선
- **파리→베네치아**: 썬샤인 익스프레스 (약 12시간)
- **파리→바르셀로나**: 야간버스 or 저가항공 대체 다수
- **오스트리아→독일**: 나이트젯 (야간열차 부활)

### 저가항공 vs 기차
| | 저가항공 | 기차 |
|--|---------|------|
| 비용 | 3~10만원 | 5~20만원 |
| 시간 | 이동+공항 = 4~5시간 | 시내 중심→시내 직결 |
| 짐 | 수화물 추가비 | 무료 |
| 추천 | 1,000km 이상 | 500km 이내 |

### 앱·사이트
- **Trainline**: 유럽 전체 기차 예약
- **Omio**: 기차+버스+항공 비교
- **Flixbus**: 유럽 시외버스 (초저렴)""",
    },

]
