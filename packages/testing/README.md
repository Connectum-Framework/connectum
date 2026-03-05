# @connectum/testing

Testing utilities for the Connectum framework. Provides mock factories, assertion helpers, and a test server utility to eliminate boilerplate in ConnectRPC interceptor and service tests.

**Layer**: 2 (Testing Utilities) | **Node.js**: >=18.0.0 | **License**: Apache-2.0

## Installation

```bash
pnpm add -D @connectum/testing
```

**Peer dependencies**: `@connectrpc/connect`, `@bufbuild/protobuf`

## Quick Start

```typescript
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { Code } from '@connectrpc/connect';
import {
  createMockRequest,
  createMockNext,
  createMockNextError,
  assertConnectError,
} from '@connectum/testing';
import { createTimeoutInterceptor } from '@connectum/interceptors';

describe('timeout interceptor', () => {
  const interceptor = createTimeoutInterceptor({ duration: 100 });

  it('should pass through fast responses', async () => {
    const req = createMockRequest();
    const next = createMockNext({ message: { value: 42 } });
    const handler = interceptor(next);
    const res = await handler(req);
    assert.deepStrictEqual(res.message, { value: 42 });
  });

  it('should abort slow responses', async () => {
    const req = createMockRequest();
    const next = createMockNextSlow(500);
    const handler = interceptor(next);
    await assert.rejects(() => handler(req), (err: unknown) => {
      assertConnectError(err, Code.DeadlineExceeded);
      return true;
    });
  });
});
```

## API Overview

| Function | Description |
|----------|-------------|
| `createMockRequest(options?)` | Mock ConnectRPC unary request for interceptor testing |
| `createMockNext(options?)` | Mock `next` handler returning a successful response (spy) |
| `createMockNextError(code, message?)` | Mock `next` handler that throws a `ConnectError` (spy) |
| `createMockNextSlow(delay, options?)` | Mock `next` handler with configurable delay (spy) |
| `assertConnectError(error, code, pattern?)` | Type-safe `ConnectError` assertion with code and message matching |
| `createMockDescMessage(typeName, options?)` | Mock protobuf `DescMessage` descriptor |
| `createMockDescField(localName, options?)` | Mock protobuf `DescField` descriptor |
| `createMockDescMethod(name, options?)` | Mock protobuf `DescMethod` descriptor |
| `createFakeService(options?)` | Fake `DescService` for testing |
| `createFakeMethod(service, name, options?)` | Fake `DescMethod` attached to a service |
| `createMockStream(items, options?)` | Mock `AsyncIterable` stream |
| `createTestServer(options)` | Start a real test server on a random port |
| `withTestServer(options, testFn)` | Auto-managed test server lifecycle |

## Test Server

For integration testing, `createTestServer` starts a real ConnectRPC server:

```typescript
import { createTestServer, withTestServer } from '@connectum/testing';
import { createClient } from '@connectrpc/connect';
import { MyService } from './gen/myservice_pb.js';

// Manual lifecycle
const server = await createTestServer({ services: [myRoutes] });
const client = createClient(MyService, server.transport);
const response = await client.getUser({ id: '123' });
await server.close();

// Auto-managed lifecycle
await withTestServer({ services: [myRoutes] }, async (server) => {
  const client = createClient(MyService, server.transport);
  const res = await client.getUser({ id: '1' });
  assert.strictEqual(res.name, 'Test User');
});
```

## Running Tests

```bash
pnpm --filter @connectum/testing test    # This package only
pnpm test                                 # All packages
```

## Documentation

- [Package Documentation](https://connectum-framework.github.io/docs/en/packages/testing)
- [API Reference](https://connectum-framework.github.io/docs/en/api/@connectum/testing/)
- [Testing Guide](https://connectum-framework.github.io/docs/en/guide/testing)

## License

Apache-2.0
