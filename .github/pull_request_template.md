<!--
Thanks for contributing to Connectum! Please fill out the sections below.
The Parity coverage checkbox is required for any change that touches
service-observable RPC behaviour.
-->

## Summary

<!-- 1–3 sentences: what does this PR change and why? -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (documented in migration guide)
- [ ] Documentation / chore / internal

## Test plan

<!-- Bulleted checklist of how the change was verified. -->

- [ ] `pnpm build && pnpm typecheck && pnpm test` pass locally
- [ ] `pnpm lint` passes locally
- [ ] Relevant examples in `examples/` exercised (if applicable)

## Parity coverage

> Connectum guarantees a cross-transport parity invariant between the HTTP/2
> and in-process transports — see
> [`docs/en/contributing/parity-invariant.md`](../docs/en/contributing/parity-invariant.md).

- [ ] Parity coverage added: this PR adds or extends a
      `transportParityTest()` scenario covering the new/changed observable
      behaviour, **or**
- [ ] Parity N/A: this PR does not change observable RPC behaviour. Briefly
      justify below.

<!-- If "Parity N/A", explain why (e.g. internal refactor, docs-only, build tooling). -->

## Related issues / changes

<!-- Link issues, ADRs, related PRs, etc. -->
