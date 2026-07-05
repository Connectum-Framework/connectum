---
"@connectum/events-amqp": minor
---

feat: machine-readable `object` on `AmqpTopologyError` (#202)

- New `AmqpTopologyObject` discriminated union — `{ kind: 'exchange' | 'queue', name }` or `{ kind: 'binding', source, destination, destinationType, routingKey }` (a binding has no name of its own) — exposed as `AmqpTopologyError.object` and exported from the barrel.
- Populated structurally at every broker declare/check/consume site (`applyTopology` check and assert modes per object, subscribe-path queue declaration/bindings/check-mode verification, consume failures), so CI drift checks and observability never parse broker-reply text. `object.kind` says *what* was being declared; *why* it failed stays with the error class and `cause`. One documented exception: the config-validation error for a malformed binding declaration (neither `queue` nor `exchange` set) carries no `object` — its destination is exactly the missing piece.
- `AmqpTopologyError` constructor now takes an options-bag `{ cause?, object? }`. Construction stays bit-for-bit compatible: message-only instances install no own `cause`/`object` keys (pinned by unit tests), so spread clones and own-property log serializers see no new keys unless an object is actually supplied.
