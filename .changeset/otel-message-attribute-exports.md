---
"@connectum/otel": minor
---

feat(otel): export RPC message-event semantic conventions from the package root

`ATTR_RPC_MESSAGE_ID`, `ATTR_RPC_MESSAGE_TYPE`, `ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE`,
and `RPC_MESSAGE_EVENT` are now re-exported from the root `@connectum/otel`
entrypoint, alongside the other `ATTR_RPC_*` / `RPC_*` semantic-convention
constants. Previously they were reachable only via the `@connectum/otel/attributes`
subpath, which was inconsistent with the rest of the streaming-span attributes and
broke documented root-level imports.
