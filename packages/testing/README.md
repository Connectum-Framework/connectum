# @connectum/testing

This README describes the 1.3.x source; that release is not yet published to npm.

Utilities for testing Connectum services and interceptors, including mocks,
in-process clients, transport-parity scenarios, and in-memory telemetry
collectors.

## Install

```bash
pnpm add -D \
  @connectum/testing @connectum/interceptors @connectum/core \
  @bufbuild/protobuf @connectrpc/connect @connectrpc/connect-node tsx
```

This installs the published package versions, not the unreleased 1.3.x source
described in this README. Use this command for the documented 1.3.x API after
that version is published.

The package requires Node.js `>=22.13.0`. Its peer dependencies are
`@bufbuild/protobuf` `^2.16.0`, `@connectrpc/connect` `^2.2.0`, and
`@connectrpc/connect-node` `^2.2.0`; keep these shared with the application.
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

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/testing)
- [Testing guide](https://connectum.dev/en/guide/testing)
- [API reference](https://connectum.dev/en/api/@connectum/testing/)

## License

Apache-2.0
