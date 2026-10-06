/**
 * A minimal base project shaped like the `getting-started` example, for tests that run
 * the real `init` pipeline against an injected clone (no network).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloneFn } from "../../src/scaffold/fetchBase.ts";

export const GREETER_PROTO = `syntax = "proto3";

package greeter.v1;

service GreeterService {
  rpc SayHello(SayHelloRequest) returns (SayHelloResponse) {}
  rpc SayGoodbye(SayGoodbyeRequest) returns (SayGoodbyeResponse) {}
}

message SayHelloRequest { string name = 1; }
message SayHelloResponse { string message = 1; }
message SayGoodbyeRequest { string name = 1; }
message SayGoodbyeResponse { string message = 1; }
`;

const BASE_PACKAGE_JSON = {
    name: "@connectum/example-getting-started",
    private: true,
    type: "module",
    imports: { "#gen/*": "./gen/*", "#*": "./src/*" },
    scripts: { start: "node src/index.ts" },
    dependencies: { "@connectum/core": "^1.0.0" },
    devDependencies: { "@bufbuild/buf": "^1.65.0", "@connectrpc/connect-node": "^2.1.1", typescript: "^5.9.3" },
    engines: { node: ">=25.2.0" },
};

/** The files of a fit base, keyed by relative path. */
export function baseFiles(): Map<string, string> {
    return new Map<string, string>([
        ["package.json", JSON.stringify(BASE_PACKAGE_JSON, null, 2)],
        ["tsconfig.json", "{}\n"],
        ["pnpm-workspace.yaml", "packages: []\n"],
        ["proto/greeter/v1/greeter.proto", GREETER_PROTO],
        ["src/services/greeterService.ts", "export const greeterService = {};\n"],
        ["tests/e2e/e2e.test.ts", "// old test using createGrpcTransport\n"],
        ["buf.gen.yaml", "version: v2\n"],
    ]);
}

/** Write `files` under `dest`. */
export function writeBase(dest: string, files: ReadonlyMap<string, string>): void {
    for (const [relPath, content] of files) {
        mkdirSync(dirname(join(dest, relPath)), { recursive: true });
        writeFileSync(join(dest, relPath), content);
    }
}

/** A clone stub that writes a fit base into the destination. */
export const cloneStub: CloneFn = async (_source, dest) => {
    writeBase(dest, baseFiles());
};

/** A clone stub for a base derived from the fit one (for example with a file removed). */
export function cloneOf(mutate: (files: Map<string, string>) => void): CloneFn {
    return async (_source, dest) => {
        const files = baseFiles();
        mutate(files);
        writeBase(dest, files);
    };
}
