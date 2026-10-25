---
"@connectum/interceptors": patch
---

fix: `createFallbackInterceptor({ skipStreaming: false })` now answers a streaming call whose opening failed with a streaming response. The `handler`'s message is the call's only message (the single response of a client-streaming call), and the caller receives it over gRPC and Connect instead of `Internal: internal error` with no message that replaced the original failure.

Why: the interceptor built a unary-shaped response (`stream: false`, the message as a plain object) for every call, and the protocol layer cannot send that for a streaming call. Reproduced over real gRPC and Connect connections for server-streaming, client-streaming and bidirectional calls. Only configurations with `skipStreaming: false` on a streaming call change; unary calls, the default (streaming calls skipped), the refusal of access (`Unauthenticated`, `PermissionDenied`, never replaced) and a failure after the first message (not replaced) behave as before.
