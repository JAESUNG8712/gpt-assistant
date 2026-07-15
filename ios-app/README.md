# iOS 앱 (Swift Playgrounds)

이 저장소에는 서로 독립된 두 백엔드가 있고(`docs/API_CONTRACT.md`, `claude/mobile-hr-app-testing-rDc2F`
브랜치 참고), 각각을 위한 별도의 Swift Playgrounds 앱이 이 폴더 아래에 있습니다.

| 앱 | 백엔드 | 인증 | 자세히 |
|---|---|---|---|
| `GPTAssistant.swiftpm` | `ai/main.py` (AI 어시스턴트) | 없음(공개 API) | [GPTAssistant.swiftpm/README.md](GPTAssistant.swiftpm/README.md) |
| `HRERPApp.swiftpm` | `server.js` (HR/ERP 시스템) | 로그인 + Bearer 토큰 | [HRERPApp.swiftpm/README.md](HRERPApp.swiftpm/README.md) |

각 `.swiftpm` 폴더를 iPad/Mac의 Swift Playgrounds 앱에서 그대로 열면 실행할 수 있습니다.
두 앱은 서로 다른 프로젝트(별도 `Package.swift`, 별도 번들 ID)이므로 독립적으로 열고 배포합니다.
