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
            revision: "9f306d1e585069ca4aa703412c5d70656336e50f"
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
