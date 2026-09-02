#!/usr/bin/env python3
"""Adversarial tests for the explicit single-maintainer release verifier."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("verify-maintainer-release.py")
SPEC = importlib.util.spec_from_file_location("verify_maintainer_release", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
SOURCE = SCRIPT.parents[1]


def shell_run_blocks(workflow: str) -> list[str]:
    lines = workflow.splitlines()
    result: list[str] = []
    index = 0
    while index < len(lines):
        match = re.match(r"^(\s*)run:\s*(.*)$", lines[index])
        if match is None:
            index += 1
            continue
        indent = len(match.group(1))
        block = [match.group(2)]
        index += 1
        while index < len(lines):
            following = lines[index]
            if following.strip() and len(following) - len(following.lstrip()) <= indent:
                break
            block.append(following)
            index += 1
        result.append("\n".join(block))
    return result


class MaintainerReleaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="latchway-maintainer-release-")
        self.root = Path(self.temporary.name) / SOURCE.name
        subprocess.run(["git", "clone", "--quiet", "--no-local", str(SOURCE), str(self.root)], check=True)
        self.commit = self.git("rev-parse", "HEAD")
        self.original_root = MODULE.ROOT
        MODULE.ROOT = self.root

    def tearDown(self) -> None:
        MODULE.ROOT = self.original_root
        self.temporary.cleanup()

    def arguments(self, **changes: str) -> argparse.Namespace:
        values = {
            "repository_id": "react_native",
            "repository_name": "Latchway/latchway-react-native-sdk",
            "profile": "single_maintainer_v1",
            "release_commit": self.commit,
            "release_version": "1.0.0",
            "workflow_commit": self.commit,
            "workflow_ref": "refs/heads/main",
            "run_id": "123",
            "run_attempt": "1",
            "confirmation": "publish-v1.0.0-with-deferred-assurance",
            "intent_output": Path(self.temporary.name) / "intent.json",
            "github_output": None,
        }
        values.update(changes)
        return argparse.Namespace(**values)

    def test_accepts_exact_source_and_exports_all_locked_commits(self) -> None:
        result = MODULE.verify(self.arguments())
        self.assertEqual(result["commit"], self.commit)
        for key in ("core_commit", "javascript_commit", "ios_commit", "android_commit"):
            self.assertRegex(result[key], r"^[0-9a-f]{40}$")
        intent = json.loads((Path(self.temporary.name) / "intent.json").read_text())
        self.assertFalse(intent["release_qualified"])
        self.assertEqual(intent["workflow"]["file"], ".github/workflows/single-maintainer-release.yml")

    def test_rejects_wrong_confirmation_or_non_main_ref(self) -> None:
        for change in ({"confirmation": "yes"}, {"workflow_ref": "refs/heads/feature"}):
            with self.subTest(change=change), self.assertRaisesRegex(MODULE.Rejected, "maintainer_release_dispatch_invalid"):
                MODULE.verify(self.arguments(**change))

    def test_rejects_dirty_source(self) -> None:
        (self.root / "untracked").write_text("dirty\n", encoding="utf-8")
        with self.assertRaisesRegex(MODULE.Rejected, "maintainer_release_worktree_dirty"):
            MODULE.verify(self.arguments())

    def test_workflow_requires_all_public_platform_dependencies_and_trusted_tuple(self) -> None:
        workflow = (SOURCE / ".github/workflows/single-maintainer-release.yml").read_text(encoding="utf-8")
        self.assertIn("--rawfile body", workflow)
        documentation = (SOURCE / "docs/releasing.md").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("needs: [intent, verify-source, core-release-gate]", workflow)
        self.assertNotIn('"latchway:${{ needs.intent.outputs.core_commit }}"', workflow)
        self.assertIn("git -C latchway merge-base --is-ancestor", workflow)
        self.assertIn("verify:bundle", workflow)
        self.assertIn("verify-published-dependencies.mjs --android-single-maintainer-v1", workflow)
        self.assertIn("attestations: read", workflow)
        self.assertNotIn("$artifact-1.0.0.pom", workflow)
        android_verifier = (SOURCE / "scripts/verify-published-dependencies.mjs").read_text(encoding="utf-8")
        for artifact in ("latchway-core", "latchway-okhttp", "latchway-play-integrity", "latchway-firebase-auth", "latchway-bom"):
            self.assertIn(artifact, android_verifier)
        for asset in (
            "android-dependency-vulnerability-scan.json",
            "latchway-single-maintainer-v1-intent.json",
            "pinned-core-conformance.tar.gz",
            "single-maintainer-release-evidence.json",
        ):
            self.assertIn(asset, (SOURCE / "scripts/android-release-evidence.mjs").read_text(encoding="utf-8"))
        self.assertIn("android-consumer", workflow)
        self.assertIn("ios-consumer", workflow)
        publisher = (SOURCE / "scripts/publish-or-verify.mjs").read_text(encoding="utf-8")
        self.assertIn('"--provenance"', publisher)
        self.assertIn("workflow file\n`single-maintainer-release.yml`", documentation)
        self.assertIn("strict `release.yml` cannot publish", documentation)
        self.assertIn("npm permits only one trusted publisher", documentation)

    def test_dispatch_inputs_are_never_interpolated_directly_into_shell(self) -> None:
        workflow = (SOURCE / ".github/workflows/single-maintainer-release.yml").read_text(encoding="utf-8")
        blocks = shell_run_blocks(workflow)
        self.assertGreater(len(blocks), 0)
        for block in blocks:
            self.assertNotIn("${{ inputs.", block)
        for name in ("RELEASE_PROFILE", "RELEASE_COMMIT", "RELEASE_VERSION_INPUT", "CONFIRMATION"):
            self.assertIn(name, workflow)

    def test_run_identity_is_authenticated_before_checkout_and_main_is_rechecked_before_tag(self) -> None:
        workflow = (SOURCE / ".github/workflows/single-maintainer-release.yml").read_text(encoding="utf-8")
        intent = workflow.split("\n  intent:\n", 1)[1].split("\n  verify-source:\n", 1)[0]
        steps = intent.split("\n    steps:\n", 1)[1].lstrip()
        self.assertTrue(steps.startswith("- name: Authenticate this exact workflow run and attempt before checkout"))
        authentication = steps.split("\n      - uses: actions/checkout", 1)[0]
        for value in (
            "actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT",
            '.head_sha == $commit and .head_branch == "main"',
            '.path == ".github/workflows/single-maintainer-release.yml"',
            'test "$RELEASE_COMMIT" = "$GITHUB_SHA"',
        ):
            self.assertIn(value, authentication)
        self.assertNotIn("scripts/verify-maintainer-release.py", authentication)
        tag = workflow.split("\n  tag:\n", 1)[1].split("\n  package:\n", 1)[0]
        self.assertIn('test "$RELEASE_COMMIT" = "$REQUESTED_COMMIT"', tag)
        self.assertIn('test "$RELEASE_COMMIT" = "$GITHUB_SHA"', tag)
        self.assertIn("git/ref/heads/main", tag)

    def test_workflow_closes_core_provenance_retry_and_draft_adoption(self) -> None:
        workflow = (SOURCE / ".github/workflows/single-maintainer-release.yml").read_text(encoding="utf-8")
        documentation = (SOURCE / "docs/releasing.md").read_text(encoding="utf-8")
        verifier = (SOURCE / "scripts/verify-public-core-release.sh").read_text(encoding="utf-8")
        semantic = (SOURCE / "scripts/verify-public-core-release.py").read_text(encoding="utf-8")
        for value in (
            "core-release-gate:",
            "Reject a v1 tag owned by another workflow transaction",
            "verify-public-core-release.sh",
            "EXPECTED_WORKFLOW_PATH: .github/workflows/single-maintainer-release.yml",
            "verify-published.mjs",
            "retention-days: 90",
            "--draft --verify-tag",
            "cmp --silent",
            "{\"draft\":false}",
        ):
            self.assertIn(value, workflow)
        self.assertNotIn("--clobber", workflow)
        self.assertNotIn("gh release delete", workflow)
        for value in ("gh attestation verify", "single-maintainer-release.yml", "release.yml", "deployment-evidence.yml", "compare/$locked_core_commit...$core_commit"):
            self.assertIn(value, verifier)
        for value in ("core_publication_gate", "vulnerability_scan_verified", "sbom_verified", "compose", "cloud_run"):
            self.assertIn(value, semantic)
        self.assertIn("Re-run failed jobs", documentation)
        self.assertIn("Never use **Re-run all jobs**", documentation)
        self.assertIn("never start a new workflow", documentation)

    def test_every_lower_assurance_environment_job_checks_exact_sentinel_first(self) -> None:
        workflow = (SOURCE / ".github/workflows/single-maintainer-release.yml").read_text(encoding="utf-8")
        expected = "latchway-release-controls-v1:latchway-react-native-sdk:single-maintainer-v1"
        boundaries = {
            "tag": "package",
            "publish": "github-release",
            "github-release": None,
        }
        for job, following_job in boundaries.items():
            with self.subTest(job=job):
                section = workflow.split(f"\n  {job}:\n", 1)[1]
                if following_job is not None:
                    section = section.split(f"\n  {following_job}:\n", 1)[0]
                self.assertIn("environment: single-maintainer-v1", section)
                steps = section.split("\n    steps:\n", 1)[1].lstrip()
                self.assertTrue(
                    steps.startswith("- name: Verify exact lower-assurance environment"),
                    f"{job} must fail closed before any action, credential, OIDC request, or mutation",
                )
                first_step = steps.split("\n      - ", 1)[0]
                self.assertIn("OBSERVED_POLICY_ID: ${{ vars.LATCHWAY_RELEASE_CONTROL_POLICY_ID }}", first_step)
                self.assertIn(expected, first_step)

    def git(self, *arguments: str) -> str:
        return subprocess.run(["git", "-C", str(self.root), *arguments], check=True, capture_output=True, text=True).stdout.strip()


if __name__ == "__main__":
    unittest.main()
