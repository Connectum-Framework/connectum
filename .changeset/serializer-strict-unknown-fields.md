---
"@connectum/interceptors": patch
---

fix: `createSerializerInterceptor` (and `serializer` in `createDefaultInterceptors`) with `ignoreUnknownFields: false` no longer fails every call with `Internal`. The response a handler returns is already a protobuf message, and parsing it again as JSON made strict mode reject its `$typeName` marker. A response that is already a message of the output type is now passed on as it is, for unary and streaming calls; a JSON response is still parsed with the option, so an unknown key in it is still refused.
