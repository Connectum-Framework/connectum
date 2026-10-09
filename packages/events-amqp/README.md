# @connectum/events-amqp

AMQP/RabbitMQ adapter for `@connectum/events`.

**@connectum/events-amqp** connects the Connectum EventBus to [RabbitMQ](https://www.rabbitmq.com/) (AMQP 0-9-1) for durable, at-least-once event delivery with topic exchanges, consumer groups, dead-letter support, explicit external topology, automatic connection recovery, and per-message publisher confirms.

**Layer**: 2 (Tools) | **Node.js**: >=22.13.0 | **License**: Apache-2.0

## Features

- **Topic Exchange** -- flexible routing via AMQP topic exchange with wildcard patterns
- **Consumer Groups** -- load-balanced consumption via named queues (competing consumers)
- **Per-Message Publisher Confirms** -- every publish resolves on its own broker ack and rejects on nack
- **Explicit Topology** -- declare external exchanges, queues (raw `arguments`, e.g. `x-dead-letter-exchange`), and bindings (including exchange-to-exchange)
- **Queue Overrides** -- attach a consumer group to an externally named queue from a contract
- **Automatic Recovery** -- native amqplib v2 connection recovery with backoff and jitter (enabled by default)
- **Typed Errors** -- every terminal publish/topology outcome is a distinct error class
- **Serialization Control** -- `contentType` label and optional wire transcoding hooks
- **Dead Letter Exchange** -- built-in DLX support for rejected messages
- **Metadata as Headers** -- event metadata mapped to AMQP message headers
- **Prefetch Control** -- configurable QoS prefetch count per consumer

## Installation

```bash
pnpm add @connectum/events-amqp
```

**Peer dependencies:**

```bash
pnpm add @connectum/events
```

## Quick Start

```typescript
import { createEventBus } from '@connectum/events';
import { AmqpAdapter } from '@connectum/events-amqp';

const bus = createEventBus({
  adapter: AmqpAdapter({
    url: 'amqp://guest:guest@localhost:5672',
  }),
  routes: [eventRoutes],
});

await bus.start();
```

### With Full Options

```typescript
const bus = createEventBus({
  adapter: AmqpAdapter({
    url: 'amqp://guest:guest@localhost:5672',
    exchange: 'my-service.events',
    exchangeType: 'topic',
    exchangeOptions: {
      durable: true,
      autoDelete: false,
    },
    queueOptions: {
      durable: true,
      messageTtl: 60000,
      maxLength: 100000,
      deadLetterExchange: 'dlx.events',
      deadLetterRoutingKey: 'dlq',
    },
    consumerOptions: {
      prefetch: 20,
    },
    publisherOptions: {
      persistent: true,
      mandatory: false,
    },
    recovery: {
      initialDelay: 100,
      maxDelay: 30000,
      factor: 2,
      jitter: 0.2,
    },
    lifecycle: {
      onConnected: () => console.log('AMQP connected'),
      onDisconnected: (cause) => console.error('AMQP disconnected', cause),
      onReconnecting: ({ attempt, delay }) => console.warn(`Reconnect #${attempt} in ${delay}ms`),
      onReconnectFailed: (cause) => console.error('AMQP recovery exhausted', cause),
    },
    publishTimeoutMs: 30000,
  }),
  routes: [eventRoutes],
  group: 'worker-group',
  middleware: {
    retry: { maxRetries: 3 },
    dlq: { topic: 'service.dlq' },
  },
});
```

## API Reference

### AmqpAdapter()

```typescript
import { AmqpAdapter } from '@connectum/events-amqp';

function AmqpAdapter(options: AmqpAdapterOptions): EventAdapter
```

### AmqpAdapterOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | `string` | required | AMQP connection URL |
| `socketOptions` | `Record<string, unknown>` | `undefined` | Socket options for connection |
| `exchange` | `string` | `'connectum.events'` | Exchange name |
| `exchangeType` | `'topic' \| 'direct' \| 'fanout' \| 'headers'` | `'topic'` | Exchange type; decides which subscription patterns are accepted and what the queue receives (see [Exchange types and subscription patterns](#exchange-types-and-subscription-patterns)) |
| `exchangeOptions` | `AmqpExchangeOptions` | `{}` | Exchange assertion options |
| `queueOptions` | `AmqpQueueOptions` | `{}` | Default queue assertion options |
| `consumerOptions` | `AmqpConsumerOptions` | `{}` | Consumer options |
| `publisherOptions` | `AmqpPublisherOptions` | `{}` | Publisher options |
| `serialization` | `AmqpSerializationOptions` | `{}` | `contentType` label and optional wire transcoding |
| `topology` | `AmqpTopology` | `undefined` | Explicit topology declared on connect (and after recovery) |
| `topologyMode` | `'assert' \| 'check' \| 'skip'` | `'assert'` | How topology is established |
| `queueOverrides` | `Record<string, AmqpQueueOverride>` | `undefined` | Map a consumer group to an externally named queue |
| `recovery` | `boolean \| AmqpRecoveryOptions` | `true` | Automatic connection recovery (amqplib native); `false` disables |
| `failFastOnInitialSetupError` | `boolean` | `false` | Reject `connect()` with the typed `AmqpTopologyError` on a deterministic setup/topology error at the **first** connect, instead of hanging in infinite recovery. Transient broker-unreachable still blocks-and-retries. |
| `treatTopologyErrorAsFatal` | `boolean` | `false` | Stop the reconnect cycle on **deterministic** topology drift during steady-state recovery (a missing queue or exchange, or a redeclare with different or invalid arguments — judged by reply code **and** message text) instead of retrying forever; reports terminal `reconnect-failed` after `setup-failed`. The stop is quiet — no exception reaches the application — and the adapter stays down until the application restarts the bus. Transient causes (`320`/`541`/`405`, self-healing `404`s, connection drops) stay in recovery. Since 1.3.0 |
| `lifecycle` | `AmqpLifecycleCallbacks` | `undefined` | Connection lifecycle callbacks |
| `publishTimeoutMs` | `number` | `30000` | Per-publish broker-outcome deadline. A value that is not a finite number of at least `1` (`NaN`, `Infinity`, `0`, negative) counts as unset; a fraction is floored; a value above `2147483647` ms is capped to it. There is no "no timeout" value |
| `publishRetry` | `boolean \| AmqpPublishRetryOptions` | `false` | Opt-in bounded retry for **connection-class** publish failures (`AmqpConnectionError`; timeouts only via `retryOnTimeout`) — a broker blip becomes a transparent delay instead of an instant rejection. At-least-once; ids stay stable across attempts. See [Publish Retry](#publish-retry). Since 1.3.0 |

### AmqpExchangeOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `durable` | `boolean` | `true` | Survive broker restarts |
| `autoDelete` | `boolean` | `false` | Delete when last queue unbinds |

### AmqpQueueOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `durable` | `boolean` | `true` | Survive broker restarts |
| `messageTtl` | `number` | `undefined` | Per-message TTL in ms |
| `maxLength` | `number` | `undefined` | Max messages in queue |
| `deadLetterExchange` | `string` | `undefined` | DLX exchange name |
| `deadLetterRoutingKey` | `string` | `undefined` | DLX routing key |

### AmqpConsumerOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prefetch` | `number` | `10` | QoS prefetch count |
| `exclusive` | `boolean` | `true` | Make the private queue of a subscription without `group` exclusive to its connection. RabbitMQ 4.3+ refuses a queue that is neither durable nor exclusive, so `false` works only on older brokers; subscriptions with `group` ignore it |

### AmqpPublisherOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `persistent` | `boolean` | `true` | Persist messages (deliveryMode=2) |
| `mandatory` | `boolean` | `false` | Reject the publish with `AmqpUnroutableError` if the broker cannot route the message |
| `correlationHeader` | `boolean` | `true` | Correlate `basic.return` frames via a private `x-connectum-publish-id` header on mandatory publishes; `false` switches to single-flight serialization |
| `externalContract` | `boolean` | `false` | Publish against an external (non-EventBus) contract: suppress the EventBus envelope so the wire carries only contract-specified properties (no `x-event-id` / `x-published-at` / auto `messageId` / `timestamp` / publish-id). Forces single-flight for `mandatory`. See [External AMQP Contract](#external-amqp-contract) |

### AmqpSerializationOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `contentType` | `string` | `'application/protobuf'` | AMQP `contentType` message property |
| `encode` | `(payload: Uint8Array) => Uint8Array` | `undefined` | Transform the outgoing wire body; failures reject the publish with `AmqpSerializationError` |
| `decode` | `(content: Uint8Array) => Uint8Array` | `undefined` | Transform the incoming wire body before the handler; failures nack the message without requeue |

> The adapter receives payloads as bytes -- the EventBus serializes protobuf upstream. `contentType` is a label, not a converter: setting `'application/json'` does not make the EventBus emit JSON. For external JSON contracts the application publishes pre-serialized bytes through the adapter directly and sets `contentType` accordingly (see [External AMQP Contract](#external-amqp-contract)).

### AmqpTopology

| Parameter | Type | Description |
|-----------|------|-------------|
| `exchanges` | `AmqpExchangeDeclaration[]` | Exchanges to declare: `name`, `type`, `durable`, `autoDelete`, raw `arguments` |
| `queues` | `AmqpQueueDeclaration[]` | Queues to declare: `name`, `durable`, `autoDelete`, `exclusive`, raw `arguments` (e.g. `x-dead-letter-exchange`) |
| `bindings` | `AmqpBindingDeclaration[]` | Bindings: `source` exchange + `routingKey` to either a `queue` or another `exchange` (exchange-to-exchange) |

Queues declared in `topology.queues` are asserted once (with their full arguments) when topology is applied. `subscribe()` does **not** re-assert them -- it only binds patterns. Re-asserting without the original arguments would be a conflicting redeclare (`PRECONDITION_FAILED` 406).

### Topology Modes

| Mode | Behavior |
|------|----------|
| `'assert'` (default) | Declare topology idempotently (`assertExchange` / `assertQueue` / bind) |
| `'check'` | Existence-only verification (`checkExchange` / `checkQueue`); a missing object raises `AmqpTopologyError` |
| `'skip'` | No topology operations; the application owns topology |

> **`check` limitations**: AMQP has no passive introspection. `check` mode verifies only that exchanges and queues *exist* -- argument equivalence and binding presence are NOT verifiable. A conflicting redeclare elsewhere still fails with `PRECONDITION_FAILED` (406).
>
> **Fail-fast vs. recovery**: a topology `AmqpTopologyError` rejects `connect()` immediately **only** with `recovery: false` or `failFastOnInitialSetupError: true`. Under the default recovery (`maxRetries: Infinity`), a permanent topology error on the first connect otherwise enters the infinite recovery loop -- `connect()` does not reject; the failure is surfaced via `onSetupFailed` / `onReconnecting`. Set `failFastOnInitialSetupError: true` to reject a deterministic startup misconfiguration instead. See [Connection Recovery](#connection-recovery).

### AmqpQueueOverride

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `queue` | `string` | required | Externally defined queue name to consume from |
| `arguments` | `Record<string, unknown>` | `undefined` | Raw AMQP arguments used when asserting the queue (assert mode only) |
| `durable` | `boolean` | `true` | Queue durability |

By default a consumer group consumes from `${exchange}.${group}`. A `queueOverrides` entry attaches the subscription to a queue from an external contract instead:

```typescript
queueOverrides: {
  'partner': { queue: 'partner.inbound.v1' },
}
```

### AmqpRecoveryOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `initialDelay` | `number` | `100` | First reconnect delay in ms |
| `maxDelay` | `number` | `30000` | Upper bound of every reconnect delay in ms. The base is capped at `maxDelay / (1 + jitter)`, so jitter never pushes a delay above it (saturated delays lie in `[20000, 30000]` at the defaults) |
| `factor` | `number` | `2` | Exponential backoff factor |
| `jitter` | `number` | `0.2` | Symmetric jitter factor (0..1): the delay is drawn uniformly from `[base × (1 − jitter), base × (1 + jitter)]` around the capped base |
| `maxRetries` | `number` | `Infinity` | Attempts per series before giving up. Governs **both** the initial connect and each later recovery series; the counter resets on every success. A finite value exhausted on the initial connect rejects `connect()` with `AmqpConnectionError` (`cause`: the last connection error). To bound only startup, use `initialConnectMaxRetries` |
| `backoff` | `(attempt: number) => number` | unset | Custom reconnect delay in ms for every reconnect attempt (initial connect and steady state; not `publishRetry`). Synchronous; a failure ends recovery. Cannot be combined with `initialDelay`/`maxDelay`/`factor`/`jitter`. See [Custom backoff hook](#custom-backoff-hook-recoverybackoff). Since 1.3.0 |
| `initialConnectMaxRetries` | `number` | unset | Bound the **initial** connect independently: a finite N gives at most `max(0, floor(N)) + 1` attempts; `Infinity`/`NaN` count as unset. amqplib runs the attempts on the connection the adapter keeps, with per-attempt lifecycle events (`reconnecting`, `setup-failed {initial: true}`), and `connect()` rejects typed on exhaustion (terminal `reconnect-failed`) — instead of blocking forever. See [Connection Recovery](#connection-recovery). Since 1.3.0 |

### AmqpLifecycleCallbacks

The preferred surface is the single discriminated **`onLifecycle`** callback (since 1.3.0); the flat callbacks below are a compatibility shim over the same event stream, `@deprecated` since 1.3.0 (removal not before 2.0). When both are set, flat callbacks fire after `onLifecycle` for the same underlying event.

Callbacks **should not throw** — dispatch runs inside the connection driver's event handlers, so a thrown exception, or a returned promise that rejects, is isolated to protect the connection and reported as a `lifecycle-error` event (below) instead of disappearing. The adapter does **not await** a returned promise: events are dispatched in order, but a slow `async` callback may finish after later events. The same applies to the flat shim callbacks. A failure of the callback that is handling `lifecycle-error` itself is dropped (no recursion). Note: without `recovery.initialConnectMaxRetries`, setting `onLifecycle` (like `onSetupFailed` / `failFastOnInitialSetupError`) enables the startup validation probe — one extra short-lived connection plus a topology validation pass at `connect()` (requires recovery enabled). With `initialConnectMaxRetries` no probe runs: the initial attempts report their own setup failures.

```typescript
lifecycle: {
  onLifecycle: (event) => {
    if (event.type === 'disconnected') metrics.increment('amqp.disconnects');
    if (event.type === 'setup-failed' && event.initial) log.fatal(event.error);
    if (event.type === 'blocked') log.warn(`broker flow control: ${event.reason}`);
  },
},
```

| Event `type` | Payload | Fires when |
|--------------|---------|------------|
| `connected` | `reconnected: boolean` | Connection established — exactly once per (re)connect; `false` for the initial connect, `true` after a recovery |
| `disconnected` | `error: Error` | Connection lost — exactly once per drop. With `recovery: false` the error is the broker's own close error when there is one (`code` carries the reply code, e.g. `320` for a forced close); `Connection closed` is only the fallback when the driver supplied none |
| `reconnecting` | `attempt, delay, error` | A reconnect attempt is scheduled (exactly once per scheduled retry) |
| `reconnect-failed` | `error: Error` | Terminal: retry budget exhausted (`maxRetries`), the initial connect budget ran out (`initialConnectMaxRetries`), the `recovery.backoff` hook failed (`AmqpConnectionError` with the hook's error as `cause`), or the cycle was stopped by the fatal topology policy (`treatTopologyErrorAsFatal`). By the time it fires the adapter has dropped the dead connection and its subscriptions: `publish()`/`subscribe()` reject with `AmqpConnectionError`, and a new `connect()` starts clean (re-subscribe explicitly) |
| `setup-failed` | `initial, attempt, error` | Topology/setup failed during the initial connect (`initial: true`: on the startup probe with `attempt: 0`, or on an attempt under `initialConnectMaxRetries` with its 0-based index) or on a reconnect re-assert (`initial: false`). Without `initialConnectMaxRetries`, the startup probe runs when `onLifecycle`, `onSetupFailed`, or `failFastOnInitialSetupError` is set — and only with recovery enabled |
| `blocked` | `reason: string` | Broker flow control (`connection.blocked`, e.g. a memory/disk alarm). Union-only — no flat equivalent |
| `unblocked` | — | Broker resumed after flow control. Union-only — no flat equivalent |
| `settlement-skipped` | `action, queue, routingKey, deliveryTag, error` | A delivery could not be acknowledged because its channel was already closed (`action`: `ack`, `requeue` or `reject`). The broker returns an unacknowledged delivery to the queue when the channel closes, and it arrives again with `attempt` greater than 1; on a quorum queue each such return counts toward the queue's delivery limit (default 20 since RabbitMQ 4.0), and past the limit the broker drops the message or dead-letters it. The adapter swallows this one error quietly (it used to escape as an unhandled rejection); any other settlement error is not hidden. Union-only. Real adapter only — `FakeAmqpAdapter` has no channel to close |
| `consumer-lost` | `queue, cause, error?, willRestore` | The broker ended one subscription's consumer while the connection stayed up. `cause` is `cancelled` (queue deleted or consumer cancelled) or `channel-closed` (channel exception, passed as `error`). `willRestore` is `true` when `recovery` is enabled. Not reported for a connection loss, `unsubscribe()` or `disconnect()`. Union-only |
| `consumer-restored` | `queue, attempt` | A lost consumer is consuming again; for a subscription without a group `queue` is the new auto-named queue. Union-only |
| `consumer-restore-failed` | `queue, attempt, error, willRetry` | A restoration attempt failed; `willRetry: false` means this subscription's restoration has ended (see Consumer Loss and Restoration). Union-only |
| `lifecycle-error` | `callback, event, error` | A lifecycle callback threw or returned a rejected promise. `callback` names the callback (`onLifecycle` or a flat one such as `onReconnecting`); `event` is the `type` it was handling. Union-only |

Deprecated flat callbacks (compatibility shim): `onConnected()`, `onDisconnected(cause)`, `onReconnecting({ attempt, delay, error })`, `onReconnectFailed(cause)`, `onSetupFailed(error, { initial, attempt })`.

**Scope**: with amqplib's own initial loop (default), the retry loop of the **initial** connect (broker unreachable when `connect()` is called) runs before the lifecycle wiring can attach, so its per-retry events are not surfaced; the startup probe covers the deterministic-misconfiguration case. Set `recovery.initialConnectMaxRetries` (since 1.3.0) to bound that window: the wiring is then attached before the first attempt, so it reports per-attempt `reconnecting`/`setup-failed` events and a terminal `reconnect-failed` on budget exhaustion.

> **Fixed in 1.3.0**: a socket-level connection cut used to fire `onDisconnected` twice (once via the raw connection `error` re-emit, once via the recovery `disconnect` event); it now fires exactly once per drop on both surfaces. If you count disconnects in metrics, expect the count to roughly halve. A graceful server close (e.g. `rabbitmqctl close_all_connections`) was and remains single-fire.

Connection errors are surfaced through these callbacks -- never console-only.

## How It Works

### Topic Mapping

Event types are mapped to AMQP routing keys on the configured exchange:

```text
EventType:    "user.created"
Exchange:     "connectum.events"
Routing Key:  "user.created"
```

### Wildcard Conversion

EventBus wildcard patterns are converted to AMQP topic patterns:

```text
EventBus pattern  →  AMQP topic binding
*                 →  *       (exactly one segment)
terminal >        →  *.#     (one or more trailing segments)

Example: "order.>"  →  "order.*.#"
```

Only a complete `>` segment at the end of a pattern is supported. A complete
`>` segment elsewhere throws before the adapter creates or binds a queue.
Characters embedded in a segment, such as `user*` or `user>`, remain literal.
A complete `#` segment is rejected on topic exchanges because RabbitMQ
interprets it as a wildcard, while the EventBus matcher treats it as literal
text. On non-topic exchanges `#` remains an ordinary routing-key literal (or is
ignored according to the exchange type). What the other exchange types do with
wildcard subscriptions is listed in
[Exchange types and subscription patterns](#exchange-types-and-subscription-patterns).

When upgrading an existing named-group queue, the adapter adds the corrected
binding but does not remove an older, broader binding. Add the new binding
before removing the old one so the queue remains bound throughout the change:

```typescript
await channel.bindQueue(queue, exchange, 'user.*.#');
await channel.unbindQueue(queue, exchange, 'user.#');
```

This changes routing only; it does not delete the queue or its queued messages.
Check every binding on externally managed queues before removing one, because
another consumer may still rely on it.

### Exchange types and subscription patterns

The EventBus selects handlers: for each delivered event it looks for a handler
by exact event type, then by wildcard pattern, and acknowledges an event that
has none. The adapter's part is to make the broker deliver every event a
subscription wants, never a subset. How narrowly it can do so depends on the
exchange type and on who creates the bindings (`topologyMode`):

| Exchange type | Binding made from the pattern (`assert`) | Queue receives | EventBus handler gets | A handler passed to `adapter.subscribe()` gets |
|---------------|------------------------------------------|----------------|-----------------------|-----------------------------------------------|
| `topic` | translated (`*`, terminal `>` as `*.#`) | exactly the events the pattern matches | matching events | matching events |
| `direct` | the pattern as a literal key | only events whose routing key equals the pattern; a wildcard pattern would never match, so `*`/`>` is rejected | equal-key events | equal-key events |
| `fanout` | none that filters (the routing key is ignored) | every message, whatever the pattern | matching events; the rest are acknowledged | every message |
| `headers` | an argument-less binding, which matches everything; none when `topology.bindings` binds the queue to the exchange | every message, whatever the pattern; with declared bindings, exactly what they select | matching events among those delivered; the rest are acknowledged | everything the queue receives |

With `topologyMode: "check"` or `"skip"` the adapter binds nothing and
the operator's bindings decide what reaches the queue; the pattern then only
selects handlers, so no pattern is rejected for the exchange type. For example,
a direct exchange whose queue the operator bound to `user.created` and
`user.deleted` accepts the subscription `user.*` and delivers exactly those two.

Consequences worth knowing:

- On a direct exchange with `topologyMode: "assert"`, `subscribe()` throws a
  `TypeError` for a complete `*` or `>` segment before any queue is declared.
- On fanout and headers exchanges every pattern is accepted, and the queue
  receives every message published to the exchange, except that on a headers
  exchange a selective binding declared for the queue in `topology.bindings`
  limits it to the messages that binding matches. A literal such as
  `user.created` does not narrow it either; use a topic exchange when the broker
  should do the filtering.
- The adapter publishes no header carrying the event type, so a headers
  exchange cannot route by event type, and the adapter cannot derive header
  bindings from a pattern. Selective routing by headers belongs to the
  application: declare the bindings in `topology.bindings` (see
  [Selective routing on a headers exchange](#selective-routing-on-a-headers-exchange)),
  or use `topologyMode: "check"` or `"skip"` and create them yourself.
- A headers exchange delivers a message when any one binding of the queue
  matches. In `assert` mode the adapter therefore adds its argument-less binding
  only when `topology.bindings` declares no binding of that queue to the
  exchange; a binding created outside the topology is not seen, so the
  argument-less binding is added next to it and the queue receives everything.
- An exchange's type cannot be changed by redeclaring it (the broker answers
  `406 PRECONDITION_FAILED`); moving to another type means a new exchange.

#### Selective routing on a headers exchange

Declare the queue and its `x-match` binding in the topology. The adapter binds
nothing of its own to that queue, so only messages whose headers match reach it:

```typescript
const queue = 'orders.eu';

const adapter = AmqpAdapter({
  url: 'amqp://localhost:5672',
  exchange: 'orders',
  exchangeType: 'headers',
  topology: {
    queues: [{ name: queue, durable: true }],
    bindings: [
      { queue, source: 'orders', routingKey: '', arguments: { 'x-match': 'all', region: 'eu' } },
    ],
  },
  queueOverrides: { eu: { queue } },
});

// Receives only messages published with the header `region: eu`.
await adapter.subscribe(
  ['order.created'],
  async (event, ack) => {
    console.log(event.eventType);
    await ack();
  },
  { group: 'eu' },
);
```

To keep the catch-all for a queue, declare no binding for it, or declare the
binding without arguments. Bindings created outside the topology are not seen
by the adapter; to rely on them use `topologyMode: "check"` or `"skip"`.

> **Behavior change in `assert` mode.** Before this rule, the adapter's
> argument-less binding was added next to the declared ones, so a queue with a
> selective declared binding still received every message. It now receives only
> what the declared bindings select. To keep the old behavior, remove the
> selective binding from `topology.bindings` or declare it without arguments.

**Upgrading a durable queue the previous version bound.** The previous version
bound a durable queue with an argument-less binding, and the broker keeps that
binding after the upgrade. The adapter stops adding it but never removes
bindings, because it cannot tell its own from one an operator created; until the
operator removes it, the queue still receives every message and the declared
`x-match` binding filters nothing. Remove the leftover once, with the same routing
key the old binding was made with (the subscription pattern) and no arguments,
for example with amqplib `channel.unbindQueue(queue, exchange, pattern)` (or the
broker's management HTTP API), or delete the queue and let the adapter declare it
again (`rabbitmqctl delete_queue <queue>`; its messages are lost). `rabbitmqctl
list_bindings` shows what the broker holds for the queue.

### Consumer Groups

| Mode | Queue Name | Behavior |
|------|-----------|----------|
| With `group` + `queueOverrides[group]` | override `queue` | External contract queue (bound, consumed) |
| With `group` | `{exchange}.{group}` | Shared, durable, competing consumers |
| Without `group` | `{exchange}.sub-{uuid}` | Exclusive, auto-delete (fan-out); the name is new on every consumer start |

### Delivery Settlement

Every delivery is settled **at most once**, and the first settlement wins: `ack()`, `nack(false)` (reject without requeue), `nack()` / `nack(true)` (requeue), the requeue the adapter sends after a handler rejects, and the reject after a `decode` failure all go through the same gate. A later call for the same delivery resolves without reaching the broker and without a lifecycle event.

- A handler that settles and then throws keeps its settlement: after `await ack()` (or `nack(false)`) a thrown error does **not** requeue the message. A handler that throws without settling is requeued, as before.
- This matters because the broker treats a second settlement of one delivery tag as a protocol violation (`PRECONDITION_FAILED - unknown delivery tag`) and closes the consumer channel.
- It mirrors `ctx.ack()` / `ctx.nack()` in `@connectum/events`, which are idempotent per event.

### Consumer Loss and Restoration

The broker can end one subscription's consumer while the connection stays up: its queue is deleted, the consumer is cancelled, or the broker closes the consumer channel with a channel exception. Before 1.3 this was silent. Now the adapter reports `consumer-lost` once per loss and, with `recovery` enabled, restores the consumer:

- Restoration repeats the subscription's topology step on the live connection. `assert` mode declares the queue again (a deleted queue returns empty; its messages are gone, including unacknowledged ones of a subscription without a group). `check` mode fails with `AmqpTopologyError` for a missing queue and reports `consumer-restore-failed { willRetry: false }`; `skip` mode never declares the queue. An ended restoration is not retried until a connection recovery or a new `subscribe()`.
- A queue you delete on purpose comes back in `assert` mode: also `unsubscribe()`, set `recovery: false`, or use `topologyMode: "check"`.
- Attempt `n` waits the reconnect delay for `n` (`initialDelay`, `factor`, `jitter`, `maxDelay`; defaults when `recovery.backoff` is set; `maxRetries` is not consulted). A failure that can heal is retried without a limit. The counter restarts after the consumer has run for `maxDelay` without a new loss.
- With `recovery: false` the loss is reported with `willRestore: false` and the consumer stays dead.
- The lost consumer's channel is closed. A handler still running settles late: `settlement-skipped`, and the broker returns the unacknowledged message to its queue (if the queue still exists), so the restored consumer gets it again with `attempt` > 1. Keep handlers idempotent.
- A handler that throws synchronously is treated as a rejection: the message is requeued and the consumer keeps working.
- `consumer_timeout` (measured on RabbitMQ 4.3.1 with `consumer_timeout = 60000` and a handler that never settles): a quorum queue cancelled the consumer at about 60 s, it was restored about 100 ms later and the message came back with `attempt: 2`. A classic queue showed no event and no redelivery over 330 s (one observation, not a guarantee).

### Metadata

Event metadata is transmitted as AMQP message headers. Internal headers (`x-event-id`, `x-published-at`, `x-connectum-publish-id`) are set on publish and stripped from metadata on delivery. For an external contract that must not carry these, set `publisherOptions.externalContract: true` — see [External AMQP Contract](#external-amqp-contract).

### Reliable Publishing (Per-Message Confirms)

The adapter publishes on a confirm channel with **per-message confirms**: every `publish()` resolves when the broker acks that specific message and rejects when the broker nacks it. There is no batching and no `waitForConfirms()` -- each publish has its own outcome.

- A publish with no broker outcome (ack/nack/return/connection loss) within `publishTimeoutMs` (default 30000 ms) rejects with `AmqpPublishTimeoutError`. The message state is then UNKNOWN -- it may or may not have been routed; an at-least-once producer should republish.
- A publish is accepted only on a usable connection. While `connect()` is still running (including its startup probe) and after a connection loss, `publish()` rejects with the typed `AmqpConnectionError` ("not connected (or recovery in progress)") — never with a raw "Channel closed" from the dead channel.
- A publish during a disconnected window (or while recovery is in progress) fails fast with `AmqpConnectionError` — unless the opt-in [`publishRetry`](#publish-retry) is enabled, which retries connection-class failures in place. In-flight publishes at the moment of a connection loss also reject with `AmqpConnectionError` (retried under the same opt-in).

> **Note**: confirms are always per-message — every `publish()` resolves on its own broker ack (or rejects with a typed error). There is no fire-and-forget mode. (The legacy `sync` flag was removed from `PublishOptions` ahead of the first stable release.)

### Publish Retry

Opt-in (`publishRetry: true` or an `AmqpPublishRetryOptions` object, since 1.3.0): a `publish()` that fails with a **connection-class** outcome — publishing during a recovery window, or an in-flight confirm lost to a drop — is retried in place (the caller's promise stays pending) instead of rejecting immediately.

```typescript
publishRetry: {
  maxRetries: 5,        // retries after the first attempt (default 5 — bounded, unlike recovery); negative or -Infinity = single attempt, NaN = default, Infinity = until disconnect()
  initialDelay: 100,    // backoff mirrors the recovery formula (never above maxDelay)
  retryOnTimeout: false, // opt-in: also retry AmqpPublishTimeoutError (state UNKNOWN — raises duplicate likelihood)
  onRetry: ({ attempt, delay, routingKey }) => metrics.increment('amqp.publish_retry'),
}
```

- **The auto-retry boundary is `isAutoRetriablePublishError` (exported)** and is deliberately **narrower** than the at-least-once *republish* matrix below: a broker `nack` is republish-safe by policy but is an explicit refusal — it is never auto-retried inline. Deterministic outcomes (unroutable, serialization, topology) never retry.
- **At-least-once, full stop**: a retry after an in-flight confirm loss (state UNKNOWN) may duplicate on the broker. `x-event-id` / `messageId` stay **stable across attempts** (incl. `externalContract` with caller-supplied ids), so consumer-side dedup keys on them.
- **Worst-case latency**: each attempt is bounded by `publishTimeoutMs` (default 30s) — at defaults a single `publish()` can be held for minutes, far beyond typical 30s RPC timeouts. Bound the budget via `maxRetries`/`publishTimeoutMs`; there is deliberately no second overall-deadline knob.
- **Shutdown-aware**: the loop aborts promptly on `disconnect()` (also when the recovery cycle is dead — stopped by `treatTopologyErrorAsFatal` or given up after `maxRetries` — no budget is burned against it), and — living inside the `adapter.publish()` promise — is automatically covered by the bus-level `drainPublishTimeout`.
- **Single-flight interaction** (`mandatory: true` with `correlationHeader: false`; `externalContract` forces the latter but single-flight still requires `mandatory`): retries **hold the chain** — ordering is preserved at the cost of head-of-line blocking during backoff. In this headerless mode a late `basic.return` from an abandoned timed-out attempt may mark the current one — prefer the default header correlation when combining `mandatory` with `retryOnTimeout`.
- **A channel closed by the broker is not retried**: when the broker closes the *current* publish channel with a reply code — `404` for a publish to a missing exchange under `topologyMode: "skip"`, `403` for a publish to an internal exchange, `541` and the rest alike — the publish surfaces immediately with the broker reply as `cause`. The connection stays up and recovery never recreates a channel the broker closed, so every further attempt would meet the same closed channel. A connection loss closes channels without a reply code and stays retriable; so does a channel that was already replaced when the failure arrived.
- **`maxRetries: Infinity` with a channel that cannot heal**: the rule above ends the loop for a broker-closed channel, but a caller who sets `publishRetry.maxRetries: Infinity` and hits a persistent failure of another kind keeps retrying until `disconnect()`. Prefer a finite budget.
- The publish channel is re-resolved on every attempt, so a recovery swap mid-loop is picked up automatically (a *connection*-level recovery; see the previous bullet for channel-only closes).

### Mandatory Publishing and basic.return Correlation

With `publisherOptions.mandatory: true`, an unroutable message (no queue bound for the routing key) rejects the publish with `AmqpUnroutableError` (carries `.routingKey`). The AMQP `basic.return` frame has no delivery tag, so the adapter must correlate returns to publishes:

- **`correlationHeader: true` (default)** -- mandatory publishes are stamped with a private `x-connectum-publish-id` header and returns are matched by it. **The header is visible on the wire to external consumers** -- document it in external contracts.
- **`correlationHeader: false`** -- no header on the wire; mandatory publishes are serialized (single-flight, at most one outstanding at a time) so correlation stays unambiguous at the cost of throughput.

### Connection Recovery

Recovery is delegated to amqplib v2 native opt-in recovery and is **enabled by default** (`recovery: false` restores single-shot, no-reconnect behavior). On every successful (re)connect the adapter:

1. Re-creates its publish and consumer channels.
2. Re-applies topology (per `topologyMode`).
3. Replays all active subscriptions.

Connection behavior:

- **With recovery enabled**, `connect()` retries with backoff until the broker becomes reachable -- convenient for `docker-compose` startup ordering. Under the default `maxRetries: Infinity`, `connect()` blocks rather than failing fast, and a **permanent** setup/topology error on the first connect would otherwise loop indefinitely. Set `failFastOnInitialSetupError: true` to reject `connect()` with the typed `AmqpTopologyError` on such a deterministic startup misconfiguration while still recovering from transient broker outages; use `onSetupFailed` for observability without changing behavior.
- **`maxRetries` scope.** The retry budget governs **both** the initial connect and every later recovery series, with the counter reset on each success. A finite value chosen only to bound startup therefore makes the adapter brittle in steady state: a normal transient blip of that many consecutive failures in any single series permanently stops recovery. The default `Infinity` blocks at startup but never self-destructs on a transient outage. Since 1.3.0, `recovery.initialConnectMaxRetries` expresses "bounded startup, unbounded steady-state" directly — see the next bullet.
- **Bounded initial connect (`initialConnectMaxRetries`).** A finite N gives at most `max(0, floor(N)) + 1` initial attempts (a negative value means one attempt); a value that is not a finite number (`Infinity`, `NaN`) counts as unset. amqplib runs the attempts itself (its `initialMaxRetries`) on the recovering connection the adapter keeps, so each attempt includes the full topology setup and a success leaves exactly one adapter connection on the broker. The lifecycle wiring is attached before the first attempt: every scheduled retry reports `reconnecting` with the applied delay, a topology failure reports `setup-failed { initial: true, attempt }` (0-based index of the failed attempt), and exhaustion reports one terminal `reconnect-failed`, after which `connect()` rejects with `AmqpConnectionError("Initial connect failed after N attempt(s) (initialConnectMaxRetries: M)")` whose `cause` is the last attempt's error. Until the first success `publish()`/`subscribe()` reject with the typed "not connected" error, and the initial `connected` event arrives only once the adapter is usable. `disconnect()` during the initial connect cancels a pending retry at once, and `connect()` rejects with "Adapter closed during the initial connect phase". `failFastOnInitialSetupError` stops the initial connect on the first topology error, budget notwithstanding. Unset (default): amqplib's own initial loop under `maxRetries` governs startup and its per-retry events are not surfaced.
- **Recovery give-up.** When a finite `maxRetries` runs out, recovery is over: the adapter reports the terminal `reconnect-failed` after dropping the dead connection and its subscriptions. From then on `publish()` and `subscribe()` reject at once with `AmqpConnectionError` (`publishRetry` spends no budget), and a later `connect()` starts from a clean slate — re-subscribe explicitly.
- **Reconnect delay.** The delay is symmetric jitter around a capped exponential base — uniform in `[base × (1 − jitter), base × (1 + jitter)]`, rounded, with `base = min(maxDelay / (1 + jitter), initialDelay × factor^(attempt − 1))`. The largest jitter offset lands exactly on `maxDelay`, so a delay never exceeds it: at the defaults a saturated delay lies in `[20000, 30000]` ms. This is amqplib's built-in formula (amqplib ≥ 2.2.0, the minimum this package requires); it applies to every reconnect attempt, including those under `initialConnectMaxRetries`, and `publishRetry` uses the same one. `recovery.backoff` replaces it for reconnect attempts (not for `publishRetry`). See [Tuning the reconnect backoff](#tuning-the-reconnect-backoff).
- **Topology drift during recovery.** Under the default policy, a queue/exchange deleted or incompatibly redeclared while the adapter reconnects makes every recovery attempt fail deterministically — the cycle retries forever, reporting `setup-failed` per attempt (and heals if the topology is restored). Set `treatTopologyErrorAsFatal: true` to stop the cycle on the first such failure instead: the adapter reports `setup-failed` then the terminal `reconnect-failed`, tears down fully (consumers are dead, subscription records cleared — a later `connect()` starts from a clean slate; re-subscribe explicitly), and subsequent publishes fail fast with `AmqpConnectionError`. The gate is the AMQP reply code **together with** the broker's message text on the cause — never `instanceof`, which also wraps transient causes. Fatal: `404` whose text says `no queue '…'` or `no exchange '…'`, and `406` whose text says `inequivalent arg`, `invalid arg`, `unknown exchange type` or `invalid exchange type`. Everything else stays in recovery: `320`/`541`/`405`/`403`, connection drops, and the self-healing `404`s (a queue's home node down or inaccessible, its process stopped by the supervisor or crashed, a timeout, a leader being demoted) and `406 exchange limit … reached`. A `404`/`406` whose message does not match is treated as transient. The fatal stop is quiet — wire `onLifecycle` (`reconnect-failed`) or `onReconnectFailed` and restart the bus from there. Boot-time drift is `failFastOnInitialSetupError`'s job; setting both covers boot and steady state — the remaining window (broker unreachable at `connect()` time with drift surfacing before the first successful connect) is closed by `recovery.initialConnectMaxRetries` (since 1.3.0).
- **With `recovery: false`**, `connect()` rejects immediately if the broker is unreachable or topology setup fails, and a lost connection is not restored. A lost connection surfaces as a single `disconnected` on the connection `close` (an abnormal loss keeps its `error` as the cause; since 1.3.0 a server-forced graceful close also counts, matching the exactly-once contract). The startup probe never runs in this mode — setup errors reject `connect()` directly.
- **`connect()` and `disconnect()` may overlap.** A second `connect()` while one is still running is refused with `AmqpConnectionError("AmqpAdapter: connect() already in progress")` and opens no second connection. `disconnect()` during a running `connect()` cancels it: that `connect()` rejects ("Adapter closed while connect() was in progress", or "…during the initial connect phase"), the connection it had opened is closed, and a `connect()` called after `disconnect()` starts a clean attempt that the cancelled one cannot disturb.
- **Manual reconnect with `recovery: false`.** After the broker closes the connection the adapter reports `disconnected` and stays down. Calling `connect()` again opens a new connection and replays the subscriptions, so each one declares a new private queue under a new name (with the default `exclusive: true` the old queue died with its connection).

#### Tuning the reconnect backoff

The numeric knobs above shape amqplib's built-in schedule; a schedule they cannot express is set with the [`recovery.backoff` hook](#custom-backoff-hook-recoverybackoff).

One shape that **is** expressible exactly with the numeric knobs is AWS-style **full jitter** with a hard cap — the delay drawn uniformly from `[0, min(schedule step, cap)]`, never above the cap. Set `jitter: 1`, halve `initialDelay`, and keep `maxDelay` at the intended cap:

```typescript
// Full jitter over an intended 500ms → 30s exponential schedule, hard-capped at 30s:
recovery: {
  jitter: 1,          // delay becomes uniform in [0, 2 × base]
  initialDelay: 250,  // half of the intended 500ms first step
  maxDelay: 30_000,   // the intended cap itself
}
```

With `jitter: 1` the delay is uniform in `[0, 2 × base]`, and the base is capped at `maxDelay / 2`. Halving `initialDelay` makes `2 × base` trace the intended schedule, and the cap stops it at `maxDelay`: attempt `n` waits uniformly in `[0, min(500 × 2^(n − 1), 30000)]` ms.

> **Caveat**: this relies on amqplib's built-in delay formula, which this package requires in its 2.2.0 form (`base = min(maxDelay / (1 + jitter), initialDelay × factor^(attempt − 1))`, then a uniform offset of `± base × jitter`). amqplib 2.0.x capped the base at `maxDelay` itself, where the same settings would double the cap.

#### Custom backoff hook (`recovery.backoff`)

Since 1.3.0, `recovery.backoff` replaces the built-in schedule with your own function. It receives the attempt number and returns the delay in milliseconds before that attempt; the adapter forwards it to amqplib's `calculateDelay`. Full jitter over an exponential schedule, capped at 30 s:

```typescript
recovery: {
  backoff: (n) => Math.random() * Math.min(30_000, 100 * 2 ** (n - 1)),
}
```

- **`attempt`** is 1-based and restarts at 1 after every successful connect.
- **Coverage.** The hook sets the delay of every reconnect attempt: steady-state recovery and the retries of the initial connect (with or without `initialConnectMaxRetries`). It does **not** cover `publishRetry`, which keeps its own numeric backoff.
- **Return value.** A finite number ≥ 0, rounded to whole milliseconds and applied as is — it is **not** clamped to `maxDelay`, so put the cap into the function (`Math.min(cap, …)`, as above). `0` retries at once. The `reconnecting` event reports this applied delay; the adapter never calls the hook again to fill it.
- **Budgets.** The hook only sets intervals. `maxRetries` and `initialConnectMaxRetries` still bound the attempts and stay valid alongside it.
- **Not combinable with the delay knobs.** `initialDelay`, `maxDelay`, `factor` and `jitter` have no effect once a hook is set, so combining any of them with `backoff` throws a `TypeError` when the adapter is constructed.
- **State across calls** (e.g. decorrelated jitter, which depends on the previous delay) lives in a closure — the hook receives only the attempt number.

> **Warning — a failing hook ends recovery for good.** The hook must be synchronous. If it throws, returns anything but a finite number ≥ 0 (`NaN`, `Infinity`, a negative number, a numeric string) or returns a Promise (an `async` function), recovery gives up — there is no fallback to the built-in schedule. During the initial connect, `connect()` rejects; in steady state the terminal `reconnect-failed` fires once and the adapter drops the dead connection and its subscriptions, exactly as after an exhausted `maxRetries`. Either way the error is an `AmqpConnectionError` whose `cause` is the hook's error (the thrown error, or one stating the invalid return or that the hook must be synchronous) and whose message names the last connection error — "none observed" when the hook failed during an initial connect without `initialConnectMaxRetries`, a window the adapter cannot observe.

### Error Taxonomy

Every terminal publish/topology outcome is distinguishable by error class -- what an at-least-once producer needs for an "advance cursor after confirm" pattern. The **Message state** and **Republish** columns are the published, authoritative retry-safety policy:

| Error | Meaning | Message state | Republish (at-least-once) |
|-------|---------|---------------|---------------------------|
| `AmqpAdapterError` | Base class for all adapter errors | -- | -- |
| `AmqpConnectionError` | Connection absent, lost, or recovery in progress / exhausted | Not sent (pre-send) or UNKNOWN (in-flight)\* | **Yes** |
| `AmqpPublishTimeoutError` | No broker outcome within `publishTimeoutMs` | UNKNOWN | **Yes** |
| `AmqpPublishNackError` | Broker negatively acknowledged (nacked) a published message | Sent, refused | **Yes** -- policy: treated as retriable |
| `AmqpUnroutableError` | Broker returned a `mandatory` message as unroutable (`basic.return`); has `.routingKey` | Sent, dropped | **No** -- deterministic; fix topology/routing |
| `AmqpSerializationError` | Payload encoding failed in a custom `serialization.encode` hook | Never sent | **No** -- deterministic |
| `AmqpTopologyError` | Topology declaration or verification failed (missing object in `check` mode, conflicting redeclare in `assert` mode) | N/A (not a publish) | **No** -- fix config/topology |

> **Do not infer republish-safety from class names -- this matrix is the policy.** In particular the **Nack** row is a maintainer decision: a `basic.nack` is treated as a retriable, deliverable-on-retry outcome (e.g. a queue at capacity with `x-overflow: reject-publish`), so an at-least-once producer should republish. Connection loss is classified *structurally* (the confirm channel emitted `close`, was swapped by recovery, or the publish is closing) rather than by amqplib's error text, so an in-flight connection drop is never misreported as a nack.
>
> \* `AmqpConnectionError` covers both a **pre-send** failure (publishing while disconnected, or a synchronous publish failure -- the message is never sent) and an **in-flight** loss (the connection drops while awaiting the confirm -- state genuinely UNKNOWN). Both are republish-safe; UNKNOWN is the conservative label.

Since 1.3.0, `AmqpTopologyError` also carries a machine-readable **`object`** identifying the failing topology object -- `{ kind: 'exchange' | 'queue', name }` or `{ kind: 'binding', source, destination, destinationType, routingKey }` (a binding has no name of its own). It is populated structurally at the declare/check/consume site, so CI drift checks and observability never parse broker-reply text. `object.kind` says *what* was being declared; *why* it failed stays with the error class and `cause`.

```typescript
try {
  await bus.start();
} catch (err) {
  if (err instanceof AmqpTopologyError && err.object?.kind === 'queue') {
    console.error(`Topology drift: queue '${err.object.name}' rejected by the broker`, err.cause);
  }
}
```

## External AMQP Contract

A complete recipe for integrating with an externally defined AMQP contract (AsyncAPI-style): direct exchange, named durable queue with DLQ arguments, JSON `contentType`, mandatory routing, and per-message confirms. The application serializes JSON itself and publishes through the adapter directly:

```typescript
import { AmqpAdapter, AmqpUnroutableError } from '@connectum/events-amqp';

const adapter = AmqpAdapter({
  url: 'amqp://broker:5672',
  exchange: 'partner.direct',
  exchangeType: 'direct',
  serialization: { contentType: 'application/json' },
  topology: {
    exchanges: [{ name: 'partner.dlx', type: 'direct' }],
    queues: [
      { name: 'partner.dead.v1', durable: true },
      {
        name: 'partner.inbound.v1',
        durable: true,
        arguments: {
          'x-dead-letter-exchange': 'partner.dlx',
          'x-dead-letter-routing-key': 'inbound.dead',
        },
      },
    ],
    bindings: [
      { queue: 'partner.dead.v1', source: 'partner.dlx', routingKey: 'inbound.dead' },
      { queue: 'partner.inbound.v1', source: 'partner.direct', routingKey: 'inbound' },
    ],
  },
  queueOverrides: {
    partner: { queue: 'partner.inbound.v1' },
  },
  // externalContract: emit only contract-specified properties — no EventBus
  // envelope (no x-event-id / x-published-at / auto messageId / publish-id).
  publisherOptions: { persistent: true, mandatory: true, externalContract: true },
});

await adapter.connect();

// Consume from the external queue (group "partner" → partner.inbound.v1)
await adapter.subscribe(
  ['inbound'],
  async (event, ack) => {
    const message = JSON.parse(new TextDecoder().decode(event.payload));
    // ...
    await ack();
  },
  { group: 'partner' },
);

// Publish pre-serialized JSON bytes; resolves on broker ack,
// rejects with AmqpUnroutableError if no queue is bound
const body = new TextEncoder().encode(JSON.stringify({ code: '0104603...' }));
await adapter.publish('inbound', body);
```

> **Clean wire for external contracts.** By default the adapter stamps EventBus *envelope* metadata on every frame: the `x-event-id` and `x-published-at` headers, an auto-generated `messageId`, an auto `timestamp`, and — on mandatory publishes with the default `correlationHeader: true` — a private `x-connectum-publish-id` header. A consumer validating an external contract would see fields it never defined. Set **`publisherOptions.externalContract: true`** (as above) to suppress the whole envelope: the frame then carries only `contentType`, `persistent`/deliveryMode, `mandatory`, and exactly the headers you pass via `PublishOptions.metadata`. In this mode mandatory publishes use single-flight correlation, so no `x-connectum-publish-id` reaches the wire (`correlationHeader` is ignored). Note: `correlationHeader: false` alone removes only the publish-id header — the rest of the envelope still ships, so it is **not** a clean wire on its own. When the contract requires a specific `messageId`/`timestamp`, set them per publish via `PublishOptions.messageId` / `PublishOptions.timestamp` (a caller-supplied value is used as-is; the AMQP `timestamp` property is Unix epoch seconds).

## Testing

A programmable test double ships via the **`@connectum/events-amqp/testing`** subpath (since 1.3.0) — model AMQP failure semantics in unit tests without a broker and without `amqplib` in the runtime graph:

```typescript
import { FakeAmqpAdapter } from '@connectum/events-amqp/testing';
import { AmqpPublishNackError, AmqpPublishTimeoutError } from '@connectum/events-amqp';

const fake = FakeAmqpAdapter({ lifecycle: { onLifecycle: (e) => log.push(e) } });
const bus = createEventBus({ adapter: fake, routes: [eventRoutes] });
await bus.start();

// Inject publish outcomes (FIFO; empty queue = ack). This includes
// AmqpPublishTimeoutError — the state-UNKNOWN outcome that no real broker
// (or even Toxiproxy) reproduces deterministically:
fake.control.nextPublish(new AmqpPublishNackError('nacked'), new AmqpPublishTimeoutError('no outcome'));
await assert.rejects(() => bus.publish(OrderSchema, order), AmqpPublishNackError);
await assert.rejects(() => bus.publish(OrderSchema, order), AmqpPublishTimeoutError);

// Drive the connection lifecycle deterministically:
fake.control.dropConnection();     // disconnected → reconnecting (publishes fail fast; subscribes PARK)
fake.control.failSetup();          // the next recovery re-assert fails (setup-failed for topology errors)
fake.control.completeRecovery();   // …consume it, then heal on the next call
fake.control.completeRecovery();   // connected { reconnected: true }, parked subscribes complete

// A consumer the broker ends while the connection stays up:
fake.control.loseConsumer({ queue: 'orders' }); // consumer-lost; deliver() skips it
fake.control.restoreConsumers();                // consumer-restored { attempt: 1 }; deliver() resumes

// Deliver events (wildcards + competing-consumer groups) and assert settlement:
const result = await fake.control.deliver('order.created', payload);
// result: { delivered, acked, nacked, requeued, failed }
```

Parity contract: pass `exchangeType` (and `topologyMode`, default `assert`) to model the real exchange: `subscribe()` accepts and rejects exactly the patterns the real adapter does, and `deliver()` routes by that type (topic and direct by the EventBus matcher, fanout and headers to every subscription). One exception to that parity: the fake does not model `topology`, so declared header bindings are not modeled and a headers fake delivers every message even where the real adapter, with `x-match` bindings declared for the queue, would deliver only the matching ones. Lifecycle events go through the real adapter's dispatch (union ordering, the deprecated flat shim, and exception isolation match by construction); errors are the real typed classes — `instanceof` holds across the subpath boundary (shared build chunk, pinned by a dist test); the state machine mirrors the real adapter (`connect()` on a live/recovering adapter throws `already connected`, while after `exhaustRecovery()` it starts clean without the old subscriptions and `publish()`/`subscribe()` reject with the real adapter's `AmqpConnectionError`; a mid-recovery `subscribe()` parks and settles with the recovery outcome; `setup-failed` and fail-fast gate on `AmqpTopologyError` exactly like the real probe); incoming envelope headers (`x-event-id`, `x-published-at`) are honored and stripped like the real consumer.

Documented divergences: no timing (recovery advances only via explicit `control` calls; `reconnecting.delay` is `0`; a lost consumer returns only through `restoreConsumers()`, on attempt 1, and `consumer-restore-failed` is never reported; a subscription without a group is named `fake.sub-N` by registration order; the `recovery` option only decides `willRestore`); handler `ack`/`nack` calls are recorded in the `deliver()` result, at most one per delivery per handler (the first wins, as in the real adapter), but do not drive redelivery — re-deliver explicitly with `attempt + 1` (handler rejections are swallowed and counted as `failed`, like the real nack-on-error consumer); `control.published` records the bus-facing call, not the wire envelope; a queued topology `failSetup` at `connect()` without fail-fast reports and proceeds instead of blocking forever. For the generic happy path prefer `MemoryAdapter` from `@connectum/events`; for real-broker semantics see the integration suite.

## Dependencies

### External

- `amqplib` (^2.0.1) -- AMQP 0-9-1 client for Node.js with native connection recovery

### Peer

- `@connectum/events` -- EventBus core

## Requirements

- **Node.js**: >=22.13.0
- **RabbitMQ**: >=3.8

## Documentation

- [Adapters Guide](https://connectum.dev/en/guide/events/adapters)
- [EventBus Guide](https://connectum.dev/en/guide/events)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** — Universal framework for production-ready gRPC/ConnectRPC microservices
