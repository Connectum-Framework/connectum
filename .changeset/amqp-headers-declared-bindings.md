---
"@connectum/events-amqp": minor
---

fix: on a headers exchange in `assert` mode the adapter no longer adds its own argument-less (catch-all) binding to a queue whose bindings are declared in `topology.bindings`; the declared `x-match` bindings now select what the queue receives.

**BREAKING** behaviour correction for that configuration only: a queue that declared selective header bindings used to receive every message (the adapter's catch-all matched alongside them), and now receives only the matching ones. To keep the old catch-all, drop the selective binding from `topology.bindings` or declare it without arguments. Queues without declared bindings, `check`/`skip` modes and topic/direct/fanout exchanges are unchanged. A binding created outside the topology is still not seen by the adapter, which keeps adding its catch-all next to it; use `check`/`skip` or declare the binding. `FakeAmqpAdapter` does not model `topology`, so a headers fake still delivers every message.
