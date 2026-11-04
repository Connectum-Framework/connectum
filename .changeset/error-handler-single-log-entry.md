---
"@connectum/interceptors": patch
---

fix: with default options outside production, `createErrorHandlerInterceptor` now writes one console entry per handled error instead of three. The failure is logged once, as the error object with its stack and `cause`; the separate `Stack trace:` line is gone, and the `Transformed ConnectError:` line appears only when the client receives something other than what was thrown, as a short text (`[internal] internal error`) instead of a second copy of the error. A `ConnectError` that leaves unchanged, such as a validation failure, is one entry. `includeStackTrace` now only controls `info.stack` passed to `onError`.
