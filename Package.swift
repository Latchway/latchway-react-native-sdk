// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "LatchwayReactNativeBridgeConformance",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
    ],
    dependencies: [
        .package(
            url: "https://github.com/Latchway/latchway-ios-sdk.git",
            revision: "92a394acbc00d1af6d258372f22b11ddae8e1750"
        ),
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
