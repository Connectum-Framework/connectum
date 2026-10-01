---
"@connectum/reflection": patch
"@connectum/cli": patch
---

Serve gRPC Server Reflection with Connectum's own implementation and drop `@lambdalisue/connectrpc-grpcreflect`.

That package declared `@bufbuild/protobuf` and `@connectrpc/connect` as regular dependencies, so a package manager could install a private protobuf copy for it next to the application's. `@connectum/reflection` and the reflection client behind `connectum proto sync` now use code generated from the upstream `grpc.reflection.v1` / `v1alpha` protos, with no third-party reflection package. The public API is unchanged.

Responses now follow the reflection protocol where the previous implementation did not:

- `grpcurl describe pkg.Service.Method` works: `file_containing_symbol` resolves methods, fields, oneofs, enum values, map entries and extensions, not only types and services.
- File answers carry the requested file and its transitive imports (well-known types included), without repeating files already sent on the same stream.
- `all_extension_numbers_of_type` fills `base_type_name` and lists numbers in ascending order; an unknown type is `NOT_FOUND` instead of an empty list.
- A not-found extension names the type and number instead of `File not found: [object Object]`.
- A request with no query set gets an `INVALID_ARGUMENT` error response instead of an empty one; the stream stays open.
- `list_services` lists the mounted services only, not services declared in a file that is merely imported.

`connectum proto sync` and `@connectum/cli/utils/reflection` return the same file order and descriptor-set bytes as before (the service list changes only as described above), and still fall back to v1alpha for servers without v1.
