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

/**
 * Build the `interceptors:` expression and the imports it needs, applying the
 * canonical order (outermost → innermost): otel → errorHandler → validation → ….
 * `createDefaultInterceptors()` already yields `errorHandler → validation`.
 */
function interceptorsExpr(config: ScaffoldConfig): { imports: string[]; expr: string } {
    const otel = config.modules.otel === true;
    const auth = config.modules.auth === true;
    const imports: string[] = [];
    const parts: string[] = [];

    // otel is outermost so the span covers the whole request (including errors).
    if (otel) {
        imports.push('import { createOtelInterceptor } from "@connectum/otel";');
        parts.push("createOtelInterceptor({ trustRemote: true })");
    }

    if (auth) {
        // Canonical order (D-3): otel -> errorHandler -> auth -> validation. An explicit
        // errorHandler goes under otel, then auth, then the default chain WITHOUT its own
        // errorHandler (so it is never duplicated).
        imports.push('import { createDefaultInterceptors, createErrorHandlerInterceptor } from "@connectum/interceptors";');
        imports.push('import { buildAuthInterceptors } from "#auth.ts";');
        parts.push("createErrorHandlerInterceptor()", "...buildAuthInterceptors()", "...createDefaultInterceptors({ errorHandler: false })");
        return { imports, expr: `[${parts.join(", ")}]` };
    }

    imports.push('import { createDefaultInterceptors } from "@connectum/interceptors";');
    if (parts.length > 0) {
        parts.push("...createDefaultInterceptors()");
        return { imports, expr: `[${parts.join(", ")}]` };
    }
    return { imports, expr: "createDefaultInterceptors()" };
}

/**
 * Generate `src/server.ts`.
 */
export function generateServer(config: ScaffoldConfig): string {
    const { imports: interceptorImports, expr } = interceptorsExpr(config);
    const events = config.modules.events !== undefined;
    const imports = [
        'import { createServer } from "@connectum/core";',
        'import type { Server } from "@connectum/core";',
        'import { Healthcheck } from "@connectum/healthcheck";',
        ...interceptorImports,
        'import { Reflection } from "@connectum/reflection";',
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
        protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
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
    const imports = [
        'import { healthcheckManager, ServingStatus } from "@connectum/healthcheck";',
        ...(otel ? ['import { initProvider, shutdownProvider } from "@connectum/otel";'] : []),
        'import { buildServer } from "#server.ts";',
    ];
    const initBlock = otel ? `\ninitProvider({ serviceName: ${JSON.stringify(config.name)} });\n` : "";
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
    healthcheckManager.update(ServingStatus.SERVING);
    console.log(\`${config.name} ready on \${addr?.address}:\${addr?.port}\`);
});

${stopHandler}
server.on("error", (err) => {
    console.error("server error:", err);
    process.exitCode = 1;
});

await server.start();
`;
}
