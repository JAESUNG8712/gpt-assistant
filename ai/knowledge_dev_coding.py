"""코드 개발자 전용 지식베이스 — 개발환경 설치, FastAPI, SQLite, TF-IDF, LLM API 연동 등"""

DEV_CODING_KNOWLEDGE = [

    # ══════════════════════════════════════════════
    #  개발환경 설치
    # ══════════════════════════════════════════════

    {
        "persona": "dev",
        "q": "Python 설치 방법 파이썬 설치 pip venv 가상환경 설정",
        "a": """## Python 설치 및 가상환경 설정

### Windows
```bash
# 1. python.org에서 Python 3.11+ 다운로드 후 설치
#    설치 시 "Add Python to PATH" 반드시 체크

# 2. 설치 확인
python --version
pip --version

# 3. 가상환경 생성 및 활성화
python -m venv venv
venv\\Scripts\\activate      # Windows
```

### macOS / Linux
```bash
# macOS: Homebrew 사용
brew install python@3.11

# Ubuntu/Debian
sudo apt update && sudo apt install python3 python3-pip python3-venv

# 가상환경 생성 및 활성화
python3 -m venv venv
source venv/bin/activate    # macOS/Linux

# 비활성화
deactivate
```

### pip 패키지 관리
```bash
pip install fastapi uvicorn          # 패키지 설치
pip install -r requirements.txt      # 목록에서 일괄 설치
pip freeze > requirements.txt        # 현재 환경을 목록으로 저장
pip list                             # 설치된 패키지 확인
pip uninstall 패키지명               # 삭제
```

### 이번 프로젝트 requirements.txt
```
fastapi==0.115.0
uvicorn[standard]==0.30.0
httpx==0.27.0
python-dotenv==1.0.0
pydantic==2.7.0
python-multipart==0.0.9
```
""",
    },

    {
        "persona": "dev",
        "q": "Node.js npm 설치 방법 JavaScript 환경 nvm 버전 관리",
        "a": """## Node.js / npm 설치

### 공식 설치 (LTS 권장)
```bash
# nodejs.org에서 LTS 버전 다운로드

# 설치 확인
node --version    # v20.x.x
npm --version     # 10.x.x
```

### nvm으로 버전 관리 (권장)
```bash
# macOS/Linux
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc   # 또는 ~/.zshrc

nvm install 20     # Node.js 20 LTS 설치
nvm use 20         # 활성화
nvm ls             # 설치된 버전 목록

# Windows: nvm-windows 사용
# https://github.com/coreybutler/nvm-windows
```

### npx / npm 기본 사용
```bash
npm init -y                      # package.json 생성
npm install express              # 패키지 설치
npm install -D nodemon           # 개발 의존성
npm run dev                      # package.json scripts 실행
npx create-react-app my-app      # 일회성 실행
```
""",
    },

    {
        "persona": "dev",
        "q": "Git 설치 기본 명령어 브랜치 커밋 푸시 클론 GitHub 사용법",
        "a": """## Git 기본 설치 및 명령어

### 설치
```bash
# macOS
brew install git

# Ubuntu
sudo apt install git

# Windows: git-scm.com 다운로드
```

### 초기 설정
```bash
git config --global user.name "홍길동"
git config --global user.email "hong@example.com"
git config --global core.editor "code --wait"   # VS Code를 기본 에디터로
```

### 일상 워크플로우
```bash
# 저장소 클론
git clone https://github.com/user/repo.git
cd repo

# 브랜치 생성 및 이동
git checkout -b feature/새기능
git switch -c feature/새기능   # 최신 방식

# 변경사항 확인
git status
git diff

# 커밋
git add 파일명        # 특정 파일 스테이징
git add .            # 모든 변경사항
git commit -m "feat: 새 기능 추가"

# 원격 저장소 푸시
git push origin feature/새기능
git push -u origin feature/새기능   # upstream 설정

# 최신 변경사항 가져오기
git pull origin main
git fetch origin main

# 로그 확인
git log --oneline --graph
```

### 커밋 메시지 컨벤션 (Conventional Commits)
```
feat: 새 기능
fix: 버그 수정
docs: 문서 수정
refactor: 코드 리팩토링
test: 테스트 추가
chore: 빌드/설정 변경
```
""",
    },

    {
        "persona": "dev",
        "q": "VS Code 설치 필수 확장 프로그램 extension 추천 개발환경 설정",
        "a": """## VS Code 설치 및 필수 확장

### 설치
- code.visualstudio.com 에서 다운로드

### Python 개발 필수 확장
```
Python (ms-python.python)           - Python 언어 지원
Pylance (ms-python.vscode-pylance)  - 타입 체크, 자동완성
Black Formatter                     - 코드 포맷터
Ruff (charliermarsh.ruff)           - 빠른 Python 린터
```

### 웹 개발 필수 확장
```
ESLint                              - JavaScript 린터
Prettier                            - 코드 포맷터
Auto Rename Tag                     - HTML 태그 자동 변경
Live Server                         - 로컬 개발 서버
```

### 유틸리티
```
GitLens                             - Git 히스토리 시각화
GitHub Copilot                      - AI 코드 자동완성
REST Client (.http 파일로 API 테스트)
Thunder Client (Postman 대체 내장)
Docker
Remote - SSH
```

### settings.json 추천 설정
```json
{
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "[python]": {
        "editor.defaultFormatter": "ms-python.black-formatter"
    },
    "editor.tabSize": 4,
    "files.autoSave": "afterDelay",
    "terminal.integrated.defaultProfile.windows": "Git Bash"
}
```
""",
    },

    {
        "persona": "dev",
        "q": "Docker 도커 설치 기본 사용법 컨테이너 이미지 docker-compose",
        "a": """## Docker 설치 및 기본 사용

### 설치
```bash
# Docker Desktop: docker.com 에서 다운로드 (Mac/Windows)
# Linux
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER  # sudo 없이 사용
```

### 기본 명령어
```bash
# 이미지 다운로드 및 실행
docker pull python:3.11-slim
docker run -it python:3.11-slim python

# 컨테이너 관리
docker ps               # 실행 중인 컨테이너
docker ps -a            # 모든 컨테이너
docker stop 컨테이너ID
docker rm 컨테이너ID
docker images           # 이미지 목록
docker rmi 이미지명

# 포트 매핑, 볼륨 마운트
docker run -d -p 8000:8000 -v $(pwd):/app --name myapp myimage
```

### FastAPI 앱을 위한 Dockerfile
```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### docker-compose.yml
```yaml
version: '3.8'
services:
  api:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - ./data:/app/data
    environment:
      - DB_PATH=/app/data/memory.db
      - GROQ_API_KEY=${GROQ_API_KEY}
    restart: unless-stopped
```

```bash
docker-compose up -d      # 백그라운드 실행
docker-compose logs -f    # 로그 보기
docker-compose down       # 중지
```
""",
    },

    # ══════════════════════════════════════════════
    #  FastAPI 구현
    # ══════════════════════════════════════════════

    {
        "persona": "dev",
        "q": "FastAPI 기본 서버 구조 설치 실행 uvicorn GET POST 엔드포인트",
        "a": """## FastAPI 기본 서버 구조

### 설치 및 실행
```bash
pip install fastapi uvicorn[standard]
uvicorn main:app --reload --port 8000
```

### main.py 기본 구조
```python
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

app = FastAPI(title="내 API 서버", version="1.0.0")

# GET 엔드포인트
@app.get("/")
def read_root():
    return {"message": "Hello World"}

@app.get("/items/{item_id}")
def read_item(item_id: int, q: Optional[str] = None):
    return {"item_id": item_id, "query": q}

# POST 엔드포인트
class CreateItemRequest(BaseModel):
    name: str
    price: float
    description: Optional[str] = None

@app.post("/items")
def create_item(item: CreateItemRequest):
    # item.name, item.price 등으로 접근
    return {"created": item.model_dump()}

# 에러 처리
@app.get("/users/{user_id}")
def get_user(user_id: int):
    if user_id == 0:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    return {"user_id": user_id}
```

### 자동 생성 API 문서 확인
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc
""",
    },

    {
        "persona": "dev",
        "q": "FastAPI StreamingResponse 스트리밍 응답 구현 async generator LLM 스트리밍",
        "a": """## FastAPI StreamingResponse 스트리밍 구현

LLM 답변, 파일 다운로드 등 실시간 스트리밍에 사용합니다.

```python
import asyncio
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

app = FastAPI()

# 기본 스트리밍 패턴
async def generate_stream(message: str):
    \"\"\"비동기 제너레이터로 청크 단위 스트리밍\"\"\"
    words = message.split()
    for word in words:
        yield word + " "
        await asyncio.sleep(0.05)  # 타이핑 효과

@app.get("/stream")
async def stream_response(text: str = "Hello World"):
    return StreamingResponse(
        generate_stream(text),
        media_type="text/plain; charset=utf-8"
    )

# POST 방식 (이번 프로젝트 방식)
from pydantic import BaseModel

class ChatRequest(BaseModel):
    message: str

@app.post("/chat")
async def chat(req: ChatRequest):
    async def generate():
        collected = []
        try:
            # LLM API 스트리밍 토큰 yield
            async for token in llm_stream(req.message):
                collected.append(token)
                yield token
            # 완료 후 저장 등 후처리
            full_response = "".join(collected)
            save_to_db(req.message, full_response)
        except Exception as e:
            yield f"\\n⚠️ 오류: {e}"

    return StreamingResponse(
        generate(),
        media_type="text/plain; charset=utf-8"
    )
```

### 프론트엔드에서 스트리밍 읽기 (JavaScript)
```javascript
const response = await fetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '안녕하세요' })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    console.log(chunk);  // 실시간 토큰 처리
}
```
""",
    },

    {
        "persona": "dev",
        "q": "FastAPI 파일 업로드 UploadFile Form 파일 처리 이미지 문서",
        "a": """## FastAPI 파일 업로드 구현

```python
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from typing import Optional

app = FastAPI()

# 단일 파일 업로드
@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    # 파일 내용 읽기
    content = await file.read()

    # 텍스트 파일 디코딩
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        text = content.decode("euc-kr", errors="ignore")

    return {
        "filename": file.filename,
        "content_type": file.content_type,
        "size": len(content),
        "preview": text[:200]
    }

# 파일 + 폼 데이터 함께
@app.post("/upload-with-form")
async def upload_with_form(
    file: UploadFile = File(...),
    category: str = Form(...),
    description: Optional[str] = Form(None)
):
    content = await file.read()
    # 파일 저장
    save_path = f"uploads/{file.filename}"
    with open(save_path, "wb") as f:
        f.write(content)

    return {"saved": save_path, "category": category}

# 여러 파일 동시 업로드
@app.post("/upload-multiple")
async def upload_multiple(files: list[UploadFile] = File(...)):
    results = []
    for file in files:
        content = await file.read()
        results.append({"name": file.filename, "size": len(content)})
    return {"uploaded": results}
```

### 클라이언트에서 파일 전송 (curl)
```bash
curl -X POST http://localhost:8000/upload \\
  -F "file=@/path/to/document.txt"

# 파일 + 폼 데이터
curl -X POST http://localhost:8000/upload-with-form \\
  -F "file=@document.txt" \\
  -F "category=HR문서"
```
""",
    },

    {
        "persona": "dev",
        "q": "FastAPI 미들웨어 CORS 설정 정적파일 마운트 StaticFiles",
        "a": """## FastAPI 미들웨어 및 정적파일

### CORS 설정 (프론트엔드 연동 필수)
```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

app = FastAPI()

# CORS 허용 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # 모든 출처 허용 (개발용)
    # allow_origins=["https://myapp.com"],  # 운영환경: 특정 도메인만
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 정적 파일 마운트 (HTML, CSS, JS, 이미지)
app.mount("/static", StaticFiles(directory="static"), name="static")

# HTML 파일 직접 반환
from fastapi.responses import HTMLResponse
import os

@app.get("/", response_class=HTMLResponse)
def index():
    with open("static/index.html", encoding="utf-8") as f:
        return f.read()
```

### 커스텀 미들웨어 (요청 로깅 등)
```python
import time
from fastapi import Request

@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    process_time = time.time() - start_time
    response.headers["X-Process-Time"] = str(process_time)
    return response
```

### 서버 실행 옵션
```bash
# 개발 (자동 재시작)
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# 운영 (워커 수 조정)
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4
```
""",
    },

    # ══════════════════════════════════════════════
    #  SQLite 구현
    # ══════════════════════════════════════════════

    {
        "persona": "dev",
        "q": "SQLite Python sqlite3 연결 CRUD 테이블 생성 조회 삽입 삭제",
        "a": """## Python SQLite3 기본 사용법

### 연결 및 테이블 생성
```python
import sqlite3
import os
from datetime import datetime

DB_PATH = os.getenv("DB_PATH", "/tmp/app.db")

def _conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row  # dict처럼 컬럼명으로 접근
    return c

def init_db():
    with _conn() as c:
        c.execute(\"\"\"
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                persona TEXT DEFAULT 'default',
                created_at TEXT NOT NULL
            )
        \"\"\")
        # 인덱스 생성 (검색 성능 향상)
        c.execute(\"\"\"
            CREATE INDEX IF NOT EXISTS idx_messages_persona
            ON messages(persona)
        \"\"\")
```

### INSERT (데이터 저장)
```python
def save_message(role: str, content: str, persona: str = "default"):
    with _conn() as c:
        c.execute(
            "INSERT INTO messages (role, content, persona, created_at) VALUES (?,?,?,?)",
            (role, content, persona, datetime.now().isoformat())
        )
```

### SELECT (데이터 조회)
```python
def get_messages(limit: int = 20, persona: str = None) -> list:
    with _conn() as c:
        if persona:
            rows = c.execute(
                "SELECT * FROM messages WHERE persona=? ORDER BY id DESC LIMIT ?",
                (persona, limit)
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT * FROM messages ORDER BY id DESC LIMIT ?",
                (limit,)
            ).fetchall()
    return [dict(r) for r in reversed(rows)]  # dict 변환 후 순서 반전

# 단일 행
def get_message_by_id(msg_id: int):
    with _conn() as c:
        row = c.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    return dict(row) if row else None
```

### UPDATE / DELETE
```python
def update_message(msg_id: int, content: str):
    with _conn() as c:
        c.execute("UPDATE messages SET content=? WHERE id=?", (content, msg_id))

def delete_messages(persona: str = None):
    with _conn() as c:
        if persona:
            c.execute("DELETE FROM messages WHERE persona=?", (persona,))
        else:
            c.execute("DELETE FROM messages")
```
""",
    },

    {
        "persona": "dev",
        "q": "SQLite 트랜잭션 에러 처리 마이그레이션 스키마 변경 컬럼 추가",
        "a": """## SQLite 트랜잭션 및 스키마 관리

### 트랜잭션 처리
```python
import sqlite3

def batch_insert(items: list):
    \"\"\"여러 행을 한 트랜잭션으로 삽입 (빠름)\"\"\"
    with _conn() as c:
        try:
            c.executemany(
                "INSERT INTO items (name, value) VALUES (?,?)",
                [(item['name'], item['value']) for item in items]
            )
            # with 블록 종료 시 자동 COMMIT
        except Exception as e:
            # with 블록 예외 발생 시 자동 ROLLBACK
            print(f"삽입 실패: {e}")
            raise

# 명시적 트랜잭션
def transfer(from_id: int, to_id: int, amount: float):
    conn = _conn()
    try:
        conn.execute("BEGIN")
        conn.execute("UPDATE accounts SET balance=balance-? WHERE id=?", (amount, from_id))
        conn.execute("UPDATE accounts SET balance=balance+? WHERE id=?", (amount, to_id))
        conn.execute("COMMIT")
    except Exception as e:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
```

### 스키마 마이그레이션 (컬럼 추가)
```python
def migrate_db():
    \"\"\"DB 버전 관리 및 마이그레이션\"\"\"
    with _conn() as c:
        # 기존 컬럼 목록 확인
        columns = [row[1] for row in c.execute("PRAGMA table_info(messages)").fetchall()]

        # 새 컬럼이 없으면 추가
        if 'persona' not in columns:
            c.execute("ALTER TABLE messages ADD COLUMN persona TEXT DEFAULT 'default'")
            print("✅ persona 컬럼 추가 완료")

        if 'rating' not in columns:
            c.execute("ALTER TABLE messages ADD COLUMN rating INTEGER DEFAULT 0")
```

### 통계 쿼리
```python
def get_stats() -> dict:
    with _conn() as c:
        total = c.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        by_persona = c.execute(
            "SELECT persona, COUNT(*) as cnt FROM messages GROUP BY persona"
        ).fetchall()
    return {
        "total": total,
        "by_persona": {r['persona']: r['cnt'] for r in by_persona}
    }
```
""",
    },

    # ══════════════════════════════════════════════
    #  TF-IDF 검색 엔진
    # ══════════════════════════════════════════════

    {
        "persona": "dev",
        "q": "TF-IDF 원리 설명 구현 방법 검색 엔진 코사인 유사도 벡터",
        "a": """## TF-IDF 검색 엔진 원리

### TF-IDF란?
- **TF (Term Frequency)**: 문서 내 단어 빈도 → 많이 나올수록 중요
- **IDF (Inverse Document Frequency)**: 전체 문서에서 희귀한 단어일수록 중요
- TF-IDF = TF × IDF → 특정 문서에서 중요하고 희귀한 단어에 높은 점수

### 핵심 수식
```
TF(t, d)  = 단어t의 문서d 출현 횟수 / 문서d의 전체 단어 수
IDF(t)    = log(전체 문서 수 / 단어t 포함 문서 수)
TF-IDF    = TF × IDF
```

### 코사인 유사도
```
cos(q, d) = (q · d) / (|q| × |d|)
→ 두 벡터가 같은 방향 = 1.0, 직각 = 0.0, 반대 = -1.0
```

### Python 최소 구현
```python
import math
from collections import Counter

def build_tfidf(documents: list[str]):
    # 토크나이징
    tokenized = [doc.split() for doc in documents]
    N = len(documents)

    # IDF 계산
    df = {}
    for tokens in tokenized:
        for t in set(tokens):
            df[t] = df.get(t, 0) + 1
    idf = {t: math.log(N / (df[t] + 1)) for t in df}

    # TF-IDF 벡터 빌드
    vectors = []
    for tokens in tokenized:
        tf = Counter(tokens)
        total = len(tokens)
        vec = {t: (cnt / total) * idf.get(t, 0) for t, cnt in tf.items()}
        vectors.append(vec)

    return vectors, idf

def cosine_sim(v1: dict, v2: dict) -> float:
    dot = sum(v1.get(t, 0) * v2.get(t, 0) for t in v2)
    norm1 = math.sqrt(sum(x**2 for x in v1.values()))
    norm2 = math.sqrt(sum(x**2 for x in v2.values()))
    if not norm1 or not norm2:
        return 0.0
    return dot / (norm1 * norm2)

def search(query: str, vectors, documents, top_n=3):
    q_tokens = query.split()
    q_tf = Counter(q_tokens)
    total = len(q_tokens)
    # IDF는 전역 idf 사용
    q_vec = {t: cnt / total for t, cnt in q_tf.items()}

    scores = [(cosine_sim(q_vec, v), i) for i, v in enumerate(vectors)]
    scores.sort(reverse=True)
    return [(documents[i], s) for s, i in scores[:top_n] if s > 0]
```
""",
    },

    {
        "persona": "dev",
        "q": "한국어 토크나이저 구현 stopwords 불용어 bigram 형태소 분석",
        "a": """## 한국어 토크나이저 구현 (이번 프로젝트 방식)

외부 라이브러리(KoNLPy 등) 없이 순수 Python으로 구현합니다.

```python
import re
from typing import List

# 불용어 목록
STOPWORDS = {
    '이', '그', '저', '것', '수', '있', '하', '되', '않', '같', '때',
    '및', '등', '를', '을', '은', '는', '가', '의', '에', '서', '로',
    '합니다', '습니다', '입니다', '됩니다', '하세요', '해요',
    '설명', '알려줘', '알려주세요', '뭐야', '궁금해', '어떻게',
    '무엇', '뭐가', '언제', '왜', '얼마', '어디',
}

def tokenize(text: str) -> List[str]:
    \"\"\"한국어 텍스트 토크나이징 (특수문자 제거, stopwords 필터링)\"\"\"
    # 특수문자 제거 (한글, 영문, 숫자, 공백 유지)
    text = re.sub(r'[^\\w가-힣a-zA-Z0-9\\s]', ' ', text)

    tokens = []
    for word in text.split():
        word_lower = word.lower()
        # 1글자, 불용어 제외
        if len(word) < 2 or word_lower in STOPWORDS:
            continue
        # 조항 번호 정규화: "3조" → "제3조"
        if re.match(r'^\\d+조$', word_lower):
            tokens.append(f'제{word_lower}')
        else:
            tokens.append(word_lower)
    return tokens

def extract_features(text: str) -> List[str]:
    \"\"\"단어 + bigram(연속 2단어) 특징 추출\"\"\"
    tokens = tokenize(text)
    bigrams = [f'{tokens[i]}_{tokens[i+1]}' for i in range(len(tokens)-1)]
    return tokens + bigrams  # 단어 + 2gram 조합

# 사용 예시
text = "근로기준법 제60조에 따른 연차 유급휴가 계산 방법"
print(tokenize(text))
# ['근로기준법', '제60조', '연차', '유급휴가', '계산', '방법']
print(extract_features(text))
# ['근로기준법', '제60조', '연차', ..., '근로기준법_제60조', '제60조_연차', ...]
```

### KoNLPy 사용 (설치 가능한 경우)
```bash
pip install konlpy   # Java 필요 (JDK 설치 후)
```
```python
from konlpy.tag import Okt
okt = Okt()
okt.morphs("연차 유급휴가 계산")  # ['연차', '유급', '휴가', '계산']
okt.nouns("연차 유급휴가 계산")   # 명사만: ['연차', '휴가', '계산']
```
""",
    },

    {
        "persona": "dev",
        "q": "TF-IDF 엔진 전체 구현 클래스 add search 지식베이스 로드",
        "a": """## TF-IDF 검색 엔진 전체 구현 (이번 프로젝트)

```python
import re, math
from collections import Counter, defaultdict
from typing import List, Tuple, Dict

class TFIDFEngine:
    def __init__(self):
        self._qa: List[Tuple[str, str, dict]] = []  # (질문, 답변, 메타)
        self._vecs: List[Dict[str, float]] = []
        self._idf: Dict[str, float] = {}
        self._dirty = True  # 재계산 필요 여부

    def add(self, question: str, answer: str, meta: dict = None):
        self._qa.append((question, answer, meta or {}))
        self._dirty = True

    def count(self) -> int:
        return len(self._qa)

    def _build(self):
        \"\"\"IDF + 문서 벡터 빌드 (검색 전 1회 실행)\"\"\"
        N = len(self._qa)

        # 문서별 토큰 추출
        doc_tokens = [_extract_features(q) for q, a, m in self._qa]

        # IDF 계산
        df = defaultdict(int)
        for tokens in doc_tokens:
            for t in set(tokens):
                df[t] += 1
        self._idf = {t: math.log((N + 1) / (cnt + 1)) + 1 for t, cnt in df.items()}

        # TF-IDF 벡터 빌드
        self._vecs = []
        for tokens in doc_tokens:
            tf = Counter(tokens)
            total = len(tokens) or 1
            vec = {}
            for t, cnt in tf.items():
                vec[t] = (cnt / total) * self._idf.get(t, 0)
            # L2 정규화
            norm = math.sqrt(sum(v**2 for v in vec.values())) or 1
            self._vecs.append({t: v/norm for t, v in vec.items()})

        self._dirty = False

    def search(self, query: str, n: int = 5, persona: str = None, min_score: float = 0.10):
        if self._dirty:
            self._build()

        q_tokens = _extract_features(query)
        q_tf = Counter(q_tokens)
        total = len(q_tokens) or 1
        q_vec = {}
        for t, cnt in q_tf.items():
            q_vec[t] = (cnt / total) * self._idf.get(t, 0)
        norm = math.sqrt(sum(v**2 for v in q_vec.values())) or 1
        q_vec = {t: v/norm for t, v in q_vec.items()}

        results = []
        for i, (q, a, meta) in enumerate(self._qa):
            # 페르소나 필터
            if persona and meta.get('persona') and meta['persona'] != persona:
                continue
            # 코사인 유사도
            score = sum(q_vec.get(t, 0) * self._vecs[i].get(t, 0) for t in q_vec)
            if score >= min_score:
                results.append((q, a, score, meta))

        results.sort(key=lambda x: x[2], reverse=True)
        return results[:n]


# 글로벌 싱글턴
_engine = TFIDFEngine()

def get_engine() -> TFIDFEngine:
    return _engine
```
""",
    },

    # ══════════════════════════════════════════════
    #  LLM API 연동
    # ══════════════════════════════════════════════

    {
        "persona": "dev",
        "q": "Groq API 연동 llama 스트리밍 코드 무료 LLM API 사용법",
        "a": """## Groq API 스트리밍 연동

### API 키 발급
- console.groq.com 접속 → 무료 계정 생성 → API Keys

### 설치
```bash
pip install httpx python-dotenv
```

### .env 파일
```env
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxx
GROQ_MODEL=llama-3.3-70b-versatile
```

### 스트리밍 구현
```python
import httpx
import json
import os
from typing import AsyncGenerator

async def groq_stream(
    messages: list,
    system_prompt: str = "당신은 도움이 되는 AI 어시스턴트입니다.",
) -> AsyncGenerator[str, None]:
    api_key = os.getenv("GROQ_API_KEY")
    model   = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system_prompt}] + messages,
        "temperature": 0.7,
        "max_tokens": 2048,
        "stream": True,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=60) as client:
        async with client.stream(
            "POST",
            "https://api.groq.com/openai/v1/chat/completions",
            headers=headers,
            json=payload
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    chunk = line[6:]
                    if chunk == "[DONE]":
                        break
                    try:
                        delta = json.loads(chunk)["choices"][0]["delta"].get("content", "")
                        if delta:
                            yield delta
                    except Exception:
                        pass

# FastAPI에서 사용
@app.post("/chat")
async def chat(req: ChatRequest):
    messages = [{"role": "user", "content": req.message}]
    async def generate():
        async for token in groq_stream(messages):
            yield token
    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8")
```
""",
    },

    {
        "persona": "dev",
        "q": "OpenRouter API 연동 무료 모델 llama mistral 스트리밍 폴백",
        "a": """## OpenRouter API 연동 (무료 모델)

### 무료 모델 목록 (openrouter.ai/models?q=free)
- `meta-llama/llama-3.3-70b-instruct:free` — 고품질 70B
- `deepseek/deepseek-r1:free` — 추론 특화
- `google/gemma-3-27b-it:free` — Google 27B
- `mistralai/mistral-7b-instruct:free` — 안정적

```python
import httpx, json, os
from typing import AsyncGenerator

FALLBACK_MODELS = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "meta-llama/llama-3.1-8b-instruct:free",
    "mistralai/mistral-7b-instruct:free",
]

async def openrouter_stream(
    messages: list,
    system: str,
) -> AsyncGenerator[str, None]:
    api_key = os.getenv("OPENROUTER_API_KEY")

    for model in FALLBACK_MODELS:
        try:
            payload = {
                "model": model,
                "messages": [{"role": "system", "content": system}] + messages,
                "stream": True,
                "max_tokens": 2048,
            }
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://myapp.com",
            }
            async with httpx.AsyncClient(timeout=60) as client:
                async with client.stream(
                    "POST",
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers=headers, json=payload
                ) as resp:
                    if resp.status_code == 404:
                        continue  # 다음 모델 시도
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if line.startswith("data: "):
                            chunk = line[6:]
                            if chunk == "[DONE]":
                                return
                            try:
                                delta = json.loads(chunk)["choices"][0]["delta"].get("content","")
                                if delta:
                                    yield delta
                            except Exception:
                                pass
            return  # 성공 시 종료
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                raise  # 한도 초과는 상위로 전파
            continue
```
""",
    },

    {
        "persona": "dev",
        "q": "LLM 폴백 체인 다중 제공자 OpenRouter Groq Gemini 자동 전환",
        "a": """## LLM 다중 제공자 폴백 체인 구현

API 한도 초과 시 자동으로 다음 제공자로 전환하는 패턴입니다.

```python
import time
import asyncio
from typing import AsyncGenerator

# 쿨다운 상태 (메모리 내 캐시)
_cooldown: dict[str, float] = {}

def is_cooling(provider: str) -> bool:
    return time.time() < _cooldown.get(provider, 0)

def set_cooldown(provider: str, seconds: int = 3600):
    _cooldown[provider] = time.time() + seconds
    print(f"[{provider}] {seconds//60}분 쿨다운 설정")

def get_provider_chain() -> list[str]:
    \"\"\"사용 가능한 제공자를 우선순위 순으로 반환\"\"\"
    chain = []
    if os.getenv("OPENROUTER_API_KEY") and not is_cooling("openrouter"):
        chain.append("openrouter")
    if os.getenv("GROQ_API_KEY") and not is_cooling("groq"):
        chain.append("groq")
    if os.getenv("GEMINI_API_KEY") and not is_cooling("gemini"):
        chain.append("gemini")
    chain.append("local")  # 항상 포함 (최후 폴백)
    return chain

async def chat_stream(messages: list, context: str = "", system: str = "") -> AsyncGenerator[str, None]:
    chain = get_provider_chain()

    for i, provider in enumerate(chain):
        is_last = (i == len(chain) - 1)
        try:
            if provider == "openrouter":
                async for token in openrouter_stream(messages, system + context):
                    yield token
                return
            elif provider == "groq":
                async for token in groq_stream(messages, system + context):
                    yield token
                return
            elif provider == "local":
                # 로컬 TF-IDF 엔진 폴백
                async for token in local_tfidf_stream(messages, context):
                    yield token
                return
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                set_cooldown(provider)
            if not is_last:
                await asyncio.sleep(1)
                continue
            yield "\\n⚠️ 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
```
""",
    },

    # ══════════════════════════════════════════════
    #  비동기 Python
    # ══════════════════════════════════════════════

    {
        "persona": "dev",
        "q": "Python asyncio async await 비동기 기본 패턴 사용법 이해",
        "a": """## Python 비동기(asyncio) 기본 패턴

### 기본 개념
- `async def` — 코루틴 함수 정의
- `await` — 비동기 작업 완료 대기
- `asyncio.run()` — 이벤트 루프 실행 진입점

```python
import asyncio
import httpx

# 기본 async 함수
async def fetch_data(url: str) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.get(url)
        return resp.json()

# 병렬 실행 (gather)
async def fetch_all():
    urls = [
        "https://api.example.com/data1",
        "https://api.example.com/data2",
    ]
    # 두 요청을 동시에 보냄
    results = await asyncio.gather(*[fetch_data(url) for url in urls])
    return results

# 실행
result = asyncio.run(fetch_all())
```

### AsyncGenerator (스트리밍)
```python
from typing import AsyncGenerator

async def number_stream(n: int) -> AsyncGenerator[int, None]:
    for i in range(n):
        await asyncio.sleep(0.1)  # I/O 시뮬레이션
        yield i

async def main():
    async for num in number_stream(5):
        print(num)

asyncio.run(main())
```

### FastAPI에서는 자동 이벤트 루프
```python
# FastAPI는 이미 이벤트 루프 실행 중 → asyncio.run() 불필요
@app.get("/data")
async def get_data():
    result = await fetch_data("https://api.example.com")
    return result
```

### 동기 함수를 비동기로 실행 (블로킹 방지)
```python
import asyncio
from concurrent.futures import ThreadPoolExecutor

executor = ThreadPoolExecutor()

async def run_sync(func, *args):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(executor, func, *args)

# 사용
result = await run_sync(heavy_sync_function, arg1, arg2)
```
""",
    },

    # ══════════════════════════════════════════════
    #  환경변수 및 배포
    # ══════════════════════════════════════════════

    {
        "persona": "dev",
        "q": ".env 환경변수 python-dotenv os.getenv 설정 관리 API 키 보안",
        "a": """## 환경변수 관리 (.env + python-dotenv)

### 설치
```bash
pip install python-dotenv
```

### .env 파일 작성
```env
# .env (절대 git에 커밋하지 말 것!)
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxx
OPENROUTER_API_KEY=sk-or-xxxxxxxxxx
DB_PATH=/app/data/memory.db
LLM_PROVIDER=auto
DEBUG=false
```

### .gitignore에 추가
```
.env
.env.local
*.db
__pycache__/
venv/
```

### Python에서 사용
```python
import os
from dotenv import load_dotenv

# 앱 시작 시 한 번만 호출
load_dotenv()

# 값 읽기
api_key = os.getenv("GROQ_API_KEY", "")      # 기본값 ""
db_path = os.getenv("DB_PATH", "/tmp/app.db") # 기본값 /tmp/app.db
debug   = os.getenv("DEBUG", "false") == "true"  # bool 변환

# 필수 키 체크
if not api_key:
    raise RuntimeError("GROQ_API_KEY 환경변수가 설정되지 않았습니다.")
```

### 개발/운영 환경 분리
```python
# settings.py
import os

ENV = os.getenv("ENV", "development")

if ENV == "production":
    DB_PATH = "/app/data/memory.db"
    DEBUG = False
else:
    DB_PATH = "/tmp/dev_memory.db"
    DEBUG = True
```
""",
    },

    {
        "persona": "dev",
        "q": "Railway 배포 방법 Procfile 환경변수 설정 Python FastAPI 무료 배포",
        "a": """## Railway 배포 방법 (무료)

### 사전 준비
1. railway.app 계정 생성
2. GitHub 저장소에 코드 푸시

### 필수 파일

**Procfile** (프로젝트 루트 또는 ai/ 폴더)
```
web: uvicorn main:app --host 0.0.0.0 --port $PORT
```

**requirements.txt**
```
fastapi
uvicorn[standard]
httpx
python-dotenv
python-multipart
```

**nixpacks.toml** (선택, Python 버전 지정)
```toml
[phases.setup]
nixPkgs = ["python311"]
```

### 배포 절차
1. Railway 대시보드 → New Project → Deploy from GitHub
2. 저장소 선택
3. Settings → Source → Root Directory: `ai` (ai 폴더가 서버면)
4. Variables 탭에서 환경변수 추가:
   ```
   GROQ_API_KEY = gsk_xxx
   DB_PATH = /app/data/memory.db
   ```
5. Volumes 탭 → Add Volume → Mount Path: `/app/data` (데이터 영속 저장)
6. Deploy 버튼 클릭

### 배포 로그 확인
```bash
# Railway CLI 설치
npm install -g @railway/cli
railway login
railway logs
```

### 헬스체크 엔드포인트 (권장)
```python
@app.get("/health")
def health():
    return {"status": "ok"}
```
""",
    },

    {
        "persona": "dev",
        "q": "Render 배포 방법 Web Service 무료 플랜 Python FastAPI Disk 마운트",
        "a": """## Render.com 배포 방법 (무료)

### 배포 절차
1. render.com 계정 생성 → New Web Service
2. GitHub 저장소 연결
3. 설정:
   - **Root Directory**: `ai` (서버 코드 위치)
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Plan**: Free

### 환경변수 설정
```
GROQ_API_KEY = gsk_xxx
DB_PATH = /app/data/memory.db
```

### Disk 마운트 (무료 플랜: 1GB)
- Disks 탭 → Add Disk
- **Mount Path**: `/app/data`
- **Size**: 1 GB

### render.yaml (코드로 배포 설정)
```yaml
services:
  - type: web
    name: ai-assistant
    env: python
    rootDir: ai
    buildCommand: pip install -r requirements.txt
    startCommand: uvicorn main:app --host 0.0.0.0 --port $PORT
    envVars:
      - key: DB_PATH
        value: /app/data/memory.db
    disk:
      name: data
      mountPath: /app/data
      sizeGB: 1
```

### 주의사항
- 무료 플랜은 15분 비활성 후 슬립 → 첫 요청 30초 지연
- 슬립 방지: UptimeRobot으로 5분마다 헬스체크 핑
""",
    },

    # ══════════════════════════════════════════════
    #  테스트 및 시뮬레이션
    # ══════════════════════════════════════════════

    {
        "persona": "dev",
        "q": "pytest 사용법 테스트 작성 단위 테스트 단위테스트 fixture 실행",
        "a": """## pytest 기본 사용법

### 설치
```bash
pip install pytest pytest-asyncio httpx
```

### 기본 테스트 파일 (test_calculator.py)
```python
# 테스트 파일명은 test_ 로 시작
import pytest
from calculator import calc_annual_leave, _parse_amount, _parse_date
from datetime import date

# 기본 함수 테스트
def test_parse_amount():
    assert _parse_amount("300만원") == 3_000_000
    assert _parse_amount("4800만") == 48_000_000
    assert _parse_amount("1억") == 100_000_000
    assert _parse_amount("12000") == 12_000

def test_parse_date():
    d = _parse_date("24년 8월 17일")
    assert d == date(2024, 8, 17)

    d2 = _parse_date("2023년 4월")
    assert d2 == date(2023, 4, 1)

def test_annual_leave_1year():
    # 1년 이상 근무 → 15일
    join = date(2023, 1, 1)
    today = date(2024, 6, 1)
    result = calc_annual_leave(join, today)
    assert result["avail"] == 15

# fixture: 공통 객체 재사용
@pytest.fixture
def sample_engine():
    from engine import TFIDFEngine
    eng = TFIDFEngine()
    eng.add("연차 계산", "연차는 15일입니다.", {"persona": "hr"})
    return eng

def test_engine_search(sample_engine):
    results = sample_engine.search("연차", persona="hr")
    assert len(results) > 0
    assert results[0][2] > 0  # 점수 > 0
```

### 실행 명령어
```bash
pytest                          # 모든 테스트
pytest test_calculator.py       # 특정 파일
pytest -v                       # 상세 출력
pytest -k "test_parse"          # 이름 필터
pytest --tb=short               # 짧은 오류 메시지
```
""",
    },

    {
        "persona": "dev",
        "q": "FastAPI TestClient API 테스트 통합 테스트 pytest 비동기",
        "a": """## FastAPI TestClient로 API 테스트

```python
# test_api.py
import pytest
from fastapi.testclient import TestClient
from main import app

# TestClient: requests 방식의 동기 클라이언트 (pytest와 호환)
client = TestClient(app)

def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"

def test_chat():
    response = client.post("/chat", json={
        "message": "연차 계산 방법",
        "persona": "hr"
    })
    assert response.status_code == 200
    # 스트리밍 응답 확인
    assert len(response.text) > 0

def test_learn_text():
    response = client.post("/learn/text", json={
        "question": "테스트 질문",
        "answer": "테스트 답변",
        "persona": "dev"
    })
    assert response.status_code == 200
    assert response.json()["ok"] is True

def test_history():
    response = client.get("/history?limit=10&persona=hr")
    assert response.status_code == 200
    assert "history" in response.json()

# 파일 업로드 테스트
def test_file_upload():
    import io
    content = b"이것은 테스트 문서입니다."
    response = client.post(
        "/learn/document",
        files={"file": ("test.txt", io.BytesIO(content), "text/plain")},
        data={"persona": "hr"}
    )
    assert response.status_code == 200
```

### 비동기 테스트 (pytest-asyncio)
```python
import pytest
import pytest_asyncio

@pytest.mark.asyncio
async def test_async_function():
    from llm import groq_stream
    tokens = []
    async for token in groq_stream([{"role": "user", "content": "안녕"}]):
        tokens.append(token)
    assert len(tokens) > 0
```
""",
    },

    {
        "persona": "dev",
        "q": "curl 명령어 API 테스트 GET POST JSON 파일 업로드 스트리밍",
        "a": """## curl로 API 테스트

```bash
# GET 요청
curl http://localhost:8000/health
curl http://localhost:8000/history?limit=5

# POST JSON
curl -X POST http://localhost:8000/chat \\
  -H "Content-Type: application/json" \\
  -d '{"message": "연차 계산 방법", "persona": "hr"}'

# 스트리밍 응답 (실시간 출력)
curl -N http://localhost:8000/chat \\
  -X POST \\
  -H "Content-Type: application/json" \\
  -d '{"message": "퇴직금 계산 방법"}'

# 파일 업로드
curl -X POST http://localhost:8000/learn/document \\
  -F "file=@document.txt" \\
  -F "persona=hr"

# DELETE
curl -X DELETE "http://localhost:8000/history?persona=hr"

# 응답을 예쁘게 출력 (jq 필요)
curl http://localhost:8000/model-info | python3 -m json.tool
curl http://localhost:8000/model-info | jq .

# 헤더 포함 응답 확인
curl -v http://localhost:8000/health
```

### HTTPie (curl보다 간편)
```bash
pip install httpie

http GET localhost:8000/health
http POST localhost:8000/chat message="안녕하세요" persona="hr"
http -f POST localhost:8000/learn/document file@document.txt persona=hr
```
""",
    },

    {
        "persona": "dev",
        "q": "Python 디버깅 방법 pdb print 로깅 logging breakpoint 시뮬레이션",
        "a": """## Python 디버깅 방법

### 1. print 디버깅 (빠르고 간단)
```python
def search(query: str):
    tokens = tokenize(query)
    print(f"[DEBUG] 토큰: {tokens}")   # 중간값 확인

    results = engine.search(tokens)
    print(f"[DEBUG] 결과 수: {len(results)}, 1위 점수: {results[0][2] if results else 0}")

    return results
```

### 2. logging 모듈 (운영환경 권장)
```python
import logging

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)

def search(query: str):
    logger.debug(f"검색 쿼리: {query}")
    results = engine.search(query)
    logger.info(f"결과 {len(results)}개 반환")
    return results
```

### 3. pdb (Python 내장 디버거)
```python
import pdb

def complex_function(data):
    result = process(data)
    pdb.set_trace()   # 여기서 실행 중단 → 대화형 디버깅
    # 명령어: n(다음줄), s(함수진입), c(계속), p 변수명(출력), q(종료)
    return result

# Python 3.7+
def complex_function(data):
    result = process(data)
    breakpoint()   # pdb.set_trace()와 동일
    return result
```

### 4. 코드 없이 로직 시뮬레이션
```python
# 별도 스크립트로 로직만 테스트
# simulate.py
import sys
sys.path.insert(0, '.')

from engine import get_engine
from calculator import try_any_calc

# 엔진 로드 확인
engine = get_engine()
print(f"KB 항목 수: {engine.count()}")

# 검색 결과 확인
results = engine.search("연차 계산", n=3, persona="hr")
for q, a, score, meta in results:
    print(f"{score:.3f} | {q[:50]}")

# 계산기 테스트
result = try_any_calc("월급 300만 실수령액")
print(result)
```

```bash
python3 simulate.py   # 서버 없이 실행
```
""",
    },

    # ══════════════════════════════════════════════
    #  이번 AI 프로젝트 전체 구조
    # ══════════════════════════════════════════════

    {
        "persona": "dev",
        "q": "이번 AI 프로젝트 전체 구조 아키텍처 파일 구성 설명",
        "a": """## AI 어시스턴트 프로젝트 전체 구조

```
ai/
├── main.py              # FastAPI 서버 (모든 API 엔드포인트)
├── llm.py               # LLM 라우터 (Claude → OpenCode Zen → OpenRouter → Groq → Gemini → Local)
├── engine.py            # TF-IDF 검색 엔진 + 한국어 토크나이저
├── memory.py            # SQLite DB 관리 (대화이력, 학습 데이터)
├── calculator.py        # HR 날짜·금액 직접 계산기 (LLM 불필요)
├── personas.py          # 페르소나 정의 (HR/Dev/Travel/Company/Stock/Resume)
├── search.py            # DuckDuckGo 인터넷 검색
├── backup.py            # Google Drive 백업 (OAuth2)
├── law_search.py        # law.go.kr 법령 실시간 검색
├── knowledge_base.py    # 지식베이스 통합 (여러 KB 파일 합산)
├── knowledge_labor_laws.py     # 노동법 371개 항목
├── knowledge_hr_management.py  # 직무분석·인사평가 47개
├── knowledge_payroll.py        # 급여·보험·세금 37개
├── knowledge_practical_qa.py   # 실용 Q&A 20개
├── knowledge_dev_coding.py     # 개발자 코딩 지식베이스
├── static/
│   └── index.html       # iPad PWA 채팅 UI
├── requirements.txt
└── .env                 # API 키, DB 경로 등 (git 제외)
```

### 요청 처리 흐름
```
사용자 질문
    ↓
0단계: Python 계산기 (날짜·금액 계산)
    ↓ (계산 불가)
1단계: TF-IDF KB 검색 (567개 항목)
    ↓
신뢰도 판정
  ≥0.55 → KB 직접 서빙 (LLM 불필요)
  0.10~0.55 → LLM + KB 컨텍스트
  <0.10 → LLM 생성 + 자동학습 저장
    ↓
LLM 호출 (OpenRouter → Groq → Gemini → Local TF-IDF)
    ↓
응답 스트리밍 + SQLite 저장
```
""",
    },

    {
        "persona": "dev",
        "q": "지식베이스 KB 추가 방법 새로운 학습 데이터 영구 저장 방법",
        "a": """## 지식베이스(KB) 추가 방법

### 방법 1: Python 파일로 정적 추가 (영구, 추천)

```python
# knowledge_my_topic.py 파일 생성
MY_KNOWLEDGE = [
    {
        "persona": "dev",  # "hr", "travel", "dev" 중 선택
        "q": "검색 키워드 질문 형태 여러 동의어 포함",
        "a": \"\"\"## 제목

내용 (Markdown 지원)

```python
# 코드 예시
print("hello")
```
\"\"\",
    },
]

__all__ = ['MY_KNOWLEDGE']
```

```python
# knowledge_base.py 하단에 추가
from knowledge_my_topic import MY_KNOWLEDGE
KNOWLEDGE = KNOWLEDGE + MY_KNOWLEDGE
```

### 방법 2: API로 런타임 추가 (영구, 재시작 후 유지)
```bash
curl -X POST http://localhost:8000/learn/text \\
  -H "Content-Type: application/json" \\
  -d '{
    "question": "FastAPI 배포 방법",
    "answer": "uvicorn main:app --host 0.0.0.0 --port $PORT",
    "persona": "dev"
  }'
```

### 방법 3: 자동 학습 (LLM 응답 자동 저장)
- KB 매칭 점수 < 0.10 시 LLM 답변 자동 저장
- `memory.auto_learn()` → SQLite `learned_knowledge` 테이블
- 재시작 후 `engine._load_knowledge()`가 SQLite에서 복원

### 방법 4: 문서 업로드 (텍스트 파일 학습)
```bash
curl -X POST http://localhost:8000/learn/document \\
  -F "file=@technical_docs.txt" \\
  -F "persona=dev"
```
""",
    },

    {
        "persona": "dev",
        "q": "pydantic BaseModel 데이터 검증 요청 응답 모델 FastAPI 타입",
        "a": """## Pydantic BaseModel 활용

```python
from pydantic import BaseModel, Field, validator
from typing import Optional, List
from datetime import date

# 기본 요청 모델
class ChatRequest(BaseModel):
    message: str
    persona: str = "hr"                    # 기본값
    use_search: bool = False

# 유효성 검사 포함
class UserCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=50)
    email: str = Field(..., pattern=r'.+@.+')
    age: int = Field(..., ge=0, le=150)    # 0 이상 150 이하
    tags: List[str] = []

# 중첩 모델
class Address(BaseModel):
    city: str
    country: str = "KR"

class Employee(BaseModel):
    id: int
    name: str
    address: Address
    join_date: Optional[date] = None

# 응답 모델 (자동 직렬화)
class ChatResponse(BaseModel):
    reply: str
    source: str = "kb"
    confidence: float = 0.0

# 사용 예시
@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    return ChatResponse(
        reply="연차는 15일입니다.",
        source="kb",
        confidence=0.85
    )

# 모델 딕셔너리 변환
emp = Employee(id=1, name="홍길동", address=Address(city="서울"))
print(emp.model_dump())         # dict 변환 (Pydantic v2)
print(emp.model_dump_json())    # JSON 문자열

# 입력값 검증 실패 시 422 에러 자동 반환
```
""",
    },

    # ══════════════════════════════════════════════
    #  정규표현식 · datetime · json
    # ══════════════════════════════════════════════

    {
        "persona": "dev",
        "q": "Python 정규표현식 re 모듈 사용법 한국어 날짜 숫자 추출 패턴",
        "a": """## Python 정규표현식 (re 모듈)

```python
import re

# 기본 패턴
text = "2024년 8월 17일 입사, 월급 300만원"

# 날짜 추출
m = re.search(r'(\\d{4})년\\s*(\\d{1,2})월\\s*(\\d{1,2})일', text)
if m:
    year, month, day = m.group(1), m.group(2), m.group(3)
    print(f"{year}-{month}-{day}")   # 2024-8-17

# 숫자+단위 추출
m = re.search(r'(\\d+(?:\\.\\d+)?)만', text)
if m:
    amount = int(float(m.group(1)) * 10000)  # 3000000

# findall: 모든 매칭 반환
numbers = re.findall(r'\\d+', "연차 15일, 퇴직금 300만, 근속 3년")
print(numbers)   # ['15', '300', '3']

# sub: 치환
clean = re.sub(r'[^\\w가-힣a-zA-Z0-9\\s]', ' ', "안녕하세요! 반갑습니다.")
print(clean)   # "안녕하세요  반갑습니다 "

# split
parts = re.split(r'[,;\\n]', "항목1,항목2;항목3\\n항목4")
print(parts)   # ['항목1', '항목2', '항목3', '항목4']

# 그룹 이름 지정
m = re.search(r'(?P<year>\\d{4})년\\s*(?P<month>\\d{1,2})월', text)
if m:
    print(m.group('year'))    # 2024
    print(m.group('month'))   # 8

# 컴파일 (반복 사용 시 성능 향상)
date_pattern = re.compile(r'\\d{2,4}년\\s*\\d{1,2}월(?:\\s*\\d{1,2}일)?')
matches = date_pattern.findall("2024년 1월 1일부터 2024년 12월 31일까지")
```
""",
    },

    {
        "persona": "dev",
        "q": "Python datetime 날짜 계산 date timedelta 날짜 차이 연산",
        "a": """## Python datetime 날짜 계산

```python
from datetime import date, datetime, timedelta

# 오늘 날짜
today = date.today()               # date(2026, 5, 29)
now   = datetime.now()             # datetime 전체

# 날짜 생성
d = date(2024, 8, 17)
d2 = date.fromisoformat("2024-08-17")

# 날짜 차이
delta = today - d
print(delta.days)   # 일 수 차이

# 날짜 덧셈
next_week = today + timedelta(days=7)
next_year = today.replace(year=today.year + 1)

# 월 더하기 (timedelta는 달 지원 안 함)
from dateutil.relativedelta import relativedelta  # pip install python-dateutil
one_month_later = today + relativedelta(months=1)
one_year_later  = today + relativedelta(years=1)

# 포맷 변환
print(today.strftime("%Y년 %m월 %d일"))   # 2026년 05월 29일
print(today.isoformat())                  # 2026-05-29

# 파싱
d3 = datetime.strptime("2024-08-17", "%Y-%m-%d").date()

# 연차 계산에서 사용한 패턴: 1년 단위 반복
join_date = date(2024, 8, 17)
years = 0
temp = join_date
while True:
    try:
        next_ann = date(temp.year + 1, temp.month, temp.day)
    except ValueError:  # 2월 29일 같은 경우
        next_ann = date(temp.year + 1, temp.month, 28)
    if next_ann > today:
        break
    years += 1
    temp = next_ann
print(f"근속 {years}년")
```
""",
    },

    {
        "persona": "dev",
        "q": "Python json 파싱 직렬화 파일 읽기 쓰기 API 응답 처리",
        "a": """## Python JSON 처리

```python
import json

# dict → JSON 문자열
data = {"name": "홍길동", "age": 30, "skills": ["Python", "FastAPI"]}
json_str = json.dumps(data, ensure_ascii=False, indent=2)
print(json_str)

# JSON 문자열 → dict
parsed = json.loads('{"key": "value", "num": 42}')
print(parsed["key"])   # value

# 파일 저장
with open("data.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

# 파일 읽기
with open("data.json", encoding="utf-8") as f:
    loaded = json.load(f)

# API 응답 파싱 (httpx)
import httpx
resp = httpx.get("https://api.example.com/data")
data = resp.json()   # 자동 파싱

# 커스텀 직렬화 (datetime 등)
from datetime import date

class DateEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, date):
            return obj.isoformat()
        return super().default(obj)

json.dumps({"date": date.today()}, cls=DateEncoder)  # {"date": "2026-05-29"}

# 안전한 파싱 (실패 시 None)
def safe_parse(text: str):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None
```
""",
    },

    # ══════════════════════════════════════════════
    #  JavaScript / 프론트엔드
    # ══════════════════════════════════════════════

    {
        "persona": "dev",
        "q": "JavaScript fetch API POST JSON 비동기 스트리밍 읽기 프론트엔드",
        "a": """## JavaScript fetch API 사용법

### 기본 GET/POST
```javascript
// GET 요청
const response = await fetch('/history?limit=10');
const data = await response.json();
console.log(data.history);

// POST JSON
const response = await fetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        message: '연차 계산 방법',
        persona: 'hr'
    })
});

if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
}
const result = await response.json();
```

### 스트리밍 응답 읽기 (이번 프로젝트 방식)
```javascript
async function streamChat(message, onChunk, onDone) {
    const response = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, persona: 'hr' })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        onChunk(buffer);   // 실시간 화면 업데이트
    }

    onDone(buffer);        // 완료 후 처리
}

// 사용
streamChat(
    '안녕하세요',
    (text) => { document.getElementById('output').innerText = text; },
    (fullText) => { saveToHistory(fullText); }
);
```

### FormData (파일 업로드)
```javascript
const formData = new FormData();
formData.append('file', fileInput.files[0]);
formData.append('persona', 'hr');

const response = await fetch('/learn/document', {
    method: 'POST',
    body: formData   // Content-Type 자동 설정
});
```
""",
    },

    {
        "persona": "dev",
        "q": "PWA 설정 manifest.json service worker 오프라인 iPad 홈화면 추가",
        "a": """## PWA (Progressive Web App) 설정

### manifest.json
```json
{
    "name": "AI 어시스턴트",
    "short_name": "AI 어시스턴트",
    "description": "나만의 HR AI 어시스턴트",
    "start_url": "/",
    "display": "standalone",
    "background_color": "#1a1a2e",
    "theme_color": "#1565c0",
    "orientation": "portrait",
    "icons": [
        {
            "src": "/static/icon-192.png",
            "sizes": "192x192",
            "type": "image/png"
        },
        {
            "src": "/static/icon-512.png",
            "sizes": "512x512",
            "type": "image/png"
        }
    ]
}
```

### HTML에 연결
```html
<head>
    <link rel="manifest" href="/static/manifest.json">
    <meta name="theme-color" content="#1565c0">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="AI 어시스턴트">
    <!-- iOS용 아이콘 -->
    <link rel="apple-touch-icon" href="/static/icon-192.png">
</head>
```

### Service Worker (오프라인 지원)
```javascript
// sw.js
const CACHE = 'ai-cache-v1';
const ASSETS = ['/', '/static/index.html', '/static/style.css'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('fetch', e => {
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request))
    );
});
```

### iPad에서 홈화면 추가
1. Safari에서 앱 URL 접속
2. 공유 버튼(네모+화살표) 클릭
3. "홈 화면에 추가" 선택
4. 이름 확인 후 "추가"
""",
    },

    # ══════════════════════════════════════════════
    #  코드 품질 및 패턴
    # ══════════════════════════════════════════════

    {
        "persona": "dev",
        "q": "Python 코드 품질 black ruff lint 포맷터 타입 힌트 type hints",
        "a": """## Python 코드 품질 관리

### 코드 포맷터 설치 및 사용
```bash
pip install black ruff

# black: 코드 자동 포맷
black main.py           # 단일 파일
black ai/               # 디렉토리 전체
black --check ai/       # 변경 없이 확인만

# ruff: 빠른 린터 (flake8/isort 대체)
ruff check ai/          # 린트 검사
ruff check --fix ai/    # 자동 수정
```

### 타입 힌트 (Type Hints)
```python
from typing import Optional, List, Dict, Union, Tuple, Any

def process(
    text: str,
    count: int = 5,
    tags: Optional[List[str]] = None
) -> Dict[str, Any]:
    return {"result": text, "count": count}

# Python 3.10+ 단순화
def new_style(x: int | None = None) -> list[str]:
    return []

# dataclass
from dataclasses import dataclass, field

@dataclass
class SearchResult:
    question: str
    answer: str
    score: float
    meta: dict = field(default_factory=dict)
```

### pyproject.toml 설정
```toml
[tool.black]
line-length = 100
target-version = ['py311']

[tool.ruff]
line-length = 100
select = ["E", "F", "I"]   # pycodestyle, pyflakes, isort

[tool.mypy]
python_version = "3.11"
strict = true
```
""",
    },

    {
        "persona": "dev",
        "q": "싱글턴 패턴 Python 캐싱 글로벌 변수 엔진 초기화 once 패턴",
        "a": """## 싱글턴(Singleton) 패턴 구현

서버 전체에서 하나의 인스턴스만 공유할 때 사용합니다 (DB 연결, TF-IDF 엔진 등).

```python
# 방법 1: 모듈 레벨 글로벌 (이번 프로젝트 방식)
_engine = None
_loaded = False

def get_engine():
    global _engine, _loaded
    if not _loaded:
        _engine = TFIDFEngine()
        _engine.load_knowledge()
        _loaded = True
    return _engine

# 방법 2: 클래스 싱글턴
class Database:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._init()
        return cls._instance

    def _init(self):
        self.conn = sqlite3.connect("/tmp/app.db")

db1 = Database()
db2 = Database()
print(db1 is db2)  # True

# 방법 3: functools.lru_cache (캐싱 포함)
from functools import lru_cache

@lru_cache(maxsize=1)
def get_config():
    \"\"\"설정 파일을 한 번만 로드\"\"\"
    with open("config.json") as f:
        return json.load(f)

# 방법 4: FastAPI Dependency Injection
from fastapi import Depends

def get_db():
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()

@app.get("/items")
def read_items(db: sqlite3.Connection = Depends(get_db)):
    return db.execute("SELECT * FROM items").fetchall()
```
""",
    },

    {
        "persona": "dev",
        "q": "에러 처리 예외 처리 try except finally 파이썬 FastAPI 에러",
        "a": """## 에러 처리 패턴

### 기본 try-except
```python
def safe_parse_date(text: str):
    try:
        from datetime import date
        parts = text.split('-')
        return date(int(parts[0]), int(parts[1]), int(parts[2]))
    except (ValueError, IndexError) as e:
        print(f"날짜 파싱 실패: {e}")
        return None
    finally:
        print("파싱 시도 완료")  # 항상 실행

# 여러 예외 처리
def fetch_data(url: str):
    try:
        import httpx
        resp = httpx.get(url, timeout=10)
        resp.raise_for_status()
        return resp.json()
    except httpx.TimeoutException:
        return {"error": "요청 시간 초과"}
    except httpx.HTTPStatusError as e:
        return {"error": f"HTTP {e.response.status_code}"}
    except Exception as e:
        import traceback
        print(traceback.format_exc())
        return {"error": str(e)}
```

### FastAPI 커스텀 에러
```python
from fastapi import FastAPI, HTTPException
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import JSONResponse

app = FastAPI()

# 표준 HTTPException
@app.get("/item/{id}")
def get_item(id: int):
    if id <= 0:
        raise HTTPException(status_code=400, detail="ID는 양수여야 합니다.")
    if id > 1000:
        raise HTTPException(status_code=404, detail="아이템을 찾을 수 없습니다.")
    return {"id": id}

# 커스텀 예외 클래스
class KBNotFoundError(Exception):
    def __init__(self, query: str):
        self.query = query

@app.exception_handler(KBNotFoundError)
async def kb_error_handler(request, exc: KBNotFoundError):
    return JSONResponse(
        status_code=404,
        content={"error": "KB 없음", "query": exc.query}
    )
```
""",
    },

    {
        "persona": "dev",
        "q": "requirements.txt 패키지 의존성 관리 버전 고정 pip freeze",
        "a": """## requirements.txt 작성 및 관리

### 이번 프로젝트 requirements.txt
```txt
# API 서버
fastapi==0.115.0
uvicorn[standard]==0.30.0

# HTTP 클라이언트 (비동기)
httpx==0.27.0

# 환경변수
python-dotenv==1.0.0

# 데이터 검증
pydantic==2.7.0

# 파일 업로드
python-multipart==0.0.9

# 날짜 계산 (옵션)
# python-dateutil==2.9.0
```

### 패키지 관리 명령어
```bash
# 현재 환경 전체 고정
pip freeze > requirements.txt

# 설치
pip install -r requirements.txt

# 업그레이드
pip install --upgrade fastapi
pip install fastapi --upgrade

# 패키지 상세 정보
pip show fastapi

# 의존성 트리 확인
pip install pipdeptree
pipdeptree
```

### 버전 표기 방식
```txt
fastapi==0.115.0      # 정확한 버전 고정 (운영 권장)
fastapi>=0.100.0      # 최소 버전
fastapi>=0.100,<1.0   # 범위 지정
fastapi~=0.115.0      # 0.115.x 호환
```

### pyproject.toml (최신 방식)
```toml
[project]
name = "ai-assistant"
version = "1.0.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.30.0",
    "httpx>=0.27.0",
    "python-dotenv>=1.0.0",
]
```
""",
    },

    {
        "persona": "dev",
        "q": "API 테스트 시뮬레이션 로컬 실행 없이 로직 검증 방법",
        "a": """## API 없이 로직 시뮬레이션하는 방법

서버를 실행하지 않고도 핵심 로직을 검증할 수 있습니다.

### 1. 독립 실행 스크립트 (가장 빠름)
```python
# simulate_kb.py
import sys
sys.path.insert(0, 'ai/')  # ai 폴더를 Python 경로에 추가

# 엔진 직접 로드
from engine import get_engine
engine = get_engine()
print(f"KB 로드 완료: {engine.count()}개")

# 검색 테스트
questions = [
    "연차 계산 방법",
    "퇴직금 계산",
    "최저임금 2024",
]
for q in questions:
    results = engine.search(q, n=1, persona="hr")
    if results:
        score = results[0][2]
        matched = results[0][0][:40]
        print(f"{score:.3f} | {q} → {matched}")

# 계산기 테스트
from calculator import try_any_calc
test = "월급 300만 실수령액"
result = try_any_calc(test)
print(result[:200] if result else "계산 불가")
```
```bash
python3 simulate_kb.py
```

### 2. Python 대화형 셸 (REPL)
```bash
python3
>>> import sys; sys.path.insert(0, 'ai/')
>>> from engine import get_engine
>>> engine = get_engine()
>>> engine.search("연차", n=2, persona="hr")
```

### 3. Jupyter Notebook (시각화 포함)
```bash
pip install jupyter
jupyter notebook   # 브라우저에서 셀 단위 실행
```

### 4. FastAPI 테스트 클라이언트 (서버 불필요)
```python
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)   # 서버 없이 직접 테스트
resp = client.post("/chat", json={"message": "연차 계산"})
print(resp.text)
```

### 5. 특정 함수만 단독 실행
```python
# 파일 맨 아래에 추가
if __name__ == "__main__":
    # python3 calculator.py 로 실행 시에만 동작
    from datetime import date
    result = calc_annual_leave(date(2024, 8, 17), date.today())
    print(result)
```
```bash
python3 ai/calculator.py
```
""",
    },

    {
        "persona": "dev",
        "q": "개발자 도구 Postman REST Client HTTP 파일 API 테스트 도구",
        "a": """## API 테스트 도구 모음

### 1. Postman (GUI, 가장 유명)
- postman.com 에서 무료 다운로드
- Collections로 테스트 그룹 관리
- 환경변수로 dev/prod URL 전환
- 자동화 테스트 (Test Scripts)

### 2. VS Code REST Client 확장 (.http 파일)
```http
### 헬스체크
GET http://localhost:8000/health

### 채팅 요청
POST http://localhost:8000/chat
Content-Type: application/json

{
  "message": "연차 계산 방법",
  "persona": "hr"
}

### 지식 추가
POST http://localhost:8000/learn/text
Content-Type: application/json

{
  "question": "FastAPI란",
  "answer": "Python 기반 빠른 API 프레임워크",
  "persona": "dev"
}

### 히스토리 조회
GET http://localhost:8000/history?limit=10&persona=hr
```
`Ctrl+Alt+R` (또는 Send Request 클릭)으로 실행

### 3. Thunder Client (VS Code 내장 Postman)
- VS Code 확장에서 "Thunder Client" 설치
- 설치 후 왼쪽 사이드바 번개 아이콘

### 4. HTTPie (터미널, curl보다 가독성 좋음)
```bash
pip install httpie

http GET localhost:8000/health
http POST localhost:8000/chat message="안녕" persona="hr"
http -f POST localhost:8000/learn/document file@doc.txt
```

### 5. Insomnia (오픈소스 GUI)
- insomnia.rest 에서 다운로드
- GraphQL 지원 강점
""",
    },

    {
        "persona": "dev",
        "q": "Git 브랜치 전략 PR 워크플로우 코드리뷰 협업 방법 GitHub Flow",
        "a": """## Git 브랜치 전략 및 협업

### GitHub Flow (단순, 추천)
```
main (항상 배포 가능 상태)
  └── feature/기능명    (개발)
  └── fix/버그명        (버그 수정)
  └── hotfix/긴급수정   (운영 긴급 패치)
```

```bash
# 1. 새 기능 브랜치 생성
git checkout -b feature/add-calculator

# 2. 개발 + 커밋
git add calculator.py main.py
git commit -m "feat: HR 계산기 추가"

# 3. 원격에 푸시
git push -u origin feature/add-calculator

# 4. GitHub에서 PR (Pull Request) 생성 → 코드 리뷰
# 5. 승인 후 main에 Merge

# 6. 로컬 정리
git checkout main
git pull origin main
git branch -d feature/add-calculator
```

### 이번 프로젝트 브랜치
```
main → 배포 브랜치
claude/account-pinned-agents-v6W7p → 현재 개발 브랜치
```

### 유용한 Git 명령어
```bash
# 변경사항 임시 저장 (WIP)
git stash
git stash pop           # 복원

# 커밋 되돌리기 (새 커밋 생성)
git revert HEAD

# 특정 파일만 되돌리기
git checkout -- 파일명

# 브랜치 비교
git diff main...feature/new-feature

# 그래프 로그
git log --oneline --graph --all
```

### 커밋 메시지 규칙 (Conventional Commits)
```
feat: 새 기능 추가
fix: 버그 수정
docs: 문서만 변경
refactor: 기능 변경 없이 코드 개선
test: 테스트 추가/수정
chore: 빌드 설정, 패키지 변경
```
""",
    },

    {
        "persona": "dev",
        "q": "Python 성능 최적화 캐싱 lru_cache 프로파일링 느린 코드 개선",
        "a": """## Python 성능 최적화

### 1. functools.lru_cache (메모이제이션)
```python
from functools import lru_cache
import time

@lru_cache(maxsize=128)
def expensive_calculation(n: int) -> int:
    \"\"\"같은 인자로 두 번 호출 시 캐시에서 반환\"\"\"
    time.sleep(1)
    return n ** 2

print(expensive_calculation(5))   # 1초 소요
print(expensive_calculation(5))   # 즉시 반환 (캐시)

# 캐시 정보
print(expensive_calculation.cache_info())
# CacheInfo(hits=1, misses=1, maxsize=128, currsize=1)

# 캐시 비우기
expensive_calculation.cache_clear()
```

### 2. 프로파일링 (느린 부분 찾기)
```python
import cProfile
import pstats
import io

# 함수 프로파일링
profiler = cProfile.Profile()
profiler.enable()

# 측정할 코드
result = slow_function(data)

profiler.disable()
stream = io.StringIO()
stats = pstats.Stats(profiler, stream=stream).sort_stats('cumulative')
stats.print_stats(20)  # 상위 20개 함수
print(stream.getvalue())
```

### 3. 간단한 시간 측정
```python
import time

start = time.time()
result = engine.search("연차 계산", n=5)
elapsed = time.time() - start
print(f"검색 시간: {elapsed*1000:.2f}ms")
```

### 4. 리스트 컴프리헨션 (반복문보다 빠름)
```python
# 느림
result = []
for item in items:
    if item['score'] > 0.5:
        result.append(item['answer'])

# 빠름
result = [item['answer'] for item in items if item['score'] > 0.5]

# 제너레이터 (메모리 절약)
result_gen = (item['answer'] for item in items if item['score'] > 0.5)
```

### 5. TF-IDF 빌드 최적화 (이번 프로젝트)
```python
# dirty flag 패턴: 데이터 추가 시 즉시 재빌드 X
# → 검색 시 한 번만 빌드
class Engine:
    def add(self, q, a, meta=None):
        self._qa.append((q, a, meta))
        self._dirty = True   # 재빌드 필요 표시

    def search(self, query, ...):
        if self._dirty:
            self._build()   # 필요할 때만 한 번 빌드
            self._dirty = False
        # ... 검색
```
""",
    },

    {
        "persona": "dev",
        "q": "전체 기능 통합 구현 AI 어시스턴트 처음부터 만들기 종합 구현",
        "a": """## AI 어시스턴트 처음부터 만들기 (종합)

이번 프로젝트의 전체 구현 순서입니다.

### Step 1: 환경 설정
```bash
mkdir ai-assistant && cd ai-assistant
python3 -m venv venv && source venv/bin/activate
pip install fastapi uvicorn httpx python-dotenv pydantic python-multipart

# .env 파일 생성
echo "GROQ_API_KEY=your_key_here" > .env
echo "DB_PATH=/tmp/memory.db" >> .env
```

### Step 2: DB 초기화 (memory.py)
```python
import sqlite3, os
from datetime import datetime

DB_PATH = os.getenv("DB_PATH", "/tmp/memory.db")

def init_db():
    with sqlite3.connect(DB_PATH) as c:
        c.execute(\"\"\"CREATE TABLE IF NOT EXISTS conversations
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
             role TEXT, content TEXT, persona TEXT, created_at TEXT)\"\"\")
        c.execute(\"\"\"CREATE TABLE IF NOT EXISTS learned_knowledge
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
             content TEXT, persona TEXT, source TEXT, created_at TEXT)\"\"\")
```

### Step 3: 검색 엔진 (engine.py)
```python
# TF-IDF 엔진 + 지식베이스 로드
# (위의 TF-IDF 구현 참조)
```

### Step 4: LLM 연동 (llm.py)
```python
# Groq 스트리밍 + OpenRouter 폴백
# (위의 LLM API 연동 참조)
```

### Step 5: API 서버 (main.py)
```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
import memory as mem, llm, engine as eng

app = FastAPI()
mem.init_db()

@app.post("/chat")
async def chat(req: ChatRequest):
    # KB 검색 → LLM 폴백 → 자동학습
    kb = eng.get_engine().search(req.message, n=5)
    context = "\\n".join(a for q,a,s,m in kb if s > 0.1)

    async def generate():
        async for token in llm.chat_stream(
            [{"role": "user", "content": req.message}],
            context=context
        ):
            yield token

    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8")
```

### Step 6: 실행 및 테스트
```bash
uvicorn main:app --reload
curl -X POST http://localhost:8000/chat -H "Content-Type: application/json" -d '{"message":"안녕"}'
```

### Step 7: 배포 (Railway)
```bash
# Procfile 생성
echo "web: uvicorn main:app --host 0.0.0.0 --port \\$PORT" > Procfile
git add . && git commit -m "feat: AI 어시스턴트 초기 구현"
git push origin main
# Railway 대시보드에서 GitHub 연결 → 자동 배포
```
""",
    },

]

__all__ = ['DEV_CODING_KNOWLEDGE']
