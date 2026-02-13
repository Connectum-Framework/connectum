---
"@connectum/otel": minor
"@connectum/core": minor
"@connectum/cli": patch
---

Обновлены production-зависимости:

**@connectum/otel** (minor):
- OpenTelemetry SDK обновлён до v2 (@opentelemetry/resources ^2.5.1, @opentelemetry/sdk-trace-node ^2.5.1, @opentelemetry/sdk-metrics ^2.5.1, experimental packages ^0.212.0)
- Resource class заменён на resourceFromAttributes()
- LoggerProvider: processors передаются через constructor
- MeterProvider: добавлен resource parameter

**@connectum/core** (minor):
- Zod обновлён с v3 до v4 (^4.3.6)
- Изменён тип возврата safeParseEnvConfig (убрана явная аннотация z.SafeParseReturnType)

**@connectum/cli** (patch):
- citty обновлён до ^0.2.1
- Исправлена типизация ProtoSyncOptions.template для exactOptionalPropertyTypes

Также обновлены:
- @biomejs/biome: ^1.9.4 → ^2.3.15 (конфиг автомигрирован)
