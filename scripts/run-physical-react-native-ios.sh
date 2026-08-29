#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
schema="$repository_root/Conformance/physical-device-evidence.schema.json"
required=(
  LATCHWAY_EVIDENCE_OUTPUT_DIR LATCHWAY_IOS_DEVICE_ID LATCHWAY_IOS_APP_BUNDLE_PATH
  LATCHWAY_IOS_INSTALL_MODE LATCHWAY_BUNDLE_ID LATCHWAY_APP_VERSION LATCHWAY_BUILD_NUMBER
  LATCHWAY_TEAM_ID LATCHWAY_SIGNING_CERTIFICATE_SHA256 LATCHWAY_APP_BINARY_SHA256
  LATCHWAY_IOS_JAVASCRIPT_BUNDLE_SHA256
  LATCHWAY_DISTRIBUTION LATCHWAY_SOURCE_COMMIT LATCHWAY_CORE_COMMIT LATCHWAY_IOS_COMMIT
  LATCHWAY_RN_SDK_VERSION LATCHWAY_NATIVE_SDK_VERSION LATCHWAY_CONTRACT_VERSION
  LATCHWAY_CONTRACT_BUNDLE_SHA256 LATCHWAY_GATEWAY_IMAGE_DIGEST
  LATCHWAY_GATEWAY_CONFIGURATION_SHA256 LATCHWAY_NATIVE_EVIDENCE_SHA256
  LATCHWAY_GATEWAY_ORIGIN LATCHWAY_GATEWAY_DEPLOYMENT_KEY_ID
  LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256 LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_PATH
  LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256 LATCHWAY_GATEWAY_MINIMUM_TRUST_LEVEL
  LATCHWAY_ENVIRONMENT LATCHWAY_ERROR_MAPPING_FEATURE
  LATCHWAY_NATIVE_EVIDENCE_PATH LATCHWAY_NATIVE_PROFILE_PATH LATCHWAY_RUN_ID
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "required protected variable is missing: $name" >&2; exit 2; }
done
for tool in cmp codesign curl install openssl python3 shasum swift xcodebuild; do
  command -v "$tool" >/dev/null || { echo "required tool is unavailable: $tool" >&2; exit 2; }
done
# shellcheck source=scripts/gateway-deployment-evidence.sh
source "$repository_root/scripts/gateway-deployment-evidence.sh"
[[ "$LATCHWAY_IOS_INSTALL_MODE" == install ]] || { echo "physical evidence requires installing the pinned app bundle" >&2; exit 2; }
case "$LATCHWAY_DISTRIBUTION" in ad_hoc|testflight|app_store) ;; *) echo "invalid distribution" >&2; exit 2;; esac
[[ "$LATCHWAY_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ && "$LATCHWAY_CORE_COMMIT" =~ ^[0-9a-f]{40}$ && "$LATCHWAY_IOS_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid commit pin" >&2; exit 2; }
[[ "$LATCHWAY_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo "invalid team pin" >&2; exit 2; }
[[ "$LATCHWAY_SIGNING_CERTIFICATE_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_APP_BINARY_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_IOS_JAVASCRIPT_BUNDLE_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_NATIVE_EVIDENCE_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid artifact pin" >&2; exit 2; }
[[ "$LATCHWAY_CONTRACT_BUNDLE_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_GATEWAY_CONFIGURATION_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid configuration pin" >&2; exit 2; }
[[ "$LATCHWAY_GATEWAY_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid image pin" >&2; exit 2; }
[[ "$LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid gateway deployment hash pin" >&2; exit 2; }
case "$LATCHWAY_GATEWAY_MINIMUM_TRUST_LEVEL" in device_verified|strong_device_verified) ;; *) echo "invalid gateway minimum trust level" >&2; exit 2;; esac
[[ "$LATCHWAY_RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$ ]] || { echo "invalid run ID" >&2; exit 2; }
[[ -d "$LATCHWAY_IOS_APP_BUNDLE_PATH" && ! -L "$LATCHWAY_IOS_APP_BUNDLE_PATH" && "$LATCHWAY_IOS_APP_BUNDLE_PATH" == *.app ]] || { echo "signed app bundle is unsafe" >&2; exit 2; }
[[ -f "$LATCHWAY_NATIVE_EVIDENCE_PATH" && ! -L "$LATCHWAY_NATIVE_EVIDENCE_PATH" && -f "$LATCHWAY_NATIVE_PROFILE_PATH" && ! -L "$LATCHWAY_NATIVE_PROFILE_PATH" ]] || { echo "linked native evidence is unsafe" >&2; exit 2; }

mkdir -p "$LATCHWAY_EVIDENCE_OUTPUT_DIR"
output="$(cd "$LATCHWAY_EVIDENCE_OUTPUT_DIR" && pwd -P)"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/latchway-rn-ios.XXXXXX")"
cleanup() { if [[ -d "$temporary" && "$temporary" == */latchway-rn-ios.* ]]; then rm -rf "$temporary"; fi; }
trap cleanup EXIT

[[ "$(git -C "$repository_root" rev-parse HEAD)" == "$LATCHWAY_SOURCE_COMMIT" ]] || { echo "source commit mismatch" >&2; exit 1; }
[[ -z "$(git -C "$repository_root" status --porcelain=v1 --untracked-files=all)" ]] || { echo "physical evidence requires a clean source tree" >&2; exit 1; }
[[ "$(shasum -a 256 "$LATCHWAY_NATIVE_EVIDENCE_PATH" | awk '{print $1}')" == "$LATCHWAY_NATIVE_EVIDENCE_SHA256" ]] || { echo "linked native evidence hash mismatch" >&2; exit 1; }
python3 "$repository_root/scripts/device-evidence.py" verify \
  --schema "$schema" --profile "$LATCHWAY_NATIVE_PROFILE_PATH" --evidence "$LATCHWAY_NATIVE_EVIDENCE_PATH" \
  --junit "$temporary/native-junit.xml" --summary "$temporary/native-validation.json"
python3 - "$LATCHWAY_NATIVE_EVIDENCE_PATH" <<'PY'
import json, os, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
source = value.get("source", {})
expected = {
    "repository": "Latchway/latchway-ios-sdk",
    "commit": os.environ["LATCHWAY_IOS_COMMIT"],
    "core_commit": os.environ["LATCHWAY_CORE_COMMIT"],
    "contract_version": os.environ["LATCHWAY_CONTRACT_VERSION"],
    "contract_bundle_sha256": os.environ["LATCHWAY_CONTRACT_BUNDLE_SHA256"],
    "gateway_image_digest": os.environ["LATCHWAY_GATEWAY_IMAGE_DIGEST"],
    "gateway_configuration_sha256": os.environ["LATCHWAY_GATEWAY_CONFIGURATION_SHA256"],
    "gateway_origin": os.environ["LATCHWAY_GATEWAY_ORIGIN"],
    "gateway_deployment_key_id": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_KEY_ID"],
    "gateway_deployment_statement_sha256": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256"],
    "gateway_deployment_public_key_sha256": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256"],
}
if any(source.get(name) != expected_value for name, expected_value in expected.items()):
    raise SystemExit("linked native evidence release coordinates mismatch")
PY

plist="$LATCHWAY_IOS_APP_BUNDLE_PATH/Info.plist"
[[ -f "$plist" && ! -L "$plist" ]] || { echo "signed app Info.plist is unsafe" >&2; exit 1; }
actual_bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")"
actual_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")"
actual_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")"
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
[[ -f "$LATCHWAY_IOS_APP_BUNDLE_PATH/$executable" && ! -L "$LATCHWAY_IOS_APP_BUNDLE_PATH/$executable" ]] || { echo "signed app executable is unsafe" >&2; exit 1; }
javascript_bundle="$LATCHWAY_IOS_APP_BUNDLE_PATH/main.jsbundle"
[[ -f "$javascript_bundle" && ! -L "$javascript_bundle" ]] || { echo "signed React Native JavaScript bundle is unsafe" >&2; exit 1; }
[[ "$actual_bundle" == "$LATCHWAY_BUNDLE_ID" && "$actual_version" == "$LATCHWAY_APP_VERSION" && "$actual_build" == "$LATCHWAY_BUILD_NUMBER" ]] || { echo "signed app identity mismatch" >&2; exit 1; }
codesign --verify --deep --strict "$LATCHWAY_IOS_APP_BUNDLE_PATH"
entitlements="$temporary/entitlements.plist"
codesign -d --entitlements :- "$LATCHWAY_IOS_APP_BUNDLE_PATH" >"$entitlements" 2>/dev/null
actual_team="$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.team-identifier' "$entitlements")"
actual_attest="$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.devicecheck.appattest-environment' "$entitlements")"
actual_app_identifier="$(/usr/libexec/PlistBuddy -c 'Print :application-identifier' "$entitlements")"
actual_get_task_allow="$(/usr/libexec/PlistBuddy -c 'Print :get-task-allow' "$entitlements" 2>/dev/null || true)"
[[ "$actual_team" == "$LATCHWAY_TEAM_ID" && "$actual_attest" == production && "$actual_app_identifier" == "$LATCHWAY_TEAM_ID.$LATCHWAY_BUNDLE_ID" ]] || { echo "production App Attest/team identity mismatch" >&2; exit 1; }
[[ -z "$actual_get_task_allow" || "$actual_get_task_allow" == false ]] || { echo "release evidence rejects get-task-allow" >&2; exit 1; }
certificate_prefix="$temporary/certificate"
codesign -d --extract-certificates "$certificate_prefix" "$LATCHWAY_IOS_APP_BUNDLE_PATH" 2>/dev/null
actual_certificate="$(shasum -a 256 "${certificate_prefix}0" | awk '{print $1}')"
actual_binary="$(shasum -a 256 "$LATCHWAY_IOS_APP_BUNDLE_PATH/$executable" | awk '{print $1}')"
actual_javascript_bundle="$(shasum -a 256 "$javascript_bundle" | awk '{print $1}')"
[[ "$actual_certificate" == "$LATCHWAY_SIGNING_CERTIFICATE_SHA256" && "$actual_binary" == "$LATCHWAY_APP_BINARY_SHA256" && "$actual_javascript_bundle" == "$LATCHWAY_IOS_JAVASCRIPT_BUNDLE_SHA256" ]] || { echo "signed certificate/executable/JavaScript bundle mismatch" >&2; exit 1; }

client_policy="$temporary/gateway-client-policy.json"
python3 - "$client_policy" <<'PY'
import json, os, pathlib, sys
policy = {"allow_debug": False, "allow_testing": False, "app_attest_environment": "production",
 "app_version": os.environ["LATCHWAY_APP_VERSION"], "application_identifier": os.environ["LATCHWAY_BUNDLE_ID"],
 "build_number": os.environ["LATCHWAY_BUILD_NUMBER"], "minimum_trust_level": os.environ["LATCHWAY_GATEWAY_MINIMUM_TRUST_LEVEL"],
 "platform": "react_native_ios_app_attest", "provider": "app_attest", "require_licensed": False,
 "require_play_recognized": False, "require_request_hash": True,
 "signing_certificate_sha256": os.environ["LATCHWAY_SIGNING_CERTIFICATE_SHA256"], "team_id": os.environ["LATCHWAY_TEAM_ID"]}
pathlib.Path(sys.argv[1]).write_text(json.dumps(policy, allow_nan=False, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
PY
latchway_capture_gateway_deployment "$output" "$client_policy"

inventory_raw="$temporary/devicectl.json"
xcrun devicectl device info details --device "$LATCHWAY_IOS_DEVICE_ID" --timeout 30 --json-output "$inventory_raw" --omit-deprecated-fields-in-json >/dev/null
xcrun devicectl device install app --device "$LATCHWAY_IOS_DEVICE_ID" --timeout 120 "$LATCHWAY_IOS_APP_BUNDLE_PATH" >/dev/null
export DEVICECTL_CHILD_LATCHWAY_RUN_ID="$LATCHWAY_RUN_ID"
xcrun devicectl device process launch --device "$LATCHWAY_IOS_DEVICE_ID" --terminate-existing --timeout 30 "$LATCHWAY_BUNDLE_ID" >/dev/null
raw="$output/react-native-ios-run.json"
ready=false
for _ in {1..180}; do
  candidate="$temporary/run.json"
  if xcrun devicectl device copy from --device "$LATCHWAY_IOS_DEVICE_ID" --domain-type appDataContainer --domain-identifier "$LATCHWAY_BUNDLE_ID" --source Documents/latchway-rn-device-run.json --destination "$candidate" --timeout 15 >/dev/null 2>&1; then
    if python3 - "$candidate" "$LATCHWAY_RUN_ID" <<'PY'
import json, os, pathlib, sys
try: value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
except Exception: raise SystemExit(1)
raise SystemExit(0 if value.get("run", {}).get("id") == sys.argv[2] else 1)
PY
    then cp "$candidate" "$raw"; ready=true; break; fi
  fi
  sleep 5
done
[[ "$ready" == true ]] || { echo "React Native iOS run was not produced" >&2; exit 1; }

inventory="$output/device-inventory.json"
collection="$output/react-native-ios-collection.json"
python3 - "$inventory_raw" "$raw" "$inventory" "$collection" <<'PY'
import json, pathlib, sys
inventory_raw = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
raw = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
if inventory_raw.get("info", {}).get("outcome") != "success": raise SystemExit("devicectl query failed")
device = raw["device"]
if device.get("physical") is not True or device.get("simulator") is not False: raise SystemExit("not physical")
inventory = {
    "schema_version": "latchway.physical-device-inventory.v1", "collector": "devicectl",
    "collector_version": str(inventory_raw.get("info", {}).get("version", "unknown"))[:64],
    "physical": True, "model": device["model"], "os_name": device["os_name"],
    "os_version": device["os_version"], "os_build": device["os_build"],
}
pathlib.Path(sys.argv[3]).write_text(json.dumps(inventory, indent=2, sort_keys=True) + "\n", encoding="utf-8")
pins = raw["pins"]
if pins["distribution"] != os.environ["LATCHWAY_DISTRIBUTION"]: raise SystemExit("distribution pin mismatch")
application = {**raw["application"], "build_mode": "release", "distribution": os.environ["LATCHWAY_DISTRIBUTION"],
    "signing_certificate_sha256": pins["signing_certificate_sha256"], "team_id": pins["team_id"],
    "app_attest_environment": pins["app_attest_environment"]}
collection = {"schema_version": "latchway.react-native-collector.v1", "platform": raw["platform"],
    "application": application, "device": raw["device"]}
pathlib.Path(sys.argv[4]).write_text(json.dumps(collection, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
inventory_hash="$(shasum -a 256 "$inventory" | awk '{print $1}')"
export LATCHWAY_RUNNER_OS="$(sw_vers -productName) $(sw_vers -productVersion) $(sw_vers -buildVersion)"
export LATCHWAY_RUNNER_ARCH="$(uname -m)"
export LATCHWAY_COMPILER="$(swift --version | head -n 1)"
export LATCHWAY_BUILD_TOOL="$(xcodebuild -version | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
export LATCHWAY_DEVICE_INVENTORY_SHA256="$inventory_hash"
profile="$output/react-native-ios-profile.json"
python3 - "$profile" <<'PY'
import json, os, pathlib, sys
expected = {
 "application_identifier": os.environ["LATCHWAY_BUNDLE_ID"], "app_version": os.environ["LATCHWAY_APP_VERSION"],
 "build_number": os.environ["LATCHWAY_BUILD_NUMBER"], "team_id": os.environ["LATCHWAY_TEAM_ID"],
 "signing_certificate_sha256": os.environ["LATCHWAY_SIGNING_CERTIFICATE_SHA256"], "app_attest_environment": "production",
 "javascript_bundle_sha256": os.environ["LATCHWAY_IOS_JAVASCRIPT_BUNDLE_SHA256"],
 "native_sdk_version": os.environ["LATCHWAY_NATIVE_SDK_VERSION"], "native_evidence_sha256": os.environ["LATCHWAY_NATIVE_EVIDENCE_SHA256"],
 "source_commit": os.environ["LATCHWAY_SOURCE_COMMIT"], "core_commit": os.environ["LATCHWAY_CORE_COMMIT"],
 "contract_bundle_sha256": os.environ["LATCHWAY_CONTRACT_BUNDLE_SHA256"], "gateway_image_digest": os.environ["LATCHWAY_GATEWAY_IMAGE_DIGEST"],
 "gateway_configuration_sha256": os.environ["LATCHWAY_GATEWAY_CONFIGURATION_SHA256"],
 "gateway_origin": os.environ["LATCHWAY_GATEWAY_ORIGIN"], "gateway_deployment_key_id": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_KEY_ID"],
 "gateway_environment": os.environ["LATCHWAY_ENVIRONMENT"],
 "error_mapping_feature": os.environ["LATCHWAY_ERROR_MAPPING_FEATURE"],
 "gateway_deployment_statement_sha256": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256"],
 "gateway_deployment_public_key_sha256": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256"],
}
profile = {"schema_version": "latchway.physical-device-profile.v1", "platform": "react_native_ios_app_attest",
 "repository": "Latchway/latchway-react-native-sdk", "source": {"commit": os.environ["LATCHWAY_SOURCE_COMMIT"],
 "core_commit": os.environ["LATCHWAY_CORE_COMMIT"], "worktree_clean": True, "sdk_version": os.environ["LATCHWAY_RN_SDK_VERSION"],
 "contract_version": os.environ["LATCHWAY_CONTRACT_VERSION"], "contract_bundle_sha256": os.environ["LATCHWAY_CONTRACT_BUNDLE_SHA256"],
 "gateway_image_digest": os.environ["LATCHWAY_GATEWAY_IMAGE_DIGEST"], "gateway_configuration_sha256": os.environ["LATCHWAY_GATEWAY_CONFIGURATION_SHA256"],
 "gateway_origin": os.environ["LATCHWAY_GATEWAY_ORIGIN"], "gateway_deployment_key_id": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_KEY_ID"],
 "gateway_deployment_statement_sha256": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256"],
 "gateway_deployment_public_key_sha256": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256"]},
 "toolchain": {"runner_os": os.environ["LATCHWAY_RUNNER_OS"], "runner_arch": os.environ["LATCHWAY_RUNNER_ARCH"],
 "compiler": os.environ["LATCHWAY_COMPILER"], "build_tool": os.environ["LATCHWAY_BUILD_TOOL"], "collector_version": "1"},
 "expected_pins": expected, "application_binary_sha256": os.environ["LATCHWAY_APP_BINARY_SHA256"],
 "device_inventory_sha256": os.environ["LATCHWAY_DEVICE_INVENTORY_SHA256"]}
pathlib.Path(sys.argv[1]).write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
observation="$output/react-native-ios-observation.json"
python3 "$repository_root/scripts/finalize-react-native-device-run.py" \
  --raw "$raw" --collection "$collection" --profile "$profile" \
  --native-evidence "$LATCHWAY_NATIVE_EVIDENCE_PATH" --native-profile "$LATCHWAY_NATIVE_PROFILE_PATH" \
  --client-policy "$output/gateway-client-policy.json" \
  --schema "$schema" --observation "$observation"
latchway_recheck_gateway_deployment "$output" "$temporary"
latchway_verify_observation_against_gateway_policy "$observation" "$output/gateway-client-policy.json"
evidence="$output/react-native-ios-evidence.json"
python3 "$repository_root/scripts/device-evidence.py" finalize --schema "$schema" --profile "$profile" --observation "$observation" --evidence "$evidence" --junit "$output/react-native-ios-junit.xml" --summary "$output/react-native-ios-validation.json"
cp "$LATCHWAY_NATIVE_EVIDENCE_PATH" "$output/linked-ios-native-evidence.json"
cp "$LATCHWAY_NATIVE_PROFILE_PATH" "$output/linked-ios-native-profile.json"
(
 cd "$output"
 shasum -a 256 device-inventory.json gateway-client-policy.json gateway-deployment-public-key.pem gateway-deployment-statement.json gateway-deployment-statement.sig gateway-deployment-verification.json linked-ios-native-evidence.json linked-ios-native-profile.json react-native-ios-collection.json react-native-ios-evidence.json react-native-ios-junit.xml react-native-ios-observation.json react-native-ios-profile.json react-native-ios-run.json react-native-ios-validation.json > SHA256SUMS
)
chmod 600 "$output"/*.json "$output"/*.pem "$output"/*.sig "$output"/*.xml "$output/SHA256SUMS"
echo "physical React Native iOS evidence accepted: $evidence"
