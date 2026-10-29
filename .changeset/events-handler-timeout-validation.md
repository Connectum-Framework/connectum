---
"@connectum/events": minor
---

fix: `createEventBus` now refuses an unusable `handlerTimeout` when the bus is created. The value goes to `AbortSignal.timeout()` on every delivery, so `NaN`, a negative number, a fraction, `Infinity`, a number above 4294967295 or a non-number made each delivery fail before the handler ran (the error reached `publish()` on the memory adapter, was only logged on Redis, and was silent on NATS, where the message was nak-ed until `maxDeliver`), and `0` aborted the handler signal immediately. The option must now be an integer from 1 to 4294967295; anything else throws a `RangeError` or `TypeError` that names `handlerTimeout` and the received value. **Behaviour change:** these values used to be accepted and break each delivery; an omitted option and every valid value are unchanged. Shipped as minor because a configuration that used to start now throws.
