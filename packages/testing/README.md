# @connectum/testing

Testing utilities for Connectum framework.

> **Status:** Planned — this package is not yet implemented. This README serves as a specification for future implementation.

**@connectum/testing** eliminates test boilerplate across Connectum packages by providing mock factories, assertion helpers, and a test server utility.

## Motivation

Analysis of the existing test suite revealed significant duplication:

| Pattern | Duplicates | Priority |
|---------|-----------|----------|
| Mock interceptor request | 50+ | P0 |
| Mock next function | 35+ | P0 |
| ConnectError assertions | 50+ | P0 |
| DescMessage/Field/Method mocks | 10+ | P1 |
| Streaming mock generators | 5+ | P1 |
| Test server lifecycle | 2+ | P2 |

**Design influenced by:** [connect-es](https://github.com/connectrpc/connect-es) (Jasmine, `useNodeServer`, service descriptor mocks) and [protobuf-es](https://github.com/bufbuild/protobuf-es) (`node:test`, descriptor-driven tests, parameterized test cases).

## Installation

```bash
pnpm add -D @connectum/testing
```

**Peer dependencies:**

```bash
pnpm add -D @connectrpc/connect @bufbuild/protobuf
```

## API Reference

### Mock Request — `createMockRequest()`

Creates a mock interceptor request object. Eliminates the most common boilerplate (50+ duplicates).

```typescript
import type { Code } from '@connectrpc/connect';

interface MockRequestOptions {
  /** Service type name. Default: `'test.TestService'` */
  service?: string;
  /** Method name. Default: `'TestMethod'` */
  method?: string;
  /** Request message payload. Default: `{}` */
  message?: unknown;
  /** Streaming request flag. Default: `false` */
  stream?: boolean;
  /** Request URL. Auto-generated from service/method if omitted */
  url?: string;
  /** Request headers. Default: `new Headers()` */
  headers?: Headers;
}

function createMockRequest(options?: MockRequestOptions): UnaryRequest;
```

**Usage:**

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
const req = createMockRequest({ stream: true, message: createMockStream({ id: '1' }, { id: '2' }) });
```

**Replaces this boilerplate:**

```typescript
// BEFORE (repeated 50+ times across tests)
const mockReq = {
  url: 'http://localhost/test.Service/Method',
  stream: false,
  message: { field: 'value' },
  service: { typeName: 'test.Service' },
  method: { name: 'Method' },
  header: new Headers(),
} as any;

// AFTER
const mockReq = createMockRequest({ message: { field: 'value' } });
```

---

### Mock Next Function — `createMockNext()`

Creates mock `next` functions for interceptor testing. Returns `node:test` `mock.fn()` with spy capabilities (call count, arguments tracking).

```typescript
import type { MockFunction } from 'node:test';

interface MockNextOptions {
  /** Response message. Default: `{ result: 'success' }` */
  message?: unknown;
  /** Streaming response flag. Default: `false` */
  stream?: boolean;
}

/** Returns a successful response */
function createMockNext(options?: MockNextOptions): MockFunction;

/** Throws a ConnectError */
function createMockNextError(code: Code, message?: string): MockFunction;

/** Responds after a delay (for timeout/retry testing) */
function createMockNextSlow(delay: number, options?: MockNextOptions): MockFunction;
```

**Usage:**

```typescript
import { createMockNext, createMockNextError, createMockNextSlow } from '@connectum/testing';
import { Code } from '@connectrpc/connect';

// Success
const next = createMockNext();
const result = await handler(req, next);
assert.strictEqual(next.mock.calls.length, 1);

// Error
const next = createMockNextError(Code.Internal, 'Database error');

// Slow (for timeout testing)
const next = createMockNextSlow(200, { message: { result: 'late' } });
```

**Replaces this boilerplate:**

```typescript
// BEFORE (repeated 35+ times)
const next = mock.fn(async () => ({
  stream: false,
  message: { result: 'success' },
}));

// AFTER
const next = createMockNext();
```

---

### ConnectError Assertions — `assertConnectError()`

Type-safe assertion for ConnectError with code and optional message pattern matching.

```typescript
/**
 * Asserts that `error` is a ConnectError with the expected code.
 * Optionally matches the error message against a string or RegExp.
 * Narrows the type to ConnectError via `asserts`.
 */
function assertConnectError(
  error: unknown,
  expectedCode: Code,
  messagePattern?: string | RegExp,
): asserts error is ConnectError;
```

**Usage:**

```typescript
import { assertConnectError } from '@connectum/testing';
import { Code } from '@connectrpc/connect';

// In rejects callback
await assert.rejects(() => handler(req, next), (err: unknown) => {
  assertConnectError(err, Code.InvalidArgument, /validation failed/i);
  return true;
});
```

**Replaces this boilerplate:**

```typescript
// BEFORE (repeated 50+ times)
await assert.rejects(() => handler(mockReq), (err: unknown) => {
  assert(err instanceof ConnectError);
  assert.strictEqual((err as ConnectError).code, Code.Internal);
  assert((err as ConnectError).message.includes('expected text'));
  return true;
});

// AFTER
await assert.rejects(() => handler(req, next), (err: unknown) => {
  assertConnectError(err, Code.Internal, 'expected text');
  return true;
});
```

---

### Protobuf Descriptor Mocks

Mock factories for `@bufbuild/protobuf` descriptor types. These produce structurally valid objects accepted by `toJson()`, `fromJson()`, and interceptor logic.

#### `createMockDescMessage()`

```typescript
interface MockDescMessageOptions {
  /** Field definitions. Default: `[]` */
  fields?: Array<{
    name: string;
    type?: string;
    fieldNumber?: number;
  }>;
  /** Oneof group names. Default: `[]` */
  oneofs?: string[];
}

/**
 * Creates a mock DescMessage with full protobuf metadata.
 * Includes required properties: kind, typeName, name, fields, field,
 * oneofs, members, nestedEnums, nestedMessages, nestedExtensions,
 * parent, proto, file.
 */
function createMockDescMessage(
  typeName: string,
  options?: MockDescMessageOptions,
): DescMessage;
```

**Usage:**

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
// Attach schema to method descriptor
req.method.input = schema;
req.method.output = schema;
```

**Replaces this boilerplate:**

```typescript
// BEFORE (20 lines per mock, repeated 10+ times)
const schema = {
  kind: 'message',
  typeName: 'test.UserMessage',
  name: 'UserMessage',
  fields: [],
  field: {},
  oneofs: [],
  members: [],
  nestedEnums: [],
  nestedMessages: [],
  nestedExtensions: [],
  parent: undefined,
  proto: { options: undefined },
  file: { name: 'test.proto', proto: { edition: 'EDITION_PROTO3' } },
} as any as DescMessage;

// AFTER
const schema = createMockDescMessage('test.UserMessage');
```

#### `createMockDescField()`

```typescript
interface MockDescFieldOptions {
  /** Mark field as sensitive (for redact interceptor). Default: `false` */
  isSensitive?: boolean;
  /** Proto field number. Default: auto-incremented */
  fieldNumber?: number;
  /** Field scalar type. Default: `'string'` */
  type?: string;
}

function createMockDescField(
  localName: string,
  options?: MockDescFieldOptions,
): DescField;
```

**Usage:**

```typescript
import { createMockDescField } from '@connectum/testing';

const passwordField = createMockDescField('password', { isSensitive: true });
const usernameField = createMockDescField('username');
```

#### `createMockDescMethod()`

```typescript
interface MockDescMethodOptions {
  /** Input message descriptor */
  input?: DescMessage;
  /** Output message descriptor */
  output?: DescMessage;
  /** Method kind. Default: `'unary'` */
  kind?: 'unary' | 'server_streaming' | 'client_streaming' | 'bidi_streaming';
  /** Enable sensitive field redaction for this method. Default: `false` */
  useSensitiveRedaction?: boolean;
}

function createMockDescMethod(
  name: string,
  options?: MockDescMethodOptions,
): DescMethod;
```

**Usage:**

```typescript
import { createMockDescMethod, createMockDescMessage } from '@connectum/testing';

const inputSchema = createMockDescMessage('test.LoginRequest');
const outputSchema = createMockDescMessage('test.LoginResponse');

const method = createMockDescMethod('Login', {
  input: inputSchema,
  output: outputSchema,
  useSensitiveRedaction: true,
});
```

---

### Streaming Helpers — `createMockStream()`

Creates an `AsyncIterable` from a list of items. Useful for testing streaming interceptors.

```typescript
/**
 * Creates an AsyncIterable that yields items sequentially.
 * Optionally inserts a delay between items.
 */
function createMockStream<T>(
  items: T[],
  options?: { delayMs?: number },
): AsyncIterable<T>;
```

**Usage:**

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

**Replaces this boilerplate:**

```typescript
// BEFORE
async function* mockResStream() {
  yield { result: 'chunk1' };
  yield { result: 'chunk2' };
}

// AFTER
const stream = createMockStream([{ result: 'chunk1' }, { result: 'chunk2' }]);
```

---

### Test Server — `createTestServer()`

Starts a real ConnectRPC server on a random port for integration testing. Inspired by `useNodeServer()` from connect-es.

```typescript
interface TestServer {
  /** Pre-configured client transport connected to the test server */
  transport: Transport;
  /** Server base URL (e.g. `http://localhost:54321`) */
  baseUrl: string;
  /** Assigned port number */
  port: number;
  /** Stop the server and close all connections */
  close(): Promise<void>;
}

interface CreateTestServerOptions {
  /** ConnectRPC service route handlers */
  services: ServiceRoute[];
  /** Interceptors to apply. Default: `[]` */
  interceptors?: Interceptor[];
  /** Protocol extensions (Healthcheck, Reflection). Default: `[]` */
  protocols?: Protocol[];
  /** Port number. Default: `0` (random available port) */
  port?: number;
}

function createTestServer(options: CreateTestServerOptions): Promise<TestServer>;
```

**Usage:**

```typescript
import { createTestServer } from '@connectum/testing';
import { createPromiseClient } from '@connectrpc/connect';
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
    const client = createPromiseClient(MyService, server.transport);
    const response = await client.getUser({ id: '123' });
    assert.strictEqual(response.name, 'Test User');
  });
});
```

### Convenience Wrapper — `withTestServer()`

Manages server lifecycle automatically — starts before the test function, closes after (even on error).

```typescript
/**
 * Creates a test server, runs the test function, and ensures cleanup.
 * Equivalent to try/finally with createTestServer + close.
 */
function withTestServer<T>(
  options: CreateTestServerOptions,
  testFn: (server: TestServer) => Promise<T>,
): Promise<T>;
```

**Usage:**

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

---

## Complete Example

A typical interceptor unit test using @connectum/testing utilities:

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

## Architecture

- **Layer:** 2 (Tools) — depends on Layer 0 (@connectum/core) and external packages
- **Dependencies:** `@connectum/core`, `@connectrpc/connect`, `@bufbuild/protobuf`
- **Rationale:** Testing is a devDependency concern — production code must not pull test utilities ([ADR-003](https://github.com/Connectum-Framework/docs/blob/main/en/contributing/adr/003-package-decomposition.md))
- **Test runner:** `node:test` built-in ([ADR-007](https://github.com/Connectum-Framework/docs/blob/main/en/contributing/adr/007-testing-strategy.md))

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Mock objects vs runtime proto compilation | Mock objects | No protoc/buf dependency at test time; matches existing codebase patterns; simpler |
| `mock.fn()` in createMockNext | Yes (node:test) | Spy capabilities (call count, args) needed; node:test is the project standard |
| Both createTestServer + withTestServer | Yes | Different use cases: beforeEach/afterEach vs single-test convenience |
| No re-exports of Code/ConnectError | Correct | Users import directly from @connectrpc/connect; avoids coupling |
| `createMock*` naming | `create` prefix | Consistent with existing codebase (`createServer`, `createDefaultInterceptors`) |

## Implementation Plan

| Phase | Scope | Depends on |
|-------|-------|-----------|
| 1 | `createMockRequest`, `createMockNext*`, `assertConnectError` | — |
| 2 | `createMockDescMessage`, `createMockDescField`, `createMockDescMethod`, `createMockStream` | — |
| 3 | `createTestServer`, `withTestServer` | @connectum/core |
| 4 | Migrate existing tests in interceptors/core/otel to use @connectum/testing | Phases 1-3 |

## Running Tests

```bash
pnpm test                                         # All tests
pnpm test:unit                                    # Unit tests only
pnpm --filter @connectum/testing test             # This package only
pnpm test -- --experimental-test-coverage         # With coverage
```

## License

Apache-2.0

## References

- [ADR-003: Package Decomposition](https://github.com/Connectum-Framework/docs/blob/main/en/contributing/adr/003-package-decomposition.md)
- [ADR-007: Testing Strategy](https://github.com/Connectum-Framework/docs/blob/main/en/contributing/adr/007-testing-strategy.md)
- [connect-es testing patterns](https://github.com/connectrpc/connect-es) — Jasmine, `useNodeServer()`, service descriptor mocks
- [protobuf-es testing patterns](https://github.com/bufbuild/protobuf-es) — `node:test`, descriptor-driven tests, runtime proto compilation
