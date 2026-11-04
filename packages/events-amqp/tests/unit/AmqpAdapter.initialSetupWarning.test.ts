/**
 * The warning about a topology failure of the first connect that no callback
 * reports: which failures it names, how often, and when it stops. The wiring
 * to a live broker is covered by the container suite; this is the part that
 * has to hold on every runtime.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { warnAboutInitialSetupFailures } from "../../src/AmqpAdapter.ts";
import { AmqpConnectionError, AmqpTopologyError } from "../../src/index.ts";

const conflict = (): AmqpTopologyError =>
    new AmqpTopologyError("Topology declaration failed: 406 PRECONDITION_FAILED - inequivalent arg 'type' for exchange 'orders' in vhost '/': received 'topic' but current is 'fanout'");

function setup(isActive: () => boolean = () => true): { readonly source: EventEmitter; readonly warnings: string[]; readonly stop: () => void } {
    const source = new EventEmitter();
    const warnings: string[] = [];
    const stop = warnAboutInitialSetupFailures(source, isActive, (warning) => warnings.push(warning));
    return { source, warnings, stop };
}

describe("warnAboutInitialSetupFailures", () => {
    it("names the broker reply and the options that make connect() reject", () => {
        const { source, warnings } = setup();
        source.emit("connect-failed", conflict());

        assert.equal(warnings.length, 1);
        const [warning] = warnings as [string];
        assert.ok(warning.includes("inequivalent arg 'type' for exchange 'orders'"), warning);
        assert.ok(warning.includes("failFastOnInitialSetupError"), warning);
        assert.ok(warning.includes("recovery.initialConnectMaxRetries"), warning);
        assert.ok(warning.includes("onLifecycle"), warning);
    });

    it("warns once per distinct text, however often the retry repeats it", () => {
        const { source, warnings } = setup();
        for (let attempt = 0; attempt < 5; attempt++) {
            source.emit("connect-failed", conflict());
        }
        assert.equal(warnings.length, 1);

        source.emit("connect-failed", new AmqpTopologyError("Topology declaration failed: 406 PRECONDITION_FAILED - inequivalent arg 'durable' for queue 'orders.q'"));
        assert.equal(warnings.length, 2, "another cause is another warning");
    });

    it("stays silent for a failure that is not a broker refusal of the topology", () => {
        const { source, warnings } = setup();
        source.emit("connect-failed", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5672"), { code: "ECONNREFUSED" }));
        source.emit("connect-failed", new AmqpConnectionError("Connection lost during the topology setup pass"));
        source.emit("connect-failed", "not an error");
        assert.deepEqual(warnings, []);
    });

    it("stays silent once the adapter is closing", () => {
        let active = true;
        const { source, warnings } = setup(() => active);
        active = false;
        source.emit("connect-failed", conflict());
        assert.deepEqual(warnings, []);
    });

    it("stops listening when asked, so a later reconnect failure is not warned", () => {
        const { source, warnings, stop } = setup();
        assert.equal(source.listenerCount("connect-failed"), 1);
        stop();
        assert.equal(source.listenerCount("connect-failed"), 0);
        source.emit("connect-failed", conflict());
        assert.deepEqual(warnings, []);
    });
});
