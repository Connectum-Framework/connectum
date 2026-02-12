# @connectum/interceptors

ConnectRPC interceptors for Connectum.

**@connectum/interceptors** -- это коллекция production-ready interceptors для ConnectRPC, предоставляющих error handling, resilience patterns (retry, circuit breaker, bulkhead, timeout, fallback), валидацию и JSON-сериализацию.

## Возможности

- **Error Handler** -- преобразование ошибок в ConnectError с корректными gRPC-кодами
- **Timeout** -- ограничение времени выполнения запроса
- **Bulkhead** -- ограничение количества одновременных запросов
- **Circuit Breaker** -- предотвращение каскадных сбоев
- **Retry** -- повторные попытки с exponential backoff (cockatiel)
- **Fallback** -- graceful degradation при сбое сервиса (отключен по умолчанию)
- **Validation** -- валидация входных данных через `@connectrpc/validate`
- **Serializer** -- автоматическая JSON-сериализация protobuf-сообщений
- **Logger** -- логирование запросов и ответов
- **Method Filter** -- декларативная per-method маршрутизация interceptors (ADR-014)

## Установка

```bash
pnpm add @connectum/interceptors
```

**Peer dependencies**:

```bash
pnpm add @connectrpc/connect @bufbuild/protobuf
```

## Default interceptor chain

Пакет предоставляет готовую цепочку из 8 interceptors с фиксированным порядком:

```
errorHandler -> timeout -> bulkhead -> circuitBreaker -> retry -> fallback -> validation -> serializer
```

| # | Interceptor | По умолчанию | Назначение |
|---|-------------|-------------|------------|
| 1 | errorHandler | включен | Catch-all нормализация ошибок (должен быть первым) |
| 2 | timeout | включен (30с) | Enforce deadline до начала обработки |
| 3 | bulkhead | включен (10/10) | Ограничение concurrency |
| 4 | circuitBreaker | включен (5 сбоев) | Предотвращение каскадных сбоев |
| 5 | retry | включен (3 попытки) | Повтор transient failures с exponential backoff |
| 6 | fallback | **отключен** | Graceful degradation (требует функцию handler) |
| 7 | validation | включен | `@connectrpc/validate` (`createValidateInterceptor()`) |
| 8 | serializer | включен | JSON-сериализация protobuf-ответов |

**Почему этот порядок:**

1. **errorHandler** -- внешний слой, перехватывает все ошибки из всей цепочки
2. **timeout** -- fail fast для медленных запросов до начала обработки
3. **bulkhead** -- ограничение concurrent load для защиты ресурсов
4. **circuitBreaker** -- быстрый отказ при каскадных сбоях
5. **retry** -- повторная попытка для transient failures
6. **fallback** -- последний шанс на graceful degradation
7. **validation** -- проверка корректности данных перед бизнес-логикой
8. **serializer** -- сериализация ответа (innermost)

## Быстрый старт

### Интеграция с `@connectum/core` (рекомендуемый способ)

Параметр `builtinInterceptors` в `createServer()` управляет default chain:

```typescript
import { createServer } from "@connectum/core";
import routes from "#gen/routes.js";

const server = createServer({
  services: [routes],
  port: 5000,

  // Настройка default chain
  builtinInterceptors: {
    timeout: { duration: 10000 },    // Кастомный timeout
    retry: false,                    // Отключить retry
    // остальные -- по умолчанию
  },

  // Пользовательские interceptors добавляются после builtins
  interceptors: [myCustomInterceptor],
});

await server.start();
```

Для полного отключения default chain:

```typescript
const server = createServer({
  services: [routes],
  builtinInterceptors: false, // Все builtins отключены
  interceptors: [
    // Полностью ручная цепочка
  ],
});
```

### Standalone usage (без createServer)

```typescript
import { createDefaultInterceptors } from "@connectum/interceptors";
import { createConnectTransport } from "@connectrpc/connect-node";

const interceptors = createDefaultInterceptors({
  timeout: { duration: 10000 },
  retry: { maxRetries: 5 },
  fallback: {
    handler: () => ({ data: [] }),
  },
});

const transport = createConnectTransport({
  baseUrl: "http://localhost:5000",
  interceptors,
});
```

### Использование отдельных interceptors

```typescript
import {
  createErrorHandlerInterceptor,
  createRetryInterceptor,
  createTimeoutInterceptor,
} from "@connectum/interceptors";

const interceptors = [
  createErrorHandlerInterceptor({ logErrors: true }),
  createTimeoutInterceptor({ duration: 5000 }),
  createRetryInterceptor({ maxRetries: 2 }),
];
```

## Экспортируемые фабрики

Каждый interceptor доступен как именованный экспорт:

| Фабрика | Подпуть импорта |
|---------|-----------------|
| `createErrorHandlerInterceptor` | `@connectum/interceptors/errorHandler` |
| `createLoggerInterceptor` | `@connectum/interceptors/logger` |
| `createSerializerInterceptor` | `@connectum/interceptors/serializer` |
| `createRetryInterceptor` | `@connectum/interceptors/retry` |
| `createCircuitBreakerInterceptor` | `@connectum/interceptors/circuit-breaker` |
| `createTimeoutInterceptor` | `@connectum/interceptors/timeout` |
| `createBulkheadInterceptor` | `@connectum/interceptors/bulkhead` |
| `createFallbackInterceptor` | `@connectum/interceptors/fallback` |
| `createDefaultInterceptors` | `@connectum/interceptors/defaults` |
| `createMethodFilterInterceptor` | `@connectum/interceptors/method-filter` |

Все фабрики также доступны через основной экспорт `@connectum/interceptors`.

## Справочник interceptors

### Error Handler

Преобразует произвольные ошибки в `ConnectError` с корректными gRPC-кодами.

**Важно**: должен быть первым в цепочке, чтобы перехватывать ошибки из всех последующих interceptors.

```typescript
import { createErrorHandlerInterceptor } from "@connectum/interceptors";

const interceptor = createErrorHandlerInterceptor({
  logErrors: true,           // Логировать ошибки (default: true в dev, false в prod)
  includeStackTrace: false,  // Включать stack trace (default: true в dev, false в prod)
});
```

### Timeout

Предотвращает зависание запросов, устанавливая максимальное время выполнения.

```typescript
import { createTimeoutInterceptor } from "@connectum/interceptors";

const interceptor = createTimeoutInterceptor({
  duration: 30000,      // Timeout в мс (default: 30000)
  skipStreaming: true,   // Пропустить streaming вызовы (default: true)
});
```

**Ответ при превышении timeout:**
```json
{
  "code": "deadline_exceeded",
  "message": "Request timeout after 30000ms"
}
```

### Bulkhead

Ограничивает количество одновременных запросов для предотвращения истощения ресурсов.

```typescript
import { createBulkheadInterceptor } from "@connectum/interceptors";

const interceptor = createBulkheadInterceptor({
  capacity: 10,        // Максимум concurrent запросов (default: 10)
  queueSize: 10,       // Размер очереди ожидания (default: 10)
  skipStreaming: true,  // Пропустить streaming вызовы (default: true)
});
```

**Ответ при превышении capacity:**
```json
{
  "code": "resource_exhausted",
  "message": "Bulkhead capacity exceeded (10/10 active, 10/10 queued)"
}
```

### Circuit Breaker

Предотвращает каскадные сбои путем разрыва цепи при повторяющихся ошибках.

```typescript
import { createCircuitBreakerInterceptor } from "@connectum/interceptors";

const interceptor = createCircuitBreakerInterceptor({
  threshold: 5,           // Открыть после N последовательных сбоев (default: 5)
  halfOpenAfter: 30000,   // Перейти в half-open через N мс (default: 30000)
  skipStreaming: true,     // Пропустить streaming вызовы (default: true)
});
```

**Состояния цепи:**

| Состояние | Описание |
|-----------|----------|
| **Closed** | Нормальная работа, запросы проходят |
| **Open** | Сбой: запросы отклоняются немедленно |
| **Half-Open** | Тестирование: один запрос допускается для проверки восстановления |

**Ответ при открытой цепи:**
```json
{
  "code": "unavailable",
  "message": "Circuit breaker is open (5 consecutive failures)"
}
```

### Retry

Повторяет неудачные unary-вызовы с exponential backoff. Реализован на базе [cockatiel](https://github.com/connor4312/cockatiel).

```typescript
import { createRetryInterceptor } from "@connectum/interceptors";

const interceptor = createRetryInterceptor({
  maxRetries: 3,          // Количество повторных попыток (default: 3)
  initialDelay: 200,      // Начальная задержка в мс (default: 200)
  maxDelay: 5000,         // Максимальная задержка в мс (default: 5000)
  skipStreaming: true,     // Пропустить streaming вызовы (default: true)
  retryableCodes: [       // gRPC-коды для повтора (default: Unavailable, ResourceExhausted)
    Code.Unavailable,
    Code.ResourceExhausted,
  ],
});
```

**Стратегия backoff:**
- Попытка 1: задержка `initialDelay` (200 мс)
- Попытка 2: задержка `initialDelay * 2` (400 мс)
- Попытка 3: задержка `initialDelay * 4` (800 мс)
- ... и так далее, но не более `maxDelay`

### Fallback

Обеспечивает graceful degradation при сбое сервиса. **Отключен по умолчанию** -- для работы требуется передать функцию `handler`.

```typescript
import { createFallbackInterceptor } from "@connectum/interceptors";

const interceptor = createFallbackInterceptor({
  handler: (error) => {
    console.error("Service failed, returning cached data:", error);
    return { message: getCachedData() };
  },
  skipStreaming: true,   // Пропустить streaming вызовы (default: true)
});
```

Включение fallback в default chain:

```typescript
const server = createServer({
  services: [routes],
  builtinInterceptors: {
    fallback: {
      handler: () => ({ data: [] }),
    },
  },
});
```

### Validation

Валидация входных данных с использованием официального пакета `@connectrpc/validate` (`createValidateInterceptor()`). Проверяет proto-constraints перед передачей запроса в бизнес-логику.

В default chain используется напрямую `createValidateInterceptor()` из `@connectrpc/validate`. Опция `validation` принимает только `boolean`:

```typescript
const server = createServer({
  services: [routes],
  builtinInterceptors: {
    validation: true,  // Включен по умолчанию
    // validation: false, // Отключить
  },
});
```

**Пример proto-файла с validation constraints:**

```protobuf
syntax = "proto3";

import "buf/validate/validate.proto";

message CreateUserRequest {
  string email = 1 [(buf.validate.field).string.email = true];
  string name = 2 [(buf.validate.field).string.min_len = 1];
  int32 age = 3 [(buf.validate.field).int32.gte = 0];
}
```

### Serializer

Автоматическая JSON-сериализация protobuf-сообщений через `@bufbuild/protobuf`.

```typescript
import { createSerializerInterceptor } from "@connectum/interceptors";

const interceptor = createSerializerInterceptor({
  skipGrpcServices: true,    // Пропустить для gRPC (binary protobuf) (default: true)
  alwaysEmitImplicit: true,  // Включать default-значения в JSON (default: true)
  ignoreUnknownFields: true, // Игнорировать неизвестные поля (default: true)
});
```

### Logger

Логирование запросов и ответов.

```typescript
import { createLoggerInterceptor } from "@connectum/interceptors";

const interceptor = createLoggerInterceptor({
  level: "info",            // Уровень логирования (default: "debug")
  skipHealthCheck: true,    // Пропустить health check (default: true)
  logger: console.info,    // Кастомный логгер (default: console[level])
});
```

## Per-Service и Per-Method Interceptors

Connectum предоставляет три подхода для применения interceptors к конкретным сервисам или методам.

### Подход 1: ConnectRPC native per-service/per-method (рекомендуемый)

ConnectRPC нативно поддерживает per-service и per-method interceptors через опции `router.service()` и `router.rpc()`:

```typescript
import type { ConnectRouter } from "@connectrpc/connect";
import { GreeterService } from "#gen/greeter_pb.js";

export default (router: ConnectRouter) => {
  // Per-service interceptors -- применяются ко всем methods сервиса
  router.service(GreeterService, impl, {
    interceptors: [requireAuth, auditLog],
  });

  // Per-method interceptors -- применяются только к конкретному method
  router.rpc(GreeterService, GreeterService.methods.sayHello, helloImpl, {
    interceptors: [rateLimiter],
  });
};
```

Используйте этот подход когда interceptors привязаны к конкретному сервису или методу на уровне роутинга.

### Подход 2: createMethodFilterInterceptor (декларативная маршрутизация)

`createMethodFilterInterceptor` -- convenience helper для декларативной per-method маршрутизации interceptors на основе wildcard-паттернов. Реализует [ADR-014](../../docs/contributing/adr/014-method-filter-interceptor.md).

```typescript
import {
  createMethodFilterInterceptor,
  createTimeoutInterceptor,
  createCircuitBreakerInterceptor,
} from "@connectum/interceptors";

const perMethodInterceptor = createMethodFilterInterceptor({
  // Global wildcard: все methods
  "*": [logRequest],

  // Service wildcard: все methods сервиса
  "admin.v1.AdminService/*": [requireAdmin],

  // Exact match: конкретный method
  "user.v1.UserService/DeleteUser": [requireAdmin, auditLog],
});

const server = createServer({
  services: [routes],
  interceptors: [perMethodInterceptor],
});
```

**Поддерживаемые паттерны:**

| Паттерн | Описание | Пример |
|---------|----------|--------|
| `"*"` | Все methods всех сервисов | `"*": [logRequest]` |
| `"Service/*"` | Все methods конкретного сервиса | `"admin.v1.AdminService/*": [auth]` |
| `"Service/Method"` | Конкретный method | `"user.v1.UserService/GetUser": [cache]` |

**Порядок выполнения:**

Все совпавшие паттерны выполняются последовательно (от общего к частному):

```
Request: user.v1.UserService/GetUser

1. "*": [logRequest]                       -- global (всегда)
2. "user.v1.UserService/*": [auth]         -- service-level (если определен)
3. "user.v1.UserService/GetUser": [cache]  -- exact match (если определен)

Итоговая цепочка: logRequest -> auth -> cache -> next(req)
```

**Пример: разные resilience настройки для разных методов:**

```typescript
createMethodFilterInterceptor({
  // Быстрые операции -- timeout 5s
  "catalog.v1.CatalogService/GetProduct": [
    createTimeoutInterceptor({ duration: 5_000 }),
  ],
  // Тяжелые операции -- timeout 30s + circuit breaker
  "report.v1.ReportService/*": [
    createTimeoutInterceptor({ duration: 30_000 }),
    createCircuitBreakerInterceptor({ threshold: 3 }),
  ],
});
```

### Подход 3: Custom interceptor с ручной фильтрацией

Для сложных или динамических условий фильтрации можно написать custom interceptor:

```typescript
import type { Interceptor } from "@connectrpc/connect";

const conditionalAuth: Interceptor = (next) => async (req) => {
  // Динамическая логика фильтрации
  if (req.service.typeName === "admin.v1.AdminService") {
    await verifyAdminToken(req);
  }
  return next(req);
};
```

Используйте этот подход для случаев, которые не покрываются паттернами `createMethodFilterInterceptor` (например, фильтрация по содержимому запроса, динамические условия).

### Когда какой подход использовать

| Сценарий | Подход |
|----------|--------|
| Interceptor привязан к конкретному сервису/методу в роутере | ConnectRPC native (`router.service()` / `router.rpc()`) |
| Декларативная маршрутизация по паттернам для группы сервисов | `createMethodFilterInterceptor` |
| Динамическая логика фильтрации (по содержимому запроса, runtime условиям) | Custom interceptor |
| Техническое ограничение interceptor (streaming, gRPC binary) | `skip*` опции interceptor |

### О skip* опциях

Опции `skipStreaming`, `skipGrpcServices` и `skipHealthCheck` в отдельных interceptors -- это **не** routing concerns. Они являются техническими ограничениями самих interceptors:

- **`skipStreaming`** (retry, timeout, bulkhead, circuit-breaker, fallback): Resilience interceptors оборачивают весь вызов целиком. Для streaming это технически некорректно -- нельзя повторить stream, ограничить timeout для long-lived соединения, или заменить stream fallback-значением.
- **`skipGrpcServices`** (serializer): JSON сериализация для gRPC binary протокола технически невозможна. Это защита от ошибки протокола.
- **`skipHealthCheck`** (logger): Convenience shortcut для исключения health check из логов.

Эти опции дополняют, а не заменяют `createMethodFilterInterceptor`. Method filter управляет бизнес-routing ("какие interceptors для каких методов"), а skip* -- техническими ограничениями ("interceptor не может работать с этим типом вызова").

## Типы

### MethodFilterMap

```typescript
type MethodFilterMap = Record<string, Interceptor[]>;
```

### DefaultInterceptorOptions

```typescript
interface DefaultInterceptorOptions {
  errorHandler?: boolean | ErrorHandlerOptions;
  timeout?: boolean | TimeoutOptions;
  bulkhead?: boolean | BulkheadOptions;
  circuitBreaker?: boolean | CircuitBreakerOptions;
  retry?: boolean | RetryOptions;
  fallback?: boolean | FallbackOptions;
  validation?: boolean;
  serializer?: boolean | SerializerOptions;
}
```

### ErrorHandlerOptions

```typescript
interface ErrorHandlerOptions {
  logErrors?: boolean;          // default: true в dev, false в prod
  includeStackTrace?: boolean;  // default: true в dev, false в prod
}
```

### TimeoutOptions

```typescript
interface TimeoutOptions {
  duration?: number;        // default: 30000 (30 секунд)
  skipStreaming?: boolean;  // default: true
}
```

### BulkheadOptions

```typescript
interface BulkheadOptions {
  capacity?: number;        // default: 10
  queueSize?: number;       // default: 10
  skipStreaming?: boolean;  // default: true
}
```

### CircuitBreakerOptions

```typescript
interface CircuitBreakerOptions {
  threshold?: number;       // default: 5
  halfOpenAfter?: number;   // default: 30000
  skipStreaming?: boolean;  // default: true
}
```

### RetryOptions

```typescript
interface RetryOptions {
  maxRetries?: number;       // default: 3
  initialDelay?: number;     // default: 200
  maxDelay?: number;         // default: 5000
  skipStreaming?: boolean;   // default: true
  retryableCodes?: Code[];   // default: [Code.Unavailable, Code.ResourceExhausted]
}
```

### FallbackOptions

```typescript
interface FallbackOptions<T = unknown> {
  handler: (error: Error) => T | Promise<T>;  // Обязательный
  skipStreaming?: boolean;                     // default: true
}
```

### LoggerOptions

```typescript
interface LoggerOptions {
  level?: "debug" | "info" | "warn" | "error";  // default: "debug"
  skipHealthCheck?: boolean;                     // default: true
  logger?: (message: string, ...args: unknown[]) => void;
}
```

### SerializerOptions

```typescript
interface SerializerOptions {
  skipGrpcServices?: boolean;    // default: true
  alwaysEmitImplicit?: boolean;  // default: true
  ignoreUnknownFields?: boolean; // default: true
}
```

## Примеры

### Production-конфигурация с createServer

```typescript
import { createServer } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { withReflection } from "@connectum/reflection";
import routes from "#gen/routes.js";

const server = createServer({
  services: [routes],
  port: 5000,
  protocols: [Healthcheck({ httpEnabled: true }), withReflection()],
  shutdown: { autoShutdown: true },

  builtinInterceptors: {
    errorHandler: {
      logErrors: true,
      includeStackTrace: process.env.NODE_ENV !== "production",
    },
    timeout: { duration: 10000 },
    bulkhead: { capacity: 20, queueSize: 20 },
    circuitBreaker: { threshold: 3 },
    retry: {
      maxRetries: 2,
      initialDelay: 100,
    },
    // fallback отключен по умолчанию
    // validation включен по умолчанию
    // serializer включен по умолчанию
  },
});

server.on("ready", () => {
  healthcheckManager.update(ServingStatus.SERVING);
});

await server.start();
```

### Включение fallback с handler

```typescript
const server = createServer({
  services: [routes],
  builtinInterceptors: {
    fallback: {
      handler: (error) => {
        console.error("Service failed:", error);
        return { items: [], total: 0 };
      },
    },
  },
});
```

### Client-side interceptors

```typescript
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  createRetryInterceptor,
  createTimeoutInterceptor,
} from "@connectum/interceptors";

const transport = createConnectTransport({
  baseUrl: "https://api.example.com",
  interceptors: [
    createTimeoutInterceptor({ duration: 5000 }),
    createRetryInterceptor({
      maxRetries: 3,
      initialDelay: 500,
      maxDelay: 10000,
      retryableCodes: [Code.Unavailable, Code.ResourceExhausted],
    }),
  ],
});

const client = createClient(MyService, transport);
```

### Полностью кастомная цепочка

```typescript
import {
  createErrorHandlerInterceptor,
  createTimeoutInterceptor,
  createRetryInterceptor,
  createSerializerInterceptor,
} from "@connectum/interceptors";

const server = createServer({
  services: [routes],
  builtinInterceptors: false, // Отключить default chain

  interceptors: [
    createErrorHandlerInterceptor({ logErrors: true }),
    createTimeoutInterceptor({ duration: 5000 }),
    createRetryInterceptor({ maxRetries: 2 }),
    createSerializerInterceptor(),
  ],
});
```

## Миграция

### Удаленные interceptors

Следующие interceptors были удалены из пакета и перенесены в примеры:

| Interceptor | Куда перенесен | Причина |
|-------------|---------------|---------|
| `redact` | `examples/extensions/redact/` | Domain-specific, не является частью universal framework |
| `addToken` | `examples/interceptors/jwt/` | Domain-specific, не является частью universal framework |
| `validation` (custom) | -- | Заменен на `@connectrpc/validate` (`createValidateInterceptor()`) |

**Для `addToken`:** используйте пример из `examples/interceptors/jwt/` или напишите свой interceptor.

**Для `redact`:** используйте пример из `examples/extensions/redact/` или реализуйте как custom interceptor.

**Для `validation`:** замените на `@connectrpc/validate`:

```typescript
// Было (custom validation)
import { createValidationInterceptor } from "@connectum/interceptors";
const interceptor = createValidationInterceptor({ skipStreaming: true });

// Стало (official @connectrpc/validate)
import { createValidateInterceptor } from "@connectrpc/validate";
const interceptor = createValidateInterceptor();
// Или включен автоматически в default chain через builtinInterceptors.validation
```

### Изменения в retry interceptor

| Параметр | Было | Стало |
|----------|------|-------|
| `maxRetries` | default: 5 | default: 3 |
| `initialDelay` | `timeout: 100` | `initialDelay: 200` |
| `maxDelay` | -- | 5000 мс |
| `retryableCodes` | -- | `[Code.Unavailable, Code.ResourceExhausted]` |
| Реализация | Встроенная | [cockatiel](https://github.com/connor4312/cockatiel) |

### Изменения в default chain

Resilience interceptors (timeout, bulkhead, circuitBreaker, retry, fallback) теперь **включены** в default chain (ранее были optional). Fallback остается отключенным по умолчанию.

## Зависимости

### Внутренние

- `@connectrpc/connect` -- ConnectRPC core
- `@connectrpc/validate` -- Official validation interceptor
- `@bufbuild/protobuf` -- Protocol Buffers runtime
- `cockatiel` -- Resilience patterns (retry, circuit breaker, bulkhead, timeout)

### Dev

- `@biomejs/biome` -- Linting и formatting
- `typescript` -- Type checking

## Требования

- **Node.js**: >=25.2.0 (для stable type stripping)
- **TypeScript**: >=5.7.2 (для type checking)

## License

MIT

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices
