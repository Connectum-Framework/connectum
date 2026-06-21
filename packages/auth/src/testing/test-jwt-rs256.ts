/**
 * RS256 + JWKS test utilities.
 *
 * The production-realistic auth path with an external IdP is RS256 signed
 * tokens validated through a JWKS endpoint — i.e. `createJwtAuthInterceptor({
 * jwksUri })`, the `jose.createRemoteJWKSet` branch. Testing that path needs an
 * RSA keypair, a JWKS endpoint to publish the public key, and a token signed by
 * the private key with a matching `kid`. These helpers provide exactly that, so
 * consumers do not hand-roll a keypair + JWKS server + minter in every project.
 *
 * NOT for production use — the keys are generated per call for tests only.
 *
 * @example Round-trip against the production `jwksUri` branch
 * ```typescript
 * import {
 *   generateRsaTestKeypair,
 *   startTestJwksServer,
 *   createTestJwtRS256,
 * } from '@connectum/auth/testing';
 * import { createJwtAuthInterceptor } from '@connectum/auth';
 *
 * const keypair = await generateRsaTestKeypair();
 * const jwks = await startTestJwksServer(keypair.publicJwk);
 *
 * const auth = createJwtAuthInterceptor({
 *   jwksUri: jwks.url,
 *   issuer: 'https://issuer.example',
 *   audience: 'my-api',
 *   algorithms: ['RS256'],
 * });
 *
 * const token = await createTestJwtRS256(
 *   keypair.privateKey,
 *   { sub: 'user-123', roles: ['admin'] },
 *   { kid: keypair.kid, issuer: 'https://issuer.example', audience: 'my-api' },
 * );
 *
 * // ...exercise the interceptor with `Authorization: Bearer ${token}`...
 * await jwks.close();
 * ```
 *
 * @module testing/test-jwt-rs256
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as jose from "jose";

/** Default `kid` shared by the generated keypair and the minted tokens. */
export const TEST_JWT_KID = "connectum-test-key";

/** A generated RSA test keypair plus the public JWK to publish at a JWKS endpoint. */
export interface RsaTestKeypair {
    /** Private signing key — pass to {@link createTestJwtRS256}. */
    readonly privateKey: CryptoKey;
    /** Public verification key. */
    readonly publicKey: CryptoKey;
    /** Public JWK (carries `kid`, `alg: "RS256"`, `use: "sig"`) — serve at the JWKS endpoint. */
    readonly publicJwk: jose.JWK;
    /** Key id shared by `publicJwk` and the token header (load-bearing for JWKS key selection). */
    readonly kid: string;
}

/**
 * Generate an RSA (RS256) test keypair and the matching public JWK.
 *
 * The returned `publicJwk` carries the `kid`/`alg`/`use` a JWKS endpoint
 * publishes, and the same `kid` must be set on every token minted for it
 * (otherwise `createRemoteJWKSet` fails key selection).
 *
 * @param kid - Key id to stamp on the JWK; defaults to {@link TEST_JWT_KID}.
 */
export async function generateRsaTestKeypair(kid: string = TEST_JWT_KID): Promise<RsaTestKeypair> {
    const { privateKey, publicKey } = await jose.generateKeyPair("RS256", { extractable: true });
    const publicJwk: jose.JWK = { ...(await jose.exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
    return { privateKey, publicKey, publicJwk, kid };
}

/** A running in-process JWKS server. */
export interface TestJwksServer {
    /** The JWKS URL — pass as `jwksUri` to `createJwtAuthInterceptor`. */
    readonly url: string;
    /** Origin (no path), e.g. `http://127.0.0.1:<port>`. */
    readonly origin: string;
    /** Stop the server. Call after the test (e.g. in `after`). */
    close(): Promise<void>;
}

/**
 * Start an ephemeral in-process JWKS server publishing the given public JWK(s)
 * at `/.well-known/jwks.json` on a random loopback port.
 *
 * @param jwks - One public JWK or an array (from {@link generateRsaTestKeypair}).
 */
export async function startTestJwksServer(jwks: jose.JWK | readonly jose.JWK[]): Promise<TestJwksServer> {
    const keys = Array.isArray(jwks) ? jwks : [jwks as jose.JWK];
    const body = JSON.stringify({ keys });

    const server = createServer((req, res) => {
        if (req.url === "/.well-known/jwks.json") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(body);
            return;
        }
        res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;

    return {
        url: `${origin}/.well-known/jwks.json`,
        origin,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
}

/**
 * Mint an RS256 test JWT signed by the private key from
 * {@link generateRsaTestKeypair}, with a `kid` header matching the published JWK.
 *
 * NOT for production use.
 *
 * @param privateKey - Private key from {@link generateRsaTestKeypair}.
 * @param payload - JWT claims (e.g. `sub`, `roles`, `scope`).
 * @param options - `kid` (required, must match the published JWK) plus optional
 *   `issuer`/`audience`/`expiresIn` (default `"1h"`).
 */
export async function createTestJwtRS256(
    privateKey: CryptoKey,
    payload: Record<string, unknown>,
    options: {
        kid: string;
        issuer?: string;
        audience?: string;
        expiresIn?: string;
    },
): Promise<string> {
    let builder = new jose.SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: options.kid })
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? "1h");

    if (options.issuer) {
        builder = builder.setIssuer(options.issuer);
    }
    if (options.audience) {
        builder = builder.setAudience(options.audience);
    }

    return await builder.sign(privateKey);
}
