/**
 * Consumer process that the per-batch crash test kills with SIGKILL.
 *
 * It joins `GROUP` on `TOPIC` with `commitStrategy: "per-batch"`, acknowledges the first `ACKS`
 * messages of the batch it fetched, and then blocks forever inside the handler of the next one,
 * after printing `READY`. At that moment the acknowledgements exist only in this process: a
 * per-batch adapter has not sent them to the broker because the batch has not ended. The parent
 * test reads `READY` and kills the process, which is the death between `ack()` and the end of the
 * batch that the commit strategy's documentation warns about.
 *
 * Configuration comes from the environment: KAFKA_TEST_URL, TOPIC, GROUP, ACKS.
 */

import { KafkaAdapter } from "../../src/KafkaAdapter.ts";

const brokers = (process.env.KAFKA_TEST_URL ?? "").split(",").map((broker) => broker.trim());
const topic = process.env.TOPIC ?? "";
const group = process.env.GROUP ?? "";
const acks = Number(process.env.ACKS);

const adapter = KafkaAdapter({
    brokers,
    clientId: `per-batch-victim-${process.pid}`,
    logLevel: "error",
    consumerOptions: { fromBeginning: true, sessionTimeout: 6_000, commitStrategy: "per-batch", redeliveryDelay: 0 },
});

let delivered = 0;
await adapter.connect();
await adapter.subscribe(
    [topic],
    async (_event, ack) => {
        delivered += 1;
        if (delivered <= acks) {
            await ack();
            return;
        }
        process.stdout.write("READY\n");
        await new Promise<never>(() => undefined);
    },
    { group },
);
