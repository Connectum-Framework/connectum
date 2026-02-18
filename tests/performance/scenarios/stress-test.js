/**
 * Stress Test
 *
 * Purpose: Find system breaking point and maximum throughput
 * Duration: 8 minutes total
 * Target: Ramp from 100 to 2000 VUs
 * SLA: Error rate < 5% (relaxed for stress conditions)
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

// Track performance at different load levels
const throughputAt100 = new Trend("throughput_at_100_vus", false);
const throughputAt500 = new Trend("throughput_at_500_vus", false);
const throughputAt1000 = new Trend("throughput_at_1000_vus", false);
const throughputAt2000 = new Trend("throughput_at_2000_vus", false);

// ============================================================================
// Test Configuration
// ============================================================================

export const options = {
    stages: [
        { duration: "1m", target: 100 }, // Baseline: Normal load
        { duration: "2m", target: 500 }, // Stress: 5x normal load
        { duration: "2m", target: 1000 }, // High stress: 10x normal load
        { duration: "2m", target: 2000 }, // Extreme stress: 20x normal load
        { duration: "1m", target: 0 }, // Recovery: Ramp down
    ],

    // Relaxed thresholds for stress testing (expect some failures)
    thresholds: {
        // Allow higher error rate under stress (< 5%)
        http_req_failed: ["rate<0.05"],

        // Success rate > 95% (relaxed from 99%)
        success_rate: ["rate>0.95"],

        // No latency requirements (we're finding the breaking point)
    },

    // Test tags
    tags: {
        test_type: "stress",
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
// Helper: Get current stage info
// ============================================================================

function getCurrentStage(vus) {
    if (vus <= 100) return "100_vus";
    if (vus <= 500) return "500_vus";
    if (vus <= 1000) return "1000_vus";
    return "2000_vus";
}

// ============================================================================
// Test Scenario
// ============================================================================

export default function () {
    const currentStage = getCurrentStage(__VU);

    // ConnectRPC unary call payload
    const payload = JSON.stringify({
        name: `StressTest-${__VU}-${__ITER}`,
    });

    // Execute request
    const response = http.post(`${BASE_URL}${SERVICE_PATH}`, payload, {
        headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "User-Agent": "k6-stress-test/1.0",
        },
        tags: {
            name: "SayHello",
            stage: currentStage,
            vu: __VU,
        },
    });

    // ============================================================================
    // Validation Checks
    // ============================================================================

    const success = check(response, {
        "status is 200": (r) => r.status === 200,
        "has valid JSON": (r) => {
            try {
                JSON.parse(r.body);
                return true;
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
        if (Math.random() < 0.01) {
            // Log only 1% of errors to avoid spam
            console.error(`[${currentStage}] Request failed: Status=${response.status}, Duration=${response.timings.duration.toFixed(2)}ms`);
        }
    }

    successRate.add(success);
    requestDuration.add(response.timings.duration);

    // Record throughput per stage (approximate)
    if (__ITER % 10 === 0) {
        // Sample every 10th iteration
        const stage = getCurrentStage(__VU);
        const rps = 1000 / response.timings.duration; // Rough requests per second

        switch (stage) {
            case "100_vus":
                throughputAt100.add(rps);
                break;
            case "500_vus":
                throughputAt500.add(rps);
                break;
            case "1000_vus":
                throughputAt1000.add(rps);
                break;
            case "2000_vus":
                throughputAt2000.add(rps);
                break;
        }
    }

    // ============================================================================
    // Think Time (minimal for stress testing)
    // ============================================================================

    // Very short sleep to maximize stress
    sleep(0.01); // 10ms
}

// ============================================================================
// Setup Function (runs once before test)
// ============================================================================

export function setup() {
    console.log("\n🔥 Starting Stress Test");
    console.log(`   Target: ${BASE_URL}`);
    console.log(`   Service: ${SERVICE_PATH}`);
    console.log("   Max VUs: 2000");
    console.log("   Duration: 8 minutes");
    console.log("\n📊 Test Stages:");
    console.log("   1. Baseline (100 VUs) - 1 minute");
    console.log("   2. Stress (500 VUs) - 2 minutes");
    console.log("   3. High Stress (1000 VUs) - 2 minutes");
    console.log("   4. Extreme Stress (2000 VUs) - 2 minutes");
    console.log("   5. Recovery (0 VUs) - 1 minute");
    console.log("\n🎯 Goal: Find breaking point");
    console.log("   - Monitor latency degradation");
    console.log("   - Track error rate increase");
    console.log("   - Identify maximum sustainable throughput");
    console.log("\n⚠️  Expect some failures - this is intentional!\n");

    // Health check (using Connect protocol POST instead of GET)
    const healthResponse = http.post(`${BASE_URL}/greeter.v1.GreeterService/SayHello`, JSON.stringify({ name: "healthcheck" }), {
        headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
        },
    });
    if (healthResponse.status !== 200) {
        console.error(`❌ Health check failed! Status: ${healthResponse.status}`);
        throw new Error("Server health check failed");
    }

    console.log("✅ Server health check passed\n");
}

// ============================================================================
// Teardown Function (runs once after test)
// ============================================================================

export function teardown(_data) {
    console.log("\n✅ Stress Test completed");
    console.log("\n📊 Analysis Checklist:");
    console.log("   1. At what VU count did latency start degrading?");
    console.log("   2. At what VU count did errors start appearing?");
    console.log("   3. What was the maximum throughput achieved?");
    console.log("   4. Did the system recover during ramp-down?");
    console.log("   5. Were there any memory/CPU spikes?");
    console.log("\n💡 Use this data to set realistic capacity limits\n");
}
