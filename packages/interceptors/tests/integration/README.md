# Integration Tests для @connectum/interceptors

## Обзор

Этот каталог содержит интеграционные тесты для проверки взаимодействия между interceptors в реальных сценариях.

## Структура тестов

### 1. `full-chain.test.ts` - Полная цепочка interceptors

**Тесты:**
- ✅ Обработка запроса через все interceptors успешно
- ✅ Обработка ошибок через цепочку (retry с ResourceExhausted)
- ✅ Соблюдение timeout в цепочке
- ✅ Ограничения capacity bulkhead
- ✅ Пропуск health check сервисов

**Проверяемые interceptors:**
- Logger
- Retry
- Timeout
- Circuit Breaker
- Bulkhead

### 2. `resilience.test.ts` - Паттерны устойчивости

**Тесты:**
- ✅ Retry + Circuit Breaker + Timeout (успешный retry)
- ✅ Открытие circuit после threshold failures
- ✅ Fallback при открытом circuit
- ✅ Timeout без retry (DeadlineExceeded не retryable)
- ✅ Комбинация всех resilience interceptors
- ✅ Корректная обработка streaming запросов

**Проверяемые паттерны:**
- Retry с exponential backoff
- Circuit Breaker с threshold
- Timeout с deadline
- Fallback для graceful degradation

**Важные детали:**
- Retry работает **только для Code.ResourceExhausted** (по дизайну)
- DeadlineExceeded, Internal и другие errors **не retryable**
- Circuit breaker открывается после threshold consecutive failures
- Все resilience interceptors пропускают streaming по умолчанию

### 3. `security.test.ts` - Security interceptors

**Тесты:**
- ✅ Validation + Logger (без redact)
- ✅ Reject invalid requests before processing
- ✅ Redact utility functions (smoke test)
- ✅ Graceful validation error handling
- ✅ Skip streaming requests when configured
- ✅ Logger без exposure sensitive data
- ✅ Комбинированный порядок validation + logging

**Проверяемые interceptors:**
- Validation (protovalidate)
- Logger
- Redact (smoke test только - requires real proto)

**Ограничения:**
- Полное тестирование Redact требует реальных proto schemas с extensions
- Текущие тесты - smoke tests для проверки API

## Запуск тестов

```bash
# Только integration tests
pnpm test:integration

# Все тесты (unit + integration)
pnpm test

# С coverage
pnpm test -- --experimental-test-coverage
```

## Результаты

**Total tests:** 18 integration tests
**Status:** ✅ All passing
**Execution time:** ~400ms

**Breakdown:**
- Full Chain Integration: 5 tests
- Resilience Pattern Integration: 6 tests
- Security Integration: 7 tests

## Отличия от Unit Tests

**Unit tests:**
- Тестируют отдельные interceptors в изоляции
- Используют mocks для dependencies
- Быстрое выполнение (<1s)
- 77 unit tests

**Integration tests:**
- Тестируют взаимодействие нескольких interceptors
- Используют реальные компоненты (no mocks)
- Проверяют end-to-end сценарии
- 18 integration tests

## Будущие улучшения

1. **Database Integration Tests** (Priority 2):
   - SQLite CRUD operations
   - Transaction handling
   - Error recovery

2. **OpenTelemetry Integration Tests** (Priority 3):
   - Trace propagation через interceptor chain
   - Metrics collection
   - OTLP export

3. **Runner Integration Tests** (Priority 4):
   - Full server lifecycle
   - Health check + Reflection
   - Graceful shutdown

4. **Redact Integration Tests**:
   - Требуются реальные proto schemas с (integrity.attributes.sensitive) extension
   - Проверка redaction в response messages
   - Проверка rpcCheck для методов с use_sensitive

## Примечания

- Все interceptors поддерживают `skipStreaming: true` по умолчанию
- Retry работает только с ResourceExhausted errors
- Circuit breaker использует библиотеку Cockatiel
- Timeout использует AbortController для cancellation
- Mock requests должны иметь полную структуру (method.input, method.output)
