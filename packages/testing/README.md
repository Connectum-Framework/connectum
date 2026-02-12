# @connectum/testing

Testing utilities for Connectum framework.

> **Status:** Planned - This package is not yet implemented. This README serves as a specification for future implementation.

**@connectum/testing** is a collection of testing utilities for simplifying the writing of unit and integration tests for Connectum microservices.

## Planned Features

- **Mock Helpers**: createMockMessage, createMockField, createMockMethod for protobuf types
- **Test Server**: createTestServer for integration tests
- **Mock Interceptors**: mockInterceptor for test isolation
- **Assertions**: Custom assertions for ConnectRPC responses
- **Fixtures**: Ready-made test fixtures for common scenarios

## Installation

```bash
pnpm add -D @connectum/testing
```

**Peer dependencies**:

```bash
pnpm add -D @connectrpc/connect @bufbuild/protobuf
```

## Planned API

### Mock Helpers for Protobuf Types

**Problem:** @bufbuild/protobuf requires full metadata structure for DescMessage, DescField, DescMethod

**Solution:** Ready-made mock helpers with correct structure

#### createMockMessage

```typescript
import { createMockMessage } from '@connectum/testing';
import type { DescMessage } from '@bufbuild/protobuf';

// Create mock DescMessage with full metadata
const mockSchema: DescMessage = createMockMessage('test.UserMessage', {
  fields: [
    { name: 'id', type: 'string' },
    { name: 'email', type: 'string' },
  ]
});

// Used in interceptor tests
const interceptor = createSerializerInterceptor();
const mockReq = {
  method: {
    input: mockSchema,
    output: mockSchema,
  },
  message: { id: '123', email: 'test@example.com' },
};
```

**Implementation reference:** `packages/interceptors/tests/unit/serializer.test.ts:16-39`

**Signature:**
```typescript
function createMockMessage(
  typeName: string,
  options?: {
    fields?: Array<{ name: string; type: string }>;
    oneofs?: string[];
  }
): DescMessage;
```

#### createMockField

```typescript
import { createMockField } from '@connectum/testing';
import type { DescField } from '@bufbuild/protobuf';

// Create mock DescField with proto options
const passwordField: DescField = createMockField('password', {
  isSensitive: true,  // Sets sensitive extension
});

// Used in redact interceptor tests
const mockSchema = createMockMessage('test.LoginRequest', {
  fields: [passwordField, createMockField('username')],
});
```

**Implementation reference:** `packages/interceptors/tests/unit/redact.test.ts:19-39`

**Signature:**
```typescript
function createMockField(
  localName: string,
  options?: {
    isSensitive?: boolean;
    type?: string;
  }
): DescField;
```

#### createMockMethod

```typescript
import { createMockMethod } from '@connectum/testing';
import type { DescMethod } from '@bufbuild/protobuf';

// Create mock DescMethod with options
const mockMethod: DescMethod = createMockMethod('Login', {
  useSensitiveRedaction: true,  // Sets useSensitive extension
  input: mockInputSchema,
  output: mockOutputSchema,
});

// Used in tests
const mockReq = {
  method: mockMethod,
  message: { username: 'john', password: 'secret' },
};
```

**Implementation reference:** `packages/interceptors/tests/unit/redact.test.ts:60-80`

**Signature:**
```typescript
function createMockMethod(
  name: string,
  options?: {
    useSensitiveRedaction?: boolean;
    input?: DescMessage;
    output?: DescMessage;
  }
): DescMethod;
```

### Test Server for Integration Tests

**Problem:** Need a way to spin up a real ConnectRPC server for integration tests

**Solution:** createTestServer utility

```typescript
import { createTestServer } from '@connectum/testing';
import { myServiceRoutes } from './services';

describe('Integration tests', () => {
  it('should handle requests end-to-end', async () => {
    // Start test server
    const server = await createTestServer({
      routes: [myServiceRoutes],
      interceptors: [
        createValidationInterceptor(),
        createLoggerInterceptor({ level: 'silent' }),
      ],
    });

    // Make request
    const client = createPromiseClient(MyService, server.transport);
    const response = await client.getUser({ id: '123' });

    // Assertions
    assert.strictEqual(response.id, '123');

    // Cleanup
    await server.close();
  });
});
```

**Signature:**
```typescript
interface TestServer {
  transport: Transport;           // Client transport
  baseUrl: string;                // Server base URL
  close: () => Promise<void>;     // Cleanup
}

function createTestServer(options: {
  routes: Routes[];
  interceptors?: Interceptor[];
  port?: number;  // Random port if not specified
}): Promise<TestServer>;
```

### Mock Interceptor

**Problem:** Isolate tests from real interceptors

**Solution:** mockInterceptor for stubbing

```typescript
import { mockInterceptor } from '@connectum/testing';
import { mock } from 'node:test';

describe('Service tests', () => {
  it('should handle validation errors', async () => {
    const validationMock = mockInterceptor({
      type: 'validation',
      behavior: 'reject',
      error: new ConnectError('Validation failed', Code.InvalidArgument),
    });

    const server = await createTestServer({
      routes: [myServiceRoutes],
      interceptors: [validationMock],
    });

    // Test that service handles validation errors correctly
    await assert.rejects(
      () => client.createUser({ email: 'invalid' }),
      /Validation failed/
    );
  });
});
```

## Best Practices

### 1. Use the node:test Runner

Connectum uses the built-in `node:test` (no dependencies):

```typescript
import assert from 'node:assert';
import { describe, it, mock, beforeEach, afterEach } from 'node:test';

describe('myFunction', () => {
  it('should handle valid input', () => {
    const result = myFunction('valid');
    assert.strictEqual(result, 'expected');
  });

  it('should reject invalid input', () => {
    assert.throws(() => myFunction(null), /Invalid input/);
  });
});
```

### 2. Test Structure

```
packages/my-package/
├── src/
│   ├── index.ts
│   └── myService.ts
└── tests/
    ├── unit/           # Unit tests (isolated)
    │   └── myService.test.ts
    └── integration/    # Integration tests (full stack)
        └── full-chain.test.ts
```

### 3. Mock Only External Dependencies

**Rule:** Mock external dependencies (database, HTTP), do NOT mock internal code

```typescript
// GOOD - mock external database
import { mock } from 'node:test';

const dbMock = mock.fn(async (query) => {
  return { rows: [{ id: 1, name: 'Test' }] };
});

// BAD - mock internal functions
const myFunctionMock = mock.fn(() => 'fake result');
```

### 4. Cleanup After Tests

```typescript
describe('Server tests', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer({ routes: [myRoutes] });
  });

  afterEach(async () => {
    await server.close();  // CRITICAL: Always cleanup
  });

  it('should respond to requests', async () => {
    // Test code
  });
});
```

### 5. Use Descriptive Test Names

```typescript
// GOOD - descriptive name
it('should reject requests when circuit breaker is open', async () => {
  // Test code
});

// BAD - unclear name
it('should work', async () => {
  // Test code
});
```

### 6. Test Edge Cases

```typescript
describe('retry interceptor', () => {
  it('should succeed on first attempt', async () => { /* ... */ });
  it('should retry on ResourceExhausted', async () => { /* ... */ });
  it('should NOT retry on Internal error', async () => { /* ... */ });
  it('should stop after maxRetries', async () => { /* ... */ });
  it('should reject negative maxRetries', async () => { /* ... */ });
});
```

### 7. Assertion Style

```typescript
import assert from 'node:assert';

// Prefer strict equality
assert.strictEqual(result, expected);

// NOT loose equality
assert.equal(result, expected);  // BAD

// Deep object comparison
assert.deepStrictEqual(obj1, obj2);

// Error assertions
assert.throws(() => myFunction(), /Error message/);
await assert.rejects(async () => myAsyncFn(), /Error/);
```

## Running Tests

```bash
# All tests
pnpm test

# Unit tests only
pnpm test:unit

# Integration tests only
pnpm test:integration

# Specific package
pnpm --filter @connectum/my-package test

# With coverage
pnpm test -- --experimental-test-coverage
```

## Coverage Requirements

**Target:** 90%+ coverage for all packages

**Command:**
```bash
pnpm test -- --experimental-test-coverage
```

**CI enforcement:** Coverage threshold checked in CI pipeline

## Examples from Phase 4

### Interceptor Unit Test

See `packages/interceptors/tests/unit/serializer.test.ts` for a full example:

```typescript
import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { createSerializerInterceptor } from '../../src/serializer.ts';

describe('serializer interceptor', () => {
  it('should serialize unary request to JSON', async () => {
    const interceptor = createSerializerInterceptor();
    const mockSchema = createMockMessage('test.Message');

    const mockReq = {
      method: { input: mockSchema, output: mockSchema },
      message: { field: 'value' },
    };

    const next = mock.fn(async (req) => ({
      stream: false,
      message: { result: 'success' },
    }));

    const handler = interceptor(next);
    const result = await handler(mockReq);

    assert.strictEqual(next.mock.calls.length, 1);
    assert.strictEqual(result.message.result, 'success');
  });
});
```

### Integration Test

See `packages/interceptors/tests/integration/full-chain.test.ts`:

```typescript
describe('Full Interceptor Chain', () => {
  it('should process request through all interceptors', async () => {
    const interceptors = [
      createValidationInterceptor(),
      createSerializerInterceptor(),
      createLoggerInterceptor({ level: 'silent' }),
      createRetryInterceptor({ maxRetries: 3 }),
    ];

    const handler = interceptors.reduce(
      (next, interceptor) => interceptor(next),
      mockNext
    );

    const result = await handler(mockReq);
    assert.strictEqual(result.message.result, 'success');
  });
});
```

## Implementation Plan

**Priority:** Medium (after core packages are implemented)

**Tasks:**
1. Implement createMockMessage helper
2. Implement createMockField helper
3. Implement createMockMethod helper
4. Implement createTestServer utility
5. Implement mockInterceptor utility
6. Add TypeScript types
7. Write unit tests for utilities
8. Update documentation with real examples
9. Publish v0.1.0

**Target release:** v0.2.0-beta.1 or later

## License

MIT

## Related Packages

- [@connectum/interceptors](../interceptors/README.md) - Uses mock helpers in tests
- [@connectum/core](../runner/README.md) - Uses createTestServer in integration tests
