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
| `exchangeType` | `'topic' \| 'direct' \| 'fanout' \| 'headers'` | `'topic'` | Exchange type |
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
| `lifecycle` | `AmqpLifecycleCallbacks` | `undefined` | Connection lifecycle callbacks |
| `publishTimeoutMs` | `number` | `30000` | Per-publish broker-outcome deadline |

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
| `exclusive` | `boolean` | `false` | Exclusive consumer |

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
| `maxDelay` | `number` | `30000` | Delay cap in ms |
| `factor` | `number` | `2` | Exponential backoff factor |
| `jitter` | `number` | `0.2` | Randomization factor (0..1) |
| `maxRetries` | `number` | `Infinity` | Give up after this many attempts |

### AmqpLifecycleCallbacks

| Callback | Signature | Fires when |
|----------|-----------|------------|
| `onConnected` | `() => void` | Connection established (initial and after recovery) |
| `onDisconnected` | `(cause: Error) => void` | Connection lost |
| `onReconnecting` | `(info: { attempt, delay, error }) => void` | A reconnect attempt is scheduled (fires exactly once per scheduled retry) |
| `onReconnectFailed` | `(cause: Error) => void` | Recovery exhausted (`maxRetries` reached) |
| `onSetupFailed` | `(error, { initial, attempt }) => void` | Topology/setup failed on the initial validation probe (`initial: true`) or a reconnect re-assert (`initial: false`). Surfaces deterministic config drift distinctly from a broker outage; the initial-connect call requires the startup probe (runs when this callback or `failFastOnInitialSetupError` is set). |

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
EventBus  →  AMQP
*         →  *     (single token -- same in both)
>         →  #     (multi-token greedy match)

Example: "order.>"  →  "order.#"
```

### Consumer Groups

| Mode | Queue Name | Behavior |
|------|-----------|----------|
| With `group` + `queueOverrides[group]` | override `queue` | External contract queue (bound, consumed) |
| With `group` | `{exchange}.{group}` | Shared, durable, competing consumers |
| Without `group` | `{exchange}.sub-{uuid}` | Exclusive, auto-delete (fan-out) |

### Metadata

Event metadata is transmitted as AMQP message headers. Internal headers (`x-event-id`, `x-published-at`, `x-connectum-publish-id`) are set on publish and stripped from metadata on delivery. For an external contract that must not carry these, set `publisherOptions.externalContract: true` — see [External AMQP Contract](#external-amqp-contract).

### Reliable Publishing (Per-Message Confirms)

The adapter publishes on a confirm channel with **per-message confirms**: every `publish()` resolves when the broker acks that specific message and rejects when the broker nacks it. There is no batching and no `waitForConfirms()` -- each publish has its own outcome.

- A publish with no broker outcome (ack/nack/return/connection loss) within `publishTimeoutMs` (default 30000 ms) rejects with `AmqpPublishTimeoutError`. The message state is then UNKNOWN -- it may or may not have been routed; an at-least-once producer should republish.
- A publish during a disconnected window (or while recovery is in progress) fails fast with `AmqpConnectionError`. In-flight publishes at the moment of a connection loss also reject with `AmqpConnectionError`.

> **Note**: confirms are always per-message — every `publish()` resolves on its own broker ack (or rejects with a typed error). There is no fire-and-forget mode. (The legacy `sync` flag was removed from `PublishOptions` ahead of the first stable release.)

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
- **With `recovery: false`**, `connect()` rejects immediately if the broker is unreachable or topology setup fails, and a lost connection is not restored.

### Error Taxonomy

Every terminal publish/topology outcome is distinguishable by error class -- what an at-least-once producer needs for an "advance cursor after confirm" pattern:

| Error | Meaning |
|-------|---------|
| `AmqpAdapterError` | Base class for all adapter errors |
| `AmqpConnectionError` | Connection absent, lost, or recovery in progress / exhausted |
| `AmqpUnroutableError` | Broker returned a `mandatory` message as unroutable (`basic.return`); has `.routingKey` |
| `AmqpPublishNackError` | Broker negatively acknowledged (nacked) a published message |
| `AmqpPublishTimeoutError` | No broker outcome within `publishTimeoutMs`; message state UNKNOWN |
| `AmqpTopologyError` | Topology declaration or verification failed (missing object in `check` mode, conflicting redeclare in `assert` mode) |
| `AmqpSerializationError` | Payload encoding failed in a custom `serialization.encode` hook |

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
