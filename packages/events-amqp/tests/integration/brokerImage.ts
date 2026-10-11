/**
 * RabbitMQ image started by the container-based integration suites.
 *
 * An exact version: the broker under test changes only by a commit, never because a floating
 * tag moved. `.github/workflows/ci.yml` (job `test-amqp-broker`) pins the same image for the
 * service-container suite; change both together. `AMQP_BROKER_IMAGE` overrides the default to
 * run a suite against another broker version.
 */
export const RABBITMQ_IMAGE = process.env.AMQP_BROKER_IMAGE ?? "rabbitmq:4.3.6-alpine";
