@preconcurrency import Foundation
import Latchway
#if canImport(LatchwayAppAttest)
import LatchwayAppAttest
#endif

public typealias LatchwayResolveString = @Sendable (String) -> Void
public typealias LatchwayResolveVoid = @Sendable () -> Void
public typealias LatchwayReject = @Sendable (String, String, NSError?) -> Void

protocol NativeClientOperating: Sendable {
    func startRequest(identityToken: String, encoded: String) async throws -> String
    func readResponseChunk(responseID: String, maximumBytes: Double) async throws -> String
    func closeResponse(responseID: String) async
    func close() async
    func quota(identityToken: String, feature: String) async throws -> String
    func diagnostics(identityToken: String) async throws -> String
    func refresh(identityToken: String) async throws
    func prepareComponents(identityToken: String, encoded: String) async throws -> String
    func revokeComponent(identityToken: String, encoded: String) async throws
    func replaceComponent(identityToken: String, encoded: String) async throws -> String
    func componentDiagnostics(encoded: String) async throws -> String
    func revokeCurrentInstallation(identityToken: String) async throws
    func revokeCurrentInstallationFamily(identityToken: String) async throws
    func revokeFamily(identityToken: String, encoded: String) async throws
}

typealias NativeClientFactory = @Sendable (NativeConfiguration) throws -> any NativeClientOperating

@objc(LatchwayNativeBridge)
public final class LatchwayNativeBridge: NSObject, @unchecked Sendable {
    private let store: LatchwayBridgeStore

    public override init() {
        store = LatchwayBridgeStore { try NativeClientContext(configuration: $0) }
        super.init()
    }

    init(makeClient: @escaping NativeClientFactory) {
        store = LatchwayBridgeStore(makeClient: makeClient)
        super.init()
    }

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

    @objc(configureComponentWithClientID:configurationJSON:componentJSON:resolve:reject:)
    public func configureComponent(
        clientID: String,
        configurationJSON: String,
        componentJSON: String,
        resolve: @escaping LatchwayResolveString,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                resolve(try await store.configureComponent(
                    clientID: clientID,
                    encodedConfiguration: configurationJSON,
                    encodedComponent: componentJSON
                ))
            } catch { Self.reject(error, with: reject) }
        }
    }

    @objc(startRequestWithClientID:operationID:identityToken:requestJSON:resolve:reject:)
    public func startRequest(
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
                    try await context.startRequest(identityToken: identityToken, encoded: requestJSON)
                })
            } catch { Self.reject(error, with: reject) }
        }
    }

    @objc(readResponseChunkWithClientID:operationID:responseID:maximumBytes:resolve:reject:)
    public func readResponseChunk(
        clientID: String,
        operationID: String,
        responseID: String,
        maximumBytes: Double,
        resolve: @escaping LatchwayResolveString,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                resolve(try await store.run(clientID: clientID, operationID: operationID) { context in
                    try await context.readResponseChunk(responseID: responseID, maximumBytes: maximumBytes)
                })
            } catch { Self.reject(error, with: reject) }
        }
    }

    @objc(closeResponseWithClientID:responseID:resolve:reject:)
    public func closeResponse(
        clientID: String,
        responseID: String,
        resolve: @escaping LatchwayResolveVoid,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                try await store.closeResponse(clientID: clientID, responseID: responseID)
                resolve()
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
            try await $0.refresh(identityToken: $1)
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

    @objc(establishDirectAttestationWithClientID:operationID:resolve:reject:)
    public func establishDirectAttestation(
        clientID: String,
        operationID: String,
        resolve: @escaping LatchwayResolveVoid,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                _ = try await store.runComponent(clientID: clientID, operationID: operationID) { context in
                    try await context.establishDirectAttestation()
                    return true
                }
                resolve()
            } catch { Self.reject(error, with: reject) }
        }
    }

    @objc(componentDiagnosticsWithClientID:operationID:resolve:reject:)
    public func componentDiagnostics(
        clientID: String,
        operationID: String,
        resolve: @escaping LatchwayResolveString,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                resolve(try await store.runComponent(clientID: clientID, operationID: operationID) { context in
                    try await context.diagnostics()
                })
            } catch { Self.reject(error, with: reject) }
        }
    }

    @objc(prepareComponentsWithClientID:operationID:identityToken:componentsJSON:resolve:reject:)
    public func prepareComponents(
        clientID: String,
        operationID: String,
        identityToken: String,
        componentsJSON: String,
        resolve: @escaping LatchwayResolveString,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                resolve(try await store.run(clientID: clientID, operationID: operationID) { context in
                    try await context.prepareComponents(identityToken: identityToken, encoded: componentsJSON)
                })
            } catch { Self.reject(error, with: reject) }
        }
    }

    @objc(replaceComponentWithClientID:operationID:identityToken:componentJSON:resolve:reject:)
    public func replaceComponent(
        clientID: String,
        operationID: String,
        identityToken: String,
        componentJSON: String,
        resolve: @escaping LatchwayResolveString,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                resolve(try await store.run(clientID: clientID, operationID: operationID) { context in
                    try await context.replaceComponent(identityToken: identityToken, encoded: componentJSON)
                })
            } catch { Self.reject(error, with: reject) }
        }
    }

    @objc(rootComponentDiagnosticsWithClientID:operationID:componentJSON:resolve:reject:)
    public func rootComponentDiagnostics(
        clientID: String,
        operationID: String,
        componentJSON: String,
        resolve: @escaping LatchwayResolveString,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                resolve(try await store.run(clientID: clientID, operationID: operationID) { context in
                    try await context.componentDiagnostics(encoded: componentJSON)
                })
            } catch { Self.reject(error, with: reject) }
        }
    }

    @objc(revokeComponentWithClientID:operationID:identityToken:componentJSON:resolve:reject:)
    public func revokeComponent(
        clientID: String,
        operationID: String,
        identityToken: String,
        componentJSON: String,
        resolve: @escaping LatchwayResolveVoid,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                _ = try await store.run(clientID: clientID, operationID: operationID) { context in
                    try await context.revokeComponent(identityToken: identityToken, encoded: componentJSON)
                    return true
                }
                resolve()
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
            try await $0.revokeCurrentInstallation(identityToken: $1)
        }
    }

    @objc(revokeFamilyWithClientID:operationID:identityToken:resolve:reject:)
    public func revokeFamily(
        clientID: String,
        operationID: String,
        identityToken: String,
        resolve: @escaping LatchwayResolveVoid,
        reject: @escaping LatchwayReject
    ) {
        runVoid(clientID: clientID, operationID: operationID, identityToken: identityToken, resolve: resolve, reject: reject) {
            try await $0.revokeCurrentInstallationFamily(identityToken: $1)
        }
    }

    @objc(revokeFamilyWithComponentsWithClientID:operationID:identityToken:componentsJSON:resolve:reject:)
    public func revokeFamilyWithComponents(
        clientID: String,
        operationID: String,
        identityToken: String,
        componentsJSON: String,
        resolve: @escaping LatchwayResolveVoid,
        reject: @escaping LatchwayReject
    ) {
        Task {
            do {
                _ = try await store.run(clientID: clientID, operationID: operationID) { context in
                    try await context.revokeFamily(identityToken: identityToken, encoded: componentsJSON)
                    return true
                }
                resolve()
            } catch { Self.reject(error, with: reject) }
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
        operation: @escaping @Sendable (any NativeClientOperating, String) async throws -> Void
    ) {
        Task {
            do {
                _ = try await store.run(clientID: clientID, operationID: operationID) { context in
                    try await operation(context, identityToken)
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
                "documentationURL": failure.documentationURL,
                "requestID": failure.requestID as Any,
                "operationID": failure.operationID as Any,
                "status": failure.status as Any,
                "retryable": failure.retryable,
            ])
        ))
    }
}

private actor LatchwayBridgeStore {
    private let makeClient: NativeClientFactory
    private var clients: [String: any NativeClientOperating] = [:]
    private var componentClients: [String: NativeComponentContext] = [:]
    private var cancellations: [String: @Sendable () -> Void] = [:]

    init(makeClient: @escaping NativeClientFactory) {
        self.makeClient = makeClient
    }

    func configure(clientID: String, encoded: String) throws -> String {
        guard clients[clientID] == nil, componentClients[clientID] == nil else {
            throw LatchwayError.invalidConfiguration("client identifier is already configured")
        }
        let configuration = try NativeConfiguration.decode(encoded)
        let context = try makeClient(configuration)
        clients[clientID] = context
        return try jsonString([
            "platform": "react_native_ios",
            "nativeSDKVersion": LatchwayVersion.sdk,
            "contractVersion": LatchwayVersion.contract,
            "protocolVersion": LatchwayVersion.protocolVersion,
        ])
    }

    func configureComponent(
        clientID: String,
        encodedConfiguration: String,
        encodedComponent: String
    ) throws -> String {
        guard clients[clientID] == nil, componentClients[clientID] == nil else {
            throw LatchwayError.invalidConfiguration("client identifier is already configured")
        }
        let configuration = try NativeComponentConfiguration.decode(encodedConfiguration)
        let component = try NativeComponentInput.decode(encodedComponent)
        guard configuration.apple.legacySharedKeychainAccessGroups.contains(
            component.keychainAccessGroup
        ) else {
            throw LatchwayError.invalidConfiguration(
                "component Keychain access group is not shared by the containing root application"
            )
        }
        componentClients[clientID] = try NativeComponentContext(
            configuration: configuration,
            component: component
        )
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
        operation: @escaping @Sendable (any NativeClientOperating) async throws -> T
    ) async throws -> T {
        guard let context = clients[clientID] else { throw LatchwayError.invalidConfiguration("client is not configured") }
        let key = "\(clientID)|\(operationID)"
        guard cancellations[key] == nil else { throw LatchwayError.invalidRequest("operation identifier is already active") }
        let task = Task { try await operation(context) }
        cancellations[key] = { task.cancel() }
        defer { cancellations.removeValue(forKey: key) }
        return try await task.value
    }

    func runComponent<T: Sendable>(
        clientID: String,
        operationID: String,
        operation: @escaping @Sendable (NativeComponentContext) async throws -> T
    ) async throws -> T {
        guard let context = componentClients[clientID] else {
            throw LatchwayError.invalidConfiguration("component client is not configured")
        }
        let key = "\(clientID)|\(operationID)"
        guard cancellations[key] == nil else {
            throw LatchwayError.invalidRequest("operation identifier is already active")
        }
        let task = Task { try await operation(context) }
        cancellations[key] = { task.cancel() }
        defer { cancellations.removeValue(forKey: key) }
        return try await task.value
    }

    func cancel(clientID: String, operationID: String) {
        cancellations["\(clientID)|\(operationID)"]?()
    }

    func closeResponse(clientID: String, responseID: String) async throws {
        guard let context = clients[clientID] else {
            throw LatchwayError.invalidConfiguration("client is not configured")
        }
        await context.closeResponse(responseID: responseID)
    }

    func dispose(clientID: String) async {
        let context = clients.removeValue(forKey: clientID)
        componentClients.removeValue(forKey: clientID)
        let prefix = "\(clientID)|"
        for key in cancellations.keys.filter({ $0.hasPrefix(prefix) }) {
            cancellations.removeValue(forKey: key)?()
        }
        await context?.close()
    }
}

private final class NativeClientContext: NativeClientOperating, @unchecked Sendable {
    private let identity = TransientIdentityTokenProvider()
    private let operationLock = NativeOperationLock()
    private let client: LatchwayClient
    private let baseURL: URL
    private let frameworkVersion: String
    private let responses = NativeResponseRegistry()
    private let sharedKeychainAccessGroups: Set<String>

    init(configuration: NativeConfiguration) throws {
        let baseURL = try validatedNativeBaseURL(
            configuration.baseURL,
            allowInsecureLoopback: configuration.allowInsecureLoopback
        )
        self.baseURL = baseURL
        frameworkVersion = configuration.frameworkVersion
        sharedKeychainAccessGroups = Set(configuration.apple.legacySharedKeychainAccessGroups)
        let attestation: (any LatchwayAttestationProvider)?
        if configuration.apple.appAttestEnabled {
            if let namespace = configuration.apple.storageNamespace {
                attestation = LatchwayAppAttestProvider(
                    rootKeychainAccessGroup: configuration.apple.rootKeychainAccessGroup,
                    legacySharedKeychainAccessGroups: configuration.apple.legacySharedKeychainAccessGroups,
                    storageNamespace: "\(namespace).react_native_ios"
                )
            } else {
                attestation = LatchwayAppAttestProvider(
                    applicationID: configuration.applicationID,
                    environment: configuration.environment,
                    rootKeychainAccessGroup: configuration.apple.rootKeychainAccessGroup,
                    legacySharedKeychainAccessGroups: configuration.apple.legacySharedKeychainAccessGroups,
                    clientRuntime: .reactNativeIOS
                )
            }
        } else {
            attestation = nil
        }
        let fallback: LatchwaySoftwareKeyFallbackPolicy = configuration.apple.softwareKeyFallbackPolicy == "allow"
            ? .allowWhenSecureEnclaveUnavailable
            : .disallow
        let native = LatchwayConfiguration(
            baseURL: baseURL,
            applicationID: configuration.applicationID,
            environment: configuration.environment,
            rootKeychainAccessGroup: configuration.apple.rootKeychainAccessGroup,
            legacySharedKeychainAccessGroups: configuration.apple.legacySharedKeychainAccessGroups,
            identityProvider: configuration.identityProvider,
            clientRuntime: .reactNativeIOS,
            clientSDKVersion: configuration.sdkVersion,
            appVersion: configuration.appVersion,
            softwareKeyFallbackPolicy: fallback,
            attestationProvider: attestation
        )
        client = LatchwayClient(configuration: native, identityTokenProvider: identity)
    }

    func startRequest(identityToken: String, encoded: String) async throws -> String {
        let input = try NativeRequestInput.decode(encoded)
        guard let url = URL(string: input.url) else {
            throw LatchwayError.invalidRequest("request URL is invalid")
        }
        try validateTarget(baseURL: baseURL, target: url, method: input.method, feature: input.feature)
        var request = URLRequest(url: url)
        request.httpMethod = input.method
        request.httpBody = input.body
        for pair in input.headers {
            request.setValue(pair[1], forHTTPHeaderField: pair[0])
        }
        let preparedRequest = request
        return try await withIdentityToken(identityToken) { client in
            let stream = try await client.transport(
                feature: input.feature,
                framework: .reactNativeFetch(version: self.frameworkVersion)
            ).bytes(for: preparedRequest)
            do {
                try Task.checkCancellation()
                let response = stream.response
                guard (200 ... 599).contains(response.statusCode),
                      response.url.map({
                          targetHasSameAllowedOriginAndPath(
                              baseURL: self.baseURL,
                              target: $0,
                              method: input.method,
                              feature: input.feature
                          )
                      }) == true
                else {
                    throw LatchwayError.invalidServerResponse
                }
                let responseID = "rsp_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
                let handle = NativeResponseHandle(stream: stream)
                await self.responses.insert(handle, responseID: responseID)
                do {
                    return try responseMetadata(responseID: responseID, response: response)
                } catch {
                    await self.responses.close(responseID: responseID)
                    throw error
                }
            } catch let error as LatchwayError {
                stream.cancel()
                throw error
            } catch is CancellationError {
                stream.cancel()
                throw LatchwayError.cancelled
            } catch let error as URLError where error.code == .cancelled && Task.isCancelled {
                stream.cancel()
                throw LatchwayError.cancelled
            } catch {
                stream.cancel()
                throw LatchwayError.transportFailure
            }
        }
    }

    func readResponseChunk(responseID: String, maximumBytes: Double) async throws -> String {
        guard maximumBytes.isFinite,
              maximumBytes.rounded(.towardZero) == maximumBytes,
              (1 ... Double(maximumResponseChunkBytes)).contains(maximumBytes)
        else { throw LatchwayError.invalidRequest("response chunk limit is invalid") }
        guard let data = try await responses.read(responseID: responseID, maximumBytes: Int(maximumBytes)) else {
            return try jsonString(["done": true])
        }
        return try jsonString([
            "done": false,
            "chunk": data.base64EncodedString(),
        ])
    }

    func closeResponse(responseID: String) async {
        await responses.close(responseID: responseID)
    }

    func close() async {
        await responses.closeAll()
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
                    "provider": diagnostics.trustProvider as Any,
                    "trustLevel": diagnostics.trustLevel as Any,
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

    func prepareComponents(identityToken: String, encoded: String) async throws -> String {
        let components = try NativeHostComponentInput.decodeMany(
            encoded,
            sharedKeychainAccessGroups: sharedKeychainAccessGroups
        )
        let diagnostics = try await withIdentityToken(identityToken) { client in
            try await client.prepareComponents(components.map(\.configuration))
        }
        return try jsonString([
            "components": diagnostics.map(componentDiagnosticsDictionary),
        ])
    }

    func revokeComponent(identityToken: String, encoded: String) async throws {
        let component = try NativeHostComponentInput.decodeOne(
            encoded,
            sharedKeychainAccessGroups: sharedKeychainAccessGroups
        )
        try await withIdentityToken(identityToken) { client in
            try await client.revokeComponent(component.configuration)
        }
    }

    func replaceComponent(identityToken: String, encoded: String) async throws -> String {
        let component = try NativeHostComponentInput.decodeOne(
            encoded,
            sharedKeychainAccessGroups: sharedKeychainAccessGroups
        )
        let diagnostics = try await withIdentityToken(identityToken) { client in
            try await client.replaceComponent(component.configuration)
        }
        return try jsonString(componentDiagnosticsDictionary(diagnostics))
    }

    func componentDiagnostics(encoded: String) async throws -> String {
        let component = try NativeHostComponentInput.decodeOne(
            encoded,
            sharedKeychainAccessGroups: sharedKeychainAccessGroups
        )
        let diagnostics = await client.componentDiagnostics(component.configuration)
        return try jsonString(componentDiagnosticsDictionary(diagnostics))
    }

    func revokeCurrentInstallation(identityToken: String) async throws {
        try await withIdentityToken(identityToken) { try await $0.revokeCurrentInstallation() }
    }

    func revokeCurrentInstallationFamily(identityToken: String) async throws {
        // The native SDK discovers every prepared descriptor from its
        // root-private durable registry; JavaScript does not need to replay it.
        try await withIdentityToken(identityToken) { try await $0.revokeCurrentInstallationFamily() }
    }

    func revokeFamily(identityToken: String, encoded: String) async throws {
        let components = try NativeHostComponentInput.decodeMany(
            encoded,
            sharedKeychainAccessGroups: sharedKeychainAccessGroups
        )
        try await withIdentityToken(identityToken) { client in
            try await client.revokeCurrentInstallationFamily(retiring: components.map(\.configuration))
        }
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

private final class NativeComponentContext: @unchecked Sendable {
    private let client: LatchwayExtensionClient

    init(configuration: NativeComponentConfiguration, component input: NativeComponentInput) throws {
        guard isApplicationExtensionProcess() else {
            throw LatchwayComponentError.invalidConfiguration(
                "The React Native component client must run inside the signed iOS extension process"
            )
        }
        let baseURL = try validatedNativeBaseURL(
            configuration.baseURL,
            allowInsecureLoopback: configuration.allowInsecureLoopback
        )
        let fallback: LatchwaySoftwareKeyFallbackPolicy = configuration.apple.softwareKeyFallbackPolicy == "allow"
            ? .allowWhenSecureEnclaveUnavailable
            : .disallow
        let native = LatchwayConfiguration(
            baseURL: baseURL,
            applicationID: configuration.applicationID,
            environment: configuration.environment,
            rootKeychainAccessGroup: configuration.apple.rootKeychainAccessGroup,
            legacySharedKeychainAccessGroups: configuration.apple.legacySharedKeychainAccessGroups,
            identityProvider: "custom_jwt",
            clientRuntime: .reactNativeIOS,
            clientSDKVersion: configuration.sdkVersion,
            appVersion: configuration.appVersion,
            softwareKeyFallbackPolicy: fallback
        )
        let component = LatchwayComponentConfiguration(
            definitionID: input.definitionID,
            kind: input.kind,
            keychainAccessGroup: input.keychainAccessGroup,
            requestedFeatures: input.requestedFeatures
        )
        // DCAppAttestService.generateKey is unavailable to iOS application
        // extensions. Use the delegated-only public initializer so the .appex
        // cannot construct a direct App Attest provider or let its containing
        // application attest on its behalf.
        client = try LatchwayExtensionClient(
            configuration: native,
            component: component
        )
    }

    func establishDirectAttestation() async throws {
        try await client.establishDirectAttestation()
    }

    func diagnostics() async throws -> String {
        let diagnostics = await client.diagnostics()
        return try jsonString(componentDiagnosticsDictionary(diagnostics))
    }
}

private func isApplicationExtensionProcess(bundle: Bundle = .main) -> Bool {
    bundle.bundleURL.pathExtension == "appex"
        && bundle.object(forInfoDictionaryKey: "NSExtension") != nil
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

private actor NativeResponseRegistry {
    private var responses: [String: NativeResponseHandle] = [:]

    func insert(_ response: NativeResponseHandle, responseID: String) {
        responses[responseID] = response
    }

    func read(responseID: String, maximumBytes: Int) async throws -> Data? {
        guard let response = responses[responseID] else {
            throw LatchwayError.invalidRequest("native response handle is unavailable")
        }
        let data = try await response.read(maximumBytes: maximumBytes)
        if data == nil {
            responses.removeValue(forKey: responseID)
            await response.close()
        }
        return data
    }

    func close(responseID: String) async {
        guard let response = responses.removeValue(forKey: responseID) else { return }
        await response.close()
    }

    func closeAll() async {
        let active = Array(responses.values)
        responses.removeAll()
        for response in active { await response.close() }
    }
}

private actor NativeResponseHandle {
    private let stream: LatchwayStreamingResponse
    private var iterator: LatchwayAsyncBytes.AsyncIterator?
    private var exhausted = false
    private var closed = false

    init(stream: LatchwayStreamingResponse) {
        self.stream = stream
        iterator = stream.bytes.makeAsyncIterator()
    }

    func read(maximumBytes: Int) async throws -> Data? {
        if exhausted { return nil }
        guard !closed, var activeIterator = iterator else {
            throw LatchwayError.invalidRequest("native response handle is unavailable")
        }
        iterator = nil
        var result = Data()
        result.reserveCapacity(maximumBytes)
        do {
            while result.count < maximumBytes {
                try Task.checkCancellation()
                guard let byte = try await activeIterator.next() else {
                    exhausted = true
                    closed = true
                    iterator = nil
                    stream.finish()
                    return result.isEmpty ? nil : result
                }
                guard !closed else { throw LatchwayError.cancelled }
                result.append(byte)
                // A line boundary keeps SSE and NDJSON delivery incremental even
                // when the bridge requests a larger maximum chunk.
                if byte == 0x0A { break }
            }
            guard !closed else { throw LatchwayError.cancelled }
            iterator = activeIterator
            return result
        } catch let error as LatchwayError {
            closeNow()
            throw error
        } catch is CancellationError {
            closeNow()
            throw LatchwayError.cancelled
        } catch let error as URLError where error.code == .cancelled {
            closeNow()
            throw LatchwayError.cancelled
        } catch {
            closeNow()
            throw LatchwayError.transportFailure
        }
    }

    func close() {
        closeNow()
    }

    private func closeNow() {
        guard !closed else { return }
        closed = true
        iterator = nil
        stream.cancel()
    }
}

struct NativeConfiguration: Decodable {
    struct Apple: Decodable {
        let appAttestEnabled: Bool
        let rootKeychainAccessGroup: String
        let legacySharedKeychainAccessGroups: [String]
        let storageNamespace: String?
        let softwareKeyFallbackPolicy: String
    }

    let baseURL: String
    let applicationID: String
    let environment: String
    let identityProvider: String
    let appVersion: String
    let sdkVersion: String
    let frameworkID: String
    let frameworkVersion: String
    let contractVersion: String
    let protocolVersion: Int
    let allowInsecureLoopback: Bool
    let apple: Apple

    static func decode(_ encoded: String) throws -> Self {
        guard let data = encoded.data(using: .utf8), data.count <= 65_536,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == nativeConfigurationKeys,
              let apple = object["apple"] as? [String: Any],
              nativeAppleConfigurationRequiredKeys.isSubset(of: apple.keys),
              Set(apple.keys).isSubset(of: nativeAppleConfigurationKeys),
              let android = object["android"] as? [String: Any],
              nativeAndroidConfigurationRequiredKeys.isSubset(of: android.keys),
              Set(android.keys).isSubset(of: nativeAndroidConfigurationKeys)
        else { throw LatchwayError.invalidConfiguration("native configuration is invalid") }
        let value = try decodeStrict(Self.self, encoded: encoded)
        guard value.contractVersion == LatchwayVersion.contract,
              value.protocolVersion == LatchwayVersion.protocolVersion,
              value.frameworkID == reactNativeFrameworkID,
              value.frameworkVersion == reactNativeFrameworkVersion,
              value.apple.softwareKeyFallbackPolicy == "allow"
                || value.apple.softwareKeyFallbackPolicy == "disallow"
        else { throw LatchwayError.invalidConfiguration("contract version is incompatible") }
        try LatchwayRootKeychainPreflight.validateAccessGroups(
            rootKeychainAccessGroup: value.apple.rootKeychainAccessGroup,
            legacySharedKeychainAccessGroups: value.apple.legacySharedKeychainAccessGroups
        )
        return value
    }
}

private struct NativeComponentConfiguration: Decodable {
    struct Apple: Decodable {
        let rootKeychainAccessGroup: String
        let legacySharedKeychainAccessGroups: [String]
        let storageNamespace: String?
        let softwareKeyFallbackPolicy: String
    }

    let baseURL: String
    let applicationID: String
    let environment: String
    let appVersion: String
    let sdkVersion: String
    let contractVersion: String
    let protocolVersion: Int
    let allowInsecureLoopback: Bool
    let apple: Apple

    static func decode(_ encoded: String) throws -> Self {
        guard let data = encoded.data(using: .utf8), data.count <= 65_536,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == nativeComponentConfigurationKeys,
              let apple = object["apple"] as? [String: Any],
              nativeComponentAppleConfigurationRequiredKeys.isSubset(of: apple.keys),
              Set(apple.keys).isSubset(of: nativeComponentAppleConfigurationKeys)
        else { throw LatchwayError.invalidConfiguration("native component configuration is invalid") }
        let value = try decodeStrict(Self.self, encoded: encoded)
        guard value.contractVersion == LatchwayVersion.contract,
              value.protocolVersion == LatchwayVersion.protocolVersion,
              value.apple.softwareKeyFallbackPolicy == "allow"
                || value.apple.softwareKeyFallbackPolicy == "disallow"
        else { throw LatchwayError.invalidConfiguration("component contract version is incompatible") }
        try LatchwayRootKeychainPreflight.validateAccessGroups(
            rootKeychainAccessGroup: value.apple.rootKeychainAccessGroup,
            legacySharedKeychainAccessGroups: value.apple.legacySharedKeychainAccessGroups
        )
        return value
    }
}

private struct NativeComponentInput: Decodable, Equatable {
    let definitionID: String
    let kind: String
    let keychainAccessGroup: String
    let requestedFeatures: [String]

    static func decode(_ encoded: String) throws -> Self {
        guard let data = encoded.data(using: .utf8), data.count <= 65_536,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["definitionID", "kind", "keychainAccessGroup", "requestedFeatures"])
        else { throw LatchwayError.invalidRequest("native component descriptor is invalid") }
        let value = try decodeStrict(Self.self, encoded: encoded)
        guard matches(value.definitionID, pattern: "^[a-z][a-z0-9_-]{0,62}$"),
              reactNativeDirectAttestationComponentKinds.contains(value.kind),
              !value.requestedFeatures.isEmpty,
              value.requestedFeatures.count <= 256,
              Set(value.requestedFeatures).count == value.requestedFeatures.count,
              value.requestedFeatures.allSatisfy(validFeature)
        else { throw LatchwayError.invalidRequest("native component descriptor is invalid") }
        try LatchwayRootKeychainPreflight.validateAccessGroups(
            rootKeychainAccessGroup: value.keychainAccessGroup
        )
        return value
    }
}

private struct NativeHostComponentInput: Decodable, Equatable {
    let definitionID: String
    let kind: String
    let keychainAccessGroup: String
    let requestedFeatures: [String]

    var configuration: LatchwayComponentConfiguration {
        LatchwayComponentConfiguration(
            definitionID: definitionID,
            kind: kind,
            keychainAccessGroup: keychainAccessGroup,
            requestedFeatures: requestedFeatures
        )
    }

    static func decodeOne(
        _ encoded: String,
        sharedKeychainAccessGroups: Set<String>
    ) throws -> Self {
        guard let data = encoded.data(using: .utf8), data.count <= 65_536,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw LatchwayError.invalidRequest("native component descriptor is invalid") }
        try validateKeys(object)
        let value = try decodeStrict(Self.self, encoded: encoded)
        try validate(value, sharedKeychainAccessGroups: sharedKeychainAccessGroups)
        return value
    }

    static func decodeMany(
        _ encoded: String,
        sharedKeychainAccessGroups: Set<String>
    ) throws -> [Self] {
        guard let data = encoded.data(using: .utf8), data.count <= 65_536,
              let objects = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              !objects.isEmpty, objects.count <= 256
        else { throw LatchwayError.invalidRequest("native component descriptors are invalid") }
        try objects.forEach(validateKeys)
        let values = try decodeStrict([Self].self, encoded: encoded)
        try values.forEach { try validate($0, sharedKeychainAccessGroups: sharedKeychainAccessGroups) }
        guard Set(values.map(\.definitionID)).count == values.count else {
            throw LatchwayError.invalidRequest("native component definition IDs must be unique")
        }
        return values
    }

    private static func validateKeys(_ object: [String: Any]) throws {
        guard Set(object.keys) == Set(["definitionID", "kind", "keychainAccessGroup", "requestedFeatures"])
        else { throw LatchwayError.invalidRequest("native component descriptor is invalid") }
    }

    private static func validate(
        _ value: Self,
        sharedKeychainAccessGroups: Set<String>
    ) throws {
        guard matches(value.definitionID, pattern: "^[a-z][a-z0-9_-]{0,62}$"),
              nativeIOSComponentKinds.contains(value.kind),
              sharedKeychainAccessGroups.contains(value.keychainAccessGroup),
              !value.requestedFeatures.isEmpty,
              value.requestedFeatures.count <= 256,
              Set(value.requestedFeatures).count == value.requestedFeatures.count,
              value.requestedFeatures.allSatisfy(validFeature)
        else { throw LatchwayError.invalidRequest("native component descriptor is invalid") }
        try LatchwayRootKeychainPreflight.validateAccessGroups(
            rootKeychainAccessGroup: value.keychainAccessGroup
        )
    }
}

private struct NativeRequestInput: Decodable {
    let url: String
    let method: String
    let feature: String
    let headers: [[String]]
    let bodyBase64: String?

    var body: Data? {
        guard let bodyBase64 else { return nil }
        return Data(base64Encoded: bodyBase64)
    }

    static func decode(_ encoded: String) throws -> Self {
        guard let data = encoded.data(using: .utf8), data.count <= maximumNativeRequestBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw LatchwayError.invalidRequest("native request is invalid") }
        let required = Set(["url", "method", "feature", "headers"])
        let allowed = required.union(["bodyBase64"])
        guard required.isSubset(of: object.keys), Set(object.keys).isSubset(of: allowed) else {
            throw LatchwayError.invalidRequest("native request is invalid")
        }
        let value = try decodeStrict(Self.self, encoded: encoded, maximumBytes: maximumNativeRequestBytes)
        guard validMethod(value.method), validFeature(value.feature), value.headers.count <= maximumHeaders else {
            throw LatchwayError.invalidRequest("native request is invalid")
        }
        var headerBytes = 0
        for pair in value.headers {
            guard pair.count == 2 else { throw LatchwayError.invalidRequest("native request header is invalid") }
            let name = pair[0].lowercased()
            let headerValue = pair[1]
            guard validHeaderName(name), validHeaderValue(headerValue), !isForbiddenCredentialName(name) else {
                throw LatchwayError.invalidRequest("native request header is invalid")
            }
            headerBytes += name.utf8.count + headerValue.utf8.count
            guard headerBytes <= maximumHeaderBytes else {
                throw LatchwayError.invalidRequest("native request headers are too large")
            }
        }
        if let encodedBody = value.bodyBase64 {
            guard let body = Data(base64Encoded: encodedBody), body.count <= maximumRequestBodyBytes,
                  body.base64EncodedString() == encodedBody
            else { throw LatchwayError.invalidRequest("native request body is invalid") }
        }
        return value
    }
}

private func responseMetadata(responseID: String, response: HTTPURLResponse) throws -> String {
    var headers: [[String]] = []
    var headerBytes = 0
    for (rawName, rawValue) in response.allHeaderFields {
        guard let name = (rawName as? String)?.lowercased(), safeResponseHeaders.contains(name),
              let value = rawValue as? String
        else { continue }
        guard validHeaderValue(value) else { throw LatchwayError.invalidServerResponse }
        headerBytes += name.utf8.count + value.utf8.count
        guard headers.count < maximumHeaders, headerBytes <= maximumHeaderBytes else {
            throw LatchwayError.invalidServerResponse
        }
        headers.append([name, value])
    }
    return try jsonString([
        "responseID": responseID,
        "status": response.statusCode,
        "statusText": "",
        "headers": headers,
    ])
}

private func validatedNativeBaseURL(_ encoded: String, allowInsecureLoopback: Bool) throws -> URL {
    guard let url = URL(string: encoded),
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.user == nil, components.password == nil,
          components.percentEncodedPath == "/", components.percentEncodedQuery == nil,
          components.fragment == nil, let scheme = components.scheme?.lowercased(),
          let host = components.host?.lowercased()
    else { throw LatchwayError.invalidConfiguration("base URL is invalid") }
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
    guard scheme == "https" || (allowInsecureLoopback && loopback && scheme == "http") else {
        throw LatchwayError.invalidConfiguration("base URL transport is invalid")
    }
    return url
}

private func validateTarget(baseURL: URL, target: URL, method: String, feature: String) throws {
    guard targetHasSameAllowedOriginAndPath(
        baseURL: baseURL,
        target: target,
        method: method,
        feature: feature
    ) else {
        throw LatchwayError.invalidRequest("request destination is not an allowed Latchway data-plane URL")
    }
    guard let query = URLComponents(url: target, resolvingAgainstBaseURL: false)?.percentEncodedQuery else { return }
    for component in query.split(separator: "&", omittingEmptySubsequences: false) {
        let name = component.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        if isForbiddenCredentialName(decodedCredentialName(name)) {
            throw LatchwayError.invalidRequest("upstream provider credentials must not be supplied in the request URL")
        }
    }
}

func targetHasSameAllowedOriginAndPath(
    baseURL: URL,
    target: URL,
    method: String,
    feature: String
) -> Bool {
    guard let base = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
          let candidate = URLComponents(url: target, resolvingAgainstBaseURL: false),
          let baseScheme = base.scheme?.lowercased(), let candidateScheme = candidate.scheme?.lowercased(),
          let baseHost = base.host?.lowercased(), let candidateHost = candidate.host?.lowercased(),
          base.user == nil, base.password == nil, base.fragment == nil,
          candidate.user == nil, candidate.password == nil, candidate.fragment == nil,
          baseScheme == candidateScheme, baseHost == candidateHost,
          effectivePort(base) == effectivePort(candidate)
    else { return false }
    let normalizedMethod = method.uppercased()
    if normalizedMethod == "POST", allowedDataPlanePaths.contains(candidate.percentEncodedPath) {
        return true
    }
    let prefix = "/proxy/\(feature)/"
    guard opaqueDataPlaneMethods.contains(normalizedMethod), candidate.percentEncodedQuery == nil,
          candidate.percentEncodedPath.hasPrefix(prefix)
    else { return false }
    let remaining = String(candidate.percentEncodedPath.dropFirst(prefix.count))
    let lowerRemaining = remaining.lowercased()
    return (1 ... 2_048).contains(remaining.utf8.count)
        && remaining.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
            !$0.isEmpty && $0 != "." && $0 != ".."
        }
        && !lowerRemaining.contains("%2e")
        && !lowerRemaining.contains("%2f")
        && !lowerRemaining.contains("%5c")
        && !remaining.contains("\\")
        && !lowerRemaining.hasPrefix("http:")
        && !lowerRemaining.hasPrefix("https:")
}

private func effectivePort(_ components: URLComponents) -> Int? {
    if let port = components.port { return port }
    switch components.scheme?.lowercased() {
    case "https": return 443
    case "http": return 80
    default: return nil
    }
}

private func decodedCredentialName(_ value: String) -> String {
    var decoded = value
    for _ in 0 ..< 4 {
        guard let next = decoded.removingPercentEncoding, next != decoded else { break }
        decoded = next
    }
    if decoded.range(of: #"%[0-9A-Fa-f]{2}"#, options: .regularExpression) != nil {
        return "credential-encoded-name"
    }
    return decoded.lowercased()
}

private func isForbiddenCredentialName(_ value: String) -> Bool {
    let normalized = value.lowercased()
    if forbiddenRequestHeaders.contains(normalized) || forbiddenCredentialQueryNames.contains(normalized) { return true }
    let compact = normalized.replacingOccurrences(
        of: #"[^a-z0-9]"#,
        with: "",
        options: .regularExpression
    )
    if ["key", "token", "secret", "bearer", "cookie", "password", "passwd"].contains(compact) { return true }
    return forbiddenCredentialNameFragments.contains { compact.contains($0) }
}

private func validMethod(_ value: String) -> Bool {
    matches(value, pattern: #"^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$"#)
        && !forbiddenMethods.contains(value)
}

private func validFeature(_ value: String) -> Bool {
    matches(value, pattern: #"^[a-z][a-z0-9_-]{0,62}$"#)
}

private func validHeaderName(_ value: String) -> Bool {
    matches(value, pattern: #"^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$"#)
}

private func validHeaderValue(_ value: String) -> Bool {
    guard value.utf8.count <= maximumHeaderValueBytes else { return false }
    return !value.unicodeScalars.contains { scalar in
        (0x00 ... 0x08).contains(scalar.value)
            || (0x0A ... 0x1F).contains(scalar.value)
            || scalar.value == 0x7F
    }
}

private func matches(_ value: String, pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
}

private let maximumRequestBodyBytes = 8 * 1024 * 1024
private let maximumNativeRequestBytes = 12 * 1024 * 1024
private let maximumResponseChunkBytes = 32 * 1024
private let maximumHeaders = 128
private let maximumHeaderBytes = 128 * 1024
private let maximumHeaderValueBytes = 8 * 1024
private let nativeConfigurationKeys = Set([
    "baseURL", "applicationID", "environment", "identityProvider", "appVersion", "sdkVersion",
    "frameworkID", "frameworkVersion", "contractVersion", "protocolVersion",
    "allowInsecureLoopback", "apple", "android",
])
private let reactNativeFrameworkID = "react-native-fetch"
private let reactNativeFrameworkVersion = "0.82.0"
private let nativeAppleConfigurationRequiredKeys = Set([
    "appAttestEnabled", "rootKeychainAccessGroup", "legacySharedKeychainAccessGroups",
    "softwareKeyFallbackPolicy",
])
private let nativeAppleConfigurationKeys = nativeAppleConfigurationRequiredKeys.union(["storageNamespace"])
private let nativeAndroidConfigurationRequiredKeys = Set(["keyPolicy"])
private let nativeAndroidConfigurationKeys = nativeAndroidConfigurationRequiredKeys.union([
    "playIntegrityCloudProjectNumber",
])
private let nativeComponentConfigurationKeys = Set([
    "baseURL", "applicationID", "environment", "appVersion", "sdkVersion", "contractVersion",
    "protocolVersion", "allowInsecureLoopback", "apple",
])
private let nativeComponentAppleConfigurationRequiredKeys = Set([
    "rootKeychainAccessGroup", "legacySharedKeychainAccessGroups", "softwareKeyFallbackPolicy",
])
private let nativeComponentAppleConfigurationKeys = nativeComponentAppleConfigurationRequiredKeys.union([
    "storageNamespace",
])
private let forbiddenMethods = Set(["CONNECT", "TRACE", "TRACK"])
private let allowedDataPlanePaths = Set([
    "/v1/responses",
    "/v1/chat/completions",
    "/v1/embeddings",
    "/v1/messages",
])
private let opaqueDataPlaneMethods = Set(["GET", "POST", "PUT", "PATCH", "DELETE"])
private let reactNativeDirectAttestationComponentKinds = Set(["action_extension", "sso_extension"])
private let nativeIOSComponentKinds = Set([
    "widget", "share_extension", "app_intent_extension", "notification_service_extension",
    "action_extension", "sso_extension",
])
private let forbiddenRequestHeaders = Set([
    "authorization", "proxy-authorization", "api-key", "api_key", "apikey", "x-api-key",
    "openai-api-key", "openai_api_key", "x-openai-api-key", "anthropic-api-key", "anthropic_api_key",
    "x-goog-api-key", "x-goog_api_key", "access_token", "auth_token", "x-auth-token", "cookie", "connection",
    "content-length", "expect", "host", "key", "proxy-connection", "te", "trailer", "transfer-encoding",
    "token", "upgrade", "x-amz-credential", "x-amz-security-token", "x-amz-signature", "x-goog-credential",
    "x-goog-signature", "dpop", "dpop-nonce", "x-latchway-feature", "x-latchway-framework",
    "x-latchway-framework-version", "x-latchway-protocol-version", "x-latchway-request-id", "x-latchway-sdk",
    "x-latchway-sdk-version",
])
private let forbiddenCredentialQueryNames = forbiddenRequestHeaders.union([
    "refresh_token", "identity_token", "private_key", "client_data_hash", "request_hash", "integrity_token",
])
private let forbiddenCredentialNameFragments = [
    "authorization", "dpop", "apikey", "accesstoken", "authtoken", "refreshtoken", "identitytoken",
    "integritytoken", "sessiontoken", "privatekey", "clientsecret", "credential", "attestationevidence",
    "clientdatahash", "requesthash", "xamzsignature", "xgoogsignature",
]
private let safeResponseHeaders = Set([
    "accept-ranges", "age", "cache-control", "content-encoding", "content-language", "content-length",
    "content-range", "content-type", "date", "etag", "expires", "last-modified", "request-id", "retry-after",
    "server-timing", "vary", "x-request-id", "x-latchway-request-id", "x-latchway-server-version",
    "x-latchway-operation-id",
])

private struct NativeFailure {
    let code: String
    let documentationURL: String
    let message: String
    let requestID: String?
    let operationID: String?
    let status: Int?
    let retryable: Bool

    init(_ error: Error) {
        if let error = error as? LatchwayComponentError {
            switch error {
            case .containingAppSetupRequired:
                code = "containing_app_setup_required"; message = "The containing application must prepare this component."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .componentNotProvisioned:
                code = "component_not_provisioned"; message = "The component has not been provisioned."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .componentGrantExpired:
                code = "component_delegation_expired"; message = "The component delegation has expired."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .componentRevoked:
                code = "component_revoked"; message = "The component has been revoked."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .installationFamilyRevoked:
                code = "installation_family_revoked"; message = "The installation family has been revoked."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .parentTrustExpired:
                code = "component_parent_trust_expired"; message = "The component parent trust has expired."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .featureNotDelegated:
                code = "component_feature_not_granted"; message = "The feature was not delegated to this component."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .keychainAccessGroupUnavailable:
                code = "secure_state_unavailable"; message = "The component Keychain access group is unavailable."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .componentKeyUnavailable:
                code = "key_unavailable"; message = "The component key is unavailable."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .identityChanged:
                code = "identity_reauthentication_required"; message = "The application identity must be reauthenticated."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .directAttestationRequired:
                code = "component_direct_attestation_required"; message = "Direct component attestation is required."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .invalidConfiguration:
                code = "invalid_configuration"; message = "The native component configuration is invalid."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case let .latchway(underlying):
                let failure = NativeFailure(underlying)
                code = failure.code; message = failure.message
                requestID = failure.requestID; operationID = failure.operationID
                status = failure.status; retryable = failure.retryable
            }
        } else if let error = error as? LatchwayError {
            switch error {
            case let .server(problem):
                code = problem.code.description
                message = "The Latchway gateway rejected the request."
                requestID = problem.requestID
                operationID = problem.operationID
                status = problem.status
                retryable = problem.retryable
            case .invalidConfiguration:
                code = "invalid_configuration"; message = "Latchway native configuration is invalid."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .invalidRequest:
                code = "request_invalid"; message = "The native Latchway request is invalid."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .secureEnclaveUnavailable:
                code = "key_unavailable"; message = "Required hardware-backed key storage is unavailable."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .keyStorageFailure:
                code = "secure_state_unavailable"; message = "Secure Latchway state is unavailable."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .rootKeychainMigrationRequired:
                code = "secure_state_unavailable"; message = "Legacy root Keychain state requires explicit migration."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .attestationUnavailable:
                code = "attestation_unsupported"; message = "Required application attestation is unavailable."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .invalidAttestationBinding:
                code = "attestation_invalid"; message = "The attestation challenge binding is invalid."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .sessionUnavailable:
                code = "session_unavailable"; message = "A Latchway session is unavailable."
                requestID = nil; operationID = nil; status = nil; retryable = true
            case .transportFailure:
                code = "network_unavailable"; message = "The Latchway control request failed."
                requestID = nil; operationID = nil; status = nil; retryable = true
            case .invalidServerResponse:
                code = "response_invalid"; message = "Latchway returned an invalid native response."
                requestID = nil; operationID = nil; status = nil; retryable = false
            case .cancelled:
                code = "cancelled"; message = "The Latchway native operation was cancelled."
                requestID = nil; operationID = nil; status = nil; retryable = false
            }
        } else if error is CancellationError {
            code = "cancelled"; message = "The Latchway native operation was cancelled."
            requestID = nil; operationID = nil; status = nil; retryable = false
        } else {
            code = "internal_error"; message = "The Latchway native operation failed."
            requestID = nil; operationID = nil; status = nil; retryable = false
        }
        documentationURL = "https://docs.latchway.dev/errors/\(code.replacingOccurrences(of: "_", with: "-"))"
    }
}

private func decodeStrict<T: Decodable>(
    _ type: T.Type,
    encoded: String,
    maximumBytes: Int = 65_536
) throws -> T {
    guard let data = encoded.data(using: .utf8), data.count <= maximumBytes else {
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

private func componentDiagnosticsDictionary(
    _ diagnostics: LatchwayComponentDiagnostics
) -> [String: Any] {
    compact([
        "familyID": diagnostics.familyID as Any,
        "componentID": diagnostics.componentID as Any,
        "definitionID": diagnostics.definitionID,
        "keychainAccessGroup": diagnostics.keychainAccessGroup,
        "keyAvailable": diagnostics.keyAvailable,
        "keyStorage": diagnostics.keyStorage.rawValue,
        "grantAvailable": diagnostics.grantAvailable,
        "sessionAvailable": diagnostics.sessionAvailable,
        "trustSource": diagnostics.trustSource?.rawValue as Any,
        "trustExpiresAt": diagnostics.trustExpiresAt.map(iso8601) as Any,
        "containingAppActionRequired": diagnostics.containingAppActionRequired,
    ])
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
