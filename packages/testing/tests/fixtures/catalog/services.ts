/**
 * Implementations of the services in `proto/catalogparity/v1/parity.proto`, the
 * contract the service-catalog parity tests run on. What each method must
 * answer is written on the proto; this file only carries it out.
 *
 * `ctx.call` / `ctx.stream` keys are typed by `pb/catalog.gen.ts`, which
 * `buf generate` and the catalog plugin produce, so a key that the generated
 * catalog does not know fails to compile here.
 */

import { setTimeout as delay } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { type Context, defineService } from "@connectum/core";
import { EdgeService, type Item, ItemSchema, ProbeService, RelayService, TargetService, TotalSchema } from "./pb/catalogparity/v1/parity_pb.ts";

/** What the leaf service reports to the scenario that drives it. */
export interface LeafProbe {
    /** Resolves when the leaf service started a call. */
    started: PromiseWithResolvers<void>;
    /** Resolves when the call the leaf service handles was cancelled. */
    aborted: PromiseWithResolvers<void>;
}

export function newLeafProbe(): LeafProbe {
    return { started: Promise.withResolvers<void>(), aborted: Promise.withResolvers<void>() };
}

/** Holder the scenario replaces before each run, so a run never sees the previous run's signals. */
export interface LeafProbeHolder {
    current: LeafProbe;
}

function watch(probe: LeafProbe, ctx: Context): void {
    probe.started.resolve();
    if (ctx.signal.aborted) {
        probe.aborted.resolve();
    } else {
        ctx.signal.addEventListener("abort", () => probe.aborted.resolve(), { once: true });
    }
}

function item(value: string, sequence: number): Item {
    return create(ItemSchema, { value, sequence });
}

function refusal(request: Item): ConnectError {
    return new ConnectError(`target refused ${request.value}`, request.failCode);
}

/** The leaf service of the contract. `probe.current` is read at each call. */
export function targetService(probe: LeafProbeHolder) {
    return defineService(TargetService, {
        async echo(request, ctx) {
            watch(probe.current, ctx);
            if (request.hold) {
                if (!ctx.signal.aborted) {
                    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
                }
                throw new ConnectError("target call cancelled", Code.Canceled);
            }
            if (request.failCode !== 0) {
                throw refusal(request);
            }
            return item(`target:${request.value}`, request.sequence);
        },
        async *count(request, ctx) {
            watch(probe.current, ctx);
            for (let i = 1; request.hold || i <= request.sequence; i++) {
                if (ctx.signal.aborted) {
                    return;
                }
                yield item(`${request.value}#${i}`, i);
                if (request.hold) {
                    await delay(5);
                }
            }
            if (request.failCode !== 0) {
                throw refusal(request);
            }
        },
        async sum(requests, ctx) {
            watch(probe.current, ctx);
            let count = 0;
            let sum = 0;
            for await (const request of requests) {
                if (request.failCode !== 0) {
                    throw refusal(request);
                }
                count++;
                sum += request.sequence;
            }
            return create(TotalSchema, { count, sum });
        },
        async *chat(requests, ctx) {
            watch(probe.current, ctx);
            for await (const request of requests) {
                if (request.failCode !== 0) {
                    throw refusal(request);
                }
                yield item(`target:${request.value}`, request.sequence);
            }
        },
    });
}

/** The middle service: forwards every method to `TargetService`. */
export function relayService() {
    return defineService(RelayService, {
        async echo(request, ctx) {
            const reply = await ctx.call("catalogparity.v1.TargetService/Echo", request);
            return item(`relay:${reply.value}`, reply.sequence);
        },
        async *count(request, ctx) {
            for await (const reply of ctx.stream("catalogparity.v1.TargetService/Count")(request)) {
                yield item(`relay:${reply.value}`, reply.sequence);
            }
        },
        async sum(requests, ctx) {
            const call = ctx.stream("catalogparity.v1.TargetService/Sum")();
            for await (const request of requests) {
                call.send(request);
            }
            return call.close();
        },
        async *chat(requests, ctx) {
            const call = ctx.stream("catalogparity.v1.TargetService/Chat")();
            const forwarded = (async () => {
                try {
                    for await (const request of requests) {
                        call.send(request);
                    }
                } finally {
                    call.close();
                }
            })();
            for await (const reply of call.responses) {
                yield item(`relay:${reply.value}`, reply.sequence);
            }
            await forwarded;
        },
    });
}

/** The outer service: forwards every method to `RelayService`. */
export function edgeService() {
    return defineService(EdgeService, {
        async echo(request, ctx) {
            const reply = await ctx.call("catalogparity.v1.RelayService/Echo", request);
            return item(`edge:${reply.value}`, reply.sequence);
        },
        async *count(request, ctx) {
            for await (const reply of ctx.stream("catalogparity.v1.RelayService/Count")(request)) {
                yield item(`edge:${reply.value}`, reply.sequence);
            }
        },
        async sum(requests, ctx) {
            const call = ctx.stream("catalogparity.v1.RelayService/Sum")();
            for await (const request of requests) {
                call.send(request);
            }
            return call.close();
        },
        async *chat(requests, ctx) {
            const call = ctx.stream("catalogparity.v1.RelayService/Chat")();
            const forwarded = (async () => {
                try {
                    for await (const request of requests) {
                        call.send(request);
                    }
                } finally {
                    call.close();
                }
            })();
            for await (const reply of call.responses) {
                yield item(`edge:${reply.value}`, reply.sequence);
            }
            await forwarded;
        },
    });
}

/** Calls that no route can serve; each lets the catalog's error out. */
export function probeService() {
    return defineService(ProbeService, {
        async orphan(request, ctx) {
            return ctx.call("catalogparity.v1.OrphanService/Echo", request);
        },
        async unknownService(request, ctx) {
            return ctx.call("catalogparity.v1.NoSuchService/Echo" as never, request as never) as Promise<Item>;
        },
        async unknownMethod(request, ctx) {
            return ctx.call("catalogparity.v1.TargetService/NoSuchMethod" as never, request as never) as Promise<Item>;
        },
        async wrongKind(request, ctx) {
            return ctx.call("catalogparity.v1.TargetService/Count" as never, request as never) as Promise<Item>;
        },
    });
}
