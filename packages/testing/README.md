# @connectum/testing

This README documents `@connectum/testing` 1.3 and later.

Utilities for testing Connectum services and interceptors, including mocks,
in-process clients, transport-parity scenarios, and in-memory telemetry
collectors.

## Install

```bash
pnpm add -D \
  @connectum/testing @connectum/interceptors @connectum/core \
  @bufbuild/protobuf @connectrpc/connect @connectrpc/connect-node tsx
```

Install version 1.3 or later to get the API documented in this README.

The package requires Node.js `>=22.13.0`. Its peer dependencies are
`@bufbuild/protobuf` `^2.16.0`, `@connectrpc/connect` `^2.3.0`, and
`@connectrpc/connect-node` `^2.3.0`; keep these shared with the application.
See [peer dependency guidance](https://connectum.dev/en/migration/peer-dependencies).

## Start here

This test uses the built-in `node:test` runner and verifies that a timeout
interceptor passes through a fast response and rejects a slow one.

```typescript
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { Code } from '@connectrpc/connect';
import {
  assertConnectError,
  createMockNext,
  createMockNextSlow,
  createMockRequest,
} from '@connectum/testing';
import { createTimeoutInterceptor } from '@connectum/interceptors';

describe('timeout interceptor', () => {
  const interceptor = createTimeoutInterceptor({ duration: 100 });

  it('passes through a fast response', async () => {
    const request = createMockRequest();
    const next = createMockNext({ message: { value: 42 } });
    const response = await interceptor(next)(request);

    assert.strictEqual(next.mock.calls.length, 1);
    assert.deepStrictEqual(response.message, { value: 42 });
  });

  it('rejects a slow response with DeadlineExceeded', async () => {
    const request = createMockRequest();
    const next = createMockNextSlow(500);

    await assert.rejects(() => interceptor(next)(request), (error: unknown) => {
      assertConnectError(error, Code.DeadlineExceeded);
      return true;
    });
  });
});
```

Save the example as `tests/timeout.test.ts` in a TypeScript project with the
dependencies above. Run it with `pnpm exec node --import tsx --test
tests/timeout.test.ts`. `@connectum/testing` supplies test helpers and is not
intended as a production service dependency.

## Spans and metrics of `@connectum/otel` in a test

`@connectum/otel` keeps the tracer it created for the provider that was
registered when it first recorded something, so a scenario that only registers
its collector sees spans in the first test of a process and nothing after it.
Let the helper do the whole sequence (reset the provider, register the
collectors, unregister them when the scenario ends, even if it throws):

```typescript
import { createOtelInterceptor, shutdownProvider } from '@connectum/otel';
import { transportParityTest } from '@connectum/testing/parity';

// OTEL_TRACES_EXPORTER=none and OTEL_METRICS_EXPORTER=none must be set.
transportParityTest('Greeter.sayHello emits the same span on both transports', {
  services: [greeterRoutes],
  interceptors: [createOtelInterceptor()],
  telemetry: { shutdownProvider },
  scenario: async ({ transport, spans }) => {
    await createClient(GreeterService, transport).sayHello({ name: 'world' });
    return { spans: spans.flush() };
  },
});
```

Outside the parity driver, `withTelemetry({ shutdownProvider }, async ({ spans,
metrics }) => { ... })` does the same around any body. The registrations are process-wide, so
scenarios that use telemetry must run one after another; an overlapping one is
refused with an error. Without `telemetry` the parity driver changes nothing, and `shutdownProvider` is passed in so that this
package does not depend on `@connectum/otel`. Two empty results still compare
as equal: assert that `spans.flush()` is not empty before you return it.

## Catalog calls (`ctx.call`, `ctx.stream`) in a parity scenario

A handler that calls another service through the service catalog goes through
the same dispatch on both transports. Give the driver the catalog and, for
services that run elsewhere, the resolver; both servers receive them as
`createServer({ catalog, remoteResolver })` would:

```typescript
import { serviceCatalog } from './gen/catalog.gen.ts'; // from protoc-gen-connectum-catalog
import { mapResolver } from '@connectum/core';
import { transportParityTest } from '@connectum/testing/parity';

transportParityTest('Orders.createOrder reaches Inventory identically', {
  services: [ordersService],            // Inventory is not mounted here
  catalog: serviceCatalog,
  remoteResolver: mapResolver({ 'shop.v1.InventoryService': inventoryTransport }),
  scenario: async ({ transport }) => {
    const order = await createClient(OrdersService, transport).createOrder({ sku: 'A-1' });
    return { response: { orderId: order.orderId } };
  },
});
```

A service that is in `services` is called in-process; any other catalog service
goes through `remoteResolver`. The resolver is called by both runs, so start the
remote service once for the whole test (for example in `before`) and reset what
it records between the runs. The package's own tests run this on a catalog
generated by `buf`, in three configurations (target on the same server, target on
another server, and a chain of two remote hops).

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/testing)
- [Testing guide](https://connectum.dev/en/guide/testing)
- [API reference](https://connectum.dev/en/api/@connectum/testing/)

## License

Apache-2.0
