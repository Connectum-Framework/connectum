# Integration Tests for @connectum/interceptors

## Overview

This directory contains integration tests for verifying the interaction between interceptors in real-world scenarios.

## Test Structure

### 1. `full-chain.test.ts` - Full Interceptor Chain

**Tests:**
- Processing a request through all interceptors successfully
- Error handling through the chain (retry with ResourceExhausted)
- Timeout enforcement in the chain
- Bulkhead capacity limits
- Skipping health check services

**Tested interceptors:**
- Logger
- Retry
- Timeout
- Circuit Breaker
- Bulkhead

### 2. `resilience.test.ts` - Resilience Patterns

**Tests:**
- Retry + Circuit Breaker + Timeout (successful retry)
- Circuit opening after threshold failures
- Fallback on open circuit
- Timeout without retry (DeadlineExceeded is not retryable)
- Combination of all resilience interceptors
- Correct handling of streaming requests

**Tested patterns:**
- Retry with exponential backoff
- Circuit Breaker with threshold
- Timeout with deadline
- Fallback for graceful degradation

**Important details:**
- Retry works **only for Code.ResourceExhausted** (by design)
- DeadlineExceeded, Internal and other errors are **not retryable**
- Circuit breaker opens after threshold consecutive failures
- All resilience interceptors skip streaming by default

### 3. `security.test.ts` - Security Interceptors

**Tests:**
- Validation + Logger (without redact)
- Reject invalid requests before processing
- Redact utility functions (smoke test)
- Graceful validation error handling
- Skip streaming requests when configured
- Logger without exposing sensitive data
- Combined order of validation + logging

**Tested interceptors:**
- Validation (protovalidate)
- Logger
- Redact (smoke test only - requires real proto)

**Limitations:**
- Full Redact testing requires real proto schemas with extensions
- Current tests are smoke tests for API verification

## Running Tests

```bash
# Integration tests only
pnpm test:integration

# All tests (unit + integration)
pnpm test

# With coverage
pnpm test -- --experimental-test-coverage
```

## Results

**Total tests:** 18 integration tests
**Status:** All passing
**Execution time:** ~400ms

**Breakdown:**
- Full Chain Integration: 5 tests
- Resilience Pattern Integration: 6 tests
- Security Integration: 7 tests

## Differences from Unit Tests

**Unit tests:**
- Test individual interceptors in isolation
- Use mocks for dependencies
- Fast execution (<1s)
- 77 unit tests

**Integration tests:**
- Test interaction between multiple interceptors
- Use real components (no mocks)
- Verify end-to-end scenarios
- 18 integration tests

## Future Improvements

1. **Database Integration Tests** (Priority 2):
   - SQLite CRUD operations
   - Transaction handling
   - Error recovery

2. **OpenTelemetry Integration Tests** (Priority 3):
   - Trace propagation through interceptor chain
   - Metrics collection
   - OTLP export

3. **Runner Integration Tests** (Priority 4):
   - Full server lifecycle
   - Health check + Reflection
   - Graceful shutdown

4. **Redact Integration Tests**:
   - Require real proto schemas with (integrity.attributes.sensitive) extension
   - Verify redaction in response messages
   - Verify rpcCheck for methods with use_sensitive

## Notes

- All interceptors support `skipStreaming: true` by default
- Retry works only with ResourceExhausted errors
- Circuit breaker uses the Cockatiel library
- Timeout uses AbortController for cancellation
- Mock requests must have full structure (method.input, method.output)
