/**
 * What a service learns when the topology setup of its FIRST connect is refused
 * by a reachable broker, against a live RabbitMQ (testcontainers).
 *
 * With default options the refusal is retried (the service may start before
 * another one fixes the topology), and there is no callback to report it, so the
 * wait used to be silent. The adapter now emits one process warning per distinct
 * broker reply while `connect()` keeps retrying. Checked against the broker's
 * real replies:
 *
 * - an existing exchange of another type, a queue declared with other arguments
 *   and an exchange type the broker does not know each produce exactly one
 *   warning that carries the broker's reply, while `connect()` stays pending
 *   across several retries and resolves once the conflict is removed;
 * - a refused permission (403) is reported the same way;
 * - an unreachable broker is not a topology failure: no warning, and `connect()`
 *   resolves once the broker answers;
 * - nothing is warned when another channel already reports the failure
 *   (`onLifecycle`, `failFastOnInitialSetupError`, `initialConnectMaxRetries`),
 *   and a failure of a later reconnect is not warned.
 *
 * Gated behind RUN_RECOVERY_TESTS=1 like the other container suites.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type amqp from "amqplib";
import { connect } from "amqplib";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import { AmqpConnectionError, AmqpTopologyError } from "../../src/errors.ts";
import type { AmqpLifecycleEvent } from "../../src/types.ts";
import { RABBITMQ_IMAGE } from "./brokerImage.ts";

const RUN = process.env.RUN_RECOVERY_TESTS === "1";

const WARNING_CODE = "CONNECTUM_AMQP_TOPOLOGY_SETUP_FAILED";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 20_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: condition not met in time");
        }
        await sleep(25);
    }
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const uniqueName = (label: string): string => `warn.${label}.${randomUUID().slice(0, 8)}`;

/** Settled state of a promise that is not awaited. */
function track<T>(promise: Promise<T>): { readonly state: () => "pending" | "resolved" | "rejected"; readonly error: () => unknown } {
    let state: "pending" | "resolved" | "rejected" = "pending";
    let error: unknown;
    promise.then(
        () => {
            state = "resolved";
        },
        (err: unknown) => {
            state = "rejected";
            error = err;
        },
    );
    return { state: () => state, error: () => error };
}

describe("AMQP initial connect: topology failure warning (testcontainers)", { skip: RUN ? false : "RUN_RECOVERY_TESTS != 1", concurrency: 1 }, () => {
    let container: StartedTestContainer;
    let url: string;
    let host: string;
    let port: number;

    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
        if ((warning as { code?: string }).code === WARNING_CODE) {
            warnings.push(warning);
        }
    };

    beforeEach(() => {
        warnings.length = 0;
        process.on("warning", onWarning);
    });

    afterEach(() => {
        process.off("warning", onWarning);
    });

    async function admin<T>(fn: (ch: amqp.Channel) => Promise<T>): Promise<T> {
        const conn = await connect(url);
        try {
            const ch = await conn.createChannel();
            try {
                return await fn(ch);
            } finally {
                await ch.close().catch(() => undefined);
            }
        } finally {
            await conn.close().catch(() => undefined);
        }
    }

    async function ctl(...args: string[]): Promise<void> {
        const res = await container.exec(["rabbitmqctl", "-q", ...args], { user: "rabbitmq" });
        if (res.exitCode !== 0) {
            throw new Error(`rabbitmqctl ${args.join(" ")} failed (${res.exitCode}): ${res.output}`);
        }
    }

    async function waitForBroker(): Promise<void> {
        const deadline = Date.now() + 60_000;
        for (;;) {
            try {
                const probe = await connect(url);
                await probe.close();
                return;
            } catch (err) {
                if (Date.now() > deadline) {
                    throw err;
                }
                await sleep(200);
            }
        }
    }

    /** One warning, then enough time for the default backoff to retry the setup several more times. */
    async function expectOneWarningAcrossRetries(): Promise<Error> {
        await waitFor(() => warnings.length > 0);
        await sleep(2_500);
        assert.equal(warnings.length, 1, `expected exactly one warning across the retries, got ${warnings.map((w) => w.message).join(" | ")}`);
        return warnings[0] as Error;
    }

    before(async () => {
        container = await new GenericContainer(RABBITMQ_IMAGE).withExposedPorts(5672).start();
        host = container.getHost();
        port = container.getMappedPort(5672);
        url = `amqp://guest:guest@${host}:${port}`;
        await waitForBroker();
    });

    after(async () => {
        await container?.stop();
    });

    describe("default options: connect() keeps retrying and the refusal is warned once", () => {
        it("an existing exchange of another type", { timeout: 60_000 }, async () => {
            const exchange = uniqueName("extype");
            await admin((ch) => ch.assertExchange(exchange, "fanout"));
            const adapter = AmqpAdapter({ url, exchange, exchangeType: "topic" });
            const connecting = track(adapter.connect());
            try {
                const warning = await expectOneWarningAcrossRetries();
                assert.equal(connecting.state(), "pending", "connect() keeps waiting: the outcome of the default configuration is unchanged");
                assert.match(warning.message, /inequivalent arg 'type'/);
                assert.ok(warning.message.includes(exchange), `the warning names the exchange: ${warning.message}`);
                assert.match(warning.message, /failFastOnInitialSetupError/);
                assert.match(warning.message, /initialConnectMaxRetries/);
                assert.equal(warning.name, "AmqpTopologyWarning");

                // The service that started before the topology was fixed comes up on its own.
                await admin((ch) => ch.deleteExchange(exchange));
                await waitFor(() => connecting.state() !== "pending", 40_000);
                assert.equal(connecting.state(), "resolved", String(connecting.error()));
                await adapter.publish(`${exchange}.evt`, encode("after-fix"));
                assert.equal(warnings.length, 1, "no further warning once the connection is up");
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("a queue declared with other arguments", { timeout: 60_000 }, async () => {
            const exchange = uniqueName("qargs");
            const queue = `${exchange}.q`;
            await admin((ch) => ch.assertQueue(queue, { durable: true, arguments: { "x-max-length": 10 } }));
            const adapter = AmqpAdapter({ url, exchange, topology: { queues: [{ name: queue, durable: true, arguments: { "x-max-length": 5 } }] } });
            const connecting = track(adapter.connect());
            try {
                const warning = await expectOneWarningAcrossRetries();
                assert.equal(connecting.state(), "pending");
                assert.match(warning.message, /inequivalent arg 'x-max-length'/);
                assert.ok(warning.message.includes(queue), `the warning names the queue: ${warning.message}`);

                await admin((ch) => ch.deleteQueue(queue));
                await waitFor(() => connecting.state() !== "pending", 40_000);
                assert.equal(connecting.state(), "resolved", String(connecting.error()));
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("an exchange type the broker does not know in the explicit topology", { timeout: 40_000 }, async () => {
            const exchange = uniqueName("badtype");
            const adapter = AmqpAdapter({ url, exchange, topology: { exchanges: [{ name: `${exchange}.x`, type: "TOPIC" as "topic" }] } });
            const connecting = track(adapter.connect());
            try {
                const warning = await expectOneWarningAcrossRetries();
                assert.equal(connecting.state(), "pending");
                assert.match(warning.message, /unknown exchange type 'TOPIC'/);
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
            assert.equal(connecting.state(), "rejected", "disconnect() ends the wait with a rejection");
            assert.ok(connecting.error() instanceof AmqpConnectionError);
        });

        it("a permission the broker refuses (403)", { timeout: 40_000 }, async () => {
            const user = `noperm-${randomUUID().slice(0, 8)}`;
            await ctl("add_user", user, "secret");
            try {
                // Configure permission is empty: the user may connect but not declare anything.
                await ctl("set_permissions", "-p", "/", user, "", ".*", ".*");
                const exchange = uniqueName("denied");
                const adapter = AmqpAdapter({ url: `amqp://${user}:secret@${host}:${port}`, exchange });
                const connecting = track(adapter.connect());
                try {
                    const warning = await expectOneWarningAcrossRetries();
                    assert.equal(connecting.state(), "pending");
                    assert.match(warning.message, /ACCESS_REFUSED/);
                } finally {
                    await adapter.disconnect().catch(() => undefined);
                }
            } finally {
                await ctl("delete_user", user);
            }
        });
    });

    describe("the broker is down at start and comes up with a conflicting topology", () => {
        /** A port nothing listens on yet, and a forwarder that opens it to the real broker later. */
        async function lateBroker(): Promise<{ readonly url: string; readonly open: () => Promise<void>; readonly close: () => Promise<void> }> {
            const holder = net.createServer();
            await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
            const freePort = (holder.address() as net.AddressInfo).port;
            await new Promise<void>((resolve) => holder.close(() => resolve()));
            const sockets = new Set<net.Socket>();
            const forwarder = net.createServer((client) => {
                const upstream = net.connect(port, host);
                sockets.add(client);
                sockets.add(upstream);
                client.pipe(upstream);
                upstream.pipe(client);
                client.on("error", () => upstream.destroy());
                upstream.on("error", () => client.destroy());
            });
            return {
                url: `amqp://guest:guest@127.0.0.1:${freePort}`,
                open: () => new Promise<void>((resolve) => forwarder.listen(freePort, "127.0.0.1", resolve)),
                close: async () => {
                    for (const socket of sockets) {
                        socket.destroy();
                    }
                    await new Promise<void>((resolve) => forwarder.close(() => resolve()));
                },
            };
        }

        /** Start with the broker unreachable, hold long enough for the startup probe to give up, then open it. */
        async function startBeforeBroker(
            late: Awaited<ReturnType<typeof lateBroker>>,
            exchange: string,
            extra: Record<string, unknown>,
        ): Promise<{ readonly adapter: ReturnType<typeof AmqpAdapter>; readonly connecting: ReturnType<typeof track> }> {
            await admin((ch) => ch.assertExchange(exchange, "fanout"));
            const adapter = AmqpAdapter({ url: late.url, exchange, exchangeType: "topic", ...extra });
            const connecting = track(adapter.connect());
            await sleep(1_000);
            assert.equal(connecting.state(), "pending");
            await late.open();
            return { adapter, connecting };
        }

        it("default options: one warning for the refusal, and connect() resolves after the conflict is removed", { timeout: 60_000 }, async () => {
            const late = await lateBroker();
            const exchange = uniqueName("late.default");
            const { adapter, connecting } = await startBeforeBroker(late, exchange, {});
            try {
                const warning = await expectOneWarningAcrossRetries();
                assert.match(warning.message, /inequivalent arg 'type'/);
                assert.equal(connecting.state(), "pending");
                await admin((ch) => ch.deleteExchange(exchange));
                await waitFor(() => connecting.state() !== "pending", 40_000);
                assert.equal(connecting.state(), "resolved", String(connecting.error()));
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await late.close();
            }
        });

        it("onLifecycle: setup-failed is delivered by the first recovery attempts, and nothing is warned", { timeout: 60_000 }, async () => {
            const late = await lateBroker();
            const exchange = uniqueName("late.lifecycle");
            const events: AmqpLifecycleEvent[] = [];
            const { adapter, connecting } = await startBeforeBroker(late, exchange, { lifecycle: { onLifecycle: (event: AmqpLifecycleEvent) => events.push(event) } });
            try {
                await waitFor(() => events.some((event) => event.type === "setup-failed" && event.initial));
                await sleep(1_500);
                assert.equal(warnings.length, 0);
                assert.equal(connecting.state(), "pending", "the outcome of the default configuration is unchanged");
                await admin((ch) => ch.deleteExchange(exchange));
                await waitFor(() => connecting.state() !== "pending", 40_000);
                assert.equal(connecting.state(), "resolved", String(connecting.error()));
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await late.close();
            }
        });

        it("onSetupFailed (flat callback) is called for the refusal", { timeout: 60_000 }, async () => {
            const late = await lateBroker();
            const exchange = uniqueName("late.flat");
            const failures: Error[] = [];
            const { adapter } = await startBeforeBroker(late, exchange, { lifecycle: { onSetupFailed: (error: Error) => failures.push(error) } });
            try {
                await waitFor(() => failures.length > 0);
                assert.ok(failures[0] instanceof AmqpTopologyError);
                assert.equal(warnings.length, 0);
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await late.close();
                await admin((ch) => ch.deleteExchange(exchange));
            }
        });

        it("failFastOnInitialSetupError rejects connect() with the topology error", { timeout: 60_000 }, async () => {
            const late = await lateBroker();
            const exchange = uniqueName("late.failfast");
            const { adapter, connecting } = await startBeforeBroker(late, exchange, { failFastOnInitialSetupError: true });
            try {
                await waitFor(() => connecting.state() !== "pending", 40_000);
                assert.equal(connecting.state(), "rejected");
                assert.ok(connecting.error() instanceof AmqpTopologyError, String(connecting.error()));
                assert.equal(warnings.length, 0);
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await late.close();
                await admin((ch) => ch.deleteExchange(exchange));
            }
        });
    });

    describe("controls", () => {
        it("an unreachable broker is not warned, and connect() resolves once it answers", { timeout: 60_000 }, async () => {
            // A free port nothing listens on yet; the forwarder below opens it later.
            const holder = net.createServer();
            await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
            const freePort = (holder.address() as net.AddressInfo).port;
            await new Promise<void>((resolve) => holder.close(() => resolve()));

            const adapter = AmqpAdapter({ url: `amqp://guest:guest@127.0.0.1:${freePort}`, exchange: uniqueName("down") });
            const connecting = track(adapter.connect());
            const sockets = new Set<net.Socket>();
            const forwarder = net.createServer((client) => {
                const upstream = net.connect(port, host);
                sockets.add(client);
                sockets.add(upstream);
                client.pipe(upstream);
                upstream.pipe(client);
                client.on("error", () => upstream.destroy());
                upstream.on("error", () => client.destroy());
            });
            try {
                await sleep(2_000);
                assert.equal(connecting.state(), "pending");
                assert.equal(warnings.length, 0, "a broker that cannot be reached is not a topology failure");

                await new Promise<void>((resolve) => forwarder.listen(freePort, "127.0.0.1", resolve));
                await waitFor(() => connecting.state() !== "pending", 40_000);
                assert.equal(connecting.state(), "resolved", String(connecting.error()));
                assert.equal(warnings.length, 0);
            } finally {
                await adapter.disconnect().catch(() => undefined);
                for (const socket of sockets) {
                    socket.destroy();
                }
                await new Promise<void>((resolve) => forwarder.close(() => resolve()));
            }
        });

        it("onLifecycle reports setup-failed and nothing is warned", { timeout: 40_000 }, async () => {
            const exchange = uniqueName("observed");
            await admin((ch) => ch.assertExchange(exchange, "fanout"));
            const events: AmqpLifecycleEvent[] = [];
            const adapter = AmqpAdapter({ url, exchange, exchangeType: "topic", lifecycle: { onLifecycle: (event) => events.push(event) } });
            const connecting = track(adapter.connect());
            try {
                await waitFor(() => events.some((event) => event.type === "setup-failed"));
                await sleep(1_500);
                assert.equal(warnings.length, 0);
                assert.equal(connecting.state(), "pending");
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await admin((ch) => ch.deleteExchange(exchange));
            }
        });

        it("failFastOnInitialSetupError rejects with the topology error and nothing is warned", { timeout: 40_000 }, async () => {
            const exchange = uniqueName("failfast");
            await admin((ch) => ch.assertExchange(exchange, "fanout"));
            const adapter = AmqpAdapter({ url, exchange, exchangeType: "topic", failFastOnInitialSetupError: true });
            try {
                await assert.rejects(adapter.connect(), AmqpTopologyError);
                assert.equal(warnings.length, 0);
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await admin((ch) => ch.deleteExchange(exchange));
            }
        });

        it("initialConnectMaxRetries rejects when the budget is spent and nothing is warned", { timeout: 40_000 }, async () => {
            const exchange = uniqueName("budget");
            await admin((ch) => ch.assertExchange(exchange, "fanout"));
            const adapter = AmqpAdapter({ url, exchange, exchangeType: "topic", recovery: { initialConnectMaxRetries: 1 } });
            try {
                await assert.rejects(adapter.connect(), AmqpConnectionError);
                assert.equal(warnings.length, 0);
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await admin((ch) => ch.deleteExchange(exchange));
            }
        });

        it("a setup refused on a reconnect of an established connection is not warned", { timeout: 60_000 }, async () => {
            const exchange = uniqueName("later");
            // onReconnecting does not observe a topology failure of the initial connect, so the warning path stays live;
            // it proves the reconnect and its refused setup really ran before the absence of a warning is asserted.
            let reconnecting = 0;
            const adapter = AmqpAdapter({
                url,
                exchange,
                exchangeType: "topic",
                lifecycle: {
                    onReconnecting: () => {
                        reconnecting += 1;
                    },
                },
            });
            try {
                await adapter.connect();
                // Replace the exchange with one of another type, then drop the connection: the re-assert is refused.
                await admin((ch) => ch.deleteExchange(exchange));
                await admin((ch) => ch.assertExchange(exchange, "fanout"));
                await ctl("close_all_connections", "warning-test-drop");
                await waitFor(() => reconnecting >= 2);
                assert.equal(warnings.length, 0, "only the initial connect is warned about");
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await admin((ch) => ch.deleteExchange(exchange));
            }
        });
    });
});
