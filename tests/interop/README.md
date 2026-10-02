# Protocol interop suites

Connectum's gRPC Server Reflection, its Health service and the reflection client in `connectum proto sync` are checked here with clients that are not built on Connect:

| Suite | Clients | What it proves |
|---|---|---|
| `packages/reflection/tests/interop/clients.interop.ts` | grpcurl, buf curl | `list` / `describe` for every symbol kind, calls with the schema from reflection only, and raw `ServerReflectionInfo` exchanges (v1 and v1alpha) checked field by field |
| `packages/healthcheck/tests/interop/health.interop.ts` | grpcurl, grpc_health_probe | `Check`, `List`, `Watch` as the upstream `health.proto` defines them, and the probe's exit codes |
| `packages/cli/tests/interop/proto-sync.interop.ts` | the built `connectum` binary, grpcurl, buf | `proto sync` lists, fetches and generates the same thing grpcurl sees and buf generates from the sources |

Each suite starts a real server in the test process on a free port. The clients run in Docker on the host network, which Docker provides on Linux only.

## Running

```bash
pnpm build                                 # the CLI suite runs the built binary
pnpm interop:tools                         # build the tools image (cached after the first run)
pnpm --filter @connectum/reflection test:interop
pnpm --filter @connectum/healthcheck test:interop
pnpm --filter @connectum/cli test:interop
```

CI runs the same commands in the `Protocol interop` job on every pull request to `main`.

## Pinned inputs

- **Clients**: `docker/interop-tools/Dockerfile`:
  - grpcurl v1.9.3 and buf 1.73.0, pinned by image digest;
  - grpc_health_probe v0.4.57, checked against the checksum published with the release.
- **Upstream protos** in `proto/`, copied unchanged from [grpc/grpc-proto](https://github.com/grpc/grpc-proto) at commit `813330824839bfdd3abc52f41807095c0de2ec19`:
  - `grpc/reflection/v1/reflection.proto`
  - `grpc/reflection/v1alpha/reflection.proto`
  - `grpc/health/v1/health.proto`

  The suites send raw exchanges with these files, not with schemas generated in this repository, so the protocol is checked against its definition rather than against our own reading of it.

Updating a pin is a deliberate change: edit the Dockerfile or replace the protos from a newer commit, and update the versions and the commit above.
