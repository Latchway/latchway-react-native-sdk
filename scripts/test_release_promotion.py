#!/usr/bin/env python3
"""Adversarial tests for SDK promotion verification and workflow reachability."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/verify-release-promotion.py"
SPEC = importlib.util.spec_from_file_location("verify_release_promotion", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

REPOSITORY_BY_DIRECTORY = {
    "latchway-js": "javascript",
    "latchway-ios-sdk": "ios",
    "latchway-android": "android",
    "latchway-react-native-sdk": "react_native",
}
REPOSITORY_ID = REPOSITORY_BY_DIRECTORY[ROOT.name]
REPOSITORY_VERSION = "1.2.3"
REPOSITORY_TAG = f"v{REPOSITORY_VERSION}"
CORE_TAG = "v1.0.0"
OCI_DIGEST = "ghcr.io/latchway/latchway@sha256:" + "a" * 64
NOW = datetime(2026, 8, 29, 12, 0, tzinfo=timezone.utc)

PROTECTED_RELEASE_POLICY_IDS = {
    "promote": "latchway-release-controls-v1:latchway-react-native-sdk:github-release",
    "locked-sources": "latchway-release-controls-v1:latchway-react-native-sdk:private-sibling-read",
    "published-dependencies": "latchway-release-controls-v1:latchway-react-native-sdk:private-sibling-read",
    "authorize-release": "latchway-release-controls-v1:latchway-react-native-sdk:release-administration",
    "github-draft": "latchway-release-controls-v1:latchway-react-native-sdk:github-release",
    "npm-publish": "latchway-release-controls-v1:latchway-react-native-sdk:npm",
    "publish": "latchway-release-controls-v1:latchway-react-native-sdk:npm",
    "github-release-policy": "latchway-release-controls-v1:latchway-react-native-sdk:release-administration",
    "github-release": "latchway-release-controls-v1:latchway-react-native-sdk:github-release",
}
PROTECTED_RELEASE_SECRET_ALLOWLISTS = {
    "promote": set(),
    "locked-sources": set(),
    "published-dependencies": set(),
    "authorize-release": {"LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN"},
    "github-draft": set(),
    "npm-publish": set(),
    "publish": set(),
    "github-release-policy": {"LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN"},
    "github-release": set(),
}
EXPRESSION = re.compile(r"\$\{\{(?P<body>.*?)\}\}", re.DOTALL)
STATIC_SECRET = re.compile(
    r"\bsecrets\s*(?:\.\s*(?P<dot>[A-Za-z_][A-Za-z0-9_]*)|"
    r"\[\s*(?P<quote>['\"])(?P<bracket>[A-Za-z_][A-Za-z0-9_]*)"
    r"(?P=quote)\s*\])"
)


def workflow_job(workflow: str, name: str) -> str:
    anchor = f"\n  {name}:\n"
    start = workflow.find(anchor)
    if start < 0:
        raise AssertionError(f"workflow job {name} is missing")
    end_match = re.search(r"(?m)^  [a-z0-9][a-z0-9_-]*:\n", workflow[start + len(anchor) :])
    end = len(workflow) if end_match is None else start + len(anchor) + end_match.start()
    return workflow[start:end]


def first_workflow_step(job: str) -> str:
    steps = job.find("\n    steps:\n")
    if steps < 0:
        raise AssertionError("workflow job has no steps")
    start = job.find("\n      - ", steps)
    if start < 0:
        raise AssertionError("workflow job has no first step")
    end = job.find("\n      - ", start + 1)
    return job[start : len(job) if end < 0 else end]


def require_first_policy_sentinel(job: str, policy_id: str) -> None:
    first = first_workflow_step(job)
    expected_variable = (
        "LATCHWAY_RELEASE_CONTROL_POLICY_ID: "
        "${{ vars.LATCHWAY_RELEASE_CONTROL_POLICY_ID }}"
    )
    if "Fail closed unless" not in first or expected_variable not in first:
        raise AssertionError("protected job does not start with the policy sentinel")
    if f'"{policy_id}"' not in first:
        raise AssertionError("protected job sentinel has the wrong environment identity")
    if 'test "$LATCHWAY_RELEASE_CONTROL_POLICY_ID" = \\' not in first:
        raise AssertionError("protected job sentinel is not an exact equality check")
    for forbidden in (
        "uses:", "secrets.", "secrets[", "github.token", "ACTIONS_ID_TOKEN",
        "GH_TOKEN", "RELEASE_TOKEN", "curl ", "gh ",
    ):
        if forbidden in first:
            raise AssertionError(f"protected job sentinel has preflight authority: {forbidden}")


def secret_references(job: str) -> set[str]:
    references: set[str] = set()
    for expression in EXPRESSION.finditer(job):
        body = expression.group("body")
        if re.search(r"\bsecrets\b", body) is None:
            continue
        matches = list(STATIC_SECRET.finditer(body))
        scrubbed = STATIC_SECRET.sub("", body)
        if not matches or re.search(r"\bsecrets\b", scrubbed) is not None:
            raise AssertionError("dynamic or unparsed secret reference")
        for match in matches:
            references.add(match.group("dot") or match.group("bracket"))
    return references


def bash_function(job: str, name: str) -> str:
    functions = bash_functions(job, name)
    if not functions:
        raise AssertionError(f"workflow function {name} is missing")
    return functions[0]


def bash_functions(job: str, name: str) -> list[str]:
    anchor = f"          {name}() {{"
    functions: list[str] = []
    cursor = 0
    while (raw_start := job.find(anchor, cursor)) >= 0:
        start = raw_start + 10
        end = job.find("\n          }", start)
        if end < 0:
            raise AssertionError(f"workflow function {name} is incomplete")
        functions.append(
            job[start : end + len("\n          }")].replace("\n          ", "\n")
        )
        cursor = end + len("\n          }")
    return functions


def run_policy_lease_validator(
    function: str,
    function_name: str,
    phase: str,
    lease: dict[str, object],
    *,
    digest_override: str | None = None,
    json_override: str | None = None,
    now_override: int | None = None,
) -> subprocess.CompletedProcess[str]:
    lease_json = json_override or json.dumps(
        lease, sort_keys=True, separators=(",", ":")
    )
    digest = digest_override or hashlib.sha256(lease_json.encode("utf-8")).hexdigest()
    environment = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "GITHUB_REPOSITORY": "Latchway/latchway-react-native-sdk",
        "GITHUB_RUN_ID": "41",
        "GITHUB_RUN_ATTEMPT": "2",
        "RELEASE_COMMIT": "a" * 40,
        "RELEASE_TAG": "v1.0.0",
        "RELEASE_VERSION": "1.0.0",
        "AUTHORIZATION_LEASE_JSON": lease_json,
        "AUTHORIZATION_LEASE_SHA256": digest,
        "FINAL_POLICY_LEASE_JSON": lease_json,
        "FINAL_POLICY_LEASE_SHA256": digest,
    }
    if now_override is not None:
        original = function
        function = function.replace(
            "now=$(date -u +%s)", 'now="${LATCHWAY_TEST_NOW:?}"'
        )
        if function == original:
            raise AssertionError("lease validator does not read the current epoch")
        environment["LATCHWAY_TEST_NOW"] = str(now_override)
    return subprocess.run(
        ["/bin/bash", "-c", f"set -Eeuo pipefail\n{function}\n{function_name} {phase}\n"],
        check=False,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


class PromotionVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="latchway-sdk-promotion-")
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.write_version()
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Latchway promotion test")
        self.git("config", "user.email", "promotion-test@latchway.invalid")
        self.git("add", ".")
        self.git("commit", "-m", "test: promotion source")
        self.commit = self.git("rev-parse", "HEAD")
        self.report = self.build_report()
        self.report_path = self.root / "promotion.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_version(self) -> None:
        if REPOSITORY_ID in ("javascript", "react_native"):
            self.write(
                self.source / "package.json",
                json.dumps({"name": "@latchway/test", "version": REPOSITORY_VERSION})
                + "\n",
            )
        elif REPOSITORY_ID == "ios":
            self.write(
                self.source / "Sources/Latchway/LatchwayVersion.swift",
                'public enum LatchwayVersion {\n  public static let sdk = "1.2.3"\n}\n',
            )
        else:
            self.write(
                self.source
                / "latchway-core/src/main/kotlin/dev/latchway/core/LatchwayApi.kt",
                'public const val LATCHWAY_SDK_VERSION: String = "1.2.3"\n',
            )

    def build_report(self) -> dict[str, object]:
        repositories = []
        for index, repository_id in enumerate(MODULE.REPOSITORY_IDS):
            version = "1.0.0" if repository_id == "core" else (
                REPOSITORY_VERSION if repository_id == REPOSITORY_ID else f"1.{index}.0"
            )
            commit = self.commit if repository_id == REPOSITORY_ID else f"{index + 1:x}" * 40
            repositories.append(
                {
                    "id": repository_id,
                    "commit": commit,
                    "version": version,
                    "intended_tag": f"v{version}",
                }
            )
        domains = []
        for identifier in (
            "local_source",
            "local_promotion",
            "local_release",
            "live_sdk_conformance",
            "public_tags",
            "public_registries",
            "physical_devices",
            "live_provider",
            "cloud_deployments",
            "operational_resilience",
            "supply_chain",
        ):
            if identifier in MODULE.PROMOTION_DOMAINS:
                domains.append(
                    {
                        "id": identifier,
                        "required": True,
                        "status": "passed",
                        "started_at": "2026-08-29T10:30:00Z",
                        "finished_at": "2026-08-29T11:30:00Z",
                        "document_sha256": hashlib.sha256(
                            identifier.encode("utf-8")
                        ).hexdigest(),
                        "oci_image_digest": OCI_DIGEST,
                        "artifact_sha256": [
                            hashlib.sha256(f"artifact:{identifier}".encode()).hexdigest()
                        ],
                    }
                )
            else:
                required = identifier in ("local_source", "local_promotion")
                domains.append(
                    {
                        "id": identifier,
                        "required": required,
                        "status": "passed" if required else "unverified",
                        "started_at": None,
                        "finished_at": None,
                        "document_sha256": None,
                        "oci_image_digest": None,
                        "artifact_sha256": [],
                    }
                )
        return {
            "schema_version": 1,
            "kind": "latchway_cross_repository_conformance_evidence",
            "scope": "promotion",
            "verdict": "passed",
            "source_conformance_passed": True,
            "promotion_ready": True,
            "release_ready": False,
            "contract": {
                "version": "1.0.0",
                "status": "released",
                "released_at": "2026-08-29T10:00:00Z",
                "wire_protocol": 2,
                "bundle_file_name": "latchway-contract-1.0.0.tar.gz",
                "bundle_sha256": "b" * 64,
                "core_release": CORE_TAG,
                "oci_image_digest": OCI_DIGEST,
            },
            "repositories": repositories,
            "evidence_window": {
                "started_at": "2026-08-29T10:30:00Z",
                "finished_at": "2026-08-29T11:30:00Z",
                "maximum_age_seconds": 604800,
            },
            "evidence_domains": domains,
            "checks": [
                {
                    "id": f"promotion.{domain}",
                    "domain": domain,
                    "required": True,
                    "status": "passed",
                    "summary": f"{domain} evidence passed.",
                }
                for domain in sorted(MODULE.REQUIRED_DOMAINS)
            ]
            + [
                {
                    "id": f"promotion.{domain}",
                    "domain": domain,
                    "required": False,
                    "status": "unverified",
                    "summary": f"{domain} evidence is not part of promotion.",
                    "reason": "not_required_before_publication",
                }
                for domain in sorted(MODULE.UNVERIFIED_DOMAINS)
            ],
        }

    def verify(
        self,
        report: dict[str, object] | None = None,
        *,
        expected_sha256: str | None = None,
        report_url: str | None = None,
        repository_version: str = REPOSITORY_VERSION,
        repository_tag: str = REPOSITORY_TAG,
        workflow_commit: str | None = None,
    ) -> dict[str, str]:
        value = report if report is not None else self.report
        self.write(self.report_path, json.dumps(value, sort_keys=True) + "\n")
        digest = hashlib.sha256(self.report_path.read_bytes()).hexdigest()
        return MODULE.verify(
            self.report_path,
            self.source,
            report_url=report_url
            or (
                "https://github.com/Latchway/latchway/releases/download/"
                f"{CORE_TAG}/latchway-cross-repository-promotion.json"
            ),
            report_sha256=expected_sha256 or digest,
            repository_id=REPOSITORY_ID,
            repository_commit=self.commit,
            repository_version=repository_version,
            repository_tag=repository_tag,
            workflow_commit=workflow_commit or self.commit,
            core_tag=CORE_TAG,
            oci_image_digest=OCI_DIGEST,
            now=NOW,
        )

    def test_accepts_exact_attested_report_binding(self) -> None:
        result = self.verify()
        self.assertEqual(result["release_commit"], self.commit)
        self.assertEqual(result["release_tag"], REPOSITORY_TAG)
        self.assertEqual(result["core_tag"], CORE_TAG)
        self.assertEqual(result["oci_image_digest"], OCI_DIGEST)

    def test_rejects_hash_url_or_default_branch_substitution(self) -> None:
        cases = (
            {
                "expected_sha256": "f" * 64,
                "reason": "promotion_report_sha256_mismatch",
            },
            {
                "report_url": "https://example.invalid/promotion.json",
                "reason": "promotion_report_url_invalid",
            },
            {
                "workflow_commit": "f" * 40,
                "reason": "promotion_dispatch_coordinate_invalid",
            },
        )
        for case in cases:
            reason = case.pop("reason")
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(MODULE.PromotionVerificationError, reason):
                    self.verify(**case)

    def test_rejects_report_shape_coordinate_core_or_digest_substitution(self) -> None:
        mutations = (
            (
                lambda value: value.update(unexpected=True),
                "promotion_report_fields_invalid",
            ),
            (
                lambda value: next(
                    item
                    for item in value["repositories"]
                    if item["id"] == REPOSITORY_ID
                ).update(commit="f" * 40),
                "promotion_repository_binding_mismatch",
            ),
            (
                lambda value: value["contract"].update(core_release="v1.0.1"),
                "promotion_contract_invalid",
            ),
            (
                lambda value: value["contract"].update(
                    oci_image_digest="ghcr.io/latchway/latchway@sha256:" + "f" * 64
                ),
                "promotion_contract_invalid",
            ),
        )
        for mutate, reason in mutations:
            report = deepcopy(self.report)
            mutate(report)
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(MODULE.PromotionVerificationError, reason):
                    self.verify(report)

    def test_rejects_incomplete_domains_failed_checks_and_future_window(self) -> None:
        cases = []
        missing = deepcopy(self.report)
        missing["evidence_domains"] = missing["evidence_domains"][:-1]
        cases.append((missing, "promotion_evidence_domains_invalid"))
        failed = deepcopy(self.report)
        failed["checks"][0]["status"] = "failed"
        cases.append((failed, "promotion_required_check_failed"))
        future = deepcopy(self.report)
        future["evidence_window"]["finished_at"] = "2026-08-29T12:00:01Z"
        cases.append((future, "promotion_evidence_window_invalid"))
        for report, reason in cases:
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(MODULE.PromotionVerificationError, reason):
                    self.verify(report)

    def test_rejects_payload_or_local_version_mismatch(self) -> None:
        with self.assertRaisesRegex(
            MODULE.PromotionVerificationError, "promotion_local_version_mismatch"
        ):
            self.verify(repository_version="9.9.9", repository_tag="v9.9.9")

    def test_rejects_dirty_source_duplicate_json_and_symlinked_report(self) -> None:
        self.write(self.source / "untracked.txt", "not part of promoted source\n")
        with self.assertRaisesRegex(
            MODULE.PromotionVerificationError, "promotion_local_worktree_dirty"
        ):
            self.verify()

        duplicate = self.root / "duplicate.json"
        self.write(duplicate, '{"schema_version":1,"schema_version":1}\n')
        with self.assertRaisesRegex(
            MODULE.PromotionVerificationError, "promotion_report_duplicate_key"
        ):
            MODULE.load_json(duplicate)

        regular = self.root / "regular.json"
        self.write(regular, "{}\n")
        symlink = self.root / "symlink.json"
        symlink.symlink_to(regular)
        with self.assertRaisesRegex(
            MODULE.PromotionVerificationError, "promotion_report_file_invalid"
        ):
            MODULE.sha256_file(symlink)

    def test_rejects_inconsistent_or_non_schema_check_evidence(self) -> None:
        cases = []
        missing_required_domain = deepcopy(self.report)
        missing_required_domain["checks"] = [
            check
            for check in missing_required_domain["checks"]
            if check["domain"] != "supply_chain"
        ]
        cases.append((missing_required_domain, "promotion_checks_invalid"))

        invalid_details = deepcopy(self.report)
        invalid_details["checks"][0]["details"] = {"nested": {"too": {"deep": True}}}
        cases.append((invalid_details, "promotion_checks_invalid"))

        premature_publication = deepcopy(self.report)
        public_check = next(
            check
            for check in premature_publication["checks"]
            if check["domain"] == "public_tags"
        )
        public_check["status"] = "passed"
        cases.append((premature_publication, "promotion_checks_invalid"))

        not_ready = deepcopy(self.report)
        not_ready["promotion_ready"] = False
        cases.append((not_ready, "promotion_report_not_ready"))

        stale_contract = deepcopy(self.report)
        stale_contract["contract"]["released_at"] = "2026-08-20T10:00:00Z"
        cases.append((stale_contract, "promotion_contract_invalid"))

        for report, reason in cases:
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(MODULE.PromotionVerificationError, reason):
                    self.verify(report)

    def git(self, *arguments: str) -> str:
        result = subprocess.run(
            ["git", "-C", str(self.source), *arguments],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return result.stdout.strip()

    @staticmethod
    def write(path: Path, contents: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")


class ReleaseWorkflowTests(unittest.TestCase):
    def test_release_docs_delegate_tag_creation_to_promoted_dispatch(self) -> None:
        documentation = (ROOT / "docs/releasing.md").read_text(encoding="utf-8")
        self.assertIn("repository_dispatch", documentation)
        self.assertIn("tag manually", documentation.lower())
        self.assertNotIn("\ngit tag ", documentation)
        self.assertNotIn("\ngit push", documentation)

    def test_sibling_reads_are_public_only_and_never_fall_back_to_a_secret(self) -> None:
        if REPOSITORY_ID != "react_native":
            self.skipTest("React Native-only sibling checkout policy")
        release = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        sibling_checkouts = release.count("repository: Latchway/")
        self.assertGreater(sibling_checkouts, 0)
        self.assertEqual(release.count("token: ${{ github.token }}"), sibling_checkouts)
        self.assertNotIn("secrets.LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN", release)

        locked_sources = (
            ROOT / ".github/workflows/locked-sources.yml"
        ).read_text(encoding="utf-8")
        self.assertNotIn("repository: Latchway/", locked_sources)
        self.assertNotIn("secrets.", locked_sources)
        self.assertEqual(locked_sources.count("environment: private-sibling-read"), 1)
        require_first_policy_sentinel(
            workflow_job(locked_sources, "authenticate-inputs"),
            PROTECTED_RELEASE_POLICY_IDS["locked-sources"],
        )
        self.assertIn("bundle_locked_repository Latchway/latchway-js", locked_sources)
        self.assertIn("bundle_locked_repository Latchway/latchway-android", locked_sources)
        self.assertIn("bundle_locked_repository Latchway/latchway-ios-sdk", locked_sources)
        self.assertIn(
            'bundle_locked_repository Latchway/latchway "$CORE_COMMIT"',
            locked_sources,
        )
        self.assertNotIn('if [[ -n "$LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN" ]]', locked_sources)
        self.assertIn(
            "printf '%s\\n' '#!/usr/bin/env bash' 'exit 1' > \"$git_askpass\"",
            locked_sources,
        )
        self.assertEqual(locked_sources.count("fetch --no-tags"), 1)
        documentation = (ROOT / "docs/releasing.md").read_text(encoding="utf-8")
        self.assertIn("repositories to be public\nbefore promotion", documentation)
        self.assertIn("contains no\nsecret", documentation)
        self.assertIn("credential-helper-disabled anonymous HTTPS", documentation)
        self.assertIn("Never define\n`LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN`", documentation)
        self.assertIn(
            "`private-sibling-read`\nenvironment as a credential-free protected approval boundary",
            documentation,
        )

    def test_pull_request_workflow_cannot_receive_private_sibling_credentials(self) -> None:
        if REPOSITORY_ID != "react_native":
            self.skipTest("React Native-only pull-request credential policy")
        pull_request = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        self.assertIn("pull_request:", pull_request)
        self.assertNotIn("secrets.", pull_request)
        self.assertNotIn("LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN", pull_request)
        self.assertNotIn("repository: Latchway/", pull_request)

        protected = (ROOT / ".github/workflows/locked-sources.yml").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("pull_request:", protected)
        self.assertIn("branches: [main]", protected)
        self.assertIn("workflow_dispatch:", protected)
        self.assertIn("environment: private-sibling-read", protected)
        self.assertIn("github.ref == 'refs/heads/main'", protected)

        consumer = (ROOT / ".github/workflows/native-consumer.yml").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("pull_request:", consumer)
        self.assertIn("environment: private-sibling-read", consumer)
        self.assertIn("github.ref == 'refs/heads/main'", consumer)

    def test_native_consumer_credentials_are_isolated_from_candidate_code(self) -> None:
        if REPOSITORY_ID != "react_native":
            self.skipTest("React Native-only published consumer policy")
        workflow = (ROOT / ".github/workflows/native-consumer.yml").read_text(
            encoding="utf-8"
        )
        authenticated = workflow.split("\n  authenticate-inputs:\n", 1)[1].split(
            "\n  android:\n", 1
        )[0]
        consumers = workflow.split("\n  android:\n", 1)[1]

        self.assertNotIn("actions/checkout", authenticated)
        self.assertNotIn("working-directory:", authenticated)
        self.assertNotIn("node scripts/", authenticated)
        self.assertIn("environment: private-sibling-read", authenticated)
        self.assertNotIn("secrets.", authenticated)
        self.assertEqual(authenticated.count("${{ github.token }}"), 2)
        require_first_policy_sentinel(
            workflow_job(workflow, "authenticate-inputs"),
            PROTECTED_RELEASE_POLICY_IDS["locked-sources"],
        )
        self.assertIn(
            "repos/$GITHUB_REPOSITORY/contents/$path?ref=$GITHUB_SHA",
            authenticated,
        )
        self.assertIn("jq --exit-status", authenticated)
        self.assertIn("git init --bare", authenticated)
        self.assertIn("locked-latchway-js.bundle", authenticated)
        self.assertIn("authenticate_tag()", authenticated)
        self.assertIn("authenticate_release()", authenticated)
        self.assertIn("gh release verify-asset", authenticated)
        self.assertIn("gh attestation verify", authenticated)
        self.assertIn("MANIFEST.sha256", authenticated)
        self.assertEqual(authenticated.count("actions/upload-artifact@"), 1)

        self.assertNotIn("environment: private-sibling-read", consumers)
        self.assertNotIn("secrets.", consumers)
        self.assertNotIn("repository: Latchway/", consumers)
        self.assertNotIn("GH_TOKEN: ${{", consumers)
        self.assertNotIn("registry-url:", consumers)
        self.assertEqual(consumers.count("needs: authenticate-inputs"), 2)
        self.assertEqual(consumers.count("actions/download-artifact@"), 2)
        self.assertEqual(consumers.count("persist-credentials: false"), 2)
        self.assertIn("LATCHWAY_AUTHENTICATED_DEPENDENCY_INPUTS", consumers)
        self.assertIn("ACTIONS_ID_TOKEN_REQUEST_URL", consumers)
        self.assertIn(
            'cmp -s "$root/release-compatibility.json"', consumers
        )
        self.assertIn(
            'git clone --no-local "$root/locked-latchway-js.bundle"', consumers
        )

    def test_only_attested_core_dispatch_can_reach_tag_and_publication(self) -> None:
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        self.assertIn("repository_dispatch:", workflow)
        self.assertIn("latchway_release_promoted", workflow)
        self.assertNotIn("\n  push:", workflow)
        self.assertNotIn("\n    tags:", workflow)
        self.assertIn("github.event.client_payload.repository.commit", workflow)
        self.assertIn("test \"$GITHUB_SHA\" = \"$SDK_COMMIT\"", workflow)
        self.assertIn(
            "https://github.com/Latchway/latchway/releases/download/$CORE_TAG/"
            "latchway-cross-repository-promotion.json",
            workflow,
        )
        self.assertIn("--proto-redir '=https'", workflow)
        self.assertIn("--max-filesize 2097152", workflow)
        self.assertNotIn("secrets.LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN", workflow)
        self.assertIn("token: ${{ github.token }}", workflow)
        self.assertIn("latchway-core-release-auth", workflow)
        self.assertIn("trap 'rm -f -- \"$auth_config\"' EXIT", workflow)
        self.assertIn("--config \"$auth_config\"", workflow)
        self.assertIn("rm -f -- \"$auth_config\"", workflow)
        self.assertNotIn('--header "Authorization: Bearer $CORE_READ_TOKEN"', workflow)
        self.assertIn("sha256sum --check --strict", workflow)
        self.assertIn(
            "--signer-workflow Latchway/latchway/.github/workflows/"
            "cross-repository-conformance.yml",
            workflow,
        )
        self.assertIn("--source-ref refs/heads/main", workflow)
        self.assertIn("--deny-self-hosted-runners", workflow)
        self.assertIn(
            f"--repository-id {REPOSITORY_ID}",
            workflow,
        )
        self.assertIn(f'test "$SDK_ID" = {REPOSITORY_ID}', workflow)
        self.assertIn("attestations: read", workflow)
        self.assertIn('{tag: $tag, message: $message, object: $object, type: "commit"', workflow)
        self.assertNotIn("git tag ", workflow)
        self.assertNotIn("git push", workflow)
        download = workflow.index("Download and hash the exact core promotion report")
        attestation = workflow.index("Verify the core workflow artifact attestation")
        verifier = workflow.index("python3 scripts/verify-release-promotion.py")
        tag = workflow.index("Create or verify evidence-gated annotated SDK tag")
        self.assertLess(download, attestation)
        self.assertLess(attestation, verifier)
        self.assertLess(verifier, tag)
        publication_markers = {
            "javascript": '"$LATCHWAY_NPM_CLI" publish "$archive"',
            "ios": "pod trunk push Latchway.podspec",
            "android": "scripts/publish-central.sh",
            "react_native": '"$LATCHWAY_NPM_CLI" publish "$archive"',
        }
        self.assertLess(tag, workflow.index(publication_markers[REPOSITORY_ID]))
        if REPOSITORY_ID == "react_native":
            dependency_job = workflow_job(workflow, "published-dependencies")
            locked_sources_job = workflow_job(workflow, "locked-sources")
            consumer_job = workflow_job(workflow, "verify")
            self.assertIn("needs: verify-promotion", dependency_job)
            self.assertIn("needs: verify-promotion", locked_sources_job)
            self.assertIn(
                "needs: [promote, locked-sources, published-dependencies]",
                consumer_job,
            )
            documentation = (ROOT / "docs/releasing.md").read_text(encoding="utf-8")
            self.assertIn(
                "starts three parallel branches: one creates\n"
                "   or verifies the protected annotated",
                documentation,
            )
            self.assertIn(
                "the irreversible tag exists before those gates execute",
                documentation,
            )
        self.assertIn("persist-credentials: false", workflow)
        if REPOSITORY_ID == "javascript":
            self.assertIn("needs: [promote, verify]", workflow)
        elif REPOSITORY_ID in ("ios", "android"):
            self.assertIn("needs: promote", workflow)

    def test_promotion_credentials_never_share_a_runner_with_candidate_code(self) -> None:
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        authorization = workflow.split("\n  authorize-promotion:\n", 1)[1].split(
            "\n  verify-promotion:\n", 1
        )[0]
        verification = workflow.split("\n  verify-promotion:\n", 1)[1].split(
            "\n  promote:\n", 1
        )[0]
        following_job = {
            "javascript": "verify",
            "react_native": "locked-sources",
            "ios": "publish",
            "android": "publish",
        }[REPOSITORY_ID]
        tag_mutation = workflow.split("\n  promote:\n", 1)[1].split(
            f"\n  {following_job}:\n", 1
        )[0]

        self.assertNotIn("actions/checkout", authorization)
        self.assertNotIn("scripts/", authorization)
        self.assertNotIn("python3 ", authorization)
        self.assertNotIn("node ", authorization)
        self.assertNotIn("secrets.", authorization)
        self.assertNotIn("LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN", authorization)
        self.assertEqual(authorization.count("${{ github.token }}"), 2)
        self.assertIn("gh attestation verify", authorization)

        self.assertIn("actions/checkout", verification)
        self.assertIn("python3 scripts/verify-release-promotion.py", verification)
        self.assertNotIn("secrets.", verification)
        self.assertNotIn("GH_TOKEN: ${{", verification)

        self.assertNotIn("actions/checkout", tag_mutation)
        self.assertNotIn("scripts/", tag_mutation)
        self.assertNotIn("python3 ", tag_mutation)
        self.assertNotIn("node ", tag_mutation)
        self.assertIn("GH_TOKEN: ${{ github.token }}", tag_mutation)
        self.assertIn("gh api", tag_mutation)
        self.assertNotIn("GIT_TAG_READ_TOKEN", workflow)
        self.assertNotIn("git_with_auth()", workflow)

    def test_react_native_publication_still_waits_for_all_dependency_releases(self) -> None:
        if REPOSITORY_ID != "react_native":
            self.skipTest("React Native-only dependency ordering")
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        dependency = workflow.index("node scripts/verify-published-dependencies.mjs --all")
        publish = workflow.index('"$LATCHWAY_NPM_CLI" publish "$archive"')
        self.assertLess(dependency, publish)
        self.assertIn(
            "Validate authenticated release inputs and wait for exact public registry bytes",
            workflow,
        )
        self.assertIn("for attempt in $(seq 1 180)", workflow)
        self.assertIn("LATCHWAY_AUTHENTICATED_DEPENDENCY_INPUTS", workflow)
        self.assertIn("Authenticate published sibling inputs without candidate checkout", workflow)
        self.assertIn("gh release verify-asset", workflow)
        self.assertIn("gh attestation verify", workflow)
        self.assertIn("sleep 30", workflow)
        self.assertIn(
            "needs: [promote, verify, android, ios, trusted-npm-cli, "
            "github-draft, npm-publish]",
            workflow,
        )

        authenticated = workflow.split("\n  published-dependencies:\n", 1)[1].split(
            "\n  verify:\n", 1
        )[0]
        self.assertNotIn("actions/checkout", authenticated)
        self.assertNotIn("scripts/", authenticated)
        self.assertNotIn("node ", authenticated)
        self.assertNotIn("secrets.", authenticated)
        self.assertIn("GH_TOKEN: ${{ github.token }}", authenticated)
        verification = workflow.split("\n  verify:\n", 1)[1].split("\n  android:\n", 1)[0]
        self.assertNotIn("secrets.", verification)
        self.assertNotIn("GH_TOKEN: ${{", verification)

    def test_github_release_retry_never_overwrites_assets(self) -> None:
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        draft = workflow.index("Create or verify GitHub draft with fixed API calls")
        registry = workflow.index('"$LATCHWAY_NPM_CLI" publish "$archive"')
        final_step = workflow.index(
            "Reconcile, publish, and verify immutable release with fixed API calls"
        )
        self.assertLess(draft, registry)
        self.assertLess(registry, final_step)
        self.assertNotIn("--clobber", workflow)
        self.assertNotIn("python3 scripts/reconcile-github-release.py", workflow)
        draft_block = workflow.split("\n  github-draft:\n", 1)[1].split(
            "\n  npm-publish:\n", 1
        )[0]
        self.assertIn(
            '. == ("docs-bundle-" + $version + ".tar.gz")', draft_block
        )
        for job_name in ("github-draft", "github-release"):
            block = workflow.split(f"\n  {job_name}:\n", 1)[1]
            if job_name == "github-draft":
                block = block.split("\n  npm-publish:\n", 1)[0]
            self.assertNotIn("actions/checkout", block)
            self.assertNotIn("scripts/", block)
            self.assertNotIn("python3 ", block)
            self.assertNotIn("node ", block)

    def test_react_native_release_authorities_use_separate_protected_environments(
        self,
    ) -> None:
        if REPOSITORY_ID != "react_native":
            self.skipTest("React Native-only release authority policy")
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        authorization = workflow.split("\n  authorize-release:\n", 1)[1].split(
            "\n  trusted-npm-cli:\n", 1
        )[0]
        draft = workflow.split("\n  github-draft:\n", 1)[1].split(
            "\n  npm-publish:\n", 1
        )[0]
        npm_publication = workflow.split("\n  npm-publish:\n", 1)[1].split(
            "\n  publish:\n", 1
        )[0]
        registry_evidence = workflow.split("\n  publish:\n", 1)[1].split(
            "\n  github-release-policy:\n", 1
        )[0]
        policy = workflow.split("\n  github-release-policy:\n", 1)[1].split(
            "\n  github-release:\n", 1
        )[0]
        release = workflow.split("\n  github-release:\n", 1)[1]

        self.assertIn(
            "needs: [promote, verify, android, ios, trusted-npm-cli]",
            authorization,
        )
        self.assertIn("environment: release-administration", authorization)
        self.assertIn("permissions: {}", authorization)
        self.assertIn("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", authorization)
        for forbidden in (
            "actions/checkout", "scripts/", "github.token", "id-token:",
            "attestations:", "contents:",
        ):
            self.assertNotIn(forbidden, authorization)

        self.assertIn("needs: [promote, authorize-release]", draft)
        self.assertIn("environment: github-release", draft)
        self.assertIn("permissions:\n      contents: write", draft)
        self.assertNotIn("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", draft)
        self.assertIn("environment: npm", npm_publication)
        self.assertIn("environment: npm", registry_evidence)
        self.assertNotIn("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", npm_publication)
        self.assertNotIn("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", registry_evidence)

        self.assertIn("environment: release-administration", policy)
        self.assertIn("permissions: {}", policy)
        self.assertIn("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", policy)
        self.assertNotIn("id-token: write", policy)
        self.assertNotIn("attestations: write", policy)
        self.assertIn("environment: github-release", release)
        self.assertIn(
            "permissions:\n      actions: read\n      attestations: write\n"
            "      contents: write\n      id-token: write",
            release,
        )
        self.assertNotIn("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", release)

        self.assertEqual(workflow.count("environment: npm"), 2)
        self.assertEqual(workflow.count("environment: release-administration"), 2)
        self.assertEqual(workflow.count("environment: github-release"), 3)
        self.assertEqual(
            workflow.count("secrets.LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN"), 2
        )

        documentation = (ROOT / "docs/releasing.md").read_text(encoding="utf-8")
        self.assertIn(
            "`private-sibling-read`, `npm`, `release-administration`, and\n"
            "`github-release`",
            documentation,
        )
        self.assertIn(
            "Every environment must require at least one reviewer, set\n"
            "`prevent_self_review: true`, use an exact main-only custom deployment branch",
            documentation,
        )
        self.assertIn(
            "`npm` environment is limited to trusted npm publication",
            documentation,
        )
        self.assertIn(
            "`release-administration` environment contains only a fine-grained",
            documentation,
        )
        self.assertIn(
            "`github-release` protects the promotion job that creates or verifies the\n"
            "annotated tag as well as the separate draft and final GitHub release mutation",
            documentation,
        )
        self.assertIn(
            "`LATCHWAY_RELEASE_CONTROL_POLICY_ID`, with no repository- or organization-level\n"
            "fallback",
            documentation,
        )
        self.assertIn("disable administrator bypass", documentation)
        self.assertIn(
            "Never define\n`LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN` at environment, repository, or\n"
            "organization scope",
            documentation,
        )

    def test_protected_release_jobs_start_with_unique_sentinels_and_exact_secret_allowlists(
        self,
    ) -> None:
        if REPOSITORY_ID != "react_native":
            self.skipTest("React Native-only protected release policy")
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        for job_name, policy_id in PROTECTED_RELEASE_POLICY_IDS.items():
            with self.subTest(job=job_name):
                job = workflow_job(workflow, job_name)
                require_first_policy_sentinel(job, policy_id)
                self.assertEqual(
                    secret_references(job),
                    PROTECTED_RELEASE_SECRET_ALLOWLISTS[job_name],
                )

        authorization = workflow_job(workflow, "authorize-release")
        wrong_value = authorization.replace(
            PROTECTED_RELEASE_POLICY_IDS["authorize-release"],
            "latchway-release-controls-v1:latchway-react-native-sdk:npm",
            1,
        )
        with self.assertRaisesRegex(AssertionError, "wrong environment identity"):
            require_first_policy_sentinel(
                wrong_value, PROTECTED_RELEASE_POLICY_IDS["authorize-release"]
            )
        action_first = authorization.replace(
            "\n    steps:\n",
            "\n    steps:\n      - uses: actions/checkout@attacker\n",
            1,
        )
        with self.assertRaisesRegex(AssertionError, "does not start"):
            require_first_policy_sentinel(
                action_first, PROTECTED_RELEASE_POLICY_IDS["authorize-release"]
            )

        bracket_fallback = authorization.replace(
            "secrets.LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN",
            "secrets['LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN'] || secrets[\"EVIL_TOKEN\"]",
            1,
        )
        self.assertEqual(
            secret_references(bracket_fallback),
            {"LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", "EVIL_TOKEN"},
        )
        dynamic = authorization.replace(
            "secrets.LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN",
            "secrets[inputs.secret_name]",
            1,
        )
        with self.assertRaisesRegex(AssertionError, "dynamic or unparsed"):
            secret_references(dynamic)

    def test_release_policy_leases_reject_replay_drift_and_stale_authority(self) -> None:
        if REPOSITORY_ID != "react_native":
            self.skipTest("React Native-only protected release policy")
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        now = int(time.time())

        promote = workflow_job(workflow, "promote")
        self.assertIn("needs: verify-promotion", promote)
        self.assertIn("GH_TOKEN: ${{ github.token }}", promote)
        self.assertEqual(promote.count("gh api --method POST"), 2)
        self.assertNotIn("secrets.", promote)
        self.assertNotIn("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", promote)
        documentation = (ROOT / "docs/releasing.md").read_text(encoding="utf-8")
        self.assertIn(
            "Annotated tag creation is the one release mutation that\n"
            "uses the authenticated core-promotion report and tag ruleset as its authority;\n"
            "it deliberately precedes immutable-release authorization",
            documentation,
        )

        def lease(phase: str) -> dict[str, object]:
            return {
                "expires_at_epoch": now + 595,
                "issued_at_epoch": now - 5,
                "kind": "latchway_release_policy_lease",
                "phase": phase,
                "policy_id": (
                    "latchway-release-controls-v1:latchway-react-native-sdk:"
                    "release-administration"
                ),
                "release_commit": "a" * 40,
                "release_tag": "v1.0.0",
                "release_version": "1.0.0",
                "repository": "Latchway/latchway-react-native-sdk",
                "run_attempt": 2,
                "run_id": 41,
                "schema_version": 1,
                "settings": {"enabled": True, "enforced_by_owner": True},
            }

        npm_job = workflow_job(workflow, "npm-publish")
        authorization_function = bash_function(
            npm_job, "validate_release_policy_lease"
        )
        valid_authorization = lease("draft-and-npm")
        result = run_policy_lease_validator(
            authorization_function,
            "validate_release_policy_lease",
            "draft-and-npm",
            valid_authorization,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

        adversarial: list[tuple[str, dict[str, object]]] = []
        for name, mutate in (
            ("wrong phase", lambda value: value.update(phase="final-github-release")),
            ("wrong repository", lambda value: value.update(repository="attacker/repo")),
            ("wrong run", lambda value: value.update(run_id=42)),
            ("wrong attempt", lambda value: value.update(run_attempt=1)),
            ("string run", lambda value: value.update(run_id="41")),
            ("string attempt", lambda value: value.update(run_attempt="2")),
            ("fractional run", lambda value: value.update(run_id=41.5)),
            ("zero attempt", lambda value: value.update(run_attempt=0)),
            (
                "unsafe integer run",
                lambda value: value.update(run_id=9_007_199_254_740_992),
            ),
            ("wrong release", lambda value: value.update(release_commit="f" * 40)),
            ("extra field", lambda value: value.update(unexpected=True)),
            (
                "owner enforcement off",
                lambda value: value["settings"].update(enforced_by_owner=False),
            ),
            (
                "expired",
                lambda value: value.update(
                    issued_at_epoch=now - 700, expires_at_epoch=now - 100
                ),
            ),
            (
                "overlong",
                lambda value: value.update(
                    issued_at_epoch=now - 1, expires_at_epoch=now + 600
                ),
            ),
            (
                "future",
                lambda value: value.update(
                    issued_at_epoch=now + 10, expires_at_epoch=now + 610
                ),
            ),
        ):
            candidate = deepcopy(valid_authorization)
            candidate["settings"] = dict(candidate["settings"])
            mutate(candidate)
            adversarial.append((name, candidate))
        for name, candidate in adversarial:
            with self.subTest(case=name):
                rejected = run_policy_lease_validator(
                    authorization_function,
                    "validate_release_policy_lease",
                    "draft-and-npm",
                    candidate,
                )
                self.assertNotEqual(rejected.returncode, 0, name)

        exact_expiry = deepcopy(valid_authorization)
        exact_expiry.update(
            issued_at_epoch=now - 600,
            expires_at_epoch=now,
        )
        expiry_result = run_policy_lease_validator(
            authorization_function,
            "validate_release_policy_lease",
            "draft-and-npm",
            exact_expiry,
            now_override=now,
        )
        self.assertNotEqual(expiry_result.returncode, 0)

        bad_hash = run_policy_lease_validator(
            authorization_function,
            "validate_release_policy_lease",
            "draft-and-npm",
            valid_authorization,
            digest_override="f" * 64,
        )
        self.assertNotEqual(bad_hash.returncode, 0)
        canonical = json.dumps(
            valid_authorization, sort_keys=True, separators=(",", ":")
        )
        noncanonical = run_policy_lease_validator(
            authorization_function,
            "validate_release_policy_lease",
            "draft-and-npm",
            valid_authorization,
            json_override=canonical + " ",
        )
        self.assertNotEqual(noncanonical.returncode, 0)
        duplicate = canonical.replace(
            '"phase":"draft-and-npm"',
            '"phase":"draft-and-npm","phase":"draft-and-npm"',
            1,
        )
        duplicate_result = run_policy_lease_validator(
            authorization_function,
            "validate_release_policy_lease",
            "draft-and-npm",
            valid_authorization,
            json_override=duplicate,
        )
        self.assertNotEqual(duplicate_result.returncode, 0)

        final_job = workflow_job(workflow, "github-release")
        final_function = bash_function(final_job, "validate_final_policy_lease")
        valid_final = lease("final-github-release")
        final_result = run_policy_lease_validator(
            final_function,
            "validate_final_policy_lease",
            "final-github-release",
            valid_final,
        )
        self.assertEqual(final_result.returncode, 0, final_result.stderr)
        wrong_final_phase = run_policy_lease_validator(
            final_function,
            "validate_final_policy_lease",
            "final-github-release",
            valid_authorization,
        )
        self.assertNotEqual(wrong_final_phase.returncode, 0)
        self.assertEqual(
            workflow.count(
                ".issued_at_epoch <= $now and $now < .expires_at_epoch"
            ),
            7,
        )
        self.assertNotIn("$now <= .expires_at_epoch", workflow)
        self.assertEqual(workflow.count("(.run_id | type) == \"number\""), 7)
        self.assertEqual(
            workflow.count(".run_id <= 9007199254740991"),
            7,
        )
        self.assertEqual(
            workflow.count(".run_attempt <= 9007199254740991"),
            7,
        )
        draft_job = workflow_job(workflow, "github-draft")
        authorization_consumers = [
            *bash_functions(draft_job, "validate_release_policy_lease"),
            *bash_functions(npm_job, "validate_release_policy_lease"),
        ]
        final_consumers = bash_functions(final_job, "validate_final_policy_lease")
        self.assertEqual(len(authorization_consumers), 4)
        self.assertEqual(len(final_consumers), 3)
        for index, (consumer, function_name, phase, valid_lease) in enumerate(
            [
                *(
                    (
                        function,
                        "validate_release_policy_lease",
                        "draft-and-npm",
                        valid_authorization,
                    )
                    for function in authorization_consumers
                ),
                *(
                    (
                        function,
                        "validate_final_policy_lease",
                        "final-github-release",
                        valid_final,
                    )
                    for function in final_consumers
                ),
            ],
            start=1,
        ):
            accepted = run_policy_lease_validator(
                consumer,
                function_name,
                phase,
                valid_lease,
                now_override=now,
            )
            self.assertEqual(accepted.returncode, 0, f"consumer {index}: {accepted.stderr}")
            for invalid in (
                {**valid_lease, "run_id": "41"},
                {**valid_lease, "run_attempt": 2.5},
                {**valid_lease, "run_id": 9_007_199_254_740_992},
                {
                    **valid_lease,
                    "issued_at_epoch": now - 600,
                    "expires_at_epoch": now,
                },
            ):
                rejected = run_policy_lease_validator(
                    consumer,
                    function_name,
                    phase,
                    invalid,
                    now_override=now,
                )
                self.assertNotEqual(rejected.returncode, 0, f"consumer {index}")

        authorization = workflow_job(workflow, "authorize-release")
        self.assertIn(
            "needs: [promote, verify, android, ios, trusted-npm-cli]",
            authorization,
        )
        self.assertIn(
            "policy_lease_json: ${{ steps.policy.outputs.lease_json }}",
            authorization,
        )
        self.assertIn(
            "policy_lease_sha256: ${{ steps.policy.outputs.lease_sha256 }}",
            authorization,
        )
        self.assertNotRegex(
            authorization,
            r"actions/(?:upload|download)-artifact@",
        )
        final_policy = workflow_job(workflow, "github-release-policy")
        self.assertIn(
            "policy_lease_json: ${{ steps.policy.outputs.lease_json }}",
            final_policy,
        )
        self.assertIn(
            "policy_lease_sha256: ${{ steps.policy.outputs.lease_sha256 }}",
            final_policy,
        )
        self.assertNotRegex(
            final_policy,
            r"actions/(?:upload|download)-artifact@",
        )
        for producer in (authorization, final_policy):
            self.assertIn('--argjson run_id "$GITHUB_RUN_ID"', producer)
            self.assertIn('--argjson run_attempt "$GITHUB_RUN_ATTEMPT"', producer)
            self.assertNotIn('--arg run_id "$GITHUB_RUN_ID"', producer)
            self.assertNotIn('--arg run_attempt "$GITHUB_RUN_ATTEMPT"', producer)
        draft = draft_job
        self.assertIn(
            "AUTHORIZATION_LEASE_JSON: "
            "${{ needs.authorize-release.outputs.policy_lease_json }}",
            draft,
        )
        self.assertLess(
            draft.rfind("validate_release_policy_lease draft-and-npm"),
            draft.index('gh release create "$RELEASE_TAG"'),
        )
        self.assertEqual(
            draft[draft.rfind("validate_release_policy_lease draft-and-npm") :]
            .splitlines()[1]
            .lstrip()
            .split(" ", 1)[0],
            "gh",
        )
        self.assertRegex(
            npm_job,
            r"validate_release_policy_lease draft-and-npm\n"
            r" {6}- name: Attest reviewed npm package",
        )
        npm_mutation = npm_job.index('"$LATCHWAY_NPM_CLI" publish "$archive"')
        self.assertGreater(
            npm_job.rfind("validate_release_policy_lease draft-and-npm", 0, npm_mutation),
            npm_job.index("Publish or adopt exact npm bytes with fixed commands"),
        )
        self.assertRegex(
            final_job,
            r"validate_final_policy_lease final-github-release\n"
            r" {6}- name: Attest exact retained registry and release evidence",
        )
        final_mutation = final_job.index('gh release edit "$RELEASE_TAG"')
        self.assertGreater(
            final_job.rfind(
                "validate_final_policy_lease final-github-release", 0, final_mutation
            ),
            final_job.index("Reconcile, publish, and verify immutable release"),
        )
        tag_ref_endpoint = (
            'gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$RELEASE_TAG"'
        )
        self.assertEqual(final_job.count(tag_ref_endpoint), 2)
        post_finalization_tag = final_job.index(
            '"$RUNNER_TEMP/post-finalization-tag-ref.json"'
        )
        self.assertGreater(
            post_finalization_tag,
            final_job.rfind("gh release verify-asset"),
        )
        self.assertIn(
            'gh api "repos/$GITHUB_REPOSITORY/git/tags/$final_tag_object"',
            final_job[post_finalization_tag:],
        )
        self.assertIn(
            ".sha == $object and .tag == $tag and .object.type == \"commit\" and",
            final_job[post_finalization_tag:],
        )
        self.assertIn(
            ".object.sha == $commit",
            final_job[post_finalization_tag:],
        )
        self.assertIn("**Re-run all\njobs**", documentation)
        self.assertIn("Never use **Re-run failed jobs**", documentation)
        self.assertIn("tag already exists", documentation)
        self.assertIn("validity interval is half-open", documentation)

    def test_ci_runs_checksum_pinned_actionlint_over_every_workflow(self) -> None:
        if REPOSITORY_ID != "react_native":
            self.skipTest("React Native-only workflow lint policy")
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        pull_request = workflow_job(ci, "pull-request")
        installer = (ROOT / "scripts/install-actionlint.mjs").read_text(
            encoding="utf-8"
        )
        mise = (ROOT / "mise.toml").read_text(encoding="utf-8")

        self.assertIn("runs-on: ubuntu-24.04", pull_request)
        setup_node = pull_request.index("actions/setup-node@")
        install_actionlint = pull_request.index("node scripts/install-actionlint.mjs")
        lint_workflows = pull_request.index(
            "actionlint -shellcheck= -pyflakes= -oneline .github/workflows/*.yml"
        )
        self.assertLess(setup_node, install_actionlint)
        self.assertLess(install_actionlint, lint_workflows)
        self.assertIn(
            'test "$(actionlint -version | sed -n \'1p\')" = "1.7.12"',
            pull_request,
        )
        self.assertIn('actionlint = "1.7.12"', mise)
        self.assertIn('const VERSION = "1.7.12";', installer)
        self.assertIn(
            'const EXPECTED_SHA256 = '
            '"8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8";',
            installer,
        )
        self.assertIn("MAXIMUM_ARCHIVE_BYTES = 8 * 1024 * 1024", installer)
        self.assertIn("response.url.startsWith(\"https://\")", installer)
        self.assertIn(
            "https://github.com/rhysd/actionlint/releases/download/v${VERSION}/",
            installer,
        )
        self.assertIn('execFileSync("tar", ["-xzf", archivePath', installer)
        self.assertNotRegex(installer, r"npm\s+(?:exec|install)|\bnpx\b")



    def test_oidc_permissions_are_confined_to_no_checkout_fixed_jobs(self) -> None:
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        headers = list(re.finditer(r"(?m)^  ([a-z0-9_-]+):\n", workflow))
        oidc_jobs: list[tuple[str, str]] = []
        for index, header in enumerate(headers):
            end = headers[index + 1].start() if index + 1 < len(headers) else len(workflow)
            block = workflow[header.start():end]
            if "id-token: write" in block or "attestations: write" in block:
                oidc_jobs.append((header.group(1), block))

        self.assertGreaterEqual(len(oidc_jobs), 1)
        for job_name, block in oidc_jobs:
            self.assertNotIn("actions/checkout", block, job_name)
            self.assertNotIn("scripts/", block, job_name)
            self.assertNotIn("working-directory:", block, job_name)
            self.assertNotIn("python3 ", block, job_name)
            self.assertNotIn("node ", block, job_name)
            self.assertNotIn("./gradlew", block, job_name)
            self.assertNotIn("npm install", block, job_name)
            self.assertNotIn("npm exec", block, job_name)
            self.assertNotRegex(block, r"(?m)^\s*npx\s", job_name)
            self.assertNotIn(
                "LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", block, job_name
            )

    def test_trusted_npm_cli_is_authenticated_before_oidc_execution(self) -> None:
        if REPOSITORY_ID not in ("javascript", "react_native"):
            self.skipTest("npm publication repositories only")
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        trusted = workflow.split("\n  trusted-npm-cli:\n", 1)[1].split(
            "\n  github-draft:\n", 1
        )[0]
        publication = workflow.split("\n  npm-publish:\n", 1)[1].split(
            "\n  publish:\n", 1
        )[0]

        self.assertIn("permissions: {}", trusted)
        self.assertIn('NPM_CONFIG_IGNORE_SCRIPTS: "true"', trusted)
        self.assertIn("curl --proto '=https' --proto-redir '=https' --tlsv1.2", trusted)
        self.assertIn("sha256sum --check --strict", trusted)
        self.assertIn("sha512sum --check --strict", trusted)
        self.assertIn("Transfer exact npm CLI tarball as inert data", trusted)
        self.assertIn(
            "NPM_CLI_SHA512: "
            "ee22b335fcbc95662cdf3ab8a053daf045d9cf9c6df6040d28965abb707512b2"
            "c16fa6c5eec049d34c74f78f390cebd14f697919eadb97756564d4f9eccc4954",
            workflow,
        )
        self.assertIn(
            "NPM_CLI_INTEGRITY: "
            "sha512-7iKzNfy8lWYs3zq4oFPa8EXZz5xt9gQNKJZau3B1ErLBb6bF7sBJ00x09485"
            "DOvRT2l5Gerbl3VlZNT57MxJVA==",
            workflow,
        )
        for forbidden in (
            "actions/checkout", "secrets.", "github.token", "id-token:",
            "attestations:", "npm install", "npm exec",
        ):
            self.assertNotIn(forbidden, trusted)
        self.assertNotRegex(trusted, r"(?m)^\s*npx\s")

        self.assertIn("trusted-npm-cli", publication.split("steps:", 1)[0])
        self.assertIn("Verify exact npm CLI closure before extraction or execution", publication)
        self.assertIn('closure=("$root"/*)', publication)
        self.assertIn("sha512sum --check --strict", publication)
        self.assertIn('"$LATCHWAY_NPM_CLI" publish "$archive"', publication)
        for forbidden in ("npm install", "npm exec"):
            self.assertNotIn(forbidden, publication)
        self.assertNotRegex(publication, r"(?m)^\s*npx\s")
        verification = publication.index("sha512sum --check --strict")
        extraction = publication.index('tar --extract --gzip --file "$archive"')
        execution = publication.index('test "$("$cli" --version)"')
        self.assertLess(verification, extraction)
        self.assertLess(extraction, execution)

    def test_react_native_registry_evidence_reuses_authenticated_npm_cli(self) -> None:
        if REPOSITORY_ID != "react_native":
            self.skipTest("React Native-only registry evidence job")
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        evidence = workflow.split("\n  publish:\n", 1)[1].split(
            "\n  github-release-policy:\n", 1
        )[0]

        self.assertIn("trusted-npm-cli", evidence.split("steps:", 1)[0])
        self.assertIn("Download exact credential-free npm CLI handoff", evidence)
        self.assertIn("Verify exact npm CLI closure before registry evidence", evidence)
        self.assertIn("sha256sum --check --strict", evidence)
        self.assertIn("sha512sum --check --strict", evidence)
        self.assertIn('printf \'LATCHWAY_NPM_CLI=%s\\n\'', evidence)
        self.assertNotIn("npm install --global", evidence)
        self.assertNotIn("npm exec", evidence)
        self.assertIn("LATCHWAY_NPM_CLI", (ROOT / "scripts/verify-published.mjs").read_text())

if __name__ == "__main__":
    unittest.main()
