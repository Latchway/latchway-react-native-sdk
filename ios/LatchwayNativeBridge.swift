@preconcurrency import Foundation
import Latchway
#if canImport(LatchwayAppAttest)
import LatchwayAppAttest
#endif

public typealias LatchwayResolveString = @Sendable (String) -> Void
public typealias LatchwayResolveVoid = @Sendable () -> Void
public typealias LatchwayReject = @Sendable (String, String, NSError?) -> Void

@objc(LatchwayNativeBridge)
public final class LatchwayNativeBridge: NSObject, @unchecked Sendable {
    private let store = LatchwayBridgeStore()

    @objc(configureWithClientID:configurationJSON:resolve:reject:)
    public func configure(
        clientID: String,
        configurationJSON: String,
        resolve: @escaping LatchwayResolveString,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do { resolve(try await store.configure(clientID: clientID, encoded: configurationJSON)) }
            catch { Self.reject(error, with: reject) }
        }
    }

    @objc(authorizeWithClientID:operationID:identityToken:requestJSON:resolve:reject:)
    public func authorize(
        clientID: String,
        operationID: String,
        identityToken: String,
        requestJSON: String,
        resolve: @escaping LatchwayResolveString,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                resolve(try await store.run(clientID: clientID, operationID: operationID) { context in
                    try await context.authorize(identityToken: identityToken, encoded: requestJSON)
                })
            } catch { Self.reject(error, with: reject) }
        }
    }

    @objc(refreshWithClientID:operationID:identityToken:resolve:reject:)
    public func refresh(
        clientID: String,
        operationID: String,
        identityToken: String,
        resolve: @escaping LatchwayResolveVoid,
        reject: @escaping LatchwayReject
    ) {
        runVoid(clientID: clientID, operationID: operationID, identityToken: identityToken, resolve: resolve, reject: reject) {
            try await $0.refresh()
        }
    }

    @objc(quotaWithClientID:operationID:identityToken:feature:resolve:reject:)
    public func quota(
        clientID: String,
        operationID: String,
        identityToken: String,
        feature: String,
        resolve: @escaping LatchwayResolveString,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                resolve(try await store.run(clientID: clientID, operationID: operationID) { context in
                    try await context.quota(identityToken: identityToken, feature: feature)
                })
            } catch { Self.reject(error, with: reject) }
        }
    }

    @objc(diagnosticsWithClientID:operationID:identityToken:resolve:reject:)
    public func diagnostics(
        clientID: String,
        operationID: String,
        identityToken: String,
        resolve: @escaping LatchwayResolveString,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                resolve(try await store.run(clientID: clientID, operationID: operationID) { context in
                    try await context.diagnostics(identityToken: identityToken)
                })
            } catch { Self.reject(error, with: reject) }
        }
    }

    @objc(revokeWithClientID:operationID:identityToken:resolve:reject:)
    public func revoke(
        clientID: String,
        operationID: String,
        identityToken: String,
        resolve: @escaping LatchwayResolveVoid,
        reject: @escaping LatchwayReject
    ) {
        runVoid(clientID: clientID, operationID: operationID, identityToken: identityToken, resolve: resolve, reject: reject) {
            try await $0.revokeCurrentInstallation()
        }
    }

    @objc(cancelWithClientID:operationID:)
    public func cancel(clientID: String, operationID: String) {
        Task { await store.cancel(clientID: clientID, operationID: operationID) }
    }

    @objc(disposeWithClientID:resolve:reject:)
    public func dispose(
        clientID: String,
        resolve: @escaping LatchwayResolveVoid,
        reject _: @escaping LatchwayReject
    ) {
        Task {
            await store.dispose(clientID: clientID)
            resolve()
        }
    }

    private func runVoid(
        clientID: String,
        operationID: String,
        identityToken: String,
        resolve: @escaping LatchwayResolveVoid,
        reject: @escaping LatchwayReject,
        operation: @escaping @Sendable (LatchwayClient) async throws -> Void
    ) {
        Task {
            do {
                _ = try await store.run(clientID: clientID, operationID: operationID) { context in
                    try await context.withIdentityToken(identityToken, operation: operation)
                    return true
                }
                resolve()
            } catch { Self.reject(error, with: reject) }
        }
    }

    private static func reject(_ error: Error, with reject: LatchwayReject) {
        let failure = NativeFailure(error)
        reject(failure.code, failure.message, NSError(
            domain: "dev.latchway.react-native",
            code: failure.status ?? 0,
            userInfo: compact([
                "code": failure.code,
                "requestID": failure.requestID as Any,
                "status": failure.status as Any,
                "retryable": failure.retryable,
            ])
        ))
    }
}

private actor LatchwayBridgeStore {
    private var clients: [String: NativeClientContext] = [:]
    private var cancellations: [String: @Sendable () -> Void] = [:]

    func configure(clientID: String, encoded: String) throws -> String {
        guard clients[clientID] == nil else { throw LatchwayError.invalidConfiguration("client identifier is already configured") }
        let configuration = try NativeConfiguration.decode(encoded)
        let context = try NativeClientContext(configuration: configuration)
        clients[clientID] = context
        return try jsonString([
            "platform": "react_native_ios",
            "nativeSDKVersion": LatchwayVersion.sdk,
            "contractVersion": LatchwayVersion.contract,
            "protocolVersion": LatchwayVersion.protocolVersion,
        ])
    }

    func run<T: Sendable>(
        clientID: String,
        operationID: String,
        operation: @escaping @Sendable (NativeClientContext) async throws -> T
    ) async throws -> T {
        guard let context = clients[clientID] else { throw LatchwayError.invalidConfiguration("client is not configured") }
        let key = "\(clientID)|\(operationID)"
        guard cancellations[key] == nil else { throw LatchwayError.invalidRequest("operation identifier is already active") }
        let task = Task { try await operation(context) }
        cancellations[key] = { task.cancel() }
        defer { cancellations.removeValue(forKey: key) }
        return try await task.value
    }

    func cancel(clientID: String, operationID: String) {
        cancellations["\(clientID)|\(operationID)"]?()
    }

    func dispose(clientID: String) {
        clients.removeValue(forKey: clientID)
        let prefix = "\(clientID)|"
        for key in cancellations.keys.filter({ $0.hasPrefix(prefix) }) {
            cancellations.removeValue(forKey: key)?()
        }
    }
}

private final class NativeClientContext: @unchecked Sendable {
    private let identity = TransientIdentityTokenProvider()
    private let operationLock = NativeOperationLock()
    private let client: LatchwayClient
    private let attestationProviderName: String?

    init(configuration: NativeConfiguration) throws {
        guard let baseURL = URL(string: configuration.baseURL) else {
            throw LatchwayError.invalidConfiguration("base URL is invalid")
        }
        let attestation: (any LatchwayAttestationProvider)?
        if configuration.apple.appAttestEnabled {
            if let namespace = configuration.apple.storageNamespace {
                attestation = LatchwayAppAttestProvider(storageNamespace: "\(namespace).react_native_ios")
            } else {
                attestation = LatchwayAppAttestProvider(
                    applicationID: configuration.applicationID,
                    environment: configuration.environment,
                    clientRuntime: .reactNativeIOS
                )
            }
        } else {
            attestation = nil
        }
        attestationProviderName = configuration.apple.appAttestEnabled ? "app_attest" : nil
        let fallback: LatchwaySoftwareKeyFallbackPolicy = configuration.apple.softwareKeyFallbackPolicy == "allow"
            ? .allowWhenSecureEnclaveUnavailable
            : .disallow
        let native = LatchwayConfiguration(
            baseURL: baseURL,
            applicationID: configuration.applicationID,
            environment: configuration.environment,
            identityProvider: configuration.identityProvider,
            clientRuntime: .reactNativeIOS,
            clientSDKVersion: configuration.sdkVersion,
            appVersion: configuration.appVersion,
            softwareKeyFallbackPolicy: fallback,
            attestationProvider: attestation
        )
        client = LatchwayClient(configuration: native, identityTokenProvider: identity)
    }

    func authorize(identityToken: String, encoded: String) async throws -> String {
        let input = try AuthorizationInput.decode(encoded)
        guard let url = URL(string: input.url) else { throw LatchwayError.invalidRequest("request URL is invalid") }
        return try await withIdentityToken(identityToken) { client in
            var request = URLRequest(url: url)
            request.httpMethod = input.method
            if let requestID = input.requestID {
                request.setValue(requestID, forHTTPHeaderField: "X-Latchway-Request-ID")
            }
            if let nonce = input.nonce {
                try await client.authorize(&request, feature: input.feature, nonce: nonce)
            } else {
                try await client.authorize(&request, feature: input.feature)
            }
            guard let authorization = request.value(forHTTPHeaderField: "Authorization"),
                  let proof = request.value(forHTTPHeaderField: "DPoP"),
                  let requestID = request.value(forHTTPHeaderField: "X-Latchway-Request-ID")
            else { throw LatchwayError.invalidServerResponse }
            return try jsonString([
                "authorization": authorization,
                "dpop": proof,
                "requestID": requestID,
            ])
        }
    }

    func quota(identityToken: String, feature: String) async throws -> String {
        try await withIdentityToken(identityToken) { client in
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            return String(decoding: try encoder.encode(try await client.quota(feature: feature)), as: UTF8.self)
        }
    }

    func diagnostics(identityToken: String) async throws -> String {
        try await withIdentityToken(identityToken) { client in
            let diagnostics = await client.diagnostics()
            return try jsonString([
                "contractVersion": diagnostics.contractVersion,
                "protocolVersion": diagnostics.protocolVersion,
                "keyStorage": diagnostics.keyStorage.rawValue,
                "attestation": compact([
                    "support": diagnostics.attestation.support.rawValue,
                    "provider": self.attestationProviderName as Any,
                    "lastOperation": diagnostics.attestation.lastOperation as Any,
                ]),
                "session": compact([
                    "state": diagnostics.sessionState.rawValue,
                    "expiresAt": diagnostics.sessionExpiresAt.map(iso8601) as Any,
                    "refreshAvailable": diagnostics.sessionExpiresAt != nil,
                ]),
                "installation": compact([
                    "id": diagnostics.installationID as Any,
                    "status": diagnostics.sessionState == .revoked ? "revoked" : "active",
                ]),
                "server": compact([
                    "version": diagnostics.serverVersion as Any,
                    "lastRequestID": diagnostics.lastRequestID as Any,
                ]),
                "lastErrorCode": diagnostics.lastErrorCode as Any,
            ])
        }
    }

    func refresh(identityToken: String) async throws {
        try await withIdentityToken(identityToken) { try await $0.refresh() }
    }

    func revokeCurrentInstallation(identityToken: String) async throws {
        try await withIdentityToken(identityToken) { try await $0.revokeCurrentInstallation() }
    }

    func withIdentityToken<T: Sendable>(
        _ token: String,
        operation: @escaping @Sendable (LatchwayClient) async throws -> T
    ) async throws -> T {
        guard !token.isEmpty, token.utf8.count <= 65_536,
              !token.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        else { throw LatchwayError.invalidRequest("identity token is invalid") }
        await operationLock.acquire()
        do {
            try Task.checkCancellation()
            await identity.set(token)
            let result = try await operation(client)
            await identity.clear()
            await operationLock.release()
            return result
        } catch {
            await identity.clear()
            await operationLock.release()
            throw error
        }
    }
}

private actor TransientIdentityTokenProvider: LatchwayIdentityTokenProvider {
    private var token: String?

    func set(_ value: String) { token = value }
    func clear() { token = nil }

    func identityToken() async throws -> String {
        guard let token else { throw LatchwayError.sessionUnavailable }
        return token
    }
}

private actor NativeOperationLock {
    private var held = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if !held {
            held = true
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        if waiters.isEmpty {
            held = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}

private struct NativeConfiguration: Decodable {
    struct Apple: Decodable {
        let appAttestEnabled: Bool
        let storageNamespace: String?
        let softwareKeyFallbackPolicy: String
    }

    let baseURL: String
    let applicationID: String
    let environment: String
    let identityProvider: String
    let appVersion: String
    let sdkVersion: String
    let contractVersion: String
    let protocolVersion: Int
    let apple: Apple

    static func decode(_ encoded: String) throws -> Self {
        let value = try decodeStrict(Self.self, encoded: encoded)
        guard value.contractVersion == LatchwayVersion.contract,
              value.protocolVersion == LatchwayVersion.protocolVersion
        else { throw LatchwayError.invalidConfiguration("contract version is incompatible") }
        return value
    }
}

private struct AuthorizationInput: Decodable {
    let url: String
    let method: String
    let feature: String
    let nonce: String?
    let requestID: String?

    static func decode(_ encoded: String) throws -> Self {
        try decodeStrict(Self.self, encoded: encoded)
    }
}

private struct NativeFailure {
    let code: String
    let message: String
    let requestID: String?
    let status: Int?
    let retryable: Bool

    init(_ error: Error) {
        if let error = error as? LatchwayError {
            switch error {
            case let .server(problem):
                code = problem.code.description
                message = sanitize(problem.detail)
                requestID = problem.requestID
                status = problem.status
                retryable = problem.retryable
            case .invalidConfiguration:
                code = "invalid_configuration"; message = "Latchway native configuration is invalid."
                requestID = nil; status = nil; retryable = false
            case .invalidRequest:
                code = "request_invalid"; message = "The native Latchway request is invalid."
                requestID = nil; status = nil; retryable = false
            case .secureEnclaveUnavailable:
                code = "key_unavailable"; message = "Required hardware-backed key storage is unavailable."
                requestID = nil; status = nil; retryable = false
            case .keyStorageFailure:
                code = "secure_state_unavailable"; message = "Secure Latchway state is unavailable."
                requestID = nil; status = nil; retryable = false
            case .attestationUnavailable:
                code = "attestation_unsupported"; message = "Required application attestation is unavailable."
                requestID = nil; status = nil; retryable = false
            case .invalidAttestationBinding:
                code = "attestation_invalid"; message = "The attestation challenge binding is invalid."
                requestID = nil; status = nil; retryable = false
            case .sessionUnavailable:
                code = "session_unavailable"; message = "A Latchway session is unavailable."
                requestID = nil; status = nil; retryable = true
            case .transportFailure:
                code = "network_unavailable"; message = "The Latchway control request failed."
                requestID = nil; status = nil; retryable = true
            case .invalidServerResponse:
                code = "response_invalid"; message = "Latchway returned an invalid native response."
                requestID = nil; status = nil; retryable = false
            case .cancelled:
                code = "cancelled"; message = "The Latchway native operation was cancelled."
                requestID = nil; status = nil; retryable = false
            }
        } else if error is CancellationError {
            code = "cancelled"; message = "The Latchway native operation was cancelled."
            requestID = nil; status = nil; retryable = false
        } else {
            code = "internal_error"; message = "The Latchway native operation failed."
            requestID = nil; status = nil; retryable = false
        }
    }
}

private func decodeStrict<T: Decodable>(_ type: T.Type, encoded: String) throws -> T {
    guard let data = encoded.data(using: .utf8), data.count <= 65_536 else {
        throw LatchwayError.invalidRequest("native input is invalid")
    }
    do { return try JSONDecoder().decode(type, from: data) }
    catch { throw LatchwayError.invalidRequest("native input is invalid") }
}

private func jsonString(_ value: [String: Any]) throws -> String {
    let compacted = compact(value)
    guard JSONSerialization.isValidJSONObject(compacted) else { throw LatchwayError.invalidServerResponse }
    return String(decoding: try JSONSerialization.data(withJSONObject: compacted, options: [.sortedKeys]), as: UTF8.self)
}

private func compact(_ value: [String: Any]) -> [String: Any] {
    value.compactMapValues { item in
        if let optional = item as? OptionalProtocol { return optional.wrapped }
        return item
    }
}

private protocol OptionalProtocol { var wrapped: Any? { get } }
extension Optional: OptionalProtocol { fileprivate var wrapped: Any? { self } }

private func iso8601(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

private func sanitize(_ value: String) -> String {
    let bounded = String(value.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f }.prefix(512))
    let markers = ["eyJ", "lwa_", "lws_", "refresh_token", "identity_token", "integrity_token"]
    if markers.contains(where: { bounded.localizedCaseInsensitiveContains($0) }) { return "Sensitive detail redacted." }
    return bounded.isEmpty ? "The Latchway native operation failed." : bounded
}
