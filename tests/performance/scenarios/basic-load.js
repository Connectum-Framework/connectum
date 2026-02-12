/**
 * Basic Load Test
 *
 * Purpose: Measure performance under normal sustained load
 * Duration: 7 minutes total
 * Target: 100 concurrent virtual users
 * SLA: p95 < 100ms, throughput > 1000 req/sec, error rate < 1%
 */

import { check, sleep } from "k6";
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

export const options = {
    stages: [
        { duration: "30s", target: 50 }, // Warm-up to 50 VUs
        { duration: "1m", target: 100 }, // Ramp-up to 100 VUs
        { duration: "5m", target: 100 }, // Sustained load (100 VUs)
        { duration: "30s", target: 0 }, // Ramp-down
    ],

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

        // Throughput: > 1000 req/sec during sustained phase
        http_reqs: ["rate>1000"],

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
};

// ============================================================================
// Test Configuration
// ============================================================================

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
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
        "has greeting field": (r) => {
            try {
                const body = JSON.parse(r.body);
                return "greeting" in body;
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

    // ============================================================================
    // Think Time (simulate real user behavior)
    // ============================================================================

    // Small random sleep between 50-150ms to simulate user think time
    const thinkTime = 0.05 + Math.random() * 0.1; // 50-150ms
    sleep(thinkTime);
}

// ============================================================================
// Setup Function (runs once before test)
// ============================================================================

export function setup() {
    console.log("\n🚀 Starting Basic Load Test");
    console.log(`   Target: ${BASE_URL}`);
    console.log(`   Service: ${SERVICE_PATH}`);
    console.log("   Max VUs: 100");
    console.log("   Duration: 7 minutes");
    console.log("\n📊 Performance Targets:");
    console.log("   - p50 latency: < 50ms");
    console.log("   - p95 latency: < 100ms (PRIMARY SLA)");
    console.log("   - p99 latency: < 150ms");
    console.log("   - Throughput: > 1000 req/sec");
    console.log("   - Error rate: < 1%");
    console.log("\n");

    // Health check
    const healthResponse = http.get(`${BASE_URL}/grpc.health.v1.Health/Check`);
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
