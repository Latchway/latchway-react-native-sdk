#!/usr/bin/env python3
"""Create or resume an immutable GitHub release without overwriting assets."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote


REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TAG = re.compile(r"^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")
MAXIMUM_ASSET_BYTES = 2 * 1024 * 1024 * 1024


class Rejected(RuntimeError):
    """The existing public release differs from the intended immutable state."""


@dataclass(frozen=True)
class Asset:
    path: Path
    name: str
    size: int
    sha256: str


class Client(Protocol):
    def immutable_releases_enabled(self, repository: str) -> bool: ...

    def release(self, repository: str, tag: str) -> dict[str, Any] | None: ...

    def create(self, repository: str, tag: str, title: str, prerelease: bool) -> None: ...

    def download(self, repository: str, asset_id: int, destination: Path) -> None: ...

    def upload(self, repository: str, tag: str, path: Path) -> None: ...

    def finalize(self, repository: str, tag: str, prerelease: bool) -> None: ...

    def verify_attestation(self, repository: str, path: Path, source_commit: str) -> None: ...

    def verify_release_attestation(
        self, repository: str, tag: str, assets: list[Asset]
    ) -> None: ...


class GitHubClient:
    def immutable_releases_enabled(self, repository: str) -> bool:
        token = os.environ.get("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", "")
        if not token or any(character in token for character in "\x00\r\n"):
            raise RuntimeError("The protected immutable-release settings credential is missing.")
        environment = os.environ.copy()
        environment["GH_TOKEN"] = token
        result = subprocess.run(
            [
                "gh", "api",
                "-H", "Accept: application/vnd.github+json",
                "-H", "X-GitHub-Api-Version: 2026-03-10",
                f"repos/{repository}/immutable-releases",
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env=environment,
        )
        if result.returncode != 0:
            return False
        try:
            value = json.loads(result.stdout)
        except json.JSONDecodeError:
            return False
        return (
            isinstance(value, dict)
            and set(value) == {"enabled", "enforced_by_owner"}
            and value.get("enabled") is True
            and isinstance(value.get("enforced_by_owner"), bool)
        )

    def release(self, repository: str, tag: str) -> dict[str, Any] | None:
        endpoint = f"repos/{repository}/releases/tags/{quote(tag, safe='')}"
        result = subprocess.run(
            ["gh", "api", "-H", "X-GitHub-Api-Version: 2026-03-10", endpoint],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if result.returncode != 0:
            if re.search(r"(?:HTTP\s+404|404\s+Not Found|release not found)", result.stderr, re.IGNORECASE):
                return None
            raise RuntimeError(f"GitHub release lookup failed: {result.stderr.strip()}")
        try:
            value = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError("GitHub returned invalid release JSON.") from error
        if not isinstance(value, dict):
            raise RuntimeError("GitHub returned an invalid release document.")
        return value

    def create(self, repository: str, tag: str, title: str, prerelease: bool) -> None:
        arguments = [
            "gh", "release", "create", tag,
            "--repo", repository,
            "--verify-tag",
            "--draft",
            "--generate-notes",
            "--title", title,
        ]
        if prerelease:
            arguments.append("--prerelease")
        _run(arguments, "GitHub draft release creation")

    def download(self, repository: str, asset_id: int, destination: Path) -> None:
        endpoint = f"repos/{repository}/releases/assets/{asset_id}"
        with destination.open("wb") as output:
            result = subprocess.run(
                ["gh", "api", "--method", "GET", "-H", "Accept: application/octet-stream", endpoint],
                check=False,
                stdout=output,
                stderr=subprocess.PIPE,
            )
        if result.returncode != 0:
            raise RuntimeError(f"GitHub release asset download failed: {result.stderr.decode(errors='replace').strip()}")

    def upload(self, repository: str, tag: str, path: Path) -> None:
        # Deliberately omit --clobber. Existing assets are downloaded and
        # verified before this method is called; immutable bytes are never replaced.
        _run(
            ["gh", "release", "upload", tag, str(path), "--repo", repository],
            "GitHub release asset upload",
        )

    def finalize(self, repository: str, tag: str, prerelease: bool) -> None:
        arguments = ["gh", "release", "edit", tag, "--repo", repository, "--draft=false"]
        if prerelease:
            arguments.append("--prerelease")
        else:
            arguments.extend(["--prerelease=false", "--latest"])
        _run(arguments, "GitHub release finalization")

    def verify_attestation(self, repository: str, path: Path, source_commit: str) -> None:
        _run(
            [
                "gh", "attestation", "verify", str(path),
                "--repo", repository,
                "--signer-workflow", f"{repository}/.github/workflows/release.yml",
                "--source-ref", "refs/heads/main",
                "--source-digest", source_commit,
                "--deny-self-hosted-runners",
            ],
            "GitHub release adoption attestation verification",
        )

    def verify_release_attestation(
        self, repository: str, tag: str, assets: list[Asset]
    ) -> None:
        _run(
            ["gh", "release", "verify", tag, "--repo", repository, "--format", "json"],
            "GitHub immutable release attestation verification",
        )
        for asset in assets:
            _run(
                [
                    "gh", "release", "verify-asset", tag, str(asset.path),
                    "--repo", repository, "--format", "json",
                ],
                f"GitHub immutable release asset attestation verification ({asset.name})",
            )


def _run(arguments: list[str], operation: str) -> None:
    result = subprocess.run(arguments, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{operation} failed: {result.stderr.strip()}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_assets(paths: list[str]) -> list[Asset]:
    if not paths:
        raise Rejected("At least one release asset is required.")
    assets: list[Asset] = []
    names: set[str] = set()
    for raw_path in paths:
        path = Path(raw_path)
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
            raise Rejected(f"Release asset must be a regular file: {path}")
        if metadata.st_size <= 0 or metadata.st_size > MAXIMUM_ASSET_BYTES:
            raise Rejected(f"Release asset has an invalid size: {path}")
        name = path.name
        if name in {"", ".", ".."} or "/" in name or "\\" in name or name in names:
            raise Rejected(f"Release asset has an unsafe or duplicate name: {name}")
        names.add(name)
        digest = sha256_file(path)
        assets.append(Asset(path=path.resolve(), name=name, size=metadata.st_size, sha256=digest))
    return sorted(assets, key=lambda asset: asset.name)


def validate_release(
    release: dict[str, Any],
    *,
    tag: str,
    title: str,
    prerelease: bool,
    expected_assets: list[Asset],
    allow_draft: bool,
    allowed_extra: re.Pattern[str] | None = None,
) -> dict[str, dict[str, Any]]:
    if release.get("tag_name") != tag:
        raise Rejected("Existing GitHub release tag does not match the promoted tag.")
    if release.get("name") != title:
        raise Rejected("Existing GitHub release title does not match the promoted release.")
    if release.get("prerelease") is not prerelease:
        raise Rejected("Existing GitHub release prerelease state does not match the promoted version.")
    if not isinstance(release.get("draft"), bool) or (release["draft"] and not allow_draft):
        raise Rejected("Existing GitHub release is not finalized.")
    raw_assets = release.get("assets")
    if not isinstance(raw_assets, list):
        raise Rejected("Existing GitHub release has an invalid asset list.")
    expected_names = {asset.name for asset in expected_assets}
    observed: dict[str, dict[str, Any]] = {}
    for raw_asset in raw_assets:
        if not isinstance(raw_asset, dict) or not isinstance(raw_asset.get("name"), str):
            raise Rejected("Existing GitHub release has invalid asset metadata.")
        name = raw_asset["name"]
        if name in observed:
            raise Rejected(f"Existing GitHub release has duplicate asset {name}.")
        if name not in expected_names and (allowed_extra is None or allowed_extra.fullmatch(name) is None):
            raise Rejected(f"Existing GitHub release has unexpected asset {name}.")
        if raw_asset.get("state") != "uploaded":
            raise Rejected(f"Existing GitHub release asset {name} is not fully uploaded.")
        if not isinstance(raw_asset.get("id"), int) or raw_asset["id"] <= 0:
            raise Rejected(f"Existing GitHub release asset {name} has an invalid identifier.")
        observed[name] = raw_asset
    return observed


def validate_release_state(release: dict[str, Any], *, tag: str, title: str, prerelease: bool) -> None:
    if release.get("tag_name") != tag or release.get("name") != title:
        raise Rejected("Existing GitHub release metadata does not match the promoted release.")
    if release.get("prerelease") is not prerelease or not isinstance(release.get("draft"), bool):
        raise Rejected("Existing GitHub release state does not match the promoted release.")
    if not isinstance(release.get("immutable"), bool):
        raise Rejected("Existing GitHub release has no immutable-state proof.")
    if release["draft"]:
        if release["immutable"]:
            raise Rejected("A draft GitHub release cannot already be immutable.")
    elif release.get("immutable") is not True:
        raise Rejected("The finalized GitHub release is not immutable.")


def validate_adoption_record(
    payload: bytes, *, name: str, repository: str, tag: str,
    source_commit: str, tarballs: dict[str, Asset],
) -> None:
    if len(payload) == 0 or len(payload) > 256 * 1024:
        raise Rejected(f"Adoption record {name} has an invalid size.")
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise Rejected(f"Adoption record {name} is not valid JSON.") from error
    match = re.fullmatch(r"npm-release-adoption-([1-9][0-9]*)-([1-9][0-9]*)\.json", name)
    expected_repository = f"https://github.com/{repository}"
    source = value.get("source") if isinstance(value, dict) else None
    provenance = value.get("provenance") if isinstance(value, dict) else None
    adoption = value.get("adoption") if isinstance(value, dict) else None
    registry = value.get("registry_evidence_manifest") if isinstance(value, dict) else None
    tarball = value.get("tarball") if isinstance(value, dict) else None
    expected_tarball = tarballs.get(tarball.get("name")) if isinstance(tarball, dict) else None
    expected_sha512 = None
    if expected_tarball is not None:
        digest = hashlib.sha512()
        with expected_tarball.path.open("rb") as source_file:
            while chunk := source_file.read(1024 * 1024):
                digest.update(chunk)
        expected_sha512 = digest.hexdigest()
    if (
        match is None
        or not isinstance(value, dict)
        or set(value) != {
            "schema_version", "kind", "package", "version", "release_tag", "tarball",
            "source", "provenance", "adoption", "registry_evidence_manifest",
        }
        or value.get("schema_version") != 1
        or value.get("kind") != "latchway_npm_release_adoption"
        or re.fullmatch(r"@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*", str(value.get("package", ""))) is None
        or value.get("version") != tag[1:]
        or value.get("release_tag") != tag
        or not isinstance(tarball, dict)
        or set(tarball) != {"name", "bytes", "sha256", "sha512", "integrity"}
        or expected_tarball is None
        or tarball.get("bytes") != expected_tarball.size
        or tarball.get("sha256") != expected_tarball.sha256
        or tarball.get("sha512") != expected_sha512
        or tarball.get("integrity") != f"sha512-{base64.b64encode(bytes.fromhex(expected_sha512 or '')).decode('ascii')}"
        or source != {
            "repository": expected_repository,
            "commit": source_commit,
            "workflow": ".github/workflows/release.yml",
            "ref": "refs/heads/main",
        }
        or not isinstance(provenance, dict)
        or set(provenance) != {
            "repository", "commit", "workflow", "ref", "predicate_type",
            "invocation_id", "run_id", "run_attempt",
        }
        or provenance.get("repository") != expected_repository
        or provenance.get("commit") != source_commit
        or provenance.get("workflow") != ".github/workflows/release.yml"
        or provenance.get("ref") != "refs/heads/main"
        or provenance.get("predicate_type") != "https://slsa.dev/provenance/v1"
        or not isinstance(provenance.get("run_id"), int)
        or provenance["run_id"] < 1
        or not isinstance(provenance.get("run_attempt"), int)
        or provenance["run_attempt"] < 1
        or provenance.get("invocation_id") != (
            f"{expected_repository}/actions/runs/{provenance.get('run_id')}"
            f"/attempts/{provenance.get('run_attempt')}"
        )
        or not isinstance(adoption, dict)
        or set(adoption) != {
            "repository", "commit", "workflow", "ref", "run_id", "run_attempt", "mode",
        }
        or str(adoption.get("run_id")) != match.group(1)
        or str(adoption.get("run_attempt")) != match.group(2)
        or adoption.get("repository") != expected_repository
        or adoption.get("commit") != source_commit
        or adoption.get("workflow") != ".github/workflows/release.yml"
        or adoption.get("ref") != "refs/heads/main"
        or adoption.get("mode") not in ("published", "adopted_existing")
        or not isinstance(registry, dict)
        or set(registry) != {"file", "sha256"}
        or registry.get("file") != "npm-registry-evidence-manifest.json"
        or re.fullmatch(r"[0-9a-f]{64}", str(registry.get("sha256", ""))) is None
    ):
        raise Rejected(f"Adoption record {name} is not bound to this release.")


def verify_adoption_asset(
    client: Client,
    repository: str,
    tag: str,
    source_commit: str,
    name: str,
    asset_id: int,
    tarballs: dict[str, Asset],
) -> None:
    with tempfile.TemporaryDirectory(prefix="latchway-release-adoption-") as temporary:
        downloaded = Path(temporary, name)
        client.download(repository, asset_id, downloaded)
        payload = downloaded.read_bytes()
        validate_adoption_record(
            payload,
            name=name,
            repository=repository,
            tag=tag,
            source_commit=source_commit,
            tarballs=tarballs,
        )
        client.verify_attestation(repository, downloaded, source_commit)


def verify_remote_asset(client: Client, repository: str, local: Asset, remote: dict[str, Any]) -> None:
    if remote.get("size") != local.size:
        raise Rejected(f"Existing GitHub release asset {local.name} has different bytes.")
    advertised_digest = remote.get("digest")
    if advertised_digest not in (None, "", f"sha256:{local.sha256}"):
        raise Rejected(f"Existing GitHub release asset {local.name} has a different digest.")
    with tempfile.TemporaryDirectory(prefix="latchway-release-asset-") as temporary:
        downloaded = Path(temporary, local.name)
        client.download(repository, remote["id"], downloaded)
        metadata = downloaded.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != local.size:
            raise Rejected(f"Existing GitHub release asset {local.name} downloaded with a different size.")
        digest = sha256_file(downloaded)
        if digest != local.sha256:
            raise Rejected(f"Existing GitHub release asset {local.name} is not byte-identical.")


def reconcile(
    *,
    repository: str,
    tag: str,
    title: str,
    prerelease: bool,
    assets: list[Asset],
    client: Client,
    source_commit: str | None = None,
    adoption_pattern: re.Pattern[str] | None = None,
) -> None:
    # The administration read is intentionally the first external operation.
    # Never create or mutate a release when GitHub cannot prove that immutable
    # releases are enabled for this repository.
    if not client.immutable_releases_enabled(repository):
        raise Rejected("Immutable GitHub releases are not enabled for this repository.")
    release = client.release(repository, tag)
    if release is None:
        client.create(repository, tag, title, prerelease)
        release = client.release(repository, tag)
        if release is None:
            raise RuntimeError("GitHub did not expose the newly created draft release.")

    observed = validate_release(
        release,
        tag=tag,
        title=title,
        prerelease=prerelease,
        expected_assets=assets,
        allow_draft=True,
        allowed_extra=adoption_pattern,
    )
    validate_release_state(release, tag=tag, title=title, prerelease=prerelease)
    adoption_names = sorted(name for name in observed if adoption_pattern is not None and adoption_pattern.fullmatch(name))
    tarballs = {asset.name: asset for asset in assets if asset.name.endswith(".tgz")}
    if adoption_pattern is not None:
        if source_commit is None:
            raise Rejected("Adoption history verification requires the exact source commit.")
        if len(tarballs) != 1:
            raise Rejected("Npm adoption history requires one exact release tarball.")
        for name in adoption_names:
            verify_adoption_asset(
                client, repository, tag, source_commit, name, observed[name]["id"], tarballs
            )
        for asset in assets:
            if adoption_pattern.fullmatch(asset.name):
                validate_adoption_record(
                    asset.path.read_bytes(),
                    name=asset.name,
                    repository=repository,
                    tag=tag,
                    source_commit=source_commit,
                    tarballs=tarballs,
                )
                client.verify_attestation(repository, asset.path, source_commit)
    # Prove every existing byte before making any mutation. A mismatched
    # partial release must fail without uploading otherwise-missing assets.
    for asset in assets:
        remote = observed.get(asset.name)
        if remote is not None:
            verify_remote_asset(client, repository, asset, remote)
    for asset in assets:
        if asset.name not in observed:
            if release["draft"] is not True:
                if adoption_pattern is not None and adoption_pattern.fullmatch(asset.name) and adoption_names:
                    continue
                raise Rejected(f"Final GitHub release is missing immutable asset {asset.name}.")
            client.upload(repository, tag, asset.path)

    release = client.release(repository, tag)
    if release is None:
        raise RuntimeError("GitHub release disappeared during asset reconciliation.")
    observed = validate_release(
        release,
        tag=tag,
        title=title,
        prerelease=prerelease,
        expected_assets=assets,
        allow_draft=True,
        allowed_extra=adoption_pattern,
    )
    expected_fixed = {
        asset.name for asset in assets
        if adoption_pattern is None or adoption_pattern.fullmatch(asset.name) is None
    }
    observed_adoptions = {
        name for name in observed
        if adoption_pattern is not None and adoption_pattern.fullmatch(name)
    }
    if not expected_fixed.issubset(observed) or (adoption_pattern is not None and not observed_adoptions):
        raise Rejected("GitHub draft release does not contain the complete immutable asset set.")
    for asset in assets:
        if asset.name not in observed and adoption_pattern is not None and adoption_pattern.fullmatch(asset.name):
            continue
        verify_remote_asset(client, repository, asset, observed[asset.name])

    if release["draft"]:
        client.finalize(repository, tag, prerelease)

    final = client.release(repository, tag)
    if final is None:
        raise RuntimeError("GitHub release disappeared after finalization.")
    final_assets = validate_release(
        final,
        tag=tag,
        title=title,
        prerelease=prerelease,
        expected_assets=assets,
        allow_draft=False,
        allowed_extra=adoption_pattern,
    )
    validate_release_state(final, tag=tag, title=title, prerelease=prerelease)
    final_adoptions = {
        name for name in final_assets
        if adoption_pattern is not None and adoption_pattern.fullmatch(name)
    }
    if not expected_fixed.issubset(final_assets) or (adoption_pattern is not None and not final_adoptions):
        raise Rejected("Final GitHub release does not contain the complete immutable asset set.")
    for asset in assets:
        if asset.name not in final_assets and adoption_pattern is not None and adoption_pattern.fullmatch(asset.name):
            continue
        verify_remote_asset(client, repository, asset, final_assets[asset.name])
    with tempfile.TemporaryDirectory(prefix="latchway-release-final-assets-") as temporary:
        local_by_name = {asset.name: asset for asset in assets if asset.name in final_assets}
        final_local: list[Asset] = []
        for name, remote in sorted(final_assets.items()):
            local = local_by_name.get(name)
            if local is None:
                downloaded = Path(temporary, name)
                client.download(repository, remote["id"], downloaded)
                local = inspect_assets([str(downloaded)])[0]
            final_local.append(local)
        client.verify_release_attestation(repository, tag, final_local)


def prepare_release(
    *, repository: str, tag: str, title: str, prerelease: bool,
    expected_names: set[str], adoption_pattern: re.Pattern[str] | None, client: Client,
) -> str:
    if not client.immutable_releases_enabled(repository):
        raise Rejected("Immutable GitHub releases are not enabled for this repository.")
    release = client.release(repository, tag)
    if release is None:
        client.create(repository, tag, title, prerelease)
        release = client.release(repository, tag)
        if release is None:
            raise RuntimeError("GitHub did not expose the newly created draft release.")
    validate_release_state(release, tag=tag, title=title, prerelease=prerelease)
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise Rejected("Existing GitHub release has an invalid asset list.")
    seen: set[str] = set()
    for asset in assets:
        name = asset.get("name") if isinstance(asset, dict) else None
        if not isinstance(name, str) or name in seen:
            raise Rejected("Existing GitHub release has invalid or duplicate assets.")
        if name not in expected_names and (adoption_pattern is None or adoption_pattern.fullmatch(name) is None):
            raise Rejected(f"Existing GitHub release has unexpected asset {name}.")
        seen.add(name)
    return "draft" if release["draft"] else "immutable"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--tag", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--prerelease", action="store_true")
    parser.add_argument("--prepare-draft", action="store_true")
    parser.add_argument("--expected-asset-name", action="append", default=[])
    parser.add_argument("--source-commit")
    parser.add_argument("--npm-adoption-history", action="store_true")
    parser.add_argument("assets", nargs="*")
    arguments = parser.parse_args()
    if not isinstance(arguments.repository, str) or REPOSITORY.fullmatch(arguments.repository) is None:
        parser.error("--repository must be an owner/repository name")
    if TAG.fullmatch(arguments.tag) is None:
        parser.error("--tag must be a canonical semantic-version release tag")
    if not arguments.title or "\n" in arguments.title or "\r" in arguments.title:
        parser.error("--title must be a non-empty single line")
    if arguments.prepare_draft and arguments.assets:
        parser.error("--prepare-draft does not accept local assets")
    if not arguments.prepare_draft and not arguments.assets:
        parser.error("at least one release asset is required")
    if arguments.npm_adoption_history and (
        not isinstance(arguments.source_commit, str)
        or re.fullmatch(r"[0-9a-f]{40}", arguments.source_commit) is None
    ):
        parser.error("--npm-adoption-history requires --source-commit")
    return arguments


def main() -> int:
    arguments = parse_arguments()
    try:
        adoption_pattern = (
            re.compile(r"npm-release-adoption-[1-9][0-9]*-[1-9][0-9]*\.json")
            if arguments.npm_adoption_history else None
        )
        client = GitHubClient()
        if arguments.prepare_draft:
            state = prepare_release(
                repository=arguments.repository,
                tag=arguments.tag,
                title=arguments.title,
                prerelease=arguments.prerelease,
                expected_names=set(arguments.expected_asset_name),
                adoption_pattern=adoption_pattern,
                client=client,
            )
            output = f"release_state={state}\n"
            github_output = os.environ.get("GITHUB_OUTPUT")
            if github_output:
                with Path(github_output).open("a", encoding="utf-8") as destination:
                    destination.write(output)
            else:
                print(output, end="")
            return 0
        assets = inspect_assets(arguments.assets)
        reconcile(
            repository=arguments.repository,
            tag=arguments.tag,
            title=arguments.title,
            prerelease=arguments.prerelease,
            assets=assets,
            client=client,
            source_commit=arguments.source_commit,
            adoption_pattern=adoption_pattern,
        )
    except (OSError, Rejected, RuntimeError) as error:
        print(f"release reconciliation rejected: {error}", file=sys.stderr)
        return 1
    print(f"Verified immutable GitHub release {arguments.repository}@{arguments.tag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
