"""개발자·여행 지식베이스 보완 — Python 패키징·인증·비동기·타입힌트·Linux·JS 및 여행 10개 주제"""

DEV_GAP_KNOWLEDGE = [

    # ══════════════════════════════════════════════
    #  1. Python 패키지 관리
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "Python 패키지 관리 pip poetry uv requirements 패키지 매니저 비교",
        "a": """## Python 패키지 관리 도구 비교 가이드

### 도구별 특징 비교
| 도구 | 속도 | 의존성 잠금 | 가상환경 | 특징 |
|------|------|------------|---------|------|
| **pip** | 보통 | requirements.txt | 별도 필요 | 기본 표준 도구 |
| **pip + pip-tools** | 보통 | requirements.in/txt | 별도 필요 | 정확한 잠금 파일 |
| **Poetry** | 보통 | pyproject.toml + poetry.lock | 내장 | 올인원, 배포까지 지원 |
| **uv** | 매우 빠름 | pyproject.toml + uv.lock | 내장 | Rust 기반, 최신 권장 |
| **conda** | 느림 | environment.yml | 내장 | 데이터사이언스 특화 |

### pip 기본 사용법
```bash
pip install requests                  # 패키지 설치
pip install "requests>=2.28,<3.0"    # 버전 범위 지정
pip install -r requirements.txt       # 파일에서 일괄 설치
pip freeze > requirements.txt         # 현재 환경 저장
pip list --outdated                   # 업데이트 가능 패키지 확인
pip install --upgrade requests        # 업그레이드
```

### Poetry 사용법
```bash
# 설치
curl -sSL https://install.python-poetry.org | python3 -

# 프로젝트 초기화
poetry new myproject
cd myproject

# 패키지 추가
poetry add requests
poetry add --dev pytest black ruff    # 개발용 의존성

# 환경 활성화
poetry shell

# 의존성 설치 (poetry.lock 기반 재현 가능)
poetry install --no-dev               # 운영 환경
```

### uv 사용법 (최신 권장)
```bash
# 설치
pip install uv
# 또는
curl -LsSf https://astral.sh/uv/install.sh | sh

# 프로젝트 초기화
uv init myproject
cd myproject

# 패키지 추가
uv add requests
uv add --dev pytest ruff

# 실행
uv run python main.py
uv run pytest

# 가상환경 직접 사용
uv venv
source .venv/bin/activate
```

### requirements.txt 모범 사례
```
# requirements.txt (운영용)
fastapi==0.111.0
uvicorn[standard]==0.30.1
sqlalchemy==2.0.31

# requirements-dev.txt (개발용)
-r requirements.txt
pytest==8.2.2
ruff==0.5.0
mypy==1.10.0
```

### 권장 선택 기준
- **소규모/단순 프로젝트**: pip + requirements.txt
- **중간 규모 팀 프로젝트**: Poetry
- **속도 최우선/최신 프로젝트**: uv
- **데이터사이언스**: conda 또는 uv + conda 혼합""",
    },

    # ══════════════════════════════════════════════
    #  2. Python 가상환경
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "Python 가상환경 venv conda 사용법 virtualenv 환경 분리",
        "a": """## Python 가상환경 완전 가이드

### 가상환경이 필요한 이유
- 프로젝트마다 다른 패키지 버전 사용 가능
- 시스템 Python 환경 오염 방지
- 재현 가능한 개발 환경 보장

### venv (Python 표준 내장)
```bash
# 가상환경 생성
python3 -m venv .venv           # .venv 폴더에 생성 (권장 이름)
python3 -m venv venv            # venv 폴더

# 활성화
source .venv/bin/activate       # macOS/Linux
.venv\\Scripts\\activate         # Windows cmd
.venv\\Scripts\\Activate.ps1    # Windows PowerShell

# 비활성화
deactivate

# 확인
which python                    # 가상환경 python 경로 출력
pip list                        # 설치된 패키지 확인
```

### virtualenv (venv 확장판)
```bash
pip install virtualenv
virtualenv .venv --python=python3.11   # 특정 버전 지정 가능
```

### conda 가상환경
```bash
# conda 설치: Miniconda 권장 (miniforge3)
# https://github.com/conda-forge/miniforge

# 환경 생성
conda create -n myproject python=3.11
conda create -n myproject python=3.11 numpy pandas  # 패키지 함께 설치

# 환경 활성화/비활성화
conda activate myproject
conda deactivate

# 환경 목록
conda env list

# 환경 삭제
conda env remove -n myproject

# 환경 내보내기/복원
conda env export > environment.yml
conda env create -f environment.yml
```

### pyenv (Python 버전 관리)
```bash
# 설치 (Linux/macOS)
curl https://pyenv.run | bash

# Python 버전 설치
pyenv install 3.11.9
pyenv install 3.12.4

# 전역/로컬 버전 설정
pyenv global 3.12.4
pyenv local 3.11.9     # .python-version 파일 생성

# 설치된 버전 목록
pyenv versions
```

### uv로 가상환경 관리 (최신)
```bash
uv venv                          # .venv 생성
uv venv --python 3.11            # 특정 버전 지정
source .venv/bin/activate
uv pip install requests          # uv pip으로 설치
```

### .gitignore에 반드시 추가
```
.venv/
venv/
__pycache__/
*.pyc
.python-version
```

### IDE 설정 (VS Code)
```json
// .vscode/settings.json
{
    "python.defaultInterpreterPath": ".venv/bin/python",
    "python.terminal.activateEnvironment": true
}
```""",
    },

    # ══════════════════════════════════════════════
    #  3. 코드 품질 도구
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "코드 품질 linting mypy ruff black pre-commit 코드 포매터 정적 분석",
        "a": """## Python 코드 품질 도구 완전 가이드

### 도구 역할 분류
| 도구 | 역할 | 특징 |
|------|------|------|
| **ruff** | 린터 + 포매터 | Rust 기반, 매우 빠름, black 대체 가능 |
| **black** | 포매터 | 오피니언 강함, 설정 최소 |
| **isort** | import 정렬 | ruff에 통합됨 |
| **mypy** | 타입 체커 | 정적 타입 검사 |
| **pylint** | 종합 린터 | 상세하지만 느림 |
| **pre-commit** | Git 훅 관리 | 커밋 전 자동 실행 |

### ruff 설정 및 사용법
```bash
pip install ruff

# 검사
ruff check .
ruff check . --fix          # 자동 수정

# 포맷
ruff format .
ruff format . --check       # 변경 없이 확인만
```

```toml
# pyproject.toml
[tool.ruff]
line-length = 88
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "W", "I", "N", "UP", "B"]
ignore = ["E501"]  # 라인 길이는 포매터에게

[tool.ruff.format]
quote-style = "double"
indent-style = "space"
```

### mypy 설정 및 사용법
```bash
pip install mypy

mypy src/                   # 폴더 전체 검사
mypy main.py --strict       # 엄격 모드
```

```toml
# pyproject.toml
[tool.mypy]
python_version = "3.11"
strict = true
ignore_missing_imports = true
```

### pre-commit 설정
```bash
pip install pre-commit
```

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.5.0
    hooks:
      - id: ruff
        args: [--fix]
      - id: ruff-format

  - repo: https://github.com/pre-commit/mirrors-mypy
    rev: v1.10.0
    hooks:
      - id: mypy
        additional_dependencies: [types-requests]

  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-added-large-files
```

```bash
# pre-commit 설치 및 실행
pre-commit install          # Git 훅에 등록
pre-commit run --all-files  # 전체 파일 검사
pre-commit autoupdate       # 훅 버전 업데이트
```

### GitHub Actions CI/CD 통합
```yaml
# .github/workflows/lint.yml
name: Lint
on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v2
      - run: uv run ruff check .
      - run: uv run ruff format --check .
      - run: uv run mypy src/
```

### VS Code 통합 설정
```json
{
    "[python]": {
        "editor.defaultFormatter": "charliermarsh.ruff",
        "editor.formatOnSave": true,
        "editor.codeActionsOnSave": {
            "source.fixAll.ruff": "explicit",
            "source.organizeImports.ruff": "explicit"
        }
    }
}
```""",
    },

    # ══════════════════════════════════════════════
    #  4. OAuth2 JWT 인증
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "OAuth2 JWT 인증 구현 FastAPI 토큰 인증 로그인 보안",
        "a": """## FastAPI OAuth2 + JWT 인증 구현 가이드

### 필요 패키지
```bash
pip install fastapi python-jose[cryptography] passlib[bcrypt] python-multipart
```

### JWT 토큰 유틸리티
```python
# auth.py
from datetime import datetime, timedelta, timezone
from typing import Optional
from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

SECRET_KEY = "your-secret-key-min-32-chars"  # 실제 운영: 환경변수 사용
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token")

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode["exp"] = expire
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

async def get_current_user(token: str = Depends(oauth2_scheme)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="인증 정보를 확인할 수 없습니다",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    user = get_user_by_id(user_id)
    if user is None:
        raise credentials_exception
    return user
```

### 라우터 구현
```python
from fastapi import APIRouter, Depends
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel

router = APIRouter(prefix="/auth", tags=["인증"])

class Token(BaseModel):
    access_token: str
    token_type: str

@router.post("/token", response_model=Token)
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    user = authenticate_user(form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="이메일 또는 비밀번호가 올바르지 않습니다",
        )
    access_token = create_access_token(data={"sub": str(user.id)})
    return {"access_token": access_token, "token_type": "bearer"}

@router.get("/me")
async def read_users_me(current_user = Depends(get_current_user)):
    return current_user
```

### 보호된 엔드포인트 사용
```python
@app.get("/protected")
async def protected_route(current_user = Depends(get_current_user)):
    return {"message": f"안녕하세요, {current_user.name}님"}
```

### 보안 주의사항
- SECRET_KEY는 반드시 **환경변수**로 관리 (.env)
- 토큰 만료 시간 짧게 설정 (30분 이내)
- HTTPS 필수 사용
- Refresh Token은 DB에 저장하여 무효화 가능하게 관리
- bcrypt rounds: 기본 12 (성능과 보안 균형)""",
    },

    # ══════════════════════════════════════════════
    #  5. WebSocket
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "WebSocket 실시간 통신 FastAPI Python 채팅 실시간 알림 구현",
        "a": """## FastAPI WebSocket 실시간 통신 구현

### 기본 WebSocket 엔드포인트
```python
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from typing import List

app = FastAPI()

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def send_personal_message(self, message: str, websocket: WebSocket):
        await websocket.send_text(message)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            await connection.send_text(message)

manager = ConnectionManager()

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            await manager.send_personal_message(f"You: {data}", websocket)
            await manager.broadcast(f"Client #{client_id}: {data}")
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        await manager.broadcast(f"Client #{client_id} 접속 종료")
```

### JSON 메시지 처리
```python
from pydantic import BaseModel

class ChatMessage(BaseModel):
    type: str      # "message", "join", "leave"
    user: str
    content: str

@app.websocket("/ws/chat")
async def chat_websocket(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            raw = await websocket.receive_text()
            msg = ChatMessage.model_validate_json(raw)
            await manager.broadcast(msg.model_dump_json())
    except WebSocketDisconnect:
        pass
```

### 클라이언트 (JavaScript)
```javascript
const ws = new WebSocket("ws://localhost:8000/ws/user1");

ws.onopen = () => {
    ws.send(JSON.stringify({type: "join", user: "user1", content: "입장"}));
};

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    console.log(`${msg.user}: ${msg.content}`);
};

ws.onerror = (err) => console.error("WebSocket 오류:", err);
ws.onclose = () => console.log("WebSocket 연결 종료");

function sendMessage(text) {
    ws.send(JSON.stringify({type: "message", user: "user1", content: text}));
}
```

### 인증된 WebSocket
```python
from fastapi import Query

@app.websocket("/ws/secure")
async def secure_ws(websocket: WebSocket, token: str = Query(...)):
    try:
        user = verify_token(token)
    except Exception:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    # 이후 처리
```

### 스케일 아웃 (Redis Pub/Sub)
여러 서버 인스턴스 간 메시지 공유가 필요하면 Redis Pub/Sub을 브로커로 사용:
```bash
pip install aioredis
```
```python
import aioredis
redis = await aioredis.create_redis("redis://localhost")
await redis.publish("chat_channel", message)
```""",
    },

    # ══════════════════════════════════════════════
    #  6. Celery Redis 비동기 작업
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "Celery Redis 비동기 작업 큐 백그라운드 태스크 Python 이메일 전송",
        "a": """## Celery + Redis 백그라운드 작업 큐 구현

### 설치
```bash
pip install celery redis "celery[redis]" flower
```

### Celery 설정
```python
# celery_config.py
from celery import Celery

def make_celery(app_name: str) -> Celery:
    celery = Celery(
        app_name,
        broker="redis://localhost:6379/0",
        backend="redis://localhost:6379/1",
    )
    celery.conf.update(
        task_serializer="json",
        accept_content=["json"],
        result_serializer="json",
        timezone="Asia/Seoul",
        enable_utc=True,
        task_track_started=True,
        task_acks_late=True,
        worker_prefetch_multiplier=1,
    )
    return celery

celery_app = make_celery("myapp")
```

### 작업(Task) 정의
```python
# tasks.py
from celery_config import celery_app

@celery_app.task(bind=True, max_retries=3)
def send_email(self, to: str, subject: str, body: str):
    try:
        # 실제 이메일 발송 로직
        return {"status": "sent", "to": to}
    except Exception as exc:
        raise self.retry(exc=exc, countdown=2 ** self.request.retries)

@celery_app.task
def process_large_file(file_path: str):
    return {"processed": file_path}

# 주기적 작업
from celery.schedules import crontab

celery_app.conf.beat_schedule = {
    "daily-report": {
        "task": "tasks.generate_daily_report",
        "schedule": crontab(hour=9, minute=0),
    },
}
```

### FastAPI에서 Celery 작업 호출
```python
from fastapi import FastAPI
from tasks import send_email

app = FastAPI()

@app.post("/send-email")
async def trigger_email(to: str, subject: str, body: str):
    task = send_email.delay(to, subject, body)
    return {"task_id": task.id, "status": "queued"}

@app.get("/task/{task_id}")
async def get_task_status(task_id: str):
    from celery.result import AsyncResult
    result = AsyncResult(task_id)
    return {
        "task_id": task_id,
        "status": result.status,
        "result": result.result if result.ready() else None,
    }
```

### 워커 실행
```bash
celery -A celery_config.celery_app worker --loglevel=info
celery -A celery_config.celery_app beat --loglevel=info
celery -A celery_config.celery_app flower --port=5555
# http://localhost:5555 에서 실시간 모니터링
```

### Docker Compose 구성
```yaml
services:
  redis:
    image: redis:7-alpine
  worker:
    build: .
    command: celery -A celery_config.celery_app worker -l info
    depends_on: [redis]
  beat:
    build: .
    command: celery -A celery_config.celery_app beat -l info
    depends_on: [redis]
```""",
    },

    # ══════════════════════════════════════════════
    #  7. Python 로깅
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "Python 로깅 설정 logging structlog 로그 관리 운영 환경",
        "a": """## Python 로깅(Logging) 완전 가이드

### 기본 logging 모듈
```python
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

logger = logging.getLogger(__name__)

logger.debug("디버그 메시지")
logger.info("정보 메시지")
logger.warning("경고 메시지")
logger.error("오류 메시지")
logger.critical("치명적 오류")
```

### 파일 + 콘솔 동시 출력
```python
import logging
from logging.handlers import RotatingFileHandler

def setup_logging(log_level: str = "INFO"):
    logger = logging.getLogger()
    logger.setLevel(log_level)

    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)-8s] %(name)s:%(lineno)d - %(message)s"
    )

    # 콘솔 핸들러
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    logger.addHandler(console)

    # 파일 핸들러 (최대 10MB, 5개 백업)
    file_handler = RotatingFileHandler(
        "app.log", maxBytes=10_000_000, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

setup_logging()
```

### FastAPI 요청 로깅 미들웨어
```python
import logging
import sys
import time
from fastapi import FastAPI, Request

app = FastAPI()
logging.basicConfig(stream=sys.stdout, level=logging.INFO)
logger = logging.getLogger("app")

@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    elapsed = time.time() - start
    logger.info(
        f"{request.method} {request.url.path} "
        f"status={response.status_code} "
        f"elapsed={elapsed:.3f}s"
    )
    return response
```

### structlog (구조화 로깅 — 운영 권장)
```bash
pip install structlog
```

```python
import structlog

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.stdlib.add_log_level,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.JSONRenderer(),  # ELK/Loki 수집에 유리
    ],
)

logger = structlog.get_logger()

logger.info("user_login", user_id=123, ip="192.168.1.1")
logger.error("db_error", query="SELECT ...", error="connection timeout")
```

### 로그 레벨 가이드
| 레벨 | 언제 사용 |
|------|---------|
| DEBUG | 개발 시 상세 디버깅 정보 |
| INFO | 정상 동작 기록 (요청, 응답 등) |
| WARNING | 예상치 못한 상황 (계속 동작 가능) |
| ERROR | 기능 오류 (일부 기능 실패) |
| CRITICAL | 시스템 중단 수준 심각한 오류 |

### 민감 정보 로깅 금지
- 비밀번호, API 키, 토큰은 절대 로그에 기록하지 않음
- 개인정보(주민번호, 카드번호) 마스킹 처리
- 이메일 일부 마스킹 예시: `email[:3] + "***@" + domain`""",
    },

    # ══════════════════════════════════════════════
    #  8. API 문서화
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "API 문서화 Swagger OpenAPI Pydantic FastAPI 자동 문서 생성",
        "a": """## FastAPI API 문서화 완전 가이드

### FastAPI 자동 문서 (기본 내장)
FastAPI는 OpenAPI 3.0 스펙을 자동 생성합니다.
- **Swagger UI**: `http://localhost:8000/docs`
- **ReDoc**: `http://localhost:8000/redoc`
- **OpenAPI JSON**: `http://localhost:8000/openapi.json`

### 문서 메타데이터 설정
```python
from fastapi import FastAPI

app = FastAPI(
    title="My API",
    description="## API 설명\\n\\n사용자 관리와 콘텐츠 서비스를 제공합니다.",
    version="1.0.0",
    contact={"name": "개발팀", "email": "dev@example.com"},
    license_info={"name": "MIT"},
    openapi_tags=[
        {"name": "users", "description": "사용자 관련 API"},
        {"name": "posts", "description": "게시물 관련 API"},
    ],
)
```

### Pydantic 모델로 스키마 문서화
```python
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime

class UserCreate(BaseModel):
    email: str = Field(..., example="user@example.com", description="사용자 이메일")
    password: str = Field(..., min_length=8, description="비밀번호 (8자 이상)")
    name: str = Field(..., max_length=50, description="이름")

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "email": "hong@example.com",
                    "password": "securepass123",
                    "name": "홍길동",
                }
            ]
        }
    }

class UserResponse(BaseModel):
    id: int
    email: str
    name: str
    created_at: datetime

    model_config = {"from_attributes": True}
```

### 엔드포인트 문서화
```python
from fastapi import APIRouter, status

router = APIRouter(prefix="/users", tags=["users"])

@router.post(
    "/",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
    summary="사용자 생성",
    description="새로운 사용자를 생성합니다. 이메일은 고유해야 합니다.",
    response_description="생성된 사용자 정보",
    responses={
        400: {"description": "잘못된 요청 데이터"},
        409: {"description": "이미 사용 중인 이메일"},
    },
)
async def create_user(user: UserCreate):
    \"\"\"
    새 사용자를 생성합니다.

    - **email**: 유니크한 이메일 주소
    - **password**: 최소 8자 이상
    - **name**: 표시 이름
    \"\"\"
    ...
```

### 운영 환경에서 문서 비활성화
```python
import os

app = FastAPI(
    docs_url="/docs" if os.getenv("ENV") != "production" else None,
    redoc_url="/redoc" if os.getenv("ENV") != "production" else None,
)
```

### 응답 스키마 커스터마이즈
```python
from fastapi.responses import JSONResponse
from pydantic import BaseModel

class ErrorResponse(BaseModel):
    detail: str
    code: str

@app.exception_handler(ValueError)
async def value_error_handler(request, exc):
    return JSONResponse(
        status_code=400,
        content={"detail": str(exc), "code": "VALIDATION_ERROR"},
    )
```""",
    },

    # ══════════════════════════════════════════════
    #  9. 환경변수 설정
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "환경변수 설정 .env dotenv 배포 환경 설정 관리 FastAPI pydantic-settings",
        "a": """## 환경변수 & .env 설정 관리 완전 가이드

### 기본 원칙 (12 Factor App)
- 설정은 코드에서 분리하여 환경변수로 관리
- 개발/스테이징/운영 환경별로 다른 값 사용
- `.env` 파일은 **절대 Git에 커밋하지 않음**

### python-dotenv 기본 사용법
```bash
pip install python-dotenv
```

```python
# .env 파일
DATABASE_URL=postgresql://user:password@localhost/mydb
SECRET_KEY=super-secret-key-here
DEBUG=true
API_KEY=sk-xxx

# main.py
from dotenv import load_dotenv
import os

load_dotenv()

db_url = os.getenv("DATABASE_URL")
secret = os.getenv("SECRET_KEY", "default-fallback")
debug = os.getenv("DEBUG", "false").lower() == "true"
```

### pydantic-settings (FastAPI 권장)
```bash
pip install pydantic-settings
```

```python
# config.py
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import SecretStr
from functools import lru_cache

class Settings(BaseSettings):
    app_name: str = "My API"
    debug: bool = False
    database_url: str
    secret_key: SecretStr
    access_token_expire_minutes: int = 30
    groq_api_key: SecretStr = ""
    redis_url: str = "redis://localhost:6379"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

@lru_cache()
def get_settings() -> Settings:
    return Settings()

settings = get_settings()
print(settings.database_url)
print(settings.secret_key.get_secret_value())
```

### FastAPI DI와 통합
```python
from fastapi import Depends

@app.get("/info")
async def info(settings: Settings = Depends(get_settings)):
    return {"app": settings.app_name, "debug": settings.debug}
```

### 환경별 .env 파일 관리
```
.env                    # 기본값 (Git 제외)
.env.example            # 예시 파일 (Git 포함, 실제값 X)
.env.development        # 개발 환경
.env.production         # 운영 환경 (서버에서만 관리)
```

### .gitignore 설정
```
.env
.env.*
!.env.example
```

### 운영 환경 환경변수 주입 방법
```bash
# Linux 서버
export SECRET_KEY="production-key"
export DATABASE_URL="postgresql://..."

# Docker
docker run -e SECRET_KEY=xxx -e DATABASE_URL=yyy myapp

# Docker Compose
services:
  app:
    env_file: .env.production

# Render/Railway/Heroku: 대시보드에서 직접 설정
```

### 비밀값 시작 시 검증
```python
@app.on_event("startup")
async def validate_settings():
    settings = get_settings()
    if settings.debug and "production" in str(settings.database_url):
        raise ValueError("운영 DB에 debug 모드 사용 금지!")
```""",
    },

    # ══════════════════════════════════════════════
    #  10. Python 성능 최적화
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "Python 성능 최적화 프로파일링 cProfile 병목 찾기 속도 개선",
        "a": """## Python 성능 최적화 & 프로파일링 가이드

### 1단계: 병목 찾기 (프로파일링)

#### cProfile (표준 라이브러리)
```python
import cProfile
import pstats

# 명령줄 실행
# python -m cProfile -s cumulative myscript.py

# 코드에서 사용
profiler = cProfile.Profile()
profiler.enable()
result = my_slow_function()
profiler.disable()
stats = pstats.Stats(profiler)
stats.sort_stats("cumulative")
stats.print_stats(20)  # 상위 20개 함수
```

#### line_profiler (라인별 분석)
```bash
pip install line-profiler
# kernprof -l -v myscript.py
```

#### memory_profiler
```bash
pip install memory-profiler
python -m memory_profiler myscript.py
```

### 2단계: 최적화 기법

#### 리스트 컴프리헨션 & 제너레이터
```python
# 느림
result = []
for i in range(1000000):
    result.append(i * 2)

# 빠름 (약 2배)
result = [i * 2 for i in range(1000000)]

# 메모리 절약 (제너레이터)
result = (i * 2 for i in range(1000000))
```

#### 올바른 자료구조 선택
```python
# 멤버십 검사: set이 list보다 O(1) vs O(n)
data_set = {1, 2, 3, ...}
print(999 in data_set)  # O(1)

# dict.get() vs try/except
value = my_dict.get("key", default)
```

#### 문자열 연결
```python
# 느림 (O(n²))
result = ""
for s in strings:
    result += s

# 빠름 (O(n))
result = "".join(strings)
```

#### 캐싱 (functools.lru_cache)
```python
from functools import lru_cache

@lru_cache(maxsize=128)
def fibonacci(n: int) -> int:
    if n < 2:
        return n
    return fibonacci(n-1) + fibonacci(n-2)
```

#### 비동기 I/O
```python
import asyncio
import aiohttp

async def fetch(session, url):
    async with session.get(url) as resp:
        return await resp.text()

async def fetch_all(urls):
    async with aiohttp.ClientSession() as session:
        tasks = [fetch(session, url) for url in urls]
        return await asyncio.gather(*tasks)

results = asyncio.run(fetch_all(urls))
```

#### NumPy 활용 (수치 연산)
```python
import numpy as np

# 순수 Python: 10초
total = sum(x**2 for x in range(10_000_000))

# NumPy: 0.05초
arr = np.arange(10_000_000)
total = np.sum(arr**2)
```

### 빠른 점검 체크리스트
- [ ] 루프 안 DB 쿼리 없는지 (N+1 문제)
- [ ] 반복 계산 결과 캐싱 여부
- [ ] 리스트 vs 제너레이터 적절히 사용
- [ ] 문자열 연결 시 join() 사용
- [ ] I/O 작업 비동기 처리""",
    },

    # ══════════════════════════════════════════════
    #  11. 프로젝트 구조
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "모노레포 프로젝트 구조 패키지 설계 Python 프로젝트 폴더 구조 아키텍처",
        "a": """## Python 프로젝트 구조 모범 사례

### FastAPI 프로젝트 표준 구조
```
api/
├── app/
│   ├── __init__.py
│   ├── main.py               # FastAPI 앱 생성, 미들웨어, 라우터 등록
│   ├── config.py             # 환경변수 설정 (pydantic-settings)
│   ├── database.py           # DB 연결, 세션 관리
│   ├── models/               # SQLAlchemy ORM 모델
│   │   └── user.py
│   ├── schemas/              # Pydantic 요청/응답 스키마
│   │   └── user.py
│   ├── crud/                 # DB CRUD 함수
│   │   └── user.py
│   ├── api/                  # 라우터
│   │   └── v1/
│   │       ├── auth.py
│   │       └── users.py
│   ├── core/                 # 공통 유틸리티
│   │   ├── security.py
│   │   └── exceptions.py
│   └── services/             # 비즈니스 로직
│       └── email.py
├── tests/
│   ├── conftest.py
│   ├── unit/
│   └── integration/
├── alembic/                  # DB 마이그레이션
├── .env
├── .env.example
├── pyproject.toml
├── Dockerfile
└── docker-compose.yml
```

### 레이어 아키텍처 원칙
```
라우터(Router) → 서비스(Service) → CRUD → DB
     |               |
  스키마          비즈니스 로직

- 라우터: HTTP 요청/응답만 처리
- 서비스: 비즈니스 로직 (여러 CRUD 조합)
- CRUD: DB 접근만 담당
```

### pyproject.toml 표준 설정
```toml
[project]
name = "myapp"
version = "0.1.0"
description = "My FastAPI Application"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.111.0",
    "uvicorn[standard]>=0.30.0",
    "pydantic-settings>=2.0.0",
    "sqlalchemy>=2.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.23.0",
    "ruff>=0.5.0",
    "mypy>=1.10.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
```

### main.py 기본 구조
```python
from fastapi import FastAPI
from app.config import get_settings
from app.api.v1 import auth, users
from app.database import init_db

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    docs_url="/docs" if not settings.debug else "/docs",
)

app.include_router(auth.router)
app.include_router(users.router)

@app.on_event("startup")
async def startup():
    await init_db()

@app.get("/health")
async def health():
    return {"status": "ok"}
```""",
    },

    # ══════════════════════════════════════════════
    #  12. Pydantic v2 데이터 검증
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "데이터 검증 Pydantic v2 모델 validators 필드 검증 FastAPI",
        "a": """## Pydantic v2 데이터 검증 완전 가이드

### 기본 모델
```python
from pydantic import BaseModel, Field, EmailStr
from typing import Optional, List
from datetime import datetime

class UserCreate(BaseModel):
    email: EmailStr                           # 이메일 형식 자동 검증
    password: str = Field(min_length=8, max_length=100)
    age: int = Field(ge=0, le=150)           # 0 <= age <= 150
    name: str = Field(min_length=1, max_length=50)
    bio: Optional[str] = None
    tags: List[str] = []
```

### 커스텀 필드 검증 (field_validator)
```python
from pydantic import field_validator
import re

class UserCreate(BaseModel):
    email: str
    password: str
    phone: Optional[str] = None

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        v = v.lower().strip()
        if not re.match(r"^[^@]+@[^@]+\\.[^@]+$", v):
            raise ValueError("올바른 이메일 형식이 아닙니다")
        return v

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if not any(c.isupper() for c in v):
            raise ValueError("비밀번호에 대문자가 하나 이상 포함되어야 합니다")
        if not any(c.isdigit() for c in v):
            raise ValueError("비밀번호에 숫자가 하나 이상 포함되어야 합니다")
        return v
```

### 모델 전체 검증 (model_validator)
```python
from pydantic import model_validator

class PasswordChange(BaseModel):
    new_password: str
    confirm_password: str

    @model_validator(mode="after")
    def passwords_match(self) -> "PasswordChange":
        if self.new_password != self.confirm_password:
            raise ValueError("비밀번호와 확인 비밀번호가 일치하지 않습니다")
        return self
```

### 중첩 모델 및 응답 모델
```python
class Address(BaseModel):
    street: str
    city: str
    country: str = "KR"

class UserResponse(BaseModel):
    id: int
    email: str
    name: str
    address: Optional[Address] = None
    created_at: datetime

    model_config = {
        "from_attributes": True,    # ORM 객체 변환
        "json_encoders": {datetime: lambda v: v.isoformat()},
    }
```

### 직렬화/역직렬화
```python
user = UserCreate(email="test@test.com", password="Password1", name="홍길동", age=30)

data = user.model_dump()
data_no_none = user.model_dump(exclude_none=True)
json_str = user.model_dump_json()

user2 = UserCreate.model_validate(data)
user3 = UserCreate.model_validate_json(json_str)
```

### FastAPI에서 응답 직렬화
```python
@app.post("/users", response_model=UserResponse)
async def create_user(user: UserCreate, db: Session = Depends(get_db)):
    db_user = User(**user.model_dump())
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    return db_user  # ORM -> UserResponse 자동 변환
```""",
    },

    # ══════════════════════════════════════════════
    #  13. Python 고급 타입 힌트
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "Python 타입 힌트 고급 Union Optional Protocol TypeVar Generic 타입 어노테이션",
        "a": """## Python 고급 타입 힌트 완전 가이드

### 기본 타입 (Python 3.10+ 권장 문법)
```python
from typing import Optional, Union, Any

def greet(name: str) -> str: ...
def add(a: int, b: int) -> int: ...
def maybe_int(x: int | None) -> None: ...   # Optional[int] 대신
def either(x: int | str) -> None: ...       # Union[int, str] 대신
```

### 컬렉션 타입 (Python 3.9+)
```python
def process(items: list[str]) -> dict[str, int]: ...
def coords() -> tuple[float, float, float]: ...
def tags(names: set[str]) -> None: ...
def variadic() -> tuple[int, ...]: ...  # 가변 길이 튜플

# TypedDict (딕셔너리 구조 명세)
from typing import TypedDict

class Config(TypedDict):
    host: str
    port: int
    debug: bool
```

### Callable과 함수 타입
```python
from typing import Callable

def apply(func: Callable[[int, int], int], a: int, b: int) -> int:
    return func(a, b)

def execute(func: Callable[..., None]) -> None:
    func()
```

### TypeVar와 제네릭
```python
from typing import TypeVar, Generic

T = TypeVar("T")

def first(items: list[T]) -> T:
    return items[0]

class Stack(Generic[T]):
    def __init__(self) -> None:
        self._items: list[T] = []

    def push(self, item: T) -> None:
        self._items.append(item)

    def pop(self) -> T:
        return self._items.pop()

stack: Stack[int] = Stack()
```

### Protocol (덕 타이핑 공식화)
```python
from typing import Protocol, runtime_checkable

@runtime_checkable
class Drawable(Protocol):
    def draw(self) -> None: ...
    def resize(self, factor: float) -> None: ...

# Circle이 Drawable을 상속하지 않아도
# draw()와 resize()를 구현하면 Drawable로 간주
class Circle:
    def draw(self) -> None:
        print("O")
    def resize(self, factor: float) -> None:
        pass

def render(shape: Drawable) -> None:
    shape.draw()
```

### Literal 타입
```python
from typing import Literal

Direction = Literal["north", "south", "east", "west"]
Status = Literal["active", "inactive", "pending"]

def move(direction: Direction) -> None: ...
def set_status(status: Status) -> None: ...
```

### TypeAlias와 NewType
```python
from typing import TypeAlias, NewType

Vector: TypeAlias = list[float]

UserId = NewType("UserId", int)
OrderId = NewType("OrderId", int)

uid = UserId(42)
# mypy: uid와 OrderId는 서로 다른 타입으로 취급
```

### ParamSpec (데코레이터 타입 보존)
```python
from typing import ParamSpec, Callable, TypeVar
import functools

P = ParamSpec("P")
T = TypeVar("T")

def log_call(func: Callable[P, T]) -> Callable[P, T]:
    @functools.wraps(func)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> T:
        print(f"Calling {func.__name__}")
        return func(*args, **kwargs)
    return wrapper
```""",
    },

    # ══════════════════════════════════════════════
    #  14. Linux 서버 기초
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "Linux 서버 기초 shell 명령어 cron ssh 파일 권한 프로세스 관리 개발자",
        "a": """## 개발자를 위한 Linux 서버 기초

### 필수 파일/디렉토리 명령어
```bash
# 탐색
ls -la                      # 숨김파일 포함 상세 목록
ls -lh                      # 파일 크기 읽기 쉽게
pwd                         # 현재 경로
find . -name "*.py"         # 파일 검색
find . -name "*.log" -mtime -1  # 1일 이내 수정된 파일

# 파일 조작
cp -r src/ dest/            # 폴더 복사
mv old.txt new.txt          # 이동/이름 변경
rm -rf ./temp/              # 폴더 강제 삭제 (주의!)
mkdir -p a/b/c              # 중간 폴더 자동 생성

# 내용 확인
less file.txt               # 페이지 단위 보기 (q 종료)
tail -f app.log             # 실시간 로그 모니터링
grep -r "ERROR" ./logs/     # 재귀 검색
grep -n "def " main.py      # 라인 번호 표시
```

### 파일 권한
```bash
# 권한 형식: rwxrwxrwx (소유자/그룹/기타)
chmod 755 script.sh         # rwxr-xr-x
chmod 644 config.txt        # rw-r--r--
chmod +x deploy.sh          # 실행 권한 추가
chown user:group file.txt   # 소유자/그룹 변경
chmod 600 ~/.ssh/id_rsa     # SSH 키 권한 (필수)
```

### SSH 연결
```bash
# 기본 연결
ssh username@192.168.1.100
ssh -p 2222 user@server.com

# SSH 키 생성 및 등록
ssh-keygen -t ed25519 -C "my@email.com"
ssh-copy-id user@server.com

# SSH config (~/.ssh/config)
Host myserver
    HostName 192.168.1.100
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519
    Port 22

ssh myserver  # 위 설정으로 간단히 접속

# 원격 파일 전송
scp local.txt user@server:/remote/path/
rsync -avz ./src/ user@server:/app/src/
```

### 프로세스 관리
```bash
ps aux | grep python        # Python 프로세스 검색
kill -9 PID                 # 강제 종료
pkill -f "uvicorn"          # 이름으로 종료

# 백그라운드 실행
nohup uvicorn app:app --port 8000 > app.log 2>&1 &

# 포트 확인
ss -tlnp | grep 8000
lsof -i :8000
```

### cron (스케줄 작업)
```bash
crontab -e   # cron 편집
crontab -l   # 목록 확인

# 형식: 분 시 일 월 요일 명령어
0 9 * * * /usr/bin/python3 /app/daily_report.py   # 매일 오전 9시
*/5 * * * * curl http://localhost:8000/health      # 매 5분
0 0 * * 1 /app/weekly_backup.sh                   # 매주 월요일
0 9 * * * /app/job.sh >> /var/log/myjob.log 2>&1  # 로그 저장
```

### systemd 서비스 등록
```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My FastAPI App
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/app
ExecStart=/app/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
```
```bash
systemctl enable myapp    # 부팅 시 자동 시작
systemctl start myapp
systemctl status myapp
journalctl -u myapp -f    # 실시간 로그
```""",
    },

    # ══════════════════════════════════════════════
    #  15. JavaScript ES6+ 모던 문법
    # ══════════════════════════════════════════════
    {
        "persona": "dev",
        "q": "JavaScript ES6 모던 문법 화살표함수 구조분해 async await 스프레드 템플릿리터럴",
        "a": """## JavaScript ES6+ 모던 문법 핵심 가이드

### 변수 선언 (let, const)
```javascript
const name = "홍길동";        // 재할당 불가
let count = 0;               // 재할당 가능
const user = { name: "홍길동" };
user.name = "김철수";         // const 객체 내부 변경은 가능
```

### 화살표 함수
```javascript
const add = (a, b) => a + b;
const square = n => n * n;
const greet = () => "안녕하세요";

// this 바인딩: 화살표함수는 상위 스코프의 this 사용
class Timer {
    constructor() { this.count = 0; }
    start() {
        setInterval(() => {
            this.count++;  // Timer 인스턴스의 this
        }, 1000);
    }
}
```

### 구조분해 할당 (Destructuring)
```javascript
// 배열
const [first, second, ...rest] = [1, 2, 3, 4, 5];
const [a, , c] = [1, 2, 3];  // 중간 건너뜀

// 객체
const { name, age, address: { city } } = user;
const { name: userName, role = "user" } = user;  // 이름 변경 + 기본값

// 함수 매개변수
function display({ name, age = 0 }) {
    console.log(`${name}, ${age}세`);
}
```

### 스프레드 / 나머지 연산자
```javascript
const merged = [...arr1, ...arr2, 0];
const updated = { ...original, name: "새이름" };
const shallow = { ...obj };

function sum(...numbers) {
    return numbers.reduce((acc, n) => acc + n, 0);
}
```

### 템플릿 리터럴
```javascript
const name = "홍길동";
const age = 30;
const msg = `이름: ${name}, 나이: ${age}세`;
const multiline = `
    첫 번째 줄
    두 번째 줄
`;
```

### 비동기 처리 (async/await)
```javascript
async function getUsers() {
    try {
        const res = await fetch("/api/users");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        console.error("요청 실패:", err);
        throw err;
    }
}

// 병렬 실행
const [users, posts] = await Promise.all([
    fetch("/api/users").then(r => r.json()),
    fetch("/api/posts").then(r => r.json()),
]);
```

### Optional Chaining & Nullish Coalescing
```javascript
const city = user?.address?.city;       // undefined (오류 없음)
const name = user.name ?? "익명";       // null/undefined일 때만 기본값
const port = config.port ?? 3000;

// || 와의 차이
const val = 0 || "default";            // "default" (0은 falsy)
const val2 = 0 ?? "default";           // 0 (null/undefined가 아님)
```

### 배열 고차 함수
```javascript
const numbers = [1, 2, 3, 4, 5];

numbers.map(n => n * 2);               // [2, 4, 6, 8, 10]
numbers.filter(n => n % 2 === 0);     // [2, 4]
numbers.reduce((acc, n) => acc + n, 0); // 15
numbers.find(n => n > 3);             // 4
numbers.every(n => n > 0);            // true
numbers.some(n => n > 4);             // true
numbers.flatMap(n => [n, n * 2]);     // [1,2, 2,4, 3,6, ...]
```

### 객체 단축 문법
```javascript
const x = 10, y = 20;
const point = { x, y };               // { x: 10, y: 20 }

const key = "dynamic";
const obj = { [key]: "value" };       // { dynamic: "value" }

const api = {
    async fetchUser(id) { ... },      // function 키워드 생략
};
```""",
    },

]


TRAVEL_GAP_KNOWLEDGE = [

    # ══════════════════════════════════════════════
    #  1. 호주 여행
    # ══════════════════════════════════════════════
    {
        "persona": "travel",
        "q": "호주 시드니 멜버른 골드코스트 여행 코스 비용 일정",
        "a": """## 호주 여행 완전 가이드 (시드니·멜버른·골드코스트)

### 기본 정보
| 항목 | 내용 |
|------|------|
| 비자 | ETA(전자여행허가) — 앱에서 간편 신청, $20 AUD |
| 통화 | 호주 달러(AUD), 1AUD 약 880원 |
| 비행 | 인천↔시드니 약 10~11시간 직항 |
| 시차 | 시드니 +2시간(서머타임 +3) |
| 여행 적기 | 9~11월 봄, 3~5월 가을 (여름 12~2월은 매우 더움) |

### 추천 코스 (14박 15일)
**시드니 5박**
- 오페라하우스, 하버브리지 클라이밍
- 본다이 비치 서핑 체험
- 블루마운틴 당일치기 (기차 2시간)
- 달링하버 해산물 저녁

**골드코스트 3박**
- 서퍼스 파라다이스 비치
- 씨월드·무비월드 테마파크
- 래밍턴 국립공원 열대우림

**멜버른 4박**
- 그레이트오션로드 투어 (12사도 바위)
- 야라밸리 와이너리 투어
- CBD 커피 탐방 (세계 3대 커피 도시)
- 피츠로이 거리 예술 골목

### 예상 비용 (1인, 14박 15일)
| 항목 | 비용 |
|------|------|
| 항공 | 100~170만원 (왕복) |
| 숙박 | 120~200만원 (3성급 기준) |
| 식비 | 60~100만원 (1일 5~8만원) |
| 교통 | 20~40만원 |
| 관광·입장료 | 30~60만원 |
| **합계** | **330~570만원** |

### 주의사항
- 호주 입국 시 음식물·식물 반입 매우 엄격 (라면도 신고 대상)
- 오팔카드(교통카드) 시드니 도착 즉시 구매 추천
- 레스토랑 팁 문화: 선택사항이나 10~15% 관행""",
    },

    # ══════════════════════════════════════════════
    #  2. 두바이 아부다비
    # ══════════════════════════════════════════════
    {
        "persona": "travel",
        "q": "두바이 아부다비 여행 가이드 아랍에미리트 UAE 관광 일정",
        "a": """## 두바이 & 아부다비 여행 완전 가이드

### 기본 정보
| 항목 | 내용 |
|------|------|
| 비자 | 무비자 30일 (한국 여권 소지자) |
| 통화 | AED(디르함), 1AED 약 370원 |
| 비행 | 인천↔두바이 약 9~10시간 직항 (에미레이트·에티하드) |
| 시차 | -5시간 (한국 대비) |
| 여행 적기 | 10~4월 (5~9월은 낮 최고 45°C 폭염) |
| 복장 | 공공장소 노출 금지 — 어깨·무릎 가리기 |

### 두바이 필수 명소
- **버즈칼리파** (세계 최고층, 124층 전망대 예약 필수)
- **두바이 몰** — 수족관, 아이스링크, 폭포
- **두바이 크릭** — 전통 목선 아부라 탑승, 골드수크·스파이스수크
- **팜주메이라** — 아틀란티스 호텔, 아쿠아벤처
- **두바이 프레임** — 구시가지와 신시가지를 잇는 150m 건물
- **사막 사파리** — 모래언덕 4WD, 낙타 탑승, 베두인 캠프 석식

### 아부다비 당일/1박 투어
- **셰이크 자이드 그랜드 모스크** (세계 3대 모스크, 무료 입장)
- **루브르 아부다비** — 세계 최초 루브르 분관
- **야스 아일랜드** — 페라리 월드, 워너 브라더스, F1 경주장

### 예상 비용 (1인, 7박 8일)
| 항목 | 비용 |
|------|------|
| 항공 | 80~150만원 (왕복) |
| 숙박 | 80~150만원 |
| 식비 | 30~60만원 |
| 관광 | 20~40만원 |
| **합계** | **210~400만원** |

### 실용 팁
- 라마단 기간 공공장소 음식·음료 섭취 금지
- 주류: 허가된 호텔 바·레스토랑에서만 가능
- 인터넷: VoIP 앱(카카오톡 통화·줌 등) 현지에서 차단됨
- 금요일이 주간 휴일 (쇼핑몰 목~금 오후가 가장 혼잡)""",
    },

    # ══════════════════════════════════════════════
    #  3. 터키 여행
    # ══════════════════════════════════════════════
    {
        "persona": "travel",
        "q": "터키 이스탄불 카파도키아 여행 코스 비용 일정 터키 여행",
        "a": """## 터키 여행 완전 가이드 (이스탄불·카파도키아·에게해)

### 기본 정보
| 항목 | 내용 |
|------|------|
| 비자 | 무비자 90일 (한국 여권) |
| 통화 | TRY(터키리라), 물가 저렴 |
| 비행 | 인천↔이스탄불 약 11~12시간 직항 (터키항공) |
| 시차 | -6시간 (한국 대비) |
| 여행 적기 | 4~6월, 9~11월 (7~8월 매우 더움) |

### 추천 코스 (10박 11일)
**이스탄불 4박**
- 아야소피아 (비잔틴·이슬람 역사 공존)
- 블루모스크 (술탄아흐메트 자미)
- 톱카프 궁전 (오스만 제국 유물)
- 그랜드 바자르 쇼핑 (4,400개 상점)
- 갈라타 타워, 보스포러스 유람선 크루즈

**카파도키아 3박**
- **열기구 투어** (새벽 5시 출발 — 여행 하이라이트)
  - 비용: 180~300달러/인, 예약 3개월 전 필수
- 괴레메 야외박물관 (유네스코)
- 지하도시 데린쿠유
- ATV 사파리, 말 투어

**파묵칼레·에페소 2박**
- 파묵칼레 하얀 석회온천 테라스
- 히에라폴리스 고대 로마 유적
- 에페소 (고대 그리스·로마 도시)

### 예상 비용 (1인, 10박 11일)
| 항목 | 비용 |
|------|------|
| 항공 | 90~160만원 (왕복) |
| 숙박 | 50~100만원 |
| 식비 | 20~40만원 (매우 저렴) |
| 관광·입장료 | 20~40만원 |
| 이동 (국내선) | 15~30만원 |
| **합계** | **195~370만원** |

### 실용 팁
- 이스탄불 카드(교통카드) 첫날 구매
- 차이(터키 홍차)와 터키 커피 무조건 경험
- 환전: 현지 환전소가 은행보다 유리
- 카펫 가게 호객 주의 — 구매 압박 강함
- 수돗물 마시면 안 됨 — 생수 구입 필수""",
    },

    # ══════════════════════════════════════════════
    #  4. 크로아티아 두브로브니크
    # ══════════════════════════════════════════════
    {
        "persona": "travel",
        "q": "크로아티아 두브로브니크 유럽 소도시 여행 코스 플리트비체",
        "a": """## 크로아티아 여행 완전 가이드

### 기본 정보
| 항목 | 내용 |
|------|------|
| 비자 | 무비자 90일 (솅겐 협정 적용) |
| 통화 | 유로(EUR) 2023년부터 유로존 가입 |
| 비행 | 직항 없음 — 프랑크푸르트·이스탄불·두바이 경유 |
| 여행 적기 | 5~6월, 9~10월 (7~8월 성수기 인파·가격 급등) |

### 추천 코스 (7박 8일)
**자그레브 1박** (수도)
- 반 옐라치치 광장, 성 마르코 성당, 돌락 시장

**플리트비체 국립공원 1박**
- 유네스코 세계자연유산
- 에메랄드빛 폭포·호수 트레킹 (4~6시간)
- 성수기 예약 필수 (입장 시간 지정)

**스플리트 2박**
- 디오클레티아누스 궁전 (도시 전체가 궁전 안에)
- 페리로 흐바르 섬 당일치기

**두브로브니크 2박**
- **성벽 트레킹** (구시가지 성벽 2km 도보, 아드리아해 전경)
- 케이블카로 슬로라드 산 전망
- 로클룸 섬 보트 여행
- 게임 오브 스론즈 촬영지 투어

### 예상 비용 (1인, 7박 8일)
| 항목 | 비용 |
|------|------|
| 항공 | 130~200만원 (경유 왕복) |
| 숙박 | 70~150만원 |
| 식비 | 40~70만원 |
| 관광·이동 | 30~60만원 |
| **합계** | **270~480만원** |

### 주의사항
- 두브로브니크: 성수기 예약 3~6개월 전 필수
- 해안 고속도로 렌터카 여행도 추천 (아드리아해 절경)
- 아드리아해 수영 가능 (맑고 투명한 물)""",
    },

    # ══════════════════════════════════════════════
    #  5. 동유럽 프라하·부다페스트
    # ══════════════════════════════════════════════
    {
        "persona": "travel",
        "q": "체코 프라하 헝가리 부다페스트 동유럽 여행 코스 비용",
        "a": """## 동유럽 여행 완전 가이드 (프라하·빈·부다페스트)

### 기본 정보
| 항목 | 내용 |
|------|------|
| 비자 | 무비자 90일 (솅겐) |
| 통화 | 체코 코루나(CZK), 헝가리 포린트(HUF), 오스트리아 유로 |
| 비행 | 직항 없음 — 프랑크푸르트·뮌헨·헬싱키 경유 |
| 여행 적기 | 4~6월, 9~10월 (12월 크리스마스 마켓도 인기) |

### 추천 코스 (9박 10일)
**프라하 3박** (체코)
- 프라하 성 & 황금 소로
- 카를교 석상 산책 (새벽이 가장 아름다움)
- 구시가지 광장 & 천문시계
- 근교: 체스키크룸로프 당일치기 (동화 같은 중세 마을)

**빈 2박** (오스트리아)
- 쇤브룬 궁전 (합스부르크 왕가)
- 링 대로 (오페라하우스, 미술사박물관)
- 커피하우스 문화 체험
- 프라하→빈: 기차 4시간

**부다페스트 3박** (헝가리)
- 어부의 요새 (야경 최고)
- 국회의사당 (도나우강 야경)
- 세체니 온천 (100년 전통 노천 온천)
- 루인 바 파티 (유럽 배낭여행자 집합소)
- 빈→부다페스트: 기차 2시간 30분

### 예상 비용 (1인, 9박 10일)
| 항목 | 비용 |
|------|------|
| 항공 | 120~180만원 (경유 왕복) |
| 숙박 | 60~120만원 (체코·헝가리 저렴) |
| 식비 | 30~60만원 |
| 이동·기차 | 15~30만원 |
| 관광 | 20~40만원 |
| **합계** | **245~430만원** |

### 실용 팁
- 유레일 패스 vs 개별 기차 구매: 3개국 이상이면 패스 유리
- 프라하·부다페스트: 현금(코루나·포린트) 지참 필수
- 부다페스트 온천은 수영복 지참
- 소매치기 주의 (구시가지, 지하철)
- 크리스마스 마켓 (11~12월): 뱅쇼(따뜻한 포도주) 필수 경험""",
    },

    # ══════════════════════════════════════════════
    #  6. 해외여행 중 응급상황
    # ══════════════════════════════════════════════
    {
        "persona": "travel",
        "q": "해외여행 중 응급상황 아프면 어떻게 병원 해외 의료 보험 대처",
        "a": """## 해외여행 중 의료 응급상황 완전 대처 가이드

### 출발 전 필수 준비
1. **여행자 보험 가입** (출발 전 반드시!)
   - 의료비 최소 $100,000 이상 보장 플랜 선택
   - 현지 병원 직접 청구(Direct Billing) 가능 보험사 확인
2. **상비약 준비**: 소화제, 지사제, 해열진통제, 밴드
3. **긴급 연락처 저장**
   - 외교부 영사콜센터: +82-2-3210-0404 (24시간)
   - 보험사 해외긴급 콜센터 번호
   - 한국 대사관 번호

### 증상별 대처

#### 경미한 증상 (감기, 복통, 두통)
1. 숙소 근처 약국(Pharmacy) 방문
2. 증상을 번역 앱으로 영어로 표현
3. 약 구매하여 복용

#### 중간 증상 (고열, 심한 설사, 알레르기)
1. 호텔 프론트에 병원 안내 요청
2. **여행자 보험 콜센터** 연락 → 제휴 병원 안내
3. 제휴 병원 방문 시 보험증서 제시 → 직접청구 가능

#### 응급 상황 (골절, 의식 불명, 심한 통증)
1. **즉시 현지 119/응급번호 호출**
   - 미국: 911 | 유럽: 112 | 일본: 119 | 중국: 120
2. 동행자 또는 호텔 직원에게 도움 요청
3. 병원 도착 후 보험사에 연락

### 의료비 청구 방법
```
현지 병원 방문
    → 진료비 영수증 + 진단서(영문) 수령 (원본)
    → 처방전·약 영수증 보관
    → 귀국 후 30~90일 이내 보험사 청구
```

### 현지 언어로 증상 전달
```
"I need a doctor" — 의사가 필요합니다
"I have a fever" — 열이 납니다
"I have severe stomach pain" — 복통이 심합니다
"I'm allergic to ___" — ___에 알레르기가 있습니다
"Call an ambulance" — 구급차를 불러주세요
```

### 나라별 의료 수준
| 지역 | 의료 수준 | 주의사항 |
|------|---------|---------|
| 서유럽·북미 | 매우 우수 | 비용 매우 높음 |
| 일본 | 우수 | 언어 장벽 있음 |
| 동남아 | 도시 우수 | 외곽 지역 취약 |
| 동유럽 | 보통 | 시설 노후 가능 |""",
    },

    # ══════════════════════════════════════════════
    #  7. 항공편 지연·결항 대처
    # ══════════════════════════════════════════════
    {
        "persona": "travel",
        "q": "항공편 지연 결항 대처 방법 보상 환불 마일리지 여행자 보험",
        "a": """## 항공편 지연·결항 대처 완전 가이드

### 항공사 의무 (EU 규정 EC 261/2004 기준)

#### 지연 보상 기준
| 지연 시간 | 항공사 의무 |
|---------|----------|
| 2시간 이상 | 식사·음료 제공 의무 |
| 3시간 이상 | 숙박 + 교통 제공 의무 (당일 출발 불가 시) |
| 3시간+ (취소) | **보상금** 지급 의무 |

#### EU 출발 또는 EU 항공사 이용 시 보상금
| 거리 | 보상금 |
|------|--------|
| 1,500km 이하 | 유로 250 |
| 1,500~3,500km | 유로 400 |
| 3,500km 초과 | 유로 600 |

### 즉시 해야 할 것
1. 항공사 카운터 또는 앱에서 상황 확인
2. 지연/취소 사유 서면 확인서 요청
3. 식사 쿠폰, 숙박 바우처 요청
4. 대체 항공편 안내 요청

### 환불 요청 방법
- 항공사 앱/웹사이트 → 내 예약 → 환불 신청
- 항공사 귀책: 전액 환불 + 보상
- 기상·천재지변: 환불 가능, 보상금 없음
- 자발적 취소: 규정에 따라 수수료 공제

### 여행자 보험 청구
- 일반적으로 3~4시간 이상 지연 시 정액 지급
- 필요 서류: 항공사 발행 지연 확인서 + 추가 식비/숙박 영수증

### 탑승 거부(오버부킹) 대처
- 자발적 탑승 포기: 항공사와 협상 (마일리지 + 대체편 + 보상)
- 비자발적 거부: **보상금 + 대체 항공편 + 필요시 숙박** 의무 청구

### 수하물 분실·파손 대처
1. 수하물 찾는 곳 직원에게 즉시 신고
2. **PIR(Property Irregularity Report)** 작성 필수
3. 72시간 이내 미해결 시 보상 협상
4. 여행자보험 + 항공사 양쪽 청구 가능

### 유용한 앱
- **Flightradar24**: 실시간 항공편 추적
- **AirHelp**: EU 보상금 청구 대행 서비스""",
    },

    # ══════════════════════════════════════════════
    #  8. 겨울 여행지 추천
    # ══════════════════════════════════════════════
    {
        "persona": "travel",
        "q": "겨울 여행지 추천 눈꽃 스키 온천 국내외 12월 1월 2월",
        "a": """## 겨울 여행지 추천 (국내외)

### 국내 겨울 여행

#### 강원도 (눈꽃·스키)
- **스키장**: 용평, 하이원, 오크밸리, 비발디파크
  - 리프트권 평일 5~7만원, 주말 8~10만원
- **평창 대관령**: 삼양목장 설원, 양떼목장 눈꽃 축제
- **정선 레일바이크**: 겨울 설경 속 페달바이크

#### 제주도 (겨울 비수기 저렴)
- 비수기라 숙박·항공 가장 저렴 (12~2월)
- 한라산 눈꽃 등반 (일출 코스)
- 협재 비치 한적한 겨울 바다
- 카멜리아힐 동백꽃 (12~2월 절정)

#### 온천 여행
- **동래·해운대 온천**: 부산 여행 + 온천
- **수안보 온천**: 충청도 탄산온천

### 해외 겨울 여행

#### 일본 (겨울 최강 추천)
| 지역 | 특징 |
|------|------|
| **홋카이도 삿포로** | 눈 축제(2월), 노보리베츠 지옥 온천 |
| **니세코** | 세계 최고 수준 파우더 스노우 스키 |
| **아오모리** | 설국 풍경, 네부타 축제 |
| **교토·도쿄** | 연말연시 분위기, 후지산 눈꽃 뷰 |

#### 유럽 크리스마스 마켓 (11월 말~12월)
- **체코 프라하**: 구시가지 광장 마켓
- **독일 뮌헨·뉘른베르크**: 글뤼바인(뱅쇼), 진저브레드
- **오스트리아 빈**: 쇤브룬 궁전 앞 마켓

#### 동남아 (따뜻한 겨울 도피)
- **태국 치앙마이**: 12~2월 건기, 최적의 날씨
- **베트남 다낭·호이안**: 한국인 최다 방문 겨울 여행지
- **발리**: 11~4월 건기 시즌

### 겨울 여행 준비 체크리스트
- 핫팩 20~30개 (스키장·야외 필수)
- 미끄럼 방지 등산화 또는 아이젠
- 방수·방풍 아우터
- 여행자 보험 (스키 특약 포함)""",
    },

    # ══════════════════════════════════════════════
    #  9. 신혼여행
    # ══════════════════════════════════════════════
    {
        "persona": "travel",
        "q": "신혼여행 허니문 추천 여행지 패키지 vs 자유여행 예산 준비",
        "a": """## 신혼여행 완전 가이드

### 신혼여행 인기 여행지 TOP
| 순위 | 여행지 | 특징 | 예산 범위 |
|------|--------|------|---------|
| 1 | **몰디브** | 수상방갈로, 프라이빗 비치 | 500~1500만원 |
| 2 | **유럽 (파리·산토리니)** | 낭만, 문화 | 400~800만원 |
| 3 | **하와이** | 자연·액티비티 | 400~700만원 |
| 4 | **발리** | 가성비+럭셔리, 풀빌라 | 200~400만원 |
| 5 | **일본 (교토·오키나와)** | 가깝고 편리 | 150~300만원 |

### 패키지 vs 자유여행 비교
| 구분 | 패키지 | 자유여행 |
|------|--------|---------|
| 가격 | 일반적으로 저렴 | 다양 |
| 자유도 | 낮음 (일정 고정) | 높음 |
| 준비 부담 | 적음 | 많음 |
| 신혼 어메니티 | 자동 제공 | 직접 요청 필요 |
| 추천 상황 | 몰디브·복잡한 유럽 | 일본·발리·하와이 |

### 예산 계획
- **200~350만원**: 발리 풀빌라, 오키나와, 홋카이도
- **350~600만원**: 하와이, 호주 동부, 지중해
- **600만원 이상**: 몰디브 수상방갈로, 유럽 주요 도시 투어

### 신혼여행 체크리스트
**예약 (3~6개월 전)**
- 항공편 예약 시 "Honeymoon" 메모 입력 (업그레이드 기회)
- 호텔/리조트 허니문 패키지 요청 (꽃 장식, 케이크, 업그레이드)
- 여행자 보험 가입
- 레스토랑 예약 시 허니문 알리기 (디저트 서비스)

**여권·서류**
- 여권 유효기간 6개월 이상 확인
- 국제운전면허증 (렌터카 예정 시)
- 신용카드 해외 결제 한도 상향
- 비상 현금 300~500달러""",
    },

    # ══════════════════════════════════════════════
    #  10. 여행 중 스마트폰 분실·도난
    # ══════════════════════════════════════════════
    {
        "persona": "travel",
        "q": "여행 중 스마트폰 분실 도난 대처 방법 여권 분실 해외 도난",
        "a": """## 해외여행 중 스마트폰·여권 분실·도난 대처 가이드

### 스마트폰 분실·도난 즉시 대처

#### 1단계: 위치 추적 (분실 직후)
- **아이폰**: iCloud.com → "나의 iPhone 찾기" → 위치 확인·원격 잠금
- **안드로이드**: findmydevice.google.com → 위치 확인·화면 잠금

#### 2단계: 원격 잠금 (즉시!)
- iCloud: 분실 모드 활성화 → 연락처 표시 메시지 설정
- Google: 기기 잠금 → 새 PIN 설정 → 분실 메시지 표시

#### 3단계: 통신사 정지
- SKT: 080-011-6000 | KT: 1588-0010 | LGU+: 1544-0010

#### 4단계: 금융 앱 처리
- 모바일 뱅킹, 카카오페이·네이버페이 즉시 비활성화

### 여권 분실·도난 대처

#### 1단계: 현지 경찰서 신고
- **폴리스 리포트(Police Report)** 발급 필수 (여권 재발급·보험 청구 필수 서류)

#### 2단계: 한국 대사관/영사관 방문
- 외교부 영사콜센터: **+82-2-3210-0404** (24시간)
- 현지 대사관 연락처: 외교부 앱 또는 www.0404.go.kr
- 지참 서류: 폴리스 리포트, 여권용 사진 2매, 신분증 사본

#### 3단계: 긴급 여권 발급
- **여행증명서** (귀국용, 1~2일 소요)
- **일반 여권 재발급** (4~7일 소요)

### 여행자 보험 청구
| 항목 | 보상 조건 |
|------|---------|
| 휴대품 손해 | 경찰 신고 + 손해 입증 |
| 여행 지연 손해 | 항공·숙박 추가 비용 |

필요 서류: 경찰신고확인서(원본) + 구매 영수증

### 예방 팁
- 여권 앞면 사진 스캔 → 클라우드 저장 (구글포토, 이메일)
- 카드 번호·긴급 연락처 메모 → 스마트폰과 별도 보관
- 소매치기 다발 지역: 뒷주머니 금지, 가방 앞으로 착용
- 유럽 소매치기 패턴: 지도 요청·종이 제시 + 협공 주의
- 잠금 화면에 비상 연락처 영문 설정""",
    },

]
