---
"@connectum/events-redis": minor
---

feat: `RedisAdapter()` validates `brokerOptions` when it is called and throws a `RangeError` that names the option and the received value. `maxLen` and `count` must be positive safe integers and `blockMs` a non-negative safe integer; `undefined` keeps the default. Previously `maxLen: 0` made every `XADD ... MAXLEN ~ 0` trim the entry it had just added, so published events vanished without an error, and an invalid `blockMs` or `count` started successfully and then failed every second inside the consume loop so that nothing was ever delivered. Valid values behave as before.
