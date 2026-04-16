---
"@connectum/events": minor
---

feat(events): support per-handler middleware configuration

Event handlers registered via `router.service()` can now specify per-handler
middleware that overrides the global EventBus middleware pipeline.

Handlers support two forms:
- Simple function: `onEvent: async (msg, ctx) => { ... }` (uses global middleware)
- Config object: `onEvent: { handler: async (msg, ctx) => { ... }, middleware: [...] }` (per-handler override)

Closes #49
