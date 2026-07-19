/**
 * Unit tests for the events module fragment (task 2.2): adapter table, proto/option
 * generation, EventBus/EventRoute wiring, buf.yaml lint excepts, and composition.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateBufYaml } from "../../src/scaffold/bufConfig.ts";
import { resolveConfig } from "../../src/scaffold/config.ts";
import { adapterPackage, generateEventBusFile, generateEventRouteFile, generateEventsProto } from "../../src/scaffold/eventsFragment.ts";
import { generateServer } from "../../src/scaffold/serverGen.ts";
import { transformBase } from "../../src/scaffold/transform.ts";
import type { ScaffoldConfig } from "../../src/scaffold/types.ts";

const natsConfig: ScaffoldConfig = { name: "orders", runtime: "node", packageManager: "pnpm", nodeExec: "raw", sample: true, modules: { events: { adapter: "nats" } } };

describe("resolveConfig events flag", () => {
    it("parses a valid adapter", () => {
        assert.deepEqual(resolveConfig({ name: "x", events: "kafka" }).modules.events, { adapter: "kafka" });
    });
    it("treats empty/absent as disabled", () => {
        assert.equal(resolveConfig({ name: "x" }).modules.events, undefined);
        assert.equal(resolveConfig({ name: "x", events: "" }).modules.events, undefined);
    });
    it("rejects an unknown adapter", () => {
        assert.throws(() => resolveConfig({ name: "x", events: "rabbitmq" }), /invalid --events/);
    });
});

describe("events proto + adapter table", () => {
    it("proto declares an event-handler service with a topic option", () => {
        const p = generateEventsProto();
        assert.match(p, /service GreeterEventHandlers/);
        assert.match(p, /rpc OnGreetingSent\(GreetingSent\) returns \(google\.protobuf\.Empty\)/);
        assert.match(p, /connectum\.events\.v1\.event\)\.topic/);
        assert.match(p, /import "connectum\/events\/v1\/options\.proto"/);
    });
    it("maps adapters to their packages", () => {
        assert.equal(adapterPackage("nats"), "@connectum/events-nats");
        assert.equal(adapterPackage("kafka"), "@connectum/events-kafka");
        assert.equal(adapterPackage("redpanda"), "@connectum/events-kafka");
        assert.equal(adapterPackage("redis"), "@connectum/events-redis");
        assert.equal(adapterPackage("amqp"), "@connectum/events-amqp");
    });
});

describe("EventBus / EventRoute files", () => {
    it("nats EventBus wires createEventBus + NatsAdapter + routes", () => {
        const f = generateEventBusFile(natsConfig, "nats");
        assert.match(f, /import \{ NatsAdapter \} from "@connectum\/events-nats"/);
        assert.match(f, /createEventBus\(\{/);
        assert.match(f, /NatsAdapter\(\{ servers:/);
        assert.match(f, /routes: \[greeterEventRoutes\]/);
        assert.match(f, /group: "orders"/);
    });
    it("kafka EventBus uses KafkaAdapter with brokers + clientId", () => {
        const f = generateEventBusFile({ ...natsConfig, modules: { events: { adapter: "kafka" } } }, "kafka");
        assert.match(f, /KafkaAdapter\(\{ brokers:.*clientId: "orders"/s);
    });
    it("EventRoute registers the handler with ack (not throw)", () => {
        const r = generateEventRouteFile();
        assert.match(r, /events\.service\(GreeterEventHandlers, \{/);
        assert.match(r, /async onGreetingSent\(event, ctx\)/);
        assert.match(r, /await ctx\.ack\(\)/);
        assert.doesNotMatch(r, /throw/);
    });
});

describe("buf.yaml lint excepts", () => {
    it("adds event-handler lint excepts only when events are enabled", () => {
        assert.match(generateBufYaml(natsConfig), /SERVICE_SUFFIX/);
        const base: ScaffoldConfig = { ...natsConfig, modules: {} };
        assert.doesNotMatch(generateBufYaml(base), /SERVICE_SUFFIX/);
    });
});

describe("generateServer with events", () => {
    it("wires eventBus into createServer", () => {
        const s = generateServer(natsConfig);
        assert.match(s, /import \{ greeterEventBus \} from "#greeterEventBus\.ts"/);
        assert.match(s, /eventBus: greeterEventBus,/);
    });
});

describe("transformBase with events", () => {
    const base = new Map<string, string>([
        ["package.json", JSON.stringify({ name: "@connectum/example-getting-started", dependencies: { "@connectum/core": "^1.2.0" }, devDependencies: {} })],
        ["buf.yaml", "version: v2\n"],
        ["src/services/greeterService.ts", "export const greeterService = {};\n"],
    ]);

    it("emits option proto, event proto, EventBus and route files", () => {
        const out = transformBase(base, natsConfig);
        assert.ok(out.has("proto/connectum/events/v1/options.proto"));
        assert.ok(out.has("proto/greeter/v1/events.proto"));
        assert.ok(out.has("src/greeterEventBus.ts"));
        assert.ok(out.has("src/services/greeterEvents.ts"));
    });

    it("adds @connectum/events + the adapter package to dependencies", () => {
        const pkg = JSON.parse(transformBase(base, natsConfig).get("package.json") ?? "{}");
        assert.equal(pkg.dependencies["@connectum/events"], "^1.2.0");
        assert.equal(pkg.dependencies["@connectum/events-nats"], "^1.2.0");
    });

    it("regenerates buf.yaml with the lint excepts", () => {
        assert.match(transformBase(base, natsConfig).get("buf.yaml") ?? "", /SERVICE_SUFFIX/);
    });
});
