package dev.latchway.reactnative

import dev.latchway.core.LatchwayLifecycleCode
import dev.latchway.core.LatchwayLifecycleException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class NativeRuntimeFenceTest {
    @Test
    public fun lateTicketBindingOrClientAcquisitionAfterInvalidationIsReleasedNotPublished() = runBlocking {
        // The module uses this same transaction for identity tickets, exclusive
        // identity bindings and both shared/legacy native clients.
        for (kind in listOf("ticket", "binding", "client")) {
            val runtime = NativeRuntimeFence()
            val entered = CompletableDeferred<Unit>()
            val finish = CompletableDeferred<Unit>()
            val owned = mutableListOf<String>()
            val released = mutableListOf<String>()
            val acquisition = async(Dispatchers.Default) {
                runCatching {
                    runtime.acquire(
                        create = { entered.complete(Unit); finish.await(); kind },
                        publish = { owned += it },
                        release = { released += it },
                    )
                }
            }
            entered.await()
            assertEquals(emptyList<String>(), runtime.invalidate { owned.toList().also { owned.clear() } })
            finish.complete(Unit)
            val failure = acquisition.await().exceptionOrNull()
            assertTrue(failure is LatchwayLifecycleException)
            assertEquals(LatchwayLifecycleCode.DISPOSED, (failure as LatchwayLifecycleException).code)
            assertTrue(owned.isEmpty())
            assertEquals(listOf(kind), released)
        }
    }

    @Test
    public fun cancellationStillReleasesLateAcquisition() = runBlocking {
        val runtime = NativeRuntimeFence()
        val entered = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        var published = false
        var releases = 0
        val acquisition = async(Dispatchers.Default) {
            runtime.acquire(
                create = { entered.complete(Unit); finish.await(); "ticket" },
                publish = { published = true },
                release = { releases++ },
            )
        }
        entered.await()
        acquisition.cancel()
        finish.complete(Unit)
        acquisition.cancelAndJoin()
        assertFalse(published)
        assertEquals(1, releases)
    }

    @Test
    public fun publishedResourceIsCapturedByInvalidationAndFutureAcquisitionNeverStarts() = runBlocking {
        val runtime = NativeRuntimeFence()
        val owned = mutableListOf<String>()
        runtime.acquire(create = { "binding" }, publish = { owned += it }, release = { error("unexpected cleanup") })
        assertEquals(listOf("binding"), runtime.invalidate { owned.toList().also { owned.clear() } })
        var started = false
        val failed = runCatching {
            runtime.acquire(create = { started = true; "late" }, publish = { owned += it }, release = {})
        }
        assertTrue(failed.exceptionOrNull() is LatchwayLifecycleException)
        assertFalse(started)
        assertTrue(owned.isEmpty())
    }
}
