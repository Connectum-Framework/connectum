import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
    type ConsumerIncarnation,
    type ConsumerTimer,
    type ConsumerTimers,
    createConsumerRestorer,
    type RestorableSubscription,
    watchConsumerChannel,
} from "../../src/AmqpAdapter.ts";
import { AmqpConnectionError, AmqpTopologyError } from "../../src/errors.ts";
import type { AmqpConsumerLossCause, AmqpLifecycleEvent } from "../../src/types.ts";

interface FakeTimer extends ConsumerTimer {
    readonly delayMs: number;
    readonly callback: () => void;
    cleared: boolean;
    fired: boolean;
    unrefCalled: boolean;
}

/** Timers fired by hand: the test decides when a backoff or stability window elapses. */
function manualTimers(): ConsumerTimers & { readonly all: FakeTimer[]; live(): FakeTimer[]; fireNext(): void } {
    const all: FakeTimer[] = [];
    return {
        all,
        set(callback, delayMs) {
            const timer: FakeTimer = {
                delayMs,
                callback,
                cleared: false,
                fired: false,
                unrefCalled: false,
                unref() {
                    this.unrefCalled = true;
                },
            };
            all.push(timer);
            return timer;
        },
        clear(timer) {
            (timer as FakeTimer).cleared = true;
        },
        live: () => all.filter((timer) => !timer.cleared && !timer.fired),
        fireNext() {
            const next = all.find((timer) => !timer.cleared && !timer.fired);
            assert.ok(next, "a timer must be pending");
            next.fired = true;
            next.callback();
        },
    };
}

interface FakeChannel {
    closeCalls: number;
    close(): Promise<void>;
}

const makeChannel = (): FakeChannel => ({
    closeCalls: 0,
    close() {
        this.closeCalls += 1;
        return Promise.resolve();
    },
});

const makeRecord = (channel: FakeChannel | null = makeChannel()): RestorableSubscription => ({
    active: true,
    generation: 1,
    channel,
    consumerTag: "ctag",
    queueName: "orders.workers",
    restore: { attempt: 0, timer: null, stabilityTimer: null, pending: false },
});

const makeIncarnation = (started = true): ConsumerIncarnation => ({ started, earlyLoss: null, lost: false, channelError: null });

const flush = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Backoff without jitter: delays are exactly initialDelay × factor^(attempt-1), capped by maxDelay. */
const BACKOFF = { initialDelay: 100, maxDelay: 1000, factor: 2, jitter: 0 };

function setup(overrides: { enabled?: boolean; liveModel?: () => object | null; closing?: () => boolean; start?: (model: object, record: RestorableSubscription) => Promise<ConsumerIncarnation | null> } = {}) {
    const timers = manualTimers();
    const events: AmqpLifecycleEvent[] = [];
    const started: RestorableSubscription[] = [];
    const model = {};
    const restorer = createConsumerRestorer<RestorableSubscription, object>({
        lifecycle: { onLifecycle: (event) => events.push(event) },
        enabled: overrides.enabled ?? true,
        backoff: BACKOFF,
        isClosing: overrides.closing ?? (() => false),
        liveModel: overrides.liveModel ?? (() => model),
        start:
            overrides.start ??
            ((_model, record) => {
                started.push(record);
                return Promise.resolve(makeIncarnation());
            }),
        timers,
    });
    return { restorer, timers, events, started, model };
}

const lose = (
    restorer: ReturnType<typeof setup>["restorer"],
    record: RestorableSubscription,
    incarnation: ConsumerIncarnation,
    channel: FakeChannel,
    extra: { cause?: AmqpConsumerLossCause; error?: Error; generation?: number } = {},
): void => {
    restorer.lost({ record, generation: extra.generation ?? record.generation, incarnation, channel, queue: "orders.workers", cause: extra.cause ?? "cancelled", error: extra.error });
};

describe("watchConsumerChannel", () => {
    const watch = () => {
        const channel = new EventEmitter();
        const incarnation = makeIncarnation();
        const losses: Array<{ cause: AmqpConsumerLossCause; error?: Error }> = [];
        watchConsumerChannel(channel, incarnation, (cause, error) => losses.push({ cause, ...(error === undefined ? {} : { error }) }));
        return { channel, incarnation, losses };
    };
    const coded = (code: number, message: string): Error => Object.assign(new Error(message), { code });

    it("a broker cancel on an open channel is a loss caused by cancel", () => {
        const { channel, losses } = watch();

        channel.emit("cancel");

        assert.deepEqual(losses, [{ cause: "cancelled" }]);
    });

    it("a channel exception (coded error, then close) is a loss that carries the exception", () => {
        const { channel, losses } = watch();
        const exception = coded(406, "PRECONDITION_FAILED - delivery acknowledgement timed out");

        channel.emit("error", exception);
        assert.equal(losses.length, 0, "the loss is reported when the channel closes, not at the error");
        channel.emit("close");

        assert.equal(losses.length, 1);
        assert.equal(losses[0]?.cause, "channel-closed");
        assert.equal(losses[0]?.error, exception);
    });

    it("a close with no preceding channel exception is not a loss", () => {
        const { channel, losses } = watch();

        channel.emit("close");

        assert.deepEqual(losses, [], "the adapter closing its channel, or a lost connection, is not the broker ending a consumer");
    });

    it("an error without a numeric reply code does not turn a later close into a loss", () => {
        const { channel, losses } = watch();

        channel.emit("error", new Error("socket hang up"));
        channel.emit("close");

        assert.deepEqual(losses, []);
    });
});

describe("createConsumerRestorer loss reporting", () => {
    it("reports one loss with the queue, cause and willRestore, closes the dead channel and forgets it", () => {
        const { restorer, events } = setup();
        const channel = makeChannel();
        const record = makeRecord(channel);
        const exception = Object.assign(new Error("closed"), { code: 406 });

        lose(restorer, record, makeIncarnation(), channel, { cause: "channel-closed", error: exception });

        assert.equal(events.length, 1);
        assert.deepEqual(events[0], { type: "consumer-lost", queue: "orders.workers", cause: "channel-closed", error: exception, willRestore: true });
        assert.equal(channel.closeCalls, 1, "a cancelled consumer's channel stays open until it is closed here");
        assert.equal(record.channel, null);
        assert.equal(record.consumerTag, null);
    });

    it("a cancel without an error carries no error field", () => {
        const { restorer, events } = setup();
        const channel = makeChannel();

        lose(restorer, makeRecord(channel), makeIncarnation(), channel);

        assert.equal(events.length, 1);
        assert.equal(Object.hasOwn(events[0] ?? {}, "error"), false);
    });

    it("cancel, a null delivery and close of one incarnation are one loss", () => {
        const { restorer, events, timers } = setup();
        const channel = makeChannel();
        const record = makeRecord(channel);
        const incarnation = makeIncarnation();

        lose(restorer, record, incarnation, channel);
        lose(restorer, record, incarnation, channel);
        lose(restorer, record, incarnation, channel, { cause: "channel-closed", error: Object.assign(new Error("x"), { code: 404 }) });

        assert.equal(events.length, 1);
        assert.equal(timers.live().length, 1, "one loss arms one restore");
    });

    it("with restoration disabled the loss is reported with willRestore false and nothing is scheduled", () => {
        const { restorer, events, timers } = setup({ enabled: false });
        const channel = makeChannel();

        lose(restorer, makeRecord(channel), makeIncarnation(), channel);

        assert.equal(events.length, 1);
        assert.equal(events[0]?.type === "consumer-lost" && events[0].willRestore, false);
        assert.equal(timers.all.length, 0);
    });

    it("ignores the loss of a superseded incarnation, of an unsubscribed subscription and of a closing adapter", () => {
        const channel = makeChannel();

        const superseded = setup();
        const supersededRecord = makeRecord(channel);
        supersededRecord.generation = 2;
        lose(superseded.restorer, supersededRecord, makeIncarnation(), channel, { generation: 1 });
        assert.deepEqual(superseded.events, []);

        const unsubscribed = setup();
        const unsubscribedRecord = makeRecord(channel);
        unsubscribedRecord.active = false;
        lose(unsubscribed.restorer, unsubscribedRecord, makeIncarnation(), channel);
        assert.deepEqual(unsubscribed.events, []);

        const closing = setup({ closing: () => true });
        lose(closing.restorer, makeRecord(channel), makeIncarnation(), channel);
        assert.deepEqual(closing.events, []);
        assert.equal(closing.timers.all.length, 0);
    });

    it("a loss during setup is remembered and reported only once the consumer has started", () => {
        const { restorer, events } = setup();
        const channel = makeChannel();
        const record = makeRecord(channel);
        const incarnation = makeIncarnation(false);
        const exception = Object.assign(new Error("closed"), { code: 404 });

        lose(restorer, record, incarnation, channel, { cause: "channel-closed", error: exception });
        assert.equal(events.length, 0, "a channel failure during setup is a setup failure, not a loss");
        assert.deepEqual(incarnation.earlyLoss, { cause: "channel-closed", error: exception });
        assert.equal(channel.closeCalls, 0);

        incarnation.started = true;
        lose(restorer, record, incarnation, channel, { ...incarnation.earlyLoss });

        assert.equal(events.length, 1);
        assert.equal(events[0]?.type, "consumer-lost");
    });
});

describe("createConsumerRestorer backoff and outcome", () => {
    it("restores after the first backoff delay and reports consumer-restored with the attempt number", async () => {
        const { restorer, timers, events, started } = setup();
        const record = makeRecord();
        const channel = makeChannel();

        lose(restorer, record, makeIncarnation(), channel);
        assert.equal(timers.live().length, 1);
        assert.equal(timers.live()[0]?.delayMs, 100);
        assert.equal(started.length, 0, "nothing restarts before the delay elapses");

        timers.fireNext();
        await flush();

        assert.equal(started.length, 1);
        assert.deepEqual(events.at(-1), { type: "consumer-restored", queue: "orders.workers", attempt: 1 });
    });

    it("the delay grows across consecutive losses until a restored consumer stays up for the longest possible delay", async () => {
        const { restorer, timers, events } = setup();
        const record = makeRecord();

        const delays: number[] = [];
        for (let round = 0; round < 3; round += 1) {
            lose(restorer, record, makeIncarnation(), makeChannel(), { generation: record.generation });
            const pending = timers.live().at(-1);
            assert.ok(pending);
            delays.push(pending.delayMs);
            timers.fireNext();
            await flush();
            record.generation += 1;
        }

        assert.deepEqual(delays, [100, 200, 400]);
        const restored = events.filter((event) => event.type === "consumer-restored");
        assert.deepEqual(
            restored.map((event) => (event.type === "consumer-restored" ? event.attempt : -1)),
            [1, 2, 3],
        );
    });

    it("a restored consumer starts a stability window equal to the effective maxDelay; after it the series starts over", async () => {
        const { restorer, timers } = setup();
        const record = makeRecord();

        lose(restorer, record, makeIncarnation(), makeChannel());
        timers.fireNext();
        await flush();
        const stability = timers.live().at(-1);
        assert.ok(stability);
        assert.equal(stability.delayMs, 1000);
        assert.equal(stability.unrefCalled, true, "the window must not keep the process alive");

        timers.fireNext();
        assert.equal(record.restore.attempt, 0);

        record.generation += 1;
        lose(restorer, record, makeIncarnation(), makeChannel());
        assert.equal(timers.live().at(-1)?.delayMs, 100, "after a stable period the delay restarts at its initial value");
    });

    it("a loss inside the stability window cancels the window and continues the series", async () => {
        const { restorer, timers } = setup();
        const record = makeRecord();

        lose(restorer, record, makeIncarnation(), makeChannel());
        timers.fireNext();
        await flush();
        const stability = timers.live().at(-1);
        assert.ok(stability);

        record.generation += 1;
        lose(restorer, record, makeIncarnation(), makeChannel());

        assert.equal(stability.cleared, true);
        assert.equal(timers.live().at(-1)?.delayMs, 200);
        assert.equal(record.restore.attempt, 2);
    });

    it("every timer it arms is unref'd", () => {
        const { restorer, timers } = setup();
        const channel = makeChannel();

        lose(restorer, makeRecord(channel), makeIncarnation(), channel);

        assert.ok(timers.all.length > 0);
        assert.ok(timers.all.every((timer) => timer.unrefCalled));
    });

    it("a failed attempt that can heal is reported with willRetry true and retried after a longer delay", async () => {
        const failure = new Error("channel error");
        const { restorer, timers, events } = setup({ start: () => Promise.reject(failure) });
        const record = makeRecord();

        lose(restorer, record, makeIncarnation(), makeChannel());
        timers.fireNext();
        await flush();

        const failed = events.at(-1);
        assert.deepEqual(failed, { type: "consumer-restore-failed", queue: "orders.workers", attempt: 1, error: failure, willRetry: true });
        assert.equal(timers.live().at(-1)?.delayMs, 200);
    });

    it("a failure that cannot heal (a missing queue in check mode) is reported with willRetry false and ends the restoration", async () => {
        const drift = new AmqpTopologyError("Queue 'orders.workers' does not exist", {
            cause: Object.assign(new Error("NOT_FOUND - no queue 'orders.workers' in vhost '/'"), { code: 404 }),
        });
        const { restorer, timers, events } = setup({ start: () => Promise.reject(drift) });

        lose(restorer, makeRecord(), makeIncarnation(), makeChannel());
        timers.fireNext();
        await flush();

        const failed = events.at(-1);
        assert.ok(failed?.type === "consumer-restore-failed");
        assert.equal(failed.willRetry, false);
        assert.equal(failed.error, drift);
        assert.equal(timers.live().length, 0, "nothing is left scheduled");
    });

    it("an attempt that finds the connection gone stands down silently: connection recovery rebuilds the consumer", async () => {
        const { restorer, timers, events } = setup({ start: () => Promise.reject(new AmqpConnectionError("Connection lost while establishing consumer channel")) });

        lose(restorer, makeRecord(), makeIncarnation(), makeChannel());
        timers.fireNext();
        await flush();

        assert.deepEqual(
            events.map((event) => event.type),
            ["consumer-lost"],
        );
        assert.equal(timers.live().length, 0);
    });

    it("an attempt that is superseded or unsubscribed (start resolves null) reports nothing", async () => {
        const { restorer, timers, events } = setup({ start: () => Promise.resolve(null) });

        lose(restorer, makeRecord(), makeIncarnation(), makeChannel());
        timers.fireNext();
        await flush();

        assert.deepEqual(
            events.map((event) => event.type),
            ["consumer-lost"],
        );
        assert.equal(timers.live().length, 0);
    });

    it("a consumer lost again before the attempt returns is not reported as restored", async () => {
        const { restorer, timers, events } = setup({
            start: () => Promise.resolve({ ...makeIncarnation(), lost: true }),
        });

        lose(restorer, makeRecord(), makeIncarnation(), makeChannel());
        timers.fireNext();
        await flush();

        assert.equal(
            events.some((event) => event.type === "consumer-restored"),
            false,
        );
    });

    it("a pending broker call that dies with the connection (wrapped into a topology error) stands down instead of reporting a failure", async () => {
        let live: object | null = {};
        const died = new AmqpTopologyError("Failed to assert queue: Channel ended, no reply will be forthcoming", {
            cause: new Error("Channel ended, no reply will be forthcoming"),
        });
        const { restorer, timers, events } = setup({
            liveModel: () => live,
            start: () => {
                live = null;
                return Promise.reject(died);
            },
        });

        lose(restorer, makeRecord(), makeIncarnation(), makeChannel());
        timers.fireNext();
        await flush();

        assert.deepEqual(
            events.map((event) => event.type),
            ["consumer-lost"],
        );
        assert.equal(timers.live().length, 0);
    });

    it("a topology error whose text mentions a closed channel is still a failure while the connection is live", async () => {
        const failure = new AmqpTopologyError("Failed to assert queue: Channel closed by server: 320 (CONNECTION-FORCED)", {
            cause: new Error("Channel closed by server: 320 (CONNECTION-FORCED)"),
        });
        const { restorer, timers, events } = setup({ start: () => Promise.reject(failure) });

        lose(restorer, makeRecord(), makeIncarnation(), makeChannel());
        timers.fireNext();
        await flush();

        const failed = events.at(-1);
        assert.ok(failed?.type === "consumer-restore-failed");
        assert.equal(failed.willRetry, true);
        assert.equal(timers.live().length, 1, "the next attempt is scheduled");
    });

    it("an attempt that returns a consumer for a subscription unsubscribed in the meantime reports nothing and leaves no timer", async () => {
        const record = makeRecord();
        const { restorer, timers, events } = setup({
            start: () => {
                record.active = false;
                return Promise.resolve(makeIncarnation());
            },
        });

        lose(restorer, record, makeIncarnation(), makeChannel());
        timers.fireNext();
        await flush();

        assert.deepEqual(
            events.map((event) => event.type),
            ["consumer-lost"],
        );
        assert.equal(timers.live().length, 0);
    });

    it("an attempt whose consumer is returned after the connection went down reports nothing and leaves no timer", async () => {
        let live: object | null = {};
        const { restorer, timers, events } = setup({
            liveModel: () => live,
            start: () => {
                live = null;
                return Promise.resolve(makeIncarnation());
            },
        });

        lose(restorer, makeRecord(), makeIncarnation(), makeChannel());
        timers.fireNext();
        await flush();

        assert.deepEqual(
            events.map((event) => event.type),
            ["consumer-lost"],
        );
        assert.equal(timers.live().length, 0);
    });
});

describe("createConsumerRestorer teardown and connection ownership", () => {
    it("stop() during the backoff cancels the attempt: nothing restarts", async () => {
        const { restorer, timers, events, started } = setup();
        const record = makeRecord();
        const channel = makeChannel();

        lose(restorer, record, makeIncarnation(), channel);
        record.active = false;
        restorer.stop(record);

        assert.equal(timers.live().length, 0);
        assert.equal(record.restore.timer, null);
        await flush();
        assert.equal(started.length, 0);
        assert.deepEqual(
            events.map((event) => event.type),
            ["consumer-lost"],
        );
    });

    it("stop() while an attempt is in flight keeps its late result from being reported", async () => {
        let finish: (incarnation: ConsumerIncarnation | null) => void = () => undefined;
        const { restorer, timers, events } = setup({
            start: () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        });
        const record = makeRecord();

        lose(restorer, record, makeIncarnation(), makeChannel());
        timers.fireNext();
        record.active = false;
        restorer.stop(record);
        finish(null);
        await flush();

        assert.deepEqual(
            events.map((event) => event.type),
            ["consumer-lost"],
        );
        assert.equal(timers.live().length, 0);
    });

    it("stop() clears the stability window and the attempt counter", async () => {
        const { restorer, timers } = setup();
        const record = makeRecord();

        lose(restorer, record, makeIncarnation(), makeChannel());
        timers.fireNext();
        await flush();
        const stability = timers.live().at(-1);
        assert.ok(stability);

        restorer.stop(record);

        assert.equal(stability.cleared, true);
        assert.equal(record.restore.attempt, 0);
        assert.equal(record.restore.stabilityTimer, null);
        assert.equal(timers.live().length, 0);
    });

    it("while no live connection is known a loss waits instead of scheduling, and resume() schedules it", () => {
        let live: object | null = null;
        const { restorer, timers } = setup({ liveModel: () => live });
        const record = makeRecord();

        lose(restorer, record, makeIncarnation(), makeChannel());
        assert.equal(timers.all.length, 0);
        assert.equal(record.restore.pending, true);

        live = {};
        restorer.resume([record]);

        assert.equal(record.restore.pending, false);
        assert.equal(timers.live().length, 1);
        assert.equal(timers.live()[0]?.delayMs, 100);
    });

    it("resume() leaves a subscription that has no waiting loss alone", () => {
        const { restorer, timers } = setup();

        restorer.resume([makeRecord()]);

        assert.equal(timers.all.length, 0);
    });

    it("a connection that went down while the delay ran: the attempt starts nothing and the loss waits", async () => {
        let live: object | null = {};
        const { restorer, timers, started } = setup({ liveModel: () => live });
        const record = makeRecord();

        lose(restorer, record, makeIncarnation(), makeChannel());
        live = null;
        timers.fireNext();
        await flush();

        assert.equal(started.length, 0);
        assert.equal(record.restore.pending, true);
    });
});
