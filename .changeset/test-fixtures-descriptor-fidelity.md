---
"@connectum/test-fixtures": minor
"@connectum/testing": minor
---

fix: the descriptor mocks of `@connectum/test-fixtures` (re-exported by `@connectum/testing`) now follow the rules of protobuf-es, so a test that passes against a mock no longer fails against a compiled descriptor for avoidable reasons.

- `createMockDescMessage` lists its fields and oneof groups in `members` (standalone fields in declaration order, then oneof groups), and its fields report implicit presence and no declared default. `create(mock)` therefore zero-initialises the declared fields and sets each oneof group to `{ case: undefined }`.
- The name of a mock field (`fields[].name`, and the first parameter of `createMockDescField`) is the proto name: `localName` and `jsonName` are derived from it (`user_id` gives `userId`), and a `localName` that collides with `constructor`, `toString`, `toJSON` or `valueOf` gets a `$` suffix. CamelCase names are unchanged.
- Automatic field numbers continue from the highest number used so far (`max + 1`). An explicit number that repeats another field's number makes the factory throw an `Error`, as `protoc` rejects such a message.
- `createMockDescMethod` and `createFakeMethod` escape reserved RPC names in `localName` (`ToString` gives `toString$`).
- `createMockNextSlow` returns a copy of the configured `message` on every call, like `createMockNext`.
- `createMockRequest` keeps the placeholder origin `http://localhost`; its documentation now says that a real in-process request carries `https://in-memory/…` and that `url` should be passed explicitly when the code under test depends on the origin.

Limits that stay: a mock oneof group has no fields (`fields: []`) and the declared fields are not attached to it, and a custom `json_name` option cannot be expressed.

**BREAKING** for tests that use these mocks (shipped as minor on purpose: the `@connectum/*` packages are one fixed version group, so a major here would release every package as 2.0.0):

- `create(mock)` returns the zeroed fields instead of only `{ $typeName }`; an assertion such as `deepStrictEqual(create(mock), { $typeName: "..." })` must list the zero values.
- A snake_case field name now yields a camelCase `localName` (`user_id` -> `userId`); read it, and the key in `desc.field`, by the camelCase name.
- Declaring the same field number twice throws; automatic numbers after an explicit number change (`[{ name: "a", fieldNumber: 5 }, { name: "b" }]` numbers `b` as 6, not 2).
- A reserved RPC name is looked up as `toString$`, not `toString`.
- `createMockNextSlow` responses are shallow copies: a test that mutated a returned `message` and expected the configured object, or the next response, to change no longer sees that; change the configured object (or pass a new `message`) instead.

**Migration.** Replace strict comparisons with `{ $typeName }` by the full zeroed shape, or compare the fields you set. Rename snake_case lookups to camelCase. Give every field a distinct number, or drop the explicit numbers. Pass an explicit `url` to `createMockRequest` when the origin matters.
