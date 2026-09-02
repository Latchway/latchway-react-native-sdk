#!/bin/sh
set -eu
umask 077

evidence_dir=${LATCHWAY_EVIDENCE_DIR:?LATCHWAY_EVIDENCE_DIR is required}
android_source_dir=${LATCHWAY_ANDROID_SOURCE_DIR:-_android_sdk}
android_commit=${LATCHWAY_ANDROID_SOURCE_COMMIT:?LATCHWAY_ANDROID_SOURCE_COMMIT is required}
native_repository=${LATCHWAY_NATIVE_REPOSITORY:-$android_source_dir/build/publication-test-repository}

test "$(git -C "$android_source_dir" rev-parse --verify HEAD)" = "$android_commit"
test -z "$(git -C "$android_source_dir" status --porcelain=v1 --untracked-files=all)"
test "$(jq --raw-output '.android.source_commit' release-compatibility.json)" = "$android_commit"
test "$(jq --raw-output '.android.version' release-compatibility.json)" = '1.0.0'
test "$(jq --raw-output '.android.group' release-compatibility.json)" = 'dev.latchway'
test "$(jq --raw-output '.android.repository' release-compatibility.json)" = 'https://github.com/Latchway/latchway-android.git'

native_repository=$(cd "$native_repository" && pwd)
core_aar="$native_repository/dev/latchway/latchway-core/1.0.0/latchway-core-1.0.0.aar"
okhttp_aar="$native_repository/dev/latchway/latchway-okhttp/1.0.0/latchway-okhttp-1.0.0.aar"
play_integrity_aar="$native_repository/dev/latchway/latchway-play-integrity/1.0.0/latchway-play-integrity-1.0.0.aar"
test -f "$core_aar"
test -f "$okhttp_aar"
test -f "$play_integrity_aar"

package_report="$evidence_dir/react-native-package-bridge.json"
pnpm exec vitest run test/client.test.ts test/security-boundary.test.ts \
  --reporter=json --outputFile="$package_report"
jq --exit-status '
  .success == true and .numFailedTests == 0 and
  .numPassedTests == .numTotalTests and .numTotalTests > 0
' "$package_report" >/dev/null

LATCHWAY_RN_PACKAGE_BRIDGE_VERIFIED=1
LATCHWAY_ANDROID_SOURCE_STATE=exact_clean_locked
LATCHWAY_ANDROID_CORE_AAR_SHA256=$(sha256sum "$core_aar" | awk '{print $1}')
LATCHWAY_ANDROID_OKHTTP_AAR_SHA256=$(sha256sum "$okhttp_aar" | awk '{print $1}')
LATCHWAY_ANDROID_PLAY_INTEGRITY_AAR_SHA256=$(sha256sum "$play_integrity_aar" | awk '{print $1}')
LATCHWAY_NATIVE_REPOSITORY=$native_repository
export LATCHWAY_RN_PACKAGE_BRIDGE_VERIFIED LATCHWAY_ANDROID_CORE_AAR_SHA256
export LATCHWAY_ANDROID_OKHTTP_AAR_SHA256 LATCHWAY_ANDROID_PLAY_INTEGRITY_AAR_SHA256
export LATCHWAY_NATIVE_REPOSITORY
export LATCHWAY_ANDROID_SOURCE_STATE

jq --null-input \
  --arg android_commit "$android_commit" \
  --arg core_aar_sha256 "$LATCHWAY_ANDROID_CORE_AAR_SHA256" \
  --arg okhttp_aar_sha256 "$LATCHWAY_ANDROID_OKHTTP_AAR_SHA256" \
  --arg play_integrity_aar_sha256 "$LATCHWAY_ANDROID_PLAY_INTEGRITY_AAR_SHA256" '
  {
    schema_version: 1,
    kind: "latchway_react_native_pr_native_artifact_identity",
    status: "prepared",
    source_commit: $android_commit,
    source_state: "exact_clean_locked",
    coordinate_origin: "exact_source_built_local_maven_publication",
    core_aar_sha256: $core_aar_sha256,
    okhttp_aar_sha256: $okhttp_aar_sha256,
    play_integrity_aar_sha256: $play_integrity_aar_sha256,
    physical_attestation_claimed: false
  }
' > "$evidence_dir/react-native-native-artifact-identity.json"

./android/gradlew -p android testDebugUnitTest \
  --tests '*NativeLatchwayModuleTest*' \
  --no-daemon --stacktrace

junit_source='Conformance/native-android-driver/build/test-results/testDebugUnitTest/TEST-dev.latchway.reactnative.conformance.ReactNativeNativeSdkLiveConformanceTest.xml'
split_report="$evidence_dir/react-native-split-boundary.json"
copy_junit() {
  if [ -f "$junit_source" ]; then
    cp "$junit_source" "$evidence_dir/react-native-native-sdk-live.junit.xml" || true
  fi
}
finalize() {
  exit_status=$?
  copy_junit
  if [ "$exit_status" -ne 0 ] && [ ! -f "$split_report" ]; then
    failure_evidence='job_log'
    if [ -f "$evidence_dir/react-native-native-sdk-live.junit.xml" ]; then
      failure_evidence='react-native-native-sdk-live.junit.xml'
    fi
    jq --null-input \
      --arg android_commit "$android_commit" \
      --arg core_aar_sha256 "$LATCHWAY_ANDROID_CORE_AAR_SHA256" \
      --arg okhttp_aar_sha256 "$LATCHWAY_ANDROID_OKHTTP_AAR_SHA256" \
      --arg play_integrity_aar_sha256 "$LATCHWAY_ANDROID_PLAY_INTEGRITY_AAR_SHA256" \
      --arg failure_evidence "$failure_evidence" '
      {
        schema_version: 1,
        kind: "latchway_react_native_pr_split_boundary",
        status: "failed",
        compatible: false,
        package_bridge_contract: true,
        native_android_sdk_live: false,
        native_ios_sdk_live: false,
        react_native_turbomodule_end_to_end: false,
        physical_play_integrity: false,
        physical_app_attest: false,
        failure_evidence: $failure_evidence,
        native_dependency: {
          source_commit: $android_commit,
          source_state: "exact_clean_locked",
          coordinate_origin: "exact_source_built_local_maven_publication",
          core_aar_sha256: $core_aar_sha256,
          okhttp_aar_sha256: $okhttp_aar_sha256,
          play_integrity_aar_sha256: $play_integrity_aar_sha256
        },
        remaining_ordinary_ci_boundary: "This job does not execute either React Native TurboModule host or the native iOS dependency; the iOS SDK repository owns native iOS live coverage",
        remaining_protected_gate: "Physical React Native Android/iOS hosts with Play Integrity/App Attest"
      }
    ' > "$split_report"
  fi
  return "$exit_status"
}
trap finalize 0

./android/gradlew -p Conformance/native-android-driver testDebugUnitTest \
  --tests 'dev.latchway.reactnative.conformance.ReactNativeNativeSdkLiveConformanceTest.exactLocallyPublishedAndroidSdkDrivesReactNativeDebugSession' \
  --no-daemon --stacktrace

test -f "$junit_source"
copy_junit
test -f "$evidence_dir/react-native-native-sdk-live.junit.xml"

jq --exit-status --arg android_commit "$android_commit" '
  .status == "passed" and
  .native_dependency.source_commit == $android_commit and
  .native_dependency.source_state == "exact_clean_locked" and
  .native_dependency.coordinate_origin == "exact_source_built_local_maven_publication" and
  .execution_boundary.package_bridge_contract == true and
  .execution_boundary.native_android_sdk_live == true and
  .execution_boundary.native_ios_sdk_live == false and
  .execution_boundary.react_native_turbomodule_end_to_end == false and
  .execution_boundary.physical_play_integrity == false and
  .execution_boundary.physical_app_attest == false and
  .observations.platform == "react_native_android" and
  .observations.logical_requests_delta == 1
' "$LATCHWAY_SDK_CONFORMANCE_OUTPUT" >/dev/null

jq --null-input \
  --arg android_commit "$android_commit" \
  --arg core_aar_sha256 "$LATCHWAY_ANDROID_CORE_AAR_SHA256" \
  --arg okhttp_aar_sha256 "$LATCHWAY_ANDROID_OKHTTP_AAR_SHA256" \
  --arg play_integrity_aar_sha256 "$LATCHWAY_ANDROID_PLAY_INTEGRITY_AAR_SHA256" '
  {
    schema_version: 1,
    kind: "latchway_react_native_pr_split_boundary",
    status: "passed",
    compatible: true,
    package_bridge_contract: true,
    native_android_sdk_live: true,
    native_ios_sdk_live: false,
    react_native_turbomodule_end_to_end: false,
    physical_play_integrity: false,
    physical_app_attest: false,
    native_dependency: {
      source_commit: $android_commit,
      source_state: "exact_clean_locked",
      coordinate_origin: "exact_source_built_local_maven_publication",
      core_aar_sha256: $core_aar_sha256,
      okhttp_aar_sha256: $okhttp_aar_sha256,
      play_integrity_aar_sha256: $play_integrity_aar_sha256
    },
    remaining_ordinary_ci_boundary: "This job does not execute either React Native TurboModule host or the native iOS dependency; the iOS SDK repository owns native iOS live coverage",
    remaining_protected_gate: "Physical React Native Android/iOS hosts with Play Integrity/App Attest"
  }
' > "$split_report"
