# GPT Assistant iOS 앱 (Swift Playgrounds)

`ai/main.py` FastAPI 백엔드에 연결하는 SwiftUI 채팅 클라이언트입니다.
Swift Playgrounds(iPad/Mac) 앱에서 `GPTAssistant.swiftpm` 폴더를 직접 열어 실행할 수 있습니다.

## docs/API_CONTRACT.md 관련 안내

이 앱을 만들 당시 저장소에 `docs/API_CONTRACT.md` 파일이 존재하지 않았습니다
(`docs/` 폴더 자체가 없음). 대신 실제 백엔드 구현(`ai/main.py`, `ai/personas.py`,
`ai/memory.py`)을 직접 읽어 아래 엔드포인트를 기준으로 앱을 작성했습니다.

## 연동 엔드포인트

| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/personas` | 페르소나 목록 (인사/개발/여행/사내규정/주식/이력서/통합검색) |
| POST | `/chat` | 채팅 — `text/plain` 청크 스트리밍 응답 (SSE 아님) |
| GET | `/history?limit=&persona=` | 페르소나별 대화 이력 조회 |
| DELETE | `/history?persona=` | 대화 이력 삭제 |
| POST | `/feedback` | 답변 좋아요/싫어요 (검색 가중치에 반영됨) |
| GET | `/health` | 서버/DB 상태 확인 (설정 탭의 "연결 확인") |

`/chat`은 `StreamingResponse(media_type="text/plain")`로 문자 단위 청크를 흘려보내므로,
클라이언트는 `URLSession.bytes(for:)`로 바이트를 직접 받아 누적 디코딩합니다
(`Sources/IncrementalUTF8Decoder.swift`) — 한글 등 멀티바이트 문자가 청크 경계에서
잘리는 것을 방지하기 위함입니다.

## 사용 방법

1. `ai/` 백엔드를 Render.com 또는 Railway에 배포합니다 (자세한 내용은 루트 `CLAUDE.md` 참고).
   `DB_PATH` 환경변수와 영속 볼륨 설정을 빠뜨리면 재배포 시 대화 이력이 초기화되니 주의하세요.
2. iPad의 Swift Playgrounds 앱(또는 Mac의 Swift Playgrounds/Xcode)에서
   `ios-app/GPTAssistant.swiftpm`을 엽니다.
3. 앱 실행 후 **설정** 탭에서 배포된 백엔드 URL을 입력합니다 (예: `https://your-app.onrender.com`).
   반드시 `https://`로 시작해야 합니다 — App Transport Security로 인해 평문 `http://`는
   기본적으로 차단됩니다.
4. **연결 확인** 버튼으로 `/health` 응답을 확인합니다.
5. **채팅** 탭으로 이동해 우측 상단 아이콘으로 페르소나(인사/개발/여행/주식 등)를 선택하고 대화를 시작합니다.

## 제한 사항 (범위 밖)

- 파일 업로드가 필요한 `/learn/document`, `/analyze/resume`, 예산관리(`/budget/*`),
  백업(`/backup/*`), 주식 분석 전용 엔드포인트(`/stock/*`)는 이번 앱에 포함하지 않았습니다.
  핵심 채팅·페르소나·이력·피드백 흐름만 구현했습니다.
