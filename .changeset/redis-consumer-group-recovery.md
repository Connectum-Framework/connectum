---
"@connectum/events-redis": minor
---

fix: a Redis consumer resumes after Redis loses its consumer group. After a restart without persistence, `FLUSHALL`, or a failover to a replica without the stream, the consume loop used to log `NOGROUP` every second and deliver nothing until the service restarted, while `publish()` kept succeeding. The adapter now re-creates the group on `NOGROUP` (from `XREADGROUP` and from the reclaim pass), reading from the beginning of the stream, so every entry Redis still retains is delivered (entries that `brokerOptions.maxLen` trimmed during the gap are gone); entries the group had already handled before the loss can be delivered a second time (at-least-once). A `console.warn` line is written and the new `group-recreated` lifecycle event (`group`, `stream`, `connection`) is delivered when `lifecycle.onLifecycle` is set; code with an exhaustive `switch` over `RedisLifecycleEvent` needs a branch for it.
