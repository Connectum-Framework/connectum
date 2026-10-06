---
"@connectum/events-redis": patch
---

`RedisAdapter` no longer lets one failing entry block the redelivery of pending entries. When the handler threw on an entry claimed by `XAUTOCLAIM`, the rest of that batch was skipped (already claimed, so not eligible again for 30 s) and the failure was logged as `XAUTOCLAIM error (non-fatal)` without the entry id. Each reclaimed entry is now handled on its own: the failure is logged as `handler error for entry <entryId>`, the entry stays pending, and the remaining entries are delivered. The reclaim pass also continues from the `next-start-id` that `XAUTOCLAIM` returns instead of always starting at `0-0`, so stale entries behind more than `count * 10` recently delivered pending entries are reached. No option, event or default changes.
