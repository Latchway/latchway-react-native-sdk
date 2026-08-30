#!/usr/bin/env python3
"""Enforce credential and OIDC isolation in physical React Native evidence."""

from __future__ import annotations

import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "physical-device-evidence.yml"


def job_block(source: str, job: str) -> str:
    match = re.search(rf"(?m)^  {re.escape(job)}:\n", source)
    if match is None:
        raise AssertionError(f"missing job: {job}")
    following = re.search(r"(?m)^  [a-z0-9][a-z0-9-]*:\n", source[match.end() :])
    end = len(source) if following is None else match.end() + following.start()
    return source[match.start() : end]


class PhysicalEvidenceWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = WORKFLOW.read_text(encoding="utf-8")
        cls.authorize = job_block(cls.source, "authorize-source")
        cls.ios = job_block(cls.source, "ios")
        cls.android = job_block(cls.source, "android")
        cls.ios_attest = job_block(cls.source, "ios-attest")
        cls.android_attest = job_block(cls.source, "android-attest")

    def test_source_authorization_is_github_hosted_and_candidate_code_free(self) -> None:
        self.assertIn("runs-on: ubuntu-24.04", self.authorize)
        self.assertIn("id-token: write", self.authorize)
        self.assertIn("artifact-metadata: write", self.authorize)
        self.assertIn("actions/attest@", self.authorize)
        self.assertIn("latchway.physical-source-authorization.v1", self.authorize)
        self.assertIn('["rn-android-play-integrity","rn-ios-app-attest"]', self.authorize)
        for forbidden in ("secrets.", "${{ vars.", "scripts/", "node ", "pnpm ", "xcodebuild", "adb "):
            self.assertNotIn(forbidden, self.authorize)

    def test_candidate_runners_are_one_job_jit_without_privileged_authority(self) -> None:
        self.assertIn("permissions: {}", self.source.split("jobs:", 1)[0])
        for candidate, runner, script, secret, name in (
            (
                self.ios,
                "runs-on: [self-hosted, macOS, latchway-physical-ios, latchway-ephemeral-jit]",
                "run: scripts/run-physical-react-native-ios.sh",
                "secrets.LATCHWAY_IOS_DEVICE_ID",
                "latchway-rn-ios-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
            ),
            (
                self.android,
                "runs-on: [self-hosted, Linux, latchway-physical-android, latchway-ephemeral-jit]",
                "run: scripts/run-physical-react-native-android.sh",
                "secrets.LATCHWAY_ANDROID_DEVICE_SERIAL",
                "latchway-rn-android-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
            ),
        ):
            self.assertIn(runner, candidate)
            self.assertIn("needs: authorize-source", candidate)
            self.assertIn("actions: read\n      contents: read", candidate)
            self.assertIn("actions/checkout@", candidate)
            self.assertIn(script, candidate)
            self.assertIn(secret, candidate)
            self.assertIn(name, candidate)
            for forbidden in (
                "id-token:", "attestations:", "artifact-metadata:", "actions/attest@",
                "packages:", "GHCR",
            ):
                self.assertNotIn(forbidden, candidate)
            self.assertIn("ACTIONS_ID_TOKEN_REQUEST_URL", candidate)
            self.assertIn("AWS_ACCESS_KEY_ID", candidate)
            self.assertIn("CLOUDFLARE_API_TOKEN", candidate)
            self.assertIn(
                "prohibited credential class is present on physical collector",
                candidate,
            )
            for forbidden_env in (
                "\n          AWS_ACCESS_KEY_ID:",
                "\n          AWS_SECRET_ACCESS_KEY:",
                "\n          CLOUDFLARE_API_TOKEN:",
            ):
                self.assertNotIn(forbidden_env, candidate)

    def test_signed_leases_bind_run_artifacts_and_single_use_grants(self) -> None:
        expectations = (
            (
                self.ios,
                "latchway-physical-evidence/rn-ios-app-attest",
                ("ios_app_binary_sha256", "ios_javascript_bundle_sha256", "native_evidence_sha256"),
            ),
            (
                self.android,
                "latchway-physical-evidence/rn-android-play-integrity",
                ("installed_apk_set_sha256", "native_evidence_sha256"),
            ),
        )
        common = (
            ".runner.ephemeral == true", ".runner.jit == true", ".runner.max_jobs == 1",
            ".runner.fresh_boot == true", ".runner.clean_workspace == true",
            ".runner.destroy_after_job == true",
            ".credentials == {long_lived:false,organization:false,administration:false,registry:false,oidc:false}",
            "caller_supplied_claims_accepted:false", "out_of_band_watchdog:true",
            "destroy_on_disconnect:true", ".grant.single_use == true",
            ".grant.issued_at_unix",
            ".grant.expires_at_unix <= .expires_at_unix",
            "(.grant.expires_at_unix - .grant.issued_at_unix) <= 300",
            "source_authorization_sha256", "--deny-self-hosted-runners",
            "openssl dgst -sha256 -verify",
        )
        for candidate, audience, artifacts in expectations:
            for marker in (*common, audience, *artifacts):
                self.assertIn(marker, candidate)

    def test_wipe_and_supervisor_finalize_are_separate_and_unconditional(self) -> None:
        for candidate, wipe_marker in (
            (self.ios, "devicectl device uninstall app"),
            (self.android, "shell pm clear"),
        ):
            self.assertGreaterEqual(candidate.count("if: ${{ always() }}"), 2)
            self.assertIn("even when collection fails", candidate)
            self.assertIn("Unconditionally finalize, deregister, and arm", candidate)
            self.assertIn(wipe_marker, candidate)
            self.assertIn("--source-authorization \"$source/source-authorization.json\"", candidate)
            self.assertIn("--evidence-directory \"$evidence\"", candidate)
            for forbidden in (
                "--source-authorization-sha256", "--lease-sha256",
                "--device-wipe-sha256", "--evidence-manifest-sha256",
            ):
                self.assertNotIn(forbidden, candidate)
            for marker in (
                ".evidence_eligible == true", "private_key_isolated:true",
                "independent_device_verification:true", "independent_provider_verification:true",
                "gateway_run_receipt_verified:true", "one_use_invocation:true",
                "watchdog_armed:true", ".observations.device_inventory_sha256",
                ".observations.provider_observation_sha256",
                ".observations.gateway_run_receipt_sha256",
                ".runner.deregistered == true", ".runner.destroy_scheduled == true",
            ):
                self.assertIn(marker, candidate)

    def test_unsigned_handoffs_are_bounded_and_short_lived(self) -> None:
        for candidate, artifact in (
            (self.ios, "react-native-ios-physical-unsigned"),
            (self.android, "react-native-android-physical-unsigned"),
        ):
            self.assertIn(
                f"name: {artifact}-${{{{ github.run_id }}}}-${{{{ github.run_attempt }}}}",
                candidate,
            )
            self.assertIn("if-no-files-found: error", candidate)
            self.assertIn("compression-level: 0", candidate)
            self.assertIn("retention-days: 1", candidate)
            self.assertIn("collector-isolation-unsigned", candidate)

    def test_fresh_signers_are_protected_and_candidate_code_free(self) -> None:
        for signer, dependency in ((self.ios_attest, "ios"), (self.android_attest, "android")):
            self.assertIn(f"needs: {dependency}", signer)
            self.assertIn("environment: physical-evidence-signing", signer)
            self.assertIn("runs-on: ubuntu-24.04", signer)
            for permission in (
                "actions: read",
                "artifact-metadata: write",
                "attestations: write",
                "contents: read",
                "id-token: write",
            ):
                self.assertIn(permission, signer)
            for forbidden in (
                "actions/checkout@",
                "secrets.",
                "scripts/",
                "xcodebuild",
                "gradle",
                "adb ",
                "node ",
                "pnpm ",
            ):
                self.assertNotIn(forbidden, signer)
            for validation in ("jq --exit-status", "sha256sum", "cmp --silent", "find \"$root\""):
                self.assertIn(validation, signer)
            for marker in (
                "collector-isolation-validation.json", "--deny-self-hosted-runners",
                "caller_supplied_claims_accepted:false", "gateway_run_receipt_verified:true",
            ):
                self.assertIn(marker, signer)
        self.assertEqual(self.source.count("actions/attest@"), 3)

    def test_final_observer_contract_is_unchanged(self) -> None:
        expectations = (
            (
                self.ios_attest,
                "react-native-ios-physical",
                {
                    "SHA256SUMS",
                    "device-inventory.json",
                    "gateway-client-policy.json",
                    "gateway-deployment-public-key.pem",
                    "gateway-deployment-statement.json",
                    "gateway-deployment-statement.sig",
                    "gateway-deployment-verification.json",
                    "github-attestation.sigstore.json",
                    "linked-ios-native-evidence.json",
                    "linked-ios-native-profile.json",
                    "react-native-ios-collection.json",
                    "react-native-ios-evidence.json",
                    "react-native-ios-junit.xml",
                    "react-native-ios-observation.json",
                    "react-native-ios-profile.json",
                    "react-native-ios-run.json",
                    "react-native-ios-validation.json",
                },
            ),
            (
                self.android_attest,
                "react-native-android-physical",
                {
                    "SHA256SUMS",
                    "device-inventory.json",
                    "gateway-client-policy.json",
                    "gateway-deployment-public-key.pem",
                    "gateway-deployment-statement.json",
                    "gateway-deployment-statement.sig",
                    "gateway-deployment-verification.json",
                    "github-attestation.sigstore.json",
                    "installed-apk-set.sha256",
                    "linked-android-native-evidence.json",
                    "linked-android-native-profile.json",
                    "react-native-android-collection.json",
                    "react-native-android-evidence.json",
                    "react-native-android-junit.xml",
                    "react-native-android-observation.json",
                    "react-native-android-profile.json",
                    "react-native-android-run.json",
                    "react-native-android-validation.json",
                },
            ),
        )
        for signer, artifact, observer_files in expectations:
            self.assertIn(
                f"name: {artifact}-${{{{ github.run_id }}}}-${{{{ github.run_attempt }}}}",
                signer,
            )
            for name in observer_files:
                self.assertIn(name, signer)
            self.assertIn("retention-days: 30", signer)
            self.assertIn("collector-isolation-${{ github.run_id }}", signer)

    def test_all_actions_are_commit_pinned(self) -> None:
        actions = re.findall(r"(?m)^\s+uses:\s+([^\s#]+)", self.source)
        self.assertGreaterEqual(len(actions), 20)
        for action in actions:
            self.assertRegex(action, r"^[^@]+@[0-9a-f]{40}$")


if __name__ == "__main__":
    unittest.main()
