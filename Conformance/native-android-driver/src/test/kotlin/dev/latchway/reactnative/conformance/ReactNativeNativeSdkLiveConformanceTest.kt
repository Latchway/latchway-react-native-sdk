package dev.latchway.reactnative.conformance

import dev.latchway.core.AttestationChallenge
import dev.latchway.core.AttestationEvidence
import dev.latchway.core.AttestationProvider
import dev.latchway.core.CoreConfiguration
import dev.latchway.core.IdentityTokenProvider
import dev.latchway.core.InstallationMetadata
import dev.latchway.core.KeyBacking
import dev.latchway.core.KeyDiagnostics
import dev.latchway.core.LATCHWAY_CONTRACT_VERSION
import dev.latchway.core.LATCHWAY_PROTOCOL_VERSION
import dev.latchway.core.LatchwayClientPlatform
import dev.latchway.core.LatchwayCoreClient
import dev.latchway.core.LatchwayFramework
import dev.latchway.core.PublicJwk
import dev.latchway.core.ResettableInstallationSigner
import dev.latchway.core.SessionSnapshot
import dev.latchway.core.SessionStateStore
import dev.latchway.okhttp.OkHttpLatchwayTransport
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import java.net.URI
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermission
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.util.Base64
import java.util.EnumSet
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Ordinary PR coverage for the native half of the React Native package.
 *
 * This deliberately uses the published Android SDK API from exact, locally
 * rebuilt AARs. It does not claim to execute a TurboModule or physical Play
 * Integrity: those remain protected device gates.
 */
public class ReactNativeNativeSdkLiveConformanceTest {
    @Test
    public fun exactLocallyPublishedAndroidSdkDrivesReactNativeDebugSession(): Unit = runBlocking {
        assertEquals("1", requiredEnvironment("LATCHWAY_RN_PACKAGE_BRIDGE_VERIFIED"))
        val baseUrl = requiredEnvironment("LATCHWAY_DEVELOP_BASE_URL")
        val applicationId = requiredEnvironment("LATCHWAY_DEVELOP_APPLICATION_ID")
        val environment = requiredEnvironment("LATCHWAY_DEVELOP_ENVIRONMENT")
        val feature = requiredEnvironment("LATCHWAY_DEVELOP_FEATURE")
        val model = requiredEnvironment("LATCHWAY_DEVELOP_MODEL")
        val identityTokenUrl = requiredEnvironment("LATCHWAY_DEVELOP_IDENTITY_TOKEN_URL")
        val attestationEvidenceUrl = requiredEnvironment("LATCHWAY_DEVELOP_ATTESTATION_EVIDENCE_URL")
        val output = Path.of(requiredEnvironment("LATCHWAY_SDK_CONFORMANCE_OUTPUT"))
        val androidSourceCommit = requiredEnvironment("LATCHWAY_ANDROID_SOURCE_COMMIT")
        val androidSourceState = requiredEnvironment("LATCHWAY_ANDROID_SOURCE_STATE")
        val coreAarSha256 = requiredEnvironment("LATCHWAY_ANDROID_CORE_AAR_SHA256")
        val okHttpAarSha256 = requiredEnvironment("LATCHWAY_ANDROID_OKHTTP_AAR_SHA256")

        val gatewayUri = requireCanonicalLoopbackOrigin(baseUrl)
        assertEquals("$baseUrl/development/v1/identity-token", identityTokenUrl)
        assertEquals("$baseUrl/development/v1/attestation-evidence", attestationEvidenceUrl)
        assertTrue(androidSourceCommit.matches(Regex("^[0-9a-f]{40}$")))
        assertTrue(androidSourceState in setOf("exact_clean_locked", "candidate_dirty_worktree"))
        val coordinateOrigin = when (androidSourceState) {
            "exact_clean_locked" -> "exact_source_built_local_maven_publication"
            else -> "candidate_worktree_built_local_maven_publication"
        }
        assertTrue(coreAarSha256.matches(Regex("^[0-9a-f]{64}$")))
        assertTrue(okHttpAarSha256.matches(Regex("^[0-9a-f]{64}$")))

        val httpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
        val signer = DeterministicSoftwareSigner()
        val stateStore = InMemorySessionStateStore()
        val identityProvider = LiveIdentityTokenProvider(httpClient, identityTokenUrl)
        val attestationProvider = LiveDebugAttestationProvider(
            client = httpClient,
            helperUrl = attestationEvidenceUrl,
            applicationId = applicationId,
            environment = environment,
            dpopJkt = signer.publicJwk.thumbprint(),
        )
        val framework = LatchwayFramework("react-native-fetch", "1.0.0")
        val core = LatchwayCoreClient.create(
            configuration = CoreConfiguration(
                baseUrl = gatewayUri.resolve("/"),
                applicationId = applicationId,
                environment = environment,
                identityProvider = "mock_oidc",
                clientPlatform = LatchwayClientPlatform.REACT_NATIVE_ANDROID,
                sdkVersion = "1.0.0",
                framework = framework,
                allowInsecureLoopback = true,
            ),
            identityTokenProvider = identityProvider,
            attestationProvider = attestationProvider,
            signer = signer,
            stateStore = stateStore,
            transport = OkHttpLatchwayTransport(httpClient),
            installationMetadata = InstallationMetadata(
                appVersion = "1.0.0-pr-conformance",
                osVersion = "ordinary-pr-jvm",
                deviceModel = "ci-software-signer",
            ),
        )

        try {
            // The first SDK call establishes the signed debug-attested session.
            // Reading quota before and after the one data-plane request makes
            // the request accounting assertion deterministic.
            val quotaBefore = core.quota(feature)
            val requestLimitBefore = quotaBefore.limits.single { it.metric == "logical_requests" }
            val firstDiagnostics = core.diagnostics()
            val firstState = requireNotNull(stateStore.load())
            assertEquals("react_native_android", firstState.installation.platform)
            assertEquals(signer.publicJwk.thumbprint(), firstState.installation.dpopJkt)
            assertEquals("active", firstDiagnostics.installationStatus)
            assertEquals(LATCHWAY_CONTRACT_VERSION, firstDiagnostics.contractVersion)
            assertEquals(LATCHWAY_PROTOCOL_VERSION, firstDiagnostics.protocolVersion)
            assertEquals("debug", firstDiagnostics.trustProvider)
            assertEquals("debug", firstDiagnostics.trustLevel)
            assertTrue(firstDiagnostics.refreshAvailable)
            assertEquals(1, identityProvider.calls.get())
            assertEquals(1, attestationProvider.calls.get())
            val refreshTokenBefore = sha256(firstState.refreshToken.reveal())

            val requestUri = URI.create("$baseUrl/v1/responses")
            val requestBody = JSONObject()
                .put("model", model)
                .put("input", "One deterministic React Native PR conformance request.")
                .put("max_output_tokens", 16)
                .toString()
            val authorization = core.authorize("POST", requestUri, feature)
            assertTrue(authorization.authorizationHeader().startsWith("DPoP "))
            assertEquals(2, authorization.dpopHeader().count { it == '.' })
            val request = Request.Builder()
                .url(requestUri.toURL())
                .header("Accept", "application/json")
                .header("Authorization", authorization.authorizationHeader())
                .header("DPoP", authorization.dpopHeader())
                .header("X-Latchway-Protocol-Version", LATCHWAY_PROTOCOL_VERSION.toString())
                .header("X-Latchway-SDK", "react-native")
                .header("X-Latchway-SDK-Version", "1.0.0")
                .header("X-Latchway-Framework", framework.id)
                .header("X-Latchway-Framework-Version", framework.version)
                .header("X-Latchway-Request-ID", authorization.requestId)
                .header("X-Latchway-Feature", feature)
                .post(requestBody.toByteArray(StandardCharsets.UTF_8).toRequestBody(JSON_MEDIA_TYPE))
                .build()
            val proxied = httpClient.executeJson(request, 200)
            val responseRequestId = proxied.requestId
            assertEquals("resp_mock_0001", proxied.document.getString("id"))
            assertEquals("latchway-mock-model", proxied.document.getString("model"))
            assertEquals("completed", proxied.document.getString("status"))
            val outputText = proxied.document.getJSONArray("output")
                .getJSONObject(0)
                .getJSONArray("content")
                .getJSONObject(0)
            assertEquals("output_text", outputText.getString("type"))
            assertEquals("Deterministic mock response.", outputText.getString("text"))
            val usage = proxied.document.getJSONObject("usage")
            assertEquals(11L, usage.getLong("input_tokens"))
            assertEquals(7L, usage.getLong("output_tokens"))
            assertEquals(18L, usage.getLong("total_tokens"))
            assertNotNull(responseRequestId)
            assertTrue(requireNotNull(responseRequestId).length >= 8)

            val quota = core.quota(feature)
            assertEquals(feature, quota.feature)
            assertTrue(quota.limits.isNotEmpty())
            assertTrue(quota.limits.all { it.metric.isNotBlank() && it.hard })
            val requestLimit = quota.limits.single { it.metric == "logical_requests" }
            assertEquals(requireNotNull(requestLimitBefore.used) + 1, requestLimit.used)
            assertEquals(requireNotNull(requestLimitBefore.remaining) - 1, requestLimit.remaining)

            core.refresh()
            val refreshedDiagnostics = core.diagnostics()
            val refreshedState = requireNotNull(stateStore.load())
            assertEquals(firstState.installation.id, refreshedState.installation.id)
            assertEquals(firstDiagnostics.installationId, refreshedDiagnostics.installationId)
            assertTrue(refreshTokenBefore != sha256(refreshedState.refreshToken.reveal()))
            assertTrue(refreshedDiagnostics.refreshAvailable)
            assertEquals(1, attestationProvider.calls.get())

            val report = JSONObject()
                .put("schema_version", 1)
                .put("kind", "latchway_sdk_live_debug_conformance")
                .put("sdk_kind", "react_native")
                .put("status", "passed")
                .put("physical_attestation_claimed", false)
                .put("checks", JSONObject()
                    .put("debug_attestation", attestationProvider.calls.get() == 1)
                    .put("dpop_session", refreshedState.installation.platform == "react_native_android" &&
                        refreshedState.installation.dpopJkt == signer.publicJwk.thumbprint())
                    .put("proxied_mock_request", true)
                    .put("quota", quota.limits.isNotEmpty())
                    .put("session_refresh", refreshedDiagnostics.installationId == firstDiagnostics.installationId))
                .put("execution_boundary", JSONObject()
                    .put("package_bridge_contract", true)
                    .put("native_android_sdk_live", true)
                    .put("native_ios_sdk_live", false)
                    .put("react_native_turbomodule_end_to_end", false)
                    .put("physical_play_integrity", false)
                    .put("physical_app_attest", false)
                    .put("native_driver_surface", "LatchwayCoreClient + OkHttpLatchwayTransport public APIs")
                    .put("limitation", "Ordinary PR CI proves the package boundary and Android SDK public API. It does not execute either TurboModule host, the native iOS SDK, physical Play Integrity, or physical App Attest; protected device gates own those hops."))
                .put("native_dependency", JSONObject()
                    .put("group", "dev.latchway")
                    .put("version", "1.0.0")
                    .put("source_commit", androidSourceCommit)
                    .put("source_state", androidSourceState)
                    .put("coordinate_origin", coordinateOrigin)
                    .put("core_aar_sha256", coreAarSha256)
                    .put("okhttp_aar_sha256", okHttpAarSha256))
                .put("observations", JSONObject()
                    .put("platform", refreshedState.installation.platform)
                    .put("trust_provider", refreshedDiagnostics.trustProvider)
                    .put("contract_version", LATCHWAY_CONTRACT_VERSION)
                    .put("protocol_version", LATCHWAY_PROTOCOL_VERSION)
                    .put("response_request_id", responseRequestId)
                    .put("quota_limit_count", quota.limits.size)
                    .put("logical_requests_delta", 1))
            writePrivateJson(output, report)
        } finally {
            core.close()
            httpClient.dispatcher.cancelAll()
            httpClient.connectionPool.evictAll()
            httpClient.dispatcher.executorService.shutdown()
        }
    }

}

private val JSON_MEDIA_TYPE = "application/json".toMediaType()
private val HELPER_JSON_MEDIA_TYPE = "application/json".toMediaType()

private class LiveIdentityTokenProvider(
    private val client: OkHttpClient,
    private val helperUrl: String,
) : IdentityTokenProvider {
    val calls: AtomicInteger = AtomicInteger(0)

    override suspend fun identityToken(): String {
        calls.incrementAndGet()
        val response = client.executeJson(
            Request.Builder().url(helperUrl).get().build(),
            expectedStatus = 200,
        ).document
        require(response.length() == 1 && response.has("identity_token")) {
            "The development identity helper returned an invalid document"
        }
        return response.getString("identity_token").also {
            require(it.length >= 64) { "The development identity helper returned an invalid token" }
        }
    }

    override fun toString(): String = "LiveIdentityTokenProvider(token=[REDACTED])"
}

private class LiveDebugAttestationProvider(
    private val client: OkHttpClient,
    private val helperUrl: String,
    private val applicationId: String,
    private val environment: String,
    private val dpopJkt: String,
) : AttestationProvider {
    val calls: AtomicInteger = AtomicInteger(0)

    override suspend fun warmUp(): Unit = Unit

    override suspend fun attest(challenge: AttestationChallenge): AttestationEvidence {
        require(challenge.provider == "debug")
        calls.incrementAndGet()
        val body = JSONObject()
            .put("challenge_id", challenge.challengeId)
            .put("binding_hash", challenge.clientDataHash)
            .put("application_id", applicationId)
            .put("environment", environment)
            .put("dpop_jkt", dpopJkt)
            .put("platform", "react_native_android")
            .toString()
            .toByteArray(StandardCharsets.UTF_8)
            .toRequestBody(HELPER_JSON_MEDIA_TYPE)
        val response = client.executeJson(
            Request.Builder().url(helperUrl).post(body).build(),
            expectedStatus = 200,
        ).document
        val responseKeys = buildSet {
            val iterator = response.keys()
            while (iterator.hasNext()) add(iterator.next())
        }
        require(responseKeys == setOf("key_id", "binding_hash", "expires_at", "signature")) {
            "The development attestation helper returned unexpected fields"
        }
        require(response.getString("binding_hash") == challenge.clientDataHash) {
            "The development attestation helper returned a mismatched binding"
        }
        return AttestationEvidence(
            provider = "debug",
            evidence = mapOf(
                "key_id" to response.getString("key_id"),
                "binding_hash" to response.getString("binding_hash"),
                "expires_at" to response.getLong("expires_at"),
                "signature" to response.getString("signature"),
            ),
        )
    }

    override fun toString(): String = "LiveDebugAttestationProvider(evidence=[REDACTED])"
}

private class InMemorySessionStateStore : SessionStateStore {
    private val mutex = Mutex()
    private var snapshot: SessionSnapshot? = null

    override suspend fun load(): SessionSnapshot? = mutex.withLock { snapshot }

    override suspend fun save(snapshot: SessionSnapshot): Unit = mutex.withLock {
        this.snapshot = snapshot
    }

    override suspend fun clear(): Unit = mutex.withLock {
        snapshot = null
    }
}

/** Fixed contract-vector key; software-only and confined to the ordinary PR test source set. */
private class DeterministicSoftwareSigner : ResettableInstallationSigner {
    override val publicJwk: PublicJwk = PublicJwk(
        x = "Cq0dYDxoGL4oLYM_cwDclqKoVgkU5OeuoXo_L4Z418s",
        y = "N5wrFgi5unJsGvU57MC-o4Iv5VHL-V6Sl9_2AcOS6cI",
    )
    override val diagnostics: KeyDiagnostics = KeyDiagnostics(
        backing = KeyBacking.SOFTWARE,
        strongBoxRequested = false,
        strongBoxUnavailable = false,
        publicJwkThumbprint = publicJwk.thumbprint(),
    )
    private val invalidated = AtomicBoolean(false)
    private val privateKey: PrivateKey = KeyFactory.getInstance("EC").generatePrivate(
        ECPrivateKeySpec(
            BigInteger(1, Base64.getUrlDecoder().decode("2ZFd1bc5bCB8zu8OEf5l7O9x_SxbsQNQMNn0si4NxxI")),
            p256Parameters(),
        ),
    )

    override suspend fun sign(signingInput: ByteArray): ByteArray {
        check(!invalidated.get()) { "The CI-only installation key was reset" }
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(privateKey)
        signer.update(signingInput)
        return derToJose(signer.sign())
    }

    override suspend fun isCurrent(): Boolean = !invalidated.get()

    override suspend fun reset() {
        invalidated.set(true)
    }

    override fun toString(): String = "DeterministicSoftwareSigner(privateKey=[REDACTED])"
}

private data class JsonHttpResponse(
    val document: JSONObject,
    val requestId: String?,
)

private fun OkHttpClient.executeJson(request: Request, expectedStatus: Int): JsonHttpResponse =
    newCall(request).execute().use { response ->
        require(response.code == expectedStatus) {
            "Conformance request failed with HTTP ${response.code}"
        }
        val bytes = response.body.bytes()
        require(bytes.isNotEmpty() && bytes.size <= 131_072) {
            "Conformance response exceeded its bounded JSON envelope"
        }
        JsonHttpResponse(
            document = JSONObject(String(bytes, StandardCharsets.UTF_8)),
            requestId = response.header("X-Latchway-Request-ID"),
        )
    }

private fun requiredEnvironment(name: String): String =
    requireNotNull(System.getenv(name)) { "$name is required" }.also {
        require(it.isNotEmpty() && it.trim() == it) { "$name is invalid" }
    }

private fun requireCanonicalLoopbackOrigin(raw: String): URI {
    val parsed = URI(raw)
    require(
        parsed.scheme == "http" && parsed.host == "127.0.0.1" &&
            parsed.port in 1..65_535 && parsed.userInfo == null && parsed.query == null &&
            parsed.fragment == null && parsed.rawPath.isNullOrEmpty() &&
            raw == "http://127.0.0.1:${parsed.port}",
    ) { "LATCHWAY_DEVELOP_BASE_URL must be an exact IPv4 loopback HTTP origin" }
    return parsed
}

private fun sha256(value: String): String =
    MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(StandardCharsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }

private fun writePrivateJson(path: Path, document: JSONObject) {
    Files.createDirectories(requireNotNull(path.parent))
    Files.writeString(
        path,
        document.toString(2) + "\n",
        StandardCharsets.UTF_8,
        StandardOpenOption.CREATE,
        StandardOpenOption.TRUNCATE_EXISTING,
        StandardOpenOption.WRITE,
    )
    Files.setPosixFilePermissions(
        path,
        EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE),
    )
}

private fun p256Parameters(): ECParameterSpec {
    val parameters = AlgorithmParameters.getInstance("EC")
    parameters.init(ECGenParameterSpec("secp256r1"))
    return parameters.getParameterSpec(ECParameterSpec::class.java)
}

private fun derToJose(der: ByteArray): ByteArray {
    var index = 0
    fun nextByte(): Int = der[index++].toInt() and 0xff
    fun length(): Int {
        val first = nextByte()
        if (first < 128) return first
        var value = 0
        repeat(first and 0x7f) { value = value shl 8 or nextByte() }
        return value
    }
    require(nextByte() == 0x30)
    require(length() == der.size - index)
    fun integer(): ByteArray {
        require(nextByte() == 0x02)
        val integerLength = length()
        val value = der.copyOfRange(index, index + integerLength)
        index += integerLength
        val unsigned = if (value.size == 33 && value[0].toInt() == 0) value.copyOfRange(1, 33) else value
        require(unsigned.size <= 32)
        return unsigned
    }
    val r = integer()
    val s = integer()
    require(index == der.size)
    return ByteArray(64).also {
        r.copyInto(it, 32 - r.size)
        s.copyInto(it, 64 - s.size)
    }
}
