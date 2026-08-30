package com.latchwayexample

import android.content.ContentProvider
import android.content.ContentValues
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Build
import android.os.Debug
import android.os.ParcelFileDescriptor
import android.os.Process
import android.util.AtomicFile
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val EVIDENCE_FILE = "latchway-rn-device-run.json"
private const val EVIDENCE_MODULE = "LatchwayEvidence"
private const val MAXIMUM_IDENTITY_GRANT_BYTES = 65_536
private val PHYSICAL_RUN_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
private val SHA256_DIGEST = Regex("^[0-9a-f]{64}$")
private val APPLICATION_IDENTIFIER = Regex("^app_[0-7][0-9A-HJKMNP-TV-Z]{25}$")

class LatchwayEvidencePackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == EVIDENCE_MODULE) LatchwayEvidenceModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            EVIDENCE_MODULE to ReactModuleInfo(
                EVIDENCE_MODULE,
                LatchwayEvidenceModule::class.java.name,
                false,
                false,
                false,
                false,
            ),
        )
    }
}

class LatchwayEvidenceModule(
    context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
    override fun getName(): String = EVIDENCE_MODULE

    @ReactMethod
    fun consumeIdentityGrant(
        applicationID: String,
        packageOrBundleIdentifier: String,
        identityProvider: String,
        promise: Promise,
    ) {
        try {
            val activity = requireNotNull(reactApplicationContext.getCurrentActivity())
            val runID = requireNotNull(activity.intent?.getStringExtra("dev.latchway.RUN_ID"))
                .also { require(PHYSICAL_RUN_ID.matches(it)) }
            val debuggable = reactApplicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
            val testing = Build.FINGERPRINT.lowercase(Locale.US).contains("robolectric")
            val debugger = Debug.isDebuggerConnected() || Debug.waitingForDebugger()
            require(!isEmulator() && !testing && !debugger && !debuggable)
            require(APPLICATION_IDENTIFIER.matches(applicationID))
            require(packageOrBundleIdentifier == reactApplicationContext.packageName)
            require(identityProvider == "firebase")
            promise.resolve(PhysicalIdentityGrantHandoff.consume(
                runID,
                applicationID,
                packageOrBundleIdentifier,
                identityProvider,
            ))
        } catch (_: Exception) {
            promise.reject(
                "device_identity_grant_invalid",
                "Protected one-use identity grant is unavailable.",
            )
        }
    }

    @ReactMethod
    fun javascriptBundleSHA256(promise: Promise) {
        promise.reject("device_evidence_invalid", "JavaScript bundle digest is only available on iOS.")
    }

    @ReactMethod
    fun write(encoded: String, promise: Promise) {
        try {
            require(encoded.toByteArray(StandardCharsets.UTF_8).size in 1..65_536)
            val input = JSONObject(encoded)
            val sanitized = sanitize(input)
            val payload = sanitized.toString(2).toByteArray(StandardCharsets.UTF_8)
            require(payload.size <= 131_072)
            val destination = AtomicFile(File(reactApplicationContext.filesDir, EVIDENCE_FILE))
            val stream = destination.startWrite()
            try {
                stream.write(payload)
                stream.write('\n'.code)
                destination.finishWrite(stream)
            } catch (failure: Exception) {
                destination.failWrite(stream)
                throw failure
            }
            promise.resolve(null)
        } catch (_: Exception) {
            promise.reject("device_evidence_invalid", "Redacted physical-device run is invalid.")
        }
    }

    @ReactMethod
    fun runID(promise: Promise) {
        @Suppress("DEPRECATION")
        val value = reactApplicationContext.getCurrentActivity()?.intent?.getStringExtra("dev.latchway.RUN_ID")
        if (value != null && RUN_ID.matches(value)) promise.resolve(value)
        else promise.reject("device_evidence_invalid", "Protected physical-device run ID is unavailable.")
    }

    private fun sanitize(input: JSONObject): JSONObject {
        require(input.namesSet() == setOf(
            "schema_version", "platform", "run", "gateway_version", "native", "pins", "tests", "redaction",
        ))
        require(input.getString("schema_version") == "latchway.react-native-device-run.v2")
        require(input.getString("platform") == "react_native_android_play_integrity")
        val run = input.getJSONObject("run")
        require(run.namesSet() == setOf("id", "mode", "started_at", "completed_at"))
        require(RUN_ID.matches(run.getString("id")) && run.getString("mode") == "release")
        require(TIMESTAMP.matches(run.getString("started_at")) && TIMESTAMP.matches(run.getString("completed_at")))
        val gatewayVersion = input.getString("gateway_version").also { require(it.length in 1..128 && SAFE_TEXT.matches(it)) }
        val native = input.getJSONObject("native")
        require(native.namesSet() == setOf(
            "provider", "trust_level", "key_storage", "native_sdk_version", "native_evidence_sha256",
            "session_state", "new_architecture",
        ))
        require(native.getString("provider") in setOf("play_integrity", "unverified"))
        require(native.getString("trust_level") in setOf(
            "none", "identity_only", "web_risk_verified", "device_verified",
            "strong_device_verified", "debug",
        ))
        require(native.getString("key_storage") in setOf(
            "strongbox", "trusted_execution_environment", "unknown_secure_hardware", "software", "unknown",
        ))
        require(SEMVER.matches(native.getString("native_sdk_version")))
        require(SHA256.matches(native.getString("native_evidence_sha256")))
        require(native.getString("session_state") in setOf(
            "absent", "establishing", "active", "refreshing", "expired", "revoked", "failed", "unknown",
        ))
        require(native.getBoolean("new_architecture") && BuildConfig.IS_NEW_ARCHITECTURE_ENABLED)
        val pins = sanitizePins(input.getJSONObject("pins"))
        val tests = sanitizeTests(input.getJSONArray("tests"))
        val redaction = sanitizeRedaction(input.getJSONObject("redaction"))

        val packageInfo = reactApplicationContext.packageInfo()
        val installer = if (Build.VERSION.SDK_INT >= 30) {
            reactApplicationContext.packageManager
                .getInstallSourceInfo(reactApplicationContext.packageName).installingPackageName.orEmpty()
        } else {
            @Suppress("DEPRECATION")
            reactApplicationContext.packageManager
                .getInstallerPackageName(reactApplicationContext.packageName).orEmpty()
        }
        val emulator = isEmulator()
        val testing = Build.FINGERPRINT.lowercase(Locale.US).contains("robolectric")
        val debugger = Debug.isDebuggerConnected() || Debug.waitingForDebugger()
        val debuggable = reactApplicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        require(!emulator && !testing && !debugger && !debuggable)

        return JSONObject()
            .put("schema_version", "latchway.react-native-device-run.v2")
            .put("platform", "react_native_android_play_integrity")
            .put("run", JSONObject()
                .put("id", run.getString("id"))
                .put("mode", "release")
                .put("started_at", run.getString("started_at"))
                .put("completed_at", run.getString("completed_at")))
            .put("gateway_version", gatewayVersion)
            .put("native", JSONObject()
                .put("provider", native.getString("provider"))
                .put("trust_level", native.getString("trust_level"))
                .put("key_storage", native.getString("key_storage"))
                .put("native_sdk_version", native.getString("native_sdk_version"))
                .put("native_evidence_sha256", native.getString("native_evidence_sha256"))
                .put("session_state", native.getString("session_state"))
                .put("new_architecture", true))
            .put("pins", pins)
            .put("application", JSONObject()
                .put("identifier", reactApplicationContext.packageName)
                .put("version", packageInfo.versionName.orEmpty())
                .put("build", packageInfo.compatibleVersionCode().toString())
                .put("debuggable", false)
                .put("installer_package", installer))
            .put("device", JSONObject()
                .put("physical", true)
                .put("simulator", false)
                .put("emulator", false)
                .put("testing", false)
                .put("debugger_attached", false)
                .put("model", listOf(Build.MANUFACTURER, Build.MODEL).filter(String::isNotBlank).joinToString(" ").take(128))
                .put("os_name", "Android")
                .put("os_version", Build.VERSION.RELEASE.take(64))
                .put("os_build", Build.ID.take(64)))
            .put("tests", tests)
            .put("redaction", redaction)
    }

    private fun sanitizeTests(input: JSONArray): JSONArray {
        require(input.length() in 1..32)
        val output = JSONArray()
        val seen = mutableSetOf<String>()
        val expected = setOf(
            "react_native_bridge", "play_integrity_session", "hardware_backed_key",
            "dpop_authorized_request", "streamed_request", "quota", "canonical_error_mapping",
        )
        for (index in 0 until input.length()) {
            val item = input.getJSONObject(index)
            require(item.namesSet().subtract(setOf(
                "id", "status", "duration_ms", "http_status", "error_code", "request_id",
                "mapped_error_type",
            )).isEmpty())
            require(item.has("id") && item.has("status") && item.has("duration_ms"))
            val id = item.getString("id").also { require(TEST_ID.matches(it) && it in expected && seen.add(it)) }
            val status = item.getString("status").also { require(it == "passed" || it == "failed") }
            val duration = item.getLong("duration_ms").also { require(it in 0..7_200_000) }
            val safe = JSONObject().put("id", id).put("status", status).put("duration_ms", duration)
            if (item.has("http_status")) safe.put("http_status", item.getInt("http_status").also { require(it in 100..599) })
            if (item.has("error_code")) safe.put("error_code", item.getString("error_code").also { require(TEST_ID.matches(it)) })
            if (item.has("request_id")) safe.put("request_id", item.getString("request_id").also { require(RUN_ID.matches(it)) })
            if (item.has("mapped_error_type")) safe.put(
                "mapped_error_type",
                item.getString("mapped_error_type").also { require(it == "react_native_latchway_error") },
            )
            output.put(safe)
        }
        require(seen == expected)
        return output
    }

    private fun sanitizeRedaction(input: JSONObject): JSONObject {
        val names = setOf(
            "identity_token_recorded", "session_token_recorded", "refresh_token_recorded",
            "dpop_proof_recorded", "attestation_evidence_recorded", "private_key_recorded",
            "provider_credential_recorded",
        )
        require(input.namesSet() == names && names.all { !input.getBoolean(it) })
        return JSONObject(input.toString())
    }

    private fun sanitizePins(input: JSONObject): JSONObject {
        val names = setOf(
            "source_commit", "core_commit", "contract_bundle_sha256", "gateway_image_digest",
            "gateway_configuration_sha256", "native_evidence_sha256", "distribution",
            "gateway_origin", "gateway_deployment_key_id", "gateway_deployment_statement_sha256",
            "gateway_deployment_public_key_sha256",
            "error_mapping_feature",
            "gateway_environment",
            "signing_certificate_sha256", "play_track", "cloud_project_number", "require_licensed",
        )
        require(input.namesSet() == names)
        require(COMMIT.matches(input.getString("source_commit")))
        require(COMMIT.matches(input.getString("core_commit")))
        require(SHA256.matches(input.getString("contract_bundle_sha256")))
        require(IMAGE.matches(input.getString("gateway_image_digest")))
        require(SHA256.matches(input.getString("gateway_configuration_sha256")))
        require(GATEWAY_ORIGIN.matches(input.getString("gateway_origin")))
        require(ENVIRONMENT.matches(input.getString("gateway_environment")))
        require(KEY_ID.matches(input.getString("gateway_deployment_key_id")))
        require(SHA256.matches(input.getString("gateway_deployment_statement_sha256")))
        require(SHA256.matches(input.getString("gateway_deployment_public_key_sha256")))
        require(FEATURE.matches(input.getString("error_mapping_feature")))
        require(SHA256.matches(input.getString("native_evidence_sha256")))
        require(SHA256.matches(input.getString("signing_certificate_sha256")))
        require(input.getString("distribution") in setOf("play_internal", "play_closed", "play_open", "play_production"))
        require(input.getString("play_track") in setOf("internal", "closed", "open", "production"))
        require(CLOUD_PROJECT.matches(input.getString("cloud_project_number")))
        require(input.getString("require_licensed") == "true")
        return JSONObject(input.toString())
    }

    companion object {
        private val RUN_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
        private val TEST_ID = Regex("^[a-z][a-z0-9_]{0,63}$")
        private val TIMESTAMP = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^\\s]{8,40}Z$")
        private val SEMVER = Regex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
        private val COMMIT = Regex("^[0-9a-f]{40}$")
        private val SHA256 = Regex("^[0-9a-f]{64}$")
        private val IMAGE = Regex("^sha256:[0-9a-f]{64}$")
        private val GATEWAY_ORIGIN = Regex("^https://[a-z0-9][A-Za-z0-9.-]*(?::[1-9][0-9]{0,4})?(?:/[A-Za-z0-9_~.-]+)*$")
        private val KEY_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
        private val ENVIRONMENT = Regex("^[a-z][a-z0-9_-]{0,62}$")
        private val FEATURE = Regex("^[a-z][a-z0-9_.:-]{0,127}$")
        private val CLOUD_PROJECT = Regex("^[1-9][0-9]{0,18}$")
        private val SAFE_TEXT = Regex("^[A-Za-z0-9._+-]{1,128}$")
    }
}

class LatchwayEvidenceProvider : ContentProvider() {
    override fun onCreate(): Boolean = true
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val caller = Binder.getCallingUid()
        if (caller != Process.SHELL_UID && caller != 0) throw SecurityException("adb shell only")
        if (mode == "r" && uri.pathSegments == listOf("v1", "latest")) {
            val file = File(requireNotNull(context).filesDir, EVIDENCE_FILE)
            check(file.isFile && file.length() in 1..131_072)
            return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        }
        if (mode == "w" && uri.pathSegments.size == 7 &&
            uri.pathSegments.take(2) == listOf("v1", "identity-grant")) {
            val expectedHash = uri.pathSegments[2].also { require(SHA256_DIGEST.matches(it)) }
            val runID = uri.pathSegments[3].also { require(PHYSICAL_RUN_ID.matches(it)) }
            val applicationID = uri.pathSegments[4].also { require(APPLICATION_IDENTIFIER.matches(it)) }
            val packageName = uri.pathSegments[5].also {
                require(it == requireNotNull(context).packageName)
            }
            val identityProvider = uri.pathSegments[6].also { require(it == "firebase") }
            val pipe = ParcelFileDescriptor.createPipe()
            Thread({
                val grantBuffer = ByteArray(MAXIMUM_IDENTITY_GRANT_BYTES)
                try {
                    var grantSize = 0
                    ParcelFileDescriptor.AutoCloseInputStream(pipe[0]).use { input ->
                        while (grantSize < grantBuffer.size) {
                            val count = input.read(grantBuffer, grantSize, grantBuffer.size - grantSize)
                            if (count < 0) break
                            grantSize += count
                        }
                        if (grantSize == grantBuffer.size) require(input.read() < 0)
                    }
                    require(grantSize > 0)
                    val grant = grantBuffer.copyOf(grantSize)
                    PhysicalIdentityGrantHandoff.stage(
                        grant,
                        expectedHash,
                        runID,
                        applicationID,
                        packageName,
                        identityProvider,
                    )
                } catch (_: Exception) {
                    PhysicalIdentityGrantHandoff.invalidate()
                } finally {
                    grantBuffer.fill(0)
                }
            }, "latchway-identity-grant-handoff").apply {
                isDaemon = true
                start()
            }
            return pipe[1]
        }
        throw IllegalArgumentException("unsupported evidence-provider operation")
    }

    override fun getType(uri: Uri): String = "application/json"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
}

/**
 * One process-memory slot populated only through the shell-protected provider.
 * `adb shell content write` streams the Firebase custom token over stdin, so
 * the value is absent from shell argv, intents, logcat, files, and retained
 * evidence. The byte array is zeroed before the sole bridge read resolves.
 */
private object PhysicalIdentityGrantHandoff {
    private val available = CountDownLatch(1)
    private var bytes: ByteArray? = null
    private var runID: String? = null
    private var applicationID: String? = null
    private var packageName: String? = null
    private var identityProvider: String? = null
    private var invalid = false
    private var consumed = false

    @Synchronized
    fun stage(
        value: ByteArray,
        expectedHash: String,
        expectedRunID: String,
        expectedApplicationID: String,
        expectedPackageName: String,
        expectedIdentityProvider: String,
    ) {
        try {
            require(!invalid && !consumed && bytes == null && runID == null)
            require(applicationID == null && packageName == null && identityProvider == null)
            require(APPLICATION_IDENTIFIER.matches(expectedApplicationID))
            require(expectedPackageName.isNotEmpty() && expectedIdentityProvider == "firebase")
            require(value.size in 32..MAXIMUM_IDENTITY_GRANT_BYTES)
            val encoded = String(value, StandardCharsets.US_ASCII)
            val segments = encoded.split('.', limit = 4)
            require(segments.size == 3 && segments.all { segment ->
                segment.isNotEmpty() && segment.all { character ->
                    character in 'A'..'Z' || character in 'a'..'z' || character in '0'..'9' ||
                        character == '_' || character == '-'
                }
            })
            val actual = MessageDigest.getInstance("SHA-256").digest(value).toHex()
            require(MessageDigest.isEqual(
                actual.toByteArray(StandardCharsets.US_ASCII),
                expectedHash.toByteArray(StandardCharsets.US_ASCII),
            ))
            bytes = value
            runID = expectedRunID
            applicationID = expectedApplicationID
            packageName = expectedPackageName
            identityProvider = expectedIdentityProvider
            available.countDown()
        } catch (failure: Exception) {
            value.fill(0)
            clearState()
            invalid = true
            consumed = true
            available.countDown()
            throw failure
        }
    }

    fun consume(
        expectedRunID: String,
        expectedApplicationID: String,
        expectedPackageName: String,
        expectedIdentityProvider: String,
    ): String {
        val staged = try {
            available.await(30, TimeUnit.SECONDS)
        } catch (failure: Exception) {
            synchronized(this) {
                clearState()
                invalid = true
                consumed = true
            }
            throw failure
        }
        synchronized(this) {
            try {
                require(staged && !invalid && !consumed && runID == expectedRunID)
                require(applicationID == expectedApplicationID)
                require(packageName == expectedPackageName)
                require(identityProvider == expectedIdentityProvider && expectedIdentityProvider == "firebase")
                val output = String(requireNotNull(bytes), StandardCharsets.US_ASCII)
                clearState()
                consumed = true
                return output
            } catch (failure: Exception) {
                clearState()
                invalid = true
                consumed = true
                throw failure
            }
        }
    }

    @Synchronized
    fun invalidate() {
        clearState()
        invalid = true
        consumed = true
        available.countDown()
    }

    private fun clearState() {
        bytes?.fill(0)
        bytes = null
        runID = null
        applicationID = null
        packageName = null
        identityProvider = null
    }
}

private fun JSONObject.namesSet(): Set<String> {
    val names = keys()
    val result = mutableSetOf<String>()
    while (names.hasNext()) result += names.next()
    return result
}

private fun ReactApplicationContext.packageInfo(): PackageInfo = if (Build.VERSION.SDK_INT >= 33) {
    packageManager.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0L))
} else {
    @Suppress("DEPRECATION")
    packageManager.getPackageInfo(packageName, 0)
}

private fun PackageInfo.compatibleVersionCode(): Long = if (Build.VERSION.SDK_INT >= 28) {
    longVersionCode
} else {
    @Suppress("DEPRECATION")
    versionCode.toLong()
}

private fun isEmulator(): Boolean {
    val fingerprint = Build.FINGERPRINT.lowercase(Locale.US)
    val model = Build.MODEL.lowercase(Locale.US)
    val product = Build.PRODUCT.lowercase(Locale.US)
    val hardware = Build.HARDWARE.lowercase(Locale.US)
    return fingerprint.startsWith("generic") || fingerprint.contains("emulator") ||
        model.contains("sdk_gphone") || model.contains("emulator") ||
        product.contains("sdk") || hardware.contains("goldfish") || hardware.contains("ranchu")
}

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(Locale.US, it.toInt() and 0xff) }
