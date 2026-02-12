# Performance Benchmarks

Comprehensive performance testing infrastructure for Connectum using k6.

## Prerequisites

### Install k6

**macOS:**
```bash
brew install k6
```

**Linux (Debian/Ubuntu):**
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
  sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

**Or via Docker:**
```bash
docker pull grafana/k6:latest
```

### Verify Installation
```bash
k6 version
# Expected output: k6 v0.XX.X (...)
```

## Running Benchmarks

### 1. Start Test Server

First, start the dedicated performance test server:

```bash
# From project root
node examples/performance-test-server/src/index.ts
```

The server will start multiple instances on different ports:
- **8081**: Baseline (no interceptors)
- **8082**: Validation only
- **8083**: Logger only
- **8084**: Tracing only
- **8080**: Full interceptor chain (all interceptors)

### 2. Run Benchmarks

**Basic Load Test (normal sustained load):**
```bash
k6 run tests/performance/scenarios/basic-load.js
```

**Stress Test (find breaking point):**
```bash
k6 run tests/performance/scenarios/stress-test.js
```

**Spike Test (recovery from sudden spikes):**
```bash
k6 run tests/performance/scenarios/spike-test.js
```

**Interceptor Overhead Profiling:**
```bash
k6 run tests/performance/scenarios/interceptor-overhead.js
```

### 3. Export Results

**Generate HTML report:**
```bash
k6 run --out json=results/basic-load.json tests/performance/scenarios/basic-load.js
# Then convert to HTML (requires k6-reporter)
```

**Send metrics to Prometheus/Grafana:**
```bash
k6 run --out prometheus tests/performance/scenarios/basic-load.js
```

## Scenarios Overview

| Scenario | Purpose | Duration | Target VUs | SLA Threshold |
|----------|---------|----------|------------|---------------|
| `basic-load.js` | Normal sustained load | 7m | 100 | p95 < 100ms |
| `stress-test.js` | Find breaking point | 8m | 100→2000 | Error < 5% |
| `spike-test.js` | Sudden load recovery | 2m | 100→1000→100 | Recovery < 30s |
| `interceptor-overhead.js` | Per-interceptor cost | 2m | 10 | < 2ms/interceptor |

## Performance Targets

### Latency (P0 - CRITICAL)
- **p50**: < 50ms
- **p95**: < 100ms ← Primary SLA
- **p99**: < 150ms

### Throughput (P0 - CRITICAL)
- **Sustained**: 1000 req/sec
- **Peak**: 2000 req/sec

### Resource Usage (P1 - HIGH)
- **Memory**: < 100MB RSS
- **CPU**: < 50% single core

### Interceptor Overhead (P1 - HIGH)
- **Baseline** (no interceptors): ~5ms
- **Full chain** (10+ interceptors): ~15ms
- **Per interceptor**: < 2ms

## Interpreting Results

k6 will output results like:

```
     ✓ status is 200
     ✓ response time < 100ms

     checks.........................: 100.00% ✓ 120000 ✗ 0
     data_received..................: 24 MB   80 kB/s
     data_sent......................: 18 MB   60 kB/s
     http_req_blocked...............: avg=1.2ms    min=0s     med=1ms    max=50ms   p(90)=2ms    p(95)=3ms
     http_req_connecting............: avg=500µs    min=0s     med=400µs  max=20ms   p(90)=800µs  p(95)=1ms
     http_req_duration..............: avg=45ms     min=10ms   med=40ms   max=200ms  p(90)=80ms   p(95)=95ms  ← KEY METRIC
     http_req_failed................: 0.00%   ✓ 0      ✗ 120000
     http_req_receiving.............: avg=100µs    min=50µs   med=90µs   max=5ms    p(90)=150µs  p(95)=200µs
     http_req_sending...............: avg=80µs     min=40µs   med=70µs   max=3ms    p(90)=120µs  p(95)=150µs
     http_req_tls_handshaking.......: avg=0s       min=0s     med=0s     max=0s     p(90)=0s     p(95)=0s
     http_req_waiting...............: avg=44ms     min=9ms    med=39ms   max=199ms  p(90)=79ms   p(95)=94ms
     http_reqs......................: 120000  1000/s
     iteration_duration.............: avg=145ms    min=110ms  med=140ms  max=300ms  p(90)=180ms  p(95)=195ms
     iterations.....................: 120000  1000/s
     vus............................: 100     min=50   max=100
     vus_max........................: 100     min=100  max=100
```

**Key metrics to check:**
- ✅ `http_req_duration p(95)` < 100ms
- ✅ `http_req_failed` < 1%
- ✅ `http_reqs` > 1000/s

## Troubleshooting

### k6 can't connect to server
```bash
# Check if server is running
curl http://localhost:8080/health

# Check server logs
# Ensure performance-test-server is running
```

### Results are inconsistent
- Run benchmarks multiple times
- Ensure no other CPU-intensive processes are running
- Use dedicated hardware for consistent results
- Consider running in Docker for isolation

### Memory/CPU too high
- Check for memory leaks in interceptors
- Profile with `node --inspect`
- Review OpenTelemetry overhead
- Consider async generator optimizations

## Continuous Integration

*Note: CI integration deferred to later release*

```yaml
# .gitlab-ci.yml example (future)
performance:
  image: grafana/k6:latest
  stage: test
  script:
    - node examples/performance-test-server/src/index.ts &
    - sleep 5
    - k6 run --out json=results.json tests/performance/scenarios/basic-load.js
  artifacts:
    paths:
      - results.json
  only:
    - main
```

## Documentation

- **Performance Baselines**: See [docs/performance/BASELINES.md](../../docs/performance/BASELINES.md)
- **Optimization Guide**: See [docs/performance/OPTIMIZATION.md](../../docs/performance/OPTIMIZATION.md) *(future)*
- **Architecture**: See [docs/architecture/overview.md](../../docs/architecture/overview.md)

## Contributing

When adding new benchmarks:

1. Create scenario in `tests/performance/scenarios/`
2. Document purpose and targets
3. Run multiple times to establish baseline
4. Update BASELINES.md with results
5. Add to CI pipeline (when available)

## License

MIT
