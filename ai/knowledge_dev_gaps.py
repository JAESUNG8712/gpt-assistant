"""Dev + Travel 갭 지식베이스 — 누락된 개발·여행 주제 보완"""

DEV_GAP_KNOWLEDGE = [

    {
        "persona": "dev",
        "q": "Python 패키지 관리 pip poetry uv requirements 가상환경",
        "a": """## Python 패키지·환경 관리 도구 비교

### pip + venv (기본)
```bash
python -m venv .venv          # 가상환경 생성
source .venv/bin/activate     # 활성화 (Mac/Linux)
.venv\\Scripts\\activate       # Windows
pip install fastapi            # 패키지 설치
pip freeze > requirements.txt  # 의존성 고정
pip install -r requirements.txt
```

### uv (2024년 신흥 강자 ⭐ 추천)
```bash
# Rust로 만든 초고속 pip 대체제 (10~100x 빠름)
pip install uv

uv venv                     # 가상환경 자동 생성
uv pip install fastapi      # 패키지 설치 (매우 빠름)
uv pip sync requirements.txt
uv run python main.py       # 환경 자동 활성화 후 실행
```

### Poetry (프로젝트 관리 + 의존성 잠금)
```bash
pip install poetry

poetry new my-project        # 프로젝트 생성
poetry add fastapi           # 의존성 추가
poetry add --dev pytest      # 개발 전용
poetry install               # lock 파일 기반 설치
poetry run python main.py
```

### 언제 뭘 쓸까?
| 상황 | 도구 |
|------|------|
| 빠른 설치·간단 스크립트 | uv |
| 라이브러리 배포 (PyPI) | Poetry |
| 팀 프로젝트 의존성 관리 | Poetry or uv |
| 기존 requirements.txt | pip + venv |

### .gitignore에 추가
```
.venv/
__pycache__/
*.pyc
.env
```""",
    },

    {
        "persona": "dev",
        "q": "Python 코드 품질 linting mypy ruff black pre-commit 정적 분석",
        "a": """## Python 코드 품질 도구 완전 정리

### Ruff (2024 최강 린터 ⭐)
```bash
pip install ruff

# 설정 (pyproject.toml)
[tool.ruff]
line-length = 88
select = ["E", "F", "I"]    # 에러·플레이크8·임포트 정렬

ruff check .                # 린팅
ruff check --fix .          # 자동 수정
ruff format .               # 포매팅 (black 대체)
```

### mypy (정적 타입 검사)
```bash
pip install mypy

# mypy.ini 또는 pyproject.toml
[mypy]
strict = true
ignore_missing_imports = true

mypy src/                   # 타입 오류 검사
```

```python
# 타입 오류 예시
def greet(name: str) -> str:
    return name + 42    # Error: str + int 불가
```

### pre-commit (커밋 전 자동 검사)
```bash
pip install pre-commit

# .pre-commit-config.yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.4.0
    hooks:
      - id: ruff
      - id: ruff-format
  - repo: https://github.com/pre-commit/mirrors-mypy
    rev: v1.9.0
    hooks:
      - id: mypy

pre-commit install          # 훅 설치
pre-commit run --all-files  # 전체 검사
```

### 추천 설정 조합
```toml
# pyproject.toml
[tool.ruff]
line-length = 100
select = ["E", "F", "I", "N", "UP"]

[tool.mypy]
python_version = "3.11"
strict = true

[tool.pytest.ini_options]
testpaths = ["tests"]
```""",
    },

    {
        "persona": "dev",
        "q": "OAuth2 JWT 인증 구현 FastAPI 로그인 토큰 인증",
        "a": """## FastAPI JWT 인증 구현

### 의존성 설치
```bash
pip install python-jose[cryptography] passlib[bcrypt]
```

### 전체 구현 예시
```python
from datetime import datetime, timedelta
from jose import jwt, JWTError
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm

SECRET_KEY = "your-secret-key-min-32chars"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30

pwd_context = CryptContext(schemes=["bcrypt"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/token")

# 비밀번호 해싱
def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)

# JWT 토큰 생성
def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode["exp"] = expire
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

# 토큰 검증 → 현재 사용자 반환
async def get_current_user(token: str = Depends(oauth2_scheme)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="유효하지 않은 인증 정보",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    return user_id

# 로그인 엔드포인트
@app.post("/auth/token")
async def login(form: OAuth2PasswordRequestForm = Depends()):
    user = authenticate_user(form.username, form.password)
    if not user:
        raise HTTPException(status_code=400, detail="잘못된 아이디/비밀번호")
    token = create_access_token({"sub": str(user.id)})
    return {"access_token": token, "token_type": "bearer"}

# 보호된 엔드포인트
@app.get("/me")
async def get_me(user_id: str = Depends(get_current_user)):
    return {"user_id": user_id}
```""",
    },

    {
        "persona": "dev",
        "q": "WebSocket 실시간 통신 FastAPI Python 채팅 알림",
        "a": """## FastAPI WebSocket 실시간 통신

### 기본 WebSocket 서버
```python
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from typing import List

app = FastAPI()

class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        self.active.remove(ws)

    async def broadcast(self, message: str):
        for connection in self.active:
            await connection.send_text(message)

    async def send_personal(self, message: str, ws: WebSocket):
        await ws.send_text(message)

manager = ConnectionManager()

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(ws: WebSocket, client_id: str):
    await manager.connect(ws)
    try:
        while True:
            data = await ws.receive_text()
            await manager.broadcast(f"[{client_id}]: {data}")
    except WebSocketDisconnect:
        manager.disconnect(ws)
        await manager.broadcast(f"{client_id} 연결 종료")
```

### 클라이언트 (JavaScript)
```javascript
const ws = new WebSocket('ws://localhost:8000/ws/user123');

ws.onopen = () => console.log('연결됨');
ws.onmessage = (e) => console.log('받음:', e.data);
ws.onclose = () => console.log('연결 종료');

// 메시지 전송
ws.send('안녕하세요!');
```

### 실시간 알림 패턴
```python
# 서버 → 클라이언트 단방향 알림 (SSE가 더 적합)
@app.get("/events")
async def event_stream():
    async def generate():
        while True:
            data = await get_new_events()
            yield f"data: {json.dumps(data)}\\n\\n"
            await asyncio.sleep(1)
    return StreamingResponse(generate(), media_type="text/event-stream")
```""",
    },

    {
        "persona": "dev",
        "q": "Celery Redis 비동기 작업 큐 백그라운드 태스크 Python",
        "a": """## Celery 비동기 작업 큐

### 설치 및 기본 설정
```bash
pip install celery redis
```

```python
# celery_app.py
from celery import Celery

celery_app = Celery(
    "tasks",
    broker="redis://localhost:6379/0",
    backend="redis://localhost:6379/1",
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    timezone="Asia/Seoul",
    task_routes={"tasks.send_email": {"queue": "email"}},
)
```

### 태스크 정의
```python
# tasks.py
from celery_app import celery_app
import time

@celery_app.task(bind=True, max_retries=3)
def send_email(self, to: str, subject: str, body: str):
    try:
        # 실제 이메일 전송 로직
        email_service.send(to, subject, body)
        return {"status": "sent", "to": to}
    except Exception as exc:
        raise self.retry(exc=exc, countdown=60)

@celery_app.task
def generate_report(user_id: int):
    time.sleep(30)  # 무거운 작업 시뮬레이션
    return {"report_url": f"/reports/{user_id}.pdf"}
```

### FastAPI에서 태스크 실행
```python
from fastapi import BackgroundTasks
from tasks import send_email, generate_report

@app.post("/send-email")
async def trigger_email(to: str, subject: str, body: str):
    task = send_email.delay(to, subject, body)   # 비동기 실행
    return {"task_id": task.id}

@app.get("/tasks/{task_id}")
async def get_task_result(task_id: str):
    result = celery_app.AsyncResult(task_id)
    return {"status": result.status, "result": result.result}
```

### Celery 워커 실행
```bash
celery -A celery_app worker --loglevel=info
celery -A celery_app worker -Q email --concurrency=4  # 이메일 큐 전용
celery -A celery_app flower   # 웹 모니터링 UI
```""",
    },

    {
        "persona": "dev",
        "q": "Python 로깅 설정 logging structlog 레벨 파일 출력",
        "a": """## Python 로깅 완전 가이드

### 기본 logging 설정
```python
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),                    # 콘솔
        logging.FileHandler("app.log", encoding="utf-8"),  # 파일
    ],
)

logger = logging.getLogger(__name__)

logger.debug("디버그 메시지")     # 개발 시
logger.info("정상 동작")          # 일반 정보
logger.warning("주의 필요")       # 경고
logger.error("오류 발생")         # 오류
logger.critical("치명적 오류")    # 즉시 대응 필요
```

### 로깅 레벨별 사용 지침
| 레벨 | 환경 | 사용 예 |
|------|------|--------|
| DEBUG | 개발 | 변수값, 함수 진입/종료 |
| INFO | 운영 | 요청 처리, 배치 시작/종료 |
| WARNING | 운영 | 예상치 못한 상황, 성능 저하 |
| ERROR | 운영 | 오류 발생 (사용자 영향 있음) |
| CRITICAL | 운영 | 서비스 중단 수준 |

### JSON 구조화 로깅 (운영 환경 추천)
```python
import logging
import json
from datetime import datetime

class JSONFormatter(logging.Formatter):
    def format(self, record):
        log = {
            "timestamp": datetime.utcnow().isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            log["exception"] = self.formatException(record.exc_info)
        return json.dumps(log, ensure_ascii=False)

handler = logging.StreamHandler()
handler.setFormatter(JSONFormatter())
logging.getLogger().addHandler(handler)
```

### FastAPI 요청 로깅 미들웨어
```python
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    duration = time.time() - start
    logger.info(
        f"{request.method} {request.url.path} "
        f"→ {response.status_code} ({duration:.3f}s)"
    )
    return response
```""",
    },

    {
        "persona": "dev",
        "q": "Pydantic v2 데이터 검증 모델 설정 FastAPI 스키마",
        "a": """## Pydantic v2 완전 가이드

### 기본 모델
```python
from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Optional
from datetime import datetime

class UserCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=50)
    email: str = Field(..., pattern=r"^[\\w.+-]+@[\\w-]+\\.[\\w.]+$")
    age: int = Field(ge=0, le=150)
    role: str = Field(default="user")

    @field_validator("name")
    @classmethod
    def name_must_not_contain_special(cls, v: str) -> str:
        if any(c in v for c in "!@#$%"):
            raise ValueError("이름에 특수문자 불가")
        return v.strip()

    @model_validator(mode="after")
    def check_age_role(self) -> "UserCreate":
        if self.role == "admin" and self.age < 18:
            raise ValueError("관리자는 18세 이상이어야 합니다")
        return self
```

### 중첩 모델 & 리스트
```python
class Address(BaseModel):
    city: str
    zipcode: str

class User(BaseModel):
    id: int
    name: str
    address: Optional[Address] = None
    tags: list[str] = []

# 사용
user = User(id=1, name="홍길동", address={"city": "서울", "zipcode": "12345"})
print(user.model_dump())     # dict 변환
print(user.model_dump_json()) # JSON 문자열
```

### v1 → v2 주요 변경사항
| v1 | v2 |
|----|-----|
| `.dict()` | `.model_dump()` |
| `.json()` | `.model_dump_json()` |
| `@validator` | `@field_validator` |
| `class Config` | `model_config = ConfigDict(...)` |
| `parse_obj()` | `model_validate()` |

### 설정 모델 (환경변수 로딩)
```python
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    db_url: str
    api_key: str
    debug: bool = False

    model_config = ConfigDict(env_file=".env")

settings = Settings()  # .env 자동 로드
```""",
    },

    {
        "persona": "dev",
        "q": "환경변수 .env dotenv 관리 배포 환경별 설정 시크릿",
        "a": """## 환경변수 완전 관리 가이드

### .env 파일 구조
```bash
# .env (개발용, 절대 git에 올리지 말 것!)
DATABASE_URL=postgresql://user:pass@localhost/db
SECRET_KEY=your-super-secret-key-min-32chars
GROQ_API_KEY=gsk_xxx
DEBUG=true
PORT=8000
```

### Python에서 로드
```python
# python-dotenv 사용
from dotenv import load_dotenv
import os

load_dotenv()  # .env 파일 자동 로드

DATABASE_URL = os.getenv("DATABASE_URL")
SECRET_KEY = os.getenv("SECRET_KEY", "default-fallback")  # 기본값
```

### Pydantic Settings로 타입 안전하게
```python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    database_url: str
    secret_key: str
    debug: bool = False
    max_connections: int = 10

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

settings = Settings()
print(settings.database_url)  # 타입 검증 자동
```

### 환경별 .env 파일
```
.env            ← 로컬 개발 (git 제외)
.env.production ← 배포 환경 예시 (git 제외)
.env.example    ← 필요한 변수 목록 (git 포함 ✅)
```

### .gitignore 필수 설정
```
.env
.env.*
!.env.example
```

### Render.com / Railway 배포 시
- 대시보드 "Environment Variables" 탭에서 직접 입력
- 코드에 시크릿 하드코딩 절대 금지
- GitHub Actions: Settings → Secrets 등록

### 검증 스크립트
```python
REQUIRED = ["DATABASE_URL", "SECRET_KEY", "API_KEY"]
missing = [k for k in REQUIRED if not os.getenv(k)]
if missing:
    raise EnvironmentError(f"필수 환경변수 누락: {missing}")
```""",
    },

    {
        "persona": "dev",
        "q": "Python 성능 최적화 프로파일링 cProfile 병목 찾기",
        "a": """## Python 성능 최적화 & 프로파일링

### cProfile로 병목 찾기
```python
import cProfile
import pstats

# 방법 1: 커맨드라인
# python -m cProfile -s cumtime my_script.py

# 방법 2: 코드 내 사용
with cProfile.Profile() as pr:
    my_slow_function()

stats = pstats.Stats(pr)
stats.sort_stats("cumulative")
stats.print_stats(20)  # 상위 20개 출력
```

### line_profiler (줄별 분석)
```bash
pip install line_profiler

# 코드에 데코레이터 추가
@profile
def slow_function(data):
    result = []
    for item in data:        # 이 줄이 느림!
        result.append(item * 2)
    return result

# 실행
kernprof -l -v my_script.py
```

### 자주 쓰는 최적화 패턴
```python
# 1. 리스트 대신 set (검색 O(1))
bad:  items = [1, 2, 3]; 5 in items    # O(n)
good: items = {1, 2, 3}; 5 in items    # O(1)

# 2. 리스트 컴프리헨션 (append 루프보다 빠름)
good: result = [x*2 for x in range(1000)]

# 3. 제너레이터 (메모리 절약)
bad:  list(range(10**6))          # 메모리에 모두 저장
good: (x for x in range(10**6))   # 순차 생성

# 4. lru_cache (반복 계산 캐시)
from functools import lru_cache

@lru_cache(maxsize=512)
def fibonacci(n):
    return n if n < 2 else fibonacci(n-1) + fibonacci(n-2)

# 5. 문자열 연결
bad:  s = ""; for x in items: s += x    # O(n²)
good: s = "".join(items)                 # O(n)

# 6. 병렬 처리
from concurrent.futures import ThreadPoolExecutor

with ThreadPoolExecutor(max_workers=4) as executor:
    results = list(executor.map(fetch_url, urls))
```

### 메모리 최적화
```python
import sys
sys.getsizeof([1, 2, 3])       # 리스트 메모리 크기
# __slots__ 사용 → 클래스 메모리 40% 절약
class Point:
    __slots__ = ["x", "y"]
    def __init__(self, x, y): self.x, self.y = x, y
```""",
    },

    {
        "persona": "dev",
        "q": "JavaScript ES6 모던 문법 화살표함수 구조분해 프로미스 async await",
        "a": """## 모던 JavaScript 핵심 문법 (ES6+)

### 화살표 함수
```javascript
// 기존
function add(a, b) { return a + b; }

// 화살표 함수
const add = (a, b) => a + b;
const greet = name => `안녕하세요, ${name}!`;
const getObj = () => ({ id: 1, name: "홍길동" });  // 객체 반환
```

### 구조 분해 할당
```javascript
// 배열
const [first, second, ...rest] = [1, 2, 3, 4, 5];

// 객체
const { name, age, role = "user" } = user;
const { address: { city } } = user;  // 중첩

// 함수 매개변수
function greet({ name, age }) {
    return `${name}님 (${age}세)`;
}
```

### 스프레드 연산자
```javascript
const newArr = [...arr1, ...arr2, 5];
const newObj = { ...obj1, ...obj2, extra: "value" };
```

### 프로미스 & async/await
```javascript
// Promise 체인
fetch('/api/users')
    .then(res => res.json())
    .then(data => console.log(data))
    .catch(err => console.error(err));

// async/await (더 깔끔)
async function loadUsers() {
    try {
        const res = await fetch('/api/users');
        const data = await res.json();
        return data;
    } catch (err) {
        console.error('오류:', err);
    }
}

// 병렬 실행
const [users, posts] = await Promise.all([
    fetch('/api/users').then(r => r.json()),
    fetch('/api/posts').then(r => r.json()),
]);
```

### 옵셔널 체이닝 & 널 병합
```javascript
const city = user?.address?.city;         // undefined 안전
const name = user?.name ?? "익명";        // null/undefined 대체
user?.greet?.();                          // 메서드 안전 호출
```

### 배열 메서드
```javascript
const numbers = [1, 2, 3, 4, 5];
numbers.map(x => x * 2)          // [2,4,6,8,10]
numbers.filter(x => x > 2)       // [3,4,5]
numbers.reduce((acc, x) => acc + x, 0)  // 15
numbers.find(x => x > 3)         // 4
numbers.some(x => x > 4)         // true
numbers.every(x => x > 0)        // true
```""",
    },

    {
        "persona": "dev",
        "q": "Linux 서버 기초 명령어 cron SSH 프로세스 관리 배포",
        "a": """## 개발자를 위한 Linux 기초

### 필수 명령어
```bash
# 파일/디렉토리
ls -la                 # 상세 목록
mkdir -p path/to/dir   # 중간 경로 포함 생성
cp -r src/ dst/        # 재귀 복사
rm -rf dir/            # 재귀 삭제 (주의!)
find . -name "*.py"    # 파일 검색
grep -r "keyword" .    # 내용 검색

# 프로세스
ps aux | grep python   # 프로세스 확인
kill -9 PID            # 강제 종료
nohup python main.py & # 백그라운드 실행

# 디스크/메모리
df -h                  # 디스크 사용량
free -h                # 메모리 사용량
du -sh *               # 폴더별 용량
top / htop             # 실시간 모니터링

# 네트워크
curl -X POST http://localhost:8000/api -d '{}'
wget http://example.com/file.zip
ss -tlnp               # 포트 확인 (netstat 대체)
```

### SSH 접속 & 파일 전송
```bash
ssh user@server-ip             # 접속
ssh -i key.pem user@server     # 키 파일 사용
scp local.txt user@server:~/   # 파일 업로드
rsync -avz ./src/ user@server:~/src/  # 동기화
```

### Cron 작업 예약
```bash
crontab -e     # 편집기 열기

# 형식: 분 시 일 월 요일 명령어
0 2 * * *  /usr/bin/python3 /app/backup.py   # 매일 새벽 2시
*/5 * * * * curl http://localhost:8000/health  # 5분마다
0 0 1 * * /app/monthly_report.sh              # 매월 1일 자정
```

### systemd 서비스 등록 (배포)
```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My FastAPI App

[Service]
User=ubuntu
WorkingDirectory=/app
ExecStart=/app/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
```
```bash
systemctl daemon-reload
systemctl enable myapp
systemctl start myapp
systemctl status myapp
journalctl -u myapp -f   # 로그 실시간 확인
```""",
    },

    {
        "persona": "dev",
        "q": "API Rate Limiting 속도 제한 요청 제한 구현 FastAPI",
        "a": """## API Rate Limiting 구현

### slowapi 사용 (FastAPI 전용)
```bash
pip install slowapi
```

```python
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from fastapi import Request

limiter = Limiter(key_func=get_remote_address)
app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

@app.get("/api/data")
@limiter.limit("60/minute")          # IP당 분당 60회
async def get_data(request: Request):
    return {"data": "..."}

@app.post("/api/ai-chat")
@limiter.limit("10/minute")          # AI API는 더 제한적으로
async def chat(request: Request, body: dict):
    return {"response": "..."}
```

### Redis 기반 분산 Rate Limiting
```python
import redis
import time
from fastapi import HTTPException

r = redis.Redis()

def check_rate_limit(user_id: str, limit: int = 60, window: int = 60) -> bool:
    key = f"rl:{user_id}:{int(time.time() // window)}"
    count = r.incr(key)
    if count == 1:
        r.expire(key, window)
    return count <= limit

@app.post("/api/expensive-operation")
async def expensive(user_id: str):
    if not check_rate_limit(user_id, limit=10, window=60):
        raise HTTPException(429, detail="요청 한도 초과. 잠시 후 다시 시도하세요.")
    return {"result": "..."}
```

### 응답 헤더로 남은 횟수 안내
```python
@app.get("/api/data")
async def get_data(response: Response):
    remaining = get_remaining_requests(user_id)
    response.headers["X-RateLimit-Limit"] = "60"
    response.headers["X-RateLimit-Remaining"] = str(remaining)
    response.headers["X-RateLimit-Reset"] = str(next_reset_time)
    return {"data": "..."}
```""",
    },

    {
        "persona": "dev",
        "q": "Python 타입 힌트 고급 Union Optional Protocol TypeVar 제네릭",
        "a": """## Python 고급 타입 힌트

### Union & Optional
```python
from typing import Union, Optional

# Python 3.10+ 간결한 표기
def process(value: int | str | None) -> int | None:
    if value is None:
        return None
    return int(value) if isinstance(value, str) else value

# Optional[X] = X | None
def find_user(user_id: int) -> Optional[dict]:
    return db.get(user_id)
```

### TypeVar & 제네릭
```python
from typing import TypeVar, Generic, Sequence

T = TypeVar("T")

def first(items: Sequence[T]) -> T | None:
    return items[0] if items else None

class Stack(Generic[T]):
    def __init__(self) -> None:
        self._items: list[T] = []

    def push(self, item: T) -> None:
        self._items.append(item)

    def pop(self) -> T:
        return self._items.pop()

stack: Stack[int] = Stack()
stack.push(1)   # OK
stack.push("x") # 타입 오류!
```

### Protocol (구조적 서브타이핑)
```python
from typing import Protocol

class Drawable(Protocol):
    def draw(self) -> None: ...
    def resize(self, factor: float) -> None: ...

class Circle:
    def draw(self) -> None: print("원 그리기")
    def resize(self, factor: float) -> None: ...

def render(shape: Drawable) -> None:
    shape.draw()

render(Circle())  # Circle이 Drawable을 명시 상속 없이도 OK!
```

### TypedDict
```python
from typing import TypedDict, Required, NotRequired

class UserDict(TypedDict):
    id: int
    name: str
    email: Required[str]
    age: NotRequired[int]

user: UserDict = {"id": 1, "name": "홍길동", "email": "test@test.com"}
```

### Annotated (메타데이터 포함 타입)
```python
from typing import Annotated
from pydantic import Field

# Pydantic에서 자주 사용
PositiveInt = Annotated[int, Field(gt=0)]
EmailStr = Annotated[str, Field(pattern=r"@")]
```""",
    },

    {
        "persona": "dev",
        "q": "모놀리스 마이크로서비스 아키텍처 선택 설계",
        "a": """## 모놀리스 vs 마이크로서비스

### 비교표
| 항목 | 모놀리스 | 마이크로서비스 |
|------|---------|-------------|
| 개발 속도 | 빠름 (초기) | 느림 (설정 많음) |
| 배포 | 전체 배포 | 서비스별 독립 배포 |
| 확장성 | 전체 스케일아웃 | 서비스별 스케일 가능 |
| 팀 규모 | 소~중 (10명 이하) | 대 (팀당 1 서비스) |
| 복잡도 | 낮음 | 네트워크·데이터 복잡 |
| 장애 격리 | 어려움 | 서비스별 격리 가능 |
| 언어/기술 | 단일 | 서비스별 선택 가능 |

### 언제 모놀리스?
- 스타트업·초기 제품 (빠른 검증)
- 팀 5~10명 이하
- 도메인 경계 불명확
- **"먼저 모놀리스로 시작, 필요 시 분리"** 권장

### 언제 마이크로서비스?
- 서비스별 트래픽 차이가 큰 경우
- 독립 배포가 중요한 경우
- 팀이 50명 이상 (콘웨이의 법칙)
- CI/CD 성숙

### Modular Monolith (중간 지점) ⭐추천
```python
# 모놀리스지만 모듈별 엄격한 경계
app/
  auth/            ← 독립 모듈 (자체 DB 접근)
    router.py
    service.py
    repository.py
  products/
    router.py
    service.py
  orders/
    router.py
    service.py
  shared/          ← 공통 유틸리티
```

### 마이크로서비스 통신
```python
# 동기: REST API 또는 gRPC
async with httpx.AsyncClient() as client:
    order = await client.get(f"http://order-service/orders/{id}")

# 비동기: 메시지 큐 (Kafka, RabbitMQ)
await kafka.produce("order.created", order_data)
```""",
    },

]


TRAVEL_GAP_KNOWLEDGE = [

    {
        "persona": "travel",
        "q": "호주 시드니 멜버른 골드코스트 여행 코스 비용 비자",
        "a": """## 호주 여행 완전 가이드

### 비자
- 한국→호주: **ETA(전자여행허가, AUD 20)** 신청 필수
- eVisitor: 무료 (컴퓨터로 신청) / ETA: 유료
- 최대 3개월 체류, 관광·방문 목적

### 시드니 필수 코스
- **오페라 하우스**: 세계 건축 걸작, 내부 투어 or 야경
- **하버브리지**: 다리 위 투어 (클라이밍 가능, 398AUD)
- **본다이 비치**: 서핑·산책, 코스탈 워크
- **록스 거리**: 역사 지구·마켓·카페
- **타롱가 동물원**: 코알라 만나기 (시내에서 페리)

### 멜버른 감성 코스
- 그라피티 골목 (Hosier Lane)
- 퀸 빅토리아 마켓 (일요일 푸드마켓)
- 야라 벨리 와이너리 투어
- 그레이트 오션 로드 (12 사도 바위, 당일치기)
- 세인트 킬다 해변

### 골드코스트 (테마파크 천국)
- 서퍼스 파라다이스 해변
- 무비월드·씨월드·드림월드 (패키지 할인)
- 탬버린 마운틴 (열대우림)

### 교통
- 서울→시드니: 직항 10시간 (30~70만원)
- 호주 내 이동: Myki카드(멜버른), Opal카드(시드니)
- 도시 간: 국내선 항공 저렴 (Jetstar·Virgin Australia)

### 예산 (7박8일)
- 항공: 50~100만원
- 숙박: 10~25만원/박
- 총: 200~400만원""",
    },

    {
        "persona": "travel",
        "q": "두바이 아랍에미리트 여행 가이드 비용 버즈칼리파",
        "a": """## 두바이 여행 완전 가이드

### 기본 정보
- 화폐: AED 디르함 (1AED ≈ 370원)
- 기후: 10~4월 최적 (5~9월 40도+ 극더위)
- 한국인 무비자 90일

### 필수 관광지
**두바이 시내**
- 버즈 칼리파: 세계 최고층 (148층 전망대 165AED, 124층 124AED)
- 두바이몰: 세계 최대 쇼핑몰 + 실내 수족관 + 아이스링크
- 두바이 분수쇼: 매일 저녁 (무료, 레이저+음악)
- 두바이 마리나: 럭셔리 요트·식당가 야경

**올드 두바이**
- 두바이 크릭: 전통 목선(아브라) 이용 강 횡단 (1AED)
- 두바이 소크 (향신료·금 시장) 체험
- 알파히디 역사 지구

**사막·자연**
- 사막 사파리: 버기카+모래썰매+BBQ디너 (200~400AED)
- 팜 쥬메이라 아틀란티스 워터파크

### 먹거리
- 샤와르마: 15~25AED (두바이 국민 간식)
- 럭셔리 레스토랑: 1인 200~500AED
- 두바이몰 푸드코트: 30~60AED

### 교통
- 두바이 메트로: 편리, 2~10AED
- 택시·카림(Uber 현지판): 저렴 (공항→시내 약 90AED)

### 예산 (4박5일)
- 항공: 30~70만원 (경유 많음)
- 숙박: 15~40만원/박
- 총: 150~350만원""",
    },

    {
        "persona": "travel",
        "q": "터키 이스탄불 카파도키아 여행 코스 비자",
        "a": """## 터키 여행 완전 가이드

### 비자
- 한국인 **무비자 90일** (터키 e-Visa 신청 권장: 60달러, 온라인 수분 내 발급)

### 이스탄불 필수 코스
**역사 지구**
- 아야 소피아 (성당→모스크 변환, 입장 무료, 모슬렘 예배 시간 확인)
- 블루 모스크 (6개 첨탑, 예배 외 시간 무료)
- 톱카프 궁전 (오스만 제국 황실, 입장료 680TL)
- 그랜드 바자르 (4,000개 상점, 쇼핑·협상 문화)

**보스포루스 해협**
- 크루즈 투어 (유럽·아시아 대륙 동시에) 150~400TL
- 갈라타 탑 (구시가지 전망, 350TL)

### 카파도키아 (동화 같은 풍경)
- **열기구 투어**: 새벽 일출 기암절벽 비행 (150~350달러) ⭐인생 경험
- 괴레메 야외박물관 (동굴 교회·프레스코화)
- 으흘라라 계곡 트레킹
- 지하도시 (데린쿠유, 8층 깊이)
- 우치히사르 성 전망대

**이동 방법**: 이스탄불→카파도키아 야간버스 9시간 (400TL) or 항공 1시간

### 터키 음식
- 케밥 (되네르·쉬쉬·아다나)
- 바클라바 (꿀 페이스트리)
- 차이(홍차): 모든 곳에서 무료 제공 문화
- 투르크 커피: 찌꺼기 아래 남기고 마시기

### 예산 (7박8일)
- 항공: 40~80만원
- 숙박: 6~15만원/박 (동굴 호텔 15~30만원)
- 총: 120~250만원""",
    },

    {
        "persona": "travel",
        "q": "크로아티아 두브로브니크 동유럽 체코 프라하 부다페스트",
        "a": """## 동유럽 3국 여행 가이드

### 체코 프라하
**필수 코스**
- 프라하 성 (내부 성당·황금골목, 260CZK)
- 구시가지 광장·천문시계 (정시마다 퍼레이드)
- 카를 다리 (일출 새벽 방문 추천, 붐비기 전)
- 바츨라프 광장

**음식**: 슈베플리크 (돼지 무릎 굽기), 트르들로(굴뚝빵), 체코 맥주(15~25CZK)

---

### 헝가리 부다페스트
**필수 코스**
- 국회의사당 야경 (세계 최아름다운 야경 중 하나, 투어 7,500HUF)
- 부다 성 지구·어부의 요새 (야경 무료)
- 세체니 온천 (온천 입욕, 주말 8,400HUF)
- 루이나 바(폐건물 개조 바 문화)

**이동**: 프라하↔부다페스트 버스 7시간(플릭스버스) or 기차 7~8시간

---

### 크로아티아 두브로브니크
**필수 코스**
- **구시가지 성벽 투어** (200HRK, 2시간 소요, 왕좌의게임 촬영지)
- 스르지 언덕 케이블카 (파노라마 뷰)
- 로크룸 섬 (쾌속정 15분, 공작새 서식)
- 플리트비체 국립공원 (에메랄드 폭포 연속, 입장료 35유로)

**수도 자그레브 추가 방문** (두브로브니크→자그레브: 버스 9시간)

---

### 3국 예산 (10박11일)
- 항공: 80~150만원
- 숙박: 4~10만원/박
- 총: 200~350만원""",
    },

    {
        "persona": "travel",
        "q": "해외여행 중 아프면 병원 응급상황 대처 여행 중 긴급 상황",
        "a": """## 해외여행 중 응급상황 대처법

### 기본 준비물 (출국 전)
- 여행자 보험 가입 확인 (보험사 긴급 연락처 저장)
- 상비약: 해열제·지사제·감기약·소화제·밴드
- 처방전이 필요한 약: 영문 처방전 출력 지참

### 나라별 긴급 전화
| 국가 | 경찰 | 응급 | 소방 |
|------|------|------|------|
| 일본 | 110 | 119 | 119 |
| 미국 | 911 | 911 | 911 |
| 유럽 공통 | 112 | 112 | 112 |
| 태국 | 191 | 1669 | 199 |

**대한민국 재외공관 긴급연락**: 외교부 해외안전여행 앱

### 해외 병원 이용 절차
1. 여행자 보험 보험사에 먼저 전화
2. 보험사 제휴 병원 안내 받거나 최가까운 병원 방문
3. **"Travel Insurance" 보험 있음** 명확히 말하기
4. 진단서·처방전·영수증 **영문** 발급 요청
5. 귀국 후 보험사 앱/홈페이지에서 청구 (30~90일 이내)

### 여행자 보험 청구 필수 서류
- 진단서 (영문)
- 의료비 영수증 (영문)
- 처방전 (영문)
- 여권 사본, 탑승권

### 약이 없을 때
- 구글번역 카메라로 약국 간판 찾기
- "Do you have fever reducer?" (해열제 영어 표현)
- "이부프로펜/파라세타몰" - 세계 공통 성분명

### 분실·도난 시
1. 경찰서 분실 신고 (폴리스 리포트 수령 - 보험 청구 필요)
2. 여권 분실: 주재국 한국 대사관 연락 → 임시여권 발급
3. 신용카드 분실: 즉시 정지 (카드사 긴급 번호 국제전화)""",
    },

    {
        "persona": "travel",
        "q": "항공편 지연 결항 대처 방법 보상 환불 권리",
        "a": """## 항공편 지연·결항 완전 대처 가이드

### 지연·결항 시 즉시 할 일
1. 항공사 카운터 방문 또는 앱·전화로 상황 확인
2. **새로운 항공편 재배정** 요청 (당일 출발 최우선)
3. **식사 쿠폰** 요청 (일정 시간 이상 지연 시 제공 의무)
4. **숙박·교통** 지원 요청 (당일 탑승 불가 시)

### 보상 기준 (EU 규정 EC261/2004 — 유럽 노선)
| 지연 시간 | 비행 거리 | 보상금 |
|---------|---------|------|
| 2시간 이상 | 1,500km 이하 | 250유로 |
| 3시간 이상 | 1,500~3,500km | 400유로 |
| 4시간 이상 | 3,500km 초과 | 600유로 |

→ 유럽 출발/도착 노선 모두 적용

### 한국 규정 (항공교통 이용자 보호기준)
- 2시간 이상 지연: 대체 편 또는 여정 시 적절한 음식·음료 제공
- 출발·도착지 변경 불가피 시: 환불 요구 가능

### 보상 청구 방법
1. 항공사 고객센터 서면 요청 (이메일 권장 — 기록 남김)
2. 한국 소비자원 1372 신고
3. 여행자 보험 청구 (항공지연 특약 가입 시)

### 항공 지연 보험 청구
- 3~4시간 이상 지연 → 여행자 보험 지연 특약 청구 가능
- 필요 서류: 탑승권, 지연 확인서 (항공사 발급)

### 환불 규정
- 취소/결항: 전액 환불 의무 (수수료 없음)
- 자발적 취소: 항공사 약관 따름 (LCC 환불 불가 다수)""",
    },

    {
        "persona": "travel",
        "q": "겨울 여행지 추천 눈꽃 스키 온천 국내 해외 12월 1월",
        "a": """## 겨울 여행지 추천 (12~2월)

### 국내 겨울 명소

**눈꽃·스키**
- **대관령·평창**: 선자령 눈꽃 트레킹 (대중교통 접근), 하이원·알펜시아 스키
- **태백 두타산·함백산**: 눈꽃 명소, 오전 이른 시간 방문
- **강원 스키장**: 용평·하이원·비발디파크 (주말 리프트 7~10만원)

**온천**
- **충청 도고·덕산 온천** (서울 2시간, 당일치기)
- **경기 이천 사우나 온천거리**
- **강원 속초·양양 해수탕**

---

### 해외 겨울 여행지

**따뜻한 나라** (한국 겨울 = 동남아 여행 성수기)
- 태국·발리·필리핀: 12~2월 건기 최적
- 베트남 호치민: 우기 끝, 더위 완화
- 몰디브: 여름 모두 좋지만 1~4월 최적

**눈·겨울 즐기기**
- 일본 홋카이도: 삿포로 눈축제 (2월), 스키 니세코
- 유럽 크리스마스 마켓: 독일·오스트리아·체코 (11~12월)
- 핀란드 라플란드: 오로라·산타마을 (12~2월)

### 12월~1월 예산 팁
- 동남아 성수기 → 항공·숙박 1.5~2배 상승
- 얼리버드 예약: 9~10월에 미리 예약
- 일본 크리스마스·연말: 일본인도 성수기 (빠른 예약 필수)""",
    },

    {
        "persona": "travel",
        "q": "신혼여행 허니문 추천 패키지 자유여행 비교",
        "a": """## 신혼여행 완전 가이드

### 패키지 vs 자유여행 비교
| 항목 | 패키지 | 자유여행 |
|------|--------|---------|
| 비용 | 2인 300~700만원 | 2인 300~600만원 |
| 편리함 | 모두 준비됨 | 직접 준비 |
| 자유도 | 낮음 | 높음 |
| 호텔 등급 | 5성급 협약 가능 | 선택 자유 |
| 허니문 서비스 | 꽃·케이크 포함 | 별도 요청 필요 |

**초보 커플**: 패키지 추천 / 여행 경험 있는 커플: 자유여행

### 인기 허니문 여행지

**로맨틱 고급 리조트**
- 몰디브: 수상방갈로, 세계 최고 투명도 (350~600만원/4박5일)
- 발리 우붓 풀빌라: 아침이 황홀한 프라이빗 (200~350만원)
- 하와이 마우이: 미국 허니문 1위 (400~700만원)

**문화·역사 함께**
- 이탈리아 (로마+아말피): 웨딩 분위기 (350~600만원)
- 터키 카파도키아 열기구 (200~350만원)

**가성비 허니문**
- 발리 꾸따+스미냑: 2인 150~250만원
- 베트남 다낭+호이안: 150~230만원
- 오키나와 리조트: 200~300만원

### 꿀팁
- 허니문 서비스: 예약 시 허니문 명시 → 꽃·케이크·업그레이드 가능
- 여행사 허니문 할인: 웨딩 계약 제출 시 5~15% 할인
- 최적 시기: 비수기 선택 시 30~40% 저렴""",
    },

    {
        "persona": "travel",
        "q": "여행 중 스마트폰 분실 도난 여권 분실 대처",
        "a": """## 여행 중 분실·도난 완전 대처 가이드

### 스마트폰 분실 시

**즉시 행동**
1. **구글 계정 → 기기 찾기** (Android) / **iCloud → 나의 찾기** (아이폰)
   - 위치 추적 + 원격 잠금 + 데이터 삭제
2. 통신사에 연락 → SIM 잠금·정지
3. 카카오뱅크·토스·인터넷뱅킹: 다른 기기에서 즉시 로그인 후 공인인증 이동
4. 경찰서에 분실 신고 (리포트 수령 — 보험 청구 시 필요)

**예방법**
- 여행 전 중요 파일 클라우드 백업
- 여권·항공권 사진 찍어 이메일로 전송
- 잠금 패스워드 활성화

---

### 여권 분실 시 (가장 중요!)

**즉시 행동**
1. 가까운 경찰서 → 분실 신고서(Police Report) 수령
2. 주재국 **한국 대사관·영사관** 연락
   - 외교부 영사콜센터: **+82-2-3210-0404** (24시간)
3. 여권 재발급 or **긴급여권(여행증명서)** 신청
   - 여행증명서: 1~2영업일 발급, 귀국 후 정식 재발급

**준비 서류**
- 여권 분실 신고서 (경찰서)
- 여권 사본 또는 여권번호 (출발 전 사진 찍어 이메일 저장!)
- 증명사진 2매

---

### 지갑·카드 분실 시
1. 카드사 즉시 정지 (비상 연락처 미리 저장)
   - 삼성카드 해외: +82-2-2000-8100
   - 신한카드 해외: +82-1544-7000
2. 해외 현금 송금: 웨스턴유니온·머니그램 (가족이 송금)
3. 카카오톡으로 가족에게 연락 후 트래블월렛 등 재충전 방법 협의""",
    },

]
