/**
 * A TCP proxy in front of a broker that destroys a connection at a chosen
 * point of the AMQP conversation, so a "connection lost while the topology
 * setup runs" scenario is interrupted at the same frame on every run and no
 * test sleeps to win a race.
 *
 * Shared by the suites that need a deterministic cut: one runs against a
 * broker given by AMQP_TEST_URL, the other against a testcontainers broker.
 */

import net from "node:net";

const AMQP_EXCHANGE_CLASS = 40;
const AMQP_QUEUE_CLASS = 50;
const AMQP_DECLARE_METHOD = 10;
const AMQP_PROTOCOL_HEADER_LENGTH = 8;
const AMQP_FRAME_HEADER_LENGTH = 7;
const AMQP_METHOD_FRAME = 1;

export interface CuttingProxy {
    readonly port: number;
    /** Destroy the next connection whose client sends an `exchange.declare` or `queue.declare`, once. Resets {@link cuts}. */
    armCutAtNextDeclare(): void;
    /** How many connections have been destroyed by a cut since the last arming. */
    cuts(): number;
    /** Destroy every connection that is open right now (the broker "going away"). */
    dropAll(): void;
    close(): Promise<void>;
}

export async function startCuttingProxy(target: { host: string; port: number }): Promise<CuttingProxy> {
    let armed = false;
    let cuts = 0;
    const sockets = new Set<net.Socket>();

    const server = net.createServer((client) => {
        const upstream = net.connect(target.port, target.host);
        sockets.add(client);
        sockets.add(upstream);
        let clientBytes: Buffer = Buffer.alloc(0);
        let headerSkipped = false;

        /** True when the buffered client bytes contain a declare frame and a cut is armed. */
        const shouldCut = (chunk: Buffer): boolean => {
            clientBytes = Buffer.concat([clientBytes, chunk]);
            if (!headerSkipped) {
                if (clientBytes.length < AMQP_PROTOCOL_HEADER_LENGTH) {
                    return false;
                }
                clientBytes = clientBytes.subarray(AMQP_PROTOCOL_HEADER_LENGTH);
                headerSkipped = true;
            }
            while (clientBytes.length >= AMQP_FRAME_HEADER_LENGTH) {
                const size = clientBytes.readUInt32BE(3);
                const total = AMQP_FRAME_HEADER_LENGTH + size + 1;
                if (clientBytes.length < total) {
                    return false;
                }
                const isMethod = clientBytes[0] === AMQP_METHOD_FRAME && size >= 4;
                if (isMethod && armed) {
                    const classId = clientBytes.readUInt16BE(7);
                    const methodId = clientBytes.readUInt16BE(9);
                    if ((classId === AMQP_EXCHANGE_CLASS || classId === AMQP_QUEUE_CLASS) && methodId === AMQP_DECLARE_METHOD) {
                        return true;
                    }
                }
                clientBytes = clientBytes.subarray(total);
            }
            return false;
        };

        client.on("data", (chunk: Buffer) => {
            if (shouldCut(chunk)) {
                armed = false;
                cuts += 1;
                // The declare never reaches the broker: the client's request is pending when the socket dies.
                client.destroy();
                upstream.destroy();
                return;
            }
            upstream.write(chunk);
        });
        upstream.on("data", (chunk: Buffer) => {
            client.write(chunk);
        });
        const closeBoth = (): void => {
            client.destroy();
            upstream.destroy();
            sockets.delete(client);
            sockets.delete(upstream);
        };
        client.on("close", closeBoth);
        upstream.on("close", closeBoth);
        client.on("error", () => undefined);
        upstream.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    return {
        port,
        armCutAtNextDeclare() {
            armed = true;
            cuts = 0;
        },
        cuts: () => cuts,
        dropAll() {
            for (const socket of sockets) {
                socket.destroy();
            }
        },
        async close() {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
