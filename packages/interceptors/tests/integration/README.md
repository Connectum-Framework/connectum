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
- Retry works for **Code.Unavailable** and **Code.ResourceExhausted** by default
- DeadlineExceeded, Internal and other errors are **not retryable** by default
- Circuit breaker opens after threshold consecutive failures
- All resilience interceptors skip streaming by default

### 3. `security.test.ts` - Security Interceptors

**Tests:**
- Validation + Logger
- Reject invalid requests before processing
- Graceful validation error handling
- Skip streaming requests when configured
- Logger without exposing sensitive data
- Combined order of validation + logging

**Tested interceptors:**
- Validation (protovalidate)
- Logger

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

**Total tests:** 14 integration tests
**Status:** All passing
**Execution time:** ~1100ms

**Breakdown:**
- Full Chain Integration: 5 tests
- Resilience Pattern Integration: 6 tests
- Security Integration: 3 tests

## Differences from Unit Tests

**Unit tests:**
- Test individual interceptors in isolation
- Use mocks for dependencies
- Fast execution (<1s)
- 109 unit tests

**Integration tests:**
- Test interaction between multiple interceptors
- Use real components (no mocks)
- Verify end-to-end scenarios
- 14 integration tests

## Future Improvements

1. **Database Integration Tests** (Priority 2):
   - SQLite CRUD operations
   - Transaction handling
   - Error recovery

2. **OpenTelemetry Integration Tests** (Priority 3):
   - Trace propagation through interceptor chain
   - Metrics collection
   - OTLP export

3. **Server Integration Tests** (Priority 4):
   - Full createServer() lifecycle
   - Health check + Reflection
   - Graceful shutdown

## Notes

- All interceptors support `skipStreaming: true` by default
- Retry works with Unavailable and ResourceExhausted errors by default
- Circuit breaker uses the Cockatiel library
- Timeout uses AbortController for cancellation
- Mock requests must have full structure (method.input, method.output)
