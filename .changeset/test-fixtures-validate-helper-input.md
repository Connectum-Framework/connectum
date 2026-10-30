---
"@connectum/test-fixtures": minor
---

feat: the fixture helpers throw on input they cannot honour instead of building something else. Valid input behaves as before.

- `createMockDescMethod` and `createFakeMethod`: a method kind that is not `unary`, `server_streaming`, `client_streaming` or `bidi_streaming` throws a `TypeError` naming the method and the value. `createFakeMethod(service, name, { register: true })` throws when the service already has a method with that name, instead of leaving two entries in `service.methods`.
- `createMockNextSlow(delay)` and `createMockStream(items, { delayMs })`: a delay that is negative, `NaN`, infinite or above 2147483647 throws (a `RangeError`; a non-number throws a `TypeError`) instead of being turned into 1 ms by the timer. `delayMs: -5` no longer means "no delay"; use `0` or omit it.
- `createMockDescField` and `createMockDescMessage`: a `fieldNumber` that is not an integer from 1 to 536870911, or lies in the reserved range 19000 to 19999, throws a `RangeError` naming the field and the number.
- `createMockNextError(code)` throws a `TypeError` when `code` is not a `Code` of `@connectrpc/connect`; `undefined` used to become `Unknown` and `999` was kept as a code no client can name. `assertConnectError(error, code, messagePattern)` throws a `TypeError` when `messagePattern` is neither a string nor a RegExp; a number or a plain object used to skip the message check, so the assertion passed unchecked. A RegExp from another realm is now matched.
- `createMockNext` and `createMockNextSlow` copy `message` at every depth for each call, so editing a nested object of one response no longer changes the next response. Plain objects, arrays, `Map`, `Set`, `Date`, `RegExp`, `Buffer`, typed arrays and `ArrayBuffer` are copied (shared references and cycles are kept); any other nested object (`Headers`, `URL`, a class instance) and functions are kept by reference, as before.
