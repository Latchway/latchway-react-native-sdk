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
for tool in codesign env git install python3 shasum xcodebuild xcrun; do
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

temporary="$(mktemp -d "${TMPDIR:-/tmp}/latchway-rn-ios-development.XXXXXX")"
cleanup() {
  unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT
  unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256
  unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID
  latchway_development_grant=""
  latchway_development_grant_sha256=""
  latchway_development_run_id=""
  unset latchway_development_grant
  unset latchway_development_grant_sha256
  unset latchway_development_run_id
  if [[ -d "$temporary" && "$temporary" == */latchway-rn-ios-development.* ]]; then
    rm -rf "$temporary"
  fi
}
trap cleanup EXIT

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

codesign --verify --deep --strict "$app"
root_entitlements="$temporary/root-entitlements.plist"
codesign -d --entitlements :- "$app" >"$root_entitlements" 2>/dev/null
python3 - "$root_entitlements" "$LATCHWAY_IOS_TEAM_ID" \
  "$LATCHWAY_IOS_APP_ID_PREFIX.$LATCHWAY_BUNDLE_ID" \
  "$private_keychain_access_group" "$LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP" <<'PY'
import pathlib
import plistlib
import sys

value = plistlib.loads(pathlib.Path(sys.argv[1]).read_bytes())
if value.get("com.apple.developer.team-identifier") != sys.argv[2]:
    raise SystemExit("signed development root Team ID mismatch")
if value.get("application-identifier") != sys.argv[3]:
    raise SystemExit("signed development root application identifier mismatch")
if value.get("com.apple.developer.devicecheck.appattest-environment") != "development":
    raise SystemExit("signed development root does not use App Attest development")
if value.get("com.apple.developer.devicecheck.app-attest-opt-in") != ["CDhash"]:
    raise SystemExit("signed development root does not have the exact App Attest CDhash opt-in")
if value.get("keychain-access-groups") != [sys.argv[4], sys.argv[5]]:
    raise SystemExit("signed development root Keychain access groups are not private-first/shared-second")
if value.get("get-task-allow") is not True:
    raise SystemExit("signed development root is not development-signed")
PY

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
codesign --verify --strict "$appintents"
actual_appintents_bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$appintents/Info.plist")"
[[ "$actual_appintents_bundle" == "$LATCHWAY_IOS_APPINTENTS_BUNDLE_ID" ]] || {
  echo "signed development App Intents bundle identifier mismatch" >&2
  exit 1
}
appintents_entitlements="$temporary/appintents-entitlements.plist"
codesign -d --entitlements :- "$appintents" >"$appintents_entitlements" 2>/dev/null
python3 - "$appintents_entitlements" "$LATCHWAY_IOS_TEAM_ID" \
  "$LATCHWAY_IOS_APP_ID_PREFIX.$LATCHWAY_IOS_APPINTENTS_BUNDLE_ID" \
  "$LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP" <<'PY'
import pathlib
import plistlib
import sys

value = plistlib.loads(pathlib.Path(sys.argv[1]).read_bytes())
if value.get("com.apple.developer.team-identifier") != sys.argv[2]:
    raise SystemExit("signed development App Intents Team ID mismatch")
if value.get("application-identifier") != sys.argv[3]:
    raise SystemExit("signed development App Intents application identifier mismatch")
if value.get("keychain-access-groups") != [sys.argv[4]]:
    raise SystemExit("signed development App Intents target is not shared-only")
for key in (
    "com.apple.developer.devicecheck.appattest-environment",
    "com.apple.developer.devicecheck.app-attest-opt-in",
):
    if key in value:
        raise SystemExit("signed development App Intents target must not carry App Attest")
PY

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
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT="$latchway_development_grant"
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256="$latchway_development_grant_sha256"
export DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID="$latchway_development_run_id"
launch_status=0
xcrun devicectl device process launch \
  --device "$LATCHWAY_IOS_DEVICE_ID" --terminate-existing --timeout 30 \
  "$LATCHWAY_BUNDLE_ID" >/dev/null || launch_status=$?
unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT
unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256
unset DEVICECTL_CHILD_LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID
latchway_development_grant=""
latchway_development_grant_sha256=""
unset latchway_development_grant
unset latchway_development_grant_sha256
(( launch_status == 0 )) || {
  echo "development application launch failed" >&2
  exit "$launch_status"
}

marker="$temporary/latchway-development-verification.json"
marker_observed=false
for ((attempt = 0; attempt < 180; attempt += 1)); do
  rm -f "$marker"
  if xcrun devicectl device copy from \
      --device "$LATCHWAY_IOS_DEVICE_ID" \
      --domain-type appDataContainer \
      --domain-identifier "$LATCHWAY_BUNDLE_ID" \
      --source "Library/Caches/latchway-development-verification.json" \
      --destination "$marker" --timeout 5 >/dev/null 2>&1; then
    python3 - "$marker" "$latchway_development_run_id" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
if path.is_symlink() or not path.is_file() or path.stat().st_size > 4096:
    raise SystemExit("development verification marker is unsafe")
try:
    value = json.loads(path.read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError) as failure:
    raise SystemExit("development verification marker is malformed") from failure
if value.get("schema_version") == 1 and value.get("run_id") == sys.argv[2] and value.get("status") == "failed":
    stage = value.get("failure_stage")
    code = value.get("failure_code")
    stages = {
        "firebase_configuration",
        "firebase_custom_token",
        "native_session_establishment",
        "gateway_responses",
        "diagnostics",
        "quota",
        "installation_revoke",
        "firebase_sign_out",
        "success_marker",
    }
    if stage not in stages or not isinstance(code, str) or not __import__("re").fullmatch(r"[a-z][a-z0-9_]{1,99}", code):
        raise SystemExit("development verification failure receipt is malformed")
    raise SystemExit(f"development verification failed at {stage}: {code}")
expected = {
    "schema_version": 1,
    "run_id": sys.argv[2],
    "status": "passed",
    "checks": [
        "firebase_custom_token",
        "gateway_responses",
        "diagnostics_app_attest_app_verified_react_native_ios",
        "quota",
        "installation_revoked",
        "firebase_signed_out",
    ],
}
if value != expected:
    raise SystemExit("development verification marker does not prove the exact run")
PY
    marker_observed=true
    break
  fi
  sleep 1
done
[[ "$marker_observed" == true ]] || {
  echo "development application did not emit a passing terminal verification marker; dismiss any iOS permission sheet and rerun with a fresh grant" >&2
  exit 1
}

echo "development React Native iOS verification accepted"
