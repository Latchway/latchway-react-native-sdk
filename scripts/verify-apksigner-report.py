#!/usr/bin/env python3
"""Verify that an apksigner report names exactly one pinned signer."""

from __future__ import annotations

import argparse
import re
import sys


MAX_REPORT_BYTES = 1024 * 1024
SHA256 = re.compile(r"[0-9a-f]{64}")
CERTIFICATE_LINE = re.compile(
    r"Signer #([1-9][0-9]*) certificate SHA-256 digest: ([0-9A-Fa-f]{64})"
)


def verify_report(report: str, expected_sha256: str) -> None:
    if SHA256.fullmatch(expected_sha256) is None:
        raise ValueError("expected certificate SHA-256 must be 64 lowercase hex characters")

    lines = [line.strip() for line in report.splitlines()]
    signer_counts = [line for line in lines if line.startswith("Number of signers:")]
    if signer_counts != ["Number of signers: 1"]:
        raise ValueError("apksigner report must declare exactly one signer")

    certificate_lines = [
        line
        for line in lines
        if line.startswith("Signer #") and " certificate SHA-256 digest:" in line
    ]
    if len(certificate_lines) != 1:
        raise ValueError("apksigner report must contain exactly one SHA-256 certificate digest")
    match = CERTIFICATE_LINE.fullmatch(certificate_lines[0])
    if match is None or match.group(1) != "1":
        raise ValueError("apksigner report certificate must belong to signer #1")
    if match.group(2).lower() != expected_sha256:
        raise ValueError("apksigner report certificate does not match the protected pin")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("expected_sha256")
    arguments = parser.parse_args()
    payload = sys.stdin.buffer.read(MAX_REPORT_BYTES + 1)
    if len(payload) > MAX_REPORT_BYTES:
        parser.error("apksigner report exceeds the reviewed size bound")
    try:
        report = payload.decode("utf-8")
        verify_report(report, arguments.expected_sha256)
    except (UnicodeDecodeError, ValueError) as failure:
        parser.error(str(failure))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
