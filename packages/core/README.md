# @connectum/core

Main Server factory with protocol plugin system for Connectum.

**@connectum/core** - это главный integration layer пакет, который объединяет все компоненты Connectum для создания production-ready ConnectRPC/gRPC сервисов.

## Возможности

- **createServer()**: Фабричная функция для создания сервера с explicit lifecycle
- **Lifecycle Hooks**: События start, ready, stop, error
- **Protocol Plugin System**: Расширяемая система через `protocols: []` array
- **TLS Configuration**: Utilities для настройки TLS certificates
- **Graceful Shutdown**: Встроенная поддержка graceful shutdown с автоматической обработкой сигналов
- **Explicit Interceptors**: Пользователь передаёт interceptors явно (zero internal deps)

### Protocol Packages (устанавливаются отдельно)

- **@connectum/healthcheck**: [gRPC Health Checking Protocol](https://github.com/grpc/grpc/blob/master/doc/health-checking.md) + HTTP endpoints
- **@connectum/reflection**: [gRPC Server Reflection](https://github.com/grpc/grpc/blob/master/doc/server-reflection.md)

## Установка

```bash
pnpm add @connectum/core
```

**Peer dependencies** (устанавливаются автоматически):

```bash
pnpm add @connectrpc/connect @connectrpc/connect-node @bufbuild/protobuf
```

## Быстрый старт

### Минимальный пример

```typescript
import { createServer } from '@connectum/core';
import routes from '#gen/routes.js';

const server = createServer({
  services: [routes],
  port: 5000,
});

await server.start();
```

### Production пример

```typescript
import { createServer } from '@connectum/core';
import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';
import { Reflection } from '@connectum/reflection';
import routes from '#gen/routes.js';

const server = createServer({
  services: [routes],
  port: 5000,
  protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
  shutdown: {
    autoShutdown: true,  // Graceful shutdown on SIGTERM/SIGINT
    timeout: 30000,
  },
});

// Lifecycle hooks
server.on('ready', () => {
  console.log(`Server ready on port ${server.address?.port}`);
  healthcheckManager.update(ServingStatus.SERVING);
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

await server.start();
```

### С TLS

```typescript
import { createServer } from '@connectum/core';

const server = createServer({
  services: [routes],
  port: 5000,
  tls: {
    keyPath: './keys/server.key',
    certPath: './keys/server.crt',
  },
});

await server.start();
```

## Внутренняя архитектура

Начиная с v0.2.0-beta, модуль `@connectum/core` разделён на 3 самостоятельных подмодуля, каждый из которых отвечает за свою область ответственности:

```
core/src/
├── Server.ts            # Оркестратор: lifecycle state machine, EventEmitter
├── TransportManager.ts  # HTTP/2 transport: создание, listen, session tracking
├── buildRoutes.ts       # Композиция: services + protocols + interceptors -> handler
├── gracefulShutdown.ts  # Graceful shutdown: timeout race, force close, hooks
├── ShutdownManager.ts   # Shutdown hooks: dependency ordering, cycle detection
├── TLSConfig.ts         # TLS: чтение сертификатов, path resolution
├── types.ts             # Публичные типы и интерфейсы
└── index.ts             # Re-exports
```

### TransportManager

Управляет жизненным циклом HTTP/2 сервера:
- Создание secure/plaintext HTTP/2 сервера
- Отслеживание активных `Http2Session` для принудительного завершения при таймауте
- Listen с корректной обработкой ошибок (error listener cleanup)
- Graceful close (отправка GOAWAY)
- Force destroy всех сессий

### buildRoutes

Композиция маршрутов и протоколов:
- Регистрация пользовательских сервисов на `ConnectRouter`
- Перехват `router.service()` для сбора `DescFile[]` registry (используется reflection)
- Регистрация протоколов (healthcheck, reflection) с передачей registry
- Создание `connectNodeAdapter` с fallback-маршрутизацией на HTTP-обработчики протоколов

### gracefulShutdown

Orchestration graceful shutdown последовательностью фаз:
1. **Close transport** -- отправка GOAWAY, прекращение приёма новых соединений
2. **Timeout race** -- ожидание завершения in-flight запросов или таймаут
3. **Force close** -- при таймауте уничтожение всех HTTP/2 сессий (если `forceCloseOnTimeout: true`)
4. **Execute hooks** -- выполнение всех shutdown hooks (даже после таймаута)
5. **Dispose** -- очистка внутреннего состояния

Ошибки в `Promise.race` корректно перехватываются, таймер очищается через `clearTimeout` в `finally`.

## Main Exports

### createServer()

Основная фабричная функция для создания сервера:

```typescript
import { createServer } from '@connectum/core';

function createServer(options: CreateServerOptions): Server
```

**Параметры (`CreateServerOptions`):**

| Параметр | Тип | Default | Описание |
|----------|-----|---------|----------|
| `services` | `ServiceRoute[]` | required | Массив service route functions |
| `port` | `number` | `5000` | Port для сервера |
| `host` | `string` | `'0.0.0.0'` | Host для bind |
| `tls` | `TLSOptions` | - | TLS конфигурация |
| `protocols` | `ProtocolRegistration[]` | `[]` | Protocol plugins (healthcheck, reflection) |
| `shutdown` | `ShutdownOptions` | - | Graceful shutdown конфигурация |
| `interceptors` | `Interceptor[]` | `[]` | ConnectRPC interceptors (use `createDefaultInterceptors()` from `@connectum/interceptors`) |
| `allowHTTP1` | `boolean` | `true` | Allow HTTP/1.1 connections |
| `handshakeTimeout` | `number` | `30000` | Handshake timeout (ms) |
| `http2Options` | `SecureServerOptions` | - | Дополнительные HTTP/2 options |

**Возвращает:** `Server` - сервер instance (не запущен)

### Server Interface

```typescript
interface Server extends EventEmitter {
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // State
  readonly address: AddressInfo | null;
  readonly isRunning: boolean;
  readonly state: ServerState;

  // Transport access
  readonly transport: Http2SecureServer | Http2Server | null;
  readonly routes: ReadonlyArray<ServiceRoute>;
  readonly interceptors: ReadonlyArray<Interceptor>;
  readonly protocols: ReadonlyArray<ProtocolRegistration>;

  // Shutdown signal (aborted when server begins shutdown)
  readonly shutdownSignal: AbortSignal;

  // Runtime operations (only before start())
  addService(service: ServiceRoute): void;
  addInterceptor(interceptor: Interceptor): void;
  addProtocol(protocol: ProtocolRegistration): void;

  // Shutdown hooks
  onShutdown(handler: ShutdownHook): void;
  onShutdown(name: string, handler: ShutdownHook): void;
  onShutdown(name: string, dependencies: string[], handler: ShutdownHook): void;

  // Events
  on(event: 'start', listener: () => void): this;
  on(event: 'ready', listener: () => void): this;
  on(event: 'stopping', listener: () => void): this;
  on(event: 'stop', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}
```

### Lifecycle Hooks

```typescript
import { healthcheckManager, ServingStatus } from '@connectum/healthcheck';

// Server начинает запуск
server.on('start', () => {
  console.log('Server starting...');
});

// Server готов принимать connections
server.on('ready', () => {
  console.log(`Listening on port ${server.address?.port}`);
  healthcheckManager.update(ServingStatus.SERVING);
});

// Server начинает graceful shutdown (до abort signal)
server.on('stopping', () => {
  console.log('Server shutting down...');
  healthcheckManager.update(ServingStatus.NOT_SERVING);
});

// Server остановлен
server.on('stop', () => {
  console.log('Server stopped');
});

// Ошибка сервера (вместо process.exit)
server.on('error', (error: Error) => {
  console.error('Server error:', error);
});
```

**Важно**: Сервер генерирует событие `error` вместо вызова `process.exit(1)`. Это позволяет приложению самостоятельно решить, как обрабатывать фатальные ошибки.

### ServerState

```typescript
const ServerState = {
  CREATED: 'created',    // Server создан, не запущен
  STARTING: 'starting',  // Server запускается
  RUNNING: 'running',    // Server работает
  STOPPING: 'stopping',  // Server останавливается
  STOPPED: 'stopped',    // Server остановлен
} as const;

type ServerState = typeof ServerState[keyof typeof ServerState];
```

### Health Check (via @connectum/healthcheck)

Health check protocol is available as a separate package:

```typescript
import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';

const server = createServer({
  services: [routes],
  protocols: [Healthcheck({ httpEnabled: true })],
});

server.on('ready', () => {
  // Update overall service health
  healthcheckManager.update(ServingStatus.SERVING);

  // Update specific service health
  healthcheckManager.update(ServingStatus.SERVING, 'my.service.Name');
});
```

See `@connectum/healthcheck` package for full documentation.

### TLS Utilities

```typescript
import { getTLSPath, readTLSCertificates, tlsPath } from '@connectum/core';

// Get TLS path from environment
const path = getTLSPath();

// Read TLS certificates
const { key, cert } = readTLSCertificates({
  keyPath: './keys/server.key',
  certPath: './keys/server.crt',
});

// Get configured TLS path
const configuredPath = tlsPath();
```

## Configuration Types

### ShutdownOptions

```typescript
interface ShutdownOptions {
  /** Timeout in milliseconds for graceful shutdown (default: 30000) */
  timeout?: number;

  /** Signals to listen for graceful shutdown (default: ['SIGTERM', 'SIGINT']) */
  signals?: NodeJS.Signals[];

  /** Enable automatic graceful shutdown on signals (default: false) */
  autoShutdown?: boolean;

  /**
   * Force close all HTTP/2 sessions when shutdown timeout is exceeded.
   * When true, sessions are destroyed after timeout.
   * When false, server waits indefinitely for in-flight requests to complete.
   * (default: true)
   */
  forceCloseOnTimeout?: boolean;
}
```

#### Поведение graceful shutdown

При вызове `server.stop()` или получении сигнала (при `autoShutdown: true`):

1. Генерируется событие `stopping` -- можно обновить healthcheck на NOT_SERVING
2. `AbortController.abort()` -- сигнализирует streaming RPC и long-running операциям о завершении
3. Транспорт отправляет GOAWAY и прекращает приём новых соединений
4. **Timeout race**: ожидание завершения in-flight запросов или истечение `timeout`
5. При таймауте и `forceCloseOnTimeout: true` -- принудительное уничтожение всех HTTP/2 сессий
6. Выполнение shutdown hooks (с учётом зависимостей)
7. Очистка внутреннего состояния

Повторные вызовы `stop()` безопасны -- возвращается тот же Promise, что и первый вызов.

### TLSOptions

```typescript
interface TLSOptions {
  /** Path to TLS key file */
  keyPath?: string;

  /** Path to TLS certificate file */
  certPath?: string;

  /** TLS directory path (alternative to keyPath/certPath) */
  dirPath?: string;
}
```

### Interceptors

`@connectum/core` не включает встроенных interceptors. Используйте `@connectum/interceptors` для production-ready chain:

```typescript
import { createDefaultInterceptors } from '@connectum/interceptors';

const server = createServer({
  services: [routes],
  interceptors: createDefaultInterceptors(),
});
```

See `@connectum/interceptors` package for `DefaultInterceptorOptions` and full documentation.

## Environment Variables

| Переменная | Описание | Default |
|------------|----------|---------|
| `PORT` | Server port | `5000` |
| `LISTEN` | Server host | `0.0.0.0` |
| `TLS_PATH` | Path to TLS certificates directory | - |
| `TLS_KEY_PATH` | Path to TLS key file | - |
| `TLS_CERT_PATH` | Path to TLS certificate file | - |
| `NODE_ENV` | Environment (affects logger) | - |

## Примеры

### Minimal Service

```typescript
import { createServer } from '@connectum/core';
import routes from '#gen/routes.js';

const server = createServer({
  services: [routes],
  port: 5000,
});

await server.start();
console.log(`Server running on ${server.address?.port}`);
```

### Production Service with All Features

```typescript
import { createServer } from '@connectum/core';
import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';
import { createDefaultInterceptors } from '@connectum/interceptors';
import { Reflection } from '@connectum/reflection';
import routes from '#gen/routes.js';

// Build protocols list
const protocols = [Healthcheck({ httpEnabled: true })];
if (process.env.NODE_ENV !== 'production') {
  protocols.push(Reflection());
}

const server = createServer({
  services: [routes],
  port: process.env.PORT ? Number(process.env.PORT) : 5000,
  host: '0.0.0.0',
  protocols,

  // TLS for production
  tls: process.env.NODE_ENV === 'production' ? {
    keyPath: './keys/server.key',
    certPath: './keys/server.crt',
  } : undefined,

  // Graceful shutdown
  shutdown: {
    autoShutdown: true,
    timeout: 30000,
    signals: ['SIGTERM', 'SIGINT'],
  },

  // Interceptors (explicit — core has no built-in interceptors)
  interceptors: createDefaultInterceptors({
    errorHandler: { logErrors: true },
    timeout: { duration: 30_000 },
  }),
});

// Lifecycle hooks
server.on('start', () => {
  console.log('Server starting...');
});

server.on('ready', () => {
  console.log(`Server ready on ${server.address?.port}`);
  healthcheckManager.update(ServingStatus.SERVING);
});

server.on('stop', () => {
  console.log('Server stopped');
});

server.on('error', (error) => {
  console.error('Server error:', error);
});

// Start server
await server.start();
```

### Manual Graceful Shutdown

```typescript
import { createServer } from '@connectum/core';
import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';

const server = createServer({
  services: [routes],
  port: 5000,
  protocols: [Healthcheck()],
  // Note: autoShutdown: false (default)
});

server.on('ready', () => {
  healthcheckManager.update(ServingStatus.SERVING);
});

await server.start();

// Manual shutdown handlers
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM');

  // Mark as not serving (drain connections)
  healthcheckManager.update(ServingStatus.NOT_SERVING);

  // Wait for connections to drain
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Stop server
  await server.stop();

  process.exit(0);
});
```

### Adding Services at Runtime

```typescript
import { createServer } from '@connectum/core';

const server = createServer({
  services: [mainRoutes],
  port: 5000,
});

// Add more services before starting
server.addService(adminRoutes);
server.addService(metricsRoutes);

await server.start();

// Note: Cannot add services after start()
```

## Legacy API (Deprecated)

The `Runner()` function is deprecated. Use `createServer()` instead.

```typescript
// Deprecated
import { Runner } from '@connectum/core';
const server = await Runner(options);

// New API
import { createServer } from '@connectum/core';
const server = createServer(options);
await server.start();
```

Key differences:
- `createServer()` returns an unstarted server (call `.start()` explicitly)
- Lifecycle hooks via EventEmitter (`server.on('ready', ...)`)
- Explicit `.stop()` method instead of `.shutdown()`
- Health check via `@connectum/healthcheck` package
- Reflection via `@connectum/reflection` package
- Server state available via `server.state`

## Документация

### Getting Started

- [Quick Start](../../docs/getting-started/quick-start.md) - Создание первого сервиса

### Architecture

- [Architecture Overview](../../docs/architecture/overview.md) - Общая архитектура
- [Package Decomposition](../../docs/architecture/adr/003-package-decomposition.md) - ADR о структуре пакетов

### Guides

- [Interceptors Guide](../../docs/guides/interceptors.md) - Работа с interceptors
- [Observability Guide](../../docs/guides/observability.md) - Настройка OpenTelemetry
- [TLS Configuration](../../docs/guides/tls-configuration.md) - Production TLS setup

## Dependencies

### Internal Dependencies

None — `@connectum/core` is Layer 0 with zero internal dependencies.

### External Dependencies

- `@connectrpc/connect` - ConnectRPC core
- `@connectrpc/connect-node` - Node.js adapter
- `@bufbuild/protobuf` - Protocol Buffers runtime
- `env-var` - Environment variables management

## Требования

- **Node.js**: >=25.2.0 (для stable type stripping)
- **pnpm**: >=10.0.0
- **TypeScript**: >=5.7.2 (для type checking)

## License

MIT

---

**Part of [@connectum](../../README.md)** - Universal framework for production-ready gRPC/ConnectRPC microservices
