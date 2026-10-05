---
"@connectum/interceptors": minor
---

feat!: the logger interceptor no longer logs request and response bodies unless `includeBodies: true` is set

**BREAKING.** `createLoggerInterceptor` used to hand the request and response message of every call (and the JSON form of every streamed response message) to the log sink. Bodies carry credentials, tokens and personal data, so they are now off by default. The log lines keep their text (`RPC <path> request`, `RPC <path> response`, `STREAM <path> request|response`, completion, failure); only the extra body argument is gone, and streamed response messages are no longer converted to JSON when bodies are off.

To get the previous output, set the new option:

```typescript
createLoggerInterceptor({ includeBodies: true });
```

See the migration guide for details.
