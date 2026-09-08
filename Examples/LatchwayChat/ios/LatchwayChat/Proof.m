// Debug-only automation entry and allowlisted receipt. It never handles SDK secrets.
#if DEBUG
#import <React/RCTBridgeModule.h>
@interface LatchwayChatProof : NSObject <RCTBridgeModule>
@end
@implementation LatchwayChatProof
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
- (NSDictionary *)constantsToExport {
  return @{@"enabled": @([NSProcessInfo.processInfo.arguments containsObject:@"--verify-latchway-chat"]),
    @"diagnoseEnabled": @([NSProcessInfo.processInfo.arguments containsObject:@"--diagnose-latchway-chat"])};
}
RCT_EXPORT_METHOD(record:(NSDictionary *)value) {
  [self writeReceipt:value filename:@"latchway-chat-proof.json"];
}
RCT_EXPORT_METHOD(recordDiagnostic:(NSDictionary *)value) {
  [self writeReceipt:value filename:@"latchway-chat-diagnostic.json"];
}
- (void)writeReceipt:(NSDictionary *)value filename:(NSString *)filename {
  NSSet *allowed = [NSSet setWithArray:@[@"status", @"stage", @"firebaseUID", @"signup",
    @"signin", @"firstTurn", @"followup", @"toolCalls", @"modelCalls", @"direct",
    @"installationID", @"trustLevel", @"keyStorage", @"platform", @"sdkVersion",
    @"nativeSDKVersion", @"quotaUsed", @"requestIDs", @"errorCode", @"errorSite", @"httpStatus", @"finishedAt",
    @"identityStatus", @"identityAuthCode", @"sourceCandidate", @"attestationSupport", @"attestationOperation"]];
  NSMutableDictionary *receipt = [NSMutableDictionary dictionary];
  for (NSString *key in value) {
    id field = value[key];
    if (![allowed containsObject:key]) continue;
    if ([field isKindOfClass:NSString.class] && [field length] <= 512) receipt[key] = field;
    if ([field isKindOfClass:NSNumber.class]) receipt[key] = field;
    if ([key isEqualToString:@"requestIDs"] && [field isKindOfClass:NSArray.class] && [field count] <= 16) {
      NSMutableArray *ids = [NSMutableArray array];
      for (id item in field) if ([item isKindOfClass:NSString.class] && [item length] <= 128) [ids addObject:item];
      receipt[key] = ids;
    }
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:receipt options:NSJSONWritingPrettyPrinted error:nil];
  NSURL *dir = [NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
  [data writeToURL:[dir URLByAppendingPathComponent:filename] options:NSDataWritingAtomic error:nil];
  NSLog(@"LatchwayChat proof status=%@ stage=%@", receipt[@"status"], receipt[@"stage"]);
}
@end
#endif
