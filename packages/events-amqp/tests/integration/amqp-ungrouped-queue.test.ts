/**
 * A subscription without `group`, observed on live brokers.
 *
 * The queue it declares is private to the subscriber and goes away with it.
 * RabbitMQ 4.3 refuses a queue that is neither durable nor exclusive
 * (`transient_nonexcl_queues`), so the properties the adapter declares decide
 * whether such a subscription works at all. The brokers under test come from
 * `AMQP_UNGROUPED_BROKER_IMAGES` (comma separated); the default is the image
 * the rest of the suite uses.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import type { AmqpLifecycleEvent } from "../../src/types.ts";
import { RABBITMQ_IMAGE } from "./brokerImage.ts";

const RUN = process.env.RUN_RECOVERY_TESTS === "1";
const IMAGES = (process.env.AMQP_UNGROUPED_BROKER_IMAGES ?? RABBITMQ_IMAGE)
    .split(",")
    .map((image) => image.trim())
    .filter((image) => image !== "");

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: condition not met in time");
        }
        await sleep(100);
    }
}

interface QueueRow {
    readonly name: string;
    readonly durable: string;
    readonly autoDelete: string;
    readonly ownerPid: string;
}

for (const image of IMAGES) {
    describe(`AMQP subscription without a group on ${image} (testcontainers)`, { skip: RUN ? false : "RUN_RECOVERY_TESTS != 1", concurrency: 1 }, () => {
        let container: StartedTestContainer;
        let url: string;

        before(async () => {
            container = await new GenericContainer(image).withExposedPorts(5672).start();
            url = `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`;
        });

        after(async () => {
            await container?.stop();
        });

        async function listQueues(): Promise<QueueRow[]> {
            const { output } = await container.exec(["rabbitmqctl", "-q", "list_queues", "name", "durable", "auto_delete", "owner_pid"]);
            return output
                .split("\n")
                .map((line) => line.split("\t"))
                .filter((cells) => cells.length === 4)
                .map(([name, durable, autoDelete, ownerPid]) => ({ name: name ?? "", durable: durable ?? "", autoDelete: autoDelete ?? "", ownerPid: ownerPid ?? "" }));
        }

        it("receives a published event on a private queue that dies with its connection", async () => {
            const events: AmqpLifecycleEvent[] = [];
            const received: string[] = [];
            const adapter = AmqpAdapter({
                url,
                exchange: "ungrouped",
                exchangeType: "topic",
                recovery: false,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            await adapter.connect();
            try {
                await adapter.subscribe(["ungrouped.evt"], async (event) => {
                    received.push(new TextDecoder().decode(event.payload));
                });
                await adapter.publish("ungrouped.evt", new TextEncoder().encode("hello"));
                await waitFor(() => received.length === 1, 5_000);
                assert.deepEqual(received, ["hello"]);

                const rows = (await listQueues()).filter((row) => row.name.startsWith("ungrouped.sub-"));
                assert.equal(rows.length, 1, `one private queue: ${JSON.stringify(rows)}`);
                assert.equal(rows[0]?.durable, "false");
                assert.equal(rows[0]?.autoDelete, "true");
                assert.match(rows[0]?.ownerPid ?? "", /^<.+>$/, "the queue has an owning connection, so it is exclusive");
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }

            const deadline = Date.now() + 5_000;
            let remaining = (await listQueues()).filter((row) => row.name.startsWith("ungrouped.sub-"));
            while (remaining.length > 0 && Date.now() < deadline) {
                await sleep(200);
                remaining = (await listQueues()).filter((row) => row.name.startsWith("ungrouped.sub-"));
            }
            assert.deepEqual(remaining, [], "the private queue is gone once the subscriber disconnected");
        });
    });
}
