/**
 * Child-process server for the cross-process acceptance tests.
 *
 * It runs the streaming fixture service behind one authentication factory in
 * its own process, so a call reaches the handler only over a real socket and
 * the credential check (including a remote JWKS fetch) happens in a process
 * that shares no memory, event loop or AsyncLocalStorage with the client. The
 * parent drives it over the IPC channel.
 */

import {
    type AuthFactoryName,
    type AuthSetup,
    boot,
    buildEndlessRoutes,
    buildRoutes,
    createAuthSetup,
    createJwksInterceptor,
    createProbe,
    type Pace,
    type TestServer,
} from "./stream-context.ts";

export type RemoteRequest =
    | { type: "start"; factory: AuthFactoryName | "jwt-jwks"; routes: "finite" | Pace; jwksUri?: string; identities: string[] }
    | { type: "dump"; identities: string[] }
    | { type: "reset" }
    | { type: "stop" };

export type RemoteReply =
    | { type: "ready"; pid: number; port: number }
    | {
          type: "dump";
          observations: ReturnType<typeof createProbe>["observations"];
          cleanups: Array<[string, { count: number; seen: string | undefined; telemetry: string | undefined }]>;
          verifications: Record<string, number>;
      }
    | { type: "stopped" };

const probe = createProbe();
let server: TestServer | undefined;
let setup: AuthSetup | undefined;

function reply(message: RemoteReply): void {
    process.send?.(message);
}

process.on("message", async (raw: RemoteRequest) => {
    switch (raw.type) {
        case "start": {
            if (raw.factory === "jwt-jwks") {
                if (!raw.jwksUri) {
                    throw new Error("jwksUri is required for jwt-jwks");
                }
                setup = { name: "jwt-jwks", interceptor: createJwksInterceptor(raw.jwksUri), headersFor: async () => ({}), verifications: () => 0 };
            } else {
                setup = createAuthSetup(raw.factory, raw.identities);
            }
            const routes = raw.routes === "finite" ? buildRoutes(probe) : buildEndlessRoutes(probe, raw.routes);
            server = await boot({ interceptors: [setup.interceptor], routes });
            reply({ type: "ready", pid: process.pid, port: server.address?.port ?? 0 });
            break;
        }
        case "dump": {
            const verifications: Record<string, number> = {};
            for (const identity of raw.identities) {
                verifications[identity] = setup?.verifications(identity) ?? 0;
            }
            reply({ type: "dump", observations: [...probe.observations], cleanups: [...probe.cleanups.entries()], verifications });
            break;
        }
        case "reset":
            probe.reset();
            break;
        case "stop":
            await server?.stop();
            reply({ type: "stopped" });
            process.exit(0);
    }
});
