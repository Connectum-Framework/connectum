/**
 * Interceptor Overhead Profiling
 *
 * Purpose: Measure performance impact of each interceptor
 * Duration: 2 minutes per configuration
 * Target: < 2ms overhead per interceptor
 *
 * Tests 5 different server configurations:
 * 1. Baseline (no interceptors) - Port 8081
 * 2. Validation only - Port 8082
 * 3. Logger only - Port 8083
 * 4. Tracing only - Port 8084
 * 5. Full chain (all interceptors) - Port 8080
 */

import { check, sleep } from "k6";
import http from "k6/http";
import { Rate, Trend } from "k6/metrics";

// ============================================================================
// Custom Metrics (per configuration)
// ============================================================================

const baselineDuration = new Trend("baseline_no_interceptors", true);
const validationDuration = new Trend("with_validation_only", true);
const loggerDuration = new Trend("with_logger_only", true);
const tracingDuration = new Trend("with_tracing_only", true);
const fullChainDuration = new Trend("full_chain_all_interceptors", true);

// Success rates per configuration
const baselineSuccess = new Rate("baseline_success");
const validationSuccess = new Rate("validation_success");
const loggerSuccess = new Rate("logger_success");
const tracingSuccess = new Rate("tracing_success");
const fullChainSuccess = new Rate("fullchain_success");

// ============================================================================
// Test Configuration
// ============================================================================

export const options = {
    vus: 10, // Low VU count for accurate measurements
    duration: "2m", // 2 minutes per scenario

    // Thresholds: Full chain should be < 2ms per interceptor overhead
    thresholds: {
        // Baseline should be fast (< 10ms p95)
        baseline_no_interceptors: ["p(95)<10"],

        // Full chain with ~10 interceptors: baseline + (10 * 2ms) = ~30ms max
        full_chain_all_interceptors: ["p(95)<30"],

        // All configurations should have high success rate
        baseline_success: ["rate>0.99"],
        validation_success: ["rate>0.99"],
        logger_success: ["rate>0.99"],
        tracing_success: ["rate>0.99"],
        fullchain_success: ["rate>0.99"],
    },

    // Test tags
    tags: {
        test_type: "interceptor-overhead",
        environment: "local",
    },

    insecureSkipTLSVerify: true,
};

// ============================================================================
// Test Configuration (Server Ports)
// ============================================================================

const BASELINE_PORT = __ENV.BASELINE_PORT || "8081"; // No interceptors
const VALIDATION_PORT = __ENV.VALIDATION_PORT || "8082"; // Validation only
const LOGGER_PORT = __ENV.LOGGER_PORT || "8083"; // Logger only
const TRACING_PORT = __ENV.TRACING_PORT || "8084"; // Tracing only
const FULLCHAIN_PORT = __ENV.FULLCHAIN_PORT || "8080"; // All interceptors

const BASE_HOST = __ENV.BASE_HOST || "localhost";
const PROTOCOL = __ENV.PROTOCOL || "https";
const SERVICE_PATH = "/greeter.v1.GreeterService/SayHello";

// ============================================================================
// Helper: Execute request to specific configuration
// ============================================================================

function callService(port, configName) {
    const payload = JSON.stringify({
        name: `Benchmark-${configName}-${__ITER}`,
    });

    const response = http.post(`${PROTOCOL}://${BASE_HOST}:${port}${SERVICE_PATH}`, payload, {
        headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "User-Agent": "k6-interceptor-benchmark/1.0",
        },
        tags: {
            name: "SayHello",
            config: configName,
        },
    });

    const success = check(response, {
        [`${configName}: status is 200`]: (r) => r.status === 200,
        [`${configName}: valid JSON`]: (r) => {
            try {
                JSON.parse(r.body);
                return true;
            } catch (_e) {
                return false;
            }
        },
    });

    return { response, success };
}

// ============================================================================
// Test Scenario
// ============================================================================

export default function () {
    // Test each configuration in sequence
    // NOTE: We test them all in one VU iteration to ensure fair comparison

    // 1. Baseline (no interceptors)
    {
        const { response, success } = callService(BASELINE_PORT, "baseline");
        baselineDuration.add(response.timings.duration);
        baselineSuccess.add(success);
    }

    sleep(0.1); // Small pause between requests

    // 2. Validation only
    {
        const { response, success } = callService(VALIDATION_PORT, "validation");
        validationDuration.add(response.timings.duration);
        validationSuccess.add(success);
    }

    sleep(0.1);

    // 3. Logger only
    {
        const { response, success } = callService(LOGGER_PORT, "logger");
        loggerDuration.add(response.timings.duration);
        loggerSuccess.add(success);
    }

    sleep(0.1);

    // 4. Tracing only
    {
        const { response, success } = callService(TRACING_PORT, "tracing");
        tracingDuration.add(response.timings.duration);
        tracingSuccess.add(success);
    }

    sleep(0.1);

    // 5. Full chain (all interceptors)
    {
        const { response, success } = callService(FULLCHAIN_PORT, "fullchain");
        fullChainDuration.add(response.timings.duration);
        fullChainSuccess.add(success);
    }

    // Think time between iterations
    sleep(0.5);
}

// ============================================================================
// Setup Function (runs once before test)
// ============================================================================

export function setup() {
    console.log("\n🔬 Starting Interceptor Overhead Profiling");
    console.log("   Duration: 2 minutes");
    console.log("   VUs: 10 (low count for accuracy)");
    console.log("\n📊 Configurations to test:");
    console.log(`   1. Baseline (no interceptors) - :${BASELINE_PORT}`);
    console.log(`   2. Validation only - :${VALIDATION_PORT}`);
    console.log(`   3. Logger only - :${LOGGER_PORT}`);
    console.log(`   4. Tracing only - :${TRACING_PORT}`);
    console.log(`   5. Full chain (all interceptors) - :${FULLCHAIN_PORT}`);
    console.log("\n🎯 Target: < 2ms overhead per interceptor");
    console.log("\n⚠️  Make sure performance-test-server is running:");
    console.log("   node examples/performance-test-server/src/index.ts\n");

    // Health check all ports
    const ports = [
        { port: BASELINE_PORT, name: "Baseline" },
        { port: VALIDATION_PORT, name: "Validation" },
        { port: LOGGER_PORT, name: "Logger" },
        { port: TRACING_PORT, name: "Tracing" },
        { port: FULLCHAIN_PORT, name: "Full Chain" },
    ];

    console.log("🔍 Health checks:\n");
    for (const { port, name } of ports) {
        const healthResponse = http.post(`${PROTOCOL}://${BASE_HOST}:${port}/greeter.v1.GreeterService/SayHello`, JSON.stringify({ name: "healthcheck" }), {
            headers: {
                "Content-Type": "application/json",
                "Connect-Protocol-Version": "1",
            },
        });
        if (healthResponse.status === 200) {
            console.log(`   ✅ ${name.padEnd(15)} - :${port}`);
        } else {
            console.error(`   ❌ ${name.padEnd(15)} - :${port} (Status: ${healthResponse.status})`);
            throw new Error(`Health check failed for ${name} on port ${port}`);
        }
    }

    console.log("\n");
}

// ============================================================================
// Teardown Function (runs once after test)
// ============================================================================

export function teardown(_data) {
    console.log("\n✅ Interceptor Overhead Profiling completed");
    console.log("\n📊 Analysis Instructions:");
    console.log("   1. Compare p50, p95, p99 latencies across configurations");
    console.log("   2. Calculate overhead per interceptor:");
    console.log("      - Validation overhead = validation_p95 - baseline_p95");
    console.log("      - Logger overhead = logger_p95 - baseline_p95");
    console.log("      - Tracing overhead = tracing_p95 - baseline_p95");
    console.log("      - Full chain overhead = fullchain_p95 - baseline_p95");
    console.log("   3. Estimate cost per interceptor:");
    console.log("      - Avg overhead = fullchain_overhead / num_interceptors");
    console.log("   4. Verify: Avg overhead < 2ms ✅ or ❌");
    console.log("\n💡 If overhead > 2ms, profile individual interceptors to find bottlenecks\n");
}
