---
"@connectum/test-fixtures": minor
---

feat: the fixture helpers throw on input they cannot honour instead of building something else. Valid input behaves as before.

- `createMockDescMethod` and `createFakeMethod`: a method kind that is not `unary`, `server_streaming`, `client_streaming` or `bidi_streaming` throws a `TypeError` naming the method and the value. `createFakeMethod(service, name, { register: true })` throws when the service already has a method with that name, instead of leaving two entries in `service.methods`.
- `createMockNextSlow(delay)` and `createMockStream(items, { delayMs })`: a delay that is negative, `NaN`, infinite or above 2147483647 throws (a `RangeError`; a non-number throws a `TypeError`) instead of being turned into 1 ms by the timer. `delayMs: -5` no longer means "no delay"; use `0` or omit it.
- `createMockDescField` and `createMockDescMessage`: a `fieldNumber` that is not an integer from 1 to 536870911, or lies in the reserved range 19000 to 19999, throws a `RangeError` naming the field and the number.
- `createMockNext` and `createMockNextSlow` copy `message` at every depth for each call, so editing a nested object of one response no longer changes the next response. Class instances keep their prototype; functions are kept by reference.
