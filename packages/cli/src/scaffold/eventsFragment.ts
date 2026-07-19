/**
 * The `events` module fragment for `connectum init` (OpenSpec change cli-scaffolding,
 * task 2.2). Adds `@connectum/events` + a transport adapter, an event-handler service
 * (proto + `EventRoute`), and the EventBus wiring.
 *
 * Adapter constructors and the event-handler proto shape are lifted from the dogfooded
 * `examples/with-events-*`; the option proto is vendored (as those examples do).
 *
 * @module scaffold/eventsFragment
 */

import type { EventAdapter, ScaffoldConfig } from "./types.ts";

interface AdapterSpec {
    /** npm package providing the adapter. */
    pkg: string;
    /** Named export (constructor function). */
    importName: string;
    /** Renders the adapter constructor call for a project named `name`. */
    ctor: (name: string) => string;
}

const ADAPTERS: Record<EventAdapter, AdapterSpec> = {
    nats: {
        pkg: "@connectum/events-nats",
        importName: "NatsAdapter",
        ctor: () => 'NatsAdapter({ servers: process.env.NATS_SERVERS ?? "nats://localhost:4222" })',
    },
    kafka: {
        pkg: "@connectum/events-kafka",
        importName: "KafkaAdapter",
        ctor: (name) => `KafkaAdapter({ brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(","), clientId: ${JSON.stringify(name)} })`,
    },
    redpanda: {
        pkg: "@connectum/events-kafka",
        importName: "KafkaAdapter",
        ctor: (name) => `KafkaAdapter({ brokers: (process.env.REDPANDA_BROKERS ?? "localhost:9092").split(","), clientId: ${JSON.stringify(name)} })`,
    },
    redis: {
        pkg: "@connectum/events-redis",
        importName: "RedisAdapter",
        ctor: () => 'RedisAdapter({ url: process.env.REDIS_URL ?? "redis://localhost:6379" })',
    },
    amqp: {
        pkg: "@connectum/events-amqp",
        importName: "AmqpAdapter",
        ctor: (name) => `AmqpAdapter({ url: process.env.AMQP_URL ?? "amqp://localhost:5672", exchange: ${JSON.stringify(name)} })`,
    },
};

/** The npm package a given adapter needs (for package.json dependencies). */
export function adapterPackage(adapter: EventAdapter): string {
    return ADAPTERS[adapter].pkg;
}

/** Vendored option proto (proto2) — same content @connectum/events publishes. */
export function generateEventsOptionsProto(): string {
    return `syntax = "proto2";

package connectum.events.v1;

import "google/protobuf/descriptor.proto";

// Method-level topic override for event handlers.
message EventOptions {
  // Custom topic name; defaults to the input message's typeName when unset.
  optional string topic = 1;
}

extend google.protobuf.MethodOptions {
  optional EventOptions event = 50102;
}
`;
}

/** Demo event message + event-handler service for the sample Greeter. */
export function generateEventsProto(): string {
    return `syntax = "proto3";

package greeter.v1;

import "google/protobuf/empty.proto";
import "connectum/events/v1/options.proto";

// A demo event. Replace with your own event messages.
message GreetingSent {
  string name = 1;
  string message = 2;
}

// Event-handler service: one rpc per subscribed event, each returning Empty.
service GreeterEventHandlers {
  rpc OnGreetingSent(GreetingSent) returns (google.protobuf.Empty) {
    option (connectum.events.v1.event).topic = "greeter.greeting-sent";
  }
}
`;
}

/** `src/<name>EventBus.ts` — constructs the EventBus with the chosen adapter. */
export function generateEventBusFile(config: ScaffoldConfig, adapter: EventAdapter): string {
    const spec = ADAPTERS[adapter];
    return `import { createEventBus } from "@connectum/events";
import { ${spec.importName} } from "${spec.pkg}";
import { greeterEventRoutes } from "./services/greeterEvents.ts";

export const greeterEventBus = createEventBus({
    adapter: ${spec.ctor(config.name)},
    routes: [greeterEventRoutes],
    group: ${JSON.stringify(config.name)},
    middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
});
`;
}

/** `src/services/greeterEvents.ts` — the EventRoute with an empty (ack) handler. */
export function generateEventRouteFile(): string {
    return `import type { EventRoute } from "@connectum/events";
import { GreeterEventHandlers } from "#gen/greeter/v1/events_pb.ts";

export const greeterEventRoutes: EventRoute = (events) => {
    events.service(GreeterEventHandlers, {
        async onGreetingSent(event, ctx) {
            // TODO: handle the GreetingSent event (topic: greeter.greeting-sent).
            console.log(\`[greeterEvents] GreetingSent: \${event.name} — \${event.message}\`);
            await ctx.ack();
        },
    });
};
`;
}

/**
 * `buf.yaml`. Event-handler services (`*EventHandlers`, `OnX(Event) returns Empty`)
 * intentionally violate STANDARD lint (SERVICE_SUFFIX / RPC_*), so when events are
 * enabled we add the same `except` list the multi-service examples use, keeping
 * `buf lint` green.
 */
export function generateBufYaml(config: ScaffoldConfig): string {
    const except = config.modules.events
        ? `
  except:
    - SERVICE_SUFFIX
    - RPC_REQUEST_STANDARD_NAME
    - RPC_RESPONSE_STANDARD_NAME
    - RPC_REQUEST_RESPONSE_UNIQUE`
        : "";
    return `version: v2
modules:
  - path: proto
lint:
  use:
    - STANDARD${except}
breaking:
  use:
    - FILE
`;
}
