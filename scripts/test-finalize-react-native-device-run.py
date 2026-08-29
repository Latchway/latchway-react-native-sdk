#!/usr/bin/env python3

from __future__ import annotations

import copy
import importlib.util
import json
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "Conformance" / "physical-device-evidence.schema.json").read_text())


def load(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validator = load("rn_run_validator", ROOT / "scripts" / "device-evidence.py")
fixtures = load("rn_run_fixtures", ROOT / "scripts" / "test-device-evidence.py")
finalizer = load("rn_run_finalizer", ROOT / "scripts" / "finalize-react-native-device-run.py")


def raw_case(platform: str):
    profile, full = fixtures.react_native_case(platform)
    android = platform.endswith("android_play_integrity")
    tests = [item for item in full["tests"] if item["id"] not in {
        "physical_device", "identifier_pins", "native_evidence_linked",
    }]
    application = {
        name: full["application"][name]
        for name in ({"identifier", "version", "build", "debuggable", "installer_package"}
                     if android else {"identifier", "version", "build", "debuggable"})
    }
    device = {name: value for name, value in full["device"].items() if name != "security_level"}
    native = {
        "provider": "play_integrity" if android else "app_attest",
        "trust_level": "strong_device_verified",
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
    native_observation = copy.deepcopy(full)
    native_observation["platform"] = native_profile["platform"]
    for name in ("new_architecture", "native_sdk_version", "native_evidence_sha256"):
        native_observation["application"].pop(name)
    for name in ("native_sdk_version", "native_evidence_sha256"):
        native_observation["observed_pins"].pop(name)
    if not android:
        native_observation["observed_pins"].pop("javascript_bundle_sha256")
    native_observation["tests"] = []
    for name in sorted(validator.PLATFORM_POLICY[native_profile["platform"]]["tests"]):
        entry = {"id": name, "status": "passed", "duration_ms": 1}
        fixtures.concrete_test_fields(
            entry,
            name,
            "kotlin_latchway_exception" if android else "swift_latchway_problem",
        )
        native_observation["tests"].append(entry)
    native_evidence = validator.build_evidence(native_observation, native_profile, SCHEMA)
    assert native_evidence["release_eligible"]
    client_policy = {
        "allow_debug": False,
        "allow_testing": False,
        "app_version": full["application"]["version"],
        "application_identifier": full["application"]["identifier"],
        "build_number": full["application"]["build"],
        "minimum_trust_level": "device_verified",
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


class FinalizeReactNativeRunTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = SCHEMA

    def test_both_platform_runs_build_valid_shared_evidence(self) -> None:
        for platform in ("react_native_ios_app_attest", "react_native_android_play_integrity"):
            with self.subTest(platform=platform):
                profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(platform)
                observation = finalizer.build(
                    raw, collection, profile, native_evidence, native_profile, client_policy, self.schema,
                )
                evidence = validator.build_evidence(observation, profile, self.schema)
                self.assertTrue(evidence["release_eligible"])
                self.assertEqual(validator.verify(evidence, profile, self.schema), [])

    def test_embedded_pin_substitution_is_rejected(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case("react_native_ios_app_attest")
        raw["pins"]["core_commit"] = "0" * 40
        with self.assertRaises(ValueError):
            finalizer.build(raw, collection, profile, native_evidence, native_profile, client_policy, self.schema)

    def test_behavior_substitution_is_rejected(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
            "react_native_android_play_integrity",
        )
        rotation = next(item for item in raw["tests"] if item["id"] == "session_refresh_rotation")
        rotation["credential_after_sha256"] = rotation["credential_before_sha256"]
        with self.assertRaises(ValueError):
            finalizer.build(raw, collection, profile, native_evidence, native_profile, client_policy, self.schema)

    def test_debug_runtime_never_becomes_release_eligible(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case("react_native_android_play_integrity")
        raw["application"]["debuggable"] = True
        collection["application"]["debuggable"] = True
        observation = finalizer.build(
            raw, collection, profile, native_evidence, native_profile, client_policy, self.schema,
        )
        evidence = validator.build_evidence(observation, profile, self.schema)
        self.assertFalse(evidence["release_eligible"])

    def test_app_only_trust_cannot_be_upgraded_to_device_verified(self) -> None:
        profile, raw, collection, native_profile, native_evidence, client_policy = raw_case(
            "react_native_ios_app_attest",
        )
        raw["native"]["trust_level"] = "app_verified"
        observation = finalizer.build(
            raw, collection, profile, native_evidence, native_profile, client_policy, self.schema,
        )
        evidence = validator.build_evidence(observation, profile, self.schema)
        self.assertFalse(evidence["release_eligible"])
        self.assertEqual(observation["provider"]["trust_level"], "none")


if __name__ == "__main__":
    unittest.main()
