---
"@connectum/events": minor
---

Add `createBroadcastSubscribers` for first-class fan-out wiring, and make the duplicate-topic error actionable.

Delivering one event to N independent reactors (each its own consumer group) requires one EventBus per reactor — the per-bus duplicate-topic guard forbids two routes on the same topic on one bus, and a shared group load-balances on a real broker instead of broadcasting. `createBroadcastSubscribers({ adapter, reactors })` builds that one-bus-per-reactor wiring (accepting a shared adapter or a per-bus factory) and rejects duplicate groups. The `Duplicate event topic` error now explains the fix (separate buses + distinct groups for independent reactors) instead of only suggesting a proto-option change.
