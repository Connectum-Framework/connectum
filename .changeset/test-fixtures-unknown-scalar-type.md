---
"@connectum/test-fixtures": minor
"@connectum/testing": patch
---

feat: `createMockDescField` and `createMockDescMessage` throw a `TypeError` naming the field, the value and the valid names when a field `type` is not a protobuf scalar type name (`"strng"`, `"message"`, `"enum"`, `"toString"`); before, such a field was silently built as `string`. `type` is typed as the new `MockScalarType` union (the fifteen scalar names, also re-exported by `@connectum/testing`), so a `string` variable needs a narrowing or a cast. An omitted `type` is still a `string` field.
