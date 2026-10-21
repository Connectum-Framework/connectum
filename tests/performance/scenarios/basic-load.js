/**
 * Basic Load Test
 *
 * Purpose: Measure performance under normal sustained load
 * Duration: 7 minutes total
 * Load model: open (fixed arrival rate). k6 starts a new request at the
 *   configured rate no matter how slow the server is, so a server that falls
 *   behind shows up as dropped iterations instead of silently lowering the
 *   measured request rate (which is what a fixed number of looping virtual
 *   users does).
 * Shape: warm-up (to half of the target rate), ramp-up, sustained stage at the
 *   target rate (TARGET_RATE, default 1000 req/s), ramp-down.
 * SLA: p95 < 100ms, the server sustains 1000 req/sec (no dropped iterations in
 *   the sustained stage), error rate < 1%
 */

import { check } from "k6";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

// ============================================================================
// Custom Metrics
// ============================================================================

const requestDuration = new Trend("request_duration", true);
const requestErrors = new Counter("request_errors");
const successRate = new Rate("success_rate");

// ============================================================================
// Test Configuration
// ============================================================================

// Arrival rate (requests per second) of the sustained stage. The SLA is 1000;
// the variable exists so the throughput threshold can be shown to fail by
// asking for more than the server sustains.
const TARGET_RATE = Number(__ENV.TARGET_RATE || 1000);
const SUSTAINED_SECONDS = 300;

// Virtual users are only the carriers of in-flight requests: at the p95 target
// of 100ms and 1000 req/s about 1000 x 0.1 = 100 requests are in flight at
// once. The pool is sized well above that so the load generator itself is not
// the limit; if it is reached anyway, k6 reports it as dropped iterations.
const PRE_ALLOCATED_VUS = 200;
const MAX_VUS = 600;

export const options = {
    // Three consecutive scenarios instead of one list of stages, because k6
    // can apply a threshold to a scenario but not to a single stage. The
    // throughput threshold must see the sustained stage only; a whole-run
    // average would mix in the ramps and could never reach the target rate.
    scenarios: {
        // Warm-up and ramp-up: 0 -> half of the target rate in 30s, then to the
        // target rate in 1m.
        ramp_up: {
            executor: "ramping-arrival-rate",
            startRate: 0,
            timeUnit: "1s",
            preAllocatedVUs: PRE_ALLOCATED_VUS,
            maxVUs: MAX_VUS,
            stages: [
                { duration: "30s", target: TARGET_RATE / 2 },
                { duration: "1m", target: TARGET_RATE },
            ],
        },
        // Sustained stage: a constant arrival rate for 5 minutes.
        sustained: {
            executor: "constant-arrival-rate",
            rate: TARGET_RATE,
            timeUnit: "1s",
            duration: `${SUSTAINED_SECONDS}s`,
            preAllocatedVUs: PRE_ALLOCATED_VUS,
            maxVUs: MAX_VUS,
            startTime: "90s",
        },
        ramp_down: {
            executor: "ramping-arrival-rate",
            startRate: TARGET_RATE,
            timeUnit: "1s",
            preAllocatedVUs: PRE_ALLOCATED_VUS,
            maxVUs: MAX_VUS,
            stages: [{ duration: "30s", target: 0 }],
            startTime: "6m30s",
        },
    },

    // SLA Thresholds (CRITICAL - must pass)
    thresholds: {
        // Primary SLA: p95 latency < 100ms
        http_req_duration: ["p(95)<100", "p(99)<150"],

        // Custom metric: request duration
        request_duration: [
            "p(50)<50", // p50 < 50ms
            "p(95)<100", // p95 < 100ms (PRIMARY SLA)
            "p(99)<150", // p99 < 150ms
        ],

        // Throughput: the server sustains the target rate during the sustained
        // stage. k6 starts one iteration (one request) per arrival; when the
        // server falls behind, k6 cannot start it and counts it as dropped.
        "dropped_iterations{scenario:sustained}": ["count==0"],

        // At least 99% of the scheduled arrivals of the sustained stage completed.
        // The count is checked instead of a rate because k6 computes a counter
        // rate over the whole test duration, not over the duration of one
        // scenario.
        "http_reqs{scenario:sustained}": [`count>=${Math.floor(TARGET_RATE * SUSTAINED_SECONDS * 0.99)}`],

        // Error rate: < 1%
        http_req_failed: ["rate<0.01"],

        // Success rate: > 99%
        success_rate: ["rate>0.99"],
    },

    // Test tags
    tags: {
        test_type: "basic-load",
        environment: "local",
    },

    insecureSkipTLSVerify: true,
};

// ============================================================================
// Test Configuration
// ============================================================================

const BASE_URL = __ENV.BASE_URL || "https://localhost:8080";
const SERVICE_PATH = "/greeter.v1.GreeterService/SayHello";

// ============================================================================
// Test Scenario
// ============================================================================

export default function () {
    // ConnectRPC unary call payload
    const payload = JSON.stringify({
        name: `TestUser-${__VU}-${__ITER}`,
    });

    // Execute request
    const response = http.post(`${BASE_URL}${SERVICE_PATH}`, payload, {
        headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "User-Agent": "k6-performance-test/1.0",
        },
        tags: {
            name: "SayHello",
            vu: __VU,
        },
    });

    // ============================================================================
    // Validation Checks
    // ============================================================================

    const success = check(response, {
        "status is 200": (r) => r.status === 200,
        "response time < 100ms": (r) => r.timings.duration < 100,
        "has valid JSON": (r) => {
            try {
                const body = JSON.parse(r.body);
                return body !== null && typeof body === "object";
            } catch (e) {
                console.error(`JSON parse error: ${e.message}`);
                return false;
            }
        },
        "has message field": (r) => {
            try {
                const body = JSON.parse(r.body);
                return "message" in body;
            } catch (_e) {
                return false;
            }
        },
    });

    // ============================================================================
    // Record Metrics
    // ============================================================================

    if (!success) {
        requestErrors.add(1);
        console.error(`Request failed: VU=${__VU}, Iter=${__ITER}, Status=${response.status}`);
    }

    successRate.add(success);
    requestDuration.add(response.timings.duration);

    // No think time: with a fixed arrival rate the pause would only keep a
    // virtual user busy without changing the request rate.
}

// ============================================================================
// Setup Function (runs once before test)
// ============================================================================

export function setup() {
    console.log("\n🚀 Starting Basic Load Test");
    console.log(`   Target: ${BASE_URL}`);
    console.log(`   Service: ${SERVICE_PATH}`);
    console.log(`   Sustained arrival rate: ${TARGET_RATE} req/s for ${SUSTAINED_SECONDS}s (open model, up to ${MAX_VUS} VUs)`);
    console.log("   Duration: 7 minutes");
    console.log("\n📊 Performance Targets:");
    console.log("   - p50 latency: < 50ms");
    console.log("   - p95 latency: < 100ms (PRIMARY SLA)");
    console.log("   - p99 latency: < 150ms");
    console.log("   - Throughput: sustained stage keeps up with the arrival rate (no dropped iterations)");
    console.log("   - Error rate: < 1%");
    console.log("\n");

    // Health check (using Connect protocol POST instead of GET)
    const healthResponse = http.post(`${BASE_URL}/greeter.v1.GreeterService/SayHello`, JSON.stringify({ name: "healthcheck" }), {
        headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
        },
    });
    if (healthResponse.status !== 200) {
        console.error(`❌ Health check failed! Status: ${healthResponse.status}`);
        console.error("   Make sure performance test server is running:");
        console.error("   node examples/performance-test-server/src/index.ts");
        throw new Error("Server health check failed");
    }

    console.log("✅ Server health check passed\n");
}

// ============================================================================
// Teardown Function (runs once after test)
// ============================================================================

export function teardown(_data) {
    console.log("\n✅ Basic Load Test completed");
    console.log("   Check results above for SLA compliance\n");
}
