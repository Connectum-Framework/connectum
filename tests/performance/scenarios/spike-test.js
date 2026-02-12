/**
 * Spike Test
 *
 * Purpose: Test system recovery from sudden load spikes
 * Duration: 2 minutes total
 * Pattern: Normal → Sudden 10x spike → Recovery
 * SLA: Error rate < 2%, recovery time < 30s
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

// Metrics for different phases
const baselineLatency = new Trend("baseline_latency", true);
const spikeLatency = new Trend("spike_latency", true);
const recoveryLatency = new Trend("recovery_latency", true);

// ============================================================================
// Test Configuration
// ============================================================================

export const options = {
    stages: [
        { duration: "30s", target: 100 }, // Baseline: Normal load
        { duration: "10s", target: 1000 }, // SPIKE: 10x increase in 10s!
        { duration: "30s", target: 1000 }, // Sustained spike
        { duration: "10s", target: 100 }, // Drop back to normal
        { duration: "30s", target: 100 }, // Recovery phase
    ],

    // Thresholds for spike testing
    thresholds: {
        // Allow some errors during spike (< 2%)
        http_req_failed: ["rate<0.02"],

        // Success rate > 98%
        success_rate: ["rate>0.98"],

        // Recovery latency should be back to normal
        recovery_latency: ["p(95)<150"], // Allow slightly higher during recovery
    },

    // Test tags
    tags: {
        test_type: "spike",
        environment: "local",
    },
};

// ============================================================================
// Test Configuration
// ============================================================================

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const SERVICE_PATH = "/greeter.v1.GreeterService/SayHello";

// ============================================================================
// Helper: Determine test phase
// ============================================================================

function getPhase(elapsed, _vus) {
    if (elapsed < 30) return "baseline";
    if (elapsed < 40) return "spike_ramp";
    if (elapsed < 70) return "spike_sustained";
    if (elapsed < 80) return "drop_ramp";
    return "recovery";
}

// ============================================================================
// Test Scenario
// ============================================================================

export default function () {
    const elapsed = Math.floor(__ENV.K6_ELAPSED || 0); // Seconds since test start
    const phase = getPhase(elapsed, __VU);

    // ConnectRPC unary call payload
    const payload = JSON.stringify({
        name: `Spike-${__VU}-${__ITER}`,
    });

    // Execute request
    const startTime = Date.now();
    const response = http.post(`${BASE_URL}${SERVICE_PATH}`, payload, {
        headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "User-Agent": "k6-spike-test/1.0",
        },
        tags: {
            name: "SayHello",
            phase: phase,
            vu: __VU,
        },
    });
    const duration = Date.now() - startTime;

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
        if (Math.random() < 0.1) {
            // Log 10% of errors
            console.error(`[${phase}] Request failed: Status=${response.status}, VU=${__VU}`);
        }
    }

    successRate.add(success);
    requestDuration.add(duration);

    // Record phase-specific latency
    switch (phase) {
        case "baseline":
            baselineLatency.add(duration);
            break;
        case "spike_ramp":
        case "spike_sustained":
            spikeLatency.add(duration);
            break;
        case "recovery":
            recoveryLatency.add(duration);
            break;
    }

    // ============================================================================
    // Think Time (minimal for spike testing)
    // ============================================================================

    sleep(0.05); // 50ms
}

// ============================================================================
// Setup Function (runs once before test)
// ============================================================================

export function setup() {
    console.log("\n⚡ Starting Spike Test");
    console.log(`   Target: ${BASE_URL}`);
    console.log(`   Service: ${SERVICE_PATH}`);
    console.log("   Duration: 2 minutes");
    console.log("\n📊 Test Pattern:");
    console.log("   1. Baseline (100 VUs) - 30s");
    console.log("   2. SPIKE RAMP (100 → 1000 VUs) - 10s 🔥");
    console.log("   3. Sustained Spike (1000 VUs) - 30s");
    console.log("   4. Drop Ramp (1000 → 100 VUs) - 10s");
    console.log("   5. Recovery (100 VUs) - 30s");
    console.log("\n🎯 Goals:");
    console.log("   - System handles sudden 10x spike");
    console.log("   - Error rate < 2% during spike");
    console.log("   - Recovery to baseline latency < 30s");
    console.log("   - No crashes or hangs");
    console.log("\n");

    // Health check
    const healthResponse = http.get(`${BASE_URL}/grpc.health.v1.Health/Check`);
    if (healthResponse.status !== 200) {
        console.error(`❌ Health check failed! Status: ${healthResponse.status}`);
        throw new Error("Server health check failed");
    }

    console.log("✅ Server health check passed\n");

    return {
        startTime: Date.now(),
    };
}

// ============================================================================
// Teardown Function (runs once after test)
// ============================================================================

export function teardown(_data) {
    console.log("\n✅ Spike Test completed");
    console.log("\n📊 Analysis Checklist:");
    console.log("   1. Did the system handle the 10x spike without crashing?");
    console.log("   2. What was the error rate during the spike?");
    console.log("   3. How long did it take to recover to baseline latency?");
    console.log("   4. Compare baseline vs spike vs recovery latencies above");
    console.log("   5. Were there any connection timeouts or refused connections?");
    console.log("\n💡 Good spike resilience indicates robust autoscaling/queuing\n");
}
