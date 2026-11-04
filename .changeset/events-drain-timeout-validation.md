---
"@connectum/events": minor
---

fix: `createEventBus` now refuses an unusable `drainTimeout` when the bus is created. `NaN` and negative values aborted running handlers as soon as `stop()` was called, and `Infinity` (or any number above 2147483647 ms, the longest delay a timer keeps) never aborted them and made the drain loop poll every millisecond, emitting thousands of `TimeoutOverflowWarning`. The option must now be a finite number from 0 to 2147483647 (`0` still aborts at once); anything else throws a `RangeError` or `TypeError` that names `drainTimeout` and the received value. **Behaviour change:** these values used to be accepted and misbehave on `stop()`; an omitted option and every valid value are unchanged. `createBroadcastSubscribers` passes its `drainTimeout` through, so it is checked the same way. Shipped as minor because a configuration that used to start now throws.
