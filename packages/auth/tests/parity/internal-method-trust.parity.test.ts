/**
 * An `internal` proto method is reachable only through the internal interceptor, on a real
 * server and a real client.
 *
 * `internal` without `requires` means "any trusted internal caller". The annotation does not
 * authenticate anyone: the internal interceptor does. When that interceptor is missing from
 * the chain, or covers no method, an end-user JWT produced a perfectly valid identity and the
 * proto authorization interceptor let it reach the method. The method must stay closed unless
 * the identity was established by the internal interceptor.
 */

import assert from "node:assert";
import { Code } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "@connectum/testing/parity";
import { createInternalAuthInterceptor, createJwtAuthInterceptor, createProtoAuthzInterceptor, getInternalMethods, sharedSecretTrust } from "../../src/index.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/index.ts";
import { callEcho, echoRoutes, makeEchoService } from "../helpers/echo-service.ts";

const Echo = makeEchoService([{ name: "Sync", auth: { internal: true } }]);
const INTERNAL_SECRET = "s".repeat(40);
const internalMethods = getInternalMethods([Echo]);

const errorHandler = () => createErrorHandlerInterceptor({ logErrors: false });
const jwt = (skipMethods: string[]) => createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, algorithms: ["HS256"], skipMethods });
const internalAuth = (methods: string[]) => createInternalAuthInterceptor({ internalMethods: methods, trustSource: sharedSecretTrust({ secret: INTERNAL_SECRET, subject: "worker-service", roles: ["worker"] }) });
const protoAuthz = () => createProtoAuthzInterceptor({ defaultPolicy: "deny" });

const endUserJwt = async () => ({ authorization: `Bearer ${await createTestJwt({ sub: "end-user" })}` });
const internalCaller = { "x-internal-secret": INTERNAL_SECRET };

/** Both transports reject with `Unauthenticated` and the literal text. */
function rejectedWith(message: string) {
    return (http: ParityScenarioResult, local: ParityScenarioResult): void => {
        const expected = { code: Code.Unauthenticated, message };
        assert.deepStrictEqual(http.error, expected, "HTTP");
        assert.deepStrictEqual(local.error, expected, "local");
        defaultCompare(http, local);
    };
}

transportParityTest("parity: documented chain rejects an end-user JWT on an internal method", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), jwt(internalMethods), internalAuth(internalMethods), protoAuthz()],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: await endUserJwt() })) }),
    compare: rejectedWith("Untrusted internal request"),
});

transportParityTest("parity: documented chain admits the internal caller and the handler sees its identity", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), jwt(internalMethods), internalAuth(internalMethods), protoAuthz()],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: internalCaller })) }),
    compare: (http, local) => {
        const expected = { text: 'handler ran as "worker-service"' };
        assert.deepStrictEqual(http.response, expected, "HTTP");
        assert.deepStrictEqual(local.response, expected, "local");
        defaultCompare(http, local);
    },
});

transportParityTest("parity: an end-user JWT is rejected when the internal interceptor is left out of the chain", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), jwt([]), protoAuthz()],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: await endUserJwt() })) }),
    compare: rejectedWith("Untrusted internal request"),
});

transportParityTest("parity: an end-user JWT is rejected when the internal interceptor covers no method", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), jwt([]), internalAuth([]), protoAuthz()],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: await endUserJwt() })) }),
    compare: rejectedWith("Untrusted internal request"),
});

transportParityTest("parity: an end-user JWT is rejected when the internal interceptor covers a different method", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), jwt([]), internalAuth(["acme.v1.Echo/Other"]), protoAuthz()],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: await endUserJwt() })) }),
    compare: rejectedWith("Untrusted internal request"),
});
