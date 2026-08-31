from __future__ import annotations

import importlib.util
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
VALIDATOR_PATH = ROOT / "scripts/validate-development-react-native-ios-env.py"
SPEC = importlib.util.spec_from_file_location("development_ios_environment", VALIDATOR_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("development iOS environment validator cannot be loaded")
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)

PREFIX = "ABCDE12345"
BUNDLE = "dev.latchway"
ROOT_GROUP = f"{PREFIX}.{BUNDLE}"
SHARED_GROUP = f"{ROOT_GROUP}.keychain"


def valid_values() -> dict[str, str]:
    return {
        "LATCHWAY_BASE_URL": "https://gateway.example.test",
        "LATCHWAY_APPLICATION_ID": "app_01J00000000000000000000000",
        "LATCHWAY_APPINTENT_COMPONENT_DEFINITION_ID": "app_intent",
        "LATCHWAY_PACKAGE_OR_BUNDLE_IDENTIFIER": BUNDLE,
        "LATCHWAY_ENVIRONMENT": "development",
        "LATCHWAY_FEATURE": "assistant_responses",
        "LATCHWAY_OPENAI_CHAT_FEATURE": "assistant_chat",
        "LATCHWAY_OPENAI_EMBEDDINGS_FEATURE": "assistant_embeddings",
        "LATCHWAY_ANTHROPIC_MESSAGES_FEATURE": "assistant_anthropic",
        "LATCHWAY_ERROR_MAPPING_FEATURE": "conformance_ungranted_feature",
        "LATCHWAY_MODEL": "assistant-default",
        "LATCHWAY_GOOGLE_CLOUD_PROJECT_NUMBER": "123456789012",
        "LATCHWAY_CONFORMANCE_AUTORUN": "false",
        "LATCHWAY_DEVELOPMENT_DEVICE_BOOTSTRAP": "true",
        "LATCHWAY_IOS_ROOT_KEYCHAIN_ACCESS_GROUP": ROOT_GROUP,
        "LATCHWAY_IOS_LEGACY_SHARED_KEYCHAIN_ACCESS_GROUPS": SHARED_GROUP,
    }


class DevelopmentReactNativeIOSEnvironmentTests(unittest.TestCase):
    def test_accepts_only_the_complete_development_coordinates(self) -> None:
        VALIDATOR.validate_environment(valid_values(), BUNDLE, PREFIX, SHARED_GROUP)
        values = valid_values()
        for name in (
            "LATCHWAY_OPENAI_CHAT_FEATURE",
            "LATCHWAY_OPENAI_EMBEDDINGS_FEATURE",
            "LATCHWAY_ANTHROPIC_MESSAGES_FEATURE",
            "LATCHWAY_GOOGLE_CLOUD_PROJECT_NUMBER",
        ):
            values.pop(name)
        VALIDATOR.validate_environment(values, BUNDLE, PREFIX, SHARED_GROUP)

    def test_loader_rejects_unknown_provider_and_ambient_credential_names(self) -> None:
        for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                path = pathlib.Path(temporary) / ".env"
                lines = [f"{key}={value}" for key, value in valid_values().items()]
                path.write_text("\n".join([*lines, f"{name}=credential"]), encoding="utf-8")
                with self.assertRaisesRegex(VALIDATOR.InvalidEnvironment, "not allowlisted"):
                    VALIDATOR.load_environment(path)

    def test_loader_rejects_duplicates_missing_names_and_empty_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / ".env"
            values = valid_values()
            lines = [f"{key}={value}" for key, value in values.items()]
            path.write_text("\n".join([*lines, lines[0]]), encoding="utf-8")
            with self.assertRaisesRegex(VALIDATOR.InvalidEnvironment, "invalid name"):
                VALIDATOR.load_environment(path)

            path.write_text("\n".join(lines[1:]), encoding="utf-8")
            with self.assertRaisesRegex(VALIDATOR.InvalidEnvironment, "missing required"):
                VALIDATOR.load_environment(path)

            path.write_text("\n".join([*lines[1:], "LATCHWAY_BASE_URL="]), encoding="utf-8")
            with self.assertRaisesRegex(VALIDATOR.InvalidEnvironment, "invalid value"):
                VALIDATOR.load_environment(path)

    def test_rejects_production_or_malformed_gateway_coordinates(self) -> None:
        mutations = (
            ("LATCHWAY_ENVIRONMENT", "production", "must be development"),
            ("LATCHWAY_BASE_URL", "http://gateway.example.test", "HTTPS origin"),
            ("LATCHWAY_BASE_URL", "https://user@gateway.example.test", "HTTPS origin"),
            ("LATCHWAY_BASE_URL", "https://gateway.example.test/path", "HTTPS origin"),
            ("LATCHWAY_APPLICATION_ID", "dev.latchway", "resource ID"),
            ("LATCHWAY_PACKAGE_OR_BUNDLE_IDENTIFIER", "dev.other", "bundle identifier mismatch"),
            ("LATCHWAY_CONFORMANCE_AUTORUN", "true", "disable protected"),
            ("LATCHWAY_DEVELOPMENT_DEVICE_BOOTSTRAP", "false", "opt into"),
        )
        for name, value, message in mutations:
            with self.subTest(name=name, value=value):
                candidate = valid_values()
                candidate[name] = value
                with self.assertRaisesRegex(VALIDATOR.InvalidEnvironment, message):
                    VALIDATOR.validate_environment(candidate, BUNDLE, PREFIX, SHARED_GROUP)

    def test_rejects_keychain_mismatches_and_invalid_prefixes(self) -> None:
        candidate = valid_values()
        candidate["LATCHWAY_IOS_ROOT_KEYCHAIN_ACCESS_GROUP"] = f"{PREFIX}.dev.other"
        with self.assertRaisesRegex(VALIDATOR.InvalidEnvironment, "root Keychain"):
            VALIDATOR.validate_environment(candidate, BUNDLE, PREFIX, SHARED_GROUP)

        candidate = valid_values()
        candidate["LATCHWAY_IOS_LEGACY_SHARED_KEYCHAIN_ACCESS_GROUPS"] = ROOT_GROUP
        with self.assertRaisesRegex(VALIDATOR.InvalidEnvironment, "legacy shared"):
            VALIDATOR.validate_environment(candidate, BUNDLE, PREFIX, SHARED_GROUP)

        with self.assertRaisesRegex(VALIDATOR.InvalidEnvironment, "App ID Prefix"):
            VALIDATOR.validate_environment(valid_values(), BUNDLE, "short", SHARED_GROUP)
        with self.assertRaisesRegex(VALIDATOR.InvalidEnvironment, "shared Keychain"):
            VALIDATOR.validate_environment(valid_values(), BUNDLE, PREFIX, ROOT_GROUP)

    def test_rejects_invalid_or_colliding_protocol_features(self) -> None:
        candidate = valid_values()
        candidate["LATCHWAY_OPENAI_CHAT_FEATURE"] = candidate["LATCHWAY_FEATURE"]
        with self.assertRaisesRegex(VALIDATOR.InvalidEnvironment, "must be distinct"):
            VALIDATOR.validate_environment(candidate, BUNDLE, PREFIX, SHARED_GROUP)

        candidate = valid_values()
        candidate["LATCHWAY_FEATURE"] = "Responses"
        with self.assertRaisesRegex(VALIDATOR.InvalidEnvironment, "feature identifier"):
            VALIDATOR.validate_environment(candidate, BUNDLE, PREFIX, SHARED_GROUP)

        candidate = valid_values()
        candidate["LATCHWAY_APPINTENT_COMPONENT_DEFINITION_ID"] = "AppIntent"
        with self.assertRaisesRegex(VALIDATOR.InvalidEnvironment, "component definition"):
            VALIDATOR.validate_environment(candidate, BUNDLE, PREFIX, SHARED_GROUP)


if __name__ == "__main__":
    unittest.main()
