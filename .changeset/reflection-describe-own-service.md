---
"@connectum/reflection": patch
---

fix: the reflection service can be described through itself. `file_containing_symbol` for `grpc.reflection.v1.ServerReflection` and `grpc.reflection.v1alpha.ServerReflection` (and for their methods and messages), and `file_by_filename` for `grpc/reflection/v1/reflection.proto` and `grpc/reflection/v1alpha/reflection.proto`, used to answer `NOT_FOUND`, so `grpcurl describe grpc.reflection.v1.ServerReflection` failed. The two services are still left out of `list_services`.
