#!/usr/bin/env python3

from __future__ import annotations

import copy
import datetime as dt
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
VALIDATOR_PATH = ROOT / "scripts" / "device-evidence.py"
FIXTURE_PATH = ROOT / "scripts" / "test-device-evidence.py"
EXPORTER_PATH = ROOT / "scripts" / "export-core-physical-evidence.py"
RN_FINALIZER_FIXTURE_PATH = ROOT / "scripts" / "test-finalize-react-native-device-run.py"
SCHEMA_PATH = ROOT / "Conformance" / "physical-device-evidence.schema.json"
CORE_CONSUMER_PATH = ROOT.parent / "latchway" / "scripts" / "cross-repo-conformance.py"


def load_module(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


validator = load_module("device_evidence_export_test", VALIDATOR_PATH)
fixtures = load_module("device_evidence_fixtures", FIXTURE_PATH)
exporter = load_module("physical_evidence_exporter", EXPORTER_PATH)
rn_finalizer_fixtures = load_module("rn_finalizer_export_fixtures", RN_FINALIZER_FIXTURE_PATH)
core_consumer = (
    load_module("latchway_core_cross_repo_consumer", CORE_CONSUMER_PATH)
    if CORE_CONSUMER_PATH.is_file()
    else None
)

EXTERNAL_DOCUMENT_FIELDS = {
    "schema_version",
    "kind",
    "domain",
    "status",
    "started_at",
    "finished_at",
    "core_commit",
    "core_release",
    "contract_version",
    "bundle_sha256",
    "oci_image_digest",
    "repositories",
    "claims",
    "artifacts",
}

GATEWAY_DEPLOYMENT = {
    "gateway_origin": "https://gateway.example.com",
    "gateway_deployment_key_id": "release-2026",
    "gateway_deployment_statement_sha256": "d" * 64,
    "gateway_deployment_public_key_sha256": "e" * 64,
}


def bind_gateway_deployment(profile: dict, observation: dict) -> None:
    profile["source"].update(GATEWAY_DEPLOYMENT)
    profile["expected_pins"].update(GATEWAY_DEPLOYMENT)
    observation["observed_pins"].update(GATEWAY_DEPLOYMENT)


def bind_finalized_ios_gateway(profile: dict, evidence: dict) -> None:
    profile["source"].update(GATEWAY_DEPLOYMENT)
    profile["expected_pins"].update(GATEWAY_DEPLOYMENT)
    evidence["source"].update(GATEWAY_DEPLOYMENT)
    pins = {item["name"]: item for item in evidence["pins"]}
    for name, value in GATEWAY_DEPLOYMENT.items():
        pins[name].update(expected=value, observed=value, matched=True)
    evidence["artifacts"]["profile_sha256"] = (
        rn_finalizer_fixtures.finalizer.ios_native_evidence.canonical_sha256(profile)
    )


def android_native_case() -> tuple[dict, dict]:
    current_profile = fixtures.profile()
    expected = {
        "application_identifier": "dev.latchway.conformance",
        "app_version": "1.0.0",
        "build_number": "42",
        "signing_certificate_sha256": "1" * 64,
        "cloud_project_number": "123456789012",
        "installer_package": "com.android.vending",
        "play_track": "internal",
        "require_licensed": "true",
        "source_commit": "2" * 40,
        "core_commit": "7" * 40,
        "contract_bundle_sha256": "3" * 64,
        "gateway_image_digest": "sha256:" + "4" * 64,
        "gateway_configuration_sha256": "5" * 64,
        "gateway_environment": "production",
        "error_mapping_feature": "missing_feature",
    }
    current_profile.update(
        platform="android_play_integrity",
        repository="Latchway/latchway-android",
        expected_pins=expected,
    )
    current_observation = fixtures.observation()
    current_observation["platform"] = "android_play_integrity"
    current_observation["application"] = {
        "identifier": expected["application_identifier"],
        "version": expected["app_version"],
        "build": expected["build_number"],
        "build_mode": "release",
        "distribution": "play_internal",
        "debuggable": False,
        "signing_certificate_sha256": expected["signing_certificate_sha256"],
        "cloud_project_number": expected["cloud_project_number"],
        "installer_package": expected["installer_package"],
        "play_track": expected["play_track"],
    }
    current_observation["device"].update(
        simulator=False,
        emulator=False,
        model="Google Pixel",
        os_name="Android",
        os_version="17",
        os_build="release-build",
        security_level="strongbox",
    )
    current_observation["provider"] = {
        "name": "play_integrity",
        "environment": "production",
        "trust_level": "strong_device_verified",
        "request_hash_bound": True,
        "app_recognition": "PLAY_RECOGNIZED",
        "account_licensing": "LICENSED",
    }
    current_observation["observed_pins"] = copy.deepcopy(expected)
    current_observation["tests"] = tests_for("android_play_integrity")
    return current_profile, current_observation


def tests_for(platform: str) -> list[dict]:
    result = []
    for name in sorted(validator.PLATFORM_POLICY[platform]["tests"]):
        entry = {"id": name, "status": "passed", "duration_ms": 1}
        fixtures.concrete_test_fields(entry, name, "kotlin_latchway_exception", platform)
        result.append(entry)
    return result


class ExportCoreEvidenceTest(unittest.TestCase):
    def test_json_loader_rejects_duplicate_nonfinite_and_symlinked_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            duplicate = root / "duplicate.json"
            nonfinite = root / "nonfinite.json"
            target = root / "target.json"
            link = root / "link.json"
            duplicate.write_text('{"commit":"a","commit":"b"}', encoding="utf-8")
            nonfinite.write_text('{"value":Infinity}', encoding="utf-8")
            target.write_text('{"valid":true}', encoding="utf-8")
            link.symlink_to(target)

            for path in (duplicate, nonfinite, link):
                with self.subTest(path=path.name), self.assertRaises(exporter.Rejected):
                    exporter.load_json(path)

    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def write_case(
        self,
        root: pathlib.Path,
        mismatched_link: bool = False,
        versions: dict[str, str] | None = None,
        coordinate_mismatch: str | None = None,
        deployment_mismatch: bool = False,
    ) -> tuple[pathlib.Path, list[pathlib.Path], list[pathlib.Path], list[pathlib.Path]]:
        versions = versions or {
            "core": "1.0.0",
            "javascript": "0.1.0",
            "ios": "0.1.0",
            "android": "0.1.0",
            "react_native": "1.0.0",
        }
        (
            _, _, _, native_ios_profile, native_ios_evidence, _,
        ) = rn_finalizer_fixtures.raw_case("react_native_ios_app_attest")
        native_ios_profile["source"]["sdk_version"] = versions["ios"]
        native_ios_evidence["source"]["sdk_version"] = versions["ios"]
        bind_finalized_ios_gateway(native_ios_profile, native_ios_evidence)
        native_android_profile, native_android_observation = android_native_case()
        native_android_profile["source"]["sdk_version"] = versions["android"]
        bind_gateway_deployment(native_android_profile, native_android_observation)
        paths: list[pathlib.Path] = []
        native_hashes: dict[str, str] = {}
        rn_finalizer_fixtures.finalizer.validate_linked_native_report(
            native_ios_evidence,
            native_ios_profile,
            "ios_app_attest",
            self.schema,
        )
        self.assertEqual(native_ios_evidence["schema_version"], "latchway.physical-device-evidence.v2")
        for name, profile, evidence in (
            ("ios", native_ios_profile, native_ios_evidence),
            (
                "android",
                native_android_profile,
                validator.build_evidence(native_android_observation, native_android_profile, self.schema),
            ),
        ):
            self.assertTrue(evidence["release_eligible"], name)
            profile_path = root / f"{name}-profile.json"
            evidence_path = root / f"{name}-evidence.json"
            profile_path.write_text(json.dumps(profile), encoding="utf-8")
            evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
            native_hashes[name] = validator.sha256_file(evidence_path)
            paths.extend((profile_path, evidence_path))

        for name, platform, native_name in (
            ("rn-ios", "react_native_ios_app_attest", "ios"),
            ("rn-android", "react_native_android_play_integrity", "android"),
        ):
            profile, observation = fixtures.react_native_case(platform)
            profile["source"]["sdk_version"] = versions["react_native"]
            bind_gateway_deployment(profile, observation)
            if deployment_mismatch and name == "rn-ios":
                profile["source"]["gateway_deployment_statement_sha256"] = "f" * 64
                profile["expected_pins"]["gateway_deployment_statement_sha256"] = "f" * 64
                observation["observed_pins"]["gateway_deployment_statement_sha256"] = "f" * 64
            linked_hash = native_hashes[native_name]
            if mismatched_link and name == "rn-ios":
                linked_hash = "0" * 64
            profile["expected_pins"]["native_evidence_sha256"] = linked_hash
            observation["application"]["native_evidence_sha256"] = linked_hash
            observation["observed_pins"]["native_evidence_sha256"] = linked_hash
            evidence = validator.build_evidence(observation, profile, self.schema)
            self.assertTrue(evidence["release_eligible"])
            profile_path = root / f"{name}-profile.json"
            evidence_path = root / f"{name}-evidence.json"
            profile_path.write_text(json.dumps(profile), encoding="utf-8")
            evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
            paths.extend((profile_path, evidence_path))

        coordinates = {
            "schema_version": 1,
            "core_commit": "7" * 40,
            "core_release": f"v{versions['core']}",
            "contract_version": "1.0.0",
            "bundle_sha256": "3" * 64,
            "oci_image_digest": "ghcr.io/latchway/latchway@sha256:" + "4" * 64,
            "gateway_configuration_sha256": "5" * 64,
            "repositories": {
                name: {
                    "commit": commit,
                    "tag": f"v{versions[name]}",
                    "version": versions[name],
                }
                for name, commit in {
                    "core": "7" * 40,
                    "javascript": "a" * 40,
                    "ios": "2" * 40,
                    "android": "2" * 40,
                    "react_native": "2" * 40,
                }.items()
            },
        }
        if coordinate_mismatch == "commit":
            coordinates["repositories"]["ios"]["commit"] = "c" * 40
        elif coordinate_mismatch == "version":
            coordinates["repositories"]["ios"].update(version="0.2.0", tag="v0.2.0")
        elif coordinate_mismatch is not None:
            raise AssertionError(f"unsupported coordinate mismatch: {coordinate_mismatch}")
        coordinates_path = root / "coordinates.json"
        coordinates_path.write_text(json.dumps(coordinates), encoding="utf-8")
        attestations: list[pathlib.Path] = []
        manifests: list[pathlib.Path] = []
        for index, name in enumerate(("ios", "android", "rn-ios", "rn-android")):
            attestation = root / f"{name}-attestation.sigstore.json"
            attestation.write_text('{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}\n', encoding="utf-8")
            attestations.append(attestation)
            profile_path = paths[index * 2]
            evidence_path = paths[index * 2 + 1]
            manifest = root / f"{name}-SHA256SUMS"
            manifest.write_text(
                f"{validator.sha256_file(evidence_path)}  {evidence_path.name}\n"
                f"{validator.sha256_file(profile_path)}  {profile_path.name}\n",
                encoding="utf-8",
            )
            manifests.append(manifest)
        return coordinates_path, paths, attestations, manifests

    def invoke(
        self,
        root: pathlib.Path,
        output: pathlib.Path,
        mismatched_link: bool = False,
        provenance_failure: bool = False,
        versions: dict[str, str] | None = None,
        coordinate_mismatch: str | None = None,
        deployment_mismatch: bool = False,
    ):
        coordinates, paths, attestations, manifests = self.write_case(
            root,
            mismatched_link,
            versions,
            coordinate_mismatch,
            deployment_mismatch,
        )
        binary_root = root / "bin"
        binary_root.mkdir()
        fake_gh = binary_root / "gh"
        fake_gh.write_text(
            "#!/bin/sh\n"
            "if [ \"${1:-}\" = version ]; then\n"
            "  printf 'gh version 2.97.0 (2026-08-29)\\nhttps://github.com/cli/cli/releases\\n'\n"
            "  exit 0\n"
            "fi\n"
            "if [ \"${LATCHWAY_TEST_PROVENANCE_FAILURE:-}\" = 1 ]; then exit 1; fi\n"
            "printf '[{\"verificationResult\":{}}]\\n'\n",
            encoding="utf-8",
        )
        fake_gh.chmod(0o755)
        fake_git = binary_root / "git"
        fake_git.write_text(
            "#!/bin/sh\n"
            "printf 'exporter must not resolve candidate release tags\\n' >&2\n"
            "exit 97\n",
            encoding="utf-8",
        )
        fake_git.chmod(0o755)
        names = ("ios", "android", "rn-ios", "rn-android")
        command = [
            sys.executable,
            str(EXPORTER_PATH),
            "--schema", str(SCHEMA_PATH),
            "--coordinates", str(coordinates),
            "--output-root", str(output),
        ]
        for index, name in enumerate(names):
            command.extend((
                f"--{name}-profile", str(paths[index * 2]),
                f"--{name}-evidence", str(paths[index * 2 + 1]),
                f"--{name}-attestation", str(attestations[index]),
                f"--{name}-manifest", str(manifests[index]),
            ))
        environment = dict(os.environ)
        environment["PATH"] = f"{binary_root}{os.pathsep}{environment.get('PATH', '')}"
        if provenance_failure:
            environment["LATCHWAY_TEST_PROVENANCE_FAILURE"] = "1"
        return subprocess.run(command, capture_output=True, text=True, check=False, env=environment)

    def test_exports_exact_core_domain_and_hash_bound_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            output = root / "external-evidence"
            completed = self.invoke(root, output)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            document_path = output / "physical_devices.json"
            document = json.loads(document_path.read_text())
            self.assertEqual(set(document), EXTERNAL_DOCUMENT_FIELDS)
            self.assertNotIn("gateway_configuration_sha256", document)
            self.assertEqual(document["domain"], "physical_devices")
            self.assertEqual(set(document["claims"]), {
                "app_attest_production_verified",
                "play_integrity_play_distributed_verified",
                "react_native_ios_verified",
                "react_native_android_verified",
            })
            self.assertTrue(all(document["claims"].values()))
            self.assertEqual(len(document["artifacts"]), 16)
            for artifact in document["artifacts"]:
                path = output / artifact["path"]
                self.assertEqual(validator.sha256_file(path), artifact["sha256"])
                if artifact["path"].endswith("-evidence.json"):
                    raw_report = json.loads(path.read_text(encoding="utf-8"))
                    self.assertEqual(
                        raw_report["source"]["gateway_configuration_sha256"],
                        "5" * 64,
                    )

            if core_consumer is not None:
                accepted = core_consumer.validate_external_document(
                    output.resolve(),
                    document_path,
                    "physical_devices",
                    core_consumer.EXTERNAL_DOMAINS["physical_devices"],
                    document["repositories"],
                    document["contract_version"],
                    document["bundle_sha256"],
                    document["core_commit"],
                    document["core_release"],
                    dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1),
                    dt.datetime.now(dt.timezone.utc),
                    document["oci_image_digest"],
                )
                self.assertEqual(accepted["artifact_count"], 16)

    def test_accepts_exact_candidate_commits_before_future_tags_exist(self) -> None:
        versions = {
            "core": "97.0.0-rc.7",
            "javascript": "96.0.0-rc.6",
            "ios": "95.0.0-rc.5",
            "android": "94.0.0-rc.4",
            "react_native": "93.0.0-rc.3",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            output = root / "external-evidence"
            completed = self.invoke(root, output, versions=versions)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            document = json.loads((output / "physical_devices.json").read_text())
            self.assertEqual(
                document["repositories"],
                {
                    name: {
                        "commit": commit,
                        "tag": f"v{versions[name]}",
                        "version": versions[name],
                    }
                    for name, commit in {
                        "core": "7" * 40,
                        "javascript": "a" * 40,
                        "ios": "2" * 40,
                        "android": "2" * 40,
                        "react_native": "2" * 40,
                    }.items()
                },
            )

    def test_rejects_candidate_commit_and_version_coordinate_drift(self) -> None:
        for mismatch in ("commit", "version"):
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                output = root / "external-evidence"
                completed = self.invoke(root, output, coordinate_mismatch=mismatch)
                self.assertNotEqual(completed.returncode, 0)
                self.assertFalse((output / "physical_devices.json").exists())
                summary = json.loads(
                    (output / "physical_devices-validation.json").read_text()
                )
                self.assertEqual(
                    summary["error"],
                    "ios_app_attest_release_coordinates_mismatch",
                )

    def test_rejects_react_native_native_evidence_substitution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            output = root / "external-evidence"
            completed = self.invoke(root, output, mismatched_link=True)
            self.assertNotEqual(completed.returncode, 0)
            self.assertFalse((output / "physical_devices.json").exists())
            summary = json.loads((output / "physical_devices-validation.json").read_text())
            self.assertEqual(summary["error"], "react_native_ios_native_link_mismatch")

    def test_rejects_mixed_gateway_deployments(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            output = root / "external-evidence"
            completed = self.invoke(root, output, deployment_mismatch=True)
            self.assertNotEqual(completed.returncode, 0)
            summary = json.loads((output / "physical_devices-validation.json").read_text())
            self.assertEqual(summary["error"], "gateway_deployment_coordinates_mismatch")

    def test_rejects_unverified_workflow_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            output = root / "external-evidence"
            completed = self.invoke(root, output, provenance_failure=True)
            self.assertNotEqual(completed.returncode, 0)
            self.assertFalse((output / "physical_devices.json").exists())
            summary = json.loads((output / "physical_devices-validation.json").read_text())
            self.assertEqual(summary["error"], "ios_app_attest_provenance_invalid")


if __name__ == "__main__":
    unittest.main()
