import AppIntents
import Foundation

#if DEBUG
import Latchway
import Security

struct LatchwayDelegatedRequestIntent: AppIntent {
    static var title: LocalizedStringResource { "Run Latchway Proof" }
    static var description = IntentDescription(
        "Runs one Debug-only request with an independently keyed delegated App Intent component."
    )
    static var openAppWhenRun: Bool { false }

    func perform() async throws -> some IntentResult {
        let proof = try LatchwayDebugIntentConfiguration.load()
        // Capture the current containing-app challenge before constructing or
        // refreshing any delegated client. A delayed prior invocation can only
        // echo the run it actually observed and cannot satisfy a newer run.
        let runID = try LatchwayDebugIntentProofStore.readChallenge(
            accessGroup: proof.component.keychainAccessGroup
        )
        let client = try LatchwayExtensionClient(
            configuration: proof.latchway,
            component: proof.component
        )

        // An iOS application extension is delegated-only. It receives neither
        // the containing application's identity token nor its root key/session.
        try await client.refresh()
        let diagnostics = await client.diagnostics()
        guard diagnostics.trustSource == .delegatedFromAttestedRoot,
              diagnostics.keyAvailable,
              diagnostics.keyStorage == .secureEnclave,
              diagnostics.grantAvailable,
              diagnostics.sessionAvailable,
              !diagnostics.containingAppActionRequired
        else { throw LatchwayDebugIntentError.delegatedSessionUnavailable }

        let transport = client.transport(feature: proof.feature)
        var request = URLRequest(url: try transport.endpoint(path: "v1/responses"))
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": proof.model,
            "input": "Return the word verified.",
            "stream": false,
        ], options: [.sortedKeys])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let streaming = try await transport.bytes(for: request)
        guard (200 ... 299).contains(streaming.response.statusCode) else {
            streaming.cancel()
            throw LatchwayDebugIntentError.gatewayRejected
        }
        var responseBytes = 0
        do {
            for try await _ in streaming.bytes {
                responseBytes += 1
                guard responseBytes <= 65_536 else {
                    throw LatchwayDebugIntentError.gatewayResponseInvalid
                }
            }
            guard responseBytes > 0 else { throw LatchwayDebugIntentError.gatewayResponseInvalid }
            streaming.finish()
        } catch {
            streaming.cancel()
            throw error
        }

        try LatchwayDebugIntentProofStore.writeReceipt(
            accessGroup: proof.component.keychainAccessGroup,
            runID: runID
        )
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(rawValue: LatchwayDebugIntentProofStore.notification as CFString),
            nil,
            nil,
            true
        )
        return .result(dialog: "Delegated Latchway proof completed.")
    }
}

struct LatchwayDebugAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: LatchwayDelegatedRequestIntent(),
            phrases: ["Run Latchway proof in \(.applicationName)"],
            shortTitle: "Run Latchway Proof",
            systemImageName: "checkmark.shield"
        )
    }
}

private struct LatchwayDebugIntentConfiguration {
    let latchway: LatchwayConfiguration
    let component: LatchwayComponentConfiguration
    let feature: String
    let model: String

    static func load(bundle: Bundle = .main) throws -> Self {
        guard bundle.bundleURL.pathExtension == "appex",
              bundle.bundleIdentifier == "dev.latchway.AppIntents"
        else { throw LatchwayDebugIntentError.invalidConfiguration }
        let baseURLValue = try value("LatchwayGatewayURL", in: bundle)
        guard let baseURL = URL(string: baseURLValue),
              baseURL.scheme == "https", baseURL.host != nil,
              baseURL.user == nil, baseURL.password == nil,
              baseURL.path.isEmpty || baseURL.path == "/",
              baseURL.query == nil, baseURL.fragment == nil
        else { throw LatchwayDebugIntentError.invalidConfiguration }
        let applicationID = try value("LatchwayApplicationID", in: bundle)
        let environment = try value("LatchwayEnvironment", in: bundle)
        let rootGroup = try value("LatchwayRootKeychainAccessGroup", in: bundle)
        let sharedGroup = try value("LatchwayAppIntentKeychainAccessGroup", in: bundle)
        let definitionID = try value("LatchwayAppIntentComponentDefinitionID", in: bundle)
        let feature = try value("LatchwayAppIntentFeature", in: bundle)
        let model = try value("LatchwayAppIntentModel", in: bundle)
        guard identifier(applicationID, pattern: "^app_[0-7][0-9A-HJKMNP-TV-Z]{25}$"),
              environment == "development",
              identifier(rootGroup, pattern: "^[A-Z0-9]{10}\\.dev\\.latchway$"),
              sharedGroup == rootGroup + ".keychain",
              identifier(definitionID, pattern: "^[a-z][a-z0-9_-]{0,62}$"),
              identifier(feature, pattern: "^[a-z][a-z0-9_-]{0,62}$"),
              identifier(model, pattern: "^[a-z][a-z0-9_-]{0,62}$")
        else { throw LatchwayDebugIntentError.invalidConfiguration }
        let component = LatchwayComponentConfiguration.appIntent(
            definitionID: definitionID,
            keychainAccessGroup: sharedGroup,
            requestedFeatures: [feature]
        )
        return Self(
            latchway: LatchwayConfiguration(
                baseURL: baseURL,
                applicationID: applicationID,
                environment: environment,
                rootKeychainAccessGroup: rootGroup,
                legacySharedKeychainAccessGroups: [sharedGroup],
                identityProvider: "firebase",
                clientRuntime: .reactNativeIOS,
                softwareKeyFallbackPolicy: .disallow
            ),
            component: component,
            feature: feature,
            model: model
        )
    }

    private static func value(_ key: String, in bundle: Bundle) throws -> String {
        guard let value = bundle.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty, value.utf8.count <= 512,
              !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }),
              !value.contains("$(")
        else { throw LatchwayDebugIntentError.invalidConfiguration }
        return value
    }

    private static func identifier(_ value: String, pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) == value.startIndex ..< value.endIndex
    }
}

private enum LatchwayDebugIntentProofStore {
    static let service = "dev.latchway.debug.app-intent-proof"
    static let challengeAccount = "challenge-v1"
    static let receiptAccount = "receipt-v1"
    static let notification = "dev.latchway.debug.app-intent-proof-complete"

    static func readChallenge(accessGroup: String) throws -> String {
        var query = keychainCoordinates(accessGroup: accessGroup, account: challengeAccount)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              data.count == 36,
              let runID = String(data: data, encoding: .utf8),
              runID.range(of: "^dev_[0-9a-f]{32}$", options: .regularExpression) == runID.startIndex ..< runID.endIndex
        else { throw LatchwayDebugIntentError.challengeUnavailable }
        return runID
    }

    static func writeReceipt(accessGroup: String, runID: String) throws {
        guard runID.range(of: "^dev_[0-9a-f]{32}$", options: .regularExpression) ==
                runID.startIndex ..< runID.endIndex
        else { throw LatchwayDebugIntentError.challengeUnavailable }
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let data = try JSONSerialization.data(withJSONObject: [
            "schema_version": 1,
            "run_id": runID,
            "status": "passed",
            "delegated_session": true,
            "delegated_request": true,
            "completed_at": timestamp,
        ], options: [.sortedKeys])
        guard data.count <= 512 else { throw LatchwayDebugIntentError.receiptUnavailable }
        // A prior invocation that outlives its run must not overwrite the
        // current receipt after the containing app rotates the challenge.
        guard try readChallenge(accessGroup: accessGroup) == runID else {
            throw LatchwayDebugIntentError.challengeUnavailable
        }
        let coordinates = keychainCoordinates(accessGroup: accessGroup, account: receiptAccount)
        let removal = SecItemDelete(coordinates as CFDictionary)
        guard removal == errSecSuccess || removal == errSecItemNotFound else {
            throw LatchwayDebugIntentError.receiptUnavailable
        }
        var item = coordinates
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        item[kSecValueData] = data
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
            throw LatchwayDebugIntentError.receiptUnavailable
        }
    }

    private static func keychainCoordinates(accessGroup: String, account: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrAccessGroup: accessGroup,
        ]
    }
}

private enum LatchwayDebugIntentError: Error, LocalizedError {
    case invalidConfiguration
    case challengeUnavailable
    case delegatedSessionUnavailable
    case gatewayRejected
    case gatewayResponseInvalid
    case receiptUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: "The Debug App Intent configuration is invalid."
        case .challengeUnavailable: "Open the containing app to start the current Debug proof."
        case .delegatedSessionUnavailable: "Open the containing app to prepare the delegated component."
        case .gatewayRejected: "The delegated Latchway request was not accepted."
        case .gatewayResponseInvalid: "The delegated Latchway response was invalid."
        case .receiptUnavailable: "The bounded Debug proof receipt could not be stored."
        }
    }
}
#else
struct LatchwayDelegatedRequestIntent: AppIntent {
    static var title: LocalizedStringResource { "Latchway delegated request unavailable" }
    static var description = IntentDescription(
        "Reports that Release builds do not expose an executable delegated component fixture."
    )

    func perform() async throws -> some IntentResult {
        if Bundle.main.bundleURL.pathExtension == "appex" {
            throw LatchwayDelegatedRequestUnavailable()
        }
        return .result(dialog: "No delegated Latchway request was performed.")
    }
}

private struct LatchwayDelegatedRequestUnavailable: LocalizedError {
    var errorDescription: String? {
        "Delegated component requests are unavailable in this Release fixture."
    }
}
#endif
