/**
 * Generate the project's composition root (`src/server.ts`) and entry (`src/index.ts`)
 * from the resolved module set.
 *
 * This is where module wiring is composed — most importantly the **interceptor order**
 * (OpenSpec change cli-scaffolding, D-3, ratified otel-outermost): a single total order
 * across any module subset, not ad-hoc concatenation. For the base (no modules) the
 * output is functionally identical to the dogfooded `getting-started` server.
 *
 * @module scaffold/serverGen
 */

import type { ScaffoldConfig } from "./types.ts";

/** Render the `createDefaultInterceptors(...)` call with opt-in resilience + errorHandler flag. */
function defaultsCall(config: ScaffoldConfig, errorHandlerFalse: boolean): string {
    const parts: string[] = [];
    if (errorHandlerFalse) {
        parts.push("errorHandler: false");
    }
    for (const r of config.modules.resilience ?? []) {
        parts.push(`${r}: true`);
    }
    return parts.length > 0 ? `createDefaultInterceptors({ ${parts.join(", ")} })` : "createDefaultInterceptors()";
}

/**
 * Build the `interceptors:` expression + imports, applying the canonical order (D-3):
 * otel -> errorHandler -> auth -> validation. `createDefaultInterceptors()` already
 * yields `errorHandler -> validation` (+ opt-in resilience).
 */
function interceptorsExpr(config: ScaffoldConfig): { imports: string[]; expr: string } {
    const otel = config.modules.otel === true;
    const auth = config.modules.auth === true;
    const imports: string[] = [];
    const parts: string[] = [];

    if (otel) {
        imports.push('import { createOtelInterceptor } from "@connectum/otel";');
        parts.push("createOtelInterceptor({ trustRemote: true })");
    }

    if (auth) {
        imports.push('import { createDefaultInterceptors, createErrorHandlerInterceptor } from "@connectum/interceptors";');
        imports.push('import { buildAuthInterceptors } from "#auth.ts";');
        parts.push("createErrorHandlerInterceptor()", "...buildAuthInterceptors()", `...${defaultsCall(config, true)}`);
        return { imports, expr: `[${parts.join(", ")}]` };
    }

    imports.push('import { createDefaultInterceptors } from "@connectum/interceptors";');
    if (parts.length > 0) {
        parts.push(`...${defaultsCall(config, false)}`);
        return { imports, expr: `[${parts.join(", ")}]` };
    }
    return { imports, expr: defaultsCall(config, false) };
}

/** Build the `protocols:` expression + imports from the healthcheck/reflection toggles. */
function protocolsExpr(config: ScaffoldConfig): { imports: string[]; expr: string } {
    const imports: string[] = [];
    const parts: string[] = [];
    if (config.modules.healthcheck !== false) {
        imports.push('import { Healthcheck } from "@connectum/healthcheck";');
        parts.push("Healthcheck({ httpEnabled: true })");
    }
    if (config.modules.reflection !== false) {
        imports.push('import { Reflection } from "@connectum/reflection";');
        parts.push("Reflection()");
    }
    return { imports, expr: `[${parts.join(", ")}]` };
}

/**
 * Generate `src/server.ts`.
 */
export function generateServer(config: ScaffoldConfig): string {
    const { imports: interceptorImports, expr } = interceptorsExpr(config);
    const { imports: protocolImports, expr: protoExpr } = protocolsExpr(config);
    const events = config.modules.events !== undefined;
    const imports = [
        'import { createServer } from "@connectum/core";',
        'import type { Server } from "@connectum/core";',
        ...protocolImports,
        ...interceptorImports,
        ...(events ? ['import { greeterEventBus } from "#greeterEventBus.ts";'] : []),
        'import { greeterService } from "#services/greeterService.ts";',
    ];
    const eventBusLine = events ? "\n        eventBus: greeterEventBus," : "";
    return `/**
 * Server factory — services, health, reflection, interceptors, graceful shutdown.
 *
 * @module server
 */

${imports.join("\n")}

/**
 * Build a Connectum server hosting GreeterService.
 *
 * @param port - TCP port to bind (0 = random, for tests).
 * @param autoShutdown - install SIGTERM/SIGINT graceful-shutdown handlers.
 */
export function buildServer(port = 5000, autoShutdown = false): Server {
    return createServer({
        services: [greeterService],${eventBusLine}
        port,
        host: "0.0.0.0",
        allowHTTP1: false,
        protocols: ${protoExpr},
        interceptors: ${expr},
        shutdown: { autoShutdown, timeout: 10_000 },
    });
}
`;
}

/**
 * Generate `src/index.ts` (process entry).
 */
export function generateIndex(config: ScaffoldConfig): string {
    const otel = config.modules.otel === true;
    const healthcheck = config.modules.healthcheck !== false;
    const imports = [
        ...(healthcheck ? ['import { healthcheckManager, ServingStatus } from "@connectum/healthcheck";'] : []),
        ...(otel ? ['import { initProvider, shutdownProvider } from "@connectum/otel";'] : []),
        'import { buildServer } from "#server.ts";',
    ];
    const initBlock = otel ? `\ninitProvider({ serviceName: ${JSON.stringify(config.name)} });\n` : "";
    const readyLifecycle = healthcheck ? "    healthcheckManager.update(ServingStatus.SERVING);\n" : "";
    const stopHandler = otel
        ? `server.on("stop", async () => {\n    await shutdownProvider();\n    console.log("stopped");\n});`
        : `server.on("stop", () => console.log("stopped"));`;
    return `/**
 * Start the server.
 *
 * @module index
 */

${imports.join("\n")}
${initBlock}
const server = buildServer(Number(process.env.PORT ?? 5000), true);

server.on("ready", () => {
    const addr = server.address;
${readyLifecycle}    console.log(\`${config.name} ready on \${addr?.address}:\${addr?.port}\`);
});

${stopHandler}
server.on("error", (err) => {
    console.error("server error:", err);
    process.exitCode = 1;
});

await server.start();
`;
}
