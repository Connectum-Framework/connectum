---
"@connectum/test-fixtures": minor
"@connectum/testing": minor
---

fix: the descriptor mocks of `@connectum/test-fixtures` (re-exported by `@connectum/testing`) match a compiled descriptor in three more places, so `toBinary`, `isFieldSet`, `equals` and `clone` of `@bufbuild/protobuf` accept a mock message instead of throwing `TypeError`.

- `createMockDescMessage` links each field it builds to the message through `parent`, as a compiled descriptor does. The message itself keeps `parent` `undefined`. A field made by `createMockDescField` alone and a method made by `createMockDescMethod` keep `parent` `undefined`; use `createFakeMethod(service, name)` for a method attached to a service.
- A field created with `isSensitive: true` carries a real `google.protobuf.FieldOptions` message with `debugRedact: true` in `proto.options`, not the plain object `{ debug_redact: true }`.
- The `file` of a mock message reports `edition` `Edition.EDITION_PROTO3` and a `proto` of `{ syntax: "proto3", edition: Edition.EDITION_UNKNOWN }`, as a compiled proto3 file does.
- `useSensitiveRedaction` of `createMockDescMethod` is marked `@deprecated` and keeps its behaviour: `MethodOptions` has no such property, so the marker is fixture-only and nothing in Connectum reads it.

**BREAKING** for tests that use these mocks (shipped as minor on purpose: the `@connectum/*` packages are one fixed version group, so a major here would release every package as 2.0.0):

- `JSON.stringify` of a mock message that has fields throws `TypeError` (the `parent` link is circular), as it does for a compiled descriptor.
- Code that read `field.proto.options.debug_redact` must read `debugRedact`.
- `file.proto.edition` is the number `Edition.EDITION_UNKNOWN` (0) and `file.proto.syntax` is `"proto3"`; it was the string `"EDITION_PROTO3"`. `file.edition` is now `Edition.EDITION_PROTO3` (999).

**Migration.** Serialise `typeName` and the field names instead of the descriptor object. Read `proto.options.debugRedact` of a sensitive field. Read the edition from `file.edition`.
