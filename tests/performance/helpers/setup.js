/**
 * Common setup and helper functions for k6 performance tests
 */

import http from "k6/http";

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_BASE_URL = "http://localhost:8080";
export const DEFAULT_SERVICE_PATH = "/greeter.v1.GreeterService/SayHello";

export const PORTS = {
    BASELINE: 8081, // No interceptors
    VALIDATION: 8082, // Validation only
    LOGGER: 8083, // Logger only
    TRACING: 8084, // Tracing only
    FULLCHAIN: 8080, // All interceptors
};

// ============================================================================
// Health Check Helpers
// ============================================================================

/**
 * Check if server is healthy
 * @param {string} baseUrl - Server base URL
 * @returns {boolean} true if healthy
 */
export function checkHealth(baseUrl) {
    try {
        const response = http.get(`${baseUrl}/grpc.health.v1.Health/Check`, {
            timeout: "5s",
        });
        return response.status === 200;
    } catch (e) {
        console.error(`Health check failed: ${e.message}`);
        return false;
    }
}

/**
 * Check health of all server ports
 * @param {string} host - Server host (default: localhost)
 * @returns {object} Health status for each port
 */
export function checkAllPorts(host = "localhost") {
    const results = {};

    for (const [name, port] of Object.entries(PORTS)) {
        const url = `http://${host}:${port}`;
        results[name] = {
            port,
            url,
            healthy: checkHealth(url),
        };
    }

    return results;
}

// ============================================================================
// Request Helpers
// ============================================================================

/**
 * Create ConnectRPC request headers
 * @param {string} userAgent - Optional user agent
 * @returns {object} Request headers
 */
export function createConnectHeaders(userAgent = "k6-performance-test/1.0") {
    return {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "User-Agent": userAgent,
    };
}

/**
 * Create test payload for Greeter service
 * @param {string} name - Name to include in request
 * @returns {string} JSON payload
 */
export function createGreeterPayload(name = "TestUser") {
    return JSON.stringify({ name });
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Common validation checks for responses
 * @param {object} response - k6 HTTP response
 * @returns {object} Check results
 */
export function validateResponse(response) {
    const checks = {
        status_200: response.status === 200,
        has_body: response.body && response.body.length > 0,
        valid_json: false,
        has_greeting: false,
    };

    try {
        const body = JSON.parse(response.body);
        checks.valid_json = true;
        checks.has_greeting = "greeting" in body;
    } catch (_e) {
        // JSON parse failed
    }

    return checks;
}

// ============================================================================
// Metrics Helpers
// ============================================================================

/**
 * Calculate percentile from sorted array
 * @param {Array<number>} arr - Sorted array of numbers
 * @param {number} p - Percentile (0-100)
 * @returns {number} Percentile value
 */
export function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const index = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, index)];
}

/**
 * Calculate overhead between two configurations
 * @param {number} baselineLatency - Baseline p95 latency (ms)
 * @param {number} configLatency - Configuration p95 latency (ms)
 * @param {number} numInterceptors - Number of interceptors in config
 * @returns {object} Overhead metrics
 */
export function calculateOverhead(baselineLatency, configLatency, numInterceptors = 1) {
    const totalOverhead = configLatency - baselineLatency;
    const perInterceptor = totalOverhead / numInterceptors;

    return {
        total: totalOverhead,
        perInterceptor: perInterceptor,
        percentage: ((totalOverhead / baselineLatency) * 100).toFixed(2),
    };
}

// ============================================================================
// Logging Helpers
// ============================================================================

/**
 * Log test configuration
 * @param {object} config - Test configuration
 */
export function logTestConfig(config) {
    console.log(`\n${"=".repeat(70)}`);
    console.log("📋 Test Configuration");
    console.log(`${"=".repeat(70)}`);

    for (const [key, value] of Object.entries(config)) {
        console.log(`   ${key.padEnd(20)}: ${value}`);
    }

    console.log(`${"=".repeat(70)}\n`);
}

/**
 * Log SLA thresholds
 * @param {object} thresholds - SLA thresholds
 */
export function logSLAThresholds(thresholds) {
    console.log("\n📊 SLA Thresholds:");

    for (const [key, value] of Object.entries(thresholds)) {
        console.log(`   ${key.padEnd(30)}: ${value}`);
    }

    console.log("");
}

// ============================================================================
// Error Helpers
// ============================================================================

/**
 * Log error with context
 * @param {string} phase - Test phase
 * @param {object} response - k6 HTTP response
 * @param {number} vu - Virtual user ID
 * @param {number} iter - Iteration number
 */
export function logError(phase, response, vu, iter) {
    console.error(`[${phase}] Error: VU=${vu}, Iter=${iter}, ` + `Status=${response.status}, Duration=${response.timings.duration.toFixed(2)}ms`);

    if (response.body && response.body.length < 500) {
        console.error(`   Body: ${response.body}`);
    }
}

// ============================================================================
// Export all
// ============================================================================

export default {
    DEFAULT_BASE_URL,
    DEFAULT_SERVICE_PATH,
    PORTS,
    checkHealth,
    checkAllPorts,
    createConnectHeaders,
    createGreeterPayload,
    validateResponse,
    percentile,
    calculateOverhead,
    logTestConfig,
    logSLAThresholds,
    logError,
};
