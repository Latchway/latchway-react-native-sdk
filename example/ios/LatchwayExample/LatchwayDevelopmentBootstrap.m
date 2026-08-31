#if DEBUG

#import <CommonCrypto/CommonDigest.h>
#import <React/RCTBridgeModule.h>
#import <Security/Security.h>
#import <TargetConditionals.h>
#import <dispatch/dispatch.h>
#import <float.h>
#import <string.h>
#import <sys/sysctl.h>
#import <unistd.h>

static NSLock *LatchwayDevelopmentGrantLock;
static NSString *LatchwayDevelopmentCapturedGrant;
static NSString *LatchwayDevelopmentVerificationRunID;
static BOOL LatchwayDevelopmentGrantInvalid = YES;
static BOOL LatchwayDevelopmentGrantConsumed = NO;
static BOOL LatchwayDevelopmentResume = NO;
static BOOL LatchwayDevelopmentAbort = NO;
static NSString *LatchwayDevelopmentAbortMarkerStage;
static BOOL LatchwayDevelopmentReceiptConsumed = NO;

static NSString *const LatchwayDevelopmentAppIntentService = @"dev.latchway.debug.app-intent-proof";
static NSString *const LatchwayDevelopmentChallengeAccount = @"challenge-v1";
static NSString *const LatchwayDevelopmentReceiptAccount = @"receipt-v1";

static BOOL LatchwayDevelopmentDebuggerAttached(void);
static BOOL LatchwayDevelopmentTesting(void);

static BOOL LatchwayDevelopmentMatches(NSString *value, NSString *pattern) {
  if (value == nil) return NO;
  NSRange range = NSMakeRange(0, value.length);
  NSRegularExpression *expression = [NSRegularExpression regularExpressionWithPattern:pattern
                                                                                options:0
                                                                                  error:nil];
  NSTextCheckingResult *match = [expression firstMatchInString:value options:0 range:range];
  return match != nil && NSEqualRanges(match.range, range);
}

static NSString *LatchwayDevelopmentSHA256(NSData *data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *result = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    [result appendFormat:@"%02x", digest[index]];
  }
  return result;
}

static BOOL LatchwayDevelopmentConstantTimeEqual(NSString *left, NSString *right) {
  NSData *leftData = [left dataUsingEncoding:NSUTF8StringEncoding];
  NSData *rightData = [right dataUsingEncoding:NSUTF8StringEncoding];
  if (leftData.length != 64 || rightData.length != 64) return NO;
  const unsigned char *leftBytes = leftData.bytes;
  const unsigned char *rightBytes = rightData.bytes;
  unsigned char difference = 0;
  for (NSUInteger index = 0; index < 64; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference == 0;
}

static NSURL *LatchwayDevelopmentVerificationMarkerURL(void) {
  NSURL *directory = [NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory
                                                           inDomains:NSUserDomainMask].firstObject;
  return [directory URLByAppendingPathComponent:@"latchway-development-verification.json" isDirectory:NO];
}

static BOOL LatchwayDevelopmentWriteMarker(NSDictionary *marker) {
  NSError *error = nil;
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:marker options:NSJSONWritingSortedKeys error:&error];
  NSURL *destination = LatchwayDevelopmentVerificationMarkerURL();
  BOOL written = encoded != nil && encoded.length <= 4096 &&
    [encoded writeToURL:destination options:NSDataWritingAtomic error:&error];
  if (written) {
    written = [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions: @0600}
                                             ofItemAtPath:destination.path error:&error];
  }
  return written;
}

static NSDictionary *LatchwayDevelopmentReadMarker(void) {
  NSData *data = [NSData dataWithContentsOfURL:LatchwayDevelopmentVerificationMarkerURL()];
  if (data == nil || data.length == 0 || data.length > 4096) return nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}

static BOOL LatchwayDevelopmentIsWaitingMarker(NSString *runID) {
  NSDictionary *marker = LatchwayDevelopmentReadMarker();
  if (marker.count != 3) return NO;
  return [marker[@"schema_version"] isEqual:@2] &&
    [marker[@"run_id"] isEqual:runID] && [marker[@"status"] isEqual:@"waiting_for_app_intent"];
}

static NSString *LatchwayDevelopmentAbortStageForMarker(NSString *runID) {
  NSDictionary *marker = LatchwayDevelopmentReadMarker();
  if (![marker[@"schema_version"] isEqual:@2] || ![marker[@"run_id"] isEqual:runID]) return nil;
  if (marker.count == 3 && [marker[@"status"] isEqual:@"waiting_for_app_intent"]) return @"waiting";
  NSSet<NSString *> *abortableStages = [NSSet setWithArray:@[
    @"app_intent_receipt", @"family_revoke", @"firebase_sign_out",
  ]];
  NSString *stage = [marker[@"failure_stage"] isKindOfClass:NSString.class]
    ? marker[@"failure_stage"] : nil;
  if (marker.count == 5 && [marker[@"status"] isEqual:@"failed"] &&
      [abortableStages containsObject:stage] &&
      LatchwayDevelopmentMatches(marker[@"failure_code"], @"^[a-z][a-z0-9_]{1,99}$")) {
    return stage;
  }
  return nil;
}

static void LatchwayDevelopmentCaptureAndClearEnvironment(void) {
  const char *grantValue = getenv("LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT");
  const char *digestValue = getenv("LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256");
  const char *runIDValue = getenv("LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID");
  const char *resumeValue = getenv("LATCHWAY_DEVELOPMENT_VERIFICATION_RESUME");
  const char *abortValue = getenv("LATCHWAY_DEVELOPMENT_VERIFICATION_ABORT");
  NSString *grant = grantValue == NULL ? nil : [NSString stringWithUTF8String:grantValue];
  NSString *expectedDigest = digestValue == NULL ? nil : [NSString stringWithUTF8String:digestValue];
  NSString *runID = runIDValue == NULL ? nil : [NSString stringWithUTF8String:runIDValue];
  unsetenv("LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT");
  unsetenv("LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256");
  unsetenv("LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID");
  unsetenv("LATCHWAY_DEVELOPMENT_VERIFICATION_RESUME");
  unsetenv("LATCHWAY_DEVELOPMENT_VERIFICATION_ABORT");

  [LatchwayDevelopmentGrantLock lock];
  @try {
    LatchwayDevelopmentCapturedGrant = nil;
    LatchwayDevelopmentVerificationRunID = nil;
    LatchwayDevelopmentGrantInvalid = YES;
    LatchwayDevelopmentGrantConsumed = NO;
    LatchwayDevelopmentResume = NO;
    LatchwayDevelopmentAbort = NO;
    LatchwayDevelopmentAbortMarkerStage = nil;
    LatchwayDevelopmentReceiptConsumed = NO;
    if (resumeValue != NULL || abortValue != NULL) {
      if ((resumeValue != NULL && abortValue != NULL) || grantValue != NULL || digestValue != NULL ||
          !LatchwayDevelopmentMatches(runID, @"^dev_[0-9a-f]{32}$")) return;
      if (resumeValue != NULL &&
          (strcmp(resumeValue, "1") != 0 || !LatchwayDevelopmentIsWaitingMarker(runID))) return;
      NSString *abortStage = abortValue == NULL ? nil : LatchwayDevelopmentAbortStageForMarker(runID);
      if (abortValue != NULL && (strcmp(abortValue, "1") != 0 || abortStage == nil)) return;
      LatchwayDevelopmentVerificationRunID = [runID copy];
      LatchwayDevelopmentGrantConsumed = YES;
      LatchwayDevelopmentResume = resumeValue != NULL;
      LatchwayDevelopmentAbort = abortValue != NULL;
      LatchwayDevelopmentAbortMarkerStage = [abortStage copy];
      return;
    }
    [NSFileManager.defaultManager removeItemAtURL:LatchwayDevelopmentVerificationMarkerURL() error:nil];
    if ((grantValue == NULL) != (digestValue == NULL) || grant == nil || expectedDigest == nil || runID == nil) return;
    NSData *grantData = [grant dataUsingEncoding:NSUTF8StringEncoding];
    if (grantData == nil || grantData.length < 32 || grantData.length > 65536) return;
    if (!LatchwayDevelopmentMatches(grant, @"^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$") ||
        !LatchwayDevelopmentMatches(expectedDigest, @"^[0-9a-f]{64}$") ||
        !LatchwayDevelopmentMatches(runID, @"^dev_[0-9a-f]{32}$")) return;
    NSString *actualDigest = LatchwayDevelopmentSHA256(grantData);
    if (!LatchwayDevelopmentConstantTimeEqual(actualDigest, expectedDigest)) return;
    LatchwayDevelopmentCapturedGrant = [grant copy];
    LatchwayDevelopmentVerificationRunID = [runID copy];
    LatchwayDevelopmentGrantInvalid = NO;
    // If JavaScript cannot acquire the Debug bridge or construct its public
    // component descriptor, the one-use launch grant must not remain resident
    // in the containing process indefinitely. The expiry block captures only
    // the public random run ID, never the grant itself.
    NSString *expiringRunID = [runID copy];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(180 * NSEC_PER_SEC)),
                   dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      [LatchwayDevelopmentGrantLock lock];
      @try {
        if (!LatchwayDevelopmentGrantConsumed &&
            [LatchwayDevelopmentVerificationRunID isEqualToString:expiringRunID]) {
          LatchwayDevelopmentCapturedGrant = nil;
          LatchwayDevelopmentGrantInvalid = YES;
          LatchwayDevelopmentGrantConsumed = YES;
        }
      } @finally {
        [LatchwayDevelopmentGrantLock unlock];
      }
    });
  } @finally {
    [LatchwayDevelopmentGrantLock unlock];
  }
}

static NSString *LatchwayDevelopmentCompletedRunID(void) {
  [LatchwayDevelopmentGrantLock lock];
  @try {
    if (!LatchwayDevelopmentResume || !LatchwayDevelopmentReceiptConsumed ||
        !LatchwayDevelopmentGrantConsumed || !LatchwayDevelopmentGrantInvalid ||
        LatchwayDevelopmentCapturedGrant != nil || LatchwayDevelopmentVerificationRunID == nil) {
      return nil;
    }
    return [LatchwayDevelopmentVerificationRunID copy];
  } @finally {
    [LatchwayDevelopmentGrantLock unlock];
  }
}

static NSString *LatchwayDevelopmentAbortRunID(void) {
  [LatchwayDevelopmentGrantLock lock];
  @try {
    if (!LatchwayDevelopmentAbort || !LatchwayDevelopmentGrantConsumed ||
        !LatchwayDevelopmentGrantInvalid || LatchwayDevelopmentCapturedGrant != nil ||
        LatchwayDevelopmentVerificationRunID == nil) return nil;
    return [LatchwayDevelopmentVerificationRunID copy];
  } @finally {
    [LatchwayDevelopmentGrantLock unlock];
  }
}

static BOOL LatchwayDevelopmentRuntimeValid(void) {
#if TARGET_OS_IOS && !TARGET_OS_SIMULATOR && !TARGET_OS_MACCATALYST
  BOOL validPlatform = YES;
#else
  BOOL validPlatform = NO;
#endif
  return validPlatform && !LatchwayDevelopmentTesting() && !LatchwayDevelopmentDebuggerAttached() &&
    [NSBundle.mainBundle.bundleIdentifier isEqualToString:@"dev.latchway"];
}

static NSDictionary *LatchwayDevelopmentAppIntentCoordinates(
  NSString *accessGroup,
  NSString *account
) {
  return @{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: LatchwayDevelopmentAppIntentService,
    (__bridge id)kSecAttrAccount: account,
    (__bridge id)kSecAttrAccessGroup: accessGroup,
  };
}

static NSData *LatchwayDevelopmentReadAppIntentItem(NSString *accessGroup, NSString *account) {
  NSMutableDictionary *query = [LatchwayDevelopmentAppIntentCoordinates(accessGroup, account) mutableCopy];
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  return status == errSecSuccess && result != NULL ? CFBridgingRelease(result) : nil;
}

static BOOL LatchwayDevelopmentDeleteAppIntentArtifacts(NSString *accessGroup) {
  BOOL deleted = YES;
  for (NSString *account in @[LatchwayDevelopmentChallengeAccount, LatchwayDevelopmentReceiptAccount]) {
    OSStatus status = SecItemDelete((__bridge CFDictionaryRef)
      LatchwayDevelopmentAppIntentCoordinates(accessGroup, account));
    if (status != errSecSuccess && status != errSecItemNotFound) deleted = NO;
  }
  return deleted;
}

static BOOL LatchwayDevelopmentWriteAppIntentChallenge(NSString *accessGroup, NSString *runID) {
  if (!LatchwayDevelopmentMatches(runID, @"^dev_[0-9a-f]{32}$")) return NO;
  NSData *data = [runID dataUsingEncoding:NSUTF8StringEncoding];
  if (data.length != 36) return NO;
  NSDictionary *coordinates = LatchwayDevelopmentAppIntentCoordinates(
    accessGroup,
    LatchwayDevelopmentChallengeAccount
  );
  OSStatus removal = SecItemDelete((__bridge CFDictionaryRef)coordinates);
  if (removal != errSecSuccess && removal != errSecItemNotFound) return NO;
  NSMutableDictionary *item = [coordinates mutableCopy];
  item[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
  item[(__bridge id)kSecValueData] = data;
  return SecItemAdd((__bridge CFDictionaryRef)item, NULL) == errSecSuccess;
}

static NSString *LatchwayDevelopmentTerminalFailureRunID(void) {
  [LatchwayDevelopmentGrantLock lock];
  @try {
    if (LatchwayDevelopmentVerificationRunID == nil) return nil;
    if (!LatchwayDevelopmentGrantConsumed) {
      // A configuration failure can occur before JavaScript takes the grant.
      // Terminally destroy that validated slot before allowing an exact-run
      // failure receipt; it can never be recovered or consumed afterward.
      LatchwayDevelopmentCapturedGrant = nil;
      LatchwayDevelopmentGrantInvalid = YES;
      LatchwayDevelopmentGrantConsumed = YES;
    }
    if (!LatchwayDevelopmentGrantInvalid || LatchwayDevelopmentCapturedGrant != nil) return nil;
    return [LatchwayDevelopmentVerificationRunID copy];
  } @finally {
    [LatchwayDevelopmentGrantLock unlock];
  }
}

static NSString *LatchwayDevelopmentTakeGrant(void) {
  [LatchwayDevelopmentGrantLock lock];
  @try {
    if (LatchwayDevelopmentGrantInvalid || LatchwayDevelopmentGrantConsumed) return nil;
    NSString *grant = LatchwayDevelopmentCapturedGrant;
    LatchwayDevelopmentCapturedGrant = nil;
    LatchwayDevelopmentGrantInvalid = YES;
    LatchwayDevelopmentGrantConsumed = grant != nil;
    return grant;
  } @finally {
    [LatchwayDevelopmentGrantLock unlock];
  }
}

static BOOL LatchwayDevelopmentDebuggerAttached(void) {
  int managementInformationBase[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid() };
  struct kinfo_proc processInformation;
  size_t processInformationSize = sizeof(processInformation);
  memset(&processInformation, 0, processInformationSize);
  if (sysctl(managementInformationBase, 4, &processInformation, &processInformationSize, NULL, 0) != 0) {
    return YES;
  }
  return (processInformation.kp_proc.p_flag & P_TRACED) != 0;
}

static BOOL LatchwayDevelopmentTesting(void) {
  NSDictionary<NSString *, NSString *> *environment = NSProcessInfo.processInfo.environment;
  return environment[@"XCTestConfigurationFilePath"] != nil ||
    environment[@"XCTestBundlePath"] != nil || NSClassFromString(@"XCTestCase") != nil;
}

@interface LatchwayDevelopmentBootstrap : NSObject <RCTBridgeModule>
@end

@implementation LatchwayDevelopmentBootstrap

RCT_EXPORT_MODULE_NO_LOAD(LatchwayDevelopmentBootstrap, LatchwayDevelopmentBootstrap)

+ (void)load {
  LatchwayDevelopmentGrantLock = [[NSLock alloc] init];
  LatchwayDevelopmentCaptureAndClearEnvironment();
}

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

RCT_REMAP_METHOD(developmentVerificationPhase,
                 developmentVerificationPhaseWithResolve:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  if (!LatchwayDevelopmentRuntimeValid()) {
    reject(@"development_verification_invalid", @"The Debug-only verification phase is unavailable.", nil);
    return;
  }
  [LatchwayDevelopmentGrantLock lock];
  @try {
    BOOL validRun = LatchwayDevelopmentVerificationRunID != nil && LatchwayDevelopmentGrantInvalid;
    if (LatchwayDevelopmentResume && validRun && LatchwayDevelopmentGrantConsumed &&
        LatchwayDevelopmentCapturedGrant == nil) {
      resolve(@"resume");
      return;
    }
    if (LatchwayDevelopmentAbort && validRun && LatchwayDevelopmentGrantConsumed &&
        LatchwayDevelopmentCapturedGrant == nil) {
      resolve([LatchwayDevelopmentAbortMarkerStage isEqual:@"firebase_sign_out"]
        ? @"abort_sign_out" : @"abort");
      return;
    }
    if (!LatchwayDevelopmentResume && !LatchwayDevelopmentGrantInvalid &&
        !LatchwayDevelopmentGrantConsumed && LatchwayDevelopmentCapturedGrant != nil) {
      resolve(@"initial");
      return;
    }
  } @finally {
    [LatchwayDevelopmentGrantLock unlock];
  }
  reject(@"development_verification_invalid", @"The Debug-only verification phase is unavailable.", nil);
}

RCT_REMAP_METHOD(clearDevelopmentAppIntentArtifacts,
                 clearDevelopmentAppIntentArtifacts:(NSString *)accessGroup
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject) {
  if (!LatchwayDevelopmentRuntimeValid() || LatchwayDevelopmentResume ||
      !LatchwayDevelopmentMatches(accessGroup, @"^[A-Z0-9]{10}\\.dev\\.latchway\\.keychain$")) {
    reject(@"development_verification_invalid", @"The Debug App Intent artifact boundary is invalid.", nil);
    return;
  }
  if (!LatchwayDevelopmentDeleteAppIntentArtifacts(accessGroup)) {
    reject(@"development_verification_invalid", @"The Debug App Intent artifacts were not cleared.", nil);
    return;
  }
  resolve(nil);
}

RCT_REMAP_METHOD(markDevelopmentAppIntentWaiting,
                 markDevelopmentAppIntentWaiting:(NSString *)accessGroup
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject) {
  if (!LatchwayDevelopmentRuntimeValid() || LatchwayDevelopmentResume || LatchwayDevelopmentAbort ||
      !LatchwayDevelopmentMatches(accessGroup, @"^[A-Z0-9]{10}\\.dev\\.latchway\\.keychain$")) {
    reject(@"development_verification_invalid", @"The Debug App Intent waiting marker is unavailable.", nil);
    return;
  }
  [LatchwayDevelopmentGrantLock lock];
  NSString *runID = nil;
  @try {
    if (LatchwayDevelopmentGrantConsumed && LatchwayDevelopmentGrantInvalid &&
        LatchwayDevelopmentCapturedGrant == nil) {
      runID = [LatchwayDevelopmentVerificationRunID copy];
    }
  } @finally {
    [LatchwayDevelopmentGrantLock unlock];
  }
  NSDictionary *marker = @{
    @"schema_version": @2,
    @"run_id": runID ?: @"",
    @"status": @"waiting_for_app_intent",
  };
  if (runID == nil || !LatchwayDevelopmentDeleteAppIntentArtifacts(accessGroup) ||
      !LatchwayDevelopmentWriteAppIntentChallenge(accessGroup, runID)) {
    LatchwayDevelopmentDeleteAppIntentArtifacts(accessGroup);
    reject(@"development_verification_invalid", @"The exact-run Debug App Intent challenge was not written.", nil);
    return;
  }
  // The shared challenge is written only after JavaScript has prepared the
  // current family and immediately before the atomic waiting marker.
  if (!LatchwayDevelopmentWriteMarker(marker)) {
    LatchwayDevelopmentDeleteAppIntentArtifacts(accessGroup);
    reject(@"development_verification_invalid", @"The Debug App Intent waiting marker was not written.", nil);
    return;
  }
  resolve(nil);
}

RCT_REMAP_METHOD(consumeDevelopmentAppIntentReceipt,
                 consumeDevelopmentAppIntentReceipt:(NSString *)accessGroup
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject) {
  if (!LatchwayDevelopmentRuntimeValid() || !LatchwayDevelopmentResume ||
      !LatchwayDevelopmentMatches(accessGroup, @"^[A-Z0-9]{10}\\.dev\\.latchway\\.keychain$") ||
      !LatchwayDevelopmentIsWaitingMarker(LatchwayDevelopmentVerificationRunID)) {
    reject(@"development_verification_invalid", @"The Debug App Intent receipt boundary is invalid.", nil);
    return;
  }
  NSData *data = LatchwayDevelopmentReadAppIntentItem(accessGroup, LatchwayDevelopmentReceiptAccount);
  NSData *challengeData = LatchwayDevelopmentReadAppIntentItem(
    accessGroup,
    LatchwayDevelopmentChallengeAccount
  );
  NSString *challenge = challengeData.length == 36
    ? [[NSString alloc] initWithData:challengeData encoding:NSUTF8StringEncoding] : nil;
  NSString *expectedRunID = [LatchwayDevelopmentVerificationRunID copy];
  id decoded = data.length > 0 && data.length <= 512
    ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  NSDictionary *receipt = [decoded isKindOfClass:NSDictionary.class] ? decoded : nil;
  NSSet *receiptKeys = receipt == nil ? nil : [NSSet setWithArray:receipt.allKeys];
  NSSet *expectedKeys = [NSSet setWithArray:@[
    @"schema_version", @"run_id", @"status", @"delegated_session", @"delegated_request",
    @"completed_at",
  ]];
  NSString *completedAt = [receipt[@"completed_at"] isKindOfClass:NSString.class]
    ? receipt[@"completed_at"] : nil;
  NSDate *completed = completedAt == nil ? nil : [[NSISO8601DateFormatter new] dateFromString:completedAt];
  NSTimeInterval age = completed == nil ? DBL_MAX : -[completed timeIntervalSinceNow];
  BOOL valid = data.length > 0 && data.length <= 512 &&
    LatchwayDevelopmentMatches(expectedRunID, @"^dev_[0-9a-f]{32}$") &&
    [challenge isEqualToString:expectedRunID] &&
    receipt != nil && [receiptKeys isEqual:expectedKeys] &&
    [receipt[@"schema_version"] isEqual:@1] && [receipt[@"status"] isEqual:@"passed"] &&
    [receipt[@"run_id"] isEqual:expectedRunID] &&
    [receipt[@"delegated_session"] isEqual:@YES] && [receipt[@"delegated_request"] isEqual:@YES] &&
    completed != nil && age >= -60 && age <= 600;
  BOOL removed = LatchwayDevelopmentDeleteAppIntentArtifacts(accessGroup);
  if (!valid || !removed) {
    reject(@"development_verification_invalid", @"The bounded Debug App Intent receipt is invalid.", nil);
    return;
  }
  [LatchwayDevelopmentGrantLock lock];
  LatchwayDevelopmentReceiptConsumed = YES;
  [LatchwayDevelopmentGrantLock unlock];
  resolve(nil);
}

RCT_REMAP_METHOD(consumeDevelopmentIdentityGrant,
                 consumeDevelopmentIdentityGrant:(NSString *)applicationID
                 packageOrBundleIdentifier:(NSString *)packageOrBundleIdentifier
                 identityProvider:(NSString *)identityProvider
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject) {
#if TARGET_OS_IOS && !TARGET_OS_SIMULATOR && !TARGET_OS_MACCATALYST
  BOOL validPlatform = YES;
#else
  BOOL validPlatform = NO;
#endif
  NSString *bundleIdentifier = NSBundle.mainBundle.bundleIdentifier;
  BOOL valid = validPlatform && !LatchwayDevelopmentTesting() && !LatchwayDevelopmentDebuggerAttached() &&
    LatchwayDevelopmentMatches(applicationID, @"^app_[0-7][0-9A-HJKMNP-TV-Z]{25}$") &&
    bundleIdentifier != nil && [packageOrBundleIdentifier isEqualToString:bundleIdentifier] &&
    [bundleIdentifier isEqualToString:@"dev.latchway"] &&
    [identityProvider isEqualToString:@"firebase"];
  if (!valid) {
    reject(@"development_identity_grant_invalid",
           @"The Debug-only one-use Firebase identity grant is unavailable.", nil);
    return;
  }
  NSString *grant = LatchwayDevelopmentTakeGrant();
  if (grant == nil) {
    reject(@"development_identity_grant_invalid",
           @"The Debug-only one-use Firebase identity grant is unavailable.", nil);
    return;
  }
  resolve(grant);
}

RCT_REMAP_METHOD(completeDevelopmentVerification,
                 completeDevelopmentVerificationWithResolve:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
#if TARGET_OS_IOS && !TARGET_OS_SIMULATOR && !TARGET_OS_MACCATALYST
  BOOL validPlatform = YES;
#else
  BOOL validPlatform = NO;
#endif
  NSString *runID = LatchwayDevelopmentCompletedRunID();
  if (!validPlatform || LatchwayDevelopmentTesting() || LatchwayDevelopmentDebuggerAttached() ||
      ![NSBundle.mainBundle.bundleIdentifier isEqualToString:@"dev.latchway"] || runID == nil) {
    reject(@"development_verification_invalid",
           @"The Debug-only physical-device verification did not complete.", nil);
    return;
  }
  NSDictionary *marker = @{
    @"schema_version": @2,
    @"run_id": runID,
    @"status": @"passed",
    @"checks": @[
      @"firebase_custom_token",
      @"gateway_responses",
      @"diagnostics_app_attest_app_verified_react_native_ios",
      @"quota",
      @"component_prepared",
      @"app_intent_delegated_session",
      @"app_intent_delegated_request",
      @"installation_family_revoked",
      @"firebase_signed_out",
    ],
  };
  if (!LatchwayDevelopmentWriteMarker(marker)) {
    reject(@"development_verification_invalid",
           @"The Debug-only physical-device verification marker was not written.", nil);
    return;
  }
  resolve(nil);
}

RCT_REMAP_METHOD(completeDevelopmentAbort,
                 completeDevelopmentAbortWithResolve:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *runID = LatchwayDevelopmentAbortRunID();
  if (!LatchwayDevelopmentRuntimeValid() || runID == nil) {
    reject(@"development_verification_invalid", @"The Debug-only abort cleanup did not complete.", nil);
    return;
  }
  NSDictionary *marker = @{
    @"schema_version": @2,
    @"run_id": runID,
    @"status": @"aborted",
    @"reason": @"delegated_verification_incomplete",
    @"checks": @[@"installation_family_revoked", @"firebase_signed_out"],
  };
  if (!LatchwayDevelopmentWriteMarker(marker)) {
    reject(@"development_verification_invalid", @"The Debug-only abort marker was not written.", nil);
    return;
  }
  resolve(nil);
}

RCT_REMAP_METHOD(failDevelopmentVerification,
                 failDevelopmentVerificationAtStage:(NSString *)stage
                 code:(NSString *)code
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject) {
#if TARGET_OS_IOS && !TARGET_OS_SIMULATOR && !TARGET_OS_MACCATALYST
  BOOL validPlatform = YES;
#else
  BOOL validPlatform = NO;
#endif
  NSSet<NSString *> *allowedStages = [NSSet setWithArray:@[
    @"firebase_configuration",
    @"firebase_custom_token",
    @"native_session_establishment",
    @"gateway_responses",
    @"diagnostics",
    @"quota",
    @"component_prepare",
    @"app_intent_wait",
    @"app_intent_receipt",
    @"family_revoke",
    @"firebase_sign_out",
    @"success_marker",
  ]];
  NSString *runID = LatchwayDevelopmentTerminalFailureRunID();
  BOOL valid = validPlatform && !LatchwayDevelopmentTesting() && !LatchwayDevelopmentDebuggerAttached() &&
    [NSBundle.mainBundle.bundleIdentifier isEqualToString:@"dev.latchway"] && runID != nil &&
    [allowedStages containsObject:stage] &&
    LatchwayDevelopmentMatches(code, @"^[a-z][a-z0-9_]{1,99}$");
  if (!valid) {
    reject(@"development_verification_invalid",
           @"The Debug-only physical-device failure receipt is unavailable.", nil);
    return;
  }
  NSDictionary *marker = @{
    @"schema_version": @2,
    @"run_id": runID,
    @"status": @"failed",
    @"failure_stage": stage,
    @"failure_code": code,
  };
  if (!LatchwayDevelopmentWriteMarker(marker)) {
    reject(@"development_verification_invalid",
           @"The Debug-only physical-device failure receipt was not written.", nil);
    return;
  }
  resolve(nil);
}

@end


#endif
