// swift-tools-version: 6.0

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "HRERPApp",
    platforms: [
        .iOS("26.0")
    ],
    products: [
        .iOSApplication(
            name: "인사 ERP",
            targets: ["AppModule"],
            bundleIdentifier: "com.jaesung8712.hrerp",
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            appIcon: .placeholder(icon: .leaf),
            accentColor: .presetColor(.indigo),
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
