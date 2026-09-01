from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import os
import pathlib
import plistlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
COPY_SCRIPT = ROOT / "scripts/copy-development-firebase-ios-config.sh"
RUNNER = ROOT / "scripts/run-development-react-native-ios.sh"
SIGNATURE_VERIFIER = ROOT / "scripts/verify_development_ios_signed_bundle.py"

SIGNATURE_SPEC = importlib.util.spec_from_file_location(
    "verify_development_ios_signed_bundle", SIGNATURE_VERIFIER
)
assert SIGNATURE_SPEC is not None and SIGNATURE_SPEC.loader is not None
SIGNATURE_MODULE = importlib.util.module_from_spec(SIGNATURE_SPEC)
SIGNATURE_SPEC.loader.exec_module(SIGNATURE_MODULE)


class DevelopmentExampleHostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = (ROOT / "example/src/App.tsx").read_text(encoding="utf-8")
        cls.native = (
            ROOT / "example/ios/LatchwayExample/LatchwayDevelopmentBootstrap.m"
        ).read_text(encoding="utf-8")
        cls.app_delegate = (
            ROOT / "example/ios/LatchwayExample/AppDelegate.swift"
        ).read_text(encoding="utf-8")
        cls.evidence = (
            ROOT / "example/ios/LatchwayExample/LatchwayEvidence.m"
        ).read_text(encoding="utf-8")
        cls.project = (
            ROOT / "example/ios/LatchwayExample.xcodeproj/project.pbxproj"
        ).read_text(encoding="utf-8")
        cls.copy_script = COPY_SCRIPT.read_text(encoding="utf-8")
        cls.runner = RUNNER.read_text(encoding="utf-8")

    def test_javascript_selects_a_terminal_debug_only_bootstrap(self) -> None:
        for marker in (
            "LATCHWAY_DEVELOPMENT_DEVICE_BOOTSTRAP",
            "NativeModules.LatchwayDevelopmentBootstrap",
            "consumeDevelopmentIdentityGrant(",
            "developmentVerificationPhase()",
            "clearDevelopmentAppIntentArtifacts(",
            "markDevelopmentAppIntentWaiting(",
            "consumeDevelopmentAppIntentReceipt(",
            "completeDevelopmentVerification()",
            "completeDevelopmentAbort()",
            "failDevelopmentVerification(",
            "developmentHTTPFailureCode(result)",
            "result.problemCode ?? result.diagnosticProblemCode",
            "runDevelopmentVerification(",
            "signInWithCustomToken(grant)",
            "firebaseAuth().signOut()",
            "__DEV__",
            'Platform.OS === "ios"',
        ):
            self.assertIn(marker, self.app)

        provider = self.app.split("getIdentityToken:", 1)[1].split(",", 1)[0]
        self.assertLess(
            provider.index("physicalConformanceEnabled()"),
            provider.index("developmentDeviceBootstrapEnabled()"),
        )
        bootstrap = self.app.split("async function bootstrapDevelopmentIdentity", 1)[1]
        consume = bootstrap.index("consumeDevelopmentIdentityGrant(")
        sign_out = bootstrap.index("firebaseAuth().signOut()")
        sign_in = bootstrap.index("signInWithCustomToken(grant)")
        self.assertLess(consume, sign_out)
        self.assertLess(sign_out, sign_in)
        self.assertIn("developmentIdentityBootstrap", self.app)
        diagnostic = self.app.split("async function inspectBounded", 1)[1]
        diagnostic = diagnostic.split("async function readBounded", 1)[0]
        self.assertIn("decodeBoundedUTF8(body)", diagnostic)
        self.assertIn("function decodeBoundedUTF8", diagnostic)
        self.assertNotIn("new TextDecoder()", diagnostic)
        self.assertIn("diagnosticProblemCode = code", diagnostic)
        self.assertIn("value.request_id === requestID", diagnostic)
        self.assertLess(
            diagnostic.index("diagnosticProblemCode = code"),
            diagnostic.index("problemCode = code"),
        )
        self.assertNotIn("grant", self.app.split("useState(", 1)[0])

        verification = self.app.split("async function runDevelopmentVerification", 1)[1]
        initial = verification.split('if (phase === "resume")', 1)[1]
        initial = initial.split("await sink.clearDevelopmentAppIntentArtifacts", 1)[1]
        ordered = (
            "await developmentIdentityToken()",
            "await current.revokeCurrentInstallationFamily([component])",
            "measured = makeClient()",
            'measured.fetch("/v1/responses"',
            "await measured.diagnostics()",
            "await measured.quota(deployment.feature)",
            "await measured.prepareComponents([component])",
            'setStatus("Waiting for the Run Latchway Proof App Intent")',
            "await sink.markDevelopmentAppIntentWaiting(component.keychainAccessGroup)",
        )
        positions = [initial.index(marker) for marker in ordered]
        self.assertEqual(positions, sorted(positions))
        after_waiting_marker = initial.split(
            "await sink.markDevelopmentAppIntentWaiting(component.keychainAccessGroup)", 1
        )[1].split("} catch", 1)[0]
        self.assertNotIn("await ", after_waiting_marker)
        self.assertNotIn("measured.dispose()", after_waiting_marker)
        self.assertLess(
            initial.index("await measured.prepareComponents([component])"),
            initial.index("await sink.markDevelopmentAppIntentWaiting(component.keychainAccessGroup)"),
        )
        self.assertLess(
            initial.index("familyCleanupRequired = true"),
            initial.index('failureStage = "family_revoke"'),
        )
        self.assertLess(
            initial.index('failureStage = "family_revoke"'),
            initial.index("await current.revokeCurrentInstallationFamily([component])"),
        )
        self.assertLess(
            initial.index('failureStage = "native_session_establishment"'),
            initial.index("await current.dispose()"),
        )
        abort = verification.split('if (phase === "abort" || phase === "abort_sign_out")', 1)[1]
        abort = abort.split('if (phase === "resume")', 1)[0]
        self.assertLess(
            abort.index("await sink.clearDevelopmentAppIntentArtifacts(component.keychainAccessGroup)"),
            abort.index("await current.revokeCurrentInstallationFamily([component])"),
        )
        finalizer = verification.split("} finally {", 1)[1].split(
            "function developmentAppIntentComponent", 1
        )[0]
        self.assertIn('terminalFailure?.stage !== "family_revoke"', finalizer)
        self.assertIn("developmentIdentityEstablished && !familyCleanupRequired", finalizer)
        self.assertIn('stage: "family_revoke"', finalizer)
        self.assertIn('stage: "firebase_sign_out"', finalizer)
        self.assertLess(
            finalizer.index("await measured.revokeCurrentInstallationFamily([component])"),
            finalizer.index("await firebaseAuth().signOut()"),
        )
        self.assertLess(
            finalizer.index("await firebaseAuth().signOut()"),
            finalizer.index("await sink.failDevelopmentVerification("),
        )
        verification_prefix = verification.split("const phase =", 1)[0]
        self.assertLess(verification_prefix.index("try {"), verification_prefix.index("sink ="))
        self.assertLess(verification_prefix.index("try {"), verification_prefix.index("component ="))

    def test_separate_native_module_captures_before_react_native_and_is_debug_only(self) -> None:
        for marker in (
            "#if DEBUG",
            "RCT_EXPORT_MODULE_NO_LOAD(LatchwayDevelopmentBootstrap, LatchwayDevelopmentBootstrap)",
            "RCT_REMAP_METHOD(consumeDevelopmentIdentityGrant",
            "+ (void)load",
            'getenv("LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT")',
            'getenv("LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256")',
            'unsetenv("LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT")',
            'unsetenv("LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256")',
            'unsetenv("LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID")',
            'unsetenv("LATCHWAY_DEVELOPMENT_VERIFICATION_RESUME")',
            'unsetenv("LATCHWAY_DEVELOPMENT_VERIFICATION_ABORT")',
            "dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(180 * NSEC_PER_SEC))",
            "LatchwayDevelopmentCapturedGrant = nil",
            "TARGET_OS_IOS",
            "!TARGET_OS_SIMULATOR",
            "!TARGET_OS_MACCATALYST",
            "validPlatform",
            "LatchwayDevelopmentDebuggerAttached",
            "LatchwayDevelopmentTesting",
            "completeDevelopmentVerification",
            "completeDevelopmentAbort",
            "consumeDevelopmentAppIntentReceipt",
            "clearDevelopmentAppIntentArtifacts",
            "markDevelopmentAppIntentWaiting",
            "failDevelopmentVerification",
            "LatchwayDevelopmentTerminalFailureRunID",
            "latchway-development-verification.json",
            'diagnostics_app_attest_app_verified_react_native_ios',
            'app_intent_delegated_session',
            'installation_family_revoked',
        ):
            self.assertIn(marker, self.native)
        self.assertLess(
            self.native.index("+ (void)load"),
            self.native.index("RCT_REMAP_METHOD(consumeDevelopmentIdentityGrant"),
        )
        self.assertIn("LatchwayDevelopmentCapturedGrant = nil", self.native)
        self.assertIn("LatchwayDevelopmentGrantConsumed", self.native)
        mark = self.native.split("RCT_REMAP_METHOD(markDevelopmentAppIntentWaiting", 1)[1]
        mark = mark.split("RCT_REMAP_METHOD(consumeDevelopmentAppIntentReceipt", 1)[0]
        self.assertLess(
            mark.index("LatchwayDevelopmentWriteAppIntentChallenge(accessGroup, runID)"),
            mark.index("LatchwayDevelopmentWriteMarker(marker)"),
        )
        self.assertGreaterEqual(
            mark.count("LatchwayDevelopmentDeleteAppIntentArtifacts(accessGroup)"),
            3,
        )
        consume_receipt = self.native.split(
            "RCT_REMAP_METHOD(consumeDevelopmentAppIntentReceipt", 1
        )[1].split("RCT_REMAP_METHOD(consumeDevelopmentIdentityGrant", 1)[0]
        for marker in (
            "LatchwayDevelopmentChallengeAccount",
            "LatchwayDevelopmentReceiptAccount",
            "LatchwayDevelopmentVerificationRunID",
            '[challenge isEqualToString:expectedRunID]',
            '[receipt[@"run_id"] isEqual:expectedRunID]',
            "LatchwayDevelopmentDeleteAppIntentArtifacts(accessGroup)",
        ):
            self.assertIn(marker, consume_receipt)
        self.assertLess(
            consume_receipt.index("NSString *expectedRunID"),
            consume_receipt.index("BOOL valid ="),
        )
        self.assertLess(
            consume_receipt.index("BOOL valid ="),
            consume_receipt.index("LatchwayDevelopmentDeleteAppIntentArtifacts(accessGroup)"),
        )
        take_grant = self.native.split("static NSString *LatchwayDevelopmentTakeGrant", 1)[1]
        take_grant = take_grant.split("static BOOL LatchwayDevelopmentDebuggerAttached", 1)[0]
        self.assertIn(
            "if (LatchwayDevelopmentGrantInvalid || LatchwayDevelopmentGrantConsumed) return nil;",
            take_grant,
        )
        self.assertIn("LatchwayDevelopmentGrantConsumed = grant != nil;", take_grant)
        self.assertTrue(self.native.startswith("#if DEBUG\n"))
        self.assertEqual(self.native.rsplit("#endif", 1)[1].strip(), "")
        consume_method = self.native.split("RCT_REMAP_METHOD(consumeDevelopmentIdentityGrant", 1)[1]
        consume_method = consume_method.split("RCT_REMAP_METHOD(completeDevelopmentVerification", 1)[0]
        self.assertLess(consume_method.index("BOOL valid ="), consume_method.index("LatchwayDevelopmentTakeGrant()"))
        self.assertNotIn("LATCHWAY_DEVELOPMENT", self.app_delegate)
        self.assertNotIn("DevelopmentIdentity", self.app_delegate)
        for marker in (
            'Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
            "import FirebaseCore",
            "FirebaseApp.configure()",
            'Bundle.main.url(forResource: "GoogleService-Info", withExtension: "plist")',
        ):
            self.assertIn(marker, self.app_delegate)
        debug_bundle = self.app_delegate.split("#if DEBUG", 1)[1].split("#else", 1)[0]
        self.assertLess(
            debug_bundle.index('Bundle.main.url(forResource: "main"'),
            debug_bundle.index("RCTBundleURLProvider.sharedSettings()"),
        )
        launch = self.app_delegate.split("didFinishLaunchingWithOptions", 1)[1].split("return true", 1)[0]
        self.assertLess(launch.index("FirebaseApp.configure()"), launch.index("RCTReactNativeFactory"))
        self.assertNotIn("LATCHWAY_DEVELOPMENT", self.evidence)
        self.assertNotIn("DevelopmentIdentity", self.evidence)

    def test_project_wires_only_the_separate_source_and_development_copy_phase(self) -> None:
        for marker in (
            "LatchwayDevelopmentBootstrap.m in Sources",
            "Copy development Firebase configuration",
            "copy-development-firebase-ios-config.sh",
            "showEnvVarsInLog = 0;",
            "APP_ATTEST_ENVIRONMENT = development;",
            "APP_ATTEST_ENVIRONMENT = production;",
        ):
            self.assertIn(marker, self.project)
        self.assertEqual(
            self.project.count("copy-development-firebase-ios-config.sh"),
            1,
        )
        self.assertEqual(
            self.project.count('TARGETED_DEVICE_FAMILY = "1,2";'),
            4,
            "both app and App Intents Debug/Release targets must support iPhone and iPad",
        )

    def test_copy_script_is_separate_and_fail_closed(self) -> None:
        for marker in (
            '"${CONFIGURATION:-}" == Debug',
            '"${PLATFORM_NAME:-}" == iphoneos',
            "LATCHWAY_PHYSICAL_CANDIDATE",
            "LATCHWAY_DEVELOPMENT_FIREBASE_IOS_CONFIG_PATH",
            "LATCHWAY_DEVELOPMENT_FIREBASE_CONFIGURATION_SHA256",
            "131_072",
            'value.get("BUNDLE_ID")',
            '"API_KEY"',
            '"GOOGLE_APP_ID"',
            '"PROJECT_ID"',
            "GoogleService-Info.plist",
        ):
            self.assertIn(marker, self.copy_script)
        self.assertNotIn("LatchwayCandidateConfigurationSHA256", self.copy_script)
        self.assertNotIn("LatchwayFirebaseConfigurationSHA256", self.copy_script)
        protected = (
            ROOT / "scripts/copy-protected-firebase-ios-config.sh"
        ).read_text(encoding="utf-8")
        self.assertNotIn("LATCHWAY_DEVELOPMENT", protected)

    def test_copy_script_copies_only_a_valid_external_debug_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = pathlib.Path(temporary)
            source = temporary_path / "external.plist"
            source.write_bytes(plistlib.dumps({
                "API_KEY": "example_api_key_1234567890",
                "BUNDLE_ID": "dev.latchway",
                "GOOGLE_APP_ID": "1:1234567890:ios:example",
                "PROJECT_ID": "latchway-example",
            }))
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            resources = temporary_path / "build/LatchwayExample.app"
            resources.mkdir(parents=True)
            environment = {
                **os.environ,
                "CONFIGURATION": "Debug",
                "LATCHWAY_DEVELOPMENT_DEVICE_BOOTSTRAP": "true",
                "LATCHWAY_DEVELOPMENT_FIREBASE_CONFIGURATION_SHA256": digest,
                "LATCHWAY_DEVELOPMENT_FIREBASE_IOS_CONFIG_PATH": str(source),
                "LATCHWAY_PHYSICAL_CANDIDATE": "0",
                "PLATFORM_NAME": "iphoneos",
                "PRODUCT_BUNDLE_IDENTIFIER": "dev.latchway",
                "SRCROOT": str(ROOT / "example/ios"),
                "TARGET_BUILD_DIR": str(temporary_path / "build"),
                "UNLOCALIZED_RESOURCES_FOLDER_PATH": "LatchwayExample.app",
            }
            subprocess.run(
                ["bash", str(COPY_SCRIPT)],
                cwd=ROOT,
                env=environment,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            copied = resources / "GoogleService-Info.plist"
            self.assertEqual(copied.read_bytes(), source.read_bytes())

            for name, value in (
                ("CONFIGURATION", "Release"),
                ("PLATFORM_NAME", "iphonesimulator"),
                ("LATCHWAY_PHYSICAL_CANDIDATE", "1"),
                ("LATCHWAY_DEVELOPMENT_FIREBASE_CONFIGURATION_SHA256", "0" * 64),
            ):
                rejected = {**environment, name: value}
                with self.subTest(name=name):
                    result = subprocess.run(
                        ["bash", str(COPY_SCRIPT)],
                        cwd=ROOT,
                        env=rejected,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn(str(source), result.stderr)

    def test_runner_never_exposes_the_grant_outside_one_child_launch(self) -> None:
        for marker in (
            "set +x",
            'latchway_development_grant="${LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT:-}"',
            "unset LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT",
            "export -n latchway_development_grant",
            'for environment_name in "${!DEVICECTL_CHILD_@}"',
            "DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT",
            "DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256",
            "DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID",
            "DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RESUME",
            "DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_ABORT",
            "devicectl device install app",
            "devicectl device process launch",
            "--terminate-existing",
            "-configuration Debug",
            "verify_development_ios_signed_bundle.py",
            "FORCE_BUNDLING=1",
            'javascript_bundle="$app/main.jsbundle"',
            '"$javascript_bundle_bytes" -ge 1024',
            "env -i",
            "LATCHWAY_IOS_XCODE_DESTINATION_ID",
            "validate-development-react-native-ios-env.py",
            "devicectl device copy from",
            "latchway-development-verification.json",
            "development React Native iOS verification accepted",
            "devicectl device notification observe",
            "shortcuts://run-shortcut?name=Run%20Latchway%20Proof",
            "descriptor-bound family cleanup completed",
        ):
            self.assertIn(marker, self.runner)
        export_grant = self.runner.index(
            "export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT"
        )
        launch = self.runner.index("devicectl device process launch", export_grant)
        unset_grant = self.runner.index("clear_development_child_state", launch)
        self.assertLess(export_grant, launch)
        self.assertLess(launch, unset_grant)
        build = self.runner.index("  xcodebuild \\")
        revalidation = self.runner.index("validate_development_grant", build)
        marker_copy = self.runner.index("if copy_development_marker", launch)
        accepted = self.runner.index("development React Native iOS verification accepted", marker_copy)
        self.assertLess(build, revalidation)
        self.assertLess(revalidation, export_grant)
        self.assertLess(unset_grant, marker_copy)
        self.assertLess(marker_copy, accepted)
        self.assertLess(unset_grant, self.runner.index("devicectl device notification observe", launch))
        child_clear = self.runner.split("clear_development_child_state() {", 1)[1].split(
            "\n}\n\ncleanup()", 1
        )[0]
        self.assertIn("unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT", child_clear)
        self.assertIn("unset latchway_development_grant", child_clear)
        resume_export = self.runner.index(
            "export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RESUME=1"
        )
        abort_export = self.runner.index(
            "export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_ABORT=1"
        )
        self.assertNotIn("ONE_TIME_DEVICE_GRANT", self.runner[resume_export:abort_export])
        self.assertIn(
            '-destination "platform=iOS,id=$LATCHWAY_IOS_XCODE_DESTINATION_ID"',
            self.runner,
        )
        self.assertNotIn(
            '-destination "platform=iOS,id=$LATCHWAY_IOS_DEVICE_ID"',
            self.runner,
        )
        for operation in (
            "devicectl device install app",
            "devicectl device process launch",
            "devicectl device copy from",
        ):
            section = self.runner.split(operation, 1)[1].split("\n\n", 1)[0]
            self.assertIn('--device "$LATCHWAY_IOS_DEVICE_ID"', section)
            self.assertNotIn("LATCHWAY_IOS_XCODE_DESTINATION_ID", section)
        self.assertNotIn("devicectl device uninstall app", self.runner)
        self.assertIn("Installing over the existing bundle preserves only OS consent", self.runner)
        self.assertNotIn("--environment", self.runner)
        self.assertNotIn("echo $latchway_development_grant", self.runner)
        self.assertNotIn("printf '%s\\n' \"$latchway_development_grant\"", self.runner)
        self.assertIn(
            'DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256="$latchway_development_grant_sha256"',
            self.runner,
        )
        build_environment = self.runner.split("env -i", 1)[1].split("  xcodebuild", 1)[0]
        for forbidden in (
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GITHUB_TOKEN",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT",
            "LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256",
        ):
            self.assertNotIn(forbidden, build_environment)

    def test_codesign_trust_only_and_tamper_diagnostics_fail_closed(self) -> None:
        bundle = pathlib.Path("/private/tmp/LatchwayExample.app")
        trust_only = (
            f"{bundle}: CSSMERR_TP_NOT_TRUSTED\n"
            "In architecture: arm64\n"
        ).encode("utf-8")
        self.assertEqual(
            SIGNATURE_MODULE.require_codesign_verification(0, b"", b""),
            "verified",
        )

        rejected = (
            trust_only,
            trust_only + b"a sealed resource is missing or invalid\n",
            f"{bundle}: a sealed resource is missing or invalid\n".encode("utf-8"),
            f"{bundle}: code object is not signed at all\n".encode("utf-8"),
        )
        for diagnostic in rejected:
            with self.subTest(diagnostic=diagnostic):
                with self.assertRaises(SIGNATURE_MODULE.VerificationError):
                    SIGNATURE_MODULE.require_codesign_verification(1, b"", diagnostic)
        with self.assertRaises(SIGNATURE_MODULE.VerificationError):
            SIGNATURE_MODULE.require_codesign_verification(0, b"unexpected", b"")
        with self.assertRaises(SIGNATURE_MODULE.VerificationError):
            SIGNATURE_MODULE.require_codesign_verification(0, b"", b"unexpected")

    def test_signed_bundle_path_validation_rejects_symlink_aliases(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="latchway-signed-bundle-path-"
        ) as directory:
            root = pathlib.Path(directory).resolve()
            app = root / "LatchwayExample.app"
            app.mkdir()
            SIGNATURE_MODULE.safe_bundle(app, ".app")

            direct_alias = root / "DirectAlias.app"
            direct_alias.symlink_to(app, target_is_directory=True)
            with self.assertRaises(SIGNATURE_MODULE.VerificationError):
                SIGNATURE_MODULE.safe_bundle(direct_alias, ".app")

            real_parent = root / "real"
            real_parent.mkdir()
            nested_app = real_parent / "Nested.app"
            nested_app.mkdir()
            parent_alias = root / "alias"
            parent_alias.symlink_to(real_parent, target_is_directory=True)
            with self.assertRaises(SIGNATURE_MODULE.VerificationError):
                SIGNATURE_MODULE.safe_bundle(parent_alias / "Nested.app", ".app")

    def test_debug_macho_inventory_rejects_extra_missing_and_symlink_code(self) -> None:
        expected = {"Root", "Nested/Code"}

        def populate(app: pathlib.Path, paths: set[str]) -> None:
            for relative in paths:
                path = app / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"\xcf\xfa\xed\xfe" + b"fixture")

        for mutation in ("extra", "missing", "symlink", "executable-text"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory(
                prefix="latchway-code-inventory-"
            ) as directory:
                root = pathlib.Path(directory)
                app = root / "Example.app"
                app.mkdir()
                populate(app, expected if mutation != "missing" else {"Root"})
                if mutation == "extra":
                    populate(app, {"Unexpected"})
                elif mutation == "symlink":
                    (app / "Nested/Code").unlink()
                    target = root / "external-code"
                    target.write_bytes(b"\xcf\xfa\xed\xfe" + b"fixture")
                    (app / "Nested/Code").symlink_to(target)
                elif mutation == "executable-text":
                    script = app / "unexpected-script"
                    script.write_text("not Mach-O", encoding="utf-8")
                    script.chmod(0o755)
                with self.assertRaises(SIGNATURE_MODULE.VerificationError):
                    SIGNATURE_MODULE.require_exact_macho_inventory(app, expected)

        with tempfile.TemporaryDirectory(
            prefix="latchway-code-inventory-valid-"
        ) as directory:
            app = pathlib.Path(directory) / "Example.app"
            app.mkdir()
            populate(app, expected)
            self.assertEqual(
                set(SIGNATURE_MODULE.require_exact_macho_inventory(app, expected)),
                expected,
            )

    def test_profile_allows_app_id_prefix_distinct_from_team_id(self) -> None:
        now = dt.datetime.now(dt.timezone.utc)
        team_id = "ABCDEFGHIJ"
        app_id_prefix = "KLMNOPQRST"
        application_identifier = f"{app_id_prefix}.dev.latchway.AppIntents"
        keychain_group = f"{app_id_prefix}.dev.latchway.keychain"
        leaf = b"fixture-leaf"
        profile = {
            "CreationDate": now - dt.timedelta(days=1),
            "ExpirationDate": now + dt.timedelta(days=1),
            "TeamIdentifier": [team_id],
            "ApplicationIdentifierPrefix": [app_id_prefix],
            "Platform": ["iOS"],
            "ProvisionedDevices": ["00008120-000175D621040032"],
            "DeveloperCertificates": [leaf],
            "Entitlements": {
                "application-identifier": application_identifier,
                "com.apple.developer.team-identifier": team_id,
                "get-task-allow": True,
                "keychain-access-groups": [keychain_group],
            },
        }
        SIGNATURE_MODULE.verify_profile(
            profile,
            team_id=team_id,
            app_id_prefix=app_id_prefix,
            device_udid="00008120-000175D621040032",
            application_identifier=application_identifier,
            keychain_groups=[keychain_group],
            app_attest=False,
            leaf=leaf,
        )
        profile["CreationDate"] = now + dt.timedelta(seconds=1)
        with self.assertRaises(SIGNATURE_MODULE.VerificationError):
            SIGNATURE_MODULE.verify_profile(
                profile,
                team_id=team_id,
                app_id_prefix=app_id_prefix,
                device_udid="00008120-000175D621040032",
                application_identifier=application_identifier,
                keychain_groups=[keychain_group],
                app_attest=False,
                leaf=leaf,
            )

    def test_profile_cms_certificate_set_parsers_are_exact(self) -> None:
        listing = ("\n".join(SIGNATURE_MODULE.PROFILE_CERTIFICATE_LISTING) + "\n").encode()
        SIGNATURE_MODULE.require_exact_profile_certificate_listing(listing)
        with self.assertRaises(SIGNATURE_MODULE.VerificationError):
            SIGNATURE_MODULE.require_exact_profile_certificate_listing(
                listing.replace(b"Apple Root CA", b"Untrusted Root", 1)
            )

        certificate = b"-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n"
        self.assertEqual(
            SIGNATURE_MODULE.split_pem_certificates(certificate * 3, exact_count=3),
            [certificate, certificate, certificate],
        )
        for malformed in (certificate * 2, certificate * 3 + b"unexpected"):
            with self.assertRaises(SIGNATURE_MODULE.VerificationError):
                SIGNATURE_MODULE.split_pem_certificates(malformed, exact_count=3)

    def test_supported_codesign_entitlement_representation_is_strict(self) -> None:
        payload = b"""[Dict]
\t[Key] application-identifier
\t[Value]
\t\t[String] PFK5S2E4H5.dev.latchway
\t[Key] get-task-allow
\t[Value]
\t\t[Bool] true
\t[Key] keychain-access-groups
\t[Value]
\t\t[Array]
\t\t\t[String] PFK5S2E4H5.dev.latchway
\t\t\t[String] PFK5S2E4H5.dev.latchway.keychain
"""
        self.assertEqual(
            SIGNATURE_MODULE.parse_abstract_entitlements(payload),
            {
                "application-identifier": "PFK5S2E4H5.dev.latchway",
                "get-task-allow": True,
                "keychain-access-groups": [
                    "PFK5S2E4H5.dev.latchway",
                    "PFK5S2E4H5.dev.latchway.keychain",
                ],
            },
        )
        for malformed in (
            payload + b"\t[Key] get-task-allow\n\t[Value]\n\t\t[Bool] false\n",
            payload.replace(b"[Bool] true", b"[Integer] 1"),
            b"<?xml version=\"1.0\"?><plist/>",
        ):
            with self.subTest(malformed=malformed):
                with self.assertRaises(SIGNATURE_MODULE.VerificationError):
                    SIGNATURE_MODULE.parse_abstract_entitlements(malformed)

    def test_runner_verifies_signed_bundle_before_any_device_install(self) -> None:
        invocation = self.runner.index("verify_development_ios_signed_bundle.py")
        install = self.runner.index("devicectl device install app")
        self.assertLess(invocation, install)
        verifier = SIGNATURE_VERIFIER.read_text(encoding="utf-8")
        for marker in (
            '["codesign", "-d", "--entitlements", "-", str(bundle)]',
            '"verify-cert"',
            '"codeSign"',
            '"-N"',
            '"-L"',
            '"codesign", "-d", "-r-"',
            '"cms",',
            '"-verify",',
            '"Apple iPhone OS Provisioning Profile Signing"',
            '"1.2.840.113635.100.6.58:"',
            'verify_debug_macho_inventory(',
            '"Frameworks/hermesvm.framework/hermesvm"',
            'creation > now',
            'app_id_prefix=arguments.app_id_prefix',
            'device_udid not in profile.get("ProvisionedDevices", [])',
            "root and App Intents targets used different signing certificates",
            'entitlements.get("com.apple.developer.devicecheck.appattest-environment") != "development"',
            'entitlements.get("com.apple.developer.devicecheck.app-attest-opt-in") != ["CDhash"]',
            'entitlements.get("get-task-allow") is not True',
        ):
            self.assertIn(marker, verifier)
        self.assertNotIn("CSSMERR_TP_NOT_TRUSTED", verifier)
        self.assertNotIn('"security", "cms"', verifier)

    def test_post_wait_runner_exit_always_uses_one_exact_run_abort_finalizer(self) -> None:
        for marker in (
            "waiting_observed=false",
            "terminal_cleanup_observed=false",
            "abort_cleanup_in_progress=false",
            "finalize_runner()",
            "run_abort_cleanup()",
            "trap finalize_runner EXIT",
            "trap 'exit 130' INT",
            "trap 'exit 143' TERM",
            "trap - EXIT INT TERM HUP",
            "local original_status=$?",
            'exit "$original_status"',
            "failed\\ app_intent_receipt\\ *",
            "failed\\ family_revoke\\ *",
            "failed\\ firebase_sign_out\\ *",
            "failed\\ success_marker\\ *",
            "initial_launch_attempted=false",
            "refresh_exact_run_cleanup_state",
            "refresh_attempt < 5",
            "wait_for_app_intent_window_remaining",
            "preserving the remaining manual App Shortcut window",
        ):
            self.assertIn(marker, self.runner)
        self.assertEqual(
            1,
            self.runner.count(
                "export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_ABORT=1"
            ),
        )
        finalizer = self.runner.split("finalize_runner()", 1)[1].split(
            "trap finalize_runner EXIT", 1
        )[0]
        self.assertIn('"$waiting_observed" == true', finalizer)
        self.assertIn('"$terminal_cleanup_observed" != true', finalizer)
        self.assertIn("run_abort_cleanup || abort_status=$?", finalizer)
        self.assertIn("if (( original_status == 0 )); then original_status=1; fi", finalizer)
        self.assertLess(
            self.runner.index("refresh_exact_run_cleanup_state()"),
            self.runner.index("initial_launch_attempted=true"),
        )
        self.assertLess(
            self.runner.index("run_abort_cleanup()"),
            self.runner.index("initial_launch_attempted=true"),
        )

        abort_admission = self.native.split(
            "static NSString *LatchwayDevelopmentAbortStageForMarker", 1
        )[1].split("static void LatchwayDevelopmentCaptureAndClearEnvironment", 1)[0]
        for stage in ("app_intent_receipt", "family_revoke", "firebase_sign_out"):
            self.assertIn(f'@"{stage}"', abort_admission)
        self.assertNotIn('@"success_marker"', abort_admission)
        self.assertIn('? @"abort_sign_out" : @"abort"', self.native)
        self.assertIn('phase === "abort_sign_out"', self.app)
        sign_out_retry = self.app.split('phase === "abort" || phase === "abort_sign_out"', 1)[1]
        sign_out_retry = sign_out_retry.split('if (phase === "resume")', 1)[0]
        self.assertIn('if (phase === "abort")', sign_out_retry)
        self.assertIn("await current.revokeCurrentInstallationFamily([component])", sign_out_retry)
        self.assertIn("await firebaseAuth().signOut()", sign_out_retry)

    def test_mocked_runner_finalizer_and_observer_fallback_are_deterministic(self) -> None:
        finalizer_body = self.runner.split("finalize_runner() {", 1)[1].split(
            "\n}\ntrap finalize_runner EXIT", 1
        )[0]
        finalizer = "finalize_runner() {" + finalizer_body + "\n}"
        clear_body = self.runner.split("clear_development_child_state() {", 1)[1].split(
            "\n}\n\ncleanup()", 1
        )[0]
        clear_function = "clear_development_child_state() {" + clear_body + "\n}"

        def run_case(
            *, waiting: bool, refresh: str, trigger: str, expected_status: int,
            expected_aborts: int,
        ) -> None:
            script = f'''\nset +e
waiting_observed={str(waiting).lower()}
terminal_cleanup_observed=false
abort_cleanup_in_progress=false
initial_launch_attempted=true
notification_observer_pid=""
refresh_state={refresh!r}
latchway_development_grant=raw-grant
latchway_development_grant_sha256=raw-digest
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT=raw-grant
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256=raw-digest
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID=dev_test
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RESUME=1
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_ABORT=1
stop_notification_observer() {{ :; }}
refresh_exact_run_cleanup_state() {{
  case "$refresh_state" in
    waiting) waiting_observed=true ;;
    success_marker) terminal_cleanup_observed=true ;;
  esac
}}
run_abort_cleanup() {{
  if env | grep -q '^DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_'; then
    printf 'contaminated\\n'
    return 91
  fi
  if [[ -n "${{latchway_development_grant+x}}" ||
        -n "${{latchway_development_grant_sha256+x}}" ]]; then
    printf 'contaminated\\n'
    return 91
  fi
  printf 'abort\\n'
  return 0
}}
cleanup() {{ printf 'cleanup\\n'; }}
{clear_function}
{finalizer}
trap finalize_runner EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
{trigger}
'''
            completed = subprocess.run(
                ["bash", "-c", script], check=False, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            self.assertEqual(completed.returncode, expected_status, completed.stderr)
            self.assertEqual(completed.stdout.splitlines().count("abort"), expected_aborts)
            self.assertNotIn("contaminated", completed.stdout.splitlines())
            self.assertEqual(completed.stdout.splitlines().count("cleanup"), 1)

        # A post-wait terminal-marker timeout remains nonzero after one abort.
        run_case(waiting=True, refresh="none", trigger="exit 17", expected_status=17, expected_aborts=1)
        # A failed resume launch takes the same exact-run abort route.
        run_case(waiting=True, refresh="none", trigger="exit 29", expected_status=29, expected_aborts=1)
        run_case(waiting=False, refresh="waiting", trigger="exit 23", expected_status=23, expected_aborts=1)
        run_case(waiting=True, refresh="none", trigger="kill -INT $$", expected_status=130, expected_aborts=1)
        run_case(waiting=True, refresh="none", trigger="kill -TERM $$", expected_status=143, expected_aborts=1)
        run_case(waiting=True, refresh="none", trigger="kill -HUP $$", expected_status=129, expected_aborts=1)
        run_case(waiting=True, refresh="success_marker", trigger="exit 41", expected_status=41, expected_aborts=0)
        run_case(waiting=True, refresh="none", trigger="exit 0", expected_status=1, expected_aborts=1)

        wait_body = self.runner.split("wait_for_app_intent_window_remaining() {", 1)[1].split(
            "\n}\n\ncleanup()", 1
        )[0]
        wait_function = "wait_for_app_intent_window_remaining() {" + wait_body + "\n}"
        completed = subprocess.run(
            ["bash", "-c", f'''\ncount=0
sleep() {{ count=$((count + 1)); }}
{wait_function}
wait_for_app_intent_window_remaining 4
printf '%s\\n' "$count"
'''],
            check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "4")

        refresh_body = self.runner.split("refresh_exact_run_cleanup_state() {", 1)[1].split(
            "\n}\n\n# Define every exact-run", 1
        )[0]
        refresh_function = "refresh_exact_run_cleanup_state() {" + refresh_body + "\n}"
        completed = subprocess.run(
            ["bash", "-c", f'''\nwaiting_observed=false
terminal_cleanup_observed=false
attempts=0
sleeps=0
copy_development_marker() {{
  attempts=$((attempts + 1))
  (( attempts >= 4 ))
}}
marker_state() {{ printf 'waiting\\n'; }}
sleep() {{ sleeps=$((sleeps + 1)); }}
{refresh_function}
refresh_exact_run_cleanup_state
printf '%s %s %s %s\\n' "$attempts" "$sleeps" "$waiting_observed" "$terminal_cleanup_observed"
'''],
            check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "4 3 true false")

    def test_runner_force_bundles_without_a_local_network_dependency(self) -> None:
        self.assertIn("FORCE_BUNDLING=1", self.runner)
        self.assertIn('javascript_bundle="$app/main.jsbundle"', self.runner)
        self.assertNotIn("LATCHWAY_METRO_HEALTH_URL", self.runner)
        self.assertNotIn("device_metro_health_url", self.runner)
        self.assertNotIn('"$app/ip.txt"', self.runner)

    def test_release_notes_name_the_responses_protocol(self) -> None:
        changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
        self.assertIn("currently supported OpenAI Responses route", changelog)
        self.assertNotIn("currently supported OpenAI Chat route", changelog)

    def test_release_and_protected_paths_do_not_accept_development_bootstrap(self) -> None:
        protected_runner = (
            ROOT / "scripts/run-physical-react-native-ios.sh"
        ).read_text(encoding="utf-8")
        protected_copy = (
            ROOT / "scripts/copy-protected-firebase-ios-config.sh"
        ).read_text(encoding="utf-8")
        self.assertNotIn("LATCHWAY_DEVELOPMENT", protected_runner)
        self.assertNotIn("LATCHWAY_DEVELOPMENT", protected_copy)
        self.assertIn('"${CONFIGURATION:-}" == Release', protected_copy)
        self.assertIn("!DeviceEvidenceFacts.debugBuild", self.app_delegate)
        self.assertIn("LATCHWAY_CONFORMANCE_AUTORUN", self.app)


if __name__ == "__main__":
    unittest.main()
