// Consumer USAGE type-check fixture (cast-free). Compiled against the PACKED
// .d.ts under the realistic consumer tsconfig (verbatimModuleSyntax:true,
// strict). Exercises documented public signatures so a signature regression in
// a published package — wrong arg count, narrowed parameter, dropped overload,
// or a value mis-declared type-only — fails this fixture even when the .d.ts
// graph is well-formed (which oracle.mjs already checks). NOT executed; type-
// checked only. Mirrors the documented patterns in examples/getting-started.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createServer, defineCatalog, defineService } from "@connectum/core";
import { createEventBus, MemoryAdapter } from "@connectum/events";
import { createDefaultInterceptors, defaultFailurePredicate } from "@connectum/interceptors";
import { GreeterService, HelloReplySchema, HelloRequestSchema } from "../gen/greeter/v1/greeter_pb.ts";

// defineService — handlers for all four RPC cardinalities, as a consumer writes them.
const greeterService = defineService(GreeterService, {
    sayHello: (req) => create(HelloReplySchema, { message: `Hello, ${req.name}` }),
    sayHelloStream: async function* (req) {
        yield create(HelloReplySchema, { message: req.name });
    },
    sayHelloCollect: async (reqs) => {
        let last = "";
        for await (const r of reqs) last = r.name;
        return create(HelloReplySchema, { message: last });
    },
    sayHelloChat: async function* (reqs) {
        for await (const r of reqs) yield create(HelloReplySchema, { message: r.name });
    },
});

// createServer — the documented options shape.
export const server = createServer({
    services: [greeterService],
    port: 0,
    interceptors: createDefaultInterceptors({ timeout: { duration: 5_000 } }),
});

// catalog + event bus + classification — documented construction signatures.
export const catalog = defineCatalog({ "greeter.v1.GreeterService": GreeterService });
export const bus = createEventBus({ adapter: MemoryAdapter() });
export const failureIsInfra: boolean = defaultFailurePredicate(new ConnectError("x", Code.Unavailable));

// message constructors round-trip with their generated schemas.
const req = create(HelloRequestSchema, { name: "x" });
export const reqName: string = req.name;
