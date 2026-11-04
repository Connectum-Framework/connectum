---
"@connectum/test-fixtures": minor
---

feat: `createMockFn` is now as compatible with `node:test` `mock.fn()` as its documentation says. It forwards `this` to the implementation, records `result`, `error` and `this` for each call, still counts a call whose implementation throws, and `mock.calls` returns a copy: a list taken earlier does not grow with later calls, and clearing it does not reset `callCount()`. The `stack` and `target` of a call are not recorded. Code that relied on `mock.calls` being the live internal list must read `mock.calls` again after each call. A call record now has four keys, so `assert.deepStrictEqual(fn.mock.calls, [{ arguments: [1] }])` fails: compare `fn.mock.calls.map((call) => call.arguments)` instead. A hand-written `MockCall` literal needs the new `result`, `error` and `this` fields.
