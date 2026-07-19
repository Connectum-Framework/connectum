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
    const imports = ['import { createDefaultInterceptors } from "@connectum/interceptors";'];
    if (config.modules.otel) {
        imports.push('import { createOtelInterceptor } from "@connectum/otel";');
        // otel is outermost so the span covers the whole request (incl. errors).
        return { imports, expr: "[createOtelInterceptor({ trustRemote: true }), ...createDefaultInterceptors()]" };
    }
    return { imports, expr: "createDefaultInterceptors()" };
}

/**
 * Generate `src/server.ts`.
 */
export function generateServer(config: ScaffoldConfig): string {
    const { imports: interceptorImports, expr } = interceptorsExpr(config);
    const imports = [
        'import { createServer } from "@connectum/core";',
        'import type { Server } from "@connectum/core";',
        'import { Healthcheck } from "@connectum/healthcheck";',
        ...interceptorImports,
        'import { Reflection } from "@connectum/reflection";',
        'import { greeterService } from "#services/greeterService.ts";',
    ];
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
        services: [greeterService],
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
