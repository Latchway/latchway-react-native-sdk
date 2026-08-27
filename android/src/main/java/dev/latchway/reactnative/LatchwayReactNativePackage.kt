package dev.latchway.reactnative

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

public class LatchwayReactNativePackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == NativeLatchwayModule.NAME) NativeLatchwayModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            NativeLatchwayModule.NAME to ReactModuleInfo(
                NativeLatchwayModule.NAME,
                NativeLatchwayModule::class.java.name,
                false,
                false,
                false,
                true,
            )
        )
    }
}
