package com.latchwaychat

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.google.firebase.auth.FirebaseAuth
import dev.latchway.core.KeyPolicy
import dev.latchway.core.LatchwayIdentityAuthorityReference
import dev.latchway.firebaseauth.FirebaseIdentityAuthority
import dev.latchway.okhttp.LatchwayApp
import dev.latchway.okhttp.LatchwayAppOptions
import dev.latchway.okhttp.LatchwayAppRegistry
import dev.latchway.okhttp.LatchwayClient
import dev.latchway.okhttp.latchwayFeature
import dev.latchway.playintegrity.PlayIntegrityAttestationProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import okhttp3.Call
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/** Application lifetime owner. No React context, JS auth callback or exported root token. */
private object EmbeddedAccountOwner {
    val auth: FirebaseAuth = FirebaseAuth.getInstance()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val transitions = Mutex()
    lateinit var app: LatchwayApp
    lateinit var config: JSONObject
    var client: LatchwayClient? = null
    var generation: String? = null
    var observedIdentity: String? = null
    var epoch = 0
    var call: Call? = null
    var request: Job? = null

    fun configure(context: Context) {
        if (::app.isInitialized) return
        config = context.assets.open("SharedNativeConfig.json").bufferedReader().use { JSONObject(it.readText()) }
        val project = requireNotNull(auth.app.options.projectId)
        val integrity = config.getString("androidPlayIntegrityProjectNumber").toLong()
        require(integrity > 0)
        app = LatchwayAppRegistry.configure(context.applicationContext,
            LatchwayAppOptions(baseUrl = config.getString("baseURL").toHttpUrl(),
                applicationId = config.getString("applicationID"), environment = config.getString("environment"),
                identity = LatchwayIdentityAuthorityReference("latchway-chat-firebase", "https://securetoken.google.com/$project"),
                keyPolicy = KeyPolicy(preferStrongBox = false, allowSoftwareBacked = false),
                attestationPolicyId = "play-integrity:$integrity", exposeToReactNative = true),
            name = "latchway-chat", authority = FirebaseIdentityAuthority(auth),
            attestationProvider = PlayIntegrityAttestationProvider(context.applicationContext, integrity))
        observedIdentity = identityKey()
        auth.addAuthStateListener {
            // Native identity guards enforce immediately; this observer performs offline cleanup.
            if (identityKey() != observedIdentity) { epoch++; call?.cancel(); request?.cancel() }
            scope.launch { transitions.withLock { runCatching { reconcile() } } }
        }
    }
    private fun identityKey(): String? = auth.currentUser?.let { "${it.tenantId.orEmpty()}:${it.uid}" }
    suspend fun reconcile() {
        val next = identityKey()
        if (next == observedIdentity) return
        retire()
        observedIdentity = next
    }
    suspend fun retire() {
        epoch++; call?.cancel(); request?.cancel()
        val captured = generation ?: app.snapshots.value.generationId
        if (captured != null) app.logout(captured)
        client?.close(); client = null; generation = null
    }
    suspend fun activate() {
        reconcile()
        generation = app.activate()
        client?.close()
        client = app.makeClient()
    }
}

/** Launch this Activity for native-first embedding, or MainActivity for standalone RN. */
class SharedNativeHostActivity : Activity() {
    private val owner = EmbeddedAccountOwner
    private lateinit var email: EditText
    private lateinit var password: EditText
    private lateinit var prompt: EditText
    private lateinit var output: TextView
    private val screenScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }
        email = EditText(this).apply { hint = "Firebase email"; inputType = 33 }
        password = EditText(this).apply { hint = "Password"; inputType = 129 }
        prompt = EditText(this).apply { setText("How does Latchway share native and React Native sessions?") }
        output = TextView(this).apply { setTextIsSelectable(true) }
        listOf(email, password, prompt).forEach(layout::addView)
        fun button(label: String, action: () -> Unit) {
            layout.addView(Button(this).apply { text = label; setOnClickListener { action() } })
        }
        button("Sign in") { login(false) }
        button("Create account") { login(true) }
        button("Resume chat") { transition { owner.activate(); output.text = "Shared account active." } }
        button("Send from native Kotlin") { send() }
        button("Open React Native chat") { startActivity(Intent(this, EmbeddedChatActivity::class.java)) }
        button("Sign out") {
            owner.epoch++; owner.call?.cancel(); owner.request?.cancel(); output.text = ""
            transition { owner.retire(); owner.auth.signOut(); owner.observedIdentity = null; output.text = "Signed out locally and from Firebase." }
        }
        layout.addView(output)
        setContentView(ScrollView(this).apply { addView(layout) })
        try {
            owner.configure(applicationContext); output.text = "Native app registered. Sign in or explicitly Resume chat."
            screenScope.launch {
                var previous: String? = null
                owner.app.snapshots.collect { snapshot ->
                    if (previous != snapshot.generationId || snapshot.state != dev.latchway.core.LatchwayAppState.ACTIVE) {
                        owner.epoch++; owner.call?.cancel(); owner.request?.cancel(); output.text = ""
                    }
                    previous = snapshot.generationId
                }
            }
        }
        catch (_: Exception) { output.text = "Configure Firebase, the generated public client config and real Play Integrity before using this host." }
    }
    override fun onDestroy() { screenScope.cancel(); super.onDestroy() }
    private fun login(create: Boolean) {
        val address = email.text.toString().trim(); val secret = password.text.toString()
        transition {
            if (create) owner.auth.createUserWithEmailAndPassword(address, secret).await()
            else owner.auth.signInWithEmailAndPassword(address, secret).await()
            password.setText(""); owner.activate(); output.text = "Shared account active."
        }
    }
    private fun transition(operation: suspend () -> Unit) {
        owner.scope.launch { owner.transitions.withLock {
            try { operation() } catch (_: Exception) { output.text = "Account operation failed. Retry Sign out to finish incomplete cleanup." }
        } }
    }
    private fun send() {
        val client = owner.client ?: return run { output.text = "Sign in or Resume chat first." }
        owner.request?.cancel(); owner.call?.cancel()
        val epoch = owner.epoch; val question = prompt.text.toString()
        if (question.isBlank() || question.length > 4_000) { output.text = "Use a prompt of 1–4,000 characters."; return }
        owner.request = owner.scope.launch {
            try {
                val messages = JSONArray().put(JSONObject().put("role", "system").put("content",
                    "Explain Latchway: a device-attested AI gateway that keeps provider keys on the server, verifies Firebase identity and enforces per-user quotas."))
                    .put(JSONObject().put("role", "user").put("content", question))
                val payload = JSONObject().put("model", "latchway-managed").put("max_tokens", 1024).put("messages", messages)
                val request = Request.Builder().url(owner.config.getString("baseURL").trimEnd('/') + "/v1/chat/completions")
                    .latchwayFeature(owner.config.getString("directFeature"))
                    .post(payload.toString().toRequestBody("application/json".toMediaType())).build()
                val call = client.buildOkHttpClient().newCall(request); owner.call = call
                val answer = withContext(Dispatchers.IO) { call.execute().use { response ->
                    check(response.isSuccessful)
                    JSONObject(requireNotNull(response.body).string()).getJSONArray("choices")
                        .getJSONObject(0).getJSONObject("message").getString("content")
                } }
                if (epoch == owner.epoch && !isFinishing) output.text = answer
            } catch (_: Exception) { if (epoch == owner.epoch && !isFinishing) output.text = "Native request stopped or failed. No automatic retry was sent." }
        }
    }
}

class EmbeddedChatActivity : ReactActivity() {
    override fun getMainComponentName(): String = "LatchwayEmbeddedChat"
    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
