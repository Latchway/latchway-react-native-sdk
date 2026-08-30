#!/usr/bin/env python3
"""Test the fail-closed physical candidate producer and build hooks."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import pathlib
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import tempfile
import textwrap
import unittest
import zipfile
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
PRODUCER_PATH = ROOT / "scripts/stage-physical-react-native-candidate.py"
VERIFIER_PATH = ROOT / "scripts/VerifyReactNativeAabSignature.java"
TREE_PATH = ROOT / "scripts/physical_app_bundle_tree.py"
SPEC = importlib.util.spec_from_file_location("physical_candidate_producer", PRODUCER_PATH)
assert SPEC is not None and SPEC.loader is not None
PRODUCER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PRODUCER)
TREE_SPEC = importlib.util.spec_from_file_location("physical_app_bundle_tree", TREE_PATH)
assert TREE_SPEC is not None and TREE_SPEC.loader is not None
TREE = importlib.util.module_from_spec(TREE_SPEC)
import sys
sys.modules[TREE_SPEC.name] = TREE
TREE_SPEC.loader.exec_module(TREE)


class NonSeekableZipOutput:
    """Force data descriptors so local/central validation covers Gradle-style ZIPs."""

    def __init__(self, target: pathlib.Path) -> None:
        self.handle = target.open("wb")

    def write(self, value: bytes) -> int:
        return self.handle.write(value)

    def tell(self) -> int:
        return self.handle.tell()

    def seek(self, *_arguments: object) -> int:
        raise OSError("intentionally non-seekable")

    def flush(self) -> None:
        self.handle.flush()

    def close(self) -> None:
        self.handle.close()


class PhysicalCandidateProducerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = PRODUCER_PATH.read_text(encoding="utf-8")
        cls.gradle = (ROOT / "example/android/app/build.gradle").read_text(encoding="utf-8")
        cls.manifest = (ROOT / "example/android/app/src/main/AndroidManifest.xml").read_text(
            encoding="utf-8"
        )
        cls.project = (
            ROOT / "example/ios/LatchwayExample.xcodeproj/project.pbxproj"
        ).read_text(encoding="utf-8")
        cls.copy_ios = (
            ROOT / "scripts/copy-protected-firebase-ios-config.sh"
        ).read_text(encoding="utf-8")
        cls.verifier = VERIFIER_PATH.read_text(encoding="utf-8")
        cls.android_workflow = (
            ROOT / ".github/workflows/react-native-android-candidate.yml"
        ).read_text(encoding="utf-8")

    def test_ios_firebase_configuration_is_exact_bundle_bound(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "GoogleService-Info.plist"
            path.write_bytes(
                plistlib.dumps(
                    {
                        "BUNDLE_ID": "dev.latchway",
                        "API_KEY": "A" * 32,
                        "GOOGLE_APP_ID": "1:123456789:ios:abcdef",
                        "PROJECT_ID": "latchway-test",
                    }
                )
            )
            value = PRODUCER.load_ios_firebase_configuration(path, "dev.latchway")
            self.assertEqual(value["project_id"], "latchway-test")
            with self.assertRaises(PRODUCER.CandidateError):
                PRODUCER.load_ios_firebase_configuration(path, "dev.other")

    def test_ios_application_tree_is_deterministic_and_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary) / "LatchwayExample.app"
            (root / "Frameworks").mkdir(parents=True)
            (root / "Info.plist").write_bytes(b"bounded plist")
            (root / "Frameworks/Library").write_bytes(b"bounded library")
            first = TREE.app_bundle_tree_digest(root)
            second = TREE.app_bundle_tree_digest(root)
            self.assertEqual(first, second)
            first_manifest = pathlib.Path(temporary) / "first-files.sha256"
            second_manifest = pathlib.Path(temporary) / "second-files.sha256"
            first_manifest_sha = TREE.write_app_files_manifest(root, first_manifest)
            second_manifest_sha = TREE.write_app_files_manifest(root, second_manifest)
            self.assertEqual(first_manifest_sha, second_manifest_sha)
            self.assertEqual(first_manifest.read_bytes(), second_manifest.read_bytes())
            self.assertIn(b"LatchwayExample.app/Info.plist", first_manifest.read_bytes())
            (root / "Frameworks/Library").write_bytes(b"changed library")
            self.assertNotEqual(first.sha256, TREE.app_bundle_tree_digest(root).sha256)
            changed_manifest = pathlib.Path(temporary) / "changed-files.sha256"
            self.assertNotEqual(
                first_manifest_sha,
                TREE.write_app_files_manifest(root, changed_manifest),
            )
            (root / "unsafe").symlink_to(root / "Info.plist")
            with self.assertRaises(TREE.BundleTreeError):
                TREE.app_bundle_tree_digest(root)
            with self.assertRaises(TREE.BundleTreeError):
                TREE.write_app_files_manifest(
                    root,
                    pathlib.Path(temporary) / "unsafe-files.sha256",
                )

    def test_ios_application_tree_rejects_descriptor_swap_races(self) -> None:
        for replacement_kind in ("symlink", "directory"):
            with self.subTest(replacement=replacement_kind), tempfile.TemporaryDirectory() as temporary:
                bundle = pathlib.Path(temporary) / "Candidate.app"
                inner = bundle / "Outer" / "Inner"
                inner.mkdir(parents=True)
                (inner / "payload").write_bytes(b"payload")
                moved = inner.with_name("Inner-original")
                original_open = TREE._open_directory_at
                changed = False

                def swapping_open(parent_descriptor, name, expected):
                    nonlocal changed
                    if parent_descriptor is not None and name == "Inner" and not changed:
                        changed = True
                        inner.rename(moved)
                        if replacement_kind == "symlink":
                            inner.symlink_to(moved.name, target_is_directory=True)
                        else:
                            inner.mkdir()
                    return original_open(parent_descriptor, name, expected)

                with mock.patch.object(TREE, "_open_directory_at", side_effect=swapping_open):
                    with self.assertRaises(TREE.BundleTreeError):
                        TREE.inspect_app_bundle(bundle)
                self.assertTrue(changed)

    def test_ios_tree_and_manifest_reject_mutation_between_complete_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            bundle = pathlib.Path(temporary) / "Candidate.app"
            bundle.mkdir()
            payload = bundle / "payload"
            payload.write_bytes(b"before")
            original_digest = TREE._regular_file_digest
            changed = False

            def mutate_after_digest(directory_descriptor, name, expected):
                nonlocal changed
                result = original_digest(directory_descriptor, name, expected)
                if not changed:
                    changed = True
                    payload.write_bytes(b"after")
                return result

            with mock.patch.object(
                TREE,
                "_regular_file_digest",
                side_effect=mutate_after_digest,
            ):
                with self.assertRaises(TREE.BundleTreeError):
                    TREE.inspect_app_bundle(bundle)
            self.assertTrue(changed)

    def test_ios_tree_and_file_manifest_share_one_stable_inspection(self) -> None:
        source = TREE_PATH.read_text(encoding="utf-8")
        self.assertIn("result = inspect_app_bundle(arguments.application_bundle)", source)
        self.assertIn("result.app_files_manifest", source)
        self.assertNotIn("os.walk(", source)
        for marker in ("O_DIRECTORY", "O_NOFOLLOW", "dir_fd=", "_stable_identity"):
            self.assertIn(marker, source)

    def test_android_firebase_configuration_is_package_and_project_bound(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "google-services.json"
            path.write_text(
                json.dumps(
                    {
                        "project_info": {
                            "project_number": "123456789012",
                            "project_id": "latchway-test",
                        },
                        "client": [
                            {
                                "client_info": {
                                    "mobilesdk_app_id": "1:123456789012:android:abcdef",
                                    "android_client_info": {"package_name": "dev.latchway"},
                                },
                                "api_key": [{"current_key": "A" * 32}],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            value = PRODUCER.load_android_firebase_configuration(
                path, "dev.latchway", "123456789012"
            )
            self.assertEqual(value["app_id"], "1:123456789012:android:abcdef")
            with self.assertRaises(PRODUCER.CandidateError):
                PRODUCER.load_android_firebase_configuration(
                    path, "dev.latchway", "999999999999"
                )

    def test_producer_binds_clean_source_native_core_contract_and_release_outputs(self) -> None:
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        self.assertIn(
            f"NODE_VERSION: {PRODUCER.PINNED_NODE_VERSION}",
            ci,
        )
        self.assertIn(
            "LATCHWAY_JAVASCRIPT_SDK_PATH: ${{ vars.LATCHWAY_JAVASCRIPT_SDK_PATH }}",
            self.android_workflow,
        )
        for marker in (
            "candidate production requires a clean source worktree",
            'verify_contract_lock(ROOT / "contract.lock"',
            'safe_repository("LATCHWAY_CORE_SOURCE_PATH")',
            'safe_repository("LATCHWAY_IOS_SDK_PATH")',
            'safe_repository("LATCHWAY_ANDROID_SDK_PATH")',
            "pinned_pnpm_command()",
            "verify_node_toolchain()",
            '"install", "--frozen-lockfile"',
            '"Release"',
            '"debuggable": False',
            '"new_architecture": True',
            '"hermes": True',
            '"candidate-manifest.json"',
            '"source-inputs.json"',
            '"SHA256SUMS"',
            '"javascript_bundle_sha256"',
            '"app_files_manifest_sha256"',
            '"application_bundle_tree_sha256"',
            '"native_evidence_sha256"',
            'safe_repository("LATCHWAY_JAVASCRIPT_SDK_PATH")',
            '"javascript": identities["javascript"]',
            '"javascript_pnpm_lock_sha256"',
            "run_in_materialized_sources(platform)",
            "verify_javascript_dependency_link(javascript_source)",
        ):
            self.assertIn(marker, self.source)

    def test_materialized_launcher_ignores_poisoned_original_generated_trees(self) -> None:
        source_commit = "a" * 40
        javascript_commit = "b" * 40
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            sources = root / "sources"
            react_native = sources / "original-react-native"
            javascript = sources / "original-javascript"
            sources.mkdir()
            react_native.mkdir()
            javascript.mkdir()
            (react_native / ".git").mkdir()
            (javascript / ".git").mkdir()
            (react_native / "node_modules/poison").mkdir(parents=True)
            (react_native / "example/ios/Pods/Poison").mkdir(parents=True)
            (react_native / "example/ios/.xcode.env.local").write_text(
                "NODE_BINARY=/tmp/poison\n",
                encoding="utf-8",
            )
            (javascript / "dist").mkdir()
            (javascript / "dist/index.js").write_text("poison", encoding="utf-8")
            (react_native / "release-compatibility.json").write_text(
                json.dumps({"javascript": {"source_commit": javascript_commit}}),
                encoding="utf-8",
            )
            added: list[list[str]] = []

            def fake_command(arguments, **_kwargs):
                if "worktree" in arguments and "add" in arguments:
                    destination = pathlib.Path(arguments[-2])
                    destination.mkdir(parents=True)
                    added.append(arguments)
                return b""

            def fake_child(*_arguments, **kwargs):
                produced = pathlib.Path(kwargs["env"]["LATCHWAY_CANDIDATE_OUTPUT_DIR"])
                produced.mkdir()
                for name in ("candidate-manifest.json", "source-inputs.json", "SHA256SUMS"):
                    (produced / name).write_text("valid\n", encoding="utf-8")
                return subprocess.CompletedProcess(["python3"], 0)

            environment = {
                "LATCHWAY_SOURCE_COMMIT": source_commit,
                "LATCHWAY_JAVASCRIPT_SDK_PATH": str(javascript),
                "LATCHWAY_CANDIDATE_OUTPUT_DIR": str(root / "candidate-output"),
            }
            with (
                mock.patch.object(PRODUCER, "ROOT", react_native),
                mock.patch.object(PRODUCER, "command", side_effect=fake_command),
                mock.patch.object(
                    PRODUCER,
                    "repository_identity",
                    return_value={
                        "commit": source_commit,
                        "tree": "c" * 40,
                        "commit_timestamp": "1",
                    },
                ),
                mock.patch.object(PRODUCER, "remove_materialized_worktree", return_value=True),
                mock.patch.object(PRODUCER.subprocess, "run", side_effect=fake_child) as run,
                mock.patch.dict(os.environ, environment, clear=False),
            ):
                self.assertEqual(PRODUCER.run_in_materialized_sources("ios"), 0)
            self.assertEqual(len(added), 2)
            react_native_fresh = pathlib.Path(added[0][-2])
            javascript_fresh = pathlib.Path(added[1][-2])
            self.assertEqual(react_native_fresh.parent, javascript_fresh.parent)
            self.assertEqual(react_native_fresh.name, "latchway-react-native-sdk")
            self.assertEqual(javascript_fresh.name, "latchway-js")
            child = run.call_args
            self.assertEqual(pathlib.Path(child.kwargs["cwd"]).name, "latchway-react-native-sdk")
            self.assertEqual(
                pathlib.Path(child.kwargs["env"]["LATCHWAY_JAVASCRIPT_SDK_PATH"]).name,
                "latchway-js",
            )

    def test_materialized_cleanup_failure_never_publishes_completed_output(self) -> None:
        source_commit = "a" * 40
        javascript_commit = "b" * 40
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            sources = root / "sources"
            react_native = sources / "original-react-native"
            javascript = sources / "original-javascript"
            output = root / "candidate-output"
            sources.mkdir()
            react_native.mkdir()
            javascript.mkdir()
            (react_native / ".git").mkdir()
            (javascript / ".git").mkdir()
            (react_native / "release-compatibility.json").write_text(
                json.dumps({"javascript": {"source_commit": javascript_commit}}),
                encoding="utf-8",
            )

            def fake_command(arguments, **_kwargs):
                if "worktree" in arguments and "add" in arguments:
                    pathlib.Path(arguments[-2]).mkdir(parents=True)
                return b""

            def fake_child(*_arguments, **_kwargs):
                produced = pathlib.Path(_kwargs["env"]["LATCHWAY_CANDIDATE_OUTPUT_DIR"])
                produced.mkdir()
                for name in ("candidate-manifest.json", "source-inputs.json", "SHA256SUMS"):
                    (produced / name).write_text("valid\n", encoding="utf-8")
                return subprocess.CompletedProcess(["python3"], 0)

            environment = {
                "LATCHWAY_SOURCE_COMMIT": source_commit,
                "LATCHWAY_JAVASCRIPT_SDK_PATH": str(javascript),
                "LATCHWAY_CANDIDATE_OUTPUT_DIR": str(output),
            }
            with (
                mock.patch.object(PRODUCER, "ROOT", react_native),
                mock.patch.object(PRODUCER, "command", side_effect=fake_command),
                mock.patch.object(
                    PRODUCER,
                    "repository_identity",
                    return_value={
                        "commit": source_commit,
                        "tree": "c" * 40,
                        "commit_timestamp": "1",
                    },
                ),
                mock.patch.object(PRODUCER, "remove_materialized_worktree", return_value=False),
                mock.patch.object(PRODUCER.subprocess, "run", side_effect=fake_child),
                mock.patch.dict(os.environ, environment, clear=False),
            ):
                with self.assertRaisesRegex(PRODUCER.CandidateError, "failed to remove"):
                    PRODUCER.run_in_materialized_sources("ios")

            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".candidate-output.unpublished-*")), [])

    def test_materialized_nonzero_after_staging_never_publishes_output(self) -> None:
        source_commit = "a" * 40
        javascript_commit = "b" * 40
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            sources = root / "sources"
            react_native = sources / "original-react-native"
            javascript = sources / "original-javascript"
            output = root / "candidate-output"
            sources.mkdir()
            react_native.mkdir()
            javascript.mkdir()
            (react_native / ".git").mkdir()
            (javascript / ".git").mkdir()
            (react_native / "release-compatibility.json").write_text(
                json.dumps({"javascript": {"source_commit": javascript_commit}}),
                encoding="utf-8",
            )

            def fake_command(arguments, **_kwargs):
                if "worktree" in arguments and "add" in arguments:
                    pathlib.Path(arguments[-2]).mkdir(parents=True)
                return b""

            def fake_child(*_arguments, **kwargs):
                produced = pathlib.Path(kwargs["env"]["LATCHWAY_CANDIDATE_OUTPUT_DIR"])
                produced.mkdir()
                (produced / "candidate-manifest.json").write_text("partial\n", encoding="utf-8")
                return subprocess.CompletedProcess(["python3"], 17)

            environment = {
                "LATCHWAY_SOURCE_COMMIT": source_commit,
                "LATCHWAY_JAVASCRIPT_SDK_PATH": str(javascript),
                "LATCHWAY_CANDIDATE_OUTPUT_DIR": str(output),
            }
            with (
                mock.patch.object(PRODUCER, "ROOT", react_native),
                mock.patch.object(PRODUCER, "command", side_effect=fake_command),
                mock.patch.object(
                    PRODUCER,
                    "repository_identity",
                    return_value={"commit": source_commit, "tree": "c" * 40, "commit_timestamp": "1"},
                ),
                mock.patch.object(PRODUCER, "remove_materialized_worktree", return_value=True),
                mock.patch.object(PRODUCER.subprocess, "run", side_effect=fake_child),
                mock.patch.dict(os.environ, environment, clear=False),
            ):
                self.assertEqual(PRODUCER.run_in_materialized_sources("android"), 17)

            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".candidate-output.unpublished-*")), [])

    def test_materialized_zero_without_complete_output_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = pathlib.Path(temporary) / "candidate"
            output.mkdir()
            with self.assertRaisesRegex(PRODUCER.CandidateError, "incomplete"):
                PRODUCER.validate_unpublished_candidate(output)

    def test_materialized_worktree_removal_oserror_is_failure(self) -> None:
        with mock.patch.object(PRODUCER.subprocess, "run", side_effect=OSError("boom")):
            self.assertFalse(
                PRODUCER.remove_materialized_worktree(pathlib.Path("/repo"), pathlib.Path("/worktree"))
            )

    def test_preexisting_generated_inputs_fail_closed_without_deletion(self) -> None:
        react_native_cases = [
            *PRODUCER.COMMON_GENERATED_INPUTS,
            *PRODUCER.IOS_GENERATED_INPUTS,
        ]
        for relative in react_native_cases:
            with self.subTest(source="react-native", relative=relative), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                react_native = root / "latchway-react-native-sdk"
                javascript = root / "latchway-js"
                react_native.mkdir()
                javascript.mkdir()
                target = react_native / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if relative.endswith(".local"):
                    target.write_text("NODE_BINARY=/tmp/poison\n", encoding="utf-8")
                else:
                    target.mkdir()
                    (target / "poison").write_text("poison", encoding="utf-8")
                with (
                    mock.patch.object(PRODUCER, "ignored_inputs_under", return_value=[]),
                    self.assertRaisesRegex(
                        PRODUCER.CandidateError,
                        "pre-existing ignored/generated candidate input",
                    ),
                ):
                    PRODUCER.require_pristine_candidate_inputs(
                        react_native,
                        javascript,
                        "ios",
                    )
                self.assertTrue(os.path.lexists(target))

        javascript_cases = [
            "node_modules",
            "dist",
            ".cache",
            ".pnpm-store",
            "packages/test/node_modules",
            "packages/test/dist",
        ]
        for relative in javascript_cases:
            with self.subTest(source="javascript", relative=relative), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                react_native = root / "latchway-react-native-sdk"
                javascript = root / "latchway-js"
                react_native.mkdir()
                javascript.mkdir()
                target = javascript / relative
                target.mkdir(parents=True)
                (target / "poison").write_text("poison", encoding="utf-8")
                with (
                    mock.patch.object(PRODUCER, "ignored_inputs_under", return_value=[]),
                    self.assertRaisesRegex(
                        PRODUCER.CandidateError,
                        "pre-existing ignored/generated candidate input",
                    ),
                ):
                    PRODUCER.require_pristine_candidate_inputs(
                        react_native,
                        javascript,
                        "ios",
                    )
                self.assertTrue(target.exists())

    def test_generated_input_guard_rejects_dangling_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            dangling = root / "node_modules"
            dangling.symlink_to(root / "missing", target_is_directory=True)
            with self.assertRaisesRegex(
                PRODUCER.CandidateError,
                "pre-existing ignored/generated candidate input",
            ):
                PRODUCER.require_absent_candidate_inputs(
                    root,
                    ["node_modules"],
                    "test source",
                )
            self.assertTrue(os.path.lexists(dangling))

    def test_ignored_native_sources_are_rejected_but_protected_pod_lock_is_allowed(self) -> None:
        for relative in ("ios/Hidden.swift", "example/ios/AppIntents/Hidden.swift"):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                subprocess.run(["git", "init", "-q", str(root)], check=True)
                (root / ".gitignore").write_text(relative + "\n", encoding="utf-8")
                hidden = root / relative
                hidden.parent.mkdir(parents=True, exist_ok=True)
                hidden.write_text("malicious native source", encoding="utf-8")
                with self.assertRaisesRegex(
                    PRODUCER.CandidateError,
                    "ignored native input",
                ):
                    PRODUCER.require_pristine_ios_native_inputs(root)
                self.assertTrue(hidden.exists())

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / ".gitignore").write_text(
                "example/ios/Podfile.lock\n",
                encoding="utf-8",
            )
            lock = root / "example/ios/Podfile.lock"
            lock.parent.mkdir(parents=True)
            lock.write_text("PODS:\n", encoding="utf-8")
            PRODUCER.require_pristine_ios_native_inputs(root)
            self.assertTrue(lock.exists())

    def test_javascript_dependency_link_cannot_escape_materialized_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            react_native = root / "latchway-react-native-sdk"
            javascript = root / "latchway-js"
            attacker = root / "attacker"
            (react_native / "node_modules/@latchway").mkdir(parents=True)
            (javascript / "dist").mkdir(parents=True)
            (javascript / "dist/index.js").write_text("export {};\n", encoding="utf-8")
            attacker.mkdir()
            link = react_native / "node_modules/@latchway/client"
            link.symlink_to(javascript, target_is_directory=True)
            with mock.patch.object(PRODUCER, "ROOT", react_native):
                PRODUCER.verify_javascript_dependency_link(javascript)
                link.unlink()
                link.symlink_to(attacker, target_is_directory=True)
                with self.assertRaisesRegex(
                    PRODUCER.CandidateError,
                    "does not resolve to the pinned source",
                ):
                    PRODUCER.verify_javascript_dependency_link(javascript)

    def test_candidate_output_cannot_enter_original_or_materialized_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            materialized = root / "materialized"
            react_native = materialized / "latchway-react-native-sdk"
            javascript = materialized / "latchway-js"
            original_react_native = root / "original-react-native"
            original_javascript = root / "original-javascript"
            outside = root / "outside"
            for directory in (
                react_native,
                javascript,
                original_react_native,
                original_javascript,
                outside,
            ):
                directory.mkdir(parents=True, exist_ok=True)
            base_environment = {
                PRODUCER.ORIGINAL_SOURCE_ROOT_ENV: str(original_react_native),
                PRODUCER.ORIGINAL_JAVASCRIPT_ROOT_ENV: str(original_javascript),
            }
            forbidden = (
                react_native / "candidate",
                javascript / "candidate",
                materialized / "candidate",
                original_react_native / "candidate",
                original_javascript / "candidate",
            )
            with mock.patch.object(PRODUCER, "ROOT", react_native):
                for output in forbidden:
                    with (
                        self.subTest(output=output),
                        mock.patch.dict(
                            os.environ,
                            {
                                **base_environment,
                                "LATCHWAY_CANDIDATE_OUTPUT_DIR": str(output),
                            },
                            clear=False,
                        ),
                        self.assertRaisesRegex(
                            PRODUCER.CandidateError,
                            "absent and narrowly scoped",
                        ),
                    ):
                        PRODUCER.candidate_output_path(javascript)
                allowed = outside / "candidate"
                with mock.patch.dict(
                    os.environ,
                    {
                        **base_environment,
                        "LATCHWAY_CANDIDATE_OUTPUT_DIR": str(allowed),
                    },
                    clear=False,
                ):
                    self.assertEqual(
                        PRODUCER.candidate_output_path(javascript),
                        allowed.resolve(),
                    )

    def test_fresh_javascript_build_precedes_react_native_and_ios_builds(self) -> None:
        main_source = self.source.split("def main(", 1)[1]
        javascript_install = main_source.index(
            '[*javascript_pnpm, "install", "--frozen-lockfile"]'
        )
        javascript_build = main_source.index('[*javascript_pnpm, "build"]')
        react_native_install = main_source.index('[*pnpm, "install", "--frozen-lockfile"]')
        link_check = main_source.index("verify_javascript_dependency_link(javascript_source)")
        main_ios_guard = main_source.index("require_pristine_ios_native_inputs(ROOT)")
        stage_call = main_source.index("stage_ios(values, compatibility, identities, temporary, staging)")
        ios_stage = self.source.split("def stage_ios(", 1)[1].split(
            "def android_manifest_values(",
            1,
        )[0]
        ios_second_guard = ios_stage.index("require_pristine_ios_native_inputs(ROOT)")
        pod_install = ios_stage.index('["pod", "install", "--deployment"]')
        self.assertLess(javascript_install, javascript_build)
        self.assertLess(javascript_build, react_native_install)
        self.assertLess(react_native_install, link_check)
        self.assertLess(link_check, main_ios_guard)
        self.assertLess(main_ios_guard, stage_call)
        self.assertLess(ios_second_guard, pod_install)

    def test_candidate_never_embeds_or_stages_runtime_grant_or_signing_passwords(self) -> None:
        self.assertIn("FORBIDDEN_RUNTIME_INPUTS", self.source)
        self.assertIn('"custom_token_in_candidate": False', self.source)
        self.assertNotIn('copy_exact(native_evidence', self.source)
        self.assertNotIn('"LATCHWAY_ANDROID_KEYSTORE_PASSWORD":', self.source)
        self.assertNotIn('"LATCHWAY_ANDROID_KEY_PASSWORD":', self.source)

    def test_docs_distinguish_firebase_client_configuration_from_credentials(self) -> None:
        for path in (ROOT / "docs/physical-device-evidence.md", ROOT / "example/README.md"):
            with self.subTest(path=path):
                content = path.read_text(encoding="utf-8")
                self.assertRegex(content, r"non-secret Firebase client\s+configuration")
                self.assertIn("provider credentials", content)
                self.assertRegex(content, r"provider\s+secrets")
                self.assertNotIn("never provider-configuration contents", content)

    def test_android_repository_build_is_unsigned_and_signing_is_external(self) -> None:
        for prohibited in ("signingConfigs", "storePassword", "keyPassword", "physicalRelease"):
            self.assertNotIn(prohibited, self.gradle)
        for marker in (
            "signing material is prohibited in the unsigned repository build",
            "signing material is prohibited on the unsigned Android candidate producer",
            "app-release-unsigned.apk",
            "LatchwayExample-release-unsigned.aab",
            "LatchwayExample-release-unsigned.apk",
            "--emit-presign-manifest",
            "android-aab-presign-payload.manifest",
            '"signing_mode": "unsigned"',
            '"upload_certificate_sha256": None',
            "credential_free_environment()",
        ):
            self.assertIn(marker, self.gradle + self.source)
        for prohibited in (
            "externally_sign_and_verify_android",
            "take_android_signing_inputs",
            "jarsigner",
            "storepass:env",
        ):
            self.assertNotIn(prohibited, self.source)

    def test_android_signing_inputs_are_rejected_by_unsigned_producer(self) -> None:
        self.assertIn("any(os.environ.get(name) for name in ANDROID_SIGNING_INPUTS)", self.source)
        self.assertIn(
            "signing material is prohibited on the unsigned Android candidate producer",
            self.source,
        )
        prohibited = (
            *PRODUCER.ANDROID_SIGNING_INPUTS,
            *PRODUCER.AMBIENT_CREDENTIAL_INPUTS,
        )
        environment = PRODUCER.credential_free_environment(
            {name: "must-not-survive" for name in prohibited}
        )
        for name in prohibited:
            if name == "NPM_CONFIG_USERCONFIG":
                self.assertEqual(environment[name], os.devnull)
            else:
                self.assertNotIn(name, environment)
        carriers = (
            "AZURE_CLIENT_CERTIFICATE_PATH",
            "CLOUDSDK_CONFIG",
            "ENTERPRISE_API_TOKEN",
            "GIT_ASKPASS",
            "GIT_CONFIG_VALUE_0",
            "GIT_SSH_COMMAND",
            "NPM_CONFIG__AUTH",
            "PRIVATE_REGISTRY_PASSWORD",
        )
        for name in carriers:
            self.assertNotIn(name, PRODUCER.credential_free_environment({name: "must-not-survive"}))
        hardened = PRODUCER.credential_free_environment()
        self.assertEqual(hardened["GIT_CONFIG_NOSYSTEM"], "1")
        self.assertEqual(hardened["NPM_CONFIG_USERCONFIG"], os.devnull)

    def test_materialized_git_creation_is_credential_free_and_disables_hooks(self) -> None:
        source = self.source
        self.assertIn('"core.hooksPath=/dev/null"', source)
        self.assertIn("env=source_environment", source)
        self.assertIn('child_environment = source_environment.copy()', source)
        self.assertIn('"GRADLE_USER_HOME": str(credential_home / "gradle")', source)

    def test_android_workflow_has_fresh_signer_and_no_secret_verifier(self) -> None:
        signing = self.android_workflow.split("  sign-isolated:", 1)[1].split(
            "  verify-signed:", 1
        )[0]
        verification = self.android_workflow.split("  verify-signed:", 1)[1]
        before_secrets, secret_step_and_after = signing.split(
            "      - name: Sign only the validated AAB and APK with isolated key material",
            1,
        )
        secret_step = secret_step_and_after.split(
            "      - name: Seal signed bytes after all key material is removed",
            1,
        )[0]
        for marker in (
            "Validate the exact closed unsigned set before secrets exist",
            "Download the independently pinned verifier source",
            "Sign only the validated AAB and APK with isolated key material",
            "without checkout or Gradle",
            "-sigfile LATCHWAY",
            "storepass:env LATCHWAY_SIGNER_STORE_PASSWORD",
            "react-native-android-signed-unverified",
            'LatchwayExample-release-unsigned.apk',
            "LATCHWAY_ANDROID_UPLOAD_SIGNATURE_ALGORITHM",
            'SHA256withRSA|SHA256withECDSA',
            '-sigalg "$SIGNATURE_ALGORITHM"',
            "--min-sdk-version 24",
            "--v1-signing-enabled false",
        ):
            self.assertIn(marker, signing)
        for marker in (
            "LATCHWAY_REACT_NATIVE_AAB_VERIFIER_SHA256",
            "VerifyReactNativeAabSignature --emit-presign-manifest",
            "signer-observed-presign.manifest",
            'apk_payload(apk, False)',
            'command("apkanalyzer", "manifest", "application-id", str(apk))',
            "unsigned APK JavaScript bundle is not source-bound",
            "unsigned APK embedded configuration hashes are not source-bound",
            '("apksigner", "verify", "--min-sdk-version", "24", str(apk))',
            "unsigned APK unexpectedly passed apksigner verification",
        ):
            self.assertIn(marker, before_secrets)
        self.assertNotIn("actions/checkout", signing)
        self.assertNotIn("gradlew", signing)
        self.assertNotIn("VerifyReactNativeAabSignature", secret_step)
        self.assertNotIn("java -cp", secret_step)
        self.assertNotIn("python3", secret_step)
        for marker in (
            "without checkout or secrets",
            "LATCHWAY_REACT_NATIVE_AAB_VERIFIER_SHA256",
            "VerifyReactNativeAabSignature",
            "javac -d",
            "signed candidate is not the exact ten-file set",
            "retained unsigned APK continuity is invalid",
            "signed APK payload does not match the retained source-built unsigned APK",
            "APK package/version identity is not bound to the audited candidate",
            "APK embedded configuration hashes are not source-bound",
            "signed APK JavaScript bundle is not source-bound",
            "single_apk_signer_certificate",
            "signed APK must declare exactly one signer",
            "signed APK must contain exactly one SHA-256 certificate digest",
            "subprocess, sys, unicodedata, zipfile",
            "import xml.etree.ElementTree as ET",
            "set(signed) != signed_keys",
            '"signature_algorithm":"SHA256withECDSA"',
        ):
            self.assertIn(marker, verification)
        self.assertNotIn("actions/checkout", verification)
        self.assertNotIn("secrets.", verification)
        self.assertNotIn("gradlew", verification)
        self.assertIn("signed_payload != unsigned_payload", verification)
        self.assertIn("signed_payload = apk_payload(signed_apk, False)", verification)
        self.assertNotIn("signed_payload = apk_payload(signed_apk, True)", verification)
        self.assertIn(
            'command("apksigner", "verify", "--min-sdk-version", "24", "--verbose", "--print-certs", str(signed_apk))',
            verification,
        )
        actions = __import__("re").findall(
            r"(?m)^\s+uses:\s+([^\s#]+)", self.android_workflow
        )
        self.assertGreaterEqual(len(actions), 10)
        for action in actions:
            self.assertRegex(action, r"^[^@]+@[0-9a-f]{40}$")

    def test_fresh_apk_verifier_rejects_multiple_signers(self) -> None:
        verification = self.android_workflow.split("  verify-signed:", 1)[1]
        start = verification.index("          def single_apk_signer_certificate")
        end = verification.index("\n          for apk in", start)
        namespace = {"re": re}
        exec(textwrap.dedent(verification[start:end]), namespace)
        verify = namespace["single_apk_signer_certificate"]
        expected = "ab" * 32
        one_signer = (
            "Verifies\n"
            "Number of signers: 1\n"
            f"Signer #1 certificate SHA-256 digest: {expected.upper()}\n"
        )
        self.assertEqual(expected, verify(one_signer))
        with self.assertRaises(SystemExit):
            verify(
                one_signer.replace("Number of signers: 1", "Number of signers: 2")
                + f"Signer #2 certificate SHA-256 digest: {'cd' * 32}\n"
            )
        with self.assertRaises(SystemExit):
            verify(one_signer + f"Signer #2 certificate SHA-256 digest: {'cd' * 32}\n")

    def test_fresh_apk_verifier_rejects_injected_meta_inf_signature_controls(self) -> None:
        verification = self.android_workflow.split("  verify-signed:", 1)[1]
        start = verification.index("          signature_control = re.compile")
        end = verification.index("\n\n          unsigned_apk =", start)
        namespace = {
            "hashlib": hashlib,
            "re": re,
            "unicodedata": __import__("unicodedata"),
            "zipfile": zipfile,
        }
        exec(textwrap.dedent(verification[start:end]), namespace)
        apk_payload = namespace["apk_payload"]
        with tempfile.TemporaryDirectory(prefix="latchway-apk-control-test-") as temporary:
            apk = pathlib.Path(temporary) / "injected.apk"
            with zipfile.ZipFile(apk, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("assets/index.android.bundle", b"source-bound bundle")
                archive.writestr("META-INF/ATTACK.SF", b"unreviewed signer control")
            with self.assertRaisesRegex(
                SystemExit,
                "prohibited META-INF signature controls",
            ):
                apk_payload(apk, False)

    def test_exact_aab_verifier_covers_every_payload_with_one_pinned_signer(self) -> None:
        for marker in (
            "new JarFile(archive.toFile(), true)",
            "AAB contains duplicate ZIP entry names",
            "case-ambiguous ZIP entry names",
            "Unicode-normalization-ambiguous ZIP entry names",
            "unexpected JAR signature artifact",
            'SIGNATURE_BASE = "LATCHWAY"',
            "readCompletely(",
            "signers.length != 1",
            "do not share exactly one common signer",
            "leafCertificateSha256",
            "payloadNames.equals(manifest.getEntries().keySet())",
            "version_needed_hex",
            "dos_time_hex",
            "dos_date_hex",
            "made_by_hex",
            "internal_attributes_hex",
            "external_mode_hex",
            "extra_hex",
            "local and central ZIP extra fields differ",
            "ZIP entry has an unsafe non-regular external mode",
            "only one canonical mtime-only extended-timestamp ZIP extra field is supported",
        ):
            self.assertIn(marker, self.verifier)

    def test_exact_aab_verifier_rejects_raw_mutations_and_signature_gaps(self) -> None:
        for tool in ("java", "jarsigner", "keytool"):
            self.assertIsNotNone(shutil.which(tool), f"required test tool is unavailable: {tool}")
        password = "latchway-functional-test-only"
        with tempfile.TemporaryDirectory(prefix="latchway-aab-signature-test-") as temporary:
            root = pathlib.Path(temporary)
            aab = root / "candidate.aab"
            output = NonSeekableZipOutput(aab)
            try:
                with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    self._write_regular_entry(archive, "BundleConfig.pb", b"bounded bundle configuration")
                    self._write_regular_entry(
                        archive,
                        "base/manifest/AndroidManifest.xml",
                        b"bounded manifest",
                    )
                    self._write_regular_entry(archive, "base/dex/classes.dex", b"bounded dex payload")
            finally:
                output.close()
            self._set_utf8_flags(aab)

            payload_manifest = root / "presign-payload.manifest"
            self._run(
                "java", str(VERIFIER_PATH), "--emit-presign-manifest",
                str(aab), str(payload_manifest),
            )
            manifest_text = payload_manifest.read_text(encoding="ascii")
            self.assertIn("schema=latchway.react-native-android-aab-presign-payload.v1", manifest_text)
            self.assertIn("sort=raw_name_unsigned_byte_lexicographic", manifest_text)
            self.assertIn("raw_name_hex", manifest_text)

            keystore = root / "upload.p12"
            signer_environment = dict(os.environ)
            signer_environment["LATCHWAY_TEST_STORE_PASSWORD"] = password
            signer_environment["LATCHWAY_TEST_KEY_PASSWORD"] = password
            self._run(
                "keytool", "-genkeypair", "-noprompt",
                "-storetype", "PKCS12", "-keystore", str(keystore),
                "-storepass", password, "-keypass", password,
                "-alias", "upload", "-keyalg", "RSA", "-keysize", "2048",
                "-sigalg", "SHA256withRSA", "-validity", "2",
                "-dname", "CN=Latchway Functional Upload",
            )
            certificate = self._run(
                "keytool", "-exportcert", "-storetype", "PKCS12",
                "-keystore", str(keystore),
                "-storepass:env", "LATCHWAY_TEST_STORE_PASSWORD",
                "-alias", "upload", "-keypass:env", "LATCHWAY_TEST_KEY_PASSWORD",
                environment=signer_environment,
            ).stdout
            certificate_sha256 = hashlib.sha256(certificate).hexdigest()
            self._run(
                "jarsigner", "-keystore", str(keystore), "-storetype", "PKCS12",
                "-storepass:env", "LATCHWAY_TEST_STORE_PASSWORD",
                "-keypass:env", "LATCHWAY_TEST_KEY_PASSWORD",
                "-digestalg", "SHA-256", "-sigalg", "SHA256withRSA",
                "-sigfile", "LATCHWAY", str(aab), "upload",
                environment=signer_environment,
            )

            accepted = self._verify(aab, certificate_sha256, payload_manifest)
            self.assertEqual(0, accepted.returncode, accepted.stderr)
            self.assertIn("Verified raw ZIP structure, pre-sign continuity", accepted.stdout)

            wrong_pin = self._verify(aab, "0" * 64, payload_manifest)
            self.assertNotEqual(0, wrong_pin.returncode)
            self.assertIn("does not match the pinned certificate", wrong_pin.stderr)

            changed_manifest = root / "changed-presign-payload.manifest"
            changed_manifest.write_bytes(payload_manifest.read_bytes() + b"unexpected\n")
            changed_manifest_result = self._verify(aab, certificate_sha256, changed_manifest)
            self.assertNotEqual(0, changed_manifest_result.returncode)
            self.assertIn("does not match the independently carried pre-sign manifest", changed_manifest_result.stderr)

            additional_signer = root / "additional-signer.aab"
            shutil.copyfile(aab, additional_signer)
            self._run(
                "keytool", "-genkeypair", "-noprompt",
                "-storetype", "PKCS12", "-keystore", str(keystore),
                "-storepass", password, "-keypass", password,
                "-alias", "second", "-keyalg", "RSA", "-keysize", "2048",
                "-sigalg", "SHA256withRSA", "-validity", "2",
                "-dname", "CN=Unexpected Additional Signer",
            )
            self._run(
                "jarsigner", "-keystore", str(keystore), "-storetype", "PKCS12",
                "-storepass:env", "LATCHWAY_TEST_STORE_PASSWORD",
                "-keypass:env", "LATCHWAY_TEST_KEY_PASSWORD",
                "-digestalg", "SHA-256", "-sigalg", "SHA256withRSA",
                "-sigfile", "SECOND", str(additional_signer), "second",
                environment=signer_environment,
            )
            extra_signer_result = self._verify(additional_signer, certificate_sha256, payload_manifest)
            self.assertNotEqual(0, extra_signer_result.returncode)
            self.assertRegex(
                extra_signer_result.stderr,
                r"additional signer|signature control basename",
            )

            appended = root / "unsigned-append.aab"
            shutil.copyfile(aab, appended)
            with zipfile.ZipFile(appended, "a", compression=zipfile.ZIP_DEFLATED) as archive:
                self._write_regular_entry(
                    archive,
                    "base/assets/unsigned-after-signing.txt",
                    b"must be rejected",
                )
            # This is the behavior that motivated the exact verifier: default
            # jarsigner reports success while warning about unsigned entries.
            plain_jarsigner = self._run("jarsigner", "-verify", str(appended))
            self.assertEqual(0, plain_jarsigner.returncode)
            append_result = self._verify(appended, certificate_sha256, payload_manifest)
            self.assertNotEqual(0, append_result.returncode)
            self.assertIn("does not match the independently carried pre-sign manifest", append_result.stderr)

            deleted = root / "deleted-signed-entry.aab"
            with zipfile.ZipFile(aab, "r") as source, zipfile.ZipFile(deleted, "w") as target:
                for entry in source.infolist():
                    if entry.filename != "base/dex/classes.dex":
                        entry.create_system = 3
                        entry.external_attr = (stat.S_IFREG | 0o644) << 16
                        entry.internal_attr = 0
                        entry.extra = b""
                        target.writestr(entry, source.read(entry))
            deletion_jarsigner = self._run("jarsigner", "-verify", str(deleted))
            self.assertEqual(0, deletion_jarsigner.returncode)
            deletion_result = self._verify(deleted, certificate_sha256, payload_manifest)
            self.assertNotEqual(0, deletion_result.returncode)
            self.assertIn("does not match the independently carried pre-sign manifest", deletion_result.stderr)

            local_mismatch = root / "local-traversal-mismatch.aab"
            shutil.copyfile(aab, local_mismatch)
            self._replace_local_name(local_mismatch, "base/dex/classes.dex")
            plain_local_mismatch = self._run("jarsigner", "-verify", str(local_mismatch))
            self.assertEqual(0, plain_local_mismatch.returncode)
            local_mismatch_result = self._verify(
                local_mismatch,
                certificate_sha256,
                payload_manifest,
            )
            self.assertNotEqual(0, local_mismatch_result.returncode)
            self.assertIn("local and central ZIP entry names differ", local_mismatch_result.stderr)

            symlink_mode = root / "symlink-external-mode.aab"
            shutil.copyfile(aab, symlink_mode)
            self._replace_central_mode_with_symlink(symlink_mode, "base/dex/classes.dex")
            plain_symlink = self._run("jarsigner", "-verify", str(symlink_mode))
            self.assertEqual(0, plain_symlink.returncode)
            symlink_result = self._verify(symlink_mode, certificate_sha256, payload_manifest)
            self.assertNotEqual(0, symlink_result.returncode)
            self.assertIn("unsafe non-regular external mode", symlink_result.stderr)

            special_mode = root / "setuid-external-mode.aab"
            shutil.copyfile(aab, special_mode)
            self._replace_central_mode_with_special_bits(
                special_mode,
                "base/dex/classes.dex",
            )
            special_result = self._verify(special_mode, certificate_sha256, payload_manifest)
            self.assertNotEqual(0, special_result.returncode)
            self.assertIn("unsafe non-regular external mode", special_result.stderr)

            version_mismatch = root / "local-version-mismatch.aab"
            shutil.copyfile(aab, version_mismatch)
            self._replace_local_version_needed(version_mismatch, "base/dex/classes.dex")
            version_result = self._verify(version_mismatch, certificate_sha256, payload_manifest)
            self.assertNotEqual(0, version_result.returncode)
            self.assertIn("required version", version_result.stderr)

            invalid_version = root / "invalid-required-version.aab"
            shutil.copyfile(aab, invalid_version)
            self._replace_local_and_central_version_needed(
                invalid_version,
                "base/dex/classes.dex",
                0,
            )
            invalid_version_result = self._verify(
                invalid_version,
                certificate_sha256,
                payload_manifest,
            )
            self.assertNotEqual(0, invalid_version_result.returncode)
            self.assertIn("non-canonical required version", invalid_version_result.stderr)

            timestamp_mismatch = root / "local-timestamp-mismatch.aab"
            shutil.copyfile(aab, timestamp_mismatch)
            self._replace_local_modification_time(timestamp_mismatch, "base/dex/classes.dex")
            timestamp_result = self._verify(
                timestamp_mismatch,
                certificate_sha256,
                payload_manifest,
            )
            self.assertNotEqual(0, timestamp_result.returncode)
            self.assertIn("timestamp differ", timestamp_result.stderr)

            internal_attributes = root / "internal-attributes.aab"
            shutil.copyfile(aab, internal_attributes)
            self._replace_central_internal_attributes(
                internal_attributes,
                "base/dex/classes.dex",
            )
            internal_result = self._verify(
                internal_attributes,
                certificate_sha256,
                payload_manifest,
            )
            self.assertNotEqual(0, internal_result.returncode)
            self.assertIn("internal file attributes are unsupported", internal_result.stderr)

            trailing = root / "trailing-polyglot.aab"
            shutil.copyfile(aab, trailing)
            with trailing.open("ab") as output:
                output.write(b"unreviewed trailing polyglot bytes")
            trailing_result = self._verify(trailing, certificate_sha256, payload_manifest)
            self.assertNotEqual(0, trailing_result.returncode)
            self.assertIn("invalid end of central directory signature", trailing_result.stderr)

            canonical_extra = root / "canonical-extra.aab"
            with zipfile.ZipFile(canonical_extra, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                entry = zipfile.ZipInfo("base/dex/classes.dex")
                entry.create_system = 3
                entry.external_attr = (stat.S_IFREG | 0o644) << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.extra = struct.pack("<HHBI", 0x5455, 5, 0x01, 0)
                archive.writestr(entry, b"bounded dex payload")
            canonical_manifest = root / "canonical-extra.manifest"
            canonical_result = subprocess.run(
                (
                    "java", str(VERIFIER_PATH), "--emit-presign-manifest",
                    str(canonical_extra), str(canonical_manifest),
                ),
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=60,
            )
            self.assertEqual(0, canonical_result.returncode, canonical_result.stderr)

            extra_mismatch = root / "local-extra-mismatch.aab"
            shutil.copyfile(canonical_extra, extra_mismatch)
            self._replace_local_extended_timestamp(extra_mismatch, "base/dex/classes.dex")
            mismatch_manifest = root / "local-extra-mismatch.manifest"
            mismatch_result = subprocess.run(
                (
                    "java", str(VERIFIER_PATH), "--emit-presign-manifest",
                    str(extra_mismatch), str(mismatch_manifest),
                ),
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=60,
            )
            self.assertNotEqual(0, mismatch_result.returncode)
            self.assertIn("local and central ZIP extra fields differ", mismatch_result.stderr)

            alternate_name_extra = root / "alternate-name-extra.aab"
            with zipfile.ZipFile(alternate_name_extra, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                entry = zipfile.ZipInfo("base/dex/classes.dex")
                entry.create_system = 3
                entry.external_attr = (stat.S_IFREG | 0o644) << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.extra = struct.pack("<HHB", 0x7075, 1, 1)
                archive.writestr(entry, b"bounded dex payload")
            alternate_manifest = root / "alternate-name-extra.manifest"
            alternate_result = subprocess.run(
                (
                    "java", str(VERIFIER_PATH), "--emit-presign-manifest",
                    str(alternate_name_extra), str(alternate_manifest),
                ),
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=60,
            )
            self.assertNotEqual(0, alternate_result.returncode)
            self.assertIn(
                "only one canonical mtime-only extended-timestamp ZIP extra field is supported",
                alternate_result.stderr,
            )

    @staticmethod
    def _run(
        *arguments: str,
        environment: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            arguments,
            check=True,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
        )

    @staticmethod
    def _verify(
        aab: pathlib.Path,
        certificate_sha256: str,
        payload_manifest: pathlib.Path,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (
                "java", str(VERIFIER_PATH), str(aab), certificate_sha256,
                str(payload_manifest),
            ),
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
        )

    @staticmethod
    def _write_regular_entry(
        archive: zipfile.ZipFile,
        name: str,
        content: bytes,
    ) -> None:
        entry = zipfile.ZipInfo(name)
        entry.create_system = 3
        entry.external_attr = (stat.S_IFREG | 0o644) << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, content)

    @staticmethod
    def _replace_local_name(path: pathlib.Path, name: str) -> None:
        with zipfile.ZipFile(path) as archive:
            entry = archive.getinfo(name)
            offset = entry.header_offset
        replacement = b"../" + b"x" * (len(name.encode("ascii")) - 3)
        with path.open("r+b") as target:
            target.seek(offset + 26)
            name_length, extra_length = struct.unpack("<HH", target.read(4))
            del extra_length
            assert name_length == len(replacement)
            target.seek(offset + 30)
            target.write(replacement)

    @staticmethod
    def _replace_central_mode_with_symlink(path: pathlib.Path, name: str) -> None:
        content = bytearray(path.read_bytes())
        end_offset = len(content) - 22
        assert struct.unpack_from("<I", content, end_offset)[0] == 0x06054B50
        entry_count = struct.unpack_from("<H", content, end_offset + 10)[0]
        position = struct.unpack_from("<I", content, end_offset + 16)[0]
        for _ in range(entry_count):
            assert struct.unpack_from("<I", content, position)[0] == 0x02014B50
            name_length, extra_length, comment_length = struct.unpack_from(
                "<HHH",
                content,
                position + 28,
            )
            raw_name = bytes(content[position + 46 : position + 46 + name_length])
            if raw_name == name.encode("ascii"):
                struct.pack_into("<H", content, position + 4, (3 << 8) | 20)
                struct.pack_into(
                    "<I",
                    content,
                    position + 38,
                    (stat.S_IFLNK | 0o777) << 16,
                )
                path.write_bytes(content)
                return
            position += 46 + name_length + extra_length + comment_length
        raise AssertionError(f"central entry not found: {name}")

    @staticmethod
    def _replace_central_mode_with_special_bits(path: pathlib.Path, name: str) -> None:
        content = bytearray(path.read_bytes())
        end_offset = len(content) - 22
        assert struct.unpack_from("<I", content, end_offset)[0] == 0x06054B50
        entry_count = struct.unpack_from("<H", content, end_offset + 10)[0]
        position = struct.unpack_from("<I", content, end_offset + 16)[0]
        for _ in range(entry_count):
            assert struct.unpack_from("<I", content, position)[0] == 0x02014B50
            name_length, extra_length, comment_length = struct.unpack_from(
                "<HHH",
                content,
                position + 28,
            )
            raw_name = bytes(content[position + 46 : position + 46 + name_length])
            if raw_name == name.encode("ascii"):
                struct.pack_into("<H", content, position + 4, (3 << 8) | 20)
                struct.pack_into(
                    "<I",
                    content,
                    position + 38,
                    (stat.S_IFREG | stat.S_ISUID | 0o755) << 16,
                )
                path.write_bytes(content)
                return
            position += 46 + name_length + extra_length + comment_length
        raise AssertionError(f"central entry not found: {name}")

    @staticmethod
    def _replace_local_version_needed(path: pathlib.Path, name: str) -> None:
        with zipfile.ZipFile(path) as archive:
            entry = archive.getinfo(name)
            offset = entry.header_offset
        content = bytearray(path.read_bytes())
        current = struct.unpack_from("<H", content, offset + 4)[0]
        replacement = 10 if current != 10 else 20
        struct.pack_into("<H", content, offset + 4, replacement)
        path.write_bytes(content)

    @staticmethod
    def _replace_local_and_central_version_needed(
        path: pathlib.Path,
        name: str,
        replacement: int,
    ) -> None:
        content = bytearray(path.read_bytes())
        end_offset = len(content) - 22
        assert struct.unpack_from("<I", content, end_offset)[0] == 0x06054B50
        entry_count = struct.unpack_from("<H", content, end_offset + 10)[0]
        position = struct.unpack_from("<I", content, end_offset + 16)[0]
        for _ in range(entry_count):
            assert struct.unpack_from("<I", content, position)[0] == 0x02014B50
            name_length, extra_length, comment_length = struct.unpack_from(
                "<HHH",
                content,
                position + 28,
            )
            raw_name = bytes(content[position + 46 : position + 46 + name_length])
            if raw_name == name.encode("ascii"):
                local_offset = struct.unpack_from("<I", content, position + 42)[0]
                struct.pack_into("<H", content, position + 6, replacement)
                struct.pack_into("<H", content, local_offset + 4, replacement)
                path.write_bytes(content)
                return
            position += 46 + name_length + extra_length + comment_length
        raise AssertionError(f"central entry not found: {name}")

    @staticmethod
    def _replace_local_modification_time(path: pathlib.Path, name: str) -> None:
        with zipfile.ZipFile(path) as archive:
            entry = archive.getinfo(name)
            offset = entry.header_offset
        content = bytearray(path.read_bytes())
        current = struct.unpack_from("<H", content, offset + 10)[0]
        struct.pack_into("<H", content, offset + 10, current ^ 0x0001)
        path.write_bytes(content)

    @staticmethod
    def _replace_central_internal_attributes(path: pathlib.Path, name: str) -> None:
        content = bytearray(path.read_bytes())
        end_offset = len(content) - 22
        assert struct.unpack_from("<I", content, end_offset)[0] == 0x06054B50
        entry_count = struct.unpack_from("<H", content, end_offset + 10)[0]
        position = struct.unpack_from("<I", content, end_offset + 16)[0]
        for _ in range(entry_count):
            assert struct.unpack_from("<I", content, position)[0] == 0x02014B50
            name_length, extra_length, comment_length = struct.unpack_from(
                "<HHH",
                content,
                position + 28,
            )
            raw_name = bytes(content[position + 46 : position + 46 + name_length])
            if raw_name == name.encode("ascii"):
                struct.pack_into("<H", content, position + 36, 1)
                path.write_bytes(content)
                return
            position += 46 + name_length + extra_length + comment_length
        raise AssertionError(f"central entry not found: {name}")

    @staticmethod
    def _replace_local_extended_timestamp(path: pathlib.Path, name: str) -> None:
        with zipfile.ZipFile(path) as archive:
            entry = archive.getinfo(name)
            offset = entry.header_offset
        content = bytearray(path.read_bytes())
        name_length, extra_length = struct.unpack_from("<HH", content, offset + 26)
        extra_offset = offset + 30 + name_length
        extra = bytes(content[extra_offset : extra_offset + extra_length])
        assert extra == struct.pack("<HHBI", 0x5455, 5, 0x01, 0)
        struct.pack_into("<I", content, extra_offset + 5, 1)
        path.write_bytes(content)

    @staticmethod
    def _set_utf8_flags(path: pathlib.Path) -> None:
        content = bytearray(path.read_bytes())
        end_offset = len(content) - 22
        assert struct.unpack_from("<I", content, end_offset)[0] == 0x06054B50
        entry_count = struct.unpack_from("<H", content, end_offset + 10)[0]
        position = struct.unpack_from("<I", content, end_offset + 16)[0]
        for _ in range(entry_count):
            assert struct.unpack_from("<I", content, position)[0] == 0x02014B50
            flags = struct.unpack_from("<H", content, position + 8)[0] | 0x0800
            local_offset = struct.unpack_from("<I", content, position + 42)[0]
            struct.pack_into("<H", content, position + 8, flags)
            struct.pack_into("<H", content, local_offset + 6, flags)
            name_length, extra_length, comment_length = struct.unpack_from(
                "<HHH",
                content,
                position + 28,
            )
            position += 46 + name_length + extra_length + comment_length
        path.write_bytes(content)

    def test_platform_builds_embed_exact_configuration_hashes_before_signing(self) -> None:
        for marker in (
            "LATCHWAY_PHYSICAL_CANDIDATE",
            "LATCHWAY_FIREBASE_CONFIGURATION_SHA256",
            "LATCHWAY_CANDIDATE_CONFIGURATION_SHA256",
            "google-services.json",
            "signing material is prohibited in the unsigned repository build",
        ):
            self.assertIn(marker, self.gradle)
        self.assertIn("dev.latchway.firebase_configuration_sha256", self.manifest)
        self.assertIn("dev.latchway.candidate_configuration_sha256", self.manifest)
        self.assertIn("Copy protected Firebase configuration", self.project)
        self.assertIn("GoogleService-Info.plist", self.copy_ios)
        self.assertIn("LatchwayFirebaseConfigurationSHA256", self.copy_ios)
        self.assertIn("LatchwayCandidateConfigurationSHA256", self.copy_ios)

    def test_ios_uses_app_id_prefix_and_openssl_profile_verification(self) -> None:
        self.assertIn("objectVersion = 77;", self.project)
        for marker in (
            "LATCHWAY_IOS_APP_ID_PREFIX",
            "LATCHWAY_IOS_APPINTENTS_BUNDLE_ID",
            "LATCHWAY_IOS_APPINTENTS_PROVISIONING_PROFILE_UUID",
            "LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP",
            "LATCHWAY_ROOT_BUNDLE_IDENTIFIER",
            "LATCHWAY_APPINTENTS_BUNDLE_IDENTIFIER",
            "LATCHWAY_ROOT_PROVISIONING_PROFILE_SPECIFIER",
            "LATCHWAY_APPINTENTS_PROVISIONING_PROFILE_SPECIFIER",
            "expected_application_identifier",
            "expected_extension_application_identifier",
            '"cms"',
            '"-verify"',
            '"embedded.mobileprovision"',
            '"keychain-access-groups"',
            'app / "Extensions" / "AppIntents.appex"',
            "private_keychain_access_group",
            "LATCHWAY_IOS_ROOT_KEYCHAIN_ACCESS_GROUP",
            "LATCHWAY_IOS_LEGACY_SHARED_KEYCHAIN_ACCESS_GROUPS",
            '"root_keychain_access_group": private_keychain_access_group',
            '"legacy_shared_keychain_access_groups": [shared_keychain_access_group]',
            "expected_root_keychain_access_groups",
            "expected_extension_keychain_access_groups",
            "profile_authorizes_keychain_access_groups",
            "profile_authorizes_string_value",
            "exact private-first/shared-second Keychain access groups",
            "authorize every signed Keychain access group",
            "com.apple.developer.devicecheck.app-attest-opt-in",
            "signed App Intents entitlements do not match delegated-only pins",
        ):
            self.assertIn(marker, self.source)
        self.assertIn(
            'PRODUCT_BUNDLE_IDENTIFIER = "$(LATCHWAY_ROOT_BUNDLE_IDENTIFIER)";',
            self.project,
        )
        self.assertIn(
            'PRODUCT_BUNDLE_IDENTIFIER = "$(LATCHWAY_APPINTENTS_BUNDLE_IDENTIFIER)";',
            self.project,
        )
        self.assertNotIn('f"PRODUCT_BUNDLE_IDENTIFIER={bundle_id}"', self.source)
        self.assertNotIn('f"PROVISIONING_PROFILE_SPECIFIER={profile_uuid}"', self.source)
        self.assertEqual(
            self.source.count(
                'get("com.apple.developer.devicecheck.app-attest-opt-in")\n'
                '        != ["CDhash"]'
            ),
            2,
        )

    def test_ios_profile_app_attest_environment_authorizes_production(self) -> None:
        self.assertTrue(PRODUCER.profile_authorizes_string_value("production", "production"))
        self.assertTrue(
            PRODUCER.profile_authorizes_string_value(
                ["development", "production"],
                "production",
            )
        )
        for malformed in (None, [], ["development"], ["production", 1]):
            with self.subTest(malformed=malformed):
                self.assertFalse(
                    PRODUCER.profile_authorizes_string_value(malformed, "production")
                )

    def test_ios_profile_keychain_authorization_accepts_exact_and_terminal_prefix_grants(self) -> None:
        private = "PFK5S2E4H5.dev.latchway"
        shared = private + ".keychain"
        signed = [private, shared]
        self.assertTrue(
            PRODUCER.profile_authorizes_keychain_access_groups(
                [private, shared, "com.apple.token"],
                signed,
            )
        )
        self.assertTrue(
            PRODUCER.profile_authorizes_keychain_access_groups(
                ["PFK5S2E4H5.*", "com.apple.token"],
                signed,
            )
        )
        self.assertTrue(
            PRODUCER.profile_authorizes_keychain_access_groups(
                [private, private + ".*"],
                signed,
            )
        )

    def test_ios_profile_keychain_authorization_rejects_malformed_wildcards(self) -> None:
        signed = ["PFK5S2E4H5.dev.latchway"]
        for malformed in (
            "*",
            "PFK5S2E4H5*",
            "PFK5S2E4H5..*",
            "PFK5S2E4H5.**",
            "PFK5S2E4H5.*.suffix",
        ):
            with self.subTest(malformed=malformed), self.assertRaisesRegex(
                PRODUCER.CandidateError,
                "malformed Keychain wildcard",
            ):
                PRODUCER.profile_authorizes_keychain_access_groups(
                    [malformed],
                    signed,
                )

    def test_ios_profile_keychain_authorization_rejects_unauthorized_signed_groups(self) -> None:
        private = "PFK5S2E4H5.dev.latchway"
        shared = private + ".keychain"
        self.assertFalse(
            PRODUCER.profile_authorizes_keychain_access_groups(
                [private, "com.apple.token"],
                [private, shared],
            )
        )
        self.assertFalse(
            PRODUCER.profile_authorizes_keychain_access_groups(
                ["OTHER12345.*", "com.apple.token"],
                [private, shared],
            )
        )

    def test_repository_symlinks_and_credential_environment_files_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            repository = root / "repository"
            repository.mkdir()
            (repository / ".git").mkdir()
            link = root / "repository-link"
            link.symlink_to(repository, target_is_directory=True)
            previous = os.environ.get("TEST_LATCHWAY_REPOSITORY")
            os.environ["TEST_LATCHWAY_REPOSITORY"] = str(link)
            try:
                with self.assertRaises(PRODUCER.CandidateError):
                    PRODUCER.safe_repository("TEST_LATCHWAY_REPOSITORY")
            finally:
                if previous is None:
                    os.environ.pop("TEST_LATCHWAY_REPOSITORY", None)
                else:
                    os.environ["TEST_LATCHWAY_REPOSITORY"] = previous

            with self.assertRaises(PRODUCER.CandidateError):
                PRODUCER.write_build_environment(
                    root / "candidate.env",
                    {"LATCHWAY_ONE_TIME_DEVICE_GRANT": "header.payload.signature"},
                )


if __name__ == "__main__":
    unittest.main()
