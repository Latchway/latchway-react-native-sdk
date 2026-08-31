from __future__ import annotations

import hashlib
import os
import pathlib
import plistlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
COPY_SCRIPT = ROOT / "scripts/copy-development-firebase-ios-config.sh"
RUNNER = ROOT / "scripts/run-development-react-native-ios.sh"


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
            "completeDevelopmentVerification()",
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
        ordered = (
            "await developmentIdentityToken()",
            "await freshClientAfterRevocation(current, makeClient)",
            'measured.fetch("/v1/responses"',
            "await measured.diagnostics()",
            "await measured.quota(deployment.feature)",
            "await measured.revokeCurrentInstallation()",
            "await measured.dispose()",
            "await firebaseAuth().signOut()",
            "firebaseAuth().currentUser !== null",
            "completeDevelopmentVerification()",
        )
        positions = [verification.index(marker) for marker in ordered]
        self.assertEqual(positions, sorted(positions))

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
            "TARGET_OS_IOS",
            "!TARGET_OS_SIMULATOR",
            "!TARGET_OS_MACCATALYST",
            "validPlatform",
            "LatchwayDevelopmentDebuggerAttached",
            "LatchwayDevelopmentTesting",
            "completeDevelopmentVerification",
            "failDevelopmentVerification",
            "LatchwayDevelopmentTerminalFailureRunID",
            "latchway-development-verification.json",
            'diagnostics_app_attest_app_verified_react_native_ios',
        ):
            self.assertIn(marker, self.native)
        self.assertLess(
            self.native.index("+ (void)load"),
            self.native.index("RCT_REMAP_METHOD(consumeDevelopmentIdentityGrant"),
        )
        self.assertIn("LatchwayDevelopmentCapturedGrant = nil", self.native)
        self.assertIn("LatchwayDevelopmentGrantConsumed", self.native)
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
            "devicectl device install app",
            "devicectl device process launch",
            "--terminate-existing",
            "-configuration Debug",
            "codesign --verify --deep --strict",
            "FORCE_BUNDLING=1",
            'javascript_bundle="$app/main.jsbundle"',
            '"$javascript_bundle_bytes" -ge 1024',
            'appattest-environment") != "development"',
            'app-attest-opt-in") != ["CDhash"]',
            "get-task-allow",
            "env -i",
            "LATCHWAY_IOS_XCODE_DESTINATION_ID",
            "validate-development-react-native-ios-env.py",
            "devicectl device copy from",
            "latchway-development-verification.json",
            "development React Native iOS verification accepted",
            "development verification failed at",
        ):
            self.assertIn(marker, self.runner)
        export_grant = self.runner.index(
            "export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT"
        )
        launch = self.runner.index("devicectl device process launch", export_grant)
        unset_grant = self.runner.index(
            "unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT",
            launch,
        )
        self.assertLess(export_grant, launch)
        self.assertLess(launch, unset_grant)
        build = self.runner.index("  xcodebuild \\")
        revalidation = self.runner.index("validate_development_grant", build)
        marker_copy = self.runner.index("devicectl device copy from", launch)
        accepted = self.runner.index("development React Native iOS verification accepted", marker_copy)
        self.assertLess(build, revalidation)
        self.assertLess(revalidation, export_grant)
        self.assertLess(unset_grant, marker_copy)
        self.assertLess(marker_copy, accepted)
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
