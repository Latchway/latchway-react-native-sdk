#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
android_source=${1:-"$repository_root/_android"}
expected_commit=$(jq --raw-output '.android.source_commit' "$repository_root/release-compatibility.json")

test "$(git -C "$android_source" rev-parse --verify HEAD)" = "$expected_commit"
test -z "$(git -C "$android_source" status --porcelain=v1 --untracked-files=all)"

# FW-AUTH-101: exact native session bootstrap.
# FW-AUTH-102: exact native DPoP construction and binding.
# FW-AUTH-104: exact identity reauthentication and replacement session.
# FW-AUTH-105: exact installation-family retirement and terminal state.
# FW-AUTH-106: exact independently keyed component revocation.
(
  cd "$android_source"
  ./gradlew :latchway-core:testDebugUnitTest \
    --tests '*SessionCoordinatorTest.initialSessionExchangeIsSingleFlightAcrossConcurrentCallers' \
    --tests '*DpopContractTest.generatedProtectedProofUsesCanonicalHtuAthAndNonce' \
    --tests '*SessionCoordinatorTest.fwAuth104RefreshRejectionReauthenticatesExternalIdentityBeforeAReplacementSession' \
    --tests '*SessionCoordinatorTest.fwAuth105InstallationFamilyRevocationRetiresStateKeyAndClientLocally' \
    --tests '*SessionCoordinatorTest.delegatedComponentProvisioningUsesIndependentKeySessionAndRevocation' \
    --no-daemon --stacktrace
)

# FW-AUTH-103: exact React Native transport expiry refresh before replay.
# FW-BEH-104: exact framework retry with a fresh native DPoP proof.
# FW-SEC-103: exact native origin guard before cross-origin redirect dispatch.
(
  cd "$android_source"
  ./gradlew :latchway-okhttp:testDebugUnitTest \
    --tests '*RetrofitFrameworkConformanceTest.reactNativeTransportAutomaticallyRefreshesExpiredSessionBeforeReplay' \
    --tests '*KoogFrameworkConformanceTest.koogNativeRetryCreatesANewDpopProofForEveryFrameworkAttempt' \
    --tests '*OkHttpLatchwayTransportTest.originGuardBlocksLatchwayHeadersBeforeACrossOriginRedirectIsDispatched' \
    --no-daemon --stacktrace
)
