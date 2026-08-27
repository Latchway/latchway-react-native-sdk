#import "RCTNativeLatchway.h"
#import "LatchwayReactNative-Swift.h"

@implementation RCTNativeLatchway {
  LatchwayNativeBridge *_bridge;
}

RCT_EXPORT_MODULE(NativeLatchway)

- (instancetype)init {
  if ((self = [super init])) {
    _bridge = [LatchwayNativeBridge new];
  }
  return self;
}

- (void)configure:(NSString *)clientID
 configurationJSON:(NSString *)configurationJSON
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  [_bridge configureWithClientID:clientID configurationJSON:configurationJSON resolve:resolve reject:reject];
}

- (void)authorize:(NSString *)clientID
       operationID:(NSString *)operationID
      identityToken:(NSString *)identityToken
        requestJSON:(NSString *)requestJSON
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject {
  [_bridge authorizeWithClientID:clientID operationID:operationID identityToken:identityToken requestJSON:requestJSON resolve:resolve reject:reject];
}

- (void)refresh:(NSString *)clientID
     operationID:(NSString *)operationID
    identityToken:(NSString *)identityToken
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  [_bridge refreshWithClientID:clientID operationID:operationID identityToken:identityToken resolve:^{ resolve(nil); } reject:reject];
}

- (void)quota:(NSString *)clientID
   operationID:(NSString *)operationID
  identityToken:(NSString *)identityToken
        feature:(NSString *)feature
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject {
  [_bridge quotaWithClientID:clientID operationID:operationID identityToken:identityToken feature:feature resolve:resolve reject:reject];
}

- (void)diagnostics:(NSString *)clientID
         operationID:(NSString *)operationID
        identityToken:(NSString *)identityToken
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  [_bridge diagnosticsWithClientID:clientID operationID:operationID identityToken:identityToken resolve:resolve reject:reject];
}

- (void)revoke:(NSString *)clientID
    operationID:(NSString *)operationID
   identityToken:(NSString *)identityToken
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject {
  [_bridge revokeWithClientID:clientID operationID:operationID identityToken:identityToken resolve:^{ resolve(nil); } reject:reject];
}

- (void)cancel:(NSString *)clientID operationID:(NSString *)operationID {
  [_bridge cancelWithClientID:clientID operationID:operationID];
}

- (void)dispose:(NSString *)clientID
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject {
  [_bridge disposeWithClientID:clientID resolve:^{ resolve(nil); } reject:reject];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeLatchwaySpecJSI>(params);
}

@end
