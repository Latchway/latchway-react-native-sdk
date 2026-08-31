#!/usr/bin/env python3
"""Convert a native-sanitized RN run into the shared device observation."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import sys
from typing import Any


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("device_evidence", SCRIPT_DIR / "device-evidence.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("physical evidence validator cannot be loaded")
device_evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(device_evidence)
GATEWAY_SPEC = importlib.util.spec_from_file_location(
    "gateway_deployment", SCRIPT_DIR / "verify-gateway-deployment.py"
)
if GATEWAY_SPEC is None or GATEWAY_SPEC.loader is None:
    raise RuntimeError("gateway deployment verifier cannot be loaded")
gateway_deployment = importlib.util.module_from_spec(GATEWAY_SPEC)
GATEWAY_SPEC.loader.exec_module(gateway_deployment)
IOS_NATIVE_SPEC = importlib.util.spec_from_file_location(
    "linked_ios_device_evidence", SCRIPT_DIR / "linked-ios-device-evidence.py"
)
if IOS_NATIVE_SPEC is None or IOS_NATIVE_SPEC.loader is None:
    raise RuntimeError("linked iOS physical evidence validator cannot be loaded")
ios_native_evidence = importlib.util.module_from_spec(IOS_NATIVE_SPEC)
IOS_NATIVE_SPEC.loader.exec_module(ios_native_evidence)
IOS_NATIVE_SCHEMA_PATH = (
    SCRIPT_DIR.parent / "Conformance" / "linked-ios-physical-device-evidence.schema.json"
)

RAW_SCHEMA = "latchway.react-native-device-run.v2"
COLLECTION_SCHEMA = "latchway.react-native-collector.v1"
LINKED_NATIVE_TESTS = {
    "dpop_replay_rejected",
    "tampered_dpop_rejected",
    "session_refresh_rotation",
    "installation_revocation",
    "protocol_version_rejection",
}
LINKED_COORDINATE_PINS = {
    "core_commit",
    "contract_bundle_sha256",
    "gateway_image_digest",
    "gateway_configuration_sha256",
    "gateway_origin",
    "gateway_environment",
    "gateway_deployment_key_id",
    "gateway_deployment_statement_sha256",
    "gateway_deployment_public_key_sha256",
    "error_mapping_feature",
}
RAW_TESTS = {
    "react_native_ios_app_attest": {
        "react_native_bridge", "app_attest_session", "app_attest_assertion", "secure_enclave_key",
        "dpop_authorized_request", "streamed_request", "quota",
        "canonical_error_mapping",
    },
    "react_native_android_play_integrity": {
        "react_native_bridge", "play_integrity_session", "hardware_backed_key",
        "dpop_authorized_request", "streamed_request", "quota",
        "canonical_error_mapping",
    },
}
RAW_PIN_NAMES = {
    "react_native_ios_app_attest": {
        "source_commit", "core_commit", "contract_bundle_sha256", "gateway_image_digest",
        "gateway_configuration_sha256", "native_evidence_sha256", "distribution",
        "gateway_origin", "gateway_deployment_key_id", "gateway_deployment_statement_sha256",
        "gateway_deployment_public_key_sha256",
        "error_mapping_feature",
        "gateway_environment",
        "signing_certificate_sha256", "javascript_bundle_sha256", "team_id",
        "app_attest_environment",
    },
    "react_native_android_play_integrity": {
        "source_commit", "core_commit", "contract_bundle_sha256", "gateway_image_digest",
        "gateway_configuration_sha256", "native_evidence_sha256", "distribution",
        "gateway_origin", "gateway_deployment_key_id", "gateway_deployment_statement_sha256",
        "gateway_deployment_public_key_sha256",
        "error_mapping_feature",
        "gateway_environment",
        "signing_certificate_sha256", "play_track", "cloud_project_number", "require_licensed",
    },
}
SAFE_TEST = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
SAFE_REQUEST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def exact(value: Any, names: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != names:
        raise ValueError(f"{label}: fields do not match the protected contract")
    return value


def load_hashed_json(path: pathlib.Path) -> tuple[dict[str, Any], str]:
    """Open once, then parse and hash the exact same native-report bytes."""
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size <= 1_048_576:
            raise ValueError("linked native evidence is not a bounded regular file")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            encoded = handle.read(1_048_577)
        if len(encoded) != metadata.st_size or len(encoded) > 1_048_576:
            raise ValueError("linked native evidence changed or exceeded its size bound")
        value = json.loads(
            encoded.decode("utf-8"),
            object_pairs_hook=device_evidence.reject_duplicate_members,
            parse_constant=device_evidence.reject_nonfinite_number,
        )
        if not isinstance(value, dict):
            raise ValueError("linked native evidence is not an object")
        return value, hashlib.sha256(encoded).hexdigest()
    finally:
        os.close(descriptor)


def validated_tests(value: Any, platform: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= 32:
        raise ValueError("tests: invalid list")
    output: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict) or not {"id", "status", "duration_ms"}.issubset(item):
            raise ValueError("tests: invalid entry")
        if set(item) - {
            "id", "status", "duration_ms", "http_status", "error_code", "request_id",
            "mapped_error_type",
        }:
            raise ValueError("tests: unexpected field")
        identifier = item.get("id")
        if not isinstance(identifier, str) or SAFE_TEST.fullmatch(identifier) is None:
            raise ValueError("tests: invalid identifier")
        if item.get("status") not in {"passed", "failed"}:
            raise ValueError("tests: invalid status")
        if not isinstance(item.get("duration_ms"), int) or not 0 <= item["duration_ms"] <= 7_200_000:
            raise ValueError("tests: invalid duration")
        if "http_status" in item and (not isinstance(item["http_status"], int) or not 100 <= item["http_status"] <= 599):
            raise ValueError("tests: invalid HTTP status")
        if "error_code" in item and (not isinstance(item["error_code"], str) or SAFE_TEST.fullmatch(item["error_code"]) is None):
            raise ValueError("tests: invalid error code")
        if "request_id" in item and (not isinstance(item["request_id"], str) or SAFE_REQUEST.fullmatch(item["request_id"]) is None):
            raise ValueError("tests: invalid request ID")
        if "mapped_error_type" in item and item["mapped_error_type"] != "react_native_latchway_error":
            raise ValueError("tests: invalid typed error mapping")
        output.append(dict(item))
    identifiers = [item["id"] for item in output]
    if len(identifiers) != len(set(identifiers)) or set(identifiers) != RAW_TESTS[platform]:
        raise ValueError("tests: identifiers do not match platform run contract")
    by_id = {item["id"]: item for item in output}
    mapping = by_id["canonical_error_mapping"]
    if (
        mapping.get("http_status") != 403
        or mapping.get("error_code") != "component_feature_not_granted"
        or "request_id" not in mapping
    ):
        raise ValueError(
            "tests: canonical_error_mapping must record HTTP 403 "
            "component_feature_not_granted with a request ID"
        )
    if by_id["canonical_error_mapping"].get("mapped_error_type") != "react_native_latchway_error":
        raise ValueError("tests: canonical mapping was not the React Native error type")
    return output


def validated_native_proofs(native_evidence: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract only the security proofs that the opaque JS bridge cannot emit.

    The complete native report is schema/profile validated before this function
    runs. Exact per-test field sets are still enforced here so an unrelated or
    newly extended native test cannot smuggle claims into the React Native
    report.
    """
    value = native_evidence.get("tests")
    if not isinstance(value, list):
        raise ValueError("linked native evidence has no tests")
    by_id: dict[str, dict[str, Any]] = {}
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise ValueError("linked native evidence contains an invalid test")
        identifier = item["id"]
        if identifier in by_id:
            raise ValueError("linked native evidence contains duplicate tests")
        by_id[identifier] = item

    exact_fields = {
        "dpop_replay_rejected": {
            "id", "status", "duration_ms", "http_status", "error_code", "request_id",
        },
        "tampered_dpop_rejected": {
            "id", "status", "duration_ms", "http_status", "error_code", "request_id",
        },
        "session_refresh_rotation": {
            "id", "status", "duration_ms", "credential_before_sha256",
            "credential_after_sha256", "installation_before_sha256",
            "installation_after_sha256",
        },
        "installation_revocation": {
            "id", "status", "duration_ms", "http_status", "error_code", "request_id",
        },
        "protocol_version_rejection": {
            "id", "status", "duration_ms", "http_status", "error_code", "request_id",
            "protocol_version_sent",
        },
    }
    expected_responses = {
        "dpop_replay_rejected": (401, "dpop_replayed"),
        "tampered_dpop_rejected": (401, "dpop_invalid"),
        "installation_revocation": (403, "installation_revoked"),
        "protocol_version_rejection": (426, "protocol_version_unsupported"),
    }
    output: list[dict[str, Any]] = []
    for identifier in sorted(LINKED_NATIVE_TESTS):
        item = by_id.get(identifier)
        if item is None or set(item) != exact_fields[identifier] or item.get("status") != "passed":
            raise ValueError(f"linked native proof {identifier} is absent or malformed")
        if not isinstance(item.get("duration_ms"), int) or not 0 <= item["duration_ms"] <= 3_600_000:
            raise ValueError(f"linked native proof {identifier} has an invalid duration")
        if identifier in expected_responses:
            status, code = expected_responses[identifier]
            if (
                item.get("http_status") != status
                or item.get("error_code") != code
                or not isinstance(item.get("request_id"), str)
                or SAFE_REQUEST.fullmatch(item["request_id"]) is None
            ):
                raise ValueError(f"linked native proof {identifier} lacks its canonical response")
        output.append(dict(item))

    protocol = by_id["protocol_version_rejection"]
    if protocol.get("protocol_version_sent") != 0:
        raise ValueError("linked native protocol proof did not send version zero")
    rotation = by_id["session_refresh_rotation"]
    rotation_hashes = [
        rotation.get("credential_before_sha256"), rotation.get("credential_after_sha256"),
        rotation.get("installation_before_sha256"), rotation.get("installation_after_sha256"),
    ]
    if any(not isinstance(value, str) or SHA256.fullmatch(value) is None for value in rotation_hashes):
        raise ValueError("linked native refresh proof lacks redacted hashes")
    if rotation_hashes[0] == rotation_hashes[1] or rotation_hashes[2] != rotation_hashes[3]:
        raise ValueError("linked native refresh proof did not rotate one installation")
    return output


def validate_linked_native_report(
    native_evidence: dict[str, Any],
    native_profile: dict[str, Any],
    native_platform: str,
    output_schema: dict[str, Any],
) -> None:
    """Validate the linked report with its platform's authoritative contract.

    Android currently publishes the shared v1 report. The pinned iOS SDK
    publishes the component-aware v2 report, so validating both with the React
    Native output schema would either reject genuine iOS evidence or silently
    weaken one platform. The v2 schema and validator are an exact, reviewed
    snapshot of the linked iOS release contract.
    """
    if native_platform == "android_play_integrity":
        errors = device_evidence.validate_profile(native_profile)
        errors.extend(device_evidence.verify(native_evidence, native_profile, output_schema))
    else:
        linked_schema = ios_native_evidence.load_json(IOS_NATIVE_SCHEMA_PATH)
        errors = ios_native_evidence.validate_profile(native_profile)
        errors.extend(ios_native_evidence.schema_errors(native_evidence, linked_schema))
        errors.extend(ios_native_evidence.semantic_errors(native_evidence, native_profile))
        if native_evidence.get("release_eligible") is not True:
            errors.append("release_eligible is not true")
        if native_evidence.get("artifacts", {}).get(
            "schema_sha256"
        ) != ios_native_evidence.canonical_sha256(linked_schema):
            errors.append("schema hash does not match checked-in linked iOS schema")
    if errors:
        raise ValueError("linked native evidence is invalid")


def build(
    raw: dict[str, Any],
    collection: dict[str, Any],
    profile: dict[str, Any],
    native_evidence: dict[str, Any],
    native_profile: dict[str, Any],
    client_policy: dict[str, Any],
    schema: dict[str, Any],
    native_evidence_sha256: str,
) -> dict[str, Any]:
    platform = profile.get("platform")
    if platform not in RAW_TESTS:
        raise ValueError("profile platform is not React Native physical conformance")
    try:
        gateway_deployment.validate_client(client_policy)
    except gateway_deployment.Rejected as error:
        raise ValueError("signed gateway client policy is invalid") from error
    if client_policy.get("platform") != platform:
        raise ValueError("signed gateway client policy platform differs from the run")
    profile_errors = device_evidence.validate_profile(profile)
    if profile_errors:
        raise ValueError("protected profile is invalid")
    native_platform = (
        "android_play_integrity"
        if platform.endswith("android_play_integrity")
        else "ios_app_attest"
    )
    native_repository = (
        "Latchway/latchway-android"
        if native_platform == "android_play_integrity"
        else "Latchway/latchway-ios-sdk"
    )
    if (
        native_profile.get("platform") != native_platform
        or native_profile.get("repository") != native_repository
        or native_evidence.get("platform") != native_platform
    ):
        raise ValueError("linked native evidence is invalid")
    validate_linked_native_report(native_evidence, native_profile, native_platform, schema)
    exact(raw, {
        "schema_version", "platform", "run", "gateway_version", "native", "pins",
        "application", "device", "tests", "redaction",
    }, "raw run")
    if raw.get("schema_version") != RAW_SCHEMA or raw.get("platform") != platform:
        raise ValueError("raw run identity is invalid")
    exact(collection, {"schema_version", "platform", "application", "device"}, "collection")
    if collection.get("schema_version") != COLLECTION_SCHEMA or collection.get("platform") != platform:
        raise ValueError("collector identity is invalid")
    run = exact(raw.get("run"), {"id", "mode", "started_at", "completed_at"}, "run")
    if run.get("mode") != "release" or SAFE_REQUEST.fullmatch(str(run.get("id", ""))) is None:
        raise ValueError("run mode or identifier is invalid")
    started = device_evidence.parse_date_time(run.get("started_at"))
    completed = device_evidence.parse_date_time(run.get("completed_at"))
    if completed < started or completed - started > dt.timedelta(hours=2):
        raise ValueError("run time window is invalid")

    pins = exact(raw.get("pins"), RAW_PIN_NAMES[platform], "raw pins")
    if any(not isinstance(value, str) for value in pins.values()):
        raise ValueError("raw pin value is invalid")
    expected = profile["expected_pins"]
    raw_native = raw.get("native")
    if not isinstance(raw_native, dict):
        raise ValueError("native diagnostics are invalid")
    if (
        SHA256.fullmatch(native_evidence_sha256) is None
        or expected.get("native_evidence_sha256") != native_evidence_sha256
        or raw_native.get("native_evidence_sha256") != native_evidence_sha256
    ):
        raise ValueError("linked native evidence hash is not bound to the candidate")
    native_expected = native_profile.get("expected_pins", {})
    if any(native_expected.get(name) != expected.get(name) for name in LINKED_COORDINATE_PINS):
        raise ValueError("linked native release coordinates differ from the React Native candidate")
    native_source = native_profile.get("source", {})
    react_native_source = profile.get("source", {})
    if (
        native_source.get("sdk_version") != expected.get("native_sdk_version")
        or native_source.get("contract_version") != react_native_source.get("contract_version")
        or native_evidence.get("source", {}).get("gateway_version") != raw.get("gateway_version")
    ):
        raise ValueError("linked native SDK or contract version differs from the React Native candidate")
    for name, observed in pins.items():
        if name != "distribution" and expected.get(name) != observed:
            raise ValueError("raw pin does not match protected profile")

    raw_application = exact(
        raw.get("application"),
        {"identifier", "version", "build", "debuggable", "installer_package"}
        if platform.endswith("android_play_integrity")
        else {"identifier", "version", "build", "debuggable"},
        "native application",
    )
    application = collection.get("application")
    if not isinstance(application, dict):
        raise ValueError("collector application is invalid")
    for name in raw_application:
        if application.get(name) != raw_application[name]:
            raise ValueError("native and collector application identity differ")
    if application.get("distribution") != pins.get("distribution"):
        raise ValueError("signed distribution differs from embedded run pin")
    device = collection.get("device")
    raw_device = raw.get("device")
    if not isinstance(device, dict) or not isinstance(raw_device, dict):
        raise ValueError("device record is invalid")
    for name in ("physical", "simulator", "emulator", "testing", "debugger_attached", "os_name", "os_version", "os_build"):
        if device.get(name) != raw_device.get(name):
            raise ValueError("native and collector device facts differ")

    native = exact(raw_native, {
        "provider", "trust_level", "key_storage", "native_sdk_version", "native_evidence_sha256",
        "session_state", "new_architecture",
    }, "native diagnostics")
    if native.get("new_architecture") is not True:
        raise ValueError("New Architecture was not observed")
    if expected.get("native_sdk_version") != native.get("native_sdk_version") or expected.get("native_evidence_sha256") != native.get("native_evidence_sha256"):
        raise ValueError("native SDK or linked evidence differs from protected profile")

    runtime_tests = validated_tests(raw.get("tests"), platform)
    linked_native_tests = validated_native_proofs(native_evidence)
    by_name = {item["id"]: item for item in runtime_tests}
    expected_provider = "play_integrity" if platform.endswith("android_play_integrity") else "app_attest"
    linked_provider = native_evidence.get("provider")
    if not isinstance(linked_provider, dict):
        raise ValueError("linked native provider is invalid")
    linked_trust_level = linked_provider.get("trust_level")
    android = platform.endswith("android_play_integrity")
    trusted_levels = (
        {"device_verified", "strong_device_verified"}
        if android else {"app_verified"}
    )
    linked_trusted = (
        linked_provider.get("name") == expected_provider
        and linked_provider.get("environment") == "production"
        and linked_trust_level in trusted_levels
        and linked_provider.get("request_hash_bound") is True
    )
    if native_evidence.get("source", {}).get("sdk_version") != native.get("native_sdk_version"):
        raise ValueError("linked native SDK version differs from the runtime")
    key_ok = native.get("key_storage") in (
        {"strongbox", "trusted_execution_environment", "unknown_secure_hardware"}
        if android else {"secure_enclave"}
    )
    session_test = "play_integrity_session" if android else "app_attest_session"
    key_test = "hardware_backed_key" if android else "secure_enclave_key"
    trust_rank = {"device_verified": 1, "strong_device_verified": 2}
    current_policy_trust = (
        trust_rank.get(native.get("trust_level"), 0)
        >= trust_rank.get(client_policy.get("minimum_trust_level"), 3)
        if android else
        native.get("trust_level") == client_policy.get("minimum_trust_level") == "app_verified"
    )
    trusted = (
        native.get("provider") == expected_provider and native.get("trust_level") in trusted_levels and
        native.get("session_state") == "active" and key_ok and linked_trusted and current_policy_trust and
        by_name["react_native_bridge"]["status"] == "passed" and
        by_name[session_test]["status"] == "passed" and by_name[key_test]["status"] == "passed" and
        (android or by_name["app_attest_assertion"]["status"] == "passed")
    )

    observed = {
        **{name: value for name, value in pins.items() if name != "distribution"},
        "application_identifier": application.get("identifier", ""),
        "app_version": application.get("version", ""),
        "build_number": application.get("build", ""),
        "native_sdk_version": native.get("native_sdk_version", ""),
        "native_evidence_sha256": native.get("native_evidence_sha256", ""),
    }
    if platform.endswith("android_play_integrity"):
        observed["installer_package"] = application.get("installer_package", "")
    pins_match = set(observed) == set(expected) and all(observed.get(name) == value for name, value in expected.items())
    physical = (
        device.get("physical") is True and all(device.get(name) is False for name in (
            "simulator", "emulator", "testing", "debugger_attached",
        )) and application.get("build_mode") == "release" and application.get("debuggable") is False
    )
    computed = [
        {"id": "physical_device", "status": "passed" if physical else "failed", "duration_ms": 0},
        {"id": "identifier_pins", "status": "passed" if pins_match else "failed", "duration_ms": 0},
        {
            "id": "native_evidence_linked",
            "status": "passed" if native.get("native_evidence_sha256") == expected.get("native_evidence_sha256") else "failed",
            "duration_ms": 0,
        },
    ]
    full_application = {
        **application,
        "new_architecture": True,
        "native_sdk_version": native["native_sdk_version"],
        "native_evidence_sha256": native["native_evidence_sha256"],
    }
    for observed_value, expected_value in (
        (full_application.get("identifier"), client_policy.get("application_identifier")),
        (full_application.get("version"), client_policy.get("app_version")),
        (full_application.get("build"), client_policy.get("build_number")),
        (full_application.get("signing_certificate_sha256"), client_policy.get("signing_certificate_sha256")),
    ):
        if observed_value != expected_value:
            raise ValueError("application identity differs from signed gateway client policy")
    platform_identity = (
        (
            (full_application.get("cloud_project_number"), client_policy.get("cloud_project_number")),
            (full_application.get("installer_package"), client_policy.get("installer_package")),
            (full_application.get("play_track"), client_policy.get("play_track")),
        )
        if platform.endswith("android_play_integrity")
        else (
            (full_application.get("team_id"), client_policy.get("team_id")),
            (full_application.get("app_attest_environment"), client_policy.get("app_attest_environment")),
        )
    )
    if any(observed_value != expected_value for observed_value, expected_value in platform_identity):
        raise ValueError("platform identity differs from signed gateway client policy")
    security = {
        "trusted_execution_environment": "tee",
    }.get(str(native.get("key_storage")), str(native.get("key_storage")))
    full_device = {**device, "security_level": security if trusted else "unknown"}
    provider = {
        "name": expected_provider,
        "environment": "production" if trusted else "unverified",
        "trust_level": native.get("trust_level") if trusted else "none",
        "request_hash_bound": trusted,
        "app_recognition": "PLAY_RECOGNIZED" if trusted and client_policy.get("require_play_recognized") else "UNEVALUATED",
        "account_licensing": "LICENSED" if trusted and client_policy.get("require_licensed") else "UNEVALUATED",
    }
    if not platform.endswith("android_play_integrity"):
        provider["app_recognition"] = "not_applicable"
        provider["account_licensing"] = "not_applicable"
    redaction = raw.get("redaction")
    if not isinstance(redaction, dict) or set(redaction) != {
        "identity_token_recorded", "session_token_recorded", "refresh_token_recorded",
        "dpop_proof_recorded", "attestation_evidence_recorded", "private_key_recorded",
        "provider_credential_recorded",
    } or any(value is not False for value in redaction.values()):
        raise ValueError("redaction declaration is invalid")
    if device_evidence.secret_scan(raw):
        raise ValueError("raw run resembles secret material")
    gateway_version = raw.get("gateway_version")
    if not isinstance(gateway_version, str) or not 1 <= len(gateway_version) <= 128:
        raise ValueError("gateway version is invalid")
    return {
        "schema_version": device_evidence.OBSERVATION_VERSION,
        "platform": platform,
        "run": run,
        "gateway_version": gateway_version,
        "application": full_application,
        "device": full_device,
        "provider": provider,
        "observed_pins": observed,
        "tests": sorted(runtime_tests + linked_native_tests + computed, key=lambda item: item["id"]),
        "redaction": redaction,
    }


def write_atomic(path: pathlib.Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", type=pathlib.Path, required=True)
    parser.add_argument("--collection", type=pathlib.Path, required=True)
    parser.add_argument("--profile", type=pathlib.Path, required=True)
    parser.add_argument("--native-evidence", type=pathlib.Path, required=True)
    parser.add_argument("--native-profile", type=pathlib.Path, required=True)
    parser.add_argument("--client-policy", type=pathlib.Path, required=True)
    parser.add_argument("--schema", type=pathlib.Path, required=True)
    parser.add_argument("--observation", type=pathlib.Path, required=True)
    arguments = parser.parse_args()
    try:
        raw = device_evidence.load_json(arguments.raw)
        collection = device_evidence.load_json(arguments.collection)
        profile = device_evidence.load_json(arguments.profile)
        native_evidence, native_evidence_sha256 = load_hashed_json(arguments.native_evidence)
        native_profile = device_evidence.load_json(arguments.native_profile)
        client_policy = device_evidence.load_json(arguments.client_policy)
        schema = device_evidence.load_json(arguments.schema)
        if native_evidence_sha256 != raw.get("native", {}).get("native_evidence_sha256"):
            raise ValueError("linked native evidence hash differs from the runtime")
        write_atomic(
            arguments.observation,
            build(
                raw,
                collection,
                profile,
                native_evidence,
                native_profile,
                client_policy,
                schema,
                native_evidence_sha256,
            ),
        )
    except (OSError, ValueError, KeyError, TypeError):
        print("React Native physical-device run rejected", file=sys.stderr)
        return 1
    print(f"React Native physical-device observation written: {arguments.observation}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
