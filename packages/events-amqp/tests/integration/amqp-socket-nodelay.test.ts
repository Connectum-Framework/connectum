/**
 * The TCP_NODELAY setting of the adapter's connections, observed on a real broker.
 *
 * With amqplib's own default, Nagle's algorithm stays on and a publish that follows the delivery
 * of the previous message on the same connection waits about 40 ms (measured: 43.9 ms against
 * 0.4 ms). The adapter therefore turns Nagle off unless `socketOptions.noDelay` says otherwise.
 * The tests watch the values handed to `net.Socket.prototype.setNoDelay` for the sockets that
 * go to the broker, so they do not depend on timing.
 *
 * Skipped unless AMQP_TEST_URL is set (see amqp-broker.test.ts for starting a broker).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterEach, describe, it } from "node:test";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";

const AMQP_URL = process.env.AMQP_TEST_URL;

/** Values given to `setNoDelay` for sockets connected to `port`, in call order. */
function watchNoDelay(port: number): { readonly values: boolean[]; readonly restore: () => void } {
    const original = net.Socket.prototype.setNoDelay;
    const values: boolean[] = [];
    net.Socket.prototype.setNoDelay = function patched(this: net.Socket, noDelay?: boolean) {
        if (this.remotePort === port || this.connecting) {
            values.push(noDelay ?? true);
        }
        return original.call(this, noDelay);
    };
    return {
        values,
        restore: () => {
            net.Socket.prototype.setNoDelay = original;
        },
    };
}

describe("AMQP adapter socket options on a real broker", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = AMQP_URL as string;
    const brokerPort = Number(new URL(url).port || 5672);
    const run = randomUUID().slice(0, 8);
    let restore: (() => void) | undefined;

    afterEach(() => {
        restore?.();
        restore = undefined;
    });

    async function connectedWith(socketOptions: Record<string, unknown> | undefined, withProbe: boolean): Promise<boolean[]> {
        const watch = watchNoDelay(brokerPort);
        restore = watch.restore;
        const exchange = `it.nodelay.${run}.${Math.random().toString(36).slice(2, 8)}`;
        const adapter = AmqpAdapter({
            url,
            exchange,
            exchangeType: "topic",
            ...(socketOptions === undefined ? {} : { socketOptions }),
            ...(withProbe ? { lifecycle: { onLifecycle: () => undefined } } : { recovery: false }),
        });
        try {
            await adapter.connect();
            return [...watch.values];
        } finally {
            await adapter.disconnect();
            watch.restore();
            restore = undefined;
        }
    }

    it("turns Nagle's algorithm off on the connection by default", async () => {
        const values = await connectedWith(undefined, false);
        assert.ok(values.length >= 1, "the adapter's socket must have been configured");
        assert.ok(values.every((value) => value === true), `setNoDelay values: ${values.join(", ")}`);
    });

    it("respects an explicit noDelay: false", async () => {
        const values = await connectedWith({ noDelay: false }, false);
        assert.ok(values.length >= 1);
        assert.ok(values.every((value) => value === false), `setNoDelay values: ${values.join(", ")}`);
    });

    it("keeps an explicit noDelay: true", async () => {
        const values = await connectedWith({ noDelay: true }, false);
        assert.ok(values.length >= 1);
        assert.ok(values.every((value) => value === true), `setNoDelay values: ${values.join(", ")}`);
    });

    it("passes other socket options through next to the default", async () => {
        const values = await connectedWith({ keepAlive: true }, false);
        assert.ok(values.length >= 1);
        assert.ok(values.every((value) => value === true), `setNoDelay values: ${values.join(", ")}`);
    });

    it("gives the startup probe connection the same value as the working connection", async () => {
        const defaults = await connectedWith(undefined, true);
        assert.ok(defaults.length >= 2, `a probe and a working connection, got ${defaults.length} socket configurations`);
        assert.ok(defaults.every((value) => value === true), `setNoDelay values: ${defaults.join(", ")}`);

        const explicit = await connectedWith({ noDelay: false }, true);
        assert.ok(explicit.length >= 2);
        assert.ok(explicit.every((value) => value === false), `setNoDelay values: ${explicit.join(", ")}`);
    });
});
