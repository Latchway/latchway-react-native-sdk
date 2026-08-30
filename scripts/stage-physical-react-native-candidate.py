#!/usr/bin/env python3
"""Build, inspect, and stage one exact React Native physical candidate."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[1]
SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$")
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$")
DEFINITION = re.compile(r"^[a-z][a-z0-9_-]{0,62}$")
APPLICATION_ID = re.compile(r"^app_[0-7][0-9A-HJKMNP-TV-Z]{25}$")
SAFE_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
SAFE_KEY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
KEYCHAIN_PROFILE_WILDCARD = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.\*$"
)
HTTPS_ORIGIN = re.compile(
    r"^https://[a-z0-9][A-Za-z0-9.-]*(?::[1-9][0-9]{0,4})?(?:/[A-Za-z0-9_~.-]+)*$"
)
FORBIDDEN_RUNTIME_INPUTS = (
    "LATCHWAY_ONE_TIME_DEVICE_GRANT",
    "LATCHWAY_DEVICE_GRANT_SHA256",
    "LATCHWAY_SESSION_TOKEN",
    "LATCHWAY_REFRESH_TOKEN",
    "LATCHWAY_ADMIN_TOKEN",
)
ANDROID_SIGNING_INPUTS = (
    "LATCHWAY_ANDROID_KEYSTORE_PATH",
    "LATCHWAY_ANDROID_KEYSTORE_PASSWORD",
    "LATCHWAY_ANDROID_KEY_ALIAS",
    "LATCHWAY_ANDROID_KEY_PASSWORD",
    "LATCHWAY_ANDROID_UPLOAD_CERTIFICATE_SHA256",
)
AMBIENT_CREDENTIAL_INPUTS = (
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_CLIENT_SECRET",
    "AZURE_FEDERATED_TOKEN_FILE",
    "CI_JOB_TOKEN",
    "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
    "CLOUDFLARE_API_TOKEN",
    "DOCKER_CONFIG",
    "DOCKER_AUTH_CONFIG",
    "FIREBASE_TOKEN",
    "GCLOUD_SERVICE_KEY",
    "GH_TOKEN",
    "GIT_ASKPASS",
    "GIT_CONFIG_GLOBAL",
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_GHA_CREDS_PATH",
    "KUBECONFIG",
    "LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN",
    "NETRC",
    "NODE_AUTH_TOKEN",
    "NPM_CONFIG_USERCONFIG",
    "NPM_TOKEN",
    "SSH_ASKPASS",
    "SSH_AUTH_SOCK",
)
AMBIENT_CREDENTIAL_NAME = re.compile(
    r"(?:^|_)(?:ACCESS_KEY|API_KEY|ASKPASS|AUTH_SOCK|CREDENTIALS?|PASSWORD|PASSWD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)"
)
SAFE_INHERITED_ENVIRONMENT = (
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "CI",
    "CP_HOME_DIR",
    "COREPACK_HOME",
    "DEVELOPER_DIR",
    "GEM_HOME",
    "GEM_PATH",
    "GRADLE_USER_HOME",
    "HOME",
    "JAVA_HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "PNPM_HOME",
    "SDKROOT",
    "SHELL",
    "SOURCE_DATE_EPOCH",
    "TMPDIR",
    "TOOLCHAINS",
    "USER",
)
SAFE_EXTRA_ENVIRONMENT = ("ENVFILE",)
PINNED_NODE_VERSION = "24.19.0"
MATERIALIZED_SOURCE_ROOT_ENV = "LATCHWAY_INTERNAL_MATERIALIZED_SOURCE_ROOT"
ORIGINAL_SOURCE_ROOT_ENV = "LATCHWAY_INTERNAL_ORIGINAL_SOURCE_ROOT"
ORIGINAL_JAVASCRIPT_ROOT_ENV = "LATCHWAY_INTERNAL_ORIGINAL_JAVASCRIPT_ROOT"
COMMON_GENERATED_INPUTS = (
    "node_modules",
    "example/node_modules",
    "lib",
    ".cache",
    ".pnpm-store",
)
IOS_GENERATED_INPUTS = (
    "ios/build",
    "example/ios/Pods",
    "example/ios/build",
    "example/ios/LatchwayExample.xcworkspace",
    "example/ios/.xcode.env.local",
    "example/ios/LatchwayExample.xcodeproj/project.xcworkspace",
    "example/ios/LatchwayExample.xcodeproj/xcuserdata",
)
ANDROID_GENERATED_INPUTS = (
    ".gradle",
    "android/build",
    "example/android/.gradle",
    "example/android/build",
    "example/android/app/build",
    "example/android/app/google-services.json",
)


class CandidateError(RuntimeError):
    pass


def required(name: str, pattern: re.Pattern[str] | None = None) -> str:
    value = os.environ.get(name, "")
    if not value or "\x00" in value or "\r" in value or "\n" in value:
        raise CandidateError(f"required safe candidate input is missing: {name}")
    if pattern is not None and pattern.fullmatch(value) is None:
        raise CandidateError(f"candidate input is invalid: {name}")
    return value


def safe_file(name: str) -> pathlib.Path:
    path = pathlib.Path(required(name)).expanduser()
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError as failure:
        raise CandidateError(f"required external file is missing: {name}") from failure
    if not stat.S_ISREG(mode) or path.is_symlink() or path.stat().st_size <= 0:
        raise CandidateError(f"required external file is unsafe: {name}")
    return path.resolve()


def credential_free_environment(extra: dict[str, str] | None = None) -> dict[str, str]:
    environment = {
        name: value
        for name, value in os.environ.items()
        if name in SAFE_INHERITED_ENVIRONMENT
        or name.startswith("LATCHWAY_")
        or name.startswith("LC_")
    }
    if extra:
        environment.update(
            {
                name: value
                for name, value in extra.items()
                if name in SAFE_INHERITED_ENVIRONMENT
                or name in SAFE_EXTRA_ENVIRONMENT
                or name.startswith("LATCHWAY_")
                or name.startswith("LC_")
            }
        )
    for name in (
        *FORBIDDEN_RUNTIME_INPUTS,
        *ANDROID_SIGNING_INPUTS,
        *AMBIENT_CREDENTIAL_INPUTS,
    ):
        environment.pop(name, None)
    for name in list(environment):
        if (
            AMBIENT_CREDENTIAL_NAME.search(name.upper()) is not None
            or (name.startswith("GIT_CONFIG_") and name != "GIT_CONFIG_NOSYSTEM")
            or (name.startswith("NPM_CONFIG_") and name != "NPM_CONFIG_USERCONFIG")
        ):
            environment.pop(name, None)
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    environment["NPM_CONFIG_USERCONFIG"] = os.devnull
    return environment


def safe_repository(name: str) -> pathlib.Path:
    supplied = pathlib.Path(required(name)).expanduser()
    try:
        mode = supplied.lstat().st_mode
    except FileNotFoundError as failure:
        raise CandidateError(f"required source repository is unsafe: {name}") from failure
    if not stat.S_ISDIR(mode) or supplied.is_symlink():
        raise CandidateError(f"required source repository is unsafe: {name}")
    path = supplied.resolve()
    if not (path / ".git").exists():
        raise CandidateError(f"required source repository is unsafe: {name}")
    return path


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ios_application_tree(
    path: pathlib.Path,
    files_manifest_path: pathlib.Path,
) -> dict[str, Any]:
    """Compute the shared fail-closed iOS .app tree digest in a fresh process."""
    payload = command(
        [
            sys.executable,
            str(ROOT / "scripts/physical_app_bundle_tree.py"),
            "--json",
            "--app-files-manifest",
            str(files_manifest_path),
            str(path),
        ],
        capture=True,
    )
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as failure:
        raise CandidateError("iOS application tree helper returned invalid JSON") from failure
    if (
        not isinstance(value, dict)
        or value.get("hash_profile") != "latchway.ios-app-bundle-tree.v1"
        or not isinstance(value.get("tree_sha256"), str)
        or SHA256.fullmatch(value["tree_sha256"]) is None
        or not isinstance(value.get("app_files_manifest_sha256"), str)
        or SHA256.fullmatch(value["app_files_manifest_sha256"]) is None
    ):
        raise CandidateError("iOS application tree helper returned an invalid digest")
    return value


def command(
    arguments: list[str],
    *,
    cwd: pathlib.Path = ROOT,
    env: dict[str, str] | None = None,
    capture: bool = False,
) -> bytes:
    result = subprocess.run(
        arguments,
        cwd=cwd,
        env=env,
        check=False,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if result.returncode != 0:
        raise CandidateError(f"candidate command failed: {pathlib.Path(arguments[0]).name}")
    return result.stdout if capture else b""


def captured_text(arguments: list[str], *, cwd: pathlib.Path = ROOT) -> str:
    return command(arguments, cwd=cwd, capture=True).decode("utf-8", errors="strict").strip()


def pinned_pnpm_command(root: pathlib.Path = ROOT) -> list[str]:
    try:
        package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except Exception as failure:
        raise CandidateError("package.json is unavailable for the pinned package manager") from failure
    package_manager = package.get("packageManager") if isinstance(package, dict) else None
    match = re.fullmatch(r"pnpm@([0-9]+\.[0-9]+\.[0-9]+)", str(package_manager))
    if match is None:
        raise CandidateError("package.json does not pin an exact pnpm version")
    expected = match.group(1)
    for candidate in (["corepack", "pnpm"], ["pnpm"]):
        if shutil.which(candidate[0]) is None:
            continue
        result = subprocess.run(
            [*candidate, "--version"],
            cwd=root,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if result.returncode == 0 and result.stdout.decode("utf-8", errors="strict").strip() == expected:
            return candidate
    raise CandidateError("the exact package.json pnpm version is unavailable")


def require_absent_candidate_inputs(
    root: pathlib.Path,
    relatives: tuple[str, ...] | list[str],
    label: str,
) -> None:
    """Reject even dangling symlinks at build-sensitive ignored paths."""
    for relative in relatives:
        path = root / relative
        try:
            path.lstat()
        except FileNotFoundError:
            continue
        raise CandidateError(
            f"{label} contains pre-existing ignored/generated candidate input: {relative}"
        )


def ignored_inputs_under(root: pathlib.Path, relatives: tuple[str, ...]) -> list[str]:
    payload = command(
        [
            "git",
            "-C",
            str(root),
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
            "--",
            *relatives,
        ],
        capture=True,
    )
    try:
        return [item.decode("utf-8", errors="strict") for item in payload.split(b"\x00") if item]
    except UnicodeDecodeError as failure:
        raise CandidateError("candidate source contains a non-UTF-8 ignored input path") from failure


def require_pristine_ios_native_inputs(root: pathlib.Path) -> None:
    require_absent_candidate_inputs(root, list(IOS_GENERATED_INPUTS), "React Native iOS source")
    ignored = ignored_inputs_under(root, ("ios", "example/ios/AppIntents"))
    if ignored:
        raise CandidateError(
            "React Native iOS source contains ignored native input: " + ignored[0]
        )


def require_pristine_candidate_inputs(
    root: pathlib.Path,
    javascript_source: pathlib.Path,
    platform: str,
) -> None:
    require_absent_candidate_inputs(root, list(COMMON_GENERATED_INPUTS), "React Native source")
    javascript_generated = ["node_modules", "dist", ".cache", ".pnpm-store"]
    packages = javascript_source / "packages"
    if packages.is_dir() and not packages.is_symlink():
        for package in sorted(packages.iterdir(), key=lambda item: item.name):
            if package.is_dir() and not package.is_symlink():
                javascript_generated.extend(
                    [
                        f"packages/{package.name}/node_modules",
                        f"packages/{package.name}/dist",
                    ]
                )
    require_absent_candidate_inputs(
        javascript_source,
        javascript_generated,
        "JavaScript SDK source",
    )
    if platform == "ios":
        require_pristine_ios_native_inputs(root)
    else:
        require_absent_candidate_inputs(
            root,
            list(ANDROID_GENERATED_INPUTS),
            "React Native Android source",
        )


def verify_javascript_dependency_link(javascript_source: pathlib.Path) -> None:
    linked = ROOT / "node_modules/@latchway/client"
    try:
        linked.lstat()
        resolved = linked.resolve(strict=True)
    except (FileNotFoundError, RuntimeError, OSError) as failure:
        raise CandidateError("installed JavaScript SDK dependency link is missing or unsafe") from failure
    if resolved != javascript_source.resolve():
        raise CandidateError("installed JavaScript SDK dependency does not resolve to the pinned source")
    entrypoint = javascript_source / "dist/index.js"
    try:
        mode = entrypoint.lstat().st_mode
    except FileNotFoundError as failure:
        raise CandidateError("fresh JavaScript SDK build did not produce dist/index.js") from failure
    if entrypoint.is_symlink() or not stat.S_ISREG(mode) or entrypoint.stat().st_size <= 0:
        raise CandidateError("fresh JavaScript SDK dist/index.js is unsafe")


def candidate_output_path(javascript_source: pathlib.Path) -> pathlib.Path:
    output = pathlib.Path(required("LATCHWAY_CANDIDATE_OUTPUT_DIR")).expanduser().resolve()
    protected_roots = {ROOT.resolve(), javascript_source.resolve(), ROOT.parent.resolve()}
    for name in (ORIGINAL_SOURCE_ROOT_ENV, ORIGINAL_JAVASCRIPT_ROOT_ENV):
        try:
            protected_roots.add(pathlib.Path(required(name)).expanduser().resolve(strict=True))
        except (FileNotFoundError, RuntimeError, OSError) as failure:
            raise CandidateError("original candidate source root is unavailable") from failure
    if (
        output.exists()
        or output == pathlib.Path.home().resolve()
        or any(output == root or output.is_relative_to(root) for root in protected_roots)
    ):
        raise CandidateError("candidate output directory must be absent and narrowly scoped")
    return output


def verify_node_toolchain() -> str:
    if shutil.which("node") is None:
        raise CandidateError("required candidate tool is unavailable: node")
    version = captured_text(["node", "--version"]).removeprefix("v")
    if version != PINNED_NODE_VERSION:
        raise CandidateError(f"candidate production requires Node {PINNED_NODE_VERSION}")
    return version


def repository_identity(path: pathlib.Path, expected_commit: str, label: str) -> dict[str, str]:
    git = [
        "git",
        "-C",
        str(path),
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
    ]
    commit = captured_text([*git, "rev-parse", "HEAD"])
    if commit != expected_commit:
        raise CandidateError(f"{label} source commit does not match its protected pin")
    status_output = captured_text(
        [*git, "status", "--porcelain=v1", "--untracked-files=all"]
    )
    if status_output:
        raise CandidateError(f"{label} candidate production requires a clean source worktree")
    tree = captured_text([*git, "rev-parse", "HEAD^{tree}"])
    timestamp = captured_text([*git, "show", "-s", "--format=%ct", "HEAD"])
    return {"commit": commit, "tree": tree, "commit_timestamp": timestamp}


def contract_lock(path: pathlib.Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r'([a-z_]+):\s*"?([^"\s]+)"?', line)
        if match:
            values[match.group(1)] = match.group(2)
    return values


def verify_contract_lock(path: pathlib.Path, expected: dict[str, str], label: str) -> None:
    values = contract_lock(path)
    if any(values.get(key) != value for key, value in expected.items()):
        raise CandidateError(f"{label} contract.lock does not match the protected core/contract pins")


def load_ios_firebase_configuration(path: pathlib.Path, bundle_id: str) -> dict[str, str]:
    if path.stat().st_size > 131_072:
        raise CandidateError("Firebase iOS configuration is too large")
    try:
        value = plistlib.loads(path.read_bytes())
    except Exception as failure:
        raise CandidateError("Firebase iOS configuration is not a plist") from failure
    if not isinstance(value, dict) or value.get("BUNDLE_ID") != bundle_id:
        raise CandidateError("Firebase iOS bundle identifier does not match the candidate")
    result = {
        "api_key": value.get("API_KEY"),
        "app_id": value.get("GOOGLE_APP_ID"),
        "project_id": value.get("PROJECT_ID"),
    }
    patterns = {
        "api_key": re.compile(r"^[A-Za-z0-9_-]{16,256}$"),
        "app_id": re.compile(r"^[A-Za-z0-9:._-]{8,256}$"),
        "project_id": re.compile(r"^[a-z][a-z0-9-]{3,62}$"),
    }
    if any(not isinstance(result[key], str) or patterns[key].fullmatch(result[key]) is None for key in result):
        raise CandidateError("Firebase iOS configuration is missing a required application coordinate")
    return result  # type: ignore[return-value]


def load_android_firebase_configuration(
    path: pathlib.Path,
    package_name: str,
    cloud_project_number: str,
) -> dict[str, str]:
    if path.stat().st_size > 262_144:
        raise CandidateError("Firebase Android configuration is too large")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as failure:
        raise CandidateError("Firebase Android configuration is not valid JSON") from failure
    if not isinstance(value, dict) or not isinstance(value.get("project_info"), dict):
        raise CandidateError("Firebase Android project information is missing")
    project = value["project_info"]
    if str(project.get("project_number", "")) != cloud_project_number:
        raise CandidateError("Firebase project number does not match the Play Integrity project")
    clients = []
    for client in value.get("client", []):
        if not isinstance(client, dict):
            continue
        info = client.get("client_info")
        android_info = info.get("android_client_info") if isinstance(info, dict) else None
        if isinstance(android_info, dict) and android_info.get("package_name") == package_name:
            clients.append(client)
    if len(clients) != 1:
        raise CandidateError("Firebase Android configuration must contain one exact package client")
    client = clients[0]
    info = client["client_info"]
    api_keys = {
        entry.get("current_key")
        for entry in client.get("api_key", [])
        if isinstance(entry, dict) and isinstance(entry.get("current_key"), str)
    }
    if len(api_keys) != 1:
        raise CandidateError("Firebase Android configuration must contain one unambiguous API key")
    result = {
        "api_key": api_keys.pop(),
        "app_id": info.get("mobilesdk_app_id"),
        "project_id": project.get("project_id"),
    }
    patterns = {
        "api_key": re.compile(r"^[A-Za-z0-9_-]{16,256}$"),
        "app_id": re.compile(r"^[A-Za-z0-9:._-]{8,256}$"),
        "project_id": re.compile(r"^[a-z][a-z0-9-]{3,62}$"),
    }
    if any(not isinstance(result[key], str) or patterns[key].fullmatch(result[key]) is None for key in result):
        raise CandidateError("Firebase Android configuration is missing a required application coordinate")
    return result  # type: ignore[return-value]


def write_canonical_json(path: pathlib.Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, allow_nan=False, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    path.chmod(0o600)


def write_build_environment(path: pathlib.Path, values: dict[str, str]) -> str:
    for key, value in values.items():
        if not re.fullmatch(r"LATCHWAY_[A-Z0-9_]+", key) or any(character in value for character in "\r\n\x00"):
            raise CandidateError("candidate environment contains an unsafe key or value")
    forbidden = ("GRANT", "TOKEN", "PASSWORD", "PRIVATE_KEY", "SERVICE_ACCOUNT")
    if any(marker in key for key in values for marker in forbidden):
        raise CandidateError("candidate environment attempted to embed credential material")
    path.write_text("".join(f"{key}={values[key]}\n" for key in sorted(values)), encoding="utf-8")
    path.chmod(0o600)
    return sha256(path)


def canonical_tree_manifest(root: pathlib.Path, destination: pathlib.Path, prefix: str) -> str:
    lines: list[str] = []
    count = 0
    total = 0
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            continue
        if not stat.S_ISREG(mode) or path.is_symlink():
            raise CandidateError("candidate bundle contains a non-regular or symbolic-link entry")
        relative = path.relative_to(root).as_posix()
        if "\n" in relative or "\r" in relative or relative.startswith("/") or ".." in pathlib.PurePosixPath(relative).parts:
            raise CandidateError("candidate bundle contains an unsafe path")
        count += 1
        total += path.stat().st_size
        if count > 20_000 or total > 2_147_483_648:
            raise CandidateError("candidate bundle exceeds the bounded manifest limits")
        lines.append(f"{sha256(path)}  {prefix}/{relative}\n")
    if not lines:
        raise CandidateError("candidate bundle is empty")
    destination.write_text("".join(lines), encoding="utf-8")
    destination.chmod(0o600)
    return sha256(destination)


def copy_exact(source: pathlib.Path, destination: pathlib.Path) -> None:
    if source.is_symlink() or not source.is_file():
        raise CandidateError("candidate artifact is missing or unsafe")
    shutil.copyfile(source, destination)
    destination.chmod(0o600)


def extract_plist_from_codesign(bundle: pathlib.Path) -> dict[str, Any]:
    result = subprocess.run(
        ["codesign", "-d", "--entitlements", ":-", str(bundle)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise CandidateError("codesign could not extract signed entitlements")
    combined = result.stdout + b"\n" + result.stderr
    start = combined.find(b"<?xml")
    if start < 0:
        start = combined.find(b"<plist")
    end = combined.rfind(b"</plist>")
    if start < 0 or end < start:
        raise CandidateError("signed entitlement output does not contain a plist")
    value = plistlib.loads(combined[start : end + len(b"</plist>")])
    if not isinstance(value, dict):
        raise CandidateError("signed entitlements are invalid")
    return value


def profile_authorizes_keychain_access_groups(
    profile_groups: Any,
    signed_groups: list[str],
) -> bool:
    """Require every signed group to be covered by an exact or terminal-wildcard profile grant."""
    if not isinstance(profile_groups, list) or not all(
        isinstance(group, str) and group for group in profile_groups
    ):
        raise CandidateError("provisioning profile contains invalid Keychain access groups")
    authorizers: list[tuple[str, bool]] = []
    for group in profile_groups:
        if "*" in group:
            if KEYCHAIN_PROFILE_WILDCARD.fullmatch(group) is None:
                raise CandidateError("provisioning profile contains a malformed Keychain wildcard")
            authorizers.append((group[:-1], True))
        else:
            authorizers.append((group, False))
    return all(
        any(
            signed_group == profile_group
            or (is_wildcard and signed_group.startswith(profile_group))
            for profile_group, is_wildcard in authorizers
        )
        for signed_group in signed_groups
    )


def profile_authorizes_string_value(profile_value: Any, required_value: str) -> bool:
    if isinstance(profile_value, str):
        return profile_value == required_value
    return (
        isinstance(profile_value, list)
        and bool(profile_value)
        and all(isinstance(value, str) and value for value in profile_value)
        and required_value in profile_value
    )


def common_inputs() -> tuple[
    dict[str, str],
    dict[str, Any],
    pathlib.Path,
    dict[str, Any],
    pathlib.Path,
]:
    for name in FORBIDDEN_RUNTIME_INPUTS:
        if os.environ.get(name):
            raise CandidateError(f"runtime credential material is forbidden during candidate production: {name}")
    values = {
        "source_commit": required("LATCHWAY_SOURCE_COMMIT", COMMIT),
        "core_commit": required("LATCHWAY_CORE_COMMIT", COMMIT),
        "contract_version": required("LATCHWAY_CONTRACT_VERSION", SEMVER),
        "contract_bundle_sha256": required("LATCHWAY_CONTRACT_BUNDLE_SHA256", SHA256),
        "rn_sdk_version": required("LATCHWAY_RN_SDK_VERSION", SEMVER),
        "native_sdk_version": required("LATCHWAY_NATIVE_SDK_VERSION", SEMVER),
        "native_evidence_sha256": required("LATCHWAY_NATIVE_EVIDENCE_SHA256", SHA256),
        "gateway_image_digest": required("LATCHWAY_GATEWAY_IMAGE_DIGEST", re.compile(r"^sha256:[0-9a-f]{64}$")),
        "gateway_configuration_sha256": required("LATCHWAY_GATEWAY_CONFIGURATION_SHA256", SHA256),
        "gateway_origin": required("LATCHWAY_GATEWAY_ORIGIN", HTTPS_ORIGIN),
        "gateway_deployment_key_id": required("LATCHWAY_GATEWAY_DEPLOYMENT_KEY_ID", SAFE_KEY_ID),
        "gateway_deployment_statement_sha256": required("LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256", SHA256),
        "gateway_deployment_public_key_sha256": required("LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256", SHA256),
        "application_id": required("LATCHWAY_APPLICATION_ID", APPLICATION_ID),
        "environment": required("LATCHWAY_ENVIRONMENT", DEFINITION),
        "feature": required("LATCHWAY_FEATURE", DEFINITION),
        "error_mapping_feature": required("LATCHWAY_ERROR_MAPPING_FEATURE", DEFINITION),
        "model": required("LATCHWAY_MODEL", SAFE_MODEL),
    }
    if values["feature"] == values["error_mapping_feature"]:
        raise CandidateError("error-mapping feature must be distinct and guaranteed absent")
    base_url = required("LATCHWAY_BASE_URL", HTTPS_ORIGIN)
    if base_url != values["gateway_origin"]:
        raise CandidateError("LATCHWAY_BASE_URL must exactly match the signed gateway origin")
    native_evidence = safe_file("LATCHWAY_NATIVE_EVIDENCE_PATH")
    if sha256(native_evidence) != values["native_evidence_sha256"]:
        raise CandidateError("linked native evidence does not match its protected digest")
    core_source = safe_repository("LATCHWAY_CORE_SOURCE_PATH")
    core_identity = repository_identity(core_source, values["core_commit"], "core")
    source_identity = repository_identity(ROOT, values["source_commit"], "React Native")
    expected_lock = {
        "contract_version": values["contract_version"],
        "core_commit": values["core_commit"],
        "bundle_sha256": values["contract_bundle_sha256"],
    }
    verify_contract_lock(ROOT / "contract.lock", expected_lock, "React Native")
    compatibility = json.loads((ROOT / "release-compatibility.json").read_text(encoding="utf-8"))
    contract = compatibility.get("contract", {})
    javascript = compatibility.get("javascript", {})
    if (
        contract.get("version") != values["contract_version"]
        or contract.get("core_commit") != values["core_commit"]
        or contract.get("bundle_sha256") != values["contract_bundle_sha256"]
        or compatibility.get("react_native", {}).get("version") != values["rn_sdk_version"]
        or not isinstance(javascript, dict)
        or not isinstance(javascript.get("source_commit"), str)
        or COMMIT.fullmatch(javascript["source_commit"]) is None
        or not isinstance(javascript.get("package"), str)
        or javascript.get("package") != "@latchway/client"
        or not isinstance(javascript.get("version"), str)
        or SEMVER.fullmatch(javascript["version"]) is None
    ):
        raise CandidateError("release-compatibility.json does not match the protected source/contract pins")
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if package.get("version") != values["rn_sdk_version"]:
        raise CandidateError("React Native SDK version does not match package.json")
    javascript_source = safe_repository("LATCHWAY_JAVASCRIPT_SDK_PATH")
    try:
        expected_javascript_source = (ROOT.parent / "latchway-js").resolve(strict=True)
    except (FileNotFoundError, RuntimeError, OSError) as failure:
        raise CandidateError("materialized JavaScript SDK sibling is missing") from failure
    if javascript_source != expected_javascript_source:
        raise CandidateError(
            "JavaScript SDK source must be the materialized sibling of the React Native source"
        )
    javascript_identity = repository_identity(
        javascript_source,
        javascript["source_commit"],
        "JavaScript SDK",
    )
    verify_contract_lock(javascript_source / "contract.lock", expected_lock, "JavaScript SDK")
    try:
        javascript_package = json.loads(
            (javascript_source / "package.json").read_text(encoding="utf-8")
        )
    except Exception as failure:
        raise CandidateError("JavaScript SDK package.json is unavailable") from failure
    if (
        not isinstance(javascript_package, dict)
        or javascript_package.get("name") != javascript.get("package")
        or javascript_package.get("version") != javascript.get("version")
        or javascript_package.get("packageManager") != package.get("packageManager")
    ):
        raise CandidateError("JavaScript SDK package identity does not match compatibility pins")
    javascript_identity.update(
        {
            "repository": "Latchway/latchway-js",
            "package": javascript["package"],
            "sdk_version": javascript["version"],
        }
    )
    identities = {
        "source": source_identity,
        "javascript": javascript_identity,
        "core": core_identity,
    }
    return values, compatibility, native_evidence, identities, javascript_source


def build_configuration(values: dict[str, str], firebase: dict[str, str], platform: str) -> dict[str, str]:
    configuration = {
        "LATCHWAY_BASE_URL": values["gateway_origin"],
        "LATCHWAY_APPLICATION_ID": values["application_id"],
        "LATCHWAY_ENVIRONMENT": values["environment"],
        "LATCHWAY_FEATURE": values["feature"],
        "LATCHWAY_ERROR_MAPPING_FEATURE": values["error_mapping_feature"],
        "LATCHWAY_MODEL": values["model"],
        "LATCHWAY_CONFORMANCE_AUTORUN": "true",
        "LATCHWAY_SOURCE_COMMIT": values["source_commit"],
        "LATCHWAY_CORE_COMMIT": values["core_commit"],
        "LATCHWAY_CONTRACT_BUNDLE_SHA256": values["contract_bundle_sha256"],
        "LATCHWAY_GATEWAY_IMAGE_DIGEST": values["gateway_image_digest"],
        "LATCHWAY_GATEWAY_CONFIGURATION_SHA256": values["gateway_configuration_sha256"],
        "LATCHWAY_GATEWAY_ORIGIN": values["gateway_origin"],
        "LATCHWAY_GATEWAY_DEPLOYMENT_KEY_ID": values["gateway_deployment_key_id"],
        "LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256": values["gateway_deployment_statement_sha256"],
        "LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256": values["gateway_deployment_public_key_sha256"],
        "LATCHWAY_NATIVE_EVIDENCE_SHA256": values["native_evidence_sha256"],
        "LATCHWAY_NATIVE_SDK_VERSION": values["native_sdk_version"],
        "LATCHWAY_FIREBASE_API_KEY": firebase["api_key"],
        "LATCHWAY_FIREBASE_APP_ID": firebase["app_id"],
        "LATCHWAY_FIREBASE_PROJECT_ID": firebase["project_id"],
    }
    if platform == "ios":
        configuration.update(
            {
                "LATCHWAY_PACKAGE_OR_BUNDLE_IDENTIFIER": required(
                    "LATCHWAY_BUNDLE_ID", IDENTIFIER
                ),
                "LATCHWAY_DISTRIBUTION": required("LATCHWAY_DISTRIBUTION"),
                "LATCHWAY_SIGNING_CERTIFICATE_SHA256": required(
                    "LATCHWAY_SIGNING_CERTIFICATE_SHA256", SHA256
                ),
                "LATCHWAY_IOS_TEAM_ID": required("LATCHWAY_TEAM_ID", re.compile(r"^[A-Z0-9]{10}$")),
                "LATCHWAY_APP_ATTEST_ENVIRONMENT": "production",
            }
        )
    else:
        configuration.update(
            {
                "LATCHWAY_PACKAGE_OR_BUNDLE_IDENTIFIER": required(
                    "LATCHWAY_PACKAGE_NAME", IDENTIFIER
                ),
                "LATCHWAY_DISTRIBUTION": f"play_{required('LATCHWAY_PLAY_TRACK')}",
                "LATCHWAY_SIGNING_CERTIFICATE_SHA256": required(
                    "LATCHWAY_SIGNING_CERTIFICATE_SHA256", SHA256
                ),
                "LATCHWAY_PLAY_TRACK": required("LATCHWAY_PLAY_TRACK"),
                "LATCHWAY_GOOGLE_CLOUD_PROJECT_NUMBER": required(
                    "LATCHWAY_CLOUD_PROJECT_NUMBER", re.compile(r"^[1-9][0-9]{0,18}$")
                ),
                "LATCHWAY_REQUIRE_LICENSED": "true",
            }
        )
    return configuration


def stage_ios(
    values: dict[str, str],
    compatibility: dict[str, Any],
    identities: dict[str, Any],
    temporary: pathlib.Path,
    staging: pathlib.Path,
) -> dict[str, Any]:
    ios_source = safe_repository("LATCHWAY_IOS_SDK_PATH")
    ios_commit = required("LATCHWAY_IOS_COMMIT", COMMIT)
    ios_identity = repository_identity(ios_source, ios_commit, "iOS native")
    if compatibility.get("ios", {}).get("source_commit") != ios_commit:
        raise CandidateError("iOS native source does not match release-compatibility.json")
    if compatibility.get("ios", {}).get("version") != values["native_sdk_version"]:
        raise CandidateError("iOS native version does not match release-compatibility.json")
    verify_contract_lock(
        ios_source / "contract.lock",
        {
            "contract_version": values["contract_version"],
            "core_commit": values["core_commit"],
            "bundle_sha256": values["contract_bundle_sha256"],
        },
        "iOS native",
    )
    bundle_id = required("LATCHWAY_BUNDLE_ID", IDENTIFIER)
    appintents_bundle_id = required("LATCHWAY_IOS_APPINTENTS_BUNDLE_ID", IDENTIFIER)
    if appintents_bundle_id == bundle_id or not appintents_bundle_id.startswith(bundle_id + "."):
        raise CandidateError("App Intents bundle ID must be a distinct child of the root bundle ID")
    app_version = required("LATCHWAY_APP_VERSION", re.compile(r"^[0-9]+(?:\.[0-9]+){1,3}$"))
    build_number = required("LATCHWAY_BUILD_NUMBER", re.compile(r"^[1-9][0-9]{0,17}$"))
    team_id = required("LATCHWAY_TEAM_ID", re.compile(r"^[A-Z0-9]{10}$"))
    app_id_prefix = required("LATCHWAY_IOS_APP_ID_PREFIX", re.compile(r"^[A-Z0-9]{10}$"))
    distribution = required("LATCHWAY_DISTRIBUTION")
    if distribution != "ad_hoc" or required("LATCHWAY_APP_ATTEST_ENVIRONMENT") != "production":
        raise CandidateError("installable iOS physical candidates require ad_hoc and production App Attest")
    certificate_pin = required("LATCHWAY_SIGNING_CERTIFICATE_SHA256", SHA256)
    profile_uuid = required(
        "LATCHWAY_IOS_PROVISIONING_PROFILE_UUID",
        re.compile(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"),
    )
    appintents_profile_uuid = required(
        "LATCHWAY_IOS_APPINTENTS_PROVISIONING_PROFILE_UUID",
        re.compile(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"),
    )
    if appintents_profile_uuid == profile_uuid:
        raise CandidateError("root and App Intents targets require distinct provisioning profiles")
    shared_keychain_access_group = required(
        "LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP",
        re.compile(r"^[A-Z0-9]{10}\.[A-Za-z0-9.-]{3,244}$"),
    )
    if shared_keychain_access_group != f"{app_id_prefix}.{bundle_id}.keychain":
        raise CandidateError("shared Keychain access group is not bound to the root App ID")
    private_keychain_access_group = f"{app_id_prefix}.{bundle_id}"
    expected_root_keychain_access_groups = [
        private_keychain_access_group,
        shared_keychain_access_group,
    ]
    expected_extension_keychain_access_groups = [shared_keychain_access_group]
    signing_identity = required("LATCHWAY_IOS_CODE_SIGN_IDENTITY")
    firebase_path = safe_file("LATCHWAY_FIREBASE_IOS_CONFIG_PATH")
    firebase = load_ios_firebase_configuration(firebase_path, bundle_id)
    firebase_sha = sha256(firebase_path)
    pod_lock_source = safe_file("LATCHWAY_IOS_PODFILE_LOCK_PATH")
    pod_lock_target = ROOT / "example/ios/Podfile.lock"
    copied_pod_lock = False
    if pod_lock_target.exists():
        if pod_lock_target.is_symlink() or sha256(pod_lock_target) != sha256(pod_lock_source):
            raise CandidateError("existing ignored Podfile.lock differs from the protected candidate lock")
    else:
        shutil.copyfile(pod_lock_source, pod_lock_target)
        pod_lock_target.chmod(0o600)
        copied_pod_lock = True
    configuration = build_configuration(values, firebase, "ios")
    configuration.update(
        {
            "LATCHWAY_IOS_ROOT_KEYCHAIN_ACCESS_GROUP": private_keychain_access_group,
            "LATCHWAY_IOS_LEGACY_SHARED_KEYCHAIN_ACCESS_GROUPS": shared_keychain_access_group,
        }
    )
    env_file = temporary / "ios-candidate.env"
    configuration_sha = write_build_environment(env_file, configuration)
    build_env = os.environ.copy()
    for name in FORBIDDEN_RUNTIME_INPUTS:
        build_env.pop(name, None)
    build_env.update(
        {
            "ENVFILE": str(env_file),
            "LATCHWAY_IOS_SDK_PATH": str(ios_source),
            "LATCHWAY_PHYSICAL_CANDIDATE": "1",
            "LATCHWAY_FIREBASE_IOS_CONFIG_PATH": str(firebase_path),
            "LATCHWAY_FIREBASE_CONFIGURATION_SHA256": firebase_sha,
            "LATCHWAY_CANDIDATE_CONFIGURATION_SHA256": configuration_sha,
            "RCT_NEW_ARCH_ENABLED": "1",
            "SOURCE_DATE_EPOCH": identities["source"]["commit_timestamp"],
        }
    )
    try:
        require_pristine_ios_native_inputs(ROOT)
        command(["pod", "install", "--deployment"], cwd=ROOT / "example/ios", env=build_env)
        archive = temporary / "LatchwayExample.xcarchive"
        command(
            [
                "xcodebuild",
                "-workspace",
                str(ROOT / "example/ios/LatchwayExample.xcworkspace"),
                "-scheme",
                "LatchwayExample",
                "-configuration",
                "Release",
                "-destination",
                "generic/platform=iOS",
                "-derivedDataPath",
                str(temporary / "DerivedData"),
                "-archivePath",
                str(archive),
                "archive",
                f"LATCHWAY_ROOT_BUNDLE_IDENTIFIER={bundle_id}",
                f"LATCHWAY_APPINTENTS_BUNDLE_IDENTIFIER={appintents_bundle_id}",
                f"MARKETING_VERSION={app_version}",
                f"CURRENT_PROJECT_VERSION={build_number}",
                f"DEVELOPMENT_TEAM={team_id}",
                "CODE_SIGN_STYLE=Manual",
                f"CODE_SIGN_IDENTITY={signing_identity}",
                f"LATCHWAY_ROOT_PROVISIONING_PROFILE_SPECIFIER={profile_uuid}",
                f"LATCHWAY_APPINTENTS_PROVISIONING_PROFILE_SPECIFIER={appintents_profile_uuid}",
                "APP_ATTEST_ENVIRONMENT=production",
                "DEBUG_INFORMATION_FORMAT=dwarf-with-dsym",
            ],
            env=build_env,
        )
    finally:
        if copied_pod_lock and pod_lock_target.exists() and not pod_lock_target.is_symlink():
            pod_lock_target.unlink()
    app = archive / "Products/Applications/LatchwayExample.app"
    if not app.is_dir() or app.is_symlink():
        raise CandidateError("xcodebuild did not produce a safe Release application")
    command(["codesign", "--verify", "--deep", "--strict", str(app)])
    info_path = app / "Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    if not isinstance(info, dict) or (
        info.get("CFBundleIdentifier") != bundle_id
        or info.get("CFBundleShortVersionString") != app_version
        or info.get("CFBundleVersion") != build_number
        or info.get("LatchwayFirebaseConfigurationSHA256") != firebase_sha
        or info.get("LatchwayCandidateConfigurationSHA256") != configuration_sha
    ):
        raise CandidateError("signed iOS candidate identity/configuration does not match")
    executable_name = info.get("CFBundleExecutable")
    if not isinstance(executable_name, str) or "/" in executable_name:
        raise CandidateError("signed iOS executable name is invalid")
    executable = app / executable_name
    javascript_bundle = app / "main.jsbundle"
    bundled_firebase = app / "GoogleService-Info.plist"
    for artifact in (executable, javascript_bundle, bundled_firebase):
        if not artifact.is_file() or artifact.is_symlink():
            raise CandidateError("signed iOS candidate is missing a required regular-file input")
    if sha256(bundled_firebase) != firebase_sha:
        raise CandidateError("signed iOS candidate embeds the wrong Firebase configuration")
    entitlements = extract_plist_from_codesign(app)
    expected_application_identifier = private_keychain_access_group
    if (
        entitlements.get("com.apple.developer.team-identifier") != team_id
        or entitlements.get("application-identifier") != expected_application_identifier
        or entitlements.get("com.apple.developer.devicecheck.appattest-environment") != "production"
        or entitlements.get("com.apple.developer.devicecheck.app-attest-opt-in")
        != ["CDhash"]
        or entitlements.get("get-task-allow") not in {None, False}
    ):
        raise CandidateError("signed iOS candidate entitlements do not match production pins")
    keychain_groups = entitlements.get("keychain-access-groups")
    if keychain_groups != expected_root_keychain_access_groups:
        raise CandidateError(
            "signed root target does not have the exact private-first/shared-second Keychain access groups"
        )
    certificate_prefix = temporary / "ios-signing-certificate-"
    command(["codesign", "-d", "--extract-certificates", str(certificate_prefix), str(app)], capture=True)
    certificate_path = pathlib.Path(f"{certificate_prefix}0")
    if not certificate_path.is_file() or sha256(certificate_path) != certificate_pin:
        raise CandidateError("signed iOS candidate certificate does not match its protected pin")
    profile_path = app / "embedded.mobileprovision"
    if not profile_path.is_file() or profile_path.is_symlink():
        raise CandidateError("signed iOS candidate is missing a safe provisioning profile")
    decoded_profile = temporary / "embedded-profile.plist"
    command(
        [
            "openssl",
            "cms",
            "-verify",
            "-inform",
            "DER",
            "-in",
            str(profile_path),
            "-noverify",
            "-out",
            str(decoded_profile),
        ],
        capture=True,
    )
    profile = plistlib.loads(decoded_profile.read_bytes())
    profile_entitlements = profile.get("Entitlements", {}) if isinstance(profile, dict) else {}
    if (
        not isinstance(profile, dict)
        or profile.get("UUID") != profile_uuid
        or team_id not in profile.get("TeamIdentifier", [])
        or not profile.get("ProvisionedDevices")
        or profile_entitlements.get("application-identifier") != expected_application_identifier
        or profile_entitlements.get("com.apple.developer.team-identifier") != team_id
        or not profile_authorizes_string_value(
            profile_entitlements.get(
                "com.apple.developer.devicecheck.appattest-environment"
            ),
            "production",
        )
        or profile_entitlements.get("com.apple.developer.devicecheck.app-attest-opt-in")
        != ["CDhash"]
        or profile_entitlements.get("get-task-allow") not in {None, False}
    ):
        raise CandidateError("iOS provisioning profile does not match the signed candidate pins")
    profile_groups = profile_entitlements.get("keychain-access-groups")
    if not profile_authorizes_keychain_access_groups(
        profile_groups,
        expected_root_keychain_access_groups,
    ):
        raise CandidateError(
            "root provisioning profile does not authorize every signed Keychain access group"
        )

    extension = app / "Extensions" / "AppIntents.appex"
    if not extension.is_dir() or extension.is_symlink():
        raise CandidateError("signed iOS candidate is missing the App Intents extension")
    command(["codesign", "--verify", "--strict", str(extension)])
    extension_info_path = extension / "Info.plist"
    if not extension_info_path.is_file() or extension_info_path.is_symlink():
        raise CandidateError("signed App Intents target is missing a safe Info.plist")
    extension_info = plistlib.loads(extension_info_path.read_bytes())
    if not isinstance(extension_info, dict) or (
        extension_info.get("CFBundleIdentifier") != appintents_bundle_id
        or extension_info.get("CFBundleShortVersionString") != app_version
        or extension_info.get("CFBundleVersion") != build_number
    ):
        raise CandidateError("signed App Intents target identity does not match")
    extension_entitlements = extract_plist_from_codesign(extension)
    expected_extension_application_identifier = f"{app_id_prefix}.{appintents_bundle_id}"
    if (
        extension_entitlements.get("com.apple.developer.team-identifier") != team_id
        or extension_entitlements.get("application-identifier")
        != expected_extension_application_identifier
        or extension_entitlements.get("keychain-access-groups")
        != expected_extension_keychain_access_groups
        or extension_entitlements.get("get-task-allow") not in {None, False}
        or "com.apple.developer.devicecheck.appattest-environment" in extension_entitlements
        or "com.apple.developer.devicecheck.app-attest-opt-in" in extension_entitlements
    ):
        raise CandidateError("signed App Intents entitlements do not match delegated-only pins")
    extension_certificate_prefix = temporary / "ios-appintents-signing-certificate-"
    command(
        [
            "codesign",
            "-d",
            "--extract-certificates",
            str(extension_certificate_prefix),
            str(extension),
        ],
        capture=True,
    )
    extension_certificate_path = pathlib.Path(f"{extension_certificate_prefix}0")
    if not extension_certificate_path.is_file() or sha256(extension_certificate_path) != certificate_pin:
        raise CandidateError("signed App Intents certificate does not match its protected pin")
    extension_profile_path = extension / "embedded.mobileprovision"
    if not extension_profile_path.is_file() or extension_profile_path.is_symlink():
        raise CandidateError("signed App Intents target is missing a safe provisioning profile")
    decoded_extension_profile = temporary / "embedded-appintents-profile.plist"
    command(
        [
            "openssl",
            "cms",
            "-verify",
            "-inform",
            "DER",
            "-in",
            str(extension_profile_path),
            "-noverify",
            "-out",
            str(decoded_extension_profile),
        ],
        capture=True,
    )
    extension_profile = plistlib.loads(decoded_extension_profile.read_bytes())
    extension_profile_entitlements = (
        extension_profile.get("Entitlements", {})
        if isinstance(extension_profile, dict)
        else {}
    )
    if (
        not isinstance(extension_profile, dict)
        or extension_profile.get("UUID") != appintents_profile_uuid
        or team_id not in extension_profile.get("TeamIdentifier", [])
        or not extension_profile.get("ProvisionedDevices")
        or extension_profile_entitlements.get("application-identifier")
        != expected_extension_application_identifier
        or extension_profile_entitlements.get("com.apple.developer.team-identifier") != team_id
        or extension_profile_entitlements.get("get-task-allow") not in {None, False}
        or "com.apple.developer.devicecheck.appattest-environment"
        in extension_profile_entitlements
        or "com.apple.developer.devicecheck.app-attest-opt-in"
        in extension_profile_entitlements
    ):
        raise CandidateError("App Intents provisioning profile does not match delegated-only pins")
    if not profile_authorizes_keychain_access_groups(
        extension_profile_entitlements.get("keychain-access-groups"),
        expected_extension_keychain_access_groups,
    ):
        raise CandidateError(
            "App Intents provisioning profile does not authorize its signed shared Keychain access group"
        )
    staged_app = staging / "LatchwayExample.app"
    shutil.copytree(app, staged_app, symlinks=True)
    for directory in [staged_app, *[path for path in staged_app.rglob("*") if path.is_dir()]]:
        directory.chmod(0o700)
    application_tree = ios_application_tree(
        staged_app,
        staging / "ios-app-files.sha256",
    )
    copy_exact(javascript_bundle, staging / "ios-main.jsbundle")
    copy_exact(pod_lock_source, staging / "ios-Podfile.lock")
    identities["native"] = ios_identity
    identities["native"]["repository"] = "Latchway/latchway-ios-sdk"
    identities["native"]["sdk_version"] = values["native_sdk_version"]
    return {
        "platform": "react_native_ios_app_attest",
        "configuration": "Release",
        "debuggable": False,
        "new_architecture": True,
        "hermes": True,
        "application": {
            "bundle_id": bundle_id,
            "version": app_version,
            "build": build_number,
            "distribution": distribution,
            "team_id": team_id,
            "app_id_prefix": app_id_prefix,
            "provisioning_profile_uuid": profile_uuid,
            "appintents_bundle_id": appintents_bundle_id,
            "appintents_provisioning_profile_uuid": appintents_profile_uuid,
            "shared_keychain_access_group": shared_keychain_access_group,
            "root_keychain_access_group": private_keychain_access_group,
            "legacy_shared_keychain_access_groups": [shared_keychain_access_group],
            "signing_certificate_sha256": certificate_pin,
            "executable_sha256": sha256(executable),
            "javascript_bundle_sha256": sha256(javascript_bundle),
            "app_files_manifest_sha256": application_tree["app_files_manifest_sha256"],
            "application_bundle_tree": application_tree,
            "application_bundle_tree_sha256": application_tree["tree_sha256"],
            "app_attest_environment": "production",
        },
        "dependency_lock": {"file": "ios-Podfile.lock", "sha256": sha256(pod_lock_source)},
        "firebase_configuration_sha256": firebase_sha,
        "candidate_configuration_sha256": configuration_sha,
    }


def android_manifest_values(apk: pathlib.Path) -> tuple[str, str]:
    xml = captured_text(["apkanalyzer", "manifest", "print", str(apk)])
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as failure:
        raise CandidateError("apkanalyzer returned an invalid manifest") from failure
    namespace = "{http://schemas.android.com/apk/res/android}"
    application = root.find("application")
    if application is None:
        raise CandidateError("signed Android candidate has no application element")
    metadata = {
        item.attrib.get(namespace + "name"): item.attrib.get(namespace + "value")
        for item in application.findall("meta-data")
    }
    return (
        metadata.get("dev.latchway.firebase_configuration_sha256", ""),
        metadata.get("dev.latchway.candidate_configuration_sha256", ""),
    )


def require_closed_directory(root: pathlib.Path, expected_names: set[str], label: str) -> None:
    try:
        entries = list(root.iterdir())
    except OSError as failure:
        raise CandidateError(f"{label} is unavailable") from failure
    if {path.name for path in entries} != expected_names:
        raise CandidateError(f"{label} does not contain the exact closed file set")
    for path in entries:
        mode = path.lstat().st_mode
        if not stat.S_ISREG(mode) or path.is_symlink() or path.stat().st_size <= 0:
            raise CandidateError(f"{label} contains an unsafe file")


def require_unsigned_android_artifacts(aab: pathlib.Path, apk: pathlib.Path) -> None:
    for artifact in (aab, apk):
        if not artifact.is_file() or artifact.is_symlink() or artifact.stat().st_size <= 0:
            raise CandidateError("Gradle did not produce both safe unsigned Release artifacts")
    signature_metadata = re.compile(
        r"^META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]*)$", re.IGNORECASE
    )
    try:
        with zipfile.ZipFile(aab) as archive:
            names: set[str] = set()
            casefolded: set[str] = set()
            normalized: set[str] = set()
            expanded_bytes = 0
            for entry in archive.infolist():
                name = entry.filename
                parts = name.split("/")
                if (
                    entry.is_dir()
                    or not name
                    or name.startswith("/")
                    or "\\" in name
                    or "\x00" in name
                    or any(part in {"", ".", ".."} for part in parts)
                ):
                    raise CandidateError("unsigned AAB contains an unsafe physical ZIP entry")
                folded = name.casefold()
                normalized_name = unicodedata.normalize("NFC", name).casefold()
                if name in names or folded in casefolded or normalized_name in normalized:
                    raise CandidateError("unsigned AAB contains an ambiguous physical ZIP entry")
                names.add(name)
                casefolded.add(folded)
                normalized.add(normalized_name)
                expanded_bytes += entry.file_size
                if len(names) > 100_000 or expanded_bytes > 2_147_483_648:
                    raise CandidateError("unsigned AAB exceeds the reviewed archive bounds")
                if signature_metadata.fullmatch(name):
                    raise CandidateError("unsigned AAB unexpectedly contains JAR signature metadata")
            if not names:
                raise CandidateError("unsigned AAB contains no physical payload entries")
    except zipfile.BadZipFile as failure:
        raise CandidateError("unsigned AAB is not a valid ZIP archive") from failure
    apk_check = subprocess.run(
        ["apksigner", "verify", str(apk)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
    )
    if apk_check.returncode == 0:
        raise CandidateError("repository Gradle build unexpectedly produced a signed APK")


def stage_android(
    values: dict[str, str],
    compatibility: dict[str, Any],
    identities: dict[str, Any],
    temporary: pathlib.Path,
    staging: pathlib.Path,
) -> dict[str, Any]:
    android_source = safe_repository("LATCHWAY_ANDROID_SDK_PATH")
    android_commit = required("LATCHWAY_ANDROID_COMMIT", COMMIT)
    android_identity = repository_identity(android_source, android_commit, "Android native")
    if compatibility.get("android", {}).get("source_commit") != android_commit:
        raise CandidateError("Android native source does not match release-compatibility.json")
    if compatibility.get("android", {}).get("version") != values["native_sdk_version"]:
        raise CandidateError("Android native version does not match release-compatibility.json")
    verify_contract_lock(
        android_source / "contract.lock",
        {
            "contract_version": values["contract_version"],
            "core_commit": values["core_commit"],
            "bundle_sha256": values["contract_bundle_sha256"],
        },
        "Android native",
    )
    package_name = required("LATCHWAY_PACKAGE_NAME", IDENTIFIER)
    app_version = required("LATCHWAY_APP_VERSION", re.compile(r"^[^\s]{1,64}$"))
    version_code = required("LATCHWAY_VERSION_CODE", re.compile(r"^[1-9][0-9]{0,17}$"))
    play_track = required("LATCHWAY_PLAY_TRACK")
    if play_track not in {"internal", "closed", "open", "production"}:
        raise CandidateError("invalid protected Play track")
    if required("LATCHWAY_REQUIRE_LICENSED") != "true":
        raise CandidateError("Play physical candidates require licensed accounts")
    cloud_project_number = required(
        "LATCHWAY_CLOUD_PROJECT_NUMBER", re.compile(r"^[1-9][0-9]{0,18}$")
    )
    play_certificate_pin = required("LATCHWAY_SIGNING_CERTIFICATE_SHA256", SHA256)
    firebase_source = safe_file("LATCHWAY_FIREBASE_ANDROID_CONFIG_PATH")
    firebase = load_android_firebase_configuration(
        firebase_source, package_name, cloud_project_number
    )
    firebase_sha = sha256(firebase_source)
    target_firebase = ROOT / "example/android/app/google-services.json"
    copied_firebase = False
    if target_firebase.exists():
        if target_firebase.is_symlink() or sha256(target_firebase) != firebase_sha:
            raise CandidateError("existing ignored google-services.json differs from the protected input")
    else:
        shutil.copyfile(firebase_source, target_firebase)
        target_firebase.chmod(0o600)
        copied_firebase = True
    configuration = build_configuration(values, firebase, "android")
    env_file = temporary / "android-candidate.env"
    configuration_sha = write_build_environment(env_file, configuration)
    build_env = credential_free_environment(
        {
            "ENVFILE": str(env_file),
            "LATCHWAY_PHYSICAL_CANDIDATE": "1",
            "LATCHWAY_NATIVE_REPOSITORY": str(android_source / "build/publication-test-repository"),
            "LATCHWAY_PUBLICATION_TEST_VERSION": values["native_sdk_version"],
            "LATCHWAY_FIREBASE_CONFIGURATION_SHA256": firebase_sha,
            "LATCHWAY_CANDIDATE_CONFIGURATION_SHA256": configuration_sha,
            "SOURCE_DATE_EPOCH": identities["source"]["commit_timestamp"],
        }
    )
    try:
        publication_env = build_env.copy()
        command(
            [str(android_source / "scripts/verify-local-publication.sh")],
            cwd=android_source,
            env=publication_env,
        )
        command(
            [
                str(ROOT / "android/gradlew"),
                "-p",
                str(ROOT / "example/android"),
                "clean",
                ":app:bundleRelease",
                ":app:assembleRelease",
                "--no-daemon",
                "--no-configuration-cache",
            ],
            env=build_env,
        )
    finally:
        if copied_firebase and target_firebase.exists() and not target_firebase.is_symlink():
            target_firebase.unlink()
    unsigned_aab = ROOT / "example/android/app/build/outputs/bundle/release/app-release.aab"
    unsigned_apk = ROOT / "example/android/app/build/outputs/apk/release/app-release-unsigned.apk"
    require_unsigned_android_artifacts(unsigned_aab, unsigned_apk)
    presign_manifest = staging / "android-aab-presign-payload.manifest"
    command(
        [
            "java",
            str(ROOT / "scripts/VerifyReactNativeAabSignature.java"),
            "--emit-presign-manifest",
            str(unsigned_aab),
            str(presign_manifest),
        ],
        env=credential_free_environment(),
        capture=True,
    )
    actual_package = captured_text(["apkanalyzer", "manifest", "application-id", str(unsigned_apk)])
    actual_version = captured_text(["apkanalyzer", "manifest", "version-name", str(unsigned_apk)])
    actual_code = captured_text(["apkanalyzer", "manifest", "version-code", str(unsigned_apk)])
    if (actual_package, actual_version, actual_code) != (package_name, app_version, version_code):
        raise CandidateError("unsigned Android candidate identity does not match")
    embedded_firebase_sha, embedded_configuration_sha = android_manifest_values(unsigned_apk)
    if embedded_firebase_sha != firebase_sha or embedded_configuration_sha != configuration_sha:
        raise CandidateError("unsigned Android candidate configuration digests do not match")
    with zipfile.ZipFile(unsigned_apk) as archive:
        javascript_name = "assets/index.android.bundle"
        if javascript_name not in archive.namelist():
            raise CandidateError("signed Android candidate is missing the Release JavaScript bundle")
        javascript_payload = archive.read(javascript_name)
    if not javascript_payload:
        raise CandidateError("signed Android JavaScript bundle is empty")
    staged_js = staging / "android-index.android.bundle"
    staged_js.write_bytes(javascript_payload)
    staged_js.chmod(0o600)
    copy_exact(unsigned_aab, staging / "LatchwayExample-release-unsigned.aab")
    copy_exact(unsigned_apk, staging / "LatchwayExample-release-unsigned.apk")
    publication_root = android_source / "build/publication-test-repository/dev/latchway"
    publication_manifest_sha = canonical_tree_manifest(
        publication_root,
        staging / "android-native-publication.sha256",
        "native-publication/dev/latchway",
    )
    identities["native"] = android_identity
    identities["native"]["repository"] = "Latchway/latchway-android"
    identities["native"]["sdk_version"] = values["native_sdk_version"]
    return {
        "platform": "react_native_android_play_integrity",
        "configuration": "Release",
        "debuggable": False,
        "new_architecture": True,
        "hermes": True,
        "application": {
            "signing_mode": "unsigned",
            "package_name": package_name,
            "version": app_version,
            "version_code": version_code,
            "distribution": f"play_{play_track}",
            "play_track": play_track,
            "cloud_project_number": cloud_project_number,
            "require_licensed": True,
            "expected_play_app_signing_certificate_sha256": play_certificate_pin,
            "upload_certificate_sha256": None,
            "aab_sha256": sha256(unsigned_aab),
            "apk_sha256": sha256(unsigned_apk),
            "javascript_bundle_sha256": hashlib.sha256(javascript_payload).hexdigest(),
            "presign_payload_manifest": {
                "file": presign_manifest.name,
                "schema_version": "latchway.react-native-android-aab-presign-payload.v1",
                "sha256": sha256(presign_manifest),
            },
            "aab_verifier_sha256": sha256(
                ROOT / "scripts/VerifyReactNativeAabSignature.java"
            ),
        },
        "dependency_lock": {
            "file": "android-native-publication.sha256",
            "sha256": publication_manifest_sha,
        },
        "firebase_configuration_sha256": firebase_sha,
        "candidate_configuration_sha256": configuration_sha,
    }


def write_sha256sums(directory: pathlib.Path) -> None:
    lines = []
    for path in sorted(directory.iterdir(), key=lambda item: item.name):
        if path.name == "SHA256SUMS" or path.is_dir():
            continue
        if path.is_symlink() or not path.is_file():
            raise CandidateError("candidate staging root contains an unsafe entry")
        lines.append(f"{sha256(path)}  {path.name}\n")
    if not lines:
        raise CandidateError("candidate staging root has no manifest subjects")
    destination = directory / "SHA256SUMS"
    destination.write_text("".join(lines), encoding="utf-8")
    destination.chmod(0o600)


def materialized_source_child() -> bool:
    marker = os.environ.get(MATERIALIZED_SOURCE_ROOT_ENV)
    if marker is None:
        return False
    try:
        marked_root = pathlib.Path(marker).resolve(strict=True)
    except (FileNotFoundError, RuntimeError, OSError) as failure:
        raise CandidateError("materialized candidate source marker is invalid") from failure
    if marked_root != ROOT.resolve():
        raise CandidateError("materialized candidate source marker does not match this source tree")
    return True


def remove_materialized_worktree(
    repository: pathlib.Path,
    worktree: pathlib.Path,
    environment: dict[str, str] | None = None,
) -> bool:
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(repository),
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
                "worktree",
                "remove",
                "--force",
                str(worktree),
            ],
            check=False,
            env=environment or credential_free_environment(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError:
        return False
    return result.returncode == 0


def validate_unpublished_candidate(output: pathlib.Path) -> None:
    """Require the minimum safe closure produced before parent publication."""
    try:
        mode = output.lstat().st_mode
    except FileNotFoundError as failure:
        raise CandidateError("successful candidate producer did not create an output") from failure
    if output.is_symlink() or not stat.S_ISDIR(mode):
        raise CandidateError("successful candidate producer created an unsafe output")
    for name in ("candidate-manifest.json", "source-inputs.json", "SHA256SUMS"):
        path = output / name
        try:
            entry_mode = path.lstat().st_mode
        except FileNotFoundError as failure:
            raise CandidateError("successful candidate output is incomplete") from failure
        if path.is_symlink() or not stat.S_ISREG(entry_mode) or path.stat().st_size <= 0:
            raise CandidateError("successful candidate output is unsafe")


def run_in_materialized_sources(platform: str) -> int:
    """Re-enter the exact producer from fresh sibling RN and JavaScript worktrees."""
    source_commit = required("LATCHWAY_SOURCE_COMMIT", COMMIT)
    supplied_output = pathlib.Path(required("LATCHWAY_CANDIDATE_OUTPUT_DIR")).expanduser()
    try:
        supplied_output.lstat()
    except FileNotFoundError:
        pass
    else:
        raise CandidateError("candidate output directory must be absent before materialization")
    output = supplied_output.resolve()
    if output.exists() or output.is_symlink():
        raise CandidateError("candidate output directory must be absent before materialization")
    repository_identity(ROOT, source_commit, "React Native")
    try:
        compatibility = json.loads(
            (ROOT / "release-compatibility.json").read_text(encoding="utf-8")
        )
    except Exception as failure:
        raise CandidateError("release-compatibility.json is unavailable") from failure
    javascript = compatibility.get("javascript", {}) if isinstance(compatibility, dict) else {}
    javascript_commit = javascript.get("source_commit") if isinstance(javascript, dict) else None
    if not isinstance(javascript_commit, str) or COMMIT.fullmatch(javascript_commit) is None:
        raise CandidateError("release-compatibility.json has no exact JavaScript source commit")
    javascript_source = safe_repository("LATCHWAY_JAVASCRIPT_SDK_PATH")
    repository_identity(javascript_source, javascript_commit, "JavaScript SDK")

    protected_roots = {ROOT.resolve(), javascript_source.resolve(), ROOT.parent.resolve()}
    if (
        output == pathlib.Path.home().resolve()
        or any(output == root or output.is_relative_to(root) for root in protected_roots)
    ):
        raise CandidateError("candidate output directory must be absent and narrowly scoped")
    output.parent.mkdir(parents=True, exist_ok=True)

    cleanup_failed = False
    result: subprocess.CompletedProcess[bytes] | None = None
    unpublished_container = pathlib.Path(
        tempfile.mkdtemp(
            prefix=f".{output.name}.unpublished-",
            dir=output.parent,
        )
    )
    unpublished_output = unpublished_container / "candidate"
    container = pathlib.Path(tempfile.mkdtemp(prefix="latchway-rn-materialized-sources."))
    try:
        react_native_worktree = container / "latchway-react-native-sdk"
        javascript_worktree = container / "latchway-js"
        credential_home = container / "credential-free-home"
        credential_home.mkdir(mode=0o700)
        source_environment = credential_free_environment(
            {
                "HOME": str(credential_home),
                "COREPACK_HOME": str(credential_home / "corepack"),
                "CP_HOME_DIR": str(credential_home / "cocoapods"),
                "GRADLE_USER_HOME": str(credential_home / "gradle"),
            }
        )
        worktrees: list[tuple[pathlib.Path, pathlib.Path]] = []
        try:
            worktrees.append((ROOT, react_native_worktree))
            command(
                [
                    "git",
                    "-C",
                    str(ROOT),
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "core.fsmonitor=false",
                    "worktree",
                    "add",
                    "--detach",
                    str(react_native_worktree),
                    source_commit,
                ],
                capture=True,
                env=source_environment,
            )
            worktrees.append((javascript_source, javascript_worktree))
            command(
                [
                    "git",
                    "-C",
                    str(javascript_source),
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "core.fsmonitor=false",
                    "worktree",
                    "add",
                    "--detach",
                    str(javascript_worktree),
                    javascript_commit,
                ],
                capture=True,
                env=source_environment,
            )
            repository_identity(react_native_worktree, source_commit, "materialized React Native")
            repository_identity(javascript_worktree, javascript_commit, "materialized JavaScript SDK")
            child_environment = source_environment.copy()
            child_environment[MATERIALIZED_SOURCE_ROOT_ENV] = str(
                react_native_worktree.resolve()
            )
            child_environment[ORIGINAL_SOURCE_ROOT_ENV] = str(ROOT.resolve())
            child_environment[ORIGINAL_JAVASCRIPT_ROOT_ENV] = str(
                javascript_source.resolve()
            )
            child_environment["LATCHWAY_JAVASCRIPT_SDK_PATH"] = str(
                javascript_worktree.resolve()
            )
            child_environment["LATCHWAY_CANDIDATE_OUTPUT_DIR"] = str(unpublished_output)
            result = subprocess.run(
                [
                    sys.executable,
                    str(
                        react_native_worktree
                        / "scripts/stage-physical-react-native-candidate.py"
                    ),
                    platform,
                ],
                cwd=react_native_worktree,
                env=child_environment,
                check=False,
            )
        finally:
            for repository, worktree in reversed(worktrees):
                try:
                    removed = remove_materialized_worktree(
                        repository,
                        worktree,
                        source_environment,
                    )
                except Exception:
                    removed = False
                cleanup_failed = not removed or cleanup_failed
            if not cleanup_failed:
                try:
                    shutil.rmtree(container)
                except OSError:
                    cleanup_failed = True

        if cleanup_failed:
            raise CandidateError("failed to remove a materialized candidate source worktree")
        if result is None:
            raise CandidateError("materialized candidate producer did not run")
        if result.returncode != 0:
            return result.returncode
        validate_unpublished_candidate(unpublished_output)
        if output.exists() or output.is_symlink():
            raise CandidateError("candidate output appeared before parent publication")
        os.replace(unpublished_output, output)
        return 0
    finally:
        shutil.rmtree(unpublished_container, ignore_errors=True)


def main(arguments: list[str]) -> int:
    if len(arguments) != 2 or arguments[1] not in {"ios", "android"}:
        print(f"usage: {pathlib.Path(arguments[0]).name} ios|android", file=sys.stderr)
        return 2
    platform = arguments[1]
    try:
        if platform == "android" and any(os.environ.get(name) for name in ANDROID_SIGNING_INPUTS):
            raise CandidateError(
                "signing material is prohibited on the unsigned Android candidate producer"
            )
        if not materialized_source_child():
            return run_in_materialized_sources(platform)
        values, compatibility, native_evidence, identities, javascript_source = common_inputs()
        output = candidate_output_path(javascript_source)
        output_parent = output.parent.resolve()
        output_parent.mkdir(parents=True, exist_ok=True)
        node_version = verify_node_toolchain()
        pnpm = pinned_pnpm_command()
        pnpm_version = captured_text([*pnpm, "--version"])
        javascript_pnpm = pinned_pnpm_command(javascript_source)
        javascript_pnpm_version = captured_text(
            [*javascript_pnpm, "--version"],
            cwd=javascript_source,
        )
        if javascript_pnpm_version != pnpm_version:
            raise CandidateError("React Native and JavaScript SDK pnpm versions do not match")
        for tool in (
            ["git", "shasum"]
            + (["pod", "xcodebuild", "codesign", "openssl"] if platform == "ios" else [
                "java", "apksigner", "apkanalyzer"
            ])
        ):
            if shutil.which(tool) is None:
                raise CandidateError(f"required candidate tool is unavailable: {tool}")
        install_env = credential_free_environment()
        require_pristine_candidate_inputs(ROOT, javascript_source, platform)
        command(
            [*javascript_pnpm, "install", "--frozen-lockfile"],
            cwd=javascript_source,
            env=install_env,
        )
        command([*javascript_pnpm, "build"], cwd=javascript_source, env=install_env)
        command([*pnpm, "install", "--frozen-lockfile"], env=install_env)
        verify_javascript_dependency_link(javascript_source)
        command([*pnpm, "example:check"], env=install_env)
        if platform == "ios":
            require_pristine_ios_native_inputs(ROOT)
        with tempfile.TemporaryDirectory(prefix="latchway-rn-candidate-build.") as temporary_name:
            temporary = pathlib.Path(temporary_name)
            staging = pathlib.Path(
                tempfile.mkdtemp(prefix=".latchway-rn-candidate-stage.", dir=output_parent)
            )
            staging.chmod(0o700)
            try:
                candidate = (
                    stage_ios(values, compatibility, identities, temporary, staging)
                    if platform == "ios"
                    else stage_android(values, compatibility, identities, temporary, staging)
                )
                source_inputs = {
                    "schema_version": "latchway.react-native-physical-source-inputs.v1",
                    "repository": "Latchway/latchway-react-native-sdk",
                    "source": identities["source"],
                    "javascript": identities["javascript"],
                    "native": identities["native"],
                    "core": identities["core"],
                    "contract": {
                        "version": values["contract_version"],
                        "bundle_sha256": values["contract_bundle_sha256"],
                    },
                    "locks": {
                        "pnpm_lock_sha256": sha256(ROOT / "pnpm-lock.yaml"),
                        "javascript_pnpm_lock_sha256": sha256(
                            javascript_source / "pnpm-lock.yaml"
                        ),
                        "release_compatibility_sha256": sha256(ROOT / "release-compatibility.json"),
                        "contract_lock_sha256": sha256(ROOT / "contract.lock"),
                    },
                    "toolchain": {
                        "node": node_version,
                        "pnpm": pnpm_version,
                    },
                }
                manifest = {
                    "schema_version": "latchway.react-native-physical-candidate.v1",
                    "repository": "Latchway/latchway-react-native-sdk",
                    "source": source_inputs,
                    "candidate": candidate,
                    "identity": {
                        "provider": "firebase",
                        "bootstrap": "run-bound-one-use-firebase-custom-token",
                        "custom_token_in_candidate": False,
                        "preexisting_firebase_user_allowed": False,
                    },
                    "native_evidence": {
                        "sha256": values["native_evidence_sha256"],
                        "source_file_name": native_evidence.name,
                    },
                    "gateway": {
                        "origin": values["gateway_origin"],
                        "image_digest": values["gateway_image_digest"],
                        "configuration_sha256": values["gateway_configuration_sha256"],
                        "deployment_key_id": values["gateway_deployment_key_id"],
                        "deployment_statement_sha256": values[
                            "gateway_deployment_statement_sha256"
                        ],
                        "deployment_public_key_sha256": values[
                            "gateway_deployment_public_key_sha256"
                        ],
                    },
                }
                write_canonical_json(staging / "source-inputs.json", source_inputs)
                write_canonical_json(staging / "candidate-manifest.json", manifest)
                write_sha256sums(staging)
                if repository_identity(ROOT, values["source_commit"], "React Native") != identities["source"]:
                    raise CandidateError("React Native source changed while the candidate was built")
                javascript_commit = compatibility["javascript"]["source_commit"]
                javascript_identity = repository_identity(
                    javascript_source,
                    javascript_commit,
                    "JavaScript SDK",
                )
                if any(
                    javascript_identity.get(key) != identities["javascript"].get(key)
                    for key in ("commit", "tree", "commit_timestamp")
                ):
                    raise CandidateError("JavaScript SDK source changed while the candidate was built")
                os.replace(staging, output)
            except Exception:
                shutil.rmtree(staging, ignore_errors=True)
                raise
        print(f"physical React Native {platform} candidate staged: {output}")
        return 0
    except CandidateError as failure:
        print(str(failure), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
