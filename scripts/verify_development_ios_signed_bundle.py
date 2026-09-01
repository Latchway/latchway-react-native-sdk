#!/usr/bin/env python3
"""Fail-closed verification for the Debug iOS delegated-component example."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import pathlib
import plistlib
import re
import subprocess
import sys
import tempfile
from typing import Any


class VerificationError(RuntimeError):
    pass


IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
TEN_CHARACTER_IDENTIFIER = re.compile(r"[A-Z0-9]{10}\Z")
DEVICE = re.compile(r"(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})\Z")
APPLE_DEVELOPMENT_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1"
PROFILE_CERTIFICATE_LISTING = [
    "subject=CN=Apple iPhone OS Provisioning Profile Signing, O=Apple Inc., C=US",
    "issuer=CN=Apple iPhone Certification Authority, OU=Certification Authority, O=Apple Inc., C=US",
    "",
    "subject=CN=Apple iPhone Certification Authority, OU=Certification Authority, O=Apple Inc., C=US",
    "issuer=C=US, O=Apple Inc., OU=Apple Certification Authority, CN=Apple Root CA",
    "",
    "subject=C=US, O=Apple Inc., OU=Apple Certification Authority, CN=Apple Root CA",
    "issuer=C=US, O=Apple Inc., OU=Apple Certification Authority, CN=Apple Root CA",
]
MACH_O_MAGICS = {
    b"\xce\xfa\xed\xfe",
    b"\xcf\xfa\xed\xfe",
    b"\xfe\xed\xfa\xce",
    b"\xfe\xed\xfa\xcf",
    b"\xca\xfe\xba\xbe",
    b"\xbe\xba\xfe\xca",
    b"\xca\xfe\xba\xbf",
    b"\xbf\xba\xfe\xca",
}


def command(arguments: list[str], *, timeout: int = 30) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            arguments,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as failure:
        raise VerificationError("a required local signing command was unavailable") from failure


def require_codesign_verification(returncode: int, stdout: bytes, stderr: bytes) -> str:
    """Require a complete, clean verification; trust-only failures remain failures."""
    if returncode != 0 or stdout or stderr:
        raise VerificationError("codesign verification failed")
    return "verified"


def parse_abstract_entitlements(payload: bytes) -> dict[str, Any]:
    """Parse the bounded representation emitted by `codesign -d --entitlements -`."""
    if not payload or len(payload) > 65536 or b"\x00" in payload:
        raise VerificationError("signed entitlement output was empty or oversized")
    try:
        lines = payload.decode("utf-8", errors="strict").replace("\r\n", "\n").splitlines()
    except UnicodeDecodeError as failure:
        raise VerificationError("signed entitlement output was not UTF-8") from failure
    if not lines or lines[0] != "[Dict]":
        raise VerificationError("signed entitlement output was not a dictionary")
    result: dict[str, Any] = {}
    index = 1
    while index < len(lines):
        key_line = lines[index]
        if not key_line.startswith("\t[Key] ") or len(key_line) > 512:
            raise VerificationError("signed entitlement output contained an invalid key")
        key = key_line[len("\t[Key] ") :]
        if not key or key in result or any(ord(character) < 32 for character in key):
            raise VerificationError("signed entitlement output contained a duplicate or unsafe key")
        if index + 2 >= len(lines) or lines[index + 1] != "\t[Value]":
            raise VerificationError("signed entitlement output omitted a value")
        value_line = lines[index + 2]
        if value_line.startswith("\t\t[String] "):
            value: Any = value_line[len("\t\t[String] ") :]
            if not value or len(value) > 4096 or any(ord(character) < 32 for character in value):
                raise VerificationError("signed entitlement output contained an unsafe string")
            index += 3
        elif value_line in ("\t\t[Bool] true", "\t\t[Bool] false"):
            value = value_line.endswith("true")
            index += 3
        elif value_line == "\t\t[Array]":
            value = []
            index += 3
            while index < len(lines) and lines[index].startswith("\t\t\t"):
                item = lines[index]
                if not item.startswith("\t\t\t[String] "):
                    raise VerificationError("signed entitlement array contained an unsupported value")
                string = item[len("\t\t\t[String] ") :]
                if not string or len(string) > 4096 or any(ord(character) < 32 for character in string):
                    raise VerificationError("signed entitlement array contained an unsafe string")
                value.append(string)
                index += 1
        else:
            raise VerificationError("signed entitlement output contained an unsupported value")
        result[key] = value
    return result


def profile_authorizes(exact: str, grants: Any) -> bool:
    if not isinstance(grants, list) or not grants or not all(isinstance(item, str) and item for item in grants):
        raise VerificationError("provisioning profile contained an invalid entitlement grant")
    for grant in grants:
        if "*" in grant and (grant.count("*") != 1 or not grant.endswith("*") or len(grant) < 2):
            raise VerificationError("provisioning profile contained a malformed wildcard")
    return any(grant == exact or (grant.endswith("*") and exact.startswith(grant[:-1])) for grant in grants)


def profile_authorizes_value(value: Any, expected: str) -> bool:
    if isinstance(value, str):
        return value == expected
    return isinstance(value, list) and bool(value) and all(isinstance(item, str) for item in value) and expected in value


def safe_bundle(path: pathlib.Path, suffix: str) -> None:
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as failure:
        raise VerificationError("signed bundle path was unsafe") from failure
    if (
        not path.is_absolute()
        or path != resolved
        or path.suffix != suffix
        or not path.is_dir()
        or path.is_symlink()
    ):
        raise VerificationError("signed bundle path was unsafe")


def plist(path: pathlib.Path) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 1_048_576:
        raise VerificationError("signed bundle plist was unsafe")
    try:
        value = plistlib.loads(path.read_bytes())
    except Exception as failure:
        raise VerificationError("signed bundle plist was invalid") from failure
    if not isinstance(value, dict):
        raise VerificationError("signed bundle plist was not a dictionary")
    return value


def exact_display_stderr(stderr: bytes, executable: pathlib.Path) -> None:
    try:
        lines = stderr.decode("utf-8", errors="strict").replace("\r\n", "\n").splitlines()
    except UnicodeDecodeError as failure:
        raise VerificationError("codesign display output was invalid") from failure
    if lines != [f"Executable={executable}"]:
        raise VerificationError("codesign display produced an unexpected diagnostic")


def signed_entitlements(bundle: pathlib.Path, executable: pathlib.Path) -> dict[str, Any]:
    result = command(["codesign", "-d", "--entitlements", "-", str(bundle)])
    if result.returncode != 0:
        raise VerificationError("codesign could not display signed entitlements")
    exact_display_stderr(result.stderr, executable)
    return parse_abstract_entitlements(result.stdout)


def positive_signature_metadata(
    code: pathlib.Path,
    identifier: str,
    team_id: str,
    *,
    sealed_resources: bool,
) -> None:
    result = command(["codesign", "-d", "--verbose=5", str(code)])
    if result.returncode != 0 or result.stdout or len(result.stderr) > 32768:
        raise VerificationError("codesign could not display signature metadata")
    try:
        text = result.stderr.decode("utf-8", errors="strict")
    except UnicodeDecodeError as failure:
        raise VerificationError("signature metadata was not UTF-8") from failure
    required = (
        f"Identifier={identifier}\n",
        "CodeDirectory ",
        " location=embedded\n",
        "Hash type=sha256 size=32\n",
        "Hash choices=sha256\n",
        "CMSDigestType=2\n",
        f"TeamIdentifier={team_id}\n",
        "Internal requirements count=1 ",
    )
    if any(marker not in text for marker in required):
        raise VerificationError("signature metadata omitted a required integrity marker")
    digests = re.findall(r"^CMSDigest=([0-9a-f]{64})$", text, re.MULTILINE)
    signatures = re.findall(r"^Signature size=([0-9]+)$", text, re.MULTILINE)
    if len(digests) != 1 or len(signatures) != 1 or int(signatures[0]) < 1024:
        raise VerificationError("signature metadata contained an invalid CMS signature")
    resource_marker = "Sealed Resources version=2 " if sealed_resources else "Sealed Resources=none\n"
    if resource_marker not in text:
        raise VerificationError("signature metadata had an unexpected sealed-resource mode")


def extract_certificate_chain(bundle: pathlib.Path, temporary: pathlib.Path) -> list[pathlib.Path]:
    prefix = temporary / "certificate-"
    result = command(["codesign", "-d", f"--extract-certificates={prefix}", str(bundle)])
    if result.returncode != 0 or result.stdout:
        raise VerificationError("codesign could not extract the signing certificate chain")
    files: list[pathlib.Path] = []
    for index in range(5):
        candidate = pathlib.Path(f"{prefix}{index}")
        if candidate.exists():
            if candidate.is_symlink() or not candidate.is_file() or not 256 <= candidate.stat().st_size <= 65536:
                raise VerificationError("signing certificate chain contained an unsafe item")
            files.append(candidate)
        elif files:
            break
    if not 2 <= len(files) <= 4 or pathlib.Path(f"{prefix}{len(files)}").exists():
        raise VerificationError("signing certificate chain was incomplete or ambiguous")
    trust = command(
        [
            "security",
            "verify-cert",
            "-p",
            "codeSign",
            "-N",
            "-L",
            *sum((["-c", str(item)] for item in files), []),
        ]
    )
    if trust.returncode != 0:
        raise VerificationError("Apple Development signing certificate chain was not trusted")
    return files


def certificate_facts(certificate: pathlib.Path) -> tuple[bytes, str]:
    dates = command(["openssl", "x509", "-inform", "DER", "-in", str(certificate), "-noout", "-startdate", "-enddate"])
    subject = command(["openssl", "x509", "-inform", "DER", "-in", str(certificate), "-noout", "-subject", "-nameopt", "multiline"])
    if dates.returncode != 0 or dates.stderr or subject.returncode != 0 or subject.stderr:
        raise VerificationError("signing certificate could not be inspected")
    try:
        date_values = dict(line.split("=", 1) for line in dates.stdout.decode("ascii").splitlines())
        fmt = "%b %d %H:%M:%S %Y %Z"
        start = dt.datetime.strptime(date_values["notBefore"], fmt).replace(tzinfo=dt.timezone.utc)
        end = dt.datetime.strptime(date_values["notAfter"], fmt).replace(tzinfo=dt.timezone.utc)
        subject_text = subject.stdout.decode("utf-8", errors="strict")
    except (KeyError, ValueError, UnicodeDecodeError) as failure:
        raise VerificationError("signing certificate metadata was invalid") from failure
    now = dt.datetime.now(dt.timezone.utc)
    if not start <= now < end:
        raise VerificationError("signing certificate was not current")
    common_names = re.findall(r"^\s*commonName\s*=\s*(.+)$", subject_text, re.MULTILINE)
    if len(common_names) != 1 or not common_names[0] or any(character in common_names[0] for character in ('"', "\n", "\r")):
        raise VerificationError("signing certificate common name was invalid")
    return certificate.read_bytes(), common_names[0]


def designated_requirement(bundle: pathlib.Path, executable: pathlib.Path, bundle_id: str, common_name: str) -> None:
    result = command(["codesign", "-d", "-r-", str(bundle)])
    if result.returncode != 0 or len(result.stdout) > 8192 or len(result.stderr) > 8192:
        raise VerificationError("codesign could not display the designated requirement")
    try:
        requirement_lines = result.stdout.decode("utf-8", errors="strict").replace("\r\n", "\n").splitlines()
    except UnicodeDecodeError as failure:
        raise VerificationError("designated requirement output was invalid") from failure
    exact_display_stderr(result.stderr, executable)
    expected = (
        f'designated => identifier "{bundle_id}" and anchor apple generic and '
        f'certificate leaf[subject.CN] = "{common_name}" and '
        f'certificate 1[field.{APPLE_DEVELOPMENT_INTERMEDIATE_OID}] /* exists */'
    )
    if requirement_lines != [expected]:
        raise VerificationError("signed bundle did not have the exact Apple Development designated requirement")


def require_exact_macho_inventory(
    app: pathlib.Path,
    expected_paths: set[str],
) -> dict[str, pathlib.Path]:
    discovered: dict[str, pathlib.Path] = {}
    try:
        candidates = app.rglob("*")
    except OSError as failure:
        raise VerificationError("signed bundle code inventory could not be enumerated") from failure
    for index, candidate in enumerate(candidates, start=1):
        if index > 4096:
            raise VerificationError("signed bundle code inventory exceeded the bounded walk")
        if candidate.is_symlink():
            raise VerificationError("signed bundle code inventory contained a symlink")
        if candidate.is_dir():
            continue
        if not candidate.is_file():
            raise VerificationError("signed bundle code inventory contained a special file")
        try:
            with candidate.open("rb") as stream:
                magic = stream.read(4)
        except OSError as failure:
            raise VerificationError("signed bundle code inventory could not be read") from failure
        if magic in MACH_O_MAGICS:
            relative = candidate.relative_to(app).as_posix()
            discovered[relative] = candidate
        elif candidate.stat().st_mode & 0o111:
            raise VerificationError("signed bundle contained an executable non-Mach-O file")
    if set(discovered) != expected_paths:
        raise VerificationError("signed Debug bundle Mach-O inventory was not the exact pinned closure")
    return discovered


def verify_exact_nested_code_bundles(app: pathlib.Path) -> None:
    expected = {
        "Frameworks/hermesvm.framework",
        "Extensions/AppIntents.appex",
    }
    discovered: dict[str, pathlib.Path] = {}
    for index, candidate in enumerate(app.rglob("*"), start=1):
        if index > 4096:
            raise VerificationError("signed nested-code inventory exceeded the bounded walk")
        if candidate.is_symlink():
            raise VerificationError("signed nested-code inventory contained a symlink")
        if candidate.is_dir() and candidate.suffix in {".app", ".appex", ".framework", ".xpc"}:
            discovered[candidate.relative_to(app).as_posix()] = candidate
    if set(discovered) != expected:
        raise VerificationError("signed Debug bundle nested-code inventory was not the exact pinned closure")
    for nested in discovered.values():
        verification = command(["codesign", "--verify", "--strict", str(nested)])
        require_codesign_verification(verification.returncode, verification.stdout, verification.stderr)


def verify_code_object(
    code: pathlib.Path,
    *,
    identifier: str,
    team_id: str,
    sealed_resources: bool,
) -> bytes:
    if not code.is_file() or code.is_symlink():
        raise VerificationError("signed code inventory item was unsafe")
    architectures = command(["lipo", "-archs", str(code)])
    if architectures.returncode != 0 or architectures.stdout.strip() != b"arm64" or architectures.stderr:
        raise VerificationError("signed code inventory item was not arm64-only")
    verification = command(["codesign", "--verify", "--strict", str(code)])
    require_codesign_verification(verification.returncode, verification.stdout, verification.stderr)
    positive_signature_metadata(
        code,
        identifier,
        team_id,
        sealed_resources=sealed_resources,
    )
    with tempfile.TemporaryDirectory(prefix="latchway-ios-code-object-", dir="/private/tmp") as directory:
        chain = extract_certificate_chain(code, pathlib.Path(directory))
        leaf, common_name = certificate_facts(chain[0])
        designated_requirement(code, code, identifier, common_name)
    return leaf


def verify_debug_macho_inventory(
    app: pathlib.Path,
    *,
    bundle_id: str,
    extension_bundle_id: str,
    team_id: str,
) -> dict[str, bytes]:
    expected = {
        "LatchwayExample": (bundle_id, True),
        "LatchwayExample.debug.dylib": ("LatchwayExample.debug", False),
        "__preview.dylib": ("__preview", False),
        "Frameworks/hermesvm.framework/hermesvm": ("dev.hermesengine.iphoneos", True),
        "Extensions/AppIntents.appex/AppIntents": (extension_bundle_id, True),
        "Extensions/AppIntents.appex/AppIntents.debug.dylib": ("AppIntents.debug", False),
        "Extensions/AppIntents.appex/__preview.dylib": ("__preview", False),
    }
    verify_exact_nested_code_bundles(app)
    inventory = require_exact_macho_inventory(app, set(expected))
    return {
        relative: verify_code_object(
            inventory[relative],
            identifier=identifier,
            team_id=team_id,
            sealed_resources=sealed_resources,
        )
        for relative, (identifier, sealed_resources) in expected.items()
    }


def split_pem_certificates(payload: bytes, *, exact_count: int) -> list[bytes]:
    pattern = re.compile(
        rb"-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----"
    )
    matches = list(pattern.finditer(payload))
    remainder = bytearray()
    previous = 0
    for match in matches:
        remainder.extend(payload[previous : match.start()])
        previous = match.end()
    remainder.extend(payload[previous:])
    if len(matches) != exact_count or bytes(remainder).strip():
        raise VerificationError("provisioning profile contained an unexpected CMS certificate set")
    return [match.group(0).replace(b"\r\n", b"\n") + b"\n" for match in matches]


def require_exact_profile_certificate_listing(payload: bytes) -> None:
    try:
        lines = payload.decode("utf-8", errors="strict").replace("\r\n", "\n").splitlines()
    except UnicodeDecodeError as failure:
        raise VerificationError("provisioning profile certificate listing was invalid") from failure
    while lines and lines[-1] == "":
        lines.pop()
    if lines != PROFILE_CERTIFICATE_LISTING:
        raise VerificationError("provisioning profile did not contain the exact Apple signer chain")


def pem_to_der(pem: bytes, path: pathlib.Path) -> bytes:
    path.write_bytes(pem)
    if path.is_symlink() or not path.is_file() or not 256 <= path.stat().st_size <= 65536:
        raise VerificationError("provisioning profile certificate extraction was unsafe")
    result = command(["openssl", "x509", "-in", str(path), "-outform", "DER"])
    if result.returncode != 0 or result.stderr or not 256 <= len(result.stdout) <= 65536:
        raise VerificationError("provisioning profile certificate could not be converted")
    return result.stdout


def require_profile_signer_leaf_constraints(certificate: pathlib.Path) -> None:
    result = command(
        ["openssl", "x509", "-inform", "DER", "-in", str(certificate), "-noout", "-text"]
    )
    if result.returncode != 0 or result.stderr or len(result.stdout) > 131072:
        raise VerificationError("provisioning profile signer certificate could not be inspected")
    try:
        text = result.stdout.decode("utf-8", errors="strict")
    except UnicodeDecodeError as failure:
        raise VerificationError("provisioning profile signer certificate was invalid") from failure
    markers = (
        "X509v3 Basic Constraints: critical\n                CA:FALSE\n",
        "X509v3 Key Usage: critical\n                Digital Signature\n",
        "1.2.840.113635.100.6.58:",
    )
    if any(text.count(marker) != 1 for marker in markers):
        raise VerificationError("provisioning profile signer certificate constraints were unexpected")


def verify_profile_cms_certificate_chain(
    path: pathlib.Path,
    *,
    certificates_pem: pathlib.Path,
    signer_pem: pathlib.Path,
    temporary: pathlib.Path,
) -> None:
    listing = command(["openssl", "pkcs7", "-inform", "DER", "-in", str(path), "-print_certs", "-noout"])
    if listing.returncode != 0 or listing.stderr:
        raise VerificationError("provisioning profile certificate chain could not be listed")
    require_exact_profile_certificate_listing(listing.stdout)

    certificates = split_pem_certificates(certificates_pem.read_bytes(), exact_count=3)
    signer = split_pem_certificates(signer_pem.read_bytes(), exact_count=1)
    pem_paths: list[pathlib.Path] = []
    der_paths: list[pathlib.Path] = []
    der_values: list[bytes] = []
    for index, certificate in enumerate(certificates):
        pem_path = temporary / f"profile-certificate-{index}.pem"
        der_path = temporary / f"profile-certificate-{index}.der"
        der = pem_to_der(certificate, pem_path)
        der_path.write_bytes(der)
        pem_paths.append(pem_path)
        der_paths.append(der_path)
        der_values.append(der)
    signer_der = pem_to_der(signer[0], temporary / "profile-signer.pem")
    if signer_der != der_values[0]:
        raise VerificationError("provisioning profile signerInfo did not bind to the pinned leaf")

    expected_common_names = (
        "Apple iPhone OS Provisioning Profile Signing",
        "Apple iPhone Certification Authority",
        "Apple Root CA",
    )
    for der_path, expected_common_name in zip(der_paths, expected_common_names, strict=True):
        _, common_name = certificate_facts(der_path)
        if common_name != expected_common_name:
            raise VerificationError("provisioning profile certificate common name was unexpected")
    require_profile_signer_leaf_constraints(der_paths[0])

    embedded_chain = command(
        [
            "openssl",
            "verify",
            "-CAfile",
            str(pem_paths[2]),
            "-untrusted",
            str(pem_paths[1]),
            str(pem_paths[0]),
        ]
    )
    if embedded_chain.returncode != 0 or embedded_chain.stderr:
        raise VerificationError("provisioning profile embedded certificate chain was invalid")

    system_trust = command(
        [
            "security",
            "verify-cert",
            "-p",
            "basic",
            "-N",
            "-L",
            "-c",
            str(der_paths[0]),
            "-c",
            str(der_paths[1]),
            "-c",
            str(der_paths[2]),
        ]
    )
    if system_trust.returncode != 0:
        raise VerificationError("provisioning profile signer chain was not trusted by macOS system roots")


def decoded_profile(path: pathlib.Path) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink() or not 1024 <= path.stat().st_size <= 1_048_576:
        raise VerificationError("embedded provisioning profile was unsafe")
    with tempfile.TemporaryDirectory(prefix="latchway-ios-profile-cms-", dir="/private/tmp") as directory:
        temporary = pathlib.Path(directory)
        certificates_pem = temporary / "profile-certificates.pem"
        signer_pem = temporary / "profile-signer-from-cms.pem"
        openssl = command(
            [
                "openssl",
                "cms",
                "-verify",
                "-inform",
                "DER",
                "-in",
                str(path),
                "-noverify",
                "-certsout",
                str(certificates_pem),
                "-signer",
                str(signer_pem),
                "-out",
                "-",
            ]
        )
        if openssl.returncode != 0:
            raise VerificationError("embedded provisioning profile CMS verification failed")
        verify_profile_cms_certificate_chain(
            path,
            certificates_pem=certificates_pem,
            signer_pem=signer_pem,
            temporary=temporary,
        )
        try:
            profile = plistlib.loads(openssl.stdout)
        except Exception as failure:
            raise VerificationError("embedded provisioning profile payload was invalid") from failure
        if not isinstance(profile, dict):
            raise VerificationError("authenticated provisioning profile payload was not a dictionary")
        return profile


def verify_profile(
    profile: dict[str, Any],
    *,
    team_id: str,
    app_id_prefix: str,
    device_udid: str,
    application_identifier: str,
    keychain_groups: list[str],
    app_attest: bool,
    leaf: bytes,
) -> None:
    now = dt.datetime.now(dt.timezone.utc)
    creation = profile.get("CreationDate")
    expiration = profile.get("ExpirationDate")
    if isinstance(creation, dt.datetime) and creation.tzinfo is None:
        creation = creation.replace(tzinfo=dt.timezone.utc)
    if isinstance(expiration, dt.datetime) and expiration.tzinfo is None:
        expiration = expiration.replace(tzinfo=dt.timezone.utc)
    entitlements = profile.get("Entitlements")
    certificates = profile.get("DeveloperCertificates")
    if (
        not isinstance(creation, dt.datetime)
        or not isinstance(expiration, dt.datetime)
        or creation > now
        or expiration <= now
        or creation >= expiration
        or profile.get("TeamIdentifier") != [team_id]
        or profile.get("ApplicationIdentifierPrefix") != [app_id_prefix]
        or "iOS" not in profile.get("Platform", [])
        or device_udid not in profile.get("ProvisionedDevices", [])
        or not isinstance(entitlements, dict)
        or entitlements.get("com.apple.developer.team-identifier") != team_id
        or entitlements.get("get-task-allow") is not True
        or not isinstance(certificates, list)
        or sum(1 for certificate in certificates if certificate == leaf) != 1
    ):
        raise VerificationError("embedded development profile did not match signer/team/device pins")
    if not profile_authorizes(application_identifier, [entitlements.get("application-identifier", "")]):
        raise VerificationError("embedded profile did not authorize the signed application identifier")
    if not all(profile_authorizes(group, entitlements.get("keychain-access-groups")) for group in keychain_groups):
        raise VerificationError("embedded profile did not authorize every signed Keychain group")
    if app_attest:
        if (
            not profile_authorizes_value(
                entitlements.get("com.apple.developer.devicecheck.appattest-environment"),
                "development",
            )
            or entitlements.get("com.apple.developer.devicecheck.app-attest-opt-in") != ["CDhash"]
        ):
            raise VerificationError("root profile did not authorize exact development App Attest")
    elif any(
        key in entitlements
        for key in (
            "com.apple.developer.devicecheck.appattest-environment",
            "com.apple.developer.devicecheck.app-attest-opt-in",
        )
    ):
        raise VerificationError("extension profile unexpectedly authorized App Attest")


def verify_bundle(
    bundle: pathlib.Path,
    *,
    suffix: str,
    bundle_id: str,
    application_identifier: str,
    app_id_prefix: str,
    team_id: str,
    device_udid: str,
    keychain_groups: list[str],
    app_attest: bool,
    deep: bool,
) -> tuple[str, bytes]:
    safe_bundle(bundle, suffix)
    info = plist(bundle / "Info.plist")
    executable_name = info.get("CFBundleExecutable")
    if info.get("CFBundleIdentifier") != bundle_id or not isinstance(executable_name, str) or "/" in executable_name:
        raise VerificationError("signed bundle identity was invalid")
    executable = bundle / executable_name
    if not executable.is_file() or executable.is_symlink():
        raise VerificationError("signed bundle executable was unsafe")
    architectures = command(["lipo", "-archs", str(executable)])
    if architectures.returncode != 0 or architectures.stdout.strip() != b"arm64" or architectures.stderr:
        raise VerificationError("signed development bundle was not arm64-only")
    verify_arguments = ["codesign", "--verify", "--strict"]
    if deep:
        verify_arguments.append("--deep")
    result = command([*verify_arguments, str(bundle)])
    mode = require_codesign_verification(result.returncode, result.stdout, result.stderr)
    entitlements = signed_entitlements(bundle, executable)
    expected_keys = {
        "application-identifier",
        "com.apple.developer.team-identifier",
        "get-task-allow",
        "keychain-access-groups",
    }
    if app_attest:
        expected_keys |= {
            "com.apple.developer.devicecheck.appattest-environment",
            "com.apple.developer.devicecheck.app-attest-opt-in",
            "com.apple.security.application-groups",
        }
    if (
        set(entitlements) != expected_keys
        or entitlements.get("application-identifier") != application_identifier
        or entitlements.get("com.apple.developer.team-identifier") != team_id
        or entitlements.get("get-task-allow") is not True
        or entitlements.get("keychain-access-groups") != keychain_groups
    ):
        raise VerificationError("signed bundle entitlements did not match exact development pins")
    if app_attest and (
        entitlements.get("com.apple.developer.devicecheck.appattest-environment") != "development"
        or entitlements.get("com.apple.developer.devicecheck.app-attest-opt-in") != ["CDhash"]
        or entitlements.get("com.apple.security.application-groups") != []
    ):
        raise VerificationError("root signed entitlements did not have exact development App Attest")
    positive_signature_metadata(
        bundle,
        bundle_id,
        team_id,
        sealed_resources=True,
    )
    with tempfile.TemporaryDirectory(prefix="latchway-ios-signature-", dir="/private/tmp") as directory:
        chain = extract_certificate_chain(bundle, pathlib.Path(directory))
        leaf, common_name = certificate_facts(chain[0])
        designated_requirement(bundle, executable, bundle_id, common_name)
        profile = decoded_profile(bundle / "embedded.mobileprovision")
        verify_profile(
            profile,
            team_id=team_id,
            app_id_prefix=app_id_prefix,
            device_udid=device_udid,
            application_identifier=application_identifier,
            keychain_groups=keychain_groups,
            app_attest=app_attest,
            leaf=leaf,
        )
    return mode, leaf


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True, type=pathlib.Path)
    parser.add_argument("--extension", required=True, type=pathlib.Path)
    parser.add_argument("--bundle-id", required=True)
    parser.add_argument("--extension-bundle-id", required=True)
    parser.add_argument("--team-id", required=True)
    parser.add_argument("--app-id-prefix", required=True)
    parser.add_argument("--device-udid", required=True)
    parser.add_argument("--private-keychain-group", required=True)
    parser.add_argument("--shared-keychain-group", required=True)
    arguments = parser.parse_args()
    try:
        if (
            IDENTIFIER.fullmatch(arguments.bundle_id) is None
            or arguments.extension_bundle_id != arguments.bundle_id + ".AppIntents"
            or TEN_CHARACTER_IDENTIFIER.fullmatch(arguments.team_id) is None
            or TEN_CHARACTER_IDENTIFIER.fullmatch(arguments.app_id_prefix) is None
            or DEVICE.fullmatch(arguments.device_udid) is None
            or arguments.private_keychain_group != f"{arguments.app_id_prefix}.{arguments.bundle_id}"
            or arguments.shared_keychain_group != arguments.private_keychain_group + ".keychain"
        ):
            raise VerificationError("development signature pins were invalid")
        expected_extension = arguments.app / "Extensions/AppIntents.appex"
        if arguments.extension != expected_extension:
            raise VerificationError("development App Intents bundle path was not the pinned nested path")
        root_mode, root_leaf = verify_bundle(
            arguments.app,
            suffix=".app",
            bundle_id=arguments.bundle_id,
            application_identifier=arguments.private_keychain_group,
            app_id_prefix=arguments.app_id_prefix,
            team_id=arguments.team_id,
            device_udid=arguments.device_udid,
            keychain_groups=[arguments.private_keychain_group, arguments.shared_keychain_group],
            app_attest=True,
            deep=True,
        )
        extension_mode, extension_leaf = verify_bundle(
            arguments.extension,
            suffix=".appex",
            bundle_id=arguments.extension_bundle_id,
            application_identifier=f"{arguments.app_id_prefix}.{arguments.extension_bundle_id}",
            app_id_prefix=arguments.app_id_prefix,
            team_id=arguments.team_id,
            device_udid=arguments.device_udid,
            keychain_groups=[arguments.shared_keychain_group],
            app_attest=False,
            deep=False,
        )
        if hashlib.sha256(root_leaf).digest() != hashlib.sha256(extension_leaf).digest():
            raise VerificationError("root and App Intents targets used different signing certificates")
        inventory_leaves = verify_debug_macho_inventory(
            arguments.app,
            bundle_id=arguments.bundle_id,
            extension_bundle_id=arguments.extension_bundle_id,
            team_id=arguments.team_id,
        )
        expected_leaf_hash = hashlib.sha256(root_leaf).digest()
        if any(hashlib.sha256(leaf).digest() != expected_leaf_hash for leaf in inventory_leaves.values()):
            raise VerificationError("signed Debug Mach-O inventory used inconsistent signing certificates")
        modes = {root_mode, extension_mode}
        if len(modes) != 1:
            raise VerificationError("root and App Intents codesign outcomes were inconsistent")
    except VerificationError as failure:
        print(f"development signed-bundle verification rejected: {failure}", file=sys.stderr)
        return 1
    print(f"development signed-bundle verification accepted ({root_mode})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
