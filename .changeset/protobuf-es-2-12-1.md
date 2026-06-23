---
"@connectum/core": patch
"@connectum/auth": patch
"@connectum/events": patch
"@connectum/healthcheck": patch
"@connectum/interceptors": patch
"@connectum/reflection": patch
"@connectum/cli": patch
"@connectum/testing": patch
"@connectum/test-fixtures": patch
"@connectum/protoc-gen-catalog": patch
---

Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.
