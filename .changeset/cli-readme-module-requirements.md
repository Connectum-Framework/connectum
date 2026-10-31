---
"@connectum/cli": patch
---

fix: the README that `connectum init` writes now says what a project needs before `start`. A project scaffolded with `--auth` gets an Authentication section naming `JWKS_URI`, `JWT_ISSUER` and `JWT_AUDIENCE` (with the JWKS default) and which sample method needs a token; one scaffolded with `--events <adapter>` gets an Events section naming the broker, the variable that holds its address and the default (`NATS_SERVERS`, `KAFKA_BROKERS`, `REDPANDA_BROKERS`, `REDIS_URL`, `AMQP_URL`), and for NATS, Redis and RabbitMQ a `docker run` line with the image the repository's CI runs the adapter against. Before, the README was the same for every combination and an `--events nats` project exited at startup with `connection refused` and no hint why. A project without those modules gets the README it had.
