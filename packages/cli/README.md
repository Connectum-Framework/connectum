# @connectum/cli

This README describes the 1.3.x source; that release is not yet published to npm.

Command-line tools for scaffolding Connectum services, adding services, and
synchronizing protobuf types from a server with reflection enabled.

## Install

```bash
pnpm add -D @connectum/cli
```

The CLI requires Node.js `>=22.13.0`. It uses `@bufbuild/protobuf` and
ConnectRPC as regular dependencies, not peer dependencies. The generated
project's runtime depends on the selected execution mode: `raw` requires
Node.js `>=25.2.0`; `tsx` supports Node.js `>=22.13.0`. See
[runtime compatibility](https://connectum.dev/en/guide/runtime-compatibility).

## Start here

From a project where `@connectum/cli` is installed, create and start a service:

```bash
pnpm exec connectum init payments
cd payments
pnpm install
pnpm start
```

The generated project does not include the CLI dependency. To add a service,
install `@connectum/cli` in that project and then run:

```bash
pnpm exec connectum generate service billing
```

The command writes a proto file and service skeleton, then prints the import
and `services` array entry to add to `src/server.ts`; it does not register the
service automatically. Run `pnpm start` after that edit to regenerate protobuf
types and start the project.

## Constraints

- The CLI downloads its starter project on first use, so project creation
  requires network access.
- `connectum proto sync` requires a reachable server with reflection enabled,
  the `buf` CLI, and a `buf.gen.yaml` template.
- The CLI's `FileRegistry` belongs to the CLI's protobuf dependency copy; do not
  assume it is the same object as an application registry.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/cli)
- [Scaffolding guide](https://connectum.dev/en/guide/scaffolding)
- [Reflection guide](https://connectum.dev/en/guide/protocols/reflection)
- [API reference](https://connectum.dev/en/api/@connectum/cli/)

## License

Apache-2.0
