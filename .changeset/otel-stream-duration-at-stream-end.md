---
"@connectum/otel": minor
---

fix: the duration of a streaming call is recorded when the stream ends. `rpc.server.call.duration` and `rpc.client.call.duration` of a server-streaming, client-streaming or bidirectional call used to be recorded as soon as the response head was available, so a call that ran for seconds showed a few milliseconds (a client call showed the time to the first message), while the span of the same call lasted until the end of the stream. The OpenTelemetry RPC metrics conventions ask the metric to equal the span duration, and it now does. This holds in every mode, including `withoutTracing: true`. The call ends, and the duration is recorded exactly once, when the response stream is exhausted, fails, or the consumer stops reading it.

Dashboards, SLOs and alerts that read these histograms for streaming methods see much larger values from this version on; the unary call durations are unchanged. A response stream that is never iterated records neither a duration nor ends its span, because no code of the stream runs.
