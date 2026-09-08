import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import FirebaseCore
#if LATCHWAY_SHARED_NATIVE
import FirebaseAuth
import Latchway
#if canImport(LatchwayAppAttest)
import LatchwayAppAttest
#endif
#endif

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?
  private var pendingLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    FirebaseApp.configure()
    pendingLaunchOptions = launchOptions
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    return true
  }

  func startReactNative(in window: UIWindow) {
    guard let factory = reactNativeFactory else { return }
    self.window = window
#if LATCHWAY_SHARED_NATIVE
    if ProcessInfo.processInfo.arguments.contains("--latchway-embedded") {
      window.rootViewController = UINavigationController(rootViewController: SharedNativeHost(factory: factory))
      window.makeKeyAndVisible()
      return
    }
#endif
    factory.startReactNative(
      withModuleName: "LatchwayChat",
      in: window,
      launchOptions: pendingLaunchOptions
    )
    pendingLaunchOptions = nil
  }
}

#if LATCHWAY_SHARED_NATIVE
/// Runnable native-first host. Firebase and Latchway stay outside the RN surface.
@MainActor final class SharedNativeHost: UIViewController {
  private let factory: RCTReactNativeFactory
  private let auth = Auth.auth()
  private var app: LatchwayApp?
  private var client: LatchwayClient?
  private var account: LatchwayAccount?
  private var authKey: String?
  private var authObserver: AuthStateDidChangeListenerHandle?
  private var transition: Task<Void, Never>?
  private var requestTask: Task<Void, Never>?
  private var observation: Task<Void, Never>?
  private var epoch = 0
  private var config: [String: String] = [:]
  private let email = UITextField()
  private let password = UITextField()
  private let prompt = UITextField()
  private let output = UITextView()

  init(factory: RCTReactNativeFactory) { self.factory = factory; super.init(nibName: nil, bundle: nil) }
  required init?(coder: NSCoder) { fatalError("Use the example application entry point.") }
  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Native host · Shared account"
    view.backgroundColor = .systemBackground
    email.placeholder = "Firebase email"; email.autocapitalizationType = .none
    password.placeholder = "Password"; password.isSecureTextEntry = true
    prompt.text = "How does Latchway share a native and React Native session?"
    output.isEditable = false; output.font = .systemFont(ofSize: 16)
    let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 12
    for field in [email, password, prompt] { field.borderStyle = .roundedRect; stack.addArrangedSubview(field) }
    for (title, action) in [("Sign in", #selector(signIn)), ("Create account", #selector(signUp)),
                             ("Resume chat", #selector(resume)), ("Send from native Swift", #selector(send)),
                             ("Open React Native chat", #selector(openReactNative)), ("Sign out", #selector(signOut))] {
      let button = UIButton(type: .system); button.setTitle(title, for: .normal)
      button.addTarget(self, action: action, for: .touchUpInside); stack.addArrangedSubview(button)
    }
    stack.addArrangedSubview(output); stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
      stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12)])
    enqueue { try await self.bootstrap() }
  }

  private func bootstrap() async throws {
    guard let location = Bundle.main.url(forResource: "SharedNativeConfig", withExtension: "json"),
          let values = try JSONSerialization.jsonObject(with: Data(contentsOf: location)) as? [String: String],
          let project = FirebaseApp.app()?.options.projectID,
          let url = values["baseURL"].flatMap(URL.init(string:)),
          let appID = values["applicationID"], let environment = values["environment"],
          let team = values["appleTeamID"], let bundle = values["appleBundleID"] else {
      throw LatchwayLifecycleError.configurationConflict
    }
    config = values
    let rootGroup = team + "." + bundle
    app = try await LatchwayApp.configure(.init(baseURL: url, applicationID: appID, environment: environment,
      rootKeychainAccessGroup: rootGroup,
      suppliedIdentity: try .firebaseProject(projectID: project),
      exposeToReactNative: true, legacyComponents: []), name: "latchway-chat")
    authKey = identityKey()
    if let app {
      observation = Task { [weak self] in
        var previous: UUID?
        for await snapshot in await app.snapshots() {
          guard let self, !Task.isCancelled else { return }
          if previous != snapshot.generationID || snapshot.state == .loggedOut || snapshot.state == .retiring {
            self.epoch += 1; self.requestTask?.cancel(); self.output.text = ""
          }
          previous = snapshot.generationID
        }
      }
    }
    authObserver = auth.addStateDidChangeListener { [weak self] _, _ in
      Task { @MainActor [weak self] in self?.enqueue { try await self?.reconcile() } }
    }
    output.text = "Native app registered. Sign in or explicitly Resume chat. Configuration did not activate a session."
  }
  private func identityKey() -> String? { auth.currentUser.map { ($0.tenantID ?? "") + ":" + $0.uid } }
  private func reconcile() async throws {
    let next = identityKey()
    guard next != authKey else { return }
    try await retire()
    authKey = next
  }
  private func retire() async throws {
    epoch += 1; requestTask?.cancel(); output.text = ""
    guard let app else { throw LatchwayLifecycleError.appNotConfigured }
    let snapshot = await app.snapshot()
    if let account { try await account.logout() }
    else if let captured = snapshot.generationID { try await app.logout(generationID: captured) }
    await client?.close(); client = nil; account = nil
  }
  private func activate() async throws {
    guard let app else { throw LatchwayLifecycleError.appNotConfigured }
    try await reconcile()
    let accepted = try await app.signIn { [weak self] in
      guard let self else { throw LatchwayLifecycleError.identityUnavailable }
      return try await self.currentIDToken()
    }
    account = accepted
    client = try await accepted.makeClient()
    output.text = "Shared account active. Native and RN use this same backend."
  }
  private func currentIDToken() async throws -> String {
    guard let user = auth.currentUser else { throw LatchwayLifecycleError.identityUnavailable }
    let version = epoch, uid = user.uid
    let token: String = try await withCheckedThrowingContinuation { continuation in
      user.getIDTokenForcingRefresh(false) { token, error in
        if let error { continuation.resume(throwing: error) }
        else if let token { continuation.resume(returning: token) }
        else { continuation.resume(throwing: LatchwayLifecycleError.identityUnavailable) }
      }
    }
    guard version == epoch, auth.currentUser === user, user.uid == uid else { throw CancellationError() }
    return token
  }
  @objc private func signIn() { login(create: false) }
  @objc private func signUp() { login(create: true) }
  private func login(create: Bool) {
    let address = email.text ?? "", secret = password.text ?? ""
    enqueue {
      if create { _ = try await self.auth.createUser(withEmail: address, password: secret) }
      else { _ = try await self.auth.signIn(withEmail: address, password: secret) }
      self.password.text = ""
      try await self.activate()
    }
  }
  @objc private func resume() { enqueue { try await self.activate() } }
  @objc private func signOut() {
    epoch += 1; requestTask?.cancel()
    enqueue { try await self.retire(); try self.auth.signOut(); self.authKey = nil; self.output.text = "Signed out locally and from Firebase." }
  }
  @objc private func openReactNative() {
    guard app != nil else { output.text = "Wait for native configuration."; return }
    let surface = UIViewController(); surface.title = "React Native chat"
    surface.view = factory.rootViewFactory.view(withModuleName: "LatchwayEmbeddedChat", initialProperties: nil)
    navigationController?.pushViewController(surface, animated: true)
  }
  @objc private func send() {
    guard let client, let base = config["baseURL"], let feature = config["directFeature"],
          let url = URL(string: base + "/v1/chat/completions") else { output.text = "Sign in or Resume chat first."; return }
    requestTask?.cancel()
    let version = epoch, question = prompt.text ?? ""
    guard !question.isEmpty, question.count <= 4_000 else { output.text = "Use a prompt of 1–4,000 characters."; return }
    requestTask = Task {
      do {
        if let account {
          try await account.updateIdToken { [weak self] in
            guard let self else { throw LatchwayLifecycleError.identityUnavailable }
            return try await self.currentIDToken()
          }
        }
        var request = URLRequest(url: url); request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["model": "latchway-managed", "max_tokens": 1024,
          "messages": [["role": "system", "content": "Explain Latchway: a device-attested AI gateway that keeps provider keys on the server, verifies Firebase identity and enforces per-user quotas."],
                       ["role": "user", "content": question]]])
        let response = try await client.send(request, feature: feature)
        guard !Task.isCancelled, version == epoch else { return }
        let json = try JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        let choices = json?["choices"] as? [[String: Any]]
        output.text = (choices?.first?["message"] as? [String: Any])?["content"] as? String ?? "Gateway returned no completed answer."
      } catch { if version == epoch { output.text = "Native request stopped or failed. No automatic retry was sent." } }
    }
  }
  private func enqueue(_ operation: @escaping @MainActor () async throws -> Void) {
    let previous = transition
    transition = Task { await previous?.value; do { try await operation() }
      catch { output.text = "Account operation failed. Retry Sign out if cleanup is incomplete; no account was automatically activated." } }
  }
}
#endif

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
             options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.startReactNative(in: window)
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
      ?? RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
