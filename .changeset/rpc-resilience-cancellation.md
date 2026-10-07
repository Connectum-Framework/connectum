---
"@connectum/interceptors": patch
"@connectum/test-fixtures": patch
---

Propagate timeout cancellation to downstream work and make retry backoff interruptible. The first cancellation cause determines the error: own timeout uses DeadlineExceeded; caller cancellation preserves an existing ConnectError, including its code, metadata and details, and maps other reasons to Canceled.

This corrects observable cancellation behavior: cancelled calls no longer start another retry or return a late success. Already running signal-unaware work is still awaited inside retry so bulkhead capacity reflects active work; cancellation does not roll back side effects. Streaming remains opening-only when explicitly enabled, and caller cancellation continues after successful opening. Public options, defaults and chain order are unchanged.

Provide each mock request with an independent, non-aborted signal required by the existing ConnectRPC request contract.
