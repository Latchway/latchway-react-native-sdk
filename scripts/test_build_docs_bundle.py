from __future__ import annotations

import gzip
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("build_docs_bundle", ROOT / "scripts/build_docs_bundle.py")
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DocumentationBundleTests(unittest.TestCase):
    def test_full_source_references_and_quickstarts_are_exact(self) -> None:
        config = json.loads((ROOT / "docs-bundle.config.json").read_text(encoding="utf-8"))
        documents = {item["path"]: item["source"] for item in config["documents"]}
        examples = {item["name"]: item["source"] for item in config["examples"]}
        for source in (
            documents["release-notes.md"],
            examples["React Native physical-device application"],
            examples["OpenAI, Vercel AI, LangChain, and Anthropic consumers"],
        ):
            line_count = len((ROOT / source["file"]).read_text(encoding="utf-8").splitlines())
            self.assertEqual(source["start_line"], 1)
            self.assertEqual(source["end_line"], line_count)

        streaming = documents["quickstart/streaming-fetch.tsx"]
        lines = (ROOT / streaming["file"]).read_text(encoding="utf-8").splitlines()
        region = lines[streaming["start_line"] - 1:streaming["end_line"]]
        self.assertTrue(region[0].strip().startswith("const send = async"))
        self.assertEqual(region[-1].strip(), "};")

        supported = {item["name"] for item in config["supported_versions"]}
        self.assertTrue({
            "@latchway/react-native/testing", "@latchway/react-native/package.json",
            "@latchway/client", "web-streams-polyfill", "React peer", "React Native peer",
            "Node.js", "pnpm", "Swift language", "C++ language standard",
            "Latchway iOS AppAttest", "Android compile SDK", "Java bytecode",
            "Android Gradle Plugin", "Gradle", "Kotlin", "Latchway Android OkHttp",
            "Latchway Android Play Integrity", "Vercel AI OpenAI", "LangChain core",
            "TypeScript",
        } <= supported)
        package = "\n".join(
            (ROOT / "package.json").read_text(encoding="utf-8").splitlines()[:54]
        )
        self.assertIn('"./testing"', package)
        self.assertIn('"./package.json"', package)
        self.assertIn('"version": "1.0.0"', package)

    def test_bundle_is_reproducible_self_describing_and_checksum_bound(self) -> None:
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            archives = []
            for output in (first, second):
                subprocess.run([
                    sys.executable, str(ROOT / "scripts/build_docs_bundle.py"),
                    "--output-dir", output, "--source-date-epoch", "0",
                ], cwd=ROOT, check=True, stdout=subprocess.PIPE, text=True)
                archives.append(Path(output, "docs-bundle-1.0.0.tar.gz"))
            self.assertEqual(archives[0].read_bytes(), archives[1].read_bytes())
            with tarfile.open(archives[0], "r:gz") as archive:
                members = archive.getmembers()
                self.assertEqual([item.name for item in members], sorted(item.name for item in members))
                self.assertTrue(all(item.isfile() and item.uid == item.gid == 0 and item.mode == 0o644 and item.mtime == 0 for item in members))
                payloads = {
                    item.name.split("/", 1)[1]: archive.extractfile(item).read()  # type: ignore[union-attr]
                    for item in members
                }
            manifest = json.loads(payloads["bundle-manifest.json"])
            self.assertEqual(manifest["schema_version"], MODULE.SCHEMA)
            self.assertEqual(manifest["release"]["version"], "1.0.0")
            self.assertEqual({item["kind"] for item in manifest["files"]} >= {
                "quickstart", "framework", "release_notes", "supported_versions",
                "public_symbols", "errors", "examples",
            }, True)
            for item in manifest["files"]:
                self.assertEqual(hashlib.sha256(payloads[item["path"]]).hexdigest(), item["sha256"])
                self.assertTrue(item["provenance"])
                for source in item["provenance"]:
                    self.assertEqual(source["repository"], manifest["repository"])
                    self.assertEqual(source["release"], manifest["release"]["tag"])
                    self.assertRegex(source["commit"], r"^[0-9a-f]{40}$")
                    self.assertLessEqual(source["region"]["start_line"], source["region"]["end_line"])
                    source_bytes = Path(ROOT, source["file"]).read_bytes()
                    source_lines = source_bytes.decode("utf-8").splitlines(keepends=True)
                    region = "".join(source_lines[
                        source["region"]["start_line"] - 1:source["region"]["end_line"]
                    ]).encode("utf-8")
                    self.assertEqual(hashlib.sha256(source_bytes).hexdigest(), source["source_sha256"])
                    self.assertEqual(hashlib.sha256(region).hexdigest(), source["region_sha256"])
            checksums = {}
            for line in payloads["SHA256SUMS"].decode("ascii").splitlines():
                digest, name = line.split("  ", 1)
                checksums[name] = digest
            self.assertEqual(set(checksums), set(payloads) - {"SHA256SUMS"})
            for name, digest in checksums.items():
                self.assertEqual(hashlib.sha256(payloads[name]).hexdigest(), digest)
            catalogs = {}
            for name, key in (("supported-versions.json", "versions"), ("public-symbols.json", "symbols"), ("errors.json", "errors"), ("examples.json", "examples")):
                catalogs[name] = json.loads(payloads[name])[key]
                self.assertTrue(catalogs[name])
            for name in ("public-symbols.json", "errors.json"):
                for row in catalogs[name]:
                    source = row["source"]
                    line = (ROOT / source["file"]).read_text(encoding="utf-8").splitlines()[
                        source["region"]["start_line"] - 1
                    ]
                    self.assertIn(row["name"], line)
            symbols = {row["name"] for row in catalogs["public-symbols.json"]}
            self.assertTrue({
                "gatewayURL", "ready", "fetch", "fetchFor", "quota", "diagnostics",
                "refresh", "prepareComponents", "replaceComponent", "componentDiagnostics",
                "revokeComponent", "revokeCurrentInstallation", "revokeCurrentInstallationFamily",
                "dispose", "establishDirectAttestation", "installNativeModuleForTesting",
                "NativeLatchwayModule", "configure", "configureComponent", "startRequest",
                "readResponseChunk", "closeResponse", "rootComponentDiagnostics", "revoke",
                "revokeFamily", "revokeFamilyWithComponents", "cancel",
            } <= symbols)
            self.assertTrue({
                "DefaultLatchwayClient", "DefaultLatchwayComponentClient", "RuntimeConfiguration",
                "RuntimeComponentConfiguration", "NativeLease", "Spec", "acquire",
                "acquireComponent",
            }.isdisjoint(symbols))
            self.assertTrue({row["source"]["file"] for row in catalogs["public-symbols.json"]} <= {
                "src/index.ts", "src/types.ts", "src/version.ts", "src/testing.ts",
                "src/native/NativeLatchway.ts",
            })
            framework = payloads["frameworks/react-native-consumers.ts"].decode("utf-8")
            for marker in (
                "export interface FrameworkFeatureBindings",
                "responsesFetch = client.fetchFor(features.responses)",
                "chatFetch = client.fetchFor(features.chat)",
                "embeddingsFetch = client.fetchFor(features.embeddings)",
                "anthropicFetch = client.fetchFor(features.anthropic)",
                "consumers.openaiResponses.responses.create",
                "consumers.openaiChat.chat.completions.create",
            ):
                self.assertIn(marker, framework)

    def test_path_validation_and_archive_verifier_reject_traversal(self) -> None:
        for value in ("/absolute", "../escape", "a/../escape", "a\\b"):
            with self.assertRaises(MODULE.BundleError):
                MODULE.safe_relative(value)
        with tempfile.TemporaryDirectory() as temporary:
            malicious = Path(temporary, "malicious.tar.gz")
            with malicious.open("wb") as output:
                with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
                    with tarfile.open(fileobj=compressed, mode="w") as archive:
                        payload = b"unsafe"
                        info = tarfile.TarInfo("../escape")
                        info.size = len(payload)
                        archive.addfile(info, io.BytesIO(payload))
            with self.assertRaises(MODULE.BundleError):
                MODULE.verify_archive(malicious, "docs-bundle-1.0.0")

    def test_provenance_commit_must_equal_the_checked_out_source(self) -> None:
        with tempfile.TemporaryDirectory() as output:
            with self.assertRaisesRegex(MODULE.BundleError, "checked-out source commit"):
                MODULE.build(MODULE.DEFAULT_CONFIG, Path(output), None, "0" * 40, 0, False)


if __name__ == "__main__":
    unittest.main()
