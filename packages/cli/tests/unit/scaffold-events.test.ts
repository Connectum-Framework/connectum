/**
 * Unit tests for the events module fragment (task 2.2): adapter table, proto/option
 * generation, EventBus/EventRoute wiring, buf.yaml lint excepts, and composition.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ts from "typescript";
import { generateBufYaml } from "../../src/scaffold/bufConfig.ts";
import { resolveConfig } from "../../src/scaffold/config.ts";
import {
    adapterPackage,
    EVENTS_OPTIONS_PROTO_PATH,
    generateEventBusFile,
    generateEventRouteFile,
    generateEventsOptionsProto,
    generateEventsProto,
    generateEventsTest,
} from "../../src/scaffold/eventsFragment.ts";
import { generateServer } from "../../src/scaffold/serverGen.ts";
import { transformBase } from "../../src/scaffold/transform.ts";
import type { ScaffoldConfig } from "../../src/scaffold/types.ts";
import { GREETER_PROTO } from "../helpers/baseFixture.ts";
import { runBuf } from "../helpers/bufProject.ts";
import {
    callsTo,
    collectNodes,
    createServerOptions,
    exportedBindings,
    importsOf,
    interfaceKeys,
    parseGenerated,
    propertiesOf,
    propertyValue,
    protoRpcMethods,
    unresolvedWorkspaceImports,
} from "../helpers/generatedCode.ts";

const natsConfig: ScaffoldConfig = { dir: "orders", name: "orders", runtime: "node", packageManager: "pnpm", nodeExec: "raw", sample: true, modules: { events: { adapter: "nats" } } };

describe("resolveConfig events flag", () => {
    it("parses a valid adapter", () => {
        assert.deepEqual(resolveConfig({ name: "x", events: "kafka" }).modules.events, { adapter: "kafka" });
    });
    it("treats an absent flag as disabled", () => {
        assert.equal(resolveConfig({ name: "x" }).modules.events, undefined);
    });
    it("rejects `--events` passed with no adapter instead of silently disabling it", () => {
        assert.throws(() => resolveConfig({ name: "x", events: "" }), /--events requires an adapter/);
        assert.throws(() => resolveConfig({ name: "x", events: "   " }), /--events requires an adapter/);
    });
    it("rejects an unknown adapter", () => {
        assert.throws(() => resolveConfig({ name: "x", events: "rabbitmq" }), /invalid --events/);
    });
});

describe("events proto + adapter table", () => {
    // buf is the judge here: it rejects an option name the vendored option proto does not define,
    // a field the option message does not have and an import that does not resolve, none of which
    // a comparison of the generated text with itself can notice.
    it("proto compiles with buf against the vendored option proto and annotates the handler with its topic", () => {
        const files = new Map([
            ["buf.yaml", "version: v2\nmodules:\n  - path: proto\n"],
            ["proto/greeter/v1/events.proto", generateEventsProto()],
            [EVENTS_OPTIONS_PROTO_PATH, generateEventsOptionsProto()],
        ]);
        const built = runBuf(["build", "-o", "-#format=json"], files);
        assert.equal(built.status, 0, built.output);
        const set = JSON.parse(built.output) as { file: Array<{ name: string; service?: Array<{ name: string; method: Array<{ name: string; inputType: string; outputType: string; options?: Record<string, unknown> }> }> }> };
        const events = set.file.find((file) => file.name === "greeter/v1/events.proto");
        const handler = events?.service?.find((service) => service.name === "GreeterEventHandlers");
        assert.ok(handler !== undefined, built.output);
        assert.equal(handler.method.length, 1);
        const [method] = handler.method;
        assert.equal(method?.name, "OnGreetingSent");
        assert.equal(method?.inputType, ".greeter.v1.GreetingSent");
        assert.equal(method?.outputType, ".google.protobuf.Empty");
        // The annotation survives compilation as the event option with its topic set.
        assert.deepEqual(method?.options, { "[connectum.events.v1.event]": { topic: "greeter.greeting-sent" } });
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
    // For each adapter: the constructor is imported from the package that exports it, called with
    // options the adapter's own options type declares, and the bus is created with options
    // `createEventBus` accepts. The workspace sources are the oracle for every name.
    const ADAPTER_CASES = [
        { adapter: "nats", exportName: "NatsAdapter", options: interfaceKeys("events-nats/src/types.ts", "NatsAdapterOptions"), required: ["servers"] },
        { adapter: "kafka", exportName: "KafkaAdapter", options: interfaceKeys("events-kafka/src/types.ts", "KafkaAdapterOptions"), required: ["brokers", "clientId"] },
        { adapter: "redpanda", exportName: "KafkaAdapter", options: interfaceKeys("events-kafka/src/types.ts", "KafkaAdapterOptions"), required: ["brokers", "clientId"] },
        { adapter: "redis", exportName: "RedisAdapter", options: interfaceKeys("events-redis/src/types.ts", "RedisAdapterOptions"), required: ["url"] },
        { adapter: "amqp", exportName: "AmqpAdapter", options: interfaceKeys("events-amqp/src/types.ts", "AmqpAdapterOptions"), required: ["url", "exchange"] },
    ] as const;
    const EVENT_BUS_OPTIONS = interfaceKeys("events/src/types.ts", "EventBusOptions");
    const RETRY_OPTIONS = interfaceKeys("events/src/types.ts", "RetryOptions");

    for (const { adapter, exportName, options, required } of ADAPTER_CASES) {
        it(`${adapter} EventBus constructs ${exportName} with options it declares and routes the greeter handlers`, () => {
            const config: ScaffoldConfig = { ...natsConfig, modules: { events: { adapter } } };
            const sf = parseGenerated(generateEventBusFile(config, adapter), "greeterEventBus.ts");
            assert.deepEqual(unresolvedWorkspaceImports(sf), []);
            assert.ok(importsOf(sf).some((record) => record.from === adapterPackage(adapter) && record.names.includes(exportName)));

            const [bus] = callsTo(sf, "createEventBus");
            assert.ok(bus !== undefined);
            const busOptions = bus.arguments[0] as ts.ObjectLiteralExpression;
            assert.deepEqual(
                propertiesOf(busOptions)
                    .map((p) => p.name)
                    .filter((name) => !EVENT_BUS_OPTIONS.has(name)),
                [],
                "createEventBus is given an option it does not have",
            );
            assert.equal(propertyValue(busOptions, "routes")?.getText(), "[greeterEventRoutes]");
            assert.equal(propertyValue(busOptions, "group")?.getText(), '"orders"');
            assert.deepEqual(exportedBindings(sf), ["greeterEventBus"]);

            const [ctor] = callsTo(sf, exportName);
            assert.ok(ctor !== undefined, `${exportName} is not called`);
            assert.equal(propertyValue(busOptions, "adapter")?.getText(), ctor.getText());
            const given = propertiesOf(ctor.arguments[0] as ts.Node).map((p) => p.name);
            assert.deepEqual(
                given.filter((name) => !options.has(name)),
                [],
                `${exportName} is given an option it does not declare`,
            );
            for (const name of required) {
                assert.ok(given.includes(name), `${exportName} is not given "${name}"`);
            }
            // The retry middleware the bus is created with uses the options the real retry type has.
            const retry = propertyValue(propertyValue(busOptions, "middleware") as ts.ObjectLiteralExpression, "retry") as ts.ObjectLiteralExpression;
            assert.deepEqual(
                propertiesOf(retry)
                    .map((p) => p.name)
                    .filter((name) => !RETRY_OPTIONS.has(name)),
                [],
            );
        });
    }

    it("kafka and redpanda name the client after the project and read their own broker variable", () => {
        const kafka = generateEventBusFile({ ...natsConfig, modules: { events: { adapter: "kafka" } } }, "kafka");
        const redpanda = generateEventBusFile({ ...natsConfig, modules: { events: { adapter: "redpanda" } } }, "redpanda");
        assert.ok(kafka.includes("process.env.KAFKA_BROKERS") && !kafka.includes("REDPANDA_BROKERS"));
        assert.ok(redpanda.includes("process.env.REDPANDA_BROKERS") && !redpanda.includes("KAFKA_BROKERS"));
        for (const source of [kafka, redpanda]) {
            assert.ok(source.includes('clientId: "orders"'), source);
        }
    });

    it("EventRoute registers an acknowledging handler for every rpc of the event-handler service", () => {
        const sf = parseGenerated(generateEventRouteFile(), "greeterEvents.ts");
        assert.deepEqual(unresolvedWorkspaceImports(sf), []);
        assert.deepEqual(exportedBindings(sf), ["greeterEventRoutes"]);
        // The service the route registers and the module it is imported from are the ones the
        // generated event proto and its protobuf-es output (`<proto file>_pb.ts`) define.
        const proto = generateEventsProto();
        assert.deepEqual(
            importsOf(sf).filter((record) => record.from.startsWith("#gen/")),
            [{ from: "#gen/greeter/v1/events_pb.ts", names: ["GreeterEventHandlers"], typeOnly: false }],
        );
        const rpcs = protoRpcMethods(proto, "GreeterEventHandlers");

        const [register] = callsTo(sf, "events.service");
        assert.ok(register !== undefined);
        assert.equal(register.arguments[0]?.getText(), "GreeterEventHandlers");
        const handlers = (register.arguments[1] as ts.ObjectLiteralExpression).properties;
        assert.deepEqual(
            handlers.map((handler) => handler.name?.getText()),
            rpcs.map((rpc) => rpc.charAt(0).toLowerCase() + rpc.slice(1)),
        );
        for (const handler of handlers) {
            assert.ok(ts.isMethodDeclaration(handler) && handler.body !== undefined);
            const body = handler.body.statements;
            // A throw would start retry and dead-letter redelivery, so the handler ends by
            // acknowledging and nothing in it throws.
            assert.ok(ts.isExpressionStatement(body.at(-1) as ts.Node));
            assert.equal(((body.at(-1) as ts.ExpressionStatement).expression as ts.AwaitExpression).expression?.getText(), "ctx.ack()");
            assert.ok(ts.isAwaitExpression((body.at(-1) as ts.ExpressionStatement).expression));
            assert.deepEqual(
                collectNodes(handler, ts.isThrowStatement).map((node) => node.getText()),
                [],
            );
            // The starter handler must not log the event body: payloads can carry user data,
            // and a generated default is exactly where that leaks unnoticed.
            assert.deepEqual(callsTo(handler, "console.log"), []);
        }
    });

    for (const runtime of ["node", "bun"] as const) {
        it(`events smoke test on ${runtime} starts and stops an in-memory bus over the route, with the ${runtime} runner`, () => {
            const sf = parseGenerated(generateEventsTest(runtime), "events.test.ts");
            assert.deepEqual(unresolvedWorkspaceImports(sf), []);
            assert.ok(importsOf(sf).some((record) => record.from === `${runtime}:test` && record.names.includes("it")));
            assert.ok(importsOf(sf).some((record) => record.from === "@connectum/events" && record.names.includes("MemoryAdapter") && record.names.includes("createEventBus")));
            const [bus] = callsTo(sf, "createEventBus");
            assert.ok(bus !== undefined);
            const options = bus.arguments[0] as ts.ObjectLiteralExpression;
            assert.deepEqual(
                propertiesOf(options)
                    .map((p) => p.name)
                    .filter((name) => !EVENT_BUS_OPTIONS.has(name)),
                [],
            );
            assert.equal(propertyValue(options, "adapter")?.getText(), "MemoryAdapter()");
            assert.equal(propertyValue(options, "routes")?.getText(), "[greeterEventRoutes]");
            // start is awaited before stop is awaited.
            const awaited = collectNodes(sf, ts.isAwaitExpression).map((node) => node.expression.getText());
            assert.deepEqual(awaited, ["bus.start()", "bus.stop()"]);
        });
    }
});

describe("buf.yaml lint excepts", () => {
    const baseProto = new Map([["proto/greeter/v1/greeter.proto", GREETER_PROTO]]);
    // A second handler service answering with Empty, as the starter proto's own comment says every
    // event handler does: sharing one response type across rpcs is what the uniqueness rule objects to.
    const secondHandlerService = `
message GreetingDeleted {
  string name = 1;
}

service GreeterAuditEventHandlers {
  rpc OnGreetingDeleted(GreetingDeleted) returns (google.protobuf.Empty) {
    option (connectum.events.v1.event).topic = "greeter.greeting-deleted";
  }
}
`;
    const eventsFiles = (yaml: string): Map<string, string> =>
        new Map([
            ...baseProto,
            ["buf.yaml", yaml],
            ["proto/greeter/v1/events.proto", generateEventsProto() + secondHandlerService],
            [EVENTS_OPTIONS_PROTO_PATH, generateEventsOptionsProto()],
        ]);

    // The lint rules the event-handler service breaks are a property of buf and the proto: the
    // excepts have to make `buf lint` accept the project, and each one has to be needed, or the
    // user's own services lose a rule for nothing.
    it("makes buf lint accept the event-handler project, and each except is needed for that", () => {
        const yaml = generateBufYaml(natsConfig);
        const exceptBlock = yaml.slice(yaml.indexOf("  except:"), yaml.indexOf("breaking:"));
        const excepts = [...exceptBlock.matchAll(/^ {4}- ([A-Z_]+)$/gm)].map((m) => m[1] as string);
        assert.ok(excepts.length > 0, yaml);
        const accepted = runBuf(["lint"], eventsFiles(yaml));
        assert.equal(accepted.status, 0, accepted.output);

        for (const rule of excepts) {
            const without = yaml.replace(`    - ${rule}\n`, "");
            const rejected = runBuf(["lint", "--error-format=json"], eventsFiles(without));
            assert.notEqual(rejected.status, 0, `${rule} is excepted but buf lint passes without it`);
            // The failure is the rule that was taken out, not some other defect of the fixture.
            assert.ok(rejected.output.includes(`"type":"${rule}"`), rejected.output);
        }
    });

    it("leaves the rules on, and buf lint passing, for a project without events", () => {
        const base: ScaffoldConfig = { ...natsConfig, modules: {} };
        const yaml = generateBufYaml(base);
        assert.ok(!yaml.includes("except"), yaml);
        const accepted = runBuf(["lint"], new Map([...baseProto, ["buf.yaml", yaml]]));
        assert.equal(accepted.status, 0, accepted.output);
        // The same event-handler proto does break the rules once nothing is excepted.
        const rejected = runBuf(["lint"], eventsFiles(yaml));
        assert.notEqual(rejected.status, 0);
    });
});

describe("generateServer with events", () => {
    it("passes the event bus the project exports to createServer", () => {
        const sf = parseGenerated(generateServer(natsConfig), "server.ts");
        const bus = parseGenerated(generateEventBusFile(natsConfig, "nats"), "greeterEventBus.ts");
        assert.deepEqual(exportedBindings(bus), ["greeterEventBus"]);
        assert.deepEqual(
            importsOf(sf).filter((record) => record.from === "#greeterEventBus.ts"),
            [{ from: "#greeterEventBus.ts", names: ["greeterEventBus"], typeOnly: false }],
        );
        const options = createServerOptions(sf);
        assert.equal(propertyValue(options, "eventBus")?.getText(), "greeterEventBus");
        assert.ok(interfaceKeys("core/src/types.ts", "CreateServerOptions").has("eventBus"));
        assert.equal(propertyValue(createServerOptions(parseGenerated(generateServer({ ...natsConfig, modules: {} }), "server.ts")), "eventBus"), undefined);
    });
});

describe("transformBase with events", () => {
    const base = new Map<string, string>([
        ["package.json", JSON.stringify({ name: "@connectum/example-getting-started", dependencies: { "@connectum/core": "^1.2.0" }, devDependencies: {} })],
        ["buf.yaml", "version: v2\n"],
        ["src/services/greeterService.ts", "export const greeterService = {};\n"],
    ]);

    it("emits option proto, event proto, EventBus, route, and a MemoryAdapter smoke test", () => {
        const out = transformBase(base, natsConfig);
        assert.ok(out.has("proto/connectum/events/v1/options.proto"));
        assert.ok(out.has("proto/greeter/v1/events.proto"));
        assert.ok(out.has("src/greeterEventBus.ts"));
        assert.ok(out.has("src/services/greeterEvents.ts"));
        assert.match(out.get("tests/e2e/events.test.ts") ?? "", /MemoryAdapter/);
    });

    // The base declares ^1.2.0, below the release that exports the events option
    // descriptors the generated code imports, so the whole slice moves to ^1.3.0.
    it("adds @connectum/events + the adapter package to dependencies, on the option-import slice floor", () => {
        const pkg = JSON.parse(transformBase(base, natsConfig).get("package.json") ?? "{}");
        assert.equal(pkg.dependencies["@connectum/events"], "^1.3.0");
        assert.equal(pkg.dependencies["@connectum/events-nats"], "^1.3.0");
        assert.equal(pkg.dependencies["@connectum/core"], "^1.3.0");
        assert.equal(pkg.devDependencies["@connectum/testing"], "^1.3.0");
    });

    it("adds module deps even when the base package.json has no dependencies block", () => {
        const noDeps = new Map(base);
        noDeps.set("package.json", JSON.stringify({ name: "@connectum/example-getting-started", devDependencies: {} }));
        const pkg = JSON.parse(transformBase(noDeps, natsConfig).get("package.json") ?? "{}");
        assert.equal(pkg.dependencies["@connectum/events"], "^1.3.0");
        assert.equal(pkg.dependencies["@connectum/events-nats"], "^1.3.0");
    });

    it("keeps a base slice that is already at or above the floor", () => {
        const newer = new Map(base);
        newer.set(
            "package.json",
            JSON.stringify({ name: "x", dependencies: { "@connectum/core": "^1.4.0", "@connectum/healthcheck": "^1.4.0" }, devDependencies: {} }),
        );
        const pkg = JSON.parse(transformBase(newer, natsConfig).get("package.json") ?? "{}");
        for (const name of ["@connectum/core", "@connectum/healthcheck", "@connectum/events", "@connectum/events-nats"]) {
            assert.equal(pkg.dependencies[name], "^1.4.0", name);
        }
        assert.equal(pkg.devDependencies["@connectum/testing"], "^1.4.0");
    });

    // The whole transform output is judged by buf: the regenerated buf.yaml has to let the
    // emitted event-handler proto (which breaks the service-suffix rule) pass lint.
    it("regenerates buf.yaml so that buf lint accepts the emitted event-handler project", () => {
        const withGreeter = new Map(base);
        withGreeter.set("proto/greeter/v1/greeter.proto", GREETER_PROTO);
        const out = transformBase(withGreeter, natsConfig);
        const protoProject = new Map([...out].filter(([path]) => path === "buf.yaml" || path.startsWith("proto/")));
        assert.ok(protoProject.has("proto/greeter/v1/events.proto") && protoProject.has(EVENTS_OPTIONS_PROTO_PATH));
        const result = runBuf(["lint"], protoProject);
        assert.equal(result.status, 0, result.output);
    });
});
