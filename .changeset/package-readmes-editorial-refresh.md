---
"@connectum/auth": patch
"@connectum/cli": patch
"@connectum/core": patch
"@connectum/events": patch
"@connectum/events-amqp": patch
"@connectum/events-kafka": patch
"@connectum/events-nats": patch
"@connectum/events-redis": patch
"@connectum/healthcheck": patch
"@connectum/interceptors": patch
"@connectum/otel": patch
"@connectum/protoc-gen-catalog": patch
"@connectum/reflection": patch
"@connectum/test-fixtures": patch
"@connectum/testing": patch
---

docs: the package READMEs are short entry points (install, a runnable start, constraints, links) and the long reference tables now live on the documentation site and in the API reference. The facts that exist only in a README stay there: the cancellation migration notes of `@connectum/interceptors`, the request initializer migration of `@connectum/protoc-gen-catalog`, the dependency injection and testing section of `@connectum/events`, the verified RabbitMQ and Kafka broker lines and the integration-suite instructions of the AMQP and Kafka adapters. Examples in the READMEs of eight packages and the Quickstart are executed against the packed packages by `pnpm docs:check`. JSDoc of a few exports was corrected to match the code; no runtime behavior changes.
