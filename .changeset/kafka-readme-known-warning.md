---
"@connectum/events-kafka": patch
---

docs: document the `TimeoutNegativeWarning` that `kafkajs` 2.2.4 prints on Node.js 26 and its cause inside `kafkajs` (an empty request queue re-arms a 1 ms timer on every broker connection, a cost that Node.js versions before 26 pay without the warning; message delivery is unaffected, the idle CPU cost was not measured), and state the Kafka version the integration suite was run on instead of the untested ">=2.0".
