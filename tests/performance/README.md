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
| `basic-load.js` | Open model (fixed arrival rate, `TARGET_RATE`, default 1,000 req/s): 30s from 0 to 500 req/s; 1m to 1,000 req/s; 5m at 1,000 req/s (the sustained stage, its own k6 scenario); 30s to 0 | `http_req_duration`: p95 < 100ms, p99 < 150ms; `request_duration`: p50 < 50ms, p95 < 100ms, p99 < 150ms; sustained stage: `dropped_iterations` count == 0 and `http_reqs` count >= 99% of the scheduled arrivals; `http_req_failed`: < 1%; `success_rate`: > 99% |
| `stress-test.js` | 1m to 100 VUs; 2m to 500; 2m to 1,000; 2m to 2,000; 1m to 0 | `http_req_failed`: < 5%; `success_rate`: > 95% |
| `spike-test.js` | 30s to 100 VUs; 10s to 1,000; 30s at 1,000; 10s to 100; 30s at 100 | `http_req_failed`: < 2%; `success_rate`: > 98%; `recovery_latency`: p95 < 150ms |
| `interceptor-overhead.js` | 10 VUs for 2m across five server configurations | `baseline_no_interceptors`: p95 < 10ms; `full_chain_all_interceptors`: p95 < 30ms; each configuration's success rate > 99% |

The scenario source is the authority for load shapes and thresholds: [`tests/performance/scenarios/`](./scenarios/). k6's default summary is printed after a run. See Grafana's [k6 results and output documentation](https://grafana.com/docs/k6/latest/get-started/results-output/) for supported ways to consume results.

There is no dedicated performance job in this repository's CI workflows.

## How `basic-load.js` measures throughput

The scenario is an open model: k6 starts a request at a fixed rate (`TARGET_RATE`, default 1,000 req/s) whatever the server does, and the number of busy virtual users follows from latency. A closed model (a fixed number of users looping with think time) cannot test "the server sustains N req/s": the users slow down together with the server, and the request rate is whatever the server leaves. The earlier version of this scenario was closed, with 100 users sleeping 50-150 ms after each request, so its `http_reqs: rate>1000` threshold could not be reached on any server (the whole-run average also includes the ramps).

The ramp-up, sustained stage and ramp-down are separate k6 scenarios (`ramp_up`, `sustained`, `ramp_down`) because k6 applies a threshold to a scenario, not to a stage. The throughput checks look at `sustained` only:

- `dropped_iterations{scenario:sustained}` count == 0. When the server falls behind and the virtual-user pool (200 pre-allocated, up to 600 per scenario) cannot absorb the in-flight requests, k6 cannot start the scheduled request and counts it as dropped.
- `http_reqs{scenario:sustained}` count >= 99% of `TARGET_RATE` x 300 s. A count is checked instead of a rate because k6 divides a counter by the duration of the whole test, not of one scenario.

To see the throughput check fail, ask for more than the server sustains, for example `TARGET_RATE=10000`.

Reading a red result:

- Only `dropped_iterations` is red: the server (or the load generator, see below) did not keep up with the arrival rate. The count is the number of requests that were never sent.
- `http_req_duration` and `request_duration` are red as well: requests were sent but answered late, so requests queued on the server.
- `http_req_failed` is red: the server answered with errors or timed out.
- Dropped iterations can also come from the load generator when k6 is short of CPU or the pool is exhausted. Check `vus_max` against 600 and the k6 process's CPU use before blaming the server.

Results of this scenario are not comparable with the earlier closed-model runs: those never measured throughput, and their latency values were taken at a different load.

## Measured results

Measured on 2026-10-21; the raw k6 summaries are kept with the change records, outside this repository. Absolute numbers are indicative; the setup is below.

- Host: Intel Core Ultra 7 165U (14 logical CPUs), 62 GB RAM, Linux 6.12, a shared developer workstation with other applications running (the load average was between 2.6 and 12.3 at the start of the runs). k6 v1.4.2 (`grafana/k6:latest` in Docker, `--network host`), Node.js v26.11.1, the example `performance-test-server` over TLS on the host.
- Target: port 8080 of the server (the full interceptor chain, including the opt-in resilience interceptors the example enables), `TARGET_RATE` = 1,000 req/s. Baseline: published `@connectum/*` 1.2.0. Candidate: packages built from commit 5c77117. Five runs of each, alternating.

Sustained stage, five runs per version (min / median / max):

| | Baseline 1.2.0 | Candidate 5c77117 |
| --- | --- | --- |
| Completed requests per second (sustained stage) | 921 / 984 / 999 | 951 / 970 / 999 |
| `dropped_iterations` (sustained stage) | 390 / 4,791 / 23,594 | 222 / 8,893 / 14,592 |
| `http_req_duration` p50, whole run | 0.80 / 0.89 / 1.13 ms | 0.79 / 0.88 / 1.28 ms |
| `http_req_duration` p95, whole run | 41 / 188 / 946 ms | 62 / 432 / 503 ms |
| `http_req_duration` p99, whole run | 220 / 525 / 1,721 ms | 271 / 848 / 1,251 ms |

Findings:

- The throughput threshold (`dropped_iterations` == 0) was red in all ten runs, and so was p99 < 150 ms. p95 < 100 ms passed in 3 of the 10 runs (baseline run 5, candidate runs 1 and 3). The run-to-run spread is larger than any difference between the two versions, so these runs do not show a difference between baseline and candidate. The median request is fast (p50 about 1 ms); the failures come from a tail of slow requests.
- The same scenario against port 8081 (no interceptors), one run at a host load average of 2.6: no dropped iterations, 300,001 completed requests in the sustained stage, p95 0.94 ms, p99 9.3 ms; every threshold green. So the load generator and the host can carry 1,000 req/s; whether the tail on port 8080 comes from the interceptor chain or from the shared host was not separated (the full chain was not re-run at the same low host load).
- `TARGET_RATE=10000` against port 8081, one run: red. 1,274,425 requests completed in the sustained stage (about 4,250 req/s) and 1,725,576 iterations were dropped.

## Related documentation

- [Performance benchmarking ADR](https://connectum.dev/en/contributing/adr/008-performance-benchmarking)
- [Connectum runtime architecture](https://connectum.dev/en/guide/production/architecture)

## License

Apache-2.0
