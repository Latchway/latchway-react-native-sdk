#!/usr/bin/env bash
set -euo pipefail

# Normal developer/CI builds deliberately have no provider configuration. The
# physical candidate producer opts in and supplies a protected file path; only
# the file bytes (never an identity grant or service-account credential) enter
# the signed application bundle.
[[ "${LATCHWAY_PHYSICAL_CANDIDATE:-0}" == 1 ]] || exit 0
[[ "${CONFIGURATION:-}" == Release ]] || { echo "physical Firebase configuration requires Release" >&2; exit 2; }

required=(
  LATCHWAY_FIREBASE_IOS_CONFIG_PATH
  LATCHWAY_FIREBASE_CONFIGURATION_SHA256
  LATCHWAY_CANDIDATE_CONFIGURATION_SHA256
  PRODUCT_BUNDLE_IDENTIFIER
  TARGET_BUILD_DIR
  UNLOCALIZED_RESOURCES_FOLDER_PATH
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "required protected Firebase build input is missing: $name" >&2; exit 2; }
done

source_path="$LATCHWAY_FIREBASE_IOS_CONFIG_PATH"
[[ -f "$source_path" && ! -L "$source_path" && -s "$source_path" ]] || {
  echo "protected Firebase iOS configuration is missing or unsafe" >&2
  exit 2
}
[[ "$LATCHWAY_FIREBASE_CONFIGURATION_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "invalid protected Firebase configuration digest" >&2
  exit 2
}
[[ "$LATCHWAY_CANDIDATE_CONFIGURATION_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "invalid protected candidate configuration digest" >&2
  exit 2
}
actual_sha256="$(shasum -a 256 "$source_path" | awk '{print $1}')"
[[ "$actual_sha256" == "$LATCHWAY_FIREBASE_CONFIGURATION_SHA256" ]] || {
  echo "protected Firebase iOS configuration digest mismatch" >&2
  exit 1
}

python3 - "$source_path" "$PRODUCT_BUNDLE_IDENTIFIER" <<'PY'
import pathlib
import plistlib
import re
import sys

path = pathlib.Path(sys.argv[1])
if path.stat().st_size > 131_072:
    raise SystemExit("protected Firebase iOS configuration is too large")
try:
    value = plistlib.loads(path.read_bytes())
except Exception as failure:
    raise SystemExit("protected Firebase iOS configuration is not a plist") from failure
if not isinstance(value, dict) or value.get("BUNDLE_ID") != sys.argv[2]:
    raise SystemExit("Firebase iOS bundle identifier does not match the candidate")
patterns = {
    "API_KEY": re.compile(r"^[A-Za-z0-9_-]{16,256}$"),
    "GOOGLE_APP_ID": re.compile(r"^[A-Za-z0-9:._-]{8,256}$"),
    "PROJECT_ID": re.compile(r"^[a-z][a-z0-9-]{3,62}$"),
}
for key, pattern in patterns.items():
    item = value.get(key)
    if not isinstance(item, str) or pattern.fullmatch(item) is None:
        raise SystemExit(f"Firebase iOS configuration has an invalid {key}")
PY

destination_directory="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
[[ -d "$destination_directory" && ! -L "$destination_directory" ]] || {
  echo "signed application resources directory is missing or unsafe" >&2
  exit 1
}
install -m 0600 "$source_path" "$destination_directory/GoogleService-Info.plist"
/usr/libexec/PlistBuddy -c "Add :LatchwayFirebaseConfigurationSHA256 string $LATCHWAY_FIREBASE_CONFIGURATION_SHA256" \
  "$TARGET_BUILD_DIR/$INFOPLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :LatchwayCandidateConfigurationSHA256 string $LATCHWAY_CANDIDATE_CONFIGURATION_SHA256" \
  "$TARGET_BUILD_DIR/$INFOPLIST_PATH"
