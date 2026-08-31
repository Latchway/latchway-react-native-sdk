#if DEBUG

#import <CommonCrypto/CommonDigest.h>
#import <React/RCTBridgeModule.h>
#import <TargetConditionals.h>
#import <sys/sysctl.h>
#import <unistd.h>

static NSLock *LatchwayDevelopmentGrantLock;
static NSString *LatchwayDevelopmentCapturedGrant;
static NSString *LatchwayDevelopmentVerificationRunID;
static BOOL LatchwayDevelopmentGrantInvalid = YES;
static BOOL LatchwayDevelopmentGrantConsumed = NO;

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

static void LatchwayDevelopmentCaptureAndClearEnvironment(void) {
  const char *grantValue = getenv("LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT");
  const char *digestValue = getenv("LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256");
  const char *runIDValue = getenv("LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID");
  NSString *grant = grantValue == NULL ? nil : [NSString stringWithUTF8String:grantValue];
  NSString *expectedDigest = digestValue == NULL ? nil : [NSString stringWithUTF8String:digestValue];
  NSString *runID = runIDValue == NULL ? nil : [NSString stringWithUTF8String:runIDValue];
  unsetenv("LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT");
  unsetenv("LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256");
  unsetenv("LATCHWAY_DEVELOPMENT_VERIFICATION_RUN_ID");
  [NSFileManager.defaultManager removeItemAtURL:LatchwayDevelopmentVerificationMarkerURL() error:nil];

  [LatchwayDevelopmentGrantLock lock];
  @try {
    LatchwayDevelopmentCapturedGrant = nil;
    LatchwayDevelopmentVerificationRunID = nil;
    LatchwayDevelopmentGrantInvalid = YES;
    LatchwayDevelopmentGrantConsumed = NO;
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
  } @finally {
    [LatchwayDevelopmentGrantLock unlock];
  }
}

static NSString *LatchwayDevelopmentCompletedRunID(void) {
  [LatchwayDevelopmentGrantLock lock];
  @try {
    if (!LatchwayDevelopmentGrantConsumed || !LatchwayDevelopmentGrantInvalid ||
        LatchwayDevelopmentCapturedGrant != nil || LatchwayDevelopmentVerificationRunID == nil) {
      return nil;
    }
    return [LatchwayDevelopmentVerificationRunID copy];
  } @finally {
    [LatchwayDevelopmentGrantLock unlock];
  }
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
    @"schema_version": @1,
    @"run_id": runID,
    @"status": @"passed",
    @"checks": @[
      @"firebase_custom_token",
      @"gateway_responses",
      @"diagnostics_app_attest_app_verified_react_native_ios",
      @"quota",
      @"installation_revoked",
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
    @"installation_revoke",
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
    @"schema_version": @1,
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
