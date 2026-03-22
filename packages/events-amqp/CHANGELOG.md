# @connectum/events-amqp

## 1.0.0-rc.7

### Minor Changes

- [#65](https://github.com/Connectum-Framework/connectum/pull/65) [`4f2705b`](https://github.com/Connectum-Framework/connectum/commit/4f2705bbd8a86eb57419baf81c292da9f5e8b841) Thanks [@intech](https://github.com/intech)! - Add @connectum/events-amqp — AMQP 0-9-1 / RabbitMQ adapter for EventBus

  New package providing AMQP adapter for @connectum/events:

  - RabbitMQ and LavinMQ compatibility
  - Topic exchange for wildcard routing
  - Durable queues with competing consumers
  - Message headers for metadata propagation
  - Dead letter exchange integration with DLQ middleware
  - Automatic client identification via connection name

### Patch Changes

- Updated dependencies [[`4d48e1c`](https://github.com/Connectum-Framework/connectum/commit/4d48e1c8ef9877fbc572a421bb99c0704f9fbbca)]:
  - @connectum/events@1.0.0-rc.7
