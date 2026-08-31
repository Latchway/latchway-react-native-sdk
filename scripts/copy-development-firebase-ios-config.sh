#!/usr/bin/env bash
set +x
set -euo pipefail

mode="${LATCHWAY_DEVELOPMENT_DEVICE_BOOTSTRAP:-false}"
[[ "$mode" == false || -z "$mode" ]] && exit 0
[[ "$mode" == true ]] || {
  echo "invalid development device bootstrap mode" >&2
  exit 2
}
[[ "${LATCHWAY_PHYSICAL_CANDIDATE:-0}" == 0 ]] || {
  echo "development Firebase configuration is forbidden for a physical candidate" >&2
  exit 2
}
[[ "${CONFIGURATION:-}" == Debug ]] || {
  echo "development Firebase configuration requires Debug" >&2
  exit 2
}
[[ "${PLATFORM_NAME:-}" == iphoneos ]] || {
  echo "development Firebase configuration requires a physical iOS device build" >&2
  exit 2
}

required=(
  LATCHWAY_DEVELOPMENT_FIREBASE_IOS_CONFIG_PATH
  LATCHWAY_DEVELOPMENT_FIREBASE_CONFIGURATION_SHA256
  PRODUCT_BUNDLE_IDENTIFIER
  SRCROOT
  TARGET_BUILD_DIR
  UNLOCALIZED_RESOURCES_FOLDER_PATH
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || {
    echo "required development Firebase build input is missing: $name" >&2
    exit 2
  }
done

source_path="$LATCHWAY_DEVELOPMENT_FIREBASE_IOS_CONFIG_PATH"
[[ -f "$source_path" && ! -L "$source_path" && -s "$source_path" ]] || {
  echo "development Firebase iOS configuration is missing or unsafe" >&2
  exit 2
}
[[ "$LATCHWAY_DEVELOPMENT_FIREBASE_CONFIGURATION_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "invalid development Firebase configuration digest" >&2
  exit 2
}

actual_sha256="$(shasum -a 256 "$source_path" | awk '{print $1}')"
[[ "$actual_sha256" == "$LATCHWAY_DEVELOPMENT_FIREBASE_CONFIGURATION_SHA256" ]] || {
  echo "development Firebase iOS configuration digest mismatch" >&2
  exit 1
}

repository_root="$(cd "$SRCROOT/../.." && pwd -P)"
python3 - "$source_path" "$PRODUCT_BUNDLE_IDENTIFIER" "$repository_root" <<'PY'
import pathlib
import plistlib
import re
import sys

path = pathlib.Path(sys.argv[1])
repository = pathlib.Path(sys.argv[3]).resolve(strict=True)
try:
    resolved = path.resolve(strict=True)
    stat = path.lstat()
except (FileNotFoundError, OSError, RuntimeError) as failure:
    raise SystemExit("development Firebase iOS configuration is unavailable") from failure
if path.is_symlink() or not resolved.is_file() or stat.st_size <= 0:
    raise SystemExit("development Firebase iOS configuration is not a safe regular file")
if resolved == repository or repository in resolved.parents:
    raise SystemExit("development Firebase iOS configuration must remain external to the repository")
if stat.st_size > 131_072:
    raise SystemExit("development Firebase iOS configuration is too large")
try:
    value = plistlib.loads(resolved.read_bytes())
except Exception as failure:
    raise SystemExit("development Firebase iOS configuration is not a plist") from failure
if not isinstance(value, dict) or value.get("BUNDLE_ID") != sys.argv[2]:
    raise SystemExit("Firebase iOS bundle identifier does not match the development application")
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
  echo "development application resources directory is missing or unsafe" >&2
  exit 1
}
destination="$destination_directory/GoogleService-Info.plist"
[[ ! -L "$destination" ]] || {
  echo "development Firebase destination is unsafe" >&2
  exit 1
}

temporary="$(mktemp "$destination_directory/.latchway-development-firebase.XXXXXX")"
[[ -f "$temporary" && ! -L "$temporary" ]] || {
  echo "development Firebase temporary destination is unsafe" >&2
  exit 1
}
cleanup() {
  if [[ -f "$temporary" && ! -L "$temporary" ]]; then
    rm -f "$temporary"
  fi
}
trap cleanup EXIT
install -m 0600 "$source_path" "$temporary"
[[ "$(shasum -a 256 "$temporary" | awk '{print $1}')" == "$actual_sha256" ]] || {
  echo "copied development Firebase configuration digest mismatch" >&2
  exit 1
}
mv -f "$temporary" "$destination"
[[ -f "$destination" && ! -L "$destination" ]] || {
  echo "development Firebase configuration was not installed safely" >&2
  exit 1
}
[[ "$(shasum -a 256 "$destination" | awk '{print $1}')" == "$actual_sha256" ]] || {
  echo "installed development Firebase configuration digest mismatch" >&2
  exit 1
}
