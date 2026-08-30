#!/usr/bin/env python3
"""Fail-closed preflight for a hash-pinned linked native device report."""

from __future__ import annotations

import argparse
import importlib.util
import pathlib
import re
import sys


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "react_native_device_finalizer",
    SCRIPT_DIR / "finalize-react-native-device-run.py",
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("React Native physical evidence finalizer cannot be loaded")
finalizer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(finalizer)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--platform",
        required=True,
        choices=("ios_app_attest", "android_play_integrity"),
    )
    parser.add_argument("--profile", type=pathlib.Path, required=True)
    parser.add_argument("--evidence", type=pathlib.Path, required=True)
    parser.add_argument("--output-schema", type=pathlib.Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--expected-source-commit", required=True)
    parser.add_argument("--expected-core-commit", required=True)
    parser.add_argument("--expected-native-sdk-version", required=True)
    parser.add_argument("--expected-contract-version", required=True)
    parser.add_argument("--expected-contract-bundle-sha256", required=True)
    parser.add_argument("--expected-gateway-image-digest", required=True)
    parser.add_argument("--expected-gateway-configuration-sha256", required=True)
    parser.add_argument("--expected-gateway-origin", required=True)
    parser.add_argument("--expected-gateway-deployment-key-id", required=True)
    parser.add_argument("--expected-gateway-deployment-statement-sha256", required=True)
    parser.add_argument("--expected-gateway-deployment-public-key-sha256", required=True)
    arguments = parser.parse_args()

    try:
        if re.fullmatch(r"[0-9a-f]{64}", arguments.expected_sha256) is None:
            raise ValueError("invalid protected native evidence hash")
        profile = finalizer.device_evidence.load_json(arguments.profile)
        output_schema = finalizer.device_evidence.load_json(arguments.output_schema)
        evidence, evidence_sha256 = finalizer.load_hashed_json(arguments.evidence)
        if evidence_sha256 != arguments.expected_sha256:
            raise ValueError("linked native evidence hash differs from the protected candidate")
        finalizer.validate_linked_native_report(
            evidence,
            profile,
            arguments.platform,
            output_schema,
        )
        expected_repository = (
            "Latchway/latchway-ios-sdk"
            if arguments.platform == "ios_app_attest"
            else "Latchway/latchway-android"
        )
        source = evidence.get("source", {})
        expected_source = {
            "repository": expected_repository,
            "commit": arguments.expected_source_commit,
            "core_commit": arguments.expected_core_commit,
            "sdk_version": arguments.expected_native_sdk_version,
            "contract_version": arguments.expected_contract_version,
            "contract_bundle_sha256": arguments.expected_contract_bundle_sha256,
            "gateway_image_digest": arguments.expected_gateway_image_digest,
            "gateway_configuration_sha256": arguments.expected_gateway_configuration_sha256,
            "gateway_origin": arguments.expected_gateway_origin,
            "gateway_deployment_key_id": arguments.expected_gateway_deployment_key_id,
            "gateway_deployment_statement_sha256": (
                arguments.expected_gateway_deployment_statement_sha256
            ),
            "gateway_deployment_public_key_sha256": (
                arguments.expected_gateway_deployment_public_key_sha256
            ),
        }
        if any(source.get(name) != value for name, value in expected_source.items()):
            raise ValueError("linked native release coordinates differ from protected inputs")
    except (OSError, ValueError, KeyError, TypeError):
        print("linked native physical-device evidence rejected", file=sys.stderr)
        return 1
    print(f"linked native physical-device evidence accepted: {evidence_sha256}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
