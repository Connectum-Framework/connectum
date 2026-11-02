---
"@connectum/interceptors": patch
---

fix: `createTimeoutInterceptor` with `skipStreaming: false` no longer retains memory for every stream when many calls share one long-lived `AbortSignal` (an application-wide shutdown signal, for example). Measured with 6000 in-process server-stream calls on Node 26: the heap grew by 190.6 MB before and by under 1 MB now, against 0.7 MB without the interceptor. Caller cancellation still reaches an opened stream while it is being read. The interceptor lets go of the caller's signal when the reader is done with the stream: read to the end, failed, or closed early. A stream that nobody reads keeps following the caller's signal until that signal aborts.
