#!/usr/bin/env bash
set +x
set -euo pipefail

# Capture the fresh-install Firebase custom token in a shell-only slot before
# any child process can inherit the exported workflow variable.
latchway_device_grant="${LATCHWAY_ONE_TIME_DEVICE_GRANT:-}"
unset LATCHWAY_ONE_TIME_DEVICE_GRANT
export -n latchway_device_grant

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
  LATCHWAY_EVIDENCE_OUTPUT_DIR LATCHWAY_ANDROID_DEVICE_SERIAL LATCHWAY_PACKAGE_NAME
  LATCHWAY_APP_VERSION LATCHWAY_VERSION_CODE LATCHWAY_SIGNING_CERTIFICATE_SHA256
  LATCHWAY_INSTALLED_APK_SET_SHA256 LATCHWAY_PLAY_TRACK LATCHWAY_CLOUD_PROJECT_NUMBER
  LATCHWAY_SOURCE_COMMIT LATCHWAY_CORE_COMMIT LATCHWAY_ANDROID_COMMIT
  LATCHWAY_RN_SDK_VERSION LATCHWAY_NATIVE_SDK_VERSION LATCHWAY_CONTRACT_VERSION
  LATCHWAY_CONTRACT_BUNDLE_SHA256 LATCHWAY_GATEWAY_IMAGE_DIGEST
  LATCHWAY_GATEWAY_CONFIGURATION_SHA256 LATCHWAY_NATIVE_EVIDENCE_SHA256
  LATCHWAY_GATEWAY_ORIGIN LATCHWAY_GATEWAY_DEPLOYMENT_KEY_ID
  LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256 LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_PATH
  LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256 LATCHWAY_GATEWAY_MINIMUM_TRUST_LEVEL
  LATCHWAY_ENVIRONMENT LATCHWAY_ERROR_MAPPING_FEATURE
  LATCHWAY_APPLICATION_ID
  LATCHWAY_NATIVE_EVIDENCE_PATH LATCHWAY_NATIVE_PROFILE_PATH LATCHWAY_RUN_ID
  LATCHWAY_DEVICE_GRANT_SHA256
)
for name in "${required[@]}"; do [[ -n "${!name:-}" ]] || { echo "required protected variable is missing: $name" >&2; exit 2; }; done
for tool in adb apksigner apkanalyzer cmp curl install java openssl python3 shasum; do command -v "$tool" >/dev/null || { echo "required tool is unavailable: $tool" >&2; exit 2; }; done
# shellcheck source=scripts/gateway-deployment-evidence.sh
source "$repository_root/scripts/gateway-deployment-evidence.sh"
[[ "$LATCHWAY_PACKAGE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$ ]] || { echo "invalid package pin" >&2; exit 2; }
[[ "$LATCHWAY_APPLICATION_ID" =~ ^app_[0-7][0-9A-HJKMNP-TV-Z]{25}$ ]] || { echo "invalid application ID pin" >&2; exit 2; }
[[ "$LATCHWAY_APP_VERSION" =~ ^[^[:space:]]{1,64}$ ]] || { echo "invalid version pin" >&2; exit 2; }
[[ "$LATCHWAY_VERSION_CODE" =~ ^[1-9][0-9]{0,17}$ && "$LATCHWAY_CLOUD_PROJECT_NUMBER" =~ ^[1-9][0-9]{0,18}$ ]] || { echo "invalid build/cloud pin" >&2; exit 2; }
[[ "$LATCHWAY_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ && "$LATCHWAY_CORE_COMMIT" =~ ^[0-9a-f]{40}$ && "$LATCHWAY_ANDROID_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid commit pin" >&2; exit 2; }
[[ "$LATCHWAY_SIGNING_CERTIFICATE_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_INSTALLED_APK_SET_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_NATIVE_EVIDENCE_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid artifact pin" >&2; exit 2; }
[[ "$LATCHWAY_CONTRACT_BUNDLE_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_GATEWAY_CONFIGURATION_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid configuration pin" >&2; exit 2; }
[[ "$LATCHWAY_GATEWAY_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid image pin" >&2; exit 2; }
[[ "$LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256" =~ ^[0-9a-f]{64}$ && "$LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid gateway deployment hash pin" >&2; exit 2; }
[[ "$LATCHWAY_DEVICE_GRANT_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid one-use identity grant pin" >&2; exit 2; }
(( ${#latchway_device_grant} >= 32 && ${#latchway_device_grant} <= 65536 )) || { echo "invalid one-use identity grant length" >&2; exit 2; }
[[ "$latchway_device_grant" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || { echo "one-use identity grant is not a Firebase custom-token JWT" >&2; exit 2; }
[[ "$(printf '%s' "$latchway_device_grant" | shasum -a 256 | awk '{print $1}')" == "$LATCHWAY_DEVICE_GRANT_SHA256" ]] || { echo "one-use identity grant hash mismatch" >&2; exit 1; }
case "$LATCHWAY_GATEWAY_MINIMUM_TRUST_LEVEL" in device_verified|strong_device_verified) ;; *) echo "invalid gateway minimum trust level" >&2; exit 2;; esac
[[ "$LATCHWAY_RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$ ]] || { echo "invalid run ID" >&2; exit 2; }
case "$LATCHWAY_PLAY_TRACK" in internal|closed|open|production) ;; *) echo "invalid Play track" >&2; exit 2;; esac
[[ -f "$LATCHWAY_NATIVE_EVIDENCE_PATH" && ! -L "$LATCHWAY_NATIVE_EVIDENCE_PATH" && -f "$LATCHWAY_NATIVE_PROFILE_PATH" && ! -L "$LATCHWAY_NATIVE_PROFILE_PATH" ]] || { echo "linked native evidence is unsafe" >&2; exit 2; }

mkdir -p "$LATCHWAY_EVIDENCE_OUTPUT_DIR"
output="$(cd "$LATCHWAY_EVIDENCE_OUTPUT_DIR" && pwd -P)"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/latchway-rn-android.XXXXXX")"
cleanup() {
  latchway_device_grant=""
  unset latchway_device_grant
  if [[ -d "$temporary" && "$temporary" == */latchway-rn-android.* ]]; then rm -rf "$temporary"; fi
}
trap cleanup EXIT
[[ "$(git -C "$repository_root" rev-parse HEAD)" == "$LATCHWAY_SOURCE_COMMIT" ]] || { echo "source commit mismatch" >&2; exit 1; }
[[ -z "$(git -C "$repository_root" status --porcelain=v1 --untracked-files=all)" ]] || { echo "physical evidence requires a clean source tree" >&2; exit 1; }
python3 "$repository_root/scripts/verify-linked-native-evidence.py" \
  --platform android_play_integrity --profile "$LATCHWAY_NATIVE_PROFILE_PATH" \
  --evidence "$LATCHWAY_NATIVE_EVIDENCE_PATH" --output-schema "$schema" \
  --expected-sha256 "$LATCHWAY_NATIVE_EVIDENCE_SHA256" \
  --expected-source-commit "$LATCHWAY_ANDROID_COMMIT" \
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

adb_device() { adb -s "$LATCHWAY_ANDROID_DEVICE_SERIAL" "$@"; }
[[ "$(adb_device get-state)" == device ]] || { echo "selected device is not ready" >&2; exit 1; }
build_type="$(adb_device shell getprop ro.build.type | tr -d '\r')"
tags="$(adb_device shell getprop ro.build.tags | tr -d '\r')"
debuggable="$(adb_device shell getprop ro.debuggable | tr -d '\r')"
secure="$(adb_device shell getprop ro.secure | tr -d '\r')"
qemu="$(adb_device shell getprop ro.kernel.qemu | tr -d '\r')"
boot="$(adb_device shell getprop ro.boot.verifiedbootstate | tr -d '\r')"
locked="$(adb_device shell getprop ro.boot.flash.locked | tr -d '\r')"
[[ "$build_type" == user && "$debuggable" == 0 && "$secure" == 1 && "$qemu" != 1 && "$tags" != *test-keys* && "$boot" == green && "$locked" == 1 ]] || { echo "emulator/debug/unlocked device rejected" >&2; exit 1; }
capture_installed_apk_set() {
  local phase="$1"
  local output_manifest="$2"
  [[ "$phase" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || { echo "invalid installed APK capture phase" >&2; return 1; }
  local source_info
  source_info="$(adb_device shell cmd package get-install-source "$LATCHWAY_PACKAGE_NAME" | tr -d '\r')"
  [[ "$source_info" == *com.android.vending* ]] || { echo "candidate is not Play installed" >&2; return 1; }

  local remote_paths_raw="$temporary/$phase-remote-apk-paths.raw"
  local remote_paths="$temporary/$phase-remote-apk-paths.txt"
  adb_device shell pm path "$LATCHWAY_PACKAGE_NAME" >"$remote_paths_raw"
  python3 - "$remote_paths_raw" "$remote_paths" <<'PY'
import pathlib, re, sys
raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
paths = []
for line in raw.splitlines():
    if not line.startswith("package:"): raise SystemExit("unexpected package-path output")
    value = line.removeprefix("package:").rstrip("\r")
    if re.fullmatch(r"/[A-Za-z0-9_./=+-]+\.apk", value) is None: raise SystemExit("unsafe APK path")
    paths.append(value)
if not 1 <= len(paths) <= 64 or len(paths) != len(set(paths)): raise SystemExit("invalid APK path set")
if sum(path.endswith("/base.apk") for path in paths) != 1: raise SystemExit("exactly one base APK is required")
if len({path.rsplit("/", 1)[-1] for path in paths}) != len(paths): raise SystemExit("ambiguous APK names")
pathlib.Path(sys.argv[2]).write_text("".join(path + "\n" for path in sorted(paths)), encoding="utf-8")
PY
  local apk_set_dir="$temporary/$phase-apk-set"
  local manifest_unsorted="$temporary/$phase-installed-apk-set.unsorted"
  mkdir "$apk_set_dir"
  while IFS= read -r remote_apk; do
    local apk_name="${remote_apk##*/}"
    local apk="$apk_set_dir/$apk_name"
    adb_device exec-out cat "$remote_apk" >"$apk"
    [[ -s "$apk" && ! -L "$apk" ]] || { echo "installed APK could not be collected safely" >&2; return 1; }
    local apksigner_report="$temporary/$phase-$apk_name-apksigner.txt"
    apksigner verify --verbose --print-certs "$apk" >"$apksigner_report"
    python3 "$repository_root/scripts/verify-apksigner-report.py" \
      "$LATCHWAY_SIGNING_CERTIFICATE_SHA256" <"$apksigner_report"
    local actual_package actual_code actual_version apk_sha256
    actual_package="$(apkanalyzer manifest application-id "$apk")"
    actual_code="$(apkanalyzer manifest version-code "$apk")"
    [[ "$actual_package" == "$LATCHWAY_PACKAGE_NAME" && "$actual_code" == "$LATCHWAY_VERSION_CODE" ]] || { echo "signed split identity mismatch" >&2; return 1; }
    actual_version="$(apkanalyzer manifest version-name "$apk" 2>/dev/null || true)"
    if [[ "$apk_name" == base.apk ]]; then
      [[ "$actual_version" == "$LATCHWAY_APP_VERSION" ]] || { echo "installed base APK version name mismatch" >&2; return 1; }
    else
      [[ -z "$actual_version" || "$actual_version" == "$LATCHWAY_APP_VERSION" ]] || { echo "signed split version name mismatch" >&2; return 1; }
    fi
    apk_sha256="$(shasum -a 256 "$apk" | awk '{print $1}')"
    printf '%s\t%s\n' "$apk_name" "$apk_sha256" >>"$manifest_unsorted"
  done <"$remote_paths"
  LC_ALL=C sort "$manifest_unsorted" >"$output_manifest"
  shasum -a 256 "$output_manifest" | awk '{print $1}'
}

apk_set_manifest="$output/installed-apk-set.sha256"
pre_run_apk_set_sha256="$(capture_installed_apk_set pre-run "$apk_set_manifest")"
[[ "$pre_run_apk_set_sha256" == "$LATCHWAY_INSTALLED_APK_SET_SHA256" ]] || { echo "installed APK set mismatch" >&2; exit 1; }

client_policy="$temporary/gateway-client-policy.json"
python3 - "$client_policy" <<'PY'
import json, os, pathlib, sys
policy = {"allow_debug": False, "allow_testing": False, "app_version": os.environ["LATCHWAY_APP_VERSION"],
 "application_identifier": os.environ["LATCHWAY_PACKAGE_NAME"], "build_number": os.environ["LATCHWAY_VERSION_CODE"],
 "cloud_project_number": os.environ["LATCHWAY_CLOUD_PROJECT_NUMBER"], "installer_package": "com.android.vending",
 "minimum_trust_level": os.environ["LATCHWAY_GATEWAY_MINIMUM_TRUST_LEVEL"], "platform": "react_native_android_play_integrity",
 "play_track": os.environ["LATCHWAY_PLAY_TRACK"], "provider": "play_integrity", "require_licensed": True,
 "require_play_recognized": True, "require_request_hash": True,
 "signing_certificate_sha256": os.environ["LATCHWAY_SIGNING_CERTIFICATE_SHA256"]}
pathlib.Path(sys.argv[1]).write_text(json.dumps(policy, allow_nan=False, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
PY
latchway_capture_gateway_deployment "$output" "$client_policy"

[[ "$(adb_device shell pm clear "$LATCHWAY_PACKAGE_NAME" | tr -d '\r')" == Success ]] || { echo "failed to clear candidate application data" >&2; exit 1; }
[[ -z "$(adb_device shell pidof "$LATCHWAY_PACKAGE_NAME" | tr -d '\r')" ]] || { echo "candidate process survived app-data clear" >&2; exit 1; }
adb_device shell am start -n "$LATCHWAY_PACKAGE_NAME/com.latchwayexample.MainActivity" --es dev.latchway.RUN_ID "$LATCHWAY_RUN_ID" >/dev/null
grant_uri="content://$LATCHWAY_PACKAGE_NAME.device-evidence/v1/identity-grant/$LATCHWAY_DEVICE_GRANT_SHA256/$LATCHWAY_RUN_ID/$LATCHWAY_APPLICATION_ID/$LATCHWAY_PACKAGE_NAME/firebase"
printf '%s' "$latchway_device_grant" | adb_device shell content write --uri "$grant_uri" >/dev/null
latchway_device_grant=""
unset latchway_device_grant
raw="$output/react-native-android-run.json"
ready=false
for _ in {1..180}; do
  candidate="$temporary/run.json"
  if adb_device exec-out content read --uri "content://$LATCHWAY_PACKAGE_NAME.device-evidence/v1/latest" >"$candidate" 2>/dev/null; then
    if python3 - "$candidate" "$LATCHWAY_RUN_ID" <<'PY'
import json, pathlib, sys
try: value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
except Exception: raise SystemExit(1)
raise SystemExit(0 if value.get("run", {}).get("id") == sys.argv[2] else 1)
PY
    then cp "$candidate" "$raw"; ready=true; break; fi
  fi
  sleep 5
done
[[ "$ready" == true ]] || { echo "React Native Android run was not produced" >&2; exit 1; }

post_run_apk_set_manifest="$temporary/installed-apk-set-post-run.sha256"
post_run_apk_set_sha256="$(capture_installed_apk_set post-run "$post_run_apk_set_manifest")"
[[ "$post_run_apk_set_sha256" == "$pre_run_apk_set_sha256" && "$post_run_apk_set_sha256" == "$LATCHWAY_INSTALLED_APK_SET_SHA256" ]] || {
  echo "installed APK set changed during physical evidence collection" >&2
  exit 1
}
cmp --silent "$apk_set_manifest" "$post_run_apk_set_manifest" || {
  echo "installed APK manifest changed during physical evidence collection" >&2
  exit 1
}
export LATCHWAY_OBSERVED_INSTALLED_APK_SET_SHA256="$post_run_apk_set_sha256"

inventory="$output/device-inventory.json"
collection="$output/react-native-android-collection.json"
export LATCHWAY_DEVICE_MODEL="$(adb_device shell getprop ro.product.manufacturer | tr -d '\r') $(adb_device shell getprop ro.product.model | tr -d '\r')"
export LATCHWAY_DEVICE_OS_VERSION="$(adb_device shell getprop ro.build.version.release | tr -d '\r')"
export LATCHWAY_DEVICE_OS_BUILD="$(adb_device shell getprop ro.build.id | tr -d '\r')"
export LATCHWAY_DEVICE_SECURITY_PATCH="$(adb_device shell getprop ro.build.version.security_patch | tr -d '\r')"
python3 - "$raw" "$inventory" "$collection" <<'PY'
import json, os, pathlib, sys
raw = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")); device = raw["device"]
if device.get("physical") is not True or device.get("emulator") is not False: raise SystemExit("not physical")
if device.get("model") != os.environ["LATCHWAY_DEVICE_MODEL"][:128] or device.get("os_version") != os.environ["LATCHWAY_DEVICE_OS_VERSION"][:64] or device.get("os_build") != os.environ["LATCHWAY_DEVICE_OS_BUILD"][:64]: raise SystemExit("device facts mismatch")
inventory = {"schema_version": "latchway.physical-device-inventory.v1", "collector": "adb-getprop", "collector_version": "1", "physical": True,
 "model": device["model"], "os_name": "Android", "os_version": device["os_version"], "os_build": device["os_build"],
 "security_patch": os.environ["LATCHWAY_DEVICE_SECURITY_PATCH"][:64], "verified_boot": "green"}
pathlib.Path(sys.argv[2]).write_text(json.dumps(inventory, indent=2, sort_keys=True) + "\n", encoding="utf-8")
pins = raw["pins"]
expected_distribution = "play_" + os.environ["LATCHWAY_PLAY_TRACK"]
if pins["distribution"] != expected_distribution: raise SystemExit("distribution pin mismatch")
application = {**raw["application"], "build_mode": "release", "distribution": expected_distribution,
 "signing_certificate_sha256": pins["signing_certificate_sha256"], "cloud_project_number": pins["cloud_project_number"], "play_track": pins["play_track"]}
collection = {"schema_version": "latchway.react-native-collector.v1", "platform": raw["platform"], "application": application, "device": raw["device"]}
pathlib.Path(sys.argv[3]).write_text(json.dumps(collection, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
inventory_hash="$(shasum -a 256 "$inventory" | awk '{print $1}')"
export LATCHWAY_RUNNER_OS="$(uname -s) $(uname -r)"
export LATCHWAY_RUNNER_ARCH="$(uname -m)"
export LATCHWAY_COMPILER="$(java -version 2>&1 | head -n 1)"
export LATCHWAY_BUILD_TOOL="$(apksigner --version 2>&1 | head -n 1)"
export LATCHWAY_DEVICE_INVENTORY_SHA256="$inventory_hash"
profile="$output/react-native-android-profile.json"
python3 - "$profile" <<'PY'
import json, os, pathlib, sys
expected = {"application_identifier": os.environ["LATCHWAY_PACKAGE_NAME"], "app_version": os.environ["LATCHWAY_APP_VERSION"],
 "build_number": os.environ["LATCHWAY_VERSION_CODE"], "signing_certificate_sha256": os.environ["LATCHWAY_SIGNING_CERTIFICATE_SHA256"],
 "cloud_project_number": os.environ["LATCHWAY_CLOUD_PROJECT_NUMBER"], "installer_package": "com.android.vending", "play_track": os.environ["LATCHWAY_PLAY_TRACK"],
 "require_licensed": "true", "native_sdk_version": os.environ["LATCHWAY_NATIVE_SDK_VERSION"], "native_evidence_sha256": os.environ["LATCHWAY_NATIVE_EVIDENCE_SHA256"],
 "source_commit": os.environ["LATCHWAY_SOURCE_COMMIT"], "core_commit": os.environ["LATCHWAY_CORE_COMMIT"], "contract_bundle_sha256": os.environ["LATCHWAY_CONTRACT_BUNDLE_SHA256"],
 "gateway_image_digest": os.environ["LATCHWAY_GATEWAY_IMAGE_DIGEST"], "gateway_configuration_sha256": os.environ["LATCHWAY_GATEWAY_CONFIGURATION_SHA256"],
 "gateway_origin": os.environ["LATCHWAY_GATEWAY_ORIGIN"], "gateway_environment": os.environ["LATCHWAY_ENVIRONMENT"],
 "error_mapping_feature": os.environ["LATCHWAY_ERROR_MAPPING_FEATURE"],
 "gateway_deployment_key_id": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_KEY_ID"],
 "gateway_deployment_statement_sha256": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256"],
 "gateway_deployment_public_key_sha256": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256"]}
profile = {"schema_version": "latchway.physical-device-profile.v1", "platform": "react_native_android_play_integrity", "repository": "Latchway/latchway-react-native-sdk",
 "source": {"commit": os.environ["LATCHWAY_SOURCE_COMMIT"], "core_commit": os.environ["LATCHWAY_CORE_COMMIT"], "worktree_clean": True,
 "sdk_version": os.environ["LATCHWAY_RN_SDK_VERSION"], "contract_version": os.environ["LATCHWAY_CONTRACT_VERSION"], "contract_bundle_sha256": os.environ["LATCHWAY_CONTRACT_BUNDLE_SHA256"],
 "gateway_image_digest": os.environ["LATCHWAY_GATEWAY_IMAGE_DIGEST"], "gateway_configuration_sha256": os.environ["LATCHWAY_GATEWAY_CONFIGURATION_SHA256"],
 "gateway_origin": os.environ["LATCHWAY_GATEWAY_ORIGIN"], "gateway_deployment_key_id": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_KEY_ID"],
 "gateway_deployment_statement_sha256": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256"],
 "gateway_deployment_public_key_sha256": os.environ["LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256"]},
 "toolchain": {"runner_os": os.environ["LATCHWAY_RUNNER_OS"], "runner_arch": os.environ["LATCHWAY_RUNNER_ARCH"], "compiler": os.environ["LATCHWAY_COMPILER"],
 "build_tool": os.environ["LATCHWAY_BUILD_TOOL"], "collector_version": "1"}, "expected_pins": expected,
 "application_binary_sha256": os.environ["LATCHWAY_OBSERVED_INSTALLED_APK_SET_SHA256"], "device_inventory_sha256": os.environ["LATCHWAY_DEVICE_INVENTORY_SHA256"]}
pathlib.Path(sys.argv[1]).write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
observation="$output/react-native-android-observation.json"
python3 "$repository_root/scripts/finalize-react-native-device-run.py" \
  --raw "$raw" --collection "$collection" --profile "$profile" \
  --native-evidence "$LATCHWAY_NATIVE_EVIDENCE_PATH" --native-profile "$LATCHWAY_NATIVE_PROFILE_PATH" \
  --client-policy "$output/gateway-client-policy.json" \
  --schema "$schema" --observation "$observation"
latchway_recheck_gateway_deployment "$output" "$temporary"
latchway_verify_observation_against_gateway_policy "$observation" "$output/gateway-client-policy.json"
evidence="$output/react-native-android-evidence.json"
python3 "$repository_root/scripts/device-evidence.py" finalize --schema "$schema" --profile "$profile" --observation "$observation" --evidence "$evidence" --junit "$output/react-native-android-junit.xml" --summary "$output/react-native-android-validation.json"
cp "$LATCHWAY_NATIVE_EVIDENCE_PATH" "$output/linked-android-native-evidence.json"
cp "$LATCHWAY_NATIVE_PROFILE_PATH" "$output/linked-android-native-profile.json"
(
 cd "$output"
 shasum -a 256 device-inventory.json gateway-client-policy.json gateway-deployment-public-key.pem gateway-deployment-statement.json gateway-deployment-statement.sig gateway-deployment-verification.json installed-apk-set.sha256 linked-android-native-evidence.json linked-android-native-profile.json react-native-android-collection.json react-native-android-evidence.json react-native-android-junit.xml react-native-android-observation.json react-native-android-profile.json react-native-android-run.json react-native-android-validation.json > SHA256SUMS
)
chmod 600 "$output"/*.json "$output"/*.pem "$output"/*.sig "$output"/*.xml "$output"/*.sha256 "$output/SHA256SUMS"
echo "physical React Native Android evidence accepted: $evidence"
