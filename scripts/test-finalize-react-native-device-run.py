#!/usr/bin/env python3

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "Conformance" / "physical-device-evidence.schema.json").read_text())
IOS_COMPONENT_TESTS_V2 = {
    "component_candidate_identities",
    "widget_delegated_request",
    "share_delegated_request",
    "action_delegated_request",
    "component_key_isolation",
    "component_session_isolation",
    "component_sibling_denied",
    "component_keychain_sibling_denied",
    "component_refresh_race",
    "component_no_host_process",
    "component_background_execution",
    "component_host_termination",
    "component_no_user_presence",
}
IOS_REVIEWED_SNAPSHOT_SHA256 = {
    "validator": "8d12b2beb887cebb10f1fcc634cd9ebad839e3b40372a03f5f558ad5f41bc0d4",
    "schema": "b0f399ff16ff21e80ac1528af143e3834d0ef80e8a8dbeb9c7d4a2e354ead8c6",
}


def load(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validator = load("rn_run_validator", ROOT / "scripts" / "device-evidence.py")
fixtures = load("rn_run_fixtures", ROOT / "scripts" / "test-device-evidence.py")
finalizer = load("rn_run_finalizer", ROOT / "scripts" / "finalize-react-native-device-run.py")


def ios_component_observation(native_profile: dict, run: dict) -> dict:
    expected = native_profile["expected_pins"]
    identity_values = {
        "host": ("main_app", "c", "0", "4"),
        "widget": ("widget", "d", "1", "5"),
        "share": ("share_extension", "e", "2", "6"),
        "action": ("action_extension", "f", "3", "7"),
    }
    identities = [
        {
            "role": role,
            "kind": kind,
            "definition_id": expected[f"{role}_definition_id"],
            "bundle_identifier": expected[f"{role}_bundle_identifier"],
            "binary_sha256": expected[f"{role}_binary_sha256"],
            "attestation_mode": "root_app_attest" if role == "host" else "delegated_only",
            "principal_id_sha256": principal * 64,
            "dpop_key_id_sha256": key * 64,
            "session_id_sha256": session * 64,
        }
        for role, (kind, principal, key, session) in identity_values.items()
    ]
    tests = [
        {"id": name, "status": "passed", "duration_ms": 1}
        for name in sorted(finalizer.ios_native_evidence.IOS_COMPONENT_TESTS)
    ]
    for role in ("widget", "share", "action"):
        next(
            item for item in tests if item["id"] == f"{role}_delegated_request"
        ).update(
            http_status=200,
            request_id=f"request-{role}-1234",
        )
    next(item for item in tests if item["id"] == "component_sibling_denied").update(
        http_status=401,
        error_code="component_key_invalid",
        request_id="request-sibling-1234",
    )
    next(
        item for item in tests if item["id"] == "component_keychain_sibling_denied"
    ).update(
        os_status=-34018,
        os_status_name="errSecMissingEntitlement",
    )
    next(item for item in tests if item["id"] == "component_refresh_race").update(
        concurrent_request_count=2,
        credential_before_sha256="8" * 64,
        credential_after_sha256="a" * 64,
    )
    return {
        "schema_version": finalizer.ios_native_evidence.IOS_COMPONENT_OBSERVATION_VERSION,
        "platform": "ios_app_attest",
        "run_id": run["id"],
        "started_at": run["started_at"],
        "completed_at": run["completed_at"],
        "runtime": {
            "identities": identities,
            "widget_delegated_execution": {
                "role": "widget",
                "definition_id": expected["widget_definition_id"],
                "component_id_sha256": "d" * 64,
                "dpop_key_id_sha256": "1" * 64,
                "session_id_sha256": "5" * 64,
                "trust_source": "delegated_from_attested_root",
                "http_status": 200,
                "request_id": "request-widget-1234",
            },
            "share_delegated_execution": {
                "role": "share",
                "definition_id": expected["share_definition_id"],
                "component_id_sha256": "e" * 64,
                "dpop_key_id_sha256": "2" * 64,
                "session_id_sha256": "6" * 64,
                "trust_source": "delegated_from_attested_root",
                "http_status": 200,
                "request_id": "request-share-1234",
            },
            "delegated_execution": {
                "role": "action",
                "definition_id": expected["action_definition_id"],
                "component_id_sha256": "f" * 64,
                "dpop_key_id_sha256": "3" * 64,
                "session_id_sha256": "7" * 64,
                "trust_source": "delegated_from_attested_root",
                "http_status": 200,
                "request_id": "request-action-1234",
            },
            "sibling_denial": {
                "requesting_role": "action",
                "credential_role": "share",
                "credential_session_id_sha256": "6" * 64,
                "http_status": 401,
                "error_code": "component_key_invalid",
                "request_id": "request-sibling-1234",
            },
            "keychain_sibling_denial": {
                "requesting_role": "action",
                "target_role": "share",
                "target_key_id_sha256": "2" * 64,
                "operation": "SecItemCopyMatching",
                "os_status": -34018,
                "os_status_name": "errSecMissingEntitlement",
                "key_material_returned": False,
            },
            "component_refresh_race": {
                "role": "action",
                "component_id_sha256": "f" * 64,
                "dpop_key_id_sha256": "3" * 64,
                "session_id_before_sha256": "8" * 64,
                "old_credential_sha256": "8" * 64,
                "requests_started_concurrently": True,
                "overlap_observed": True,
                "requests": [
                    {
                        "request_id": "request-refresh-race-a",
                        "http_status": 200,
                        "access_credential_sha256": "9" * 64,
                        "refresh_credential_sha256": "a" * 64,
                        "session_id_sha256": "7" * 64,
                    },
                    {
                        "request_id": "request-refresh-race-b",
                        "http_status": 200,
                        "access_credential_sha256": "9" * 64,
                        "refresh_credential_sha256": "a" * 64,
                        "session_id_sha256": "7" * 64,
                    },
                ],
                "session_id_after_sha256": "7" * 64,
                "results_identical": True,
            },
            "lifecycle": {
                "host_process_running_during_action_request": False,
                "background_execution_observed": True,
                "host_termination_observed": True,
                "user_presence_prompt_observed": False,
            },
        },
        "tests": tests,
    }


def raw_case(platform: str):
    profile, full = fixtures.react_native_case(platform)
    android = platform.endswith("android_play_integrity")
    tests = [
        item for item in full["tests"]
        if item["id"] in finalizer.RAW_TESTS[platform]
    ]
    application = {
        name: full["application"][name]
        for name in ({"identifier", "version", "build", "debuggable", "installer_package"}
                     if android else {"identifier", "version", "build", "debuggable"})
    }
    device = {name: value for name, value in full["device"].items() if name != "security_level"}
    native = {
        "provider": "play_integrity" if android else "app_attest",
        "trust_level": "strong_device_verified" if android else "app_verified",
        "key_storage": "strongbox" if android else "secure_enclave",
        "native_sdk_version": full["application"]["native_sdk_version"],
        "native_evidence_sha256": full["application"]["native_evidence_sha256"],
        "session_state": "active",
        "new_architecture": True,
    }
    pins = {
        name: value for name, value in profile["expected_pins"].items()
        if name not in {"application_identifier", "app_version", "build_number", "native_sdk_version", "installer_package"}
    }
    pins["distribution"] = full["application"]["distribution"]
    raw = {
        "schema_version": finalizer.RAW_SCHEMA,
        "platform": platform,
        "run": full["run"],
        "gateway_version": full["gateway_version"],
        "native": native,
        "pins": pins,
        "application": application,
        "device": device,
        "tests": tests,
        "redaction": full["redaction"],
    }
    collected_application = {
        name: value for name, value in full["application"].items()
        if name not in {"new_architecture", "native_sdk_version", "native_evidence_sha256"}
    }
    collection = {
        "schema_version": finalizer.COLLECTION_SCHEMA,
        "platform": platform,
        "application": collected_application,
        "device": device,
    }

    native_profile = copy.deepcopy(profile)
    native_profile["platform"] = "android_play_integrity" if android else "ios_app_attest"
    native_profile["repository"] = "Latchway/latchway-android" if android else "Latchway/latchway-ios-sdk"
    for name in ("native_sdk_version", "native_evidence_sha256"):
        native_profile["expected_pins"].pop(name)
    if not android:
        native_profile["expected_pins"].pop("javascript_bundle_sha256")
        # The React Native candidate binds its whole staged .app tree in the
        # outer profile. The linked native SDK report has its own authoritative
        # profile and therefore must not inherit this wrapper-only coordinate.
        native_profile.pop("application_files_manifest_sha256", None)
        native_profile["application_bundle_tree_sha256"] = "e" * 64
        native_profile["schema_version"] = finalizer.ios_native_evidence.PROFILE_VERSION
        native_profile["toolchain"]["collector_version"] = "2"
        native_profile["expected_pins"].update({
            "latchway_application_id": "app_00000000000000000000000000",
            "latchway_environment": "production",
            "identity_provider": "firebase",
            "host_bundle_identifier": native_profile["expected_pins"]["application_identifier"],
            "widget_bundle_identifier": "dev.latchway.reactnative.widget",
            "share_bundle_identifier": "dev.latchway.reactnative.share",
            "action_bundle_identifier": "dev.latchway.reactnative.action",
            "host_definition_id": "host_app",
            "widget_definition_id": "home_widget",
            "share_definition_id": "share_sheet",
            "action_definition_id": "background_action",
            "host_binary_sha256": native_profile["application_binary_sha256"],
            "widget_binary_sha256": "9" * 64,
            "share_binary_sha256": "a" * 64,
            "action_binary_sha256": "b" * 64,
        })
    native_observation = copy.deepcopy(full)
    native_observation["platform"] = native_profile["platform"]
    for name in ("new_architecture", "native_sdk_version", "native_evidence_sha256"):
        native_observation["application"].pop(name)
    for name in ("native_sdk_version", "native_evidence_sha256"):
        native_observation["observed_pins"].pop(name)
    if not android:
        native_observation["observed_pins"].pop("javascript_bundle_sha256")
        native_observation["observed_pins"] = copy.deepcopy(native_profile["expected_pins"])
    native_validator = validator if android else finalizer.ios_native_evidence
    native_tests = native_validator.PLATFORM_POLICY[native_profile["platform"]]["tests"]
    if not android:
        native_tests = native_tests - native_validator.IOS_COMPONENT_TESTS
    native_observation["tests"] = []
    for name in sorted(native_tests):
        entry = {"id": name, "status": "passed", "duration_ms": 1}
        fixtures.concrete_test_fields(
            entry,
            name,
            "kotlin_latchway_exception" if android else "swift_latchway_problem",
            native_profile["platform"],
        )
        native_observation["tests"].append(entry)
    if android:
        native_evidence = validator.build_evidence(native_observation, native_profile, SCHEMA)
    else:
        linked_schema = json.loads(finalizer.IOS_NATIVE_SCHEMA_PATH.read_text(encoding="utf-8"))
        native_evidence = native_validator.build_evidence(
            native_observation,
            native_profile,
            linked_schema,
            ios_component_observation(native_profile, native_observation["run"]),
        )
    assert native_evidence["release_eligible"]
    encoded_native = (json.dumps(native_evidence, indent=2, sort_keys=True) + "\n").encode("utf-8")
    native_evidence_sha256 = hashlib.sha256(encoded_native).hexdigest()
    profile["expected_pins"]["native_evidence_sha256"] = native_evidence_sha256
    raw["pins"]["native_evidence_sha256"] = native_evidence_sha256
    raw["native"]["native_evidence_sha256"] = native_evidence_sha256
    client_policy = {
        "allow_debug": False,
        "allow_testing": False,
        "app_version": full["application"]["version"],
        "application_identifier": full["application"]["identifier"],
        "build_number": full["application"]["build"],
        "minimum_trust_level": "device_verified" if android else "app_verified",
        "platform": platform,
        "provider": "play_integrity" if android else "app_attest",
        "require_licensed": android,
        "require_play_recognized": android,
        "require_request_hash": True,
        "signing_certificate_sha256": full["application"]["signing_certificate_sha256"],
    }
    if android:
        client_policy.update({
            "cloud_project_number": full["application"]["cloud_project_number"],
            "installer_package": full["application"]["installer_package"],
            "play_track": full["application"]["play_track"],
        })
    else:
        client_policy.update({
            "app_attest_environment": full["application"]["app_attest_environment"],
            "team_id": full["application"]["team_id"],
        })
    return profile, raw, collection, native_profile, native_evidence, client_policy


def finalize_case(
    profile: dict,
    raw: dict,
    collection: dict,
    native_profile: dict,
    native_evidence: dict,
    client_policy: dict,
    schema: dict,
):
    return finalizer.build(
        raw,
        collection,
        profile,
        native_evidence,
        native_profile,
        client_policy,
        schema,
        profile["expected_pins"]["native_evidence_sha256"],
    )


class FinalizeReactNativeRunTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = SCHEMA

    def test_both_platform_runs_build_valid_shared_evidence(self) -> None:
        for platform in ("react_native_ios_app_attest", "react_native_android_play_integrity"):
            with self.subTest(platform=platform):
                profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(platform)
                observation = finalize_case(
                    profile, raw, collection, native_profile, native_evidence, client_policy, self.schema,
                )
                evidence = validator.build_evidence(observation, profile, self.schema)
                self.assertTrue(evidence["release_eligible"])
                self.assertEqual(validator.verify(evidence, profile, self.schema), [])
                native_by_id = {item["id"]: item for item in native_evidence["tests"]}
                output_by_id = {item["id"]: item for item in observation["tests"]}
                for identifier in finalizer.LINKED_NATIVE_TESTS:
                    self.assertEqual(output_by_id[identifier], native_by_id[identifier])
                    self.assertNotIn(identifier, {item["id"] for item in raw["tests"]})

    def test_linked_ios_contract_is_the_reviewed_v2_snapshot(self) -> None:
        validator_path = ROOT / "scripts" / "linked-ios-device-evidence.py"
        schema_path = ROOT / "Conformance" / "linked-ios-physical-device-evidence.schema.json"
        self.assertEqual(
            hashlib.sha256(validator_path.read_bytes()).hexdigest(),
            IOS_REVIEWED_SNAPSHOT_SHA256["validator"],
        )
        self.assertEqual(
            hashlib.sha256(schema_path.read_bytes()).hexdigest(),
            IOS_REVIEWED_SNAPSHOT_SHA256["schema"],
        )
        sibling_ios = ROOT.parent / "latchway-ios-sdk"
        sibling_validator = sibling_ios / "scripts" / "device-evidence.py"
        sibling_schema = sibling_ios / "Conformance" / "physical-device-evidence.schema.json"
        if sibling_validator.is_file() and sibling_schema.is_file():
            self.assertEqual(validator_path.read_bytes(), sibling_validator.read_bytes())
            self.assertEqual(schema_path.read_bytes(), sibling_schema.read_bytes())
        self.assertEqual(
            finalizer.ios_native_evidence.IOS_COMPONENT_OBSERVATION_VERSION,
            "latchway.ios-component-observation.v2",
        )
        self.assertEqual(
            finalizer.ios_native_evidence.IOS_COMPONENT_TESTS,
            IOS_COMPONENT_TESTS_V2,
        )
        linked_schema = json.loads(schema_path.read_text(encoding="utf-8"))
        self.assertEqual(
            set(linked_schema["properties"]["component_runtime"]["required"]),
            {
                "identities",
                "widget_delegated_execution",
                "share_delegated_execution",
                "delegated_execution",
                "sibling_denial",
                "keychain_sibling_denial",
                "component_refresh_race",
                "lifecycle",
            },
        )

    def test_linked_ios_component_v2_proofs_fail_closed(self) -> None:
        mutations = {
            "widget request": lambda evidence: evidence["component_runtime"][
                "widget_delegated_execution"
            ].__setitem__("http_status", 401),
            "share request": lambda evidence: evidence["component_runtime"].pop(
                "share_delegated_execution"
            ),
            "action request": lambda evidence: evidence["component_runtime"][
                "delegated_execution"
            ].__setitem__("request_id", "request-widget-1234"),
            "Keychain denial": lambda evidence: evidence["component_runtime"][
                "keychain_sibling_denial"
            ].__setitem__("os_status", 0),
            "refresh race": lambda evidence: evidence["component_runtime"][
                "component_refresh_race"
            ]["requests"][1].__setitem__("request_id", "request-refresh-race-a"),
        }
        for label, mutate in mutations.items():
            with self.subTest(proof=label):
                _, _, _, native_profile, native_evidence, _ = raw_case(
                    "react_native_ios_app_attest"
                )
                mutate(native_evidence)
                with self.assertRaisesRegex(ValueError, "linked native evidence is invalid"):
                    finalizer.validate_linked_native_report(
                        native_evidence,
                        native_profile,
                        "ios_app_attest",
                        self.schema,
                    )

    def test_fresh_signer_jq_accepts_only_concrete_linked_ios_v2_proofs(self) -> None:
        workflow = (
            ROOT / ".github" / "workflows" / "physical-device-evidence.yml"
        ).read_text(encoding="utf-8")
        prefix = (
            "          jq --exit-status '\n"
            "            [\n"
            '              "action_delegated_request",'
        )
        suffix = '\n          \' "$root/linked-ios-native-evidence.json" >/dev/null'
        start = workflow.index(prefix) + len("          jq --exit-status '\n")
        end = workflow.index(suffix, start)
        program = textwrap.dedent(workflow[start:end])
        _, _, _, _, native_evidence, _ = raw_case("react_native_ios_app_attest")

        def jq(report: dict) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["jq", "--exit-status", program],
                input=json.dumps(report),
                text=True,
                capture_output=True,
                check=False,
            )

        accepted = jq(native_evidence)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        tampered = copy.deepcopy(native_evidence)
        tampered["component_runtime"]["keychain_sibling_denial"]["os_status"] = 0
        self.assertNotEqual(jq(tampered).returncode, 0)

    def test_linked_ios_legacy_component_observation_fails_closed(self) -> None:
        _, _, _, native_profile, native_evidence, _ = raw_case(
            "react_native_ios_app_attest"
        )
        component = ios_component_observation(native_profile, native_evidence["run"])
        component["schema_version"] = "latchway.ios-component-observation.v1"
        self.assertIn(
            "component observation.schema_version: unsupported value",
            finalizer.ios_native_evidence.validate_component_observation(
                component,
                platform="ios_app_attest",
                run_id=native_evidence["run"]["id"],
                run_started=native_evidence["run"]["started_at"],
                run_completed=native_evidence["run"]["completed_at"],
            ),
        )

    def test_raw_mapping_requires_root_component_authorization_response(self) -> None:
        for platform in (
            "react_native_ios_app_attest",
            "react_native_android_play_integrity",
        ):
            with self.subTest(platform=platform):
                profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
                    platform,
                )
                mapping = next(
                    item for item in raw["tests"]
                    if item["id"] == "canonical_error_mapping"
                )
                self.assertEqual(mapping["http_status"], 403)
                self.assertEqual(mapping["error_code"], "component_feature_not_granted")
                mapping.update(http_status=404, error_code="feature_not_found")
                with self.assertRaisesRegex(
                    ValueError,
                    "canonical_error_mapping must record HTTP 403 component_feature_not_granted",
                ):
                    finalize_case(
                        profile,
                        raw,
                        collection,
                        native_profile,
                        native_evidence,
                        client_policy,
                        self.schema,
                    )

    def test_shared_and_linked_validators_keep_platform_specific_mapping_contracts(self) -> None:
        self.assertEqual(
            validator.canonical_error_mapping_response("react_native_ios_app_attest"),
            (403, "component_feature_not_granted"),
        )
        self.assertEqual(
            validator.canonical_error_mapping_response("ios_app_attest"),
            (404, "feature_not_found"),
        )
        _, raw, _, _, native_evidence, _ = raw_case("react_native_ios_app_attest")
        raw_mapping = next(
            item for item in raw["tests"] if item["id"] == "canonical_error_mapping"
        )
        native_mapping = next(
            item
            for item in native_evidence["tests"]
            if item["id"] == "canonical_error_mapping"
        )
        self.assertEqual(
            (raw_mapping["http_status"], raw_mapping["error_code"]),
            (403, "component_feature_not_granted"),
        )
        self.assertEqual(
            (native_mapping["http_status"], native_mapping["error_code"]),
            (404, "feature_not_found"),
        )

    def test_embedded_pin_substitution_is_rejected(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case("react_native_ios_app_attest")
        raw["pins"]["core_commit"] = "0" * 40
        with self.assertRaises(ValueError):
            finalize_case(profile, raw, collection, native_profile, native_evidence, client_policy, self.schema)

    def test_behavior_substitution_is_rejected(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
            "react_native_android_play_integrity",
        )
        rotation = next(item for item in native_evidence["tests"] if item["id"] == "session_refresh_rotation")
        rotation["credential_after_sha256"] = rotation["credential_before_sha256"]
        with self.assertRaises(ValueError):
            finalize_case(profile, raw, collection, native_profile, native_evidence, client_policy, self.schema)

    def test_ios_raw_assertion_reuse_is_required_for_release_eligibility(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
            "react_native_ios_app_attest",
        )
        assertion = next(item for item in raw["tests"] if item["id"] == "app_attest_assertion")
        assertion["status"] = "failed"
        observation = finalize_case(
            profile,
            raw,
            collection,
            native_profile,
            native_evidence,
            client_policy,
            self.schema,
        )
        evidence = validator.build_evidence(observation, profile, self.schema)
        self.assertFalse(evidence["release_eligible"])
        self.assertIn(
            "test 'app_attest_assertion' did not pass",
            validator.verify(evidence, profile, self.schema),
        )

    def test_raw_run_cannot_claim_a_linked_native_security_proof(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
            "react_native_ios_app_attest",
        )
        raw["tests"].append(next(
            copy.deepcopy(item)
            for item in native_evidence["tests"]
            if item["id"] == "dpop_replay_rejected"
        ))
        with self.assertRaises(ValueError):
            finalize_case(profile, raw, collection, native_profile, native_evidence, client_policy, self.schema)

    def test_missing_or_renamed_linked_native_proof_is_rejected(self) -> None:
        for replacement in (None, "replay_rejected"):
            with self.subTest(replacement=replacement):
                profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
                    "react_native_android_play_integrity",
                )
                proof = next(item for item in native_evidence["tests"] if item["id"] == "dpop_replay_rejected")
                if replacement is None:
                    native_evidence["tests"].remove(proof)
                else:
                    proof["id"] = replacement
                with self.assertRaises(ValueError):
                    finalize_case(
                        profile, raw, collection, native_profile, native_evidence, client_policy, self.schema,
                    )

    def test_native_evidence_hash_must_match_candidate_and_profile(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
            "react_native_ios_app_attest",
        )
        with self.assertRaisesRegex(ValueError, "not bound to the candidate"):
            finalizer.build(
                raw,
                collection,
                profile,
                native_evidence,
                native_profile,
                client_policy,
                self.schema,
                "f" * 64,
            )

    def test_legacy_raw_schema_and_extended_native_proof_are_rejected(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
            "react_native_ios_app_attest",
        )
        raw["schema_version"] = "latchway.react-native-device-run.v1"
        with self.assertRaises(ValueError):
            finalize_case(profile, raw, collection, native_profile, native_evidence, client_policy, self.schema)

        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
            "react_native_ios_app_attest",
        )
        proof = next(item for item in native_evidence["tests"] if item["id"] == "dpop_replay_rejected")
        proof["mapped_error_type"] = "swift_latchway_problem"
        with self.assertRaises(ValueError):
            finalize_case(profile, raw, collection, native_profile, native_evidence, client_policy, self.schema)

    def test_linked_native_platform_or_source_substitution_is_rejected(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
            "react_native_ios_app_attest",
        )
        native_evidence["source"]["commit"] = "0" * 40
        with self.assertRaises(ValueError):
            finalize_case(profile, raw, collection, native_profile, native_evidence, client_policy, self.schema)

    def test_internally_valid_native_coordinate_substitution_is_rejected(self) -> None:
        mutations = (
            ("core_commit", "0" * 40),
            ("contract_version", "9.9.9"),
            ("sdk_version", "9.9.9"),
            ("gateway_version", "9.9.9"),
        )
        for name, replacement in mutations:
            with self.subTest(name=name):
                profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
                    "react_native_ios_app_attest",
                )
                native_evidence["source"][name] = replacement
                if name != "gateway_version":
                    native_profile["source"][name] = replacement
                if name == "core_commit":
                    native_profile["expected_pins"][name] = replacement
                    pin = next(item for item in native_evidence["pins"] if item["name"] == name)
                    pin.update(expected=replacement, observed=replacement, matched=True)
                native_evidence["artifacts"]["profile_sha256"] = (
                    finalizer.ios_native_evidence.canonical_sha256(native_profile)
                )
                finalizer.validate_linked_native_report(
                    native_evidence,
                    native_profile,
                    "ios_app_attest",
                    self.schema,
                )
                with self.assertRaisesRegex(ValueError, "coordinates|SDK or contract"):
                    finalize_case(
                        profile,
                        raw,
                        collection,
                        native_profile,
                        native_evidence,
                        client_policy,
                        self.schema,
                    )

    def test_linked_native_preflight_accepts_v2_ios_and_v1_android(self) -> None:
        for platform, native_platform in (
            ("react_native_ios_app_attest", "ios_app_attest"),
            ("react_native_android_play_integrity", "android_play_integrity"),
        ):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(platform)
                root = pathlib.Path(directory)
                profile_path = root / "profile.json"
                evidence_path = root / "evidence.json"
                schema_path = root / "schema.json"
                profile_path.write_text(
                    json.dumps(native_profile, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                evidence_path.write_text(
                    json.dumps(native_evidence, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                schema_path.write_text(
                    json.dumps(self.schema, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                completed = subprocess.run(
                    [
                        sys.executable,
                        str(ROOT / "scripts" / "verify-linked-native-evidence.py"),
                        "--platform", native_platform,
                        "--profile", str(profile_path),
                        "--evidence", str(evidence_path),
                        "--output-schema", str(schema_path),
                        "--expected-sha256", profile["expected_pins"]["native_evidence_sha256"],
                        "--expected-source-commit", native_evidence["source"]["commit"],
                        "--expected-core-commit", native_evidence["source"]["core_commit"],
                        "--expected-native-sdk-version", native_evidence["source"]["sdk_version"],
                        "--expected-contract-version", native_evidence["source"]["contract_version"],
                        "--expected-contract-bundle-sha256",
                        native_evidence["source"]["contract_bundle_sha256"],
                        "--expected-gateway-image-digest",
                        native_evidence["source"]["gateway_image_digest"],
                        "--expected-gateway-configuration-sha256",
                        native_evidence["source"]["gateway_configuration_sha256"],
                        "--expected-gateway-origin", native_evidence["source"]["gateway_origin"],
                        "--expected-gateway-deployment-key-id",
                        native_evidence["source"]["gateway_deployment_key_id"],
                        "--expected-gateway-deployment-statement-sha256",
                        native_evidence["source"]["gateway_deployment_statement_sha256"],
                        "--expected-gateway-deployment-public-key-sha256",
                        native_evidence["source"]["gateway_deployment_public_key_sha256"],
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_native_loader_hashes_the_bytes_it_parses_and_rejects_symlinks(self) -> None:
        _, _, _, _, native_evidence, _ = raw_case("react_native_ios_app_attest")
        encoded = (json.dumps(native_evidence, indent=2, sort_keys=True) + "\n").encode("utf-8")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            evidence_path = root / "evidence.json"
            link_path = root / "linked.json"
            evidence_path.write_bytes(encoded)
            parsed, digest = finalizer.load_hashed_json(evidence_path)
            evidence_path.write_text("{}\n", encoding="utf-8")
            self.assertEqual(parsed, native_evidence)
            self.assertEqual(digest, hashlib.sha256(encoded).hexdigest())
            link_path.symlink_to(evidence_path)
            with self.assertRaises(OSError):
                finalizer.load_hashed_json(link_path)

    def test_all_raw_sinks_are_v2_and_omit_native_only_proof_ids(self) -> None:
        paths = (
            ROOT / "example" / "src" / "App.tsx",
            ROOT / "example" / "ios" / "LatchwayExample" / "AppDelegate.swift",
            ROOT / "example" / "android" / "app" / "src" / "main" / "java"
            / "com" / "latchwayexample" / "LatchwayEvidenceModule.kt",
        )
        for path in paths:
            with self.subTest(path=path):
                source = path.read_text(encoding="utf-8")
                self.assertIn(finalizer.RAW_SCHEMA, source)
                for identifier in finalizer.LINKED_NATIVE_TESTS:
                    self.assertNotIn(identifier, source)

    def test_cli_hashes_the_exact_linked_native_report_bytes(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
            "react_native_android_play_integrity",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            values = {
                "raw.json": raw,
                "collection.json": collection,
                "profile.json": profile,
                "native-evidence.json": native_evidence,
                "native-profile.json": native_profile,
                "client-policy.json": client_policy,
                "schema.json": self.schema,
            }
            for name, value in values.items():
                (root / name).write_text(
                    json.dumps(value, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
            observation = root / "observation.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts" / "finalize-react-native-device-run.py"),
                    "--raw", str(root / "raw.json"),
                    "--collection", str(root / "collection.json"),
                    "--profile", str(root / "profile.json"),
                    "--native-evidence", str(root / "native-evidence.json"),
                    "--native-profile", str(root / "native-profile.json"),
                    "--client-policy", str(root / "client-policy.json"),
                    "--schema", str(root / "schema.json"),
                    "--observation", str(observation),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(observation.is_file())

            native_path = root / "native-evidence.json"
            native_path.write_text(native_path.read_text(encoding="utf-8") + "\n", encoding="utf-8")
            rejected = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts" / "finalize-react-native-device-run.py"),
                    "--raw", str(root / "raw.json"),
                    "--collection", str(root / "collection.json"),
                    "--profile", str(root / "profile.json"),
                    "--native-evidence", str(native_path),
                    "--native-profile", str(root / "native-profile.json"),
                    "--client-policy", str(root / "client-policy.json"),
                    "--schema", str(root / "schema.json"),
                    "--observation", str(root / "rejected.json"),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(rejected.returncode, 1)
            self.assertFalse((root / "rejected.json").exists())

    def test_debug_runtime_never_becomes_release_eligible(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case("react_native_android_play_integrity")
        raw["application"]["debuggable"] = True
        collection["application"]["debuggable"] = True
        observation = finalize_case(
            profile, raw, collection, native_profile, native_evidence, client_policy, self.schema,
        )
        evidence = validator.build_evidence(observation, profile, self.schema)
        self.assertFalse(evidence["release_eligible"])

    def test_ios_rejects_device_scoped_trust_instead_of_app_attest_normalization(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
            "react_native_ios_app_attest",
        )
        raw["native"]["trust_level"] = "device_verified"
        observation = finalize_case(
            profile, raw, collection, native_profile, native_evidence, client_policy, self.schema,
        )
        evidence = validator.build_evidence(observation, profile, self.schema)
        self.assertFalse(evidence["release_eligible"])
        self.assertEqual(observation["provider"]["trust_level"], "none")


if __name__ == "__main__":
    unittest.main()
