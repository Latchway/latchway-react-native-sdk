#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
ios_source=${1:-"$repository_root/_ios"}
expected_commit=$(jq --raw-output '.ios.source_commit' "$repository_root/release-compatibility.json")

test "$(git -C "$ios_source" rev-parse --verify HEAD)" = "$expected_commit"
test -z "$(git -C "$ios_source" status --porcelain=v1 --untracked-files=all)"

run_case() {
  case_id=$1
  filter=$2
  printf 'Running %s with %s\n' "$case_id" "$filter"
  swift test --package-path "$ios_source" --filter "$filter"
}

run_case FW-AUTH-101 ClientSessionTests/testConcurrentAuthorizationEstablishesOneSession
run_case FW-AUTH-102 DPoPTests/testGeneratedProofCarriesOnlyPublicJWKAndRequiredClaims
run_case FW-AUTH-103 ClientSessionTests/testReactNativeTransportAutomaticallyRefreshesExpiredSessionBeforeReplay
run_case FW-AUTH-104 ClientSessionTests/testRefreshIdentityReauthenticationStartsFreshAttestedExchange
run_case FW-AUTH-105 ClientSessionTests/testNoArgumentFamilyRevocationCleansRegisteredComponentsAndRetainsFailures
run_case FW-AUTH-106 ClientSessionTests/testFWAUTH106ExplicitComponentRevocationLeavesRootAndSiblingStateActive
run_case FW-BEH-104 ClientSessionTests/testBufferedSendRetriesDPoPNonceOnceWithoutRefreshing
run_case FW-BEH-104 ClientSessionTests/testFeatureTransportStreamingRetriesSessionExpiryOnceWithoutBufferingSuccess
run_case FW-BEH-104 ClientSessionTests/testFeatureTransportStreamingRetriesDPoPNonceOnceWithoutRefresh
run_case FW-SEC-103 URLSessionTransportTests/testFWSEC103RedirectDestinationIsRejectedBeforeCredentialRedispatch
