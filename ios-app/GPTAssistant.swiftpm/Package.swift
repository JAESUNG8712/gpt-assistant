// swift-tools-version: 5.9

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "GPTAssistant",
    platforms: [
        .iOS("16.0")
    ],
    products: [
        .iOSApplication(
            name: "나만의 AI 어시스턴트",
            targets: ["AppModule"],
            bundleIdentifier: "com.jaesung8712.gptassistant",
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            appIcon: .placeholder(icon: .coffee),
            accentColor: .presetColor(.blue),
            supportedDeviceFamilies: [
                .pad,
                .phone
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft,
                .portraitUpsideDown(.when(deviceFamilies: [.pad]))
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule"
        )
    ]
)
