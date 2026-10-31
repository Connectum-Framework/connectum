---
"@connectum/interceptors": patch
---

fix: the `skipHealthCheck` option of `createLoggerInterceptor` now skips a service only when `grpc.health` appears in its type name as whole package segments (`grpc.health.v1.Health`, or the same package under a prefix). Before, any name containing the text was skipped, so a service such as `acme.grpc.healthcare.v1.Svc` was missing from the log while the option was on (the default). Such services are now logged.
