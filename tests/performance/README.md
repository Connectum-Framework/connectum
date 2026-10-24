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
| `basic-load.js` | Open model (fixed arrival rate, `TARGET_RATE`, default 1,000 req/s): 30s from 0 to 500 req/s; 1m to 1,000 req/s; 5m at 1,000 req/s (the sustained stage, its own k6 scenario); 30s to 0 | `http_req_duration`: p95 < 100ms, p99 < 150ms; `request_duration`: p50 < 50ms, p95 < 100ms, p99 < 150ms; sustained stage: `dropped_iterations` count <= 1% of the scheduled arrivals and `http_reqs` count >= 99% of them; `http_req_failed`: < 1%; `success_rate`: > 99% |
| `stress-test.js` | 1m to 100 VUs; 2m to 500; 2m to 1,000; 2m to 2,000; 1m to 0 | `http_req_failed`: < 5%; `success_rate`: > 95% |
| `spike-test.js` | 30s to 100 VUs; 10s to 1,000; 30s at 1,000; 10s to 100; 30s at 100 | `http_req_failed`: < 2%; `success_rate`: > 98%; `recovery_latency`: p95 < 150ms |
| `interceptor-overhead.js` | 10 VUs for 2m across five server configurations | `baseline_no_interceptors`: p95 < 10ms; `full_chain_all_interceptors`: p95 < 30ms; each configuration's success rate > 99% |

The scenario source is the authority for load shapes and thresholds: [`tests/performance/scenarios/`](./scenarios/). k6's default summary is printed after a run. See Grafana's [k6 results and output documentation](https://grafana.com/docs/k6/latest/get-started/results-output/) for supported ways to consume results.

There is no dedicated performance job in this repository's CI workflows.

## How `basic-load.js` measures throughput

The scenario is an open model: k6 starts a request at a fixed rate (`TARGET_RATE`, default 1,000 req/s) whatever the server does, and the number of busy virtual users follows from latency. A closed model (a fixed number of users looping with think time) cannot test "the server sustains N req/s": the users slow down together with the server, and the request rate is whatever the server leaves. The earlier version of this scenario was closed, with 100 users sleeping 50-150 ms after each request, so its `http_reqs: rate>1000` threshold could not be reached on any server (the whole-run average also includes the ramps).

The ramp-up, sustained stage and ramp-down are separate k6 scenarios (`ramp_up`, `sustained`, `ramp_down`) because k6 applies a threshold to a scenario, not to a stage. The throughput checks look at `sustained` only:

- `dropped_iterations{scenario:sustained}` count <= 1% of `TARGET_RATE` x 300 s. When the server falls behind and the virtual-user pool (all 600 are allocated before the sustained stage starts) cannot absorb the in-flight requests, k6 cannot start the scheduled request and counts it as dropped. A budget instead of "zero" because on a host that runs the load generator next to the server a handful of lost iterations says nothing about the server, while a shortfall that lasts does; 1% is the same budget as `http_req_failed` and `success_rate`.
- `http_reqs{scenario:sustained}` count >= 99% of `TARGET_RATE` x 300 s. A count is checked instead of a rate because k6 divides a counter by the duration of the whole test, not of one scenario.

To see the throughput check fail, ask for more than the server sustains, for example `TARGET_RATE=10000`.

Reading a red result:

- Only `dropped_iterations` is red: the server (or the load generator, see below) did not keep up with the arrival rate. The count is the number of requests that were never sent.
- `http_req_duration` and `request_duration` are red as well: requests were sent but answered late, so requests queued on the server.
- `http_req_failed` is red: the server answered with errors or timed out.
- Dropped iterations can also come from the load generator when k6 is short of CPU or the pool is exhausted. Look for k6's `Insufficient VUs, reached 600 active VUs and cannot initialize more` warning for the `sustained` scenario (the limit of 600 applies to each of the three scenarios separately, so the run-wide `vus_max` does not show it) and at the k6 process's CPU use before blaming the server. With the pool allocated up front, reaching 600 active virtual users means the pool is exhausted, not that virtual users were still being initialised: at 1,000 req/s iterations then last 0.6 s on average, against the roughly 0.1 s the p95 target implies. The warning alone does not say why; the request timings (`http_req_duration`, `http_req_waiting`) and the CPU use of the k6 process tell a slow server from a starved generator.

## Measured values (indicative)

Five runs of `basic-load.js` against the `performance-test-server` example (full interceptor chain, port 8080, TLS on the loopback) with the packages built from commit `3c8bcf7`. Load generator and server ran on the same idle workstation (load average 0.9-2.4 before each run); k6 ran in Docker (`grafana/k6:latest`) with host networking, and the server's output was discarded. These are not guarantees: a separate generator host has not been measured.

| Metric | Range over the five runs |
| --- | --- |
| `http_req_duration` p50 | 0.51-0.61 ms |
| `http_req_duration` p95 | 1.84-4.16 ms |
| `http_req_duration` p99 | 5.3-36.8 ms |
| `http_req_duration` max | 90-388 ms |
| Requests completed in the sustained stage (scheduled: 300,000) | 299,733-300,001 |
| Dropped iterations in the sustained stage | 0-268 (at most 0.09%) |
| `http_req_failed` | 0% |

The thresholds above are the pass criteria; this table is what the runs showed.

Results of this scenario are not comparable with the earlier closed-model runs: those never measured throughput, and their latency values were taken at a different load.

## Related documentation

- [Performance benchmarking ADR](https://connectum.dev/en/contributing/adr/008-performance-benchmarking)
- [Connectum runtime architecture](https://connectum.dev/en/guide/production/architecture)

## License

Apache-2.0
