# @connectum/healthcheck

gRPC Health Check Protocol + HTTP health endpoints для Connectum.

**@connectum/healthcheck** реализует [gRPC Health Checking Protocol](https://github.com/grpc/grpc/blob/master/doc/health-checking.md) с дополнительными HTTP-эндпоинтами для Kubernetes liveness/readiness probes.

## Возможности

- **gRPC Health Check Protocol**: Check, Watch, List методы
- **HTTP Health Endpoints**: `/healthz`, `/health`, `/readyz` (настраиваемые пути)
- **Per-service Health Status**: Управление статусом каждого сервиса отдельно
- **Watch Streaming**: Real-time стриминг изменений статуса
- **Factory Pattern**: `createHealthcheckManager()` для изолированных инстансов
- **Singleton по умолчанию**: Глобальный `healthcheckManager` для простых сценариев

## Установка

```bash
pnpm add @connectum/healthcheck
```

**Peer dependency:**

```bash
pnpm add @connectum/core
```

## Быстрый старт

```typescript
import { createServer } from '@connectum/core';
import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';
import routes from '#gen/routes.js';

const server = createServer({
  services: [routes],
  port: 5000,
  protocols: [Healthcheck({ httpEnabled: true })],
});

server.on('ready', () => {
  healthcheckManager.update(ServingStatus.SERVING);
});

await server.start();
```

## API

### Healthcheck(options?)

Фабричная функция, создающая `ProtocolRegistration` для передачи в `createServer()`.

```typescript
import { Healthcheck } from '@connectum/healthcheck';

const protocol = Healthcheck({
  httpEnabled: true,
  httpPaths: ['/healthz', '/health', '/readyz'],
  watchInterval: 500,
  manager: customManager,  // опционально
});
```

**Параметры (`HealthcheckOptions`):**

| Параметр | Тип | Default | Описание |
|----------|-----|---------|----------|
| `httpEnabled` | `boolean` | `false` | Включить HTTP health endpoints |
| `httpPaths` | `string[]` | `["/healthz", "/health", "/readyz"]` | Пути HTTP health endpoints |
| `watchInterval` | `number` | `500` | Интервал polling для Watch streaming (мс) |
| `manager` | `HealthcheckManager` | `healthcheckManager` (singleton) | Кастомный менеджер (для тестов или multi-server) |

### healthcheckManager (singleton)

Глобальный singleton-инстанс `HealthcheckManager`. Импортируется из любого файла приложения:

```typescript
import { healthcheckManager, ServingStatus } from '@connectum/healthcheck';

// Обновить статус всех сервисов
healthcheckManager.update(ServingStatus.SERVING);

// Обновить статус конкретного сервиса
healthcheckManager.update(ServingStatus.NOT_SERVING, 'my.service.v1.MyService');
```

### createHealthcheckManager()

Фабричная функция для создания изолированного `HealthcheckManager`. Полезна для тестирования или запуска нескольких серверов в одном процессе.

```typescript
import { Healthcheck, createHealthcheckManager, ServingStatus } from '@connectum/healthcheck';
import { createServer } from '@connectum/core';

const manager = createHealthcheckManager();

const server = createServer({
  services: [routes],
  protocols: [Healthcheck({ httpEnabled: true, manager })],
});

server.on('ready', () => {
  manager.update(ServingStatus.SERVING);
});

await server.start();
```

### HealthcheckManager

Класс управления health-статусами сервисов.

#### Методы

| Метод | Описание |
|-------|----------|
| `update(status, service?)` | Обновить статус. Без `service` -- обновляет все зарегистрированные сервисы. |
| `getStatus(service)` | Получить статус конкретного сервиса |
| `getAllStatuses()` | Получить Map всех статусов |
| `areAllHealthy()` | Проверить, все ли сервисы в статусе SERVING |
| `initialize(serviceNames)` | Инициализировать трекинг сервисов |
| `clear()` | Очистить все сервисы |

#### Поведение initialize()

Метод `initialize()` выполняет **merge** с существующим состоянием:
- Сервисы, которые уже были зарегистрированы, сохраняют текущий статус
- Новые сервисы добавляются со статусом `UNKNOWN`

Это позволяет обновлять список сервисов без потери ранее установленных статусов (например, при hot reload).

### ServingStatus

Значения статусов (соответствуют gRPC Health Check Protocol):

| Статус | Значение | Описание |
|--------|----------|----------|
| `UNKNOWN` | `0` | Статус неизвестен |
| `SERVING` | `1` | Сервис работает нормально |
| `NOT_SERVING` | `2` | Сервис недоступен |
| `SERVICE_UNKNOWN` | `3` | Запрошенный сервис не найден |

## HTTP Health Endpoints

При `httpEnabled: true` доступны HTTP-эндпоинты, которые зеркалят статус gRPC healthcheck.

**Пути по умолчанию:** `/healthz`, `/health`, `/readyz`

Можно настроить через `httpPaths`:

```typescript
Healthcheck({
  httpEnabled: true,
  httpPaths: ['/healthz', '/ready', '/live'],
})
```

### Формат ответа

```json
{
  "status": "SERVING",
  "service": "overall",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### HTTP Status Codes

| ServingStatus | HTTP Code |
|---------------|-----------|
| `SERVING` | `200 OK` |
| `NOT_SERVING` | `503 Service Unavailable` |
| `SERVICE_UNKNOWN` | `404 Not Found` |
| `UNKNOWN` | `503 Service Unavailable` |

### Проверка конкретного сервиса

```bash
curl http://localhost:5000/healthz?service=my.service.v1.MyService
```

## gRPC методы

### Health.Check

Проверка здоровья конкретного сервиса:

```bash
grpcurl -plaintext localhost:5000 grpc.health.v1.Health/Check
```

С указанием сервиса:

```bash
grpcurl -plaintext -d '{"service": "my.service.v1.MyService"}' \
  localhost:5000 grpc.health.v1.Health/Check
```

### Health.Watch

Стриминг изменений статуса (Server-Sent Events):

```bash
grpcurl -plaintext localhost:5000 grpc.health.v1.Health/Watch
```

Поведение по спецификации gRPC:
- Немедленная отправка текущего статуса
- Отправка обновлений только при изменении статуса
- Для неизвестных сервисов: отправка `SERVICE_UNKNOWN` (не завершает вызов)
- Завершение при отключении клиента (AbortSignal)

### Health.List

Список всех сервисов с их статусами:

```bash
grpcurl -plaintext localhost:5000 grpc.health.v1.Health/List
```

## Примеры

### Kubernetes Probes

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 5000
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /readyz
    port: 5000
  initialDelaySeconds: 3
  periodSeconds: 5
```

### Graceful Shutdown

```typescript
server.on('stopping', () => {
  // Kubernetes перестанет направлять трафик
  healthcheckManager.update(ServingStatus.NOT_SERVING);
});
```

### Тестирование с изолированным менеджером

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHealthcheckManager, ServingStatus } from '@connectum/healthcheck';

describe('health check', () => {
  it('should track service status', () => {
    const manager = createHealthcheckManager();
    manager.initialize(['my.service.v1.MyService']);

    manager.update(ServingStatus.SERVING, 'my.service.v1.MyService');
    assert.ok(manager.areAllHealthy());

    manager.update(ServingStatus.NOT_SERVING, 'my.service.v1.MyService');
    assert.ok(!manager.areAllHealthy());
  });
});
```

## Dependencies

### Peer Dependencies

- `@connectum/core` -- Server factory и типы ProtocolRegistration

### Dependencies

- `@bufbuild/protobuf` -- Protocol Buffers runtime
- `@connectrpc/connect` -- ConnectRPC core

## Требования

- **Node.js**: >=25.2.0 (для stable type stripping)
- **pnpm**: >=10.0.0

## License

MIT

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices
