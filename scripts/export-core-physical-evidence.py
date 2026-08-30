#!/usr/bin/env python3
"""Aggregate four validated device reports into core physical_devices.json.

The adapter is intentionally offline and deterministic. It never creates a
passing claim from user booleans: all four platform reports must independently
validate, share the protected release coordinates, and preserve the native
evidence hashes linked by both React Native reports.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Any


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
VALIDATOR_PATH = SCRIPT_DIR / "device-evidence.py"
SPEC = importlib.util.spec_from_file_location("device_evidence", VALIDATOR_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("physical evidence validator cannot be loaded")
device_evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(device_evidence)
FINALIZER_SPEC = importlib.util.spec_from_file_location(
    "react_native_device_finalizer",
    SCRIPT_DIR / "finalize-react-native-device-run.py",
)
if FINALIZER_SPEC is None or FINALIZER_SPEC.loader is None:
    raise RuntimeError("linked native evidence validator cannot be loaded")
react_native_finalizer = importlib.util.module_from_spec(FINALIZER_SPEC)
FINALIZER_SPEC.loader.exec_module(react_native_finalizer)

SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
SEMVER = re.compile(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$")
TAG = re.compile(r"^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$")
OCI = re.compile(r"^ghcr\.io/latchway/latchway@(sha256:[0-9a-f]{64})$")
PLATFORM_INPUTS = (
    ("ios", "ios_app_attest", "ios-app-attest"),
    ("android", "android_play_integrity", "android-play-integrity"),
    ("rn_ios", "react_native_ios_app_attest", "react-native-ios"),
    ("rn_android", "react_native_android_play_integrity", "react-native-android"),
)
REPOSITORY_FOR_PLATFORM = {
    "ios_app_attest": "ios",
    "android_play_integrity": "android",
    "react_native_ios_app_attest": "react_native",
    "react_native_android_play_integrity": "react_native",
}
PROVENANCE_FOR_PLATFORM = {
    "ios_app_attest": ("Latchway/latchway-ios-sdk", ".github/workflows/physical-app-attest.yml"),
    "android_play_integrity": ("Latchway/latchway-android", ".github/workflows/physical-play-integrity.yml"),
    "react_native_ios_app_attest": (
        "Latchway/latchway-react-native-sdk", ".github/workflows/physical-device-evidence.yml",
    ),
    "react_native_android_play_integrity": (
        "Latchway/latchway-react-native-sdk", ".github/workflows/physical-device-evidence.yml",
    ),
}


class Rejected(Exception):
    pass


def reject_duplicate_members(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate_json_member")
        value[key] = item
    return value


def reject_nonfinite_number(_: str) -> Any:
    raise ValueError("nonfinite_json_number")


def load_json(path: pathlib.Path) -> Any:
    try:
        metadata = path.lstat()
        if (
            path.is_symlink()
            or not path.is_file()
            or not 1 <= metadata.st_size <= 2 * 1024 * 1024
        ):
            raise Rejected("input_file_invalid")
        return json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=reject_duplicate_members,
            parse_constant=reject_nonfinite_number,
        )
    except Rejected:
        raise
    except (OSError, UnicodeError, ValueError) as error:
        raise Rejected("input_json_invalid") from error


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_regular_file(path: pathlib.Path, maximum_size: int = 16 * 1024 * 1024) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise Rejected("input_file_invalid") from error
    if path.is_symlink() or not path.is_file() or not 1 <= metadata.st_size <= maximum_size:
        raise Rejected("input_file_invalid")


def validate_coordinates(value: Any) -> dict[str, Any]:
    fields = {
        "schema_version", "core_commit", "core_release", "contract_version",
        "bundle_sha256", "oci_image_digest", "gateway_configuration_sha256",
        "repositories",
    }
    if not isinstance(value, dict) or set(value) != fields or value.get("schema_version") != 1:
        raise Rejected("coordinates_fields_invalid")
    if COMMIT.fullmatch(str(value.get("core_commit", ""))) is None:
        raise Rejected("coordinates_core_commit_invalid")
    if TAG.fullmatch(str(value.get("core_release", ""))) is None:
        raise Rejected("coordinates_core_release_invalid")
    if SEMVER.fullmatch(str(value.get("contract_version", ""))) is None:
        raise Rejected("coordinates_contract_invalid")
    if SHA256.fullmatch(str(value.get("bundle_sha256", ""))) is None:
        raise Rejected("coordinates_bundle_invalid")
    if OCI.fullmatch(str(value.get("oci_image_digest", ""))) is None:
        raise Rejected("coordinates_image_invalid")
    if SHA256.fullmatch(str(value.get("gateway_configuration_sha256", ""))) is None:
        raise Rejected("coordinates_gateway_configuration_invalid")
    repositories = value.get("repositories")
    if not isinstance(repositories, dict) or set(repositories) != {
        "core", "javascript", "ios", "android", "react_native",
    }:
        raise Rejected("coordinates_repositories_invalid")
    for name, coordinate in repositories.items():
        if not isinstance(coordinate, dict) or set(coordinate) != {"commit", "tag", "version"}:
            raise Rejected("coordinates_repository_fields_invalid")
        if COMMIT.fullmatch(str(coordinate.get("commit", ""))) is None:
            raise Rejected("coordinates_repository_commit_invalid")
        if TAG.fullmatch(str(coordinate.get("tag", ""))) is None:
            raise Rejected("coordinates_repository_tag_invalid")
        if SEMVER.fullmatch(str(coordinate.get("version", ""))) is None:
            raise Rejected("coordinates_repository_version_invalid")
        if coordinate["tag"] != f"v{coordinate['version']}":
            raise Rejected("coordinates_repository_tag_version_mismatch")
        if name == "core" and (
            coordinate["commit"] != value["core_commit"] or
            coordinate["tag"] != value["core_release"]
        ):
            raise Rejected("coordinates_core_repository_mismatch")
    return value


def validate_report(
    platform: str,
    profile_path: pathlib.Path,
    evidence_path: pathlib.Path,
    schema: dict[str, Any],
    coordinates: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    profile = load_json(profile_path)
    evidence = load_json(evidence_path)
    try:
        if platform == "ios_app_attest":
            react_native_finalizer.validate_linked_native_report(
                evidence,
                profile,
                platform,
                schema,
            )
        else:
            profile_errors = device_evidence.validate_profile(profile)
            evidence_errors = device_evidence.verify(evidence, profile, schema)
            if profile_errors or evidence_errors:
                raise ValueError("physical evidence validation failed")
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise Rejected(f"{platform}_evidence_invalid") from error
    if profile.get("platform") != platform or evidence.get("platform") != platform:
        raise Rejected(f"{platform}_identity_invalid")
    source = evidence["source"]
    repository_id = REPOSITORY_FOR_PLATFORM[platform]
    expected_commit = coordinates["repositories"][repository_id]["commit"]
    expected_version = coordinates["repositories"][repository_id]["version"]
    image_match = OCI.fullmatch(coordinates["oci_image_digest"])
    assert image_match is not None
    if (
        source.get("commit") != expected_commit or
        source.get("sdk_version") != expected_version or
        source.get("core_commit") != coordinates["core_commit"] or
        source.get("contract_version") != coordinates["contract_version"] or
        source.get("contract_bundle_sha256") != coordinates["bundle_sha256"] or
        source.get("gateway_image_digest") != image_match.group(1) or
        source.get("gateway_configuration_sha256") != coordinates["gateway_configuration_sha256"]
    ):
        raise Rejected(f"{platform}_release_coordinates_mismatch")
    return profile, evidence


def verify_provenance(
    platform: str,
    subject_path: pathlib.Path,
    bundle_path: pathlib.Path,
    source_commit: str,
) -> None:
    validate_regular_file(bundle_path)
    executable = shutil.which("gh")
    if executable is None:
        raise Rejected("github_attestation_verifier_unavailable")
    version_check = subprocess.run(
        [sys.executable, str(pathlib.Path(__file__).with_name("require-gh-version.py")), "--gh", executable],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=20,
    )
    if version_check.returncode != 0:
        raise Rejected("github_attestation_verifier_unsafe")
    repository, workflow = PROVENANCE_FOR_PLATFORM[platform]
    environment = dict(os.environ)
    environment["GH_PROMPT_DISABLED"] = "1"
    try:
        result = subprocess.run(
            [
                executable,
                "attestation", "verify", str(subject_path),
                "--bundle", str(bundle_path),
                "--repo", repository,
                "--signer-workflow", f"{repository}/{workflow}",
                "--source-digest", source_commit,
                "--format", "json",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
            env=environment,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise Rejected(f"{platform}_provenance_invalid") from error
    if result.returncode != 0 or len(result.stdout.encode("utf-8")) > 4 * 1024 * 1024:
        raise Rejected(f"{platform}_provenance_invalid")
    try:
        verified = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise Rejected(f"{platform}_provenance_invalid") from error
    if not isinstance(verified, list) or not verified:
        raise Rejected(f"{platform}_provenance_invalid")


def validate_checksum_manifest(
    manifest_path: pathlib.Path,
    required: dict[str, pathlib.Path],
) -> None:
    validate_regular_file(manifest_path, maximum_size=256 * 1024)
    try:
        lines = manifest_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise Rejected("artifact_manifest_invalid") from error
    if not 1 <= len(lines) <= 128:
        raise Rejected("artifact_manifest_invalid")
    entries: dict[str, str] = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})", line)
        if match is None or match.group(2) in entries:
            raise Rejected("artifact_manifest_invalid")
        entries[match.group(2)] = match.group(1)
    for name, path in required.items():
        if entries.get(name) != sha256_file(path):
            raise Rejected("artifact_manifest_subject_mismatch")


def write_exclusive(path: pathlib.Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        raise


def copy_exclusive(source: pathlib.Path, destination: pathlib.Path) -> None:
    write_exclusive(destination, source.read_bytes())


def snapshot_input(source: pathlib.Path, destination: pathlib.Path) -> None:
    """Copy one untrusted artifact from a single no-follow file descriptor."""
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(source, flags)
    except OSError as error:
        raise Rejected("input_file_invalid") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or not 1 <= metadata.st_size <= 16 * 1024 * 1024:
            raise Rejected("input_file_invalid")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            payload = handle.read(16 * 1024 * 1024 + 1)
        if len(payload) != metadata.st_size or len(payload) > 16 * 1024 * 1024:
            raise Rejected("input_file_changed")
    finally:
        os.close(descriptor)
    destination.parent.mkdir(mode=0o700, parents=True)
    write_exclusive(destination, payload)
    destination.chmod(0o400)


def snapshot_arguments(arguments: argparse.Namespace, root: pathlib.Path) -> argparse.Namespace:
    copied = argparse.Namespace(**vars(arguments))
    names = ["schema", "coordinates"]
    for argument_name, _, _ in PLATFORM_INPUTS:
        names.extend(
            f"{argument_name}_{suffix}"
            for suffix in ("profile", "evidence", "attestation", "manifest")
        )
    for name in names:
        source = getattr(arguments, name)
        destination = root / name / source.name
        snapshot_input(source, destination)
        setattr(copied, name, destination)
    return copied


def export(arguments: argparse.Namespace) -> dict[str, Any]:
    schema = load_json(arguments.schema)
    coordinates = validate_coordinates(load_json(arguments.coordinates))
    output_root = arguments.output_root.absolute()
    if output_root.exists() and output_root.is_symlink():
        raise Rejected("output_root_unsafe")
    document_path = output_root / "physical_devices.json"
    artifact_root = output_root / "artifacts" / "physical-devices"
    if document_path.exists() or artifact_root.exists():
        raise Rejected("output_already_exists")

    reports: dict[
        str,
        tuple[pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path, dict[str, Any], dict[str, Any]],
    ] = {}
    timestamps: list[dt.datetime] = []
    for argument_name, platform, artifact_stem in PLATFORM_INPUTS:
        profile_path = getattr(arguments, f"{argument_name}_profile")
        evidence_path = getattr(arguments, f"{argument_name}_evidence")
        attestation_path = getattr(arguments, f"{argument_name}_attestation")
        manifest_path = getattr(arguments, f"{argument_name}_manifest")
        source_commit = coordinates["repositories"][REPOSITORY_FOR_PLATFORM[platform]]["commit"]
        verify_provenance(platform, profile_path, attestation_path, source_commit)
        verify_provenance(platform, evidence_path, attestation_path, source_commit)
        verify_provenance(platform, manifest_path, attestation_path, source_commit)
        validate_checksum_manifest(
            manifest_path,
            {profile_path.name: profile_path, evidence_path.name: evidence_path},
        )
        profile, evidence = validate_report(
            platform, profile_path, evidence_path, schema, coordinates,
        )
        reports[platform] = (
            profile_path, evidence_path, attestation_path, manifest_path, profile, evidence,
        )
        timestamps.extend((
            device_evidence.parse_date_time(evidence["run"]["started_at"]),
            device_evidence.parse_date_time(evidence["run"]["completed_at"]),
        ))

    deployment_fields = (
        "gateway_origin",
        "gateway_deployment_key_id",
        "gateway_deployment_statement_sha256",
        "gateway_deployment_public_key_sha256",
    )
    deployments = {
        tuple(report[5]["source"].get(name) for name in deployment_fields)
        for report in reports.values()
    }
    if len(deployments) != 1:
        raise Rejected("gateway_deployment_coordinates_mismatch")

    ios_hash = sha256_file(arguments.ios_evidence)
    android_hash = sha256_file(arguments.android_evidence)
    rn_ios = reports["react_native_ios_app_attest"][5]
    rn_android = reports["react_native_android_play_integrity"][5]
    if rn_ios["application"].get("native_evidence_sha256") != ios_hash:
        raise Rejected("react_native_ios_native_link_mismatch")
    if rn_android["application"].get("native_evidence_sha256") != android_hash:
        raise Rejected("react_native_android_native_link_mismatch")

    started = min(timestamps).replace(microsecond=0)
    finished = max(timestamps).replace(microsecond=0)
    now = dt.datetime.now(dt.timezone.utc)
    if finished <= started or finished - started > dt.timedelta(days=7):
        raise Rejected("physical_evidence_window_invalid")
    if finished > now + dt.timedelta(minutes=5) or now - finished > dt.timedelta(days=7):
        raise Rejected("physical_evidence_not_fresh")

    artifact_entries: list[dict[str, str]] = []
    pending: list[tuple[pathlib.Path, pathlib.Path]] = []
    for argument_name, platform, artifact_stem in PLATFORM_INPUTS:
        profile_path, evidence_path, attestation_path, manifest_path, _, _ = reports[platform]
        pending.extend((
            (profile_path, artifact_root / f"{artifact_stem}-profile.json"),
            (evidence_path, artifact_root / f"{artifact_stem}-evidence.json"),
            (attestation_path, artifact_root / f"{artifact_stem}-attestation.sigstore.json"),
            (manifest_path, artifact_root / f"{artifact_stem}-SHA256SUMS"),
        ))
    for source, destination in pending:
        copy_exclusive(source, destination)
        relative = destination.relative_to(output_root).as_posix()
        artifact_entries.append({"path": relative, "sha256": sha256_file(destination)})

    document = {
        "schema_version": 1,
        "kind": "latchway_cross_repository_external_evidence",
        "domain": "physical_devices",
        "status": "passed",
        "started_at": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "finished_at": finished.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "core_commit": coordinates["core_commit"],
        "core_release": coordinates["core_release"],
        "contract_version": coordinates["contract_version"],
        "bundle_sha256": coordinates["bundle_sha256"],
        "oci_image_digest": coordinates["oci_image_digest"],
        "repositories": coordinates["repositories"],
        "claims": {
            "app_attest_production_verified": True,
            "play_integrity_play_distributed_verified": True,
            "react_native_ios_verified": True,
            "react_native_android_verified": True,
        },
        "artifacts": sorted(artifact_entries, key=lambda item: item["path"]),
    }
    encoded = (json.dumps(document, indent=2, sort_keys=True) + "\n").encode("utf-8")
    write_exclusive(document_path, encoded)
    return {
        "schema_version": "latchway.physical-device-export.v1",
        "valid": True,
        "document_sha256": sha256_file(document_path),
        "artifact_count": len(artifact_entries),
    }


def write_summary(path: pathlib.Path, value: dict[str, Any]) -> None:
    encoded = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
    if path.exists():
        raise Rejected("summary_already_exists")
    write_exclusive(path, encoded)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema", type=pathlib.Path, required=True)
    parser.add_argument("--coordinates", type=pathlib.Path, required=True)
    parser.add_argument("--output-root", type=pathlib.Path, required=True)
    parser.add_argument("--summary", type=pathlib.Path)
    for argument_name, _, _ in PLATFORM_INPUTS:
        parser.add_argument(f"--{argument_name.replace('_', '-')}-profile", type=pathlib.Path, required=True)
        parser.add_argument(f"--{argument_name.replace('_', '-')}-evidence", type=pathlib.Path, required=True)
        parser.add_argument(f"--{argument_name.replace('_', '-')}-attestation", type=pathlib.Path, required=True)
        parser.add_argument(f"--{argument_name.replace('_', '-')}-manifest", type=pathlib.Path, required=True)
    arguments = parser.parse_args()
    summary_path = arguments.summary or arguments.output_root / "physical_devices-validation.json"
    try:
        with tempfile.TemporaryDirectory(prefix="latchway-physical-export-") as directory:
            result = export(snapshot_arguments(arguments, pathlib.Path(directory)))
    except Rejected as error:
        failure = {
            "schema_version": "latchway.physical-device-export.v1",
            "valid": False,
            "error": str(error),
        }
        try:
            write_summary(summary_path, failure)
        except (OSError, Rejected):
            pass
        print(f"physical-device export rejected: {error}", file=sys.stderr)
        return 1
    except Exception:
        print("physical-device export rejected: internal_error", file=sys.stderr)
        return 1
    try:
        write_summary(summary_path, result)
    except (OSError, Rejected):
        print("physical-device export rejected: summary_write_failed", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
