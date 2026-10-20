---
"@connectum/events-nats": patch
---

fix: `consumerOptions.deliverPolicy: "last"` now delivers the last message of every matching subject, as the `NatsConsumerOptions` reference says, instead of only the single last message that matches the filter. The adapter maps `"last"` to the JetStream policy `last_per_subject`. For a literal pattern nothing changes (one subject, one last message). For a wildcard pattern such as `orders.*` a new consumer now starts with the last message of each subject; with overlapping patterns every event is still handled once.

A durable consumer that was already created with the old policy keeps it: the adapter does not rewrite an existing consumer, it reports the difference once through a warning (`deliver_policy=last (requested last_per_subject)`) and goes on with the existing configuration. To get the new behaviour for such a group, delete its durable consumer or use a new group name.
