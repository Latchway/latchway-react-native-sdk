#!/usr/bin/env bash
set +x
set -euo pipefail

# Capture the fresh-install Firebase custom token in a shell-only slot before
# any child process can inherit the exported workflow variable.
latchway_device_grant="${LATCHWAY_ONE_TIME_DEVICE_GRANT:-}"
unset LATCHWAY_ONE_TIME_DEVICE_GRANT
export -n latchway_device_grant

for environment_name in "${!DEVICECTL_CHILD_@}"; do
  echo "pre-existing CoreDevice child environment is forbidden" >&2
  exit 2
done
for environment_name in "${!LATCHWAY_@}"; do
  case "$environment_name" in
    LATCHWAY_DEVICE_GRANT_SHA256)
      ;;
    *TOKEN*|*GRANT*)
      echo "unexpected ambient identity or device grant is forbidden" >&2
      exit 2
      ;;
  esac
done

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
schema="$repository_root/Conformance/physical-device-evidence.schema.json"
required=(
  LATCHWAY_EVIDENCE_OUTPUT_DIR LATCHWAY_IOS_DEVICE_ID LATCHWAY_IOS_APP_BUNDLE_PATH
  LATCHWAY_IOS_INSTALL_MODE LATCHWAY_BUNDLE_ID LATCHWAY_IOS_APPINTENTS_BUNDLE_ID
  LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP LATCHWAY_APP_VERSION LATCHWAY_BUILD_NUMBER
  LATCHWAY_TEAM_ID LATCHWAY_IOS_APP_ID_PREFIX LATCHWAY_SIGNING_CERTIFICATE_SHA256 LATCHWAY_APP_BINARY_SHA256
  LATCHWAY_IOS_JAVASCRIPT_BUNDLE_SHA256 LATCHWAY_IOS_APP_FILES_MANIFEST_SHA256
  LATCHWAY_IOS_APP_BUNDLE_TREE_SHA256
  LATCHWAY_DISTRIBUTION LATCHWAY_SOURCE_COMMIT LATCHWAY_CORE_COMMIT LATCHWAY_IOS_COMMIT
  LATCHWAY_RN_SDK_VERSION LATCHWAY_NATIVE_SDK_VERSION LATCHWAY_CONTRACT_VERSION
  LATCHWAY_CONTRACT_BUNDLE_SHA256 LATCHWAY_GATEWAY_IMAGE_DIGEST
  LATCHWAY_GATEWAY_CONFIGURATION_SHA256 LATCHWAY_NATIVE_EVIDENCE_SHA256
  LATCHWAY_GATEWAY_ORIGIN LATCHWAY_GATEWAY_DEPLOYMENT_KEY_ID
  LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256 LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_PATH
  LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256 LATCHWAY_GATEWAY_MINIMUM_TRUST_LEVEL
  LATCHWAY_ENVIRONMENT LATCHWAY_ERROR_MAPPING_FEATURE
  LATCHWAY_NATIVE_EVIDENCE_PATH LATCHWAY_NATIVE_PROFILE_PATH LATCHWAY_RUN_ID
  LATCHWAY_DEVICE_GRANT_SHA256
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "required protected variable is missing: $name" >&2; exit 2; }
done
for tool in cmp codesign curl ditto install openssl python3 shasum swift xcodebuild; do
  command -v "$tool" >/dev/null || { echo "required tool is unavailable: $tool" >&2; exit 2; }
done
# shellcheck source=scripts/gateway-deployment-evidence.sh
source "$repository_root/scripts/gateway-deployment-evidence.sh"
[[ "$LATCHWAY_IOS_INSTALL_MODE" == install ]] || { echo "physical evidence requires installing the pinned app bundle" >&2; exit 2; }
case "$LATCHWAY_DISTRIBUTION" in ad_hoc|testflight|app_store) ;; *) echo "invalid distribution" >&2; exit 2;; esac
[[ "$LATCHWAY_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ && "$LATCHWAY_CORE_COMMIT" =~ ^[0-9a-f]{40}$ && "$LATCHWAY_IOS_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid commit pin" >&2; exit 2; }
[[ "$LATCHWAY_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo "invalid team pin" >&2; exit 2; }
[[ "$LATCHWAY_IOS_APP_ID_PREFIX" =~ ^[A-Z0-9]{10}$ ]] || { echo "invalid App ID Prefix pin" >&2; exit 2; }
[[ "$LATCHWAY_IOS_APPINTENTS_BUNDLE_ID" == "$LATCHWAY_BUNDLE_ID".* && "$LATCHWAY_IOS_APPINTENTS_BUNDLE_ID" != "$LATCHWAY_BUNDLE_ID" ]] || { echo "invalid App Intents bundle ID pin" >&2; exit 2; }
[[ "$LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP" == "$LATCHWAY_IOS_APP_ID_PREFIX.$LATCHWAY_BUNDLE_ID.keychain" ]] || { echo "shared Keychain access-group pin is not bound to the root App ID" >&2; exit 2; }
private_keychain_access_group="$LATCHWAY_IOS_APP_ID_PREFIX.$LATCHWAY_BUNDLE_ID"
[[ "$LATCHWAY_SIGNING_CERTIFICATE_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_APP_BINARY_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_IOS_JAVASCRIPT_BUNDLE_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_IOS_APP_FILES_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_IOS_APP_BUNDLE_TREE_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_NATIVE_EVIDENCE_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid artifact pin" >&2; exit 2; }
[[ "$LATCHWAY_CONTRACT_BUNDLE_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_GATEWAY_CONFIGURATION_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid configuration pin" >&2; exit 2; }
[[ "$LATCHWAY_GATEWAY_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid image pin" >&2; exit 2; }
[[ "$LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid gateway deployment hash pin" >&2; exit 2; }
[[ "$LATCHWAY_DEVICE_GRANT_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid one-use identity grant pin" >&2; exit 2; }
(( ${#latchway_device_grant} >= 32 && ${#latchway_device_grant} <= 65536 )) || { echo "invalid one-use identity grant length" >&2; exit 2; }
[[ "$latchway_device_grant" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || { echo "one-use identity grant is not a Firebase custom-token JWT" >&2; exit 2; }
[[ "$(printf '%s' "$latchway_device_grant" | shasum -a 256 | awk '{print $1}')" == "$LATCHWAY_DEVICE_GRANT_SHA256" ]] || { echo "one-use identity grant hash mismatch" >&2; exit 1; }
[[ "$LATCHWAY_GATEWAY_MINIMUM_TRUST_LEVEL" == app_verified ]] || { echo "iOS App Attest requires the normalized app_verified gateway trust level" >&2; exit 2; }
[[ "$LATCHWAY_RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$ ]] || { echo "invalid run ID" >&2; exit 2; }
[[ -d "$LATCHWAY_IOS_APP_BUNDLE_PATH" && ! -L "$LATCHWAY_IOS_APP_BUNDLE_PATH" && "$LATCHWAY_IOS_APP_BUNDLE_PATH" == *.app ]] || { echo "signed app bundle is unsafe" >&2; exit 2; }
[[ -f "$LATCHWAY_NATIVE_EVIDENCE_PATH" && ! -L "$LATCHWAY_NATIVE_EVIDENCE_PATH" && -f "$LATCHWAY_NATIVE_PROFILE_PATH" && ! -L "$LATCHWAY_NATIVE_PROFILE_PATH" ]] || { echo "linked native evidence is unsafe" >&2; exit 2; }

mkdir -p "$LATCHWAY_EVIDENCE_OUTPUT_DIR"
output="$(cd "$LATCHWAY_EVIDENCE_OUTPUT_DIR" && pwd -P)"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/latchway-rn-ios.XXXXXX")"
cleanup() {
  unset DEVICECTL_CHILD_LATCHWAY_ONE_TIME_DEVICE_GRANT DEVICECTL_CHILD_LATCHWAY_DEVICE_GRANT_SHA256
  unset DEVICECTL_CHILD_LATCHWAY_JAVASCRIPT_BUNDLE_SHA256
  latchway_device_grant=""
  unset latchway_device_grant
  if [[ -d "$temporary" && "$temporary" == */latchway-rn-ios.* ]]; then rm -rf "$temporary"; fi
}
trap cleanup EXIT

caller_app_bundle_path="$LATCHWAY_IOS_APP_BUNDLE_PATH"
snapshot_directory="$temporary/candidate-snapshot"
install -d -m 0700 "$snapshot_directory"
snapshot_app_bundle_path="$snapshot_directory/LatchwayExample.app"
ditto --norsrc "$caller_app_bundle_path" "$snapshot_app_bundle_path"
unset caller_app_bundle_path
LATCHWAY_IOS_APP_BUNDLE_PATH="$snapshot_app_bundle_path"
export LATCHWAY_IOS_APP_BUNDLE_PATH
snapshot_files_manifest="$temporary/snapshot-app-files-initial.sha256"
snapshot_tree_sha256="$(python3 "$repository_root/scripts/physical_app_bundle_tree.py" \
  --app-files-manifest "$snapshot_files_manifest" \
  "$LATCHWAY_IOS_APP_BUNDLE_PATH")"
[[ "$snapshot_tree_sha256" == "$LATCHWAY_IOS_APP_BUNDLE_TREE_SHA256" ]] || { echo "private application snapshot does not match the protected bundle-tree hash" >&2; exit 1; }
[[ "$(shasum -a 256 "$snapshot_files_manifest" | awk '{print $1}')" == "$LATCHWAY_IOS_APP_FILES_MANIFEST_SHA256" ]] || { echo "private application snapshot does not match the protected files-manifest hash" >&2; exit 1; }

[[ "$(git -C "$repository_root" rev-parse HEAD)" == "$LATCHWAY_SOURCE_COMMIT" ]] || { echo "source commit mismatch" >&2; exit 1; }
[[ -z "$(git -C "$repository_root" status --porcelain=v1 --untracked-files=all)" ]] || { echo "physical evidence requires a clean source tree" >&2; exit 1; }
python3 "$repository_root/scripts/verify-linked-native-evidence.py" \
  --platform ios_app_attest --profile "$LATCHWAY_NATIVE_PROFILE_PATH" \
  --evidence "$LATCHWAY_NATIVE_EVIDENCE_PATH" --output-schema "$schema" \
  --expected-sha256 "$LATCHWAY_NATIVE_EVIDENCE_SHA256" \
  --expected-source-commit "$LATCHWAY_IOS_COMMIT" \
  --expected-core-commit "$LATCHWAY_CORE_COMMIT" \
  --expected-native-sdk-version "$LATCHWAY_NATIVE_SDK_VERSION" \
  --expected-contract-version "$LATCHWAY_CONTRACT_VERSION" \
  --expected-contract-bundle-sha256 "$LATCHWAY_CONTRACT_BUNDLE_SHA256" \
  --expected-gateway-image-digest "$LATCHWAY_GATEWAY_IMAGE_DIGEST" \
  --expected-gateway-configuration-sha256 "$LATCHWAY_GATEWAY_CONFIGURATION_SHA256" \
  --expected-gateway-origin "$LATCHWAY_GATEWAY_ORIGIN" \
  --expected-gateway-deployment-key-id "$LATCHWAY_GATEWAY_DEPLOYMENT_KEY_ID" \
  --expected-gateway-deployment-statement-sha256 "$LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256" \
  --expected-gateway-deployment-public-key-sha256 "$LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256"

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
[[ "$actual_team" == "$LATCHWAY_TEAM_ID" && "$actual_attest" == production && "$actual_app_identifier" == "$LATCHWAY_IOS_APP_ID_PREFIX.$LATCHWAY_BUNDLE_ID" ]] || { echo "production App Attest/team/App ID Prefix identity mismatch" >&2; exit 1; }
[[ -z "$actual_get_task_allow" || "$actual_get_task_allow" == false ]] || { echo "release evidence rejects get-task-allow" >&2; exit 1; }
python3 - "$entitlements" "$private_keychain_access_group" "$LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP" <<'PY'
import pathlib, plistlib, sys
value = plistlib.loads(pathlib.Path(sys.argv[1]).read_bytes())
groups = value.get("keychain-access-groups")
if groups != [sys.argv[2], sys.argv[3]]:
    raise SystemExit("signed root target does not have the exact private-first/shared-second Keychain access groups")
if value.get("com.apple.developer.devicecheck.app-attest-opt-in") != ["CDhash"]:
    raise SystemExit("signed root target does not have the exact App Attest CDhash opt-in")
PY
certificate_prefix="$temporary/certificate"
codesign -d --extract-certificates "$certificate_prefix" "$LATCHWAY_IOS_APP_BUNDLE_PATH" 2>/dev/null
actual_certificate="$(shasum -a 256 "${certificate_prefix}0" | awk '{print $1}')"
actual_binary="$(shasum -a 256 "$LATCHWAY_IOS_APP_BUNDLE_PATH/$executable" | awk '{print $1}')"
actual_javascript_bundle="$(shasum -a 256 "$javascript_bundle" | awk '{print $1}')"
[[ "$actual_certificate" == "$LATCHWAY_SIGNING_CERTIFICATE_SHA256" && "$actual_binary" == "$LATCHWAY_APP_BINARY_SHA256" && "$actual_javascript_bundle" == "$LATCHWAY_IOS_JAVASCRIPT_BUNDLE_SHA256" ]] || { echo "signed certificate/executable/JavaScript bundle mismatch" >&2; exit 1; }

appintents="$LATCHWAY_IOS_APP_BUNDLE_PATH/Extensions/AppIntents.appex"
appintents_info="$appintents/Info.plist"
[[ -d "$appintents" && ! -L "$appintents" && -f "$appintents_info" && ! -L "$appintents_info" ]] || { echo "signed App Intents extension is unsafe or absent" >&2; exit 1; }
codesign --verify --strict "$appintents"
actual_appintents_bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$appintents_info")"
[[ "$actual_appintents_bundle" == "$LATCHWAY_IOS_APPINTENTS_BUNDLE_ID" ]] || { echo "signed App Intents bundle identity mismatch" >&2; exit 1; }
appintents_entitlements="$temporary/appintents-entitlements.plist"
codesign -d --entitlements :- "$appintents" >"$appintents_entitlements" 2>/dev/null
python3 - "$appintents_entitlements" "$LATCHWAY_TEAM_ID" "$LATCHWAY_IOS_APP_ID_PREFIX.$LATCHWAY_IOS_APPINTENTS_BUNDLE_ID" "$LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP" <<'PY'
import pathlib, plistlib, sys
value = plistlib.loads(pathlib.Path(sys.argv[1]).read_bytes())
if value.get("com.apple.developer.team-identifier") != sys.argv[2]:
    raise SystemExit("signed App Intents Team ID mismatch")
if value.get("application-identifier") != sys.argv[3]:
    raise SystemExit("signed App Intents application identifier mismatch")
if value.get("keychain-access-groups") != [sys.argv[4]]:
    raise SystemExit("signed App Intents target does not have only the exact shared Keychain access group")
if value.get("get-task-allow") not in (None, False):
    raise SystemExit("release App Intents target enables get-task-allow")
for key in (
    "com.apple.developer.devicecheck.appattest-environment",
    "com.apple.developer.devicecheck.app-attest-opt-in",
):
    if key in value:
        raise SystemExit("App Intents target must not carry an App Attest entitlement")
PY
appintents_certificate_prefix="$temporary/appintents-certificate"
codesign -d --extract-certificates "$appintents_certificate_prefix" "$appintents" 2>/dev/null
[[ "$(shasum -a 256 "${appintents_certificate_prefix}0" | awk '{print $1}')" == "$LATCHWAY_SIGNING_CERTIFICATE_SHA256" ]] || { echo "signed App Intents certificate mismatch" >&2; exit 1; }

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
installed_apps="$temporary/preinstall-apps.json"
xcrun devicectl device info apps --device "$LATCHWAY_IOS_DEVICE_ID" --bundle-id "$LATCHWAY_BUNDLE_ID" \
  --include-all-apps --timeout 30 --json-output "$installed_apps" --omit-deprecated-fields-in-json >/dev/null
if python3 - "$installed_apps" "$LATCHWAY_BUNDLE_ID" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if value.get("info", {}).get("outcome") != "success": raise SystemExit("devicectl app query failed")
def contains(item):
    if isinstance(item, dict): return any(contains(child) for child in item.values())
    if isinstance(item, list): return any(contains(child) for child in item)
    return item == sys.argv[2]
raise SystemExit(0 if contains(value.get("result", {})) else 1)
PY
then
  xcrun devicectl device uninstall app --device "$LATCHWAY_IOS_DEVICE_ID" --timeout 60 "$LATCHWAY_BUNDLE_ID" >/dev/null
fi
post_uninstall_apps="$temporary/post-uninstall-apps.json"
xcrun devicectl device info apps --device "$LATCHWAY_IOS_DEVICE_ID" --bundle-id "$LATCHWAY_BUNDLE_ID" \
  --include-all-apps --timeout 30 --json-output "$post_uninstall_apps" --omit-deprecated-fields-in-json >/dev/null
python3 - "$post_uninstall_apps" "$LATCHWAY_BUNDLE_ID" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if value.get("info", {}).get("outcome") != "success": raise SystemExit("devicectl app query failed")
def contains(item):
    if isinstance(item, dict): return any(contains(child) for child in item.values())
    if isinstance(item, list): return any(contains(child) for child in item)
    return item == sys.argv[2]
if contains(value.get("result", {})): raise SystemExit("candidate application remained after pre-run uninstall")
PY
snapshot_files_manifest="$temporary/snapshot-app-files-preinstall.sha256"
snapshot_tree_sha256="$(python3 "$repository_root/scripts/physical_app_bundle_tree.py" \
  --app-files-manifest "$snapshot_files_manifest" \
  "$LATCHWAY_IOS_APP_BUNDLE_PATH")"
[[ "$snapshot_tree_sha256" == "$LATCHWAY_IOS_APP_BUNDLE_TREE_SHA256" ]] || { echo "private application snapshot changed before installation" >&2; exit 1; }
[[ "$(shasum -a 256 "$snapshot_files_manifest" | awk '{print $1}')" == "$LATCHWAY_IOS_APP_FILES_MANIFEST_SHA256" ]] || { echo "private application files changed before installation" >&2; exit 1; }
xcrun devicectl device install app --device "$LATCHWAY_IOS_DEVICE_ID" --timeout 120 "$LATCHWAY_IOS_APP_BUNDLE_PATH" >/dev/null
postinstall_snapshot_files_manifest="$temporary/snapshot-app-files-postinstall.sha256"
postinstall_snapshot_tree_sha256="$(python3 "$repository_root/scripts/physical_app_bundle_tree.py" \
  --app-files-manifest "$postinstall_snapshot_files_manifest" \
  "$LATCHWAY_IOS_APP_BUNDLE_PATH")"
[[ "$postinstall_snapshot_tree_sha256" == "$LATCHWAY_IOS_APP_BUNDLE_TREE_SHA256" ]] || { echo "private application snapshot changed during installation" >&2; exit 1; }
[[ "$(shasum -a 256 "$postinstall_snapshot_files_manifest" | awk '{print $1}')" == "$LATCHWAY_IOS_APP_FILES_MANIFEST_SHA256" ]] || { echo "private application files changed during installation" >&2; exit 1; }
cmp --silent "$snapshot_files_manifest" "$postinstall_snapshot_files_manifest" || { echo "private application manifest changed during installation" >&2; exit 1; }
export DEVICECTL_CHILD_LATCHWAY_RUN_ID="$LATCHWAY_RUN_ID"
export DEVICECTL_CHILD_LATCHWAY_JAVASCRIPT_BUNDLE_SHA256="$LATCHWAY_IOS_JAVASCRIPT_BUNDLE_SHA256"
export DEVICECTL_CHILD_LATCHWAY_ONE_TIME_DEVICE_GRANT="$latchway_device_grant"
export DEVICECTL_CHILD_LATCHWAY_DEVICE_GRANT_SHA256="$LATCHWAY_DEVICE_GRANT_SHA256"
xcrun devicectl device process launch --device "$LATCHWAY_IOS_DEVICE_ID" --terminate-existing --timeout 30 "$LATCHWAY_BUNDLE_ID" >/dev/null
unset DEVICECTL_CHILD_LATCHWAY_ONE_TIME_DEVICE_GRANT DEVICECTL_CHILD_LATCHWAY_DEVICE_GRANT_SHA256
unset DEVICECTL_CHILD_LATCHWAY_JAVASCRIPT_BUNDLE_SHA256
latchway_device_grant=""
unset latchway_device_grant
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
 "application_files_manifest_sha256": os.environ["LATCHWAY_IOS_APP_FILES_MANIFEST_SHA256"],
 "application_bundle_tree_sha256": os.environ["LATCHWAY_IOS_APP_BUNDLE_TREE_SHA256"],
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
