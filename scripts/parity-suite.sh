#!/usr/bin/env bash
# parity-suite.sh — Run the cross-transport parity contract suite.
#
# Behavioural Parity is a release-blocking invariant for the
# `in-process-transport` capability: every observable behaviour of the in-process
# transport must structurally match the HTTP/2 transport.
#
# This script aggregates all parity tests that are driven through
# `transportParityTest()` from `@connectum/testing/parity`:
#   - packages/testing/tests/parity/*.parity.test.ts
#       (interceptors, validation, authorization, streaming, errors, coexistence)
#   - packages/otel/tests/parity/*.parity.test.ts
#       (OTEL tracing & metrics)
#
# Exit non-zero on ANY structural diff between HTTP and local transport.
#
# Usage (from repository root, i.e. connectum/):
#   ./scripts/parity-suite.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

echo "==> [parity-gate] Building packages (pnpm -r, sidesteps dev-cycle in turbo)"
if ! pnpm build; then
  echo "==> [parity-gate] turbo build failed; falling back to pnpm -r --workspace-concurrency=1"
  pnpm -r --workspace-concurrency=1 build
fi

echo ""
echo "==> [parity-gate] Running @connectum/testing parity tests"
pnpm --filter @connectum/testing exec exodus-test --typescript "tests/parity/**/*.test.ts"

echo ""
echo "==> [parity-gate] Running @connectum/otel parity tests"
pnpm --filter @connectum/otel exec exodus-test --typescript "tests/parity/**/*.test.ts"

echo ""
echo "==> [parity-gate] OK — HTTP ↔ in-process parity invariant holds."
