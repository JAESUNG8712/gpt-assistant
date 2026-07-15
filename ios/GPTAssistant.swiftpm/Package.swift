// swift-tools-version: 5.9

import AppPackage

// 참고: Swift Playgrounds에서 "새로운 항목 → 앱"으로 프로젝트를 만들면
// 이 파일이 Swift Playgrounds 버전에 맞게 자동 생성됩니다.
// 이미 생성된 Package.swift가 있다면 이 파일로 덮어쓰지 말고,
// GPTAssistantApp.swift / ContentView.swift / WebView.swift 3개 파일만
// 자동 생성된 프로젝트에 추가/교체하세요.
let package = Package(
    name: "GPTAssistant",
    platforms: [
        .iOS("16.0")
    ],
    products: [
        .iOSApplication(
            name: "GPTAssistant",
            targets: ["AppModule"],
            bundleIdentifier: "com.jaesung8712.gptassistant",
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            supportedDeviceFamilies: [
                .pad,
                .phone
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeLeft,
                .landscapeRight,
                .portraitUpsideDown
            ],
            capabilities: [
                .outgoingNetworkConnections()
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "."
        )
    ]
)
