# GPT Assistant iOS 앱 (Swift Playgrounds)

`ai/main.py` FastAPI 백엔드(AI 어시스턴트)에 연결하는 SwiftUI 채팅 클라이언트입니다.
Swift Playgrounds(iPad/Mac) 앱에서 `GPTAssistant.swiftpm` 폴더를 직접 열어 실행할 수 있습니다.

## docs/API_CONTRACT.md 관련 안내

이 앱을 처음 만들 때는 이 브랜치(`claude/add-jaesung8712-gpt-assistant-boed6i`)에
`docs/API_CONTRACT.md`가 없어 `ai/main.py`·`ai/personas.py`·`ai/memory.py`를 직접 읽어
아래 엔드포인트를 기준으로 작성했습니다. 이후 `docs/API_CONTRACT.md`가 실제로는
`claude/mobile-hr-app-testing-rDc2F` 브랜치에 존재한다는 걸 확인했고, 거기에 따르면:

- 이 저장소에는 **완전히 독립된 두 백엔드**가 있습니다 — 이 앱이 연동하는 AI 어시스턴트
  (`ai/main.py`, 무인증)와, 별도의 HR/ERP 시스템(`server.js`, 로그인+Bearer 토큰 인증,
  회계·영업·재고·PMS·채용 등 100개 이상 엔드포인트). 이 앱은 AI 어시스턴트만 다룹니다.
- AI 어시스턴트의 실제 운영 배포는 `https://ai-assist-aosk.onrender.com`이며,
  배포에 쓰이는 브랜치는 `claude/account-pinned-agents-v6W7p`입니다 — 처음 이 앱을 만들 때
  참고한 브랜치와는 다릅니다. 두 브랜치의 `ai/main.py`를 직접 diff해 핵심 엔드포인트
  (`/personas`, `/chat`, `/history`, `/feedback`)가 동일한 요청/응답 형태임을 확인했고,
  차이가 있던 `/health`(Turso 클라우드 DB 모드에서는 `db_exists`/`disk_free_mb` 필드가
  아예 빠짐)와 메시지 길이 제한(4000자, 초과 시 400)은 이 앱에 반영했습니다.
- HR/ERP 시스템(`server.js`) 연동은 아직 이 앱에 포함되어 있지 않습니다. 필요하면 별도로
  요청하세요 — 로그인/토큰 인증부터 새로 구현해야 합니다.

## 연동 엔드포인트

| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/personas` | 페르소나 목록 (인사/개발/여행/사내규정/주식/이력서/통합검색) |
| POST | `/chat` | 채팅 — `text/plain` 청크 스트리밍 응답 (SSE 아님), 메시지 최대 4000자 |
| GET | `/history?limit=&persona=` | 페르소나별 대화 이력 조회 |
| DELETE | `/history?persona=` | 대화 이력 삭제 |
| POST | `/feedback` | 답변 좋아요/싫어요 (검색 가중치에 반영됨) |
| GET | `/health` | 서버/DB 상태 확인 (설정 탭의 "연결 확인") |

`/chat`은 `StreamingResponse(media_type="text/plain")`로 문자 단위 청크를 흘려보내므로,
클라이언트는 `URLSession.bytes(for:)`로 바이트를 직접 받아 누적 디코딩합니다
(`Sources/AppModule/IncrementalUTF8Decoder.swift`) — 한글 등 멀티바이트 문자가 청크
경계에서 잘리는 것을 방지하기 위함입니다.

## 사용 방법

1. `ai/` 백엔드를 Render.com 또는 Railway에 배포합니다 (자세한 내용은 루트 `CLAUDE.md` 참고).
   `DB_PATH` 환경변수와 영속 볼륨 설정을 빠뜨리면 재배포 시 대화 이력이 초기화되니 주의하세요.
2. iPad의 Swift Playgrounds 앱(또는 Mac의 Swift Playgrounds/Xcode)에서
   `ios-app/GPTAssistant.swiftpm`을 엽니다.
3. 앱 실행 후 **설정** 탭에서 배포된 백엔드 URL을 입력합니다
   (예: `https://ai-assist-aosk.onrender.com`).
   반드시 `https://`로 시작해야 합니다 — App Transport Security로 인해 평문 `http://`는
   기본적으로 차단됩니다.
4. **연결 확인** 버튼으로 `/health` 응답을 확인합니다.
5. **채팅** 탭으로 이동해 우측 상단 아이콘으로 페르소나(인사/개발/여행/주식 등)를 선택하고 대화를 시작합니다.

## 제한 사항 (범위 밖)

- 파일 업로드가 필요한 `/learn/document`, `/analyze/resume`, 예산관리(`/budget/*`),
  백업(`/backup/*`), 주식 분석 전용 엔드포인트(`/stock/*`)는 이번 앱에 포함하지 않았습니다.
  핵심 채팅·페르소나·이력·피드백 흐름만 구현했습니다.
- HR/ERP 시스템(`server.js`)은 완전히 별도 범위입니다 — 위 참고 사항 참고.
