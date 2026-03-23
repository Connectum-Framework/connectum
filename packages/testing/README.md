# @connectum/testing

Testing utilities for the Connectum framework. Provides mock factories, assertion helpers, and a test server utility to eliminate boilerplate in ConnectRPC interceptor and service tests.

**Layer**: 2 (Testing Utilities) | **Node.js**: >=20.0.0 | **License**: Apache-2.0

## Installation

```bash
pnpm add -D @connectum/testing
```

**Peer dependencies**: `@connectrpc/connect`, `@bufbuild/protobuf`

## Quick Start

A typical interceptor unit test:

```typescript
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { Code } from '@connectrpc/connect';
import {
  createMockRequest,
  createMockNext,
  createMockNextError,
  createMockNextSlow,
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

    assert.strictEqual(next.mock.calls.length, 1);
    assert.deepStrictEqual(res.message, { value: 42 });
  });

  it('should abort slow responses with DeadlineExceeded', async () => {
    const req = createMockRequest();
    const next = createMockNextSlow(500);

    const handler = interceptor(next);

    await assert.rejects(() => handler(req), (err: unknown) => {
      assertConnectError(err, Code.DeadlineExceeded);
      return true;
    });
  });

  it('should propagate upstream errors unchanged', async () => {
    const req = createMockRequest();
    const next = createMockNextError(Code.NotFound, 'User not found');

    const handler = interceptor(next);

    await assert.rejects(() => handler(req), (err: unknown) => {
      assertConnectError(err, Code.NotFound, 'User not found');
      return true;
    });
  });
});
```

## API Reference

### Mock Request — `createMockRequest()`

Creates a mock ConnectRPC `UnaryRequest` for testing interceptors. All fields have sensible defaults.

```typescript
import { createMockRequest } from '@connectum/testing';

// Minimal — all defaults
const req = createMockRequest();
// → { url: 'http://localhost/test.TestService/TestMethod', stream: false, message: {}, ... }

// Custom service and message
const req = createMockRequest({
  service: 'myapp.UserService',
  method: 'GetUser',
  message: { id: '123' },
});

// Streaming request
const req = createMockRequest({ stream: true, message: createMockStream([{ id: '1' }, { id: '2' }]) });
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `service` | `string` | `'test.TestService'` | Service type name |
| `method` | `string` | `'TestMethod'` | Method name |
| `message` | `unknown` | `{}` | Request message payload |
| `stream` | `boolean` | `false` | Streaming request flag |
| `url` | `string` | Auto-generated | Request URL |
| `headers` | `Headers` | `new Headers()` | Request headers |

---

### Mock Next Functions — `createMockNext()`

Creates mock `next` handlers for interceptor testing. Returns `node:test` `mock.fn()` with spy capabilities.

```typescript
import { createMockNext, createMockNextError, createMockNextSlow } from '@connectum/testing';
import { Code } from '@connectrpc/connect';

// Success
const next = createMockNext();
const result = await handler(req, next);
assert.strictEqual(next.mock.calls.length, 1);

// Custom response message
const next = createMockNext({ message: { id: 1, name: 'Alice' } });

// Error
const next = createMockNextError(Code.Internal, 'Database error');

// Slow (for timeout testing)
const next = createMockNextSlow(200, { message: { result: 'late' } });
```

**Options (`MockNextOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `message` | `unknown` | `{ result: 'success' }` | Response message |
| `stream` | `boolean` | `false` | Streaming response flag |

---

### ConnectError Assertions — `assertConnectError()`

Type-safe assertion that narrows `error` to `ConnectError`. Checks the gRPC status code and optionally matches the message against a string or RegExp.

```typescript
import { assertConnectError } from '@connectum/testing';
import { Code } from '@connectrpc/connect';

// In rejects callback
await assert.rejects(() => handler(req, next), (err: unknown) => {
  assertConnectError(err, Code.InvalidArgument, /validation failed/i);
  return true;
});

// String pattern matching
assertConnectError(err, Code.NotFound, 'user not found');

// Code-only check (no message matching)
assertConnectError(err, Code.PermissionDenied);
```

---

### Protobuf Descriptor Mocks

Mock factories for `@bufbuild/protobuf` descriptor types. Produce structurally valid objects accepted by `toJson()`, `fromJson()`, and interceptor logic.

#### `createMockDescMessage()`

```typescript
import { createMockDescMessage } from '@connectum/testing';

const schema = createMockDescMessage('test.UserMessage', {
  fields: [
    { name: 'id', type: 'string' },
    { name: 'email', type: 'string' },
  ],
});

// Use in interceptor request
const req = createMockRequest({
  method: 'GetUser',
  message: { id: '123', email: 'test@example.com' },
});
req.method.input = schema;
req.method.output = schema;
```

**Options (`MockDescMessageOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `fields` | `Array<{ name, type?, fieldNumber? }>` | `[]` | Field definitions |
| `oneofs` | `string[]` | `[]` | Oneof group names |

#### `createMockDescField()`

```typescript
import { createMockDescField } from '@connectum/testing';

const passwordField = createMockDescField('password', { isSensitive: true });
const usernameField = createMockDescField('username');
const idField = createMockDescField('userId', { type: 'int32', fieldNumber: 1 });
```

**Options (`MockDescFieldOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `isSensitive` | `boolean` | `false` | Mark field as sensitive (for redact interceptor) |
| `fieldNumber` | `number` | Auto-incremented | Proto field number |
| `type` | `string` | `'string'` | Field scalar type |

#### `createMockDescMethod()`

```typescript
import { createMockDescMethod, createMockDescMessage } from '@connectum/testing';

const inputSchema = createMockDescMessage('test.LoginRequest');
const outputSchema = createMockDescMessage('test.LoginResponse');

const method = createMockDescMethod('Login', {
  input: inputSchema,
  output: outputSchema,
  useSensitiveRedaction: true,
});

// Streaming method
const streaming = createMockDescMethod('ListUsers', {
  kind: 'server_streaming',
});
```

**Options (`MockDescMethodOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `input` | `DescMessage` | Auto-generated | Input message descriptor |
| `output` | `DescMessage` | Auto-generated | Output message descriptor |
| `kind` | `string` | `'unary'` | Method kind (`unary`, `server_streaming`, `client_streaming`, `bidi_streaming`) |
| `useSensitiveRedaction` | `boolean` | `false` | Enable sensitive field redaction |

---

### Fake Service Descriptors

#### `createFakeService()` / `createFakeMethod()`

Create fake `DescService` and `DescMethod` descriptors for testing interceptors and utilities that iterate over service methods.

```typescript
import { createFakeService, createFakeMethod } from '@connectum/testing';

const svc = createFakeService({ typeName: 'acme.v1.UserService' });
const getUser = createFakeMethod(svc, 'GetUser', { register: true });
const listUsers = createFakeMethod(svc, 'ListUsers', {
  methodKind: 'server_streaming',
  register: true,
});
// svc.methods.length === 2
// svc.method.getUser === getUser
```

**Options (`FakeServiceOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `typeName` | `string` | `'test.v1.TestService'` | Service type name |
| `name` | `string` | Derived from typeName | Service short name |

**Options (`FakeMethodOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `methodKind` | `string` | `'unary'` | Method kind |
| `register` | `boolean` | `false` | Register method in `service.methods` |

---

### Streaming Helpers — `createMockStream()`

Creates a reusable `AsyncIterable` from a list of items.

```typescript
import { createMockStream } from '@connectum/testing';

// Simple stream
const stream = createMockStream([{ id: '1' }, { id: '2' }, { id: '3' }]);

// Slow stream (for timeout testing)
const stream = createMockStream([{ id: '1' }, { id: '2' }], { delayMs: 100 });

// In streaming interceptor test
const req = createMockRequest({
  stream: true,
  message: createMockStream([{ value: 'a' }, { value: 'b' }]),
});
```

---

### Test Server — `createTestServer()`

Starts a real ConnectRPC server on a random port for integration testing.

```typescript
import { createTestServer } from '@connectum/testing';
import { createClient } from '@connectrpc/connect';
import { MyService } from './gen/myservice_pb.js';

describe('MyService integration', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer({
      services: [myServiceRoutes],
      interceptors: [createValidationInterceptor()],
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it('should handle GetUser request', async () => {
    const client = createClient(MyService, server.transport);
    const response = await client.getUser({ id: '123' });
    assert.strictEqual(response.name, 'Test User');
  });
});
```

**Options (`CreateTestServerOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `services` | `unknown[]` | — | ConnectRPC service route handlers (required) |
| `interceptors` | `unknown[]` | `[]` | Interceptors to apply |
| `protocols` | `unknown[]` | `[]` | Protocol extensions (Healthcheck, Reflection) |
| `port` | `number` | `0` | Port number (0 = random) |

**`TestServer` interface:**

| Property | Type | Description |
|----------|------|-------------|
| `transport` | `Transport` | Pre-configured client transport |
| `baseUrl` | `string` | Server URL (e.g. `http://localhost:54321`) |
| `port` | `number` | Assigned port number |
| `close()` | `Promise<void>` | Stop server and close connections |

### Convenience Wrapper — `withTestServer()`

Manages server lifecycle automatically — starts before the test function, closes after (even on error).

```typescript
import { withTestServer } from '@connectum/testing';

it('should respond to health check', async () => {
  await withTestServer(
    {
      services: [myServiceRoutes],
      protocols: [Healthcheck({ httpEnabled: true })],
    },
    async (server) => {
      const res = await fetch(`${server.baseUrl}/healthz`);
      assert.strictEqual(res.status, 200);
    },
  );
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

## Architecture

- **Layer:** 2 (Tools) — depends on Layer 0 (@connectum/core) and external packages
- **Dependencies:** `@connectum/core`, `@connectrpc/connect`, `@bufbuild/protobuf`
- **Rationale:** Testing is a devDependency concern — production code must not pull test utilities ([ADR-003](https://github.com/Connectum-Framework/docs/blob/main/en/contributing/adr/003-package-decomposition.md))
- **Test runner:** `node:test` built-in ([ADR-007](https://github.com/Connectum-Framework/docs/blob/main/en/contributing/adr/007-testing-strategy.md))

## License

Apache-2.0
