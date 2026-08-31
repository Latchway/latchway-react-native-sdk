package dev.latchway.reactnative

import android.net.Uri
import android.util.Base64
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
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

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
            val context = NativeClientContext(client, tokenProvider, nativeConfiguration.baseUrl)
            check(clients.putIfAbsent(clientID, context) == null) { "client identifier is already configured" }
            JSONObject()
                .put("platform", "react_native_android")
                .put("nativeSDKVersion", LATCHWAY_SDK_VERSION)
                .put("contractVersion", LATCHWAY_CONTRACT_VERSION)
                .put("protocolVersion", LATCHWAY_PROTOCOL_VERSION)
                .toString()
        }
    }

    override fun configureComponent(
        clientID: String,
        configurationJSON: String,
        componentJSON: String,
        promise: Promise,
    ) {
        launchPromise(clientID, "configure-component", promise) {
            throw LatchwayException(
                code = LatchwayErrorCode.ATTESTATION_UNSUPPORTED,
                safeMessage = "React Native direct component attestation is not supported by this Android SDK",
            )
        }
    }

    override fun startRequest(
        clientID: String,
        operationID: String,
        identityToken: String,
        requestJSON: String,
        promise: Promise,
    ) {
        operate(clientID, operationID, promise) { context ->
            context.startRequest(identityToken, requestJSON)
        }
    }

    override fun readResponseChunk(
        clientID: String,
        operationID: String,
        responseID: String,
        maximumBytes: Double,
        promise: Promise,
    ) {
        operate(clientID, operationID, promise) { context ->
            context.readResponseChunk(responseID, maximumBytes)
        }
    }

    override fun closeResponse(clientID: String, responseID: String, promise: Promise) {
        val context = clients[clientID]
        if (context == null) {
            promise.reject("invalid_configuration", "Latchway native client is not configured.")
            return
        }
        context.closeResponse(responseID)
        promise.resolve(null)
    }

    override fun refresh(clientID: String, operationID: String, identityToken: String, promise: Promise) {
        operate(clientID, operationID, promise) { context ->
            context.withIdentityToken(identityToken) { client -> client.refresh() }
        }
    }

    override fun quota(
        clientID: String,
        operationID: String,
        identityToken: String,
        feature: String,
        promise: Promise,
    ) {
        operate(clientID, operationID, promise) { context ->
            val snapshot = context.withIdentityToken(identityToken) { client -> client.quota(feature) }
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
        operate(clientID, operationID, promise) { context ->
            val diagnostics = context.withIdentityToken(identityToken) { client -> client.diagnostics() }
            JSONObject()
                .put("contractVersion", diagnostics.contractVersion)
                .put("protocolVersion", diagnostics.protocolVersion)
                .put("keyStorage", diagnostics.key.backing.name.lowercase())
                .put("attestation", JSONObject()
                    .put("support", "supported")
                    .put("provider", diagnostics.trustProvider)
                    .put("trustLevel", diagnostics.trustLevel))
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

    override fun establishDirectAttestation(
        clientID: String,
        operationID: String,
        promise: Promise,
    ) {
        operate(clientID, operationID, promise) {
            // The v1 Android SDK has independently keyed delegated components,
            // but no direct component-attestation endpoint. Never imitate the
            // iOS App Attest protocol or accept evidence through JavaScript.
            throw LatchwayException(
                code = LatchwayErrorCode.ATTESTATION_UNSUPPORTED,
                safeMessage = "Direct component attestation is not supported by this Android SDK",
            )
        }
    }

    override fun componentDiagnostics(
        clientID: String,
        operationID: String,
        promise: Promise,
    ) {
        operate(clientID, operationID, promise) {
            throw LatchwayException(
                code = LatchwayErrorCode.ATTESTATION_UNSUPPORTED,
                safeMessage = "Direct-attestation component diagnostics are not supported by this Android SDK",
            )
        }
    }

    override fun prepareComponents(
        clientID: String,
        operationID: String,
        identityToken: String,
        componentsJSON: String,
        promise: Promise,
    ) {
        operate(clientID, operationID, promise) {
            throw LatchwayException(
                code = LatchwayErrorCode.ATTESTATION_UNSUPPORTED,
                safeMessage = "Native iOS component provisioning is not supported by this Android SDK",
            )
        }
    }

    override fun replaceComponent(
        clientID: String,
        operationID: String,
        identityToken: String,
        componentJSON: String,
        promise: Promise,
    ) {
        operate(clientID, operationID, promise) {
            throw LatchwayException(
                code = LatchwayErrorCode.ATTESTATION_UNSUPPORTED,
                safeMessage = "Native iOS component replacement is not supported by this Android SDK",
            )
        }
    }

    override fun rootComponentDiagnostics(
        clientID: String,
        operationID: String,
        componentJSON: String,
        promise: Promise,
    ) {
        operate(clientID, operationID, promise) {
            throw LatchwayException(
                code = LatchwayErrorCode.ATTESTATION_UNSUPPORTED,
                safeMessage = "Native iOS root component diagnostics are not supported by this Android SDK",
            )
        }
    }

    override fun revokeComponent(
        clientID: String,
        operationID: String,
        identityToken: String,
        componentJSON: String,
        promise: Promise,
    ) {
        operate(clientID, operationID, promise) {
            throw LatchwayException(
                code = LatchwayErrorCode.ATTESTATION_UNSUPPORTED,
                safeMessage = "Native iOS component revocation is not supported by this Android SDK",
            )
        }
    }

    override fun revoke(clientID: String, operationID: String, identityToken: String, promise: Promise) {
        operate(clientID, operationID, promise) { context ->
            context.withIdentityToken(identityToken) { client -> client.revokeCurrentInstallation() }
        }
    }

    override fun revokeFamily(clientID: String, operationID: String, identityToken: String, promise: Promise) {
        operate(clientID, operationID, promise) { context ->
            context.withIdentityToken(identityToken) { client -> client.revokeCurrentInstallationFamily() }
        }
    }

    override fun revokeFamilyWithComponents(
        clientID: String,
        operationID: String,
        identityToken: String,
        componentsJSON: String,
        promise: Promise,
    ) {
        operate(clientID, operationID, promise) {
            throw LatchwayException(
                code = LatchwayErrorCode.ATTESTATION_UNSUPPORTED,
                safeMessage = "Descriptor-bound iOS family retirement is not supported by this Android SDK",
            )
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
        promise: Promise,
        action: suspend (NativeClientContext) -> T,
    ) {
        val context = clients[clientID]
        if (context == null) {
            promise.reject("invalid_configuration", "Latchway native client is not configured.")
            return
        }
        val key = operationKey(clientID, operationID)
        val job = scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            try {
                promise.resolve(action(context))
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
    private val baseURL: okhttp3.HttpUrl,
) {
    private val operationMutex = Mutex()
    private val responses = ConcurrentHashMap<String, NativeResponse>()
    private val applicationClient = OkHttpClient.Builder()
        .addInterceptor(client.interceptor())
        .addNetworkInterceptor(client.originGuard())
        .authenticator(client.authenticator())
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    suspend fun startRequest(identityToken: String, encoded: String): String =
        withIdentityToken(identityToken) {
            val input = NativeRequestInput.parse(encoded)
            val url = try {
                input.url.toHttpUrl()
            } catch (failure: IllegalArgumentException) {
                throw requestFailure("The request URL is invalid", failure)
            }
            validateTarget(baseURL, url, input.method, input.feature)
            val mediaType = input.headers.firstOrNull { it.first.equals("content-type", ignoreCase = true) }
                ?.second?.toMediaTypeOrNull()
            val body = when {
                input.body != null -> input.body.toRequestBody(mediaType)
                input.method in METHODS_REQUIRING_BODY -> ByteArray(0).toRequestBody(mediaType)
                else -> null
            }
            val request = try {
                val builder = Request.Builder().url(url).method(input.method, body)
                input.headers.forEach { (name, value) -> builder.header(name, value) }
                builder.header("X-Latchway-Feature", input.feature)
                builder.build()
            } catch (failure: IllegalArgumentException) {
                throw requestFailure("The native request is invalid", failure)
            }
            val response = try {
                applicationClient.newCall(request).awaitResponse()
            } catch (failure: IOException) {
                throw LatchwayException(
                    code = LatchwayErrorCode.NETWORK_UNAVAILABLE,
                    retryable = true,
                    safeMessage = "The Latchway data-plane endpoint could not be reached",
                    cause = failure,
                )
            }
            try {
                validateTarget(baseURL, response.request.url, input.method, input.feature)
                if (response.code !in 200..599) throw responseFailure("The native response status is invalid")
            } catch (failure: Throwable) {
                response.close()
                throw failure
            }
            val responseID = "rsp_${UUID.randomUUID()}"
            val handle = NativeResponse(response)
            check(responses.putIfAbsent(responseID, handle) == null)
            try {
                responseMetadata(responseID, response)
            } catch (failure: Throwable) {
                responses.remove(responseID)?.close()
                throw failure
            }
        }

    suspend fun readResponseChunk(responseID: String, maximumBytes: Double): String {
        if (!maximumBytes.isFinite() || maximumBytes % 1.0 != 0.0 || maximumBytes < 1.0 ||
            maximumBytes > MAXIMUM_RESPONSE_CHUNK_BYTES.toDouble()
        ) {
            throw requestFailure("The response chunk limit is invalid")
        }
        val handle = responses[responseID] ?: throw requestFailure("The native response handle is unavailable")
        val bytes = handle.read(maximumBytes.toInt())
        if (bytes == null) {
            responses.remove(responseID, handle)
            handle.close()
            return JSONObject().put("done", true).toString()
        }
        return JSONObject()
            .put("done", false)
            .put("chunk", Base64.encodeToString(bytes, Base64.NO_WRAP))
            .toString()
    }

    fun closeResponse(responseID: String) {
        responses.remove(responseID)?.close()
    }

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

    fun close() {
        responses.values.forEach(NativeResponse::close)
        responses.clear()
        applicationClient.dispatcher.cancelAll()
        applicationClient.connectionPool.evictAll()
        applicationClient.dispatcher.executorService.shutdown()
        client.close()
    }
}

private class NativeResponse(
    private val response: Response,
) {
    private val input = response.body.byteStream()
    private val readMutex = Mutex()
    private val closed = AtomicBoolean(false)

    suspend fun read(maximumBytes: Int): ByteArray? = readMutex.withLock {
        if (closed.get()) return@withLock null
        val cancellation = currentCoroutineContext()[Job]?.invokeOnCompletion { failure ->
            if (failure is CancellationException) close()
        }
        try {
            val buffer = ByteArray(maximumBytes)
            var count: Int
            do {
                count = input.read(buffer)
            } while (count == 0 && !closed.get())
            if (count < 0) null else buffer.copyOf(count)
        } catch (failure: IOException) {
            throw LatchwayException(
                code = LatchwayErrorCode.NETWORK_UNAVAILABLE,
                retryable = true,
                safeMessage = "The Latchway response stream failed",
                cause = failure,
            )
        } finally {
            cancellation?.dispose()
        }
    }

    fun close() {
        if (closed.compareAndSet(false, true)) response.close()
    }
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
            val apple = value.getJSONObject("apple")
            require(value.keys().asSequence().toSet() == NATIVE_CONFIGURATION_KEYS &&
                android.keys().asSequence().toSet().let { keys ->
                    NATIVE_ANDROID_CONFIGURATION_REQUIRED_KEYS.all(keys::contains) &&
                        keys.all(NATIVE_ANDROID_CONFIGURATION_KEYS::contains)
                } &&
                apple.keys().asSequence().toSet().let { keys ->
                    NATIVE_APPLE_CONFIGURATION_REQUIRED_KEYS.all(keys::contains) &&
                        keys.all(NATIVE_APPLE_CONFIGURATION_KEYS::contains)
                }
            ) { "native configuration has unexpected fields" }
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

private data class NativeRequestInput(
    val url: String,
    val method: String,
    val feature: String,
    val headers: List<Pair<String, String>>,
    val body: ByteArray?,
) {
    companion object {
        fun parse(encoded: String): NativeRequestInput = try {
            require(encoded.toByteArray(Charsets.UTF_8).size <= MAXIMUM_NATIVE_REQUEST_BYTES) {
                "native request is too large"
            }
            val value = JSONObject(encoded)
            require(value.keys().asSequence().toSet() == setOf("url", "method", "feature", "headers", "bodyBase64")) {
                "native request has unexpected fields"
            }
            val method = value.getString("method")
            require(METHOD_PATTERN.matches(method) && method !in FORBIDDEN_METHODS) { "request method is invalid" }
            val feature = value.getString("feature")
            require(FEATURE_PATTERN.matches(feature)) { "request feature is invalid" }
            val encodedHeaders = value.getJSONArray("headers")
            require(encodedHeaders.length() <= MAXIMUM_HEADERS) { "request has too many headers" }
            var headerBytes = 0
            val headers = buildList {
                for (index in 0 until encodedHeaders.length()) {
                    val pair = encodedHeaders.getJSONArray(index)
                    require(pair.length() == 2) { "request header is invalid" }
                    val name = pair.getString(0).lowercase()
                    val headerValue = pair.getString(1)
                    require(HEADER_NAME_PATTERN.matches(name) && validHeaderValue(headerValue) &&
                        !isForbiddenCredentialName(name)
                    ) { "request header is invalid" }
                    headerBytes += name.length + headerValue.length
                    require(headerBytes <= MAXIMUM_HEADER_BYTES) { "request headers are too large" }
                    add(name to headerValue)
                }
            }
            val body = value.optNullableString("bodyBase64")?.let { encodedBody ->
                val decoded = Base64.decode(encodedBody, Base64.NO_WRAP)
                require(decoded.size <= MAXIMUM_REQUEST_BODY_BYTES &&
                    Base64.encodeToString(decoded, Base64.NO_WRAP) == encodedBody
                ) { "request body is invalid" }
                decoded
            }
            NativeRequestInput(
                url = value.getString("url"),
                method = method,
                feature = feature,
                headers = headers,
                body = body,
            )
        } catch (failure: LatchwayException) {
            throw failure
        } catch (failure: Exception) {
            throw requestFailure("The native request is invalid", failure)
        }
    }
}

private suspend fun Call.awaitResponse(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (continuation.isActive) continuation.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            if (continuation.isActive) {
                continuation.resume(response)
            } else {
                response.close()
            }
        }
    })
}

private fun responseMetadata(responseID: String, response: Response): String {
    val headers = JSONArray()
    var count = 0
    var size = 0
    for ((name, value) in response.headers) {
        val normalized = name.lowercase()
        if (!safeResponseHeader(normalized)) continue
        if (!validHeaderValue(value)) throw responseFailure("The response header is invalid")
        count += 1
        size += normalized.length + value.length
        if (count > MAXIMUM_HEADERS || size > MAXIMUM_HEADER_BYTES) {
            throw responseFailure("The response headers are too large")
        }
        headers.put(JSONArray().put(normalized).put(value))
    }
    return JSONObject()
        .put("responseID", responseID)
        .put("status", response.code)
        .put("statusText", "")
        .put("headers", headers)
        .toString()
}

private fun validateTarget(
    baseURL: okhttp3.HttpUrl,
    target: okhttp3.HttpUrl,
    method: String,
    feature: String,
) {
    if (target.scheme != baseURL.scheme || target.host != baseURL.host || target.port != baseURL.port ||
        target.username.isNotEmpty() || target.password.isNotEmpty() || target.fragment != null
    ) {
        throw requestFailure("The request destination is not an allowed Latchway data-plane URL")
    }
    val normalizedMethod = method.uppercase(java.util.Locale.US)
    val structured = normalizedMethod == "POST" && target.encodedPath in ALLOWED_DATA_PLANE_PATHS
    val opaquePrefix = "/proxy/$feature/"
    val remaining = target.encodedPath.removePrefix(opaquePrefix)
    val lowerRemaining = remaining.lowercase(java.util.Locale.US)
    val opaque = normalizedMethod in OPAQUE_DATA_PLANE_METHODS && target.query == null &&
        target.encodedPath.startsWith(opaquePrefix) && remaining.length in 1..2_048 &&
        remaining.split('/').all { it.isNotEmpty() && it != "." && it != ".." } &&
        "%2e" !in lowerRemaining && "%2f" !in lowerRemaining && "%5c" !in lowerRemaining &&
        '\\' !in remaining && !remaining.startsWith("http:", ignoreCase = true) &&
        !remaining.startsWith("https:", ignoreCase = true)
    if (!structured && !opaque) {
        throw requestFailure("The request method and path are not allowed by the Latchway client contract")
    }
    if (target.queryParameterNames.any { isForbiddenCredentialName(decodedCredentialName(it)) }) {
        throw requestFailure("Upstream provider credentials must not be supplied in the request URL")
    }
}

private fun decodedCredentialName(value: String): String {
    var decoded = value
    repeat(4) {
        val next = Uri.decode(decoded)
        if (next == decoded) return decoded.lowercase()
        decoded = next
    }
    if (PERCENT_ESCAPE_PATTERN.containsMatchIn(decoded)) return "credential-encoded-name"
    return decoded.lowercase()
}

private fun isForbiddenCredentialName(value: String): Boolean {
    val normalized = value.lowercase()
    if (normalized in FORBIDDEN_REQUEST_HEADERS || normalized in FORBIDDEN_CREDENTIAL_QUERY_NAMES) return true
    val compact = normalized.filter(Char::isLetterOrDigit)
    if (compact in setOf("key", "token", "secret", "bearer", "cookie", "password", "passwd")) return true
    return FORBIDDEN_CREDENTIAL_NAME_FRAGMENTS.any(compact::contains)
}

private fun safeResponseHeader(name: String): Boolean =
    name in SAFE_RESPONSE_HEADERS || name.startsWith("x-ratelimit-") || name.startsWith("ratelimit-")

private fun validHeaderValue(value: String): Boolean =
    value.length <= MAXIMUM_HEADER_VALUE_BYTES && value.none { character ->
        character.code in 0x00..0x08 || character.code in 0x0a..0x1f || character.code == 0x7f
    }

private fun requestFailure(message: String, cause: Throwable? = null): LatchwayException = LatchwayException(
    code = LatchwayErrorCode.REQUEST_INVALID,
    safeMessage = message,
    cause = cause,
)

private fun responseFailure(message: String): LatchwayException = LatchwayException(
    code = LatchwayErrorCode.RESPONSE_INVALID,
    safeMessage = message,
)

private const val MAXIMUM_REQUEST_BODY_BYTES: Int = 8 * 1024 * 1024
private const val MAXIMUM_NATIVE_REQUEST_BYTES: Int = 12 * 1024 * 1024
private const val MAXIMUM_RESPONSE_CHUNK_BYTES: Int = 32 * 1024
private const val MAXIMUM_HEADERS: Int = 128
private const val MAXIMUM_HEADER_BYTES: Int = 128 * 1024
private const val MAXIMUM_HEADER_VALUE_BYTES: Int = 8 * 1024

private val NATIVE_CONFIGURATION_KEYS = setOf(
    "baseURL", "applicationID", "environment", "identityProvider", "appVersion", "sdkVersion",
    "contractVersion", "protocolVersion", "allowInsecureLoopback", "apple", "android",
)
private val NATIVE_ANDROID_CONFIGURATION_REQUIRED_KEYS = setOf("keyPolicy")
private val NATIVE_ANDROID_CONFIGURATION_KEYS = NATIVE_ANDROID_CONFIGURATION_REQUIRED_KEYS +
    setOf("playIntegrityCloudProjectNumber")
private val NATIVE_APPLE_CONFIGURATION_REQUIRED_KEYS = setOf("appAttestEnabled", "softwareKeyFallbackPolicy")
private val NATIVE_APPLE_CONFIGURATION_KEYS = NATIVE_APPLE_CONFIGURATION_REQUIRED_KEYS + setOf(
    "storageNamespace", "rootKeychainAccessGroup", "legacySharedKeychainAccessGroups",
)

private val METHOD_PATTERN = Regex("^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$")
private val FEATURE_PATTERN = Regex("^[a-z][a-z0-9_-]{0,62}$")
private val HEADER_NAME_PATTERN = Regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")
private val PERCENT_ESCAPE_PATTERN = Regex("%[0-9A-Fa-f]{2}")
private val METHODS_REQUIRING_BODY = setOf("POST", "PUT", "PATCH", "PROPPATCH", "REPORT")
private val FORBIDDEN_METHODS = setOf("CONNECT", "TRACE", "TRACK")
private val ALLOWED_DATA_PLANE_PATHS = setOf(
    "/v1/responses",
    "/v1/chat/completions",
    "/v1/embeddings",
    "/v1/messages",
)
private val OPAQUE_DATA_PLANE_METHODS = setOf("GET", "POST", "PUT", "PATCH", "DELETE")
private val FORBIDDEN_REQUEST_HEADERS = setOf(
    "authorization", "proxy-authorization", "api-key", "api_key", "apikey", "x-api-key",
    "openai-api-key", "openai_api_key", "x-openai-api-key", "anthropic-api-key", "anthropic_api_key",
    "x-goog-api-key", "x-goog_api_key", "access_token", "auth_token", "x-auth-token", "cookie", "connection",
    "content-length", "expect", "host", "key", "proxy-connection", "te", "trailer", "transfer-encoding",
    "token", "upgrade", "x-amz-credential", "x-amz-security-token", "x-amz-signature", "x-goog-credential",
    "x-goog-signature", "dpop", "dpop-nonce", "x-latchway-feature", "x-latchway-framework",
    "x-latchway-framework-version", "x-latchway-protocol-version", "x-latchway-request-id", "x-latchway-sdk",
    "x-latchway-sdk-version",
)
private val FORBIDDEN_CREDENTIAL_QUERY_NAMES = FORBIDDEN_REQUEST_HEADERS + setOf(
    "refresh_token", "identity_token", "private_key", "client_data_hash", "request_hash", "integrity_token",
)
private val FORBIDDEN_CREDENTIAL_NAME_FRAGMENTS = setOf(
    "authorization", "dpop", "apikey", "accesstoken", "authtoken", "refreshtoken", "identitytoken",
    "integritytoken", "sessiontoken", "privatekey", "clientsecret", "credential", "attestationevidence",
    "clientdatahash", "requesthash", "xamzsignature", "xgoogsignature",
)
private val SAFE_RESPONSE_HEADERS = setOf(
    "accept-ranges", "age", "cache-control", "content-encoding", "content-language", "content-length",
    "content-range", "content-type", "date", "etag", "expires", "last-modified", "request-id", "retry-after",
    "server-timing", "vary", "x-request-id", "x-latchway-request-id", "x-latchway-server-version",
    "x-latchway-operation-id",
)

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
            message = safeNativeErrorMessage(code)
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

private fun safeNativeErrorMessage(code: String): String = when (code) {
    "request_invalid" -> "The native Latchway request is invalid."
    "configuration_invalid" -> "Latchway native configuration is invalid."
    "network_unavailable" -> "The Latchway native transport is unavailable."
    "response_invalid" -> "Latchway returned an invalid native response."
    "operation_indeterminate" -> "The Latchway operation outcome must be reconciled."
    else -> "The Latchway gateway rejected the request."
}
