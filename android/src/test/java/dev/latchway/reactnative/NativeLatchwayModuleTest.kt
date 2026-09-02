package dev.latchway.reactnative

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import dev.latchway.core.LATCHWAY_CONTRACT_VERSION
import dev.latchway.core.LATCHWAY_PROTOCOL_VERSION
import dev.latchway.core.LatchwayErrorCode
import dev.latchway.core.LatchwayException
import dev.latchway.okhttp.LATCHWAY_REACT_NATIVE_FRAMEWORK_ID
import dev.latchway.okhttp.LATCHWAY_REACT_NATIVE_FRAMEWORK_VERSION
import okhttp3.Authenticator
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import okio.Buffer
import java.lang.reflect.Proxy
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [35])
public class NativeLatchwayModuleTest {
    private val fixtures = mutableListOf<ModuleFixture>()

    @After
    public fun closeFixtures() {
        fixtures.reversed().forEach(ModuleFixture::close)
        fixtures.clear()
    }

    @Test
    public fun fwAuth101And102GeneratedSpecForwardsBootstrapAndDpopDispatchToNativeSdk() {
        // FW-AUTH-101 / FW-AUTH-102: this is compiled bridge evidence. Pair it
        // with the exact-AAR session/DPoP tests for the native cryptography.
        val fake = FakeNativeClientOperations()
        val fixture = configuredFixture(fake)

        val response = fixture.startRequest(
            identityToken = "external-identity-bootstrap",
            requestJSON = nativeRequest(fixture.baseURL, "bootstrap through generated spec"),
        )
        val metadata = JSONObject(response.resolvedString())

        assertEquals(200, metadata.getInt("status"))
        assertEquals(1, fake.bootstrapCalls.get())
        assertEquals(listOf("external-identity-bootstrap"), fake.networkIdentityTokens)
        assertEquals(1, fake.protectedRequests.size)
        val protected = fake.protectedRequests.single()
        assertTrue(protected.header("Authorization")?.startsWith("DPoP ") == true)
        assertEquals(2, protected.header("DPoP")?.count { it == '.' })
        val protectedBody = Buffer()
        requireNotNull(protected.body).writeTo(protectedBody)
        assertEquals("bootstrap through generated spec", protectedBody.readUtf8())
        assertTokenCleared(fake)
        fixture.closeResponse(metadata.getString("responseID")).assertResolved()
    }

    @Test
    public fun fwAuth103AndBeh104OneGeneratedSpecCallKeepsSafeRetryAndFreshProofNative() {
        // FW-AUTH-103 / FW-BEH-104: the compiled TurboModule boundary owns one
        // operation while OkHttp performs both attempts. Pair with the exact
        // Android AAR proof test to establish real DPoP generation.
        MockWebServer().use { server ->
            server.enqueue(MockResponse()
                .setResponseCode(401)
                .setHeader("WWW-Authenticate", "DPoP error=\"use_dpop_nonce\", dpop_nonce=\"nonce-2\"")
                .setBody("{}"))
            server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
            server.start()

            val proofSequence = AtomicInteger()
            val nativeRefreshes = AtomicInteger()
            val identities = CopyOnWriteArrayList<String>()
            val fake = FakeNativeClientOperations { operations ->
                val authorization = "DPoP native-access-token"
                nativeApplicationClientBuilder()
                    .addInterceptor { chain ->
                        identities += operations.currentIdentity()
                        val request = chain.request().newBuilder()
                            .header("Authorization", authorization)
                            .header("DPoP", semanticProof(proofSequence.incrementAndGet()))
                            .build()
                        chain.proceed(request)
                    }
                    .authenticator(Authenticator { _, response ->
                        identities += operations.currentIdentity()
                        nativeRefreshes.incrementAndGet()
                        response.request.newBuilder()
                            .header("Authorization", authorization)
                            .header("DPoP", semanticProof(proofSequence.incrementAndGet()))
                            .build()
                    })
                    .build()
            }
            val fixture = configuredFixture(fake, server.url("/").toString().removeSuffix("/"))

            val response = fixture.startRequest(
                identityToken = "external-identity-for-native-retry",
                requestJSON = nativeRequest(fixture.baseURL, "one replayable body"),
            )
            val metadata = JSONObject(response.resolvedString())
            val first = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            val second = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))

            assertEquals(200, metadata.getInt("status"))
            assertEquals(1, nativeRefreshes.get())
            assertEquals(2, server.requestCount)
            assertEquals(first.body.readUtf8(), second.body.readUtf8())
            assertEquals(first.headers["Authorization"], second.headers["Authorization"])
            assertNotEquals(first.headers["DPoP"], second.headers["DPoP"])
            assertEquals(
                listOf("external-identity-for-native-retry", "external-identity-for-native-retry"),
                identities,
            )
            assertTokenCleared(fake)
            fixture.closeResponse(metadata.getString("responseID")).assertResolved()
        }
    }

    @Test
    public fun fwAuth104GeneratedSpecClearsRejectedIdentityBeforeReauthentication() {
        // FW-AUTH-104
        val fake = FakeNativeClientOperations()
        fake.refreshFailures += LatchwayException(
            code = LatchwayErrorCode.IDENTITY_REAUTHENTICATION_REQUIRED,
            safeMessage = "synthetic native reauthentication request",
        )
        val fixture = configuredFixture(fake)

        val rejected = fixture.refresh("external-identity-stale")
        assertEquals("identity_reauthentication_required", rejected.rejection().code)
        assertTokenCleared(fake)

        fixture.refresh("external-identity-fresh").assertResolved()
        assertEquals(
            listOf("external-identity-stale", "external-identity-fresh"),
            fake.refreshIdentityTokens,
        )
        assertTokenCleared(fake)
    }

    @Test
    public fun fwAuth105GeneratedSpecDelegatesFamilyRetirementAndSurfacesTerminalState() {
        // FW-AUTH-105: terminal-state enforcement is implemented by the exact
        // native SDK; this compiled test proves the generated bridge forwards it.
        val fake = FakeNativeClientOperations()
        val fixture = configuredFixture(fake)

        fixture.revokeFamily("external-identity-family-owner").assertResolved()
        assertEquals(1, fake.familyRevocations.get())
        assertTokenCleared(fake)

        val rejected = fixture.quota("external-identity-after-family-retirement")
        assertEquals("installation_family_revoked", rejected.rejection().code)
        assertTrue(fake.protectedRequests.isEmpty())
        assertTokenCleared(fake)
    }

    @Test
    public fun fwAuth106GeneratedSpecSurfacesNativeComponentRevocationWithoutDispatch() {
        // FW-AUTH-106: the Android SDK owns component state. The React Native
        // TurboModule must preserve its closed terminal failure unchanged.
        val fake = FakeNativeClientOperations().apply { componentRevoked = true }
        val fixture = configuredFixture(fake)

        val rejected = fixture.quota("external-identity-component-owner")

        assertEquals("component_revoked", rejected.rejection().code)
        assertTrue(fake.protectedRequests.isEmpty())
        assertTokenCleared(fake)
    }

    @Test
    public fun fwSec103ProductionResponseTargetRevalidationRejectsCrossOriginRedirectResult() {
        // FW-SEC-103
        val fake = FakeNativeClientOperations { operations ->
            nativeApplicationClientBuilder()
                .addInterceptor { chain ->
                    operations.redirectResponseAttempts.incrementAndGet()
                    val redirected = chain.request().newBuilder()
                        .url("https://redirect-attacker.invalid/v1/responses")
                        .build()
                    Response.Builder()
                        .request(redirected)
                        .protocol(Protocol.HTTP_1_1)
                        .code(200)
                        .message("OK")
                        .body("{}".toResponseBody(JSON_MEDIA_TYPE))
                        .build()
                }
                .build()
        }
        val fixture = configuredFixture(fake)
        val policyClient = nativeApplicationClientBuilder().build()
        try {
            assertFalse(policyClient.followRedirects)
            assertFalse(policyClient.followSslRedirects)
        } finally {
            policyClient.closeCompletely()
        }

        val rejected = fixture.startRequest(
            identityToken = "external-identity-redirect-check",
            requestJSON = nativeRequest(fixture.baseURL, "redirect must be revalidated"),
        )

        assertEquals("request_invalid", rejected.rejection().code)
        assertEquals(1, fake.redirectResponseAttempts.get())
        assertTokenCleared(fake)
    }

    private fun configuredFixture(
        fake: FakeNativeClientOperations,
        baseURL: String = "https://gateway.example.test",
    ): ModuleFixture {
        val reactContext: ReactApplicationContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        val factory = NativeClientFactory { configuration, _, _, tokenProvider, _ ->
            fake.configuration = configuration
            fake.tokenProvider = tokenProvider
            fake
        }
        val module = NativeLatchwayModule(reactContext, factory) { JavaOnlyMap() }
        val fixture = ModuleFixture(module, fake, baseURL)
        fixtures += fixture

        val configured = fixture.configure()
        val compatibility = JSONObject(configured.resolvedString())
        assertEquals("react_native_android", compatibility.getString("platform"))
        assertEquals(LATCHWAY_CONTRACT_VERSION, compatibility.getString("contractVersion"))
        assertEquals(LATCHWAY_PROTOCOL_VERSION, compatibility.getInt("protocolVersion"))
        assertEquals(LATCHWAY_REACT_NATIVE_FRAMEWORK_ID, fake.configuration?.frameworkID)
        assertEquals(LATCHWAY_REACT_NATIVE_FRAMEWORK_VERSION, fake.configuration?.frameworkVersion)
        return fixture
    }

    private fun assertTokenCleared(fake: FakeNativeClientOperations) {
        assertThrows(IllegalStateException::class.java) { fake.currentIdentity() }
    }
}

private class ModuleFixture(
    private val module: NativeLatchwayModule,
    private val operations: FakeNativeClientOperations,
    val baseURL: String,
) {
    private val operationSequence = AtomicInteger()
    private var closed = false

    fun configure(): RecordingPromise = RecordingPromise().also { promise ->
        module.configure(CLIENT_ID, nativeConfiguration(baseURL), promise.value)
        promise.await()
    }

    fun startRequest(identityToken: String, requestJSON: String): RecordingPromise =
        RecordingPromise().also { promise ->
            module.startRequest(
                CLIENT_ID,
                operationID("request"),
                identityToken,
                requestJSON,
                promise.value,
            )
            promise.await()
        }

    fun refresh(identityToken: String): RecordingPromise = RecordingPromise().also { promise ->
        module.refresh(CLIENT_ID, operationID("refresh"), identityToken, promise.value)
        promise.await()
    }

    fun revokeFamily(identityToken: String): RecordingPromise = RecordingPromise().also { promise ->
        module.revokeFamily(CLIENT_ID, operationID("family"), identityToken, promise.value)
        promise.await()
    }

    fun quota(identityToken: String): RecordingPromise = RecordingPromise().also { promise ->
        module.quota(CLIENT_ID, operationID("quota"), identityToken, "assistant", promise.value)
        promise.await()
    }

    fun closeResponse(responseID: String): RecordingPromise = RecordingPromise().also { promise ->
        module.closeResponse(CLIENT_ID, responseID, promise.value)
        promise.await()
    }

    fun close() {
        if (closed) return
        closed = true
        val disposed = RecordingPromise()
        module.dispose(CLIENT_ID, disposed.value)
        disposed.await()
        module.invalidate()
        if (!operations.closed) operations.close()
    }

    private fun operationID(kind: String): String =
        "rn-android-$kind-${operationSequence.incrementAndGet()}"
}

private class FakeNativeClientOperations(
    createApplicationClient: (FakeNativeClientOperations) -> OkHttpClient = { operations ->
        nativeApplicationClientBuilder()
            .addInterceptor { chain -> operations.defaultDispatch(chain.request()) }
            .build()
    },
) : NativeClientOperations {
    lateinit var tokenProvider: TransientIdentityTokenProvider
    var configuration: NativeConfiguration? = null
    var familyRevoked: Boolean = false
    var componentRevoked: Boolean = false
    var closed: Boolean = false
    val bootstrapCalls = AtomicInteger()
    val familyRevocations = AtomicInteger()
    val redirectResponseAttempts = AtomicInteger()
    val networkIdentityTokens = CopyOnWriteArrayList<String>()
    val refreshIdentityTokens = CopyOnWriteArrayList<String>()
    val protectedRequests = CopyOnWriteArrayList<Request>()
    val refreshFailures = ArrayDeque<Throwable>()

    override val applicationClient: OkHttpClient by lazy { createApplicationClient(this) }

    override suspend fun refresh() {
        refreshIdentityTokens += currentIdentity()
        refreshFailures.pollFirst()?.let { throw it }
    }

    override suspend fun quota(feature: String): String {
        if (familyRevoked) {
            throw LatchwayException(
                code = LatchwayErrorCode.INSTALLATION_FAMILY_REVOKED,
                safeMessage = "synthetic native family terminal state",
            )
        }
        if (componentRevoked) {
            throw LatchwayException(
                code = LatchwayErrorCode.COMPONENT_REVOKED,
                safeMessage = "synthetic native component terminal state",
            )
        }
        return JSONObject()
            .put("feature", feature)
            .put("observed_at", "2026-09-02T00:00:00Z")
            .put("limits", JSONArray())
            .toString()
    }

    override suspend fun diagnostics(): String = JSONObject()
        .put("contractVersion", LATCHWAY_CONTRACT_VERSION)
        .put("protocolVersion", LATCHWAY_PROTOCOL_VERSION)
        .toString()

    override suspend fun revokeCurrentInstallation() = Unit

    override suspend fun revokeCurrentInstallationFamily() {
        currentIdentity()
        familyRevocations.incrementAndGet()
        familyRevoked = true
    }

    fun currentIdentity(): String = tokenProvider.current()

    override fun close() {
        if (closed) return
        closed = true
        applicationClient.closeCompletely()
    }

    private fun defaultDispatch(request: Request): Response {
        if (familyRevoked) {
            throw LatchwayException(
                code = LatchwayErrorCode.INSTALLATION_FAMILY_REVOKED,
                safeMessage = "synthetic native family terminal state",
            )
        }
        if (componentRevoked) {
            throw LatchwayException(
                code = LatchwayErrorCode.COMPONENT_REVOKED,
                safeMessage = "synthetic native component terminal state",
            )
        }
        networkIdentityTokens += currentIdentity()
        bootstrapCalls.compareAndSet(0, 1)
        val protected = request.newBuilder()
            .header("Authorization", "DPoP native-access-token")
            .header("DPoP", semanticProof(protectedRequests.size + 1))
            .build()
        protectedRequests += protected
        return Response.Builder()
            .request(protected)
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
            .body("{}".toResponseBody(JSON_MEDIA_TYPE))
            .build()
    }
}

private class RecordingPromise {
    private val terminal = CountDownLatch(1)
    @Volatile private var resolved: Any? = UNSET
    @Volatile private var rejected: NativeRejection? = null

    val value: Promise = Proxy.newProxyInstance(
        Promise::class.java.classLoader,
        arrayOf(Promise::class.java),
    ) { _, method, arguments ->
        when (method.name) {
            "resolve" -> {
                resolved = arguments?.firstOrNull()
                terminal.countDown()
            }
            "reject" -> {
                val values = arguments.orEmpty()
                rejected = NativeRejection(
                    code = values.firstOrNull() as? String ?: "unspecified",
                    message = values.drop(1).filterIsInstance<String>().firstOrNull(),
                    userInfo = values.filterIsInstance<WritableMap>().firstOrNull(),
                )
                terminal.countDown()
            }
        }
        null
    } as Promise

    fun await(): RecordingPromise {
        assertTrue("native promise did not settle", terminal.await(10, TimeUnit.SECONDS))
        return this
    }

    fun assertResolved() {
        assertNull(rejected)
        assertTrue(resolved !== UNSET)
    }

    fun resolvedString(): String {
        assertResolved()
        return resolved as String
    }

    fun rejection(): NativeRejection {
        assertTrue(resolved === UNSET)
        return requireNotNull(rejected)
    }
}

private data class NativeRejection(
    val code: String,
    val message: String?,
    val userInfo: WritableMap?,
)

private fun nativeConfiguration(baseURL: String): String = JSONObject()
    .put("baseURL", baseURL)
    .put("applicationID", "app_react_native_android_test")
    .put("environment", "development")
    .put("identityProvider", "mock_oidc")
    .put("appVersion", "1.0.0-test")
    .put("sdkVersion", "1.0.0")
    .put("frameworkID", LATCHWAY_REACT_NATIVE_FRAMEWORK_ID)
    .put("frameworkVersion", LATCHWAY_REACT_NATIVE_FRAMEWORK_VERSION)
    .put("contractVersion", LATCHWAY_CONTRACT_VERSION)
    .put("protocolVersion", LATCHWAY_PROTOCOL_VERSION)
    .put("allowInsecureLoopback", baseURL.startsWith("http://127.0.0.1:"))
    .put("apple", JSONObject()
        .put("appAttestEnabled", true)
        .put("softwareKeyFallbackPolicy", "forbidden"))
    .put("android", JSONObject()
        .put("playIntegrityCloudProjectNumber", "123456789")
        .put("keyPolicy", "software_allowed"))
    .toString()

private fun nativeRequest(baseURL: String, body: String): String = JSONObject()
    .put("url", "$baseURL/v1/responses")
    .put("method", "POST")
    .put("feature", "assistant")
    .put("headers", JSONArray().put(JSONArray().put("content-type").put("application/json")))
    .put(
        "bodyBase64",
        Base64.getEncoder().encodeToString(body.toByteArray(StandardCharsets.UTF_8)),
    )
    .toString()

private fun semanticProof(sequence: Int): String =
    "eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.eyJqdGkiOiJqdGktJHNlcXVlbmNlIn0.signature-$sequence"

private fun OkHttpClient.closeCompletely() {
    dispatcher.cancelAll()
    connectionPool.evictAll()
    dispatcher.executorService.shutdown()
}

private val JSON_MEDIA_TYPE = "application/json".toMediaType()
private const val CLIENT_ID = "rn-android-compiled-test-client"
private val UNSET = Any()
