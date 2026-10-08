---
"@connectum/events-nats": minor
---

fix: an event matched by several patterns of one subscription is handled once

A JetStream consumer delivers a stream message once, and the adapter created one consumer per pattern, so a route set such as `user.created`, `user.*`, `user.>` ran the handler three times for a single `user.created`. `subscribe()` now creates consumers for the patterns that remain after dropping every pattern another one contains (the three patterns above share the consumer of `user.>`). Two patterns that overlap only in part (`a.*.c`, `a.b.*`) are replaced by one wider pattern and the adapter acknowledges and skips events that match none of the patterns that were asked for. Patterns that overlap with nothing keep their own consumer and name, so subscriptions without overlaps are unchanged on the broker.

**Upgrade note.** Consumers that earlier versions created for the dropped patterns stay on the broker; the adapter does not delete them because other instances of the group may still run the old version. No event is lost by the upgrade: the consumer that stays is one of the old ones and resumes from its position. Once every instance runs the new version, remove the leftovers (`nats consumer ls <stream>`, then `nats consumer rm <stream> <name>` for `{group}--{pattern}--{hash}` of each dropped pattern). Until then their pending count grows with every event, and on a stream with `interest` retention they keep every message in the stream.
