#!/usr/bin/env python3
"""Validate the exact non-secret environment embedded by the Debug iOS host."""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
from urllib.parse import urlsplit


IDENTIFIER = re.compile(r"^[a-z][a-z0-9_-]{0,62}$")
APPLICATION_ID = re.compile(r"^app_[0-7][0-9A-HJKMNP-TV-Z]{25}$")
APP_ID_PREFIX = re.compile(r"^[A-Z0-9]{10}$")
PROJECT_NUMBER = re.compile(r"^[1-9][0-9]{5,18}$")

REQUIRED_NAMES = frozenset({
    "LATCHWAY_APPLICATION_ID",
    "LATCHWAY_BASE_URL",
    "LATCHWAY_CONFORMANCE_AUTORUN",
    "LATCHWAY_DEVELOPMENT_DEVICE_BOOTSTRAP",
    "LATCHWAY_ENVIRONMENT",
    "LATCHWAY_ERROR_MAPPING_FEATURE",
    "LATCHWAY_FEATURE",
    "LATCHWAY_IOS_LEGACY_SHARED_KEYCHAIN_ACCESS_GROUPS",
    "LATCHWAY_IOS_ROOT_KEYCHAIN_ACCESS_GROUP",
    "LATCHWAY_MODEL",
    "LATCHWAY_PACKAGE_OR_BUNDLE_IDENTIFIER",
})
OPTIONAL_NAMES = frozenset({
    "LATCHWAY_ANTHROPIC_MESSAGES_FEATURE",
    "LATCHWAY_GOOGLE_CLOUD_PROJECT_NUMBER",
    "LATCHWAY_OPENAI_CHAT_FEATURE",
    "LATCHWAY_OPENAI_EMBEDDINGS_FEATURE",
})
ALLOWED_NAMES = REQUIRED_NAMES | OPTIONAL_NAMES


class InvalidEnvironment(ValueError):
    pass


def load_environment(path: pathlib.Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as failure:
        raise InvalidEnvironment("development environment is unreadable") from failure
    for number, raw_line in enumerate(lines, 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise InvalidEnvironment(f"development environment has an invalid entry on line {number}")
        name, value = line.split("=", 1)
        if re.fullmatch(r"[A-Z][A-Z0-9_]*", name) is None or name in values:
            raise InvalidEnvironment(f"development environment has an invalid name on line {number}")
        if name not in ALLOWED_NAMES:
            raise InvalidEnvironment(f"development environment name is not allowlisted: {name}")
        if not value or value != value.strip() or any(ord(character) < 32 for character in value):
            raise InvalidEnvironment(f"development environment has an invalid value on line {number}")
        values[name] = value
    missing = sorted(REQUIRED_NAMES - values.keys())
    if missing:
        raise InvalidEnvironment(f"development environment is missing required names: {', '.join(missing)}")
    return values


def validate_environment(
    values: dict[str, str],
    bundle_identifier: str,
    app_id_prefix: str,
    shared_keychain_access_group: str,
) -> None:
    if bundle_identifier != "dev.latchway":
        raise InvalidEnvironment("development bundle identifier must be dev.latchway")
    if APP_ID_PREFIX.fullmatch(app_id_prefix) is None:
        raise InvalidEnvironment("development App ID Prefix is invalid")
    expected_root_group = f"{app_id_prefix}.{bundle_identifier}"
    expected_shared_group = f"{expected_root_group}.keychain"
    if shared_keychain_access_group != expected_shared_group:
        raise InvalidEnvironment("development shared Keychain access group is invalid")

    try:
        origin = urlsplit(values["LATCHWAY_BASE_URL"])
        port = origin.port
    except ValueError as failure:
        raise InvalidEnvironment("development gateway origin is invalid") from failure
    if (
        origin.scheme != "https"
        or not origin.hostname
        or origin.username is not None
        or origin.password is not None
        or origin.path not in {"", "/"}
        or origin.query
        or origin.fragment
        or port is not None and not 1 <= port <= 65535
    ):
        raise InvalidEnvironment("development gateway must be an HTTPS origin")
    if APPLICATION_ID.fullmatch(values["LATCHWAY_APPLICATION_ID"]) is None:
        raise InvalidEnvironment("development application resource ID is invalid")
    if values["LATCHWAY_PACKAGE_OR_BUNDLE_IDENTIFIER"] != bundle_identifier:
        raise InvalidEnvironment("development environment bundle identifier mismatch")
    if values["LATCHWAY_ENVIRONMENT"] != "development":
        raise InvalidEnvironment("development gateway environment must be development")
    if values["LATCHWAY_CONFORMANCE_AUTORUN"] != "false":
        raise InvalidEnvironment("development environment must disable protected conformance autorun")
    if values["LATCHWAY_DEVELOPMENT_DEVICE_BOOTSTRAP"] != "true":
        raise InvalidEnvironment("development environment must opt into the Debug device bootstrap")
    if values["LATCHWAY_IOS_ROOT_KEYCHAIN_ACCESS_GROUP"] != expected_root_group:
        raise InvalidEnvironment("development root Keychain access group mismatch")
    if values["LATCHWAY_IOS_LEGACY_SHARED_KEYCHAIN_ACCESS_GROUPS"] != expected_shared_group:
        raise InvalidEnvironment("development legacy shared Keychain access groups mismatch")

    feature_names = (
        "LATCHWAY_FEATURE",
        "LATCHWAY_ERROR_MAPPING_FEATURE",
        "LATCHWAY_OPENAI_CHAT_FEATURE",
        "LATCHWAY_OPENAI_EMBEDDINGS_FEATURE",
        "LATCHWAY_ANTHROPIC_MESSAGES_FEATURE",
    )
    configured_features: list[str] = []
    for name in feature_names:
        value = values.get(name)
        if value is not None:
            if IDENTIFIER.fullmatch(value) is None:
                raise InvalidEnvironment(f"development feature identifier is invalid: {name}")
            configured_features.append(value)
    if len(configured_features) != len(set(configured_features)):
        raise InvalidEnvironment("development feature identifiers must be distinct")
    if IDENTIFIER.fullmatch(values["LATCHWAY_MODEL"]) is None:
        raise InvalidEnvironment("development model identifier is invalid")

    project_number = values.get("LATCHWAY_GOOGLE_CLOUD_PROJECT_NUMBER")
    if project_number is not None and (
        PROJECT_NUMBER.fullmatch(project_number) is None
        or int(project_number) > 9_223_372_036_854_775_807
    ):
        raise InvalidEnvironment("development Google Cloud project number is invalid")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("environment_file", type=pathlib.Path)
    parser.add_argument("bundle_identifier")
    parser.add_argument("app_id_prefix")
    parser.add_argument("shared_keychain_access_group")
    arguments = parser.parse_args()
    try:
        validate_environment(
            load_environment(arguments.environment_file),
            arguments.bundle_identifier,
            arguments.app_id_prefix,
            arguments.shared_keychain_access_group,
        )
    except InvalidEnvironment as failure:
        print(str(failure), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
