import Foundation
import Latchway
@testable import LatchwayReactNativeBridge
import XCTest

final class LatchwayNativeBridgeConformanceTests: XCTestCase {
    func testGatewayProblemPreservesSafeDetailAndDiagnosticsAcrossBridge() async throws {
        let problem = LatchwayProblem(code: .init(rawValue: "quota_exceeded"), title: "Quota exceeded",
            detail: "The weekly total token allowance is exhausted.", status: 429,
            requestID: "req_12345678", retryable: true,
            retryAfter: Date(timeIntervalSince1970: 1_789_344_000), feature: "chat",
            errors: [.init(path: "quota.total_tokens", message: "The weekly user limit is exhausted.")],
            supportedProtocolVersions: [1, 2, 3], instance: "/requests/req_12345678")
        let native = RecordingNativeClient(failure: LatchwayError.server(problem))
        let store = LatchwayBridgeStore()
        try await store.register(clientID: "rn-ios-conformance", context: native)
        let bridge = LatchwayNativeBridge(store: store)
        do {
            try await refresh(bridge)
            XCTFail("Expected gateway rejection")
        } catch let failure as BridgeFailure {
            XCTAssertEqual(failure.code, "quota_exceeded")
            XCTAssertEqual(failure.message, problem.detail)
            let metadata = try XCTUnwrap(failure.error?.userInfo)
            XCTAssertEqual(metadata["requestID"] as? String, problem.requestID)
            XCTAssertEqual(metadata["retryAfter"] as? String, "2026-09-14T00:00:00Z")
            XCTAssertEqual(metadata["feature"] as? String, "chat")
            XCTAssertEqual(metadata["title"] as? String, "Quota exceeded")
            XCTAssertEqual(metadata["instance"] as? String, problem.instance)
            XCTAssertEqual(metadata["supportedProtocolVersions"] as? [Int], [1, 2, 3])
            XCTAssertEqual(metadata["validationErrors"] as? [[String: String]],
                [["path": "quota.total_tokens", "message": "The weekly user limit is exhausted."]])
        }
        await store.invalidate()
    }

    func testInvalidHTTPResponsePreservesHeaderCorrelationAcrossBridge() async throws {
        let native = RecordingNativeClient(failure: LatchwayHTTPResponseError(statusCode: 502, requestID: "req_12345678"))
        let store = LatchwayBridgeStore()
        try await store.register(clientID: "rn-ios-conformance", context: native)
        do {
            try await refresh(LatchwayNativeBridge(store: store))
            XCTFail("Expected invalid response rejection")
        } catch let failure as BridgeFailure {
            XCTAssertEqual(failure.code, "response_invalid")
            XCTAssertEqual(failure.error?.userInfo["requestID"] as? String, "req_12345678")
            XCTAssertEqual(failure.error?.userInfo["status"] as? Int, 502)
        }
        await store.invalidate()
    }

    func testCallerCannotSelectAppleEvidenceEnvironmentThroughTheNativeBridge() async throws {
        let store = LatchwayBridgeStore()
        for key in ["appAttestEnvironment", "environment", "allowTestingResponses", "isTestingResponse"] {
            let encoded = """
            {"operation":"configure","identityMode":"supplied",
             "baseURL":"https://gateway.example.test","applicationID":"app_01J00000000000000000000000",
             "environment":"development","apple":{"\(key)":"any"}}
            """
            do {
                _ = try await store.appCommand(encoded)
                XCTFail("An evidence-policy option crossed the native boundary")
            } catch {
                XCTAssertEqual(error as? LatchwayLifecycleError, .configurationConflict)
            }
        }
        await store.invalidate()
    }

    func testRuntimeInvalidationClosesOnlyOwnedLeasesAndRejectsLaterCommands() async throws {
        let native = RecordingNativeClient()
        let store = LatchwayBridgeStore()
        try await store.register(clientID: "owned", context: native)
        await store.invalidate()
        await store.invalidate()
        let events = await native.events()
        XCTAssertEqual(events, [.close])
        do {
            try await store.register(clientID: "late", context: native)
            XCTFail("Invalidated runtime reopened")
        } catch { XCTAssertEqual(error as? LatchwayLifecycleError, .disposed) }
        do {
            _ = try await store.configureComponent(clientID: "late-component",
                encodedConfiguration: "{}", encodedComponent: "{}")
            XCTFail("Invalidated runtime reopened a component")
        } catch { XCTAssertEqual(error as? LatchwayLifecycleError, .disposed) }
        do {
            _ = try await store.appCommand(#"{"operation":"get"}"#)
            XCTFail("Invalidated runtime accepted a command")
        } catch { XCTAssertEqual(error as? LatchwayLifecycleError, .disposed) }
    }

    func testFWAUTH101And102PublicBridgeDispatchesThroughRegisteredNativeLease() async throws {
        let native = RecordingNativeClient()
        let store = LatchwayBridgeStore()
        try await store.register(clientID: "rn-ios-conformance", context: native)
        let bridge = LatchwayNativeBridge(store: store)

        let request = #"{"url":"https://gateway.example.test/v1/responses","method":"POST","feature":"assistant","headers":[]}"#
        let response = try await startRequest(
            bridge,

            requestJSON: request
        )

        XCTAssertEqual(response, RecordingNativeClient.responseMetadata)
        let events = await native.events()
        XCTAssertEqual(
            events,
            [.start(requestJSON: request)]
        )
    }

    func testFWAUTH103And104PublicBridgeRefreshNeverAcceptsIdentity() async throws {
        let native = RecordingNativeClient()
        let store = LatchwayBridgeStore()
        try await store.register(clientID: "rn-ios-conformance", context: native)
        let bridge = LatchwayNativeBridge(store: store)

        try await refresh(bridge)

        let events = await native.events()
        XCTAssertEqual(
            events,
            [.refresh]
        )
    }

    func testFWAUTH105And106PublicBridgeForwardsFamilyAndComponentRevocation() async throws {
        let native = RecordingNativeClient()
        let store = LatchwayBridgeStore()
        try await store.register(clientID: "rn-ios-conformance", context: native)
        let bridge = LatchwayNativeBridge(store: store)
        let component = #"{"definitionID":"intent","kind":"app_intent_extension","keychainAccessGroup":"ABCDE12345.dev.latchway.shared","requestedFeatures":["assistant"]}"#

        try await revokeFamily(bridge)
        try await revokeComponent(
            bridge,

            componentJSON: component
        )

        let events = await native.events()
        XCTAssertEqual(
            events,
            [
                .revokeFamily,
                .revokeComponent(componentJSON: component),
            ]
        )
    }

    func testFWBEH104PublicBridgeKeepsFrameworkRetryInsideNativeTransport() async throws {
        let native = RecordingNativeClient()
        let store = LatchwayBridgeStore()
        try await store.register(clientID: "rn-ios-conformance", context: native)
        let bridge = LatchwayNativeBridge(store: store)
        let request = #"{"url":"https://gateway.example.test/v1/responses","method":"POST","feature":"assistant","headers":[]}"#

        _ = try await startRequest(
            bridge,

            requestJSON: request
        )

        let startCount = await native.startCount()
        let events = await native.events()
        XCTAssertEqual(startCount, 1)
        XCTAssertEqual(
            events,
            [.start(requestJSON: request)]
        )
    }

    func testFWSEC103ProductionTargetValidatorRevalidatesEveryRedirectDestination() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://gateway.example.test"))
        let allowed = try XCTUnwrap(URL(string: "https://gateway.example.test/v1/responses"))
        let foreignOrigin = try XCTUnwrap(URL(string: "https://attacker.example/v1/responses"))
        let downgraded = try XCTUnwrap(URL(string: "http://gateway.example.test/v1/responses"))
        let wrongPort = try XCTUnwrap(URL(string: "https://gateway.example.test:444/v1/responses"))
        let credentialed = try XCTUnwrap(URL(string: "https://user@gateway.example.test/v1/responses"))
        let wrongPath = try XCTUnwrap(URL(string: "https://gateway.example.test/admin"))

        XCTAssertTrue(targetHasSameAllowedOriginAndPath(
            baseURL: baseURL,
            target: allowed,
            method: "POST",
            feature: "assistant"
        ))
        for destination in [foreignOrigin, downgraded, wrongPort, credentialed, wrongPath] {
            XCTAssertFalse(targetHasSameAllowedOriginAndPath(
                baseURL: baseURL,
                target: destination,
                method: "POST",
                feature: "assistant"
            ))
        }
    }

    func testDisposingComponentAwaitsItsLeaseCloseAndLeavesRootUsable() async throws {
        let native = RecordingNativeClient()
        let component = RecordingNativeComponent()
        let store = LatchwayBridgeStore(makeComponent: { _, _ in component })
        try await store.register(clientID: "rn-ios-conformance", context: native)
        let bridge = LatchwayNativeBridge(store: store)
        let componentJSON = #"{"definitionID":"action","kind":"action_extension","keychainAccessGroup":"ABCDE12345.dev.latchway.shared","requestedFeatures":["assistant"]}"#
        let configuration = #"{"baseURL":"https://gateway.example.test","applicationID":"app_01J00000000000000000000000","environment":"production","appVersion":"1.0.0","sdkVersion":"1.2.0","contractVersion":"1.1.0","protocolVersion":3,"nativeAppABI":3,"allowInsecureLoopback":false,"account":"\#(Self.componentAccount)"}"#
        _ = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            bridge.configureComponent(clientID: "child", configurationJSON: configuration, componentJSON: componentJSON,
                resolve: { continuation.resume(returning: $0) },
                reject: { code, message, error in continuation.resume(throwing: BridgeFailure(code: code, message: message, error: error)) })
        }
        try await dispose(bridge, clientID: "child")
        let count = await component.closeCount()
        XCTAssertEqual(count, 1)
        try await dispose(bridge, clientID: "child")
        let repeated = await component.closeCount()
        XCTAssertEqual(repeated, 1)
        _ = try await startRequest(bridge, requestJSON: "{}")
        let events = await native.events()
        XCTAssertEqual(events, [.start(requestJSON: "{}")])
    }

    private static var componentAccount: String {
        let payload = ["generationID": "58da9766-77db-42a0-a4dd-b0f71abae5db",
            "appScope": String(repeating: "a", count: 64), "accountScope": String(repeating: "b", count: 64)]
        return try! JSONSerialization.data(withJSONObject: payload).base64EncodedString()
    }

    func testFreshComponentConfigurationRejectsOldABIAndUnscopedOrOversharingHandoffs() throws {
        let config: [String: Any] = ["baseURL": "https://gateway.example.test",
            "applicationID": "app_01J00000000000000000000000", "environment": "production",
            "appVersion": "1.2.0", "sdkVersion": "1.2.0", "contractVersion": "1.1.0",
            "protocolVersion": 3, "nativeAppABI": 3, "allowInsecureLoopback": false, "account": Self.componentAccount]
        func encoded(_ changes: [String: Any]) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: config.merging(changes) { _, new in new }), as: UTF8.self)
        }
        XCTAssertNoThrow(try NativeComponentConfiguration.decode(encoded([:])))
        for changes: [String: Any] in [["nativeAppABI": 2], ["account": "e30="], ["apple": [:]],
            ["account": "not-base64"], ["account": String(repeating: "a", count: 4097)]] {
            XCTAssertThrowsError(try NativeComponentConfiguration.decode(encoded(changes)))
        }
    }

    func testCurrentComponentDescriptorsRequireExplicitNativeGroups() throws {
        let component = #"{"definitionID":"intent","kind":"app_intent_extension","keychainAccessGroup":"ABCDE12345.dev.latchway.shared","requestedFeatures":["assistant"]}"#
        let groups: Set<String> = ["ABCDE12345.dev.latchway.shared"]
        XCTAssertEqual(try NativeHostComponentInput.decodeMany("[\(component)]", sharedKeychainAccessGroups: groups).count, 1)
        XCTAssertThrowsError(try NativeHostComponentInput.decodeMany("[\(component)]", sharedKeychainAccessGroups: []))
        XCTAssertThrowsError(try NativeHostComponentInput.decodeMany("[]", sharedKeychainAccessGroups: groups))
        XCTAssertThrowsError(try NativeHostComponentInput.decodeMany("[\(component),\(component)]", sharedKeychainAccessGroups: groups))
    }

    private func dispose(_ bridge: LatchwayNativeBridge, clientID: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            bridge.dispose(clientID: clientID, resolve: { continuation.resume() },
                reject: { code, message, error in continuation.resume(throwing: BridgeFailure(code: code, message: message, error: error)) })
        }
    }

    private func startRequest(
        _ bridge: LatchwayNativeBridge,
        requestJSON: String
    ) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            bridge.startRequest(
                clientID: "rn-ios-conformance",
                operationID: "request-\(UUID().uuidString)",
                requestJSON: requestJSON,
                resolve: { continuation.resume(returning: $0) },
                reject: { code, message, error in
                    continuation.resume(throwing: BridgeFailure(code: code, message: message, error: error))
                }
            )
        }
    }

    private func refresh(_ bridge: LatchwayNativeBridge) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            bridge.refresh(
                clientID: "rn-ios-conformance",
                operationID: "refresh-\(UUID().uuidString)",
                resolve: { continuation.resume() },
                reject: { code, message, error in
                    continuation.resume(throwing: BridgeFailure(code: code, message: message, error: error))
                }
            )
        }
    }

    private func revokeFamily(_ bridge: LatchwayNativeBridge) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            bridge.revokeFamily(
                clientID: "rn-ios-conformance",
                operationID: "family-\(UUID().uuidString)",
                resolve: { continuation.resume() },
                reject: { code, message, error in
                    continuation.resume(throwing: BridgeFailure(code: code, message: message, error: error))
                }
            )
        }
    }

    private func revokeComponent(
        _ bridge: LatchwayNativeBridge,
        componentJSON: String
    ) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            bridge.revokeComponent(
                clientID: "rn-ios-conformance",
                operationID: "component-\(UUID().uuidString)",
                componentJSON: componentJSON,
                resolve: { continuation.resume() },
                reject: { code, message, error in
                    continuation.resume(throwing: BridgeFailure(code: code, message: message, error: error))
                }
            )
        }
    }


}

private struct BridgeFailure: Error, @unchecked Sendable {
    let code: String
    let message: String
    let error: NSError?
}

private actor RecordingNativeClient: NativeClientOperating {
    enum Event: Equatable, Sendable {
        case start(requestJSON: String)
        case refresh
        case revokeFamily
        case revokeComponent(componentJSON: String)
        case close
    }

    static let responseMetadata = #"{"responseID":"rsp_fixture","status":200,"statusText":"","headers":[]}"#
    private var recordedEvents: [Event] = []
    private let failure: (any Error)?

    init(failure: (any Error)? = nil) { self.failure = failure }

    func events() -> [Event] { recordedEvents }
    func startCount() -> Int { recordedEvents.filter { if case .start = $0 { true } else { false } }.count }

    func startRequest(encoded: String) async throws -> String {
        recordedEvents.append(.start(requestJSON: encoded))
        return Self.responseMetadata
    }

    func readResponseChunk(responseID _: String, maximumBytes _: Double) async throws -> String {
        #"{"done":true}"#
    }

    func closeResponse(responseID _: String) async {}
    func close() async { recordedEvents.append(.close) }
    func quota(feature _: String) async throws -> String { "{}" }
    func diagnostics() async throws -> String { "{}" }

    func refresh() async throws {
        recordedEvents.append(.refresh)
        if let failure { throw failure }
    }

    func prepareComponents(encoded _: String) async throws -> String { "{}" }

    func revokeComponent(encoded: String) async throws {
        recordedEvents.append(.revokeComponent(componentJSON: encoded))
    }

    func replaceComponent(encoded _: String) async throws -> String { "{}" }
    func componentDiagnostics(encoded _: String) async throws -> String { "{}" }
    func revokeCurrentInstallation() async throws {}

    func revokeCurrentInstallationFamily() async throws {
        recordedEvents.append(.revokeFamily)
    }

}

private actor RecordingNativeComponent: NativeComponentOperating {
    private var closed = 0
    func diagnostics() async throws -> String { "{}" }
    func close() async { closed += 1 }
    func closeCount() -> Int { closed }
}
