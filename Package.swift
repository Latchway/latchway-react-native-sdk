// swift-tools-version: 6.2

import PackageDescription
import Foundation

// This manifest is a development-only bridge test harness (not npm payload).
let nativeDevelopmentPath = ProcessInfo.processInfo.environment["LATCHWAY_IOS_SDK_PATH"]
let nativeDependency: Package.Dependency = nativeDevelopmentPath.map { .package(name: "latchway-ios-sdk", path: $0) }
    ?? .package(url: "https://github.com/Latchway/latchway-ios-sdk.git", revision: "a2c062b66c334d328754eb5a0d5e73f79b5977df")

let package = Package(
    name: "LatchwayReactNativeBridgeConformance",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
    ],
    dependencies: [
        nativeDependency,
    ],
    targets: [
        .target(
            name: "LatchwayReactNativeBridge",
            dependencies: [
                .product(name: "Latchway", package: "latchway-ios-sdk"),
                .product(name: "LatchwayAppAttest", package: "latchway-ios-sdk"),
            ],
            path: "ios",
            exclude: [
                "RCTNativeLatchway.h",
                "RCTNativeLatchway.mm",
            ],
            sources: ["LatchwayNativeBridge.swift"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "LatchwayReactNativeBridgeTests",
            dependencies: ["LatchwayReactNativeBridge"],
            path: "Conformance/Tests/NativeIOSBridge",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
