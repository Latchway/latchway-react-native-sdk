package dev.latchway.reactnative

import dev.latchway.core.LatchwayLifecycleCode
import dev.latchway.core.LatchwayLifecycleException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** Publishes runtime-owned resources atomically with the invalidation snapshot. */
internal class NativeRuntimeFence {
    private val lock = Any()
    private var invalidated = false

    fun <T> active(action: () -> T): T = synchronized(lock) {
        if (invalidated) throw LatchwayLifecycleException(LatchwayLifecycleCode.DISPOSED)
        action()
    }

    fun <T> invalidate(snapshot: () -> T): T? = synchronized(lock) {
        if (invalidated) return@synchronized null
        invalidated = true
        snapshot()
    }

    suspend fun <T> acquire(
        create: suspend () -> T,
        publish: (T) -> Unit,
        release: suspend (T) -> Unit,
    ): T {
        val caller = currentCoroutineContext()
        caller.ensureActive()
        active { }
        // Native acquisition may finish after cancellation. Keep its result
        // reachable until either publication or explicit compensating cleanup.
        return withContext(NonCancellable) {
            val resource = create()
            try {
                caller.ensureActive()
                active { publish(resource) }
                resource
            } catch (failure: Throwable) {
                try { release(resource) } catch (cleanup: Throwable) { failure.addSuppressed(cleanup) }
                throw failure
            }
        }
    }
}
