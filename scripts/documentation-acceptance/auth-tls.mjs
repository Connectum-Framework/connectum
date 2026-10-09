/**
 * Execute the TLS, mTLS, client transport, auth-context, and cookie-session
 * examples from the documentation against packed Connectum candidate packages.
 *
 * Usage:
 * node scripts/documentation-acceptance/auth-tls.mjs \
 *   --docs ../docs \
 *   --candidate-dir .tmp/documentation-acceptance-<id>/quickstart
 *
 * The candidate directory must have been prepared by docs:check --keep. This
 * check never builds or packs packages itself and never modifies that fixture.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const parseOption = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`);
    return resolve(process.argv[index + 1]);
};
const docs = parseOption("docs");
const candidateDir = parseOption("candidate-dir");
const candidateNodeModules = join(candidateDir, "node_modules");
if (!existsSync(candidateNodeModules)) throw new Error(`Candidate dependencies not found: ${candidateNodeModules}`);
const keep = process.argv.includes("--keep");
const work = mkdtempSync(join(repo, ".tmp/auth-tls-acceptance-"));
const outcomes = [];

function run(command, args, cwd, options = {}) {
    console.log(`$ ${command} ${args.join(" ")}  (cwd ${cwd})`);
    return execFileSync(command, args, { cwd, stdio: "inherit", timeout: 120_000, env: process.env, ...options });
}

function codeBlock(file, predicate) {
    const source = readFileSync(file, "utf8");
    const matches = [...source.matchAll(/^```typescript\s*\n([\s\S]*?)^```\s*$/gm)].filter((match) => predicate(match[1]));
    if (matches.length !== 1) throw new Error(`${file}: expected one matching TypeScript block, found ${matches.length}`);
    return matches[0][1];
}

function write(path, contents) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
}

function adaptServerExample(source) {
    let result = source;
    if (!result.includes("services: [routes]")) throw new Error("Server example no longer mounts routes");
    result = result.replace("services: [routes]", "services: [greeterService]");
    if (!result.includes("port: 5000,")) throw new Error("Server example no longer declares port 5000");
    result = result.replace("port: 5000,", "port: 0,\n  host: '127.0.0.1',");
    if (!result.includes("await server.start();")) throw new Error("Server example no longer starts the server");
    return `import { greeterService } from './src/services/greeterService.ts';\n${result}\nexport { server };\n`;
}

async function startServer(modulePath) {
    const { server } = await import(pathToFileURL(modulePath).href);
    const address = server.address;
    if (!address || typeof address === "string") throw new Error("Server did not expose its listening address");
    return { server, baseUrl: `https://localhost:${address.port}` };
}

async function callGreeter(baseUrl, nodeOptions) {
    const { callGreeterClient } = await import(pathToFileURL(join(work, "connect-client.ts")).href);
    return callGreeterClient(baseUrl, nodeOptions);
}

async function expectRejectedClient(label, baseUrl, nodeOptions, expectedCodes) {
    let failure;
    try {
        await callGreeter(baseUrl, nodeOptions);
    } catch (error) {
        failure = error;
    }
    if (!failure) throw new Error(`${label}: the mTLS handshake unexpectedly succeeded`);
    const reasons = [];
    for (let error = failure; error && !reasons.some((reason) => reason === error); error = error.cause) {
        reasons.push(error);
    }
    const evidence = reasons.map((error) => ({ name: error.name, code: error.code, message: error.message }));
    assert.ok(
        reasons.some((error) => expectedCodes.includes(error.code)),
        `${label}: expected TLS rejection, received ${JSON.stringify(evidence)}`,
    );
    console.log(`REJECT ${label}: ${JSON.stringify(evidence)}`);
    outcomes.push({ name: label, result: "passed", rejection: evidence });
}

function writeSessionTest(sessionSource, cookieSource) {
    const mapStart = sessionSource.indexOf("function mapSession(");
    const sessionStart = sessionSource.indexOf("\nconst sessionAuth = createSessionAuthInterceptor(", mapStart);
    if (mapStart < 0 || sessionStart < 0) throw new Error("Could not isolate the documented mapSession implementation");
    const mapSession = sessionSource.slice(mapStart, sessionStart).trim();
    const cookie = cookieSource.trim();
    const prefix = `import assert from 'node:assert/strict';
import { Code, ConnectError } from '@connectrpc/connect';
import { getAuthContext } from '@connectum/auth';
import { createMockNext, createMockRequest } from '@connectum/test-fixtures';
import { createSessionAuthInterceptor } from '@connectum/auth';
import type { AuthContext } from '@connectum/auth';

const sessionStore = new Map([['valid-session', { user: { id: 'user-42', name: 'Alice', roles: ['admin'] } }]]);
const auth = { api: { async getSession({ headers }: { headers: Headers }) {
  const match = /(?:^|;\\s*)session=([^;]+)/.exec(headers.get('cookie') ?? '');
  return match ? sessionStore.get(match[1]) ?? null : null;
} } };

`;
    const suffix = `
const calls: unknown[] = [];
const next = createMockNext({ message: { ok: true } });
const interceptor = sessionAuth(async (request) => {
  calls.push(getAuthContext());
  return next(request);
});

const validRequest = createMockRequest({
  service: 'demo.v1.ProfileService',
  method: 'GetProfile',
  headers: new Headers({ cookie: 'theme=dark; session=valid-session' }),
});
await interceptor(validRequest);
assert.equal((calls[0] as AuthContext).subject, 'user-42');
assert.deepEqual((calls[0] as AuthContext).roles, ['admin']);

const beforeMissing = calls.length;
const missingRequest = createMockRequest({
  service: 'demo.v1.ProfileService',
  method: 'GetProfile',
  headers: new Headers({ cookie: 'theme=dark' }),
});
await assert.rejects(interceptor(missingRequest), (error: unknown) =>
  error instanceof ConnectError && error.code === Code.Unauthenticated);
assert.equal(calls.length, beforeMissing);

const invalidRequest = createMockRequest({
  service: 'demo.v1.ProfileService',
  method: 'GetProfile',
  headers: new Headers({ cookie: 'session=unknown-session' }),
});
await assert.rejects(interceptor(invalidRequest), (error: unknown) =>
  error instanceof ConnectError && error.code === Code.Unauthenticated);
console.log('session-cookie: valid cookie accepted; unrelated cookie alone and unknown session rejected');
`;
    write(join(work, "session-cookie.test.ts"), `${prefix}${mapSession}\n\n${cookie}\n${suffix}`);
}

try {
    const quickstartManifest = JSON.parse(readFileSync(join(candidateDir, "package.json"), "utf8"));
    if (quickstartManifest.dependencies?.["@connectum/core"]?.startsWith("file:") !== true) {
        throw new Error("Candidate package manifest does not resolve @connectum/core from packed file dependencies");
    }
    for (const name of ["core", "auth", "healthcheck", "reflection", "test-fixtures"]) {
        const installed = realpathSync(join(candidateNodeModules, "@connectum", name));
        if (!installed.includes("@file+")) throw new Error(`${name} resolved outside candidate tarballs: ${installed}`);
        console.log(`candidate @connectum/${name} <- ${installed}`);
    }

    const tlsDoc = join(docs, "en/guide/security/tls.md");
    const mtlsDoc = join(docs, "en/guide/security/mtls.md");
    const tlsExample = codeBlock(tlsDoc, (text) => text.includes("server.on('ready'") && text.includes("dirPath: './keys'"));
    const mtlsExample = codeBlock(mtlsDoc, (text) => text.includes("requestCert: true") && text.includes("readFileSync('./keys/ca.crt')") && text.includes("port: 5000,"));
    const opensslExample = (() => {
        const source = readFileSync(tlsDoc, "utf8");
        const matches = [...source.matchAll(/^```bash\s*\n([\s\S]*?)^```\s*$/gm)].filter((match) => match[1].includes("openssl req -x509 -newkey rsa:4096"));
        if (matches.length !== 1) throw new Error(`${tlsDoc}: expected exactly one documented self-signed certificate command`);
        return matches[0][1];
    })();

    const authClientDoc = join(docs, "en/guide/auth/client-interceptors.md");
    const clientBlocks = [
        codeBlock(authClientDoc, (text) => text.includes("createClientBearerInterceptor") && text.includes("httpVersion: '1.1'")),
        codeBlock(authClientDoc, (text) => text.includes("createClientGatewayInterceptor") && !text.includes("createOtelClientInterceptor") && text.includes("httpVersion: '1.1'")),
        codeBlock(authClientDoc, (text) => text.includes("createOtelClientInterceptor") && text.includes("httpVersion: '1.1'")),
    ];

    const contextDoc = join(docs, "en/guide/auth/context.md");
    const contextExample = codeBlock(contextDoc, (text) => text.includes("describe('updateProfile'") && text.includes("Code.Unauthenticated"));
    const contextSetup = `import { requireAuthContext } from '@connectum/auth';
function updateProfile(input: { name: string }) {
  const auth = requireAuthContext();
  return { name: input.name, subject: auth.subject };
}
`;
    const contextPath = join(work, "auth-context.test.ts");
    write(contextPath, `${contextSetup}\n${contextExample}`);

    const sessionDoc = join(docs, "en/guide/auth/session.md");
    const sessionConfig = codeBlock(
        sessionDoc,
        (text) => text.includes("function mapSession(session: unknown)") && text.includes("const sessionAuth = createSessionAuthInterceptor"),
    );
    const sessionCookie = codeBlock(sessionDoc, (text) => text.includes("extractToken: ({ header })") && text.includes("auth.api.getSession({ headers })"));
    writeSessionTest(sessionConfig, sessionCookie);

    // The fixture is an isolated consumer package that reuses the parent docs:check
    // install of packed candidates and generated quickstart protobuf source.
    write(
        join(work, "package.json"),
        `${JSON.stringify(
            {
                name: "documentation-auth-tls-acceptance",
                private: true,
                type: "module",
                imports: { "#gen/*": "./gen/*", "#services/*": "./src/services/*" },
            },
            null,
            2,
        )}\n`,
    );
    symlinkSync(candidateNodeModules, join(work, "node_modules"), "dir");
    cpSync(join(candidateDir, "gen"), join(work, "gen"), { recursive: true });
    cpSync(join(candidateDir, "src/services/greeterService.ts"), join(work, "src/services/greeterService.ts"));
    write(
        join(work, "connect-client.ts"),
        `import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { GreeterService } from '#gen/greeter_pb.ts';

export async function callGreeterClient(baseUrl: string, nodeOptions: { ca: Buffer; cert?: Buffer; key?: Buffer }) {
  const transport = createConnectTransport({ baseUrl, httpVersion: '1.1', nodeOptions, defaultTimeoutMs: 5000 });
  return createClient(GreeterService, transport).sayHello({ name: 'acceptance' });
}
`,
    );

    const keys = join(work, "keys");
    mkdirSync(keys);
    console.log("$ bash -euo pipefail -c '<TLS guide self-signed certificate block>'");
    console.log(opensslExample.trim());
    execFileSync("bash", ["-euo", "pipefail", "-c", opensslExample], { cwd: work, stdio: "inherit", timeout: 120_000, env: process.env });
    run("openssl", ["x509", "-in", "keys/server.crt", "-noout", "-checkhost", "localhost"], work);
    cpSync(keys, join(work, "tls-keys"), { recursive: true });
    const tlsServerCode = adaptServerExample(tlsExample).replace("dirPath: './keys'", "dirPath: './tls-keys'");
    write(join(work, "tls-server.ts"), tlsServerCode);

    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", "keys/ca.key", "-out", "keys/ca.crt", "-subj", "/CN=Acceptance Root CA"], work);
    run(
        "openssl",
        [
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            "keys/server.key",
            "-out",
            "keys/server.csr",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        work,
    );
    run(
        "openssl",
        [
            "x509",
            "-req",
            "-in",
            "keys/server.csr",
            "-CA",
            "keys/ca.crt",
            "-CAkey",
            "keys/ca.key",
            "-CAcreateserial",
            "-out",
            "keys/server.crt",
            "-days",
            "1",
            "-copy_extensions",
            "copy",
        ],
        work,
    );
    run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "keys/client.key", "-out", "keys/client.csr", "-subj", "/CN=acceptance-client"], work);
    run("openssl", ["x509", "-req", "-in", "keys/client.csr", "-CA", "keys/ca.crt", "-CAkey", "keys/ca.key", "-CAcreateserial", "-out", "keys/client.crt", "-days", "1"], work);
    run(
        "openssl",
        ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", "keys/wrong-ca.key", "-out", "keys/wrong-ca.crt", "-subj", "/CN=Untrusted Root CA"],
        work,
    );
    run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "keys/wrong-client.key", "-out", "keys/wrong-client.csr", "-subj", "/CN=untrusted-client"], work);
    run(
        "openssl",
        [
            "x509",
            "-req",
            "-in",
            "keys/wrong-client.csr",
            "-CA",
            "keys/wrong-ca.crt",
            "-CAkey",
            "keys/wrong-ca.key",
            "-CAcreateserial",
            "-out",
            "keys/wrong-client.crt",
            "-days",
            "1",
        ],
        work,
    );
    run("openssl", ["x509", "-in", "keys/server.crt", "-noout", "-checkhost", "localhost"], work);

    const mtlsServerCode = adaptServerExample(mtlsExample);
    write(join(work, "mtls-server.ts"), mtlsServerCode);
    for (let i = 0; i < clientBlocks.length; i++) write(join(work, `client-http-${i + 1}.ts`), clientBlocks[i]);

    const tsc = join(candidateNodeModules, "typescript/bin/tsc");
    run(
        process.execPath,
        [
            tsc,
            "--noEmit",
            "--strict",
            "--esModuleInterop",
            "--allowImportingTsExtensions",
            "--skipLibCheck",
            "--target",
            "ES2022",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            "--types",
            "node",
            "connect-client.ts",
            "tls-server.ts",
            "mtls-server.ts",
            "auth-context.test.ts",
            "session-cookie.test.ts",
            "client-http-1.ts",
            "client-http-2.ts",
            "client-http-3.ts",
        ],
        work,
    );
    outcomes.push({ name: "TLS/mTLS and auth guide TypeScript examples", result: "passed" });

    run(process.execPath, ["--test", "auth-context.test.ts", "session-cookie.test.ts"], work);
    outcomes.push({ name: "AuthContext and cookie session examples", result: "passed" });

    process.chdir(work);
    const tlsModule = join(work, "tls-server.ts");
    const tls = await startServer(tlsModule);
    try {
        const response = await callGreeter(tls.baseUrl, { ca: readFileSync(join(work, "tls-keys/server.crt")) });
        assert.equal(response.message, "Hello, acceptance!");
        outcomes.push({ name: "TLS: trusted client receives ConnectRPC response", result: "passed", response: response.message });
        console.log(`PASS TLS trusted client: ${response.message}`);
    } finally {
        await tls.server.stop();
    }

    const mtls = await startServer(join(work, "mtls-server.ts"));
    try {
        const response = await callGreeter(mtls.baseUrl, {
            ca: readFileSync(join(work, "keys/ca.crt")),
            cert: readFileSync(join(work, "keys/client.crt")),
            key: readFileSync(join(work, "keys/client.key")),
        });
        assert.equal(response.message, "Hello, acceptance!");
        outcomes.push({ name: "mTLS: client certificate issued by configured CA accepted", result: "passed", response: response.message });
        console.log(`PASS mTLS trusted client: ${response.message}`);

        await expectRejectedClient(
            "mTLS: client without certificate rejected",
            mtls.baseUrl,
            {
                ca: readFileSync(join(work, "keys/ca.crt")),
            },
            ["ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED"],
        );

        await expectRejectedClient(
            "mTLS: client certificate from untrusted CA rejected",
            mtls.baseUrl,
            {
                ca: readFileSync(join(work, "keys/ca.crt")),
                cert: readFileSync(join(work, "keys/wrong-client.crt")),
                key: readFileSync(join(work, "keys/wrong-client.key")),
            },
            ["ECONNRESET", "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA"],
        );
        const afterRejections = await callGreeter(mtls.baseUrl, {
            ca: readFileSync(join(work, "keys/ca.crt")),
            cert: readFileSync(join(work, "keys/client.crt")),
            key: readFileSync(join(work, "keys/client.key")),
        });
        assert.equal(afterRejections.message, "Hello, acceptance!");
    } finally {
        await mtls.server.stop();
    }

    console.log(JSON.stringify({ work, outcomes }, null, 2));
} finally {
    if (keep) console.log(`auth-tls-acceptance: retained ${work}`);
    else rmSync(work, { recursive: true, force: true });
}
