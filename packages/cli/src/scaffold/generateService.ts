/**
 * `connectum generate service <name>` generators (OpenSpec change cli-scaffolding,
 * Phase 3). Scaffolds a service proto + a `defineService` skeleton with empty
 * handlers (D-6), optionally an event-handler `EventRoute` (`--with-events`), and
 * returns the manual registration edit to print (D-11 — the composition root is
 * user-owned and never edited).
 *
 * @module scaffold/generateService
 */

import { generateEventsOptionsProto } from "./eventsFragment.ts";

/** Proto/package-safe lowercase identifier (strips non-alphanumerics). */
export function packageName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** PascalCase from an arbitrary name (`my-service` -> `MyService`). */
export function pascalCase(name: string): string {
    return name
        .split(/[^a-zA-Z0-9]+/)
        .filter((p) => p.length > 0)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join("");
}

/** camelCase from an arbitrary name (`my-service` -> `myService`). */
export function camelCase(name: string): string {
    const p = pascalCase(name);
    return p.charAt(0).toLowerCase() + p.slice(1);
}

/** Generate the service proto (a starter with one demo rpc; optional event handler). */
export function generateServiceProto(name: string, withEvents: boolean): string {
    const pkg = packageName(name);
    const Svc = pascalCase(name);
    const eventsImport = withEvents ? 'import "google/protobuf/empty.proto";\nimport "connectum/events/v1/options.proto";\n\n' : "";
    const eventsBlock = withEvents
        ? `
// A demo event. Replace with your own event messages.
message ${Svc}Event {
  string id = 1;
}

// Event-handler service: one rpc per subscribed event, each returning Empty.
service ${Svc}EventHandlers {
  rpc On${Svc}Event(${Svc}Event) returns (google.protobuf.Empty) {
    option (connectum.events.v1.event).topic = "${pkg}.event";
  }
}
`
        : "";
    return `syntax = "proto3";

package ${pkg}.v1;

${eventsImport}message PingRequest {
  string message = 1;
}
message PingResponse {
  string message = 1;
}

service ${Svc}Service {
  rpc Ping(PingRequest) returns (PingResponse);
}
${eventsBlock}`;
}

/** Generate the service implementation module (`defineService` + optional EventRoute). */
export function generateServiceImpl(name: string, withEvents: boolean): string {
    const pkg = packageName(name);
    const Svc = pascalCase(name);
    const svcConst = `${camelCase(name)}Service`;
    const genPath = `#gen/${pkg}/v1/${pkg}_pb.ts`;

    const rpc = `import { defineService } from "@connectum/core";
import { Code, ConnectError } from "@connectrpc/connect";
import { ${Svc}Service } from "${genPath}";

export const ${svcConst} = defineService(${Svc}Service, {
    ping: (_req, _ctx) => {
        // TODO: implement Ping.
        throw new ConnectError("Ping not implemented", Code.Unimplemented);
    },
});
`;

    if (!withEvents) {
        return rpc;
    }

    const routesConst = `${camelCase(name)}EventRoutes`;
    return `${rpc}
import type { EventRoute } from "@connectum/events";
import { ${Svc}EventHandlers } from "${genPath}";

export const ${routesConst}: EventRoute = (events) => {
    events.service(${Svc}EventHandlers, {
        async on${Svc}Event(event, ctx) {
            // TODO: handle the ${Svc}Event event.
            console.log(\`[${svcConst}] ${Svc}Event: \${event.id}\`);
            await ctx.ack();
        },
    });
};
`;
}

/** Build the file map `generate service` emits (relative paths). */
export function buildServiceFiles(name: string, withEvents: boolean): Map<string, string> {
    const pkg = packageName(name);
    const files = new Map<string, string>([
        [`proto/${pkg}/v1/${pkg}.proto`, generateServiceProto(name, withEvents)],
        [`src/services/${camelCase(name)}Service.ts`, generateServiceImpl(name, withEvents)],
    ]);
    if (withEvents) {
        // The event proto imports the vendored option proto; emit it (skipped if present).
        files.set("proto/connectum/events/v1/options.proto", generateEventsOptionsProto());
    }
    return files;
}

/** The manual registration edit to print (D-11 — never edits server.ts). */
export function registrationMessage(name: string, withEvents: boolean): string {
    const svcConst = `${camelCase(name)}Service`;
    const genPath = `#services/${camelCase(name)}Service.ts`;
    const lines = [
        "Register the new service in src/server.ts:",
        `  import { ${svcConst} } from "${genPath}";`,
        `  // add ${svcConst} to the services: [...] array passed to createServer`,
    ];
    if (withEvents) {
        const routesConst = `${camelCase(name)}EventRoutes`;
        lines.push(
            "",
            "For the event handler, register it with your EventBus (requires @connectum/events):",
            `  import { ${routesConst} } from "${genPath}";`,
            `  // add ${routesConst} to the EventBus routes: [...] array`,
        );
    }
    lines.push("", "Then run: buf generate  (runs automatically on test/start)");
    return lines.join("\n");
}
