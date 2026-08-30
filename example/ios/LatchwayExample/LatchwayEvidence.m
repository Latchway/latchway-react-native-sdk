#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(LatchwayEvidence, NSObject)

RCT_EXTERN_METHOD(consumeIdentityGrant:(NSString *)applicationID
                  packageOrBundleIdentifier:(NSString *)packageOrBundleIdentifier
                  identityProvider:(NSString *)identityProvider
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(javascriptBundleSHA256:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(write:(NSString *)encoded
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(runID:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
