# @connectum/testing

Testing utilities for Connectum framework.

> **Status:** 🚧 **Planned** - Пакет еще не реализован. Этот README служит спецификацией для будущей реализации.

**@connectum/testing** — это коллекция testing utilities для упрощения написания unit и integration тестов для Connectum микросервисов.

## Планируемые возможности

- **Mock Helpers**: createMockMessage, createMockField, createMockMethod для protobuf types
- **Test Server**: createTestServer для integration тестов
- **Mock Interceptors**: mockInterceptor для изоляции тестов
- **Assertions**: Кастомные assertions для ConnectRPC responses
- **Fixtures**: Готовые test fixtures для common scenarios

## Установка

```bash
pnpm add -D @connectum/testing
```

**Peer dependencies**:

```bash
pnpm add -D @connectrpc/connect @bufbuild/protobuf
```

## Planned API

### Mock Helpers для Protobuf Types

**Проблема:** @bufbuild/protobuf требует полную metadata структуру для DescMessage, DescField, DescMethod

**Решение:** Готовые mock helpers с правильной структурой

#### createMockMessage

```typescript
import { createMockMessage } from '@connectum/testing';
import type { DescMessage } from '@bufbuild/protobuf';

// Create mock DescMessage с full metadata
const mockSchema: DescMessage = createMockMessage('test.UserMessage', {
  fields: [
    { name: 'id', type: 'string' },
    { name: 'email', type: 'string' },
  ]
});

// Используется в тестах interceptors
const interceptor = createSerializerInterceptor();
const mockReq = {
  method: {
    input: mockSchema,
    output: mockSchema,
  },
  message: { id: '123', email: 'test@example.com' },
};
```

**Реализация reference:** `packages/interceptors/tests/unit/serializer.test.ts:16-39`

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

// Create mock DescField с proto options
const passwordField: DescField = createMockField('password', {
  isSensitive: true,  // Sets sensitive extension
});

// Используется в тестах redact interceptor
const mockSchema = createMockMessage('test.LoginRequest', {
  fields: [passwordField, createMockField('username')],
});
```

**Реализация reference:** `packages/interceptors/tests/unit/redact.test.ts:19-39`

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

// Create mock DescMethod с options
const mockMethod: DescMethod = createMockMethod('Login', {
  useSensitiveRedaction: true,  // Sets useSensitive extension
  input: mockInputSchema,
  output: mockOutputSchema,
});

// Используется в тестах
const mockReq = {
  method: mockMethod,
  message: { username: 'john', password: 'secret' },
};
```

**Реализация reference:** `packages/interceptors/tests/unit/redact.test.ts:60-80`

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

### Test Server для Integration Tests

**Проблема:** Нужен способ поднять реальный ConnectRPC server для integration тестов

**Решение:** createTestServer utility

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

**Проблема:** Изолировать тесты от реальных interceptors

**Решение:** mockInterceptor для stubbing

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

### 1. Используй node:test Runner

Connectum использует встроенный `node:test` (no dependencies):

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

### 2. Структура тестов

```
packages/my-package/
├── src/
│   ├── index.ts
│   └── myService.ts
└── tests/
    ├── unit/           # Unit tests (изолированные)
    │   └── myService.test.ts
    └── integration/    # Integration tests (полный stack)
        └── full-chain.test.ts
```

### 3. Mock только external dependencies

**Правило:** Mock external dependencies (database, HTTP), НЕ mock internal code

```typescript
// ✅ GOOD - mock external database
import { mock } from 'node:test';

const dbMock = mock.fn(async (query) => {
  return { rows: [{ id: 1, name: 'Test' }] };
});

// ❌ BAD - mock internal functions
const myFunctionMock = mock.fn(() => 'fake result');
```

### 4. Cleanup после тестов

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

### 5. Используй descriptive test names

```typescript
// ✅ GOOD - описательное название
it('should reject requests when circuit breaker is open', async () => {
  // Test code
});

// ❌ BAD - неясное название
it('should work', async () => {
  // Test code
});
```

### 6. Test edge cases

```typescript
describe('retry interceptor', () => {
  it('should succeed on first attempt', async () => { /* ... */ });
  it('should retry on ResourceExhausted', async () => { /* ... */ });
  it('should NOT retry on Internal error', async () => { /* ... */ });
  it('should stop after maxRetries', async () => { /* ... */ });
  it('should reject negative maxRetries', async () => { /* ... */ });
});
```

### 7. Assertions style

```typescript
import assert from 'node:assert';

// Prefer strict equality
assert.strictEqual(result, expected);

// NOT loose equality
assert.equal(result, expected);  // ❌ BAD

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

## Examples из Phase 4

### Interceptor Unit Test

См. `packages/interceptors/tests/unit/serializer.test.ts` для полного примера:

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

См. `packages/interceptors/tests/integration/full-chain.test.ts`:

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

**Priority:** Medium (после core packages реализованы)

**Tasks:**
1. Реализовать createMockMessage helper
2. Реализовать createMockField helper
3. Реализовать createMockMethod helper
4. Реализовать createTestServer utility
5. Реализовать mockInterceptor utility
6. Добавить TypeScript types
7. Написать unit tests для utilities
8. Обновить документацию с реальными examples
9. Publish v0.1.0

**Target release:** v0.2.0-beta.1 или позже

## License

MIT

## Related Packages

- [@connectum/interceptors](../interceptors/README.md) - Использует mock helpers в тестах
- [@connectum/core](../runner/README.md) - Использует createTestServer в integration тестах
