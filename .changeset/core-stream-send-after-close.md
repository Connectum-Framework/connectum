---
"@connectum/core": minor
---

feat(core): `send()` after `close()` on a `ctx.stream()` handle for a client-streaming or bidi call now throws a `ConnectError` with `Code.FailedPrecondition`. Before, the message was dropped without any signal. A handler that sent a message after `close()` now sees the error where it used to lose the message; move the `send()` before `close()`, or open a new handle. Calling `close()` twice stays harmless. The `responses` iterable of a bidi handle is single-use (two loops over it split the messages, and a loop started after another has ended receives nothing); this is unchanged and is now documented on the handle type and in the service-catalog guide.
