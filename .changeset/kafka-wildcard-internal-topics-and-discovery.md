---
"@connectum/events-kafka": minor
---

fix: a wildcard no longer subscribes Kafka's internal topics; feat: `consumerOptions.topicDiscoveryInterval` picks up topics created after the subscription

- A pattern that opens with a wildcard (`>`, `*`, `*.created`) no longer matches topics whose name starts with `__`, the prefix Kafka uses for its own (`__consumer_offsets`, `__transaction_state`). A catch-all `>` used to subscribe `__consumer_offsets` and hand its binary records to the event handler. Literal topic names, a pattern that spells the prefix out (`__audit.>`) and names with a single leading underscore are unaffected.
- New opt-in `consumerOptions.topicDiscoveryInterval` (milliseconds, unset by default so nothing changes unless you set it). KafkaJS expands a wildcard once, when `subscribe()` runs, so a matching topic created later was never consumed. With the option, the adapter lists the broker's topics at that interval and, when a matching topic has appeared, restarts the subscription's consumer to include it; a discovered topic is read from its first message. The restart rebalances the consumer group (a pause of a few seconds; messages being handled are delivered again) and happens only when there is a new topic. Without the option the behaviour, now documented, is unchanged.
