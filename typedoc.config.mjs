// TypeDoc configuration for the API reference (`pnpm docs:api`).
//
// With `entryPointStrategy: "packages"` every package is converted as a
// separate project and the results are merged. Conversion options set at the
// root are NOT inherited by those per-package conversions — only
// `packageOptions` (plus each package's own `typedoc.json`) apply there. That is
// why the exclusion and link options below live in `packageOptions`.

/**
 * Links for symbols that are referenced by the documented API but not part of
 * it (third-party types, and one generated enum). They are needed at both
 * levels: per package, so conversion and export validation see the symbols as
 * linked, and at the root, where the merged project re-resolves type references
 * and would otherwise render them as plain text.
 */
const externalSymbolLinkMappings = {
    "@opentelemetry/api": {
        Meter: "https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api._opentelemetry_api.Meter.html",
        Span: "https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api._opentelemetry_api.Span.html",
        Tracer: "https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api._opentelemetry_api.Tracer.html",
    },
    "@opentelemetry/api-logs": {
        Logger: "https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api-logs.Logger.html",
    },
    "@bufbuild/protobuf": {
        DescField: "https://protobufes.com/reference/reflection/descriptors/#field-descriptors",
        DescMessage: "https://protobufes.com/reference/reflection/descriptors/#types",
        DescMethod: "https://protobufes.com/reference/reflection/descriptors/#types",
        DescService: "https://protobufes.com/reference/reflection/descriptors/#types",
    },
    "@connectrpc/connect": {
        ConnectError: "https://connectrpc.com/docs/web/errors",
    },
    typescript: {
        AsyncIterable: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols#the_async_iterator_and_async_iterable_protocols",
    },
    // `ServingStatus` re-exports this generated enum; its source of truth is the
    // upstream gRPC Health Checking Protocol definition.
    "@connectum/healthcheck": {
        HealthCheckResponse_ServingStatus: "https://github.com/grpc/grpc-proto/blob/master/grpc/health/v1/health.proto",
    },
};

export default {
    entryPoints: [
        "packages/core",
        "packages/auth",
        "packages/interceptors",
        "packages/healthcheck",
        "packages/reflection",
        "packages/otel",
        "packages/cli",
        "packages/test-fixtures",
        "packages/testing",
        "packages/events",
        "packages/events-nats",
        "packages/events-kafka",
        "packages/events-redis",
        "packages/events-amqp",
        "packages/protoc-gen-catalog",
    ],
    entryPointStrategy: "packages",
    plugin: ["typedoc-plugin-markdown", "typedoc-vitepress-theme"],
    docsRoot: "../docs",
    out: "../docs/en/api",
    name: "Connectum API Reference",
    readme: "none",
    externalSymbolLinkMappings,
    // A warning is a broken or dangling reference in the published reference;
    // fail the run instead of shipping it.
    treatWarningsAsErrors: true,
    cleanOutputDir: true,
    packageOptions: {
        entryPoints: ["src/index.ts"],
        // Sources only: the type-check tsconfig also pulls in `packages/*/tests`,
        // whose `ConnectumCallMap` augmentations would leak fixture services into
        // the documented public interfaces.
        tsconfig: "../../tsconfig.typedoc.json",
        readme: "none",
        excludePrivate: true,
        excludeProtected: true,
        excludeInternal: true,
        // Only OpenTelemetry declarations count as external, so the `Meter` and
        // `Tracer` re-exports link to the upstream reference instead of copying
        // it (with its broken links). A broader pattern would also strip the
        // members that Connectum classes inherit from `@connectrpc/connect`.
        excludeExternals: true,
        externalPattern: ["**/node_modules/@opentelemetry/**"],
        externalSymbolLinkMappings,
    },
};
