#!/usr/bin/env python3
"""Enforce the one-use physical identity handoff and non-test host boundary."""

from __future__ import annotations

import os
import pathlib
import plistlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class PhysicalExampleHostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = (ROOT / "example/src/App.tsx").read_text(encoding="utf-8")
        cls.ios = (ROOT / "example/ios/LatchwayExample/AppDelegate.swift").read_text(encoding="utf-8")
        cls.ios_evidence_export = (
            ROOT / "example/ios/LatchwayExample/LatchwayEvidence.m"
        ).read_text(encoding="utf-8")
        cls.android = (
            ROOT
            / "example/android/app/src/main/java/com/latchwayexample/LatchwayEvidenceModule.kt"
        ).read_text(encoding="utf-8")
        cls.manifest = (ROOT / "example/android/app/src/main/AndroidManifest.xml").read_text(
            encoding="utf-8"
        )
        cls.ios_runner = (ROOT / "scripts/run-physical-react-native-ios.sh").read_text(encoding="utf-8")
        cls.android_runner = (ROOT / "scripts/run-physical-react-native-android.sh").read_text(encoding="utf-8")
        cls.scheme = (
            ROOT
            / "example/ios/LatchwayExample.xcodeproj/xcshareddata/xcschemes/LatchwayExample.xcscheme"
        ).read_text(encoding="utf-8")
        cls.ios_bridge = (ROOT / "ios/LatchwayNativeBridge.swift").read_text(encoding="utf-8")
        cls.app_intent = (ROOT / "example/ios/AppIntents/AppIntents.swift").read_text(
            encoding="utf-8"
        )
        cls.project = (
            ROOT / "example/ios/LatchwayExample.xcodeproj/project.pbxproj"
        ).read_text(encoding="utf-8")
        cls.root_entitlements = plistlib.loads(
            (ROOT / "example/ios/LatchwayExample/LatchwayExample.entitlements").read_bytes()
        )
        cls.root_info = plistlib.loads(
            (ROOT / "example/ios/LatchwayExample/Info.plist").read_bytes()
        )
        cls.app_intents_entitlements = plistlib.loads(
            (ROOT / "example/ios/AppIntents/AppIntents.entitlements").read_bytes()
        )
        cls.readme = (ROOT / "README.md").read_text(encoding="utf-8")

    def test_physical_identity_is_bootstrapped_once_from_firebase_custom_token(self) -> None:
        for marker in (
            "consumeIdentityGrant(",
            "signInWithCustomToken(grant)",
            "Protected physical evidence requires a fresh Firebase identity state.",
            "Protected one-use Firebase identity bootstrap failed.",
            "firebaseAuth().signOut()",
        ):
            self.assertIn(marker, self.app)
        self.assertNotIn("measuredClient = client", self.app)

    def test_physical_run_rotates_before_measurement_and_cleans_up_before_success(self) -> None:
        run = self.app.split("const runPhysicalEvidence", 1)[1].split("useEffect(() => {", 1)[0]
        firebase_ready = run.index("await ensureFirebaseApp();")
        fresh_identity = run.index("firebaseAuth().currentUser !== null")
        rotate = run.index("measuredClient = await freshClientAfterRevocation(client, makeClient,")
        install = run.index("setClient(measuredClient);")
        first_fetch = run.index('measuredClient.fetch("/v1/responses"')
        self.assertLess(firebase_ready, fresh_identity)
        self.assertLess(fresh_identity, rotate)
        self.assertLess(rotate, install)
        self.assertLess(install, first_fetch)
        self.assertEqual(1, run.count("measuredClient = await freshClientAfterRevocation(client, makeClient,"))
        self.assertNotIn("await client.ready;", run)

        cleanup = run.index("await measuredClient.revokeCurrentInstallation();")
        sign_out = run.index("await firebaseAuth().signOut();", cleanup)
        bridge_pass = run.index('tests.push(booleanTest("react_native_bridge", true));')
        success_write = run.index("await sink.write(JSON.stringify(record));")
        self.assertLess(cleanup, sign_out)
        self.assertLess(sign_out, bridge_pass)
        self.assertLess(bridge_pass, success_write)
        self.assertIn("physicalConformanceEnabled() && !physicalCleanupComplete", run)
        self.assertIn("failure record is already terminal", run)

    def test_physical_failure_diagnostics_are_allowlisted_and_identity_free(self) -> None:
        self.assertIn("replacementFailureDiagnostics ?? await (measuredClient ?? client).diagnostics()", self.app)
        self.assertIn("replacementFailureDiagnostics = await replacement.diagnostics()", self.app)
        summary = self.app.split("function physicalDiagnosticsSummary", 1)[1].split(
            "async function inspectBounded", 1
        )[0]
        for marker in (
            "platform: diagnostics.platform",
            "key_storage: diagnostics.keyStorage",
            "support: diagnostics.attestation.support",
            "last_operation: diagnostics.attestation.lastOperation",
            "session: { state: diagnostics.session.state }",
            "last_error_code: diagnostics.lastErrorCode",
        ):
            self.assertIn(marker, summary)
        for forbidden in (
            "installation",
            "requestID",
            "expiresAt",
            "identity",
            "evidence",
            "keyID",
        ):
            self.assertNotIn(forbidden, summary)

    def test_physical_mapping_proves_authorization_before_feature_lookup(self) -> None:
        run = self.app.split("const runPhysicalEvidence", 1)[1].split("useEffect(() => {", 1)[0]
        self.assertIn('error.code === "component_feature_not_granted"', run)
        self.assertIn("error.status === 403", run)
        self.assertNotIn('error.code === "feature_not_found"', run)
        self.assertNotIn("error.status === 404", run)

    def test_ios_physical_run_proves_assertion_reuse_without_exporting_identifiers(self) -> None:
        run = self.app.split("const runPhysicalEvidence", 1)[1].split("useEffect(() => {", 1)[0]
        registration = run.index("const registrationDiagnostics = await measuredClient.diagnostics();")
        registered_installation = run.index(
            "const registeredInstallationID = registrationDiagnostics.installation.id;"
        )
        dispose = run.index("await measuredClient.dispose();", registered_installation)
        retire = run.index("await sink.retireSessionForAssertionReuse(", dispose)
        recreate = run.index("measuredClient = makeClient();", retire)
        refresh = run.index("await measuredClient.refresh();", recreate)
        assertion = run.index("const assertionDiagnostics = await measuredClient.diagnostics();", refresh)
        same_installation = run.index(
            "assertionDiagnostics.installation.id === registeredInstallationID", assertion
        )
        assertion_operation = run.index(
            'assertionDiagnostics.attestation.lastOperation === "assertion"', assertion
        )
        recorded = run.index('tests.push(booleanTest("app_attest_assertion", assertionPassed));')
        self.assertLess(registration, registered_installation)
        self.assertLess(registered_installation, dispose)
        self.assertLess(dispose, retire)
        self.assertLess(retire, recreate)
        self.assertLess(recreate, refresh)
        self.assertLess(refresh, assertion)
        self.assertLess(assertion, same_installation)
        self.assertLess(assertion, assertion_operation)
        self.assertLess(assertion_operation, recorded)
        self.assertLess(same_installation, recorded)
        self.assertIn('...(Platform.OS === "ios" ? ["app_attest_assertion"] : [])', self.app)
        self.assertNotIn("registeredInstallationID,", run.split("const record =", 1)[1])

    def test_provider_trust_levels_match_core_normalization(self) -> None:
        self.assertIn(
            'diagnostics.attestation.trustLevel === "app_verified"', self.app
        )
        self.assertIn(
            'diagnostics.attestation.trustLevel === "device_verified"', self.app
        )
        self.assertIn(
            'diagnostics.attestation.trustLevel === "strong_device_verified"', self.app
        )
        self.assertIn("== app_verified", self.ios_runner)
        self.assertNotIn('"device_verified"', self.ios)
        self.assertNotIn('"strong_device_verified"', self.ios)
        self.assertNotIn('"app_verified"', self.android)

    def test_ios_handoff_is_hash_bound_one_use_and_environment_only(self) -> None:
        for marker in (
            "captureAndClearEnvironment()",
            'getenv("LATCHWAY_ONE_TIME_DEVICE_GRANT")',
            'unsetenv("LATCHWAY_ONE_TIME_DEVICE_GRANT")',
            "SHA256.hash",
            "captured = nil",
            "consumed = true",
        ):
            self.assertIn(marker, self.ios)
        for marker in (
            "DEVICECTL_CHILD_LATCHWAY_ONE_TIME_DEVICE_GRANT",
            "DEVICECTL_CHILD_LATCHWAY_DEVICE_GRANT_SHA256",
            "one-use identity grant hash mismatch",
            'latchway_device_grant="${LATCHWAY_ONE_TIME_DEVICE_GRANT:-}"',
            "unset LATCHWAY_ONE_TIME_DEVICE_GRANT",
            "physical_app_bundle_tree.py",
            "private application snapshot changed before installation",
            "private application snapshot changed during installation",
            'cmp --silent "$snapshot_files_manifest" "$postinstall_snapshot_files_manifest"',
        ):
            self.assertIn(marker, self.ios_runner)
        self.assertNotIn("--environment", self.ios_runner)

    def test_ios_assertion_reuse_diagnostic_retires_only_the_session(self) -> None:
        diagnostic = self.ios.split("func retireSessionForAssertionReuse", 1)[1].split(
            "@objc(write:resolve:reject:)", 1
        )[0]
        for marker in (
            "DeviceEvidenceFacts.physical",
            "!DeviceEvidenceFacts.simulator",
            "!DeviceEvidenceFacts.debugBuild",
            "!DeviceEvidenceFacts.testing",
            "!DeviceEvidenceFacts.debuggerAttached",
            "PhysicalAssertionReuseGate.consume()",
            "LatchwayKeychainSessionStorage(",
            "clientRuntime: .reactNativeIOS",
            "try await storage.clear()",
        ):
            self.assertIn(marker, diagnostic)
        for forbidden in (
            "LatchwayAppAttestProvider",
            "attestationProvider.reset",
            "installationKey.reset",
            "revokeCurrentInstallation",
            "SecItemDelete",
        ):
            self.assertNotIn(forbidden, diagnostic)
        self.assertIn("private static var consumed = false", self.ios)
        self.assertIn("guard !consumed else { return false }", self.ios)
        self.assertIn("consumed = true", self.ios)
        self.assertIn(
            "RCT_EXTERN_METHOD(retireSessionForAssertionReuse:",
            self.ios_evidence_export,
        )

    def test_android_handoff_uses_shell_protected_stdin_not_argv_or_disk(self) -> None:
        for marker in (
            "ParcelFileDescriptor.createPipe()",
            "AutoCloseInputStream",
            "MessageDigest.isEqual",
            "value.fill(0)",
            "available.await(30, TimeUnit.SECONDS)",
            "clearState()",
            "val staged = try",
            "staged && !invalid && !consumed",
        ):
            self.assertIn(marker, self.android)
        self.assertIn('android:writePermission="android.permission.DUMP"', self.manifest)
        self.assertIn("content write --uri", self.android_runner)
        self.assertIn("printf '%s' \"$latchway_device_grant\" | adb_device", self.android_runner)
        self.assertIn("/$LATCHWAY_APPLICATION_ID/$LATCHWAY_PACKAGE_NAME/firebase", self.android_runner)
        for marker in (
            "expectedApplicationID",
            "expectedPackageName",
            "expectedIdentityProvider",
            "packageOrBundleIdentifier == reactApplicationContext.packageName",
        ):
            self.assertIn(marker, self.android)
        self.assertNotIn("--es dev.latchway.IDENTITY_GRANT", self.android_runner)

    def test_android_identity_grant_slot_is_terminal_on_every_consume_or_stage_failure(self) -> None:
        slot = self.android.split("private object PhysicalIdentityGrantHandoff", 1)[1]
        stage_failure = slot.split("fun stage(", 1)[1].split("fun consume(", 1)[0]
        consume = slot.split("fun consume(", 1)[1].split("fun invalidate()", 1)[0]
        invalidate = slot.split("fun invalidate()", 1)[1].split("private fun clearState()", 1)[0]
        self.assertIn("value.fill(0)\n            clearState()", stage_failure)
        self.assertIn("invalid = true\n            consumed = true", stage_failure)
        self.assertGreaterEqual(consume.count("clearState()"), 2)
        self.assertGreaterEqual(consume.count("consumed = true"), 2)
        self.assertGreaterEqual(consume.count("invalid = true"), 2)
        self.assertIn("clearState()", invalidate)
        self.assertIn("consumed = true", invalidate)
        self.assertIn("bytes?.fill(0)", slot)

    def test_host_uses_a_stricter_bounded_firebase_custom_token_shape(self) -> None:
        self.assertIn("32 ... 65_536", self.ios)
        self.assertIn("MAXIMUM_IDENTITY_GRANT_BYTES = 65_536", self.android)
        for runner in (self.ios_runner, self.android_runner):
            self.assertIn("<= 65536", runner)
            self.assertIn(
                "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
                runner,
            )

    def test_grant_is_never_traced_or_inherited_from_an_ambient_lowercase_name(self) -> None:
        upper_sentinel = "eyJhbGciOiJSUzI1NiJ9.dXBwZXItc2VjcmV0.c2lnbmF0dXJl"
        lower_sentinel = "ambient-lowercase-secret-sentinel"
        runner_paths = (
            ROOT / "scripts/run-physical-react-native-ios.sh",
            ROOT / "scripts/run-physical-react-native-android.sh",
        )
        for runner_path in runner_paths:
            with self.subTest(runner=runner_path.name), tempfile.TemporaryDirectory(
                prefix="latchway-rn-runner-path-"
            ) as temporary:
                fake_dirname = pathlib.Path(temporary) / "dirname"
                fake_dirname.write_text(
                    "#!/bin/sh\n"
                    'if [ -n "${latchway_device_grant+x}" ]; then\n'
                    '  echo "child inherited lowercase grant" >&2\n'
                    "fi\n"
                    'exec /usr/bin/dirname "$@"\n',
                    encoding="utf-8",
                )
                fake_dirname.chmod(0o700)
                environment = dict(os.environ)
                environment.update(
                    {
                        "LATCHWAY_ONE_TIME_DEVICE_GRANT": upper_sentinel,
                        "latchway_device_grant": lower_sentinel,
                        "PATH": temporary + os.pathsep + environment["PATH"],
                    }
                )
                result = subprocess.run(
                    ("bash", "-x", str(runner_path)),
                    cwd=ROOT,
                    env=environment,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=10,
                    check=False,
                )
            combined = result.stdout + result.stderr
            self.assertNotEqual(0, result.returncode)
            self.assertNotIn(upper_sentinel.encode("ascii"), combined)
            self.assertNotIn(lower_sentinel.encode("ascii"), combined)
            self.assertNotIn(b"child inherited lowercase grant", combined)

    def test_runners_reject_unexpected_ambient_identity_material(self) -> None:
        for runner in (self.ios_runner, self.android_runner):
            self.assertTrue(
                runner.startswith("#!/usr/bin/env bash\nset +x\nset -euo pipefail\n")
            )
            self.assertIn('for environment_name in "${!LATCHWAY_@}"', runner)
            self.assertIn("unexpected ambient identity or device grant is forbidden", runner)
        self.assertIn('for environment_name in "${!DEVICECTL_CHILD_@}"', self.ios_runner)
        self.assertIn("pre-existing CoreDevice child environment is forbidden", self.ios_runner)

    def test_collectors_enforce_fresh_application_identity_state(self) -> None:
        self.assertIn("device uninstall app", self.ios_runner)
        self.assertIn("candidate application remained after pre-run uninstall", self.ios_runner)
        self.assertIn("shell pm clear", self.android_runner)
        self.assertIn("candidate process survived app-data clear", self.android_runner)

    def test_ios_distinguishes_team_id_from_app_id_prefix(self) -> None:
        self.assertIn("LATCHWAY_IOS_APP_ID_PREFIX", self.ios_runner)
        self.assertIn(
            '"$LATCHWAY_IOS_APP_ID_PREFIX.$LATCHWAY_BUNDLE_ID"',
            self.ios_runner,
        )

    def test_ios_scheme_has_no_nonexistent_test_bundle(self) -> None:
        self.assertNotIn("LatchwayExampleTests", self.scheme)
        self.assertNotIn(".xctest", self.scheme)

    def test_ios_host_adopts_a_single_window_scene_lifecycle(self) -> None:
        scene_manifest = self.root_info["UIApplicationSceneManifest"]
        self.assertFalse(scene_manifest["UIApplicationSupportsMultipleScenes"])
        configuration = scene_manifest["UISceneConfigurations"][
            "UIWindowSceneSessionRoleApplication"
        ]
        self.assertEqual(1, len(configuration))
        self.assertEqual(
            "$(PRODUCT_MODULE_NAME).SceneDelegate",
            configuration[0]["UISceneDelegateClassName"],
        )
        self.assertIn("final class SceneDelegate: UIResponder, UIWindowSceneDelegate", self.ios)
        self.assertIn("let window = UIWindow(windowScene: windowScene)", self.ios)
        self.assertIn("appDelegate.startReactNative(in: window)", self.ios)
        self.assertNotIn("UIWindow(frame: UIScreen.main.bounds)", self.ios)

    def test_ios_extensions_never_construct_an_app_attest_provider(self) -> None:
        component_context = self.ios_bridge.split("private final class NativeComponentContext", 1)[1]
        component_context = component_context.split("private func isApplicationExtensionProcess", 1)[0]
        self.assertNotIn("directAttestationProvider:", component_context)
        self.assertNotIn("LatchwayAppAttestProvider(", component_context)
        self.assertIn("iOS application extension cannot call", self.readme)
        self.assertIn("invocation fails closed", self.readme)
        self.assertIn("`attestation_unsupported`", self.readme)

    def test_app_intents_target_is_explicitly_not_delegated_request_evidence(self) -> None:
        self.assertIn("throw LatchwayDelegatedRequestUnavailable()", self.app_intent)
        self.assertIn("delegated component requests are unsupported", self.app_intent.lower())
        self.assertNotIn("LatchwayExtensionClient", self.app_intent)
        self.assertNotIn("createLatchwayComponentClient", self.app_intent)
        self.assertIn("does not host a React Native JavaScript runtime", self.readme)
        self.assertIn("delegated-component execution evidence", self.readme)

    def test_ios_targets_have_distinct_overridable_bundle_and_profile_settings(self) -> None:
        for marker in (
            "LATCHWAY_ROOT_BUNDLE_IDENTIFIER = dev.latchway;",
            "LATCHWAY_APPINTENTS_BUNDLE_IDENTIFIER = dev.latchway.AppIntents;",
            'PRODUCT_BUNDLE_IDENTIFIER = "$(LATCHWAY_ROOT_BUNDLE_IDENTIFIER)";',
            'PRODUCT_BUNDLE_IDENTIFIER = "$(LATCHWAY_APPINTENTS_BUNDLE_IDENTIFIER)";',
            'PROVISIONING_PROFILE_SPECIFIER = "$(LATCHWAY_ROOT_PROVISIONING_PROFILE_SPECIFIER)";',
            'PROVISIONING_PROFILE_SPECIFIER = "$(LATCHWAY_APPINTENTS_PROVISIONING_PROFILE_SPECIFIER)";',
        ):
            self.assertIn(marker, self.project)
        self.assertEqual(2, self.project.count("IPHONEOS_DEPLOYMENT_TARGET = 16.0;"))
        self.assertNotIn("IPHONEOS_DEPLOYMENT_TARGET = 27.0;", self.project)
        self.assertEqual(
            self.project.count("LATCHWAY_ROOT_BUNDLE_IDENTIFIER = dev.latchway;"),
            4,
        )

    def test_ios_root_defaults_to_private_keychain_group_and_extension_is_shared_only(self) -> None:
        opt_in_key = "com.apple.developer.devicecheck.app-attest-opt-in"
        environment_key = "com.apple.developer.devicecheck.appattest-environment"
        self.assertEqual(self.root_entitlements.get(opt_in_key), ["CDhash"])
        self.assertNotIn(opt_in_key, self.app_intents_entitlements)
        self.assertEqual(self.root_entitlements.get(environment_key), "$(APP_ATTEST_ENVIRONMENT)")
        self.assertNotIn(environment_key, self.app_intents_entitlements)
        self.assertEqual(
            self.root_entitlements.get("keychain-access-groups"),
            [
                "$(AppIdentifierPrefix)$(LATCHWAY_ROOT_BUNDLE_IDENTIFIER)",
                "$(AppIdentifierPrefix)$(LATCHWAY_ROOT_BUNDLE_IDENTIFIER).keychain",
            ],
        )
        self.assertEqual(
            self.app_intents_entitlements.get("keychain-access-groups"),
            ["$(AppIdentifierPrefix)$(LATCHWAY_ROOT_BUNDLE_IDENTIFIER).keychain"],
        )
        for marker in (
            'private_keychain_access_group="$LATCHWAY_IOS_APP_ID_PREFIX.$LATCHWAY_BUNDLE_ID"',
            "if groups != [sys.argv[2], sys.argv[3]]:",
            'if value.get("keychain-access-groups") != [sys.argv[4]]:',
            "exact private-first/shared-second Keychain access groups",
            "only the exact shared Keychain access group",
            "exact App Attest CDhash opt-in",
            "App Intents target must not carry an App Attest entitlement",
        ):
            self.assertIn(marker, self.ios_runner)


if __name__ == "__main__":
    unittest.main()
