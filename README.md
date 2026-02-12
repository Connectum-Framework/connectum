# Connectum

> Универсальный фреймворк для создания production-ready gRPC/ConnectRPC микросервисов на Node.js 25+

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D25.2.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Native-blue)](https://nodejs.org/api/typescript.html)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Alpha Release](https://img.shields.io/badge/release-v0.2.0--alpha.1-orange)](https://github.com/Connectum-Framework/connectum/releases/tag/v0.2.0-alpha.2)

## Особенности

- **Native TypeScript** - stable type stripping в Node.js 25.2.0+ без build step
- **Zero Configuration** - работает из коробки с разумными defaults
- **Production Ready** - встроенная observability, health checks, graceful shutdown
- **Type Safe** - полная типизация без `any`
- **Modular** - выбирайте только нужные компоненты
- **Extensible** - гибкая система interceptors
- **Explicit Lifecycle** - полный контроль над жизненным циклом сервера

## Быстрый старт

### Требования

- **Node.js**: >=25.2.0 (для stable type stripping)
- **pnpm**: >=10

### Установка

```bash
pnpm add @connectum/core
```

### Минимальный пример

```typescript
// src/index.ts
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
import { createServer, ServingStatus } from '@connectum/core';
import { createTracingInterceptor, createLoggerInterceptor } from '@connectum/interceptors';
import routes from '#gen/routes.js';

const server = createServer({
  services: [routes],
  port: 5000,
  interceptors: [
    createTracingInterceptor(),
    createLoggerInterceptor(),
  ],
  health: {
    enabled: true,
    httpEnabled: true,  // HTTP /healthz endpoint
  },
  shutdown: {
    autoShutdown: true,  // Graceful shutdown on SIGTERM/SIGINT
    timeout: 30000,
  },
});

// Lifecycle hooks
server.on('ready', () => {
  console.log(`Server ready on port ${server.address?.port}`);
  server.health.update(ServingStatus.SERVING);
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

server.on('stop', () => {
  console.log('Server stopped');
});

// Start the server
await server.start();
```

### Запуск

```bash
# Native TypeScript execution (no build step!)
node src/index.ts

# Development with watch mode
node --watch src/index.ts
```

## Пакеты

Connectum организован в 4 модульных пакетов:

| Пакет | Описание | Layer |
|-------|----------|-------|
| [`@connectum/otel`](packages/otel) | OpenTelemetry instrumentation | 0 |
| [`@connectum/interceptors`](packages/interceptors) | ConnectRPC interceptors | 1 |
| [`@connectum/core`](packages/core) | Main server factory + protocols | 2 |
| [`@connectum/testing`](packages/testing) | Testing utilities | 3 |

## Документация

- **[Полная документация](https://github.com/Connectum-Framework/docs)** - Все разделы документации
- **[Быстрый старт](https://github.com/Connectum-Framework/docs/blob/main/guide/getting-started/quick-start.md)** - Создание первого сервиса за 5 минут
- **[Миграция с @labeling/utils](https://github.com/Connectum-Framework/docs/blob/main/guide/migration/from-labeling-utils.md)** - Руководство по миграции
- **[Architecture Decision Records](https://github.com/Connectum-Framework/docs/blob/main/contributing/adr/)** - Архитектурные решения
- **[API Reference](https://github.com/Connectum-Framework/docs/blob/main/guide/api/)** - Полная API документация

## Архитектура

```
Layer 0: Independent Core
  ├── proto           # Proto definitions
  └── otel            # OpenTelemetry

Layer 1: Protocol Implementations
  └── interceptors    # ConnectRPC interceptors

Layer 2: Integration
  └── core            # Main server factory + protocols

Layer 3: Development Tools
  └── testing         # Testing utilities
```

Подробнее: [Архитектурный обзор](https://github.com/Connectum-Framework/docs/blob/main/contributing/architecture/overview.md)

## Server API

### createServer()

Основная фабричная функция для создания сервера:

```typescript
import { createServer } from '@connectum/core';

const server = createServer({
  // Required: service routes
  services: [myRoutes],

  // Server config
  port: 5000,              // Default: 5000
  host: '0.0.0.0',         // Default: 0.0.0.0

  // TLS (optional)
  tls: {
    keyPath: './keys/server.key',
    certPath: './keys/server.crt',
  },

  // Health check (optional)
  health: {
    enabled: true,         // gRPC health check
    httpEnabled: true,     // HTTP /healthz endpoint
    httpPath: '/healthz',  // Custom path
  },

  // Graceful shutdown (optional)
  shutdown: {
    autoShutdown: true,    // Auto handle SIGTERM/SIGINT
    timeout: 30000,        // Shutdown timeout
    signals: ['SIGTERM', 'SIGINT'],
  },

  // Custom interceptors
  interceptors: [myInterceptor],

  // Server reflection
  reflection: true,        // Default: true
});
```

### Server Interface

```typescript
interface Server extends EventEmitter {
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // State
  readonly address: AddressInfo | null;
  readonly isRunning: boolean;
  readonly state: ServerState;  // 'created' | 'starting' | 'running' | 'stopping' | 'stopped'

  // Health management
  readonly health: HealthcheckManager;

  // Events: 'start', 'ready', 'stop', 'error'
}
```

### Lifecycle Hooks

```typescript
server.on('start', () => {
  // Server начинает запуск
});

server.on('ready', () => {
  // Server готов принимать connections
  server.health.update(ServingStatus.SERVING);
});

server.on('stop', () => {
  // Server остановлен
});

server.on('error', (error: Error) => {
  // Ошибка сервера
  console.error(error);
});
```

## Примеры

Примеры использования вынесены в отдельный репозиторий: **[Connectum-Framework/examples](https://github.com/Connectum-Framework/examples)**

- **basic-service** - минимальный greeter сервис
- **performance-test-server** - сервер для k6 бенчмарков
- **production-ready** - production deployment template (WIP)
- **with-custom-interceptor** - пример кастомных interceptors (WIP)

## Разработка

### Настройка окружения

```bash
# Клонировать репозиторий
git clone https://github.com/Connectum-Framework/connectum.git
cd connectum

# Установить зависимости
pnpm install

# Генерация proto файлов
pnpm run build:proto

# Запуск тестов
pnpm test
```

Подробнее: [Development Setup](https://github.com/Connectum-Framework/docs/blob/main/contributing/development/development-setup.md)

### Структура репозитория

```
connectum/
├── packages/          # 5 пакетов фреймворка
└── .husky/            # Git hooks (commitlint, biome)
```

Связанные репозитории:
- **[docs](https://github.com/Connectum-Framework/docs)** - Документация
- **[examples](https://github.com/Connectum-Framework/examples)** - Примеры использования

## Статус проекта

**Текущий релиз**: v0.2.0-alpha.2 (Alpha)

### Завершено

- Native TypeScript support (Node.js 25.2.0+)
- 5-package modular architecture
- New createServer() API with explicit lifecycle
- OpenTelemetry instrumentation
- gRPC Health Check Protocol
- gRPC Server Reflection
- ConnectRPC interceptors (validation, tracing, logging, etc.)
- Resilience interceptors (circuit breaker, timeout, bulkhead, fallback)
- Comprehensive documentation

### В разработке

- Beta testing с реальными сервисами
- Дополнительные примеры
- Plugin system

## Участие в разработке

Мы приветствуем contributions! См. [CONTRIBUTING.md](CONTRIBUTING.md)

### Быстрые ссылки

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Development Setup](https://github.com/Connectum-Framework/docs/blob/main/contributing/development/development-setup.md)
- [Architecture Decision Records](https://github.com/Connectum-Framework/docs/blob/main/contributing/adr/)

## Лицензия

Apache License 2.0 - see [LICENSE](LICENSE) file for details.

## Благодарности

Connectum - это эволюция [@labeling/utils](https://github.com/AnyLabel/Integrity), переработанная в универсальный фреймворк.

---

**Connectum** - универсальный фреймворк для production-ready gRPC/ConnectRPC микросервисов на Node.js 25+.

Built with care by [Highload.Zone](https://highload.zone)
