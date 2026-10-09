# Performance benchmarks

These k6 scenarios exercise the example server with different interceptor configurations. The configured thresholds below are test checks; they are not measured results or performance guarantees.

## Prerequisites

- Install k6 using the [official k6 installation guide](https://grafana.com/docs/k6/latest/set-up/install-k6/).
- Check out the [examples repository](https://github.com/Connectum-Framework/examples) alongside this repository. The performance server requires Node.js 25.2 or later.

## Start the example server

In the `examples` checkout, from `performance-test-server/`:

```bash
pnpm install
pnpm build:proto
pnpm start
```

The server exposes these configurations: port 8081 has no interceptors, 8082 enables validation, 8083 enables logging, 8084 enables OpenTelemetry tracing and metrics, and 8080 uses the full interceptor chain. Port 8085 is an optional OTLP-export configuration enabled only with `OTEL_EXPORT_ENABLED=1` and a configured collector; the scenarios in this repository do not target it. The server uses HTTP by default; set `TLS_DIR` to enable TLS.

## Run scenarios

Run these commands from the `connectum` repository root. The example server listens on HTTP by default, so set `BASE_URL` for the first three scenarios and `PROTOCOL` for interceptor profiling:

These commands require `TLS_DIR` to be unset in the server environment. If TLS is enabled with `TLS_DIR`, use `https://` in each `BASE_URL` and set `PROTOCOL=https`.

```bash
BASE_URL=http://localhost:8080 k6 run tests/performance/scenarios/basic-load.js
BASE_URL=http://localhost:8080 k6 run tests/performance/scenarios/stress-test.js
BASE_URL=http://localhost:8080 k6 run tests/performance/scenarios/spike-test.js
PROTOCOL=http k6 run tests/performance/scenarios/interceptor-overhead.js
```

Each scenario's setup check sends a Connect POST to `greeter.v1.GreeterService/SayHello`; it does not call a separate `/health` endpoint.

## Scenario configuration

| Scenario | Load shape | Configured thresholds |
| --- | --- | --- |
| `basic-load.js` | 30s to 50 VUs; 1m to 100; 5m at 100; 30s to 0 | `http_req_duration`: p95 < 100ms, p99 < 150ms; `request_duration`: p50 < 50ms, p95 < 100ms, p99 < 150ms; `http_reqs`: > 1,000/s; `http_req_failed`: < 1%; `success_rate`: > 99% |
| `stress-test.js` | 1m to 100 VUs; 2m to 500; 2m to 1,000; 2m to 2,000; 1m to 0 | `http_req_failed`: < 5%; `success_rate`: > 95% |
| `spike-test.js` | 30s to 100 VUs; 10s to 1,000; 30s at 1,000; 10s to 100; 30s at 100 | `http_req_failed`: < 2%; `success_rate`: > 98%; `recovery_latency`: p95 < 150ms |
| `interceptor-overhead.js` | 10 VUs for 2m across five server configurations | `baseline_no_interceptors`: p95 < 10ms; `full_chain_all_interceptors`: p95 < 30ms; each configuration's success rate > 99% |

The scenario source is the authority for load shapes and thresholds: [`tests/performance/scenarios/`](./scenarios/). k6's default summary is printed after a run. See Grafana's [k6 results and output documentation](https://grafana.com/docs/k6/latest/get-started/results-output/) for supported ways to consume results.

There is no dedicated performance job in this repository's CI workflows.

## Related documentation

- [Performance benchmarking ADR](https://connectum.dev/en/contributing/adr/008-performance-benchmarking)
- [Connectum runtime architecture](https://connectum.dev/en/guide/production/architecture)

## License

Apache-2.0
