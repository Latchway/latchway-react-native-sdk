#!/usr/bin/env python3
"""Adversarially enforce the locked-source credential handoff boundary."""

from __future__ import annotations

import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "locked-sources.yml"
CONSUMER_JOBS = ("javascript", "android-source", "ios-source")
EXACT_CLOSURE = (
    "contract.lock",
    "locked-latchway-android.bundle",
    "locked-latchway-ios-sdk.bundle",
    "locked-latchway-js.bundle",
    "locked-latchway.bundle",
    "release-compatibility.json",
)


class WorkflowInvariantError(AssertionError):
    """Raised when a credential or exact-closure invariant is weakened."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise WorkflowInvariantError(message)


def job_block(source: str, job: str) -> str:
    match = re.search(rf"(?m)^  {re.escape(job)}:\n", source)
    if match is None:
        raise WorkflowInvariantError(f"missing job: {job}")
    following = re.search(r"(?m)^  [a-z0-9][a-z0-9-]*:\n", source[match.end() :])
    end = len(source) if following is None else match.end() + following.start()
    return source[match.start() : end]


def named_step_block(job: str, name: str) -> str:
    match = re.search(rf"(?m)^      - name: {re.escape(name)}\n", job)
    if match is None:
        raise WorkflowInvariantError(f"missing step: {name}")
    following = re.search(r"(?m)^      - (?:name:|uses:)", job[match.end() :])
    end = len(job) if following is None else match.end() + following.start()
    return job[match.start() : end]


def exact_closure_arrays(source: str) -> list[tuple[str, ...]]:
    bodies = re.findall(
        r"(?m)^          expected_files=\(\n"
        r"(?P<body>(?:            [A-Za-z0-9._-]+\n)+)"
        r"^          \)",
        source,
    )
    return [tuple(line.strip() for line in body.splitlines()) for body in bodies]


def validate_workflow(source: str) -> None:
    prefix = source.split("jobs:", 1)[0]
    require("permissions: {}" in prefix, "workflow permissions must default to none")

    authenticator = job_block(source, "authenticate-inputs")
    require(
        "environment: private-sibling-read" in authenticator,
        "authenticator must use the protected sibling-read environment",
    )
    require("runs-on: ubuntu-24.04" in authenticator, "authenticator runner must be fixed")
    require("actions/checkout@" not in authenticator, "authenticator checked out candidate code")
    require("working-directory:" not in authenticator, "authenticator entered a candidate checkout")

    secret_reference = "${{ secrets.LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN }}"
    require(source.count(secret_reference) == 1, "sibling secret must have one exact reference")
    require(secret_reference in authenticator, "sibling secret escaped the authenticator")
    require(
        source.count("${{ github.token }}") == 1
        and "GH_TOKEN: ${{ github.token }}" in authenticator,
        "current-repository token must be confined to the fixed lock API step",
    )

    bundle_step = named_step_block(
        authenticator, "Fetch and bundle only the four exact locked sibling objects"
    )
    require(secret_reference in bundle_step, "sibling secret must be scoped to bundle fetching")
    require(
        'if [[ -n "$LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN" ]]; then'
        in bundle_step,
        "optional sibling token path must be selected only when the token is nonempty",
    )
    require(
        "printf '%s\\n' '#!/usr/bin/env bash' 'exit 1' > \"$git_askpass\""
        in bundle_step,
        "anonymous source reads must reject every credential prompt",
    )
    require(
        'GIT_ASKPASS="$git_askpass" GIT_TERMINAL_PROMPT=0' in bundle_step
        and "git -c credential.helper=" in bundle_step,
        "sibling fetches must disable ambient and interactive credentials",
    )
    for marker in (
        "node ",
        "pnpm ",
        "npm ",
        "npx ",
        "yarn ",
        "python",
        "scripts/",
        "./gradlew",
        "xcodebuild",
        "pod install",
        "actions/setup-node@",
        "pnpm/action-setup@",
    ):
        require(marker not in authenticator, f"candidate execution reached credential job: {marker}")

    require(
        '"repos/$GITHUB_REPOSITORY/contents/$path?ref=$GITHUB_SHA"' in authenticator,
        "candidate locks must be fetched by exact commit API coordinates",
    )
    require(
        "fetch_candidate_file release-compatibility.json 262144 524288" in authenticator
        and "fetch_candidate_file contract.lock 65536 196608" in authenticator,
        "candidate lock API reads must be fixed and bounded",
    )
    require(
        "(( response_bytes <= maximum_response_bytes ))" in authenticator,
        "candidate lock API responses must be bounded before parsing",
    )
    require("jq --exit-status" in authenticator, "locks must fail closed through jq")
    require("cmp -s \"$canonical_lock\" \"$sealed/contract.lock\"" in authenticator,
            "contract lock must have a canonical exact shape")
    require(
        ".wire_protocol == 2" in authenticator
        and 'test "$WIRE_PROTOCOL" = 2' in authenticator,
        "locked-source workflow must require current wire protocol 2",
    )
    require(
        'keys == ["attestation-binding-v1.json", '
        '"component-attestation-binding-v2.json", "dpop-v1.json", '
        '"installation-family-v2.json", "protocol-version.json"]' in authenticator,
        "locked-source workflow must require the complete canonical fixture set",
    )
    require(
        '[[ "$CORE_TAG" == "unreleased" || "$CORE_TAG" =~ ^v' in authenticator,
        "source conformance must accept only an unreleased checkpoint or a semantic core tag",
    )

    for repository, commit, name in (
        ("Latchway/latchway-js", "$JAVASCRIPT_COMMIT", "latchway-js"),
        ("Latchway/latchway-android", "$ANDROID_COMMIT", "latchway-android"),
        ("Latchway/latchway-ios-sdk", "$IOS_COMMIT", "latchway-ios-sdk"),
        ("Latchway/latchway", "$CORE_COMMIT", "latchway"),
    ):
        require(
            f'bundle_locked_repository {repository} "{commit}" {name}' in bundle_step,
            f"missing exact bundle fetch for {repository}",
        )
    require(
        bundle_step.count("fetch --no-tags") == 1,
        "bundle fetch must exclude tags in one fail-closed attempt",
    )
    require(
        '"$commit:refs/heads/authenticated"' in bundle_step,
        "bundle fetch must pin its only advertised ref to the locked commit",
    )
    require("bundle create \"$bundle\" refs/heads/authenticated" in bundle_step,
            "bundle must contain only the authenticated reachable closure")

    require(
        len(re.findall(r"(?m)^    environment:", source)) == 1,
        "only the authenticator may use a protected environment",
    )
    first_candidate_execution = source.find("node scripts/ci-lock-output.mjs")
    require(first_candidate_execution > source.find("  javascript:\n"),
            "candidate script executed before the first consumer job")

    for job_name in CONSUMER_JOBS:
        consumer = job_block(source, job_name)
        require("needs: authenticate-inputs" in consumer, f"{job_name} bypasses authentication")
        require("permissions:\n      contents: read" in consumer,
                f"{job_name} has unexpected permissions")
        for forbidden in (
            "    environment:",
            "secrets.",
            "id-token:",
            "attestations:",
            "registry-url:",
            "      repository:",
            "GH_TOKEN: ",
            "GITHUB_TOKEN: ",
            "NODE_AUTH_TOKEN: ",
        ):
            require(forbidden not in consumer, f"{job_name} gained forbidden authority: {forbidden}")
        for variable in (
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "NODE_AUTH_TOKEN",
            "ACTIONS_ID_TOKEN_REQUEST_URL",
            "LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN",
        ):
            require(variable in consumer, f"{job_name} does not assert {variable} is empty")

        compare_lock = consumer.find(
            'cmp -s "$root/release-compatibility.json" '
            "latchway-react-native-sdk/release-compatibility.json"
        )
        import_bundle = consumer.find(
            'materialize_bundle "$root/locked-latchway-js.bundle"'
        )
        candidate_execution = consumer.find("node scripts/ci-lock-output.mjs")
        require(
            -1 < compare_lock < import_bundle < candidate_execution,
            f"{job_name} executes candidate tooling before authenticated offline import",
        )
        require(
            consumer.count('cmp -s "$expected_paths" "$actual_paths"') == 1
            and consumer.count('cmp -s "$expected_paths" "$manifest_paths"') == 1,
            f"{job_name} does not enforce exact archive and manifest closure",
        )

    arrays = exact_closure_arrays(source)
    require(len(arrays) == 4, "producer and all consumers need exact closure arrays")
    for index, closure in enumerate(arrays):
        require(closure == EXACT_CLOSURE, f"exact closure mutation in handoff {index}")
    require(
        source.count('cmp -s "$expected_paths" "$actual_paths"') == 4,
        "every handoff boundary must compare its filesystem closure",
    )
    require(
        source.count('test "$(shasum -a 256 "$artifact" | awk \'{print $1}\')" = "$EXPECTED_ARCHIVE_SHA256"')
        == 3,
        "each consumer must bind the downloaded archive to the protected digest output",
    )

    actions = re.findall(r"(?m)^\s+(?:-\s+)?uses:\s+([^\s#]+)", source)
    require(len(actions) >= 16, "expected pinned workflow actions are missing")
    for action in actions:
        require(bool(re.fullmatch(r"[^@]+@[0-9a-f]{40}", action)), f"unpinned action: {action}")


class LockedSourcesWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = WORKFLOW.read_text(encoding="utf-8")

    def test_current_workflow_satisfies_boundary(self) -> None:
        validate_workflow(self.source)

    def assert_mutation_rejected(self, mutated: str, reason: str) -> None:
        with self.subTest(reason=reason):
            with self.assertRaisesRegex(WorkflowInvariantError, reason):
                validate_workflow(mutated)

    def test_rejects_candidate_execution_before_or_within_secret_step(self) -> None:
        before_secret = self.source.replace(
            "          sealed=\"$RUNNER_TEMP/authenticated-locked-sources\"\n",
            "          node scripts/ci-lock-output.mjs\n"
            "          sealed=\"$RUNNER_TEMP/authenticated-locked-sources\"\n",
            1,
        )
        self.assert_mutation_rejected(before_secret, "candidate execution")

        within_secret = self.source.replace(
            '          git_askpass="$RUNNER_TEMP/latchway-locked-sources-askpass.sh"\n',
            "          pnpm --dir latchway-react-native-sdk check\n"
            '          git_askpass="$RUNNER_TEMP/latchway-locked-sources-askpass.sh"\n',
            1,
        )
        self.assert_mutation_rejected(within_secret, "candidate execution")

    def test_rejects_weakened_public_or_private_source_authentication(self) -> None:
        unconditional_token = self.source.replace(
            'if [[ -n "$LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN" ]]; then',
            "if true; then",
            1,
        )
        self.assert_mutation_rejected(unconditional_token, "optional sibling token path")

        prompting_anonymous = self.source.replace(
            "printf '%s\\n' '#!/usr/bin/env bash' 'exit 1' > \"$git_askpass\"",
            "printf '%s\\n' '#!/usr/bin/env bash' 'printf retry' > \"$git_askpass\"",
            1,
        )
        self.assert_mutation_rejected(prompting_anonymous, "reject every credential prompt")

        ambient_credentials = self.source.replace(
            "git -c credential.helper= -C \"$bare\" fetch --no-tags",
            "git -C \"$bare\" fetch --no-tags",
            1,
        )
        self.assert_mutation_rejected(ambient_credentials, "disable ambient")

        retry = self.source.replace(
            "git -c credential.helper= -C \"$bare\" fetch --no-tags",
            "git -c credential.helper= -C \"$bare\" fetch --no-tags || "
            "git -c credential.helper= -C \"$bare\" fetch --no-tags",
            1,
        )
        self.assert_mutation_rejected(retry, "one fail-closed")

    def test_rejects_secret_or_oidc_mutation_in_consumers(self) -> None:
        leaked_secret = self.source.replace(
            "  javascript:\n",
            "  javascript:\n    environment: private-sibling-read\n",
            1,
        )
        self.assert_mutation_rejected(leaked_secret, "protected environment")

        oidc = self.source.replace(
            "  android-source:\n",
            "  android-source:\n    permissions:\n      id-token: write\n",
            1,
        )
        self.assert_mutation_rejected(oidc, "unexpected permissions|forbidden authority")

    def test_rejects_input_closure_mutations(self) -> None:
        missing = self.source.replace("            locked-latchway-ios-sdk.bundle\n", "", 1)
        self.assert_mutation_rejected(missing, "exact closure mutation")

        added = self.source.replace(
            "            release-compatibility.json\n          )",
            "            release-compatibility.json\n"
            "            unexpected.bundle\n"
            "          )",
            1,
        )
        self.assert_mutation_rejected(added, "exact closure mutation")

        weakened = self.source.replace(
            '          cmp -s "$expected_paths" "$manifest_paths"\n', "", 1
        )
        self.assert_mutation_rejected(weakened, "manifest closure")

    def test_rejects_floating_lock_or_bundle_coordinates(self) -> None:
        floating_api = self.source.replace("?ref=$GITHUB_SHA", "?ref=main", 1)
        self.assert_mutation_rejected(floating_api, "exact commit API coordinates")

        unbounded_api = self.source.replace(
            "            (( response_bytes <= maximum_response_bytes ))\n", "", 1
        )
        self.assert_mutation_rejected(unbounded_api, "bounded before parsing")

        tags = self.source.replace("fetch --no-tags", "fetch --tags", 1)
        self.assert_mutation_rejected(tags, "exclude tags")

    def test_rejects_contract_semantic_downgrades(self) -> None:
        wire = self.source.replace('.wire_protocol == 2', '.wire_protocol == 1', 1)
        self.assert_mutation_rejected(wire, "current wire protocol 2")

        missing_component_binding = self.source.replace(
            ', "component-attestation-binding-v2.json"', "", 1
        )
        self.assert_mutation_rejected(
            missing_component_binding, "complete canonical fixture set"
        )

        missing_family = self.source.replace(', "installation-family-v2.json"', "", 1)
        self.assert_mutation_rejected(missing_family, "complete canonical fixture set")

        release_only = self.source.replace(
            '[[ "$CORE_TAG" == "unreleased" || "$CORE_TAG" =~ ^v',
            '[[ "$CORE_TAG" =~ ^v',
            1,
        )
        self.assert_mutation_rejected(release_only, "unreleased checkpoint")


if __name__ == "__main__":
    unittest.main()
