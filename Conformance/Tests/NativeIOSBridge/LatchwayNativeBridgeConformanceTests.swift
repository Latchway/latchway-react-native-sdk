import Foundation
import Latchway
@testable import LatchwayReactNativeBridge
import XCTest

final class LatchwayNativeBridgeConformanceTests: XCTestCase {
    func testRuntimeInvalidationClosesOnlyOwnedLeasesAndRejectsLaterCommands() async throws {
        let native = RecordingNativeClient()
        let store = LatchwayBridgeStore(makeClient: { _ in native })
        _ = try await store.configure(clientID: "owned", encoded: Self.configurationJSON)
        await store.invalidate()
        await store.invalidate()
        let events = await native.events()
        XCTAssertEqual(events, [.close])
        do {
            _ = try await store.configure(clientID: "late", encoded: Self.configurationJSON)
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

    func testFWAUTH101And102PublicBridgeConfiguresAndDispatchesNativeRequest() async throws {
        let native = RecordingNativeClient()
        let bridge = LatchwayNativeBridge(makeClient: { _ in native })

        let metadata = try await configure(bridge)
        let metadataObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(metadata.utf8)) as? [String: Any]
        )
        XCTAssertEqual(metadataObject["platform"] as? String, "react_native_ios")

        let request = #"{"url":"https://gateway.example.test/v1/responses","method":"POST","feature":"assistant","headers":[]}"#
        let response = try await startRequest(
            bridge,
            identityToken: "identity-bootstrap-token",
            requestJSON: request
        )

        XCTAssertEqual(response, RecordingNativeClient.responseMetadata)
        let events = await native.events()
        XCTAssertEqual(
            events,
            [.start(identityToken: "identity-bootstrap-token", requestJSON: request)]
        )
    }

    func testFWAUTH103And104PublicBridgeForwardsFreshIdentityToExplicitRefresh() async throws {
        let native = RecordingNativeClient()
        let bridge = LatchwayNativeBridge(makeClient: { _ in native })
        _ = try await configure(bridge)

        try await refresh(bridge, identityToken: "fresh-external-identity")

        let events = await native.events()
        XCTAssertEqual(
            events,
            [.refresh(identityToken: "fresh-external-identity")]
        )
    }

    func testFWAUTH105And106PublicBridgeForwardsFamilyAndComponentRevocation() async throws {
        let native = RecordingNativeClient()
        let bridge = LatchwayNativeBridge(makeClient: { _ in native })
        _ = try await configure(bridge)
        let component = #"{"definitionID":"intent","kind":"app_intent_extension","keychainAccessGroup":"ABCDE12345.dev.latchway.shared","requestedFeatures":["assistant"]}"#

        try await revokeFamily(bridge, identityToken: "family-identity")
        try await revokeComponent(
            bridge,
            identityToken: "component-identity",
            componentJSON: component
        )

        let events = await native.events()
        XCTAssertEqual(
            events,
            [
                .revokeFamily(identityToken: "family-identity"),
                .revokeComponent(identityToken: "component-identity", componentJSON: component),
            ]
        )
    }

    func testFWBEH104PublicBridgeKeepsFrameworkRetryInsideNativeTransport() async throws {
        let native = RecordingNativeClient()
        let bridge = LatchwayNativeBridge(makeClient: { _ in native })
        _ = try await configure(bridge)
        let request = #"{"url":"https://gateway.example.test/v1/responses","method":"POST","feature":"assistant","headers":[]}"#

        _ = try await startRequest(
            bridge,
            identityToken: "retry-identity",
            requestJSON: request
        )

        let startCount = await native.startCount()
        let events = await native.events()
        XCTAssertEqual(startCount, 1)
        XCTAssertEqual(
            events,
            [.start(identityToken: "retry-identity", requestJSON: request)]
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

    func testLegacyComponentInventoryDoesNotRequireResupplyingInheritedRootCopyGroups() throws {
        let component = #"{"definitionID":"intent","kind":"app_intent_extension","keychainAccessGroup":"ABCDE12345.dev.latchway.shared","requestedFeatures":["assistant"]}"#
        // This is the exact decoder used by configure when legacy root-copy
        // groups are omitted. The native registry owns immutable inheritance.
        let inventory = try NativeHostComponentInput.decodeLegacyInventory("[\(component)]")
        XCTAssertEqual(inventory.map(\.keychainAccessGroup), ["ABCDE12345.dev.latchway.shared"])
        XCTAssertEqual(try NativeHostComponentInput.decodeLegacyInventory("[]"), [])
        // Current provisioning still requires explicit native-authorized groups.
        XCTAssertThrowsError(try NativeHostComponentInput.decodeMany("[\(component)]", sharedKeychainAccessGroups: []))
        XCTAssertEqual(try NativeHostComponentInput.decodeMany("[\(component)]",
            sharedKeychainAccessGroups: ["ABCDE12345.dev.latchway.shared"]), inventory)
        XCTAssertThrowsError(try NativeHostComponentInput.decodeLegacyInventory("[\(component),\(component)]"))
        XCTAssertThrowsError(try NativeHostComponentInput.decodeLegacyInventory(
            "[\(component.replacingOccurrences(of: "ABCDE12345.dev.latchway.shared", with: "*"))]"))
    }

    func testDisposingComponentAwaitsItsLeaseCloseAndLeavesRootUsable() async throws {
        let native = RecordingNativeClient()
        let component = RecordingNativeComponent()
        let bridge = LatchwayNativeBridge(makeClient: { _ in native }, makeComponent: { _, _ in component })
        _ = try await configure(bridge)
        let componentJSON = #"{"definitionID":"action","kind":"action_extension","keychainAccessGroup":"ABCDE12345.dev.latchway.shared","requestedFeatures":["assistant"]}"#
        let configuration = #"{"baseURL":"https://gateway.example.test","applicationID":"app_01J00000000000000000000000","environment":"production","appVersion":"1.0.0","sdkVersion":"1.2.0","contractVersion":"1.1.0","protocolVersion":2,"allowInsecureLoopback":false,"apple":{"rootKeychainAccessGroup":"ABCDE12345.dev.latchway.example","legacySharedKeychainAccessGroups":["ABCDE12345.dev.latchway.shared"],"softwareKeyFallbackPolicy":"allow"}}"#
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
        _ = try await startRequest(bridge, identityToken: "root-still-active", requestJSON: "{}")
        let events = await native.events()
        XCTAssertEqual(events, [.start(identityToken: "root-still-active", requestJSON: "{}")])
    }

    private func dispose(_ bridge: LatchwayNativeBridge, clientID: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            bridge.dispose(clientID: clientID, resolve: { continuation.resume() },
                reject: { code, message, error in continuation.resume(throwing: BridgeFailure(code: code, message: message, error: error)) })
        }
    }

    private func configure(_ bridge: LatchwayNativeBridge) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            bridge.configure(
                clientID: "rn-ios-conformance",
                configurationJSON: Self.configurationJSON,
                resolve: { continuation.resume(returning: $0) },
                reject: { code, message, error in
                    continuation.resume(throwing: BridgeFailure(code: code, message: message, error: error))
                }
            )
        }
    }

    private func startRequest(
        _ bridge: LatchwayNativeBridge,
        identityToken: String,
        requestJSON: String
    ) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            bridge.startRequest(
                clientID: "rn-ios-conformance",
                operationID: "request-\(UUID().uuidString)",
                identityToken: identityToken,
                requestJSON: requestJSON,
                resolve: { continuation.resume(returning: $0) },
                reject: { code, message, error in
                    continuation.resume(throwing: BridgeFailure(code: code, message: message, error: error))
                }
            )
        }
    }

    private func refresh(_ bridge: LatchwayNativeBridge, identityToken: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            bridge.refresh(
                clientID: "rn-ios-conformance",
                operationID: "refresh-\(UUID().uuidString)",
                identityToken: identityToken,
                resolve: { continuation.resume() },
                reject: { code, message, error in
                    continuation.resume(throwing: BridgeFailure(code: code, message: message, error: error))
                }
            )
        }
    }

    private func revokeFamily(_ bridge: LatchwayNativeBridge, identityToken: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            bridge.revokeFamily(
                clientID: "rn-ios-conformance",
                operationID: "family-\(UUID().uuidString)",
                identityToken: identityToken,
                resolve: { continuation.resume() },
                reject: { code, message, error in
                    continuation.resume(throwing: BridgeFailure(code: code, message: message, error: error))
                }
            )
        }
    }

    private func revokeComponent(
        _ bridge: LatchwayNativeBridge,
        identityToken: String,
        componentJSON: String
    ) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            bridge.revokeComponent(
                clientID: "rn-ios-conformance",
                operationID: "component-\(UUID().uuidString)",
                identityToken: identityToken,
                componentJSON: componentJSON,
                resolve: { continuation.resume() },
                reject: { code, message, error in
                    continuation.resume(throwing: BridgeFailure(code: code, message: message, error: error))
                }
            )
        }
    }

    private static let configurationJSON = #"{"baseURL":"https://gateway.example.test","applicationID":"app_01J00000000000000000000000","environment":"production","identityProvider":"custom_jwt","appVersion":"1.0.0","sdkVersion":"1.2.0","frameworkID":"react-native-fetch","frameworkVersion":"0.82.0","contractVersion":"1.1.0","protocolVersion":2,"allowInsecureLoopback":false,"apple":{"appAttestEnabled":false,"rootKeychainAccessGroup":"ABCDE12345.dev.latchway.example","legacySharedKeychainAccessGroups":[],"softwareKeyFallbackPolicy":"allow"},"android":{"keyPolicy":"strongbox_preferred"}}"#
}

private struct BridgeFailure: Error, @unchecked Sendable {
    let code: String
    let message: String
    let error: NSError?
}

private actor RecordingNativeClient: NativeClientOperating {
    enum Event: Equatable, Sendable {
        case start(identityToken: String, requestJSON: String)
        case refresh(identityToken: String)
        case revokeFamily(identityToken: String)
        case revokeComponent(identityToken: String, componentJSON: String)
        case close
    }

    static let responseMetadata = #"{"responseID":"rsp_fixture","status":200,"statusText":"","headers":[]}"#
    private var recordedEvents: [Event] = []

    func events() -> [Event] { recordedEvents }
    func startCount() -> Int { recordedEvents.filter { if case .start = $0 { true } else { false } }.count }

    func startRequest(identityToken: String, encoded: String) async throws -> String {
        recordedEvents.append(.start(identityToken: identityToken, requestJSON: encoded))
        return Self.responseMetadata
    }

    func readResponseChunk(responseID _: String, maximumBytes _: Double) async throws -> String {
        #"{"done":true}"#
    }

    func closeResponse(responseID _: String) async {}
    func close() async { recordedEvents.append(.close) }
    func quota(identityToken _: String, feature _: String) async throws -> String { "{}" }
    func diagnostics(identityToken _: String) async throws -> String { "{}" }

    func refresh(identityToken: String) async throws {
        recordedEvents.append(.refresh(identityToken: identityToken))
    }

    func prepareComponents(identityToken _: String, encoded _: String) async throws -> String { "{}" }

    func revokeComponent(identityToken: String, encoded: String) async throws {
        recordedEvents.append(.revokeComponent(identityToken: identityToken, componentJSON: encoded))
    }

    func replaceComponent(identityToken _: String, encoded _: String) async throws -> String { "{}" }
    func componentDiagnostics(encoded _: String) async throws -> String { "{}" }
    func revokeCurrentInstallation(identityToken _: String) async throws {}

    func revokeCurrentInstallationFamily(identityToken: String) async throws {
        recordedEvents.append(.revokeFamily(identityToken: identityToken))
    }

    func revokeFamily(identityToken _: String, encoded _: String) async throws {}
}

private actor RecordingNativeComponent: NativeComponentOperating {
    private var closed = 0
    func establishDirectAttestation() async throws {}
    func diagnostics() async throws -> String { "{}" }
    func close() async { closed += 1 }
    func closeCount() -> Int { closed }
}
