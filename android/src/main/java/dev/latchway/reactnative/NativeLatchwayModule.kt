package dev.latchway.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import dev.latchway.core.KeyPolicy
import dev.latchway.core.LATCHWAY_CONTRACT_VERSION
import dev.latchway.core.LATCHWAY_PROTOCOL_VERSION
import dev.latchway.core.LATCHWAY_SDK_VERSION
import dev.latchway.core.LatchwayClientPlatform
import dev.latchway.core.LatchwayErrorCode
import dev.latchway.core.LatchwayException
import dev.latchway.okhttp.LatchwayClient
import dev.latchway.okhttp.LatchwayConfiguration
import dev.latchway.playintegrity.PlayIntegrityAttestationProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

@ReactModule(name = NativeLatchwayModule.NAME)
public class NativeLatchwayModule(
    reactContext: ReactApplicationContext,
) : NativeLatchwaySpec(reactContext) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val clients = ConcurrentHashMap<String, NativeClientContext>()
    private val jobs = ConcurrentHashMap<String, Job>()

    override fun getName(): String = NAME

    override fun configure(clientID: String, configurationJSON: String, promise: Promise) {
        launchPromise(clientID, "configure", promise) {
            require(!clients.containsKey(clientID)) { "client identifier is already configured" }
            val configuration = NativeConfiguration.parse(configurationJSON)
            require(configuration.contractVersion == LATCHWAY_CONTRACT_VERSION &&
                configuration.protocolVersion == LATCHWAY_PROTOCOL_VERSION
            ) { "contract version is incompatible" }
            val projectNumber = configuration.playIntegrityCloudProjectNumber
                ?: throw IllegalArgumentException("Play Integrity cloud project number is required on Android")
            val keyPolicy = when (configuration.keyPolicy) {
                "hardware_backed_required" -> KeyPolicy(preferStrongBox = false, allowSoftwareBacked = false)
                "strongbox_preferred" -> KeyPolicy(preferStrongBox = true, allowSoftwareBacked = false)
                "software_allowed" -> KeyPolicy(preferStrongBox = true, allowSoftwareBacked = true)
                else -> throw IllegalArgumentException("Android key policy is invalid")
            }
            val tokenProvider = TransientIdentityTokenProvider()
            val nativeConfiguration = LatchwayConfiguration(
                baseUrl = configuration.baseURL.toHttpUrl(),
                applicationId = configuration.applicationID,
                environment = configuration.environment,
                identityProvider = configuration.identityProvider,
                clientPlatform = LatchwayClientPlatform.REACT_NATIVE_ANDROID,
                sdkVersion = configuration.sdkVersion,
                keyPolicy = keyPolicy,
                allowInsecureLoopback = configuration.allowInsecureLoopback,
            )
            val client = LatchwayClient(
                configuration = nativeConfiguration,
                identityTokenProvider = { tokenProvider.current() },
                attestationProvider = PlayIntegrityAttestationProvider(
                    context = reactApplicationContext,
                    cloudProjectNumber = projectNumber,
                ),
                context = reactApplicationContext,
            )
            val context = NativeClientContext(client, tokenProvider)
            check(clients.putIfAbsent(clientID, context) == null) { "client identifier is already configured" }
            JSONObject()
                .put("platform", "react_native_android")
                .put("nativeSDKVersion", LATCHWAY_SDK_VERSION)
                .put("contractVersion", LATCHWAY_CONTRACT_VERSION)
                .put("protocolVersion", LATCHWAY_PROTOCOL_VERSION)
                .toString()
        }
    }

    override fun authorize(
        clientID: String,
        operationID: String,
        identityToken: String,
        requestJSON: String,
        promise: Promise,
    ) {
        operate(clientID, operationID, identityToken, promise) { client ->
            val input = AuthorizationInput.parse(requestJSON)
            val body = if (input.method in setOf("POST", "PUT", "PATCH", "PROPPATCH", "REPORT")) {
                ByteArray(0).toRequestBody(null)
            } else {
                null
            }
            val builder = Request.Builder().url(input.url).method(input.method, body)
            input.requestID?.let { builder.header("X-Latchway-Request-ID", it) }
            val authorized = if (input.nonce == null) {
                client.authorize(builder.build(), input.feature)
            } else {
                client.authorize(builder.build(), input.feature, input.nonce)
            }
            val requestID = input.requestID ?: authorized.header("X-Latchway-Request-ID")
                ?: throw IllegalStateException("native authorization omitted request ID")
            JSONObject()
                .put("authorization", authorized.header("Authorization"))
                .put("dpop", authorized.header("DPoP"))
                .put("requestID", requestID)
                .toString()
        }
    }

    override fun refresh(clientID: String, operationID: String, identityToken: String, promise: Promise) {
        operate(clientID, operationID, identityToken, promise) { client ->
            client.refresh()
            null
        }
    }

    override fun quota(
        clientID: String,
        operationID: String,
        identityToken: String,
        feature: String,
        promise: Promise,
    ) {
        operate(clientID, operationID, identityToken, promise) { client ->
            val snapshot = client.quota(feature)
            val limits = JSONArray()
            snapshot.limits.forEach { limit ->
                limits.put(JSONObject()
                    .put("metric", limit.metric)
                    .putNullable("maximum", limit.maximum)
                    .putNullable("used", limit.used)
                    .putNullable("reserved", limit.reserved)
                    .putNullable("remaining", limit.remaining)
                    .putNullable("resets_at", limit.resetsAt)
                    .put("hard", limit.hard))
            }
            JSONObject()
                .put("feature", snapshot.feature)
                .put("observed_at", snapshot.observedAt)
                .put("limits", limits)
                .toString()
        }
    }

    override fun diagnostics(clientID: String, operationID: String, identityToken: String, promise: Promise) {
        operate(clientID, operationID, identityToken, promise) { client ->
            val diagnostics = client.diagnostics()
            JSONObject()
                .put("contractVersion", diagnostics.contractVersion)
                .put("protocolVersion", diagnostics.protocolVersion)
                .put("keyStorage", diagnostics.key.backing.name.lowercase())
                .put("attestation", JSONObject()
                    .put("support", "supported")
                    .put("provider", diagnostics.trustProvider))
                .put("session", JSONObject()
                    .put("state", "active")
                    .put("expiresAt", diagnostics.sessionExpiresAt)
                    .put("refreshAvailable", diagnostics.refreshAvailable))
                .put("installation", JSONObject()
                    .put("id", diagnostics.installationId)
                    .put("status", diagnostics.installationStatus))
                .put("server", JSONObject()
                    .put("version", diagnostics.serverVersion)
                    .put("lastRequestID", diagnostics.requestId))
                .toString()
        }
    }

    override fun revoke(clientID: String, operationID: String, identityToken: String, promise: Promise) {
        operate(clientID, operationID, identityToken, promise) { client ->
            client.revokeCurrentInstallation()
            null
        }
    }

    override fun cancel(clientID: String, operationID: String) {
        jobs[operationKey(clientID, operationID)]?.cancel()
    }

    override fun dispose(clientID: String, promise: Promise) {
        clients.remove(clientID)?.close()
        val prefix = "$clientID|"
        jobs.entries.filter { it.key.startsWith(prefix) }.forEach { it.value.cancel() }
        promise.resolve(null)
    }

    override fun invalidate() {
        jobs.values.forEach { it.cancel() }
        clients.values.forEach(NativeClientContext::close)
        jobs.clear()
        clients.clear()
        scope.cancel()
        super.invalidate()
    }

    private fun <T> operate(
        clientID: String,
        operationID: String,
        identityToken: String,
        promise: Promise,
        action: suspend (LatchwayClient) -> T,
    ) {
        val context = clients[clientID]
        if (context == null) {
            promise.reject("invalid_configuration", "Latchway native client is not configured.")
            return
        }
        val key = operationKey(clientID, operationID)
        val job = scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            try {
                promise.resolve(context.withIdentityToken(identityToken, action))
            } catch (failure: Throwable) {
                promise.rejectSafe(failure)
            } finally {
                jobs.remove(key)
            }
        }
        if (jobs.putIfAbsent(key, job) != null) {
            job.cancel()
            promise.reject("request_invalid", "Latchway operation identifier is already active.")
        } else {
            job.start()
        }
    }

    private fun <T> launchPromise(
        clientID: String,
        operationID: String,
        promise: Promise,
        action: suspend () -> T,
    ) {
        val key = operationKey(clientID, operationID)
        val job = scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            try { promise.resolve(action()) }
            catch (failure: Throwable) { promise.rejectSafe(failure) }
            finally { jobs.remove(key) }
        }
        if (jobs.putIfAbsent(key, job) != null) {
            job.cancel()
            promise.reject("request_invalid", "Latchway operation identifier is already active.")
        } else {
            job.start()
        }
    }

    public companion object { public const val NAME: String = "NativeLatchway" }
}

private class NativeClientContext(
    private val client: LatchwayClient,
    private val tokenProvider: TransientIdentityTokenProvider,
) {
    private val operationMutex = Mutex()

    suspend fun <T> withIdentityToken(token: String, action: suspend (LatchwayClient) -> T): T {
        if (token.isEmpty() || token.toByteArray(Charsets.UTF_8).size > 65_536 || token.any(Char::isISOControl)) {
            throw LatchwayException(
                code = LatchwayErrorCode.REQUEST_INVALID,
                safeMessage = "The identity token is invalid",
            )
        }
        return operationMutex.withLock {
            tokenProvider.set(token)
            try { action(client) } finally { tokenProvider.clear() }
        }
    }

    fun close() { client.close() }
}

private class TransientIdentityTokenProvider {
    @Volatile private var value: String? = null
    fun set(token: String) { value = token }
    fun clear() { value = null }
    fun current(): String = value ?: throw IllegalStateException("identity token is unavailable")
}

private data class NativeConfiguration(
    val baseURL: String,
    val applicationID: String,
    val environment: String,
    val identityProvider: String,
    val sdkVersion: String,
    val contractVersion: String,
    val protocolVersion: Int,
    val allowInsecureLoopback: Boolean,
    val playIntegrityCloudProjectNumber: Long?,
    val keyPolicy: String,
) {
    companion object {
        fun parse(encoded: String): NativeConfiguration {
            require(encoded.toByteArray(Charsets.UTF_8).size <= 65_536) { "native configuration is too large" }
            val value = JSONObject(encoded)
            val android = value.getJSONObject("android")
            return NativeConfiguration(
                baseURL = value.getString("baseURL"),
                applicationID = value.getString("applicationID"),
                environment = value.getString("environment"),
                identityProvider = value.getString("identityProvider"),
                sdkVersion = value.getString("sdkVersion"),
                contractVersion = value.getString("contractVersion"),
                protocolVersion = value.getInt("protocolVersion"),
                allowInsecureLoopback = value.optBoolean("allowInsecureLoopback", false),
                playIntegrityCloudProjectNumber = android.optString("playIntegrityCloudProjectNumber")
                    .takeIf(String::isNotEmpty)?.toLongOrNull(),
                keyPolicy = android.getString("keyPolicy"),
            )
        }
    }
}

private data class AuthorizationInput(
    val url: String,
    val method: String,
    val feature: String,
    val nonce: String?,
    val requestID: String?,
) {
    companion object {
        fun parse(encoded: String): AuthorizationInput {
            require(encoded.toByteArray(Charsets.UTF_8).size <= 65_536) { "native request is too large" }
            val value = JSONObject(encoded)
            return AuthorizationInput(
                url = value.getString("url"),
                method = value.getString("method"),
                feature = value.getString("feature"),
                nonce = value.optNullableString("nonce"),
                requestID = value.optNullableString("requestID"),
            )
        }
    }
}

private fun JSONObject.optNullableString(name: String): String? =
    if (isNull(name)) null else getString(name)

private fun JSONObject.putNullable(name: String, value: Any?): JSONObject =
    put(name, value ?: JSONObject.NULL)

private fun operationKey(clientID: String, operationID: String): String = "$clientID|$operationID"

private fun Promise.rejectSafe(failure: Throwable) {
    val code: String
    val message: String
    val requestID: String?
    val operationID: String?
    val status: Int?
    val retryable: Boolean
    when (failure) {
        is CancellationException -> {
            code = "cancelled"; message = "The Latchway native operation was cancelled."
            requestID = null; operationID = null; status = null; retryable = false
        }
        is LatchwayException -> {
            code = failure.code.wireValue
            message = sanitize(failure.message)
            requestID = failure.requestId
            operationID = failure.operationId
            status = failure.httpStatus
            retryable = failure.retryable
        }
        is IllegalArgumentException -> {
            code = "invalid_configuration"; message = "Latchway native configuration is invalid."
            requestID = null; operationID = null; status = null; retryable = false
        }
        else -> {
            code = "internal_error"; message = "The Latchway native operation failed."
            requestID = null; operationID = null; status = null; retryable = false
        }
    }
    val userInfo = Arguments.createMap().apply {
        putString("code", code)
        requestID?.let { putString("requestID", it) }
        operationID?.let { putString("operationID", it) }
        status?.let { putInt("status", it) }
        putBoolean("retryable", retryable)
    }
    reject(code, message, userInfo)
}

private fun sanitize(value: String?): String {
    if (value.isNullOrBlank()) return "The Latchway native operation failed."
    val bounded = value.replace(Regex("[\\u0000-\\u001f\\u007f]"), " ").take(512)
    return if (Regex("eyJ|lwa_|lws_|refresh.?token|identity.?token|integrity.?token|[A-Za-z0-9_-]{64,}", RegexOption.IGNORE_CASE)
            .containsMatchIn(bounded)
    ) "Sensitive native error detail was redacted." else bounded
}
