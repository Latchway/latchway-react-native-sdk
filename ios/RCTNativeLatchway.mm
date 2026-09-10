#import "RCTNativeLatchway.h"
#if __has_include(<LatchwayReactNative/LatchwayReactNative-Swift.h>)
#import <LatchwayReactNative/LatchwayReactNative-Swift.h>
#else
#import "LatchwayReactNative-Swift.h"
#endif

@implementation RCTNativeLatchway {
  LatchwayNativeBridge *_bridge;
}

RCT_EXPORT_MODULE(NativeLatchway)

- (void)invalidate {
  [_bridge invalidate];
}

- (void)appCommand:(NSString *)commandJSON
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  [_bridge appCommandWithJSON:commandJSON resolve:resolve reject:reject];
}

- (instancetype)init {
  if ((self = [super init])) {
    _bridge = [LatchwayNativeBridge new];
  }
  return self;
}

- (void)configureComponent:(NSString *)clientID
          configurationJSON:(NSString *)configurationJSON
              componentJSON:(NSString *)componentJSON
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  [_bridge configureComponentWithClientID:clientID configurationJSON:configurationJSON componentJSON:componentJSON resolve:resolve reject:reject];
}

- (void)startRequest:(NSString *)clientID
         operationID:(NSString *)operationID
         requestJSON:(NSString *)requestJSON
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  [_bridge startRequestWithClientID:clientID operationID:operationID requestJSON:requestJSON resolve:resolve reject:reject];
}

- (void)readResponseChunk:(NSString *)clientID
              operationID:(NSString *)operationID
               responseID:(NSString *)responseID
             maximumBytes:(double)maximumBytes
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  [_bridge readResponseChunkWithClientID:clientID operationID:operationID responseID:responseID maximumBytes:maximumBytes resolve:resolve reject:reject];
}

- (void)closeResponse:(NSString *)clientID
           responseID:(NSString *)responseID
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  [_bridge closeResponseWithClientID:clientID responseID:responseID resolve:^{ resolve(nil); } reject:reject];
}

- (void)refresh:(NSString *)clientID
     operationID:(NSString *)operationID
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  [_bridge refreshWithClientID:clientID operationID:operationID resolve:^{ resolve(nil); } reject:reject];
}

- (void)quota:(NSString *)clientID
   operationID:(NSString *)operationID
        feature:(NSString *)feature
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject {
  [_bridge quotaWithClientID:clientID operationID:operationID feature:feature resolve:resolve reject:reject];
}

- (void)diagnostics:(NSString *)clientID
         operationID:(NSString *)operationID
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  [_bridge diagnosticsWithClientID:clientID operationID:operationID resolve:resolve reject:reject];
}

- (void)componentDiagnostics:(NSString *)clientID
                  operationID:(NSString *)operationID
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject {
  [_bridge componentDiagnosticsWithClientID:clientID operationID:operationID resolve:resolve reject:reject];
}

- (void)prepareComponents:(NSString *)clientID
              operationID:(NSString *)operationID
           componentsJSON:(NSString *)componentsJSON
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  [_bridge prepareComponentsWithClientID:clientID operationID:operationID componentsJSON:componentsJSON resolve:resolve reject:reject];
}

- (void)replaceComponent:(NSString *)clientID
              operationID:(NSString *)operationID
            componentJSON:(NSString *)componentJSON
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  [_bridge replaceComponentWithClientID:clientID operationID:operationID componentJSON:componentJSON resolve:resolve reject:reject];
}

- (void)rootComponentDiagnostics:(NSString *)clientID
                      operationID:(NSString *)operationID
                    componentJSON:(NSString *)componentJSON
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject {
  [_bridge rootComponentDiagnosticsWithClientID:clientID operationID:operationID componentJSON:componentJSON resolve:resolve reject:reject];
}

- (void)revokeComponent:(NSString *)clientID
             operationID:(NSString *)operationID
           componentJSON:(NSString *)componentJSON
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  [_bridge revokeComponentWithClientID:clientID operationID:operationID componentJSON:componentJSON resolve:^{ resolve(nil); } reject:reject];
}

- (void)revoke:(NSString *)clientID
    operationID:(NSString *)operationID
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject {
  [_bridge revokeWithClientID:clientID operationID:operationID resolve:^{ resolve(nil); } reject:reject];
}

- (void)revokeFamily:(NSString *)clientID
          operationID:(NSString *)operationID
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  [_bridge revokeFamilyWithClientID:clientID operationID:operationID resolve:^{ resolve(nil); } reject:reject];
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
