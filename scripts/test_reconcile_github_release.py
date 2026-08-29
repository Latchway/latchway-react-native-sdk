#!/usr/bin/env python3
"""Offline tests for fail-closed GitHub release reconciliation."""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
import json
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("reconcile-github-release.py")
SPEC = importlib.util.spec_from_file_location("reconcile_github_release", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FakeClient:
    def __init__(self, release: dict[str, Any] | None = None, contents: dict[int, bytes] | None = None) -> None:
        self.value = release
        self.contents = dict(contents or {})
        self.created = 0
        self.uploaded: list[str] = []
        self.finalized = 0
        self.attestations_verified: list[str] = []
        self.release_attestations_verified: list[str] = []
        self.settings_reads = 0
        self.settings_enabled = True

    def immutable_releases_enabled(self, repository: str) -> bool:
        del repository
        self.settings_reads += 1
        return self.settings_enabled

    def release(self, repository: str, tag: str) -> dict[str, Any] | None:
        del repository, tag
        if self.value is None:
            return None
        return {
            **self.value,
            "assets": [dict(asset) for asset in self.value["assets"]],
        }

    def create(self, repository: str, tag: str, title: str, prerelease: bool) -> None:
        del repository
        self.created += 1
        self.value = {
            "tag_name": tag,
            "name": title,
            "draft": True,
            "prerelease": prerelease,
            "immutable": False,
            "assets": [],
        }

    def download(self, repository: str, asset_id: int, destination: Path) -> None:
        del repository
        destination.write_bytes(self.contents[asset_id])

    def upload(self, repository: str, tag: str, path: Path) -> None:
        del repository, tag
        assert self.value is not None
        asset_id = max(self.contents, default=0) + 1
        payload = path.read_bytes()
        self.contents[asset_id] = payload
        self.value["assets"].append({
            "id": asset_id,
            "name": path.name,
            "size": len(payload),
            "state": "uploaded",
        })
        self.uploaded.append(path.name)

    def finalize(self, repository: str, tag: str, prerelease: bool) -> None:
        del repository, tag, prerelease
        assert self.value is not None
        self.finalized += 1
        self.value["draft"] = False
        self.value["immutable"] = True

    def verify_attestation(self, repository: str, path: Path, source_commit: str) -> None:
        del repository, source_commit
        self.attestations_verified.append(path.name)

    def verify_release_attestation(self, repository: str, tag: str, assets: list[Any]) -> None:
        del repository, tag
        self.release_attestations_verified = [asset.name for asset in assets]


def release(*, draft: bool, assets: list[dict[str, Any]], title: str = "Latchway v1.0.0") -> dict[str, Any]:
    return {
        "tag_name": "v1.0.0",
        "name": title,
        "draft": draft,
        "prerelease": False,
        "immutable": not draft,
        "assets": assets,
    }


class ReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.first_path = root / "first.tgz"
        self.second_path = root / "SHA256SUMS"
        self.first_path.write_bytes(b"first immutable bytes")
        self.second_path.write_bytes(b"digest  first.tgz\n")
        self.assets = MODULE.inspect_assets([str(self.first_path), str(self.second_path)])

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def reconcile(self, client: FakeClient) -> None:
        MODULE.reconcile(
            repository="Latchway/example",
            tag="v1.0.0",
            title="Latchway v1.0.0",
            prerelease=False,
            assets=self.assets,
            client=client,
        )

    def test_creates_uploads_and_finalizes_new_release(self) -> None:
        client = FakeClient()
        self.reconcile(client)
        self.assertEqual(client.created, 1)
        self.assertEqual(client.uploaded, ["SHA256SUMS", "first.tgz"])
        self.assertEqual(client.finalized, 1)

    def test_resumes_partial_draft_without_overwriting_identical_asset(self) -> None:
        first = next(asset for asset in self.assets if asset.name == "first.tgz")
        client = FakeClient(
            release(
                draft=True,
                assets=[{
                    "id": 7,
                    "name": first.name,
                    "size": first.size,
                    "state": "uploaded",
                    "digest": f"sha256:{first.sha256}",
                }],
            ),
            {7: self.first_path.read_bytes()},
        )
        self.reconcile(client)
        self.assertEqual(client.created, 0)
        self.assertEqual(client.uploaded, ["SHA256SUMS"])
        self.assertEqual(client.finalized, 1)

    def test_exact_final_release_is_a_read_only_success(self) -> None:
        remote_assets = []
        contents: dict[int, bytes] = {}
        for identifier, asset in enumerate(self.assets, 1):
            remote_assets.append({
                "id": identifier,
                "name": asset.name,
                "size": asset.size,
                "state": "uploaded",
                "digest": f"sha256:{asset.sha256}",
            })
            contents[identifier] = asset.path.read_bytes()
        client = FakeClient(release(draft=False, assets=remote_assets), contents)
        self.reconcile(client)
        self.assertEqual(client.created, 0)
        self.assertEqual(client.uploaded, [])
        self.assertEqual(client.finalized, 0)

    def test_rejects_different_existing_bytes(self) -> None:
        first = next(asset for asset in self.assets if asset.name == "first.tgz")
        client = FakeClient(
            release(draft=True, assets=[{
                "id": 1,
                "name": first.name,
                "size": first.size,
                "state": "uploaded",
            }]),
            {1: b"x" * first.size},
        )
        with self.assertRaisesRegex(MODULE.Rejected, "not byte-identical"):
            self.reconcile(client)
        self.assertEqual(client.uploaded, [])
        self.assertEqual(client.finalized, 0)

    def test_rejects_unexpected_asset_and_metadata_mismatch(self) -> None:
        unexpected = FakeClient(release(draft=True, assets=[{
            "id": 1, "name": "foreign.bin", "size": 1, "state": "uploaded",
        }]), {1: b"x"})
        with self.assertRaisesRegex(MODULE.Rejected, "unexpected asset"):
            self.reconcile(unexpected)

        wrong_title = FakeClient(release(draft=True, assets=[], title="wrong"))
        with self.assertRaisesRegex(MODULE.Rejected, "title"):
            self.reconcile(wrong_title)

    def test_final_release_cannot_be_backfilled(self) -> None:
        client = FakeClient(release(draft=False, assets=[]))
        with self.assertRaisesRegex(MODULE.Rejected, "missing immutable asset"):
            self.reconcile(client)
        self.assertEqual(client.uploaded, [])

    def test_final_release_must_be_github_immutable(self) -> None:
        value = release(draft=False, assets=[])
        value["immutable"] = False
        client = FakeClient(value)
        with self.assertRaisesRegex(MODULE.Rejected, "not immutable"):
            self.reconcile(client)

    def test_disabled_immutable_setting_rejects_before_release_lookup_or_mutation(self) -> None:
        client = FakeClient()
        client.settings_enabled = False
        with self.assertRaisesRegex(MODULE.Rejected, "not enabled"):
            self.reconcile(client)
        self.assertEqual(client.settings_reads, 1)
        self.assertEqual(client.created, 0)

    def test_release_attestation_covers_every_final_asset(self) -> None:
        client = FakeClient()
        self.reconcile(client)
        self.assertEqual(client.release_attestations_verified, ["SHA256SUMS", "first.tgz"])

    def test_prepare_creates_draft_and_accepts_only_declared_names(self) -> None:
        client = FakeClient()
        state = MODULE.prepare_release(
            repository="Latchway/example",
            tag="v1.0.0",
            title="Latchway v1.0.0",
            prerelease=False,
            expected_names={"first.tgz"},
            adoption_pattern=None,
            client=client,
        )
        self.assertEqual(state, "draft")
        client.value["assets"].append({"id": 1, "name": "foreign", "size": 1, "state": "uploaded"})
        with self.assertRaisesRegex(MODULE.Rejected, "unexpected asset"):
            MODULE.prepare_release(
                repository="Latchway/example",
                tag="v1.0.0",
                title="Latchway v1.0.0",
                prerelease=False,
                expected_names={"first.tgz"},
                adoption_pattern=None,
                client=client,
            )

    def test_retry_preserves_attested_adoption_history(self) -> None:
        commit = "a" * 40
        prior_name = "npm-release-adoption-100-1.json"
        current_name = "npm-release-adoption-200-2.json"

        def record(run_id: int, attempt: int) -> bytes:
            repository = "https://github.com/Latchway/example"
            tarball = self.first_path.read_bytes()
            sha512 = MODULE.hashlib.sha512(tarball).hexdigest()
            return (json.dumps({
                "schema_version": 1,
                "kind": "latchway_npm_release_adoption",
                "package": "@latchway/react-native",
                "version": "1.0.0",
                "release_tag": "v1.0.0",
                "tarball": {
                    "name": "first.tgz", "bytes": len(tarball),
                    "sha256": MODULE.hashlib.sha256(tarball).hexdigest(), "sha512": sha512,
                    "integrity": f"sha512-{MODULE.base64.b64encode(bytes.fromhex(sha512)).decode('ascii')}",
                },
                "source": {"repository": repository, "commit": commit, "workflow": ".github/workflows/release.yml", "ref": "refs/heads/main"},
                "provenance": {"repository": repository, "commit": commit, "workflow": ".github/workflows/release.yml", "ref": "refs/heads/main", "predicate_type": "https://slsa.dev/provenance/v1", "invocation_id": f"{repository}/actions/runs/100/attempts/1", "run_id": 100, "run_attempt": 1},
                "adoption": {"repository": repository, "commit": commit, "workflow": ".github/workflows/release.yml", "ref": "refs/heads/main", "run_id": run_id, "run_attempt": attempt, "mode": "adopted_existing"},
                "registry_evidence_manifest": {"file": "npm-registry-evidence-manifest.json", "sha256": "b" * 64},
            }, sort_keys=True) + "\n").encode()

        current_path = Path(self.temporary.name) / current_name
        current_path.write_bytes(record(200, 2))
        prior = record(100, 1)
        fixed = next(asset for asset in self.assets if asset.name == "first.tgz")
        client = FakeClient(
            release(draft=True, assets=[
                {"id": 1, "name": fixed.name, "size": fixed.size, "state": "uploaded"},
                {"id": 2, "name": prior_name, "size": len(prior), "state": "uploaded"},
            ]),
            {1: fixed.path.read_bytes(), 2: prior},
        )
        MODULE.reconcile(
            repository="Latchway/example",
            tag="v1.0.0",
            title="Latchway v1.0.0",
            prerelease=False,
            assets=MODULE.inspect_assets([str(fixed.path), str(current_path)]),
            client=client,
            source_commit=commit,
            adoption_pattern=MODULE.re.compile(r"npm-release-adoption-[1-9][0-9]*-[1-9][0-9]*\.json"),
        )
        self.assertIn(current_name, client.uploaded)
        self.assertEqual(client.attestations_verified, [prior_name, current_name])
        self.assertTrue(client.value["immutable"])
        self.assertEqual(set(client.release_attestations_verified), {"first.tgz", prior_name, current_name})
        tampered = json.loads(record(200, 2))
        tampered["tarball"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(MODULE.Rejected, "not bound"):
            MODULE.validate_adoption_record(
                (json.dumps(tampered) + "\n").encode(),
                name=current_name,
                repository="Latchway/example",
                tag="v1.0.0",
                source_commit=commit,
                tarballs={fixed.name: fixed},
            )

    def test_admin_preflight_requires_exact_enabled_response_and_protected_token(self) -> None:
        client = MODULE.GitHubClient()
        accepted = {"enabled": True, "enforced_by_owner": False}
        with patch.dict(os.environ, {"LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN": "token"}), patch.object(
            MODULE.subprocess,
            "run",
            return_value=MODULE.subprocess.CompletedProcess([], 0, json.dumps(accepted), ""),
        ) as run:
            self.assertTrue(client.immutable_releases_enabled("Latchway/example"))
            arguments = run.call_args.args[0]
            self.assertIn("X-GitHub-Api-Version: 2026-03-10", arguments)
            self.assertIn("repos/Latchway/example/immutable-releases", arguments)
            self.assertEqual(run.call_args.kwargs["env"]["GH_TOKEN"], "token")

        for response in (
            {"enabled": False, "enforced_by_owner": False},
            {"enabled": True},
            {"enabled": True, "enforced_by_owner": False, "unexpected": True},
        ):
            with self.subTest(response=response), patch.dict(
                os.environ, {"LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN": "token"}
            ), patch.object(
                MODULE.subprocess,
                "run",
                return_value=MODULE.subprocess.CompletedProcess([], 0, json.dumps(response), ""),
            ):
                self.assertFalse(client.immutable_releases_enabled("Latchway/example"))

    def test_admin_preflight_rejects_missing_or_multiline_token_without_network(self) -> None:
        client = MODULE.GitHubClient()
        for token in (None, "bad\nvalue"):
            environment = {} if token is None else {"LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN": token}
            with self.subTest(token=token), patch.dict(os.environ, environment, clear=True), patch.object(
                MODULE.subprocess, "run"
            ) as run:
                with self.assertRaisesRegex(RuntimeError, "credential is missing"):
                    client.immutable_releases_enabled("Latchway/example")
                run.assert_not_called()

    def test_release_attestation_invokes_github_verifier_for_every_asset(self) -> None:
        with patch.object(MODULE, "_run") as run:
            MODULE.GitHubClient().verify_release_attestation(
                "Latchway/example", "v1.0.0", self.assets
            )
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(commands[0][:4], ["gh", "release", "verify", "v1.0.0"])
        self.assertEqual(len(commands), 3)
        self.assertEqual({Path(command[4]).name for command in commands[1:]}, {"first.tgz", "SHA256SUMS"})

    def test_adoption_attestation_is_pinned_to_exact_source_commit(self) -> None:
        commit = "c" * 40
        with patch.object(MODULE, "_run") as run:
            MODULE.GitHubClient().verify_attestation(
                "Latchway/example", self.first_path, commit
            )
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--source-digest") + 1], commit)


if __name__ == "__main__":
    unittest.main()
