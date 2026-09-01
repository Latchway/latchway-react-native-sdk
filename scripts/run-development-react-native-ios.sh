#!/usr/bin/env bash
set +x
set -euo pipefail

# Capture the custom token and its digest before any child process can inherit
# their exported workflow variables. These lowercase variables are deliberately
# not exported.
latchway_development_grant="${LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT:-}"
latchway_development_grant_sha256="${LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256:-}"
unset LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT
unset LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256
export -n latchway_development_grant
export -n latchway_development_grant_sha256

for environment_name in "${!DEVICECTL_CHILD_@}"; do
  echo "pre-existing CoreDevice child environment is forbidden" >&2
  exit 2
done
for environment_name in "${!LATCHWAY_@}"; do
  case "$environment_name" in
    *TOKEN*|*GRANT*|*PASSWORD*|*PRIVATE_KEY*|*SERVICE_ACCOUNT*|*CREDENTIAL*|*SECRET*)
      echo "unexpected ambient credential-shaped input is forbidden" >&2
      exit 2
      ;;
  esac
done

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
required=(
  LATCHWAY_DEVELOPMENT_FIREBASE_IOS_CONFIG_PATH
  LATCHWAY_DEVELOPMENT_FIREBASE_CONFIGURATION_SHA256
  LATCHWAY_DEVELOPMENT_ENVFILE
  LATCHWAY_IOS_DEVICE_ID
  LATCHWAY_IOS_XCODE_DESTINATION_ID
  LATCHWAY_IOS_APP_ID_PREFIX
  LATCHWAY_IOS_TEAM_ID
  LATCHWAY_BUNDLE_ID
  LATCHWAY_IOS_APPINTENTS_BUNDLE_ID
  LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || {
    echo "required development variable is missing: $name" >&2
    exit 2
  }
done
for tool in codesign env git install lipo openssl python3 security shasum xcodebuild xcrun; do
  command -v "$tool" >/dev/null || {
    echo "required development tool is unavailable: $tool" >&2
    exit 2
  }
done

[[ "$LATCHWAY_BUNDLE_ID" == dev.latchway ]] || {
  echo "development runner requires the registered dev.latchway application" >&2
  exit 2
}
[[ "$LATCHWAY_IOS_DEVICE_ID" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] || {
  echo "invalid CoreDevice identifier" >&2
  exit 2
}
[[ "$LATCHWAY_IOS_XCODE_DESTINATION_ID" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$ ||
   "$LATCHWAY_IOS_XCODE_DESTINATION_ID" =~ ^[0-9A-Fa-f]{40}$ ]] || {
  echo "invalid Xcode device destination identifier" >&2
  exit 2
}
[[ "$LATCHWAY_IOS_APPINTENTS_BUNDLE_ID" == "$LATCHWAY_BUNDLE_ID.AppIntents" ]] || {
  echo "development App Intents bundle identifier mismatch" >&2
  exit 2
}
[[ "$LATCHWAY_IOS_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || {
  echo "invalid development Team ID" >&2
  exit 2
}
[[ "$LATCHWAY_IOS_APP_ID_PREFIX" =~ ^[A-Z0-9]{10}$ ]] || {
  echo "invalid development App ID Prefix" >&2
  exit 2
}
private_keychain_access_group="$LATCHWAY_IOS_APP_ID_PREFIX.$LATCHWAY_BUNDLE_ID"
[[ "$LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP" == "$private_keychain_access_group.keychain" ]] || {
  echo "development shared Keychain access group mismatch" >&2
  exit 2
}
[[ "$latchway_development_grant_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "invalid development identity grant digest" >&2
  exit 2
}
[[ "$LATCHWAY_DEVELOPMENT_FIREBASE_CONFIGURATION_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "invalid development Firebase configuration digest" >&2
  exit 2
}
[[ -f "$LATCHWAY_DEVELOPMENT_FIREBASE_IOS_CONFIG_PATH" &&
   ! -L "$LATCHWAY_DEVELOPMENT_FIREBASE_IOS_CONFIG_PATH" ]] || {
  echo "development Firebase configuration is unsafe" >&2
  exit 2
}
[[ -f "$LATCHWAY_DEVELOPMENT_ENVFILE" && ! -L "$LATCHWAY_DEVELOPMENT_ENVFILE" ]] || {
  echo "development environment file is unsafe" >&2
  exit 2
}
development_envfile="$(cd "$(dirname "$LATCHWAY_DEVELOPMENT_ENVFILE")" && pwd -P)/$(basename "$LATCHWAY_DEVELOPMENT_ENVFILE")"
case "$development_envfile" in
  "$repository_root/example/.env"|"$repository_root/example/.env."*)
    ;;
  *)
    echo "development environment file must be an ignored example .env file" >&2
    exit 2
    ;;
esac
[[ "$development_envfile" != "$repository_root/example/.env.example" ]] || {
  echo "the tracked example environment template cannot be used as a build input" >&2
  exit 2
}
git -C "$repository_root" check-ignore --quiet -- "$development_envfile" || {
  echo "development environment file must be ignored by Git" >&2
  exit 2
}
python3 "$repository_root/scripts/validate-development-react-native-ios-env.py" \
  "$development_envfile" "$LATCHWAY_BUNDLE_ID" "$LATCHWAY_IOS_APP_ID_PREFIX" \
  "$LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP"
app_intent_build_output="$(python3 "$repository_root/scripts/validate-development-react-native-ios-env.py" \
  "$development_envfile" "$LATCHWAY_BUNDLE_ID" "$LATCHWAY_IOS_APP_ID_PREFIX" \
  "$LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP" --emit-app-intent-build-values)"
app_intent_build_values=()
while IFS= read -r value; do
  app_intent_build_values+=("$value")
done <<< "$app_intent_build_output"
[[ "${#app_intent_build_values[@]}" -eq 6 ]] || {
  echo "development App Intent build coordinates are incomplete" >&2
  exit 2
}
app_intent_gateway_url="${app_intent_build_values[0]}"
app_intent_application_id="${app_intent_build_values[1]}"
app_intent_environment="${app_intent_build_values[2]}"
app_intent_component_definition_id="${app_intent_build_values[3]}"
app_intent_feature="${app_intent_build_values[4]}"
app_intent_model="${app_intent_build_values[5]}"
unset app_intent_build_output app_intent_build_values
case "$(cd "$(dirname "$LATCHWAY_DEVELOPMENT_FIREBASE_IOS_CONFIG_PATH")" && pwd -P)/$(basename "$LATCHWAY_DEVELOPMENT_FIREBASE_IOS_CONFIG_PATH")" in
  "$repository_root"|"$repository_root"/*)
    echo "development Firebase configuration must remain external to the repository" >&2
    exit 2
    ;;
esac

(( ${#latchway_development_grant} >= 32 && ${#latchway_development_grant} <= 65536 )) || {
  echo "invalid development identity grant length" >&2
  exit 2
}
[[ "$latchway_development_grant" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || {
  echo "development identity grant is not a Firebase custom-token JWT" >&2
  exit 2
}
actual_grant_sha256="$(printf '%s' "$latchway_development_grant" | shasum -a 256 | awk '{print $1}')"
[[ "$actual_grant_sha256" == "$latchway_development_grant_sha256" ]] || {
  echo "development identity grant digest mismatch" >&2
  exit 1
}

validate_development_grant() {
  local now
  now="$(date +%s)"
  [[ "$(printf '%s' "$latchway_development_grant" | shasum -a 256 | awk '{print $1}')" == \
      "$latchway_development_grant_sha256" ]] || {
    echo "development identity grant digest changed" >&2
    return 1
  }
  printf '%s' "$latchway_development_grant" | python3 -c '
import base64
import json
import sys

now = int(sys.argv[1])
token = sys.stdin.read()
try:
    payload_segment = token.split(".")[1]
    payload_segment += "=" * (-len(payload_segment) % 4)
    payload = json.loads(base64.urlsafe_b64decode(payload_segment.encode("ascii")))
except Exception as failure:
    raise SystemExit("development identity grant payload is malformed") from failure
if not isinstance(payload, dict):
    raise SystemExit("development identity grant payload is malformed")
iat = payload.get("iat")
exp = payload.get("exp")
if isinstance(iat, bool) or not isinstance(iat, int) or isinstance(exp, bool) or not isinstance(exp, int):
    raise SystemExit("development identity grant timestamps are invalid")
if iat > now + 60 or now - iat > 300 or exp <= now or exp <= iat or exp - iat > 3600:
    raise SystemExit("development identity grant is stale or has an invalid lifetime")
if payload.get("aud") != "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit":
    raise SystemExit("development identity grant has an invalid audience")
if not isinstance(payload.get("uid"), str) or not payload["uid"] or len(payload["uid"]) > 128:
    raise SystemExit("development identity grant has an invalid uid")
' "$now"
}
validate_development_grant

workspace="$repository_root/example/ios/LatchwayExample.xcworkspace"
[[ -d "$workspace" && ! -L "$workspace" ]] || {
  echo "install CocoaPods before running the development device bootstrap" >&2
  exit 2
}

temporary_parent="${TMPDIR:-/tmp}"
temporary_parent="$(cd "$temporary_parent" && pwd -P)"
temporary="$(mktemp -d "$temporary_parent/latchway-rn-ios-development.XXXXXX")"
waiting_observed=false
terminal_cleanup_observed=false
abort_cleanup_in_progress=false
notification_observer_pid=""
initial_launch_attempted=false

stop_notification_observer() {
  if [[ -n "${notification_observer_pid:-}" ]]; then
    kill "$notification_observer_pid" >/dev/null 2>&1 || true
    wait "$notification_observer_pid" >/dev/null 2>&1 || true
    notification_observer_pid=""
  fi
}

wait_for_app_intent_window_remaining() {
  local remaining="$1"
  while (( remaining > 0 )); do
    sleep 1
    remaining=$((remaining - 1))
  done
}

clear_development_child_state() {
  unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT
  unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256
  unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID
  unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RESUME
  unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_ABORT
  latchway_development_grant=""
  latchway_development_grant_sha256=""
  unset latchway_development_grant
  unset latchway_development_grant_sha256
}

cleanup() {
  clear_development_child_state
  stop_notification_observer
  latchway_development_run_id=""
  unset latchway_development_run_id
  if [[ -d "$temporary" && "$temporary" == */latchway-rn-ios-development.* ]]; then
    rm -rf "$temporary"
  fi
}

finalize_runner() {
  local original_status=$?
  local abort_status=0
  # Disable every trap before cleanup so an abort failure or a second signal
  # cannot recurse through this exact-run finalizer.
  trap - EXIT INT TERM HUP
  # A signal can interrupt an initial or resume launch before its normal unset
  # statements. Clear every mutually exclusive child phase and the raw one-use
  # grant before inspecting the marker or exporting the sole abort phase.
  clear_development_child_state
  set +e
  stop_notification_observer
  if [[ "$initial_launch_attempted" == true && "$terminal_cleanup_observed" != true ]]; then
    # Close the atomic-marker/poll race. This exact-run refresh also recognizes
    # terminal cleanup that completed immediately before an interrupt.
    refresh_exact_run_cleanup_state
  fi
  if [[ "$waiting_observed" == true && "$terminal_cleanup_observed" != true &&
        "$abort_cleanup_in_progress" != true ]]; then
    echo "development verification ended after component preparation; starting exact-run abort cleanup" >&2
    run_abort_cleanup || abort_status=$?
    if (( abort_status == 0 )); then
      echo "development delegated verification was incomplete; descriptor-bound family cleanup completed" >&2
    else
      echo "development delegated verification was incomplete and bounded cleanup was not confirmed" >&2
    fi
    # A path that reached the waiting boundary can never become successful
    # merely because its compensating cleanup succeeded.
    if (( original_status == 0 )); then original_status=1; fi
  fi
  cleanup
  exit "$original_status"
}
trap finalize_runner EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

derived_data="$temporary/DerivedData"
xcode_environment=(
  "HOME=${HOME:?HOME is required for Apple development signing}"
  "PATH=${PATH:?PATH is required for the iOS toolchain}"
)
for safe_name in DEVELOPER_DIR LANG LC_ALL LOGNAME SHELL TMPDIR USER; do
  if [[ -n "${!safe_name:-}" ]]; then
    [[ "${!safe_name}" != *$'\n'* && "${!safe_name}" != *$'\r'* ]] || {
      echo "unsafe inherited Xcode environment value" >&2
      exit 2
    }
    xcode_environment+=("$safe_name=${!safe_name}")
  fi
done
env -i "${xcode_environment[@]}" \
  ENVFILE="$development_envfile" \
  FORCE_BUNDLING=1 \
  LATCHWAY_DEVELOPMENT_DEVICE_BOOTSTRAP=true \
  LATCHWAY_DEVELOPMENT_FIREBASE_IOS_CONFIG_PATH="$LATCHWAY_DEVELOPMENT_FIREBASE_IOS_CONFIG_PATH" \
  LATCHWAY_DEVELOPMENT_FIREBASE_CONFIGURATION_SHA256="$LATCHWAY_DEVELOPMENT_FIREBASE_CONFIGURATION_SHA256" \
  LATCHWAY_PHYSICAL_CANDIDATE=0 \
  xcodebuild \
  -workspace "$workspace" \
  -scheme LatchwayExample \
  -configuration Debug \
  -destination "platform=iOS,id=$LATCHWAY_IOS_XCODE_DESTINATION_ID" \
  -derivedDataPath "$derived_data" \
  DEVELOPMENT_TEAM="$LATCHWAY_IOS_TEAM_ID" \
  LATCHWAY_ROOT_BUNDLE_IDENTIFIER="$LATCHWAY_BUNDLE_ID" \
  LATCHWAY_APPINTENTS_BUNDLE_IDENTIFIER="$LATCHWAY_IOS_APPINTENTS_BUNDLE_ID" \
  LATCHWAY_APPINTENT_GATEWAY_URL="$app_intent_gateway_url" \
  LATCHWAY_APPINTENT_APPLICATION_ID="$app_intent_application_id" \
  LATCHWAY_APPINTENT_ENVIRONMENT="$app_intent_environment" \
  LATCHWAY_APPINTENT_COMPONENT_DEFINITION_ID="$app_intent_component_definition_id" \
  LATCHWAY_APPINTENT_FEATURE="$app_intent_feature" \
  LATCHWAY_APPINTENT_MODEL="$app_intent_model" \
  LATCHWAY_APPINTENT_ROOT_KEYCHAIN_ACCESS_GROUP="$private_keychain_access_group" \
  LATCHWAY_APPINTENT_SHARED_KEYCHAIN_ACCESS_GROUP="$LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP" \
  build

app="$derived_data/Build/Products/Debug-iphoneos/LatchwayExample.app"
plist="$app/Info.plist"
firebase_plist="$app/GoogleService-Info.plist"
javascript_bundle="$app/main.jsbundle"
[[ -d "$app" && ! -L "$app" && -f "$plist" && ! -L "$plist" &&
   -f "$firebase_plist" && ! -L "$firebase_plist" &&
   -f "$javascript_bundle" && ! -L "$javascript_bundle" ]] || {
  echo "development build did not produce a safe configured application" >&2
  exit 1
}
javascript_bundle_bytes="$(wc -c <"$javascript_bundle" | tr -d '[:space:]')"
[[ "$javascript_bundle_bytes" =~ ^[0-9]+$ &&
   "$javascript_bundle_bytes" -ge 1024 &&
   "$javascript_bundle_bytes" -le 67108864 ]] || {
  echo "development JavaScript bundle has an invalid size" >&2
  exit 1
}
[[ "$(shasum -a 256 "$firebase_plist" | awk '{print $1}')" == "$LATCHWAY_DEVELOPMENT_FIREBASE_CONFIGURATION_SHA256" ]] || {
  echo "built development Firebase configuration digest mismatch" >&2
  exit 1
}
actual_bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")"
[[ "$actual_bundle" == "$LATCHWAY_BUNDLE_ID" ]] || {
  echo "built development bundle identifier mismatch" >&2
  exit 1
}

appintents=""
for candidate in "$app/Extensions/AppIntents.appex" "$app/PlugIns/AppIntents.appex"; do
  if [[ -d "$candidate" && ! -L "$candidate" ]]; then
    [[ -z "$appintents" ]] || {
      echo "development application contains ambiguous App Intents extensions" >&2
      exit 1
    }
    appintents="$candidate"
  fi
done
[[ -n "$appintents" && -f "$appintents/Info.plist" && ! -L "$appintents/Info.plist" ]] || {
  echo "signed development App Intents extension is unsafe or absent" >&2
  exit 1
}
actual_appintents_bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$appintents/Info.plist")"
[[ "$actual_appintents_bundle" == "$LATCHWAY_IOS_APPINTENTS_BUNDLE_ID" ]] || {
  echo "signed development App Intents bundle identifier mismatch" >&2
  exit 1
}
python3 - "$appintents/Info.plist" "$app_intent_gateway_url" "$app_intent_application_id" \
  "$app_intent_environment" "$private_keychain_access_group" \
  "$LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP" "$app_intent_component_definition_id" \
  "$app_intent_feature" "$app_intent_model" <<'PY'
import pathlib
import plistlib
import sys

value = plistlib.loads(pathlib.Path(sys.argv[1]).read_bytes())
expected = {
    "LatchwayGatewayURL": sys.argv[2],
    "LatchwayApplicationID": sys.argv[3],
    "LatchwayEnvironment": sys.argv[4],
    "LatchwayRootKeychainAccessGroup": sys.argv[5],
    "LatchwayAppIntentKeychainAccessGroup": sys.argv[6],
    "LatchwayAppIntentComponentDefinitionID": sys.argv[7],
    "LatchwayAppIntentFeature": sys.argv[8],
    "LatchwayAppIntentModel": sys.argv[9],
}
if any(value.get(key) != item for key, item in expected.items()):
    raise SystemExit("built development App Intent configuration mismatch")
PY
python3 "$repository_root/scripts/verify_development_ios_signed_bundle.py" \
  --app "$app" \
  --extension "$appintents" \
  --bundle-id "$LATCHWAY_BUNDLE_ID" \
  --extension-bundle-id "$LATCHWAY_IOS_APPINTENTS_BUNDLE_ID" \
  --team-id "$LATCHWAY_IOS_TEAM_ID" \
  --app-id-prefix "$LATCHWAY_IOS_APP_ID_PREFIX" \
  --device-udid "$LATCHWAY_IOS_XCODE_DESTINATION_ID" \
  --private-keychain-group "$private_keychain_access_group" \
  --shared-keychain-group "$LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP"

# Preserve the application container when updating this Debug verifier. iOS
# resets Local Network consent on uninstall even though the embedded bundle does
# not depend on Metro. Identity and installation freshness are enforced inside
# the application: it consumes a new one-use Firebase grant, signs out any old
# Firebase user, and revokes the prior Latchway installation before measuring a
# replacement. Installing over the existing bundle preserves only OS consent.
xcrun devicectl device install app \
  --device "$LATCHWAY_IOS_DEVICE_ID" --timeout 120 "$app" >/dev/null

# Revalidate the immutable in-memory credential after the build and immediately
# before its only application launch. A stale or expired grant never reaches
# CoreDevice merely because it was fresh when a clean build began.
validate_development_grant
latchway_development_run_id="dev_$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
[[ "$latchway_development_run_id" =~ ^dev_[0-9a-f]{32}$ ]] || {
  echo "development verification run identifier generation failed" >&2
  exit 1
}
export -n latchway_development_run_id

marker="$temporary/latchway-development-verification.json"
copy_development_marker() {
  rm -f "$marker"
  xcrun devicectl device copy from \
    --device "$LATCHWAY_IOS_DEVICE_ID" \
    --domain-type appDataContainer \
    --domain-identifier "$LATCHWAY_BUNDLE_ID" \
    --source "Library/Caches/latchway-development-verification.json" \
    --destination "$marker" --timeout 5 >/dev/null 2>&1
}

marker_state() {
  python3 - "$marker" "$latchway_development_run_id" <<'PY'
import json
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 4096:
    raise SystemExit("development verification marker is unsafe")
try:
    value = json.loads(path.read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError) as failure:
    raise SystemExit("development verification marker is malformed") from failure
if value.get("schema_version") != 2 or value.get("run_id") != sys.argv[2]:
    raise SystemExit("development verification marker does not identify the exact run")
if value.get("status") == "failed":
    stages = {
        "firebase_configuration", "firebase_custom_token", "native_session_establishment",
        "gateway_responses", "diagnostics", "quota", "component_prepare", "app_intent_wait",
        "app_intent_receipt", "family_revoke", "firebase_sign_out", "success_marker",
    }
    stage = value.get("failure_stage")
    code = value.get("failure_code")
    if set(value) != {"schema_version", "run_id", "status", "failure_stage", "failure_code"} or \
            stage not in stages or not isinstance(code, str) or re.fullmatch(r"[a-z][a-z0-9_]{1,99}", code) is None:
        raise SystemExit("development verification failure receipt is malformed")
    print(f"failed {stage} {code}")
elif value == {
    "schema_version": 2,
    "run_id": sys.argv[2],
    "status": "waiting_for_app_intent",
}:
    print("waiting")
elif value == {
    "schema_version": 2,
    "run_id": sys.argv[2],
    "status": "passed",
    "checks": [
        "firebase_custom_token",
        "gateway_responses",
        "diagnostics_app_attest_app_verified_react_native_ios",
        "quota",
        "component_prepared",
        "app_intent_delegated_session",
        "app_intent_delegated_request",
        "installation_family_revoked",
        "firebase_signed_out",
    ],
}:
    print("passed")
elif value == {
    "schema_version": 2,
    "run_id": sys.argv[2],
    "status": "aborted",
    "reason": "delegated_verification_incomplete",
    "checks": ["installation_family_revoked", "firebase_signed_out"],
}:
    print("aborted")
else:
    raise SystemExit("development verification marker is not an allowed state")
PY
}

run_abort_cleanup() {
  if [[ "$abort_cleanup_in_progress" == true ]]; then return 1; fi
  abort_cleanup_in_progress=true
  stop_notification_observer

  export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID="$latchway_development_run_id"
  export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_ABORT=1
  local abort_status=0
  xcrun devicectl device process launch \
    --device "$LATCHWAY_IOS_DEVICE_ID" --terminate-existing --timeout 30 \
    "$LATCHWAY_BUNDLE_ID" >/dev/null || abort_status=$?
  clear_development_child_state
  if (( abort_status != 0 )); then
    echo "development exact-run abort-cleanup launch failed" >&2
    return "$abort_status"
  fi

  local state=""
  for ((attempt = 0; attempt < 120; attempt += 1)); do
    if copy_development_marker && state="$(marker_state 2>/dev/null)"; then
      case "$state" in
        aborted)
          terminal_cleanup_observed=true
          return 0
          ;;
        # These are admitted exact-run retry states. The launched host may
        # leave the prior marker in place until its cleanup turn completes.
        waiting|failed\ app_intent_receipt\ *|failed\ family_revoke\ *|failed\ firebase_sign_out\ *)
          ;;
        *)
          echo "development exact-run abort cleanup reached a non-abortable state" >&2
          return 1
          ;;
      esac
    fi
    sleep 1
  done
  echo "development exact-run abort cleanup marker timed out" >&2
  return 1
}

refresh_exact_run_cleanup_state() {
  local observed_state=""
  local refresh_attempt
  for ((refresh_attempt = 0; refresh_attempt < 5; refresh_attempt += 1)); do
    if copy_development_marker && observed_state="$(marker_state 2>/dev/null)"; then
      case "$observed_state" in
        waiting|failed\ app_intent_receipt\ *|failed\ family_revoke\ *|failed\ firebase_sign_out\ *)
          waiting_observed=true
          return 0
          ;;
        passed|aborted|failed\ success_marker\ *)
          terminal_cleanup_observed=true
          return 0
          ;;
      esac
    fi
    if (( refresh_attempt < 4 )); then sleep 1; fi
  done
  return 1
}

# Define every exact-run marker and abort helper before launching the host. If
# launch and marker publication race an interrupt, the EXIT finalizer can still
# inspect the atomic marker and perform the same bounded abort route.
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT="$latchway_development_grant"
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256="$latchway_development_grant_sha256"
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID="$latchway_development_run_id"
initial_launch_attempted=true
launch_status=0
xcrun devicectl device process launch \
  --device "$LATCHWAY_IOS_DEVICE_ID" --terminate-existing --timeout 30 \
  "$LATCHWAY_BUNDLE_ID" >/dev/null || launch_status=$?
clear_development_child_state
(( launch_status == 0 )) || {
  echo "development application launch failed" >&2
  exit "$launch_status"
}

for ((attempt = 0; attempt < 180; attempt += 1)); do
  if copy_development_marker; then
    state="$(marker_state)"
    case "$state" in
      waiting)
        waiting_observed=true
        break
        ;;
      failed\ *)
        echo "development verification ${state}" >&2
        exit 1
        ;;
      *)
        echo "development verification reached an unexpected initial state" >&2
        exit 1
        ;;
    esac
  fi
  sleep 1
done
[[ "$waiting_observed" == true ]] || {
  echo "development host did not prepare the App Intent component" >&2
  exit 1
}

# The one-use launch credential and its digest no longer exist in this process
# or the host's native slot. Observe only a fixed Darwin notification while a
# bounded Shortcuts URL attempt gives the system a chance to run the App
# Shortcut. The shared-Keychain receipt remains the authoritative proof.
[[ -z "${latchway_development_grant+x}" && -z "${latchway_development_grant_sha256+x}" ]] || {
  echo "development launch credential survived the waiting boundary" >&2
  exit 1
}
notification_result="$temporary/app-intent-notification.json"
notification_window_started=$SECONDS
xcrun devicectl device notification observe \
  --device "$LATCHWAY_IOS_DEVICE_ID" \
  --name "dev.latchway.debug.app-intent-proof-complete" \
  --session-timeout 180 --timeout 190 --json-output "$notification_result" \
  >/dev/null 2>&1 &
notification_observer_pid=$!
sleep 1
shortcuts_url_status=0
xcrun devicectl device process launch \
  --device "$LATCHWAY_IOS_DEVICE_ID" --terminate-existing --timeout 15 \
  --payload-url "shortcuts://run-shortcut?name=Run%20Latchway%20Proof" \
  com.apple.shortcuts >/dev/null 2>&1 || shortcuts_url_status=$?
if (( shortcuts_url_status != 0 )); then
  echo "The bounded Shortcuts URL attempt was unavailable." >&2
fi
echo "Waiting up to 180 seconds for the App Intent proof. If it does not run automatically, open Shortcuts and tap ‘Run Latchway Proof’ under the LatchwayExample App Shortcuts."
notification_status=0
wait "$notification_observer_pid" || notification_status=$?
notification_observer_pid=""
if (( notification_status != 0 )); then
  notification_elapsed=$((SECONDS - notification_window_started))
  notification_remaining=$((180 - notification_elapsed))
  if (( notification_remaining > 0 )); then
    echo "The Darwin notification observer ended early; preserving the remaining manual App Shortcut window." >&2
    wait_for_app_intent_window_remaining "$notification_remaining"
  fi
  echo "The Darwin notification wait ended without confirmation; the host will check the authoritative receipt." >&2
fi

# Resume with only the public exact-run identifier and a phase bit. No custom
# token, token digest, request body, component identifier, or session material
# crosses this second CoreDevice launch boundary.
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID="$latchway_development_run_id"
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RESUME=1
resume_status=0
xcrun devicectl device process launch \
  --device "$LATCHWAY_IOS_DEVICE_ID" --terminate-existing --timeout 30 \
  "$LATCHWAY_BUNDLE_ID" >/dev/null || resume_status=$?
clear_development_child_state
(( resume_status == 0 )) || {
  echo "development application cleanup launch failed" >&2
  exit "$resume_status"
}

terminal_observed=false
for ((attempt = 0; attempt < 120; attempt += 1)); do
  if copy_development_marker; then
    state="$(marker_state)"
    case "$state" in
      passed)
        terminal_observed=true
        terminal_cleanup_observed=true
        break
        ;;
      failed\ *)
        if [[ "$state" == failed\ success_marker\ * ]]; then
          # The host sets success_marker only after descriptor-bound family
          # retirement and Firebase sign-out both completed. No identity
          # remains, so this is terminal nonzero without another abort launch.
          terminal_cleanup_observed=true
        fi
        echo "development verification ${state}" >&2
        exit 1
        ;;
      waiting)
        ;;
      *)
        echo "development verification reached an unexpected terminal state" >&2
        exit 1
        ;;
    esac
  fi
  sleep 1
done
[[ "$terminal_observed" == true ]] || {
  echo "development application did not emit a terminal delegated-component marker" >&2
  exit 1
}

echo "development React Native iOS verification accepted"
