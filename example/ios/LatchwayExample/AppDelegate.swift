import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import Darwin
import CryptoKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "LatchwayExample",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

/// Example-only sink for a fixed, redacted physical-device run document.
/// It rebuilds the JSON from an allowlist and refuses simulator/debug/test
/// processes before anything is persisted for the external collector.
@objc(LatchwayEvidence)
final class LatchwayEvidence: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(write:resolve:reject:)
  func write(
    _ encoded: String,
    resolve: RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    do {
      let data = Data(encoded.utf8)
      guard (1 ... 65_536).contains(data.count),
            let input = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { throw EvidenceFailure.invalid }
      let sanitized = try Self.sanitize(input)
      let output = try JSONSerialization.data(withJSONObject: sanitized, options: [.prettyPrinted, .sortedKeys])
      guard output.count <= 131_072 else { throw EvidenceFailure.invalid }
      let directory = try FileManager.default.url(
        for: .documentDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
      )
      let destination = directory.appendingPathComponent("latchway-rn-device-run.json")
      try output.write(to: destination, options: [.atomic, .completeFileProtection])
      resolve(nil)
    } catch {
      reject("device_evidence_invalid", "Redacted physical-device run is invalid.", nil)
    }
  }

  @objc(runID:reject:)
  func runID(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    let value = ProcessInfo.processInfo.environment["LATCHWAY_RUN_ID"]
    if let value, Self.safe(value, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$") {
      resolve(value)
    } else {
      reject("device_evidence_invalid", "Protected physical-device run ID is unavailable.", nil)
    }
  }

  @objc(sha256:resolve:reject:)
  func sha256(
    _ value: String,
    resolve: RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    guard (1 ... 8_192).contains(value.utf8.count) else {
      reject("device_evidence_invalid", "Hash input is outside the protected bound.", nil)
      return
    }
    resolve(SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined())
  }

  private static func sanitize(_ input: [String: Any]) throws -> [String: Any] {
    try requireKeys(input, [
      "schema_version", "platform", "run", "gateway_version", "native", "pins", "tests", "redaction",
    ])
    guard input["schema_version"] as? String == "latchway.react-native-device-run.v1",
          input["platform"] as? String == "react_native_ios_app_attest",
          let run = input["run"] as? [String: Any],
          let gatewayVersion = input["gateway_version"] as? String,
          safe(gatewayVersion, pattern: "^[A-Za-z0-9._+-]{1,128}$"),
          let native = input["native"] as? [String: Any],
          let pins = input["pins"] as? [String: Any],
          let tests = input["tests"] as? [[String: Any]],
          let redaction = input["redaction"] as? [String: Any]
    else { throw EvidenceFailure.invalid }
    try requireKeys(run, ["id", "mode", "started_at", "completed_at"])
    guard let runID = run["id"] as? String,
          safe(runID, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$"),
          run["mode"] as? String == "release",
          let startedAt = run["started_at"] as? String,
          let completedAt = run["completed_at"] as? String,
          safe(startedAt, pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^\\s]{8,40}Z$"),
          safe(completedAt, pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^\\s]{8,40}Z$")
    else { throw EvidenceFailure.invalid }
    try requireKeys(native, [
      "provider", "trust_level", "key_storage", "native_sdk_version", "native_evidence_sha256",
      "session_state", "new_architecture",
    ])
    guard let provider = native["provider"] as? String,
          ["app_attest", "unverified"].contains(provider),
          let trustLevel = native["trust_level"] as? String,
          ["none", "identity_only", "web_risk_verified", "app_verified", "device_verified", "strong_device_verified", "debug"].contains(trustLevel),
          let keyStorage = native["key_storage"] as? String,
          ["secure_enclave", "unknown"].contains(keyStorage),
          let nativeVersion = native["native_sdk_version"] as? String,
          safe(nativeVersion, pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$"),
          let nativeEvidenceSHA256 = native["native_evidence_sha256"] as? String,
          safe(nativeEvidenceSHA256, pattern: "^[0-9a-f]{64}$"),
          let sessionState = native["session_state"] as? String,
          ["absent", "establishing", "active", "refreshing", "expired", "revoked", "failed", "unknown"].contains(sessionState),
          native["new_architecture"] as? Bool == true,
          Bundle.main.object(forInfoDictionaryKey: "RCTNewArchEnabled") as? Bool == true
    else { throw EvidenceFailure.invalid }
    let safePins = try sanitizePins(pins)
    let safeTests = try sanitizeTests(tests)
    let safeRedaction = try sanitizeRedaction(redaction)
    guard DeviceEvidenceFacts.physical,
          !DeviceEvidenceFacts.simulator,
          !DeviceEvidenceFacts.debugBuild,
          !DeviceEvidenceFacts.testing,
          !DeviceEvidenceFacts.debuggerAttached,
          let identifier = Bundle.main.bundleIdentifier,
          let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
          let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    else { throw EvidenceFailure.invalid }

    return [
      "schema_version": "latchway.react-native-device-run.v1",
      "platform": "react_native_ios_app_attest",
      "run": [
        "id": runID,
        "mode": "release",
        "started_at": startedAt,
        "completed_at": completedAt,
      ],
      "gateway_version": gatewayVersion,
      "native": [
        "provider": provider,
        "trust_level": trustLevel,
        "key_storage": keyStorage,
        "native_sdk_version": nativeVersion,
        "native_evidence_sha256": nativeEvidenceSHA256,
        "session_state": sessionState,
        "new_architecture": true,
      ],
      "pins": safePins,
      "application": [
        "identifier": identifier,
        "version": version,
        "build": build,
        "debuggable": false,
      ],
      "device": [
        "physical": true,
        "simulator": false,
        "emulator": false,
        "testing": false,
        "debugger_attached": false,
        "model": DeviceEvidenceFacts.model,
        "os_name": "iOS",
        "os_version": UIDevice.current.systemVersion,
        "os_build": DeviceEvidenceFacts.osBuild,
      ],
      "tests": safeTests,
      "redaction": safeRedaction,
    ]
  }

  private static func sanitizeTests(_ tests: [[String: Any]]) throws -> [[String: Any]] {
    guard (1 ... 32).contains(tests.count) else { throw EvidenceFailure.invalid }
    var seen = Set<String>()
    return try tests.map { item in
      guard Set(item.keys).isSubset(of: [
        "id", "status", "duration_ms", "http_status", "error_code", "request_id",
        "mapped_error_type", "credential_before_sha256", "credential_after_sha256",
        "installation_before_sha256", "installation_after_sha256", "protocol_version_sent",
      ]),
      let identifier = item["id"] as? String,
      safe(identifier, pattern: "^[a-z][a-z0-9_]{0,63}$"),
      seen.insert(identifier).inserted,
      let status = item["status"] as? String,
      ["passed", "failed"].contains(status),
      let duration = item["duration_ms"] as? NSNumber,
      (0 ... 7_200_000).contains(duration.intValue)
      else { throw EvidenceFailure.invalid }
      var output: [String: Any] = [
        "id": identifier,
        "status": status,
        "duration_ms": duration.intValue,
      ]
      if let httpStatus = item["http_status"] as? NSNumber {
        guard (100 ... 599).contains(httpStatus.intValue) else { throw EvidenceFailure.invalid }
        output["http_status"] = httpStatus.intValue
      }
      if let code = item["error_code"] as? String {
        guard safe(code, pattern: "^[a-z][a-z0-9_]{0,63}$") else { throw EvidenceFailure.invalid }
        output["error_code"] = code
      }
      if let requestID = item["request_id"] as? String {
        guard safe(requestID, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$") else { throw EvidenceFailure.invalid }
        output["request_id"] = requestID
      }
      if let mapped = item["mapped_error_type"] as? String {
        guard mapped == "react_native_latchway_error" else { throw EvidenceFailure.invalid }
        output["mapped_error_type"] = mapped
      }
      for name in [
        "credential_before_sha256", "credential_after_sha256",
        "installation_before_sha256", "installation_after_sha256",
      ] {
        if let hash = item[name] as? String {
          guard safe(hash, pattern: "^[0-9a-f]{64}$") else { throw EvidenceFailure.invalid }
          output[name] = hash
        }
      }
      if let version = item["protocol_version_sent"] as? NSNumber {
        guard version.int64Value >= 0 && version.int64Value <= Int64(Int32.max) else {
          throw EvidenceFailure.invalid
        }
        output["protocol_version_sent"] = version.intValue
      }
      return output
    }
  }

  private static func sanitizeRedaction(_ input: [String: Any]) throws -> [String: Bool] {
    let names: Set<String> = [
      "identity_token_recorded", "session_token_recorded", "refresh_token_recorded",
      "dpop_proof_recorded", "attestation_evidence_recorded", "private_key_recorded",
      "provider_credential_recorded",
    ]
    try requireKeys(input, names)
    guard names.allSatisfy({ input[$0] as? Bool == false }) else { throw EvidenceFailure.invalid }
    return Dictionary(uniqueKeysWithValues: names.map { ($0, false) })
  }

  private static func sanitizePins(_ input: [String: Any]) throws -> [String: String] {
    let names: Set<String> = [
      "source_commit", "core_commit", "contract_bundle_sha256", "gateway_image_digest",
      "gateway_configuration_sha256", "native_evidence_sha256", "distribution",
      "gateway_origin", "gateway_deployment_key_id", "gateway_deployment_statement_sha256",
      "gateway_deployment_public_key_sha256",
      "error_mapping_feature",
      "gateway_environment",
      "signing_certificate_sha256", "javascript_bundle_sha256", "team_id",
      "app_attest_environment",
    ]
    try requireKeys(input, names)
    guard let sourceCommit = input["source_commit"] as? String,
          safe(sourceCommit, pattern: "^[0-9a-f]{40}$"),
          let coreCommit = input["core_commit"] as? String,
          safe(coreCommit, pattern: "^[0-9a-f]{40}$"),
          let contractHash = input["contract_bundle_sha256"] as? String,
          safe(contractHash, pattern: "^[0-9a-f]{64}$"),
          let gatewayImage = input["gateway_image_digest"] as? String,
          safe(gatewayImage, pattern: "^sha256:[0-9a-f]{64}$"),
          let configurationHash = input["gateway_configuration_sha256"] as? String,
          safe(configurationHash, pattern: "^[0-9a-f]{64}$"),
          let gatewayOrigin = input["gateway_origin"] as? String,
          safe(gatewayOrigin, pattern: "^https://[a-z0-9][A-Za-z0-9.-]*(?::[1-9][0-9]{0,4})?(?:/[A-Za-z0-9_~.-]+)*$"),
          let gatewayEnvironment = input["gateway_environment"] as? String,
          safe(gatewayEnvironment, pattern: "^[a-z][a-z0-9_-]{0,62}$"),
          let deploymentKeyID = input["gateway_deployment_key_id"] as? String,
          safe(deploymentKeyID, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"),
          let deploymentStatementHash = input["gateway_deployment_statement_sha256"] as? String,
          safe(deploymentStatementHash, pattern: "^[0-9a-f]{64}$"),
          let deploymentPublicKeyHash = input["gateway_deployment_public_key_sha256"] as? String,
          safe(deploymentPublicKeyHash, pattern: "^[0-9a-f]{64}$"),
          let errorMappingFeature = input["error_mapping_feature"] as? String,
          safe(errorMappingFeature, pattern: "^[a-z][a-z0-9_.:-]{0,127}$"),
          let nativeHash = input["native_evidence_sha256"] as? String,
          safe(nativeHash, pattern: "^[0-9a-f]{64}$"),
          let distribution = input["distribution"] as? String,
          ["ad_hoc", "testflight", "app_store"].contains(distribution),
          let certificate = input["signing_certificate_sha256"] as? String,
          safe(certificate, pattern: "^[0-9a-f]{64}$"),
          let javascriptBundle = input["javascript_bundle_sha256"] as? String,
          safe(javascriptBundle, pattern: "^[0-9a-f]{64}$"),
          let team = input["team_id"] as? String,
          safe(team, pattern: "^[A-Z0-9]{10}$"),
          input["app_attest_environment"] as? String == "production"
    else { throw EvidenceFailure.invalid }
    return Dictionary(uniqueKeysWithValues: names.map { name in
      (name, input[name] as! String)
    })
  }

  private static func requireKeys(_ value: [String: Any], _ expected: Set<String>) throws {
    guard Set(value.keys) == expected else { throw EvidenceFailure.invalid }
  }

  private static func safe(_ value: String, pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
  }
}

private enum DeviceEvidenceFacts {
  #if targetEnvironment(simulator)
  static let physical = false
  static let simulator = true
  #else
  static let physical = true
  static let simulator = false
  #endif

  #if DEBUG
  static let debugBuild = true
  #else
  static let debugBuild = false
  #endif

  static let testing = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
  static let debuggerAttached: Bool = {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var name = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&name, u_int(name.count), &info, &size, nil, 0) == 0 else { return true }
    return (info.kp_proc.p_flag & P_TRACED) != 0
  }()
  static let model: String = {
    var system = utsname()
    uname(&system)
    var machine = system.machine
    let count = MemoryLayout.size(ofValue: machine)
    return withUnsafePointer(to: &machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: 1) { pointer in
        let bytes = UnsafeBufferPointer(start: pointer, count: count)
          .prefix { $0 != 0 }
          .map { UInt8(bitPattern: $0) }
        return String(decoding: bytes, as: UTF8.self)
      }
    }
  }()
  static let osBuild: String = {
    var size = 0
    guard sysctlbyname("kern.osversion", nil, &size, nil, 0) == 0, size > 1 else { return "unknown" }
    var buffer = [CChar](repeating: 0, count: size)
    guard sysctlbyname("kern.osversion", &buffer, &size, nil, 0) == 0 else { return "unknown" }
    return String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
  }()
}

private enum EvidenceFailure: Error { case invalid }
